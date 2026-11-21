import assert from 'node:assert/strict'
import test from 'node:test'
import { createSwarmDriver } from './swarm/swarm-driver'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmPosition } from './swarm/swarm-driver/position'
import { drive, worldOf } from '../daemon/test/parkour-fixture'
import { executeJump, navigate } from '../daemon/src/navigation/parkour'

const home = { x: 600.5, y: 120, z: 600.5 }
const arena = { ...home, r: 20, killY: 113, ellipse: { a: 2, b: 2 } }
const landing = { x: 603.5, y: 121, z: 600.5 }

function gallery() {
  let time = 1000
  const pos = {}, calls: string[] = []
  const scouts = ['Front', 'Rear'].map((name, i) => {
    const { bot, world } = worldOf([[600,119,600,'stone'], [601,119,600,'stone'], [603,120,600,'stone']])
    bot.entity.position.set(i ? 600.65 : 601.4, 120, 600.5)
    drive(bot, world)
    const report = () => {
      pos[name] = { p: { ...bot.entity.position }, hp: 20, inv: { iron_sword: 1 }, armor: { torso: 'iron_chestplate' },
        hpAskedAt: time, frameAt: time, observedAt: time, watchRound: 1 }
    }
    report()
    const walk = async at => {
      const r = await executeJump(bot, { aborted: false }, at, { allowWalk: true, maxFallDamage: 0, arena })
      assert.equal(r.ok, true, r.why)
      report()
      return { status: 'done', detail: { arrived: { ...bot.entity.position } } }
    }
    return { name, team: 'blue', report, walk, c: { async call(method, params) {
      if (method === 'parkour') return { status: 'done', detail: await navigate(bot, { aborted: false }, params) }
      if (method === 'goto') { calls.push(name); return walk(params) }
      return { status: 'done', detail: {} }
    } } }
  })
  const driver = createSwarmDriver({ bots: scouts, pos, home: () => home, arena, now: () => time,
    alive: () => true, hostile: () => false, log() {} })
  const tick = (ms: number) => { time += ms }
  return { scouts, driver, pos, calls, tick }
}

test('the lead scout lands on the only ledge and the rear waits for its fresh report of leaving', async () => {
  const { scouts: [front, rear], driver, calls, pos, tick } = gallery()
  driver.observe(front, []); driver.observe(rear, [])
  await driver.turn(front)
  assert.deepEqual(calls, ['Front'])
  assert.ok(Math.hypot(pos[front.name].p.x - landing.x, pos[front.name].p.z - landing.z) < .5)
  assert.equal(pos[front.name].p.y, landing.y)
  await driver.turn(rear)
  assert.deepEqual(calls, ['Front'], 'the first scout has released its route but still occupies the landing')
  await front.walk({ x: 601.5, y: 120, z: 600.5 })
  tick(4000)
  front.report(); rear.report()
  await driver.turn(rear)
  assert.deepEqual(calls, ['Front', 'Rear'])
  assert.equal(pos[rear.name].p.y, landing.y)
  assert.ok(Math.hypot(pos[rear.name].p.x - landing.x, pos[rear.name].p.z - landing.z) < .5)
})

test('an old body frame, delayed reply, former round or different floor cannot hold a scout landing', async () => {
  for (const report of [{ frameAt: 0 }, { hpAskedAt: 0 }, { watchRound: 0 }, { p: { ...landing, y: landing.y + 3 } }]) {
    const { scouts: [front, rear], driver, pos, calls } = gallery()
    Object.assign(pos[front.name], { p: landing }, report)
    await driver.scout(rear)
    assert.deepEqual(calls, ['Rear'], JSON.stringify(report))
  }
})

test('an urgent escape can take the only observed landing even while its ally is still there', async () => {
  const { scouts, pos } = gallery(), [front, rear] = scouts
  await front.walk(landing)
  const sw = createDriverState({ bots: scouts, pos, arena, now: () => 1000, alive: () => true })
  const goals: Array<typeof landing> = []
  const { search } = swarmPosition({ ...sw, teamOf: b => b.team, detail: r => r.detail, async go(_b, at) {
    goals.push({ ...at })
    return { status: 'interrupted' }
  } })
  await search(rear, { members: scouts.map(b => ({ id: b.name })) }, [{ position: { ...home, x: home.x - 1 } }])
  assert.deepEqual(goals, [landing])
})
