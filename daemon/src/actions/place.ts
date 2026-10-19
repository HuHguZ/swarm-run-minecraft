'use strict'
// Постановка блока (place), ниша, память своих блоков (верстак, поставленный ботом, уходит с ним).
// ---------------------------------------------------------------- place
import { posKey } from './gather'
const gameClock: typeof import('../game-clock') = require('../game-clock')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const { sleep, xyz }: typeof import('../movement') = require('../movement')
const { equipBestTool, itemNamed }: typeof import('../items') = require('../items')
const { withTimeout, placeBlockAt }: typeof import('../build') = require('../build')
// Куда ставят блок: клетка пустая или заменимая (canBeReplaced: трава,
// папоротник, снег, лоза, корни Ада — растения из REPLACEABLE_BY_TREES
// без цветов; цветы, саженцы и факел заменимыми не бывают).
const PLACE_INTO = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|seagrass|tall_seagrass|leaf_litter|vine|glow_lichen|light|warped_roots|nether_sprouts|crimson_roots|hanging_roots|bush|firefly_bush|short_dry_grass|tall_dry_grass)$/
// Не заменимое, но ломается мгновенно (прочность 0: цветы, саженцы, факел) —
// сорвать и поставить, как игрок. Огонь и порталы — нет.
const clearable = b => !!b && b.boundingBox === 'empty' && b.hardness === 0 && !/fire|portal|water|lava|bubble/.test(b.name)
// Опоры, клик по которым — действие (окно, сон, дверь), а не постановка.
const CLICKABLE = /furnace|smoker|chest|barrel|crafting_table|crafter|_bed$|anvil|shulker|enchanting_table|brewing_stand|hopper|dispenser|dropper|lectern|loom|grindstone|stonecutter|smithing_table|cartography_table|fletching_table|note_block|jukebox|_door$|_trapdoor$|_button$|lever|beacon|bell|composter|repeater|comparator|daylight_detector|cake|_sign$|_fence_gate$/

async function place (session, ctl, { block: name, at = null }: any = {}) {
  const bot = session.bot
  const item = itemNamed(bot, name)
  if (!item) throw new Error(`нет ${name} в инвентаре`)

  if (at) {
    if (!['x', 'y', 'z'].every(k => Number.isInteger(at[k]))) throw new Error('at: нужны целые координаты x,y,z')
    const pos = new Vec3(at.x, at.y, at.z)
    if (pos.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) > 4.5) {
      throw new Error('названная клетка слишком далеко — сначала подойди')
    }
    if (ctl.aborted) return { stopped: 'прервано' }
    const r = await placeBlockAt(bot, pos, { item: item.name, honest: true })
    if (!r.ok) throw new Error(`не поставил ${name} на ${pos.x},${pos.y},${pos.z}: ${r.reason}`)
    return { placed: !r.already, block: r.already || name, at: xyz(pos) }
  }

  const feet = bot.entity.position.floored()
  const head = feet.offset(0, 1, 0)
  // Опора — на два уровня вниз, а не на один: на подъёме лесенкой пустые
  // ступени позади лежат НИЖЕ ног (клетка ног прошлой ступени — feet-1), и
  // прежний перебор dy -1..1 не видел ни одной. Кампания 2026-09-26: кирка
  // стёрлась на подъёме с y=16, «некуда поставить crafting_table — вокруг нет
  // свободной опоры» при 212 булыжника и 7 палках, и тело встало насовсем.
  const collect = () => {
    const out = []
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dy = -2; dy <= 1; dy++) {
          const p = feet.offset(dx, dy, dz)
          const target = p.offset(0, 1, 0)
          // Never place into our own hitbox.
          if (target.equals(feet) || target.equals(head)) continue
          const ref = bot.blockAt(p)
          const above = bot.blockAt(target)
          if (!ref || !above) continue
          if (ref.boundingBox !== 'block' || above.boundingBox !== 'empty') continue
          if (/water|lava/.test(above.name)) continue
          // Над опорой — воздух или трава: в клетку с факелом блок не встаёт
          // (у факела рамка пустая, но клетка занята). И опора — не печь,
          // сундук, верстак: клик по ним открывает окно, а блок не ставится.
          // 2026-09-26, штрек: два факела на полу и печь — восемь попыток
          // верстака «blockUpdate did not fire», и ни ведра, ни щита из 17
          // слитков.
          // Цветы у леса — не заменимы, а белый список без них оставил тело
          // без верстака на поляне: «некуда поставить crafting_table» и ночь
          // на 1 хп в яме без кирки (2026-09-26, 13:29). Такие — сорвать.
          const free = PLACE_INTO.test(above.name)
          if (!free && !clearable(above)) continue
          if (CLICKABLE.test(ref.name)) continue
          out.push({ ref, dist: p.distanceTo(feet) + (free ? 0 : 0.5), clear: free ? null : above })
        }
      }
    }
    return out.sort((a, b) => a.dist - b.dist)
  }
  let candidates = collect()
  // Совсем тесно (колодец, штрек без хвоста) — как игрок: вырубить нишу в
  // стене на уровне головы и поставить туда.
  if (!candidates.length && await digNiche(bot, ctl, feet)) candidates = collect()
  if (!candidates.length) {
    // Стою на столбе или узком уступе: сверху ни одной свободной опоры, но у
    // блока под ногами есть бока — поставить сбоку, к его грани (как игрок,
    // присев на краю). Кампания 2026-09-26: на столбе в небе стёрлась кирка, а
    // верстак ставить было «некуда» — и спуститься стало нечем.
    const { placeBlockAt }: typeof import('../build') = require('../build')
    const under = feet.offset(0, -1, 0)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (ctl.aborted) break
      const p = under.offset(dx, 0, dz)
      const b = bot.blockAt(p)
      if (!b || b.boundingBox !== 'empty' || /water|lava/.test(b.name)) continue
      const r = await placeBlockAt(bot, p, { item: name })
      if (r.ok) {
        rememberOwnBlock(session, name, p)
        return { placed: name, at: xyz(p), side: true }
      }
    }
    throw new Error(`некуда поставить ${name} — вокруг нет свободной опоры`)
  }

  await bot.equip(item, 'hand')
  let last = null
  for (const c of candidates.slice(0, 8)) {
    if (ctl.aborted) break
    try {
      if (c.clear) {
        try { await withTimeout(bot.dig(c.clear, true), 3000, 'не сорвать') } catch {}
        await sleep(100)
        await bot.equip(item, 'hand')
      }
      await bot.lookAt(c.ref.position.offset(0.5, 1.2, 0.5), true)
      await bot.placeBlock(c.ref, new Vec3(0, 1, 0))
      const at = c.ref.position.offset(0, 1, 0)
      rememberOwnBlock(session, name, at)
      return { placed: name, at: xyz(at) }
    } catch (e) {
      last = e
    }
  }
  throw new Error(`не смог поставить ${name}${last ? ': ' + last.message : ''}`)
}

// Ниша под блок: одна клетка сбоку на уровне головы, под ней остаётся опора
// (клетка сбоку на уровне ног). Не вскрываем жидкость и пустоту за стеной:
// вода или лава за нишей — это потоп в штрек; бедрок и обсидиан не рубим.
async function digNiche (bot, ctl, feet) {
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [dx, dz] of sides) {
    if (ctl.aborted) return false
    const cell = feet.offset(dx, 1, dz)
    const support = bot.blockAt(feet.offset(dx, 0, dz))
    const b = bot.blockAt(cell)
    if (!b || !support || support.boundingBox !== 'block' || b.boundingBox !== 'block') continue
    if (/bedrock|obsidian|chest|furnace|crafting_table|barrel|spawner/.test(b.name)) continue
    const around = [cell.offset(0, 1, 0), cell.offset(dx, 0, dz), cell.offset(dz, 0, dx), cell.offset(-dz, 0, -dx)]
    if (around.some(p => { const n = bot.blockAt(p); return !n || /water|lava/.test(n.name) })) continue
    try {
      await equipBestTool(bot, b)
      await withTimeout(bot.dig(b, true), 8000, 'не копается')
      return true
    } catch {}
  }
  return false
}

// ---------------------------------------------------------------- own blocks

// A crafting table costs four planks and, at depth, the climb home: the run of
// 2026-08-31 stood one up at y=-59, crafted a pickaxe on it, walked forty
// blocks on and later refused the next pickaxe with «нужен верстак, а его нет
// ни рядом, ни в инвентаре». So a table the bot stood up has to leave with the
// body.
//
// A table found already standing does not: on a shared server breaking someone
// else's furniture is theft, and the block itself cannot tell the two cases
// apart. The only honest witness is our own memory of having placed it, so
// that is what is kept here — every place() goes through this, including the
// autopilot's tableUnderfoot, which places through the same function.
const OWN_BLOCKS_KEPT = 24
// Recent, not forever: «я его поставил в этом крафте» is the licence, and two
// minutes covers place → craft → pick up with room for a 90s craft intent. A
// table standing on that square an hour later is part of the world again.
const OWN_BLOCK_TTL_MS = 120000

function rememberOwnBlock (session, name, pos) {
  if (name !== 'crafting_table') return
  if (!session.ownBlocks) session.ownBlocks = new Map()
  session.ownBlocks.delete(posKey(pos)) // re-insert so the eviction order is age
  session.ownBlocks.set(posKey(pos), gameClock.now())
  while (session.ownBlocks.size > OWN_BLOCKS_KEPT) {
    session.ownBlocks.delete(session.ownBlocks.keys().next().value)
  }
}

function isOwnBlock (session, pos) {
  const at = session.ownBlocks && session.ownBlocks.get(posKey(pos))
  return !!at && gameClock.now() - at < OWN_BLOCK_TTL_MS
}

function forgetOwnBlock (session, pos) {
  if (session.ownBlocks) session.ownBlocks.delete(posKey(pos))
}

export { place, rememberOwnBlock, isOwnBlock, forgetOwnBlock }
