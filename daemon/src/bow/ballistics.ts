'use strict'
// Лук (bow.ts): физика стрелы — константы, полёт, решатели угла и прицела, проверка траектории по блокам.
import vec3 from 'vec3'
// Фабрика vec3 (parseFloat, null → 0,0,0), как прежний require('vec3'); тип — класс Vec3.
const Vec3 = vec3 as unknown as typeof import('vec3').Vec3

const SPEED = 3.0
const GRAVITY = 0.05
const DRAG = Math.fround(.99) // AbstractArrow.tick's 0.99f, promoted to double.
const DRAW_MS = 1150

// Летит стрела под углом pitch (вверх +). Возвращает высоту (относительно
// точки вылета) на горизонтальном расстоянии dx и число тиков, или null.
function flight (pitch, dx, speed = SPEED, g = GRAVITY, drag = DRAG) {
  let x = 0; let y = 0
  let vx = Math.cos(pitch) * speed
  let vy = Math.sin(pitch) * speed
  for (let t = 1; t <= 200; t++) {
    const nx = x + vx
    const ny = y + vy
    if (nx >= dx) {
      // Точка на отрезке тика, где пересекли dx.
      const f = (dx - x) / (nx - x)
      return { y: y + (ny - y) * f, ticks: t - 1 + f }
    }
    x = nx; y = ny
    vx *= drag
    vy = vy * drag - g
    if (vx < 1e-3) return null
  }
  return null
}

// Угол, при котором стрела на дистанции dx окажется на высоте dy. Низкая
// траектория: между -45° и углом максимальной дальности высота на dx растёт
// монотонно, так что деление пополам сходится.
// Низ — до −80°: со столба (pvp perch) цель бывает круто под ногами, а при
// −45° решатель молча возвращал сам край и стрела уходила поверх головы.
const LOW = -80 * Math.PI / 180
// Крутой выстрел (steep): цель высоко над головой и близко — кристалл на
// обелиске в сорок блоков высотой с двадцати блоков по земле. Потолок 43°
// такой выстрел отвергал как «не долетит», хотя стрела долетает: высота на
// дистанции dx растёт с углом до своего пика и потом падает, так что верхняя
// граница поиска — это угол пика для этой dx, а не угол максимальной дальности.
// По умолчанию выключено: у всех прежних вызовов поведение прежнее.
const TOP = 1.45
function peakPitch (dx, speed = SPEED, g = GRAVITY) {
  let lo = Math.PI / 4.2
  let hi = TOP
  const at = p => { const f = flight(p, dx, speed, g); return f ? f.y : -Infinity }
  for (let i = 0; i < 50; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (at(m1) < at(m2)) lo = m1
    else hi = m2
  }
  return (lo + hi) / 2
}
// steep = 'lob' — навесом: ветка за пиком, где высота на dx с углом падает.
// Стрела приходит сверху — так бьют кристалл на высоком обелиске, чей край
// закрывает его от пологой стрелы с земли.
function solvePitch (dx, dy, speed = SPEED, g = GRAVITY, steep: any = false) {
  if (steep === 'lob') {
    const at = p => { const f = flight(p, dx, speed, g); return f ? f.y : -Infinity }
    let lo = peakPitch(dx, speed, g)
    let hi = TOP
    if (at(lo) < dy || at(hi) > dy) return null
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (at(mid) > dy) lo = mid
      else hi = mid
    }
    const pitch = (lo + hi) / 2
    const f = flight(pitch, dx, speed, g)
    return f ? { pitch, ticks: f.ticks } : null
  }
  let lo = LOW
  let hi = steep ? peakPitch(dx, speed, g) : Math.PI / 4.2
  const at = p => { const f = flight(p, dx, speed, g); return f ? f.y : -Infinity }
  if (at(hi) < dy) return null // не долетает
  if (at(lo) > dy) return null // круче, чем можно наклонить голову
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (at(mid) < dy) lo = mid
    else hi = mid
  }
  const pitch = (lo + hi) / 2
  const f = flight(pitch, dx, speed, g)
  return f ? { pitch, ticks: f.ticks } : null
}

// Прицел по движущейся цели на точный дробный тик перехвата.
// targetAt(ticks) -> Vec3 точки, куда целимся.
function aim (from, targetAt, speed = SPEED, g = GRAVITY, steep: boolean | string = false) {
  return aimMoving(from, targetAt, { x: 0, y: 0, z: 0 }, false, speed, g, steep)
}

// Projectile.shootFromRotation adds known movement; vertical only airborne.
function aimMoving (from, targetAt, u, airborne = false, speed = SPEED, g = GRAVITY, steep: any = false) {
  // AbstractArrow: p += v; v *= .99; v.y -= .05. Sum whole ticks and
  // the final segment, then solve |launch - inherited movement| = speed.
  // This also handles steep falling shots; an uncompensated fallback misses.
  const uy = airborne ? u.y : 0
  const at = (ticks) => {
    const n = Math.floor(ticks)
    const dragN = DRAG ** n
    const sum = (1 - dragN) / (1 - DRAG) + (ticks - n) * dragN
    const P = targetAt(ticks)
    const v = { x: (P.x - from.x) / sum - u.x,
      y: (P.y - from.y + g * (ticks - sum) / (1 - DRAG)) / sum - uy,
      z: (P.z - from.z) / sum - u.z }
    return { P, v, error: Math.hypot(v.x, v.y, v.z) - speed }
  }
  let lo = .001
  let previous = at(lo).error
  for (let hi = 1; hi <= 200; hi++) {
    const current = at(hi).error
    const crossing = steep === 'lob' ? previous < 0 && current >= 0 : previous > 0 && current <= 0
    if (crossing) {
      let end = hi
      for (let i = 0; i < 35; i++) {
        const mid = (lo + end) / 2
        if ((at(mid).error > 0) === (steep !== 'lob')) lo = mid
        else end = mid
      }
      const ticks = (lo + end) / 2
      const { P, v } = at(ticks)
      const pitch = Math.atan2(v.y, Math.hypot(v.x, v.z))
      return { yaw: Math.atan2(-v.x, -v.z), pitch, ticks, at: P, comp: true }
    }
    lo = hi
    previous = current
  }
  return null
}

// Свободна ли траектория: стрела по тикам (та же физика), каждый отрезок —
// лучом по блокам. Живой прогон: бот вышел из арены через пробитую дыру и
// стрелял в стеклянную стену, потому что целился только по цели, не по пути.
// Возвращает null — путь чист, или точку, где стрела упрётся.
function blockedAt (bot, from, sol, u = { x: 0, y: 0, z: 0 }, speed = SPEED) {
  const dir = { x: -Math.sin(sol.yaw) * Math.cos(sol.pitch), y: Math.sin(sol.pitch), z: -Math.cos(sol.yaw) * Math.cos(sol.pitch) }
  let p = from.clone()
  let v = { x: dir.x * speed + u.x, y: dir.y * speed + (bot.entity?.onGround ? 0 : u.y), z: dir.z * speed + u.z }
  const ticks = Math.ceil(sol.ticks || 20)
  for (let t = 0; t < ticks; t++) {
    const step = new Vec3(v.x, v.y, v.z)
    const len = step.norm()
    if (len < 1e-3) break
    // Последний отрезок — до самой цели, не дальше: цель стоит в своём блоке.
    // Цель на дробном тике (ticks 3.4) — от последнего шага нужна только доля
    // (0.4): полный шаг минус 0.8 пролетал цель и упирался в стену за ней
    // (лаборатория 2026-09-27: блейз у стены — «на линии стрельбы блок» 40 раз).
    const fraction = Math.min(1, (sol.ticks || ticks) - t)
    const reach = t === ticks - 1 ? Math.max(0, len * fraction - 0.8) : len
    try {
      // Направление — копией: Vec3.normalize() меняет сам вектор (vec3), и
      // раньше step после проверки становился единичным — стрела в симуляции
      // шла блок за тик вместо трёх, и проверялась лишь первая треть пути.
      const hit = bot.world.raycast(p, step.scaled(1 / len), reach, b => b && b.boundingBox === 'block')
      if (hit) return hit.position
    } catch { return null }
    p = p.plus(step)
    v = { x: v.x * DRAG, y: v.y * DRAG - GRAVITY, z: v.z * DRAG }
  }
  return null
}

export { SPEED, GRAVITY, DRAG, DRAW_MS, flight, peakPitch, solvePitch, aim, aimMoving, blockedAt }
