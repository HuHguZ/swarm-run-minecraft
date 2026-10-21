'use strict'
// Ночь до портала (nightHold): работа внизу (night-work-step), литьё у лавы, за водой, в Ад через портал, нора и коробка
// поверху, ожидание в закрытом. Рассвет внизу — наверх своей лестницей.
import { died, state, sit, known, nightHeld, lavaSourceKnown, setNightHeld, setStage, skyLavaSeen, setLavaSourceKnown, knownWater, setSkyLookAt, setSkyLavaSeen } from '../state'
import { log } from '../log'
import { have, dim, PICK_STONE, portalFar, portalBuckets, todNow, lighter } from '../queries'
import { sense, refresh } from '../observe'
import { castNear, nightHold, nightDigWood, READY, stageProgress, stageRun, near3 } from '../stages/table'
import { act } from '../act'
import { leaveWater } from '../danger'
import { toSurface } from '../underground'
import { structureValue, lavaLookout } from '../scout'
import { enterNether } from '../nether-trip'
import { nightWorkEnabled, nightWorkHere, nightWorkStep } from '../night-work-step'
import type { CampaignTurn, TurnFlow } from './turn'
import * as gameClock from '../../src/game-clock'
let nightDigAt = 0
let nightCastAt = 0
let nightEnterAt = 0
let nightWaterAt = 0
let nightIronEmpty = 0
let nightKitEmpty = 0
const nightLooked = new Set<string>()

async function loopNight (loop: CampaignTurn): Promise<TurnFlow> {
  // nightHold requires a pick. A real threat without one still permits an emergency hand shelter.
  // No untilDawn/wait: return control to useful planning once the refuge action settles.
  if (process.env.ND_OW_DESERT_HAND_SHELTER === '1' && !died && dim() === 'overworld' &&
      state.playPolicy?.mode === 'speedrun' && sit.night && sit.surface && sit.foes > 0 && !have(/_pickaxe$/)) {
    if (sit.inWater && !(await leaveWater())) return 'continue'
    const hole = await act('shelter', { mode: 'enter', depth: 3, torch: false })
    if (died) return 'continue'
    if (hole.detail?.sealed && hole.detail.depth >= 2) {
      await act('refuge', { minHp: 20, maxSeconds: 15, stayIn: true, why: 'night threat: hand shelter, then replan' })
    } else await act('flee', { timeoutSeconds: 8 })
    return 'continue'
  }
  // Ночь до портала без брони (nightHold): работа под землёй той же цепочкой этапа iron (лесенкой к y 16, штреки: железо на
  // броню и щит, уголь, гравий); пережидать нельзя (правило пользователя), поверху — смерть (обе смерти cl-e 14.10 — ночью
  // поверху). Литьё у видимой лавы с готовым набором не прерываю (castNear).
  // Ночь кончилась, а тело внизу: наверх своей лестницей до наземных этапов — разведка поверху из глубины шла пещерами
  // (cl-t 14.10: с y 16 explore поднял в пещеру с тремя зомби, смерть на рассвете).
  if (nightHeld && !nightHold() && !died) {
    setNightHeld(false)
    nightIronEmpty = 0
    nightKitEmpty = 0
    await sense()
    if (!sit.surface && !sit.night && dim() === 'overworld') {
      if (nightWorkHere(true)) {
        const worked = await nightWorkStep()
        if (worked?.progress) { loop.lastProgressAt = gameClock.now(); setNightHeld(true); return 'continue' }
      }
      // ND_OW_DAWN_STAY_DOWN=1: набор портала не собран, а тело уже на глубине железа — подъём своей лестницей и новый спуск
      // (≈50 уровней туда и обратно, ~5 игр. мин) дороже, чем продолжить штреки здесь; этап iron работает и под землёй.
      const stayDown = process.env.ND_OW_DAWN_STAY_DOWN === '1' && !known.portal && (state.pos?.y ?? 64) < 40 && have(PICK_STONE) > 0 &&
        (have(/bucket$/) < portalBuckets() || !lighter()) && (state.health ?? 20) >= 12 && (state.food ?? 20) >= 8
      if (stayDown) log('рассвет: набор не собран, я на глубине железа — продолжаю здесь, наверх с набором')
      else { setStage('-'); log('рассвет — наверх своей лестницей'); await toSurface() }
    }
  }
  if (!died && nightHold()) {
    setNightHeld(true)
    // ND_OW_NIGHT_IRON=1: под землёй ночь не отличается от дня (спавн там от темноты, не от времени суток) — с несобранным набором
    // портала этап iron целиком, как днём; поверху его шаги ночью и так не идут (sit.night). nightWork до вехи iron — 9 игр. мин на
    // прогон (90 прогонов C12/R32/R37/D0), отказы NIGHT_RISK 390 и «нет доступной работы» 1784 (C5–C12). Два пустых захода — прежний nightWork.
    if (process.env.ND_OW_NIGHT_IRON === '1') await sense()
    // Только глубоко (y < 50): у поверхности этап iron на мокром спуске уходил отходом поверху (owE2-06: −9170, ночь, «вода под дёрном —
    // отхожу на 24 бл.», зомби и паук — смерть на 13-й мин); там — прежний nightWork.
    if (process.env.ND_OW_NIGHT_IRON === '1' && !sit.surface && !sit.inWater && !known.portal && dim() === 'overworld' && have(PICK_STONE) > 0 &&
        (state.pos?.y ?? 64) < 50 &&
        (have(/bucket$/) < portalBuckets() || !lighter()) && (state.health ?? 20) >= 10 && (state.food ?? 20) >= 6 && nightIronEmpty < 2) {
      setStage('iron')
      log('ночь, набор не собран, я под землёй — штреки этапа iron, как днём; поверху — с рассветом')
      const before = stageProgress('iron')
      try { await stageRun('iron')(true) } catch (e) { if (e.stopCampaign) throw e; log(`ночная работа внизу: ${e.message}`) }
      await refresh()
      if (Object.entries(stageProgress('iron')).some(([key, value]) => Number(value) > (before[key] || 0))) { loop.lastProgressAt = gameClock.now(); nightIronEmpty = 0 } else nightIronEmpty++
      return 'continue'
    }
    // ND_OW_NIGHT_KIT=1: набор собран, я под землёй ночью — вода тем же подземным шагом, что днём (kitWaterHere: видимая в 48, увиденная
    // раньше — подходом под землёй, слух), затем литьё у увиденной лавы в 64 (пещерная лава ночью видна в штреках: «видел лаву на …»).
    // Поверху — с рассветом. Два пустых захода — прежний nightWork. owD0-07: 29 мин ночного пинг-понга к воде с готовым набором.
    if (process.env.ND_OW_NIGHT_KIT === '1') await sense()
    if (process.env.ND_OW_NIGHT_KIT === '1' && !sit.surface && !sit.inWater && !known.portal && dim() === 'overworld' &&
        have(/bucket$/) >= portalBuckets() && lighter() && (state.health ?? 20) >= 10 && nightKitEmpty < 2) {
      const hadWater = have('water_bucket') > 0
      if (!hadWater) {
        setStage('water')
        log('ночь, набор собран, я под землёй — вода под землёй (видимая, увиденная раньше, по слуху)')
        // Ленивый require: песочницы тестов loop/night (vm с заглушками require) без portal-kit.
        try { await (require('../portal-kit') as typeof import('../portal-kit')).kitWaterHere() } catch (e) { if (e.stopCampaign) throw e; log(`ночная вода внизу: ${e.message}`) }
        await refresh()
      }
      if (have('water_bucket') && known.lava && near3(known.lava, 64) && !died) {
        setStage('cast')
        log(`ночь, набор и вода есть, лава видена у ${known.lava.x},${known.lava.y},${known.lava.z} — литьё`)
        try { await stageRun('cast')() } catch (e) { if (e.stopCampaign) throw e; log(`ночное литьё внизу: ${e.message}`) }
        await refresh()
      }
      // ND_OW_NIGHT_SKY_CAST=1: набор и вода есть, внизу литьё не встало, а озеро под небом видено (skyLavaSeen) в 128 бл. — подъём своей
      // лестницей и литьё ночью, если до рассвета больше минуты (owE1-07: набор и вода к 11 мин на y14, озеро в 17 бл. от спавна с 0-й мин,
      // ждал рассвета 22-й мин и не отлил до 40-й). Цена — минута поверху ночью против ожидания до рассвета.
      // Воды нет, а поверху видел воду (knownWater y ≥ 55 в 96 бл.) — то же: наверх, вода, литьё (owG1-02/03: набор к 11–16 мин, внизу воды
      // не видно — 8–17 мин nightWork до рассвета).
      // ND_OW_NIGHT_LOOK=1: озера под небом не видел — наверх и вышка обзора ночью: лава и вода видны лучом так же, как днём
      // (ночью лава ещё и светится), минута на столбе против ночи внизу: nightWork после набора — 6 мин/прогон (66 полных прогонов),
      // owN0-owD0-10: озеро в 40 бл. известно, а ночная работа ушла лестницей к y −54. Один раз на место (32 бл.).
      if (process.env.ND_OW_NIGHT_LOOK === '1' && !known.portal && !died && state.pos && (state.health ?? 20) >= 14 &&
          (!skyLavaSeen || skyLavaSeen.hint) && !(lavaSourceKnown && known.lava && (known.lava.y ?? 0) >= 50)) {
        const key = `${Math.round(state.pos.x / 32)},${Math.round(state.pos.z / 32)}`
        if (!nightLooked.has(key)) {
          nightLooked.add(key)
          log('ночь: набор есть, озера под небом не видел — наверх, вышка обзора (лава и вода видны и ночью)')
          try {
            if (await toSurface() && !died) { setSkyLookAt(null); await lavaLookout(); await refresh() }
          } catch (e) { if (e.stopCampaign) throw e; log(`ночной обзор: ${e.message}`) }
          if (!skyLavaSeen && lavaSourceKnown && known.lava && (known.lava.y ?? 0) >= 50) setSkyLavaSeen({ ...known.lava })
        }
      }
      const surfWater = !have('water_bucket') && knownWater && (knownWater.y ?? 0) >= 55 && state.pos &&
        Math.hypot(knownWater.x - state.pos.x, knownWater.z - state.pos.z) <= 96
      if (process.env.ND_OW_NIGHT_SKY_CAST === '1' && (have('water_bucket') || surfWater) && !known.portal && !died && skyLavaSeen && !skyLavaSeen.hint &&
          Number.isFinite(skyLavaSeen.x) && state.pos && Math.hypot(skyLavaSeen.x - state.pos.x, skyLavaSeen.z - state.pos.z) <= 128 &&
          (state.health ?? 20) >= 14) {
        const t = todNow()
        const toDawn = t !== null && t >= 11840 && t < 23460 ? (23460 - t) / 20 : 0
        if (toDawn > 60) {
          log(`ночь: набор и вода есть, озеро под небом ${skyLavaSeen.x},${skyLavaSeen.y},${skyLavaSeen.z} — наверх и литьё ночью (до рассвета ${Math.round(toDawn)} с)`)
          known.lava = { x: skyLavaSeen.x, y: skyLavaSeen.y, z: skyLavaSeen.z }
          setLavaSourceKnown(true)
          setStage('cast')
          try {
            if (await toSurface() && !died) {
              if (!have('water_bucket')) { setStage('water'); await stageRun('water')(); await refresh() }
              if (have('water_bucket') && !died) { setStage('cast'); await stageRun('cast')() }
            }
          } catch (e) { if (e.stopCampaign) throw e; log(`ночное литьё у озера: ${e.message}`) }
          await refresh()
        }
      }
      // ND_OW_NIGHT_DEEP=1: набор и вода есть, а лавы для литья в 64 бл. не видно (и озера под небом нет) — глубокая лава ночью тем же путём,
      // что днём (DeepLavaPortal: вниз к −54, лава по виду и слуху, литьё): под землёй ночь как день, спавн там от темноты. −9170: озеро
      // в ~300 бл., лава у бедрока в 15–60 бл. от снимков (оракул), ночная работа до рассвета её не находит (8–9 мин из 20 на скамье).
      if (process.env.ND_OW_NIGHT_DEEP === '1' && have('water_bucket') && !known.portal && !died && !sit.surface && state.pos &&
          (state.health ?? 20) >= 12 && !(known.lava && near3(known.lava, 64)) && !(skyLavaSeen && !skyLavaSeen.hint)) {
        const t = todNow()
        const toDawn = t !== null && t >= 11840 && t < 23460 ? (23460 - t) / 20 : 0
        if (toDawn > 90) {
          log(`ночь: набор и вода есть, лавы рядом не видно — глубокая лава ночью (до рассвета ${Math.round(toDawn)} с)`)
          setStage('cast')
          // Ленивые require: песочницы тестов loop/night без этих модулей.
          const deep = require('../../src/campaign/deep-lava') as typeof import('../../src/campaign/deep-lava')
          const kitMod = require('../kit') as typeof import('../kit'), pk = require('../portal-kit') as typeof import('../portal-kit')
          const st = require('../state') as typeof import('../state'), obs = require('../observe') as typeof import('../observe')
          try {
            const r = await deep.runDeepLava({ now: () => gameClock.now(), stopped: () => died || st.strategyInterrupted, position: () => state.pos,
              portal: () => !!known.portal, water: () => have('water_bucket') > 0, prepare: kitMod.spares, act, hear: process.env.ND_OW_HEAR !== '0',
              cast: async params => { const c = await pk.castForKit(params); await obs.readMemory(); return c } }, Math.min(600, toDawn - 30))
            log(`ночная глубокая лава: ${r}`)
          } catch (e) { if (e.stopCampaign) throw e; log(`ночная глубокая лава: ${e.message}`) }
          await refresh()
        }
      }
      if (known.portal || (!hadWater && have('water_bucket'))) { loop.lastProgressAt = gameClock.now(); nightKitEmpty = 0 } else nightKitEmpty++
      return 'continue'
    }
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
