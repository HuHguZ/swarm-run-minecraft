// Бастион (bastion()) — подготовка вызова: отладочные режимы сцен, броня и кирка, место и память между вызовами,
// защищённый бартер принесённым золотом, золото по памяти и план обзора. Итог функции — объект для немедленного
// возврата из bastion() или undefined (дальше).
import {
  log, mobs, xyz, goals, walkGoal, gameClock, GOLD_PICK, countOf, Vec3, fullCover, isBaby, clamp, worlds, PLACE, unpackGold,
  keyOf, centerGuess, vantagePoints, goldWorn, armGold
} from './take-gold-block'
import { tunnelTo, boothTrade, MEMO, barterRound, lavaWatched, barterTraders } from './booth-trade'
import { rememberStarts } from './sealed-gold'
import { buildTrap, prepareBarterCover } from './barter-site'
import { type BastionRun, report, memoSave } from './run'

// goto/trap/pit/booth/tunnel — отладка для сцен (scan — в самом bastion(), до этих режимов).
export async function debugRun (bx: BastionRun) {
  const { session, ctl, p, bot, st, mode } = bx
  // goto — отладка подхода pathfinder'ом (noMob — без обхода мобов, floor — пол Ада).
  if (mode === 'goto') {
    const f0 = bot._ndNetherFloor
    bot._ndNoMobAvoid = !!p.noMob
    if (p.floor) bot._ndNetherFloor = p.floor
    const pf = bot.pathfinder
    const th = pf && pf.thinkTimeout
    if (pf) pf.thinkTimeout = p.think || 12000
    const t0g = gameClock.now()
    let w
    try { w = await walkGoal(session, ctl, new goals.GoalNear(p.tx, p.ty, p.tz, p.range ?? 1), (p.seconds || 45) * 1000, { dig: !!p.dig }) } finally { bot._ndNoMobAvoid = false; bot._ndNetherFloor = f0; if (pf) pf.thinkTimeout = th }
    return { ...report(bx), goto: { ...w, s: Math.round((gameClock.now() - t0g) / 1000), at: xyz(bot.entity.position.floored()) } }
  }
  // booth — отладка окна бартера: тело уже стоит в клетке F, окно — F+d+1 (dx,dz), пиглины за ним (сцены).
  if (mode === 'trap') {
    // Отладка ловушки (сцены): ноги в H, пол пиглинов (их ноги) — на 3 выше наших ног, камера по d.
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const px = d[1]; const pz = d[0]
    const M = { x: f.x, y: f.y + 1, z: f.z }
    const C0 = { x: M.x + d[0], y: M.y, z: M.z + d[1] }
    const C2 = { x: C0.x + d[0], y: C0.y, z: C0.z + d[1] }
    const P = { x: f.x, y: f.y - 1, z: f.z }
    const bo = { kind: 'trap', O: C0, C0, C1: { x: C0.x, y: C0.y + 1, z: C0.z }, C2, M, R: { x: M.x, y: M.y + 1, z: M.z }, H: xyz(f), P, d, p: [px, pz], dump: null, F: P, W: M, C: xyz(f), sill: true }
    if (p.dump) bo.dump = { Dh: { x: f.x + px, y: f.y, z: f.z + pz }, D1: { x: P.x + px, y: P.y, z: P.z + pz }, D2: { x: P.x + px, y: P.y - 1, z: P.z + pz } }
    const S = { own: new Set([(require('.././sealed') as typeof import('.././sealed')).key(f.x, f.y, f.z), (require('.././sealed') as typeof import('.././sealed')).key(M.x, M.y, M.z)]), fails: [], deadline: gameClock.now() + 600000 }
    const built = await buildTrap(session, ctl, st, bo, S)
    if (!built) return { ...report(bx, 'ловушка не построилась: ' + S.fails.join('; ')), trap: bo }
    const r = await boothTrade(session, ctl, st, built, gameClock.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...report(bx), booth: r, trap: { baited: built.baited, C2: !!built.C2 } }
  }
  if (mode === 'pit') {
    // Отладка ямы (сцены): тело уже в яме, рот над головой (P+2), пиглины по d.
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const M = { x: f.x, y: f.y + 2, z: f.z }
    const bo = { kind: 'pit', P: xyz(f), H: { x: f.x, y: f.y + 1, z: f.z }, M, R: { x: M.x, y: M.y + 1, z: M.z }, O: { x: M.x + d[0], y: M.y, z: M.z + d[1] }, d, p: [d[1], d[0]], dump: null, F: xyz(f), W: M, C: { x: f.x, y: f.y + 1, z: f.z }, sill: true }
    if (p.dump) bo.dump = { Dh: { x: f.x + d[1], y: f.y + 1, z: f.z + d[0] }, D1: { x: f.x + d[1], y: f.y, z: f.z + d[0] }, D2: { x: f.x + d[1], y: f.y - 1, z: f.z + d[0] } }
    const r = await boothTrade(session, ctl, st, bo, gameClock.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...report(bx), booth: r }
  }
  if (mode === 'booth') {
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const bo = { F: xyz(f), C: { x: f.x + d[0], y: f.y, z: f.z + d[1] }, W: { x: f.x + d[0], y: f.y + 1, z: f.z + d[1] }, O: { x: f.x + 2 * d[0], y: f.y, z: f.z + 2 * d[1] }, d, sill: p.sill === false }
    const r = await boothTrade(session, ctl, st, bo, gameClock.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...report(bx), booth: r }
  }
  // tunnel — отладка своего штрека к клетке tx,ty,tz (сцены).
  if (mode === 'tunnel') return { ...report(bx), tunnel: await tunnelTo(session, ctl, new Vec3(p.tx, p.ty, p.tz), { maxSteps: p.maxSteps || 60 }) }
}

// Без золотой брони пиглины враждебны сами (PiglinAi.isWearingSafeArmor: хватит одной вещи), но целятся только видя нас
// (NEAREST_TARGETABLE_PLAYER_NOT_WEARING_GOLD — сенсор с лучом): закрытый штрек их не показывает. Поэтому без брони — не отказ
// (b0 14.10: бастион в 28 и 55 бл., «в бастион не иду» и 90 мин без добычи), а заход только закрытым штреком до первого золота
// (сундук, блок): броня из него — armGold, торг — после неё. Бартер с принесённым золотом без брони — прежний отказ.
export async function checkGear (bx: BastionRun) {
  const { session, ctl, p, bot, st, mode } = bx
  if (process.env.ND_BARTER_TRADER_MEMORY === '1') (require('./trader-memory') as typeof import('./trader-memory')).install(bot)
  if (!(await armGold(session, ctl))) {
    if (mode === 'barter' || !st.sealed) {
      return { ...report(bx, 'без золотой брони пиглины нападают сами (PiglinAi.isWearingSafeArmor: хватит одной вещи) — золотой шлем: 5 слитков'), need: { what: 'golden_helmet', count: 1, have: 0 } }
    }
    st.goldless = true
    log('бастион без золотой брони — только закрытым штреком до первого золота', { ingots: countOf(bot, 'gold_ingot'), nuggets: countOf(bot, 'gold_nugget') })
  }
  const needPick = mode !== 'barter' && !bot.inventory.items().some(i => GOLD_PICK.test(i.name))
  // Кирка сломалась, а золото в рюкзаке есть (≥ 18 слитков с блоками) — не выходить с ним: торговать
  const goldHave = countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block')
  // Нет железной кирки и золота мало — сперва сундуки бастиона (закрытым штреком, каменными кирками):
  if (needPick && !(st.sealed && goldHave >= 18) && !(st.sealed && p.chestsFirst !== false)) return { ...report(bx, 'золотой блок ломается только железной киркой и лучше (needs_iron_tool)'), need: { what: 'iron_pickaxe', count: 1, have: 0 } }
  if (needPick && goldHave >= 18) { st.noPick = true; log('бастион: железной кирки нет — только торг', { gold: goldHave }) } else if (needPick) { st.chestsOnly = true; log('бастион: железной кирки нет — сперва сундуки (железо)', { ironIngots: countOf(bot, 'iron_ingot'), raw: countOf(bot, 'raw_iron'), nuggets: countOf(bot, 'iron_nugget') }) }
}

// Место бастиона (параметр или журнал) и память между вызовами: узнанные стены, свои клетки, укрытие бартера.
export function restoreMemo (bx: BastionRun) {
  const { session, p, bot, st, mode } = bx
  const places = (session.journal.state && session.journal.state.places) || {}
  const rec = bx.rec = p.x !== undefined ? { x: p.x, y: p.y ?? 64, z: p.z } : places[PLACE]
  if (!rec && mode !== 'barter') return report(bx, 'бастион не знаю: mc_fortress в Аду записывает его («бастион (ад)»), когда видит кирпич чернокамня')
  // Память между вызовами (кампания зовёт bastion несколько раз): узнанные стены,
  const memoKey = bx.memoKey = rec ? `${Math.round(rec.x)},${Math.round(rec.z)}` : null
  let memo = bx.memo = memoKey && MEMO.get(memoKey)
  if ((process.env.ND_BASTION_TERRAIN_MEMORY === '1' || process.env.ND_SEALED_OPENING_MEMORY === '1') && memo &&
      (memo.owner !== bot || memo.dimension !== worlds.worldOf(bot))) memo = bx.memo = null
  if (memo && memo.owner === bot && memo.dimension === worlds.worldOf(bot)) {
    for (const key of memo.looted || []) st.looted.add(key)
  }
  if (!memo && memoKey && st.sealed && mode === 'barter') {
    const SL: typeof import('.././sealed') = require('.././sealed')
    const CM: typeof import('./cover-memory') = require('./cover-memory')
    const air = at => SL.classOf(bot.blockAt(new Vec3(at.x, at.y, at.z))) === SL.AIR
    const firm = at => fullCover(bot.blockAt(new Vec3(at.x, at.y, at.z)))
    const geometry = {
      site: memoKey, dimension: worlds.worldOf(bot), now: gameClock.wall.now(), position: bot.entity.position,
      air, firm, closed: own => CM.protectedGeometry(bot.entity.position, own, SL.exposure(bot, own), air, firm)
    }
    const near = bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    const restored = near && (CM.restoreCover(session.journal.state?.bastionCovers?.[memoKey], geometry) ||
      CM.recognizeCover((require('.././tunnel') as typeof import('.././tunnel')).ownSet(session), geometry))
    if (restored) {
      memo = bx.memo = { pred: new Map(), mined: new Set(), looted: new Set(), owner: bot, dimension: worlds.worldOf(bot), own: restored.own, entry: restored.entry,
        filled: new Set(), exposed: false, t: gameClock.now() }
      MEMO.set(memoKey, memo)
      log('защищённый бартер восстановлен', { site: memoKey, own: restored.own.size })
    }
  }
  if (st.sealed && memo && gameClock.now() - memo.t < 3600e3) {
    for (const [k, v] of memo.pred) if (!memo.mined.has(k)) st.pred.set(k, { ...v, pos: new Vec3(v.pos.x, v.pos.y, v.pos.z) })
    st.towered = 2
    st.sealedState = { own: memo.own, filled: memo.filled, exposed: memo.exposed, entry: memo.entry, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
    if (process.env.ND_SEALED_OPENING_MEMORY === '1') {
      Object.assign(st.sealedState, { openings: memo.openings, openingFacts: memo.openingFacts,
        openingRetry: memo.openingRetry, openingSkips: memo.openingSkips })
      for (const [k, until] of memo.openingSkips || []) if (until > gameClock.now()) st.skip.set(k, Math.max(st.skip.get(k) || 0, until))
    }
    const tradeOwn = mode === 'barter' && memo.own?.size > 0 && memo.entry &&
      bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    if (!st.pred.size || tradeOwn) st.sealedDone = true
  }
  if (st.noPick && st.sealed) {
    if (!st.sealedState) st.sealedState = { own: new Set(), exposed: true, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
    st.pred.clear()
    st.sealedDone = true
    st.towered = Math.max(st.towered || 0, 3)
  }
}

// Бартер принесённым золотом (mode barter, закрытый путь): подход по сетке к известному бастиону, защищённое укрытие,
// при малом риске — бартер на открытом.
export async function barterOnly (bx: BastionRun) {
  const { session, ctl, bot, st, rec, deadline, keep } = bx
  let near = rec && bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
  if (!near && rec && !ctl.aborted) {
    const NR: typeof import('.././nether-route') = require('.././nether-route')
    const seconds = Math.min(300, Math.floor((deadline - gameClock.now()) / 1000) - 180)
    if (!NR.enabled() || !NR.gridOf(session) || seconds < 20) {
      return { ...report(bx, 'к защищённому бартеру сначала нужен безопасный подход'), barterRetry: 'подход недоступен или бюджет исчерпан' }
    }
    const rr = await lavaWatched(bot, ctl, sub => NR.routeTo(session, sub,
      { x: rec.x, y: rec.y, z: rec.z, r: 12, dy: 8, solidFloor: true, timeoutSeconds: seconds, zoneExpo: 14,
        abortNear: { re: '^(piglin_brute|hoglin)$', r: 10 } }))
    st.tunnel = { ok: rr.ok, route: true, steps: rr.steps, dug: rr.dug, at: rr.at, why: rr.why }
    if (!ctl.aborted && session.bot === bot && rr.own?.size) {
      st.sealedState ||= { own: new Set(), filled: new Set(), exposed: true, dug: 0, moves: 0,
        fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
      for (const cell of rr.own) st.sealedState.own.add(cell)
      ;(require('.././tunnel') as typeof import('.././tunnel')).rememberOwn(session, rr.own)
    }
    log('к защищённому бартеру по сетке', st.tunnel)
    if (!rr.ok || ctl.aborted || session.bot !== bot) {
      return { ...report(bx, 'подход к защищённому бартеру не завершён'), barterRetry: rr.why || 'подход прерван' }
    }
    near = bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
  }
  if (process.env.ND_BARTER_VISIBLE_TRADERS === '1') barterTraders(bot, 64)
  const restored = near && await prepareBarterCover(session, ctl, st, Math.min(deadline - 85000, gameClock.now() + 60000))
  if (!restored || !restored.ok) {
    const refused = restored && restored.ok === false ? restored : undefined
    // Гибкость (решение пользователя 06.10): укрытие не встало — бартер на открытом, как у спидраннеров, когда риск мал: золото
    // на теле, хп ≥ 16, взрослые пиглины рядом; бруты/хоглины — отказ самого pearls.barter (bastionThreats). По std-прогонам
    // «укрытие не подтверждено» — 62 вызова с нулём сделок при золоте в рюкзаке. ND_OPEN_BARTER=0 — выкл.
    const carried = countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') - keep
    if (process.env.ND_OPEN_BARTER !== '0' && near && carried >= 8 && goldWorn(bot) && (bot.health ?? 0) >= 16 &&
      mobs(bot, 'piglin', 16).some(e => !isBaby(bot, e)) && !ctl.aborted && gameClock.now() < deadline - 60000) {
      if (countOf(bot, 'gold_ingot') - keep < carried) await unpackGold(session, ctl, carried)
      const n = countOf(bot, 'gold_ingot') - keep
      const ob: any = await barterRound(session, ctl, st, n, deadline - 30000).catch(e => ({ error: e.message }))
      st.lastBarter = 'на открытом'
      log('бартер на открытом (укрытие не встало)', { ingots: n, spent: ob && ob.spent, pearls: ob && ob.pearls, stopped: ob && (ob.stopped || ob.error), why: refused?.why })
      if (ob && ob.spent > 0) return { ...report(bx, ob.stopped ? 'бартер на открытом: ' + ob.stopped : null), openBarter: { spent: ob.spent, pearls: ob.pearls || 0 } }
    }
    return { ...report(bx, 'защищённое укрытие для бартера не подтверждено; выход к торговцам без укрытия запрещён'),
      barterRetry: refused?.why || 'далеко от известного бастиона', barterCover: refused?.diagnostic }
  }
  memoSave(bx)
}

// Золото и сундуки по памяти (карта копии мира — p.knownGold), гипотезы стартов обзора, план точек обзора.
export function loadMemory (bx: BastionRun) {
  const { p, bot, st, rec, mode } = bx
  if ((p.knownGold || []).length && !st.knownLoaded) {
    st.knownLoaded = true
    for (const [x, y, z] of p.knownGold) { const v = new Vec3(x, y, z); const b = bot.blockAt(v); if (b && b.name !== 'gold_block' && b.boundingBox === 'empty') continue; const k = keyOf(v); if (!st.pred.has(k)) st.pred.set(k, { pos: v, piece: 'память', rank: 0 }) }
    for (const [x, y, z] of (p.knownChests || [])) { const v = new Vec3(x, y, z); const k = keyOf(v); if (!st.chestSeen.has(k) && !st.looted.has(k)) st.chestSeen.set(k, { pos: v, seen: gameClock.now(), pred: true }) }
    st.towered = 3
    log('бастион по памяти', { gold: st.pred.size, chests: st.chestSeen.size })
  }
  // Гипотезы стартов из обзора fortress (Codex q10: fortress передавал p.starts, bastion их не читал) — цели G/C закрытого штрека.
  if (st.sealed && !st.noPick && !st.startsRemembered) {
    st.startsRemembered = true
    rememberStarts(bot, st, p.starts || rec?.starts)
    // Carried-gold mode must keep the cover confirmed by barterOnly.
    if ((process.env.ND_BARTER_CARRIED_PHASE !== '1' || mode !== 'barter') && (st.pred.size || st.chestSeen.size)) st.sealedDone = false
  }
  const center = bx.center = rec ? centerGuess(bot, rec) : bot.entity.position.floored()
  const points = bx.points = rec ? vantagePoints(center, center.box) : []
  log('план обзора', { center: { x: center.x, y: center.y, z: center.z }, box: center.box, points: points.length })
  bx.idle = 0
  bx.vantage = 0
  bx.barterWalks = 0
  bx.minedSinceRetry = false
}
