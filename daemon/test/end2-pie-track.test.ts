// Поток end2 (sr27): «пирог» при нескольких спавнерах у крепости (ND_END2_PIE) — треки по дугам, данж и спавнер выше крепости мимо.
import test from 'node:test'
import assert from 'node:assert/strict'

const S = require('../src/perception/senses')
const D = require('../src/endportal-descent')
const P: typeof import('../src/endportal/pie-track') = require('../src/endportal/pie-track')

// Мир: данж (спавнер + сундук рядом) на 40,0 y 20; спавнер у поверхности 0,-45 y 75; комната портала −30,40 y −10.
const spawners = [{ x: 40, z: 0, y: 20 }, { x: 0, z: -45, y: 75 }, { x: -30, z: 40, y: -10 }]
const chests = [{ x: 41, z: 2 }]
function fakeBot (pos) {
  return { entity: { position: { ...pos, y: 64 } }, registry: { blocksByName: { mossy_cobblestone: { id: 1 } } }, findBlocks: () => [] }
}
function stub (bot) {
  const arcs = list => list.map(c => ({ center: Math.round(S.yawOf(c.x - bot.entity.position.x, c.z - bot.entity.position.z) / 2) * 2, all: false }))
  S.pieArcs = (_b, type) => arcs(type === 'spawner' ? spawners : chests)
  D.pieElevation = (_b, flat, o) => {
    const c = spawners.find(s => Math.abs(((S.yawOf(s.x - bot.entity.position.x, s.z - bot.entity.position.z) - o.yaw) % 360 + 540) % 360 - 180) <= 10)
    return c ? { y: c.y } : null
  }
}

test('end2 pie: три спавнера — три трека; данж (сундук на пеленге) и спавнер выше крепости мимо, оценка — комната', () => {
  const session: any = {}
  const store = P.pieStore(session, 'k')
  for (const p of [{ x: 0, z: 0 }, { x: 14, z: 6 }, { x: -12, z: 12 }, { x: 4, z: 22 }]) {
    const bot = fakeBot(p)
    stub(bot)
    P.pieObserve(bot, store, { minStep: 0 })
  }
  assert.equal(store.tracks.length, 3)
  const near = (x, z) => store.tracks.slice().sort((a, b) => Math.hypot(a.est.x - x, a.est.z - z) - Math.hypot(b.est.x - x, b.est.z - z))[0]
  assert.match(near(40, 0).dungeon || '', /данж/)
  assert.match(near(0, -45).notRoom || '', /выше крепости/)
  assert.equal(near(-30, 40).notRoom, undefined)
  const b = P.pieBest(fakeBot({ x: 4, z: 22 }), store, { x: 0, z: 0 })
  assert.ok(b.precise)
  assert.ok(Math.hypot(b.at.x + 30, b.at.z - 40) < 3, `оценка у комнаты: ${JSON.stringify(b.at)}`)
  assert.equal(b.y, -10)
})

test('end2 pie: под землёй спавнер шахты на y −45 ближе к лестнице, но комната на высоте коридоров (−18) — выбор комнаты', () => {
  const store: any = { key: 'k', n: 2, tracks: [
    { id: 1, samples: [{ x: 0, z: 0, yaw: 0, chest: false }], est: { x: 5, z: 30, spread: 0, uncertainty: 2 }, y: -45 },
    { id: 2, samples: [{ x: 0, z: 0, yaw: 0, chest: false }], est: { x: -40, z: 40, spread: 0, uncertainty: 2 }, y: -18 }] }
  const b = P.pieBest({ entity: { position: { x: 0, y: -12, z: 0 } } }, store, { x: 0, z: 0 })
  assert.equal(b.track, 2)
  const top = P.pieBest({ entity: { position: { x: 0, y: 70, z: 0 } } }, store, { x: 0, z: 0 })
  assert.equal(top.track, 1, 'с поверхности высоты коридоров не знаю — ближе к лестнице')
})
