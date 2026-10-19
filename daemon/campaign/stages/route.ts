'use strict'
// Этапы дальнего маршрута: route и routeEnter (оба переносятся в начало STAGES).
import { ROUTE } from '../flags'
import { stage, manualControl, strategyInterrupted, state, sit, died, known, routeStructureSeconds, routeEntered,
  routeFrame, routeDeadline, setRouteDeadline, setRouteEntered, setRouteStepNow, setRouteStructureSeconds } from '../state'
import { telemetry } from '../log'
import { bag, have, dim, foodUnits, fillerCount, todNow } from '../queries'
import { sense, refresh } from '../observe'
import { STAGES, defStage, stageRun } from './table'
import { act } from '../act'
import { awayFrom } from '../travel'
import { quickHunt } from '../food'
import { routeMod, routeAvoid, routeDoneIds, routeFails, routeInfoGet, rlog, routeBlocks, routeFood, routeHunt,
  routeSleep, routeBedLate, routeRecover, routeHealToEnter, routeStep, routeSkills } from '../route-wiring'
import { enterNether } from '../nether-trip'
import * as gameClock from '../../src/game-clock'
let routeDone = false
let routeT0 = 0
defStage('route', () => ROUTE && !routeDone && dim() === 'overworld' && (!known.portal || !routeDoneIds.has('enter')) && !!routeInfoGet(), async () => {
  if (!routeT0) routeT0 = gameClock.now()
  let first = true
  for (let round = 0; round < 24 && !died && dim() === 'overworld'; round++) {
    await refresh()
    await routeSleep('перед шагом')
    await routeBedLate()
    if (died) break
    // Вслепую — план из увиденного (S8c): осмотр построек/лавы перед шагом, info каждый раунд заново.
    await routeSkills.routeSeenRefresh()
    const info = routeInfoGet()
    if (!info) break
    await sense()
    const elapsed = todNow() !== null ? Math.max(0, Math.round((todNow() - 1000) / 20)) : Math.round((gameClock.now() - routeT0) / 1000)
    const p = routeMod.plan(info, { from: state.pos, fromY: state.pos ? state.pos.y : undefined, have: state.inventory || {}, avoid: routeAvoid, done: routeDoneIds, portal: !!known.portal, elapsed, structureSeconds: routeStructureSeconds, frame: known.portal ? null : routeFrame })
    if (first) { rlog(routeMod.describe(p)); first = false }
    const s = p.steps.find(x => !routeDoneIds.has(x.id))
    if (!s) break
    const t0 = gameClock.now()
    let ok: any = false
    const telStepWall = gameClock.wall.now()
    const telStep = telemetry.on() ? telemetry.snapshot(state, sit) : null
    let telErr = null
    // Долгий переход почти без блоков: путь pathfinder'а с мостом/столбом, а ставить нечем — «блок под ноги не ставится» ×6 и
    // минуты в горах (s8b-a1-11: кремень 250 + 264 с, dirt×1). По умолчанию ВЫКЛ. (ND_ROUTE_WALKBLOCKS=1 — вкл.): в s8b-b2 добор
    // стоил 18 с на прогон (15 вызовов по ~19 с) при пользе ~9 с на прогон — дороже, чем помогает.
    if (s.at && state.pos && Math.hypot(s.at.x - state.pos.x, s.at.z - state.pos.z) > 48 && fillerCount() < 6 && have(/_pickaxe$/) && !died && process.env.ND_ROUTE_WALKBLOCKS === '1') {
      try { await routeBlocks(8) } catch (e) { if (e.stopCampaign || manualControl || e.strategyInterrupted) throw e }
    }
    setRouteStepNow(s.id)
    rlog(`шаг ${s.id}: ${s.why || ''} (бюджет ${s.budget} с)`)
    setRouteDeadline(gameClock.now() + (/^(wood|stone)$/.test(s.kind) ?
      (process.env.ND_ROUTE_BOOTSTRAP_LIMIT === '1' && process.env.ND_ROUTE_DEADLINE !== '0' ? Math.min(300, Math.max(150, (s.budget || 60) * 2)) : 600) :
      Math.max(150, (s.budget || 60) * 3)) * 1000)
    const structureStep = /^(ruin|village|treasure|ship)$/.test(s.kind)
    // Остаток бюджета построек — из плана (S8c: без руды по карте он равен цене копки, а не 180 с).
    const structureLeft = Number.isFinite(p.structureBudgetSeconds) ? p.structureBudgetSeconds : routeMod.structureSearchLeft(routeStructureSeconds)
    if (structureStep && Number.isFinite(structureLeft)) {
      setRouteDeadline(Math.min(routeDeadline, gameClock.now() + structureLeft * 1000))
      rlog(`постройки: использовано ${Math.round(routeStructureSeconds)} с, осталось ${Math.floor(structureLeft)} с; затем руда`)
    }
    try { ok = await routeStep(s) } catch (e) {
      setRouteDeadline(0)
      telErr = String(e.message).slice(0, 240)
      // S8d: срыв тактикой бывает и исключением (граф: «навык прерван») — тот же счёт срывов шага (s8d-d-v1-1: «пещера» ×10 за 10 мин,
      // каждый раз заново колодец — счёт ниже по циклу его не видел).
      if (e.strategyInterrupted && !died && !manualControl) {
        const nInt = (routeFails.get(`int:${s.id}`) || 0) + 1
        routeFails.set(`int:${s.id}`, nInt)
        if (routeMod.interruptCap(s.kind, nInt, Number(process.env.ND_ROUTE_INTERRUPT_MAX ?? 3))) {
          rlog(`шаг ${s.id} сорван тактикой ${nInt}-й раз — считаю провалом`)
          routeMod.bookStep(s.id, false, { done: routeDoneIds, fails: routeFails, avoid: routeAvoid })
          routeMod.bookStep(s.id, false, { done: routeDoneIds, fails: routeFails, avoid: routeAvoid })
        }
      }
      if (e.stopCampaign || manualControl || e.strategyInterrupted) throw e
      rlog(`шаг ${s.id} упал: ${e.message}`)
      if (e.routeUnsafe && !died) {
        const n = (routeFails.get('unsafe!') || 0) + 1
        routeFails.set('unsafe!', n)
        if (n <= 4) { await routeRecover(); continue }
      }
      if (/сначала еда/.test(e.message) && !died) {
        try { await stageRun('food')() } catch (e2) { if (e2.stopCampaign || manualControl) throw e2 }
        continue
      }
    } finally {
      if (structureStep) setRouteStructureSeconds(routeStructureSeconds + ((gameClock.now() - t0) / 1000))
      setRouteStepNow(null)
      if (telStep) {
        const after = telemetry.snapshot(state, sit)
        telemetry.record({ level: 'step', stage, step: s.id, kind: s.kind, budget: s.budget ?? null, cost: s.cost ?? null, why: s.why ? String(s.why).slice(0, 200) : null,
          sec: Math.round((gameClock.now() - t0) / 100) / 10, wallSec: (gameClock.wall.now() - telStepWall) / 1000, ok: ok === true, result: typeof ok === 'string' ? ok : (ok ? 'ok' : 'fail'), error: telErr, death: !!died,
          sinceStart: Math.round((gameClock.now() - routeT0) / 1000), before: telStep, after, gained: telemetry.delta(telStep, after) })
      }
    }
    setRouteDeadline(0)
    const sec = Math.round((gameClock.now() - t0) / 1000)
    // Шаг сорвала тактика (враги, рефлекс) — это не провал шага: без счёта в avoid, граф перезапустит маршрут после неё
    // (s8-r2-0: два «wood НЕ ВЫШЕЛ» от прерываний зомби на 1-й мин → дерево в avoid → камень с пустым рюкзаком).
    if (!ok && strategyInterrupted && !died) {
      // S8d: тот же шаг сорван тактикой N раз — угроза у места шага постоянная (s8d-a-v1-5: корабль ×9 по 33 с, 5 мин без железа) —
      // шаг в провал (постройка — в avoid), а не бесконечное «жду конца угрозы». ND_ROUTE_INTERRUPT_MAX=0 — прежнее.
      const maxInt = Number(process.env.ND_ROUTE_INTERRUPT_MAX ?? 3)
      const nInt = (routeFails.get(`int:${s.id}`) || 0) + 1
      routeFails.set(`int:${s.id}`, nInt)
      if (!routeMod.interruptCap(s.kind, nInt, maxInt)) { rlog(`шаг ${s.id} прерван тактикой за ${sec} с — не провал, жду конца угрозы`); return }
      rlog(`шаг ${s.id} сорван тактикой ${nInt}-й раз — считаю провалом`)
    }
    if (ok === 'delegate') { rlog(`шаг ${s.id}: дальше обычные этапы (глубокое литьё) — с начала ${Math.round((gameClock.now() - routeT0) / 1000)} с`); break }
    if (ok === 'water') {
      const n = (routeFails.get('water!') || 0) + 1
      routeFails.set('water!', n)
      rlog(`шаг ${s.id}: воды в ведро не нашлось (${n}-й раз) за ${Math.round((gameClock.now() - t0) / 1000)} с`)
      if (n >= 2) break
      continue
    }
    rlog(`шаг ${s.id} ${ok ? 'ok' : 'НЕ ВЫШЕЛ'} за ${sec} с (бюджет ${s.budget} с), с начала ${Math.round((gameClock.now() - routeT0) / 1000)} с; рюкзак: ${bag()}`)
    if (routeMod.bookStep(s.id, ok, { done: routeDoneIds, fails: routeFails, avoid: routeAvoid }) === 'break') { rlog('плавка не вышла трижды — дальше обычные этапы'); break }
    // Пустое ведро, а вода на виду рядом — набрать сейчас, как раннер по пути (s8-r2-2: вода карты у спавна, лава в 230 м в
    // другую сторону — крюк и смерть от утопленника ночью). Воды не видно — ответ сразу. ND_ROUTE_WATERNEAR=0 — выкл.
    if (ok && !died && have(/^bucket$/) && !have('water_bucket') && !have('lava_bucket') && !known.portal && process.env.ND_ROUTE_WATERNEAR !== '0') {
      try { await act('bucket', { fluid: 'water', radius: 12 }) } catch (e) { if (e.stopCampaign || manualControl || e.strategyInterrupted) throw e }
      if (have('water_bucket')) rlog('вода по пути — ведро полное')
    }
    // Еды почти нет, а зверь рядом — взять по пути (≤ 16 бл., ≤ 20 с): шаг еды часто пуст (зверей в 40 нет), а без еды ночью
    // тело не лечится (s8-f1-2: паук, хп 1 «еды нет» до конца прогона). ND_ROUTE_FOODNEAR=0 — выкл.
    // S8c: смерти ночью — хп ≤ 10 без еды (регенерации нет): брать зверя на виду смелее — до 4 единиц еды и в 24 бл.
    // (ND_ROUTE_FOODNEAR2=0 — прежние 3 и 16).
    const foodNear2 = process.env.ND_ROUTE_FOODNEAR2 !== '0'
    if (ok && !died && foodUnits() < (foodNear2 ? 4 : 3) && !known.portal && process.env.ND_ROUTE_FOODNEAR !== '0') {
      try { await routeHunt(foodNear2 ? 24 : 16, foodNear2 ? 25 : 20) } catch (e) { if (e.stopCampaign || manualControl || e.strategyInterrupted) throw e }
    }
    if (s.kind === 'giveup') break
    if (s.kind === 'enter' && ok) break
    if (died) break
  }
  routeDone = true
  rlog(`маршрут кончился: ${dim() === 'the_nether' ? 'в Аду' : known.portal ? 'портал горит' : 'без портала — дальше обычные этапы'}, ${Math.round((gameClock.now() - routeT0) / 1000)} с`)
  if (!died && dim() === 'overworld' && !known.portal && process.env.ND_ROUTE_LAVAEDGE !== '0') {
    try {
      const ob = await act('observe', { radius: 5 })
      const lv = (Array.isArray(ob.detail && ob.detail.blocks) ? ob.detail.blocks : []).find(b => b && b.name === 'lava')
      if (lv && lv.nearest) { rlog(`лава в ${lv.dist ?? '?'} бл. — отхожу от неё перед обычными этапами`); await awayFrom(lv.nearest, 12) }
    } catch (e) { if (e.stopCampaign || manualControl) throw e }
  }
})
{ const i = STAGES.findIndex(x => x.name === 'route'); if (i > 0) STAGES.unshift(STAGES.splice(i, 1)[0]) }
defStage('routeEnter', () => {
  if (dim() === 'the_nether') setRouteEntered(true)
  return ROUTE && routeDone && !routeEntered && !!known.portal && dim() === 'overworld' && !!routeInfoGet() && process.env.ND_ROUTE_ENTER !== '0'
}, async () => {
  await refresh()
  rlog(`портал горит (${known.portal.x},${known.portal.y},${known.portal.z}) — вход сразу; еды ${foodUnits()}, сытость ${state.food ?? '?'}`)
  await routeSleep('у портала')
  await routeFood({ cookRaw: false })
  if (foodUnits() < 2) await quickHunt()
  if (!(await routeHealToEnter())) return
  await enterNether()
  await refresh()
  if (dim() === 'the_nether') setRouteEntered(true)
  else { routeEnterFails++; if (routeEnterFails >= 3) { setRouteEntered(true); rlog('вход трижды не вышел — дальше обычные этапы') } }
})
let routeEnterFails = 0
{ const i = STAGES.findIndex(x => x.name === 'routeEnter'); if (i > 0) STAGES.unshift(STAGES.splice(i, 1)[0]) }
