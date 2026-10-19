'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { Movements } from 'mineflayer-pathfinder'
import { unstick } from '../movement'
import { withTimeout } from '../build'
import { EYE, REACH, sleep, k3, isSolid, isPassable, centre, canStand } from './world'

// ---------------------------------------------------------------- movement

function buildMovements (bot) {
  const m = new Movements(bot)
  m.canDig = false
  m.allow1by1towers = false
  m.scafoldingBlocks = []
  m.allowSprinting = false
  m.maxDropDown = 3
  return m
}

async function walk (bot, goal, ms) {
  const from = bot.entity.position.clone()
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, 'не дошёл')
    return true
  } catch {
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    // Не сдвинулся вовсе — тело зажато (впритык к стене после смены хитбокса,
    // см. session.connect playerHalfWidth): встряхнуть, как это делает goto.
    if (bot.entity.position.distanceTo(from) < 0.2) await unstick(bot)
    return false
  }
}

// Где встать, чтобы дотянуться до клетки: ближе к телу, не в будущей стене,
// не на земле, которую сейчас выкопаем, не в самой клетке и её паре.
// band — соседние по очереди клетки: место, откуда достаётся больше их,
// лучше ближнего — иначе тело ходит за каждым блоком отдельно.
function standSpots (bot, c, ctx, { outside = null, band = null }: any = {}) {
  const T = centre(c.pos)
  const me = bot.entity.position
  const pairPos = c.pair ? ctx.byKey.get(c.pair)?.pos : null
  const out = []
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (let dy = -5; dy <= 1; dy++) {
        const S = c.pos.offset(dx, dy, dz)
        if (S.offset(0.5, EYE, 0.5).distanceTo(T) > REACH - 0.3) continue
        // Не в клетке, не под ней головой и не НА ней: блок под ногами тело
        // не трогает (reachable ниже), и место «на цели» — вечная ходьба туда же.
        if (S.equals(c.pos) || S.offset(0, 1, 0).equals(c.pos) || S.offset(0, -1, 0).equals(c.pos)) continue
        if (pairPos && (S.equals(pairPos) || S.offset(0, 1, 0).equals(pairPos))) continue
        if (outside && S.x >= outside.x1 && S.x <= outside.x2 && S.z >= outside.z1 && S.z <= outside.z2) continue
        if (!canStand(bot, S)) continue
        if (ctx.reach && !ctx.reach.has(k3(S))) continue
        let score = S.distanceTo(me)
        if (band) {
          const eye = S.offset(0.5, EYE, 0.5)
          let cover = 0
          for (const b of band) if (eye.distanceTo(centre(b.pos)) <= REACH - 0.2) cover++
          score -= Math.min(cover, 24) * 0.6
        }
        if (ctx.pendingSolid.has(k3(S)) || ctx.pendingSolid.has(k3(S.offset(0, 1, 0)))) score += 6
        if (ctx.pendingAir.has(k3(S.offset(0, -1, 0)))) score += 12
        out.push({ p: S, score })
      }
    }
  }
  return out.sort((a, b) => a.score - b.score)
}

// Куда тело дойдёт пешком отсюда — тем же набором ходов, что pathfinder без
// копания и без столбов: шаг, шаг на блок вверх, падение до трёх. Место
// встать, до которого не дойти (на верху стены, в замкнутом углу), раньше
// выбиралось по близости — и pathfinder искал к нему дорогу до таймаута:
// 5104 частичных поиска и 15 таймаутов за один дом, 243 с из 315 на ходьбу.
function reachMap (bot, box, { margin = 6, limit = 15000 }: any = {}) {
  const s = bot.entity.position.floored()
  const X1 = Math.min(box.x1, s.x) - margin; const X2 = Math.max(box.x2, s.x) + margin
  const Z1 = Math.min(box.z1, s.z) - margin; const Z2 = Math.max(box.z2, s.z) + margin
  const Y1 = Math.min(box.y1, s.y) - 4; const Y2 = Math.max(box.y2, s.y) + 3
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const open = (x, y, z) => isPassable(at(x, y, z))
  const solid = (x, y, z) => isSolid(at(x, y, z))
  const seen = new Set()
  const q = [[s.x, s.y, s.z]]
  seen.add(k3(s))
  const push = (x, y, z) => {
    if (x < X1 || x > X2 || z < Z1 || z > Z2 || y < Y1 || y > Y2) return
    const k = `${x},${y},${z}`
    if (seen.has(k)) return
    seen.add(k); q.push([x, y, z])
  }
  while (q.length && seen.size < limit) {
    const [x, y, z] = q.shift()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const nz = z + dz
      if (open(nx, y, nz) && open(nx, y + 1, nz)) {
        let ny = y
        while (ny > y - 4 && !solid(nx, ny - 1, nz) && open(nx, ny - 1, nz)) ny--
        if (solid(nx, ny - 1, nz)) push(nx, ny, nz)
      } else if (solid(nx, y, nz) && open(x, y + 2, z) && open(nx, y + 1, nz) && open(nx, y + 2, nz)) {
        push(nx, y + 1, nz)
      }
    }
  }
  return seen
}

// Выйти наружу пешком: соседняя клетка на том же уровне, шаг на блок вверх
// (прыжок) и падение. Сверх этого тело из коробки не выберется — летать не
// умеет, а столб наружу это уже порча чужой стены.
function canWalkOut (bot, box, extra) {
  // Дверь здесь — стена: pathfinder 2.4.5 открывать умеет только калитки
  // (movements.js: openable — только имена с «gate»), и из дома с закрытой
  // дверью тело пешком не выйдет. Поэтому дверь ставится снаружи.
  const solidAt = (x, y, z) => extra.has(`${x},${y},${z}`) || isSolid(bot.blockAt(new Vec3(x, y, z)))
  const passable = (x, y, z) => !solidAt(x, y, z) && !solidAt(x, y + 1, z)
  const outside = (x, y, z) => x < box.x1 || x > box.x2 || z < box.z1 || z > box.z2 || y > box.y2 + 1
  const s = bot.entity.position.floored()
  const q = [[s.x, s.y, s.z]]
  const seen = new Set([k3(s)])
  const push = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (seen.has(k)) return
    seen.add(k); q.push([x, y, z])
  }
  while (q.length && seen.size < 8000) {
    const [x, y, z] = q.shift()
    if (outside(x, y, z)) return true
    let fy = y
    while (fy > box.y1 - 4 && !solidAt(x, fy - 1, z)) fy--
    if (fy !== y) { push(x, fy, z); continue }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx; const nz = z + dz
      if (passable(nx, y, nz)) push(nx, y, nz)
      else if (!solidAt(x, y + 2, z) && passable(nx, y + 1, nz)) push(nx, y + 1, nz)
    }
  }
  return false
}

// ---------------------------------------------------------------- placing

function waitLook (bot) {
  return new Promise<any>(resolve => {
    const t = gameClock.setTimeout(done, 160)
    function done () { gameClock.clearTimeout(t); bot.removeListener('move', done); resolve(undefined) }


    bot.once('move', done)
  })
}

async function waitChange (bot, pos, before, ms) {
  const deadline = gameClock.now() + ms
  while (gameClock.now() < deadline) {
    const b = bot.blockAt(pos)
    if (b && b.name !== before) return b
    await sleep(50)
  }
  return null
}

export { buildMovements, walk, standSpots, reachMap, canWalkOut, waitLook, waitChange }
