// Лук с «Отдачей» — сброс с края (пользователь 24.10: «луком откидывать, чтобы убить»). Стрела почти не подкидывает: 1.21.11
// AbstractArrow.doKnockback — push(вдоль полёта стрелы по горизонтали × 0.6 × уровень × (1 − сопротивление), 0.1, …), до
// этого обычный отброс попадания LivingEntity.knockback(0.4) от стрелы. Значит, «Отдача» — откинуть: с обрыва, с террасы,
// подброшенного — дальше наружу. Здесь — прогноз: если стрела попадёт сейчас, упадёт ли он (edges.knockRun — тот же полёт
// тела, что у сброса ударом, он рулит назад к опоре).
import { Vec3 } from 'vec3'
import edges = require('../edges')
import * as pick from '../pick'

/** Victim velocity right after a Punch arrow along horizontal `dir` (unit): hurt knockback, then the Punch push. */
export function punchVelocity(vel: Vec3, onGround: boolean, dir: { x: number; z: number }, punch: number, resist = 0) {
  const k = 1 - Math.max(0, Math.min(1, resist))
  let v = edges.knockback(vel, edges.KB_HIT * k, -dir.x, -dir.z, onGround)
  const s = .6 * punch * k
  if (s > 0) v = new Vec3(v.x + dir.x * s, v.y + .1, v.z + dir.z * s)
  return v
}

/** Would an arrow released now (flight `ticks`, from `eye`) drop him off his footing? */
export function punchDrops(bot: any, e: any, punch: number, ticks: number, vel: { x: number; y: number; z: number }) {
  if (!e?.position || punch <= 0) return { drop: false, why: 'без Отдачи' }
  const at = e.position.offset(vel.x * ticks, 0, vel.z * ticks), eye = pick.eyeOf(bot)
  const h = Math.hypot(at.x - eye.x, at.z - eye.z) || 1
  const dir = { x: (at.x - eye.x) / h, z: (at.z - eye.z) / h }
  const v = punchVelocity(new Vec3(vel.x, vel.y, vel.z), !!e.onGround, dir, punch, edges.resistOf(bot, e))
  // Он рулит назад (к стрелку — оттуда, где опора): взгляд на меня, «вперёд».
  const face = Math.atan2(-(eye.x - at.x), -(eye.z - at.z))
  const r = edges.knockRun(bot, edges.stateOf(bot), at, v, !!e.onGround, face, true, new Map())
  return { drop: !!r.fall, lava: !!r.lava, v }
}

/** Is there a drop within `r` blocks of him (edges.clearance looks up to 3) — the only case worth holding a drawn Punch bow for? */
export function nearDrop(bot: any, e: any, r = 3) {
  try { return edges.clearance(bot, e.position, r, new Map()) < r } catch { return false }
}
