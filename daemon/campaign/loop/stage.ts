'use strict'
// Ход этапа: запуск, итог (готов / снят / частичный / пустой заход), пауза пустых заходов, телеметрия этапа.
import { only } from '../flags'
import { sleep } from '../rpc'
import { T0, manualControl, strategyExecuting, strategyTail, state, sit, died, barterRetryPending, setBarterRetryPending,
  setStage } from '../state'
import { telemetry, log } from '../log'
import { bag, dim } from '../queries'
import { sense, refresh, readMemory } from '../observe'
import { stageProgress } from '../stages/table'
import { barterFlow } from '../nether-plan'
import { act } from '../act'
import { recoverGuard } from '../guards'
import type { CampaignTurn, TurnFlow } from './turn'
import * as gameClock from '../../src/game-clock'

async function loopStage (loop: CampaignTurn, s: any, turn: number): Promise<TurnFlow> {
  const { fails, failureKey, failStage, resetPauses } = loop
  setStage(s.name)
  loop.lastStage = s.name
  log(`ход ${turn}: начинаю; рюкзак: ${bag()}`)
  const pauseName = process.env.ND_OW_PAUSE_CAUSE === '1' && dim() === 'overworld' ? s.pauseKey || s.name : s.name
  const attemptedKey = failureKey(pauseName)
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
  if (manualControl) return 'break'
  await refresh()
  await sense()
  await readMemory()
  const off = !s.needed()
  const ok = off && s.done()
  const after = stageProgress(s.name)
  const progressed = s.progressed ? s.progressed() : Object.entries(after).some(([key, value]) => value > (before[key] || 0))
  if (attemptInterrupted || s.interrupted?.()) {
    log('навык прерван — новое наблюдение и план')
    if (process.env.ND_OW_PAUSE_CAUSE === '1' && dim() === 'overworld' && !off && !progressed && !died) failStage(pauseName, attemptedKey)
    return 'continue'
  }
  if (telStage) {
    const snap = telemetry.snapshot(state, sit)
    telemetry.record({ level: 'stage', stage: s.name, turn, sec: Math.round((gameClock.now() - telStage.t0) / 100) / 10, wallSec: (gameClock.wall.now() - telStage.wallT0) / 1000, ok, off, progressed,
      error: telStageErr, death: died && !telStage.dead, sinceStart: Math.round((gameClock.now() - T0) / 1000), before: telStage.before, after: snap,
      gained: telemetry.delta(telStage.before, snap) })
  }
  if (!off && s.defer()) {
    log(`этап отложен (${s.name === 'food' ? 'ночь — охота с рассветом' : 'не сейчас'}); рюкзак: ${bag()}`)
    return 'continue'
  }
  log(`итог этапа: ${ok ? 'готов' : off ? 'снят без итога (сдан или нельзя)' : 'НЕ ГОТОВ'}; рюкзак: ${bag()}`)
  if (off) {
    fails.delete(attemptedKey)
    if (ok || progressed) loop.lastProgressAt = gameClock.now()
    if (ok) {
      log(`ВЕХА ${s.name}: готово в ${new Date().toTimeString().slice(0, 8)}, ${Math.round((gameClock.now() - T0) / 60000)} мин от запуска`)
    }
  } else if (progressed) {
    fails.delete(attemptedKey)
    loop.lastProgressAt = gameClock.now()
    log('частичный полезный результат — продолжаю без ожидания и отката')
  } else if (process.env.ND_NE_RECOVER !== '1' && s.name === 'bastion' && barterFlow.enabled() && barterRetryPending) {
    setBarterRetryPending(false)
    fails.delete(attemptedKey)
    log('бартер: золото есть — 15 с в закрытом укрытии и другой поиск, FR-гейт сохраняю')
    await act('ne_burrow', { why: 'бартер: смена торговцев' })
    await sleep(15000)
  } else failStage(pauseName, attemptedKey)
  if (died) { log('умер — проверяю, какие ресурсы действительно потеряны'); resetPauses('смерть') }
}

export { loopStage }
