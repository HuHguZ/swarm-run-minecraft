// Бастион (bastion()) — подход к бастиону издалека: цель (гуща известного золота вне дома брутов, место обзора, край),
// ход по сетке nether-route, закрытый штрек (с подходом пешком при неудаче), пешком под сторожем лавы. Итог — объект для
// немедленного возврата из bastion() или undefined (дошёл или подход не нужен).
import {
  log, sleep, gameClock, inLava, lavaEscape, lavaEscapeDeep, Vec3, fireRes, drinkFireRes, effectOn, goldWorn
} from './take-gold-block'
import { lavaWatched } from './booth-trade'
import { eatIfHungry } from './predict-gold'
import * as miningCycle from './mining-cycle'
import { approachGold } from './brute-risk'
import { burrow } from './defense'
import { type BastionRun, report } from './run'

// Подход издалека: общие для его частей значения (прежние const блока подхода в bastion()).
export interface Approach {
  KG0: any[]
  nearG0: any
  nearG: any
  goal: any
  V: any
  me0: any
  far1: number
  strict0: any
  routed: boolean
  NR: typeof import('.././nether-route')
  walkToward: typeof import('.././nether')['walkToward']
}

export async function approachSite (bx: BastionRun) {
  const { session, p, bot, st, mode, rec, memo } = bx
  // Дойти до бастиона (издалека — отрезками по Аду).
  const inOwnTunnel = !!(st.sealedState && st.sealedState.own && st.sealedState.own.has(`${Math.floor(bot.entity.position.x)},${Math.floor(bot.entity.position.y)},${Math.floor(bot.entity.position.z)}`))
  const nearMemo = !!memo && bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
  if (inOwnTunnel || nearMemo) log('подход не нужен', { inOwnTunnel, nearMemo })
  // Золото бастиона известно (карта копии этого мира — разрешено пользователем 30.09): цель подхода — гуще
  const KG0 = (p.knownGold || []).map(([x, y, z]) => ({ x, y, z }))
  const me00 = bot.entity.position
  const dens0 = g => KG0.filter(q => Math.abs(q.x - g.x) + Math.abs(q.y - g.y) + Math.abs(q.z - g.z) <= 6).length
  // Гуща золота сокровищницы — дом брутов (копия мира): цель подхода — гуща вне их зоны, если такая есть (S1d 07.10:
  // 4120… — 6 смертей от брута у входа 18,41,−115, цель подхода 18,37,−124 — в 9 бл. от его места). Остальное золото
  // берёт закрытый штрек (sealedGold — бруты его не видят) или пропускает routeGold.
  const KGa = approachGold(KG0, (require('.././nether-route') as typeof import('.././nether-route')).bruteSpots(session))
  const nearG0 = KGa.length ? KGa.reduce((a, b) => (dens0(b) > dens0(a) || (dens0(b) === dens0(a) && Math.hypot(b.x - me00.x, b.z - me00.z) < Math.hypot(a.x - me00.x, a.z - me00.z))) ? b : a) : null
  const needApproach = () => nearG0
    ? Math.hypot(nearG0.x - bot.entity.position.x, nearG0.z - bot.entity.position.z) > 12 || Math.abs(nearG0.y - bot.entity.position.y) > 8
    : bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) > 40
  if (mode !== 'barter' && rec && needApproach() &&
    miningCycle.needsKnownGoldApproach(bot.entity.position, nearG0, inOwnTunnel, nearMemo)) {
    return approachFar(bx, KG0, nearG0)
  }
}

async function approachFar (bx: BastionRun, KG0: any[], nearG0: any) {
  const { p, bot, st, rec } = bx
  const { walkToward }: typeof import('.././nether') = require('.././nether')
  // Подход по Аду — со строгим обходом лавы (session: шаг над обрывом к лаве — 1000, у лавы — 200):
  // pit-v2-14 и trip-9 30.09 — тело на подходе упало в лавовое озеро (y 24–31), одна смерть.
  const strict0 = bot._ndLavaStrict
  // Восстановить и при исключении из питья/штрека — во внешнем finally (ревью Codex 30.09).
  if (st.lavaStrict0 === undefined) st.lavaStrict0 = strict0
  bot._ndLavaStrict = true
  // Дальний путь (второй бастион): огнестойкость на дорогу, если зелий хватает (≥2 — одно остаётся).
  if ((p.tripSeconds || 0) > 0 && fireRes(bot) >= 2) { const fr = await drinkFireRes(bot).catch(() => null); log('в путь: огнестойкость', { fr, left: fireRes(bot) }) }
  // Издалека (второй бастион) — не в центр, а к краю: в 28 блоках не доходя, по горизонтали. У центра
  const me0 = bot.entity.position
  const far0 = Math.hypot(rec.x - me0.x, rec.z - me0.z)
  // Место обзора (vantage) из памяти — там вал бастиона виден с вышки (b2-15 30.09: 642,59,269 → стены
  // узнаны, 17 блоков); с края по прямой вышка слепла в толще незерака (trip2-11: basalt 0 ×3).
  const V = p.vantage || (rec && rec.vantage) || null
  // Золото бастиона известно (карта копии этого мира — разрешено пользователем 30.09): штрек — прямо к
  const nearG = nearG0
  const goal = nearG ? { x: nearG.x, y: nearG.y, z: nearG.z } : V ? { x: V.x, y: V.y ?? rec.y, z: V.z } : far0 > 200 ? { x: rec.x - (rec.x - me0.x) / far0 * 28, y: rec.y, z: rec.z - (rec.z - me0.z) / far0 * 28 } : rec
  // Штреком (tunnel.js), если далеко: пешком по Аду тело гибло (лавовое озеро у 103,31,80 — 4 смерти;
  const far1 = Math.hypot(goal.x - me0.x, goal.z - me0.z)
  // ND_NE_ROUTE=1 и сетка копии мира есть — к гуще золота одним планом (nether-route): мосты/спрыгивания по дороге,
  const NR: typeof import('.././nether-route') = require('.././nether-route')
  const a: Approach = { KG0, nearG0, nearG, goal, V, me0, far1, strict0, routed: false, NR, walkToward }
  const routedOut = await routeToGold(bx, a)
  if (routedOut) return routedOut
  await tunnelToGold(bx, a)
  await walkToSite(bx, a)
  const leftNow = nearG0 ? Math.hypot(nearG0.x - bot.entity.position.x, nearG0.z - bot.entity.position.z) : bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z))
  // Известное золото: штрек довёл на ~50 блоков, а дальше закрытого пути нет (вокруг двор и лава) —
  if (nearG0 ? leftNow > 72 : leftNow > 48) return report(bx, `до бастиона не дошёл: ${Math.round(leftNow)} блоков`)
}

// Сторож лавы: в лаве — оборвать ходьбу (свой ctl), выбраться, идти дальше.
async function walkLava (bx: BastionRun, a: Approach, ms, to = null) {
  const { session, ctl, bot, st, rec, deadline } = bx
  const { goal, V } = a
  const sub = { aborted: false, onAbort: [] as Array<() => void>, waitReflex: () => ctl.waitReflex?.() }
  const cut = () => { if (sub.aborted) return; sub.aborted = true; for (const fn of sub.onAbort) { try { fn() } catch {} } }
  const watch = gameClock.setInterval(() => { if (ctl.aborted || inLava(bot)) cut() }, 100)
  try { await a.walkToward(session, sub, to || goal, Math.min(deadline, gameClock.now() + ms), to ? { range: 8, xz: true } : goal === rec || V ? { range: V ? 4 : 6 } : { range: 6, xz: true }) } finally { gameClock.clearInterval(watch) }
  if (inLava(bot)) { try { bot.pathfinder.setGoal(null) } catch {} ; if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); st.lavaEscapes = (st.lavaEscapes || 0) + 1; return true }
  return false
}

// Ход по сетке копии (nether-route) к гуще известного золота: свои клетки пути — закрытому штреку, нужда в запасе — итогом.
export async function routeToGold (bx: BastionRun, a: Approach) {
  const { session, ctl, bot, st, deadline } = bx
  const { nearG, NR, goal, KG0, me0, far1 } = a
  if (nearG && NR.enabled() && NR.gridOf(session) && !ctl.aborted && (far1 > 12 || Math.abs(goal.y - me0.y) > 8)) {
    const xs = KG0.map(q => q.x); const ys = KG0.map(q => q.y); const zs = KG0.map(q => q.z)
    const zone = [Math.min(...xs) - 12, Math.min(...ys) - 6, Math.min(...zs) - 12, Math.max(...xs) + 12, Math.max(...ys) + 8, Math.max(...zs) + 12]
    const rStart = bot.entity.position.floored()
    const rr = await lavaWatched(bot, ctl, sub => NR.routeTo(session, sub, { x: goal.x, y: goal.y, z: goal.z, r: 4, dy: 3, zone, zoneExpo: 5, supplyReserve: true, timeoutSeconds: Math.max(60, Math.min(600, Math.round((deadline - gameClock.now()) / 1000) - 300)) }))
    log('к бастиону по сетке', { ok: rr.ok, why: rr.why, steps: rr.steps, dug: rr.dug, placed: rr.placed, plans: rr.plans, s: rr.seconds, at: rr.at })
    if (!ctl.aborted && rr.own?.size) {
      const SL: typeof import('.././sealed') = require('.././sealed')
      const own = new Set([...(st.sealedState?.own || []), ...rr.own])
      st.sealedState = { ...(st.sealedState || {}), own, exposed: SL.exposure(bot, own).length > 0,
        entry: st.sealedState?.entry || { x: rStart.x, y: rStart.y, z: rStart.z },
        dug: st.sealedState?.dug || 0, moves: st.sealedState?.moves || 0, fills: st.sealedState?.fills || 0,
        ores: st.sealedState?.ores || 0, bonusBlocks: st.sealedState?.bonusBlocks || 0,
        goldPassed: st.sealedState?.goldPassed || 0, plans: st.sealedState?.plans || 0,
        fails: st.sealedState?.fails || [], planMs: st.sealedState?.planMs || 0, walks: st.sealedState?.walks || 0 }
      try { (require('.././tunnel') as typeof import('.././tunnel')).rememberOwn(session, [...own]) } catch {}
    }
    if (rr.supplyNeeded && !ctl.aborted && session.bot === bot) {
      st.supplyNeeded = rr.supplyNeeded
      return report(bx, rr.why || 'нужно пополнить инструменты до продолжения подхода')
    }
    if (rr.ok && !ctl.aborted) {
      a.routed = true
      st.tunnel = { ok: true, route: true, steps: rr.steps, dug: rr.dug, at: rr.at }
    }
  }
}

// Без золотой брони — штреком и вблизи: пешком на виду у пиглинов — бой с ними (b0-5-1 14.10: «враги 8 не по силам»).
async function tunnelToGold (bx: BastionRun, a: Approach) {
  const { session, ctl, p, bot, st, rec, deadline } = bx
  const { nearG, goal, me0, far1 } = a
  if (!a.routed && (far1 > (st.goldless ? 12 : 40) || (nearG && (far1 > 12 || Math.abs(goal.y - me0.y) > 8))) && p.tunnel !== false) {
    // Вслепую — закрытым штреком по видимому (nether-cover.coveredTo): tunnelTo планирует по скрытому объёму (Codex q9).
    const NC: typeof import('.././nether-cover') = require('.././nether-cover')
    const tunnelTo = NC.blind() ? (s0, sub, g, o) => NC.coveredTo(s0, sub, g, { deadline: o.deadline, radius: o.radius }) : (require('.././tunnel') as typeof import('.././tunnel')).tunnelTo
    // Вход штрека подхода — клетка, откуда он начат: без него exitTunnel отвечал «входа нет», и после бастиона тело
    // оставалось в своём штреке под лавовым морем (neF-mB26-1 02.10: y 21, все шаги к спавнеру и порталу — на месте).
    let tStart = bot.entity.position.floored()
    const tOpts = () => ({ band: p.band ?? 40, radius: nearG ? 10 : 5, noBreachNear: rec ? { x: rec.x, z: rec.z, r: 48 } : null, deadline: Math.min(deadline - 240000, gameClock.now() + 90000 + far1 * 3000), log: (w, d) => log(w, d) })
    let tr = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts()))
    // Штрек не начался (тело на открытом, «со старта не войти»): закопаться и снова.
    if (!tr.ok && !tr.segs && (tr.dug || 0) < 8 && !ctl.aborted && process.env.ND_BURROW !== '0') {
      const bw = await burrow(session, ctl, st, 'штрек к бастиону не начался')
      if (bw.ok) { tStart = bot.entity.position.floored(); tr = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts())) } else log('закопаться не вышло', { why: bw.why })
    }
    st.tunnel = { ok: tr.ok, why: tr.why, segs: tr.segs, breach: tr.breach, detours: tr.detours, dug: tr.dug, crafted: tr.crafted, at: tr.at }
    log('штрек к бастиону', st.tunnel)
    // Дальше — тем же закрытым штреком: его клетки — «свои» для sealedGold (без «ко входу» пешком).
    if (nearG && tr.own && tr.own.size) st.sealedState = { own: tr.own, exposed: !!tr.exposed, entry: { x: tStart.x, y: tStart.y, z: tStart.z }, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
    // Известное золото, а штрек встал далеко («пути нет»: лавовые озёра по дороге — neF-map26-1 02.10: 145 бл. до
    for (let k = 0; k < 2 && nearG && !tr.ok && !ctl.aborted && gameClock.now() < deadline - 300000; k++) {
      const me1 = bot.entity.position
      const d1 = Math.hypot(nearG.x - me1.x, nearG.z - me1.z)
      if (d1 <= 60) break
      const mid = { x: Math.round(nearG.x - (nearG.x - me1.x) / d1 * 40), y: Math.round(me1.y), z: Math.round(nearG.z - (nearG.z - me1.z) / d1 * 40) }
      // Пешком по Аду — только под огнестойкостью (есть зелье — выпить): без неё подход ногами кончался лавой и
      if (st.fastSafe && !effectOn(bot, 'fire_resistance')) {
        if (fireRes(bot) >= 1) { const d = await drinkFireRes(bot).catch(e => e.message); for (let q = 0; q < 30 && !effectOn(bot, 'fire_resistance'); q++) await sleep(100); log('подход пешком: огнестойкость', { d, left: fireRes(bot) }) }
        // Без зелья — только недалеко (≤ 110 бл., строгий обход лавы): иначе тело стоит у портала весь прогон
        // (neF-T24-1 02.10: штрек и закопаться не начались на тонкой корке у портала, 84 бл. до золота).
        if (!effectOn(bot, 'fire_resistance') && d1 > 110) { log('подход пешком без огнестойкости — не иду', { left: Math.round(d1) }); break }
      }
      await walkLava(bx, a, 150000, mid)
      const d2 = Math.hypot(nearG.x - bot.entity.position.x, nearG.z - bot.entity.position.z)
      log('подход пешком к штреку', { k, from: { x: Math.round(me1.x), y: Math.round(me1.y), z: Math.round(me1.z) }, to: mid, left: Math.round(d2), was: Math.round(d1) })
      if (d2 > d1 - 16 && k > 0) break
      let tStart2 = bot.entity.position.floored()
      const tOpts2 = () => ({ band: p.band ?? 40, radius: 10, noBreachNear: rec ? { x: rec.x, z: rec.z, r: 48 } : null, deadline: Math.min(deadline - 240000, gameClock.now() + 90000 + d2 * 3000), log: (w, d) => log(w, d) })
      let tr2 = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts2()))
      if (!tr2.ok && !tr2.segs && (tr2.dug || 0) < 8 && !ctl.aborted && process.env.ND_BURROW !== '0') {
        const bw = await burrow(session, ctl, st, 'штрек после подхода не начался')
        if (bw.ok) { tStart2 = bot.entity.position.floored(); tr2 = await lavaWatched(bot, ctl, sub => tunnelTo(session, sub, goal, tOpts2())) } else log('закопаться не вышло', { why: bw.why })
      }
      st.tunnel = { ok: tr2.ok, why: tr2.why, segs: tr2.segs, breach: tr2.breach, detours: tr2.detours, dug: tr2.dug, crafted: tr2.crafted, at: tr2.at, walked: k + 1 }
      log('штрек к бастиону', st.tunnel)
      if (tr2.own && tr2.own.size) st.sealedState = { own: tr2.own, exposed: !!tr2.exposed, entry: { x: tStart2.x, y: tStart2.y, z: tStart2.z }, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
      if (tr2.ok) break
    }
  }
}

// Пешком под сторожем лавы (без известного золота: к бастиону, до трёх заходов); строгий обход лавы — вернуть.
async function walkToSite (bx: BastionRun, a: Approach) {
  const { session, ctl, p, bot, rec, deadline } = bx
  const { nearG, goal } = a
  try {
    const left = () => goal === rec ? bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) : Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z)
    // Вслепую без золотой вещи поверху не идём (d5-7-1 14.10: штрек «пути нет» → пешком над лавовым морем, падение с y 74).
    const openOk = !((require('.././nether-cover') as typeof import('.././nether-cover')).blind() && !goldWorn(bot))
    let again = openOk && !nearG && left() > (goal === rec ? 40 : 12) ? await walkLava(bx, a, 180000 + (p.tripSeconds || 0) * 1000) : false
    // Второй заход (бой по дороге, обрыв: booth-2 — «не дошёл: 76 блоков» за 38 с; вынырнули из лавы).
    for (let k = 0; k < 3 && openOk && !nearG && !ctl.aborted && (again || left() > (goal === rec ? 48 : 20)) && gameClock.now() < deadline - 300000; k++) {
      if ((bot.health ?? 20) < 12) await eatIfHungry(session, ctl)
      again = await walkLava(bx, a, 150000)
    }
  } finally { bot._ndLavaStrict = a.strict0 }
}
