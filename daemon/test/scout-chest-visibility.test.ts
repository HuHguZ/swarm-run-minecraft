import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import { scoutStructures } from '../src/campaign/structure-search'
const Vec3 = require('vec3')
const data = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')(data)
const pick = require('../src/pick')

function fixture(hidden: 'chest' | 'clue' | null) {
  const chest = new Vec3(3, 64, 0), clue = new Vec3(3, 64, 2)
  const cells = new Map<string, string>([[chest.toString(), 'chest'], [clue.toString(), 'crying_obsidian']])
  if (hidden) for (const y of [64, 65]) cells.set(new Vec3(2, y, hidden === 'chest' ? 0 : 1).toString(), 'stone')
  const bot: any = { registry: data, game: { dimension: 'overworld' }, entity: { position: new Vec3(.5, 64, .5) }, entities: {},
    blockAt(p) { const at = p.floored(); const b = Block.fromStateId(data.blocksByName[cells.get(at.toString()) || 'air'].defaultState, 0); b.position = at; return b },
    findBlocks({ matching }) { return [...cells].filter(([, name]) => data.blocksByName[name].id === matching).map(([at]) => new Vec3(...at.slice(1, -1).split(',').map(Number))) },
    findBlock(options) { return this.findBlocks(options)[0] || null } }
  const opens = []
  const structures = { recordedAt: () => null, playerMarks: () => [], STRUCTURE_PLACES: require('../src/structures').STRUCTURE_PLACES,
    async takeWorth(_session, _ctl, at) { opens.push(at); return { took: { iron_ingot: 4 } } } }
  const file = path.join(__dirname, '../src/loot.ts'), req = createRequire(file)
  const context: any = { module: { exports: {} }, console, require: name => name === './structures' ? structures : req(name) }
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, context, { filename: file })
  const session = { bot, journal: { state: { looted: [], places: {} }, patch(fn) { fn(this.state) } } }
  return { chest, clue, bot, cells, opens, structures, session, loot: (options = { visibleOnly: true }) => context.module.exports.loot(session, { aborted: false, onAbort: [] }, { x: chest.x, y: chest.y, z: chest.z, ...options }) }
}

test('scout loot takes a visible chest beside a visible structure clue', async () => {
  const f = fixture(null)
  assert.equal(pick.blockSeen(f.bot, f.chest), true)
  assert.equal(pick.blockSeen(f.bot, f.clue), true)
  assert.equal((await f.loot()).took.iron_ingot, 4)
  assert.equal(f.opens.length, 1)
})

for (const place of ['лава', 'база', 'дом', 'мой склад']) test(`a remembered ${place} ${place === 'лава' ? 'does not own' : 'still protects'} the visible natural chest`, async () => {
  const f = fixture(null)
  f.session.journal.state.places = { [place]: { x: 3, y: 64, z: 0, dimension: 'overworld' } } as any
  const result = await f.loot()
  if (place === 'лава') { assert.equal(result.took?.iron_ingot, 4); assert.equal(f.opens.length, 1) }
  else { assert.ok(result.stopped); assert.equal(f.opens.length, 0) }
})

for (const failed of [false, true]) test(`a ${failed ? 'failed opening remains searchable' : 'successfully inspected empty chest is remembered'}`, async () => {
  const f = fixture(null)
  f.structures.takeWorth = async () => ({ took: {}, ...(failed ? { stopped: 'сундук не открылся' } : {}) }) as any
  await f.loot()
  assert.equal(f.session.journal.state.looted.includes(`${f.chest.x},${f.chest.y},${f.chest.z}`), !failed)
})

for (const hidden of ['chest', 'clue'] as const) test(`scout loot refuses a hidden ${hidden} even within five blocks`, async () => {
  const f = fixture(hidden)
  assert.equal(pick.blockSeen(f.bot, hidden === 'chest' ? f.chest : f.clue), false)
  const result = await f.loot()
  assert.ok(result.stopped, 'unobserved geometry cannot authorize a container open')
  assert.equal(f.opens.length, 0)
})

test('legacy nearby chest loot keeps its existing visibility policy', async () => {
  const f = fixture('chest')
  assert.equal((await f.loot({ visibleOnly: false })).took.iron_ingot, 4)
  assert.equal(f.opens.length, 1)
})

test('strict scout loot recognizes two visible ruin groups without crying obsidian or stored structure memory', async () => {
  const f = fixture(null)
  f.cells.set(f.clue.toString(), 'obsidian')
  const rubble = new Vec3(3, 64, -2)
  f.cells.set(rubble.toString(), 'netherrack')
  assert.equal(pick.blockSeen(f.bot, f.clue), true)
  assert.equal(pick.blockSeen(f.bot, rubble), true)
  assert.equal((await f.loot()).took?.iron_ingot, 4)
  assert.equal(f.opens.length, 1)
})

for (const missing of ['obsidian', 'netherrack', 'hidden', 'active portal', 'player marks', 'our base'] as const) test(`two-group ruin inference refuses ${missing}`, async () => {
  const f = fixture(missing === 'hidden' ? 'clue' : null)
  f.cells.set(f.clue.toString(), 'obsidian')
  f.cells.set(new Vec3(3, 64, -2).toString(), 'netherrack')
  if (missing === 'obsidian') f.cells.delete(f.clue.toString())
  if (missing === 'netherrack') f.cells.delete(new Vec3(3, 64, -2).toString())
  if (missing === 'active portal') f.cells.set(new Vec3(2, 64, -1).toString(), 'nether_portal')
  if (missing === 'player marks') f.structures.playerMarks = () => ['табличка рядом']
  if (missing === 'our base') f.session.journal.state.places = { база: { x: 3, y: 64, z: 0 } } as any
  assert.ok((await f.loot()).stopped)
  assert.equal(f.opens.length, 0)
})

test('two-group ruin inference keeps the legacy nearby clue policy unchanged', async () => {
  const f = fixture(null)
  f.cells.set(f.clue.toString(), 'obsidian')
  f.cells.set(new Vec3(3, 64, -2).toString(), 'netherrack')
  assert.ok((await f.loot({ visibleOnly: false })).stopped)
  assert.equal(f.opens.length, 0)
})

test('the overworld ruin signature also accepts a visible magma group', async () => {
  const f = fixture(null)
  f.cells.set(f.clue.toString(), 'obsidian')
  const magma = new Vec3(3, 64, -2)
  f.cells.set(magma.toString(), 'magma_block')
  assert.equal(pick.blockSeen(f.bot, magma), true)
  assert.equal((await f.loot()).took?.iron_ingot, 4)
})

test('ordinary Nether netherrack beside obsidian is not the overworld ruin signature', async () => {
  const f = fixture(null)
  f.bot.game.dimension = 'the_nether'
  f.cells.set(f.clue.toString(), 'obsidian')
  f.cells.set(new Vec3(3, 64, -2).toString(), 'netherrack')
  assert.ok((await f.loot()).stopped)
  assert.equal(f.opens.length, 0)
})

test('the bounded scout loot RPC honors its remaining game seconds', () => {
  let options
  require('../src/session/combat').loot.call({ runIntent(_name, _work, opts) { options = opts } }, { timeoutSeconds: 9, visibleOnly: true })
  assert.equal(options.timeoutMs, 9000)
})

for (const obstacle of ['wall', 'glass', 'deadline', 'none'] as const) test(`strict scout opening rechecks the ${obstacle} at activation`, async () => {
  const f = fixture(null)
  let opened = 0
  f.bot.pathfinder = { setGoal() {} }
  f.bot.lookAt = async () => { if (obstacle === 'wall' || obstacle === 'glass') for (const y of [64, 65]) f.cells.set(new Vec3(2, y, 0).toString(), obstacle === 'wall' ? 'stone' : 'glass') }
  f.bot.openContainer = async () => { opened++; return {} }
  const gc = require('../src/game-clock')
  assert.equal(pick.blockSeen(f.bot, f.chest), true)
  const open = require('../src/containers').findAndOpen({ bot: f.bot }, { aborted: false, onAbort: [] }, { ...f.chest, visibleOnly: true }, gc.now() + (obstacle === 'deadline' ? -1 : 1000))
  if (obstacle === 'none') { await open; assert.equal(opened, 1) }
  else { await assert.rejects(open); assert.equal(opened, 0) }
})

test('the overworld route scout also consumes its observed chest before another leg', async () => {
  let now = 0
  const calls = []
  const ctx = { state: { pos: { x: 0, y: 64, z: 0 } }, sit: { surface: true }, process: { env: {} }, died: false,
    have: () => 0, refresh: async () => {}, sense: async () => {}, gameClock: { now: () => now }, rlog() {},
    async act(method, params) { calls.push({ method, params }); if (method === 'explore') { now += 400; return { detail: { found: 'chest', at: { x: 3, y: 64, z: 0 } } } } return { detail: method === 'loot' ? { took: { iron_ingot: 4 } } : { known: [] } } } }
  const result = await require('../src/campaign/overworld-route').createOverworldRoute(ctx).routeStep({ kind: 'scoutIron' })
  assert.equal(result, true)
  assert.equal(calls.filter(c => c.method === 'loot').length, 1)
  assert.equal(calls.find(c => c.method === 'loot').params.visibleOnly, true)
  assert.equal(calls.find(c => c.method === 'explore').params.unlootedContainers, true)
  assert.equal(calls.filter(c => c.method === 'goto').length, 0)
})

test('a repeated empty observed chest is attempted once within the same search budget', async () => {
  let now = 0, attempts = 0
  await scoutStructures({ now: () => now, position: () => ({ x: 0, z: 0 }), scan: async () => {}, list: async () => [],
    explore: async () => { now += 2000; return { found: 'chest', at: { x: 3, y: 64, z: 0 } } },
    loot: async () => { attempts++; return false }, move: async () => {}, interrupted: () => false, fact() {}, log() {} } as any, 0)
  assert.equal(attempts, 1)
})

for (const stop of ['deadline', 'abort'] as const) test(`an observed chest cannot start loot after the ${stop}`, async () => {
  let now = 0, aborted = false, attempts = 0
  await scoutStructures({ now: () => now, position: () => ({ x: 0, z: 0 }), scan: async () => {}, list: async () => [],
    explore: async () => { if (stop === 'deadline') now = 180000; else aborted = true; return { found: 'chest', at: { x: 3, y: 64, z: 0 } } },
    loot: async () => { attempts++; return true }, move: async () => {}, interrupted: () => aborted, fact() {}, log() {} } as any, 0)
  assert.equal(attempts, 0)
})
