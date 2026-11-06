import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { GameClock, bind } from '../src/game-clock'
import { installMelee } from '../src/pvp/duel-melee'
import { strikeTurn } from '../src/pvp/turn-melee'

function fixture(t, { held = 'netherite_sword', weapon = true, hurtAgo = null, knownRaw = null, slot = 0, visible = true, distance = 2.4, using = false }: any = {}) {
  const clock = new GameClock({ manual: true, epoch: 10000 })
  bind({ ndClock: clock })
  const sent = [], sword = { name: 'netherite_sword', slot: 36, count: 1 }, bot: any = new EventEmitter()
  Object.assign(bot, { username: 'NeuroFarm31e', entity: { id: 1, position: new Vec3(0, 120, 0), velocity: new Vec3(0, .3, -.4), onGround: true, yaw: 0, pitch: 0 },
    inventory: { slots: weapon ? Object.assign([], { 36: sword }) : [] }, heldItem: held ? { name: held, slot: 36, count: 1 } : null,
    quickBarSlot: 0, game: { serverBrand: 'Paper' }, getControlState: () => false, setControlState: () => {},
    _ndUse: { cur: using ? { name: 'bread' } : null, endedAt: -1e9 }, _client: new EventEmitter() })
  bot._client.write = (name, data) => { sent.push({ name, data, held: bot.heldItem?.name ?? null }); return true }
  bot.attack = e => bot._client.write('use_entity', { target: e.id, mouse: 1 })
  const foe: any = { id: 2, type: 'player', username: 'RedUcounter', position: new Vec3(0, 120, distance), width: .6, height: 1.8 }
  let hiddenReads = 0
  Object.defineProperty(foe, 'health', { get() { hiddenReads++; throw Error('hidden player HP') } })
  const notes = [], targetHurtAt = hurtAgo === null ? 0 : clock.now() - hurtAgo
  const ctx: any = { bot, entity: foe, ctl: { aborted: false }, weapon: weapon ? sword : null, st: { swings: 0 }, used: s => notes.push(s), prof: { player: true },
    vision: { visible: () => visible }, targetHurtAt, targetHurtBy: hurtAgo === null ? null : 'Ally',
    strikeSlot: slot, strikeSlotAt: clock.now() + 250, foeEst: { iframe: { known: knownRaw === null ? null : { at: targetHurtAt, raw: knownRaw } } },
    session: { current: { name: 'fight', params: { target: foe.username, shoveAt: { x: 0, y: 120, z: 4 } } } },
    holdWeapon: async () => { ctx.restores = (ctx.restores || 0) + 1; bot.heldItem = sword }, combo: { note() {} },
    ready: () => false, rest() {}, TRACE: false, trace() {}, hitKind: 'sprint', opts: {} }
  installMelee(ctx)
  ctx.mf.skill.counter = 1; ctx.mf.skill.jumpReset = 0
  t.after(() => { ctx.mf.close(); clock.dispose(); assert.equal(hiddenReads, 0) })
  return { ctx, bot, clock, notes, packets: () => sent.filter(p => p.name === 'use_entity'), async velocity() {
    const raw = Buffer.alloc(7); raw[0] = 1
    bot._client.emit('raw.entity_velocity', raw)
    await new Promise<any>(resolve => setImmediate(resolve))
  } }
}

for (const held of [null, 'water_bucket', 'cobblestone']) test(`counter defers a changed ${held || 'AIR'} hand to the ordinary weapon restore`, async t => {
  const f = fixture(t, { held })
  f.ctx.strikeSlotAt = 0
  await f.velocity()
  assert.equal(f.packets().length, 0)
  assert.equal(f.ctx.restores, undefined, 'the synchronous counter does not take equipment ownership')
  assert.equal(f.ctx.strikeSlotAt, 0, 'bad hand does not refresh or claim an allied strike slot')
})

for (const bare of [false, true]) test(`counter respects a known stronger ally hit with ${bare ? 'bare hand' : 'sword'}`, async t => {
  const f = fixture(t, { held: bare ? null : 'netherite_sword', weapon: !bare, hurtAgo: 50, knownRaw: 38 })
  await f.velocity()
  assert.equal(f.packets().length, 0)
  f.clock.advanceTicks(10)
  await f.velocity()
  assert.equal(f.packets().length, 1, 'the same counter works after the native damage window')
})

test('counter shares unknown-receipt wait, known lower-raw excess and allied slot delay', async t => {
  const found = []
  for (const opts of [{ hurtAgo: 50 }, { hurtAgo: 50, knownRaw: 4 }, { hurtAgo: 50, knownRaw: 4, slot: 1 }, { hurtAgo: 550, slot: 1 }]) {
    const f = fixture(t, opts)
    await f.velocity(); found.push(f.packets().length)
  }
  assert.deepEqual(found, [0, 1, 0, 0])
})

test('ordinary armed and bare counters retain physical, item-use and cooldown guards', async t => {
  const found = []
  for (const opts of [{}, { held: null, weapon: false }, { distance: 6 }, { visible: false }, { using: true }, { uncharged: true }]) {
    const f = fixture(t, opts)
    if (opts.uncharged) f.ctx.mf.clock.resetAt = f.clock.now()
    f.ctx.strikeSlotAt = 0
    await f.velocity(); found.push(f.packets().length)
    if (f.packets().length === 0) assert.equal(f.ctx.strikeSlotAt, 0, 'physical/use/cooldown veto runs before allied slot work')
  }
  assert.deepEqual(found, [1, 1, 0, 0, 0, 0])
})

test('normal strike restores its hand and edgeSpam keeps the target iframe veto', async t => {
  const a = fixture(t, { held: null }), frame: any = { canHit: true, r: 2.4, theirR: 2.4, cdHit: 0, cooldownLeft: 0,
    iframes: 0, inSight: true, now: a.clock.now(), owMelee: null, race: false, closing: 0, intoShield: false }
  await strikeTurn(a.ctx, frame)
  assert.equal(a.packets().length, 0); assert.equal(a.ctx.restores, 1)
  const b = fixture(t, { held: null, weapon: false, hurtAgo: 50, knownRaw: 38 })
  await strikeTurn(b.ctx, { ...frame, canHit: false, iframes: 450, cooldownLeft: 100, edgeHit: 'hit' })
  assert.equal(b.packets().length, 0)
})

for (const bare of [false, true]) test(`queued counter respects cancellation and close with ${bare ? 'bare hand' : 'sword'}`, async t => {
  for (const nextIntent of ['flee', 'rearm', 'closed']) {
    const f = fixture(t, { held: bare ? null : 'netherite_sword', weapon: !bare })
    f.ctx.strikeSlotAt = 0
    const pending = f.velocity()
    if (nextIntent === 'closed') f.ctx.mf.close()
    else { f.ctx.ctl.aborted = true; f.ctx.session.current = { name: nextIntent, params: {} } }
    await pending
    assert.equal(f.packets().length, 0, `a queued old counter cannot attack during ${nextIntent}`)
    assert.equal(f.ctx.strikeSlotAt, 0)
  }
})
