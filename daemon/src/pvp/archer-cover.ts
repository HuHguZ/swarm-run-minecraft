import { Vec3 } from 'vec3'
import * as clock from '../game-clock'
import * as pick from '../pick'
import { bodyClear, dimensions, standPositions, supportAt } from '../navigation/geometry'
import { insideArena } from '../flee'
import { observedCollision } from './search'

interface Cover { at: Vec3; path: Vec3[]; distance: number; arena?: any }
const plans = new WeakMap<object, any>()

// Неизвестный блок не даёт укрытия: луч pick пересекает только уже увиденные формы.
export function archerCovered (bot, eye: Vec3, at = bot.entity.position, world = observedCollision(bot)) {
  const { half, height } = dimensions(bot)
  const d = at.minus(eye), length = Math.hypot(d.x, d.z) || 1
  for (const h of [.15, height / 2, height - .1]) for (const shoulder of [-half, 0, half]) {
    const body = at.offset(-d.z / length * shoulder, h, d.x / length * shoulder)
    const ray = body.minus(eye), distance = ray.norm()
    if (!distance || !pick.blockOnRay(world, eye, ray.scaled(1 / distance), distance)) return false
  }
  return true
}

function corridor (world, from: Vec3, to: Vec3, arena) {
  const samples = Math.max(1, Math.ceil(from.distanceTo(to) * 4))
  let last = from
  for (let i = 1; i <= samples; i++) {
    const p = from.plus(to.minus(from).scaled(i / samples)), support = supportAt(world, p.offset(0, .6, 0), 1.2)
    if (!support || Math.abs(support.top - p.y) > .6) return false
    p.y = support.top
    if (Math.abs(p.y - last.y) > .6 || !insideArena(p, arena) || !bodyClear(world, p)) return false
    last = p
  }
  return true
}

// Ближайшая пешая цепочка по увиденным опорам; ступень в полблока допустима, яма — нет.
export function archerCover (bot, eye: Vec3, { arena = null, maxRun = 8.6, advance = false }: any = {}): Cover | null {
  const me = bot.entity.position, key = JSON.stringify([eye, arena, maxRun, advance])
  if (!insideArena(me, arena) || !Number.isFinite(maxRun) || maxRun < 0) return null
  let cache = plans.get(bot)
  if (!cache) {
    cache = {}; plans.set(bot, cache)
    bot.on?.('blockUpdate', () => { cache.until = -Infinity })
  }
  if (clock.now() < cache.until && cache.world === bot.world && cache.key === key && me.distanceTo(cache.from) < 1) return cache.plan
  const seen = observedCollision(bot), cells = new Map<string, any>()
  const world = { ...seen, blockAt (p) { const k = p.floored().toString(); if (!cells.has(k)) cells.set(k, seen.blockAt(p)); return cells.get(k) } }
  const queue = [{ at: me.clone(), path: [] as Vec3[], distance: 0 }], costs = new Map<string, number>()
  let plan: Cover = null
  // shortcut: 192 опоры за поиск, для более длинного обхода остаётся обычная навигация.
  for (let n = 0; queue.length && n < 192; n++) {
    queue.sort((a, b) => a.distance - b.distance)
    const node = queue.shift()!
    if (node.distance > (costs.get(node.at.toString()) ?? Infinity)) continue
    // При подходе укрытие должно приближать к стрелку, иначе каждый выход из-за задней колонны вернёт к ней.
    if ((!advance || node.at.distanceTo(eye) < me.distanceTo(eye)) && archerCovered(bot, eye, node.at, world)) { plan = { ...node, arena }; break }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      for (const at of standPositions(world, node.at.offset(dx, 0, dz), { rise: .6, drop: .6 })) {
        const distance = node.distance + node.at.distanceTo(at), id = at.toString()
        if (distance > maxRun || distance >= (costs.get(id) ?? Infinity) || !corridor(world, node.at, at, arena)) continue
        costs.set(id, distance); queue.push({ at, path: [...node.path, at], distance })
      }
    }
  }
  Object.assign(cache, { key, from: me.clone(), world: bot.world, until: clock.now() + 500, plan })
  return plan
}

// Взгляд остаётся на стрелке, клавиши ведут по проверенным коротким отрезкам.
export function steerArcherCover (bot, cover: Cover) {
  while (cover.path.length && bot.entity.position.distanceTo(cover.path[0]) < (cover.path.length === 1 ? .1 : .3)) cover.path.shift()
  const to = cover.path[0]
  if (!to) { bot.clearControlStates(); return false }
  if (!corridor(observedCollision(bot), bot.entity.position, to, cover.arena)) { bot.clearControlStates(); return false }
  const d = to.minus(bot.entity.position), length = Math.hypot(d.x, d.z) || 1, yaw = bot.entity.yaw
  const forward = (-Math.sin(yaw) * d.x - Math.cos(yaw) * d.z) / length
  const side = (Math.cos(yaw) * d.x - Math.sin(yaw) * d.z) / length
  bot.setControlState('forward', forward > .38); bot.setControlState('back', forward < -.38)
  bot.setControlState('right', side > .38); bot.setControlState('left', side < -.38)
  bot.setControlState('sprint', forward > .38 && (bot.food ?? 20) > 6); bot.setControlState('jump', false)
  return true
}
