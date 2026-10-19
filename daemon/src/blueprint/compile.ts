'use strict'
// Чертёж: части плана → клетки (стены, пол, проёмы, двери, кровати, утварь, таблички) и крыша.
import { key, kindOf, itemFor, PHASE, vec, range, OPP, HORIZONTAL, DIRS, wallVariant } from './names'

// ---------------------------------------------------------------- compile

// Части → клетки в относительных координатах. Каждая клетка знает имя блока,
// состояние, чем её ставить (item), фазу и за что держаться (support).
export function compileParts (parts, has) {
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

  const solid = (name, props = null, extra: any = {}) => {
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
  const out: any = {}
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
export function signLines (text) {
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
