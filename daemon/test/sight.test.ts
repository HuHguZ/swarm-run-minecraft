'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const { visibleOf } = require('../src/sight')

function fixture ({ metadata = true, storage = 'palette', targets = [], hidden = [] }: any = {} as Record<string, any>) {
  const minY = -64
  const blocks = new Map(targets.map(p => [p.join(','), new Vec3(...p)]))
  const hiddenKeys = new Set(hidden.map(p => p.join(',')))
  const columns = new Map()
  let reads = 0
  let paletteChecks = 0
  const paletted = palette => {
    const some = palette.some
    palette.some = function (fn) { paletteChecks++; return some.call(this, fn) }
    return { palette }
  }
  const column = (cx, cz) => {
    const key = `${cx},${cz}`
    if (!columns.has(key)) {
      const col: Record<string, any> = { getBlockStateId: p => {
        reads++
        return blocks.has(`${cx * 16 + p.x},${p.y},${cz * 16 + p.z}`) ? 7 : 0
      } }
      if (metadata) {
        col.sections = Array.from({ length: 24 }, (_, sy) => {
          const mixed = targets.some(([x, y, z]: any) => (x >> 4) === cx && (z >> 4) === cz && Math.floor((y - minY) / 16) === sy)
          return { data: storage === 'direct' ? {} as Record<string, any> : mixed ? paletted([0, 7]) : storage === 'palette' ? paletted([0]) : { value: 0 } }
        })
      }
      columns.set(key, col)
    }
    return columns.get(key)
  }
  const bot = {
    registry: { blocks: { 1: { minStateId: 7, maxStateId: 7 } }, blocksByStateId: { 0: { boundingBox: 'empty' }, 7: { boundingBox: 'block' } } },
    game: { minY, height: 384 },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: p => ({ name: blocks.has(`${p.x},${p.y},${p.z}`) ? 'oak_log' : 'air', position: p.clone(), shapes: [] }),
    world: {
      getColumn: column,
      raycast: (_eye, delta) => {
        const target = targets.find(p => {
          const d = new Vec3(...p).offset(0.5, 0.5, 0.5).minus(bot.entity.position.offset(0, 1.62, 0)).normalize()
          return d.distanceTo(delta) < 1e-9
        })
        return target && !hiddenKeys.has(target.join(',')) ? bot.blockAt(new Vec3(...target)) : null
      }
    }
  }
  return { bot, reads: () => reads, paletteChecks: () => paletteChecks }
}

for (const storage of ['palette', 'uniform']) {
  test(`visibleOf skips sections known to contain no target states (${storage})`, () => {
    const f = fixture({ storage })
    assert.deepEqual(visibleOf(f.bot, [1], 48, { max: 1 }), [])
    assert.equal(f.reads(), 0, 'an empty radius-48 scan must not read 462781 block states')
  })
}

test('visibleOf checks each section palette once per scan and rechecks on the next scan', t => {
  const f = fixture({ targets: [[1, 64, 0]] })
  visibleOf(f.bot, [1], 48, { fair: false })
  const first = f.paletteChecks()
  assert.ok(first <= 500, `repeated section palette checks: ${first}`)
  visibleOf(f.bot, [1], 48, { fair: false })
  assert.equal(f.paletteChecks(), first * 2, 'no section result survives into the next call')
  t.diagnostic(`radius-48 palette witness: ${first} palette checks per scan`)
})

test('visibleOf reads only the matching section, retaining radius, LOS, skip and nearest order', t => {
  const targets = [[1, 64, 0], [2, 64, 0], [3, 64, 0], [4, 64, 0], [15, 70, 15]]
  const f = fixture({ targets, hidden: [[2, 64, 0]] })
  const result = visibleOf(f.bot, [1], 48, { max: 2, skip: p => p.x === 1 })
  assert.deepEqual(result.map(b => b.position.x), [3, 4])
  assert.ok(f.reads() < 5000, `unexpected full scan: ${f.reads()} state reads`)
  t.diagnostic(`radius-48 mixed-section witness: ${f.reads()} state reads (before: 462786)`)
  const withoutSight = visibleOf(f.bot, [1], 3, { max: 10, fair: false })
  assert.deepEqual(withoutSight.map(b => b.position.x), [1, 2, 3])
})

for (const opts of [{ metadata: false }, { storage: 'direct' }]) {
  test(`visibleOf falls back without palette evidence: ${JSON.stringify(opts)}`, () => {
    const f = fixture({ ...opts, targets: [[1, 64, 0]] })
    assert.deepEqual(visibleOf(f.bot, [1], 3, { fair: false }).map(b => b.position.x), [1])
    assert.ok(f.reads() > 1)
  })
}
