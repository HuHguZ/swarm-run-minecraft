'use strict'
// Главный цикл кампании: ход за ходом — наблюдение, связь, смена мира, смерть, сторож; дальше части хода из loop/:
// chores (дела между этапами), night (ночь до портала), select (выбор шага и угроза в Аду), idle (шага нет), stage (ход
// этапа). Общее состояние хода — объект CampaignTurn (loop/turn.ts).
import { WATCHDOG_MIN, PAUSE_MIN } from './flags'
import { ws, call } from './rpc'
import { manualControl, state, sit, died, detached, known, bastionPausedUntil, setBastionPausedUntil, setHeading,
  setStage } from './state'
import { seamSnapshot, log } from './log'
import { bag, have, dim } from './queries'
import { sense, refresh, readMemory, bState } from './observe'
import { FOOD_STOCK } from './stages/table'
import { barterFlow, deferBastionMining, bastionBlocked, nextBastion, netherRetryState, netherFailureName, netherFailureState,
  overworldFailureState } from './nether-plan'
import { act } from './act'
import { recoverGuard } from './guards'
import { netherArrival } from './nether-trip'
import { loopChores } from './loop/chores'
import { loopNight } from './loop/night'
import { loopSelect } from './loop/select'
import { loopIdle } from './loop/idle'
import { loopStage } from './loop/stage'
import type { CampaignTurn } from './loop/turn'
import * as gameClock from '../src/game-clock'

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
    const loop: CampaignTurn = { fails, failureKey, cooling, failStage, resetPauses, lastProgressAt: gameClock.now(), lastStage: '-',
      netherThreatWaits: 0, threatHp0: 20, threatBurrowAt: -Infinity }
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
      if (gameClock.now() - loop.lastProgressAt >= WATCHDOG_MIN * 60000) {
        setStage('-')
        log(`БЛОКЕР: сторож — ${Math.round((gameClock.now() - loop.lastProgressAt) / 60000)} мин без прогресса ни в одном этапе (последний этап ${loop.lastStage}); останавливаю кампанию`)
        await act('stop')
        process.exitCode = 2
        break
      }
      const turnStart = gameClock.now()
      await loopChores(loop)
      if (await loopNight(loop) === 'continue') continue
      const pick = await loopSelect(loop)
      if (pick === 'break') break
      if (pick === 'continue' || pick === undefined) continue
      const { need, s } = pick
      if (!s) {
        if (await loopIdle(loop, need, turnStart) === 'break') break
        continue
      }
      if (await loopStage(loop, s, turn) === 'break') break
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
