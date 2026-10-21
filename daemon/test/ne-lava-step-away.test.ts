import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { stepAway } from '../src/lava-nav'

// Лавопад с севера (z−1), пол сплошной: шаг прочь — на юг, не под лаву и не к ней.
test('lava-nav: no trail — step to the dry side away from visible lava', () => {
  const lava = new Set(['0,64,-1', '0,65,-1', '0,66,-1', '0,67,-1', '1,67,0'])
  const blockAt = (p: Vec3) => {
    const k = `${p.x},${p.y},${p.z}`
    if (lava.has(k)) return { name: 'lava', boundingBox: 'empty', shapes: [], position: p }
    if (p.y <= 63) return { name: 'netherrack', boundingBox: 'block', position: p }
    return { name: 'air', boundingBox: 'empty', shapes: [], position: p }
  }
  const bot: any = { entity: { position: new Vec3(0.5, 64, 0.5) }, blockAt }
  const route = stepAway(bot)
  assert.ok(route.length >= 1)
  const end = route[route.length - 1]
  assert.ok(end.z > 1, `ушёл на юг: ${JSON.stringify(route)}`)
  assert.ok(!route.some(p => Math.floor(p.x) === 1 && Math.floor(p.z) === 0), 'не под лаву сверху')
})
