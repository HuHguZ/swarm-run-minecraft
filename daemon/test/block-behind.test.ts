import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { testBot, block, data } from './tick-plugins-fixture'
import { native, drive } from './parkour-fixture'
import * as clock from '../src/game-clock'
import { terrainCoverMethods } from '../src/rpc/terrain-cover'
import { flee } from '../src/session/combat'
import { seesPlayer } from '../src/pvp/last-seen'
import { pickFiller } from '../src/build'

const faces = [[0,-1,0],[0,1,0],[0,0,-1],[0,0,1],[-1,0,0],[1,0,0]].map(([x,y,z]) => new Vec3(x,y,z))
function tunnel(roof = true) {
  const bot = testBot(), changed = new Map<string, string>()
  bot.username = 'Runner'; bot.health = 20; bot.food = 20
  bot.jumpTicks = 0; bot.jumpQueued = false; bot.fireworkRocketDuration = 0
  Object.assign(bot.entity, { name: 'player', width: .6, metadata: [], position: new Vec3(.5,64,.5) })
  bot.blockAt = p => {
    const c = p.floored(), solid = c.y === 63 || roof && c.y === 66 || Math.abs(c.z) === 1 && c.y >= 64 && c.y <= 65
    return block(changed.get(c.toString()) ?? (solid ? 'stone' : 'air'), c)
  }
  bot.world = { getBlock: bot.blockAt, raycast: require('prismarine-world/src/worldsync').prototype.raycast }
  bot.physics = native.Physics(bot.registry, bot.world); drive(bot, bot.world)
  const player = (id, username, x) => ({ id, username, name: 'player', type: 'player', width: .6, height: 1.8,
    position: new Vec3(x,64,.5), velocity: new Vec3(-.25,0,0), yaw: Math.PI / 2, onGround: true, metadata: [], equipment: [] })
  const foe = player(2,'Pursuer',6.5), ally = player(3,'Tail',-1.5)
  bot.players = { Pursuer: { entity: foe }, Tail: { entity: ally } }; bot.entities = { 2: foe, 3: ally }
  bot._ndSwarmAllies = ['Tail']
  bot.heldItem = { name: 'cobblestone', count: 16, type: data.itemsByName.cobblestone.id }; bot.inventory.slots[36] = bot.heldItem
  bot.equip = async it => { bot.heldItem = it }
  const hooks = { aim() {} }, placed: Vec3[] = []
  bot.lookAt = async () => { hooks.aim() }
  require('mineflayer/lib/plugins/generic_place')(bot); require('mineflayer/lib/plugins/place_block')(bot)
  bot._client.write = (name, p) => {
    if (name !== 'block_place') return
    const c = p.location.plus(faces[p.direction]); placed.push(c)
    changed.set(c.toString(),bot.heldItem.name)
    bot._client.emit('block_change',{ location: c, type: bot.blockAt(c).stateId })
  }
  const ctl = { aborted: false, onAbort: [] }
  const session = { bot, require: () => bot, immediate: fn => fn(), runIntent: (_name, fn) => fn(ctl) }
  const run = () => terrainCoverMethods({ session } as any).block_behind({ from: 'Pursuer' })
  return { bot, foe, ally, placed, hooks, changed, session, run, ctl }
}

test('rear barrier waits for the last visible teammate to cross the doorway', async () => {
  const f = tunnel(); f.ally.position.x = 3.5
  assert.ok(seesPlayer(f.bot,f.ally) && seesPlayer(f.bot,f.foe))
  assert.equal((await f.run()).ok, false)
  assert.equal(f.placed.length,0)
  f.ally.position.x = -1.5
  assert.equal((await f.run()).ok,true)
  assert.deepEqual(f.placed[0], new Vec3(1,64,0))
})

async function retreat(f: ReturnType<typeof tunnel>) {
  const game = clock.activate(new clock.GameClock({ manual: true }))
  let done = false
  const run = flee.call(f.session, { from: ['Pursuer'], timeoutSeconds: 1, arena: { x: 0, z: 0, r: 24, killY: 60 } }).finally(() => { done = true })
  try {
    for (let i = 0; i < 24 && !done; i++) {
      await new Promise<void>(resolve => setImmediate(resolve))
      if (done) break
      const st = new native.PlayerState(f.bot, f.bot.controlState)
      f.bot.physics.simulatePlayer(st, f.bot.world); st.apply(f.bot)
      game.advanceTicks(1); f.bot.emit('physicsTick')
    }
    assert.ok(done)
    return await run
  } finally {
    f.ctl.aborted = true; for (const cancel of f.ctl.onAbort) cancel()
    game.advanceTicks(100); await run; game.dispose(); clock.activate(null)
  }
}

function sprintThrough(f: ReturnType<typeof tunnel>, jump: boolean) {
  const st = new native.PlayerState(f.bot, { ...f.bot.controlState, forward: true, sprint: true, jump })
  st.pos = new Vec3(6.5, 64, .5); st.vel = new Vec3(-.25, -.0784, 0); st.yaw = Math.PI / 2
  for (let i = 0; i < 42; i++) f.bot.physics.simulatePlayer(st, f.bot.world)
  return st.pos.x
}

for (const scenario of ['open choke', 'sand and quartz', 'one low wall', 'falling block', 'teammate', 'wall removed during aim', 'no receipt']) {
  test(`a normal retreat through a roofless passage: ${scenario}`, async t => {
    const f = tunnel(false)
    const highSide = new Vec3(1,65,1).toString()
    if (scenario === 'one low wall') for (let x = -10; x <= 10; x++) f.changed.set(new Vec3(x,65,1).toString(), 'air')
    if (scenario === 'falling block' || scenario === 'sand and quartz') {
      const old = process.env.ND_SCAFFOLD_ANY; process.env.ND_SCAFFOLD_ANY = '1'
      t.after(() => { if (old == null) delete process.env.ND_SCAFFOLD_ANY; else process.env.ND_SCAFFOLD_ANY = old })
      f.bot.heldItem = { name: 'sand', count: 16, type: data.itemsByName.sand.id }; f.bot.inventory.slots[36] = f.bot.heldItem
      if (scenario === 'sand and quartz') f.bot.inventory.slots[37] = { name: 'smooth_quartz', count: 1, type: data.itemsByName.smooth_quartz.id }
    }
    if (scenario === 'teammate') f.ally.position.x = 3.5
    if (scenario === 'wall removed during aim') f.hooks.aim = () => { f.changed.set(highSide, 'air') }
    if (scenario === 'no receipt') {
      f.bot._client.write = (name, p) => { if (name === 'block_place') f.placed.push(p.location.plus(faces[p.direction])) }
      t.after(() => f.bot.emit(`blockUpdate:${new Vec3(1,65,0)}`, null, null)) // unload the fake world after the skill returned
    }
    f.foe.equipment[0] = { name: 'netherite_sword' }
    const openX = sprintThrough(f, true)
    assert.ok(openX < 1, 'the jumping chaser can cross the original doorway')
    const result = await retreat(f)
    if (scenario === 'open choke' || scenario === 'sand and quartz') {
      assert.deepEqual(f.placed, [new Vec3(1,65,0)])
      assert.equal(result.rearBarrier, 'стена 1')
      assert.equal(f.bot.blockAt(new Vec3(1,65,0)).name, scenario === 'sand and quartz' ? 'smooth_quartz' : 'cobblestone')
      const runX = sprintThrough(f, false), jumpX = sprintThrough(f, true)
      assert.ok(runX >= 2.29 && jumpX >= 2.29, 'walking and jumping bodies stop at the new block')
      if (scenario === 'open choke') t.diagnostic(`42 chase ticks, open x=${openX.toFixed(2)}, closed sprint x=${runX.toFixed(2)}, jump x=${jumpX.toFixed(2)}, runner x=${f.bot.entity.position.x.toFixed(2)}`)
    } else {
      assert.deepEqual(f.placed, scenario === 'no receipt' ? [new Vec3(1,65,0)] : [])
      assert.equal(result.rearBarrier, undefined)
      if (scenario === 'falling block') assert.equal(pickFiller(f.bot, { steady: true }), null)
      assert.ok(f.bot.entity.position.x < (scenario === 'no receipt' ? -.8 : -2), 'refused or unconfirmed work releases movement')
      if (scenario === 'no receipt') t.diagnostic(`unconfirmed placement, runner x=${f.bot.entity.position.x.toFixed(2)}`)
    }
  })
}

test('rear barrier ignores a pursuer behind a solid wall and rechecks an ally during aim', async () => {
  const f = tunnel()
  for (const y of [64,65]) f.changed.set(new Vec3(4,y,0).toString(),'stone')
  assert.equal(seesPlayer(f.bot,f.foe),false)
  assert.equal((await f.run()).ok,false); assert.equal(f.placed.length,0)
  f.changed.clear(); f.hooks.aim = () => { f.ally.position.x = 3.5 }
  assert.equal((await f.run()).ok,false); assert.equal(f.placed.length,0)
})

test('the runner keeps the only exit open at a drop and keeps moving against a spear already in reach', async () => {
  const f = tunnel()
  f.changed.set(new Vec3(-1,63,0).toString(), 'air')
  assert.equal((await f.run()).ok,false)
  f.changed.clear(); f.foe.equipment[0] = { name: 'iron_spear' }; f.foe.position.x = 4.9
  assert.equal((await f.run()).ok,false)
  assert.equal(f.placed.length,0)
})

test('a supporting face removed while aiming receives no placement packet', async () => {
  const f = tunnel()
  f.hooks.aim = () => { f.changed.set(new Vec3(1,63,0).toString(), 'air') }
  assert.equal((await f.run()).ok,false)
  assert.equal(f.placed.length,0)
})

for (const [scenario, title] of [
  ['chase', 'normal flee places one block under the low ceiling and sprints on down the clear tunnel'],
  ['slow', 'a delayed equip cannot spend the block after the runner resumes'],
  ['leaving', 'normal retreat conserves the block when the opponent is already running away']
]) test(title, async () => {
  const f = tunnel()
  if (scenario === 'leaving') f.foe.velocity.x = .25
  if (scenario === 'slow') {
    f.bot.heldItem = { name: 'stick', type: data.itemsByName.stick.id }
    f.bot.equip = async it => { await clock.sleep(650); f.bot.heldItem = it }
  }
  const result = await retreat(f)
  assert.equal(result.rearBarrier, scenario === 'chase' ? 'стена 1' : undefined)
  assert.deepEqual(f.placed,scenario === 'chase' ? [new Vec3(1,64,0)] : [])
  assert.ok(f.bot.entity.position.x < (scenario === 'slow' ? -.8 : -2) && f.bot.entity.position.y === 64)
})
