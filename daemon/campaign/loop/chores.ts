'use strict'
// Дела хода между этапами: щит в Аду, печь прерванной плавки, осмотр лавы вдаль, лут построек на виду, еда по пути.
import { died, state, sit, known, lavaSourceKnown, quickHuntAt, setQuickHuntAt, setStage } from '../state'
import { log } from '../log'
import { have, dim, LOGS, foodUnits, planksFor, shieldOn } from '../queries'
import { sense, refresh } from '../observe'
import { STAGES, castNear, stageProgress, stageRun } from '../stages/table'
import { act } from '../act'
import { craft } from '../kit'
import { quickHunt } from '../food'
import { dayLavaActive, lavaLookout, skyLavaLook, lootSeenStructures } from '../scout'
import type { CampaignTurn } from './turn'
import * as gameClock from '../../src/game-clock'
let foodSearchAt = 0
let skyLookNext = 0
let structLootNext = 0
let netherShieldAt = -Infinity

async function loopChores (loop: CampaignTurn): Promise<void> {
  const { cooling } = loop
  // Щит в Аду (слиток + 6 досок), если вошёл без него (после смерти, сломан): удар пиглина, залп гаста и ифрита он снимает.
  // Доски в Аду — это палки на кирки и верстак: щит — только из запаса сверх них (≥ 10 досок или стебли/брёвна), иначе кирки
  // кончались, а потерянный верстак не из чего сделать (b3-6-1 14.10: 2 доски после щита, верстак потерян — ни палок, ни кирок).
  if (dim() === 'the_nether' && !died && !shieldOn() && have('iron_ingot') >= 1 && (have(/_planks$/) >= 10 || have(LOGS) >= 2) &&
      gameClock.now() >= netherShieldAt && (state.tactics?.threatLevel ?? 0) < 2) {
    netherShieldAt = gameClock.now() + 120000
    setStage('-')
    if (have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
    if (await craft('shield')) { await act('armor'); log('щит в Аду сделан из запаса') }
  }
  // Прерванная плавка оставила сырьё/слитки в своей печке — забрать, пока рядом (containers.takeFurnace; cl-a 14.10:
  // таймаут MineIron отменил плавку 13 железа, тело копало его заново).
  const furnaceLeft = state.furnaceLeft
  if (furnaceLeft && furnaceLeft.dimension === dim() && state.pos && (state.tactics?.threatLevel ?? 0) < 2 &&
      Math.hypot(furnaceLeft.at.x - state.pos.x, furnaceLeft.at.y - state.pos.y, furnaceLeft.at.z - state.pos.z) <= 48) {
    setStage('-')
    await act('furnace_take', {})
  }
  // Лава светится: осмотр вдаль с поверхности по ходу дела (не чаще раза в минуту, с нового места) — где озеро, знать
  // заранее, к литью идти туда (cl-o 14.10: озеро у руин в 26 бл. от спавна не заметил, литьё искал за 300 бл.).
  if (dim() === 'overworld' && !known.portal && !lavaSourceKnown && !died && sit.surface && !sit.night && gameClock.now() >= skyLookNext) {
    skyLookNext = gameClock.now() + 60000
    try {
      await skyLavaLook()
      // С земли озеро часто закрыто рельефом и деревьями (замер слота 1 14.10: 5 открытых клеток озера в 54 бл., ни одна не видна
      // с земли): раз-два за прогон — столб на 10 вверх своими блоками, осмотр, спуск (как игрок с вышки). Блоки — после камня.
      if (!lavaSourceKnown && !dayLavaActive()) await lavaLookout()
    } catch (e) { if (e.stopCampaign) throw e }
  }
  // Постройки на виду — раз в минуту днём поверху: лут, если выгода больше пути (lootSeenStructures, числа в журнале).
  if (dim() === 'overworld' && !died && sit.surface && !sit.night && gameClock.now() >= structLootNext && process.env.ND_STRUCT_LOOT !== '0') {
    structLootNext = gameClock.now() + 60000
    try { await lootSeenStructures() } catch (e) { if (e.stopCampaign) throw e }
  }
  // Еда по пути, как у игрока: днём, звери на виду, запас мал — добыть сейчас (quickHunt: только видимые в 24 бл., ≤ 60 с).
  // Граф ставит FindFood перед входом в Ад; cl-a/cl-c 14.10: первые 15–18 мин без еды, урон не лечится, смерть ночью.
  if (dim() === 'overworld' && !died && foodUnits() < 4 && gameClock.now() >= quickHuntAt && (state.tactics?.threatLevel ?? 0) < 1 &&
      (state.health ?? 20) >= 8 && process.env.ND_QUICK_HUNT !== '0') {
    setQuickHuntAt(gameClock.now() + 90000)
    await sense()
    if (sit.surface && !sit.night) {
      setStage('food')
      try { await quickHunt() } catch (e) { if (e.stopCampaign) throw e; log(`охота по пути: ${e.message}`) }
      // Зверей на виду нет, а еды нет совсем и сытость уже не лечит (≤ 15): днём — охота с поиском (этап food, ≤ 2 мин),
      // пока светло, а не ночью с 4 хп (cl-g 14.10: обе смерти — ночью без единой еды за 13–23 мин).
      await refresh()
      // Лава с набором рядом (castNear) — сперва литьё (2–3 мин, портал не пропадёт), еда — после: kc6-fp1-s16-1-kit-202 16.10:
      // лава в 32 бл., вода и огниво в рюкзаке, «днём ищу зверей» увёл за 135 бл., ночь в норе, 25 мин без портала.
      // ND_CAST_BEFORE_FOOD=0 — прежний порядок.
      const castFirst = process.env.ND_CAST_BEFORE_FOOD !== '0' && !known.portal && castNear() && (state.food ?? 20) > 6
      if (!died && !castFirst && foodUnits() < 2 && (state.food ?? 20) <= 15 && gameClock.now() >= foodSearchAt && !cooling(STAGES.find(x => x.name === 'food'))) {
        foodSearchAt = gameClock.now() + 300000
        log(`еды ${foodUnits()}, сытость ${state.food} — днём ищу зверей, пока светло`)
        const before = stageProgress('food')
        try { await stageRun('food')() } catch (e) { if (e.stopCampaign) throw e; log(`поиск еды днём: ${e.message}`) }
        await refresh()
        if (Object.entries(stageProgress('food')).some(([key, value]) => Number(value) > (before[key] || 0))) loop.lastProgressAt = gameClock.now()
      }
    }
  }
}

export { loopChores }
