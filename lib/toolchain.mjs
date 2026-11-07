/**
 * lib/toolchain.mjs —— Lean 工具链的定位、下载、解压与运行。
 *
 * 设计原则：
 * - 不假设机器上已有 Lean；按「配置 → 受管目录 → PATH → elan」的顺序找。
 * - 下载走 Node 全局 fetch（Host 进程网络），解压走系统 tar（Windows bsdtar 支持 zst），
 *   全程不依赖 npm 包、不写用户 profile 的 package.json。
 * - 所有耗时操作都支持 AbortSignal 与超时；失败返回可读原因，不抛裸异常。
 */

import { closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir, platform, arch, tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const IS_WIN = platform() === 'win32'
export const LEAN_EXE = IS_WIN ? 'lean.exe' : 'lean'
export const LAKE_EXE = IS_WIN ? 'lake.exe' : 'lake'
export const PLATFORM_TAG = IS_WIN ? 'windows' : platform() === 'darwin' ? 'darwin' : 'linux'
export const ARCH_TAG = arch() === 'arm64' ? 'aarch64' : 'x86_64'

const GITHUB_API = 'https://api.github.com/repos/leanprover/lean4/releases'
const DEFAULT_VERSION = 'v4.35.0'

/** 插件数据目录：config.dataDir > DSH_LEAN_HOME > $DSH_HOME/lean-verify > ~/.dsh/lean-verify。 */
export function resolveDataDir(config = {}) {
  if (typeof config.dataDir === 'string' && config.dataDir.trim()) return resolve(config.dataDir)
  if (typeof process.env.DSH_LEAN_HOME === 'string' && process.env.DSH_LEAN_HOME.trim()) {
    return resolve(process.env.DSH_LEAN_HOME)
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return resolve(join(home, 'lean-verify'))
}

/** 受管工具链根目录：config.toolchainDir > <dataDir>/toolchain。 */
export function resolveToolchainRoot(config = {}) {
  if (typeof config.toolchainDir === 'string' && config.toolchainDir.trim()) return resolve(config.toolchainDir)
  return join(resolveDataDir(config), 'toolchain')
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 在候选根目录里找 <root>/bin/lean 或 <root>/lean 或 <root>/<version>/bin/lean。 */
function findLeanUnder(root) {
  if (!root || !isDir(root)) return null
  const direct = join(root, 'bin', LEAN_EXE)
  if (isFile(direct)) return { lean: direct, lake: join(root, 'bin', LAKE_EXE), root }
  const flat = join(root, LEAN_EXE)
  if (isFile(flat)) return { lean: flat, lake: join(root, LAKE_EXE), root }
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const child = join(root, entry.name)
    const candidate = join(child, 'bin', LEAN_EXE)
    if (isFile(candidate)) return { lean: candidate, lake: join(child, 'bin', LAKE_EXE), root: child }
    const flatChild = join(child, LEAN_EXE)
    if (isFile(flatChild)) return { lean: flatChild, lake: join(child, LAKE_EXE), root: child }
  }
  return null
}

/** 在 PATH 中查找可执行文件（Windows 按 PATHEXT 扩展）。 */
function findOnPath(name) {
  const dirs = String(process.env.PATH || '').split(IS_WIN ? ';' : ':').filter(Boolean)
  const exts = IS_WIN
    ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
        .split(';')
        .filter(Boolean)
    : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name.endsWith(ext.toLowerCase()) || name.endsWith(ext.toUpperCase()) ? name : name + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * 定位 Lean。返回 { lean, lake, root, source }，找不到返回 null。
 * source 取值：config | managed | path | elan。
 */
export function locateLean(config = {}) {
  const explicit = typeof config.leanPath === 'string' && config.leanPath.trim() ? resolve(config.leanPath) : null
  if (explicit) {
    if (isFile(explicit)) {
      return { lean: explicit, lake: join(dirname(explicit), LAKE_EXE), root: dirname(dirname(explicit)), source: 'config' }
    }
    const found = findLeanUnder(explicit)
    if (found) return { ...found, source: 'config' }
  }
  const managed = findLeanUnder(resolveToolchainRoot(config))
  if (managed) return { ...managed, source: 'managed' }
  const onPath = findOnPath(LEAN_EXE)
  if (onPath) return { lean: onPath, lake: join(dirname(onPath), LAKE_EXE), root: dirname(dirname(onPath)), source: 'path' }
  const elanBin = join(homedir(), '.elan', 'bin')
  const elanLean = join(elanBin, LEAN_EXE)
  if (isFile(elanLean)) return { lean: elanLean, lake: join(elanBin, LAKE_EXE), root: elanBin, source: 'elan' }
  return null
}

/**
 * 运行子进程并收集输出。
 *
 * 正常情况用 pipe 收集；在受限沙箱里 Node 用 pipe 拉子进程输出会得到 EPERM
 * （无法创建命名管道），此时自动退回「临时文件重定向」再读回，保证同样的结果。
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, aborted:boolean, ms:number, error?:string, errorCode?:string}>}
 */
export function runProcess(exe, args, options = {}) {
  return runProcessOnce(exe, args, options, 'pipe').then((result) => {
    if (result?.errorCode === 'EPERM') return runProcessOnce(exe, args, options, 'files')
    return result
  })
}

function runProcessOnce(exe, args, options, capture) {
  const { cwd, timeoutMs = 120_000, env, signal, maxBuffer = 8 * 1024 * 1024 } = options
  return new Promise((resolvePromise) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false
    let aborted = false
    let settled = false
    let child = null
    let tmpDir = null
    let outFd = null
    let errFd = null
    let outPath = null
    let errPath = null

    try {
      if (capture === 'files') {
        tmpDir = mkdtempSync(join(tmpdir(), 'dsh-lean-'))
        outPath = join(tmpDir, 'out.txt')
        errPath = join(tmpDir, 'err.txt')
        outFd = openSync(outPath, 'w')
        errFd = openSync(errPath, 'w')
      }
      child = spawn(exe, args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, ...(env || {}) },
        stdio: capture === 'files' ? ['ignore', outFd, errFd] : ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      if (outFd !== null) {
        try {
          closeSync(outFd)
        } catch {
          /* ignore */
        }
      }
      if (errFd !== null) {
        try {
          closeSync(errFd)
        } catch {
          /* ignore */
        }
      }
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
      resolvePromise({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        ms: Date.now() - started,
        error: String(error?.message || error),
        errorCode: error?.code,
      })
      return
    }

    const closeFds = () => {
      if (capture !== 'files') return
      try {
        if (outFd !== null) closeSync(outFd)
      } catch {
        /* ignore */
      }
      try {
        if (errFd !== null) closeSync(errFd)
      } catch {
        /* ignore */
      }
    }

    const readFiles = () => {
      try {
        stdout = readFileSync(outPath, 'utf8')
      } catch {
        /* ignore */
      }
      try {
        stderr = readFileSync(errPath, 'utf8')
      } catch {
        /* ignore */
      }
      if (stdout.length > maxBuffer) {
        stdoutTruncated = true
        stdout = stdout.slice(0, maxBuffer)
      }
      if (stderr.length > maxBuffer) {
        stderrTruncated = true
        stderr = stderr.slice(0, maxBuffer)
      }
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }

    const finish = (extra = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.('abort', onAbort)
      closeFds()
      if (capture === 'files') readFiles()
      if (stdoutTruncated || stderrTruncated) stderr += '\n[输出被截断]'
      resolvePromise({
        code: child.exitCode,
        stdout,
        stderr,
        timedOut,
        aborted,
        ms: Date.now() - started,
        ...extra,
      })
    }

    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, Math.max(1000, timeoutMs))
    const onAbort = () => {
      aborted = true
      kill()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener?.('abort', onAbort, { once: true })
    }

    if (capture === 'pipe') {
      child.stdout?.on('data', (chunk) => {
        if (stdout.length >= maxBuffer) {
          stdoutTruncated = true
          return
        }
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk) => {
        if (stderr.length >= maxBuffer) {
          stderrTruncated = true
          return
        }
        stderr += chunk.toString('utf8')
      })
    }
    child.on('error', (error) => finish({ code: null, error: String(error?.message || error), errorCode: error?.code }))
    child.on('close', () => finish())
  })
}

/** 读取 lean --version。 */
export async function readLeanVersion(lean, options = {}) {
  const result = await runProcess(lean, ['--version'], { timeoutMs: options.timeoutMs ?? 20_000, signal: options.signal })
  if (result.code !== 0) return { ok: false, version: null, raw: (result.stdout + result.stderr).trim(), error: result.error || `exit ${result.code}` }
  const raw = result.stdout.trim() || result.stderr.trim()
  const match = raw.match(/Lean \(version ([^,\s)]+)/i) || raw.match(/Lean version ([^\s,)]+)/i) || raw.match(/version ([^\s,)]+)/i)
  return { ok: true, version: (match && match[1]) || raw.split('\n')[0], raw }
}

/** 读取 lake --version（拿不到就返回 null）。 */
export async function readLakeVersion(lake, options = {}) {
  if (!lake || !isFile(lake)) return null
  const result = await runProcess(lake, ['--version'], { timeoutMs: options.timeoutMs ?? 20_000, signal: options.signal })
  const raw = (result.stdout || result.stderr).trim()
  return result.code === 0 ? raw.split('\n')[0] : null
}

/** 运行 Lean 检查一个文件；projectDir 存在时用 `lake env lean`，否则直接 lean。 */
export async function runLeanFile({ located, file, projectDir, timeoutMs = 120_000, signal, extraArgs = [] }) {
  const useProject = Boolean(projectDir && isDir(projectDir))
  if (useProject && isFile(located.lake)) {
    return runProcess(located.lake, ['env', 'lean', ...extraArgs, file], { cwd: projectDir, timeoutMs, signal })
  }
  return runProcess(located.lean, [...extraArgs, file], { cwd: projectDir || dirname(file), timeoutMs, signal })
}

// ── 下载与解压 ────────────────────────────────────────────────────────────

async function fetchJson(url, { timeoutMs = 30_000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener?.('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'dsh-lean-verify/0.1.0', Accept: 'application/vnd.github+json' },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} @ ${url}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** 选平台对应的发布资产：优先 .tar.zst，其次 .zip。 */
function pickAsset(assets, version) {
  const platformMatch = (name) => name.includes(`-${PLATFORM_TAG}`)
  const archMatch = (name) => {
    const arm = /aarch64|arm64/i.test(name)
    return ARCH_TAG === 'aarch64' ? arm : !arm
  }
  const hasVersion = (name) => {
    if (!version) return true
    const bare = String(version).replace(/^v/i, '')
    return name.includes(bare)
  }
  const candidates = (assets || []).filter((asset) => {
    const name = String(asset?.name || '')
    if (!/\.(tar\.zst|tar\.gz|zip)$/i.test(name)) return false
    return platformMatch(name) && archMatch(name) && hasVersion(name)
  })
  const rank = (name) => (name.endsWith('.tar.zst') ? 0 : name.endsWith('.tar.gz') ? 1 : 2)
  candidates.sort((a, b) => rank(a.name) - rank(b.name))
  return candidates[0] || null
}

/** 解析某个 GitHub release 的下载资产；version 为空时取 latest。 */
export async function resolveReleaseAsset({ version, timeoutMs = 30_000, signal } = {}) {
  const tag = version ? (String(version).startsWith('v') ? String(version) : `v${version}`) : null
  const url = tag ? `${GITHUB_API}/tags/${encodeURIComponent(tag)}` : `${GITHUB_API}/latest`
  const release = await fetchJson(url, { timeoutMs, signal })
  const asset = pickAsset(release.assets, release.tag_name || tag)
  if (!asset) {
    throw new Error(`没有找到 ${PLATFORM_TAG}/${ARCH_TAG} 的 Lean 发布包（release ${release.tag_name}）`)
  }
  return { tag: release.tag_name, name: asset.name, url: asset.browser_download_url, size: asset.size, digest: asset.digest }
}

/** 流式下载文件。 */
export async function downloadFile(url, destPath, { timeoutMs = 900_000, signal, onProgress } = {}) {
  mkdirSync(dirname(destPath), { recursive: true })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener?.('abort', onAbort, { once: true })
  }
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'dsh-lean-verify/0.1.0' } })
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') || 0)
    let received = 0
    let lastTick = 0
    const source = Readable.fromWeb(response.body)
    source.on('data', (chunk) => {
      received += chunk.length
      const now = Date.now()
      if (onProgress && now - lastTick > 1000) {
        lastTick = now
        onProgress({ received, total })
      }
    })
    await pipeline(source, createWriteStream(destPath))
    return { bytes: received, total, path: destPath }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/** 解压工具链包：Windows/BSD tar 原生支持 zst 与 zip；GNU tar 需要 --zstd 或 unzip。 */
export async function extractArchive(archive, destDir, { timeoutMs = 600_000, signal } = {}) {
  mkdirSync(destDir, { recursive: true })
  const attempts = [['-xf', archive, '-C', destDir]]
  if (/\.tar\.zst$/i.test(archive)) attempts.push(['--zstd', '-xf', archive, '-C', destDir])
  if (/\.zip$/i.test(archive)) attempts.push(['-xf', archive, '-C', destDir])
  let lastError = null
  for (const args of attempts) {
    const result = await runProcess('tar', args, { timeoutMs, signal })
    if (result.code === 0) return { ok: true, command: `tar ${args.join(' ')}` }
    lastError = (result.stderr || result.stdout || result.error || `exit ${result.code}`).trim()
  }
  // Windows 兜底：Expand-Archive（PowerShell）。
  if (IS_WIN && /\.zip$/i.test(archive)) {
    const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`], { timeoutMs, signal })
    if (result.code === 0) return { ok: true, command: 'Expand-Archive' }
    lastError = (result.stderr || result.stdout || result.error || `exit ${result.code}`).trim()
  }
  return { ok: false, error: lastError || '解压失败（未知原因）' }
}

/**
 * 确保工具链可用。已安装则直接返回；否则按「本地 archive → GitHub release」顺序安装。
 * @returns {Promise<{located:object, installed:boolean, tag?:string, download?:object, extracted?:object, message:string}>}
 */
export async function ensureToolchain({
  config = {},
  archivePath,
  version,
  force = false,
  signal,
  onProgress,
  timeoutMs = 900_000,
} = {}) {
  const root = resolveToolchainRoot(config)
  if (!force) {
    const existing = findLeanUnder(root)
    if (existing) {
      return { located: { ...existing, source: 'managed' }, installed: false, message: `已安装：${existing.lean}` }
    }
  }

  let archive = archivePath ? resolve(archivePath) : null
  let release = null
  let downloaded = null
  if (!archive || !isFile(archive)) {
    release = await resolveReleaseAsset({ version: version || config.version || DEFAULT_VERSION, signal })
    const dest = join(resolveDataDir(config), 'downloads', release.name)
    if (!isFile(dest) || force) {
      downloaded = await downloadFile(release.url, dest, { timeoutMs, signal, onProgress })
      archive = dest
    } else {
      archive = dest
    }
  }

  mkdirSync(root, { recursive: true })
  const extracted = await extractArchive(archive, root, { timeoutMs: Math.max(timeoutMs, 600_000), signal })
  if (!extracted.ok) {
    return { located: null, installed: false, tag: release?.tag, download: downloaded, extracted, message: `解压失败：${extracted.error}` }
  }
  const located = findLeanUnder(root)
  if (!located) {
    return { located: null, installed: false, tag: release?.tag, download: downloaded, extracted, message: `解压完成但在 ${root} 下没有找到 lean 可执行文件` }
  }
  const versionInfo = await readLeanVersion(located.lean, { signal })
  return {
    located: { ...located, source: 'managed' },
    installed: true,
    tag: release?.tag,
    download: downloaded,
    extracted,
    version: versionInfo,
    message: `已安装 Lean ${versionInfo.ok ? versionInfo.version : release?.tag || ''} → ${located.root}`,
  }
}

/** 目录体积（MB），用于状态报告。 */
export function dirSizeMB(dir) {
  let total = 0
  let stack = [dir]
  let guard = 0
  while (stack.length && guard < 200_000) {
    const current = stack.pop()
    guard += 1
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          total += statSync(full).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  return total / (1024 * 1024)
}

export { DEFAULT_VERSION, GITHUB_API, findLeanUnder, findOnPath, isDir, isFile, pickAsset }