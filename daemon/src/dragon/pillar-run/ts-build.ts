'use strict'
// Бой с драконом (dragon/pillar-run.ts): обход, постройка станции TS и траншея.
const { gameClock, Vec3, playerBox, FILLER_RE, sleep, CENTER, isSolid, stepTo, dragonOf, phaseOf, digDownTo, build, SITTING, partsOf, clearControls, runnerOn }: typeof import('../dig-down-to') = require('../dig-down-to')
const { doing, r1, standY }: typeof import('../fall-guard') = require('../fall-guard')
const { hurtNear, segPoint2 }: typeof import('../evade-raw') = require('../evade-raw')
const { chargeAnchor, placeNoBed, placeBedAt, placeAnchorAt }: typeof import('../ts-plan') = require('../ts-plan')
import { walkTo } from './walk'
import { lastDragonHit } from './feed'
import { bedsGo } from './beds-act'

async function walkAround (session, ctl, target, { timeoutMs = 8000, stop = null }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const me = bot.entity.position
  const pts = []
  const segNear = (a, b) => segPoint2({ x: a.x, z: a.z }, { x: b.x, z: b.z }, CENTER)
  if (segNear(me, target) < 4.5) {
    const a0 = Math.atan2(me.z - CENTER.z, me.x - CENTER.x); const a1 = Math.atan2(target.z - CENTER.z, target.x - CENTER.x)
    const da = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0))
    const n = Math.max(1, Math.ceil(Math.abs(da) / 0.6))
    for (let k = 1; k < n; k++) { const a = a0 + da * k / n; pts.push(new Vec3(CENTER.x + Math.cos(a) * 7.5, target.y, CENTER.z + Math.sin(a) * 7.5)) }
  }
  pts.push(target)
  for (let i = 0; i < pts.length; i++) {
    if (ctl.aborted || gameClock.now() - t0 > timeoutMs) break
    const p = pts[i]
    const last = i === pts.length - 1
    const y = standY(bot, p.x, p.z, bot.entity.position.y, 3, 4)
    const q = new Vec3(p.x, y != null ? y : p.y, p.z)
    if (stop && stop()) break
    const r = await stepTo(bot, ctl, q, { ms: 2500, sprint: true, stopAt: last ? 0.3 : 1.0, stop })
    if (stop && stop()) break
    if (!r.ok && Math.hypot(bot.entity.position.x - q.x, bot.entity.position.z - q.z) > (last ? 0.6 : 2)) {
      await walkTo(session, ctl, q, { range: last ? 0.35 : 1.5, timeoutMs: Math.max(1500, timeoutMs - (gameClock.now() - t0)), hazards: true, stopIf: stop ? () => (stop() ? 'опасно' : null) : undefined })
    }
  }
  clearControls(bot)
  const m = bot.entity.position
  return { ok: Math.hypot(m.x - target.x, m.z - target.z) <= 0.6, why: gameClock.now() - t0 > timeoutMs ? 'не успел' : null }
}

async function tsBuild (session, ctl, stats, plan, danger = null, left = null, { skipTrench = false, onlyTrench = false, parts = null }: any = {}) {
  const bot = session.bot
  const v = (c, y) => new Vec3(c.x, y, c.z)
  const t0 = gameClock.now()
  const lap: any = {}
  const mark = k => { lap[k] = gameClock.now() - t0; doing(ctl, 'ts:' + k) }
  const risky = () => { const w = (gameClock.now() - lastDragonHit < 1500 ? 'удар дракона' : null) || (danger && danger()); if (w) { lap.danger = w; return true } return false }
  const res = r => { if (ctl.trace) ctl.trace.ev('tsBuild', { ok: r.ok, why: r.why, lap, role: plan.role || undefined, part: skipTrench ? 'стройка' : onlyTrench ? 'окоп' : undefined }); return r }
  const trench = async () => { const r = await tsTrench(bot, ctl, plan, mark, session); Object.assign(lap, r.lap || {}); delete r.lap; return res(r) }
  if (onlyTrench) return trench()
  mark('walk')
  if (risky()) return res({ ok: false, why: 'дракон рядом' })
  const low = plan.psLift ? new Vec3(plan.ground.x, plan.gPS, plan.ground.z) : plan.ground
  // Дракон сидит (parts) — идти в обход его коробок (bedsGo), а не дугой у фонтана.
  const walkStop = () => {
    if (gameClock.now() - lastDragonHit < 1500) return true
    const dd = dragonOf(bot)
    if (dd && SITTING.has(phaseOf(bot, dd))) { const pp = partsOf(bot, dd, null); if (hurtNear(playerBox(bot.entity.position), pp)) return true }
    return !!(danger && danger())
  }
  const g = parts ? await bedsGo(session, ctl, { feet: low, y: low.y, B: { x: Math.floor(low.x), z: Math.floor(low.z) }, lift: 0 }, true, parts()) : await walkAround(session, ctl, low, { timeoutMs: 7000, stop: walkStop })
  if (!g.ok) return res({ ok: false, why: `не дошёл до места ставки: ${g.why || ''}` })
  clearControls(bot)
  // Ставить с середины клетки: план проверял грани из неё (касательные взгляды с края — «грань
  // не видно», fin1).
  for (let k = 0; k < 3 && Math.hypot(bot.entity.position.x - low.x, bot.entity.position.z - low.z) > 0.12; k++) { await stepTo(bot, ctl, low, { ms: 600, sprint: false, stopAt: 0.06 }); clearControls(bot) }
  // Ставить стоя на земле: fin2-28 — опора и заслон ставились в прыжке (y 61.4→62.2, g 0),
  // грани из воздуха «не видно».
  const settle = async () => { clearControls(bot); for (let j = 0; j < 16 && !bot.entity.onGround; j++) await sleep(50) }
  await settle()
  if (plan.psLift) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    mark('stand')
    await stepTo(bot, ctl, low, { ms: 700, sprint: false, stopAt: 0.1 }); clearControls(bot)
    // Встал — значит стоит на своём блоке (на земле), а не в прыжке: fin2-28 — проверка прошла
    // в воздухе (y 64.2), блока не было, тело упало, и заслон «грань не видно».
    const onStand = () => bot.entity.onGround && Math.abs(bot.entity.position.y - plan.ground.y) <= 0.3 && isSolid(bot.blockAt(new Vec3(low.x, plan.gPS, low.z)))
    for (let k = 0; k < 2 && !onStand(); k++) {
      if (k) { await stepTo(bot, ctl, low, { ms: 700, sprint: false, stopAt: 0.1 }); clearControls(bot) }
      await build.towerUp(bot, ctl, 1).catch(() => {})
      clearControls(bot)
      for (let j = 0; j < 15 && !bot.entity.onGround; j++) await sleep(50)
    }
    if (!onStand()) return res({ ok: false, why: 'на блок у места ставки не встал' })
  }
  mark('support')
  for (const y of plan.sCells) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    await settle()
    let r: any = await placeNoBed(bot, v(plan.F, y), { timeoutMs: 1200 })
    // Грань опоры видна с середины клетки ставки (так считал план) — встать точно и ещё раз.
    if (!r.ok) { await stepTo(bot, ctl, plan.ground, { ms: 900, sprint: false, stopAt: 0.08 }); clearControls(bot); r = await placeNoBed(bot, v(plan.F, y), { timeoutMs: 1200 }) }
    if (!r.ok) return res({ ok: false, why: `опора: ${r.reason || r.why}` })
  }
  // заслон — отсюда, если видно; нет — с B
  mark('wall')
  let moved = false
  for (const y of plan.wCells) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    await settle()
    let r: any = await placeNoBed(bot, v(plan.W, y), { timeoutMs: 1200 })
    // С места ставки не вышло — сперва встать точно туда (стоя), потом уже с B.
    if (!r.ok && !moved && !plan.psLift) { await stepTo(bot, ctl, plan.ground, { ms: 900, sprint: false, stopAt: 0.06 }); await settle(); r = await placeNoBed(bot, v(plan.W, y), { timeoutMs: 1200 }) }
    if (!r.ok && !moved) {
      moved = true
      await stepTo(bot, ctl, new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5), { ms: 2000, stopAt: 0.08 })
      await settle()
      r = await placeNoBed(bot, v(plan.W, y), { timeoutMs: 1200 })
    }
    if (!r.ok) { const q = bot.entity.position; lap.wallAt = [plan.W.x, y, plan.W.z]; lap.me = [r1(q.x), r1(q.y), r1(q.z)]; lap.ps = [plan.ground.x, plan.ground.y, plan.ground.z]; return res({ ok: false, why: `заслон: ${r.reason || r.why}` }) }
  }
  if (plan.K && !isSolid(bot.blockAt(v(plan.K, plan.G)))) {
    mark('anchor')
    let r: any = await placeNoBed(bot, v(plan.K, plan.G), { timeoutMs: 1200 })
    if (!r.ok) { await stepTo(bot, ctl, new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5), { ms: 2000, stopAt: 0.2 }); r = await placeNoBed(bot, v(plan.K, plan.G), { timeoutMs: 1200 }); moved = true }
    if (!r.ok) return res({ ok: false, why: `упор крышки: ${r.reason || r.why}` })
  }
  if (moved) await stepTo(bot, ctl, plan.ground, { ms: 2000, stopAt: 0.2 })
  if (plan.anchor) {
    mark('anchor')
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    await settle()
    const r = await placeAnchorAt(bot, plan)
    if (!r.ok) return res({ ok: false, why: `якорь: ${r.why}` })
    mark('charge')
    const c = await chargeAnchor(bot, plan)
    if (!c.ok) return res({ ok: false, why: `заряд: ${c.why}` })
  } else {
  mark('bed')
  const bedAt = bot.blockAt(v(plan.F, plan.yb))
  if (!(bedAt && /_bed$/.test(bedAt.name))) {
    if (risky()) return res({ ok: false, why: 'дракон рядом' })
    const r = await placeBedAt(bot, plan.F, plan.H, plan.yb)
    if (!r.ok) return res(r)
  }
  const hb = bot.blockAt(v(plan.H, plan.yb))
  if (!hb || !/_bed$/.test(hb.name)) return res({ ok: false, why: 'изголовье не там (взгляд не вдоль a)' })
  }
  if (plan.second && (!left || left() >= 70)) {
    const s2 = plan.second
    mark('walk0')
    const g0 = risky() ? { ok: false } : await walkAround(session, ctl, s2.ground, { timeoutMs: 6000 })
    if (g0.ok) {
      mark('build0')
      let ok0 = true
      for (const y of s2.sCells) { if (risky()) { ok0 = false; break } const r = await placeNoBed(bot, v(s2.F, y), { timeoutMs: 1200 }); if (!r.ok) { ok0 = false; break } }
      for (const y of ok0 ? s2.wCells : []) {
        if (risky()) { ok0 = false; break }
        let r = await placeNoBed(bot, v(s2.W, y), { timeoutMs: 1200 })
        if (!r.ok) { await stepTo(bot, ctl, new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5), { ms: 2000, stopAt: 0.2 }); r = await placeNoBed(bot, v(s2.W, y), { timeoutMs: 1200 }); await stepTo(bot, ctl, s2.ground, { ms: 2000, stopAt: 0.2 }) }
        if (!r.ok) { ok0 = false; break }
      }
      if (ok0 && !risky()) { const r = await placeBedAt(bot, s2.F, s2.H, s2.yb); ok0 = r.ok } else ok0 = false
      const hb0 = bot.blockAt(v(s2.H, s2.yb))
      lap.second = ok0 && hb0 && /_bed$/.test(hb0.name) ? 'ok' : 'нет'
      if (lap.second !== 'ok') plan.second = null
    } else { lap.second = 'не дошёл'; plan.second = null }
  }
  else if (plan.second) { lap.second = 'некогда'; plan.second = null }
  if (skipTrench) { mark('done'); return res({ ok: true }) }
  return trench()
}

async function tsTrench (bot, ctl, plan, mark, session) {
  const lap: any = {}
  mark('trench')
  const runner0 = runnerOn() && plan.runner
  const bc = runner0 && plan.feet ? new Vec3(plan.feet.x, plan.G, plan.feet.z) : new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5)
  // portal: окоп станции у столба — в 3–5 от середины: шаг к середине клетки смотрит на 0.9 вперёд и
  // упирался в «чашу портала» (pil5-15: «не встал в середину клетки» ×5 за 1.5 с)
  const portal = !!plan.portal
  const runner = runnerOn() && plan.runner
  // depth 0: спуститься с обода P−3 в чашу P−4 маршрутом, а не копкой под собой.
  if (runner && plan.depth === 0) await walkTo(session, ctl, bc, { range: 0.3, timeoutMs: 8000, portal })
  // R: в клетке ног чаши — свой блок (рефлекс от облака/фаербола, rs8-s1), бот стоит на нём на ярус выше — снять под собой
  if (runner && plan.depth === 0) {
    for (let k = 0; k < 2; k++) {
      const q0 = bot.entity.position
      const under = bot.blockAt(new Vec3(Math.floor(q0.x), Math.floor(q0.y + 0.01) - 1, Math.floor(q0.z)))
      if (Math.floor(q0.y + 0.01) <= plan.G || Math.hypot(q0.x - bc.x, q0.z - bc.z) > 0.6 || !under || !FILLER_RE.test(under.name)) break
      lap.unfill = (lap.unfill || 0) + 1
      await digDownTo(bot, ctl, plan.G, 2, plan.abortIf || null).catch(() => {})
    }
  }
  await stepTo(bot, ctl, bc, { ms: 2000, stopAt: 0.15, portal })
  clearControls(bot)
  // R: ноги сдвинуты к краю клетки (x 0.2/0.8) — floor(x) на шаге за край врёт; годится ≤ 0.35 от точки ног (rs3: 37 «не встал над окопом»)
  const inCell = () => { const q = bot.entity.position; return runner0 && plan.feet ? Math.hypot(q.x - bc.x, q.z - bc.z) <= 0.35 : Math.floor(q.x) === plan.B.x && Math.floor(q.z) === plan.B.z && Math.hypot(q.x - bc.x, q.z - bc.z) <= 0.45 }
  for (let k = 0; k < 2 && !inCell(); k++) {
    if (k === 0) await walkTo(session, ctl, bc, { range: 0.3, timeoutMs: 4000, hazards: true, portal })
    await stepTo(bot, ctl, bc, { ms: 900, sprint: false, stopAt: 0.1, portal })
    clearControls(bot)
  }
  if (plan.abortIf && plan.abortIf()) return { ok: false, why: plan.abortIf(), lap }
  if (!inCell()) return { ok: false, why: 'не встал над окопом', lap }
  // Копать под собой — только стоя целиком над клеткой (коробка 0.6: смещение ≤ 0.18),
  const centred = () => { const q = bot.entity.position; return Math.max(Math.abs(q.x - bc.x), Math.abs(q.z - bc.z)) <= 0.18 }
  for (let k = 0; k < 4 && !centred(); k++) { await stepTo(bot, ctl, bc, { ms: 600, sprint: false, stopAt: 0.05, portal }); clearControls(bot); await sleep(60) }
  if (!centred()) return { ok: false, why: 'не встал в середину клетки окопа', lap }
  for (let k = 0; k < 2 && (!runner || plan.depth > 0) && Math.floor(bot.entity.position.y + 0.01) > plan.G - plan.depth; k++) {
    const stopWhy = plan.abortIf && plan.abortIf()
    if (stopWhy) return { ok: false, why: stopWhy, lap }
    const down = await digDownTo(bot, ctl, plan.G - plan.depth, plan.depth, plan.abortIf || null)
    lap['dig' + k] = { dug: down.dug, why: down.why || null, y: r1(bot.entity.position.y), off: r1(Math.hypot(bot.entity.position.x - bc.x, bot.entity.position.z - bc.z) * 100) / 100 }
    if (Math.floor(bot.entity.position.y + 0.01) > plan.G - plan.depth) { clearControls(bot); bot.setControlState('sneak', false); for (let j = 0; j < 3 && !centred(); j++) { await stepTo(bot, ctl, bc, { ms: 600, sprint: false, stopAt: 0.05, portal }); clearControls(bot) } }
  }
  // глубже, чем надо (провалился) — подняться на свой блок
  const under = plan.G - plan.depth - Math.floor(bot.entity.position.y + 0.01)
  if (!runner && under > 0 && under <= 2 && inCell()) { lap.up = under; await build.towerUp(bot, ctl, under).catch(() => {}); clearControls(bot) }
  // st2-s1: «не спустился» ×6 подряд за 1.5 с — тело ещё падало/подпрыгивало в яме (y 61.4 при цели 61): ждать земли
  for (let j = 0; j < 16 && !bot.entity.onGround; j++) await sleep(50)
  lap.end = { y: r1(bot.entity.position.y), want: plan.G - plan.depth, ground: !!bot.entity.onGround }
  if (Math.floor(bot.entity.position.y + 0.01) !== plan.G - plan.depth) return { ok: false, why: 'окоп: не спустился', lap }
  mark('done')
  return { ok: true, lap }
}

export {
  walkAround, tsBuild, tsTrench
}
