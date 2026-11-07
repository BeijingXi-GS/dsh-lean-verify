/**
 * 真实 Lean 内核测试：检测到 Lean 工具链才运行，否则跳过。
 *
 * 工具链定位顺序：DSH_LEAN_TEST_LEAN 环境变量 → locateLean() 默认探测。
 * 运行：node --test lean-verify/tests/
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { locateLean } from '../lib/toolchain.mjs'
import { probeCode, verifyCode } from '../lib/verify-core.mjs'

const located = process.env.DSH_LEAN_TEST_LEAN
  ? { lean: process.env.DSH_LEAN_TEST_LEAN }
  : locateLean({})
const hasLean = Boolean(located?.lean)
const skip = hasLean ? false : '未找到 Lean 工具链，跳过真实内核测试'

const runsRoot = join(import.meta.dirname, '..', '.test-runs')
if (hasLean) mkdirSync(runsRoot, { recursive: true })
const config = hasLean ? { leanPath: located.lean, dataDir: runsRoot, keepRuns: 3 } : {}

test('内核证明 → verified', { skip }, async () => {
  const result = await verifyCode({
    code: 'theorem add_zero_test (n : Nat) : n + 0 = n := by omega',
    config,
  })
  assert.equal(result.status, 'verified')
  assert.equal(result.verified, true)
  assert.equal(result.declarations[0].status, 'kernel')
  const standard = new Set(['propext', 'Classical.choice', 'Quot.sound'])
  assert.ok(result.declarations[0].axioms.every((axiom) => standard.has(axiom)))
})

test('sorry → unproven（且不标记为已验证）', { skip }, async () => {
  const result = await verifyCode({ code: 'theorem bad : 1 = 2 := by sorry', config })
  assert.equal(result.status, 'unproven')
  assert.equal(result.verified, false)
  assert.ok(result.scan.sorries.length >= 1)
})

test('错误证明 → failed', { skip }, async () => {
  const result = await verifyCode({ code: 'theorem wrong : 1 = 2 := rfl', config })
  assert.equal(result.status, 'failed')
  assert.ok(result.errors.length >= 1)
})

test('native_decide → verified-trusted；strict 拒绝', { skip }, async () => {
  const code = 'theorem fast : (List.range 100).length = 100 := by native_decide'
  const trusted = await verifyCode({ code, config })
  assert.equal(trusted.status, 'verified-trusted')
  assert.equal(trusted.verified, true)
  assert.equal(trusted.kernelOnly, false)
  const strict = await verifyCode({ code, config, strict: true })
  assert.equal(strict.status, 'trusted-rejected')
  assert.equal(strict.verified, false)
})

test('自定义 axiom → conditional', { skip }, async () => {
  const result = await verifyCode({ code: 'axiom cheat : 1 = 2\ntheorem bogus : 1 = 2 := cheat', config })
  assert.equal(result.status, 'conditional')
  assert.equal(result.verified, false)
  assert.ok(result.scan.axioms.some((item) => item.name === 'cheat'))
})

test('只有命令 → no-statement', { skip }, async () => {
  const result = await verifyCode({ code: '#check Nat.add_comm\n#eval 1 + 1', config })
  assert.equal(result.status, 'no-statement')
  assert.equal(result.verified, false)
})

test('多命名空间声明可审计', { skip }, async () => {
  const result = await verifyCode({
    code: 'namespace TestNs\n\ntheorem inside : 2 + 2 = 4 := by decide\n\nend TestNs',
    config,
  })
  assert.equal(result.status, 'verified')
  assert.ok(result.declarations.some((decl) => decl.fullName === 'TestNs.inside' && decl.status === 'kernel'))
})

test('探针输出 #check / #eval', { skip }, async () => {
  const result = await probeCode({ code: '#check Nat.add_comm\n#eval 2 ^ 10', config })
  assert.equal(result.status, 'compiled')
  assert.ok(result.stdout.includes('Nat.add_comm'))
  assert.ok(result.stdout.includes('1024'))
})

test('没有工具链时返回 no-toolchain（不误报 verified）', async () => {
  const result = await verifyCode({
    code: 'theorem t : 1 = 1 := rfl',
    config: { leanPath: 'C:/does/not/exist/lean.exe', toolchainDir: 'C:/does/not/exist/toolchain', dataDir: runsRoot },
  })
  assert.equal(result.status, 'no-toolchain')
  assert.equal(result.verified, false)
})

// 需要 Mathlib 的集成测试：设置 DSH_LEAN_TEST_PROJECT 指向已就绪的 Mathlib 工程才运行。
const mathlibProject = process.env.DSH_LEAN_TEST_PROJECT
const hasMathlib = Boolean(hasLean && mathlibProject)
const skipMathlib = hasMathlib ? false : '未提供 DSH_LEAN_TEST_PROJECT（Mathlib 工程），跳过 Mathlib 集成测试'

test('Mathlib：ring 恒等式 → verified', { skip: skipMathlib }, async () => {
  const result = await verifyCode({
    code: 'import Mathlib\n\ntheorem sq_expand (a b : ℝ) : (a + b) ^ 2 = a ^ 2 + 2 * a * b + b ^ 2 := by ring',
    projectDir: mathlibProject,
    config,
    timeoutMs: 300_000,
  })
  assert.equal(result.status, 'verified')
  assert.equal(result.verified, true)
})

test('Mathlib：坐标几何（一般位置）→ verified', { skip: skipMathlib }, async () => {
  const code = [
    'import Mathlib',
    '',
    'abbrev Pt := ℝ × ℝ',
    '',
    'def collinear (a b c : Pt) : Prop :=',
    '  (b.1 - a.1) * (c.2 - a.2) = (b.2 - a.2) * (c.1 - a.1)',
    '',
    'theorem collinear_midpoint (a b : Pt) : collinear a ((a.1 + b.1) / 2, (a.2 + b.2) / 2) b := by',
    '  unfold collinear',
    '  ring',
  ].join('\n')
  const result = await verifyCode({ code, projectDir: mathlibProject, config, timeoutMs: 300_000 })
  assert.equal(result.status, 'verified')
})

test('Mathlib：数值答案 norm_num → verified', { skip: skipMathlib }, async () => {
  const result = await verifyCode({
    code: 'import Mathlib\n\ntheorem big : (2 : ℕ) ^ 100 = 1267650600228229401496703205376 := by norm_num',
    projectDir: mathlibProject,
    config,
    timeoutMs: 300_000,
  })
  assert.equal(result.status, 'verified')
})