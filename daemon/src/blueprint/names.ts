'use strict'
// Чертёж: направления и фазы стройки, дерево и камень, имена блоков и вариантов, палитра.

export type BlueprintPart = { type: string; role?: string; block?: string; from?: number[]; to?: number[]; at?: number[]; [option: string]: any }
// Чертёж: из чего состоит постройка и во что она раскладывается по клеткам.
// Здесь нет ни бота, ни мира — только геометрия и имена блоков, поэтому всё
// это проверяется без сервера. Мир (место, смета, стройка) — в architect.js.
//
// ФОРМАТ ПЛАНА — то, что мозг может собрать сам под любую просьбу игрока.
// Координаты ОТНОСИТЕЛЬНЫЕ: [x, y, z] или {x, y, z}; y=0 — уровень земли/пола,
// стены обычно с y=1. Фасад (вход) рисуется на ЮГ (+z), а поворот `front`
// разворачивает всё целиком, вместе с ориентацией ступеней, дверей и табличек.
// Части накладываются по порядку: поздняя перекрывает раннюю в той же клетке
// (так окно вырезается в стене, а проём — в заборе).
//
//   {type:'box',    from, to, block, hollow?}   сплошной параллелепипед (hollow — только оболочка)
//   {type:'walls',  from, to, block}            периметр по высоте, без пола и потолка
//   {type:'floor',  from, to, block}            слой на высоте from.y
//   {type:'line',   from, to, block}            линия (оси и диагонали)
//   {type:'clear',  from, to}                   воздух: выкопать всё, что там есть
//   {type:'seal',   from, to, block}            заделать только дыры: твёрдое не трогает
//   {type:'block',  at, block, facing?, half?, axis?}   один блок с состоянием
//   {type:'stairs', from, to, block, facing, half?}     ступени (half top — перевёрнутые)
//   {type:'slab',   from, to, block, half?}
//   {type:'door',   at, block?, facing?}        дверь (две клетки); facing — куда смотрел ставящий, по умолчанию north (снаружи с юга внутрь)
//   {type:'window', from, to, block?}           стекло (glass_pane по умолчанию), вырезается в стене
//   {type:'torch',  at, facing?}                с facing — на стене (facing — от стены), без — на полу
//   {type:'lantern',at, hanging?}
//   {type:'bed',    at, facing?, block?}        at — ноги, изголовье в сторону facing
//   {type:'chest',  at, facing?}                facing — куда смотрит крышка/перед
//   {type:'sign',   at, facing?, text, block?}  табличка на стене (facing — от стены) или на полу (standing:true)
//   {type:'ladder', from, to, facing}           столбец лестницы, facing — от стены
//   {type:'crenel', from, to, block}            зубцы: через один по линии
//   {type:'roof',   from, to, block, style?, axis?, overhang?, ridge?, gable?}
//        from/to — прямоугольник СТЕН (y — верх стены); style gable|hip|flat;
//        axis — вдоль чего конёк (x|z); overhang — свес (1); ridge — блок конька
//        (плита или полный); gable — чем зашить треугольники фронтонов.
//
// Готовые постройки (kind) — генераторы ниже собирают такой же список частей.

export const DIRS = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }
export const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
export const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
export const HORIZONTAL = ['north', 'east', 'south', 'west']
// Сколько поворотов по часовой нужно, чтобы южный фасад смотрел в `front`.
export const STEPS = { south: 0, west: 1, north: 2, east: 3 }

// Какой фазой клетка строится. Порядок нужен не для красоты: сначала вынуть
// землю, потом всё, что держится за соседа гранью, снизу вверх, потом то, что
// держится за конкретную опору (факел, табличка, кровать), и дверь последней —
// пока её нет, проём остаётся выходом, и бот не замурует себя в доме.
export const PHASE = { clear: 0, solid: 1, fixture: 2, door: 3 }

export const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'crimson', 'warped']

// Породы, из которых строят «каменное»: базовый блок и как игра называет
// производные. Имена сверены с minecraft-data 1.21.11 при разборе палитры
// (resolveNames) — сюда можно дописывать, лишнее просто не найдётся.
export const STONES = [
  'cobblestone', 'stone_bricks', 'cobbled_deepslate', 'deepslate_bricks', 'polished_deepslate', 'bricks',
  'stone', 'mossy_cobblestone', 'mossy_stone_bricks', 'sandstone', 'red_sandstone', 'smooth_sandstone',
  'blackstone', 'polished_blackstone_bricks', 'andesite', 'polished_andesite', 'granite', 'polished_granite',
  'diorite', 'polished_diorite', 'tuff', 'tuff_bricks', 'mud_bricks', 'nether_bricks', 'end_stone_bricks',
  'prismarine', 'quartz_block', 'deepslate_tiles'
]

export const vec = v => {
  if (Array.isArray(v)) return { x: Math.round(v[0]), y: Math.round(v[1]), z: Math.round(v[2]) }
  if (v && typeof v === 'object') return { x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) }
  throw new Error(`не понял координату ${JSON.stringify(v)}: жду [x,y,z] или {x,y,z}`)
}
export const key = (x, y, z) => `${x},${y},${z}`

export function range (a, b) {
  const out = []
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) out.push(i)
  return out
}

// ---------------------------------------------------------------- names

// Какие блоки ставятся как: от этого зависит, за что клетку держать и куда при
// постановке смотреть. Разобрано по байткоду paper-1.21.11.jar:
//  · StairBlock.getStateForPlacement: facing = getHorizontalDirection() (куда
//    смотрит игрок), half = TOP, если нажата нижняя грань или боковая выше 0.5;
//  · DoorBlock: facing — направление игрока, верхняя половина ставится сама,
//    нужна свободная клетка сверху;
//  · BedBlock: facing — направление игрока, изголовье = клетка + facing;
//  · ChestBlock: facing = направление игрока НАОБОРОТ (сундук смотрит на
//    ставящего), без приседа сливается с соседним одиночным в двойной;
//  · факел, табличка, лестница на стене — за блок, по грани которого кликнули
//    (BlockPlaceContext ставит противоположную нажатой грани первой).
export function kindOf (name) {
  if (/_door$/.test(name)) return 'door'
  if (/_bed$/.test(name)) return 'bed'
  if (/_stairs$/.test(name)) return 'stairs'
  if (/_slab$/.test(name)) return 'slab'
  if (/wall_torch$/.test(name) || /_wall_sign$/.test(name) || name === 'ladder') return 'wall'
  if (/^(torch|soul_torch|redstone_torch|copper_torch)$/.test(name) || (/_sign$/.test(name) && !/hanging/.test(name))) return 'floor'
  if (/^(lantern|soul_lantern|copper_lantern)$/.test(name)) return 'lantern'
  if (/^(chest|trapped_chest|furnace|blast_furnace|smoker)$/.test(name)) return 'facer'
  if (/_(log|wood|stem|hyphae)$/.test(name) || /^(hay_block|bone_block|basalt|polished_basalt|quartz_pillar|purpur_pillar)$/.test(name)) return 'pillar'
  return 'plain'
}

// Предмет, из которого блок ставится. Настенный факел и настенная табличка —
// отдельные блоки мира, а в рюкзаке это обычный факел и обычная табличка.
export function itemFor (name) {
  if (/wall_torch$/.test(name)) return name.replace('wall_torch', 'torch')
  if (/_wall_sign$/.test(name)) return name.replace('_wall_sign', '_sign')
  if (/_wall_hanging_sign$/.test(name)) return name.replace('_wall_hanging_sign', '_hanging_sign')
  if (/_wall_banner$/.test(name)) return name.replace('_wall_banner', '_banner')
  return name
}

// Для настенного варианта — имя настенного блока.
export function wallVariant (name) {
  if (/^(torch|soul_torch|redstone_torch|copper_torch)$/.test(name)) return name.replace('torch', 'wall_torch')
  if (/_sign$/.test(name) && !/_wall_sign$/.test(name) && !/hanging/.test(name)) return name.replace(/_sign$/, '_wall_sign')
  return name
}

// ---------------------------------------------------------------- palette

// Производные блока: ступени, плита, стенка. У досок это «oak_stairs», у
// кирпичей «brick_stairs» (без s), у каменных кирпичей «stone_brick_stairs».
export function derived (base, suffix, has) {
  const bare = base.replace(/_planks$/, '')
  const cands = [`${bare}_${suffix}`, `${bare.replace(/s$/, '')}_${suffix}`, `${bare.replace(/_block$/, '')}_${suffix}`]
  return cands.find(n => has(n)) || null
}

// Палитра — роли, а не блоки: стена, каркас, пол, крыша, конёк, дверь, окно,
// свет, табличка. Генераторы просят роли, а палитра говорит, чем их закрыть.
// Палитра постройки; window, light, fill, ladder, bed дописывает architect по рюкзаку.
interface Palette {
  material: string; main: string; frame: string; floor: string; stairs: string | null; slab: string | null; wall: string | null
  fence: string | null; door: string | null; sign: string; roofFill: string
  window?: string | null; light?: string | null; fill?: string; ladder?: string | null; bed?: string
}
export function palette (material, has): Palette {
  const m = String(material || '').trim().toLowerCase()
  const wood = WOODS.find(w => m === w || m === `${w}_planks` || m === `${w}_log` || m === `${w}_stem`)
  if (wood) {
    const nether = wood === 'crimson' || wood === 'warped'
    const planks = `${wood}_planks`
    return {
      material: wood,
      main: planks,
      frame: has(`${wood}_${nether ? 'stem' : 'log'}`) ? `${wood}_${nether ? 'stem' : 'log'}` : planks,
      floor: planks,
      stairs: derived(planks, 'stairs', has),
      slab: derived(planks, 'slab', has),
      wall: null,
      fence: has(`${wood}_fence`) ? `${wood}_fence` : null,
      door: has(`${wood}_door`) ? `${wood}_door` : 'oak_door',
      sign: has(`${wood}_sign`) ? `${wood}_sign` : 'oak_sign',
      roofFill: planks
    }
  }
  if (!has(m)) throw new Error(`материал «${material}» не блок 1.21.11: дерево (${WOODS.join(', ')}) или камень (${STONES.slice(0, 8).join(', ')}, …)`)
  return {
    material: m,
    main: m,
    frame: m,
    floor: m,
    stairs: derived(m, 'stairs', has),
    slab: derived(m, 'slab', has),
    wall: derived(m, 'wall', has),
    fence: null,
    door: 'oak_door',
    sign: 'oak_sign',
    roofFill: m
  }
}
