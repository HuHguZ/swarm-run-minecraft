import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as co from '../src/pvp/combat-observe'
import { createHpEstimate } from '../src/pvp/hp-estimate'

function scene() {
  let time = 1000
  let visible = true
  const bot: any = new EventEmitter()
  bot._client = new EventEmitter()
  bot.entity = { id: 1, position: new Vec3(0, 0, 0), onGround: true }
  const player = (id = 7, username = 'Foe', uuid: string | null = 'foe-uuid') => {
    const metadata = []
    Object.defineProperty(metadata, 9, { get() { throw new Error('точное HP игрока запрещено') } })
    return { id, uuid, username, type: 'player', name: 'player', position: new Vec3(2, 0, 0), onGround: true, equipment: [], metadata }
  }
  const foe = player()
  const trackers: any[] = []
  const track = (entity = foe, roundScope: any = 'round-1', extra = {}) => {
    const t = co.trackFoe(bot, entity, { roundScope, now: () => time, visible: () => visible, ...extra })
    trackers.push(t)
    return t
  }
  const hit = (t, damage = { min: 5, max: 7, mean: 6, raw: 9 }) => {
    t.noteAttack(damage)
    bot._client.emit('damage_event', { entityId: t.entity.id, sourceTypeId: 0, sourceCauseId: 2, sourceDirectId: 2 })
  }
  return { bot, foe, player, track, hit, estimate: (target = 'Foe', roundScope = 'round-1') => co.readFoeEstimate(bot, { roundScope, target }),
    advance: (ms: number) => { time += ms }, hide: () => { visible = false },
    close: () => { for (const t of trackers) t.stop(); bot.emit('end') } }
}
const interval = t => { const h = t.hp.snapshot(); return [h.lo, h.hi] }

test('P8 observer: чтение чужого scope не создаёт память и не останавливает текущий tracker', () => {
  const f = scene()
  try {
    assert.equal(f.estimate(), null)
    assert.equal(f.bot.eventNames().length, 0)
    const a = f.track(); f.hit(a)
    assert.equal(f.estimate('Foe', 'another-round'), null)
    assert.equal(f.estimate('Other'), null)
    assert.equal(f.bot.listenerCount('physicsTick'), 1)
    f.advance(1000)
    const h = f.estimate('foe-uuid')
    assert.deepEqual([h.lo, h.hi], [13, 15], 'активный tracker стареет только в своём physicsTick')
    h.lo = 0; h.health.lo = 0
    assert.equal(f.estimate('foe').lo, 13, 'снимок не меняет общую память')
  } finally { f.close() }
})

test('P8 observer: повторные чтения idle памяти двигают один cursor, следующий Engage не стареет повторно', () => {
  const f = scene()
  try {
    const a = f.track(); f.hit(a); a.stop()
    f.advance(1000)
    assert.deepEqual([f.estimate().lo, f.estimate().hi], [13, 17])
    assert.deepEqual([f.estimate().lo, f.estimate().hi], [13, 17])
    f.advance(500)
    assert.equal(f.estimate().hi, 18)
    assert.equal(f.bot.listenerCount('physicsTick'), 0, 'observer не заводит tracker')
    assert.deepEqual(interval(f.track()), [13, 18])
    f.bot.emit('entityDead', f.foe)
    assert.equal(f.estimate(), null)
  } finally { f.close() }
})

test('P8: unseen aging расширяет интервал, не поднимая нижнюю границу даже от известного эффекта', () => {
  const h = createHpEstimate()
  h.hit({ min: 8, max: 10, mean: 9 })
  h.eat('golden_apple')
  const before = h.snapshot()
  h.tick(80, { visible: false })
  const after = h.snapshot()
  assert.equal(after.health.lo, before.health.lo)
  assert.ok(after.health.hi > before.health.hi)
  assert.ok(after.conf < before.conf)
  h.tick(5000, { visible: false })
  assert.equal(h.snapshot().health.lo, before.health.lo, 'долгое отсутствие не доказывает полное лечение')
  assert.equal(h.snapshot().regen, false)
  assert.equal(h.snapshot().absorption.hi, 0, 'срок известного поглощения истёк')
})

test('P8: Engage → Recover → Engage сохраняет подтверждённый урон и стареет по игровому времени', () => {
  const f = scene()
  try {
    const a = f.track(); f.hit(a)
    assert.deepEqual(interval(a), [13, 15])
    a.stop()
    f.advance(1000)
    const b = f.track({ ...f.foe })
    assert.deepEqual(interval(b), [13, 17])
    assert.equal(b.hp.snapshot().exact, false)
    b.stop()
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
    assert.equal(f.bot._client.listenerCount('damage_event'), 0)
  } finally { f.close() }
})

test('P8: скрытый противник во время боя тоже не получает доказанное лечение', () => {
  const f = scene()
  try {
    const t = f.track(); f.hit(t); f.hide()
    for (let i = 0; i < 40; i++) { f.advance(50); f.bot.emit('physicsTick') }
    assert.equal(t.hp.snapshot().lo, 13)
    assert.ok(t.hp.snapshot().hi > 15)
  } finally { f.close() }
})

test('P8: память сохраняет остаток эффектов и бюджет насыщения, а повторный stop не обнуляет возраст', () => {
  const f = scene()
  try {
    const a = f.track(); f.hit(a, { min: 14, max: 14, mean: 14, raw: 14 })
    a.hp.eat('golden_apple'); a.stop()
    f.advance(1000); a.stop() // повторная уборка не сдвигает момент последнего наблюдения
    f.advance(1000)
    const b = f.track(); const during = b.hp.snapshot()
    assert.equal(during.regen, true)
    assert.equal(during.absorption.hi, 4)
    assert.ok(during.satHp < 20 / 1.5)
    assert.equal(during.health.lo, 6)
    assert.equal(during.health.hi, 11.6, '2 секунды: +4 natural upper +1.6 известной regen')
    b.stop(); f.advance(3000)
    const c = f.track()
    assert.equal(c.hp.snapshot().regen, false, 'пять секунд эффекта не запускаются заново при Engage')
    assert.equal(c.hp.snapshot().absorption.hi, 4)
  } finally { f.close() }
})

test('P8: другой бот, цель и раунд изолированы; старый stop не возвращает прошлый раунд', () => {
  const f = scene(); const other = scene()
  try {
    const old = f.track(); f.hit(old); old.stop()
    assert.deepEqual(interval(other.track()), [20, 20], 'тот же UUID у другого бота — отдельное знание')
    assert.deepEqual(interval(f.track(f.player(8, 'Other', 'other-uuid'))), [20, 20])
    const resumed = f.track(); assert.deepEqual(interval(resumed), [13, 15]); resumed.stop()
    const next = f.track(f.foe, 'round-2'); assert.deepEqual(interval(next), [20, 20]); next.stop()
    old.stop()
    assert.deepEqual(interval(f.track()), [20, 20], 'возврат старого scope создаёт новое знание')
  } finally { f.close(); other.close() }
})

test('P8: username — запасной ключ; переиспользованный entity id не смешивает игроков', () => {
  const f = scene()
  try {
    const named = f.player(8, 'Named', null)
    const a = f.track(named); f.hit(a); a.stop()
    assert.deepEqual(interval(f.track({ ...named, username: 'named' })), [13, 15])
    assert.deepEqual(interval(f.track(f.player(8, 'SomeoneElse', null))), [20, 20])
  } finally { f.close() }
})

test('P8: смерть, spawn и end сбрасывают память своего бота без накопления слушателей', () => {
  for (const event of ['death', 'spawn', 'end']) {
    const f = scene()
    try {
      const a = f.track(); f.hit(a); a.stop()
      assert.deepEqual(interval(f.track()), [13, 15])
      f.bot.emit(event)
      a.stop()
      assert.deepEqual(interval(f.track()), [20, 20], event)
      assert.equal(f.bot.listenerCount('death'), 1)
      assert.equal(f.bot.listenerCount('spawn'), 1)
      assert.equal(f.bot.listenerCount('end'), 1)
    } finally { f.close() }
    assert.equal(f.bot.listenerCount('death'), 0)
    assert.equal(f.bot.listenerCount('spawn'), 0)
    assert.equal(f.bot.listenerCount('end'), 0)
    assert.equal(f.bot.listenerCount('entityDead'), 0)
  }
})

test('P8: смерть цели сбрасывает только её, а entityGone не объявляет смерть', () => {
  const f = scene()
  try {
    const a = f.track(); f.hit(a); a.stop()
    const second = f.player(8, 'Other', 'other-uuid')
    const b = f.track(second); f.hit(b); b.stop()
    f.bot.emit('entityGone', f.foe)
    const returned = f.track(); assert.deepEqual(interval(returned), [13, 15]); returned.stop()
    f.bot.emit('entityDead', f.foe)
    assert.deepEqual(interval(f.track()), [20, 20])
    assert.deepEqual(interval(f.track(second)), [13, 15])
  } finally { f.close() }
})

test('P8: без scope и для telemetry-трекера память не используется', () => {
  const f = scene()
  try {
    const a = f.track(); f.hit(a); a.stop()
    const unscoped = f.track(f.foe, null); assert.deepEqual(interval(unscoped), [20, 20]); unscoped.stop()
    const telemetry = f.track(f.foe, 'round-1', { honest: false })
    telemetry.hp.exact(1); telemetry.stop()
    assert.deepEqual(interval(f.track()), [13, 15], 'телеметрия не подменяет честное знание')
  } finally { f.close() }
})
