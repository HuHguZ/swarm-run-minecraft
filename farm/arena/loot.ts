'use strict'
// Лут гонки: набивка сундуков на раунд (зерно — seed карты и номер раунда) и пополнение открытых по числу бойцов.
import { SOLO } from './context'
import type { ArenaContext } from './context'

// Зелья реестра 1.21.11 (Potions, server-1.21.11.jar) без воды, «странного», «густого», «неуклюжего».
const ALL_POTIONS = ['night_vision', 'long_night_vision', 'invisibility', 'long_invisibility', 'leaping', 'long_leaping', 'strong_leaping',
  'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness', 'strong_swiftness', 'slowness', 'long_slowness', 'strong_slowness',
  'turtle_master', 'long_turtle_master', 'strong_turtle_master', 'water_breathing', 'long_water_breathing', 'healing', 'strong_healing',
  'harming', 'strong_harming', 'poison', 'long_poison', 'strong_poison', 'regeneration', 'long_regeneration', 'strong_regeneration',
  'strength', 'long_strength', 'strong_strength', 'weakness', 'long_weakness', 'luck', 'slow_falling', 'long_slow_falling',
  'wind_charged', 'weaving', 'oozing', 'infested']

// Свой лут на 12 бойцов (пользователь 10.10: «добавь ресурсов, покруче»): карта arms-layout рассчитана на дуэль —
// 14 оружия на 12, лава в сундуках. Сундук очищается и набивается заново (seed): оружие железо/алмаз, броня,
// щиты, яблоки, зелья, жемчуг, еда, блоки; тайники — лучше. Нарочно неровно: кому-то два меча, кому-то пусто —
// каптёру есть что делить. ARMS_LOOT=layout — как было.
export function makeStockChests (ctx: ArenaContext) {
  const { i, L, X, Y, Z, rcon, log, sleep } = ctx
  return async (round: number, only: any[] | null = null) => {
    if (process.env.ARMS_LOOT === 'layout') return
    let seed = [...(String(L.seed) + ':' + round)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7)
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
    const pickOne = (arr) => arr[Math.floor(rnd() * arr.length)]
    const pot = (kind, name) => `${kind}[potion_contents={potion:"minecraft:${name}"}]`
    const heal = pot('splash_potion', 'strong_healing')
    const stats: any = { weapons: 0, armor: 0, items: 0 }
    const used = new Map<string, number>()
    for (const c of (only || L.chests)) {
      const hidden = /secret|under|niche/.test(c.kind)
      const mat = () => (rnd() < (SOLO ? 0.75 : hidden ? 0.6 : 0.25) ? 'diamond' : 'iron')
      const gen = () => {
      const items: string[] = []
      // Оружие (пользователь 10.10: «разное — булава, копьё, чарованное; лут как в сундуках Края»): в 80% сундуков, в
      // тайнике — и второе; чары — в 40% (тайник 70%), уровни случайны. Тайник — лут города Края: алмаз, изредка незерит.
      const lv = (max) => 1 + Math.floor(rnd() * max)
      const ench = (base, list) => rnd() < (SOLO ? 1 : hidden ? 0.7 : 0.4) ? `${base}[enchantments={${list.filter(() => rnd() < 0.7).join(',') || list[0]}}]` : base
      const mat2 = () => (SOLO ? rnd() < (hidden ? 0.4 : 0.2) : hidden && rnd() < 0.08) ? 'netherite' : mat()
      // Раунд кристаллов (10.10: «в основном взрывают друг друга») — без оружия в сундуках: бой кристаллами, а не мечом.
      for (let w = 0; w < (process.env.ARMS_CRYSTAL === '1' ? 0 : hidden ? 3 : 2); w++) if (rnd() < 0.8) {
        const kind = pickOne(['sword', 'sword', 'sword', 'axe', 'axe', 'spear', 'spear', 'mace', 'trident', 'bow', 'bow', 'crossbow'])
        const m = mat2()
        if (kind === 'sword') items.push(ench(`${m}_sword`, [`sharpness:${lv(5)}`, `fire_aspect:${lv(2)}`, `knockback:${lv(2)}`, 'sweeping_edge:2']) + ' 1')
        else if (kind === 'axe') items.push(ench(`${m}_axe`, [`sharpness:${lv(5)}`, 'efficiency:3']) + ' 1')
        else if (kind === 'spear') items.push(ench(`${m === 'netherite' ? 'diamond' : m}_spear`, [`sharpness:${lv(5)}`, `knockback:${lv(2)}`]) + ' 1')
        else if (kind === 'mace') items.push(ench('mace', [`density:${lv(5)}`, `breach:${lv(4)}`, 'wind_burst:1']) + ' 1', 'wind_charge 6')
        else if (kind === 'trident') items.push(ench('trident', [`impaling:${lv(5)}`, `loyalty:${lv(3)}`]) + ' 1')
        else if (kind === 'bow') items.push(ench('bow', [`power:${lv(5)}`, `punch:${lv(2)}`, 'flame:1']) + ' 1', 'arrow 32')
        else items.push(ench('crossbow', [`quick_charge:${lv(3)}`, 'multishot:1', `piercing:${lv(4)}`]) + ' 1', 'arrow 32')
        stats.weapons++
      }
      const nArmor = Math.floor(rnd() * (hidden ? 3 : 2)) + 2
      for (let a = 0; a < nArmor; a++) {
        const piece = pickOne(['helmet', 'chestplate', 'leggings', 'boots'])
        items.push(ench(`${mat2()}_${piece}`, [`protection:${lv(4)}`, 'unbreaking:3', ...(piece === 'boots' ? [`feather_falling:${lv(4)}`] : []), ...(piece === 'leggings' ? [`blast_protection:${lv(4)}`] : [])]) + ' 1')
        stats.armor++
      }
      for (let e = 0; e < 2 + (hidden ? 2 : 1); e++) items.push(pickOne(['golden_apple 2', `${heal} 2`, 'shield 1', 'ender_pearl 2', 'cooked_beef 8', 'cobblestone 32', 'golden_apple 1', `${heal} 1`, 'wind_charge 4', 'wind_charge 8']))
      if (hidden && rnd() < 0.12) items.push('enchanted_golden_apple 1')
      // Щит — в каждом втором (10.10: «от булавы без щита не защищаются»; щит держит и смэш булавы).
      if (rnd() < 0.5) items.push('shield 1')
      // Чем уничтожать чужой лут (лава, огонь): ведро лавы, огниво, огненный заряд — иногда.
      if (rnd() < 0.3) items.push(pickOne(['flint_and_steel 1', 'lava_bucket 1', 'fire_charge 3']))
      // Ведро воды (10.10: «гасить урон от падения и тушиться, а то не хватает») — в 45% сундуков.
      if (rnd() < 0.45) items.push('water_bucket 1')
      // Паутина — закрыть проход за собой (10.10).
      if (rnd() < 0.4) items.push('cobweb 4')
      if (rnd() < (SOLO ? (hidden ? 0.5 : 0.2) : hidden ? 0.1 : 0)) items.push('totem_of_undying 1')
      if (SOLO && rnd() < 0.25) items.push('elytra[enchantments={unbreaking:3}] 1', 'firework_rocket 16')
      // Зелья (пользователь 10.10: «больше зелий — хилок и опасных»): лечение чаще всего, вред/яд взрывные, сила/реген.
      for (let e = 0; e < (hidden ? 4 : 3); e++) items.push(pickOne([`${heal} 2`, `${heal} 1`, `${heal} 2`, pot('splash_potion', 'strong_harming') + ' 1', pot('splash_potion', 'harming') + ' 2',
        pot('splash_potion', 'poison') + ' 1', pot('potion', 'strength') + ' 1', pot('potion', 'regeneration') + ' 1']))
      // Баффы (10.10: «больше зелий — усиления на скорость, урон, чтобы ускорялись жёстко и мочили»): в каждом сундуке
      // 2 (тайник 3). Скорость и сила — сверх обычных (Скорость IV, Сила III на 90 с); основа — strong_* (бой их
      // узнаёт по potion и пьёт сам: перед боем и между разменами).
      const fx = (base, id, amp, sec) => `potion[potion_contents={potion:"minecraft:${base}",custom_effects:[{id:"minecraft:${id}",amplifier:${amp},duration:${sec * 20}}]}]`
      for (let e = 0; e < (hidden ? 3 : 2); e++) items.push(pickOne([fx('strong_swiftness', 'speed', 3, 90) + ' 1', fx('strong_swiftness', 'speed', 3, 90) + ' 2', fx('strong_strength', 'strength', 2, 90) + ' 1',
        fx('strong_strength', 'strength', 2, 90) + ' 2', pot('potion', 'strong_regeneration') + ' 1', pot('potion', 'long_fire_resistance') + ' 1', pot('potion', 'strong_turtle_master') + ' 1',
        pot('potion', 'strong_leaping') + ' 1', pot('splash_potion', 'strong_slowness') + ' 1', pot('splash_potion', 'long_weakness') + ' 1']))
      // Соло (12.10: «зелья поразнообразнее — все виды и разной силы»): все зелья реестра 1.21.11 (кроме воды/пустых),
      // вредные — взрывные или оседающие, остальные — чаще питьевые; 3 в сундук, 5 в тайник.
      if (SOLO) for (let e = 0; e < (hidden ? 5 : 3); e++) {
        const id = pickOne(ALL_POTIONS)
        const bad = /harming|poison|slowness|weakness|infested|oozing|weaving/.test(id)
        const r = rnd()
        items.push(pot(bad ? (r < 0.7 ? 'splash_potion' : 'lingering_potion') : r < 0.65 ? 'potion' : r < 0.9 ? 'splash_potion' : 'lingering_potion', id) + ' 1')
      }
      // Алхимия и кузница — по частям в разных сундуках: полный набор только у команды вместе (свозят алхимику).
      if (rnd() < 0.45) items.push(pickOne(['nether_wart 3', 'glistering_melon_slice 3', 'glowstone_dust 3', 'gunpowder 3', 'blaze_powder 2', 'glass_bottle 3', 'fermented_spider_eye 2']))
      if (rnd() < 0.3) items.push(pickOne(['iron_ingot 2', 'diamond 2', 'stick 2']))
      // Кирки (10.10: «добавь в сундуки кирки — ботам не хватает»): ломать стенки, столбы, крышки нычек; и набор на
      // свою кирку — 3 слитка/алмаза, 2 палки, верстак (крафтят сами, если кирки нет).
      if (rnd() < 0.45) items.push(ench(`${mat2()}_pickaxe`, [`efficiency:${lv(5)}`, 'unbreaking:3']) + ' 1')
      if (rnd() < 0.2) items.push(pickOne(['iron_ingot 3', 'diamond 3']), 'stick 2', 'crafting_table 1')
      return items
      }
      const items = gen()
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
      const mine = L.chests.filter(c => c.x * side > 0).sort(() => rnd() - 0.5)
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
    log(`гонка: сундуки набиты (раунд ${round}) — оружия ${stats.weapons}, брони ${stats.armor}, всего предметов ${stats.items}, двойных сундуков ${stats.doubled || 0}/${L.chests.length} (без лавы)`)
  }
}

// Лут пропорционально бойцам (10.10: «30 на 30 — лута пропорционально»): сундук на 27 ячеек больше не вмещает, поэтому
// открытый сундук пополняется заново, пока не выдаст ARMS_LOOT_X наборов за раунд (умолчание — бойцов / 24).
export function startRefills (ctx: ArenaContext) {
  const { arms, N, L, opened, refills, log } = ctx
  const LOOT_X = Number(process.env.ARMS_LOOT_X) || Math.max(1, (N || 24) / 24)
  let refillRound = 0
  return arms && LOOT_X > 1 ? setInterval(async () => {
    if (ctx.between) return
    const due = L.chests.filter(c => { const k = `${c.x},${c.y},${c.z}`; return opened.has(k) && (refills.get(k) || 0) < Math.round(LOOT_X / (c.pair ? 2 : 1)) - 1 }) // двойной — два набора за раз
    if (!due.length) return
    for (const c of due) { const k = `${c.x},${c.y},${c.z}`; refills.set(k, (refills.get(k) || 0) + 1); opened.delete(k) }
    await ctx.stockChests(1000 + ++refillRound, due).catch(() => {})
    log(`🎁 пополнил сундуков ${due.length} (лут ×${LOOT_X.toFixed(1)} на ${N} бойцов)`)
  }, 20000) : null
}
