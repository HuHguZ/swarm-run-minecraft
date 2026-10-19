'use strict'
import { bodySource } from './source-fixture'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

function fixture ({ hidden = false, lava = false, placement = true }: any = {} as Record<string, any>) {
  const file = path.join(__dirname, '../src/actions.js')
  const realRequire = createRequire(file)
  const roof = new Vec3(0, 61, 0)
  const wall = new Vec3(1, 59, 0)
  const blocks = [wall, roof].map(position => ({ name: 'stone', position, type: 1 }))
  const moves = { dug: [], collections: 0, placed: [] }
  const bot = { entity: { position: new Vec3(0.5, 59, 0.5) },
    canDigBlock: () => true,
    blockAt: pos => ({ name: lava && pos.equals(roof.offset(0, 1, 0)) ? 'lava' : 'air' }),
    dig: async (b, forceLook) => { assert.equal(forceLook, true, 'взгляд перед копкой не ждёт плавного поворота'); moves.dug.push(b.position) } }
  const context = { module: { exports: {} as Record<string, any> }, console, Date, setTimeout, clearTimeout, moves,
    require: name => {
      const actual = realRequire(name)
      if (name === './items') return { ...actual, resolveBlockIds: () => [1], countItems: () => ({} as Record<string, any>), itemNamed: () => ({ name: 'cobblestone' }),
        missingHarvestTool: () => null, equipBestTool: async () => {} }
      if (name === './build') return { ...actual, placeBlockAt: async (_bot, pos, opts) => {
        moves.placed.push({ pos, opts }); return { ok: placement, reason: placement ? undefined : 'нет опоры' }
      } }
      if (name === './sight') return { ...actual, visibleOf: (_bot, _ids, _radius, opts) => {
        assert.equal(opts.fair, true)
        return blocks.filter(b => !(hidden && b.position.equals(roof)) && !opts.skip(b.position))
      } }
      return actual
    } }
  vm.runInNewContext(bodySource(process.env.ACTIONS_TEST_SOURCE || file) + `
    underFeet = () => [];
    collectNearbyDrops = async () => { moves.collections++; };
  `, cjsContext(context))
  const session = { bot, mcData: {} as Record<string, any>, cfg: { fairPlay: true } }
  const ctl = { aborted: false, onAbort: [] }
  return { moves, roof, mine: p => context.module.exports.mine(session, ctl, p),
    place: p => context.module.exports.place(session, ctl, p) }
}

test('точечная копка открывает названный потолок, сохраняя соседнюю стену и не гоняясь за дропом', async () => {
  const f = fixture()
  const r = await f.mine({ block: 'stone', at: { x: 0, y: 61, z: 0 }, count: 8, collect: false })
  assert.equal(r.dug, 1)
  assert.equal(f.moves.dug.length, 1)
  assert.ok(f.moves.dug[0].equals(f.roof))
  assert.equal(f.moves.collections, 0)
})

for (const hazard of ['hidden', 'lava']) {
  test(`точечная копка при ${hazard} не выбирает другой видимый камень вместо отказа`, async () => {
    const f = fixture({ [hazard]: true })
    await assert.rejects(f.mine({ block: 'stone', at: { x: 0, y: 61, z: 0 } }), /не вижу/)
    assert.equal(f.moves.dug.length, 0)
  })
}

test('обычная копка продолжает собирать дроп ближайшего видимого блока', async () => {
  const f = fixture()
  await f.mine({ block: 'stone' })
  assert.equal(f.moves.dug[0].x, 1)
  assert.equal(f.moves.collections, 1)
})

test('точечная постановка строит названную ступень из своего блока с проверкой видимой грани', async () => {
  const f = fixture()
  await f.place({ block: 'cobblestone', at: { x: 1, y: 60, z: 0 } })
  assert.equal(f.moves.placed.length, 1)
  assert.equal(f.moves.placed[0].pos.y, 60)
  assert.equal(f.moves.placed[0].opts.item, 'cobblestone')
  assert.equal(f.moves.placed[0].opts.honest, true)
})

test('отказ постановки точечной ступени не ищет случайное место рядом', async () => {
  const f = fixture({ placement: false })
  await assert.rejects(f.place({ block: 'cobblestone', at: { x: 1, y: 60, z: 0 } }), /нет опоры/)
  assert.equal(f.moves.placed.length, 1)
})
