import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'
import { exposure, coverCell } from '../src/blaze/cover'

// Мир: пол y=63 (x −10..10, z −10..10), стена x=2 по z −1..1 высотой 2 (y 64..65). Ифрит на x=6 — за стеной от клеток x ≤ 1, z ∈ [−1, 1].
function world () {
  const solid = (x: number, y: number, z: number) => (y === 63 && Math.abs(x) <= 10 && Math.abs(z) <= 10) || (x === 2 && (y === 64 || y === 65) && Math.abs(z) <= 1)
  const blockAt = (p: any) => { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); return solid(x, y, z) ? { name: 'nether_bricks', boundingBox: 'block', position: new Vec3(x, y, z) } : { name: 'air', boundingBox: 'empty', position: new Vec3(x, y, z) } }
  const raycast = (from: any, dir: any, max: number, match: any) => {
    for (let t = 0; t <= max; t += 0.05) { const b = blockAt(from.plus(dir.scaled(t))); if (match(b)) return b }
    return null
  }
  return { blockAt, world: { raycast } }
}

test('exposure: за стеной — 0, на виду — 1', () => {
  const w = world()
  const bot: any = { blockAt: w.blockAt, world: w.world, entity: { position: new Vec3(0.5, 64, 0.5) } }
  const blaze = { position: new Vec3(6.5, 64, 0.5) }
  assert.equal(exposure(bot, new Vec3(0, 64, 0), [blaze]).n, 0)
  assert.equal(exposure(bot, new Vec3(0, 64, 4), [blaze]).n, 1)
})

test('coverCell: с открытого места — в клетку за стеной', () => {
  const w = world()
  const bot: any = { blockAt: w.blockAt, world: w.world, entity: { position: new Vec3(0.5, 64, 4.5) } }
  const c = coverCell(bot, [{ position: new Vec3(6.5, 64, 0.5) }], { radius: 7 })
  assert.ok(c, 'укрытие найдено')
  assert.equal(c.w, 0)
  assert.ok(c.pos.x <= 1 && c.pos.z <= 2, JSON.stringify(c.pos)) // тень стены z −1..1 (блоки до z<2) от ифрита на x 6.5
})
