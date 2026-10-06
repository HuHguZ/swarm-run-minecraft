const { inClouds, inCharge, standY, headroom, nearEdge, straightWalkable, embeddedNow, unembed, awayFromHead, r1, dragonVel, HOLE_TOP, duckPlan, duck, podiumTop, cloudAgeMs, fastTower, aboveCloudY, straightOut, doing } = require('./fall-guard')
const { cloudHits, FIREBALL_SNAP, lineDist, HEAD_AHEAD, playerBox, overlap, inflate, HURT_PAD, Vec3, voidBelow, zonesOf, nearPortal, dragonOf, stepTo, gameClock, sleep, cloudsOf, dbg, FILLER_RE, findItem, isSolid, build, clearControls, isAirish, items, CLOUD_SLAB, EYE, fillerItem, lookSafe, PHASE, box, pick } = require('./dig-down-to')
async function lookAtSafe (bot, point) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const d = point.minus(eye)
  const yaw = Math.atan2(-d.x, -d.z)
  const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  await lookSafe(bot, yaw, pitch)
}

const countOf = (bot, re) => bot.inventory.items().filter(i => re.test(i.name)).reduce((n, i) => n + i.count, 0)

function dangerAt (bot, feet, ctx) {
  const clouds = ctx.clouds
  const c = inClouds(clouds, feet, 0.8)
  if (c) return { kind: 'облако', c }
  if (ctx.breath && cloudHits(ctx.breath, feet, 0.8)) return { kind: 'будет облако огня', c: ctx.breath }
  for (const f of ctx.fireballs) {
    if (!f.at) continue
    // Облако переедет на того, кто ближе 4 блоков к точке попадания (по ногам,
    // в трёх измерениях); запас полтора блока — на неточность точки.
    const land = f.line ? f.ground : f.at
    if (land && feet.distanceTo(land) < FIREBALL_SNAP + 1.5) return { kind: 'фаербол', f }
    if (!f.line && Math.hypot(feet.x - f.at.x, feet.z - f.at.z) < FIREBALL_SNAP + 1.2 && Math.abs(feet.y - f.at.y) < 3.5) return { kind: 'фаербол', f }
    // Стоять на самой прямой полёта — поймать фаербол телом.
    if (f.line) {
      const q = lineDist(f.line.p0, f.line.dir, feet.offset(0, 0.9, 0))
      if (q.s > 0 && q.s < f.line.dist && q.d < 1.6) return { kind: 'фаербол', f }
    }
  }
  if (ctx.charge && inCharge(ctx.charge, feet)) return { kind: 'таран' }
  if (ctx.sweep) {
    // Сидя дракон поворачивает голову к игроку (DragonSittingScanningPhase:
    const w = ctx.sweep
    const rx = feet.x - w.pos.x; const rz = feet.z - w.pos.z
    const h = Math.hypot(rx, rz)
    const ang = h > 0.1 ? Math.acos(Math.max(-1, Math.min(1, (rx * w.dir.x + rz * w.dir.z) / h))) : Math.PI
    // (EnderDragon.knockBack) — вплотную это выброс прямо под шею. Безопасно
    const front = ang <= 0.4 && h >= HEAD_AHEAD + 1
    // По высоте — до низа коробок удара (голова и шея, раздутые на 1: Y − 2):
    // кто в яме ниже (ноги ≤ Y − 3.8), того дуга не задевает.
    if (h < HEAD_AHEAD + 2.8 && !front && feet.y + 1.8 > w.pos.y - 2.1 && feet.y < w.pos.y + 3) return { kind: h > 2.5 ? 'дуга головы' : 'под драконом' }
  }
  if (ctx.parts) {
    const pb = playerBox(feet)
    // Игра бьёт на 10 всех, чей хитбокс в голове или шее, раздутых на 1
    // (EnderDragon.aiStep → hurt); +0.05 на неточность нашей оценки положения.
    if (overlap(pb, inflate(ctx.parts.head, HURT_PAD)) || overlap(pb, inflate(ctx.parts.neck, HURT_PAD))) return { kind: 'голова дракона' }
  }
  // Крылья на посадке, взлёте и в низком полёте (5 урона и отброс); сидя —
  // только коридор скорого взлёта (толчок сидящего до клиента не доходит).
  if (ctx.wings && ctx.wings.length) {
    const pb = playerBox(feet)
    // Уходить от коридора взлёта — поперёк (от ближней точки его оси), не вдоль.
    const away = ctx.wingAxis ? (() => { const a = ctx.wingAxis; const t = Math.max(0, (feet.x - a.p.x) * a.dir.x + (feet.z - a.p.z) * a.dir.z); return new Vec3(a.p.x + a.dir.x * t, feet.y, a.p.z + a.dir.z * t) })() : (ctx.wingAway || null)
    for (const b of ctx.wings) if (overlap(pb, b)) return { kind: ctx.wingKind || 'крыло', away }
  }
  // Садится: куда бы ни лёг, коробки крыльев в 13.3 от центра тела (угол AABB
  if (ctx.landing) {
    const L = ctx.landing
    if (Math.hypot(feet.x - L.c.x, feet.z - L.c.z) < L.r && feet.y + 1.8 > L.yMin + 0.01) return { kind: 'посадка', away: L.c }
  }
  return null
}

const SCAN_RANGE = 20

function noteNear (rec, d, bot, now) {
  if (!rec || (rec.lastPh != null && rec.lastPh !== PHASE.SCANNING) || now - rec.t0 < 1250) return
  const me = bot.entity.position
  const sneak = typeof bot.getControlState === 'function' && bot.getControlState('sneak')
  const r = (sneak ? SCAN_RANGE * 0.8 : SCAN_RANGE) - 0.7
  // Непрерывно в круге: вышли — отсчёт заново.
  rec.nearAt = me.distanceTo(d.position) <= r && Math.abs(me.y - d.position.y) <= 9.5 ? (rec.nearAt || now) : null
}

async function evade (bot, ctl, stats, bad, prefer = null) {
  const was = ctl.doing
  doing(ctl, `evade:${bad.kind}`)
  ctl.evading = (ctl.evading || 0) + 1
  try {
    const r = await evadeRaw(bot, ctl, stats, bad, prefer)
    // Уйти некуда, а стоим в облаке (fin1-25: яма у края острова, «evade: облако → null» ×12,
    // 19 → 0 хп): облако — пол в 0.5 высотой, над ним не бьёт — на блок-два вверх столбом.
    const c = inClouds(cloudsOf(bot), bot.entity.position, 0.3)
    if (c && !ctl.aborted && bot.entity.onGround && countOf(bot, FILLER_RE) > 0) {
      const need = Math.max(1, Math.ceil(c.pos.y + CLOUD_SLAB + 0.05 - bot.entity.position.y))
      if (ctl.trace) ctl.trace.ev('cloudUp', { need, hp: r1(bot.health) })
      await build.towerUp(bot, ctl, Math.min(3, need)).catch(() => {})
      clearControls(bot)
    }
    return r
  } finally { doing(ctl, was); ctl.evading-- }
}

async function evadeRaw (bot, ctl, stats, bad, prefer = null) {
  if (embeddedNow(bot)) await unembed(bot, ctl)
  const ctx = { ...bad.ctx, prefer }
  const me = bot.entity.position
  // Голова и шея сидящего (10 за удар раз в полсекунды) — прежде всего, даже из
  if (ctx.parts) {
    const pb = playerBox(me)
    if (overlap(pb, inflate(ctx.parts.head, HURT_PAD)) || overlap(pb, inflate(ctx.parts.neck, HURT_PAD))) {
      const dh = dragonOf(bot)
      if (dh) {
        stats.dodges['от головы'] = (stats.dodges['от головы'] || 0) + 1
        const t = awayFromHead(dh, ctx.parts, me, 4)
        if (ctl.trace) ctl.trace.ev('evade', { kind: 'голова дракона', to: [r1(t.x), r1(t.y), r1(t.z)], first: bad.kind })
        const r = await stepTo(bot, ctl, t, { ms: 1200, stopAt: 0.4, clouds: false })
        return r.ok
      }
    }
  }
  // Таран: бегом поперёк его линии, прочь от неё (коридор — 11 блоков вбок).
  if (bad.kind === 'таран' && ctx.charge) {
    stats.dodges.таран = (stats.dodges.таран || 0) + 1
    const ch = ctx.charge
    const ax = ch.target.x - ch.from.x; const az = ch.target.z - ch.from.z
    const L = Math.hypot(ax, az) || 1
    let side = Math.sign((me.x - ch.from.x) * (az / L) - (me.z - ch.from.z) * (ax / L)) || 1
    // Разворачивается он широко (радиус ~19: 0.06 за тик вперёд, поворот не
    if (ch.yaw != null) {
      const bulge = Math.sin(ch.yaw) * (az / L) + Math.cos(ch.yaw) * (-ax / L)
      if (Math.abs(bulge) > 0.2) side = -Math.sign(bulge)
    }
    // Вбок не успеть (он здесь раньше, чем мы в 11 блоках от его линии) — нырнуть:
    {
      const dn = dragonOf(bot)
      if (dn) {
        const v = dragonVel(dn, gameClock.now())
        const sp = Math.max(0.8, Math.hypot(v.x, v.z))
        const etaMs = Math.hypot(dn.position.x - me.x, dn.position.z - me.z) / sp * 50
        const lat = Math.abs((me.x - ch.from.x) * (az / L) - (me.z - ch.from.z) * (ax / L))
        const runMs = Math.max(0, 11 - lat) / 5.5 * 1000 + 300
        const F = Math.floor(dn.position.y - 0.6 - HOLE_TOP - 0.15)
        const plan = duckPlan(bot, F)
        // Уже в яме (или успеем докопать) — сидеть: вылезти и бежать — под крылья
        if (plan && (plan.dig === 0 || plan.dig * 800 < etaMs + 300 || runMs > etaMs)) {
          if (plan.dig <= (etaMs > 1700 ? 2 : 1)) {
            stats.dodges['нырок'] = (stats.dodges['нырок'] || 0) + 1
            if (ctl.trace) ctl.trace.ev('duck', { kind: 'таран', F, dig: plan.dig, etaMs: Math.round(etaMs) })
            if (plan.dig === 0) { await sleep(100); return true }
            if (await duck(bot, ctl, F)) return true
          }
        }
      }
    }
    for (const s2 of [side, -side]) {
      for (const k of [16, 13, 10, 7]) {
        const t = me.offset(az / L * s2 * k, 0, -ax / L * s2 * k)
        const y = standY(bot, t.x, t.z, me.y, 2, 4)
        if (y == null) continue
        const feet = new Vec3(Math.floor(t.x) + 0.5, y, Math.floor(t.z) + 0.5)
        if (nearEdge(bot, feet, 3) || nearPortal(feet) || inClouds(cloudsOf(bot), feet, 1.5)) continue
        if (ctl.trace) ctl.trace.ev('evade', { kind: 'таран', to: [r1(feet.x), feet.y, r1(feet.z)] })
        const r = await stepTo(bot, ctl, feet, { ms: 3000, stopAt: 0.6 })
        return r.ok
      }
    }
    await sleep(100)
    return false
  }
  // Скорый взлёт (слепой на 3.8 с): вбок на 11+ блоков не успеть — нырнуть на
  // блок, если под ногами копается (коробки взлёта пройдут поверх).
  if (/взлёт/.test(bad.kind)) {
    const d = dragonOf(bot)
    const P = podiumTop(bot)
    const F = d ? Math.floor(Math.min(d.position.y, P != null ? P - 0.2 : d.position.y) - HOLE_TOP - 0.15) : null
    const plan = F != null ? duckPlan(bot, F) : null
    if (plan && plan.dig <= 1) {
      stats.dodges['нырок'] = (stats.dodges['нырок'] || 0) + 1
      if (ctl.trace) ctl.trace.ev('duck', { kind: bad.kind, F, dig: plan.dig })
      if (await duck(bot, ctl, F)) return true
    }
  }
  // Облако уже на нас: сколько осталось до первого удара. Облако ждёт 20 тиков
  const cloudOnMe = !!(bad.c && /облако/.test(bad.kind) && cloudHits(bad.c, me, 0.3))
  const graceMs = cloudOnMe ? Math.max(0, 1000 - cloudAgeMs(bad.c) - 150) : null
  const away = bad.c ? bad.c.pos : bad.f ? (bad.f.ground || bad.f.at) : (bad.away || null)
  const budgetMs = bad.f ? bad.f.ticks * 50 - 150 : cloudOnMe ? graceMs : 3000
  // Сквозь край чужого облака — только когда само бьёт: фаербол летит или
  ctl.evadeBad = (ctl.evadeBad || []).filter(b => gameClock.now() - b.t < 8000)
  const esc = escapeSpot(bot, ctx, { away, budgetMs, cloudMargin: cloudOnMe && bad.c.r < 4 ? 1.0 : 2.2, through: !!(bad.f || cloudOnMe), skip: ctl.evadeBad.map(b => b.feet) })
  stats.dodges[bad.kind] = (stats.dodges[bad.kind] || 0) + 1
  dbg('evade', bad.kind, esc ? `${esc.feet} за ${esc.etaMs} мс, бюджет ${budgetMs}` : 'некуда')
  if (ctl.trace) ctl.trace.ev('evade', { kind: bad.kind, to: esc ? [r1(esc.feet.x), esc.feet.y, r1(esc.feet.z)] : null, etaMs: esc ? esc.etaMs : null, budgetMs, cloudOnMe, through: esc && esc.through ? esc.exposure : undefined })
  // Облако уже на нас, а выбежать до удара не успеть — блок под себя: облако
  if (cloudOnMe && (!esc || esc.etaMs > graceMs) && countOf(bot, FILLER_RE) === 0) {
    const pick = findItem(bot, /_pickaxe$/)
    const f = bot.entity.position.floored()
    const cand = pick && [[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dz]) => [f.offset(dx, 0, dz), f.offset(dx, 1, dz), f.offset(dx, -1, dz)])
      .map(p => bot.blockAt(p)).find(b => b && isSolid(b) && /^(end_stone|cobblestone|stone|dirt)$/.test(b.name))
    if (cand) {
      try { await bot.equip(pick, 'hand'); await build.withTimeout(bot.dig(cand, true), 2500) } catch {}
      const tp = gameClock.now()
      while (countOf(bot, FILLER_RE) === 0 && gameClock.now() - tp < 700) await sleep(50)
      stats.dodges['выломал блок'] = (stats.dodges['выломал блок'] || 0) + 1
    }
  }
  // На земле ли — подождать до 0.4 с: тело в облаке часто в прыжке (шаг на
  // ступеньку), и правило молчало, пока шли удары (camp2, 144–147 с).
  if (cloudOnMe && (!esc || esc.etaMs > graceMs) && countOf(bot, FILLER_RE) > 0 && !bot.entity.onGround) {
    clearControls(bot)
    const tg = gameClock.now()
    while (!bot.entity.onGround && gameClock.now() - tg < 400) await sleep(50)
  }
  if (cloudOnMe && (!esc || esc.etaMs > graceMs) && countOf(bot, FILLER_RE) > 0 && bot.entity.onGround &&
      isAirish(bot.blockAt(bot.entity.position.floored().offset(0, 2, 0)))) {
    // Быстрый столб (≈6 тиков), а не build.towerUp (пауза и ожидание
    const t = await fastTower(bot, ctl, aboveCloudY(bot.entity.position, bad.c), { maxMs: 2500 })
    if (t.placed) {
      stats.dodges['на блок'] = (stats.dodges['на блок'] || 0) + 1
      const w = items.bestWeapon(bot)
      if (w) await bot.equip(w, 'hand').catch(() => {})
      return true
    }
  }
  // Всегда отдать тик: вызывающие циклы крутятся на этом ответе, и «некуда»
  // без ожидания подвешивало весь демон (сервер рвал связь по тайм-ауту).
  if (!esc) {
    // В 9 блоках чистого нет (облака слились) — прочь от центра того, что
    const t = away ? straightOut(bot, me, away) : null
    if (t) {
      stats.dodges.напрямик = (stats.dodges.напрямик || 0) + 1
      if (ctl.trace) ctl.trace.ev('straightOut', { to: [r1(t.x), r1(t.y), r1(t.z)], kind: bad.kind })
      const r = await stepTo(bot, ctl, t, { ms: 2500, stopAt: 0.5 })
      return r.ok
    }
    if (away) stats.dodges['некуда (край)'] = (stats.dodges['некуда (край)'] || 0) + 1
    await sleep(150)
    return false
  }
  const before = bot.entity.position.clone()
  const r = await stepTo(bot, ctl, esc.feet, { ms: Math.max(1500, esc.etaMs + 800), stopAt: 0.5, clouds: esc.through ? 'fb' : true })
  if (!r.ok && Math.hypot(bot.entity.position.x - before.x, bot.entity.position.z - before.z) < 0.5) {
    ctl.evadeBad.push({ feet: esc.feet, t: gameClock.now() })
    if (ctl.trace) ctl.trace.ev('evadeStuck', { to: [r1(esc.feet.x), esc.feet.y, r1(esc.feet.z)], why: r.why })
  }
  return r.ok
}

function straightExposure (bot, from, to, clouds) {
  const dx = to.x - from.x; const dz = to.z - from.z
  const len = Math.hypot(dx, dz)
  const cs = clouds.filter(c => !cloudHits(c, from, 0.3))
  let y = Math.floor(from.y + 0.01)
  let inside = 0
  let prev = from
  for (let s = 0.5; s <= len; s += 0.5) {
    const x = from.x + dx / len * s; const z = from.z + dz / len * s
    const ny = standY(bot, x, z, y, 1, 3)
    if (ny == null || ny > y + 1) return null
    if (ny > y && !headroom(bot, prev, y)) return null
    if (voidBelow(bot, x, ny + 0.5, z, 12)) return null
    if (inClouds(cs, new Vec3(x, ny, z), 0.2)) inside += 0.5
    prev = new Vec3(x, ny, z)
    y = ny
  }
  return inside
}

function escapeSpot (bot, ctx, { away = null, budgetMs = null, cloudMargin = 2.2, through = false, skip = null }: any = {}) {
  const me = bot.entity.position
  const zones = zonesOf(ctx.clouds, ctx.fireballs || [])
  let best = null
  for (const pass of through ? [0, 1] : [0]) {
    for (let r = 2; r <= 9; r++) {
      for (let k = 0; k < 16; k++) {
        const a = 2 * Math.PI * k / 16
        const x = me.x + Math.cos(a) * r; const z = me.z + Math.sin(a) * r
        // Вверх — не больше блока: выше прыжком не взять (stepTo прыгает на 1).
        const y = standY(bot, x, z, me.y, 1, 3)
        if (y == null) continue
        const feet = new Vec3(Math.floor(x) + 0.5, y, Math.floor(z) + 0.5)
        if (nearPortal(feet)) continue
        if (dangerAt(bot, feet, ctx)) continue
        if (inClouds(ctx.clouds, feet, cloudMargin)) continue
        if (nearEdge(bot, feet, 3)) continue
        if (skip && skip.some(b => Math.hypot(b.x - feet.x, b.z - feet.z) < 1.6)) continue
        let exp = 0
        if (pass === 0) {
          if (!straightWalkable(bot, me, feet, zones)) continue
        } else {
          exp = straightExposure(bot, me, feet, ctx.clouds)
          if (exp == null || exp > 2) continue
          if (!straightWalkable(bot, me, feet, zones.filter(z => z.fb))) continue
        }
        const dist = Math.hypot(feet.x - me.x, feet.z - me.z)
        const etaMs = 150 + dist / 5 * 1000
        if (budgetMs != null && etaMs > budgetMs + 400) continue
        let score = dist + exp * 4 + (ctx.prefer ? feet.distanceTo(ctx.prefer) * 0.3 : 0)
        if (away) score -= Math.min(4, Math.hypot(feet.x - away.x, feet.z - away.z) - Math.hypot(me.x - away.x, me.z - away.z)) * 0.5
        if (ctx.sweep && Math.hypot(feet.x - ctx.sweep.pos.x, feet.z - ctx.sweep.pos.z) < 11) score += 6
        if (!best || score < best.score) best = { feet, score, etaMs: Math.round(etaMs), through: pass === 1, exposure: exp }
      }
      if (best && r >= 4) break
    }
    if (best) break
  }
  return best
}

function bedPlan (bot, d, parts, { brave = false }: any = {}) {
  const hc = parts.headC
  const me = bot.entity.position
  const zones = { clouds: cloudsOf(bot), fireballs: [], parts, sweep: { pos: d.position, dir: parts.dir } }
  const headPos = new Vec3(hc.x, parts.head.min.y, hc.z)
  const why = {}
  const no = k => { why[k] = (why[k] || 0) + 1 }
  let best = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    // D — от нас к голове, то есть против взгляда морды (стоим перед ней).
    if (dx * parts.dir.x + dz * parts.dir.z > -0.5) continue
    for (let ox = -2; ox <= 2; ox++) {
      for (let oz = -2; oz <= 2; oz++) {
        const hx = Math.floor(hc.x) + ox; const hz = Math.floor(hc.z) + oz
        // Уровень — по изножью (его ставим кликом по полу); изголовью пол не
        // нужен: кровать не проверяет опору (BedBlock без canSurvive).
        const g = standY(bot, hx - dx + 0.5, hz - dz + 0.5, parts.head.min.y - 1, 1, 6)
        if (g == null) { no('земля'); continue }
        const cells = [0, 1, 2, 3].map(k => ({ x: hx - k * dx, z: hz - k * dz }))
        let ok = true
        for (let i = 0; i < 4 && ok; i++) {
          const c = cells[i]
          const floor = bot.blockAt(new Vec3(c.x, g - 1, c.z))
          const at = bot.blockAt(new Vec3(c.x, g, c.z))
          if (i > 0 && (!isSolid(floor) || /portal|bed$/.test(floor.name))) ok = false
          else if (i === 2) ok = isAirish(at) || (isSolid(at) && FILLER_RE.test(at.name))
          else ok = isAirish(at) || (!!at && /^fire$/.test(at.name) && i < 2)
          if (ok && i === 3) ok = isAirish(bot.blockAt(new Vec3(c.x, g + 1, c.z)))
        }
        if (!ok) { no('клетки'); continue }
        const centre = new Vec3(hx + 0.5, g + 0.5, hz + 0.5)
        const dist = centre.distanceTo(headPos)
        if (dist > 4) { no('далеко от головы'); continue }
        const feet = new Vec3(cells[3].x + 0.5, g, cells[3].z + 0.5)
        const bad = dangerAt(bot, feet, zones)
        if (bad && !(brave && /облако/.test(bad.kind))) { no(bad.kind); continue }
        // Запас как у walkTo (цель ближе 2.5 к облаку он отвергает). Смелый —
        // идёт и в облако: дыхание — 3 в секунду, кровать — секунда-полторы.
        if (!brave && inClouds(zones.clouds, feet, 2.5)) { no('у облака'); continue }
        if (overlap(playerBox(feet), inflate(parts.body, 0.6))) { no('тело'); continue }
        if (feet.offset(0, EYE, 0).distanceTo(centre) > 4.2) { no('не дотянуться'); continue }
        const cost = dist + feet.distanceTo(me) * 0.1
        if (!best || cost < best.cost) best = { H: cells[0], F: cells[1], W: cells[2], B: cells[3], g, D: { x: dx, z: dz }, feet, centre, dist, cost }
      }
    }
  }
  if (!best) bedPlan.why = why
  return best
}
declare namespace bedPlan {
  let why: any
}

async function takeoffSidestep (bot, ctl, d, kind) {
  const me = bot.entity.position
  const ax = Math.sin(d.yaw); const az = Math.cos(d.yaw)
  const side = Math.sign((me.x - d.position.x) * az - (me.z - d.position.z) * ax) || 1
  // Из двух сторон — где земля (без обрыва) и не облако; своя сторона первой.
  for (const sd of [side, -side]) {
    const t = me.offset(az * sd * 6, 0, -ax * sd * 6)
    const y = standY(bot, t.x, t.z, me.y, 1, 3)
    if (y == null) continue
    const feet = new Vec3(t.x, y, t.z)
    if (inClouds(cloudsOf(bot), feet, 0.5)) continue
    if (ctl.trace) ctl.trace.ev('evade', { kind, to: [r1(feet.x), feet.y, r1(feet.z)] })
    await stepTo(bot, ctl, feet, { ms: 1400, stopAt: 0.5, clouds: false })
    return true
  }
  return false
}

function segPoint2 (a, b, c) {
  const vx = b.x - a.x; const vz = b.z - a.z
  const L2 = vx * vx + vz * vz
  const t = L2 > 1e-9 ? Math.max(0, Math.min(1, ((c.x - a.x) * vx + (c.z - a.z) * vz) / L2)) : 0
  return Math.hypot(a.x + vx * t - c.x, a.z + vz * t - c.z)
}

const MSIN = (() => { const t = new Float32Array(65536); for (let i = 0; i < 65536; i++) t[i] = Math.fround(Math.sin(i * Math.PI * 2 / 65536)); return t })()

const mIdx = v => { let n = Math.trunc(v) % 65536; if (n < 0) n += 65536; return n }

const msin = d => MSIN[mIdx(d * 10430.378350470453)]

const mcos = d => MSIN[mIdx(d * 10430.378350470453 + 16384)]

const DRAD = 0.017453292

const wrapDeg = f => { f %= 360; if (f >= 180) f -= 360; if (f < -180) f += 360; return f }

const clampN = (v, a, b) => v < a ? a : v > b ? b : v

function nrm3 (x, y, z) { const l = Math.sqrt(x * x + y * y + z * z); return l < 1e-4 ? [0, 0, 0] : [x / l, y / l, z / l] }

function simStep (s, T, flySpeed, turn) {
  s.hist.unshift(s.y); if (s.hist.length > 12) s.hist.length = 12
  const dx = T.x - s.x; const dy = T.y - s.y; const dz = T.z - s.z
  const g = dx * dx + dy * dy + dz * dz
  const j = Math.sqrt(dx * dx + dz * dz)
  const e = j > 0 ? clampN(dy / j, -flySpeed, flySpeed) : dy
  s.vy += e * 0.01
  s.yRot = wrapDeg(s.yRot)
  const v32 = nrm3(dx, dy, dz)
  const v33 = nrm3(msin(s.yRot * DRAD), s.vy, -mcos(s.yRot * DRAD))
  const k = Math.max((v33[0] * v32[0] + v33[1] * v32[1] + v33[2] * v32[2] + 0.5) / 1.5, 0)
  if (Math.abs(dx) > 1e-5 || Math.abs(dz) > 1e-5) {
    const l = clampN(wrapDeg(180 - Math.atan2(dx, dz) * 57.295776 - s.yRot), -50, 50)
    s.yRotA = s.yRotA * 0.8 + l * turn(s)
    s.yRot += s.yRotA * 0.1
  }
  const l2 = 2 / (g + 1)
  const sp = 0.06 * (k * l2 + (1 - l2))
  s.vx += sp * msin(s.yRot * DRAD); s.vz += -sp * mcos(s.yRot * DRAD)
  const m = s.inWall ? 0.8 : 1
  s.x += s.vx * m; s.y += s.vy * m; s.z += s.vz * m
  const v34 = nrm3(s.vx, s.vy, s.vz)
  const n = 0.8 + 0.15 * (v34[0] * v33[0] + v34[1] * v33[1] + v34[2] * v33[2] + 1) / 2
  s.vx *= n; s.vy *= 0.91; s.vz *= n
  return s
}

const turnLanding = s => { const f = Math.hypot(s.vx, s.vz) + 1; return Math.min(f, 40) / f }

const simClone = s => ({ ...s, hist: s.hist.slice() })

function simPart (s, len, sitting) {
  const h = s.hist
  const y0 = h[0] ?? s.y; const y5 = h[5] ?? y0; const y10 = h[10] ?? y5
  const f16 = (y5 - y10) * 10 * DRAD
  const f17 = mcos(f16); const f18 = msin(f16)
  const a = s.yRot * DRAD - s.yRotA * 0.01
  const off = sitting ? -1 : (y5 - y0)
  return new Vec3(s.x + msin(a) * len * f17, s.y + off + f18 * len, s.z - mcos(a) * len * f17)
}

const simHead = (s, sitting = false) => simPart(s, 6.5, sitting)

const simNeck = (s, sitting = false) => simPart(s, 5.5, sitting)

function landingForecast (feed, P) {
  const L = feed.list
  const b = L[L.length - 1]; const a = L[L.length - 2]
  if (!a || !b || a.id !== b.id || b.ph !== PHASE.LANDING || a.ph !== PHASE.LANDING) return null
  if (a.vx == null || b.vx == null || P == null) return null
  // тиков между пакетами — по пути (feedTicks), без него — по отметкам
  const n = b.tick != null && a.tick != null && b.n != null ? b.tick - a.tick : Math.round((b.t - a.t) / 50)
  if (n < 1 || n > 6) return null
  const T = { x: 0.5, y: P, z: 0.5 }
  const from = q => ({ x: a.x, y: a.y, z: a.z, vx: a.vx, vy: a.vy, vz: a.vz, yRot: a.yRot, yRotA: q, hist: new Array(11).fill(a.y), inWall: false })
  const fit = q => { const s = from(q); for (let k = 0; k < n; k++) simStep(s, T, 1.5, turnLanding); return { s, e: Math.abs(wrapDeg(s.yRot - b.yRot)) } }
  let best = null
  for (let q = -300; q <= 300; q += 3) { const r = fit(q); if (!best || r.e < best.e) best = { ...r, q } }
  for (let q = best.q - 3; q <= best.q + 3; q += 0.1) { const r = fit(q); if (r.e < best.e) best = { ...r, q } }
  const s = { x: b.x, y: b.y, z: b.z, vx: b.vx, vy: b.vy, vz: b.vz, yRot: b.yRot, yRotA: best.s.yRotA, hist: best.s.hist.slice(), inWall: false }
  const path = []
  for (let k = 1; k <= 400; k++) {
    const dx = s.x - T.x; const dy = s.y - T.y; const dz = s.z - T.z
    if (dx * dx + dy * dy + dz * dz < 1) {
      const sit = simClone(s)
      return { t: b.tt ?? b.t, stampT: b.t, monoT: b.ttMono ?? null, wallMs: b.wallMs, n: k - 1 + 1, fitErr: best.e, sit, head: simHead(sit, true), neck: simNeck(sit, true), path, yRotA: s.yRotA }
    }
    simStep(s, T, 1.5, turnLanding)
    path.push({ k, head: simHead(s, false), neck: simNeck(s, false), pos: new Vec3(s.x, s.y, s.z), yRot: s.yRot, st: simClone(s) })
  }
  return null
}

function predParts (fc) {
  const s = fc.sit
  const pos = new Vec3(s.x, s.y, s.z)
  const h = fc.head; const n = fc.neck
  const head = box(h.x, h.y, h.z, 0.5, 1)
  const neck = box(n.x, n.y, n.z, 1.5, 3)
  const body = box(s.x + msin(s.yRot * DRAD) * 0.5, s.y, s.z - mcos(s.yRot * DRAD) * 0.5, 2.5, 3)
  const dx = h.x - s.x; const dz = h.z - s.z; const l = Math.hypot(dx, dz) || 1
  const center = b => b.min.plus(b.max).scaled(0.5)
  return { sit: true, dir: { x: dx / l, z: dz / l }, pos, head, neck, body, headC: center(head), bodyC: center(body) }
}

function landingHits (fc, feet, pad = 0.4) {
  const pb = playerBox(feet)
  const grow = (b, h, v) => ({ min: b.min.offset(-h, -v, -h), max: b.max.offset(h, v, h) })
  for (const st of fc.path) {
    if (overlap(pb, grow(box(st.head.x, st.head.y, st.head.z, 0.5, 1), 1 + pad, 1 + pad))) return { k: st.k, what: 'голова' }
    if (overlap(pb, grow(box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3), 1 + pad, 1 + pad))) return { k: st.k, what: 'шея' }
    const cx = Math.cos(st.yRot * DRAD) * 4.5; const cz = Math.sin(st.yRot * DRAD) * 4.5
    for (const sg of [1, -1]) {
      const wx = st.pos.x + cx * sg; const wz = st.pos.z + cz * sg
      const wb = { min: new Vec3(wx - 6 - pad, st.pos.y - 2, wz - 6 - pad), max: new Vec3(wx + 6 + pad, st.pos.y + 4, wz + 6 + pad) }
      if (overlap(pb, wb)) return { k: st.k, what: 'крыло' }
    }
  }
  return null
}

const SEEN_Y5 = [0, 0.391, 0.783, 1.174, 1.565]

function exposure (vbot, feet, centre) {
  let open = 0; let all = 0
  for (const fy of SEEN_Y5) {
    for (const ox of SEEN_XZ) {
      for (const oz of SEEN_XZ) {
        all++
        const p = new Vec3(feet.x + ox, feet.y + fy, feet.z + oz)
        const dv = centre.minus(p); const len = dv.norm()
        if (len < 0.1) { open++; continue }
        if (!pick.blockOnRay(vbot, p, dv.scaled(1 / len), len - 0.02)) open++
      }
    }
  }
  return open / all
}

const DIRS4 = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }]

const addc = (c, d, k = 1) => ({ x: c.x + d.x * k, z: c.z + d.z * k })

function tsClickPoint (vbot, eye, plan) {
  const F = plan.F; const u = plan.u; const yb = plan.yb
  // грань F, обращённая к −u: плоскость x = F.x (+1 если −u = +x) …
  const fx = u.x > 0 ? F.x : u.x < 0 ? F.x + 1 : null
  const fz = u.z > 0 ? F.z : u.z < 0 ? F.z + 1 : null
  const pts = []
  for (const s of [0.5, 0.3, 0.7, 0.15, 0.85]) {
    for (const h of [0.3, 0.15, 0.45]) {
      const y = yb + h
      if (fx != null) pts.push(new Vec3(fx - u.x * 0.001, y, F.z + s)); else pts.push(new Vec3(F.x + s, y, fz - u.z * 0.001))
    }
  }
  for (const P of pts) {
    const dv = P.minus(eye); const len = dv.norm()
    if (len > 4.3 || len < 0.5) continue
    const hit = pick.blockOnRay(vbot, eye, dv.scaled(1 / len), len + 0.1)
    if (hit && /_bed$/.test(hit.block.name) && hit.pos.x === F.x && hit.pos.z === F.z && hit.pos.y === yb) return { point: P, block: hit.block }
  }
  return null
}

function anClickPoint (vbot, eye, st) {
  const P0 = new Vec3(st.H.x, st.yb, st.H.z)
  const faces = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]]
  for (const [fx, fy, fz] of faces) {
    for (const [a, b] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.25, 0.25], [0.75, 0.75], [0.25, 0.75], [0.75, 0.25]]) {
      const p = fx ? new Vec3(P0.x + (fx > 0 ? 1.001 : -0.001), P0.y + a, P0.z + b) : fy ? new Vec3(P0.x + a, P0.y + (fy > 0 ? 1.001 : -0.001), P0.z + b) : new Vec3(P0.x + a, P0.y + b, P0.z + (fz > 0 ? 1.001 : -0.001))
      const dv = p.minus(eye); const len = dv.norm()
      if (len > 4.3 || len < 0.5) continue
      if (dv.x * fx + dv.y * fy + dv.z * fz >= 0) continue
      const hit = pick.blockOnRay(vbot, eye, dv.scaled(1 / len), len + 0.1)
      if (hit && hit.pos.x === P0.x && hit.pos.y === P0.y && hit.pos.z === P0.z) return { point: p, block: hit.block, face: new Vec3(fx, fy, fz) }
    }
  }
  return null
}

const RES_CACHE = new Map()

function blockRes (bot, b) {
  if (!b || b.boundingBox === 'empty') return /water|lava/.test((b && b.name) || '') ? 100 : 0
  if (RES_CACHE.has(b.name)) return RES_CACHE.get(b.name)
  const info = bot.registry && bot.registry.blocksByName[b.name]
  const r = info && typeof info.resistance === 'number' ? info.resistance : 6
  RES_CACHE.set(b.name, r)
  return r
}

function blastReaches (vbot, bot, centre, cells, power = 5) {
  const want = new Set(cells.map(c => `${c.x},${c.y},${c.z}`))
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < 16; j++) {
      for (let k = 0; k < 16; k++) {
        if (!(i === 0 || i === 15 || j === 0 || j === 15 || k === 0 || k === 15)) continue
        let dx = i / 15 * 2 - 1; let dy = j / 15 * 2 - 1; let dz = k / 15 * 2 - 1
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz); dx /= l; dy /= l; dz /= l
        let h = power * 1.3
        let x = centre.x; let y = centre.y; let z = centre.z
        while (h > 0) {
          const bx = Math.floor(x); const by = Math.floor(y); const bz = Math.floor(z)
          const key = `${bx},${by},${bz}`
          const b = vbot.blockAt(new Vec3(bx, by, bz))
          const res = blockRes(bot, b)
          if (b && b.boundingBox !== 'empty') h -= (res + 0.3) * 0.3
          if (h > 0 && want.has(key)) return true
          x += dx * 0.3; y += dy * 0.3; z += dz * 0.3
          h -= 0.225
        }
      }
    }
  }
  return false
}

const SNEAK_EYE = 1.27

const BED_TOP = 0.5625

function hurtNear (pb, parts) {
  const grow = (b, h, v) => ({ min: b.min.offset(-h, -v, -h), max: b.max.offset(h, v, h) })
  return overlap(pb, grow(parts.head, HURT_PAD, 1.05)) || overlap(pb, grow(parts.neck, HURT_PAD, 1.05)) || overlap(pb, grow(parts.body, 0.5, 0.3))
}

function bedCellFree (b) { return !!b && (isAirish(b) || /^(fire|soul_fire)$/.test(b.name)) }

function fillPlaceable (bot, pos, eye, { robust = false }: any = {}) {
  // robust: грань видна и при сдвиге глаз на ±0.2 (тело стоит не точно в середине клетки:
  // fin4 — заслон «грань не видно» с места ставки при касательном взгляде, бот в 0.4 от центра).
  const eyes = robust ? [eye, eye.offset(0.2, 0, 0), eye.offset(-0.2, 0, 0), eye.offset(0, 0, 0.2), eye.offset(0, 0, -0.2)] : [eye]
  for (const f of [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
    const ref = bot.blockAt(pos.minus(f))
    if (!ref || !isSolid(ref) || /_bed$|portal|gateway/.test(ref.name)) continue
    if (eyes.every(e => pick.faceAim(bot, ref.position, f, { eye: e, avoid: [] }))) return true
  }
  return false
}

const SOLID_SHAPE = [[0, 0, 0, 1, 1, 1]]

const BED_SHAPE = [[0, 0, 0, 1, 0.5625, 1]]

function virtualBot (bot, extra) {
  return {
    ...bot,
    blockAt (p, ...r: any[]) {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      const k = `${x},${y},${z}`
      if (extra.has(k)) {
        const v = extra.get(k)
        const pos = new Vec3(x, y, z)
        if (v === 'air') return { name: 'air', boundingBox: 'empty', shapes: [], position: pos }
        if (v === 'bed') return { name: 'red_bed', boundingBox: 'block', shapes: BED_SHAPE, position: pos }
        return { name: 'cobblestone', boundingBox: 'block', shapes: SOLID_SHAPE, position: pos }
      }
      return bot.blockAt(p, ...r)
    }
  }
}

const SEEN_XZ = [-0.255, 0.018, 0.29]

function bedDamage (dist, seen = 1) {
  const i = Math.max(0, 1 - dist / 10) * seen
  return Math.round((i * i + i) / 2 * 70 + 1)
}

const SEEN_DX = [-7, -3.5, 0, 3.5, 7];

const SEEN_DY = [0.5, 4, 7.5]

function dragonSeen (vbot, centre, pos) {
  let open = 0; let all = 0
  for (const dx of SEEN_DX) {
    for (const dy of SEEN_DY) {
      for (const dz of SEEN_DX) {
        all++
        const p = new Vec3(pos.x + dx, pos.y + dy, pos.z + dz)
        const dv = p.minus(centre); const len = dv.norm()
        if (len < 0.1) { open++; continue }
        if (!pick.blockOnRay(vbot, centre, dv.scaled(1 / len), len)) open++
      }
    }
  }
  return open / all
}

async function sneakPlace (bot, pos, opts) {
  const was = bot.getControlState('sneak')
  bot.setControlState('sneak', true)
  await new Promise<any>(resolve => bot.once('physicsTick', resolve))
  try { return await build.placeBlockAt(bot, pos, { ...opts, item: fillerItem(bot) }) } finally { if (!was) bot.setControlState('sneak', false) }
}

module.exports = { lookAtSafe, countOf, dangerAt, SCAN_RANGE, noteNear, evade, evadeRaw, straightExposure, escapeSpot, bedPlan, takeoffSidestep, segPoint2, MSIN, mIdx, msin, mcos, DRAD, wrapDeg, clampN, nrm3, simStep, turnLanding, simClone, simPart, simHead, simNeck, landingForecast, predParts, landingHits, SEEN_Y5, exposure, DIRS4, addc, tsClickPoint, anClickPoint, RES_CACHE, blockRes, blastReaches, SNEAK_EYE, BED_TOP, hurtNear, bedCellFree, fillPlaceable, SOLID_SHAPE, BED_SHAPE, virtualBot, SEEN_XZ, bedDamage, SEEN_DX, SEEN_DY, dragonSeen, sneakPlace }
