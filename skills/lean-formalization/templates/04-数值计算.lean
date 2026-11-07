-- 模板 4：计算题 / 数值答案（核心 Lean 即可；大数用 native_decide）
--
-- 流程：先用 lean_probe 的 #eval 探测候选值（只是探测），
--       再写 theorem 用 decide / native_decide / norm_num 做证明。

-- 例 1：小范围，decide
theorem compute_1 : (1234 * 5678 : Nat) = 7006652 := by decide

-- 例 2：大数，native_decide（快；报告会标「可信计算」）
theorem compute_2 : (2 : Nat) ^ 100 = 1267650600228229401496703205376 := by native_decide

-- 例 3：取模（2^3 ≡ 1 (mod 7)，所以 2^100 ≡ 2）
theorem compute_3 : (2 : Nat) ^ 100 % 7 = 2 := by decide

-- 例 4：线性范围验证（omega 能处理 Nat 线性算术）
theorem bound_example : ∀ n : Nat, n < 1000 → n ≤ 999 := by
  intro n h
  omega

-- 例 5：证伪一个错误答案
theorem wrong_answer_counterexample : ¬ ((2 : Nat) ^ 10 = 1025) := by decide

/-
计算题规则：
1. #eval 只用于探测，不能作为证明；
2. 精确算术优先 Nat / Int / Rat，避免 Float；
3. 大范围/大数用 native_decide，并在报告里注明「可信计算」；
4. 需要 Mathlib 时（norm_num/ring）要传 projectDir；
5. 浮点/近似值要写误差界或转有理数，不要直接等号比较；
6. 注意 pow_mod 这类题先算清规律：2^3 = 8 ≡ 1 (mod 7) → 2^100 ≡ 2。
-/