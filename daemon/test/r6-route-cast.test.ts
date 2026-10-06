'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

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
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `
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
  `, context)
  return { ...context.module.exports, state, calls, logs }
}

test('cast reported shortage replenishes blocks before next attempt on same frame', async () => {
  let casts = 0
  const c: any = load({ stone_pickaxe: 1, water_bucket: 1, cobblestone: 1 }, {} as Record<string, any>, {
    mine: (p,s) => { if (p.block === 'stone') s.inventory.cobblestone += p.count; return { status: 'done', detail: { dug: p.count } } },
    portal: (_,s) => { casts++;
      if (casts === 1) return { status: 'done', detail: { frame: '8/10', need: { what: 'cobblestone', count: 3, have: 1 } } };
      assert.ok(s.inventory.cobblestone >= 3); return { status: 'done', detail: { lit: true } }
    }
  })
  assert.equal(await c.castOneAt({ x:20,y:53,z:89 }), true)
  assert.equal(casts, 2)
})
test('failed block replenishment exits without resending unchanged cast shortage', async () => {
  let casts = 0
  const c: any = load({ stone_pickaxe: 1, water_bucket: 1, cobblestone: 1 }, {} as Record<string, any>, {
    mine: () => ({ status: 'failed', detail: {} as Record<string, any> }),
    portal: () => { casts++; return { status: 'done', detail: { need: { what: 'cobblestone', count: 3, have: 1 } } } }
  })
  assert.equal(await c.castOneAt({ x:20,y:53,z:89 }), false)
  assert.equal(casts, 1)
})
test('ND_ROUTE_CAST_RESUPPLY=0 preserves three unchanged shortage responses', async () => {
  const c: any = load({ stone_pickaxe: 1, water_bucket: 1, cobblestone: 1 }, { ND_ROUTE_CAST_RESUPPLY: '0' },
    { portal: () => ({ status: 'done', detail: { need: { what: 'cobblestone', count: 3, have: 1 } } }) })
  assert.equal(await c.castOneAt({ x:20,y:53,z:89 }), false)
  assert.equal(c.calls.filter(([m]: any) => m === 'portal').length, 3)
  assert.equal(c.calls.filter(([m]: any) => m === 'mine').length, 0)
})
test('CAST_UNSAFE keeps its refusal and does not fetch supplies', async () => {
  const c: any = load({ stone_pickaxe: 1, water_bucket: 1 }, {} as Record<string, any>,
    { portal: () => ({ status: 'done', detail: { stopped: 'CAST_UNSAFE: zombie', need: { what: 'cobblestone', count: 3, have: 0 } } }) })
  await assert.rejects(c.castOneAt({ x:20,y:53,z:89 }), /CAST_UNSAFE/)
  assert.equal(c.calls.filter(([m]: any) => m === 'mine').length, 0)
})
