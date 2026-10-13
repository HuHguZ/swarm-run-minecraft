import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const { Vec3 } = require('vec3')
const { transformSync } = require('esbuild')

function sourceModule(name: string, overrides: Record<string, any> = {}) {
  const file = path.resolve(__dirname, '../src', name + '.ts')
  const local = createRequire(file), module = { exports: {} as any }
  const dependencies = new Map(Object.entries(overrides).map(([id, value]) => [local.resolve(id), value]))
  const code = transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext(require('node:module').wrap(code), { filename: file })(module.exports,
    (id: string) => dependencies.get(local.resolve(id)) ?? local(id), module, file, path.dirname(file))
  return module.exports
}
const sealed = sourceModule('sealed')
const surface = sourceModule('survival/surface-body', { '../sealed': sealed })
const state = sourceModule('tactics/state')

function field({ wetFeet = false, pool = false, y = pool ? 60.5 : 60, boundary = 'stone' }: any = {}) {
  const bot: any = {
    version: '1.21.11', registry: require('minecraft-data')('1.21.11'), health: 10, food: 15,
    entity: { id: 1, position: new Vec3(.5, y, .5), onGround: !pool && Number.isInteger(y), isInWater: wetFeet || pool, height: 1.8, metadata: [0], effects: {} },
    game: { dimension: 'overworld' }, inventory: { slots: [], items: () => [] }, entities: {},
    getControlState: () => false,
    blockAt(p: any) {
      const q = p.floored(), own = q.x === 0 && q.z === 0 && [60, 61].includes(q.y)
      const name = pool ? q.y < 60 ? 'stone' : q.y <= 62 ? 'water' : 'air'
        : own ? q.y === 60 && wetFeet ? 'water' : 'air'
          : boundary === 'air' && q.x >= 1 && q.y === 60 && q.z === 0 ? 'air'
          : q.x === 1 && q.y === 60 && q.z === 0 ? boundary : 'stone'
      if (name === null) return null
      const solid = name === 'stone' || name === 'oak_slab'
      return { name, position: q, boundingBox: solid ? 'block' : 'empty',
        shapes: name === 'oak_slab' ? [[0, 0, 0, 1, .5, 1]] : solid ? [[0, 0, 0, 1, 1, 1]] : [], getProperties: () => ({}) }
    }
  }
  return { bot, mcData: bot.registry, autopilot: {}, bus: { emit() {} } }
}

for (const wetFeet of [false, true]) test(`closed ${wetFeet ? 'wet feet with dry head' : 'dry'} pocket remains usable`, () => {
  const { bot } = field({ wetFeet })
  const pocket = surface.pocketOf(bot, [])
  assert.equal(pocket?.size, 2)
  assert.equal(sealed.exposure(bot, new Set(pocket)).length, 0)
})

// CG23 logged pocket2/water=true and cover flips while bobbing, but did not record native surrounding cells.
test('open water body cells are not solid cover even when localAir returns two cells', () => {
  const { bot } = field({ pool: true })
  assert.equal(sealed.localAir(bot)?.size, 2, 'keep the mining helper unchanged')
  assert.ok(sealed.exposure(bot, new Set(sealed.localAir(bot))).length > 0)
  assert.equal(surface.pocketOf(bot, []), null)
  bot.entity.position.y = 61.5
  assert.equal(surface.pocketOf(bot, []), null, 'bobbing cannot toggle false cover on')
})

for (const boundary of ['water', 'lava', 'air', 'oak_slab', null]) test(`a ${boundary ?? 'unknown'} boundary does not close a safety pocket`, () => {
  const { bot } = field({ boundary })
  assert.equal(surface.pocketOf(bot, []), null)
})

function observe(session: any) {
  const bot = session.bot
  const foe = { id: 2, name: 'zombie', position: bot.entity.position.offset(4.4, 0, 0), isValid: true }
  bot.entities[2] = foe
  const flee = { DOCTRINE: { ghast: { range: 64 }, zombie: { radius: 1.45 } },
    hostilesAround: () => [{ e: foe, d: 4.4, doc: { radius: 1.45 } }] }
  const hold = sourceModule('survival/hold-out', { './surface-body': surface, '../flee': flee,
    '../fortify': { feetCell: (b: any) => sealed.bodyCells(b)[0], refugeCell: () => null, pickaxeOf: () => null } })
  const tactics = sourceModule('tactics/minecraft', { '../survival': hold, '../flee': flee,
    '../combat-safety': { inspect: () => ({ action: 'recover', threats: [{ id: 2, distance: 4.4, hit: 3 }] }) },
    '../ne-guard': { hot: () => null }, '../pick': { aim: () => ({ point: foe.position }) },
    '../autopilot': { creeperNeed: () => null }, '../threats': { incoming: () => [] } })
  const look = hold.refugeLook(session)
  const observed = tactics.observeTactics(session)
  assert.ok(observed, 'actual observer must run, not silently skip geometry')
  return { look, observed, choices: state.candidates(observed, 3) } // Replay the logged level-3 incident.
}

test('actual refugeLook and tactical cover/Hide consumer reject open water', () => {
  const { look, observed, choices } = observe(field({ pool: true }))
  assert.equal(look.water, true)
  assert.equal(look.pocket, 0)
  assert.equal(observed.inWater, true)
  assert.equal(observed.cover, false)
  assert.equal(choices.some((c: any) => c.id === 'Hide'), false)
})

for (const wetFeet of [false, true]) test(`actual critical cover/Hide consumer preserves physically closed ${wetFeet ? 'wet-feet' : 'dry'} cover`, () => {
  const { look, observed, choices } = observe(field({ wetFeet }))
  assert.equal(look.pocket, 2)
  assert.equal(observed.cover, true)
  assert.equal(observed.inWater, wetFeet)
  assert.equal(observed.shelter, wetFeet ? null : 'Hide', 'the existing water-first executor choice is a separate contract')
  assert.equal(choices.some((c: any) => c.id === 'Hide'), true)
})
