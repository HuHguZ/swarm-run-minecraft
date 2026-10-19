'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz } from '../movement'
import { seesBlock } from '../sight'
import * as worlds from '../worlds'
import { PLACE, log, look, rememberSpawner, placeOf } from './look'
import { legTo, keepBlocks, climbTo, climbWalk } from './legs'

// S1f: куда звать «пирог» и слух на обходе (вслепую): дуга спавнера в прорисовке (64 бл., F3) — пеленг; ифрит слышен (16 бл.,
// сторона по субтитру) — туда. Точка — leg бл. по направлению на высоте тела. null — подсказки нет.
function spawnerHint (bot, { leg = 20, skipYaws = [] }: any = {}) {
  const S: typeof import('../perception/senses') = require('../perception/senses')
  const me = bot.entity.position
  const arc = S.pieArcs(bot, 'spawner', { fov: 30 }).find(a => a.center !== null && !skipYaws.some(y => Math.abs(((a.center - y + 540) % 360) - 180) < 20))
  if (arc) { const v = S.vecOf(arc.center); return { x: Math.round(me.x + v.x * leg), z: Math.round(me.z + v.z * leg), by: 'пирог', yaw: arc.center, width: arc.width } }
  const h = S.heard(bot, { sinceMs: 6000, match: /blaze/ })[0]
  if (h) { const p = S.hearPoint(bot, h); if (p) return { x: Math.round(p.x), z: Math.round(p.z), by: 'слух', dir: h.dir8, band: h.band } }
  return null
}

/** Ход вдоль моста: ось — больший разброс видимого кирпича в 16 бл. от ног, конец отрезка (24 бл.) — дальше от остановок (≥ 12). */
function axisLeg (pool, feet, visited, len = 24) {
  const near = pool.filter(p => Math.hypot(p.x - feet.x, p.z - feet.z) <= 16)
  if (near.length < 3) return null
  const spread = k => Math.max(...near.map(p => p[k])) - Math.min(...near.map(p => p[k]))
  const axis = spread('x') >= spread('z') ? 'x' : 'z'
  const far = p => visited.length ? Math.min(...visited.map(q => Math.hypot(p.x - q.x, p.z - q.z))) : Infinity
  const ends = [len, -len].map(d => axis === 'x' ? { x: feet.x + d, z: feet.z, axis } : { x: feet.x, z: feet.z + d, axis })
  const best = ends.reduce((a, b) => (far(b) > far(a) ? b : a))
  return far(best) >= 12 ? best : null
}

// Один кирпич памяти не задаёт ось моста. От закрытого взгляда сначала шаг
// на видимый пол с местом для тела, затем новый взгляд: никаких целей за стеной.
// One observed adjacent deck cell at a time; memory is committed only after actual arrival.
function deckLeg (bot, state: any) {
  if (typeof bot.blockAt !== 'function') return null // макет без мира (тест прогресса обхода) — прежний подъём/обзор
  const at = bot.entity.position.floored()
  const key = p => [p.x, p.y, p.z].join(',')
  const near = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.z - b.z) === 1 && Math.abs(a.y - b.y) <= 1
  state.seen ||= new Set(); state.blocked ||= new Set(); state.stack ||= []
  if (state.pending) {
    const last = state.pending
    if (at.equals(last.to)) { if (last.back) state.stack.pop(); else state.stack.push(last.from) }
    else state.blocked.add(key(last.to))
    state.pending = null
  }
  const open = b => b && seesBlock(bot, b) && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name)
  const deck = p => {
    const floor = bot.blockAt(p.offset(0, -1, 0))
    return floor && seesBlock(bot, floor) && floor.name === 'nether_bricks' && floor.boundingBox === 'block' &&
      open(bot.blockAt(p)) && open(bot.blockAt(p.offset(0, 1, 0)))
  }
  if (!deck(at)) return null
  state.seen.add(key(at))
  let to = null, back = false
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    for (const dy of [0, 1, -1]) {
      const q = at.offset(dx, dy, dz)
      if (state.seen.has(key(q)) || state.blocked.has(key(q)) || !deck(q)) continue
      if (dy === 1 && !open(bot.blockAt(at.offset(0, 2, 0)))) continue
      to = q; break
    }
    if (to) break
  }
  if (!to) {
    const parent = state.stack[state.stack.length - 1]
    if (!parent || !near(at, parent) || state.blocked.has(key(parent)) || !deck(parent)) return null
    to = parent; back = true
  }
  state.pending = { from: at, to, back }
  return { floor: to.offset(0, -1, 0), back }
}

function continuationSupply (bot) {
  const picks: Record<string,number> = {}
  for (const i of bot.inventory?.items() || []) if (/pickaxe$/.test(i.name)) {
    const max = i.maxDurability || bot.registry?.itemsByName?.[i.name]?.maxDurability
    picks[i.name] = (picks[i.name] || 0) + (max ? Math.max(0,max-(i.durabilityUsed || 0)) : 1) * i.count
  }
  return { blocks:(require('../sealed') as typeof import('../sealed')).fillerCount(bot),picks }
}

// The local visible floor is only one route: remembered brick and a straight
// bridge row can justify opening the next section, never its hidden contents.
function continuationPlan (session, v: any = {}) {
  if (process.env.ND_FORTRESS_CONTINUE === '0') return null
  const bot = session.bot, me = bot.entity.position, here = worlds.worldOf(bot)
  const frontier = session._ndFortressFrontier
  if (here !== 'the_nether' || frontier?.world !== here) return null
  const vec = k => new Vec3(...(String(k).replace(/[()]/g,'').split(',').map(Number) as [number, number, number]))
  const points = [...frontier.bricks].map(vec).filter(p => [p.x,p.y,p.z].every(Number.isFinite))
  const views = session._ndTourVisited?.world === here ? session._ndTourVisited.views || [me] : [me]
  const { blocks,picks } = continuationSupply(bot)
  const nearest = Math.min(v.blazes?.nearest ?? Infinity, v.routeThreat ?? Infinity)
  const covered = !!v.boxed || nearest <= (session._ndFortressContinue?.covered ? 32 : 24)
  const threat = JSON.stringify([covered, nearest <= 16])
  const routes = session._ndFortressContinue?.world === here ? session._ndFortressContinue.routes : new Map()
  const candidates = new Map()
  const add = (to, source) => {
    const feet = to.offset(.5,1,.5), distance = feet.distanceTo(me)
    const novel = Math.min(...views.map(p => p.distanceTo(feet)))
    if (distance > 48 || novel < 8 || to.y + 1 < me.y - 1) return
    const key = to.toString(), mark = routes.get(key)
    if (mark && mark.revision === frontier.bricks.size && me.distanceTo(mark.origin) < 8 &&
        blocks <= mark.blocks && Object.entries(picks).every(([name,left]) => left <= (mark.picks[name] || 0)) && threat === mark.threat) return
    // shortcut: prior ETA for two brick cuts and one floor (three cover blocks)
    // per step; replace with continuation receipts when enough native legs exist.
    const { DIG, C }: typeof import('../nether-grid') = require('../nether-grid')
    const steps = Math.abs(to.x + .5 - me.x) + Math.abs(to.z + .5 - me.z)
    const seconds = steps * (.25 + 2 * DIG[C.STONE] + (covered ? 3 : 1) * 1.4) + Math.abs(feet.y - me.y) * 1.3
    if (!candidates.has(key)) candidates.set(key, { key, to, source, covered, seconds, blocks, picks, threat })
  }
  for (const p of points) add(p, 'seen brick')
  // Only rows actually seen, or walked on, vote for an axis; no seed/structure NBT.
  const deck = session._ndDeckTour?.world === here ? [...(session._ndDeckTour.seen || [])].map(k => vec(k).offset(0,-1,0)) : []
  for (const axis of ['x','z']) {
    const cross = axis === 'x' ? 'z' : 'x', rows = new Map()
    for (const p of deck.length ? deck : points) {
      const k = `${p.y},${p[cross]}`
      if (!rows.has(k)) rows.set(k, [])
      rows.get(k).push(p)
    }
    for (const row of rows.values()) {
      row.sort((a,b) => a[axis]-b[axis])
      if (row.length < 3 || row.at(-1)[axis]-row[0][axis] < 3) continue
      if (row.some((p,i) => i && p[axis]-row[i-1][axis]>1)) continue
      for (const [p, sign] of [[row[0],-1],[row.at(-1),1]]) {
        if (p.distanceTo(me) > 24) continue
        const to = p.clone(); to[axis] += sign * 8
        add(to, 'bridge axis')
      }
    }
  }
  return [...candidates.values()].sort((a,b) => a.seconds-b.seconds)[0] || null
}

async function continueFortress (session, ctl, { deadline, planOnly = false, planKey = null, maxCostSeconds = Infinity }: any = {}) {
  const bot = session.bot, here = worlds.worldOf(bot), start = bot.entity.position.clone()
  if (session._ndFortressFrontier?.world !== here) session._ndFortressFrontier = { world: here, bricks: new Set(), blocked: new Map() }
  if (session._ndFortressContinue?.world !== here) session._ndFortressContinue = { world: here, routes: new Map() }
  const frontier = session._ndFortressFrontier
  const observe = () => {
    const v = look(bot, session.mcData, { radius:64 })
    const foes = (require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot, { radius:32 }).filter(e => /^(blaze|ghast|skeleton|wither_skeleton|piglin_brute|hoglin|zoglin)$/.test(e.name))
    const bands = { рядом:3,близко:6,средне:12,далеко:20 } // senses.BAND_MID: coarse sound, never a hidden position
    v.routeThreat = Math.min(Infinity,...foes.map(e => e.seen ? e.dist : e.lastPos ?
      bot.entity.position.distanceTo(new Vec3(e.lastPos.x,e.lastPos.y,e.lastPos.z)) : bands[e.heard?.band]).filter(Number.isFinite))
    const cover: typeof import('../nether-cover') = require('../nether-cover'), feet = bot.entity.position.floored()
    if (typeof cover.around === 'function') v.boxed = cover.around(bot,[feet,feet.offset(0,1,0)]).open.length === 0
    for (const p of v.seenList || []) frontier.bricks.add(p.toString())
    for (const sp of v.spawners || []) rememberSpawner(session,sp)
    return v
  }
  let v = observe()
  const revision = frontier.bricks.size, plan = continuationPlan(session,v)
  session._ndFortressContinue.covered = !!plan?.covered
  const out = extra => ({ frontierRevision:frontier.bricks.size, at:xyz(bot.entity.position), ...extra })
  if (planOnly) return out({ plan, spawners:v.spawners })
  if (!plan || v.spawners?.length || ctl.aborted) return out({ advanced:false, continuationTried:0, frontierExhausted:!plan })
  if ((planKey && planKey !== plan.key) || plan.seconds > maxCostSeconds) return out({ advanced:false, continuationTried:0, changed:true })
  const bore = () => (require('../nether-cover') as typeof import('../nether-cover')).closedBore(session,ctl,plan.to,{ deadline,maxSteps:24,adjacent:true,minY:Math.floor(start.y),onOpen:observe })
  let w = await (plan.covered ? bore() : climbTo(session,ctl,plan.to,deadline)).catch(e => ({ ok:false,error:e.message }))
  if (!plan.covered && !w.ok && !w.fought && !ctl.aborted && gameClock.now()<deadline) w = await bore().catch(e=>({ok:false,error:e.message}))
  v = observe()
  const advanced = bot.entity.position.distanceTo(start) >= 8 || frontier.bricks.size > revision
  if (!session._ndTourVisited || session._ndTourVisited.world !== here) session._ndTourVisited = { world:here,points:[],views:[] }
  const visited = session._ndTourVisited
  if (visited.points.every(p => p.distanceTo(bot.entity.position)>=8)) visited.points.push(bot.entity.position.clone())
  visited.views ||= []
  if (visited.views.every(p => p.distanceTo(bot.entity.position)>=.8)) visited.views.push(bot.entity.position.clone())
  // Record the resulting cause: our own spent blocks cannot reopen this refusal.
  session._ndFortressContinue.routes.set(plan.key,{ origin:bot.entity.position.clone(),revision:frontier.bricks.size,
    ...continuationSupply(bot),
    threat:JSON.stringify([!!v.boxed || Math.min(v.blazes?.nearest ?? Infinity,v.routeThreat ?? Infinity) <= (plan.covered ? 32 : 24),
      Math.min(v.blazes?.nearest ?? Infinity,v.routeThreat ?? Infinity)<=16]) })
  log('продолжение', { source:plan.source,to:xyz(plan.to),covered:plan.covered,seconds:plan.seconds,advanced,moved:bot.entity.position.distanceTo(start),ok:w.ok,error:w.error || w.why })
  return out({ advanced,continuationTried:1,explored:visited.points.length,spawners:v.spawners,blazes:v.blazes,receipt:w })
}

function viewLeg (bot, visited, { toward = null, blocked = null }: any = {}) {
  const { blockSeen }: typeof import('../pick') = require('../pick')
  const me = bot.entity.position
  const open = b => b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name)
  let best = null
  let bestPrice = -Infinity
  for (const p of bot.findBlocks({ matching: b => b.boundingBox === 'block', maxDistance: 16, count: 512 })) {
    const b = bot.blockAt(p)
    if (!b?.shapes?.some(s => s[0] === 0 && s[2] === 0 && s[3] === 1 && s[4] === 1 && s[5] === 1)) continue
    const body = [1, 2].map(dy => bot.blockAt(p.offset(0, dy, 0)))
    if (!body.every(b => seesBlock(bot, b) && open(b))) continue
    const feet = p.offset(0.5, 1, 0.5)
    if (feet.distanceTo(me) < 0.8 || !blockSeen(bot, p, { range: 16 })) continue
    const novel = Math.min(...visited.map(q => Math.hypot(feet.x - q.x, feet.z - q.z)))
    if (blocked && (novel < 0.8 || blocked.get(p.toString()) === [b, ...body].map(b => b.name).join(','))) continue
    const gain = toward ? me.distanceTo(toward) - feet.distanceTo(toward) : 0
    const price = novel + gain - feet.distanceTo(me) * 0.25 - Math.max(0, me.y - feet.y - 3) * 2
    if (price > bestPrice) { best = p; bestPrice = price }
  }
  return best
}

/** S1f: два пеленга F3-yaw развёрнуты больше чем на 110° — цель между точками взгляда (почти над/под телом). */
const hintFlipped = (a, b) => Math.abs(((b - a + 540) % 360) - 180) > 110

async function tour (session, ctl, { deadline, hops = 8, pie = false, advance = false }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const here = worlds.worldOf(bot)
  // Остановки обхода — между вызовами (тот же мир): следующий заход идёт дальше по мосту, а не туда же.
  if (!session._ndTourVisited || session._ndTourVisited.world !== here) session._ndTourVisited = { world: here, points: [] }
  const visited = session._ndTourVisited.points
  const path = []
  let pillars = 0
  let axes = 0
  let hinted = 0
  let lastHint = null
  let verticals = 0
  let stuckAt = null
  let deckSteps = 0
  if (session._ndDeckTour?.world !== here) session._ndDeckTour = { world: here }
  const deck = session._ndDeckTour
  const activeFrontier = process.env.ND_FORTRESS_FRONTIER !== '0' && typeof bot.findBlocks === 'function' && typeof bot.blockAt === 'function'
  if (session._ndFortressFrontier?.world !== here) session._ndFortressFrontier = { world: here, bricks: new Set(), blocked: new Map() }
  const frontier = session._ndFortressFrontier
  const start = bot.entity.position.clone()
  let frontierTried = 0, frontierExhausted = false
  // Short observation steps also matter on the next call, without earning the
  // separate eight-block exploration credit. Keep a bounded recent history.
  const views = (session._ndTourVisited.views ||= [])
  const lookNow = () => {
    if (views.every(p => p.distanceTo(bot.entity.position) >= 0.8)) {
      views.push(bot.entity.position.clone())
      if (views.length > 256) views.shift()
    }
    const v: any = look(bot, mcData, { radius: 64 })
    if (activeFrontier) for (const p of v.seenList || []) frontier.bricks.add(p.toString())
    for (const sp of v.spawners || []) rememberSpawner(session, sp)
    console.log('[fortress] обход', JSON.stringify({ gameMs: gameClock.now(), at: xyz(bot.entity.position), seen: v.seen, spawners: (v.spawners || []).length, blazes: v.blazes }))
    return v
  }
  let v: any = lookNow()
  const revision0 = frontier.bricks.size
  let still = 0
  let lastAt = null
  for (let i = 0; i < hops && !v.spawners && !ctl.aborted && gameClock.now() < deadline; i++) {
    const me = bot.entity.position
    if (advance && (me.distanceTo(start) >= 8 || frontier.bricks.size > revision0)) break
    // S1f: три остановки подряд без сдвига (s1f-C1-1: 14 «остановок» на одном месте моста, блоков 0) — обход кончен.
    still = lastAt && me.distanceTo(lastAt) < 0.8 ? still + 1 : 0
    lastAt = me.clone()
    if (still >= 3) { path.push({ stuck: true, at: xyz(me) }); break }
    // S1f: ифриты видны рядом (≤ 16) или хп < 14 — обход с «пирогом» кончен: дальше бой ведёт blaze (коробка с окном, щит, отдых),
    // а не шаг по пеленгу под шары (s1f-H1-2: подсказки довели к спавнеру на 4 бл., огонь ифритов — смерть на 3.7 мин). ND_TOUR_STOP=0 — прежнее.
    if (pie && process.env.ND_TOUR_STOP !== '0' && ((v.blazes && v.blazes.nearest <= 16) || (bot.health ?? 20) < 14)) { path.push({ handover: true, blazes: v.blazes, hp: Math.round(bot.health ?? 0) }); break }
    await keepBlocks(session, ctl)
    if (visited.every(p => p.distanceTo(me) >= 8)) visited.push(me.clone())
    const adjacent = deckLeg(bot, deck)
    if (adjacent) {
      const w = await climbWalk(session, ctl, adjacent.floor, deadline, { exact: true })
      path.push({ deck: true, back: adjacent.back, to: xyz(adjacent.floor), ok: w.ok, error: w.ok ? undefined : w.error })
      v = lookNow()
      if (w.ok) deckSteps++
      if (deckSteps >= hops * 64) break
      i--
      continue
    }
    // S1f (вслепую): «пирог» F3 показывает спавнер в прорисовке или ифрит слышен — сперва туда, отрезком по пеленгу (до 6 раз).
    const overhead = (v.seenList || []).filter(p => p.y >= me.y + 2 && Math.hypot(p.x - me.x, p.z - me.z) <= 2)
      .sort((a, b) => a.y - b.y)[0]
    const hint = !overhead && pie && hinted < 6 && process.env.ND_TOUR_PIE !== '0' ? spawnerHint(bot) : null
    // Пеленг «пирога» развернулся (> 110°) после короткого отрезка — спавнер почти над/под нами (s1f-A2-3, сид 7777…: тело на y 50–52
    // ходило туда-сюда под тронным залом, спавнер −85,77,60 — в 3–5 бл. по горизонтали и 25 выше). Тронный зал — наверху крепости
    // (палубы 48–90): столбом вверх к палубе и взгляд, а не новый отрезок по пеленгу.
    // Ход по подсказке не сдвинул тело (sr-e-1 10.10: y 46 под крепостью, 12 подсказок подряд «ok:false» с одного места) —
    // тоже сперва к палубе (столб, копка вверх), а не тот же отрезок.
    const hintStuck = !!hint && !!stuckAt && me.distanceTo(stuckAt) < 3
    // Застрявшая подсказка — к палубе только с высоты мостов (sr-h-2 10.10: подъём с y 62 кончился падением на 28 и спуском
    // вызов за вызовом до 21, под лавовое море).
    if (hint && ((hint.by === 'пирог' && lastHint && hintFlipped(lastHint.yaw, hint.yaw) && me.distanceTo(lastHint.at) < 30) || (hintStuck && me.y >= 45 && me.y < 64)) && verticals < 2) {
      stuckAt = null
      verticals++
      const fy = Math.floor(me.y)
      const up = Math.max(4, Math.min(28, (fy < 64 ? Math.max(fy + 16, 68) : fy + 12) - fy))
      const t = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, up, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
      // Столб упёрся в потолок коридора (sr-d-1 10.10: «вверх 16» дал +2..3 — пеленг метался −137↔−155, спавнер не найден за
      // 30 мин): как игрок — копать потолок над головой и ставить блок под ноги до палубы.
      const left = fy + up - Math.floor(bot.entity.position.y)
      if (left > 2 && Math.floor(bot.entity.position.y) >= fy && !ctl.aborted) {
        const d = await (require('../build') as typeof import('../build')).digUp(bot, ctl, { blocks: left, mcData }).catch(e => ({ dug: 0, stopped: e.message }))
        path.push({ digUp: d.dug, stopped: d.stopped, y: Math.floor(bot.entity.position.y) })
      }
      path.push({ vertical: true, up, from: fy, y: Math.floor(bot.entity.position.y), ok: t && t.ok, error: t && t.ok ? undefined : t && t.reason })
      log('обход: спавнер над/под нами — вверх', { from: fy, up, y: Math.floor(bot.entity.position.y), yaws: [lastHint && lastHint.yaw, hint.yaw], stuck: hintStuck })
      lastHint = null
      v = lookNow()
      continue
    }
    if (activeFrontier && !overhead) {
      // Новый вариант пути не повторяет свой noPath до изменения наблюдений, тела или снабжения.
      const supplies = (bot.inventory?.items() || []).filter(i => /pickaxe$|^(cobblestone|blackstone|netherrack|nether_bricks)$/.test(i.name))
        .map(i => [i.name, i.count, i.durabilityUsed || 0]).sort()
      const cause = JSON.stringify([frontier.bricks.size, supplies, bot.health, v.blazes?.seen || 0, (v.blazes?.nearest ?? Infinity) <= 16, hint && [hint.by, hint.yaw, hint.dir, hint.band]])
      if (frontier.cause !== cause || (frontier.origin && me.distanceTo(frontier.origin) >= 8)) {
        frontier.blocked.clear(); frontier.cause = cause; frontier.origin = me.clone()
      }
      const rec = placeOf(session, PLACE)
      const brick = hint ? new Vec3(hint.x, me.y, hint.z) : (v.seenList || [])[0] || (rec && worlds.worldOfRecord(rec) === here ? new Vec3(rec.x, rec.y, rec.z) : null)
      // shortcut: видимый пол в 16 блоках; расширять по натурным отказам дальнего подхода.
      const view = viewLeg(bot, views, { toward: brick, blocked: frontier.blocked })
      if (view) {
        const before = me.clone()
        const fingerprint = [0, 1, 2].map(dy => bot.blockAt(view.offset(0, dy, 0))?.name).join(',')
        if (hint) { hinted++; if (hint.by === 'пирог') lastHint = { yaw: hint.yaw, at: before.clone() } }
        let w = await climbWalk(session, ctl, view, deadline, { exact: true })
        if (!w.ok && !w.fought && !ctl.aborted && gameClock.now() < deadline) w = await climbTo(session, ctl, view, deadline)
        frontierTried++
        if (!w.ok && !w.fought && !ctl.aborted) frontier.blocked.set(view.toString(), fingerprint)
        path.push({ frontier: true, view: true, by: hint?.by || 'кирпич', to: xyz(view), ok: w.ok, moved: Math.round(bot.entity.position.distanceTo(before) * 10) / 10, error: w.error })
        if (hint) stuckAt = bot.entity.position.distanceTo(before) < 3 ? bot.entity.position.clone() : null
        v = lookNow()
        continue
      }
      if (advance) { frontierExhausted = true; break }
    }
    if (hint) {
      hinted++
      if (hint.by === 'пирог') lastHint = { yaw: hint.yaw, at: me.clone() }
      const deck = Math.max(Math.floor(me.y), 52)
      const at0 = me.clone()
      let w = await climbTo(session, ctl, new Vec3(hint.x, deck, hint.z), deadline)
      // «Дошёл», не сдвинувшись (s1f-S1-1: три подсказки подряд ok:true на месте 16,62,60) — тот же отрезок прямым ходом/штреком.
      if ((!w.ok || bot.entity.position.distanceTo(at0) < 3) && !w.fought) w = await legTo(session, ctl, hint.x, hint.z, deadline)
      path.push({ to: { x: hint.x, z: hint.z }, hint: hint.by, yaw: hint.yaw, ok: w.ok, y: Math.floor(bot.entity.position.y), error: w.ok ? undefined : w.error })
      stuckAt = bot.entity.position.distanceTo(at0) < 3 ? bot.entity.position.clone() : null
      log('обход: подсказка', { ...hint, ok: w.ok, error: w.ok ? undefined : w.error, at: xyz(bot.entity.position) })
      v = lookNow()
      continue
    }
    // Видны блейзы — к ним: они висят у спавнера (±4 от него), а спавнер
    // виден глазами только ближе 48 (прогон 12: блейзы в 36, спавнера нет).
    const far = (v.blazeList || []).filter(b => b.distanceTo(me) > 12)
    if (far.length) {
      const b = far.reduce((a, c) => (c.distanceTo(me) < a.distanceTo(me) ? c : a))
      const w = await climbTo(session, ctl, b.offset(0, -3, 0), deadline)
      path.push({ to: xyz(b), blaze: true, ok: w.ok, y: Math.floor(bot.entity.position.y), error: w.ok ? undefined : w.error })
      v = lookNow()
      continue
    }
    let pool = (overhead ? [overhead] : (v.seenList || [])).filter(p => p.distanceTo(me) <= 64)
    if (!pool.length) {
      // Кирпича не видно — к крепости из памяти.
      const rec = placeOf(session, PLACE)
      if (!rec || worlds.worldOfRecord(rec) !== here) { console.log('[fortress] обход: конец — кирпича не видно, в памяти нет'); break }
      pool = [new Vec3(rec.x, rec.y, rec.z)]
    }
    const score = p => Math.min(...visited.map(q => Math.hypot(p.x - q.x, p.z - q.z)))
    const pick = pool.reduce((a, b) => (score(b) > score(a) ? b : a))
    if (score(pick) < 8) {
      // Всё видимое рядом, а крепость над головой: разведка с полом y=40 видит
      // её снизу — опоры и днище мостов, а мосты и тронный зал на 64+. Как
      // игрок: к ближайшей опоре и столбом вверх до верхнего видимого кирпича
      // (build.towerUp, блок под себя с проверкой), оттуда — снова взгляд.
      // 2026-09-26 (22:48): крепость найдена с y=41, обход кончался за один
      // шаг («видно 6, спавнеров 0») пять вызовов подряд.
      const feet = bot.entity.position.floored()
      // Выше палубы не лезем; ниже — вверх, даже если кирпич сверху не виден:
      // снизу видны 3-4 блока днища, и «над головой ничего» — это не правда
      // (прогон 00:00: y=45, «видно 3», столба не было).
      const above0 = pool.filter(p => Math.hypot(p.x - feet.x, p.z - feet.z) <= 16 && p.y >= feet.y + 2)
      const above = above0.length ? above0 : (feet.y < 60 ? pool : [])
      if (!above.length || pillars >= 2) {
        // На палубе видно только ближний кирпич (sr-1010 10.10: тело на мосту y 74, «обход 0 остановок» — 0 стержней): как
        // игрок — вдоль моста. Ось — по разбросу видимого кирпича рядом (мосты крепости идут по x или z), сторона — дальше
        // от прежних остановок.
        const leg = axisLeg(pool, feet, visited)
        if (!leg || axes >= 4) {
          const view = viewLeg(bot, visited.concat(views))
          if (view) {
            const w = await climbWalk(session, ctl, view, deadline, { exact: true })
            path.push({ view: true, to: xyz(view), ok: w.ok, y: Math.floor(bot.entity.position.y), error: w.ok ? undefined : w.error })
            v = lookNow()
            continue
          }
          console.log('[fortress] обход: конец', JSON.stringify({ above: above.length, pillars, axes, pool: pool.length, near: pool.filter(p => Math.hypot(p.x - feet.x, p.z - feet.z) <= 16).length, visited: visited.length })); break
        }
        axes++
        const w = await legTo(session, ctl, leg.x, leg.z, deadline)
        path.push({ axis: leg.axis, to: { x: leg.x, z: leg.z }, ok: w.ok, y: Math.floor(bot.entity.position.y), error: w.ok ? undefined : w.error })
        v = lookNow()
        continue
      }
      const base = above.reduce((a, b) => (Math.hypot(b.x - feet.x, b.z - feet.z) < Math.hypot(a.x - feet.x, a.z - feet.z) ? b : a))
      await climbWalk(session, ctl, new Vec3(base.x, Math.max(feet.y - 1, bot.entity.position.y - 1), base.z), deadline)
      const topY = Math.max(...above.map(p => p.y))
      const from = Math.floor(bot.entity.position.y)
      const up = await (require('../build') as typeof import('../build')).towerUp(bot, ctl, Math.max(1, Math.min(28, topY + 1 - from)), { sneak: true })
      // N21: the visible bridge floor stopped the tower at y53. Open that
      // ceiling to the observed floor, then look again from the actual body.
      const at = bot.entity.position.floored()
      const head = bot.blockAt(at.offset(0, 2, 0))
      const visible = head?.boundingBox === 'block' && (require('../pick') as typeof import('../pick')).blockSeen(bot, head.position)
      const ceilingY = visible && /^nether_brick/.test(head.name) ? head.position.y : -Infinity
      const left = Math.max(topY, ceilingY) + 1 - at.y
      if (left > 0 && visible && !ctl.aborted && gameClock.now() < deadline) {
        const d = await (require('../build') as typeof import('../build')).digUp(bot, ctl, { blocks: Math.min(28, left), mcData })
        path.push({ digUp: d.dug, stopped: d.stopped, y: Math.floor(bot.entity.position.y) })
      }
      pillars++
      path.push({ pillar: up.placed, from, y: Math.floor(bot.entity.position.y), ok: up.ok, error: up.ok ? undefined : up.reason })
      v = lookNow()
      continue
    }
    // НА мост, а не под него: тронный зал и блейзы — на палубе крепости
    // (y 48..70), а GoalNearXZ высоты не спрашивает — прогон 9 обошёл крепость
    // по дну на y=34 и видел только опоры. Цель — верх самого высокого
    // видимого кирпича у выбранной точки; не вышло — хотя бы по x,z.
    const top = pool.filter(p => Math.hypot(p.x - pick.x, p.z - pick.z) <= 4).reduce((a, b) => (b.y > a.y ? b : a), pick)
    let w = await climbTo(session, ctl, top, deadline)
    if (!w.ok && !w.fought) w = await legTo(session, ctl, pick.x, pick.z, deadline)
    path.push({ to: xyz(top), ok: w.ok, y: Math.floor(bot.entity.position.y), error: w.ok ? undefined : w.error })
    v = lookNow()
  }
  const advanced = bot.entity.position.distanceTo(start) >= 8 || frontier.bricks.size > revision0
  console.log('[fortress] обход: итог', JSON.stringify({ deckSteps, deckVisited: deck.seen?.size || 0, hops: path.length,
    explored: visited.length, spawners: (v.spawners || []).length, at: xyz(bot.entity.position), advanced, frontierRevision: frontier.bricks.size, frontierTried, frontierExhausted }))
  return { spawners: v.spawners, blazes: v.blazes, seen: v.seen, hops: path, deckSteps, deckVisited: deck.seen?.size || 0, explored: visited.length, at: xyz(bot.entity.position),
    advanced, frontierRevision: frontier.bricks.size, frontierTried, frontierExhausted }
}

export { spawnerHint, axisLeg, deckLeg, continueFortress, hintFlipped, tour }
