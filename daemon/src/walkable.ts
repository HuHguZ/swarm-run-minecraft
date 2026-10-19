'use strict'
// Куда отсюда можно дойти ногами: заливка по клеткам, где тело стоит (пол
// твёрдый, ноги и голова свободны, ни лавы, ни огня, ни портала), шагом в
// четыре стороны с подъёмом и спуском на блок. Это не зрение — это «ощупью»:
// какие клетки связаны с той, где стою. Что ВИДНО, решает луч (perception
// raySees / bot.canSeeBlock) поверх этого списка.
//
// Зачем отдельно. Кольца точек вокруг тела (blaze.js, первый прогон) находили
// «укрытие» за стеной арены и на её крыше — pathfinder туда не доходил, и все
// четыре попытки отдыха ушли в никуда. Заливка знает только связанные клетки.

const Vec3: typeof import('vec3').Vec3 = require('vec3')

const HAZARD = /lava|fire|portal|gateway|magma_block|campfire|cactus|sweet_berry|powder_snow|cobweb/
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function passable (b) {
  return !!b && b.boundingBox === 'empty' && !HAZARD.test(b.name) && !/water/.test(b.name)
}

function standable (bot, p) {
  const g = bot.blockAt(p.offset(0, -1, 0))
  if (!g || g.boundingBox !== 'block' || HAZARD.test(g.name)) return false
  return passable(bot.blockAt(p)) && passable(bot.blockAt(p.offset(0, 1, 0)))
}

// Двери и решётки проёма — по желанию: закрытая деревянная дверь это стена для
// заливки, но не для тела с руками (stronghold.js открывает/ломает их).
function isDoorway (b) {
  return !!b && /_door$|iron_bars/.test(b.name)
}

// Узлы заливки: [{pos, d}] — d в шагах от старта. Первый — сам старт.
function walkable (bot, start, { radius = 24, maxNodes = 4000, doors = false }: any = {}) {
  const s = start.floored ? start.floored() : new Vec3(Math.floor(start.x), Math.floor(start.y), Math.floor(start.z))
  const key = p => `${p.x},${p.y},${p.z}`
  const seen = new Set([key(s)])
  const out = [{ pos: s, d: 0 }]
  const r2 = radius * radius
  for (let i = 0; i < out.length && out.length < maxNodes; i++) {
    const { pos, d } = out[i]
    for (const [dx, dz] of DIRS) {
      for (const dy of [0, 1, -1]) {
        const n = pos.offset(dx, dy, dz)
        const k = key(n)
        if (seen.has(k)) continue
        if ((n.x - s.x) ** 2 + (n.z - s.z) ** 2 > r2) continue
        // Подъём: над головой в своей клетке должно быть место для прыжка.
        if (dy === 1 && !passable(bot.blockAt(pos.offset(0, 2, 0)))) continue
        // Спуск: клетка над целью (наша высота головы там) тоже свободна.
        if (dy === -1 && !passable(bot.blockAt(n.offset(0, 2, 0)))) continue
        let ok = standable(bot, n)
        if (!ok && doors && dy === 0) {
          const f = bot.blockAt(n)
          const h = bot.blockAt(n.offset(0, 1, 0))
          const g = bot.blockAt(n.offset(0, -1, 0))
          ok = !!g && g.boundingBox === 'block' && (isDoorway(f) || passable(f)) && (isDoorway(h) || passable(h)) &&
            (isDoorway(f) || isDoorway(h))
        }
        if (!ok) continue
        seen.add(k)
        out.push({ pos: n, d: d + 1 })
        break
      }
    }
  }
  return out
}

export { walkable, standable, passable, isDoorway, HAZARD }
