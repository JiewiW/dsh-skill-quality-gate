#!/usr/bin/env node
/**
 * skill-rule-remove.mjs —— skill-rule-add 的对称删除工具，保证不留悬空引用。
 *
 * 用法：
 *   node skill-rule-remove.mjs <SKILL.md路径> --id <规则id> [--triggers a、b] [--lint <路径>] [--dry-run] [--no-lint]
 *
 * 一次调用原子完成 5 处清理（任一处算不出来，整个事务不写盘）：
 *   1. 删除正文规则块（连同其前的空行）；
 *   2. 清理症状速查表：该 id 独占的行整行删除，与其它 id 共用的行只摘掉该 id；
 *   3. 删除自查清单中带锚点〔id〕的条目，并把后续条目重新编号；
 *   4. 从 frontmatter description 中摘掉该规则带入的触发词（优先用状态文件记录，可用 --triggers 覆盖）；
 *   5. 章节索引计数 -1、编号范围上界回退、分组行移除该 id。
 *
 * 写盘后自动调用 linter；linter 非 0 时回滚文件到写盘前状态并以退出码 2 结束。
 *
 * 退出码：0 成功；1 入参/结构校验失败（文件未改动）；2 已写盘但 linter 未通过（已回滚）。
 */

import { existsSync, statSync, writeFileSync } from 'node:fs';
import {
  RuleToolError,
  analyzeDocument,
  applyLineEdits,
  parseCliArgs,
  planRuleRemove,
  printHelp,
  readDocument,
  resolveLinterPath,
  runLinter,
  saveState,
  loadState,
  stateKeyFor,
  toAbsolute,
  verifyRemoveResult,
  writeDocumentAtomically,
} from './skill-rule-core.mjs';

const USAGE = `用法：node skill-rule-remove.mjs <SKILL.md路径> --id <规则id> [选项]

必填：
  <SKILL.md路径>          目标技能文件
  --id <规则id>           要删除的规则编号，如 TB-R9

选项：
  --triggers a、b         显式指定要从 description 摘掉的触发词（默认读状态文件记录）
  --lint <路径>           指定 linter（默认 <本目录>/skill-lint.mjs）
  --dry-run               只计算并打印信号，不写盘、不跑 linter
  --no-lint               写盘但不跑 linter（仅供离线排查，正式流程勿用）
  -h, --help              显示本帮助`;

const EXIT_OK = 0;
const EXIT_INPUT_ERROR = 1;
const EXIT_LINT_FAILED = 2;

/** 把原始文件内容原样写回（linter 未通过时回滚）。 */
function restoreDocument(doc) {
  const payload = doc.hasBom ? `\uFEFF${doc.text}` : doc.text;
  writeFileSync(doc.filePath, payload, 'utf8');
}

/** 解析 --triggers 取值（支持 `、` 与 `,` 分隔）。 */
function parseTriggerList(raw) {
  if (!raw) return null;
  const items = raw
    .split(/[、,，]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return items.length > 0 ? items : null;
}

function main() {
  const { positionals, flags } = parseCliArgs(
    process.argv.slice(2),
    ['id', 'triggers', 'lint'],
    ['dry-run', 'no-lint', 'help'],
  );

  if (flags.help || positionals.length === 0) {
    printHelp(USAGE);
    process.exit(positionals.length === 0 && !flags.help ? EXIT_INPUT_ERROR : EXIT_OK);
  }
  if (positionals.length > 1) {
    throw new RuleToolError(`只接受一个 SKILL.md 路径，收到 ${positionals.length} 个：${positionals.join(' ')}`);
  }
  if (!flags.id) throw new RuleToolError('缺少 --id <规则id>');

  const targetPath = toAbsolute(positionals[0]);
  if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
    throw new RuleToolError(`目标文件不存在：${targetPath}`);
  }

  // 阶段一：读文件 + 解析结构 + 在内存里算全部 patch。
  const doc = readDocument(targetPath);
  const lines = doc.text.split(/\r?\n/);
  const analysis = analyzeDocument(lines);
  const plan = planRuleRemove(lines, analysis, {
    id: flags.id.trim(),
    triggers: parseTriggerList(flags.triggers),
    stateKey: stateKeyFor(targetPath),
  });

  // 阶段二：应用 patch 并做「写盘前自检」——全文不得残留该 id（无悬空引用）。
  const nextLines = applyLineEdits(lines, plan.edits);
  const nextText = nextLines.join(doc.eol);
  verifyRemoveResult(nextText, flags.id.trim());

  // 阶段三：linter 前置存在性检查（必须在写盘之前）。
  const linterPath = flags['no-lint'] ? null : resolveLinterPath(flags.lint);

  if (flags['dry-run']) {
    process.stdout.write(`【dry-run】将删除 ${flags.id.trim()}；${plan.signals.join('；')}\n`);
    process.stdout.write('  未写盘（--dry-run）；linter 路径检查已通过。\n');
    return;
  }

  // 阶段四：原子写盘。
  writeDocumentAtomically(doc, nextLines);
  process.stdout.write(`已删除 ${flags.id.trim()}；${plan.signals.join('；')}\n`);

  // 阶段五：写盘后自动调用 linter；不通过则回滚。
  if (linterPath) {
    const lint = runLinter(linterPath, targetPath);
    if (lint.stdout.trim() !== '') process.stdout.write(lint.stdout.endsWith('\n') ? lint.stdout : `${lint.stdout}\n`);
    if (lint.stderr.trim() !== '') process.stderr.write(lint.stderr.endsWith('\n') ? lint.stderr : `${lint.stderr}\n`);
    if (lint.spawnError) process.stderr.write(`linter 启动失败：${lint.spawnError}\n`);

    if (lint.exitCode !== 0) {
      restoreDocument(doc);
      process.stderr.write(`linter 未通过（退出码 ${lint.exitCode}），已回滚 ${targetPath} 到写盘前状态。\n`);
      process.exit(EXIT_LINT_FAILED);
    }
    process.stdout.write(`linter 通过：${linterPath} 退出码 0\n`);
  }

  // 阶段六：清掉状态文件里该规则的记录。
  const stateKey = stateKeyFor(targetPath);
  const state = loadState();
  if (state[stateKey] && state[stateKey].rules && state[stateKey].rules[flags.id.trim()]) {
    delete state[stateKey].rules[flags.id.trim()];
    saveState(state);
  }

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