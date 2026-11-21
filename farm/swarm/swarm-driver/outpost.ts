import { AIR, DIRECTIONS, masonry, validCell } from '../../../daemon/src/swarm-work'
import { withinArena } from '../../../daemon/src/navigation/parkour/model'
import { cellKey } from './common'
import type { SwarmPosition } from '../../../daemon/src/swarm/types'
import type { WindArena } from '../../../daemon/src/combat/team-wind'

type Block = { name: string; solid: boolean; tread?: boolean }
type Seen = { at: SwarmPosition; existing?: Block }
const air = (block?: Block) => !!block && AIR.test(block.name)
const footing = (block?: Block) => block?.solid || block?.tread

export function outpostSurvey(at: SwarmPosition) {
  const cells: SwarmPosition[] = []
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
    for (let y = -1; y <= 3; y++) cells.push({ x: at.x + x, y: at.y + y, z: at.z + z })
  }
  for (const [dx, dz] of Object.values(DIRECTIONS)) for (let y = -2; y <= 2; y++) {
    cells.push({ x: at.x + 2 * dx, y: at.y + y, z: at.z + 2 * dz })
  }
  return cells
}

export function fitOutpost(at: SwarmPosition, survey: Seen[], arena?: WindArena, direction?: string) {
  const blocks = new Map(survey.map(row => [cellKey(row.at), row.existing]))
  const seen = (x: number, y: number, z: number) => blocks.get(cellKey({ x: at.x + x, y: at.y + y, z: at.z + z }))
  for (const level of [0, 1]) {
    if (!validCell({ x: at.x - 1, y: at.y + level - 1, z: at.z - 1 }) ||
        !validCell({ x: at.x + 1, y: at.y + level + 2, z: at.z + 1 })) continue
    let anchored = false, obstructed = false
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
      const floor = seen(x, level - 1, z)
      if (footing(floor)) anchored = true
      else if (floor && !air(floor)) obstructed = true
    }
    if (obstructed) continue
    if (!anchored && (level === 1 || !Object.values(DIRECTIONS).some(([x, z]) => footing(seen(2 * x, level - 1, 2 * z))))) continue
    for (const [door, [dx, dz]] of Object.entries(DIRECTIONS)) {
      if (direction && door !== direction) continue
      let fits = true
      for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let y = level; y <= level + 2; y++) {
        const block = seen(x, y, z)
        const passage = y < level + 2 && (x === 0 && z === 0 || x === dx && z === dz)
        if (passage) {
          if (!air(block)) fits = false
        } else if (block && !air(block) && (!block.solid || !masonry(block.name))) fits = false
      }
      if (!fits) continue
      const x = 2 * dx, z = 2 * dz
      if (!validCell({ x: at.x + x, y: at.y + level, z: at.z + z })) continue
      if (!withinArena({}, { x: at.x + x + .5, y: at.y + level, z: at.z + z + .5 }, arena)) continue
      const feet = seen(x, level, z), head = seen(x, level + 1, z)
      if (!air(feet) || !air(head)) continue
      const under = seen(x, level - 1, z), lower = seen(x, level - 2, z)
      const canStepDown = !arena || at.y + level - 2 > (arena.killY ?? -64)
      if (footing(under) || canStepDown && air(under) && footing(lower)) return { y: at.y + level, direction: door }
    }
  }
}
