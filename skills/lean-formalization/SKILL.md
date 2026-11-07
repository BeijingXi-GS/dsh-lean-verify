# lean-formalization 技能工作单

> 适用：用户要求「用 Lean 证明/验证」「把这个数学题形式化」「验证这个答案对不对」「证明/推翻这个猜想」「验证程序正确性」「用形式化方法论证几何/计算问题」。
> 技能定位：本文件是**深度工作单**，管「具体怎么把问题变成 Lean、怎么迭代到通过」；常驻 persona 管「不能违反什么」。冲突时以更严的为准。
>
> 配套文件索引（按需加载，不要一次全读）：
> `references/01-形式化协议.md`（问题解析 → 类型/量词 → 陈述 → 证明 → 判定的完整协议，含 Lean 语法最小集）；
> `references/02-题型模式.md`（数论/代数/不等式/组合/几何坐标化/计算/程序正确性/猜想证伪的编码套路）；
> `references/03-Lean与Mathlib速查.md`（战术清单、报错→修法对照、Mathlib 名字查找、工具链与 Mathlib 安装）；
> `templates/`（可直接复制的 Lean 骨架：命题验证、坐标几何、算法正确性、数值计算）。

---

## 0. 一句话流程

```
G0 需求解析 → G1 环境检查 → G2 形式化陈述 → G3 证明迭代 → G4 反例/证伪 → G5 判定与交付
```

核心原则：**先陈述、后证明；机器判定优先于口头判断；陈述保真优先于证明通过。**

---

## 1. 开工清单（G0）

先判断用户要验证的是哪一种：

| 类型 | 典型问法 | Lean 目标 |
|---|---|---|
| 数学定理 | 「证明对任意 n，…」 | `theorem : ∀ n, P n` |
| 竞赛/作业求值 | 「求 x 的值 / 这个答案对不对」 | `theorem : x = <答案>` 或反证 `≠` |
| 判断真假 | 「这个命题成立吗」 | 证明 `P` 或证明 `¬P`（给反例） |
| 猜想 | 「我猜…，对吗」 | 先小范围枚举证伪，再尝试证明 |
| 程序正确性 | 「这个算法对不对/满足规约吗」 | 把程序写成 Lean 函数 + `theorem spec` |
| 几何 | 「证明三点共线/四点共圆/…」 | 坐标化（首选）或 `EuclideanGeometry` |
| 纯计算 | 「算一下 2^100 / 这个级数和」 | `#eval` 探测 + `theorem : f n = 值 := by decide/native_decide` |
| 复杂度 | 「时间复杂度是 O(n log n)」 | 显式 cost 函数 + 不等式定理（说明模型假设） |

同时确认：用户要「验证答案」还是「验证命题」；有没有现成的 Lean/Mathlib 环境；问题里有没有隐含假设（正数、整数、非退化、有限）。

---

## 2. 环境检查（G1）

```
lean_env action="status"
```

- 未安装 → `lean_env action="install"`（约 600 MB 下载；可传 archive 离线装）。
- 需要 Mathlib（实数、代数、几何、analysis 几乎都需要）→ `lean_env action="mathlib" run=true`，后台装好后用 `lean_env action="status" projectDir=<工程目录>` 看进度。
- 没有 Mathlib 时只能用 **Lean 核心库**：`Nat` / `Int` / `Rat` / `List` / `Bool`（注意：`ℕ` / `ℤ` / `ℚ` / `ℝ` / `ℂ` 都是 **Mathlib 记号**，核心 Lean 里没有；核心没有 `Real`），战术只有 `simp`、`omega`、`decide`、`native_decide`、`induction`、`rfl`、`cases`、`constructor`、`rw`、`calc` 等；**没有** `norm_num`、`ring`、`linarith`、`nlinarith`、`positivity`、`gcongr`、`field_simp`。报告里要说清楚用的是哪一档。
  - 没有 Mathlib 仍可验证：整数/有理数坐标的具体几何题（`Int × Int` + `unfold` + `decide`）、纯计算题、列表/递归程序正确性、`Nat`/`Int` 线性算术。
  - 实数分析、`ring`/`linarith` 类代数、综合几何必须 Mathlib；`github.com` 直连失败时可给 `lean_env` 传 `gitProxy`。

> **工具链不可用时的唯一正确做法**：报告「未验证」，给出安装步骤，不口头断言证明成立。

---

## 3. 形式化陈述（G2）

按 `references/01-形式化协议.md` 的顺序做，**每一层都写下来**：

1. **对象**：变量是什么类型？核心用 `Nat` / `Int` / `Rat`；Mathlib 用 `ℕ` / `ℤ` / `ℚ` / `ℝ` / `ℂ` 或自定义结构。竞赛题里的整数优先 `Int`（Mathlib 写作 `ℤ`），正数加假设 `0 < x`。
2. **假设**：题目条件逐条翻译成 `(h : ...)`；隐含条件（分母非零、三角形非退化、n ≥ 1）必须显式补上并在报告里注明「这是补充假设」。
3. **结论**：量词顺序、`∧`/`∨`/`→`/`↔`/`∃`/`∀` 要精确；「存在唯一」用 `∃!`。
4. **陈述骨架**：先只写 `theorem name (params) : statement := by sorry`，用 `lean_verify` 确认陈述本身能过 elaboration（报告会标 ⚠ sorry，这是预期的）；类型/名字不确定时先用 `lean_probe` 做 `#check`。
5. **对照表**：把「原问题的一句话 → Lean 命题」写成对照，交付时附上。

### 陈述合法性自检（最常见的形式化错误）

- 把「对所有 n」写成 `∃ n`；把「若…则…」写成 `∧`；把「当且仅当」写成 `→`；
- `Nat` 减法截断（`3 - 5 = 0`）：涉及减法/负数一律转 `Int`（Mathlib 里是 `ℤ`）；
- 整数除法/取模的语义（`Nat.div` 向下取整），除法用 `∣` 或转 `Rat`（Mathlib 为 `ℚ`）；
- `Real.sqrt`（`ℝ` 上的开方）有 `sqrt x ^ 2 = x` 只在 `0 ≤ x` 时成立，别默认；
- 空集/空列表/边界 `n = 0` 容易漏；
- 几何：共线/共圆的退化情形（重合点、三点中有两点相同）要么显式排除，要么在结论里允许。

---

## 4. 证明迭代（G3）

1. **先跑小片段**：`lean_probe` 做 `#check`/`#eval`，确认名字与类型，不要把大文件一次写完再调。
2. **写证明**：按题型选策略（见 `references/02-题型模式.md`）。
3. **提交验证**：`lean_verify`（有 Mathlib 工程时传 `projectDir`），读判定与错误；
4. **读错误**：`unknown identifier` → 名字/导入错；`type mismatch` → 陈述写错；`unsolved goals` → 证明没做完；`decide` 报 false → 命题为假（转 G4）；`maximum heartbeats` → 拆小或加 `set_option maxHeartbeats`；
5. **迭代**：每次只改一处，改完再验。**禁止**用 `sorry`/`axiom`/`native_decide` 把状态「刷绿」；`native_decide` 只能用于确实是大规模有限计算，且必须在报告里标「可信计算」。

### 迭代停止条件

- 状态 `verified`：陈述与证明都被内核接受，且无自定义公理；
- 状态 `verified-trusted`：只有 native_decide（报告标出）；
- 状态 `conditional`：依赖自定义假设，报告必须列出假设；
- 状态 `unproven` / `failed`：继续改；若连续多轮无进展，转 G4 或如实报告卡点。

---

## 5. 反例与证伪（G4）

对「猜想 / 答案 / 判断题」，证伪往往比证明更快：

- 用 `#eval` 在有限范围枚举（`List.range 1000` 上 `filter` 反例）；
- 找到反例后写成 `theorem counterexample : ¬ (命题) := by decide`，或给出具体反例并 `native_decide` 验证；
- 数值答案被证伪：写 `theorem wrong : f 17 ≠ 12345 := by decide`；
- 区分三种结论：**已证明** / **已证伪**（有反例） / **未证明**（既没证出也没反例）。三者不能混写。

---

## 6. 判定与交付（G5）

`lean_verify` 的判定口径：

| 判定 | 含义 | 能否说「已证明」 |
|---|---|---|
| ✅ 内核已验证 | 无 sorry、无自定义公理、公理 ⊆ 标准三条 | 能（前提：陈述保真） |
| ✅ 已验证（含可信计算） | 同上但用了 native_decide | 能，但要注明「编译器可信扩展」 |
| ⚠ 条件证明 | 依赖自定义 axiom/constant | 只能说「在假设下成立」 |
| ⚠ 未完成（含 sorry） | 编译过但有 sorry/admit | 不能 |
| ❌ 未通过 | 编译/类型错误 | 不能；命题或证明至少一个错 |
| ⚠ 没有可验证的命题 | 只有 #check/#eval | 不能 |

交付模板：

```markdown
## 结论
✅ 已验证 / ⚠ 条件成立 / ⚠ 未完成 / ❌ 已证伪

## 形式化陈述
（Lean 代码原文）

## 与原问题的对照
| 原问题 | Lean 陈述 | 差异 |
|---|---|---|
| … | … | 无 / 补充假设 … / 只验证了 n ≤ 100 |

## 机器证据
- 工具链：Lean 4.x（来源 managed/path）± Mathlib
- lean_verify：状态、声明表、公理、关键错误
- 文件：<路径>/Formalization.lean

## 未完成项与风险
- 哪些子命题没验证；
- 用了哪些可信扩展（native_decide）；
- 陈述保真上的假设与限制。
```

同时把可复用的 Lean 源码保存到工作区（`<问题名>/Formalization.lean`），用 `present` 交付文件卡片。

---

## 7. 常见坑（完整版见 references/03）

1. **把「编译通过」当「证明完成」**：`sorry` 不报错，只报 warning；工具判定会标 ⚠。
2. **把 `#eval` 当证明**：它只说明这次算出来是这个值，不是对所有输入成立。
3. **把 `native_decide` 当纯内核**：它信任编译器；strict=true 会拒绝。
4. **偷换命题**：证明不了就悄悄弱化结论/加假设——这是最严重的错误，报告必须展示最终 Lean 陈述。
5. **`Nat` 减法/除法语义**：截断会让你「证明」一个错误的算术命题。
6. **类型强制转换**：`(n : Int)`、`(x : ℝ)` 要显式；`norm_num`/`ring` 在不同类型上行为不同。
7. **Mathlib 名字记错**：用 `#check`、`exact?`、`apply?`、`simp?` 查，不要凭记忆写。
8. **大文件一次编译**：先小步验证，再拼装。
9. **超时**：`maximum heartbeats` 或文件太大时拆小、提高 `timeoutMs`。
10. **没有工具链却声称验证**：零容忍。

---

## 8. 工具速查

| 工具 | 用途 |
|---|---|
| `lean_env action="status"` | 看 lean/lake 版本、受管目录、Mathlib 工程、后台安装进度 |
| `lean_env action="install"` | 下载安装 Lean 工具链（可 `archive` 离线） |
| `lean_env action="mathlib"` | 生成 Mathlib 工程；`run=true` 后台 `lake update` + `lake exe cache get` |
| `lean_probe` | `#check` / `#eval` / `#print` / `#reduce` 快速探测 |
| `lean_verify` | 内核检查 + `#print axioms` 公理审计 + 判定（主工具） |