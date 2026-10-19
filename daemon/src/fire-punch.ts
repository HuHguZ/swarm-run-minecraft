'use strict'
// Огонь на земле тушится ударом: у огня прочность 0 — гаснет с первого удара, контур — плита 1/16 у пола, прицел клиента
// в неё упирается (так тушит и cast1). Пользователь 16.10: «не умеют огонь рукой тушить — это спасать будет их часто, и не
// мешать им идти ко мне». Гасит то, что видит прицел в досягаемости: огонь у ног (стоит в нём или шагнёт) и огонь по пути
// к цели — поиск пути огонь обходит, удар открывает коридор, путь пересчитывается сам (block_updated).
import { blockOnRay, eyeOf } from './pick'

const FIRE = /^(fire|soul_fire)$/
const REACH = 4.5

function fireToPunch (bot) {
  const me = bot.entity?.position
  if (!me || bot.targetDigBlock || !((bot.health ?? 20) > 0)) return null
  const eye = eyeOf(bot)
  const goal = bot.pathfinder?.goal
  const v = bot.entity.velocity || { x: 0, z: 0 }
  const to = goal && Number.isFinite(goal.x) && Number.isFinite(goal.z) ? { x: goal.x - me.x, z: goal.z - me.z } : { x: v.x, z: v.z }
  const len = Math.hypot(to.x, to.z)
  let best = null
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -1; dy <= 1; dy++) {
    const b = bot.blockAt(me.offset(dx, dy, dz))
    if (!b || !FIRE.test(b.name)) continue
    const point = b.position.offset(0.5, 0.5 / 16, 0.5)
    const flat = Math.hypot(point.x - me.x, point.z - me.z)
    const ahead = len > 0.05 && flat > 0 && ((point.x - me.x) * to.x + (point.z - me.z) * to.z) / (len * flat) > 0.5
    if (flat > 1.5 && !ahead) continue
    const d = point.distanceTo(eye)
    if (d > REACH || d < 1e-3) continue
    const hit = blockOnRay(bot, eye, point.minus(eye).scaled(1 / d), d)
    if (hit && !hit.pos.equals(b.position)) continue
    if (!best || d < best.d) best = { block: b, point, d }
  }
  return best
}

// На каждом тике физики, пока тело живо: одна клетка за раз, без своего ожидания — удар мгновенный.
function hookFirePunch (session, bot) {
  if (!bot || bot._ndFirePunch || typeof bot.on !== 'function') return
  bot._ndFirePunch = true
  let busy = false
  bot.on('physicsTick', () => {
    if (busy || process.env.ND_FIRE_PUNCH === '0' || bot !== session.bot) return
    let need = null
    try { need = fireToPunch(bot) } catch {}
    if (!need) return
    busy = true
    bot.lookAt(need.point, true).then(() => bot.dig(need.block, 'ignore')).catch(() => {}).finally(() => { busy = false })
  })
}

export { fireToPunch, hookFirePunch, FIRE }
