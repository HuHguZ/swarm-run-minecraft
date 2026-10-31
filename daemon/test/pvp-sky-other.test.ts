// Таран другого летуна в бою со своей целью: защита, если свою цель сейчас не ударить раньше.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { skySenseTurn } from '../src/pvp/turn-air'

function frame(t, { targetAt = new Vec3(10, 64, 0), ready = true } = {}) {
  const threats = require('../src/threats')
  const glider = { id: 7, name: 'glider', kind: 'dive', ticks: 14, at: { x: 0, y: 64.5, z: -2 }, from: { x: 0, y: 66, z: -20 }, vel: { x: 0, y: -.1, z: 1.4 }, blockable: false }
  t.mock.method(threats, 'incomingGliders', () => [glider])
  const bot: any = { entity: { position: new Vec3(0, 64, 0), elytraFlying: false, height: 1.8, width: .6 }, blockAt: p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] }) }
  const ctx: any = { bot, prof: { player: true }, sky: { threat: () => null }, vision: { visible: () => true }, entity: { id: 2, position: targetAt },
    session: { _ndFoes: ['Flyer', 'Target'] }, nextReady: ready ? 0 : Infinity }
  const turn: any = { me: bot.entity.position }
  skySenseTurn(ctx, turn)
  return turn
}

test('чужой летун идёт на меня, а свою цель не ударить — защита от него', t => {
  const turn = frame(t)
  assert.equal(turn.skyThreat?.other?.id, 7)
  assert.equal(turn.skyThreat.eta, 14)
})

test('своя цель в досягаемости и удар готов — бью её, не отвлекаюсь', t => {
  assert.equal(frame(t, { targetAt: new Vec3(2, 64, 0) }).skyThreat, null)
})

test('своя цель рядом, но удар не готов — защита от летуна', t => {
  assert.equal(frame(t, { targetAt: new Vec3(2, 64, 0), ready: false }).skyThreat?.other?.id, 7)
})

// cl29a–e (28.10): на земле теперь чаще всего гибнут в бою — цель кружит на элитрах («жду посадки»), удар не достаёт, а копьё
// поднимается, только когда таран уже ближе задержки (11 т.), — поздно. Пока он кружит дальше удара — копьё на изготовку заранее.
import { skyDefenseTurn, braceReleaseTurn } from '../src/pvp/turn-air'
function duel(t, { gliding = true, r = 12 } = {}) {
  const uses: any[] = [], looks: any[] = []
  const bot: any = { entity: { position: new Vec3(0, 64, 0), elytraFlying: false, height: 1.8, width: .6, yaw: 0, pitch: 0 }, heldItem: { name: 'diamond_sword' },
    inventory: { items: () => [{ name: 'diamond_spear', count: 1 }] }, equip: async it => { bot.heldItem = { name: it.name } },
    look: async (y, p) => { looks.push([y, p]) }, activateItem: () => { uses.push('up'); bot.usingHeldItem = true }, deactivateItem: () => { uses.push('down'); bot.usingHeldItem = false },
    on() {}, once() {}, blockAt: p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] }) }
  const ctx: any = { bot, sky: { gliding: () => gliding, fl: { at: () => new Vec3(0, 70, -r), st: {} } }, entity: { id: 2, position: new Vec3(0, 70, -r) },
    pathTo() {}, set() {}, ready: () => true, rest() {}, st: {}, used: () => {}, sleep: async () => {}, heldName: () => bot.heldItem?.name, guard: null }
  const turn: any = { me: bot.entity.position, meInWeb: false, now: 1000, r, skyThreat: null }
  return { ctx, turn, uses, looks, bot }
}

test('цель кружит на элитрах дальше удара — копьё на изготовку заранее и держится', async t => {
  const f = duel(t)
  await skyDefenseTurn(f.ctx, f.turn)
  assert.deepEqual(f.uses, ['up']); assert.equal(f.ctx.bracing, true)
  braceReleaseTurn(f.ctx, f.turn)
  assert.equal(f.ctx.bracing, true, 'кружит — не опускать')
  f.ctx.sky.gliding = () => false
  braceReleaseTurn(f.ctx, f.turn)
  assert.equal(f.ctx.bracing, false, 'сел — опустить')
})

test('a prepared ground spear without an incoming ram still permits pursuit and flight selection', async t => {
  const f = duel(t)
  await skyDefenseTurn(f.ctx, f.turn)
  braceReleaseTurn(f.ctx, f.turn)
  assert.equal(f.ctx.bracing, true)
  assert.equal(await skyDefenseTurn(f.ctx, f.turn), undefined, 'holding a ready spear must not consume every subsequent turn')
  assert.deepEqual(f.uses, ['up'])
})

test('a prepared ground spear still owns the turn during an actual incoming ram', async t => {
  const f = duel(t)
  await skyDefenseTurn(f.ctx, f.turn)
  f.turn.skyThreat = { eta: 14, at: new Vec3(0, 65, -2) }
  braceReleaseTurn(f.ctx, f.turn)
  assert.equal(await skyDefenseTurn(f.ctx, f.turn), 'next')
  assert.equal(f.ctx.bracing, true)
  assert.deepEqual(f.uses, ['up'])
})

test('цель на земле — заранее копьё не поднимаю', async t => {
  const f = duel(t, { gliding: false })
  await skyDefenseTurn(f.ctx, f.turn)
  assert.deepEqual(f.uses, [])
})

for (const bracing of [false, true]) test(`airborne pilot keeps its flight turn instead of ${bracing ? 'retaining' : 'starting'} ground spear defense`, async t => {
  const f = duel(t)
  f.bot.entity.elytraFlying = true
  f.ctx.bracing = bracing
  f.bot.heldItem.name = 'diamond_spear'
  const keys: string[] = []
  f.ctx.set = key => keys.push(key)
  braceReleaseTurn(f.ctx, f.turn)
  assert.equal(await skyDefenseTurn(f.ctx, f.turn), undefined, 'the flight stage must still run')
  assert.equal(f.ctx.bracing, false)
  assert.deepEqual(keys, [], 'ground defense must not clear flight controls')
  assert.deepEqual(f.uses, bracing ? ['down'] : [])
})

// Kimi 29.10 (сверено): ранний подъём копья выключался при любом луке в рюкзаке — с луком в наборе у всех упора не было ни у кого.
// Теперь — ценой: выстрел есть (лук и стрелы, тело видно, баллистика решает) — стрелять; нет — копьё заранее.
test('лук в рюкзаке, а тела не видно — копьё заранее; выстрел есть — не поднимаю', async t => {
  const bow = (sees: boolean) => {
    const f = duel(t)
    f.bot.inventory.items = () => [{ name: 'diamond_spear', count: 1 }, { name: 'bow', count: 1 }, { name: 'arrow', count: 32 }]; f.bot.inventory.slots = []
    f.bot.entity.velocity = new Vec3(0, 0, 0); f.bot.entity.onGround = true
    f.ctx.rangedAllowed = () => true
    // Как в бою: skyDefenseTurn раньше noteSightTurn — turn.seesBody ещё не посчитан, видимость — из глаз (ctx.vision).
    f.ctx.vision = { visible: () => sees }
    return f
  }
  const hidden = bow(false)
  await skyDefenseTurn(hidden.ctx, hidden.turn)
  assert.deepEqual(hidden.uses, ['up'], 'не видно — копьё заранее')
  const open = bow(true)
  await skyDefenseTurn(open.ctx, open.turn)
  assert.deepEqual(open.uses, [], 'выстрел есть — стрелять, не стоять с копьём')
  // Видно, решение есть, но дуга упирается в стену (cl71: «на линии стрельбы блок» у стен колизея) — выстрела нет, копьё заранее.
  const walled = bow(true)
  walled.bot.world = { raycast: () => ({ position: new Vec3(0, 66, -3) }) }
  await skyDefenseTurn(walled.ctx, walled.turn)
  assert.deepEqual(walled.uses, ['up'], 'дуга закрыта — копьё заранее')
})
