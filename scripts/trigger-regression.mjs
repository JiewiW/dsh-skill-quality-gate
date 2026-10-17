#!/usr/bin/env node
/**
 * 触发回归测试（harness 补偿方案「方向三 3.2」）。
 *
 * 目的：把「技能能否被模型调用到」从人读主观判断变成可测指标。
 * 做法：对真实技能目录 `~/.dsh/skills/<name>/SKILL.md` 逐条跑症状样本，
 *       用 frontmatter description + 正文做子串匹配，输出命中技能名与命中片段，
 *       命中率低于阈值即非零退出并列出未命中条目。
 *
 * 命中判定语义（集合包含判据）：一条样本的命中技能集合包含 expectSkill 即通过；
 * 不要求 expectSkill 是 top1，避免新技能抢走唯一命中位导致误判。
 *
 * 用法：
 *   node trigger-regression.mjs [选项]
 *   --cases <path>        样本集 JSON 路径（默认同目录 trigger-cases.json）
 *   --skills-dir <path>   技能目录（默认 %USERPROFILE%\.dsh\skills）
 *   --threshold <0..1>    命中率阈值（默认 1.0）
 *   --min-match <n>       判定命中所需的最长公共子串字符数（默认 4）
 *   --min-ascii-match <n> 纯 ASCII 命中片段所需的最小字符数（默认 8，防文件名残片等噪声误判）
 *   --json                额外输出机器可读 JSON
 *   --self-test           对临时副本做删除测试：删掉触发词后对应样本必须失配且命中率跌破阈值
 *   --quiet               只输出汇总
 *
 * 退出码：0 命中率达标；1 命中率不达标（或 --self-test 未通过）；2 参数/环境错误。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 工具目录，用于定位同目录的默认样本集。 */
const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
/** 默认技能目录：真实生效的技能根目录，不是副本。 */
const DEFAULT_SKILLS_DIR = join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "skills");
/** 默认样本集路径：包内 data/ 目录（scripts/ 的上级 data/）。 */
const DEFAULT_CASES_PATH = join(TOOL_DIR, "..", "data", "trigger-cases.json");
/** 判定命中所需的最长公共子串最小字符数。 */
const DEFAULT_MIN_MATCH_CHARS = 4;
/**
 * 纯 ASCII 命中片段所需的最小字符数。
 * 含中日韩文字的片段按 minMatchChars 判定即可；但纯 ASCII 的短重叠多为噪声
 * （例如查询里的文件名残片 `xps1` 与正文 `x.ps1` 撞上），故要求更长才算命中。
 */
const DEFAULT_MIN_ASCII_MATCH_CHARS = 8;
/** 判断片段是否含中日韩文字。 */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]/;
/** 命中率阈值：默认要求全中。 */
const DEFAULT_THRESHOLD = 1.0;
/** 技能文件名。 */
const SKILL_FILE_NAME = "SKILL.md";
/** 归一化时保留的字符类：中日韩文字 + 拉丁字母 + 数字。 */
const KEEP_PATTERN = /[^\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ffa-z0-9]/g;

/**
 * 解析命令行参数。
 * @param {string[]} argv 进程参数（不含 node 与脚本路径）
 * @returns {{casesPath:string, skillsDir:string, threshold:number, minMatchChars:number, json:boolean, selfTest:boolean, quiet:boolean}}
 */
function parse_arguments(argv) {
	const options = {
		casesPath: DEFAULT_CASES_PATH,
		skillsDir: DEFAULT_SKILLS_DIR,
		threshold: DEFAULT_THRESHOLD,
		minMatchChars: DEFAULT_MIN_MATCH_CHARS,
		minAsciiMatchChars: DEFAULT_MIN_ASCII_MATCH_CHARS,
		json: false,
		selfTest: false,
		quiet: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const next = argv[index + 1];
		if (flag === "--cases") {
			options.casesPath = resolve(next);
			index += 1;
		} else if (flag === "--skills-dir") {
			options.skillsDir = resolve(next);
			index += 1;
		} else if (flag === "--threshold") {
			options.threshold = Number(next);
			index += 1;
		} else if (flag === "--min-match") {
			options.minMatchChars = Number(next);
			index += 1;
		} else if (flag === "--min-ascii-match") {
			options.minAsciiMatchChars = Number(next);
			index += 1;
		} else if (flag === "--json") {
			options.json = true;
		} else if (flag === "--self-test") {
			options.selfTest = true;
		} else if (flag === "--quiet") {
			options.quiet = true;
		} else {
			throw new Error(`未知参数：${flag}`);
		}
	}
	if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) {
		throw new Error(`--threshold 必须是 0..1 之间的数，收到：${options.threshold}`);
	}
	if (!Number.isInteger(options.minMatchChars) || options.minMatchChars < 1) {
		throw new Error(`--min-match 必须是正整数，收到：${options.minMatchChars}`);
	}
	if (!Number.isInteger(options.minAsciiMatchChars) || options.minAsciiMatchChars < 1) {
		throw new Error(`--min-ascii-match 必须是正整数，收到：${options.minAsciiMatchChars}`);
	}
	return options;
}

/**
 * 归一化文本：小写化，仅保留中日韩文字、字母、数字，丢弃空白与标点。
 * 这样 `未对文件…进行数字签名` 与正文中的同类表述可跨标点比对。
 * @param {string} text 原始文本
 * @returns {string} 归一化文本
 */
function normalize_text(text) {
	return text.toLowerCase().replace(KEEP_PATTERN, "");
}

/**
 * 从 SKILL.md 中拆出 frontmatter description 与正文。
 * @param {string} raw SKILL.md 原文
 * @returns {{description:string, body:string}}
 */
function split_skill_document(raw) {
	const frontmatter_match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
	if (frontmatter_match === null) {
		return { description: "", body: raw };
	}
	const description_match = /^description:[ \t]*(.*)$/m.exec(frontmatter_match[1]);
	return {
		description: description_match === null ? "" : description_match[1].trim(),
		body: raw.slice(frontmatter_match[0].length),
	};
}

/**
 * 计算两串的最长公共子串（长度与片段）。逐字符滚动一维 DP，O(n*m) 时间、O(m) 空间。
 * @param {string} query_text 归一化查询串（片段取自此处，便于人读）
 * @param {string} skill_text 归一化技能检索串
 * @returns {{length:number, fragment:string}} 最长公共子串长度与查询侧片段
 */
function find_longest_common_substring(query_text, skill_text) {
	if (query_text.length === 0 || skill_text.length === 0) {
		return { length: 0, fragment: "" };
	}
	const previous = new Uint32Array(skill_text.length + 1);
	const current = new Uint32Array(skill_text.length + 1);
	let best_length = 0;
	let best_end = 0;
	for (let query_index = 1; query_index <= query_text.length; query_index += 1) {
		for (let skill_index = 1; skill_index <= skill_text.length; skill_index += 1) {
			if (query_text[query_index - 1] === skill_text[skill_index - 1]) {
				current[skill_index] = previous[skill_index - 1] + 1;
				if (current[skill_index] > best_length) {
					best_length = current[skill_index];
					best_end = query_index;
				}
			} else {
				current[skill_index] = 0;
			}
		}
		previous.set(current);
		current.fill(0);
	}
	return { length: best_length, fragment: query_text.slice(best_end - best_length, best_end) };
}

/**
 * 载入技能目录下全部 SKILL.md，生成归一化检索文本。
 * @param {string} skills_dir 技能根目录
 * @returns {Array<{name:string, path:string, raw:string, description:string, body:string, searchText:string}>}
 */
function load_skills(skills_dir) {
	if (!existsSync(skills_dir)) {
		throw new Error(`技能目录不存在：${skills_dir}`);
	}
	const skills = [];
	for (const entry of readdirSync(skills_dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skill_path = join(skills_dir, entry.name, SKILL_FILE_NAME);
		if (!existsSync(skill_path) || !statSync(skill_path).isFile()) continue;
		const raw = readFileSync(skill_path, "utf8");
		const { description, body } = split_skill_document(raw);
		skills.push({
			name: entry.name,
			path: skill_path,
			raw,
			description,
			body,
			searchText: normalize_text(`${description}\n${body}`),
		});
	}
	skills.sort((left, right) => left.name.localeCompare(right.name));
	if (skills.length === 0) {
		throw new Error(`技能目录下没有找到任何 ${SKILL_FILE_NAME}：${skills_dir}`);
	}
	return skills;
}

/**
 * 载入并校验样本集。
 * @param {string} cases_path 样本集 JSON 路径
 * @returns {Array<{query:string, expectSkill:string}>}
 */
function load_cases(cases_path) {
	if (!existsSync(cases_path)) {
		throw new Error(`样本集不存在：${cases_path}`);
	}
	const parsed = JSON.parse(readFileSync(cases_path, "utf8"));
	if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
		throw new Error(`样本集缺少非空 cases 数组：${cases_path}`);
	}
	for (const [index, item] of parsed.cases.entries()) {
		if (typeof item?.query !== "string" || item.query.trim() === "") {
			throw new Error(`第 ${index + 1} 条样本缺少 query`);
		}
		if (typeof item?.expectSkill !== "string" || item.expectSkill.trim() === "") {
			throw new Error(`第 ${index + 1} 条样本缺少 expectSkill`);
		}
	}
	return parsed.cases;
}

/**
 * 判断最长公共子串是否够格算作命中。
 * 含中日韩文字的片段按 min_match_chars 判定；纯 ASCII 片段要求达到 min_ascii_match_chars，
 * 以免文件名残片之类的短重叠造成假命中。
 * @param {{length:number, fragment:string}} match 最长公共子串
 * @param {number} min_match_chars 含中日韩文字时的最小长度
 * @param {number} min_ascii_match_chars 纯 ASCII 时的最小长度
 * @returns {boolean} 是否算命中
 */
function is_qualifying_match(match, min_match_chars, min_ascii_match_chars) {
	if (match.length < min_match_chars) return false;
	if (CJK_PATTERN.test(match.fragment)) return true;
	return match.length >= min_ascii_match_chars;
}

/**
 * 对单条样本跑一次检索，返回命中技能列表。
 * @param {{query:string}} case_item 样本
 * @param {ReturnType<typeof load_skills>} skills 技能清单
 * @param {number} min_match_chars 命中所需最短公共子串长度
 * @param {number} min_ascii_match_chars 纯 ASCII 命中片段所需最小长度
 * @returns {Array<{skill:string, matchedChars:number, fragment:string}>} 按匹配长度降序的命中列表
 */
function match_case(case_item, skills, min_match_chars, min_ascii_match_chars = DEFAULT_MIN_ASCII_MATCH_CHARS) {
	const query_text = normalize_text(case_item.query);
	const hits = [];
	for (const skill of skills) {
		const match = find_longest_common_substring(query_text, skill.searchText);
		if (is_qualifying_match(match, min_match_chars, min_ascii_match_chars)) {
			hits.push({ skill: skill.name, matchedChars: match.length, fragment: match.fragment });
		}
	}
	hits.sort((left, right) => right.matchedChars - left.matchedChars || left.skill.localeCompare(right.skill));
	return hits;
}

/**
 * 跑完整回归，返回结构化结果。
 * @param {Array<{query:string, expectSkill:string}>} cases 样本集
 * @param {ReturnType<typeof load_skills>} skills 技能清单
 * @param {number} min_match_chars 命中所需最短公共子串长度
 * @param {number} min_ascii_match_chars 纯 ASCII 命中片段所需最小长度
 * @returns {{total:number, hitCount:number, hitRate:number, misses:Array<object>, results:Array<object>}}
 */
function run_regression(cases, skills, min_match_chars, min_ascii_match_chars = DEFAULT_MIN_ASCII_MATCH_CHARS) {
	const results = [];
	const misses = [];
	for (const case_item of cases) {
		const hits = match_case(case_item, skills, min_match_chars, min_ascii_match_chars);
		const passed = hits.some((hit) => hit.skill === case_item.expectSkill);
		const expected_hit = hits.find((hit) => hit.skill === case_item.expectSkill) ?? null;
		const record = {
			query: case_item.query,
			expectSkill: case_item.expectSkill,
			passed,
			hitSkills: hits.map((hit) => hit.skill),
			expectedFragment: expected_hit === null ? "" : expected_hit.fragment,
			expectedMatchedChars: expected_hit === null ? 0 : expected_hit.matchedChars,
			bestHit: hits.length === 0 ? null : { skill: hits[0].skill, matchedChars: hits[0].matchedChars, fragment: hits[0].fragment },
		};
		results.push(record);
		if (!passed) misses.push(record);
	}
	const hitCount = results.length - misses.length;
	return {
		total: results.length,
		hitCount,
		hitRate: results.length === 0 ? 0 : hitCount / results.length,
		misses,
		results,
	};
}

/**
 * 打印人读报告。
 * @param {ReturnType<typeof run_regression>} report 回归结果
 * @param {object} options 参数
 * @returns {void}
 */
function print_report(report, options) {
	if (!options.quiet) {
		console.log(`技能目录：${options.skillsDir}`);
		console.log(`样本集　：${options.casesPath}`);
		console.log(`命中判据：description + 正文的最长公共子串 ≥ ${options.minMatchChars} 字符（含中文）/ ≥ ${options.minAsciiMatchChars} 字符（纯 ASCII）；集合包含判据`);
		console.log("");
		for (const record of report.results) {
			const mark = record.passed ? "PASS" : "MISS";
			const fragment = record.passed
				? `${record.expectedFragment}（${record.expectedMatchedChars} 字符）`
				: record.bestHit === null
					? "<无任何技能命中>"
					: `${record.bestHit.fragment} @ ${record.bestHit.skill}（${record.bestHit.matchedChars} 字符，非期望技能）`;
			console.log(`[${mark}] expect=${record.expectSkill} :: ${record.query}`);
			console.log(`        命中技能=${record.hitSkills.length === 0 ? "-" : record.hitSkills.join(", ")}`);
			console.log(`        命中片段=${fragment}`);
		}
		console.log("");
	}
	console.log(`总样本数：${report.total}`);
	console.log(`命中数　：${report.hitCount}`);
	console.log(`命中率　：${(report.hitRate * 100).toFixed(1)}%（阈值 ${(options.threshold * 100).toFixed(1)}%）`);
	if (report.misses.length > 0) {
		console.log(`未命中条目（${report.misses.length} 条）：`);
		for (const record of report.misses) {
			console.log(`  - expect=${record.expectSkill} :: ${record.query}`);
		}
	}
}

/**
 * 把归一化片段还原成可匹配原文的正则：片段字符之间允许夹带被归一化丢弃的空白与标点。
 * @param {string} fragment 归一化片段
 * @returns {RegExp} 全局正则
 */
function build_flexible_pattern(fragment) {
	const escaped = [...fragment].map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp(escaped.join("[^\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ffa-z0-9]*"), "g");
}

/**
 * 在临时副本上做删除测试：删掉触发词后，对应样本必须变为未命中且命中率跌破阈值（即退出码非 0）。
 * 这是对「命中率」是否为假通过的自检，同时复现验收要求的「删词 → 未命中 + 非零退出」。
 * @param {ReturnType<typeof load_skills>} skills 真实技能清单
 * @param {Array<{query:string, expectSkill:string}>} cases 样本集
 * @param {object} options 参数
 * @returns {{ok:boolean, lines:string[]}} 自检结果
 */
function run_self_test(skills, cases, options) {
	const lines = [];
	const temp_dir = mkdtempSync(join(tmpdir(), "trigger-regression-"));
	const pristine_report = run_regression(cases, skills, options.minMatchChars, options.minAsciiMatchChars);
	try {
		for (const skill of skills) {
			const target_dir = join(temp_dir, skill.name);
			mkdirSync(target_dir, { recursive: true });
			copyFileSync(skill.path, join(target_dir, SKILL_FILE_NAME));
		}
		const candidates = [];
		for (const case_item of cases) {
			const expected_hit = match_case(case_item, skills, options.minMatchChars, options.minAsciiMatchChars)
				.find((hit) => hit.skill === case_item.expectSkill);
			if (expected_hit === undefined || expected_hit.fragment === "") continue;
			const skill = skills.find((item) => item.name === case_item.expectSkill);
			const pattern = build_flexible_pattern(expected_hit.fragment);
			const in_description = pattern.test(skill.description);
			candidates.push({
				skill: case_item.expectSkill,
				query: case_item.query,
				fragment: expected_hit.fragment,
				inDescription: in_description,
			});
		}
		// 优先挑「触发词确实写在 description 里」的候选，其次按片段长度从长到短，
		// 以便自检复现验收要求的「删 description 触发词 → 未命中」。
		candidates.sort((left, right) => Number(right.inDescription) - Number(left.inDescription)
			|| right.fragment.length - left.fragment.length
			|| left.skill.localeCompare(right.skill));
		if (candidates.length === 0) {
			return { ok: false, lines: ["自检失败：没有任何样本命中期望技能，无法构造删除测试"] };
		}
		// 基线命中率即「达标线」：删除前退出码为 0，删除后跌破即退出码 1，可干净地证明灵敏度。
		const baseline_threshold = pristine_report.hitRate;
		for (const candidate of candidates) {
			const target_path = join(temp_dir, candidate.skill, SKILL_FILE_NAME);
			const original = readFileSync(target_path, "utf8");
			const scopes = candidate.inDescription ? ["description", "description + 正文"] : ["description + 正文"];
			for (const scope of scopes) {
				writeFileSync(target_path, original, "utf8");
				const pattern = build_flexible_pattern(candidate.fragment);
				const mutated = original.replace(pattern, "");
				if (mutated === original) continue;
				writeFileSync(target_path, mutated, "utf8");
				const mutated_report = run_regression(cases, load_skills(temp_dir), options.minMatchChars, options.minAsciiMatchChars);
				const probe_record = mutated_report.results.find((record) => record.query === candidate.query);
				const probe_missed = probe_record !== undefined && !probe_record.passed;
				const gate_flip = mutated_report.hitRate < baseline_threshold;
				if (!probe_missed || !gate_flip) continue;
				lines.push("删除测试（在临时副本上进行，真实技能目录未被改动）：");
				lines.push(`  技能=${candidate.skill}　删除范围=${scope}　删除触发词「${candidate.fragment}」`);
				lines.push(`  对应样本：${candidate.query}`);
				lines.push(`  删除前：该样本命中 ${candidate.skill}；命中率 ${(pristine_report.hitRate * 100).toFixed(1)}%，以该命中率为达标线时退出码 0`);
				lines.push(`  删除后：该样本未命中；命中率 ${(mutated_report.hitRate * 100).toFixed(1)}%，跌破达标线 → 退出码 1`);
				lines.push(`  未命中条目：${mutated_report.misses.map((record) => `expect=${record.expectSkill} :: ${record.query}`).join("；")}`);
				lines.push("  结论：命中率对 description 触发词真实敏感，不是恒真的假通过。");
				return { ok: true, lines };
			}
		}
		return { ok: false, lines: [...lines, "自检失败：遍历全部候选触发词，删除后均未使对应样本失配"] };
	} finally {
		rmSync(temp_dir, { recursive: true, force: true });
	}
}

/**
 * 入口。
 * @returns {void}
 */
function main() {
	try {
		const options = parse_arguments(process.argv.slice(2));
		const skills = load_skills(options.skillsDir);
		const cases = load_cases(options.casesPath);
		const report = run_regression(cases, skills, options.minMatchChars, options.minAsciiMatchChars);
		print_report(report, options);

		let self_test = null;
		if (options.selfTest) {
			console.log("");
			self_test = run_self_test(skills, cases, options);
			for (const line of self_test.lines) console.log(line);
		}
		if (options.json) {
			console.log("");
			console.log(JSON.stringify({
				skillsDir: options.skillsDir,
				casesPath: options.casesPath,
				threshold: options.threshold,
				minMatchChars: options.minMatchChars,
				minAsciiMatchChars: options.minAsciiMatchChars,
				skillCount: skills.length,
				total: report.total,
				hitCount: report.hitCount,
				hitRate: report.hitRate,
				misses: report.misses.map((record) => ({ query: record.query, expectSkill: record.expectSkill, bestHit: record.bestHit })),
				results: report.results,
				selfTest: self_test === null ? null : { ok: self_test.ok, lines: self_test.lines },
			}, null, 2));
		}

		const gate_passed = report.hitRate >= options.threshold;
		const self_test_passed = self_test === null || self_test.ok;
		if (!gate_passed) {
			console.error(`\n触发回归失败：命中率 ${(report.hitRate * 100).toFixed(1)}% < 阈值 ${(options.threshold * 100).toFixed(1)}%，未命中 ${report.misses.length} 条。`);
		}
		if (!self_test_passed) {
			console.error("\n自检失败：删除测试未能证明匹配逻辑的灵敏度。");
		}
		process.exitCode = gate_passed && self_test_passed ? 0 : 1;
	} catch (error) {
		console.error(`trigger-regression 参数/环境错误：${error.message}`);
		process.exitCode = 2;
	}
}

main();