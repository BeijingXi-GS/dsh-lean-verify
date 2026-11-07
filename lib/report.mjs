/**
 * lib/report.mjs —— 把结构化判定渲染成模型/用户可读的中文报告。
 *
 * 报告的第一行必须是「判定」，因为模型最容易把「编译通过」误当「验证通过」。
 */

const STATUS = {
  verified: { icon: '✅', label: '内核已验证', detail: '所有声明被 Lean 内核接受，且未使用 sorry / 自定义公理；依赖公理 ⊆ {propext, Classical.choice, Quot.sound}。' },
  'verified-trusted': { icon: '✅', label: '已验证（含可信计算）', detail: '证明被内核接受，但依赖 native_decide 的编译器可信扩展；strict=true 可要求纯内核。' },
  unproven: { icon: '⚠', label: '未完成：含 sorry/admit', detail: '文件能编译，但存在未完成的证明，不能当作「已证明」。' },
  conditional: { icon: '⚠', label: '条件证明', detail: '结论依赖自定义 axiom / constant；只有这些假设成立时结论才成立。' },
  failed: { icon: '❌', label: '未通过', detail: 'Lean 报编译/类型检查错误，命题或证明至少有一个不成立。' },
  'trusted-rejected': { icon: '⚠', label: 'strict 拒绝可信计算', detail: '证明用了 native_decide，strict 模式不把它算作内核证明。' },
  'no-statement': { icon: '⚠', label: '没有可验证的命题', detail: '文件里没有 theorem/lemma/example；只有 #check / #eval 时请用 lean_probe。' },
  timeout: { icon: '⏱', label: '超时', detail: 'Lean 在超时前没有结束。可提高 timeoutMs，或把证明拆小。' },
  aborted: { icon: '⏹', label: '已中断', detail: '调用被取消。' },
  'exec-error': { icon: '⚙', label: '执行错误', detail: 'Lean 进程启动/运行失败。' },
  'no-toolchain': { icon: '⚙', label: '未安装 Lean 工具链', detail: '没有工具链时不能做任何验证。' },
  invalid: { icon: '⚙', label: '参数无效', detail: '缺少代码。' },
}

const DECL_STATUS = {
  kernel: '✅ 内核',
  trusted: '✅ 可信计算',
  conditional: '⚠ 条件',
  unproven: '⚠ sorry',
  compiled: '· 编译通过',
  error: '❌ 有错误',
}

function statusOf(status) {
  return STATUS[status] || { icon: '⚙', label: status || '未知状态', detail: '' }
}

function truncate(text, limit) {
  const value = String(text || '')
  return value.length > limit ? `${value.slice(0, limit)}\n…（截断，共 ${value.length} 字符）` : value
}

function formatDiagnostics(diagnostics, limit = 12) {
  if (!diagnostics || diagnostics.length === 0) return []
  const lines = []
  for (const diagnostic of diagnostics.slice(0, limit)) {
    const code = diagnostic.code ? ` (${diagnostic.code})` : ''
    const message = String(diagnostic.message || '').trim().replace(/\n/gu, '\n      ')
    lines.push(`- [${diagnostic.line}:${diagnostic.column}] ${diagnostic.severity}${code}: ${truncate(message, 600)}`)
  }
  if (diagnostics.length > limit) lines.push(`- …还有 ${diagnostics.length - limit} 条诊断，见生成文件`)
  return lines
}

function toolchainLine(toolchain = {}) {
  const version = toolchain.version || '未知版本'
  const source = toolchain.source ? `来源 ${toolchain.source}` : ''
  const project = toolchain.projectDir ? `；工程 ${toolchain.projectDir}` : ''
  return `${version}${source ? `（${source}）` : ''}${project}`
}

/** 验证报告。 */
export function formatVerify(result) {
  if (result.status === 'invalid' || result.status === 'no-toolchain') {
    return [`## 判定：${statusOf(result.status).icon} ${statusOf(result.status).label}`, '', result.message || ''].join('\n')
  }
  const meta = statusOf(result.status)
  const lines = [`## 判定：${meta.icon} ${meta.label}`, '']
  if (meta.detail && !result.verified) lines.push(`> ${meta.detail}`, '')
  lines.push(
    `- 工具链：${toolchainLine(result.toolchain)}`,
    `- 用时：${result.elapsedMs ?? '?'} ms；退出码：${result.exitCode ?? '?'}`,
    `- 生成文件：${result.filePath}`,
    `- 严格内核（strict 语义）：${result.kernelOnly ? '是' : '否'}；可作为答案验证：${result.verified ? '是' : '否'}`,
  )
  if (result.declarations?.length) {
    lines.push('', '### 声明')
    for (const decl of result.declarations) {
      const axiomText = decl.axioms?.length ? `；公理：${decl.axioms.join(', ')}` : decl.audit ? '；公理：无' : '；未审计'
      lines.push(`- \`${decl.fullName}\`（第 ${decl.line} 行）：${DECL_STATUS[decl.status] || decl.status}${axiomText}`)
    }
  } else if (result.status === 'no-statement') {
    lines.push('', '> 没有 theorem/lemma/example：这段代码只是命令（#check/#eval 等）。要验证命题，请写成 `theorem name : 命题 := by ...`；要试跑命令请用 `lean_probe`。')
  }
  if (result.errors?.length) {
    lines.push('', `### 错误（${result.errors.length}）`, ...formatDiagnostics(result.errors))
  }
  if (result.warnings?.length) {
    lines.push('', `### 警告（${result.warnings.length}）`, ...formatDiagnostics(result.warnings, 8))
  }
  if (result.notes?.length) {
    lines.push('', '### 说明', ...result.notes.map((note) => `- ${note}`))
  }
  if (result.auditErrors?.length) {
    lines.push('', `> 公理审计未完成的声明：${result.auditErrors.map((item) => `${item.line}`).join(', ')}（行号）`)
  }
  const axiomNames = (result.axioms || []).flatMap((item) => item.axioms || [])
  const customAxioms = (result.scan?.axioms || []).map((item) => `${item.kind} ${item.name}`)
  const nativeCount = result.scan?.nativeDecide || 0
  if (axiomNames.length || customAxioms.length || nativeCount) {
    lines.push('', '### 公理与可信扩展')
    if (axiomNames.length) lines.push(`- 定理依赖公理：${[...new Set(axiomNames)].join(', ')}`)
    if (customAxioms.length) lines.push(`- 源码自定义假设：${customAxioms.join('、')}`)
    if (nativeCount) lines.push(`- native_decide 使用：${nativeCount} 处（编译器可信扩展，非纯内核）`)
  }
  if (result.status === 'failed' && result.scan?.sorries?.length) {
    lines.push('', `> 源码中还有 ${result.scan.sorries.length} 处 sorry（行：${result.scan.sorries.map((item) => item.line).join(', ')}）。`)
  }
  if (result.output && (result.status === 'failed' || result.status === 'exec-error')) {
    lines.push('', '### Lean 原始输出（尾部）', '```', truncate(result.output, 4000), '```')
  }
  return lines.join('\n')
}

/** 探针报告。 */
export function formatProbe(result) {
  if (result.status === 'invalid' || result.status === 'no-toolchain') {
    return [`## 探针：${statusOf(result.status).icon} ${statusOf(result.status).label}`, '', result.message || ''].join('\n')
  }
  const ok = result.status === 'compiled'
  const lines = [`## 探针：${ok ? '✅ 执行完成' : '❌ 有错误'}`, '']
  lines.push(`- 工具链：${toolchainLine(result.toolchain)}`, `- 用时：${result.elapsedMs} ms；退出码：${result.exitCode}`)
  if (result.stdout) lines.push('', '### 输出（#check / #eval / #print）', '```', truncate(result.stdout, 6000), '```')
  else lines.push('', '> 没有输出：确认代码里确实有 #check / #eval / #print 命令。')
  if (result.errors?.length) lines.push('', `### 错误（${result.errors.length}）`, ...formatDiagnostics(result.errors))
  if (result.warnings?.length) lines.push('', `### 警告（${result.warnings.length}）`, ...formatDiagnostics(result.warnings, 6))
  lines.push('', `> 探针只执行命令，不做证明验收；要验证命题请用 lean_verify。生成文件：${result.filePath}`)
  return lines.join('\n')
}

/** 环境状态报告。 */
export function formatEnv(status) {
  const lines = [`## Lean 环境：${status.installed ? '✅ 可用' : '⚙ 未安装'}`, '']
  lines.push(`- 数据目录：${status.dataDir}`, `- 工具链目录：${status.toolchainRoot}`)
  if (status.installed) {
    lines.push(`- lean：${status.lean}`, `- lake：${status.lake}`, `- 版本：${status.version || '未知'}`, `- 来源：${status.source}`)
    if (status.toolchainSizeMB != null) lines.push(`- 工具链体积：约 ${status.toolchainSizeMB} MB`)
  }
  if (status.projectDir) {
    lines.push('', '### 工程')
    lines.push(`- 目录：${status.projectDir}`)
    if (status.project) {
      lines.push(`- lakefile：${status.project.lakefile || '缺失'}`)
      lines.push(`- Mathlib 已拉取：${status.project.mathlibCheckedOut ? '是' : '否'}`)
      if (status.project.mathlibCacheMB != null) lines.push(`- Mathlib 构建产物：约 ${status.project.mathlibCacheMB} MB`)
    } else {
      lines.push('- 目录不存在')
    }
  }
  if (status.mathlibProject) lines.push(`- 默认 Mathlib 工程：${status.mathlibProject}`)
  if (status.mathlibProgress) {
    lines.push('', '### Mathlib 后台安装进度')
    if (status.mathlibProgress.done) {
      lines.push(status.mathlibProgress.failed ? `- ❌ 失败（DONE=${status.mathlibProgress.exitCode}）` : '- ✅ 完成')
    } else if (status.mathlibProgress.logSize > 0) lines.push(`- 进行中（日志 ${status.mathlibProgress.logSize} 字符）`)
    if (status.mathlibProgress.tail) lines.push('```', truncate(status.mathlibProgress.tail, 2000), '```')
  }
  if (!status.installed) {
    lines.push('', '安装：`lean_env action="install"`（约 600 MB 下载、2–3 GB 磁盘）；离线可传本地 archive 路径。')
  } else {
    lines.push('', 'Mathlib（真实数学/几何通常需要）：`lean_env action="mathlib"` 生成工程；`run=true` 会在后台执行 lake update + cache get。')
  }
  return lines.join('\n')
}

/** 安装结果报告。 */
export function formatInstall(result) {
  if (!result.ok) return [`## 安装：❌ 失败`, '', result.message || result.error || ''].join('\n')
  const lines = [`## 安装：✅ 完成`, '', `- ${result.message}`]
  if (result.tag) lines.push(`- 版本：${result.tag}`)
  if (result.toolchain?.lean) lines.push(`- lean：${result.toolchain.lean}`)
  if (result.toolchain?.lake) lines.push(`- lake：${result.toolchain.lake}`)
  if (result.download?.bytes) lines.push(`- 下载：${(result.download.bytes / 1048576).toFixed(1)} MB`)
  lines.push('', '下一步：用 `lean_verify` 验证 first theorem，或 `lean_env action="mathlib"` 准备 Mathlib 工程。')
  return lines.join('\n')
}

/** Mathlib 脚手架报告。 */
export function formatMathlib(result) {
  if (!result.ok) return [`## Mathlib 工程：❌ 失败`, '', result.message || result.error || ''].join('\n')
  const lines = [`## Mathlib 工程：${result.running ? '🚀 后台安装已启动' : '✅ 脚手架就绪'}`, '']
  lines.push(`- 工程目录：${result.projectDir}`)
  if (result.leanToolchain) lines.push(`- lean-toolchain：${result.leanToolchain}`)
  if (result.created?.length) lines.push(`- 新建文件：${result.created.join('、')}`)
  if (result.gitConfig) lines.push(`- git 配置（OpenSSL 后端）：${result.gitConfig}`)
  if (result.running) {
    lines.push(`- 后台进程 PID：${result.pid}`, `- 日志：${result.logPath}`, `- 完成标记：${result.donePath}`)
    lines.push('', '后台正在执行 `lake update` 与 `lake exe cache get`（数 GB，可能 10–40 分钟）。用 `lean_env action="status" projectDir="…"` 查看进度；完成后用 `lean_verify projectDir="…"`。')
  } else {
    lines.push('', '下一步（在工程目录执行）：', '```', `lake update`, `lake exe cache get`, '```')
    lines.push('', '完成后用 `lean_verify` 并传 `projectDir` 指到该工程。若想由插件后台执行，调用 `lean_env action="mathlib" run=true`。')
  }
  return lines.join('\n')
}

export { STATUS }