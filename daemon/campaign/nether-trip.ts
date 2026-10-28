'use strict'
// Поход в Ад: вход, прибытие, золото, отказ и смена причины, пополнение запаса.
import { only } from './flags'
import { strategyInterrupted, state, sit, died, known, fightGearWanted, netherSearchFailure, homeForGearState,
  setHomeForGearState } from './state'
import { log } from './log'
import { have, dim, RAW, LOGS, planksFor, goldOn, shieldOn, lighter, fireResReady } from './queries'
import { sense, refresh, readMemory } from './observe'
import { READY, fightReady, owFastTrack } from './stages/table'
import { noteNetherRecovery, rodsWanted, netherRetryState, netherFailureState, netherSupply, netherSupplyState } from './nether-plan'
import { act } from './act'
import { goToward, returnFromNether } from './travel'
import { eatTo, craft, sticks, smeltAll } from './kit'
import { cook } from './food'
import { intelligence } from './strategy-bridge'
import * as gameClock from '../src/game-clock'
async function enterNether () {
  if (!lighter()) log('огнива нет и сделать не из чего — вхожу без него (погасший портал = возврат через кровать)')
  await refresh()
  const fastEntry = owFastTrack() && !!known.portal && lighter()
  if (!fastEntry && process.env.ND_NETHER_COOK === '1' && dim() === 'overworld' && !died && !sit.foes && have(RAW)) {
    await cook()
    await refresh()
    if (died || strategyInterrupted) return { status: 'interrupted', detail: { went: false } }
  }
  if (known.portal && state.pos && dim() === 'overworld' && state.pos.y < (known.portal.y ?? 64) - 5) {
    log(`к порталу из-под земли (y ${Math.round(state.pos.y)}) — сперва наверх`)
    await act('surface', { timeoutSeconds: 120, hand: false, preferPillar: true })
    await refresh()
    for (let k = 0; k < 3 && !died; k++) if (await goToward(known.portal, 4)) break
  }
  // Дешёвое снаряжение на Ад до входа: щит (слиток + доски) и золото, если есть из чего (cl-ab 14.10: вход на 25-й мин без щита
  // при слитке в рюкзаке — у бастиона «нет брони», у крепости «нет щита», обратно домой через 7 мин).
  if (!fastEntry && dim() === 'overworld' && !died) {
    if (!shieldOn() && !have('shield') && have('iron_ingot') >= 1) {
      if (have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
      if (have(/_planks$/) >= 6 && await craft('shield')) await act('armor')
    }
    if (!goldOn() && have('gold_nugget') >= 9) await craft('gold_ingot', Math.floor(have('gold_nugget') / 9))
    if (!goldOn() && have('gold_ingot') >= 4) await wearGold()
  }
  // ND_OW_NETHER_STICKS=1 (просьба ne 21.10): в Аду кирки стираются за 3–5 мин (195 незерака), а nether-supply куёт каменную кирку
  // из булыжника/блэкстоуна только при ≥ 2 палках (иначе ждёт стебли 14–17 мин). С собой — железная кирка, если есть 3 слитка
  // (вдвое прочнее каменной), и 8 палок (1 бревно = 4 доски = 8 палок). Только крафт из рюкзака, без походов за деревом.
  if (typeof process !== 'undefined' && process.env.ND_OW_NETHER_STICKS === '1' && dim() === 'overworld' && !died) {
    // Сырое железо набора — в слитки (≈10 с за слиток в печи): минуты прочности кирки в Аду дороже.
    if (!have(/^(iron|diamond|netherite)_pickaxe$/) && have('iron_ingot') < 3 && have('iron_ingot') + have('raw_iron') >= 3) {
      await smeltAll('raw_iron', 'iron_ingot', { max: 3 - have('iron_ingot') })
    }
    if (have('iron_ingot') >= 3 && !have(/^(iron|diamond|netherite)_pickaxe$/)) {
      await sticks(2)
      if (have('stick') >= 2 && await craft('iron_pickaxe')) log('в Ад: железная кирка из слитков набора')
    }
    // ND_OW_NETHER_WOOD=1 (ne 21.10): в Аду кирки стираются к 3–13-й мин, а палок без дерева не сделать (у снимков 5730 stick×1, ни бревна) —
    // затем «домой за недостающим» и гибель наверху (17 прогонов). 8 палок или их дерево (бревно = 8 палок) — нет ни того, ни другого: крюк к
    // видимому дереву в 24 бл. (2 бревна, ≤ 40 с): палки и бревно в запас.
    if (process.env.ND_OW_NETHER_WOOD === '1' && !died && have('stick') < 8 && have(LOGS) === 0 && have(/_planks$/) < 4) {
      log('в Ад: палок мало, дерева нет — крюк к видимому дереву у портала')
      await act('mine', { block: 'any_log', count: 2, radius: 24, dry: true, timeoutSeconds: 40, netherWood: true })
      await refresh()
    }
    if (!died && have('stick') < 8) await sticks(8)
    await refresh()
  }
  return act('portal', { mode: 'enter', timeoutSeconds: 120, ...(lighter() ? {} : { noIgniter: true }) })
}

// Пиглинам хватает любой золотой вещи: ботинки — 4 слитка, шлем — 5 (броня 1 против 2); из 4 слитков — ботинки, а не ещё одна руда.
async function wearGold () {
  await craft('golden_boots')
  await act('armor')
}
// Native 1.21.11 Block.playerWillDestroy: guarded ore angers adults in the
// player AABB +16 blocks without line of sight. This is the cautious ore
// variant; the body repeats its visible-piglin check at each actual swing.
// Опасное прибытие: у портала прибытия враги (пиглины без нашего золота, хоглины, бруты, кубы магмы, иссушители, ифриты в 16 бл.,
// гаст в 40) — смерть за 2–6 мин на открытом (b0-6-1, b2-5-2, b3-6-1 14.10). Назад в портал не лечит: чанки Ада без игрока стоят,
// у рамы те же мобы (ревью Codex 14.10). Поэтому — из-под удара в толщу (закрытый карман), затем закрытым штреком на 32 бл. прочь
// от их середины; дальше дело начинается не у их стаи.
async function netherArrival () {
  if (dim() !== 'the_nether' || died) return
  await refresh()
  // Без золотой вещи — сразу в укрытие (план координатора 14.10): вслепую ne_burrow закрывает видимые проёмы у тела или уводит
  // ступенями в толщу (nether-cover.coverHere); дальше поиск идёт закрытым штреком из этой клетки.
  // И с золотыми ботинками: бруты, хоглины и гасты бьют при любом золоте (h1: брут на 1.7 мин у портала, ботинки на ногах).
  // ND_NE_GOLD_FIRST: до укрытия — оглядеться (руда на стенах видна только снаружи кармана), дальше золото — по памяти глаз.
  if (process.env.ND_NE_GOLD_FIRST === '1' && !goldOn()) await act('ne_gold_first', { look: true, timeoutSeconds: 10 })
  if (process.env.ND_NE_COVER !== '0') {
    const c = await act('ne_burrow', { why: 'прибытие: сразу в укрытие' })
    await refresh()
    log(`прибытие: укрытие — ${(c.detail && (c.detail.how || c.detail.why)) || c.error || c.status}`)
    if (died || dim() !== 'the_nether') return
  }
  const o = await act('observe', { radius: 40 })
  const ents = ((o.detail && o.detail.entities) || []).filter(e => e && e.pos)
  const nm = e => String(e.name || '').toLowerCase().replace(/ /g, '_')
  const foes = ents.filter(e => {
    const n = nm(e), d = e.dist ?? 99
    if (/^(hoglin|piglin_brute|magma_cube|wither_skeleton|blaze)$/.test(n)) return d <= 16
    if (n === 'piglin') return !goldOn() && d <= 16
    if (n === 'ghast') return d <= 40
    return false
  })
  if (!foes.length || !state.pos) { await goldFirstStep(); return }
  log(`опасное прибытие: ${foes.map(e => `${nm(e)} ${Math.round(e.dist)}`).join(', ')} — в толщу и штреком прочь`)
  await act('ne_burrow', { why: 'опасное прибытие' })
  await refresh()
  if (died || dim() !== 'the_nether' || !state.pos) return
  const cx = foes.reduce((n, e) => n + e.pos.x, 0) / foes.length, cz = foes.reduce((n, e) => n + e.pos.z, 0) / foes.length
  const dx = state.pos.x - cx, dz = state.pos.z - cz, len = Math.hypot(dx, dz) || 1
  const to = { x: Math.round(state.pos.x + dx / len * 32), z: Math.round(state.pos.z + dz / len * 32) }
  const t = await act('nether_tunnel', { x: to.x, z: to.z, radius: 4, timeoutSeconds: 120 })
  await refresh()
  log(`прибытие: штрек прочь к ${to.x},${to.z} — ${(t.detail && t.detail.note) || t.error || t.status}`)
  await goldFirstStep()
}

// ND_NE_GOLD_FIRST=1 (поток ne 21.10, выкл.): без золота на теле — сперва золотые ботинки из видимой руды Ада закрытым штреком
// (ne_gold_first). Полный проход приносит каменную кирку без золота и брони: пиглины бьют с первой секунды (int7: 4 из 10 смертей).
async function goldFirstStep () {
  if (process.env.ND_NE_GOLD_FIRST !== '1' || died || dim() !== 'the_nether' || goldOn()) return
  if (have('gold_ingot') + 9 * have('gold_block') + Math.floor(have('gold_nugget') / 9) >= 4) { await wearGold(); await refresh(); if (goldOn()) return }
  const g = await act('ne_gold_first', { timeoutSeconds: 480 })
  await refresh()
  log(`прибытие: золото первым — ${(g.detail && g.detail.note) || g.error || g.status}`)
}

// Золото Ада — по пути, не отдельной фазой (пользователь 14.10: «можно по пути накопать, пока идёшь к нужным структурам в аду»):
// поиск и обход ведут свои отрезки и копают увиденную руду сами (fortress.goldOnTheWay). Здесь, у входа в этап bastion, —
// только то, что видно рядом (10 бл.), и не на глазах у пиглинов: копка руды злит взрослых в коробке ±16 без луча
// (Block.playerWillDestroy, 1.21.11) — враги в 24 бл. на виду, значит не трогать; без брони в бастион — закрытым штреком.
// Самородки — в слитки, броня — как хватит на 4 слитка. Пустая попытка — пауза 2 игр. мин.
let netherGoldNext = -Infinity
// ND_BAST_GOLD_ON=1 (поток bast 27.10, выкл.): золото в рюкзаке в любом виде (самородки, блок, слитки) → золотые ботинки до торга и
// хода к бастиону. Граф торговал (pearls seek) без брони: 32 слитка в рюкзаке, ботинок нет — пиглины бьют (sr27-bast-b0f слот 12:
// хп 20 → 7, «домой» и смерть в огне); 43 самородка лежали не сплавленными (b0s слот 13).
async function goldUp () {
  await refresh()
  if (goldOn()) return true
  if (have('gold_ingot') < 4 && have('gold_nugget') >= 9) await craft('gold_ingot', Math.floor(have('gold_nugget') / 9))
  if (have('gold_ingot') < 4 && have('gold_block')) await craft('gold_ingot', 9)
  if (have('gold_ingot') >= 4) { await wearGold(); await refresh() }
  return goldOn()
}

async function netherGold () {
  if (process.env.ND_BAST_GOLD_ON === '1' && await goldUp()) return
  await refresh()
  if (!goldOn() && have('gold_block') && have('gold_ingot') < 5) {
    await craft('gold_ingot', 9 * have('gold_block'))
    await refresh()
  }
  if (have('gold_ingot') >= 4 && !goldOn()) await wearGold()
  if (goldOn() || gameClock.now() < netherGoldNext) return
  netherGoldNext = gameClock.now() + 120000
  const o = await act('observe', { radius: 32 })
  const foes = ((o.detail && o.detail.entities) || []).filter(e => /^(piglin|piglin[ _]brute|hoglin)$/i.test(String(e.name || '')) && (e.dist ?? 0) <= 24)
  if (foes.length) { log(`золото рядом не трогаю: пиглины в ${Math.round(Math.min(...foes.map(e => e.dist ?? 99)))} бл.`); return }
  const nuggets = have('gold_nugget') + 9 * have('gold_ingot')
  const m = await act('mine', { block: 'nether_gold_ore,gilded_blackstone', count: Math.max(2, Math.min(6, Math.ceil((36 - nuggets) / 4))), radius: 10, avoidPiglinAggro: true })
  await refresh()
  if (have('gold_nugget') >= 9) await craft('gold_ingot', Math.floor(have('gold_nugget') / 9))
  if (have('gold_ingot') >= 4 && !goldOn()) await wearGold()
  if (m.detail && m.detail.dug) log(`золото рядом: руды ${m.detail.dug}, самородков ${have('gold_nugget') + 9 * have('gold_ingot') - nuggets}`)
}

// Сытость перед боем у спавнера: еда прерывается тактикой/ифритами («не поел»), а уход из боя без защиты навыка у спавнера
// гибелен (s1-post13 06.10: blaze вернулся на 19 хп, «сытость не восстановилась», ожидание тактики — смерть). Под огнестойкостью
// (или с зельем в рюкзаке) и с 12+ хп бой не откладываем.
async function fedForBlazes () {
  if (await eatTo(18)) return true
  // Без огнестойкости — тот же бой (щит на залп, коробка, отход), лишь запас хп выше: недоеденная сытость — не запрет.
  return (state.health ?? 0) >= (fireResReady() ? 12 : 14)
}
async function continueFortressChoice (selection, blocked) {
  if (process.env.ND_FORTRESS_CONTINUE === '0' || process.env.ND_FORTRESS_FRONTIER === '0' || dim() !== 'the_nether' || died ||
      !known.fortress || !rodsWanted() || (state.tactics?.threatLevel ?? 0) >= 2 || blocked?.observed === undefined) return false
  const cause = netherRetryState(blocked.origin)
  if (blocked.frontier !== cause && !netherSearchFailure?.exhausted) return false
  const quote = await act('fortress', { mode:'continue',planOnly:true,timeoutSeconds:90 })
  await readMemory()
  if (cause !== netherRetryState(blocked.origin)) return true
  const plan = quote.detail?.plan
  if (quote.status !== 'done' || !plan || !Number.isFinite(plan.seconds) || plan.seconds < 0) return false
  const alternative = selection?.strategy
  if (alternative) {
    // Same expected-loss price as core/strategy.ts: 72000 ticks = 3600 seconds.
    const risk = intelligence.registry.get('FindFortress')?.estimateRisk(selection.before) ?? 0
    const price = plan.seconds + risk * 3600
    const other = alternative.estimateCost(selection.before) / 20 + alternative.estimateRisk(selection.before) * 3600
    log(`крепость: продолжение ≈${Math.round(price)} с; ${alternative.id} ≈${Math.round(other)} с`)
    if (price >= other) return false
  }
  await act('fortress', { mode:'continue',planKey:plan.key,maxCostSeconds:plan.seconds,timeoutSeconds:90 })
  await refresh(); await readMemory()
  return true
}
const netherRecoveryActions = new Map()
// q11: физические действия тела сравниваются до повторного большого поиска/пути домой.
// Неизвестность, noPath и прерывание не являются доказательством невозможности.
let netherRecoverySeconds = 90
const recoveryTrail: Array<{ x: number, y: number, z: number, t: number }> = []
async function noGiveupNether (onProgress = (_why: string) => {}) {
  const r = await act('ne_recover', { portal: known.netherPortal || null, timeoutSeconds: netherRecoverySeconds })
  await refresh(); await readMemory()
  if (died || dim() !== 'the_nether') return true
  const d = r.detail || {}
  netherRecoverySeconds = Number.isFinite(d.requiredSeconds) ? Math.max(90, Math.min(600, d.requiredSeconds)) : 90
  log('RECOVERY_SNAPSHOT ' + JSON.stringify({ pos: state.pos, hp: state.health, inventory: state.inventory,
    candidates: d.candidates, chosen: d.chosen, progressed: d.progressed, interrupted: d.interrupted, proof: d.proof }))
  log(`восстановление Ада: ${d.chosen?.kind || 'наблюдение'} — ${d.why || r.error || r.status}`)
  if (r.status === 'done' && d.impossible === true && d.proof === 'sealed-unbreakable') {
    log(`БЛОКЕР: Ад — доказана физическая невозможность: ${d.why}`)
    process.exitCode = 2
    return false
  }
  // Изменение на месте (копка туда-обратно на 1 бл., nbs35-5974: 2012 вызовов ne_recover за 9 игр. мин между (15,62,-17) и
  // (14,62,-17); nbs33-6185 — 1016, nbs32-5408 — 1726) — не прогресс: паузы этапов не снимать, переждать 10 с в своей клетке.
  const here = state.pos && { x: state.pos.x, y: state.pos.y, z: state.pos.z, t: gameClock.now() }
  if (here) recoveryTrail.push(here)
  while (recoveryTrail.length > 6) recoveryTrail.shift()
  const churn = here && recoveryTrail.filter(p => here.t - p.t < 60000 && Math.hypot(p.x - here.x, p.y - here.y, p.z - here.z) <= 3).length >= 5
  if (churn) {
    log('восстановление Ада: изменения на месте (5 из 6 в 3 бл. за минуту) — не прогресс, жду 10 с')
    await act('wait', { seconds: 10 })
    recoveryTrail.length = 0
    return true
  }
  if (d.progressed) {
    noteNetherRecovery()
    onProgress('восстановление Ада: подтверждённое изменение тела или снабжения')
  }
  return true
}
async function changeNetherCause (onProgress = (_why: string) => {}) {
  if (process.env.ND_NE_NO_GIVEUP === '1' && dim() === 'the_nether' && !died) return noGiveupNether(onProgress)
  if (process.env.ND_NE_RECOVER !== '1' || dim() !== 'the_nether' || died) return false
  if ((state.tactics?.threatLevel ?? 0) >= 2) {
    const cover = netherRecoveryActions.get('threatCover')
    if (!cover || cover.observed !== netherRetryState(cover.origin) || (state.health ?? 20) <= cover.hp - 3) {
      await act('ne_burrow', { why: 'реальная угроза перед сменой подхода' })
      await refresh()
      netherRecoveryActions.set('threatCover', { observed: netherRetryState(), origin: state.pos && { ...state.pos }, hp: state.health ?? 20 })
    }
    await act('wait', { seconds: 3 })
    return true
  }
  // J owns the next seen fortress deck. This is the existing general scout outside that search, never a repeated failed RPC.
  for (const action of ['explore', 'home']) {
    if (action === 'home' && netherSupply.netherToolsReady(netherSupplyState()) && READY.nether() && (!fightGearWanted || fightReady())) continue
    if (action === 'home' && homeForGearState && homeForGearState.observed === netherRetryState(homeForGearState.origin)) continue
    const mark = netherRecoveryActions.get(action)
    if (mark && mark.observed === netherFailureState('netherTools', mark.origin)) continue
    const from = state.pos && { ...state.pos }
    const before = netherFailureState('netherTools', from)
    let r = null
    if (action === 'explore') {
      log('отказ: доступных целей нет — новый наблюдаемый участок, не ожидание')
      r = await act('explore', { block: only?.includes('nether') && !only.includes('pearls') ? 'nether_bricks' : 'warped_nylium', newView: true, radius: 48, stepDistance: 16, timeoutSeconds: 90 })
    } else {
      log('отказ: здесь снабжение недоступно — домой за недостающим')
      await returnFromNether()
    }
    await refresh(); await readMemory()
    if (dim() !== 'the_nether' || died) return true
    // Прерывание тактикой (reflex/tactical) — не отказ мира: угроза была временной причиной. Повтор того же разведочного хода —
    // один раз на неизменное состояние; второе прерывание при том же состоянии — уже отказ (fj2-1-b-101 16.10: explore прерван
    // reflex и сразу БЛОКЕР, этап брошен на 7-й минуте при хп 20).
    const byThreat = r && r.status === 'interrupted' && (/^(reflex|tactical|damage|low_health)$/.test(r.by?.type || '') || /reflex|tactical|тактик/.test(String(r.error || r.detail?.stopped || '')))
    if (byThreat && !strategyInterrupted) {
      const again = netherFailureState('netherTools', from)
      const prev = netherRecoveryActions.get(action + ':interrupted')
      if (!prev || prev.observed !== again) {
        netherRecoveryActions.set(action + ':interrupted', { observed: again })
        log(`разведка прервана тактикой — повторю после угрозы (${r.detail?.stopped || r.error || 'reflex'})`)
        return true
      }
    }
    netherRecoveryActions.set(action, { observed: netherFailureState('netherTools'), origin: state.pos && { ...state.pos } })
    if (action === 'home') setHomeForGearState({ observed: netherRetryState(), origin: state.pos && { ...state.pos } })
    if ((state.tactics?.threatLevel ?? 0) >= 2 || r?.detail?.found || before !== netherFailureState('netherTools', from)) return true
  }
  // Пешей дороги нет ни в одну сторону (базальтовые дельты, обрыв над лавой: nbs-5408-111 16.10 — «пути нет ни в одном направлении»
  // и БЛОКЕР на 22-й мин при хп 20): закрытый штрек на 48 бл. по стороне света, ещё не испробованной из этого места, — новый обзор
  // ценой копки. Все четыре не сдвинули тело — тогда БЛОКЕР.
  if (state.pos && have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0 && process.env.ND_NE_TUNNEL_RECOVER !== '0') {
    const here = state.pos, cell = `${Math.round(here.x / 16)},${Math.round(here.z / 16)}`
    const tried = netherRecoveryActions.get('tunnel:' + cell)?.dirs || []
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const key = `${dx},${dz}`
      if (tried.includes(key)) continue
      tried.push(key)
      netherRecoveryActions.set('tunnel:' + cell, { dirs: tried })
      const to = { x: Math.round(here.x + dx * 48), y: Math.round(here.y), z: Math.round(here.z + dz * 48) }
      log(`отказ: пешком некуда — закрытый штрек к ${to.x},${to.y},${to.z} (новый обзор ценой копки)`)
      const t = await act('nether_tunnel', { ...to, radius: 4, timeoutSeconds: 240 })
      await refresh(); await readMemory()
      if (dim() !== 'the_nether' || died) return true
      if (state.pos && Math.hypot(state.pos.x - here.x, state.pos.z - here.z) >= 8) return true
      if (t?.status === 'interrupted') return true
    }
  }
  log('БЛОКЕР: Ад — новые подходы и снабжение недоступны при том же состоянии; завершаю без пустого ожидания')
  return false
}
async function replenishNetherSupply () {
  let interrupted = false
  return netherSupply.replenishNetherTools({
    observe: async () => { await refresh(); await sense(); return netherSupplyState() },
    act: async (method, params) => { const result = await act(method, params); interrupted ||= result.status === 'interrupted' }, craft,
    now: () => gameClock.now(), interrupted: () => interrupted || strategyInterrupted || died, log
  })
}

export { enterNether, wearGold, goldUp, netherArrival, netherGold, fedForBlazes, continueFortressChoice, changeNetherCause,
  replenishNetherSupply }
