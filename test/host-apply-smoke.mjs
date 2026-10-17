/**
 * host-apply-smoke.mjs —— 不起宿主，用假 ctx 验证 lib/index.js 的 apply：
 *   1) skill-authoring 技能经 ctx.skills.register 注册；
 *   2) turn/end 控制器挂上 session/event 与 agent/pre-step；
 *   3) 走一遍 turn/start → tool/call(edit 缺陷 SKILL.md) → turn/end → pre-step，
 *      下一 turn 的 decision.messages 必须含具体 FAIL 缺口。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../lib/index.js'

const failures = []
const handlers = new Map()
const registered = []

const ctx = {
  logger: { info() {}, warn(...a) { failures.push('插件 warn: ' + a.join(' ')) } },
  effect(fn, label) {
    const disposer = fn()
    if (typeof disposer !== 'function') failures.push('effect 未返回卸载函数: ' + label)
    return disposer
  },
  skills: {
    register(def) {
      registered.push(def)
      return () => {}
    }
  },
  on(event, cb) {
    const list = handlers.get(event) ?? []
    list.push(cb)
    handlers.set(event, list)
    return () => {}
  }
}

apply(ctx)

if (name !== 'dsh-skill-quality-gate') failures.push('导出名不符: ' + name)
const skillDef = registered.find((d) => d.name === 'skill-authoring')
if (!skillDef) failures.push('skill-authoring 未注册')
if (skillDef && !/覆盖矩阵/.test(skillDef.content)) failures.push('技能正文异常（缺覆盖矩阵）')
if (!handlers.has('session/event')) failures.push('未挂 session/event')
if (!handlers.has('agent/pre-step')) failures.push('未挂 agent/pre-step')

// 构造缺陷 SKILL.md 并模拟一整个 turn。
const dir = mkdtempSync(join(tmpdir(), 'qg-host-smoke-'))
const bad = join(dir, 'SKILL.md')
writeFileSync(bad, '---\nname: p\ndescription: 短\n---\n# P\n\n**PB-R1 x**\n- 做法：z', 'utf8')

const emit = (event) => handlers.get('session/event').forEach((cb) => cb({}, event))
emit({ type: 'turn/start', data: { turn: 1 } })
emit({ type: 'tool/call', data: { name: 'edit', arguments: JSON.stringify({ file_path: bad }) } })
emit({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

let injected
const pre = handlers.get('agent/pre-step')[0]
await pre({ turn: 2, step: 1 }, async () => ({ kind: 'enter', messages: [] })).then((d) => { injected = d })

if (!injected || !Array.isArray(injected.messages) || injected.messages.length === 0) {
  failures.push('下一 turn 未注入消息')
} else {
  const text = JSON.stringify(injected.messages)
  if (!/FAIL /.test(text)) failures.push('注入消息不含 FAIL 缺口行')
  if (!/skill-lint 后置检查/.test(text)) failures.push('注入消息缺检查抬头')
}

rmSync(dir, { recursive: true, force: true })

if (failures.length === 0) {
  console.log('HOST-APPLY SMOKE PASS: 技能注册 + 钩子挂载 + 缺口注入全链路成立')
  process.exit(0)
}
console.log('HOST-APPLY SMOKE FAIL:')
for (const f of failures) console.log('  - ' + f)
process.exit(1)
