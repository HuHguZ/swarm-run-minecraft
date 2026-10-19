import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'

function load(env, full = true, equip = true) {
  const file = require.resolve('../scenes/ow/try-lab-fresh'), local = createRequire(file), commands = [], calls = [], logs = []
  const state: any = { inventory: {}, armor: {}, health: 18, food: 19, dimension: 'overworld' }
  const kit = { randomReset: async () => {}, setDifficulty: async () => {}, gamerule: async () => {}, cmd: async text => {
    commands.push(text)
    if (text === '/clear @s') { state.inventory = {}; state.armor = {} }
    const m = /^\/give @s minecraft:(\w+)(?: (\d+))?$/.exec(text)
    if (m && full) state.inventory[m[1]] = (state.inventory[m[1]] || 0) + Number(m[2] || 1)
  } }
  const mocks = { '../lib/farm-bootstrap': {}, '../lib/scene-kit': { connect: () => ({ call: async method => {
    calls.push(method)
    if (method === 'armor' && equip && state.inventory.iron_helmet) {
      state.inventory.iron_helmet--; state.armor.head = 'iron_helmet'
    }
    return { status: 'done', state }
  }, heard: [] }), createKit: () => kit } }
  const ctx: any = { require: name => mocks[name] || local(name), __dirname: path.dirname(file),
    moduleExports: null, process: { env: { KEEP_STATE: '1', KIT: 'ender_eye*16;iron_helmet;white_bed*6', ...env } },
    console: { log: (...args) => logs.push(args.join(' ')), error() {} } }
  vm.runInNewContext(fs.readFileSync(file, 'utf8').replace(/main\(\)\.catch\([\s\S]*$/, '') + '\nmoduleExports = { scene };', cjsContext(ctx))
  return { scene: ctx.moduleExports.scene, commands, calls, logs }
}

test('replacement: clear the snapshot inventory, equip and verify KIT without changing time or health', async () => {
  const c = load({ KIT_REPLACE: '1' })
  await c.scene()
  assert.ok(c.commands.indexOf('/clear @s') < c.commands.indexOf('/give @s minecraft:ender_eye 16'))
  assert.equal(c.commands.some(x => /^\/(time|tp|effect|fill|setblock)\b/.test(x)), false)
  assert.ok(c.calls.includes('armor'))
  assert.ok(c.logs.some(x => /KIT_READY/.test(x)))
})

test('replacement: a successful give reply with missing inventory fails setup', async () => {
  const c = load({ KIT_REPLACE: '1' }, false)
  await assert.rejects(c.scene(), /KIT_MISSING.*ender_eye.*white_bed/)
})

test('replacement: carried armor alone does not pass the equipped KIT check', async () => {
  const c = load({ KIT_REPLACE: '1' }, true, false)
  await assert.rejects(c.scene(), /KIT_MISSING.*worn:iron_helmet/)
})

test('replacement: an empty or invalid replacement is rejected before clearing', async () => {
  for (const KIT of ['', 'white_bed*0', 'ender_eye*1;bad_item[foo]']) {
    const c = load({ KIT_REPLACE: '1', KIT })
    await assert.rejects(c.scene(), /KIT_INVALID/)
    assert.equal(c.commands.includes('/clear @s'), false)
  }
})

test('replacement: without the flag KEEP_STATE still adds KIT and preserves the old scene', async () => {
  const c = load({})
  await c.scene()
  assert.equal(c.commands.includes('/clear @s'), false)
  assert.equal(c.calls.includes('armor'), false)
  assert.ok(c.commands.includes('/give @s minecraft:ender_eye 16'))
})
