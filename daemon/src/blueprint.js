'use strict'
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

const DIRS = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
const HORIZONTAL = ['north', 'east', 'south', 'west']
// Сколько поворотов по часовой нужно, чтобы южный фасад смотрел в `front`.
const STEPS = { south: 0, west: 1, north: 2, east: 3 }

// Какой фазой клетка строится. Порядок нужен не для красоты: сначала вынуть
// землю, потом всё, что держится за соседа гранью, снизу вверх, потом то, что
// держится за конкретную опору (факел, табличка, кровать), и дверь последней —
// пока её нет, проём остаётся выходом, и бот не замурует себя в доме.
const PHASE = { clear: 0, solid: 1, fixture: 2, door: 3 }

const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'crimson', 'warped']

// Породы, из которых строят «каменное»: базовый блок и как игра называет
// производные. Имена сверены с minecraft-data 1.21.11 при разборе палитры
// (resolveNames) — сюда можно дописывать, лишнее просто не найдётся.
const STONES = [
  'cobblestone', 'stone_bricks', 'cobbled_deepslate', 'deepslate_bricks', 'polished_deepslate', 'bricks',
  'stone', 'mossy_cobblestone', 'mossy_stone_bricks', 'sandstone', 'red_sandstone', 'smooth_sandstone',
  'blackstone', 'polished_blackstone_bricks', 'andesite', 'polished_andesite', 'granite', 'polished_granite',
  'diorite', 'polished_diorite', 'tuff', 'tuff_bricks', 'mud_bricks', 'nether_bricks', 'end_stone_bricks',
  'prismarine', 'quartz_block', 'deepslate_tiles'
]

const vec = v => {
  if (Array.isArray(v)) return { x: Math.round(v[0]), y: Math.round(v[1]), z: Math.round(v[2]) }
  if (v && typeof v === 'object') return { x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) }
  throw new Error(`не понял координату ${JSON.stringify(v)}: жду [x,y,z] или {x,y,z}`)
}
const key = (x, y, z) => `${x},${y},${z}`

function range (a, b) {
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
function kindOf (name) {
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
function itemFor (name) {
  if (/wall_torch$/.test(name)) return name.replace('wall_torch', 'torch')
  if (/_wall_sign$/.test(name)) return name.replace('_wall_sign', '_sign')
  if (/_wall_hanging_sign$/.test(name)) return name.replace('_wall_hanging_sign', '_hanging_sign')
  if (/_wall_banner$/.test(name)) return name.replace('_wall_banner', '_banner')
  return name
}

// Для настенного варианта — имя настенного блока.
function wallVariant (name) {
  if (/^(torch|soul_torch|redstone_torch|copper_torch)$/.test(name)) return name.replace('torch', 'wall_torch')
  if (/_sign$/.test(name) && !/_wall_sign$/.test(name) && !/hanging/.test(name)) return name.replace(/_sign$/, '_wall_sign')
  return name
}

// ---------------------------------------------------------------- palette

// Производные блока: ступени, плита, стенка. У досок это «oak_stairs», у
// кирпичей «brick_stairs» (без s), у каменных кирпичей «stone_brick_stairs».
function derived (base, suffix, has) {
  const bare = base.replace(/_planks$/, '')
  const cands = [`${bare}_${suffix}`, `${bare.replace(/s$/, '')}_${suffix}`, `${bare.replace(/_block$/, '')}_${suffix}`]
  return cands.find(n => has(n)) || null
}

// Палитра — роли, а не блоки: стена, каркас, пол, крыша, конёк, дверь, окно,
// свет, табличка. Генераторы просят роли, а палитра говорит, чем их закрыть.
function palette (material, has) {
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

// ---------------------------------------------------------------- compile

// Части → клетки в относительных координатах. Каждая клетка знает имя блока,
// состояние, чем её ставить (item), фазу и за что держаться (support).
function compileParts (parts, has) {
  if (!Array.isArray(parts) || !parts.length) throw new Error('план пуст: жду parts — список частей')
  const cells = new Map()
  const bad = new Set()
  const check = name => { if (!has(name)) bad.add(name) }

  const put = (x, y, z, spec) => {
    const k = key(x, y, z)
    // Две клетки двери или кровати — одна вещь. Если поздняя часть перекрыла
    // одну половину, вторая тоже должна уйти, иначе останется полдвери.
    const old = cells.get(k)
    if (old && old.pair) cells.delete(old.pair)
    cells.set(k, { x, y, z, ...spec })
  }

  const solid = (name, props = null, extra = {}) => {
    check(name)
    const kind = kindOf(name)
    return { name, item: itemFor(name), kind: kind === 'pillar' || kind === 'plain' || kind === 'stairs' || kind === 'slab' || kind === 'facer' ? kind : 'plain', props: props || undefined, phase: PHASE.solid, ...extra }
  }

  parts.forEach((part, index) => {
    const t = String(part.type || '').toLowerCase()
    const tag = { part: index, role: part.role || t, optional: !!part.optional || undefined }
    const box = () => {
      const a = vec(part.from ?? part.at); const b = vec(part.to ?? part.from ?? part.at)
      return { a, b }
    }
    switch (t) {
      case 'box':
      case 'fill': {
        const { a, b } = box()
        for (const x of range(a.x, b.x)) {
          for (const y of range(a.y, b.y)) {
            for (const z of range(a.z, b.z)) {
              const shell = x === Math.min(a.x, b.x) || x === Math.max(a.x, b.x) || y === Math.min(a.y, b.y) ||
            y === Math.max(a.y, b.y) || z === Math.min(a.z, b.z) || z === Math.max(a.z, b.z)
              if (part.hollow && !shell) continue
              put(x, y, z, { ...solid(part.block, propsOf(part)), ...tag })
            }
          }
        }
        break
      }
      case 'walls': {
        const { a, b } = box()
        for (const x of range(a.x, b.x)) {
          for (const y of range(a.y, b.y)) {
            for (const z of range(a.z, b.z)) {
              const edge = x === Math.min(a.x, b.x) || x === Math.max(a.x, b.x) || z === Math.min(a.z, b.z) || z === Math.max(a.z, b.z)
              if (edge) put(x, y, z, { ...solid(part.block, propsOf(part)), ...tag })
            }
          }
        }
        break
      }
      case 'floor': {
        const { a, b } = box()
        for (const x of range(a.x, b.x)) for (const z of range(a.z, b.z)) put(x, a.y, z, { ...solid(part.block, propsOf(part)), ...tag })
        break
      }
      case 'line': {
        const a = vec(part.from); const b = vec(part.to)
        const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z))
        for (let i = 0; i <= n; i++) {
          const f = n ? i / n : 0
          put(Math.round(a.x + (b.x - a.x) * f), Math.round(a.y + (b.y - a.y) * f), Math.round(a.z + (b.z - a.z) * f),
            { ...solid(part.block, propsOf(part)), ...tag })
        }
        break
      }
      case 'crenel': {
        const a = vec(part.from); const b = vec(part.to)
        const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z))
        for (let i = 0; i <= n; i += 2) {
          const f = n ? i / n : 0
          put(Math.round(a.x + (b.x - a.x) * f), Math.round(a.y + (b.y - a.y) * f), Math.round(a.z + (b.z - a.z) * f),
            { ...solid(part.block), ...tag })
        }
        break
      }
      case 'clear':
      case 'air': {
        const { a, b } = box()
        for (const x of range(a.x, b.x)) {
          for (const y of range(a.y, b.y)) {
            for (const z of range(a.z, b.z)) {
              put(x, y, z, { name: 'air', kind: 'air', phase: PHASE.clear, ...tag })
            }
          }
        }
        break
      }
      case 'seal': {
        const { a, b } = box()
        check(part.block)
        for (const x of range(a.x, b.x)) {
          for (const y of range(a.y, b.y)) {
            for (const z of range(a.z, b.z)) {
              // Заделка не перекрывает то, что план уже положил сюда осмысленно.
              if (cells.has(key(x, y, z))) continue
              put(x, y, z, { name: part.block, item: itemFor(part.block), kind: 'seal', phase: PHASE.solid, ...tag })
            }
          }
        }
        break
      }
      case 'block': {
        const p = vec(part.at)
        const name = part.block
        const k = kindOf(name)
        if (k === 'door') putDoor(put, check, p, name, part.facing || 'north', tag)
        else if (k === 'bed') putBed(put, check, p, name, part.facing || 'north', tag)
        else if (k === 'wall' || k === 'floor' || k === 'lantern') putFixture(put, check, p, name, part, tag)
        else put(p.x, p.y, p.z, { ...solid(name, propsOf(part)), ...tag })
        break
      }
      case 'stairs':
      case 'slab': {
        const { a, b } = box()
        const name = part.block
        if (t === 'stairs' && !/_stairs$/.test(name)) throw new Error(`stairs: ${name} — не ступени`)
        if (t === 'slab' && !/_slab$/.test(name)) throw new Error(`slab: ${name} — не плита`)
        for (const x of range(a.x, b.x)) {
          for (const y of range(a.y, b.y)) {
            for (const z of range(a.z, b.z)) {
              put(x, y, z, { ...solid(name, propsOf({ ...part, facing: t === 'stairs' ? (part.facing || 'north') : undefined })), ...tag })
            }
          }
        }
        break
      }
      case 'door':
        putDoor(put, check, vec(part.at), part.block || 'oak_door', part.facing || 'north', tag)
        break
      case 'bed':
        putBed(put, check, vec(part.at), part.block || 'red_bed', part.facing || 'north', tag)
        break
      case 'window': {
        const { a, b } = box()
        const name = part.block || 'glass_pane'
        for (const x of range(a.x, b.x)) {
          for (const y of range(a.y, b.y)) {
            for (const z of range(a.z, b.z)) {
              put(x, y, z, { ...solid(name), ...tag, role: 'window' })
            }
          }
        }
        break
      }
      case 'torch':
        putFixture(put, check, vec(part.at), part.block || 'torch', part, tag)
        break
      case 'lantern':
        putFixture(put, check, vec(part.at), part.block || 'lantern', part, tag)
        break
      case 'chest': {
        const p = vec(part.at)
        const name = part.block || 'chest'
        check(name)
        put(p.x, p.y, p.z, { name, item: itemFor(name), kind: 'facer', props: { facing: part.facing || 'south' }, phase: PHASE.fixture, label: part.label, ...tag })
        break
      }
      case 'sign': {
        const p = vec(part.at)
        const name = part.block || 'oak_sign'
        const text = signLines(part.text)
        putFixture(put, check, p, name, { ...part, facing: part.standing ? undefined : (part.facing || 'south'), faces: part.facing || 'south' }, { ...tag, text })
        break
      }
      case 'ladder': {
        const a = vec(part.from ?? part.at); const b = vec(part.to ?? part.at)
        const facing = part.facing || 'south'
        check('ladder')
        for (const y of range(a.y, b.y)) {
          put(a.x, y, a.z, { name: 'ladder', item: 'ladder', kind: 'wall', props: { facing }, support: OPP[facing], phase: PHASE.fixture, ...tag })
        }
        break
      }
      case 'roof':
        compileRoof(part, put, solid, tag)
        break
      default:
        throw new Error(`часть ${index}: неизвестный тип «${part.type}»`)
    }
  })

  if (bad.size) throw new Error(`таких блоков в 1.21.11 нет: ${[...bad].join(', ')}`)
  return cells
}

function propsOf (part) {
  const out = {}
  if (part.facing && HORIZONTAL.includes(part.facing) && /_stairs$/.test(part.block || '')) out.facing = part.facing
  if (part.half && /_stairs$/.test(part.block || '')) out.half = part.half
  if (/_stairs$/.test(part.block || '') && !out.half) out.half = 'bottom'
  if (/_slab$/.test(part.block || '')) out.type = part.half === 'top' ? 'top' : part.half === 'double' ? 'double' : 'bottom'
  if (part.axis && kindOf(part.block || '') === 'pillar') out.axis = part.axis
  if (part.facing && kindOf(part.block || '') === 'facer') out.facing = part.facing
  return Object.keys(out).length ? out : null
}

// Строк на табличке четыре. Сервер режет строку по ширине сам, но в игре
// длинная строка просто не видна, поэтому режем по 15 знаков честно здесь.
function signLines (text) {
  const raw = Array.isArray(text) ? text : String(text || '').split(/\n|\|/)
  return raw.map(s => String(s).trim()).filter((s, i) => i < 4).map(s => s.slice(0, 15))
}

function putDoor (put, check, p, name, facing, tag) {
  check(name)
  const lower = key(p.x, p.y, p.z)
  const upper = key(p.x, p.y + 1, p.z)
  put(p.x, p.y, p.z, { name, item: name, kind: 'door', props: { facing, half: 'lower' }, phase: PHASE.door, pair: upper, ...tag })
  put(p.x, p.y + 1, p.z, { name, item: null, kind: 'part', props: { half: 'upper' }, phase: PHASE.door, pair: lower, ...tag })
}

function putBed (put, check, p, name, facing, tag) {
  check(name)
  const d = DIRS[facing]
  const foot = key(p.x, p.y, p.z)
  const head = key(p.x + d[0], p.y, p.z + d[2])
  put(p.x, p.y, p.z, { name, item: name, kind: 'bed', props: { facing, part: 'foot' }, phase: PHASE.fixture, pair: head, ...tag })
  put(p.x + d[0], p.y, p.z + d[2], { name, item: null, kind: 'part', props: { part: 'head' }, phase: PHASE.fixture, pair: foot, ...tag })
}

// Факел, фонарь, табличка. На стене — facing от стены, опора за спиной; на
// полу — опора снизу; фонарь может висеть — опора сверху.
function putFixture (put, check, p, name, part, tag) {
  const base = itemFor(name)
  if (/lantern$/.test(base)) {
    check(base)
    put(p.x, p.y, p.z, { name: base, item: base, kind: 'lantern', props: { hanging: part.hanging ? 'true' : 'false' }, support: part.hanging ? 'up' : 'down', phase: PHASE.fixture, ...tag })
    return
  }
  if (part.facing && HORIZONTAL.includes(part.facing)) {
    const wall = wallVariant(base)
    check(wall)
    put(p.x, p.y, p.z, { name: wall, item: base, kind: 'wall', props: { facing: part.facing }, support: OPP[part.facing], phase: PHASE.fixture, ...tag })
    return
  }
  check(base)
  put(p.x, p.y, p.z, { name: base, item: base, kind: 'floor', support: 'down', faces: part.faces || null, phase: PHASE.fixture, ...tag })
}

// Крыша. from/to — прямоугольник стен, y — верх стены. Первый ряд ступеней
// лежит на свесе вровень с верхом стены, следующий — уже над стеной: так
// выглядит обычная крыша игрока, а не коробка с крышкой.
function compileRoof (part, put, solid, tag) {
  const a = vec(part.from); const b = vec(part.to)
  const x1 = Math.min(a.x, b.x); const x2 = Math.max(a.x, b.x)
  const z1 = Math.min(a.z, b.z); const z2 = Math.max(a.z, b.z)
  const top = Math.max(a.y, b.y)
  const ov = Math.max(0, Math.min(2, part.overhang ?? 1))
  const style = String(part.style || 'gable').toLowerCase()
  const block = part.block
  const stairs = /_stairs$/.test(block)
  const ridge = part.ridge || null
  const xa = x1 - ov; const xb = x2 + ov; const za = z1 - ov; const zb = z2 + ov
  const baseY = top + 1 - ov

  // Ступень, если крыша из ступеней, иначе полный блок той же высоты —
  // «ступенчатая» крыша из того, что есть, а не отказ.
  const step = (x, y, z, facing) => put(x, y, z, stairs
    ? { ...solid(block, { facing, half: 'bottom' }), ...tag }
    : { ...solid(block), ...tag })
  const cap = (x, y, z) => {
    const name = ridge || (stairs ? null : block)
    if (!name) return
    const props = /_slab$/.test(name) ? { type: 'bottom' } : null
    put(x, y, z, { ...solid(name, props), ...tag, role: 'ridge' })
  }

  if (style === 'flat') {
    for (let x = xa; x <= xb; x++) {
      for (let z = za; z <= zb; z++) {
        const name = part.flat || ridge || block
        const props = /_slab$/.test(name) ? { type: 'bottom' } : null
        put(x, top + 1, z, { ...solid(name, props), ...tag })
      }
    }
    return
  }

  if (style === 'hip') {
    for (let i = 0; ; i++) {
      const lx = xa + i; const hx = xb - i; const lz = za + i; const hz = zb - i
      if (lx > hx || lz > hz) break
      const y = baseY + i
      if (lx === hx || lz === hz) {
        for (let x = lx; x <= hx; x++) for (let z = lz; z <= hz; z++) cap(x, y, z)
        break
      }
      for (let x = lx; x <= hx; x++) {
        step(x, y, lz, 'south')
        step(x, y, hz, 'north')
      }
      for (let z = lz + 1; z <= hz - 1; z++) {
        step(lx, y, z, 'east')
        step(hx, y, z, 'west')
      }
    }
    return
  }

  // gable: конёк вдоль axis; по умолчанию — вдоль длинной стороны.
  const axis = part.axis || ((x2 - x1) >= (z2 - z1) ? 'x' : 'z')
  const span = axis === 'z' ? xb - xa + 1 : zb - za + 1
  const peak = Math.floor((span - 1) / 2)
  const gable = part.gable || null
  for (let s = 0; s < span; s++) {
    const i = Math.min(s, span - 1 - s)
    const y = baseY + i
    const centre = span % 2 === 1 && s === peak
    const up = s < span - 1 - s
    for (let t = (axis === 'z' ? za : xa); t <= (axis === 'z' ? zb : xb); t++) {
      const x = axis === 'z' ? xa + s : t
      const z = axis === 'z' ? t : za + s
      if (centre) cap(x, y, z)
      else step(x, y, z, axis === 'z' ? (up ? 'east' : 'west') : (up ? 'south' : 'north'))
    }
    // Фронтоны: треугольник стены под скатом на обоих торцах.
    if (gable) {
      for (let yy = top + 1; yy < y; yy++) {
        if (axis === 'z') {
          const x = xa + s
          if (x < x1 || x > x2) continue
          put(x, yy, z1, { ...solid(gable), ...tag, role: 'gable' })
          put(x, yy, z2, { ...solid(gable), ...tag, role: 'gable' })
        } else {
          const z = za + s
          if (z < z1 || z > z2) continue
          put(x1, yy, z, { ...solid(gable), ...tag, role: 'gable' })
          put(x2, yy, z, { ...solid(gable), ...tag, role: 'gable' })
        }
      }
    }
  }
}

// ---------------------------------------------------------------- placing

// Поворот и перенос: относительные клетки → мировые. Поворот по часовой вокруг
// начала, потом сдвиг так, чтобы угол коробки встал в origin.
function rotateCells (cells, steps) {
  const s = ((steps % 4) + 4) % 4
  const out = []
  for (const c of cells.values()) {
    let x = c.x; let z = c.z
    for (let i = 0; i < s; i++) [x, z] = [-z, x]
    const props = c.props ? { ...c.props } : undefined
    if (props && props.facing && CW[props.facing]) props.facing = turn(props.facing, s)
    if (props && props.axis && s % 2 === 1 && props.axis !== 'y') props.axis = props.axis === 'x' ? 'z' : 'x'
    const support = c.support && CW[c.support] ? turn(c.support, s) : c.support
    const faces = c.faces && CW[c.faces] ? turn(c.faces, s) : c.faces
    out.push({ ...c, x, z, props, support, faces })
  }
  return out
}

function turn (dir, steps) {
  let d = dir
  for (let i = 0; i < steps; i++) d = CW[d]
  return d
}

function bounds (list) {
  const b = { x1: Infinity, y1: Infinity, z1: Infinity, x2: -Infinity, y2: -Infinity, z2: -Infinity }
  for (const c of list) {
    b.x1 = Math.min(b.x1, c.x); b.y1 = Math.min(b.y1, c.y); b.z1 = Math.min(b.z1, c.z)
    b.x2 = Math.max(b.x2, c.x); b.y2 = Math.max(b.y2, c.y); b.z2 = Math.max(b.z2, c.z)
  }
  return b
}

// Относительный план, повёрнутый и прижатый к нулю по x/z: что получится,
// если origin — это угол (минимальные x и z) на уровне земли.
function layout (parts, { front = 'south', has }) {
  const steps = STEPS[front] ?? 0
  const rel = rotateCells(compileParts(parts, has), steps)
  const b = bounds(rel)
  for (const c of rel) { c.x -= b.x1; c.z -= b.z1 }
  for (const c of rel) {
    if (c.pair) {
      const [px, py, pz] = c.pair.split(',').map(Number)
      let x = px; let z = pz
      for (let i = 0; i < steps; i++) [x, z] = [-z, x]
      c.pair = key(x - b.x1, py, z - b.z1)
    }
  }
  return { rel, size: { w: b.x2 - b.x1 + 1, h: b.y2 - b.y1 + 1, d: b.z2 - b.z1 + 1, y1: b.y1, y2: b.y2 }, steps }
}

// ---------------------------------------------------------------- kinds

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

// Хижина на первую ночь: коробка с плоской крышей, дверь (или проём), факел.
// Пол не кладём — земля и есть пол; только заделываем дыры под стенами.
function hut (p, pal) {
  const W = clampInt(p.width, 3, 9, 5); const D = clampInt(p.depth, 3, 9, 5); const H = clampInt(p.height, 2, 4, 2)
  const mid = Math.floor(W / 2)
  const parts = [
    { type: 'seal', from: [0, -1, 0], to: [W - 1, 0, D - 1], block: pal.fill || pal.main, role: 'foundation' },
    { type: 'clear', from: [1, 1, 1], to: [W - 2, H, D - 2], role: 'inside' },
    { type: 'walls', from: [0, 1, 0], to: [W - 1, H, D - 1], block: pal.main, role: 'walls' },
    { type: 'floor', from: [0, H + 1, 0], to: [W - 1, H + 1, D - 1], block: pal.roofFlat || pal.main, role: 'roof' },
    { type: 'clear', from: [mid, 1, D - 1], to: [mid, 2, D], role: 'doorway' }
  ]
  if (pal.door) parts.push({ type: 'door', at: [mid, 1, D - 1], block: pal.door, facing: 'north', role: 'door', optional: true })
  if (pal.light && W >= 3 && D >= 3) parts.push({ type: 'torch', at: [mid, Math.min(2, H), 1], facing: 'south', block: pal.light, role: 'light', optional: true })
  return parts
}

// Дом: каркас из брёвен по углам, стены, пол, окна со стеклом, дверь в
// торце под фронтоном, двускатная крыша со свесом, свет внутри и у входа.
function house (p, pal) {
  const W = clampInt(p.width, 5, 15, 7); const D = clampInt(p.depth, 5, 17, 9); const H = clampInt(p.height, 3, 6, 4)
  const mid = Math.floor(W / 2); const zm = Math.floor(D / 2)
  const style = String(p.roof || 'gable').toLowerCase()
  const parts = [
    { type: 'seal', from: [0, -2, 0], to: [W - 1, -1, D - 1], block: pal.fill || pal.main, role: 'foundation' },
    { type: 'clear', from: [1, 1, 1], to: [W - 2, H, D - 2], role: 'inside' },
    { type: 'floor', from: [0, 0, 0], to: [W - 1, 0, D - 1], block: pal.floor, role: 'floor' },
    { type: 'walls', from: [0, 1, 0], to: [W - 1, H, D - 1], block: pal.main, role: 'walls' }
  ]
  for (const [x, z] of [[0, 0], [W - 1, 0], [0, D - 1], [W - 1, D - 1]]) {
    parts.push({ type: 'line', from: [x, 1, z], to: [x, H, z], block: pal.frame, axis: 'y', role: 'frame' })
  }
  // Окна: по одному на боковых стенах и на задней, плюс по бокам от двери.
  const winTop = Math.min(H - 1, 3)
  if (pal.window) {
    const win = (from, to) => parts.push({ type: 'window', from, to, block: pal.window, role: 'window', optional: true })
    for (const z of D >= 8 ? [zm - 2, zm + 1] : [zm]) {
      win([0, 2, z], [0, winTop, z]); win([W - 1, 2, z], [W - 1, winTop, z])
    }
    win([mid, 2, 0], [mid, winTop, 0])
    if (W >= 7) { win([mid - 2, 2, D - 1], [mid - 2, 2, D - 1]); win([mid + 2, 2, D - 1], [mid + 2, 2, D - 1]) }
  }
  parts.push({ type: 'clear', from: [mid, 1, D - 1], to: [mid, 2, D], role: 'doorway' })
  if (pal.door) parts.push({ type: 'door', at: [mid, 1, D - 1], block: pal.door, facing: 'north', role: 'door', optional: true })
  // Крыша.
  const roofBlock = pal.stairs || pal.roofFill
  if (style === 'flat') {
    parts.push({ type: 'roof', style: 'flat', from: [0, H, 0], to: [W - 1, H, D - 1], block: roofBlock, flat: pal.slab || pal.roofFill, overhang: 0, role: 'roof' })
  } else {
    parts.push({
      type: 'roof',
      style: style === 'hip' ? 'hip' : 'gable',
      axis: 'z',
      from: [0, H, 0],
      to: [W - 1, H, D - 1],
      overhang: 1,
      block: roofBlock,
      ridge: pal.slab || pal.roofFill,
      gable: pal.frame !== pal.main ? pal.main : pal.roofFill,
      role: 'roof'
    })
  }
  if (pal.light) {
    const t = Math.min(H - 1, 3)
    // Не на zm: там окно, а факел на стекле не держится.
    parts.push({ type: 'torch', at: [1, t, 1], facing: 'east', block: pal.light, role: 'light', optional: true })
    parts.push({ type: 'torch', at: [W - 2, t, D - 2], facing: 'west', block: pal.light, role: 'light', optional: true })
    parts.push({ type: 'torch', at: [mid - 1, 2, D], facing: 'south', block: pal.light, role: 'light', optional: true })
  }
  if (p.furnish) {
    parts.push({ type: 'bed', at: [1, 1, 2], facing: 'north', block: pal.bed || 'red_bed', role: 'furniture', optional: true })
    parts.push({ type: 'chest', at: [W - 2, 1, 1], facing: 'south', role: 'furniture', optional: true })
    parts.push({ type: 'block', at: [W - 2, 1, 2], block: 'crafting_table', role: 'furniture', optional: true })
  }
  return parts
}

// Комната под землёй: землянка в склоне и база в шахте — одна форма. Своё
// держится за природу: оболочка из seal заделывает только дыры, а цельную
// породу не трогает. Фасад — юг: там проём (и дверь, если просили).
function room (p, pal, { door = true, lights = 1 } = {}) {
  const W = clampInt(p.width, 3, 9, 3); const D = clampInt(p.depth, 3, 9, 4); const H = clampInt(p.height, 2, 4, 3)
  const mid = Math.floor(W / 2)
  const fill = pal.fill || pal.main
  const parts = [
    { type: 'clear', from: [0, 1, 0], to: [W - 1, H, D - 1], role: 'inside' },
    { type: 'seal', from: [-1, 0, -1], to: [W, H + 1, D], block: fill, role: 'shell' },
    { type: 'clear', from: [mid, 1, D], to: [mid, 2, D + 1], role: 'doorway' }
  ]
  if (door && pal.door) parts.push({ type: 'door', at: [mid, 1, D], block: pal.door, facing: 'north', role: 'door', optional: true })
  if (pal.light) {
    parts.push({ type: 'torch', at: [mid, 2, 0], facing: 'south', block: pal.light, role: 'light', optional: true })
    if (lights > 1 && W >= 3) {
      parts.push({ type: 'torch', at: [0, 2, Math.floor(D / 2)], facing: 'east', block: pal.light, role: 'light', optional: true })
      parts.push({ type: 'torch', at: [W - 1, 2, Math.floor(D / 2)], facing: 'west', block: pal.light, role: 'light', optional: true })
    }
  }
  if (p.furnish) {
    parts.push({ type: 'chest', at: [0, 1, 0], facing: 'east', role: 'furniture', optional: true })
    if (W >= 3) parts.push({ type: 'block', at: [W - 1, 1, 0], block: 'crafting_table', role: 'furniture', optional: true })
    if (W >= 4 || D >= 4) parts.push({ type: 'block', at: [W - 1, 1, 1], block: 'furnace', facing: 'west', role: 'furniture', optional: true })
    if (D >= 4) parts.push({ type: 'bed', at: [0, 1, 2], facing: 'north', block: pal.bed || 'red_bed', role: 'furniture', optional: true })
  }
  return parts
}

// Склад: ряд сундуков у задней стенки, между ними столбы из брёвен, над
// каждым сундуком — табличка с категорией на стенке, факелы на столбах.
// Табличка над сундуком, а не на его передней грани: ставить её на сундук
// можно только присев (иначе клик откроет сундук), а висящая над ним не мешает
// его открывать — ChestBlock.isChestBlockedAt смотрит только на блок, который
// проводит сигнал, а табличка его не проводит.
function storage (p, pal, labels) {
  const cats = labels.length ? labels : [{ key: 'misc', lines: ['Разное'] }]
  const dbl = !!p.double
  const step = dbl ? 3 : 2
  const L = cats.length * step
  const parts = [
    { type: 'seal', from: [0, -1, -1], to: [L, 0, 1], block: pal.fill || pal.main, role: 'foundation' },
    { type: 'clear', from: [0, 1, 0], to: [L, 3, 1], role: 'inside' },
    { type: 'box', from: [0, 1, -1], to: [L, 3, -1], block: pal.main, role: 'walls' }
  ]
  cats.forEach((c, k) => {
    const x = k * step + 1
    parts.push({ type: 'chest', at: [x, 1, 0], facing: 'south', role: 'chest', label: c.key })
    if (dbl) parts.push({ type: 'chest', at: [x + 1, 1, 0], facing: 'south', role: 'chest', label: c.key })
    parts.push({ type: 'sign', at: [x, 2, 0], facing: 'south', text: c.lines, block: pal.sign, role: 'sign', optional: true, label: c.key })
  })
  for (let k = 0; k <= cats.length; k++) {
    parts.push({ type: 'line', from: [k * step, 1, 0], to: [k * step, 2, 0], block: pal.frame, axis: 'y', role: 'frame' })
    if (pal.light && k % 2 === 0) parts.push({ type: 'torch', at: [k * step, 3, 0], block: pal.light, role: 'light', optional: true })
  }
  return parts
}

// Замок: квадратная стена с зубцами, четыре угловые башни выше стены с
// зубцами поверху, ворота посреди фасада с аркой из перевёрнутых ступеней,
// лестница на стену изнутри, свет по стенам.
function castle (p, pal) {
  let S = clampInt(p.width ?? p.size, 9, 31, 13)
  if (S % 2 === 0) S++
  const H = clampInt(p.height, 3, 8, 4)
  const T = S >= 15 ? 5 : 3
  const TH = H + 2
  const mid = (S - 1) / 2
  const g = S >= 13 ? 1 : 0
  const gh = Math.min(H - 1, g ? 3 : 2)
  const m = pal.main
  const parts = [
    { type: 'seal', from: [0, -1, 0], to: [S - 1, 0, S - 1], block: pal.fill || m, role: 'foundation' },
    // Двор расчищается ПЕРВЫМ: поздняя часть перекрывает раннюю, и стены с
    // башнями должны лечь поверх воздуха, а не наоборот.
    { type: 'clear', from: [1, 1, 1], to: [S - 2, H + 1, S - 2], role: 'yard' },
    // Стены между башнями.
    { type: 'box', from: [T, 1, 0], to: [S - 1 - T, H, 0], block: m, role: 'walls' },
    { type: 'box', from: [T, 1, S - 1], to: [S - 1 - T, H, S - 1], block: m, role: 'walls' },
    { type: 'box', from: [0, 1, T], to: [0, H, S - 1 - T], block: m, role: 'walls' },
    { type: 'box', from: [S - 1, 1, T], to: [S - 1, H, S - 1 - T], block: m, role: 'walls' },
    // Зубцы на стенах.
    { type: 'crenel', from: [T, H + 1, 0], to: [S - 1 - T, H + 1, 0], block: m, role: 'battlement' },
    { type: 'crenel', from: [T, H + 1, S - 1], to: [S - 1 - T, H + 1, S - 1], block: m, role: 'battlement' },
    { type: 'crenel', from: [0, H + 1, T], to: [0, H + 1, S - 1 - T], block: m, role: 'battlement' },
    { type: 'crenel', from: [S - 1, H + 1, T], to: [S - 1, H + 1, S - 1 - T], block: m, role: 'battlement' }
  ]
  // Башни: полые при T=5 (глухой колодец — дешевле сплошной вдвое), сплошные при T=3.
  for (const [x0, z0] of [[0, 0], [S - T, 0], [0, S - T], [S - T, S - T]]) {
    parts.push({ type: 'box', from: [x0, 1, z0], to: [x0 + T - 1, TH, z0 + T - 1], block: pal.frame || m, hollow: T >= 5, role: 'tower' })
    if (T >= 5) parts.push({ type: 'clear', from: [x0 + 1, 1, z0 + 1], to: [x0 + T - 2, TH - 1, z0 + T - 2], role: 'tower' })
    const top = TH + 1
    const ring = []
    for (let i = 0; i < T; i++) ring.push([x0 + i, z0])
    for (let i = 1; i < T; i++) ring.push([x0 + T - 1, z0 + i])
    for (let i = T - 2; i >= 0; i--) ring.push([x0 + i, z0 + T - 1])
    for (let i = T - 2; i >= 1; i--) ring.push([x0, z0 + i])
    ring.forEach(([x, z], i) => { if (i % 2 === 0) parts.push({ type: 'block', at: [x, top, z], block: m, role: 'battlement' }) })
  }
  // Ворота в южной стене и арка.
  parts.push({ type: 'clear', from: [mid - g, 1, S - 1], to: [mid + g, gh, S - 1], role: 'gate' })
  parts.push({ type: 'clear', from: [mid - g, 1, S], to: [mid + g, gh, S], role: 'gate' })
  if (g && pal.stairs && gh >= 3) {
    parts.push({ type: 'block', at: [mid - g, gh, S - 1], block: pal.stairs, facing: 'west', half: 'top', role: 'arch' })
    parts.push({ type: 'block', at: [mid + g, gh, S - 1], block: pal.stairs, facing: 'east', half: 'top', role: 'arch' })
  }
  // Лестница на северную стену изнутри.
  if (pal.ladder) parts.push({ type: 'ladder', from: [mid, 1, 1], to: [mid, H, 1], facing: 'south', role: 'ladder', optional: true })
  if (pal.light) {
    for (const x of [T + 1, S - 2 - T]) parts.push({ type: 'torch', at: [x, 2, 1], facing: 'south', block: pal.light, role: 'light', optional: true })
    for (const x of [mid - g - 1, mid + g + 1]) parts.push({ type: 'torch', at: [x, 2, S], facing: 'south', block: pal.light, role: 'light', optional: true })
  }
  return parts
}

const KINDS = {
  hut: { ru: 'хижина-укрытие', make: hut, site: 'surface', roles: ['door', 'light'], defaults: { width: 5, depth: 5, height: 2 }, note: 'на первую ночь: плоская крыша, дверь или проём, факел' },
  house: { ru: 'дом', make: house, site: 'surface', roles: ['stairs', 'slab', 'frame', 'door', 'window', 'light'], defaults: { width: 7, depth: 9, height: 4, roof: 'gable' }, note: 'пол, каркас из брёвен, окна, дверь, двускатная (hip/flat) крыша со свесом, свет; furnish — кровать, сундук, верстак' },
  dugout: { ru: 'землянка', make: (p, pal) => room(p, pal, { door: true, lights: 1 }), site: 'hill', roles: ['door', 'light'], defaults: { width: 3, depth: 4, height: 3 }, note: 'комната, выкопанная в склоне: копает, заделывает дыры, дверь и факел' },
  mine_room: { ru: 'комната в шахте', make: (p, pal) => room({ ...p, width: p.width ?? 5, depth: p.depth ?? 5 }, pal, { door: !!p.door, lights: 3 }), site: 'ahead', roles: ['light'], defaults: { width: 5, depth: 5, height: 3 }, note: 'база под землёй прямо перед ботом: выкапывает, заделывает пещеры, факелы; furnish — сундук, верстак, печь, кровать' },
  storage: { ru: 'склад', make: null, site: 'surface', roles: ['frame', 'light'], defaults: { double: false }, note: 'ряд сундуков по категориям с табличками над каждым; потом mc_sort раскладывает' },
  castle: { ru: 'замок', make: castle, site: 'surface', roles: ['stairs', 'frame', 'light'], defaults: { width: 13, height: 4 }, note: 'стена с зубцами, угловые башни, ворота с аркой, лестница на стену' }
}

module.exports = {
  DIRS,
  OPP,
  CW,
  HORIZONTAL,
  STEPS,
  PHASE,
  WOODS,
  STONES,
  KINDS,
  key,
  vec,
  kindOf,
  itemFor,
  wallVariant,
  derived,
  palette,
  compileParts,
  layout,
  rotateCells,
  bounds,
  turn,
  signLines,
  hut,
  house,
  room,
  storage,
  castle
}
