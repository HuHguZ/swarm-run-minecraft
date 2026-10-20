'use strict'
// Бой с драконом (dragon/pillar-run.ts): один цикл посадки (ocLanding) — стройка станции L, щелчок L0, ожидание мига
// и щелчок L (с крышкой окопа для слепого). Состояние — oc-plan.ts (OcLanding).
import { gameClock, Vec3, sleep, isSolid, dragonOf, phaseOf, PHASE, items, build, EYE, SITTING, PHASE_RU, pick, fillerItem } from '../dig-down-to'
import { doing, r1, sight } from '../fall-guard'
import { lookAtSafe, landingForecast, landingHits, tsClickPoint, anClickPoint } from '../evade-raw'
import { FACE_IDX } from '../ts-plan'
import { bedsBoom } from './beds-act'
import { tsBuild } from './ts-build'
import { type OcLanding } from './oc-plan'

export async function ocBuildL (oc: OcLanding) {
  const { bot, ctl, session, stats, feed } = oc

  oc.ev('ocPlan', { ms: gameClock.now() - oc.tPlan0, anchor: oc.plan.anchor || undefined, n: oc.fc.n, head: [r1(oc.tgt.x), r1(oc.tgt.y), r1(oc.tgt.z)], sitHead: [r1(oc.fc.head.x), r1(oc.fc.head.y), r1(oc.fc.head.z)], yRotA: r1(oc.fc.yRotA), H: [oc.plan.H.x, oc.plan.yb, oc.plan.H.z], lift: oc.plan.lift, depth: oc.plan.depth, dist: oc.plan.dist, seen: oc.plan.seen, expect: oc.plan.expect, u: [oc.plan.u.x, oc.plan.u.z], a: [oc.plan.a.x, oc.plan.a.z], no: oc.whyAll })
  doing(ctl, 'oc:build')
  // Опасно стоять там, где мы сейчас: коробки снижающегося по свежему прогнозу на ~1.5 с вперёд.
  const danger = () => {
    const dd = dragonOf(bot)
    const ph = dd ? phaseOf(bot, dd) : null
    if (ph !== PHASE.LANDING) return `фаза ${PHASE_RU[ph] ?? ph}`
    const f = feed.fc && feed.fc.id === oc.d.id ? feed.fc : oc.fc
    if (f.n - Math.round((gameClock.now() - f.t) / 50) < 8) return 'не успеть до посадки'
    const soon = { ...f, path: f.path.slice(0, 30) }
    const h = landingHits(soon, bot.entity.position, 0.5)
    return h ? `${h.what} через ${h.k} тиков` : null
  }
  ctl.holdStation = true
  let b
  const leftTicks = () => { const f = feed.fc && feed.fc.id === oc.d.id ? feed.fc : oc.fc; return f.n - Math.round((gameClock.now() - f.t) / 50) }
  try {
    if (!oc.ownA) b = await tsBuild(session, ctl, stats, oc.plan, danger, leftTicks)
    else {
      b = await tsBuild(session, ctl, stats, oc.plan, danger, leftTicks, { skipTrench: true })
      if (b.ok) {
        // A — пока до посадки ≥ 70 тиков; бросить, если меньше 45 (успеть в окоп L).
        if (leftTicks() >= 70) {
          const dangerA = () => (leftTicks() < 45 ? 'некогда (A)' : danger())
          const bA = await tsBuild(session, ctl, stats, oc.ownA, dangerA, leftTicks, { skipTrench: true })
          if (!bA.ok) { oc.ev('ocA', { fail: `стройка A: ${bA.why}` }); oc.ownA = null; oc.ownB = null }
          if (oc.ownB && leftTicks() >= 70) {
            const bB = await tsBuild(session, ctl, stats, oc.ownB, dangerA, leftTicks, { skipTrench: true })
            if (bB.ok) oc.ownB.built = true
            else { oc.ev('ocB', { fail: `стройка B: ${bB.why}` }); oc.ownB = null }
          }
        } else { oc.ev('ocA', { fail: 'некогда строить A' }); oc.ownA = null; oc.ownB = null }
        b = await tsBuild(session, ctl, stats, oc.plan, danger, leftTicks, { onlyTrench: true })
      }
    }
  } finally { ctl.holdStation = false }
  if (!b.ok) return oc.no(`стройка: ${b.why}`)
  stats.oc.built++
}

export async function ocClickL0 (oc: OcLanding) {
  const { bot, ctl, session, stats, feed } = oc
  // L0: щелчок за gapTicks тиков до L (прогноз — свежий).
  if (oc.plan.second && oc.plan.gapTicks >= 10) {
    const s2 = oc.plan.second
    const hit0 = tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), s2)
    if (hit0) {
      await lookAtSafe(bot, hit0.point)
      await new Promise<any>(resolve => bot.once('physicsTick', resolve))
      doing(ctl, 'oc:wait0')
      let t0c = 0; let last0 = oc.fc; let okWait = true
      for (;;) {
        if (ctl.aborted) return false
        const dd = dragonOf(bot)
        if (!dd || phaseOf(bot, dd) !== PHASE.LANDING) { okWait = false; break }
        const f2 = feed.fc && feed.fc.id === oc.d.id ? feed.fc : null
        if (f2) last0 = f2
        // До L0 дракон летит по прогнозу без толчка: тик L0 — i0 + 1 от пакета плана, сдвиг —
        // по свежему прогнозу того же (ещё не толкнутого) полёта.
        t0c = oc.plan.nPlan ? last0.t + 50 * (last0.n - oc.plan.nPlan + s2.i0 + 1) - 30 : last0.t + 50 * (last0.n - 2) - 30 - 50 * oc.plan.gapTicks
        if (t0c - gameClock.now() < 70) break
        await sleep(15)
      }
      if (okWait && t0c > gameClock.now() - 30) {
        const at0 = oc.plan.nPlan ? last0.path[last0.n - oc.plan.nPlan + s2.i0] : last0.path[last0.n - 3 - oc.plan.gapTicks]
        const hd0 = at0 ? r1(at0.head.distanceTo(s2.centre)) : null
        const b0 = await bedsBoom(session, ctl, stats, { ...s2, reuse: true }, hit0, 'снижение', { aimed: true, until: t0c, uncounted: true, phCheck: p => p === PHASE.LANDING, note: { headDist: hd0, oc: 'L0' } })
        stats.oc.L0 = stats.oc.L0 || []
        stats.oc.L0.push({ ok: b0.ok, dmg: b0.dmg, headDist: hd0 })
      } else oc.ev('ocL', { why: 'L0: не дождался' })
    } else oc.ev('ocL', { why: 'L0: бок не видно' })
  }
}

export async function ocWaitL (oc: OcLanding) {
  const { bot, ctl, feed } = oc
  oc.hitPt = oc.plan.anchor ? anClickPoint(bot, bot.entity.position.offset(0, EYE, 0), oc.plan) : tsClickPoint(bot, bot.entity.position.offset(0, EYE, 0), oc.plan)
  if (!oc.hitPt) return oc.no(oc.plan.anchor ? 'якорь из окопа не видно' : 'бок кровати из окопа не видно')
  await lookAtSafe(bot, oc.hitPt.point)
  await new Promise<any>(resolve => bot.once('physicsTick', resolve))
  // Ждать миг: прогноз по свежим пакетам; голова должна лечь у кровати.
  doing(ctl, 'oc:wait')
  oc.tClick = 0; oc.last = oc.fc
  for (;;) {
    if (ctl.aborted) return false
    const dd = dragonOf(bot)
    if (!dd) return false
    const ph = phaseOf(bot, dd)
    if (ph !== PHASE.LANDING) return oc.no(`фаза ${PHASE_RU[ph] ?? ph} до щелчка`)
    const f2 = landingForecast(feed, oc.P)
    if (f2) oc.last = f2
    const miss = oc.last.head.distanceTo(oc.refHead)
    if (miss > 1.2) return oc.no(`прогноз ушёл на ${r1(miss)}`)
    if (landingHits(oc.last, bot.entity.position, 0.2)) return oc.no('коробки дракона на месте')
    // Щелчок, обработанный после тика g + n − 2 (за два тика до посадки): опоздание на тик
    // — ещё снижение; на тик раньше «в самый раз» — уже сидит (урон в сидячий счёт; oc2-26).
    oc.tClick = oc.last.t + 50 * (oc.last.n - 2) - 55
    if (oc.tClick - gameClock.now() < 70) break
    await sleep(15)
  }
}

export async function ocClickL (oc: OcLanding) {
  const { bot, ctl, session, stats, blindLid } = oc
  const at = oc.last.path[oc.last.n - 3] || oc.last.path[oc.last.path.length - 1]
  const cen = oc.plan.centre
  const headDist = at ? r1(Math.hypot(at.head.x - cen.x, at.head.y - cen.y, at.head.z - cen.z)) : null
  // Первая посадка: сразу за L — крышка над головой к упору K (обработается через тик, до
  // тика посадки: первое «высматривает» спросит видимость — окоп закрыт, и дракон слепой навсегда).
  let lidSent = false
  const placeLid = async () => {
    const K = new Vec3(oc.plan.K.x, oc.plan.G, oc.plan.K.z)
    const face = new Vec3(-oc.plan.K.d.x, 0, -oc.plan.K.d.z)
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
    await lookAtSafe(bot, oc.hitPt.point)
    await new Promise<any>(resolve => bot.once('physicsTick', resolve))
  }
  const boom = await bedsBoom(session, ctl, stats, oc.plan, oc.hitPt, 'снижение', { aimed: true, until: oc.tClick, uncounted: true, phCheck: p => p === PHASE.LANDING, note: { headDist, n: oc.last.n, oc: 'L', lid: blindLid || undefined }, keepHand: blindLid, afterClick: blindLid ? placeLid : null })
  if (blindLid) {
    // Дождаться «высматривает» (запрос видимости — в тик посадки), потом вылезти.
    const lidPos = new Vec3(oc.plan.B.x, oc.plan.G, oc.plan.B.z)
    const t0 = gameClock.now(); let sat = 0; let roared = false
    while (!ctl.aborted && gameClock.now() - t0 < 4000) {
      const dd = dragonOf(bot); const ph = dd ? phaseOf(bot, dd) : null
      if (ph === PHASE.ROARING || ph === PHASE.FLAMING) { roared = true; break }
      if (SITTING.has(ph)) { if (!sat) sat = gameClock.now(); if (gameClock.now() - sat > 150) break }
      await sleep(20)
    }
    const lidUp = isSolid(bot.blockAt(lidPos))
    oc.ev('blind:lid', { sent: lidSent, lid: lidUp, sat: !!sat, roared })
    if (sat && lidUp && !roared && dragonOf(bot)) sight.set(dragonOf(bot).id + ':' + bot.entity.id, 'blind')
    if (lidUp) { await items.equipBestTool(bot, bot.blockAt(lidPos)); await build.withTimeout(bot.dig(bot.blockAt(lidPos), true), 3000).catch(() => {}) }
  }
  if (!boom.ok) return oc.no(`щелчок: ${boom.why}`)
  stats.oc.booms++
  stats.oc.L = stats.oc.L || []
  stats.oc.L.push({ dmg: boom.dmg, headDist, took: boom.ph })
  if (oc.tk && oc.plan.second) ctl.ocTk = { dId: oc.d.id, t: gameClock.now(), plan: { ...oc.plan, second: null }, T2: oc.tk.T2, A: oc.tk.A, path: oc.tk.path, S: oc.tk.S }
}
