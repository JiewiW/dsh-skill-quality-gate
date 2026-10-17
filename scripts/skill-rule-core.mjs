/**
 * skill-rule-core.mjs —— skill-rule-add / skill-rule-remove 的共享内核。
 *
 * 纯 Node ESM，零外部依赖。职责：
 *   1. 解析 SKILL.md 的结构（frontmatter / 症状速查表 / 自查清单 / 章节索引 / 正文规则块）；
 *   2. 在内存里计算全部 patch，任一步校验不过就整体抛错，文件一个字节都不动；
 *   3. 写盘后调用外部 linter（接口契约：`node skill-lint.mjs <path>`，退出码 0 通过）。
 *
 * 正文规则块支持两种格式：
 *   - 格式 A：`**TB-R9 标题。**【必须】` + 做法/条件/后果 三行（本仓 dsh-task-board 用此格式）
 *   - 格式 B：`### PS-R9 标题`（本仓 powershell-scripting-standards 技能用此格式）
 */

import { readFileSync, writeFileSync, renameSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 工具自身所在目录，用于定位同目录的默认 linter。 */
export const TOOL_DIR = dirname(fileURLToPath(import.meta.url));

/** 允许的模态标记（对应 llm-doc R49：每条规则必须有模态）。 */
export const ALLOWED_MODALS = ['必须', '禁止', '建议'];

/** 规则 JSON 的必填字符串字段（缺失或空串即非零退出）。 */
export const REQUIRED_STRING_FIELDS = [
  'id',
  'title',
  'practice',
  'condition',
  'consequence',
  'checklistItem',
  'modal',
];

/** 规则 JSON 的必填数组字段（键必须存在且为数组；允许空数组）。 */
export const REQUIRED_ARRAY_FIELDS = ['symptoms', 'descriptionTriggers'];

/** 规则 JSON 的字段白名单：多写字段视为拼写错误，直接拒绝。 */
export const ALLOWED_FIELDS = [...REQUIRED_STRING_FIELDS, ...REQUIRED_ARRAY_FIELDS];

/** 规则 id 形态：`TB-R9` / `PS-R9` / `R11`。 */
export const RE_RULE_ID = /^([A-Za-z][A-Za-z0-9]*-)?([A-Za-z]*)(\d+)$/;

/** 正文规则块格式 A。 */
const RE_RULE_A = /^\*\*([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)[ \t\u3000]+(.+?)\*\*[ \t]*【([^】]+)】[ \t]*$/;

/** 正文规则块格式 B。 */
const RE_RULE_B = /^(#{3,4})[ \t]+([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)[ \t]+(.+?)[ \t]*$/;

/** 任意 Markdown 标题行。 */
export const RE_HEADING = /^#{1,6}[ \t]/;

/** 自查清单条目：`- [ ] 12. 文本…〔TB-C4〕`。 */
export const RE_CHECK_ITEM = /^([ \t]*-[ \t]*\[[ xX]\][ \t]*)(\d+)(\.[ \t]*)(.*)$/;

/** 正文分组标题：`### 组 R：执行、读取与重试（Run）`。 */
const RE_GROUP_HEADING = /^#{2,4}[ \t]+组[ \t]*([A-Za-z]+)[ \t]*[:：]/;

/**
 * 索引里的分组行：`- 组 W 何时用：TB-W1 …｜TB-W2 …`。
 * 分组名可含空格与中文（如 `- 组 GAPI 纪律：`），故整段前缀按原文捕获、重建时原样回填，
 * 避免把组名与标题之间的空格吃掉。
 * 捕获组：1=前缀原文（`- 组 <字母><组名>`），2=组字母，3=冒号，4=条目尾。
 */
const RE_INDEX_GROUP_LINE = /^(-[ \t]*组[ \t]*([A-Za-z]+)[^:：]*)([:：])(.*)$/;

/** 索引区起始行：`规则编号索引（27 条，无空号）：` 或 `## 章节索引`。 */
const RE_INDEX_HEADING = /(编号索引（|章节索引)/;

/** frontmatter 的 description 字段行。 */
const RE_FM_DESCRIPTION = /^description:[ \t]*(.*)$/;

/** Markdown 表格行。 */
export const RE_TABLE_ROW = /^[ \t]*\|/;

/** 编号范围声明：`PS-R1～PS-R7`。 */
const RE_ID_RANGE = /([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)[ \t]*([～~])[ \t]*([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)/g;

/** 触发词在 description 里的分隔符。 */
const TRIGGER_SEPARATOR = '、';

/** 句末标点：追加触发词时先剥掉、末尾再补回。 */
const TRAILING_PUNCTUATION = /[。．.；;，,]+$/;

/**
 * 规则状态文件目录：记录「本次新增实际写入了哪些 description 触发词」，供删除时精确回退。
 * 放在用户配置目录（%USERPROFILE%\.dsh\skill-quality-gate），不随包写——
 * 插件装在 node_modules 内，状态写包目录会在 pnpm 升级/重装时被清空。
 */
export const STATE_DIR = join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.dsh', 'skill-quality-gate');
export const STATE_FILE = join(STATE_DIR, 'state.json');

/** 工具错误：携带进程退出码。 */
export class RuleToolError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'RuleToolError';
    this.exitCode = exitCode;
  }
}

/** 转义正则元字符。 */
export function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把相对路径转成绝对路径（相对 cwd）。 */
export function toAbsolute(filePath) {
  return isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
}

/**
 * 解析命令行参数：位置参数进 positionals，`--key value` 与 `--key=value` 都支持。
 * @param {string[]} argv process.argv.slice(2)
 * @param {string[]} valueFlags 需要取值的选项名（不含 `--`）
 * @param {string[]} booleanFlags 布尔选项名（不含 `--`）
 */
export function parseCliArgs(argv, valueFlags, booleanFlags) {
  const positionals = [];
  const flags = Object.create(null);
  for (const name of valueFlags) flags[name] = null;
  for (const name of booleanFlags) flags[name] = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    const equalsAt = token.indexOf('=');
    const name = equalsAt === -1 ? token.replace(/^--?/, '') : token.slice(2, equalsAt);
    const inlineValue = equalsAt === -1 ? null : token.slice(equalsAt + 1);

    if (valueFlags.includes(name)) {
      const value = inlineValue === null ? argv[++index] : inlineValue;
      if (value === undefined) throw new RuleToolError(`选项 --${name} 缺少取值`);
      flags[name] = value;
      continue;
    }
    if (booleanFlags.includes(name)) {
      flags[name] = inlineValue === null ? true : inlineValue !== 'false';
      continue;
    }
    throw new RuleToolError(`未知选项：${token}`);
  }
  return { positionals, flags };
}

/**
 * 读取文件并识别 BOM / 换行风格，保证往返写盘不改变这两项。
 * @param {string} filePath
 */
export function readDocument(filePath) {
  const rawBuffer = readFileSync(filePath);
  let text = rawBuffer.toString('utf8');
  const hasBom = text.charCodeAt(0) === 0xfeff;
  if (hasBom) text = text.slice(1);

  const crlfCount = (text.match(/\r\n/g) || []).length;
  const loneLfCount = (text.match(/(?<!\r)\n/g) || []).length;
  const eol = crlfCount > loneLfCount ? '\r\n' : '\n';
  return { filePath, text, hasBom, eol };
}

/** 拆出 frontmatter 区段；返回 null 表示没有合法 frontmatter。 */
export function locateFrontmatter(lines) {
  if ((lines[0] || '').trim() !== '---') return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') return { openIndex: 0, closeIndex: index };
  }
  return null;
}

/** 找到第一个满足 matcher 的行下标。 */
function findLineIndex(lines, matcher, fromIndex = 0) {
  for (let index = fromIndex; index < lines.length; index += 1) {
    if (matcher.test(lines[index])) return index;
  }
  return -1;
}

/** 从 startIndex 起找下一个标题行下标（找不到返回 lines.length）。 */
function findNextHeadingIndex(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (RE_HEADING.test(lines[index])) return index;
  }
  return lines.length;
}

/** 拆分 Markdown 表格行为单元格数组。 */
function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** 症状表单元格归一化（去首尾引号与空白），用于去重判断。 */
export function normalizeCell(cell) {
  return cell.replace(/^["“”'‘’]+|["“”'‘’]+$/g, '').trim();
}

/** 解析症状速查表。 */
export function parseSymptomTable(lines) {
  const headingIndex = findLineIndex(lines, /^#{2,6}[ \t]*.*症状速查/);
  if (headingIndex === -1) return null;

  let tableStart = -1;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (RE_HEADING.test(lines[index])) break;
    if (RE_TABLE_ROW.test(lines[index])) {
      tableStart = index;
      break;
    }
  }
  if (tableStart === -1) return null;
  const separatorIndex = tableStart + 1;
  if (!RE_TABLE_ROW.test(lines[separatorIndex] || '')) return null;

  const rows = [];
  let tableEnd = separatorIndex + 1;
  for (let index = separatorIndex + 1; index < lines.length; index += 1) {
    if (!RE_TABLE_ROW.test(lines[index])) break;
    rows.push({ lineIndex: index, cells: splitTableRow(lines[index]), raw: lines[index] });
    tableEnd = index + 1;
  }
  return { headingIndex, headerIndex: tableStart, separatorIndex, tableStart, tableEnd, rows };
}

/** 解析交付前自查清单。 */
export function parseChecklist(lines) {
  const headingIndex = findLineIndex(lines, /^#{2,6}[ \t]*.*(自查清单|自检清单)/);
  if (headingIndex === -1) return null;

  const sectionEnd = findNextHeadingIndex(lines, headingIndex + 1);
  const items = [];
  for (let index = headingIndex + 1; index < sectionEnd; index += 1) {
    const match = RE_CHECK_ITEM.exec(lines[index]);
    if (!match) continue;
    items.push({
      lineIndex: index,
      indent: match[1],
      number: Number(match[2]),
      dotText: match[3],
      body: match[4],
      raw: lines[index],
    });
  }
  const fallbackItem = [...items].reverse().find((item) => /兜底/.test(item.body)) || null;
  return { headingIndex, sectionEnd, items, fallbackItem };
}

/**
 * 解析章节索引区。索引标题既可能是标题行，也可能是普通文本行（如 `规则编号索引（27 条，无空号）：`）。
 */
export function parseIndex(lines) {
  const indexLineIndex = findLineIndex(lines, RE_INDEX_HEADING);
  const groupLines = [];
  if (indexLineIndex !== -1) {
    for (let index = indexLineIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === '') continue;
      const match = RE_INDEX_GROUP_LINE.exec(line);
      if (!match) break;
      groupLines.push({
        lineIndex: index,
        group: match[2],
        prefix: match[1],
        colon: match[3],
        tail: match[4],
      });
    }
  }
  const sequenceLineIndex = findLineIndex(lines, /本文节序[:：]/);
  return { indexLineIndex, groupLines, sequenceLineIndex };
}

/** 解析正文规则块（存在格式 A 就用 A，否则用 B）。 */
export function parseBodyRules(lines) {
  const rulesA = [];
  const rulesB = [];
  for (let index = 0; index < lines.length; index += 1) {
    const matchA = RE_RULE_A.exec(lines[index]);
    if (matchA) {
      rulesA.push({ lineIndex: index, id: matchA[1], title: matchA[2].trim(), modal: matchA[3].trim(), format: 'A' });
      continue;
    }
    const matchB = RE_RULE_B.exec(lines[index]);
    if (matchB) rulesB.push({ lineIndex: index, id: matchB[2], title: matchB[3].trim(), modal: null, format: 'B' });
  }
  return rulesA.length > 0 ? { rules: rulesA, format: 'A' } : { rules: rulesB, format: 'B' };
}

/** 汇总文档结构；所有下标均为 lines 数组下标。 */
export function analyzeDocument(lines) {
  const frontmatter = locateFrontmatter(lines);
  let descriptionLineIndex = -1;
  let descriptionValue = '';
  if (frontmatter) {
    for (let index = frontmatter.openIndex + 1; index < frontmatter.closeIndex; index += 1) {
      const match = RE_FM_DESCRIPTION.exec(lines[index]);
      if (match) {
        descriptionLineIndex = index;
        descriptionValue = match[1];
        break;
      }
    }
  }
  const bodyRules = parseBodyRules(lines);
  return {
    frontmatter,
    descriptionLineIndex,
    descriptionValue,
    symptomTable: parseSymptomTable(lines),
    checklist: parseChecklist(lines),
    index: parseIndex(lines),
    bodyRules: bodyRules.rules,
    ruleFormat: bodyRules.format,
  };
}

/** 规则 id 解析：{ base, group, number }；非法 id 返回 null。 */
export function decomposeRuleId(ruleId) {
  const match = RE_RULE_ID.exec(ruleId);
  if (!match) return null;
  return {
    base: match[1] ? match[1].replace(/-$/, '') : '',
    group: match[2] || '',
    number: Number(match[3]),
  };
}

/** 由解析结果还原规则 id 文本。 */
export function composeRuleId(parts) {
  return `${parts.base ? `${parts.base}-` : ''}${parts.group}${parts.number}`;
}

/** 该 id 在文本中出现的次数（按 id 边界匹配，避免 TB-R1 命中 TB-R11）。 */
export function countIdOccurrences(text, ruleId) {
  return (text.match(new RegExp(`${escapeRegExp(ruleId)}(?![A-Za-z0-9])`, 'g')) || []).length;
}

/** 返回所有含该 id 的行的下标。 */
export function findIdLines(lines, ruleId) {
  const pattern = new RegExp(`${escapeRegExp(ruleId)}(?![A-Za-z0-9])`);
  const hits = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) hits.push(index);
  }
  return hits;
}

/** 校验并规范化规则 JSON；失败抛 RuleToolError。 */
export function normalizeRuleInput(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuleToolError('规则 JSON 必须是一个对象');
  }
  const unknownKeys = Object.keys(parsed).filter((key) => !ALLOWED_FIELDS.includes(key));
  if (unknownKeys.length > 0) {
    throw new RuleToolError(
      `规则 JSON 含未知字段：${unknownKeys.join('、')}；允许字段为 ${ALLOWED_FIELDS.join('、')}`,
    );
  }

  const missing = [];
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = parsed[field];
    if (typeof value !== 'string' || value.trim() === '') missing.push(field);
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(parsed[field])) missing.push(field);
  }
  if (missing.length > 0) throw new RuleToolError(`规则 JSON 缺失或非法字段：${missing.join('、')}`);

  const rule = {
    id: parsed.id.trim(),
    title: parsed.title.trim(),
    practice: parsed.practice.trim(),
    condition: parsed.condition.trim(),
    consequence: parsed.consequence.trim(),
    checklistItem: parsed.checklistItem.trim(),
    modal: parsed.modal.trim(),
    symptoms: parsed.symptoms.map((item) => String(item).trim()).filter((item) => item !== ''),
    descriptionTriggers: parsed.descriptionTriggers.map((item) => String(item).trim()).filter((item) => item !== ''),
  };

  if (!RE_RULE_ID.test(rule.id)) throw new RuleToolError(`规则 id 形态非法：${rule.id}（期望如 TB-R9 / PS-R9）`);
  if (!ALLOWED_MODALS.includes(rule.modal)) {
    throw new RuleToolError(`模态非法：${rule.modal}（只允许 ${ALLOWED_MODALS.join('、')}）`);
  }
  if (rule.symptoms.some((item) => item.includes('|') || /[\r\n]/.test(item))) {
    throw new RuleToolError('symptoms 条目不得包含表格分隔符 | 或换行');
  }
  if (/[\r\n]/.test(rule.checklistItem)) throw new RuleToolError('checklistItem 不得包含换行');
  return rule;
}

/** 应用行级编辑：edits = [{ start, end, lines }]，end 为开区间。 */
export function applyLineEdits(lines, edits) {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  const result = [...lines];
  for (const edit of ordered) result.splice(edit.start, edit.end - edit.start, ...edit.lines);
  return result;
}

/** 渲染规则块（格式 A / B）。 */
export function renderRuleBlock(rule, format) {
  const title = /[。.．]$/.test(rule.title) ? rule.title : `${rule.title}。`;
  const body = [`做法：${rule.practice}`, `条件：${rule.condition}`, `后果：${rule.consequence}`];
  if (format === 'B') return [`### ${rule.id} ${rule.title}`, `**【${rule.modal}】**`, ...body];
  return [`**${rule.id} ${title}**【${rule.modal}】`, ...body];
}

/** 找分组标题所在区段的 [start, end) 范围。 */
function locateGroupSection(lines, groupLetter) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = RE_GROUP_HEADING.exec(lines[index]);
    if (!match || match[1].toUpperCase() !== groupLetter.toUpperCase()) continue;
    return { start: index, end: findNextHeadingIndex(lines, index + 1) };
  }
  return null;
}

/** 区段内最后一个非空行的下标；全空则返回 start。 */
function lastNonBlankLine(lines, start, end) {
  for (let index = end - 1; index >= start; index -= 1) {
    if (lines[index].trim() !== '') return index;
  }
  return start;
}

/** 规则块结束位置（末尾空行之前）的下标 + 1。 */
function locateRuleBlockEnd(lines, ruleEntry) {
  const sectionEnd = findNextHeadingIndex(lines, ruleEntry.lineIndex + 1);
  let cursor = ruleEntry.lineIndex + 1;
  while (cursor < sectionEnd) {
    if (RE_RULE_A.test(lines[cursor]) || RE_RULE_B.test(lines[cursor])) break;
    cursor += 1;
  }
  return lastNonBlankLine(lines, ruleEntry.lineIndex, cursor) + 1;
}

/** 确定正文规则块的插入位置：优先同分组区段末尾，其次同前缀最后一条规则之后。 */
function locateRuleInsertion(lines, analysis, rule) {
  const decomposed = decomposeRuleId(rule.id);
  const groupLetter = decomposed ? decomposed.group : '';

  if (groupLetter) {
    const section = locateGroupSection(lines, groupLetter);
    if (section) {
      const anchor = lastNonBlankLine(lines, section.start + 1, section.end);
      return { insertAt: anchor + 1, label: `组 ${groupLetter}` };
    }
  }

  const sameBase = analysis.bodyRules.filter((item) => {
    const other = decomposeRuleId(item.id);
    return decomposed && other && other.base === decomposed.base;
  });
  const anchorRule =
    sameBase.length > 0 ? sameBase[sameBase.length - 1] : analysis.bodyRules[analysis.bodyRules.length - 1];
  if (!anchorRule) throw new RuleToolError('正文中未找到任何规则块，无法确定插入位置');
  return { insertAt: locateRuleBlockEnd(lines, anchorRule), label: `规则 ${anchorRule.id} 之后` };
}

/**
 * 计算「新增规则」的全部 patch 与客观信号。任一步校验不过即抛错，不做任何写盘。
 */
export function planRuleAdd(lines, analysis, rule) {
  const edits = [];
  const signals = [];

  // —— 校验：规则 id 全局唯一（llm-doc R4：编号一经使用不复用）——
  const idLines = findIdLines(lines, rule.id);
  if (idLines.length > 0) {
    throw new RuleToolError(
      `规则 id 已存在，编号不得复用（llm-doc R4）：${rule.id}，出现在第 ${idLines.map((index) => index + 1).join('、')} 行`,
    );
  }

  // —— 写入点 1：正文规则块 ——
  const placement = locateRuleInsertion(lines, analysis, rule);
  const blockLines = renderRuleBlock(rule, analysis.ruleFormat);
  const nextIsBlank = placement.insertAt < lines.length && lines[placement.insertAt].trim() === '';
  edits.push({
    start: placement.insertAt,
    end: nextIsBlank ? placement.insertAt + 1 : placement.insertAt,
    lines: nextIsBlank ? [...blockLines, ''] : ['', ...blockLines],
  });
  signals.push(`正文规则块 +1 处（插入点：${placement.label}）`);

  // —— 写入点 2：症状速查表，每个 symptom 一行 ——
  const symptomTable = analysis.symptomTable;
  if (!symptomTable) throw new RuleToolError('未找到「症状速查」表，拒绝写入（症状表是同步点之一）');
  const knownSymptoms = new Set(symptomTable.rows.map((row) => normalizeCell(row.cells[0] || '')));
  const newSymptomRows = [];
  let skippedSymptoms = 0;
  for (const symptom of rule.symptoms) {
    const key = normalizeCell(symptom);
    if (knownSymptoms.has(key)) {
      skippedSymptoms += 1;
      continue;
    }
    newSymptomRows.push(`| ${symptom} | ${rule.id} |`);
    knownSymptoms.add(key);
  }
  if (newSymptomRows.length > 0) {
    edits.push({ start: symptomTable.tableEnd, end: symptomTable.tableEnd, lines: newSymptomRows });
  }
  signals.push(
    `症状表 +${newSymptomRows.length} 行` +
      (skippedSymptoms > 0 ? `（${skippedSymptoms} 条症状已存在，未重复插入）` : ''),
  );

  // —— 写入点 3：自查清单，兜底项之前插入带锚点项 ——
  const checklist = analysis.checklist;
  if (!checklist) throw new RuleToolError('未找到「自查清单」区，拒绝写入');
  if (!checklist.fallbackItem) throw new RuleToolError('自查清单缺少兜底核对项（llm-doc R13），拒绝写入');
  const checklistBefore = checklist.items.length;
  const fallbackNumber = checklist.fallbackItem.number;
  const newItemLine = `${checklist.fallbackItem.indent}${fallbackNumber}. ${rule.checklistItem}〔${rule.id}〕`;
  const bumpedFallbackLine = checklist.fallbackItem.raw.replace(
    RE_CHECK_ITEM,
    (_all, indent, _number, dotText, body) => `${indent}${fallbackNumber + 1}${dotText}${body}`,
  );
  edits.push({
    start: checklist.fallbackItem.lineIndex,
    end: checklist.fallbackItem.lineIndex + 1,
    lines: [newItemLine, bumpedFallbackLine],
  });
  signals.push(`清单 ${checklistBefore}→${checklistBefore + 1}`);

  // —— 写入点 4：frontmatter description 追加触发词（去重）——
  const descriptionPlan = planDescriptionAppend(lines, analysis, rule.descriptionTriggers);
  if (descriptionPlan.edit) edits.push(descriptionPlan.edit);
  signals.push(descriptionPlan.signal);

  // —— 写入点 5：章节索引编号范围与清单计数同步 ——
  const indexPlan = planIndexSync(lines, analysis, rule, checklistBefore, checklistBefore + 1);
  edits.push(...indexPlan.edits);
  signals.push(...indexPlan.signals);

  return { edits, signals, appendedTriggers: descriptionPlan.appended, checklistBefore };
}

/** 计算 description 追加触发词的编辑与信号。 */
function planDescriptionAppend(lines, analysis, triggers) {
  if (triggers.length === 0) return { edit: null, signal: 'description +0 触发词（未提供）', appended: [] };
  if (analysis.descriptionLineIndex === -1) {
    throw new RuleToolError('frontmatter 缺少 description 字段，拒绝写入（description 是同步点之一）');
  }
  const current = analysis.descriptionValue;
  const appended = [];
  for (const trigger of triggers) {
    if (current.includes(trigger) || appended.includes(trigger)) continue;
    appended.push(trigger);
  }
  if (appended.length === 0) return { edit: null, signal: 'description +0 触发词（全部已存在）', appended: [] };

  const stripped = current.replace(TRAILING_PUNCTUATION, '');
  const terminal = current.slice(stripped.length);
  const nextValue = `${stripped}${TRIGGER_SEPARATOR}${appended.join(TRIGGER_SEPARATOR)}${terminal}`;
  return {
    edit: {
      start: analysis.descriptionLineIndex,
      end: analysis.descriptionLineIndex + 1,
      lines: [`description: ${nextValue}`],
    },
    signal: `description +${appended.length} 触发词`,
    appended,
  };
}

/**
 * 章节索引同步（新增方向）：每行只生成一个编辑，避免同一行被多处改写。
 * 覆盖：计数声明（条数/项数）、编号范围上界、分组行追加 id。
 */
function planIndexSync(lines, analysis, rule, checklistBefore, checklistAfter) {
  const edits = [];
  const signals = [];
  const rulesBefore = analysis.bodyRules.length;
  const rulesAfter = rulesBefore + 1;
  const decomposed = decomposeRuleId(rule.id);
  const groupLineIndex =
    decomposed && decomposed.group
      ? (analysis.index.groupLines.find((entry) => entry.group.toUpperCase() === decomposed.group.toUpperCase()) || {})
          .lineIndex
      : undefined;

  let countBumped = false;
  let rangeBumped = false;
  for (let index = 0; index < lines.length; index += 1) {
    let updated = bumpCountDeclarations(lines[index], rulesBefore, rulesAfter, checklistBefore, checklistAfter);
    if (updated !== lines[index]) countBumped = true;
    const ranged = extendIdRangesInLine(updated, rule);
    if (ranged !== updated) rangeBumped = true;
    updated = ranged;
    if (index === groupLineIndex) updated = appendToIndexGroupLine(updated, rule);
    if (updated !== lines[index]) edits.push({ start: index, end: index + 1, lines: [updated] });
  }

  signals.push(`索引规则条数 ${rulesBefore}→${rulesAfter}${countBumped ? '' : '（未找到匹配的计数声明，未改写）'}`);
  signals.push(`索引清单项数 ${checklistBefore}→${checklistAfter}`);
  if (rangeBumped) signals.push(`索引编号范围上界→${rule.id}`);
  if (groupLineIndex !== undefined) signals.push(`索引分组行追加 ${rule.id}`);
  else signals.push(`索引未找到组 ${decomposed ? decomposed.group : ''} 的分组行，未追加`);
  return { edits, signals };
}

/**
 * 把「N 条 / N 项」类计数声明从 declaredBefore 改写为 declaredAfter。
 * 只有声明值恰好等于 declaredBefore 时才改，避免误伤无关数字。
 */
function bumpCountDeclarations(line, declaredBefore, declaredAfter, checklistBefore, checklistAfter) {
  let result = line;
  const rulePatterns = [
    /(规则正文（)(\d+)([ \t]*条)/g,
    /(编号索引（)(\d+)([ \t]*条)/g,
    /(（)(\d+)([ \t]*条，无空号)/g,
  ];
  for (const pattern of rulePatterns) {
    result = result.replace(pattern, (all, prefix, value, suffix) =>
      Number(value) === declaredBefore ? `${prefix}${declaredAfter}${suffix}` : all,
    );
  }
  if (checklistBefore === null || checklistAfter === null) return result;
  const checklistPatterns = [
    /(自查清单（)(\d+)([ \t]*项)/g,
    /(自检清单（)(\d+)([ \t]*项)/g,
    /(清单（)(\d+)([ \t]*项)/g,
  ];
  for (const pattern of checklistPatterns) {
    result = result.replace(pattern, (all, prefix, value, suffix) =>
      Number(value) === checklistBefore ? `${prefix}${checklistAfter}${suffix}` : all,
    );
  }
  return result;
}

/** 把一行里 `同组同前缀` 的编号范围上界扩展到新规则 id。 */
function extendIdRangesInLine(line, rule) {
  const target = decomposeRuleId(rule.id);
  if (!target) return line;
  return line.replace(RE_ID_RANGE, (all, lowerId, tilde, upperId) => {
    const upper = decomposeRuleId(upperId);
    if (!upper) return all;
    if (upper.base !== target.base || upper.group !== target.group) return all;
    if (target.number <= upper.number) return all;
    return `${lowerId}${tilde}${rule.id}`;
  });
}

/** 在索引分组行末尾追加 `｜<id> <短标题>`。 */
function appendToIndexGroupLine(line, rule) {
  const shortTitle = rule.title.length > 24 ? `${rule.title.slice(0, 24)}…` : rule.title;
  return `${line}｜${rule.id} ${shortTitle}`;
}

/**
 * 写盘前的最终自检：对「将要落盘」的文本重新解析，确认五处同步点真的成立。
 * 任何一条不过即整体抛错、不写盘。
 */
export function verifyAddResult(nextText, rule) {
  const lines = nextText.split(/\r?\n/);
  const analysis = analyzeDocument(lines);
  const failures = [];

  if (!analysis.bodyRules.some((item) => item.id === rule.id)) failures.push(`正文缺少规则块 ${rule.id}`);

  if (!analysis.symptomTable) {
    failures.push('症状速查表缺失');
  } else {
    for (const symptom of rule.symptoms) {
      const hit = analysis.symptomTable.rows.some(
        (row) => normalizeCell(row.cells[0] || '') === normalizeCell(symptom) && (row.cells[1] || '').includes(rule.id),
      );
      if (!hit) failures.push(`症状表缺少「${symptom}」→ ${rule.id} 的行`);
    }
  }

  const checklist = analysis.checklist;
  if (!checklist) {
    failures.push('自查清单缺失');
  } else {
    if (!checklist.items.some((item) => item.body.includes(`〔${rule.id}〕`))) {
      failures.push(`自查清单缺少锚点〔${rule.id}〕的条目`);
    }
    const numbers = checklist.items.map((item) => item.number);
    const expected = numbers.map((_value, index) => index + 1);
    if (numbers.join(',') !== expected.join(',')) failures.push(`自查清单编号不连续：${numbers.join(',')}`);
  }

  for (const trigger of rule.descriptionTriggers) {
    if (!analysis.descriptionValue.includes(trigger)) failures.push(`description 未包含触发词「${trigger}」`);
  }

  const declaredRules = extractDeclaredCount(lines, /编号索引（(\d+)[ \t]*条/);
  if (declaredRules !== null && declaredRules !== analysis.bodyRules.length) {
    failures.push(`索引声明 ${declaredRules} 条与正文实际 ${analysis.bodyRules.length} 条不一致`);
  }
  const declaredChecklist = extractDeclaredCount(lines, /自查清单（(\d+)[ \t]*项/);
  if (declaredChecklist !== null && checklist && declaredChecklist !== checklist.items.length) {
    failures.push(`索引声明 ${declaredChecklist} 项与清单实际 ${checklist.items.length} 项不一致`);
  }

  if (failures.length > 0) {
    throw new RuleToolError(`写盘前自检未通过（文件未改动）：\n  - ${failures.join('\n  - ')}`);
  }
}

/** 取第一处计数声明的数值；不存在返回 null。 */
function extractDeclaredCount(lines, pattern) {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

/** 计算「删除规则」的全部 patch 与客观信号。 */
export function planRuleRemove(lines, analysis, options) {
  const ruleId = options.id;
  if (!RE_RULE_ID.test(ruleId)) throw new RuleToolError(`规则 id 形态非法：${ruleId}`);
  if (countIdOccurrences(lines.join('\n'), ruleId) === 0) {
    throw new RuleToolError(`文档中不存在规则 ${ruleId}，未做任何改动`);
  }

  const edits = [];
  const signals = [];

  // —— 删除点 1：正文规则块 ——
  const bodyRule = analysis.bodyRules.find((item) => item.id === ruleId);
  if (!bodyRule) throw new RuleToolError(`正文中不存在规则块 ${ruleId}，拒绝删除（避免留下悬空引用）`);
  const blockEnd = locateRuleBlockEnd(lines, bodyRule);
  let blockStart = bodyRule.lineIndex;
  if (blockStart > 0 && lines[blockStart - 1].trim() === '') blockStart -= 1;
  edits.push({ start: blockStart, end: blockEnd, lines: [] });
  signals.push('正文规则块 -1 处');

  // —— 删除点 2：症状速查表行 / 条款单元格里的该 id ——
  let removedRows = 0;
  let cleanedCells = 0;
  const symptomTable = analysis.symptomTable;
  if (symptomTable) {
    const idPattern = new RegExp(`${escapeRegExp(ruleId)}(?![A-Za-z0-9])`);
    for (const row of symptomTable.rows) {
      const clauseIndex = row.cells.length - 1;
      const clause = row.cells[clauseIndex] || '';
      if (!idPattern.test(clause)) continue;
      const remaining = clause
        .split(/[、,，]/)
        .map((item) => item.trim())
        .filter((item) => item !== '' && item !== ruleId);
      if (remaining.length === 0) {
        edits.push({ start: row.lineIndex, end: row.lineIndex + 1, lines: [] });
        removedRows += 1;
      } else {
        const rebuilt = row.cells.map((cell, index) => (index === clauseIndex ? remaining.join('、') : cell)).join(' | ');
        edits.push({ start: row.lineIndex, end: row.lineIndex + 1, lines: [`| ${rebuilt} |`] });
        cleanedCells += 1;
      }
    }
  }
  signals.push(`症状表 -${removedRows} 行` + (cleanedCells > 0 ? `，-${cleanedCells} 处条款引用` : ''));

  // —— 删除点 3：自查清单项（含后续条目重新编号）——
  const checklist = analysis.checklist;
  const checklistBefore = checklist ? checklist.items.length : null;
  let checklistSignal = '清单未变更（未找到清单区）';
  if (checklist) {
    const itemIndex = checklist.items.findIndex((item) => item.body.includes(`〔${ruleId}〕`));
    if (itemIndex === -1) {
      checklistSignal = '清单无该项，未变更';
    } else {
      edits.push({ start: checklist.items[itemIndex].lineIndex, end: checklist.items[itemIndex].lineIndex + 1, lines: [] });
      for (let index = itemIndex + 1; index < checklist.items.length; index += 1) {
        const item = checklist.items[index];
        const renumbered = item.raw.replace(
          RE_CHECK_ITEM,
          (_all, indent, numberText, dotText, body) => `${indent}${Number(numberText) - 1}${dotText}${body}`,
        );
        edits.push({ start: item.lineIndex, end: item.lineIndex + 1, lines: [renumbered] });
      }
      checklistSignal = `清单 ${checklistBefore}→${checklistBefore - 1}`;
    }
  }
  signals.push(checklistSignal);

  // —— 删除点 4：description 触发词 ——
  const triggerPlan = planTriggerRemoval(analysis, ruleId, options.triggers, options.stateKey);
  if (triggerPlan.edit) edits.push(triggerPlan.edit);
  signals.push(triggerPlan.signal);

  // —— 删除点 5：索引分组行 / 计数与编号范围同步 ——
  const indexPlan = planIndexRemoval(lines, analysis, ruleId, checklistBefore);
  edits.push(...indexPlan.edits);
  signals.push(...indexPlan.signals);

  return { edits, signals };
}

/**
 * description 触发词删除：优先用显式 --triggers，其次读状态文件里**该文档**的记录。
 * 必须按 stateKey 精确取值——同名规则 id 可能出现在多个技能文件里，全局查找会取错记录。
 */
function planTriggerRemoval(analysis, ruleId, explicitTriggers, stateKey) {
  const fromState = stateKey ? loadRecordedTriggers(stateKey, ruleId) : [];
  const triggers = explicitTriggers && explicitTriggers.length > 0 ? explicitTriggers : fromState;
  if (!triggers || triggers.length === 0) {
    return {
      edit: null,
      signal: `description -0 触发词（${stateKey ? '该文档无记录' : '未提供 stateKey'}，可用 --triggers 指定）`,
    };
  }
  if (analysis.descriptionLineIndex === -1) return { edit: null, signal: 'description 字段缺失，未变更' };

  let current = analysis.descriptionValue;
  let removed = 0;
  for (const trigger of triggers) {
    if (!current.includes(trigger)) continue;
    const next = current
      .replace(new RegExp(`${escapeRegExp(TRIGGER_SEPARATOR)}?${escapeRegExp(trigger)}`, 'g'), '')
      .replace(new RegExp(`^${escapeRegExp(TRIGGER_SEPARATOR)}+`), '')
      .replace(new RegExp(`${escapeRegExp(TRIGGER_SEPARATOR)}+$`), '');
    if (next !== current) {
      current = next;
      removed += 1;
    }
  }
  if (removed === 0) return { edit: null, signal: 'description -0 触发词（未命中）' };
  return {
    edit: { start: analysis.descriptionLineIndex, end: analysis.descriptionLineIndex + 1, lines: [`description: ${current}`] },
    signal: `description -${removed} 触发词`,
  };
}

/** 索引同步（删除方向）：计数 -1、编号范围上界回退、分组行移除该 id。每行只生成一个编辑。 */
function planIndexRemoval(lines, analysis, ruleId, checklistBefore) {
  const edits = [];
  const signals = [];
  const rulesBefore = analysis.bodyRules.length;
  const rulesAfter = rulesBefore - 1;
  const checklistAfter = checklistBefore === null ? null : checklistBefore - 1;
  const groupLineIndexes = new Set(analysis.index.groupLines.map((entry) => entry.lineIndex));

  let rangeShrunk = false;
  let groupLineCleaned = false;
  for (let index = 0; index < lines.length; index += 1) {
    let updated = bumpCountDeclarations(lines[index], rulesBefore, rulesAfter, checklistBefore, checklistAfter);
    const shrunk = shrinkIdRangesInLine(updated, ruleId, analysis);
    if (shrunk !== updated) rangeShrunk = true;
    updated = shrunk;
    if (groupLineIndexes.has(index)) {
      const cleaned = removeIdFromIndexGroupLine(updated, ruleId);
      if (cleaned !== updated) groupLineCleaned = true;
      updated = cleaned;
    }
    if (updated !== lines[index]) edits.push({ start: index, end: index + 1, lines: [updated] });
  }

  signals.push(`索引规则条数 ${rulesBefore}→${rulesAfter}`);
  if (checklistBefore !== null) signals.push(`索引清单项数 ${checklistBefore}→${checklistAfter}`);
  if (rangeShrunk) signals.push('索引编号范围上界回退');
  if (groupLineCleaned) signals.push(`索引分组行移除 ${ruleId}`);
  return { edits, signals };
}

/** 把编号范围上界从被删规则回退到同组现存最大编号。 */
function shrinkIdRangesInLine(line, ruleId, analysis) {
  const target = decomposeRuleId(ruleId);
  if (!target) return line;
  const siblings = analysis.bodyRules
    .map((item) => decomposeRuleId(item.id))
    .filter((item) => item && item.base === target.base && item.group === target.group && item.number !== target.number);
  if (siblings.length === 0) return line;
  const maxSibling = siblings.reduce((left, right) => (right.number > left.number ? right : left));
  const replacementId = composeRuleId(maxSibling);
  return line.replace(RE_ID_RANGE, (all, lowerId, tilde, upperId) => {
    if (upperId !== ruleId) return all;
    return `${lowerId}${tilde}${replacementId}`;
  });
}

/** 从索引分组行里删掉指向该 id 的分段（前缀原样回填，不改动组名空格）。 */
function removeIdFromIndexGroupLine(line, ruleId) {
  const match = RE_INDEX_GROUP_LINE.exec(line);
  if (!match) return line;
  const idPattern = new RegExp(`^${escapeRegExp(ruleId)}(?![A-Za-z0-9])`);
  const segments = match[4]
    .split('｜')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && !idPattern.test(segment));
  return `${match[1]}${match[3]}${segments.join('｜')}`;
}

/** 删除后的自检：全文不得残留该 id 的任何引用（无悬空引用）。 */
export function verifyRemoveResult(nextText, ruleId) {
  const lines = nextText.split(/\r?\n/);
  const analysis = analyzeDocument(lines);
  const failures = [];

  const residue = countIdOccurrences(nextText, ruleId);
  if (residue > 0) {
    const residueLines = findIdLines(lines, ruleId).map((index) => index + 1);
    failures.push(`仍残留 ${residue} 处 ${ruleId} 引用（第 ${residueLines.join('、')} 行）`);
  }
  const declaredRules = extractDeclaredCount(lines, /编号索引（(\d+)[ \t]*条/);
  if (declaredRules !== null && declaredRules !== analysis.bodyRules.length) {
    failures.push(`索引声明 ${declaredRules} 条与正文实际 ${analysis.bodyRules.length} 条不一致`);
  }
  const checklist = analysis.checklist;
  if (checklist) {
    const numbers = checklist.items.map((item) => item.number);
    const expected = numbers.map((_value, index) => index + 1);
    if (numbers.join(',') !== expected.join(',')) failures.push(`自查清单编号不连续：${numbers.join(',')}`);
  }
  const declaredChecklist = extractDeclaredCount(lines, /自查清单（(\d+)[ \t]*项/);
  if (declaredChecklist !== null && checklist && declaredChecklist !== checklist.items.length) {
    failures.push(`索引声明 ${declaredChecklist} 项与清单实际 ${checklist.items.length} 项不一致`);
  }

  if (failures.length > 0) throw new RuleToolError(`删除前自检未通过（文件未改动）：\n  - ${failures.join('\n  - ')}`);
}

/** 原子写盘：同目录临时文件 + rename，保留 BOM 与换行风格。 */
export function writeDocumentAtomically(doc, nextLines) {
  const nextText = nextLines.join(doc.eol);
  const payload = doc.hasBom ? `\uFEFF${nextText}` : nextText;
  const tempPath = `${doc.filePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, payload, 'utf8');
  renameSync(tempPath, doc.filePath);
  return nextText;
}

/** 解析 linter 路径并前置存在性检查（缺 linter 时在任何写盘之前失败）。 */
export function resolveLinterPath(explicitPath) {
  const candidate = explicitPath ? toAbsolute(explicitPath) : join(TOOL_DIR, 'skill-lint.mjs');
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new RuleToolError(
      `linter 不存在：${candidate}\n` +
        '  真实 linter 由并行任务③产出（D:\\dsh\\tools\\skill-lint.mjs）；自测请显式传 --lint <mock路径>。',
    );
  }
  return candidate;
}

/**
 * 调用 linter。接口契约：`node <linter> <SKILL.md 路径>`，退出码 0 通过、非 0 在 stdout 打印逐条缺口。
 */
export function runLinter(linterPath, targetPath) {
  const result = spawnSync(process.execPath, [linterPath, targetPath], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  return {
    exitCode: result.status === null ? 1 : result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    spawnError: result.error ? String(result.error.message || result.error) : null,
  };
}

/** 读取状态文件（记录每次新增实际写入的 description 触发词）。 */
export function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** 写回状态文件（目录不存在时创建；状态在用户配置目录，不写包目录）。 */
export function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 从状态文件取某文档某规则记录过的触发词（必须按文档精确取值，避免跨文件取错）。 */
function loadRecordedTriggers(stateKey, ruleId) {
  const state = loadState();
  const record = state[stateKey];
  if (record && record.rules && record.rules[ruleId]) return record.rules[ruleId].triggers || [];
  return [];
}

/** 归一化文件路径作为状态键。 */
export function stateKeyFor(filePath) {
  return toAbsolute(filePath);
}

/** 打印帮助文本。 */
export function printHelp(usage) {
  process.stdout.write(`${usage}\n`);
}