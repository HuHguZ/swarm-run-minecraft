'use strict'
// Сундуки, которые бот видит. Игрок, заметивший сундук в данже или шахте,
// идёт и забирает — а бот проходил мимо. Но сундук у чужого дома — это не
// лут, а кража, и бот не имеет права её совершать молча. Поэтому:
//
//   * сундук, рядом с которым видно постройку игры (спавнер и замшелый
//     булыжник — данж, рельсы и паутина — шахта, TNT и песчаник — пустынный
//     храм, колокол — деревня, крайний обсидиан — руины портала...), —
//     «лут»: автопилот заберёт его сам, когда вокруг спокойно;
//   * всё остальное — «чей-то сундук»: только событие для мозга, трогать
//     решает он (и спросит человека).
//
// Вагонетка с сундуком — всегда шахта, это лут.
// Взятые сундуки записываются в память (state.looted), второй раз не зовут.

const Vec3 = require('vec3')
const { xyz } = require('./movement')
const { raySees } = require('./perception')
const structures = require('./structures')

const CONTAINERS = ['chest', 'trapped_chest', 'barrel']

const HINTS = [
  { guess: 'данж', near: ['spawner', 'mossy_cobblestone'], r: 7 },
  { guess: 'заброшенная шахта', near: ['rail', 'cobweb'], r: 6, both: true },
  { guess: 'пустынный храм', near: ['tnt', 'chiseled_sandstone', 'orange_terracotta', 'blue_terracotta'], r: 10 },
  { guess: 'храм в джунглях', near: ['tripwire_hook', 'tripwire', 'chiseled_stone_bricks'], r: 10 },
  { guess: 'деревня', near: ['bell'], r: 32 },
  { guess: 'руины портала', near: ['crying_obsidian'], r: 10 },
  { guess: 'крепость Энда', near: ['end_portal_frame', 'infested_stone_bricks'], r: 24 },
  { guess: 'крепость Незера', near: ['nether_bricks', 'nether_brick_fence'], r: 8, both: true },
  { guess: 'бастион', near: ['gilded_blackstone', 'polished_blackstone_bricks'], r: 10 },
  { guess: 'затонувший корабль', near: ['stripped_spruce_log', 'spruce_trapdoor'], r: 6, wet: true },
  { guess: 'подводные руины', near: ['suspicious_gravel', 'mossy_stone_bricks'], r: 8, wet: true },
  { guess: 'иглу', near: ['white_carpet', 'snow_block'], r: 6, both: true },
  { guess: 'аванпост', near: ['dark_oak_log', 'birch_planks', 'dark_oak_planks'], r: 8, both: true },
  { guess: 'древний город', near: ['sculk', 'reinforced_deepslate'], r: 16 },
  { guess: 'испытательная камера', near: ['trial_spawner', 'vault'], r: 16 }
]

function keyOf (p) { return `${p.x},${p.y},${p.z}` }

function lootedSet (session) {
  const s = session.journal.state
  if (!s.looted) s.looted = []
  return new Set(s.looted)
}

// Что за место вокруг: ищем подсказки в радиусе. both — нужны все имена.
function guessStructure (bot, pos) {
  for (const h of HINTS) {
    const found = new Set()
    for (const name of h.near) {
      const b = bot.registry.blocksByName[name]
      if (!b) continue
      const hit = bot.findBlock({ matching: b.id, maxDistance: h.r, point: pos, count: 1 })
      if (hit) found.add(name)
    }
    if (h.both ? found.size >= Math.min(2, h.near.length) : found.size > 0) {
      if (h.wet) {
        const w = bot.registry.blocksByName.water
        if (!w || !bot.findBlock({ matching: w.id, maxDistance: 4, point: pos })) continue
      }
      return h.guess
    }
  }
  return null
}

// Сундук рядом с тем, что строит игрок (верстак, печь, кровать, факел у самого
// сундука), — чей-то. Используется, только если постройку игры не опознали.
function lookOwned (bot, pos) {
  for (const name of ['crafting_table', 'furnace', 'white_bed', 'red_bed', 'torch', 'wall_torch', 'lantern']) {
    const b = bot.registry.blocksByName[name]
    if (!b) continue
    if (bot.findBlock({ matching: b.id, maxDistance: 4, point: pos })) return true
  }
  return false
}

// Рядом с местами из памяти (база, дом) — точно не лут. Места-постройки
// (крепость, бастион, спавнер блейзов — их пишут разведчики) — не база, и
// место в другом измерении — тоже: раньше сундук крепости Ада рядом с
// записью «крепость (ад)» считался «рядом с нашей базой».
function nearKnownPlace (session, pos) {
  const places = (session.journal.state && session.journal.state.places) || {}
  const skip = require('./structures').STRUCTURE_PLACES
  const bot = session.bot
  const here = String((bot && bot.game && bot.game.dimension) || 'overworld').replace(/^minecraft:/, '')
  for (const [name, p] of ((Object.entries(places) as [string, any][]) as any)) {
    if (!p || typeof p.x !== 'number' || skip.has(name)) continue
    if ((p.dimension || 'overworld') !== here) continue
    if (Math.hypot(p.x - pos.x, p.z - pos.z) < 24 && Math.abs((p.y ?? pos.y) - pos.y) < 16) return true
  }
  return false
}

// Что видно сейчас: сундуки и вагонетки с сундуком в radius, которых ещё не
// брали. Каждому — догадка, что это за место, и вердикт lootable.
function seen (session, { radius = 20 }: any = {}) {
  const bot = session.bot
  const me = bot.entity.position
  const eye = me.offset(0, 1.62, 0)
  const done = lootedSet(session)
  const ids = CONTAINERS.map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
  const out = []
  const blocks = bot.findBlocks({ matching: ids, maxDistance: radius, count: 24 })
  for (const p of blocks) {
    if (done.has(keyOf(p))) continue
    const center = p.offset(0.5, 0.5, 0.5)
    if (center.distanceTo(eye) > 5 && !raySees(bot, eye, center)) continue
    const block = bot.blockAt(p)
    // Постройка, опознанная глазами (structures.js), — главнее догадки по соседям.
    const rec = structures.recordedAt(session, p)
    const guess = (rec && structures.KINDS[rec.kind].ru) || guessStructure(bot, p)
    const mine = nearKnownPlace(session, p)
    const marks = structures.playerMarks(bot, p, rec ? rec.kind : null)
    const owned = !guess && lookOwned(bot, p)
    out.push({
      at: xyz(p),
      kind: block ? block.name : 'chest',
      guess: guess || undefined,
      structure: rec ? rec.kind : undefined,
      lootable: !!guess && !mine && !marks.length,
      why: mine ? 'рядом с нашей базой' : marks.length ? `поставил игрок? ${marks.join(', ')}` : guess ? `похоже на ${guess}` : owned ? 'рядом верстак/печь/кровать — чей-то' : 'откуда — непонятно',
      dist: Math.round(center.distanceTo(me))
    })
  }
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || e.name !== 'chest_minecart' || !e.position) continue
    if (e.position.distanceTo(me) > radius) continue
    const k = `cart:${e.id}`
    if (done.has(k)) continue
    out.push({ at: xyz(e.position), kind: 'chest_minecart', entityId: e.id, guess: 'заброшенная шахта', lootable: true, why: 'вагонетка с сундуком — шахта', dist: Math.round(e.position.distanceTo(me)) })
  }
  return out.sort((a, b) => a.dist - b.dist)
}

function markLooted (session, key) {
  session.journal.patch(s => {
    if (!s.looted) s.looted = []
    if (!s.looted.includes(key)) s.looted.push(key)
    if (s.looted.length > 500) s.looted.splice(0, s.looted.length - 500)
  })
}

// Забрать всё из сундука или вагонетки. force — разрешить «чей-то» сундук
// (только по решению мозга).
async function loot (session, ctl, { x, y, z, entityId, force = false }: any = {}) {
  const bot = session.bot
  let target = null
  if (entityId !== undefined || (x === undefined && z === undefined)) {
    const all = seen(session, { radius: 24 })
    target = entityId !== undefined ? all.find(s => s.entityId === entityId) : (force ? all[0] : all.find(s => s.lootable))
    if (!target) return { stopped: 'лутать нечего: сундуков с постройками игры рядом не вижу', seen: all.slice(0, 5) }
  } else {
    const p = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
    const rec = structures.recordedAt(session, p)
    const guess = (rec && structures.KINDS[rec.kind].ru) || guessStructure(bot, p)
    const marks = structures.playerMarks(bot, p, rec ? rec.kind : null)
    target = { at: xyz(p), kind: (bot.blockAt(p) || {}).name, guess, structure: rec ? rec.kind : undefined, lootable: !!guess && !nearKnownPlace(session, p) && !marks.length, why: marks.length ? `поставил игрок? ${marks.join(', ')}` : undefined }
  }
  if (!target.lootable && !force) {
    return { stopped: `не трогаю: ${target.why || 'не похоже на постройку игры'} — если это правда лут, зови с force:true`, target }
  }

  // Берём ценное по structures.decide (с «зачем»), хлам оставляем в сундуке;
  // ловушки (плита, нить) pathfinder обходит. Храм и бастион — через
  // mc_structure explore: там сначала обезвредить.
  if (target.kind === 'chest_minecart') {
    const cart = bot.entities[target.entityId]
    if (!cart) return { stopped: 'вагонетка пропала', target }
    structures.armTraps(session)
    const r = await structures.takeCart(session, ctl, cart)
    session.journal.append('лут', `вагонетка в шахте: ${(Object.entries(r.took || {}) as [string, any][]).map(([k, v]) => `${k}×${v}`).join(', ') || 'пусто'}`, bot.entity.position)
    return { looted: 'вагонетка с сундуком', guess: target.guess, took: r.took, why: r.why, junkLeft: r.left, stopped: r.stopped }
  }

  const r = await structures.takeWorth(session, ctl, target.at, { kind: target.structure })
  if (!r.stopped || Object.keys(r.took || {}).length) markLooted(session, keyOf(target.at))
  return { looted: target.kind, guess: target.guess, at: target.at, took: r.took || {}, why: r.why, junkLeft: r.left, left: r.notTaken, stopped: r.stopped }
}

module.exports = { seen, loot, guessStructure, markLooted }
