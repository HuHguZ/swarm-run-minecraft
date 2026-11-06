import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'
import { swarmRetry } from './swarm/swarm-driver/retry'

test('проигранный размен в контакте: на насест без хилки; выигранный — бой', async () => {
  for (const [hp, dy] of [[1, 0], [1, 4], [20, 0]]) {
    const calls: any[] = []
    const bot = { name: 'A', team: 'blue', c: { async call(method, params) {
      calls.push({ method, params })
      return { status: 'done', detail: { ok: true } }
    } } }
    const perch = { x: -18, y: 76, z: 0 }
    const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp,
      inv: { netherite_sword: 1, firework_rocket: 47 },
      armor: { head: 'netherite_helmet', torso: 'elytra', legs: 'netherite_leggings', feet: 'netherite_boots' } } }
    const arena = { x: 0, y: 64, z: 0, r: 100 }
    const driver = createSwarmDriver({ bots: [bot], pos, alive: () => true,
      aggressive: true, now: () => 1000, arena, perches: [perch],
      home: () => pos.A.p, hostile: () => true, log: () => {} })
    driver.observe(bot, [{ id: 'Foe', visible: true, position: { x: 2, y: 64 + dy, z: 0 },
      equipment: { weapon: 'wooden_sword', armor: [] } }])
    await driver.turn(bot)
    const flight = calls.find(c => c.method === 'fly_to')
    if (hp === 1) {
      assert.ok(flight, 'ракеты дают отрыв и в контакте, без предмета лечения')
      assert.deepEqual(flight.params.at, perch)
      assert.deepEqual(flight.params.arena, arena)
      assert.equal(calls.some(c => c.method === 'fight' || c.method === 'mine'), false)
    } else {
      assert.equal(flight, undefined, 'выигрывающий боец остаётся в бою')
      assert.ok(calls.some(c => c.method === 'fight'))
    }
  }
})

test('полное хп против сильного (выжить < убить, но не смертельно): бой, не насест', async () => {
  // Игра пользователя 23.10: «воздушный отход» с хп 20 против незерита и меча — бой бросали ради насеста за гребнем.
  const calls: any[] = []
  const bot = { name: 'A', team: 'blue', c: { async call(method, params) { calls.push({ method, params }); return { status: 'done', detail: { ok: true } } } } }
  const pos = { A: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { iron_sword: 1, firework_rocket: 47 },
    armor: { head: 'iron_helmet', torso: 'elytra', legs: 'iron_leggings', feet: 'iron_boots' } } }
  const arena = { x: 0, y: 64, z: 0, r: 100 }
  const driver = createSwarmDriver({ bots: [bot], pos, alive: () => true, aggressive: true, now: () => 1000, arena,
    perches: [{ x: -18, y: 76, z: 0 }], home: () => pos.A.p, hostile: () => true, log: () => {} })
  driver.observe(bot, [{ id: 'Foe', visible: true, position: { x: 2, y: 64, z: 0 },
    equipment: { weapon: 'netherite_sword', enchanted: true, armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'] } }])
  await driver.turn(bot)
  assert.equal(calls.find(c => c.method === 'fly_to'), undefined)
})

test('занятый насест закрывает только посадку, потолок над ботом — и следующий взлёт', async () => {
  for (const [why, flights] of [
    ['негде сесть у цели (под навесом или занято)', 2],
    ['над головой блок, неба в 10 бл. нет', 1]
  ] as const) {
    const calls: any[] = [], m = { p: { x: 0, y: 64, z: 0 }, inv: { elytra: 1, firework_rocket: 10 } }
    const b = { name: 'A', c: { async call(method, params) {
      calls.push({ method, params })
      return { status: 'done', detail: { ok: method === 'fly_to' && calls.filter(c => c.method === 'fly_to').length > 1, why } }
    } } }
    const sw: any = { now: () => 1000, generation: 1, alive: () => true, pos: { A: m },
      arena: { x: 0, y: 64, z: 0, r: 100 }, log() {}, detail: r => r.detail,
      rangedAdvantage: () => false }
    Object.assign(sw, swarmRetry(sw))
    const action = swarmTurnTasks(sw)
    for (const x of [20, -20]) await action.turnFlee({ b, round: 1, m, enemies: [], context: { members: [] },
      board: { recordFact() {} }, member: {}, task: { position: { x, y: 80, z: 0 }, data: { perch: true } } })
    assert.equal(calls.filter(c => c.method === 'fly_to').length, flights, why)
  }
})

test('преследователь у недоступного насеста: отрыв на элитрах до пешего отхода', async () => {
  const calls: any[] = [], m = { p: { x: 0, y: 64, z: 0 }, inv: { elytra: 1, firework_rocket: 10 } }
  const b = { name: 'A', c: { async call(method, params) {
    calls.push({ method, params })
    return { status: 'done', detail: calls.length === 1
      ? { ok: false, why: 'негде сесть у цели (под навесом или занято)' } : { ok: true } }
  } } }
  const sw: any = { now: () => 1000, generation: 1, alive: () => true, pos: { A: m },
    arena: { x: 0, y: 64, z: 0, r: 100 }, log() {}, detail: r => r.detail,
    bounded: p => p, rangedAdvantage: () => false }
  Object.assign(sw, swarmRetry(sw))
  await swarmTurnTasks(sw).turnFlee({ b, round: 1, m, context: { members: [] },
    enemies: [{ id: 'Foe', position: { x: 8, y: 64, z: 0 }, seenAt: 1000 }],
    board: { recordFact() {} }, member: {}, task: { position: { x: 20, y: 80, z: 0 }, data: { perch: true } } })
  assert.deepEqual(calls.map(c => c.method), ['fly_to', 'fly_to'])
  assert.deepEqual(calls[1].params.at, { x: -30, y: 64, z: 0 }, 'полёт прочь от преследователя')
})
