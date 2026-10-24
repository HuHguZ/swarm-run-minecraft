// Спрыгнуть от врага (пользователь 25.10: «не спрыгивают сверху — легко умирают»): наверху (ярус, крыша, насест) человек
// пришёл на удар — край в стороне от него, где падение дёшево: вода, ведро в хотбаре (сторож падения ставит воду сам) или урон,
// после которого остаётся minHpAfter. Шаг с края бегом; приземление внутри арены.
import { Vec3 } from 'vec3'
import * as gameClock from '../game-clock'

const DIRS = 16

export async function jumpDown (session, ctl, p: any = {}) {
  const bot = session.require()
  const me = bot.entity.position, hp = bot.health ?? 20, minHpAfter = p.minHpAfter ?? 6
  const edges = require('../edges')
  const mlg = edges.mlgDrop(session).ok
  const from = p.from ? new Vec3(p.from.x, p.from.y, p.from.z) : null
  const solid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z), false); return !!b && b.boundingBox === 'block' }
  const name = (x, y, z) => bot.blockAt(new Vec3(x, y, z), false)?.name
  const inside = at => !p.arena || require('./team-wind').windInside(at, p.arena)
  const fy = Math.floor(me.y + 1e-6)
  let best: any = null
  for (let k = 0; k < DIRS; k++) {
    const a = k * 2 * Math.PI / DIRS, dx = -Math.sin(a), dz = -Math.cos(a)
    for (let r = 1; r <= 4; r++) {
      const x = Math.floor(me.x + dx * r), z = Math.floor(me.z + dz * r)
      // Путь до края: голова и ноги свободны; дальше по лучу — только если под ногами ещё пол.
      if (solid(x, fy, z) || solid(x, fy + 1, z)) break
      if (solid(x, fy - 1, z)) continue
      let land = null, water = false, lava = false
      for (let y = fy - 1; y >= fy - 48; y--) {
        const n = name(x, y, z)
        if (n === undefined) break
        if (n === 'lava') { lava = true; break }
        if (n === 'water' || n === 'bubble_column') { water = true; land = y + 1; break }
        if (solid(x, y, z)) { land = y + 1; break }
      }
      if (land == null || lava) break
      const drop = me.y - land
      if (drop < 2.5) break
      const at = new Vec3(x + .5, land, z + .5)
      if (!inside(at)) break
      const dmg = water ? 0 : Math.max(0, Math.ceil(drop - 3))
      if (!(water || hp - dmg >= minHpAfter || mlg && drop <= 40)) break
      const away = from ? at.distanceTo(from) : 0
      const score = (water || mlg ? 0 : dmg) * 1.5 + r * .5 - away
      if (!best || score < best.score) best = { score, a, drop, dmg: water || mlg ? 0 : dmg, at, r }
      break
    }
  }
  if (!best) return { ok: false, why: 'нет края с дешёвым падением' }
  await bot.look(best.a, 0, true).catch(() => {})
  bot.setControlState('sneak', false)
  bot.setControlState('forward', true); bot.setControlState('sprint', best.r > 1)
  const y0 = me.y, t0 = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() - t0 < 600 + best.r * 300 && bot.entity.position.y > y0 - 1.5) await new Promise(r => gameClock.setTimeout(r, 50))
  } finally { bot.clearControlStates() }
  const fell = bot.entity.position.y < y0 - 1.5
  if (fell) {
    // Долететь до земли: сторож падения сам ставит воду; ждём касания.
    const t1 = gameClock.now()
    while (!ctl.aborted && !bot.entity.onGround && gameClock.now() - t1 < 4000) await new Promise(r => gameClock.setTimeout(r, 50))
  }
  return { ok: fell, drop: Math.round(best.drop * 10) / 10, dmg: best.dmg, mlg, at: bot.entity.position.floored(), hp: bot.health }
}
