# CLI ↔ linter 接口契约（方向一方案 A：skill-rule-add 事务化 CLI）

> 产出方：任务②（`skill-rule-add.mjs` / `skill-rule-remove.mjs`）
> 对接方：任务③（`skill-lint.mjs`）、父卡集成步骤
> 状态：**双向已实测接通**（2026-10-06，用③的真实 `D:\dsh\tools\skill-lint.mjs` 跑通新增+删除全链路）

---

## 1. 契约范围

事务工具与 linter 是**两个独立进程**，通过「进程退出码 + 子进程参数」对接，不共享内存、不互相 import。
事务工具不解析 linter 的输出内容做判据，只认退出码；linter 也不需要知道是谁调用了它。

```
skill-rule-add.mjs  ──写盘──▶  SKILL.md
        │                          ▲
        └──spawnSync(node)──▶ skill-lint.mjs ──只读──┘
                参数：<SKILL.md 绝对路径>
                判据：退出码 0 = 通过
```

## 2. linter 侧契约（③ 必须满足，② 已按此实现）

| 项 | 约定 |
|---|---|
| 调用形式 | `node <linter 路径> <SKILL.md 绝对路径>` |
| 参数个数 | 恰好 1 个位置参数（目标文件路径）。**不传任何选项、不传 stdin** |
| 工作目录 | 不保证，**不得依赖 cwd**；一切路径用传入的绝对路径 |
| 退出码 0 | 通过 |
| 退出码 非 0 | 存在缺口（③ 现行：1=有缺口、2=用法/读文件错误，二者对②等价，均触发回滚） |
| stdout | 逐条缺口行（`FAIL <规则号> <缺口>`），通过时一行 PASS 摘要。② **原样回显**给模型，用于定点修复 |
| stderr | 诊断信息。② 原样回显，但不作为判据 |
| 超时 | ② 给 linter 60 秒上限；超时按失败处理（触发回滚） |
| 副作用 | **必须只读**：linter 不得改写目标文件（② 已在写盘后调用，若 linter 再写会破坏事务语义） |

## 3. 事务工具侧契约（② 提供）

### 3.1 `skill-rule-add.mjs`

```
node skill-rule-add.mjs <SKILL.md路径> --json '<规则JSON>' [--lint <路径>] [--dry-run] [--no-lint]
```

规则 JSON 字段（**全部必填**，缺任一项即退出码 1 且文件不动）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 规则编号，如 `TB-R9`；**全局唯一，不得复用**（llm-doc R4） |
| `title` | string | 规则标题 |
| `practice` | string | 做法 |
| `condition` | string | 条件 |
| `consequence` | string | 后果（含可 grep 的报错原文） |
| `symptoms` | string[] | 症状速查表条目，每个症状一行 |
| `checklistItem` | string | 自查清单条目正文（锚点 `〔id〕` 由工具自动追加） |
| `descriptionTriggers` | string[] | 追加到 frontmatter description 的触发词（自动去重） |
| `modal` | string | 必须 / 禁止 / 建议 |

**退出码**：`0` 成功；`1` 入参或结构校验失败（文件未改动）；`2` 已写盘但 linter 未通过（**已回滚**）。

### 3.2 `skill-rule-remove.mjs`

```
node skill-rule-remove.mjs <SKILL.md路径> --id <规则id> [--triggers a、b] [--lint <路径>] [--dry-run] [--no-lint]
```

**退出码**同上。删除后自动重校「全文零残留该 id」，不过则不写盘。

### 3.3 `--lint` 选项与默认值

- 省略 `--lint` → 默认 `<skill-rule-*.mjs 所在目录>/skill-lint.mjs`，即 `D:\dsh\tools\skill-lint.mjs`。
- **linter 存在性在写盘之前检查**：文件不存在时以退出码 1 失败、目标文件一个字节都不动。
- 自测用 `--lint <mock 路径>` 覆盖；`--no-lint` 仅供离线排查，正式流程禁用。

## 4. 事务语义（父卡集成时的关键约定）

1. **先算后写**：全部 5 处 patch 在内存算完并自检通过才落盘；任一处失败，文件保持原样。
2. **原子写盘**：同目录临时文件 + `rename`；保留原 BOM 与换行风格（LF/CRLF）。
3. **写盘后跑 linter**：非 0 则**按写盘前原文回滚**，退出码 2。
4. **5 处同步点**：① 正文规则块；② 症状速查表每症状一行；③ 自查清单兜底项前插带锚点项并顺延兜底编号；④ frontmatter description 追加触发词（去重）；⑤ 章节索引条数/清单项数/编号范围上界/分组行。
5. **删除对称**：清症状表行（共用行只摘 id）、删清单项并重排编号、摘 description 触发词、索引回退。

## 5. stdout 客观信号格式

```
已写入 TB-R9；正文规则块 +1 处（插入点：组 R）；症状表 +2 行；清单 28→29；description +3 触发词；索引规则条数 27→28；索引清单项数 28→29；索引分组行追加 TB-R9
PASS <linter 的 PASS 摘要行>
linter 通过：D:\dsh\tools\skill-lint.mjs 退出码 0
```

```
已删除 TB-R9；正文规则块 -1 处；症状表 -2 行；清单 29→28；description -3 触发词；索引规则条数 28→27；索引清单项数 29→28；索引分组行移除 TB-R9
```

## 6. 父卡集成步骤（建议）

1. **接通即已完成**：默认路径已指向③的真实 linter，无需改代码。集成时只需跑一次冒烟：

   ```powershell
   Copy-Item 'C:\Users\Administrator\.dsh\skills\<技能>\SKILL.md' 'D:\dsh\tools\test-fixtures\work\smoke.md' -Force
   node D:\dsh\tools\skill-rule-add.mjs D:\dsh\tools\test-fixtures\work\smoke.md --json '<规则JSON>'
   node D:\dsh\tools\skill-rule-remove.mjs D:\dsh\tools\test-fixtures\work\smoke.md --id <规则id>
   ```

2. **禁止**在真技能文件上做首次冒烟——③的 linter 以真文件为合格基线，②的验收也要求真文件哈希不变。
3. 状态文件 `D:\dsh\tools\.skill-rule-state.json` 记录「每次新增实际写入了哪些触发词」，供删除时精确回退；它是运行时产物，可安全删除（删除后删除规则需用 `--triggers` 显式指定）。

## 7. 已知边界

- 正文规则块支持两种格式：格式 A `**TB-R9 标题。**【必须】`（dsh-task-board）与格式 B `### PS-R9 标题`（powershell-scripting-standards）。
- 症状表按「精确同名即跳过」去重，不做语义合并。
- 清单计数声明只在「声明值 == 当前实际值」时才改写，避免误伤无关数字；不一致时不改并在信号中提示人工核对。
- 索引分组行按「组字母」匹配；找不到对应分组行时只同步计数、不追加 id，并在信号中提示。