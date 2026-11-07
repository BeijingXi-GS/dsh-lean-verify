# dsh-lean-verify — Lean 形式化论证插件

> 一句话定位：给做数学、计算机、几何与计算问题的人（以及替你做题的模型）一条**可核验的流水线**——把问题写成 Lean 4 命题，用真实 Lean 内核检查，产出「被证明了没有」的机器判定，而不是又一篇看起来像证明的散文。

> English abstract: A DeepSeek Harness plugin that turns math / CS / geometry / computation problems into Lean 4 formalizations and checks them with the real Lean kernel (compilation + `#print axioms` audit), so you can tell whether an answer or conjecture is actually *proved*, merely compiled, or still full of `sorry`. It registers three tools (`lean_verify`, `lean_probe`, `lean_env`), ships a formalization skill plus an agent preset, and can download the Lean toolchain and scaffold a Mathlib project on demand. Install the bundle with `plugin_manager action=install_bundle`, then create a new session and pick the preset.

> ⚠ **首次使用有真金白银的成本**：这个插件第一次用要先下载 Lean 工具链（**约 600 MB 下载、2–3 GB 磁盘**），要做真实数学/几何还得准备 Mathlib（**数 GB、10–40 分钟**）。没有工具链时，`lean_verify` 只会返回 **「⚙ 未安装 Lean 工具链 / 未验证」**，它不会、也不能假装证明成功。

它不是「再讲一遍解法」的助手，而是一条可核验的流水线：

```
自然语言问题 → Lean 命题（形式化陈述）→ Lean 证明 → 内核编译 → #print axioms 公理审计 → 机器判定
```

## 解决什么问题

| 你的痛点 | 它给什么 |
|---|---|
| 模型说「已证明」，但你没法确认它是真证了还是糊弄 | 真实 Lean 内核编译 + 公理审计，给出机器判定；`sorry` / 自定义 `axiom` / `native_decide` 全部单独标出 |
| 同一个答案，有人说是对的，有人说是错的 | 把「答案 = 某个值」写成 Lean 定理（`decide` / `native_decide` / `norm_num`），对错交给内核 |
| 想知道一个猜想是不是成立 | 先 `#eval` 小范围枚举找反例，再尝试证明；「证伪」与「证不出」分开报告 |
| 不知道 Mathlib 里定理叫什么、类型签名长什么样 | `lean_probe` 直接跑 `#check` / `#print` / `#eval`，不用靠记忆编名字 |
| 装 Lean / Mathlib 工程太麻烦 | `lean_env` 一条命令下载工具链、生成 lake 工程、后台 `lake update` + `lake exe cache get` |

## 交付内容

| 组件 | 说明 |
|---|---|
| 工具 `lean_verify` | 内核检查 + 公理审计 + 判定（主工具） |
| 工具 `lean_probe` | `#check` / `#eval` / `#print` / `#reduce` 探针 |
| 工具 `lean_env` | `status` / `install`（下载 Lean 工具链）/ `mathlib`（Mathlib 工程） |
| 技能 `lean-formalization` | 形式化协议、各题型编码模式、战术速查、Lean 模板 |
| 预设「Lean 形式化论证师」 | 常驻 persona：先形式化、再验证、诚实报告 |

## 判定口径（关键）

报告第一行永远是判定，口径如下（与报告里的字面标签一致）：

| 判定 | 含义 | 能否说「已证明」 |
|---|---|---|
| ✅ 内核已验证 | 编译通过，无 `sorry`/`admit`，无自定义公理，公理 ⊆ `{propext, Classical.choice, Quot.sound}` | 能（前提：陈述忠实于原问题） |
| ✅ 已验证（含可信计算） | 同上，但用了 `native_decide`（编译器可信扩展，不是纯内核证明） | 能，但必须注明用了可信计算 |
| ⚠ 条件证明 | 依赖自定义 `axiom` / `constant` | 只能说「在这些假设下成立」 |
| ⚠ 未完成：含 `sorry`/`admit` | 文件能编译，但存在未完成的证明 | 不能 | 
| ❌ 未通过 | 编译 / 类型检查错误 | 不能（命题或证明至少一个错） |
| ⚠ 没有可验证的命题 | 只有 `#check` / `#eval`，没有 theorem/lemma/example | 不能 |
| ⚠ strict 拒绝可信计算 | 用了 `native_decide` 且 `strict=true` | 不能（strict 模式只认纯内核） |
| ⚙ 未安装 Lean 工具链 / ⏱ 超时 / ⏹ 已中断 / ⚙ 执行错误 | 未运行或未跑完 | 不能 |

**工具只验证 Lean 陈述**；「Lean 陈述是否忠实翻译了原问题」必须由使用者/模型逐条核对，报告里必须写出形式化陈述。也就是说：

- **「编译通过」≠「证明完成」**：`sorry`、自定义 `axiom`、`native_decide` 三者都必须单独标注。
- **「没跑起来」≠「没验证通过」**：工具链没装时只会返回「未验证」，**不会**把「未运行」说成「已证明」；这种情况下正确的回答是「未验证 + 给安装步骤」，不是口头断言。

## 安装

**前置条件**：DeepSeek Harness 桌面版（`desktop` profile）、Node ≥ 22。

### 首次使用成本（先看这一节）

| 依赖 | 下载体积 | 磁盘占用 | 耗时 | 何时需要 |
|---|---|---|---|---|
| Lean 4 工具链（`lean` / `lake`） | ≈ 600 MB | 2–3 GB | 视网速 | **所有验证都必须有它** |
| Mathlib（`import Mathlib`） | 数 GB | 数 GB | 10–40 分钟（`lake exe cache get`） | 实数/代数/几何/分析等真实数学 |
| 什么也不装 | — | — | — | 只能得到「⚙ 未安装 Lean 工具链 / 未验证」 |

> 只想试一下的话，先装工具链（第 4 步），Lean **核心库**就能验证整数/有理数算术、列表与递归程序正确性、具体数值计算；Mathlib 可以之后再加。

### 安装步骤

```text
# 1) 克隆仓库
git clone <你的仓库地址> dsh-lean-verify
cd dsh-lean-verify

# 2) 把技能目录写成绝对路径（skill-filesystem 的 bundledSkillDir 不能是相对路径）
node scripts/set-skill-dir.mjs

# 3) 安装 bundle
plugin_manager action=install_bundle target="<repo-path>"

# 4) 首次使用：安装 Lean 工具链（约 600 MB 下载、2–3 GB 磁盘）
lean_env action="install"
```

5. 要做真实数学/几何，再准备 Mathlib（数 GB，10–40 分钟）：

   ```
   lean_env action="mathlib" run=true
   lean_env action="status" projectDir="<数据目录>/mathlib-project"   # 看进度
   ```

   之后 `lean_verify` 传 `projectDir` 即可用 `import Mathlib`。`projectDir` 既可以是脚手架工程，也可以直接指向一个已构建好的 Mathlib 仓库（例如 `lean_env` 数据目录下的 `mathlib-src`，只要它已 `lake exe cache get` 过）。

   > 首次 `import Mathlib` 约 1–3 分钟（加载 oleans），插件在传了 `projectDir` 时默认把超时放宽到 10 分钟。

   > 若 `github.com` 直连失败（国内网络常见），给 `lean_env` 传 GitHub 代理前缀（会写入 gitconfig 的 `insteadOf`）：
   > `lean_env action="mathlib" run=true gitProxy="https://ghproxy.net/"`（也接受完整形式 `https://ghproxy.net/https://github.com/`）。
   > 实测 `ghproxy.net` 能克隆 Mathlib 这种大仓库；`gh-proxy.com` 对大仓库可能卡住。代理服务是第三方服务，可用性不由本项目保证。
   > 后台日志在 `<projectDir>/setup.log`；`DONE=0` 表示更新+缓存都成功，`DONE=1` 表示某一步失败（看日志尾部）。
   > `lake exe cache get` 失败时会退化为从源码编译 Mathlib（可能数小时）；失败时先修网络再重跑。

6. 新建会话，在 Agent 预设列表选择「Lean 形式化论证师」。

> 数据目录默认 `$DSH_HOME/lean-verify`（Windows 为 `%USERPROFILE%\.dsh\lean-verify`，即 `~/.dsh/lean-verify`）；可用环境变量 `DSH_LEAN_HOME` 或 `config.dataDir` 覆盖。运行文件在 `<dataDir>/runs/`，保留最近 `keepRuns` 次。

### 离线安装工具链

先在能联网的机器上下载 Lean 官方 Windows/macOS/Linux 发行包（`lean-4.x.x-<platform>.tar.zst` 或 `.zip`），拷到目标机器后：

```
lean_env action="install" archive="<本地路径>/lean-4.35.0-windows.tar.zst"
```

## 使用

### 1. 验证一个程序性质（Lean 核心，无需 Mathlib）

```lean
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
```

```
lean_verify code=<上面代码>
```

预期：`✅ 内核已验证`，`rev_rev` 公理 ⊆ 标准三条。

> Lean **核心**只有 `Nat` / `Int` / `Rat` 等类型，没有 `ℕ` / `ℤ` / `ℚ` / `ℝ` 记号（后四者是 Mathlib 记号，`ℝ` 还需要 Mathlib 的 `Real`）。核心模式下请写 `Nat` / `Int`；用 Mathlib 记号时要 `import Mathlib` 并给 `lean_verify` 传 `projectDir`。

### 2. 验证一个数学命题（需要 Mathlib：`nlinarith` 处理非线性）

```lean
import Mathlib

def sumTo : Nat → Nat
  | 0 => 0
  | n + 1 => (n + 1) + sumTo n

theorem sumTo_correct (n : Nat) : 2 * sumTo n = n * (n + 1) := by
  induction n with
  | zero => rfl
  | succ k ih =>
      simp [sumTo]
      nlinarith
```

```
lean_verify code=<上面代码> projectDir="<mathlib-project>"
```

### 3. 验证具体数值答案（核心）

```
lean_probe code="#eval (1234 * 5678 : Nat)"          # 探测
lean_verify code="theorem ans : (1234 * 5678 : Nat) = 7006652 := by decide"
```

### 4. 验证 Mathlib 里的命题

```
lean_verify imports="Mathlib" code="theorem t (a b : ℝ) : (a + b)^2 = a^2 + 2*a*b + b^2 := by ring" projectDir="<mathlib-project>"
```

### 5. 证伪一个猜想

```
lean_verify code="theorem cex : ¬ (∀ n : Nat, n < n) := by intro h; have h2 := h 0; omega"
```

### 6. 查 Mathlib 名字/类型

```
lean_probe imports="Mathlib" projectDir="<mathlib-project>" code="#check Real.sqrt_sq\n#check Nat.Prime"
```

## 配置

`cordis.patch.yml` 中的插件行可改：

| 配置 | 默认 | 说明 |
|---|---|---|
| `dataDir` | `$DSH_HOME/lean-verify` | 数据目录（工具链、runs、gitconfig） |
| `toolchainDir` | `<dataDir>/toolchain` | 受管工具链目录 |
| `leanPath` | — | 指定已有 lean 可执行文件/目录（跳过受管目录） |
| `projectDir` | — | 默认 Mathlib 工程目录 |
| `mathlibProject` | `<dataDir>/mathlib-project` | `lean_env action="mathlib"` 默认工程目录 |
| `mathlibRev` | 跟随已安装 Lean 版本 | Mathlib 版本 tag |
| `gitProxy` | — | GitHub 代理前缀（如 `https://ghproxy.net/`），写入 gitconfig 的 `insteadOf`；`github.com` 直连失败时用 |
| `timeoutMs` | 180000 | `lean_verify` 默认超时 |
| `probeTimeoutMs` | 90000 | `lean_probe` 默认超时 |
| `keepRuns` | 40 | 保留最近运行目录数 |

## 目录结构

```text
dsh-lean-verify/
├── package.json
├── cordis.patch.yml          # bundle 声明：工具插件行 + Agent 预设「Lean 形式化论证师」
├── index.js                  # Host 插件：注册 lean_verify / lean_probe / lean_env
├── lib/
│   ├── toolchain.mjs         # 定位 / 下载 / 解压 / 运行 Lean
│   ├── verify-core.mjs       # 诊断解析、公理审计、判定
│   ├── mathlib.mjs           # Mathlib 工程脚手架与后台安装
│   └── report.mjs            # 中文判定报告
├── skills/lean-formalization/
│   ├── SKILL.md
│   ├── references/           # 形式化协议 / 题型模式 / Lean 与 Mathlib 速查
│   └── templates/            # 可复制的 Lean 骨架（验证 / 几何坐标 / 程序正确性 / 数值计算）
├── scripts/set-skill-dir.mjs # 把 skills/ 的绝对路径写进 bundledSkillDir
├── locale/                   # zh / en 元信息
├── tests/                    # node --test（解析/判定 + 真实内核 + Mathlib 集成）
└── README.md
```

## 依赖与兼容性

- DSH：桌面版（`desktop` profile），需要 `tools` 服务注册工具；预设需要 `agent-preset` / `skill-filesystem` / `persona` 等内置插件。
- Node：≥ 22（已在 22.19 上验证；插件只用 Node 内置模块，无 npm 运行时依赖）。
- 平台：Windows / macOS / Linux（`lib/toolchain.mjs` 按 `win32` / `darwin` / `linux` 与 `x64` / `arm64` 选择发行包；主要验证环境是 **Windows 11 + Node 22.19**）。
- 外部依赖：**Lean 4 工具链**（`lean_env action="install"` 按需下载）、可选 **Mathlib**（`lean_env action="mathlib"`）、可选 **GitHub 代理**（`gitProxy`）。三者都不是本仓库的捆绑内容。
- 建议在宽松的本地环境里跑：验证时插件要 spawn `lean` 进程、写数据目录；受限沙箱可能拒绝子进程或写入。

## 测试

```bash
npm test                  # = node --test tests/（标准跑法）
npm run test:direct       # 逐个文件直接跑，不依赖 test runner spawn 子进程
```

- **不需要 Lean 也能跑**：`tests/parse.test.mjs`（诊断解析、公理分类、声明扫描、源码生成）与 `tests/mathlib.test.mjs`（gitconfig 生成、`lean-toolchain` 推导、Mathlib 进度解析）是纯逻辑测试；`tests/lean.test.mjs` 里「没有工具链时返回 `no-toolchain`、不误报 verified」这一条也总能跑。
- **需要 Lean 的用例会自动跳过**：检测不到工具链时，真实内核用例标 skipped（输出里是 `skip`，不是 pass），整个测试仍然通过；装了工具链（包括 `lean_env action="install"` 之前就存在于数据目录的）才会真跑内核编译。
- **Mathlib 集成测试**：设置 `DSH_LEAN_TEST_PROJECT=<已构建的 Mathlib 工程>` 才运行，否则跳过。
- 测试会在仓库根目录生成 `.test-runs/`（运行文件、临时 gitconfig）；它已被 `.gitignore` 忽略，属于测试运行时生成产物，不随仓库分发。
- 在受限沙箱里 `node --test tests/` 需要 test runner spawn 子进程，可能被拒绝（`spawn EPERM`）；此时用 `npm run test:direct` 或直接运行单个测试文件（如 `node tests/parse.test.mjs`）。

## 已知限制

1. **验证的是 Lean 陈述，不是原问题的自然语言**。形式化忠实度必须人工/模型核对；命题弱于原问题（漏假设、换量词、把实数写成有理数）时，验证结果无效。工具会在报告里反复提示。
2. **没有工具链就没有验证**。未安装 Lean 时 `lean_verify` 返回「⚙ 未安装 Lean 工具链 / 未验证」，`lean_probe` 返回「未找到工具链」；这一步**不会**假装成功，也不能从「没跑」推出「已证明」。必须先 `lean_env action="install"`。
3. **首次使用成本高**：工具链约 600 MB 下载 / 2–3 GB 磁盘，Mathlib 数 GB / 10–40 分钟；离线环境要自己准备发行包（`archive=`）。
4. `native_decide` 是编译器可信扩展，不是纯内核证明；`strict=true` 会拒绝它（判定为「⚠ strict 拒绝可信计算」，不算已验证）。
5. 复杂度/浮点/概率类断言需要先建立成本或误差模型；Lean 不直接验证「实际运行时间」。
6. Mathlib 版本必须与 Lean 工具链版本匹配；脚手架默认取「已安装 Lean 版本对应的 Mathlib tag」（如 `v4.35.0`），也可用 `config.mathlibRev` 或 `lean_env rev=` 覆盖。版本不匹配会直接编译失败。
7. Windows 受限环境下 `curl`（Schannel）可能无法联网；插件生成的 `gitconfig` 让 git 走 OpenSSL。`lake exe cache get` 需要工具链 `bin` 在 PATH（插件后台脚本已自动处理）；缓存地址是 `cache.mathlib.org`，与 GitHub 是否可达无关。
8. `bundledSkillDir` 必须是自己机器上的绝对路径：不跑 `node scripts/set-skill-dir.mjs` 时，插件与预设照常工作，只是 `lean-formalization` 技能不会被自动加载——persona 里有「技能加载失败就按提示词框架继续」的兜底，但报告里会说明未加载技能。
9. 测试依赖运行机器上的环境（Lean 工具链 / 受限沙箱是否允许 spawn）；真实内核与 Mathlib 用例在缺条件时跳过，不是「全部通过」。

## 来源、数据与版权说明

- 本仓库不捆绑任何第三方数据、题库或字幕原文；不含 B 站 / 试卷 / 书籍内容。
- 运行时会**按用户要求**下载第三方软件：**Lean 4**（leanprover/lean4，Apache-2.0）与 **Mathlib4**（leanprover-community/mathlib4，Apache-2.0），来自官方 GitHub Releases / 仓库，以及可选的第三方 GitHub 代理镜像。它们不是本仓库的一部分，其许可与安全由上游负责。
- 技能与模板里的 Lean 代码是通用写法示例（`List` 反转、坐标几何、递归求和等），不来自特定教材或竞赛原题。
- 文中出现的工具名 `#check` / `#eval` / `#print axioms` / `native_decide` 等属于 Lean 与 Mathlib 项目。

## 开源协议

[MIT](LICENSE) © 2026 Huhehaotedong