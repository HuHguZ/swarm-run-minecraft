import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import pick = require('../src/pick')
import { createLastSeen, seesPlayer, gearPartVisible, observePlayerGear } from '../src/pvp/last-seen'
import { observationMethods } from '../src/rpc/observation'

function scene () {
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(.5, 0, .5), onGround: true },
    registry: (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  })
  let shape = [0, 0, 0, 1, 1, 1], name = 'stone', missing = false
  bot.blockAt = p => {
    if (missing) return null
    const position = p.floored(), solid = position.x === 3 && position.z === 0 && position.y >= 0 && position.y <= 2
    return { position, name: solid ? name : 'air', boundingBox: solid ? 'block' : 'empty', shapes: solid ? [shape] : [] }
  }
  const raw: any = { id: 2, type: 'player', username: 'Foe', position: new Vec3(4.5, 0, .5), height: 1.8, width: .6, onGround: true }
  return { bot, raw, wall: (value: number[], material = 'stone') => { shape = value; name = material }, missing: () => { missing = true } }
}

for (const part of [false, true]) test(`sight reuses an opaque cube within one ${part ? 'gear' : 'body'} query`, t => {
  const f = scene(), original = pick.blockOnRay
  const ray = t.mock.method(pick, 'blockOnRay', (...args: Parameters<typeof pick.blockOnRay>) => original(...args))
  assert.equal(part ? gearPartVisible(f.bot, f.raw, 4) : seesPlayer(f.bot, f.raw), false)
  assert.ok(ray.mock.callCount() <= 2, `one cube must not require ${ray.mock.callCount()} complete DDA rays`)
  f.wall([0, 0, 0, 1, 1, 1], 'glass')
  assert.equal(part ? gearPartVisible(f.bot, f.raw, 4) : seesPlayer(f.bot, f.raw), true, 'a later call must see changed terrain')
})

test('sight shortcut preserves exact rays around partial blocks, cube edges, poses and transparent walls', () => {
  const f = scene()
  const reference = (part: number | null) => {
    const eye = pick.eyeOf(f.bot), box = pick.hitboxOf(f.bot, f.raw)
    const heights = [[.35, .75], [.35, .75], [0, .18], [.15, .50], [.48, .75], [.75, 1]]
    const points = part === null ? [[.5, .5, .5], [.5, .9, .5], [.1, .5, .1], [.9, .5, .9], [.1, .5, .9], [.9, .5, .1]]
      : heights[part].flatMap(y => [.1, .5, .9].flatMap(x => [.1, .5, .9].map(z => [x, y, z])))
    const world = { blockAt: p => f.bot.blockAt(p) || { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } }
    return points.some(([x, y, z]) => {
      const delta = new Vec3(box.lo.x + box.w * x, box.lo.y + box.h * y, box.lo.z + box.w * z).minus(eye), d = delta.norm()
      return d <= (part === null ? 128 : 64) && (d < 1e-6 || !pick.blockOnRay(world, eye, delta.scaled(1 / d), d, /glass|_pane$|^barrier$|^iron_bars$/))
    })
  }
  for (const shape of [[0, 0, 0, 1, 1, 1], [0, 0, 0, 1, .5, 1], [.4, 0, .4, .6, 1.5, .6]]) {
    for (const material of ['stone', 'glass']) for (const z of [-.31, 0, .5, 1, 1.31]) for (const gliding of [false, true]) {
      f.wall(shape, material); f.raw.position.z = z; f.raw.elytraFlying = gliding
      assert.equal(seesPlayer(f.bot, f.raw), reference(null), `body ${shape}/${material}/${z}/${gliding}`)
      const expected = Array.from({length: 6}, (_, i) => reference(i))
      assert.deepEqual(observePlayerGear(f.bot, f.raw).visible, expected, `all gear ${shape}/${material}/${z}/${gliding}`)
      for (let i = 0; i < 6; i++) assert.equal(gearPartVisible(f.bot, f.raw, i), expected[i], `gear ${i}/${shape}/${material}/${z}/${gliding}`)
    }
  }
})

test('unavailable terrain never becomes an observed occluder or reveals a body', t => {
  const f = scene(); f.missing()
  const original = pick.blockOnRay, ray = t.mock.method(pick, 'blockOnRay', (...args: Parameters<typeof pick.blockOnRay>) => original(...args))
  assert.equal(gearPartVisible(f.bot, f.raw, 4), false)
  assert.equal(ray.mock.callCount(), 18, 'unknown geometry still takes the exact conservative path')
})

test('strands reveal the opponent and their hands while the crosshair still picks the web', () => {
  const f = scene()
  f.wall([0, 0, 0, 1, 1, 1], 'cobweb')
  f.raw.equipment = [{ name: 'bow' }]
  assert.equal(seesPlayer(f.bot, f.raw), true)
  assert.equal(observePlayerGear(f.bot, f.raw).equipment[0]?.name, 'bow')
  assert.equal(pick.canHit(f.bot, f.raw, { range: 5 }), false)
  assert.ok(pick.blockAim(f.bot, new Vec3(3, 1, 0), { range: 5, seeThrough: null }))
})

test('a swarm status records occlusion for 20 enemies with one direct sight query each', async t => {
  const f = scene(), { bot } = f
  const opponents = Array.from({ length: 20 }, (_, i) => ({ ...f.raw, id: i + 2, username: `Foe${i}`,
    position: f.raw.position.offset(i, 0, 0), equipment: [{ name: 'iron_sword' }] }))
  bot.entities = Object.fromEntries(opponents.map(e => [e.id, e]))
  bot.physics = {}
  const sight = createLastSeen(bot)
  const rpc = observationMethods({ session: { bot, immediate: read => read() }, cfg: {} } as any)
  const poll = () => rpc.status({ swarm: true, swarmAllies: [] })
  try {
    f.wall([0, 0, 0, 1, 1, 1], 'glass')
    const view = sight.observe(opponents[0])
    assert.equal(view.equipment[0].name, 'iron_sword')
    f.wall([0, 0, 0, 1, 1, 1])
    opponents[0].equipment[0] = { name: 'mace' }
    const ray = t.mock.method(pick, 'blockOnRay')
    assert.ok(opponents.every(e => !seesPlayer(bot, e)))
    const directRays = ray.mock.callCount()
    const { sightings } = await poll()
    const reportRays = ray.mock.callCount() - directRays
    assert.equal(sightings.length, opponents.length)
    assert.ok(sightings.every(s => s.nametag && !s.visible && !s.equipment.weapon))
    assert.equal(view._ndVisible, false)
    assert.equal(view.equipment[0].name, 'iron_sword')
    assert.equal(reportRays, directRays, 'the radio already witnessed occlusion in this synchronous query')
    f.wall([0, 0, 0, 1, 1, 1], 'glass')
    bot.emit('physicsTick')
    assert.equal(view._ndVisible, true)
    assert.equal(view.equipment[0].name, 'mace')
    assert.equal((await poll()).sightings[0].equipment.weapon, 'mace')
  } finally { bot.emit('end'); sight.close() }
})
