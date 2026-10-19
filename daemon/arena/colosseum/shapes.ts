'use strict'
// Колизей (часть colosseum.ts): формы блоков после установки — как их посчитает сервер.
import { WALL_TEST, DIR, OPP, CCW, HOR, axisOf, st, parse, isStairs, isWall, isFence, isBars, isFullCube, octMask, faceBits, sturdyFace, isExceptionForConnection } from './blocks'

// ------------------------------------------------ формы по правилам игры

// Ступени (StairBlock.getStairsShape), стены (WallBlock), заборы (FenceBlock),
// решётки/панели — как посчитает сервер после установки всего, чтобы модель
// совпала с миром.
function finishShapes (g) {
  const at = (x, y, z) => g.get(x, y, z)
  for (let pass = 0; pass < 2; pass++) {
    for (let y = g.y0; y <= g.y1; y++) {
      for (let z = g.z0; z <= g.z1; z++) {
        for (let x = g.x0; x <= g.x1; x++) {
          const s = g.pal[g.data[g.i(x, y, z)]]
          if (!s) continue
          if (isStairs(s)) {
            const { name, props } = parse(s)
            const F = props.facing; const H = props.half
            const [fx, fz] = DIR[F]
            let shape = 'straight'
            const front = at(x + fx, y, z + fz)
            const canTake = face => { const [ax, az] = DIR[face]; const n = at(x + ax, y, z + az); return !isStairs(n) || parse(n).props.facing !== F || parse(n).props.half !== H }
            if (isStairs(front) && parse(front).props.half === H) {
              const F2 = parse(front).props.facing
              if (axisOf(F2) !== axisOf(F) && canTake(OPP[F2])) shape = F2 === CCW[F] ? 'outer_left' : 'outer_right'
            }
            if (shape === 'straight') {
              const back = at(x - fx, y, z - fz)
              if (isStairs(back) && parse(back).props.half === H) {
                const F3 = parse(back).props.facing
                if (axisOf(F3) !== axisOf(F) && canTake(F3)) shape = F3 === CCW[F] ? 'inner_left' : 'inner_right'
              }
            }
            if (shape !== props.shape) g.set(x, y, z, st(name, { ...props, shape }))
          } else if (isWall(s) || isFence(s) || isBars(s)) {
            const { name, props } = parse(s)
            const np: Record<string, any> = { ...props }
            const con: Record<string, any> = {} as Record<string, any>
            for (const d of HOR) {
              const [dx, dz] = DIR[d]
              const nb = at(x + dx, y, z + dz)
              const solid = sturdyFace(nb, OPP[d]) && !isExceptionForConnection(nb)
              if (isWall(s)) con[d] = isWall(nb) || solid || isBars(nb)
              else if (isFence(s)) con[d] = solid || (isFence(nb) && /(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|pale_oak)_fence$/.test(parse(nb).name))
              else con[d] = solid || isBars(nb) || isWall(nb)
            }
            if (isWall(s)) {
              const above = at(x, y + 1, z)
              const cover = test => coversDown(above, test)
              for (const d of HOR) np[d] = con[d] ? (cover(WALL_TEST[d]) ? 'tall' : 'low') : 'none'
              np.up = String(raisePost(np, above))
            } else for (const d of HOR) np[d] = String(con[d])
            np.waterlogged = 'false'
            const ns = st(name, np)
            if (ns !== s) g.set(x, y, z, ns)
          }
        }
      }
    }
  }
}
// Нижняя грань блока сверху (коллизия) покрывает ли тест [x0,z0,x1,z1]/16.
function coversDown (above, test) {
  if (!above) return false
  if (isFullCube(above)) return true
  const { name, props } = parse(above)
  if (name.endsWith('_slab')) return props.type !== 'top'
  if (name.endsWith('_stairs')) {
    const m = octMask(above); const f = faceBits(m, 'down') // биты: (ix, iz) → a=ix, b=iz
    const [x0, z0, x1, z1] = test
    for (let ix = 0; ix < 2; ix++) {
      for (let iz = 0; iz < 2; iz++) {
        const ox0 = ix * 8; const ox1 = ox0 + 8; const oz0 = iz * 8; const oz1 = oz0 + 8
        const touches = x0 < ox1 && x1 > ox0 && z0 < oz1 && z1 > oz0
        if (touches && !(f & (1 << (ix * 2 + iz)))) return false
      }
    }
    return true
  }
  if (name === 'lantern') { // [5..11]×[5..11], стоячий касается низа
    if (props.hanging === 'true') return false
    const [x0, z0, x1, z1] = test
    return x0 >= 5 && x1 <= 11 && z0 >= 5 && z1 <= 11
  }
  return false
}
function raisePost (np, above) {
  if (isWall(above) && parse(above).props.up === 'true') return true
  const n = np.north === 'none'; const s = np.south === 'none'; const e = np.east === 'none'; const w = np.west === 'none'
  if ((n && s && e && w) || n !== s || e !== w) return true
  if ((np.north === 'tall' && np.south === 'tall') || (np.east === 'tall' && np.west === 'tall')) return false
  if (above && /(_banner|torch|_sign|pressure_plate)$/.test(parse(above).name)) return true
  return coversDown(above, WALL_TEST.post)
}

export { finishShapes }
