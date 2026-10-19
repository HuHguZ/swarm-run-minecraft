'use strict'
// Бой с драконом (dragon/pillar-run.ts): один цикл: посадка, свой клик, взлёт, первый тик, станция в виду.
const { gameClock, Vec3, overlap, playerBox, inflate, FILLER_RE, sleep, isSolid, dragonOf, phaseOf, PHASE, items, build, EYE, SITTING, partsOf, clearControls, box, PHASE_RU, pick, sitFix, fillerItem }: typeof import('../dig-down-to') = require('../dig-down-to')
const { doing, r1, podiumTop, sight }: typeof import('../fall-guard') = require('../fall-guard')
const { countOf, lookAtSafe, DRAD, virtualBot, exposure, landingForecast, landingHits, bedDamage, hurtNear, simClone, simHead, simNeck, predParts, tsClickPoint, DIRS4, blastReaches, anClickPoint }: typeof import('../evade-raw') = require('../evade-raw')
const { BED_GAP_MS, bedsBuild, bedClickPoint }: typeof import('../pillar-plan') = require('../pillar-plan')
const { FACE_IDX, pushedForecast, yRotOf, blastPush, dragonNodes, takeoffNode, takeoffForecast, tsPlan, tsSecond, tsOwnPlan, stationWorld, tsOwnStation }: typeof import('../ts-plan') = require('../ts-plan')
import { sitRec, sitAcc } from './sight-zones'
import { bedsLayout } from './beds-plan'
import { bedsGo, bedsBoom } from './beds-act'
import { tsBuild, tsTrench } from './ts-build'

async function ocLanding (session, ctl, rep, stats, track, feed, { blindLid = false }: any = {}) {
  const bot = session.bot
  const P = podiumTop(bot)
  const fc = landingForecast(feed, P)
  if (!fc || fc.n < 40 || fc.n > 190) { if (ctl.trace) ctl.trace.ev('ocL', { why: fc ? `n ${fc.n}` : 'нет прогноза', blindLid: blindLid || undefined }); return false }
  // Режим «видящий» (ND_SEE=1): на первой посадке L нет — окоп спрятал бы нас от первого
  // «высматривает», и дракон остался бы слепым навсегда (Sensing не чистится).
  if (process.env.ND_SEE === '1' && !blindLid) {
    const dd0 = dragonOf(bot)
    if (dd0 && !sight.get(dd0.id + ':' + bot.entity.id)) { if (ctl.trace) ctl.trace.ev('ocL', { why: 'видящий: первая посадка без L', n: fc.n }); return false }
  }
  const anchorsOk = process.env.ND_OC_ANCHOR !== '0' && !blindLid && countOf(bot, /^respawn_anchor$/) >= 1 && countOf(bot, /^glowstone$/) >= 1
  if ((countOf(bot, /_bed$/) < 2 && !anchorsOk) || countOf(bot, FILLER_RE) < 3) return false
  const d = dragonOf(bot)
  if (!d) return false
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  stats.oc = stats.oc || { tries: 0, built: 0, booms: 0, why: {} }
  const no = w => { stats.oc.why[w] = (stats.oc.why[w] || 0) + 1; ev('ocL', { why: w, n: fc.n }); return false }
  stats.oc.tries++
  const tPlan0 = gameClock.now()
  const tgt = (fc.path[fc.n - 3] || fc.path[fc.path.length - 1]).head
  let plan = null
  const whyAll = {}
  const cands = []
  // Кровать на блок или два выше земли (на два — центр взрыва у самой головы; кровать не
  // должна попасть в коробки головы/шеи на пути снижения — проверка в tsPlan: oc3-22).
  for (const lift of [2, 1]) {
    if (countOf(bot, /_bed$/) < 1) break
    const p2 = tsPlan(bot, tgt, { lift, fc, dpos: new Vec3(fc.sit.x, fc.sit.y, fc.sit.z), lid: blindLid })
    for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) whyAll[k] = (whyAll[k] || 0) + v
    cands.push(...(tsPlan.all || []))
    if (p2 && (!plan || p2.cost < plan.cost)) plan = p2
  }
  // Якорь возрождения (есть в рюкзаке): прямо на путь головы — взрыв ближе (до ~0.5 от низа головы).
  if (anchorsOk) {
    let pa = null
    for (const lift of [3, 2, 1]) {
      const p3 = tsPlan(bot, tgt, { lift, fc, dpos: new Vec3(fc.sit.x, fc.sit.y, fc.sit.z), anchor: true })
      for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) whyAll['я:' + k] = (whyAll['я:' + k] || 0) + v
      if (p3 && (!pa || p3.cost < pa.cost)) pa = p3
    }
    if (pa && (!plan || pa.expect > plan.expect + 3)) plan = pa
  }
  tsPlan.why = whyAll
  if (!plan) { ev('ocNoPlan', { no: tsPlan.why }); return no('нет станции у головы') }
  // Вторая кровать снижения (L0) с другой стороны того же окопа — за ≥ 10 тиков до L.
  let refHead = fc.head
  if (process.env.ND_OC_L0 === '1' && !blindLid && fc.n >= 60) {
    const dpos = new Vec3(fc.sit.x, fc.sit.y, fc.sit.z)
    const P = podiumTop(bot)
    const seenKeys = new Set()
    const top = cands.sort((p, q) => p.cost - q.cost).filter(c => { const k = `${c.B.x},${c.B.z}`; if (seenKeys.has(k)) return false; seenKeys.add(k); return true }).slice(0, 3)
    let bestPair = null; const why0 = {}
    const note = k => { why0[k] = (why0[k] || 0) + 1 }
    for (const c of top) {
      const sides = DIRS4.filter(d2 => !(d2.x === c.u.x && d2.z === c.u.z))
      const s2 = tsSecond(bot, c, fc, { dpos, sides })
      for (const [k, v] of (Object.entries(tsSecond.why || {}) as [string, any][])) why0[k] = (why0[k] || 0) + v
      if (!s2) continue
      const fc2 = pushedForecast(fc, s2.i0, s2.centre, s2.seen || 1, P)
      if (!fc2) { note('толчок: нет посадки'); continue }
      if ((fc2.n - 2) - (s2.i0 + 1) < 10) { note('толчок: L раньше 10 тиков'); continue }
      const tgt2 = (fc2.path[fc2.n - 3] || fc2.path[fc2.path.length - 1]).head
      const avoid = new Set([s2.F, s2.W, s2.V, s2.PS, s2.H].map(q => `${q.x},${q.z}`))
      const extra = new Map()
      for (const y of s2.sCells) extra.set(`${s2.F.x},${y},${s2.F.z}`, 'block')
      for (const y of s2.wCells) extra.set(`${s2.W.x},${y},${s2.W.z}`, 'block')
      let L2 = null
      for (const lift of [2, 1]) {
        const q = tsPlan(bot, tgt2, { lift, fc: fc2, dpos: new Vec3(fc2.sit.x, fc2.sit.y, fc2.sit.z), fixedB: c.B, avoid, extra })
        if (q && (!L2 || q.cost < L2.cost)) L2 = q
      }
      if (!L2) { note('L после толчка: нет станции у того же окопа'); continue }
      // L переживает взрыв L0; бок L0 виден из окопа в мире со станцией L2
      const exW = new Map(L2.world); exW.set(`${L2.F.x},${L2.yb},${L2.F.z}`, 'bed'); exW.set(`${L2.H.x},${L2.yb},${L2.H.z}`, 'bed')
      if (blastReaches(virtualBot(bot, exW), bot, s2.centre, [{ x: L2.F.x, y: L2.yb, z: L2.F.z }, { x: L2.H.x, y: L2.yb, z: L2.H.z }])) { note('L0 снесёт кровать L'); continue }
      const ex0 = new Map(exW); ex0.set(`${s2.F.x},${s2.yb},${s2.F.z}`, 'bed'); ex0.set(`${s2.H.x},${s2.yb},${s2.H.z}`, 'bed')
      if (!tsClickPoint(virtualBot(bot, ex0), L2.trench.offset(0, EYE, 0), s2)) { note('бок L0 закрыт станцией L'); continue }
      if (exposure(virtualBot(bot, L2.world), L2.trench, s2.centre) > 0.02) { note('взрыв L0 видит окоп'); continue }
      const sum = s2.expect + L2.expect
      if (!bestPair || sum > bestPair.sum) bestPair = { L2, s2, fc2, sum }
    }
    ev('ocPlan0', bestPair ? { i0: bestPair.s2.i0, n: fc.n, n2: bestPair.fc2.n, H0: [bestPair.s2.H.x, bestPair.s2.yb, bestPair.s2.H.z], L0: bestPair.s2.expect, H: [bestPair.L2.H.x, bestPair.L2.yb, bestPair.L2.H.z], L: bestPair.L2.expect, alone: plan.expect, push: [r1(bestPair.fc2.pushed.x * 100) / 100, r1(bestPair.fc2.pushed.y * 100) / 100, r1(bestPair.fc2.pushed.z * 100) / 100] } : { no: why0, tried: top.length })
    if (bestPair && bestPair.sum > plan.expect + 25) {
      plan = bestPair.L2; plan.second = bestPair.s2; plan.gapTicks = (bestPair.fc2.n - 2) - (bestPair.s2.i0 + 1); plan.nPlan = fc.n
      refHead = bestPair.fc2.head
    }
  }
  // Взлёт слепого (сам, на 99-м тике после посадки — без толчка B): голова первые ~15 тиков
  let tk = null
  if (process.env.ND_OC_TK === '1' && !blindLid && sight.get(d.id + ':' + bot.entity.id) === 'blind') {
    const why1 = {}
    const n1 = k => { why1[k] = (why1[k] || 0) + 1 }
    const fcL = pushedForecast(fc, fc.n - 3, plan.centre, plan.seen || 1, P)
    if (!fcL) n1('посадка после L не считается')
    else if (hurtNear(playerBox(plan.ground), predParts(fcL)) || hurtNear(playerBox(new Vec3(plan.B.x + 0.5, plan.G, plan.B.z + 0.5)), predParts(fcL))) n1('станция L у шеи сидящего (T1 заново не поставить)')
    else {
      const A = bedsLayout(bot, d, predParts(fcL), { headAt: fcL.head, noTurn: true, brave: true, cap: 46 })
      const S = simClone(fcL.sit)
      if (A) { const pu = blastPush(S, A.centre, A.seen != null ? A.seen : 1); S.vx += pu.x; S.vy += pu.y; S.vz += pu.z }
      S.hist = new Array(12).fill(S.y)
      const nodes = dragonNodes(bot)
      const node = nodes && takeoffNode(nodes, S)
      if (!node) n1('узел взлёта не найден')
      else {
        const path = takeoffForecast(S, node, 30)
        const t1 = path[1]
        const t1exp = bedDamage(t1.head.distanceTo(plan.centre), plan.seen || 1)
        const sides = DIRS4.filter(q => !(q.x === plan.u.x && q.z === plan.u.z))
        const T2 = tsSecond(bot, plan, { n: 99, path }, { dpos: new Vec3(S.x, S.y, S.z), sides, imin: 11, imax: 18, primaryFirst: true })
        if (!T2) Object.assign(why1, tsSecond.why || {})
        else {
          // Клетки станции T2 (кровать, опора, заслон) не на пути снижения (checkWalls снесёт) и
          // переживут взрыв A (A — сидя, до T1/T2).
          const cells = [{ x: T2.F.x, y: T2.yb, z: T2.F.z }, { x: T2.H.x, y: T2.yb, z: T2.H.z }, ...T2.sCells.map(y => ({ x: T2.F.x, y, z: T2.F.z })), ...T2.wCells.map(y => ({ x: T2.W.x, y, z: T2.W.z }))]
          let onPath = false
          for (const st of fc.path) {
            const boxes = [inflate(box(st.head.x, st.head.y, st.head.z, 0.5, 1), 0.2), inflate(box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3), 0.2), inflate(box(st.pos.x + Math.sin(st.yRot * DRAD) * 0.5, st.pos.y, st.pos.z - Math.cos(st.yRot * DRAD) * 0.5, 2.5, 3), 0.2)]
            if (cells.some(c => boxes.some(b => overlap(b, { min: new Vec3(c.x, c.y, c.z), max: new Vec3(c.x + 1, c.y + 1, c.z + 1) })))) { onPath = true; break }
          }
          const ex = new Map(plan.world)
          for (const y of T2.sCells) ex.set(`${T2.F.x},${y},${T2.F.z}`, 'block')
          for (const y of T2.wCells) ex.set(`${T2.W.x},${y},${T2.W.z}`, 'block')
          ex.set(`${T2.F.x},${T2.yb},${T2.F.z}`, 'bed'); ex.set(`${T2.H.x},${T2.yb},${T2.H.z}`, 'bed')
          if (onPath) n1('станция T2 на пути снижения')
          else if (A && blastReaches(virtualBot(bot, ex), bot, A.centre, cells)) n1('взрыв A заденет станцию T2')
          else tk = { A, T2, path, node, t1exp, sum: t1exp + T2.expect, S }
        }
      }
    }
    ev('ocTk', tk ? { node: [tk.node.x, tk.node.z], A: tk.A ? tk.A.expect : null, T1: tk.t1exp, T2: tk.T2.expect, i2: tk.T2.i0, H2: [tk.T2.H.x, tk.T2.yb, tk.T2.H.z] } : { no: why1 })
    if (tk && tk.sum < 70) tk = null
    if (tk) { plan.second = tk.T2 }
  }  // Кровать A заранее в СВОЁМ окопе у головы сидящего (слепой: голова сидящего не поворачивается):
  // после L — к окопу A, щелчок через ≥ 10 тиков после L, в сидячий счёт (≤ cap). Темп спидраннеров:
  let fcA = null
  let ownA = null
  let ownB = null
  if (process.env.ND_OC_A === '1' && !blindLid && !plan.second && fc.n >= 120 && sight.get(d.id + ':' + bot.entity.id) === 'blind') {
    fcA = pushedForecast(fc, fc.n - 3, plan.centre, plan.seen || 1, P)
    if (fcA) {
      const acc = sitAcc.id === d.id ? sitAcc.dmg : 0
      const cap = acc < 25 ? 49 - acc : null
      const tA = gameClock.now()
      ownA = tsOwnPlan(bot, plan, fcA, { cap, dpos: new Vec3(fcA.sit.x, fcA.sit.y, fcA.sit.z) })
      ev('ocA', ownA ? { ms: gameClock.now() - tA, H: [ownA.H.x, ownA.yb, ownA.H.z], B: [ownA.B.x, ownA.G, ownA.B.z], depth: ownA.depth, expect: ownA.expect, dist: r1(ownA.centre.distanceTo(fcA.head)), seen: ownA.seen, cap, acc: r1(acc) } : { ms: gameClock.now() - tA, no: tsOwnPlan.why, cap, acc: r1(acc) })
      // B — тоже свой окоп у головы сидящего, без потолка (её взрыв поднимет на взлёт); цела после
      // взрывов L и A, её окоп не в их воронках.
      if (ownA && process.env.ND_OC_B !== '0') {
        const tB = gameClock.now()
        const world = stationWorld(ownA, stationWorld(plan, plan.world))
        ownB = tsOwnStation(bot, fcA.head, { fc: { ...fcA, n: fcA.n + 3 }, dpos: new Vec3(fcA.sit.x, fcA.sit.y, fcA.sit.z), world, priors: [plan, ownA], avoid: [plan, ownA], sitP: predParts(fcA) })
        if (ownB) ownB.role = 'B'
        ev('ocB', ownB ? { ms: gameClock.now() - tB, H: [ownB.H.x, ownB.yb, ownB.H.z], B: [ownB.B.x, ownB.G, ownB.B.z], depth: ownB.depth, expect: ownB.expect, dist: r1(ownB.centre.distanceTo(fcA.head)), seen: ownB.seen } : { ms: gameClock.now() - tB, no: tsOwnStation.why })
      }
    } else ev('ocA', { no: { 'посадка после L не считается': 1 } })
  }

  ev('ocPlan', { ms: gameClock.now() - tPlan0, anchor: plan.anchor || undefined, n: fc.n, head: [r1(tgt.x), r1(tgt.y), r1(tgt.z)], sitHead: [r1(fc.head.x), r1(fc.head.y), r1(fc.head.z)], yRotA: r1(fc.yRotA), H: [plan.H.x, plan.yb, plan.H.z], lift: plan.lift, depth: plan.depth, dist: plan.dist, seen: plan.seen, expect: plan.expect, u: [plan.u.x, plan.u.z], a: [plan.a.x, plan.a.z], no: whyAll })
  doing(ctl, 'oc:build')
  // Опасно стоять там, где мы сейчас: коробки снижающегося по свежему прогнозу на ~1.5 с вперёд.
  const danger = () => {
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : null
    if (ph !== PHASE.LANDING) return `фаза ${PHASE_RU[ph] ?? ph}`
    const f = feed.fc && feed.fc.id === d.id ? feed.fc : fc
    if (f.n - Math.round((gameClock.now() - f.t) / 50) < 8) return 'не успеть до посадки'
    const soon = { ...f, path: f.path.slice(0, 30) }
    const h = landingHits(soon, bot.entity.position, 0.5)
    return h ? `${h.what} через ${h.k} тиков` : null
  }
  ctl.holdStation = true
  let b
  const leftTicks = () => { const f = feed.fc && feed.fc.id === d.id ? feed.fc : fc; return f.n - Math.round((gameClock.now() - f.t) / 50) }
  try {
    if (!ownA) b = await tsBuild(session, ctl, stats, plan, danger, leftTicks)
    else {
      b = await tsBuild(session, ctl, stats, plan, danger, leftTicks, { skipTrench: true })
      if (b.ok) {
        // A — пока до посадки ≥ 70 тиков; бросить, если меньше 45 (успеть в окоп L).
        if (leftTicks() >= 70) {
          const dangerA = () => (leftTicks() < 45 ? 'некогда (A)' : danger())
          const bA = await tsBuild(session, ctl, stats, ownA, dangerA, leftTicks, { skipTrench: true })
          if (!bA.ok) { ev('ocA', { fail: `стройка A: ${bA.why}` }); ownA = null; ownB = null }
          if (ownB && leftTicks() >= 70) {
            const bB = await tsBuild(session, ctl, stats, ownB, dangerA, leftTicks, { skipTrench: true })
            if (bB.ok) ownB.built = true
            else { ev('ocB', { fail: `стройка B: ${bB.why}` }); ownB = null }
          }
        } else { ev('ocA', { fail: 'некогда строить A' }); ownA = null; ownB = null }
        b = await tsBuild(session, ctl, stats, plan, danger, leftTicks, { onlyTrench: true })
      }
    }
  } finally { ctl.holdStation = false }
  if (!b.ok) return no(`стройка: ${b.why}`)
  stats.oc.built++
  // L0: щелчок за gapTicks тиков до L (прогноз — свежий).
  if (plan.second && plan.gapTicks >= 10) {
    const s2 = plan.second
    const hit0 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), s2)
    if (hit0) {
      await lookAtSafe(bot, hit0.point)
      await new Promise<any>(resolve => bot.once('physicsTick', resolve))
      doing(ctl, 'oc:wait0')
      let t0c = 0; let last0 = fc; let okWait = true
      for (;;) {
        if (ctl.aborted) return false
        const dd = dragonOf(bot)
        if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) { okWait = false; break }
        const f2 = feed.fc && feed.fc.id === d.id ? feed.fc : null
        if (f2) last0 = f2
        // До L0 дракон летит по прогнозу без толчка: тик L0 — i0 + 1 от пакета плана, сдвиг —
        // по свежему прогнозу того же (ещё не толкнутого) полёта.
        t0c = plan.nPlan ? last0.t + 50 * (last0.n - plan.nPlan + s2.i0 + 1) - 30 : last0.t + 50 * (last0.n - 2) - 30 - 50 * plan.gapTicks
        if (t0c - gameClock.now() < 70) break
        await sleep(15)
      }
      if (okWait && t0c > gameClock.now() - 30) {
        const at0 = plan.nPlan ? last0.path[last0.n - plan.nPlan + s2.i0] : last0.path[last0.n - 3 - plan.gapTicks]
        const hd0 = at0 ? r1(at0.head.distanceTo(s2.centre)) : null
        const b0 = await bedsBoom(session, ctl, stats, { ...s2, reuse: true }, hit0, 'снижение', { aimed: true, until: t0c, uncounted: true, phCheck: p => p === PHASE.LANDING, note: { headDist: hd0, oc: 'L0' } })
        stats.oc.L0 = stats.oc.L0 || []
        stats.oc.L0.push({ ok: b0.ok, dmg: b0.dmg, headDist: hd0 })
      } else ev('ocL', { why: 'L0: не дождался' })
    } else ev('ocL', { why: 'L0: бок не видно' })
  }
  const hitPt = plan.anchor ? anClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan) : tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
  if (!hitPt) return no(plan.anchor ? 'якорь из окопа не видно' : 'бок кровати из окопа не видно')
  await lookAtSafe(bot, hitPt.point)
  await new Promise<any>(resolve => bot.once('physicsTick', resolve))
  // Ждать миг: прогноз по свежим пакетам; голова должна лечь у кровати.
  doing(ctl, 'oc:wait')
  let tClick = 0; let last = fc
  for (;;) {
    if (ctl.aborted) return false
    const dd = dragonOf(bot)
    if (!dd) return false
    const ph = phaseOf(bot, dd)
    if (ph !== PHASE.LANDING) return no(`фаза ${PHASE_RU[ph] ?? ph} до щелчка`)
    const f2 = landingForecast(feed, P)
    if (f2) last = f2
    const miss = last.head.distanceTo(refHead)
    if (miss > 1.2) return no(`прогноз ушёл на ${r1(miss)}`)
    if (landingHits(last, bot.entity.position, 0.2)) return no('коробки дракона на месте')
    // Щелчок, обработанный после тика g + n − 2 (за два тика до посадки): опоздание на тик
    // — ещё снижение; на тик раньше «в самый раз» — уже сидит (урон в сидячий счёт; oc2-26).
    tClick = last.t + 50 * (last.n - 2) - 55
    if (tClick - gameClock.now() < 70) break
    await sleep(15)
  }
  const at = last.path[last.n - 3] || last.path[last.path.length - 1]
  const cen = plan.centre
  const headDist = at ? r1(Math.hypot(at.head.x - cen.x, at.head.y - cen.y, at.head.z - cen.z)) : null
  // Первая посадка: сразу за L — крышка над головой к упору K (обработается через тик, до
  // тика посадки: первое «высматривает» спросит видимость — окоп закрыт, и дракон слепой навсегда).
  let lidSent = false
  const placeLid = async () => {
    const K = new Vec3(plan.K.x, plan.G, plan.K.z)
    const face = new Vec3(-plan.K.d.x, 0, -plan.K.d.z)
    const aim = pick.faceAim(bot, K, face, { avoid: [] })
    if (!aim) return
    await lookAtSafe(bot, aim)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    const cur = aim.minus(K)
    bot._client.write('block_place', { location: K, direction: FACE_IDX(face), hand: 0, cursorX: cur.x, cursorY: cur.y, cursorZ: cur.z, insideBlock: false, sequence: 0, worldBorderHit: false })
    bot.swingArm()
    lidSent = true
  }
  if (blindLid) {
    const f = fillerItem(bot)
    const it = f && bot.inventory.items().find(i => i.name === f)
    if (it) await bot.equip(it, 'hand').catch(() => {})
    await lookAtSafe(bot, hitPt.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
  }
  const boom = await bedsBoom(session, ctl, stats, plan, hitPt, 'снижение', { aimed: true, until: tClick, uncounted: true, phCheck: p => p === PHASE.LANDING, note: { headDist, n: last.n, oc: 'L', lid: blindLid || undefined }, keepHand: blindLid, afterClick: blindLid ? placeLid : null })
  if (blindLid) {
    // Дождаться «высматривает» (запрос видимости — в тик посадки), потом вылезти.
    const lidPos = new Vec3(plan.B.x, plan.G, plan.B.z)
    const t0 = gameClock.now(); let sat = 0; let roared = false
    while (!ctl.aborted && gameClock.now() - t0 < 4000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (ph === PHASE.ROARING || ph === PHASE.FLAMING) { roared = true; break }
      if (SITTING.has(ph)) { if (!sat) sat = gameClock.now(); if (gameClock.now() - sat > 150) break }
      await sleep(20)
    }
    const lidUp = isSolid(bot.blockAt(lidPos))
    ev('blind:lid', { sent: lidSent, lid: lidUp, sat: !!sat, roared })
    if (sat && lidUp && !roared && dragonOf(bot)) sight.set(dragonOf(bot).id + ':' + bot.entity.id, 'blind')
    if (lidUp) { await items.equipBestTool(bot, bot.blockAt(lidPos)); await build.withTimeout(bot.dig(bot.blockAt(lidPos), true), 3000).catch(() => {}) }
  }
  if (!boom.ok) return no(`щелчок: ${boom.why}`)
  stats.oc.booms++
  stats.oc.L = stats.oc.L || []
  stats.oc.L.push({ dmg: boom.dmg, headDist, took: boom.ph })
  if (tk && plan.second) ctl.ocTk = { dId: d.id, t: gameClock.now(), plan: { ...plan, second: null }, T2: tk.T2, A: tk.A, path: tk.path, S: tk.S }
  // Видящий: «высматривает» 25 тиков поворачивает голову к нам — переждать в окопе (в окопе в 2
  {
    const dd = dragonOf(bot)
    if (dd && sight.get(dd.id + ':' + bot.entity.id) === 'seeing') {
      doing(ctl, 'oc:scanWait')
      const tw = gameClock.now()
      while (!ctl.aborted && gameClock.now() - tw < 3500) {
        const d2 = dragonOf(bot); const ph2 = d2 ? phaseOf(bot, d2) : null
        if (!d2 || ph2 === PHASE.ROARING || ph2 === PHASE.FLAMING) break
        if (!SITTING.has(ph2) && ph2 !== PHASE.LANDING) break
        await sleep(25)
      }
    }
  }
  // Из окопа — сразу на землю (блок под себя): выход шагами из ямы в блок шёл по 4 с
  // (oc7-15: «beds:walk» до самого взлёта — ни A, ни B).
  const q = bot.entity.position
  if (Math.floor(q.y + 0.01) < plan.G) { doing(ctl, 'oc:out'); await build.towerUp(bot, ctl, plan.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  if (ownA) {
    const rA = await ocOwnClick(session, ctl, stats, ownA, fcA, track, { tag: 'A' })
    // B: построена на снижении — дойти и щёлкнуть; нет — построить сейчас (слепой сидит 99 тиков).
    if (rA && ownB) await ocOwnClick(session, ctl, stats, ownB, fcA, track, { tag: 'B', build: !ownB.built })
  }
  return true
}

async function ocOwnClick (session, ctl, stats, st, fcA, track, { tag = 'A', build: doBuild = false }: any = {}) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  let why = null
  let ok = false
  const sittingNow = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  try {
    const d0 = dragonOf(bot)
    if (!d0) { why = 'нет дракона'; return false }
    if (doBuild) {
      if (!sittingNow()) { why = 'не сидит — строить некогда'; return false }
      if (!st.psSafe) { why = 'место ставки у шеи сидящего'; return false }
      ctl.holdStation = true
      let b
      try { b = await tsBuild(session, ctl, stats, st, () => (!sittingNow() ? 'взлетел' : null), null, { skipTrench: true, parts: () => partsOf(bot, dragonOf(bot), track) }) } finally { ctl.holdStation = false }
      if (!b.ok) { why = `стройка: ${b.why}`; return false }
    }
    const bedOk = /_bed$/.test((bot.blockAt(new Vec3(st.H.x, st.yb, st.H.z)) || {}).name || '')
    if (!bedOk) { why = 'кровати нет (снесло?)'; return false }
    doing(ctl, `oc:to${tag}`)
    const feet = new Vec3(st.B.x + 0.5, st.G, st.B.z + 0.5)
    const g = await bedsGo(session, ctl, { feet, y: st.G, B: st.B, lift: 0 }, true, partsOf(bot, d0, track))
    if (!g.ok) { why = `не дошёл: ${g.why}`; return false }
    const tr = await tsTrench(bot, ctl, st, k => doing(ctl, `oc${tag}:` + k), session)
    if (!tr.ok) { why = `окоп: ${tr.why}`; return false }
    const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), st)
    if (!hit) { why = 'бок не видно'; return false }
    await lookAtSafe(bot, hit.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    doing(ctl, `oc:wait${tag}`)
    const tw = gameClock.now()
    let sat = false
    while (!ctl.aborted && gameClock.now() - tw < 3000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (SITTING.has(ph)) { sat = true; break }
      if (ph !== PHASE.LANDING) break
      await sleep(10)
    }
    if (!sat) { why = 'не сидит'; return false }
    const hd = fcA ? r1(fcA.head.distanceTo(st.centre)) : null
    const r = await bedsBoom(session, ctl, stats, { ...st, reuse: true }, hit, 'сидит', { aimed: true, until: Math.max(gameClock.now(), (stats.lastBoom || 0) + BED_GAP_MS), phCheck: p => SITTING.has(p), note: { oc: tag, headDist: hd, ms: gameClock.now() - t0, prebuilt: !doBuild } })
    stats.oc[tag] = stats.oc[tag] || []
    stats.oc[tag].push({ ok: r.ok, dmg: r.dmg, headDist: hd })
    if (!r.ok) { why = `щелчок: ${r.why}`; return false }
    ok = true
    return true
  } finally {
    ev('oc' + tag, { done: ok, why, ms: gameClock.now() - t0 })
    const q = bot.entity.position
    if (Math.floor(q.y + 0.01) < st.G && Math.floor(q.x) === st.B.x && Math.floor(q.z) === st.B.z) { doing(ctl, `oc:out${tag}`); await build.towerUp(bot, ctl, st.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

async function ocTakeoffRun (session, ctl, rep, stats, track, P, tkP) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const rec = sitRec
  const t0 = rec && !rec.ended ? rec.t0 : gameClock.now()
  const el = () => gameClock.now() - t0
  const sitting = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  const out = { A: null, T1: null, T2: null, why: null }
  try {
    // A
    if (tkP.A && el() < 2200 && sitting()) {
      const A = tkP.A
      const g = await bedsGo(session, ctl, A, true, partsOf(bot, dragonOf(bot), track))
      if (g.ok) {
        ctl.holdStation = true
        let b
        try { b = await bedsBuild(session, ctl, stats, A) } finally { ctl.holdStation = false }
        while (!ctl.aborted && gameClock.now() < (stats.lastBoom || 0) + BED_GAP_MS) await sleep(20)
        const hit = b.ok && sitting() ? bedClickPoint(bot, A) : null
        if (hit) { const bo = await bedsBoom(session, ctl, stats, A, hit, 'сидит', { note: { oc: 'A' } }); if (bo.ok) { out.A = bo.dmg; P.beds.push(bo.dmg) } }
      }
    }
    if (!sitting()) { out.why = 'взлетел до T1'; return out }
    // T1: станция L заново (опора/заслон, если снесло, кровать), в окоп
    const danger = () => (!sitting() ? 'взлетел' : el() > 4500 ? 'не успеть до взлёта' : null)
    ctl.holdStation = true
    let tb
    try { tb = await tsBuild(session, ctl, stats, tkP.plan, danger, null) } finally { ctl.holdStation = false }
    if (!tb.ok) { out.why = `T1: ${tb.why}`; return out }
    const hit1 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tkP.plan)
    const hit2p = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tkP.T2)
    if (!hit1) { out.why = 'T1 не видно'; return out }
    await lookAtSafe(bot, hit1.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    doing(ctl, 'tk:wait')
    // сам-взлёт: фаза TAKEOFF
    const tw = gameClock.now()
    while (!ctl.aborted && gameClock.now() - tw < 6000) {
      const dd = dragonOf(bot)
      if (!dd) break
      const ph = phaseOf(bot, dd)
      if (ph === PHASE.TAKEOFF) break
      if (!SITTING.has(ph)) { out.why = `фаза ${PHASE_RU[ph] ?? ph}`; return out }
      await sleep(5)
    }
    const tT1 = gameClock.now()
    const d1 = dragonOf(bot)
    if (!d1 || phaseOf(bot, d1) !== PHASE.TAKEOFF) { out.why = 'взлёта не дождался'; return out }
    const b1 = await bedsBoom(session, ctl, stats, tkP.plan, hit1, 'взлёт', { aimed: true, uncounted: true, note: { oc: 'T1', headDist: r1(tkP.path[1].head.distanceTo(tkP.plan.centre)) } })
    if (b1.ok) { out.T1 = b1.dmg; P.beds.push(b1.dmg) }
    // T2
    const hit2 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), tkP.T2) || hit2p
    if (!hit2) { out.why = 'T2 не видно'; return out }
    await lookAtSafe(bot, hit2.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    const tT2 = tT1 + 50 * (tkP.T2.i0 - 1) - 30
    const b2 = await bedsBoom(session, ctl, stats, { ...tkP.T2, reuse: true }, hit2, 'взлёт', { aimed: true, until: Math.max(tT2, (stats.lastBoom || 0) + BED_GAP_MS), uncounted: true, note: { oc: 'T2', headDist: r1(tkP.path[tkP.T2.i0].head.distanceTo(tkP.T2.centre)) } })
    if (b2.ok) { out.T2 = b2.dmg; P.beds.push(b2.dmg) }
    return out
  } finally {
    ev('ocTkRun', out)
    // из окопа
    const q = bot.entity.position
    if (tkP.plan && Math.floor(q.y + 0.01) < tkP.plan.G && Math.floor(q.x) === tkP.plan.B.x && Math.floor(q.z) === tkP.plan.B.z) { await build.towerUp(bot, ctl, tkP.plan.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

async function ocT1 (session, ctl, stats, track, d, rec, P) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  const out: any = { why: null }
  const sittingNow = () => { const dd = dragonOf(bot); return !!dd && SITTING.has(phaseOf(bot, dd)) }
  try {
    const fx = sitFix.get(d.id)
    if (!fx || !fx.sit) { out.why = 'нет сидячего состояния'; return out }
    const S = simClone(fx.sit)
    S.x = d.position.x; S.y = d.position.y; S.z = d.position.z; S.yRot = yRotOf(d.yaw)
    for (const pu of fx.pushes || []) { const q = blastPush(S, pu.centre, pu.seen); S.vx += q.x; S.vy += q.y; S.vz += q.z }
    S.hist = new Array(12).fill(S.y); S.inWall = false
    const nodes = dragonNodes(bot)
    const node = nodes && takeoffNode(nodes, S)
    if (!node) { out.why = 'узел взлёта не найден'; return out }
    const path = takeoffForecast(S, node, 4)
    const target = path[0].head
    const sitHead = simHead(S, true); const sitNeck = simNeck(S, true)
    const fcT = { n: 3, path: [{ k: 0, head: path[0].head, neck: path[0].neck, pos: path[0].pos, yRot: path[0].yRot }], sit: S, head: sitHead, neck: sitNeck }
    const sitP = predParts(fcT)
    const left = () => rec.t0 + 4950 - gameClock.now()
    if (left() < 2300) { out.why = `некогда (${left()} мс)`; return out }
    let plan = null; const why = {}
    for (const lift of [2, 1, 0]) {
      const all = []
      tsPlan(bot, target, { lift, fc: fcT, dpos: new Vec3(S.x, S.y, S.z) })
      for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) why[k] = (why[k] || 0) + v
      all.push(...(tsPlan.all || []))
      for (const c of all.sort((a, b) => a.cost - b.cost)) {
        const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
        if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { why['в сидячих коробках'] = (why['в сидячих коробках'] || 0) + 1; continue }
        const near = q => hurtNear(playerBox(q), sitP) || hurtNear(playerBox(q.offset(0, 1.3, 0)), sitP) || hurtNear(playerBox(q.offset(0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(-0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(0, 0, 0.5)), sitP) || hurtNear(playerBox(q.offset(0, 0, -0.5)), sitP)
        if (near(c.ground) || near(new Vec3(c.B.x + 0.5, c.G, c.B.z + 0.5))) { why['место ставки у шеи'] = (why['место ставки у шеи'] || 0) + 1; continue }
        if (!plan || c.cost < plan.cost) plan = c
        break
      }
    }
    out.plan = plan ? { H: [plan.H.x, plan.yb, plan.H.z], expect: plan.expect, dist: plan.dist, node: [node.x, node.z] } : { no: why }
    if (!plan) { out.why = 'нет станции'; return out }
    out.st = plan
    ctl.holdStation = true
    let b
    try { b = await tsBuild(session, ctl, stats, plan, () => (!sittingNow() ? 'взлетел' : null), null, { parts: () => partsOf(bot, dragonOf(bot), track) }) } finally { ctl.holdStation = false }
    if (!b.ok) { out.why = `стройка: ${b.why}`; return out }
    const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
    if (!hit) { out.why = 'бок не видно'; return out }
    await lookAtSafe(bot, hit.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    doing(ctl, 'oc:waitT1')
    const tw = gameClock.now()
    let took = false
    while (!ctl.aborted && gameClock.now() - tw < 4000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (ph === PHASE.TAKEOFF) { took = true; break }
      if (!SITTING.has(ph)) break
      await sleep(3)
    }
    out.wait = gameClock.now() - tw
    if (!took) { out.why = 'взлёта не дождался'; return out }
    const r = await bedsBoom(session, ctl, stats, { ...plan, reuse: true }, hit, 'взлёт', { aimed: true, uncounted: true, phCheck: p => p === PHASE.TAKEOFF, note: { oc: 'T1', headDist: plan.dist } })
    out.dmg = r.ok ? r.dmg : null
    if (r.ok) P.beds.push(r.dmg); else out.why = `щелчок: ${r.why}`
    return out
  } finally {
    const st = out.st
    delete out.st
    out.ms = gameClock.now() - t0
    ev('ocT1', out)
    const q = bot.entity.position
    if (st && Math.floor(q.y + 0.01) < st.G && Math.floor(q.x) === st.B.x && Math.floor(q.z) === st.B.z) { doing(ctl, 'oc:outT1'); await build.towerUp(bot, ctl, st.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

async function seeStation (session, ctl, stats, track, d, P, { cap = null }: any = {}) {
  const bot = session.bot
  const ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  const t0 = gameClock.now()
  const out: any = { cap }
  try {
    const fx = sitFix.get(d.id)
    const S = { x: d.position.x, y: d.position.y, z: d.position.z, yRot: yRotOf(d.yaw), yRotA: fx ? fx.yRotA : 0, vx: 0, vy: 0, vz: 0, hist: new Array(12).fill(d.position.y) }
    const head = simHead(S, true); const neck = simNeck(S, true)
    const fcS = { n: 0, path: [], sit: S, head, neck }
    const sitP = predParts(fcS)
    const ux = head.x - S.x; const uz = head.z - S.z; const ul = Math.hypot(ux, uz) || 1
    const cloud = { x: head.x + ux / ul * 2.5, z: head.z + uz / ul * 2.5 }
    const inCloud = p => Math.hypot(p.x - cloud.x, p.z - cloud.z) < 5.6
    const Ptop = podiumTop(bot)
    let plan = null; const why = {}
    for (const lift of [2, 1, 0]) {
      tsPlan(bot, head, { lift, fc: fcS, dpos: new Vec3(S.x, S.y, S.z) })
      for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) why[k] = (why[k] || 0) + v
      for (const c of (tsPlan.all || []).sort((a, b) => b.expect - a.expect)) {
        const no = k => { why[k] = (why[k] || 0) + 1 }
        if (c.psLift) { no('свой блок'); continue }
        if (Ptop != null && c.yb > Ptop - 1) { no('выше P − 1'); continue }
        if (cap != null && c.expect > cap) { no('больше потолка'); continue }
        const bb = { min: new Vec3(Math.min(c.F.x, c.H.x), c.yb, Math.min(c.F.z, c.H.z)), max: new Vec3(Math.max(c.F.x, c.H.x) + 1, c.yb + 1, Math.max(c.F.z, c.H.z) + 1) }
        if (overlap(bb, inflate(sitP.head, 0.05)) || overlap(bb, inflate(sitP.neck, 0.05)) || overlap(bb, inflate(sitP.body, 0.05))) { no('в сидячих коробках'); continue }
        const bG = new Vec3(c.B.x + 0.5, c.G, c.B.z + 0.5)
        // с запасом: тело прыгает (+1.25) и стоит на своём блоке; голова/шея бьют 10 (fin5-19: смерть у шеи)
        const near = q => hurtNear(playerBox(q), sitP) || hurtNear(playerBox(q.offset(0, 1.3, 0)), sitP) || hurtNear(playerBox(q.offset(0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(-0.5, 0, 0)), sitP) || hurtNear(playerBox(q.offset(0, 0, 0.5)), sitP) || hurtNear(playerBox(q.offset(0, 0, -0.5)), sitP)
        if (near(c.ground) || near(bG)) { no('у головы/шеи'); continue }
        if (inCloud(c.ground) || inCloud(bG)) { no('в облаке'); continue }
        if (!plan || c.expect - c.cost * 0.05 > plan.expect - plan.cost * 0.05) plan = c
        break
      }
    }
    out.plan = plan ? { H: [plan.H.x, plan.yb, plan.H.z], expect: plan.expect, dist: plan.dist, depth: plan.depth } : { no: why }
    if (!plan) { out.why = 'нет станции'; return out }
    out.st = plan
    const sittingSettled = () => { const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null; return !dd ? 'нет дракона' : !SITTING.has(ph) ? 'взлетел' : ph === PHASE.SCANNING ? 'высматривает' : null }
    ctl.holdStation = true
    let b
    try { b = await tsBuild(session, ctl, stats, plan, sittingSettled, null, { parts: () => partsOf(bot, dragonOf(bot), track) }) } finally { ctl.holdStation = false }
    if (!b.ok) { out.why = `стройка: ${b.why}`; return out }
    const hit = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), plan)
    if (!hit) { out.why = 'бок не видно'; return out }
    await lookAtSafe(bot, hit.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
    if (sittingSettled()) { out.why = sittingSettled(); return out }
    const r = await bedsBoom(session, ctl, stats, { ...plan, reuse: true }, hit, 'сидит', { aimed: true, until: Math.max(gameClock.now(), (stats.lastBoom || 0) + BED_GAP_MS), phCheck: p => SITTING.has(p) && p !== PHASE.SCANNING, note: { oc: cap != null ? 'SA' : 'SB', headDist: plan.dist } })
    if (r.ok) { out.dmg = r.dmg; P.beds.push(r.dmg) } else out.why = `щелчок: ${r.why}`
    return out
  } finally {
    const st = out.st
    delete out.st
    out.ms = gameClock.now() - t0
    ev('seeStation', out)
    const q = bot.entity.position
    if (st && Math.floor(q.y + 0.01) < st.G && Math.floor(q.x) === st.B.x && Math.floor(q.z) === st.B.z) { doing(ctl, 'see:out'); await build.towerUp(bot, ctl, st.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  }
}

export {
  ocLanding, ocOwnClick, ocTakeoffRun, ocT1, seeStation
}
