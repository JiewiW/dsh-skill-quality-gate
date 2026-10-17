#!/usr/bin/env node
/**
 * skill-rule-add.mjs —— 把「新增一条 SKILL 规则」升级为一个事务。
 *
 * 用法：
 *   node skill-rule-add.mjs <SKILL.md路径> --json '<规则JSON>' [--lint <linter路径>] [--dry-run] [--no-lint]
 *
 * 一次调用原子完成 5 处写入（任一处算不出来，整个事务不写盘）：
 *   1. 正文按编号插入规则块（做法 + 条件 + 后果 + 模态）；
 *   2. 症状速查表为每个 symptoms 加一行 → 指向该 id；
 *   3. 自查清单在兜底项之前插入带锚点〔id〕的检查项，并把兜底项顺延一位；
 *   4. frontmatter description 追加 descriptionTriggers（去重）；
 *   5. 章节索引的编号条数 / 清单项数 / 编号范围上界 / 分组行同步。
 *
 * 写盘后自动调用 linter（接口契约：`node <linter> <SKILL.md路径>`，退出码 0 通过）；
 * linter 非 0 时回滚文件到写盘前状态并以退出码 2 结束。
 *
 * 退出码：0 成功；1 入参/结构校验失败（文件未改动）；2 已写盘但 linter 未通过（已回滚）。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  RuleToolError,
  analyzeDocument,
  applyLineEdits,
  normalizeRuleInput,
  parseCliArgs,
  planRuleAdd,
  printHelp,
  readDocument,
  resolveLinterPath,
  runLinter,
  saveState,
  loadState,
  stateKeyFor,
  toAbsolute,
  verifyAddResult,
  writeDocumentAtomically,
} from './skill-rule-core.mjs';

const USAGE = `用法：node skill-rule-add.mjs <SKILL.md路径> --json '<规则JSON>' [选项]

必填：
  <SKILL.md路径>          目标技能文件
  --json '<规则JSON>'     规则对象，字段：id/title/practice/condition/consequence/
                          symptoms[]/checklistItem/descriptionTriggers[]/modal

选项：
  --lint <路径>           指定 linter（默认 <本目录>/skill-lint.mjs）
  --dry-run               只计算并打印信号，不写盘、不跑 linter
  --no-lint               写盘但不跑 linter（仅供离线排查，正式流程勿用）
  -h, --help              显示本帮助`;

/** 退出码约定。 */
const EXIT_OK = 0;
const EXIT_INPUT_ERROR = 1;
const EXIT_LINT_FAILED = 2;

/** 把原始文件内容原样写回（linter 未通过时回滚）。 */
function restoreDocument(doc) {
  const payload = doc.hasBom ? `\uFEFF${doc.text}` : doc.text;
  writeFileSync(doc.filePath, payload, 'utf8');
}

/** 打印事务信号行。 */
function printSignalLine(verb, ruleId, signals) {
  process.stdout.write(`${verb} ${ruleId}；${signals.join('；')}\n`);
}

function main() {
  const { positionals, flags } = parseCliArgs(
    process.argv.slice(2),
    ['json', 'lint'],
    ['dry-run', 'no-lint', 'help'],
  );

  if (flags.help || positionals.length === 0) {
    printHelp(USAGE);
    process.exit(positionals.length === 0 && !flags.help ? EXIT_INPUT_ERROR : EXIT_OK);
  }
  if (positionals.length > 1) {
    throw new RuleToolError(`只接受一个 SKILL.md 路径，收到 ${positionals.length} 个：${positionals.join(' ')}`);
  }
  if (!flags.json) throw new RuleToolError("缺少 --json '<规则JSON>'");

  const targetPath = toAbsolute(positionals[0]);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    throw new RuleToolError(`目标文件不存在：${targetPath}`);
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(flags.json);
  } catch (error) {
    throw new RuleToolError(`--json 不是合法 JSON：${error.message}`);
  }

  // 阶段一：入参与结构校验（此时文件尚未读取，更未改动）。
  const rule = normalizeRuleInput(parsedJson);

  // 阶段二：读文件 + 解析结构 + 在内存里算全部 patch。
  const doc = readDocument(targetPath);
  const lines = doc.text.split(/\r?\n/);
  const analysis = analyzeDocument(lines);
  const plan = planRuleAdd(lines, analysis, rule);

  // 阶段三：应用 patch 并做「写盘前自检」——五处同步点必须真的成立。
  const nextLines = applyLineEdits(lines, plan.edits);
  const nextText = nextLines.join(doc.eol);
  verifyAddResult(nextText, rule);

  // 阶段四：linter 前置存在性检查（必须在写盘之前，避免写了一半才发现没有 linter）。
  const linterPath = flags['no-lint'] ? null : resolveLinterPath(flags.lint);

  if (flags['dry-run']) {
    printSignalLine('【dry-run】将写入', rule.id, plan.signals);
    process.stdout.write('  未写盘（--dry-run）；linter 路径检查已通过。\n');
    return;
  }

  // 阶段五：原子写盘。
  writeDocumentAtomically(doc, nextLines);
  printSignalLine('已写入', rule.id, plan.signals);

  // 阶段六：写盘后自动调用 linter；不通过则回滚。
  if (linterPath) {
    const lint = runLinter(linterPath, targetPath);
    if (lint.stdout.trim() !== '') process.stdout.write(lint.stdout.endsWith('\n') ? lint.stdout : `${lint.stdout}\n`);
    if (lint.stderr.trim() !== '') process.stderr.write(lint.stderr.endsWith('\n') ? lint.stderr : `${lint.stderr}\n`);
    if (lint.spawnError) process.stderr.write(`linter 启动失败：${lint.spawnError}\n`);

    if (lint.exitCode !== 0) {
      restoreDocument(doc);
      process.stderr.write(
        `linter 未通过（退出码 ${lint.exitCode}），已回滚 ${targetPath} 到写盘前状态。\n`,
      );
      process.exit(EXIT_LINT_FAILED);
    }
    process.stdout.write(`linter 通过：${linterPath} 退出码 0\n`);
  }

  // 阶段七：记录本次实际写入的触发词，供 skill-rule-remove 精确回退。
  const stateKey = stateKeyFor(targetPath);
  const state = loadState();
  const record = state[stateKey] || { rules: {} };
  record.rules = record.rules || {};
  record.rules[rule.id] = { triggers: plan.appendedTriggers, updatedAt: new Date().toISOString() };
  state[stateKey] = record;
  saveState(state);

  process.exit(EXIT_OK);
}

try {
  main();
} catch (error) {
  if (error instanceof RuleToolError) {
    process.stderr.write(`[失败] ${error.message}\n`);
    process.exit(error.exitCode);
  }
  process.stderr.write(`[失败] 未预期错误：${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(EXIT_INPUT_ERROR);
}