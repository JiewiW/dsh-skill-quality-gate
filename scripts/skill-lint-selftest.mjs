#!/usr/bin/env node
/**
 * skill-lint-selftest.mjs —— skill-lint.mjs 的缺陷检出率自测（只读真基线，缺陷埋在临时副本）。
 *
 * 用法：node skill-lint-selftest.mjs
 * 退出码：0 = 5 类缺陷全部检出且基线仍通过；非 0 = 有未达标项。
 *
 * 真基线文件全程只读，所有改动只作用于 os.tmpdir() 下的临时副本。
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ── 固定口径 ──────────────────────────────────────────────────────────────
// 基线用包内自带夹具（dsh-task-board 的逐字节副本），使插件自包含、不依赖机器上的技能目录。
const BASELINE_PATH = fileURLToPath(new URL('../test/fixtures/dsh-task-board.fixture.md', import.meta.url));
const LINTER_PATH = fileURLToPath(new URL('./skill-lint.mjs', import.meta.url));
const EXPECTED_EXIT_PASS = 0;
const EXPECTED_EXIT_FAIL = 1;

/**
 * 运行 linter，返回退出码与 stdout。
 * @param {string} file_path 目标文件
 * @returns {{status: number, stdout: string, stderr: string}} 运行结果
 */
function run_linter(file_path) {
  const result = spawnSync(process.execPath, [LINTER_PATH, file_path], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/**
 * 断言辅助：记录通过/失败。
 * @param {Array<object>} failures 失败收集器
 * @param {boolean} ok 是否通过
 * @param {string} label 断言标签
 * @param {string} detail 失败详情
 */
function assert_case(failures, ok, label, detail) {
  if (ok) {
    process.stdout.write(`PASS ${label}\n`);
    return;
  }
  failures.push(`${label}: ${detail}`);
  process.stdout.write(`FAIL ${label}: ${detail}\n`);
}

/**
 * 在临时副本上做一次文本替换并跑 linter。
 * @param {object} ctx 测试上下文
 * @param {string} label 用例标签
 * @param {(text: string) => string} mutate 变更函数
 * @param {string} expect_rule 期望出现的 FAIL 规则号
 * @param {string} expect_token 期望出现在 FAIL 行里的定位串
 * @param {Array<object>} failures 失败收集器
 */
function case_mutation(ctx, label, mutate, expect_rule, expect_token, failures) {
  const mutated = mutate(ctx.baseline_text);
  if (mutated === ctx.baseline_text) {
    // 替换未生效（文本锚点漂移）会让用例假通过，必须显式暴露
    assert_case(failures, false, label, '缺陷注入未生效：目标文本未在基线中匹配到');
    return;
  }
  const mutated_path = join(ctx.dir, `${label}.md`);
  writeFileSync(mutated_path, mutated, 'utf8');
  const result = run_linter(mutated_path);
  const lines = result.stdout.split('\n').filter((line) => line.startsWith('FAIL '));
  const hit = lines.some((line) => line.startsWith(`FAIL ${expect_rule} `) && line.includes(expect_token));
  assert_case(
    failures,
    result.status === EXPECTED_EXIT_FAIL && hit,
    label,
    `期望 FAIL ${expect_rule} 且含「${expect_token}」；实际 exit=${result.status} stdout=${JSON.stringify(result.stdout)}`,
  );
}

/**
 * 主流程。
 * @returns {number} 退出码
 */
function main() {
  const failures = [];
  const baseline_text = readFileSync(BASELINE_PATH, 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'skill-lint-selftest-'));
  const ctx = { baseline_text, dir };
  try {
    // 0) 基线必须退出 0（且真文件只读、不被本次测试改动）
    const baseline_result = run_linter(BASELINE_PATH);
    assert_case(
      failures,
      baseline_result.status === EXPECTED_EXIT_PASS,
      'baseline-pass',
      `基线应 exit 0；实际 exit=${baseline_result.status} stdout=${JSON.stringify(baseline_result.stdout)}`,
    );

    // 1) 缺锚点：摘掉 TB-G2 清单项的锚点
    case_mutation(
      ctx,
      'defect-missing-anchor',
      (text) => text.replace('〔TB-G2〕', ''),
      'R11',
      'TB-G2',
      failures,
    );

    // 2) 计数不符：把节序声明的规则条数 27 改成 26
    case_mutation(
      ctx,
      'defect-count-mismatch',
      (text) => text.replace('规则正文（27 条', '规则正文（26 条'),
      'R15',
      '26',
      failures,
    );

    // 3) 报错串无反查：正文插入一个症状表没有的报错串
    case_mutation(
      ctx,
      'defect-uncovered-error-string',
      (text) => text.replace('**TB-G1 run 后轮询 settle，禁止盲等。**', '**TB-G1 run 后轮询 settle，禁止盲等。**\n做法：若出现 `bypasses PowerShell command validation` 即视为失败。'),
      'R14',
      'bypasses PowerShell command validation',
      failures,
    );

    // 4) description 缺词：从 description 删掉正文高频标识符 task_board
    case_mutation(
      ctx,
      'defect-description-missing-word',
      (text) => text.replace('task_board。', '。'),
      'R1',
      'task_board',
      failures,
    );

    // 5) YAML 非法：frontmatter 内用 Tab 缩进
    case_mutation(
      ctx,
      'defect-invalid-yaml',
      (text) => text.replace('name: dsh-task-board', '\tname: dsh-task-board'),
      'R2',
      'Tab',
      failures,
    );

    // 6) 兜底项缺失：把清单末尾兜底项改成普通项（去掉兜底关键字）
    case_mutation(
      ctx,
      'defect-missing-fallback-item',
      (text) => text.replace('兜底核对：逐条比对', '补充核对：逐条比对'),
      'R13',
      '兜底',
      failures,
    );

    // 7) 决策表无兜底行：去掉决策表里的兜底行
    case_mutation(
      ctx,
      'defect-decision-table-no-fallback',
      (text) => text.replace('| 依赖关系无法判定（兜底） | 默认按有依赖保守处理：先建单卡，跑通后再按瓶颈拆分，禁止赌并发 |\n', ''),
      'R27',
      '兜底行',
      failures,
    );

    // 8) 三要素缺失：摘掉 TB-W3 的「后果」
    case_mutation(
      ctx,
      'defect-missing-element',
      (text) => text.replace('后果：不标注不清理会污染用户真实看板。', ''),
      'R6',
      'TB-W3',
      failures,
    );

    // 9) 模态标记缺失：摘掉 TB-W3 的模态标记
    case_mutation(
      ctx,
      'defect-missing-modal',
      (text) => text.replace('【建议】\n做法：为演示或测试建卡片时', '\n做法：为演示或测试建卡片时'),
      'R49',
      'TB-W3',
      failures,
    );

    // 10) 禁令无替代做法：TB-L3 正文去掉全部替代关键字
    case_mutation(
      ctx,
      'defect-forbidden-no-alternative',
      (text) => text.replace(
        '做法：不得尝试用 manage 把任务移入 running 或 failed——工具不提供这两个 action；这两列只能由真实执行产生。需要演示失败态时必须让会话真实异常终止，演示不出就让该列留空。',
        '做法：不得尝试用 manage 把任务移入 running 或 failed——工具不提供这两个 action；这两列由真实执行产生。需要演示失败态时让会话真实异常终止，演示不出就让该列留空。',
      ),
      'R8',
      'TB-L3',
      failures,
    );

    // 11) 锚点指向不存在的 id：清单里插入 〔TB-Z9〕
    case_mutation(
      ctx,
      'defect-dangling-anchor',
      (text) => text.replace('〔TB-G2〕', '〔TB-G2〕〔TB-Z9〕'),
      'R12',
      'TB-Z9',
      failures,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} 项未达标:\n${failures.map((item) => `  - ${item}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write('\n全部用例通过（基线 exit 0 + 11 类缺陷全部检出）\n');
  return 0;
}

process.exitCode = main();