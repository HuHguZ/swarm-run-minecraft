import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { SwarmBoard, pvpState } from '../src/swarm/board'
import { canDigTrap, pvpDiggers } from '../src/swarm/plan-jobs'
import { swarmTurnWork } from '../../farm/swarm/swarm-driver/turn-work'
import { swarmWork } from '../src/swarm-work'
import { faceAim } from '../src/pick'

const p = (x: number, z: number, y = 119) => ({ x, y, z })
const key = q => `${q.x},${q.y},${q.z}`
const lower = (x, z) => ({ ...p(x + .5, z + .5), requiresClear: [p(x, z)], support: p(x, z, 118) })
function scene(cells = [0], supports = [1]) {
  const team: any[] = [p(.5, 1.4), p(-.5, .5), p(1.5, .5)].map((position, i) => ({ id: `b${i}`, team: 'blue', position,
    health: 20, strength: 40, role: 'fighter', weapon: 'stone_sword', inventory: { stone_sword: 1, diamond_pickaxe: 1 } }))
  const sites: any[] = cells.map((x, i) => ({ x, y: 119, z: 0, feetY: 120, blocks: ['sandstone', 'obsidian'], drop: Infinity, tier: 2,
    stands: [p(supports[i] + .5, .5, 120), lower(supports[i], 0)] }))
  const foe: any = { id: 'Champ', position: p(.5, .5), seenAt: 10000, source: 'b0', sources: ['b0'], hpEstimate: 20,
    equipment: { weapon: 'diamond_sword', enchanted: true, armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'] } }
  const board = new SwarmBoard('blue', () => 10000, 8000)
  const work = pvpState(board).dislodgeWork = new Map()
  const clear = (x, z = 0, dug = 1) => work.set(`Champ:dig:${x},119,${z}`, { at: 10000, active: false, failed: false, work: 10, alternative: 100,
    deadline: 20000, penalty: 0, penaltyAt: 10000, dug })
  const run = () => { board.setMembers(team); const S: any = { board, team, enemies: [foe], plan: new Map(), aggressive: true,
    options: { digSites: () => [...sites] }, weak: () => false, state: pvpState(board) }; pvpDiggers(S); return S }
  return { team, sites, foe, board, work, clear, run }
}

test('a confirmed cleared upper floor exposes its known lower stand without changing the original job or penalty', () => {
  const f = scene(); f.clear(0); f.clear(1)
  const attempt = f.work.get('Champ:dig:0,119,0')!; attempt.penalty = 2
  const S = f.run(), job = S.diggers.get('b2')?.site
  assert.ok(job, 'remaining obsidian can be reached from a known lower neighboring support')
  assert.equal(key(job), '0,119,0', 'origin key and progress do not move down a layer')
  assert.deepEqual(job.blocks, ['sandstone', 'obsidian'])
  assert.deepEqual(job.stands, [p(1.5, .5)])
  assert.equal(canDigTrap(p(1.5, .5), job), true)
  assert.equal(f.work.get('Champ:dig:0,119,0'), attempt)
  assert.equal(attempt.penalty, 2)
  assert.ok(S.digAvoid.some(q => key(q) === '0,118,0'), 'the remaining lower layer is reserved too')
  assert.ok(S.digAvoid.some(q => key(q) === '1,119,0'), 'the removed upper floor is still avoided')
})

test('a proposed lower stand needs its clear receipt and cannot use an already removed lower support', () => {
  const f = scene(); f.clear(0)
  assert.ok([...f.run().diggers.values()].every((d: any) => d.site.stands.every(q => q.y === 120)), 'unconfirmed lower surface is not supplied; the still live upper stand remains usable')
  f.clear(1, 0, 2)
  assert.equal(f.run().diggers.size, 0, 'a completely removed neighboring column is not a lower stand')
})

test('long obsidian work pays contact risk and chooses a known reachable standoff without changing its hole key', () => {
  const f = scene(); f.clear(0); f.clear(1)
  const remote = lower(3, 2); f.sites[0].stands.push(remote); f.clear(3, 2)
  f.team[2].armor = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']
  f.foe.equipment.weapon = 'netherite_sword'
  let S = f.run()
  assert.deepEqual(S.diggers.get('b2').site.stands, [p(3.5, 2.5)], 'a slightly longer walk beats spending the entire obsidian dig inside melee reach')
  assert.equal(key(S.diggers.get('b2').site), '0,119,0')
  f.work.delete('Champ:dig:3,119,2')
  S = f.run()
  assert.deepEqual(S.diggers.get('b2').site.stands, [p(1.5, .5)], 'unconfirmed far support is still unavailable; the existing body retains final safety authority')
})

test('lower supports remain reserved across workers and an occupied remaining layer is evacuated', () => {
  const f = scene([0, 1, 2], [1, 2, 3]); f.team.push({ ...f.team[2], id: 'b3', position: p(3.5, .5) })
  for (const x of [0, 1, 2, 3]) f.clear(x)
  const S = f.run(), jobs = [...S.diggers.values()].map((d: any) => d.site)
  assert.equal(jobs.length, 2)
  assert.deepEqual(jobs.map(s => s.x).sort(), [0, 2], 'a neighbor cannot mine the lower block supporting the first worker')
  f.board.upsert({ id: 'pvp:b3', assignedTo: 'b3', kind: 'goto', position: jobs.find(s => s.x === 2),
    data: { target: 'Champ', dig: '2,119,0', undermine: true, stands: [p(3.5, .5)] } })
  f.sites.splice(0, 1)
  const retained = f.run()
  assert.equal(key(retained.diggers.get('b3').site), '2,119,0')
  assert.equal(retained.diggers.has('b2'), false, 'a replacement cannot stand on the retained job\'s lower block')

  const occupied = scene(); occupied.team[0].position = p(.5, .5)
  occupied.sites[0].stands.push(lower(0, 1)); occupied.clear(0); occupied.clear(1); occupied.clear(0, 1)
  const moved = occupied.run()
  assert.ok(moved.diggers.has('b2'))
  assert.ok(moved.digVacate.has('b0'), 'a guard on the remaining obsidian is moved before the body starts mining it')
  const safe = moved.digVacate.get('b0')
  assert.ok(!(Math.floor(safe.y - .01) === 118 && safe.x < 1 && safe.z < 1 && safe.x > 0 && safe.z > 0))
})

function driver(allyOnBottom = false, peer = false) {
  const calls: any[] = [], site: any = { x: 0, y: 119, z: 0, feetY: 120, blocks: ['sandstone', 'obsidian'], dug: 1, stands: [p(1.5, .5)] }
  const board = new SwarmBoard('blue', () => 10000, 8000)
  const task: any = { kind: 'goto', assignedTo: 'Worker', position: site, data: { target: 'Champ', dig: key(site), undermine: true, blocks: site.blocks, stands: site.stands } }
  if (peer) board.upsert({ id: 'peer', kind: 'goto', assignedTo: 'Peer', position: { x: 1, y: 119, z: 0 },
    data: { target: 'Champ', dig: '1,119,0', blocks: ['sandstone', 'obsidian'] } })
  const members = [{ id: 'Worker', position: p(1.5, .5) }, ...(allyOnBottom ? [{ id: 'Ally', position: p(.5, .5) }] : [])]
  const b: any = { name: 'Worker', swarmTask: task, c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'status') return { state: { pos: p(1.5, .5) } }
    if (method === 'center_in') return { detail: { ok: true, at: p(1.5, .5) } }
    if (method === 'swarm_work') return { detail: { ok: true } }
    return {}
  } } }
  const holes: any[] = [], sw: any = { generation: 1, now: () => 10000, alive: () => true, log() {}, pos: {}, arena: {}, cooldown: new Map(), holes,
    planned: new Map(), teamOf: () => 'blue', ownProtection: () => [], detail: r => r?.detail || r, say2() {}, siteFailed() {} }
  const work = swarmTurnWork(sw)
  return { calls, holes, run: () => work.turnDig({ b, board, task, round: 1, context: { members }, m: { p: p(1.5, .5) } } as any) }
}

test('driver occupancy waits on the actual remaining lower layer, rather than the original feetY', async () => {
  const f = driver(true); await f.run()
  assert.deepEqual(f.calls.filter(c => c.method === 'swarm_work').map(c => c.params.at.y), [119], 'already clear top can be checked, but not the occupied obsidian below')
  assert.equal(f.holes.length, 0)
})

test('driver never centers a lower stand supported by a peer\'s remaining dig layer', async () => {
  const f = driver(false, true); await f.run()
  assert.equal(f.calls.some(c => c.method === 'center_in'), false)
  assert.equal(f.calls.some(c => c.method === 'swarm_work'), false)
})

test('driver completes the lower layer while keeping the original hole coordinates and depth', async () => {
  const f = driver(); await f.run()
  assert.deepEqual(f.calls.filter(c => c.method === 'swarm_work').map(c => c.params.at.y), [119, 118])
  assert.equal(f.holes.length, 1)
  assert.equal(key(f.holes[0]), '0,119,0')
  assert.equal(f.holes[0].bottomY, 118)
  assert.equal(f.holes[0].feetY, 120)
})

test('the existing native body sees obsidian from the lower neighbor and still refuses its visible ally support', async () => {
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const bot: any = Object.assign(new EventEmitter(), { registry, version: '1.21.11', health: 20, _client: new EventEmitter(),
    entity: { id: 1, position: new Vec3(1.5, 119, .5), velocity: new Vec3(0, 0, 0), height: 1.8, width: .6, metadata: [], yaw: 0, pitch: 0 },
    blockAt(q) { const b = Block.fromStateId(registry.blocksByName[q.y === 118 ? 'obsidian' : 'air'].defaultState); b.position = q.floored(); return b } })
  const ally: any = { id: 2, username: 'Ally', name: 'player', type: 'player', isValid: true, position: new Vec3(.5, 119, .5), height: 1.8, width: .6, metadata: [] }
  Object.defineProperty(ally.metadata, 9, { get() { throw new Error('exact player HP is not a support input') } })
  bot.entities = { 2: ally }
  const at = new Vec3(0, 118, 0)
  const reply = await swarmWork({ bot }, null, { kind: 'dig', at, undermine: true, allies: ['Ally'] })
  assert.equal(reply.why, 'allied_support')
  ally.position.x = 3.5
  assert.ok(faceAim(bot, at, new Vec3(0, 1, 0)), 'the genuine lower top face is visible after the ally moves away')
})
