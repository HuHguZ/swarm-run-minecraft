'use strict'
// Огонь на земле тушится ударом: у огня прочность 0 — гаснет с первого удара, контур — плита 1/16 у пола, прицел клиента
// в неё упирается (так тушит и cast1). Пользователь 16.10: «не умеют огонь рукой тушить — это спасать будет их часто, и не
// мешать им идти ко мне». Гасит то, что видит прицел в досягаемости: огонь у ног (стоит в нём или шагнёт) и огонь по пути
// к цели — поиск пути огонь обходит, удар открывает коридор, путь пересчитывается сам (block_updated).
import { blockOnRay, eyeOf, rayBox } from './pick'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

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

// Прицел сейчас (взгляд тела) упирается в этот огонь: луч входит в его контур раньше любого блока.
function aimedAt (bot, at) {
  const e = bot.entity, eye = eyeOf(bot)
  const dir = new Vec3(-Math.sin(e.yaw) * Math.cos(e.pitch), Math.sin(e.pitch), -Math.cos(e.yaw) * Math.cos(e.pitch))
  const t = rayBox(eye, dir, at, at.offset(1, 1 / 16, 1), REACH)
  if (t == null) return false
  const hit = blockOnRay(bot, eye, dir, t)
  return !hit || hit.pos.equals(at)
}

// На каждом тике физики, пока тело живо: одна клетка за раз. Взгляд на огонь, тик (пакет взгляда ушёл), и удар — только если
// прицел всё ещё на нём: в бою прицел дуэли каждый тик ведёт к врагу и может перебить взгляд. Журнал: «[fire-punch] тушу» и
// «прицел перебит» (не чаще раза в 2 с) — сколько тушат и сколько срывает бой.
function hookFirePunch (session, bot) {
  if (!bot || bot._ndFirePunch || typeof bot.on !== 'function') return
  bot._ndFirePunch = true
  let busy = false, missAt = 0
  bot.on('physicsTick', () => {
    if (busy || process.env.ND_FIRE_PUNCH === '0' || bot !== session.bot) return
    let need = null
    try { need = fireToPunch(bot) } catch {}
    if (!need) return
    busy = true
    // Два тика голова — моя: прицел дуэли в бою поворачивает её к врагу каждый тик (стенд 22.10: удар на огонь срывался 99
    // раз против 43 удачных). Чужие повороты на это время глохнут, после удара — снова их.
    const at = need.block.position, look = bot.look, mute = () => Promise.resolve()
    const unmute = () => { if (bot.look === mute) bot.look = look }
    const d = need.point.minus(eyeOf(bot))
    bot.look = mute
    look.call(bot, Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)), true).then(() => bot.waitForTicks(1)).then(() => {
      if (!FIRE.test(bot.blockAt(at)?.name || '')) return
      if (!aimedAt(bot, at)) {
        if (Date.now() - missAt > 2000) { missAt = Date.now(); console.log(`[fire-punch] огонь ${at} — прицел перебит`) }
        return
      }
      console.log(`[fire-punch] тушу огонь ${at}`)
      const dig = bot.dig(need.block, 'ignore')
      unmute()
      return dig
    }).catch(() => {}).finally(() => { unmute(); busy = false })
  })
}

export { fireToPunch, hookFirePunch, aimedAt, FIRE }
