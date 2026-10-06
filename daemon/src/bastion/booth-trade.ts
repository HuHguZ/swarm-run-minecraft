const { gameClock, countOf, Vec3, BF, mobs, isBaby, sleep, xyz, unpackGold, aggressive, admiring, raySees, eyePos, seesMob, inLava, lavaEscape, walkGoal, goals, dropJunk, lavaEscapeDeep, log, SIDES4, inOwnTunnel } = require('./take-gold-block')
const { pitLike, junkOut, eatIfHungry, hitThroughWindow, lastGoldBreak, makeSill, unholdGold, distToBox, throwLands, handNoWalk, tossLands, aimOut, pitLures, floorRegion, tossOut, rayClear, PIGLIN_EYE } = require('./predict-gold')
const ownTunnelAt = (bot, S) => inOwnTunnel(bot, S)

async function lavaWatched (bot, ctl, fn) {
  const sub = { aborted: false, onAbort: [] as Array<() => void>, async waitReflex () {
    if (ctl.waitReflex) await ctl.waitReflex()
    if (ctl.aborted) throw Object.assign(new Error('reflex: действие прервано'), { code: 'REFLEX_CANCELLED' })
  } }
  const cut = () => { if (sub.aborted) return; sub.aborted = true; for (const f of sub.onAbort) { try { f() } catch {} } }
  ctl.onAbort && ctl.onAbort.push(cut)
  if (ctl.aborted) cut()
  const watch = gameClock.setInterval(() => { if (ctl.aborted || inLava(bot)) cut() }, 100)
  let r
  try { r = await fn(sub) } finally {
    gameClock.clearInterval(watch)
    if (ctl.onAbort) { const index = ctl.onAbort.indexOf(cut); if (index >= 0) ctl.onAbort.splice(index, 1) }
  }
  if (inLava(bot)) {
    try { bot.pathfinder.setGoal(null) } catch {}
    bot.clearControlStates()
    // Прыжок не вынес (D7-26 03.10: «из лавы» к клетке над лавой, «выбрался» с inLava true, смерть через 2 с) — вплавь.
    await lavaEscape(bot)
    if (inLava(bot)) await lavaEscapeDeep(bot)
    log('штрек оборван: лава у ног — выбрался', { hp: Math.round(bot.health ?? 0), inLava: inLava(bot) })
    if (r && typeof r === 'object') r = { ...r, ok: false, why: 'лава у ног' }
  }
  return r
}

async function barterRound (session, ctl, st, count, deadline) {
  const bot = session.bot
  const pearls = require('.././pearls')
  const secs = Math.max(20, Math.min(180, Math.round((deadline - gameClock.now()) / 1000) - 5))
  const r = await pearls.barter(session, ctl, { count, timeoutSeconds: secs, force: !BF.enabled() })
  st.traded += r.spent || 0
  for (const [k, v] of (Object.entries(r.gained || {}) as [string, any][])) st.gained[k] = (st.gained[k] || 0) + v
  st.barters.push({ spent: r.spent || 0, stopped: r.stopped, pearls: r.pearls || 0 })
  const tossed = await dropJunk(bot)
  if (tossed.length) st.tossed.push(...tossed)
  return r
}

function nextToBlock (f, t) {
  const dx = f.x - t.x; const dy = f.y - t.y; const dz = f.z - t.z
  return Math.abs(dx) + Math.abs(dy < 0 ? dy + 1 : dy) + Math.abs(dz) === 1
}

function bruteComing (bot) {
  return mobs(bot, 'piglin_brute', 10).some(e => aggressive(bot, e) && seesMob(bot, e))
}

async function walkUnlessBrute (session, ctl, goal, ms, opts) {
  const bot = session.bot
  let hit = false
  const iv = gameClock.setInterval(() => { if (bruteComing(bot)) { hit = true; try { bot.pathfinder.setGoal(null) } catch {} } }, 300)
  try {
    const w = await walkGoal(session, ctl, goal, ms, opts)
    return hit ? { ok: false, error: 'брут идёт' } : w
  } finally { gameClock.clearInterval(iv) }
}

async function stepCell (bot, next, up) {
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 2500 && !bot.entity.position.floored().equals(next)) {
      await bot.lookAt(next.offset(0.5, 1.6, 0.5), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', !!up)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
  await sleep(200)
  return bot.entity.position.floored().equals(next)
}

async function tunnelTo (session, ctl, target, { maxSteps = 60 }: any = {}) {
  const bot = session.bot
  const GUARD = /^(gold_block|gilded_blackstone|chest|trapped_chest|barrel|raw_gold_block|gold_ore|nether_gold_ore|bedrock)$/
  const wet = c => {
    for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = bot.blockAt(c.offset(dx, dy, dz))
      if (b && /lava|water/.test(b.name)) return true
    }
    return false
  }
  const clearable = c => {
    const b = bot.blockAt(c)
    if (!b) return false
    if (b.boundingBox === 'empty') return !/lava|water/.test(b.name)
    if (GUARD.test(b.name)) return false
    return !wet(c)
  }
  // Пол под новой клеткой ног: воздух — упадём, до лавы — смерть. Ферма 29.09,
  // bastion-route-12: тело копало пол на y 37 и падало в море лавы (y ≤ 31).
  const landOk = c => {
    for (let d = 1; d <= 4; d++) {
      const b = bot.blockAt(c.offset(0, -d, 0))
      if (!b) return 'мир не прогружен'
      if (/lava|fire|magma/.test(b.name)) return `под ногами ${b.name}`
      if (b.boundingBox === 'block') return d <= 2 ? null : `обрыв ${d}`
    }
    return 'пропасть'
  }

  let steps = 0
  for (; steps < maxSteps && !ctl.aborted; steps++) {
    if (inLava(bot)) { await lavaEscape(bot); return { ok: false, why: 'лава', steps } }
    if (bruteComing(bot)) return { ok: false, why: 'брут идёт', steps }
    const f = bot.entity.position.floored()
    if (nextToBlock(f, target)) return { ok: true, steps }
    const dx = Math.sign(target.x - f.x); const dz = Math.sign(target.z - f.z)
    const needDown = target.y < f.y - 0 && !(Math.abs(target.x - f.x) + Math.abs(target.z - f.z) === 0 && target.y === f.y - 1)
    const needUp = target.y > f.y + 1
    const sy = needDown ? -1 : needUp ? 1 : 0
    const opts = []
    const ax = Math.abs(target.x - f.x) >= Math.abs(target.z - f.z)
    if (dx || dz) {
      const first = ax && dx ? [dx, 0] : dz ? [0, dz] : [dx, 0]
      const second = first[0] ? (dz ? [0, dz] : null) : (dx ? [dx, 0] : null)
      for (const [hx, hz] of [first, second].filter(Boolean)) opts.push({ next: f.offset(hx, sy, hz), up: sy > 0 })
      // Вбок и прямо, если по высоте не пускает (ступенька упёрлась).
      if (sy) for (const [hx, hz] of [first, second].filter(Boolean)) opts.push({ next: f.offset(hx, 0, hz), up: false })
    }
    if (!dx && !dz && sy) opts.push({ next: f.offset(0, sy, 0), up: sy > 0, vertical: true })
    let moved = false
    const why = []
    for (const o of opts) {
      // Клетки: ноги и голова следующей, при подъёме — ещё над своей головой.
      const cells = [o.next, o.next.offset(0, 1, 0)]
      if (o.up) cells.push(f.offset(0, 2, 0))
      if (o.vertical && sy < 0) cells.length = 1 // вниз столбом: только под ногами
      const bad = cells.find(c => !clearable(c))
      if (bad) { const bb = bot.blockAt(bad); why.push(`${xyz(bad).x},${xyz(bad).y},${xyz(bad).z}:${bb ? bb.name : '?'}${bb && bb.boundingBox !== 'empty' && wet(bad) ? '+жидкость' : ''}`); continue }
      const land = landOk(o.next)
      if (land) { why.push(`${o.next.x},${o.next.y},${o.next.z}:${land}`); continue }
      // Цель — золото: не ломать его как проход (ломает takeGoldBlock).
      if (cells.some(c => c.equals(target))) continue
      // Каждая клетка — через грань, которую видит прицел (pen-trap.digSeenAll, S2b 06.10): прежде bot.dig 'auto' смотрел
      // в центр блока, и вниз по ступени нижняя клетка копалась сквозь пол под ногами.
      const dr = await require('./pen-trap').digSeenAll(bot, cells)
      if (dr !== 'ok') { why.push(`не копается ${dr}`); continue }
      if (o.vertical && sy < 0) { await sleep(500); moved = true; break }
      // Шаг сам (вперёд, при подъёме — с прыжком): pathfinder на шаг в
      // свежую клетку отвечал «пустой путь» (пол Ада min(40, y) и не только).
      const d0 = Math.abs(f.x - target.x) + Math.abs(f.y - target.y) + Math.abs(f.z - target.z)
      let okStep = await stepCell(bot, o.next, o.up)
      // Сам не шагнул (зацепился краем, ступень) — один ход pathfinder'ом с копкой
      // (пол Ада опущен обёрткой digToPredicted, иначе «пустой путь»).
      if (!okStep && bot.entity.position.floored().equals(f)) {
        const w1 = await walkGoal(session, ctl, new goals.GoalBlock(o.next.x, o.next.y, o.next.z), 3500, { dig: true })
        okStep = !!(w1 && w1.ok)
      }
      const g = bot.entity.position.floored()
      // Шагнул не ровно в клетку (сполз ниже, съехал вбок), но ближе к цели — тоже ход.
      if (okStep || (!g.equals(f) && Math.abs(g.x - target.x) + Math.abs(g.y - target.y) + Math.abs(g.z - target.z) < d0)) { moved = true; break }
      why.push(`не шагнул ${o.next.x},${o.next.y},${o.next.z}`)
    }
    if (!moved) return { ok: false, why: 'штрек упёрся: ' + (why.join('; ') || 'нет ходов'), steps, at: xyz(f) }
  }
  return { ok: nextToBlock(bot.entity.position.floored(), target), steps, why: steps >= maxSteps ? 'штрек длиннее лимита' : undefined }
}

const DAMAGE_TYPES = ['arrow', 'bad_respawn_point', 'cactus', 'campfire', 'cramming', 'dragon_breath', 'drown', 'dry_out',
  'ender_pearl', 'explosion', 'fall', 'falling_anvil', 'falling_block', 'falling_stalactite', 'fireball', 'fireworks',
  'fly_into_wall', 'freeze', 'generic', 'generic_kill', 'hot_floor', 'in_fire', 'in_wall', 'indirect_magic', 'lava',
  'lightning_bolt', 'mace_smash', 'magic', 'mob_attack', 'mob_attack_no_aggro', 'mob_projectile', 'on_fire',
  'out_of_world', 'outside_border', 'player_attack', 'player_explosion', 'sonic_boom', 'spear', 'spit', 'stalagmite',
  'starve', 'sting', 'sweet_berry_bush', 'thorns', 'thrown', 'trident', 'unattributed_fireball', 'wind_charge',
  'wither', 'wither_skull']

function boothAt (view, own, O, d) {
  const SL = require('.././sealed')
  const c = (x, y, z) => view.cls(x, y, z)
  const stand = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD || k === SL.FALL
  const firm = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD
  if (c(O.x, O.y, O.z) !== SL.AIR || c(O.x, O.y + 1, O.z) !== SL.AIR || !stand(c(O.x, O.y - 1, O.z))) return null
  const C = { x: O.x - d[0], y: O.y, z: O.z - d[1] }
  const W = { x: C.x, y: C.y + 1, z: C.z }
  const F = { x: O.x - 2 * d[0], y: O.y, z: O.z - 2 * d[1] }
  if (!firm(c(C.x, C.y, C.z))) return null
  if (c(W.x, W.y, W.z) !== SL.SOLID) return null
  if (!firm(c(W.x, W.y + 1, W.z))) return null
  const px = d[1]; const pz = d[0]
  if (!firm(c(W.x + px, W.y, W.z + pz)) || !firm(c(W.x - px, W.y, W.z - pz))) return null
  const cellOk = (x, y, z) => { const k = c(x, y, z); return k === SL.SOLID || (k === SL.AIR && own.has(SL.key(x, y, z))) }
  if (!cellOk(F.x, F.y, F.z) || !cellOk(F.x, F.y + 1, F.z)) return null
  if (!stand(c(F.x, F.y - 1, F.z))) return null
  // Широкое окно: ещё по клетке окна слева и справа (W±p) и ниши на высоте головы (F+1±p) —
  const wide = [1, -1].every(sg => {
    const q = (base, k = 1) => ({ x: base.x + sg * px * k, y: base.y, z: base.z + sg * pz * k })
    const Cs = q(C); const Ws = q(W); const Hs = q({ x: F.x, y: F.y + 1, z: F.z })
    return firm(c(Cs.x, Cs.y, Cs.z)) && c(Ws.x, Ws.y, Ws.z) === SL.SOLID && firm(c(Ws.x, Ws.y + 1, Ws.z)) &&
      firm(c(W.x + sg * px * 2, W.y, W.z + sg * pz * 2)) &&
      cellOk(Hs.x, Hs.y, Hs.z) && firm(c(Hs.x, Hs.y - 1, Hs.z)) && firm(c(Hs.x, Hs.y + 1, Hs.z)) &&
      firm(c(F.x + sg * px * 2, F.y + 1, F.z + sg * pz * 2)) && firm(c(Hs.x - d[0], Hs.y, Hs.z - d[1]))
  })
  return { O, C, W, F, d, p: [px, pz], wide }
}

function boothCandidates (bot, view, own, radius = 40) {
  const me = bot.entity.position
  const pigs = mobs(bot, 'piglin', radius).filter(e => !isBaby(bot, e))
  const seen = new Set()
  const out = []
  for (const pg of (pigs as any)) {
    const p = pg.position.floored()
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = 0; dy <= 0; dy++) {
          const O = { x: p.x + dx, y: p.y + dy, z: p.z + dz }
          for (const d of SIDES4) {
            const k = `${O.x},${O.y},${O.z}|${d}`
            if (seen.has(k)) continue
            seen.add(k)
            const b: any = boothAt(view, own, O, d)
            if (!b) continue
            const center = new Vec3(O.x + 0.5, O.y, O.z + 0.5)
            // Пиглины на том же полу, что O: окно на высоте их ног + 1 (booth-1: пол комнаты на блок выше O — добыча била в стену над окном).
            b.pigs = pigs.filter((e : any) => e.position.distanceTo(center) <= 7 && Math.abs(e.position.y - O.y) < 0.6).length
            b.brutes = mobs(bot, 'piglin_brute', 7, center).length
            b.d0 = center.distanceTo(me)
            out.push(b)
          }
        }
      }
    }
  }
  return out.filter(b => b.pigs >= 2).sort((a, b) => (Number(b.wide) - Number(a.wide)) || (b.pigs - a.pigs) || (a.d0 - b.d0))
}

function currentPit (bot, S) {
  const SL = require('.././sealed')
  const CM = require('./cover-memory')
  if (!S?.own || !bot.entity.onGround) return null
  const P = bot.entity.position.floored()
  const H = P.offset(0, 1, 0); const M = P.offset(0, 2, 0); const R = P.offset(0, 3, 0)
  const air = q => SL.classOf(bot.blockAt(new Vec3(q.x, q.y, q.z))) === SL.AIR
  const firm = q => require('./take-gold-block').fullCover(bot.blockAt(new Vec3(q.x, q.y, q.z)))
  const own = new Set(S.own)
  if (!own.has(SL.keyV(P)) || !own.has(SL.keyV(H)) || !air(P) || !air(H) || !air(M) || !firm(P.offset(0, -1, 0)) ||
    !CM.protectedGeometry(P, own, SL.exposure(bot, own), air, firm)) return null
  const d = SIDES4.find(([dx, dz]) => air(M.offset(dx, 0, dz)) && air(M.offset(dx, 1, dz)) && firm(M.offset(dx, -1, dz)))
  if (!d) return null
  const O = M.offset(d[0], 0, d[1])
  const region = floorRegion(require('.././drops').blockGetter(bot), O.x, O.z, M.y)
  const pigs = mobs(bot, 'piglin', 16).filter(pg => !isBaby(bot, pg) && !aggressive(bot, pg) &&
    Math.abs(pg.position.y - M.y) < 0.6 && region.has(`${Math.floor(pg.position.x)},${Math.floor(pg.position.z)}`))
  if (!pigs.length || mobs(bot, 'piglin_brute', 7, O).length) return null
  S.own.add(SL.keyV(M))
  return { kind: 'pit', P: xyz(P), H: xyz(H), M: xyz(M), R: xyz(R), O: xyz(O), d, p: [d[1], d[0]],
    dump: null, F: xyz(P), W: xyz(M), C: xyz(H), sill: true, pigs: pigs.length, brutes: 0, reused: true }
}

function pitAt (view, own, O, d) {
  const SL = require('.././sealed')
  const c = (x, y, z) => view.cls(x, y, z)
  const stand = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD || k === SL.FALL
  const firm = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD
  const mineK = (x, y, z) => own.has(SL.key(x, y, z))
  if (c(O.x, O.y, O.z) !== SL.AIR || c(O.x, O.y + 1, O.z) !== SL.AIR || !firm(c(O.x, O.y - 1, O.z))) return null
  const M = { x: O.x - d[0], y: O.y, z: O.z - d[1] }
  const R = { x: M.x, y: M.y + 1, z: M.z }
  const H = { x: M.x, y: M.y - 1, z: M.z }
  const P = { x: M.x, y: M.y - 2, z: M.z }
  if (c(M.x, M.y, M.z) !== SL.SOLID || !firm(c(R.x, R.y, R.z))) return null
  const px = d[1]; const pz = d[0]
  // Рот открыт только к O: по бокам и сзади — твёрдое (или наш штрек).
  for (const [x, y, z] of [[M.x + px, M.y, M.z + pz], [M.x - px, M.y, M.z - pz], [M.x - d[0], M.y, M.z - d[1]]]) {
    if (!firm(c(x, y, z)) && !mineK(x, y, z)) return null
  }
  const cellOk = (x, y, z) => { const k = c(x, y, z); return k === SL.SOLID || (k === SL.AIR && mineK(x, y, z)) }
  if (!cellOk(H.x, H.y, H.z) || !cellOk(P.x, P.y, P.z) || !stand(c(P.x, P.y - 1, P.z))) return null
  // Свалка хлама: столб сбоку — у головы (Dh), у ног (D1) и под ней (D2). Брошенное почти
  const sealedOk = (x, y, z, ours) => SL.FACES.every(([fx, fy, fz]) => {
    const k = SL.key(x + fx, y + fy, z + fz)
    if (mineK(x + fx, y + fy, z + fz) || ours.includes(k)) return true
    const n = c(x + fx, y + fy, z + fz)
    return n === SL.SOLID || n === SL.HARD || n === SL.GUARD
  })
  let dump = null
  for (const sg of [1, -1]) {
    const D1 = { x: P.x + sg * px, y: P.y, z: P.z + sg * pz }
    const D2 = { x: D1.x, y: D1.y - 1, z: D1.z }
    const Dh = { x: D1.x, y: D1.y + 1, z: D1.z }
    const cells = [Dh, D1, D2]
    const ours = [SL.key(P.x, P.y, P.z), SL.key(H.x, H.y, H.z), ...cells.map(q => SL.key(q.x, q.y, q.z))]
    if (cells.every(q => cellOk(q.x, q.y, q.z) && sealedOk(q.x, q.y, q.z, ours))) { dump = { Dh, D1, D2 }; break }
  }
  return { kind: 'pit', O, M, R, H, P, d, p: [px, pz], dump, F: P, W: M, C: H, sill: true }
}

function pitCandidates (bot, view, own, radius = 40) {
  const me = bot.entity.position
  const pigs = mobs(bot, 'piglin', radius).filter(e => !isBaby(bot, e))
  const seen = new Set()
  const out = []
  for (const pg of (pigs as any)) {
    const p = pg.position.floored()
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        const O = { x: p.x + dx, y: p.y, z: p.z + dz }
        for (const d of SIDES4) {
          const k = `${O.x},${O.y},${O.z}|${d}`
          if (seen.has(k)) continue
          seen.add(k)
          const b: any = pitAt(view, own, O, d)
          if (!b) continue
          const center = new Vec3(O.x + 0.5, O.y, O.z + 0.5)
          b.pigs = pigs.filter((e : any) => e.position.distanceTo(center) <= 7 && Math.abs(e.position.y - O.y) < 0.6).length
          b.brutes = mobs(bot, 'piglin_brute', 7, center).length
          b.d0 = center.distanceTo(me)
          out.push(b)
        }
      }
    }
  }
  const pre = out.filter(b => b.pigs >= (BF.enabled() ? 1 : 2) && (!BF.enabled() || !b.brutes)).sort((a, b) => (Number(!!b.dump) - Number(!!a.dump)) || (b.pigs - a.pigs) || (a.d0 - b.d0)).slice(0, 24)
  // Место улова: сколько клеток пола у рта, откуда пиглин нас видит, до него дотянемся, и его
  // бросок (расчёт полёта) ляжет к нам. pit-real 29.09: рот у тесной лестницы — 70–89% добычи.
  for (const b of pre) b.catch = catchScore(bot, b)
  return pre.filter(b => b.catch >= 2).sort((a, b) => (Number(!!b.dump) - Number(!!a.dump)) || (b.catch - a.catch) || (b.pigs - a.pigs) || (a.d0 - b.d0))
}

function catchScore (bot, bo) {
  const base = require('.././drops').blockGetter(bot)
  const openK = new Set([bo.M, bo.H, bo.P].map(c => `${c.x},${c.y},${c.z}`))
  const AIRB = { name: 'air', shapes: [], boundingBox: 'empty' }
  const getBlock = (x, y, z) => openK.has(`${x},${y},${z}`) ? AIRB : base(x, y, z)
  const feet = new Vec3(bo.P.x + 0.5, bo.P.y, bo.P.z + 0.5)
  const eye = feet.offset(0, 1.62, 0)
  const empty = q => q && q.boundingBox === 'empty' && !/lava|water|fire/.test(q.name)
  let n = 0
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      const x = bo.M.x + dx; const z = bo.M.z + dz; const y = bo.M.y
      if (openK.has(`${x},${y},${z}`) || Math.hypot(dx, dz) > 3.2) continue
      const f = getBlock(x, y - 1, z)
      if (!empty(getBlock(x, y, z)) || !empty(getBlock(x, y + 1, z)) || !f || f.boundingBox !== 'block') continue
      const from = new Vec3(x + 0.5, y, z + 0.5)
      if (!rayClear(getBlock, from.offset(0, PIGLIN_EYE, 0), eye)) continue
      if (throwLands(bot, from, feet, getBlock).ok) n++
    }
  }
  return n
}

function trapAt (view, own, O, d) {
  const SL = require('.././sealed')
  const c = (x, y, z) => view.cls(x, y, z)
  const stand = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD || k === SL.FALL
  const firm = k => k === SL.SOLID || k === SL.HARD || k === SL.GUARD
  const mineK = (x, y, z) => own.has(SL.key(x, y, z))
  const solidDig = (x, y, z) => c(x, y, z) === SL.SOLID && !mineK(x, y, z)
  const cellOk = (x, y, z) => { const k = c(x, y, z); return k === SL.SOLID || (k === SL.AIR && mineK(x, y, z)) }
  // O — клетка пола пиглинов (их ноги), под ней будет камера.
  if (c(O.x, O.y, O.z) !== SL.AIR || c(O.x, O.y + 1, O.z) !== SL.AIR) return null
  const px = d[1]; const pz = d[0]
  const cell = (b, k = 1) => ({ x: b.x + d[0] * k, y: b.y, z: b.z + d[1] * k })
  const up = (b, k = 1) => ({ x: b.x, y: b.y + k, z: b.z })
  // Камера в клетке q (ноги пиглина q.y = O.y − 2): оба блока копаются, пол держит, бока твёрдые.
  const roomOk = q => {
    const q1 = up(q)
    if (!solidDig(q.x, q.y, q.z) || !solidDig(q1.x, q1.y, q1.z) || !stand(c(q.x, q.y - 1, q.z))) return false
    for (const [sx, sz] of [[px, pz], [-px, -pz]]) for (const y of [q.y, q1.y]) if (!firm(c(q.x + sx, y, q.z + sz))) return false
    return true
  }
  const C0 = { x: O.x, y: O.y - 2, z: O.z }
  if (!roomOk(C0)) return null
  const M = cell(C0, -1)
  const R = up(M)
  const H = up(M, -1)
  const P = up(M, -2)
  if (!solidDig(M.x, M.y, M.z) || !firm(c(R.x, R.y, R.z))) return null
  for (const [x, y, z] of [[M.x + px, M.y, M.z + pz], [M.x - px, M.y, M.z - pz]]) if (!firm(c(x, y, z)) && !mineK(x, y, z)) return null
  // Строим, стоя ногами в H (голова в M): P под ногами — твёрдый, его копаем последним и падаем
  // в него. Грани P — наше или твёрдое (закрытый штрек не вскрывается), под P — опора.
  if (!cellOk(H.x, H.y, H.z) || !solidDig(P.x, P.y, P.z) || !stand(c(P.x, P.y - 1, P.z))) return null
  for (const [x, y, z] of [[P.x + px, P.y, P.z + pz], [P.x - px, P.y, P.z - pz], [P.x + d[0], P.y, P.z + d[1]], [P.x - d[0], P.y, P.z - d[1]]]) if (!firm(c(x, y, z)) && !mineK(x, y, z)) return null
  // Дальняя клетка C2 — вторая камера (торговец за слитком прыгает туда: она дальше нашей рамки).
  const C2c = cell(C0)
  const O2 = cell(O)
  const C2 = (c(O2.x, O2.y, O2.z) === SL.AIR && c(O2.x, O2.y + 1, O2.z) === SL.AIR && roomOk(C2c) &&
    firm(c(C2c.x + d[0], C2c.y, C2c.z + d[1])) && firm(c(C2c.x + d[0], C2c.y + 1, C2c.z + d[1]))) ? C2c : null
  // Без C2 задняя стенка C0 должна быть твёрдой (иначе камера открыта вбок, пиглин уйдёт).
  if (!C2 && (!firm(c(C0.x + d[0], C0.y, C0.z + d[1])) || !firm(c(C0.x + d[0], C0.y + 1, C0.z + d[1])))) return null
  // Свалка — как у ямы: столб сбоку от тела.
  const sealedOk = (x, y, z, ours) => SL.FACES.every(([fx, fy, fz]) => {
    const k = SL.key(x + fx, y + fy, z + fz)
    if (mineK(x + fx, y + fy, z + fz) || ours.includes(k)) return true
    const n = c(x + fx, y + fy, z + fz)
    return n === SL.SOLID || n === SL.HARD || n === SL.GUARD
  })
  let dump = null
  for (const sg of [1, -1]) {
    const D1 = { x: P.x + sg * px, y: P.y, z: P.z + sg * pz }
    const cells = [up(D1), D1, up(D1, -1)]
    const ours = [SL.key(P.x, P.y, P.z), SL.key(H.x, H.y, H.z), ...cells.map(q => SL.key(q.x, q.y, q.z))]
    if (cells.every(q => cellOk(q.x, q.y, q.z) && sealedOk(q.x, q.y, q.z, ours))) { dump = { Dh: cells[0], D1, D2: cells[2] }; break }
  }
  return { kind: 'trap', O: C0, C0, C1: up(C0), C2, M, R, H, P, d, p: [px, pz], dump, F: P, W: M, C: H, sill: true }
}

function trapCandidates (bot, view, own, radius = 40) {
  const me = bot.entity.position
  const pigs = mobs(bot, 'piglin', radius).filter(e => !isBaby(bot, e))
  const seen = new Set()
  const out = []
  for (const pg of (pigs as any)) {
    const p = pg.position.floored()
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        const O = { x: p.x + dx, y: p.y, z: p.z + dz }
        for (const d of SIDES4) {
          const k = O.x + ',' + O.y + ',' + O.z + '|' + d
          if (seen.has(k)) continue
          seen.add(k)
          const b: any = trapAt(view, own, O, d)
          if (!b) continue
          const center = new Vec3(O.x + 0.5, O.y, O.z + 0.5)
          b.pigs = pigs.filter((e : any) => e.position.distanceTo(center) <= 10 && Math.abs(e.position.y - O.y) < 0.6).length
          b.brutes = mobs(bot, 'piglin_brute', 8, center).length
          b.d0 = center.distanceTo(me)
          out.push(b)
        }
      }
    }
  }
  return out.filter(b => b.pigs >= 1).sort((a, b) => (Number(!!b.C2) - Number(!!a.C2)) || (Number(!!b.dump) - Number(!!a.dump)) || (a.brutes - b.brutes) || (b.pigs - a.pigs) || (a.d0 - b.d0))
}

function tradeBreach (S: any, extra: any = () => false) {
  return (ck, nk) => !!(S.filled && S.filled.has(ck)) || extra(ck, nk)
}

async function tradeExecute (session, ctl, path, S, local = null) {
  const SL = require('.././sealed')
  const prevOpen = S.openOk; const prevBreach = S.breachOk
  S.openOk = local
  S.breachOk = tradeBreach(S, (ck, nk) => !!(local && local.has(nk)))
  S.exposed = SL.exposure(session.bot, S.own).length > 0
  try { return await SL.execute(session, ctl, path, S) } finally { S.openOk = prevOpen; S.breachOk = prevBreach }
}

// settle:false — не ждать последних бросков в конце (загон S2b сразу после ямы закрывает рот: стоящие у люка
// разглядывают и не уходят; их броски считает журнал загона).
async function boothTrade (session, ctl, st, bo, until, { keep = 8, done = () => false, settle = true }: any = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  let lastToss = 0
  let lures = null
  let lastLure = null
  let idleSince = gameClock.now()
  const r: any = { handed: 0, tossed: 0, hits: 0, pearls0: countOf(bot, 'ender_pearl'), ingots0: countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block'), waitedAnger: 0, junked: {}, bag0: Object.fromEntries(bot.inventory.items().reduce((m, i) => m.set(i.name, (m.get(i.name) || 0) + i.count), new Map())) }
  const O = new Vec3(bo.O.x + 0.5, bo.O.y, bo.O.z + 0.5)
  // Журнал бросков: предмет, появившийся у глаз взрослого пиглина (BehaviorUtils.throwItem:
  const throws = new Map()
  const itemType = bot.registry.entitiesByName.item && bot.registry.entitiesByName.item.id
  const handedAt = new Map()
  const busyUntil = new Map()
  if (BF.enabled()) { try { require('.././ne-guard').attach(session) } catch {} }
  const badCells = new Map()
  const onSpawn = p => {
    if (p.type !== itemType) return
    const pg: any = mobs(bot, 'piglin', 24).find((e : any) => !isBaby(bot, e) && Math.hypot(e.position.x - p.x, e.position.z - p.z) < 0.35 && Math.abs(e.position.y + 1.79 - 0.3 - p.y) < 0.15)
    if (!pg) return
    // Чья сделка: вручённая нами (в 12 с до броска) или приманка; где стоял пиглин относительно нас.
    const me = bot.entity.position
    const src = handedAt.has(pg.id) && gameClock.now() - handedAt.get(pg.id) < 12000 ? 'hand' : 'lure'
    throws.set(p.entityId, { t: gameClock.now(), src, cell: Math.floor(pg.position.x) + ',' + Math.floor(pg.position.y) + ',' + Math.floor(pg.position.z), rel: [+(pg.position.x - me.x).toFixed(1), +(pg.position.y - me.y).toFixed(1), +(pg.position.z - me.z).toFixed(1)] })
    idleSince = gameClock.now()
  }
  const onCollect = (collector, collected) => {
    if (!collector || collector !== bot.entity || !collected) return
    const t = throws.get(collected.id)
    if (t) t.got = true
  }
  bot.on('playerCollect', onCollect)
  const onMeta = p => {
    const t = throws.get(p.entityId)
    if (!t || t.name) return
    try { const it = bot.entities[p.entityId] && bot.entities[p.entityId].getDroppedItem(); if (it) { t.name = it.name; t.count = it.count } } catch {}
  }
  bot._client.on('spawn_entity', onSpawn)
  bot._client.on('entity_metadata', onMeta)
  // Перед торгом — место в рюкзаке: штрек набил его чернокамнем, гравием, добычей сундуков.
  if (pitLike(bo)) await junkOut(bot, bo, r.junked)
  try {
  while (!ctl.aborted && gameClock.now() < until - 3000) {
    if (done()) { r.stopped = 'цель'; break }
    if (BF.enabled()) {
      const G = require('.././ne-guard')
      // Guard may move the body while a trade loop is waiting. Never reuse the old mouth.
      if (G.busy(bot) || G.hot(bot)) { await G.react(session, ctl); r.stopped = 'страж изменил место'; break }
      if (bot.entity.position.distanceTo(new Vec3(bo.F.x + 0.5, bo.F.y, bo.F.z + 0.5)) > 0.9) { r.stopped = 'ушёл из места бартера'; break }
    }
    if ((bot.health ?? 20) < 12) await eatIfHungry(session, ctl)
    if ((bot.health ?? 20) < 8) { r.stopped = `хп ${Math.round(bot.health)}`; break }
    // Брут у окна — мечом, пока стоит (злость пиглинов от удара — 30 с, переждём).
    if (st.hitBrutes && await hitThroughWindow(bot)) { r.hits++; st.lastBreak = gameClock.now(); idleSince = gameClock.now(); continue }
    const cool = lastGoldBreak(st) + 33000 - gameClock.now()
    if (cool > 0) { r.waitedAnger += Math.min(cool, 1000); await sleep(Math.min(cool, 1000)); continue }
    // Стопка при перекладке в руку на миг вне inventory.items() — пересчёт через паузу (s2b-alt03 k=5).
    if (countOf(bot, 'gold_ingot') - keep < 1 && !countOf(bot, 'gold_block')) await sleep(300)
    if (countOf(bot, 'gold_ingot') - keep < 1) {
      // Место под слитки: хлам — в окно (брошенное под ноги подберётся назад через 2 с).
      if (countOf(bot, 'gold_block') && bot.inventory.emptySlotCount() < 2) await junkOut(bot, bo, r.junked)
      if (countOf(bot, 'gold_block')) await unpackGold(session, ctl, keep + 18)
      if (countOf(bot, 'gold_ingot') - keep < 1) { r.stopped = countOf(bot, 'gold_block') ? 'блоки не распаковались' : 'слитки кончились'; break }
    }
    // Рюкзак почти полон — хлам в свалку: в полный рюкзак добыча не идёт и копится у ног.
    if (bot.inventory.emptySlotCount() < 3) await junkOut(bot, bo, r.junked)
    // Подоконник из песка душ: блок стены под окном (C) меняем на песок душ (высота 0.875).
    if (!bo.sill && countOf(bot, 'soul_sand') > 0 && !mobs(bot, 'piglin_brute', 4, O).length && !mobs(bot, 'hoglin', 4, O).length) {
      bo.sill = await makeSill(bot, bo)
      r.sill = bo.sill
    }
    // Броски старше 4 с: не подобран, а лежит — клетка, откуда пиглин бросал, плохая (модель полёта там
    if (pitLike(bo)) {
      let n = 0; let got = 0
      for (const [id, t] of throws) {
        if (!t.eval && gameClock.now() - t.t > 4000) {
          t.eval = true
          if (!t.got && bot.entities[id] && t.cell && t.src === 'hand') { badCells.set(t.cell, (badCells.get(t.cell) || 0) + 1); r.badCells = badCells.size }
        }
        if (t.eval) { n++; if (t.got) got++ }
      }
      if (n >= 10 && got / n < 0.5) { r.stopped = 'яма не доносит'; break }
    }
    // Золото в руке держим только на миг вручения: с ним в руке пиглин к нам не подходит.
    if (await unholdGold(bot)) r.unheld = (r.unheld || 0) + 1
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const pigs = mobs(bot, 'piglin', 16).filter(e => !isBaby(bot, e) && !aggressive(bot, e) && !admiring(e) && (!BF.enabled() || BF.ready(bot, e, busyUntil)))
      .sort((a, b) => distToBox(eye, a) - distToBox(eye, b))
    let handed = false
    // Вручать тому, кто видит нас глаз в глаз сквозь окно: только он бросит добычу к нам
    const eyeSees = pg => raySees(bot, eye, pg.position.offset(0, (pg.height || 1.95) * 0.92, 0))
    const getBlock = pitLike(bo) ? require('.././drops').blockGetter(bot) : null
    let firstLureBudget = 0
    for (const pg of (pigs as any)) {
      if (distToBox(eye, pg) > 2.9) break
      // Яма: вручать только тому, кто нас видит и чей бросок (расчёт полёта) ляжет к нам —
      // иначе добыча остаётся у рта (pit-real 29.09: без этого в рюкзаке 70–89% сделок).
      if (pitLike(bo) || BF.enabled()) {
        if ((badCells.get(Math.floor(pg.position.x) + ',' + Math.floor(pg.position.y) + ',' + Math.floor(pg.position.z)) || 0) >= 2) { r.badCellSkip = (r.badCellSkip || 0) + 1; continue }
        if (!eyeSees(pg)) { r.unseen = (r.unseen || 0) + 1; continue }
        if (!throwLands(bot, pg.position, bot.entity.position, getBlock).ok) { r.wontLand = (r.wontLand || 0) + 1; continue }
      } else if (!eyeSees(pg) && gameClock.now() - (r.lastSeenHand || t0) < 15000) { r.unseen = (r.unseen || 0) + 1; continue }
      if (await handNoWalk(bot, pg)) {
        handedAt.set(pg.id, gameClock.now())
        if (BF.enabled()) busyUntil.set(pg.id, gameClock.now() + BF.ADMIRE_MS + 150)
        r.handed++; st.traded++; handed = true; idleSince = gameClock.now(); r.lastHandT = gameClock.now(); if (eyeSees(pg)) r.lastSeenHand = gameClock.now()
        // Кривая жемчуга по сделкам (опыты: последовательность бартера у мира одна — random_sequence).
        if (r.handed % 32 === 0) { r.curve = r.curve || []; r.curve.push([r.handed + r.tossed, countOf(bot, 'ender_pearl')]) }
        break
      }
    }
    if (!handed) {
      const near = pigs.filter((e : any) => e.position.distanceTo(O) <= 8)
      const lying = (Object.values(bot.entities) as any[]).filter((e : any) => e.name === 'item' && e.position && e.position.distanceTo(O) < 3 &&
        (() => { try { const d = e.getDroppedItem && e.getDroppedItem(); return d && d.name === 'gold_ingot' } catch { return false } })()).length
      // Брошенный слиток лежит и его не берут дольше 10 с — бросить ещё (booth-3: 2 слитка легли, торг встал).
      let tossOk = !pitLike(bo)
      let lureAim = null
      let pendingLure = null
      if (bo.kind === 'trap') {
        // Манить в камеру: в ней нет свободного взрослого и слиток там не лежит; слиток ляжет в
        // клетку камеры дальше нашей рамки подбора (иначе вернётся к нам через 2 с).
        const inTrap = e => [bo.C0, bo.C2].filter(Boolean).some(T => Math.floor(e.position.x) === T.x && Math.floor(e.position.z) === T.z && Math.abs(e.position.y - T.y) < 0.6)
        const caught = mobs(bot, 'piglin', 8).filter(e => !isBaby(bot, e) && inTrap(e))
        const baitThere = (Object.values(bot.entities) as any[]).some((e : any) => e.name === 'item' && e.position && inTrap(e) && (() => { try { const d = e.getDroppedItem(); return d && d.name === 'gold_ingot' } catch { return false } })())
        const at = tossLands(bot, aimOut(bo))
        const me0 = bot.entity.position
        tossOk = !caught.length && !baitThere && inTrap({ position: new Vec3(at.x, at.y, at.z) }) && Math.hypot(at.x - me0.x, at.z - me0.z) >= 1.6
        if (!tossOk) r.tossHeld = (r.tossHeld || 0) + 1
        r.caught = Math.max(r.caught || 0, caught.length)
      } else if (bo.kind === 'pit') {
        // Прицелы приманки — раз на яму; порог оценки снижается, пока сделок нет: лучше приманка,
        // чей бросок долетит из 5 точек из 9, чем 120 с простоя (pit-tick 30.09: 387 удержаний, 0 сделок).
        if (!lures) { const t1 = gameClock.now(); lures = bo.lureAims || (bo.lureAims = pitLures(bot, bo)); r.lureBest = lures.length ? lures[0].score : -1; r.lureMs = gameClock.now() - t1 }
        let lastTrade = Math.max(t0, r.lastHandT || 0)
        for (const t of throws.values()) if (t.t > lastTrade) lastTrade = t.t
        const quiet = gameClock.now() - lastTrade
        // Сделка с приманки доходит хуже вручённой (pit-v4 30.09: руки 93–95%, приманки 11 из 26): манить,
        // только когда 30 с не было ни одной сделки, и не больше 12 приманок на яму.
        const need = r.tossed >= 12 ? 99 : quiet > 70000 ? 3 : quiet > 50000 ? 5 : quiet > 30000 ? 7 : 99
        // Прошлую приманку не взяли за 25 с (лежит у места посадки) — это место не годится.
        if (lastLure && gameClock.now() - lastLure.t > 25000 && !lastLure.L.bad) {
          const still = (Object.values(bot.entities) as any[]).some((e : any) => e.name === 'item' && e.position && Math.hypot(e.position.x - lastLure.L.at.x, e.position.z - lastLure.L.at.z) < 1 && Math.abs(e.position.y - lastLure.L.at.y) < 1 &&
            (() => { try { const d = e.getDroppedItem(); return d && d.name === 'gold_ingot' } catch { return false } })())
          if (still) { lastLure.L.bad = true; r.lureBad = (r.lureBad || 0) + 1 }
        }
        const gbl = require('.././drops').blockGetter(bot)
        const adults = mobs(bot, 'piglin', 16).filter(e => !isBaby(bot, e) && !aggressive(bot, e))
        const reachableLures = lures.filter(x => {
          if (x.bad || x.score < 3) return false
          if (!x.region) x.region = floorRegion(gbl, Math.floor(x.at.x), Math.floor(x.at.z), bo.M.y)
          return adults.some((e : any) => Math.abs(e.position.y - bo.M.y) < 1.1 && x.region.has(Math.floor(e.position.x) + ',' + Math.floor(e.position.z)))
        })
        const L = reachableLures.find(x => x.score >= need)
        if (BF.enabled() && !r.handed && !r.tossed && !throws.size && reachableLures.length) {
          const best = Math.max(...reachableLures.map(x => x.score))
          // The ordinary 30s idle limit must leave a polling window after the existing 30/50/70s lure thresholds.
          firstLureBudget = (best >= 7 ? 30000 : best >= 5 ? 50000 : 70000) + 3000
        }
        tossOk = !!L
        lureAim = L ? L.aim : null
        if (L) { r.lureScores = [...(r.lureScores || []).slice(-40), L.score]; pendingLure = L }
        if (!tossOk) r.tossHeld = (r.tossHeld || 0) + 1
      }
      if (tossOk && near.length && (lying < 1 || gameClock.now() - lastToss > 10000) && gameClock.now() - lastToss > 2500) {
        if (await tossOut(bot, bo, 'gold_ingot', 1, lureAim)) { r.tossed++; st.traded++; lastToss = gameClock.now(); if (!BF.enabled()) idleSince = gameClock.now(); if (pendingLure) lastLure = { L: pendingLure, t: gameClock.now() } }
      }
    }
    // Яма не работает — не жечь золото: приманки не берут или 150 с ни одного броска пиглина.
    // Вызывающий копает другую яму (pit-v3-1 30.09: 50 приманок, 0 сделок за 520 с).
    const awaitingLure = BF.enabled() && BF.awaitingLure(lastLure?.t, gameClock.now())
    const initialLureWait = !r.handed && !r.tossed && !throws.size ? firstLureBudget : 0
    if (bo.kind === 'pit' && !throws.size && (r.tossed >= 8 || (!awaitingLure && gameClock.now() - t0 > (BF.enabled() ? Math.max(45000, initialLureWait) : 150000)))) { r.stopped = 'яма не работает'; break }
    // Из ямы вручаем только тем, чей бросок долетит, — ждать их дольше.
    const idleMax = BF.enabled() ? Math.max(30000, initialLureWait) : pitLike(bo) ? 120000 : 60000
    if (gameClock.now() - idleSince > idleMax && !awaitingLure) {
      r.stopped = `пиглины не подходят ${idleMax / 1000} с`; break
    }
    await sleep(300)
  }
  // Последние сделки: добыча разглядывающих прилетит через ~6 с.
  for (let i = 0; settle && i < 16 && !ctl.aborted && gameClock.now() < until; i++) {
    if (!mobs(bot, 'piglin', 12).some(e => admiring(e))) break
    await sleep(500)
  }
  if (settle) await sleep(2500) // задержка подбора и полёт последних бросков
  } finally { bot._client.removeListener('spawn_entity', onSpawn); bot._client.removeListener('entity_metadata', onMeta); bot.removeListener('playerCollect', onCollect) }
  const thrown = {}
  for (const t of throws.values()) if (t.name) thrown[t.name] = (thrown[t.name] || 0) + t.count
  r.thrown = thrown
  r.throwsN = throws.size
  const receipts = [...throws.values()].filter(t => t.name && t.name !== 'gold_ingot' && t.name !== 'gold_block' && t.count > 0)
  r.barterReceipts = receipts.length
  r.barterDelivered = receipts.filter(t => t.got === true).length
  // Доставка по источнику сделки (штуки): вручённые и приманки; где стоял пиглин у недошедших.
  const bySrc = {}
  const missed = []
  for (const t of throws.values()) {
    const b = bySrc[t.src || '?'] || (bySrc[t.src || '?'] = { n: 0, got: 0 })
    b.n += t.count || 1
    if (t.got) b.got += t.count || 1
    else if (missed.length < 30) missed.push([t.src === 'hand' ? 'h' : 'l', t.name || '?', ...(t.rel || [])])
  }
  r.bySrc = bySrc
  r.missed = missed
  r.seconds = Math.round((gameClock.now() - t0) / 1000)
  r.pearls = countOf(bot, 'ender_pearl') - r.pearls0
  r.spent = r.ingots0 - countOf(bot, 'gold_ingot') - 9 * countOf(bot, 'gold_block')
  const out = {}
  const dumped = {}
  const where = []
  const ref = pitLike(bo) ? bo.M : bo.W
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (e.name !== 'item' || !e.position || e.position.distanceTo(O) > 10) continue
    const inDump = bo.dump && Math.floor(e.position.x) === bo.dump.D2.x && Math.floor(e.position.z) === bo.dump.D2.z && e.position.y < bo.P.y
    try {
      const d = e.getDroppedItem && e.getDroppedItem()
      if (!d) continue
      const m = inDump ? dumped : out
      m[d.name] = (m[d.name] || 0) + d.count
      // Где лежит (от рта/окна): решать, чем добирать — подкопом снизу или вылазкой.
      if (!inDump && where.length < 40) where.push([d.name, d.count, +(e.position.x - ref.x - 0.5).toFixed(1), +(e.position.y - ref.y).toFixed(1), +(e.position.z - ref.z - 0.5).toFixed(1)])
    } catch {}
  }
  r.lyingWhere = where.length ? where : undefined
  r.lyingOutside = Object.keys(out).length ? out : undefined
  r.dumped = Object.keys(dumped).length ? dumped : undefined
  // Сколько добычи пришло в рюкзак (с выброшенным в свалку) — для счёта сделок.
  const bag1 = bot.inventory.items().reduce((m, i) => m.set(i.name, (m.get(i.name) || 0) + i.count), new Map())
  const got = {}
  for (const [n, c] of bag1) { const d = c - (r.bag0[n] || 0) + (r.junked[n] || 0); if (d > 0 && n !== 'gold_ingot' && n !== 'gold_block') got[n] = d }
  for (const [n, c] of ((Object.entries(r.junked) as [string, any][]) as any)) if (!bag1.has(n) && c - (r.bag0[n] || 0) > 0) got[n] = c - (r.bag0[n] || 0)
  r.got = got
  delete r.bag0
  let tSum: any = 0; let dSum = 0
  for (const [n, c] of (Object.entries(r.thrown || {}) as [string, any][])) { tSum += c; dSum += Math.min(c, got[n] || 0) }
  // Доставка по штукам: что из брошенного пиглинами пришло к нам (с выброшенным в свалку).
  r.delivery = tSum ? +(dSum / tSum).toFixed(3) : undefined
  return r
}

const MEMO = new Map()

function exitReserveReady (bot, p: any = {}) {
  return process.env.ND_EXIT_KIT === '0' || !(p.obsidian >= 10) || require('.././nether').exitKit(bot).ready
}

module.exports = { ownTunnelAt, lavaWatched, barterRound, nextToBlock, bruteComing, walkUnlessBrute, stepCell, tunnelTo, DAMAGE_TYPES, boothAt, boothCandidates, currentPit, pitAt, pitCandidates, catchScore, trapAt, trapCandidates, tradeBreach, tradeExecute, boothTrade, MEMO, exitReserveReady }
