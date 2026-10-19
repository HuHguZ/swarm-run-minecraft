'use strict'
// Директор: цели (пройти игру, еда, ждать) и шаги к ним; кровать.
import { ORES } from '../worldmap'
import { count, WOOL, PICK } from './situation'

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
export const GOALS: any = {}

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
