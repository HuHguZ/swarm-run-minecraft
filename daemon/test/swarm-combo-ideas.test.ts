import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { strike, runMeleeCombo, debuffOpening, splashMedic } from '../src/swarm/combos/ideas'

const potion = (kind: string, slot = 37) => ({ name: 'splash_potion', type: 500, slot, count: 1,
  componentMap: new Map([['potion_contents', { data: { potionId: kind } }]]) })
const foe = (x = 2) => {
  const e: any = { id: 2, username: 'enemy', type: 'player', name: 'player', position: new Vec3(x, 64, 0), width: .6, height: 1.8, metadata: [] }
  Object.defineProperty(e, 'health', { get() { throw new Error('hidden enemy HP') } })
  return e
}
function fixture(items: any[] = [{ name: 'iron_sword', slot: 36, type: 1 }]) {
  const bot: any = new EventEmitter()
  let tick = 0, wall = false
  const attacks: Array<{ tick: number; name: string; id: number }> = [], uses: string[] = []
  bot.username = 'blue'
  bot.entity = { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), metadata: [], onGround: true }
  bot.entities = {}; bot.heldItem = items[0]
  bot.inventory = { slots: [], items: () => items }
  bot.blockAt = p => ({ name: wall ? 'stone' : 'air', boundingBox: wall ? 'block' : 'empty', position: p,
    shapes: wall ? [[0, 0, 0, 1, 1, 1]] : [] })
  bot.world = { raycast(from, direction, length) {
    const t = direction.y < 0 ? (64 - from.y) / direction.y : Infinity
    return t >= 0 && t <= length ? { intersect: from.plus(direction.scaled(t)), position: from.plus(direction.scaled(t)).floored() } : null
  } }
  bot.lookAt = async () => {}; bot.look = async () => {}; bot.deactivateItem = () => {}
  bot.equip = async item => { bot.heldItem = item }
  bot.waitForTicks = async n => { tick += n }
  bot.attack = e => attacks.push({ tick, name: bot.heldItem.name, id: e.id })
  bot.activateItem = () => uses.push(bot.heldItem.componentMap?.get('potion_contents')?.data?.potionId)
  return { bot, attacks, uses, tick: () => tick, wall: () => { wall = true } }
}

test('idea strike uses the visible hitbox and never reads enemy HP', async () => {
  const f = fixture()
  assert.equal((await strike(f.bot, foe())).sent, true)
  assert.equal(f.attacks.length, 1)
})
test('idea strike rechecks a wall that appeared while aiming', async () => {
  const f = fixture(); f.bot.lookAt = async () => f.wall()
  assert.equal((await strike(f.bot, foe())).sent, false)
  assert.equal(f.attacks.length, 0)
})
test('idea strike refuses a public teammate', async () => {
  const f = fixture(); f.bot._ndSwarmAllies = ['enemy']
  assert.equal((await strike(f.bot, foe())).sent, false)
  assert.equal(f.attacks.length, 0)
})
test('idea strike rechecks a target that joined our team while aiming', async () => {
  const f = fixture(); f.bot.lookAt = async () => { f.bot._ndSwarmAllies = ['enemy'] }
  assert.equal((await strike(f.bot, foe())).sent, false)
  assert.equal(f.attacks.length, 0)
})
test('stagger control leaves ten ticks between allies and full personal recharge', async () => {
  const a = fixture(), b = fixture()
  await Promise.all([runMeleeCombo(a.bot, foe(), { kind: 'stagger', index: 0, count: 2, rounds: 2 }),
    runMeleeCombo(b.bot, foe(), { kind: 'stagger', index: 1, count: 2, rounds: 2 })])
  assert.deepEqual([...a.attacks, ...b.attacks].map(a => a.tick).sort((a, b) => a - b), [25, 35, 45, 55])
})
test('axe front chooses an axe for the first slot and swords for focus', async () => {
  const items = [{ name: 'iron_sword', slot: 36, type: 1 }, { name: 'iron_axe', slot: 37, type: 2 }]
  const a = fixture(items), b = fixture(items)
  await runMeleeCombo(a.bot, foe(), { kind: 'shield-break', index: 0, count: 3, rounds: 2 })
  await runMeleeCombo(b.bot, foe(), { kind: 'shield-break', index: 1, count: 3, rounds: 2 })
  assert.deepEqual(a.attacks.map(a => [a.tick, a.name]), [[25, 'iron_axe'], [55, 'iron_axe']])
  assert.deepEqual(b.attacks.map(a => [a.tick, a.name]), [[35, 'iron_sword'], [65, 'iron_sword']])
})
test('cancelling during warmup sends no experimental attack', async () => {
  const f = fixture(), ctl = { aborted: false }
  f.bot.waitForTicks = async () => { ctl.aborted = true }
  const r = await runMeleeCombo(f.bot, foe(), { kind: 'stagger', index: 0, count: 2, ctl })
  assert.equal(r.sent, 0); assert.equal(f.attacks.length, 0)
})
test('debuff opening keeps the assault group outside the splash before entry', async () => {
  const f = fixture([potion('weakness')])
  const r = await debuffOpening(f.bot, foe(5), { kind: 'weakness', allies: [{ position: new Vec3(4, 64, 0) }] })
  assert.equal(r.thrown, false); assert.equal(f.uses.length, 0)
})
for (const kind of ['weakness', 'slowness'] as const) test(`${kind} opening can pass two allies behind the thrower to reach a six-block target`, async () => {
  const f = fixture([potion(kind)]), originalBlock = f.bot.blockAt
  const allies = [-1, 1].map((z, i) => ({ id: 3 + i, username: `ally${i}`, name: 'player', type: 'player', isValid: true,
    position: new Vec3(-3, 64, z), velocity: new Vec3(0, 0, 0), onGround: true, width: .6, height: 1.8, metadata: [] }))
  f.bot._ndSwarmAllies = allies.map(e => e.username)
  for (const ally of allies) f.bot.entities[ally.id] = ally
  f.bot.blockAt = p => p.y < 64 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p } : originalBlock(p)
  let jumping = false
  f.bot.setControlState = (name, value) => { if (name === 'jump') jumping = value }
  const timer = setInterval(() => {
    if (jumping && f.bot.entity.onGround) { f.bot.entity.position = f.bot.entity.position.offset(0, .42, 0); f.bot.entity.onGround = false }
    f.bot.emit('physicsTick')
  }, 2)
  try {
    const r = await debuffOpening(f.bot, foe(6), { kind, allies })
    assert.equal(r.thrown, true, r.why); assert.deepEqual(f.uses, [kind])
  } finally { clearInterval(timer) }
})
test('debuff opening refreshes allies that entered during potion equip', async () => {
  const f = fixture([potion('weakness')]); f.bot.heldItem = null
  f.bot.equip = async item => {
    f.bot.heldItem = item; f.bot._ndSwarmAllies = ['late']
    f.bot.entities[3] = { id: 3, username: 'late', name: 'player', type: 'player', isValid: true,
      position: new Vec3(5.46, 64, .5), velocity: new Vec3(0, 0, 0), width: .6, height: 1.8, metadata: [] }
  }
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    assert.equal((await debuffOpening(f.bot, foe(5.46), { kind: 'weakness' })).thrown, false)
    assert.equal(f.uses.length, 0)
  } finally { clearInterval(timer) }
})
test('debuff opening refuses a stale slot that selected harming instead', async () => {
  const f = fixture([potion('weakness')]); f.bot.heldItem = null
  f.bot.equip = async () => { f.bot.heldItem = potion('strong_harming') }
  const r = await debuffOpening(f.bot, foe(5.46), { kind: 'weakness' })
  assert.equal(r.thrown, false); assert.equal(r.why, 'wrong_potion'); assert.equal(f.uses.length, 0)
})
test('debuff opening rechecks a target that joined our team while equipping the potion', async () => {
  const f = fixture([potion('weakness')]); f.bot.heldItem = null
  f.bot.equip = async item => { f.bot.heldItem = item; f.bot._ndSwarmAllies = ['enemy'] }
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    const r = await debuffOpening(f.bot, foe(5.46), { kind: 'weakness' })
    assert.equal(r.thrown, false); assert.equal(f.uses.length, 0)
  } finally { clearInterval(timer) }
})
test('debuff opening executes the existing ballistic throw against a distant visible target', async () => {
  const f = fixture([potion('weakness')])
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    const r = await debuffOpening(f.bot, foe(5.46), { kind: 'weakness' })
    assert.equal(r.thrown, true, r.why)
    assert.deepEqual(f.uses, ['weakness'])
  } finally { clearInterval(timer) }
})
test('debuff opening uses the existing jump launch when a six-block floor throw is unreachable', async () => {
  const f = fixture([potion('weakness')]), originalBlock = f.bot.blockAt
  const spectator = foe(3.5); spectator.id = 3; spectator.username = 'spectator'; spectator.position.z = .6
  f.bot.entities[3] = spectator; f.bot.players = { spectator: { gamemode: 3 } }
  f.bot.blockAt = p => p.y < 64 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p } : originalBlock(p)
  let jumping = false
  f.bot.setControlState = (name, value) => { if (name === 'jump') jumping = value }
  const timer = setInterval(() => {
    if (jumping && f.bot.entity.onGround) {
      f.bot.entity.position = f.bot.entity.position.offset(0, .42, 0)
      f.bot.entity.onGround = false
    }
    f.bot.emit('physicsTick')
  }, 2)
  try {
    const r = await debuffOpening(f.bot, foe(6), { kind: 'weakness' })
    assert.equal(r.thrown, true, r.why)
    assert.equal(r.jump, 'stand')
    assert.equal(r.airborne, true)
    assert.ok(Math.abs(r.moved.y - .42) < 1e-8)
    assert.deepEqual(f.uses, ['weakness'])
  } finally { clearInterval(timer) }
})
test('debuff opening refuses native five-block front-body splash that reaches the thrower', async () => {
  const f = fixture([potion('weakness')])
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    const r = await debuffOpening(f.bot, foe(5), { kind: 'weakness' })
    assert.equal(r.thrown, false); assert.equal(r.why, 'unverified_entity_impact'); assert.equal(f.uses.length, 0)
  } finally { clearInterval(timer) }
})
test('debuff opening refuses a nearby visible body intercepting the six-block jump shot', async () => {
  const f = fixture([potion('weakness')]), originalBlock = f.bot.blockAt
  f.bot.blockAt = p => p.y < 64 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p } : originalBlock(p)
  const interceptor = foe(3.5); interceptor.id = 3; interceptor.username = 'bystander'; interceptor.position.z = .6
  f.bot.entities[3] = interceptor
  let jumping = false
  f.bot.setControlState = (name, value) => { if (name === 'jump') jumping = value }
  const timer = setInterval(() => {
    if (jumping && f.bot.entity.onGround) {
      f.bot.entity.position = f.bot.entity.position.offset(0, .42, 0)
      f.bot.entity.onGround = false
    }
    f.bot.emit('physicsTick')
  }, 2)
  try {
    const r = await debuffOpening(f.bot, foe(6), { kind: 'weakness' })
    assert.equal(r.thrown, false); assert.equal(r.why, 'unverified_entity_impact'); assert.equal(f.uses.length, 0)
  } finally { clearInterval(timer) }
})
test('group medic refuses to heal an enemy in the allied cluster', async () => {
  const f = fixture([potion('strong_healing')])
  const allies = [{ position: new Vec3(2, 64, 0), health: 10 }, { position: new Vec3(2.5, 64, 0), health: 8 }]
  const r = await splashMedic(f.bot, allies, [foe(3)])
  assert.equal(r.thrown, false); assert.equal(f.uses.length, 0)
})
test('group medic refuses an enemy intercepting the launch before the separated cluster', async () => {
  const f = fixture([potion('strong_healing')])
  const allies = [{ position: new Vec3(5, 64, 0), health: 10 }, { position: new Vec3(5.5, 64, 0), health: 8 }]
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    const r = await splashMedic(f.bot, allies, [foe(.25)])
    assert.equal(r.thrown, false); assert.equal(f.uses.length, 0)
  } finally { clearInterval(timer) }
})
test('group medic protects an enemy hitbox below the splash even when its feet are outside the sphere', async () => {
  const f = fixture([potion('strong_healing')])
  const allies = [{ position: new Vec3(5, 64, 0), health: 10 }, { position: new Vec3(5.5, 64, 0), health: 8 }]
  const enemy = foe(9.2); enemy.position.y = 61.5
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    const r = await splashMedic(f.bot, allies, [enemy])
    assert.equal(r.thrown, false); assert.equal(f.uses.length, 0)
  } finally { clearInterval(timer) }
})
test('group medic throws one healing potion for two injured allies after enemy separation', async () => {
  const f = fixture([potion('strong_healing')])
  const allies = [{ position: new Vec3(2, 64, 0), health: 10 }, { position: new Vec3(2.5, 64, 0), health: 8 }]
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    const r = await splashMedic(f.bot, allies, [foe(12)])
    assert.equal(r.thrown, true, r.why)
    assert.deepEqual(f.uses, ['strong_healing'])
  } finally { clearInterval(timer) }
})

test('group medic cancels when a new visible enemy enters the cluster during potion equip', async () => {
  const f = fixture([potion('strong_healing')]), enemy = foe(2.25)
  enemy.position.z = 1.5; f.bot.heldItem = null
  f.bot.equip = async item => { f.bot.heldItem = item; f.bot.entities[enemy.id] = enemy }
  const allies = [{ position: new Vec3(2, 64, 0), health: 10 }, { position: new Vec3(2.5, 64, 0), health: 8 }]
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    assert.equal((await splashMedic(f.bot, allies, [])).thrown, false)
    assert.equal(f.uses.length, 0)
  } finally { clearInterval(timer) }
})

test('group medic refreshes public allegiance after equip without reading the former ally HP', async () => {
  const f = fixture([potion('strong_healing')])
  const allies = [[2, 0], [2, 1], [2.5, -.5]].map(([x, z], i) => ({ id: 3 + i, username: `friend${i}`, type: 'player', name: 'player',
    position: new Vec3(x, 64, z), health: 8, width: .6, height: 1.8, metadata: [] }))
  f.bot._ndSwarmAllies = allies.map(e => e.username); f.bot.heldItem = null
  f.bot.equip = async item => {
    f.bot.heldItem = item; f.bot._ndSwarmAllies = allies.slice(1).map(e => e.username)
    Object.defineProperty(allies[0], 'health', { get() { throw Error('former ally HP is now private') } })
  }
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    assert.equal((await splashMedic(f.bot, allies, [])).thrown, false)
    assert.equal(f.uses.length, 0)
  } finally { clearInterval(timer) }
})

for (const kind of ['hidden_player', 'unrelated_mob']) test(`group medic ignores ${kind} newly observed during equip`, async () => {
  const f = fixture([potion('strong_healing')]), other = foe(2.25), blockAt = f.bot.blockAt
  other.position.z = 2; f.bot.heldItem = null
  if (kind === 'unrelated_mob') { other.username = undefined; other.type = 'mob'; other.name = 'cow' }
  else f.bot.blockAt = p => p.z >= 1 ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], position: p } : blockAt(p)
  f.bot.equip = async item => { f.bot.heldItem = item; f.bot.entities[other.id] = other }
  const allies = [{ position: new Vec3(2, 64, 0), health: 10 }, { position: new Vec3(2.5, 64, 0), health: 8 }]
  const timer = setInterval(() => f.bot.emit('physicsTick'), 2)
  try {
    assert.equal((await splashMedic(f.bot, allies, [])).thrown, true)
    assert.deepEqual(f.uses, ['strong_healing'])
  } finally { clearInterval(timer) }
})
