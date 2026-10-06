'use strict'
const gameClock = require('./game-clock')
// Предметы на земле — общий слой подбора.
//
// Корень «бот не видит выпавшее» (замер pickprobe на ферме, 2026-09-29): mineflayer не
// считает физику предметов, а сервер шлёт позицию предмета раз в 20 тиков (EntityType.ITEM
// updateInterval 20, ServerEntity.sendChanges) и ещё при резкой смене скорости (удар о
// землю). До того тело видит предмет в точке появления: бросок пиглина — у глаз пиглина,
// дроп блока над головой — в воздухе. Прежний подбор читал позицию один раз: шёл к
// клетке в воздухе (GoalBlock → «пути нет» → весь подбор обрывался `break`) или отсеивал
// по радиусу от точки броска — брошенное к телу подбиралось 0 раз из 16. Вторая беда —
// GoalBlock по клетке предмета: на плите, песке душ, пашне клетка предмета — клетка
// самого блока, стоять в ней можно только сломав его.
//
// Здесь:
//  1. свои записи о предметах из пакетов: появление со скоростью (lpVec3 — уже блоки/тик;
//     mineflayer делит её на 8000 и хранит почти ноль), синхронизации позиции и скорости;
//  2. физика ItemEntity.tick 1.21.11: гравитация 0.04, сопротивление 0.98, трение
//     опоры × 0.98, замедление песка душ/мёда, столкновения с формами блоков по осям
//     (Y, затем большая из X/Z — Direction.axisStepOrder) — где предмет сейчас и где ляжет;
//  3. цель для pathfinder «рамка подбора касается предмета» (Player.aiStep: рамка игрока
//     inflate(1.0, 0.5, 1.0), без проверки видимости);
//  4. цикл сбора: не вышло с одним предметом — следующий, а не конец всего подбора;
//     подобранным считается только то, что сервер отдал нам (пакет collect).
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const TICK_MS = 50
const GRAVITY = 0.04
const ITEM_HALF = 0.125 // EntityType.ITEM 0.25 × 0.25
const ITEM_H = 0.25
const PLAYER_HALF = Math.fround(0.6) / 2
const PLAYER_H = 1.8
const REACH_XZ = PLAYER_HALF + 1.0 + ITEM_HALF // |dx| строго меньше — пересечение рамок
const REACH_DOWN = 0.5 + ITEM_H // предмет ниже ног не глубже этого
const REACH_UP = PLAYER_H + 0.5 // и выше ног не выше этого
// pathfinder считает узел пройденным в 0.35 от центра клетки (index.js monitorMovement).
const NODE_SLACK = 0.37
const FRICTION = { ice: 0.98, packed_ice: 0.98, frosted_ice: 0.98, blue_ice: 0.989, slime_block: 0.8 }
const SPEED = { soul_sand: 0.4, honey_block: 0.4 }
// Огнестойкие (DataComponents.DAMAGE_RESISTANT, тег is_fire): в лаве не горят, всплывают.
const FIREPROOF = /netherite|^ancient_debris$/
// Задержка подбора: дроп блока и моба, бросок пиглина — 10 тиков (setDefaultPickUpDelay),
// выброшенное игроком — 40 (Player.drop). Дольше этого плюс запас — не наш случай.
const MAX_PICKUP_DELAY_MS = 2000 + 400

const sleep = ms => new Promise<any>(resolve => gameClock.setTimeout(resolve, ms))

// ------------------------------------------------------------------ записи о предметах

// Запись о предмете: bx..bz — где он по последнему слову сервера (основа для
// относительных сдвигов), x..vz/onGround — состояние на момент tSync, sim — наша физика,
// которая тикает с телом (physicsTick) и двигает e.position, как клиент игры.
// Так все, кто читает e.position (добыча в шахте, стержни, жемчуг, передача из рук),
// видят предмет там, где он есть, а не там, где он появился.
function install (bot) {
  if (bot._ndDrops) return bot._ndDrops
  const S: any = { items: new Map(), mine: new Map(), rawVel: new Map(), itemType: null,
    pickupSequence: 0, pickupEpoch: 0, pickups: new Map() }
  bot._ndDrops = S
  try { S.itemType = bot.registry.entitiesByName.item.id } catch {}
  const now = () => gameClock.now()
  const show = r => {
    const e = bot.entities && bot.entities[r.id]
    if (!e || !e.position || typeof e.position.set !== 'function') return
    e.position.set(r.sim.x, r.sim.y, r.sim.z)
    if (e.velocity && typeof e.velocity.set === 'function') e.velocity.set(r.sim.vx, r.sim.vy, r.sim.vz)
  }
  const reset = (r, patch) => {
    Object.assign(r, patch)
    r.tSync = now()
    r.sim = { id: r.id, age: 0, x: r.x, y: r.y, z: r.z, vx: r.vx, vy: r.vy, vz: r.vz, onGround: r.onGround, fireproof: r.fireproof }
    show(r)
  }
  S.reset = reset
  const cl = bot._client
  if (!cl || typeof cl.on !== 'function') return S
  // Скорость — из сырых байтов пакета: читалка lpVec3 в minecraft-protocol берёт
  // 4 старших байта как little-endian, а сервер (Netty writeInt) пишет big-endian.
  // Замер: предмет в покое (0, −0.12, 0) приходит как (1, 0.99, −0.45), бросок
  // (0, 0.06, −0.28) — как (−0.5, 0.16, −0.30). Сырые байты есть только в событии
  // 'packet', а оно приходит ДО события по имени (minecraft-protocol client.js emitPacket),
  // то есть до обработчика mineflayer: здесь только запомнить скорость, а править
  // e.position и e.velocity — в своих обработчиках событий по имени. Они подписаны
  // позже mineflayer (install — после spawn) и потому идут после него.
  cl.on('packet', (data, meta, buf) => {
    if (!meta || !data) return
    if (meta.name === 'spawn_entity') {
      if (S.itemType !== null && data.type === S.itemType) S.rawVel.set(data.entityId, velocityFromRaw(buf, 'spawn') || { x: 0, y: 0, z: 0 })
    } else if (meta.name === 'entity_velocity') {
      if (S.items.has(data.entityId)) { const v = velocityFromRaw(buf, 'velocity'); if (v) S.rawVel.set(data.entityId, v) }
    }
  })
  cl.on('spawn_entity', data => {
    if (S.itemType === null || data.type !== S.itemType) return
    const v = S.rawVel.get(data.entityId) || { x: 0, y: 0, z: 0 }
    S.rawVel.delete(data.entityId)
    const r = { id: data.entityId, t0: now(), synced: false, bx: data.x, by: data.y, bz: data.z, vx0: v.x, vy0: v.y, vz0: v.z }
    S.items.set(r.id, r)
    reset(r, { x: data.x, y: data.y, z: data.z, vx: v.x, vy: v.y, vz: v.z, onGround: false })
  })
  cl.on('entity_velocity', data => {
    const r = S.items.get(data.entityId)
    const v = S.rawVel.get(data.entityId)
    S.rawVel.delete(data.entityId)
    if (!r || !v) return
    // Скорость меняется «сейчас», позиция — наша на этот миг.
    reset(r, { x: r.sim.x, y: r.sim.y, z: r.sim.z, onGround: r.sim.onGround, vx: v.x, vy: v.y, vz: v.z })
  })
  cl.on('sync_entity_position', data => {
    const r = S.items.get(data.entityId)
    if (!r) return
    Object.assign(r, { bx: data.x, by: data.y, bz: data.z, synced: true })
    reset(r, { x: data.x, y: data.y, z: data.z, vx: data.dx, vy: data.dy, vz: data.dz, onGround: !!data.onGround })
  })
  const rel = data => {
    const r = S.items.get(data.entityId)
    if (!r) return
    // Сдвиг — от прошлой позиции сервера (1/4096 блока), а не от нашей: mineflayer уже
    // прибавил его к e.position (нашей) — ставим верную.
    r.bx += (data.dX || 0) / 4096; r.by += (data.dY || 0) / 4096; r.bz += (data.dZ || 0) / 4096
    r.synced = true
    reset(r, { x: r.bx, y: r.by, z: r.bz, onGround: !!data.onGround, vx: r.sim.vx, vy: r.sim.vy, vz: r.sim.vz })
  }
  cl.on('rel_entity_move', rel)
  cl.on('entity_move_look', rel)
  // Стопка выросла — к ней влилась другая (ItemEntity.merge): задержка подбора у выжившей
  // — max двух, то есть может начаться заново (до 40 тиков у выброшенного игроком).
  cl.on('entity_metadata', data => {
    const r = S.items.get(data.entityId)
    const e = bot.entities[data.entityId]
    if (!r || !e) return
    const st = stackOf(e)
    if (!st) return
    if (typeof r.count === 'number' && st.count > r.count) r.tMerge = now()
    r.count = st.count
    const fp = FIREPROOF.test(st.name)
    if (fp !== !!r.fireproof) { r.fireproof = fp; if (r.sim) r.sim.fireproof = fp }
  })
  cl.on('entity_destroy', data => { for (const id of data.entityIds || []) { S.items.delete(id); S.rawVel.delete(id) } })
  // Сущности, убранные не пакетом (worlds.purgeEntities при смене мира), и сама смена мира.
  bot.on('entityGone', e => { if (e) { S.items.delete(e.id); S.rawVel.delete(e.id) } })
  bot.on('respawn', () => { S.items.clear(); S.rawVel.clear(); S.pickupEpoch++; S.pickups.clear() })
  cl.on('collect', packet => {
    if (!bot.entity || !Number.isSafeInteger(bot.entity.id) || packet.collectorEntityId !== bot.entity.id) return
    const entity = bot.entities?.[packet.collectedEntityId]
    const stack = entity && isItemEntity(entity) ? stackOf(entity) : null
    const count = packet.pickupItemCount
    const known = stack && typeof stack.name === 'string' && bot.registry?.itemsByName?.[stack.name] &&
      Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(stack.count) && count <= stack.count
    S.pickups.set(++S.pickupSequence, known ? { item: stack.name, count } : null)
    if (S.pickups.size > 512) S.pickups.delete(S.pickups.keys().next().value)
  })
  // Физика с телом: каждый тик — шаг для летящих и скользящих.
  bot.on('physicsTick', () => {
    if (!S.items.size) return
    const getBlock = blockGetter(bot)
    for (const r of S.items.values()) {
      if (!r.sim || atRest(r.sim) || r.sim.burning) continue
      if (!bot.entities[r.id]) continue
      // Мир под предметом не прогружен — не роняем его в пустоту.
      if (!getBlock(Math.floor(r.sim.x), Math.floor(r.sim.y) - 1, Math.floor(r.sim.z))) continue
      stepItem(getBlock, r.sim)
      show(r)
    }
  })
  bot.on('playerCollect', (collector, collected) => {
    if (!collector || !collected || collector !== bot.entity) return
    S.mine.set(collected.id, now())
    if (S.mine.size > 512) S.mine.delete(S.mine.keys().next().value)
  })
  return S
}

function pickupMark(bot) {
  const owner = install(bot)
  return Number.isSafeInteger(owner.pickupSequence) && owner.pickups instanceof Map
    ? { owner, sequence: owner.pickupSequence, epoch: owner.pickupEpoch } : null
}

function pickupDelta(bot, mark) {
  const owner = bot._ndDrops
  if (!mark || owner !== mark.owner || owner.pickupEpoch !== mark.epoch || !owner.pickups) return null
  const delta: Record<string, number> = {}
  for (let sequence = mark.sequence + 1; sequence <= owner.pickupSequence; sequence++) {
    const receipt = owner.pickups.get(sequence)
    if (!receipt) return null
    delta[receipt.item] = (delta[receipt.item] || 0) + receipt.count
  }
  return delta
}

// ------------------------------------------------------------------ lpVec3 (1.21.9+)

function readVarInt (buf, off) {
  let value = 0
  let shift = 0
  let i = off
  for (;;) {
    if (i >= buf.length || shift > 35) return null
    const b = buf[i++]
    value |= (b & 0x7f) << shift
    if (!(b & 0x80)) break
    shift += 7
  }
  return { value, size: i - off }
}

// LpVec3.read (Mojang): байт, байт, int big-endian (+ varint масштаба, если бит 2).
function readLpVec3 (buf, off) {
  if (!buf || off >= buf.length) return null
  const a = buf[off]
  if (a === 0) return { x: 0, y: 0, z: 0 }
  if (off + 6 > buf.length) return null
  const b = buf[off + 1]
  const c = buf.readUInt32BE(off + 2)
  const packed = c * 65536 + b * 256 + a
  let scale = a & 3
  if (a & 4) {
    const v = readVarInt(buf, off + 6)
    if (!v) return null
    scale = v.value * 4 + scale
  }
  const un = sh => (Math.min(Math.floor(packed / 2 ** sh) % 32768, 32766) * 2) / 32766 - 1
  return { x: un(3) * scale, y: un(18) * scale, z: un(33) * scale }
}

// Где в сыром пакете скорость: spawn_entity — id пакета, id сущности, UUID, тип,
// x y z (f64); entity_velocity — id пакета, id сущности.
function velocityFromRaw (buf, kind) {
  try {
    if (!Buffer.isBuffer(buf)) return null
    let o: any = 0
    for (const step of kind === 'spawn' ? ['v', 'v', 16, 'v', 24] : ['v', 'v']) {
      if (step === 'v') { const v = readVarInt(buf, o); if (!v) return null; o += v.size } else o += step
    }
    return readLpVec3(buf, o)
  } catch { return null }
}

// Запись о предмете: своя, а если он появился до install — из позиции mineflayer (скорость 0).
function recordOf (bot, e) {
  const S = install(bot)
  let r = S.items.get(e.id)
  if (!r) {
    const p = e.position
    const st = stackOf(e)
    const fireproof = !!st && FIREPROOF.test(st.name)
    r = { id: e.id, t0: 0, synced: true, bx: p.x, by: p.y, bz: p.z, x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, onGround: false, tSync: gameClock.now(), count: st ? st.count : undefined, fireproof }
    r.sim = { id: r.id, age: 0, x: p.x, y: p.y, z: p.z, vx: 0, vy: 0, vz: 0, onGround: false, fireproof }
    S.items.set(e.id, r)
  }
  return r
}

// ------------------------------------------------------------------ физика ItemEntity

function blockGetter (bot) {
  const cache = new Map()
  return (x, y, z) => {
    const k = `${x},${y},${z}`
    if (cache.has(k)) return cache.get(k)
    let b = null
    try { b = bot.blockAt(new Vec3(x, y, z)) } catch {}
    cache.set(k, b)
    return b
  }
}

// Коробки столкновений блоков вокруг рамки (мировые координаты).
function boxesAround (getBlock, x0, y0, z0, x1, y1, z1) {
  const out = []
  for (let x = Math.floor(x0); x <= Math.floor(x1); x++) {
    for (let y = Math.floor(y0) - 1; y <= Math.floor(y1); y++) {
      for (let z = Math.floor(z0); z <= Math.floor(z1); z++) {
        const b = getBlock(x, y, z)
        if (!b || !Array.isArray(b.shapes) || !b.shapes.length || b.boundingBox === 'empty') continue
        for (const s of b.shapes) out.push([x + s[0], y + s[1], z + s[2], x + s[3], y + s[4], z + s[5]])
      }
    }
  }
  return out
}

// Shapes.collide по одной оси: насколько рамка b сдвинется на d, не входя в коробки.
function clip (boxes, b, axis, d) {
  const [a0, a1, o1a, o1b, o2a, o2b] = axis === 0 ? [0, 3, 1, 4, 2, 5] : axis === 1 ? [1, 4, 0, 3, 2, 5] : [2, 5, 0, 3, 1, 4]
  for (const s of boxes) {
    if (Math.abs(d) < 1e-7) return 0
    if (s[o1b] <= b[o1a] + 1e-7 || s[o1a] >= b[o1b] - 1e-7) continue
    if (s[o2b] <= b[o2a] + 1e-7 || s[o2a] >= b[o2b] - 1e-7) continue
    if (d > 0 && s[a0] >= b[a1] - 1e-7) d = Math.min(d, s[a0] - b[a1])
    else if (d < 0 && s[a1] <= b[a0] + 1e-7) d = Math.max(d, s[a1] - b[a0])
  }
  return Math.abs(d) < 1e-7 ? 0 : d
}

function blockName (getBlock, x, y, z) {
  const b = getBlock(Math.floor(x), Math.floor(y), Math.floor(z))
  return b ? b.name : null
}

// Один тик ItemEntity.tick (серверная ветка, без слияния стопок и толчка течением).
function stepItem (getBlock, s) {
  const here = blockName(getBlock, s.x, s.y + 0.05, s.z)
  if (here === 'lava' && !s.fireproof) { s.burning = true }
  if (here === 'water' || here === 'bubble_column') { s.vx *= 0.99; s.vz *= 0.99; if (s.vy < 0.06) s.vy += 5e-4 } else if (here === 'lava') { s.vx *= 0.95; s.vz *= 0.95; if (s.vy < 0.06) s.vy += 5e-4 } else s.vy -= GRAVITY
  const idTick = ((s.age || 0) + (s.id || 0)) % 4 === 0
  if (!s.onGround || s.vx * s.vx + s.vz * s.vz > 1e-5 || idTick) {
    const b = [s.x - ITEM_HALF, s.y, s.z - ITEM_HALF, s.x + ITEM_HALF, s.y + ITEM_H, s.z + ITEM_HALF]
    const reach = Math.max(Math.abs(s.vx), Math.abs(s.vy), Math.abs(s.vz)) + 1
    const boxes = boxesAround(getBlock, b[0] - reach, b[1] - reach, b[2] - reach, b[3] + reach, b[4] + reach, b[5] + reach)
    const move = [0, 0, 0]
    const want = [s.vx, s.vy, s.vz]
    const order = Math.abs(s.vx) < Math.abs(s.vz) ? [1, 2, 0] : [1, 0, 2]
    for (const ax of order) {
      if (want[ax] === 0) continue
      const moved = [b[0] + move[0], b[1] + move[1], b[2] + move[2], b[3] + move[0], b[4] + move[1], b[5] + move[2]]
      move[ax] = clip(boxes, moved, ax, want[ax])
    }
    s.x += move[0]; s.y += move[1]; s.z += move[2]
    const hitX = Math.abs(move[0] - want[0]) > 1e-5
    const hitZ = Math.abs(move[2] - want[2]) > 1e-5
    const hitY = move[1] !== want[1]
    s.onGround = hitY && want[1] < 0
    if (hitX) s.vx = 0
    if (hitZ) s.vz = 0
    // Block.updateEntityMovementAfterFallOn: обычный блок гасит vy, слизь отбрасывает не-живое
    // на 0.8 (SlimeBlock.bounceUp), кровать — на 0.66 × 0.8 (BedBlock.bounceUp).
    if (hitY) {
      const on = want[1] < 0 ? blockName(getBlock, s.x, s.y - 0.2, s.z) : null
      s.vy = on === 'slime_block' ? -want[1] * 0.8 : (on && /_bed$/.test(on)) ? -want[1] * 0.66 * 0.8 : 0
    }
    // Пузырьковая колонна (BubbleColumnBlock.entityInside): вниз над магмой (drag), вверх над
    // песком душ. Внутри (над клеткой колонны не воздух) — onInsideBubbleColumn: max(−0.3, vy−0.03)
    // / min(0.7, vy+0.06); на выходе (над ней воздух) — onAboveBubbleColumn: max(−0.9, vy−0.03) /
    // min(1.8, vy+0.1).
    const cx = Math.floor(s.x); const cy = Math.floor(s.y); const cz = Math.floor(s.z)
    const col = getBlock(cx, cy, cz)
    if (col && col.name === 'bubble_column') {
      let drag = false
      try { drag = String(col.getProperties ? col.getProperties().drag : col.drag) === 'true' } catch {}
      const up = getBlock(cx, cy + 1, cz)
      const top = !up || up.name === 'air' || up.name === 'cave_air' || up.name === 'void_air'
      s.vy = drag ? Math.max(top ? -0.9 : -0.3, s.vy - 0.03) : Math.min(top ? 1.8 : 0.7, s.vy + (top ? 0.1 : 0.06))
    }
    const own = blockName(getBlock, s.x, s.y, s.z)
    const below = blockName(getBlock, s.x, s.y - 0.500001, s.z)
    const sf = SPEED[own] || SPEED[below] || 1
    s.vx *= sf; s.vz *= sf
    const f = s.onGround ? (FRICTION[below] || 0.6) * 0.98 : 0.98
    s.vx *= f; s.vy *= 0.98; s.vz *= f
    if (s.onGround && s.vy < 0) s.vy *= -0.5
  }
  s.age = (s.age || 0) + 1
  return s
}

// Где предмет по физике через n тиков после записи (и лежит ли он уже).
function simulate (getBlock, r, ticks) {
  const s: any = { id: r.id, age: 0, x: r.x, y: r.y, z: r.z, vx: r.vx, vy: r.vy, vz: r.vz, onGround: r.onGround, fireproof: r.fireproof }
  for (let t = 0; t < ticks; t++) {
    stepItem(getBlock, s)
    if (s.burning) break
    if (s.y < -128) break
  }
  return s
}

function atRest (s) {
  return s.onGround && Math.abs(s.vy) < 1e-3 && s.vx * s.vx + s.vz * s.vz < 1e-4
}

// Сейчас — наша физика (sim, тикает с телом от последнего слова сервера); «где ляжет» —
// от неё вперёд до покоя.
function predictNow (bot, r) {
  const s = r.sim || r
  return { x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, onGround: s.onGround }
}

function predictRest (bot, r, getBlock = null) {
  const cur = { ...(r.sim || r), id: r.id, age: (r.sim && r.sim.age) || 0 }
  if (atRest(cur)) return { ...cur, rest: true }
  if (cur.burning) return { ...cur, rest: true, burns: true }
  getBlock = getBlock || blockGetter(bot)
  for (let t = 0; t < 160; t++) {
    stepItem(getBlock, cur)
    if (cur.burning) return { ...cur, rest: true, burns: true }
    if (atRest(cur) || cur.y < -128) break
  }
  return { ...cur, rest: atRest(cur) }
}

// Где предмет сейчас и где ляжет — для чужих модулей (Vec3).
function nowOf (bot, e) {
  const p = predictNow(bot, recordOf(bot, e))
  return new Vec3(p.x, p.y, p.z)
}
function restOf (bot, e) {
  const p = predictRest(bot, recordOf(bot, e))
  return new Vec3(p.x, p.y, p.z)
}
// Скорость появления (блоки/тик), если её прислал сервер, — для «кинул в мою сторону».
function spawnVelocity (bot, id) {
  const r = bot._ndDrops && bot._ndDrops.items.get(id)
  return r && r.t0 ? { x: r.vx0 ?? r.vx, y: r.vy0 ?? r.vy, z: r.vz0 ?? r.vz } : null
}

// ------------------------------------------------------------------ досягаемость подбора

// Рамка игрока с ногами в feet, раздутая на (1.0, 0.5, 1.0), пересекает рамку предмета в p
// (Player.aiStep → touch). Пересечение строгое (AABB.intersects).
function inPickup (feet, p, margin = 0.02) {
  return Math.abs(p.x - feet.x) < REACH_XZ - margin &&
    Math.abs(p.z - feet.z) < REACH_XZ - margin &&
    p.y > feet.y - REACH_DOWN + margin &&
    p.y < feet.y + REACH_UP - margin
}

// Высота ног на узле pathfinder: верх коробки блока под ним (плита — на полблока ниже).
function feetYAt (getBlock, x, y, z) {
  const b = getBlock(x, y - 1, z)
  if (!b || !Array.isArray(b.shapes) || !b.shapes.length) return y
  const top = Math.max(...b.shapes.map(s => s[4]))
  return top <= 1 ? y - 1 + top : y
}

class GoalPickup extends goals.Goal {
  declare getBlock: any
  declare p: any

  constructor (getBlock, p) {
    super()
    this.getBlock = getBlock
    this.p = { x: p.x, y: p.y, z: p.z }
  }

  heuristic (node) {
    const dx = node.x + 0.5 - this.p.x
    const dz = node.z + 0.5 - this.p.z
    return Math.sqrt(dx * dx + dz * dz) + Math.abs(node.y - this.p.y)
  }

  isEnd (node) {
    const feet = { x: node.x + 0.5, y: feetYAt(this.getBlock, node.x, node.y, node.z), z: node.z + 0.5 }
    return inPickup(feet, this.p, NODE_SLACK)
  }
}

// ------------------------------------------------------------------ что лежит

function isItemEntity (e) {
  return !!e && !!e.position && (e.name === 'item' || e.displayName === 'Item' || e.name === 'item_stack')
}

function stackOf (e) {
  try { return e.getDroppedItem() || null } catch { return null }
}

// Предметы вокруг: где лежат по физике (rest), а не где их последний раз видел mineflayer.
// Радиус — от from и от тела сейчас (что ближе): куча добычи вытягивается следом за
// телом, как у прежнего подбора; ход ограничен сроком вызова.
function lying (bot, { radius = 8, from = null, match = null, skip = null }: any = {}) {
  const S = install(bot)
  const me = bot.entity.position
  const center = from || me
  const getBlock = blockGetter(bot)
  const out = []
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!isItemEntity(e) || e === bot.entity) continue
    if (skip && skip.has(e.id)) continue
    const r = recordOf(bot, e)
    const rest = predictRest(bot, r, getBlock)
    if (rest.burns) continue
    const dist = Math.min(Math.hypot(rest.x - center.x, rest.y - center.y, rest.z - center.z), Math.hypot(rest.x - me.x, rest.y - me.y, rest.z - me.z))
    if (dist > radius) continue
    const stack = stackOf(e)
    if (match && !match(e, stack)) continue
    out.push({ e, id: e.id, stack, name: stack ? stack.name : null, rest, dist, age: r.t0 ? gameClock.now() - r.t0 : Infinity })
  }
  S.lastLying = out.length
  return out.sort((a, b) => a.dist - b.dist)
}

// ------------------------------------------------------------------ подойти и подобрать один

// Итог: 'picked' — сервер отдал нам (collect); 'gone' — исчез не у нас (слияние, огонь,
// чужой подбор); иначе причина неудачи.
interface PickupOptions {
  timeoutMs?: number
  allowMovement?: boolean
  canContinue?: () => boolean
}

async function pickOne (bot, ctl, item, { timeoutMs = 6000, allowMovement = true, canContinue = () => true }: PickupOptions = {}) {
  const S = install(bot)
  const id = item.id
  const deadline = gameClock.now() + timeoutMs
  const getBlock = blockGetter(bot)
  const r0 = S.items.get(id) || recordOf(bot, item.e)
  let target = predictRest(bot, r0, getBlock)
  let goal = null
  let noPath = false
  let lastProgress = gameClock.now()
  let best = Infinity
  let inRangeSince = 0
  let pickupReceiptUntil = 0
  const onPath = res => { if (res && res.status === 'noPath' && (!res.path || !res.path.length)) noPath = true }
  bot.on('path_update', onPath)
  // Снимать только свою цель: после отмены её место может занять уже следующее намерение.
  // При отмене — сразу (ctl.onAbort синхронен), не дожидаясь очередного круга.
  const dropGoal = () => { try { if (goal && bot.pathfinder.goal === goal) bot.pathfinder.setGoal(null) } catch {} }
  const hooked = Array.isArray(ctl.onAbort)
  if (hooked) ctl.onAbort.push(dropGoal)
  const setGoal = p => {
    goal = new GoalPickup(blockGetter(bot), p)
    noPath = false
    try { bot.pathfinder.setGoal(goal) } catch {}
  }
  try {
    for (;;) {
      if (!bot.entities[id]) return S.mine.has(id) ? 'picked' : 'gone'
      if (ctl.aborted) return 'прервано'
      if (!canContinue()) return 'подбор небезопасен'
      const r = S.items.get(id) || r0
      const now = predictNow(bot, r)
      const feet = bot.entity.position
      const touching = inPickup(feet, now)
      if (touching && !inRangeSince) {
        inRangeSince = gameClock.now()
        pickupReceiptUntil = gameClock.wall.monotonic() + (bot.version === '1.21.11' ? 250 : 0)
      }
      if (gameClock.now() > deadline && (!touching || gameClock.wall.monotonic() >= pickupReceiptUntil)) return 'время вышло'
      if (touching) {
        // В досягаемости: стоять и ждать, пока кончится задержка подбора (от появления или
        // от слияния стопок — ItemEntity.merge берёт max задержек).
        if (goal) { dropGoal(); goal = null }
        bot.clearControlStates()
        const born = Math.max(r.t0 || 0, r.tMerge || 0)
        const age = born ? gameClock.now() - born : Infinity
        if (gameClock.now() - inRangeSince > 700 && age > MAX_PICKUP_DELAY_MS && gameClock.wall.monotonic() >= pickupReceiptUntil) return 'рядом, но не отдают'
        await sleep(TICK_MS)
        continue
      }
      inRangeSince = 0
      const rest = predictRest(bot, r, getBlock)
      if (!allowMovement) {
        if (!inPickup(feet, rest)) return 'вне рамки подбора'
        bot.clearControlStates()
        await sleep(TICK_MS)
        continue
      }
      const flat = Math.hypot(rest.x - feet.x, rest.z - feet.z)
      const d = flat + Math.abs(rest.y - feet.y)
      if (d < best - 0.25) { best = d; lastProgress = gameClock.now() }
      // Рядом и на том же уровне, а pathfinder встал (путь кончился в соседней клетке) —
      // шаг прямо к предмету, как делает человек.
      let moving = false
      try { moving = bot.pathfinder.isMoving() } catch {}
      if (goal && !moving && flat < 2.2 && Math.abs(rest.y - feet.y) < 0.9 && gameClock.now() - lastProgress > 600) {
        dropGoal()
        goal = null
        await nudge(bot, ctl, rest, 600)
        lastProgress = gameClock.now()
        continue
      }
      if (!goal || Math.hypot(rest.x - target.x, rest.y - target.y, rest.z - target.z) > 0.3) {
        target = rest
        if (process.env.ND_DEBUG_DROPS) console.log('[drops] goal', id, JSON.stringify({ rec: { x: r.x, y: r.y, z: r.z, vx: r.vx, vy: r.vy, vz: r.vz, og: r.onGround, synced: r.synced, age: gameClock.now() - r.t0, sinceSync: gameClock.now() - r.tSync }, now: { x: now.x, y: now.y, z: now.z }, rest: { x: rest.x, y: rest.y, z: rest.z, rest: rest.rest }, feet: { x: feet.x, y: feet.y, z: feet.z } }))
        setGoal(rest)
      }
      if (noPath) return 'пути нет'
      if (gameClock.now() - lastProgress > 3500) return 'не приближаюсь'
      await sleep(TICK_MS)
    }
  } finally {
    bot.removeListener('path_update', onPath)
    if (hooked) { const i = ctl.onAbort.indexOf(dropGoal); if (i >= 0) ctl.onAbort.splice(i, 1) }
    dropGoal()
  }
}

// Шаг к точке без pathfinder: взгляд по горизонту и вперёд, пока не дошли или не вышло время.
// Свои клавиши снимаем в момент отмены (ctl.onAbort — синхронно, до того как управление
// получит следующее намерение), а после отмены их не трогаем: они уже чужие. Ревью Codex
// 29.09: старый шаг гасил чужой «вперёд», а отмена по сроку (runIntent → ctl.abort без
// clearControlStates) оставляла «вперёд» нажатым.
async function nudge (bot, ctl, p, ms) {
  const until = gameClock.now() + ms
  let mine = false
  const release = () => {
    if (!mine) return
    mine = false
    try { bot.setControlState('forward', false); bot.setControlState('jump', false) } catch {}
  }
  const hooked = Array.isArray(ctl.onAbort)
  if (hooked) ctl.onAbort.push(release)
  try {
    while (gameClock.now() < until && !ctl.aborted) {
      const me = bot.entity.position
      const dx = p.x - me.x
      const dz = p.z - me.z
      if (Math.hypot(dx, dz) < 0.4) break
      await bot.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
      if (ctl.aborted) return
      bot.setControlState('forward', true)
      bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
      mine = true
      await sleep(TICK_MS)
    }
  } finally {
    if (hooked) { const i = ctl.onAbort.indexOf(release); if (i >= 0) ctl.onAbort.splice(i, 1) }
    if (!ctl.aborted) release()
  }
}

// ------------------------------------------------------------------ подобрать всё вокруг

// radius — от точки from (по умолчанию где тело в начале вызова), по месту, где предмет
// ляжет. appearMs — сколько ждать предметов, которых ещё нет (спавн приходит через тик-два
// после слома или смерти). Возвращает число подобранных стопок; подробности — в bot._ndLastCollect.
async function collect (bot, ctl, { radius = 6, timeoutMs = 8000, from = null, match = null, appearMs = 600, onStack = null, allowMovement = true, canContinue = () => true }: any = {}) {
  install(bot)
  const t0 = gameClock.now()
  let deadline = t0 + timeoutMs
  const spawnReceiptUntil = gameClock.wall.monotonic() + (bot.version === '1.21.11' && appearMs > 0 ? 250 : 0)
  const center = from ? new Vec3(from.x, from.y, from.z) : bot.entity.position.clone()
  const skip = new Map()
  const report = { picked: 0, gone: 0, skipped: [], seen: 0 }
  bot._ndLastCollect = report
  while (!ctl.aborted && canContinue()) {
    const cands = lying(bot, { radius, from: center, match, skip })
    if (gameClock.now() >= deadline && (report.seen > 0 || gameClock.wall.monotonic() >= spawnReceiptUntil)) break
    if (cands.length && !report.seen && gameClock.now() >= deadline) deadline = gameClock.now() + timeoutMs
    report.seen = Math.max(report.seen, cands.length + report.picked)
    if (!cands.length) {
      if (gameClock.now() - t0 < appearMs || gameClock.wall.monotonic() < spawnReceiptUntil) { await sleep(TICK_MS * 2); continue }
      break
    }
    // Ближайший к телу (не к центру поиска): обход кучи по порядку, без метаний.
    const me = bot.entity.position
    const it = cands.map(c => ({ c, d: Math.hypot(c.rest.x - me.x, c.rest.y - me.y, c.rest.z - me.z) })).sort((a, b) => a.d - b.d)[0].c
    if (onStack) {
      const verdict = await onStack(it)
      if (verdict === 'skip') { skip.set(it.id, 'не берём'); continue }
    }
    if (ctl.aborted || !canContinue()) break
    const far = Math.hypot(it.rest.x - me.x, it.rest.z - me.z)
    const res = await pickOne(bot, ctl, it, { timeoutMs: Math.min(3000 + 450 * far, Math.max(0, deadline - gameClock.now())), allowMovement, canContinue })
    if (res === 'picked') report.picked++
    else if (res === 'gone') report.gone++
    else { skip.set(it.id, res); report.skipped.push({ item: it.name, at: { x: +it.rest.x.toFixed(1), y: +it.rest.y.toFixed(1), z: +it.rest.z.toFixed(1) }, why: res }) }
  }
  return report.picked
}

module.exports = {
  install, pickupMark, pickupDelta, collect, pickOne, lying, nowOf, restOf, spawnVelocity, predictNow, predictRest, simulate, stepItem, inPickup, feetYAt, readLpVec3, velocityFromRaw,
  GoalPickup, isItemEntity, blockGetter, REACH_XZ, REACH_DOWN, REACH_UP
}
