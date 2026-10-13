'use strict'
// movement.pathKeepAlive: пока поиск идёт, pathFromPlayer срезает узел, на котором стоит тело, и исполнитель
// pathfinder'а не засчитывает узлы — через 3.5 с «stuck» и поиск с нуля (рельеф пула, mv-spr-dbg4). Метка в точке тела
// в начале нового пути — только если тело сдвинулось на 0.8+ блока.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const { pathKeepAlive } = require('../src/movement')

const node = (x, y, z, extra: any = {} as Record<string, any>) => Object.assign(new Vec3(x, y, z), { toBreak: [], toPlace: [], parkour: false, remainingBlocks: 16 }, extra)

for (const event of ['end', 'death']) test(`gotoGoal settles ${event} even when game time is frozen`, async () => {
  const clock = require('../src/game-clock')
  const { gotoGoal } = require('../src/movement')
  const c = new clock.GameClock({ manual: true, epoch: 0 }); clock.activate(c)
  const bot: any = new EventEmitter()
  bot.pathfinder = { setGoal: () => {}, isMoving: () => true }
  try {
    const result = gotoGoal(bot, { isEnd: () => false }).then(() => 'resolved', e => e.name)
    bot.emit(event)
    assert.equal(await Promise.race([result, new Promise(resolve => setTimeout(() => resolve('pending'), 30))]), event === 'end' ? 'Disconnected' : 'Died')
    for (const event of ['end', 'death', 'path_update', 'goal_updated', 'physicsTick']) assert.equal(bot.listenerCount(event), 0)
  } finally { c.dispose() }
})

test('a bounded walk cancels its paused goal without taking hands from Emergency', async t => {
  const clock = require('../src/game-clock')
  const lock = require('../src/reflex-lock')
  const { travelXZ } = require('../src/movement')
  const before = process.env.ND_GOTO_WAIT; process.env.ND_GOTO_WAIT = '1'
  t.after(() => { if (before === undefined) delete process.env.ND_GOTO_WAIT; else process.env.ND_GOTO_WAIT = before })
  t.mock.method(clock, 'setTimeout', (fn, ms) => setTimeout(fn, Math.min(ms, 20)))
  t.mock.method(clock, 'clearTimeout', timer => clearTimeout(timer))
  const bot: any = new EventEmitter()
  bot.health = 20; bot.entity = { position: new Vec3(.5, 64, .5), onGround: true }
  bot.blockAt = () => ({ name: 'air' }); bot.clearControlStates = () => {}
  let goals = 0
  bot.pathfinder = { isMoving: () => true, setGoal (g) { if (g) goals++; bot.emit('goal_updated', g) } }
  const session = { bot }; const ctl = { aborted: false, onAbort: [] }
  lock.install(session)
  const move = lock.run(session, ctl, () => travelXZ(bot, ctl, 16, 0, { retries: 0, deadline: clock.now() + 2000 }))
  let release
  setImmediate(() => lock.start(session, () => new Promise(resolve => { release = resolve }), { owner: 'Emergency' }))
  const r = await move
  assert.equal(r.outOfTime, true)
  assert.equal(lock.owner(session).owner, 'Emergency')
  assert.equal(goals, 1)
  release(); await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(goals, 1, 'a completed caller must not restart its old goal after Emergency')
  for (const event of ['end', 'death', 'goal_reached', 'path_update', 'goal_updated', 'path_stop', 'physicsTick', 'path_reset']) assert.equal(bot.listenerCount(event), 0, event)
})

test('bounded Nether walks keep empty partial searches, timeout prefixes and the goal after a reflex', async t => {
  const { travelXZ } = require('../src/movement')
  const fortress = require('../src/fortress')
  const nether = require('../src/nether')
  const blaze = require('../src/blaze')
  const clock = require('../src/game-clock')
  const rawGoto = require('mineflayer-pathfinder/lib/goto')
  t.mock.method(clock, 'snapshot', () => null)
  t.mock.method(nether, 'bore', async () => { assert.fail('a live search must not fall back to boring') })
  const before = process.env.ND_GOTO_WAIT
  process.env.ND_GOTO_WAIT = '1'
  t.after(() => { if (before === undefined) delete process.env.ND_GOTO_WAIT; else process.env.ND_GOTO_WAIT = before })
  const ctl = () => ({ aborted: false, onAbort: [] })
  const walks = [
    { name: 'travelXZ', y: 64, run: bot => travelXZ(bot, ctl(), 16, 0, { retries: 0 }) },
    { name: 'fortress ascent', y: 32, run: bot => fortress.walkLeg(bot, ctl(), 16, 0, clock.now() + 15000), arrived: r => assert.equal(r.up, 12) },
    { name: 'fortress descent', y: 96, run: bot => fortress.walkLeg(bot, ctl(), 16, 0, clock.now() + 15000), arrived: r => assert.equal(r.down, 12) },
    { name: 'climbTo', y: 64, run: bot => fortress.climbTo({ bot }, ctl(), { x: 16, y: 83, z: 0 }, clock.now() + 40000) },
    { name: 'portal final leg', y: 64, run: bot => nether.walkToward({ bot }, ctl(), { x: 16, y: 64, z: 0 }, clock.now() + 40000) },
    { name: 'blaze refuge exit', y: 64, run: bot => blaze.walkNear(bot, ctl(), new Vec3(16, 64, 0), 0, 5000) }
  ]
  for (const walk of walks) for (const status of ['partial', 'timeout', 'reflex']) {
    const bot = new EventEmitter()
    bot.entity = { position: new Vec3(.5, walk.y, .5), onGround: true }
    bot.blockAt = () => ({ name: 'air' })
    let timer
    let moving = false
    let calls = 0
    bot.pathfinder = {
      thinkTimeout: 5000,
      isMoving: () => moving,
      goto: goal => rawGoto(bot, goal),
      setGoal(goal) {
        if (!goal) { clearTimeout(timer); return }
        calls++
        moving = true
        bot.emit('path_update', { status: status === 'reflex' ? 'partial' : status, path: status === 'partial' ? [] : [node(16.5, goal.y ?? walk.y, .5)] })
        timer = setTimeout(() => {
          if (status === 'reflex' && calls === 1) {
            let resume
            bot._ndReflexTake = { after: fn => { resume = fn } }
            bot.emit('goal_updated', null)
            assert.equal(typeof resume, 'function', 'the reflex keeps a continuation for the same goal')
            delete bot._ndReflexTake
            resume()
            return
          }
          bot.entity.position = new Vec3(16.5, goal.y ?? walk.y, .5)
          moving = false
          if (status !== 'timeout') bot.emit('goal_reached')
          else bot.emit('physicsTick')
        }, 20)
      }
    }
    try {
      const result = await walk.run(bot)
      assert.equal(result.ok, true, `${walk.name}: ${status}`)
      if (walk.arrived) walk.arrived(result)
      assert.equal(bot.entity.position.x, 16.5)
      for (const event of ['path_update', 'goal_updated', 'physicsTick', 'entityHurt']) assert.equal(bot.listenerCount(event), 0)
      assert.equal(bot.pathfinder.thinkTimeout, 5000, 'climbing restores the caller search budget')
      assert.equal(calls, status === 'reflex' ? 2 : 1)
    } finally { clearTimeout(timer) }
  }
})

test('a consumed partial prefix waits for its search instead of following a stale branch', async () => {
  const { gotoGoal } = require('../src/movement')
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(.5, 64, .5) }
  const start = { data: node(0, 64, 0), parent: null }
  const context = { bestNode: { data: node(1.5, 64, .5), parent: start } }
  let path = []; let goals = 0
  bot.pathfinder = { isMoving: () => path.length > 0, setGoal: () => { goals++ } }
  const walk = gotoGoal(bot, { isEnd: () => false }); walk.catch(() => {})
  const first = { status: 'partial', context, path: [context.bestNode.data] }
  bot.emit('path_update', first); path = first.path
  path.shift(); bot.entity.position = new Vec3(1.5, 64, .5)
  const next = { status: 'partial', context, path: [node(.5, 64, 2.5)] }
  bot.emit('path_update', next)
  assert.equal(next.path.length, 0, 'the old search root cannot supply a directly reachable branch from the new body position')
  bot.emit('physicsTick')
  assert.equal(goals, 1, 'the unfinished search remains rooted at its original start until a terminal result')
  walk.cancel(); await assert.rejects(walk, { name: 'PathStopped' })
})

test('a final search branch resumes from the consumed prefix, but never after disconnect', async () => {
  const { gotoGoal } = require('../src/movement')
  for (const disconnect of [false, true]) {
    const bot: any = new EventEmitter()
    bot.entity = { position: new Vec3(.5, 64, .5) }
    const start = { data: node(0, 64, 0), parent: null }
    const first = { data: node(1.5, 64, .5), parent: start }
    const context = { bestNode: first }
    let path = []; let goals = 0
    bot.pathfinder = { isMoving: () => path.length > 0, setGoal: () => { goals++ } }
    // A native frame can end the connection before gotoGoal's tick listener.
    if (disconnect) bot.on('physicsTick', () => bot.emit('end'))
    const goal = { isEnd: () => false }
    const result = gotoGoal(bot, goal).then(() => 'arrived', e => e.name)
    const partial = { status: 'partial', context, path: [first.data] }
    bot.emit('path_update', partial); path = partial.path
    const final = { status: 'success', context, path: [node(2.5, 64, 1.5)] }
    const publication = final.path
    bot.emit('path_update', final)
    assert.equal(final.path, publication, 'earlier consumers keep the actual published array')
    assert.deepEqual(final.path, path, 'finish the active prefix nodes before switching to a different final branch')
    // Native adopts each emitted result after the listeners have selected its prefix.
    path = final.path
    path.shift(); bot.entity.position = new Vec3(1.5, 64, .5)
    bot.emit('physicsTick')
    assert.equal(goals, disconnect ? 1 : 2, 'only a live walk may replan after its prefix')
    if (!disconnect) bot.emit('death')
    assert.equal(await result, disconnect ? 'Disconnected' : 'Died')
    for (const event of ['path_update', 'goal_updated', 'goal_reached', 'path_reset']) assert.equal(bot.listenerCount(event), 0)
  }
})

test('метка пути: тело бежит — узел-метка в начале нового пути; стоит — нет; копка — нет', (t) => {
  const was = process.env.ND_PATH_KEEPALIVE
  process.env.ND_PATH_KEEPALIVE = '1'
  t.after(() => { if (was === undefined) delete process.env.ND_PATH_KEEPALIVE; else process.env.ND_PATH_KEEPALIVE = was })
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(10.5, 64, 0.5) }
  const k = pathKeepAlive(bot)
  const upd = (path) => { const r = { status: 'partial', path }; bot.emit('path_update', r); return r.path }
  // Первый путь — только запомнить, где тело.
  let p = upd([node(9.5, 64, 0.5), node(8.5, 64, 0.5)])
  assert.equal(p.length, 2)
  // Пробежало 1.2 блока: узел 9.5 срезан pathFromPlayer, впереди 8.5 — метка в точке тела.
  bot.entity.position = new Vec3(9.3, 64, 0.5)
  p = upd([node(8.5, 64, 0.5), node(7.5, 64, 0.5)])
  assert.equal(p.length, 3)
  assert.ok(p[0].ndKeep, 'метка первая')
  assert.equal(p[0].x, 9.3)
  assert.equal(p[0].y, 64)
  assert.deepEqual(p[0].toBreak, [])
  assert.equal(typeof p[0].distanceSquared, 'function', 'метка — Vec3 (pathFromPlayer зовёт distanceSquared)')
  // Стоит на месте (упёрлось) — метки нет: честный «stuck» остаётся.
  bot.entity.position = new Vec3(9.2, 64, 0.5)
  p = upd([node(8.5, 64, 0.5)])
  assert.equal(p.length, 1)
  // Дальше, но впереди копка — порядок исполнителя не трогаем.
  bot.entity.position = new Vec3(8.2, 64, 0.5)
  p = upd([node(7.5, 64, 0.5, { toBreak: [{ x: 7, y: 64, z: 0 }] })])
  assert.equal(p.length, 1)
  // Сброс пути — метка забыта, новый отсчёт.
  bot.emit('path_reset', 'stuck')
  bot.entity.position = new Vec3(6.0, 64, 0.5)
  p = upd([node(5.5, 64, 0.5)])
  assert.equal(p.length, 1)
  assert.equal(k.stats.marks, 1)
  k.stop()
  assert.equal(bot.listenerCount('path_update'), 0)
})

// gotoGoal: A* не уложился в 5 с ('timeout'), но лучший путь есть — идти по нему до конца (pathfinder в конце встаёт сам,
// без нового поиска), а не отказывать «Took to long» (goto.js): session.goto повторит из нового места.
test('gotoGoal: таймаут поиска с путём — идёт до конца пути и отдаёт «дошёл» (флаг), без флага — отказ', async (t) => {
  const { gotoGoal } = require('../src/movement')
  const was = process.env.ND_GOTO_TIMEOUT_WALK
  t.after(() => { if (was === undefined) delete process.env.ND_GOTO_TIMEOUT_WALK; else process.env.ND_GOTO_TIMEOUT_WALK = was })
  const mk = () => {
    const bot = new EventEmitter()
    let left = 0
    bot.pathfinder = {
      isMoving: () => left > 0,
      setGoal (g) {
        if (!g) return
        setImmediate(() => {
          bot.emit('path_update', { status: 'partial', path: [node(1, 64, 0)] })
          left = 5
          bot.emit('path_update', { status: 'timeout', path: [node(1, 64, 0), node(2, 64, 0)] })
          const tick = () => { bot.emit('physicsTick'); if (left > 0) { left--; setImmediate(tick) } else bot.emit('physicsTick') }
          setImmediate(tick)
        })
      }
    }
    return bot
  }
  process.env.ND_GOTO_TIMEOUT_WALK = '1'
  const b1 = mk()
  await gotoGoal(b1, { isEnd: () => false })
  assert.equal(b1.pathfinder.isMoving(), false, 'дошёл до конца лучшего пути')
  assert.equal(b1.listenerCount('physicsTick'), 0)
  process.env.ND_GOTO_TIMEOUT_WALK = '0'
  await assert.rejects(gotoGoal(mk(), { isEnd: () => false }), /Took to long/)
})
