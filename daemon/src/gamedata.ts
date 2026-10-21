'use strict'
// Поправки к данным игры, в которых minecraft-data 1.21.11 расходится с самой
// игрой. Каждая — с замером, почему.
//
// Материал блоков с требованием к уровню инструмента. У 108 блоков (все руды,
// obsidian, блоки железа/золота/алмазов, наковальни...) в blocks.json записан
// material «incorrect_for_wooden_tool» (или другого уровня) вместо
// «mineable/pickaxe». В materials.json под «incorrect_for_wooden_tool» —
// только деревянные инструменты. prismarine-block.digTime берёт множитель
// скорости из materials[block.material][heldItem] и для алмазной кирки по
// обсидиану не находит ничего — множитель 1, как у руки:
//   obsidian, diamond_pickaxe: digTime 75 с вместо 9.4 с
//   (hardness 50, скорость 8, делитель 30 — ванильная формула
//   Player.getDestroySpeed / BlockState.getDestroyProgress).
// mineflayer bot.dig ждёт ровно digTime, прежде чем послать «докопал», —
// значит, каждую руду бот копал в 6-8 раз дольше, чем игрок: алмазную руду
// железной киркой 4.5 с вместо 0.75. В ванили все эти блоки — в теге
// mineable/pickaxe (требование уровня — отдельные теги needs_*_tool, и
// harvestTools в тех же данных у всех 107 — только кирки; 108-й — crafter,
// тоже кирочный).
function fixMaterials (registry) {
  if (!registry || !registry.blocksArray || registry.__ndMaterialsFixed) return 0
  let n = 0
  for (const b of registry.blocksArray) {
    if (typeof b.material === 'string' && /^incorrect_for_/.test(b.material)) {
      b.material = 'mineable/pickaxe'
      n++
    }
  }
  registry.__ndMaterialsFixed = true
  return n
}

// Доски из любого бревна породы. В игре рецепт досок бесформенный и берёт
// тег (VanillaRecipeProvider: planksFromLog(s)(Blocks.OAK_PLANKS,
// ItemTags.OAK_LOGS, 4); бамбук — BAMBOO_BLOCKS, 2 доски), а тег — четыре вещи
// (BlockItemTagsProvider: OAK_LOGS = oak_log, oak_wood, stripped_oak_log,
// stripped_oak_wood; стебли Ада — stem, stripped_stem, hyphae, stripped_hyphae;
// бамбук — bamboo_block, stripped_bamboo_block). Код — extracted_minecraft_data
// client1.21.11. В minecraft-data 1.21.11 у oak_planks один вариант — oak_log
// (замер 2026-09-26): ободранное бревно для крафта не существовало, и на
// глубине «не из чего верстак» с бревном в рюкзаке.
const PLANK_WOODS = {
  oak: 'log', spruce: 'log', birch: 'log', jungle: 'log', acacia: 'log', dark_oak: 'log',
  pale_oak: 'log', mangrove: 'log', cherry: 'log', crimson: 'stem', warped: 'stem'
}
function fixPlanks (registry) {
  if (!registry || !registry.recipes || !registry.itemsByName || registry.__ndPlanksFixed) return 0
  let n = 0
  const add = (planks, members, count) => {
    const p = registry.itemsByName[planks]
    if (!p) return
    const list = registry.recipes[p.id] = registry.recipes[p.id] || []
    for (const m of members) {
      const it = registry.itemsByName[m]
      if (!it) continue
      if (list.some(r => Array.isArray(r.ingredients) && r.ingredients.length === 1 && r.ingredients[0] === it.id)) continue
      list.push({ ingredients: [it.id], result: { id: p.id, count } })
      n++
    }
  }
  for (const [w, kind] of (Object.entries(PLANK_WOODS) as [string, any][])) {
    const members = kind === 'log'
      ? [`${w}_log`, `${w}_wood`, `stripped_${w}_log`, `stripped_${w}_wood`]
      : [`${w}_stem`, `stripped_${w}_stem`, `${w}_hyphae`, `stripped_${w}_hyphae`]
    add(`${w}_planks`, members, 4)
  }
  add('bamboo_planks', ['bamboo_block', 'stripped_bamboo_block'], 2)
  registry.__ndPlanksFixed = true
  return n
}

// dye_white_wool в jar 1.21.11 принимает любой из 15 прочих цветов;
// minecraft-data сохраняет из списка только black_wool. Разворачиваем
// именно этот рецепт, чтобы смешанную шерсть можно было собрать в кровать.
function fixWhiteWool (registry) {
  const white = registry?.itemsByName?.white_wool
  const dye = registry?.itemsByName?.white_dye
  if (!white || !dye || !registry.recipes) return 0
  const list = registry.recipes[white.id] = registry.recipes[white.id] || []
  let added = 0
  for (const [name, item] of ((Object.entries(registry.itemsByName) as [string, any][]) as any)) {
    if (!name.endsWith('_wool') || name === 'white_wool') continue
    if (list.some(r => r.ingredients?.length === 2 && r.ingredients.includes(dye.id) && r.ingredients.includes(item.id))) continue
    list.push({ ingredients: [dye.id, item.id], result: { id: white.id, count: 1 } })
    added++
  }
  return added
}

// minecraft-data 1.21.11: таблица номеров атрибутов в пакете
// entity_update_attributes устарела — с 20-го номера всё съехало: скорость
// (22 = movement_speed по реестру и javap) приходит как «generic.scale».
// Физика prismarine ищет minecraft:movement_speed, не находит и считает
// базовые 0.1 — зелья скорости и замедления, песок душ, всё мимо: тело
// идёт не с той скоростью, что видит сервер (нашёл агент фермы на лошадях).
// Чиним имена до того, как mineflayer их запишет. Серверный модификатор бега
// (minecraft:sprinting) выкидываем: физика кладёт свой по старому uuid и
// иначе посчитала бы бег дважды.
function fixAttributes (bot) {
  if (!bot || !bot._client || bot.__ndAttrFixed || process.env.ND_NO_ATTRFIX) return 0
  const reg = bot.registry
  const find = (o) => {
    if (!o || typeof o !== 'object') return null
    if (o.mappings && (Object.values(o.mappings) as any[]).includes('generic.armor')) return o.mappings
    for (const v of (Object.values(o) as any[])) { const r = find(v); if (r) return r }
    return null
  }
  let mapper = null
  try { mapper = find(reg.protocol.play.toClient.types.packet_entity_update_attributes) } catch {}
  const real = reg.attributesArray || []
  const rename: any = {}
  if (mapper) for (const [id, k] of (Object.entries(mapper) as [string, any][])) if (real[id] && real[id].resource) rename[k] = real[id].resource
  bot.__ndAttrFixed = true
  bot._client.prependListener('entity_update_attributes', (packet) => {
    for (const p of packet.properties || []) {
      if (rename[p.key]) p.key = rename[p.key]
      if (Array.isArray(p.modifiers)) p.modifiers = p.modifiers.filter(m => m.uuid !== 'minecraft:sprinting')
    }
  })
  return Object.keys(rename).length
}

// Компонент предмета intangible_projectile (стрела или ракета, которую нельзя
// подобрать: лишние снаряды «Тройного выстрела», стрелы с «Бесконечностью»).
// В игре у него нет своего сетевого кодека (DataComponents.INTANGIBLE_PROJECTILE:
// только persistent(Unit.CODEC)), и тогда DataComponentType.Builder.build берёт
// ByteBufCodecs.fromCodecWithRegistries — по сети это NBT пустого compound
// (2 байта). В protocol.json minecraft-data 1.21.11 он записан как void — и
// разбор любого предмета с ним съезжал на 2 байта: заряженный «Тройным
// выстрелом» арбалет (charged_projectiles) и ракета из него (метаданные
// fireworks_item) падали PartialReadError, бот не видел, что арбалет заряжен
// (замер 2026-09-26, try-xbow.js xrocket: «не зарядился», а он выстрелил).
// Правим до того, как minecraft-protocol скомпилирует протокол (первый
// createBot) — модуль грузится раньше.
function fixProtocol (version = '1.21.11') {
  try {
    const proto = (require('minecraft-data') as typeof import('minecraft-data'))(version).protocol
    const sc = proto && proto.types && proto.types.SlotComponent
    const sw = sc && sc[1] && sc[1][1] && sc[1][1].type && sc[1][1].type[1]
    if (sw && sw.fields && sw.fields.intangible_projectile === 'void') { sw.fields.intangible_projectile = 'anonymousNbt'; return 1 }
  } catch {}
  return 0
}
fixProtocol()

// Чары предмета (арена с чарами, 2026-09-26). У предмета с компонентами
// prismarine-item.enchants отдаёт сырые данные пакета — {enchantments:
// [{id, level}]}, — а все, кто его читает, ждут список [{name, lvl}], как было
// до 1.20.5: digTime самого mineflayer (digging.js: enchantments.concat(чары
// шлема)), prismarine-block.digTime (for…of, .name/.lvl), tools.digMs,
// structures.js, @nxg-org util-plugin (armor.enchants.map). Замер try-ench.js
// на Paper 1.21.11: с зачарованной киркой или мечом в руке bot.dig падал
// сразу — «enchantments.concat is not a function», — ни обсидиан, ни булыжник,
// ни паутина; tools.digMs у любого зачарованного инструмента — Infinity
// (for…of по объекту бросает, digMs ловит), и bestFor выбирал руку: паутину
// 20 с вместо 0.4 мечом. Сервер «Эффективность» считает: «докопал» через
// 2.4 с обсидиан киркой с «Эффективностью V» принят, простой — нет.
// Здесь загрузчик prismarine-item подменяется так, что каждый класс Item —
// mineflayer, prismarine-windows, prismarine-entity, сам демон — отдаёт
// [{name, lvl}]. Номер — по реестру чар (у 1.21.11 он алфавитный, как в
// minecraft-data, — enchant.js). Сам компонент (componentMap) не трогаем:
// read.enchLevel и enchant.enchantsOf читают его напрямую. Все вызовы
// загрузчика — внутри inject (после createBot), а этот модуль грузит
// session.js раньше, так что подмена успевает.
function fixEnchants () {
  let file
  try { file = require.resolve('prismarine-item') } catch { return 0 }
  require(file)
  const mod = require.cache[file]
  if (!mod || typeof mod.exports !== 'function' || mod.exports.__ndEnchFixed) return 0
  const orig = mod.exports
  const loader = function (registryOrVersion) {
    const Item = orig(registryOrVersion)
    const proto = Item && Item.prototype
    const d = proto && Object.getOwnPropertyDescriptor(proto, 'enchants')
    if (!d || !d.get || proto.__ndEnchFixed) return Item
    let table = null
    try { table = typeof registryOrVersion === 'string' ? (require('minecraft-data') as typeof import('minecraft-data'))(registryOrVersion).enchantments : registryOrVersion.enchantments } catch {}
    Object.defineProperty(proto, 'enchants', {
      configurable: true,
      enumerable: d.enumerable,
      get () {
        const c = this.componentMap && this.componentMap.get && this.componentMap.get('enchantments')
        if (!c) return d.get.call(this)
        const data = c.data
        const list = Array.isArray(data) ? data : (data && data.enchantments) || []
        return list.map(e => {
          const id = e.id ?? e.enchantment
          const name = typeof id === 'number' ? (table && table[id] && table[id].name) : String(id || '').replace(/^minecraft:/, '')
          return { name: name || null, lvl: e.level ?? e.lvl ?? 1 }
        })
      },
      set: d.set
    })
    proto.__ndEnchFixed = true
    return Item
  }
  Object.assign(loader, orig)
  loader.__ndEnchFixed = true
  mod.exports = loader
  return 1
}
fixEnchants()

// Mineflayer 4.37.1 entities.js обновляет oxygenLevel из air_supply ЛЮБОЙ
// сущности. На run воздух игрока был 300 тиков, situation показывала 6.
// Запоминаем только собственный пакет, а перед подписчиками breath возвращаем
// его значение: чужой моб не должен ни создать, ни скрыть утопление игрока.
function fixBreath (bot) {
  if (!bot || bot.__ndBreathFixed) return false
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys
  const key = bot.supportFeature('mcDataHasEntityMetadata') ? keys?.indexOf('air_supply') : 1
  if (!(key >= 0)) return false
  let oxygen = typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20
  bot._client.prependListener('entity_metadata', packet => {
    if (!bot.entity || packet.entityId !== bot.entity.id) return
    const air = (packet.metadata || []).find(m => m.key === key)
    if (air && typeof air.value === 'number') oxygen = Math.max(0, Math.min(20, Math.round(air.value / 15)))
  })
  bot.prependListener('breath', () => { bot.oxygenLevel = oxygen })
  bot.on('respawn', () => { oxygen = 20; bot.oxygenLevel = oxygen })
  bot.oxygenLevel = oxygen
  bot.__ndBreathFixed = true
  return true
}

// Типы урона — номер в реестре damage_type (пакет damage_event, поле sourceTypeId). Реестр по алфавиту
// имён: data/minecraft/damage_type/*.json в server-1.21.11.jar, 50 штук (сверено 2026-09-27). Одна копия
// для тела (session.wireHealth → damage.cause); копии в bastion.js, blaze.js, dragon.js и номер in_wall в
// autopilot.js сверяет тест test/damage-cause.test.js.
const DAMAGE_TYPES = ['arrow', 'bad_respawn_point', 'cactus', 'campfire', 'cramming', 'dragon_breath', 'drown', 'dry_out',
  'ender_pearl', 'explosion', 'fall', 'falling_anvil', 'falling_block', 'falling_stalactite', 'fireball', 'fireworks',
  'fly_into_wall', 'freeze', 'generic', 'generic_kill', 'hot_floor', 'in_fire', 'in_wall', 'indirect_magic', 'lava',
  'lightning_bolt', 'mace_smash', 'magic', 'mob_attack', 'mob_attack_no_aggro', 'mob_projectile', 'on_fire',
  'out_of_world', 'outside_border', 'player_attack', 'player_explosion', 'sonic_boom', 'spear', 'spit', 'stalagmite',
  'starve', 'sting', 'sweet_berry_bush', 'thorns', 'thrown', 'trident', 'unattributed_fireball', 'wind_charge',
  'wither', 'wither_skull']
const damageTypeName = id => (Number.isInteger(id) && DAMAGE_TYPES[id]) || null

// Own body only; a small collision crop is read once on death, never every physics tick.
function bodySnapshot (bot, local = false) {
  const e = bot?.entity, p = e?.position
  if (!p) return undefined
  const round = n => Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null
  const vec = v => v ? [round(v.x), round(v.y), round(v.z)] : null
  const keys = bot.registry?.entitiesByName?.player?.metadataKeys || []
  const out: Record<string, any> = { p: vec(p), v: vec(e.velocity), yaw: round(e.yaw), pitch: round(e.pitch),
    onGround: !!e.onGround, inWater: !!e.isInWater, inLava: !!e.isInLava,
    height: e._ndPoseHeight ?? e.height ?? 1.8, pose: e.metadata?.[keys.indexOf('pose')] ?? null,
    air: e.metadata?.[keys.indexOf('air_supply')] ?? null, oxygen: bot.oxygenLevel ?? null,
    effects: Object.entries(e.effects || {}).map(([id, fx]: [string, any]) => [Number(id), fx.amplifier ?? 0, fx.duration ?? null]),
    held: bot.heldItem?.name ?? null, gameTick: bot.ndClock?.ticks ?? null,
    gameMs: bot.ndClock?.now?.() ?? null, physicsTicks: bot._ndPhysicsTicks ?? null, wallMs: round(performance.now()) }
  // Replay needs the actual dangers used by flee, including loaded mobs behind a wall; telemetry only.
  out.mobs = Object.values(bot.entities || {}).filter((m: any) => m !== e && (m.type === 'mob' || m.type === 'hostile') && m.position && m.isValid !== false && m.position.distanceTo(p) <= 16)
    .sort((a: any, b: any) => a.position.distanceTo(p) - b.position.distanceTo(p)).slice(0, 16)
    .map((m: any) => {
      const names = bot.registry?.entitiesByName?.[m.name]?.metadataKeys || []
      return { id: m.id, kind: m.name, p: vec(m.position), v: vec(m.velocity),
        sw: m.name === 'creeper' ? m.metadata?.[names.indexOf('swell_dir')] ?? null : undefined,
        charged: m.name === 'creeper' ? m.metadata?.[names.indexOf('is_powered')] ?? null : undefined }
    })
  if (local && typeof bot.blockAt === 'function') {
    const min = [Math.floor(p.x) - 3, Math.floor(p.y) - 2, Math.floor(p.z) - 3], size = [7, 9, 7], runs: number[] = [], palette: number[] = [], cell = p.clone()
    let previous = -2, count = 0
    for (let y = min[1]; y < min[1] + size[1]; y++) for (let z = min[2]; z < min[2] + size[2]; z++) for (let x = min[0]; x < min[0] + size[0]; x++) {
      let sid = -1
      try { sid = bot.blockAt(cell.set(x, y, z))?.stateId ?? -1 } catch {}
      const index = sid < 0 ? -1 : palette.indexOf(sid) >= 0 ? palette.indexOf(sid) : palette.push(sid) - 1
      if (index !== previous && count) { runs.push(count, previous); count = 0 }
      previous = index; count++
    }
    if (count) runs.push(count, previous)
    out.near = { version: bot.version, min, size, palette, runs }
    out.trail = (bot._ndBodyTrail || []).map(frame => [...frame])
  }
  return out
}

// ND_SLIME_SIZE=1 (blz 21.10): рамка слизня и магмового куба — по размеру из метаданных (Slime.ID_SIZE, индекс 16; размеры
// EntityType 0.52 × 0.52, Slime.getDefaultDimensions — scale(size)): minecraft-data даёт 0.52 на любой размер, и большой куб (2.08)
// для глаз и прицела — кубик у земли: «бьёт невидимый (magma_cube)», бой «ни одного удара за 4 с» — смерть (gC11-s18-1, bE2-s18-2).
function fixSlimeSize (bot) {
  const fix = e => {
    if (!e || !/^(slime|magma_cube)$/.test(e.name || '')) return
    const size = Number(e.metadata?.[16])
    if (size > 0 && size <= 127) { const d = Math.fround(0.52 * size); e.width = d; e.height = d }
  }
  bot.on('entitySpawn', fix)
  bot.on('entityUpdate', fix)
}
export { bodySnapshot, fixMaterials, fixPlanks, fixWhiteWool, fixAttributes, fixProtocol, fixEnchants, fixBreath, fixSlimeSize, DAMAGE_TYPES, damageTypeName }
