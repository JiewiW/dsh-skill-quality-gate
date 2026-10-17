# dsh-skill-quality-gate

SKILL.md 质量门禁插件：把"写技能靠模型自觉"变成系统强制。一个安装单元交付五类部件。

## 部件

| 部件 | 位置 | 作用 |
|---|---|---|
| 运行期技能 | `skills/skill-authoring.md` | 动 SKILL.md 正文前强制输出覆盖矩阵；挂载后随 catalog 自动加载 |
| turn/end 后置检查 | `scripts/skill-lint-turnend-plugin.mjs`（`lib/index.js` 安装） | 本 turn 改过 SKILL.md → 跑真实 linter → 未过检把**具体缺口**（规则号+位置+期望）注入下一 turn 开头；只提示，不阻断 |
| 确定性 linter | `scripts/skill-lint.mjs` | 退出码 0/1/2；stdout 仅 `FAIL <规则号> <缺口>` 行 |
| 规则增删事务 CLI | `scripts/skill-rule-add.mjs` / `skill-rule-remove.mjs` / `skill-rule-core.mjs` | 一次调用原子同步五处（正文/症状表/清单/description/索引），写盘后自动 lint，未过回滚 |
| 触发回归 | `scripts/trigger-regression.mjs` + `data/trigger-cases.json` | 症状样本对技能目录跑集合包含匹配，命中率不达标即非零退出 |

辅助：`skill-lint-on-save.ps1`（编辑器保存后触发）、`test/`（夹具与自检）、`docs/`（设计与契约文档）。

## 内核能力边界（0.2.0-rc.2 实测，见 `docs/INJECTION-NOTES.md`）

- 插件**只能观察不能事前拦截**：turn 边界经 `ctx.on("session/event")`；被写文件路径取自 `tool/call` 事件的 `arguments.file_path`；`agent/pre-step` 的 payload 不含待执行工具名与路径。
- 下一 turn 注入经 `agent/pre-step` waterfall 的 `decision.messages`，落盘为 **user/message**，不是 system/message。
- 不使用 `agent/turn-stopping` 做硬阻断（其返回值不参与 turn 结束判定），不引用已删除的 `agent/soft-cut`。

## 安装（profile 本地开发，file: 依赖）

1. profile `package.json`：`dependencies` 加 `"dsh-skill-quality-gate": "file:D:/dsh/dsh-skill-quality-gate"`；`dsh.profile.bundles` 数组加 `"dsh-skill-quality-gate"`（两处必须一致）。
2. 在 profile 目录执行 `pnpm install`。
3. 经 `dsh.cmd` 直启前先跑 `D:\dsh\DSH-fix-profile-shadowed-deps.ps1`（经 `DSH.ps1` 启动自动执行）。
4. 重启 dsh web；插件自带技能需重启才进 catalog。

卸载：删 dependencies 与 bundles 两处登记后 `pnpm install`；`cordis.patch.yml` 的 insert 随包移除，无需手改 profile。

## 用法

```powershell
# 编辑器保存后单文件校验（可填进 save hook）
pwsh <包目录>\skill-lint-on-save.ps1 -Path C:\Users\Administrator\.dsh\skills\<技能>\SKILL.md
# 提交前全量
pwsh <包目录>\skill-lint-on-save.ps1 -All

# 事务化新增/删除规则（写盘后自动 lint，未过回滚）
node <包目录>\scripts\skill-rule-add.mjs <SKILL.md> --json '<规则JSON>'
node <包目录>\scripts\skill-rule-remove.mjs <SKILL.md> --id <规则id>

# 触发命中率回归
node <包目录>\scripts\trigger-regression.mjs
```

事务状态文件在 `%USERPROFILE%\.dsh\skill-quality-gate\state.json`（不写包目录，升级不丢）。

## 自检

```powershell
node scripts\skill-lint-selftest.mjs          # linter 11 类缺陷检出
node scripts\skill-lint-turnend-plugin.mjs --self-test
node scripts\trigger-regression.mjs           # 14 条样本，阈值默认 1.0
```

## 边界

`harness-ab/`（4 档 A/B 评测框架）是一次性实验脚手架，**不在本插件内**，留在 `D:\dsh\output\harness-ab\`。
