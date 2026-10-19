'use strict'
// Ночь до портала (nightHold): работа внизу (night-work-step), литьё у лавы, за водой, в Ад через портал, нора и коробка
// поверху, ожидание в закрытом. Рассвет внизу — наверх своей лестницей.
import { died, state, sit, known, nightHeld, lavaSourceKnown, setNightHeld, setStage } from '../state'
import { log } from '../log'
import { have, dim, PICK_STONE, portalFar, portalBuckets, todNow, lighter } from '../queries'
import { sense, refresh } from '../observe'
import { castNear, nightHold, nightDigWood, READY, stageProgress, stageRun } from '../stages/table'
import { act } from '../act'
import { leaveWater } from '../danger'
import { toSurface } from '../underground'
import { structureValue } from '../scout'
import { enterNether } from '../nether-trip'
import { nightWorkEnabled, nightWorkHere, nightWorkStep } from '../night-work-step'
import type { CampaignTurn, TurnFlow } from './turn'
import * as gameClock from '../../src/game-clock'
let nightDigAt = 0
let nightCastAt = 0
let nightEnterAt = 0
let nightWaterAt = 0

async function loopNight (loop: CampaignTurn): Promise<TurnFlow> {
  // Ночь до портала без брони (nightHold): работа под землёй той же цепочкой этапа iron (лесенкой к y 16, штреки: железо на
  // броню и щит, уголь, гравий); пережидать нельзя (правило пользователя), поверху — смерть (обе смерти cl-e 14.10 — ночью
  // поверху). Литьё у видимой лавы с готовым набором не прерываю (castNear).
  // Ночь кончилась, а тело внизу: наверх своей лестницей до наземных этапов — разведка поверху из глубины шла пещерами
  // (cl-t 14.10: с y 16 explore поднял в пещеру с тремя зомби, смерть на рассвете).
  if (nightHeld && !nightHold() && !died) {
    setNightHeld(false)
    await sense()
    if (!sit.surface && !sit.night && dim() === 'overworld') {
      if (nightWorkHere()) {
        const worked = await nightWorkStep()
        if (worked?.progress) { loop.lastProgressAt = gameClock.now(); setNightHeld(true); return 'continue' }
      }
      setStage('-'); log('рассвет — наверх своей лестницей'); await toSurface()
    }
  }
  if (!died && nightHold()) {
    setNightHeld(true)
    if (nightWorkEnabled) {
      const worked = await nightWorkStep()
      if (worked) { if (worked.progress) loop.lastProgressAt = gameClock.now(); return 'continue' }
    }
    if (!nightWorkEnabled && !known.portal && castNear() && gameClock.now() >= nightCastAt) {
      nightCastAt = gameClock.now() + 120000
      setStage('cast')
      log('ночь, но лава рядом и набор литья готов — литьё')
      try { await stageRun('cast')() } catch (e) { if (e.stopCampaign) throw e; log(`ночное литьё: ${e.message}`) }
      return 'continue'
    }
    // Набор собран (ведро, огниво), лава-источник видена в 96 бл., нет только воды: ждать рассвета — N с впустую, заход за
    // водой и литьё ночью поверху — ~90 с по цене structure-value.NIGHT_SECONDS. Ждать дороже — иду (пользователь: «ночью не
    // пережидать»; g3-s2-1 14.10: ночь в коробке с готовым железом, на рассвете — смерть в деревне).
    if (!nightWorkEnabled && !known.portal && !have('water_bucket') && have(/^bucket$/) >= portalBuckets() && lighter() && lavaSourceKnown && known.lava && state.pos &&
        Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) <= 96 && gameClock.now() >= nightWaterAt && (state.health ?? 20) >= 12) {
      const t = todNow()
      const toDawn = t !== null && t >= 11840 && t < 23460 ? (23460 - t) / 20 : 0
      const risk = 90 * structureValue.NIGHT_SECONDS
      if (toDawn > risk) {
        nightWaterAt = gameClock.now() + 180000
        log(`ночь: набор литья готов, лава видена, нет воды — до рассвета ${Math.round(toDawn)} с ждать, ночь поверху ≈ ${risk} с: за водой и литьё`)
        setStage('water')
        try { await stageRun('water')() } catch (e) { if (e.stopCampaign) throw e; log(`ночью за водой: ${e.message}`) }
        if (have('water_bucket') && !died && !known.portal) {
          setStage('cast')
          try { await stageRun('cast')() } catch (e) { if (e.stopCampaign) throw e; log(`ночное литьё: ${e.message}`) }
        }
        return 'continue'
      }
    }
    // Портал есть и в Ад готов — ночь не пережидать, а уйти в Ад (там нет ночи); портал рядом.
    if (!nightWorkEnabled && known.portal && READY.nether() && portalFar() < 96 && gameClock.now() >= nightEnterAt) {
      nightEnterAt = gameClock.now() + 120000
      setStage('nether')
      log('ночь, портал рядом и в Ад готов — ухожу в Ад')
      try { await enterNether() } catch (e) { if (e.stopCampaign) throw e; log(`ночью в Ад: ${e.message}`) }
      return 'continue'
    }
    // Поверху ночью — сначала нора на месте (3 вниз, крыша), работа вниз — уже из неё: скелет бьёт за 15 бл., пока тело ищет
    // сухое место для лестницы (cl-u 14.10: смерть через минуту после темноты, у воды). Нора не копается — коробка.
    if (sit.surface) {
      setStage('-')
      const hole = await act('shelter', { mode: 'enter', depth: 3 })
      await sense()
      // Нора с открытым боком у воды заливается: из воды — и коробку (cl-y 14.10).
      if (sit.inWater && !died) { await leaveWater(); await sense() }
      if (!sit.surface && !died && !sit.inWater && /ПОТОЛОК ОТКРЫТ/.test(String(hole.detail?.note || ''))) {
        await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why: 'ночь: нора открыта — коробка' })
        return 'continue'
      }
      // Вниз не вышло (вода под дёрном, болото, берег — cl-p 14.10: 3 мин ночью поверху в поисках сухого места, смерть от
      // зомби): коробка на месте — стены от ходячих, крыша от стрел, до рассвета.
      if (sit.surface && !died) {
        const r = await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why: 'ночь: вниз здесь нельзя — коробка' })
        if (!(r && r.detail && r.detail.stayed)) await act('wait', { seconds: 5 })
      }
      return 'continue'
    }
    if (gameClock.now() >= nightDigAt && nightDigWood()) {
      nightDigAt = gameClock.now() + 120000
      // Кирки по камню ещё нет — ночь на лестнице за камнем (этап stone копает вниз), есть — штреки этапа iron.
      const work = have(PICK_STONE) > 0 ? 'iron' : 'stone'
      setStage(work)
      log(work === 'iron' ? 'ночь, брони нет — работаю под землёй (железо на броню, уголь, гравий), поверху — с рассветом' : 'ночь, кирки по камню нет — камень под землёй, поверху — с рассветом')
      const before = stageProgress(work)
      try { await stageRun(work)(work === 'iron' && !known.portal) } catch (e) { if (e.stopCampaign) throw e; log(`ночная работа внизу: ${e.message}`) }
      // Железо, ведро, щит ночной работы — прогресс для сторожа (cl-k 14.10: 9 слитков и ведро за ночь, а сторож через 48 мин
      // «без прогресса» остановил кампанию: этапы вне хода не обновляли его отметку).
      await refresh()
      if (Object.entries(stageProgress(work)).some(([key, value]) => Number(value) > (before[key] || 0))) loop.lastProgressAt = gameClock.now()
      return 'continue'
    }
    // Работа внизу сделана или отказала — наземные этапы графа (вода, охота, разведка) ночью не зову (cl-k 14.10: вода ночью
    // вывела наверх, cl-h/cl-j: охота и берег ночью — смерть): короткое ожидание в выработке. Залило — сперва из воды
    // (cl-y 14.10: нора у воды с открытым боком залилась, ожидание по 20 с под водой — утонул).
    setStage('-')
    await sense()
    if (sit.inWater) await leaveWater()
    else {
      // Ждать — в закрытом: на ступенях своей лестницы скелет из пещеры стрелял, а ожидание шло по 20 с под стрелами (cl-an2
      // 14.10: «wait 20» ×5 между боями со скелетом, смерть на 12-й мин). Замкнутый карман refuge признаёт сразу, коробка — 2–3 с.
      const r = await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why: 'ночь: жду внизу в закрытом' })
      const shut = !!(r && r.detail && (r.detail.stayed || r.detail.how === 'pocket'))
      await act('wait', { seconds: shut ? 20 : 5 })
    }
    return 'continue'
  }
}

export { loopNight }
