import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

for (const hazard of ['safe', 'lava', 'edge', 'wall']) {
  test(`a complete landing prices its support and skid once (${hazard})`, () => {
    const filename = require.resolve('../src/elytra/control'), load = createRequire(filename), control: any = {}
    let quote: any
    runInNewContext(readFileSync(filename, 'utf8'), { exports: control, require: name => name === './landing'
      ? { landingPlan: (_W, _st, _goal, price) => { quote = price; return {} } } : load(name) }, { filename })
    const counts = { floor: 0, box: 0, safe: 0 }
    const W = {
      floorBelow: (x: number) => { counts.floor++; return hazard === 'lava' ? { top: 100, lava: true }
        : hazard === 'edge' && x > 1 ? null : { top: 100 } },
      boxHit: () => { counts.box++; return hazard === 'wall' },
      landingSafe: () => { counts.safe++; return true }
    }
    const st = { p: { x: .5, y: 101, z: .5 }, v: { x: .6, y: -.1, z: 0 }, boost: 0, fd: 0 }
    const goal = { kind: 'land', at: { x: 3, y: 100, z: .5 } }
    const r = { p: { x: .5, y: 99.99, z: .5 }, v: st.v, fd: 1, t: 3, kind: 'floor' }
    control.choose(W, st, goal)
    const expected = control.cost(W, st, goal, () => goal.at, r, 0, 0), single = { ...counts }
    counts.floor = counts.box = counts.safe = 0
    const result = quote(r)
    assert.equal(result.c, expected, 'the full physical price must stay unchanged')
    assert.equal(result.safe, hazard === 'safe', 'lava, an unsupported skid and a wall remain unsafe')
    assert.deepEqual(counts, single, 'certification must share the same support/skid check as its price')
  })
}
