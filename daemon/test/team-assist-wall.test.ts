import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { block, data, testBot } from './tick-plugins-fixture'
import { assist } from '../src/pvp/team-assist'
import { aim, blockedAt } from '../src/bow/ballistics'
import { seesPlayer } from '../src/pvp/last-seen'
import { EventBus } from '../src/events'
import { swarmMethods } from '../src/rpc/swarm'
import { runIntent } from '../src/session/intent-runner'

const faces = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]].map(([x, y, z]) => new Vec3(x, y, z))
const xyz = (p: { x: number, y: number, z: number }) => [p.x, p.y, p.z]

function wallScene(shooterY = 64) {
  const bot = testBot(), cells = new Map<string, ReturnType<typeof block>>()
  Object.assign(bot.entity, { position: new Vec3(1.5, 64, 3.3), name: 'player', type: 'player', width: .6, metadata: [] })
  bot.username = 'Builder'; bot.health = 20
  bot.blockAt = p => cells.get(p.floored().toString()) ?? block(p.y < 64 ? 'stone' : 'air', p)
  bot.world = { getBlock: bot.blockAt, raycast: require('prismarine-world/src/worldsync').prototype.raycast }
  bot.pathfinder = { setGoal() {} }
  const stock = { name: 'cobblestone', slot: 36, count: 64, type: data.itemsByName.cobblestone.id }
  bot.inventory.slots[36] = stock; bot.heldItem = stock; bot.equip = async it => { bot.heldItem = it }
  bot.waitForTicks = async () => {}; bot.setControlState = () => {}; bot.clearControlStates = () => {}
  const player = (id: number, username: string, x: number) => ({
    id, name: 'player', username, type: 'player', isValid: true, width: .6, height: 1.8,
    position: new Vec3(x, 64, .5), velocity: new Vec3(0, 0, 0), yaw: Math.PI / 2, pitch: 0,
    onGround: true, metadata: [], equipment: []
  })
  const ward = player(2, 'Ward', .5), bow = player(3, 'Bow', 10.5)
  bow.position.y = shooterY
  const flags = data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  bow.equipment[0] = { name: 'bow' }; bow.metadata[flags] = 1
  bot.players = { Ward: { entity: ward }, Bow: { entity: bow } }; bot.entities = { 2: ward, 3: bow }
  const from = bow.position.offset(0, 1.52, 0), shot = aim(from, () => ward.position.offset(0, 1.12, 0))
  bow.pitch = shot.pitch
  // With no custom matcher prismarine-world intersects the segment with the block's actual shapes.
  const shotWorld = { raycast: (origin, dir, reach) => bot.world.raycast(origin, dir, reach) }
  const arrowBlock = () => blockedAt({ world: shotWorld }, from, shot)
  require('mineflayer/lib/plugins/generic_place')(bot)
  require('mineflayer/lib/plugins/place_block')(bot)
  const packets: Vec3[] = [], receiptHits: Array<Vec3 | null> = []
  const ctl = { aborted: false, onAbort: [] as Array<() => void> }
  const hooks = { acknowledge: true, afterReceipt: () => {}, beforeAim: () => {} }
  bot.lookAt = async () => { hooks.beforeAim() }
  const put = (name: string, p: Vec3) => { const b = block(name, p); cells.set(p.toString(), b); return b }
  const write = bot._client.write
  bot._client.write = (name, p) => {
    write(name, p)
    if (name !== 'block_place') return
    const at = p.location.plus(faces[p.direction])
    packets.push(at)
    const placed = put('cobblestone', at)
    if (hooks.acknowledge) bot._client.emit('block_change', { location: at, type: placed.stateId })
    receiptHits.push(arrowBlock()); hooks.afterReceipt()
  }
  const session = { require: () => bot, bot }
  const run = () => assist(session, { mode: 'wall', whileDraw: true, ally: 'Ward', foe: 'Bow', allies: ['Ward'] }, ctl) as Promise<any>
  return { bot, ward, bow, flags, ctl, hooks, put, packets, receiptHits, run, arrowBlock }
}

test('an archer fires along an open lane until the helper confirms the upper block', async () => {
  const f = wallScene()
  assert.equal(f.arrowBlock(), null)
  const result = await f.run()
  assert.equal(result.ok, true, result.why)
  assert.equal(result.placed, 2)
  assert.deepEqual(result.cells.map(xyz), f.packets.map(xyz))
  const [base, upper] = f.packets
  assert.equal(base.y, 64); assert.ok(base.x === 1 || base.x === 2); assert.equal(base.z, 0)
  assert.deepEqual(upper, base.offset(0, 1, 0))
  assert.equal(f.receiptHits[0], null, 'a foot block alone does not cover the patient')
  assert.deepEqual(f.receiptHits[1], upper, 'the real arrow hits the new chest-height collision')
})

test('a visible side face covers the shot with a single block', async () => {
  const f = wallScene()
  f.put('stone', new Vec3(1, 65, -1))
  assert.equal(f.arrowBlock(), null)
  const result = await f.run()
  assert.equal(result.ok, true, result.why)
  assert.equal(result.placed, 1)
  assert.deepEqual(f.packets.map(xyz), [[1, 65, 0]])
  assert.deepEqual(f.arrowBlock(), f.packets[0])
})

test('an existing screen farther up the shot already protects the ally', async () => {
  const f = wallScene()
  for (let y = 64; y <= 66; y++) f.put('stone', new Vec3(6, y, 0))
  assert.ok(seesPlayer(f.bot, f.ward) && seesPlayer(f.bot, f.bow))
  assert.deepEqual(f.arrowBlock(), new Vec3(6, 65, 0))
  const result = await f.run()
  assert.equal(result.placed, 0)
  assert.deepEqual(f.packets, [])
})

test('an arrow from a higher shooter clears a visible bottom slab but strikes the newly confirmed screen', async () => {
  const f = wallScene(65), at = new Vec3(5, 65, 0)
  f.put('stone', new Vec3(10, 64, 0))
  f.put('stone', at)
  assert.deepEqual(f.arrowBlock(), at, 'the arrow visits the occupied voxel')
  const slab = f.put('stone_slab', at)
  assert.equal(slab.getProperties().type, 'bottom')
  assert.equal(f.arrowBlock(), null, 'the shape below the trajectory leaves a clear lane')
  const result = await f.run()
  assert.equal(result.ok, true, result.why)
  assert.deepEqual(f.arrowBlock(), f.packets.at(-1))
  assert.deepEqual(result.cells.map(xyz), f.packets.map(xyz))
})

for (const why of ['hidden', 'relaxed']) test('the helper conserves blocks when the archer is ' + why, async () => {
  const f = wallScene()
  if (why === 'relaxed') f.bow.metadata[f.flags] = 0
  else {
    for (let y = 64; y < 68; y++) for (let z = 1; z < 4; z++) f.put('stone', new Vec3(5, y, z))
    assert.equal(seesPlayer(f.bot, f.bow), false, 'the flank wall hides the shooter only from the builder')
  }
  assert.equal(f.arrowBlock(), null)
  const result = await f.run()
  assert.equal(result.ok, false, result.why)
  assert.deepEqual(f.packets, [])
})

for (const change of ['sidestep', 'cancel']) test('a support receipt survives a ' + change + ' before the second click', async () => {
  const f = wallScene()
  if (change === 'sidestep') f.hooks.afterReceipt = () => { f.ward.position.z += 4 }
  else f.hooks.beforeAim = () => {
    if (f.packets.length === 1) { f.ctl.aborted = true; for (const cancel of [...f.ctl.onAbort]) cancel() }
  }
  const result = await f.run()
  assert.equal(f.packets.length, 1)
  assert.equal(f.packets[0].y, 64)
  assert.equal(result.placed, 1)
  assert.deepEqual(result.cells.map(xyz), f.packets.map(xyz))
})

test('a client-side block appearance without a server receipt does not authorize building on it', async () => {
  const f = wallScene()
  f.hooks.acknowledge = false
  const result = await f.run()
  assert.equal(result.ok, false, result.why)
  assert.equal(result.placed, 0)
  assert.deepEqual(result.cells, [])
  assert.ok(f.packets.length > 0 && f.packets.every(p => p.y === 64))
})

test('the carrier keeps the patient’s only walkable exit open before placing a support', async () => {
  const f = wallScene(), original = f.bot.blockAt
  f.bot.blockAt = p => {
    const at = p.floored()
    const walkway = at.z === 0 && at.x >= 0
    const builder = at.x === 1 && at.z === 3
    return at.y < 64 && !walkway && !builder ? block('air', at) : original(p)
  }
  f.bot.world.getBlock = f.bot.blockAt
  const result = await f.run()
  assert.equal(result.ok, false)
  assert.deepEqual(f.packets, [], 'do not spend the support for a wall that would trap the patient')
})

test('an interrupted assist RPC returns the confirmed support to the team', async () => {
  const f = wallScene()
  const session: any = { bot: f.bot, require: () => f.bot, runIntent, cancel() {}, state: () => ({}), bus: new EventBus() }
  f.hooks.beforeAim = () => { if (f.packets.length) session.current.ctl.abort() }
  const answer: any = await swarmMethods({ session } as any).assist({ mode: 'wall', whileDraw: true, ally: 'Ward', foe: 'Bow', allies: ['Ward'] })
  assert.equal(answer.status, 'interrupted')
  assert.equal(answer.partial, true)
  assert.equal(f.packets.length, 1)
  assert.deepEqual(answer.detail.cells.map(xyz), f.packets.map(xyz))
  assert.equal(session.current, null)
})
