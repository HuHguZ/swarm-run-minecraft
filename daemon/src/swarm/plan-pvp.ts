// Рой (swarm.ts): план боя команды — оркестратор. Фазы (plan-*.ts) по порядку читают и дописывают общее состояние
// одного вызова (PvpPlan, plan-frame); порядок фаз — порядок прежнего тела: доска (prune, факты) читается в том же порядке.
import type { SwarmMember, SwarmTask } from './types'
import { type SwarmBoard, liveMembers, pvpState, knownEnemies } from './board'
import { doctrines } from './common'
import { keepDoctrine } from './doctrine'
import { type PvpOptions, type PvpPlan, pvpFrame } from './plan-frame'
import { pvpAssault } from './plan-assault'
import { pvpFlee, pvpRecover } from './plan-flee'
import { pvpTargets, ringShields, pvpBuilders, falseWeakness, falseRetreat, fountain } from './plan-doctrines'
import { pvpSectors, pvpGather, coverHurt, pvpDiggers, pvpLadders, pvpCampers } from './plan-jobs'
import { assignFighters, commitPlan } from './plan-assign'
import { strongFew, ineffectiveDamage } from './race'

export function planPvp(board: SwarmBoard, members: SwarmMember[], options: PvpOptions = {}): Map<string, SwarmTask> {
  board.setMembers(members)
  const team = liveMembers(board, members).sort((a, b) => a.id.localeCompare(b.id))
  const state = pvpState(board)
  const enemies = knownEnemies(board)

  // Натиск — против людей (соло) и против сильного меньшинства (race.ts strongFew): мир решает, как играть.
  ineffectiveDamage(state, team, enemies)
  const strong = strongFew(state, team, enemies, options.foesLeft, options.killsBy)
  const aggressive = !!options.aggressive || strong
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
