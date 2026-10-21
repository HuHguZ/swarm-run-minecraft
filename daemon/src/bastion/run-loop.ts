// Бастион (bastion()) — цикл добычи и торга (прежний while в bastion()): каждый оборот — шаги по порядку; шаг возвращает
// 'next' (следующий оборот), 'stop' (конец цикла; с bx.ret — возврат этого итога из bastion()) или ничего (дальше).
import {
  log, sleep, xyz, mobs, seesMob, goals, walkGoal, gameClock, reachSet, threatens, takeGoldBlock, inLava, lavaEscape,
  lavaEscapeDeep, makeIronPick, countOf, Vec3, unpackGold, keyOf, goldWorn, nearestTrader, survey, nextTarget, lootChest
} from './take-gold-block'
import { towerScan, routeGold } from './tower-scan'
import { walkUnlessBrute } from './booth-trade'
import { eatIfHungry, predictGoldAsync } from './predict-gold'
import * as miningCycle from './mining-cycle'
import { bruteWalkRisk } from './brute-risk'
import { bruteDefense, hunker, answerAttack } from './defense'
import { rememberStarts, sealedGold, digToPredicted } from './sealed-gold'
import { type BastionRun, type Turn, report, spare, done, goldTarget, goldReady, tryBarter, miningSnapshot } from './run'
import { stepTunnelBarter } from './run-trade'
import * as HF from './hyp-focus'

const MINE_STEPS: ((bx: BastionRun) => Turn | Promise<Turn>)[] = [
  stepSafe, stepEntry, stepTunnelBarter, stepBarterBetween, stepGoldOver, stepSealed,
  stepYard, stepTower, stepPredicted, stepDeferred, stepVantage
]

export async function mineLoop (bx: BastionRun) {
  const { ctl, deadline } = bx
  turn: while (!ctl.aborted && gameClock.now() < deadline - 12000) {
    await new Promise<void>(resolve => setImmediate(resolve)) // оборот без ввода-вывода не держит пакеты (см. sealedGold)
    for (const step of MINE_STEPS) {
      const r = await step(bx)
      if (r === 'stop') break turn
      if (r === 'next') continue turn
    }
  }
}

// Лава, малое хп, еда, ответ на удар, бруты, цель набрана.
async function stepSafe (bx: BastionRun): Promise<Turn> {
  const { session, ctl, bot, st, mode } = bx
  if (inLava(bot)) { if (!(await lavaEscape(bot))) await lavaEscapeDeep(bot); return 'next' }
  if ((bot.health ?? 20) < 8) { bx.ret = report(bx, `хп ${Math.round(bot.health)} — ухожу лечиться`); return 'stop' }
  await eatIfHungry(session, ctl)
  if (await answerAttack(session, ctl, st)) return 'next'
  if (await bruteDefense(session, ctl, st)) return 'next'
  if (mode !== 'gold' && done(bx)) return 'stop'
}

// Вслепую — вход по второму виду и закрытому пути к стене (entry-route).
async function stepEntry (bx: BastionRun): Promise<Turn> {
  const { session, ctl, bot, st, mode, deadline } = bx
  if (st.sealed && mode !== 'barter' && (require('.././nether-cover') as typeof import('.././nether-cover')).blind() && !st.entryDone) {
    // ND_BASTION_HYP_FOCUS: старт подтверждён двумя видами — сразу цели этой гипотезы планом штрека (без хода к метке E нижней
    // стены: nbs41-5408 — 40 вызовов «пол забоя не встал»/«устье в пещеру» на шве стен при верном старте).
    const confirmed = HF.on() && (require('./entry-route') as typeof import('./entry-route')).memory(bot).confirmed
    if (confirmed && !HF.refutedOf(bot).hyps.has(HF.hypKey(confirmed))) {
      st.entryDone = true
      st.pred.clear(); st.pieces = []
      for (const [k, c] of st.chestSeen) if (c.pred) st.chestSeen.delete(k)
      rememberStarts(bot, st, [confirmed])
      st.entryRoute = { ok: false, start: confirmed, why: 'старт подтверждён — к целям гипотезы' }
      st.sealedDone = false
      return
    }
    const entry = await (require('./entry-route') as typeof import('./entry-route')).approach(session, ctl, st, deadline)
    if (entry.handled) {
      st.entryRoute = { ok: entry.ok, start: entry.start, entry: entry.entry, why: entry.why }
      if ('recognized' in entry && entry.recognized) {
        st.entryDone = true
        st.pred.clear(); st.pieces = []
        for (const [k,c] of st.chestSeen) if (c.pred) st.chestSeen.delete(k)
        rememberStarts(bot, st, [entry.recognized])
        st.entryRoute = { ok: false, start: entry.recognized, why: entry.why }
        st.sealedDone = false
      } else if (entry.ok && entry.start) {
        st.entryDone = true
        st.pred.clear(); st.pieces = []
        for (const [k,c] of st.chestSeen) if (c.pred) st.chestSeen.delete(k)
        rememberStarts(bot, st, [entry.start])
        st.sealedDone = false
      } else if (entry.progress) return 'next'
      // ND_BASTION_ENTRY_ON=1: вход по второму виду не вышел без продвижения («на открытом: ни вниз, ни в стену» — 6 вызовов 16.10,
      // ne01-s13 21.10: весь заход кончался за 0 с, граф уходил к эндерменам) — не конец захода, а дальше по шагам: закрытый
      // штрек к гипотезам, двор в золоте, вышка-обзор, точки обзора.
      else if (process.env.ND_BASTION_ENTRY_ON === '1') { st.entryDone = true; log('вход по второму виду не вышел — дальше другими шагами', { why: entry.why }) }
      else { bx.ret = report(bx, entry.why || 'housing: второго вида или закрытого пути к стене пока нет'); return 'stop' }
    }
  }
}

// Бартер между делом: слитков много и пиглины рядом — сделки идут, пока
// копаем (и разглядывающие золото не злятся от следующего блока).
async function stepBarterBetween (bx: BastionRun): Promise<Turn> {
  const { st } = bx
  if (!st.sealed || !st.sealedState) { if (await tryBarter(bx)) return 'next' }
}

// Золото набрано или его фаза кончилась — к торговцам (остывшие пиглины, бруты — цена хода, ближайший торговец).
async function stepGoldOver (bx: BastionRun): Promise<Turn> {
  const { session, ctl, bot, st, mode } = bx
  // S1f: >= — «фаза кончилась сейчас» (goldPhaseEnd = now) под пошаговой фермой не ждёт сдвига часов: с > цикл без единого await
  // на таймере крутился вечно (мир ждёт тело) — s1f-D1-1: «игровые часы стоят 90 с» после 16 точек обзора.
  const goldOver = mode === 'barter' || spare(bx) >= goldTarget(bx) || gameClock.now() >= bx.goldPhaseEnd
  if (goldOver) {
    if (mode === 'gold') return 'stop'
    if (!(await goldReady(bx))) { st.lastBarter = st.lastBarter || 'без золотой брони к торговцам не иду'; return 'stop' }
    // Злость пиглинов от сломанного золота — 600 тиков (30 с): торговать,
    // когда остынут, а до того сидеть там, где копал (они до нас не доходят).
    if (gameClock.now() - (st.lastBreak || 0) < 33000) { await sleep(2000); return 'next' }
    if (spare(bx) <= 0) return 'stop'
    if (await tryBarter(bx, true)) return 'next'
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
      if (!wr.go) { log('бартер: к торговцам — брут', { ...wr, brutes: brutesNear.length }); await hunker(session, ctl, st, 'брут рядом — к торговцам не иду').catch(() => null); st.lastBarter = 'брут рядом'; return 'stop' }
    }
    if (!tr || bx.barterWalks >= 8) { st.lastBarter = st.lastBarter || 'пиглинов рядом нет'; return 'stop' }
    bx.barterWalks++
    const pg: any = tr.e
    await walkGoal(session, ctl, new goals.GoalNear(pg.position.x, pg.position.y, pg.position.z, 3), 15000, { dig: !tr.walk })
    bx.barterNext = 0
    return 'next'
  }
}

// Закрытый штрек (sealed): вышка-обзор → золото по шаблону сквозь твёрдое.
async function stepSealed (bx: BastionRun): Promise<Turn> {
  const { session, ctl, bot, st, mode, deadline } = bx
  if (st.sealed && mode !== 'barter' && !st.sealedDone) {
    survey(bot, st, 56)
    const blind = (require('.././nether-cover') as typeof import('.././nether-cover')).blind()
    if (blind && !st.pred.size && !st.chestSeen.size) {
      const pg = await predictGoldAsync(bot, 56, ctl)
      rememberStarts(bot, st, pg.start?.all)
      if (!HF.on()) for (const g of pg.gold) { const k = keyOf(g.pos); if (!st.pred.has(k)) st.pred.set(k, { pos: g.pos, piece: g.piece, rank: g.rank, wall: g.wall }) }
    }
    const chestsLeft = st.lootChests && [...st.chestSeen.keys()].some(k => !st.looted.has(k))
    const goldLeft = !st.chestsOnly && (st.pred.size > 0 || st.gold.size > 0)
    // ND_BASTION_BLIND_TOWER=1: вслепую в золоте — тоже вышка-обзор (как человек: подняться и посмотреть на бастион сверху), если
    // брута не видно в 16; без неё вслепую «бастион не узнан» с 1 бл. от стены (nbs07e 21.10: hypotheses 0, заход кончился).
    const blindTower = blind && process.env.ND_BASTION_BLIND_TOWER === '1' && goldWorn(bot) && !mobs(bot, 'piglin_brute', 16).some(e => seesMob(bot, e))
    if ((!blind || blindTower) && !goldLeft && !chestsLeft && st.towered < 3 &&
        (!st.lastTower || st.lastTower.distanceTo(bot.entity.position) >= 4)) {
      st.towered++
      await towerScan(session, ctl, st)
      st.lastTower = bot.entity.position.clone()
      return 'next'
    }
    if (st.chestsOnly && chestsLeft) {
      await sealedGold(session, ctl, st, Math.max(gameClock.now() + 60000, deadline - 300000))
      await goldReady(bx)
      const made = await makeIronPick(session, ctl)
      log('железная кирка из сундуков', { made, ingots: countOf(bot, 'iron_ingot'), raw: countOf(bot, 'raw_iron'), nuggets: countOf(bot, 'iron_nugget'), blocks: countOf(bot, 'iron_block') })
      st.chestsOnly = false
      if (!made) { st.ironNeed = true; return 'stop' }
      return 'next'
    }
    // Сундуки, увиденные с вышки (survey), — тоже цели закрытого штрека: в сундуках бастиона золото и золотая броня
    // (loot_table chests/bastion_other: ботинки ×2, шлем, нагрудник, поножи, блок и слитки — 9 из 20 на бросок, бросков 2).
    // Вслепую стены по шаблону часто не узнаются (b2-6-1 14.10), а сундук двора виден — без него заход кончался пустым.
    if (goldLeft || chestsLeft) {
      const beforeMining = miningSnapshot(bx)
      await sealedGold(session, ctl, st, mode === 'gold' ? deadline : Math.max(gameClock.now() + 60000, deadline - 240000))
      await goldReady(bx)
      // Золото карты осталось — ходом по сетке к каждому (ND_GOLD_ROUTE=1).
      if (!(require('.././nether-cover') as typeof import('.././nether-cover')).blind() && process.env.ND_GOLD_ROUTE === '1' && st.pred.size && !ctl.aborted) st.routeGold = await routeGold(session, ctl, st, mode === 'gold' ? deadline : Math.max(gameClock.now() + 60000, deadline - 200000))
      bx.minedSinceRetry = miningCycle.miningProgress(beforeMining, miningSnapshot(bx))
      // ND_BASTION_HYP_FOCUS: штрек встал (стопы, кирки), а гнездо золота гипотезы в 16 бл. — ещё заход штрека (до 3 за вызов),
      // а не конец фазы золота и бартер с первыми блоками.
      if (HF.on() && !ctl.aborted && HF.clusterLeft(bot, st, 16) > 0 && (st.reentered = (st.reentered || 0) + 1) <= 3) {
        if (st.sealedState) st.sealedState.fails = []
        log('штрек: гнездо золота рядом — ещё заход', { left: HF.clusterLeft(bot, st, 16), n: st.reentered, mined: bx.minedSinceRetry })
        return 'next'
      }
      st.sealedDone = true
      bx.goldPhaseEnd = gameClock.now()
      return 'next'
    }
    return sealedSurvey(bx)
  }
}

// Закрытый штрек без целей: обзор с золотом на теле по видимому полу, вслепую — штреком к центру; нет — бастион не узнан.
async function sealedSurvey (bx: BastionRun): Promise<Turn> {
  const { session, ctl, bot, st, deadline, center, points } = bx
  // shortcut: три перехода только по видимому полу; если не хватит, добавить поиск по пеленгам.
  // Вслепую — и с золотом не ходить по бастиону открыто: бруты бьют при любом золоте (g4-9-1: обзор по двору на ботинках —
  // брут, смерть на 3-й мин); обзор — зондом закрытого штрека ниже.
  if (goldWorn(bot) && bx.vantage < 3 && !(require('.././nether-cover') as typeof import('.././nether-cover')).blind()) {
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
      bx.vantage++
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
      return 'next'
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
    if (r.moved || targets() || st.pred.size) return 'next'
  }
  st.sealedDone = true
  st.notRecognized = true
  return 'stop'
}

// Открытый двор: видимые цели (золото, сундуки); целей нет, а слитков хватает — к пиглинам.
async function stepYard (bx: BastionRun): Promise<Turn> {
  const { session, ctl, bot, st, mode } = bx
  if (!(await goldReady(bx))) { st.lastBarter = st.lastBarter || 'без золотой брони по двору не хожу'; return 'stop' }
  survey(bot, st)
  const t = nextTarget(bot, st)
  // Целей не видно, а слитков на бартер хватает — к пиглинам (они в 32
  // блоках слышны), а не бродить по точкам обзора.
  if (!t && mode !== 'gold' && spare(bx) >= 24 && bx.barterWalks < 6) {
    const tr0 = nearestTrader(bot, 32)
    if (tr0) {
      bx.barterWalks++
      const pg0: any = tr0.e
      await walkGoal(session, ctl, new goals.GoalNear(pg0.position.x, pg0.position.y, pg0.position.z, 3), 15000, { dig: !tr0.walk })
      bx.barterNext = 0
      if (await tryBarter(bx, true)) return 'next'
    }
  }
  if (t) {
    bx.idle = 0
    const r = t.kind === 'gold' ? await takeGoldBlock(session, ctl, t.pos, st) : await lootChest(session, ctl, t.pos, st)
    log(t.kind, { at: t.k, r, hp: Math.round(bot.health ?? 0), ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') })
    // Слитки на подкуп — из первого же блока.
    if (r === 'piglins' && !countOf(bot, 'gold_ingot') && countOf(bot, 'gold_block')) await unpackGold(session, ctl, 9)
    return 'next'
  }
}

// Видимых целей нет — узнать бастион сверху (вышка) и идти к золоту по
// шаблону: предсказанные блоки в стенах (жилой: 17 золотых в двух стенах).
async function stepTower (bx: BastionRun): Promise<Turn> {
  const { session, ctl, st, mode } = bx
  if (!st.pred.size && st.towered < 2 && mode !== 'barter') {
    st.towered++
    await towerScan(session, ctl, st)
    return 'next'
  }
}

async function stepPredicted (bx: BastionRun): Promise<Turn> {
  const { session, ctl, bot, st } = bx
  if (HF.on()) HF.focus(st)
  const pt = [...st.pred.entries()].filter(([k, v]) => (st.skip.get(k) || 0) < gameClock.now() && HF.predAllowed(st, v))
    .map(([k, v]) => ({ k, pos: v.pos, rank: v.rank || 0, d: v.pos.distanceTo(bot.entity.position) })).sort((a, c) => (a.rank - c.rank) || (a.d - c.d))[0]
  if (pt) {
    bx.idle = 0
    const r = await digToPredicted(session, ctl, st, pt)
    log('к золоту по шаблону', { at: pt.k, ...r, left: st.pred.size, hp: Math.round(bot.health ?? 0), blocks: countOf(bot, 'gold_block') })
    return 'next'
  }
}

// Отложенные есть — подождать, пока пиглины разойдутся (или раздать слитки).
export async function stepDeferred (bx: BastionRun): Promise<Turn> {
  const { session, ctl, bot, st } = bx
  const waiting = [...st.gold.keys()].some(k => (st.skip.get(k) || 0) >= gameClock.now())
  if (waiting && bx.idle < 3 && (process.env.ND_NE_RECOVER !== '1' || (require('.././ne-guard') as typeof import('.././ne-guard')).hot(bot))) {
    bx.idle++
    if (!countOf(bot, 'gold_ingot') && countOf(bot, 'gold_block')) await unpackGold(session, ctl, 9)
    await sleep(3000)
    return 'next'
  }
}

// Точка обзора: ближайшая непосещённая; восемь — и хватит искать.
async function stepVantage (bx: BastionRun): Promise<Turn> {
  const { session, ctl, bot, st, mode, points } = bx
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
  if (!next || bx.vantage >= 16) { bx.goldPhaseEnd = gameClock.now(); if (mode === 'gold') return 'stop'; return 'next' }
  st.visited.add(keyOf(next))
  bx.vantage++
  bx.idle = 0
  // Сквозь стены бастиона — можно (чернокамень; охраняемое pathfinder не
  // ломает, лава под шагом — прыжок к полу).
  const w = await walkGoal(session, ctl, new goals.GoalNear(next.x, next.y + 1, next.z, 3), 20000, { dig: true })
  log('обзор', { to: xyz(next), ok: w && w.ok, at: xyz(bot.entity.position.floored()), gold: st.gold.size, chests: st.chestSeen.size, bricks: st.bricks.size })
  // S1f: не дошёл — соседние кирпичи той же стены (8 бл.) тоже недоступны отсюда: не тратить на них точки обзора (s1f-D1-1:
  // 13 точек подряд у x 82–86 «ok:false» с одного места, бюджет обзора ушёл). ND_VANTAGE_SKIP=0 — прежнее.
  if (!(w && w.ok) && process.env.ND_VANTAGE_SKIP !== '0') for (const b of st.bricks.values()) if (b.distanceTo(next) <= 8) st.visited.add(keyOf(b))
}
