import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
const { Vec3 } = require('vec3')
const clock = require('../src/game-clock')
const combat = require('../src/combat')
const bow = require('../src/bow')
const pick = require('../src/pick')
const tempo = require('../src/tempo')

function scene(t, { distance = 4.3, wallHeight = 1, hand = 'diamond_sword', screen = false, onTick = null }: any = {}) {
  const time = new clock.GameClock({ manual: true, epoch: 10000 }); clock.activate(time)
  t.mock.method(Math, 'random', () => .5)
  t.mock.method(console, 'log', () => {})
  const bot: any = new EventEmitter(); bot.setMaxListeners(100)
  const data = require('minecraft-data')('1.21.11')
  const Item = require('prismarine-item')('1.21.11')
  const Block = require('prismarine-block')('1.21.11')
  bot._client = new EventEmitter(); bot._client.state = 'play'
  const packets: any[] = []
  bot._client.write = (name, packet) => packets.push({ name, ...packet })
  bot.registry = data; bot.version = '1.21.11'; bot.game = { gameMode: 'survival', difficulty: 'normal' }
  bot.username = 'NeuroDown'; bot.health = 20; bot.food = 20; bot.foodSaturation = 5
  bot.entity = { id: 1, type: 'player', username: bot.username, position: new Vec3(.5, 0, .5), velocity: new Vec3(0, 0, 0),
    onGround: true, yaw: -Math.PI / 2, pitch: 0, height: 1.8, width: .6, eyeHeight: 1.62, metadata: [], effects: {} }
  const foe = { id: 2, type: 'player', name: 'player', username: 'Foe', uuid: 'foe', isValid: true,
    position: new Vec3(.5 + distance, 0, .5), velocity: new Vec3(0, 0, 0), onGround: true,
    yaw: Math.PI / 2, pitch: 0, height: 1.8, width: .6, equipment: [], metadata: [], effects: {} }
  bot.entities = { 1: bot.entity, 2: foe }; bot.players = { Foe: { entity: foe } }
  if (hand) foe.equipment[0] = new Item(data.itemsByName[hand].id, 1)
  bot.blockAt = p => {
    p = p.floored()
    const wall = p.x === 1 && p.y < (typeof wallHeight === 'function' ? wallHeight() : wallHeight) && Math.abs(p.z) <= 1
    const lowRoof = p.x === 0 && p.y === 2 && Math.abs(p.z) <= 1
    const name = p.y < 0 ? 'stone' : wall || lowRoof ? 'bedrock' : (typeof screen === 'function' ? screen() : screen) && p.x === 2 && p.y === 1 ? 'glass' : 'air'
    const b = Block.fromStateId(data.blocksByName[name].defaultState, 0); b.position = p; return b
  }
  bot.world = { getBlock: p => bot.blockAt(p), raycast(from, direction, length) {
    const hit = pick.blockOnRay(bot, from, direction, length)
    return hit && { ...hit.block, position: hit.pos, intersect: from.plus(direction.scaled(hit.t)) }
  } }
  const slots = Array(46).fill(null)
  for (const [n, name] of ['diamond_sword', 'bow', 'arrow'].entries()) {
    const it = new Item(data.itemsByName[name].id, name === 'arrow' ? 64 : 1); it.slot = 36 + n; slots[it.slot] = it
  }
  bot.inventory = { slots, items: () => slots.filter(Boolean) }
  bot.quickBarSlot = 0; bot.heldItem = slots[36]
  bot.setQuickBarSlot = n => { bot.quickBarSlot = n; bot.heldItem = slots[36 + n]; bot.emit('heldItemChanged') }
  bot.equip = async item => { bot.setQuickBarSlot(item.slot - 36) }
  bot.controlState = {}
  bot.setControlState = (key, value) => { bot.controlState[key] = value }
  bot.getControlState = key => !!bot.controlState[key]
  bot.clearControlStates = () => { for (const key of Object.keys(bot.controlState)) bot.setControlState(key, false) }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async p => { const d = p.minus(pick.eyeOf(bot)); await bot.look(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z))) }
  const useKey = data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  let drawing = false, draws = 0, releases = 0, paths = 0
  const drawAges: number[] = []
  bot.activateItem = () => {
    if (bot.heldItem?.name !== 'bow') return
    drawing = true; draws++; drawAges.push(age)
    bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: useKey, value: 1 }] })
  }
  bot.deactivateItem = () => {
    if (!drawing || bot.heldItem?.name !== 'bow') return
    drawing = false; releases++; bot._client.write('block_dig', { status: 5 })
    bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key: useKey, value: 0 }] })
  }
  bot.on('heldItemChanged', () => { drawing = false })
  bot.attack = () => {}; bot.swingArm = () => {}; bot.chat = () => {}; bot.findBlock = () => null
  bot.nearestEntity = predicate => Object.values(bot.entities).find(predicate)
  bot.pathfinder = new EventEmitter()
  Object.assign(bot.pathfinder, { movements: { blocksToAvoid: new Set(), exclusionAreasStep: [], exclusionAreasBreak: [], exclusionAreasPlace: [] },
    setGoal(goal) {
      this.goal = goal
      if (goal) { paths++; queueMicrotask(() => bot.emit('path_update', { status: 'noPath', path: [] })) }
    }, isMoving: () => false, isMining: () => false, isBuilding: () => false })
  const ctl = { aborted: false, onAbort: [] as Array<() => void>, abort() { if (this.aborted) return; this.aborted = true; for (const fn of this.onAbort) fn() } }
  const params = { target: 'Foe', allowPlayer: true, arena: { x: 0, y: 0, z: 0, r: 24 }, timeoutSeconds: 12, roundScope: 'close-bow' }
  const session: any = { bot, current: { name: 'fight', ctl, params }, state: () => ({ health: bot.health }),
    bus: { emit() {}, drain: () => [] }, movements: bot.pathfinder.movements, tactics: { snapshot: () => ({ threatLevel: 0 }) } }
  time.attach(bot)
  let age = 1000
  bot._client.emit('update_time', { age: BigInt(age) })
  const tick = async () => {
    time.advanceTicks(1); bot._client.emit('update_time', { age: BigInt(++age) })
    onTick?.({ bot, foe, ctl, paths, draws, releases, drawing, age, session })
    bot.emit('physicsTick'); bot.emit('physicTick'); bot.emit('ndMovementSent')
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const run = async () => {
    let done = false, result, error
    combat.fight(session, ctl, params).then(r => { result = r; done = true }, e => { error = e; done = true })
    for (let i = 0; i < 360 && !done; i++) await tick()
    assert.equal(done, true, 'bounded actual PvP loop must finish')
    if (error) throw error
    return { result, draws, releases, paths, packets, drawAges }
  }
  t.after(() => { ctl.abort(); bot.emit('end'); time.dispose() })
  return { bot, foe, run }
}

test('actual PvP uses a clear close bow shot after a failed route leaves melee unavailable', async t => {
  const f = scene(t)
  const eye = pick.eyeOf(f.bot).offset(0, -.1, 0)
  const aim = bow.aim(eye, () => f.foe.position.offset(0, .99, 0))
  assert.ok(aim)
  assert.equal(bow.blockedAt(f.bot, eye, aim), null, 'the low wall leaves the actual projectile trajectory clear')
  const out = await f.run()
  assert.ok(out.draws > 0, 'the observed obstacle already makes the direct melee approach unavailable')
  assert.ok(out.result.arrows > 0, JSON.stringify({ arrows: out.result.arrows, draws: out.draws, paths: out.paths, tricks: out.result.tricks }))
  assert.ok(out.releases > 0, 'the real bow executor releases a natively confirmed charge')
})

test('close bow keeps physical projectile clearance through a visible glass screen', async t => {
  const f = scene(t, { screen: true })
  const eye = pick.eyeOf(f.bot).offset(0, -.1, 0)
  const aim = bow.aim(eye, () => f.foe.position.offset(0, .99, 0))
  assert.equal(bow.blockedAt(f.bot, eye, aim)?.x, 2)
  const out = await f.run()
  assert.ok(out.paths > 0)
  assert.equal(out.releases, 0)
  assert.equal(out.result.arrows || 0, 0)
})

for (const [hand, shoot] of [['diamond_sword', false], [null, true]] as const) {
  test(`close bow prices recent damage against visible ${hand || 'empty hand'}`, async t => {
    const f = scene(t, { hand, onTick: ({ bot, age }) => {
      if (age % 10 === 0) { bot.health -= .1; bot.emit('entityHurt', bot.entity) }
    } })
    const out = await f.run()
    assert.equal(out.releases > 0, shoot)
  })
}

test('a visible approach during a close draw yields back to melee', async t => {
  let approached = false
  const f = scene(t, { onTick: ({ bot, foe, draws }) => {
    if (!draws) return
    approached = true
    foe.position.x = Math.max(2.4, foe.position.x - .28)
    bot.emit('entityMoved', foe)
  } })
  const out = await f.run()
  assert.equal(approached, true, 'the decision first accepted the stationary target')
  assert.equal(out.releases, 0, 'it cancels when the observed charge becomes expensive')
  assert.ok(out.result.swings > 0, 'the actual main loop resumes with a reachable melee attack')
})

test('abort stops a close draw before a charged shot and frees movement controls', async t => {
  const f = scene(t, { onTick: ({ ctl, draws }) => { if (draws) ctl.abort() } })
  const out = await f.run()
  assert.ok(out.draws > 0)
  assert.equal(out.result.arrows || 0, 0)
  assert.ok(Object.values(f.bot.controlState).every(v => !v))
})

test('the same actual bow fixture can release beyond the ordinary ranged threshold', async t => {
  const f = scene(t, { distance: 8 })
  const out = await f.run()
  assert.ok(out.result.arrows > 0)
  assert.ok(out.releases > 0)
})

test('opening rush does not become bow-first solely because three seconds passed', async t => {
  const f = scene(t, { distance: 8, wallHeight: 0 })
  t.mock.method(tempo, 'pickOpening', () => ({ kind: 'rush' }))
  const out = await f.run()
  assert.equal(out.draws, 0, 'safe opening approach still has no contact or physical reason to change intent')
})

test('a newly blocked opening approach can switch to bow without waiting out the rush', async t => {
  let blocked = false; let changed = 0
  const f = scene(t, { distance: 8, wallHeight: () => blocked ? 1 : 0, onTick: ({ age }) => {
    if (!blocked && age >= 1025) { blocked = true; changed = age }
  } })
  t.mock.method(tempo, 'pickOpening', () => ({ kind: 'rush' }))
  const out = await f.run()
  assert.ok(out.drawAges.length > 0)
  assert.ok(out.drawAges[0] <= changed + 3, `approach blocked at ${changed}, first draw ${out.drawAges[0]}`)
})

test('a clear projectile lane starts the next native draw without the blocked-shot penalty', async t => {
  let screen = true; let cleared = 0
  const f = scene(t, { distance: 8, screen: () => screen, onTick: ({ age, bot }) => {
    if (!screen || age < 1030) return
    screen = false; cleared = age
    bot.emit('blockUpdate', { position: new Vec3(2, 1, 0), name: 'glass' }, { position: new Vec3(2, 1, 0), name: 'air' })
  } })
  t.mock.method(tempo, 'pickOpening', () => ({ kind: 'bow' }))
  const out = await f.run()
  assert.ok(out.drawAges.length > 0)
  assert.ok(out.drawAges[0] <= cleared + 3, `clear at ${cleared}, first draw ${out.drawAges[0]}`)
})

function blockedBow(t) {
  let screen = true
  const f = scene(t, { distance: 8, screen: () => screen })
  const source = readFileSync(join(__dirname, '../src/pvp.ts'), 'utf8')
  const a = source.indexOf('  const cd = '); const b = source.indexOf('\n  let targetHurtAt', a)
  const c = source.indexOf('      if (shot.blocked) {'); const e = source.indexOf('      await holdWeapon()', c)
  const x = source.indexOf('      if (xb && xb.blocked)'); const xe = source.indexOf('\n', x)
  assert.ok(a > 0 && b > a && c > b && e > c)
  const ctx: any = { bot: f.bot, entity: f.foe, bowMod: bow, pick, ranged: require('../src/ranged'),
    prof: { player: true }, vision: { visible: () => true }, track: { vel: () => new Vec3(0, 0, 0) },
    BOW_DRAW_MS: bow.DRAW_MS, TICK_MS: 50, shot: { blocked: true }, st: {}, used() {},
    prepB: { drawMs: null }, gameClock: { now: () => ctx.now }, now: 1000,
    repositionUntil: 0, reposition: null }
  runInNewContext(`${source.slice(a, b)}\nglobalThis.block = () => { ${source.slice(c, e)} }; globalThis.blockX = () => { const xb = { blocked: true }; ${source.slice(x, xe)} }; globalThis.available = (kind = 'bow', point = null) => typeof shotReady === 'function' ? shotReady(kind, BOW_DRAW_MS, point) : ready(kind)`, ctx)
  return { ctx, clear: () => { screen = false } }
}

test('unchanged blocked bow lane stays blocked after sixty seconds', t => {
  const f = blockedBow(t); f.ctx.block(); f.ctx.now = 60000
  assert.equal(f.ctx.available(), false)
})

test('removing the actual bow obstruction permits retry at the same game time', t => {
  const f = blockedBow(t); f.ctx.block(); f.clear()
  assert.equal(f.ctx.available(), true)
})

test('blocked-shot history does not transfer to a new target', t => {
  const f = blockedBow(t); f.ctx.block(); f.ctx.entity.id = 3
  assert.equal(f.ctx.available(), true)
})

test('unchanged crossbow obstruction is not retried after the old fifteen-hundred-ms penalty', t => {
  const f = blockedBow(t); f.ctx.blockX(); f.ctx.now = 60000
  assert.equal(f.ctx.available('xbow'), false)
  f.clear()
  assert.equal(f.ctx.available('xbow'), true)
})

test('crossbow obstruction is checked against the currently planned aim point', t => {
  const f = blockedBow(t); f.ctx.blockX()
  const point = () => f.ctx.entity.position.offset(0, 6, 0)
  const speed = f.ctx.ranged.ARROW_SPEED; const from = pick.eyeOf(f.ctx.bot).offset(0, -.1, 0)
  const sol = bow.aim(from, point, speed, bow.GRAVITY)
  assert.ok(sol)
  assert.equal(bow.blockedAt(f.ctx.bot, from, sol, { x: 0, y: 0, z: 0 }, speed), null, 'the alternate physical lane is clear')
  assert.equal(f.ctx.available('xbow', point), true)
})


test('a real blocked approach selects the already clear close shot without aging blockedSince', async t => {
  const out = await scene(t).run()
  assert.ok(out.drawAges.length > 0)
  assert.ok(out.drawAges[0] < 1050, `first native draw at tick ${out.drawAges[0]}: no 2.5-second mode gate`)
})


function projectileTurn() {
  const source = readFileSync(join(__dirname, '../src/pvp.ts'), 'utf8')
  const after = source.indexOf('    const arrowIn = ')
  const start = source.indexOf('    const released = ', after) >= 0 ? source.indexOf('    const released = ', after) : source.indexOf('    if (sawRelease())', after)
  const end = source.indexOf('    if (myPit', start)
  assert.ok(start > after && end > start)
  const me = new Vec3(0, 0, 0), projectile = { id: 10, position: new Vec3(8, 1, 0) }
  const ctx: any = { bot: { entity: { position: me, yaw: 0 }, entities: { 10: projectile } }, me, inc: [],
    entity: { id: 2, position: new Vec3(8, 0, 0), yaw: Math.PI / 2 },
    prof: { player: true }, seesBody: true, r: 8, d: 8, FAR: 7, HIT_REACH: 2.9, now: 1000,
    dodgeKey: null, dodgeUntil: 0, dodgeLine: null, cbShieldUntil: 0, strafeKey: 'left', st: { dodges: 0 },
    sawRelease: () => false, stepSafe: () => true, keyDir: (_b, k) => k,
    threats: require('../src/threats'), foe: { aimedAtMe: () => null },
    read: { crossbowInfo: () => ({ loaded: false, piercing: false }) }, guard: { stats: { worn: true } },
    ready: () => true, rest() {}, used() {} }
  const nativeDodge = ctx.threats.dodgeKey
  ctx.threats = { dodgeKey: nativeDodge }
  runInNewContext(`globalThis.poll = () => { ${source.slice(start, end)}; return { shield: cbShield, active: !!dodgeKey && (dodgeLine ? true : now < dodgeUntil) } }`, ctx)
  const incoming = { name: 'arrow', entity: projectile, ticks: 8, vel: { x: -1, y: 0, z: 0 }, at: new Vec3(0, 1, 0) }
  return { ctx, incoming }
}

test('the same incoming projectile keeps its chosen dodge across the old expiration', () => {
  const { ctx, incoming } = projectileTurn(); ctx.inc = [incoming]
  ctx.poll(); assert.equal(ctx.st.dodges, 1)
  ctx.now += 60000
  assert.equal(ctx.poll().active, true)
  assert.equal(ctx.st.dodges, 1, 'one projectile must not resample a new dodge by age')
})

test('leaving the concrete projectile corridor ends dodge immediately', () => {
  const { ctx, incoming } = projectileTurn(); ctx.inc = [incoming]
  ctx.poll(); ctx.me.z = 2; ctx.inc = []
  assert.equal(ctx.poll().active, false)
})

test('shield remains useful against the released crossbow arrow after the crossbow is empty', () => {
  const { ctx, incoming } = projectileTurn(); ctx.inc = [incoming]
  assert.equal(ctx.poll().shield, true)
  ctx.inc = []; delete ctx.bot.entities[10]
  assert.equal(ctx.poll().shield, false)
})

test('ordinary far pursuit cannot bypass an unchanged rejected follow route', async t => {
  let closed = false
  const f = scene(t, { distance: 8, wallHeight: () => closed ? 3 : 1, onTick: ({ session }) => { if (session.tempo) closed = true } })
  f.bot.inventory.slots[37] = null; f.bot.inventory.slots[38] = null
  const out = await f.run()
  assert.equal(out.result.micro, true, 'the visible target was acquired before its approach closed')
  assert.equal(out.paths, 1, 'after noPath use another safe stance instead of installing the same GoalFollow again')
})
