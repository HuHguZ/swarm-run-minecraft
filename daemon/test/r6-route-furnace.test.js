'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function load (inventory = {}, env = {}, hooks = {}) {
  const calls = []
  const state = { inventory: { ...inventory }, health: 20, food: 20,
    pos: { x: 20, y: 53, z: 89 }, dimension: 'overworld' }
  const logs = []
  const file = path.resolve(__dirname, '../campaign.js')
  const local = createRequire(file)
  class Socket { on () {} }
  const fixture = { state, calls, logs, hooks }
  const route = { ...local('./src/route'), plan: (info, opts) => fixture.plan || local('./src/route').plan(info, opts) }
  const context = { require: n => n === 'ws' ? Socket : n === 'fs' ? { appendFileSync () {} } : n === './src/route' ? route : local(n),
    __dirname: path.dirname(file), module: { exports: {} },
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

test('ore shaft makes its eight cobblestone into a portable furnace before tower consumes them', async () => {
  const c = load({ stone_pickaxe: 1, crafting_table: 1, raw_iron: 4, cobblestone: 9, dirt: 12 }, {}, {
    tunnel: (p, s) => {
      if (p.direction === 'up') { assert.equal(s.inventory.furnace, 1); s.pos.y = 68 }
      return { status: 'done', detail: {} }
    }
  })
  c.setShaft({ x: 20, z: 89, bottom: 53, top: 68 })
  await c.routeReturnShaft('ore return')
  assert.equal(c.state.inventory.furnace, 1)
  assert.equal(c.state.inventory.cobblestone, 1)
})
test('failed portable furnace craft uses surface fallback instead of consuming recipe in shaft', async () => {
  const c = load({ stone_pickaxe: 1, raw_iron: 4, cobblestone: 9, dirt: 20 }, {}, { craft: () => false })
  c.setShaft({ x: 20, z: 89, bottom: 53, top: 68 })
  await c.routeReturnShaft('ore return')
  assert.ok(c.calls.some(([m]) => m === 'toSurface'))
  assert.ok(!c.calls.some(([m,p]) => m === 'tunnel' && p.direction === 'up'))
})
test('smelt repairs missing furnace with exactly its recipe before spending raw iron', async () => {
  const c = load({ stone_pickaxe: 1, crafting_table: 1, raw_iron: 4, oak_log: 3, iron_ingot: 1, flint_and_steel: 1 }, {}, {
    mine: (p,s) => { if (p.block === 'stone') { assert.equal(p.count, 8); assert.equal(p.dry, true); s.inventory.cobblestone = 8 }
      return { status: 'done', detail: { dug: p.block === 'stone' ? 8 : 0 } } },
    smelt: (p,s) => { if (!s.inventory.furnace) return { status: 'failed', detail: {} };
      s.inventory.raw_iron -= p.count; s.inventory.iron_ingot += p.count; return { status: 'done', detail: {} } }
  })
  c.setSituation({ surface: true })
  assert.equal(await c.routeStep({ kind: 'smelt' }), true)
  assert.equal(c.state.inventory.bucket, 1)
  assert.equal(c.state.inventory.raw_iron, 2)
  assert.ok(c.calls.findIndex(([m,p]) => m === 'craft' && p.item === 'furnace') < c.calls.findIndex(([m]) => m === 'smelt'))
})
test('unavailable furnace recipe stops before three identical smelt RPCs', async () => {
  const c = load({ stone_pickaxe: 1, raw_iron: 4, oak_log: 3 }, {}, { smelt: () => ({ status: 'failed', detail: {} }) })
  c.setSituation({ surface: true })
  assert.equal(await c.routeStep({ kind: 'smelt' }), false)
  assert.equal(c.calls.filter(([m]) => m === 'smelt').length, 0)
})
test('existing ingots need no furnace or new stone for bucket', async () => {
  const c = load({ iron_ingot: 3, flint_and_steel: 1 })
  assert.equal(await c.routeStep({ kind: 'smelt' }), true)
  assert.equal(c.calls.filter(([m]) => m === 'mine' || m === 'smelt').length, 0)
})
test('ND_ROUTE_FURNACE_SUPPLY=0 keeps previous smelt failure', async () => {
  const c = load({ stone_pickaxe: 1, raw_iron: 4, oak_log: 3 }, { ND_ROUTE_FURNACE_SUPPLY: '0' },
    { smelt: () => ({ status: 'failed', detail: {} }) })
  assert.equal(await c.routeStep({ kind: 'smelt' }), false)
  assert.equal(c.calls.filter(([m]) => m === 'smelt').length, 3)
  assert.equal(c.calls.filter(([m,p]) => m === 'mine' && p.block === 'stone').length, 0)
})
