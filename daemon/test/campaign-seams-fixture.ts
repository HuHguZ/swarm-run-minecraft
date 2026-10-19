'use strict'
import { campaignScript } from './campaign-source'
import { cjsContext } from './cjs-context'
import 'node:test'
import test = require('node:test')
import 'node:assert/strict'
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'

function load (state, handle: (...args: any[]) => any = () => ({} as Record<string, any>), env: any = {} as Record<string, any>): Record<string, any> {
  const calls = []; const logs = []
  const daemon = process.env.CAMPAIGN_TEST_ROOT || path.resolve(__dirname, '..')
  const requireDaemon = createRequire(path.join(daemon, 'campaign.js'))
  class Socket {
  declare listeners: any

    constructor () { this.listeners = new Map() }
    on (name, fn) { this.listeners.set(name, fn) }
    send (raw) {
      const { id, method, params } = JSON.parse(raw)
      calls.push({ method, params })
      const detail = method === 'situation' ? { foes: 0, surface: false, timeOfDay: 1000 } : handle(method, params)
      queueMicrotask(() => this.listeners.get('message')(JSON.stringify({ id, ok: true,
        result: detail.rpcResult || { status: 'done', state, detail, events: [] } })))
    }
    close () {}
  }
  const ctx = {
    require: name => name === 'ws' ? Socket : name === 'fs' ? { appendFileSync (f, s) { logs.push(s) } } : requireDaemon(name),
    __dirname: daemon, module: { exports: {} as Record<string, any> },
    process: { argv: ['node', 'campaign.js'], env }, console: { log () {}, error () {} },
    setTimeout, queueMicrotask, testState: state
  }
  vm.runInNewContext(campaignScript(process.env.CAMPAIGN_TEST_SOURCE) + `
    state = testState; sit = { foes: 0, surface: false };
    module.exports = { known, done: n => DONE[n](), select: () => intelligence.select(STAGES, () => false), needed: n => STAGES.find(s => s.name === n).needed(),
      run: n => { stage = n; return STAGES.find(s => s.name === n).run() },
      runs: n => { endkitRuns = n }, hooks: h => { if (h.rest) rest = h.rest; if (h.nightGuard) nightGuard = h.nightGuard; },
      acceptResult, boot: () => ws.listeners.get('open')(),
      snapshot: typeof seamSnapshot === 'function' ? seamSnapshot : null };
  `, cjsContext(ctx))
  return { ...ctx.module.exports, calls, logs }
}

function ready (extra: any = {} as Record<string, any>): Record<string, any> {
  return { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 60, z: 0 },
    inventory: { iron_pickaxe: 1, iron_sword: 1, red_bed: 5, obsidian: 4, water_bucket: 2,
      cobblestone: 108, oak_boat: 1, cooked_beef: 8, bow: 1, spectral_arrow: 32, ...extra } }
}


export { load, ready }
