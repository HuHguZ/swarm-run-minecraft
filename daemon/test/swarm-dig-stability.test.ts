import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, pvpState } from '../src/swarm/board'
import { pvpDiggers } from '../src/swarm/plan-jobs'
import type { SwarmMember } from '../src/swarm/types'

const p = (x: number, z: number, y = 120) => ({ x, y, z })
const key = (q: any) => `${q.x},${q.y},${q.z}`
function scene() {
  let time = 10000
  const team: SwarmMember[] = Array.from({ length: 12 }, (_, i) => ({ id: `b${String(i).padStart(2, '0')}`, team: 'blue',
    position: i < 2 ? p(.5 + i * .1, .5) : p(.5 + Math.cos(i) * 3, .5 + Math.sin(i) * 3),
    health: 20, strength: 40, role: 'fighter', weapon: 'stone_sword', inventory: { stone_sword: 1, netherite_pickaxe: 1 } }))
  const sites = Array.from({ length: 25 }, (_, i) => {
    const x = (i % 5 - 2) * 2, z = (Math.floor(i / 5) - 2) * 2
    return { x, y: 119, z, feetY: 120, drop: Infinity, tier: 2, blocks: ['sandstone', 'obsidian'],
      stands: [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => p(x + .5 + dx, z + .5 + dz)) }
  })
  const foe = { id: 'Champ', position: p(.5, .5), seenAt: time, source: 'b00', sources: ['b00'], hpEstimate: 20,
    equipment: { weapon: 'diamond_sword', armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'], enchanted: true } }
  const board = new SwarmBoard('blue', () => time, 8000)
  const options = { digSites: () => [...sites] }
  const run = () => {
    board.setMembers(team); foe.seenAt = time
    const S: any = { board, team, enemies: [foe], plan: new Map(), aggressive: true, options, weak: () => false, state: pvpState(board) }
    pvpDiggers(S)
    for (const task of board.tasks()) board.cancel(task.id)
    for (const [id, d] of S.diggers) board.upsert({ id: `pvp:${id}`, kind: 'goto', assignedTo: id, position: d.site,
      data: { dig: key(d.site), target: foe.id, stands: d.site.stands, undermine: true } })
    return S.diggers as Map<string, { site: any }>
  }
  return { team, sites, foe, options, board, run, at: (at: number) => { time = at }, advance: () => { time += 250 } }
}

test('moving diggers keep their available cell and reserved stand instead of swapping neighbors', () => {
  const f = scene(), first = f.run()
  assert.ok(first.size >= 6)
  for (let step = 0; step < 8; step++) {
    for (const [id, d] of first) {
      const m = f.team.find(m => m.id === id)!, stand = d.site.stands[0]
      m.position = p(m.position.x + (stand.x - m.position.x) * .2, m.position.z + (stand.z - m.position.z) * .2)
    }
    f.advance()
    const next = f.run()
    for (const [id, d] of first) {
      assert.equal(key(next.get(id)?.site || {}), key(d.site), `${id}: retained useful dig cell at step ${step}`)
      assert.deepEqual(next.get(id)!.site.stands, d.site.stands, `${id}: retained assigned support at step ${step}`)
    }
  }
})

test('a removed dig site is released and failed work is not held forever', () => {
  const f = scene(), first = f.run(), [id, job] = first.entries().next().value!
  f.sites.splice(f.sites.findIndex(s => key(s) === key(job.site)), 1)
  f.advance()
  assert.notEqual(key(f.run().get(id)?.site || {}), key(job.site))
  f.advance()
  const current = f.run().get(id)
  assert.ok(current, 'removed site can be replaced with another available job')
  const attempt = pvpState(f.board).dislodgeWork!.get(`Champ:dig:${key(current.site)}`)!
  assert.ok(attempt.active)
  f.at(attempt.deadline + 1)
  assert.notEqual(key(f.run().get(id)?.site || {}), key(current.site), 'failure price still ends the old assignment')
})

test('a replacement job cannot take another digger\'s reserved cell or support', () => {
  const f = scene(), first = f.run(), [id, job] = first.entries().next().value!
  f.sites.splice(f.sites.findIndex(s => key(s) === key(job.site)), 1)
  const peer = [...first].find(([who]) => who !== id)![1]
  f.team.find(m => m.id === id)!.position = { ...peer.site.stands[0] }
  f.advance()
  const next = f.run()
  for (const [who, old] of first) if (who !== id) {
    assert.equal(key(next.get(who)?.site || {}), key(old.site), `${who}: cell remains reserved`)
    assert.deepEqual(next.get(who)!.site.stands, old.site.stands, `${who}: support remains reserved`)
  }
})

test('an approaching digger does not become a replacement guard merely by getting closer', () => {
  const f = scene(), first = f.run(), [id, job] = first.entries().next().value!
  f.team.find(m => m.id === id)!.position = p(.5, .5)
  f.advance()
  const next = f.run()
  assert.equal(key(next.get(id)?.site || {}), key(job.site))
  assert.deepEqual(next.get(id)!.site.stands, job.site.stands)
})

test('a confirmed cleared top is avoided as a support while its lower layer remains a dig candidate', () => {
  const f = scene()
  f.team.splice(3)
  f.team[0].position = p(.5, 1.5); f.team[1].position = p(.5, -.5)
  const cleared = p(0, 0, 119), unsafe = p(.5, .5), safe = p(3.5, .5)
  pvpState(f.board).dislodgeWork = new Map([['Champ:dig:0,119,0', { at: 10000, active: false, failed: false, work: 10,
    alternative: 100, deadline: 20000, penalty: 0, penaltyAt: 10000, dug: 1 }]])
  const neighbor = { ...f.sites[0], x: 2, z: 0, stands: [unsafe, safe] }
  f.sites.splice(0, f.sites.length, neighbor)
  f.board.setMembers(f.team)
  f.board.upsert({ id: 'pvp:b02', kind: 'goto', assignedTo: 'b02', position: neighbor,
    data: { dig: key(neighbor), target: 'Champ', stands: [unsafe], undermine: true } })
  const S: any = { board: f.board, team: f.team, enemies: [f.foe], plan: new Map(), aggressive: true,
    options: f.options, weak: () => false, state: pvpState(f.board) }
  pvpDiggers(S)
  assert.deepEqual(S.diggers.get('b02')?.site.stands, [safe], 'a removed upper block cannot support the neighboring worker')
  assert.ok(S.digAvoid.some(q => key(q) === key(cleared)), 'fighters avoid known partial holes even without a current worker there')
  f.sites.splice(0, f.sites.length, { ...neighbor, x: 0, stands: [p(-.5, .5)] })
  f.advance()
  const next = f.run().get('b02')
  assert.ok(next, 'the remaining obsidian is still available from another live support')
  assert.equal(key(next.site), key(cleared))
  assert.deepEqual(next.site.stands, [p(-.5, .5)])
})
