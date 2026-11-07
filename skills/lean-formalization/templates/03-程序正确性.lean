-- 模板 3：程序正确性（Lean 核心即可；需要实数/非线性算术时加 Mathlib）
--
-- 思路：程序 → 纯函数（递归/归纳类型）；正确性 → 定理；证明 → induction + simp + omega。

-- ── 例 1：列表反转（核心，含辅助引理）──
def rev : List Nat → List Nat
  | [] => []
  | x :: xs => rev xs ++ [x]

theorem rev_append (xs ys : List Nat) : rev (xs ++ ys) = rev ys ++ rev xs := by
  induction xs with
  | nil => simp [rev]
  | cons x xs ih => simp [rev, ih, List.append_assoc]

theorem rev_rev (xs : List Nat) : rev (rev xs) = xs := by
  induction xs with
  | nil => rfl
  | cons x xs ih => simp [rev, rev_append, ih]

-- ── 例 2：规约式正确性（前置条件 → 后置条件，核心）──
def clamp (lo hi x : Int) : Int := max lo (min hi x)

theorem clamp_spec (lo hi x : Int) (h : lo ≤ hi) :
    lo ≤ clamp lo hi x ∧ clamp lo hi x ≤ hi := by
  unfold clamp
  constructor <;> omega

-- ── 例 3：递归函数与线性性质（核心）──
def sumTo : Nat → Nat
  | 0 => 0
  | n + 1 => (n + 1) + sumTo n

theorem sumTo_succ (n : Nat) : sumTo (n + 1) = sumTo n + (n + 1) := by
  simp [sumTo, Nat.add_comm]

/-
需要 Mathlib 的非线性求和公式（核心的 omega 处理不了乘法变量）：

  import Mathlib

  theorem sumTo_correct (n : Nat) : 2 * sumTo n = n * (n + 1) := by
    induction n with
    | zero => rfl
    | succ k ih =>
        simp [sumTo]
        nlinarith

程序正确性编码清单：
1. 程序的输入类型是否覆盖溢出/空输入/非法输入？
2. 副作用、可变状态、异常是否被建模？没有就说明「这是纯函数模型」。
3. 规约是否完整：前置条件 P、后置条件 Q，定理 `P → Q (f x)`。
4. 循环：改写成递归 + 循环不变量；用 induction 证明。
5. 复杂度：显式 cost 函数 + 不等式；报告里声明是抽象成本模型。
-/