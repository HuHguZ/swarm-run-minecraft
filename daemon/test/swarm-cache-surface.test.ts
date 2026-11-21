import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { swarmCaches } from '../../farm/swarm/swarm-driver/caches'
import { generate } from '../arena/colosseum-arms'
import { swarmMethods } from '../src/rpc/swarm'
import { chestTake } from '../src/containers/chest'
import { blockSeen } from '../src/pick'
import { createTickPlugins } from '../src/tick-plugins'
import { castRays, pieCounts } from '../src/swarm/cache-model'
import { testBot, testClock } from './tick-plugins-fixture'

const registry = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')(registry), Item = require('prismarine-item')(registry)
const windows = require('prismarine-windows')(registry)
const next = () => new Promise<void>(resolve => setImmediate(resolve))

// Only the server knows the layout and inventory. Mining, ray picks, menus and clicks are native.
for (const outcome of ['loot', 'empty test pit', 'lost footing', 'damage', 'enemy after cut', 'floor after cut', 'own footing']) {
  test('selected field probe on team1 sand: ' + outcome, async t => {
    const layout = generate('team1'), buried = layout.chests.find(c => c.kind === 'under')
    const mapEnv = process.env.ARMS_MAP, memoryEnv = process.env.ARMS_CACHE_MEMORY
    process.env.ARMS_MAP = 'colosseum'; process.env.ARMS_CACHE_MEMORY = '0'
    t.after(() => {
      if (mapEnv === undefined) delete process.env.ARMS_MAP; else process.env.ARMS_MAP = mapEnv
      if (memoryEnv === undefined) delete process.env.ARMS_CACHE_MEMORY; else process.env.ARMS_CACHE_MEMORY = memoryEnv
    })
    const bottom = new Vec3(600 + buried.x, 120 + buried.y, 600 + buried.z)
    const cap = bottom.offset(0, 1, 0), stand = cap.offset(-1, 1, 0), feet = stand.offset(.5, 0, .5)
    assert.equal(buried.cover[0].block, 'sand')
    assert.ok(!layout.field.some(([x, y, z]) => x === buried.x - 1 && z === buried.z && y >= -1))
    const bot = testBot(), clock = testClock(), changed = new Map<string, string>()
    for (const [x,y,z,b] of [...layout.field,...layout.set]) {
      if (Math.abs(x-buried.x) <= 12 && Math.abs(z-buried.z) <= 12) {
        changed.set(new Vec3(600+x,120+y,600+z).toString(), String(b).split(/[\[{]/)[0])
      }
    }
    if (outcome === 'empty test pit') changed.set(bottom.toString(), 'sandstone')
    const mined: number[] = [], opens: Vec3[] = [], clicks: any[] = [], calls: string[] = []
    const server = windows.createWindow(1, 'minecraft:generic_9x3', 'chest')
    server.updateSlot(0, new Item(registry.itemsByName.diamond.id, 3))
    bot.entity.position = outcome === 'own footing' ? cap.offset(.5, 1, .5) : feet.clone()
    bot.game.height = 384; bot.game.dimension = 'overworld'; bot.health = 20; bot.food = 20
    bot.blockAt = v => {
      const p = v.floored(), name = changed.get(p.toString()) ?? (p.equals(bottom) && outcome !== 'empty test pit'
        ? 'chest' : p.y === 119 ? 'sand' : p.y < 119 ? 'sandstone' : 'air')
      const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0); block.position = p; return block
    }
    bot.world = { getBlock: p => bot.blockAt(p), raycast: require('prismarine-world/src/worldsync').prototype.raycast }
    bot.pathfinder = { setGoal() {} }; bot.lookAt = async () => {}; bot.setControlState = bot.clearControlStates = () => {}
    bot._client.write = (name, packet) => {
      if (name === 'block_dig') {
        assert.ok(packet.location.equals(cap), 'only the sand lid may be mined')
        mined.push(packet.status)
        if (packet.status === 2) {
          changed.set(cap.toString(), 'air')
          bot._client.emit('block_change', { location: cap, type: registry.blocksByName.air.defaultState })
          if (outcome === 'floor after cut') changed.set(stand.offset(0,-1,0).toString(), 'air')
          if (outcome === 'enemy after cut') {
            bot.entities[7] = { id: 7, name: 'player', username: 'Rival', type: 'player', height: 1.8, width: .6,
              equipment: [], metadata: [], position: feet.offset(-1,0,0), velocity: new Vec3(0,0,0) }
          }
        }
      } else if (name === 'block_place') {
        opens.push(packet.location)
        assert.ok(packet.location.equals(bottom) && blockSeen(bot, bottom, { range: 4.5 }))
        setImmediate(() => {
          bot._client.emit('open_window', { windowId: 1, inventoryType: 'minecraft:generic_9x3', windowTitle: 'chest' })
          bot._client.emit('window_items', { windowId: 1, stateId: 2, items: server.slots.map(Item.toNotch), carriedItem: Item.toNotch(null) })
        })
      } else if (name === 'window_click') { clicks.push(packet); server.acceptClick({ ...packet, item: server.slots[packet.slot] }) }
    }
    const plugins = createTickPlugins(clock).plugins
    plugins.inventory(bot, { hideErrors: true })
    require('mineflayer/lib/plugins/chest')(bot)
    plugins.digging(bot)
    t.after(() => bot.emit('end'))
    const ctl = { aborted: false, onAbort: [] }
    const session: any = { bot, mcData: registry, require: () => bot, immediate: fn => fn(), runIntent: (_k, fn) => fn(ctl) }
    const methods = swarmMethods({ session } as any)
    const arena = { x: 600, y: 120, z: 600, r: 64, killY: 98, minY: 119 }
    const pos = { Miner: { p: bot.entity.position.clone(), hp: 20, inv: { iron_pickaxe: 1 } } }
    const b = { name: 'Miner', c: { call: async (m, p) => {
      calls.push(m)
      if (m === 'swarm_work' || m === 'swarm_pose') return { status: 'done', detail: await methods[m](p) }
      if (m === 'chest_take') { assert.equal(p.stay, true); assert.equal(p.visibleOnly, true); return { status: 'done', detail: await chestTake(session, ctl, p) } }
      if (m === 'status') return { state: { inventory: { iron_pickaxe: 1, diamond: bot.inventory.count(registry.itemsByName.diamond.id, null) } } }
      return { status: 'done', detail: {} }
    } } }
    const board = { enemies: () => [], recordFact() {} }
    const work = swarmCaches({ arms: true, arena, bots: [b], pos, now: () => 21000, generation: 1, alive: () => true,
      teamOf: () => 'blue', boardOf: () => board, lootArena: () => arena, detail: r => r?.detail || {},
      go: async () => { calls.push('goto'); return { status: 'interrupted' } }, log() {}, placed: new Map(), blocked: () => false, failed() {} } as any)
    const model = work.cacheModelOf(b)
    if (outcome === 'loot') {
      const loaded = layout.chests.map(c => new Vec3(600 + c.x, 120 + c.y, 600 + c.z))
      for (const [i, [dx,dz]] of [[-3,-1],[1,3],[3,-2]].entries()) {
        const eye = feet.offset(1+dx,1.62,dz), n = 700, spin = .16 + i / 10, range = 8
        const opaque = (x,y,z) => {
          const name=changed.get(new Vec3(x,y,z).toString()) ?? (y===119?'sand':y<119?'sandstone':'air')
          return name === 'air' || registry.blocksByName[name]?.transparent ? 0 : 1
        }
        model.addScan({ eye, n, spin, range, hits: castRays(eye, opaque, n, spin, range),
          pie: { step: 5, range, bins: pieCounts(eye, loaded, 5, range) } })
      }
      model.markWalked(feet)
      assert.equal(model.known.size, 0, 'the team has only bearings and surface hits')
    } else {
      // Hold the already selected cap fixed while changing the physical result or disrupting the swing.
      model.planSurface = () => ({ from: stand, to: bottom, surface: cap, gain: 1, rate: 1, cost: 1, cells: 1, exposed: [] })
    }
    assert.equal(blockSeen(bot, bottom, { range: 4.5 }), false, 'the full sand block hides the chest')
    let finished = false, disturbed = false
    const run = work.cacheTurn(b, board).finally(() => { finished = true })
    for (let n = 0; n < 25 && !finished; n++) {
      await next()
      if (!disturbed && mined.includes(0)) {
        disturbed = true
        if (outcome === 'lost footing') changed.set(stand.offset(0, -1, 0).toString(), 'air')
        if (outcome === 'damage') { bot.health -= 4; bot.emit('health') }
      }
      bot.emit('physicsTick'); await clock.advanceGame(50)
    }
    await run
    if (outcome === 'loot' || outcome === 'empty test pit' || outcome.endsWith('after cut')) {
      assert.deepEqual(mined, [0, 2], JSON.stringify(calls))
      assert.deepEqual(bot.entity.position, feet)
      if (outcome === 'loot') {
        assert.deepEqual(opens, [bottom]); assert.ok(clicks.length > 0)
        assert.equal(server.containerCount(registry.itemsByName.diamond.id, null), 0)
        assert.equal(bot.inventory.count(registry.itemsByName.diamond.id, null), 3)
      } else assert.equal(opens.length, 0)
    } else {
      assert.equal(mined.includes(2), false); assert.equal(opens.length, 0)
      if (outcome === 'own footing') assert.equal(mined.length, 0)
      else assert.deepEqual(mined, [0, 1])
    }
  })
}
