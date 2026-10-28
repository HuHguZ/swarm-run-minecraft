'use strict'
// Выбор шага хода: нужные этапы, граф (intelligence.select), домой из Ада за недостающим, срочная еда, ожидание угрозы в Аду.
import { only, EYES_NEED } from '../flags'
import { state, sit, memorySnapshot, died, known, fightGearWanted, homeForGearState, blazeDugInAt, setBlazeDugInAt,
  setHomeForGearState, setStage } from '../state'
import { log } from '../log'
import { refresh } from '../observe'
import { have, dim, pearlsNow, foodUnits, goldOn } from '../queries'
import { STAGES, OTHER_WORLD, weakAndHungry, READY, netherLack, fightReady, fightLack, stageRun } from '../stages/table'
import { eyesWant, bastionPearlsPending, rodsWanted, netherRetryState } from '../nether-plan'
import { act } from '../act'
import { leaveWater } from '../danger'
import { returnFromNether } from '../travel'
import { craft, ensurePick } from '../kit'
import { continueFortressChoice, replenishNetherSupply, goldUp } from '../nether-trip'
import { intelligence } from '../strategy-bridge'
import type { CampaignTurn, TurnFlow } from './turn'
import * as gameClock from '../../src/game-clock'

let homeWaits = 0
let goldUpAt = -Infinity
async function loopSelect (loop: CampaignTurn): Promise<TurnFlow | { need: any[], s: any }> {
  const { fails, failureKey, cooling } = loop
  if (only && dim() !== 'overworld' && !have(/_pickaxe$/)) { setStage('-'); await ensurePick() }
  // ND_BAST_GOLD_ON=1 (поток bast 27.10): в Аду золото на ботинки есть (самородки, слитки, блок) — надеть до любого шага: граф
  // торговал без брони (b0f слот 12: 32 слитка), 43 самородка ждали 4 мин поиска крепости до смерти (b0s слот 13).
  if (process.env.ND_BAST_GOLD_ON === '1' && dim() === 'the_nether' && !goldOn() &&
      have('gold_ingot') + 9 * have('gold_block') + Math.floor(have('gold_nugget') / 9) >= 4 && gameClock.now() - goldUpAt > 60000) {
    goldUpAt = gameClock.now(); setStage('-'); await goldUp()
  }
  const need = STAGES.filter(s => !(only && !only.includes(s.name)) && s.needed() && (dim() === 'overworld' || OTHER_WORLD.has(s.name)))
  const selection = only ? null : await intelligence.select(need, cooling, name => cooling({ name }))
  if (selection) homeWaits = 0
  if (await continueFortressChoice(selection, fails.get(failureKey('nether')))) return 'continue'
  if (!selection && dim() === 'the_nether' && !bastionPearlsPending() && need.some(s => s.name === 'nether') && (!READY.nether() || (fightGearWanted && !fightReady())) &&
      homeForGearState?.observed !== netherRetryState(homeForGearState?.origin)) {
    setStage('-')
    // ND_NE_HOME_PRICE=1 (поток ne 21.10, выкл.): «домой за недостающим» — ход по цене, а не ворота (правило гибкости). 0 кирок — сперва
    // кирка в Аду (стебли → доски → палки, блэкстоун/булыжник: nether-supply); не хватает только еды «на ифритов» (порог 6 ед., не
    // физика), а жемчуг ещё нужен — дело в Аду по графу, наверх не идти (17 прогонов b86/c92/c94/d94 уходили наверх на 3–13-й мин,
    // наверху — смерть на этапе wood).
    if (process.env.ND_NE_HOME_PRICE === '1') {
      const PICK = /^(stone|iron|diamond|netherite)_pickaxe$/
      if (!have(PICK) && (state.health ?? 20) >= 12) {
        log('кирок нет — сперва кирка из того, что есть в Аду (стебли, блэкстоун), домой — только если не выйдет')
        const supply = await replenishNetherSupply()
        await refresh()
        if (died || dim() !== 'the_nether') return 'continue'
        if (have(PICK)) { log(`кирка в Аду: ${supply.ready ? 'запас пополнен' : supply.reason || 'есть'} — домой не иду`); return 'continue' }
      }
      // Не вечно: 6 ожиданий подряд без выбора графа (≈ 30 с и больше) — прежний ход домой.
      if (have(PICK) && pearlsNow() < eyesWant() && (state.health ?? 20) >= 10 && foodUnits() >= 1 && homeWaits++ < 6) {
        log(`на ифритов не хватает ${netherLack()}, но жемчуг нужен (${pearlsNow()}/${eyesWant()}) и хп ${Math.round(state.health ?? 0)} — домой не иду, дело в Аду`)
        await act('ne_burrow', { why: 'граф молчит — жду смены причины в толще' })
        await act('wait', { seconds: 5 })
        return 'continue'
      }
    }
    log(`для ифритов не хватает ${fightGearWanted ? fightLack() : netherLack()} — домой за недостающим`)
    await returnFromNether()
    if (dim() === 'the_nether') {
      await act('ne_burrow', { why: 'домой не вышло' })
      setHomeForGearState({ observed: netherRetryState(), origin: state.pos && { ...state.pos } })
    }
    return 'continue'
  }
  if (!selection && !need.length && dim() === 'the_nether') {
    setStage('-')
    log('в Аду делать нечего (кирки нет или стержни есть) — домой через портал')
    await returnFromNether()
    return 'continue'
  }
  if (!selection && !need.length) {
    setStage('-')
    if (known.dragonWon) { log('все этапы готовы'); return 'break' }
    if (only) { log(`нужных этапов нет среди ${only.join(',')} — запуск окончен (дракон жив: жемчуга ${pearlsNow()} из ${EYES_NEED}, очей ${have('ender_eye')})`); return 'break' }
    log(`нужных этапов нет, а дракон жив (жемчуга ${pearlsNow()} из ${EYES_NEED}, очей ${have('ender_eye')}) — жду перемены, остановит сторож`)
    if (dim() === 'overworld') await leaveWater()
    await act('wait', { seconds: 60 })
    return 'continue'
  }
  const foodFail = fails.get('food')
  const urgentOk = x => !cooling(x) || ((process.env.ND_OW_PAUSE_CAUSE !== '1' || dim() !== 'overworld') &&
    (!foodFail || gameClock.now() - (foodFail.at || 0) > 90000))
  const urgent = weakAndHungry() ? need.find(x => x.name === 'food' && urgentOk(x) && x.ready() && !x.defer()) : null
  const legacy = only && (urgent || need.find(x => !cooling(x) && x.ready() && !x.defer()))
  const s = legacy ? (only ? legacy : intelligence.wrap(legacy)) : selection?.stage
  if (!s && dim() === 'the_nether' && (state.tactics?.threatLevel ?? 0) >= 2 && loop.netherThreatWaits < 20 && !died) {
    await loopNetherThreat(loop)
    return 'continue'
  }
  if (s || (state.tactics?.threatLevel ?? 0) < 2) loop.netherThreatWaits = 0
  return { need, s }
}

async function loopNetherThreat (loop: CampaignTurn): Promise<void> {
  // Граф молчит из-за угрозы (intelligence.select: threatLevel ≥ 2) — не повод идти домой: путь к порталу под
  // ифритами рвёт тактика и тело гибнет на ходу (s1-post01b 06.10). Ифриты, а стержни нужны — бой у спавнера;
  // иначе короткое ожидание, пока тактика не снимет угрозу.
  loop.netherThreatWaits++
  setStage('-')
  // У спавнера (в 24 бл. по памяти) угроза — это ифриты, даже если sit.fight их не перечислил: бой ведёт blaze, а не тактика
  // (s1-post21hole 06.10: навык вернулся по времени с 3 стержнями, кампания ждала тактику у спавнера — смерть).
  const spMem = memorySnapshot?.places?.['спавнер блейзов']
  const nearSpawner = !!(spMem && state.pos && dim() === 'the_nether' && Math.hypot(spMem.x - state.pos.x, spMem.z - state.pos.z) <= 24 && Math.abs(spMem.y - state.pos.y) <= 24)
  const blazes = (sit.fight?.order || []).some(o => o && o.name === 'blaze') || nearSpawner
  if (blazes && rodsWanted() && !bastionPearlsPending() && known.fortress && fightReady() && !(require('../stages/nether') as typeof import('../stages/nether')).blazeFrPaused()) {
    log('ифриты рядом, стержни нужны — бой у спавнера, а не путь домой')
    setStage('nether')
    try { await stageRun('nether')() } catch (e) { if (e.stopCampaign) throw e; log(`бой у спавнера: ${e.message}`) }
  } else if (dim() === 'the_nether' && known.netherPortal && state.pos && Math.hypot(known.netherPortal.x - state.pos.x, known.netherPortal.z - state.pos.z) <= 6 &&
    !rodsWanted() && have('ender_eye') + have('ender_pearl') >= eyesWant()) {
    // У портала домой, всё собрано — угроза не повод ждать: вход в портал и есть уход (s1-LG-10 06.10: 5 стержней, 10 очей,
    // «прервано у портала», 7 мин ожидания тактики у рамы — смерть).
    log('у портала домой, всё собрано — ухожу через портал, не жду тактику')
    await act('portal', { mode: 'enter', timeoutSeconds: 60 })
  } else if (dim() === 'the_nether' && gameClock.now() - blazeDugInAt < 300000 && !rodsWanted()) {
    // В яме у спавнера после «набрал» граф молчит из-за угрозы (ифриты видны в открытый верх), а ожидание кончалось шарами
    // после конца FR (s1-LL-6 06.10: 5 стержней, яма без крышки, «жду её конца» — смерть). Очи — крафт в рюкзаке прямо в
    // яме; готово — домой ходом (у спавнера план идёт штреком, expoMul).
    if (have('ender_eye') < eyesWant() && have('ender_pearl') > 0 && have('blaze_rod') + have('blaze_powder') > 0) {
      log('в яме у спавнера: крафт очей, не жду тактику')
      const want = Math.min(eyesWant() - have('ender_eye'), have('ender_pearl'))
      if (have('blaze_powder') < want) await craft('blaze_powder', Math.min(2 * have('blaze_rod'), want - have('blaze_powder') + 1))
      await craft('ender_eye', Math.min(want, have('blaze_powder')))
    } else {
      log('в яме у спавнера, всё собрано — домой, не жду тактику')
      setBlazeDugInAt(-Infinity)
      await returnFromNether()
    }
  } else if (nearSpawner && !rodsWanted() && loop.netherThreatWaits <= 2 && gameClock.now() - blazeDugInAt > 60000) {
    // Стержни набраны, а у спавнера ифриты — в толщу, а не ждать тактику (s1-LE-4 06.10: 5 стержней на 5-й мин, затем LastStand/
    // BlockOff у спавнера — смерть через секунды).
    log('стержни набраны, у спавнера ифриты — закапываюсь')
    await act('ne_burrow', { why: 'стержни набраны — ухожу от ифритов' })
  } else if (loop.netherThreatWaits >= 2 && (gameClock.now() >= loop.threatBurrowAt || (state.health ?? 20) <= loop.threatHp0 - 3) &&
    ((state.health ?? 20) <= loop.threatHp0 - 3 || (sit.fight?.order || []).some(o => o && /^(blaze|ghast)$/.test(o.name)))) {
    // Угроза не снимается, а тело на открытом теряет хп или по нему стреляют издалека (ифриты/гасты у портала прибытия, b1-6-2
    // 14.10: 12 ожиданий по 3 с под огнём ифритов, хп 20 → 2, смерть) — из-под огня в толщу (закрытый карман), а не ждать.
    // Снова — через 15 с или сразу, если хп падает и после норы (b8-5-1 14.10: нора в 22-й мин, через 2 мин ифриты снова,
    // пауза 60 с держала тело в ожиданиях под огнём, хп 20 → 0).
    loop.threatBurrowAt = gameClock.now() + 15000
    log(`в Аду угроза держится (${loop.netherThreatWaits} ожиданий, хп ${Math.round(loop.threatHp0)} → ${Math.round(state.health ?? 0)}) — в толщу, из-под огня`)
    await act('ne_burrow', { why: 'угроза держится — из-под огня' })
    loop.threatHp0 = state.health ?? 20
  } else {
    if (loop.netherThreatWaits === 1) loop.threatHp0 = state.health ?? 20
    log(`в Аду угроза (тактика ${state.tactics?.action || '?'}) — домой не иду, жду её конца`)
    await act('wait', { seconds: 3 })
  }
}

export { loopSelect }
