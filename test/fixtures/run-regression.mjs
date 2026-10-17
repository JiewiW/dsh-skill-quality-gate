#!/usr/bin/env node
/**
 * run-regression.mjs —— 任务②的自测回归（只对夹具运行，绝不触碰真文件）。
 *
 * 隔离纪律（硬要求）：
 *   - 真文件 `C:\Users\Administrator\.dsh\skills\dsh-task-board\SKILL.md` 只读一次用于取哈希/复制夹具，
 *     全程不写；收尾复核哈希与开工前一致，不一致即整体判失败。
 *   - 每个用例都从「原始夹具」重新复制一份到 test-fixtures/work/ 下再跑，
 *     因此夹具本身保持 pristine，可反复重跑。
 *
 * 用法：node run-regression.mjs
 * 退出码：0 全部通过；1 有失败项。
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = resolve(HERE, '..');
const FIXTURE = join(HERE, 'dsh-task-board.fixture.md');
const WORK_DIR = join(HERE, 'work');
const MOCK_LINT = join(HERE, 'mock-skill-lint.mjs');
const MOCK_LINT_FAIL = join(HERE, 'mock-skill-lint-fail.mjs');
const ADD_TOOL = join(TOOLS_DIR, 'skill-rule-add.mjs');
const REMOVE_TOOL = join(TOOLS_DIR, 'skill-rule-remove.mjs');
const REAL_SKILL = 'C:\\Users\\Administrator\\.dsh\\skills\\dsh-task-board\\SKILL.md';

const TEST_RULE = {
  id: 'TB-R9',
  title: '测试用规则：不得直接编辑技能文件',
  practice: '一律通过事务工具写入，禁止裸 edit 技能文件。',
  condition: '任何需要修改 SKILL.md 的场合。',
  consequence: '裸编辑会漏回填 description，检索命中率下降。',
  symptoms: ['裸 edit 改完技能正文后检索不到', '症状表与正文脱节'],
  checklistItem: '本次技能改动是否全部经由事务工具完成、且 linter 退出码为 0？',
  descriptionTriggers: ['事务工具', '裸编辑技能', 'linter 退出码'],
  modal: '必须',
};

const results = [];

/** 记录一条断言结果。 */
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}\n`);
}

/** 计算文件 SHA256。 */
function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toUpperCase();
}

/** 运行一个 CLI，返回 { code, stdout, stderr }。 */
function runCli(toolPath, args) {
  const result = spawnSync(process.execPath, [toolPath, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  return { code: result.status === null ? -1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** 从 pristine 夹具复制一份可写工作副本。 */
function freshWorkCopy(name) {
  const target = join(WORK_DIR, name);
  copyFileSync(FIXTURE, target);
  return target;
}

/** 统计文本中某 id 的出现次数（按 id 边界）。 */
function countId(text, id) {
  return (text.match(new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'g')) || []).length;
}

function main() {
  process.stdout.write('=== skill-rule-add / remove 回归（仅对夹具） ===\n');

  // —— 前置：记录真文件哈希 + 夹具自愈 ——
  if (!existsSync(REAL_SKILL)) throw new Error(`真文件不存在：${REAL_SKILL}`);
  const realHashBefore = sha256(REAL_SKILL);
  process.stdout.write(`真文件开工前哈希：${realHashBefore}\n`);

  if (!existsSync(FIXTURE)) {
    copyFileSync(REAL_SKILL, FIXTURE);
    process.stdout.write(`夹具缺失，已从真文件临时复制：${FIXTURE}\n`);
  }
  const fixtureHashBefore = sha256(FIXTURE);

  if (existsSync(WORK_DIR)) rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  // —— 用例 0：mock linter 基线校准 ——
  // 「mock lint 退出 0」只有在这个替身对**未改动的原始夹具**也返回 0 时才是有效证据。
  const baselineTarget = freshWorkCopy('baseline.md');
  const baselineRun = runCli(MOCK_LINT, [baselineTarget]);
  check(
    '用例0 mock linter 对原始夹具基线退出 0（替身已校准）',
    baselineRun.code === 0,
    `实际 ${baselineRun.code}：${baselineRun.stdout.trim().split('\n').slice(0, 3).join(' / ')}`,
  );

  // —— 用例 1：正常新增，五处同步 + mock lint 退出 0 ——
  const addTarget = freshWorkCopy('add.md');
  const addRun = runCli(ADD_TOOL, [addTarget, '--json', JSON.stringify(TEST_RULE), '--lint', MOCK_LINT]);
  process.stdout.write(`\n[用例1 stdout] ${addRun.stdout.trim()}\n`);
  if (addRun.stderr.trim()) process.stdout.write(`[用例1 stderr] ${addRun.stderr.trim()}\n`);

  check('用例1 退出码为 0', addRun.code === 0, `实际 ${addRun.code}`);
  const addedText = readFileSync(addTarget, 'utf8');

  // 同步点 1：正文规则块
  check('用例1 同步点1 正文规则块出现', /^\*\*TB-R9 /m.test(addedText) && /做法：/.test(addedText));
  // 同步点 2：症状表两行
  const symptomRows = addedText.split(/\r?\n/).filter((line) => /^\|/.test(line) && line.includes('TB-R9'));
  check('用例1 同步点2 症状表 +2 行且指向 TB-R9', symptomRows.length === 2, `实际 ${symptomRows.length} 行`);
  // 同步点 3：清单锚点项 + 编号连续
  const checklistNumbers = [...addedText.matchAll(/^[ \t]*-[ \t]*\[[ xX]\][ \t]*(\d+)\./gm)].map((m) => Number(m[1]));
  const contiguous = checklistNumbers.every((value, index) => value === index + 1);
  check('用例1 同步点3 清单插入锚点项〔TB-R9〕', /〔TB-R9〕/.test(addedText));
  check(
    '用例1 同步点3 清单编号连续且 28→29',
    checklistNumbers.length === 29 && contiguous,
    `项数 ${checklistNumbers.length}，连续=${contiguous}`,
  );
  // 同步点 4：description 触发词
  const descriptionLine = (addedText.match(/^description:.*$/m) || [''])[0];
  const triggersPresent = TEST_RULE.descriptionTriggers.every((trigger) => descriptionLine.includes(trigger));
  check('用例1 同步点4 description +3 触发词', triggersPresent);
  // 同步点 5：索引计数与分组行
  check(
    '用例1 同步点5 索引计数同步（28 条 / 29 项）',
    addedText.includes('规则编号索引（28 条，无空号）') &&
      addedText.includes('规则正文（28 条') &&
      addedText.includes('交付前自查清单（29 项）'),
  );
  const groupRLine = (addedText.match(/^- 组 R[^\n]*$/m) || [''])[0];
  check('用例1 同步点5 索引分组行追加 TB-R9', groupRLine.includes('TB-R9'), groupRLine.slice(0, 60));
  // 客观信号
  check(
    '用例1 stdout 含客观信号四要素',
    /已写入 TB-R9/.test(addRun.stdout) &&
      /症状表 \+2 行/.test(addRun.stdout) &&
      /清单 28→29/.test(addRun.stdout) &&
      /description \+3 触发词/.test(addRun.stdout),
  );
  check('用例1 mock lint 退出 0', /linter 通过/.test(addRun.stdout));

  // —— 用例 2：缺字段被拒且文件不变 ——
  const missingTarget = freshWorkCopy('missing-field.md');
  const hashBeforeMissing = sha256(missingTarget);
  const brokenRule = { ...TEST_RULE };
  delete brokenRule.consequence;
  delete brokenRule.descriptionTriggers;
  const missingRun = runCli(ADD_TOOL, [missingTarget, '--json', JSON.stringify(brokenRule), '--lint', MOCK_LINT]);
  check('用例2 缺字段调用退出码非 0', missingRun.code !== 0, `实际 ${missingRun.code}`);
  check('用例2 报错点名缺失字段', /consequence/.test(missingRun.stderr) && /descriptionTriggers/.test(missingRun.stderr));
  check('用例2 夹具工作副本未被修改', sha256(missingTarget) === hashBeforeMissing);

  // —— 用例 3：id 复用被拒且文件不变 ——
  const dupTarget = freshWorkCopy('duplicate-id.md');
  const hashBeforeDup = sha256(dupTarget);
  const dupRun = runCli(ADD_TOOL, [dupTarget, '--json', JSON.stringify({ ...TEST_RULE, id: 'TB-R1' }), '--lint', MOCK_LINT]);
  check('用例3 复用已有 id 退出码非 0', dupRun.code !== 0, `实际 ${dupRun.code}`);
  check('用例3 报错说明编号不得复用', /R4/.test(dupRun.stderr));
  check('用例3 夹具工作副本未被修改', sha256(dupTarget) === hashBeforeDup);

  // —— 用例 4：删除后无悬空引用 ——
  const removeRun = runCli(REMOVE_TOOL, [addTarget, '--id', 'TB-R9', '--lint', MOCK_LINT]);
  process.stdout.write(`\n[用例4 stdout] ${removeRun.stdout.trim()}\n`);
  if (removeRun.stderr.trim()) process.stdout.write(`[用例4 stderr] ${removeRun.stderr.trim()}\n`);
  check('用例4 删除退出码为 0', removeRun.code === 0, `实际 ${removeRun.code}`);
  const removedText = readFileSync(addTarget, 'utf8');
  check('用例4 全文零残留 TB-R9 引用', countId(removedText, 'TB-R9') === 0, `残留 ${countId(removedText, 'TB-R9')} 处`);
  check(
    '用例4 索引/清单计数回退（27 条 / 28 项）',
    removedText.includes('规则编号索引（27 条，无空号）') && removedText.includes('交付前自查清单（28 项）'),
  );
  const removedChecklistNumbers = [...removedText.matchAll(/^[ \t]*-[ \t]*\[[ xX]\][ \t]*(\d+)\./gm)].map((m) => Number(m[1]));
  check(
    '用例4 清单编号回到 28 项且连续',
    removedChecklistNumbers.length === 28 && removedChecklistNumbers.every((value, index) => value === index + 1),
    `项数 ${removedChecklistNumbers.length}`,
  );
  check('用例4 删除后内容与原始夹具逐字节一致', sha256(addTarget) === fixtureHashBefore);

  // —— 用例 5：linter 未通过即回滚 ——
  const rollbackTarget = freshWorkCopy('rollback.md');
  const hashBeforeRollback = sha256(rollbackTarget);
  const rollbackRun = runCli(ADD_TOOL, [rollbackTarget, '--json', JSON.stringify(TEST_RULE), '--lint', MOCK_LINT_FAIL]);
  check('用例5 linter 失败时退出码为 2', rollbackRun.code === 2, `实际 ${rollbackRun.code}`);
  check('用例5 文件已回滚到写盘前', sha256(rollbackTarget) === hashBeforeRollback);
  check('用例5 报告回滚动作', /已回滚/.test(rollbackRun.stderr));

  // —— 用例 5b：触发词状态按文档隔离（回归：曾按规则 id 全局查找，会取到别的文件的记录）——
  // 文档 A 新增 TB-R9 记录触发词；文档 B 用**同一 id** 记录另一组触发词。
  // 删除 B 的 TB-R9 时必须只摘 B 自己的触发词，不得误摘 A 的词。
  const scopeA = freshWorkCopy('scope-a.md');
  const scopeB = freshWorkCopy('scope-b.md');
  runCli(ADD_TOOL, [scopeA, '--json', JSON.stringify(TEST_RULE), '--lint', MOCK_LINT]);
  runCli(ADD_TOOL, [
    scopeB,
    '--json',
    JSON.stringify({ ...TEST_RULE, descriptionTriggers: ['乙文档专属触发词'] }),
    '--lint',
    MOCK_LINT,
  ]);
  const scopeBRemove = runCli(REMOVE_TOOL, [scopeB, '--id', 'TB-R9', '--lint', MOCK_LINT]);
  const scopeBText = readFileSync(scopeB, 'utf8');
  check('用例5b 文档B 删除退出码为 0', scopeBRemove.code === 0, `实际 ${scopeBRemove.code}`);
  check(
    '用例5b 只摘掉文档B自己的触发词',
    !scopeBText.includes('乙文档专属触发词') && /description -1 触发词/.test(scopeBRemove.stdout),
    scopeBRemove.stdout.trim().slice(0, 90),
  );
  check(
    '用例5b 未误摘文档A的触发词（按文档隔离）',
    TEST_RULE.descriptionTriggers.every((trigger) => readFileSync(scopeA, 'utf8').includes(trigger)),
  );

  // —— 用例 6：dry-run 不写盘 ——
  const dryTarget = freshWorkCopy('dry-run.md');
  const hashBeforeDry = sha256(dryTarget);
  const dryRun = runCli(ADD_TOOL, [dryTarget, '--json', JSON.stringify(TEST_RULE), '--lint', MOCK_LINT, '--dry-run']);
  check('用例6 dry-run 退出码为 0 且未写盘', dryRun.code === 0 && sha256(dryTarget) === hashBeforeDry);
  check('用例6 dry-run 仍打印事务信号', /将写入 TB-R9/.test(dryRun.stdout));

  // —— 收尾：夹具 pristine + 真文件哈希复核 ——
  check('收尾 夹具未被任何用例改动', sha256(FIXTURE) === fixtureHashBefore);
  const realHashAfter = sha256(REAL_SKILL);
  check('收尾 真文件哈希与开工前一致', realHashAfter === realHashBefore, `开工前 ${realHashBefore.slice(0, 16)}…`);

  const failed = results.filter((item) => !item.passed);
  process.stdout.write(`\n=== 合计 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length} ===\n`);
  if (failed.length > 0) {
    for (const item of failed) process.stdout.write(`  FAIL ${item.name} ${item.detail}\n`);
    process.exit(1);
  }
  process.exit(0);
}

try {
  main();
} catch (error) {
  process.stdout.write(`\n[回归运行器异常] ${error && error.stack ? error.stack : String(error)}\n`);
  process.exit(1);
}