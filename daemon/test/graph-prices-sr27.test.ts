// Поток graph (sr27): жёсткие ворота графа → цены (правило пользователя 06.10). Состояния — как их отдаёт мост кампании.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fact, type FactValue, type WorldState } from '../src/core/world-state'
import { speedrunRegistry, dragonGoal } from '../src/core/speedrun'
import { plan } from '../src/core/strategy'
import { applyCosts } from '../src/core/cost-model'
import { createCampaignIntelligence } from '../src/campaign/intelligence'
import { worldFromObservation } from '../src/environments/mineflayer'
import { replenishNetherTools } from '../src/campaign/nether-supply'
import { tacticalDeaths } from '../../farm/analysis/strategy-costs'

const KIT = { iron_pickaxe: 1, stone_pickaxe: 1, stone_sword: 1, bucket: 1, flint_and_steel: 1, cobblestone: 48, stick: 4,
  oak_planks: 3, crafting_table: 1, cooked_porkchop: 4 }
function nether(opts: { inventory?: Record<string, number>; health?: number; food?: number; known?: Record<string, unknown>; facts?: Record<string, FactValue> } = {}): WorldState {
  const facts: Record<string, FactValue> = { nether_ready: true, nether_tools_ready: true, nether_pick_swings: 381, fire_resistance_count: 0,
    fire_resistance_active: false, blaze_allowed: true, end_ready: false, endermen_seconds_per_pearl: 900, bastions_exhausted: false,
    ...(opts.known?.bastion ? { bastion: true, bastion_position: opts.known.bastion as FactValue } : {}), ...opts.facts }
  return worldFromObservation({ state: { dimension: 'the_nether', health: opts.health ?? 20, food: opts.food ?? 20, inventory: opts.inventory ?? KIT, pos: { x: 0, y: 70, z: 0 } },
    known: { portal: { x: 0, y: 70, z: 0 }, ...opts.known }, facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, fact(v, 'observed', 0)])) }, 0)
}
const FORTRESS = { x: 80, y: 70, z: 40 }, BASTION = { x: 60, y: 70, z: 0 }
const worn = { nether_pick_swings: 120, nether_tools_ready: false }
function withEnv<T>(env: Record<string, string>, body: () => T): T {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  try { return body() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}
const first = (state: WorldState, excluded: string[] = []) => plan(speedrunRegistry({ eyes: 12 }), state, dragonGoal, { excluded: new Set(excluded) }).steps[0]?.id ?? null

test('ND_GRAPH_TOOLS_PRICE: worn picks after a failed resupply still fight blazes with the sword', () => {
  const state = nether({ inventory: { ...KIT, iron_pickaxe: 0, ender_pearl: 12 }, known: { fortress: FORTRESS }, facts: worn })
  assert.equal(withEnv({ ND_GRAPH_TOOLS_PRICE: '0' }, () => first(state, ['AcquireNetherTools'])), null, 'old gate: no plan → campaign goes home')
  assert.equal(withEnv({ ND_GRAPH_TOOLS_PRICE: '1' }, () => first(state, ['AcquireNetherTools'])), 'GetBlazeRods')
  // Almost no swings left: a possible resupply stays first — the price keeps it ahead, not a gate.
  const bare = nether({ inventory: { ...KIT, iron_pickaxe: 0, ender_pearl: 12 }, known: { fortress: FORTRESS }, facts: { nether_pick_swings: 10, nether_tools_ready: false } })
  assert.equal(withEnv({ ND_GRAPH_TOOLS_PRICE: '1' }, () => first(bare)), 'AcquireNetherTools')
})

test('ND_GRAPH_TOOLS_PRICE: an iron pick with swings for the first batch opens the bastion (as the stage does)', () => {
  const state = nether({ inventory: { ...KIT, stone_pickaxe: 0 }, known: { bastion: BASTION }, facts: worn })
  const registry = () => speedrunRegistry({ eyes: 12 })
  assert.equal(withEnv({ ND_GRAPH_TOOLS_PRICE: '0' }, () => registry().get('BastionBarter')!.preconditions(state)), false)
  assert.equal(withEnv({ ND_GRAPH_TOOLS_PRICE: '1' }, () => registry().get('BastionBarter')!.preconditions(state)), true)
  // Gold blocks need an iron pick: that is physics and stays.
  const stoneOnly = nether({ inventory: { ...KIT, iron_pickaxe: 0 }, known: { bastion: BASTION }, facts: worn })
  assert.equal(withEnv({ ND_GRAPH_TOOLS_PRICE: '1' }, () => registry().get('BastionBarter')!.preconditions(stoneOnly)), false)
})

test('ND_GRAPH_HP_PRICE: a pick is crafted at any health; low health raises the price, not a gate', () => {
  const state = nether({ health: 9, food: 14, inventory: { ...KIT, iron_pickaxe: 0, cooked_porkchop: 0 }, facts: { nether_pick_swings: 100, nether_tools_ready: false } })
  assert.equal(withEnv({ ND_GRAPH_HP_PRICE: '0' }, () => speedrunRegistry({ eyes: 12 }).get('AcquireNetherTools')!.preconditions(state)), false)
  withEnv({ ND_GRAPH_HP_PRICE: '1' }, () => {
    const tools = speedrunRegistry({ eyes: 12 }).get('AcquireNetherTools')!
    assert.equal(tools.preconditions(state), true)
    assert.ok(tools.estimateRisk(state) > tools.estimateRisk(nether({ facts: { nether_pick_swings: 100, nether_tools_ready: false } })))
  })
})

test('ND_GRAPH_BARTER_FR: a full pearl barter brings fire resistance, so the bastion goes before the blazes', () => {
  const state = nether({ known: { bastion: BASTION, fortress: FORTRESS } })
  withEnv({ ND_GRAPH_BARTER_FR: '1' }, () => {
    const registry = speedrunRegistry({ eyes: 12 })
    const effect = registry.get('BastionBarter')!.expectedEffects
    const after = typeof effect === 'function' ? effect(state) : effect
    assert.ok(Number(after.facts?.fire_resistance_count) >= 1, 'twelve pearls take ~200 ingots: P(FR) ≈ 1')
    assert.equal(first(state), 'BastionBarter')
  })
  // Two pearls short: ~35 ingots, P(FR) ≈ 0.7 — still a potion; one pearl (~18 ingots, P ≈ 0.46) — not counted.
  withEnv({ ND_GRAPH_BARTER_FR: '1' }, () => {
    const registry = speedrunRegistry({ eyes: 12 })
    const effectOf = (pearls: number) => { const s = nether({ inventory: { ...KIT, ender_pearl: pearls }, known: { bastion: BASTION } }); const e = registry.get('BastionBarter')!.expectedEffects; return typeof e === 'function' ? e(s) : e }
    assert.ok(Number(effectOf(10).facts?.fire_resistance_count) >= 1)
    assert.equal(effectOf(11).facts?.fire_resistance_count, undefined)
  })
})

test('ND_GRAPH_SEARCH_RETURN: a visible bastion is worked before searching the fortress away from it', () => {
  const state = nether({ known: { bastion: BASTION } })
  assert.equal(withEnv({ ND_GRAPH_SEARCH_RETURN: '1', ND_GRAPH_BARTER_FR: '1' }, () => first(state)), 'BastionBarter')
  // Nothing known: searching stays the first step.
  assert.ok(['FindBastions', 'FindFortress'].includes(withEnv({ ND_GRAPH_SEARCH_RETURN: '1', ND_GRAPH_BARTER_FR: '1' }, () => first(nether()))!))
})

test('ND_GRAPH_HP_PRICE: the Nether resupply crafts from carried materials below 12 hp but does not walk for stems', async () => {
  const run = async (inventory: Record<string, number>) => {
    const state = { dimension: 'the_nether', health: 9, pickSwings: 100, inventory: { ...inventory } }
    const acts: string[] = [], crafts: string[] = []
    const result = await replenishNetherTools({ observe: async () => state, now: () => 0, interrupted: () => false, log () {},
      async act (method) { acts.push(method) },
      async craft (item) {
        crafts.push(item)
        if (item === 'stone_pickaxe') { state.inventory.stick -= 2; state.inventory.cobblestone -= 3; state.inventory.stone_pickaxe = (state.inventory.stone_pickaxe ?? 0) + 1; state.pickSwings += 131 }
        if (item === 'stick') { state.inventory.oak_planks -= 2; state.inventory.stick = (state.inventory.stick ?? 0) + 4 }
        return true
      } })
    return { result, acts, crafts }
  }
  const carried = { stick: 4, cobblestone: 20, crafting_table: 1, oak_planks: 6, stone_pickaxe: 1 }
  assert.equal((await withEnvAsync({ ND_GRAPH_HP_PRICE: '0' }, () => run(carried))).crafts.length, 0, 'old gate: nothing below 12 hp')
  const priced = await withEnvAsync({ ND_GRAPH_HP_PRICE: '1' }, () => run(carried))
  assert.ok(priced.crafts.includes('stone_pickaxe'))
  assert.equal(priced.result.ready, true)
  const noWood = await withEnvAsync({ ND_GRAPH_HP_PRICE: '1' }, () => run({ cobblestone: 20, stone_pickaxe: 1 }))
  assert.deepEqual(noWood.acts, [], 'walking for stems still needs 12 hp')
  assert.equal(noWood.result.ready, false)
})
async function withEnvAsync<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  try { return await body() } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

test('the overworld hunt is not offered in the Nether (its skill climbs to the surface)', () => {
  const state = nether({ health: 9, food: 14, inventory: { ...KIT, cooked_porkchop: 0 } })
  assert.equal(speedrunRegistry({ eyes: 12 }).get('FindFood')!.preconditions(state), false)
  assert.notEqual(first(state), 'FindFood')
})

test('ND_GRAPH_TOOLS_PRICE: with worn picks and a possible resupply, the resupply goes before a search', () => {
  const state = nether({ inventory: { ...KIT, iron_pickaxe: 0 }, facts: worn })
  assert.equal(withEnv({ ND_GRAPH_TOOLS_PRICE: '1' }, () => first(state)), 'AcquireNetherTools')
})

test('cost import: a death in tactics within 180 game s after an interrupted strategy counts against that strategy', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 9, 27, 10, 0, 0) + s * 1000).toISOString()
  const rows = [
    { level: 'strategy', strategy: 'FindFood', at: t(0), tickRate: 100, after: { alive: true } },
    { level: 'act', skill: 'refuge', death: true, at: t(20) },                // 20 wall s × 5 = 100 game s → FindFood
    { level: 'strategy', strategy: 'MineIron', at: t(100), tickRate: 20, after: { alive: true } },
    { level: 'act', skill: 'flee', death: true, at: t(400) },                 // 300 game s later → not attributed
    { level: 'strategy', strategy: 'GetWater', at: t(500), tickRate: 20, after: { alive: false } },
    { level: 'act', skill: 'wait', death: true, at: t(501) }                  // already a death row of its own
  ]
  assert.deepEqual([...tacticalDeaths(rows)], [0])
})

test('ND_GRAPH_TOOLS_PRICE: arriving with 250 of 260 swings does not start a stem hunt before the Nether work', () => {
  const state = nether({ facts: { nether_pick_swings: 250, nether_tools_ready: false } })
  const steps = () => plan(speedrunRegistry({ eyes: 12 }), state, dragonGoal).steps.map(s => s.id)
  assert.ok(withEnv({ ND_GRAPH_TOOLS_PRICE: '0' }, steps).includes('AcquireNetherTools'), 'old gate: a resupply before rods or the bastion')
  assert.ok(!withEnv({ ND_GRAPH_TOOLS_PRICE: '1' }, steps).includes('AcquireNetherTools'))
})

test('ND_GRAPH_END_ORDER: the stronghold is searched with the eyes; the dragon kit is collected before entering the End', () => {
  const overworld = worldFromObservation({ state: { dimension: 'overworld', health: 20, food: 20, inventory: { ...KIT, ender_eye: 12 }, pos: { x: 0, y: 70, z: 0 } },
    known: { portal: { x: 5, y: 64, z: 5 } }, facts: { end_ready: fact(false, 'observed', 0) } }, 0)
  const steps = (s: WorldState) => plan(speedrunRegistry({ eyes: 12 }), s, dragonGoal).steps.map(x => x.id)
  const failedKit = (s: WorldState) => plan(speedrunRegistry({ eyes: 12 }), s, dragonGoal, { excluded: new Set(['PrepareEnd']), retryStates: new Map([['PrepareEnd', s]]) }).steps.map(x => x.id)
  assert.deepEqual(withEnv({ ND_GRAPH_END_ORDER: '0' }, () => steps(overworld)).slice(0, 2), ['PrepareEnd', 'FindStronghold'], 'kit first while it is possible')
  assert.deepEqual(withEnv({ ND_GRAPH_END_ORDER: '0' }, () => failedKit(overworld)), [], 'old: a failed kit blocks the stronghold')
  // The kit still goes first by price (beds: no bed — no fight), but a failed kit no longer blocks the stronghold.
  assert.deepEqual(withEnv({ ND_GRAPH_END_ORDER: '1' }, () => steps(overworld)).slice(0, 2), ['PrepareEnd', 'FindStronghold'])
  assert.deepEqual(withEnv({ ND_GRAPH_END_ORDER: '1' }, () => failedKit(overworld)), ['FindStronghold', 'PrepareEnd', 'EnterEnd', 'KillDragon'])
})

test('ND_GRAPH_TOOLS_PRICE: the resupply is priced by what it must fetch — a carried recipe is cheap, a blind stem hunt is not', () => {
  const noRecipe = { ...KIT, stone_pickaxe: 0, stick: 1, oak_planks: 0 }
  const at = (inventory: Record<string, number>, woodSeen: boolean) =>
    nether({ inventory, known: { bastion: BASTION }, facts: { nether_pick_swings: 190, nether_tools_ready: false, nether_wood_seen: woodSeen } })
  withEnv({ ND_GRAPH_TOOLS_PRICE: '1' }, () => {
    // sr27-graph-B slot 22: 190/260, one stick, no stems in sight — five stem hunts in a second instead of the bastion.
    assert.ok(['BastionBarter', 'FindFortress'].includes(first(at(noRecipe, false))!), 'Nether work first, not a blind stem hunt')
    assert.equal(first(at(noRecipe, true)), 'AcquireNetherTools', 'stems seen nearby: fetch them first')
    assert.equal(first(at(KIT, false)), 'AcquireNetherTools', 'sticks, stone and a table carried: a pick in seconds')
  })
})

test('ND_GRAPH_RISK_PER_DONE: telemetry mortality is per attempt; a strategy that needs many attempts carries their deaths', () => {
  // GetBlazeRods in sr27 (attributed deaths): 14 attempts, none finished (tactics interrupt), 1 death.
  const model = { key: 'GetBlazeRods', samples: 14, successes: 0, partials: 0, deaths: 1, deathSamples: 14, medianTicks: 120, p90Ticks: 980 }
  const state = nether({ inventory: { ...KIT, ender_pearl: 12 }, known: { fortress: FORTRESS } })
  const risk = (env: string) => withEnv({ ND_GRAPH_RISK_PER_DONE: env }, () => { const r = speedrunRegistry({ eyes: 12 }); applyCosts(r, [model]); return r.get('GetBlazeRods')!.estimateRisk(state) })
  assert.ok(risk('0') < 0.3, 'old: one death in 14 attempts dilutes the 0.74 prior')
  assert.ok(risk('1') > 0.6, 'per completion: 1 − (1 − 1/14)^(1/success) with success (0+1)/16')
})

test('graph surcharges stay outside the telemetry blend (many survived samples do not dilute a state-specific risk)', () => {
  const state = nether({ inventory: { ...KIT, iron_pickaxe: 0, ender_pearl: 12 }, known: { fortress: FORTRESS }, facts: { nether_pick_swings: 0, nether_tools_ready: false } })
  withEnv({ ND_GRAPH_TOOLS_PRICE: '1' }, () => {
    const bare = speedrunRegistry({ eyes: 12 }).get('GetBlazeRods')!
    const costed = speedrunRegistry({ eyes: 12 })
    applyCosts(costed, [{ key: 'GetBlazeRods', samples: 500, successes: 400, deaths: 0, deathSamples: 500, medianTicks: 4000, p90Ticks: 8000 }])
    // Telemetry says the fight itself is safe here; the 0.04 of a total tool shortfall remains on top.
    assert.ok(Math.abs(costed.get('GetBlazeRods')!.estimateRisk(state) - 0.04) < 0.01, String(costed.get('GetBlazeRods')!.estimateRisk(state)))
    assert.ok(bare.estimateRisk(state) > 0.04)
  })
})

test('ND_GRAPH_ENTER_HUNGRY: a lit portal with little food is entered at a priced risk instead of a mandatory hunt', () => {
  const ow = (food: Record<string, number>, hunger = 18) => worldFromObservation({ state: { dimension: 'overworld', health: 20, food: hunger,
    inventory: { ...KIT, cooked_porkchop: 0, ...food }, pos: { x: 0, y: 70, z: 0 } }, known: { portal: { x: 5, y: 64, z: 5 } },
    facts: { nether_ready: fact(false, 'observed', 0), end_ready: fact(false, 'observed', 0) } }, 0)
  assert.equal(withEnv({ ND_GRAPH_ENTER_HUNGRY: '0' }, () => first(ow({ cooked_porkchop: 2 }))), 'PrepareNether', 'old gate: hunt to 4 portions first')
  withEnv({ ND_GRAPH_ENTER_HUNGRY: '1' }, () => {
    const registry = speedrunRegistry({ eyes: 12 })
    // FindFood telemetry sr27: 1 success of 45, 5 deaths of 31 — the hunt is the dearer way here.
    applyCosts(registry, [{ key: 'FindFood', samples: 31, successes: 1, deaths: 5, deathSamples: 31, medianTicks: 2260, p90Ticks: 2260 }])
    assert.equal(plan(registry, ow({ cooked_porkchop: 2 }), dragonGoal).steps[0]?.id, 'EnterNether')
    const enter = registry.get('EnterNether')!
    assert.ok(enter.estimateRisk(ow({})) > enter.estimateRisk(ow({ cooked_porkchop: 2 })), 'less food — dearer entry')
    assert.equal(enter.preconditions(ow({ cooked_porkchop: 2, iron_pickaxe: 0, stone_pickaxe: 0 })), false, 'a pick is still needed')
  })
})

test('ND_GRAPH_TOOLS_PRICE: a failed blind stem hunt is not reopened by walking a few blocks (sr27-graph-B2: 176 turns of it)', () => {
  const run = (env: Record<string, string>) => withEnv({ ND_NE_NO_GIVEUP: '1', ...env }, () => {
    const brain = createCampaignIntelligence({ eyes: 12, beds: 5, now: () => 0, sleep: async () => {}, record: () => {},
      observe: async () => ({ state: {} }), call: async () => ({}), execute: async () => ({ outcome: 'FAILURE', events: [] }) })
    const retry = brain.registry.get('AcquireNetherTools')!.retryCondition!
    const failed = nether({ inventory: { ...KIT, stone_pickaxe: 0, stick: 1, oak_planks: 0 }, facts: { nether_pick_swings: 150, nether_tools_ready: false, nether_wood_seen: false } })
    const moved = { ...failed, position: { x: 20, y: 70, z: 0 } }
    const seen = { ...failed, facts: { ...failed.facts, nether_wood_seen: fact(true, 'observed', 0) } }
    return { moved: retry(failed, moved), seen: retry(failed, seen) }
  })
  assert.equal(run({ ND_GRAPH_TOOLS_PRICE: '0' }).moved, true, 'old: any 8 blocks reopen it')
  assert.deepEqual(run({ ND_GRAPH_TOOLS_PRICE: '1' }), { moved: false, seen: true })
})

test('ND_GRAPH_END_ORDER: underground at the stronghold the room goes first; the kit is not started 60 levels below the sheep', () => {
  const at = (y: number) => worldFromObservation({ state: { dimension: 'overworld', health: 20, food: 20, inventory: { ...KIT, ender_eye: 12 }, pos: { x: 317, y, z: 1352 } },
    known: { portal: { x: 5, y: 64, z: 5 } }, facts: { end_ready: fact(false, 'observed', 0) } }, 0)
  const steps = (s: WorldState) => plan(speedrunRegistry({ eyes: 12 }), s, dragonGoal).steps.map(x => x.id)
  assert.equal(withEnv({ ND_GRAPH_END_ORDER: '1' }, () => steps(at(-5)))[0], 'FindStronghold')
  assert.equal(withEnv({ ND_GRAPH_END_ORDER: '1' }, () => steps(at(70)))[0], 'PrepareEnd')
  assert.equal(withEnv({ ND_GRAPH_END_ORDER: '0' }, () => steps(at(-5)))[0], 'PrepareEnd', 'without the flag nothing changes')
})
