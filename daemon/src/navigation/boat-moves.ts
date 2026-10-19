// Подъём «телепортом» через лодку (приём спидраннера, пользователь 14.10): лодка на видимую верхнюю грань уступа, посадка
// по прицелу — сервер ставит пассажира на место сиденья (у уступа), высадка — рядом с лодкой на уступе; лодку разбить и
// подобрать (не расходуется). Верхнюю грань выше глаз не видно, поэтому уступ — на 2 бл.: в прыжке глаза выше его грани.
// Цепочкой — по уступам, пока они есть; дальше столб или ступени (решает вызывающий по цене).
import { Vec3 } from 'vec3'
import * as clock from '../game-clock'
import pick = require('../pick')
import ride = require('../ride')
import { boatItem, boatBaseVisible, placeBoatOn, mountBoat } from '../combat/boat-placement'
import { breakBoatEntity } from '../combat/boat-hop'

type Body = Record<string, any>
type Ctl = { aborted: boolean; onAbort: Array<() => void> }
const log = (m: string) => { if (process.env.ND_DEBUG_BOAT) console.log('[boat-climb] ' + m) }

export interface ClimbStep { ok: boolean; why?: string; gained: number; sec: number; boatBack: boolean; hpLost: number; at?: { x: number; y: number; z: number } }

const boats = (bot: Body): number => bot.inventory.items().filter((i: Body) => /_(boat|raft)$/.test(i.name) && !/chest/.test(i.name)).reduce((n: number, i: Body) => n + i.count, 0)

/** Уступ для шага: стена высотой ровно 2 (верх на 2 выше ног) в 1–3 клетках по направлению dir (или рядом), по проступи до
 * неё — ровно; stand — откуда прыгать (клетка перед стеной, с простором для прыжка). */
export function climbLedge(bot: Body, dir: Vec3 | null = null): { base: Vec3; stand: Vec3 } | null {
  const f = bot.entity.position.floored()
  const empty = (p: Vec3) => { const a = bot.blockAt(p); return !!a && a.boundingBox === 'empty' && !/lava|water|fire/.test(a.name) }
  const solid = (p: Vec3) => { const a = bot.blockAt(p); return !!a && a.boundingBox === 'block' }
  const dirs = dir ? [dir] : [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  for (const d of dirs) {
    for (let k = 1; k <= 3; k++) {
      const col = f.offset(d.x * k, 0, d.z * k); const stand = f.offset(d.x * (k - 1), 0, d.z * (k - 1))
      if (empty(col) && empty(col.offset(0, 1, 0)) && solid(col.offset(0, -1, 0))) continue // проступь — дальше
      // Стена в 2: ноги и голова — твёрдое, выше — простор под лодку; над местом прыжка — простор.
      if (solid(col) && solid(col.offset(0, 1, 0)) && empty(col.offset(0, 2, 0)) && empty(col.offset(0, 3, 0)) && [2, 3].every(y => empty(stand.offset(0, y, 0)))) return { base: col.offset(0, 1, 0), stand }
      break
    }
  }
  return null
}

/** Один шаг: прыжок, лодка на грань уступа в верхней точке, посадка, высадка, лодку разбить и подобрать. */
export async function boatClimbStep(session: Body, ctl: Ctl, base: Vec3): Promise<ClimbStep> {
  const bot = session.bot
  const t0 = clock.now(); const y0 = bot.entity.position.y; const hp0 = bot.health ?? 20; const n0 = boats(bot)
  const done = (ok: boolean, why?: string): ClimbStep => ({ ok, why, gained: Math.round((bot.entity.position.y - y0) * 10) / 10, sec: Math.round((clock.now() - t0) / 100) / 10,
    boatBack: boats(bot) >= n0, hpLost: Math.max(0, hp0 - (bot.health ?? 0)), at: { x: base.x, y: base.y, z: base.z } })
  const item = boatItem(bot)
  if (!item) return done(false, 'no_boat')
  if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand')
  // К краю уступа лицом: середина своей клетки.
  const top = base.offset(.5, 1, .5)
  await bot.lookAt(top, true)
  // Прыжок; в верхней точке (глаза выше грани уступа) — лодка на грань.
  bot.setControlState('jump', true)
  let placed: Body | null | undefined = null
  try {
    for (let t = 0; t < 14 && !ctl.aborted && !placed; t++) {
      await clock.sleep(50)
      if (t === 1) bot.setControlState('jump', false)
      // В верхней точке прыжка (скорость вверх ~0): глаза выше грани уступа и на сервере (позиция приходит с тиком позже).
      const eye = pick.eyeOf(bot).y
      if (eye <= base.y + 1.3 || bot.entity.velocity.y > .08 || !boatBaseVisible(bot, base)) continue
      const aim = pick.faceAim(bot, base, new Vec3(0, 1, 0))
      const r = await placeBoatOn(session, ctl, { at: base, maxMs: 600 })
      log(`прыжок t${t}: ${JSON.stringify({ ok: r.ok, why: r.why, eye: eye.toFixed(2), vy: bot.entity.velocity.y.toFixed(3), aim: aim && [aim.x.toFixed(2), aim.y.toFixed(2), aim.z.toFixed(2)] })}`)
      if (r.ok) placed = r.boat
      else if (!/not visible|occupied/.test(String(r.why))) break
    }
  } finally { bot.setControlState('jump', false) }
  if (!placed) return done(false, 'boat_not_placed')
  // Опустились — посадка по прицелу (лодка в 3 бл. от глаз).
  for (let t = 0; t < 20 && !ctl.aborted && !bot.entity.onGround; t++) await clock.sleep(50)
  const m = await mountBoat(session, ctl, placed, { maxMs: 1500 })
  log(`посадка: ${JSON.stringify({ ok: m.ok, why: m.why, vehicle: !!bot.vehicle, y: bot.entity.position.y.toFixed(2) })}`)
  if (!m.ok) { await breakBoatEntity(session, ctl, placed.id, 2000); return done(false, 'mount: ' + m.why) }
  for (let k = 0; k < 3 && bot.vehicle && !ctl.aborted; k++) await ride.dismount(bot, 1500)
  log(`высадка: ${JSON.stringify({ vehicle: !!bot.vehicle, pos: bot.entity.position.toString() })}`)
  await breakBoatEntity(session, ctl, placed.id, 2500)
  try { await (require('../actions') as typeof import('../actions')).collectNearbyDrops(bot, ctl, { radius: 4, timeoutMs: 2500 }) } catch {}
  const up = bot.entity.position.y - y0
  return done(up >= 1.5 && !bot.vehicle, up >= 1.5 ? undefined : 'not_raised')
}

/** Подъём цепочкой до goalY (или пока есть уступы): шаги по 2 бл. */
export async function boatClimb(session: Body, ctl: Ctl, { toward = null, goalY = null, maxSteps = 8 }: { toward?: { x: number; z: number } | null; goalY?: number | null; maxSteps?: number } = {}): Promise<{ ok: boolean; steps: ClimbStep[]; gained: number; sec: number; why?: string }> {
  const bot = session.bot; const t0 = clock.now(); const y0 = bot.entity.position.y; const steps: ClimbStep[] = []
  for (let k = 0; k < maxSteps && !ctl.aborted; k++) {
    if (goalY !== null && bot.entity.position.y >= goalY - .2) break
    let dir: Vec3 | null = null
    if (toward) {
      const dx = toward.x - bot.entity.position.x; const dz = toward.z - bot.entity.position.z
      dir = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1)
    }
    const ledge = climbLedge(bot, dir) || (dir ? climbLedge(bot) : null)
    if (!ledge) return { ok: steps.length > 0, steps, gained: bot.entity.position.y - y0, sec: (clock.now() - t0) / 1000, why: steps.length ? 'no_more_ledges' : 'no_ledge' }
    // К месту прыжка вдоль проступи (крадучись — не сорваться с края).
    const at = ledge.stand.offset(.5, 0, .5)
    for (let t = 0; t < 40 && !ctl.aborted && Math.hypot(bot.entity.position.x - at.x, bot.entity.position.z - at.z) > .25; t++) {
      await bot.lookAt(new Vec3(at.x, bot.entity.position.y + 1.6, at.z), true)
      bot.setControlState('sneak', true); bot.setControlState('forward', true); await clock.sleep(50)
    }
    bot.clearControlStates()
    const s = await boatClimbStep(session, ctl, ledge.base)
    steps.push(s)
    if (!s.ok) return { ok: false, steps, gained: bot.entity.position.y - y0, sec: (clock.now() - t0) / 1000, why: s.why }
  }
  return { ok: true, steps, gained: bot.entity.position.y - y0, sec: (clock.now() - t0) / 1000 }
}

/**
 * Решение в goto: цель выше на 4+ и к ней уступы по 2 — сравнить пеший путь pathfinder'а (столб, прыжки, копка) с подъёмом
 * на лодке (замер try-lab-boat-climb 14.10: ~2.3 с на блок без блоков, столб — 0.8 с на блок, но тратит блоки и ставит на
 * столб, а не на уступ; goto по ступеням — ~4 с на блок). Лишний жемчуг — свой ход goto (hopgoto, резерв 12 на очи).
 */
export async function maybeAscend(session: Body, ctl: Ctl, goalXYZ: { x: number; y: number | null; z: number }, goal: unknown, opt: Record<string, any> = {}): Promise<Record<string, unknown>> {
  const bot = session.bot; const me = bot.entity?.position
  if (!me || !bot.entity.onGround || bot.entity.isInWater || process.env.ND_ASCENT_BOAT === '0' || !boatItem(bot)) return { used: null, why: 'нет лодки' }
  const gy = goalXYZ.y
  if (gy == null || gy - me.y < 4) return { used: null, why: 'цель не выше' }
  const dx = goalXYZ.x + .5 - me.x; const dz = goalXYZ.z + .5 - me.z
  const dir = Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx) || 1, 0, 0) : new Vec3(0, 0, Math.sign(dz) || 1)
  if (!climbLedge(bot, dir)) return { used: null, why: 'нет уступа' }
  const hopgoto: typeof import('../hopgoto') = require('../hopgoto')
  const walk = await hopgoto.planWalk(bot, goal, { ms: opt.planMs ?? 400, abortIf: () => ctl.aborted })
  const speed = bot.pathfinder?.movements?.allowSprinting ? hopgoto.RUN : hopgoto.WALK
  const tail = walk?.path?.length ? walk.path[walk.path.length - 1] : null
  const target = { x: goalXYZ.x + .5, y: gy, z: goalXYZ.z + .5 }
  const walkSec = walk && walk.status === 'success' ? hopgoto.pathSeconds(walk.path, me, { speed })
    : tail ? hopgoto.pathSeconds(walk.path, me, { speed }) + Math.hypot(tail.x - target.x, tail.y - target.y, tail.z - target.z) * 2 / speed
      : Math.hypot(me.x - target.x, me.y - target.y, me.z - target.z) * 3 / speed
  const rise = gy - me.y
  // Оценка A* для подъёма занижена: столб и прыжки pathfinder'а на деле ~3 с на блок высоты сверх оценки (лаборатория 14.10:
  // 6 бл. — оценка 7.6 с, на деле 23–35 с; 10 бл. — 18 с и 51–57 с).
  const walkReal = walkSec + 3 * rise
  const boatSec = rise * 2.3 + 1 + Math.hypot(dx, dz) / speed
  const line = `цель выше на ${rise.toFixed(1)}; пешком ~${walkReal.toFixed(1)} с (A* ${walkSec.toFixed(1)}, ${walk ? walk.status : 'пути нет'}); лодкой ~${boatSec.toFixed(1)} с`
  if (walkReal - boatSec < (opt.minGain ?? 3)) { console.log('[ascent] ' + line + ' — пешком'); return { used: null, why: 'мал выигрыш', walkSec, boatSec } }
  const r = await boatClimb(session, ctl, { toward: goalXYZ, goalY: gy })
  console.log('[ascent] ' + line + ` — лодкой: ${JSON.stringify({ ok: r.ok, gained: Math.round(r.gained * 10) / 10, sec: Math.round(r.sec * 10) / 10, steps: r.steps.length, why: r.why })}`)
  return { used: 'boat', walkSec, boatSec, ...r, steps: r.steps.length }
}
