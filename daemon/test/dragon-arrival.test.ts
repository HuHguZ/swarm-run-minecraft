const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')

// Run the actual RPC entry with the dimension switched before its first column arrives.
function arrival ({ loaded = false, cancel = false, timeout = false, lost = null }: any = {}) {
  const file = require.resolve('../src/dragon/dragon')
  const local = createRequire(file)
  let now = 0; let waits = 0; let guardCalls = 0
  const ctl = { aborted: false, onAbort: [] }
  const bot: any = { game: { dimension: 'the_end' }, health: 20, entities: {},
    entity: { position: new Vec3(100.5, 49, 0.5) },
    on () {}, clearControlStates () {}, pathfinder: { setGoal () {} },
    blockAt (p) {
      if (!loaded) return null
      const solid = p.y === 48 && p.x >= 98 && p.x <= 102 && p.z >= -2 && p.z <= 2
      return { position: p, name: solid ? 'obsidian' : 'air', boundingBox: solid ? 'block' : 'empty' }
    }
  }
  const session = { bot }
  const pause = async () => {
    waits++; now += 50
    if (cancel) ctl.aborted = true
    else if (!timeout) loaded = true
    if (lost === 'death') bot.health = 0
    if (lost === 'body') session.bot = null
    if (lost === 'dimension') bot.game.dimension = 'overworld'
  }
  const data = local('./dig-down-to')
  const mocks: any = {
    './dig-down-to': { ...data, gameClock: { now: () => now, snapshot: () => ({ tickRate: 20 }), wall: { sleep: pause } }, sleep: pause },
    './bridge-to-island': { ...local('./bridge-to-island'), kitOf: () => ({ beds: 8, blocks: 200, food: 15 }),
      missing: () => [], crystalKitState: () => null },
    './fall-guard': { ...local('./fall-guard'), lookGuard () {
      guardCalls++
      assert.ok(loaded, 'no movement or fight guards before the arrival column is readable')
      throw new Error('arrival reached')
    }, crystalsOf: () => [] },
    '../credits': { install () {} },
    './precision': { precisionRate: () => 0, precisionOff () {} }
  }
  const module = { exports: {} as any }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, require: name => mocks[name] || local(name), console: { error () {} }, process
  }, { filename: file })
  return { run: async () => {
    try { return await module.exports.dragon(session, ctl, { timeoutSeconds: 6 }) } catch (e) { return { error: e.message } }
  },
    waits: () => waits, guards: () => guardCalls }
}

test('End RPC waits for local spawn blocks before deciding island, bridge or path', async () => {
  const s = arrival()
  const out = await s.run()
  assert.ok(s.waits() > 0, 'a dimension event alone does not mean blocks are loaded')
  assert.equal(s.guards(), 1)
  assert.equal(out.error, 'arrival reached')
})

test('a ready End column starts immediately', async () => {
  const s = arrival({ loaded: true })
  assert.equal((await s.run()).error, 'arrival reached')
  assert.equal(s.waits(), 0)
})

test('abort and deadline during End loading cannot fall through into movement', async () => {
  for (const opts of [{ cancel: true }, { timeout: true }]) {
    const s = arrival(opts)
    const out = await s.run()
    assert.equal(s.guards(), 0)
    assert.match(out.stopped, /прервано|не прогружен/)
    assert.equal(out.error, undefined)
  }
})

test('death, body replacement and leaving End during arrival cannot start a fight', async () => {
  for (const lost of ['death', 'body', 'dimension']) {
    const s = arrival({ lost })
    const out = await s.run()
    assert.equal(s.guards(), 0)
    assert.match(out.stopped, /тело сменилось/)
    assert.equal(out.error, undefined)
  }
})
