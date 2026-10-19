'use strict'
// S7d (пункт G): учёт блоков в бою — один перехват _genericPlace/dig, приём по подсказке/стеку, успех по серверу,
// ошибки «не подтвердил сервер» и «своя опора».
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'node:events'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as gameClock from '../src/game-clock'

function fakeBot () {
  const bot: any = new EventEmitter()
  const world = new Map()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  bot.heldItem = { name: 'cobblestone' }
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  bot.blockAt = (p) => { const k = `${p.x},${p.y},${p.z}`; const n = world.get(k) || 'air'; return { name: n, boundingBox: n === 'air' ? 'empty' : 'block', position: p } }
  bot._genericPlace = async (ref, face) => { const c = ref.position.plus(face); world.set(`${c.x},${c.y},${c.z}`, bot.heldItem.name); bot.emit('blockUpdate', null, bot.blockAt(c)) }
  bot.dig = async (b) => { world.delete(`${b.position.x},${b.position.y},${b.position.z}`) }
  return { bot, world }
}

test('блоки в бою: поставил (подтверждено), сломал по подсказке, своя опора — ошибка', async () => {
  const bl: typeof import('../src/pvp/block-log') = require('../src/pvp/block-log')
  const { bot, world } = fakeBot()
  const log = bl.install(bot)
  await bot._genericPlace({ position: new Vec3(2, 64, 0) }, new Vec3(0, 1, 0))
  bot._ndBlockTag = { what: 'сломать опору под ним', at: gameClock.wall.now() }
  world.set('5,66,5', 'cobblestone')
  await bot.dig(bot.blockAt(new Vec3(5, 66, 5)))
  bot._ndBlockTag = null
  world.set('0,63,0', 'stone')
  await bot.dig(bot.blockAt(new Vec3(0, 63, 0))) // под своими ногами
  await new Promise(resolve => gameClock.setTimeout(resolve, 450))
  const r = log.report()
  const placed = Object.values<any>(r.place).reduce((s, e) => s + e.ok, 0)
  assert.equal(placed, 1, JSON.stringify(r))
  assert.equal(r.dig['сломать опору под ним'].ok, 1)
  assert.equal(r.errors.ownSupport, 1)
  log.close()
  assert.equal(typeof bot.dig, 'function')
})

test('приём по кадрам стека', () => {
  const bl: typeof import('../src/pvp/block-log') = require('../src/pvp/block-log')
  assert.equal(bl.tagOf('Error\n at x\n at wallToward (C:/x/cover.js:1:1)', 'cobblestone'), 'стенка от стрелка')
  assert.equal(bl.tagOf('Error\n at x\n at whatever (C:/x/crystal.js:1:1)', 'end_crystal'), 'кристалл')
  assert.equal(bl.tagOf('Error\n at x\n at guardFor (C:/x/crystal.js:1:1)', 'glowstone'), 'заслон от якоря (светокамень)')
})

test('клик по якорю: светокамень — заряд (состояние сменилось), иным — подрыв (клетка пуста), оба — успех', async () => {
  const bl: typeof import('../src/pvp/block-log') = require('../src/pvp/block-log')
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true }
  bot.registry = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
  const at = new Vec3(3, 64, 0)
  let anchor: any = { name: 'respawn_anchor', stateId: 100, boundingBox: 'block', position: at }
  bot.blockAt = (p) => (p.equals(at) ? anchor : { name: 'air', boundingBox: 'empty', position: p })
  bot._genericPlace = async (ref) => {
    const old = anchor
    anchor = bot.heldItem.name === 'glowstone' ? { ...old, stateId: old.stateId + 1 } : { name: 'air', stateId: 0, boundingBox: 'empty', position: at }
    bot.emit('blockUpdate', old, anchor)
  }
  bot.dig = async () => {}
  const log = bl.install(bot)
  bot.heldItem = { name: 'glowstone' }
  await bot._genericPlace(anchor, new Vec3(0, 1, 0))
  bot.heldItem = { name: 'diamond_sword' }
  await bot._genericPlace(anchor, new Vec3(0, 1, 0))
  await new Promise(resolve => gameClock.setTimeout(resolve, 450))
  const r = log.report()
  assert.deepEqual([r.place['заряд якоря'].ok, r.place['подрыв якоря'].ok], [1, 1], JSON.stringify(r))
  assert.equal(r.errors.notConfirmed, 0)
  log.close()
})

test('яма под обсидиановым потолком: быстрого выхода нет — выход копкой обсидиана (цена), а не «сидеть в яме»', () => {
  const edges: typeof import('../src/edges') = require('../src/edges')
  // Поле на y 100 (пол — клетки y 99), я в яме: ноги на 96 (пол ямы — y 95), над ямой — обсидиан на 99 везде.
  const solid = (x, y, z) => y === 99 || y <= 95
  const blockAt = (p) => {
    const s = solid(p.x, p.y, p.z)
    const name = !s ? 'air' : p.y === 99 ? 'obsidian' : 'stone'
    return { name, position: p, boundingBox: s ? 'block' : 'empty', diggable: true, hardness: s ? 50 : 0, digTime: () => (name === 'obsidian' ? 9400 : 750), canHarvest: () => true }
  }
  const bot: any = { entity: { position: new Vec3(0.5, 96, 0.5), onGround: true }, blockAt, inventory: { items: () => [] } }
  const him = { position: new Vec3(3.5, 100, 0.5), equipment: [] }
  const s = edges.findShaft(bot, him, { floorY: 100, radius: 6 })
  assert.ok(s, 'выход найден')
  assert.ok(s.digMs >= 9000, `копать обсидиан ${s.digMs} мс`)
})

test('копка самого pathfinder (кадры только из node_modules) — своя метка, не «прочее»', () => {
  const bl: typeof import('../src/pvp/block-log') = require('../src/pvp/block-log')
  assert.equal(bl.tagOf('Error\n at x\n at Pathfinder.monitor (C:/p/node_modules/mineflayer-pathfinder/index.js:1:1)', null), 'путь (копает pathfinder)')
})

test('подкоп опоры: намерение, незавершённая попытка и подтверждённый слом раздельны', async () => {
  const { bot, world } = fakeBot()
  const pos = new Vec3(0, 63, 0)
  world.set('0,63,0', 'stone')
  let finish
  bot.dig = async () => { await new Promise(resolve => { finish = resolve }); world.delete('0,63,0') }
  const log = (require('../src/pvp/block-log') as typeof import('../src/pvp/block-log')).install(bot)
  bot._ndBlockTag = { what: 'спуск по своей опоре', intent: 'perch-descent', cell: pos, at: gameClock.wall.now() }
  const work = bot.dig(bot.blockAt(pos))
  const during = log.report()
  assert.ok(during, 'pending dig must be reported before completion')
  assert.deepEqual(during.supportDig['perch-descent'], { n: 1, ok: 0, failed: 0, pending: 1, unconfirmed: 0, ms: null })
  assert.equal(during.dig['спуск по своей опоре'].pending, 1)
  finish(); await work
  const { ms, ...counts } = log.report().supportDig['perch-descent']
  assert.deepEqual(counts, { n: 1, ok: 1, failed: 0, pending: 0, unconfirmed: 0 })
  assert.ok(Number.isFinite(ms) && ms >= 0)
  assert.equal(during.supportDig['perch-descent'].pending, 1, 'report must be a snapshot')
  assert.equal(log.report().errors.ownSupport, 1, 'legacy field remains an attempt count')
  log.close()
})

test('отмена и неизвестная клетка после копки не считаются подтверждённым разбором опоры', async () => {
  for (const mode of ['abort', 'unloaded']) {
    const { bot, world } = fakeBot()
    world.set('0,63,0', 'stone')
    const block = bot.blockAt(new Vec3(0, 63, 0))
    bot.dig = async () => {
      if (mode === 'abort') throw new Error('Digging aborted')
      bot.blockAt = () => null
    }
    const log = (require('../src/pvp/block-log') as typeof import('../src/pvp/block-log')).install(bot)
    if (mode === 'abort') await assert.rejects(bot.dig(block), /aborted/)
    else await bot.dig(block)
    const report: any = log.report()
    assert.deepEqual(report.supportDig.unclassified, { n: 1, ok: 0, failed: mode === 'abort' ? 1 : 0, pending: 0, unconfirmed: mode === 'unloaded' ? 1 : 0, ms: null })
    assert.equal(Object.values<any>(report.dig)[0].ok, 0)
    log.close()
  }
})

test('метка намеренного спуска ограничена клеткой; копка в стороне не подкоп своей опоры', async () => {
  const { bot, world } = fakeBot()
  const log = (require('../src/pvp/block-log') as typeof import('../src/pvp/block-log')).install(bot)
  bot._ndBlockTag = { what: 'спуск по своей опоре', intent: 'perch-descent', cell: new Vec3(9, 63, 0), at: gameClock.wall.now() }
  world.set('0,63,0', 'stone'); world.set('1,63,0', 'stone')
  await bot.dig(bot.blockAt(new Vec3(0, 63, 0)))
  await bot.dig(bot.blockAt(new Vec3(1, 63, 0)))
  const report: any = log.report()
  assert.equal(report.supportDig.unclassified.n, 1)
  assert.equal(report.supportDig['perch-descent'], undefined)
  assert.equal(report.dig['спуск по своей опоре'], undefined)
  assert.equal(Object.values<any>(report.dig).reduce((n, row) => n + row.ok, 0), 2)
  log.close()
})
