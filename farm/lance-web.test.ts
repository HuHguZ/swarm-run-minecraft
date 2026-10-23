import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'

test('one nearest ally receives web request only during a fresh allied lance on the same target', () => {
  const calls: any[] = [], now = Date.now()
  const bots: any[] = ['L', 'Near', 'Far'].map(name => ({ name, team: 'blue',
    last: { m: 'fight', pending: true, p: { target: 'Foe' } },
    c: { call: async (m, p) => { calls.push({ name, m, p }); return {} } } }))
  const pos: any = Object.fromEntries(bots.map((b, i) => [b.name, {
    p: { x: i ? i + 5 : 15, y: 64, z: 0 }, hp: 20, inv: { iron_sword: 1, cobweb: i ? 2 : 0 }, armor: {},
    gliding: i === 0, observedAt: now
  }]))
  pos.L.lance = { target: 'Foe', phase: 'таран: разбег' }
  const driver = createSwarmDriver({ bots, pos, now: () => now, alive: () => true,
    arena: { x: 0, y: 64, z: 0, r: 80 }, home: () => pos.Near.p,
    hostile: (_, id) => id === 'Foe', log: () => {} })
  const seen = { id: 'Foe', position: { x: 0, y: 64, z: 0 }, visible: true }
  const web = () => calls.filter(c => c.m === 'team_hint' && c.p.lanceWeb?.target)
  for (const b of bots) driver.observe(b, [seen], now)
  assert.deepEqual(web().map(c => c.name), ['Near'])
  driver.observe(bots[1], [], now)
  driver.observe(bots[2], [seen], now)
  assert.equal(web().at(-1).name, 'Far', 'hidden nearest ally cannot reserve the support')
  pos.L.lance.phase = 'таран: выход'
  driver.observe(bots[2], [seen], now)
  assert.ok(calls.some(c => c.name === 'Far' && c.p.lanceWeb === null))
  calls.length = 0
  pos.L.lance.phase = 'таран: заход'; pos.L.observedAt = now - 1001
  driver.observe(bots[1], [seen], now)
  assert.equal(web().length, 0)
  pos.L.observedAt = now; bots[0].team = 'red'
  driver.observe(bots[1], [seen], now)
  assert.equal(web().length, 0)
  bots[0].team = 'blue'; pos.L.lance.target = 'Other'
  driver.observe(bots[1], [seen], now)
  assert.equal(web().length, 0)
})
