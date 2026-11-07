import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { ensureGitConfig, leanToolchainFromVersion, readMathlibProgress } from '../lib/mathlib.mjs'

const runsRoot = join(import.meta.dirname, '..', '.test-runs')
mkdirSync(runsRoot, { recursive: true })

test('ensureGitConfig 写入 OpenSSL 后端与可选代理 insteadOf', () => {
  const dir = join(runsRoot, 'gitconfig-plain')
  mkdirSync(dir, { recursive: true })
  const path = ensureGitConfig(dir)
  const content = readFileSync(path, 'utf8')
  assert.ok(content.includes('sslBackend = openssl'))
  assert.equal(content.includes('insteadOf'), false)

  const proxied = ensureGitConfig(dir, { gitProxy: 'https://gh-proxy.com/https://github.com/' })
  const proxiedContent = readFileSync(proxied, 'utf8')
  assert.ok(proxiedContent.includes('insteadOf = https://github.com/'))
  assert.ok(proxiedContent.includes('[url "https://gh-proxy.com/https://github.com/"]'))

  const prefixed = ensureGitConfig(dir, { gitProxy: 'https://gh-proxy.com/' })
  const prefixedContent = readFileSync(prefixed, 'utf8')
  assert.ok(prefixedContent.includes('[url "https://gh-proxy.com/https://github.com/"]'))
})

test('leanToolchainFromVersion 从版本号生成 lean-toolchain', () => {
  assert.equal(leanToolchainFromVersion('4.35.0'), 'leanprover/lean4:v4.35.0')
  assert.equal(leanToolchainFromVersion('Lean 4.35.0'), 'leanprover/lean4:v4.35.0')
  assert.equal(leanToolchainFromVersion(''), 'leanprover/lean4:stable')
})

test('readMathlibProgress 区分成功/失败/进行中', () => {
  const dir = join(runsRoot, 'mathlib-progress')
  mkdirSync(dir, { recursive: true })
  const donePath = join(dir, '.setup-done')
  const logPath = join(dir, 'setup.log')

  writeFileSync(donePath, 'RUNNING\n', 'utf8')
  let progress = readMathlibProgress(dir)
  assert.equal(progress.done, false)

  writeFileSync(logPath, '=== lake update ===\ninfo: mathlib: fetching\n', 'utf8')
  progress = readMathlibProgress(dir)
  assert.equal(progress.done, false)
  assert.ok(progress.logSize > 0)
  assert.ok(progress.tail.includes('fetching'))

  writeFileSync(donePath, 'DONE=0\n', 'utf8')
  progress = readMathlibProgress(dir)
  assert.equal(progress.done, true)
  assert.equal(progress.failed, false)
  assert.equal(progress.exitCode, 0)

  writeFileSync(donePath, 'DONE=1\n', 'utf8')
  progress = readMathlibProgress(dir)
  assert.equal(progress.done, true)
  assert.equal(progress.failed, true)
  assert.equal(progress.exitCode, 1)
})