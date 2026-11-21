import assert from 'node:assert/strict'
import test from 'node:test'
import { createSwarmDriver } from './swarm/swarm-driver'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmPosition } from './swarm/swarm-driver/position'

const center = { x: 0, y: 120, z: 0 }
const sector = at => [Math.round(at.x / 4), Math.floor(at.y / 2), Math.round(at.z / 4)].join(',')

async function lostContact(hiddenX: number) {
  const pos: Record<string, { p: typeof center; hp: number; inv: { iron_sword: number }; armor: { torso: string } }> = {}
  const goals: Array<typeof center> = []
  let time = 1000, finish
  const moving = new Promise(resolve => { finish = resolve })
  const bots = ['blue', 'red'].flatMap(team => Array.from({ length: 20 }, (_, i) => {
    const name = team + i
    pos[name] = { p: { x: (team === 'red' ? hiddenX : 0) + (i % 5 - 2) * .68, y: 120, z: (Math.floor(i / 5) - 1.5) * .68 },
      hp: 20, inv: { iron_sword: 1 }, armor: { torso: 'iron_chestplate' } }
    return { name, team, c: { async call(method, params) {
      if (method !== 'goto') return { status: 'done', detail: {} }
      goals.push({ x: params.x, y: params.y, z: params.z })
      return moving
    } } }
  }))
  const driver = createSwarmDriver({ bots, pos, now: () => time, alive: () => true,
    arena: { ...center, r: 64 }, home: () => center, hostile: (b, id) => id.startsWith(b.team === 'blue' ? 'red' : 'blue'), log() {} })
  driver.observe(bots[0], [{ id: 'red0', visible: true, position: { ...center, x: 35 } }])
  time += 181000
  const scouts = bots.filter(b => b.team === 'blue')
  for (const b of scouts) driver.observe(b, [{ id: 'red0', visible: false, position: pos.red0.p }])
  const turns = scouts.map(b => driver.turn(b))
  try {
    await new Promise(resolve => setImmediate(resolve))
    return [...goals]
  } finally { finish({ status: 'interrupted' }); await Promise.all(turns) }
}

test('twenty scouts losing contact sweep distinct sectors independently of unseen opponents', async () => {
  const first = await lostContact(50)
  assert.equal(first.length, 20, 'all twenty equipped scouts can sweep open ground')
  assert.equal(new Set(first.map(sector)).size, 20, 'a pending search already covers its sector')
  assert.deepEqual(await lostContact(-52), first, 'moving an unseen enemy gives the scouts no position')
})

test('scouts share the only observed step for retreat, or leave it to its scout until released', async () => {
  const step = { ...center, x: -4, y: 121 }, foe = { position: { ...center, x: 8 } }
  const bots = ['A', 'B', 'C'].map(name => ({ name, team: 'blue', c: {
    async call() { return { status: 'done', detail: { options: [{ target: step }] } } }
  } }))
  const pos = Object.fromEntries(bots.map(b => [b.name, { p: center, hp: 20 }]))
  let time = 1000
  const sw = createDriverState({ bots, pos, arena: { ...center, r: 20, ellipse: { a: 2, b: 2 } }, now: () => time, alive: () => true })
  const goals: string[] = []
  let release
  const pending = new Promise(resolve => { release = resolve })
  const search = swarmPosition({ ...sw, teamOf: b => b.team, detail: r => r.detail, go: async (b, at) => {
    assert.deepEqual(at, step)
    goals.push(b.name)
    return b.name === 'A' ? pending : { status: 'done', detail: { arrived: step } }
  } }).search
  const context = { members: bots.map(b => ({ id: b.name })) }
  const active = search(bots[0], context)
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(await search(bots[1], context), false)
    assert.equal(await search(bots[2], context, [foe]), true)
    assert.deepEqual(goals, ['A', 'C'])
  } finally { release({ status: 'interrupted' }); await active }
  time += 4000
  assert.equal(await search(bots[1], context), true)
  assert.deepEqual(goals, ['A', 'C', 'B'])
})
