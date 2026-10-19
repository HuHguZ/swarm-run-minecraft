'use strict'

// Отдельная граница планирования: сетка только из загруженных клиентом блоков.
function planBoatRoute ({ start, target, grid, astar, landingAt = null, maxNodes = 40000, radius = landingAt ? 24 : 12 }: any) {
  const distance = n => Math.hypot(n.x - target.x, n.z - target.z)
  // В открытой воде обычный A* остаётся быстрым. Отказ ближайшего пруда
  // означает переход к поиску по связной компоненте, а не отказ всей езды.
  if (!landingAt) {
    let nearest = null
    for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
      const n = { x: Math.floor(target.x) + dx, y: start.y, z: Math.floor(target.z) + dz }
      if (grid.water(n.x, n.z) && (!nearest || distance(n) < distance(nearest))) nearest = n
    }
    if (nearest) {
      const route = astar(start, n => Math.hypot(n.x - nearest.x, n.z - nearest.z) <= 1.5, grid.neighbours,
        n => Math.hypot(n.x - nearest.x, n.z - nearest.z), maxNodes)
      if (route.complete) return { ...route, goal: nearest, landing: null, fromShore: distance(nearest) }
    }
  }
  // Каждый рассмотренный узел имеет реальный водный путь от лодки. Поэтому
  // островной пруд не может победить связный берег только своей близостью.
  const key = n => `${n.x},${n.y},${n.z}`
  const queue = [start]
  const parent = new Map([[key(start), null]])
  let chosen = null
  let landing = null
  let bestScore = Infinity
  let nearest = start
  let head = 0
  while (head < queue.length && head < maxNodes) {
    const n = queue[head++]
    if (distance(n) < distance(nearest)) nearest = n
    if (distance(n) <= radius && grid.water(n.x, n.z)) {
      const dry = landingAt ? landingAt(n) : null
      if (!landingAt || dry) {
        const score = distance(dry || n)
        if (score < bestScore) { chosen = n; landing = dry; bestScore = score }
        if (score < 0.01) break
      }
    }
    for (const { n: next } of grid.neighbours(n)) {
      const nk = key(next)
      if (parent.has(nk)) continue
      parent.set(nk, n)
      queue.push(next)
    }
  }
  const goal = chosen || nearest
  const path = []
  for (let n = goal; n; n = parent.get(key(n))) path.push(n)
  path.reverse()
  return { path, complete: !!chosen, seen: head, goal, landing, fromShore: distance(goal) }
}

export { planBoatRoute }
