'use strict'
const Vec3 = require('vec3')
// Slot numbers live in exactly one place. Three copies of 5..8 and 45 is the
// way they eventually disagree, and armor.js is the file that already has to
// know them. No import cycle: perception -> armor -> movement, and movement
// knows nothing about perception.
const { readWorn, readOffHand, defenseOf } = require('./armor')

// Blocks worth reporting. Everything else is terrain noise and only shows up
// in the coarse summary.
const INTERESTING = [
  /_ore$/, /^ancient_debris$/, /_log$/, /_wood$/, /^bamboo$/,
  /^chest$/, /^trapped_chest$/, /^barrel$/, /^ender_chest$/, /^shulker_box$/,
  /^crafting_table$/, /^furnace$/, /^blast_furnace$/, /^smoker$/, /^anvil$/,
  /^enchanting_table$/, /^brewing_stand$/, /^cauldron$/, /^smithing_table$/,
  /_bed$/, /^water$/, /^lava$/, /^obsidian$/, /^crying_obsidian$/,
  /^spawner$/, /^nether_portal$/, /^end_portal/, /^end_stone$/,
  /^torch$/, /^campfire$/, /^bookshelf$/, /^glowstone$/, /^sea_lantern$/,
  /^melon$/,
  // S8c 07.10: гравий на виду (кремень вслепую — берег, склон, пещера; осмотр маршрута на 96 бл.)
  /^gravel$/
]

function interestingIds (mcData) {
  return (Object.values(mcData.blocksByName) as any[])
    .filter((b : any) => INTERESTING.some(re => re.test(b.name)))
    .map((b : any) => b.id)
}

function eyePos (bot) {
  return bot.entity.position.offset(0, bot.entity.height || 1.62, 0)
}

// Is there a clear line between two arbitrary points? Taking `from` as an
// argument rather than always using our own eyes is what lets combat ask the
// question that actually matters when a skeleton is shooting: "if I stood
// over THERE, would it still see me?"
function raySees (bot, from, target) {
  try {
    const delta = target.minus(from)
    const dist = delta.norm()
    if (dist < 0.1) return true
    const hit = bot.world.raycast(from, delta.normalize(), Math.min(dist, 96),
      b => b && b.boundingBox !== 'empty')
    if (!hit) return true
    // The ray stops on the block the target is standing in as often as on real
    // cover, so anything within a block of the target still counts as visible.
    return hit.position.distanceTo(from) >= dist - 1.2
  } catch {
    // A raycast that throws must not be read as "safe here" - but it must not
    // freeze the bot either. Assume seen: the cautious answer.
    return true
  }
}

// Line of sight from our own eyes. Used for entities; blocks have
// bot.canSeeBlock() which does the same thing more precisely.
function canSeePoint (bot, target) {
  return raySees(bot, eyePos(bot), target)
}

// On 1.21 the biome carried by a block is often just a registry id with no
// name attached, so fall back to the registry the bot already loaded.
function biomeName (bot, pos) {
  try {
    const block = bot.blockAt(pos)
    if (!block || !block.biome) return null
    if (block.biome.name) return block.biome.name
    const reg = bot.registry && bot.registry.biomes
    const entry = reg && reg[block.biome.id]
    if (entry && entry.name) return entry.name
    return `biome#${block.biome.id}`
  } catch {
    return null
  }
}

// Floor, matching movement.xyz and the game's own F3 readout: the block an
// entity occupies, not the nearest block centre.
function round (v) {
  return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) }
}

// Погода — по уровням дождя и грозы, как у клиента игры (2026-09-26):
// world/level/Level.java 1.21.11 — isRaining = canHaveWeather && rainLevel >
// 0.2, isThundering = canHaveWeather && thunderLevel > 0.9; canHaveWeather —
// небо без потолка и не Энд. Уровни сервер шлёт каждый тик, пока они меняются
// (ServerLevel.advanceWeatherCycle: RAIN_LEVEL_CHANGE, THUNDER_LEVEL_CHANGE), и
// при входе (PlayerList.sendLevelInfo); mineflayer кладёт их в bot.rainState и
// bot.thunderState. Флаг bot.isRaining (rain.js, события START/STOP_RAINING)
// на Paper вывернут: замер на тестовом Paper 1.21.11 — на /weather rain
// уровень дорос до 0.19, и пришёл STOP_RAINING (id 2): флаг остался false и
// встал бы true, когда дождь кончится. Флаг чиним по уровню — его читает и сам
// mineflayer (bed.js: «спать днём можно только в грозу»).
function weatherPossible (bot) {
  const d = String((bot.game && bot.game.dimension) || 'overworld')
  return !/nether|end$/.test(d)
}
function syncRainFlag (bot) {
  if (!bot || !bot._client) return
  if (!bot._ndRainFix) {
    bot._ndRainFix = true
    // После обработчика mineflayer (он подписан раньше) — флаг по уровню.
    try { bot._client.on('game_state_change', () => { try { bot.isRaining = weatherPossible(bot) && (bot.rainState || 0) > 0.2 } catch {} }) } catch {}
  }
  try { bot.isRaining = weatherPossible(bot) && (bot.rainState || 0) > 0.2 } catch {}
}
function raining (bot) {
  syncRainFlag(bot)
  return weatherPossible(bot) && (bot.rainState || 0) > 0.2
}
function thundering (bot) {
  syncRainFlag(bot)
  return weatherPossible(bot) && (bot.thunderState || 0) > 0.9
}

function timeLabel (bot) {
  const t = bot.time ? bot.time.timeOfDay : 0
  if (t < 1000) return 'рассвет'
  if (t < 11000) return 'день'
  if (t < 13000) return 'закат'
  if (t < 23000) return 'ночь'
  return 'рассвет'
}

// Compact header attached to every tool result so the brain never has to ask
// "where am I" as a separate round trip.
function stateSummary (bot, extra: any = {}) {
  if (!bot || !bot.entity) return { connected: false, ...extra }
  const p = bot.entity.position
  const biome = biomeName(bot, p)
  const held = bot.heldItem ? bot.heldItem.name : null
  const items: any = {}
  const bag = bot.inventory.items()
  for (const it of bag) items[it.name] = (items[it.name] || 0) + it.count
  const off = bot.inventory.slots?.[45]
  if (off && bot.registry?.foodsByName?.[off.name] && !/_bucket$/.test(off.name) &&
      !bag.some(it => it === off || it.slot === 45)) items[off.name] = (items[off.name] || 0) + off.count
  const wornNow = readWorn(bot)
  const worn = {
    head: wornNow.head ? wornNow.head.item : null,
    torso: wornNow.torso ? wornNow.torso.item : null,
    legs: wornNow.legs ? wornNow.legs.item : null,
    feet: wornNow.feet ? wornNow.feet.item : null
  }
  return {
    connected: true,
    pos: round(p),
    dimension: bot.game ? bot.game.dimension : null,
    biome,
    // Живой с 0.24 хп — не «0»: арена (where) читала 0 как смерть и обрывала раунд (S7d, s7d-p-27 р.3 swap).
    health: (bot.health ?? 0) > 0 ? Math.max(1, Math.round(bot.health)) : 0,
    food: Math.round(bot.food ?? 0),
    fireResistance: require('./blaze').hasEffect(bot, 'fire_resistance'),
    time: timeLabel(bot),
    isRaining: raining(bot),
    held,
    // Spendable inventory is the bag plus edible food in the second hand.
    // Worn gear stays separate: surplusPlan, craftPlan and plankReserve work this
    // way, so worn gear must NOT be folded into it. But leaving it out
    // entirely meant the brain never knew whether the bot was dressed, while
    // the autopilot re-dressed it every fifteen seconds and said nothing.
    armor: worn,
    defense: defenseOf(wornNow),
    offHand: readOffHand(bot),
    inventory: items,
    // Зелья в рюкзаке — по действию, а не «potion×3»: кампании нужно знать,
    // сколько огнестойкости (бартер бастиона → блейзы), а вода из бартера — тоже
    // «potion». Поле есть, только если зелья есть.
    ...(items.potion || items.splash_potion ? { potions: potionsSummary(bot) } : {}),
    playersOnline: Object.keys(bot.players).filter(n => n !== bot.username),
    ...extra
  }
}

function potionsSummary (bot) {
  const out = {}
  try {
    const { potionOf } = require('./pvp')
    for (const it of bot.inventory.items()) {
      if (!/potion$/.test(it.name)) continue
      const k = (it.name === 'splash_potion' ? 'splash_' : '') + (potionOf(it) || 'unknown')
      out[k] = (out[k] || 0) + it.count
    }
  } catch {}
  return out
}

// Fog-of-war view of the surroundings.
function observe (bot, mcData, { radius = 24, fair = true, maxBlocks = 300 }: any = {}) {
  const out: any = { radius, fair, entities: [], blocks: [], terrain: {} }
  if (!bot || !bot.entity) return out
  const me = bot.entity.position

  // --- entities ---
  for (const ent of ((Object.values(bot.entities) as any[]) as any)) {
    if (!ent || ent === bot.entity || !ent.position) continue
    const dist = ent.position.distanceTo(me)
    if (dist > radius) continue
    if (fair && !canSeePoint(bot, ent.position.offset(0, (ent.height || 1) * 0.6, 0))) continue
    out.entities.push({
      name: ent.username || ent.displayName || ent.name,
      kind: ent.type,
      dist: Math.round(dist * 10) / 10,
      pos: round(ent.position),
      // `pos` is floored on purpose — it has to match F3 and /setblock. But a
      // floored pair cannot answer «в какой стороне от меня это лежит»: the
      // difference of two truncated coordinates wobbles by a whole block, which
      // at 1.2 blocks of distance is ±40° of bearing. Measuring where a thrown
      // item lands relative to the look direction was impossible for exactly
      // this reason — the instrument could not resolve the angle it was asked
      // about. Two decimals is enough for that and cheap: entities are few.
      at: {
        x: Math.round(ent.position.x * 100) / 100,
        y: Math.round(ent.position.y * 100) / 100,
        z: Math.round(ent.position.z * 100) / 100
      }
    })
  }
  out.entities.sort((a, b) => a.dist - b.dist)

  // --- notable blocks ---
  try {
    const ids = interestingIds(mcData)
    // This is the whole fog of war: an ore buried in stone is not the first
    // block a ray from our eyes hits, so it is not reported. Отсечка по числу —
    // ПОСЛЕ зрения (sight.visibleOf): findBlocks count 300 брал ближние клетки
    // (руда в толще, вода под дном), луч отсеивал их, и видимая лава в тридцати
    // блоках до луча не доходила вовсе — та же болезнь, что у mine (2026-09-26).
    const found = require('./sight').visibleOf(bot, ids, radius, { max: maxBlocks, fair, rays: 1500 })
    const groups = new Map()
    for (const block of found) {
      if (!block) continue
      const pos = block.position
      const dist = pos.distanceTo(me)
      const g = groups.get(block.name)
      if (!g) {
        groups.set(block.name, { name: block.name, count: 1, nearest: round(pos), dist: Math.round(dist * 10) / 10 })
      } else {
        g.count++
        if (dist < g.dist) { g.dist = Math.round(dist * 10) / 10; g.nearest = round(pos) }
      }
    }
    // Память увиденного (perception/eyes, S10): что тело видело раньше и сейчас отсюда не видно — тоже «знаю», с пометкой
    // remembered и возрастом (ago, игр. с). Только при зрении (fair) и в 2·radius; ND_OBSERVE_MEM=0 — без памяти.
    if (fair && bot._ndEyes && process.env.ND_OBSERVE_MEM !== '0') {
      const re = new RegExp(INTERESTING.map(r => r.source).join('|'))
      for (const m of require('./perception/eyes').nearest(bot, re, { max: 200, maxDist: radius * 2 })) {
        if (groups.has(m.name)) { const g = groups.get(m.name); if (!g.remembered) continue }
        const g = groups.get(m.name)
        if (!g) groups.set(m.name, { name: m.name, count: 1, nearest: { x: m.x, y: m.y, z: m.z }, dist: m.dist, remembered: true, ago: m.ago })
        else { g.count++; if (m.dist < g.dist) { g.dist = m.dist; g.nearest = { x: m.x, y: m.y, z: m.z }; g.ago = m.ago } }
      }
    }
    out.blocks = Array.from(groups.values()).sort((a, b) => a.dist - b.dist)
  } catch (e) {
    out.blocksError = String(e.message || e)
  }

  // --- immediate terrain ---
  try {
    const under = bot.blockAt(me.offset(0, -1, 0))
    const ahead = bot.blockAtCursor(5)
    out.terrain = {
      standingOn: under ? under.name : null,
      lookingAt: ahead ? { name: ahead.name, pos: round(ahead.position) } : null,
      y: Math.round(me.y)
    }
  } catch {}

  return out
}

module.exports = { observe, stateSummary, canSeePoint, raySees, eyePos, timeLabel, biomeName, raining, thundering, Vec3 }
