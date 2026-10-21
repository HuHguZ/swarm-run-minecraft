import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { reachOf } from '../src/reach'

// owC7-12: паук за ходом шириной в клетку — «дойдёт за 6 шаг.» стопорил спуск 7 игр. мин; паук 1.4 в клетку не пролезает.
function world (open: string[]) {
  const air = new Set(open)
  return {
    entity: { position: new Vec3(0.5, 1, 0.5), eyeHeight: 1.62 },
    world: { raycast: () => null },
    blockAt: (p: any) => air.has(`${p.x},${p.y},${p.z}`) ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' }
  }
}
// Тело (0,0), стена (1,0); ход в клетку (0,1)→(0,2)→(1,2)→(2,2)→(2,1)→(2,0) с мобом в (2,0).
const corridor = ['0,1,0', '0,2,0', '0,1,1', '0,1,2', '1,1,2', '2,1,2', '2,1,1', '2,1,0']
const mob = (name: string, width: number) => ({ name, width, height: name === 'spider' ? 0.9 : 0.5, position: new Vec3(2.5, 1, 0.5), metadata: [] })

test('ND_OW_SPIDER_WIDTH: a 1.4-wide spider cannot path a one-wide corridor; a cave spider still can; off keeps the old stop', () => {
  const bot = world(corridor)
  delete process.env.ND_OW_SPIDER_WIDTH
  assert.equal(reachOf(bot, mob('spider', 1.4)).reaches, true, 'flag off: old conservative stop')
  process.env.ND_OW_SPIDER_WIDTH = '1'
  try {
    assert.equal(reachOf(bot, mob('spider', 1.4)).reaches, false)
    assert.equal(reachOf(bot, mob('cave_spider', 0.7)).reaches, true)
    // Двухшириный ход паук проходит.
    const wide = world([...corridor, '-1,1,1', '-1,1,2', '1,1,1', '3,1,1', '3,1,0', '1,1,3', '2,1,3', '0,1,3', '-1,1,3', '3,1,2', '3,1,3'])
    assert.equal(reachOf(wide, mob('spider', 1.4)).reaches, true)
  } finally { delete process.env.ND_OW_SPIDER_WIDTH }
})
