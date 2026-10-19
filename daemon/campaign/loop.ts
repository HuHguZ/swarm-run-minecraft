'use strict'
// Главный цикл кампании: выбор этапа, паузы, сторож, смерть, свободный режим.
import { only, PAUSE_MIN, WATCHDOG_MIN, NIGHT_DOWN2, EYES_NEED } from './flags'
import { ws, call, sleep } from './rpc'
import { T0, stage, manualControl, strategyExecuting, strategyTail, state, sit, memorySnapshot, died, detached, known,
  fightGearWanted, quickHuntAt, nightHeld, lavaSourceKnown, barterRetryPending, bastionPausedUntil, blazeDugInAt,
  homeForGearState, setBarterRetryPending, setBastionPausedUntil, setBlazeDugInAt, setHeading, setHomeForGearState,
  setNightHeld, setQuickHuntAt, setStage } from './state'
import { telemetry, seamSnapshot, log } from './log'
import { bag, have, dim, LOGS, foodUnits, PICK_STONE, planksFor, portalFar, portalBuckets, todNow, shieldOn, lighter,
  pearlsNow } from './queries'
import { sense, refresh, readMemory, bState } from './observe'
import { STAGES, OTHER_WORLD, castNear, nightHold, nightDigWood, weakAndHungry, READY, netherLack, fightReady,
  fightLack, stageProgress, FOOD_STOCK, stageRun } from './stages/table'
import { eyesWant, barterFlow, deferBastionMining, bastionBlocked, nextBastion, bastionPearlsPending, rodsWanted,
  netherRetryState, netherFailureName, netherFailureState, overworldFailureState } from './nether-plan'
import { act } from './act'
import { leaveWater } from './danger'
import { nightGuard, recoverGuard } from './guards'
import { walkAway, returnFromNether } from './travel'
import { craft, ensurePick } from './kit'
import { toSurface } from './underground'
import { quickHunt } from './food'
import { dayLavaActive, lavaLookout, skyLavaLook, structureValue, lootSeenStructures } from './scout'
import { enterNether, netherArrival, continueFortressChoice, changeNetherCause } from './nether-trip'
import { intelligence } from './strategy-bridge'
import { nightWorkEnabled, nightWorkHere, nightWorkStep } from './night-work-step'
const gameClock: typeof import('../src/game-clock') = require('../src/game-clock')
let lastStage = '-'
let nightDigAt = 0
let nightCastAt = 0
let nightEnterAt = 0
let nightWaterAt = 0
let foodSearchAt = 0
let skyLookNext = 0
let structLootNext = 0
let netherShieldAt = -Infinity

async function runCampaign () {
  try {
    await act('connect')
    await act('play_mode', { mode: 'speedrun', foodTarget: FOOD_STOCK })
    await act('set_goal', { text: 'Пройти игру честно: дерево → камень → еда → железо → вода → алмазы → обсидиан → портал → Ад → жемчуг → око → крепость → дракон' })
    await refresh()
    await readMemory()
    if (!known.portal && state.pos && Math.hypot(state.pos.x, state.pos.z) > 32) setHeading(Math.atan2(state.pos.z, state.pos.x))
    log(`старт: ${bag()}${known.portal ? `; портал в памяти ${known.portal.x},${known.portal.y},${known.portal.z}` : ''}`)
    seamSnapshot('start')
    const fails = new Map()
    let netherThreatWaits = 0
    let threatHp0 = 20
    let threatBurrowAt = -Infinity
    const failureKey = name => {
      if (process.env.ND_NE_RECOVER === '1' && dim() === 'the_nether') name = netherFailureName(name)
      const site = name === 'bastion' ? nextBastion() : null
      return site ? `${name}:${site.dimension || 'the_nether'}:${site.x}:${site.z}` : name
    }
    const cooling = s => {
      const f = fails.get(failureKey(s.name))
      if (f?.ow) return dim() === 'overworld' && f.observed === overworldFailureState(f.origin)
      if (f?.observed !== undefined) return dim() === 'the_nether' && f.observed === (f.kind ? netherFailureState(f.kind, f.origin) : netherRetryState(f.origin))
      if (process.env.ND_NE_RECOVER === '1' && netherFailureName(s.name) === 'bastion') { const b = nextBastion(); if (b && bastionBlocked(b)) return true }
      return !!f && f.until > gameClock.now()
    }
    const failStage = (name, key) => {
      const kind = process.env.ND_NE_RECOVER === '1' ? netherFailureName(name) : null
      if (kind && dim() === 'the_nether' && ['nether', 'bastion', 'pearls', 'netherTools', 'bastionSupply'].includes(kind)) {
        fails.set(key, { kind, observed: netherFailureState(kind), origin: state.pos && { ...state.pos }, until: Infinity })
        log('этап ' + kind + ': повтор после смены причины; дальше другой подход или цель по цене')
        return
      }
      if (name === 'nether' && dim() === 'the_nether') {
        fails.set(key, { observed: netherRetryState(), origin: state.pos && { ...state.pos }, until: Infinity })
        log('поиск крепости не продвинулся — повтор после нового обзора, пути, снабжения или смены угрозы')
        return
      }
      if (process.env.ND_OW_CAUSE_RETRY === '1' && dim() === 'overworld') {
        const prev = fails.get(key)
        const n = prev?.ow ? prev.n + 1 : 1
        // Первый пустой заход — сразу другой этап по цене; второй при том же состоянии — ждать смены причины.
        fails.set(key, { ow: true, n, observed: n >= 2 ? overworldFailureState(state.pos) : '', origin: state.pos && { ...state.pos }, until: 0 })
        if (n >= 2) log(`этап ${name}: пустой заход при том же состоянии — повтор после смены причины (место, ночь, вода/лава, снаряжение, еда)`)
        return
      }
      const f = fails.get(key) || { n: 0, level: 0, until: 0 }
      f.n++
      f.at = gameClock.now()
      if (f.n >= (f.level ? 1 : 2)) {
        const PM = process.env.ND_NE_STAY === '1' && dim() === 'the_nether' ? [1, 2, 3, 4] : PAUSE_MIN
        const min = PM[Math.min(f.level, PM.length - 1)]
        f.until = gameClock.now() + min * 60000
        f.level++
        f.n = 0
        log(`этап ${name}: ${f.level > 1 ? 'снова пустой заход' : 'два пустых захода подряд'} — пауза ${min} мин`)
        if (/^(bastion|BastionBarter|PiglinBarter)$/.test(name)) setBastionPausedUntil(Math.max(bastionPausedUntil, f.until))
        if (name === 'bastion' && dim() === 'the_nether' && have('gold_ingot') + 9 * have('gold_block') < 8) {
          const attempted = (known.bastions || []).find(b => key === `${name}:${b.dimension || 'the_nether'}:${b.x}:${b.z}`)
          if (attempted?.gold?.length && (known.bastions || []).some(other => other !== attempted &&
            Number.isFinite(other.x) && Number.isFinite(other.z) && !bState(other).spent &&
            (bState(other).miningDeferredUntil || 0) <= gameClock.now() &&
            (!barterFlow.enabled() || (bState(other).barterUntil || 0) <= gameClock.now()))) deferBastionMining(attempted)
        }
      }
      fails.set(key, f)
    }
    const resetPauses = why => { if (fails.size) { log(`паузы этапов сняты: ${why}`); fails.clear() } }
    let lastProgressAt = gameClock.now()
    let lastDim = dim()
    let arrivalPending = dim() === 'the_nether'
    let wasNight = !!sit.night
    for (let turn = 1; turn <= 5000; turn++) {
      await refresh()
      await sense()
      if (state.playPolicy?.mode === 'free') { log('режим free — кампания уступает управление игроку'); break }
      if (state.connected === false) {
        setStage('-')
        log('тело не в игре — переподключаюсь')
        await act('connect')
        await refresh()
        if (state.connected === false) await gameClock.wall.sleep(30000)
        continue
      }
      if (dim() !== lastDim) { resetPauses(`смена измерения ${lastDim} → ${dim()}`); await readMemory(); seamSnapshot(`observed:${lastDim}->${dim()}`); lastDim = dim(); arrivalPending = dim() === 'the_nether' }
      if (arrivalPending && dim() === 'the_nether' && !died) { arrivalPending = false; setStage('-'); try { await netherArrival() } catch (e) { if (e.stopCampaign) throw e; log(`прибытие: ${e.message}`) } }
      if (wasNight && !sit.night && dim() === 'overworld') resetPauses('рассвет')
      wasNight = !!sit.night
      if (died) {
        setStage('-')
        try { await recoverGuard() } catch (e) { if (e.stopCampaign) throw e; log(`после смерти: ${e.message}`) }
      }
      if (gameClock.now() - lastProgressAt >= WATCHDOG_MIN * 60000) {
        setStage('-')
        log(`БЛОКЕР: сторож — ${Math.round((gameClock.now() - lastProgressAt) / 60000)} мин без прогресса ни в одном этапе (последний этап ${lastStage}); останавливаю кампанию`)
        await act('stop')
        process.exitCode = 2
        break
      }
      const turnStart = gameClock.now()
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
            if (Object.entries(stageProgress('food')).some(([key, value]) => Number(value) > (before[key] || 0))) lastProgressAt = gameClock.now()
          }
        }
      }
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
            if (worked?.progress) { lastProgressAt = gameClock.now(); setNightHeld(true); continue }
          }
          setStage('-'); log('рассвет — наверх своей лестницей'); await toSurface()
        }
      }
      if (!died && nightHold()) {
        setNightHeld(true)
        if (nightWorkEnabled) {
          const worked = await nightWorkStep()
          if (worked) { if (worked.progress) lastProgressAt = gameClock.now(); continue }
        }
        if (!nightWorkEnabled && !known.portal && castNear() && gameClock.now() >= nightCastAt) {
          nightCastAt = gameClock.now() + 120000
          setStage('cast')
          log('ночь, но лава рядом и набор литья готов — литьё')
          try { await stageRun('cast')() } catch (e) { if (e.stopCampaign) throw e; log(`ночное литьё: ${e.message}`) }
          continue
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
            continue
          }
        }
        // Портал есть и в Ад готов — ночь не пережидать, а уйти в Ад (там нет ночи); портал рядом.
        if (!nightWorkEnabled && known.portal && READY.nether() && portalFar() < 96 && gameClock.now() >= nightEnterAt) {
          nightEnterAt = gameClock.now() + 120000
          setStage('nether')
          log('ночь, портал рядом и в Ад готов — ухожу в Ад')
          try { await enterNether() } catch (e) { if (e.stopCampaign) throw e; log(`ночью в Ад: ${e.message}`) }
          continue
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
            continue
          }
          // Вниз не вышло (вода под дёрном, болото, берег — cl-p 14.10: 3 мин ночью поверху в поисках сухого места, смерть от
          // зомби): коробка на месте — стены от ходячих, крыша от стрел, до рассвета.
          if (sit.surface && !died) {
            const r = await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why: 'ночь: вниз здесь нельзя — коробка' })
            if (!(r && r.detail && r.detail.stayed)) await act('wait', { seconds: 5 })
          }
          continue
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
          if (Object.entries(stageProgress(work)).some(([key, value]) => Number(value) > (before[key] || 0))) lastProgressAt = gameClock.now()
          continue
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
        continue
      }
      if (only && dim() !== 'overworld' && !have(/_pickaxe$/)) { setStage('-'); await ensurePick() }
      const need = STAGES.filter(s => !(only && !only.includes(s.name)) && s.needed() && (dim() === 'overworld' || OTHER_WORLD.has(s.name)))
      const selection = only ? null : await intelligence.select(need, cooling)
      if (await continueFortressChoice(selection, fails.get(failureKey('nether')))) continue
      if (!selection && dim() === 'the_nether' && !bastionPearlsPending() && need.some(s => s.name === 'nether') && (!READY.nether() || (fightGearWanted && !fightReady())) &&
          homeForGearState?.observed !== netherRetryState(homeForGearState?.origin)) {
        setStage('-')
        log(`для ифритов не хватает ${fightGearWanted ? fightLack() : netherLack()} — домой за недостающим`)
        await returnFromNether()
        if (dim() === 'the_nether') {
          await act('ne_burrow', { why: 'домой не вышло' })
          setHomeForGearState({ observed: netherRetryState(), origin: state.pos && { ...state.pos } })
        }
        continue
      }
      if (!selection && !need.length && dim() === 'the_nether') {
        setStage('-')
        log('в Аду делать нечего (кирки нет или стержни есть) — домой через портал')
        await returnFromNether()
        continue
      }
      if (!selection && !need.length) {
        setStage('-')
        if (known.dragonWon) { log('все этапы готовы'); break }
        if (only) { log(`нужных этапов нет среди ${only.join(',')} — запуск окончен (дракон жив: жемчуга ${pearlsNow()} из ${EYES_NEED}, очей ${have('ender_eye')})`); break }
        log(`нужных этапов нет, а дракон жив (жемчуга ${pearlsNow()} из ${EYES_NEED}, очей ${have('ender_eye')}) — жду перемены, остановит сторож`)
        if (dim() === 'overworld') await leaveWater()
        await act('wait', { seconds: 60 })
        continue
      }
      const foodFail = fails.get('food')
      const urgentOk = x => !cooling(x) || !foodFail || gameClock.now() - (foodFail.at || 0) > 90000
      const urgent = weakAndHungry() ? need.find(x => x.name === 'food' && urgentOk(x) && x.ready() && !x.defer()) : null
      const legacy = only && (urgent || need.find(x => !cooling(x) && x.ready() && !x.defer()))
      const s = legacy ? (only ? legacy : intelligence.wrap(legacy)) : selection?.stage
      if (!s && dim() === 'the_nether' && (state.tactics?.threatLevel ?? 0) >= 2 && netherThreatWaits < 20 && !died) {
        // Граф молчит из-за угрозы (intelligence.select: threatLevel ≥ 2) — не повод идти домой: путь к порталу под
        // ифритами рвёт тактика и тело гибнет на ходу (s1-post01b 06.10). Ифриты, а стержни нужны — бой у спавнера;
        // иначе короткое ожидание, пока тактика не снимет угрозу.
        netherThreatWaits++
        setStage('-')
        // У спавнера (в 24 бл. по памяти) угроза — это ифриты, даже если sit.fight их не перечислил: бой ведёт blaze, а не тактика
        // (s1-post21hole 06.10: навык вернулся по времени с 3 стержнями, кампания ждала тактику у спавнера — смерть).
        const spMem = memorySnapshot?.places?.['спавнер блейзов']
        const nearSpawner = !!(spMem && state.pos && dim() === 'the_nether' && Math.hypot(spMem.x - state.pos.x, spMem.z - state.pos.z) <= 24 && Math.abs(spMem.y - state.pos.y) <= 24)
        const blazes = (sit.fight?.order || []).some(o => o && o.name === 'blaze') || nearSpawner
        if (blazes && rodsWanted() && !bastionPearlsPending() && known.fortress && fightReady()) {
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
        } else if (nearSpawner && !rodsWanted() && netherThreatWaits <= 2 && gameClock.now() - blazeDugInAt > 60000) {
          // Стержни набраны, а у спавнера ифриты — в толщу, а не ждать тактику (s1-LE-4 06.10: 5 стержней на 5-й мин, затем LastStand/
          // BlockOff у спавнера — смерть через секунды).
          log('стержни набраны, у спавнера ифриты — закапываюсь')
          await act('ne_burrow', { why: 'стержни набраны — ухожу от ифритов' })
        } else if (netherThreatWaits >= 2 && (gameClock.now() >= threatBurrowAt || (state.health ?? 20) <= threatHp0 - 3) &&
          ((state.health ?? 20) <= threatHp0 - 3 || (sit.fight?.order || []).some(o => o && /^(blaze|ghast)$/.test(o.name)))) {
          // Угроза не снимается, а тело на открытом теряет хп или по нему стреляют издалека (ифриты/гасты у портала прибытия, b1-6-2
          // 14.10: 12 ожиданий по 3 с под огнём ифритов, хп 20 → 2, смерть) — из-под огня в толщу (закрытый карман), а не ждать.
          // Снова — через 15 с или сразу, если хп падает и после норы (b8-5-1 14.10: нора в 22-й мин, через 2 мин ифриты снова,
          // пауза 60 с держала тело в ожиданиях под огнём, хп 20 → 0).
          threatBurrowAt = gameClock.now() + 15000
          log(`в Аду угроза держится (${netherThreatWaits} ожиданий, хп ${Math.round(threatHp0)} → ${Math.round(state.health ?? 0)}) — в толщу, из-под огня`)
          await act('ne_burrow', { why: 'угроза держится — из-под огня' })
          threatHp0 = state.health ?? 20
        } else {
          if (netherThreatWaits === 1) threatHp0 = state.health ?? 20
          log(`в Аду угроза (тактика ${state.tactics?.action || '?'}) — домой не иду, жду её конца`)
          await act('wait', { seconds: 3 })
        }
        continue
      }
      if (s || (state.tactics?.threatLevel ?? 0) < 2) netherThreatWaits = 0
      if (!s) {
        setStage('-')
        const upNeed = dim() === 'the_nether' ? STAGES.filter(x => !(only && !only.includes(x.name)) && !OTHER_WORLD.has(x.name) && x.needed()) : []
        const blockedSearch = fails.get(failureKey('nether'))
        // Закрытый повтор поиска нуждается в собственном ходе к следующему наблюдаемому месту.
        if (dim() === 'the_nether' && known.fortress && rodsWanted() && blockedSearch?.observed !== undefined && process.env.ND_FORTRESS_FRONTIER !== '0') {
          const cause = netherRetryState(blockedSearch.origin)
          if (blockedSearch.frontier !== cause) {
            const probe = await act('fortress', { mode: 'advance', timeoutSeconds: 90 })
            const stoppedCause = netherRetryState(blockedSearch.origin)
            await refresh()
            await readMemory()
            if (!cooling({ name: 'nether' }) || (probe.status === 'done' && probe.detail?.frontierTried > 0)) continue
            blockedSearch.frontier = stoppedCause
            log(probe.detail?.frontierExhausted ? 'крепость: доступные видимые точки обзора исчерпаны; та же недоступная цель не повторяется'
              : `крепость: новый обзор не выполнен (${probe.code || probe.status}); повтор после смены причины`)
          }
        }
        if (await continueFortressChoice(null, blockedSearch)) continue
        if (process.env.ND_NE_RECOVER === '1' && dim() === 'the_nether') {
          if (await changeNetherCause()) continue
          break
        }
        if (process.env.ND_NE_STAY === '1' && dim() === 'the_nether' && need.length && need.every(x => cooling(x))) {
          const blocked = fails.get(failureKey('nether'))
          if (blocked?.observed !== undefined) {
            if (!blocked.covered) {
              blocked.covered = true
              await act('ne_burrow', { why: 'поиск крепости: укрытие перед новым наблюдением' })
              await refresh()
            }
            await act('observe', { radius: 40 })
            await act('wait', { seconds: 3 }) // observation polling; elapsed time does not reopen the search
            continue
          }
          log(`в Аду этапы на паузе (${need.map(x => x.name).join(', ')}) — жду в толще (ND_NE_STAY)`)
          await act('ne_burrow', { why: 'жду конца паузы' })
          await refresh()
          await act('wait', { seconds: 45 })
          continue
        }
        if (upNeed.length && need.every(x => !x.defer() && (cooling(x) || !x.ready()))) {
          log(`в Аду нечем (${need.map(x => x.name).join(', ')}) — домой за: ${upNeed.map(x => x.name).join(', ')}`)
          await returnFromNether()
          continue
        }
        const paused = need.filter(x => cooling(x)).map(x => Math.ceil((fails.get(failureKey(x.name)).until - gameClock.now()) / 60000))
        const blocked = need.every(x => !x.defer() && (cooling(x) || !x.ready()))
        log(`${blocked ? 'нет доступного шага' : 'нужные этапы отложены'} (${need.map(x => `${x.name}${cooling(x) ? '·пауза' : ''}${x.ready() ? '' : '·нечем'}${x.defer() ? '·отложен' : ''}`).join(', ')}) — жду${paused.length ? `: ближайшая пауза кончится через ${Math.min(...paused)} мин` : ' изменения обстановки'}`)
        if (dim() === 'the_nether' && process.env.ND_NE_STAY === '1') { await act('ne_burrow', { why: 'жду конца паузы' }); await refresh() } else
        if (dim() === 'the_nether') await returnFromNether()
        else if ((sit.night || (NIGHT_DOWN2() && sit.dusk)) && sit.surface && dim() === 'overworld') await nightGuard({ dusk: true })
        // Верхний мир: граф молчит из-за угрозы (select: threatLevel ≥ 2), тело у тактики — короткое ожидание, а не 60 с: угроза
        // снята через секунды, и ожидание шло впустую (S8b s8b-a1-3: ×10+ «жду» по 60 с ночью, ~6 игр. мин без хода; S8c).
        const threatWait = dim() === 'overworld' && (state.tactics?.threatLevel ?? 0) >= 1 && process.env.ND_OW_THREAT_WAIT !== '0'
        // Все нужные этапы на паузе после пустых заходов — не стоять по 60 с (cl-a/cl-b/cl-c 14.10: 15–45 мин простоя до сторожа):
        // новое место — новый обзор (звери, вода, лава, руда, постройки). Ночью при малом хп — по-прежнему ждать.
        if (dim() === 'overworld' && blocked && !threatWait && !died && ((state.health ?? 20) >= 14 || !sit.night) && process.env.ND_IDLE_RELOCATE !== '0') {
          const from = state.pos && { ...state.pos }
          log('все нужные этапы на паузе — не стою: меняю место для нового обзора')
          if (!sit.surface) await toSurface()
          else await walkAway(64, Math.PI / 3)
          await refresh()
          const moved = from && state.pos ? Math.hypot(state.pos.x - from.x, state.pos.y - from.y, state.pos.z - from.z) : 0
          if (moved >= 32) resetPauses('новое место')
          if (moved >= 8 || died) continue
        }
        if (gameClock.now() - turnStart < 20000) { if (dim() === 'overworld') await leaveWater(); await act('wait', { seconds: threatWait ? 3 : 60 }) }
        continue
      }
      setStage(s.name)
      lastStage = s.name
      log(`ход ${turn}: начинаю; рюкзак: ${bag()}`)
      const attemptedKey = failureKey(s.name)
      const before = stageProgress(s.name)
      const telStage = telemetry.on() ? { t0: gameClock.now(), wallT0: gameClock.wall.now(), before: telemetry.snapshot(state, sit), dead: died } : null
      let telStageErr = null
      let attemptInterrupted = false
      try {
        if (only) await recoverGuard()
        await s.run()
      } catch (e) {
        if (telStage) telStageErr = String(e.message).slice(0, 240)
        if (e.stopCampaign) throw e
        attemptInterrupted = !!e.strategyInterrupted
        log(`этап упал: ${e.message}`)
      }
      // Снятый директором исполнитель ещё идёт — без ожидания act цикла падал на его флагах (b6-5-1 14.10: FindBastions по
      // тайм-ауту 360 с, «домой за недостающим» → «прогон упал: STRATEGY_INTERRUPTED»).
      if (strategyExecuting) { log('снятая стратегия ещё сворачивается — жду её'); await strategyTail }
      if (manualControl) break
      await refresh()
      await sense()
      await readMemory()
      const off = !s.needed()
      const ok = off && s.done()
      const after = stageProgress(s.name)
      const progressed = s.progressed ? s.progressed() : Object.entries(after).some(([key, value]) => value > (before[key] || 0))
      if (attemptInterrupted || s.interrupted?.()) { log('навык прерван — новое наблюдение и план'); continue }
      if (telStage) {
        const snap = telemetry.snapshot(state, sit)
        telemetry.record({ level: 'stage', stage: s.name, turn, sec: Math.round((gameClock.now() - telStage.t0) / 100) / 10, wallSec: (gameClock.wall.now() - telStage.wallT0) / 1000, ok, off, progressed,
          error: telStageErr, death: died && !telStage.dead, sinceStart: Math.round((gameClock.now() - T0) / 1000), before: telStage.before, after: snap,
          gained: telemetry.delta(telStage.before, snap) })
      }
      if (!off && s.defer()) {
        log(`этап отложен (${s.name === 'food' ? 'ночь — охота с рассветом' : 'не сейчас'}); рюкзак: ${bag()}`)
        continue
      }
      log(`итог этапа: ${ok ? 'готов' : off ? 'снят без итога (сдан или нельзя)' : 'НЕ ГОТОВ'}; рюкзак: ${bag()}`)
      if (off) {
        fails.delete(attemptedKey)
        if (ok || progressed) lastProgressAt = gameClock.now()
        if (ok) {
          log(`ВЕХА ${s.name}: готово в ${new Date().toTimeString().slice(0, 8)}, ${Math.round((gameClock.now() - T0) / 60000)} мин от запуска`)
        }
      } else if (progressed) {
        fails.delete(attemptedKey)
        lastProgressAt = gameClock.now()
        log('частичный полезный результат — продолжаю без ожидания и отката')
      } else if (process.env.ND_NE_RECOVER !== '1' && s.name === 'bastion' && barterFlow.enabled() && barterRetryPending) {
        setBarterRetryPending(false)
        fails.delete(attemptedKey)
        log('бартер: золото есть — 15 с в закрытом укрытии и другой поиск, FR-гейт сохраняю')
        await act('ne_burrow', { why: 'бартер: смена торговцев' })
        await sleep(15000)
      } else failStage(s.name, attemptedKey)
      if (died) { log('умер — проверяю, какие ресурсы действительно потеряны'); resetPauses('смерть') }
    }
  } catch (e) {
    log(`прогон упал: ${e.stack || e.message}`)
    process.exitCode = 1
  } finally {
    if (!detached && !manualControl && state.playPolicy?.mode !== 'free') {
      let disconnectTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([call('disconnect', { reason: 'кампания завершена' }),
          new Promise<void>(resolve => { disconnectTimer = gameClock.wall.setTimeout(resolve, 15000) })])
        log('кампания завершена — бот отключён от сервера')
      } catch (e) { log(`disconnect RPC-ОШИБКА ${e.message}`) }
      finally { if (disconnectTimer !== undefined) gameClock.wall.clearTimeout(disconnectTimer) }
    }
    ws.close()
  }
}

export { runCampaign }
