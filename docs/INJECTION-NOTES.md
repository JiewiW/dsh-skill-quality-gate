# 覆盖矩阵的注入落地：两种形态与取舍

> 用途：本文件是 `skill-authoring` 技能的配套设计说明，供**父卡集成步骤**读取，决定"强制前置覆盖矩阵"用哪种机制落地。
> 定位：只写设计与取舍，**不实现内核改动**；形态二（pre-step 中间件）本文只给设计草案与待核实项。
> 内核基线：dsh-app-boot 0.2.0-rc.2。可用 turn 级事件：`turn/start`、`turn/end`、`agent/pre-step`、`agent/turn-stopping`（serial）、`agent/assistant-stream`、`agent/error`；`agent/soft-cut` 已被上游移除，**不得作为拦截点**。

---

## 形态一：skill 任务触发加载（零成本软形态）

**机制**：把覆盖矩阵要求写进 `~/.dsh/skills/skill-authoring/SKILL.md`，靠 frontmatter `description` 的触发词在"写/改 SKILL.md、技能、规范、清单"类任务上被 catalog 命中并加载。

**落地状态**：已落地。文件 `C:\Users\Administrator\.dsh\skills\skill-authoring\SKILL.md` 存在，frontmatter 为合法 YAML 且含 `name` 与 `description`。

**优点**：零内核改动、零额外进程、无回归风险；加载后规则与自查清单一起进上下文，成本只在命中的任务上发生。

**缺点**：
- **软约束**：模型可以不加载、可以加载了不照做，强制力完全依赖服从度；
- **收录时机**：新技能要**新会话启动**时才进 catalog，本会话内无法自证"能被加载"（验收只能查文件结构与内容，不能查命中）；
- **触发词漏项即静默失效**：description 缺词时技能不被加载，且没有任何报错信号（对应 R1）。

---

## 形态二：agent/pre-step 工具中间件（强制形态，仅设计）

**机制草案**：注册一个 `agent/pre-step` 钩子，在每次工具调用前检查"本次调用是否即将写 SKILL.md 类文件"；命中时在当次调用前追加上下文——一条"先交覆盖矩阵再写正文"的强制提示，或直接拒绝本次写入直至矩阵出现。

**落地状态**：**未实现**。本文件只给设计，父卡集成步骤负责实现决策。

**设计要点（若实现）**：
1. 判定入口：从 pre-step 拿到的调用信息中提取工具名与目标路径，匹配 `*SKILL.md`、`skills/**`、以及规范/清单类路径；
2. 注入动作：命中时把 SA-R1 的强制条款与矩阵六列表头追加到当次调用的前置上下文，而不是长驻 AGENTS.md 顶部；
3. 幂等：同一 turn 内重复命中只注入一次，避免 token 叠加；
4. 不拦 turn：只拦/改写单次工具调用，不依赖 `agent/turn-stopping` 做硬阻断（0.2.0 下其语义仅"通知"，未证实能否真正阻止 turn 结束）。

**待核实项（2026-10-06 父卡集成已实测回写，结论见本节末）**：
- [x] **已核实为「否」**：`agent/pre-step` 能否读取**下一步工具名**？——**不能**。pre-step 的 payload 只有 `{ messages, turn, step, signal }`（`dsh-agent-loop/lib/index.js:924-927`），无待执行调用信息；"即将写 SKILL.md"无法判定。
- [x] **已核实为「否」**：`agent/pre-step` 能否读取**目标文件路径**？——**不能**。同一 payload 中无 file_path；工具入参只在调用**之后**经 `session/event` 的 `tool/call` 事件可见（`index.js:693-699` 的 `{ turn, step, callId, name, arguments }`）。
- [x] **已核实为「是」**：`agent/pre-step` 能否**动态追加上下文**？——**能**。它是 waterfall，默认返回 `{ kind:"enter", messages: [...] }`，插件可在 `next()` 之后追加消息（`index.js:924-931`）。

**结论**：三项中前两项为否 ⇒ **形态二（pre-step 事前拦截写 SKILL.md）不成立**，降级为"事后检查 + 下一 turn 注入"；形态二的强制力只剩"提示"，不是"拦截"。

---

## 取舍对照

| 维度 | 形态一：skill 触发加载 | 形态二：pre-step 中间件 |
| --- | --- | --- |
| 强制力 | 软（靠模型服从） | 硬（可拦截/改写当次调用） |
| 内核改动 | 无 | 有（新增钩子与匹配逻辑） |
| 落地成本 | 已落地，零成本 | 待设计验证，至少 0.5～1 人天 |
| 生效时机 | 新会话启动进 catalog | 当前会话即时生效 |
| 失败模式 | 静默不加载、加载不照做 | 判定不准时误拦无关写入 |
| 风险 | 无回归风险 | 需回归验证工具调用链，误拦可能打断正常编辑 |
| 前置依赖 | description 触发词穷举（SA-R10） | 三项待核实项全部为"是" |

**建议路径**：先用形态一跑 A/B（C 档），测"漏项数是否从 5 降到 ≤1"；有收益再投入形态二。若形态一已把漏项压到阈值内，形态二可只做提示不做拦截。

---

## 与父卡集成步骤的接口

- 集成步骤读取本文件即可获得：两种形态的机制、优点/缺点、待核实项、取舍表与建议路径。
- 本文件与 `SKILL.md` 同目录落盘，父卡不需要解析 SKILL.md 正文来获取注入设计。
- 三项待核实项的实测结论已回写本节上方（2026-10-06）。

---

## 父卡集成实测结论（2026-10-06）

**挂载形态定论：采用首选链路（工具后校验，不拦 turn），形态二降级为"事后检查 + 下一 turn 注入"提示。**

### 首选链路已落地并实测

| 落点 | 产物 | 触发方式 |
| --- | --- | --- |
| 事务 CLI 写盘后自动校验 | `D:\dsh\tools\skill-rule-add.mjs` / `skill-rule-remove.mjs` | 默认调用 `D:\dsh\tools\skill-lint.mjs`；非 0 即回滚，退出码 2 |
| 编辑器保存后校验 | `D:\dsh\tools\skill-lint-on-save.ps1` | `pwsh D:\dsh\tools\skill-lint-on-save.ps1 -Path <SKILL.md>`（单文件）或 `-All`（全量技能目录） |

**"保存 SKILL.md 后触发 lint"的用法**：

```powershell
# 单文件（编辑器保存后手敲，或填进编辑器的 save hook）
pwsh D:\dsh\tools\skill-lint-on-save.ps1 -Path C:\Users\Administrator\.dsh\skills\<技能>\SKILL.md

# 提交前全量（任一未过检即整体退出码 1）
pwsh D:\dsh\tools\skill-lint-on-save.ps1 -All
```

退出码与 linter 对齐：0 通过 / 1 有缺口（stdout 逐条 `FAIL <规则号> <位置+期望>`）/ 2 用法或读文件错误。
缺口行可直接回填给模型定点修复，符合 3.4「报错要具体到缺口」。

### 次选链路（turn/end 后置检查）已实现为最小可运行插件

`D:\dsh\tools\skill-lint-turnend-plugin.mjs`，导出 `installSkillLintTurnEndPlugin(ctx, options)`。
自检通过：`node D:\dsh\tools\skill-lint-turnend-plugin.mjs --self-test` → 退出码 0。

**内核证据（`D:\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js`，版本 0.2.0-rc.2）**：

| 事实 | 源码位置 | 含义 |
| --- | --- | --- |
| `turn/start` 签名 `{ turn }` | `index.js:956` | `session.append("turn/start", { turn })` |
| `turn/end` 签名 `{ turn, reason }` | `index.js:1040` | `session.append("turn/end", { turn, reason: turnEnds })`；**是 append 不是 dispatch 钩子** |
| 插件只能观察 turn 边界 | `index.js:330`（内核自身用法）、`:987` | 经 `ctx.on("session/event", (subject, event) => …)` |
| "本 turn 改过哪些文件"可得 | `index.js:693-699` | `tool/call` 事件含 `{ turn, step, callId, name, arguments }`，`arguments.file_path` 即目标路径 |
| 下一 turn 注入可得 | `index.js:924-931` | `agent/pre-step` 是 waterfall，可在 `next()` 后追加 `decision.messages` |
| `agent/turn-stopping` 不能硬阻断 | `index.js:1012-1018` | serial 派发后**不修改** `turnEnds`；结束与否只由 `this.inbox.nextStep.length === 0` 决定 |

**3c 合规**：本集成未使用 `agent/turn-stopping` 做硬阻断，只做提示；未引用已删除的 `agent/soft-cut`。
（注：本机内核 `index.js:15-24` 存在一处 `DSH-SOFT-CUT-PORT` 本地移植区，那是宿主侧补丁，不是上游钩子契约，集成代码不依赖它。）

**3d 未触发**：次选链路可行，无需降级为"仅保留工具后校验"。
**当前状态**：该插件已实现并自检通过，但**尚未注册为活动 dsh 插件**（`profiles/web` 的 `package.json` / `cordis.yml` / `cordis.patch.yml` 均无引用）。
接入属运行期部署动作，需按插件开发规范落 profile 并重启宿主；本卡范围内只保证"实现 + 自检通过 + 源码证据成立"。