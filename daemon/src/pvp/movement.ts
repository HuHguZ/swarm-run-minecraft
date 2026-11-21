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
export function burnStepCost (bot, observed?: { blockAt: (p) => any }) {
  const BURN = /^(lava|fire|soul_fire)$/
  const burns = p => {
    const b = bot.blockAt(p)
    return b && BURN.test(b.name) && (!observed || BURN.test(observed.blockAt(p)?.name))
  }
  return b => {
    const p = b && b.position
    if (!p) return 0
    for (const dy of [0, -1]) if (burns(p.offset(0, dy, 0))) return 100
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const dy of [0, -1]) {
      if ((dx || dz) && burns(p.offset(dx, dy, dz))) return 30
    }
    return 0
  }
}

const burnPriced = new WeakMap<object, { seen?: ReturnType<typeof burnStepCost> }>()
export function priceBurnSteps (bot, movements, observed?: { blockAt: (p) => any }) {
  const seen = observed && burnStepCost(bot, observed)
  const installed = burnPriced.get(movements)
  if (installed) {
    if (!seen) return () => {}
    const previous = installed.seen
    installed.seen = seen
    return () => { if (installed.seen === seen) installed.seen = previous }
  }
  const prices = { seen }
  burnPriced.set(movements, prices)
  const burn = burnStepCost(bot), fb = bot._ndFastBlocks
  const risk = (block: any) => {
    if (prices.seen) return prices.seen(block)
    if (fb?.live && block && block._ndBurnVer === fb.ver) return block._ndBurnV
    const value = burn(block)
    if (fb?.live && block) { block._ndBurnVer = fb.ver; block._ndBurnV = value }
    return value
  }
  let from = 0
  const cost = block => {
    const value = risk(block)
    // Native adds feet/head prices several times and rejects totals above 100; existing heat must not forbid its exit.
    return value >= 100 ? value : Math.max(0, value - from)
  }
  const neighbors = movements.getNeighbors
  const priced = function (node) {
    const previous = from
    from = risk(this.getBlock(node, 0, 0, 0))
    try { return neighbors.call(this, node) } finally { from = previous }
  }
  movements.getNeighbors = priced
  movements.exclusionAreasStep.push(cost)
  return () => {
    const i = movements.exclusionAreasStep.indexOf(cost)
    if (i >= 0) movements.exclusionAreasStep.splice(i, 1)
    if (movements.getNeighbors === priced) movements.getNeighbors = neighbors
    burnPriced.delete(movements)
  }
}

// Acquisition and the duel must use the same route constraints, including intermediate nodes.
export function combatMovement (bot, arena = null, observed?: { blockAt: (p) => any }) {
  const mv = bot.pathfinder?.movements
  const arenaOk = arena && ['x', 'y', 'z', 'r'].every(k => Number.isFinite(arena[k])) && arena.r > 0 ? arena : null
  const onField = p => !!arenaOk && !!p && p.y >= arenaOk.y - 1.5 && Math.abs(p.x - arenaOk.x) <= arenaOk.r + .5 && Math.abs(p.z - arenaOk.z) <= arenaOk.r + .5
  if (!mv) return { arena: arenaOk, onField, restore: () => {} }
  const before = { canDig: mv.canDig, allow1by1towers: mv.allow1by1towers, scafoldingBlocks: mv.scafoldingBlocks,
    allowParkour: mv.allowParkour, maxDropDown: mv.maxDropDown, digCost: mv.digCost, getNeighbors: mv.getNeighbors }
  // Путь в бою — не вплотную к лаве и огню (стенд 15×15 a8 21.10: погоня по краю ямы с лавой, срезанный угол на спринте —
  // 4 смерти «tried to swim in lava» без чужого удара). Клетка у лавы (на уровне ног или пола, вкл. диагональ) — дорого,
  // в обход, если обход есть; сама лава — уже не клетка пути (pathfinder blocksToAvoid).
  const stopBurn = Array.isArray(mv.exclusionAreasStep) ? priceBurnSteps(bot, mv, observed) : null
  mv.allow1by1towers = false; mv.scafoldingBlocks = []; mv.allowParkour = false
  // Pathfinder compares feet Y to the solid support's block Y, one below landing feet.
  mv.maxDropDown = edges.SAFE_FALL + 1
  mv.digCost = tempo.SPRINT_BPT * 20 / 3
  // A hole through a suspended arena's floor is not a route toward an opponent below it.
  const floorGuard = arenaOk && Array.isArray(mv.exclusionAreasBreak) ? b => b?.position?.y <= arenaOk.y - 1 ? 100 : 0 : null
  if (floorGuard) mv.exclusionAreasBreak.push(floorGuard)
  const neighbors = mv.getNeighbors
  if (arenaOk && typeof neighbors === 'function') mv.getNeighbors = function (node) {
    const out = neighbors.call(this, node)
    if (!onField(bot.entity?.position)) return out
    // A fighter already in a shallow crater must be able to walk along its floor to the exit.
    const floor = Math.min(arenaOk.y, Math.floor(bot.entity.position.y))
    return out.filter(m => m.y >= floor && Math.abs(m.x + .5 - arenaOk.x) <= arenaOk.r && Math.abs(m.z + .5 - arenaOk.z) <= arenaOk.r)
  }
  return { arena: arenaOk, onField, restore () {
    stopBurn?.()
    Object.assign(mv, before)
    if (floorGuard) { const i = mv.exclusionAreasBreak.indexOf(floorGuard); if (i >= 0) mv.exclusionAreasBreak.splice(i, 1) }
  } }
}
