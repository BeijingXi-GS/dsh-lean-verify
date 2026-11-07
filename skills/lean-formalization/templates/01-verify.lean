-- 模板 1：通用命题验证
-- 用法：复制本文件，替换陈述与证明，然后
--   lean_verify code=<本文件内容> [imports=...] [projectDir=<Mathlib 工程>]
--
-- 判定目标：✅ 内核已验证（无 sorry、无自定义 axiom；公理 ⊆ 标准三条）

-- 有 Mathlib 工程时取消下一行注释（并给 lean_verify 传 projectDir）
-- import Mathlib

/- 1. 形式化陈述：把原问题的对象/假设/结论逐条写下来 -/

theorem main_statement (n : Nat) (h : 0 < n) : 0 < n + 1 := by
  -- 2. 证明
  omega

/- 3. 自检清单（交付前逐条确认）
   [ ] 量词与顺序与原问题一致
   [ ] 类型选对（Nat/ℤ/ℚ/ℝ），减法/除法语义检查过
   [ ] 所有假设都出现在命题里；补充假设已标注
   [ ] 结论没有弱化（= 没变成 ≤，∀ 没变成只验证有限范围）
   [ ] 没有 sorry / admit / 自定义 axiom
   [ ] lean_verify 判定为 verified（或 verified-trusted 并注明）
-/

-- 4. 反例模板（命题为假时用）
-- theorem counterexample : ¬ (∀ n : Nat, n < n + 1) := by
--   intro h
--   have h2 := h 0
--   omega