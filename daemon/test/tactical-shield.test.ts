import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const Vec3 = require('vec3')
const clock = require('../src/game-clock')
const esbuild = require('../../node_modules/esbuild')

function sourceModule(name: string, overrides: Record<string, unknown> = {}, expose = '') {
  const file = path.resolve(__dirname, '../src', name + '.ts')
  const local = createRequire(file)
  const module = { exports: {} as Record<string, any> }
  const source = esbuild.transformSync(readFileSync(file, 'utf8') + expose, { loader: 'ts', format: 'cjs', target: 'node24' }).code
  vm.runInThisContext(require('node:module').wrap(source), { filename: file })(module.exports,
    (id: string) => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
  return module.exports
}

function actor() {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.version = '1.21.11'; bot.health = 20; bot.food = 20
  bot.registry = require('minecraft-data')('1.21.11')
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, width: .6,
    onGround: true, yaw: 0, pitch: 0, metadata: [], effects: {} }
  const key = bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  const shield = { name: 'shield', type: bot.registry.itemsByName.shield.id, count: 1 }
  const sword = { name: 'iron_sword', type: bot.registry.itemsByName.iron_sword.id, count: 1 }
  bot.inventory = new EventEmitter(); bot.inventory.slots = []; bot.inventory.slots[45] = shield
  bot.inventory.items = () => [sword]
  bot.heldItem = sword; bot.quickBarSlot = 0
  bot.entities = { 2: { id: 2, name: 'piglin_brute', position: new Vec3(.5, 64, 5.5),
    height: 1.95, width: .6, equipment: [], metadata: [], isValid: true } }
  bot.blockAt = (p: any) => ({ position: p.floored(), name: p.y < 64 ? 'stone' : 'air',
    boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.lookAt = async () => {}
  bot.clearControlStates = () => {}; bot.pathfinder = { setGoal: () => {} }
  const writes: Array<{ hand: boolean; at: number }> = []
  let releases = 0
  bot.activateItem = (off = false) => { writes.push({ hand: off, at: c.ticks }) }
  bot.deactivateItem = () => { releases++; metadata(0) }
  const metadata = (flags: number, id = 1) => {
    if (id === 1) bot.entity.metadata[key] = flags
    bot._client.emit('entity_metadata', { entityId: id, metadata: [{ key, value: flags }] })
  }
  c.attach(bot)
  const age = (n: number) => bot._client.emit('update_time', { age: BigInt(n) })
  age(1000)
  const session: any = { bot, current: null, bus: { emit: () => {} } }
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const fn of this.onAbort) fn() } }
  const bow = sourceModule('bow')
  const combat = sourceModule('combat', { './bow': bow })
  const tactics = sourceModule('tactics/minecraft', { '../combat': combat })
  return { c, bot, session, ctl, key, shield, metadata, age, bow, combat, tactics, writes,
    releases: () => releases, close() { bot.emit('end'); c.dispose() } }
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve))

test('Full40 Shield cannot complete after its old three-tick pulse', async () => {
  const a = actor()
  let result: any
  try {
    const system = new a.tactics.TacticalSystem(a.session)
    const pending = system.execute({ id: 'Shield', score: 80 }, a.ctl, a.tactics.observeTactics(a.session)).then((r: any) => { result = r })
    await turn(); a.metadata(3); a.age(1001)
    a.c.advanceTicks(3); await turn()
    assert.equal(result, undefined, 'three ticks never reach native BlocksAttacks.blockDelayTicks=5')
    assert.equal(a.releases(), 0, 'the actual protection is held while the native gate is pending')
    a.ctl.abort(); await pending
    assert.equal(a.releases(), 1)
  } finally { a.close() }
})

test('offhand self-use gate dates five ticks only after its own delayed ACK and a later native age', () => {
  const a = actor()
  const use = a.bow.observeCharge(a.bot, { item: 'shield', hand: 'off-hand' })
  try {
    assert.equal(use.start(), true)
    assert.equal(a.writes[0].hand, true)
    a.age(1040); a.c.advanceTicks(50)
    a.metadata(3, 2); a.metadata(1)
    assert.equal(use.ready(5), false, 'other entity and main-hand metadata do not acknowledge the shield')
    a.metadata(3); a.age(1050); a.age(1053)
    assert.equal(use.ready(5), false)
    a.age(1055)
    assert.equal(use.ready(5), true)
    assert.equal(use.snapshot().confirmedTicks, 5)
    a.bot.quickBarSlot = 1
    assert.equal(use.ready(5), true, 'a passive main-hand slot change does not replace the offhand shield')
    a.bot.inventory.slots[45] = null; a.bot.inventory.emit('updateSlot', 45)
    assert.equal(use.ready(5), false)
  } finally { use.close(); a.close() }
})

test('shared shield reports actual ready blocking and a server block sound, then rejects axe cooldown', async () => {
  const a = actor()
  const guard = a.combat.makeShield(a.session, a.ctl, { shield: 'always' })
  try {
    assert.equal(await guard.wear(), true)
    const raised = guard.raise(true)
    await turn(); a.metadata(3); a.age(1001); a.c.advanceTicks(1); await turn()
    assert.equal(await raised, true)
    assert.equal(guard.blocking(), false, 'using ACK is distinct from blocking')
    a.age(1006)
    assert.equal(guard.blocking(), true)
    a.bot._client.emit('sound_effect', { sound: { data: { soundName: 'minecraft:item.shield.block' } }, x: 4, y: 512, z: 4 })
    assert.equal(guard.report().blocked, 1, 'the report counts a native shield block receipt, not our activate intent')
    a.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 100 })
    assert.equal(guard.blocking(), false)
    assert.equal(guard.report().disabled, 1)
    assert.equal(a.tactics.observeTactics(a.session).shield, false, 'the graph cannot select a disabled shield')
  } finally { guard.close(); a.close() }
})

test('Shield keeps protection after native five ticks while still admissible, and completes when the threat clears', async () => {
  const a = actor()
  let result: any
  const looks: any[] = []
  a.bot.lookAt = async (at: any) => { looks.push(at.clone()) }
  try {
    const system = new a.tactics.TacticalSystem(a.session)
    const pending = system.execute({ id: 'Shield', score: 80 }, a.ctl, a.tactics.observeTactics(a.session)).then((r: any) => { result = r })
    await turn(); a.metadata(3); a.age(1001); a.c.advanceTicks(1); await turn()
    a.age(1006); a.c.advanceTicks(1); await turn()
    assert.equal(result, undefined, 'a ready shield is not a completed pulse while the same incoming threat remains')
    assert.equal(a.releases(), 0)
    a.bot.entities[2].position = new Vec3(5.5, 64, .5)
    a.c.advanceTicks(1); await turn()
    assert.equal(looks.at(-1).x, 5.5, 'held protection follows the current observed threat direction')
    delete a.bot.entities[2]; a.c.advanceTicks(1); await pending
    assert.equal(result.shielded, true)
    assert.ok(result.shield.confirmedTicks >= 5)
    assert.equal(a.releases(), 1)
  } finally { a.close() }
})

for (const cause of ['slot', 'cooldown', 'death', 'abort', 'authority']) test(`native Shield ${cause} cannot turn missing protection into completed success`, async () => {
  const a = actor()
  try {
    if (cause === 'authority') a.bot.ndClock = null
    const system = new a.tactics.TacticalSystem(a.session)
    const pending = system.execute({ id: 'Shield', score: 80 }, a.ctl, a.tactics.observeTactics(a.session)).then(
      (r: any) => ({ result: r }), (error: Error) => ({ error: error.message }))
    await turn()
    if (cause === 'slot') { a.bot.inventory.slots[45] = null; a.bot.inventory.emit('updateSlot', 45) }
    if (cause === 'cooldown') a.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 100 })
    if (cause === 'death') { a.bot.health = 0; a.bot.emit('death') }
    if (cause === 'abort') a.ctl.abort()
    const outcome = await pending
    assert.notEqual(outcome.result?.shielded, true)
    assert.ok(cause === 'abort' ? outcome.result?.cancelled : outcome.error)
    assert.equal(a.bot._client.listenerCount('set_cooldown'), 0)
    assert.equal(a.bot._client.listenerCount('entity_metadata'), 0)
  } finally { a.close() }
})

test('Full40 pressured BlockOff preserves the failed actual box and does not report a completed refuge', async () => {
  const a = actor()
  a.bot.game.dimension = 'the_nether'
  const nativeGuard = require('../src/ne-guard')
  const receipt = { acted: true, box: { ok: false, placed: 0, left: ['91,52,142'], pressure: true }, duel: { swings: 0, stopped: 'не достать' }, killed: false }
  const react = nativeGuard.react
  nativeGuard.react = async () => receipt
  const events: any[] = []
  a.session.bus.emit = (type: string, detail: any) => events.push({ type, ...detail })
  try {
    const system = new a.tactics.TacticalSystem(a.session)
    system.begin({ id: 'BlockOff', score: 95 }, [], a.tactics.observeTactics(a.session), 2)
    await system.waitForRelease()
    const finished = events.find(event => event.type === 'tactical_finished')
    assert.equal(finished.result, 'failed')
    assert.equal(finished.detail.box.pressure, true)
    assert.equal(finished.detail.box.placed, 0)
  } finally { nativeGuard.react = react; a.close() }
})

test('Full40 saved Brute inside the two-block refuge volume prevents box success; outside and neutral actors do not', async () => {
  const a = actor()
  const guard = sourceModule('ne-guard', {}, '\nmodule.exports.__boxIn=boxIn;module.exports.__sealedAt=sealedAt;')
  a.bot.entity.position = new Vec3(98.5, 43, 141.5)
  a.bot.entities[2].position = new Vec3(98.30000001192093, 43, 141.69999998807907)
  a.bot.entities[2].health = 44
  a.bot.inventory.items = () => [{ name: 'cobbled_deepslate', count: 61 }]
  a.bot.blockAt = (p: any) => {
    const air = Math.floor(p.x) === 98 && Math.floor(p.z) === 141 && (Math.floor(p.y) === 43 || Math.floor(p.y) === 44)
    return { position: p.floored(), name: air ? 'air' : 'blackstone', boundingBox: air ? 'empty' : 'block', shapes: air ? [] : [[0, 0, 0, 1, 1, 1]] }
  }
  try {
    const blocked = await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })
    assert.equal(blocked.ok, false, 'a complete shell enclosing a hostile with us is not refuge')
    assert.equal(blocked.pressure, true)
    assert.equal(blocked.placed, 0)
    assert.equal(guard.__sealedAt(a.bot, a.bot.entity.position.floored()), false)
    a.bot.entities[2].position = new Vec3(100.5, 43, 141.5)
    assert.equal((await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })).ok, true, 'a brute behind the solid shell does not invalidate actual cover')
    a.bot.entities[2].position = new Vec3(98.3, 43, 141.7)
    a.bot.entities[2].name = 'piglin'; a.bot.entities[2].metadata = []
    assert.equal((await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })).ok, true, 'neutral barter piglins do not become hostile')
    a.bot.entities[2].name = 'oak_boat'
    assert.equal((await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })).ok, true, 'a protected boat is not a melee hostile')
    a.ctl.abort()
    assert.equal((await guard.__boxIn(a.bot, null, { ctl: a.ctl })).cancelled, true)
  } finally { a.close() }
})

test('box construction reobserves hostile entry before another placement and before success', async () => {
  const a = actor()
  let placed = 0
  const filled = new Set<string>()
  a.bot.entities[2].position = new Vec3(3.5, 64, .5)
  a.bot.inventory.items = () => [{ name: 'cobbled_deepslate', count: 61 }]
  a.bot.blockAt = (p: any) => {
    const solid = p.y < 64 || filled.has(p.floored().toString())
    return { position: p.floored(), name: solid ? 'blackstone' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  const guard = sourceModule('ne-guard', { './build': { placeBlockAt: async (_bot: unknown, p: any) => {
    placed++; filled.add(p.toString()); a.bot.entities[2].position = new Vec3(.3, 64, .7); return { ok: true }
  } } }, '\nmodule.exports.__boxIn=boxIn;')
  try {
    const result = await guard.__boxIn(a.bot, a.bot.entities[2], { ctl: a.ctl })
    assert.equal(placed, 1, 'the existing fair placement stops when a hostile enters our interior')
    assert.equal(result.ok, false)
    assert.equal(result.pressure, true)
    assert.equal(result.placed, 1, 'already acknowledged placements remain real partial progress')
  } finally { a.close() }
})

test('a failed diagonal refuge after a real hit cannot start another guarded wait', async () => {
  const a = actor()
  const refusal = { ok: false, placed: 0, left: ['0,64,0'], pressure: true, interior: [2] }
  const guard = sourceModule('ne-guard', {}, '\nmodule.exports.__reactBody=reactBody;module.exports.__setHooks=(h)=>{boxIn=h.boxIn;sit=h.sit;duel=h.duel;};')
  a.bot.blockAt = (p: any) => ({ position: p.floored(), name: 'blackstone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] })
  let boxes = 0; let sits = 0; let lastStand = false
  guard.__setHooks({
    boxIn: async () => ++boxes === 1 ? { ok: true, placed: 7, left: [] } : refusal,
    sit: async () => ({ hit: ++sits === 1 }),
    duel: async (_session: unknown, _ctl: unknown, _e: unknown, _ms: number, opts: { lastStand?: boolean }) => {
      lastStand = opts.lastStand === true; return { swings: 1, killed: true }
    }
  })
  try {
    const result = await guard.__reactBody(a.session, a.ctl, {}, { e: a.bot.entities[2], why: 'brute near refuge' })
    assert.equal(sits, 1, 'an observed hostile entering the failed refuge cannot authorize another 25-second wait')
    assert.equal(lastStand, true, 'the existing close-combat fallback handles the failed refuge')
    assert.equal(result.boxDiag.pressure, true)
    assert.deepEqual(result.boxDiag.interior, [2])
  } finally { a.close() }
})

async function rangedDuelFixture({ name = 'skeleton', hand = 'bow', player = false, visible = true, worn = true, aborted = false, loaded = false, piercing = false, distance = 10 } = {}) {
  const a = actor()
  a.bot.setMaxListeners(30)
  a.bot.entities[2].name = player ? 'player' : name
  if (player) { a.bot.entities[2].username = 'Target'; a.bot.entities[2].type = 'player' }
  a.bot.entities[2].position = new Vec3(.5, 64, distance + .5)
  a.bot.entities[2].yaw = 0; a.bot.entities[2].pitch = Math.atan2(-.72, distance)
  const componentMap = new Map<string, unknown>()
  if (loaded) componentMap.set('charged_projectiles', { data: { projectiles: [{ name: 'arrow' }] } })
  if (piercing) componentMap.set('enchantments', { data: { enchantments: [{ id: 'piercing', level: 1 }] } })
  a.bot.entities[2].equipment[0] = { name: hand, componentMap }
  a.bot.entities[2].metadata[a.bot.registry.entitiesByName[a.bot.entities[2].name].metadataKeys.indexOf('living_entity_flags')] = 1
  a.bot.world = { raycast: () => visible ? null : { position: new Vec3(.5, 65, 4.5) } }
  if (!visible) {
    const flat = a.bot.blockAt
    a.bot.blockAt = (p: any) => p.z >= 4 && p.z < 5 ? { position: p.floored(), name: 'blackstone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : flat(p)
  }
  a.bot.entity.velocity = new Vec3(0, 0, 0)
  a.bot.entity.attributes = {}
  a.bot.controlState = {}
  a.bot.setControlState = (key: string, value: boolean) => { a.bot.controlState[key] = value }
  a.bot._client.write = () => {}
  a.bot.look = async () => {}
  a.bot.equip = async (item: unknown) => { a.bot.heldItem = item }
  a.bot.getEquipmentDestSlot = () => 36
  a.session.mcData = a.bot.registry
  const raises: boolean[] = []
  const guard = { stats: { worn }, melee: false, measure: false,
    safety: { check: () => ({ action: 'fight', hazard: false }) },
    wear: async () => true, watch() {}, swung() {}, report: () => ({}),
    raise: async (value: boolean) => { raises.push(value); return value }
  }
  const movement = require('../src/movement')
  const pvp = sourceModule('pvp', { './movement': { ...movement, sleep: async (ms: number) => { a.c.advanceTicks(Math.max(1, Math.ceil(ms / 50))); await turn() } } })
  try {
    if (aborted) a.ctl.abort()
    const result = await pvp.duel(a.session, a.ctl, a.bot.entities[2], { lastStand: true, timeoutSeconds: .5, guard })
    return { result, raises }
  } finally { a.close() }
}

test('a visible skeleton beyond melee reach keeps the existing offhand guard during LastStand', async () => {
  const { result, raises } = await rangedDuelFixture()
  assert.equal(result.swings, 0, 'the target is outside honest melee reach')
  assert.ok(raises.includes(true), 'the existing guard must defend from the observed ranged mob: ' + JSON.stringify(raises))
  assert.ok(raises.slice(0, -1).every(value => value === true), 'the far-approach branch must not lower the bow shield in the same loop: ' + JSON.stringify(raises))
})

test('player bow uses the same far shield while crossbow keeps its existing loaded-aim gate', async () => {
  assert.ok((await rangedDuelFixture({ player: true })).raises.includes(true))
  assert.equal((await rangedDuelFixture({ player: true, hand: 'crossbow' })).raises.includes(true), false)
  assert.ok((await rangedDuelFixture({ player: true, hand: 'crossbow', loaded: true, distance: 6 })).raises.includes(true))
  assert.equal((await rangedDuelFixture({ player: true, hand: 'crossbow', loaded: true, piercing: true, distance: 6 })).raises.includes(true), false)
})

test('ranged guard requires visible draw and actual worn availability, and does not start after cancellation', async () => {
  for (const options of [{ name: 'zombie', hand: 'iron_sword' }, { visible: false }, { worn: false }, { aborted: true }]) {
    assert.equal((await rangedDuelFixture(options)).raises.includes(true), false, JSON.stringify(options))
  }
})

test('a threat that passes before the server confirms the raised shield ends the Shield, it does not fail it (farm 06.10)', async () => {
  const a = actor()
  let result: any, error: any
  try {
    const system = new a.tactics.TacticalSystem(a.session)
    const pending = system.execute({ id: 'Shield', score: 80 }, a.ctl, a.tactics.observeTactics(a.session))
      .then((r: any) => { result = r }, (e: any) => { error = e })
    await turn()
    a.bot.entities = {}
    for (let tick = 0; tick < 200 && result === undefined && error === undefined; tick++) { a.c.advanceTicks(1); await turn() }
    assert.equal(error, undefined, error?.message)
    assert.equal(result?.shielded, false)
  } finally { a.close() }
})
