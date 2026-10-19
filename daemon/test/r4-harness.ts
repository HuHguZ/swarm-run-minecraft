'use strict'
import { campaignScript } from './campaign-source'
import { cjsContext } from './cjs-context'
import * as fs from 'fs'
import * as vm from 'vm'
import { withClockFixture } from './clock-fixture'
import path = require('path')
import { createRequire } from 'module'
function campaign (inventory: any = {} as Record<string, any>, situation: any = {} as Record<string, any>, env: any = {} as Record<string, any>): Record<string, any> {
  const clock = { t: 1000 }
  const calls = []
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory }
  const sit = { surface: true, foes: 0, tod: 1000, ...situation }
  class Socket {
  declare listeners: any

    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw)
      calls.push({ method, params })
      const detail = method === 'situation' ? sit : {} as Record<string, any>
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({ id, ok: true, result: { status: 'done', detail, state, events: [] } })))
    }
    close () {}
  }
  const local = createRequire(path.join(__dirname, '../campaign.js'))
  class Time extends Date { constructor (...args) { super(...((args.length ? args : [clock.t]) as [any])) } static now () { return clock.t } }
  const context = { require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync () {} } : local(name),
    __dirname: path.resolve(__dirname, '..'), module: { exports: {} as Record<string, any> }, process: { argv: ['node', 'campaign.js'], env: { ND_ROUTE: '1', ...env } },
    console: { log () {}, error () {} }, setTimeout, Date: Time, queueMicrotask, fixtureState: state, fixtureSit: sit }
  vm.runInNewContext(campaignScript() + `
    state = fixtureState; sit = fixtureSit;
    module.exports = { act, routeGo, routeHunt, routeStep, castOneAt, routeHealToEnter,
      deadline: t => { stage = 'route'; routeDeadline = t },
      hooks: h => { if (h.goToward) goToward = h.goToward; if (h.leaveWater) leaveWater = h.leaveWater;
        if (h.rest) rest = h.rest; if (h.quickHunt) quickHunt = h.quickHunt; if (h.eatTo) eatTo = h.eatTo;
        if (h.routeInfo) routeInfoGet = () => h.routeInfo; },
      portal: p => { known.portal = p },
    }
  `, cjsContext(withClockFixture(context)))
  return { ...context.module.exports, clock, calls, state, sit }
}
export { campaign }
