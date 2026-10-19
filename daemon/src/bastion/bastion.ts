const { digBooth, mergeTrades, exitTunnel, towerScan, routeGold }: typeof import('./tower-scan') = require('./tower-scan')
const { log, sleep, xyz, mobs, seesMob, goals, walkGoal, gameClock, reachSet, threatens, takeGoldBlock, inLava, lavaEscape, lavaEscapeDeep, GOLD_PICK, makeIronPick, countOf, Vec3, fullCover, isBaby, pickUp, BF, waitWatched, clamp, fireRes, worlds, PLACE, unpackGold, drinkFireRes, effectOn, keyOf, centerGuess, vantagePoints, goldWorn, armGold, nearestTrader, survey, nextTarget, lootChest, dropJunk }: typeof import('./take-gold-block') = require('./take-gold-block')
const { walkUnlessBrute, tunnelTo, boothTrade, MEMO, exitReserveReady, barterRound, DAMAGE_TYPES, lavaWatched, ownTunnelAt }: typeof import('./booth-trade') = require('./booth-trade')
const { trade: penTrade }: typeof import('./pen-trap') = require('./pen-trap')
const { eatIfHungry, scanPiecesAsync, predictGoldAsync }: typeof import('./predict-gold') = require('./predict-gold')
const miningCycle: typeof import('./mining-cycle') = require('./mining-cycle')
const { goldMode }: typeof import('./gold-mode') = require('./gold-mode')
const { nearBruteHome, pitsAwayFromBrutes, approachGold, bruteHomeTake, pitAngerWait, targetsByBruteHome, bruteWalkRisk, goldWindowOk }: typeof import('./brute-risk') = require('./brute-risk')
const { bruteDefense, goldExposes, hunker, burrowColumn, burrow, answerAttack, sealBody }: typeof import('./defense') = require('./defense')
const { planView, rememberStarts, sealedGold, digToPredicted, digToPredictedBody }: typeof import('./sealed-gold') = require('./sealed-gold')
const { digTrap, buildTrap, prepareBarterCover, digPit, moveBarterSite }: typeof import('./barter-site') = require('./barter-site')
async function bastion (session, ctl, p: any = {}) {
  const bot = session.bot
  try { (require('.././ne-guard') as typeof import('.././ne-guard')).swatInstall(bot) } catch {}
  try { (require('.././ne-guard') as typeof import('.././ne-guard')).attach(session) } catch {}
  goldMode.fastSafe = p.fastSafe === true || process.env.ND_GOLD_FAST_SAFE === '1'
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 400, 30, 1800) * 1000 - 5000
  const mode = p.mode || 'auto'
  const wantPearls = p.pearls ?? 12
  const wantFire = p.fireRes ?? 3
  // Обсидиан на раму выхода у крепости Края (кампания ND_SH_NETHER: 10 на раму) — тоже цель бартера (вес 40/469, по 1).
  const wantObs = p.obsidian ?? 0
  // Слитки про запас не держим: без золотой брони на теле bastion не идёт (wearGold ниже), а
  // 8 оставленных — это 8 сделок, ~0.5 жемчуга (ревью Codex 29.09: 153 → 145 обменов).
  const keep = p.keep ?? 0
  const st: any = {
    gold: new Map(), chestSeen: new Map(), skip: new Map(), looted: new Set(),
    blocks: 0, bribed: 0, traded: 0, chests: [], fights: [], barters: [], gained: {}, tossed: [], brutes: 0,
    visited: new Set(), lastBlocked: null, bruteSeen: new Map(), bricks: new Map(), been: [],
    pred: new Map(), towered: 0, predWrong: 0, predMiss: 0,
    // outside — подход к стене снаружи (внешние грани шаблона): на ферме пока
    // не лучше подхода через двор, поэтому по параметру (route-10/11 против 6).
    outside: !!p.outside || !!p.high,
    high: !!p.high,
    // sealed — золото закрытым штреком (sealedGold), без обхода двора.
    sealed: p.sealed !== false,
    fastSafe: goldMode.fastSafe,
    // breach — второй план закрытого штрека со вскрытием у входа и у целей (ND_SEALED_BREACH=1 у кампании; 02.10, мерка идёт)
    breach: !!p.breach || process.env.ND_SEALED_BREACH === '1',
    lootChests: p.chests !== false,
    hitBrutes: !!p.hitBrutes
  }
  const out = (stopped = null) => {
    const d: any = {
      mode,
      seconds: Math.round((gameClock.now() - t0) / 1000),
      goldBlocksDug: st.blocks,
      bribed: st.bribed,
      ingotsTraded: st.traded,
      chests: st.chests,
      gained: st.gained,
      bag: { gold_ingot: countOf(bot, 'gold_ingot'), gold_block: countOf(bot, 'gold_block'), ender_pearl: countOf(bot, 'ender_pearl'), fire_res: fireRes(bot), obsidian: countOf(bot, 'obsidian'), string: countOf(bot, 'string'), fire_charge: countOf(bot, 'fire_charge') },
      goldSeenLeft: [...st.gold.keys()].length,
      predLeft: st.pred.size,
      ...(st.fastSafe ? { knownGoldLeft: (p.knownGold || []).filter(a => {
        const b = bot.blockAt(new Vec3(...(a as [number, number, number]))); return !b || b.name === 'gold_block'
      }).length } : {}),
      predWrong: st.predWrong || undefined,
      predMiss: st.predMiss || undefined,
      towered: st.towered || undefined,
      sealed: st.sealedState ? { dug: st.sealedState.dug, moves: st.sealedState.moves, fills: st.sealedState.fills, ores: st.sealedState.ores, plans: st.sealedState.plans, planMs: st.sealedState.planMs, walks: st.sealedState.walks, exposed: st.sealedState.exposed, fails: st.sealedState.fails.slice(-6), goldPickups: st.sealedState.goldPickups } : undefined,
      goldNuggets: countOf(bot, 'gold_nugget') || undefined,
      pit: st.pit || undefined,
      pitTrade: st.pitTrade || undefined,
      barterRetry: BF.enabled() && st.barterRetry ? st.barterRetry : undefined,
      barterPlans: st.plans && st.plans.length ? st.plans.slice(-6) : undefined,
      hurts: st.hurts && st.hurts.length ? st.hurts : undefined,
      exit: st.exit || undefined,
      fights: st.fights.length ? st.fights : undefined,
      brutesAvoided: st.brutes || undefined,
      tossed: st.tossed.length ? st.tossed : undefined,
      lastBlocked: st.lastBlocked || undefined,
      entryRoute: st.entryRoute || undefined,
      goldless: st.goldless || undefined
    }
    if (st.supplyNeeded) d.supplyNeeded = st.supplyNeeded
    if (stopped) d.stopped = stopped
    d.note = `Золотых блоков ${st.blocks}, сундуков ${st.chests.filter(c => !c.error && !c.stopped).length}, слитков пиглинам ${st.traded}. ` +
      `В рюкзаке: жемчуг ${d.bag.ender_pearl}, огнестойкость ${d.bag.fire_res}, слитков ${d.bag.gold_ingot} (+${d.bag.gold_block} блоков), обсидиан ${d.bag.obsidian}, нить ${d.bag.string}.`
    if (st.ironNeed) d.need = { what: 'iron_pickaxe', count: 1, have: 0 }
    return d
  }

  if (worlds.worldOf(bot) !== 'the_nether') return out('бастионы — в Аду; сначала mc_portal mode=enter')
  // scan — только посмотреть: видимые сундуки и узнанные по ним куски (сцены).
  if (mode === 'scan') return { ...out(), scan: await scanPiecesAsync(bot, p.radius || 48, ctl) }
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
    return { ...out(), goto: { ...w, s: Math.round((gameClock.now() - t0g) / 1000), at: xyz(bot.entity.position.floored()) } }
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
    if (!built) return { ...out('ловушка не построилась: ' + S.fails.join('; ')), trap: bo }
    const r = await boothTrade(session, ctl, st, built, gameClock.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...out(), booth: r, trap: { baited: built.baited, C2: !!built.C2 } }
  }
  if (mode === 'pit') {
    // Отладка ямы (сцены): тело уже в яме, рот над головой (P+2), пиглины по d.
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const M = { x: f.x, y: f.y + 2, z: f.z }
    const bo = { kind: 'pit', P: xyz(f), H: { x: f.x, y: f.y + 1, z: f.z }, M, R: { x: M.x, y: M.y + 1, z: M.z }, O: { x: M.x + d[0], y: M.y, z: M.z + d[1] }, d, p: [d[1], d[0]], dump: null, F: xyz(f), W: M, C: { x: f.x, y: f.y + 1, z: f.z }, sill: true }
    if (p.dump) bo.dump = { Dh: { x: f.x + d[1], y: f.y + 1, z: f.z + d[0] }, D1: { x: f.x + d[1], y: f.y, z: f.z + d[0] }, D2: { x: f.x + d[1], y: f.y - 1, z: f.z + d[0] } }
    const r = await boothTrade(session, ctl, st, bo, gameClock.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...out(), booth: r }
  }
  if (mode === 'booth') {
    const f = bot.entity.position.floored()
    const d = [p.dx || 0, p.dz || 0]
    const bo = { F: xyz(f), C: { x: f.x + d[0], y: f.y, z: f.z + d[1] }, W: { x: f.x + d[0], y: f.y + 1, z: f.z + d[1] }, O: { x: f.x + 2 * d[0], y: f.y, z: f.z + 2 * d[1] }, d, sill: p.sill === false }
    const r = await boothTrade(session, ctl, st, bo, gameClock.now() + clamp(p.seconds ?? 60, 10, 600) * 1000, { keep: p.keep ?? 0 })
    return { ...out(), booth: r }
  }
  // tunnel — отладка своего штрека к клетке tx,ty,tz (сцены).
  if (mode === 'tunnel') return { ...out(), tunnel: await tunnelTo(session, ctl, new Vec3(p.tx, p.ty, p.tz), { maxSteps: p.maxSteps || 60 }) }
  // Без золотой брони пиглины враждебны сами (PiglinAi.isWearingSafeArmor: хватит одной вещи), но целятся только видя нас
  // (NEAREST_TARGETABLE_PLAYER_NOT_WEARING_GOLD — сенсор с лучом): закрытый штрек их не показывает. Поэтому без брони — не отказ
  // (b0 14.10: бастион в 28 и 55 бл., «в бастион не иду» и 90 мин без добычи), а заход только закрытым штреком до первого золота
  // (сундук, блок): броня из него — armGold, торг — после неё. Бартер с принесённым золотом без брони — прежний отказ.
  if (!(await armGold(session, ctl))) {
    if (mode === 'barter' || !st.sealed) {
      return { ...out('без золотой брони пиглины нападают сами (PiglinAi.isWearingSafeArmor: хватит одной вещи) — золотой шлем: 5 слитков'), need: { what: 'golden_helmet', count: 1, have: 0 } }
    }
    st.goldless = true
    log('бастион без золотой брони — только закрытым штреком до первого золота', { ingots: countOf(bot, 'gold_ingot'), nuggets: countOf(bot, 'gold_nugget') })
  }
  const needPick = mode !== 'barter' && !bot.inventory.items().some(i => GOLD_PICK.test(i.name))
  // Кирка сломалась, а золото в рюкзаке есть (≥ 18 слитков с блоками) — не выходить с ним: торговать
  const goldHave = countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block')
  // Нет железной кирки и золота мало — сперва сундуки бастиона (закрытым штреком, каменными кирками):
  if (needPick && !(st.sealed && goldHave >= 18) && !(st.sealed && p.chestsFirst !== false)) return { ...out('золотой блок ломается только железной киркой и лучше (needs_iron_tool)'), need: { what: 'iron_pickaxe', count: 1, have: 0 } }
  if (needPick && goldHave >= 18) { st.noPick = true; log('бастион: железной кирки нет — только торг', { gold: goldHave }) } else if (needPick) { st.chestsOnly = true; log('бастион: железной кирки нет — сперва сундуки (железо)', { ironIngots: countOf(bot, 'iron_ingot'), raw: countOf(bot, 'raw_iron'), nuggets: countOf(bot, 'iron_nugget') }) }

  const places = (session.journal.state && session.journal.state.places) || {}
  const rec = p.x !== undefined ? { x: p.x, y: p.y ?? 64, z: p.z } : places[PLACE]
  if (!rec && mode !== 'barter') return out('бастион не знаю: mc_fortress в Аду записывает его («бастион (ад)»), когда видит кирпич чернокамня')
  // Память между вызовами (кампания зовёт bastion несколько раз): узнанные стены,
  const memoKey = rec ? `${Math.round(rec.x)},${Math.round(rec.z)}` : null
  let memo = memoKey && MEMO.get(memoKey)
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
      memo = { pred: new Map(), mined: new Set(), looted: new Set(), owner: bot, dimension: worlds.worldOf(bot), own: restored.own, entry: restored.entry,
        filled: new Set(), exposed: false, t: gameClock.now() }
      MEMO.set(memoKey, memo)
      log('защищённый бартер восстановлен', { site: memoKey, own: restored.own.size })
    }
  }
  if (st.sealed && memo && gameClock.now() - memo.t < 3600e3) {
    for (const [k, v] of memo.pred) if (!memo.mined.has(k)) st.pred.set(k, { ...v, pos: new Vec3(v.pos.x, v.pos.y, v.pos.z) })
    st.towered = 2
    st.sealedState = { own: memo.own, filled: memo.filled, exposed: memo.exposed, entry: memo.entry, dug: 0, moves: 0, fills: 0, ores: 0, bonusBlocks: 0, goldPassed: 0, plans: 0, fails: [], planMs: 0, walks: 0 }
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
  const memoSave = () => {
    if (!memoKey || !st.sealed || !st.sealedState) return
    const old = memo || { pred: new Map(), mined: new Set() }
    for (const [k, v] of st.pred) old.pred.set(k, { rank: v.rank, piece: v.piece, pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z } })
    for (const [k] of old.pred) if (!st.pred.has(k)) { const b = bot.blockAt(new Vec3(...(k.split(',').map(Number) as [number, number, number]))); if (b && b.name !== 'gold_block') old.mined.add(k) }
    MEMO.set(memoKey, { pred: old.pred, mined: old.mined, looted: new Set(st.looted), owner: bot, dimension: worlds.worldOf(bot), own: st.sealedState.own, filled: st.sealedState.filled, exposed: st.sealedState.exposed, entry: st.sealedState.entry, t: gameClock.now() })
    const CM: typeof import('./cover-memory') = require('./cover-memory')
    const feet = bot.entity.position.floored()
    const current = st.sealedState.own.has(`${feet.x},${feet.y},${feet.z}`) &&
      st.sealedState.own.has(`${feet.x},${feet.y + 1},${feet.z}`) ? feet : st.sealedState.entry
    const record = CM.coverRecord(memoKey, worlds.worldOf(bot), gameClock.wall.now(), st.sealedState.own, current)
    if (record && session.journal.patch) session.journal.patch(state => { state.bastionCovers = CM.storeCover(state.bastionCovers, record) })
  }

  if (mode === 'barter' && st.sealed) {
    let near = rec && bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    if (!near && rec && !ctl.aborted) {
      const NR: typeof import('.././nether-route') = require('.././nether-route')
      const seconds = Math.min(300, Math.floor((deadline - gameClock.now()) / 1000) - 180)
      if (!NR.enabled() || !NR.gridOf(session) || seconds < 20) {
        return { ...out('к защищённому бартеру сначала нужен безопасный подход'), barterRetry: 'подход недоступен или бюджет исчерпан' }
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
        return { ...out('подход к защищённому бартеру не завершён'), barterRetry: rr.why || 'подход прерван' }
      }
      near = bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) < 96
    }
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
        if (ob && ob.spent > 0) return { ...out(ob.stopped ? 'бартер на открытом: ' + ob.stopped : null), openBarter: { spent: ob.spent, pearls: ob.pearls || 0 } }
      }
      return { ...out('защищённое укрытие для бартера не подтверждено; выход к торговцам без укрытия запрещён'),
        barterRetry: refused?.why || 'далеко от известного бастиона', barterCover: refused?.diagnostic }
    }
    memoSave()
  }

  const spare = () => countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') - keep
  // Огнестойкость — плюс, не цель копки (решение пользователя 06.10 22:33): за неё отдаётся уже добытое золото (оно оплачено),
  // но ни копки, ни ожидания ради неё (барьер-модель: слиток стоит 2.4 с торга + 2.5 с копки, FR даёт 0.034 на слиток).
  const done = () => countOf(bot, 'ender_pearl') >= wantPearls && (fireRes(bot) >= wantFire || spare() <= 0) && countOf(bot, 'obsidian') >= wantObs && exitReserveReady(bot, p)
  // Сколько слитков нужно на цели (таблица бартера 1.21.11): жемчуг 0.064 на
  const goldTarget = () => p.gold ?? Math.min(BF.enabled() ? 480 : 240, Math.max(
    BF.enabled() ? BF.pearlBudget(wantPearls - countOf(bot, 'ender_pearl')) : Math.ceil(Math.max(0, wantPearls - countOf(bot, 'ender_pearl')) / 0.064),
    Math.ceil(Math.max(0, wantObs - countOf(bot, 'obsidian')) / (40 / 469)),
    // Нет огня: 34 сделки дают >=95% хотя бы одного fire_charge (40/469).
    !exitReserveReady(bot, p) && !(require('.././nether') as typeof import('.././nether')).exitKit(bot).lighter ? 34 : 0))
  // Пакет копки — от модели бартера S3 (core/barter-model.barterPlan через barter-flow.plan): при известном золоте бастиона
  // (st.pred — карта копии или узнанные стены) копать пакет B* = √(2·S·E[копки]/c) и торговать, а не всё «на 85 % жемчуга» сразу.
  // Модель считается на начало пакета (gold 0: добытое ещё не в рюкзаке), её строка — в лог и в итог (detail.plans).
  st.round = 0
  let batchRound = -1
  const batch = () => {
    if (batchRound === st.round) return st.batch
    batchRound = st.round
    const tr = st.pitTrade || {}
    const d = BF.plan({ pearls: countOf(bot, 'ender_pearl'), required: wantPearls, gold: 0, siteIngots: st.pred.size * 9,
      delivered: tr.barterDelivered, thrown: tr.barterReceipts,
      ...(st.traded ? { traded: { ingots: st.traded, seconds: tr.seconds || 0 } } : {}),
      fireRes: { have: fireRes(bot), want: wantFire, valueSeconds: 120 } })
    st.batch = d.action === 'mine' ? Math.max(9, d.batch) : 9
    ;(st.plans ||= []).push({ round: st.round, action: d.action, batch: d.batch, eSeconds: Math.round(d.eSeconds), pReach: Math.round(d.pReach * 100) / 100, why: d.why })
    log(d.line, { round: st.round, site: st.pred.size * 9, pearls: countOf(bot, 'ender_pearl'), want: wantPearls, spare: spare(), batch: st.batch })
    return st.batch
  }
  st.stopMining = () => mode !== 'gold' && spare() >= (BF.enabled() && st.pred.size && p.gold == null ? batch() : BF.enabled() ? Math.min(144, goldTarget()) : goldTarget())
  if (BF.enabled()) st.fastSafe = true
  // Золоту — не больше 60% вызова: остальное — бартер (прогон 2 лаборатории
  // ходил по точкам обзора все 500 с, и на обмен не осталось ни секунды).
  let goldPhaseEnd = mode === 'gold' ? deadline : t0 + (deadline - t0) * 0.6
  let barterNext = 0
  // Без брони: после каждой добычи — броня из неё; пока её нет, ни торга, ни хода по двору.
  const goldReady = async () => {
    if (!st.goldless) return true
    if (!(await armGold(session, ctl))) return false
    st.goldless = false
    log('золотая броня из добычи бастиона — дальше как обычно', { ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') })
    return true
  }
  const piglinsAround = () => mobs(bot, 'piglin', 16).filter(e => !isBaby(bot, e) && seesMob(bot, e))
  const tryBarter = async (force = false) => {
    if (mode === 'gold' || done() || gameClock.now() < barterNext) return false
    if (!(await goldReady())) return false
    if (!force && spare() < 24) return false
    if (countOf(bot, 'gold_ingot') - keep < 8 && countOf(bot, 'gold_block')) await unpackGold(session, ctl, keep + 27)
    const can = countOf(bot, 'gold_ingot') - keep
    if (can <= 0 || !piglinsAround().length) return false
    const r = await barterRound(session, ctl, st, Math.min(can, 24), deadline)
    log('бартер', { spent: r.spent, handed: r.handed, thrown: r.thrown, stopped: r.stopped, gained: r.gained, s: r.seconds })
    barterNext = gameClock.now() + (r.spent > 0 ? 1500 : 20000)
    if (!(r.spent > 0)) st.lastBarter = r.stopped || 'пиглины не берут'
    return r.spent > 0
  }

  // Кто и чем бьёт (damage_event: тип урона из реестра 1.21.11, причина) — с позицией, хп и
  // блоками вокруг: урон 20→5 за секунды у свалки ямы (pit-dump 30.09) остался без объяснения.
  st.hurts = []
  let lastHp = bot.health ?? 20
  const onDmg = pk => {
    if (!pk || pk.entityId !== bot.entity.id || st.hurts.length >= 40) return
    const f = bot.entity.position
    const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
    const cause = id => { const e = bot.entities[id]; return e ? (e.name || e.username || e.type) : (id >= 0 ? '#' + id : null) }
    const src = bot.entities[(pk.sourceCauseId ?? 0) - 1]
    const rel = src && src.position ? [+(src.position.x - f.x).toFixed(2), +(src.position.y - f.y).toFixed(2), +(src.position.z - f.z).toFixed(2)] : null
    const rec = { t: Math.round((gameClock.now() - t0) / 1000), type: DAMAGE_TYPES[pk.sourceTypeId] || pk.sourceTypeId, by: cause((pk.sourceCauseId ?? 0) - 1), rel, hpBefore: Math.round(lastHp), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], feet: nm(f), under: nm(f.offset(0, -0.5, 0)), head: nm(f.offset(0, 1.6, 0)), doing: st.doing || null }
    st.hurts.push(rec)
    log('урон', rec)
  }
  const onHp = () => { lastHp = bot.health ?? lastHp }
  bot._client.on('damage_event', onDmg)
  const toolFilter0 = bot._ndToolFilter
  bot._ndToolFilter = (require('.././tunnel') as typeof import('.././tunnel')).makeToolFilter(bot, false)
  bot.on('health', onHp)
  try {
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
      // Сторож лавы: в лаве — оборвать ходьбу (свой ctl), выбраться, идти дальше.
      const walk = async (ms, to = null) => {
        const sub = { aborted: false, onAbort: [] as Array<() => void>, waitReflex: () => ctl.waitReflex?.() }
        const cut = () => { if (sub.aborted) return; sub.aborted = true; for (const fn of sub.onAbort) { try { fn() } catch {} } }
        const watch = gameClock.setInterval(() => { if (ctl.aborted || inLava(bot)) cut() }, 100)
        try { await walkToward(session, sub, to || goal, Math.min(deadline, gameClock.now() + ms), to ? { range: 8, xz: true } : goal === rec || V ? { range: V ? 4 : 6 } : { range: 6, xz: true }) } finally { gameClock.clearInterval(watch) }
        if (inLava(bot)) { try { bot.pathfinder.setGoal(null) } catch {} ; if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); st.lavaEscapes = (st.lavaEscapes || 0) + 1; return true }
        return false
      }
      // Штреком (tunnel.js), если далеко: пешком по Аду тело гибло (лавовое озеро у 103,31,80 — 4 смерти;
      const far1 = Math.hypot(goal.x - me0.x, goal.z - me0.z)
      // ND_NE_ROUTE=1 и сетка копии мира есть — к гуще золота одним планом (nether-route): мосты/спрыгивания по дороге,
      let routed = false
      const NR: typeof import('.././nether-route') = require('.././nether-route')
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
          return out(rr.why || 'нужно пополнить инструменты до продолжения подхода')
        }
        if (rr.ok && !ctl.aborted) {
          routed = true
          st.tunnel = { ok: true, route: true, steps: rr.steps, dug: rr.dug, at: rr.at }
        }
      }
      // Без золотой брони — штреком и вблизи: пешком на виду у пиглинов — бой с ними (b0-5-1 14.10: «враги 8 не по силам»).
      if (!routed && (far1 > (st.goldless ? 12 : 40) || (nearG && (far1 > 12 || Math.abs(goal.y - me0.y) > 8))) && p.tunnel !== false) {
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
          await walk(150000, mid)
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
      try {
        const left = () => goal === rec ? bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z)) : Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z)
        // Вслепую без золотой вещи поверху не идём (d5-7-1 14.10: штрек «пути нет» → пешком над лавовым морем, падение с y 74).
        const openOk = !((require('.././nether-cover') as typeof import('.././nether-cover')).blind() && !goldWorn(bot))
        let again = openOk && !nearG && left() > (goal === rec ? 40 : 12) ? await walk(180000 + (p.tripSeconds || 0) * 1000) : false
        // Второй заход (бой по дороге, обрыв: booth-2 — «не дошёл: 76 блоков» за 38 с; вынырнули из лавы).
        for (let k = 0; k < 3 && openOk && !nearG && !ctl.aborted && (again || left() > (goal === rec ? 48 : 20)) && gameClock.now() < deadline - 300000; k++) {
          if ((bot.health ?? 20) < 12) await eatIfHungry(session, ctl)
          again = await walk(150000)
        }
      } finally { bot._ndLavaStrict = strict0 }
      const leftNow = nearG0 ? Math.hypot(nearG0.x - bot.entity.position.x, nearG0.z - bot.entity.position.z) : bot.entity.position.distanceTo(new Vec3(rec.x, rec.y, rec.z))
      // Известное золото: штрек довёл на ~50 блоков, а дальше закрытого пути нет (вокруг двор и лава) —
      if (nearG0 ? leftNow > 72 : leftNow > 48) return out(`до бастиона не дошёл: ${Math.round(leftNow)} блоков`)
    }
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
      if (st.pred.size || st.chestSeen.size) st.sealedDone = false
    }
    const center = rec ? centerGuess(bot, rec) : bot.entity.position.floored()
    const points = rec ? vantagePoints(center, center.box) : []
    log('план обзора', { center: { x: center.x, y: center.y, z: center.z }, box: center.box, points: points.length })
    let idle = 0
    let vantage = 0
    let barterWalks = 0
    let minedSinceRetry = false
    const miningSnapshot = () => ({ goldBlocks: st.blocks, chests: st.chests.length,
      dug: st.sealedState?.dug || 0, ownCells: st.sealedState?.own.size || 0, gold: spare() })
    while (!ctl.aborted && gameClock.now() < deadline - 12000) {
      if (inLava(bot)) { if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); continue }
      if ((bot.health ?? 20) < 8) return out(`хп ${Math.round(bot.health)} — ухожу лечиться`)
      await eatIfHungry(session, ctl)
      if (await answerAttack(session, ctl, st)) continue
      if (await bruteDefense(session, ctl, st)) continue
      if (mode !== 'gold' && done()) break
      if (st.sealed && mode !== 'barter' && (require('.././nether-cover') as typeof import('.././nether-cover')).blind() && !st.entryDone) {
        const entry = await (require('./entry-route') as typeof import('./entry-route')).approach(session, ctl, st, deadline)
        if (entry.handled) {
          st.entryRoute = { ok: entry.ok, start: entry.start, entry: entry.entry, why: entry.why }
          if (entry.ok && entry.start) {
            st.entryDone = true
            st.pred.clear(); st.pieces = []
            for (const [k,c] of st.chestSeen) if (c.pred) st.chestSeen.delete(k)
            rememberStarts(bot, st, [entry.start])
            st.sealedDone = false
          } else if (entry.progress) continue
          else return out(entry.why || 'housing: второго вида или закрытого пути к стене пока нет')
        }
      }
      // Закрытый путь: после золота — торговое окно из штрека, потом штреком назад.
      if (st.sealed && st.sealedState && st.sealedDone && !st.pitDone) {
        st.pitDone = true
        if (mode !== 'gold' && !done() && (spare() > 0 || countOf(bot, 'gold_block')) && await goldReady()) {
          // Яма со ртом (добыча падает к нам); не вышла — окно в стене.
          let bo = null
          for (let tryN = 0; tryN < (BF.enabled() ? 2 : 6) && !bo && !ctl.aborted && gameClock.now() < deadline - 90000; tryN++) {
            if (tryN && BF.enabled()) {
              if (!(await moveBarterSite(session, ctl, st, p, deadline - 60000))) break
            }
            if (tryN && !BF.enabled()) {
              // Тело стоит не в своём ходе (ход по сетке к золоту кончился у двора: план ямы — «пути нет», 9 узлов:
              // D2-21 03.10 — 19 золотых блоков в рюкзаке, бартера не было вовсе) — закопаться в толщу и искать снова.
              if (tryN <= 2 && process.env.ND_GOLD_ROUTE === '1' && !ownTunnelAt(bot, st.sealedState)) {
                const bw = await burrow(session, ctl, st, 'бартер: места нет').catch(e => ({ ok: false, why: e.message }))
                log('бартер: закопался', { ok: bw && bw.ok, why: bw && bw.why })
                if (bw && bw.ok) continue
              }
              st.doing = 'жду место'; log('бартер: места нет — жду', { try: tryN, pigs: mobs(bot, 'piglin', 40).length })
              const w = await waitWatched(session, ctl, 15000)
              if (w) log('бартер: ждать не вышло', { why: w, hp: Math.round(bot.health ?? 0) })
            }
            bo = p.trade === 'trap' ? await digTrap(session, ctl, st, deadline - 85000) : null
            if (!bo && p.trade !== 'booth') bo = await digPit(session, ctl, st, deadline - 85000)
            // Окно — только по просьбе (trade:'booth' или boothFallback): доставка у окна 0–41% (pit-v2-1
            // 30.09: 41 слиток — один бросок пиглина). Ямы нет — золото остаётся в рюкзаке до другого места.
            if (!bo && ((!BF.enabled() && tryN >= 1 && p.boothFallback !== false) || p.trade === 'booth')) bo = await digBooth(session, ctl, st, deadline - 85000)
          }
          if (bo) {
            st.pit = { kind: bo.kind || 'booth', at: bo.F, window: bo.W, dump: !!bo.dump, catch: bo.catch, pigs: bo.pigs, brutes: bo.brutes, sealed: bo.sealed, baited: bo.baited }
            st.pitTrade = await (bo.kind === 'pit' ? penTrade : boothTrade)(session, ctl, st, bo, deadline - 5000, { keep, done })
            log(bo.kind === 'trap' ? 'ловушка: бартер' : bo.kind === 'pit' ? 'яма: бартер' : 'окно: бартер', st.pitTrade)
            // Яма не работает (приманки не берут, нет бросков) — другая яма, до двух раз.
            const notWorking = t => t && (t.stopped === 'яма не работает' || t.stopped === 'яма не доносит' || /не подходят|страж изменил место|ушёл из места/.test(t.stopped || ''))
            for (let k = 0; k < 2 && bo.kind === 'pit' && notWorking(st.pitTrade) && countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') >= 18 && !ctl.aborted && gameClock.now() < deadline - 150000; k++) {
              const S2 = st.sealedState
              ;(S2.badPits || (S2.badPits = new Set())).add((require('.././sealed') as typeof import('.././sealed')).key(bo.M.x, bo.M.y, bo.M.z))
              log('яма не работает — другая', { at: bo.P, tossed: st.pitTrade.tossed, seconds: st.pitTrade.seconds })
              if (BF.enabled() && !(await moveBarterSite(session, ctl, st, p, deadline - 60000))) break
              const bo2 = await digPit(session, ctl, st, deadline - 85000)
              if (!bo2) break
              bo = bo2
              st.pits = [...(st.pits || [st.pit]), { kind: bo.kind, at: bo.F, catch: bo.catch, pigs: bo.pigs, sealed: bo.sealed }]
              const r2 = await penTrade(session, ctl, st, bo, deadline - 5000, { keep, done })
              log('яма: бартер', r2)
              st.pitTrade = mergeTrades(st.pitTrade, r2)
            }
          } else {
            st.lastBarter = 'ни ямы, ни окна'
            if (BF.enabled()) st.barterRetry = 'нет защищённого места у торговцев'
            // ND_OPEN_BARTER=1: ни ямы, ни окна, а золото есть — бартер на открытом, как у спидраннеров (золотая броня, брутов и
            // хоглинов в 24 нет): D7b-32 03.10 — 15 золотых блоков, 0 сделок, бастион «выработан».
            if (!BF.enabled() && process.env.ND_OPEN_BARTER === '1' && !ctl.aborted && goldWorn(bot) && countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') >= 9 &&
              ![...mobs(bot, 'piglin_brute', 24), ...mobs(bot, 'hoglin', 24)].length && gameClock.now() < deadline - 60000) {
              await unpackGold(session, ctl, 9 * countOf(bot, 'gold_block') + countOf(bot, 'gold_ingot'))
              const n = countOf(bot, 'gold_ingot')
              const ob = await barterRound(session, ctl, st, n, deadline - 40000).catch(e => ({ error: e.message }))
              st.lastBarter = 'на открытом'
              log('бартер на открытом', { ingots: n, spent: ob && ob.spent, pearls: ob && ob.pearls, stopped: ob && (ob.stopped || ob.error) })
            }
          }
          // ND_PEARL_PICK=1: жемчуг, брошенный мимо ямы (D6-21 03.10: 108 слитков, брошено 4 жемчуга, доставка 0.58 — в
          // рюкзаке 0), — ходом по сетке (двор втридорога, брут в 10 — бросить) к каждому в 14 бл. и подобрать.
          if (bo && process.env.ND_PEARL_PICK === '1' && !ctl.aborted) {
            const NR: typeof import('.././nether-route') = require('.././nether-route')
            const isPearl = e => { try { const d = e.getDroppedItem && e.getDroppedItem(); return !!d && d.name === 'ender_pearl' } catch { return false } }
            const pk = { seen: 0, went: 0, got: 0 }
            const p0 = countOf(bot, 'ender_pearl')
            for (let k = 0; k < 5 && NR.enabled() && NR.gridOf(session) && !ctl.aborted && gameClock.now() < deadline - 60000; k++) {
              const me = bot.entity.position
              const its: any = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(me) < 14 && e.position.distanceTo(me) > 1.3).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
              if (!k) pk.seen = its.length
              if (!its.length || mobs(bot, 'piglin_brute', 16).length) break
              const g = its[0].position.floored()
              pk.went++
              const rr: Partial<import('.././nether-route').NetherRouteResult> = await NR.routeTo(session, ctl, { x: g.x, y: g.y, z: g.z, r: 1, dy: 1, zones: undefined, zoneExpo: 14, abortNear: { re: '^(piglin_brute|hoglin)$', r: 10 }, timeoutSeconds: 45 }).catch(e => ({ ok: false, why: e.message }))
              for (const c of (rr.own || [])) { if (st.sealedState && st.sealedState.own) st.sealedState.own.add(c) }
              await pickUp(bot, ctl, 3, 2500)
              if (!rr.ok) break
            }
            pk.got = countOf(bot, 'ender_pearl') - p0
            if (pk.seen || pk.went) log('жемчуг мимо ямы', pk)
          }
        }
        // Лечиться — здесь, в замкнутой яме/штреке, а не снаружи: кампания после захода с хп 6 искала
        // нору в Аду, нора не закрылась — «БЛОКЕР», тело отключено (ферма 30.09, camp-10).
        if ((bot.health ?? 20) < 14 && !ctl.aborted) {
          const h0 = Math.round(bot.health ?? 0)
          const until2 = Math.min(deadline - 20000, gameClock.now() + 120000)
          while ((bot.health ?? 20) < 16 && gameClock.now() < until2 && !ctl.aborted && !inLava(bot)) {
            if ((bot.food ?? 20) < 18) await eatIfHungry(session, ctl)
            if ((bot.food ?? 20) < 18 && (bot.food ?? 20) < 20 && !bot.inventory.items().some(i => /cooked|bread|apple|carrot|potato|melon_slice|stew|porkchop|beef|mutton|chicken|rabbit|cod|salmon/.test(i.name))) break
            await sleep(2000)
          }
          st.healed = { from: h0, to: Math.round(bot.health ?? 0) }
          log('лечусь в штреке', st.healed)
        }
        // Выходить — только подлечившись (хп ≥ 14); иначе остаться в замкнутом штреке: следующий вызов
        // продолжит отсюда (ревью Codex 30.09: выход при хп 7 после неудачного лечения).
        if (p.exit !== false && (!BF.enabled() || done()) && (bot.health ?? 20) >= 14 && exitReserveReady(bot, p)) { st.exit = await exitTunnel(session, ctl, st, deadline); log('выход', st.exit) } else if (p.exit !== false && (!BF.enabled() || done())) { st.exit = { ok: false, why: !exitReserveReady(bot, p) ? 'набор на выход не готов (обсидиан/огонь) — остаюсь в штреке' : `лечение не завершилось (хп ${Math.round(bot.health ?? 0)}) — остаюсь в штреке` }; log('выход', st.exit) }
        if (BF.enabled() && mode !== 'gold' && !done() && !ctl.aborted) {
          if (spare() < 18 && st.pred.size && !st.noPick && gameClock.now() < deadline - 60000) {
            // Ход к сундукам/золоту без единого блока золота — тоже «продвижение» для miningProgress; два пакета подряд без золота —
            // стоп (s1c-A-8 06.10: 4 пакета по кругу у сундуков, которые видят пиглины, и «небезопасных» блоков; 680 с, 0 золота).
            st.dryBatches = st.blocks > (st.blocksAtBatch ?? -1) || spare() > 0 ? 0 : (st.dryBatches || 0) + 1
            st.blocksAtBatch = st.blocks
            if (!minedSinceRetry || mode === 'barter' || st.dryBatches >= 2) {
              st.barterRetry = 'добыча не продвинулась — нужен новый путь к оставшемуся золоту'
              break
            }
            minedSinceRetry = false
            st.pitDone = false; st.sealedDone = false
            // S1f: новый пакет — новая фаза золота. Прежний goldPhaseEnd (конец первого пакета, «сейчас») делал goldOver истинным на
            // первом же обороте: пакет 2+ не копался ни разу, заход кончался «золото кончилось» при 54 целях шаблона (s1f-B0-1).
            if (process.env.ND_BATCH_PHASE !== '0') goldPhaseEnd = gameClock.now() + (deadline - gameClock.now()) * 0.6
            st.round++
            log('бартер: следующий пакет золота', { left: st.pred.size, pearls: countOf(bot, 'ender_pearl') })
            continue
          }
          if (spare() >= 18) st.barterRetry = 'сменить место у торговцев с сохранённым золотом'
        }
        break
      }
      // Бартер между делом: слитков много и пиглины рядом — сделки идут, пока
      // копаем (и разглядывающие золото не злятся от следующего блока).
      if (!st.sealed || !st.sealedState) { if (await tryBarter()) continue }
      // S1f: >= — «фаза кончилась сейчас» (goldPhaseEnd = now) под пошаговой фермой не ждёт сдвига часов: с > цикл без единого await
      // на таймере крутился вечно (мир ждёт тело) — s1f-D1-1: «игровые часы стоят 90 с» после 16 точек обзора.
      const goldOver = mode === 'barter' || spare() >= goldTarget() || gameClock.now() >= goldPhaseEnd
      if (goldOver) {
        if (mode === 'gold') break
        if (!(await goldReady())) { st.lastBarter = st.lastBarter || 'без золотой брони к торговцам не иду'; break }
        // Злость пиглинов от сломанного золота — 600 тиков (30 с): торговать,
        // когда остынут, а до того сидеть там, где копал (они до нас не доходят).
        if (gameClock.now() - (st.lastBreak || 0) < 33000) { await sleep(2000); continue }
        if (spare() <= 0) break
        if (await tryBarter(true)) continue
        // Брут в 16 — к торговцам не идти: выход из ямы под его удары (S1d s1d-F21-1: «бартер: рядом брут в 10 — отойти», ход к пиглинам
        // через двор — 2 удара, смерть). Заложиться на месте и кончить заход.
        // Пиглинов в 16 не видно — к ближайшему известному (до 48 блоков).
        const tr = nearestTrader(bot, 48)
        const brutesNear = mobs(bot, 'piglin_brute', 24)
        if (brutesNear.length) {
          const reach = reachSet(bot)
          const A: typeof import('.././assess') = require('.././assess')
          const g = A.gearOf([5, 6, 7, 8].map(i => bot.inventory.slots[i]))
          const wr = bruteWalkRisk(brutesNear, { threatens: b => threatens(bot, b, reach), nearTrader: b => !!tr && b.position.distanceTo(tr.e.position) < 10,
            hit: A.afterArmor(13, g.armor, g.tough), hp: bot.health ?? 20 })
          if (!wr.go) { log('бартер: к торговцам — брут', { ...wr, brutes: brutesNear.length }); await hunker(session, ctl, st, 'брут рядом — к торговцам не иду').catch(() => null); st.lastBarter = 'брут рядом'; break }
        }
        if (!tr || barterWalks >= 8) { st.lastBarter = st.lastBarter || 'пиглинов рядом нет'; break }
        barterWalks++
        const pg: any = tr.e
        await walkGoal(session, ctl, new goals.GoalNear(pg.position.x, pg.position.y, pg.position.z, 3), 15000, { dig: !tr.walk })
        barterNext = 0
        continue
      }
      // Закрытый штрек (sealed): вышка-обзор → золото по шаблону сквозь твёрдое.
      if (st.sealed && mode !== 'barter' && !st.sealedDone) {
        survey(bot, st, 56)
        const blind = (require('.././nether-cover') as typeof import('.././nether-cover')).blind()
        if (blind && !st.pred.size && !st.chestSeen.size) {
          const pg = await predictGoldAsync(bot, 56, ctl)
          rememberStarts(bot, st, pg.start?.all)
          for (const g of pg.gold) { const k = keyOf(g.pos); if (!st.pred.has(k)) st.pred.set(k, { pos: g.pos, piece: g.piece, rank: g.rank, wall: g.wall }) }
        }
        const chestsLeft = st.lootChests && [...st.chestSeen.keys()].some(k => !st.looted.has(k))
        const goldLeft = !st.chestsOnly && (st.pred.size > 0 || st.gold.size > 0)
        if (!blind && !goldLeft && !chestsLeft && st.towered < 3 &&
            (!st.lastTower || st.lastTower.distanceTo(bot.entity.position) >= 4)) {
          st.towered++
          await towerScan(session, ctl, st)
          st.lastTower = bot.entity.position.clone()
          continue
        }
        if (st.chestsOnly && chestsLeft) {
          await sealedGold(session, ctl, st, Math.max(gameClock.now() + 60000, deadline - 300000))
          await goldReady()
          const made = await makeIronPick(session, ctl)
          log('железная кирка из сундуков', { made, ingots: countOf(bot, 'iron_ingot'), raw: countOf(bot, 'raw_iron'), nuggets: countOf(bot, 'iron_nugget'), blocks: countOf(bot, 'iron_block') })
          st.chestsOnly = false
          if (!made) { st.ironNeed = true; break }
          continue
        }
        // Сундуки, увиденные с вышки (survey), — тоже цели закрытого штрека: в сундуках бастиона золото и золотая броня
        // (loot_table chests/bastion_other: ботинки ×2, шлем, нагрудник, поножи, блок и слитки — 9 из 20 на бросок, бросков 2).
        // Вслепую стены по шаблону часто не узнаются (b2-6-1 14.10), а сундук двора виден — без него заход кончался пустым.
        if (goldLeft || chestsLeft) {
          const beforeMining = miningSnapshot()
          await sealedGold(session, ctl, st, mode === 'gold' ? deadline : Math.max(gameClock.now() + 60000, deadline - 240000))
          await goldReady()
          // Золото карты осталось — ходом по сетке к каждому (ND_GOLD_ROUTE=1).
          if (!(require('.././nether-cover') as typeof import('.././nether-cover')).blind() && process.env.ND_GOLD_ROUTE === '1' && st.pred.size && !ctl.aborted) st.routeGold = await routeGold(session, ctl, st, mode === 'gold' ? deadline : Math.max(gameClock.now() + 60000, deadline - 200000))
          minedSinceRetry = miningCycle.miningProgress(beforeMining, miningSnapshot())
          st.sealedDone = true
          goldPhaseEnd = gameClock.now()
          continue
        }
        // shortcut: три перехода только по видимому полу; если не хватит, добавить поиск по пеленгам.
        // Вслепую — и с золотом не ходить по бастиону открыто: бруты бьют при любом золоте (g4-9-1: обзор по двору на ботинках —
        // брут, смерть на 3-й мин); обзор — зондом закрытого штрека ниже.
        if (goldWorn(bot) && vantage < 3 && !(require('.././nether-cover') as typeof import('.././nether-cover')).blind()) {
          const eyes: typeof import('.././perception/eyes') = require('.././perception/eyes')
          const view = { blockAt: pos => eyes.seesNow(bot, pos) ? bot.blockAt(pos) : null }
          const me = bot.entity.position.clone()
          st.been.push(me)
          const aims = points.map(q => new Vec3(q.x, q.y, q.z)).filter(q => !st.been.some(v => v.distanceTo(q) < 4))
          if (!aims.length) aims.push(new Vec3(center.x, center.y, center.z))
          const A: typeof import('.././assess') = require('.././assess')
          const gear = A.gearOf([5, 6, 7, 8].map(i => bot.inventory.slots[i]))
          const brutes = mobs(bot, 'piglin_brute', 40).filter(e => seesMob(bot, e))
          const score = n => Math.min(...aims.map(q => q.distanceTo(n.pos))) + n.d * 0.3
          const next = (require('.././walkable') as typeof import('.././walkable')).walkable(view, me, { radius: 20, maxNodes: 3000 })
            .filter(n => !st.visited.has(keyOf(n.pos)) && !st.been.some(v => v.distanceTo(n.pos) < 4))
            .filter(n => bruteWalkRisk(brutes, { threatens: () => false, nearTrader: e => e.position.distanceTo(n.pos) < 10,
              hit: A.afterArmor(13, gear.armor, gear.tough), hp: bot.health ?? 20 }).go)
            .sort((a, b) => score(a) - score(b))[0]
          if (next) {
            st.visited.add(keyOf(next.pos))
            vantage++
            const strict = bot._ndLavaStrict
            bot._ndLavaStrict = true
            let w
            try {
              w = await walkUnlessBrute(session, ctl, new goals.GoalBlock(next.pos.x, next.pos.y, next.pos.z),
                Math.min(20000, deadline - gameClock.now() - 12000), { dig: false })
            } finally { bot._ndLavaStrict = strict }
            if (!ctl.aborted && session.bot === bot) survey(bot, st, 56)
            log('закрытый заход: обзор', { to: xyz(next.pos), ok: w && w.ok, moved: me.distanceTo(bot.entity.position),
              gold: st.gold.size, chests: st.chestSeen.size })
            continue
          }
        }
        // Вслепую без золотой вещи — к центру бастиона закрытым штреком (nether-cover), устья — окна обзора (survey): вскрытый двор
        // показывает золото и сундуки, дальше — к ним (sealedGold). golden-v1 g1-5-1: бастион в 15 бл., «не узнан» за 2 с, брошен.
        const NC: typeof import('.././nether-cover') = require('.././nether-cover')
        if (NC.blind() && (st.probes || 0) < 6 && gameClock.now() < deadline - 30000) {
          st.probes = (st.probes || 0) + 1
          const targets = () => st.gold.size + [...st.chestSeen.keys()].filter(k => !st.looted.has(k)).length
          const r: any = await NC.closedBore(session, ctl, { x: center.x, z: center.z }, {
            deadline: Math.min(deadline - 20000, gameClock.now() + 60000), maxSteps: 24,
            onOpen: async () => { survey(bot, st, 56); const pg = await predictGoldAsync(bot, 56, ctl); rememberStarts(bot, st, pg.start?.all); return { seen: targets() + st.pred.size } }, stop: v => !!(v && v.seen > 0)
          })
          survey(bot, st, 56)
          log('бастион: штреком к центру', { n: st.probes, ok: r.ok, moved: r.moved, mouths: r.mouths, corridor: r.corridor, gold: st.gold.size, chests: st.chestSeen.size, why: r.why, at: r.at })
          if (r.moved || targets() || st.pred.size) continue
        }
        st.sealedDone = true
        st.notRecognized = true
        break
      }
      if (!(await goldReady())) { st.lastBarter = st.lastBarter || 'без золотой брони по двору не хожу'; break }
      survey(bot, st)
      const t = nextTarget(bot, st)
      // Целей не видно, а слитков на бартер хватает — к пиглинам (они в 32
      // блоках слышны), а не бродить по точкам обзора.
      if (!t && mode !== 'gold' && spare() >= 24 && barterWalks < 6) {
        const tr0 = nearestTrader(bot, 32)
        if (tr0) {
          barterWalks++
          const pg0: any = tr0.e
          await walkGoal(session, ctl, new goals.GoalNear(pg0.position.x, pg0.position.y, pg0.position.z, 3), 15000, { dig: !tr0.walk })
          barterNext = 0
          if (await tryBarter(true)) continue
        }
      }
      if (t) {
        idle = 0
        const r = t.kind === 'gold' ? await takeGoldBlock(session, ctl, t.pos, st) : await lootChest(session, ctl, t.pos, st)
        log(t.kind, { at: t.k, r, hp: Math.round(bot.health ?? 0), ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') })
        // Слитки на подкуп — из первого же блока.
        if (r === 'piglins' && !countOf(bot, 'gold_ingot') && countOf(bot, 'gold_block')) await unpackGold(session, ctl, 9)
        continue
      }
      // Видимых целей нет — узнать бастион сверху (вышка) и идти к золоту по
      // шаблону: предсказанные блоки в стенах (жилой: 17 золотых в двух стенах).
      if (!st.pred.size && st.towered < 2 && mode !== 'barter') {
        st.towered++
        await towerScan(session, ctl, st)
        continue
      }
      const pt = [...st.pred.entries()].filter(([k]) => (st.skip.get(k) || 0) < gameClock.now())
        .map(([k, v]) => ({ k, pos: v.pos, rank: v.rank || 0, d: v.pos.distanceTo(bot.entity.position) })).sort((a, c) => (a.rank - c.rank) || (a.d - c.d))[0]
      if (pt) {
        idle = 0
        const r = await digToPredicted(session, ctl, st, pt)
        log('к золоту по шаблону', { at: pt.k, ...r, left: st.pred.size, hp: Math.round(bot.health ?? 0), blocks: countOf(bot, 'gold_block') })
        continue
      }
      // Отложенные есть — подождать, пока пиглины разойдутся (или раздать слитки).
      const waiting = [...st.gold.keys()].some(k => (st.skip.get(k) || 0) >= gameClock.now())
      if (waiting && idle < 3 && (process.env.ND_NE_RECOVER !== '1' || (require('.././ne-guard') as typeof import('.././ne-guard')).hot(bot))) {
        idle++
        if (!countOf(bot, 'gold_ingot') && countOf(bot, 'gold_block')) await unpackGold(session, ctl, 9)
        await sleep(3000)
        continue
      }
      // Точка обзора: ближайшая непосещённая; восемь — и хватит искать.
      const me = bot.entity.position
      // Граница обхода: видимый кирпич бастиона вдали от того, где уже стоял
      st.been.push(me.clone())
      const bricks = [...st.bricks.values()]
      const minY = bricks.length ? Math.min(...bricks.map(b => b.y)) : me.y
      let next = null
      let best = Infinity
      for (const b of bricks) {
        if (st.been.some(v => v.distanceTo(b) < 12)) continue
        if (st.visited.has(keyOf(b))) continue
        const score = b.distanceTo(me) + 1.5 * (b.y - minY)
        if (score < best) { best = score; next = b }
      }
      if (!next) next = points.filter(q => !st.visited.has(keyOf(q))).sort((a, c) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(c.x - me.x, c.z - me.z))[0] || null
      if (!next || vantage >= 16) { goldPhaseEnd = gameClock.now(); if (mode === 'gold') break; continue }
      st.visited.add(keyOf(next))
      vantage++
      idle = 0
      // Сквозь стены бастиона — можно (чернокамень; охраняемое pathfinder не
      // ломает, лава под шагом — прыжок к полу).
      const w = await walkGoal(session, ctl, new goals.GoalNear(next.x, next.y + 1, next.z, 3), 20000, { dig: true })
      log('обзор', { to: xyz(next), ok: w && w.ok, at: xyz(bot.entity.position.floored()), gold: st.gold.size, chests: st.chestSeen.size, bricks: st.bricks.size })
      // S1f: не дошёл — соседние кирпичи той же стены (8 бл.) тоже недоступны отсюда: не тратить на них точки обзора (s1f-D1-1:
      // 13 точек подряд у x 82–86 «ok:false» с одного места, бюджет обзора ушёл). ND_VANTAGE_SKIP=0 — прежнее.
      if (!(w && w.ok) && process.env.ND_VANTAGE_SKIP !== '0') for (const b of st.bricks.values()) if (b.distanceTo(next) <= 8) st.visited.add(keyOf(b))
    }
    // Добыча бартера, что легла дальше руки (за уступом, в яме) — собрать с копкой.
    if (!st.sealedState) await pickUp(bot, ctl, 10, 20000)
    const tossed = await dropJunk(bot)
    if (tossed.length) st.tossed.push(...tossed)
  } finally {
    try { bot.setControlState('sneak', false) } catch {}
    bot._client.removeListener('damage_event', onDmg)
    bot.removeListener('health', onHp)
    bot._ndToolFilter = toolFilter0
    if (st.lavaStrict0 !== undefined) bot._ndLavaStrict = st.lavaStrict0
    // Свои клетки бастиона (штрек к золоту и сундукам, яма) — в общую память штреков (и на диск): обратный путь
    // к порталу идёт по ним, а не вскрытием двора (разбор Codex 30.09: 2 смерти на обратном штреке у бастиона).
    try { if (st.sealedState && st.sealedState.own) (require('.././tunnel') as typeof import('.././tunnel')).rememberOwn(session, st.sealedState.own) } catch {}
    try { memoSave() } catch {}
  }
  const leftGold = [...st.gold.keys()].length
  // Золото по памяти (карта копии мира), до которого не нашлось пути, — не «кончилось»: neF-Pa25-1 02.10 — 4 блока,
  // «штрек: пути нет» к 26 целям, и кампания пометила бастион выработанным при 24 известных.
  const memLeft = [...st.pred.values()].filter(v => v.piece === 'память').length
  const tplLeft = [...st.pred.entries()].filter(([k, v]) => v.piece !== 'память' && v.piece !== 'видно' && !(st.sealedState && st.sealedState.own && st.sealedState.own.has(k))).length
  let stopped = null
  if (ctl.aborted) stopped = 'прервано'
  else if (st.notRecognized) stopped = 'бастион не узнан — доступных целей после обзора нет'
  else if (done()) stopped = null
  else if (spare() <= 0 && leftGold === 0 && memLeft > 0) stopped = `золото по памяти осталось (${memLeft}), пути к нему нет${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  // S1f: цели шаблона (predictGold: тип и поворот бастиона узнаны) остались — не «кончилось» (вслепую кампания по этой фразе
  // помечала бастион выработанным после первого пакета: s1f-B0-1, 18 слитков при 54 целях шаблона).
  else if (spare() <= 0 && leftGold === 0 && tplLeft > 0 && process.env.ND_BATCH_PHASE !== '0') stopped = `золото по шаблону осталось (${tplLeft}), заход кончился${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  else if (spare() <= 0 && leftGold === 0) stopped = `золото кончилось: видимых блоков больше нет${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  else if (gameClock.now() >= deadline - 20000) stopped = 'время вышло — позови ещё раз, продолжу'
  else if (st.lastBarter) stopped = `бартер встал: ${st.lastBarter}`
  return out(stopped)
}
// Снимок на загрузке, как прежний экспорт FAST_SAFE (module.exports брал значение let при загрузке); никем не читается.
const FAST_SAFE = goldMode.fastSafe
module.exports = { approachGold, targetsByBruteHome, bruteHomeTake, pitAngerWait, bruteWalkRisk, nearBruteHome, pitsAwayFromBrutes, goldWindowOk, rememberStarts, planView, bruteDefense, FAST_SAFE, goldExposes, hunker, burrowColumn, burrow, answerAttack, digToPredicted, digToPredictedBody, sealedGold, digTrap, buildTrap, sealBody, prepareBarterCover, digPit, moveBarterSite, bastion }
export {
  approachGold, targetsByBruteHome, bruteHomeTake, pitAngerWait, bruteWalkRisk, nearBruteHome, pitsAwayFromBrutes,
  goldWindowOk, rememberStarts, planView, bruteDefense, FAST_SAFE, goldExposes, hunker, burrowColumn, burrow,
  answerAttack, digToPredicted, digToPredictedBody, sealedGold, digTrap, buildTrap, sealBody, prepareBarterCover,
  digPit, moveBarterSite, bastion
}
