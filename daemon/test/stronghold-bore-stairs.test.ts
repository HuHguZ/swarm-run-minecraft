'use strict'
// ND_SH_BORE (sr27-end): штрек под землёй к лестнице старта — по осям к углу + 4, кирпич в забое — стоп «крепость», ниже y 5 —
// сперва ступенями вверх.
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')

function scene (y = 40, brickX = null) {
  const D: any = require('../src/endportal-descent')
  const saved = { step: D.honestTunnelStep, level: D.toLevel }
  const bot: any = { entity: { position: new Vec3(0.5, y, 0.5) } }
  const steps = []; const levels = []
  D.honestTunnelStep = async (_s, _c, cell, o) => {
    steps.push({ cell, o })
    if (brickX !== null && cell.x === brickX) return { ok: false, dug: 0, why: 'stone_bricks в забое', brick: 'stone_bricks' }
    bot.entity.position = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5)
    return { ok: true, dug: 2 }
  }
  D.toLevel = async (_s, _c, ty) => { levels.push(ty); bot.entity.position = new Vec3(0.5, ty, 0.5); return { ok: true, dug: 5 } }
  const gx: any = { session: { bot }, ctl: { aborted: false }, bot, deadline: Infinity, corner: { x: 20, z: 0 } }
  return { gx, bot, steps, levels, restore () { D.honestTunnelStep = saved.step; D.toLevel = saved.level } }
}

test('bore walks the main axis to the start stairs (corner + 4) and stops within one block', async () => {
  const s = scene()
  try {
    const r = await require('../src/endportal/go-steps').boreToStairs(s.gx)
    assert.equal(r.ok, true)
    assert.equal(r.bricks, undefined)
    const f = s.bot.entity.position.floored()
    assert.ok(Math.abs(f.x - 24) <= 1 && Math.abs(f.z - 4) <= 1, `стою ${f}`)
    assert.ok(s.steps.every(x => x.o.throughBricks === false), 'кирпич не копать — это крепость')
    assert.equal(s.levels.length, 0)
  } finally { s.restore() }
})

test('bore stops at the first stronghold brick and reports it as found', async () => {
  const s = scene(40, 10)
  try {
    const r = await require('../src/endportal/go-steps').boreToStairs(s.gx)
    assert.equal(r.ok, true)
    assert.equal(r.bricks.found, 'stone_bricks')
    assert.equal(r.bricks.at.x, 10)
  } finally { s.restore() }
})

test('bore from a deep cave first climbs to y 20, and refuses a far target', async () => {
  const s = scene(-38)
  try {
    const gs = require('../src/endportal/go-steps')
    const r = await gs.boreToStairs(s.gx)
    assert.deepEqual(s.levels, [20])
    assert.equal(r.ok, true)
    s.gx.corner = { x: 400, z: 0 }
    const far = await gs.boreToStairs(s.gx)
    assert.equal(far.ok, false)
    assert.match(far.why, /далеко/)
  } finally { s.restore() }
})
