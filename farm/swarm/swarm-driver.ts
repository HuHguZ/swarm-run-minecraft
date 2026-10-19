// Драйвер роя на арене: по своим телам и докладам союзников — доска команды, план (тактики, стройка, лут, передачи), ход
// каждого бота. Части — в swarm-driver/: common (общее), state (состояние драйвера), team, moves, build, loot, climb,
// position, safety, turn-tasks, turn-work, turn, lifecycle; все работают над одним контекстом sw.
import { createDriverState } from './swarm-driver/state'
import { swarmTeam } from './swarm-driver/team'
import { swarmMoves } from './swarm-driver/moves'
import { swarmBuild } from './swarm-driver/build'
import { swarmLoot } from './swarm-driver/loot'
import { swarmClimb } from './swarm-driver/climb'
import { swarmPosition } from './swarm-driver/position'
import { swarmSafety } from './swarm-driver/safety'
import { swarmTurnTasks } from './swarm-driver/turn-tasks'
import { swarmTurnWork } from './swarm-driver/turn-work'
import { swarmTurn } from './swarm-driver/turn'
import { swarmLifecycle } from './swarm-driver/lifecycle'

// This adapter sees own bodies and allied reports; enemy daemon snapshots never enter the board.
// now — часы решений: в ffa это подменённый Date.now (игровое время при ускорении), в лаборатории — свои игровые часы.
export function createSwarmDriver (opts: any) {
  const sw = createDriverState(opts)
  Object.assign(sw, swarmTeam(sw))
  Object.assign(sw, swarmMoves(sw))
  Object.assign(sw, swarmBuild(sw))
  Object.assign(sw, swarmLoot(sw))
  Object.assign(sw, swarmClimb(sw))
  Object.assign(sw, swarmPosition(sw))
  Object.assign(sw, swarmSafety(sw))
  Object.assign(sw, swarmTurnTasks(sw))
  Object.assign(sw, swarmTurnWork(sw))
  Object.assign(sw, swarmTurn(sw))
  Object.assign(sw, swarmLifecycle(sw))
  const { observe, guardedTurn, release, reset, snapshot, panic, canEngage, refill, boardOf } = sw
  return { observe, turn: guardedTurn, release, reset, snapshot, panic, canEngage, refill, enemies: b => boardOf(b).enemies() }
}
