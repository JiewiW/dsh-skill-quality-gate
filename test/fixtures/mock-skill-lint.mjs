#!/usr/bin/env node
/**
 * mock-skill-lint.mjs —— 任务②自测用的 linter 替身（不是真 linter，真 linter 由任务③产出）。
 *
 * 接口契约与真 linter 完全一致：`node mock-skill-lint.mjs <SKILL.md 路径>`
 *   退出码 0 = 通过；非 0 = 不通过，并在 stdout 逐条打印 `FAIL <检查码> <缺口描述>`。
 *
 * 它不是一个「恒返回 0」的空壳：它真的做结构一致性检查，因此「mock lint 退出 0」
 * 才能作为「五处同步真的闭合」的独立证据。检查项覆盖任务③ plan 3.1 表中的
 * R2/R15/R11/R12/R13/R6/R49 七类。
 */

import { readFileSync } from 'node:fs';

const RE_BODY_RULE_A = /^\*\*([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)[ \t\u3000]+(.+?)\*\*[ \t]*【([^】]+)】[ \t]*$/;
const RE_BODY_RULE_B = /^(#{3,4})[ \t]+([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)[ \t]+(.+?)[ \t]*$/;
const RE_CHECK_ITEM = /^[ \t]*-[ \t]*\[[ xX]\][ \t]*(\d+)\.[ \t]*(.*)$/;
const RE_TABLE_ROW = /^[ \t]*\|/;
const RE_ANCHOR = /〔([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)〕/g;
const RE_ID = /[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+/g;

const MODALS = ['必须', '禁止', '建议'];

/** 读取目标文件；失败直接以退出码 1 结束。 */
function readTarget(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    process.stdout.write(`FAIL R0 无法读取文件 ${filePath}：${error.message}\n`);
    process.exit(1);
  }
}

/** 解析 frontmatter 与正文。 */
function splitFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') return { frontmatter: null, lines, bodyStart: 0 };
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') return { frontmatter: lines.slice(1, index), lines, bodyStart: index + 1 };
  }
  return { frontmatter: null, lines, bodyStart: 0 };
}

/** 收集正文规则块。 */
function collectRules(lines) {
  const rulesA = [];
  const rulesB = [];
  for (let index = 0; index < lines.length; index += 1) {
    const matchA = RE_BODY_RULE_A.exec(lines[index]);
    if (matchA) {
      rulesA.push({ lineIndex: index, id: matchA[1], title: matchA[2].trim(), modal: matchA[3].trim() });
      continue;
    }
    const matchB = RE_BODY_RULE_B.exec(lines[index]);
    if (matchB) rulesB.push({ lineIndex: index, id: matchB[2], title: matchB[3].trim(), modal: null });
  }
  const rules = rulesA.length > 0 ? rulesA : rulesB;
  return { rules, format: rulesA.length > 0 ? 'A' : 'B' };
}

/** 收集症状速查表的条款列引用。 */
function collectSymptomRefs(lines) {
  const refs = [];
  let inTable = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (/症状速查/.test(lines[index])) inTable = true;
    if (inTable && RE_TABLE_ROW.test(lines[index])) {
      const cells = lines[index].trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
      const clause = (cells[cells.length - 1] || '').trim();
      for (const id of clause.match(RE_ID) || []) refs.push({ id, lineIndex: index });
    } else if (inTable && lines[index].trim() !== '' && !RE_TABLE_ROW.test(lines[index]) && !/症状速查/.test(lines[index])) {
      inTable = false;
    }
  }
  return refs;
}

function main() {
  const target = process.argv[2];
  if (!target) {
    process.stdout.write('FAIL R0 缺少 SKILL.md 路径参数\n');
    process.exit(1);
  }

  const text = readTarget(target);
  const { frontmatter, lines } = splitFrontmatter(text);
  const failures = [];

  // —— R2：frontmatter 合法且含 name/description；H1 唯一 ——
  if (!frontmatter) {
    failures.push(['R2', 'frontmatter 缺失或未闭合']);
  } else {
    const keys = frontmatter.map((line) => (/^([A-Za-z_][\w-]*):/.exec(line) || [])[1]).filter(Boolean);
    for (const required of ['name', 'description']) {
      if (!keys.includes(required)) failures.push(['R2', `frontmatter 缺少字段 ${required}`]);
    }
  }
  const h1 = lines.filter((line) => /^#[ \t]/.test(line));
  if (h1.length !== 1) failures.push(['R26', `H1 数量应为 1，实际 ${h1.length}`]);

  // —— R6/R49：每条规则含做法/条件/后果 与模态标记 ——
  // 注意：本仓既有规则允许把「条件」并进「做法与条件（互斥穷尽）：」一行，故条件判定接受该写法。
  const ELEMENTS = [
    ['做法', /^做法/m],
    ['条件', /^(条件|做法与条件)/m],
    ['后果', /^后果/m],
  ];
  const { rules, format } = collectRules(lines);
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const sectionEnd = index + 1 < rules.length ? rules[index + 1].lineIndex : lines.length;
    const section = lines.slice(rule.lineIndex, sectionEnd).join('\n');
    for (const [element, pattern] of ELEMENTS) {
      if (!pattern.test(section)) failures.push(['R6', `规则 ${rule.id} 缺少「${element}」要素`]);
    }
    const modal = rule.modal || (/【([^】]+)】/.exec(section) || [])[1] || '';
    if (!MODALS.includes(modal.trim())) failures.push(['R49', `规则 ${rule.id} 缺少合法模态标记（必须/禁止/建议）`]);
  }

  // —— R15：索引声明的编号条数、清单项数与正文清点一致 ——
  const ruleIdSet = new Set(rules.map((rule) => rule.id));
  const indexCountMatch = /编号索引（(\d+)[ \t]*条/.exec(text);
  if (indexCountMatch && Number(indexCountMatch[1]) !== rules.length) {
    failures.push(['R15', `索引声明 ${indexCountMatch[1]} 条，正文实际 ${rules.length} 条`]);
  }
  const checklistItems = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = RE_CHECK_ITEM.exec(lines[index]);
    if (match) checklistItems.push({ lineIndex: index, number: Number(match[1]), body: match[2] });
  }
  const checklistCountMatch = /(?:自查清单|自检清单)（(\d+)[ \t]*项/.exec(text);
  if (checklistCountMatch && Number(checklistCountMatch[1]) !== checklistItems.length) {
    failures.push(['R15', `索引声明 ${checklistCountMatch[1]} 项，清单实际 ${checklistItems.length} 项`]);
  }

  // —— R11：每条规则在自查清单有对应锚点 ——
  const anchored = new Set();
  for (const item of checklistItems) {
    for (const match of item.body.matchAll(RE_ANCHOR)) anchored.add(match[1]);
  }
  for (const id of ruleIdSet) {
    if (!anchored.has(id)) failures.push(['R11', `规则 ${id} 无对应自查清单项`]);
  }

  // —— R12：每个锚点指向的 id 存在 ——
  for (const id of anchored) {
    if (!ruleIdSet.has(id)) failures.push(['R12', `自查清单锚点〔${id}〕在正文中不存在`]);
  }

  // —— R13：清单末尾有兜底核对项 ——
  if (checklistItems.length > 0 && !/兜底/.test(checklistItems[checklistItems.length - 1].body)) {
    failures.push(['R13', '自查清单末尾缺少兜底核对项']);
  }

  // —— 症状表条款列不得悬空 ——
  for (const ref of collectSymptomRefs(lines)) {
    if (!ruleIdSet.has(ref.id)) failures.push(['R14', `症状表第 ${ref.lineIndex + 1} 行引用不存在的规则 ${ref.id}`]);
  }

  if (failures.length > 0) {
    for (const [code, message] of failures) process.stdout.write(`FAIL ${code} ${message}\n`);
    process.stdout.write(`linter(替身) 未通过：${failures.length} 项缺口；格式 ${format}\n`);
    process.exit(1);
  }
  process.stdout.write(`PASS mock-skill-lint：规则 ${rules.length} 条、清单 ${checklistItems.length} 项、锚点 ${anchored.size} 个，格式 ${format}\n`);
  process.exit(0);
}

main();