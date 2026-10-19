'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { xyz, stuckGuard, gotoPath } from '../movement'
import * as worlds from '../worlds'
import { sleep, bore } from './dig'

// Бьют по дороге — ответить, а не идти дальше: эндермен, разозлённый взглядом
// по пути, убил тело за 10 с, пока разведка шла следующим отрезком
// (try-nether-trip 2026-09-25, «slain by Enderman»; автопилот в намерении
// молчит). run(sub) — отрезок под своим ctl, который рвётся на удар живого
// врага в 6 блоках (combat.liveAttacker); дальше бой с ним и еда.
async function guarded (session, ctl, run) {
  const bot = session.bot
  const combat: typeof import('../combat') = require('../combat')
  const sub = { aborted: false, onAbort: [] }
  let hitBy = null
  const cut = () => {
    if (sub.aborted) return
    sub.aborted = true
    for (const fn of sub.onAbort) { try { fn() } catch {} }
  }
  const onHurt = victim => {
    if (victim !== bot.entity || hitBy) return
    const a = combat.liveAttacker(session)
    if (!a || !a.position || a.position.distanceTo(bot.entity.position) > 6) return
    // The session reflex pauses goto and resumes it. The old local cut/return
    // would abort that same step and initiate a second defence on top of it.
    if (worlds.worldOf(bot) === 'the_nether' && (require('../reflex-lock') as typeof import('../reflex-lock')).on() && /^(piglin|piglin_brute|hoglin|zoglin|zombified_piglin|wither_skeleton|magma_cube|zombie|husk|vindicator)$/.test(a.name || '')) return
    hitBy = a
    cut()
  }
  const relay = gameClock.setInterval(() => { if (ctl.aborted) cut() }, 200)
  // Взгляд в пол на ходу (только Ад). pathfinder идёт с pitch 0
  // (mineflayer-pathfinder index.js: bot.look(yaw, 0)), а эндермен злится, если
  // игрок смотрит ему в глаза: EnderMan.isLookingAtMe — dot > 1 - 0.025/d, то
  // есть на 20 блоках допуск 2.9°, а его глаза на 0.93 выше наших — 2.7°.
  // Идя по ровному на эндермена в 15–60 блоках, тело злит его само (прогоны
  // 2026-09-25: дважды «slain by Enderman» / падение в лаву в бою с ним).
  // Направление шага задаёт только yaw; pitch ниже -0.6 (≈34° вниз) правим
  // после pathfinder'а в том же тике, до отправки позиции (physics.js).
  const inNether = worlds.worldOf(bot) === 'the_nether'
  const lookDown = () => { if (!session.reflex && bot.entity && bot.entity.pitch > -0.6) bot.entity.pitch = -0.6 }
  if (inNether) bot.on('physicsTick', lookDown)
  bot.on('entityHurt', onHurt)
  let r
  try { r = await run(sub) } finally {
    gameClock.clearInterval(relay)
    bot.removeListener('entityHurt', onHurt)
    if (inNether) bot.removeListener('physicsTick', lookDown)
  }
  if (!hitBy || ctl.aborted) return r
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
  // Эндермена — на месте, без погони: он телепортируется, и погоня за ним по
  // краю обрыва кончилась падением в лавовое море (прогон 4, 2026-09-25). Он
  // сам подходит бить — меч встречает его в упор.
  // ND_GUARD=1: брут/хоглин/зоглин/иссушитель (или злых трое, хп < 9) — не бой на земле, а яма на 2 вниз/столб (ne-guard).
  if (process.env.ND_GUARD !== '0' && hitBy.name !== 'enderman') {
    const G: typeof import('../ne-guard') = require('../ne-guard')
    const foes = G.meleeFoes(bot, 6)
    if (G.HIDE_FROM.test(hitBy.name || '') || foes.length >= 3 || (bot.health ?? 20) < 9) {
      const rr = await G.react(session, ctl, { force: { e: hitBy, why: 'удар ' + hitBy.name } })
      return { ...(r || {}), ok: false, fought: { with: hitBy.name, won: !!rr.killed, hp: Math.round(bot.health ?? 0), how: rr.how }, error: `по дороге напал ${hitBy.name} — ${rr.how || 'ответ'}` }
    }
  }
  const f = hitBy.name === 'enderman'
    ? await standAndSwing(session, ctl, hitBy, 25000)
    : await combat.fight(session, ctl, { target: '#' + hitBy.id, timeoutSeconds: 30, retreatAtHealth: 5, clearArea: 0 })
      .catch(e => ({ error: String(e.message || e) }))
  if ((bot.food ?? 20) < 18 && !ctl.aborted) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} }
  const won = !!(f.killed || (f.kills && f.kills.length))
  console.log('[nether] ответил', JSON.stringify({ to: hitBy.name, won, hp: Math.round(bot.health ?? 0), why: f.error || f.stopped }))
  return {
    ...(r || {}),
    ok: false,
    fought: { with: hitBy.name, won, hp: Math.round(bot.health ?? 0) },
    error: `по дороге напал ${hitBy.name} — ${won ? 'убил' : `бой без победы${f.error ? `: ${f.error}` : ''}`}`
  }
}

async function standAndSwing (session, ctl, mob, ms) {
  const bot = session.bot
  const { bestWeapon }: typeof import('../items') = require('../items')
  const w = bestWeapon(bot)
  if (w) { try { await bot.equip(w, 'hand') } catch {} }
  try { bot.clearControlStates() } catch {}
  const t0 = gameClock.now()
  let swings = 0
  let last = 0
  while (!ctl.aborted && gameClock.now() - t0 < ms && mob.isValid !== false && bot.entities[mob.id]) {
    if ((bot.health ?? 0) <= 5) return { stopped: `хп ${Math.round(bot.health ?? 0)}`, swings }
    const d = mob.position.distanceTo(bot.entity.position)
    if (d <= 3.2 && gameClock.now() - last >= 650) {
      try { await bot.lookAt(mob.position.offset(0, 1.0, 0), true); bot.attack(mob); swings++; last = gameClock.now() } catch {}
    }
    await sleep(60)
  }
  const gone = mob.isValid === false || !bot.entities[mob.id]
  return { killed: gone && swings > 0 ? mob.name : undefined, swings, stopped: gone ? undefined : 'не подошёл' }
}

// До записанного портала своего мира, если он дальше, чем видно.
async function walkToward (session, ctl, target, deadline, { range = 3, xz = false }: any = {}) {
  const bot = session.bot
  const { travelXZ }: typeof import('../movement') = require('../movement')
  // Издалека — отрезками по 24 блока по прямой, со сдвигом вбок, если прямо
  // не пройти: одним GoalNear на 290 блоков по Аду pathfinder отвечает «No
  // path to the goal!» за 5 с поиска (try-nether-trip, 2026-09-25), а
  // отрезками тот же рельеф проходится.
  let side = 0
  let fails = 0
  let dug = 0
  while (!ctl.aborted && gameClock.now() < deadline) {
    const me = bot.entity.position
    const dx = target.x - me.x
    const dz = target.z - me.z
    const dist = Math.hypot(dx, dz)
    if (dist <= 24) break
    const ux = dx / dist
    const uz = dz / dist
    const tx = Math.round(me.x + ux * 24 - uz * side)
    const tz = Math.round(me.z + uz * 24 + ux * side)
    const w = await guarded(session, ctl, sub => travelXZ(bot, sub, tx, tz, { range: 3, retries: 1, deadline: Math.min(deadline, gameClock.now() + 40000) }))
    if (w.fought && (bot.health ?? 0) < 8) return { ok: false, error: w.error, fought: w.fought }
    if (w.ok || w.fought) { side = 0; fails = 0; continue }
    // Два обхода не вышло — штрек прямо к порталу (на его высоту) на 16 шагов.
    if (fails >= 2) {
      const b = await bore(session, ctl, { x: Math.round(target.x), z: Math.round(target.z) }, {
        deadline: Math.min(deadline, gameClock.now() + 45000), maxSteps: 16, minY: target.y, maxY: target.y, throughBricks: true
      })
      dug += b.dug
      if (b.moved >= 4) { side = 0; fails = 0; continue }
    }
    if (++fails > 6) return { ok: false, error: w.error, dug: dug || undefined }
    side = side <= 0 ? -side + 8 : -side
  }
  const last = async () => {
    const guard = stuckGuard(bot, ctl)
    let timer = null
    const path = gotoPath(bot, xz ? new goals.GoalNearXZ(target.x, target.z, range) : new goals.GoalNear(target.x, target.y, target.z, range))
    try {
      await Promise.race([
        path,
        guard.promise,
        new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), Math.max(1000, Math.min(60000, deadline - gameClock.now()))) })
      ])
      const p1 = bot.entity.position
      if ((xz ? Math.hypot(p1.x - target.x, p1.z - target.z) : p1.distanceTo(new Vec3(target.x, target.y, target.z))) > range + 3) return { ok: false, error: 'pathfinder не нашёл ни шага к цели' }
      return { ok: true }
    } catch (e) {
      try { bot.pathfinder.setGoal(null) } catch {}
      return { ok: false, error: e.message }
    } finally {
      path.cancel?.()
      guard.stop()
      if (timer) gameClock.clearTimeout(timer)
    }
  }
  const r = await last()
  // Цель высоко над нами (портал на 19 блоков выше, кампания 2026-09-28, 14:09):
  // pathfinder без столба 1x1 в Аду подъёма не находит («Took to long to decide
  // path», а goto отвечал «done» без шага). Подняться лестницей штрека (bore:
  // ступенька вверх на каждый шаг, пока ниже maxY) в ту сторону, где места
  // больше, — прочь от цели, чтобы хватило длины, — и снова к цели.
  if (!r.ok && !xz && Number.isFinite(target.y) && target.y - bot.entity.position.y > 3 && !ctl.aborted && gameClock.now() < deadline - 15000) {
    const f = bot.entity.position.floored()
    const up = Math.ceil(target.y - f.y)
    const tries = []
    for (const [sx, sz] of [[Math.sign(f.x - target.x) || 1, 0], [0, Math.sign(f.z - target.z) || 1], [-(Math.sign(f.x - target.x) || 1), 0], [0, -(Math.sign(f.z - target.z) || 1)]]) {
      if (ctl.aborted || bot.entity.position.y >= target.y - 1) break
      const b = await bore(session, ctl, { x: f.x + sx * (up + 12), z: f.z + sz * (up + 12) }, {
        deadline: Math.min(deadline - 5000, gameClock.now() + 60000), maxSteps: up + 4, maxY: Math.floor(target.y), throughBricks: true
      })
      tries.push({ dir: [sx, sz], moved: b.moved, y: Math.floor(bot.entity.position.y), why: b.why })
      if (bot.entity.position.y >= target.y - 1) break
    }
    console.log('[nether] подъём к цели', JSON.stringify({ target: xyz(target), tries }))
    if (bot.entity.position.y >= target.y - 2) {
      const r2 = await walkToward(session, ctl, target, deadline, { range, xz })
      return { ...r2, climbed: tries }
    }
    return { ...r, climbed: tries }
  }
  return r
}

export { guarded, walkToward }
