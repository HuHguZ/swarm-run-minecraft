const { dragonOf, gameClock, clearControls, phaseOf, PHASE, SITTING, CENTER, sleep, makeTrack, Vec3, isSolid, stepTo, digDownTo, items, build, HEAD_AHEAD, partsOf, cloudsOf, nearPortal, voidBelow, overlap, BREATH_R, CLOUD_SLAB, EYE, findItem, isAirish, dbg, pearlHop, FILLER_RE, starer, LABENV, runnerOn }: typeof import('./dig-down-to') = require('./dig-down-to')
const { blindTried, platformInner }: typeof import('./bridge-to-island') = require('./bridge-to-island')
const { sight, doing, nearEdge, podiumTop, pickSpot, nearPillar, r1, breathOf, inClouds, standY, fastTower, angryEndermen, embeddedNow, unembed, hunters }: typeof import('./fall-guard') = require('./fall-guard')
const { hazardNow, walkTo, guard, heal, ocLanding, bedsLayout, walkAround, bedsGo, makeDragonFeed, pillarRun, pillarEnter }: typeof import('./pillar-run') = require('./pillar-run')
const { evade, predParts, countOf, dangerAt, bedDamage }: typeof import('./evade-raw') = require('./evade-raw')
const { OC_ON, bedsBuild, takeoffSeen, pillowDys, pillarPlan, pillarKey, portalBlocks, runnerPlan }: typeof import('./pillar-plan') = require('./pillar-plan')
const { placeNoBed, AXES }: typeof import('./ts-plan') = require('./ts-plan')
const { groundAt, pillarPlanAutoAsync, pillarHere }: typeof import('./station-plan') = require('./station-plan')
async function blindPit (session, ctl, stats, deadline) {
  const bot = session.bot
  const d0 = dragonOf(bot)
  if (!d0 || !bot.entity || !bot.entity.onGround) return
  const key = d0.id + ':' + bot.entity.id
  if (blindTried.has(key) || sight.get(key)) return
  blindTried.add(key)
  const ev = (k, v) => { if (ctl.trace) ctl.trace.ev(k, v) }
  doing(ctl, 'blind:await-approach')
  let ok = false
  while (!ctl.aborted && bot.health > 0 && gameClock.now() < deadline - 15000) {
    clearControls(bot)
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : null
    if (ph === PHASE.APPROACH || ph === PHASE.LANDING) { ok = true; break }
    if (SITTING.has(ph)) { ev('blind', { r: 'пропустил посадку' }); return }
    const me = bot.entity.position
    const danger = hazardNow(bot)
    if (danger) await evade(bot, ctl, stats, danger)
    else {
      // Ждать в кольце 9.5–12.5 от центра: яма там (глубина 3) — в ≤ 16 от сидящего по 3D
      const fromC = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
      // (Пока кружит — дальше, 13–16: у фонтана заходов с фаерболом вдвое больше; к яме —
      // ближе, перед копанием.)
      if (fromC > 16.5 || fromC < 12.5 || nearEdge(bot, me, 2)) {
        const P0 = podiumTop(bot)
        const spot = pickSpot(bot, CENTER, { rMin: 13, rMax: 16, step: 0.75, prefer: me, avoid: f => nearPillar(bot, f, 3) || (P0 != null && f.y > P0 - 2.5) })
        if (spot) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 12000 })
      } else { await guard(session, ctl); await heal(session, ctl, null, stats) }
    }
    await sleep(100)
  }
  if (!ok) { ev('blind', { r: 'не дождался захода' }); return }
  // Яму — там, где будет стоять первая кровать посадки (A): ждём снижения и прогноза
  if (OC_ON && ctl.feed) {
    doing(ctl, 'blind:await-forecast')
    const tw = gameClock.now()
    let fc = null
    while (!ctl.aborted && gameClock.now() - tw < 45000) {
      const dd = dragonOf(bot)
      const ph = dd ? phaseOf(bot, dd) : null
      if (SITTING.has(ph) || !dd) break
      const f = ctl.feed.fc
      if (ph === PHASE.LANDING && f && f.id === dd.id && gameClock.now() - f.t < 400 && f.n >= 70) { fc = f; break }
      const danger = hazardNow(bot)
      if (danger) await evade(bot, ctl, stats, danger)
      await sleep(100)
    }
    // Сперва — кровать L из окопа с крышкой (ослепит и не потеряет первую посадку); не вышло
    if (fc && process.env.ND_OC_LID === '1') {
      const tw2 = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tw2 < 15000) {
        const f = ctl.feed.fc
        const left = f ? f.n - (gameClock.now() - f.t) / 50 : 999
        const ddw = dragonOf(bot)
        if (!ddw || SITTING.has(phaseOf(bot, ddw))) break
        if (f && gameClock.now() - f.t < 400 && left <= 185) break
        const danger = hazardNow(bot)
        if (danger) await evade(bot, ctl, stats, danger)
        await sleep(60)
      }
      const r = await ocLanding(session, ctl, null, stats, makeTrack(bot), ctl.feed, { blindLid: true })
      const fv = ctl.feed.fc
      ev('blind:viaL', { ok: !!r, blind: sight.get(key) || null, n: fv ? Math.round(fv.n - (gameClock.now() - fv.t) / 50) : null })
      if (sight.get(key) === 'blind') return
      const f = ctl.feed.fc
      const dd0 = dragonOf(bot)
      if (!dd0 || SITTING.has(phaseOf(bot, dd0))) return
      fc = f && gameClock.now() - f.t < 500 && f.n - (gameClock.now() - f.t) / 50 > 75 ? f : null
      if (!fc) { ev('blind', { r: 'после L — не успеть с ямой' }); return }
    }
    if (fc) {
      const dd = dragonOf(bot)
      const plan = dd && bedsLayout(bot, dd, predParts(fc), { headAt: fc.head, noTurn: true, brave: true, cap: 46 })
      // Только близко (≤ 9 шагов) и если после дороги до посадки ещё ≥ 4 с на яму: иначе —
      // яма на месте (oc5-19: шёл к месту 12 с, крышка встала уже после посадки — видящий).
      const spot = plan && new Vec3(plan.B.x + 0.5, plan.y, plan.B.z + 0.5)
      const far = spot ? Math.hypot(spot.x - bot.entity.position.x, spot.z - bot.entity.position.z) : 99
      if (plan && far <= 9 && fc.n - (gameClock.now() - fc.t) / 50 > 80 + far * 5) {
        ev('blind:spot', { n: fc.n, feet: [r1(plan.feet.x), plan.feet.y, r1(plan.feet.z)], expect: plan.expect, far: r1(far) })
        doing(ctl, 'blind:go-spot')
        await walkAround(session, ctl, spot, { timeoutMs: Math.min(3500, Math.max(1000, (fc.n - 80) * 50 - (gameClock.now() - fc.t))) })
        // Кровать A и заслон — сейчас (снижающийся их не заденет: голова в G + 2.9 и выше,
        // кровать — на земле), яма — под собой на месте стоящего у A: вылез — и щелчок.
        const left = () => fc.n - (gameClock.now() - fc.t) / 50
        const at = bot.entity.position
        if (left() > 90 && Math.floor(at.x) === plan.B.x && Math.floor(at.z) === plan.B.z) {
          await bedsGo(session, ctl, plan, true, predParts(fc))
          ctl.holdStation = true
          let b
          try { b = await bedsBuild(session, ctl, stats, plan) } finally { ctl.holdStation = false }
          ev('blind:A', { ok: b.ok, why: b.why || null, left: Math.round(left()) })
        }
      } else ev('blind:spot', { no: plan ? `далеко ${r1(far)}` : bedsLayout.why })
    }
  }
  {
    const m = bot.entity.position
    if (Math.hypot(m.x - CENTER.x, m.z - CENTER.z) > 13) {
      const P0 = podiumTop(bot)
      const spot = pickSpot(bot, CENTER, { rMin: 9.5, rMax: 12, step: 0.75, prefer: m, avoid: f => nearPillar(bot, f, 3) || (P0 != null && f.y > P0 - 2.5) })
      if (spot) await walkAround(session, ctl, spot.feet, { timeoutMs: 4000 })
      if (spot && Math.hypot(bot.entity.position.x - CENTER.x, bot.entity.position.z - CENTER.z) > 14) await walkTo(session, ctl, spot.feet, { range: 1, timeoutMs: 6000 }).catch(() => {})
      if (Math.hypot(bot.entity.position.x - CENTER.x, bot.entity.position.z - CENTER.z) > 14) { ev('blind', { r: 'далеко от центра для ямы' }); return }
    }
  }
  const start = bot.entity.position.floored()
  // Яма в 3: крышка — в яме на уровне головы (feet + 2), у неё стены с четырёх сторон
  // (в 2 блока крышке не к чему прислониться: сверху — воздух у поверхности).
  for (let i = 1; i <= 4; i++) {
    const b = bot.blockAt(start.offset(0, -i, 0))
    if (!b || !isSolid(b) || !/end_stone|cobble|stone|dirt|netherrack/.test(b.name)) { ev('blind', { r: 'нет земли под ямой', i }); return }
  }
  doing(ctl, 'blind:dig')
  // Копать под собой — только стоя целиком над клеткой (иначе тело висит на краю: oc12 —
  // «не спустился до земли», яма в 0, видящий дракон).
  const cc = start.offset(0.5, 0, 0.5)
  const centred = () => { const q = bot.entity.position; return Math.max(Math.abs(q.x - cc.x), Math.abs(q.z - cc.z)) <= 0.18 }
  for (let k = 0; k < 5 && !centred(); k++) { await stepTo(bot, ctl, cc, { ms: 700, sprint: false, stopAt: 0.05 }); clearControls(bot); await sleep(60) }
  let down = await digDownTo(bot, ctl, start.y - 3, 3)
  if (Math.floor(bot.entity.position.y + 0.01) > start.y - 3) {
    bot.setControlState('sneak', false)
    const c2 = bot.entity.position.floored().offset(0.5, 0, 0.5)
    for (let k = 0; k < 3; k++) { await stepTo(bot, ctl, c2, { ms: 600, sprint: false, stopAt: 0.05 }); clearControls(bot) }
    down = await digDownTo(bot, ctl, start.y - 3, 3)
  }
  const lidPos = bot.entity.position.floored().offset(0, 2, 0)
  const lid = await placeNoBed(bot, lidPos, { timeoutMs: 2000 })
  const depth = start.y - Math.floor(bot.entity.position.y + 0.01)
  ev('blind:sealed', { depth, lid: !!lid.ok, down: down.why })
  let sat = 0; let roared = false
  doing(ctl, 'blind:wait')
  while (!ctl.aborted && bot.health > 0 && depth >= 3 && lid.ok && gameClock.now() < deadline - 15000) {
    clearControls(bot)
    const dd = dragonOf(bot)
    if (!dd) break
    const ph = phaseOf(bot, dd)
    if (ph === PHASE.ROARING || ph === PHASE.FLAMING) { roared = true; break }
    // Сел: первое «высматривает» (мы в 20) уже спросило Sensing — через 3 тика выходим.
    if (SITTING.has(ph)) { if (!sat) sat = gameClock.now(); if (gameClock.now() - sat > 150) break }
    if (!SITTING.has(ph) && ph !== PHASE.LANDING && ph !== PHASE.APPROACH) break
    await sleep(25)
  }
  ev('blind:result', { sat: !!sat, roared })
  if (sat && !roared) sight.set(key, 'blind')
  doing(ctl, 'blind:exit')
  const cover = bot.blockAt(lidPos)
  if (!ctl.aborted && cover && isSolid(cover)) {
    await items.equipBestTool(bot, cover)
    await build.withTimeout(bot.dig(cover, true), 4000).catch(() => {})
  }
  if (!ctl.aborted && bot.health > 0) await build.towerUp(bot, ctl, depth).catch(() => {})
}

function takeoffAzOf (d) {
  const r = takeoffSeen.get(d.id)
  if (!r || !r.az.length) return null
  let best = null
  for (const a of r.az) {
    const n = r.az.filter(b => Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) < 0.45).length
    if (!best || n > best.n) best = { a, n }
  }
  return best.a
}

function headAfterTakeoff (d, parts) {
  const az = takeoffAzOf(d)
  if (az == null) return null
  const face = Math.atan2(parts.dir.z, parts.dir.x)
  const need = Math.atan2(Math.sin(az - face), Math.cos(az - face))
  const rot = Math.sign(need) * Math.min(Math.abs(need), 32 * Math.PI / 180)
  const a = face + rot
  return new Vec3(d.position.x + Math.cos(a) * HEAD_AHEAD, parts.head.min.y + 0.4, d.position.z + Math.sin(a) * HEAD_AHEAD)
}

const CARD4 = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]

function pillarPlanAuto (bot, P, bad = null) {
  const obsHave = countOf(bot, /^(obsidian|crying_obsidian)$/)
  // выше P + 1 из окопа не дотянуться (до грани опоры > 4.5) — не считать: перебор впустую — секунды стоящего тела
  const dys = pillowDys()
  for (const dy of dys) {
    const p = pillarPlan(bot, P, { dy })
    if (!p) continue
    const all = (pillarPlan.all || []).filter(q => q.nObs <= obsHave && !(bad && (bad.get(pillarKey(q)) || 0) >= 2))
    if (all.length) return all[0]
  }
  return null
}

function headPlan (bot, d, track, { breathSafe = true }: any = {}) {
  const parts = partsOf(bot, d, track)
  const hp = new Vec3(parts.headC.x, parts.head.min.y, parts.headC.z)
  // коробки задевают кровать и EnderDragon.checkWalls сносит её каждый тик
  const yb = Math.floor(hp.y - 0.87)
  const breath = breathOf(bot, d, parts)
  const clouds = cloudsOf(bot)
  const me = bot.entity.position
  const zones = { clouds, fireballs: [], parts, sweep: { pos: d.position, dir: parts.dir } }
  let best = null
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  const cells = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [ox, oz] of cells) {
    const hx = Math.floor(hp.x) + ox; const hz = Math.floor(hp.z) + oz
    const blast = new Vec3(hx + 0.5, yb + 0.5, hz + 0.5)
    const dist = blast.distanceTo(hp)
    if (dist > 2.2) continue
    for (const D of AXES) {
      // Стоять — перед мордой, по её взгляду: сбоку дракон доворачивает к нам
      if (D.x * parts.dir.x + D.z * parts.dir.z < 0.5) continue
      const at = k => ({ x: hx + D.x * k, z: hz + D.z * k })
      // Как у готовой станции: F, две стенки (H+2, H+3), стоим на H+4. Облако
      const F = at(1); const W = at(2); const W2 = at(3); const B = at(4)
      const g = groundAt(bot, B.x, B.z, yb - 2)
      if (g == null) { no('земля'); continue }
      if (yb - g < 1 || yb - g > 3) { no('высота'); continue }
      const feet = new Vec3(B.x + 0.5, g, B.z + 0.5)
      if (nearPortal(feet)) { no('портал'); continue }
      if (voidBelow(bot, feet.x, g, feet.z, 6) || nearEdge(bot, feet, 2)) { no('край'); continue }
      const air = (x, y, z, bedOk?: any) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && ((bedOk && /_bed$/.test(b.name)) || (!isSolid(b) && !/portal|gateway|lava/.test(b.name))) }
      if (!air(hx, yb, hz, true) || !air(F.x, yb, F.z, true)) { no('клетки кровати'); continue }
      if (!air(B.x, g, B.z) || !air(B.x, g + 1, B.z)) { no('место стоянки'); continue }
      // Кровать не должна войти в коробки головы, шеи и тела (checkWalls ломает).
      const bedBox = { min: new Vec3(Math.min(hx, F.x), yb, Math.min(hz, F.z)), max: new Vec3(Math.max(hx, F.x) + 1, yb + 0.5625, Math.max(hz, F.z) + 1) }
      if (overlap(bedBox, parts.head) || overlap(bedBox, parts.neck) || overlap(bedBox, parts.body)) { no('в драконе'); continue }
      // Место стоянки: не у головы и шеи, не под крылом (толкает), не в облаке.
      const bad = dangerAt(bot, feet, { ...zones, breath: null })
      if (bad && !/дуга/.test(bad.kind)) { no(bad.kind); continue }
      if (Math.hypot(feet.x - d.position.x, feet.z - d.position.z) < 6) { no('у тела'); continue }
      if (inClouds(clouds, feet, 1.2)) { no('облако'); continue }
      // Облако огня: ляжет на верх первого непустого под головой в своём
      // столбце — если это наша стенка/опора (станем их строить), оно выше нас.
      const bc = breath.column
      const raised = [W, W2, F].some(c => bc.x === c.x && bc.z === c.z)
      if (breathSafe && !raised && Math.hypot(feet.x - breath.pos.x, feet.z - breath.pos.z) < BREATH_R + 0.8 && feet.y < breath.pos.y + CLOUD_SLAB + 0.1) { no('будет облако огня'); continue }
      // Что поставить: пол под B, F и W; опора F до yb−1; стенка W в два блока.
      const place = []
      const want = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); if (b && !isSolid(b)) place.push(new Vec3(x, y, z)) }
      for (const c of [B, W, W2, F]) if (!voidBelow(bot, c.x + 0.5, g, c.z + 0.5, 6)) want(c.x, g - 1, c.z)
      for (let y = g; y <= yb - 1; y++) want(F.x, y, F.z)
      for (const c of [W, W2]) for (let y = g; y <= g + 1; y++) want(c.x, y, c.z)
      // Изножье — в досягаемости руки от глаз на B (4.5, с запасом 4.3).
      if (feet.offset(0, EYE, 0).distanceTo(new Vec3(F.x + 0.5, yb + 0.5, F.z + 0.5)) > 4.3) { no('не дотянуться'); continue }
      const walk = feet.distanceTo(me)
      const cost = dist * 3 + place.length * 0.6 + walk * 0.4
      if (!best || cost < best.cost) {
        best = {
          ok: true, key: `голова ${hx},${hz} ${D.x},${D.z}`, a: D, yb, g, dynamic: true,
          B: feet, H: new Vec3(hx, yb, hz), F: new Vec3(F.x, yb, F.z), support: new Vec3(F.x, yb - 1, F.z),
          blast, place, dist, cost, expect: bedDamage(dist)
        }
      }
    }
  }
  if (!best) headPlan.why = why
  return best
}
declare namespace headPlan {
  let why: any
}

async function collectXp (session, ctl, ms = 6000) {
  const bot = session.bot
  const t0 = gameClock.now()
  const xp0 = bot.experience ? bot.experience.points : 0
  while (!ctl.aborted && gameClock.now() - t0 < ms) {
    // Опыт сыплется над порталом: за шаром в портал не шагать (унесёт домой).
    const orb = bot.nearestEntity(e => e && e.name === 'experience_orb' && e.position && e.position.distanceTo(bot.entity.position) < 16 &&
      Math.hypot(e.position.x - CENTER.x, e.position.z - CENTER.z) > 6.5)
    if (!orb) { await sleep(250); continue }
    // Шагом, не бегом: шары сами летят к игроку в 8 блоках, а разбег у края
    // портала заносит в него (прогон 2026-09-25: тело ушло домой само).
    await stepTo(bot, ctl, orb.position, { ms: 800, stopAt: 0.8, sprint: false })
  }
  return bot.experience ? bot.experience.points - xp0 : null
}

function eggItem (bot, r = 24) {
  const me = bot.entity.position
  return bot.nearestEntity(e => {
    if (!e || e.name !== 'item' || !e.position || e.position.distanceTo(me) > r) return false
    try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'dragon_egg' } catch { return false }
  })
}

async function pickUp (session, ctl, item, name) {
  const bot = session.bot
  const had = countOf(bot, new RegExp(`^${name}$`))
  for (let i = 0; i < 3 && !ctl.aborted && item && item.isValid !== false; i++) {
    const at = item.position.clone()
    await stepTo(bot, ctl, at, { ms: 2500, stopAt: 0.25, sprint: false })
    if (Math.hypot(bot.entity.position.x - at.x, bot.entity.position.z - at.z) > 0.8) await walkTo(session, ctl, at, { range: 0, timeoutMs: 6000 })
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && countOf(bot, new RegExp(`^${name}$`)) <= had) await sleep(100)
    if (countOf(bot, new RegExp(`^${name}$`)) > had) break
  }
  const torch = bot.blockAt(bot.entity.position.floored())
  if (torch && /torch/.test(torch.name)) await bot.dig(torch, true).catch(() => {})
  await build.escapePit(bot, ctl, { maxClimb: 4, mcData: session.mcData }).catch(() => {})
  return countOf(bot, new RegExp(`^${name}$`)) > had
}

async function takeEgg (session, ctl, rep) {
  const bot = session.bot
  const id = bot.registry.blocksByName.dragon_egg.id
  const out: any = { pokes: 0 }
  const lying = eggItem(bot)
  if (lying) { out.lying = true; out.have = await pickUp(session, ctl, lying, 'dragon_egg'); if (!out.have) out.why = 'яйцо лежит предметом, но в рюкзак не попало'; return out }
  if (!findItem(bot, /^torch$/)) { out.why = 'нет факела — без него яйцо не взять (падая на факел, оно становится предметом)'; return out }
  const diggable = b => b && isSolid(b) && !/bedrock|obsidian|end_portal|end_gateway/.test(b.name)
  for (let attempt = 0; attempt < 5 && !ctl.aborted; attempt++) {
    const egg = bot.findBlock({ matching: id, maxDistance: 48, point: bot.entity.position })
    // Яйцо кладётся только за ПЕРВОГО дракона мира (EndDragonFight.setDragonKilled:
    // !previouslyKilled); за воскрешённого — нет.
    if (!egg) { out.why = 'яйца нет: его кладут только за первого дракона этого мира, за воскрешённого — нет'; return out }
    const E = egg.position
    out.at = { x: E.x, y: E.y, z: E.z }
    const S = E.offset(0, -1, 0); const T = E.offset(0, -2, 0); const U = E.offset(0, -3, 0)
    const sB = bot.blockAt(S); const tB = bot.blockAt(T); const uB = bot.blockAt(U)
    const fits = diggable(sB) && (diggable(tB) || isAirish(tB)) && isSolid(uB)
    // Встать рядом с яйцом, не над ямой.
    const near = pickSpot(bot, { x: E.x + 0.5, z: E.z + 0.5 }, { rMin: 2, rMax: 3, step: 1, edge: 0, nearY: E.y })
    if (near) await walkTo(session, ctl, near.feet, { range: 0.6, timeoutMs: 20000 })
    if (!fits) {
      // Ткнуть: перелетит на новое место.
      await bot.lookAt(E.offset(0.5, 0.5, 0.5), true).catch(() => {})
      await bot.activateBlock(egg).catch(() => {})
      out.pokes++
      await sleep(2000)
      continue
    }
    try {
      if (diggable(tB)) { await items.equipBestTool(bot, tB); await build.withTimeout(bot.dig(tB, true), 6000) }
      await bot.equip(findItem(bot, /^torch$/), 'hand')
      await build.withTimeout(bot.placeBlock(bot.blockAt(U), new Vec3(0, 1, 0)), 3000).catch(() => {})
      await sleep(250)
      if (!bot.blockAt(T) || !/torch/.test(bot.blockAt(T).name)) { out.why = 'факел на дно ямы не встал'; return out }
      const s2 = bot.blockAt(S)
      await items.equipBestTool(bot, s2)
      await build.withTimeout(bot.dig(s2, true), 6000)
    } catch (e) { out.why = e.message; return out }
    await sleep(1500)
    // Предмет на дне ямы: спуститься, подобрать, выбраться.
    const item = eggItem(bot, 8) || bot.nearestEntity(e => e && e.name === 'item' && e.position && e.position.distanceTo(T.offset(0.5, 0, 0.5)) < 3)
    if (item) await pickUp(session, ctl, item, 'dragon_egg')
    out.have = countOf(bot, /^dragon_egg$/) > 0
    if (!out.have) out.why = 'яйцо упало, но в рюкзак не попало'
    return out
  }
  if (!out.why) out.why = `после ${out.pokes} тычков яйцо так и не легло на копаемую землю`
  return out
}

async function goHome (session, ctl, rep) {
  const bot = session.bot
  const out: any = {}
  const blocks = portalBlocks(bot)
  if (!blocks.length) { out.why = 'выходного портала не видно — дракон жив?'; return out }
  // Из ямы (после яйца) pathfinder не выводит — сначала выбраться.
  const pit = await build.escapePit(bot, ctl, { maxClimb: 6, mcData: session.mcData }).catch(() => null)
  if (pit && pit.wasInPit) out.pit = pit
  const target = blocks.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
  // Край портала (bedrock) вровень с землёй: ходят на высоте target.y + 1. Кто
  // ниже (яма от яйца рядом с порталом) — сначала подняться столбом.
  for (let i = 0; i < 4 && !ctl.aborted && bot.entity.position.y < target.y + 0.9 && target.distanceTo(bot.entity.position) < 8; i++) {
    const t = await build.towerUp(bot, ctl, 1)
    if (!t.placed) break
  }
  const dim0 = bot.game.dimension
  ctl.homeBound = true
  let credits = false
  const onGame = (packet) => { if (packet && (packet.reason === 4 || packet.reason === 'win_game')) credits = true }
  bot._client.on('game_state_change', onGame)
  try {
    // pathfinder'у портал — не пол (blocksToAvoid): довести до края, а внутрь
    // шагнуть клавишами.
    const w = await walkTo(session, ctl, target.offset(0.5, 0, 0.5), { range: 3, timeoutMs: 25000, xz: true, portal: true })
    out.walk = w.ok ? 'дошёл до края' : w.why
    const t0 = gameClock.now()
    while (!ctl.aborted && gameClock.now() - t0 < 12000 && bot.game.dimension === dim0) {
      if (credits) {
        try { bot._client.write('client_command', bot.supportFeature('respawnIsPayload') ? { payload: 0 } : { actionId: 0 }) } catch {}
        credits = false
        out.credits = true
      }
      if (bot.game.dimension === dim0 && !credits) {
        const r = await stepTo(bot, ctl, target.offset(0.5, 0, 0.5), { ms: 1200, stopAt: 0.1, sprint: false, portal: true })
        out.step = r.why || 'ok'
      }
      await sleep(250)
    }
  } finally {
    bot._client.removeListener('game_state_change', onGame)
  }
  out.dimension = bot.game.dimension
  out.home = bot.game.dimension !== dim0
  if (!out.home) { out.target = { x: target.x, y: target.y, z: target.z }; const m = bot.entity.position; out.at = { x: +m.x.toFixed(1), y: +m.y.toFixed(1), z: +m.z.toFixed(1) } }
  return out
}

async function respawnDragon (session, ctl, rep) {
  const bot = session.bot
  const out: any = { placed: 0, sides: [] }
  const blocks = portalBlocks(bot)
  if (!blocks.length) { out.why = 'выходного портала не видно (дракон жив или портал не зажжён)'; return out }
  const Y = Math.min(...blocks.map(b => b.y))
  const cx = Math.round(blocks.reduce((a, b) => a + b.x, 0) / blocks.length)
  const cz = Math.round(blocks.reduce((a, b) => a + b.z, 0) / blocks.length)
  out.center = { x: cx, y: Y, z: cz }
  const crystalItem = () => findItem(bot, /^end_crystal$/)
  if (!crystalItem() || countOf(bot, /^end_crystal$/) < 4) { out.why = `нужно 4 end_crystal, есть ${countOf(bot, /^end_crystal$/)}`; out.need = { what: 'end_crystal', count: 4, have: countOf(bot, /^end_crystal$/) }; return out }
  // Два прохода: «ответа от сервера нет» бывает и там, где кристалл встал бы
  // со второго раза; уже стоящие второй проход засчитывает и не трогает.
  for (let pass = 0; pass < 2 && !ctl.aborted; pass++) {
  if (pass) { if (out.placed >= 4) break; out.placed = 0; out.firstPass = out.sides; out.sides = [] }
  for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
    if (ctl.aborted) break
    const rim = new Vec3(cx + dx, Y, cz + dz)
    const side: any = { at: { x: rim.x, y: rim.y, z: rim.z } }
    out.sides.push(side)
    // Уже стоит?
    if ((Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'end_crystal' && e.position && Math.abs(e.position.x - rim.x - 0.5) < 0.6 && Math.abs(e.position.z - rim.z - 0.5) < 0.6)) { side.already = true; out.placed++; continue }
    // Встать снаружи, в двух блоках от края, лицом к порталу.
    const sy = standY(bot, cx + Math.sign(dx) * 5 + 0.5, cz + Math.sign(dz) * 5 + 0.5, Y + 1, 2, 3) ?? (Y + 1)
    const stand = new Vec3(cx + Math.sign(dx) * 5 + 0.5, sy, cz + Math.sign(dz) * 5 + 0.5)
    const w = await walkTo(session, ctl, stand, { range: 1.5, timeoutMs: 20000 })
    side.dist = Math.round(bot.entity.position.offset(0, EYE, 0).distanceTo(rim.offset(0.5, 1, 0.5)) * 10) / 10
    if (!w.ok) side.walk = w.why
    // Край читать уже рядом (издали прогон увидел «stone» и «gravel» там, где
    // сервер отвечает bedrock).
    const b = bot.blockAt(rim)
    side.block = b && b.name
    if (!b || !/bedrock|obsidian/.test(b.name)) { side.why = 'край портала не bedrock'; continue }
    // Огонь над краем: кристалл держит огонь в своей клетке (EndCrystal.tick),
    const above = bot.blockAt(rim.offset(0, 1, 0))
    if (above && /fire/.test(above.name)) {
      const pl = await build.placeBlockAt(bot, rim.offset(0, 1, 0), { timeoutMs: 3000 })
      const fb = bot.blockAt(rim.offset(0, 1, 0))
      if (pl.ok && fb && isSolid(fb)) { try { await items.equipBestTool(bot, fb); await build.withTimeout(bot.dig(fb, true), 5000) } catch {} }
      side.fire = bot.blockAt(rim.offset(0, 1, 0)) ? bot.blockAt(rim.offset(0, 1, 0)).name : '?'
    }
    try {
      await bot.equip(crystalItem(), 'hand')
      await bot.lookAt(rim.offset(0.5, 1, 0.5), true)
      await build.withTimeout(bot.placeEntity(b, new Vec3(0, 1, 0)), 4000)
      out.placed++
      side.ok = true
    } catch (e) {
      side.why = e.message
      // Сервер мог поставить, а подтверждение не дошло.
      if ((Object.values(bot.entities) as any[]).some((e2 : any) => e2 && e2.name === 'end_crystal' && e2.position && e2.position.distanceTo(rim.offset(0.5, 1, 0.5)) < 1)) { out.placed++; side.ok = true }
    }
    await sleep(300)
  }
  }
  // Через пару секунд кристаллы потянут лучи вверх — анимация воскрешения.
  await sleep(3000)
  out.started = out.placed >= 4
  return out
}

async function pearlApproach (session, ctl, stats) {
  const bot = session.bot
  const me = bot.entity.position
  const r0 = Math.hypot(me.x - CENTER.x, me.z - CENTER.z)
  if (r0 < 30) return null
  const reserve = Number(process.env.ND_PEARL_RESERVE ?? 1)
  if (countOf(bot, /^ender_pearl$/) <= reserve) return null
  let goal = null; let goalWhy = 'r8'
  const P0 = podiumTop(bot)
  if (P0 != null && countOf(bot, /^(obsidian|crying_obsidian)$/) >= 2) {
    let pp = null
    // план станции — цель броска; считать не чаще раза в 20 с (pearlApproach зовётся на ходу раз в 2 с)
    const pc = ctl.pearlPlan
    if (pc && gameClock.now() - pc.t < 20000) pp = pc.pp
    else { try { pp = await pillarPlanAutoAsync(bot, P0) } catch { pp = null } ctl.pearlPlan = { t: gameClock.now(), pp } }
    if (pp) { goal = new Vec3(pp.feet.x, pp.G, pp.feet.z); goalWhy = 'станция' }
  }
  if (!goal) {
    const ux = (me.x - CENTER.x) / r0; const uz = (me.z - CENTER.z) / r0
    goal = new Vec3(CENTER.x + ux * 8, P0 != null ? P0 - 4 : me.y, CENTER.z + uz * 8)
  }
  ctl.pearlGoal = goal
  doing(ctl, 'pearl')
  const log = (m) => { console.log('[pearl] ' + m); dbg('pearl', m) }
  const floorOk = (b) => b.name === 'end_stone'
  const avoid = (feet) => Math.hypot(feet.x - CENTER.x, feet.z - CENTER.z) < 4.5
  // С платформы (y 49) до верха острова (~60+) дальность броска ~37 бл., а дуга снизу бьёт в бок обрыва:
  // нет броска отсюда — столб на платформе (как bridge:rise) на столько, со скольки бросок есть.
  let rise = null
  const under = bot.blockAt(me.floored().offset(0, -1, 0))
  // 02.10 (rs8-s12, смерть): остров нависает над платформой — жемчуг с платформы задел его бок, телепорт в воздух над пустотой.
  // Есть end_stone над платформой (до 14 выше, ±6 к острову) — с платформы не бросать.
  if (under && under.name === 'obsidian') {
    // нависание, а не обрыв: в колонне end_stone выше на 4–14, а под ним у платформы — воздух (у обрыва колонна сплошная снизу)
    let over = false
    const dx = Math.sign(CENTER.x - me.x) || 0, dz = Math.sign(CENTER.z - me.z) || 0
    const y0 = Math.floor(me.y)
    for (let k = 0; k <= 6 && !over; k++) for (let w = -2; w <= 2 && !over; w++) {
      const cx = Math.floor(me.x) + dx * k + (dx ? 0 : w), cz = Math.floor(me.z) + dz * k + (dz ? 0 : w)
      const open = [1, 2].every(h => isAirish(bot.blockAt(new Vec3(cx, y0 + h, cz))))
      if (!open) continue
      for (let y = y0 + 4; y <= y0 + 14 && !over; y++) { const b = bot.blockAt(new Vec3(cx, y, cz)); if (b && b.name === 'end_stone') over = true }
    }
    if (over) { log('остров нависает над платформой — с платформы не бросать'); return { hops: 0, pearls: 0, hpLost: 0, misses: 0, secs: 0, stop: 'остров над платформой' } }
  }
  if (under && under.name === 'obsidian') {
    const world = pearlHop.worldOf(bot)
    const feet = new Vec3(Math.floor(me.x) + 0.5, Math.floor(me.y + 0.01), Math.floor(me.z) + 0.5)
    const o = { floorOk, avoid, obstacles: pearlHop.obstaclesOf(bot) }
    if (!pearlHop.planHop(world, feet, goal, o).plan) {
      for (let k = 2; k <= 16; k += 2) {
        // столб — только в открытое небо (сид с сушей над платформой: «потолок end_stone»)
        let open = true
        for (let y = feet.y; y <= feet.y + k + 1 && open; y++) { const b = world(Math.floor(feet.x), y, Math.floor(feet.z)); if (!b || b.boundingBox !== 'empty') open = false }
        if (!open) break
        const r = pearlHop.planHop(world, feet.offset(0, k, 0), goal, o)
        if (r.plan) { rise = { k, to: r.plan.feet }; break }
      }
      if (!rise) { log('нет броска ни с платформы, ни со столба до +16'); return { hops: 0, pearls: 0, hpLost: 0, misses: 0, secs: 0, stop: 'нет броска' } }
      if (countOf(bot, FILLER_RE) < rise.k + 6) { log('на столб мало блоков'); return null }
      const inner = platformInner(bot)
      if (inner && Math.hypot(inner.x - bot.entity.position.x, inner.z - bot.entity.position.z) > 0.3) await stepTo(bot, ctl, inner, { ms: 2500, sprint: false, stopAt: 0.2 })
      doing(ctl, 'pearl:rise')
      const t0 = gameClock.now()
      const t = await fastTower(bot, ctl, Math.floor(bot.entity.position.y + 0.01) + rise.k, { maxMs: 15000, abortIf: () => angryEndermen(bot, 3).length ? 'эндермен рядом' : null })
      rise.ok = t.ok; rise.ms = gameClock.now() - t0
      log('столб +' + rise.k + ' для броска: ' + (t.ok ? 'ок' : t.why) + ' за ' + rise.ms + ' мс')
      doing(ctl, 'pearl')
    }
  }
  log(`подход: от ${Math.round(me.x)},${Math.round(me.y)},${Math.round(me.z)} к ${goalWhy} ${goal.x.toFixed(1)},${goal.y},${goal.z.toFixed(1)}, жемчуга ${countOf(bot, /^ender_pearl$/)}, хп ${Math.round(bot.health)}`)
  const out = await pearlHop.hopTo(bot, goal, {
    reserve,
    hpMin: Number(process.env.ND_PEARL_HPMIN ?? 11),
    maxHops: Number(process.env.ND_PEARL_MAX ?? 3),
    arriveR: 5,
    floorOk,
    avoid,
    lookOk: (y, pt) => !starer(bot, y, pt),
    abortIf: () => ctl.aborted,
    log
  })
  out.goal = goalWhy
  // 02.10 (rs4-s1): жемчуг лёг в стену — тело в блоке, «in_wall» 15 раз за 10 с, пока бот ел (pearl:heal). Сперва выбраться.
  if (out.hops && embeddedNow(bot)) { out.embedded = (embeddedNow(bot) || {}).name; await unembed(bot, ctl) }
  // К станции — не с просевшим хп (01.10): после бросков поесть и дождаться регенерации (до 8 с, пока дракон не заходит).
  if (out.hops && bot.health < 19 && !ctl.aborted) {
    const hp0 = bot.health; const t0 = gameClock.now()
    const busy = () => { const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null; return ph === PHASE.APPROACH || ph === PHASE.LANDING || ph === PHASE.STRAFE || ph === PHASE.CHARGING || hunters(bot, 6).length > 0 || !!embeddedNow(bot) }
    if (!busy()) {
      doing(ctl, 'pearl:heal')
      try { await pearlHop.recover(bot, 19.5, 8000, busy) } catch {}
      out.healed = { from: r1(hp0), to: r1(bot.health), ms: gameClock.now() - t0 }
      log(`после бросков: хп ${r1(hp0)} → ${r1(bot.health)} за ${gameClock.now() - t0} мс`)
    }
  }
  if (rise) out.rise = rise
  if (ctl.trace) ctl.trace.ev('pearl', { goal: [r1(goal.x), goal.y, r1(goal.z)], ...out })
  log(`итог: бросков ${out.hops}, жемчуга ${out.pearls}, хп −${out.hpLost}, промахов ${out.misses}, ${Math.round(out.ms / 100) / 10} с; стоп: ${out.stop || '-'}`)
  return { hops: out.hops, pearls: out.pearls, hpLost: out.hpLost, misses: out.misses, secs: Math.round(out.ms / 100) / 10, saved: out.saved, stop: out.stop, rise: rise || undefined, steps: out.steps }
}

const LAB_PLANS = new Map()

function labCells (pp) {
  const cells = []
  for (const c of pp.supCob || []) cells.push([...c, 'cobblestone'])
  for (const c of pp.sup || []) cells.push([...c, 'obsidian'])
  if (pp.place.obsidian) cells.push([pp.place.K.x, pp.place.K.y, pp.place.K.z, 'obsidian'])
  for (const o of pp.obs || []) cells.push([...o, 'obsidian'])
  for (const c of pp.labExtra || []) cells.push(c)
  const dig = []
  for (let k = 1; k <= pp.dig; k++) dig.push([pp.B.x, pp.G - k, pp.B.z, 'air'])
  return { P: pp.P, H: [pp.H.x, pp.yb, pp.H.z], F: [pp.F.x, pp.yb, pp.F.z], B: [pp.B.x, pp.B.z], feet: [pp.feet.x, pp.feet.y, pp.feet.z], G: pp.G, dig: pp.dig, seen: pp.seen, expo: pp.expo, nObs: pp.nObs, cells: [...dig, ...cells] }
}

async function dragonLab (session, ctl, stats, p, mode, deadline) {
  const bot = session.bot
  const arm = String(p.arm || 'A')
  for (const k of Object.keys(LABENV)) delete LABENV[k]
  Object.assign(LABENV, p.env || {})
  try {
    if (mode === 'labPlan') {
      const P0 = podiumTop(bot)
      if (P0 == null) return { stop: 'нет вершины столба' }
      const t0 = gameClock.now()
      const pp = runnerOn() ? runnerPlan(bot, P0) : await pillarPlanAutoAsync(bot, P0)
      LAB_PLANS.set(arm, pp)
      if (!pp) return { stop: 'плана нет', why: pillarPlan.why, P: P0 }
      return { arm, ms: gameClock.now() - t0, plan: labCells(pp) }
    }
    const plan = LAB_PLANS.get(arm)
    if (!plan) return { stop: `нет плана плеча ${arm}` }
    ctl.pillar = { plan, built: true, t: gameClock.now(), booms: 0 }
    ctl.bedsOnly = true; ctl.pillarMode = true
    const feed = ctl.feed || (ctl.feed = makeDragonFeed(bot))
    const track = makeTrack(bot)
    const t0 = gameClock.now()
    const tEnd = Math.min(deadline, gameClock.now() + (p.waitSeconds ?? 60) * 1000)
    let run = null; let entered = 0
    while (!ctl.aborted && gameClock.now() < tEnd) {
      track.tick()
      const d = dragonOf(bot)
      const ph = d ? phaseOf(bot, d) : null
      if (ph === PHASE.LANDING) { run = await pillarRun(session, ctl, stats, track, feed); break }
      if (ph === PHASE.APPROACH && !pillarHere(bot, plan)) { entered++; doing(ctl, 'pillar:enter'); await pillarEnter(session, ctl, plan) }
      await sleep(50)
    }
    const me = bot.entity.position
    return { arm, run, beds: stats.beds, entered, ms: gameClock.now() - t0, hp: r1(bot.health), at: [r1(me.x), r1(me.y), r1(me.z)], inTrench: !!pillarHere(bot, plan), ...(run ? {} : { stop: 'снижения не было' }) }
  } finally {
    for (const k of Object.keys(LABENV)) delete LABENV[k]
  }
}

const headPlanExport = headPlan
module.exports = { blindPit, takeoffAzOf, headAfterTakeoff, CARD4, pillarPlanAuto, headPlan, collectXp, eggItem, pickUp, takeEgg, goHome, respawnDragon, pearlApproach, LAB_PLANS, labCells, dragonLab }
export {
  blindPit, takeoffAzOf, headAfterTakeoff, CARD4, pillarPlanAuto, headPlanExport as headPlan, collectXp, eggItem,
  pickUp, takeEgg, goHome, respawnDragon, pearlApproach, LAB_PLANS, labCells, dragonLab
}
