'use strict'
// Дуэль (huntDuel) — состояние охоты и действия над ним. Прежние `let` и стрелки замыкания huntDuel — поля объекта dh
// (DuelHunt); обзор и вышка — функции с dh первым аргументом. Шаги цикла — duel/steps.ts, оркестр — pearls/duel.ts.
import * as gameClock from '../../game-clock'
import { sleep } from '../../movement'
import { countOf } from '../../items'
import { towerUp } from '../../build'
import { clamp, log, meta, ents, digCell } from '../common'
import { clearRay, eyesSeen, lavaAround } from '../aim'
import { trappedEm } from '../shelter'

export interface DuelHunt {
  session: any
  ctl: any
  p: any
  bot: any
  t0: number
  deadline: number
  pearls0: number
  want: number
  hp0: number
  retreatAt: number
  rounds: any[]
  skip: Set<any>
  rests: any[]
  home0: any
  deadIds: Set<any>
  hurtAt: Map<any, number>
  onHurt: (e: any) => void
  onDead: (e: any, how?: any) => void
  onGone: (e: any) => void
  onMeHurt: (victim: any) => void
  pitchCap: number | null
  capPitch: () => void
  ignoreAngry: Map<any, number>
  safeSpot: (f: any) => boolean
  angryClose: (r: number) => boolean
  pickTarget: (all: any[], me: any) => any
  angryWait: number
  kills: number
  hpSpent: number
  stopped: any
  idle: number
}

// Начало охоты: состояние, подписки на события, ограничитель взгляда (прежнее начало huntDuel до цикла).
export function openDuel (session, ctl, p: any = {}): DuelHunt {
  const bot = session.bot
  const dh = { session, ctl, p, bot } as DuelHunt
  const combat: typeof import('../../combat') = require('../../combat')
  dh.t0 = gameClock.now()
  dh.deadline = dh.t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  dh.pearls0 = countOf(bot, 'ender_pearl')
  dh.want = dh.pearls0 + Math.max(1, p.count ?? 4)
  dh.hp0 = Math.round(bot.health ?? 20)
  dh.retreatAt = clamp(p.retreatAtHealth ?? 9, 4, 16)
  dh.rounds = []
  dh.skip = new Set()
  dh.rests = []
  dh.home0 = bot.entity.position.clone()
  // Убит — по смерти (entityDead) или пропаже в 12 блоках через <3 с после
  // нашего удара; «isValid false» бывает и у ушедшего телепортом (дуэль 4:
  // «убит» с двух взмахов).
  dh.deadIds = new Set()
  dh.hurtAt = new Map()
  dh.onHurt = e => { if (e && e.name === 'enderman') dh.hurtAt.set(e.id, gameClock.now()) }
  dh.onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || !e.position) return
    if (e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (dh.hurtAt.get(e.id) || 0) < 3000)) return
    dh.deadIds.add(e.id)
  }
  dh.onGone = e => dh.onDead(e, 'gone')
  bot.on('entityHurt', dh.onHurt)
  bot.on('entityDead', dh.onDead)
  bot.on('entityGone', dh.onGone)
  // Взгляд вниз всегда, кроме нарочного взгляда в глаза выбранному. Эндермен
  // злится на взгляд в глаза (EnderMan.isLookingAtMe: угол до его глаз меньше
  // acos(1 − 0.025/d) — 2.9° на 20 блоках), а тело ходило и дралось с pitch
  // около 0 и злило чужих: «второй злой» — в смертях дуэлей 1–7 (лаборатория
  // 2026-09-27); вблизи (< 4 бл.) взгляд в глаза ещё и телепортирует его прочь
  // посреди боя (EndermanLookForPlayerGoal.tick). В бою −20°: прицел на его
  // ногах и поясе (внутри его коробки до 3 блоков), до его глаз ≥ 30°.
  dh.onMeHurt = victim => {
    if (victim !== bot.entity) return
    const me = bot.entity.position
    const near = (Object.values(bot.entities) as any[]).filter((e : any) => e && e !== bot.entity && e.position && e.position.distanceTo(me) < 5 && e.type !== 'object' && e.name !== 'item')
      .map((e : any) => [e.name, e.id, Math.round(e.position.distanceTo(me) * 10) / 10, meta(bot, e, 'creepy') ? 1 : 0])
    log('удар по мне', { hp: Math.round((bot.health ?? 0) * 10) / 10, near })
  }
  bot.on('entityHurt', dh.onMeHurt)
  dh.pitchCap = -0.5
  dh.capPitch = () => { if (dh.pitchCap !== null && bot.entity && bot.entity.pitch > dh.pitchCap) bot.entity.pitch = dh.pitchCap }
  bot.on('physicsTick', dh.capPitch)
  dh.ignoreAngry = new Map()
  // Где драться можно: в 2 блоках вокруг нет обрыва глубже 3 (удар эндермена
  // отбрасывает — прогон 51: «fell from a high place»), лавы в 4 блоках нет
  // (прогон 51: «tried to swim in lava to escape Ghast»).
  dh.safeSpot = (f) => {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        let depth = 0
        for (let dy = -1; dy >= -5; dy--) {
          const b = bot.blockAt(f.offset(dx, dy, dz))
          if (!b) break
          if (/lava/.test(b.name)) return false
          if (b.boundingBox === 'block') break
          depth++
        }
        if (depth > 3) return false
      }
    }
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -3; dy <= 1; dy++) { const b = bot.blockAt(f.offset(dx, dy, dz)); if (b && /lava/.test(b.name)) return false }
    return true
  }
  dh.angryClose = r => ents(bot).some((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dh.deadIds.has(e.id) && meta(bot, e, 'creepy') && e.position.distanceTo(bot.entity.position) < r)
  // Кого злить (глаза видно строгим лучом отсюда): 6..28 блоков, рядом с ним
  // никого в 3 и злых в 16 (кроме застрявших), пиглинов в 10 нет, не в яме,
  // не дальше 64 от места старта.
  dh.pickTarget = (all, me) => all.filter(e => !dh.skip.has(e.id) && eyesSeen(bot, e))
    .filter(e => { const d = e.position.distanceTo(me); return d >= 6 && d <= 28 })
    .filter(e => !all.some(o => o !== e && (o.position.distanceTo(e.position) < 3 || (meta(bot, o, 'creepy') && !((dh.ignoreAngry.get(o.id) || 0) > gameClock.now()) && !trappedEm(bot, o) && o.position.distanceTo(e.position) < 16))))
    .filter(e => !ents(bot).some((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(e.position) < 10))
    .filter(e => e.position.distanceTo(dh.home0) < 64 && !trappedEm(bot, e))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0] || null
  dh.angryWait = 0
  dh.kills = 0
  dh.hpSpent = 0
  dh.stopped = null
  dh.idle = 0
  return dh
}

// Конец охоты (прежние отписки после цикла huntDuel).
export function closeDuel (dh: DuelHunt) {
  const { bot } = dh
bot.removeListener('entityHurt', dh.onHurt)
bot.removeListener('entityDead', dh.onDead)
bot.removeListener('entityGone', dh.onGone)
bot.removeListener('physicsTick', dh.capPitch)
bot.removeListener('entityHurt', dh.onMeHurt)
}

// Откуда видно больше глаз: заливка «куда дойду» (24), каждая третья клетка
// (до 200), луч от глаз клетки к глазам эндерменов 6..28 — как в pillarUp.
export function duelVantage (dh: DuelHunt, all) {
  const { bot } = dh
  const { walkable }: typeof import('../../walkable') = require('../../walkable')
  const nodes = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 3000 })
  const ems = all.filter(e => !dh.skip.has(e.id) && !trappedEm(bot, e) && e.position.distanceTo(dh.home0) < 64)
  if (!ems.length) return null
  let best = null
  let checked = 0
  for (let i = 0; i < nodes.length && checked < 200; i += 3) {
    const n = nodes[i]
    if (n.d < 3) continue
    if (!dh.safeSpot(n.pos)) continue
    checked++
    const eye = n.pos.offset(0.5, 1.62, 0.5)
    let seen = 0
    for (const e of ems) {
      const d = e.position.distanceTo(eye)
      if (d < 6 || d > 28) continue
      if (clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++
    }
    const score = seen * 10 - n.d * 0.2
    if (seen && (!best || score > best.score)) best = { pos: n.pos, seen, score, d: n.d }
  }
  return best ? { ...best, checked } : null
}

export async function duelLookout (dh: DuelHunt) {
  const { bot, ctl, session } = dh
  const feet = bot.entity.position.floored()
  const res: any = {}
  if (dh.angryClose(10)) return { why: 'злой рядом' }
  for (let y = 2; y <= 5; y++) { const b = bot.blockAt(feet.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || /lava|water/.test(b.name)) return { why: 'над головой нет 4 блоков воздуха' } }
  if (lavaAround(bot, feet) || lavaAround(bot, feet.offset(0, -1, 0))) return { why: 'лава рядом' }
  try { await (require('../../fortify') as typeof import('../../fortify')).centerInCell(bot, 600) } catch {}
  const up = await towerUp(bot, ctl, 3)
  res.placed = up.placed || 0
  const top = bot.entity.position.floored()
  if (top.y - feet.y >= 2) {
    let target = null
    for (let k = 0; k < 4 && !target && !ctl.aborted && !dh.angryClose(6); k++) {
      const all2 = ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false)
      target = dh.pickTarget(all2, bot.entity.position)
      if (k === 0) { const me3 = bot.entity.position; const inR = all2.filter((e : any) => { const d = e.position.distanceTo(me3); return d >= 6 && d <= 28 }); res.inRange = inR.length; clearRay.stats = {}; res.eyesTop = inR.filter(e => eyesSeen(bot, e)).length; res.blockedBy = clearRay.stats; res.y = Math.round(me3.y) }
      if (!target) { try { await bot.look(bot.entity.yaw + Math.PI / 2, -0.5, true) } catch {} ; await sleep(600) }
      else res.eyes = all2.filter(e => eyesSeen(bot, e)).length
    }
    if (target) {
      res.from = Math.round(target.position.distanceTo(bot.entity.position))
      dh.pitchCap = null
      const tA = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tA < 5000 && !meta(bot, target, 'creepy') && target.isValid !== false) {
        if (eyesSeen(bot, target)) await bot.lookAt(target.position.offset(0, 2.55, 0), true).catch(() => {})
        await sleep(100)
      }
      dh.pitchCap = -0.5
      res.angry = !!meta(bot, target, 'creepy')
      if (!res.angry) dh.skip.add(target.id)
    }
  } else res.why = `столб не вышел: ${up.reason || ''}`
  // Вниз: свой столб из-под ног (блоки — в рюкзак).
  for (let i = 0; i < 5 && !ctl.aborted; i++) {
    const f = bot.entity.position.floored()
    if (f.y <= feet.y) break
    const e2 = await digCell(bot, session.mcData, f.offset(0, -1, 0))
    if (e2) { res.down = e2; break }
    await sleep(300)
  }
  try { await bot.look(bot.entity.yaw, -0.5, true) } catch {}
  return res
}

// Итог охоты (прежний хвост huntDuel).
export function duelReport (dh: DuelHunt) {
  const { bot } = dh
const pearls = countOf(bot, 'ender_pearl')
const secs = Math.round((gameClock.now() - dh.t0) / 1000)
const detail: any = {
  mode: 'hunt',
  style: 'дуэль',
  pearls: { before: dh.pearls0, now: pearls, gained: pearls - dh.pearls0, want: dh.want },
  kills: dh.kills,
  hpPerKill: dh.kills ? Math.round(dh.hpSpent / dh.kills * 10) / 10 : null,
  killsPerHour: secs ? Math.round(dh.kills * 3600 / secs) : 0,
  rests: dh.rests.length ? dh.rests : undefined,
  rounds: dh.rounds.slice(-10),
  hpLost: Math.max(0, dh.hp0 - Math.round(bot.health ?? 0)),
  seconds: secs
}
if (pearls < dh.want) {
  detail.need = { what: 'ender_pearl', count: dh.want - pearls, have: pearls }
  detail.stopped = `${dh.stopped || 'встал'} — жемчуга ${pearls} из ${dh.want} (убил ${dh.kills})`
}
detail.note = `Жемчуг +${detail.pearls.gained}, убито ${dh.kills} за ${secs} с, хп на убийство ${detail.hpPerKill}.`
return detail
}
