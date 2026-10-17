#!/usr/bin/env node
/**
 * skill-lint.mjs —— SKILL.md 纯机械一致性检查器（纯 Node、零依赖、不调 AI）。
 *
 * 用法：
 *   node skill-lint.mjs <SKILL.md 路径>
 *
 * 退出码：
 *   0 = 全部检查通过；1 = 存在可行动缺口；2 = 用法错误或文件不可读。
 *
 * 输出契约（stdout，一行一处缺口，供调用方 CLI 直接消费）：
 *   FAIL <规则号> <缺口描述，含规则 id 与行号/位置>
 * 通过时 stdout 只打印一行 PASS 摘要。诊断信息走 stderr，不污染 stdout。
 *
 * 检查项与依据：
 *   R2/R26  frontmatter 为合法 YAML 且含 name/description；全文 H1 唯一
 *   R1      description 含触发词声明、词数与去重合规、正文高频标识符出现在 description
 *   R15     节序声明的编号范围与清单计数、正文清点一致
 *   R11/R12 每个规则 id 在自查清单有锚点；每个锚点指向的 id 存在
 *   R13     自查清单末尾有兜底核对项
 *   R14     正文反引号内报错串在症状速查表都有反查行
 *   R6      每条规则含「做法/条件/后果」三要素
 *   R8      每条禁令能找到替代做法关键字
 *   R49     每条规则有模态标记（必须/禁止/建议）
 *   R27     决策表有兜底行
 */

import { readFileSync } from 'node:fs';

// ── 退出码契约 ────────────────────────────────────────────────────────────
const EXIT_CODE_PASS = 0; // 全部检查通过
const EXIT_CODE_LINT_FAIL = 1; // 存在可行动缺口
const EXIT_CODE_USAGE_ERROR = 2; // 用法错误 / 文件不可读 / 未预期失败

// ── frontmatter（YAML 子集）判定 ──────────────────────────────────────────
const FRONTMATTER_FENCE = '---'; // YAML 头围栏
const YAML_KEY_PATTERN = /^([A-Za-z_][A-Za-z0-9_-]*):(\s|$)/; // 顶层键
const YAML_BLOCK_SCALAR_PATTERN = /^[|>][+-]?\d*$/; // | 或 > 块标量
const YAML_TAB_INDENT_PATTERN = /^\t/; // YAML 禁止 Tab 缩进
const YAML_NESTED_COLON_PATTERN = /:\s/; // 未加引号的值内含 ": " 会被解析成嵌套映射

// ── 文档结构清点 ──────────────────────────────────────────────────────────
const H1_PATTERN = /^#\s+\S/; // 一级标题
const H2_PATTERN = /^##\s+(\S.*)$/; // 二级标题（节）
const RULE_HEADING_PATTERN = /^\*\*([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)\s+([^*]+)\*\*(.*)$/;
const CHECKLIST_ITEM_PATTERN = /^\s*-\s*\[[ xX]\]\s*(.+)$/; // 自查清单 checkbox 项
const ANCHOR_PATTERN = /〔([^〕]+)〕/g; // 清单锚点 〔TB-W1〕
const ANCHOR_ID_SPLIT_PATTERN = /[、，,]/; // 一个锚点可含多个 id
const RULE_ID_PATTERN = /\b([A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+)\b/g;
const NUMBERED_STEP_PATTERN = /^\s*\d+\.\s+\S/; // 编号步骤
const TABLE_ROW_PATTERN = /^\s*\|/; // 表格行
const TABLE_SEPARATOR_PATTERN = /^\s*\|[\s:|-]+\|\s*$/; // 表格分隔行
const BACKTICK_SPAN_PATTERN = /`([^`\n]+)`/g; // 反引号内联串
const CODE_FENCE_PATTERN = /^\s*```/; // 代码围栏（其内不做反引号扫描）
const SECTION_ORDER_PATTERN = /本文节序：([^\n]*)/; // 节序声明行
const DECLARED_COUNT_PATTERN = /（(\d+)\s*(条|项|步)/; // 节序里的「（27 条）」
const RULE_INDEX_PATTERN = /规则编号索引（(\d+)\s*条/; // 规则编号索引声明

// ── 判据阈值与关键字（全部为文本结构判据，无模糊判断）────────────────────
const MIN_TRIGGER_WORDS = 8; // description 触发词最少个数
const HIGH_FREQUENCY_IDENTIFIER_MIN = 3; // 正文标识符算「高频」的最少出现次数
const MIN_ERROR_STRING_LENGTH = 4; // 报错串最短长度
const MAX_ERROR_STRING_LENGTH = 120; // 报错串最长长度
const MODAL_KEYWORDS = ['必须', '禁止', '建议']; // R49 模态标记
const RULE_ELEMENT_MARKERS = {
  // R6 三要素（按小标题/标记解析）
  做法: /(^|\n)\s*\*{0,2}\s*做法/,
  条件: /(^|\n)\s*\*{0,2}\s*(条件|做法与条件)/,
  后果: /(^|\n)\s*\*{0,2}\s*后果/,
};
// R8 替代做法关键字
const ALTERNATIVE_KEYWORDS = ['替代', '代替', '改用', '改为', '改写', '而应', '应改', '正确做法', '换成', '应当', '必须', '只能', '按序', '不拆'];
// R27 决策表兜底行关键字。
// 刻意不含 "未列"：它会撞上 "尚未列出…" 这类正文，导致兜底行被删后仍误判为存在。
const FALLBACK_ROW_KEYWORDS = ['兜底', '默认', '其他', '其它', '任意', '其余', '以上都不'];
// R13 兜底核对项关键字：以「兜底」为核心必需字样，避免普通清单项被误判为兜底项
const FALLBACK_ITEM_REQUIRED_KEYWORD = '兜底';
// R14 报错串判定
const ERROR_STRING_KEYWORDS = [/\b(error|errors|exception|denied|refused|invalid|cannot|unable|failed|failure|fatal)\b/i, /\bnot found\b|\bno such\b/i];
const ERROR_STRING_CJK_PATTERN = /报错|错误|失败|异常|非法|无效|拒绝|未签名|数字签名|超时|越界|不匹配|缺少|无法|不能/;
const PATH_LIKE_PATTERN = /[\\/]|\.(md|mjs|js|ps1|json|csv|txt|sh)$/i; // 路径不是报错串
const CODE_LIKE_PATTERN = /[<>{}=]|\.\.\./; // 代码片段不是报错串
const IDENTIFIER_LIKE_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/; // 单个标识符不是报错串
const SNAKE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*_[a-z0-9_]+$/; // snake_case 标识符（工具名）
const ASCII_ONLY_PATTERN = /^[\x20-\x7E]+$/; // 纯 ASCII
const HAS_LETTER_PATTERN = /[A-Za-z\u4e00-\u9fa5]/;

// ── 通用工具 ──────────────────────────────────────────────────────────────

/**
 * 构造一条缺口记录。
 * @param {string} rule_id 规则号（如 R11）
 * @param {string} message 可直接行动的缺口描述
 * @returns {{rule: string, message: string}}
 */
function issue(rule_id, message) {
  return { rule: rule_id, message };
}

/**
 * 统计行首空格数。
 * @param {string} line_text 单行文本
 * @returns {number} 行首空格个数
 */
function leading_spaces(line_text) {
  const match = /^ */.exec(line_text);
  return match[0].length;
}

/**
 * 解析命令行参数，返回 SKILL.md 路径。
 * @param {string[]} argv process.argv 去掉前两项后的参数
 * @returns {string} 目标文件路径
 * @throws {Error} 参数个数不为 1 时抛出
 */
function parse_cli_arguments(argv) {
  const positional = argv.filter((item) => !item.startsWith('-'));
  if (positional.length !== 1) {
    throw new Error('用法: node skill-lint.mjs <SKILL.md 路径>');
  }
  return positional[0];
}

/**
 * 读取文件并按行切分，去掉 BOM。
 * @param {string} file_path 目标文件路径
 * @returns {string[]} 行数组
 */
function read_source_lines(file_path) {
  const raw_text = readFileSync(file_path, 'utf8').replace(/^\uFEFF/, '');
  return raw_text.split(/\r?\n/);
}

// ── frontmatter 解析与校验 ────────────────────────────────────────────────

/**
 * 定位 frontmatter 围栏区间。
 * @param {string[]} lines 全文行数组
 * @returns {{start: number, end: number, body_start: number}|null} 区间或 null
 */
function locate_frontmatter(lines) {
  if (lines.length === 0 || lines[0].trim() !== FRONTMATTER_FENCE) return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === FRONTMATTER_FENCE) {
      return { start: 0, end: index, body_start: index + 1 };
    }
  }
  return { start: 0, end: -1, body_start: 0 }; // end = -1 表示围栏未闭合
}

/**
 * 校验单个标量值是否符合 YAML 子集规则。
 * @param {string} raw_value 值文本
 * @param {number} line_number 行号（1 基）
 * @returns {string|null} 问题描述或 null
 */
function inspect_scalar_value(raw_value, line_number) {
  if (raw_value === '') return null;
  const first_char = raw_value[0];
  if (first_char === '"' || first_char === "'") {
    if (raw_value.length < 2 || raw_value[raw_value.length - 1] !== first_char) {
      return `第 ${line_number} 行引号未闭合`;
    }
    if (first_char === '"' && /(?<!\\)"/.test(raw_value.slice(1, -1))) {
      return `第 ${line_number} 行双引号内存在未转义的引号`;
    }
    return null;
  }
  if (first_char === '[' && !raw_value.endsWith(']')) return `第 ${line_number} 行数组未闭合`;
  if (first_char === '{' && !raw_value.endsWith('}')) return `第 ${line_number} 行映射未闭合`;
  if (YAML_NESTED_COLON_PATTERN.test(raw_value)) {
    return `第 ${line_number} 行未加引号的值内含 ": "（YAML 会解析为嵌套映射）`;
  }
  return null;
}

/**
 * 校验 frontmatter 是否为合法 YAML 子集，并抽出键值。
 * @param {string[]} lines 全文行数组
 * @param {{start: number, end: number}} frontmatter 围栏区间
 * @returns {{fields: Map<string, string>, problems: string[]}} 字段与问题列表
 */
function validate_frontmatter(lines, frontmatter) {
  const fields = new Map();
  const problems = [];
  let block_scalar_indent = -1;
  const fence_lines = frontmatter.end > frontmatter.start ? lines.slice(frontmatter.start + 1, frontmatter.end) : [];
  fence_lines.forEach((line_text, offset) => {
    const line_number = offset + 2; // 首行是 ---
    if (block_scalar_indent >= 0) {
      if (line_text.trim() === '' || leading_spaces(line_text) > block_scalar_indent) return;
      block_scalar_indent = -1;
    }
    if (line_text.trim() === '' || line_text.trim().startsWith('#')) return;
    if (YAML_TAB_INDENT_PATTERN.test(line_text)) {
      problems.push(`第 ${line_number} 行用 Tab 缩进（YAML 禁止）`);
      return;
    }
    const key_match = YAML_KEY_PATTERN.exec(line_text);
    if (!key_match) {
      problems.push(`第 ${line_number} 行不是合法的 "键: 值" 结构`);
      return;
    }
    const key = key_match[1];
    if (fields.has(key)) problems.push(`第 ${line_number} 行键 "${key}" 重复`);
    const raw_value = line_text.slice(key_match[0].length).trim();
    const value_problem = inspect_scalar_value(raw_value, line_number);
    if (value_problem) problems.push(value_problem);
    fields.set(key, raw_value);
    if (YAML_BLOCK_SCALAR_PATTERN.test(raw_value)) block_scalar_indent = leading_spaces(line_text);
  });
  return { fields, problems };
}

// ── 文档结构解析 ──────────────────────────────────────────────────────────

/**
 * 解析全部二级标题节。
 * @param {string[]} lines 全文行数组
 * @returns {Array<{title: string, start: number, end: number}>} 节列表
 */
function parse_sections(lines) {
  const sections = [];
  lines.forEach((line_text, index) => {
    const match = H2_PATTERN.exec(line_text);
    if (!match) return;
    if (sections.length > 0) sections[sections.length - 1].end = index;
    sections.push({ title: match[1].trim(), start: index, end: lines.length });
  });
  return sections;
}

/**
 * 按标题关键字找节。
 * @param {Array<object>} sections 节列表
 * @param {string} keyword 标题关键字
 * @returns {object|null} 节或 null
 */
function find_section(sections, keyword) {
  return sections.find((section) => section.title.includes(keyword)) || null;
}

/**
 * 清点规则标题（正文中形如 **TB-W1 标题。**【必须】 的加粗行）。
 * @param {string[]} lines 全文行数组
 * @param {object|null} scope_section 限定节
 * @returns {Array<{id: string, title: string, modal_source: string, line: number, start: number, end: number}>}
 */
function collect_rules(lines, scope_section) {
  const range_start = scope_section ? scope_section.start : 0;
  const range_end = scope_section ? scope_section.end : lines.length;
  const rules = [];
  for (let index = range_start; index < range_end; index += 1) {
    const match = RULE_HEADING_PATTERN.exec(lines[index]);
    if (!match) continue;
    rules.push({
      id: match[1],
      title: match[2].trim(),
      modal_source: `${match[2]}${match[3]}`,
      line: index + 1,
      start: index,
      end: range_end,
    });
  }
  rules.forEach((rule, position) => {
    rule.end = position + 1 < rules.length ? rules[position + 1].start : range_end;
  });
  return rules;
}

/**
 * 抽取一行文本里的全部锚点 id（支持 〔A、B〕）。
 * @param {string} text 文本
 * @returns {string[]} id 列表
 */
function extract_anchors(text) {
  const anchors = [];
  for (const match of text.matchAll(ANCHOR_PATTERN)) {
    match[1]
      .split(ANCHOR_ID_SPLIT_PATTERN)
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => anchors.push(part));
  }
  return anchors;
}

/**
 * 清点自查清单 checkbox 项。
 * @param {string[]} lines 全文行数组
 * @param {object|null} section 清单节
 * @returns {Array<{text: string, line: number, anchors: string[]}>} 清单项
 */
function collect_checklist_items(lines, section) {
  const items = [];
  const range_start = section ? section.start : 0;
  const range_end = section ? section.end : lines.length;
  for (let index = range_start; index < range_end; index += 1) {
    const match = CHECKLIST_ITEM_PATTERN.exec(lines[index]);
    if (!match) continue;
    items.push({ text: match[1].trim(), line: index + 1, anchors: extract_anchors(match[1]) });
  }
  return items;
}

/**
 * 解析节序行里声明的各项计数。
 * @param {string[]} lines 全文行数组
 * @returns {Array<{name: string, count: number, unit: string, line: number}>} 声明列表
 */
function parse_section_order(lines) {
  const declared = [];
  lines.forEach((line_text, index) => {
    const order_match = SECTION_ORDER_PATTERN.exec(line_text);
    if (!order_match) return;
    order_match[1].split('→').forEach((segment) => {
      const count_match = DECLARED_COUNT_PATTERN.exec(segment);
      if (!count_match) return;
      declared.push({ name: segment.trim(), count: Number(count_match[1]), unit: count_match[2], line: index + 1 });
    });
  });
  return declared;
}

/**
 * 解析规则编号索引声明及其列出的 id。
 * @param {string[]} lines 全文行数组
 * @returns {{declared_count: number, ids: string[], line: number}|null} 索引或 null
 */
function parse_rule_index(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = RULE_INDEX_PATTERN.exec(lines[index]);
    if (!match) continue;
    const ids = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() === '') break;
      for (const id_match of lines[cursor].matchAll(RULE_ID_PATTERN)) ids.push(id_match[1]);
    }
    return { declared_count: Number(match[1]), ids, line: index + 1 };
  }
  return null;
}

/**
 * 清点节内编号步骤数。
 * @param {string[]} lines 全文行数组
 * @param {object|null} section 节
 * @returns {number} 步骤数
 */
function count_numbered_steps(lines, section) {
  if (!section) return 0;
  return lines.slice(section.start, section.end).filter((text) => NUMBERED_STEP_PATTERN.test(text)).length;
}

/**
 * 清点节内表格数据行数。
 * @param {string[]} lines 全文行数组
 * @param {object|null} section 节
 * @returns {number} 数据行数
 */
function count_table_rows(lines, section) {
  if (!section) return 0;
  return lines
    .slice(section.start, section.end)
    .filter((text) => TABLE_ROW_PATTERN.test(text) && !TABLE_SEPARATOR_PATTERN.test(text)).length;
}

/**
 * 按连续表格行切分节内的表格。
 * @param {string[]} lines 全文行数组
 * @param {object} section 节
 * @returns {Array<{start_line: number, rows: Array<{text: string, line: number}>}>} 表格列表
 */
function split_tables(lines, section) {
  const tables = [];
  let current = null;
  for (let index = section.start; index < section.end; index += 1) {
    if (TABLE_ROW_PATTERN.test(lines[index])) {
      if (!current) current = { start_line: index + 1, rows: [] };
      current.rows.push({ text: lines[index], line: index + 1 });
    } else if (current) {
      tables.push(current);
      current = null;
    }
  }
  if (current) tables.push(current);
  return tables;
}

// ── 报错串识别（R14）────────────────────────────────────────────────────

/**
 * 判定一个反引号内联串是否为「报错串」。
 * @param {string} candidate 反引号内容
 * @returns {boolean} 是否为报错串
 */
function is_error_string(candidate) {
  if (candidate.length < MIN_ERROR_STRING_LENGTH || candidate.length > MAX_ERROR_STRING_LENGTH) return false;
  if (PATH_LIKE_PATTERN.test(candidate)) return false;
  if (CODE_LIKE_PATTERN.test(candidate)) return false;
  if (IDENTIFIER_LIKE_PATTERN.test(candidate)) return false;
  if (ERROR_STRING_CJK_PATTERN.test(candidate)) return true;
  if (ERROR_STRING_KEYWORDS.some((pattern) => pattern.test(candidate))) return true;
  const word_tokens = candidate.split(/\s+/).filter((token) => HAS_LETTER_PATTERN.test(token));
  return word_tokens.length >= 2 && ASCII_ONLY_PATTERN.test(candidate);
}

/**
 * 扫描正文（排除 frontmatter、症状速查节、代码围栏）里的报错串。
 * @param {object} context 文档上下文
 * @returns {Array<{text: string, line: number}>} 去重后的报错串
 */
function collect_error_strings(context) {
  const found = new Map();
  let in_fence = false;
  context.lines.forEach((line_text, index) => {
    if (CODE_FENCE_PATTERN.test(line_text)) {
      in_fence = !in_fence;
      return;
    }
    if (in_fence) return;
    if (context.frontmatter && index <= context.frontmatter.end) return;
    if (context.symptom_section && index >= context.symptom_section.start && index < context.symptom_section.end) return;
    for (const match of line_text.matchAll(BACKTICK_SPAN_PATTERN)) {
      const candidate = match[1].trim();
      if (!is_error_string(candidate)) continue;
      if (!found.has(candidate)) found.set(candidate, { text: candidate, line: index + 1 });
    }
  });
  return [...found.values()];
}

/**
 * 收集正文中高频 snake_case 标识符前缀（如 task_board_get → task_board）。
 * @param {string[]} lines 全文行数组
 * @returns {string[]} 高频前缀
 */
function collect_required_trigger_words(lines) {
  const counts = new Map();
  lines.forEach((line_text) => {
    for (const match of line_text.matchAll(BACKTICK_SPAN_PATTERN)) {
      const candidate = match[1].trim();
      if (!SNAKE_IDENTIFIER_PATTERN.test(candidate)) continue;
      const parts = candidate.split('_');
      const prefix = `${parts[0]}_${parts[1]}`;
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
  });
  return [...counts.entries()].filter(([, count]) => count >= HIGH_FREQUENCY_IDENTIFIER_MIN).map(([word]) => word);
}

// ── 各检查项 ──────────────────────────────────────────────────────────────

/**
 * R2：frontmatter 合法 YAML 且含 name/description。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_frontmatter(context) {
  const issues = [];
  if (!context.frontmatter) {
    issues.push(issue('R2', 'frontmatter 缺失：文件未以 --- 包裹的 YAML 头开始'));
    return issues;
  }
  if (context.frontmatter.end < 0) {
    issues.push(issue('R2', 'frontmatter 围栏未闭合：缺少收尾的 ---'));
    return issues;
  }
  if (context.frontmatter.problems.length > 0) {
    context.frontmatter.problems.forEach((problem) => issues.push(issue('R2', `frontmatter 非法 YAML：${problem}`)));
  }
  ['name', 'description'].forEach((field_name) => {
    const value = context.frontmatter.fields.get(field_name);
    if (!value) issues.push(issue('R2', `frontmatter 缺少字段 ${field_name}`));
  });
  return issues;
}

/**
 * R26：全文 H1 唯一。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_h1_uniqueness(context) {
  const issues = [];
  const h1_lines = [];
  context.lines.forEach((line_text, index) => {
    if (context.frontmatter && index <= context.frontmatter.end) return;
    if (H1_PATTERN.test(line_text)) h1_lines.push(index + 1);
  });
  if (h1_lines.length === 0) {
    issues.push(issue('R26', '全文缺少 H1 一级标题'));
  } else if (h1_lines.length > 1) {
    issues.push(issue('R26', `全文 H1 不唯一：${h1_lines.length} 个（第 ${h1_lines.join('、')} 行）`));
  }
  return issues;
}

/**
 * R1：description 触发词声明完整且覆盖正文高频标识符。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_trigger_words(context) {
  const issues = [];
  const description = context.frontmatter ? context.frontmatter.fields.get('description') || '' : '';
  if (!description) {
    issues.push(issue('R1', 'description 为空或缺失，无法承载触发词'));
    return issues;
  }
  const declaration_match = /触发词[：:]\s*(.+)$/m.exec(description);
  if (!declaration_match) {
    issues.push(issue('R1', 'description 缺少触发词声明（应含「触发词：词1、词2、…」）'));
    return issues;
  }
  const words = declaration_match[1]
    .replace(/[。．.]\s*$/, '')
    .split(ANCHOR_ID_SPLIT_PATTERN)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length < MIN_TRIGGER_WORDS) {
    issues.push(issue('R1', `description 触发词仅 ${words.length} 个，少于 ${MIN_TRIGGER_WORDS} 个`));
  }
  const duplicated = [...new Set(words.filter((word, position) => words.indexOf(word) !== position))];
  if (duplicated.length > 0) issues.push(issue('R1', `description 触发词重复: ${duplicated.join('、')}`));
  const missing = collect_required_trigger_words(context.lines).filter((word) => !description.includes(word));
  if (missing.length > 0) {
    issues.push(issue('R1', `description 缺少触发词: ${missing.map((word) => `"${word}"`).join('、')}`));
  }
  return issues;
}

/**
 * 把节序声明名映射为正文实际清点数。
 * @param {string} name 节序段名
 * @param {object} context 文档上下文
 * @returns {number|null} 实际计数或 null（该段无计数语义）
 */
function actual_count_for_segment(name, context) {
  if (/自查清单|清单/.test(name)) return context.checklist_items.length;
  if (/规则正文|规则/.test(name)) return context.rules.length;
  if (/工具调用要点|要点/.test(name)) return count_numbered_steps(context.lines, context.tool_section);
  if (/症状速查|症状/.test(name)) return count_table_rows(context.lines, context.symptom_section);
  return null;
}

/**
 * R15：节序声明的计数与正文清点一致。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_section_order_counts(context) {
  const issues = [];
  if (context.section_order.length === 0) {
    issues.push(issue('R15', '缺少「本文节序：…」声明行，无法声明编号范围与各项计数'));
  }
  context.section_order.forEach((declared) => {
    const actual = actual_count_for_segment(declared.name, context);
    if (actual === null) return;
    if (actual !== declared.count) {
      issues.push(
        issue('R15', `节序声明「${declared.name}」为 ${declared.count} ${declared.unit}，正文实际清点 ${actual} ${declared.unit}（第 ${declared.line} 行）`),
      );
    }
  });
  return issues;
}

/**
 * R15：规则编号索引声明的条数与实际列出/正文的 id 数一致。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_rule_index(context) {
  const issues = [];
  if (!context.rule_index) {
    issues.push(issue('R15', '缺少「规则编号索引（N 条，无空号）」声明'));
    return issues;
  }
  const index_ids = [...new Set(context.rule_index.ids)];
  if (context.rule_index.declared_count !== index_ids.length) {
    issues.push(
      issue('R15', `规则编号索引声明 ${context.rule_index.declared_count} 条，索引实际列出 ${index_ids.length} 个 id（第 ${context.rule_index.line} 行）`),
    );
  }
  const body_ids = context.rules.map((rule) => rule.id);
  const missing_in_index = body_ids.filter((id) => !index_ids.includes(id));
  if (missing_in_index.length > 0) {
    issues.push(issue('R15', `规则未进编号索引: ${missing_in_index.join('、')}`));
  }
  const dangling_index_ids = index_ids.filter((id) => !body_ids.includes(id));
  if (dangling_index_ids.length > 0) {
    issues.push(issue('R15', `编号索引指向的规则在正文不存在: ${dangling_index_ids.join('、')}`));
  }
  return issues;
}

/**
 * 计算落在正文规则 id 命名空间内的清单锚点（去重）。
 * 异命名空间锚点（如本文件引用其它文档的 〔R13〕）不属于本文件的 id 空间，
 * 一律不参与统计与存在性校验。
 * @param {object} context 文档上下文
 * @returns {Map<string, number>} 锚点 id → 首次出现行号
 */
function collect_in_namespace_anchors(context) {
  const namespace_prefixes = new Set(context.rules.map((rule) => rule.id.split('-')[0]));
  const anchored = new Map();
  context.checklist_items.forEach((item) => {
    item.anchors.forEach((anchor_id) => {
      if (!namespace_prefixes.has(anchor_id.split('-')[0])) return;
      if (!anchored.has(anchor_id)) anchored.set(anchor_id, item.line);
    });
  });
  return anchored;
}

/**
 * R11/R12：规则 id ↔ 清单锚点的双向闭合。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_rule_anchor_closure(context) {
  const issues = [];
  const anchored = collect_in_namespace_anchors(context);
  context.rules.forEach((rule) => {
    if (!anchored.has(rule.id)) {
      issues.push(issue('R11', `规则 ${rule.id} 无对应自查清单项（规则标题在第 ${rule.line} 行，清单无 〔${rule.id}〕 锚点）`));
    }
  });
  const rule_ids = context.rules.map((rule) => rule.id);
  [...anchored.keys()].forEach((anchor_id) => {
    if (rule_ids.includes(anchor_id)) return;
    issues.push(issue('R12', `自查清单第 ${anchored.get(anchor_id)} 行的锚点 〔${anchor_id}〕 指向的规则 id 在正文不存在`));
  });
  return issues;
}

/**
 * R15：计数契约——规则标题数 = 清单锚点数；checkbox 总数 = 锚点数 + 1（兜底项）。
 * 该契约刻意不把 checkbox 总数直接与规则数比较：清单比规则多出的那 1 项就是兜底项。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_count_contract(context) {
  const issues = [];
  const rule_count = context.rules.length;
  const anchors = collect_in_namespace_anchors(context);
  const anchor_count = anchors.size;
  const checkbox_count = context.checklist_items.length;
  if (rule_count !== anchor_count) {
    const unanchored = context.rules.map((rule) => rule.id).filter((id) => !anchors.has(id));
    const detail = unanchored.length > 0 ? `，未挂锚点的规则: ${unanchored.join('、')}` : '';
    issues.push(issue('R15', `计数不符：规则标题 ${rule_count} 个、清单锚点 ${anchor_count} 个，应相等${detail}`));
  }
  const expected_checkbox = anchor_count + 1; // 锚点项 + 文末兜底项
  if (checkbox_count !== expected_checkbox) {
    issues.push(
      issue('R15', `计数不符：checkbox 共 ${checkbox_count} 个，应为锚点数 ${anchor_count} + 1 个兜底项 = ${expected_checkbox} 个`),
    );
  }
  return issues;
}

/**
 * R13：清单末尾有兜底核对项，且其覆盖全部规则编号。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_fallback_item(context) {
  const issues = [];
  const items = context.checklist_items;
  if (items.length === 0) {
    issues.push(issue('R13', '自查清单为空，缺少兜底核对项'));
    return issues;
  }
  const last_item = items[items.length - 1];
  if (!last_item.text.includes(FALLBACK_ITEM_REQUIRED_KEYWORD)) {
    issues.push(issue('R13', `自查清单末尾第 ${last_item.line} 行不是兜底核对项（应含「兜底」字样）`));
  }
  if (context.rules.length > 0) {
    const first_id = context.rules[0].id;
    const last_id = context.rules[context.rules.length - 1].id;
    if (!last_item.text.includes(first_id) || !last_item.text.includes(last_id)) {
      issues.push(issue('R13', `兜底核对项未声明覆盖范围：应显式列出 ${first_id}～${last_id}（第 ${last_item.line} 行）`));
    }
  }
  return issues;
}

/**
 * R14：正文报错串在症状速查表都有反查行。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_error_string_lookup(context) {
  const issues = [];
  if (!context.symptom_section) {
    issues.push(issue('R14', '缺少「症状速查」节，正文报错串无表可反查'));
    return issues;
  }
  const table_text = context.lines.slice(context.symptom_section.start, context.symptom_section.end).join('\n');
  collect_error_strings(context).forEach((entry) => {
    if (!table_text.includes(entry.text)) {
      issues.push(issue('R14', `报错串「${entry.text}」在症状表无反查行（出现于第 ${entry.line} 行）`));
    }
  });
  return issues;
}

/**
 * R6：每条规则含「做法/条件/后果」三要素。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_rule_elements(context) {
  const issues = [];
  context.rules.forEach((rule) => {
    const body = context.lines.slice(rule.start, rule.end).join('\n');
    Object.entries(RULE_ELEMENT_MARKERS).forEach(([element_name, pattern]) => {
      if (!pattern.test(body)) {
        issues.push(issue('R6', `规则 ${rule.id} 缺「${element_name}」要素（规则标题在第 ${rule.line} 行）`));
      }
    });
  });
  return issues;
}

/**
 * R49：每条规则有模态标记（必须/禁止/建议）。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_modal_marker(context) {
  const issues = [];
  context.rules.forEach((rule) => {
    if (!MODAL_KEYWORDS.some((keyword) => rule.modal_source.includes(keyword))) {
      issues.push(issue('R49', `规则 ${rule.id} 无模态标记 必须/禁止/建议（规则标题在第 ${rule.line} 行）`));
    }
  });
  return issues;
}

/**
 * R8：每条禁令能找到对应替代做法关键字。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_forbidden_alternatives(context) {
  const issues = [];
  context.rules.forEach((rule) => {
    if (!rule.modal_source.includes('禁止')) return;
    const body = context.lines.slice(rule.start, rule.end).join('\n');
    if (!ALTERNATIVE_KEYWORDS.some((keyword) => body.includes(keyword))) {
      issues.push(issue('R8', `禁令 ${rule.id} 未给出替代做法关键字（规则标题在第 ${rule.line} 行，正文应含「改用/改为/而应/只能」等）`));
    }
  });
  return issues;
}

/**
 * R27：每张决策表有兜底行。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 缺口列表
 */
function check_decision_tables(context) {
  const issues = [];
  if (!context.decision_section) {
    issues.push(issue('R27', '缺少「决策表」节'));
    return issues;
  }
  const tables = split_tables(context.lines, context.decision_section);
  if (tables.length === 0) {
    issues.push(issue('R27', '决策表节内未找到表格'));
    return issues;
  }
  tables.forEach((table) => {
    const has_fallback = table.rows.some((row) => FALLBACK_ROW_KEYWORDS.some((keyword) => row.text.includes(keyword)));
    if (!has_fallback) {
      issues.push(issue('R27', `决策表（第 ${table.start_line} 行起）缺兜底行（应含「兜底/默认/任意」等）`));
    }
  });
  return issues;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/**
 * 组装文档上下文（一次性解析，供各检查项共享）。
 * @param {string[]} lines 全文行数组
 * @returns {object} 上下文对象
 */
function build_context(lines) {
  const frontmatter_range = locate_frontmatter(lines);
  let frontmatter = null;
  if (frontmatter_range) {
    const validated = validate_frontmatter(lines, frontmatter_range);
    frontmatter = { ...frontmatter_range, ...validated };
  }
  const sections = parse_sections(lines);
  const rules_section = find_section(sections, '规则正文');
  return {
    lines,
    frontmatter,
    sections,
    rules_section,
    rules: collect_rules(lines, rules_section),
    checklist_section: find_section(sections, '自查清单'),
    checklist_items: [],
    symptom_section: find_section(sections, '症状速查'),
    decision_section: find_section(sections, '决策表'),
    tool_section: find_section(sections, '工具调用要点'),
    section_order: parse_section_order(lines),
    rule_index: parse_rule_index(lines),
  };
}

/**
 * 按检查项顺序执行全部检查。
 * @param {object} context 文档上下文
 * @returns {Array<object>} 全部缺口
 */
function run_all_checks(context) {
  context.checklist_items = collect_checklist_items(context.lines, context.checklist_section);
  return [
    ...check_frontmatter(context),
    ...check_h1_uniqueness(context),
    ...check_trigger_words(context),
    ...check_section_order_counts(context),
    ...check_rule_index(context),
    ...check_count_contract(context),
    ...check_rule_anchor_closure(context),
    ...check_fallback_item(context),
    ...check_error_string_lookup(context),
    ...check_rule_elements(context),
    ...check_modal_marker(context),
    ...check_forbidden_alternatives(context),
    ...check_decision_tables(context),
  ];
}

/**
 * 程序入口。
 * @returns {number} 退出码
 */
function main() {
  let target_path;
  try {
    target_path = parse_cli_arguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return EXIT_CODE_USAGE_ERROR;
  }
  let lines;
  try {
    lines = read_source_lines(target_path);
  } catch (error) {
    process.stderr.write(`无法读取文件 ${target_path}: ${error.message}\n`);
    return EXIT_CODE_USAGE_ERROR;
  }
  const context = build_context(lines);
  const issues = run_all_checks(context);
  if (issues.length === 0) {
    const anchor_count = collect_in_namespace_anchors(context).size;
    process.stdout.write(
      `PASS ${target_path} 规则标题 ${context.rules.length} 个、清单锚点 ${anchor_count} 个、checkbox ${context.checklist_items.length} 个（= 锚点 ${anchor_count} + 1 兜底项）\n`,
    );
    return EXIT_CODE_PASS;
  }
  issues.forEach((entry) => process.stdout.write(`FAIL ${entry.rule} ${entry.message}\n`));
  process.stderr.write(`共 ${issues.length} 处缺口\n`);
  return EXIT_CODE_LINT_FAIL;
}

process.exitCode = main();