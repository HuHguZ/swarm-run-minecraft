import test from 'node:test'
import assert from 'node:assert/strict'

// ne_burrow без колонны в толще (помост спавнера, мост крепости) — яма 3 с крышкой на месте (blaze.digInNear), а не отказ.
const stub = (rel: string, exports: Record<string, unknown>) => {
  const id = require.resolve(rel)
  require.cache[id] = { id, filename: id, loaded: true, exports } as any
}
let burrowResult: any = { ok: false, why: 'к колонне не дошёл' }
const pits: string[] = []
stub('../src/bastion/bastion', { burrow: async () => burrowResult })
stub('../src/blaze', { digInNear: async () => { pits.push('pit'); return { ok: true, sealed: true, depth: 3, at: { x: 1, y: 61, z: 2 } } } })
const covers: string[] = []
stub('../src/nether-cover', { blind: () => process.env.ND_NE_COVER !== '0', coverHere: async () => { covers.push('cover'); return { ok: true, how: 'проёмы вокруг закрыл' } } })
const { burrowIntent } = require('../src/bastion/burrow-intent')
// Прежний путь (колонна, яма) — при знании scan / ND_NE_COVER=0; вслепую — nether-cover.coverHere (тест ниже).
process.env.ND_NE_COVER = '0'
const session = { bot: { game: { dimension: 'the_nether' } } }

test('s1d: ne_burrow falls back to the capped blaze pit when no burrow column is reachable', async () => {
  const r = await burrowIntent(session, { aborted: false }, { why: 'стержни набраны' })
  assert.equal(r.ok, true)
  assert.equal(r.how, 'яма на месте')
  assert.equal(r.burrow, 'к колонне не дошёл')
  assert.equal(pits.length, 1)
})

test('s1d: a working burrow column keeps the old path (no pit)', async () => {
  burrowResult = { ok: true, how: 'колонна' }
  pits.length = 0
  const r = await burrowIntent(session, { aborted: false }, {})
  assert.equal(r.how, 'колонна')
  assert.equal(pits.length, 0)
})

test('вслепую: ne_burrow — по видимому (nether-cover.coverHere), без колонны по скрытым блокам', async () => {
  delete process.env.ND_NE_COVER
  pits.length = 0
  const r = await burrowIntent(session, { aborted: false }, {})
  process.env.ND_NE_COVER = '0'
  assert.equal(r.how, 'проёмы вокруг закрыл')
  assert.deepEqual(covers, ['cover'])
  assert.equal(pits.length, 0)
})
