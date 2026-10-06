'use strict'
const gameClock = require('./game-clock')
const { AsyncLocalStorage } = require('async_hooks')
const assess = require('./assess')
const bedtime = require('./bedtime')
const { WorldMap, ORES } = require('./worldmap')

// Чьё намерение: контекст «это директор» тянется через все await шага, а
// вызовы мозга по WebSocket приходят без него (session.runIntent смотрит сюда).
const owner = new AsyncLocalStorage()
function byDirector () { const st = owner.getStore(); return !!(st && st.director) }

const NIGHT_FROM = 12542
const NIGHT_TO = 23459
const TICK_MS = 1000

function isNight (bot) {
  const t = bot.time && typeof bot.time.timeOfDay === 'number' ? bot.time.timeOfDay : 6000
  return t >= NIGHT_FROM && t <= NIGHT_TO
}

function sleep (ms) { return gameClock.sleep(ms) }

function count (bot, re) {
  let n = 0
  for (const it of bot.inventory.items()) if (typeof re === 'string' ? it.name === re : re.test(it.name)) n += it.count
  return n
}

const WOOL = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const FOOD = /^(cooked_[a-z_]+|bread|baked_potato|golden_carrot|apple|carrot|sweet_berries|melon_slice|pumpkin_pie|golden_apple|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|cookie)$/
const RAW = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon|potato)$/
const PICK = { wooden_pickaxe: 1, stone_pickaxe: 2, golden_pickaxe: 1, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 }

function pickTier (bot) {
  let t = 0
  for (const it of bot.inventory.items()) if (PICK[it.name] > t) t = PICK[it.name]
  return t
}

// ------------------------------------------------------------ обстановка

function situation (d) {
  const bot = d.session.bot
  const e = bot.entity
  const feet = e.position.floored()
  const here = bot.blockAt(feet)
  const head = bot.blockAt(feet.offset(0, 1, 0))
  // Под землёй — это порода над головой, а не полумрак своей ямы.
  let roofed = false
  for (let dy = 2; dy <= 24; dy++) {
    const b = bot.blockAt(feet.offset(0, dy, 0))
    if (!b) break
    if (b.boundingBox === 'block' && !/leaves|log/.test(b.name)) { roofed = true; break }
  }
  const flags = e.metadata && typeof e.metadata[0] === 'number' ? e.metadata[0] : 0
  let fight = null
  try { fight = assess.plan(bot, { radius: 16 }) } catch {}
  const now = gameClock.now()
  return {
    hp: bot.health ?? 20,
    food: bot.food ?? 20,
    oxygen: typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : 20,
    inLava: !!(here && here.name === 'lava') || !!(head && head.name === 'lava'),
    onFire: (flags & 0x01) !== 0,
    inWater: !!e.isInWater,
    y: e.position.y,
    surface: !roofed,
    night: isNight(bot),
    dimension: bot.game ? bot.game.dimension : 'overworld',
    foes: fight && typeof fight.foes === 'number' ? fight.foes : 0,
    verdict: fight ? fight.verdict : 'чисто',
    fight,
    hurtRecently: now - (d.lastHurt || 0) < 4000,
    armed: count(bot, /_(sword|axe)$/) > 0,
    edible: count(bot, FOOD) + count(bot, RAW),
    cooked: count(bot, FOOD),
    raw: count(bot, RAW),
    pick: pickTier(bot),
    free: bot.inventory.emptySlotCount(),
    // Кровать — в рюкзаке или своя, поставленная рядом (bedtime.js её помнит).
    bed: count(bot, /_bed$/) > 0 || ownBedNear(d.session, e.position),
    sleeping: !!bot.isSleeping,
    dusk: (() => { const t = bot.time ? bot.time.timeOfDay : 6000; return t >= bedtime.DUSK_FROM && t < NIGHT_FROM })(),
    day: bot.time && typeof bot.time.day === 'number' ? bot.time.day : 0
  }
}

function ownBedNear (session, pos) {
  if (!session.myBeds || !session.myBeds.size) return false
  for (const k of session.myBeds) {
    const [x, y, z] = k.split(',').map(Number)
    if (Math.abs(x - pos.x) <= 12 && Math.abs(y - pos.y) <= 6 && Math.abs(z - pos.z) <= 12) return true
  }
  return false
}

function sitText (s) {
  const bits = [`хп ${Math.round(s.hp)}`, `еда ${s.food}`]
  if (s.foes) bits.push(`врагов ${s.foes} (${s.verdict})`)
  if (s.night) bits.push('ночь')
  bits.push(s.surface ? 'на поверхности' : `под землёй y=${Math.floor(s.y)}`)
  if (s.inLava) bits.push('В ЛАВЕ')
  if (s.onFire) bits.push('горит')
  if (s.inWater && s.oxygen < 10) bits.push(`тонет (воздух ${s.oxygen})`)
  return bits.join(', ')
}

// ------------------------------------------------------------ цели

function bedStep (d, s, { why, roam = false }: any) {
  const S = d.session
  const bot = S.bot
  const planks = count(bot, /_planks$/)
  const logs = count(bot, /_(log|stem)$/)
  const planksOf = () => {
    const log = bot.inventory.items().find(i => /_(log|stem)$/.test(i.name) && !/^stripped_/.test(i.name))
    return log ? log.name.replace(/_(log|stem)$/, '_planks') : null
  }
  const woolBy = {}
  for (const it of bot.inventory.items()) if (/_wool$/.test(it.name)) woolBy[it.name] = (woolBy[it.name] || 0) + it.count
  const best: any = Object.entries(woolBy).sort((a: any, b: any) => b[1] - a[1])[0]
  if (best && best[1] >= 3 && (planks >= 3 || logs)) {
    if (planks < 3) return { name: 'craft_planks', why: 'доски на кровать', run: () => S.craft({ item: planksOf(), count: 4 }) }
    return { name: 'craft_bed', why, run: () => S.craft({ item: best[0].replace(/_wool$/, '_bed') }) }
  }
  const have = best ? best[0].replace(/_wool$/, '') : null
  const sheep = Object.values(bot.entities).filter((e : any) => e && e.name === 'sheep' && e.position.distanceTo(bot.entity.position) < 40)
    .map((e : any) => { const m = e.metadata && e.metadata[17]; const b = typeof m === 'number' ? m : 0; return { e, color: WOOL[b & 15], sheared: (b & 16) !== 0, d: e.position.distanceTo(bot.entity.position) } })
    .filter(x => !x.sheared)
    .sort((a, b) => ((b.color === have) as any) - ((a.color === have) as any) || a.d - b.d)
  const pick: any = sheep.find(x => !have || x.color === have || (best[1] <= 1))
  if (pick && d.ok('hunt_sheep')) {
    return {
      name: 'hunt_sheep',
      why: `шерсть на кровать: ${have ? `${have} ${best[1]}/3` : '0/3'} — ${pick.color} овца в ${Math.round(pick.d)} м`,
      surfaceWalk: true,
      ok: r => !!(r && r.detail && ((r.detail.kills && r.detail.kills.length) || r.detail.killed || r.detail.picked)),
      run: () => S.fight({ target: `#${pick.e.id}`, timeoutSeconds: 40 })
    }
  }
  // К вечеру без кровати — искать овец: ночь в норе стоит девяти минут.
  const t = bot.time ? bot.time.timeOfDay : 0
  if (roam && t > 8000 && t < 11800 && s.surface && d.ok('roam_animals')) return d.roam('animals', 'к ночи нужна кровать — ищу овец')
  return null
}

// Кровать-точка возрождения (bedtime.js, journal.state.spawnBed): зачем
// поставлена и рядом ли.
function spawnBed (d, radius = 24) {
  const S = d.session
  const sb = S.journal && S.journal.state && S.journal.state.spawnBed
  if (!sb) return null
  const p = S.bot.entity.position
  const near = (S.bot.game ? S.bot.game.dimension : 'overworld') === 'overworld' && Math.abs(sb.x - p.x) <= radius && Math.abs(sb.z - p.z) <= radius && Math.abs(sb.y - p.y) <= 12
  return { ...sb, near }
}

// Шаг: { name, why, prio, run: () => Promise<результат намерения> }.
// Цели — функции (d, s) → шаг | null (null — цель выполнена).
const GOALS: any = {}

GOALS.beat_game = (d, s) => {
  const S = d.session
  const bot = S.bot
  const has = (re) => count(bot, re)
  const logs = has(/_(log|stem)$/)
  const planks = has(/_planks$/)
  const planksOf = () => {
    const log = bot.inventory.items().find(i => /_(log|stem)$/.test(i.name) && !/^stripped_/.test(i.name))
    return log ? log.name.replace(/_(log|stem)$/, '_planks') : null
  }
  // 1. Дерево и деревянная кирка.
  if (s.pick === 0) {
    if (logs + planks / 4 < 4) {
      if (d.ok('mine_log')) return { name: 'mine_log', why: 'нет кирки и мало дерева', run: () => S.mine({ block: 'any_log', count: 8, radius: 48, timeoutSeconds: 150 }) }
      return d.roam('trees', 'деревьев рядом не видно')
    }
    if (planks < 11 && planksOf()) return { name: 'craft_planks', why: 'доски на верстак, палки и кирку', run: () => S.craft({ item: planksOf(), count: 12 }) }
    if (!has('crafting_table') && planks >= 4) return { name: 'craft_table', why: 'нужен верстак', run: () => S.craft({ item: 'crafting_table' }) }
    if (has('stick') < 2) return { name: 'craft_stick', why: 'палки на кирку', run: () => S.craft({ item: 'stick', count: 4 }) }
    return { name: 'craft_wood_pick', why: 'деревянная кирка', run: () => S.craft({ item: 'wooden_pickaxe' }) }
  }
  {
    const picks = bot.inventory.items().filter(i => PICK[i.name])
    const top = picks.sort((a, b) => PICK[b.name] - PICK[a.name])[0]
    if (top) {
      const left = (top.maxDurability || 0) - (top.durabilityUsed || 0)
      const same = picks.filter(i => i.name === top.name).length
      const mat = { wooden_pickaxe: [/_planks$/, 3], stone_pickaxe: [/^(cobblestone|cobbled_deepslate|blackstone)$/, 3], iron_pickaxe: ['iron_ingot', 3], diamond_pickaxe: ['diamond', 3] }[top.name]
      if (top.maxDurability && left < 60 && same === 1 && mat && has(mat[0]) >= mat[1] + (top.name === 'wooden_pickaxe' ? 2 : 0) && d.ok('spare_pick')) {
        if (has('stick') < 2 && planks < 2 && logs) return { name: 'craft_planks', why: 'доски на палки для запасной кирки', run: () => S.craft({ item: planksOf(), count: 4 }) }
        if (has('stick') < 2) return { name: 'craft_stick', why: 'палки на запасную кирку', run: () => S.craft({ item: 'stick', count: 4 }) }
        return { name: 'spare_pick', why: `${top.name}: осталось ${left} ударов — выковать такую же`, run: () => S.craft({ item: top.name }) }
      }
    }
  }
  // 2. Еда — раньше камня: без неё не лечится (FoodData: регенерация с 18).
  if (s.edible < 4 && s.food < 18) return d.foodStep(s)
  // 3. Камень: кирка, меч.
  const cobble = has(/^(cobblestone|cobbled_deepslate|blackstone)$/)
  if (s.pick < 2 || !s.armed) {
    if (cobble < 6) {
      // Как игрок: видно камень — копать его; не видно — вниз лесенкой (под
      // слоем земли камень почти везде); в песке/воде не выходит — искать склон.
      if (d.ok('mine_stone')) return { name: 'mine_stone', why: 'камень на каменные инструменты', run: () => S.mine({ block: 'stone', count: 12, radius: 32, timeoutSeconds: 150 }) }
      if (d.ok('dig_stone')) return { name: 'dig_stone', why: 'камня не видно — вниз лесенкой, под землёй он есть', ok: r => r.detail && r.detail.dug > 0, run: () => S.digDown({ mode: 'stairs', depth: 8, timeoutSeconds: 150 }) }
      return { name: 'explore_stone', why: 'вниз не копается — ищу склон или обрыв', ok: r => r.detail && r.detail.found, run: () => S.explore({ block: 'stone', radius: 48, stepDistance: 80, timeoutSeconds: 120 }) }
    }
    if (!has('crafting_table') && planks < 4 && logs) return { name: 'craft_planks', why: 'доски на верстак', run: () => S.craft({ item: planksOf(), count: 4 }) }
    if (has('stick') < 3 && (planks >= 2 || logs)) return { name: 'craft_stick', why: 'палки', run: () => planks >= 2 ? S.craft({ item: 'stick', count: 4 }) : S.craft({ item: planksOf(), count: 4 }) }
    if (s.pick < 2) return { name: 'craft_stone_pick', why: 'каменная кирка', run: () => S.craft({ item: 'stone_pickaxe' }) }
    return { name: 'craft_stone_sword', why: 'меч — без него не драться', run: () => S.craft({ item: 'stone_sword' }) }
  }
  // 3б. Кровать: ночь проспать, а не сидеть 7 минут в норе (и спавн рядом).
  if (!s.bed) {
    const step = bedStep(d, s, { why: 'кровать — пропускать ночи', roam: true })
    if (step) return step
  }
  // 4. Еда впрок перед шахтой.
  if (s.edible < 8) return d.foodStep(s)
  // 5. Железо: кирка и ведро.
  if (s.pick < 3 || !has(/^(bucket|water_bucket|lava_bucket)$/)) {
    const iron = has(/^(raw_iron|iron_ingot)$/)
    if (has('raw_iron') >= 3 && (has('raw_iron') + has('iron_ingot') >= 6 || iron >= 6)) {
      return { name: 'smelt_iron', why: `переплавить ${has('raw_iron')} руды`, run: () => S.smelt({ item: 'iron_ingot', count: has('raw_iron'), timeoutSeconds: 300 }) }
    }
    if (has('iron_ingot') >= 3 && s.pick < 3) return { name: 'craft_iron_pick', why: 'железная кирка', run: () => S.craft({ item: 'iron_pickaxe' }) }
    if (has('iron_ingot') >= 3) return { name: 'craft_bucket', why: 'ведро', run: () => S.craft({ item: 'bucket' }) }
    if (s.y > ORES.iron.y + 8) return { name: 'descend_iron', why: `железо гуще всего на y=${ORES.iron.y} (данные генерации мира)`, run: () => S.digDown({ mode: 'stairs', depth: Math.min(96, Math.floor(s.y) - ORES.iron.y), timeoutSeconds: 360 }) }
    if (d.ok('mine_seen_iron')) return { name: 'mine_seen_iron', why: 'добрать виденную руду', run: () => S.mineSeen({ block: 'iron_ore', timeoutSeconds: 120 }) }
    return { name: 'tunnel_iron', why: `ищу железо штреком (есть ${iron}, нужно 6)`, run: () => S.tunnel({ direction: d.nextDir(), length: 32, timeoutSeconds: 300 }) }
  }
  // 5б. Щит — за один слиток (плюс 6 досок): стрелы и удары спереди.
  if (!has('shield') && has('iron_ingot') >= 1 && (planks >= 6 || logs >= 2)) {
    if (planks < 6) return { name: 'craft_planks', why: 'доски на щит', run: () => S.craft({ item: planksOf(), count: 8 }) }
    return { name: 'craft_shield', why: 'щит', run: () => S.craft({ item: 'shield' }) }
  }
  // 6. Вода в ведро.
  if (!has('water_bucket')) {
    if (!s.surface && s.y < 50) return { name: 'surface_water', why: 'за водой — наверх', run: () => S.surface({ timeoutSeconds: 360 }) }
    if (d.ok('bucket_water')) return { name: 'bucket_water', why: 'вода на обсидиан', run: () => S.bucket({ fluid: 'water', radius: 32 }) }
    return { name: 'explore_water', why: 'воды не видно', ok: r => r.detail && r.detail.found, run: () => S.explore({ block: 'water', radius: 48, stepDistance: 80, timeoutSeconds: 120 }) }
  }
  // 7. Алмазы.
  if (s.pick < 4) {
    if (has('diamond') >= 3) return { name: 'craft_diamond_pick', why: 'алмазная кирка', run: () => S.craft({ item: 'diamond_pickaxe' }) }
    if (s.y > ORES.diamond.y + 8) return { name: 'descend_diamond', why: `алмазы гуще всего у бедрока, y=${ORES.diamond.y} (данные генерации мира)`, run: () => S.digDown({ mode: 'stairs', depth: Math.min(120, Math.floor(s.y) - ORES.diamond.y), timeoutSeconds: 540 }) }
    if (d.ok('mine_seen_diamond')) return { name: 'mine_seen_diamond', why: 'добрать виденные алмазы', run: () => S.mineSeen({ block: 'deepslate_diamond_ore', timeoutSeconds: 150 }) }
    return { name: 'tunnel_diamond', why: `ищу алмазы (есть ${has('diamond')}, нужно 3)`, run: () => S.tunnel({ direction: d.nextDir(), length: 40, timeoutSeconds: 360 }) }
  }
  // 8. Обсидиан и портал.
  if (!d.memo.portalLit) {
    if (has('obsidian') < 10) {
      if (d.ok('obsidian')) return { name: 'obsidian', why: `обсидиан на раму (есть ${has('obsidian')})`, run: () => S.obsidian({ count: 10 - has('obsidian'), radius: 24, timeoutSeconds: 300 }) }
      return { name: 'tunnel_lava', why: 'лавы не видно — штрек', run: () => S.tunnel({ direction: d.nextDir(), length: 32, timeoutSeconds: 300 }) }
    }
    if (!has('flint_and_steel') && !has('fire_charge')) {
      if (has('flint') && has('iron_ingot')) return { name: 'craft_flint_steel', why: 'огниво', run: () => S.craft({ item: 'flint_and_steel' }) }
      return { name: 'mine_gravel', why: 'кремень из гравия', run: () => S.mine({ block: 'gravel', count: 6, radius: 32, timeoutSeconds: 150 }) }
    }
    if (!s.surface && s.y < 50) return { name: 'surface_portal', why: 'портал — наверху', run: () => S.surface({ timeoutSeconds: 500 }) }
    return { name: 'portal', why: 'строю портал в Ад', run: () => S.portal({ mode: 'build', timeoutSeconds: 300 }).then(r => { if (r && r.detail && r.detail.lit) d.memo.portalLit = true; return r }) }
  }
  // 9+. Ад, крепость, Энд — шаги агентов (fortress/blaze/pearls/stronghold/dragon).
  if (has('blaze_rod') + Math.floor(has('blaze_powder') / 2) + Math.floor(has('ender_eye') / 2) < 6) {
    if (s.dimension !== 'the_nether') {
      const sb = spawnBed(d)
      if (has(/_bed$/) && !(sb && sb.why === 'у портала в Ад' && sb.near) && d.ok('set_spawn')) {
        return { name: 'set_spawn', why: 'перед Адом — точка возрождения у портала (в Аду кровать всё равно взрывается)', ok: r => !!(r && r.detail && r.detail.set), run: () => S.sleepInBed({ mode: 'spawn', why: 'у портала в Ад' }) }
      }
      return { name: 'enter_nether', why: 'в Ад за стержнями', run: () => S.portal({ mode: 'enter', timeoutSeconds: 120 }) }
    }
    if (!d.memo.fortress) return { name: 'fortress', why: 'ищу крепость Ада', run: () => S.fortress({ timeoutSeconds: 300 }).then(r => { if (r && r.detail && r.detail.found) d.memo.fortress = r.detail.found; return r }) }
    return { name: 'blaze', why: 'стержни с блейзов', run: () => S.blaze({ rods: 7, timeoutSeconds: 400 }) }
  }
  if (has('ender_pearl') + has('ender_eye') < 12) return { name: 'pearls', why: `жемчуг (есть ${has('ender_pearl')})`, run: () => S.pearls({ count: 12 - has('ender_eye'), timeoutSeconds: 400 }) }
  if (has('ender_eye') < 12) {
    if (has('blaze_powder') < 12 - has('ender_eye')) return { name: 'craft_powder', why: 'порошок', run: () => S.craft({ item: 'blaze_powder', count: 12 }) }
    return { name: 'craft_eyes', why: 'очи эндера', run: () => S.craft({ item: 'ender_eye', count: 12 - has('ender_eye') }) }
  }
  if (s.dimension === 'the_nether') return { name: 'leave_nether', why: 'домой из Ада', run: () => S.portal({ mode: 'enter', timeoutSeconds: 120 }) }
  // Из Ада вернулись — кровать от портала с собой: дальше путь к крепости.
  {
    const sb = spawnBed(d)
    if (sb && sb.why === 'у портала в Ад' && sb.near && d.ok('take_bed')) {
      return { name: 'take_bed', why: 'Ад позади — забираю кровать от портала', ok: r => !!(r && r.detail && r.detail.took), run: () => S.sleepInBed({ mode: 'take' }) }
    }
  }
  if (has(/_bed$/) < 3) {
    const step = bedStep(d, s, { why: `кровать на Энд (есть ${has(/_bed$/)}): точка у портала + взрывы по дракону` })
    if (step) return step
  }
  if (!d.memo.stronghold) return { name: 'stronghold_find', why: 'где крепость', run: () => S.stronghold({ mode: 'find', timeoutSeconds: 400 }).then(r => { if (r && r.detail && (r.detail.at || r.detail.estimate)) d.memo.stronghold = r.detail.at || r.detail.estimate; return r }) }
  if (!d.memo.endPortal) return { name: 'stronghold_room', why: 'дойти и найти портальную комнату', run: () => S.stronghold({ mode: 'room', timeoutSeconds: 500 }).then(r => { if (r && r.detail && r.detail.room) d.memo.endPortal = r.detail.room; return r }) }
  if (s.dimension === 'overworld' && !d.memo.dragonWon && has(/_bed$/)) {
    const sb = spawnBed(d, 32)
    if (!(sb && sb.why === 'у портала в Энд' && sb.near) && d.ok('set_spawn_end')) {
      return { name: 'set_spawn_end', why: `перед Эндом — точка у портала; на дракона останется ${has(/_bed$/) - 1} кроватей`, ok: r => !!(r && r.detail && r.detail.set), run: () => S.sleepInBed({ mode: 'spawn', why: 'у портала в Энд' }) }
    }
  }
  // Без enter:true fill только зажигает портал и не входит — цикл «уже горит».
  if (s.dimension !== 'the_end' && !d.memo.dragonWon) return { name: 'stronghold_fill', why: 'вставить очи и войти', ok: r => !!(r && r.detail && (r.detail.entered || r.detail.lit)), run: () => S.stronghold({ mode: 'fill', enter: true, timeoutSeconds: 200 }) }
  if (d.memo.dragonWon) return null
  // Бой продолжается с состояния мира: таймаут — позвать ещё раз.
  return {
    name: 'dragon',
    why: 'дракон',
    ok: r => !!(r && ((r.detail && r.detail.dragon && r.detail.dragon.won) || r.status === 'timeout')),
    run: () => S.dragon({ timeoutSeconds: 600 }).then(r => {
      if (r && r.detail && r.detail.dragon && r.detail.dragon.won) { d.memo.dragonWon = true; d.note('ДРАКОН УБИТ') }
      return r
    })
  }
}

// Просто собрать еду.
GOALS.food = (d, s) => (s.edible >= 12 ? null : d.foodStep(s))

// Держаться у точки и выживать (мозг занят разговором, тело не скучает).
GOALS.idle = () => null

// ------------------------------------------------------------ директор

class Director {
  declare session: any
  declare on: any
  declare loopToken: any
  declare goal: any
  declare rules: any
  declare step: any
  declare history: any
  declare fails: any
  declare memo: any
  declare dirs: any
  declare dirI: any
  declare lastHurt: any
  declare brainQuietUntil: any
  declare hooked: any
  declare map: any
  declare recoverTries: any
  declare roamHeading: any
  declare scoutAt: any
  declare sleepSkipDay: any
  declare idle: any
  declare lastStepName: any

  constructor (session) {
    this.session = session
    this.on = false
    this.loopToken = null
    this.goal = 'beat_game'
    this.rules = { sleepAtNight: true, flee: true }
    this.step = null
    this.history = []
    this.fails = new Map()
    this.memo = {}
    this.dirs = ['north', 'east', 'south', 'west']
    this.dirI = 0
    this.lastHurt = 0
    this.brainQuietUntil = 0
    this.hooked = null
    this.map = new WorldMap(session.cfg && session.cfg.memoryDir)
    this.recoverTries = new Map()
  }

  nextDir () { return this.dirs[this.dirI++ % 4] }

  // Последняя незабранная смерть в этом мире, за которой стоит сходить.
  deathLoot (s) {
    const S = this.session
    const deaths = (S.journal && S.journal.state && S.journal.state.deaths) || []
    for (let i = deaths.length - 1; i >= Math.max(0, deaths.length - 3); i--) {
      const d = deaths[i]
      if (!d || d.recovered || !d.pos || typeof d.pos.x !== 'number') continue
      if ((d.dimension || 'overworld') !== s.dimension) continue
      // Сколько куча тикала (lootclock.js); нет счёта — настенные часы.
      const age = gameClock.wall.now() - Date.parse(d.at)
      const ticked = typeof d.ticking === 'number' ? d.ticking : null
      if (ticked !== null ? ticked >= 280 : !(age < 5 * 60000)) continue
      if (!(age < 3 * 3600000)) continue
      if ((this.recoverTries.get(d.at) || 0) >= 2) continue
      const p = S.bot.entity.position
      if (s.pick === 0 && (d.pos.y < p.y - 2 || Math.hypot(d.pos.x - p.x, d.pos.z - p.z) > 64)) continue
      // Цена кучи против дороги: записан рюкзак (session death) — дальше 64
      if (Array.isArray(d.bag) && d.bag.length && Math.hypot(d.pos.x - p.x, d.pos.z - p.z) > 64) {
        const pack = require('./pack')
        const top = Math.max(0, ...d.bag.map(it => pack.worth(it.name)))
        const sum = d.bag.reduce((n, it) => n + pack.worth(it.name) * Math.min(16, it.count), 0)
        if (top < 3 && sum < 24) continue
      }
      if (Math.max(0, p.y - d.pos.y) * 8 + 30 > 300 - (typeof d.ticking === 'number' ? d.ticking : 0)) continue
      const dist = Math.round(Math.hypot(d.pos.x - p.x, d.pos.z - p.z))
      if (dist > 600) continue
      if (s.night || s.hp < 12 || !this.ok('recover')) return null
      const t = S.bot.time ? S.bot.time.timeOfDay : 0
      const left = t < 12000 ? 12000 - t : (t > NIGHT_TO ? 24000 - t + 12000 : 0)
      if ((dist / 4 + 30) * 20 > left) return null
      return { index: i, at: d.at, dist, pos: d.pos }
    }
    return null
  }

  // Шаг не отложен (не проваливался 3 раза подряд в последние 5 минут).
  ok (name) {
    const f = this.fails.get(name)
    return !f || f.n < 3 || gameClock.now() - f.at > 300000
  }

  foodStep (s) {
    const S = this.session
    const bot = S.bot
    if (s.raw > 0 && s.cooked < 6) {
      const log = bot.inventory.items().find(i => /_(log|stem)$/.test(i.name))
      const plank = bot.inventory.items().find(i => /_planks$/.test(i.name) && count(bot, i.name) > 8)
      const fuel = count(bot, /^(coal|charcoal)$/) ? undefined
        : (log && count(bot, log.name) > 2 ? log.name : (plank ? plank.name : undefined))
      const raw = bot.inventory.items().find(i => RAW.test(i.name))
      // Печка: в рюкзаке, рядом или из 8 булыжника. Без неё cook падал трижды
      // «не хватает камня (1 из 8)» — сначала камень, раз кирка есть.
      const cobble = count(bot, /^(cobblestone|cobbled_deepslate|blackstone)$/)
      const furnace = count(bot, 'furnace') > 0 || !!bot.findBlock({ matching: b => b && b.name === 'furnace', maxDistance: 32 })
      if (raw && !furnace && cobble < 8 && s.pick >= 1) {
        if (this.ok('mine_stone')) return { name: 'mine_stone', why: `печь пожарить ${raw.name} — булыжника ${cobble} из 8`, run: () => S.mine({ block: 'stone', count: 10, radius: 32, timeoutSeconds: 150 }) }
        if (this.ok('dig_stone')) return { name: 'dig_stone', why: 'камень на печь — вниз лесенкой', ok: r => r.detail && r.detail.dug > 0, run: () => S.digDown({ mode: 'stairs', depth: 8, timeoutSeconds: 150 }) }
      }
      if (raw && (furnace || cobble >= 8) && this.ok('cook')) return { name: 'cook', why: `пожарить ${raw.name}`, run: () => S.smelt({ item: raw.name === 'potato' ? 'baked_potato' : `cooked_${raw.name}`, count: count(bot, raw.name), fuel, timeoutSeconds: 200 }) }
    }
    // Видно животное — охота; нет — пройтись по поверхности.
    const near = Object.values(bot.entities).filter((e : any) => e && /^(cow|pig|sheep|chicken|rabbit)$/.test(e.name) && e.position.distanceTo(bot.entity.position) < 32)
    // Без кровати — сначала овцы: шерсть на кровать заодно с мясом.
    const prey: any = (!s.bed && near.find((e : any) => e.name === 'sheep')) || near.sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    // Охота засчитана, только если кого-то убил: «бой кончился» за 7 с у
    // коровы за забором — это не охота (директор 2026-09-25: полчаса по кругу).
    if (prey && this.ok('hunt')) {
      return {
        name: 'hunt',
        why: `еды мало (${s.edible}) — ${prey.name} рядом`,
        surfaceWalk: true,
        ok: r => !!(r && r.detail && ((r.detail.kills && r.detail.kills.length) || r.detail.killed || r.detail.picked)),
        run: () => S.fight({ target: prey.name, purpose: 'food', timeoutSeconds: 40 })
      }
    }
    if (!s.surface) {
      if (s.pick === 0 && this.ok('cave_escape')) return { name: 'cave_escape', why: 'за едой — наверх, а кирки нет: пещерой', surfaceWalk: true, ok: r => !!(r && r.detail && r.detail.out), run: () => this.caveEscape() }
      return { name: 'surface_food', why: 'за едой — наверх', surfaceWalk: true, run: () => S.surface({ timeoutSeconds: 300 }) }
    }
    return this.roam('animals', 'животных не видно')
  }

  roam (want, because) {
    const S = this.session
    const bot = S.bot
    // Бродить — только поверху. Из-под горы goto к чанку вёл по пещерам: прогон
    // 2026-09-25, y=87 «под землёй», roam_animals → четыре моба, 2 хп.
    let here = null
    try { here = situation(this) } catch {}
    if (here && !here.surface && (bot.game ? bot.game.dimension : 'overworld') === 'overworld') {
      if (here.pick === 0 && this.ok('cave_escape')) return { name: 'cave_escape', why: `${because} — под землёй без кирки: пещерой наверх`, surfaceWalk: true, ok: r => !!(r && r.detail && r.detail.out), run: () => this.caveEscape() }
      return { name: 'surface', why: `${because} — сначала наверх, по пещерам не брожу`, surfaceWalk: true, run: () => S.surface({ timeoutSeconds: 240 }) }
    }
    const dim = bot.game ? bot.game.dimension : 'overworld'
    const t = this.map.frontier(dim, bot.entity.position, { want, maxSteps: 16, heading: this.roamHeading || null })
    if (!t) return { name: `roam_${want}`, why: `${because}, а неразведанного рядом нет`, surfaceWalk: true, run: () => S.explore({ radius: 48, stepDistance: 100, timeoutSeconds: 120 }) }
    const p = bot.entity.position
    const dx = t.x - p.x
    const dz = t.z - p.z
    const far = Math.hypot(dx, dz)
    const leg = far > 72 ? { x: Math.round(p.x + dx / far * 64), z: Math.round(p.z + dz / far * 64) } : { x: t.x, z: t.z }
    if (far > 1) this.roamHeading = { x: dx / far, z: dz / far }
    return {
      name: `roam_${want}`,
      why: `${because} — иду в чанк ${t.cx},${t.cz} (${t.why}, ${t.steps} чанков${far > 72 ? `, отрезок 64 из ${Math.round(far)}` : ''})`,
      surfaceWalk: true,
      ok: r => r && r.status === 'done',
      run: () => S.goto({ x: leg.x, z: leg.z, range: 6, timeoutSeconds: 120 })
    }
  }

  // Что вижу вокруг — подсказки на карту: деревья, вода, лава, камень,
  // животные. Честно: только то, что видно глазами (canSeeBlock).
  scout () {
    const bot = this.session.bot
    const dim = bot.game ? bot.game.dimension : 'overworld'
    this.map.visit(dim, bot.entity.position)
    if (gameClock.now() - (this.scoutAt || 0) < 10000) return
    this.scoutAt = gameClock.now()
    const R = bot.registry.blocksByName
    const groups = {
      trees: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log'],
      water: ['water'],
      lava: ['lava'],
      stone: ['stone']
    }
    for (const [what, names] of Object.entries(groups)) {
      const ids = names.map(n => R[n] && R[n].id).filter(x => x !== undefined)
      let found = []
      try { found = bot.findBlocks({ matching: ids, maxDistance: 32, count: 12 }) } catch {}
      for (const p of found) {
        const b = bot.blockAt(p)
        let seen = false
        try { seen = b && bot.canSeeBlock(b) } catch {}
        if (seen) { this.map.hint(dim, p, what); break }
      }
    }
    for (const e of (Object.values(bot.entities) as any)) {
      if (e && /^(cow|pig|sheep|chicken|rabbit)$/.test(e.name) && e.position.distanceTo(bot.entity.position) < 32) { this.map.hint(dim, e.position, 'animals'); break }
    }
  }

  // Что делать прямо сейчас: критично → срочно → цель.
  decide (s) {
    const S = this.session
    const bot = S.bot
    // КРИТИЧНО.
    if (s.inLava || (s.onFire && !s.inWater)) return { prio: 'критично', name: 'escape_fire', why: s.inLava ? 'в лаве' : 'горю', run: () => this.escapeFire() }
    if (s.inWater && s.oxygen < 8) return { prio: 'критично', name: 'surface_air', why: `тону, воздуха ${s.oxygen}`, run: () => this.swimUp() }
    if (s.hp <= 6 && s.foes > 0 && this.rules.flee) return { prio: 'критично', name: 'flee', why: `${Math.round(s.hp)} хп, враги рядом`, run: () => S.flee({ timeoutSeconds: 40 }) }
    // СРОЧНО.
    if (s.foes > 0 && (s.hurtRecently || (s.fight && s.fight.first && s.fight.first.dist < 6))) {
      const first = s.fight && s.fight.first
      if (first && first.swelling) return { prio: 'срочно', name: 'flee_creeper', why: 'крипер шипит', run: () => S.flee({ timeoutSeconds: 15 }) }
      if (s.armed && s.hp >= 10 && s.verdict !== 'уходить') return { prio: 'срочно', name: 'fight', why: s.fight ? s.fight.text : 'бьют', run: () => S.fight({ timeoutSeconds: 45, retreatAtHealth: 7 }) }
      if (this.rules.flee) return { prio: 'срочно', name: 'flee', why: s.armed ? `${s.verdict}: ${s.fight ? s.fight.text : ''}` : 'бьют, а меча нет', run: () => S.flee({ timeoutSeconds: 40 }) }
    }
    if (s.hp < 20 && s.food < 18 && s.edible > 0 && s.foes === 0) return { prio: 'срочно', name: 'eat', why: `ранен (${Math.round(s.hp)}), сытость ${s.food} — без 18 не лечусь`, run: () => S.eat({}) }
    if (s.food <= 6 && s.edible > 0) return { prio: 'срочно', name: 'eat', why: `голоден (${s.food})`, run: () => S.eat({}) }
    if (s.sleeping) return { prio: 'срочно', name: 'sleep', why: 'в кровати — жду утра', run: () => S.sleepInBed({ untilMorning: true }) }
    if (this.rules.sleepAtNight && s.dimension === 'overworld' && s.bed && (s.night || (s.dusk && s.surface)) &&
        this.sleepSkipDay !== s.day && this.ok('sleep')) {
      return {
        prio: 'срочно',
        name: 'sleep',
        why: s.night ? 'ночь — спать' : 'сумерки — ставлю кровать, лягу с темнотой',
        ok: r => !!(r && r.detail && (r.detail.morning || r.detail.sleeping)),
        run: async () => {
          const r = await S.sleepInBed({ untilMorning: true })
          // Ночь не проскочила — не спят другие; до следующей ночи не пытаться.
          if (r && r.detail && r.detail.othersAwake) { this.sleepSkipDay = s.day; this.note('ночь не проскочила — другие не спят') }
          return r
        }
      }
    }
    if (s.night && s.surface && this.rules.sleepAtNight && s.dimension === 'overworld') {
      return { prio: 'срочно', name: 'night_shelter', why: s.bed ? 'кровать не помогла — в нору до утра' : 'ночь на поверхности, кровати нет — в нору до утра', run: () => this.nightShelter() }
    }
    // Отлежаться имеет смысл только сытым: FoodData лечит с 18 сытости. Ниже —
    // стоять без толку (прогон 2026-09-25: «rest» на 8 хп при сытости 16).
    if (s.hp < 10 && s.foes === 0 && s.food >= 18) return { prio: 'срочно', name: 'rest', why: `${Math.round(s.hp)} хп — отлежаться`, run: () => this.rest() }
    // Ночью за едой поверху не ходить — до утра голод не убьёт (сытость > 6).
    if (s.hp < 10 && s.foes === 0 && s.food < 18 && s.edible === 0 && !(s.night && s.food > 6 && s.dimension === 'overworld')) {
      const f = this.foodStep(s)
      if (f) return { ...f, prio: 'срочно', why: `${Math.round(s.hp)} хп, сытость ${s.food} — без еды не лечусь: ${f.why}` }
    }
    const loot = this.deathLoot(s)
    // Далёкая куча: сначала подойти поверху (там она не стареет — чанк стоит),
    // recover берёт дорогу не длиннее 280 с.
    if (loot && loot.dist > 150) {
      return {
        prio: 'срочно',
        name: 'recover_walk',
        why: `к вещам на месте смерти — ${loot.dist} блоков, подхожу поверху`,
        surfaceWalk: true,
        ok: r => !!(r && r.status === 'done'),
        run: () => {
          // Отрезками по 64: дальний путь pathfinder не решает целиком.
          const p = S.bot.entity.position
          const dx = loot.pos.x - p.x
          const dz = loot.pos.z - p.z
          const far = Math.hypot(dx, dz)
          if (far > 180) return S.goto({ x: Math.round(p.x + dx / far * 64), z: Math.round(p.z + dz / far * 64), range: 6, timeoutSeconds: 120 })
          return S.goto({ x: loot.pos.x, y: loot.pos.y, z: loot.pos.z, range: 110, timeoutSeconds: 240 })
        }
      }
    }
    if (loot) {
      return {
        prio: 'срочно',
        name: 'recover',
        why: `вещи на месте смерти — ${loot.dist} блоков`,
        ok: r => !!(r && r.detail && r.detail.gained && Object.keys(r.detail.gained).length),
        run: () => { this.recoverTries.set(loot.at, (this.recoverTries.get(loot.at) || 0) + 1); return S.recoverLoot({ index: loot.index, timeoutSeconds: 240 }) }
      }
    }
    if (s.free <= 2 && s.foes === 0 && s.hp >= 12 && s.food >= 18 && bot.entity.onGround && this.ok('repair_tools')) {
      try {
        const pair = require('./conversions/repair').repairOptions(S)
        const anvil = pair?.mechanism === 'anvil' && bot.experience.level >= 2 && bot.findBlock({ matching: b => /^(chipped_|damaged_)?anvil$/.test(b.name), maxDistance: 4 })
        if (pair && (pair.mechanism === 'craft' || anvil)) return { prio: 'обычно', name: 'repair_tools',
          why: `освободить ячейку и восстановить ${pair.first.name}`, ok: r => !!r?.detail?.repaired,
          run: () => S.craft({ item: pair.first.name, repair: true }) }
      } catch {}
    }
    // ЦЕЛЬ.
    const g = GOALS[this.goal]
    if (!g) return null
    const step = g(this, s)
    if (step) step.prio = 'цель'
    // Бродить по поверхности ночью — к мобам в темноте: переждать.
    if (step && step.surfaceWalk && s.night && s.dimension === 'overworld') {
      // Уже под крышей (своя нора, пещерный карман) — сидеть, а не вылезать и
      // не копать новую: прогон 2026-09-25 вылез из закрытой норы ночью.
      if (!s.surface) return { prio: 'срочно', name: 'wait_night', why: `ночь, я под крышей — ${step.name} подождёт до утра`, run: () => this.waitNight() }
      return { prio: 'срочно', name: 'night_shelter', why: `ночь — ${step.name} подождёт до утра`, run: () => this.nightShelter() }
    }
    return step
  }

  // ------------------------------------------------------ свои короткие дела

  // Module function: the tactics call it without a Director (was Director.prototype.escapeFire.call({ session }, ctl)).
  escapeFire (ctl: any = null) { return escapeFire(this.session, ctl) }

  async swimUp () {
    const bot = this.session.bot
    bot.setControlState('jump', true)
    await sleep(1500)
    bot.setControlState('jump', false)
    return { status: 'done', detail: { how: 'всплыл' } }
  }

  caveEscape () {
    const S = this.session
    return S.runIntent('cave_escape', async (ctl) => {
      const bot = S.require()
      const { goals, Movements } = require('mineflayer-pathfinder')
      const m = new Movements(bot)
      m.canDig = true
      m.allowSprinting = false
      m.allow1by1towers = bot.inventory.items().some(i => /^(dirt|cobblestone|cobbled_deepslate|gravel|sand|netherrack|.*_planks)$/.test(i.name))
      bot.pathfinder.setMovements(m)
      const startY = Math.floor(bot.entity.position.y)
      const sky = (n) => {
        for (let dy = 1; dy <= 40; dy++) {
          const b = bot.blockAt(n.offset(0, dy, 0))
          if (!b) return true
          if (b.boundingBox === 'block' && !/leaves/.test(b.name)) return false
        }
        return true
      }
      const goal = new goals.Goal()
      goal.heuristic = (n) => Math.max(0, startY + 40 - n.y) * 0.8
      goal.isEnd = (n) => n.y >= startY + 3 && sky(n)
      goal.hasChanged = () => false
      goal.isValid = () => true
      let err = null
      let timer = null
      try {
        await Promise.race([
          bot.pathfinder.goto(goal),
          new Promise((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), 150000) }),
          new Promise((_resolve, reject) => { ctl.onAbort.push(() => reject(new Error('прервано'))) })
        ])
      } catch (e) { err = e.message } finally { gameClock.clearTimeout(timer); try { bot.pathfinder.setGoal(null) } catch {}; S.updateMovements(true) }
      const y = Math.floor(bot.entity.position.y)
      return { from: startY, y, out: sky(bot.entity.position.floored()), stopped: err || undefined }
    }, { timeoutMs: 160000 })
  }

  async waitNight () {
    const S = this.session
    for (let i = 0; i < 30 && this.on && isNight(S.bot); i++) {
      await S.wait({ seconds: 20 })
      if (this.lastHurt && gameClock.now() - this.lastHurt < 3000) break
    }
    return { status: 'done', detail: { waited: true } }
  }

  // Нора на твёрдом: на песке и гравии «сверху осыпается» — отойти на дёрн,
  // землю или камень и копать там (до трёх мест).
  async nightShelter () {
    const S = this.session
    const bot = S.bot
    let r = await S.shelter({ mode: 'enter', depth: 2 })
    for (let i = 0; i < 3 && this.on && !(r && r.detail && r.detail.sealed); i++) {
      if (this.lastHurt && gameClock.now() - this.lastHurt < 3000) break
      const here = bot.entity.position
      const firm = bot.findBlocks({
        matching: b => b && /^(grass_block|dirt|coarse_dirt|podzol|stone|deepslate|andesite|diorite|granite|tuff|mud|clay|terracotta)$/.test(b.name),
        maxDistance: 16,
        count: 40
      }).filter(p => {
        if (p.distanceTo(here) < 3) return false
        const a = bot.blockAt(p.offset(0, 1, 0))
        const b = bot.blockAt(p.offset(0, 2, 0))
        return a && b && a.boundingBox === 'empty' && b.boundingBox === 'empty' && !/water|lava/.test(a.name)
      }).sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0]
      if (!firm) break
      await S.goto({ x: firm.x, y: firm.y + 1, z: firm.z, range: 0, timeoutSeconds: 20 })
      r = await S.shelter({ mode: 'enter', depth: 2 })
    }
    // Ждём утра короткими ожиданиями: каждое будит урон и чат.
    for (let i = 0; i < 30 && this.on && isNight(S.bot); i++) {
      await S.wait({ seconds: 20 })
      if (this.lastHurt && gameClock.now() - this.lastHurt < 3000) break
    }
    await S.shelter({ mode: 'exit' })
    return r
  }

  async rest () {
    const S = this.session
    for (let i = 0; i < 8 && this.on && (S.bot.health ?? 20) < 16; i++) {
      if (this.lastHurt && gameClock.now() - this.lastHurt < 3000) break
      await S.wait({ seconds: 10 })
    }
    return { status: 'done' }
  }

  // ------------------------------------------------------------ цикл

  hook () {
    const bot = this.session.bot
    if (!bot || this.hooked === bot) return
    this.hooked = bot
    let last = bot.health ?? 20
    bot.on('health', () => {
      const hp = bot.health ?? 20
      if (hp < last) this.lastHurt = gameClock.now()
      last = hp
    })
    bot.on('chat', (u) => { if (u !== bot.username) this.brainQuietUntil = gameClock.now() + 20000 })
  }

  // Мозг ведёт тело своим намерением — не мешать.
  brainHolds () {
    const cur = this.session.current
    return !!(cur && !cur.byDirector && cur.name !== 'wait')
  }

  // Аварийный отход (autopilot.emergency → survival.refuge) идёт — шаг директора его оборвал бы (research/dev-B-refuge.md,
  // правка 6): и когда отход записан в current, и когда автопилот ещё отпускает руки перед ним (refuging).
  refugeRuns () {
    const cur = this.session.current
    return !!((cur && cur.name === 'refuge') || this.session.reflex || (this.session.autopilot && this.session.autopilot.refuging))
  }

  start ({ goal, rules }: any = {}) {
    if (goal) {
      if (!GOALS[goal]) throw new Error(`не знаю цель ${goal}: ${Object.keys(GOALS).join(', ')}`)
      this.goal = goal
    }
    if (rules && typeof rules === 'object') Object.assign(this.rules, rules)
    if (this.on) return this.status()
    this.on = true
    const token = this.loopToken = {}
    this.loop(token).catch(e => {
      if (this.loopToken !== token) return
      this.note(`цикл упал: ${e.message}`); this.on = false
    })
    return this.status()
  }

  stop () {
    this.on = false
    this.loopToken = null
    const cur = this.session.current
    if (cur && cur.byDirector && cur.ctl) { try { cur.ctl.abort() } catch {} }
    return this.status()
  }

  note (text) {
    this.history.push({ at: new Date().toISOString().slice(11, 19), text })
    if (this.history.length > 30) this.history.shift()
  }

  status () {
    const bot = this.session.bot
    let s = null
    try { if (bot && bot.entity) s = situation(this) } catch {}
    return {
      on: this.on,
      goal: this.goal,
      rules: this.rules,
      step: this.step ? { name: this.step.name, why: this.step.why, prio: this.step.prio, since: this.step.since } : null,
      situation: s ? sitText(s) : null,
      blocked: [...this.fails.entries()].filter(([, f]) => f.n >= 3 && gameClock.now() - f.at < 300000).map(([n]) => n),
      recent: this.history.slice(-10),
      memo: this.memo,
      text: this.on
        ? `директор: цель ${this.goal}; сейчас ${this.step ? `${this.step.name} (${this.step.prio}: ${this.step.why})` : 'выбираю'}; ${s ? sitText(s) : ''}`
        : 'директор выключен'
    }
  }

  async loop (token = this.loopToken) {
    const S = this.session
    while (this.on && this.loopToken === token) {
      await sleep(TICK_MS)
      if (!this.on || this.loopToken !== token) break
      const bot = S.bot
      if (!bot || !bot.entity || (bot.health ?? 0) <= 0) continue
      this.hook()
      if (this.brainHolds() || this.refugeRuns()) { this.step = null; continue }
      if (S.tactics?.snapshot().requireObservation) await S.observe()
      // Кто-то говорит — дать мозгу ответить (он решит, продолжать ли).
      if (gameClock.now() < this.brainQuietUntil && S.brainAttached) continue
      try { this.scout() } catch {}
      let s
      try { s = situation(this) } catch { continue }
      const step = this.decide(s)
      if (!step) { this.step = null; if (this.goal !== 'idle') this.note(`цель ${this.goal} выполнена`); this.goal = 'idle'; continue }
      step.since = new Date().toISOString().slice(11, 19)
      if (!this.step || this.step.name !== step.name) {
        S.bus.emit('director', { step: step.name, prio: step.prio, why: step.why, text: `директор: ${step.name} — ${step.why}` })
      }
      this.step = step
      // Отпечаток до шага: рюкзак и клетка. Шаг, который трижды подряд ничего
      // не изменил, — провал, что бы он сам ни говорил.
      const sig = () => {
        const p = bot.entity.position
        return bot.inventory.items().map(i => `${i.name}${i.count}`).sort().join(',') + `|${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`
      }
      const before = sig()
      let r = null
      try {
        r = await owner.run({ director: true }, () => step.run())
      } catch (e) {
        r = { status: 'failed', error: e.message }
      }
      if (!this.on || this.loopToken !== token) break
      // Шаг сам говорит, что считать успехом (ok), иначе — общее правило.
      const bad = step.ok
        ? !(r && r.status !== 'failed' && step.ok(r))
        : !r || r.status === 'failed' || r.status === 'timeout' || r.status === 'interrupted' ||
          (r.detail && (r.detail.need || (typeof r.detail.stopped === 'string' && !r.partial && r.detail.dug === 0)))
      const same = (() => { try { return sig() === before } catch { return false } })()
      this.idle = same && this.lastStepName === step.name ? (this.idle || 0) + 1 : 0
      this.lastStepName = step.name
      const stuck = this.idle >= 2
      const f = this.fails.get(step.name) || { n: 0, at: 0 }
      if (bad || stuck) { f.n++; f.at = gameClock.now(); this.fails.set(step.name, f) } else this.fails.delete(step.name)
      if (stuck && f.n === 3) this.note(`${step.name}: трижды без перемен — откладываю`)
      this.note(`${step.name}: ${r ? r.status : '?'}${r && r.error ? ' — ' + r.error : ''}${r && r.detail && r.detail.stopped ? ' — ' + r.detail.stopped : ''}`.slice(0, 200))
      if (r && r.by && r.by.type === 'death') this.note('умер')
    }
    if (!this.on || this.loopToken === token) this.step = null
  }
}

async function escapeFire (session, ctl: any = null) {
  const bot = session.bot
  ctl ||= require('./reflex-lock').owner(session)?.ctl || { aborted: false, onAbort: [] }
  const rescue = require('./tactics/lava-escape')
  if (rescue.inLava(bot)) {
    const air = require('./combat/emergency-escape').createEmergencyEscape(bot)
    const capabilities = air.snapshot()
    for (const kind of ['flight', 'pearl']) {
      if (ctl.aborted) return { status: 'interrupted', detail: { how: 'lava rescue interrupted' } }
      if (!capabilities[kind === 'flight' ? 'flightReady' : 'pearlReady']) continue
      const result = await air.run(ctl, kind)
      if (result.ok && !rescue.inLava(bot)) return { status: 'done', detail: { how: kind, ...result } }
    }
    const kit = require('./fightkit')
    if (!kit.hasEffect(bot, 'fire_resistance') && rescue.lavaCapabilities(session).potion) await rescue.drinkFireResistance(session, ctl)
    if (kit.hasEffect(bot, 'fire_resistance')) {
      const result = await rescue.climbFromLava(session, ctl)
      return { status: result.ok ? 'done' : ctl.aborted ? 'interrupted' : 'failed', detail: result }
    }
    const result = await require('./unstuck').RUNGS.swimOutLava({ bot, session: session, ctl, sleep })
    const escaped = !rescue.inLava(bot) && bot.entity.onGround
    return { status: escaped ? 'done' : ctl.aborted ? 'interrupted' : 'failed', detail: { ...result, escaped } }
  }
  const nether = /nether/.test(String((bot.game && bot.game.dimension) || ''))
  const bucket = nether ? null : bot.inventory.items().find(i => i.name === 'water_bucket')
  if (bucket) {
    try { await bot.equip(bucket, 'hand'); await bot.look(bot.entity.yaw, -Math.PI / 2, true); bot.activateItem() } catch {}
    await sleep(600)
    return { status: 'done', detail: { how: 'вода из ведра' } }
  }
  const me = bot.entity.position.floored()
  let best = null
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (const dy of [0, 1, -1]) {
        const c = me.offset(dx, dy, dz)
        const b = bot.blockAt(c)
        const f = bot.blockAt(c.offset(0, -1, 0))
        if (!b || !f || b.name === 'lava' || b.boundingBox !== 'empty' || f.boundingBox !== 'block') continue
        const dd = Math.hypot(dx, dz)
        if (!best || dd < best.dd) best = { c, dd }
      }
    }
  }
  if (best) {
    try { await bot.lookAt(best.c.offset(0.5, 1, 0.5), true) } catch {}
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    bot.setControlState('sprint', true)
    await sleep(1200)
    bot.clearControlStates()
  }
  return { status: 'done', detail: { how: best ? 'выпрыгнул к полу' : 'некуда', ...(nether ? { nether: true } : {}) } }
}

module.exports = { Director, situation, GOALS, byDirector, escapeFire }
