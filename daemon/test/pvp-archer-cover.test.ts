import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { hazardCoverMethods } from '../src/rpc/hazards-cover'
import { farApproachTurn } from '../src/pvp/turn-approach'
const threats: typeof import('../src/threats') = require('../src/threats')
const flee: typeof import('../src/flee') = require('../src/flee')

function scene (t, column = true, columnZ = -1) {
  const bot: any = new EventEmitter(), controls: any = {}, commands = [], walked = []
  const foe: any = Object.assign(new EventEmitter(), { id: 2, username: 'Archer', type: 'player', isValid: true,
    position: new Vec3(.5, 0, -12.5), height: 1.8, width: .6, metadata: [], equipment: [{ name: 'bow' }], yaw: Math.PI })
  Object.assign(bot, { health: 20, food: 20, players: { Archer: { entity: foe } }, entities: { 2: foe },
    registry: { entitiesByName: {}, blocksByName: {} }, physics: { playerHeight: 1.8, playerHalfWidth: .3 },
    inventory: { slots: [], items: () => [] }, game: { minY: -64, height: 384 },
    entity: { id: 1, position: new Vec3(.5, 0, .5), height: 1.8, eyeHeight: 1.62, yaw: 0, onGround: true, effects: {}, metadata: [] },
    pathfinder: { setGoal: goal => commands.push(goal) }, canSeeBlock: () => true,
    lookAt: async () => {}, clearControlStates: () => { for (const k of Object.keys(controls)) controls[k] = false },
    setControlState: (key, value) => { controls[key] = value }, getControlState: key => !!controls[key],
    blockAt (p) {
      const at = p.floored(), solid = at.y < 0 || column && at.x === 2 && at.z === columnZ && at.y >= 0 && at.y <= 2
      return { name: solid ? 'stone' : 'air', position: at, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [] }
    } })
  const ctl: any = { aborted: false, onAbort: [] }
  let now = 1000
  const sleep = async () => {
    now += 50
    const x = Number(controls.right) - Number(controls.left), z = Number(controls.back) - Number(controls.forward), n = Math.hypot(x, z) || 1
    bot.entity.position = bot.entity.position.offset(x / n * .215, 0, z / n * .215)
    walked.push(bot.entity.position.clone())
  }
  const session: any = { require: () => bot, runIntent: async (_name, action) => action(ctl) }
  const methods = hazardCoverMethods({ session, state: {}, gameClock: { now: () => now, sleep } } as any)
  t.mock.method(threats, 'dangers', () => ({ aims: [{ name: 'Archer' }], arrows: [] }))
  t.mock.method(flee, 'smartFlee', async () => { throw new Error('локальное укрытие не должно превращаться в обычное бегство') })
  return { bot, foe, ctl, controls, commands, walked, methods, sleep }
}

test('Q10 take_cover идёт за видимую колонну внутри арены и без стройки', async t => {
  const f = scene(t)
  const result = await f.methods.take_cover({ from: 'Archer', localOnly: true, nearerThan: { x: 20, y: 0, z: 0 }, arena: { x: 0, y: 0, z: 0, r: 20 } })
  assert.equal(result.ok, true, JSON.stringify({ result, position: f.bot.entity.position }))
  assert.equal(result.how, 'укрытие')
  assert.ok(f.walked.length > 0)
  assert.ok(f.bot.entity.position.x > 2, 'укрытие находится за колонной, а не дальше по открытому месту')
  assert.ok(Object.values(f.controls).every(value => !value))
})

test('Q10 juke предпочитает колонну открытому зигзагу', async t => {
  const f = scene(t)
  const result: any = await f.methods.juke({ from: 'Archer', maxTicks: 80, retreat: true, jumpy: 0, arena: { x: 0, y: 0, z: 0, r: 20 } })
  assert.equal(result.how, 'укрытие')
  assert.ok(f.bot.entity.position.x > 2)
  assert.equal((await f.methods.take_cover({ from: 'Archer', localOnly: true })).ok, true, 'после джука скрытый стрелок остаётся последней видимой угрозой')
})

test('Q10 farApproachTurn при натянутом луке выбирает укрытие с 6 и 13 блоков, обычная цель сохраняет прямой бег', async t => {
  for (const [theyBow, d] of [[true, 13], [false, 13], [true, 6]] as const) {
    const f = scene(t, theyBow, -3)
    f.foe.position.z = .5 - d
    const ctx: any = { bot: f.bot, entity: f.foe, prof: { player: true, ranged: false },
      clear: () => f.bot.clearControlStates(), holdWeapon: async () => {}, leadFn: () => f.foe.position,
      pathTo: () => {}, pvpSkills: {}, ready: () => false, rest() {}, routeInputs: () => '',
      set: f.bot.setControlState, spearChargeFar: async () => false, strafeStep: () => {}, strafeKey: 'left', used() {},
      sleep: async () => {}, AR: { x: 0, y: 0, z: 0, r: 20 } }
    const result = await farApproachTurn(ctx, { d, hp: 20, r: {}, seesBody: true, theyBow } as any)
    assert.equal(result, 'next')
    if (theyBow) {
      assert.equal(f.controls.right, true, 'ближайшая колонна справа важнее старого стрейфа влево')
      assert.equal(f.controls.left, false)
    } else {
      assert.equal(f.controls.forward, true)
      assert.equal(!!f.controls.left || !!f.controls.right, false)
    }
  }
})

test('Q10 подход не возвращается к колонне позади: такое укрытие выгодно только при отходе', t => {
  const { archerCover }: typeof import('../src/pvp/archer-cover') = require('../src/pvp/archer-cover')
  const f = scene(t, true, 1), eye = f.foe.position.offset(0, 1.62, 0)
  const retreat = archerCover(f.bot, eye)
  assert.ok(retreat)
  assert.ok(retreat.at.distanceTo(eye) > f.bot.entity.position.distanceTo(eye), 'контроль: колонна действительно позади')
  assert.equal(archerCover(f.bot, eye, { advance: true }), null, 'повторный возврат к задней колонне не приближает к лучнику')
})

test('Q10 localOnly не выходит из арены, не бежит через яму и сравнивает путь с насестом', async t => {
  for (const kind of ['nearer', 'arena', 'gap', 'unknown', 'open']) {
    const f = scene(t, kind !== 'open'), original = f.bot.blockAt
    if (kind === 'gap' || kind === 'unknown') f.bot.blockAt = p => p.x >= 1 && p.x < 2
      ? kind === 'unknown' ? null : { name: 'air', boundingBox: 'empty', shapes: [], position: p.floored() } : original(p)
    const start = performance.now()
    const result = await f.methods.take_cover({ from: 'Archer', localOnly: true,
      nearerThan: kind === 'nearer' ? { x: 1, y: 0, z: .5 } : undefined,
      arena: { x: 0, y: 0, z: 0, r: kind === 'arena' ? 2 : 20 } })
    assert.equal(result.ok, false, kind)
    assert.equal(f.walked.length, 0, kind)
    if (kind === 'open') t.diagnostic(`Поиск без укрытия: ${(performance.now() - start).toFixed(1)} мс`)
  }
})

test('Q10 тело закрыто целиком: плечо мимо узкой формы и голова над ступенью остаются под огнём', t => {
  const { archerCovered }: typeof import('../src/pvp/archer-cover') = require('../src/pvp/archer-cover')
  const f = scene(t), eye = f.foe.position.offset(0, 1.62, 0), at = new Vec3(2.5, 0, .5)
  const stone = f.bot.blockAt
  assert.equal(archerCovered(f.bot, eye, at, { blockAt: stone } as any), true)
  for (const shape of [[.49, 0, 0, .51, 1, 1], [0, 0, 0, 1, .5, 1]]) {
    const world: any = { blockAt: p => { const b = stone(p); return b.boundingBox === 'block' && p.y >= 0 ? { ...b, shapes: [shape] } : b } }
    assert.equal(archerCovered(f.bot, eye, at, world), false)
  }
  assert.equal(archerCovered(f.bot, eye, at, { blockAt: () => null } as any), false)
})

test('Q10 после входа за колонну повторный localOnly использует последнюю видимую позицию, стрелу джук не игнорирует', async t => {
  const f = scene(t)
  const first = await f.methods.take_cover({ from: 'Archer', localOnly: true })
  assert.equal(first.ok, true)
  const held = f.bot.entity.position.clone()
  const second = await f.methods.take_cover({ from: 'Archer', localOnly: true })
  assert.equal(second.ok, true)
  assert.ok(f.bot.entity.position.equals(held))
  for (let i = 0; i < 60; i++) await f.sleep()
  assert.equal((await f.methods.take_cover({ from: 'Archer', localOnly: true })).ok, true,
    'просроченная позиция не ведёт из уже занятого укрытия обратно под стрелы')
  assert.ok(f.bot.entity.position.equals(held))
  const g = scene(t)
  t.mock.method(threats, 'dangers', () => ({ aims: [{ name: 'Archer' }], arrows: [{ side: { x: -1, z: 0 } }] }))
  await g.methods.juke({ from: 'Archer', maxTicks: 10, jumpy: 0 })
  assert.ok(g.walked[0].x < .5, 'близкая летящая стрела требует немедленного шага влево, колонна справа подождёт')
})

test('wall закрывает луч к телу и при диагональном направлении стрелка', async t => {
  const build: typeof import('../src/build') = require('../src/build')
  for (const [x, z] of [[0, -1], [1, 0], [1, 1], [-1, 1], [1, .4], [-.4, -1]]) {
    const f = scene(t, false), placed = new Map<string, Vec3>(), original = f.bot.blockAt
    f.foe.position = new Vec3(.5 + x * 12, 0, .5 + z * 12)
    f.bot.blockAt = p => placed.has(p.floored().toString())
      ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : original(p)
    t.mock.method(build, 'pickFiller', () => ({ name: 'stone' } as any))
    t.mock.method(build, 'placeBlockAt', async (_bot, at, opts) => {
      assert.equal(opts.honest, true)
      placed.set(at.toString(), at)
      return { ok: true }
    })
    const result = await f.methods.take_cover({ from: 'Archer', wall: true, maxRun: 0, arena: { x: 0, z: 0, r: 20 } })
    assert.equal(result.ok, true, JSON.stringify({ x, z, result, placed: [...placed.keys()] }))
    assert.ok(placed.size <= 6)
  }
})

test('wall не объявляет укрытие по старому лучу переместившегося стрелка', async t => {
  const build: typeof import('../src/build') = require('../src/build')
  const f = scene(t, false), placed = new Set<string>(), original = f.bot.blockAt
  f.foe.position = new Vec3(12.5, 0, .5)
  f.bot.blockAt = p => placed.has(p.floored().toString())
    ? { name: 'stone', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : original(p)
  t.mock.method(build, 'pickFiller', () => ({ name: 'stone' } as any))
  t.mock.method(build, 'placeBlockAt', async (_bot, at) => {
    placed.add(at.toString())
    f.foe.position = new Vec3(.5, 0, -12.5)
    return { ok: true }
  })
  const result = await f.methods.take_cover({ from: 'Archer', wall: true, maxRun: 0, arena: { x: 0, z: 0, r: 20 } })
  assert.equal(result.ok, false)
  assert.equal(placed.size, 1, 'новый угол прекращает бесполезную старую стенку')
})
