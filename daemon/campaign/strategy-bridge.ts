'use strict'
// Мост к стратегии (src/campaign/intelligence): наблюдение для графа и исполнение его команд.
import { EYES_NEED, BEDS_END, END_PREP_PRICE } from './flags'
import { call, sleep } from './rpc'
import { T0, stage, strategyInterrupted, state, sit, died, known, netherExplored, quickHuntAt, lavaSourceKnown,
  routeStructureSeconds, bastionGoldDug, bastionIngotsTraded, barterZero, setBarterZero, setBastionIngotsTraded,
  setQuickHuntAt, setRouteDeadline, setRouteStructureSeconds, setStage, setStrategyExecuting, setStrategyInterrupted,
  setStrategyTail } from './state'
import { telemetry, log } from './log'
import { have, dim, foodUnits, lighter, fireResNow, fireResReady } from './queries'
import { sense, refresh, readMemory } from './observe'
import { STAGES, READY, DONE, stageRun } from './stages/table'
import { EXIT_KIT, pendingExitFrame, obsShort, eyesWant, nextBastion, activeBastion, barterExhausted, barterSite,
  bastionSearchWanted, bastionPearlsPending, netherRetryState, endermenSecondsPerPearl, netherSupply,
  netherSupplyState } from './nether-plan'
import { act } from './act'
import { rest } from './guards'
import { returnFromNether } from './travel'
import { eatTo, craft } from './kit'
import { spendIron } from './gear'
import { quickHunt } from './food'
import { ensureFlint } from './portal-kit'
import { dayLavaStep, lavaLookout, skyLavaLook, lavaAtSeenRuins, structureValue, dayLeft } from './scout'
import { routeMod, routeStep } from './route-wiring'
import { enterNether, replenishNetherSupply } from './nether-trip'
import { checkEndEntry, SH_NETHER, canLink } from './endgame'
import * as gameClock from '../src/game-clock'
import { createCampaignIntelligence } from '../src/campaign/intelligence'
import type { ExecutionResult } from '../src/core/environment'
const graphFacts: Record<string, import('../src/core/world-state').Fact> = {}
const graphFact = (name: string, value: import('../src/core/world-state').FactValue | null, source: import('../src/core/world-state').FactSource = 'observed') => { graphFacts[name] = { status: value === null ? 'unknown' : 'known', value, source, at: gameClock.now(), confidence: value === null ? 0 : 1 } }
let strategyMap
function campaignMap () {
  // ND_MAP=0 — вслепую (S8b 07.10): сид идёт в телеметрию, но постройки копии графу не даются.
  if (strategyMap === undefined) strategyMap = routeMod && process.env.ND_WORLD_SEED && process.env.ND_MAP !== '0' ? routeMod.routeInfo(process.env.ND_WORLD_SEED) : null
  return strategyMap
}
async function intelligenceObservation () {
  await refresh()
  await sense()
  await readMemory()
  graphFact('nether_ready', READY.nether())
  graphFact('nether_tools_ready', netherSupply.netherToolsReady(netherSupplyState()))
  graphFact('nether_pick_swings', sit.pickLeft ?? 0)
  graphFact('fortress_explored', netherExplored)
  if (process.env.ND_NE_RECOVER === '1') graphFact('nether_search_state', netherRetryState())
  graphFact('fire_resistance_count', fireResNow())
  graphFact('fire_resistance_active', state.fireResistance === true || state.tactics?.state?.fireResistance === true)
  graphFact('bastion_gold_dug', bastionGoldDug)
  graphFact('bastion_traded', bastionIngotsTraded)
  graphFact('barter_exhausted', barterExhausted())
  // Огнестойкость — не допуск к ифритам, а риск/цена GetBlazeRods в графе (speedrun.ts, решение пользователя 06.10 22:33).
  graphFact('blaze_allowed', !bastionPearlsPending())
  graphFact('end_ready', DONE.endkit())
  graphFact('endermen_seconds_per_pearl', Math.round(endermenSecondsPerPearl()))
  graphFact('bastions_exhausted', !activeBastion() && !bastionSearchWanted())
  const next = nextBastion()
  if (next) {
    graphFact('bastion', true, 'map')
    graphFact('bastion_position', { x: next.x, y: next.y ?? 64, z: next.z }, 'map')
  }
  if (!nextBastion() && !bastionSearchWanted()) graphFact('bastion', false)
  return { state, situation: sit, known, facts: graphFacts, map: campaignMap(), elapsedMs: gameClock.now() - T0, structureSearchMs: routeStructureSeconds * 1000 }
}
const lavaScoutCells = new Set<string>()
let lavaScoutViews = 0
async function executeStrategy (command, signal) {
  if (signal.aborted) return { outcome: 'INTERRUPTED', reason: String(signal.reason), events: [] }
  setStrategyExecuting(true)
  setStrategyInterrupted(false)
  const onAbort = () => { setStrategyInterrupted(true) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const skill = command.skill
    if (skill === 'structureIron') {
      const place = String(command.params.kind)
      const mapKey = { village: 'village', shipwreck: 'ship', treasure: 'treasure' }[place]
      const at = campaignMap()?.[mapKey] || graphFacts[`${place}_position`]?.value
      if (!at) return { outcome: 'FAILURE', reason: 'постройка без известного места', events: [] }
      const left = Math.max(0, 180 - routeStructureSeconds)
      log(`граф ${command.strategy}: постройки ${Math.round(routeStructureSeconds)}/180 с, осталось ${Math.floor(left)} с; затем руда`)
      const t0 = gameClock.now()
      setRouteDeadline(t0 + left * 1000)
      const oldStage = stage
      setStage('route')
      let visited = false
      try { visited = await routeStep({ kind: mapKey, at, id: command.strategy, budget: left }) }
      finally {
        setRouteStructureSeconds(routeStructureSeconds + ((gameClock.now() - t0) / 1000))
        setRouteDeadline(0)
        setStage(oldStage)
      }
      if (!visited && !strategyInterrupted) return { outcome: 'FAILURE', reason: 'подход или посещение постройки не завершены', events: [] }
      if (visited && !strategyInterrupted) graphFact(`${place}_exhausted`, true)
    } else if (skill === 'scoutStructures') {
      // Хвост шага разведки за сумерками (11840) — секунды поверху ночью по цене structure-value.NIGHT_SECONDS (в воде — вдвое)
      // против выгоды шага вслепую (находка в одном шаге — редкость: 99 «бюджет исчерпан» из ~160 разведок фермы): дороже —
      // разведка встаёт, дальше работа внизу. g1-1 14.10: шаг на 10857, урон от скелета на 11473; g2-s2-1: сундук под водой
      // на 11528 (40 с, «не дотянуться»), сумерки в воде — утопленники.
      let dusk = false
      const lateBy = (seconds, wet = false) => Math.max(0, seconds - dayLeft()) * structureValue.NIGHT_SECONDS * (wet ? 2 : 1)
      const search = await require('../src/campaign/structure-search').scoutStructures({
        now: () => gameClock.now(), position: () => state.pos,
        scan: async () => { await act('structure', { mode: 'scan', radius: 96 }) },
        list: async () => ((await act('structure', { mode: 'list' })).detail?.known || []).map(entry => ({ ...entry,
          done: entry.done || graphFacts[`${entry.kind === 'buried_treasure' ? 'treasure' : entry.kind}_exhausted`]?.value === true })),
        explore: async (direction, timeoutSeconds) => {
          // Звери на виду по пути разведки — как спидраннер: еда сейчас, а не после голода (g3-s1-2 14.10: разведка 4 × 30 с
          // поверху, сытость 20 → 13, еды 0 — ночью NO_FOOD, хп не лечится; свиньи — только на 20-й мин).
          if (foodUnits() < 4 && gameClock.now() >= quickHuntAt) { setQuickHuntAt(gameClock.now() + 90000); await quickHunt() }
          await sense()
          const risk = lateBy(timeoutSeconds)
          if (risk > 10) { dusk = true; log(`разведка построек: шаг ${direction} кончится в сумерках — ночь поверху ≈ ${Math.round(risk)} с дороже шага вслепую, дальше внизу`); return undefined }
          return (await act('explore', { block: 'bell,chest,barrel', radius: 48, stepDistance: 60, direction, timeoutSeconds, dry: true, surface: true, unlootedContainers: true })).detail
        },
        loot: async (at, timeoutSeconds) => {
          await sense()
          // Сундук, увиденный поверху ниже уровня моря (62) на 2+, — почти всегда под водой (корабль, руины): нырок.
          const wet = Number.isFinite(at.y) && at.y < 60
          const risk = lateBy(Math.min(timeoutSeconds, wet ? 40 : 20), wet)
          if (risk > 30) { dusk = true; log(`разведка построек: сундук ${at.x},${at.y},${at.z}${wet ? ' под водой' : ''} — заход кончится в сумерках (≈ ${Math.round(risk)} с риска), мимо`); return false }
          return Object.values((await act('loot', { ...at, visibleOnly: true, timeoutSeconds })).detail?.took || {}).some(n => Number(n) > 0)
        },
        move: async (at, timeoutSeconds) => { await act('goto', { ...at, range: 6, surface: 'strict', timeoutSeconds }) },
        interrupted: () => signal.aborted || strategyInterrupted || died || dusk, fact: graphFact, log
      }, routeStructureSeconds * 1000)
      setRouteStructureSeconds(search.spentMs / 1000)
      if (search.blocked) return { outcome: 'FAILURE', reason: 'путь поиска построек заблокирован до исчерпания бюджета', events: [] }
    } else if (skill === 'netherTools') {
      const supply = await replenishNetherSupply()
      if (!supply.ready) return { outcome: supply.interrupted ? 'INTERRUPTED' : 'FAILURE', reason: supply.reason, events: [] }
    } else if (skill === 'bastionSupply') {
      if (have('gold_block') && have('gold_ingot') < 8) await craft('gold_ingot', 9 * have('gold_block'))
      if (have('gold_ingot') >= 8) {
        const barter = await act('bastion', { ...barterSite(), mode: 'barter', pearls: have('ender_pearl'), fireRes: 1, timeoutSeconds: 540, sealed: true })
        setBastionIngotsTraded(bastionIngotsTraded + (Number(barter.detail?.ingotsTraded) || 0))
      }
      await refresh()
      if (!fireResReady() && nextBastion()) await stageRun('bastion')()
    } else if (skill === 'portalKit') {
      await spendIron()
      if (!have(/bucket$/) && have('iron_ingot') >= 3) await craft('bucket')
      if (!lighter()) await ensureFlint()
    } else if (skill === 'scoutLava') {
      const cell = () => state.pos && [dim(), ...['x', 'y', 'z'].map(axis => Math.floor(state.pos[axis] / 16))].join(':')
      if (cell()) lavaScoutCells.add(cell())
      if (!(await dayLavaStep())) {
        await skyLavaLook()
        if (!known.lava) await lavaLookout()
        if (!lavaSourceKnown) await lavaAtSeenRuins()
        await act('observe', { radius: 64 })
        if (!known.lava) await act('explore', { block: 'lava', lavaSource: true, radius: 48, stepDistance: 60, timeoutSeconds: 90, surface: true })
      }
      const viewed = cell()
      if (viewed && !lavaScoutCells.has(viewed)) { lavaScoutCells.add(viewed); lavaScoutViews++ }
      graphFact('lava_scout_views', lavaScoutViews)
    } else if (skill === 'ruinedPortal') {
      const at = campaignMap()?.rp
      if (!at) return { outcome: 'FAILURE', reason: 'руины без известного места', events: [] }
      await routeStep({ kind: 'ruin', at })
      if (have('obsidian') >= 10) await stageRun('portal')()
      else if (!known.portal) await stageRun('cast')()
      graphFact('ruined_portal_exhausted', true)
    } else if (skill === 'enterNether') await enterNether()
    // LeaveNether к точке выхода у крепости Края, а не домой (COORD 00:55 S5c: s5c-f3-1 — граф уводил к порталу дома, 12 мин
    // впустую, дальше пешком): при ND_SH_NETHER и известной крепости выход ведёт этап stronghold (viaNetherTo; не вышло — он сам домой).
    else if (skill === 'leaveNether') {
      if (SH_NETHER && known.stronghold && !known.endPortal && canLink() && !obsShort()) { await stageRun('stronghold')(); await refresh() }
      if (dim() === 'the_nether' && !died && !pendingExitFrame()) await returnFromNether()
    }
    else if (skill === 'enterEnd') { await checkEndEntry(); await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 120 }) }
    else if (skill === 'heal') await rest(18)
    else if (skill === 'eatFood') await eatTo(20, () => signal.aborted || strategyInterrupted)
    else if (skill === 'prepareBread') {
      const bread = require('../src/campaign/bread').carriedBread(state.inventory || {})
      if (!bread || !(await craft('bread', bread.count))) return { outcome: 'FAILURE', reason: 'хлеб из принесённых ингредиентов не подтверждён', events: [] }
    }
    else if (skill === 'piglinBarter') {
      if (have('gold_block') && have('gold_ingot') < 8) await craft('gold_ingot', 9 * have('gold_block'))
      if (have('gold_ingot') < 8) return { outcome: 'FAILURE', reason: 'сервер не подтвердил восемь слитков для бартера', events: [] }
      const barter = await act('bastion', { ...barterSite(), mode: 'barter', pearls: Math.max(0, eyesWant() - have('ender_eye')), fireRes: 1,
        ...(process.env.ND_SH_NETHER === '1' ? { obsidian: 10 } : {}), ...(EXIT_KIT ? { exit: false } : {}), sealed: true, timeoutSeconds: 540 })
      setBastionIngotsTraded(bastionIngotsTraded + (Number(barter.detail?.ingotsTraded) || 0))
      setBarterZero((Number(barter.detail?.ingotsTraded) || 0) > 0 ? 0 : barterZero + 1)
    }
    else if (skill === 'findBastions') {
      const r = await act('structure', { mode: 'scan', radius: 96 })
      await stageRun('bastion')(true)
      await readMemory()
      if (!nextBastion() && !bastionSearchWanted()) graphFact('bastion', false)
    } else if (skill === 'findFortress') await stageRun('nether')()
    else {
      const executor = STAGES.find(entry => entry.name === skill)
      if (!executor) return { outcome: 'FAILURE', reason: `нет навыка ${skill}`, events: [] }
      await executor.run(command.strategy === 'AcquireWood' ? 5 : command.strategy === 'MineIron' ? true : undefined)
    }
    return { outcome: strategyInterrupted ? 'INTERRUPTED' : 'SUCCESS', events: strategyInterrupted ? [{ type: 'tactical_released' }] : [] }
  } catch (error) {
    if (error.stopCampaign) throw error
    return { outcome: error.strategyInterrupted || strategyInterrupted ? 'INTERRUPTED' : 'FAILURE', reason: error.message, events: [] }
  } finally { signal.removeEventListener('abort', onAbort); setStrategyExecuting(false); setStrategyInterrupted(false) }
}
const intelligence = createCampaignIntelligence({
  observe: intelligenceObservation, call, now: () => gameClock.now(), sleep,
  execute: (command, signal) => { const run = executeStrategy(command, signal); setStrategyTail(run.catch(() => undefined)); return run as Promise<ExecutionResult> },
  eyes: EYES_NEED, beds: BEDS_END, endPrepPrice: END_PREP_PRICE,
  record: decision => {
    telemetry.record({ ...decision, sec: decision.seconds, stage, sinceStart: Math.round((gameClock.now() - T0) / 1000) })
    if (decision.level === 'decision') log(`ГРАФ ${decision.reason}: ${(decision.plan || []).join(' → ')}`)
  }
})

export { graphFact, intelligence }
