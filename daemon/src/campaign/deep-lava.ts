import { amount, type WorldState } from '../core/world-state'

export const DEEP_LAVA_Y = -54 // FluidStatus(-54).at(y) is lava only for y < -54 (1.21.11).
/** A route ETA, not a guarantee of a cave. Mining times are dry, unenchanted 1.21.11 ticks.
 * shortcut: one 32-block search and the existing 120s cast prior need kit-scene calibration. */
export function deepLavaPrice(s: WorldState) {
  const y = s.position?.y ?? 64, depth = Math.max(0, y - DEEP_LAVA_Y)
  const stone = Math.min(depth, Math.max(0, y)), slate = depth - stone
  // conserveTool uses stone for bulk rock even when an iron pick is also carried.
  const iron = amount(s, 'iron_pick') > 0 && !s.inventory.stone_pickaxe
  // ND_OW_DEEP_SHAFT=1: колодец 1×1 (блок на уровень, шаг вниз — падение), а не лестница (3 блока и шаг по диагонали на уровень).
  const shaft = typeof process !== 'undefined' && process.env.ND_OW_DEEP_SHAFT === '1'
  const dig = (shaft ? 1 : 3) * (stone * (iron ? .4 : .6) + slate * (iron ? .75 : 1.15))
  const walk = shaft ? depth * .25 : depth * Math.SQRT2 / 2.5
  const search = 32 * (2 * (iron ? .75 : 1.15) + 1 / 2.5)
  // Same measured 4.05 swings/level as items.SWINGS_PER_LEVEL; 64 for the search.
  const swings = Math.ceil(depth * (shaft ? 1.35 : 4.05) + 64) // колодец — блок на уровень (4.05 — три блока ступени)
  const left = s.facts.deep_lava_pick_swings
  const available = left?.status === 'known' ? Math.max(0, Number(left.value) || 0) : 0
  const replacements = Math.ceil(Math.max(0, swings - available) / 131)
  const planks = Object.entries(s.inventory).reduce((n, [k, v]) => n + (/_planks$/.test(k) ? v : /_(log|wood|stem|hyphae)$/.test(k) ? 4 * v : 0), 0)
  const needed = 2 * Math.ceil(Math.max(0, 2 * replacements - (s.inventory.stick || 0)) / 4) + (s.inventory.crafting_table ? 0 : 4)
  // Reuse AcquireWood/CraftPortalKit priors for missing supplies; never a material ban.
  const supplies = replacements * 20 + (needed > planks ? 90 : 0)
  const water = amount(s, 'water') > 0 ? 0 : 40 // Existing GetWater prior; local aquifer success is unmeasured.
  return { y: DEEP_LAVA_Y, depth, dig, walk, search, supplies, swings, water, seconds: dig + walk + search + supplies + water + 120 }
}
/** Laplace prior: zero finds in n completed empty searches => p=1/(n+2).
 * Only local receipts count; elapsed time, seed and hidden terrain do not. */
export function lavaSearchSeconds(s: WorldState): number {
  const f = s.facts.lava_empty_searches
  const empty = f?.status === 'known' ? Math.max(0, Number(f.value) || 0) : 0
  return 60 * (empty + 2)
}

type Point = { x: number; y: number; z: number }
interface Reply { status?: string; error?: string; detail?: any }
export interface DeepLavaPort {
  now(): number
  stopped(): boolean
  position(): Point | null
  portal(): boolean
  water(): boolean
  prepare(swings: number): Promise<void>
  act(method: string, params: Record<string, unknown>): Promise<Reply>
  cast(params: Record<string, unknown>): Promise<Reply>
  hear: boolean
}
/** Bounded staircase from the kit site. Lava must be seen again before casting.
 * Sound selects a direction only; no hidden coordinates or fluid-hazard target. */
export async function runDeepLava(p: DeepLavaPort, budgetSeconds: number): Promise<string> {
  const deadline = p.now() + Math.max(1, budgetSeconds) * 1000
  const dirs = ['north', 'east', 'south', 'west']
  let turn = 0, blocked = 0, shaftStuck = false
  const shaftOn = typeof process !== 'undefined' && process.env.ND_OW_DEEP_SHAFT === '1'
  const tried = new Set<string>()
  const active = () => !p.stopped() && !p.portal() && p.now() < deadline
  const step = async (method: string, params: Record<string, unknown> = {}) => {
    if (!active()) return null
    const left = Math.floor((deadline - p.now()) / 1000)
    if (left < 1) return null
    const args = { ...params, timeoutSeconds: Math.min(Number(params.timeoutSeconds) || 60, left) }
    const r = method === 'cast' ? await p.cast(args) : await p.act(method, args)
    if (r?.status === 'interrupted') return null
    return r
  }
  // The bound also protects tests/invalid clocks; each genuine route leg pays game time.
  for (let leg = 0; leg < 64 && active(); leg++) {
    const o = await step('observe', { radius: 32 })
    if (!o || !active()) break
    if (!p.water()) {
      const at = p.position()
      const water = (Array.isArray(o.detail?.blocks) ? o.detail.blocks : []).some((b: any) => b?.name === 'water' && !b.remembered && at && b.nearest &&
        Math.hypot(b.nearest.x - at.x, b.nearest.y - at.y - 1.62, b.nearest.z - at.z) <= 4)
      if (water && !await step('bucket', { fluid: 'water', radius: 4, walk: false, timeoutSeconds: 20 })) break
    }
    const lava = (Array.isArray(o.detail?.blocks) ? o.detail.blocks : []).find((b: any) => b?.name === 'lava' && !b.remembered && b.nearest &&
      ['x', 'y', 'z'].every(k => Number.isFinite(b.nearest[k])) && !tried.has(JSON.stringify(b.nearest)))?.nearest as Point | undefined
    if (lava && p.water()) {
      const key = JSON.stringify(lava), at = p.position()
      if (!at) return 'нет положения'
      if (Math.hypot(lava.x - at.x, lava.y - at.y, lava.z - at.z) > 8) {
        if (!await step('goto', { ...lava, y: lava.y + 1, range: 4, maxFallHp: 0, timeoutSeconds: 30 })) break
        const after = p.position()
        if (!after || Math.hypot(after.x - at.x, after.y - at.y, after.z - at.z) < 1) tried.add(key)
        continue // Reobserve LOS after approach, never cast from stale sight.
      }
      const r = await step('cast', { mode: 'cast', windows: true, maxDig: 80, radius: 12, timeoutSeconds: 240 })
      if (!r || !active()) break
      if (r.detail?.need) return `литью нужно ${JSON.stringify(r.detail.need)}`
      tried.add(key) // A failed site needs new lava, not the same immediate cast again.
      turn++
    }
    let heard: any = null
    if (p.hear) {
      const h = await step('portal', { mode: 'cast', listen: 16, ...(!p.water() ? { fluid: 'water' } : {}), timeoutSeconds: 20 })
      if (!h || !active()) break
      heard = h.detail?.heard?.[0]
    }
    const before = p.position()
    if (!before || !active()) break
    const direction = dirs.includes(heard?.dir) ? heard.dir : dirs[turn % 4]
    const down = before.y > DEEP_LAVA_Y + .5 && !heard?.above
    await p.prepare(Math.ceil(Math.max(0, before.y - DEEP_LAVA_Y) * 4.05 + 64))
    if (!active()) break
    // ND_OW_DEEP_SHAFT=1: вниз колодцем (чутьё лавы и воды под ногами и сбоку — стоп и место названо), колодец встал на месте —
    // одно колено лестницы вбок, затем снова колодец. Лестница — 3.25 с на уровень, к −54 с y 63 это 6 мин.
    const shaftLeg = shaftOn && down && !shaftStuck
    const r = shaftLeg ? await step('tunnel', { direction: 'down', length: Math.min(64, Math.ceil(before.y - DEEP_LAVA_Y)), nightWork: true, timeoutSeconds: 240 })
      : await step(down ? 'dig_down' : 'tunnel', down
      ? { mode: 'stairs', depth: Math.min(8, Math.ceil(before.y - DEEP_LAVA_Y)), direction, maxFallHp: 0, nightWork: true, torchEvery: 8, timeoutSeconds: 90 }
      : { direction, length: heard ? 4 : shaftOn ? 16 : 8, nightWork: true, torchEvery: 8, timeoutSeconds: 90 })
    if (!r || !active()) break
    const after = p.position()
    const moved = after && Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) >= 1
    if (shaftLeg) { shaftStuck = !moved || after.y > before.y - 2; if (moved) { blocked = 0; continue } }
    else shaftStuck = false
    const why = String(r.detail?.stopped || r.error || '')
    // Gold/redstone on a stair is a route obstruction, not a reason to require an iron pick for lava.
    const oreTool = /_ore/.test(why) && /кирк|инструмент/.test(why)
    if (/NIGHT_RISK|MOB_|NO_FOOD/.test(why) || !oreTool && /кирк|инструмент/.test(why)) return why
    blocked = moved ? 0 : blocked + 1
    if (blocked >= 2) return `две проходки без продвижения: ${why}`
    // ND_OW_DEEP_SHAFT: у дна штрек идёт прямо, пока идётся (поворот на каждом колене водил квадратом 8×8 вокруг колодца:
    // owN3-owE1-06 — 4 мин у −54 без лавы, ближайшая в 51 бл.); поворот — только когда встал.
    if (!moved || r.detail?.stopped || (!down && !shaftOn)) turn++
  }
  return p.portal() ? 'портал подтверждён' : p.stopped() ? 'прервано' : 'бюджет глубокого пути исчерпан'
}
