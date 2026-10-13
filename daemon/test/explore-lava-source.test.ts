import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
const Vec3 = require('vec3')

// Load both complete production modules. Visibility and walking are the boundary;
// cast.lavaSources itself decides which observed lava can feed the portal skill.
const code = Object.fromEntries(['actions', 'cast'].map(name => [name,
  transformSync(fs.readFileSync(path.join(__dirname, `../src/${name}.ts`), 'utf8'), { loader: 'ts', format: 'cjs' }).code]))

function fixture(options: any = {}) {
  let now = 0, walks = 0, outside = options.outside !== false, sealed = !!options.sealed
  const calls: string[] = [], reads: string[] = []
  const block = (x, z, level) => ({ name: 'lava', position: new Vec3(x, 64, z), getProperties: () => ({ level }) })
  const flow = block(options.flowX ?? (options.memory ? 12 : 3), 0, 3)
  const covered = block(4, 0, 0), hidden = block(5, 0, 0)
  const source = block(options.sourceX ?? (options.memory ? 75 : 63), options.sourceZ ?? 0, 0)
  const bot: any = {
    game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0) },
    registry: { blocksByName: { lava: { id: 10 } } },
    pathfinder: { movements: { canDig: true, scafoldingBlocks: [] } },
    blockAt(p) { reads.push(p.toString()); return { name: p.equals(covered.position.offset(0, 1, 0)) ? 'stone' : 'air' } }
  }
  if (options.memory) bot._ndEyes = {}
  const imports: Record<string, any> = {
    './game-clock': { now: () => now },
    './movement': {
      xyz: p => ({ x: p.x, y: p.y, z: p.z }), sleep: async ms => { now += ms },
      travelXZ: async (_bot, _ctl, x, z) => {
        calls.push('travel'); now += 1000
        if (sealed) return { ok: false, error: 'noPath: confirmed walls' }
        walks++; bot.entity.position = new Vec3(x, 64, z)
        return { ok: true }
      }
    },
    './items': { GROUPS: {}, resolveBlockIds: () => [10] }, './build': {}, './pick': {},
    './sight': { visibleOf: (_bot, _ids, radius, { max }) => [flow, covered, hidden, source]
      .filter(b => b !== hidden && (b !== covered || options.rejectSources) && (b !== source || (!options.noSource && walks >= (options.revealAfter ?? 1))) &&
        (b !== flow || walks >= (options.flowAfter ?? 0)) && b.position.distanceTo(bot.entity.position) <= radius)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)).slice(0, max) },
    './worlds': { worldOf: () => 'overworld' },
    './survival': { surface: async () => { calls.push('surface'); now += 1000; outside = true; sealed = false } },
    './fortify': { enclosure: () => ({ sealed }), leaveSealedCell: async () => null },
    './perception/eyes': { nearest: () => [{ name: 'lava', x: 12, y: 64, z: 0 }] },
    'vec3': Vec3, 'mineflayer-pathfinder': { goals: {} }
  }
  const modules: Record<string, any> = {}
  const load = name => {
    if (modules[name]) return modules[name].exports
    const module = modules[name] = { exports: {} }
    vm.runInNewContext(code[name], { module, exports: module.exports, process: { env: {} }, console: { log() {} },
      require(request) {
        if (request === './cast') return load('cast')
        if (request in imports) return imports[request]
        throw new Error(`unexpected dependency ${request}`)
      }
    }, { filename: path.join(__dirname, `../src/${name}.ts`) })
    return module.exports
  }
  const session = { bot, cfg: { fairPlay: true }, mcData: { blocks: { 10: { name: 'lava' } } }, underSky: () => outside, surfaceWalk: false }
  return { bot, calls, reads, source, hidden, cast: load('cast'),
    run: (params: any = {}) => load('actions').explore(session, { aborted: false, onAbort: [] },
      { block: 'lava', radius: 48, stepDistance: 60, timeoutSeconds: 3, lavaSource: true, ...params }) }
}

test('portal source search walks past a visible flow instead of repeating a stationary cast refusal', async () => {
  const f = fixture()
  assert.equal(f.cast.lavaSources(f.bot).length, 0)
  const result = await f.run()
  assert.equal(result.at.x, f.source.position.x)
  assert.deepEqual(f.calls, ['travel'])
})

test('a flow after surface preflight does not complete a portal source search', async () => {
  const f = fixture({ outside: false })
  const result = await f.run({ surface: true, timeoutSeconds: 15 })
  assert.equal(result.at.x, f.source.position.x)
  assert.deepEqual(f.calls, ['surface', 'travel'])
})

test('seeing a remembered flow after approaching it still requires a source', async () => {
  const f = fixture({ memory: true, revealAfter: 2 })
  const result = await f.run()
  assert.equal(result.at.x, f.source.position.x)
  assert.deepEqual(f.calls, ['travel', 'travel'])
  assert.match(result.legs[0], /память lava/)
})

test('a first walking leg that reveals only a flow continues to another observation', async () => {
  const f = fixture({ flowX: 61, flowAfter: 1, revealAfter: 2, sourceZ: 60 })
  const result = await f.run()
  assert.equal(result.at.z, 60)
  assert.deepEqual(f.calls, ['travel', 'travel'])
})

test('an already observed source accepted by the actual cast predicate ends the search immediately', async () => {
  const f = fixture({ revealAfter: 0, sourceX: 2 })
  const result = await f.run()
  assert.equal(result.at.x, 2)
  assert.deepEqual(f.calls, [])
})

test('hidden and covered sources do not become found resources; the existing deadline ends the search', async () => {
  const f = fixture({ noSource: true, rejectSources: true })
  const result = await f.run()
  assert.equal(result.found, null)
  assert.equal(f.calls.length, 3)
  assert.ok(!f.reads.includes(f.hidden.position.offset(0, 1, 0).toString()))
})

test('ordinary lava exploration still accepts an already visible flow without walking', async () => {
  const f = fixture()
  const result = await f.run({ lavaSource: false })
  assert.equal(result.at.x, 3)
  assert.equal(result.walked, 0)
  assert.deepEqual(f.calls, [])
})

test('a confirmed box exits before scouting even while the client skylight still says outside', async () => {
  const f = fixture({ sealed: true })
  const result = await f.run({ surface: true, timeoutSeconds: 15 })
  assert.equal(result.at?.x, f.source.position.x)
  assert.deepEqual(f.calls, ['surface', 'travel'])
})

test('an explicit underground search keeps its walls and bounded no-path receipt', async () => {
  const f = fixture({ sealed: true })
  const result = await f.run({ surface: false, timeoutSeconds: 15 })
  assert.equal(result.stuck, true)
  assert.equal(f.calls.includes('surface'), false)
})

test('a sealed surface search does not exceed its remaining recovery budget', async () => {
  const f = fixture({ sealed: true })
  const result = await f.run({ surface: true, timeoutSeconds: 3 })
  assert.equal(result.found, null)
  assert.equal(f.calls.includes('surface'), false)
})
