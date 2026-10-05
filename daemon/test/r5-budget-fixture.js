'use strict'
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { withClockFixture } = require('./clock-fixture')
const { createRequire } = require('node:module')
function fixture (info) {
  const clock = { t: 1000 }; const calls = []; const steps = []; const logs = []
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const sit = { surface: true, foes: 0, timeOfDay: 1000, inWater: false }
  class Socket {
    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw); calls.push({ method, params })
      const detail = method === 'situation' ? sit : {}
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({ id, ok: true, result: { status: 'done', detail, state, events: [] } })))
    }
    close () {}
  }
  class Time extends Date { constructor (...args) { super(...(args.length ? args : [clock.t])) } static now () { return clock.t } }
  const filename = path.resolve(__dirname, '../campaign.js'); const local = createRequire(filename)
  const ctx = { require: n => n === 'ws' ? Socket : n === 'fs' ? { appendFileSync (f, s) { logs.push(s) } } : local(n),
    __dirname: path.dirname(filename), module: { exports: {} }, process: { argv: ['node', 'campaign.js'], env: { ND_ROUTE: '1', ND_ROUTE_BED: '0' } },
    console: { log () {}, error () {} }, setTimeout, Date: Time, queueMicrotask, fixtureState: state, fixtureSit: sit, fixtureInfo: info,
    step: async s => { steps.push(s.kind); if (s.kind === 'treasure') { clock.t += 181000; return false }; return 'delegate' } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + `
    state = fixtureState; sit = fixtureSit; routeInfoGet = () => fixtureInfo;
    routeStep = async s => { if (s.kind === 'treasure') await act('structure', { timeoutSeconds: 900 }); return step(s) };
    stage = 'route'; module.exports = { run: () => STAGES.find(s => s.name === 'route').run() };
  `, withClockFixture(ctx))
  return { ...ctx.module.exports, calls, steps, logs }
}
module.exports = { fixture }
