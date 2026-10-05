'use strict'
const gameClock = require('./game-clock')
// Подбор стрел в бою. Просьба 2026-09-25: «они видят, где стрелы падают, могут
// специально к ним подбегать и собирать, чтобы потом на дальнике атаковать».
//
// Правила — из декомпиляции 1.21.11 (extremeheat/extracted_minecraft_data,
// ветка client1.21.11):
// · стрелу, выпущенную игроком, подбирает ЛЮБОЙ игрок — и свои, и чужие
//   промахи (AbstractArrow.setOwner: владелец Player → pickup ALLOWED); стрелы
//   мобов — DISALLOWED; лук с «Бесконечностью» кладёт компонент
//   INTANGIBLE_PROJECTILE → CREATIVE_ONLY, такие в выживании не взять;
// · берётся воткнутая (in_ground) и отдрожавшая: shakeTime = 7 тиков;
// · касание — рамка игрока, раздутая на 1.0 вбок и 0.5 по высоте
//   (Player.aiStep: getBoundingBox().inflate(1.0, 0.5, 1.0)); стрела 0.5×0.5,
//   игрок 0.6×1.8: по x и по z центр ближе 1.55, по высоте стрела от ступней
//   −1.0 до +2.3;
// · воткнутая живёт 1200 тиков (tickDespawn) — минуту;
// · отбитая щитом стрела падает предметом (spawnAtLocation) — его тоже берём.

const SPRINT = 5.612 // м/с, спринт игрока (0.13 блока/тик после трения ×20)
const TOUCH = 1.55
const SHAKE_MS = 7 * 50

const tracked = new WeakMap()

// Кто стрелял: владельца сервер присылает в spawn_entity (objectData = id
// стрелка), а mineflayer его выбрасывает — ловим пакет сами, один раз на бота.
function track (bot) {
  let t = tracked.get(bot)
  if (t) return t
  // bad — стрелы, которые не взять: не взялась при касании, или выпущены луком
  // с «Бесконечностью» / арбалетом с «Тройным выстрелом» (AbstractArrow.pickup
  // = CREATIVE_ONLY — выживающему не дастся; сервер это поле клиенту не шлёт,
  // поэтому — по чарам оружия в руке стрелка в миг выстрела). Раньше бот
  // бегал к такой стреле снова и снова: «сбегал за стрелой — не берётся» по
  // 20–27 раз за раунд (арена с чарами, 2026-09-26).
  // shots — выстрелы по стрелкам (id → {n, at}): стрела родилась — он выстрелил.
  // Точнее натяжения: предмет в его руке клиент видит не всегда (лук в руке
  // только на время выстрела, пакет снаряжения опаздывает за флагами).
  t = { player: new Map(), landed: new Map(), bad: new Set(), shots: new Map() }
  tracked.set(bot, t)
  const arrowTypes = new Set(['arrow', 'spectral_arrow']
    .map(n => bot.registry.entitiesByName[n]).filter(Boolean).map(e => e.id))
  bot._client.on('spawn_entity', p => {
    if (!arrowTypes.has(p.type)) return
    // Стрелок вне видимости или стрелы без стрелка (/summon) — неизвестно:
    // такие пробуем. Отсекаем только те, что точно выпустил моб.
    const owner = p.objectData ? bot.entities[p.objectData] : null
    if (p.objectData) { const s = t.shots.get(p.objectData) || { n: 0, at: 0 }; s.n++; s.at = gameClock.now(); t.shots.set(p.objectData, s) }
    t.player.set(p.entityId, owner ? owner.type === 'player' : null)
    if (t.player.size > 2000) t.player.delete(t.player.keys().next().value)
    try {
      const w = owner ? (owner === bot.entity ? bot.heldItem : owner.equipment && owner.equipment[0]) : null
      const ench = w && Array.isArray(w.enchants) ? w.enchants.map(x => x.name) : []
      if (w && ((w.name === 'bow' && ench.includes('infinity')) || (w.name === 'crossbow' && ench.includes('multishot')))) t.bad.add(p.entityId)
    } catch {}
    if (t.bad.size > 2000) t.bad.delete(t.bad.values().next().value)
  })
  bot.on('entityGone', e => { t.player.delete(e.id); t.landed.delete(e.id); t.bad.delete(e.id) })
  // Когда воткнулась — по метке in_ground в момент, когда она пришла: от него
  // считаются 7 тиков дрожи и минута жизни.
  bot.on('entityUpdate', e => {
    if ((e.name === 'arrow' || e.name === 'spectral_arrow') && !t.landed.has(e.id) && inGround(bot, e)) t.landed.set(e.id, gameClock.now())
  })
  return t
}

function arrowCount (bot) {
  let n = 0
  for (const i of bot.inventory.items()) if (/arrow$/.test(i.name)) n += i.count
  return n
}

// Влезет ли стрела: неполная пачка стрел или пустой слот рюкзака.
function hasRoom (bot) {
  const inv = bot.inventory
  for (let s = inv.inventoryStart; s < inv.inventoryEnd; s++) {
    const it = inv.slots[s]
    if (!it) return true
    if (it.name === 'arrow' && it.count < it.stackSize) return true
  }
  return false
}

function inGround (bot, e) {
  const keys = bot.registry.entitiesByName[e.name] && bot.registry.entitiesByName[e.name].metadataKeys
  const i = keys ? keys.indexOf('in_ground') : -1
  if (i >= 0 && e.metadata && e.metadata[i] !== undefined) return !!e.metadata[i]
  return e.velocity && Math.abs(e.velocity.x) + Math.abs(e.velocity.y) + Math.abs(e.velocity.z) < 0.01
}

function solid (bot, x, y, z) {
  const b = bot.blockAt({ x, y, z, floored () { return this } })
  return !!b && b.boundingBox === 'block'
}

// Клетка, где можно стоять: под ногами твёрдое, на уровне ног и головы — не
// твёрдое и не опасное.
const BAD = /lava|fire|cobweb|magma|campfire|sweet_berry|powder_snow|cactus/
function standable (bot, x, y, z) {
  const fx = Math.floor(x); const fz = Math.floor(z)
  if (!solid(bot, fx, y - 1, fz)) return false
  for (const dy of [0, 1]) {
    const b = bot.blockAt(new (require('vec3').Vec3)(fx, y + dy, fz))
    if (!b || b.boundingBox === 'block' || BAD.test(b.name)) return false
  }
  const under = bot.blockAt(new (require('vec3').Vec3)(fx, y - 1, fz))
  return !(under && BAD.test(under.name))
}

// Путь по прямой до точки подбора: каждая клетка через 0.3 блока — с полом и
// без опасностей. Дыра в полу по дороге — не идём (арена в небе).
function lineClear (bot, from, to) {
  const y = Math.floor(from.y + 0.01)
  const dx = to.x - from.x; const dz = to.z - from.z
  const len = Math.hypot(dx, dz)
  for (let s = 0.3; s <= len; s += 0.3) {
    const x = from.x + dx * s / len; const z = from.z + dz * s / len
    if (!standable(bot, x, y, z)) return false
  }
  return true
}

// Стрелы, которые можно взять отсюда: воткнулись, стрелял игрок, по высоте
// достаёт рука (−1.0..+2.3 от ступней на уровне нашего пола), ближе maxDist.
function pickable (bot, { maxDist = 12 } = {}) {
  const t = track(bot)
  const me = bot.entity.position
  const now = gameClock.now()
  const out = []
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position) continue
    let kind = null
    if (e.name === 'arrow' || e.name === 'spectral_arrow') {
      if (t.player.get(e.id) === false) continue // стрела моба — не подобрать
      if (t.bad.has(e.id)) continue // не взялась или «Бесконечность»/«Тройной»
      if (!inGround(bot, e)) { t.landed.delete(e.id); continue }
      // Воткнутую до нашего взгляда считаем отдрожавшей.
      if (!t.landed.has(e.id)) t.landed.set(e.id, now - SHAKE_MS)
      if (now - t.landed.get(e.id) < SHAKE_MS) continue
      kind = 'стрела'
    } else if (e.name === 'item') {
      let it = null
      try { it = e.getDroppedItem && e.getDroppedItem() } catch {}
      if (!it || !/arrow$/.test(it.name)) continue
      kind = 'предмет'
    } else continue
    const dy = e.position.y - me.y
    if (dy < -1.0 || dy > 2.3) continue
    const dist = Math.hypot(e.position.x - me.x, e.position.z - me.z)
    if (dist > maxDist) continue
    out.push({ e, kind, pos: e.position, dist, age: now - (t.landed.get(e.id) || now) })
  }
  return out.sort((a, b) => a.dist - b.dist)
}

// Стоит ли бежать и за какой. Нужда — от запаса: без стрел идём дальше и в
// окно поуже, с полным колчаном — только за тем, что лежит под рукой.
// Окно — он не успеет добежать до нас, пока мы подбираем: его путь до стрелы
// минус то, что он пробежит спринтом за наше время, должен остаться больше
// 3.5 блока (дальность удара 3 + запас); занят (ест, в коробке, на столбе) —
// хватает 2.
function plan (bot, { enemy = null, busy = false, hp = 20 } = {}) {
  if (!bot.entity || !hasRoom(bot)) return null
  const have = arrowCount(bot)
  const maxDist = have === 0 ? 16 : have < 16 ? 11 : have < 48 ? 6 : 2.5
  const list = pickable(bot, { maxDist })
  if (!list.length) return null
  const me = bot.entity.position
  const eD = enemy ? Math.hypot(enemy.position.x - me.x, enemy.position.z - me.z) : Infinity
  if (enemy && hp < 8 && eD < 10 && !busy) return null
  // Бег бросается, когда он ближе 5 (collect.abortIf в pvp.js) — начинать
  // имеет смысл только с запасом от этой черты.
  if (enemy && eD < 6.5 && !busy) return null
  for (const a of list) {
    const stop = Math.max(0, a.dist - 1.1)
    const tRun = stop / SPRINT + SHAKE_MS / 1000
    if (enemy) {
      const eToA = Math.hypot(enemy.position.x - a.pos.x, enemy.position.z - a.pos.z)
      if (eToA - tRun * SPRINT < (busy ? 2 : 3.5)) continue
    }
    const to = stopPoint(me, a.pos, stop)
    if (stop > 0.05 && !lineClear(bot, me, to)) continue
    return a
  }
  return null
}

function stopPoint (me, pos, stop) {
  const dx = pos.x - me.x; const dz = pos.z - me.z
  const len = Math.hypot(dx, dz) || 1
  return { x: me.x + dx / len * stop, y: me.y, z: me.z + dz / len * stop }
}

const sleep = ms => new Promise(r => gameClock.setTimeout(r, ms))

// Сбегать за стрелой (и за соседними — в пределах 3 блоков от следующей) и
// вернуться к бою. Бросаем, как только: ударили нас, враг сократил до abortIf,
// шаг опасен (safe), стрелы нет, вышло maxMs. Управление по возвращении пустое —
// главный цикл боя выставит своё на следующем тике.
async function collect (bot, ctl, { target, safe = null, abortIf = null, maxMs = 3500 } = {}) {
  const t0 = gameClock.now()
  const before = arrowCount(bot)
  const hp0 = bot.health ?? 20
  let cur = target
  let why = 'собрал'
  let moved = false
  const stopKeys = () => { for (const k of ['forward', 'sprint', 'jump', 'back', 'left', 'right']) bot.setControlState(k, false) }
  try {
    while (cur) {
      if (ctl && ctl.aborted) { why = 'прервали'; break }
      if (gameClock.now() - t0 > maxMs) { why = 'не успел'; break }
      if ((bot.health ?? 20) < hp0) { why = 'ударили'; break }
      if (abortIf && abortIf()) { why = 'враг рядом'; break }
      if (!cur.e.isValid || !bot.entities[cur.e.id]) {
        // Взяли (или пропала) — соседняя в пределах 3 блоков, если есть.
        const next = pickable(bot, { maxDist: 3 })[0]
        if (!next || !hasRoom(bot)) break
        cur = next
        continue
      }
      const me = bot.entity.position
      const dx = cur.e.position.x - me.x; const dz = cur.e.position.z - me.z
      const dist = Math.hypot(dx, dz)
      if (dist < 0.9) { stopKeys(); await sleep(100); if (cur.e.isValid && bot.entities[cur.e.id]) { why = 'не берётся'; track(bot).bad.add(cur.e.id); break } continue }
      const dir = { x: dx / dist, y: 0, z: dz / dist }
      if (safe && !safe(dir)) { why = 'опасный шаг'; break }
      const yaw = Math.atan2(-dx, -dz)
      await bot.look(yaw, bot.entity.pitch, true)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', (bot.food ?? 20) > 6 && dist > 1.6)
      bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
      moved = true
      await sleep(50)
    }
  } finally {
    stopKeys()
  }
  // Стрела исчезает из мира раньше, чем сервер пришлёт слот рюкзака, — чуть
  // подождать, иначе подобранное считается нулём.
  for (let i = 0; i < 6 && arrowCount(bot) === before && moved; i++) await sleep(50)
  const got = Math.max(0, arrowCount(bot) - before)
  return { got, moved, why, ms: gameClock.now() - t0 }
}

module.exports = { track, plan, collect, pickable, arrowCount, hasRoom }
