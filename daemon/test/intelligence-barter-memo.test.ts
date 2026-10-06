const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Vec3 = require('vec3')
const { createRequire } = require('node:module')
const { coverRecord } = require('../src/bastion/cover-memory')

interface SealedState {
  sealed: boolean
  noPick: boolean
  pred: Map<string, { pos: unknown }>
  towered: number
  sealedDone: boolean
  sealedState?: { own: Set<string> }
}

function restoreTrade(mode: string, options: { key?: string; cells?: string[]; age?: number; far?: boolean;
  persisted?: unknown; historical?: string[]; breach?: boolean; unloaded?: boolean; mouth?: boolean; lava?: boolean } = {}): SealedState {
  const source = fs.readFileSync(path.resolve(__dirname, '../src/bastion/bastion.js'), 'utf8')
  const start = source.indexOf('  const memoKey = ')
  const end = source.indexOf('  const memoSave = ', start)
  assert.ok(start > 0 && end > start, 'actual Bastion restoration block exists')
  const st: SealedState = { sealed: true, noPick: false, pred: new Map(), towered: 0, sealedDone: false }
  const rec = { x: 91, y: 49, z: 139 }
  const memory = { t: 0, pred: new Map([['105,48,132', { pos: { x: 105, y: 48, z: 132 } }]]), mined: new Set(),
    own: new Set(options.cells ?? ['89,54,141', '89,55,141']), entry: { x: 89, y: 54, z: 141 }, filled: new Set(), exposed: false }
  const air = new Set(['89,54,141', '89,55,141'])
  if (options.breach) air.add('90,54,141')
  if (options.mouth) { air.add('89,56,141'); air.add('90,56,141') }
  const blockAt = at => {
    const key = `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`
    if (options.unloaded && key === '89,55,141' || Math.abs(at.x) > 1000) return null
    if (options.lava && key === '89,53,141') return { name: 'lava', boundingBox: 'empty', shapes: [] }
    return air.has(key) ? { name: 'air', boundingBox: 'empty', shapes: [] }
      : { name: 'blackstone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
  }
  const fresh = options.persisted !== undefined || options.historical !== undefined
  const context = { mode, st, rec, Vec3, MEMO: fresh ? new Map() : new Map([[options.key ?? '91,139', memory]]),
    gameClock: { now: () => options.age ?? 1000, wall: { now: () => 1000 } },
    require: createRequire(path.resolve(__dirname, '../src/bastion/bastion.js')),
    worlds: require('../src/worlds'), fullCover: b => !!b && b.name === 'blackstone', log: () => {},
    session: { journal: { state: { bastionCovers: { '91,139': options.persisted } } }, _tunnelOwn: new Set(options.historical ?? []) },
    bot: { game: { dimension: 'the_nether' }, blockAt,
      entity: { position: options.far ? new Vec3(250, 54, 141) : new Vec3(89.5, 54, 141.5) } } }
  vm.runInNewContext(source.slice(start, end), context)
  return st
}

test('barter restores the protected trade branch of the mined Bastion while mapped gold remains', () => {
  const st = restoreTrade('barter')
  assert.equal(st.pred.size, 1, 'remaining mapped gold is preserved')
  assert.equal(st.sealedDone, true, 'actual protected trade branch becomes executable')
  assert.ok(st.sealedState?.own.has('89,54,141'))
  assert.equal(restoreTrade('auto').sealedDone, false, 'normal mining can continue')
})

test('a reloaded Bastion activates protected barter from serialized own cells and current native geometry', () => {
  const record = coverRecord('91,139', 'the_nether', 0,
    ['89,54,141', '89,55,141', '5000,54,141'], { x: 5000, y: 54, z: 141 })
  const persisted = JSON.parse(JSON.stringify(record))
  const st = restoreTrade('barter', { persisted })
  assert.equal(st.sealedDone, true, 'the actual Bastion branch can run after losing the in-process MEMO')
  assert.deepEqual([...st.sealedState!.own].sort(), ['89,54,141', '89,55,141'])
  assert.equal(restoreTrade('barter', { persisted, breach: true }).sealedDone, false)
  assert.equal(restoreTrade('barter', { persisted, unloaded: true }).sealedDone, false)
  assert.equal(restoreTrade('barter', { persisted, lava: true }).sealedDone, false)
  assert.equal(restoreTrade('barter', { persisted: { ...persisted, site: '545,-99' } }).sealedDone, false)
})

test('legacy own-cell memory is recognized physically; only the existing high trading mouth may remain open', () => {
  const cells = ['89,54,141', '89,55,141', '89,56,141', '5000,54,141']
  assert.equal(restoreTrade('barter', { historical: cells, mouth: true }).sealedDone, true)
  const legacy = restoreTrade('barter', { historical: ['89,54,141', '89,55,141'], mouth: true })
  assert.equal(legacy.sealedDone, true, 'old digPit did not record its last native mouth dig')
  assert.ok(legacy.sealedState!.own.has('89,56,141'), 'only the physically verified protected mouth is adopted')
  assert.equal(restoreTrade('barter', { historical: cells, mouth: true, breach: true }).sealedDone, false)
  assert.equal(restoreTrade('barter', { historical: cells, far: true }).sealedDone, false)
})

test('foreign, empty, distant, and expired tunnel memories cannot assert a protected trade state', () => {
  for (const options of [{ key: '545,-99' }, { cells: [] }, { far: true }, { age: 3600001 }]) {
    assert.equal(restoreTrade('barter', options).sealedDone, false)
  }
})
