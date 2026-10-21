import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import { Vec3 } from 'vec3'
import { REPO_ROOT } from '../src/paths'

const sourceRoot = process.env.ND_DESERT_TEST_ROOT || REPO_ROOT
const realRequire = createRequire(path.join(REPO_ROOT, 'daemon/package.json'))
function load(name: string, mocks: Record<string, any> = {}, env: Record<string, string> = {}, tail = '') {
  const module = { exports: {} }
  const target = path.join(sourceRoot, name)
  const text = fs.readFileSync(fs.existsSync(target) ? target : path.join(REPO_ROOT, name), 'utf8')
  const code = transformSync(text, { loader: 'ts', format: 'cjs' }).code
  const context: any = { module, exports: module.exports, process: { env }, console, setTimeout, clearTimeout,
    require: (key: string) => key in mocks ? mocks[key] : realRequire(key) }
  vm.runInNewContext(code + tail, context, { filename: name })
  return module.exports as any
}

function fixture(options: any = {}) {
  let now = 0
  const env = { ND_OW_DESERT_LOOK: '1', ND_OW_DESERT_HAND_SHELTER: '1', ...options.env }
  const inventory: Record<string, number> = { sand: options.sand ?? 0 }
  const calls: any[] = [], blocks = new Map<string, string>()
  const bot: any = { entity: { position: new Vec3(.5, 64, .5), onGround: true }, game: { dimension: 'overworld' },
    settings: { viewDistance: 8 }, inventory: { items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })) },
    blockAt(p: any) { const name = blocks.get(p.floored().toString()) || (p.y < 64 ? 'sand' : 'air');
      return { name, position: p.floored(), boundingBox: name === 'air' ? 'empty' : 'block' } },
    async dig(b: any) { calls.push(['dig', b.name]); blocks.set(b.position.toString(), 'air'); if (!options.noFall) bot.entity.position.y-- }, stopDigging() {} }
  let wet = !!options.wet
  const ctl: any = { aborted: false, onAbort: [] }
  const mocks: any = {
    '../game-clock': { now: () => now },
    '../movement': { inWater: () => wet, escapeWater: async () => { calls.push(['escape']); if (!options.wetStuck) wet = false },
      sleep: async (ms: number) => { now += ms } },
    '../perception/eyes': { surface: (b: any, p: any) => options.surface?.(b, p) || null },
    '../items': { countOf: (_b: any, name: string) => inventory[name] || 0, equipBestTool: async () => {} },
    '../build': { withTimeout: (p: any) => p,
      pickFiller: (_b: any, p: any = {}) => Object.entries(inventory).filter(([name, n]) => n > 0 && (!p.steady || name !== 'sand'))
        .map(([name, count]) => ({ name, count }))[0] || null,
      towerUp: async (_b: any, _c: any, n: number, p: any) => { calls.push(['tower', n, p.item]);
        if (options.towerAbort) ctl.aborted = true
        for (let i = 0; i < n; i++) { blocks.set(bot.entity.position.floored().toString(), p.item); bot.entity.position.y++ }
        inventory[p.item] -= n
        return { ok: true, placed: n } } },
    './gather': { mine: async (_s: any, _c: any, p: any) => { calls.push(['mine', p]); inventory.sand += p.count } },
    './craft': { craft: async (_s: any, _c: any, p: any) => { calls.push(['craft', p]); inventory.sand -= 4; inventory.sandstone = 1 } }
  }
  const api = load('daemon/src/actions/desert.ts', mocks, env)
  const walk = async (x: number, z: number, p: any) => { calls.push(['walk', x, z, p]); return { ok: true } }
  return { bot, ctl, inventory, calls, blocks, api, walk, env, mocks, session: { bot, mcData: {} } }
}

test('desert flags are off by default and dimension-scoped', async () => {
  const f = fixture({ env: { ND_OW_DESERT_LOOK: '0', ND_OW_DESERT_HAND_SHELTER: '0' } })
  assert.equal(await f.api.desertTreeLook(f.session, f.ctl, f.walk, 60000), null)
  assert.equal(await f.api.desertRoof(f.session, f.ctl), false)
  f.bot.game.dimension = 'the_nether'; f.env.ND_OW_DESERT_LOOK = '1'
  assert.equal(await f.api.desertTreeLook(f.session, f.ctl, f.walk, 60000), null)
  assert.equal(f.calls.length, 0)
})

test('actual eyes rays stop at opaque dunes, unloaded columns and the 8-chunk range', () => {
  const eyes = load('daemon/src/perception/eyes.ts', { '../game-clock': {}, '../pick': { eyeHeight: () => 1.62 },
    '../perception': { biomeName: () => 'desert' } })
  const f = fixture(), cells = new Map<string, number>()
  const fill = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, id: number) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) cells.set(`${x},${y},${z}`, id)
  }
  f.bot.registry = { blocksByStateId: [{ name: 'air', boundingBox: 'empty' }, { name: 'sand', boundingBox: 'block' },
    { name: 'mangrove_leaves', boundingBox: 'block' }, { name: 'mangrove_log', boundingBox: 'block' }] }
  f.bot.game.minY = -64; f.bot.game.height = 384
  let loaded = true
  f.bot.world = { getColumn: (cx: number, cz: number) => !loaded && cx > 2 ? null :
    { getBlockStateId: (p: any) => cells.get(`${cx * 16 + p.x},${p.y},${cz * 16 + p.z}`) || 0 } }
  // Wide enough canopy to be sampled; the enclosed trunk must never be returned as the first hit.
  fill(96, 100, 70, 80, -6, 6, 2); fill(98, 98, 70, 76, 0, 0, 3)
  const api = load('daemon/src/actions/desert.ts', { '../game-clock': {}, '../perception/eyes': eyes,
    '../movement': {}, '../build': {}, '../items': {} })
  assert.equal(api.treeHorizon(f.bot, f.ctl).name, 'mangrove_leaves')
  fill(8, 8, 50, 100, -30, 30, 1)
  assert.equal(api.treeHorizon(f.bot, f.ctl), null, 'opaque dune hides canopy and log')
  cells.clear(); fill(140, 144, 70, 80, -6, 6, 2)
  assert.equal(api.treeHorizon(f.bot, f.ctl), null, 'no evidence outside 128 blocks')
  cells.clear(); fill(96, 100, 70, 80, -6, 6, 2); loaded = false
  assert.equal(api.treeHorizon(f.bot, f.ctl), null, 'unknown chunk terminates sight')
})

test('leaves seen above a six-sand tower survive descent as a canopy hint', async () => {
  const f = fixture({ sand: 6, surface: (b: any, p: any) => p.yaw === 270 && p.pitch === -15 && b.entity.position.y >= 69
    ? { name: 'mangrove_leaves', pos: { x: -68, y: 95, z: 85 }, dist: 109 } : null })
  const result = await f.api.desertTreeLook(f.session, f.ctl, f.walk, 60000)
  assert.equal(result.tree.name, 'mangrove_leaves'); assert.equal(result.raised, 6)
  assert.equal(f.bot.entity.position.y, 64)
  assert.equal(f.calls.filter(x => x[0] === 'dig').length, 6)
  assert.equal(result.found, undefined, 'canopy is not a confirmed log')
})

test('dune is tried before spending sand and a failed descent halts exploration', async () => {
  const f = fixture({ sand: 6, noFall: true, surface: (_b: any, p: any) => p.maxDist === 32 && p.yaw === 0
    ? { name: 'sand', pos: { x: 0, y: 70, z: 20 }, dist: 20 } : null })
  const result = await f.api.desertTreeLook(f.session, f.ctl, f.walk, 60000)
  assert.equal(f.calls[0][0], 'walk'); assert.match(result.stopped, /descent/)
  assert.equal(f.calls.filter(x => x[0] === 'dig').length, 1, 'no tight dig loop while physics is stalled')
})

test('wet scouting really escapes first; failure never builds or walks', async () => {
  const f = fixture({ wet: true, wetStuck: true, sand: 6 })
  assert.match((await f.api.desertTreeLook(f.session, f.ctl, f.walk, 60000)).stopped, /water/)
  assert.deepEqual(f.calls.map(x => x[0]), ['escape'])
})

test('an abort during ascent never digs the tower or starts a canopy approach', async () => {
  const f = fixture({ sand: 6, towerAbort: true })
  assert.match((await f.api.desertTreeLook(f.session, f.ctl, f.walk, 60000)).stopped, /descent/)
  assert.equal(f.calls.some(x => x[0] === 'walk' || x[0] === 'dig'), false)
  assert.equal(f.ctl.aborted, true)
})

test('actual any_log explore approaches a canopy but reports success only for an observed log', async () => {
  for (const logVisible of [false, true]) {
    const f = fixture(), calls: any[] = []
    f.bot.pathfinder = { movements: null }
    let now = 0
    const api = load('daemon/src/actions/gather.ts', {
      '../game-clock': { now: () => now }, '../items': { resolveBlockIds: () => [1] }, '../build': {},
      '../movement': { xyz: (p: any) => ({ x: p.x, y: p.y, z: p.z }), waterBudgetOn: () => false,
        travelXZ: async (_b: any, _c: any, x: number, z: number) => { calls.push([x, z]); now = 60000; return { ok: true } } },
      '../sight': { visibleOf: () => now > 0 && logVisible ? [{ name: 'mangrove_log', position: new Vec3(-67, 93, 87) }] : [] },
      '../fortify': { leaveSealedCell: async () => {} },
      './desert': { desertTreeLook: async () => ({ tree: { name: 'mangrove_leaves', pos: { x: -68, y: 95, z: 85 } }, raised: 6 }) }
    }, { ND_OW_DESERT_LOOK: '1' })
    const result = await api.explore({ bot: f.bot, cfg: { fairPlay: true }, mcData: {}, underSky: () => true }, f.ctl,
      { block: 'any_log', timeoutSeconds: 45 })
    assert.deepEqual(calls, [[-68, 85]])
    assert.equal(result.found, logVisible ? 'mangrove_log' : null)
  }
})

test('hand shelter prepares a stable sandstone roof and preserves three exit blocks', async () => {
  const f = fixture()
  assert.equal(await f.api.desertRoof(f.session, f.ctl), true)
  assert.equal(f.inventory.sandstone, 1); assert.equal(f.inventory.sand, 3)
  assert.equal(f.calls[0][1].count, 7); assert.equal(f.calls[0][1].minY, 63)
  assert.equal(f.calls[0][1].fair, true); assert.equal(f.calls[1][1].item, 'sandstone')
  assert.equal(f.calls[1][1].count, 1)
})

test('exit primitive can break the sandstone roof by hand; default tool guard still refuses it', async () => {
  const bot: any = { entity: { position: new Vec3(.5, 61, .5) },
    blockAt: (p: any) => ({ name: p.y === 63 ? 'sandstone' : 'air', boundingBox: p.y === 63 ? 'block' : 'empty', position: p }),
    dig: async () => {} }
  const api = load('daemon/src/build.ts', { './game-clock': {}, './movement': { sleep: async () => {} },
    './items': { missingHarvestTool: () => 'need pick', equipBestTool: async () => {} } })
  const ctl = { aborted: false }, mcData = {}
  assert.equal((await api.digUp(bot, ctl, { blocks: 1, mcData, tower: false })).dug, 0)
  assert.equal((await api.digUp(bot, ctl, { blocks: 1, mcData, tower: false, handSandstone: true })).dug, 1)
  bot.blockAt = (p: any) => ({ name: p.y === 64 ? 'water' : p.y === 63 ? 'sandstone' : 'air',
    boundingBox: p.y === 63 ? 'block' : 'empty', position: p })
  assert.equal((await api.digUp(bot, ctl, { blocks: 1, mcData, tower: false, handSandstone: true })).dug, 0, 'water hazard guard remains active')
})

test('one sand over two sandstone: enter and exit consume real reserve, sandstone has no hand drop', async () => {
  const f = fixture(), { bot, inventory, blocks } = f
  const key = (p: any) => p.floored().toString()
  bot.on = bot.once = () => bot; bot.removeListener = () => bot; bot.clearControlStates = () => {}
  bot.blockAt = (p: any) => { const name = blocks.get(key(p)) || (p.y < 63 ? 'sandstone' : p.y < 64 ? 'sand' : 'air');
    return { name, position: p.floored(), boundingBox: name === 'air' ? 'empty' : 'block' } }
  bot.dig = async (b: any) => { blocks.set(key(b.position), 'air'); if (b.name === 'sand') inventory.sand++
    if (b.position.y === Math.floor(bot.entity.position.y) - 1) bot.entity.position.y-- }
  const movement = { sleep: async () => {}, xyz: (p: any) => ({ x: p.x, y: p.y, z: p.z }), inWater: () => false }
  const items = { missingHarvestTool: (_b: any, b: any) => b.name === 'sandstone' ? 'need pick' : null,
    equipBestTool: async () => {}, itemNamed: () => null }
  const build = load('daemon/src/build.ts', { './game-clock': {}, './movement': movement, './items': items,
    './test-tower': async () => {
      if (!inventory.sand) return { placed: 0, reason: 'no blocks' }
      inventory.sand--; blocks.set(key(bot.entity.position), 'sand'); bot.entity.position.y++
      return { placed: 1, ok: true }
    } }, {}, "\ntowerUp = require('./test-tower');")
  const primitive = load('daemon/src/survival/enter-shelter.ts', {
    '.././game-clock': { now: () => 0, setInterval: () => ({ unref() {} }), clearInterval() {} },
    '.././movement': movement, '.././items': items,
    '.././build': { ...build, pickFiller: f.mocks['../build'].pickFiller,
      placeBlockAt: async (_b: any, p: any, options: any) => {
        assert.equal(options.steady, true); assert.ok(inventory.sandstone)
        inventory.sandstone--; blocks.set(key(p), 'sandstone'); return { ok: true }
      } },
    '.././actions': {}, '.././combat': {}, '.././perception': {}, '.././reach': {},
    '.././worlds': { worldOf: () => 'overworld' }, '../actions/desert': f.api
  }, f.env)
  const session: any = { ...f.session, journal: { append() {}, patch() {} } }
  const entered = await primitive.enterShelter(session, f.ctl, { depth: 3, torch: false })
  assert.equal(entered.sealed, true); assert.equal(entered.depth, 3)
  assert.ok(inventory.sand >= 3, 'before any tower exit we still own three scaffold blocks')
  const out = await primitive.exitShelter(session, f.ctl, { depth: 3 })
  assert.equal(out.out, true); assert.equal(out.climbed, 3); assert.equal(bot.entity.position.y, 64)
  assert.equal(inventory.sandstone, 0, 'neither natural sandstone nor roof returns a block by hand')
})

test('speedrun night threat reaches hand shelter without a pick or nightHold and then replans', async () => {
  const calls: any[] = []
  const state: any = { playPolicy: { mode: 'speedrun' } }, sit: any = { night: true, surface: true, foes: 1, inWater: false }
  const defaults = new Proxy({}, { get: (_t, key) => key === '__esModule' ? false : () => {} })
  const mocks: any = {
    '../state': { state, sit, died: false }, '../queries': { dim: () => 'overworld', have: () => 0 },
    '../act': { act: async (name: string, p: any) => { calls.push([name, p]); if (name === 'shelter') sit.surface = false; return { detail: { sealed: true, depth: 3 } } } },
    '../danger': { leaveWater: async () => { calls.push(['shore']); return true } },
    '../stages/table': { nightHold: () => false },
    '../../src/game-clock': { now: () => 0 }
  }
  for (const name of ['../log', '../observe', '../underground', '../scout', '../nether-trip', '../night-work-step']) mocks[name] = defaults
  const api = load('daemon/campaign/loop/night.ts', mocks, { ND_OW_DESERT_HAND_SHELTER: '1' })
  assert.equal(await api.loopNight({}), 'continue')
  assert.deepEqual(calls.map(x => x[0]), ['shelter', 'refuge'])
  assert.equal(calls[1][1].untilDawn, undefined)
  assert.equal(calls.some(x => x[0] === 'wait'), false)
  calls.length = 0; await api.loopNight({})
  assert.equal(calls.length, 0, 'the next protected turn does not dig deeper or flee')
  calls.length = 0; sit.foes = 0
  await api.loopNight({}); assert.equal(calls.length, 0, 'night alone is not a reason to stop useful work')
})

test('structure scouting calls the shore action and keeps the temple eligible afterwards', async () => {
  const calls: any[] = [], state = { pos: { x: 0, y: 63, z: 0 } }, sit = { inWater: true }
  const temple = { kind: 'desert_pyramid', name: 'temple', at: { x: 70, y: 65, z: 0 }, fit: { chests: [] } }
  const mocks: any = {
    './flags': {}, './rpc': {}, './state': { state, sit, known: {}, died: false }, './log': { log() {} },
    './queries': { dim: () => 'overworld', have: () => 0, foodUnits: () => 0, goldOn: () => false, shieldOn: () => false, lighter: () => false },
    './observe': { sense: async () => {} }, './stages/table': {}, './travel': {}, './kit': {}, './strategy-bridge': {},
    '../src/game-clock': { now: () => 0 },
    '../src/campaign/structure-value': { PRIOR: { desert_pyramid: 1 }, structureWorth: () => ({}), withNight: () => ({ net: 10, distance: 70 }), describeWorth: () => 'test' },
    './act': { act: async (_name: string, p: any) => p.mode === 'list' ? { detail: { known: [temple] } } : {} },
    './danger': { leaveWater: async () => { calls.push('shore'); return false } }
  }
  const api = load('daemon/campaign/scout.ts', mocks, { ND_OW_DESERT_SHORE: '1' })
  await api.lootSeenStructures(); await api.lootSeenStructures()
  assert.deepEqual(calls, ['shore', 'shore'], 'failed water exit must not mark the temple tried')
})
