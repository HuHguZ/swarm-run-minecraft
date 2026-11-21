import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as armor from '../src/armor'
import { bestWeapon, weaponScore } from '../src/items'
import { createEquipment } from '../src/pvp/equipment'
import { smashTurn } from '../src/pvp/turn-mace'
import { makeShield } from '../src/combat/shield'
import { offhandTurn } from '../src/pvp/turn-heal'
import { webTurn } from '../src/pvp/turn-hazards'
import { hazardMethods } from '../src/rpc/hazards'
import { targetStrikeWait } from '../src/pvp/turn-melee'
import { createTickPlugins } from '../src/tick-plugins'
import { block, data, testBot, testClock } from './tick-plugins-fixture'
import * as totem from '../src/totem'
import { inspect as safetyInspect } from '../src/combat-safety'
import { createRecovery } from '../src/pvp/recovery'
import { createLastSeen } from '../src/pvp/last-seen'
import { incomingTurn } from '../src/pvp/turn-projectiles'
import { installSight, installInputs } from '../src/pvp/duel-probes'
import { farApproachTurn } from '../src/pvp/turn-approach'
import { flightTurn } from '../src/pvp/turn-air'
import { crowdTurn } from '../src/pvp/turn-crowd'
import * as Loot from '../src/pvp/arms-loot'
import * as clock from '../src/game-clock'
import * as tempo from '../src/tempo'

const registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Item = (require('prismarine-item') as typeof import('prismarine-item').default)(registry)

function makeItem (name: string, slot: number, ench: Record<string, number> = {}, durabilityUsed = 0) {
  const info = registry.itemsByName[name]
  const it: any = new Item(info.id, 1)
  it.slot = slot
  it.durabilityUsed = durabilityUsed
  const list = Object.entries(ench).map(([k, level]) => ({ id: k, level }))
  if (list.length) {
    const comp = { type: 'enchantments', data: { enchantments: list } }
    it.components = [comp]
    it.componentMap = new Map([['enchantments', comp]])
  } else {
    it.components = []
    it.componentMap = new Map()
  }
  return it
}

// ---------------------------------------------------------------- 1. Armor & Weapons

test('armor.ts keeps enchanted P4/FF4 gear over 100% unenchanted spares and matches exact enchants', async () => {
  const wornChest = makeItem('diamond_chestplate', 6, { protection: 4 }, 50)
  const plainChest = makeItem('diamond_chestplate', 9, {}, 0)
  const wornBoots = makeItem('netherite_boots', 8, { protection: 4, feather_falling: 4 }, 40)
  const plainBoots = makeItem('netherite_boots', 10, {}, 0)
  const plainHelm = makeItem('diamond_helmet', 11, {}, 0)
  const p4Helm = makeItem('diamond_helmet', 12, { protection: 4 }, 0)
  const slots: any[] = Array(46).fill(null)
  slots[6] = wornChest
  slots[8] = wornBoots
  slots[9] = plainChest
  slots[10] = plainBoots
  slots[11] = plainHelm
  slots[12] = p4Helm
  const equippedItems: any[] = []
  const bot: any = {
    entity: { onGround: true, elytraFlying: false },
    game: { dimension: 'overworld' },
    health: 20,
    currentWindow: null,
    registry,
    inventory: { slots, selectedItem: null, items: () => slots.slice(9, 45).filter(Boolean) },
    async equip (item, dest) {
      equippedItems.push({ item, dest })
      const idx = { head: 5, torso: 6, legs: 7, feet: 8 }[dest]!
      slots[item.slot] = slots[idx]
      slots[idx] = item
      item.slot = idx
    }
  }
  const plan = armor.planSwaps(bot)
  assert.equal(plan.some(s => s.dest === 'torso'), false, 'must NOT strip P4 diamond chestplate for 100% plain')
  assert.equal(plan.some(s => s.dest === 'feet'), false, 'must NOT strip P4/FF4 netherite boots for 100% plain')
  assert.equal(plan.length, 1)
  assert.equal(plan[0].dest, 'head')
  const res = await armor.equipBestArmor({ bot }, { aborted: false }, { confirmMs: 200 })
  assert.equal(equippedItems.length, 1)
  assert.equal(equippedItems[0].item, p4Helm, 'findAgain must select the P4 helmet, not the plain duplicate in an earlier slot')
  assert.equal(res.equipped.length, 1)
})

test('bestWeapon and holdWeapon score enchants/DPS and upgrade from plain to enchanted same-name stack', async () => {
  const woodSword = makeItem('wooden_sword', 36)
  const nethAxe = makeItem('netherite_axe', 37)
  const plainDiamond = makeItem('diamond_sword', 38)
  const sharpDiamond = makeItem('diamond_sword', 39, { sharpness: 5, fire_aspect: 2 })
  const ironSpear = makeItem('iron_spear', 40)
  const nethSpear = makeItem('netherite_spear', 41)

  const botWith = (items: any[]) => ({ registry, inventory: { items: () => items, slots: [] } })
  assert.equal(bestWeapon(botWith([woodSword, nethAxe])), nethAxe, 'netherite_axe beats wooden_sword')
  assert.equal(bestWeapon(botWith([ironSpear, nethSpear])), nethSpear, 'netherite_spear beats iron_spear')
  assert.equal(bestWeapon(botWith([plainDiamond, sharpDiamond])), sharpDiamond, 'Sharp V diamond_sword beats plain')
  assert.ok(weaponScore(botWith([]), sharpDiamond) > weaponScore(botWith([]), plainDiamond))

  // holdWeapon with chosenWeapon='diamond_sword' must swap from plain diamond_sword to Sharp V diamond_sword
  const equipped: any[] = []
  const bot: any = new EventEmitter()
  bot.registry = registry
  bot.heldItem = plainDiamond
  bot.inventory = { items: () => [plainDiamond, sharpDiamond], slots: [] }
  bot.equip = async (it) => { equipped.push(it); bot.heldItem = it }
  const ctx: any = {
    bot,
    bestWeapon,
    chosenWeapon: 'diamond_sword',
    heldName: () => bot.heldItem?.name ?? null,
    findItem: (_b, fn) => bot.inventory.items().find(fn),
    switched: () => {}
  }
  const eq = createEquipment(ctx)
  await eq.holdWeapon()
  assert.equal(equipped.length, 1)
  assert.equal(equipped[0], sharpDiamond)
  assert.equal(bot.heldItem, sharpDiamond)
  eq.closeEquipment()
})

// ---------------------------------------------------------------- 2. Shield state machine & ranged jitter

test('smashTurn does not drop active shield when riptideSmash cannot run (dry / no riptide trident)', async () => {
  const lowers: boolean[] = []
  let riptideCalls = 0
  const bot: any = {
    health: 20,
    isRaining: false,
    entity: { position: new Vec3(0, 64, 0), isInWater: false },
    inventory: { items: () => [{ name: 'diamond_sword' }], slots: [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' })
  }
  const ctx: any = {
    bot,
    prof: { player: true },
    perch: null,
    fort: null,
    pendingLava: [],
    ctl: { aborted: false },
    entity: { id: 2, position: new Vec3(8, 64, 0), onGround: true, equipment: [] },
    tt: { foes: new Map() },
    duo: { active: () => false },
    gate: () => true,
    guard: { raise: async (v: boolean) => { lowers.push(v); return false } },
    util: { riptideSmash: async () => { riptideCalls++; return null } },
    ready: () => false,
    rest () {},
    used () {},
    clear () {},
    holdWeapon: async () => {},
    track: { vel: () => new Vec3(0, 0, 0) },
    maceChain: { choose: () => null },
    mc: { st: {} },
    st: {},
    telemetryHp: () => null,
    windInputs: () => 'x',
    aim: 'target'
  }
  await smashTurn(ctx, { aimedCb: null, hp: 20, meInWeb: false, now: 1000, theirR: 8, theyBow: false } as any)
  assert.deepEqual(lowers, [], 'active shield must stay raised when riptideSmash cannot launch')
  assert.equal(riptideCalls, 0)
  assert.equal(ctx.aim, 'target')
})

test('shield.ts resets sh.want on start() failure, supports bounded unconfirmed retry, and tracks worn dynamically', async () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.health = 20
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), metadata: [], yaw: 0 }
  const shieldItem = { name: 'shield', type: registry.itemsByName.shield.id, count: 1 }
  const totemItem = { name: 'totem_of_undying', type: registry.itemsByName.totem_of_undying.id, count: 1 }
  bot.inventory = new EventEmitter()
  bot.inventory.slots = Array(46).fill(null)
  bot.inventory.slots[45] = shieldItem
  bot.inventory.items = () => []
  let writes = 0
  let failStart = true
  bot.activateItem = () => {
    if (failStart) throw new Error('busy')
    writes++
  }
  bot.deactivateItem = () => {}
  c.attach(bot)
  bot._client.emit('update_time', { age: 1000n })
  const session: any = { bot, current: null }
  const ctl: any = { aborted: false, onAbort: [] }
  const guard = makeShield(session, ctl, { shield: 'always' })
  try {
    // Dynamic worn reflects live slot 45 even before wear() and across totem swaps
    assert.equal(guard.stats.worn, true)
    bot.inventory.slots[45] = totemItem
    assert.equal(guard.stats.worn, false, 'swapping totem into offhand immediately clears worn')
    bot.inventory.slots[45] = shieldItem
    assert.equal(guard.stats.worn, true, 'swapping shield back into offhand immediately restores worn')

    // First start() throws -> sh.want must be reset AND failure() must surface the start error
    assert.equal(await guard.raise(true), false)
    assert.equal(guard.traceState().want, false, 'failed start must reset sh.want')
    assert.equal(guard.failure(), 'busy', 'failed start must remain visible to shield.failure()')

    // Next attempt succeeds in sending packet (no ACK yet -> bounded retry after 1000ms)
    failStart = false
    const p1 = guard.raise(true)
    assert.equal(guard.failure(), null, 'subsequent successful start clears prior raiseFail')
    c.advanceTicks(15) // past 600ms confirm window
    await p1
    assert.equal(writes, 1)
    assert.equal(guard.traceState().want, true)

    // Still inside 1000ms window -> no duplicate spam
    assert.equal(await guard.raise(true), false)
    assert.equal(writes, 1)

    // Past 1000ms -> bounded unconfirmed retry #2 fires
    c.advanceTicks(10)
    const p2 = guard.raise(true)
    c.advanceTicks(15)
    await p2
    assert.equal(writes, 2, 'bounded retry recovers from dropped initial packet')
  } finally {
    guard.close()
    bot.emit('end')
    c.dispose()
  }
})

test('webTurn does not freeze thinking it is blocking with a shield when offhand holds a totem', async () => {
  const bot: any = new EventEmitter()
  bot.health = 10
  bot.entity = { id: 1, position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8, onGround: true, isInWater: false, metadata: [] }
  bot.game = { dimension: 'overworld' }
  bot.registry = registry
  bot.inventory = {
    slots: Object.assign(Array(46).fill(null), { 45: { name: 'totem_of_undying' } }),
    items: () => [{ name: 'shears', type: registry.itemsByName.shears.id, slot: 36 }]
  }
  const webBlock = { name: 'cobweb', position: new Vec3(0, 64, 0), boundingBox: 'empty', hardness: 4, diggable: true, stateId: 1, digTime: t => t === registry.itemsByName.shears.id ? 400 : 20000 }
  bot.blockAt = (p: Vec3) => p.floored().equals(new Vec3(0, 64, 0)) ? webBlock : { name: 'air', position: p.floored(), boundingBox: 'empty', shapes: [] }
  bot.lookAt = async () => {}
  let dug = false
  let raised = 0
  const ctx: any = {
    bot,
    prof: { player: true },
    ctl: { aborted: false, onAbort: [] },
    // Stale mock guard claiming worn: true even though offhand is totem_of_undying!
    guard: { stats: { worn: true }, blocking: () => false, raise: async (v: boolean) => { if (v) raised++; return false }, failure: () => null },
    mc: { threat: () => ({ kind: 'air', eta: 10 }) },
    tt: { threats: () => [], eta: () => 0, state: () => ({}) },
    clear () {},
    pathTo () {},
    routeInputs: () => 'r',
    digWatch: async () => { dug = true; return null },
    escapePearl: async () => null,
    holdItem: async () => true,
    holdWeapon: async () => {},
    pendingWater: [],
    ready: () => false,
    rest () {},
    st: {},
    used () {},
    sleep: async () => {}
  }
  await webTurn(ctx, {} as any)
  assert.equal(raised, 0, 'must not try to raise shield when holding a totem')
  assert.equal(dug, true, 'must cut web instead of freezing behind a phantom shield')
})

// ---------------------------------------------------------------- 3. clear_web, targetStrikeWait, ND_DIG_RESTART, totem/safety

test('clear_web equips shears before digging cobweb and recomputes dig time', async () => {
  let webGone = false
  const shears = { name: 'shears', type: registry.itemsByName.shears.id, slot: 36 }
  const pickaxe = { name: 'diamond_pickaxe', type: registry.itemsByName.diamond_pickaxe.id, slot: 37 }
  const blockObj = (p: Vec3) => ({
    name: !webGone && p.equals(new Vec3(0, 64, 0)) ? 'cobweb' : 'air',
    position: p,
    boundingBox: 'empty',
    hardness: 4,
    diggable: true,
    digTime: (type: number | null) => type === shears.type ? 400 : 20000
  })
  let heldWhenDigging: any = null
  const bot: any = {
    entity: { type: 'player', position: new Vec3(0.5, 64, 0.5), width: 0.6, height: 1.8, onGround: true, isInWater: false },
    entities: {},
    heldItem: pickaxe,
    inventory: { items: () => [pickaxe, shears] },
    blockAt: (p: Vec3) => blockObj(p.floored()),
    digTime: (b: any) => b.digTime(bot.heldItem?.type ?? null),
    equip: async (it: any) => { bot.heldItem = it },
    lookAt: async () => {},
    clearControlStates () {},
    pathfinder: { setGoal () {} },
    dig: async () => { heldWhenDigging = bot.heldItem; webGone = true },
    stopDigging () {}
  }
  const ctl = { aborted: false, onAbort: [] }
  const session = { require: () => bot, runIntent: async (_n, fn) => ({ status: 'done', detail: await fn(ctl) }) }
  const fakeClock = { sleep: async () => {}, setInterval: () => 1, clearInterval () {}, now: () => 0 }
  const res = await hazardMethods({ session, gameClock: fakeClock }).clear_web({})
  assert.equal(res.detail.ok, true)
  assert.equal(heldWhenDigging, shears, 'clear_web must equip shears before calling bot.dig')
})

test('targetStrikeWait reads ctx.calc.iframe.known so stronger melee swings through lava iframes', () => {
  const sword = makeItem('netherite_sword', 36, { sharpness: 5 })
  const bot: any = {
    registry,
    heldItem: sword,
    entity: { position: new Vec3(0, 64, 0), effects: {} }
  }
  const ctx: any = {
    bot,
    prof: { player: true },
    entity: { id: 2, username: 'Foe', position: new Vec3(2, 64, 0) },
    opts: {},
    mf: { clock: { charge: () => 1 } },
    targetHurtAt: 1000,
    // Real duel shape: foeEst is a function, iframe lives on calc!
    foeEst: () => ({ lo: 10, hi: 20, mean: 15 }),
    calc: { iframe: { known: { raw: 4, at: 1000 } } }
  }
  assert.equal(targetStrikeWait(ctx, 1100), 0, 'netherite Sharp V (11 raw) must swing through 4-raw lava iframe immediately')
  // Weak fist (1 raw) must still wait out iframe
  bot.heldItem = null
  assert.ok(targetStrikeWait(ctx, 1100) > 0, 'weak damage below lastHurt must wait out iframe')
})

test('ND_DIG_RESTART defaults to restarting on same-tool durability delta, and respects ND_DIG_RESTART=0', async () => {
  const prev = process.env.ND_DIG_RESTART
  delete process.env.ND_DIG_RESTART
  try {
    const ck = testClock(), bot = testBot()
    createTickPlugins(ck).plugins.digging(bot)
    assert.ok(bot.getMaxListeners() >= 40, 'bot maxListeners raised to prevent false MaxListenersExceededWarning')
    assert.ok(bot._client.getMaxListeners() >= 40, 'client maxListeners raised')
    bot.heldItem = new Item(data.itemsByName.iron_pickaxe.id, 1)
    bot.entity.onGround = true
    const web = block('cobweb', new Vec3(0, 1, 0))
    const task = bot.dig(web, 'ignore')
    await ck.advanceGame(2000)
    // Durability packet arrives on the same count-1 tool
    const nextTool: any = new Item(data.itemsByName.iron_pickaxe.id, 1)
    nextTool.components = [{ type: 'damage', data: 1 }]
    bot.heldItem = nextTool
    await ck.advanceGame(50)
    assert.equal(bot.targetDigBlock, web, 'default ND_DIG_RESTART restarts instead of aborting on durability delta')
    await ck.advanceGame(20200)
    await task
    assert.deepEqual(bot.packets.filter(p => p.name === 'block_dig').map(p => p.status), [0, 0, 2])
    bot.emit('end')

    // Explicitly setting ND_DIG_RESTART=0 restores abort behavior
    process.env.ND_DIG_RESTART = '0'
    const ck2 = testClock(), bot2 = testBot()
    createTickPlugins(ck2).plugins.digging(bot2)
    bot2.heldItem = new Item(data.itemsByName.iron_pickaxe.id, 1)
    bot2.entity.onGround = true
    const task2 = bot2.dig(web, 'ignore')
    const rej = assert.rejects(task2, /aborted/)
    await ck2.advanceGame(500)
    const nextTool2: any = new Item(data.itemsByName.iron_pickaxe.id, 1)
    nextTool2.components = [{ type: 'damage', data: 1 }]
    bot2.heldItem = nextTool2
    await ck2.advanceGame(50)
    await rej
    bot2.emit('end')
  } finally {
    if (prev === undefined) delete process.env.ND_DIG_RESTART
    else process.env.ND_DIG_RESTART = prev
  }
})

test('totem.ts, combat-safety.ts, and recovery.ts price 1.21.11 spears + Sharpness and drive totemNeeded from wantTotem', async () => {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'
  bot.registry = registry
  bot.health = 14
  bot.food = 20
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), onGround: true, height: 1.8, metadata: [] }
  bot.inventory = { slots: Array(46).fill(null), items: () => [makeItem('iron_sword', 36)] }
  bot.blockAt = (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', position: p, boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.entities = {}

  const spearFoe = { id: 2, type: 'player', username: 'Lancer', isValid: true, position: new Vec3(2, 64, 0), equipment: [makeItem('netherite_spear', 0, { sharpness: 5 })] }
  const fistFoe = { id: 3, type: 'player', username: 'Boxer', isValid: true, position: new Vec3(2, 64, 0), equipment: [] }
  const spearBurst = totem.burstOf(bot, spearFoe)
  const fistBurst = totem.burstOf(bot, fistFoe)
  assert.ok(spearBurst > 10, `expected netherite_spear Sharp V burst > 10, got ${spearBurst}`)
  assert.ok(spearBurst > fistBurst * 5)

  const safetyRes = safetyInspect(bot, { target: spearFoe })
  assert.ok(safetyRes.threats[0].hit >= 11, `expected combat-safety hit >= 11 for netherite_spear Sharp V, got ${safetyRes.threats[0].hit}`)

  // recovery.consumeItem must keep totem in offhand at HP=14 when wantTotem().yes is true (instead of hardcoded hp<=10)
  const totemIt = makeItem('totem_of_undying', 45)
  const gapple = makeItem('golden_apple', 37)
  bot.inventory.slots[45] = totemIt
  bot.inventory.items = () => [makeItem('iron_sword', 36), gapple]
  bot.heldItem = makeItem('iron_sword', 36)
  bot.usingHeldItem = false
  let equippedHand: string | null = null
  bot.equip = async (_it, hand) => { equippedHand = hand }
  const ctx: any = {
    bot,
    entity: spearFoe,
    prof: { player: true },
    ctl: { aborted: false },
    session: {},
    EYE: 1.62,
    HIT_REACH: 2.9,
    TICK_MS: 50,
    gameClock: clock,
    tempo,
    tt: { safe: () => ({ ok: true }), state: () => ({}) },
    edges: { falling: () => false },
    fortSealed: () => false,
    maceNow: () => false,
    reachFrom: () => 2.5,
    potionOf: () => null,
    punishable: () => null,
    holdItem: async () => { equippedHand = 'hand'; return true },
    eatHeld: async () => true,
    countOf: () => 1,
    st: { healed: [] }
  }
  const rec = createRecovery(ctx)
  ctx.eatHeld = async () => true
  await rec.consumeItem(gapple)
  assert.equal(equippedHand, 'hand', 'must eat in main hand instead of evicting offhand totem when wantTotem() is true at HP=14')
})

// ---------------------------------------------------------------- 4. CPU spikes, A* thrashing, failedSky, breakOut, full-bag loot

test('last-seen.ts memoizes per (entity, tick) and throttles gear raycasts while tracking visible gear changes', () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.entity = { id: 1, position: new Vec3(0.5, 0, 0.5), onGround: true }
  c.attach(bot)
  let blockReads = 0
  bot.blockAt = (p: Vec3) => {
    blockReads++
    return { name: 'air', position: p, boundingBox: 'empty', shapes: [] }
  }
  bot._ndFastBlocks = { live: true, ver: 1, world: null, block: (x, y, z) => bot.blockAt(new Vec3(x, y, z)) }
  const raw: any = Object.assign(new EventEmitter(), {
    id: 2, type: 'player', name: 'player', username: 'Foe', isValid: true,
    position: new Vec3(4.5, 0, 0.5), onGround: true, height: 1.8, width: 0.6, yaw: 0, pitch: 0, headYaw: 0,
    equipment: [{ name: 'iron_sword', componentMap: new Map() }],
    metadata: Object.assign(Array(18).fill(0), { 9: 12, 17: 4 })
  })
  const vision = createLastSeen(bot)
  try {
    const view = vision.observe(raw)
    assert.equal(view.metadata[9], undefined)
    assert.equal(view.metadata[17], undefined)
    const afterFirst = blockReads
    // 10 more calls on the same tick -> 0 extra block reads!
    for (let i = 0; i < 10; i++) vision.observe(raw)
    assert.equal(blockReads, afterFirst, 'same-tick repeated observe() must hit per-tick memo')

    // Next tick with equipment change: visible hand updates immediately without 90-ray gear rescan
    c.advanceTicks(1)
    raw.equipment[0] = { name: 'netherite_sword', componentMap: new Map() }
    bot._client.emit('entity_equipment', { entityId: 2 })
    vision.observe(raw)
    assert.equal(view.equipment[0].name, 'netherite_sword')
    const readsOnTick2 = blockReads - afterFirst
    assert.ok(readsOnTick2 < afterFirst, `throttled gear rays should use fewer reads (${readsOnTick2} < ${afterFirst})`)
  } finally {
    vision.close()
    c.dispose()
  }
})

test('turn-projectiles passes session._ndFoes to threats.dangers so dangerMemo hits', async t => {
  const threats = require('../src/threats')
  const seenOpts: any[] = []
  t.mock.method(threats, 'dangers', (_bot, opts) => { seenOpts.push(opts); return { arrows: [] } })
  t.mock.method(threats, 'incoming', () => [])
  const bot: any = { entity: { position: new Vec3(0, 64, 0) }, entities: {} }
  const ctx: any = {
    bot,
    session: { _ndFoes: ['Red1', 'Red2'] },
    entity: { id: 2, name: 'player' },
    swatted: new Map(),
    ready: () => false,
    rest () {},
    set () {},
    strafeStep () {},
    used () {},
    coverFrom: async () => false,
    holdWeapon: async () => {},
    healAt: 10
  }
  await incomingTurn(ctx, { eye: new Vec3(0, 65.6, 0), hp: 20, me: new Vec3(0, 64, 0), theyBow: false } as any)
  assert.deepEqual(seenOpts, [{ foes: ['Red1', 'Red2'] }])
})

test('duel-probes memoizes routeInputs per TurnFrame', () => {
  let blockReads = 0
  const bot: any = {
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, eyeHeight: 1.62 },
    inventory: { items: () => [] },
    pathfinder: { movements: { canDig: false, maxDropDown: 3 } },
    _ndFastBlocks: { live: true, ver: 1 },
    blockAt: (p: Vec3) => {
      blockReads++
      return { name: p.y < 64 ? 'stone' : 'air', stateId: p.y < 64 ? 1 : 0, position: p.floored(), boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }
    }
  }
  const ctx: any = { bot, entity: { id: 2, position: new Vec3(5.5, 64, 0.5) }, _turnFrame: {} }
  installSight(ctx)
  installInputs(ctx)
  const first = ctx.routeInputs()
  const afterFirst = blockReads
  for (let i = 0; i < 20; i++) assert.equal(ctx.routeInputs(), first)
  assert.equal(blockReads, afterFirst, '20 routeInputs() calls in one TurnFrame must hit cache')
  // New TurnFrame recomputes cleanly
  ctx._turnFrame = {}
  ctx.routeInputs()
  assert.ok(blockReads > afterFirst)
})

test('farApproachTurn does not clear active pathTo when no archerCover exists and backs off failedReposition', async () => {
  const pathCalls: boolean[] = []
  const bot: any = {
    food: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true, height: 1.8, eyeHeight: 1.62 },
    inventory: { items: () => [] },
    blockAt: (p: Vec3) => ({
      // Narrow 1-wide ledge at (0,63,0) surrounded by void: no cover, no side strafe, no direct forward stepSafe -> needs A*
      name: p.y === 63 && p.x === 0 && p.z === 0 ? 'stone' : 'air',
      position: p.floored(),
      boundingBox: p.y === 63 && p.x === 0 && p.z === 0 ? 'block' : 'empty',
      shapes: p.y === 63 && p.x === 0 && p.z === 0 ? [[0, 0, 0, 1, 1, 1]] : []
    }),
    setControlState () {},
    clearControlStates () {}
  }
  const ctx: any = {
    bot,
    entity: { id: 2, position: new Vec3(0.5, 64, -15.5), height: 1.8, width: 0.6 },
    prof: { player: true, ranged: false },
    pathing: true,
    pathTo: (on: boolean) => pathCalls.push(on),
    clear () {},
    set () {},
    strafeKey: 'left',
    strafeStep () {},
    routeInputs: () => 'same',
    spearChargeFar: async () => false,
    holdWeapon: async () => {},
    leadFn: () => () => new Vec3(0.5, 64, -15.5),
    pvpSkills: { itemReady: () => false },
    ready: () => false,
    rest () {},
    used () {},
    sleep: async () => {},
    AR: null
  }
  await farApproachTurn(ctx, { d: 16, hp: 20, r: 16, seesBody: true, theyBow: true, aimedCb: null } as any)
  assert.equal(pathCalls.includes(false), false, 'must NOT stop active A* path when archerCover is null on narrow bridge')

  // Unchanged noPath rejection must NEVER bypass to pathTo(true), even if strafe is blocked or time advances
  ctx.pathing = false
  ctx.failedReposition = { inputs: 'same', why: 'noPath' }
  pathCalls.length = 0
  await farApproachTurn(ctx, { d: 16, hp: 20, r: 16, seesBody: false, theyBow: false, aimedCb: null, now: 1000 } as any)
  await farApproachTurn(ctx, { d: 16, hp: 20, r: 16, seesBody: false, theyBow: false, aimedCb: null, now: 20000 } as any)
  assert.deepEqual(pathCalls, [], 'unchanged noPath route must not re-install the rejected GoalFollow')

  // Transient no_progress failure suppresses inside backoff window, then retries pathTo(true) with bounded backoff
  ctx.pathing = false
  ctx.failedReposition = { inputs: 'same', why: 'no_progress' }
  pathCalls.length = 0
  await farApproachTurn(ctx, { d: 16, hp: 20, r: 16, seesBody: false, theyBow: false, aimedCb: null, now: 1000 } as any)
  assert.deepEqual(pathCalls, [], 'no_progress stays suppressed inside initial 2500ms backoff window')
  await farApproachTurn(ctx, { d: 16, hp: 20, r: 16, seesBody: false, theyBow: false, aimedCb: null, now: 3500 } as any)
  assert.deepEqual(pathCalls, [true], 'no_progress retries pathTo(true) once backoff expires')
  assert.equal(ctx.failedReposition.farBackoffMs, 5000)
})

test('flightTurn respects ctx.failedSky to avoid infinite same-input aerial retry loops', async () => {
  let runs = 0
  const bot: any = {
    health: 20,
    entity: { position: new Vec3(0, 64, 0), elytraFlying: false },
    inventory: { items: () => [] },
    heldItem: null
  }
  const ctx: any = {
    bot,
    prof: { player: true },
    perch: null,
    fort: null,
    ctl: { aborted: false },
    entity: { id: 2, position: new Vec3(8, 64, 0), equipment: [] },
    foe: { shieldOff: () => 0 },
    foeGrounded: () => true,
    gate: () => true,
    guard: null,
    healAt: 10,
    holdWeapon: async () => {},
    maceNow: () => false,
    pathTo () {},
    clear () {},
    sky: {
      decide: () => ({ kind: 'aerial' }),
      run: async () => { runs++; return { ok: false, note: 'takeoff_failed' } }
    },
    fg: { noteExperience () {} },
    st: { healed: [] },
    tt: { safe: () => ({ ok: true }) },
    used () {},
    windInputs: () => 'same-sky-state',
    track: { vel: () => new Vec3(0, 0, 0) },
    failedSky: null
  }
  await flightTurn(ctx, { d: 8, dy: 0, hp: 20, meInWeb: false, theirR: 8 } as any)
  await flightTurn(ctx, { d: 8, dy: 0, hp: 20, meInWeb: false, theirR: 8 } as any)
  assert.equal(runs, 1, 'failedSky must suppress repeating the same failed aerial turn on unchanged inputs')
})

test('arms-loot full 36-slot bag prices evicting lowest-value slots (+ drop cost) in quoteLoot and fittingLoot(evict)', () => {
  const fullStorage: Loot.StorageItem[] = Array.from({ length: 36 }, (_, i) =>
    i === 0 ? { name: 'iron_sword', count: 1 } : { name: 'cobblestone', count: 64 }
  )
  const owned: Loot.StorageItem[] = fullStorage.slice()
  const chestContents = [{ name: 'netherite_chestplate', count: 1 }, { name: 'netherite_sword', count: 1 }]

  // Default strict mode preserved for backward compatibility
  assert.deepEqual(Loot.fittingLoot(chestContents, fullStorage), [])
  assert.equal(Loot.marginalGain(owned, chestContents, fullStorage), 0)

  // Eviction mode accepts upgrades, evicts 0-value cobblestone, and prices drop ticks
  const plan = Loot.planLootEviction(owned, chestContents, fullStorage)
  assert.equal(plan.accepted.length, 2)
  assert.equal(plan.evicted.length, 2)
  assert.ok(plan.evicted.every(e => e.name === 'cobblestone'))
  assert.equal(plan.dropTicks, 2 * Loot.DROP_TICKS_PER_SLOT)
  assert.ok(plan.netGain > 5)

  // quoteLoot automatically prices eviction on a full bag + adds dropTicks to costTicks
  const { emptyWorld, fact }: typeof import('../src/core/world-state') = require('../src/core/world-state')
  const { armsRegistry, powerOf }: typeof import('../src/pvp/arms-graph') = require('../src/pvp/arms-graph')
  const state = emptyWorld()
  state.position = { x: 0, y: 0, z: 0 }
  state.resources.power = powerOf(owned).total
  state.facts.enemy_power = fact(15, 'observed', 0)
  const q = Loot.quoteLoot({
    state,
    owned,
    storage: fullStorage,
    chest: { id: 'c1', x: 1, y: 0, z: 0, seenAt: 0, seenFrom: { x: 0, y: 0, z: 0 }, opened: true, looted: false, taken: 0, contents: chestContents, attempt: null },
    prior: [chestContents],
    traversals: [],
    foe: null,
    roundScope: 'r1',
    now: 0,
    interactionTicks: 20,
    engage: armsRegistry().get('Engage')
  })
  assert.ok(q.gain > 5, 'full-bag quoteLoot must see Netherite upgrade gain')
  assert.equal(q.costTicks, 20 + 2 * Loot.DROP_TICKS_PER_SLOT, 'quoteLoot must add eviction dropTicks to costTicks')
})

test('turn-crowd breakOut keeps free aim while fleeing, calls holdWeapon, and restores target aim on fight/exit/error', async t => {
  const flee = require('../src/flee')
  const ct = require('../src/pvp/crowd-threat')
  let fleeMode: 'escape' | 'cornered' | 'throw' = 'escape'
  let decideKind: 'break' | 'engage' = 'break'
  t.mock.method(flee, 'smartFlee', async () => {
    if (fleeMode === 'throw') throw new Error('flee_boom')
    return { cornered: fleeMode === 'cornered', ok: fleeMode === 'escape' }
  })
  t.mock.method(ct, 'decide', () => ({ kind: decideKind, why: 'surrounded', f: null }))
  let heldCalls = 0
  const mkFoe = (id: number, x: number) => ({
    id, type: 'player', username: `Foe${id}`, isValid: true, position: new Vec3(x, 64, 0),
    height: 1.8, width: 0.6, equipment: [{ name: 'iron_sword' }], metadata: []
  })
  const foes = [mkFoe(2, 3), mkFoe(3, -3), mkFoe(4, 0)]
  const bot: any = {
    username: 'NeuroDown',
    health: 20,
    entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), height: 1.8, width: 0.6 },
    entities: Object.fromEntries(foes.map(f => [f.id, f])),
    players: Object.fromEntries(foes.map(f => [f.username, { entity: f }])),
    inventory: { slots: Array(46).fill(null), items: () => [] },
    blockAt: () => ({ name: 'stone', boundingBox: 'block' })
  }
  const ctx: any = {
    bot,
    session: {},
    ctl: { aborted: false },
    entity: foes[0],
    opts: { targets: foes.map(f => f.username) },
    prof: { player: true },
    attackers: new Map(),
    dead: new Set(),
    duo: { foes: () => foes, ehp: () => 20, shieldAtUs: () => false },
    vision: { observe: e => e, visible: () => true },
    tt: { foes: new Map(), state: () => ({}) },
    mf: { clock: { charge: () => 1 } },
    guard: null,
    pathing: false,
    pathTo () {},
    clear () {},
    used () {},
    holdWeapon: async () => { heldCalls++ },
    fortPossible: () => false,
    aim: 'target',
    deadline: 100000,
    AR: null
  }
  // 1. Uncornered breakout keeps aim='free' between consecutive break ticks and re-equips weapon
  assert.equal(await crowdTurn(ctx, { now: 1000 } as any), 'next')
  assert.equal(ctx.aim, 'free', 'uncornered breakOut preserves free aim while still breaking out')
  assert.equal(ctx.crowd.freeAim, true)
  assert.equal(heldCalls, 1, 'breakOut must re-equip weapon after smartFlee')

  // 2. Returning to fight (d.kind !== 'break') restores ctx.aim='target'
  decideKind = 'engage'
  await crowdTurn(ctx, { now: 1200 } as any)
  assert.equal(ctx.aim, 'target', 'returning to fight from breakOut restores target aim')
  assert.equal(ctx.crowd.freeAim, false)

  // 3. Exiting crowd mode (< 3 foes for > 2s) after uncornered breakout also restores ctx.aim='target'
  decideKind = 'break'
  await crowdTurn(ctx, { now: 1400 } as any)
  assert.equal(ctx.aim, 'free')
  ctx.opts.targets = [foes[0].username]
  ctx.duo.foes = () => [foes[0]]
  await crowdTurn(ctx, { now: 1600 } as any) // starts offAt
  await crowdTurn(ctx, { now: 4000 } as any) // > 2s -> cr.on becomes false
  assert.equal(ctx.crowd.on, false)
  assert.equal(ctx.aim, 'target', 'exiting crowd mode must restore ctx.aim from free to target')
  assert.equal(ctx.crowd.freeAim, false)

  // 4. Exception during smartFlee immediately restores ctx.aim='target' via finally
  ctx.opts.targets = foes.map(f => f.username)
  ctx.duo.foes = () => foes
  fleeMode = 'throw'
  await assert.rejects(crowdTurn(ctx, { now: 4200 } as any), /flee_boom/)
  assert.equal(ctx.aim, 'target', 'throwing smartFlee must restore ctx.aim via finally')
  assert.equal(ctx.crowd.freeAim, false)
})

test('openDuel stops stale digging and switches off pickaxe/block to best weapon immediately', async () => {
  const { openDuel } = require('../src/pvp/duel-opening')
  const pick = makeItem('diamond_pickaxe', 36)
  const sword = makeItem('netherite_sword', 37, { sharpness: 5 })
  let stoppedDig = false
  const bot: any = new EventEmitter()
  bot.registry = registry
  bot.health = 20
  bot.heldItem = pick
  bot.targetDigBlock = { name: 'stone' }
  bot.stopDigging = () => { stoppedDig = true; bot.targetDigBlock = null }
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), effects: {} }
  bot.inventory = { items: () => [pick, sword], slots: Array(46).fill(null) }
  bot.equip = async (it) => { bot.heldItem = it }
  const ctx: any = {
    bot,
    entity: { id: 2, type: 'player', username: 'Foe', position: new Vec3(3, 64, 0) },
    prof: { player: true },
    lastStand: true,
    opts: {},
    ctl: { aborted: false },
    bestWeapon,
    chosenWeapon: null,
    heldName: () => bot.heldItem?.name ?? null,
    findItem: (_b, fn) => bot.inventory.items().find(fn),
    switched () {},
    pvpSkills: { buffUp: async () => {} },
    st: { style: {} },
    style: { openDelayMs: 0, aggression: 0.5 },
    tt: { state: () => ({}) },
    used () {},
    sleep: async () => {}
  }
  const eq = createEquipment(ctx)
  ctx.holdWeapon = eq.holdWeapon
  await openDuel(ctx)
  assert.equal(stoppedDig, true, 'openDuel must cancel stale mining before combat')
  assert.equal(bot.heldItem, sword, 'openDuel must immediately switch off pickaxe to best enchanted weapon')
  eq.closeEquipment()
})

test('offhandTurn swaps shield<->totem cleanly and keeps makeShield guard.stats.worn in sync', async () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.health = 8
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), metadata: [], yaw: 0, onGround: true, height: 1.8 }
  const shieldIt = makeItem('shield', 45)
  const totemIt = makeItem('totem_of_undying', 36)
  const slots: any[] = Array(46).fill(null)
  slots[45] = shieldIt
  slots[36] = totemIt
  bot.inventory = Object.assign(new EventEmitter(), {
    slots,
    items: () => slots.slice(9, 45).filter(Boolean)
  })
  bot.blockAt = (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', position: p, boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.entities = {}
  bot.deactivateItem = () => {}
  bot.equip = async (it: any, dest: string) => {
    if (dest === 'off-hand') {
      const prev = slots[45]
      slots[it.slot] = prev
      if (prev) prev.slot = it.slot
      slots[45] = it
      it.slot = 45
    }
  }
  c.attach(bot)
  const session: any = { bot, current: null }
  const ctl: any = { aborted: false, onAbort: [] }
  const guard = makeShield(session, ctl, { shield: 'always' })
  const foe = { id: 2, type: 'player', username: 'Foe', isValid: true, position: new Vec3(2, 64, 0), equipment: [makeItem('netherite_sword', 0, { sharpness: 5 })] }
  const usedLog: string[] = []
  const tot = {
    lastSwitch: 0,
    preempt: 0,
    shieldBack: 0,
    equip: () => {
      const prev = slots[45]
      slots[totemIt.slot] = prev
      if (prev) prev.slot = totemIt.slot
      slots[45] = totemIt
      totemIt.slot = 45
      return true
    }
  }
  const ctx: any = {
    bot,
    entity: foe,
    prof: { player: true },
    guard,
    mc: { threat: () => null },
    tot,
    totemAt: 0,
    used: (s: string) => usedLog.push(s)
  }
  try {
    assert.equal(guard.stats.worn, true)
    // Low HP vs Sharp V sword -> preemptively swaps shield to totem
    await offhandTurn(ctx, { now: 1000, theirR: 2 } as any)
    assert.equal(slots[45]?.name, 'totem_of_undying')
    assert.equal(guard.stats.worn, false, 'swapping to totem clears dynamic guard.stats.worn')
    assert.equal(tot.preempt, 1)

    // High HP & safe distance -> swaps shield back into off-hand
    bot.health = 20
    foe.equipment = []
    await offhandTurn(ctx, { now: 1500, theirR: 12 } as any)
    assert.equal(slots[45]?.name, 'shield')
    assert.equal(guard.stats.worn, true, 'swapping shield back restores dynamic guard.stats.worn')
    assert.equal(tot.shieldBack, 1)
  } finally {
    guard.close()
    bot.emit('end')
    c.dispose()
  }
})

test('pvp.duel finally cleanup removes all bot listeners, ctl.onAbort, and session.tempo when duelBody throws', async () => {
  const { duel }: typeof import('../src/pvp') = require('../src/pvp')
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 10000 }))
  const bot: any = new EventEmitter()
  bot.setMaxListeners(100)
  bot._client = new EventEmitter()
  bot._client.state = 'play'
  bot._client.write = () => {}
  bot.registry = registry
  bot.version = '1.21.11'
  bot.username = 'NeuroDown'
  bot.health = 20
  bot.food = 20
  bot.game = { gameMode: 'survival', difficulty: 'normal', dimension: 'overworld' }
  bot.entity = { id: 1, type: 'player', username: 'NeuroDown', position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8, width: 0.6, eyeHeight: 1.62, metadata: [], effects: {}, attributes: {} }
  const foe: any = { id: 2, type: 'player', name: 'player', username: 'Target', uuid: 'target', isValid: true, position: new Vec3(3.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8, width: 0.6, equipment: [], metadata: [], effects: {} }
  bot.entities = { 1: bot.entity, 2: foe }
  bot.players = { Target: { entity: foe } }
  const slots = Array(46).fill(null)
  slots[36] = makeItem('diamond_sword', 36)
  bot.inventory = Object.assign(new EventEmitter(), { slots, items: () => slots.filter(Boolean) })
  bot.heldItem = slots[36]
  bot.blockAt = (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', position: p.floored(), boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.world = { getBlock: (p: Vec3) => bot.blockAt(p), raycast: () => null }
  bot.controlState = {}
  bot.setControlState = (k: string, v: boolean) => { bot.controlState[k] = v }
  bot.getControlState = (k: string) => !!bot.controlState[k]
  bot.clearControlStates = () => { for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false }
  bot.look = async () => {}
  bot.lookAt = async () => {}
  bot.equip = async (it: any) => { bot.heldItem = it }
  bot.deactivateItem = () => {}
  bot.pathfinder = Object.assign(new EventEmitter(), {
    movements: { blocksToAvoid: new Set(), exclusionAreasStep: [], exclusionAreasBreak: [], exclusionAreasPlace: [] },
    setGoal () {},
    isMoving: () => false,
    isMining: () => false,
    isBuilding: () => false
  })
  c.attach(bot)
  const session: any = { bot, current: null, mcData: registry, bus: { emit () {} } }
  const trackedEvents = ['physicsTick', 'entityHurt', 'death', 'nd_mlg', 'blockBreakProgressObserved', 'blockBreakProgressEnd', 'path_update', 'entityDead', 'message']
  const runThrowingDuel = async () => {
    const pushed: Array<() => void> = []
    const ctl: any = { aborted: false, onAbort: [] as Array<() => void> }
    const origPush = ctl.onAbort.push.bind(ctl.onAbort)
    ctl.onAbort.push = (...fns: Array<() => void>) => { pushed.push(...fns); return origPush(...fns) }
    const throwingGuard = {
      stats: { worn: false },
      melee: false,
      measure: false,
      wear: async () => { throw new Error('openDuel_boom') },
      raise: async () => false,
      watch () {},
      swung () {},
      report: () => ({})
    }
    await assert.rejects(duel(session, ctl, foe, { guard: throwingGuard, lastStand: true, timeoutSeconds: 5 }), /openDuel_boom/)
    assert.ok(pushed.length >= 1, 'duelBody registers cleanup on ctl.onAbort')
    assert.equal(ctl.onAbort.includes(pushed[0]), false, 'duelBody finally must splice its cleanup callback out of ctl.onAbort')
    assert.equal(session.tempo, null, 'session.tempo must be cleared after throw')
  }
  try {
    // First run initializes any bot-lifetime singletons (e.g. arrows.track); subsequent throwing duels must add 0 listeners.
    await runThrowingDuel()
    const baseline = Object.fromEntries(trackedEvents.map(ev => [ev, bot.listenerCount(ev)]))
    for (let i = 0; i < 3; i++) await runThrowingDuel()
    for (const ev of trackedEvents) {
      assert.equal(bot.listenerCount(ev), baseline[ev], `bot listener count for '${ev}' must not grow across throwing duels`)
    }
  } finally {
    bot.emit('end')
    c.dispose()
  }
})

test('Phase 4 physicsTick: pre-aborted duel & fight install 0 listeners; repeated aborted duels stay flat and multiplexed', async () => {
  const { duel }: typeof import('../src/pvp') = require('../src/pvp')
  const { fight }: typeof import('../src/combat') = require('../src/combat')
  const { acquireTarget }: typeof import('../src/pvp/search') = require('../src/pvp/search')
  const { createLastSeen }: typeof import('../src/pvp/last-seen') = require('../src/pvp/last-seen')
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 20000 }))
  const bot: any = new EventEmitter()
  bot.setMaxListeners(100)
  bot._client = new EventEmitter()
  bot._client.state = 'play'
  bot._client.write = () => {}
  bot.registry = registry
  bot.version = '1.21.11'
  bot.username = 'NeuroDown'
  bot.health = 20
  bot.food = 20
  bot.game = { gameMode: 'survival', difficulty: 'normal', dimension: 'overworld' }
  bot.entity = { id: 1, type: 'player', username: 'NeuroDown', position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8, width: 0.6, eyeHeight: 1.62, metadata: [], effects: {}, attributes: {} }
  const foe: any = { id: 2, type: 'player', name: 'player', username: 'Target', uuid: 'target', isValid: true, position: new Vec3(3.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8, width: 0.6, equipment: [], metadata: [], effects: {} }
  bot.entities = { 1: bot.entity, 2: foe }
  bot.players = { Target: { entity: foe } }
  const slots = Array(46).fill(null)
  slots[36] = makeItem('diamond_sword', 36)
  bot.inventory = Object.assign(new EventEmitter(), { slots, items: () => slots.filter(Boolean) })
  bot.heldItem = slots[36]
  bot.blockAt = (p: Vec3) => ({ name: p.y < 64 ? 'stone' : 'air', position: p.floored(), boundingBox: p.y < 64 ? 'block' : 'empty', shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.world = { getBlock: (p: Vec3) => bot.blockAt(p), raycast: () => null }
  bot.controlState = {}
  bot.setControlState = (k: string, v: boolean) => { bot.controlState[k] = v }
  bot.getControlState = (k: string) => !!bot.controlState[k]
  bot.clearControlStates = () => { for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false }
  bot.look = async () => {}
  bot.lookAt = async () => {}
  bot.equip = async (it: any) => { bot.heldItem = it }
  bot.deactivateItem = () => {}
  bot.pathfinder = Object.assign(new EventEmitter(), {
    movements: { blocksToAvoid: new Set(), exclusionAreasStep: [], exclusionAreasBreak: [], exclusionAreasPlace: [] },
    setGoal () {},
    isMoving: () => false,
    isMining: () => false,
    isBuilding: () => false
  })
  c.attach(bot)
  const session: any = { bot, current: null, mcData: registry, bus: { emit () {} } }
  const noopGuard = {
    stats: { worn: false },
    melee: false,
    measure: false,
    wear: async () => {},
    raise: async () => false,
    watch () {},
    swung () {},
    report: () => ({})
  }
  try {
    // 1. Pre-aborted acquireTarget must not return an entity even when foe is visible.
    const vision = createLastSeen(bot)
    try {
      const acq = await acquireTarget(bot, { aborted: true, onAbort: [] }, vision, foe, { deadline: 30000 })
      assert.equal(acq.entity, null, 'pre-aborted acquireTarget must return null entity')
    } finally { vision.close() }

    // 2. Pre-aborted duel & fight install 0 physicsTick listeners (prevents 31k zombie overlap).
    const beforePreAborted = bot.listenerCount('physicsTick')
    const preCtl: any = { aborted: true, onAbort: [] }
    const dRes = await duel(session, preCtl, foe, { guard: noopGuard, lastStand: true, timeoutSeconds: 5 })
    assert.equal(dRes.aborted, true)
    assert.equal(preCtl.onAbort.length, 0, 'pre-aborted duel must not push onto ctl.onAbort')
    assert.equal(bot.listenerCount('physicsTick'), beforePreAborted, 'pre-aborted duel must add 0 physicsTick listeners')

    const fCtl: any = { aborted: true, onAbort: [] }
    const fRes = await fight(session, fCtl, { target: 'Target', allowPlayer: true, lastStand: true })
    assert.equal(fRes.aborted, true)
    assert.equal(bot.listenerCount('physicsTick'), beforePreAborted, 'pre-aborted fight must add 0 physicsTick listeners')

    // 3. Abort during openDuel (simulating cancelled fight #1) + repeated duels must NOT accumulate physicsTick listeners,
    // and in-duel physicsTick count must stay compact via onDuelTick multiplexing (<= 9 temporary listeners).
    let peakDuringDuel = 0
    const runAbortedInOpen = async () => {
      const ctl: any = {
        aborted: false,
        onAbort: [] as Array<() => void>,
        abort () { if (!this.aborted) { this.aborted = true; for (const fn of [...this.onAbort]) fn() } }
      }
      const abortingGuard = {
        ...noopGuard,
        wear: async () => {
          peakDuringDuel = Math.max(peakDuringDuel, bot.listenerCount('physicsTick'))
          ctl.abort()
        }
      }
      const r = await duel(session, ctl, foe, { guard: abortingGuard, lastStand: true, timeoutSeconds: 5 })
      assert.equal(r.aborted, true)
    }
    await runAbortedInOpen()
    const baseAfterWarmup = bot.listenerCount('physicsTick')
    peakDuringDuel = 0
    for (let i = 0; i < 8; i++) await runAbortedInOpen()
    assert.equal(bot.listenerCount('physicsTick'), baseAfterWarmup, '8 repeated aborted duels must leave 0 leaked physicsTick listeners')
    assert.ok(peakDuringDuel - baseAfterWarmup <= 9, `multiplexed duel must add <= 9 temporary physicsTick listeners (got ${peakDuringDuel - baseAfterWarmup})`)
  } finally {
    bot.emit('end')
    c.dispose()
  }
})

test('Phase 4 physicsTick: retarget after abort/cleanup and duo.ehpOf after close do not leak trackFoe listeners', () => {
  const { installTarget }: typeof import('../src/pvp/duel-target') = require('../src/pvp/duel-target')
  const co: typeof import('../src/pvp/combat-observe') = require('../src/pvp/combat-observe')
  const duoMod: typeof import('../src/duo') = require('../src/duo')
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 30000 }))
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = registry
  bot.entity = { id: 1, type: 'player', username: 'NeuroDown', position: new Vec3(0, 64, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8, width: 0.6, metadata: [] }
  const foeA: any = { id: 2, type: 'player', username: 'FoeA', isValid: true, position: new Vec3(3, 64, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8, width: 0.6, metadata: [], equipment: [] }
  const foeB: any = { id: 3, type: 'player', username: 'FoeB', isValid: true, position: new Vec3(4, 64, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8, width: 0.6, metadata: [], equipment: [] }
  bot.entities = { 1: bot.entity, 2: foeA, 3: foeB }
  try {
    const base = bot.listenerCount('physicsTick')
    const calc0 = co.trackFoe(bot, foeA, { honest: true, visible: () => true })
    const ctx: any = {
      bot,
      ctl: { aborted: true },
      _cleaned: true,
      entity: foeA,
      calc: calc0,
      co,
      blockedShotTargets: {},
      guard: null,
      opts: {},
      pathTo () {},
      pickWeaponFor () {},
      st: { swings: 0, landed: 0, bowProg: [] },
      vision: { observe: (e: any) => e, visible: () => true }
    }
    installTarget(ctx)
    calc0.stop()
    assert.equal(bot.listenerCount('physicsTick'), base)
    // Must be ignored once ctl.aborted / ctx._cleaned — zero new trackFoe physicsTick listeners!
    ctx.retarget(foeB)
    assert.equal(ctx.entity, foeA, 'retarget after abort/cleanup must be a no-op')
    assert.equal(bot.listenerCount('physicsTick'), base, 'retarget after abort/cleanup must not leak trackFoe physicsTick listener')

    // duo.close() removes its physicsTick + hpTrackers cleanly and subsequent step/secondThreat stay no-op.
    const duo = duoMod.create(bot, {
      target: () => foeA,
      attackers: new Map([[foeB.id, { e: foeB, at: 30000, n: 1 }]]),
      dead: new Set(),
      used () {},
      tt: { state: () => ({}), foes: new Map() },
      observe: (e: any) => e,
      holdWeapon: async () => {},
      setAim () {},
      potionOf: () => null
    })
    assert.ok(bot.listenerCount('physicsTick') > base)
    duo.close()
    assert.equal(bot.listenerCount('physicsTick'), base, 'duo.close() must return physicsTick listener count to baseline')
    assert.equal(duo.secondThreat(), false)
    assert.equal(bot.listenerCount('physicsTick'), base)
  } finally {
    bot.emit('end')
    c.dispose()
  }
})




