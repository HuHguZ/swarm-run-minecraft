import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'
import { hazardMethods } from '../src/rpc/hazards'
import { createTickPlugins } from '../src/tick-plugins'
import { testBot, testClock, data, block } from './tick-plugins-fixture'
import { installDangers } from '../../farm/arena/dangers'

function scene() {
  const bot = testBot(), clock = testClock(), cells = new Map(), hits = []
  const at = new Vec3(3, 64, 0), ctl: any = { aborted: false, onAbort: [] }
  bot.entity.position = new Vec3(.5, 64, .5)
  const ally = { id: 2, username: 'Ward', type: 'player', name: 'player', position: at.offset(.5, 0, .5), height: 1.8, width: .6, metadata: [] }
  bot.players = { Ward: { entity: ally } }; bot.entities[ally.id] = ally
  const sword = { name: 'iron_sword', type: data.itemsByName.iron_sword.id, count: 1, slot: 36, enchants: [] }
  bot.inventory.slots[36] = sword; bot.heldItem = null
  bot.clearControlStates = () => {}; bot.equip = async item => { bot.heldItem = item }
  bot.lookAt = async () => {}
  const set = (p, name) => cells.set(p.toString(), name)
  bot.blockAt = p => { const name = cells.get(p.floored().toString()) || (p.y < 64 ? 'stone' : 'air'); return name === 'unloaded' ? null : block(name, p) }
  bot._updateBlockState = (p, state) => {
    const old = bot.blockAt(p)
    set(p, data.blocksByStateId[state].name)
    bot.emit('blockUpdate:' + p, old, bot.blockAt(p))
  }
  createTickPlugins(clock).plugins.digging(bot)
  bot.digTime = () => 100
  const confirm = (p, name) => { set(p, name); bot._client.emit('block_change', { location: p, type: data.blocksByName[name].defaultState }) }
  bot._client.write = (key, packet) => { if (key === 'block_dig') hits.push(packet) }
  const session = { require: () => bot, runIntent: (_name, fn) => fn(ctl) }
  const cut = (params = { target: 'Ward' }) => hazardMethods({ session, gameClock: clock } as any).cut_ally_web(params)
  return { bot, hits, at, ally, set, confirm, clock, ctl, cut }
}

for (const situation of ['free', 'wall', 'unloaded']) test('helper needs a personal view before reporting a free ally: ' + situation, async () => {
  const f = scene()
  if (situation === 'wall') for (let y = 63; y < 67; y++) f.set(new Vec3(1, y, 0), 'stone')
  if (situation === 'unloaded') f.set(f.at, 'unloaded')
  const r = await f.cut()
  assert.equal(r.ok, situation === 'free'); assert.equal(r.cut, 0)
  if (r.ok) assert.equal(r.alreadyFree, true)
  assert.equal(f.hits.length, 0); f.bot.emit('end')
})

for (const receipt of ['air', 'cobweb']) test('ally web uses the visible native dig face and exact server response: ' + receipt, async () => {
  const f = scene(); f.set(f.at, 'cobweb')
  let ended = false
  const run = f.cut().then(r => { ended = true; return r })
  await new Promise(resolve => setImmediate(resolve))
  await f.clock.advanceGame(200)
  assert.equal(f.bot.blockAt(f.at).name, 'air', 'Mineflayer has predicted the cut')
  assert.equal(ended, false, 'client air without a matching packet is not a rescue')
  f.confirm(f.at.offset(0, 0, 1), 'air')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ended, false, 'another cell cannot confirm the cut')
  f.confirm(f.at, receipt)
  const r = await run, west = require('prismarine-world').iterators.BlockFace.WEST
  assert.deepEqual(f.hits.map(h => [h.status, h.face]), [[0, west], [2, west]])
  assert.equal(r.ok, receipt === 'air')
  assert.equal(r.cut, receipt === 'air' ? 1 : 0)
  assert.equal(f.bot._client.listenerCount('block_change'), 0)
  f.bot.emit('end')
})

test('a helper sees the head above cover, but cannot certify hidden feet as free or trapped', async () => {
  for (const floor of ['air', 'cobweb']) {
    const f = scene(); f.set(f.at, floor); f.set(new Vec3(2, 64, 0), 'stone')
    const r = await f.cut()
    assert.equal(r.ok, false); assert.equal(r.why, 'не вижу его целиком'); assert.equal(r.cut, 0)
    assert.equal(f.hits.length, 0); f.bot.emit('end')
  }
})

test('a visible cobweb eleven blocks away is not cut on radio range alone', async () => {
  const f = scene(); f.ally.position.x = 11.5; f.set(f.ally.position.floored(), 'cobweb')
  const r = await f.cut()
  assert.equal(r.ok, false); assert.equal(r.why, 'не достаю'); assert.equal(f.hits.length, 0)
  f.bot.emit('end')
})

test('a helper aborts the native cut when the ally leaves its web during the swing', async () => {
  const f = scene(); f.set(f.at, 'cobweb')
  const run = f.cut()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.hits.map(h => h.status), [0])
  f.ally.position.z += 2; f.bot.emit('physicsTick')
  const r = await run
  assert.equal(r.ok, false); assert.equal(r.cut, 0)
  assert.deepEqual(f.hits.map(h => h.status), [0, 1])
  assert.equal(f.bot._client.listenerCount('block_change'), 0); assert.equal(f.ctl.onAbort.length, 0)
  f.bot.emit('end')
})

for (const change of ['moves during equip', 'cancel during look', 'helper displaced during look']) test('stale rescue sends no dig start: ' + change, async () => {
  const f = scene(); f.set(f.at, 'cobweb')
  if (change === 'moves during equip') f.bot.equip = async item => { f.bot.heldItem = item; f.ally.position.x += 2 }
  else if (change === 'cancel during look') f.bot.lookAt = async () => { f.ctl.aborted = true; for (const stop of [...f.ctl.onAbort]) stop() }
  else f.bot.lookAt = async () => { f.bot.entity.position.z += .2 }
  const run = f.cut()
  await new Promise(resolve => setImmediate(resolve)); await f.clock.advanceGame(200)
  f.confirm(f.at, 'air')
  await run
  assert.equal(f.hits.length, 0)
  f.bot.emit('end')
})

for (const situation of ['near', 'walk', 'wall', 'already free']) test('arena distress through native ally dig: ' + situation, async t => {
  const f = scene(), calls = [], log: string[] = []
  t.after(() => f.bot.emit('end'))
  const settle = () => new Promise(resolve => setImmediate(resolve))
  const walking = situation === 'walk' || situation === 'already free'
  const start = f.bot.entity.position.clone()
  if (walking) f.bot.entity.position.x = -7.5 // Eleven blocks from Ward.
  f.set(f.at, 'cobweb')
  if (situation === 'wall') for (let y = 63; y < 67; y++) f.set(new Vec3(1, y, 0), 'stone')
  let arrive!: () => void, release!: () => void
  const ward: any = { name: 'Ward', team: 'blue', c: { async call(method, params) {
    calls.push({ actor: 'Ward', method, params })
    if (method === 'swarm_hold') await new Promise<void>(resolve => { release = resolve })
    return { status: 'done', detail: {} }
  } } }
  const helper: any = { name: 'Helper', team: 'blue', c: { async call(method, params) {
    calls.push({ actor: 'Helper', method, params })
    const action = helper.last = { m: method, p: params, pending: true }
    try {
      if (method === 'goto') {
        await new Promise<void>(resolve => { arrive = resolve })
        f.bot.entity.position.set(start.x, start.y, start.z)
        return { status: 'done', detail: { arrived: start } }
      }
      assert.equal(method, 'cut_ally_web')
      return { status: 'done', detail: await f.cut(params) }
    } finally { action.pending = false }
  } } }
  const ctx: any = { bots: [ward, helper], round: 1, pos: {
    Ward: { p: f.ally.position, inv: {}, offHand: { item: 'shield' } },
    Helper: { p: f.bot.entity.position, inv: { iron_sword: 1 } } },
    alive: () => true, busy: new Set(), out: new Set(), deadNow: new Set(), enemiesOf: () => [], log: line => log.push(line) }
  installDangers(ctx)
  const report = web => ward.c.onDanger({ pos: f.ally.position, dangers: { web: web ? [{ at: f.at, cells: 1 }] : [],
    aims: [{ name: 'Bow', weapon: 'bow', at: { x: 18, y: 64, z: 0 } }] } })
  report(true); report(true)
  assert.equal(ward.webHelper, helper); assert.equal(ctx.busy.has(helper.name), true)
  assert.deepEqual(calls.filter(c => c.actor === 'Ward').map(c => [c.method, c.params.whileWebbed]), [['swarm_hold', true]])
  if (walking) {
    assert.deepEqual(calls.filter(c => c.actor === 'Helper').map(c => c.method), ['goto'])
    if (situation === 'already free') f.confirm(f.at, 'air')
    arrive()
  }
  await settle()
  if (situation === 'near' || situation === 'walk') {
    assert.equal(f.bot.heldItem?.name, 'iron_sword')
    assert.deepEqual(f.hits.map(p => p.status), [0])
    report(true)
    await f.clock.advanceGame(200)
    assert.deepEqual(f.hits.map(p => p.status), [0, 2])
    assert.equal(log.some(line => line.includes('Helper → Ward: вырезал')), false)
    f.confirm(f.at, 'air')
  } else assert.equal(f.hits.length, 0)
  await settle()
  const finished = log.filter(line => line.includes('Helper → Ward:'))
  assert.equal(finished.length, 1)
  assert.match(finished[0], situation === 'wall' ? /Helper → Ward: не вырезал/ :
    situation === 'already free' ? /Helper → Ward: союзник уже свободен/ : /Helper → Ward: вырезал \(1\)/)
  assert.deepEqual(calls.filter(c => c.actor === 'Helper').map(c => c.method), walking ? ['goto', 'cut_ally_web'] : ['cut_ally_web'])
  report(false); release(); await settle()
  assert.equal(ward.webHelper, null); assert.equal(helper.webRescue, null); assert.equal(ctx.busy.size, 0)
})
