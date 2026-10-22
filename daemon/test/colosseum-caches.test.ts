import test from 'node:test'
import assert from 'node:assert/strict'
import * as C from '../arena/colosseum'
import * as CA from '../arena/colosseum-arms'
import { cacheCells, pickCaches } from '../arena/colosseum-caches'

// Мир раунда, как его кладёт арена: модель Колизея, раскладка гонки поверх; над сундуками раскладки — плита (commands).
function world (seed: string) {
  const m = C.model({ R: 24, ceilH: 16 })
  const L = CA.generate(seed)
  for (const [x, y, z, b] of [...L.field, ...L.set]) m.g.set(x, y, z, b === 'air' ? '' : b.replace(/\{.*$/, ''))
  for (const c of L.chests) if (m.g.get(c.x, c.y + 1, c.z)) m.g.set(c.x, c.y + 1, c.z, 'smooth_sandstone_slab[type=top]')
  return { g: m.g, p: m.p, L }
}
const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const opaque = (b: string) => !!b && C.isFullCube(b) && !/glass|barrier|ice$|leaves/.test(C.parse(b).name)

test('тайники Колизея: 2–3 за раунд, все 6 соседей сплошные, не на поле, не у сундуков, разнесены', () => {
  const { g, p, L } = world('team1')
  const { cells } = cacheCells(L)
  assert.ok(cells.length > 1000, `мест под тайник мало: ${cells.length}`)
  const tops: number[] = []
  for (let round = 1; round <= 30; round++) {
    const cs = pickCaches(L, round)
    assert.ok(cs.length >= 2 && cs.length <= 3, `раунд ${round}: тайников ${cs.length}`)
    tops.push(Math.max(...cs.map(c => c.y)))
    for (const c of cs) {
      assert.equal(g.get(c.x, c.y, c.z), c.was, `раунд ${round}: тайник на месте камня стены`)
      for (const [dx, dy, dz] of N6) assert.ok(opaque(g.get(c.x + dx, c.y + dy, c.z + dz)), `раунд ${round}: сосед ${dx},${dy},${dz} тайника ${c.x},${c.y},${c.z} — «${g.get(c.x + dx, c.y + dy, c.z + dz)}»`)
      assert.ok(C.foot(p.A1, p.B1, c.x, c.z).n >= 0 && !(Math.abs(c.x) <= L.R && Math.abs(c.z) <= L.R), 'не на поле')
      assert.ok(L.chests.every((o: any) => Math.max(Math.abs(o.x - c.x), Math.abs(o.y - c.y), Math.abs(o.z - c.z)) > 2), 'не у сундука раскладки')
      assert.ok(c.items.length >= 4 && c.items.length <= 7, `предметов ${c.items.length}`)
      // Каждый тайник — сверх ванили: чары выше 5 или зелье с уровнем выше II.
      assert.ok(c.items.some(it => /:(?:[6-9]|[1-9]\d)[,}]/.test(it) || /amplifier:[3-9]/.test(it)), `тайник без сверхценного: ${c.items.join('; ')}`)
    }
    for (const a of cs) for (const b of cs) if (a !== b) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 16, 'тайники разнесены по горизонтали')
    assert.ok(cs[0].items.some(it => it.startsWith('trident')), 'трезубец — в каждом раунде')
    assert.deepEqual(pickCaches(L, round), cs, 'то же зерно и раунд — то же место')
  }
  assert.ok(tops.filter(y => y >= 22).length >= 8, `верх Колизея (dy ≥ 22) — редко: ${tops.join(',')}`)
  assert.notDeepEqual(pickCaches(L, 1).map(c => c.x), pickCaches(L, 2).map(c => c.x), 'раунды — разные места')
})
