import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'
import { screenCells } from '../src/blaze/wall'
import { exposure } from '../src/blaze/cover'

// Пол y=63 на x,z ∈ [−10, 10]; поставленные блоки — в set. Ифрит висит на уровне глаз в 6 бл. по x.
function world (extra: string[] = []) {
  const put = new Set(extra)
  const solid = (x: number, y: number, z: number) => (y === 63 && Math.abs(x) <= 10 && Math.abs(z) <= 10) || put.has(`${x},${y},${z}`)
  const blockAt = (p: any) => { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); return solid(x, y, z) ? { name: 'cobblestone', boundingBox: 'block', position: new Vec3(x, y, z) } : { name: 'air', boundingBox: 'empty', position: new Vec3(x, y, z) } }
  const raycast = (from: any, dir: any, max: number, match: any) => {
    for (let t = 0; t <= max; t += 0.05) { const b = blockAt(from.plus(dir.scaled(t))); if (match(b)) return b }
    return null
  }
  return { put, blockAt, world: { raycast } }
}

test('screenCells: ифрит на уровне глаз — подпорка на полу и клетка головы рядом; после них луча нет', () => {
  const w = world()
  const pos = new Vec3(0.5, 64, 0.5)
  const blaze = { position: new Vec3(6.5, 64.1, 0.5) }
  const cells = screenCells(w.blockAt, pos, blaze.position.offset(0, 1.53, 0))
  assert.deepEqual(cells.map(c => `${c.x},${c.y},${c.z}`), ['1,64,0', '1,65,0'])
  const bot: any = { blockAt: w.blockAt, world: w.world, entity: { position: pos } }
  assert.equal(exposure(bot, pos.floored(), [blaze]).n, 1)
  for (const c of cells) w.put.add(`${c.x},${c.y},${c.z}`)
  assert.equal(exposure(bot, pos.floored(), [blaze]).n, 0, 'заслон закрыл глаза ±0.3')
})

test('screenCells: стоит опора — один блок; ифрит вплотную или за стеной — ничего', () => {
  const w = world(['1,64,0'])
  const pos = new Vec3(0.5, 64, 0.5)
  assert.deepEqual(screenCells(w.blockAt, pos, new Vec3(6.5, 65.63, 0.5)).map(c => `${c.x},${c.y},${c.z}`), ['1,65,0'])
  assert.deepEqual(screenCells(w.blockAt, pos, new Vec3(1.5, 65.6, 0.5)), [])
  const w2 = world(['1,65,0'])
  assert.deepEqual(screenCells(w2.blockAt, pos, new Vec3(6.5, 65.63, 0.5)), [])
})

test('screenCells: клетка не задевает коробку тела у края клетки', () => {
  const w = world()
  const pos = new Vec3(0.85, 64, 0.5) // коробка 0.55..1.15 — задевает x=1
  const cells = screenCells(w.blockAt, pos, new Vec3(7.5, 65.63, 0.5))
  assert.ok(cells.length > 0)
  for (const c of cells) assert.ok(c.x >= 2, `клетка ${c.x} вне тела`)
})
