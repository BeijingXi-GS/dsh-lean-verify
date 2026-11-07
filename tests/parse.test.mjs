import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSource,
  classifyAxioms,
  parseAxioms,
  parseDiagnostics,
  scanDeclarations,
  scanSource,
  stripCommentsAndStrings,
} from '../lib/verify-core.mjs'

test('stripCommentsAndStrings 去掉注释与字符串里的 sorry', () => {
  const source = [
    '-- 这里写着 sorry 但只是注释',
    'theorem a : True := by',
    '  /- 块注释里的 sorry 也不算 -/',
    '  trivial',
    'def s : String := "sorry 在字符串里"',
  ].join('\n')
  const cleaned = stripCommentsAndStrings(source)
  assert.equal(cleaned.includes('这里写着'), false)
  assert.equal(cleaned.includes('块注释'), false)
  assert.equal(cleaned.includes('字符串里'), false)
  assert.equal(cleaned.includes('trivial'), true)
  // 去掉注释后行数必须保持不变（行号映射依赖这个不变量）
  assert.equal(cleaned.split('\n').length, source.split('\n').length)
})

test('stripCommentsAndStrings 保留多行块注释内部的行数', () => {
  const source = ['def a := 1', '/- 第一行', '第二行', '第三行 -/', 'def b := 2'].join('\n')
  const cleaned = stripCommentsAndStrings(source)
  assert.equal(cleaned.split('\n').length, source.split('\n').length)
  assert.equal(cleaned.includes('第一行'), false)
  assert.ok(cleaned.includes('def b := 2'))
})

test('scanDeclarations 行号在含注释时不偏移', () => {
  const source = ['-- 注释一', 'theorem a : True := trivial', '', '-- 注释二', 'theorem b : True := trivial'].join('\n')
  const declarations = scanDeclarations(source)
  assert.deepEqual(
    declarations.map((decl) => [decl.fullName, decl.line]),
    [
      ['a', 2],
      ['b', 5],
    ],
  )
})

test('parseDiagnostics 解析带 code 的错误与多行消息', () => {
  const text = [
    'C:\\x\\Verify.lean:3:8: error(lean.unknownIdentifier): Unknown identifier `foo`',
    'C:\\x\\Verify.lean:5:0: error: Type mismatch',
    '  rfl',
    'has type',
    '  1 = 1',
    "C:\\x\\Verify.lean:9:2: warning: declaration uses `sorry`",
    "'thm' depends on axioms: [sorryAx]",
  ].join('\n')
  const diagnostics = parseDiagnostics(text)
  assert.equal(diagnostics.length, 3)
  assert.equal(diagnostics[0].severity, 'error')
  assert.equal(diagnostics[0].code, 'lean.unknownIdentifier')
  assert.equal(diagnostics[1].line, 5)
  assert.ok(diagnostics[1].message.includes('Type mismatch'))
  assert.ok(diagnostics[1].message.includes('has type'))
  assert.equal(diagnostics[2].severity, 'warning')
  // #print axioms 的输出不应被并入上一条诊断
  assert.equal(diagnostics[2].message.includes('depends on axioms'), false)
})

test('parseAxioms 解析依赖与不依赖', () => {
  const text = [
    "'a' does not depend on any axioms",
    "'b' depends on axioms: [propext, Classical.choice, Quot.sound]",
    "'c' depends on axioms: [sorryAx]",
    "'d' depends on axioms: [d._native.native_decide.ax_1_1]",
  ].join('\n')
  const parsed = parseAxioms(text)
  assert.deepEqual(parsed.get('a'), { axioms: [], none: true })
  assert.deepEqual(parsed.get('b').axioms, ['propext', 'Classical.choice', 'Quot.sound'])
  const classifiedC = classifyAxioms(parsed.get('c').axioms)
  assert.deepEqual(classifiedC.sorry, ['sorryAx'])
  const classifiedD = classifyAxioms(parsed.get('d').axioms)
  assert.equal(classifiedD.native.length, 1)
})

test('scanDeclarations 跟踪 namespace 并生成全限定名', () => {
  const source = [
    'namespace Foo',
    '',
    'theorem bar : 1 = 1 := rfl',
    '',
    'section',
    '',
    'lemma baz : 2 = 2 := rfl',
    '',
    'end',
    '',
    'end Foo',
    '',
    'theorem top : 3 = 3 := rfl',
  ].join('\n')
  const declarations = scanDeclarations(source)
  assert.deepEqual(
    declarations.map((decl) => decl.fullName),
    ['Foo.bar', 'Foo.baz', 'top'],
  )
})

test('scanSource 检测 sorry/admit/用户公理/native_decide', () => {
  const source = [
    'axiom cheat : False',
    'theorem bad : 1 = 2 := by sorry',
    'theorem fast : (List.range 10).length = 10 := by native_decide',
    'theorem ok : 1 = 1 := rfl',
  ].join('\n')
  const scan = scanSource(source)
  assert.equal(scan.sorries.length, 1)
  assert.equal(scan.axioms.length, 1)
  assert.equal(scan.axioms[0].name, 'cheat')
  assert.equal(scan.nativeDecide, 1)
})

test('buildSource 生成 import 头与公理审计命令', () => {
  const source = buildSource({
    code: 'theorem t : 1 = 1 := rfl',
    imports: ['Mathlib'],
    declarations: [{ fullName: 't' }],
  })
  assert.ok(source.content.startsWith('import Mathlib\n'))
  assert.ok(source.content.includes('#print axioms t'))
  assert.equal(source.headerLineCount, 2)
})

test('classifyAxioms 区分标准/自定义/sorry/native', () => {
  const classified = classifyAxioms(['propext', 'myAxiom', 'sorryAx', 'fast._native.native_decide.ax_1_1'])
  assert.deepEqual(classified.standard, ['propext'])
  assert.deepEqual(classified.custom, ['myAxiom'])
  assert.deepEqual(classified.sorry, ['sorryAx'])
  assert.equal(classified.native.length, 1)
})