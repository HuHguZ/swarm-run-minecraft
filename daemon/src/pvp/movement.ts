import * as edges from '../edges'
import * as tempo from '../tempo'

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

// Цена шага пути у лавы и огня (mineflayer-pathfinder exclusionAreasStep: блок ног узла → прибавка): над лавой или огнём
// (лава вровень с полом — яма Колизея: pathfinder с запасом блоков «мостит» её поставкой, и неудачная поставка — шаг
// в лаву) — 100, нельзя; рядом (3×3, ноги и пол) — 30, в обход, если обход есть. Годится и для goto (session movements).
export function burnStepCost (bot) {
  const BURN = /^(lava|fire|soul_fire)$/
  return b => {
    const p = b && b.position
    if (!p) return 0
    for (const dy of [0, -1]) { const n = bot.blockAt(p.offset(0, dy, 0)); if (n && BURN.test(n.name)) return 100 }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const dy of [0, -1]) {
      const n = bot.blockAt(p.offset(dx, dy, dz))
      if (n && BURN.test(n.name)) return 30
    }
    return 0
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
  // Путь в бою — не вплотную к лаве и огню (стенд 15×15 a8 21.10: погоня по краю ямы с лавой, срезанный угол на спринте —
  // 4 смерти «tried to swim in lava» без чужого удара). Клетка у лавы (на уровне ног или пола, вкл. диагональ) — дорого,
  // в обход, если обход есть; сама лава — уже не клетка пути (pathfinder blocksToAvoid).
  const nearBurn = Array.isArray(mv.exclusionAreasStep) ? burnStepCost(bot) : null
  if (nearBurn) mv.exclusionAreasStep.push(nearBurn)
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
    if (nearBurn) { const i = mv.exclusionAreasStep.indexOf(nearBurn); if (i >= 0) mv.exclusionAreasStep.splice(i, 1) }
    if (floorGuard) { const i = mv.exclusionAreasBreak.indexOf(floorGuard); if (i >= 0) mv.exclusionAreasBreak.splice(i, 1) }
  } }
}
