-- 模板 2：坐标几何（需要 Mathlib 工程：lean_verify 传 projectDir）
--
-- 思路：点 = ℝ × ℝ；几何关系 → 代数等式；证明 = ring / nlinarith / norm_num。
-- 这是竞赛几何最稳的路径；综合几何（EuclideanGeometry）引理多、成本高。

import Mathlib

abbrev Pt := ℝ × ℝ

/-- 三点共线：向量叉积为零。 -/
def collinear (a b c : Pt) : Prop :=
  (b.1 - a.1) * (c.2 - a.2) = (b.2 - a.2) * (c.1 - a.1)

/-- 距离平方。 -/
def distSq (a b : Pt) : ℝ := (a.1 - b.1) ^ 2 + (a.2 - b.2) ^ 2

/-- 四点共圆：存在圆心与半径。 -/
def concyclic (a b c d : Pt) : Prop :=
  ∃ (o : Pt) (r : ℝ), distSq o a = r ∧ distSq o b = r ∧ distSq o c = r ∧ distSq o d = r

/-- 中点。实数除法是非计算性的，必须标 noncomputable。 -/
noncomputable def mid (a b : Pt) : Pt := ((a.1 + b.1) / 2, (a.2 + b.2) / 2)

-- 例 1：具体数值，norm_num 直接算
theorem collinear_example : collinear (0, 0) (1, 1) (2, 2) := by
  norm_num [collinear]

-- 例 2：一般位置，ring 展开多项式
theorem collinear_midpoint (a b : Pt) : collinear a (mid a b) b := by
  unfold collinear mid
  ring

-- 例 3：点到中点距离
theorem distSq_midpoint (a b : Pt) :
    distSq a (mid a b) = distSq b (mid a b) := by
  unfold distSq mid
  ring

/-
使用说明：
1. 把题目中的点用参数表示（如 A = (ax, ay)），条件写成 `(h : ...)`；
2. 结论写成 collinear / concyclic / 等式；
3. `norm_num` 处理具体数值，`ring` 处理恒等式，`nlinarith` 处理不等式/平方和；
4. 退化情形（重合点、三点共线）在报告里说明是否允许；
5. 坐标化不改变几何性质，但要在报告里写出「选取了笛卡尔坐标」这一步；
6. 命名冲突：Mathlib 已有 `midpoint`、`collinear` 等名字，自定义时换名（如 `mid`、`myCollinear`）；
7. 实数上的除法/开方定义要标 `noncomputable def`，否则报 `dependsOnNoncomputable`。
-/