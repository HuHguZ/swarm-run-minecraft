import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, knownEnemies, pvpState } from '../src/swarm/board'
import { assessSwarmFight, memberFight } from '../src/swarm/fight'
import { pvpFrame, type PvpPlan } from '../src/swarm/plan-frame'
import { pvpFlee } from '../src/swarm/plan-flee'
import { shoveValue } from '../src/swarm/shove'
import type { EnemyObservation, SwarmMember } from '../src/swarm/types'

const p = { x: 557.3282968380656, y: 150.5, z: 644.4920342235919 }
const naked = { armor: [] as string[] }
function scene() {
  let time = 1000
  const own: SwarmMember = { id: 'g', team: 'blue', position: { x: 538.475666864703, y: 153.5, z: 631.587088812499 }, health: 20, strength: 50, role: 'flank',
    weapon: 'wooden_sword', inventory: { wooden_sword: 1, trident: 1, netherite_spear: 1 }, armor: ['iron_boots'] }
  const team = [own, ...Array.from({ length: 11 }, (_, i): SwarmMember => ({ id: `watch${i}`, team: 'blue', position: { x: 900 + i, y: 120, z: 900 }, health: 20, strength: 20, role: 'fighter' }))]
  const board = new SwarmBoard('blue', () => time, 8000); board.setMembers(team)
  const see = (source: string, equipment: EnemyObservation['equipment'], extra: Partial<EnemyObservation> = {}) => board.observe(source, time, { id: 'h', position: p, visible: true, equipment, ...extra })
  return { board, own, team, see, at: (at: number) => { time = at } }
}

test('eleven clear naked reports survive a1ms newer unknown observer and avoid the captured phantom-P4 flee', () => {
  const f = scene()
  for (const m of f.team.slice(0, 11)) f.see(m.id, naked)
  f.at(1001); f.see('watch10', { armor: [], unknownArmorSlots: 4 })
  for (const e of [
    { id: 'l', position: { x: 575.2909638488053, y: 120, z: 629.485723747471 }, equipment: { armor: ['iron_boots', 'chainmail_leggings', 'iron_helmet'], enchanted: true, weapon: 'stone_axe' } },
    { id: 'n', position: { x: 568.5013036856794, y: 121.51074260861367, z: 621.0615774603835 }, equipment: { armor: ['iron_boots', 'leather_chestplate'], enchanted: true, weapon: 'oak_planks' } }
  ]) f.board.observe('g', 1001, { ...e, visible: true })
  const enemies = knownEnemies(f.board), h = enemies.find(e => e.id === 'h')!
  assert.equal(h.source, 'watch10', 'position still belongs to the newest observer')
  assert.equal(h.equipment?.unknownArmorSlots || 0, 0, 'not seeing armor does not contradict the other observers')
  const risk = assessSwarmFight(f.own, enemies, f.team)
  assert.equal(risk.enemyProtection[1], 0)
  assert.equal(risk.unsafe, false)
  const plan = new Map(), S = pvpFrame({ board: f.board, team: f.team, state: pvpState(f.board), enemies, aggressive: false, doctrine: 'hunt', options: { foesLeft: 12 }, plan } as PvpPlan)
  pvpFlee(S)
  assert.equal(plan.get('g'), undefined, 'early flee leaves this favorable contest available to the later assignment phase')
})

test('new visible armor replaces known naked slots and a full clear removes it', () => {
  const f = scene(); f.see('g', naked)
  f.at(1001); f.see('watch0', { armor: ['netherite_helmet'], unknownArmorSlots: 3, armorVisible: [false, false, false, true] })
  assert.deepEqual(knownEnemies(f.board)[0].equipment?.armor, ['netherite_helmet'])
  f.at(1002); f.see('watch0', { armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true })
  let h = knownEnemies(f.board)[0]
  assert.equal(h.equipment?.armor?.length, 4)
  const risk = assessSwarmFight(f.own, [h], f.team)
  assert.equal(risk.enemyProtection[1], 16)
  assert.equal(risk.unsafe, true, 'real enchanted armor still makes this exchange unsafe')
  f.at(1003); f.see('watch0', naked)
  h = knownEnemies(f.board)[0]
  assert.deepEqual(h.equipment?.armor, [])
  assert.equal(h.equipment?.unknownArmorSlots || 0, 0)
})

test('only freshly visible slots refresh or clear their shared armor facts', () => {
  const f = scene(); f.see('g', { armor: ['iron_boots', 'iron_helmet'] })
  f.at(2000)
  f.see('watch0', { armor: ['iron_boots'], unknownArmorSlots: 2, armorVisible: [false, false, false, true] })
  assert.deepEqual(knownEnemies(f.board)[0].equipment?.armor, ['iron_boots'])
  f.at(9000)
  f.see('watch0', { armor: ['iron_boots'], armorVisible: [false, false, false, false] })
  const h = knownEnemies(f.board)[0]
  assert.deepEqual(h.equipment?.armor, [])
  assert.equal(h.equipment?.unknownArmorSlots, 3, 'only the freshly seen empty head slot remains known')
})

test('unknown reports and nametags do not renew armor knowledge past the existing TTL', () => {
  const f = scene(); f.see('g', naked)
  f.at(7999); f.see('watch0', { armor: [], unknownArmorSlots: 4 })
  f.at(8999); f.see('watch0', naked, { visible: false, nametag: true })
  assert.equal(knownEnemies(f.board)[0].equipment?.unknownArmorSlots || 0, 0)
  f.at(9000); f.see('watch0', naked, { visible: false, nametag: true })
  const h = knownEnemies(f.board)[0]
  assert.equal(h.equipment?.unknownArmorSlots, 4, 'position can stay fresh while the old full gear observation expires')
  assert.equal(h.position.y, p.y)
})

test('an unmasked partial legacy report remains conservative without a full observation', () => {
  const f = scene(); f.see('g', { armor: [], unknownArmorSlots: 4 })
  assert.equal(knownEnemies(f.board)[0].equipment?.unknownArmorSlots, 4)
})

test('a newer observer without armor visibility cannot erase confirmed armor glint', () => {
  const f = scene()
  f.see('g', { armor: ['netherite_boots', 'netherite_leggings', 'netherite_chestplate', 'netherite_helmet'], enchanted: true })
  f.at(1001); f.see('watch0', { armor: [], unknownArmorSlots: 4, armorVisible: [false, false, false, false] })
  const h = knownEnemies(f.board)[0]
  assert.equal(assessSwarmFight(f.own, [h], f.team).enemyProtection[1], 16)
  const range = memberFight(f.own, h).damage
  assert.ok(range[1] > range[0], 'visible glint remains a damage range, not known Protection IV')
})

test('a legacy partial report updates its named item without clearing the other known slots', () => {
  const f = scene(); f.see('g', naked)
  f.at(1001); f.see('watch0', { armor: ['netherite_chestplate'], unknownArmorSlots: 3 })
  const h = knownEnemies(f.board)[0]
  assert.deepEqual(h.equipment?.armor, ['netherite_chestplate'])
  assert.equal(h.equipment?.unknownArmorSlots || 0, 0)
})

test('per-slot visible glint changes independently of a weapon glint and ages with its armor fact', () => {
  const f = scene(), armor = ['netherite_boots', 'netherite_leggings', 'netherite_chestplate', 'netherite_helmet']
  f.see('g', { armor, enchanted: true, armorVisible: [true, true, true, true], armorEnchanted: [true, true, true, true] })
  f.at(2000); f.see('watch0', { armor, enchanted: true, armorVisible: [false, false, false, true], armorEnchanted: [false, false, false, false] })
  assert.equal(assessSwarmFight(f.own, knownEnemies(f.board), f.team).enemyProtection[1], 12, 'only the observed helmet lost its glint')
  f.at(9000); f.see('watch0', { armor, armorVisible: [false, false, false, false], armorEnchanted: [true, true, true, true] })
  const aged = knownEnemies(f.board)[0]
  assert.deepEqual(aged.equipment?.armor, ['netherite_helmet'])
  assert.equal(aged.equipment?.unknownArmorSlots, 3)
  f.at(9001); f.see('g', { armor, weapon: 'diamond_sword', enchanted: true, armorVisible: [true, true, true, true], armorEnchanted: [false, false, false, false] })
  const risk = assessSwarmFight(f.own, knownEnemies(f.board), f.team)
  assert.equal(risk.enemyProtection[1], 0, 'a weapon glint does not enchant the armor')
  assert.equal(risk.enemySharpness[1], 5, 'the existing visible weapon uncertainty remains intact')
})

test('forget and round reset discard armor names, glint, and completeness together', () => {
  for (const action of ['forget', 'reset'] as const) {
    const f = scene(); f.see('g', { armor: ['netherite_helmet'], enchanted: true })
    if (action === 'forget') f.board.forget('h')
    else { f.board.resetRound(); f.board.setMembers(f.team) }
    f.at(1001); f.see('g', { armor: [], unknownArmorSlots: 4 })
    const h = knownEnemies(f.board)[0]
    assert.deepEqual(h.equipment?.armor, [])
    assert.equal(h.equipment?.unknownArmorSlots, 4)
  }
})

test('lava shove prices actual armor glint while a weapon glint leaves plain armor unchanged', () => {
  const armor = ['netherite_boots', 'netherite_leggings', 'netherite_chestplate', 'netherite_helmet'], edge = { x: 1, z: 0, lava: true }
  const plain = shoveValue({ equipment: { armor } }, edge)
  const weaponGlint = shoveValue({ equipment: { armor, enchanted: true, armorEnchanted: [false, false, false, false] } }, edge)
  const armorGlint = shoveValue({ equipment: { armor, armorEnchanted: [true, true, true, true] } }, edge)
  assert.equal(weaponGlint, plain, 'a shining weapon cannot grant armor protection against lava')
  assert.ok(armorGlint < plain, 'known armor glint remains protective when the newest source omits a weapon glint')
})
