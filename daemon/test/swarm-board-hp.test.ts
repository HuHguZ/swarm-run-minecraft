import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../src/swarm/board'

const p = { x: 0, y: 64, z: 0 }
function scene() {
  let time = 1000
  const board = new SwarmBoard('blue', () => time, 8000)
  board.setMembers(['a', 'b', ...Array.from({ length: 15 }, (_, i) => `watch${i}`)].map(id => ({ id, team: 'blue', position: p, health: 20, strength: 20, role: 'fighter' as const })))
  return {
    board,
    at: (at: number) => { time = at },
    see: (source: string, hpEstimate?: number, proof?: any) => board.observe(source, time, { id: 'foe', position: p, visible: true, ...(hpEstimate !== undefined ? { hpEstimate } : {}), ...(proof ? { hitProof: proof } : {}) })
  }
}

test('a new observer with no damage knowledge preserves an aged wounded estimate', () => {
  const f = scene()
  f.see('a', 3)
  f.at(1100)
  f.see('b', 20)
  const enemy = f.board.enemies()[0]
  assert.ok(enemy.hpEstimate! > 3 && enemy.hpEstimate! < 6)
  assert.equal(enemy.seenAt, 1100, 'position still comes from the freshest sighting')
})

test('an unknown regeneration phase permits one food heal and one effect heal immediately', () => {
  const f = scene()
  f.see('a', 3)
  f.at(1050)
  f.see('b', 20)
  assert.ok(f.board.enemies()[0].hpEstimate! >= 5, 'native food/effect healing is discrete, not just a fractional slope')
})

test('visible healing invalidates a source model that missed it even after its sight refreshes', () => {
  const f = scene()
  f.see('a', 3)
  f.at(1100)
  f.see('b', 20, { healed: 0, hits: [], healing: { event: 1, ago: 0, absorption: 0 } })
  assert.equal(f.board.enemies()[0].hpEstimate, 20)
  f.at(1200)
  f.see('a', 3)
  assert.equal(f.board.enemies()[0].hpEstimate, 20, 'fresh timestamp cannot repair the missed heal')
  f.at(9200)
  f.see('a', 3)
  assert.equal(f.board.enemies()[0].hpEstimate, 20, 'healing knowledge survives expiration of its observer')
})

test('confirmed hits after a totem reduce the shared upper despite repeated heal observers', () => {
  const f = scene()
  f.see('a', 3)
  f.at(1100)
  f.see('b', 9, { healed: 0, hits: [], healing: { event: 1, ago: 0, absorption: 8 } })
  for (let i = 0; i < 15; i++) f.see(`watch${i}`, 9, { healed: 0, hits: [], healing: { event: 1, ago: 0, absorption: 8 } })
  const before = f.board.enemies()[0].hpEstimate!
  assert.ok(before >= 9)
  f.at(1150)
  f.see('a', .5, { healed: 0, hits: [
    { ago: 0, damage: 6, lowDamage: 6, minDamage: 6, healed: 0 },
    { ago: 0, damage: 6, lowDamage: 6, minDamage: 6, healed: 0 },
    { ago: 0, damage: 5, lowDamage: 5, minDamage: 5, healed: 0 },
    { ago: 0, damage: 6, lowDamage: 6, minDamage: 6, healed: 0 }
  ] })
  const after = f.board.enemies()[0].hpEstimate!
  assert.equal(after, 7, '28 EHP ceiling minus 23 minimum damage plus two unknown healing phases')
  for (let i = 0; i < 15; i++) f.see(`watch${i}`, 9, { healed: 0, hits: [], healing: { event: 1, ago: 50, absorption: 8 } })
  assert.equal(f.board.enemies()[0].hpEstimate, after, 'the same heal does not multiply its budget')
  assert.ok(after < before)
})

test('mean pressure damage without a minimum cannot lower the post-heal HP upper', () => {
  const f = scene()
  f.see('a', 3)
  f.see('b', 20, { healed: 0, hits: [{ ago: 0, damage: 17, lowDamage: 17, healed: 0 }], healing: { event: 1, ago: 0, absorption: 0 } })
  assert.equal(f.board.enemies()[0].hpEstimate, 20)
  assert.equal(f.board.enemies()[0].pressure!.damage, 17)
})

test('different status RTTs cannot move an old hit beyond a healing receipt', () => {
  const f = scene()
  f.see('a', 3)
  f.at(1100)
  f.board.observe('b', 1000, { id: 'foe', position: p, visible: true, hpEstimate: 20,
    hitProof: { healed: 0, hits: [], healing: { event: 77, ago: 0, absorption: 0 } } })
  const proof = { healed: 0, hits: [{ ago: 0, damage: 17, lowDamage: 17, minDamage: 17, healed: 0 }] }
  f.board.observe('a', 1050, { id: 'foe', position: p, visible: true, hpEstimate: 3, hitProof: proof })
  assert.equal(f.board.enemies()[0].hpEstimate, 20, 'the hit may have happened before the heal')
  f.at(1200)
  f.see('a', 3, proof)
  f.see('b', 20, { healed: 0, hits: [], healing: { event: 77, ago: 100, absorption: 0 } })
  assert.equal(f.board.enemies()[0].hpEstimate, 5, 'same heal receipt is deduplicated; subsequent damage restores focus')
})

test('simultaneous reports keep the lowest honest upper bound', () => {
  const f = scene()
  f.see('a', 12)
  f.see('b', 7)
  assert.equal(f.board.enemies()[0].hpEstimate, 7)
})

test('a sighting without HP preserves old knowledge with native regeneration uncertainty', () => {
  const f = scene()
  f.see('a', 3)
  f.at(2000)
  f.see('b')
  const enemy = f.board.enemies()[0]
  assert.ok(enemy.hpEstimate! > 3 && enemy.hpEstimate! < 10)
  assert.deepEqual(enemy.sources, ['a', 'b'], 'shared sight and damage proofs remain available')
})

test('HP remains unknown without any estimate or visible healing evidence', () => {
  const f = scene()
  f.see('a')
  f.at(1100)
  f.see('b')
  assert.equal('hpEstimate' in f.board.enemies()[0], false)
})
