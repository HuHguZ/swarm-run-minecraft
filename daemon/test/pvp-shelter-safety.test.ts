import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const Vec3 = require('vec3')
const esbuild = require('../../node_modules/esbuild')

function source(name: string, overrides: Record<string, any> = {}) {
  const file = path.resolve(__dirname, '../src', name + '.ts'), local = createRequire(file), module = { exports: {} as any }
  const code = esbuild.transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext(require('node:module').wrap(code), { filename: file })(module.exports,
    (id: string) => overrides[id] ?? local(id), module, file, path.dirname(file))
  return module.exports
}

function fixture(hp = 20) {
  const bot: any = new EventEmitter(), cells = new Map(), control: any = {}, calls: any[] = [], notes: string[] = []
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  let now = 5000
  const clock = { now: () => now, setTimeout, clearTimeout }
  bot.registry = registry; bot.health = hp; bot.food = 20; bot._client = new EventEmitter(); bot.version = '1.21.11'
  bot.entity = { id: 1, name: 'player', position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), width: .6, height: 1.8, onGround: true, effects: {}, metadata: [] }
  bot.entities = {}; bot.inventory = { slots: [], items: () => [{ name: 'dirt', type: registry.itemsByName.dirt.id, count: 64 }] }
  bot.blockAt = p => {
    const at = p.floored(), b = Block.fromStateId(registry.blocksByName[cells.get(at.toString()) || (at.y < 64 ? 'stone' : 'air')].defaultState)
    b.position = at; return b
  }
  bot.lookAt = async () => {}; bot.look = async () => {}; bot.equip = async i => { bot.heldItem = i }
  bot.setControlState = (k, v) => { control[k] = v }; bot.getControlState = k => !!control[k]
  bot.clearControlStates = () => { for (const k of Object.keys(control)) control[k] = false }
  bot.nearestEntity = () => null; bot.pathfinder = { setGoal: () => {}, movements: {} }
  const put = (ref, face, opts) => {
    const at = ref.position.plus(face); calls.push({ at, opts }); cells.set(at.toString(), bot.heldItem.name)
    bot.emit('blockUpdate', null, bot.blockAt(at)); return Promise.resolve()
  }
  bot._placeBlockWithOptions = put; bot.placeBlock = put; bot._genericPlace = put
  const sleep = async ms => {
    now += ms
    bot.entity.position.y = control.jump ? 65 : 64; bot.entity.onGround = !control.jump
    bot.emit('physicsTick')
  }
  const pick = source('pick'), build = source('build', { './game-clock': clock, './movement': { sleep } })
  const fortify = source('fortify', { './game-clock': clock, './movement': { sleep }, './build': build, './pick': pick })
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true; for (const fn of [...this.onAbort]) fn() } }
  const enemy: any = { id: 2, username: 'Enemy', name: 'player', type: 'player', position: new Vec3(2.5, 64, .5), width: .6, height: 1.8, isValid: true, metadata: [], equipment: [{ name: 'iron_sword' }] }
  const ctx: any = { bot, ctl, entity: enemy, prof: { player: true }, FIX: true, Vec3, pick, fortify, gameClock: clock,
    st: { build: { refused: 0, aborted: 0, box: 0, boxMs: [] } }, style: { reactMs: 150 }, BOX_MS: 2500, BOX_FRONT_MS: 1300,
    tt: { myHurtAt: 0, eta: () => 0, threats: () => [enemy] }, tempo: { PLAYER_REACH: 3 }, process: { env: {} },
    blockName: (_bot, p) => bot.blockAt(p).name, onFire: () => false, hasEffect: () => false,
    maceNow: () => false, ready: () => true, rest: () => {}, used: s => notes.push(s),
    pickFiller: build.pickFiller, countOf: () => 64, pathTo: () => {}, clear: bot.clearControlStates,
    holdWeapon: async () => {}, cooldownMs: () => 675, aim: 'target', pathing: false,
    reachFrom: () => 2, sleep }
  Object.assign(ctx, source('pvp/cover').createCover(ctx))
  ctx.fortSpot = () => fortify.feetCell(bot)
  return { bot, cells, calls, notes, ctl, enemy, ctx, fortify, control }
}

test('an enemy occupying a required wall refuses a box before centering or sending placement packets', async () => {
  const f = fixture(); f.enemy.position.x = 1.5; f.bot.entities[2] = f.enemy
  const out = await f.fortify.boxIn(f.bot, { toward: f.enemy.position, ctl: f.ctl })
  assert.equal(out.sealed, false); assert.equal(out.placed, 0); assert.equal(f.calls.length, 0)
  assert.match(out.why, /в клетке стоит/)
})

test('low HP and an immediately reachable visible enemy cannot trade a whole shelter for lethal incoming hits', async () => {
  const f = fixture(6); f.bot.entities[2] = f.enemy
  f.enemy.metadata = new Proxy([], { get(target, property) { if (String(property) === '9') throw Error('enemy health is private'); return target[property] } })
  Object.defineProperty(f.enemy.equipment[0], 'enchants', { get() { throw Error('enemy enchantments are private') } })
  f.ctx.tt.eta = () => 1600
  f.ctx.fortify = { ...f.fortify, boxIn: async () => { f.calls.push({ box: true }); return { cell: f.fortify.feetCell(f.bot), walls: 0, roof: false, placed: 0 } } }
  assert.equal(await f.ctx.fortOut(), false)
  assert.equal(f.calls.length, 0); assert.equal(f.ctx.fort, undefined); assert.equal(f.ctx.aim, 'target')
})

test('a shared box aborts immediately when hit during an unconfirmed placement', async () => {
  const f = fixture(8)
  f.bot._placeBlockWithOptions = async (_ref, _face, opts) => {
    f.calls.push({ opts }); f.bot.health = 4; f.bot.emit('health'); await new Promise(() => {})
  }
  const out = await f.fortify.boxIn(f.bot, { toward: f.enemy.position, ctl: f.ctl, timeoutMs: 3000 })
  assert.equal(out.aborted, true); assert.equal(out.sealed, false); assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].opts.forceLook, 'ignore'); assert.equal(f.bot.listenerCount('health'), 0)
})

test('an unpressured complete box builds honest walls and a real jumping roof support', async () => {
  const f = fixture()
  const out = await f.fortify.boxIn(f.bot, { toward: f.enemy.position, ctl: f.ctl })
  assert.equal(out.sealed, true); assert.equal(out.placed, 10)
  assert.ok(f.calls.some(c => c.opts?.delta), 'roof support clicked in its visible face while jumping')
  assert.equal(f.control.jump, false)
})

test('a construction obstruction ends the attempt and patch respects cancellation', async () => {
  const f = fixture(); f.bot._placeBlockWithOptions = async () => { throw Error('occupied by enemy') }
  const out = await f.fortify.boxIn(f.bot, { ctl: f.ctl, timeoutMs: 1 })
  assert.equal(out.placed, 0); assert.equal(out.sealed, false); assert.ok(out.failed?.length)
  f.ctl.abort()
  assert.equal(await f.fortify.patch(f.bot, out.plan, { ctl: f.ctl }), 0)
})

test('three walls and a failed roof cannot be reported as a fort', async () => {
  const f = fixture(); f.ctx.tt.eta = () => Infinity
  f.ctx.fortify = { ...f.fortify, boxIn: async () => ({ cell: f.fortify.feetCell(f.bot), walls: 3, roof: false, placed: 6, sealed: false }) }
  assert.equal(await f.ctx.fortOut(), false); assert.equal(f.ctx.fort, undefined)
})

test('the construction feasibility check prices existing walls and refuses an insufficient physical block supply', () => {
  const f = fixture(); f.bot.inventory.items = () => [{ name: 'dirt', count: 3 }]
  assert.equal(f.fortify.boxCheck(f.bot).ok, false)
  for (const side of f.fortify.SIDES) for (const h of [0, 1]) f.cells.set(new Vec3(0, 64, 0).plus(side).offset(0, h, 0).toString(), 'stone')
  const need = f.fortify.boxCheck(f.bot)
  assert.equal(need.ok, true); assert.equal(need.blocks, 2); assert.ok(need.ms < 1000)
})

test('cancellation during roof-support equipment cannot enable a late jump or placement', async () => {
  const f = fixture(), at = new Vec3(1, 66, 0)
  f.cells.set(at.offset(0, -1, 0).toString(), 'stone')
  f.bot.equip = async () => { f.ctl.abort() }
  const result = await f.fortify.jumpPlace(f.bot, at, { ctl: f.ctl })
  assert.equal(result.ok, false); assert.equal(f.control.jump, undefined); assert.equal(f.calls.length, 0)
})
