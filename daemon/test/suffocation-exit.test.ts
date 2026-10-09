'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { transformSync } = require('esbuild')
const Vec3 = require('vec3')
const data = require('minecraft-data')('1.21.11')
require('../src/gamedata').fixMaterials(data)
const Block = require('prismarine-block')(data)

// The real escape controller, item selection and client ray run against native block dig times.
// This fixture supplies only a clock/body: one in_wall HP per ten ticks, a walkable side cell,
// and server confirmation after the selected tool's actual dig time. It is not a native proof.
function fixture ({ head = 'obsidian', feet = 'air', side = true, sideFloor = 'stone', hasPick = true, hp = 6, abortAt = Infinity } = {}) {
  let time = 100000; let sequence = 0
  const timers = new Map(); const cells = new Map(); const controls = {}; const digs = []; const events = []; const looks = []; const steps = []
  const ctl = { aborted: false, onAbort: [] }
  const position = new Vec3(.5, 64, .5)
  const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const put = (p, name) => cells.set(key(p), name)
  const blockAt = p => {
    const q = p.floored(); const name = cells.get(key(q)) ?? (q.y < 64 ? 'stone' : 'bedrock')
    const b = Block.fromStateId(data.blocksByName[name].defaultState, 0); b.position = q
    return b
  }
  put(position, feet); put(position.offset(0, 1, 0), head); put(position.offset(0, 2, 0), 'air')
  if (side) { put(position.offset(1, 0, 0), 'air'); put(position.offset(1, 1, 0), 'air'); put(position.offset(1, -1, 0), sideFloor) }
  const clock = {
    now: () => time,
    setTimeout: (fn, ms) => { const id = ++sequence; timers.set(id, { at: time + ms, fn }); return id },
    clearTimeout: id => timers.delete(id),
    sleep: ms => new Promise(resolve => clock.setTimeout(resolve, ms))
  }
  const pickaxe = { name: 'diamond_pickaxe', type: data.itemsByName.diamond_pickaxe.id, count: 1, slot: 36, enchants: [], maxDurability: 1561, durabilityUsed: 0 }
  let activeDig = null
  const bot: any = { health: hp, registry: data, physics: { sneakSpeed: .3 }, entity: { position, onGround: true, height: 1.8, effects: {}, metadata: [] },
    entities: {}, inventory: { items: () => hasPick ? [pickaxe] : [], slots: Array(46).fill(null) }, heldItem: null, blockAt,
    equip: async item => { bot.heldItem = item },
    lookAt: async p => { looks.push(p.clone()); bot.entity.yaw = Math.atan2(bot.entity.position.x - p.x, bot.entity.position.z - p.z) },
    setControlState: (k, v) => { controls[k] = v }, getControlState: k => !!controls[k],
    digTime: b => b.digTime(bot.heldItem?.type ?? null, false, false, !bot.entity.onGround, bot.heldItem?.enchants ?? [], bot.entity.effects),
    dig: b => new Promise((resolve, reject) => {
      const rec = { name: b.name, ms: bot.digTime(b), complete: false }; digs.push(rec)
      const timer = clock.setTimeout(() => { put(b.position, 'air'); rec.complete = true; activeDig = null; resolve(undefined) }, rec.ms)
      activeDig = { timer, reject }
    }),
    stopDigging: () => { if (activeDig) { clock.clearTimeout(activeDig.timer); activeDig.reject(new Error('Digging aborted')); activeDig = null } }
  }
  const file = path.join(__dirname, '../src/autopilot/suffocation.ts'); const req = createRequire(file)
  const context = { module: { exports: {} as any }, console,
    require: name => name === '../game-clock' ? clock : name === '../movement' ? { sleep: clock.sleep }
      : name === '../build' ? { withTimeout: (promise, ms, message) => {
        let timer
        return Promise.race([promise, new Promise((_, reject) => { timer = clock.setTimeout(() => reject(new Error(message)), ms) })]).finally(() => clock.clearTimeout(timer))
      } } : req(name) }
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, context, { filename: file })
  const auto: any = { ...context.module.exports, cfg: { lowHealth: 8 }, lastHp: hp + 1, bodyBusy: () => true,
    session: { mcData: data, current: { name: 'fight' }, bus: { emit: (type, detail) => events.push({ type, ...detail }) }, journal: { append () {} } } }
  async function run () {
    let done = false; let result; let error
    auto.freeIfBuried(bot, { ctl, force: true }).then(r => { result = r; done = true }, e => { error = e; done = true })
    for (let tick = 0; tick < 1000 && !done; tick++) {
      for (let i = 0; i < 12; i++) await Promise.resolve()
      if (done) break
      time += 50
      if (controls['forward'] && !ctl.aborted) {
        const speed = .2 * (controls['sneak'] ? bot.physics.sneakSpeed : 1)
        const next = bot.entity.position.offset(-Math.sin(bot.entity.yaw) * speed, 0, -Math.cos(bot.entity.yaw) * speed)
        const nextCell = next.floored()
        // Starting overlap permits leaving its block; a different solid cell still blocks movement.
        const floor = blockAt(next.offset(0, -1, 0))
        if ((!controls['sneak'] || floor.boundingBox === 'block') && (key(nextCell) === key(position) || blockAt(nextCell).boundingBox === 'empty' && blockAt(nextCell.offset(0, 1, 0)).boundingBox === 'empty')) bot.entity.position = next
        steps.push({ sneak: !!controls['sneak'], at: bot.entity.position.clone() })
      }
      if ((time - 100000) % 500 === 0 && blockAt(bot.entity.position.offset(0, 1.62, 0)).boundingBox === 'block') bot.health = Math.max(0, bot.health - 1)
      if (!ctl.aborted && (!bot.health || time - 100000 >= abortAt)) { ctl.aborted = true; for (const fn of ctl.onAbort) fn() }
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) if (timer.at <= time && timers.delete(id)) timer.fn()
    }
    assert.equal(done, true, 'escape finishes within the fixture deadline')
    if (error) throw error
    return result
  }
  return { bot, auto, ctl, run, digs, controls, events, blockAt, looks, steps }
}

test('lava-water obsidian at the head: a free side step escapes before lethal in_wall damage', async () => {
  const f = fixture()
  const result = await f.run()
  assert.equal(result.freed, true)
  assert.ok(f.bot.health > 0, 'slow obsidian mining must not spend the remaining three seconds of life')
  assert.ok(f.bot.entity.position.x >= 1)
  assert.equal(f.digs.length, 0)
  assert.equal(f.controls['forward'], false)
})

test('a fast head block is mined rather than spending a longer side-step budget', async () => {
  const f = fixture({ head: 'stone', hp: 6 })
  const result = await f.run()
  assert.equal(result.freed, true)
  assert.equal(f.digs[0].name, 'stone')
  assert.equal(f.digs[0].complete, true)
  assert.equal(f.bot.entity.position.x, .5)
})

test('missing harvest tool does not prevent a free side escape', async () => {
  const f = fixture({ hasPick: false })
  const result = await f.run()
  assert.equal(result.freed, true)
  assert.ok(f.bot.health > 0)
  assert.equal(f.digs.length, 0)
})

test('unknown hand dig time still permits a blind escape instead of a coerced zero budget', async () => {
  for (const value of [null, NaN]) {
    const f = fixture({ hasPick: false })
    const at = f.bot.blockAt
    f.bot.blockAt = p => { const b = at(p); b.digTime = () => value; return b }
    f.bot.digTime = () => 9400
    const result = await f.run()
    assert.equal(result.freed, true, String(value))
    assert.ok(f.bot.health > 0)
  }
})

test('an empty side cell without footing is not an escape that spends a fall', async () => {
  const f = fixture({ sideFloor: 'air', hp: 30 })
  await f.run()
  assert.ok(f.steps.every(s => s.at.x < 1), 'blind probes do not walk over the unknown edge while sneaking')
  assert.equal(f.digs[0].name, 'obsidian')
  assert.equal(f.digs[0].complete, true)
})

test('no side exit keeps the honest head dig as a fallback', async () => {
  const f = fixture({ side: false, hp: 30 })
  const result = await f.run()
  assert.equal(result.freed, true)
  assert.equal(f.digs[0].name, 'obsidian')
  assert.equal(f.digs[0].complete, true)
  assert.ok(f.bot.health > 0)
})

test('obsidian at the feet receives its equipped-tool dig time, not an eight-second timeout', async () => {
  const f = fixture({ head: 'stone', feet: 'obsidian', side: false, hp: 30 })
  await f.run()
  const feet = f.digs.find(d => d.name === 'obsidian')
  assert.ok(feet.ms > 8000, 'native data exercises the previous deadline')
  assert.equal(feet.complete, true)
  assert.equal(f.blockAt(new Vec3(.5, 64, .5)).name, 'air')
})

test('interrupted side escape releases forward and does not start a later dig', async () => {
  const f = fixture({ abortAt: 50 })
  await f.run()
  assert.equal(f.ctl.aborted, true)
  assert.equal(f.controls['forward'], false)
  assert.equal(f.digs.length, 0)
})

test('escape probes ignore hidden side geometry and use sneak for the unknown footing', async () => {
  const choices = []
  for (const sideFloor of ['stone', 'magma_block', 'air']) {
    const f = fixture({ sideFloor, abortAt: 50 })
    await f.run()
    choices.push(f.looks[0]?.toString())
    assert.ok(f.steps.length && f.steps.every(s => s.sneak), 'blind movement keeps the native sneak edge guard')
  }
  assert.equal(new Set(choices).size, 1, 'an occluded support type must not select a different escape direction')
})

test('a visible hazardous support is rejected instead of being treated as a solid floor', async () => {
  for (const sideFloor of ['magma_block', 'cactus', 'campfire']) {
    const f = fixture({ head: 'barrier', sideFloor, abortAt: 50 })
    await f.run()
    assert.notEqual(f.looks[0]?.x, 1.5, sideFloor)
  }
})

test('abort releases escape controls without waiting for a physics tick', async () => {
  const f = fixture()
  let done = false
  const work = f.auto.stepOutOfWall(f.bot, { ctl: f.ctl, maxMs: 2000 }).then(() => { done = true })
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.equal(f.controls['forward'], true)
  f.ctl.aborted = true
  for (const fn of [...f.ctl.onAbort]) fn()
  assert.equal(f.controls['forward'], false)
  assert.equal(f.controls['sneak'], false)
  await work
  assert.equal(done, true)
})
