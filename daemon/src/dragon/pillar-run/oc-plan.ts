'use strict'
// Бой с драконом (dragon/pillar-run.ts): один цикл посадки (ocLanding, oc.ts) — состояние и план станции у головы.
// Прежние let и стрелки замыкания ocLanding — поля объекта oc (OcLanding); фаза возвращает итог ocLanding (false — отказ)
// или ничего (дальше по фазам). Стройка и щелчки — oc-click.ts, оркестр и выход из окопа — oc.ts.
import { gameClock, Vec3, overlap, playerBox, inflate, FILLER_RE, dragonOf, EYE, box } from '../dig-down-to'
import { r1, podiumTop, sight } from '../fall-guard'
import { countOf, DRAD, virtualBot, exposure, landingForecast, bedDamage, hurtNear, simClone, predParts, tsClickPoint, DIRS4, blastReaches } from '../evade-raw'
import { pushedForecast, blastPush, dragonNodes, takeoffNode, takeoffForecast, tsPlan, tsSecond, tsOwnPlan, stationWorld, tsOwnStation } from '../ts-plan'
import { sitAcc } from './sight-zones'
import { bedsLayout } from './beds-plan'

export interface OcLanding {
  session: any
  ctl: any
  rep: any
  stats: any
  track: any
  feed: any
  blindLid: boolean
  bot: any
  P: number
  fc: any
  anchorsOk: boolean
  d: any
  ev: (k: any, o: any) => void
  no: (w: any) => false
  tPlan0: number
  tgt: any
  plan: any
  whyAll: any
  cands: any[]
  refHead: any
  tk: any
  fcA: any
  ownA: any
  ownB: any
  hitPt: any
  tClick: number
  last: any
}

// Есть ли прогноз посадки, заряды и дракон (прежнее начало ocLanding).
export async function ocGate (oc: OcLanding) {
  const { bot, ctl, stats, feed, blindLid } = oc
  oc.P = podiumTop(bot)
  oc.fc = landingForecast(feed, oc.P)
  if (!oc.fc || oc.fc.n < 40 || oc.fc.n > 190) { if (ctl.trace) ctl.trace.ev('ocL', { why: oc.fc ? `n ${oc.fc.n}` : 'нет прогноза', blindLid: blindLid || undefined }); return false }
  // Режим «видящий» (ND_SEE=1): на первой посадке L нет — окоп спрятал бы нас от первого
  // «высматривает», и дракон остался бы слепым навсегда (Sensing не чистится).
  if (process.env.ND_SEE === '1' && !blindLid) {
    const dd0 = dragonOf(bot)
    if (dd0 && !sight.get(dd0.id + ':' + bot.entity.id)) { if (ctl.trace) ctl.trace.ev('ocL', { why: 'видящий: первая посадка без L', n: oc.fc.n }); return false }
  }
  oc.anchorsOk = process.env.ND_OC_ANCHOR !== '0' && !blindLid && countOf(bot, /^respawn_anchor$/) >= 1 && countOf(bot, /^glowstone$/) >= 1
  if ((countOf(bot, /_bed$/) < 2 && !oc.anchorsOk) || countOf(bot, FILLER_RE) < 3) return false
  oc.d = dragonOf(bot)
  if (!oc.d) return false
  oc.ev = (k, o) => { if (ctl.trace) ctl.trace.ev(k, o) }
  stats.oc = stats.oc || { tries: 0, built: 0, booms: 0, why: {} }
  oc.no = w => { stats.oc.why[w] = (stats.oc.why[w] || 0) + 1; oc.ev('ocL', { why: w, n: oc.fc.n }); return false }
  stats.oc.tries++
}

// Станция L у головы снижающегося: кровать на 1–2 выше земли или якорь.
export async function ocPlanL (oc: OcLanding) {
  const { bot, blindLid } = oc
  oc.tPlan0 = gameClock.now()
  oc.tgt = (oc.fc.path[oc.fc.n - 3] || oc.fc.path[oc.fc.path.length - 1]).head
  oc.plan = null
  oc.whyAll = {}
  oc.cands = []
  // Кровать на блок или два выше земли (на два — центр взрыва у самой головы; кровать не
  // должна попасть в коробки головы/шеи на пути снижения — проверка в tsPlan: oc3-22).
  for (const lift of [2, 1]) {
    if (countOf(bot, /_bed$/) < 1) break
    const p2 = tsPlan(bot, oc.tgt, { lift, fc: oc.fc, dpos: new Vec3(oc.fc.sit.x, oc.fc.sit.y, oc.fc.sit.z), lid: blindLid })
    for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) oc.whyAll[k] = (oc.whyAll[k] || 0) + v
    oc.cands.push(...(tsPlan.all || []))
    if (p2 && (!oc.plan || p2.cost < oc.plan.cost)) oc.plan = p2
  }
  // Якорь возрождения (есть в рюкзаке): прямо на путь головы — взрыв ближе (до ~0.5 от низа головы).
  if (oc.anchorsOk) {
    let pa = null
    for (const lift of [3, 2, 1]) {
      const p3 = tsPlan(bot, oc.tgt, { lift, fc: oc.fc, dpos: new Vec3(oc.fc.sit.x, oc.fc.sit.y, oc.fc.sit.z), anchor: true })
      for (const [k, v] of (Object.entries(tsPlan.why || {}) as [string, any][])) oc.whyAll['я:' + k] = (oc.whyAll['я:' + k] || 0) + v
      if (p3 && (!pa || p3.cost < pa.cost)) pa = p3
    }
    if (pa && (!oc.plan || pa.expect > oc.plan.expect + 3)) oc.plan = pa
  }
  tsPlan.why = oc.whyAll
  if (!oc.plan) { oc.ev('ocNoPlan', { no: tsPlan.why }); return oc.no('нет станции у головы') }
}

export async function ocPlanL0 (oc: OcLanding) {
  const { bot, blindLid } = oc
  // Вторая кровать снижения (L0) с другой стороны того же окопа — за ≥ 10 тиков до L.
  oc.refHead = oc.fc.head
  if (process.env.ND_OC_L0 === '1' && !blindLid && oc.fc.n >= 60) {
    const dpos = new Vec3(oc.fc.sit.x, oc.fc.sit.y, oc.fc.sit.z)
    const P = podiumTop(bot)
    const seenKeys = new Set()
    const top = oc.cands.sort((p, q) => p.cost - q.cost).filter(c => { const k = `${c.B.x},${c.B.z}`; if (seenKeys.has(k)) return false; seenKeys.add(k); return true }).slice(0, 3)
    let bestPair = null; const why0 = {}
    const note = k => { why0[k] = (why0[k] || 0) + 1 }
    for (const c of top) {
      const sides = DIRS4.filter(d2 => !(d2.x === c.u.x && d2.z === c.u.z))
      const s2 = tsSecond(bot, c, oc.fc, { dpos, sides })
      for (const [k, v] of (Object.entries(tsSecond.why || {}) as [string, any][])) why0[k] = (why0[k] || 0) + v
      if (!s2) continue
      const fc2 = pushedForecast(oc.fc, s2.i0, s2.centre, s2.seen || 1, P)
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
    oc.ev('ocPlan0', bestPair ? { i0: bestPair.s2.i0, n: oc.fc.n, n2: bestPair.fc2.n, H0: [bestPair.s2.H.x, bestPair.s2.yb, bestPair.s2.H.z], L0: bestPair.s2.expect, H: [bestPair.L2.H.x, bestPair.L2.yb, bestPair.L2.H.z], L: bestPair.L2.expect, alone: oc.plan.expect, push: [r1(bestPair.fc2.pushed.x * 100) / 100, r1(bestPair.fc2.pushed.y * 100) / 100, r1(bestPair.fc2.pushed.z * 100) / 100] } : { no: why0, tried: top.length })
    if (bestPair && bestPair.sum > oc.plan.expect + 25) {
      oc.plan = bestPair.L2; oc.plan.second = bestPair.s2; oc.plan.gapTicks = (bestPair.fc2.n - 2) - (bestPair.s2.i0 + 1); oc.plan.nPlan = oc.fc.n
      oc.refHead = bestPair.fc2.head
    }
  }
}

export async function ocPlanTk (oc: OcLanding) {
  const { bot, blindLid } = oc
  // Взлёт слепого (сам, на 99-м тике после посадки — без толчка B): голова первые ~15 тиков
  oc.tk = null
  if (process.env.ND_OC_TK === '1' && !blindLid && sight.get(oc.d.id + ':' + bot.entity.id) === 'blind') {
    const why1 = {}
    const n1 = k => { why1[k] = (why1[k] || 0) + 1 }
    const fcL = pushedForecast(oc.fc, oc.fc.n - 3, oc.plan.centre, oc.plan.seen || 1, oc.P)
    if (!fcL) n1('посадка после L не считается')
    else if (hurtNear(playerBox(oc.plan.ground), predParts(fcL)) || hurtNear(playerBox(new Vec3(oc.plan.B.x + 0.5, oc.plan.G, oc.plan.B.z + 0.5)), predParts(fcL))) n1('станция L у шеи сидящего (T1 заново не поставить)')
    else {
      const A = bedsLayout(bot, oc.d, predParts(fcL), { headAt: fcL.head, noTurn: true, brave: true, cap: 46 })
      const S = simClone(fcL.sit)
      if (A) { const pu = blastPush(S, A.centre, A.seen != null ? A.seen : 1); S.vx += pu.x; S.vy += pu.y; S.vz += pu.z }
      S.hist = new Array(12).fill(S.y)
      const nodes = dragonNodes(bot)
      const node = nodes && takeoffNode(nodes, S)
      if (!node) n1('узел взлёта не найден')
      else {
        const path = takeoffForecast(S, node, 30)
        const t1 = path[1]
        const t1exp = bedDamage(t1.head.distanceTo(oc.plan.centre), oc.plan.seen || 1)
        const sides = DIRS4.filter(q => !(q.x === oc.plan.u.x && q.z === oc.plan.u.z))
        const T2 = tsSecond(bot, oc.plan, { n: 99, path }, { dpos: new Vec3(S.x, S.y, S.z), sides, imin: 11, imax: 18, primaryFirst: true })
        if (!T2) Object.assign(why1, tsSecond.why || {})
        else {
          // Клетки станции T2 (кровать, опора, заслон) не на пути снижения (checkWalls снесёт) и
          // переживут взрыв A (A — сидя, до T1/T2).
          const cells = [{ x: T2.F.x, y: T2.yb, z: T2.F.z }, { x: T2.H.x, y: T2.yb, z: T2.H.z }, ...T2.sCells.map(y => ({ x: T2.F.x, y, z: T2.F.z })), ...T2.wCells.map(y => ({ x: T2.W.x, y, z: T2.W.z }))]
          let onPath = false
          for (const st of oc.fc.path) {
            const boxes = [inflate(box(st.head.x, st.head.y, st.head.z, 0.5, 1), 0.2), inflate(box(st.neck.x, st.neck.y, st.neck.z, 1.5, 3), 0.2), inflate(box(st.pos.x + Math.sin(st.yRot * DRAD) * 0.5, st.pos.y, st.pos.z - Math.cos(st.yRot * DRAD) * 0.5, 2.5, 3), 0.2)]
            if (cells.some(c => boxes.some(b => overlap(b, { min: new Vec3(c.x, c.y, c.z), max: new Vec3(c.x + 1, c.y + 1, c.z + 1) })))) { onPath = true; break }
          }
          const ex = new Map(oc.plan.world)
          for (const y of T2.sCells) ex.set(`${T2.F.x},${y},${T2.F.z}`, 'block')
          for (const y of T2.wCells) ex.set(`${T2.W.x},${y},${T2.W.z}`, 'block')
          ex.set(`${T2.F.x},${T2.yb},${T2.F.z}`, 'bed'); ex.set(`${T2.H.x},${T2.yb},${T2.H.z}`, 'bed')
          if (onPath) n1('станция T2 на пути снижения')
          else if (A && blastReaches(virtualBot(bot, ex), bot, A.centre, cells)) n1('взрыв A заденет станцию T2')
          else oc.tk = { A, T2, path, node, t1exp, sum: t1exp + T2.expect, S }
        }
      }
    }
    oc.ev('ocTk', oc.tk ? { node: [oc.tk.node.x, oc.tk.node.z], A: oc.tk.A ? oc.tk.A.expect : null, T1: oc.tk.t1exp, T2: oc.tk.T2.expect, i2: oc.tk.T2.i0, H2: [oc.tk.T2.H.x, oc.tk.T2.yb, oc.tk.T2.H.z] } : { no: why1 })
    if (oc.tk && oc.tk.sum < 70) oc.tk = null
    if (oc.tk) { oc.plan.second = oc.tk.T2 }
  }
}

export async function ocPlanOwn (oc: OcLanding) {
  const { bot, blindLid } = oc
  // Кровать A заранее в СВОЁМ окопе у головы сидящего (слепой: голова сидящего не поворачивается):
  // после L — к окопу A, щелчок через ≥ 10 тиков после L, в сидячий счёт (≤ cap). Темп спидраннеров:
  oc.fcA = null
  oc.ownA = null
  oc.ownB = null
  if (process.env.ND_OC_A === '1' && !blindLid && !oc.plan.second && oc.fc.n >= 120 && sight.get(oc.d.id + ':' + bot.entity.id) === 'blind') {
    oc.fcA = pushedForecast(oc.fc, oc.fc.n - 3, oc.plan.centre, oc.plan.seen || 1, oc.P)
    if (oc.fcA) {
      const acc = sitAcc.id === oc.d.id ? sitAcc.dmg : 0
      const cap = acc < 25 ? 49 - acc : null
      const tA = gameClock.now()
      oc.ownA = tsOwnPlan(bot, oc.plan, oc.fcA, { cap, dpos: new Vec3(oc.fcA.sit.x, oc.fcA.sit.y, oc.fcA.sit.z) })
      oc.ev('ocA', oc.ownA ? { ms: gameClock.now() - tA, H: [oc.ownA.H.x, oc.ownA.yb, oc.ownA.H.z], B: [oc.ownA.B.x, oc.ownA.G, oc.ownA.B.z], depth: oc.ownA.depth, expect: oc.ownA.expect, dist: r1(oc.ownA.centre.distanceTo(oc.fcA.head)), seen: oc.ownA.seen, cap, acc: r1(acc) } : { ms: gameClock.now() - tA, no: tsOwnPlan.why, cap, acc: r1(acc) })
      // B — тоже свой окоп у головы сидящего, без потолка (её взрыв поднимет на взлёт); цела после
      // взрывов L и A, её окоп не в их воронках.
      if (oc.ownA && process.env.ND_OC_B !== '0') {
        const tB = gameClock.now()
        const world = stationWorld(oc.ownA, stationWorld(oc.plan, oc.plan.world))
        oc.ownB = tsOwnStation(bot, oc.fcA.head, { fc: { ...oc.fcA, n: oc.fcA.n + 3 }, dpos: new Vec3(oc.fcA.sit.x, oc.fcA.sit.y, oc.fcA.sit.z), world, priors: [oc.plan, oc.ownA], avoid: [oc.plan, oc.ownA], sitP: predParts(oc.fcA) })
        if (oc.ownB) oc.ownB.role = 'B'
        oc.ev('ocB', oc.ownB ? { ms: gameClock.now() - tB, H: [oc.ownB.H.x, oc.ownB.yb, oc.ownB.H.z], B: [oc.ownB.B.x, oc.ownB.G, oc.ownB.B.z], depth: oc.ownB.depth, expect: oc.ownB.expect, dist: r1(oc.ownB.centre.distanceTo(oc.fcA.head)), seen: oc.ownB.seen } : { ms: gameClock.now() - tB, no: tsOwnStation.why })
      }
    } else oc.ev('ocA', { no: { 'посадка после L не считается': 1 } })
  }
}
