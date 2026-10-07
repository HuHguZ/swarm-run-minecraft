'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')

async function hold ({ food = true, frForMs = 0, hp = null }: any = {} as Record<string, any>) {
  const file = path.join(__dirname, '../src/blaze.js')
  const req = createRequire(file)
  const calls = []
  const enemy: Record<string, any> = { id: 2, name: 'blaze', position: new Vec3(0, 64, 2), isValid: true }
  const bot = new EventEmitter()
  const items = [{ name: 'iron_sword', count: 1 }, ...(food ? [{ name: 'melon_slice', count: 9 }] : [])]
  Object.assign(bot, { version: '1.21.11', health: hp ?? (food ? 11.5 : 20), food: 20,
    entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 2: enemy },
    inventory: { items: () => items, slots: Array(46).fill(null) },
    pathfinder: { movements: {} as Record<string, any>, setMovements () {}, setGoal () {} },
    clearControlStates () {}, equip: async () => {}, attack: () => calls.push('attack'), lookAt: async () => {},
    blockAt: (p: any) => ({ name: p.y < 64 ? 'netherrack' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p }) })
  if (frForMs) {
    // Огнестойкость в начале боя, кончается через frForMs (зелий в рюкзаке нет).
    Object.assign(bot, { registry: { effectsByName: { fire_resistance: { id: 12 } } } })
    ;(bot as any).entity.effects = { 12: { amplifier: 0 } }
    setTimeout(() => { delete (bot as any).entity.effects[12] }, frForMs)
  }
  bot.inventory.slots[6] = { name: 'iron_chestplate' }
  bot.inventory.slots[8] = { name: 'iron_boots' }
  const ctl: Record<string, any> = { aborted: false }
  const guard = { wear: async () => {}, raise: async () => {}, close () {}, report: () => ({} as Record<string, any>), stats: { blocked: 0 } }
  const context = { module: { exports: {} as Record<string, any> }, console: { log () {} }, setTimeout, clearTimeout, Date, bot, calls, process: { env: { ND_GUARD: '0', ND_NE_ROUTE: '0' } },
    require: name => {
      if (name === './combat') return { makeShield: () => guard, retreat: async () => { calls.push('wall'); ctl.aborted = true; return {} as Record<string, any> } }
      if (name === './walkable') return { walkable: () => [] }
      if (name === './combat-safety') return { ...req(name), disengage: (s, c, foes) => req(name).disengage(s, c, foes, {
        kite: async () => { calls.push('run'); enemy.position = new Vec3(0, 64, 12); return 'оторвался' }
      }) }
      if (name === './flee') return { hostilesAround: () => [{ e: enemy }], smartFlee: async () => { calls.push('flee'); ctl.aborted = true; return { mode: 'нет укрытия' } } }
      return req(name)
    } }
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
    makeRadar = () => ({ stop () {}, untilDanger: () => 99999, incoming: () => [], charged: () => false, stats: {} }); fightMoves = () => ({});
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

test('реальный цикл спавнера не атакует на 11.5 HP: без FR — в толщу раньше бега, коробки и еды (s1c-L-4)', async () => {
  const { result, calls, bot } = await hold()
  assert.equal(calls.includes('attack'), false)
  assert.ok(calls.indexOf('в толщу отлечиться') >= 0, calls.join(','))
  assert.equal(calls.includes('run'), false, 'без FR под лучами ифритов — не бег под залпами')
  assert.ok(calls.indexOf('в толщу отлечиться') < calls.indexOf('wall'), 'яма не вышла — тогда стенка')
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
  const context = { module: { exports: {} as Record<string, any> }, console, setTimeout, clearTimeout, Date,
    require: name => name === './build' ? { pickFiller: () => ({ name: 'cobblestone' }) }
      : name === './fortify' ? { boxIn: async () => ({ sealed: true, cell: bot.entity.position, placed: 9 }),
        enclosure: () => ({ sealed: true }), breakOut: async () => { opened = true; return { ok: false } } }
        : name === './actions' ? { collectNearbyDrops: async () => {} } : req(name) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  const r = await context.module.exports.boxRest({ bot }, { aborted: false }, { maxMs: 0 })
  assert.equal(r.rested, false)
  assert.equal(opened, false)
})

test('s1c: огнестойкость кончилась посреди боя — бой дальше без неё, а не стоп «без защиты от огня»', async () => {
  const { result, calls } = await hold({ frForMs: 150, hp: 20 })
  assert.ok(calls.includes('бой без огнестойкости'), calls.join(','))
  assert.doesNotMatch(String(result.stopped || ''), /без защиты от огня/)
})
