// Бастион (bastion()) — закрытый путь после золота: торговое место из штрека (ловушка, яма, окно), бартер в нём, жемчуг
// мимо ямы, лечение в штреке, выход и следующий пакет золота (шаг цикла добычи, прежняя ветка «st.sealedDone && !st.pitDone»).
import {
  log, sleep, mobs, gameClock, inLava, countOf, pickUp, BF, waitWatched, unpackGold, goldWorn
} from './take-gold-block'
import { digBooth, mergeTrades, exitTunnel } from './tower-scan'
import { boothTrade, exitReserveReady, barterRound, ownTunnelAt } from './booth-trade'
import { trade as penTrade } from './pen-trap'
import { eatIfHungry } from './predict-gold'
import { burrow } from './defense'
import { digTrap, digPit, moveBarterSite } from './barter-site'
import * as OpenSite from './open-site'
import { type BastionRun, type Turn, spare, done, goldReady } from './run'
import * as HF from './hyp-focus'

// Закрытый путь: после золота — торговое окно из штрека, потом штреком назад.
export async function stepTunnelBarter (bx: BastionRun): Promise<Turn> {
  const { session, ctl, p, bot, st, mode, deadline } = bx
  if (st.sealed && st.sealedState && st.sealedDone && !st.pitDone) {
    // Закрытый проход прошлого вызова кончился без добычи (sealedDone из памяти), торговать нечем и целей нет — не стоп за 1 с,
    // а один новый обзор за вызов (stepSealed: вышка, зонд штреком к центру; не вышло — «не узнан», и кампания отложит бастион):
    // nbs39-5974 — 349 вызовов подряд «золото кончилось: видимых блоков больше нет» с одного места.
    if (mode !== 'barter' && !bx.rescanned && spare(bx) <= 0 && !countOf(bot, 'gold_block') && !st.pred.size && !st.gold.size &&
        ![...st.chestSeen.keys()].some(k => !st.looted.has(k))) { bx.rescanned = true; st.sealedDone = false; return 'next' }
    st.pitDone = true
    // ND_BASTION_HYP_FOCUS: торговое место из штрека в стене не встаёт ни разу («ни ямы, ни окна» во всех nbf46–53), а яма у пола
    // бастиона вскрыла море лавы (nbf53-5408, смерть с 108 слитками) — торг только на открытом (pearls seek: выход по своему штреку).
    // Меньше 8 слитков — не торг: кампания на открытое с ними не идёт (carriedTrade ≥ 8), и «торг — на открытом» крутил bastion ↔ этапы
    // без копки (c91-int1-s22: 1 слиток, 3 вызова подряд «бартер встал», потом ход к крепости — ифриты).
    if (HF.on() && mode !== 'gold' && !done(bx) && spare(bx) > 0 && spare(bx) < 8 && !countOf(bot, 'gold_block')) st.lastBarter = `золота на торг мало (${spare(bx)} сл.)`
    else if (HF.on() && mode !== 'gold' && !done(bx) && (spare(bx) > 0 || countOf(bot, 'gold_block'))) { st.lastBarter = 'торг — на открытом (seek)'; st.barterRetry = 'сменить место у торговцев с сохранённым золотом' }
    else if (mode !== 'gold' && !done(bx) && (spare(bx) > 0 || countOf(bot, 'gold_block')) && await goldReady(bx)) await barterAtSite(bx)
    // ND_SEEK_OWN_EXIT=1 (поток ne 21.10, выкл.): к торговцам — выйти своим закрытым штреком ко входу (exitTunnel: план по своим клеткам,
    // закладки за спиной копаются), а не ходьбой seek с копкой напрямик: nl71b/nlo74b-5408 — путь сквозь комнаты стены, брут 12.9 + 8.3.
    if (process.env.ND_SEEK_OWN_EXIT === '1' && st.lastBarter === 'торг — на открытом (seek)' && (bot.health ?? 20) >= 14 && !ctl.aborted) {
      st.exit = await exitTunnel(session, ctl, st, deadline).catch(e => ({ ok: false, why: e.message })); log('выход к торговцам', st.exit)
    }
    if (stoppedReturn(bx)) return 'stop'
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
    if (p.exit !== false && (!BF.enabled() || done(bx)) && (bot.health ?? 20) >= 14 && exitReserveReady(bot, p)) { st.exit = await exitTunnel(session, ctl, st, deadline); log('выход', st.exit) } else if (p.exit !== false && (!BF.enabled() || done(bx))) { st.exit = { ok: false, why: !exitReserveReady(bot, p) ? 'набор на выход не готов (обсидиан/огонь) — остаюсь в штреке' : `лечение не завершилось (хп ${Math.round(bot.health ?? 0)}) — остаюсь в штреке` }; log('выход', st.exit) }
    if (BF.enabled() && mode !== 'gold' && !done(bx) && !ctl.aborted) {
      if (spare(bx) < 18 && st.pred.size && !st.noPick && gameClock.now() < deadline - 60000) {
        // Ход к сундукам/золоту без единого блока золота — тоже «продвижение» для miningProgress; два пакета подряд без золота —
        // стоп (s1c-A-8 06.10: 4 пакета по кругу у сундуков, которые видят пиглины, и «небезопасных» блоков; 680 с, 0 золота).
        st.dryBatches = st.blocks > (st.blocksAtBatch ?? -1) || spare(bx) > 0 ? 0 : (st.dryBatches || 0) + 1
        st.blocksAtBatch = st.blocks
        if (!bx.minedSinceRetry || mode === 'barter' || st.dryBatches >= 2) {
          st.barterRetry = 'добыча не продвинулась — нужен новый путь к оставшемуся золоту'
          return 'stop'
        }
        bx.minedSinceRetry = false
        st.pitDone = false; st.sealedDone = false
        // S1f: новый пакет — новая фаза золота. Прежний goldPhaseEnd (конец первого пакета, «сейчас») делал goldOver истинным на
        // первом же обороте: пакет 2+ не копался ни разу, заход кончался «золото кончилось» при 54 целях шаблона (s1f-B0-1).
        if (process.env.ND_BATCH_PHASE !== '0') bx.goldPhaseEnd = gameClock.now() + (deadline - gameClock.now()) * 0.6
        st.round++
        log('бартер: следующий пакет золота', { left: st.pred.size, pearls: countOf(bot, 'ender_pearl') })
        return 'next'
      }
      if (spare(bx) >= 18) st.barterRetry = 'сменить место у торговцев с сохранённым золотом'
    }
    return 'stop'
  }
}

// Яма со ртом (добыча падает к нам); не вышла — окно в стене. Бартер на месте, жемчуг мимо ямы.
async function barterAtSite (bx: BastionRun) {
  const { ctl } = bx
  const started = gameClock.now()
  const bo = await chooseSite(bx)
  if (stoppedReturn(bx)) return
  const setupSeconds = (gameClock.now() - started) / 1000
  if (bo?.kind === 'open') {
    await OpenSite.tradeOpen(bx, bo)
    if (stoppedReturn(bx)) return
    if (bo.nextKind && !ctl.aborted) {
      const t = gameClock.now(), protectedSite = await chooseSite(bx, false)
      const protectedSetup = (gameClock.now()-t)/1000
      if (protectedSite) { await tradeAtSite(bx, protectedSite); OpenSite.rememberProtected(bx.st, protectedSite, protectedSetup) }
      else await noSite(bx)
    }
  }
  else if (bo) { await tradeAtSite(bx, bo); if (OpenSite.enabled()) OpenSite.rememberProtected(bx.st, bo, setupSeconds) }
  else { if (OpenSite.enabled()) OpenSite.rememberProtected(bx.st, null, setupSeconds); await noSite(bx) }
  // ND_PEARL_PICK=1: жемчуг, брошенный мимо ямы (D6-21 03.10: 108 слитков, брошено 4 жемчуга, доставка 0.58 — в
  // рюкзаке 0), — ходом по сетке (двор втридорога, брут в 10 — бросить) к каждому в 14 бл. и подобрать.
  if (bo && bo.kind !== 'open' && process.env.ND_PEARL_PICK === '1' && !ctl.aborted) await pickStrayPearls(bx)
}

function stoppedReturn (bx: BastionRun) { return OpenSite.enabled() && bx.st.openReturn?.ok === false }

async function chooseSite (bx: BastionRun, considerOpen = true) {
  const { session, ctl, p, bot, st, deadline } = bx
  if (considerOpen && OpenSite.enabled() && process.env.ND_BARTER_TRADER_MEMORY === '1') await (require('./tower-scan') as typeof import('./tower-scan')).peekTraders(session,ctl,st,Math.min(deadline-90000,gameClock.now()+20000))
  if (considerOpen && OpenSite.enabled()) {
    const open = await OpenSite.chooseOpen(bx)
    if (open) return open
    if (stoppedReturn(bx)) return null
  }
  if (!OpenSite.enabled() && process.env.ND_BARTER_TRADER_MEMORY === '1') await (require('./tower-scan') as typeof import('./tower-scan')).peekTraders(session,ctl,st,Math.min(deadline-90000,gameClock.now()+20000))
  // The local probe needs no already-seen trader or copy grid.
  if (process.env.ND_BARTER_WALL_BOOTH === '1' && (!p.trade || p.trade === 'booth')) return digBooth(session, ctl, st, deadline - 85000)
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
  return bo
}

// Бартер в найденном месте: яма — penTrade (не работает — другая яма, до двух раз), окно и ловушка — boothTrade.
export async function tradeAtSite (bx: BastionRun, bo) {
  const { session, ctl, p, bot, st, deadline, keep } = bx
  const doneNow = () => done(bx)
  st.pit = { kind: bo.kind || 'booth', at: bo.F, window: bo.W, dump: !!bo.dump, catch: bo.catch, pigs: bo.pigs, brutes: bo.brutes, sealed: bo.sealed, baited: bo.baited }
  st.pitTrade = await (bo.kind === 'pit' ? penTrade : boothTrade)(session, ctl, st, bo, deadline - 5000, { keep, done: doneNow })
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
    const r2 = await penTrade(session, ctl, st, bo, deadline - 5000, { keep, done: doneNow })
    log('яма: бартер', r2)
    st.pitTrade = mergeTrades(st.pitTrade, r2)
  }
}

async function noSite (bx: BastionRun) {
  const { session, ctl, bot, st, deadline } = bx
  st.lastBarter = 'ни ямы, ни окна'
  if (BF.enabled()) st.barterRetry = 'нет защищённого места у торговцев'
  // ND_OPEN_BARTER=1: ни ямы, ни окна, а золото есть — бартер на открытом, как у спидраннеров (золотая броня, брутов и
  // хоглинов в 24 нет): D7b-32 03.10 — 15 золотых блоков, 0 сделок, бастион «выработан».
  if (!OpenSite.enabled() && !BF.enabled() && process.env.ND_OPEN_BARTER === '1' && !ctl.aborted && goldWorn(bot) && countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block') >= 9 &&
    ![...mobs(bot, 'piglin_brute', 24), ...mobs(bot, 'hoglin', 24)].length && gameClock.now() < deadline - 60000) {
    await unpackGold(session, ctl, 9 * countOf(bot, 'gold_block') + countOf(bot, 'gold_ingot'))
    const n = countOf(bot, 'gold_ingot')
    const ob = await barterRound(session, ctl, st, n, deadline - 40000).catch(e => ({ error: e.message }))
    st.lastBarter = 'на открытом'
    log('бартер на открытом', { ingots: n, spent: ob && ob.spent, pearls: ob && ob.pearls, stopped: ob && (ob.stopped || ob.error) })
  }
}

async function pickStrayPearls (bx: BastionRun) {
  const { session, ctl, bot, st, deadline } = bx
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
