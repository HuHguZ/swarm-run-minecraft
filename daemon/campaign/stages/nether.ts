'use strict'
// Этапы Ада: prep, bastion, nether.
import { OW_DEEP } from '../flags'
import { strategyInterrupted, state, sit, memorySnapshot, died, known, bastionDry, bastionGoldDug,
  bastionIngotsTraded, barterZero, bastionSearchRuns, bastionSearchSeconds, blazeDugInAt, netherSearchFailure,
  setBarterRetryPending, setBarterZero, setBastionDry, setBastionGoldDug, setBastionIngotsTraded,
  setBastionSearchRuns, setBastionSearchSeconds, setBlazeDugInAt, setBlazeDugInPos, setHuntWool, setIronChestTried,
  setLastBastionGoldLeft, lastBastionGoldLeft, setNetherSearchFailure, setSupplyBlockedAt, setSupplyBlockedState } from '../state'
import { log } from '../log'
import { have, dim, LOGS, FOOD, foodUnits, netherFoodHave, planksFor, portalFar, rodsNow, goldOn, shieldOn, shieldLow,
  spawnAtPortal, lighter, fireResNow, fireResReady, pearlsNow } from '../queries'
import { sense, refresh, readMemory, bState } from '../observe'
import { READY, netherFoodNeed, fightReady, fightLack, defStage, entrySupplies, foodShort, near3, stageRun, owFastTrack } from './table'
import { EXIT_KIT, obsShort, eyesWant, barterFlow, deferBastionMining, nextBastion, activeBastion, barterExhausted,
  BASTION_SEARCH_S, bastionSearchWanted, BASTION_FIRST, bastionPearlsPending, rodsShort, rodsWanted, netherRetryState,
  netherFailureState, bastionPriceChoice, netherSupply, netherSupplyState } from '../nether-plan'
import { act } from '../act'
import { nightGuard, recoverGuard, baseDeposit } from '../guards'
import { netherVia, goToward, returnFromNether } from '../travel'
import { ensureTable, craft, sticks, sticksReserve, spares, netherFillers, lumber, mineSeenAll, smeltAll } from '../kit'
import { makeBed, cook } from '../food'
import { ensureFlint } from '../portal-kit'
import { enterNether, wearGold, netherGold, fedForBlazes, replenishNetherSupply, goldUp } from '../nether-trip'
import * as gameClock from '../../src/game-clock'
let prepRuns = 0
defStage('prep', () => !!known.portal && dim() === 'overworld' && rodsNow() < 7 && (prepRuns < 1 || !lighter()) &&
  (!lighter() || foodShort() > 0 || (!shieldOn() && have('iron_ingot') > 0)), async () => {
  prepRuns++
  await sense()
  if (owFastTrack() && lighter()) { log('OW_FAST: портал готов; сборы >=90с + охота против входа ~30с — вхожу, запас пополню в укрытии Ада'); return }
  if (entrySupplies() && READY.nether() && lighter()) { log('сборы: еды на вход хватает — без охоты за шерстью и дальнего сбора щита'); return }
  if (OW_DEEP && known.portal && near3(known.portal, 48) && lighter() && netherFoodHave() >= netherFoodNeed()) {
    log(`сборы: портал в ${Math.round(portalFar())} бл., огниво есть, еды ${foodUnits()} — в Ад без сборов`)
    return
  }
  await nightGuard()
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  setHuntWool(!entrySupplies() && !spawnAtPortal())
  try {
    if (foodShort() > 0) await stageRun('food')()
  } finally { setHuntWool(false) }
  await cook()
  await makeBed()
  if (entrySupplies() && READY.nether() && lighter()) return
  const ironWant = lighter() ? 0 : 1
  if (ironWant) {
    await refresh()
    for (let k = 0; k < 2 && have('iron_ingot') + have('raw_iron') < ironWant && have('iron_nugget') >= 9; k++) {
      const before = have('iron_ingot')
      await ensureTable()
      await act('craft', { item: 'iron_ingot', count: 1 })
      await refresh()
      if (have('iron_ingot') <= before) break
    }
    if (have('iron_ingot') + have('raw_iron') < ironWant) {
      for (let k = 0; k < 3 && have('iron_ingot') + have('raw_iron') < ironWant && !died; k++) {
        await nightGuard()
        const m = await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: ironWant, radius: 48, timeoutSeconds: 150 })
        if (m.detail && m.detail.dug) continue
        await mineSeenAll('iron_ore,deepslate_iron_ore', 48)
        if (have('iron_ingot') + have('raw_iron') >= ironWant) break
        const e = await act('explore', { block: 'iron_ore', radius: 48, stepDistance: 60, timeoutSeconds: 120 })
        if (!(e.detail && e.detail.found)) break
      }
    }
    await smeltAll('raw_iron', 'iron_ingot')
    if (!lighter()) { await nightGuard(); await ensureFlint() }
  }
  {
    await refresh()
    if (!shieldOn() && have('iron_ingot')) {
      if (have(/_planks$/) < 6 && !have(LOGS)) await lumber(2)
      if (have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
      await craft('shield')
      await act('armor')
    }
  }
  await readMemory()
  if (have(/_bed$/) && !spawnAtPortal() && known.portal) {
    await goToward(known.portal, 6)
    await act('sleep', { mode: 'spawn', why: 'у портала в Ад' })
    await readMemory()
  }
})
const SCOUT_HIGH = process.env.ND_SCOUT_HIGH === '1'
let rodsFirstSkips = 0 // не больше 3 отказов бастиона ради стержней: путь к спавнеру тоже может не открыться
// Бастион сам отдал торг на открытое («торг — на открытом (seek)»: закрытый проход кончился, путей к остальному золоту нет) — следующий
// оборот торгует принесённым, даже если слитков < 90 и шаблон обещает ещё золото: иначе livelock bastion ↔ pearls без копки и торга
// (sG85-int3-s20: 32 слитка, ~40 вызовов «торг — на открытом» за минуту, потом explore — брут).
let bastionWantsSeek = false
defStage('bastion', () => !!known.portal && (!!nextBastion() || bastionSearchWanted()) && bastionDry < 3 && !known.endPortal &&
  (BASTION_FIRST || rodsNow() >= 7) && (pearlsNow() < eyesWant() || obsShort()), async (searchOnly = false) => {
  if (dim() !== 'the_nether') {
    await refresh()
    if (!goldOn() && have('gold_ingot') >= 4) await wearGold()
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
    }
    if (!lighter()) await ensureFlint()
    if (state.playPolicy?.mode !== 'speedrun') {
      await baseDeposit()
      await sticksReserve()
    }
    await act('kit', { for: 'bastion' })
    if (have(/_bed$/) && !spawnAtPortal()) await act('sleep', { mode: 'spawn', why: 'у портала в Ад' })
    const e = await enterNether()
    if (!(e.detail && e.detail.went)) throw new Error('в Ад не прошёл')
  }
  // S1f: огнестойкость в рюкзаке (≥ 2 зелий — ~6 мин боя), жемчуга уже ≥ 6, крепость известна, стержней не хватает, золота на бартер
  // нет — сперва стержни: бой у спавнера под FR — риск 0.35 против 0.7 без неё (калибровка s1c), а дальнейшие заходы в бастион
  // уносили и FR, и жемчуг (s1f-G3-1: 10 жемч./6 FR — брут на 40 мин; S1-2: 11/9 — брут на 51; I1-3: 8/2 — куб магмы на 46; план всё
  // время «BastionBarter → GetBlazeRods»). Неудача этапа — директор берёт стержни. ND_RODS_FIRST_FR=0 — прежнее.
  if (!searchOnly && dim() === 'the_nether' && process.env.ND_RODS_FIRST_FR !== '0' && fireResNow() >= 2 && rodsShort() > 0 && pearlsNow() >= 6 && known.fortress &&
    have('gold_ingot') + 9 * have('gold_block') < 8 && rodsFirstSkips < 3 && !died) {
    rodsFirstSkips++
    log(`бастион подождёт: огнестойкость ×${fireResNow()}, жемчуг ${pearlsNow()}/${eyesWant()}, стержней не хватает ${rodsShort()} — сперва ифриты под FR`)
    throw new Error('сперва стержни под огнестойкостью')
  }
  if (!nextBastion() && bastionSearchWanted() && dim() === 'the_nether' && !died) {
    setBastionSearchRuns(bastionSearchRuns + 1)
    await spares(260)
    await netherFillers()
    const f = await act('fortress', { mode: 'bastion', timeoutSeconds: 420, ...(SCOUT_HIGH ? { high: true } : {}) })
    await readMemory()
    const fd = f.detail || {}
    if (/обошёл регионы/.test(fd.stopped || '')) setBastionSearchRuns(99)
    setBastionSearchSeconds(bastionSearchSeconds + Math.max(30, Number(fd.seconds) || 0))
    log(`поиск бастиона: ${fd.found ? `найден ${JSON.stringify((fd.bastion && fd.bastion.nearest) || {})}` : 'не найден' + (fd.stopped ? ' — ' + fd.stopped : '')} (заход ${Math.min(bastionSearchRuns, 8)}, ${fd.seconds ?? '?'} с, бюджет ${Math.round(bastionSearchSeconds)}/${BASTION_SEARCH_S} с)`)
    if (!nextBastion()) return
  }
  if (searchOnly) return
  if (!goldOn() && have(/^golden_(helmet|chestplate|leggings|boots)$/)) await act('armor')
  if (!goldOn()) await netherGold()
  // Золотой брони нет — не отказ (правило гибкости; b0 14.10: бастион в 28 и 55 бл., «в бастион не иду» → домой, 90 мин без
  // добычи): навык bastion идёт только закрытым штреком до первого золота (сундук, блок), из него — броня, торг — после неё.
  if (!goldOn()) log('РИСК: золотой брони нет — в бастион закрытым штреком: первое золото (сундук, блок) — на броню, торг — после неё')
  for (let i = 0; i < 4 && !died && dim() === 'the_nether'; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    if ((state.health ?? 20) < 12) { if (have(FOOD)) await act('eat'); if ((state.health ?? 20) < 10) break }
    const b = nextBastion()
    if (!b) { log('все известные бастионы выработаны'); break }
    // Нести слитки к ДАЛЁКОМУ бастиону в режиме бартера — потерять его золото (S1d s1d-AB-1 слот 22: 9 слитков, бастион 2 в 170 бл.,
    // barter 540 с «подход к защищённому бартеру не завершён» → «два бартера без слитка» → бастион отложен, к ифритам с 0 жемчуга).
    // Далёкий бастион — обычным заходом: копка и торг всего, включая принесённое.
    // ND_BASTION_HYP_FOCUS: золото верной гипотезы ещё в стенах — добрать до ~90 слитков, торг потом (поток ne 21.10, nbf47/48).
    const carriedGold = have('gold_ingot') + 9 * have('gold_block')
    const carriedTrade = barterFlow.enabled() && pearlsNow() < eyesWant() && carriedGold >= 8 &&
      (process.env.ND_BASTION_HYP_FOCUS === '0' || carriedGold >= 90 || !lastBastionGoldLeft || bastionIngotsTraded > 0 || bastionWantsSeek) &&
      (!state.pos || Math.hypot(b.x - state.pos.x, b.z - state.pos.z) <= 64)
    const price = bastionPriceChoice(b)
    if (price) log(price.line)
    if (price?.action === 'endermen') { await stageRun('pearls')(); return }
    // ND_BARTER_SEEK (по умолчанию вкл., =0 — выкл.): золото на руках — сперва к видимым пиглинам на открытом без брутов рядом (pearls mode=seek), как спидраннер
    // в золотой броне; защищённое место бастиона (яма/окно) — только если так не вышло ни слитка (nbs32-5974: 27 слитков, «ни ямы, ни окна»).
    // ND_BAST_GOLD_ON: золото пришло внутри этапа (заход bastion) — ботинки до торга: цикл этапа шёл в seek без брони (R-P слот 13: 32 слитка,
    // ботинок нет, seek рвала тактика ×N).
    if (carriedTrade && process.env.ND_BAST_GOLD_ON === '1' && !goldOn()) await goldUp()
    if (carriedTrade && process.env.ND_BARTER_SEEK !== '0') {
      bastionWantsSeek = false
      const sk = await act('pearls', { mode: 'seek', pearls: Math.max(0, eyesWant() - have('ender_eye')), timeoutSeconds: 360, avoid: { x: b.x, z: b.z, r: 20 } })
      await refresh()
      const sd = sk.detail || {}
      setBastionIngotsTraded(bastionIngotsTraded + (Number(sd.spent) || 0))
      log(`${b.key}: торг на открытом — слитков ${sd.spent ?? 0}, жемчуг +${sd.pearls ?? 0} (${pearlsNow()}/${eyesWant()}); ${sd.stopped || sk.error || sk.status}`)
      if (died || dim() !== 'the_nether') return
      if (pearlsNow() >= eyesWant() || have('gold_ingot') + 9 * have('gold_block') < 8) break
      if ((Number(sd.spent) || 0) > 0) { setBarterZero(0); continue }
      // Прервала тактика (гаст, куб магмы) — после неё снова к торговцам, а не в долгий защищённый бартер бастиона.
      if (sk.status === 'interrupted' || sk.code === 'TACTICAL') continue
      // ND_SEEK_AGAIN=1 (поток ne 21.10, выкл.): торговцев не нашёл — снова seek с нового места (оборот цикла), а не бартер bastion: при
      // FOCUS он сразу «торг — на открытом» → пауза этапа и ne_recover/wait до конца с золотом в рюкзаке (nlo78c: 105 слитков).
      if (process.env.ND_SEEK_AGAIN === '1' && /пиглинов не нашёл/.test(String(sd.stopped || ''))) continue
    }
    if (!carriedTrade && !netherSupply.netherToolsReady(netherSupplyState())) {
      const supply = await replenishNetherSupply()
      // ND_BASTION_TOOLS_PRICE=1: 260 взмахов — запас на весь поход, а не допуск в бастион. Железная кирка есть и взмахов хватает
      // на первый пакет (штрек ~20 копок + блоки золота) — идти, пополнение — потом (nbs07d 21.10: бастион в 27 бл., 136/96/87
      // взмахов, «откладываю до пополнения» ×4 — дерева Ада не видно, 30 мин без захода).
      const bastionPick = process.env.ND_BASTION_TOOLS_PRICE === '1' && have(/^(iron|diamond|netherite)_pickaxe$/) > 0 && (sit.pickLeft ?? 0) >= 40
      if (!supply.ready && bastionPick) log(`РИСК: инструменты не пополнены (${supply.reason}), взмахов ${sit.pickLeft} — на первый пакет золота хватит, иду`)
      else if (!supply.ready) { setSupplyBlockedAt(gameClock.now()); setSupplyBlockedState({ observed: netherFailureState('netherTools'), origin: state.pos && { ...state.pos } }); log(`копку и путь к бастиону откладываю до пополнения инструментов: ${supply.reason}`); return }
    }
    const bs = bState(b)
    bs.runs++
    const nearAny = !!state.pos && (known.bastions || []).some(x => Math.hypot(x.x - state.pos.x, x.z - state.pos.z) < 80)
    if (!nearAny && process.env.ND_NE_ROUTE !== '1') await spares(600)
    const via0 = dim() === 'the_nether' && state.pos ? netherVia(state.pos, b) : []
    if (via0.length && state.pos && Math.hypot(b.x - state.pos.x, b.z - state.pos.z) > 100) {
      const end = via0[via0.length - 1]
      const t = await act('nether_tunnel', { x: end[0], y: end[1], z: end[2], radius: 5, via: via0, budgetCheck: true, noBreachNear: { x: b.x, z: b.z, r: 48 }, timeoutSeconds: 2700 })
      await refresh()
      if (died || dim() !== 'the_nether') return
      const td = t.detail || {}
      const why = td.why || t.error || ''
      if (/кирок на дорогу не хватит/.test(why)) { log(`${b.key}: ${why} — сначала пополнить кирки`); break }
      log(`${b.key}: штрек по маршруту — ${td.ok ? 'дошёл' : 'не дошёл: ' + why} (точек ${td.viaDone ?? '?'}/${via0.length}, копок ${td.dug ?? '?'})`)
      if (!td.ok && state.pos && Math.hypot(b.x - state.pos.x, b.z - state.pos.z) > 100) { log(`${b.key}: до бартера не дошёл — бастион остаётся нужен`); break }
    }
    // S1e (вслепую): бастион узнан глазами издалека, золото не известно — сперва подойти к нему (на 20 бл.), а не начинать закрытый
    // штрек с уступа за лавовым морем (s1e-M2-1: с 31 бл. «штрек: пути нет», заливка старта 29 клеток, 2 сухих захода за секунду —
    // «выработан» при 142 блоках золота шаблона стен). До 3 подходов на бастион.
    // Без золотой брони пешком не подходить: подход ведёт навык закрытым штреком (ревью Codex 14.10).
    if (!(b.gold && b.gold.length) && goldOn() && state.pos && Math.hypot(b.x - state.pos.x, b.z - state.pos.z) > 28 && (bs.blindApproach || 0) < 3 && dim() === 'the_nether') {
      bs.blindApproach = (bs.blindApproach || 0) + 1
      log(`${b.key}: золото не известно, до него ${Math.round(Math.hypot(b.x - state.pos.x, b.z - state.pos.z))} бл. — сперва подхожу (${bs.blindApproach}/3)`)
      // ND_NE_SEALED_APPROACH=1 (поток ne 21.10, выкл.): и в золотых ботинках — штреком: точка бастиона — первый увиденный блок, обычно верх
      // вала, где посты брутов; пешком на 57 бл. к валу в ботинках — брут с вала (c87-int2-s20: 12.9 + 7.1 на 5-й мин).
      await goToward({ x: b.x, y: b.y ?? 64, z: b.z }, 20, 1, process.env.ND_NE_SEALED_APPROACH === '1' ? 16 : null)
      await refresh()
      if (died || dim() !== 'the_nether') return
    }
    const far = state.pos ? Math.hypot(b.x - state.pos.x, b.z - state.pos.z) : 0
    const beforeApproach = state.pos ? { ...state.pos } : null
    const r = await act('bastion', { x: b.x, y: b.y, z: b.z, vantage: b.vantage, knownGold: b.gold, knownChests: b.chests, starts: b.starts,
      ...(carriedTrade ? { mode: 'barter' } : {}), timeoutSeconds: carriedTrade ? 540 : process.env.ND_GOLD_FAST_SAFE === '1' ? 720 : 1200 + Math.min(600, Math.round(far)), tripSeconds: far > 200 ? Math.min(480, Math.round(far / 1.3)) : 0, pearls: Math.max(0, eyesWant() - have('ender_eye')), fireRes: process.env.ND_BASTION_PRICE === '1' ? 0 : 3, ...(process.env.ND_SH_NETHER === '1' ? { obsidian: 10 } : {}), ...(EXIT_KIT ? { exit: false } : {}), sealed: !bs.openNext, ...(process.env.ND_SEALED_BREACH === '1' ? { breach: true } : {}), ...(process.env.ND_GOLD_FAST_SAFE === '1' ? { fastSafe: true } : {}) })
    const d = r.detail || {}
    if (/торг — на открытом \(seek\)/.test(String(d.stopped || ''))) bastionWantsSeek = true
    setLastBastionGoldLeft(Math.max(0, Number(d.knownGoldLeft ?? d.predLeft) || 0))
    setBastionGoldDug(bastionGoldDug + (Number(d.goldBlocksDug) || 0))
    setBastionIngotsTraded(bastionIngotsTraded + (Number(d.ingotsTraded) || 0))
    if ((Number(d.ingotsTraded) || 0) > 0) setBarterZero(0)
    if (d.supplyNeeded) await sense()
    if (strategyInterrupted || r.status === 'interrupted' || r.code === 'TACTICAL' || r.by?.type === 'tactical') {
      throw Object.assign(new Error('STRATEGY_INTERRUPTED: бастион прерван, исчерпание не подтверждено'), { strategyInterrupted: true })
    }
    if (d.supplyNeeded && netherSupplyState().pickSwings < 260) {
      log(`${b.key}: ресурсный запас ${netherSupplyState().pickSwings}/260 — пополнение и новый план; сухой заход не засчитываю`)
      throw Object.assign(new Error('STRATEGY_INTERRUPTED: ресурсный запас требует пополнения и перепланирования'), { strategyInterrupted: true })
    }
    const approached = dim() === 'the_nether' && require('../../src/campaign/nether-progress')
      .bastionApproachProgress(beforeApproach, state.pos, b)
    if (carriedTrade) {
      setBastionDry(0); bs.dry = 0
      setBarterZero((Number(d.ingotsTraded) || 0) > 0 ? 0 : barterZero + 1)
      if (barterExhausted() && pearlsNow() < eyesWant()) {
        if ((bs.miningDeferredUntil || 0) <= gameClock.now()) log(`${b.key}: два бартера подряд без единого слитка (${String(d.stopped || r.error || '').slice(0, 100)}) — бартер исчерпан, бастион отложен`)
        deferBastionMining(b)
      }
      if (pearlsNow() < eyesWant() && have('gold_ingot') + 9 * have('gold_block') >= 8) {
        setBarterRetryPending(true)
        bs.barterUntil = approached ? 0 : gameClock.now() + 60000
      }
      log(`${b.key}: бартер с сохранённым золотом — слитков ${d.ingotsTraded ?? 0}, жемчуг ${pearlsNow()}/${eyesWant()}; добыча другого бастиона отложена`)
      break
    }
    if (barterFlow.enabled() && barterFlow.retry(d, state.inventory || {})) {
      setBarterRetryPending(true); setBastionDry(0); bs.dry = 0
      // Подход продвинулся — то же место без минутной паузы (как у бартера с принесённым золотом выше).
      bs.barterUntil = approached ? 0 : gameClock.now() + 60000
      log(`${b.key}: золото сохранено, нужен другой этаж/торговцы — повтор без многоминутной паузы`)
      break
    }
    if (d.need && d.need.what === 'iron_pickaxe') { setIronChestTried(true); log('в сундуках бастиона железа на кирку не хватило — за железом наверх'); break }
    log(`${b.key}: золотых блоков ${d.goldBlocksDug ?? '?'}, слитков пиглинам ${d.ingotsTraded ?? '?'}, в рюкзаке ${JSON.stringify(d.bag || {})}${d.stopped ? ' — ' + d.stopped : ''}`)
    const got = d.goldBlocksDug > 0 || d.ingotsTraded > 0 || (Array.isArray(d.chests) && d.chests.some(c => c && Object.values(c.took || {}).some((n : any) => n > 0)))
    if (!got && !approached) { setBastionDry(bastionDry + 1); bs.dry++ } else { setBastionDry(0); bs.dry = 0; bs.miningDeferredUntil = 0 }
    // Заходы без золота и сделок, где «подход» — лишь шаги внутри бастиона: 3 подряд — отложить (S1d s1d-M-1: 8340… с 31-й по
    // 56-ю мин ~10 вызовов «золото кончилось: видимых блоков больше нет», каждый засчитан подходом — бастион не откладывался).
    bs.noGain = got ? 0 : (bs.noGain || 0) + 1
    if (bs.noGain >= 3 && (bs.miningDeferredUntil || 0) <= gameClock.now()) { log(`${b.key}: ${bs.noGain} захода подряд без золота и сделок`); deferBastionMining(b); bs.noGain = 0; break }
    if (approached && !got) log(`${b.key}: приблизился к известному золоту/сундуку — сухой заход не засчитываю`)
    const mappedLeft = process.env.ND_GOLD_FAST_SAFE === '1' &&
      ((d.knownGoldLeft ?? d.predLeft ?? b.gold?.length ?? 0) > 0 || /золото по памяти осталось|пути.*нет|не дошёл|время вышло|заплатка/.test(d.stopped || ''))
    if (mappedLeft) {
      // Два сухих захода — отложить и без второго бастиона: дальше граф берёт стержни/эндерменов, а не крутит тот же бастион
      // (s1c-B-1 06.10: 4 захода по 4–10 мин с нулём золота, 27→57 мин; по std раунда 1 «пути нет»/«золото кончилось» — 85
      // вызовов, 362 мин).
      if (!got && !approached && bs.dry >= 2) {
        deferBastionMining(b)
      }
      log(`${b.key}: не выработан — осталось золото или путь не закончен`)
      break
    }
    // S1e: вслепую два сухих захода издалека (> 28 бл. до бастиона на старте захода) — не «выработан», а ближе и снова (до 3 подходов).
    if (!got && bs.dry >= 2 && far > 28 && !(b.gold && b.gold.length) && (bs.blindApproach || 0) < 3) {
      log(`${b.key}: два сухих захода с ${Math.round(far)} бл. — не выработан, подойду ближе`)
      bs.dry = 0
      break
    }
    // S1f: вслепую (золото бастиона не известно) закрытый штрек по шаблону ничего не дал (шаблон не попал: s1f-B0-2 сокровищница,
    // s1f-A2-3 мост — «не золото» по всем целям, 0 блоков ×2 → «выработан» на 5-й мин; S1e M4/M5 — то же в 9 из 21) — прежде чем
    // бросить бастион, один заход открытым обзором, как игрок в золотой броне: видимое золото и сундуки с точек обзора. Риск обзора
    // меньше потери единственного источника жемчуга. По умолчанию ВЫКЛ. (ND_BASTION_OPEN=1 — вкл.): нативно 3 открытых захода (s1f-FA-1,
    // G1-2, D1-1) — 2 смерти (брут; лава у y 25), 0 золота в рюкзак — цена риска выше выгоды.
    if (!got && far <= 48 && !/не дош/.test(String(d.stopped || '')) && !(b.gold && b.gold.length) && !bs.openTried && !bs.openNext && process.env.ND_BASTION_OPEN === '1' && dim() === 'the_nether' && !died) {
      bs.openNext = true
      log(`${b.key}: закрытый штрек по шаблону ничего не дал — следующий заход открытым обзором (видимое золото, сундуки)`)
      bs.dry = 0
      continue
    }
    if (bs.openNext) { bs.openNext = false; bs.openTried = true }
    const unfinished = /не узнан|не дош|пути.*нет|время вышло|заход кончился|не закрылась|закладка/.test(d.stopped || '') || (d.predLeft || 0) > 0 || (d.goldSeenLeft || 0) > 0
    if (unfinished) {
      deferBastionMining(b)
      break
    }
    if (got && /золото кончилось/.test(d.stopped || '')) {
      bs.spent = true
      log(`${b.key} выработан`)
      await act('remember', { kind: 'прогресс', place: `выработан: ${b.key}`, text: 'Бартер завершён: золото выработано или два сухих захода подряд' })
    }
    if (!got && !bs.spent) break
    if (!(pearlsNow() < eyesWant() || fireResNow() < 1 || obsShort())) break
    await refresh()
  }
})
defStage('nether', () => !!known.portal && rodsWanted() && !blazeFrPaused(), async () => {
  if (bastionPearlsPending()) {
    log(`к крепости пока не иду: жемчуга ${pearlsNow()}/${eyesWant()}, сперва бартер имеющегося золота и известные бастионы`)
    return
  }
  if (dim() !== 'the_nether') {
    await refresh()
    if (!goldOn() && have('gold_ingot') >= 4) await wearGold()
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) {
        await nightGuard()
        if (await goToward(known.portal, 6)) break
      }
    }
    if (!lighter()) await ensureFlint()
    await baseDeposit()
    await sticksReserve()
    if (shieldLow() && !have('shield') && have('iron_ingot')) {
      if (have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
      await craft('shield')
      log(`запасной щит: ${have('shield') ? 'есть' : 'не вышел'}`)
    }
    await act('kit', { for: 'nether' })
    if (have(/_bed$/) && !spawnAtPortal()) await act('sleep', { mode: 'spawn', why: 'у портала в Ад' })
    const e = await enterNether()
    if (!(e.detail && e.detail.went)) throw new Error('в Ад не прошёл')
  }
  for (let i = 0; i < 6 && !known.fortress; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    await spares(260)
    await netherFillers()
    const f = await act('fortress', { timeoutSeconds: 300, ...(SCOUT_HIGH ? { high: true } : {}) })
    if (f.detail && f.detail.found) known.fortress = f.detail.fortress || true
  }
  for (let i = 0; i < 3 && rodsWanted() && known.fortress; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    // ND_BLZ_FR_RESERVE (blz 21.10): последнее FR ушло на бой у трона, зелья нет — обратно к трону без FR не идти: открытый бой без FR
    // — смерть (0 доставленных стержней из ~33 сцен; di-s19-3: 5 стержней, к спавнеру без FR — сгорел). Пауза до зелья (бартер/сток).
    // Остаток FR < 60 с без зелий — тоже: новый подход к трону кончится без FR посреди ифритов (gB11-s19-1: бой прерван на 8 убийствах,
    // нора, «к спавнеру» с остатком FR — сгорел у трона).
    // Ждать у трона под шарами нечего (mS11-s19-1, hC12-s18-1: «жду зелья» в 5–7 бл. от ифритов — сгорел): домой с тем, что есть;
    // этап снова — когда появится зелье (blazeFrPaused снимается).
    if (process.env.ND_BLZ_FR_RESERVE === '1' && fireResNow() === 0) log(`FR перед подходом: зелий 0, эффект ${state.fireResistance ? 'да' : 'нет'}, ${state.fireResistanceSec ?? '?'} с, бой с FR был ${blazeFrSpentAt ? 'да' : 'нет'}`)
    if (process.env.ND_BLZ_FR_RESERVE === '1' && process.env.ND_BLZ_DODGE !== '1' && (blazeFrSpentAt || fireResNow() === 0 && (state.fireResistance || have('glass_bottle') > 0)) && fireResNow() === 0 && (!state.fireResistance || (state.fireResistanceSec ?? 999) < 60)) {
      if (!blazeFrSpentAt) blazeFrSpentAt = gameClock.now()
      log(`к трону без огнестойкости не иду: зелий нет${state.fireResistance ? `, FR на ${state.fireResistanceSec} с` : ''} — домой со стержнями: ${have('blaze_rod')}`)
      await returnFromNether()
      return
    }
    if (!have(/^(stone|iron|diamond|netherite)_pickaxe$/)) await spares(200)
    if (!fightReady()) {
      log(`бой у спавнера: не хватает ${fightLack()} — сохраняю добытые стержни`)
      return
    }
    if (!(await fedForBlazes())) { log('сытость не восстановилась — путь к спавнеру не начинаю'); return }
    if (!netherSupply.netherToolsReady(netherSupplyState())) {
      // Запас 260 взмахов — цена, а не ворота (ND_BLZ_TOOLS_PRICE=1; bz04-s19-1 21.10: у крепости 74 взмаха, «нет безопасного дерева
      // на крафт» ×N — к спавнеру в 30 бл. не пошёл). Хватает на ход к крепости и домой с запасом — пополнение (до 240 с) не жду.
      const sw = netherSupplyState().pickSwings || 0
      const P = known.netherPortal
      const fortFar = known.fortress && known.fortress.x != null && state.pos ? Math.hypot(known.fortress.x - state.pos.x, known.fortress.z - state.pos.z) : 64
      const homeFar = P && known.fortress && known.fortress.x != null ? Math.hypot(known.fortress.x - P.x, known.fortress.z - P.z) : fortFar
      // ND_BLZ_TOOLS_NEAR=1: спавнер увиден в 48 бл. — до боя взмахов почти не нужно (бой — меч), домой — своим ходом/следом: цена пути
      // 30, а не 40 + до крепости + домой (bz12-s18-3 21.10: спавнер в 10 бл., 130 взмахов — ушёл искать стебли на кирки, шары ×3, смерть).
      // Иначе путь по видимому — полвзмаха на блок (обход дешевле копки, ND_BLZ_DIG_PRICE).
      const spSeen = memorySnapshot?.places?.['спавнер блейзов']
      const spDist = spSeen && state.pos ? Math.hypot(spSeen.x - state.pos.x, spSeen.z - state.pos.z) : Infinity
      const swNeed = process.env.ND_BLZ_TOOLS_NEAR === '1'
        ? (spDist <= 48 ? 30 : Math.min(260, Math.round(20 + 0.5 * (fortFar + homeFar))))
        : Math.min(260, Math.round(40 + fortFar + homeFar))
      if (process.env.ND_BLZ_TOOLS_PRICE === '1' && sw >= swNeed) log(`инструменты Ада: ${sw} взмахов при цене пути ${swNeed} (к крепости ${Math.round(fortFar)} + домой ${Math.round(homeFar)}) — к спавнеру без пополнения`)
      else {
        const supply = await replenishNetherSupply()
        if (!supply.ready) { log(`путь к спавнеру отложен: ${supply.reason}`); return }
      }
    }
    await spares(200)
    await netherFillers()
    const spFar = known.fortress && known.fortress.x != null && state.pos ? Math.hypot(known.fortress.x - state.pos.x, known.fortress.z - state.pos.z) : 0
    if (!have('bow') && have('string') >= 3) { await sticks(3); await craft('bow'); await refresh() }
    // Уже у спавнера (в яме у помоста или в 8 бл. на его уровне) — подход не нужен: fortress уводил из ямы под ифритов.
    const spHere = memorySnapshot?.places?.['спавнер блейзов']
    // В 40 бл. от спавнера подход ведёт сам blaze (ход по сетке под защитой навыка, с огнестойкостью и отбоем), а не fortress:
    // последний отрезок fortress рвала тактика, тело доходило с 6–10 хп (s1-LC-1/LD-1 06.10, крепость в 2–24 бл. от входа).
    const atSpawner = !!(spHere && state.pos && Math.hypot(spHere.x - state.pos.x, spHere.z - state.pos.z) <= 40 && Math.abs(spHere.y - state.pos.y) <= 24)
    // Спавнер известен (карта копии), а до него > 40 бл. — сперва ходом по сетке до 36 бл., дальше — blaze (см. выше).
    if (!atSpawner && spHere && state.pos && process.env.ND_NE_ROUTE === '1' && Math.hypot(spHere.x - state.pos.x, spHere.z - state.pos.z) > 40) {
      // Огнестойкость — бою у спавнера: ход не пьёт зелья (frKeep 3, как fortress), s1-LE-3 06.10 — 2 зелья ушли на ход, на бой одно.
      await goToward({ x: spHere.x, y: spHere.y, z: spHere.z }, 36, 3)
      await refresh()
      if (died || dim() !== 'the_nether') return
      if (state.pos && Math.hypot(spHere.x - state.pos.x, spHere.z - state.pos.z) <= 40) { i--; continue }
    }
    const needsView = process.env.ND_FORTRESS_FRONTIER !== '0' && netherSearchFailure && netherSearchFailure.observed === netherRetryState(netherSearchFailure.origin)
    if (!atSpawner && needsView && netherSearchFailure.exhausted) throw new Error('крепость: видимые выходы исчерпаны, нужен новый путь или обзор')
    // ND_BLZ_SEEN_FIGHT=1 (blz 21.10): ифриты уже видны рядом (2+ в 20 бл. или один в 12) — бой отсюда сразу, без обхода крепости
    // под их шарами: обход «у крепости спавнера не видно» рвала тактика, тело стояло у подножия трона без боя и без зелья до смерти
    // (nS15-s19-1: 5 ифритов в 5–15 бл., 0 боёв за 10 мин; nA11-s17-1). Навык blaze сам лезет на помост к ним.
    if (process.env.ND_BLZ_SEEN_FIGHT === '1' && !atSpawner && !needsView) await sense()
    const seenBz = process.env.ND_BLZ_SEEN_FIGHT === '1' && !atSpawner && !needsView ? (sit.fight?.order || []).filter(o => o && o.name === 'blaze' && o.dist <= 20) : []
    const seenNearest = seenBz.length ? Math.round(Math.min(...seenBz.map(o => o.dist))) : 99
    const s = atSpawner ? { detail: { reached: true, spawner: { x: spHere.x, y: spHere.y, z: spHere.z }, dist: 0 } } as any
      : (seenBz.length >= 2 || seenNearest <= 12) ? { detail: { blazes: { seen: seenBz.length, nearest: seenNearest } }, stopped: 'ифриты видны рядом' } as any
      : await act('fortress', needsView ? { mode: 'advance', timeoutSeconds: 90 }
        : { mode: 'spawner', timeoutSeconds: Math.min(600, 300 + Math.round(spFar / 2)), ...(process.env.ND_SPAWNER_TUNNEL === '1' ? { tunnel: true } : {}) })
    if (!atSpawner && needsView) {
      await readMemory()
      if (!died && dim() === 'the_nether' && netherSearchFailure.observed !== netherRetryState(netherSearchFailure.origin)) { i--; continue }
      netherSearchFailure.exhausted = s.detail?.frontierExhausted === true
      return
    }
    // Не «дошёл», но спавнер в 24 бл. (ифриты уже бьют: s1-post01b 06.10 — 15 бл. над спавнером, подход рвала тактика,
    // кампания шла домой и умерла) — бой отсюда: blaze сам ищет точку боя и стреляет из лука.
    const spAt = (s.detail && s.detail.spawner) || memorySnapshot?.places?.['спавнер блейзов'] || null
    const spNear = !!(spAt && state.pos && Math.hypot(spAt.x - state.pos.x, spAt.z - state.pos.z) <= 24 && Math.abs(spAt.y - state.pos.y) <= 24)
    // S1f (вслепую): спавнер не увиден, но обход крепости видел ифритов рядом (≤ 24 бл.) — бой с ними отсюда: ифриты держатся у спавнера,
    // навык blaze бьёт видимых и сам ищет спавнер (s1f-A2-3: тело под тронным залом, ифриты били — смерть без боя на 19-й мин).
    // ND_BLAZE_SEEN=0 — прежнее (только у спавнера).
    // ND_BLZ_FR_BUDGET: последнее зелье FR — бою у трона: 1–2 дальних бродячих ифрита без спавнера — не бой отсюда (di-s19-2: «ифриты
    // видны (1, в 22 бл.)» у портала — зелье выпито, иссушитель и шары, смерть), а дальше к спавнеру; ближний (≤ 16) или 2+ — бой (nA11-s17-1:
    // ифриты в 12–16 бл. били с трона, а бой не начинался — 5 мин под шарами).
    const bzSeen = s.detail?.blazes
    const budget = process.env.ND_BLZ_FR_BUDGET === '1' && fireResNow() <= 1 && !state.fireResistance
    const blazesNear = process.env.ND_BLAZE_SEEN !== '0' && !!(bzSeen && bzSeen.seen > 0 && bzSeen.nearest <= 24 && (!budget || bzSeen.nearest <= 16 || bzSeen.seen >= 2))
    if (!(s.detail && s.detail.reached) && !spNear && !blazesNear) {
      if (process.env.ND_FORTRESS_FRONTIER !== '0') setNetherSearchFailure({ observed: netherRetryState(), origin: state.pos && { ...state.pos }, exhausted: false })
      log(`к спавнеру не дошёл: ${String((s.detail && s.detail.stopped) || s.error || '').slice(0, 120)}`); break
    }
    setNetherSearchFailure(null)
    if (!(s.detail && s.detail.reached)) log(`к спавнеру не дошёл (${String((s.detail && s.detail.stopped) || s.error || '').slice(0, 80)}), но ${spNear ? 'он в 24 бл.' : `ифриты видны (${s.detail.blazes.seen}, ближний в ${s.detail.blazes.nearest} бл.)`} — бой отсюда`)
    else log(`у спавнера ${JSON.stringify(s.detail.spawner)} (${s.detail.dist} бл.)`)
    if (!(await fedForBlazes())) { log('сытость не восстановилась — бой с блейзами не начинаю'); return }
    if (!have('bow') && have('string') >= 3) { await sticks(3); await craft('bow'); await refresh() }
    // Коробка с окном — укрытие боя без огнестойкости (ифрит стреляет только по лучу); под огнестойкостью — открытый бой.
    const bz = await act('blaze', { rods: Math.max(1, have('blaze_rod') + rodsShort()), timeoutSeconds: 400, ...(fireResReady() ? { box: false } : {}), ...(have('bow') ? { allowRanged: true } : {}) })
    // blaze закопался на месте (яма 2 вниз с крышкой) — ne_burrow уже не нужен: он уводил тело из ямы под ифритов.
    if (bz && bz.detail && bz.detail.dugIn) { setBlazeDugInAt(gameClock.now()); setBlazeDugInPos(bz.detail.dugIn.at || null) }
    await refresh()
    log(`стержней: ${have('blaze_rod')}`)
    // S1e: «ифриты за стеной, доступной точки обзора нет» раз за разом (s1e-B0-4: 20+ игр. мин вызовов blaze по 1–3 мин, 0 стержней,
    // тело на 4 бл. ниже помоста) — после двух таких подряд заново к спавнеру штреком со вскрытием стены зала (fortress tunnel+breach),
    // а не тот же вызов с того же места.
    const bzd = (bz && bz.detail) || {}
    if (fireResNow() === 0 && (/огнестойкость (на исходе|кончилась)/.test(String(bzd.stopped || bz?.error || '')) || state.fireResistance || Number(bzd.kills) > 0)) blazeFrSpentAt = gameClock.now()
    if (bzd.clearing?.length) log(`расчистка спавнера: ${bzd.clearing.filter(r => r.ok).length}/${bzd.clearing.length}, прогноз экономии ${Math.round(bzd.clearing.reduce((s, r) => s + (r.ok ? r.savedSeconds - r.costSeconds : 0), 0))}с; результат — по стержням и урону`)
    blazeNoView = /доступной точки обзора нет/.test(String(bzd.stopped || '')) && !(Number(bzd.kills) > 0) ? blazeNoView + 1 : 0
    if (blazeNoView >= 2 && rodsWanted() && dim() === 'the_nether' && !died) {
      log(`ифриты за стеной ${blazeNoView}-й вызов подряд — к спавнеру штреком со вскрытием зала`)
      await act('fortress', { mode: 'spawner', tunnel: true, breach: true, timeoutSeconds: 300 })
      await refresh()
      if (blazeNoView >= 4) { log('за стеной и после штрека — этап ифритов отдаю графу'); blazeNoView = 0; return }
    }
    // Без огнестойкости бой продолжается (навык blaze сам держит щит на залп, коробку с окном, отход и возврат) — решение
    // пользователя 06.10 22:33. Закопаться — только когда навык вернул тело с малым хп и сам не ушёл в толщу.
    if (rodsWanted() && (state.health ?? 20) < 10 && !(bz && bz.detail && bz.detail.dugIn) && dim() === 'the_nether' && !died) { log(`хп ${Math.round(state.health ?? 0)} у спавнера — закапываюсь лечиться`); await act('ne_burrow', { why: 'мало хп у спавнера' }); await refresh(); break }
    // Огнестойкость кончилась, а её можно добыть (бастион в работе или золото на руках) — решает граф по цене: купить FR
    // (AcquireFireResistance) или бой без неё; не крутить вызовы blaze без FR внутри этапа (s1c-I-6 06.10: 12 жемчуга к 11.5 мин,
    // FR кончилась после 1 стержня, 4 вызова без FR — 3 стержня и смерть на 30.9 мин).
    if (rodsWanted() && !fireResReady() && bz && (activeBastion() || have('gold_ingot') + 9 * have('gold_block') >= 8) && dim() === 'the_nether' && !died) {
      log('огнестойкость кончилась — решает граф: купить её или бой без неё')
      if (!(bz.detail && bz.detail.dugIn)) await act('ne_burrow', { why: 'FR кончилась — к решению графа' })
      await refresh()
      break
    }
    // Набрал — сразу в толщу (ифриты у спавнера остаются; после этапа граф молчит из-за угрозы, а тактика у спавнера гибнет).
    if (!rodsWanted() && dim() === 'the_nether' && !died && gameClock.now() - blazeDugInAt > 60000) { log('стержни набраны — закапываюсь от ифритов'); await act('ne_burrow', { why: 'стержни набраны — ухожу от ифритов' }); await refresh(); break }
    if ((state.health ?? 20) < 10) break
  }
})
let blazeNoView = 0
let blazeFrSpentAt = 0
// ND_BLZ_FR_RESERVE: последнее FR ушло на бой, зелья нет — этап ифритов на паузе до зелья (бартер/сток); loop/select не зовёт его
// «боем у спавнера» по угрозе.
export function blazeFrPaused () {
  return process.env.ND_BLZ_FR_RESERVE === '1' && process.env.ND_BLZ_DODGE !== '1' && !!blazeFrSpentAt && fireResNow() === 0 && (!state.fireResistance || (state.fireResistanceSec ?? 999) < 60)
}
