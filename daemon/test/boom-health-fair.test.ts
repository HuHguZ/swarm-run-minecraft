import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'
import { create, judge } from '../src/boom'

function scene(identity: any = { username: 'Enemy' }, hp = 1) {
  let reads = 0
  const metadata: any = {}
  Object.defineProperty(metadata, 9, { get() { reads++; return hp } })
  const bot: any = { health: 20, registry: { entitiesByName: { player: { metadataKeys: [] }, zombie: { metadataKeys: [] } } },
    entity: { position: new Vec3(0, 64, 0) }, inventory: { slots: [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] }) }
  const foe = { name: 'player', position: new Vec3(2, 64, 0), metadata, equipment: [], ...identity }
  return { bot, foe, reads: () => reads, center: new Vec3(2, 64, 0) }
}

for (const identity of [{ username: 'Enemy' }, { type: 'player' }, { name: 'player' }]) {
  test(`explosive choice ignores private player HP (${Object.keys(identity)[0]})`, () => {
    const f = scene(identity), result = judge(f.bot, f.foe, f.center, 1)
    assert.equal(f.reads(), 0)
    assert.equal(result.hisHp, 20)
    assert.equal(result.kill, false)
  })
}

test('explosive choice accepts the existing duel estimate and retains native mob HP', () => {
  const f = scene(), seen: any[] = []
  const estimated = judge(f.bot, f.foe, f.center, 1, { foeHp: e => { seen.push(e); return 4 } })
  assert.equal(estimated.hisHp, 4)
  assert.equal(estimated.kill, true)
  assert.deepEqual(seen, [f.foe])
  assert.equal(f.reads(), 0)
  const mob = scene({ name: 'zombie' }, 8)
  assert.equal(judge(mob.bot, mob.foe, mob.center, 1).hisHp, 8)
  assert.equal(mob.reads(), 1)
})

test('the live explosive planner forwards the duel estimate without consuming telemetry HP', () => {
  const f = scene(), seen: any[] = []
  f.bot._client = new EventEmitter()
  f.bot.entities = { 2: { id: 2, name: 'end_crystal', position: f.center, isValid: true } }
  f.bot.inventory.items = () => [{ name: 'bow', count: 1 }, { name: 'arrow', count: 1 }]
  const fight = create(f.bot, { enemy: () => f.foe, foeHp: e => { seen.push(e); return 4 },
    telemetryHp() { throw Error('private telemetry must not enter planning') } })
  try { fight.plan(); assert.ok(seen.length > 0); assert.ok(seen.every(e => e === f.foe)); assert.equal(f.reads(), 0) }
  finally { fight.close() }
})

test('the duel estimate already includes absorption and no private player absorption is consulted', () => {
  const f = scene(); let reads = 0
  Object.defineProperty(f.foe.metadata, 17, { get() { reads++; return 4 } })
  assert.equal(judge(f.bot, f.foe, f.center, 1, { foeHp: () => 24 }).hisHp, 24)
  assert.equal(judge(f.bot, f.foe, f.center, 1).hisHp, 20)
  assert.equal(reads, 0)
})
