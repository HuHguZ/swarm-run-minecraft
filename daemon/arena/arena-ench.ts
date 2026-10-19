'use strict'
// Чары на арене (просьба 2026-09-26). Каждому зачаровываемому предмету набора —
// случайные чары из тех, что игра разрешает именно ему, каждый раунд и каждому
// бойцу свои: один выходит в зачарованной броне, другой — с острым мечом. Но
// случай не должен решать бой, поэтому у обоих одна «сила» набора (веса ниже):
// оба набора добираются до одного бюджета, и пара принимается, только если
// суммы различаются не больше допуска. Пары раундов: во втором раунде пары те
// же два набора, но бойцы меняются ими — за пару каждый дрался обоими, и для
// счёта побед (и отбора) различие наборов вычитается.
//
// Таблица — из самой игры, не по памяти: ванильный jar 1.21.11
// (server-end/versions/1.21.11/server-1.21.11.jar): data/minecraft/enchantment/
// *.json — max_level, supported_items, exclusive_set, weight;
// tags/item/enchantable/*.json и tags/enchantment/exclusive_set/*.json.
// minecraft-data 1.21.11 с ней совпадает по всем 43 чарам (макс. уровень,
// категория = supported_items, исключения в обе стороны, сокровища, проклятия) —
// сверено 2026-09-26. supported_items — то, что игра разрешает (наковальня,
// команды); primary_items у стола уже (шипы — только нагрудник, острота — без
// топора), но выдаём мы командой, и разрешено всё из supported.
//
// Синтаксис 1.21.5+: item[enchantments={sharpness:5,knockback:2}] — и в /give,
// и в /item replace … with (проверено на Paper 1.21.11: чары доходят, status
// { enchants: true } их видит). Уровни, закреплённые в наборе
// (crossbow[enchantments={quick_charge:3}], trident[enchantments={loyalty:3}] —
// на них держится логика бота), не трогаются, и к ним не добавляется
// несовместимое: «Тягун» к «Верности» не встанет (exclusive_set/riptide).

// ------------------------------------------------------------- таблица игры

const MAT = ['wooden', 'stone', 'copper', 'iron', 'golden', 'diamond', 'netherite']
const ARM = ['leather', 'copper', 'chainmail', 'iron', 'golden', 'diamond', 'netherite']
const of = (suffix, mats = MAT) => mats.map(m => `${m}_${suffix}`)
const HEADS = ['player_head', 'creeper_head', 'zombie_head', 'skeleton_skull', 'wither_skeleton_skull', 'dragon_head', 'piglin_head']
const SWORDS = of('sword')
const SPEARS = of('spear')
const AXES = of('axe')
const DIGGERS = [...AXES, ...of('pickaxe'), ...of('shovel'), ...of('hoe')]
const HEAD = [...of('helmet', ARM), 'turtle_helmet']
const CHEST = of('chestplate', ARM)
const LEGS = of('leggings', ARM)
const FEET = of('boots', ARM)
const ARMOR = [...FEET, ...LEGS, ...CHEST, ...HEAD]
const DURABILITY = [...ARMOR, 'elytra', 'shield', ...SWORDS, ...DIGGERS, 'bow', 'crossbow', 'trident', 'flint_and_steel', 'shears', 'brush', 'fishing_rod', 'carrot_on_a_stick', 'warped_fungus_on_a_stick', 'mace', ...SPEARS]
// #minecraft:enchantable/* — раскрытые теги предметов (как в jar).
const TAG = {
  armor: ARMOR,
  head_armor: HEAD,
  chest_armor: CHEST,
  leg_armor: LEGS,
  foot_armor: FEET,
  equippable: [...ARMOR, 'elytra', ...HEADS, 'carved_pumpkin'],
  sharp_weapon: [...SWORDS, ...SPEARS, ...AXES],
  weapon: [...SWORDS, ...SPEARS, ...AXES, 'mace'],
  melee_weapon: [...SWORDS, ...SPEARS],
  fire_aspect: [...SWORDS, ...SPEARS, 'mace'],
  sweeping: SWORDS,
  lunge: SPEARS,
  mining: [...DIGGERS, 'shears'],
  mining_loot: DIGGERS,
  durability: DURABILITY,
  vanishing: [...DURABILITY, 'compass', 'carved_pumpkin', ...HEADS],
  bow: ['bow'],
  crossbow: ['crossbow'],
  trident: ['trident'],
  mace: ['mace'],
  fishing: ['fishing_rod']
}
// #minecraft:exclusive_set/* — несовместимость в игре проверяется в обе
// стороны (Enchantment.areCompatible): «Верность» сама ни с чем не спорит, но
// она в наборе «Тягуна», и вместе их не бывает.
const XSET = {
  armor: ['protection', 'blast_protection', 'fire_protection', 'projectile_protection'],
  boots: ['frost_walker', 'depth_strider'],
  damage: ['sharpness', 'smite', 'bane_of_arthropods', 'impaling', 'density', 'breach'],
  mining: ['fortune', 'silk_touch'],
  bow: ['infinity', 'mending'],
  crossbow: ['multishot', 'piercing'],
  riptide: ['loyalty', 'channeling']
}
// id: [max_level, supported_items (#enchantable/…), exclusive_set, weight у стола]
const ENCH = {
  protection: [4, 'armor', 'armor', 10],
  fire_protection: [4, 'armor', 'armor', 5],
  blast_protection: [4, 'armor', 'armor', 2],
  projectile_protection: [4, 'armor', 'armor', 5],
  thorns: [3, 'armor', null, 1],
  feather_falling: [4, 'foot_armor', null, 5],
  depth_strider: [3, 'foot_armor', 'boots', 2],
  frost_walker: [2, 'foot_armor', 'boots', 2],
  soul_speed: [3, 'foot_armor', null, 1],
  respiration: [3, 'head_armor', null, 2],
  aqua_affinity: [1, 'head_armor', null, 2],
  swift_sneak: [3, 'leg_armor', null, 1],
  binding_curse: [1, 'equippable', null, 1],
  sharpness: [5, 'sharp_weapon', 'damage', 10],
  smite: [5, 'weapon', 'damage', 5],
  bane_of_arthropods: [5, 'weapon', 'damage', 5],
  knockback: [2, 'melee_weapon', null, 5],
  fire_aspect: [2, 'fire_aspect', null, 2],
  looting: [3, 'melee_weapon', null, 2],
  sweeping_edge: [3, 'sweeping', null, 2],
  lunge: [3, 'lunge', null, 5],
  efficiency: [5, 'mining', null, 10],
  fortune: [3, 'mining_loot', 'mining', 2],
  silk_touch: [1, 'mining_loot', 'mining', 1],
  power: [5, 'bow', null, 10],
  punch: [2, 'bow', null, 2],
  flame: [1, 'bow', null, 2],
  infinity: [1, 'bow', 'bow', 1],
  quick_charge: [3, 'crossbow', null, 5],
  multishot: [1, 'crossbow', 'crossbow', 2],
  piercing: [4, 'crossbow', 'crossbow', 10],
  loyalty: [3, 'trident', null, 5],
  impaling: [5, 'trident', 'damage', 2],
  riptide: [3, 'trident', 'riptide', 2],
  channeling: [1, 'trident', null, 1],
  density: [5, 'mace', 'damage', 5],
  breach: [4, 'mace', 'damage', 2],
  wind_burst: [3, 'mace', null, 2],
  lure: [3, 'fishing', null, 2],
  luck_of_the_sea: [3, 'fishing', null, 2],
  unbreaking: [3, 'durability', null, 5],
  mending: [1, 'durability', null, 2],
  vanishing_curse: [1, 'vanishing', null, 1]
}
const SUPPORTED: Record<string, any> = {} as Record<string, any>
for (const [e, [, tag]] of Object.entries<any>(ENCH)) for (const id of TAG[tag]) (SUPPORTED[id] || (SUPPORTED[id] = [])).push(e)
const applicable = id => SUPPORTED[id] || []
const clash = (a, b) => a === b || (!!ENCH[a][2] && XSET[ENCH[a][2]].includes(b)) || (!!ENCH[b][2] && XSET[ENCH[b][2]].includes(a))

// Вид предмета — для весов и подписи в логе.
function kindOf (id) {
  const m = id.match(/_(sword|spear|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots)$/)
  if (m) return { helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' }[m[1]] || m[1]
  return id
}
const ARMOR_KINDS = new Set(['head', 'chest', 'legs', 'feet'])

// ------------------------------------------------------------------- сила
//
// Единица — примерно процент боя в логарифме: чары множат либо урон, который
// наносишь, либо урон, который держишь, и 10 — это «на ~10% сильнее». Прикидка
// по механике 1.21.11 (Player.attack, CombatRules, данные чар из jar) против
// алмазной брони «арсенала» (20 брони, 8 твёрдости) и по тому, чем там бьют на
// самом деле: 319 раундов «арсенала» в логах арены 2026-09-25/26 — на бойца за
// раунд ~9–14 ударов в ближнем, 3.5 попадания из лука, 2 из арбалета, 1.4
// трезубцем, 0.38 удара булавой с падения (~10 урона каждый), щитом погашено
// меньше одного удара, лава — почти в каждом раунде.
//  · «Острота» +1/+1.5/…/+3 к удару, после крита (Player.attack: бонус чар
//    прибавляется уже после ×1.5). Против алмаза броня режет слабые удары
//    сильнее (CombatRules: armor − урон/(2 + твёрдость/4)), и +3 к 7 дают +55%
//    урона мечом после брони; меч — около половины всего урона.
//  · «Сила» лука прибавляется к базе стрелы 2 до множителя скорости: V —
//    стрела 15 вместо 6, после алмаза ×3.5; лук — около 1/8 урона.
//  · «Заговор огня» и «Горящая стрела»: огонь 1 в секунду мимо брони
//    (on_fire в #bypasses_armor), держит только «Защита» и вода.
//  · «Пронзание» сквозь щит (LivingEntity.applyItemBlocking: стрела с
//    getPierceLevel() > 0 не гасится) — уровни выше I в дуэли ничего не
//    добавляют (пронзать второго некого).
//  · булава: «Плотность» +0.5·ур. урона за блок падения (≈8 бл. взлёта:
//    V — удар 48 вместо 28, насквозь через алмаз); «Пробитие» −15% брони за
//    уровень; «Порыв ветра» — снова вверх после удара. Но удар с падения —
//    0.38 за раунд, поэтому дешевле «Остроты».
//  · «Шипы» 15%·ур. на куске — 1–5 урона бьющему (и стрелку), каждый кусок
//    бросает сам.
//  · «Защита» — не слагаемым: вся броня даёт EPF (защита 1 за уровень, от
//    снарядов/огня/взрывов 2 за уровень, но только от своего урона), урон
//    ×(1 − EPF/25), не больше 20 (CombatRules.getDamageAfterMagicAbsorb;
//    огонь и зелья вреда тоже режет — «Защиту» обходит только sonic_boom).
//    Живучесть — 25/(25 − EPF), и каждое следующее очко дороже: II на всех
//    четырёх — 39, IV на всех — 102. Специальные засчитаны долей своего урона:
//    снаряды ~30%, огонь и лава ~20% (плюс горит на 15% меньше за уровень),
//    взрывов в «арсенале» нет — у «Взрывоустойчивости» в счёт только отброс
//    зарядов ветра (−15% за уровень).
//  · ноль — что против игрока на арене не действует: «Небесная кара», «Бич
//    членистоногих», «Пронзатель» (нежить, членистоногие, водные — теги
//    sensitive_to_*), «Добыча», «Удача», «Шёлковое касание», «Приманка»,
//    «Везучий рыбак», «Разящий клинок» (задевает соседей цели — в дуэли их
//    нет), «Громовержец» (только в грозу), «Подводное дыхание», «Подводник»,
//    «Ледоход», «Скорость души», «Починка» (опыта нет), «Прочность» (за раунд
//    ничего не ломается), проклятия (снимать и ронять на арене нечего). Их тоже
//    выдаём — это полный список игры, — но реже (DUD), и места в исключениях они
//    занимают честно: «Небесная кара» на мече — меч без «Остроты».
const W = {
  protection: { epf: 1 },
  projectile_protection: { epf: 0.6 },
  fire_protection: { epf: 0.45 },
  blast_protection: { epf: 0.05, lv: [1, 2, 3, 4] },
  thorns: { lv: [2.5, 5, 7.5] },
  feather_falling: { lv: [1, 2, 3, 4] },
  depth_strider: { lv: [0.3, 0.6, 1] },
  swift_sneak: { lv: [0.3, 0.6, 1] },
  sharpness: { lv: [7.5, 11, 15, 18.5, 22], axe: [1.5, 2.3, 3, 3.8, 4.6] },
  knockback: { lv: [3, 6] },
  fire_aspect: { lv: [10, 17], mace: [2, 3] },
  lunge: { lv: [2, 3.5, 5] },
  efficiency: { lv: [0.2, 0.4, 0.6, 0.8, 1], pickaxe: [2, 3.5, 5, 6.5, 8], axe: [0.5, 1, 1.5, 2, 2.5] },
  power: { lv: [8, 12, 17, 21, 26] },
  punch: { lv: [2, 4] },
  flame: { lv: [10] },
  infinity: { lv: [1] },
  quick_charge: { lv: [2, 4, 6] },
  multishot: { lv: [1] },
  piercing: { lv: [4, 4, 4, 4] },
  loyalty: { lv: [3, 4, 5] },
  riptide: { lv: [1, 1.5, 2] },
  density: { lv: [3, 6, 9, 12, 15] },
  breach: { lv: [3, 5.5, 7.5, 8.5] },
  wind_burst: { lv: [2, 3.5, 5] },
  unbreaking: { fishing_rod: [0.3, 0.5, 0.7] }
}
// Набор со взрывчаткой («небо и порох», arena.js ench: 'blast', 2026-09-26):
// вагонетки с TNT и кристаллы — треть урона и больше (кристалл в 2–3 бл. по
// алмазу — 43–55, PVP-RESEARCH б.10), и толчок взрыва — в дыры пола.
// «Взрывоустойчивость» — 2 защиты от взрыва за уровень: ≈0.7 «Защиты» при
// трети урона взрывами; плюс −15% толчка взрывом за уровень (дыры) — уровни
// дороже. «Невесомость» — пике с элитр и падения в дыры: чуть дороже.
const W_BLAST = { ...W, blast_protection: { epf: 0.7, lv: [2, 4, 6, 8], draw: 4 }, feather_falling: { lv: [2, 3, 5, 6] } }
let Wcur = W
const levelPower = (kind, e, L) => {
  const w = Wcur[e]
  const arr = w && (w[kind] || w.lv)
  return arr ? arr[Math.min(L, arr.length) - 1] || 0 : 0
}
const epfOf = (kind, e) => (ARMOR_KINDS.has(kind) && Wcur[e] && Wcur[e].epf) || 0
const useful = (kind, e) => epfOf(kind, e) > 0 || levelPower(kind, e, ENCH[e][0]) > 0
// Живучесть от EPF брони, в тех же единицах: 100·ln(25/(25 − EPF)), EPF ≤ 20.
const PROT = epf => 100 * Math.log(25 / (25 - Math.min(20, epf)))

// Сила случайной добавки стороны (закреплённое в наборе — база, в счёт не идёт,
// но «Защиту» сверху считаем от закреплённого EPF).
function sidePower (items) {
  let sum = 0; let epf0 = 0; let epf = 0
  for (const it of items) {
    for (const [e, L] of Object.entries<any>(it.pinned)) epf0 += epfOf(it.kind, e) * L
    for (const [e, L] of Object.entries<any>(it.add)) {
      sum += levelPower(it.kind, e, L)
      epf += epfOf(it.kind, e) * L
    }
  }
  return sum + PROT(epf0 + epf) - PROT(epf0)
}

// ------------------------------------------------------- разбор и сборка

// «имя[компоненты] число» — как в наборах arena.js (пробелов внутри нет).
function parseItem (s) {
  const [head, ...rest] = String(s).split(' ')
  const id = head.replace(/\[.*$/, '').replace(/^minecraft:/, '')
  let comps = (head.match(/\[(.*)\]$/) || [])[1] || ''
  const pinned: Record<string, any> = {} as Record<string, any>
  const m = comps.match(/(?:^|,)(?:minecraft:)?enchantments=\{([^}]*)\}/)
  if (m) {
    for (const kv of m[1].split(',').filter(Boolean)) {
      const [k, v] = kv.split(':')
      pinned[k.replace(/^minecraft:/, '')] = Number(v)
    }
    comps = comps.replace(m[0], '').replace(/^,/, '')
  }
  return { raw: String(s), id, kind: kindOf(id), comps, pinned, add: {} as Record<string, any>, count: rest.join(' ') }
}
// Обратно в строку набора: закреплённые первыми, потом случайные.
function itemString (it) {
  const all = { ...it.pinned, ...it.add }
  const keys = Object.keys(all)
  if (!Object.keys(it.add).length) return it.raw
  const ench = `enchantments={${keys.map(k => `${k}:${all[k]}`).join(',')}}`
  const comps = it.comps ? `${it.comps},${ench}` : ench
  return `${it.id}[${comps}]${it.count ? ' ' + it.count : ''}`
}

// ------------------------------------------------------------- розыгрыш

// Группы — для «уклона» стороны: один выходит в броне, другой с мечом.
const GROUP = { head: 'броня', chest: 'броня', legs: 'броня', feet: 'броня', sword: 'ближний', spear: 'ближний', axe: 'ближний', mace: 'булава', bow: 'дальний', crossbow: 'дальний', trident: 'дальний', pickaxe: 'инструмент', shovel: 'инструмент', hoe: 'инструмент', shears: 'инструмент' }
const groupOf = kind => GROUP[kind] || 'прочее'
const DUD = 0.3 // бесполезное против игрока — в 0.3 раза реже
const FOCUS = 3 // любимая группа стороны — втрое чаще и уровни повыше
const PER_ITEM = 4 // случайных на предмет не больше: команда короче 250 знаков (say режет)
const MAX_DUDS = 3 // пустых чар на сторону — не больше
const STOP = 1.5 // бюджет добран, если осталось меньше

function rng (seed) {
  if (seed == null || seed === '') return Math.random
  let a = 0
  for (const ch of String(seed)) a = (Math.imul(a, 31) + ch.charCodeAt(0)) | 0
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Одна сторона: чары набираются, пока не выйдет бюджет target. Кандидаты —
// все пары (предмет, чары), которые игра разрешает; вытягиваются по весу стола
// (weight из jar: «Защита» и «Острота» 10, «Шипы» 1), бесполезные — реже,
// любимая группа — чаще. Уровень — случайный (в любимой группе — лучший из
// двух бросков); не влезает в остаток — ниже, до I; не влезает и I — мимо.
function drawSide (base, target, random = Math.random) {
  const items = base.map(parseItem)
  const pool = []
  items.forEach((it, i) => {
    for (const e of applicable(it.id)) {
      if (e in it.pinned) continue
      const u = useful(it.kind, e)
      // draw — во сколько раз чаще тянуть в этом наборе (W_BLAST: взрывозащита).
      pool.push({ i, e, u, g: groupOf(it.kind), w: ENCH[e][3] * (u ? 1 : DUD) * ((Wcur[e] && Wcur[e].draw) || 1) })
    }
  })
  // Любимая группа — из тех, где есть что-то полезное; «прочее» (щит, удочка,
  // огниво — одна «Прочность» да пустое) любимой не бывает.
  const groups = [...new Set(pool.filter(c => c.u && c.g !== 'прочее').map(c => c.g))]
  const favored = groups.length ? groups[Math.floor(random() * groups.length)] : null
  for (const c of pool) if (c.g === favored) c.w *= FOCUS
  let power = 0; let duds = 0
  while (pool.length && target - power > STOP) {
    let r = random() * pool.reduce((s, c) => s + c.w, 0)
    let k = 0
    while (k < pool.length - 1 && (r -= pool[k].w) > 0) k++
    const c = pool.splice(k, 1)[0]
    const it = items[c.i]
    if ([...Object.keys(it.pinned), ...Object.keys(it.add)].some(h => clash(h, c.e))) continue
    if (Object.keys(it.add).length >= PER_ITEM) continue
    if (!c.u && duds >= MAX_DUDS) continue
    const max = ENCH[c.e][0]
    const roll = () => 1 + Math.floor(random() * max)
    let L = groupOf(it.kind) === favored ? Math.max(roll(), roll()) : roll()
    for (; L >= 1; L--) {
      it.add[c.e] = L
      const p = sidePower(items)
      if (p <= target + 1e-9) { power = p; break }
      delete it.add[c.e]
    }
    if (L >= 1 && !c.u) duds++
  }
  return { items, strings: items.map(itemString), power: Math.round(power * 10) / 10, favored, count: items.reduce((s, it) => s + Object.keys(it.add).length, 0) }
}

// Пара наборов с одним бюджетом (случайным из [lo, hi] на пару): тянем заново,
// пока суммы не сойдутся в допуск tol (обычно с первого раза — оба добирают
// бюджет до остатка < STOP). base a и b — предметы сторон (одинаковые или нет).
function drawPair (baseA, baseB, { budget = [40, 70], tol = 3, random = Math.random, tries = 200, weights = null }: any = {} as Record<string, any>) {
  // Свои веса на этот розыгрыш (W_BLAST) — и обратно: розыгрыш синхронный.
  const was = Wcur
  Wcur = weights || W
  try { return drawPairW(baseA, baseB, { budget, tol, random, tries }) } finally { Wcur = was }
}
function drawPairW (baseA, baseB, { budget, tol, random, tries }: any) {
  const [lo, hi] = budget
  const target = lo + random() * Math.max(0, hi - lo)
  let best = null
  for (let t = 1; t <= tries; t++) {
    const a = drawSide(baseA, target, random)
    const b = drawSide(baseB, target, random)
    const diff = Math.abs(a.power - b.power)
    if (!best || diff < best.diff) best = { a, b, diff: Math.round(diff * 10) / 10, tries: t }
    if (diff <= tol) break
  }
  return { ...best, target: Math.round(target * 10) / 10 }
}

const enchantable = base => base.some(s => applicable(parseItem(s).id).length > 0)
const sameItems = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort())

// ------------------------------------------------------------------- лог

const LABEL = { sword: 'меч', spear: 'копьё', axe: 'топор', pickaxe: 'кирка', shovel: 'лопата', hoe: 'мотыга', head: 'шлем', chest: 'нагрудник', legs: 'поножи', feet: 'ботинки', mace: 'булава', bow: 'лук', crossbow: 'арбалет', trident: 'трезубец', shield: 'щит', fishing_rod: 'удочка', flint_and_steel: 'огниво', shears: 'ножницы', elytra: 'элитры', turtle_helmet: 'шлем' }
// «меч sharpness:4,fire_aspect:1 · шлем protection:2» — только случайные
// добавки (закреплённое в наборе и так известно), в порядке набора; второй
// такой же предмет — «арбалет 2».
function describe (side) {
  const n: Record<string, any> = {} as Record<string, any>
  const parts = []
  for (const it of side.items) {
    let label = LABEL[it.kind] || it.id
    n[label] = (n[label] || 0) + 1
    if (n[label] > 1) label += ' ' + n[label]
    const keys = Object.keys(it.add)
    if (keys.length) parts.push(`${label} ${keys.map(e => `${e}:${it.add[e]}`).join(',')}`)
  }
  return parts.join(' · ') || 'без чар'
}

// Сверка выдачи: что должно быть на теле и в рюкзаке (всё зачарованное — и
// закреплённое, и случайное) против status { enchants } демона.
function verify (side, got) {
  const want = side.items.filter(it => Object.keys(it.pinned).length || Object.keys(it.add).length)
  const left = [...(got || [])]
  const missing = []
  const same = (a, b) => { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k]) }
  for (const it of want) {
    const all = { ...it.pinned, ...it.add }
    const k = left.findIndex(g => g.name === it.id && same(g.ench || {} as Record<string, any>, all))
    if (k >= 0) left.splice(k, 1)
    else missing.push(LABEL[it.kind] || it.id)
  }
  return { total: want.length, got: want.length - missing.length, missing }
}

export { ENCH, XSET, TAG, W, W_BLAST, PROT, applicable, clash, kindOf, levelPower, sidePower, parseItem, itemString, drawSide, drawPair, enchantable, sameItems, describe, verify, rng }
