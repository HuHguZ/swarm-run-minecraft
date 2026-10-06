'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const SOURCE = path.resolve(__dirname, '../../daemon/campaign.js')

function brain (initial) {
  const calls = []
  class Socket {
  declare listeners: any

    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw)
      calls.push({ method, params })
      if (method === 'goto') { initial.pos.x = params.x; initial.pos.z = params.z }
      const detail = method === 'situation' ? { night: false, surface: false, foes: 0 } : {} as Record<string, any>
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({ id, ok: true,
        result: { status: 'done', detail, state: initial, events: [] } })))
    }
    close () {}
  }
  const context = { require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync () {} } : require(name),
    __dirname: path.dirname(SOURCE), module: { exports: {} as Record<string, any> }, process: { argv: ['node', 'campaign.js'], env: {} as Record<string, any> },
    console: { log () {}, error () {} }, setTimeout, Date, queueMicrotask, initial }
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8') + `
    state = initial; sit = { night: false, surface: false, foes: 0 };
    let repaired = 0;
    ensurePick = async () => { repaired++; initial.inventory.stone_pickaxe = 1; state.inventory.stone_pickaxe = 1; return true };
    module.exports = { goToward, repaired: () => repaired };
  `, context)
  return { ...context.module.exports, calls }
}

test('допуск крепости 150 не делает отрезки 64 готовыми на месте', async () => {
  const s = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const c: any = brain(s)
  assert.equal(await c.goToward({ x: 600, z: 0 }, 150), true)
  assert.ok(s.pos.x >= 448, 'честно прошёл расстояние до допуска цели')
  assert.ok(c.calls.filter(x => x.method === 'goto').every(x => x.params.range <= 8))
})

test('переход по верхнему миру с истёршимися кирками пополняет инструмент до следующего пути', async () => {
  // sh2 slot13: y43, булыжник416, палки8, стол есть; сотни попыток goto без кирки.
  const s = { health: 20, food: 20, dimension: 'overworld', pos: { x: -81, y: 44, z: 243 },
    inventory: { crafting_table: 1, cobblestone: 416, stick: 8 } }
  const c: any = brain(s)
  await c.goToward({ x: -400, z: 1776 }, 150)
  assert.equal(c.repaired(), 1, 'замена инструмента должна быть выполнена до первого пути')
})
