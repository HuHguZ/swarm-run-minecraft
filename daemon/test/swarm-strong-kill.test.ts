import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import { shoveValue, SHOVE } from '../src/swarm/shove'
import { MELEE_CAP } from '../src/swarm/race'
import { harmWait, WINDOW_MS } from '../src/pvp/strike-order'
import { digSeconds, attackSeconds } from '../src/swarm/dislodge'

// Рой против сильного одиночки (стенд 21.10, чемпион в незерите с Защитой IV и Шипами III): убивают булава с падения,
// зелья вреда и сброс в пустоту — ближний бой толпой только кормит его шипы и меч.
const p = (x = 0, y = 64, z = 0) => ({ x, y, z })
const IRON = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
const NETHERITE = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
const CHAMP = { equipment: { weapon: 'netherite_sword', armor: NETHERITE, enchanted: true } }
const blue = (id: string, k: number, extra: Partial<SwarmMember> = {}): SwarmMember => ({ id, team: 'blue', position: p(8, 64, k * 2 - 7), health: 20, strength: 60 - k,
  role: 'fighter', weapon: 'diamond_sword', armor: IRON, ench: {}, inventory: { diamond_sword: 1 }, ...extra })
function scene(members: SwarmMember[], foe = CHAMP) {
  let time = 1000
  const board = new SwarmBoard('blue', () => time, 3000)
  board.setMembers(members)
  const see = () => { for (const m of members) board.observe(m.id, time, { id: 'champ', position: p(0), visible: true, ...foe }) }
  see()
  return { board, members, next: () => { time += 500; see() } }
}
// Он убил двоих наших и жив — сильное меньшинство (race.ts strongFew), бой «как против человека».
const STRONG = { foesLeft: 1, quorum: 2, killsBy: { champ: 2 } }
const onHim = (plan: Map<string, any>) => [...plan.values()].filter(t => t.kind === 'fight' && t.data?.target === 'champ')

test('strong foe: two swords take every invulnerability window, the rest of the melee stays off; mace and harming always go', () => {
  assert.equal(MELEE_CAP, 2, 'a sword charges in 12 ticks, the window is 10: two swords fill it')
  const team = [...Array.from({ length: 6 }, (_, k) => blue(`s${k}`, k, k < MELEE_CAP ? { ench: { sharpness: 5 } } : {})),
    blue('mace', 6, { inventory: { diamond_sword: 1, mace: 1, wind_charge: 4 } }),
    blue('harm', 7, { inventory: { diamond_sword: 1, splash_potion: 2 }, potions: { splash_strong_harming: 2 } })]
  const f = scene(team)
  const plan = planPvp(f.board, team, STRONG)
  const fight = onHim(plan)
  const melee = fight.filter(t => !['pvp:mace', 'pvp:harm'].includes(t.id))
  assert.equal(melee.length, MELEE_CAP, `swords on him: ${fight.map(t => t.id).join(',')}`)
  assert.deepEqual(melee.map(t => t.id).sort(), ['pvp:s0', 'pvp:s1'], 'the two strongest swords')
  assert.ok(plan.get('mace')!.kind === 'fight' && plan.get('mace')!.data!.smash, 'the mace with a wind charge strikes from the air')
  assert.equal(plan.get('harm')!.kind, 'fight', 'harming potions go past his armour')
  for (const id of ['s2', 's3', 's4', 's5']) assert.notEqual(plan.get(id)!.kind, 'fight', `${id}: a third sword adds nothing but thorns`)
})

test('strong foe at a void edge: swords and wind lead him to the void, including a chain of hits from afar', () => {
  const team = Array.from({ length: 6 }, (_, k) => blue(`s${k}`, k, k === 5 ? { inventory: { diamond_sword: 1, wind_charge: 3 } } : {}))
  const edge = scene(team)
  const close = planPvp(edge.board, team, { ...STRONG, edgeOf: () => ({ x: -1, z: 0, drop: Infinity, at: 1 }) })
  assert.equal(onHim(close).length, 6, 'a sprint hit from the far side drops him: all of them')
  assert.ok(onHim(close).every(t => t.data!.shove && Math.cos(t.data!.slot * Math.PI / 4) > 0), 'from the side away from the void')
  const far = scene(team.map((m, k) => ({ ...m, ...(k < MELEE_CAP ? { ench: { sharpness: 5 } } : {}) })))
  const plan = planPvp(far.board, far.members, { ...STRONG, edgeOf: () => ({ x: -1, z: 0, drop: Infinity, at: 4 }) })
  assert.ok(plan.get('s5')!.data!.shove && plan.get('s5')!.data!.push, 'four blocks to the edge: the wind charge reaches')
  assert.equal(onHim(plan).filter(t => !t.data!.push).length, 5, 'несколько ударов ведут к краю в четырёх блоках: работают все пять мечников')
  assert.ok(onHim(plan).every(t => t.data!.shove && Math.cos(t.data!.slot * Math.PI / 4) > 0), 'и заряды, и цепь ударов направлены в пустоту')
  const maceMan = [blue('mace', 0, { inventory: { diamond_sword: 1, mace: 1, wind_charge: 2 } }), blue('m3', 1, { inventory: { diamond_sword: 1, mace: 1, wind_charge: 3 } }), ...Array.from({ length: 4 }, (_, k) => blue(`c${k}`, k + 2))]
  const g = scene(maceMan)
  const pm = planPvp(g.board, maceMan, { ...STRONG, edgeOf: () => ({ x: -1, z: 0, drop: Infinity, at: 4 }) })
  assert.ok(!pm.get('mace')!.data!.push && pm.get('m3')!.data!.push, 'a mace keeps two charges for its launch; the third may push')
})

test('lava kills the naked, not netherite with Protection IV: no shove into a pit he walks out of', () => {
  const pit = { x: 1, z: 0, drop: Infinity, lava: true, at: 1 }
  assert.ok(shoveValue(CHAMP, pit) < SHOVE, `champion in lava: ${shoveValue(CHAMP, pit).toFixed(2)} of his hp`)
  assert.equal(shoveValue({ equipment: { armor: [] } }, pit), 1, 'naked: dead in the pit')
  assert.equal(shoveValue(CHAMP, { x: 1, z: 0, at: 2 }), 1, 'the void kills anyone')
})

test('a fight task that turns into a shove reaches the board, not the old task without the flag', () => {
  const team = [blue('a', 0, { inventory: { diamond_sword: 1, wind_charge: 2 } })]
  const f = scene(team, { equipment: { weapon: 'iron_sword', armor: [] } } as any)
  // Мелкий край с той же стороны: то же место в кольце (slot), только без сброса — по месту задача «та же».
  planPvp(f.board, team, { quorum: 1, aggressive: true, edgeOf: () => ({ x: -1, z: 0, drop: 5, at: 1 }) })
  const before = f.board.tasks().find(t => t.id === 'pvp:a')!
  assert.ok(!before.data!.shove)
  assert.ok(f.board.claim('pvp:a', 'a', 10000), 'the driver holds its task')
  f.next()
  planPvp(f.board, team, { quorum: 1, aggressive: true, edgeOf: () => ({ x: -1, z: 0, drop: Infinity, at: 1 }) })
  const t = f.board.tasks().find(t => t.id === 'pvp:a')!
  assert.equal(t.data!.slot, before.data!.slot, 'same ring slot as before')
  assert.ok(t.data!.shove && t.data!.push, `the board carries the shove: ${JSON.stringify(t.data)}`)
})

test('undermining the strong foe: the hole over the void goes first, obsidian waits for a diamond pickaxe', () => {
  // Земля за полем: песчаник на обсидиане фундамента, под ним пустота (watch.ts holeCells, F = 0); галерея — падение 7 бл.
  const cell = (x: number, z: number, more: any) => ({ x, y: 63, z, feetY: 64, blocks: ['cut_sandstone', 'obsidian'], stands: [p(x + 1.5, 64, z + .5)], handMs: 254000, ...more })
  const voidHole = cell(2, 1, { drop: Infinity, tier: 2 }), gallery = cell(-1, 1, { drop: 7, blocks: ['sandstone', 'sandstone'], handMs: 8000 })
  const digSites = () => [gallery, voidHole]
  const crowd = () => Array.from({ length: 6 }, (_, k) => blue(`s${k}`, k + 1))
  const pick = [blue('pick', 0, { position: p(0.5, 64, 4.5), inventory: { diamond_sword: 1, diamond_pickaxe: 1 } }), ...crowd()]
  const f = scene(pick)
  const walk = Math.hypot(3, 3) / 5.6
  assert.ok(digSeconds(pick[0], voidHole) + walk < attackSeconds(pick[0], f.board.enemies()[0]), 'копка с подходом дешевле доступной атаки по видимой броне')
  const t = planPvp(f.board, pick, { ...STRONG, digSites }).get('pick')!
  assert.equal(t.data!.dig, '2,63,1', `the gallery is nearer to him, the void kills: ${JSON.stringify(t.data)}`)
  assert.equal(t.data!.drop, Infinity, 'the driver knows the hole is lethal (edgeNear → shove)')
  const iron = [blue('iron', 0, { position: p(3, 64, 3.5), inventory: { diamond_sword: 1, iron_pickaxe: 1 } }), ...crowd()]
  const g = scene(iron)
  assert.notEqual(planPvp(g.board, iron, { ...STRONG, digSites: () => [voidHole] }).get('iron')!.data?.dig, '2,63,1', 'iron does not cut obsidian in time')
})

test('web, axe, mace: with a mace on the team the axes go in to break his shield; without one they stay capped', () => {
  const swords = () => Array.from({ length: 6 }, (_, k) => blue(`s${k}`, k))
  const axes = () => [7, 8].map(k => blue(`axe${k}`, k, { inventory: { diamond_sword: 1, diamond_axe: 1 } }))
  const combo = [...swords(), blue('mace', 6, { inventory: { diamond_sword: 1, mace: 1, wind_charge: 4 } }), ...axes()]
  const f = scene(combo)
  const plan = planPvp(f.board, combo, STRONG)
  for (const id of ['axe7', 'axe8']) assert.ok(plan.get(id)!.kind === 'fight' && plan.get(id)!.data!.axe, `${id}: the shield he raises against the mace goes down`)
  const alone = [...swords(), ...axes()]
  const g = scene(alone)
  const solo = planPvp(g.board, alone, STRONG)
  for (const id of ['axe7', 'axe8']) assert.notEqual(solo.get(id)!.kind, 'fight', `${id}: no mace to follow up — a third blade adds thorns only`)
})

test('harming in invulnerability windows: the cloud lands after the window of the last hit on him', () => {
  assert.equal(harmWait(1000, null, 10), 0, 'nobody hit him: throw')
  assert.equal(harmWait(1000, 1000, 4), WINDOW_MS - 200, 'just hit, 4 ticks of flight: wait out the rest')
  assert.equal(harmWait(1000, 1000, 10), 0, 'the flight itself outlasts the window')
})
