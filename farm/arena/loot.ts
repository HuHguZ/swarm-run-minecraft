'use strict'
// Лут гонки: набивка сундуков на раунд (зерно — seed карты и номер раунда) и пополнение открытых по числу бойцов.
import { SOLO } from './context'
import type { ArenaContext } from './context'
import { pickCaches } from '../../daemon/arena/colosseum-caches'
import { ANTIDOTES } from './gear'

// Зелья реестра 1.21.11 (Potions, server-1.21.11.jar) без воды, «странного», «густого», «неуклюжего».
const ALL_POTIONS = ['night_vision', 'long_night_vision', 'invisibility', 'long_invisibility', 'leaping', 'long_leaping', 'strong_leaping',
  'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness', 'strong_swiftness', 'slowness', 'long_slowness', 'strong_slowness',
  'turtle_master', 'long_turtle_master', 'strong_turtle_master', 'water_breathing', 'long_water_breathing', 'healing', 'strong_healing',
  'harming', 'strong_harming', 'poison', 'long_poison', 'strong_poison', 'regeneration', 'long_regeneration', 'strong_regeneration',
  'strength', 'long_strength', 'strong_strength', 'weakness', 'long_weakness', 'luck', 'slow_falling', 'long_slow_falling',
  'wind_charged', 'weaving', 'oozing', 'infested']

// Ярусы колизея (пользователь 14.10: «чем выше этаж — тем круче лут: снизу слабое, на самом верху, куда просто так не
// залезть, — незерит, крутые чары; у всех мотивация лезть наверх»). Ярус — по высоте сундука над песком (dy): 0 — песок,
// камеры, нижние галереи, комнаты спавна; 1 — терраса, нижние ряды, галерея 8; 2 — средние ряды, галерея 16; 3 — верх рядов,
// галерея 24; 4 — крыша-терраса (31, только жемчугом, столбом, на элитрах); 5 — венец стены (34). Тайник — на ярус выше.
export const tierOf = (y: number) => y <= 2 ? 0 : y <= 10 ? 1 : y <= 18 ? 2 : y <= 27 ? 3 : y <= 32 ? 4 : 5
const TIERS = [
  { weapon: ['stone', 'stone', 'iron'], armor: ['leather', 'chainmail', 'chainmail', 'iron'], ench: 0.25, lv: 0.3, weapons: 1, armorN: 1, totem: 0, gapple: 0, elytra: 0.1, tnt: 0.35, blocks: 0.6 },
  { weapon: ['stone', 'iron', 'iron'], armor: ['chainmail', 'iron', 'iron'], ench: 0.45, lv: 0.5, weapons: 2, armorN: 2, totem: 0.05, gapple: 0, elytra: 0.15, tnt: 0.3, blocks: 0.5 },
  { weapon: ['iron', 'diamond', 'diamond'], armor: ['iron', 'diamond'], ench: 0.7, lv: 0.7, weapons: 2, armorN: 2, totem: 0.12, gapple: 0.05, elytra: 0.2, tnt: 0.25, blocks: 0.4 },
  { weapon: ['diamond', 'diamond', 'netherite'], armor: ['diamond', 'diamond', 'netherite'], ench: 0.9, lv: 0.85, weapons: 2, armorN: 3, totem: 0.25, gapple: 0.12, elytra: 0.3, tnt: 0.25, blocks: 0.3 },
  { weapon: ['diamond', 'netherite', 'netherite'], armor: ['diamond', 'netherite', 'netherite'], ench: 1, lv: 1, weapons: 3, armorN: 3, totem: 0.5, gapple: 0.3, elytra: 0.45, tnt: 0.3, blocks: 0.3 },
  { weapon: ['netherite'], armor: ['netherite'], ench: 1, lv: 1, max: true, weapons: 3, armorN: 4, totem: 0.8, gapple: 0.6, elytra: 0.6, tnt: 0.3, blocks: 0.3 }
] as const

// Свой лут на 12 бойцов (пользователь 10.10: «добавь ресурсов, покруче»): карта arms-layout рассчитана на дуэль —
// 14 оружия на 12, лава в сундуках. Сундук очищается и набивается заново (seed): оружие железо/алмаз, броня,
// щиты, яблоки, зелья, жемчуг, еда, блоки; тайники — лучше. Нарочно неровно: кому-то два меча, кому-то пусто —
// каптёру есть что делить. ARMS_LOOT=layout — как было.
export function makeStockChests (ctx: ArenaContext) {
  const { i, L, X, Y, Z, rcon, log, sleep } = ctx
  // Тайники в толще Колизея (пользователь 21.10; daemon/arena/colosseum-caches): прежние — обратно камнем стены (без копии
  // Колизея, ARMS_RESET=0, они бы остались), новые — по зерну карты и раунда. Где они — знает только журнал арены (замер);
  // рою — ни слова: ищет сам, вскрывая толщу. ARMS_CACHES=0 — без тайников.
  let caches: any[] = []
  const placeCaches = async (round: number) => {
    if (L.map !== 'colosseum' || process.env.ARMS_CACHES === '0') return
    for (const c of caches) await rcon(i, `setblock ${X + c.x} ${Y + c.y} ${Z + c.z} minecraft:${c.was}`).catch(() => {})
    caches = pickCaches(L, round)
    for (const c of caches) {
      const p = { x: X + c.x, y: Y + c.y, z: Z + c.z }
      await rcon(i, `setblock ${p.x} ${p.y} ${p.z} minecraft:chest[facing=${c.facing}]`).catch(() => {})
      for (const [k, it] of c.items.entries()) { const [n, cnt] = it.split(/ (?=\d+$)/); await rcon(i, `item replace block ${p.x} ${p.y} ${p.z} container.${k} with minecraft:${n} ${cnt || 1}`).catch(() => {}) }
    }
    log(`🗝 тайники раунда ${round}: ${caches.map(c => `${X + c.x},${Y + c.y},${Z + c.z} (dy ${c.y}: ${c.items.map(s => s.replace(/\[.*\]/, '*').replace(/ \d+$/, '')).join(', ')})`).join(' | ')}`)
  }
  return async (round: number, only: any[] | null = null) => {
    if (!only) await placeCaches(round)
    if (process.env.ARMS_LOOT === 'layout') return
    let seed = [...(String(L.seed) + ':' + round)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7)
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    const pickOne = (arr) => arr[Math.floor(rnd() * arr.length)]
    const pot = (kind, name) => `${kind}[potion_contents={potion:"minecraft:${name}"}]`
    const heal = pot('splash_potion', 'strong_healing')
    const stats: any = { weapons: 0, armor: 0, items: 0 }
    const used = new Map<string, number>()
    for (const c of (only || L.chests)) {
      // Сундуки комнат спавна (14.10: «сундуки с лутом с некоторой вероятностью»): место есть всегда, сундук в раунде — с
      // вероятностью ARMS_SPAWN_CHEST (0.5), иначе пусто.
      if (c.kind === 'spawn' && !only && rnd() >= Number(process.env.ARMS_SPAWN_CHEST ?? 0.5)) { await rcon(i, `setblock ${X + c.x} ${Y + c.y} ${Z + c.z} minecraft:air`).catch(() => {}); continue }
      const hidden = /secret|under|niche/.test(c.kind)
      const mat = () => (rnd() < (SOLO ? 0.75 : hidden ? 0.6 : 0.25) ? 'diamond' : 'iron')
      const tier = L.map === 'colosseum' ? Math.min(5, tierOf(c.y) + (hidden ? 1 : 0)) : null
      const T: any = tier === null ? null : TIERS[tier]
      if (T) (stats.tiers ||= [0, 0, 0, 0, 0, 0])[tier]++
      const gen = (reserve = 0) => {
      const items: string[] = []
      // Оружие (пользователь 10.10: «разное — булава, копьё, чарованное; лут как в сундуках Края»): в 80% сундуков, в
      // тайнике — и второе; чары — в 40% (тайник 70%), уровни случайны. Тайник — лут города Края: алмаз, изредка незерит.
      const lv = (max) => T?.max ? max : 1 + Math.floor(rnd() * (T ? Math.ceil(max * T.lv) : max))
      const ench = (base, list) => rnd() < (T ? T.ench : SOLO ? 1 : hidden ? 0.7 : 0.4) ? `${base}[enchantments={${(T?.max ? list : list.filter(() => rnd() < 0.7)).join(',') || list[0]}}]` : base
      const mat2 = () => T ? pickOne(T.weapon) : (SOLO ? rnd() < (hidden ? 0.4 : 0.2) : hidden && rnd() < 0.08) ? 'netherite' : mat()
      // Раунд кристаллов (10.10: «в основном взрывают друг друга») — без оружия в сундуках: бой кристаллами, а не мечом.
      for (let w = 0; w < (process.env.ARMS_CRYSTAL === '1' ? 0 : T ? T.weapons : hidden ? 3 : 2); w++) if (T || rnd() < 0.8) {
        // Соло (14.10: «не замечаю, чтоб атаковали булавой или копьём в полёте»): булав и копий втрое/вдвое больше — было 1 из 12.
        const kind = pickOne(['sword', 'sword', 'sword', 'axe', 'axe', 'spear', 'spear', 'mace', 'trident', 'bow', 'bow', 'crossbow', ...(SOLO ? ['mace', 'mace', 'spear', 'spear'] : [])])
        const m = mat2()
        if (kind === 'sword') items.push(ench(`${m}_sword`, [`sharpness:${lv(5)}`, `fire_aspect:${lv(2)}`, `knockback:${lv(2)}`, 'sweeping_edge:2']) + ' 1')
        else if (kind === 'axe') items.push(ench(`${m}_axe`, [`sharpness:${lv(5)}`, 'efficiency:3']) + ' 1')
        else if (kind === 'spear') items.push(ench(`${m === 'netherite' && !T ? 'diamond' : m}_spear`, [`sharpness:${lv(5)}`, `knockback:${lv(2)}`, `lunge:${lv(3)}`]) + ' 1')
        // Булава — всегда с «Порывом ветра» (пользователь 24.10: отскок после смэша, Nuke Diving); Плотность и Пробитие в 1.21.11
        // взаимоисключают друг друга (enchantment/exclusive_set/damage) — одно из двух.
        else if (kind === 'mace') items.push(`mace[enchantments={wind_burst:${lv(3)}${rnd() < (T ? T.ench : 0.5) ? `,${rnd() < 0.6 ? `density:${lv(5)}` : `breach:${lv(4)}`}` : ''}}] 1`, 'wind_charge 6')
        // «Тягун» (связка трезубец → булава в грозу) — в 40%; с Верностью и Громовержцем он несовместим (exclusive_set/riptide).
        // Уровень I — чаще: только он садится на врага в 5–11 бл. с переживаемой вершины (II–III — 18–38 бл., riptideArc).
        else if (kind === 'trident') items.push((rnd() < .4 ? `trident[enchantments={riptide:${rnd() < .6 ? 1 : lv(3)},impaling:${lv(5)}}]` : ench('trident', [`impaling:${lv(5)}`, `loyalty:${lv(3)}`])) + ' 1')
        else if (kind === 'bow') items.push(rnd() < .25 ? 'bow[enchantments={punch:2}] 1' : ench('bow', [`power:${lv(5)}`, `punch:${lv(2)}`, 'flame:1']) + ' 1', 'arrow 32')
        else items.push(ench('crossbow', [`quick_charge:${lv(3)}`, 'multishot:1', `piercing:${lv(4)}`]) + ' 1', 'arrow 32')
        stats.weapons++
      }
      const nArmor = T ? T.armorN + (T.max ? 0 : Math.floor(rnd() * 2)) : Math.floor(rnd() * (hidden ? 3 : 2)) + 2
      for (let a = 0; a < nArmor; a++) {
        const piece = T?.max ? ['helmet', 'chestplate', 'leggings', 'boots'][a % 4] : pickOne(['helmet', 'chestplate', 'leggings', 'boots'])
        items.push(ench(`${T ? pickOne(T.armor) : mat2()}_${piece}`, [`protection:${lv(4)}`, 'unbreaking:3', ...(piece === 'boots' ? [`feather_falling:${lv(4)}`] : []), ...(piece === 'leggings' ? [`blast_protection:${lv(4)}`] : [])]) + ' 1')
        stats.armor++
      }
      const extras: string[][] = []
      const extra = (...group: string[]) => extras.push(group)
      if (process.env.ARMS_CRYSTAL !== '1') extra(...ANTIDOTES) // Two slots together, before other optional supplies; existing reserve/capacity still applies.
      for (let e = 0; e < 2 + (hidden ? 2 : 1); e++) extra(pickOne(['golden_apple 2', `${heal} 2`, 'shield 1', 'ender_pearl 2', 'cooked_beef 8', 'cobblestone 32', 'golden_apple 1', `${heal} 1`, 'wind_charge 4', 'wind_charge 8']))
      if (T ? rnd() < T.gapple : hidden && rnd() < 0.12) extra('enchanted_golden_apple 1')
      // Динамит (пользователь 14.10: «динамитом взрывать — достать игрока или разнести колизей к чертям, больше анархии»): с
      // огнивом или огненными зарядами; блоки — строить столбы и мосты к человеку наверху (ND_SCAFFOLD_ANY).
      if (T && rnd() < T.tnt) extra(`tnt ${2 + Math.floor(rnd() * 4)}`, rnd() < 0.7 ? 'flint_and_steel 1' : 'fire_charge 4')
      if (T && rnd() < T.blocks) extra(`${pickOne(['cobblestone', 'sandstone', 'oak_planks'])} ${pickOne([32, 48, 64])}`)
      // Лестницы (пользователь 14.10: «лестницу, по которой другие залезут; дерево в сундуках — крафтить лестницы»): готовые
      // или брёвна (1 бревно ≈ 3 лестницы).
      if (T && rnd() < 0.35) extra(rnd() < 0.6 ? `ladder ${pickOne([16, 24, 32])}` : `oak_log ${pickOne([4, 6, 8])}`)
      // Щит — в каждом втором (10.10: «от булавы без щита не защищаются»; щит держит и смэш булавы).
      if (rnd() < 0.5) extra('shield 1')
      // Чем уничтожать чужой лут (лава, огонь): ведро лавы, огниво, огненный заряд — иногда.
      if (rnd() < 0.3) extra(pickOne(['flint_and_steel 1', 'lava_bucket 1', 'fire_charge 3']))
      // Ведро воды (10.10: «гасить урон от падения и тушиться, а то не хватает») — в 45% сундуков.
      if (rnd() < 0.45) extra('water_bucket 1')
      // Паутина — закрыть проход за собой (10.10).
      if (rnd() < 0.4) extra('cobweb 4')
      // Удочка (пользователь 14.10: «удочки добавь в сундуки для пвп — пусть боты ими притягивают игроков и врагов»): в
      // трети сундуков, в тайнике — в половине; бой берёт её сам (utility: подтяг под удар, со столба, в лаву или яму).
      if (rnd() < (hidden ? 0.5 : 0.35)) extra('fishing_rod[enchantments={unbreaking:3}] 1')
      if (rnd() < (T ? T.totem : SOLO ? (hidden ? 0.5 : 0.2) : hidden ? 0.1 : 0)) extra('totem_of_undying 1')
      if (SOLO && rnd() < (T ? T.elytra : 0.25)) extra('elytra[enchantments={unbreaking:3}] 1', 'firework_rocket 16')
      // Зелья (пользователь 10.10: «больше зелий — хилок и опасных»): лечение чаще всего, вред/яд взрывные, сила/реген.
      for (let e = 0; e < (hidden ? 4 : 3); e++) extra(pickOne([`${heal} 2`, `${heal} 1`, `${heal} 2`, pot('splash_potion', 'strong_harming') + ' 1', pot('splash_potion', 'harming') + ' 2',
        pot('splash_potion', 'poison') + ' 1', pot('potion', 'strength') + ' 1', pot('potion', 'regeneration') + ' 1']))
      // Баффы (10.10: «больше зелий — усиления на скорость, урон, чтобы ускорялись жёстко и мочили»): в каждом сундуке
      // 2 (тайник 3). Скорость и сила — сверх обычных (Скорость IV, Сила III на 90 с); основа — strong_* (бой их
      // узнаёт по potion и пьёт сам: перед боем и между разменами).
      const fx = (base, id, amp, sec) => `potion[potion_contents={potion:"minecraft:${base}",custom_effects:[{id:"minecraft:${id}",amplifier:${amp},duration:${sec * 20}}]}]`
      for (let e = 0; e < (hidden ? 3 : 2); e++) extra(pickOne([fx('strong_swiftness', 'speed', 3, 90) + ' 1', fx('strong_swiftness', 'speed', 3, 90) + ' 2', fx('strong_strength', 'strength', 2, 90) + ' 1',
        fx('strong_strength', 'strength', 2, 90) + ' 2', pot('potion', 'strong_regeneration') + ' 1', pot('potion', 'long_fire_resistance') + ' 1', pot('potion', 'strong_turtle_master') + ' 1',
        pot('potion', 'strong_leaping') + ' 1', pot('splash_potion', 'strong_slowness') + ' 1', pot('splash_potion', 'long_weakness') + ' 1']))
      // Соло (12.10: «зелья поразнообразнее — все виды и разной силы»): все зелья реестра 1.21.11 (кроме воды/пустых),
      // вредные — взрывные или оседающие, остальные — чаще питьевые; 3 в сундук, 5 в тайник.
      if (SOLO) for (let e = 0; e < (hidden ? 5 : 3); e++) {
        const id = pickOne(ALL_POTIONS)
        const bad = /harming|poison|slowness|weakness|infested|oozing|weaving/.test(id)
        const r = rnd()
        extra(pot(bad ? (r < 0.7 ? 'splash_potion' : 'lingering_potion') : r < 0.65 ? 'potion' : r < 0.9 ? 'splash_potion' : 'lingering_potion', id) + ' 1')
      }
      // Алхимия и кузница — по частям в разных сундуках: полный набор только у команды вместе (свозят алхимику).
      if (rnd() < 0.45) extra(pickOne(['nether_wart 3', 'glistering_melon_slice 3', 'glowstone_dust 3', 'gunpowder 3', 'blaze_powder 2', 'glass_bottle 3', 'fermented_spider_eye 2']))
      if (rnd() < 0.3) extra(pickOne(['iron_ingot 2', 'diamond 2', 'stick 2']))
      // Кирки (10.10: «добавь в сундуки кирки — ботам не хватает»): ломать стенки, столбы, крышки нычек; и набор на
      // свою кирку — 3 слитка/алмаза, 2 палки, верстак (крафтят сами, если кирки нет).
      if (rnd() < 0.45) items.push(ench(`${mat2()}_pickaxe`, [`efficiency:${lv(5)}`, 'unbreaking:3']) + ' 1')
      if (rnd() < 0.2) items.push(pickOne(['iron_ingot 3', 'diamond 3']), 'stick 2', 'crafting_table 1')
      // Парные припасы в обычном луте; оставляем места под добавки раунда (элитры, кузница, алхимия).
      // Стазис-ловушка (пользователь 24.10): вода над песком душ — пузырьковый столб, жемчуг в нём зависает. Песок с ведром —
      // одной парой, в четверти сундуков.
      if (items.length <= 21 && rnd() < .25) items.push('soul_sand 4', 'water_bucket 1')
      // Кристальное PvP (пользователь 24.10, «в разумных количествах»): кристаллы с обсидианом выше по ярусам, якорь со
      // светокамнем (в Верхнем мире заряженный якорь взрывается при использовании) — реже.
      if (items.length <= 21 && rnd() < (T ? .08 + .04 * tier! : .1)) items.push(`end_crystal ${pickOne([2, 3, 4])}`, `obsidian ${pickOne([4, 6, 8])}`)
      if (items.length <= 22 && rnd() < (T ? .04 + .02 * tier! : .05)) items.push('respawn_anchor 1', `glowstone ${pickOne([4, 8])}`)
      items.push(pot('tipped_arrow', pickOne(['swiftness', 'strong_swiftness', 'regeneration', 'strong_regeneration', 'slowness', 'strong_slowness', 'weakness', 'poison', 'strong_poison', 'harming', 'strong_harming', 'slow_falling'])) + ' 8')
      // Optional supplies fit as whole groups after weapons, armor, tools and recipe pairs.
      for (const group of extras) if (items.length + group.length <= 27 - reserve) items.push(...group)
      return items
      }
      // Reserve the first half for up to five round additions: flight kit, smithing pair and ingredient.
      const items = gen(only ? 0 : 5)
      const p = { x: X + c.x, y: Y + c.y, z: Z + c.z }
      // Двойной сундук (10.10: «сундуки двойные — больше поместится»; лут пропорционально 30 на 30): вторая половина сбоку
      // (по часовой от взгляда — так её ищет ChestBlock для type=left), если там и над ней воздух; раз в раунд (колизей
      // восстанавливается из запаса — вторые половины пропадают). Каждая половина — свой набор. ARMS_DOUBLE=0 — одинарные.
      if (!only && process.env.ARMS_DOUBLE !== '0' && c.facing) {
        const cw = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }[c.facing]
        const q = cw && { x: p.x + cw[0], y: p.y, z: p.z + cw[1] }
        const free = q && /passed/i.test(String(await rcon(i, `execute if block ${q.x} ${q.y} ${q.z} minecraft:air if block ${q.x} ${q.y + 1} ${q.z} minecraft:air`).catch(() => '')))
        c.pair = free ? q : null
        if (free) {
          await rcon(i, `setblock ${p.x} ${p.y} ${p.z} minecraft:chest[facing=${c.facing},type=left]`).catch(() => {})
          await rcon(i, `setblock ${q.x} ${q.y} ${q.z} minecraft:chest[facing=${c.facing},type=right]`).catch(() => {})
          stats.doubled = (stats.doubled || 0) + 1
        }
      }
      let slot = 0
      used.set(c.id, items.length)
      for (const [half, list] of [[p, items], ...(c.pair ? [[c.pair, gen()]] : [])] as any[]) {
        await rcon(i, `data merge block ${half.x} ${half.y} ${half.z} {Items:[]}`).catch(() => {})
        slot = 0
        for (const it of list) { const [n, k] = it.split(/ (?=\d+$)/); await rcon(i, `item replace block ${half.x} ${half.y} ${half.z} container.${slot++} with minecraft:${n} ${k || 1}`).catch(() => {}); stats.items++ }
      }
    }
    // Пополнение отдельных сундуков (ARMS_LOOT_X) — без элитр, наборов алхимии и лаборатории: те раз на раунд.
    if (only) return
    {
      const secretChests = L.chests.filter(c => /secret|under|niche/.test(c.kind))
      const c = secretChests[Math.floor(rnd() * secretChests.length)]
      if (c) for (const it of ['elytra[enchantments={unbreaking:3}] 1', 'firework_rocket 24']) {
        const [n, cnt] = it.split(/ (?=\d+$)/); const sl = used.get(c.id) || 0; used.set(c.id, sl + 1)
        await rcon(i, `item replace block ${X + c.x} ${Y + c.y} ${Z + c.z} container.${sl} with minecraft:${n} ${cnt}`).catch(() => {})
      }
      if (c) log(`гонка: элитры в этом раунде — тайник ${c.room}`)
    }
    // Полный набор на взрывное лечение — на каждой половине карты (запад — красным, восток — синим), каждый
    // ингредиент в своём сундуке: сварит команда, что обыщет свою сторону и свезёт алхимику (10.10: случайно — не собирался).
    for (const side of [-1, 1]) {
      const mine = L.chests.filter(c => c.x * side > 0 && c.kind !== 'spawn').sort(() => rnd() - 0.5) // сундука комнаты в раунде может не быть
      const SET = ['nether_wart 3', 'glistering_melon_slice 3', 'glowstone_dust 3', 'gunpowder 3', 'blaze_powder 2', 'glass_bottle 3', 'fermented_spider_eye 1']
      // Кузница: слитки и алмазы — вместе с палкой (в одном сундуке: крафт меча без своза).
      for (const [k, pair] of [['iron_ingot 2', 'stick 1'], ['diamond 2', 'stick 1']].entries()) {
        const c = mine[(SET.length + k) % mine.length]; if (!c) continue
        for (const it of pair) { const [n, cnt] = it.split(/ (?=\d+$)/); const sl = used.get(c.id) || 0; used.set(c.id, sl + 1); rcon(i, `item replace block ${X + c.x} ${Y + c.y} ${Z + c.z} container.${sl} with minecraft:${n} ${cnt}`).catch(() => {}) }
      }
      SET.forEach((it, k) => {
        const c = mine[k % mine.length]; if (!c) return
        const [n, cnt] = it.split(/ (?=\d+$)/); const sl = used.get(c.id) || 0; used.set(c.id, sl + 1)
        rcon(i, `item replace block ${X + c.x} ${Y + c.y} ${Z + c.z} container.${sl} with minecraft:${n} ${cnt}`).catch(() => {})
      })
    }
    await sleep(500)
    // Припасы лаборатории (гонка 10: набор по сундукам поля не собирался ни разу — обыскивали не все) — по набору
    // на каждую команду; алхимик берёт только недостающее, так что второй команде тоже останется.
    const LC = { x: X + L.lab.brewing.x - 1, y: Y + L.lab.brewing.y, z: Z + L.lab.brewing.z }
    await rcon(i, `setblock ${LC.x} ${LC.y} ${LC.z} chest[facing=south]`).catch(() => {})
    for (const [k, it] of ['nether_wart 2', 'glistering_melon_slice 2', 'glowstone_dust 2', 'gunpowder 2', 'blaze_powder 4', 'glass_bottle 6', 'fermented_spider_eye 2'].entries())
      await rcon(i, `item replace block ${LC.x} ${LC.y} ${LC.z} container.${k} with minecraft:${it}`).catch(() => {})
    log(`гонка: сундуки набиты (раунд ${round}) — оружия ${stats.weapons}, брони ${stats.armor}, всего предметов ${stats.items}, двойных сундуков ${stats.doubled || 0}/${L.chests.length}${stats.tiers ? `, по ярусам ${stats.tiers.join('/')}` : ''} (без лавы)`)
  }
}

// Лут пропорционально бойцам (10.10: «30 на 30 — лута пропорционально»): сундук на 27 ячеек больше не вмещает, поэтому
// открытый сундук пополняется заново, пока не выдаст ARMS_LOOT_X наборов за раунд (умолчание — бойцов / 24).
export function startRefills (ctx: ArenaContext) {
  const { arms, N, L, X, Y, Z, opened, refills, log } = ctx
  const LOOT_X = Number(process.env.ARMS_LOOT_X) || Math.max(1, (N || 24) / 24)
  let refillRound = 0
  return arms && LOOT_X > 1 ? setInterval(async () => {
    if (ctx.between) return
    const due = L.chests.filter(c => { const k = `${c.x},${c.y},${c.z}`; return opened.has(k) && (refills.get(k) || 0) < Math.round(LOOT_X / (c.pair ? 2 : 1)) - 1 }) // двойной — два набора за раз
    if (!due.length) return
    for (const c of due) { const k = `${c.x},${c.y},${c.z}`; refills.set(k, (refills.get(k) || 0) + 1); opened.delete(k) }
    await ctx.stockChests(1000 + ++refillRound, due).catch(() => {})
    // Пополнен — рой узнаёт об этом сундуке (Codex 1b): пустой больше не считается пустым, без срока «через 60 с проверить снова».
    for (const c of due) ctx.swarmDriver?.refill?.({ x: X + c.x, y: Y + c.y, z: Z + c.z })
    log(`🎁 пополнил сундуков ${due.length} (лут ×${LOOT_X.toFixed(1)} на ${N} бойцов)`)
  }, 20000) : null
}
