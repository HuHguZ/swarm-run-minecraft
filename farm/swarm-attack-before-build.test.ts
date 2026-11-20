import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, type SwarmMember } from '../daemon/src/swarm'
import { swarmTurn } from './swarm/swarm-driver/turn'

const p = (x = 0, y = 120, z = 0) => ({ x, y, z })
const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
const zone = { ...p(649, 153, 646), tier: 5 }
function fixture({ fresh = true, strong = true, upper = false, plan = true, maneuver = false, foeAbove = false, rescuing = false } = {}) {
  const now = () => 10000, calls: string[] = []
  const member: SwarmMember = { id: 'U', team: 'blue', position: upper ? p(648, 153, 646) : p(600, 120, 590), health: 20,
    strength: strong ? 120 : 20, role: 'miner-builder', inventory: strong ? { netherite_axe: 1, cobblestone: 32 } : {},
    weapon: strong ? 'netherite_axe' : undefined, armor: strong ? armor : [], ench: strong ? { sharpness: 5, protection: 16 } : {} }
  const members = [member, ...Array.from({ length: 11 }, (_, i) => ({ ...member, id: 'Ally' + i, role: 'fighter' as const,
    position: p(648, 153, 646), strength: 20, weapon: undefined, inventory: {}, armor: [], ench: {} }))]
  const board = new SwarmBoard('blue', now)
  board.setMembers(members)
  const foePosition = p(596, foeAbove ? 128 : 120, 597)
  board.observe('Ally0', fresh ? now() : now() - 2000, { id: 'Red', position: foePosition, visible: true,
    equipment: { weapon: 'stone_sword', armor: [] } })
  const task = plan ? planPvp(board, members, { foesLeft: 12, doctrine: 'hunt', quorum: 1, lootZones: [zone] }).get('U')! :
    { kind: maneuver ? 'goto' : 'fight', data: { target: 'Red', ...(maneuver ? { hold: 'shield' } : {}) }, position: foePosition }
  const pos = { U: { p: member.position, hp: 20, inv: member.inventory, armor: member.armor, rescuing } }
  const b = { name: 'U', team: 'blue', c: { async call(method) { calls.push(method); return { detail: {} } } } }
  const sw: any = { now, generation: 1, pos, arms: true, hideouts: [], chestTops: [zone], alive: () => true, arena: { x: 600, y: 120, z: 600, r: 100 },
    refresh: () => ({ board, member, members, task }), say() {}, log() {}, onslaught: () => false, cooldown: new Map(),
    chestAtHand: () => false, cacheTurn: async () => false, transfer: async () => false, loot: async () => false, tour: async () => false,
    blocked: () => false, positionStep: async (_b, _context, purpose) => { calls.push('position:' + purpose); return true },
    buildStep: async () => { calls.push('build'); return true }, mineStep: async () => { calls.push('mine'); return true },
    turnBuildSite: async () => { calls.push('cutoff') }, turnFight: async () => { calls.push('fight') }, turnHold: async () => { calls.push('shield') },
    search: async () => { calls.push('search') }, detail: r => r?.detail || r }
  return { task, calls, run: () => swarmTurn(sw).turn(b) }
}

test('the newly equipped rim builder takes a fresh allied target instead of a team cutoff', async () => {
  const f = fixture({ upper: true })
  assert.equal(f.task.kind, 'fight')
  assert.ok(f.task.data)
  assert.equal('buildKind' in f.task.data, false)
  await f.run()
  assert.deepEqual(f.calls, ['fight'])
})

test('a profitable assigned attack reaches combat before optional miner position and construction', async () => {
  const f = fixture({ plan: false })
  await f.run()
  assert.deepEqual(f.calls, ['fight'])
})

test('a stale report does not turn optional work into a pursuit', async () => {
  const f = fixture({ plan: false, fresh: false })
  await f.run()
  assert.deepEqual(f.calls, ['position:build'])
})

test('a weak builder retains equipment preparation', () => {
  const f = fixture({ strong: false, upper: true })
  assert.equal(f.task.kind, 'loot')
})

test('an ascent still gets necessary digging before combat', async () => {
  const f = fixture({ plan: false, foeAbove: true })
  await f.run()
  assert.deepEqual(f.calls, ['mine'])
})

test('an explicit shield maneuver and emergency movement retain priority', async () => {
  const shield = fixture({ plan: false, maneuver: true })
  await shield.run()
  assert.deepEqual(shield.calls, ['shield'])
  const rescue = fixture({ plan: false, rescuing: true })
  await rescue.run()
  assert.deepEqual(rescue.calls, [])
})
