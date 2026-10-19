'use strict'
import { campaignSocket, campaignVm } from './campaign-source'
import 'node:test'
import 'node:assert/strict'
import path = require('node:path')
import { createRequire } from 'node:module'

function load (state, handle: (...args: any[]) => any = () => ({} as Record<string, any>), env: any = {} as Record<string, any>): Record<string, any> {
  const calls = []; const logs = []
  const daemon = process.env.CAMPAIGN_TEST_ROOT || path.resolve(__dirname, '..')
  const requireDaemon = createRequire(path.join(daemon, 'campaign.js'))
  const socket = campaignSocket((method, params) => {
    calls.push({ method, params })
    const detail = method === 'situation' ? { foes: 0, surface: false, timeOfDay: 1000 } : handle(method, params)
    return detail.rpcResult || { status: 'done', state, detail, events: [] }
  })
  const ctx = campaignVm(`
    state = testState; sit = { foes: 0, surface: false };
    module.exports = { known, done: n => DONE[n](), select: () => intelligence.select(STAGES, () => false), needed: n => STAGES.find(s => s.name === n).needed(),
      run: n => { stage = n; return STAGES.find(s => s.name === n).run() },
      runs: n => { endkitRuns = n }, hooks: h => { if (h.rest) rest = h.rest; if (h.nightGuard) nightGuard = h.nightGuard; },
      acceptResult, boot: () => ws.listeners.get('open')(),
      snapshot: typeof seamSnapshot === 'function' ? seamSnapshot : null };
  `, { socket, log: s => logs.push(s), base: requireDaemon, dirname: daemon, env, globals: { testState: state }, source: process.env.CAMPAIGN_TEST_SOURCE })
  return { ...ctx.module.exports, calls, logs }
}

function ready (extra: any = {} as Record<string, any>): Record<string, any> {
  return { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 60, z: 0 },
    inventory: { iron_pickaxe: 1, iron_sword: 1, red_bed: 5, obsidian: 4, water_bucket: 2,
      cobblestone: 108, oak_boat: 1, cooked_beef: 8, bow: 1, spectral_arrow: 32, ...extra } }
}


export { load, ready }
