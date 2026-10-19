import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { resolve, dirname } from 'node:path'
import { runInThisContext } from 'node:vm'
import { bodySource } from './source-fixture'
import { pvpParts } from './pvp-parts'
import { stubRequire } from './stub-require'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as clock from '../src/game-clock'
import boom = require('../src/boom')

// Real crystal planner/run/poll and damage model; only the server's consume/place acknowledgements are simulated.
function fixture ({ filler = true, screen = false, hidden = 'air' }: any = {}) {
  const game = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = new EventEmitter(); bot._client = new EventEmitter()
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.health = 12; bot.food = 20; bot.game = { difficulty: 'normal', dimension: 'overworld' }
  bot.entity = { id: 1, name: 'player', type: 'player', position: new Vec3(.5, 0, .5), width: .6, height: 1.8, metadata: [], yaw: -Math.PI / 2, onGround: true }
  const foe: any = { id: 2, name: 'player', type: 'player', username: 'Foe', position: new Vec3(5.5, 0, .5), width: .6, height: 1.8, isValid: true, equipment: [] }
  Object.defineProperty(foe, 'health', { get () { throw new Error('enemy exact HP is not a policy input') } })
  bot.entities = { 1: bot.entity, 2: foe }
  const apple = { name: 'golden_apple', count: 4, slot: 36 }
  const items = [apple, ...(filler ? [{ name: 'obsidian', count: 8, slot: 37 }] : [])]
  const ench = name => ({ name, count: 1, componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'minecraft:protection', level: 4 }] } }]]) })
  bot.inventory = { slots: [], items: () => items.filter(i => i.count > 0) }
  for (const [n, name] of ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'].entries()) bot.inventory.slots[5 + n] = ench(name)
  for (const item of items) bot.inventory.slots[item.slot] = item
  bot.quickBarSlot = 0; bot.heldItem = apple
  bot.setQuickBarSlot = n => { bot.quickBarSlot = n; bot.heldItem = bot.inventory.slots[36 + n] }
  const cells = new Map<string, any>(); const anchor = new Vec3(3, 0, 0)
  const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const make = (p, name, charges = 0) => ({ name, position: p.floored(), boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ charges }) })
  // Opaque back wall: changing the packet-only space behind it must not change the defense.
  for (let y = 0; y <= 3; y++) for (let z = -8; z <= 8; z++) cells.set(`-1,${y},${z}`, make(new Vec3(-1, y, z), 'obsidian'))
  const hide = () => { for (let y = 0; y <= 3; y++) for (let z = -4; z <= 4; z++) cells.set(`1,${y},${z}`, make(new Vec3(1, y, z), 'obsidian')) }
  if (screen) hide()
  let hiddenReads = 0
  bot.blockAt = p => {
    const q = p.floored()
    if (q.x <= -2 && q.y >= 0 && q.y <= 2 && Math.abs(q.z) <= 3) { hiddenReads++; return make(q, hidden) }
    return cells.get(key(q)) || make(q, q.y === -1 ? 'obsidian' : 'air')
  }
  bot.controlState = {}; bot.setControlState = (k, v) => { bot.controlState[k] = v }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.world = { raycast: () => null }
  let consuming = null; let active = false; let lowers = 0; let starts = 0
  bot.activateItem = () => {
    active = true; starts++
    consuming = game.setTimeout(() => { apple.count--; active = false; consuming = null }, 1600)
  }
  bot.deactivateItem = () => { active = false; lowers++; if (consuming) game.clearTimeout(consuming); consuming = null }
  const placements: any[] = []
  const file = resolve(__dirname, '../src/crystal.js'); const mod = { exports: {} as any }
  const placeBlockAt = async (_bot, p, opts) => {
    assert.equal(active, false, 'consume is released before placing defense')
    placements.push({ at: game.now(), pos: p.clone(), item: opts.item })
    cells.set(key(p), make(p, opts.item)); return { ok: true }
  }
  // bodySource: фасад вместе с папкой тела crystal/ — один скрипт; './build' подменён у фасада (части берут его из deps).
  runInThisContext(`(function(require,module,exports,__filename,__dirname){${bodySource(file)}\n})`, { filename: file })
    (stubRequire(file, { './build': { placeBlockAt } }), mod, mod.exports, file, dirname(file))
  const cx = mod.exports.create(bot, { enemy: () => foe, telemetryHp: () => { throw new Error('telemetry cannot decide eat defense') } })
  const ctl = { aborted: false, onAbort: [] }
  const update = charges => {
    const old = bot.blockAt(anchor); const next = make(anchor, 'respawn_anchor', charges)
    cells.set(key(anchor), next); bot.emit('blockUpdate', old, next)
  }
  const turn = () => new Promise<void>(done => setImmediate(done))
  const step = async (n = 1) => { for (let i = 0; i < n; i++) { game.advanceTicks(1); await turn() } }
  const finish = async p => {
    let done = false; let result; let error
    p.then(x => { done = true; result = x }, e => { done = true; error = e })
    await turn()
    for (let i = 0; !done && i < 70; i++) await step()
    assert.ok(done, 'real run returns within its bounded poll'); if (error) throw error
    return result
  }
  const eat = (ctx = {}) => cx.run(ctl, { kind: 'eat', item: 'golden_apple', note: 'apple' }, ctx)
  const damage = () => {
    cells.delete(key(anchor)) // RespawnAnchorBlock removes itself before explosion.
    return boom.blast(bot, anchor.offset(.5, .5, .5), 5, bot.entity.position, { def: boom.defenseOf(bot, bot.entity) }).dmg
  }
  return { bot, foe, game, cx, ctl, apple, update, hide, step, turn, finish, eat, damage, placements,
    active: () => active, lowers: () => lowers, starts: () => starts, hiddenReads: () => hiddenReads,
    close () { cx.close(); bot.deactivateItem(); game.dispose() } }
}

test('eat poll respects ctx.stop, releases use, and leaves the duel available for another action', async () => {
  const f = fixture()
  try {
    let stop = false
    const pending = f.eat({ stop: () => stop }); await f.turn(); await f.step(4)
    stop = true
    const r: any = await f.finish(pending)
    assert.equal(r.ok, false); assert.equal(f.apple.count, 4)
    assert.equal(f.active(), false); assert.equal(f.lowers(), 1); assert.equal(f.ctl.aborted, false)
    assert.ok(f.game.now() < 1500, 'stop is checked by the next poll, not after food finishes')
    const next: any = await f.finish(f.eat())
    assert.equal(next.ok, true); assert.equal(f.apple.count, 3); assert.equal(f.ctl.aborted, false)
  } finally { f.close() }
})

test('visible charge during real eat yields a cheaper wall, with cleanup before the same-ctl defense', async () => {
  const f = fixture()
  try {
    f.update(0)
    const pending = f.eat({ reactMs: 150 }); await f.turn(); await f.step(7)
    f.update(1); const chargedAt = f.game.now()
    const r: any = await f.finish(pending)
    assert.equal(r.ok, false); assert.equal(r.defense?.kind, 'wall'); assert.equal(f.apple.count, 4)
    assert.ok(f.game.now() - chargedAt >= 150, 'observed threat keeps the configured reaction time')
    assert.ok(f.game.now() - chargedAt <= 250, 'remaining bite does not hold the main loop')
    assert.equal(f.active(), false); assert.equal(f.lowers(), 1); assert.equal(f.ctl.aborted, false)
    assert.equal(f.cx.st.evadePlans || 0, 0, 'poll evaluations are not counted as executed attempts')
    const openDamage = f.damage()
    f.update(1)
    const defended: any = await f.finish(f.cx.run(f.ctl, r.defense))
    assert.equal(defended.ok, true); assert.equal(f.placements.length, 1)
    assert.ok(f.damage() < openDamage / 2, 'actual planned block reduces model damage before detonation')
    assert.equal(f.ctl.aborted, false)
  } finally { f.close() }
})

test('hidden charge changes do not interrupt an apple', async () => {
  for (const initiallySeen of [false, true]) {
    const outcomes = []
    for (const charges of [0, 1, 4]) {
      const f = fixture({ screen: !initiallySeen })
      try {
        f.update(0); f.hide()
        const pending = f.eat(); await f.turn(); await f.step(7); f.update(charges)
        const r: any = await f.finish(pending)
        outcomes.push({ ok: r.ok, defense: r.defense, apples: f.apple.count, ends: f.lowers() })
      } finally { f.close() }
    }
    assert.deepEqual(outcomes[1], outcomes[0]); assert.deepEqual(outcomes[2], outcomes[0])
    assert.equal(outcomes[0].ok, true)
  }
})

test('external stop errors and duel abort both release an ongoing use', async () => {
  for (const throws of [false, true]) {
    const f = fixture()
    try {
      let stop = false
      const pending = f.eat({ stop: () => { if (stop && throws) throw new Error('stop failed'); return false } })
      await f.turn(); await f.step(4)
      if (throws) stop = true
      else f.ctl.aborted = true
      if (throws) await assert.rejects(f.finish(pending), /stop failed/)
      else { const r: any = await f.finish(pending); assert.equal(r.ok, false); assert.equal(r.defense, undefined) }
      assert.equal(f.active(), false); assert.equal(f.apple.count, 4); assert.equal(f.lowers(), 1)
    } finally { f.close() }
  }
})

test('hidden geometry pair chooses the same real defense without reading packet-only cells', async () => {
  const results = []
  for (const hidden of ['air', 'obsidian']) {
    const f = fixture({ hidden })
    try {
      const pending = f.eat(); await f.turn(); await f.step(7); f.update(1)
      const r: any = await f.finish(pending)
      assert.equal(r.defense?.kind, 'wall')
      results.push({ kind: r.defense.kind, cells: r.defense.cells.map(p => p.toArray()), exp: r.defense.exp })
      assert.equal(f.hiddenReads(), 0, 'unknown space is neither clearance nor free cover')
    } finally { f.close() }
  }
  assert.deepEqual(results[1], results[0])
})

test('almost completed apple and no beneficial defense can continue instead of unconditional cancellation', async () => {
  const f = fixture()
  try {
    const pending = f.eat(); await f.turn(); await f.step(30); f.update(1)
    const r: any = await f.finish(pending)
    assert.equal(r.ok, true); assert.equal(r.defense, undefined); assert.equal(f.apple.count, 3)
  } finally { f.close() }
  const no = fixture({ filler: false })
  try {
    const pending = no.eat(); await no.turn(); await no.step(7); no.update(1)
    const r: any = await no.finish(pending)
    assert.equal(r.ok, true); assert.equal(r.defense, undefined)
  } finally { no.close() }
})

test('actual PvP caller executes eat then defense sequentially and preserves priority/error cleanup', async () => {
  // Execute the actual narrow caller, not a second hand-written copy of its handoff.
  for (const outcome of ['defend', 'priority', 'error']) {
    const f = fixture()
    try {
      let urgent = false
      const calls = []
      const ctx: any = { bot: f.bot, ctl: f.ctl, ca: { kind: 'eat', item: 'golden_apple', note: 'apple' }, rc: null,
        style: { reactMs: 150 }, FIX: true, maceNow: () => urgent, stepSafe: () => true, gameClock: clock,
        cx: { run: async (ctl, action, options) => {
          assert.equal(ctl, f.ctl); calls.push(action.kind)
          if (action.kind !== 'eat') {
            assert.equal(f.active(), false, 'actual caller never overlaps food use with defense')
            assert.ok(f.bot._ndBlockTag?.what, 'defense placement has its own block tag')
            if (outcome === 'error') throw new Error('defense failed')
          }
          const value = await f.cx.run(ctl, action, options)
          if (action.kind === 'eat' && outcome === 'priority') urgent = true
          return value
        } } }
      // Настоящая передача ветке кристаллов из ступени хода crystalTurn (pvp/turn-blast.ts).
      const { runCrystalAction } = pvpParts(ctx, ['turn-blast'], ['runCrystalAction'])
      assert.equal(typeof runCrystalAction, 'function', 'real crystal caller is present')
      const pending = runCrystalAction(ctx, ctx.ca)
      await f.turn(); await f.step(7); f.update(1)
      const r: any = await f.finish(pending)
      assert.deepEqual(calls, outcome === 'priority' ? ['eat'] : ['eat', 'wall'])
      assert.equal(f.bot._ndBlockTag, null); assert.equal(f.active(), false); assert.equal(f.ctl.aborted, false)
      if (outcome === 'error') assert.match(r.note, /defense failed/)
      if (outcome === 'defend') { assert.equal(r.ok, true); assert.equal(f.placements.length, 1) }
    } finally { f.close() }
  }
})
