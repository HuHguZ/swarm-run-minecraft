'use strict'
import { campaignScript } from './campaign-source'
import { cjsContext } from './cjs-context'
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { withClockFixture } from './clock-fixture'
import { createRequire } from 'node:module'
function fixture (info): Record<string, any> {
  const clock: Record<string, any> = { t: 1000 }; const calls = []; const steps = []; const logs = []
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const sit = { surface: true, foes: 0, timeOfDay: 1000, inWater: false }
  class Socket {
  declare listeners: any

    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw); calls.push({ method, params })
      const detail = method === 'situation' ? sit : {} as Record<string, any>
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({ id, ok: true, result: { status: 'done', detail, state, events: [] } })))
    }
    close () {}
  }
  class Time extends Date { constructor (...args) { super(...((args.length ? args : [clock.t]) as [any])) } static now () { return clock.t } }
  const filename = path.resolve(__dirname, '../campaign.js'); const local = createRequire(filename)
  const ctx = { require: n => n === 'ws' ? Socket : n === 'fs' ? { appendFileSync (f, s) { logs.push(s) } } : local(n),
    __dirname: path.dirname(filename), module: { exports: {} as Record<string, any> }, process: { argv: ['node', 'campaign.js'], env: { ND_ROUTE: '1', ND_ROUTE_BED: '0' } },
    console: { log () {}, error () {} }, setTimeout, Date: Time, queueMicrotask, fixtureState: state, fixtureSit: sit, fixtureInfo: info,
    step: async s => { steps.push(s.kind); if (s.kind === 'treasure') { clock.t += 181000; return false }; return 'delegate' } }
  vm.runInNewContext(campaignScript() + `
    state = fixtureState; sit = fixtureSit; routeInfoGet = () => fixtureInfo;
    routeStep = async s => { if (s.kind === 'treasure') await act('structure', { timeoutSeconds: 900 }); return step(s) };
    stage = 'route'; module.exports = { run: () => STAGES.find(s => s.name === 'route').run() };
  `, cjsContext(withClockFixture(ctx)))
  return { ...ctx.module.exports, calls, steps, logs }
}
export { fixture }
