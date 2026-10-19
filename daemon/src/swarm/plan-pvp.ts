// Рой (swarm.ts): план боя команды — оркестратор. Фазы (plan-*.ts) по порядку читают и дописывают общее состояние
// одного вызова (PvpPlan, plan-frame); порядок фаз — порядок прежнего тела: доска (prune, факты) читается в том же порядке.
import type { SwarmMember, SwarmTask } from './types'
import { type SwarmBoard, liveMembers, pvpState } from './board'
import { copy, doctrines } from './common'
import { keepDoctrine } from './doctrine'
import { type PvpOptions, type PvpPlan, pvpFrame } from './plan-frame'
import { pvpAssault } from './plan-assault'
import { pvpFlee, pvpRecover } from './plan-flee'
import { pvpTargets, ringShields, pvpBuilders, falseWeakness, falseRetreat, fountain } from './plan-doctrines'
import { pvpSectors, pvpGather, coverHurt, pvpDiggers, pvpLadders, pvpCampers } from './plan-jobs'
import { assignFighters, commitPlan } from './plan-assign'

export function planPvp(board: SwarmBoard, members: SwarmMember[], options: PvpOptions = {}): Map<string, SwarmTask> {
  board.setMembers(members)
  const team = liveMembers(board, members).sort((a, b) => a.id.localeCompare(b.id))
  const state = pvpState(board)
  // Пропуск поля не доказывает, что враг снял прежнюю броню или чары (15.10).
  const enemies = board.enemies().map(e => {
    const equipment = { ...state.equipment.get(e.id), ...e.equipment }
    if (e.equipment?.armor && e.equipment.unknownArmorSlots === undefined) delete equipment.unknownArmorSlots
    state.equipment.set(e.id, copy(equipment))
    return { ...e, equipment }
  })

  const aggressive = !!options.aggressive
  const doctrine = options.doctrine ?? keepDoctrine(board, team, aggressive)
  if (!doctrines.includes(doctrine)) throw new Error('Invalid doctrine')
  const plan = new Map<string, SwarmTask>()
  if (!team.length) {
    if (board.assault && state.assault) {
      const a = board.assault, episode = state.assault
      board.assaultEnded = { at: board.now(), why: 'проигрываем', lost: episode.roster.size, target: a.target, seconds: Math.round((board.now() - a.since) / 1000) }
      state.failed.set(a.target, { ...episode.balance, hp: episode.hp, voters: a.voters })
      board.assault = null; delete state.assault
    }
    return plan
  }
  // Строй и группы; штурм; ва-банк и бегство; раненые и лекари.
  const S = pvpFrame({ board, options, team, state, enemies, aggressive, doctrine, plan } as PvpPlan)
  pvpAssault(S)
  pvpFlee(S)
  pvpRecover(S)
  // Цели и приёмы строя.
  pvpTargets(S)
  ringShields(S)
  pvpBuilders(S)
  falseWeakness(S)
  falseRetreat(S)
  fountain(S)
  // Окружение и работа на команду.
  pvpSectors(S)
  pvpGather(S)
  coverHurt(S)
  pvpDiggers(S)
  pvpLadders(S)
  pvpCampers(S)
  // Остальные — бой, резерв, лут или укрытие; план — на доску.
  assignFighters(S)
  return commitPlan(S)
}
