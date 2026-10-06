'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const Vec3 = require('vec3')
const drops = require('../src/drops')

// Мир: пол из полных блоков на y=150 (верх 151), по желанию — плита, яма.
const FULL = [[0, 0, 0, 1, 1, 1]]
const SLAB = [[0, 0, 0, 1, 0.5, 1]]

test('craft conservation receives only bounded native own pickup counts with actual item metadata', () => {
  const create = () => {
    const bot = new EventEmitter()
    bot._client = new EventEmitter()
    bot.entity = { id: 1 }
    bot.registry = { entitiesByName: { item: { id: 71 } }, itemsByName: { blackstone: { id: 1 } } }
    bot.entities = { 10: { id: 10, name: 'item', position: new Vec3(0, 0, 0), getDroppedItem: () => ({ name: 'blackstone', count: 64 }) } }
    return bot
  }
  const bot = create()
  const mark = drops.pickupMark(bot)
  bot._client.emit('collect', { collectorEntityId: 2, collectedEntityId: 10, pickupItemCount: 20 })
  assert.deepEqual(drops.pickupDelta(bot, mark), {})
  bot._client.emit('collect', { collectorEntityId: 1, collectedEntityId: 10, pickupItemCount: 10 })
  bot._client.emit('collect', { collectorEntityId: 1, collectedEntityId: 10, pickupItemCount: 3 })
  assert.deepEqual(drops.pickupDelta(bot, mark), { blackstone: 13 }, 'partial pickup uses the native amount, not the metadata stack size')
  for (const packet of [{ pickupItemCount: 0 }, { pickupItemCount: 65 }, {}, { collectedEntityId: 99, pickupItemCount: 10 }]) {
    const invalid = create(); const baseline = drops.pickupMark(invalid)
    invalid._client.emit('collect', { collectorEntityId: 1, collectedEntityId: 10, ...packet })
    assert.equal(drops.pickupDelta(invalid, baseline), null)
  }
  const epoch = drops.pickupMark(bot)
  bot.emit('respawn')
  assert.equal(drops.pickupDelta(bot, epoch), null)
  const overflow = drops.pickupMark(bot)
  for (let receipt = 0; receipt < 513; receipt++) bot._client.emit('collect', { collectorEntityId: 1, collectedEntityId: 10, pickupItemCount: 1 })
  assert.equal(drops.pickupDelta(bot, overflow), null)
  assert.equal(bot._ndDrops.pickups.size, 512)
})
function world ({ slabs = [], pits = [] }: any = {} as Record<string, any>) {
  const k = (x: any, y: any, z: any) => `${x},${y},${z}`
  const slab = new Set(slabs.map(p => k(...(p as [number, number, number]))))
  const pit = new Set(pits.map(p => k(...(p as [number, number, number]))))
  return (x, y, z) => {
    if (slab.has(k(x, y, z))) return { name: 'stone_slab', shapes: SLAB, boundingBox: 'block' }
    if (y === 150 && !pit.has(k(x, y, z))) return { name: 'grass_block', shapes: FULL, boundingBox: 'block' }
    if (y === 149) return { name: 'stone', shapes: FULL, boundingBox: 'block' }
    return { name: 'air', shapes: [], boundingBox: 'empty' }
  }
}

test('брошенное к телу ложится там же, где на сервере (бросок пиглина, замер фермы: z 2.61)', () => {
  const s = drops.simulate(world(), { id: 1, x: 0.5, y: 152.49, z: 5.5, vx: 0, vy: 0.06, vz: -0.28, onGround: false }, 60)
  assert.ok(s.onGround)
  assert.equal(s.y, 151)
  assert.ok(Math.abs(s.z - 2.61) < 0.02, `z ${s.z}`)
})

test('предмет на плите лежит на её верхе, в яме — на дне', () => {
  const onSlab = drops.simulate(world({ slabs: [[3, 151, 0]] }), { id: 2, x: 3.5, y: 153, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false }, 40)
  assert.equal(onSlab.y, 151.5)
  const inPit = drops.simulate(world({ pits: [[-3, 150, 0]] }), { id: 3, x: -2.5, y: 152, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false }, 40)
  assert.equal(inPit.y, 150)
})

test('досягаемость подбора — рамка игрока, раздутая на (1, 0.5, 1)', () => {
  const feet = { x: 0.5, y: 151, z: 0.5 }
  assert.ok(drops.inPickup(feet, { x: 1.9, y: 151, z: 0.5 }))
  assert.ok(!drops.inPickup(feet, { x: 1.95, y: 151, z: 0.5 }))
  assert.ok(!drops.inPickup(feet, { x: 0.5, y: 150, z: 1.5 }), 'в яме соседней клетки с края не достать')
  assert.ok(drops.inPickup(feet, { x: 1.5, y: 153, z: 0.5 }), 'на уступе в два блока рядом — достать')
})

test('цель подбора: на плиту не надо вставать в клетку плиты — хватит соседней', () => {
  const g = new drops.GoalPickup(world({ slabs: [[3, 151, 0]] }), { x: 3.5, y: 151.5, z: 0.5 })
  assert.ok(g.isEnd({ x: 2, y: 151, z: 0 }), 'сосед на траве')
  assert.ok(g.isEnd({ x: 3, y: 152, z: 0 }), 'на самой плите')
  assert.ok(!g.isEnd({ x: 0, y: 151, z: 0 }), 'за три блока — нет')
  const pit = new drops.GoalPickup(world({ pits: [[-3, 150, 0]] }), { x: -2.5, y: 150, z: 0.5 })
  assert.ok(!pit.isEnd({ x: -2, y: 151, z: 0 }), 'с края ямы не подобрать')
  assert.ok(pit.isEnd({ x: -3, y: 150, z: 0 }), 'в яме — да')
})

// Сырой spawn_entity: id пакета, id сущности, UUID, тип, x y z, lpVec3 (как пишет сервер).
function spawnRaw (id, type, x, y, z, lpHex) {
  const xyz = Buffer.alloc(24); xyz.writeDoubleBE(x, 0); xyz.writeDoubleBE(y, 8); xyz.writeDoubleBE(z, 16)
  return Buffer.concat([Buffer.from([0x01, id, ...Array(16).fill(0), type]), xyz, Buffer.from(lpHex, 'hex'), Buffer.from([0, 0, 0, 0])])
}

test('скорость lpVec3 — int big-endian, как пишет сервер (байты из пакетов фермы)', () => {
  const v = h => { const r = drops.readLpVec3(Buffer.from(h, 'hex'), 0); return [r.x, r.y, r.z].map(n => Math.round(n * 1000) / 1000) }
  assert.deepEqual(v('f9ff7ffee145'), [0, -0.12, 0])
  assert.deepEqual(v('f9ff5c290f59'), [0, 0.06, -0.28])
  assert.deepEqual(v('00'), [0, 0, 0])
  const raw = spawnRaw(50, 71, 0.5, 152.49, 5.5, 'f9ff5c290f59')
  assert.deepEqual(Object.values<any>(drops.velocityFromRaw(raw, 'spawn')).map(n => Math.round(n * 1000) / 1000), [0, 0.06, -0.28])
  assert.deepEqual(Object.values<any>(drops.velocityFromRaw(Buffer.from('638e04f9ff7ffee145', 'hex'), 'velocity')).map(n => Math.round(n * 1000) / 1000), [0, -0.12, 0])
})

// Как minecraft-protocol (client.js emitPacket): сначала 'packet' с сырыми байтами, потом событие по имени.
function emitPkt (bot, name, data, raw = Buffer.alloc(0)) {
  bot._client.emit('packet', data, { name }, raw)
  bot._client.emit(name, data)
}

// Обработчики mineflayer (entities.js), подписанные раньше модуля: сдвиг прибавляется к
// e.position, скорость — lpVec3 из читалки (как есть) делится на 8000.
function mineflayerLike (bot) {
  const ent = id => bot.entities[id]
  bot._client.on('rel_entity_move', p => { const e = ent(p.entityId); if (e) e.position.translate(p.dX / 4096, p.dY / 4096, p.dZ / 4096) })
  bot._client.on('entity_velocity', p => { const e = ent(p.entityId); if (e && p.velocity) e.velocity = new Vec3(p.velocity.x / 8000, p.velocity.y / 8000, p.velocity.z / 8000) })
  bot._client.on('sync_entity_position', p => { const e = ent(p.entityId); if (e) { e.position.set(p.x, p.y, p.z); e.velocity = new Vec3(p.dx, p.dy, p.dz) } })
}

// Тело с pathfinder-заглушкой: цель — GoalPickup, «идём» сразу в ближайший узел, где isEnd.
function fakeBot (w) {
  const bot = new EventEmitter()
  bot._client = new EventEmitter()
  bot.registry = { entitiesByName: { item: { id: 71 } } }
  bot.entity = { position: new Vec3(0.5, 151, 0.5), isCollidedHorizontally: false }
  bot.entities = {} as Record<string, any>
  bot.blockAt = p => {
    const b = w(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    return b ? { ...b, position: p } : null
  }
  bot.clearControlStates = () => {}
  bot.setControlState = () => {}
  bot.look = async () => {}
  bot.goals = []
  // Тик тела, как у mineflayer (physicsTick каждые 50 мс).
  bot.ticker = setInterval(() => bot.emit('physicsTick'), 50)
  bot.pathfinder = {
    isMoving: () => false,
    setGoal (g) {
      if (!g) return
      bot.goals.push(g)
      for (let r = 0; r <= 12; r++) {
        for (let dx = -r; dx <= r; dx++) {
          for (let dz = -r; dz <= r; dz++) {
            const node = { x: Math.floor(bot.entity.position.x) + dx, y: 151, z: Math.floor(bot.entity.position.z) + dz }
            if (g.isEnd(node)) { bot.entity.position = new Vec3(node.x + 0.5, 151, node.z + 0.5); return }
          }
        }
      }
    }
  }
  return bot
}

test('подбор идёт туда, где брошенное ляжет, а не туда, откуда его бросили', async () => {
  const w = world()
  const bot = fakeBot(w)
  drops.install(bot)
  // Сервер: бросок у глаз пиглина в 5 блоках, летит к телу (скорость — только в сырых байтах).
  const data = { entityId: 50, type: 71, x: 0.5, y: 152.49, z: 5.5, velocity: { x: -0.5, y: 0.16, z: -0.3 } }
  emitPkt(bot, 'spawn_entity', data, spawnRaw(50, 71, 0.5, 152.49, 5.5, 'f9ff5c290f59'))
  const ent = { id: 50, name: 'item', position: new Vec3(0.5, 152.49, 5.5), getDroppedItem: () => ({ name: 'ender_pearl', count: 3 }) }
  bot.entities[50] = ent
  // Сервер отдаёт предмет, когда рамка тела его касается (как Player.aiStep).
  const timer = setInterval(() => {
    if (!bot.entities[50]) return
    const r = bot._ndDrops.items.get(50)
    const now = drops.predictNow(bot, r)
    if (drops.inPickup(bot.entity.position, now, 0) && Date.now() - r.t0 > 500) {
      bot.emit('playerCollect', bot.entity, ent)
      delete bot.entities[50]
    }
  }, 20)
  try {
    const picked = await drops.collect(bot, { aborted: false }, { radius: 6, timeoutMs: 4000 })
    assert.equal(picked, 1)
    // Шёл к месту падения (z≈2.6), а не к точке броска (z 5.5).
    assert.ok(bot.goals.length >= 1)
    assert.ok(Math.abs(bot.goals[0].p.z - 2.61) < 0.05, `цель z ${bot.goals[0].p.z}`)
    // И e.position теперь — там, где предмет лежит (физика с телом), а не в точке броска.
  } finally { clearInterval(timer); clearInterval(bot.ticker) }
})

test('недостижимый предмет не обрывает подбор остальных', async () => {
  const w = world()
  const bot = fakeBot(w)
  drops.install(bot)
  // Первый (ближний) — на столбе в воздухе, которого pathfinder не достанет; второй — на полу.
  const stuck = { id: 60, name: 'item', position: new Vec3(0.5, 160, 1.5), getDroppedItem: () => ({ name: 'stone', count: 1 }) }
  const ok = { id: 61, name: 'item', position: new Vec3(3.5, 151, 0.5), getDroppedItem: () => ({ name: 'iron_ingot', count: 1 }) }
  bot.entities[60] = stuck; bot.entities[61] = ok
  // «Столб»: запись сервера — лежит на высоте 160 (как на блоке, которого у нас в мире нет).
  bot._ndDrops.items.set(60, { id: 60, t0: 1, tSync: Date.now(), synced: true, x: 0.5, y: 160, z: 1.5, vx: 0, vy: 0, vz: 0, onGround: true })
  const realSet = bot.pathfinder.setGoal
  bot.pathfinder.setGoal = g => { if (g && g.p.y > 155) { setImmediate(() => bot.emit('path_update', { status: 'noPath', path: [] })); bot.goals.push(g); return } realSet(g) }
  const timer = setInterval(() => {
    if (bot.entities[61] && drops.inPickup(bot.entity.position, { x: 3.5, y: 151, z: 0.5 }, 0)) { bot.emit('playerCollect', bot.entity, ok); delete bot.entities[61] }
  }, 20)
  try {
    const picked = await drops.collect(bot, { aborted: false }, { radius: 12, timeoutMs: 4000 })
    assert.equal(picked, 1)
    assert.equal(bot._ndLastCollect.skipped.length, 1)
    assert.equal(bot._ndLastCollect.skipped[0].why, 'пути нет')
  } finally { clearInterval(timer); clearInterval(bot.ticker) }
})

test('e.position летящего предмета двигается с тиками тела и ложится там же, где на сервере', async () => {
  const bot = fakeBot(world())
  mineflayerLike(bot)
  drops.install(bot)
  const ent = { id: 70, name: 'item', position: new Vec3(0.5, 152.49, 5.5), velocity: new Vec3(0, 0, 0), getDroppedItem: () => null }
  bot.entities[70] = ent
  emitPkt(bot, 'spawn_entity', { entityId: 70, type: 71, x: 0.5, y: 152.49, z: 5.5 }, spawnRaw(70, 71, 0.5, 152.49, 5.5, 'f9ff5c290f59'))
  try {
    await new Promise<any>(resolve => setTimeout(resolve, 1500))
    assert.equal(ent.position.y, 151)
    assert.ok(Math.abs(ent.position.z - 2.61) < 0.05, `z ${ent.position.z}`)
    // Сервер: относительный сдвиг от своей прошлой позиции (точка броска). mineflayer прибавляет
    // его к e.position (уже нашей) — после него модуль ставит верную.
    const dZ = Math.round((2.6064 - 5.5) * 4096)
    const dY = Math.round((151 - 152.49) * 4096)
    emitPkt(bot, 'rel_entity_move', { entityId: 70, dX: 0, dY, dZ, onGround: true })
    assert.ok(Math.abs(ent.position.z - 2.6064) < 0.01, `после сдвига z ${ent.position.z} (сдвиг не удвоен)`)
    assert.ok(Math.abs(ent.position.y - 151) < 0.01)
    // Скорость из сырых байтов (0, −0.12, 0) не затирается делённой на 8000 из читалки.
    emitPkt(bot, 'entity_velocity', { entityId: 70, velocity: { x: 1, y: 0.99, z: -0.45 } }, Buffer.from('638e04f9ff7ffee145', 'hex'))
    assert.ok(Math.abs(ent.velocity.y + 0.12) < 0.005, `vy ${ent.velocity.y}`)
  } finally { clearInterval(bot.ticker) }
})

test('отменённый подбор не стирает цель следующего намерения', async () => {
  const bot = fakeBot(world())
  drops.install(bot)
  // pathfinder, который не двигает тело: подбор крутится, пока его не отменят.
  bot.pathfinder = { goal: null, isMoving: () => false, setGoal (g) { this.goal = g } }
  const ent = { id: 80, name: 'item', position: new Vec3(8.5, 151, 0.5), getDroppedItem: () => ({ name: 'stone', count: 1 }) }
  bot.entities[80] = ent
  const ctl: Record<string, any> = { aborted: false }
  const run = drops.pickOne(bot, ctl, { id: 80, e: ent }, { timeoutMs: 3000 })
  await new Promise<any>(resolve => setTimeout(resolve, 200))
  const other = { mine: 'следующее намерение' }
  ctl.aborted = true
  bot.pathfinder.setGoal(other)
  const res = await run
  try {
    assert.equal(res, 'прервано')
    assert.equal(bot.pathfinder.goal, other)
  } finally { clearInterval(bot.ticker) }
})

test('после слияния стопок ждём задержку подбора заново (ваниль берёт max задержек)', async () => {
  const bot = fakeBot(world())
  drops.install(bot)
  let count = 1
  const ent = { id: 90, name: 'item', position: new Vec3(0.9, 151, 0.5), getDroppedItem: () => ({ name: 'stone', count }) }
  bot.entities[90] = ent
  // Старая кучка: лежит давно (записи нет — модуль возьмёт позицию mineflayer), тело рядом.
  drops.lying(bot, { radius: 8 })
  const r = bot._ndDrops.items.get(90)
  r.t0 = Date.now() - 10000
  // Через 100 мс к ней влилась свежая стопка (count 1 → 3), и сервер отдаёт её лишь через 1.5 с.
  setTimeout(() => { count = 3; emitPkt(bot, 'entity_metadata', { entityId: 90, metadata: [] }) }, 100)
  setTimeout(() => { bot.emit('playerCollect', bot.entity, ent); delete bot.entities[90] }, 1600)
  try {
    const res = await drops.pickOne(bot, { aborted: false }, { id: 90, e: ent }, { timeoutMs: 4000 })
    assert.equal(res, 'picked')
  } finally { clearInterval(bot.ticker) }
})

test('ушедшая сущность (entityGone, смена мира) — и записи о ней нет', () => {
  const bot = fakeBot(world())
  drops.install(bot)
  const ent = { id: 95, name: 'item', position: new Vec3(3.5, 151, 0.5), getDroppedItem: () => null }
  bot.entities[95] = ent
  emitPkt(bot, 'spawn_entity', { entityId: 95, type: 71, x: 3.5, y: 151, z: 0.5 }, spawnRaw(95, 71, 3.5, 151, 0.5, '00'))
  assert.ok(bot._ndDrops.items.has(95))
  delete bot.entities[95]
  bot.emit('entityGone', ent)
  clearInterval(bot.ticker)
  assert.ok(!bot._ndDrops.items.has(95))
})

test('слизь отбрасывает предмет (×0.8), в лаве горит всё, кроме незерита и обломков', () => {
  const slime = (x, y, z) => y === 150 ? { name: 'slime_block', shapes: FULL, boundingBox: 'block' } : world()(x, y, z)
  const s = { id: 7, age: 0, x: 0.5, y: 155, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false }
  let bounced = false
  for (let i = 0; i < 40; i++) { drops.stepItem(slime, s); if (s.vy > 0.05) bounced = true }
  assert.ok(bounced, 'на слизи отскок вверх')
  const lava = (x, y, z) => y === 151 ? { name: 'lava', shapes: [], boundingBox: 'empty' } : world()(x, y, z)
  const burn = drops.simulate(lava, { id: 8, x: 0.5, y: 151.2, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false }, 10)
  assert.ok(burn.burning, 'булыжник в лаве сгорает')
  const keep = drops.simulate(lava, { id: 9, x: 0.5, y: 151.2, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false, fireproof: true }, 10)
  assert.ok(!keep.burning, 'незерит в лаве цел')
})

test('пузырьковая колонна над песком душ поднимает предмет', () => {
  const col = (x, y, z) => (y >= 151 && y <= 155) ? { name: 'bubble_column', shapes: [], boundingBox: 'empty', drag: false } : world()(x, y, z)
  const s = drops.simulate(col, { id: 10, x: 0.5, y: 151, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: true }, 20)
  assert.ok(s.y > 153, `поднялся до ${s.y}`)
})

test('отменённый шаг (nudge) не гасит клавиши следующего намерения', async () => {
  const bot = fakeBot(world())
  drops.install(bot)
  const keys: Record<string, any> = {} as Record<string, any>
  bot.setControlState = (k, v) => { keys[k] = v }
  bot.clearControlStates = () => { for (const k of Object.keys(keys)) keys[k] = false }
  // Путь «кончился» рядом (pathfinder стоит), предмет в 1.8 блока — подбор шагает сам (nudge).
  bot.pathfinder = { goal: null, isMoving: () => false, setGoal (g) { this.goal = g } }
  bot.look = () => new Promise<any>(resolve => setTimeout(resolve, 30))
  const ent = { id: 81, name: 'item', position: new Vec3(2.3, 151, 0.5), getDroppedItem: () => ({ name: 'stone', count: 1 }) }
  bot.entities[81] = ent
  const ctl: Record<string, any> = { aborted: false }
  const run = drops.pickOne(bot, ctl, { id: 81, e: ent }, { timeoutMs: 4000 })
  // Ждём, пока шаг начнётся (forward нажат), отменяем и «новое намерение» жмёт своё.
  for (let i = 0; i < 60 && !keys.forward; i++) await new Promise<any>(resolve => setTimeout(resolve, 50))
  ctl.aborted = true
  keys.forward = false; keys.jump = false // session.cancel → clearControlStates
  keys.forward = true // следующее намерение
  await run
  try { assert.equal(keys.forward, true) } finally { clearInterval(bot.ticker) }
})

test('на выходе из пузырьковой колонны (сверху воздух) подъём сильнее, чем внутри', () => {
  const col = (x, y, z) => (y >= 151 && y <= 152) ? { name: 'bubble_column', shapes: [], boundingBox: 'empty', drag: false } : world()(x, y, z)
  const inside = { id: 11, age: 0, x: 0.5, y: 151.1, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false }
  drops.stepItem(col, inside)
  const top = { id: 12, age: 0, x: 0.5, y: 152.1, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false }
  drops.stepItem(col, top)
  assert.ok(top.vy > inside.vy, `сверху ${top.vy} > внутри ${inside.vy}`)
})

test('отмена по сроку (ctl.abort без clearControlStates) не оставляет «вперёд» нажатым', async () => {
  const bot = fakeBot(world())
  drops.install(bot)
  const keys: Record<string, any> = {} as Record<string, any>
  bot.setControlState = (k, v) => { keys[k] = v }
  bot.clearControlStates = () => { for (const k of Object.keys(keys)) keys[k] = false }
  bot.pathfinder = { goal: null, isMoving: () => false, setGoal (g) { this.goal = g } }
  bot.look = () => new Promise<any>(resolve => setTimeout(resolve, 30))
  const ent = { id: 82, name: 'item', position: new Vec3(2.3, 151, 0.5), getDroppedItem: () => ({ name: 'stone', count: 1 }) }
  bot.entities[82] = ent
  // Как session.runIntent: ctl.abort() гонит onAbort синхронно, клавиши сам не трогает.
  const ctl: Record<string, any> = { aborted: false, onAbort: [] }
  ctl.abort = () => { ctl.aborted = true; for (const fn of ctl.onAbort) fn() }
  const run = drops.pickOne(bot, ctl, { id: 82, e: ent }, { timeoutMs: 4000 })
  for (let i = 0; i < 60 && !keys.forward; i++) await new Promise<any>(resolve => setTimeout(resolve, 50))
  ctl.abort()
  assert.equal(keys.forward, false, 'сразу при отмене')
  keys.forward = true // следующее намерение
  await run
  try { assert.equal(keys.forward, true, 'чужое не тронуто') } finally { clearInterval(bot.ticker) }
})
