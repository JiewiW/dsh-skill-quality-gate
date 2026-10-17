#!/usr/bin/env node
/**
 * skill-lint-turnend-plugin.mjs —— 方案三 3.3「次选：turn/end 后置检查」的最小可运行实现。
 *
 * 形态定位（对应卡面步骤 3b）：
 *   turn 结束时若本 turn 改动过 SKILL.md，则对该文件跑真实 skill-lint.mjs；
 *   未过检时，把**具体缺口**（规则号 + 位置 + 期望）注入下一 turn 开头的系统消息。
 *   只做提示，**不做硬阻断**（3c：agent/turn-stopping 在 0.2.0-rc.2 仅为 serial 通知，
 *   不修改 turnEnds，见 dsh-agent-loop/lib/index.js:1012 与 :1018 的 break 条件）。
 *
 * 内核证据（D:\dsh\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js，版本 0.2.0-rc.2）：
 *   - 事件签名 `turn/start`：{ turn }            —— :956 session.append("turn/start", { turn })
 *   - 事件签名 `turn/end`  ：{ turn, reason }    —— :1040 session.append("turn/end", { turn, reason: turnEnds })
 *     ★ turn/end 是 session.append，不是 dispatch 钩子；插件不能直接 on("turn/end")。
 *   - 插件可观察的通道：ctx.on("session/event", (subject, event) => …) —— :330（内核自身即如此用）
 *   - 工具调用事件含工具名与入参：tool/call { turn, step, callId, name, arguments } —— :695-699
 *   - 注入通道：agent/pre-step waterfall 的 decision.messages 可被追加 —— :924-931
 *     `{ messages: claimed, ...position, signal }`，默认返回 `{ kind:"enter", messages: […] }`
 *
 * 用法（在 dsh 插件中注册；本文件同时可作为独立自检脚本运行）：
 *   自检：node skill-lint-turnend-plugin.mjs --self-test
 *
 * @module skill-lint-turnend-plugin
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** skill-lint.mjs 的默认路径：与本模块同目录（随包分发，不写死机器路径）。 */
const DEFAULT_LINTER_PATH = fileURLToPath(new URL('./skill-lint.mjs', import.meta.url))

/** 命中本插件的文件判据：任何名为 SKILL.md 的文件。 */
const SKILL_FILE_PATTERN = /(^|[\\/])SKILL\.md$/i

/** 写入类工具名（这些工具的 arguments 里可能带 file_path）。 */
const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'str_replace', 'create_file', 'apply_patch'])

/** 单次注入的缺口行上限，避免长文档把下一 turn 的开头撑爆。 */
const MAX_INJECTED_GAPS = 12

/** 从工具入参中提取目标路径的候选键名。 */
const PATH_ARG_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'notebook_path']

/**
 * 从一个 tool/call 事件里取出被写入的文件路径。
 * 只负责取路径，不判是否 SKILL.md（由调用方用 SKILL_FILE_PATTERN 判定）。
 * @param {object} event - 会话事件。
 * @returns {string|null} 路径字符串或 null。
 */
function extractWrittenPath(event) {
  if (event?.type !== 'tool/call') return null
  const name = String(event.data?.name ?? '')
  if (!WRITE_TOOL_NAMES.has(name)) return null
  const args = event.data?.arguments
  const parsed = typeof args === 'string' ? safeJsonParse(args) : args
  if (parsed === null || typeof parsed !== 'object') return null
  for (const key of PATH_ARG_KEYS) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

/**
 * 判断一个 tool/call 事件是否写入了 SKILL.md。
 * @param {object} event - 会话事件。
 * @returns {string|null} 命中的 SKILL.md 绝对路径，否则 null。
 */
function extractSkillPath(event) {
  const writtenPath = extractWrittenPath(event)
  if (writtenPath === null) return null
  return SKILL_FILE_PATTERN.test(writtenPath) ? resolve(writtenPath) : null
}

/**
 * JSON.parse 的容错包装：解析失败返回 null 而不是抛错。
 * @param {string} text - 待解析文本。
 * @returns {object|null} 解析结果或 null。
 */
function safeJsonParse(text) {
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

/**
 * 对指定 SKILL.md 跑真实 skill-lint.mjs，返回退出码与 stdout。
 * @param {string} skillPath - SKILL.md 绝对路径。
 * @param {string} linterPath - skill-lint.mjs 绝对路径。
 * @returns {{code:number, stdout:string, stderr:string}} 运行结果。
 */
function runLinter(skillPath, linterPath) {
  const result = spawnSync(process.execPath, [linterPath, skillPath], {
    encoding: 'utf8',
    timeout: 30000
  })
  return {
    code: result.status ?? -1,
    stdout: String(result.stdout ?? '').trim(),
    stderr: String(result.stderr ?? '').trim()
  }
}

/**
 * 把 linter 的 stdout 缺口行整理成注入用文本（保留规则号与位置，禁止模糊措辞）。
 * @param {string} stdout - linter 的标准输出。
 * @returns {string[]} 缺口行数组。
 */
function collectGapLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('FAIL '))
    .slice(0, MAX_INJECTED_GAPS)
}

/**
 * 构造注入下一 turn 的系统消息文本。
 * @param {string} skillPath - 被改动的 SKILL.md 路径。
 * @param {string[]} gapLines - 缺口行。
 * @param {number} exitCode - linter 退出码。
 * @returns {string} 注入文本。
 */
function buildInjectionText(skillPath, gapLines, exitCode) {
  const header = [
    `【skill-lint 后置检查】上一 turn 改动的 ${basename(skillPath)} 未过检（退出码 ${exitCode}）。`,
    `文件：${skillPath}`,
    '具体缺口（规则号 + 位置 + 期望，逐条修复后重跑 skill-lint）：'
  ]
  return [...header, ...gapLines.map((line) => `  ${line}`)].join('\n')
}

/**
 * 创建一个 turn/end 后置检查控制器。
 * @param {object} options - 配置项。
 * @param {string} [options.linterPath] - skill-lint.mjs 路径。
 * @param {Function} [options.onInject] - 注入回调，便于测试。
 * @returns {object} 控制器。
 */
export function createTurnEndLintController(options = {}) {
  const linterPath = options.linterPath ?? DEFAULT_LINTER_PATH
  /** 本 turn 内被写过的 SKILL.md 路径集合。 */
  let currentTurnPaths = new Set()
  /** 待注入下一 turn 的文本队列。 */
  const pendingInjections = []
  /** 统计：检查次数与未过检次数。 */
  const stats = { checked: 0, failed: 0 }

  /**
   * 处理一个会话事件：累积本 turn 的写入路径；在 turn/end 时触发检查。
   * @param {object} event - 会话事件。
   * @returns {void}
   */
  function handleSessionEvent(event) {
    if (event?.type === 'turn/start') {
      currentTurnPaths = new Set()
      return
    }
    const writtenPath = extractSkillPath(event)
    if (writtenPath !== null) {
      currentTurnPaths.add(writtenPath)
      return
    }
    if (event?.type !== 'turn/end') return
    for (const skillPath of currentTurnPaths) {
      if (!existsSync(skillPath)) continue
      const { code, stdout } = runLinter(skillPath, linterPath)
      stats.checked += 1
      if (code === 0) continue
      const gapLines = collectGapLines(stdout)
      if (gapLines.length === 0) continue
      stats.failed += 1
      pendingInjections.push(buildInjectionText(skillPath, gapLines, code))
    }
    currentTurnPaths = new Set()
  }

  /**
   * 取出并清空待注入文本。
   * @returns {string[]} 待注入文本数组。
   */
  function drainInjections() {
    return pendingInjections.splice(0, pendingInjections.length)
  }

  return { handleSessionEvent, drainInjections, stats }
}

/**
 * 把控制器接到 dsh 插件上下文上。
 * @param {object} ctx - dsh 插件上下文。
 * @param {object} [options] - 传给 createTurnEndLintController 的配置。
 * @returns {Function} 卸载函数。
 */
export function installSkillLintTurnEndPlugin(ctx, options = {}) {
  const controller = createTurnEndLintController(options)
  const disposers = []

  disposers.push(ctx.on('session/event', (subject, event) => {
    controller.handleSessionEvent(event)
  }))

  disposers.push(ctx.on('agent/pre-step', (payload, next) => {
    const injections = controller.drainInjections()
    if (injections.length === 0) return next()
    return next().then((decision) => {
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const notice = {
        role: 'user',
        content: [{ type: 'text', text: injections.join('\n\n') }]
      }
      return { ...decision, messages: [...decision.messages, notice] }
    })
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** 自检用的最小缺陷 SKILL.md 内容（故意缺触发词/锚点/三要素/兜底项）。 */
const SELF_TEST_DEFECTIVE_SKILL = [
  '---',
  'name: probe-skill',
  'description: 短',
  '---',
  '# Probe',
  '',
  '**PB-R1 某规则**',
  '- 做法：做某事'
].join('\n')

// ── 自检：验证「路径提取 → 落盘 → 检查 → 缺口 → 注入文本」全链路 ─────────
if (process.argv.includes('--self-test')) {
  const observed = runSelfTest()
  if (observed.failures.length === 0) {
    console.log('SELF-TEST PASS: 路径提取 / 非技能文件排除 / turn 边界 / 退出码 / 缺口行 / 注入文本 全部符合预期')
    console.log(`  观测：checked=${observed.stats.checked} failed=${observed.stats.failed} gaps=${observed.gapLines.length}`)
    process.exit(0)
  }
  console.log('SELF-TEST FAIL:')
  for (const item of observed.failures) console.log('  - ' + item)
  process.exit(1)
}

/**
 * 走完整链路做自检：造缺陷文件 → 走 turn/start…turn/end → 取注入文本。
 * @returns {object} 观测值，含 failures 数组。
 */
function runSelfTest() {
  const failures = []
  const tmpDir = mkdtempSync(join(tmpdir(), 'skill-lint-turnend-'))
  const defectivePath = join(tmpDir, 'SKILL.md')
  writeFileSync(defectivePath, SELF_TEST_DEFECTIVE_SKILL, 'utf8')

  const controller = createTurnEndLintController()
  controller.handleSessionEvent({ type: 'turn/start', data: { turn: 1 } })
  controller.handleSessionEvent({
    type: 'tool/call',
    data: { name: 'edit', arguments: JSON.stringify({ file_path: defectivePath }) }
  })
  controller.handleSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const injections = controller.drainInjections()

  const skillEvent = {
    type: 'tool/call',
    data: { name: 'edit', arguments: JSON.stringify({ file_path: 'C:\\x\\SKILL.md' }) }
  }
  const otherEvent = {
    type: 'tool/call',
    data: { name: 'edit', arguments: JSON.stringify({ file_path: 'D:\\dsh\\tools\\foo.mjs' }) }
  }

  if (extractSkillPath(skillEvent) === null) failures.push('未从 write 事件提取到 SKILL.md 路径')
  if (extractSkillPath(otherEvent) !== null) failures.push('普通文件被误判为 SKILL.md')
  if (controller.stats.checked !== 1) failures.push(`turn/end 未触发检查，checked=${controller.stats.checked}`)
  if (controller.stats.failed !== 1) failures.push(`缺陷文件未被判失败，failed=${controller.stats.failed}`)
  if (injections.length !== 1) failures.push(`未生成注入文本，injections=${injections.length}`)
  const injectionText = injections[0] ?? ''
  if (!/FAIL /.test(injectionText)) failures.push('注入文本不含具体缺口行')
  if (!/退出码 1/.test(injectionText)) failures.push('注入文本未含退出码')

  rmSync(tmpDir, { recursive: true, force: true })
  return {
    failures,
    stats: controller.stats,
    gapLines: collectGapLines(injectionText)
  }
}