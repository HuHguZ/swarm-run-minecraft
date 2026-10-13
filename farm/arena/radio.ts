'use strict'
// Рация отряда и чат бойцов: просьбы «нужно: …», вызовы «прикройте», кто из бойцов жив.
import { ALCHEMY } from './gear'
import type { ArenaContext } from './context'

export function installRadio (ctx: ArenaContext) {
  const { i, teams, bots, pos, deadNow, out, radio, rcon, log } = ctx
  // Просьба вслух — в чат (видно зрителю): новая нужда, не чаще раза в 30 с на бойца.
  const asked: Record<string, number> = {}
  const announce = setInterval(() => {
    if (!teams) return
    for (const b of bots) {
      // Вслух — не чаще раза в 30 с (гонка 10.10: 1008 строк «нужно:» за 4 минуты — спам).
      const need = ctx.needOf(pos[b.name]); if (!need || deadNow.has(b.name) || out.has(b.name) || ctx.between) continue
      if ((asked[b.name] || 0) > Date.now()) continue
      asked[b.name] = Date.now() + 30000
      const ru = ALCHEMY.test(need.item) ? 'для зелий ' + need.item : { оружие: 'оружие', еда: 'еда', golden_apple: 'золотое яблоко', splash_potion: 'зелье лечения', cobblestone: 'блоки', 'броня:head': 'шлем', 'броня:torso': 'нагрудник', 'броня:legs': 'поножи', 'броня:feet': 'ботинки' }[need.item]
      ctx.tell(b, `[${b.team === 'red' ? 'красные' : 'синие'}] нужно: ${ru}`)
    }
  }, 2000)
  const help: Record<string, number> = {}
  // Чат бойцов — сообщением сервера (tellraw), не чатом бота: чат игрока рвёт задачи всех демонов (interruptOn 'chat' —
  // это для человека), и рация отряда срывала сундуки: 220 «interrupted» за минуту (гонка 10.10).
  // В чат игры — только с ARMS_CHAT=1 (10.10: «бесит спам в чате»); журнал гонки пишет всё равно.
  ctx.tell = (b, text) => process.env.ARMS_CHAT !== '1' ? null : rcon(i, `tellraw @a ${JSON.stringify({ text: `<${b.name}> ${text}`, color: b.team === 'red' ? 'red' : b.team === 'blue' ? 'aqua' : 'white' })}`).catch(() => {})
  // ---------------------------------------------------------------- рация отряда
  // 10.10: «команды друг другу как в CS — прикрой, за мной, помогите; группироваться сразу и атаковать толпой».
  // Отряды по 4 (порядок в команде), лидер — сильнейший живой (держится, пока жив). Вызовы:
  //  help  — «нужна помощь»: врагов рядом сильнее, чем нас (power), отвечают ближайшие свободные (не в ближнем бою), сколько
  //          нужно, чтобы сравнять число, и кто успеет за время вызова; cover — то же, когда бойца сорвали с лута;
  //  gather — лидер «за мной»: ждёт снаряжённых своих, пока добегут (срок — время пути дальнего + 2 с), потом атака;
  //  фокус — цель лидера бьёт весь отряд («в атаку на …»). Пороги — во времени пути (SPRINT), не в блоках.
  const saidAt: Record<string, number> = {}
  ctx.short = (n) => String(n).replace('NeuroFarm', '')
  ctx.alive = (n) => !!(pos[n]?.p && pos[n].hp > 0 && !deadNow.has(n) && !out.has(n))
  ctx.radioSay = (b, text) => {
    log(`📻 ${b.name}: ${text}`)
    if ((saidAt[b.name] || 0) > Date.now()) return
    saidAt[b.name] = Date.now() + 4000
    ctx.tell(b, `[${b.team === 'red' ? 'красные' : 'синие'}] ${text}`)
  }
  ctx.callout = (b, kind, data, ttl, text) => {
    const k = `${b.name}:${kind}`; const was = radio[k]
    const fresh = !was || was.until < Date.now() || was.foe !== data.foe
    radio[k] = { kind, from: b.name, team: b.team, until: Date.now() + ttl, ans: fresh ? new Set() : was.ans, t0: fresh ? Date.now() : was.t0, ...data }
    if (fresh) ctx.radioSay(b, text)
  }
  return announce
}
