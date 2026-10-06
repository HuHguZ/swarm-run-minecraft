'use strict'
// Рюкзак полон, а под ногами лежит то, за чем шли. Живой игрок в этот момент
// думает: что у меня самое дешёвое — выкинуть; нечего выкинуть — поставить
// сундук и оставить схрон, а не бросить алмаз в шахте. До этого файла тело
// молча проходило мимо дропа: mineflayer не подбирает в полный рюкзак, а
// collectNearbyDrops считал «подошёл» за «подобрал».
//
// Цена предмета — эвристика, не механика игры: 0 хлам, 1 обиходное,
// 2 материал, 3 ценность. Снаряжение (инструменты, броня, вёдра, огниво) не
// выбрасывается никогда, запас из containers.js KEEP (булыжник 64, еда 16,
// факелы 32...) — тоже: выбрасывается только сверх него.

// Лениво: containers.js тянет actions.js, а actions.js — этот файл.
const keepFor = (name) => require('./containers').keepFor(name)

const JUNK = /^(dirt|coarse_dirt|rooted_dirt|gravel|sand|red_sand|granite|diorite|andesite|tuff|calcite|dripstone_block|pointed_dripstone|rotten_flesh|poisonous_potato|wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds|[a-z_]+_sapling|dandelion|poppy|[a-z_]*tulip|oxeye_daisy|cornflower|azure_bluet|allium|blue_orchid|kelp|seagrass|short_grass|fern|dead_bush|spider_eye|ink_sac|clay_ball|snowball|egg|moss_block|moss_carpet|glow_lichen|hanging_roots|cobweb|wildflowers|pink_petals|leaf_litter|bush|firefly_bush|short_dry_grass|tall_dry_grass|cactus_flower|bone_meal)$/
const COMMON = /^(cobblestone|cobbled_deepslate|netherrack|blackstone|basalt|smooth_basalt|deepslate|stone|end_stone|soul_sand|soul_soil|[a-z_]+_planks|[a-z_]+_log|[a-z_]+_wood|glass|torch|coal|charcoal|bread|apple|[a-z_]*wool|[a-z_]+_bed|stick|string|bone|leather|feather|flint)$/
const VALUE = /^(diamond|emerald|netherite_[a-z_]+|ancient_debris|obsidian|crying_obsidian|blaze_rod|blaze_powder|ender_pearl|ender_eye|golden_apple|enchanted_golden_apple|totem_of_undying|nether_star|elytra|dragon_egg|shulker_shell|experience_bottle|[a-z_]*diamond[a-z_]*|nether_wart|ghast_tear|potion|splash_potion|fire_charge|magma_cream|gold_block|golden_carrot|spectral_arrow)$/
// Снаряжение: не выбрасывается ни при какой нужде.
const GEAR = /_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots)$|^(shield|bow|crossbow|trident|flint_and_steel|shears|fishing_rod|bucket|water_bucket|lava_bucket|clock|compass|map|filled_map|elytra|totem_of_undying|crafting_table)$/

// Аварийный запас (research/05-synthesis.md F.5, «Аварийный запас»): без
// блоков нет коробки аварийного отхода (survival.refuge), без кирки — ни норы,
// ни выхода из своей же коробки, без еды нечем лечиться внутри. Любая
// разгрузка здесь (tidy, makeRoom) не опускает эти три ниже запаса — яма
// бастиона уже раз выкинула камень, на котором держались и кирки, и укрытие.
// build — штук блоков стройки (BUILD), pickaxe — кирок, food — кусков еды.
const RESERVE = Object.freeze({ build: 16, pickaxe: 1, food: 2 })
// Блоки стройки: наполнители build.js (FILLER и FILLER_NETHER) и доски — то,
// что pickFiller берёт на стены. Песка, гравия и песка душ нет: крыша из них
// падает на голову, а песок душ не целый блок.
const BUILD_OVER = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt']
const BUILD_NETHER = ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'polished_blackstone', 'end_stone', 'mossy_cobblestone', 'soul_soil', 'warped_wart_block', 'nether_wart_block']
const isBuild = (name, dim = null) => /_planks$/.test(name) || BUILD_OVER.includes(name) ||
  (dim !== 'overworld' && dim !== 'the_end' && BUILD_NETHER.includes(name))
// Еда в запас — то, что лечит, а не травит (combat-safety RISKY).
const RISKY_FOOD = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chicken|suspicious_stew)$/
const FOOD_NAMES = /^(cooked_[a-z_]+|bread|baked_potato|golden_carrot|apple|carrot|potato|sweet_berries|glow_berries|melon_slice|pumpkin_pie|golden_apple|enchanted_golden_apple|mushroom_stew|beetroot_soup|beetroot|rabbit_stew|dried_kelp|cookie|honey_bottle|beef|porkchop|mutton|rabbit|cod|salmon)$/
function isFood (bot, name) {
  if (RISKY_FOOD.test(name) || /_bucket$/.test(name)) return false
  const foods = bot && bot.registry && bot.registry.foodsByName
  return foods ? !!foods[name] : FOOD_NAMES.test(name)
}
function reserveKind (bot, name) {
  if (isBuild(name)) return 'build'
  if (/_pickaxe$/.test(name)) return 'pickaxe'
  if (isFood(bot, name)) return 'food'
  return null
}
// Сколько в рюкзаке блоков стройки. dim — какие из них возьмёт pickFiller в
// этом измерении (кирпич бастиона — только в Аду, build.js FILLER_NETHER).
function buildCount (bot, dim = null) {
  return bot.inventory.items().filter(i => isBuild(i.name, dim)).reduce((n, i) => n + i.count, 0)
}
function reserveLeft (bot, inventory = bot.inventory) {
  const left = { build: 0, pickaxe: 0, food: 0 }
  for (const it of inventory.items()) {
    const k = reserveKind(bot, it.name)
    if (k) left[k] += it.count
  }
  return left
}

// Флинт и перья — хлам, пока нет лука; палки и нитки — пока их много.
function worth (name) {
  if (!name) return 1
  if (GEAR.test(name)) return 9
  if (VALUE.test(name)) return 3
  if (/raw_|_ingot$|_nugget$|redstone|lapis_lazuli|quartz|gunpowder|slime_ball|glowstone_dust|amethyst_shard|copper/.test(name)) return 2
  if (/^cooked_|^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato|carrot|baked_potato|golden_carrot)$/.test(name)) return 2
  if (JUNK.test(name)) return 0
  if (COMMON.test(name)) return 1
  return 1
}

function stackSize (bot, name) {
  const it = bot.registry.itemsByName[name]
  return it ? it.stackSize : 64
}

// Место под предмет: пустая клетка или неполная стопка того же.
function fits (bot, name, count = 1) {
  if (bot.inventory.emptySlotCount() > 0) return true
  if (!name) return false
  const size = stackSize(bot, name)
  let room = 0
  for (const it of bot.inventory.items()) if (it.name === name) room += size - it.count
  return room >= count
}

function outputSlots (bot, name, count = 1) {
  const size = stackSize(bot, name)
  const partial = bot.inventory.items().filter(it => it.name === name)
    .reduce((n, it) => n + Math.max(0, size - it.count), 0)
  return Math.ceil(Math.max(0, count - partial) / size)
}

// Collection should not deliberately walk back to discarded clutter on the
// next action. The server can still pick it up if a necessary route crosses
// the pile; full prevention needs a stash/disposal location.
function ignoreDrop (bot, entity) {
  if (bot.ndPlayPolicy?.mode !== 'speedrun') return false
  let item
  try { item = entity.getDroppedItem() } catch { return false }
  if (!item) return false
  // Аварийный запас не добран — земля под ногами не хлам.
  if (isBuild(item.name) && buildCount(bot) < RESERVE.build) return false
  if (worth(item.name) === 0 && keepFor(item.name) === 0) return true
  const cap = bot.ndInventoryCaps?.[item.name]
  if (cap === undefined) return false
  const count = bot.inventory.items().filter(i => i.name === item.name).reduce((n, i) => n + i.count, 0)
  return count >= cap
}

// Кандидаты на выброс: всё, что сверх запаса, от самого дешёвого. Целиком
// стопками — полстопки клетку не освобождает.
// reserve — остаток аварийного запаса (reserveLeft), общий с вызывающим: tidy
// считает по нему и свой список also.
function tossPlan (bot, { below = Infinity, reserve = null, inventory = bot.inventory, preserve = null }: any = {}) {
  const counts = {}
  for (const it of inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count
  const out = []
  const kept = {}
  const left0 = reserve || reserveLeft(bot, inventory)
  const stacks = inventory.items().slice().sort((a, b) => a.count - b.count)
  for (const it of stacks) {
    if (preserve?.has(it.name)) continue
    const w = worth(it.name)
    if (w >= 9 || w >= below) continue
    const cap = keepFor(it.name)
    if (cap === Infinity) continue
    // Запас держим: стопка выбрасывается, только если без неё запас цел.
    const left = (counts[it.name] || 0) - (kept[it.name] || 0) - it.count
    if (left < cap && !(w === 0 && cap === 0)) {
      kept[it.name] = (kept[it.name] || 0) + it.count
      continue
    }
    // Аварийный запас: земля и диорит — хлам, но пока из них вся коробка — нет.
    const kind = reserveKind(bot, it.name)
    if (kind && left0[kind] - it.count < RESERVE[kind]) continue
    if (kind) left0[kind] -= it.count
    counts[it.name] -= it.count
    out.push({ slot: it.slot, name: it.name, count: it.count, worth: w })
  }
  out.sort((a, b) => a.worth - b.worth || b.count - a.count)
  return out
}

// Освободить slots клеток. forItem — ради чего: выбрасывается только то, что
// дешевле него (алмаз ради булыжника не выкидывают). away — точка, от которой
// бросать (дроп летит туда, куда смотрим, и через 2 с подбирается обратно,
// если стоять над ним): бросаем в обратную сторону.
async function makeRoom (bot, { slots = 1, forItem = null, away = null, preserve = null, allowEqual = false }: any = {}) {
  const need = Math.max(0, slots - bot.inventory.emptySlotCount())
  if (need === 0) return { freed: 0, tossed: [] }
  const value = forItem ? worth(forItem) : 2
  const below = allowEqual && forItem && value <= 1 ? value + 1 : value
  const plan = tossPlan(bot, { below, preserve })
  const tossed = []
  if (away) {
    const me = bot.entity.position
    const dx = me.x - away.x
    const dz = me.z - away.z
    const n = Math.hypot(dx, dz) || 1
    try { await bot.lookAt(me.offset(dx / n * 4, 0.5, dz / n * 4), true) } catch {}
  }
  for (const s of plan) {
    if (tossed.length >= need) break
    const it = bot.inventory.slots[s.slot]
    if (!it || it.name !== s.name) continue
    try {
      await bot.tossStack(it)
      tossed.push(`${s.name}×${s.count}`)
    } catch {}
  }
  return { freed: tossed.length, tossed, short: Math.max(0, need - tossed.length) }
}

// Для мозга: сколько места и что пойдёт в выброс первым.
function status (bot) {
  const plan = tossPlan(bot, { below: 2 })
  const free = bot.inventory.emptySlotCount()
  const junk = plan.filter(p => p.worth === 0)
  return {
    free,
    full: free === 0,
    junk: junk.map(p => `${p.name}×${p.count}`),
    wouldToss: plan.slice(0, 6).map(p => `${p.name}×${p.count}`),
    text: free === 0
      ? `рюкзак полон; выкинуть можно: ${plan.slice(0, 4).map(p => `${p.name}×${p.count}`).join(', ') || 'нечего — только схрон (mc_cache)'}`
      : `свободно клеток: ${free}${junk.length ? `; хлам: ${junk.slice(0, 4).map(p => `${p.name}×${p.count}`).join(', ')}` : ''}`
  }
}

// Выбросить весь хлам сейчас (мозг: «разгрузись»). also — ещё и названное
// сверх своего числа, целыми стопками: { cobblestone: 128 }. Булыжник — не хлам
// (worth 1, запас 64), и десять его стопок ехали вниз, занимая клетки под руду
// (кампания 2026-09-26: 700 булыжника на спуске к алмазам). Бросать — только
// здесь: session.pack после броска уводит тело от дропа, а голый mc_drop стоит
// над ним, и через 2 с (задержка подбора 40 тиков) всё возвращается в рюкзак.
async function tidy (bot, { also = null }: any = {}) {
  if (also) bot.ndInventoryCaps = { ...bot.ndInventoryCaps, ...also }
  let merged = 0
  // Only merge whole compatible stacks. Never swap different NBT/components
  // or durable tools; those may have distinct enchantments and repair value.
  if (!bot.currentWindow && typeof bot.moveSlotItem === 'function') {
    const signature = it => JSON.stringify([it.type, it.metadata, it.nbt, it.components])
    for (const source of bot.inventory.items().slice()) {
      if (source.maxDurability || !bot.inventory.slots[source.slot]) continue
      const dest = bot.inventory.items().find(it => it.slot !== source.slot && !it.maxDurability &&
        signature(it) === signature(source) && it.count >= source.count && it.count + source.count <= stackSize(bot, it.name))
      if (!dest) continue
      try { await bot.moveSlotItem(source.slot, dest.slot); if (!bot.inventory.slots[source.slot]) merged++ } catch {}
    }
  }
  const reserve = reserveLeft(bot)
  const plan = tossPlan(bot, { below: 1, reserve })
  // Retire cheap exhausted tools only when the same kind has a usable spare.
  // Запасная кирка с ≥16 ударами остаётся — RESERVE.pickaxe цел.
  const tools = bot.inventory.items()
  for (const it of tools) {
    const kind = /^(wooden|stone)_(pickaxe|axe|shovel|hoe)$/.exec(it.name)?.[2]
    if (!kind || !it.maxDurability || it.maxDurability - (it.durabilityUsed || 0) > 8) continue
    if (tools.some(other => other.slot !== it.slot && other.name.endsWith(`_${kind}`) &&
      other.maxDurability && other.maxDurability - (other.durabilityUsed || 0) >= 16)) {
      plan.push({ slot: it.slot, name: it.name, count: it.count })
    }
  }
  if (also) {
    for (const [name, keep] of ((Object.entries(also) as [string, any][]) as any)) {
      let left = bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
      const stacks = bot.inventory.items().filter(i => i.name === name).sort((a, b) => a.count - b.count)
      const kind = reserveKind(bot, name)
      for (const it of stacks) {
        let count = Math.min(it.count, Math.max(0, left - keep))
        // Явный лимит кампании (also) аварийный запас тоже не пробивает.
        if (kind) count = Math.min(count, Math.max(0, reserve[kind] - RESERVE[kind]))
        if (!count) break
        if (kind) reserve[kind] -= count
        left -= count
        plan.push({ slot: it.slot, name: it.name, count, partial: count < it.count, worth: worth(it.name) })
      }
    }
  }
  const tossed = []
  const done = new Set()
  for (const s of plan) {
    if (done.has(s.slot)) continue
    done.add(s.slot)
    const it = bot.inventory.slots[s.slot]
    if (!it || it.name !== s.name) continue
    try {
      if (s.partial) await bot.toss(it.type, it.metadata, s.count)
      else await bot.tossStack(it)
      tossed.push(`${s.name}×${s.count}`)
    } catch {}
  }
  return { tossed, merged, free: bot.inventory.emptySlotCount() }
}

module.exports = { worth, fits, outputSlots, ignoreDrop, tossPlan, makeRoom, status, tidy, RESERVE, reserveKind, reserveLeft, buildCount, isBuild }
