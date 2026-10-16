// Named stress scenarios (user, 06.10: "a diamond god-tank suddenly appears, TNT starts falling..."), plus a seeded
// generator of random distractions and a shrinker of failing tapes. Ticks: 20 per second.
import type { Scenario, SimEvent } from './sim-world'
import { rng } from './sim-world'

const iron = { armor: 15, toughness: 0 }

// A lower bound on observed arrivals, not a night-spawn rate. Lost sightings must not duplicate the same mob.
// shortcut: no entity IDs in old tactical records; replacement by another mob of the same kind is unknowable.
export function observedArrivals(frames: Array<{ at: number; enemies: Array<{ kind: string; distance: number; angle?: number }> }>): SimEvent[] {
  const maximum = new Map<string, number>(), events: SimEvent[] = []
  let previous = 0
  for (const frame of frames) {
    if (!Number.isInteger(frame.at) || frame.at < previous) throw new Error('unordered observation tick')
    previous = frame.at
    const counts = new Map<string, number>()
    for (const enemy of frame.enemies) {
      if (typeof enemy.kind !== 'string' || !enemy.kind || !Number.isFinite(enemy.distance) || enemy.distance < 0 || enemy.angle !== undefined && !Number.isFinite(enemy.angle)) throw new Error('invalid observed enemy')
      const ordinal = (counts.get(enemy.kind) ?? 0) + 1; counts.set(enemy.kind, ordinal)
      if (ordinal > (maximum.get(enemy.kind) ?? 0)) events.push({ at: frame.at, type: 'enemy', ...enemy })
    }
    for (const [kind, count] of counts) maximum.set(kind, Math.max(count, maximum.get(kind) ?? 0))
  }
  return events
}

export const SCENARIOS: Scenario[] = [
  { name: 'regress-box-flight-arrow', seed: 3008, ticks: 600,
    body: { hp: 4, food: 15, armor: 7 }, events: [
      { at: 99, type: 'enemy', kind: 'skeleton', distance: 3.6, angle: 4.6 }] },
  { name: 'regress-retreat-box-eta', seed: 3309, ticks: 600,
    body: { hp: 8, food: 13, armor: 0 }, world: { physics: .5 }, events: [
      { at: 77, type: 'enemy', kind: 'zombie', distance: 13.9, angle: 3.8 },
      { at: 77, type: 'enemy', kind: 'zombie', distance: 12.4, angle: 6.4 },
      { at: 77, type: 'enemy', kind: 'zombie', distance: 13.7, angle: 7.7 }] },
  // Two runs with no useful distance gain must leave an untried physical box in the price comparison.
  { name: 'regress-ow-exhausted-refuge', seed: 1, ticks: 900,
    body: { hp: 9, food: 13, armor: 0, weapon: 'stone_sword', blocks: 16, meals: 0 }, world: { physics: .7, floorDiggable: false },
    events: [{ at: 10, type: 'enemy', kind: 'spider', distance: 4.3 }] },
  // Native cmk1-s1-3: Fight closed on a creeper at 4.3 before Dodge; mk1-s2-5: a critical arrow restarted BlockOff.
  { name: 'regress-ow-creeper-approach', seed: 1, ticks: 600,
    body: { hp: 16, food: 20, armor: 0, weapon: 'stone_sword', blocks: 0, meals: 0 }, world: { physics: .5 },
    events: [{ at: 10, type: 'enemy', kind: 'creeper', distance: 4.3 }] },
  { name: 'regress-ow-box-critical-hit', seed: 1, ticks: 600,
    body: { hp: 12, food: 13, armor: 0, weapon: 'stone_sword', blocks: 240, meals: 0 }, world: { physics: .5, floorDiggable: false },
    events: [{ at: 10, type: 'enemy', kind: 'skeleton', distance: 6.3 }] },
  { name: 'diamond-tank', body: { ...iron, blocks: 16 }, events: [
    { at: 20, type: 'enemy', kind: 'player', player: true, distance: 6, damage: 10, armor: 20, toughness: 8, hostile: true }] },
  { name: 'tnt-falling', events: [{ at: 20, type: 'tnt', distance: .5, fuse: 60 }] },
  { name: 'creeper-skeleton-hp3', body: { hp: 3 }, events: [
    { at: 10, type: 'enemy', kind: 'creeper', distance: 5 }, { at: 10, type: 'enemy', kind: 'skeleton', distance: 12, angle: 2 }] },
  { name: 'lava-under-feet', body: { frPotion: 1 }, events: [{ at: 20, type: 'lava' }] },
  { name: 'lava-no-potion', events: [{ at: 20, type: 'lava' }] },
  { name: 'fall-with-water', body: { waterBucket: true }, events: [{ at: 20, type: 'fall', height: 30 }] },
  { name: 'brute-in-nether', world: { nether: true, floorDiggable: false }, body: { ...iron, blocks: 20 }, events: [
    { at: 20, type: 'enemy', kind: 'piglin_brute', distance: 8 }] },
  { name: 'arrows-from-afar', body: { shield: true }, events: [
    { at: 20, type: 'enemy', kind: 'skeleton', distance: 14 }, { at: 30, type: 'enemy', kind: 'skeleton', distance: 14, angle: .6 }] },
  { name: 'crowd', body: { hp: 14 }, events: [0, 1, 2, 3, 4].map(i => ({ at: 20 + i * 5, type: 'enemy' as const, kind: i % 2 ? 'husk' : 'zombie', distance: 6 + i, angle: i * 1.2 })) },
  { name: 'fire-no-water', events: [{ at: 20, type: 'fire', ticks: 200 }] },
  { name: 'fire-with-water', body: { waterBucket: true, hp: 6 }, events: [{ at: 20, type: 'fire', ticks: 300 }] },
  { name: 'suffocation', events: [{ at: 20, type: 'suffocate' }] },
  { name: 'drowning', events: [{ at: 20, type: 'water', ticks: 700 }], ticks: 900 },
  { name: 'blocks-lost-in-box', body: { hp: 8 }, events: [
    { at: 10, type: 'enemy', kind: 'zombie', distance: 5 }, { at: 10, type: 'enemy', kind: 'zombie', distance: 6, angle: 1 }, { at: 40, type: 'loseBlocks' }] },
  { name: 'charged-creeper', events: [{ at: 10, type: 'enemy', kind: 'creeper', distance: 4, charged: true }] },
  { name: 'cornered-zombies-hp5', body: { hp: 5, blocks: 0 }, world: { exits: false, floorDiggable: false }, events: [
    { at: 10, type: 'enemy', kind: 'zombie', distance: 3 }] },
  // Minimal tapes the fuzzer found on 06.10 (research/claude-1006/s4-tactics-log.md), kept as regressions.
  { name: 'regress-fists-vs-skeleton', body: { weapon: 'fist' }, events: [{ at: 52, type: 'enemy', kind: 'skeleton', distance: 6.4, angle: 5.63 }] },
  { name: 'regress-regen-flicker', body: { hp: 8, food: 12 }, events: [{ at: 22, type: 'water', ticks: 241 }, { at: 114, type: 'enemy', kind: 'husk', distance: 11.6 }] },
  { name: 'regress-box-vs-archer', body: { hp: 8, food: 12, armor: 0, blocks: 64 }, events: [{ at: 48, type: 'enemy', kind: 'skeleton', distance: 12.5, angle: 2.49 }] },
  { name: 'regress-box-vs-blaze', skill: 'craft', body: { hp: 11, food: 15, blocks: 64 }, events: [{ at: 93, type: 'enemy', kind: 'blaze', distance: 5.9, angle: 3.26 }] },
  { name: 'regress-low-hp-zombie', body: { hp: 6, food: 17 }, events: [{ at: 163, type: 'enemy', kind: 'zombie', distance: 10.4, angle: 1.69 }] },
  { name: 'regress-phantom-fists', body: { weapon: 'fist' }, events: [{ at: 194, type: 'enemy', kind: 'phantom', distance: 13.3, angle: 5.52 }] },
  { name: 'regress-tnt-and-creeper', events: [{ at: 145, type: 'tnt', distance: 1.6, fuse: 69 }, { at: 35, type: 'enemy', kind: 'creeper', distance: 10.2, angle: 2.98 }] },
  { name: 'regress-tnt-and-blaze', skill: 'walk', events: [{ at: 112, type: 'tnt', distance: 4.05, fuse: 40 }, { at: 101, type: 'enemy', kind: 'blaze', distance: 11.8, angle: 3.08 }] },
  { name: 'regress-phantom-and-brute', world: { exits: false, floorDiggable: false }, events: [
    { at: 114, type: 'enemy', kind: 'piglin_brute', distance: 13.3, angle: 3.13 }, { at: 204, type: 'enemy', kind: 'phantom', distance: 12.1, angle: 2.27 }] },
  // Round 2 (s4b-tactics-log.md): A>B>A within 40 ticks. Crit jumps flipped the route/exhaustion facts (farm slot 30:
  // Fight<->LastStand at four blazes); the rest are verdict/refuge thresholds crossed by one hit or one regenerated point.
  { name: 'regress-crit-jump-zombie', skill: 'walk', events: [{ at: 71, type: 'enemy', kind: 'zombie', distance: 4.81, angle: 3.19 }] },
  { name: 'regress-crit-jump-skeleton', skill: 'walk', events: [{ at: 35, type: 'enemy', kind: 'skeleton', distance: 2.84, angle: 2.08 }] },
  { name: 'regress-crit-jump-blazes', world: { nether: true, floorDiggable: false }, body: { shield: true, blocks: 64 }, events: [0, 1, 2, 3].map(i =>
    ({ at: 10 + i * 4, type: 'enemy' as const, kind: 'blaze', distance: 2.5 + i * .5, angle: i * 1.6 })) },
  { name: 'regress-regen-back-to-skeleton', skill: 'craft', body: { hp: 11 }, events: [{ at: 6, type: 'enemy', kind: 'skeleton', distance: 3.96, angle: 4.09 }] },
  { name: 'regress-hide-shield-volley', skill: 'walk', body: { hp: 15, food: 11, shield: true }, world: { exits: false, cover: true }, events: [
    { at: 31, type: 'enemy', kind: 'blaze', distance: 3.6, angle: .47 }, { at: 86, type: 'damage', amount: 7, kind: 'generic' }] },
  { name: 'regress-heal-threshold', body: { hp: 17, food: 15, armor: 7 }, world: { cover: true }, events: [{ at: 15, type: 'enemy', kind: 'zombie', distance: 8.62, angle: 1.89 }] },
  { name: 'regress-creeper-build', body: { hp: 6, food: 16 }, events: [{ at: 23, type: 'enemy', kind: 'creeper', distance: 8.99, angle: .98 },
    { at: 127, type: 'suffocate' }, { at: 203, type: 'enemy', kind: 'phantom', distance: 3.27, angle: 4.31 }] },
  // 10k runs of round 2: the dead-end hold must not delay a lava swim, a ghast overhead is no dead end for it, a ghast is
  // not fled every volley, and a boundary fact does not drag the body back into the action it just left.
  { name: 'regress-lava-dead-end-hold', body: { blocks: 3 }, world: { exits: false }, events: [{ at: 130, type: 'enemy', kind: 'skeleton', distance: 14, angle: .5 }, { at: 148, type: 'lava' }] },
  { name: 'regress-lava-under-ghast', events: [{ at: 15, type: 'enemy', kind: 'ghast', distance: 14.8, angle: 7.5 }, { at: 41, type: 'lava' }] },
  { name: 'regress-ghast-volleys', body: { hp: 14, food: 14, armor: 20, shield: true, blocks: 0 }, events: [{ at: 125, type: 'enemy', kind: 'ghast', distance: 5.2, angle: 3.2 }, { at: 198, type: 'suffocate' }] },
  { name: 'regress-spider-on-fire-box', body: { hp: 15, food: 15, armor: 0 }, events: [{ at: 28, type: 'fire', ticks: 155 }, { at: 78, type: 'enemy', kind: 'spider', distance: 3.3, angle: 4 }] },
  { name: 'regress-husk-at-sight-edge', body: { hp: 11, food: 17, armor: 0 }, events: [{ at: 13, type: 'enemy', kind: 'husk', distance: 6.9, angle: 3.1 },
    { at: 59, type: 'enemy', kind: 'phantom', distance: 6.5, angle: 5.8 }] },
  // Round 4 (S4c): a respawn among zombies on natural ground (farm slot 18, 06.10 22:57:41-46 MSK, 4 deaths): the flat-only
  // exit check found a route on some cells and none on others, LastStand<->CreateDistance on every step (roughScenario 7).
  { ...roughScenario(7), name: 'regress-rough-ground' },
  // 14.10 (offline, 40 000 rough tapes): the hole was priced for endermen only - DigDown under a zombie's blows outbid the run,
  // 14 -> 6 hp before the floor sank, then a run at 6 hp; 9.4% of the tapes died where a simple policy lived (state.digDownCost).
  { ...roughScenario(1443), name: 'regress-dig-under-zombie' },
  { ...roughScenario(49), name: 'regress-fist-dig-under-zombie' }
]

// Round 4 (S4c): zombies (a spider in every fifth) around a body without blocks on stage B's rough ground (1-block steps),
// at half and full client physics - the family that reproduced the slot-18 LastStand<->CreateDistance swings.
export function roughScenario(seed: number): Scenario {
  const r = Math.sin(seed * 12.9898) * 43758.5453, f = r - Math.floor(r)
  return { name: `rough-${seed}`, seed, skill: 'walk', ticks: 600,
    body: { armor: seed % 2 ? 0 : 15, weapon: seed % 3 ? 'fist' : 'iron_sword', blocks: 0, meals: 0, hp: 8 + seed % 13 },
    world: { rough: true, physics: seed % 4 < 2 ? .5 : 1 }, events: [
      { at: 10, type: 'enemy', kind: 'zombie', distance: 1.5 + f * 4, angle: f * 6 },
      { at: 30 + seed % 40, type: 'enemy', kind: seed % 5 ? 'zombie' : 'spider', distance: 3 + (1 - f) * 6, angle: 2 + f }] }
}

const KINDS = ['zombie', 'skeleton', 'creeper', 'spider', 'husk', 'piglin_brute', 'player', 'phantom', 'blaze']
export function randomScenario(seed: number): Scenario {
  const r = rng(seed)
  const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)]
  const events: SimEvent[] = []
  const count = 1 + Math.floor(r() * 4)
  for (let i = 0; i < count; i++) {
    const at = 5 + Math.floor(r() * 200)
    const type = pick(['enemy', 'enemy', 'enemy', 'tnt', 'lava', 'fall', 'fire', 'suffocate', 'water', 'damage', 'loseBlocks'] as const)
    if (type === 'enemy') {
      const kind = pick(KINDS)
      const player = kind === 'player'
      events.push({ at, type, kind, player, distance: 2 + r() * 12, angle: r() * 6.28, ...(player ? { damage: 7 + Math.floor(r() * 4), armor: 20, toughness: 8 } : {}),
        ...(kind === 'creeper' && r() < .2 ? { charged: true } : {}) })
    } else if (type === 'tnt') events.push({ at, type, distance: r() * 6, fuse: 20 + Math.floor(r() * 60) })
    else if (type === 'fall') events.push({ at, type, height: 4 + Math.floor(r() * 30) })
    else if (type === 'fire') events.push({ at, type, ticks: 60 + Math.floor(r() * 200) })
    else if (type === 'water') events.push({ at, type, ticks: 100 + Math.floor(r() * 500) })
    else if (type === 'damage') events.push({ at, type, amount: 1 + Math.floor(r() * 12), kind: 'generic' })
    else events.push({ at, type })
  }
  return {
    name: `fuzz-${seed}`, seed, ticks: 600,
    body: { hp: 4 + Math.floor(r() * 17), food: 10 + Math.floor(r() * 11), armor: pick([0, 7, 15, 20]), weapon: pick(['fist', 'stone_sword', 'iron_sword', 'iron_axe']),
      shield: r() < .4, blocks: pick([0, 3, 5, 16, 64]), meals: pick([0, 2, 8]), waterBucket: r() < .4, frPotion: r() < .3 ? 1 : 0, pearls: r() < .3 ? 2 : 0 },
    world: { exits: r() < .8, cover: r() < .15, nether: r() < .25, floorDiggable: r() < .7, lavaExit: r() < .8, landing: true, portal: false },
    skill: pick(['mine', 'walk', 'craft'] as const),
    events
  }
}

// Round 2: the encounters of the farm's deaths (S1: magma cubes in the basalt deltas, wither skeletons in fortress halls,
// blazes in crowds at the spawner, ghasts) and crowds of one kind; a seed of v1 keeps its old tape (journals cite them).
const KINDS2 = [...KINDS, 'wither_skeleton', 'magma_cube', 'ghast', 'enderman', 'cave_spider', 'vindicator', 'hoglin', 'drowned', 'piglin']
export function randomScenario2(seed: number): Scenario {
  const base = randomScenario(seed)
  const r = rng(seed * 7919 + 17)
  const pick = <T>(list: T[]): T => list[Math.floor(r() * list.length)]
  const events: SimEvent[] = []
  for (const event of base.events) {
    if (event.type !== 'enemy') { events.push(event); continue }
    const kind = pick(KINDS2)
    const player = kind === 'player'
    const crowd = !player && r() < .2 ? 2 + Math.floor(r() * 3) : 1
    for (let i = 0; i < crowd; i++) {
      const { damage, armor, toughness, ...rest } = event
      events.push({ ...rest, kind, player, distance: Math.max(1.5, event.distance + (r() - .5) * 3), angle: (event.angle ?? 0) + i * 1.3,
        ...(player ? { damage: damage ?? 7, armor: 20, toughness: 8 } : {}) })
    }
  }
  const nether = r() < .4
  return { ...base, name: `fuzz2-${seed}`, world: { ...base.world, nether, exits: r() < .7, floorDiggable: nether ? r() < .3 : base.world?.floorDiggable,
    ...(r() < .5 ? { physics: .5 } : {}) }, events }
}

// Remove events, reset body/world fields and the skill, then round the numbers, while the same violation still reproduces.
export async function shrink(scenario: Scenario, fails: (candidate: Scenario) => Promise<boolean>): Promise<Scenario> {
  let best = scenario
  const round = (event: SimEvent) => Object.fromEntries(Object.entries(event).map(([k, v]) => [k, typeof v === 'number' && k !== 'at' ? Math.round(v * 10) / 10 : v])) as SimEvent
  for (let changed = true; changed;) {
    changed = false
    const options: Scenario[] = []
    for (let i = 0; i < best.events.length; i++) options.push({ ...best, events: best.events.filter((_, j) => j !== i) })
    for (const key of Object.keys(best.body ?? {})) { const body = { ...best.body }; delete (body as Record<string, unknown>)[key]; options.push({ ...best, body }) }
    for (const key of Object.keys(best.world ?? {})) { const world = { ...best.world }; delete (world as Record<string, unknown>)[key]; options.push({ ...best, world }) }
    if (best.skill !== undefined) { const { skill: _skill, ...rest } = best; options.push(rest) }
    const rounded = { ...best, events: best.events.map(round) }
    if (JSON.stringify(rounded.events) !== JSON.stringify(best.events)) options.push(rounded)
    for (const option of options) if (await fails(option)) { best = option; changed = true; break }
  }
  return best
}
