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
