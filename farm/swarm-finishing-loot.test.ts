import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard } from '../daemon/src/swarm/board'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmLoot } from './swarm/swarm-driver/loot'

process.env.ARMS_CACHE_MEMORY = '0'
process.env.ARMS_CACHE_SEARCH = '0'

function fixture({ finishing = true, hunt = false, cache = false } = {}) {
  const calls: any[] = [], now = () => 1000, arena = { x: 0, y: 64, z: 0, r: 100, killY: 60 }
  const member: any = { id: 'A', team: 'blue', position: { x: .5, y: 64, z: .5 }, health: 20, strength: 40, role: 'fighter' }
  const board = new SwarmBoard('blue', now)
  board.setMembers([member])
  board.observe('A', now(), { id: 'Enemy', visible: true, position: { x: 20.5, y: 64, z: .5 } })
  const task: any = { kind: hunt ? 'goto' : 'fight', position: { x: 20.5, y: 64, z: .5 },
    data: { target: 'Enemy', committed: true, ...(finishing ? { finishing: true } : {}), ...(hunt ? { hunt: true, search: true } : {}) } }
  const pos = { A: { p: member.position, hp: 20, inv: { iron_sword: 1 }, armor: { torso: 'iron_chestplate' } } }
  let pickups = 0
  const b: any = { name: 'A', team: 'blue', c: { async call(method, params) {
    calls.push({ method, params })
    if (method === 'assist') return { detail: { ok: pickups++ === 0 } }
    return { detail: {} }
  } } }
  const sw: any = { generation: 1, now, arena, pos, bots: [b], arms: true, alive: () => true, log() {}, say() {},
    boardOf: () => board, teamOf: () => 'blue', detail: r => r?.detail || r, home: () => member.position,
    refresh: () => ({ board, member, members: [member], task }), onslaught: () => false,
    hideouts: [], chestTops: [], toured: new Map(), cooldown: new Map(), tourBad: new Map(), emptyChests: new Set(),
    knownChests: new Map(cache ? [] : [['chest:1,64,0', { x: 1, y: 64, z: 0 }]]), fullFor: new Map(), blockedRoutes: new Map(),
    lootThreat: () => ({ r: 14, foes: board.enemies() }), weakLoot: () => false, lootArena: () => arena,
    drops: () => [{ p: { x: -20, y: 64, z: .5 }, at: 1 }], blocked: () => false, failed() {}, renew: () => true,
    async go(_b, at, range, timeoutSeconds, _arena, loot) {
      calls.push({ method: 'go', params: { at, range, timeoutSeconds, loot } }); pos.A.p = at
      return { status: 'done', detail: { arrived: true } }
    },
    transfer: async () => false, positionStep: async () => false, buildStep: async () => false,
    turnFight: async () => { calls.push({ method: 'fight' }) }, turnGoto: async () => { calls.push({ method: 'hunt' }) }
  }
  Object.assign(sw, swarmLoot(sw))
  // The cache boundary is injected; the turn must not ask it to begin a job
  // during finishing. Cache selection/digging has its own existing tests.
  sw.cacheTurn = async () => { if (cache) calls.push({ method: 'cache' }); return cache }
  return { calls, run: () => swarmTurn(sw).turn(b) }
}

for (const hunt of [false, true]) test(`finishing ${hunt ? 'hunt' : 'fight'} reaches its task before opportunistic distant loot`, async () => {
  const f = fixture({ hunt })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), [hunt ? 'hunt' : 'fight'])
})

test('finishing fight does not enter the cache opportunity', async () => {
  const f = fixture({ cache: true })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['fight'])
})

test('ordinary hunt retains quick-loot access including the existing distant-pile policy', async () => {
  const f = fixture({ finishing: false, hunt: true })
  await f.run()
  const walk = f.calls.find(c => c.method === 'go')
  assert.equal(walk?.params.at.x, -20)
  assert.equal(walk?.params.timeoutSeconds, 8)
  assert.ok(f.calls.some(c => c.method === 'assist'))
})

test('ordinary distant fight retains the cache opportunity', async () => {
  const f = fixture({ finishing: false, cache: true })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['cache'])
})
