// Облёт на элитрах вокруг подброшенного врага (пользователь 25.10: «хочу, чтобы в полёте кидали… научи кружить»): взлёт,
// круг радиуса R на высоте летуна (без элитр — выше на 3), пока он в воздухе; заряды ветра бросает рефлекс сброса тела (wind-out, RANGE_FLY) на
// каждом сближении. Он сел (на 6 бл. над полем или ниже), время вышло — посадка подальше от него и нагрудник назад.
import * as gameClock from '../game-clock'
import { windCount } from '../mace/hands'

export async function wingOrbit (session, ctl, p: any = {}) {
  const bot = session.require()
  const sky = require('../elytra')
  const { Vec3 }: typeof import('vec3') = require('vec3')
  const foe = () => bot.players?.[p.target]?.entity
  if (!foe()) return { ok: false, why: 'цели не видно' }
  const k = sky.kit(bot)
  if (!k.elytra || k.rockets < 2 + sky.RESCUE_ROCKETS) return { ok: false, why: 'нет элитр или ракет' }
  const R = p.radius ?? 8, floorY = Number.isFinite(p.floorY) ? p.floorY : (p.arena?.y ?? -64)
  const high = () => { const e = foe(); return !!e && (!e.onGround || e.position.y - floorY > 6) }
  if (!high()) return { ok: false, why: 'он не в воздухе' }
  if (bot.entity.onGround || !sky.gliding(bot.entity)) {
    if (!windCount(bot)) return { ok: false, why: 'нет зарядов ветра' }
    const t = await sky.takeoff(bot, ctl, { pitch: 1.2, arena: p.arena })
    if (!t.ok) return { ok: false, why: 'взлёт: ' + t.why }
  }
  const t0 = gameClock.now()
  let near = 0, closest = Infinity
  // Стоит на гребне (пользователь 25.10: «с центра колизея тоже скидывать, элитровые в помощь») — не круг, а дуга ±0.8 рад.
  // со стороны центра арены: снаружи заряд толкнул бы его внутрь, а с центра — наружу, через край; сбили — тот же заход
  // добивает падающего. Сторона дуги меняется, когда бот дошёл до её конца.
  const c = p.arena && Number.isFinite(p.arena.x) ? p.arena : null
  let sweep = 1
  const flight = await sky.fly(bot, ctl, {
    arena: p.arena, maxMs: (p.seconds ?? 12) * 1000, phase: 'облёт',
    goal: () => {
      const e = foe(); if (!e) return null
      const me = bot.entity.position, f = e.position
      const d = Math.hypot(me.x - f.x, me.z - f.z); closest = Math.min(closest, me.distanceTo(f)); if (me.distanceTo(f) < 16) near++
      // Точка круга на 0.7 рад. впереди по ходу: бот всё время догоняет её и обходит его кругом.
      const ledge = c && (e.onGround || p.ledge) && Math.hypot(f.x - c.x, f.z - c.z) > R
      if (ledge) {
        const ai = Math.atan2(c.z - f.z, c.x - f.x), rel = Math.atan2(Math.sin(Math.atan2(me.z - f.z, me.x - f.x) - ai), Math.cos(Math.atan2(me.z - f.z, me.x - f.x) - ai))
        if (d < R * 1.6 && rel * sweep > .6) sweep = -sweep
        const a = ai + (d < R * 1.6 ? .8 * sweep : 0)
        return { kind: 'point', at: new Vec3(f.x + Math.cos(a) * R, f.y + 2, f.z + Math.sin(a) * R), minY: f.y - 1, maxY: f.y + 10, gap: 3, speedMin: .4 }
      }
      const a = Math.atan2(me.z - f.z, me.x - f.x) + (d < R * 1.6 ? .7 : 0)
      return { kind: 'point', at: new Vec3(f.x + Math.cos(a) * R, f.y + (sky.gliding(e) ? 0 : 3), f.z + Math.sin(a) * R), minY: f.y - 2, maxY: f.y + 12, gap: 3, speedMin: .4 }
    },
    rocketIf: s => { const e = foe(); return !!e && (s.p.y < e.position.y + 1 || Math.hypot(s.v.x, s.v.z) < .6) },
    until: () => !windCount(bot) ? 'заряды закончились' : !high() ? 'он внизу' : null
  })
  const e = foe()
  let landed: any = { ok: !!bot.entity.onGround }
  if (sky.gliding(bot.entity)) landed = await sky.land(bot, ctl, { away: e ? e.position : null, arena: p.arena })
  try { if (bot.entity.onGround && sky.wearingElytra(bot)) await sky.chestDown(bot, ctl, { arena: p.arena }) } catch {}
  return { ok: true, why: flight.why, ms: gameClock.now() - t0, nearTicks: near, closest: Number.isFinite(closest) ? Math.round(closest * 10) / 10 : null, landed: !!landed.ok, at: bot.entity.position.floored() }
}
