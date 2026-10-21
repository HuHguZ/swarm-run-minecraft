'use strict'
// Шага нет: крепость новым обзором, смена причины, ожидание в толще, домой из Ада, ночь поверху, смена места, ожидание.
import { only, NIGHT_DOWN2 } from '../flags'
import { state, sit, died, known, setStage } from '../state'
import { log } from '../log'
import { dim } from '../queries'
import { refresh, sense, readMemory } from '../observe'
import { STAGES, OTHER_WORLD } from '../stages/table'
import { rodsWanted, netherRetryState } from '../nether-plan'
import { act } from '../act'
import { leaveWater, answerThreat } from '../danger'
import { nightGuard } from '../guards'
import { walkAway, returnFromNether } from '../travel'
import { toSurface } from '../underground'
import { continueFortressChoice, changeNetherCause } from '../nether-trip'
import type { CampaignTurn, TurnFlow } from './turn'
import * as gameClock from '../../src/game-clock'
import { have } from '../queries'

// ND_BLZ_CONT_CAUSE=1: обзор «advance», вернувший «точки исчерпаны» без попытки, не повторяется с того же места при том же запасе:
// причина повтора netherRetryState меняется от действия тактики и состава мобов вокруг, и проба шла тысячами вызовов по 0 с
// (bz06-s18-2 21.10: 2194 advance с одной клетки, bz06-s19-2 — 4993, bz07-s17-3 — 3550). Новое место (≥ 4 бл.) или запас — снова.
let emptyProbe: { x: number; y: number; z: number; supply: string } | null = null
const supplyKey = () => JSON.stringify([have(/^(stone|iron|diamond|netherite)_pickaxe$/), have(/^(cobblestone|blackstone|netherrack|nether_bricks)$/) >= 16])
const sameEmptyProbe = () => process.env.ND_BLZ_CONT_CAUSE !== '0' && !!emptyProbe && !!state.pos &&
  Math.hypot(state.pos.x - emptyProbe.x, state.pos.y - emptyProbe.y, state.pos.z - emptyProbe.z) < 4 && supplyKey() === emptyProbe.supply

async function loopIdle (loop: CampaignTurn, need: any[], turnStart: number): Promise<TurnFlow> {
  const { fails, failureKey, cooling, resetPauses } = loop
  setStage('-')
  const upNeed = dim() === 'the_nether' ? STAGES.filter(x => !(only && !only.includes(x.name)) && !OTHER_WORLD.has(x.name) && x.needed()) : []
  const blockedSearch = fails.get(failureKey('nether'))
  // Закрытый повтор поиска нуждается в собственном ходе к следующему наблюдаемому месту.
  if (dim() === 'the_nether' && known.fortress && rodsWanted() && blockedSearch?.observed !== undefined && process.env.ND_FORTRESS_FRONTIER !== '0') {
    const cause = netherRetryState(blockedSearch.origin)
    if (blockedSearch.frontier !== cause && !sameEmptyProbe()) {
      const probe = await act('fortress', { mode: 'advance', timeoutSeconds: 90 })
      const stoppedCause = netherRetryState(blockedSearch.origin)
      await refresh()
      await readMemory()
      emptyProbe = probe.status === 'done' && probe.detail?.frontierExhausted && !(probe.detail?.frontierTried > 0) && state.pos
        ? { x: state.pos.x, y: state.pos.y, z: state.pos.z, supply: supplyKey() } : null
      if (!cooling({ name: 'nether' }) || (probe.status === 'done' && probe.detail?.frontierTried > 0)) return 'continue'
      blockedSearch.frontier = stoppedCause
      log(probe.detail?.frontierExhausted ? 'крепость: доступные видимые точки обзора исчерпаны; та же недоступная цель не повторяется'
        : `крепость: новый обзор не выполнен (${probe.code || probe.status}); повтор после смены причины`)
    }
  }
  if (await continueFortressChoice(null, blockedSearch)) return 'continue'
  if ((process.env.ND_NE_RECOVER === '1' || process.env.ND_NE_NO_GIVEUP === '1') && dim() === 'the_nether') {
    if (await changeNetherCause(resetPauses)) return 'continue'
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
  const causePaused = process.env.ND_OW_PAUSE_CAUSE === '1' && dim() === 'overworld'
    ? [...fails.entries()].filter(([name, f]) => f.owPause && cooling({ name })) : []
  if (causePaused.length && !died && !sit.night && !sit.dusk && (state.tactics?.threatLevel ?? 0) < 1) {
    // select already offered useful graph alternatives. Deferred food must not suppress this view change.
    const probe = causePaused[0][1]
    if ((probe.views || 0) >= 6) {
      // Спидран не сдаётся (owC2-06, owC1-13: БЛОКЕР и выход кампании на 9-й и 22-й мин): полный круг обзоров без смены причины —
      // паузы сняты, этапы снова по цене графа; новый круг обзоров — после следующих пустых заходов.
      resetPauses('полный круг обзоров без смены причины — пробую этапы снова')
      return 'continue'
    }
    probe.views = (probe.views || 0) + 1
    log('этапы закрыты прежней причиной — иду к новому обзору, затем пересчитываю граф')
    if (!sit.surface) await toSurface()
    else await walkAway(64, Math.PI / 3)
    await refresh()
    await sense()
    await readMemory()
    // No blanket reset: only an actually changed cause can reopen its stage.
    return 'continue'
  }
  const paused = need.filter(x => cooling(x) && !fails.get(failureKey(x.name))?.owPause).map(x => Math.ceil((fails.get(failureKey(x.name)).until - gameClock.now()) / 60000))
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
  if (!causePaused.length && dim() === 'overworld' && blocked && !threatWait && !died && ((state.health ?? 20) >= 14 || !sit.night) && process.env.ND_IDLE_RELOCATE !== '0') {
    const from = state.pos && { ...state.pos }
    log('все нужные этапы на паузе — не стою: меняю место для нового обзора')
    if (!sit.surface) await toSurface()
    else await walkAway(64, Math.PI / 3)
    await refresh()
    const moved = from && state.pos ? Math.hypot(state.pos.x - from.x, state.pos.y - from.y, state.pos.z - from.z) : 0
    if (moved >= 32) resetPauses('новое место')
    if (moved >= 8 || died) return 'continue'
  }
  // ND_OW_IDLE_ANSWER=1: этапы на паузе, а враг рядом — ответить (бой по цене, отход, коробка), а не стоять «wait 3»: owF1-02 21.10 —
  // зомби бил по 3 каждую секунду, пять «жду изменения обстановки» подряд, хп 16 → 0.
  if (process.env.ND_OW_IDLE_ANSWER === '1' && threatWait && (sit.foes ?? 0) > 0 && !died) { await answerThreat('mob_attack'); return 'continue' }
  if (gameClock.now() - turnStart < 20000) { if (dim() === 'overworld') await leaveWater(); await act('wait', { seconds: threatWait ? 3 : 60 }) }
  return 'continue'
}

export { loopIdle }
