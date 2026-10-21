import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { digUp } from '../src/build'

// ND_OW_GRAVEL_SETTLE=1: digUp не встаёт столбом под сыплющуюся колонну — перекапывает гравий, пока клетка не пуста.
test('ND_OW_GRAVEL_SETTLE: digUp re-digs a falling gravel column before reporting the headroom clear', async () => {
  process.env.ND_OW_GRAVEL_SETTLE = '1'
  try {
    const world = new Map<string, string>()
    const key = p => `${p.x},${p.y},${p.z}`
    for (let y = 31; y <= 33; y++) world.set(`0,${y},0`, 'stone')
    world.set('0,30,0', 'air'); world.set('0,31,0', 'air')
    world.set('0,34,0', 'gravel'); world.set('0,35,0', 'gravel')
    const block = p => { const name = world.get(key(p)) || 'air'; return { name, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'air' ? 'empty' : 'block' } }
    const bot: any = {
      entity: { position: new Vec3(0.5, 30, 0.5) }, blockAt: p => block(p.floored ? p.floored() : p),
      inventory: { items: () => [], slots: [] }, heldItem: null, equip: async () => {},
      dig: async b => {
        world.set(key(b.position), 'air')
        // гравий над вскрытой клеткой падает в неё
        let y = b.position.y
        while (world.get(`0,${y + 1},0`) === 'gravel' && world.get(`0,${y},0`) === 'air') { world.set(`0,${y},0`, 'gravel'); world.set(`0,${y + 1},0`, 'air'); y++ }
      }
    }
    const r = await digUp(bot, { aborted: false }, { blocks: 1, tower: false })
    // feet+2 и feet+3 вскрыты, гравий 34–35 упал в 33 и перекопан: над головой пусто, а не гравий
    for (const y of [32, 33, 34, 35]) assert.equal(world.get(`0,${y},0`), 'air', `y${y}`)
    assert.equal(r.dug, 4)
  } finally { delete process.env.ND_OW_GRAVEL_SETTLE }
})
