'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const esbuild = require('esbuild')
const { Vec3 } = require('vec3')
const Move = require('mineflayer-pathfinder/lib/move')

// Real installed AStar and current production patch; only the reachable world
// graph and body pose are doubled. Keep this instance isolated from other tests.
function searchCase (options: any = {}) {
  const nativeFile = require.resolve('mineflayer-pathfinder/lib/astar')
  const nativeModule = new Module(nativeFile, module)
  nativeModule.filename = nativeFile
  nativeModule.paths = Module._nodeModulePaths(path.dirname(nativeFile))
  nativeModule._compile(fs.readFileSync(nativeFile, 'utf8'), nativeFile)
  const AStar = nativeModule.exports
  const file = path.join(__dirname, '../src/fastblocks.ts')
  const patched = new Module(file, module)
  patched.filename = file
  patched.paths = Module._nodeModulePaths(path.dirname(file))
  const nativeRequire = patched.require.bind(patched)
  patched.require = (request: string) => request === 'mineflayer-pathfinder/lib/astar' ? AStar : nativeRequire(request)
  const before = { s9: process.env.ND_S9, max: process.env.ND_ASTAR_NODES_PER_MS, slice: process.env.ND_ASTAR_SLICE_NODES }
  process.env.ND_S9 = '1'; process.env.ND_ASTAR_NODES_PER_MS = '0'; process.env.ND_ASTAR_SLICE_NODES = '1'
  try {
    patched._compile(esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, file)
    const node = (x: number, z: number) => new Move(x, 1, z, 0, 1)
    const bot = { entity: { position: new Vec3(0.5, 1, 0.5) } }
    const movements = {
      bot,
      getNeighbors: (n: any) => {
        const x = Math.floor(n.x), z = Math.floor(n.z)
        if (x === 0 && z === 0) return [node(1, 0)]
        if (x === 1 && z === 0) return options.deadEnd ? [] : [node(1, 1)]
        if (z === 1 && x < 5) return [node(x + 1, 1)]
        if (x === 5 && z === 1) return [node(5, 0)]
        return []
      }
    }
    const goal = {
      heuristic: (n: any) => Math.abs(5 - Math.floor(n.x)) + Math.abs(Math.floor(n.z)),
      isEnd: (n: any) => Math.floor(n.x) === (options.terminal ? 1 : 5) && Math.floor(n.z) === 0
    }
    const search = new AStar(node(0, 0), movements, goal, 5000, 40)
    const first = search.compute()
    assert.equal(first.status, 'partial')
    assert.equal(first.path.length, 1)
    // Native postProcessPath mutates the returned Move into its standing point.
    first.path[0].x = 1.5; first.path[0].z = .5
    bot.entity.position = new Vec3(options.x ?? 1.5, options.y ?? 1, .5)
    if (options.break) first.path[0].toBreak.push(new Vec3(1, 2, 0))
    if (options.place) first.path[0].toPlace.push({ x: 1, y: 0, z: 0 })
    const best = search.bestNode
    const next = search.compute()
    return { search, bot, first, next, best }
  } finally {
    for (const [key, value] of [['ND_S9', before.s9], ['ND_ASTAR_NODES_PER_MS', before.max], ['ND_ASTAR_SLICE_NODES', before.slice]] as Array<[string, string | undefined]>) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
}

test('partial AStar continues its actual queued detour after the closest prefix has been reached', () => {
  const { search, next, best } = searchCase()
  assert.equal(next.status, 'partial')
  assert.equal(search.bestNode, best, 'frontier execution must not replace the continuing search best')
  assert.deepEqual(next.path.map((n: any) => [n.x, n.z]), [[1.5, .5], [1, 1]], 'return the real parent chain beyond the already reached closest node')
  assert.equal(next.ndPartialNode, search.openHeap.heap[1])
  assert.ok(search.closedDataSet.size > 1, 'the same native search has continued expanding')
})

for (const [label, options] of [
  ['unreached horizontal point', { x: 1.14 }],
  ['different height', { y: 2 }],
  ['pending break', { break: true }],
  ['pending placement', { place: true }]
] as Array<[string, any]>) test(`partial closest prefix remains intact with ${label}`, () => {
  const { next, best, search } = searchCase(options)
  assert.equal(next.status, 'partial')
  assert.equal(next.path.at(-1), best.data)
  assert.equal(next.ndPartialNode, undefined)
  assert.equal(search.bestNode, best)
})

test('terminal noPath keeps its true status and does not fabricate frontier progress', () => {
  const { next } = searchCase({ deadEnd: true })
  assert.equal(next.status, 'noPath')
  assert.equal(next.ndPartialNode, undefined)
})

test('terminal success keeps its real goal result', () => {
  const { next } = searchCase({ terminal: true })
  assert.equal(next.status, 'success')
  assert.equal(next.ndPartialNode, undefined)
})
