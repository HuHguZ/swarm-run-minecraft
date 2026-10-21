'use strict'
import * as gameClock from '../game-clock'
import * as drops from '../drops'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz, stuckGuard, gotoPath } from '../movement'
import { walkable } from '../walkable'
import { itemNamed } from '../items'
import { raySees } from '../perception'
import { seesMob, ents, isRod, lavaNear, arrowsOnFloor, liveBlazes, watchers } from './targets'
import { hasEffect } from './potions'

// deep (ND_BLZ_ROD_SWEEP, blz 21.10): и стержни ниже ног до 12 бл. (упали с помоста трона на землю под ним), у лавы — только если
// лава в самой клетке или вплотную (1 бл.), а не в 3: стержни лежали «ещё N рядом» после боя в 1 из 3 боёв (убил 21 — подобрано 6,
// ещё 6 лежат; убил 9 — 0 и ещё 4), доля подобранных — 38 % вместо 50 % выпадения.
async function collectRods (bot, ctl, radius = 12, ms = 6000, { arrows = false, stopIf = null, deep = false }: any = {}) {
  const t0 = gameClock.now()
  let walks = 0
  const skip = new Set()
  // Опасность посреди вылазки (заряд, шар к нам) — бросить и назад: замер 20,
  // 14.5 хп за одну вылазку с опущенным щитом, смерть.
  const sub = { aborted: false, onAbort: [] }
  const watch = stopIf ? gameClock.setInterval(() => {
    if (!sub.aborted && (ctl.aborted || stopIf())) { sub.aborted = true; try { bot.pathfinder.setGoal(null) } catch {} }
  }, 100) : null
  if (!stopIf) ctl = ctl
  const outer = ctl
  ctl = stopIf ? { get aborted () { return outer.aborted || sub.aborted }, onAbort: outer.onAbort } : ctl
  try {
  while (!ctl.aborted && gameClock.now() - t0 < ms && walks < 6) {
    const me = bot.entity.position
    // Где стержень ляжет (drops.js): убитый блейз висит в воздухе, и mineflayer до
    // секунды показывает дроп там, а не на полу.
    const at = e => { try { return drops.restOf(bot, e) } catch { return e.position } }
    let rod: any = ents(bot)
      .filter((e : any) => e && e.name === 'item' && e.position && at(e).distanceTo(me) <= radius && isRod(e) && !skip.has(e.id))
      .filter((e : any) => { const p = at(e); if (p.y < me.y - (deep ? 12 : 3) || lavaNear(bot, p, deep ? 1 : 3)) { skip.add(e.id); return false } return true })
      .sort((a, b) => at(a).distanceTo(me) - at(b).distanceTo(me))[0]
    if (!rod && arrows) rod = arrowsOnFloor(bot, radius).filter((e : any) => !skip.has(e.id)).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    if (rod && rod.name === 'arrow') skip.add(rod.id)
    if (!rod) break
    walks++
    // Стержень — общим подбором (drops.pickOne): цель «рамка подбора касается предмета».
    // Прежний GoalNear(клетка, 1) считал дошедшим и в 1.45 от стержня при рамке 1.425 — и
    // шёл к тому же стержню до шести раз (ревью Codex, 29.09). Стрела — не предмет: к ней
    // по-прежнему шагом.
    const left = () => Math.max(1000, ms - (gameClock.now() - t0))
    const go = async (limit) => rod.name === 'item'
      ? (await drops.pickOne(bot, ctl, { id: rod.id, e: rod }, { timeoutMs: limit })) === 'picked'
      : (await walkNear(bot, ctl, rod.position.floored(), 1, limit)).ok
    const ok = await go(left())
    // Без копки не дойти (стержни в комнате спавнера на 3 блока выше коробки —
    // двойник мира прохождения, 2026-09-28: 15 убийств, 10 стержней лежат,
    // подобрано 0): ступеньку — прокопать. Боевые ходы (fightMoves) копать не
    // дают; на сбор — дают, на 6 с.
    if (!ok && !ctl.aborted && bot.entities[rod.id]) {
      const saved = bot.pathfinder.movements
      try {
        const { Movements }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
        const m = new Movements(bot)
        m.canDig = true
        m.allow1by1towers = false
        m.allowParkour = false
        m.allowSprinting = false
        m.maxDropDown = deep ? 4 : 3
        try { (require('../worlds') as typeof import('../worlds')).tuneMovements(bot, m) } catch {}
        bot.pathfinder.setMovements(m)
        const ok2 = await go(Math.min(6000, left()))
        if (!ok2) skip.add(rod.id)
      } finally { try { bot.pathfinder.setMovements(saved) } catch {} }
    }
    if (bot.entities[rod.id] && rod.name === 'item') skip.add(rod.id)
    await sleep(300)
  }
  } finally { if (watch) gameClock.clearInterval(watch) }
  return stopIf && sub.aborted ? -walks - 1 : walks
}

// Снежок в блейза с упреждением по его скорости (throw.js throwAt решает
// баллистику сам; здесь — только куда целить).
async function snowballAt (bot, blaze, track) {
  const snow = itemNamed(bot, 'snowball')
  if (!snow) return { thrown: false, why: 'снежков нет' }
  const { throwAt }: typeof import('../throw') = require('../throw')
  const fn = t => blaze.position.offset(0, 0.9, 0).plus(track.vel().scaled(t))
  return throwAt(bot, fn, { item: snow })
}

function makeTrack (e) {
  let last = null
  let v = new Vec3(0, 0, 0)
  return {
    update () {
      const now = gameClock.now()
      const p = e.position.clone()
      if (last) {
        const dt = (now - last.t) / 50
        if (dt > 0.5) v = p.minus(last.p).scaled(1 / dt)
      }
      last = { p, t: now }
    },
    vel: () => v
  }
}

function canApproachSpawner (bot, dead) {
  return hasEffect(bot, 'fire_resistance') || watchers(bot, dead) === 0
}
async function walkNear (bot, ctl, target, range, ms, { stopIf = null }: any = {}) {
  if (stopIf?.()) return { ok: false, error: 'на пути линия огня — сначала бой или укрытие' }
  const guard = stuckGuard(bot, ctl)
  let timer = null
  const path = gotoPath(bot, new goals.GoalNear(target.x, target.y, target.z, range))
  let stopped = false, release = null
  const changed = new Promise<void>(resolve => { release = resolve })
  const onTick = () => {
    if (!stopIf?.()) return
    stopped = true
    try { bot.pathfinder.setGoal(null) } catch {}
    path.cancel?.(); release?.()
  }
  if (stopIf) bot.on('physicsTick', onTick)
  try {
    await Promise.race([
      path,
      guard.promise,
      changed,
      new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), ms) })
    ])
    if (stopped) return { ok: false, error: 'на пути появилась линия огня — новый выбор боя или укрытия' }
    // goto «успешен» и на пустом пути (noPath длины 0, mineflayer-pathfinder
    // lib/goto.js) — дошёл, только если правда рядом.
    const d = bot.entity.position.distanceTo(new Vec3(target.x + 0.5, target.y, target.z + 0.5))
    return d <= range + 1.8 ? { ok: true } : { ok: false, error: 'пути нет' }
  } catch (e) {
    try { bot.pathfinder.setGoal(null) } catch {}
    return { ok: false, error: e.message }
  } finally {
    if (stopIf) bot.removeListener('physicsTick', onTick)
    path.cancel?.()
    guard.stop()
    if (timer) gameClock.clearTimeout(timer)
  }
}

// Где ни один из этих блейзов не видит: кольца от 5 до 22 блоков, 24
// направления, клетка, где можно стоять, без лавы в 2 блоках. Блейз, потерявший
// цель, подлетает только первые 5 тиков (BlazeAttackGoal lastSeen < 5) — за
// углом его шары не достают, и там можно отъесться.
function restSpots (bot, blazes, { min = 4, max = 24, want = 6, maxSeen = 0 }: any = {}) {
  const lava = bot.registry.blocksByName.lava.id
  const out: any = []
  // Только связанные с нами клетки (walkable.js): кольца точек находили
  // «укрытие» за стеной и на крыше арены — туда не дойти, и первый прогон
  // потратил все четыре отдыха на путь в никуда.
  const nodes = walkable(bot, bot.entity.position, { radius: max, maxNodes: 3000 })
  out.stats = { nodes: nodes.length, hot: 0, seen: 0 }
  for (const { pos, d } of nodes) {
    if (out.length >= want) break
    if (d < min) continue
    const r = d
    let hot = false
    for (let dx = -2; dx <= 2 && !hot; dx++) {
      for (let dy = -1; dy <= 1 && !hot; dy++) {
        for (let dz = -2; dz <= 2 && !hot; dz++) {
          const b = bot.blockAt(pos.offset(dx, dy, dz))
          if (b && b.type === lava) hot = true
        }
      }
    }
    if (hot) { out.stats.hot++; continue }
    const eye = pos.offset(0.5, 1.62, 0.5)
    let seen = 0
    for (const b of blazes) {
      if (raySees(bot, b.position.offset(0, 1.2, 0), eye) && ++seen > maxSeen) break
    }
    if (seen > maxSeen) { out.stats.seen++; continue }
    out.push({ pos, r, seen })
  }
  return out
}

// Не стоять под перекрёстным огнём: на ближайшую связанную клетку, откуда
// видно не больше одного блейза. Блейз, потерявший цель, подлетает 5 тиков и
// снова висит — из-за угла они выходят по одному, и меч достаёт их по очереди.
async function takeCover (bot, ctl, dead) {
  const blazes = liveBlazes(bot, dead, 40)
  const spots: any = restSpots(bot, blazes, { min: 2, max: 22, want: 4, maxSeen: 1 })
  for (const s of spots) {
    if (ctl.aborted) break
    await walkNear(bot, ctl, s.pos, 0, 10000)
    if (bot.entity.position.floored().distanceTo(s.pos) <= 1.5) return { at: xyz(s.pos), seen: watchers(bot, dead) }
  }
  return { at: null, why: spots.length ? 'до укрытия не дошёл' : 'укрытия рядом нет', blazes: blazes.length, ...spots.stats }
}

async function rest (session, ctl, dead, { until = 18, maxMs = 45000 }: any = {}) {
  const bot = session.bot
  const actions: typeof import('../actions') = require('../actions')
  const blazes = ents(bot).filter((e : any) => e && e.name === 'blaze' && e.position && e.isValid !== false &&
    !dead.has(e.id) && e.position.distanceTo(bot.entity.position) <= 48)
  const hp0 = Math.round(bot.health ?? 0)
  const spots = restSpots(bot, blazes)
  let at = null
  let tried = 0
  for (const s of spots.slice(0, 4)) {
    if (ctl.aborted) break
    tried++
    await walkNear(bot, ctl, s.pos, 0, 15000)
    // Свидетель — где тело стоит и видит ли его кто-то, а не «pathfinder
    // закончил»: он кончает и без пути.
    if (bot.entity.position.floored().distanceTo(s.pos) > 1.5) continue
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (blazes.some((b : any) => b.isValid !== false && raySees(bot, b.position.offset(0, 1.2, 0), eye))) continue
    at = s.pos
    break
  }
  if (!at) return { rested: false, why: spots.length ? `до укрытия не дошёл (пробовал ${tried})` : 'укрытия от блейзов рядом нет', hp: hp0 }
  const t0 = gameClock.now()
  let ate = null
  while (!ctl.aborted && gameClock.now() - t0 < maxMs && (bot.health ?? 0) < until) {
    if ((bot.food ?? 20) < 20) {
      try { const r = await actions.eat(session, {}); if (r && r.ate) ate = r.ate } catch {}
    }
    // Пришёл блейз — отдых кончился, дерёмся.
    const near = ents(bot).some((e : any) => e && e.name === 'blaze' && e.position && e.isValid !== false &&
      !dead.has(e.id) && e.position.distanceTo(bot.entity.position) <= 12 && seesMob(bot, e))
    if (near) break
    await sleep(1000)
  }
  const rested = !ctl.aborted && (bot.health ?? 0) >= until && (bot.food ?? 0) >= 18
  return { rested, why: rested ? undefined : 'за укрытием не восстановился', at: xyz(at), seconds: Math.round((gameClock.now() - t0) / 1000), hp: `${hp0} -> ${Math.round(bot.health ?? 0)}`, ate: ate || undefined }
}

export { collectRods, snowballAt, makeTrack, canApproachSpawner, walkNear, takeCover, rest }
