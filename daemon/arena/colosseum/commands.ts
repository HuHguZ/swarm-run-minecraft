'use strict'
// Колизей (часть colosseum.ts): команды постройки и разбора, сдерживание и свет поля, габарит, место зрителя.
import { st, parse, isWall, isFence, isBars } from './blocks'
import { Grid } from './grid'

// ---------------------------------------------------------------- команды

// Жадные параллелепипеды одного состояния (x → z → y), не больше 32768.
function greedy (g, want, order = 'xzy') {
  const done = new Uint8Array(g.data.length)
  const boxes = []
  const { x0, x1, y0, y1, z0, z1 } = g
  const same = (i, v) => g.data[i] === v && !done[i]
  for (let y = y0; y <= y1; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const i = g.i(x, y, z)
        const v = g.data[i]
        if (!v || done[i] || !want(v, i)) continue
        let xa = x; let za = z
        if (order === 'xzy') {
          while (xa < x1 && same(g.i(xa + 1, y, z), v)) xa++
          grow: while (za < z1) { for (let xx = x; xx <= xa; xx++) if (!same(g.i(xx, y, za + 1), v)) break grow; za++ }
        } else {
          while (za < z1 && same(g.i(x, y, za + 1), v)) za++
          grow2: while (xa < x1) { for (let zz = z; zz <= za; zz++) if (!same(g.i(xa + 1, y, zz), v)) break grow2; xa++ }
        }
        let ya = y
        const area = (xa - x + 1) * (za - z + 1)
        growY: while (ya < y1 && area * (ya - y + 2) <= 32768) {
          for (let zz = z; zz <= za; zz++) for (let xx = x; xx <= xa; xx++) if (!same(g.i(xx, ya + 1, zz), v)) break growY
          ya++
        }
        for (let yy = y; yy <= ya; yy++) for (let zz = z; zz <= za; zz++) for (let xx = x; xx <= xa; xx++) done[g.i(xx, yy, zz)] = 1
        boxes.push({ x, y, z, x2: xa, y2: ya, z2: za, v })
      }
    }
  }
  return boxes
}

// «Малярный» порядок: материалы ставятся слоями, и параллелепипед раннего
// материала может захватывать клетки, которые потом перекроет более поздний
// (но не воздух и не уже поставленное). Засыпка кавеи и стены — крупными
// блоками сквозь пояса, ступени и карнизы; детали — поверх.
function painter (g, order) {
  const rank = new Int32Array(g.pal.length).fill(-1)
  order.forEach((v, r) => { rank[v] = r })
  const covered = new Uint8Array(g.data.length)
  const boxes = []
  const { x0, x1, y0, y1, z0, z1 } = g
  for (let r = 0; r < order.length; r++) {
    const v = order[r]
    const ok = i => { const w = g.data[i]; return w === v || (w && rank[w] > r) }
    const run = (mode) => {
      const out = []
      const cov = new Uint8Array(0)
      const done = new Uint8Array(g.data.length)
      for (let y = y0; y <= y1; y++) {
        for (let z = z0; z <= z1; z++) {
          for (let x = x0; x <= x1; x++) {
            const i = g.i(x, y, z)
            if (g.data[i] !== v || done[i]) continue
            let xa = x; let za = z
            if (mode === 'xzy') {
              while (xa < x1 && ok(g.i(xa + 1, y, z))) xa++
              grow: while (za < z1) { for (let xx = x; xx <= xa; xx++) if (!ok(g.i(xx, y, za + 1))) break grow; za++ }
            } else {
              while (za < z1 && ok(g.i(x, y, za + 1))) za++
              grow2: while (xa < x1) { for (let zz = z; zz <= za; zz++) if (!ok(g.i(xa + 1, y, zz))) break grow2; xa++ }
            }
            // Обрезать края, где нет ни одной своей клетки (лишний захват не нужен).
            let ya = y
            const area = (xa - x + 1) * (za - z + 1)
            growY: while (ya < y1 && area * (ya - y + 2) <= 32768) {
              for (let zz = z; zz <= za; zz++) for (let xx = x; xx <= xa; xx++) if (!ok(g.i(xx, ya + 1, zz))) break growY
              ya++
            }
            for (let yy = y; yy <= ya; yy++) for (let zz = z; zz <= za; zz++) for (let xx = x; xx <= xa; xx++) { const j = g.i(xx, yy, zz); if (g.data[j] === v) done[j] = 1 }
            out.push({ x, y, z, x2: xa, y2: ya, z2: za, v })
          }
        }
      }
      void cov
      return out
    }
    const a = run('xzy'); const b = run('zxy')
    const best = a.length <= b.length ? a : b
    for (const bx of best) {
      for (let yy = bx.y; yy <= bx.y2; yy++) for (let zz = bx.z; zz <= bx.z2; zz++) for (let xx = bx.x; xx <= bx.x2; xx++) covered[g.i(xx, yy, zz)] = 1
      boxes.push(bx)
    }
  }
  return boxes
}

const ATTACHED = /(lantern|_banner|torch)$/
function toCmd (b, s, X, Y, Z, nbt?: any) {
  const full = 'minecraft:' + s + (nbt || '')
  if (b.x === b.x2 && b.y === b.y2 && b.z === b.z2) return `/setblock ${X + b.x} ${Y + b.y} ${Z + b.z} ${full}`
  return `/fill ${X + b.x} ${Y + b.y} ${Z + b.z} ${X + b.x2} ${Y + b.y2} ${Z + b.z2} ${full}`
}

// Порядок материалов: сперва основание (обсидиан), потом массы по убыванию
// числа клеток, песок — после основания под ним, навесное (фонари, флаги) —
// в самом конце, когда держатели уже стоят.
function materialOrder (g) {
  const count = new Map()
  for (let i = 0; i < g.data.length; i++) { const v = g.data[i]; if (v) count.set(v, (count.get(v) || 0) + 1) }
  const name = v => parse(g.pal[v]).name
  const tier = v => {
    const n = name(v)
    if (ATTACHED.test(n)) return 4
    if (n === 'sand') return 3
    if (n === 'obsidian' || n === 'crying_obsidian') return 0
    return 1
  }
  return [...count.keys()].sort((a, b) => tier(a) - tier(b) || count.get(b) - count.get(a))
}

// Для команд: форму ступеней и соединения стен/заборов/решёток игра считает
// сама при установке (/fill без strict: BlockInput.place → updateFromNeighbourShapes)
// и при каждой смене соседа — в команде они не важны, а разные формы рвали
// бы параллелепипеды. Модель (g) хранит итог — для проверки мира и рендера.
function placeGrid (g) {
  const q = new Grid(g.x0, g.x1, g.y0, g.y1, g.z0, g.z1)
  const map = new Uint16Array(g.pal.length)
  for (let v = 1; v < g.pal.length; v++) {
    const { name, props } = parse(g.pal[v])
    let ns = g.pal[v]
    if (name.endsWith('_stairs')) ns = st(name, { facing: props.facing, half: props.half })
    else if (isWall(g.pal[v]) || isFence(g.pal[v]) || isBars(g.pal[v])) ns = name
    map[v] = q.id(ns)
  }
  for (let i = 0; i < g.data.length; i++) q.data[i] = map[g.data[i]]
  q.nbt = g.nbt
  return q
}

function commands (m, { X, Y, Z }: any) {
  const g: any = placeGrid(m.g)
  const order = materialOrder(g)
  const att = v => ATTACHED.test(parse(g.pal[v]).name)
  const main = painter(g, order.filter(v => !att(v)))
  const tail = []
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i]
    if (!v || !att(v)) continue
    const x = i % g.sx + g.x0; const rest = Math.floor(i / g.sx); const z = rest % g.sz + g.z0; const y = Math.floor(rest / g.sz) + g.y0
    tail.push({ x, y, z, x2: x, y2: y, z2: z, v, nbt: g.nbt.get(i) })
  }
  const out = [...main, ...tail].map(b => toCmd(b, g.pal[b.v], X, Y, Z, b.nbt))
  for (const c of out) if (c.length > 250) throw new Error('команда длиннее 250: ' + c)
  return out
}

// Разбор: воздух на всё, что ставит модель (сверху вниз — песок не сыплется).
function undoCommands (m, { X, Y, Z }: any) {
  const { g } = m
  const mask = new Grid(g.x0, g.x1, g.y0, g.y1, g.z0, g.z1)
  const one = mask.id('air')
  for (let i = 0; i < g.data.length; i++) if (g.data[i]) mask.data[i] = one
  const a = greedy(mask, () => true, 'xzy'); const b = greedy(mask, () => true, 'zxy')
  return (a.length <= b.length ? a : b).sort((p, q) => q.y2 - p.y2).map(bx => toCmd(bx, 'air', X, Y, Z))
}

// Сдерживание поля (ведёт arena.js, ставит и сборщик): сплошной барьер от слоя
// пола (dy −1) до потолка по всему периметру R+1 и потолок; дно щели —
// плачущий обсидиан (есть и в модели). Всё — взрывостойкое.
function fieldCommands ({ X, Y, Z, R, ceilH, ceiling = true }: any) {
  const r = R + 1; const top = Y + ceilH - 1
  const out = []
  const fill = (x1, y1, z1, x2, y2, z2, b) => {
    const area = (Math.abs(x2 - x1) + 1) * (Math.abs(z2 - z1) + 1)
    const step = Math.max(1, Math.floor(32768 / area))
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y += step) out.push(`/fill ${x1} ${y} ${z1} ${x2} ${Math.min(Math.max(y1, y2), y + step - 1)} ${z2} ${b}`)
  }
  fill(X - r, Y - 2, Z - r, X + r, Y - 2, Z - r, 'minecraft:crying_obsidian')
  fill(X - r, Y - 2, Z + r, X + r, Y - 2, Z + r, 'minecraft:crying_obsidian')
  fill(X - r, Y - 2, Z - r, X - r, Y - 2, Z + r, 'minecraft:crying_obsidian')
  fill(X + r, Y - 2, Z - r, X + r, Y - 2, Z + r, 'minecraft:crying_obsidian')
  fill(X - r, Y - 1, Z - r, X + r, top, Z - r, 'minecraft:barrier')
  fill(X - r, Y - 1, Z + r, X + r, top, Z + r, 'minecraft:barrier')
  fill(X - r, Y - 1, Z - r, X - r, top, Z + r, 'minecraft:barrier')
  fill(X + r, Y - 1, Z - r, X + r, top, Z + r, 'minecraft:barrier')
  if (ceiling) fill(X - r, Y + ceilH, Z - r, X + r, Y + ceilH, Z + r, 'minecraft:barrier')
  return out
}

// Свет поля в стиле «колизей»: линии вдоль x — светокамень (взрыв выбивает,
// дыр по ходу раунда больше), вдоль z — плачущий обсидиан (свет 10, не
// выбить: поле освещено, даже если светокамня не осталось). Пересечения —
// плачущий обсидиан (ставится вторым).
function fieldLightCommands ({ X, Y, Z, R }: any) {
  const out = []
  for (let d = -R + 4; d <= R - 4; d += 8) out.push(`/fill ${X - R} ${Y - 1} ${Z + d} ${X + R} ${Y - 1} ${Z + d} minecraft:glowstone`)
  for (let d = -R + 4; d <= R - 4; d += 8) out.push(`/fill ${X + d} ${Y - 1} ${Z - R} ${X + d} ${Y - 1} ${Z + R} minecraft:crying_obsidian`)
  return out
}

// Габарит постройки в мировых координатах (forceload, /kill мобов, отчёт).
function footprint (m, { X, Y, Z }: any) {
  const { g } = m
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity; let z0 = Infinity; let z1 = -Infinity
  for (let i = 0; i < g.data.length; i++) {
    if (!g.data[i]) continue
    const x = i % g.sx + g.x0; const rest = Math.floor(i / g.sx); const z = rest % g.sz + g.z0; const y = Math.floor(rest / g.sz) + g.y0
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  return { x0: X + x0, x1: X + x1, y0: Y + y0, y1: Y + y1, z0: Z + z0, z1: Z + z1 }
}

// Где ставить зрителя: пульвинар, лицом к полю.
function watchSpot (m, { X, Y, Z }: any) {
  const s = m.pulvinar.spot
  return { x: X + s.dx + 0.5, y: Y + s.dy, z: Z + s.dz + 0.5, yaw: m.pulvinar.yaw, pitch: 12 }
}

export { greedy, painter, ATTACHED, toCmd, materialOrder, placeGrid, commands, undoCommands, fieldCommands, fieldLightCommands, footprint, watchSpot }
