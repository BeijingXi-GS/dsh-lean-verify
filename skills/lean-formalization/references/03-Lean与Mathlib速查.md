# 03 Lean 与 Mathlib 速查（用于迭代排错）

> 只收录实际会用到的内容。拿不准的名字一律先 `#check` / `exact?` / `apply?`，不要凭记忆写。

---

## 1. 两档工具链：核心 vs Mathlib

| 能力 | Lean 核心（无需 Mathlib） | 需要 Mathlib |
|---|---|---|
| 类型 | `Nat` `Int` `Rat` `Bool` `List` `Option` `Prod` | Mathlib 记号 `ℕ` `ℤ` `ℚ` `ℝ` `ℂ`；`Finset` `Polynomial` `SimpleGraph` `EuclideanGeometry` … |
| 战术 | `simp` `omega` `decide` `native_decide` `induction` `cases` `constructor` `rw` `calc` `rfl` `exact` `apply` `intro` `by_contra` `push_neg` `contradiction` | 额外：`norm_num` `ring` `ring_nf` `linarith` `nlinarith` `positivity` `gcongr` `field_simp` `polyrith` `aesop` `exact_mod_cast` `push_cast` `norm_cast` |
| 安装 | `lean_env action="install"` | `lean_env action="mathlib" run=true` |

> 注意：`omega` 在当前核心 Lean 中可用；`norm_num`/`ring`/`linarith` 不在核心，**必须 `import Mathlib` 且有 Mathlib 工程**（`lean_verify projectDir=...`）。没有 Mathlib 时看到 `unknown tactic` 就是这个问题。

---

## 2. 战术选择表

| 目标形态 | 首选 | 备选 |
|---|---|---|
| 具体数值等式（`2^100 = …`） | `norm_num`（Mathlib）/ `decide`（小范围） | `native_decide`（大范围，标可信计算） |
| 自然数/整数线性算术 | `omega` | `simp` + 引理 |
| 代数恒等式 | `ring` / `ring_nf` | `simp` + `ring_nf` |
| 线性不等式 | `linarith` | `omega`（整数） |
| 非线性不等式 | `nlinarith [sq_nonneg …]` | `positivity` + `gcongr` |
| 分式/除法 | `field_simp` | `norm_num` |
| 定义展开 | `simp [defName]` | `rfl` / `unfold` |
| 结构/归纳 | `induction` / `cases` | `rcases` |
| 存在性 | `exact ⟨wit, proof⟩` | `refine ⟨?_, ?_⟩` |
| 反证 | `by_contra h` / `push_neg at h` | `contradiction` |
| 自动 | `aesop`（Mathlib） | `simp_all` |

---

## 3. 报错 → 修法

| 报错 | 含义 | 修法 |
|---|---|---|
| `unknown identifier 'x'` | 名字不存在 / 没 import / 拼错 | `#check` 确认；补 `import`；查 Mathlib 名字 |
| `unknown tactic 'norm_num'` | 战术不在当前环境 | 需要 Mathlib 工程（`import Mathlib` + `projectDir`） |
| `unknown module prefix 'Mathlib'` | 没有 Mathlib 工程 | `lean_env action="mathlib"`，并在 `lean_verify` 传 `projectDir` |
| `type mismatch` / `has type ... but is expected to have type ...` | 陈述或中间步骤类型错 | 看两边的类型；补强制转换 `(n : ℤ)`；检查 `ℕ`/`ℤ` |
| `unsolved goals` | 证明没做完 | 看剩余目标；补战术；拆 `have` |
| `Not a definitional equality` | `rfl` 证不了这个等式 | 换 `decide`/`norm_num`/`ring`；或等式本身错 |
| `Tactic 'decide' proved that the proposition … is false` | 命题为假 | 转证伪：写 `¬ 命题` 并给反例 |
| `unknown constant 'foo'`（来自 `#print axioms`） | 公理审计找不到声明 | 检查 private/局部声明；工具会把它标为「未审计」 |
| `maximum heartbeats exceeded` | 计算太重 | 拆小；`set_option maxHeartbeats 1000000 in`；提高 `timeoutMs` |
| `failed to synthesize instance` / `failed to synthesize Decidable` | 类型类缺失（常见：对自定义谓词直接 `decide`） | 显式给实例；先 `unfold 定义` 再 `decide`；或 `rw` 展开后 `decide` |
| `dependsOnNoncomputable` | 定义依赖了非计算性的实数运算（除法/开方等） | 把 `def` 改成 `noncomputable def` |
| 名字已存在 / `has already been declared` | 与 Mathlib 已有名字冲突（`midpoint`、`collinear` 等） | 换自定义名（`mid`、`myCollinear`）；用 `#check 名字` 先确认 |
| `unknown module prefix 'Mathlib'` | 没有 Mathlib 工程或没传 projectDir | 见下文「Mathlib 工程」；`lean_env action="mathlib"` 后传 `projectDir` |
| `function expected at …` | 少了参数/括号 | 补参数；检查 `^`/`*` 优先级 |
| 编译通过但判定 ⚠ | 有 `sorry`/自定义 axiom/`native_decide` | 看报告「声明」表与公理；补证明或改严格模式 |

---

## 4. 常用命令

```lean
#check Nat.add_comm          -- 查名字与类型
#check @List.map             -- 看隐式参数
#print Nat.add_comm          -- 看定义/定理体
#print axioms my_theorem     -- 看依赖公理（lean_verify 自动做）
#eval 2 ^ 100                -- 计算（不是证明）
#reduce (fun x => x + 1) 2   -- 归约
#check (rfl : 1 = 1)         -- 快速验证表达式类型
set_option pp.all true       -- 打印全限定名（调试用）
set_option maxHeartbeats 1000000 in
theorem slow : ... := by ...
```

Mathlib 专用：
```lean
example : ... := by exact?      -- 找能直接 closing 的引理（会打印建议）
example : ... := by apply?      -- 找可用定理
example : ... := by simp?       -- 看 simp 用了哪些引理
```

---

## 5. Mathlib 工程

```bash
# 由插件生成（推荐）
lean_env action="mathlib" run=true          # 后台 lake update + lake exe cache get

# 手工（在工程目录）
lake update
lake exe cache get    # 下载预编译 oleans（数 GB，必须，否则要编译数小时）
lake env lean MyFile.lean
```

- `lean_verify` 传 `projectDir="<工程绝对路径>"` 后，工具用 `lake env lean` 检查；
- 首次 `import Mathlib` 约 1–3 分钟（加载 oleans），之后同一工程内通常 30–60 秒；这是正常开销，不是卡死；
- **缓存**：`lake exe cache get` 把 oleans 下载到 `<project>/.lake/cache`（数 GB）。若报「系统找不到指定的文件」/ `error code: 2`，通常是工具链 `bin` 目录不在 PATH（`cache.exe` 需要 Lean 运行时 DLL）；插件生成的 `setup.cmd` 已自动把工具链 bin 加到 PATH，手动执行时也要先加；
- 缓存下载地址是 `https://cache.mathlib.org/mathlib4-master`（Azure），能访问 GitHub 不代表能访问它，反之亦然；
- 数学定义/定理名先从简：`#check`、`exact?`、`apply?`、`simp?`；Mathlib 里很多常用名与自定义名冲突（`midpoint`、`collinear`、`dist`、`angle`），自定义时换名前缀；
- `noncomputable def`：涉及 `ℝ` 的除法、`Real.sqrt`、`Real.log` 等非计算运算时必须标，否则 `dependsOnNoncomputable`；
- Mathlib 版本必须与 Lean 工具链版本一致；插件的 `lean_env action="mathlib"` 默认取已安装 Lean 版本对应的 tag（如 `v4.35.0`），可用 `rev` 覆盖；
- 缓存下载失败时：检查网络/代理；`lake exe cache get` 用的是 `curl`，Windows Schannel 受限环境可能失败；插件已生成 `gitconfig`（OpenSSL 后端）供 git 使用。

---

## 6. 常见语义陷阱

| 陷阱 | 说明 |
|---|---|
| `Nat` 减法（Mathlib 记 `ℕ`） | `3 - 5 = 0`（截断）；差值/负数转 `Int`（`ℤ`） |
| `Nat` 除法 | 向下取整；`a / 0 = 0` |
| `%` | `a % 0 = a`；负数取模符号 |
| 强制转换 | `(n : ℤ)`、`(x : ℝ)` 要写；`↑n` 简写 |
| `^` 优先级 | 高于 `*`，低于函数应用 |
| 相等 vs 等价 | `=` 是命题相等（需要 DecidableEq 等），`↔` 是逻辑等价 |
| `Prop` 证明无关 | 同一命题的不同证明不可区分，别在证明上做计算 |
| `decide` | 需要 `Decidable` 实例；大范围会爆 |
| `native_decide` | 可信扩展（编译执行），不是纯内核 |
| `sorry` | 编译只报 warning，exit code 仍可能是 0；工具会单独判定 |

---

## 7. 判定口径（工具输出对照）

| 工具状态 | 你能说的话 |
|---|---|
| `verified` | 「Lean 内核已验证该形式化命题」 |
| `verified-trusted` | 「已验证，但用了 native_decide 可信计算」 |
| `conditional` | 「在列出的自定义假设下成立」 |
| `unproven` | 「证明未完成（含 sorry），不能算证明」 |
| `failed` | 「证明不成立或有编译错误」 |
| `no-statement` | 「没有可验证的命题」 |
| `no-toolchain` / `timeout` | 「未验证」 |

---

## 8. 文件与运行目录

- `lean_verify` 每次在 `<dataDir>/runs/<时间戳>-<label>/` 下生成 `Verify.lean` 与 `input.txt`，报告里给出绝对路径；
- 生成的 `Verify.lean` = 可选 import 头 + 你的代码 + 自动追加的 `#print axioms` 审计命令；
- 行号：报告里的行号是生成文件的行号；若加了 import 头，你的代码会整体下移若干行，报告会注明；
- `keepRuns` 配置控制保留最近多少次运行（默认 40）。