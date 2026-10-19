'use strict'
// Учёт Ада и Края без действий: бастионы и бартер, стержни, рамка выхода, жемчуг, запас для Ада.
import { only, EYES_NEED } from './flags'
import { state, sit, memorySnapshot, known, netherExplored, netherViewRevision, lavaSourceKnown, exitFrameTarget,
  bastionDry, barterZero, bastionSearchRuns, bastionSearchSeconds, bastionPausedUntil, lastBastionGoldLeft,
  supplyBlockedAt, supplyBlockedState, setBastionDry } from './state'
import { log } from './log'
import { have, dim, foodUnits, PICK_DIAMOND, lighter, fireResReady, pearlsNow } from './queries'
import { bState } from './observe'
import { READY } from './stages/table'
const path: typeof import('path') = require('path')
const gameClock: typeof import('../src/game-clock') = require('../src/game-clock')
const EXIT_KIT = process.env.ND_EXIT_KIT !== '0' && process.env.ND_SH_NETHER === '1'
const exitKitNow = () => require('../src/nether').exitKit(state.inventory || {})
const pendingExitFrame = () => !!exitFrameTarget && dim() === 'the_nether' && lighter() && !!state.pos && Math.hypot(state.pos.x - Math.floor(exitFrameTarget.x / 8), state.pos.z - Math.floor(exitFrameTarget.z / 8)) <= 12
// Обсидиан на раму выхода нужен только в Аду: наверху с очами — к крепости, а не обратно в бастион (S5d s5d-p4-1 07.10: после
// выхода у крепости рама съела 10, граф увёл обратно в Ад за обсидианом — 11 игр. мин впустую).
const obsShort = () => !known.endPortal && dim() === 'the_nether' && (EXIT_KIT ? !pendingExitFrame() && !exitKitNow().ready : process.env.ND_OBS_EXIT === '1' && process.env.ND_SH_NETHER === '1' && !have(PICK_DIAMOND) && have('obsidian') < 10)
// Очей нужно — пустых рамок: после комнаты/частичной вставки — 12 минус уже вставленные (S5e 07.10, s5e-G-1: вставил 7 из 12, fill
// оборвала лава, у тела 7 очей на 5 пустых рамок, а граф по «12 очей» увёл в legacy-этап nether из крепости). ND_EYES_FRAMES=0 — прежнее.
const eyesWant = () => known.endPortal && Number.isFinite(known.portalEyes) && process.env.ND_EYES_FRAMES !== '0'
  ? Math.max(0, EYES_NEED - known.portalEyes) : EYES_NEED + (known.stronghold ? 0 : 2)
const notePortalEyes = r => { const d = r && r.detail; const w = d && (Number.isFinite(d.withEye) ? d.withEye : d.room && d.room.withEye); if (Number.isFinite(w)) known.portalEyes = w }
const barterFlow = require('../src/barter-flow')
function deferBastionMining (b) {
  if (process.env.ND_NE_RECOVER === '1') {
    bState(b).blocked = { observed: netherFailureState('bastion'), origin: state.pos && { ...state.pos } }
    setBastionDry(0)
    log(b.key + ': этот подход не дал добычи — другой подход или цель по цене; известное золото сохранено')
    return
  }
  bState(b).miningDeferredUntil = Math.max(bState(b).miningDeferredUntil || 0, gameClock.now() + 2700000)
  setBastionDry(0)
  log(`${b.key}: два законченных захода без добычи — отложен на бюджет следующего маршрута 2700 с; остаток известного золота сохранён`)
}
const bastionBlocked = b => {
  const mark = bState(b).blocked
  return process.env.ND_NE_RECOVER === '1' && !!mark && mark.observed === netherFailureState('bastion', mark.origin)
}
const nextBastion = () => {
  const left = (known.bastions || []).filter(b => !bState(b).spent)
  if (barterFlow.enabled() && pearlsNow() < eyesWant() && have('gold_ingot') + 9 * have('gold_block') >= 8 && state.pos) {
    // Свои слитки — и к выработанному бастиону (10.10 server-run: «выработан» после 50 слитков — кончилось НАШЕ золото, пиглины
    // на месте; с 85 слитками кампания шла копать к бастиону 2 за 570 бл. и без кирок — домой).
    const nearby = (known.bastions || []).filter(b => !bastionBlocked(b) && Math.hypot(b.x - state.pos.x, b.z - state.pos.z) < 96)
      .sort((a, b) => Math.hypot(a.x - state.pos.x, a.z - state.pos.z) - Math.hypot(b.x - state.pos.x, b.z - state.pos.z))
    if (nearby[0]) return nearby[0]
  }
  return left.find(b => !bastionBlocked(b) && (bState(b).miningDeferredUntil || 0) <= gameClock.now() &&
    (!barterFlow.enabled() || (bState(b).barterUntil || 0) <= gameClock.now())) ||
    left.slice().sort((a, b) => (bState(a).miningDeferredUntil || 0) - (bState(b).miningDeferredUntil || 0))[0] || null
}
// Бастион «в работе» — не выработан и копка не отложена. nextBastion() отдаёт и отложенные (ход туда, когда больше нечего
// делать), а ворота графа и этапов («жемчуг прежде ифритов», эндермены после бастионов) смотрят сюда: отложенный бастион
// ждёт срока, тело тем временем идёт за стержнями или жемчугом (разбор 06.10: ворота без выхода, стержней 0 во всех Full).
const activeBastion = () => (known.bastions || []).find(b => !bState(b).spent && !bastionBlocked(b) && (bState(b).miningDeferredUntil || 0) <= gameClock.now()) || null
const barterExhausted = () => barterZero >= 2
// Огнестойкость в рюкзаке и нечего отдать пиглинам — к ифритам, не дожидаясь жемчуга; потом добор (бастион, эндермены).
const blazeBeforePearls = () => fireResReady() && have('gold_ingot') + 9 * have('gold_block') < 8
function barterSite () {
  const position = state.pos
  if (!position) return {}
  const sites = (known.bastions || []).filter(b => [b.x, b.y ?? 64, b.z].every(Number.isFinite))
  const distance = b => Math.hypot(b.x - position.x, (b.y ?? 64) - position.y, b.z - position.z)
  const nearest = sites.reduce((best, site) => !best || distance(site) < distance(best) ? site : best, null)
  return nearest ? { x: nearest.x, y: nearest.y ?? 64, z: nearest.z,
    knownChests: nearest.chests, starts: nearest.starts } : {}
}
const bastionsFromMap = () => (known.bastions || []).some(b => Array.isArray(b.gold) && b.gold.length > 0)
const BASTION_SEARCH_S = Number(process.env.ND_BASTION_SEARCH_S) || 900
const bastionSearchWanted = () => !nextBastion() && bastionSearchRuns < 8 && bastionSearchSeconds < BASTION_SEARCH_S && !bastionsFromMap()
const BASTION_FIRST = process.env.ND_BASTION_FIRST !== '0'
const bastionSupplyBlocked = () => (process.env.ND_NE_RECOVER === '1'
  ? supplyBlockedState?.observed === netherFailureState('netherTools', supplyBlockedState?.origin)
  : gameClock.now() - supplyBlockedAt < 300000) && !netherSupply.netherToolsReady(netherSupplyState())
let lastPauseWhy = ''
function pauseWaitPays () {
  if (gameClock.now() >= bastionPausedUntil) return true
  // Слитки после паузы: в рюкзаке + половина известного оставшегося золота бастиона (после пустых заходов путь к нему не гарантирован).
  // ponytail: доля 0.5 — грубая; уточнять по телеметрии «золото по памяти осталось → взято после паузы».
  const goldLeft = lastBastionGoldLeft || (activeBastion()?.gold?.length ?? 0)
  const ingots = have('gold_ingot') + 9 * have('gold_block') + Math.round(9 * goldLeft * 0.5)
  const c = require('../src/campaign/nether-pause').pauseBlazeChoice({ fireRes: fireResReady(),
    pauseLeftSeconds: (bastionPausedUntil - gameClock.now()) / 1000, ingotsAfterPause: ingots, shield: have('shield') > 0 || /shield/.test(JSON.stringify(state.offHand || '')), hp: state.health ?? 20 })
  const key = `${c.wait}|${Math.round(c.gainSeconds / 60)}|${ingots}`
  if (key !== lastPauseWhy) { lastPauseWhy = key; log(`пауза бастиона: ${c.why}`) }
  return c.wait
}
// bastionDry ≥ 3 снимает этап bastion (needed) — тогда и ифриты его не ждут: иначе тупик «бастион не нужен / к крепости не иду,
// сперва жемчуг» и «в Аду нечем — домой» (b0-6-2 14.10).
const bastionPearlsPending = () => process.env.ND_NE_RECOVER !== '1' && BASTION_FIRST && (!only || only.includes('bastion')) && pearlsNow() < eyesWant() && !blazeBeforePearls() &&
  pauseWaitPays() && READY.bastion() && !bastionSupplyBlocked() && bastionDry < 3 &&
  (!!activeBastion() || (have('gold_block') * 9 + have('gold_ingot') >= 8 && !barterExhausted()))
const rodsShort = () => Math.max(0, Math.ceil((eyesWant() - have('ender_eye') - have('blaze_powder')) / 2) - have('blaze_rod'))
const rodsWanted = () => rodsShort() > 0 && (have('ender_eye') < Math.min(10, EYES_NEED) || have('ender_pearl') > 2 * have('blaze_rod') + have('blaze_powder'))
// Only changes to the failed search/supply/path can reopen a Nether attempt.
function netherRetryState (origin = null) {
  const p = state.pos
  const sp = memorySnapshot?.places?.['спавнер блейзов']
  return JSON.stringify([dim(), !!(origin && p && Math.hypot(p.x - origin.x, p.y - origin.y, p.z - origin.z) >= 8),
    known.fortress && [known.fortress.x, known.fortress.y, known.fortress.z], sp && [sp.x, sp.y, sp.z], netherExplored, netherViewRevision,
    have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0, netherSupply.netherToolsReady(netherSupplyState()),
    have('obsidian') >= 10 && !!lighter(), state.tactics?.threatLevel ?? 0,
    process.env.ND_FORTRESS_FRONTIER === '0' ? null : [state.tactics?.action, have(/^(cobblestone|blackstone|netherrack|nether_bricks)$/)],
    [...new Set((sit.fight?.order || []).map(e => e.name))].sort()])
}
function netherFailureName (name) {
  if (/^(FindFortress|GetBlazeRods)$/.test(name)) return 'nether'
  if (/^(BastionBarter|PiglinBarter|AcquireGold|MoveToNextBastion|FindBastions|SearchNextBastion)$/.test(name)) return 'bastion'
  if (name === 'HuntEndermen') return 'pearls'
  if (name === 'AcquireNetherTools') return 'netherTools'
  return name
}
function netherFailureState (name, origin = null) {
  const common = netherRetryState(origin)
  if (name === 'bastion') return JSON.stringify([common, (known.bastions || []).map(b => [b.key, b.x, b.z]),
    have('gold_ingot') + 9 * have('gold_block'), pearlsNow()])
  if (name === 'pearls') { const forest = forestToHunt(); return JSON.stringify([common, forest && [forest.x, forest.y, forest.z], pearlsNow()]) }
  if (name === 'netherTools') return JSON.stringify([common, Math.min(8, have(/_planks$/) + 4 * have(/_(log|stem)$/)),
    Math.min(2, have('stick')), have('crafting_table') > 0, Math.min(3, have(/^(cobblestone|cobbled_deepslate|blackstone)$/)),
    have('iron_ingot') + Math.floor(have('iron_nugget') / 9) + 9 * have('iron_block') >= 3])
  return common
}
// Причина неудачи этапа верхнего мира (ND_OW_CAUSE_RETRY=1): повтор — когда изменилось то, от чего зависел заход (место с точностью
// до 16 бл., ночь/день, известные вода и лава, ведро/огниво, еда), а не через N минут (правило пользователя 15.10). Было: «два пустых
// захода — пауза 5 мин» (m2g1-fp1-s14-2-kit-911 16.10: вода «пауза 5 мин» на 2-й минуте, ночь до 19-й, набор не успел к 25-й).
function overworldFailureState (origin = null) {
  const p = state.pos, o = origin
  const moved = !!(p && o && Math.hypot(p.x - o.x, p.z - o.z) >= 16)
  return JSON.stringify([dim(), moved, !!sit.night, known.water ? [known.water.x, known.water.z] : null, known.lava ? [known.lava.x, known.lava.z] : null,
    lavaSourceKnown, have('bucket'), have('water_bucket'), !!lighter(), foodUnits(), Math.floor((state.health ?? 20) / 7), state.tactics?.threatLevel ?? 0])
}
// S1e: цена жемчуга эндерменами — по факту заходов (секунды охоты / жемчуг; приор 240 с на 2 жемчуга), лес не видел — дороже
// (разведка), два пустых захода — практически стоп. Граф (HuntEndermen, barterPlan action endermen) берёт её как факт.
const PEARL_STYLE = process.env.ND_PEARL_STYLE || 'foxhole'
const pearlTrips = { seconds: 0, pearls: 0, zero: 0 }
// Пустые места (2 захода без эндерменов в виду): лес в 48 бл. от них не берём снова; запись глаз хранит и другие увиденные леса (alts).
const emptyForests = []
const failedHuntSites = []
const failedHuntSite = p => process.env.ND_NE_RECOVER === '1' && failedHuntSites.some(s => Math.hypot(s.x-p.x,s.y-p.y,s.z-p.z) < 8)
const forestEmpty = p => emptyForests.some(e => Math.hypot(e.x - p.x, e.z - p.z) < 48)
function forestToHunt () {
  const rec = memorySnapshot?.places?.['искажённый лес (ад)']
  // Место, откуда глаза видели больше всего эндерменов разом (nether-forest.js), — первым: окоп отдаёт столько, сколько видно с места.
  const em = memorySnapshot?.places?.['эндермены (ад)']
  const seenAt = em && Number.isFinite(em.x) && (em.count || 0) >= 3 ? [{ ...em, score: 1000 + em.count }] : []
  const here = process.env.ND_NE_RECOVER === '1' && state.biome === 'warped_forest' && state.pos ? [{ ...state.pos, note: 'F3: искажённый лес под ногами' }] : []
  if (!rec && !seenAt.length && !here.length) return null
  const all = [...seenAt, ...(rec ? [rec, ...(Array.isArray(rec.alts) ? rec.alts : [])] : []), ...here].filter(f => f && Number.isFinite(f.x) && !forestEmpty(f) && !failedHuntSite(f))
  return all.sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null
}
function endermenSecondsPerPearl () {
  if (pearlTrips.zero >= 2) return 3600
  const prior = forestToHunt() ? 240 : 900
  return (pearlTrips.seconds + prior * 2) / (pearlTrips.pearls + 2)
}
const netherSupply = require('../src/campaign/nether-supply')
const netherSupplyState = () => ({ dimension: dim(), health: state.health ?? 20, inventory: state.inventory || {}, pickSwings: sit.pickLeft ?? 0, woodAt: netherWoodSeen() })
// Стебли, увиденные глазами (nether-forest.js), — в 200 бл. по горизонтали (S1e).
function netherWoodSeen () {
  const w = memorySnapshot?.places?.['стебли (ад)']
  if (!w || dim() !== 'the_nether' || !state.pos || !Number.isFinite(w.x)) return null
  return Math.hypot(w.x - state.pos.x, w.z - state.pos.z) <= 200 ? { x: w.x, y: w.y, z: w.z } : null
}

export { EXIT_KIT, exitKitNow, pendingExitFrame, obsShort, eyesWant, notePortalEyes, barterFlow, deferBastionMining,
  bastionBlocked, nextBastion, activeBastion, barterExhausted, barterSite, BASTION_SEARCH_S, bastionSearchWanted,
  BASTION_FIRST, bastionPearlsPending, rodsShort, rodsWanted, netherRetryState, netherFailureName, netherFailureState,
  overworldFailureState, PEARL_STYLE, pearlTrips, emptyForests, failedHuntSites, forestEmpty, forestToHunt,
  endermenSecondsPerPearl, netherSupply, netherSupplyState }
