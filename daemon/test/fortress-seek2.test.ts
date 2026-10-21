import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
import { cjsContext } from './cjs-context'
import { Vec3 } from 'vec3'
import { RaycastIterator } from 'prismarine-world/src/iterators'
import { bodySource } from './source-fixture'

// ND_BLZ_SEEK2: ход по палубе — длинный отрезок по видимому кирпичному полу к подсказке, а не шаг в одну клетку.
function scene (hint) {
  const cells = new Map<string, string>()
  for (let x = -30; x <= 30; x++) for (let z = -2; z <= 2; z++) cells.set(`${x},63,${z}`, 'nether_bricks')
  const bot: any = { game: { dimension: 'the_nether' }, health: 20, food: 20, entities: {},
    entity: { position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62 }, inventory: { items: () => [] },
    blockAt: p => { const q = p.floored(), name = cells.get([q.x, q.y, q.z].join(',')) || 'air'
      const empty = name === 'air'
      return { name, position: q, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]], stateId: name }
    },
    findBlocks: () => [] }
  bot.world = { raycast: (from, direction, distance, match) => {
    const ray = new RaycastIterator(from, direction, distance)
    let p = from
    while (p) {
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
      if (match ? match(b, ray) : ray.intersect(b.shapes, b.position)) return b
      p = ray.next()
    }
    return null
  } }
  const file = path.resolve(__dirname, '../src/fortress.ts'), native = createRequire(file)
  const calls: any[] = []
  const context: any = { module: { exports: {} }, require: native, console: { log () {} },
    process: { env: { ND_BLZ_SEEK2: '1' } }, fixtureHint: hint,
    fixtureMove: top => { calls.push(top.clone()); bot.entity.position = top.offset(.5, 1, .5); return { ok: true } } }
  vm.runInNewContext(transformSync(bodySource(file), { loader: 'ts', format: 'cjs' }).code + `
    look = () => ({ seen: 1, seenList: [] });
    keepBlocks = async () => null;
    spawnerHint = () => fixtureHint;
    climbWalk = async (_s, _c, top) => fixtureMove(top);
    climbTo = legTo = async () => ({ ok: false, error: 'not in this test' });
  `, cjsContext(context))
  const session: any = { bot, mcData: {}, journal: { state: { places: {} } } }
  return { calls, bot, run: () => context.module.exports.tour(session, { aborted: false }, { deadline: Infinity, hops: 1, pie: true }) }
}

test('SEEK2: one long deck leg toward the F3 pie bearing', async () => {
  const f = scene({ x: 80, z: 0, by: 'пирог' })
  const r = await f.run()
  assert.equal(f.calls.length, 1)
  assert.ok(f.calls[0].x >= 15, `leg goes far along the deck toward the hint, got x=${f.calls[0].x}`)
  assert.equal(f.calls[0].y, 63, 'target is a deck floor block')
  assert.ok(r.hops[0].deckLong)
})

test('SEEK2: the other way when the hint is behind', async () => {
  const f = scene({ x: -80, z: 0, by: 'пирог' })
  await f.run()
  assert.ok(f.calls[0].x <= -15, `got x=${f.calls[0].x}`)
})
