import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { climbCell } from '../src/blaze-melee'

// Шаблон MonsterThrone (jar 1.21.11) при четырёх поворотах вокруг спавнера.
const BRICKS = [[1, 0, 0, 5, 1, 7], [1, 2, 1, 5, 2, 7], [1, 3, 2, 5, 3, 7], [1, 4, 3, 5, 4, 7], [1, 2, 0, 1, 4, 2], [5, 2, 0, 5, 4, 2],
  [1, 5, 2, 1, 5, 3], [5, 5, 2, 5, 5, 3], [0, 5, 3, 0, 5, 8], [6, 5, 3, 6, 5, 8], [1, 5, 8, 5, 5, 8]]

function world (rot: number, origin = new Vec3(100, 60, -40)) {
  const cells = new Map<string, string>()
  // Поворот локальной (x, z) на rot×90° вокруг спавнера.
  const R = (x: number, z: number) => { let a = x - 3, b = z - 5; for (let k = 0; k < rot; k++) [a, b] = [-b, a]; return [a, b] }
  const sp = origin
  const put = (x, y, z, name) => { const [a, b] = R(x, z); cells.set(`${sp.x + a},${sp.y + y - 5},${sp.z + b}`, name) }
  for (const [x0, y0, z0, x1, y1, z1] of BRICKS) for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) put(x, y, z, 'nether_bricks')
  put(3, 5, 5, 'spawner')
  const bot: any = { entity: { position: sp.offset(0.5, 0, 3.5) }, blockAt: p => {
    const q = p.floored(), name = cells.get(`${q.x},${q.y},${q.z}`) || 'air'
    return { name, position: q, boundingBox: name === 'air' ? 'empty' : 'block' }
  } }
  return { bot, sp, R }
}

// ND_BLZ_CLIMB: тело под помостом — цель подъёма на полу помоста (ноги на уровне спавнера, в ±2) при любом повороте; на уровне — нет цели;
// спавнер не виден — пол под ифритом, стоящим выше нас.
test('climb: below the throne the target is a plinth cell at spawner level; none on level; unknown spawner — floor under a resting blaze', () => {
  for (let rot = 0; rot < 4; rot++) {
    const { bot, sp } = world(rot)
    bot.entity.position = sp.offset(6.5, -9, 0.5)
    const c = climbCell(bot, sp, [])
    assert.ok(c, `rotation ${rot}: target`)
    assert.equal(c.y, sp.y, 'feet at spawner level')
    assert.ok(Math.abs(c.x - sp.x) <= 2 && Math.abs(c.z - sp.z) <= 2, 'on the plinth')
    assert.equal(bot.blockAt(c.offset(0, -1, 0)).name, 'nether_bricks')
    bot.entity.position = c.offset(0.5, 0, 0.5)
    assert.equal(climbCell(bot, sp, []), null, `rotation ${rot}: on level — no climb`)
    bot.entity.position = sp.offset(4.5, 8, 0.5)
    assert.equal(climbCell(bot, sp, [])?.y, sp.y, `rotation ${rot}: above — down to the plinth`)
  }
  const { bot, sp } = world(0)
  bot.entity.position = sp.offset(6.5, -9, 0.5)
  const resting = { position: sp.offset(1.5, 0, 1.5) }, low = { position: sp.offset(6.5, -8, 2.5) }
  const f = climbCell(bot, null, [low, resting])
  assert.deepEqual(f && f.toArray(), sp.offset(1, 0, 1).toArray(), 'floor under the blaze on the plinth')
})

