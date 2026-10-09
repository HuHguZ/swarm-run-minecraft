const edges = require('../edges')
const tempo = require('../tempo')

// A stationary pathfinder can be doing useful work. Only the heuristic route
// timers use this; explicit cancellation and combat safety still stop the dig.
export function createPathMiningProgress (bot, now) {
  let target = null
  let until = 0
  return () => {
    const block = bot.pathfinder?.isMining?.() && bot.targetDigBlock
    if (!block) { target = null; return false }
    if (block !== target) {
      target = block
      let ms = NaN
      try { ms = bot.digTime(block) } catch {}
      // Two packet ticks for the completed dig and its block receipt.
      until = now() + (Number.isFinite(ms) && ms > 0 ? ms + 2 * 50 : 0)
    }
    return now() < until
  }
}

// Acquisition and the duel must use the same route constraints, including intermediate nodes.
export function combatMovement (bot, arena = null) {
  const mv = bot.pathfinder?.movements
  const arenaOk = arena && ['x', 'y', 'z', 'r'].every(k => Number.isFinite(arena[k])) && arena.r > 0 ? arena : null
  const onField = p => !!arenaOk && !!p && p.y >= arenaOk.y - 1.5 && Math.abs(p.x - arenaOk.x) <= arenaOk.r + .5 && Math.abs(p.z - arenaOk.z) <= arenaOk.r + .5
  if (!mv) return { arena: arenaOk, onField, restore: () => {} }
  const before = { canDig: mv.canDig, allow1by1towers: mv.allow1by1towers, scafoldingBlocks: mv.scafoldingBlocks,
    allowParkour: mv.allowParkour, maxDropDown: mv.maxDropDown, digCost: mv.digCost, getNeighbors: mv.getNeighbors }
  mv.allow1by1towers = false; mv.scafoldingBlocks = []; mv.allowParkour = false
  // Pathfinder compares feet Y to the solid support's block Y, one below landing feet.
  mv.maxDropDown = edges.SAFE_FALL + 1
  mv.digCost = tempo.SPRINT_BPT * 20 / 3
  // A hole through a suspended arena's floor is not a route toward an opponent below it.
  const floorGuard = arenaOk && Array.isArray(mv.exclusionAreasBreak) ? b => b?.position?.y <= arenaOk.y - 1 ? 100 : 0 : null
  if (floorGuard) mv.exclusionAreasBreak.push(floorGuard)
  if (arenaOk && typeof before.getNeighbors === 'function') mv.getNeighbors = function (node) {
    const out = before.getNeighbors.call(this, node)
    if (!onField(bot.entity?.position)) return out
    // A fighter already in a shallow crater must be able to walk along its floor to the exit.
    const floor = Math.min(arenaOk.y, Math.floor(bot.entity.position.y))
    return out.filter(m => m.y >= floor && Math.abs(m.x + .5 - arenaOk.x) <= arenaOk.r && Math.abs(m.z + .5 - arenaOk.z) <= arenaOk.r)
  }
  return { arena: arenaOk, onField, restore () {
    Object.assign(mv, before)
    if (floorGuard) { const i = mv.exclusionAreasBreak.indexOf(floorGuard); if (i >= 0) mv.exclusionAreasBreak.splice(i, 1) }
  } }
}
