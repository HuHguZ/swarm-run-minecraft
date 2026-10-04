'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')

async function hold ({ food = true } = {}) {
  const file = path.join(__dirname, '../src/blaze.js')
  const req = createRequire(file)
  const calls = []
  const enemy = { id: 2, name: 'blaze', position: new Vec3(0, 64, 2), isValid: true }
  const bot = new EventEmitter()
  const items = [{ name: 'iron_sword', count: 1 }, ...(food ? [{ name: 'melon_slice', count: 9 }] : [])]
  Object.assign(bot, { version: '1.21.11', health: food ? 11.5 : 20, food: 20,
    entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: enemy },
    inventory: { items: () => items, slots: Array(46).fill(null) },
    pathfinder: { movements: {}, setMovements () {}, setGoal () {} },
    clearControlStates () {}, equip: async () => {}, attack: () => calls.push('attack') })
  bot.inventory.slots[6] = { name: 'iron_chestplate' }
  bot.inventory.slots[8] = { name: 'iron_boots' }
  const ctl = { aborted: false }
  const guard = { wear: async () => {}, raise: async () => {}, close () {}, report: () => ({}) }
  const context = { module: { exports: {} }, console: { log () {} }, setTimeout, clearTimeout, Date, bot, calls,
    require: name => {
      if (name === './combat') return { makeShield: () => guard, retreat: async () => { calls.push('wall'); ctl.aborted = true; return {} } }
      if (name === './walkable') return { walkable: () => [] }
      if (name === './combat-safety') return { ...req(name), disengage: (s, c, foes) => req(name).disengage(s, c, foes, {
        kite: async () => { calls.push('run'); enemy.position = new Vec3(0, 64, 12); return 'оторвался' }
      }) }
      if (name === './flee') return { hostilesAround: () => [{ e: enemy }], smartFlee: async () => { calls.push('flee'); ctl.aborted = true; return { mode: 'нет укрытия' } } }
      return req(name)
    } }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    makeRadar = () => ({ stop () {} }); fightMoves = () => ({});
    losClear = () => true; liveBlazes = () => [bot.entities[2]];
    boxRest = async () => { calls.push('box'); return { rested: false }; };
    rest = async () => { calls.push('cover'); return { rested: false, why: 'нет места' }; };
    module.exports.testHold = holdSpawner;
  `, context)
  const result = await context.module.exports.testHold({ bot }, ctl, {
    spawner: null, want: 7, dead: new Set(), deadline: Date.now() + 2000,
    setPhase: p => calls.push(p), restAt: 12, bailAt: 6, p: { box: false }
  })
  return { result, calls, bot }
}

test('реальный цикл спавнера не атакует на 11.5 HP: бегство раньше коробки и еды', async () => {
  const { result, calls, bot } = await hold()
  assert.equal(calls.includes('attack'), false)
  assert.ok(calls.indexOf('run') >= 0)
  assert.ok(calls.indexOf('run') < calls.indexOf('wall'))
  assert.equal(calls.includes('box'), false, 'прерванный отход не разрешает стройку под врагом')
  assert.equal(result.bail, true)
  assert.equal(bot.listenerCount('health'), 0)
})
test('реальный цикл отказывается фармить с пустым запасом еды и не начинает атаку', async () => {
  const { result, calls } = await hold({ food: false })
  assert.equal(result.bail, true)
  assert.equal(result.stopped, 'нет запаса еды после восстановления сытости')
  assert.equal(calls.includes('attack'), false)
  assert.equal(calls.includes('box'), false)
})

test('закрытая коробка без восстановленного здоровья не считается отдыхом и не открывается', async () => {
  const file = path.join(__dirname, '../src/blaze.js')
  const req = createRequire(file)
  let opened = false
  const bot = { health: 5, food: 13, entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => [{ name: 'cobblestone', count: 32 }] },
    pathfinder: { setGoal () {} }, clearControlStates () {} }
  const context = { module: { exports: {} }, console, setTimeout, clearTimeout, Date,
    require: name => name === './build' ? { pickFiller: () => ({ name: 'cobblestone' }) }
      : name === './fortify' ? { boxIn: async () => ({ sealed: true, cell: bot.entity.position, placed: 9 }),
        enclosure: () => ({ sealed: true }), breakOut: async () => { opened = true; return { ok: false } } }
        : name === './actions' ? { collectNearbyDrops: async () => {} } : req(name) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  const r = await context.module.exports.boxRest({ bot }, { aborted: false }, { maxMs: 0 })
  assert.equal(r.rested, false)
  assert.equal(opened, false)
})
