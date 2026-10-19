'use strict'
// Поток overworld (02.10.2026, вечер): колодец через снег без лопаты и «крышка» над колодцем от моба сверху.
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { shaftDown } from '../src/mining'
import build = require('../src/build')

function rig (extra: any = {} as Record<string, any>) {
  const dug = new Set()
  const placed: Record<string, any> = {} as Record<string, any>
  const name = p => {
    const k = `${p.x},${p.y},${p.z}`
    if (placed[k]) return placed[k]
    if (dug.has(k)) return 'air'
    if (extra[k]) return extra[k]
    return p.y >= 70 ? 'air' : 'stone'
  }
  // Тип 1 — камень (кирка годна), тип 3 — снег (нужна лопата, которой нет; рукой 1 с).
  const block = p => {
    const q = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const n = name(q)
    const empty = /^(air|cave_air|lava|water)$/.test(n)
    const snow = n === 'snow_block'
    return { name: n, type: snow ? 3 : 1, position: q, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]], hardness: snow ? 0.2 : 1.5, diggable: true, digTime: () => (snow ? 1000 : 600) }
  }
  let digs = 0
  const bot: Record<string, any> = {
    entity: { position: new Vec3(0.5, 70, 0.5), onGround: true, height: 1.8 },
    health: 20,
    entities: {} as Record<string, any>,
    inventory: { items: () => [{ name: 'stone_pickaxe', type: 2, count: 1 }], slots: [] },
    heldItem: { name: 'stone_pickaxe', type: 2 },
    blockAt: block,
    equip: async () => {},
    dig: async b => {
      dug.add(`${b.position.x},${b.position.y},${b.position.z}`)
      digs++
      let y = b.position.y
      while (name(new Vec3(0, y - 1, 0)) === 'air' || name(new Vec3(0, y - 1, 0)) === 'cave_air') y--
      bot.entity.position = new Vec3(0.5, y, 0.5)
      if (bot.onDig) bot.onDig(digs)
    }
  }
  const session = { bot, mcData: { blocks: { 1: { harvestTools: { 2: true } }, 3: { harvestTools: { 99: true } } }, items: { 99: { name: 'wooden_shovel' } } } }
  const ctl = { aborted: false, onAbort: [] }
  return { session, ctl, bot, placed }
}

test('колодец: снег под ногами без лопаты — копается рукой/киркой (≤ 1.5 с), колодец идёт дальше', async () => {
  const { session, ctl, bot } = rig({ '0,68,0': 'snow_block', '0,67,0': 'snow_block' })
  const r = await shaftDown(session, ctl, { length: 6, timeoutSeconds: 30 })
  assert.equal(r.stopped, undefined, r.stopped)
  assert.equal(r.descended, 6)
  assert.equal(bot.entity.position.y, 64)
})

test('колодец: скелет сверху, тело уже в колодце — крышка над головой и вниз дальше', async () => {
  const { session, ctl, bot, placed } = rig()
  const orig = build.placeBlockAt
  build.placeBlockAt = async (b, pos) => { placed[`${pos.x},${pos.y},${pos.z}`] = 'cobblestone'; return { ok: true, placed: 'cobblestone' } }
  bot.onDig = n => { if (n === 3) bot.entities[7] = { id: 7, name: 'skeleton', type: 'hostile', position: new Vec3(0.5, 70, 0.5), height: 1.99, width: 0.6 } }
  try {
    const r = await shaftDown(session, ctl, { length: 10, timeoutSeconds: 30 })
    assert.equal(r.stopped, undefined, r.stopped)
    assert.equal(r.descended, 10)
    assert.match(r.note || '', /крышка/)
    assert.equal(Object.keys(placed).length, 1)
  } finally { build.placeBlockAt = orig }
})

test('колодец: моб сверху у самого устья (ещё не в колодце) — стоп, как раньше', async () => {
  const { session, ctl, bot } = rig()
  bot.entities[7] = { id: 7, name: 'skeleton', type: 'hostile', position: new Vec3(0.5, 72, 0.5), height: 1.99, width: 0.6 }
  const r = await shaftDown(session, ctl, { length: 10, timeoutSeconds: 30 })
  assert.match(r.stopped || '', /skeleton .* сверху — колодец бросаю/)
})

test('сухое возвышение: низина на 63 с водой, холм 70 в 20 бл. к востоку — подсказка на холм', () => {
  const { dryGround }: typeof import('../src/mining') = require('../src/mining')
  const name = p => {
    const hill = p.x >= 18 && p.x <= 24 && Math.abs(p.z) <= 3
    const top = hill ? 69 : 62
    if (p.y > top) return 'air'
    if (!hill && p.y === 62 && p.x > 4) return 'water'
    return 'grass_block'
  }
  const bot: Record<string, any> = {
    entity: { position: new Vec3(0.5, 63, 0.5) },
    blockAt: p => { const n = name(p); return { name: n, position: p, boundingBox: /air|water/.test(n) ? 'empty' : 'block' } }
  }
  const d = dryGround(bot)
  assert.ok(d, 'нашёл')
  assert.ok(d.x >= 18 && d.x <= 24, `x ${d.x}`)
  assert.equal(d.y, 70)
})

test('подъём колодцем: digUp по уровню до toY, стоп на отказе', async () => {
  const { shaftUp }: typeof import('../src/mining') = require('../src/mining')
  const b: typeof import('../src/build') = require('../src/build')
  const orig = b.digUp
  const bot: Record<string, any> = { entity: { position: new Vec3(0.5, 16, 0.5) }, health: 20, entities: {} as Record<string, any> }
  b.digUp = async () => { bot.entity.position = bot.entity.position.offset(0, 1, 0); return { dug: 0 } as any }
  try {
    const r = await shaftUp({ bot, mcData: {} as Record<string, any> }, { aborted: false, onAbort: [] }, { length: 96, toY: 40, timeoutSeconds: 30 })
    assert.equal(r.climbed, 24)
    assert.equal(r.stopped, undefined)
    b.digUp = async () => ({ dug: 0, stopped: 'сверху water — не копаю' })
    const r2 = await shaftUp({ bot, mcData: {} as Record<string, any> }, { aborted: false, onAbort: [] }, { length: 10, timeoutSeconds: 30 })
    assert.match(r2.stopped, /water/)
  } finally { b.digUp = orig }
})
