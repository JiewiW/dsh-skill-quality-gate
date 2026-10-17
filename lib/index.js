/**
 * dsh-skill-quality-gate —— SKILL.md 质量门禁主机插件（host-only，无 client 半边）。
 *
 * 一个安装单元交付三类能力：
 *   1. 运行期技能：skills/skill-authoring.md（动 SKILL.md 正文前强制覆盖矩阵）；
 *   2. turn/end 后置检查：本 turn 改过 SKILL.md 则跑随包真实 linter，
 *      未过检时把具体缺口（规则号 + 位置 + 期望）注入下一 turn 开头（user 消息）；
 *   3. 随包脚本（scripts/）：确定性 linter、规则增删事务 CLI、触发回归；
 *      data/ 为触发样本；test/ 为夹具与自检；skill-lint-on-save.ps1 供编辑器保存后触发。
 *
 * 内核能力边界（0.2.0-rc.2，源码证据见 docs/INJECTION-NOTES.md）：
 *   - 只观察不拦截：turn 边界经 ctx.on("session/event")，文件路径取自 tool/call.arguments；
 *   - 注入经 agent/pre-step waterfall 的 decision.messages，落盘为 user/message；
 *   - 不使用 agent/turn-stopping 做硬阻断（该钩子返回值不参与结束判定），不引用 soft-cut。
 *
 * @module dsh-skill-quality-gate
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installSkillLintTurnEndPlugin } from '../scripts/skill-lint-turnend-plugin.mjs'

export const name = 'dsh-skill-quality-gate'
export const inject = ['skills']

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = join(PKG_DIR, '..', 'skills')

/** logger 拿不到时降级 console。 */
function makeLogger(ctx, tag) {
  return {
    info: (...args) => (ctx.logger?.info ? ctx.logger.info(...args) : console.log(tag, ...args)),
    warn: (...args) => (ctx.logger?.warn ? ctx.logger.warn(...args) : console.warn(tag, ...args))
  }
}

/** 极简 frontmatter 解析（name/description/whenToUse）。 */
function parseFrontmatter(md) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md)
  if (!match) return { name: undefined, description: undefined, whenToUse: undefined, body: md }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    if (key) meta[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '')
  }
  return { ...meta, body: md.slice(match[0].length) }
}

/** 从 skills/ 目录加载技能定义（文件缺失/无 frontmatter 时跳过并警告，绝不让插件挂载失败）。 */
function loadSkills(log) {
  const out = []
  if (!existsSync(SKILLS_DIR)) {
    log.warn('skills 目录缺失，技能未加载：' + SKILLS_DIR)
    return out
  }
  for (const file of readdirSync(SKILLS_DIR)) {
    if (!file.endsWith('.md')) continue
    try {
      const fm = parseFrontmatter(readFileSync(join(SKILLS_DIR, file), 'utf8'))
      if (!fm.name || !fm.description) {
        log.warn(`技能文件缺少 name/description frontmatter，已跳过：${file}`)
        continue
      }
      out.push({
        name: fm.name,
        description: fm.description,
        whenToUse: fm.whenToUse,
        body: fm.body
      })
    } catch (err) {
      log.warn(`技能文件读取失败，已跳过：${file}（${err?.message ?? err}）`)
    }
  }
  return out
}

export function apply(ctx) {
  const log = makeLogger(ctx, '[dsh-skill-quality-gate]')

  // 1) 注册随包运行期技能（契约：name/description/source/content 四必填）。
  for (const skill of loadSkills(log)) {
    ctx.effect(() => ctx.skills.register({
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
      source: 'runtime',
      content: skill.body
    }), `dsh-skill-quality-gate: register skill ${skill.name}`)
    log.info(`技能已注册：${skill.name}`)
  }

  // 2) turn/end 后置检查：改了 SKILL.md → 跑真实 linter → 缺口注入下一 turn（只提示不阻断）。
  ctx.effect(() => installSkillLintTurnEndPlugin(ctx), 'dsh-skill-quality-gate: turn/end lint controller')

  log.info('已挂载（技能 + turn/end 后置检查；脚本在 scripts/ 目录）')
}
