'use strict'
// Чертёж: поворот фасада и раскладка плана в клетки с границами.
import { CW, STEPS, key } from './names'
import { compileParts } from './compile'

// ---------------------------------------------------------------- placing

// Поворот и перенос: относительные клетки → мировые. Поворот по часовой вокруг
// начала, потом сдвиг так, чтобы угол коробки встал в origin.
export function rotateCells (cells, steps) {
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

export function turn (dir, steps) {
  let d = dir
  for (let i = 0; i < steps; i++) d = CW[d]
  return d
}

export function bounds (list) {
  const b = { x1: Infinity, y1: Infinity, z1: Infinity, x2: -Infinity, y2: -Infinity, z2: -Infinity }
  for (const c of list) {
    b.x1 = Math.min(b.x1, c.x); b.y1 = Math.min(b.y1, c.y); b.z1 = Math.min(b.z1, c.z)
    b.x2 = Math.max(b.x2, c.x); b.y2 = Math.max(b.y2, c.y); b.z2 = Math.max(b.z2, c.z)
  }
  return b
}

// Относительный план, повёрнутый и прижатый к нулю по x/z: что получится,
// если origin — это угол (минимальные x и z) на уровне земли.
export function layout (parts, { front = 'south', has }: any) {
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
