// Общая доска команды: факты из союзного зрения, задачи и аренда исполнения существующими RPC.
// Тело модуля — src/swarm/: types, common, board (доска и память плана боя), fight (счёт боя, приговор групп, бегство),
// doctrine (приёмы и строй), plan-pvp (план боя: фазы plan-frame, plan-assault, plan-flee, plan-doctrines, plan-jobs,
// plan-assign; оценки plan-judges), logistics (передачи, чертежи).
export type { SwarmPosition, SwarmRole, SwarmKind, Doctrine, ThreatKind, SwarmMember, EnemyObservation, SharedEnemy, SwarmFact,
  SwarmTask, ClaimedTask, SwarmReceipt, BlueprintCell, Blueprint } from './swarm/types'
export { ownedCount } from './swarm/common'
export { SwarmBoard } from './swarm/board'
export { type SwarmFightRisk, type SwarmTeamFight, assessSwarmFight, assessTeamFight, groupOf, groupVerdict, mustFlee } from './swarm/fight'
export { doctrineScores, selectDoctrine } from './swarm/doctrine'
export { canDigTrap } from './swarm/plan-jobs'
export { planPvp } from './swarm/plan-pvp'
export { planTransfers, addBlueprint, nextBuild } from './swarm/logistics'
