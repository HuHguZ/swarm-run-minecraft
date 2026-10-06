const { EYE, gameClock, sleep, envNum, runnerOn, BREATH_R, CLOUD_SLAB, Vec3, playerBox, overlap, inflate, HURT_PAD, HEAD_AHEAD, boxDist, MELEE_REACH, isAirish, isSolid, pick, sitFix, partsOf, SITTING, phaseOf, PHASE, envv, CENTER, SAFE_FROM_CRYSTAL, bow, cloudsOf, yieldTick, nearPortal, PART, TOWER_FAR, RUN_FACING, PILLOW_DY, HEAD_ROOM } = require('./dig-down-to')
const { lookAtSafe, BED_TOP, simClone, simHead, wrapDeg, msin, mcos, simNeck, SEEN_XZ, virtualBot, exposure, dragonSeen, DIRS4, SEEN_Y5 } = require('./evade-raw')
const { FACE_IDX, placeNoBed, placeBedAt, yRotOf } = require('./ts-plan')
const { breathOf, standY, doing, r1, cageBars, podiumTop, surfaceY, inClouds, nearEdge, nearPillar } = require('./fall-guard')
function crysOn () { return envv('ND_CRYSTALS') !== '0' }

function crystalTimingAllowed (ph, distance) {
  if (envv('ND_CRYS_STRAFE_ONLY') === '1') return ph === PHASE.STRAFE && distance > envNum('ND_CRYS_STRAFE_D', 24)
  return ph === PHASE.HOLDING || (ph === PHASE.STRAFE && distance > envNum('ND_CRYS_STRAFE_D', 24))
}

function crystalShotFrom (bot, cr, feet) {
  const dist = feet.distanceTo(cr.pos)
  if (dist < SAFE_FROM_CRYSTAL + 0.5 || Math.hypot(cr.pos.x - feet.x, cr.pos.z - feet.z) > 60) return null
  const eye = feet.offset(0, EYE - 0.1, 0)
  for (const mode of [true, 'lob']) {
    const sol = bow.aim(eye, () => cr.aim, bow.SPEED, bow.GRAVITY, mode)
    if (!sol || bow.blockedAt(bot, eye, sol)) continue
    // запас: глаза в 0.3 вбок и цель на 0.6 ниже (край обелиска снизу) — путь тоже чист
    const low = cr.aim.offset(0, -0.6, 0)
    const sLow = bow.aim(eye, () => low, bow.SPEED, bow.GRAVITY, mode)
    if (!sLow || bow.blockedAt(bot, eye, sLow)) continue
    const robust = [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].every(([ox, oz]) => {
      const e2 = eye.offset(ox, 0, oz)
      const s2 = bow.aim(e2, () => cr.aim, bow.SPEED, bow.GRAVITY, mode)
      return s2 && !bow.blockedAt(bot, e2, s2)
    })
    if (!robust) continue
    return { sol, mode, ticks: sol.ticks, cost: sol.ticks + (mode === 'lob' ? 25 : 0) }
  }
  return null
}

function crysState (bot, ctl) {
  const C = ctl.crys || (ctl.crys = { known: new Map(), tries: new Map(), pending: new Map(), ban: new Map(), noSpotUntil: 0, shots: 0, hits: 0, moves: 0, active: false, firstShot: null })
  const me = bot.entity.position
  const seen = new Set()
  // клетка кристалла не меняется — прутья считать один раз на кристалл (cageBars — 100 блоков)
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e.name !== 'end_crystal' || !e.position || e.isValid === false) continue
    if (Math.hypot(e.position.x - CENTER.x, e.position.z - CENTER.z) <= 20) continue
    seen.add(e.id)
    const k = C.known.get(e.id)
    if (k && !k.gone) continue
    const cx = Math.floor(e.position.x); const cz = Math.floor(e.position.z); const top = Math.floor(e.position.y) - 1
    C.known.set(e.id, { id: e.id, pos: e.position.clone(), aim: e.position.offset(0, 1, 0), bars: cageBars(bot, cx, top, cz).length, gone: false, cx, cz, top })
    if (!k && ctl.trace) { const ks = [...C.known.values()]; ctl.trace.ev('crysKnown', { id: e.id, y: r1(e.position.y), caged: C.known.get(e.id).bars > 0, n: ks.length, open: ks.filter(x => x.bars === 0).length }) }
  }
  for (const k of C.known.values()) {
    if (k.gone || seen.has(k.id)) continue
    if (Math.hypot(k.pos.x - me.x, k.pos.z - me.z) < 58) {
      k.gone = true
      const ours = C.pending.has(k.id)
      if (ours) { C.hits++; if (ctl.stats) ctl.stats.crystals = (ctl.stats.crystals || 0) + 1 }
      if (ctl.trace) ctl.trace.ev('crysGone', { id: k.id, ours, at: [r1(k.pos.x), r1(k.pos.y), r1(k.pos.z)], left: [...C.known.values()].filter(x => !x.gone).length })
    }
  }
  return C
}

function crysTargets (bot, ctl) {
  const C = crysState(bot, ctl)
  const tries = envNum('ND_CRYS_TRIES', 4)
  return [...C.known.values()].filter(k => !k.gone && k.bars === 0 && (C.tries.get(k.id) || 0) < tries)
}

async function crystalSpot (bot, targets, me, bad: any = []) {
  const P0 = podiumTop(bot)
  const clouds = cloudsOf(bot)
  const cand = []
  for (let r = 14; r <= 29; r += 2.5) {
    const n = Math.round(2 * Math.PI * r / 2.2)
    for (let k = 0; k < n; k++) {
      const a = 2 * Math.PI * k / n
      const x = CENTER.x + Math.cos(a) * r; const z = CENTER.z + Math.sin(a) * r
      if (Math.hypot(x - me.x, z - me.z) > 30) continue
      const sf = surfaceY(bot, x, z)
      if (!sf || !/^(end_stone|cobblestone)$/.test(sf.name)) continue
      const feet = new Vec3(Math.floor(x) + 0.5, sf.y, Math.floor(z) + 0.5)
      if (P0 != null && feet.y > P0 + 4) continue
      // где стоим — уже проверено (выстрела нет); точки, где «дошёл, а выстрела нет», — тоже (ca1-s14: 1034 перехода
      // на 0.1–0.2 бл. за 19 с — точка по центру клетки годна, с места в 0.2 от неё — нет)
      if (feet.distanceTo(me) < 1.2 || bad.some(b => b.distanceTo(feet) < 1.5)) continue
      cand.push({ feet, d: feet.distanceTo(me) })
    }
  }
  cand.sort((a, b) => a.d - b.d)
  let n = 0
  for (const c of cand) {
    if (++n > 90) break
    if (n % 6 === 0) await yieldTick()
    if (nearPortal(c.feet) || inClouds(clouds, c.feet, 2) || nearEdge(bot, c.feet, 2) || nearPillar(bot, c.feet, 3)) continue
    let best = null
    for (const t of targets) {
      const s = crystalShotFrom(bot, t, c.feet)
      if (s && (!best || s.cost < best.s.cost)) best = { t, s }
    }
    if (best) return { feet: c.feet, id: best.t.id, ticks: best.s.ticks, mode: best.s.mode }
  }
  return null
}

function meleeSpot (bot, d, parts, { blind = false }: any = {}) {
  const breath = breathOf(bot, d, parts)
  const hc = parts.headC
  let best = null
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      const x = Math.floor(hc.x) + dx; const z = Math.floor(hc.z) + dz
      const gy = standY(bot, x + 0.5, z + 0.5, parts.head.min.y - 1, 3, 6)
      if (gy == null) continue
      if (x === breath.column.x && z === breath.column.z) continue
      // Сколько блоков под себя, чтобы стоять над облаком огня: облако ляжет
      // по земле В ЕГО СТОЛБЦЕ, а земля неровная — его низ бывает выше нашего.
      const inBreath = Math.hypot(x + 0.5 - breath.pos.x, z + 0.5 - breath.pos.z) < BREATH_R + 0.8
      const lift = inBreath ? Math.max(1, Math.ceil(breath.pos.y + CLOUD_SLAB - gy)) : 1
      if (lift > 2) continue
      const pedestal = gy + lift
      const feet = new Vec3(x + 0.5, pedestal, z + 0.5)
      const pb = playerBox(feet)
      if (overlap(pb, inflate(parts.head, HURT_PAD)) || overlap(pb, inflate(parts.neck, HURT_PAD)) || overlap(pb, inflate(parts.body, 0.6))) continue
      // Только перед мордой: сбоку голова метёт дугой, когда дракон
      const rx = feet.x - parts.pos.x; const rz = feet.z - parts.pos.z
      const rh = Math.hypot(rx, rz)
      if (rh < (blind ? 5.5 : HEAD_AHEAD + 1.9)) continue
      if (Math.acos(Math.max(-1, Math.min(1, (rx * parts.dir.x + rz * parts.dir.z) / rh))) > (blind ? 1.3 : 0.14)) continue
      // Голову бьём и с прыжка: проверяем от глаз стоя и в верхней точке.
      const eye = feet.offset(0, EYE, 0)
      const reach = boxDist(eye, parts.head)
      if (reach > MELEE_REACH - 0.2) continue
      // Над головой свободно для прыжка.
      if (!isAirish(bot.blockAt(new Vec3(x, pedestal + 2, z)))) continue
      const along = (feet.x - hc.x) * parts.dir.x + (feet.z - hc.z) * parts.dir.z
      const cost = reach + (along < 0 ? 1.5 : 0) + feet.distanceTo(bot.entity.position) * 0.05
      if (!best || cost < best.cost) best = { feet, ground: new Vec3(x + 0.5, gy, z + 0.5), reach, cost, breath, lift }
    }
  }
  return best
}

const OC_ON = process.env.ND_BEDS_OC !== '0'

function scanPredict (sit, player, calls = 25) {
  const F = Math.fround
  const s = simClone(sit)
  s.hist = s.hist && s.hist.length >= 11 ? s.hist : new Array(12).fill(s.y)
  for (let t = 0; t < calls; t++) {
    const prior = simHead(s, true)
    s.yRot = F(wrapDeg(s.yRot))
    const dx = player.x - s.x; const dz = player.z - s.z
    const dl = Math.hypot(dx, dz) || 1e-6
    const a = F(F(s.yRot) * F(Math.PI / 180))
    const sx = msin(a); const sz = -mcos(a)
    const dot = Math.max(-1, Math.min(1, F((sx * dx + sz * dz) / Math.hypot(sx, sz) / dl)))
    const g = F(F(Math.acos(dot) * 180 / Math.PI) + 0.5)
    if (g < 0 || g > 10) {
      const hx = player.x - prior.x; const hz = player.z - prior.z
      const err = Math.max(-100, Math.min(100, wrapDeg(180 - Math.atan2(hx, hz) * 180 / Math.PI - s.yRot)))
      const j = F(F(Math.hypot(hx, hz)) + 1)
      const i = Math.min(j, 40)
      s.yRotA = F(F(s.yRotA * F(0.8)) + F(F(err) * F(F(F(0.7) / i) / j)))
      s.yRot = F(s.yRot + s.yRotA)
    }
  }
  return { s, head: simHead(s, true), neck: simNeck(s, true) }
}

const OBS = 'obsidian'

const OBS_ANY = /^(obsidian|crying_obsidian)$/

function pillarCells (P) {
  // столб (0,0) от P − 4 до P − 1; факелы на P − 2 по 4 сторонам
  return { pillar: [0, 1, 2, 3].map(k => ({ x: 0, y: P - 4 + k, z: 0 })), torches: [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => ({ x, y: P - 2, z })) }
}

function faceClick (vbot, eye, blockPos, face, { reach = Math.min(4.5, envNum('ND_PILLAR_REACH', 4.3)), avoidTorch = null }: any = {}) {
  const ax = face.x ? 'x' : face.y ? 'y' : 'z'
  const plane = blockPos[ax] + (face[ax] > 0 ? 1.001 : -0.001)
  const us = ax === 'x' ? ['y', 'z'] : ax === 'y' ? ['x', 'z'] : ['x', 'y']
  const isBed = vbot.blockAt(blockPos) && /_bed$/.test(vbot.blockAt(blockPos).name || '')
  for (const [a, b] of [...(runnerOn() ? [[0.5, 0.01], [0.5, 0.99], [0.01, 0.5], [0.99, 0.5]] : []), [0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5]]) {
    const pt = { x: 0, y: 0, z: 0 }; pt[ax] = plane; pt[us[0]] = blockPos[us[0]] + a; pt[us[1]] = blockPos[us[1]] + b
    // у кровати бок — только нижние 0.56
    if (isBed && ax !== 'y' && pt.y - blockPos.y > 0.5) pt.y = blockPos.y + 0.3
    if (isBed && ax === 'y' && face.y > 0) pt.y = blockPos.y + 0.5635
    const P0 = new Vec3(pt.x, pt.y, pt.z)
    const dv = P0.minus(eye); const len = dv.norm()
    if (len > reach || len < 0.4) continue
    if (dv.x * face.x + dv.y * face.y + dv.z * face.z >= 0) continue
    const d = dv.scaled(1 / len)
    const hit = pick.blockOnRay(vbot, eye, d, len + 0.05)
    if (!hit || !hit.pos.equals(blockPos)) continue
    if (avoidTorch && avoidTorch(eye, d, len)) continue
    return { point: P0, dir: d, len }
  }
  return null
}

function faceClickFacing (vbot, eye, blockPos, face, want, { reach = Math.min(4.5, envNum('ND_PILLAR_REACH', 4.3)), minCos = 0.8 }: any = {}) {
  const ax = face.x ? 'x' : face.y ? 'y' : 'z'
  const plane = blockPos[ax] + (face[ax] > 0 ? 1.001 : -0.001)
  const us = ax === 'x' ? ['y', 'z'] : ax === 'y' ? ['x', 'z'] : ['x', 'y']
  let best = null
  for (const a of [0.15, 0.3, 0.5, 0.7, 0.85]) {
    for (const b of [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]) {
      const pt = { x: 0, y: 0, z: 0 }; pt[ax] = plane; pt[us[0]] = blockPos[us[0]] + a; pt[us[1]] = blockPos[us[1]] + b
      const P0 = new Vec3(pt.x, pt.y, pt.z)
      const dv = P0.minus(eye); const len = dv.norm()
      if (len > reach || len < 0.4) continue
      if (dv.x * face.x + dv.y * face.y + dv.z * face.z >= 0) continue
      const h = Math.hypot(dv.x, dv.z); if (h < 1e-6) continue
      const cos = (dv.x * want.x + dv.z * want.z) / h
      if (cos < minCos || (best && cos <= best.cos)) continue
      const d = dv.scaled(1 / len)
      const hit = pick.blockOnRay(vbot, eye, d, len + 0.05)
      if (!hit || !hit.pos.equals(blockPos)) continue
      best = { point: P0, dir: d, len, cos }
    }
  }
  return best
}

function runnerPlan (bot, P) {
  const options = []
  const why = {}; const no = k => { why[k] = (why[k] || 0) + 1 }
  runnerPlan.why = why
  // Ноги сдвинуты к опоре K (02.10, rs2: на P + 1 видна только ближняя к боту кромка грани K — булыжник под F закрывает
  for (const s of [-1, 1]) for (const side of [-1, 1]) for (const shift of (RUN_FACING() ? [0.3, 0.2, 0.12, 0] : [0])) {
    if (options.length) break
    const feet = new Vec3(0.5 + shift * side, P - 4, 2 * s + 0.5)
    if ((bot.blockAt(feet.offset(0, -1, 0)) || {}).name !== 'bedrock' || !isAirish(bot.blockAt(feet)) || !isAirish(bot.blockAt(feet.offset(0, 1, 0)))) { no(`чаша ${s}: ${(bot.blockAt(feet.offset(0, -1, 0)) || {}).name}/${(bot.blockAt(feet) || {}).name}/${(bot.blockAt(feet.offset(0, 1, 0)) || {}).name}`); continue }
    const baseCells = [[side, P - 1, 0, OBS], [side, P - 1, s, OBS], [side, P, s, OBS], [side, P + 1, s, OBS]]
    const torch = [0, P - 2, s, 'air'] // снять факел при подготовке, прежде чем занимать чашу
    const cells = [...baseCells, torch]
    const busy = baseCells.find(c => { const b = bot.blockAt(new Vec3(...c.slice(0, 3))); return !(isAirish(b) || (b && OBS_ANY.test(b.name))) })
    if (busy) { no(`занято ${busy.slice(0, 3).join(',')}: ${(bot.blockAt(new Vec3(...busy.slice(0, 3))) || {}).name}`); continue }
    const w = new Map([...baseCells, torch].map(c => [c.slice(0, 3).join(','), c[3] === 'air' ? 'air' : 'block']))
    const levels = []
    for (const dy of [0, 1]) {
      const yb = P + dy, H = { x: 0, y: yb, z: 0 }, F = { x: 0, y: yb, z: s }
      const world = new Map(w)
      if (dy) world.set(`0,${P},${s}`, 'block') // расходный блок под изножьем
      const K = new Vec3(side, yb, s), face = new Vec3(-side, 0, 0), eye = feet.offset(0, EYE, 0)
      const place = RUN_FACING() ? faceClickFacing(virtualBot(bot, world), eye, K, face, { x: 0, z: -s }) : faceClick(virtualBot(bot, world), eye, K, face)
      if (!place || Math.abs(place.dir.z) <= Math.abs(place.dir.x) || Math.sign(place.dir.z) !== -s) { no(`K ${dy}: ${place ? 'не вдоль' : 'грань не видно'}`); break }
      const centre = new Vec3(0.5, yb + 0.5, 0.5)
      const vb = virtualBot(bot, world), expo = exposure(vb, feet, centre)
      if (expo > 0.02 || lowRowsOpen(vb, feet, centre)) { no(`открыто ${dy}: ${r1(expo * 100) / 100}`); break }
      const wb = new Map(world); wb.set(`0,${yb},0`, 'bed'); wb.set(`0,${yb},${s}`, 'bed')
      const clickFace = new Vec3(0, 0, s), hit = faceClick(virtualBot(bot, wb), eye, new Vec3(0, yb, s), clickFace)
      if (!hit) { no(`бок кровати ${dy}`); break }
      levels.push({ P, H, F, a: { x: 0, z: -s }, yb, centre, B: { x: 0, z: 2 * s }, feet, G: P - 4, dig: 0,
        place: { K: { x: side, y: yb, z: s }, face, point: place.point, obsidian: false },
        click: { cell: F, face: clickFace, point: hit.point, len: hit.len }, obs: [], sup: [], supCob: [], nObs: 4,
        seen: dragonSeen(vb, centre, new Vec3(0.5, P, 0.5)), expo, runner: true, cells })
    }
    if (levels.length === 2) { const p = levels[0]; p.runnerLevels = levels; p.labExtra = cells; options.push(p) }
  }
  return options[0] || null
}
declare namespace runnerPlan {
  let why: any
}

function runnerAim (bot, point) {
  const d = point.minus(bot.entity.position.offset(0, EYE, 0))
  bot.entity.yaw = Math.atan2(-d.x, -d.z)
  bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  bot._client.write('look', { yaw: Math.atan2(-d.x, d.z) * 180 / Math.PI, pitch: -bot.entity.pitch * 180 / Math.PI,
    onGround: bot.entity.onGround, flags: { onGround: bot.entity.onGround, hasHorizontalCollision: false } })
}

function pillarPlan (bot, P, { maxObs = 6, pillow = null, dy = PILLOW_DY, aOnly = null }: any = {}) {
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  pillarPlan.why = why
  const at = (x: any, y: any, z: any) => bot.blockAt(new Vec3(x, y, z))
  const { torches } = pillarCells(P)
  const torchSet = new Set(torches.map(t => `${t.x},${t.y},${t.z}`))
  // луч через клетку факела — прицел клиента зацепит факел: такие лучи не годятся
  const torchHit = (eye, d, len) => { for (let t = 0; t < len; t += 0.1) { const q = eye.plus(d.scaled(t)); if (torchSet.has(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`)) return true } return false }
  const yb = P + dy
  const pillows = pillow ? [pillow] : [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]
  const out = []
  for (const Hc of pillows) {
    const H = { x: Hc.x, y: yb, z: Hc.z }
    if (!isAirish(at(H.x, yb, H.z))) { no('подушка занята'); continue }
    for (const a of DIRS4) {
      if (aOnly && (a.x !== aOnly.x || a.z !== aOnly.z)) continue
      const F = { x: H.x - a.x, y: yb, z: H.z - a.z }
      if (F.x === 0 && F.z === 0) continue
      if (!isAirish(at(F.x, yb, F.z))) { no('изножье занято'); continue }
      const centre = new Vec3(H.x + 0.5, yb + 0.5, H.z + 0.5)
      // подушка над столбом: опора под изголовьем — обсидиан к боку верхнего блока столба (не висит)
      // опора под изголовьем — столбиком от яруса верхнего блока столба (P − 1) до yb − 1
      const sup: [number, number, number][] = []
      for (let y = P - 1; y <= yb - 1; y++) sup.push([H.x, y, H.z])
      if (sup.some(c => !(isAirish(at(...c)) || isSolid(at(...c))))) { no('под подушкой занято'); continue }
      const uA = { x: a.z, z: -a.x }
      const Ks = [{ c: { x: F.x - a.x, y: yb, z: F.z - a.z }, n: { x: a.x, y: 0, z: a.z } }, { c: { x: F.x + uA.x, y: yb, z: F.z + uA.z }, n: { x: -uA.x, y: 0, z: -uA.z } }, { c: { x: F.x - uA.x, y: yb, z: F.z - uA.z }, n: { x: uA.x, y: 0, z: uA.z } }, { c: { x: F.x, y: yb - 1, z: F.z }, n: { x: 0, y: 1, z: 0 } }]
      // над столбом опора под изножьем держится за опору под изголовьем (не висит) — её первой
      if (dy >= 0) Ks.unshift(Ks.pop())
      // ND_PILLAR_K=above — опора над изножьем (клик по нижней грани, видна из окопа): боковая опора на ярусе кровати
      if (envv('ND_PILLAR_K') === 'above') Ks.splice(0, Ks.length, { c: { x: F.x, y: yb + 1, z: F.z }, n: { x: 0, y: -1, z: 0 } })
      for (let bx = -6; bx <= 6; bx++) {
        for (let bz = -6; bz <= 6; bz++) {
          const r2 = bx * bx + bz * bz
          if (r2 < 1 || r2 > 40) continue
          // окоп — на стороне подушки (151 из 151 построенных станций st2–hb7): вдвое меньше перебора — план считался
          if (envv('ND_PILLAR_SIDE') === '1') { if (Math.abs(bx * Hc.x + bz * Hc.z) > 1 || Math.abs(bx * Hc.z - bz * Hc.x) < 3) continue } else if (bx * Hc.x + bz * Hc.z <= 0) continue
          const s0 = surfaceY(bot, bx + 0.5, bz + 0.5, P + 2)
          if (!s0) continue
          const feetOpts = [{ y: s0.y, dig: 0 }]
          const diggable = y => /end_stone|cobble|stone|dirt|netherrack/.test((at(bx, y, bz) || {}).name || '')
          if (diggable(s0.y - 1)) { feetOpts.push({ y: s0.y - 1, dig: 1 }); if (diggable(s0.y - 2) && diggable(s0.y - 3)) { feetOpts.push({ y: s0.y - 2, dig: 2 }); if (diggable(s0.y - 4)) feetOpts.push({ y: s0.y - 3, dig: 3 }) } }
          for (const fo of feetOpts) {
            // голова/шея/крыло на снижении не достают: макушка ≤ P − 2.6
            if (fo.y + 1.8 > P - envNum('ND_PILLAR_HEADROOM', HEAD_ROOM)) { no('высоко (голова/крыло)'); continue }
            if (Math.hypot(bx - F.x, bz - F.z) < 1.2) continue
            const base = new Map()
            for (let k = 1; k <= fo.dig; k++) base.set(`${bx},${s0.y - k},${bz}`, 'air')
            for (const c of sup) base.set(c.join(','), 'block')
            const feet = new Vec3(bx + 0.5, fo.y, bz + 0.5)
            const eye = feet.offset(0, EYE, 0)
            let place = null
            for (const K of Ks) {
              const kb = at(K.c.x, K.c.y, K.c.z)
              const isPillar = K.c.x === 0 && K.c.z === 0 && K.c.y >= P - 4 && K.c.y <= P - 1
              if (!isPillar && !(isAirish(kb) || (kb && OBS_ANY.test(kb.name)))) continue
              if (torchSet.has(`${K.c.x},${K.c.y},${K.c.z}`)) continue
              const w = new Map(base); if (!isPillar) w.set(`${K.c.x},${K.c.y},${K.c.z}`, 'block')
              const vb = virtualBot(bot, w)
              const fcl = faceClick(vb, eye, new Vec3(K.c.x, K.c.y, K.c.z), new Vec3(K.n.x, K.n.y, K.n.z), { avoidTorch: torchHit })
              if (!fcl) continue
              const hx = fcl.dir.x; const hz = fcl.dir.z
              const dom = Math.abs(hx) >= Math.abs(hz) ? { x: Math.sign(hx), z: 0 } : { x: 0, z: Math.sign(hz) }
              if (dom.x !== a.x || dom.z !== a.z) continue
              place = { K: K.c, face: new Vec3(K.n.x, K.n.y, K.n.z), point: fcl.point, obsidian: !isPillar && !(kb && OBS_ANY.test(kb.name)) }
              break
            }
            if (!place) { no('кровать с места не поставить'); continue }
            const w1 = new Map(base); if (place.obsidian) w1.set(`${place.K.x},${place.K.y},${place.K.z}`, 'block')
            w1.set(`${F.x},${yb},${F.z}`, 'bed'); w1.set(`${H.x},${yb},${H.z}`, 'bed')
            let click = null
            for (const f of [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }, { x: 0, y: -1, z: 0 }]) {
              for (const cell of [F, H]) {
                const c = faceClick(virtualBot(bot, w1), eye, new Vec3(cell.x, yb, cell.z), new Vec3(f.x, f.y, f.z), { avoidTorch: torchHit })
                if (c) { click = { cell, face: f, point: c.point, len: c.len }; break }
              }
              if (click) break
            }
            if (!click) { no('кровать с места не видно'); continue }
            const wS = new Map(base); if (place.obsidian) wS.set(`${place.K.x},${place.K.y},${place.K.z}`, 'block')
            const keep = new Set([`${F.x},${yb},${F.z}`, `${H.x},${yb},${H.z}`, `${place.K.x},${place.K.y},${place.K.z}`])
            for (let y = fo.y; y <= fo.y + 2; y++) keep.add(`${bx},${y},${bz}`)
            const sightCells = new Set()
            for (const pt of [place.point, click.point]) { const dv = pt.minus(eye); const L = dv.norm(); for (let t = 0; t <= L; t += 0.05) { const q = eye.plus(dv.scaled(t / L)); sightCells.add(`${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`) } }
            const obs = []
            let expo = exposure(virtualBot(bot, wS), feet, centre)
            while (expo > 0.02 && obs.length < maxObs) {
              const count = new Map()
              const vS = virtualBot(bot, wS)
              for (const fy of SEEN_Y5) for (const ox of SEEN_XZ) for (const oz of SEEN_XZ) {
                const p0 = new Vec3(feet.x + ox, feet.y + fy, feet.z + oz)
                const dv = centre.minus(p0); const L = dv.norm()
                if (pick.blockOnRay(vS, p0, dv.scaled(1 / L), L - 0.02)) continue
                const seen = new Set()
                for (let t = 0.3; t < L - 0.3; t += 0.1) {
                  const q = p0.plus(dv.scaled(t / L)); const k = `${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`
                  if (seen.has(k) || keep.has(k) || sightCells.has(k)) continue
                  seen.add(k)
                  const bq = vS.blockAt(new Vec3(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z)))
                  if (!isAirish(bq) || torchSet.has(k)) continue
                  if (Math.floor(q.x) === 0 && Math.floor(q.z) === 0) continue
                  count.set(k, (count.get(k) || 0) + 1)
                }
              }
              // при равенстве — клетка с твёрдым соседом (ставится без лесов)
              const anchored = k => { const [x, y, z] = k.split(',').map(Number); return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => isSolid(vS.blockAt(new Vec3(x + dx, y + dy, z + dz)))) }
              let bestK = null; let bestN = 0
              for (const [k, n] of count) { const sc = n + (anchored(k) ? 0.5 : 0); if (sc > bestN) { bestN = sc; bestK = k } }
              if (!bestK) break
              wS.set(bestK, 'block'); obs.push(bestK.split(',').map(Number))
              expo = exposure(virtualBot(bot, wS), feet, centre)
            }
            if (expo > 0.02) { no('заслоны не закрыли'); continue }
            if (!faceClick(virtualBot(bot, wS), eye, new Vec3(place.K.x, place.K.y, place.K.z), place.face, { avoidTorch: torchHit })) { no('заслон закрыл ставку'); continue }
            const wB = new Map(wS); wB.set(`${F.x},${yb},${F.z}`, 'bed'); wB.set(`${H.x},${yb},${H.z}`, 'bed')
            if (!faceClick(virtualBot(bot, wB), eye, new Vec3(click.cell.x, yb, click.cell.z), new Vec3(click.face.x, click.face.y, click.face.z), { avoidTorch: torchHit })) { no('заслон закрыл щелчок'); continue }
            const seenD = dragonSeen(virtualBot(bot, wS), centre, new Vec3(0.5, P, 0.5))
            const supNew = sup.filter((c, i) => !(i === sup.length - 1 ? OBS_ANY.test((at(c[0], c[1], c[2]) || {}).name || '') : isSolid(at(c[0], c[1], c[2]))))
            // у взрыва — только верхняя клетка опоры (обсидиан), нижние — булыжник (их снесёт, подушке не нужны)
            const supObs = supNew.slice(-1); const supCob = supNew.slice(0, -1)
            const nObs = obs.length + (place.obsidian ? 1 : 0) + supObs.length
            // висячие клетки (нужны леса: в pil4 «лес: не дошёл» — 2 боя без станции) — дороже
            const cellsAll = [...supNew, ...(place.obsidian ? [[place.K.x, place.K.y, place.K.z]] : []), ...obs]
            const solidAt = (x, y, z, w) => isSolid(virtualBot(bot, w).blockAt(new Vec3(x, y, z)))
            let floating = 0
            { const w = new Map(base); for (const c of supNew) w.delete(c.join(',')); for (const c of cellsAll) { const ok = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => solidAt(c[0] + dx, c[1] + dy, c[2] + dz, w)); if (!ok) floating++; w.set(c.join(','), 'block') } }
            const cost = nObs * 2 + fo.dig * 1.5 - seenD * 10 + Math.hypot(bx, bz) * 0.2 + floating * 6
            out.push({ P, H, F, a, yb, centre, B: { x: bx, z: bz }, feet, dig: fo.dig, G: s0.y, place, click, obs, sup: supObs, supCob, nObs, floating, expo: r1(expo * 100) / 100, seen: r1(seenD * 100) / 100, cost })
          }
        }
      }
    }
  }
  out.sort((p, q) => p.cost - q.cost)
  pillarPlan.all = out
  return out[0] || null
}
declare namespace pillarPlan {
  let why: any
  let all: any[]
}

const RUN_SWORD = () => envv('ND_RUN_SWORD') !== '0'

const SWORD_V2 = () => envv('ND_RUN_SWORD') !== '0' && envv('ND_RUN_SWORD') !== '1'

const SWORD_PED = () => envv('ND_RUN_SWORD_PED') !== '0'

const SWORD_REACH = 2.95

function swordPick (bot, parts, eye) {
  const boxes = [['head', parts.head, PART.head], ['neck', parts.neck, PART.neck], ['body', parts.body, PART.body]]
  // прицел — во внутреннюю часть коробки (модель частей в полёте ошибается на ~0.2–0.5)
  const shrink = (b, m) => ({ min: b.min.offset(m, m, m), max: b.max.offset(-m, -m, -m) })
  for (const [name, b0, id] of boxes) {
    const m = name === 'head' ? 0.2 : 0.35
    const b = shrink(b0, m)
    const near = new Vec3(Math.max(b.min.x, Math.min(eye.x, b.max.x)), Math.max(b.min.y, Math.min(eye.y, b.max.y)), Math.max(b.min.z, Math.min(eye.z, b.max.z)))
    const c = b.min.plus(b.max).scaled(0.5)
    for (const tp of [near, near.plus(c).scaled(0.5), c]) {
      const dv = tp.minus(eye); const len = dv.norm()
      if (len < 1e-6 || len > SWORD_REACH + 1.5) continue
      const dir = dv.scaled(1 / len)
      const tIn = pick.rayBox(eye, dir, b.min, b.max, SWORD_REACH)
      if (tIn == null || tIn > SWORD_REACH) continue
      // другая часть раньше на луче — прицел клиента взял бы её
      let first = true
      for (const [n2, o] of boxes) { if (n2 === name) continue; const t2 = pick.rayBox(eye, dir, o.min, o.max, tIn); if (t2 != null && t2 < tIn - 1e-3) { first = false; break } }
      if (!first) continue
      if (pick.blockOnRay(bot, eye, dir, tIn + 0.01)) continue
      return { name, id, point: eye.plus(dir.scaled(tIn + 0.05)), dist: tIn }
    }
  }
  return null
}

const BED_GAP_MS = 560

const BEDS_DOUBLE = process.env.ND_BEDS_DOUBLE === '1'

const BEDS_TAKEOFF = process.env.ND_BEDS_TAKEOFF === '1'

const takeoffSeen = new Map()

function noteTakeoff (d, ph, now) {
  let r = takeoffSeen.get(d.id)
  if (!r) { r = { t0: 0, pos: null, az: [] }; takeoffSeen.set(d.id, r) }
  if (ph === PHASE.TAKEOFF && !r.t0) { r.t0 = now; r.pos = d.position.clone() }
  if (r.t0 && now - r.t0 >= 1800) {
    const dx = d.position.x - r.pos.x; const dz = d.position.z - r.pos.z
    if (Math.hypot(dx, dz) >= 3 && now - r.t0 <= 2800) { r.az.push(Math.atan2(dz, dx)); if (r.az.length > 6) r.az.shift() }
    r.t0 = 0
  }
}

function bedClickPoint (bot, plan) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const grid = [0.85, 0.7, 0.5, 0.3, 0.15]
  for (const c of [plan.H, plan.F]) {
    const pos = new Vec3(c.x, plan.y, c.z)
    const b = bot.blockAt(pos)
    if (!b || !/_bed$/.test(b.name)) continue
    const top = Math.max(...(b.shapes && b.shapes.length ? b.shapes.map(s => s[4]) : [BED_TOP]))
    for (const a of grid) {
      for (const s of [0.5, 0.25, 0.75]) {
        // a — вдоль оси D (дальше от нас — больше), s — поперёк.
        const P = new Vec3(c.x + (plan.D.x ? (plan.D.x > 0 ? a : 1 - a) : s), pos.y + top, c.z + (plan.D.z ? (plan.D.z > 0 ? a : 1 - a) : s))
        const delta = P.minus(eye)
        const len = delta.norm()
        if (len > 4.4 || len < 0.5) continue
        const hit = pick.blockOnRay(bot, eye, delta.scaled(1 / len), len + 0.05)
        if (hit && /_bed$/.test(hit.block.name) && Math.abs(hit.t - len) < 0.04) return { block: hit.block, point: P }
      }
    }
  }
  return null
}

async function clickBedAt (bot, hit, { aimed = false, until = 0, prePlace = null }: any = {}) {
  bot.setControlState('sneak', false)
  if (!aimed) {
    await lookAtSafe(bot, hit.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
  }
  // Точный миг (снижение: тик до посадки): ждём игровой таймер, освобождая цикл событий для следующих тиков.
  if (until) {
    while (until - gameClock.now() > 12) await sleep(Math.min(40, until - gameClock.now() - 10))
    while (gameClock.now() < until) await sleep(until - gameClock.now())
    // Опоздание цикла событий (02.10, rs17: CPU ПК 100 % — щелчок уходил на 2–6 тиков позже плана, голова в 4–8 бл. вместо 1–2):
    // опоздали больше ND_CLICK_LATE_MS — кровать не тратить, ждать следующий проход. 0 — выкл. (по умолчанию, не замерено).
    const late = gameClock.now() - until, lim = envNum('ND_CLICK_LATE_MS', 0)
    if (lim > 0 && late > lim) { hit.guardWhy = `опоздал на ${late} мс`; return false }
  }
  if (hit.runnerGuard) { const g = hit.runnerGuard(); if (g !== true) { hit.guardWhy = typeof g === 'string' ? g : null; return false } }
  // ND_PLACE_CLICK: кровать ставится к грани опоры и тут же взрывается — два пакета подряд, сервер разбирает их в одном
  // окне между тиками (дракон кровать не застаёт)
  if (prePlace) {
    if (runnerOn() && hit.face) runnerAim(bot, prePlace.point)
    const pc = prePlace.point.minus(prePlace.pos)
    bot._client.write('block_place', { location: prePlace.pos, direction: FACE_IDX(prePlace.face), hand: 0, cursorX: pc.x, cursorY: pc.y, cursorZ: pc.z, insideBlock: false, sequence: 0, worldBorderHit: false })
  }
  if (runnerOn() && hit.face) runnerAim(bot, hit.point)
  const cur = hit.point.minus(hit.block.position)
  bot._client.write('block_place', { location: hit.block.position, direction: runnerOn() && hit.face ? FACE_IDX(hit.face) : 1, hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
  bot.swingArm()
}

async function bedsBuild (session, ctl, stats, plan) {
  const bot = session.bot
  const at = (c, y) => new Vec3(c.x, y, c.z)
  for (const f of plan.fills) {
    doing(ctl, 'beds:fill')
    const r: any = await placeNoBed(bot, f, { timeoutMs: 1200 })
    if (!r.ok) return { ok: false, why: `пол не встал: ${r.reason || r.why}` }
    stats.bedBlocks = (stats.bedBlocks || 0) + 1
  }
  if (!plan.reuse) {
    doing(ctl, 'beds:bed')
    // Изголовье ляжет по взгляду (BedBlock.getStateForPlacement: FACING —
    // горизонталь взгляда из последнего пакета движения): взгляд, тик, клик.
    const r = await placeBedAt(bot, plan.F, plan.H, plan.y)
    if (!r.ok) return r
  }
  const w = bot.blockAt(at(plan.W, plan.y))
  if (!w || !isSolid(w)) {
    doing(ctl, 'beds:wall')
    const r: any = await placeNoBed(bot, at(plan.W, plan.y), { timeoutMs: 1200 })
    if (!r.ok) return { ok: false, why: `заслон не встал: ${r.reason || r.why}` }
    stats.bedBlocks = (stats.bedBlocks || 0) + 1
  }
  return { ok: true }
}

function cardOf (vx, vz) { return Math.abs(vx) >= Math.abs(vz) ? { x: Math.sign(vx) || 1, z: 0 } : { x: 0, z: Math.sign(vz) || 1 } }

function cellsOnSeg (a, b) {
  const out = new Map()
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.1))
  const a0 = `${Math.floor(a.x)},${Math.floor(a.z)}`; const b0 = `${Math.floor(b.x)},${Math.floor(b.z)}`
  for (let k = 1; k < n; k++) {
    const x = Math.floor(a.x + (b.x - a.x) * k / n); const z = Math.floor(a.z + (b.z - a.z) * k / n)
    const key = `${x},${z}`
    if (key !== a0 && key !== b0) out.set(key, { x, z })
  }
  return [...out.values()]
}

const SEEN_Y = [0, 0.391, 0.783, 1.174]

function lowRowsOpen (vbot, feet, centre) {
  let open = 0
  for (const fy of SEEN_Y) {
    for (const ox of SEEN_XZ) {
      for (const oz of SEEN_XZ) {
        const p = new Vec3(feet.x + ox, feet.y + fy, feet.z + oz)
        const dv = centre.minus(p); const len = dv.norm()
        if (len < 0.1) { open++; continue }
        if (!pick.blockOnRay(vbot, p, dv.scaled(1 / len), len - 0.02)) open++
      }
    }
  }
  return open
}

function bedPointFrom (vbot, eye, cells, y, far) {
  const grid = [0.85, 0.7, 0.5, 0.3, 0.15]
  for (const c of cells) {
    for (const a of grid) {
      for (const s of [0.5, 0.25, 0.75]) {
        // a — дальше от нас по главной оси взгляда (far), s — поперёк.
        const P = new Vec3(c.x + (far.x ? (far.x > 0 ? a : 1 - a) : s), y + BED_TOP, c.z + (far.z ? (far.z > 0 ? a : 1 - a) : s))
        const dv = P.minus(eye); const len = dv.norm()
        if (len > 4.4 || len < 0.5) continue
        const hit = pick.blockOnRay(vbot, eye, dv.scaled(1 / len), len + 0.05)
        if (hit && /_bed$/.test(hit.block.name) && Math.abs(hit.t - len) < 0.04 && hit.pos.x === c.x && hit.pos.z === c.z) return P
      }
    }
  }
  return null
}

async function doubleBuild (session, ctl, stats, plan) {
  const bot = session.bot
  // Крышка облака огня — первой: облако встаёт на 10-м тике огня (через 2.5 с
  // после рёва) и ложится на верх первого непустого блока в своей колонке.
  if (plan.lid) {
    for (let k = 0; k < plan.lid.h; k++) {
      const p = new Vec3(plan.lid.x, plan.lid.y + k, plan.lid.z)
      if (isSolid(bot.blockAt(p))) continue
      doing(ctl, 'beds:lid')
      const r: any = await placeNoBed(bot, p, { timeoutMs: 1200 })
      if (!r.ok) return { ok: false, why: `крышка не встала: ${r.reason || r.why}` }
      stats.bedBlocks = (stats.bedBlocks || 0) + 1
    }
  }
  for (const T of [plan.C, plan.X]) {
    const h = bot.blockAt(new Vec3(T.H.x, plan.y, T.H.z)); const f = bot.blockAt(new Vec3(T.F.x, plan.y, T.F.z))
    if (h && /_bed$/.test(h.name) && f && /_bed$/.test(f.name)) continue
    if (T.fill && !isSolid(bot.blockAt(T.fill))) {
      doing(ctl, 'beds:fill')
      const r: any = await placeNoBed(bot, T.fill, { timeoutMs: 1200 })
      if (!r.ok) return { ok: false, why: `пол не встал: ${r.reason || r.why}` }
      stats.bedBlocks = (stats.bedBlocks || 0) + 1
    }
    doing(ctl, T === plan.C ? 'beds:bedC' : 'beds:bedX')
    const r = await placeBedAt(bot, T.F, T.H, plan.y)
    if (!r.ok) return { ok: false, why: `${T === plan.C ? 'C' : 'X'}: ${r.why}` }
  }
  const wallKeys = new Set(plan.walls.map(w => `${w.x},${w.z}`))
  const order = [...plan.place].sort((a, b) => (wallKeys.has(`${a.x},${a.z}`) ? 1 : 0) - (wallKeys.has(`${b.x},${b.z}`) ? 1 : 0) || a.y - b.y)
  for (const p of order) {
    if (ctl.aborted) return { ok: false, why: 'прервано' }
    if (isSolid(bot.blockAt(p))) continue
    doing(ctl, wallKeys.has(`${p.x},${p.z}`) ? 'beds:wall' : 'beds:shield')
    const r: any = await placeNoBed(bot, p, { timeoutMs: 1200 })
    if (!r.ok) return { ok: false, why: `${wallKeys.has(`${p.x},${p.z}`) ? 'стенка' : 'щит'} не встал: ${r.reason || r.why}` }
    stats.bedBlocks = (stats.bedBlocks || 0) + 1
  }
  return { ok: true }
}

function exposedNow (bot, y, T) {
  const extra = new Map()
  for (const c of [T.H, T.F]) extra.set(`${c.x},${y},${c.z}`, 'air')
  return lowRowsOpen(virtualBot(bot, extra), bot.entity.position, T.centre)
}

async function shieldFor (session, ctl, stats, plan, T) {
  const bot = session.bot
  if (!exposedNow(bot, plan.y, T)) return true
  for (const w of plan.walls || []) {
    const p = new Vec3(w.x, plan.y, w.z)
    if (isSolid(bot.blockAt(p))) continue
    doing(ctl, 'beds:wall-fix')
    const r = await placeNoBed(bot, p, { timeoutMs: 1000 })
    if (r.ok) stats.bedBlocks = (stats.bedBlocks || 0) + 1
  }
  return !exposedNow(bot, plan.y, T)
}

function doubleHit (bot, plan, T) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const far = cardOf(T.H.x + 0.5 - eye.x, T.H.z + 0.5 - eye.z)
  const P = bedPointFrom(bot, eye, [T.H, T.F], plan.y, far)
  if (!P) return null
  const block = bot.blockAt(new Vec3(Math.floor(P.x), plan.y, Math.floor(P.z)))
  return block && /_bed$/.test(block.name) ? { block, point: P } : null
}

function seeCalibrate (bot, d) {
  const fx = sitFix.get(d.id)
  if (!fx || !fx.sit || fx.calibrated === d.yaw) return fx ? fx.calibOk : false
  const S = simClone(fx.sit)
  S.x = fx.pos.x; S.y = fx.pos.y; S.z = fx.pos.z
  S.yRot = yRotOf(fx.yaw); S.yRotA = fx.yRotA
  const me = fx.me || bot.entity.position
  const pr = scanPredict(S, me, 25)
  const yawNow = yRotOf(d.yaw)
  const dy = Math.abs(wrapDeg(pr.s.yRot - yawNow))
  fx.calibrated = d.yaw
  fx.calibOk = dy <= 4
  fx.yaw = d.yaw
  fx.yRotA = fx.calibOk ? pr.s.yRotA : 0
  fx.scan = { dYaw: r1(dy), A: r1(pr.s.yRotA) }
  return fx.calibOk
}

function approachFar (dd) { return !!dd && TOWER_FAR > 0 && Math.hypot(dd.position.x - CENTER.x, dd.position.z - CENTER.z) > 60 }

function pillowDys () { return envv('ND_PILLOW_DY') != null ? [Number(envv('ND_PILLOW_DY'))] : envv('ND_PILLOW_TRY1') === '1' ? [1, 0, -1] : [0, -1] }

function pillarKey (p) { return `${p.B.x},${p.B.z}|${p.H.x},${p.H.z}|${p.F.x},${p.F.z}` }

function stationBedPlaced (bot, ctl) {
  const pl = ctl && ctl.pillar && ctl.pillar.built && ctl.pillar.plan
  if (!pl) return false
  const at = (x, z) => /_bed$/.test((bot.blockAt(new Vec3(x, pl.yb, z)) || {}).name || '')
  return at(pl.H.x, pl.H.z) && at(pl.F.x, pl.F.z)
}

function headPoint (bot, d, track, lead = 0) {
  const parts = partsOf(bot, d, track)
  const v = SITTING.has(phaseOf(bot, d)) ? { x: 0, y: 0, z: 0 } : track.vel()
  return new Vec3(parts.headC.x + v.x * lead, parts.head.min.y + v.y * lead, parts.headC.z + v.z * lead)
}

function portalBlocks (bot) {
  const id = bot.registry.blocksByName.end_portal && bot.registry.blocksByName.end_portal.id
  if (id == null) return []
  return bot.findBlocks({ matching: id, maxDistance: 48, count: 30, point: new Vec3(0, 60, 0) })
}

module.exports = { crysOn, crystalTimingAllowed, crystalShotFrom, crysState, crysTargets, crystalSpot, meleeSpot, OC_ON, scanPredict, OBS, OBS_ANY, pillarCells, faceClick, faceClickFacing, runnerPlan, runnerAim, pillarPlan, RUN_SWORD, SWORD_V2, SWORD_PED, SWORD_REACH, swordPick, BED_GAP_MS, BEDS_DOUBLE, BEDS_TAKEOFF, takeoffSeen, noteTakeoff, bedClickPoint, clickBedAt, bedsBuild, cardOf, cellsOnSeg, SEEN_Y, lowRowsOpen, bedPointFrom, doubleBuild, exposedNow, shieldFor, doubleHit, seeCalibrate, approachFar, pillowDys, pillarKey, stationBedPlaced, headPoint, portalBlocks }
