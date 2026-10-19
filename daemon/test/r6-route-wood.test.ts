'use strict'
import { campaignScript } from './campaign-source'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'

function load (inventory: any = {} as Record<string, any>, env: any = {} as Record<string, any>, hooks: any = {} as Record<string, any>) {
  const calls = []
  const state = { inventory: { ...inventory }, health: 20, food: 20,
    pos: { x: 20, y: 53, z: 89 }, dimension: 'overworld' }
  const logs = []
  const file = path.resolve(__dirname, '../campaign.js')
  const local = createRequire(file)
  class Socket { on () {} }
  const fixture: any = { state, calls, logs, hooks }
  const route = { ...local('./src/route'), plan: (info, opts) => fixture.plan || local('./src/route').plan(info, opts) }
  const context = { require: n => n === 'ws' ? Socket : n === 'fs' ? { appendFileSync () {} } : n === './src/route' ? route : local(n),
    __dirname: path.dirname(file), module: { exports: {} as Record<string, any> },
    process: { argv: ['node', 'campaign.js'], env: { ND_ROUTE: '1', ND_OW_DEEP: '1', ...env } },
    console: { log: (...args) => logs.push(args.join(' ')), error () {} }, setTimeout, Date, fixture }
  vm.runInNewContext(campaignScript() + `
    state = fixture.state; sit = { surface: false, night: false, inWater: false, foes: 0 };
    refresh = async () => {}; sense = async () => {}; readMemory = async () => {};
    nightGuard = async () => {}; recoverGuard = async () => {}; unclutter = async () => {};
    routeLeaveOutpost = async () => {}; routeHunt = async () => {}; ensureTable = async () => {};
    routeGo = async () => { fixture.calls.push(['routeGo', {}]); return true };
    walkAway = async () => { fixture.calls.push(['walkAway', {}]) };
    toSurface = async () => { fixture.calls.push(['toSurface', {}]); sit.surface = true; return true };
    act = async (method, params = {}) => {
      fixture.calls.push([method, params]);
      const fn = fixture.hooks[method];
      return fn ? await fn(params, state) : { status: 'done', detail: {} };
    };
    craft = async (item, count = 1) => {
      fixture.calls.push(['craft', { item, count }]);
      if (fixture.hooks.craft) return fixture.hooks.craft(item, count, state);
      const inv = state.inventory;
      const take = (name, n) => { if ((inv[name] || 0) < n) return false; inv[name] -= n; return true };
      if (item === 'furnace' && !take('cobblestone', 8)) return false;
      if (item === 'bucket' && !take('iron_ingot', 3)) return false;
      if (/_planks$/.test(item) && !take(item.replace(/_planks$/, '_log'), Math.ceil(count / 4))) return false;
      inv[item] = (inv[item] || 0) + count;
      return true;
    };
    sticks = async n => { state.inventory.stick = Math.max(state.inventory.stick || 0, n) };
    module.exports = { routeStep, routeReturnShaft, castOneAt,
      run: name => STAGES.find(s => s.name === name).run(),
      setShaft: s => { surfaceShaft = s },
      setSituation: s => { sit = { ...sit, ...s } },
      portal: p => { known.portal = p },
      captureDeadline: async (kind, budget) => {
        routeInfoGet = () => ({ spawn: { x:20,z:89 }, ores: {} });
        fixture.plan = { route: 'fixture', steps: [{ id: kind, kind, budget }], budget };
        routeSleep = async () => {}; routeBedLate = async () => {};
        routeStep = async () => { fixture.calls.push(['deadline', { ms: routeDeadline - Date.now() }]); return 'delegate' };
        await STAGES.find(s => s.name === 'route').run();
        return fixture.calls.find(([m]) => m === 'deadline')[1].ms;
      }
    };
  `, cjsContext(context))
  return { ...context.module.exports, state, calls, logs }
}


test('default initial wood budget keeps six collected logs recoverable through second exploration', async () => {
  const c: any = load()
  const left = await c.captureDeadline('wood', 90)
  assert.ok(left >= 599000 && left <= 600000, `remaining ${left}`)
})
test('route replan with starter already made never travels back to a wood point', async () => {
  const c: any = load({ wooden_pickaxe: 1, crafting_table: 1, stick: 4, oak_log: 3 })
  c.setSituation({ surface: true })
  assert.equal(await c.routeStep({ kind: 'wood', src: 'village', at: { x: 400, z: 92 } }), true)
  assert.equal(c.calls.filter(([m]: any) => m === 'routeGo' || m === 'mine').length, 0)
})
test('bootstrap limiter remains explicitly available for wood and stone', async () => {
  for (const kind of ['wood', 'stone']) {
    const c: any = load({} as Record<string, any>, { ND_ROUTE_BOOTSTRAP_LIMIT: '1' })
    const left = await c.captureDeadline(kind, 90)
    assert.ok(left >= 179000 && left <= 180000, `remaining ${left}`)
  }
})
test('ND_ROUTE_BOOTSTRAP_LIMIT=0 restores base ten-minute stone deadline', async () => {
  const c: any = load({} as Record<string, any>, { ND_ROUTE_BOOTSTRAP_LIMIT: '0' })
  const left = await c.captureDeadline('stone', 90)
  assert.ok(left >= 599000 && left <= 600000, `remaining ${left}`)
})
test('other route steps keep three-budget deadline', async () => {
  const c: any = load()
  const left = await c.captureDeadline('castSky', 100)
  assert.ok(left >= 299000 && left <= 300000, `remaining ${left}`)
})
test('ND_ROUTE_STARTER_CHECKPOINT=0 keeps old wood-point traversal', async () => {
  const c: any = load({ wooden_pickaxe: 1, crafting_table: 1, stick: 4, oak_log: 5 }, { ND_ROUTE_STARTER_CHECKPOINT: '0' })
  c.setSituation({ surface: true })
  await c.routeStep({ kind: 'wood', src: 'village', at: { x: 400, z: 92 } })
  assert.ok(c.calls.some(([m]: any) => m === 'routeGo'))
})
