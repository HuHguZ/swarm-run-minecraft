import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as gameClock from '../src/game-clock'
import * as utility from '../src/utility'
import { fightGraphTurn } from '../src/pvp/turn-graph'
import * as fightGraph from '../src/pvp/fight-graph'

const rod: any = require('../src/utility/rod')

test('удочка: угроза отдаёт руки защите, промахи по цели дорожают, ловушка подчиняется графу', async () => {
  const clock = gameClock.activate(new gameClock.GameClock({ manual: true, epoch: 1000 }))
  const bot: any = new EventEmitter()
  const item = { name: 'fishing_rod', count: 1 }
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 100, 0) }, health: 20,
    inventory: { items: () => [item] }, entities: {}, registry: { entitiesByName: {} },
    _client: new EventEmitter(),
    equip: async () => { bot.heldItem = item }, look: async () => {},
    blockAt: () => ({ name: 'air', boundingBox: 'empty' })
  })
  const foe: any = { id: 2, uuid: 'target-a', type: 'player', username: 'A', position: new Vec3(0, 103, -6), metadata: {} }
  let uses = 0
  bot.activateItem = () => { uses++ }
  const pump = setInterval(() => { clock.advanceTicks(1); bot.emit('physicsTick'); bot.emit('ndMovementSent') }, 1)
  const ctl = { aborted: false }
  const graphRod = async (blocking = false) => {
    const ctx: any = {
      GRAPH: false, bot, entity: foe, prof: { player: true }, st: {}, lastSwing: 0,
      ready: () => true, rest: () => {}, foe: { shieldOff: () => 0 }, fg: fightGraph,
      co: { observe: () => ({ dist: 9, los: true, me: { items: [item, { name: 'iron_sword' }], held: 'iron_sword', since: 20, armor: [], onGround: true }, foe: { player: true, blocking, hp: { lo: 20, hi: 20, mean: 20 }, armor: [], main: { name: 'iron_sword' } } }) }
    }
    await fightGraphTurn(ctx, { d: 9, dy: 3, hp: 20, now: clock.now() } as any)
    assert.equal(ctx.st.calcErr, undefined)
    return ctx.gp.plan.alts.find(a => a.kind === 'rod').dps
  }
  try {
    const blocked = await rod.rodPull(bot, ctl, foe, { maxMs: 0, threatFn: () => true })
    assert.equal(uses, 0, 'при известной угрозе даже не забрасываем')
    assert.equal(blocked.interrupted, true)
    assert.ok(Number.isFinite(await graphRod(true)), 'поднятый щит не превращает удочку в неизвестный графу приём')

    const prior = rod.rodChance(bot, foe)
    const beforeMiss = await graphRod()
    await rod.rodPull(bot, ctl, foe, { maxMs: 0 })
    assert.ok(rod.rodChance(bot, foe) < prior, 'завершённый промах уменьшает шанс по этой цели')
    assert.ok(await graphRod() < beforeMiss, 'граф уменьшает ценность удочки относительно других приёмов')
    assert.equal(rod.rodChance(bot, { ...foe, id: 3, uuid: 'target-b' }), prior, 'чужие промахи не переносятся')
    assert.equal(rod.rodChance(bot, { ...foe, id: 30 }), rod.rodChance(bot, foe), 'UUID переживает смену id')

    let threatened = false
    bot.activateItem = () => { uses++; threatened = true }
    const started = clock.now()
    const beforeInterrupt = uses
    const interrupted = await rod.rodPull(bot, ctl, foe, { threatFn: () => threatened })
    assert.equal(interrupted.interrupted, true, 'новая угроза прерывает ожидание поплавка')
    assert.equal(uses - beforeInterrupt, 1, 'на угрозе нет повторного use: исчезнувший поплавок иначе превратит подсечку в новый заброс')
    assert.ok(clock.now() - started < 150, 'нет ожидания полёта и паузы подсечки после угрозы')
    assert.equal(rod.rodChance(bot, foe), (prior * 5) / 7, 'время прерванного заброса тоже уменьшает эффективный шанс')

    bot.emit('entityHurt', bot.entity)
    const beforeHurt = uses
    await rod.rodPull(bot, ctl, foe, { maxMs: 0 })
    assert.equal(uses, beforeHurt, 'под недавним ударом удочку не достаём')

    clock.advanceTicks(11)
    const beforeSuccess = rod.rodChance(bot, foe)
    const beforeSuccessUses = uses
    bot.activateItem = () => {
      uses++
      bot._ndRodPull.mine = { id: 77 }
      bot.entities[77] = { id: 77, name: 'fishing_bobber', metadata: { 8: foe.id + 1 } }
    }
    assert.equal((await rod.rodPull(bot, ctl, foe)).hooked, true, 'в безопасном окне удочка остаётся доступна')
    assert.equal(uses - beforeSuccessUses, 2, 'в безопасном окне заброс и подсечка сохраняются')
    assert.ok(rod.rodChance(bot, foe) > beforeSuccess, 'успех восстанавливает оценку без запрета после N промахов')
    const util = utility.create(bot)
    try {
      const beforeGate = uses
      await util.step({ entity: foe, d: 6, dy: 3, hp: 20, sees: true, theyUp: true, ctl, allow: () => false })
      assert.equal(uses, beforeGate, 'сдёргивание со столба тоже сравнивается с альтернативами')
      await util.step({ entity: foe, d: 6, dy: 3, hp: 20, sees: true, theyUp: true, ctl, allow: () => true, threat: () => true })
      assert.equal(uses, beforeGate)
      assert.equal(util.stats.rod, 0, 'отказ до заброса не становится ложным промахом 0/1')
    } finally { util.close() }
    const counter = utility.create(bot)
    try {
      bot._ndRodPull.owners.set(88, foe.id)
      bot.entities[88] = { id: 88, name: 'fishing_bobber', metadata: { 8: bot.entity.id + 1 } }
      const beforeCounter = uses
      await counter.step({ entity: foe, d: 6, dy: 3, hp: 20, sees: true, theyUp: true, ctl, allow: () => false })
      assert.equal(uses, beforeCounter, 'ответ на чужую удочку тоже оплачивается и не обходит граф')
    } finally { counter.close() }
  } finally { clearInterval(pump); clock.dispose() }
})
