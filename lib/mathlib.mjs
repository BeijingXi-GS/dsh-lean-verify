/**
 * lib/mathlib.mjs —— Mathlib 工程脚手架与后台安装。
 *
 * 思路：Lean 核心工具链只能验证不依赖 Mathlib 的内容；真实数学/几何问题需要 Mathlib。
 * Mathlib 的构建很重（源码 + 依赖 + olean 缓存，数 GB），不适合在工具调用里同步跑，
 * 所以这里只做两件事：
 *   1) 生成一个可复现的 lake 工程（lakefile.lean + lean-toolchain + 示例文件），
 *      并把 Git 的 TLS 后端切到 OpenSSL（Windows 的 Schannel 在受限环境会拿不到凭据）；
 *   2) 可选地把 `lake update && lake exe cache get` 作为后台进程启动，日志落到工程目录，
 *      由 lean_env status 汇报进度。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { IS_WIN, readLeanVersion } from './toolchain.mjs'

const MATHLIB_REPO = 'https://github.com/leanprover-community/mathlib4'

function ensureGitConfig(dataDir, config = {}) {
  const configPath = join(dataDir, 'gitconfig')
  mkdirSync(dataDir, { recursive: true })
  const proxy = String(config.gitProxy || process.env.DSH_LEAN_GITHUB_PROXY || '').trim().replace(/\/+$/u, '/')
  const lines = ['[http]', '\tsslBackend = openssl', '[safe]', '\tdirectory = *']
  if (proxy) {
    // 两种写法都接受：`https://gh-proxy.com/` 或 `https://gh-proxy.com/https://github.com/`
    const base = /github\.com\/$/iu.test(proxy) ? proxy : `${proxy}https://github.com/`
    lines.push(`[url "${base}"]`, '\tinsteadOf = https://github.com/')
  }
  writeFileSync(configPath, `${lines.join('\n')}\n`, 'utf8')
  return configPath
}

function leanToolchainFromVersion(version) {
  const raw = String(version || '')
  const match = raw.match(/(4\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)/u)
  return match ? `leanprover/lean4:v${match[1]}` : 'leanprover/lean4:stable'
}

/**
 * 生成（不覆盖已有配置）Mathlib 工程骨架。
 * @returns {{projectDir:string, created:string[], lakefile:string, leanToolchain:string, gitConfig:string}}
 */
export async function scaffoldMathlibProject({ config = {}, located, projectDir, rev, dataDir }) {
  const dir = projectDir
  mkdirSync(dir, { recursive: true })
  const created = []
  const lakefilePath = join(dir, 'lakefile.lean')
  const toolchainPath = join(dir, 'lean-toolchain')
  const versionInfo = located?.lean ? await readLeanVersion(located.lean, { timeoutMs: 20_000 }) : { ok: false }
  const leanVersion = versionInfo.ok ? versionInfo.version : config.version
  // Mathlib 默认跟随已安装的 Lean 版本（tag 形如 v4.35.0）；优先用显式 rev/config。
  const targetRev = rev || config.mathlibRev || (leanVersion && /^4\.\d+\.\d+/u.test(String(leanVersion)) ? `v${leanVersion}` : 'v4.35.0')
  const toolchain = leanToolchainFromVersion(leanVersion)
  if (!existsSync(lakefilePath)) {
    writeFileSync(
      lakefilePath,
      [
        'import Lake',
        'open Lake DSL',
        '',
        'package «leanverify» where',
        '',
        'require mathlib from git',
        `  "${MATHLIB_REPO}" @ "${targetRev}"`,
        '',
      ].join('\n'),
      'utf8',
    )
    created.push('lakefile.lean')
  }
  if (!existsSync(toolchainPath)) {
    writeFileSync(toolchainPath, `${toolchain}\n`, 'utf8')
    created.push('lean-toolchain')
  }
  const samplePath = join(dir, 'LeanVerify.lean')
  if (!existsSync(samplePath)) {
    writeFileSync(samplePath, 'import Mathlib\n\nexample : (2 : ℕ) + 2 = 4 := by norm_num\n', 'utf8')
    created.push('LeanVerify.lean')
  }
  const gitConfig = ensureGitConfig(dataDir, config)
  return { projectDir: dir, created, lakefile: lakefilePath, leanToolchain: toolchain, gitConfig }
}

function quoteForCmd(value) {
  return `"${String(value).replace(/"/gu, '""')}"`
}

/**
 * 后台启动 `lake update && lake exe cache get`（不阻塞工具调用）。
 * 日志：<projectDir>/setup.log；完成标记：<projectDir>/.setup-done。
 */
export function startMathlibSetup({ located, projectDir, gitConfig }) {
  const logPath = join(projectDir, 'setup.log')
  const donePath = join(projectDir, '.setup-done')
  const lake = located.lake
  if (!lake || !existsSync(lake)) {
    return { ok: false, error: `找不到 lake：${lake || '(空)'}` }
  }
  try {
    writeFileSync(donePath, 'RUNNING\n', 'utf8')
  } catch {
    /* ignore */
  }
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0' }
  // Windows 上 lake 生成的 `cache.exe` 依赖工具链 bin 目录里的 Lean 运行时 DLL；
  // 若 PATH 里没有工具链 bin，`lake exe cache get` 会以「找不到指定的文件」失败。
  const toolchainBin = lake ? join(lake, '..') : null
  if (toolchainBin && existsSync(toolchainBin)) {
    env.PATH = `${toolchainBin};${env.PATH || ''}`
  }
  if (IS_WIN) {
    const scriptPath = join(projectDir, 'setup.cmd')
    const lines = [
      '@echo off',
      `set "GIT_CONFIG_GLOBAL=${gitConfig}"`,
      'set "GIT_TERMINAL_PROMPT=0"',
      ...(toolchainBin && existsSync(toolchainBin) ? [`set "PATH=${toolchainBin};%PATH%"`] : []),
      `echo === lake update === >> ${quoteForCmd(logPath)}`,
      `${quoteForCmd(lake)} update >> ${quoteForCmd(logPath)} 2>&1`,
      `echo === lake exe cache get === >> ${quoteForCmd(logPath)}`,
      `${quoteForCmd(lake)} exe cache get >> ${quoteForCmd(logPath)} 2>&1`,
      'echo DONE=%ERRORLEVEL% > ' + quoteForCmd(donePath),
    ]
    writeFileSync(scriptPath, `${lines.join('\r\n')}\r\n`, 'utf8')
    const child = spawn('cmd.exe', ['/d', '/s', '/c', scriptPath], {
      cwd: projectDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.unref()
    return { ok: true, pid: child.pid, logPath, donePath, scriptPath, mode: 'background' }
  }
  const scriptPath = join(projectDir, 'setup.sh')
  writeFileSync(
    scriptPath,
    ['#!/bin/sh', 'set -x', `"${lake}" update`, `"${lake}" exe cache get`, 'echo "DONE=$?" > .setup-done'].join('\n'),
    'utf8',
  )
  const child = spawn('sh', [scriptPath], { cwd: projectDir, detached: true, stdio: 'ignore', windowsHide: true, env })
  child.unref()
  return { ok: true, pid: child.pid, logPath, donePath, scriptPath, mode: 'background' }
}

/** 读取后台安装进度：done 标记 + 日志尾部。 */
export function readMathlibProgress(projectDir) {
  const logPath = join(projectDir, 'setup.log')
  const donePath = join(projectDir, '.setup-done')
  const result = { logPath, donePath, done: false, failed: false, exitCode: null, line: null, tail: null, logSize: 0 }
  try {
    if (existsSync(donePath)) {
      const content = readFileSync(donePath, 'utf8').trim()
      result.line = content
      const match = content.match(/^DONE=(\d+)/u)
      if (match) {
        result.done = true
        result.exitCode = Number(match[1])
        result.failed = result.exitCode !== 0
      }
    }
  } catch {
    /* ignore */
  }
  try {
    if (existsSync(logPath)) {
      const text = readFileSync(logPath, 'utf8')
      result.logSize = text.length
      const lines = text.split(/\r?\n/).filter(Boolean)
      result.tail = lines.slice(-12).join('\n')
      const lastProgress = [...lines].reverse().find((line) => /Downloading|Downloaded|unpack|Fetching|Building/i.test(line))
      if (lastProgress) result.line = result.line || lastProgress
    }
  } catch {
    /* ignore */
  }
  return result
}

export { MATHLIB_REPO, ensureGitConfig, leanToolchainFromVersion }