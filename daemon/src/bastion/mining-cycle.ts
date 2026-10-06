interface Point { x: number; y: number; z: number }
export interface MiningProgress {
  goldBlocks: number
  chests: number
  dug: number
  ownCells: number
  gold: number
}

export function miningProgress(before: MiningProgress, after: MiningProgress): boolean {
  return after.goldBlocks > before.goldBlocks || after.chests > before.chests ||
    after.dug > before.dug || after.ownCells > before.ownCells || after.gold > before.gold
}

export function needsKnownGoldApproach(position: Point, target: Point | null, ownTunnel: boolean, nearMemo: boolean): boolean {
  return !ownTunnel && !nearMemo || !!target &&
    (Math.hypot(target.x - position.x, target.z - position.z) > 12 || Math.abs(target.y - position.y) > 8)
}

export function confirmedChestLoot(receipt: unknown, target: Point, aborted: boolean): boolean {
  if (aborted || !receipt || typeof receipt !== 'object') return false
  const result = receipt as Record<string, unknown>
  if (result.stopped || result.error || !/^(chest|trapped_chest|barrel)$/.test(String(result.kind)) ||
    !result.took || typeof result.took !== 'object') return false
  if (result.notTaken && (typeof result.notTaken !== 'object' || Object.keys(result.notTaken).length)) return false
  const at = result.at as Partial<Point> | undefined
  return !!at && at.x === target.x && at.y === target.y && at.z === target.z
}
