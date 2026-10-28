export {}
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const { REPO_ROOT: root } = require('../src/paths')
const req = Module.createRequire(path.join(root, 'daemon/package.json')), { Vec3 } = req('vec3')
const ts = Module.createRequire(path.join(root, 'package.json'))('@typescript/typescript6')

function fixture() {
  let release: () => void, tossed = 0, retreated = 0, visible = true
  const looking = new Promise<void>(resolve => { release = resolve })
  const ctl = { aborted: false }, ally = { position: new Vec3(2, 64, 0), isValid: true }
  const item = { name: 'honey_bottle', type: 42, count: 2 }
  const bot = { entity: { position: new Vec3(0, 64, 0), yaw: 0 }, inventory: { items: () => [item] },
    lookAt: () => looking, toss: async (type, metadata, count) => { assert.equal(type, 42); assert.equal(count, 1); tossed++ } }
  const file = path.join(root, 'daemon/src/pvp/team-assist.ts'), local = Module.createRequire(file), module = { exports: {} as any }
  const stubs = { './vec3': { Vec3 }, '../pick': { canHit: () => visible }, '../game-clock': {},
    '../navigation/parkour': { executeJump: async () => { retreated++ }, ROUTE_FRAMES: 6000 },
    '../navigation/geometry': {}, '../drops': {}, '../pack': {} }
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', code)(id => Object.hasOwn(stubs, id) ? stubs[id] : local(id), module, module.exports)
  return { bot, ally, ctl, release: () => release(), hide: () => { visible = false },
    start: () => module.exports.tossTo(bot, ally, 'honey_bottle', 1, undefined, ctl),
    tossed: () => tossed, retreated: () => retreated }
}

test('STOP while aiming prevents the actual item drop', async () => {
  const f = fixture(), result = f.start()
  f.ctl.aborted = true; f.release()
  assert.equal((await result).ok, false); assert.equal(f.tossed(), 0); assert.equal(f.retreated(), 0)
})

test('a recipient moving beyond the existing handoff range is checked after aiming', async () => {
  const f = fixture(), result = f.start()
  f.ally.position = new Vec3(3.01, 64, 0); f.release()
  assert.equal((await result).ok, false); assert.equal(f.tossed(), 0)
})

test('a newly occluded recipient is checked after aiming', async () => {
  const f = fixture(), result = f.start()
  f.hide(); f.release()
  assert.equal((await result).ok, false); assert.equal(f.tossed(), 0)
})

test('a recipient removed while aiming receives no drop', async () => {
  const f = fixture(), result = f.start()
  f.ally.isValid = false; f.release()
  assert.equal((await result).ok, false); assert.equal(f.tossed(), 0)
})

test('an unchanged live recipient still gets the requested drop and donor retreat', async () => {
  const f = fixture(), result = f.start()
  f.release()
  assert.equal((await result).ok, true); assert.equal(f.tossed(), 1); assert.equal(f.retreated(), 1)
})
