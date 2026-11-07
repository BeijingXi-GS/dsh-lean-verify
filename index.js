/**
 * index.js —— lean-verify 的 Host 插件入口。
 *
 * 注册三个模型可调的工具（不注册命令、不加 UI）：
 *   lean_verify：把一段 Lean 4 代码（theorem/lemma/example）交给真实 Lean 内核检查，
 *                并做 #print axioms 公理审计，给出「已验证 / 含 sorry / 条件证明 / 未通过」判定；
 *   lean_probe ：快速执行 #check / #eval / #print / #reduce 片段，用于查 Mathlib 名字、
 *                试陈述类型、算具体数值（不做证明验收）；
 *   lean_env   ：工具链状态 / 下载安装 / Mathlib lake 工程脚手架与后台安装。
 *
 * 依赖：只依赖 Node 内置模块 + ctx 上的服务。`@deepseek-ai/dsh-tools` 可选：
 * 桌面版以 link 方式安装 bundle 时可能解析不到它，此时 compileTool 自行编译等价的
 * ToolDefinition，保证工具照常注册。
 */

import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import { environmentStatus, probeCode, verifyCode } from './lib/verify-core.mjs'
import { formatEnv, formatInstall, formatMathlib, formatProbe, formatVerify } from './lib/report.mjs'
import { DEFAULT_VERSION, ensureToolchain, locateLean, resolveDataDir, resolveToolchainRoot } from './lib/toolchain.mjs'
import { readMathlibProgress, scaffoldMathlibProject, startMathlibSetup } from './lib/mathlib.mjs'

export const inject = ['tools']

export const name = 'lean-verify'

let defineTool = null
try {
  ;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch {
  // 桌面版从工作区 link 安装时，插件模块的真实路径在工作区，解析不到 dsh 安装目录里的
  // @deepseek-ai/dsh-tools；compileTool 自带等价编译，工具照常注册。
  defineTool = null
}

/** 注册前的编译：优先用官方 defineTool，否则自行编译等价 ToolDefinition。 */
function compileTool(spec) {
  if (typeof defineTool === 'function') return defineTool(spec)
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec.parameters ?? {})) {
    const { required: isRequired, ...rest } = raw
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    output: {
      schema: spec.output.schema,
      render: (args, value) => spec.output.render(args, value),
      ...(spec.output.presentationMeta ? { presentationMeta: spec.output.presentationMeta } : {}),
    },
    ...(spec.isConcurrencySafe !== undefined ? { isConcurrencySafe: spec.isConcurrencySafe } : {}),
    execute: spec.execute,
  }
}

const VERIFY_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', description: '工具调用本身是否跑完（false 时 text 是错误说明）' },
      verified: { type: 'boolean', description: 'Lean 内核是否接受该证明（含 sorry/自定义公理时为 false）' },
      text: { type: 'string', description: '给模型看的判定报告' },
    },
    required: ['ok', 'verified', 'text'],
  },
  render: (args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

const PLAIN_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
    },
    required: ['ok', 'text'],
  },
  render: (args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

const VERIFY_DESC = [
  '把一段 Lean 4 代码（theorem / lemma / example）交给真实的 Lean 内核检查，并做公理审计，判定「答案/猜想是否真的被证明」。',
  '返回判定：✅ 内核已验证 / ✅ 已验证（含 native_decide 可信计算）/ ⚠ 未完成（含 sorry/admit）/ ⚠ 条件证明（依赖自定义 axiom）/ ❌ 未通过（编译错误）/ ⚠ 没有可验证的命题。',
  '参数 code 是完整 Lean 源（可先写 `import Mathlib` 再用 Mathlib 记号）；imports 可补额外模块名（逗号或换行分隔）。',
  '有 Mathlib 工程时传 projectDir（工具会用 `lake env lean`）；没有 Mathlib 时只能用 Lean 核心库（Nat/Int/List 等）与 `decide`/`native_decide`。',
  'strict=true 时 native_decide 不算内核证明（默认 false，但报告会单独标出）。',
  '注意：本工具只验证 Lean 陈述；「Lean 陈述是否忠实翻译了原问题」必须由你逐条核对并在报告中写出形式化陈述。',
  '没有工具链时返回「未验证」并提示先跑 lean_env install——不得把「未运行」说成「已证明」。',
].join('')

const PROBE_DESC = [
  '快速执行一段 Lean 命令片段并返回原始输出：`#check name`、`#eval expr`、`#print name`、`#reduce expr`、`#print axioms foo`。',
  '用途：查 Mathlib 里定理/定义的确切名字与类型、试写陈述看类型是否通过、用 `#eval` 做具体计算或小范围反例搜索。',
  '只执行、不做证明验收；要验证命题请用 lean_verify。可传 imports（如 Mathlib）与 projectDir（Mathlib 工程）。',
  '重要：`#eval` 是计算而不是证明；`#check` 通过只说明名字/类型存在，不说明命题为真。',
].join('')

const ENV_DESC = [
  'Lean 工具链与环境管理。',
  'action="status"：检查 lean/lake 是否可用、版本、受管目录、Mathlib 工程与后台安装进度。',
  'action="install"：下载并安装 Lean 官方工具链到受管目录（Windows 约 600 MB 下载、2–3 GB 磁盘；可传 archive 指向本地已下载的 tar.zst/zip 做离线安装，force=true 重装）。',
  'action="mathlib"：生成 Mathlib lake 工程骨架（lakefile.lean + lean-toolchain + 示例），run=true 时在后台执行 `lake update` 与 `lake exe cache get`（数 GB，10–40 分钟），用 status 查进度。',
  '安装/下载失败时如实返回原因，不假装成功。',
].join('')

function splitImports(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value !== 'string') return []
  return value
    .split(/[\n,，;；]+/u)
    .map((item) => item.trim())
    .filter(Boolean)
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

function resolveProjectDir(args, config) {
  const raw = args?.projectDir ?? config.projectDir
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  return resolvePath(raw.trim())
}

function makeLogger(ctx) {
  return {
    info(message) {
      try {
        ctx.logger?.info?.(message)
      } catch {
        /* ignore */
      }
    },
    warn(message) {
      try {
        ctx.logger?.warn?.(message)
      } catch {
        /* ignore */
      }
    },
  }
}

export async function apply(ctx, config = {}) {
  const toolsSvc = (() => {
    try {
      return ctx.get?.('tools')
    } catch {
      return null
    }
  })()
  if (!toolsSvc?.register) {
    try {
      ctx.logger?.info?.('[lean-verify] 未拿到 tools 服务；lean_verify / lean_probe / lean_env 未注册')
    } catch {
      /* ignore */
    }
    return
  }
  const logger = makeLogger(ctx)
  const defaultTimeoutMs = clampInt(config.timeoutMs, 180_000, 5_000, 1_800_000)
  const probeTimeoutMs = clampInt(config.probeTimeoutMs, 90_000, 5_000, 600_000)

  const verifyTool = compileTool({
    name: 'lean_verify',
    description: VERIFY_DESC,
    parameters: {
      code: { type: 'string', required: true, description: '完整 Lean 4 源码：import + 定义 + theorem/lemma/example。' },
      imports: { type: 'string', description: '额外 import 的模块名，逗号或换行分隔（如 Mathlib, Mathlib.NumberTheory）。' },
      projectDir: { type: 'string', description: 'Mathlib lake 工程目录（绝对路径）；传了就用 lake env lean。' },
      strict: { type: 'boolean', description: '严格模式：native_decide 也算未验证（默认 false，报告仍会标出可信计算）。' },
      timeoutMs: { type: 'number', description: `单次检查超时毫秒数（默认 ${defaultTimeoutMs}）。` },
      label: { type: 'string', description: '本次运行目录的标签（便于在 runs/ 下找回文件）。' },
    },
    output: VERIFY_OUTPUT,
    isConcurrencySafe: true,
    execute: async (args, execCtx) => {
      try {
        const projectDir = resolveProjectDir(args, config)
        // Mathlib 工程首次 import 需要加载大量 oleans（约 1–3 分钟），默认给更宽的超时。
        const fallbackTimeoutMs = projectDir ? Math.max(defaultTimeoutMs, 600_000) : defaultTimeoutMs
        const result = await verifyCode({
          code: args?.code,
          imports: splitImports(args?.imports),
          projectDir,
          strict: args?.strict === true,
          timeoutMs: clampInt(args?.timeoutMs, fallbackTimeoutMs, 5_000, 1_800_000),
          config,
          signal: execCtx?.signal ?? null,
          label: typeof args?.label === 'string' ? args.label : 'verify',
        })
        const ok = result.status !== 'invalid'
        return { ok, verified: Boolean(result.verified), text: formatVerify(result) }
      } catch (error) {
        return {
          ok: false,
          verified: false,
          text: `lean_verify 执行异常：${String(error?.message || error)}\n先跑 lean_env action="status" 检查工具链。`,
        }
      }
    },
  })

  const probeTool = compileTool({
    name: 'lean_probe',
    description: PROBE_DESC,
    parameters: {
      code: { type: 'string', required: true, description: 'Lean 命令片段：#check / #eval / #print / #reduce 等。' },
      imports: { type: 'string', description: '额外 import，逗号或换行分隔。' },
      projectDir: { type: 'string', description: 'Mathlib lake 工程目录。' },
      timeoutMs: { type: 'number', description: `超时毫秒数（默认 ${probeTimeoutMs}；传 projectDir 时为 300000）。` },
    },
    output: PLAIN_OUTPUT,
    isConcurrencySafe: true,
    execute: async (args, execCtx) => {
      try {
        const projectDir = resolveProjectDir(args, config)
        const fallbackTimeoutMs = projectDir ? Math.max(probeTimeoutMs, 300_000) : probeTimeoutMs
        const result = await probeCode({
          code: args?.code,
          imports: splitImports(args?.imports),
          projectDir,
          timeoutMs: clampInt(args?.timeoutMs, fallbackTimeoutMs, 5_000, 600_000),
          config,
          signal: execCtx?.signal ?? null,
          label: 'probe',
        })
        return { ok: result.status !== 'invalid', text: formatProbe(result) }
      } catch (error) {
        return { ok: false, text: `lean_probe 执行异常：${String(error?.message || error)}` }
      }
    },
  })

  const envTool = compileTool({
    name: 'lean_env',
    description: ENV_DESC,
    parameters: {
      action: { type: 'string', enum: ['status', 'install', 'mathlib'], description: 'status 检查 / install 安装工具链 / mathlib 准备 Mathlib 工程。' },
      archive: { type: 'string', description: 'action=install：本地 Lean 发行包路径（tar.zst 或 zip），离线安装用。' },
      version: { type: 'string', description: `action=install：Lean 版本 tag（默认 ${DEFAULT_VERSION}）。` },
      force: { type: 'boolean', description: 'action=install：已安装也强制重装。' },
      projectDir: { type: 'string', description: 'action=status/mathlib：目标工程目录（绝对路径）。' },
      run: { type: 'boolean', description: 'action=mathlib：true 时在后台执行 lake update + lake exe cache get。' },
      rev: { type: 'string', description: 'action=mathlib：Mathlib 版本 tag（默认跟随已安装 Lean 版本，如 v4.35.0）。' },
      gitProxy: { type: 'string', description: 'action=mathlib：GitHub 代理前缀（如 https://gh-proxy.com/ 或 https://gh-proxy.com/https://github.com/），github.com 直连失败时用；写入 gitconfig 的 insteadOf。' },
      timeoutMs: { type: 'number', description: 'action=install：下载/解压超时（默认 900000）。' },
    },
    output: PLAIN_OUTPUT,
    isConcurrencySafe: false,
    execute: async (args, execCtx) => {
      const action = args?.action === 'install' || args?.action === 'mathlib' ? args.action : 'status'
      try {
        if (action === 'status') {
          const projectDir = resolveProjectDir(args, config)
          const status = await environmentStatus({ config, projectDir, signal: execCtx?.signal ?? null })
          if (projectDir && existsSync(projectDir)) status.mathlibProgress = readMathlibProgress(projectDir)
          return { ok: true, text: formatEnv(status) }
        }
        if (action === 'install') {
          const archive = typeof args?.archive === 'string' && args.archive.trim() ? resolvePath(args.archive.trim()) : undefined
          const timeoutMs = clampInt(args?.timeoutMs, 900_000, 60_000, 3_600_000)
          const started = Date.now()
          let lastLogged = 0
          const result = await ensureToolchain({
            config,
            archivePath: archive,
            version: typeof args?.version === 'string' ? args.version : config.version,
            force: args?.force === true,
            signal: execCtx?.signal ?? null,
            timeoutMs,
            onProgress: ({ received, total }) => {
              const now = Date.now()
              if (now - lastLogged < 15_000) return
              lastLogged = now
              const mb = (received / 1048576).toFixed(1)
              logger.info(`[lean-verify] 下载 Lean：${mb}${total ? ` / ${(total / 1048576).toFixed(1)}` : ''} MB`)
            },
          })
          const text = formatInstall({
            ok: Boolean(result.located),
            message: result.message,
            tag: result.tag,
            toolchain: result.located,
            download: result.download,
            elapsedMs: Date.now() - started,
          })
          return { ok: Boolean(result.located), text }
        }
        // action === 'mathlib'
        const located = locateLean(config)
        if (!located) {
          return {
            ok: false,
            text: [
              '## Mathlib 工程：⚙ 未安装 Lean',
              '',
              `先在 ${resolveToolchainRoot(config)} 安装工具链：lean_env action="install"。`,
              'Mathlib 需要与 Lean 版本一致的 lake 工程，没有工具链时无法生成可用的工程。',
            ].join('\n'),
          }
        }
        const dataDir = resolveDataDir(config)
        const projectDir = resolveProjectDir(args, config) || resolvePath(config.mathlibProject || `${dataDir}/mathlib-project`)
        const scaffoldConfig = typeof args?.gitProxy === 'string' && args.gitProxy.trim()
          ? { ...config, gitProxy: args.gitProxy.trim() }
          : config
        const scaffold = await scaffoldMathlibProject({
          config: scaffoldConfig,
          located,
          projectDir,
          rev: typeof args?.rev === 'string' ? args.rev : config.mathlibRev,
          dataDir,
        })
        let running = null
        if (args?.run === true) {
          running = startMathlibSetup({ located, projectDir: scaffold.projectDir, gitConfig: scaffold.gitConfig })
        }
        const text = formatMathlib({
          ok: running ? Boolean(running.ok) : true,
          projectDir: scaffold.projectDir,
          leanToolchain: scaffold.leanToolchain,
          created: scaffold.created,
          gitConfig: scaffold.gitConfig,
          running: Boolean(running?.ok),
          pid: running?.pid,
          logPath: running?.logPath,
          donePath: running?.donePath,
          error: running && !running.ok ? running.error : undefined,
        })
        if (running && !running.ok) return { ok: false, text }
        return { ok: true, text }
      } catch (error) {
        return { ok: false, text: `lean_env 执行异常：${String(error?.message || error)}` }
      }
    },
  })

  try {
    toolsSvc.register(verifyTool)
    toolsSvc.register(probeTool)
    toolsSvc.register(envTool)
  } catch (error) {
    logger.warn(`[lean-verify] 工具注册失败：${String(error?.message || error)}`)
    return
  }
  logger.info('[lean-verify] 已注册工具 lean_verify / lean_probe / lean_env')
}