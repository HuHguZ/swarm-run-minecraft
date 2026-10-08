'use strict'
const gameClock = require('./src/game-clock')
// Случайный рельеф для тестовой арены arena.js (ARENA_TERRAIN=1). Генератор
// 26.09 из прежнего arena-terrain.js: тот файл с 05.10 — фиксированный профиль
// Колизея слота 31 (arena-builder), и ARENA_TERRAIN=1 падал (D1, 2026-10-06).
// Рельеф арены: ямы, из которых не выпрыгнуть (3-4 блока), лавовые ямы,
// бассейн, возвышенности и укрытия. Каждый раунд — по-новому (seed), точки
// появления бойцов и полоса между ними свободны. Позиционная война: столкнуть в
// лаву, запереть в яме, выбраться из неё, занять высоту.
//
// Всё — командами /fill, по объёму меньше 32768 блоков за раз. Под полом
// арены (Y-6..Y-2) лежит сплошной камень: ямы выкапываются в нём, и сброс
// арены заливает его обратно целиком — под ареной не остаётся дыр в чужой мир.

function rng (seed) {
  let s = seed >>> 0 || 1
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

// Сброс: камень под полом, пол, воздух над ним. cmd — функция команды.
// top — верх коробки (arena.js TOP(): с потолком для булавы и зарядов ветра —
// Y+15 под барьером на Y+16): столбы и блоки выше Y+8 иначе переживали раунд
// (2026-09-26). fillBox режет объём по высоте под предел /fill в 32768 блоков.
async function clearTerrain (cmd, fillBox, { X, Y, Z, R, top = Y + 8 }: any) {
  await fillBox(X - R, Y - 6, Z - R, X + R, Y - 2, Z + R, 'minecraft:stone')
  await fillBox(X - R, Y - 1, Z - R, X + R, Y - 1, Z + R, 'minecraft:smooth_stone')
  await fillBox(X - R, Y, Z - R, X + R, Math.max(Y + 8, top), Z + R, 'minecraft:air')
}

// Построить рельеф. avoid — точки [x, z], вокруг которых (радиус 4) и между
// которыми (полоса шириной 3) ничего не ставим: бойцы появляются там.
async function buildTerrain (cmd, { X, Y, Z, R, seed = gameClock.wall.now(), avoid = [], canopies = 0 }: any) {
  const rand = rng(seed)
  const ri = (a, b) => a + Math.floor(rand() * (b - a + 1))
  const taken = []
  const features = []
  const free = (x1, z1, x2, z2, pad = 1) => {
    if (x1 < X - R + 2 || x2 > X + R - 2 || z1 < Z - R + 2 || z2 > Z + R - 2) return false
    for (const [ax, az] of avoid) {
      if (ax > x1 - 4 && ax < x2 + 4 && az > z1 - 4 && az < z2 + 4) return false
    }
    // Полоса между двумя точками появления — чистая, чтобы бой начинался лицом к лицу.
    if (avoid.length >= 2) {
      const [a, b] = avoid
      const minx = Math.min(a[0], b[0]); const maxx = Math.max(a[0], b[0])
      if (x2 >= minx && x1 <= maxx && z2 >= Math.min(a[1], b[1]) - 1 && z1 <= Math.max(a[1], b[1]) + 1) return false
    }
    for (const t of taken) {
      if (x1 - pad <= t[2] && x2 + pad >= t[0] && z1 - pad <= t[3] && z2 + pad >= t[1]) return false
    }
    return true
  }
  const place = (w, d, tries = 40) => {
    for (let i = 0; i < tries; i++) {
      const x1 = X - R + 3 + ri(0, 2 * R - 6 - w)
      const z1 = Z - R + 3 + ri(0, 2 * R - 6 - d)
      if (free(x1, z1, x1 + w - 1, z1 + d - 1, 2)) {
        taken.push([x1, z1, x1 + w - 1, z1 + d - 1])
        return [x1, z1, x1 + w - 1, z1 + d - 1]
      }
    }
    return null
  }

  // Ямы: 2x2 или 3x3, глубина 3-4 — прыжком (1.25) не выбраться. Каждая
  // третья — с водой на дне (падение не бьёт, но выбираться всё равно надо).
  const pits = ri(3, 4)
  for (let i = 0; i < pits; i++) {
    const w = ri(2, 3)
    const depth = ri(3, 4)
    const a = place(w, w)
    if (!a) continue
    await cmd(`/fill ${a[0]} ${Y - depth} ${a[1]} ${a[2]} ${Y - 1} ${a[3]} minecraft:air`)
    const water = rand() < 0.33
    if (water) await cmd(`/fill ${a[0]} ${Y - depth} ${a[1]} ${a[2]} ${Y - depth} ${a[3]} minecraft:water`)
    features.push({ kind: water ? 'яма с водой' : 'яма', at: a, depth })
  }
  // Лавовые ямы: лава на уровне пола (Y-1), 2x2..3x2.
  const lavas = ri(2, 3)
  for (let i = 0; i < lavas; i++) {
    const a = place(ri(2, 3), 2)
    if (!a) continue
    await cmd(`/fill ${a[0]} ${Y - 1} ${a[1]} ${a[2]} ${Y - 1} ${a[3]} minecraft:lava`)
    features.push({ kind: 'лава', at: a })
  }
  // Бассейн 3x3, глубина 2.
  {
    const a = place(3, 3)
    if (a) {
      await cmd(`/fill ${a[0]} ${Y - 2} ${a[1]} ${a[2]} ${Y - 1} ${a[3]} minecraft:water`)
      features.push({ kind: 'вода', at: a })
    }
  }
  // Возвышенности: 3x3..4x4 высотой 2-3 — на них не зайти без блоков.
  const hills = ri(2, 3)
  for (let i = 0; i < hills; i++) {
    const w = ri(3, 4)
    const h = ri(2, 3)
    const a = place(w, w)
    if (!a) continue
    await cmd(`/fill ${a[0]} ${Y} ${a[1]} ${a[2]} ${Y + h - 1} ${a[3]} minecraft:stone_bricks`)
    // Ступенька с одной стороны — на часть высот можно забежать.
    if (rand() < 0.5) await cmd(`/fill ${a[0]} ${Y} ${a[1] - 1} ${a[0]} ${Y} ${a[1] - 1} minecraft:stone_bricks`)
    features.push({ kind: `высота ${h}`, at: a })
  }
  // Укрытия: стенки 3x1 высотой 2 и столбы 1x1 высотой 3.
  const covers = ri(4, 6)
  for (let i = 0; i < covers; i++) {
    const along = rand() < 0.5
    const a = place(along ? 3 : 1, along ? 1 : 3)
    if (!a) continue
    await cmd(`/fill ${a[0]} ${Y} ${a[1]} ${a[2]} ${Y + 1} ${a[3]} minecraft:cobblestone`)
    features.push({ kind: 'стенка', at: a })
  }
  const pillars = ri(2, 4)
  for (let i = 0; i < pillars; i++) {
    const a = place(1, 1)
    if (!a) continue
    await cmd(`/fill ${a[0]} ${Y} ${a[1]} ${a[0]} ${Y + 2} ${a[1]} minecraft:cobblestone`)
    features.push({ kind: 'столб', at: a })
  }
  // Навесы (S7d, трезубцы с «Громовержцем»): крыша 3×3 из досок на высоте 4 на четырёх столбах — под ней молния не
  // бьёт (channeling.json: can_see_sky у жертвы), с боков открыто. ARENA_CANOPY=n.
  for (let i = 0; i < canopies; i++) {
    const a = place(3, 3)
    if (!a) continue
    for (const [cx, cz] of [[a[0], a[1]], [a[2], a[1]], [a[0], a[3]], [a[2], a[3]]]) await cmd(`/fill ${cx} ${Y} ${cz} ${cx} ${Y + 2} ${cz} minecraft:oak_fence`)
    await cmd(`/fill ${a[0]} ${Y + 3} ${a[1]} ${a[2]} ${Y + 3} ${a[3]} minecraft:oak_planks`)
    features.push({ kind: 'навес', at: a })
  }
  return features
}

module.exports = { buildTerrain, clearTerrain, rng }
