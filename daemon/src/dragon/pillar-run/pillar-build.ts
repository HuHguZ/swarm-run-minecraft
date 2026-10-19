'use strict'
// Бой с драконом (dragon/pillar-run.ts): столб: встать, поставить, высоко, расчистка, постройка, вход.
const { gameClock, Vec3, findItem, FILLER_RE, sleep, isSolid, stepTo, dragonOf, phaseOf, PHASE, digDownTo, build, EYE, SITTING, clearControls, isAirish, envv, runnerOn, fbAlarm, placeItemAt, pick, TOWER_FAR, fireballsOf, BUILD_MAX_MS, RUN_TOWER1 }: typeof import('../dig-down-to') = require('../dig-down-to')
const { hunters, doing, surfaceY, fastTower, r1 }: typeof import('../fall-guard') = require('../fall-guard')
const { countOf, virtualBot, SNEAK_EYE }: typeof import('../evade-raw') = require('../evade-raw')
const { pillarHere, standFor }: typeof import('../station-plan') = require('../station-plan')
const { approachFar }: typeof import('../pillar-plan') = require('../pillar-plan')
const { placeNoBed }: typeof import('../ts-plan') = require('../ts-plan')
import { hazardNow } from './sight-zones'
import { walkTo, guard } from './walk'
import { tsTrench } from './ts-build'

async function standAt (session, ctl, feet) {
  const bot = session.bot
  standAt.why = null; standAt.step = null
  for (let k = 0; k < 3 && bot.entity.position.distanceTo(feet) > 0.6; k++) {
    if (fbAlarm(bot)) { standAt.why = 'фаербол'; return false }
    // чаша фонтана — портал (пока дракон жив, неактивен): шагать в неё можно (portal: true)
    // |Δy| > 0.6 — маршрут и к близкой цели на другом ярусе (Codex fr1-fix: 83 «к столбику не дошёл»); не проверено боями — только при ND_RUNNER=1
    if (bot.entity.position.distanceTo(feet) > 3 || (runnerOn() && Math.abs(bot.entity.position.y - feet.y) > 0.6)) await walkTo(session, ctl, feet, { range: 0.4, timeoutMs: 9000, portal: true }).catch(() => {})
    const st1 = await stepTo(bot, ctl, feet, { ms: 1500, sprint: false, stopAt: 0.12, portal: true })
    if (st1 && st1.why) standAt.step = st1.why
    clearControls(bot)
  }
  for (let k = 0; k < 3 && !fbAlarm(bot) && Math.hypot(bot.entity.position.x - feet.x, bot.entity.position.z - feet.z) > 0.15; k++) { const st2 = await stepTo(bot, ctl, feet, { ms: 600, sprint: false, stopAt: 0.06, portal: true }); if (st2 && st2.why) standAt.step = st2.why; clearControls(bot) }
  for (let j = 0; j < 12 && !bot.entity.onGround; j++) await sleep(50)
  const q = bot.entity.position
  // в своей клетке на нужном ярусе и на земле — годится (столбик/ставка от середины клетки не зависят)
  if (bot.entity.onGround && Math.floor(q.x) === Math.floor(feet.x) && Math.floor(q.z) === Math.floor(feet.z) && Math.abs(q.y - feet.y) < 0.5) return true
  if (q.distanceTo(feet) <= 0.8) return true
  standAt.why = `стою ${r1(q.x)},${r1(q.y)},${r1(q.z)} — цель ${r1(feet.x)},${r1(feet.y)},${r1(feet.z)}${bot.entity.onGround ? '' : ', в воздухе'}${standAt.step ? ` (шаг: ${standAt.step})` : ''}`
  return false
}
declare namespace standAt {
  let why: any
  let step: any
}

async function placeFrom (session, ctl, cell, world, itemRe) {
  const bot = session.bot
  standFor(bot, cell, world)
  const list = (standFor.all || []).slice(0, 4)
  if (!list.length) return { ok: false, reason: 'негде встать' }
  let last = null
  for (const st of list) {
    if (!(await standAt(session, ctl, st.feet))) { last = 'не дошёл'; continue }
    const r = itemRe ? await placeItemAt(bot, new Vec3(cell.x, cell.y, cell.z), itemRe) : await placeNoBed(bot, new Vec3(cell.x, cell.y, cell.z), { timeoutMs: 1500 })
    if (r.ok) return { ok: true }
    last = r.reason
  }
  return { ok: false, reason: last }
}

async function placeHigh (session, ctl, cell, world, itemRe, plan, lap, extra: any = []) {
  const bot = session.bot
  const solidW = (x, y, z) => world.get(`${x},${y},${z}`) === 'block' || isSolid(bot.blockAt(new Vec3(x, y, z)))
  const y1 = cell.y - 1
  const up = extra.length
  const forbid = new Set([`${plan.H.x},${plan.yb},${plan.H.z}`, `${plan.F.x},${plan.yb},${plan.F.z}`])
  // столбик не на окопе бота (и не рядом с ним по оси взгляда — заслоны/окоп)
  if (plan.B) for (let y = y1 - 6; y <= y1 + 2; y++) forbid.add(`${plan.B.x},${y},${plan.B.z}`)
  // 1) опора под клеткой: путь по ярусу y1 от твёрдого (BFS ≤ 4 шагов, r ≤ 3.5)
  const chainHigh = []
  if (!solidW(cell.x, y1, cell.z)) {
    const start = `${cell.x},${cell.z}`
    const prev = new Map([[start, null]])
    let q = [start]; let found = null
    for (let d = 0; d < 4 && q.length && !found; d++) {
      const nq = []
      for (const k of q) {
        const [x, z] = k.split(',').map(Number)
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx; const nz = z + dz; const nk = `${nx},${nz}`
          if (prev.has(nk) || Math.hypot(nx + 0.5, nz + 0.5) > 4) continue
          prev.set(nk, k)
          if (solidW(nx, y1, nz)) { found = nk; break }
          if (!isAirish(bot.blockAt(new Vec3(nx, y1, nz)))) continue
          nq.push(nk)
        }
        if (found) break
      }
      q = nq
    }
    if (!found) return { ok: false, reason: 'опору под клеткой не к чему прислонить' }
    // клетки пути от соседа найденного твёрдого до клетки под целью
    for (let k = prev.get(found); k; k = prev.get(k)) chainHigh.push(k)
  }
  const Ptop = plan.P ?? plan.yb + 1
  // ярус ниже верха столба — с земли к боковым граням; выше — со столбика (снизу не дотянуться)
  if (y1 < Ptop) {
    for (const k of chainHigh.splice(0)) {
      const [x, z] = k.split(',').map(Number)
      if (solidW(x, y1, z)) continue
      const r = await placeFrom(session, ctl, { x, y: y1, z }, world, FILLER_RE)
      if (!r.ok) return { ok: false, reason: `опора ${x},${y1},${z}: ${r.reason}` }
      world.set(`${x},${y1},${z}`, 'block'); lap.scaffold = (lap.scaffold || 0) + 1
    }
  }
  for (const k of chainHigh) { const [x, z] = k.split(',').map(Number); for (let y = y1; y <= y1 + 2; y++) forbid.add(`${x},${y},${z}`) }
  // 2) столбик рядом: ноги на y1, верх опоры виден
  let tower = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const tx = cell.x + dx; const tz = cell.z + dz
    if (tx === 0 && tz === 0) continue
    let bad = false
    for (let y = y1; y <= y1 + 2 + up; y++) if (forbid.has(`${tx},${y},${tz}`) || world.get(`${tx},${y},${tz}`) === 'block') bad = true
    if (bad) continue
    const s = surfaceY(virtualBot(bot, world), tx + 0.5, tz + 0.5, y1)
    if (!s || s.y > y1 || s.y < y1 - 5) continue
    let clear = true
    for (let y = s.y; y <= y1 + 2 + up; y++) { const b = bot.blockAt(new Vec3(tx, y, tz)); if (b && isSolid(b) && world.get(`${tx},${y},${tz}`) !== 'air') { clear = false; break } }
    if (!clear) continue
    const wT = new Map(world)
    for (let y = s.y; y < y1 + up; y++) wT.set(`${tx},${y},${tz}`, 'block')
    for (const k of chainHigh) { const [x, z] = k.split(',').map(Number); wT.set(`${x},${y1},${z}`, 'block') }
    const eye = new Vec3(tx + 0.5, y1 + up + SNEAK_EYE, tz + 0.5)
    if (!pick.faceAim(virtualBot(bot, wT), new Vec3(cell.x, y1, cell.z), new Vec3(0, 1, 0), { eye, avoid: [] })) continue
    // клетки сверху — каждая к верхней грани предыдущей, с того же места
    let upOk = true
    for (let i = 0; i < up && upOk; i++) { wT.set(`${cell.x},${cell.y + i},${cell.z}`, 'block'); if (!pick.faceAim(virtualBot(bot, wT), new Vec3(cell.x, cell.y + i, cell.z), new Vec3(0, 1, 0), { eye, avoid: [] })) upOk = false }
    if (!upOk) continue
    tower = { x: tx, z: tz, ground: s.y }
    break
  }
  if (!tower) return { ok: false, reason: 'некуда поставить столбик' }
  // наверху голова открыта. Раньше — только пока дракон кружит (HOLDING); у фонтана он то и дело заходит с фаерболом
  const calm = () => {
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : PHASE.HOLDING
    if (ph === PHASE.HOLDING) return !fbAlarm(bot) && !hazardNow(bot)
    if (!TOWER_FAR || !dd || (ph !== PHASE.STRAFE && ph !== PHASE.APPROACH)) return false
    const me = bot.entity.position
    if (Math.hypot(dd.position.x - me.x, dd.position.z - me.z) < TOWER_FAR) return false
    return !fireballsOf(bot).length && !hazardNow(bot)
  }
  if (!calm()) return { ok: false, reason: 'дракон не кружит' }
  doing(ctl, 'pillar:tower')
  lap.towerAt = [tower.x, tower.ground, tower.z, up]
  if (!(await standAt(session, ctl, new Vec3(tower.x + 0.5, tower.ground, tower.z + 0.5)))) { lap.towerMiss = standAt.why; return { ok: false, reason: 'к столбику не дошёл' } }
  if (!calm()) return { ok: false, reason: 'дракон не кружит' }
  const abortIf = () => hunters(bot, 5).length ? 'эндермен бьёт' : bot.health < 10 ? 'мало хп' : !calm() ? 'дракон не кружит' : null
  const t = await fastTower(bot, ctl, y1 + up, { maxMs: 12000, abortIf })
  lap.tower = { ok: t.ok, placed: t.placed, why: t.why || null }
  let r: any = { ok: false, reason: `столбик: ${t.why}` }
  if (Math.floor(bot.entity.position.y + 0.01) >= y1 + up) {
    r = { ok: true }
    for (const k of chainHigh) {
      const [x, z] = k.split(',').map(Number)
      if (solidW(x, y1, z)) continue
      const rc = await placeItemAt(bot, new Vec3(x, y1, z), FILLER_RE)
      if (!rc.ok) { r = { ok: false, reason: `опора ${x},${y1},${z} со столбика: ${rc.reason}` }; break }
      world.set(`${x},${y1},${z}`, 'block'); lap.scaffold = (lap.scaffold || 0) + 1
    }
    if (r.ok) r = await placeItemAt(bot, new Vec3(cell.x, cell.y, cell.z), itemRe)
    for (const e of extra) {
      if (!r.ok) break
      world.set(`${cell.x},${cell.y},${cell.z}`, 'block')
      r = await placeItemAt(bot, new Vec3(e.x, e.y, e.z), e.filler ? FILLER_RE : itemRe)
      if (r.ok) { world.set(`${e.x},${e.y},${e.z}`, 'block'); lap.placed.push([e.x, e.y, e.z]); e.done = true } else r = { ...r, reason: `над ней ${e.x},${e.y},${e.z}: ${r.reason}` }
    }
  }
  // вниз — всегда (раньше тот же abortIf с «не кружит» оставлял бота на столбике под фаерболом)
  await digDownTo(bot, ctl, tower.ground, 8, () => hunters(bot, 5).length ? 'эндермен бьёт' : null).catch(() => {})
  return r
}

async function runnerClean (session, ctl, plan) {
  const bot = session.bot
  const P = plan.P, s = plan.F.z, G = plan.G
  const cells = []
  for (let y = P - 2; y >= G; y--) cells.push(new Vec3(0, y, s))
  for (let y = G + 1; y >= G; y--) cells.push(new Vec3(0, y, 2 * s))
  const filled = () => cells.filter(c => { const b = bot.blockAt(c); return b && FILLER_RE.test(b.name) })
  let n = 0
  for (let k = 0; k < 8 && filled().length; k++) {
    const q = bot.entity.position
    const under = new Vec3(Math.floor(q.x), Math.floor(q.y + 0.01) - 1, Math.floor(q.z))
    const top = filled().sort((a, b) => b.y - a.y)[0]
    if (filled().some(c => c.equals(under))) { await digDownTo(bot, ctl, under.y, 1, () => hunters(bot, 5).length ? 'эндермен' : null).catch(() => {}); n++; continue }
    const b = bot.blockAt(top)
    const eye = q.offset(0, EYE, 0)
    if (eye.distanceTo(top.offset(0.5, 0.5, 0.5)) > 4.3) { await walkTo(session, ctl, new Vec3(top.x + 0.5, G, top.z + 0.5), { range: 2.5, timeoutMs: 6000, portal: true }).catch(() => {}); continue }
    try { const tool = findItem(bot, /_pickaxe$/); if (tool) await bot.equip(tool, 'hand'); await build.withTimeout(bot.dig(b, true, 'raycast'), 3000); n++ } catch (e) { bot.stopDigging(); break }
  }
  return { cleared: n, left: filled().length }
}

async function pillarBuild (session, ctl, stats, plan) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  const lap: any = { placed: [], scaffold: 0 }
  const res = r => { ev('pillarBuild', { ok: r.ok, why: r.why || null, ms: gameClock.now() - t0, ...lap }); return r }
  const OBS_RE = /^(obsidian|crying_obsidian)$/
  const runner = runnerOn() && plan.runner
  const cells = runner ? plan.cells.filter(c => OBS_RE.test(c[3])).map(c => ({ x: c[0], y: c[1], z: c[2] })) : []
  for (const c of plan.supCob || []) cells.push({ x: c[0], y: c[1], z: c[2], filler: true })
  for (const c of plan.sup || []) cells.push({ x: c[0], y: c[1], z: c[2] })
  if (plan.place.obsidian) cells.push({ x: plan.place.K.x, y: plan.place.K.y, z: plan.place.K.z })
  for (const o of plan.obs) cells.push({ x: o[0], y: o[1], z: o[2] })
  if (countOf(bot, OBS_RE) < cells.filter(c => !c.filler && !OBS_RE.test((bot.blockAt(new Vec3(c.x, c.y, c.z)) || {}).name || '')).length) return res({ ok: false, why: 'мало обсидиана' })
  const world = new Map()
  // Частичная/готовая R: не ставить уже имеющиеся обсидианы, даже при пустом рюкзаке.
  const left = cells.filter(c => {
    if (!runner || !OBS_RE.test((bot.blockAt(new Vec3(c.x, c.y, c.z)) || {}).name || '')) return true
    world.set(`${c.x},${c.y},${c.z}`, 'block'); return false
  })
  // Бьёт эндермен или мало хп — бросить стройку, пусть бой отобьётся/поест (pil6-20: смерть в окопе — эндермен
  const abortIf = () => { if (hunters(bot, 5).length) return 'эндермен бьёт'; if (bot.health < 10) return 'мало хп'; const hz = hazardNow(bot); return hz ? `опасно: ${hz.kind || 'угроза'}` : null }
  for (let guard = 0; left.length && guard < 20; guard++) {
    // st2-s5: одна стройка шла 74.6 с (до 4 мест ставки × 3 маршрута по 9 с) — дольше BUILD_MAX — бросить, план заново
    if (BUILD_MAX_MS && gameClock.now() - t0 > BUILD_MAX_MS) return res({ ok: false, why: 'стройка долго' })
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : null
    if ((ph === PHASE.APPROACH && !approachFar(dd)) || ph === PHASE.LANDING || SITTING.has(ph)) return res({ ok: false, why: 'дракон садится — потом' })
    const stopWhy = abortIf()
    if (stopWhy) return res({ ok: false, why: stopWhy })
    // клетка, которую можно поставить сейчас (есть сосед с видимой гранью откуда-то)
    let pick0 = null
    // клетка на высоте верха столба и выше (подушка над столбом) — со столбика, не «лесом»
    const Ptop = plan.P ?? plan.yb + 1
    for (const c of left) { if (c.y >= Ptop) continue; const st = standFor(bot, c, world); if (st) { pick0 = { c, st }; break } }
    const hi = !pick0 && left.find(c => c.y >= Ptop)
    if (hi) {
      // R: клетки над hi (K на P + 1) — с того же столбика
      const extra = []
      if (runner && RUN_TOWER1()) for (let y = hi.y + 1; ; y++) { const e = left.find(c => c.x === hi.x && c.z === hi.z && c.y === y); if (!e) break; extra.push(e) }
      const r = await placeHigh(session, ctl, hi, world, hi.filler ? FILLER_RE : OBS_RE, plan, lap, extra)
      for (const e of extra) if (e.done) left.splice(left.indexOf(e), 1)
      if (!r.ok) return res({ ok: false, why: `высоко ${hi.x},${hi.y},${hi.z}: ${r.reason}` })
      world.set(`${hi.x},${hi.y},${hi.z}`, 'block'); lap.placed.push([hi.x, hi.y, hi.z])
      left.splice(left.indexOf(hi), 1)
      continue
    }
    if (!pick0) {
      // лес: под первой клеткой — столбик булыжника от твёрдого снизу
      const c = left[0]
      let y = c.y - 1
      while (y > c.y - 6 && !isSolid(bot.blockAt(new Vec3(c.x, y, c.z)))) y--
      if (y <= c.y - 6) return res({ ok: false, why: `клетке ${c.x},${c.y},${c.z} не к чему прислониться` })
      const sc = { x: c.x, y: y + 1, z: c.z }
      const r = await placeFrom(session, ctl, sc, world, null)
      if (!r.ok) return res({ ok: false, why: `лес: ${r.reason}` })
      world.set(`${sc.x},${sc.y},${sc.z}`, 'block'); lap.scaffold++
      continue
    }
    const { c } = pick0
    const r = await placeFrom(session, ctl, c, world, c.filler ? FILLER_RE : OBS_RE)
    if (!r.ok) { lap.faceFail = (lap.faceFail || 0) + 1; if (lap.faceFail > 2) return res({ ok: false, why: `обсидиан ${c.x},${c.y},${c.z}: ${r.reason}` }); continue }
    world.set(`${c.x},${c.y},${c.z}`, 'block'); lap.placed.push([c.x, c.y, c.z])
    left.splice(left.indexOf(c), 1)
  }
  if (left.length) return res({ ok: false, why: 'не всё поставлено' })
  if (runner) {
    const cl0 = await runnerClean(session, ctl, plan)
    if (cl0.cleared || cl0.left) lap.clean = cl0
    if (cl0.left) return res({ ok: false, why: `R: в чаше свои блоки (${cl0.left})` })
  }
  if (runner) for (const c of plan.cells.filter(c => c[3] === 'air')) {
    const pos = new Vec3(c[0], c[1], c[2]), b = bot.blockAt(pos)
    if (b && /^(air|cave_air|void_air)$/.test(b.name)) continue
    // свой блок (рефлекс от облака кладёт булыжник под ноги — rs8-s1: бот стоял в клетке факела на своём блоке) — снять, как факел
    if (!b || !(/^(torch|wall_torch)$/.test(b.name) || FILLER_RE.test(b.name))) return res({ ok: false, why: `R: клетка факела занята (${b && b.name})` })
    const stopWhy = abortIf()
    if (stopWhy) return res({ ok: false, why: stopWhy })
    if (!(await standAt(session, ctl, plan.feet))) { lap.torchMiss = standAt.why; return res({ ok: false, why: 'R: к факелу не дошёл' }) }
    if (bot.entity.position.offset(0, EYE, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.5) return res({ ok: false, why: 'R: факел далеко' })
    try {
      const tool = findItem(bot, /_pickaxe$/)
      if (tool) await bot.equip(tool, 'hand'); else await bot.unequip('hand')
      // mineflayer digging.js: raycast выбирает реально видимую грань, torch hardness=0; свой булыжник — киркой (~0.5 с)
      await build.withTimeout(bot.dig(b, true, 'raycast'), FILLER_RE.test(b.name) ? 3000 : 1500)
    } catch (e) { bot.stopDigging(); return res({ ok: false, why: 'R: факел: ' + e.message }) }
    if (!/^(air|cave_air|void_air)$/.test((bot.blockAt(pos) || {}).name || '')) return res({ ok: false, why: 'R: факел остался' })
    lap.torch = [c[0], c[1], c[2]]
  }
  // Окоп A / готовая чаша R (depth 0).
  const tr = await tsTrench(bot, ctl, { B: plan.B, G: plan.G, depth: plan.dig, portal: true, runner, abortIf, feet: plan.feet }, k => doing(ctl, 'pillar:' + k), session)
  if (!tr.ok) lap.trench = { why: tr.why, ...(tr.lap || {}) }
  if (!tr.ok && /эндермен|мало хп|опасно/.test(tr.why || '')) return res({ ok: false, why: tr.why })
  if (!tr.ok) {
    // окоп не той глубины / не по центру — но с этого места станция годится? (pil5: «не спустился» ×9)
    const here = pillarHere(bot, plan)
    if (!here) return res({ ok: false, why: `окоп: ${tr.why}` })
    lap.here = { y: here.feet.y, expo: r1(here.expo * 100) / 100 }
    plan.feet = here.feet; plan.dig = Math.max(0, plan.G - here.feet.y); plan.G = here.feet.y + plan.dig
  }
  ctl.pillar = { plan, built: true, t: gameClock.now(), booms: 0 }
  return res({ ok: true })
}

async function pillarEnter (session, ctl, plan) {
  const bot = session.bot
  // R: рефлекс мог сложить свои блоки в чаше после постройки станции — снять до входа
  if (runnerOn() && plan.runner && !hunters(bot, 5).length) { const cl = await runnerClean(session, ctl, plan); if (cl.cleared && ctl.trace) ctl.trace.ev('runnerClean', cl) }
  const q = bot.entity.position
  const inB = Math.floor(q.x) === plan.B.x && Math.floor(q.z) === plan.B.z && Math.abs(q.y - plan.feet.y) < 0.3
  if (inB) return true
  if (pillarHere(bot, plan)) return true
  if (hunters(bot, 5).length) return false
  const bc = new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5)
  // 03.10: от точки выстрела по кристаллам (до 30 от центра) — бегом и с запасом по времени (ND_ENTER_RUN=0 — шагом, 8 с)
  const farB = Math.hypot(q.x - bc.x, q.z - bc.z)
  const runE = envv('ND_ENTER_RUN') !== '0' && farB > 8
  await walkTo(session, ctl, bc, { range: 0.5, timeoutMs: runE ? Math.min(16000, 6000 + farB * 300) : 8000, portal: true, sprint: runE })
  const tr = await tsTrench(bot, ctl, { B: plan.B, G: plan.G, depth: plan.dig, portal: true, runner: runnerOn() && plan.runner, feet: plan.feet, abortIf: () => hunters(bot, 5).length ? 'эндермен бьёт' : null }, k => doing(ctl, 'pillar:' + k), session)
  return tr.ok || !!pillarHere(bot, plan)
}

export {
  standAt, placeFrom, placeHigh, runnerClean, pillarBuild, pillarEnter
}
