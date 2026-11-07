/**
 * lib/verify-core.mjs —— Lean 源码检查、诊断解析、公理审计与判定。
 *
 * 判定的核心不是「文件有没有编译过」，而是：
 *   1) Lean 内核是否接受了所有声明（编译错误 = 失败）；
 *   2) 是否存在 sorry / admit 这类未完成证明（编译能过，但不是证明）；
 *   3) 定理实际依赖哪些公理（#print axioms）：
 *        - 标准公理 {propext, Classical.choice, Quot.sound} → 内核证明；
 *        - sorryAx → 未完成；
 *        - native_decide 生成的辅助公理 → 可信计算（编译器的可信扩展，非纯内核）；
 *        - 用户自定义 axiom / constant → 条件证明（结论依赖假设，不是无条件成立）。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { IS_WIN, dirSizeMB, locateLean, readLakeVersion, readLeanVersion, resolveDataDir, resolveToolchainRoot, runLeanFile } from './toolchain.mjs'

/** Lean 标准公理；出现它们不影响「内核证明」的成立。 */
export const STANDARD_AXIOMS = new Set(['propext', 'Classical.choice', 'Quot.sound'])
/** native_decide 的可信计算标记（不同 Lean 版本命名不同，按子串识别）。 */
const NATIVE_MARKERS = ['native_decide', 'ofReduceBool', 'trustCompiler']
/** 生成文件里「导入头」的标记，用于行号回映射。 */
const HEADER_MARK = '-- ===== dsh-lean-verify header ====='

/** 去掉行注释、块注释（可嵌套）与字符串字面量，避免把注释里的 sorry 当成证明缺口。 */
export function stripCommentsAndStrings(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '-' && next === '-') {
      while (i < n && source[i] !== '\n') i += 1
      if (source[i] === '\n') i += 1
      out += '\n'
      continue
    }
    if (ch === '/' && next === '-') {
      let depth = 1
      let newlines = 0
      i += 2
      while (i < n && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '-') {
          depth += 1
          i += 2
        } else if (source[i] === '-' && source[i + 1] === '/') {
          depth -= 1
          i += 2
        } else {
          if (source[i] === '\n') newlines += 1
          i += 1
        }
      }
      out += newlines > 0 ? '\n'.repeat(newlines) : ' '
      continue
    }
    if (ch === '"') {
      i += 1
      while (i < n) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        if (source[i] === '"') {
          i += 1
          break
        }
        i += 1
      }
      out += '""'
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/** 扫描用户源码：sorry / admit / 用户公理 / native_decide / unsafe。 */
export function scanSource(source) {
  const clean = stripCommentsAndStrings(source)
  const lines = clean.split(/\r?\n/)
  const sorries = []
  const admits = []
  const axioms = []
  let nativeDecide = 0
  let unsafeCount = 0
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/\bsorry\b/.test(line)) sorries.push({ line: index + 1, text: line.trim() })
    if (/\badmit\b/.test(line)) admits.push({ line: index + 1, text: line.trim() })
    if (/\bnative_decide\b/.test(line)) nativeDecide += 1
    const axiomMatch = line.match(/^\s*(?:private\s+|protected\s+|noncomputable\s+|unsafe\s+)*axiom\s+([A-Za-z_][\w'.]*)/u)
    if (axiomMatch) axioms.push({ name: axiomMatch[1], kind: 'axiom', line: index + 1 })
    const constantMatch = line.match(/^\s*(?:private\s+|protected\s+|noncomputable\s+|unsafe\s+)*constant\s+([A-Za-z_][\w'.]*)/u)
    if (constantMatch) axioms.push({ name: constantMatch[1], kind: 'constant', line: index + 1 })
    if (/^\s*(?:@\[[^\]]*\]\s*)*(?:private\s+|protected\s+)*unsafe\s+(?:def|theorem|lemma|instance|opaque)\b/u.test(line)) unsafeCount += 1
  }
  return { sorries, admits, axioms, nativeDecide, unsafeCount }
}

/**
 * 解析 Lean 诊断行。
 * 形如 `path:12:3: error: msg`、`path:12:3: error(lean.unknownIdentifier): msg`、`path:12:3: warning: msg`。
 * 消息可能多行，只有首行带位置；后续行并入上一条。
 */
export function parseDiagnostics(text) {
  const diagnostics = []
  const lines = String(text || '').split(/\r?\n/)
  const locationRe = /^(.*?):(\d+):(\d+):\s+(error|warning|info)(?:\(([^)]*)\))?:\s?(.*)$/u
  for (const line of lines) {
    const match = line.match(locationRe)
    if (match) {
      diagnostics.push({
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4],
        code: match[5] || null,
        message: match[6] || '',
      })
      continue
    }
    if (diagnostics.length > 0 && line !== '' && !/^'/u.test(line) && !/^(info|warning|error):/u.test(line)) {
      const last = diagnostics[diagnostics.length - 1]
      last.message += `\n${line}`
    }
  }
  return diagnostics
}

/** 解析 `#print axioms` 的输出，返回 Map<name, {axioms: string[], none: boolean}>。 */
export function parseAxioms(text) {
  const result = new Map()
  const re = /'([^']+)'\s+(depends on axioms:\s*\[([^\]]*)\]|does not depend on any axioms)/gu
  let match
  while ((match = re.exec(String(text || ''))) !== null) {
    const name = match[1]
    const none = /does not depend/u.test(match[2])
    const axioms = none
      ? []
      : match[3]
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
    result.set(name, { axioms, none })
  }
  return result
}

/**
 * 扫描顶层声明（theorem / lemma），并跟踪 namespace / section 嵌套，生成全限定名。
 * @returns {{name:string, fullName:string, line:number}[]}
 */
export function scanDeclarations(source) {
  const clean = stripCommentsAndStrings(source)
  const lines = clean.split(/\r?\n/)
  const declarations = []
  const scopes = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const namespaceMatch = line.match(/^\s*namespace\s+([A-Za-z_][\w'.]*)\s*$/u)
    if (namespaceMatch) {
      scopes.push({ kind: 'namespace', name: namespaceMatch[1] })
      continue
    }
    if (/^\s*section(?:\s+[A-Za-z_][\w'.]*)?\s*$/u.test(line)) {
      scopes.push({ kind: 'section', name: null })
      continue
    }
    if (/^\s*end(?:\s+[A-Za-z_][\w'.]*)?\s*$/u.test(line)) {
      scopes.pop()
      continue
    }
    const declMatch = line.match(/^\s*(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|partial)\s+)*(?:theorem|lemma)\s+([A-Za-z_][\w'.]*)/u)
    if (!declMatch) continue
    const namespaces = scopes.filter((scope) => scope.kind === 'namespace' && scope.name).map((scope) => scope.name)
    const fullName = [...namespaces, declMatch[1]].join('.')
    declarations.push({ name: declMatch[1], fullName, line: index + 1 })
  }
  return declarations
}

/** 依赖公理分类。 */
export function classifyAxioms(axioms) {
  const standard = []
  const native = []
  const custom = []
  const sorry = []
  for (const name of axioms) {
    if (name === 'sorryAx' || name.endsWith('.sorryAx')) sorry.push(name)
    else if (STANDARD_AXIOMS.has(name)) standard.push(name)
    else if (NATIVE_MARKERS.some((marker) => name.includes(marker))) native.push(name)
    else custom.push(name)
  }
  return { standard, native, custom, sorry }
}

function tail(text, limit = 4000) {
  const value = String(text || '')
  return value.length > limit ? `…（前 ${value.length - limit} 字符已省略）\n${value.slice(-limit)}` : value
}

/** 生成检查用的 Lean 文件内容：导入头 + 用户代码 + 追加的公理审计命令。 */
export function buildSource({ code, imports = [], declarations = [] }) {
  const headerLines = []
  if (Array.isArray(imports)) {
    for (const item of imports) {
      const trimmed = String(item || '').trim()
      if (!trimmed) continue
      headerLines.push(trimmed.startsWith('import ') ? trimmed : `import ${trimmed}`)
    }
  }
  const userCode = String(code || '').replace(/\r\n/gu, '\n')
  const prefix = headerLines.length > 0 ? `${headerLines.join('\n')}\n${HEADER_MARK}\n` : ''
  const axiomsCommands =
    declarations.length > 0
      ? `\n\n-- ===== dsh-lean-verify axiom audit =====\n${declarations.map((decl) => `#print axioms ${decl.fullName}`).join('\n')}\n`
      : ''
  const headerLineCount = headerLines.length > 0 ? headerLines.length + 1 : 0
  return {
    content: `${prefix}${userCode}${axiomsCommands}`,
    headerLineCount,
    auditStartLine: `${prefix}${userCode}`.split('\n').length + 2,
  }
}

function slugify(text, fallback = 'verify') {
  const cleaned = String(text || '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
  return cleaned || fallback
}

/** 清理旧运行目录，保留最近 keepRuns 个。 */
function pruneRuns(runsRoot, keepRuns) {
  if (!Number.isInteger(keepRuns) || keepRuns < 1) return
  let entries = []
  try {
    entries = readdirSync(runsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return
  }
  if (entries.length <= keepRuns) return
  const withTime = entries.map((entry) => {
    const full = join(runsRoot, entry.name)
    let mtime = 0
    try {
      mtime = statSync(full).mtimeMs
    } catch {
      /* ignore */
    }
    return { full, mtime }
  })
  withTime.sort((a, b) => b.mtime - a.mtime)
  for (const item of withTime.slice(keepRuns)) {
    try {
      rmSync(item.full, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

export function newRunDir(config, label) {
  const runsRoot = join(resolveDataDir(config), 'runs')
  mkdirSync(runsRoot, { recursive: true })
  pruneRuns(runsRoot, Number(config.keepRuns ?? 40))
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const dir = join(runsRoot, `${stamp}-${slugify(label)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 核心：检查一段 Lean 代码并给出结构化判定。
 * @param {object} args
 * @param {string} args.code 用户 Lean 代码（可含 theorem/example/#check/#eval）
 * @param {string[]|string} [args.imports] 额外 import
 * @param {string} [args.projectDir] 使用 lake 工程（含 Mathlib）时的工程目录
 * @param {boolean} [args.strict] 严格模式：native_decide 也不算内核证明
 * @param {number} [args.timeoutMs]
 * @param {object} [args.config]
 * @param {AbortSignal} [args.signal]
 * @param {string} [args.label]
 */
export async function verifyCode(args) {
  const { code, imports, projectDir, strict = false, timeoutMs = 120_000, config = {}, signal, label } = args
  if (typeof code !== 'string' || code.trim() === '') {
    return { status: 'invalid', ok: false, verified: false, kernelOnly: false, message: '缺少 Lean 代码：code 不能为空。' }
  }
  const located = locateLean(config)
  if (!located) {
    return {
      status: 'no-toolchain',
      ok: false,
      verified: false,
      kernelOnly: false,
      message: [
        '本机没有找到 Lean 工具链，无法做内核验证。',
        `受管目录：${resolveToolchainRoot(config)}`,
        '解决：先调用 lean_env action="install"（可传本地 archive 路径离线安装），装好后再验证。',
        '没有工具链时，任何「已验证」结论都不成立——只能报告「未验证」。',
      ].join('\n'),
      toolchainDir: resolveToolchainRoot(config),
      dataDir: resolveDataDir(config),
    }
  }

  const declarations = scanDeclarations(code)
  const source = buildSource({ code, imports, declarations })
  const runDir = newRunDir(config, label || 'verify')
  const filePath = join(runDir, 'Verify.lean')
  writeFileSync(filePath, source.content, 'utf8')
  writeFileSync(join(runDir, 'input.txt'), String(code), 'utf8')

  const result = await runLeanFile({
    located,
    file: filePath,
    projectDir: projectDir ? String(projectDir) : config.projectDir,
    timeoutMs,
    signal,
  })
  const combined = `${result.stdout}\n${result.stderr}`
  const diagnostics = parseDiagnostics(combined)
  const auditStartLine = source.auditStartLine
  const auditErrors = []
  const errors = []
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== 'error') continue
    const isAuditLine = diagnostic.line >= auditStartLine
    if (isAuditLine && /unknown (constant|identifier|declaration)/iu.test(diagnostic.message)) {
      auditErrors.push(diagnostic)
    } else {
      errors.push(diagnostic)
    }
  }
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')
  const infoMessages = diagnostics.filter((diagnostic) => diagnostic.severity === 'info')
  const axiomsMap = parseAxioms(combined)
  const scan = scanSource(code)
  const versionInfo = await readLeanVersion(located.lean, { timeoutMs: 15_000, signal })

  const declarationReports = declarations.map((decl, index) => {
    const nextLine = declarations[index + 1]?.line ?? Number.POSITIVE_INFINITY
    const axiomInfo = axiomsMap.get(decl.fullName) || axiomsMap.get(decl.name) || null
    const classified = axiomInfo ? classifyAxioms(axiomInfo.axioms) : { standard: [], native: [], custom: [], sorry: [] }
    const sorryInDecl = [...scan.sorries, ...scan.admits].some((item) => item.line >= decl.line && item.line < nextLine)
    let status = 'compiled'
    if (classified.sorry.length > 0 || sorryInDecl) status = 'unproven'
    else if (classified.custom.length > 0) status = 'conditional'
    else if (classified.native.length > 0) status = 'trusted'
    else if (axiomInfo && axiomInfo.none) status = 'kernel'
    else if (axiomInfo) status = 'kernel'
    else status = 'compiled'
    return { ...decl, status, axioms: axiomInfo?.axioms || [], audit: Boolean(axiomInfo) }
  })

  const anySorry =
    scan.sorries.length > 0 ||
    scan.admits.length > 0 ||
    declarationReports.some((report) => report.status === 'unproven') ||
    diagnostics.some((diagnostic) => /declaration uses ['`]sorry['`]/u.test(diagnostic.message))
  const anyNative =
    scan.nativeDecide > 0 ||
    declarationReports.some((report) => report.status === 'trusted') ||
    [...axiomsMap.values()].some((info) => classifyAxioms(info.axioms).native.length > 0)
  const anyCustomAxiom = scan.axioms.length > 0 || declarationReports.some((report) => report.status === 'conditional')

  let status
  if (result.timedOut) status = 'timeout'
  else if (result.aborted) status = 'aborted'
  else if (result.error) status = 'exec-error'
  else if (result.code !== 0 || errors.length > 0) status = 'failed'
  else if (anySorry) status = 'unproven'
  else if (anyCustomAxiom) status = 'conditional'
  else if (anyNative) status = strict ? 'trusted-rejected' : 'verified-trusted'
  else status = 'verified'

  const hasExample = /\bexample\b/u.test(stripCommentsAndStrings(code))
  const notes = []
  if (status === 'verified' || status === 'verified-trusted') {
    if (declarations.length === 0 && !hasExample) {
      status = 'no-statement'
    } else if (declarations.length === 0 && hasExample) {
      notes.push('只有未命名的 example：Lean 已接受，但无法用 #print axioms 做公理审计，仅按编译诊断判定。')
    }
  }
  if (scan.unsafeCount > 0) notes.push(`源码含 ${scan.unsafeCount} 处 unsafe 声明：unsafe 代码不进入内核可信性判定，请人工复核。`)
  if (auditErrors.length > 0) notes.push(`公理审计有 ${auditErrors.length} 条名字解析失败（可能来自 private/局部声明），相应定理按「仅编译通过」处理。`)
  const mathlibNotation = ['ℕ', 'ℤ', 'ℚ', 'ℝ', 'ℂ']
  const usesMathlibNotation = mathlibNotation.some((symbol) => errors.some((error) => error.message.includes(`Unknown identifier \`${symbol}\``)))
  const hasProject = Boolean(projectDir || config.projectDir)
  if (usesMathlibNotation && !hasProject) {
    notes.push('错误中出现 ℕ/ℤ/ℚ/ℝ/ℂ：这些是 Mathlib 记号，Lean 核心只有 Nat / Int / Rat（核心没有 Real）。没有 Mathlib 时改用 Nat / Int，或先 `lean_env action="mathlib"` 建工程，再给 lean_verify 传 projectDir。')
  }

  if (status === 'failed') {
    for (let index = 0; index < declarationReports.length; index += 1) {
      const start = declarationReports[index].line
      const end = declarationReports[index + 1]?.line ?? Number.POSITIVE_INFINITY
      const hit = errors.some((error) => error.line >= start && error.line < end)
      if (hit) {
        declarationReports[index].status = 'error'
        declarationReports[index].axioms = []
      }
    }
  }

  const verified = status === 'verified' || status === 'verified-trusted'
  const kernelOnly = status === 'verified'

  return {
    ok: true,
    status,
    verified,
    kernelOnly,
    notes,
    elapsedMs: result.ms,
    exitCode: result.code,
    timedOut: result.timedOut,
    toolchain: {
      lean: located.lean,
      version: versionInfo.ok ? versionInfo.version : null,
      source: located.source,
      projectDir: projectDir ? String(projectDir) : config.projectDir || null,
    },
    runDir,
    filePath,
    headerLineCount: source.headerLineCount,
    declarations: declarationReports,
    errors,
    auditErrors,
    warnings,
    infoMessages,
    axioms: [...axiomsMap.entries()].map(([name, info]) => ({ name, ...info, classified: classifyAxioms(info.axioms) })),
    scan,
    output: tail(combined, 8000),
    raw: { stdout: result.stdout, stderr: result.stderr },
  }
}

/** 探针：只编译/运行 Lean 命令片段，返回原始输出（#check / #eval / #print / #reduce）。 */
export async function probeCode(args) {
  const { code, imports, projectDir, timeoutMs = 60_000, config = {}, signal, label } = args
  if (typeof code !== 'string' || code.trim() === '') {
    return { ok: false, status: 'invalid', message: '缺少 Lean 代码片段（可用 #check / #eval / #print / #reduce）。' }
  }
  const located = locateLean(config)
  if (!located) {
    return {
      ok: false,
      status: 'no-toolchain',
      message: `本机没有找到 Lean 工具链。先调用 lean_env action="install"。受管目录：${resolveToolchainRoot(config)}`,
    }
  }
  const declarations = []
  const source = buildSource({ code, imports, declarations })
  const runDir = newRunDir(config, label || 'probe')
  const filePath = join(runDir, 'Probe.lean')
  writeFileSync(filePath, source.content, 'utf8')
  const result = await runLeanFile({
    located,
    file: filePath,
    projectDir: projectDir ? String(projectDir) : config.projectDir,
    timeoutMs,
    signal,
  })
  const combined = `${result.stdout}\n${result.stderr}`
  const diagnostics = parseDiagnostics(combined)
  const versionInfo = await readLeanVersion(located.lean, { timeoutMs: 10_000, signal })
  // #check / #eval / #print 的输出不带位置前缀，原样保留为 stdout 正文。
  const stdout = result.stdout.trim()
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
  return {
    ok: true,
    status: result.timedOut ? 'timeout' : errors.length > 0 || result.code !== 0 ? 'failed' : 'compiled',
    elapsedMs: result.ms,
    exitCode: result.code,
    timedOut: result.timedOut,
    toolchain: {
      lean: located.lean,
      source: located.source,
      version: versionInfo.ok ? versionInfo.version : null,
      projectDir: projectDir ? String(projectDir) : config.projectDir || null,
    },
    runDir,
    filePath,
    stdout,
    errors,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning'),
    infoMessages: diagnostics.filter((diagnostic) => diagnostic.severity === 'info'),
    output: tail(combined, 8000),
  }
}

/** 环境状态：定位、版本、工程、Mathlib、磁盘占用。 */
export async function environmentStatus(args = {}) {
  const { config = {}, projectDir, signal } = args
  const located = locateLean(config)
  const dataDir = resolveDataDir(config)
  const toolchainRoot = resolveToolchainRoot(config)
  const status = {
    dataDir,
    toolchainRoot,
    installed: Boolean(located),
    lean: located?.lean || null,
    lake: located?.lake || null,
    source: located?.source || null,
    version: null,
    lakeVersion: null,
    projectDir: projectDir ? String(projectDir) : config.projectDir || null,
    project: null,
    mathlibProject: config.mathlibProject || null,
    dataSizeMB: null,
    toolchainSizeMB: null,
  }
  if (located) {
    const versionInfo = await readLeanVersion(located.lean, { timeoutMs: 20_000, signal })
    status.version = versionInfo.ok ? versionInfo.version : versionInfo.raw
    status.lakeVersion = await readLakeVersion(located.lake, { timeoutMs: 20_000, signal })
    status.toolchainSizeMB = Math.round(dirSizeMB(located.root))
  }
  const project = status.projectDir
  if (project && existsSync(project)) {
    const lakefile = ['lakefile.lean', 'lakefile.toml', 'lakefile.ini'].find((name) => existsSync(join(project, name)))
    const mathlibDir = join(project, '.lake', 'packages', 'mathlib')
    const isMathlibRoot = existsSync(join(project, 'Mathlib.lean'))
    const cacheDir = join(project, '.lake', 'cache')
    const buildDir = join(project, '.lake', 'build', 'lib')
    let mathlibCacheMB = null
    if (existsSync(mathlibDir)) mathlibCacheMB = Math.round(dirSizeMB(join(mathlibDir, '.lake', 'build')))
    else if (isMathlibRoot) {
      const parts = [cacheDir, buildDir].filter((dir) => existsSync(dir))
      mathlibCacheMB = Math.round(parts.reduce((sum, dir) => sum + dirSizeMB(dir), 0))
    }
    status.project = {
      lakefile: lakefile || null,
      leanToolchain: existsSync(join(project, 'lean-toolchain')) ? 'lean-toolchain' : null,
      mathlibCheckedOut: existsSync(mathlibDir) || isMathlibRoot,
      mathlibCacheMB,
    }
  }
  if (existsSync(dataDir)) status.dataSizeMB = Math.round(dirSizeMB(dataDir))
  return status
}

export { IS_WIN }