'use strict'
// Бой с драконом (dragon/pillar-run.ts): один цикл: посадка, свой клик, взлёт, первый тик, станция в виду.
// ocLanding — оркестр фаз посадки: состояние — объект oc (oc-plan.ts), план станции — oc-plan.ts, стройка и щелчки —
// oc-click.ts; фаза возвращает итог (false — отказ) или ничего (дальше по фазам).
import { gameClock, Vec3, overlap, playerBox, inflate, sleep, dragonOf, phaseOf, PHASE, build, EYE, SITTING, partsOf, clearControls, PHASE_RU, sitFix } from '../dig-down-to'
import { doing, r1, podiumTop, sight } from '../fall-guard'
import { lookAtSafe, hurtNear, simClone, simHead, simNeck, predParts, tsClickPoint } from '../evade-raw'
import { BED_GAP_MS, bedsBuild, bedClickPoint } from '../pillar-plan'
import { yRotOf, blastPush, dragonNodes, takeoffNode, takeoffForecast, tsPlan } from '../ts-plan'
import { sitRec } from './sight-zones'
import { bedsGo, bedsBoom } from './beds-act'
import { tsBuild, tsTrench } from './ts-build'
import { type OcLanding, ocGate, ocPlanL, ocPlanL0, ocPlanTk, ocPlanOwn } from './oc-plan'
import { ocBuildL, ocClickL0, ocWaitL, ocClickL } from './oc-click'

// Фазы посадки по порядку прежнего тела ocLanding.
const OC_PHASES: ((oc: OcLanding) => Promise<any>)[] = [
  ocGate, ocPlanL, ocPlanL0, ocPlanTk, ocPlanOwn, ocBuildL, ocClickL0, ocWaitL, ocClickL, ocAfter
]

async function ocLanding (session, ctl, rep, stats, track, feed, { blindLid = false }: any = {}) {
  const oc = { session, ctl, rep, stats, track, feed, blindLid, bot: session.bot } as OcLanding
  for (const phase of OC_PHASES) {
    const r = await phase(oc)
    if (r !== undefined) return r
  }
}

// После щелчка L: переждать «высматривает» видящего, из окопа на землю, свои станции A и B.
async function ocAfter (oc: OcLanding) {
  const { bot, ctl, session, stats, track } = oc
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
  if (Math.floor(q.y + 0.01) < oc.plan.G) { doing(ctl, 'oc:out'); await build.towerUp(bot, ctl, oc.plan.G - Math.floor(q.y + 0.01)).catch(() => {}); clearControls(bot) }
  if (oc.ownA) {
    const rA = await ocOwnClick(session, ctl, stats, oc.ownA, oc.fcA, track, { tag: 'A' })
    // B: построена на снижении — дойти и щёлкнуть; нет — построить сейчас (слепой сидит 99 тиков).
    if (rA && oc.ownB) await ocOwnClick(session, ctl, stats, oc.ownB, oc.fcA, track, { tag: 'B', build: !oc.ownB.built })
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
