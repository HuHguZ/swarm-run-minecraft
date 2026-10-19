'use strict'
// Бой с драконом (dragon/pillar-run.ts): станция кроватей у фонтана — постройка и один шаг (дойти, опора, кровать,
// стенки, взрыв у головы сидящего).
import { gameClock, findItem, FILLER_RE, cloudsOf, dbg, isSolid, stepTo, PHASE, build, SITTING } from '../dig-down-to'
import { doing, r1 } from '../fall-guard'
import { countOf, sneakPlace, lookAtSafe } from '../evade-raw'
import { dynamicPlace, stationPlan, bedHere, stationPlaceBed, stationBlow } from '../station-plan'
import { headPoint } from '../pillar-plan'
import { hazardNow } from './sight-zones'
import { walkTo } from './walk'

async function stationBuild (session, ctl, st, stats) {
  const bot = session.bot
  let placed = 0; let failed = 0
  // Блоков нет — сразу сказать: без этого круг боя крутил станцию вхолостую
  if (countOf(bot, FILLER_RE) <= 4) return { placed, failed, noBlocks: true }
  for (const p of st.place) {
    if (ctl.aborted) break
    const b = bot.blockAt(p)
    if (b && isSolid(b)) continue
    const r = await sneakPlace(bot, p, { timeoutMs: 1500 })
    if (r.ok) placed++
    else { failed++; dbg('station place', p.toString(), r.reason); if (/нечем строить/.test(r.reason || '')) return { placed, failed, noBlocks: true } }
    if (hazardNow(bot)) break
  }
  stats.stationBlocks = (stats.stationBlocks || 0) + placed
  return { placed, failed }
}

async function stationStep (session, ctl, rep, stats, track, st, d, ph) {
  const bot = session.bot
  const me = bot.entity.position
  // Облако фаербола на станции (растёт 3 → 7 за 30 с) — не ходить туда, пока
  const lidded = c => c.pos.y >= st.B.y + 1.8
  if (cloudsOf(bot).some(c => !lidded(c) && Math.hypot(st.B.x - c.pos.x, st.B.z - c.pos.z) < c.r + 1.2 && Math.abs(c.pos.y - st.B.y) < 2)) return 'облако'
  const atB = Math.hypot(me.x - st.B.x, me.z - st.B.z) < 0.6 && Math.abs(me.y - st.B.y) < 0.6
  if (!atB) {
    doing(ctl, 'station:walk')
    const near = Math.hypot(me.x - st.B.x, me.z - st.B.z) < 4 && Math.abs(me.y - st.B.y) < 1.2
    const r = near ? await stepTo(bot, ctl, st.B, { ms: 2000, sprint: false, stopAt: 0.2 }) : await walkTo(session, ctl, st.B, { range: 0.4, timeoutMs: 20000 })
    // Не дошёл — помеха (фаербол, облако, эндермен, путь); станция негодна,
    if (!r.ok && Math.hypot(bot.entity.position.x - st.B.x, bot.entity.position.z - st.B.z) > 0.8) {
      st.walkFails = r.hazard || r.enderman ? (st.walkFails || 0) : (st.walkFails || 0) + 1
      return st.walkFails >= 3 ? 'fail' : 'помеха'
    }
    st.walkFails = 0
    await stepTo(bot, ctl, st.B, { ms: 700, sprint: false, stopAt: 0.12 })
    return 'дошёл'
  }
  // Блоки станции — взрыв кровати выбивает опору и верх стенок.
  const fresh = st.dynamic ? { ok: true, place: dynamicPlace(bot, st) } : stationPlan(bot, st.a)
  if (!fresh.ok) return 'fail'
  Object.assign(st, { place: fresh.place })
  const perch = ph === PHASE.LANDING || SITTING.has(ph) || ph === PHASE.TAKEOFF
  const hasBed = bedHere(bot, st)
  // Порядок: опора изножья (без неё кровать не положить) → кровать → стенки
  const buildList = async (list, what) => {
    doing(ctl, `station:${what}`)
    st.place = [...list].sort((p, q) => p.y - q.y || p.distanceTo(st.B) - q.distanceTo(st.B))
    const b = await stationBuild(session, ctl, st, stats)
    if (b.noBlocks) { stats.stationNoBlocks = true; return 'fail' }
    if (!b.placed && b.failed) st.buildFails = (st.buildFails || 0) + 1
    else if (b.placed) st.buildFails = 0
    return (st.buildFails || 0) >= 3 ? 'fail' : 'строю'
  }
  const support = fresh.place.filter(p => p.x === st.F.x && p.z === st.F.z)
  // Кривая кровать (изголовьем не туда, или половина) в клетках станции —
  // убрать: на её место новую не поставить, а щёлкать её — взрыв у самих нас.
  if (!hasBed) {
    for (const p of [st.F, st.H]) {
      const b = bot.blockAt(p)
      if (b && /_bed$/.test(b.name)) {
        doing(ctl, 'station:clear')
        try { await build.withTimeout(bot.dig(b, true), 2000) } catch (e) { dbg('station clear', e.message) }
        st.cleared = (st.cleared || 0) + 1
        return 'убрал кровать'
      }
    }
  }
  if (!hasBed && support.length) return buildList(support, 'support')
  if (!hasBed) {
    if (!findItem(bot, /_bed$/)) return 'кроватей нет'
    doing(ctl, 'station:bed')
    const r = await stationPlaceBed(bot, st)
    if (!r.ok) { st.bedFails = (st.bedFails || 0) + 1; dbg('station', r.why); if (st.bedFails >= 4) return 'fail' } else st.bedFails = 0
    return 'кровать'
  }
  // Стенки — пока летает; сидя — только высматривая (до огня ≥ 3 с), и только
  if (fresh.place.length) return buildList(fresh.place, 'build')
  if (perch) {
    const head = headPoint(bot, d, track, 2)
    const dist = head.distanceTo(st.blast)
    const was = st.lastDist
    st.lastDist = dist
    if (ctl.trace && (!st.headLog || gameClock.now() - st.headLog > 250)) {
      st.headLog = gameClock.now()
      ctl.trace.ev('head', { ph, dist: r1(dist), head: [r1(head.x), r1(head.y), r1(head.z)], d: [r1(d.position.x), r1(d.position.y), r1(d.position.z)], yaw: +d.yaw.toFixed(2) })
    }
    let go = null
    if (ph === PHASE.LANDING) {
      if (dist <= 2.0 || (was != null && dist > was && was <= 3.2)) go = 'садится'
    } else if (SITTING.has(ph)) {
      if (!st.sitSince) st.sitSince = gameClock.now()
      if (dist <= 3.2) go = 'сидит'
      else if (gameClock.now() - st.sitSince > 2500 && dist <= 4.5) go = 'сидит'
      // Готовая станция: ждать на месте — высматривая, дракон сам повернёт
      else if (st.dynamic && gameClock.now() - st.sitSince > 700 && dist > 4.5) { st.lastDist = null; st.sitSince = null; return 'далеко' }
      // не чистится — EnderDragon.aiStep не зовёт serverAiStep, и первое «не
      else if (gameClock.now() - st.sitSince > 1500) { st.lastDist = null; return 'далеко' }
    } else if (ph === PHASE.TAKEOFF) {
      if (dist <= 3.6) go = 'взлетает'
    }
    if (!SITTING.has(ph)) st.sitSince = null
    // Мало хп — не жать: за стенками взрыв снимает 0–0.4 (замер), но стенка
    // могла треснуть от прошлого взрыва так, что план этого не видит.
    if (go && bot.health >= 8) {
      await stationBlow(session, ctl, st, stats, d, track, go)
      st.lastDist = null
      return 'взрыв'
    }
    doing(ctl, 'station:wait')
    await lookAtSafe(bot, head)
    return 'жду голову'
  }
  st.lastDist = null
  return 'готово'
}

export { stationBuild, stationStep }
