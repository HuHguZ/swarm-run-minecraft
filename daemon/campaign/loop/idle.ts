'use strict'
// Шага нет: крепость новым обзором, смена причины, ожидание в толще, домой из Ада, ночь поверху, смена места, ожидание.
import { only, NIGHT_DOWN2 } from '../flags'
import { state, sit, died, known, setStage } from '../state'
import { log } from '../log'
import { dim } from '../queries'
import { refresh, readMemory } from '../observe'
import { STAGES, OTHER_WORLD } from '../stages/table'
import { rodsWanted, netherRetryState } from '../nether-plan'
import { act } from '../act'
import { leaveWater } from '../danger'
import { nightGuard } from '../guards'
import { walkAway, returnFromNether } from '../travel'
import { toSurface } from '../underground'
import { continueFortressChoice, changeNetherCause } from '../nether-trip'
import type { CampaignTurn, TurnFlow } from './turn'
import * as gameClock from '../../src/game-clock'

async function loopIdle (loop: CampaignTurn, need: any[], turnStart: number): Promise<TurnFlow> {
  const { fails, failureKey, cooling, resetPauses } = loop
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
      if (!cooling({ name: 'nether' }) || (probe.status === 'done' && probe.detail?.frontierTried > 0)) return 'continue'
      blockedSearch.frontier = stoppedCause
      log(probe.detail?.frontierExhausted ? 'крепость: доступные видимые точки обзора исчерпаны; та же недоступная цель не повторяется'
        : `крепость: новый обзор не выполнен (${probe.code || probe.status}); повтор после смены причины`)
    }
  }
  if (await continueFortressChoice(null, blockedSearch)) return 'continue'
  if (process.env.ND_NE_RECOVER === '1' && dim() === 'the_nether') {
    if (await changeNetherCause()) return 'continue'
    return 'break'
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
      return 'continue'
    }
    log(`в Аду этапы на паузе (${need.map(x => x.name).join(', ')}) — жду в толще (ND_NE_STAY)`)
    await act('ne_burrow', { why: 'жду конца паузы' })
    await refresh()
    await act('wait', { seconds: 45 })
    return 'continue'
  }
  if (upNeed.length && need.every(x => !x.defer() && (cooling(x) || !x.ready()))) {
    log(`в Аду нечем (${need.map(x => x.name).join(', ')}) — домой за: ${upNeed.map(x => x.name).join(', ')}`)
    await returnFromNether()
    return 'continue'
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
    if (moved >= 8 || died) return 'continue'
  }
  if (gameClock.now() - turnStart < 20000) { if (dim() === 'overworld') await leaveWater(); await act('wait', { seconds: threatWait ? 3 : 60 }) }
  return 'continue'
}

export { loopIdle }
