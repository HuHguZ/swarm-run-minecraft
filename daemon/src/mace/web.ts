import { Vec3 } from 'vec3'
import * as clock from '../game-clock'
import * as pick from '../pick'
import { FACES, withTimeout } from '../build'
import { observedCollision } from '../pvp/search'
import { seesPlayer } from '../pvp/last-seen'

// Цена в тиках: смена руки, пакет/ответ и один расходник; поднятый щит не размыкаем.
function plan(bot, sm, { shieldTicks = Infinity, pearlTicks = Infinity, deadlineTicks = Infinity } = {}) {
  const item = bot.inventory?.slots?.slice(36, 45).find(i => i?.name === 'cobweb' && i.count > 0)
  if (!item || !sm?.vel || ![sm.from?.x, sm.from?.y, sm.from?.z, sm.vel.x, sm.vel.y, sm.vel.z].every(Number.isFinite) || sm.vel.y >= 0) return null
  const placeTicks = (bot.heldItem?.name === 'cobweb' ? 1 : 2) + 1 + Math.ceil((bot.player?.ping || 0) / 50)
  const me = bot.entity.position, off = Math.hypot(sm.at.x - me.x, sm.at.z - me.z)
  const escapeTicks = Math.max(0, 5 - off) / .28 + 4
  if (placeTicks + 1 + 4 / item.count >= Math.min(shieldTicks, escapeTicks, pearlTicks)) return null
  const world = observedCollision(bot), p = new Vec3(sm.from.x, sm.from.y - 1.6, sm.from.z)
  let vx = sm.vel.x, vy = sm.vel.y, vz = sm.vel.z
  // Та же модель видимого полёта, что в threats.smashes, но до клетки перехвата, а не до нашей головы.
  for (let ticks = 1; ticks <= 45; ticks++) {
    const prev = p.clone()
    p.x += vx; p.y += vy; p.z += vz; vy = (vy - .08) * .98; vx *= .91; vz *= .91
    // Быстрое падение пересекает несколько клеток за тик; паутина входит в fall_damage_resetting.
    for (let y = Math.floor(prev.y); y >= Math.floor(p.y); y--) {
      const fraction = Math.max(0, Math.min(1, (prev.y - y - 1) / (prev.y - p.y)))
      const at = new Vec3(Math.floor(prev.x + (p.x - prev.x) * fraction), y, Math.floor(prev.z + (p.z - prev.z) * fraction))
      const block = world.blockAt(at)
      if (!block || block.boundingBox === 'block') return null
      if (at.y < me.y - 3) return null
      if (!/^(air|cave_air|void_air)$/.test(block.name)) continue
      // Своё тело не запутываем; над головой ставим через видимую грань с повторной проверкой траектории.
      if (me.y + (bot.entity.height || 1.8) > at.y && me.x + .3 > at.x && me.x - .3 < at.x + 1 && me.z + .3 > at.z && me.z - .3 < at.z + 1) continue
      // Оставляем время на щит после попытки: блок ещё не означает, что он уже в паутине.
      const deadline = Math.min(ticks - 1 + fraction, sm.ticks, deadlineTicks)
      if (deadline <= placeTicks + (Number.isFinite(shieldTicks) ? shieldTicks : 1)) continue
      if ((Object.values(bot.entities || {}) as any[]).some(e => {
        if (!e?.position || e === bot.entity || !(e.type === 'player' || e.username) || !seesPlayer(bot, e)) return false
        const b = pick.hitboxOf(bot, e)
        return b.lo.x < at.x + 1 && b.hi.x > at.x && b.lo.y < at.y + 1 && b.hi.y > at.y && b.lo.z < at.z + 1 && b.hi.z > at.z
      })) continue
      for (const face of FACES) {
        const ref = world.blockAt(at.minus(face))
        if (!ref || ref.boundingBox !== 'block' || /water|lava/.test(ref.name)) continue
        const aim = pick.faceAim(bot, ref.position, face)
        if (aim) return { at, ref, face, aim, item, ticks: deadline }
      }
    }
  }
  return null
}

export async function webSmash(bot, enemy: string, { ctl = null, shieldTicks = Infinity, pearlTicks = Infinity, deadlineTicks = Infinity }: any = {}) {
  const no = why => ({ attempted: false, placed: false, why })
  if (ctl?.aborted || typeof enemy !== 'string' || !enemy || !bot.entity || !bot._placeBlockWithOptions || !bot.setQuickBarSlot) return no('unavailable')
  const threats: typeof import('../threats') = require('../threats')
  const started = clock.now()
  const quote = () => plan(bot, threats.smashes(bot, [enemy]).find(t => t.name === enemy), { shieldTicks, pearlTicks, deadlineTicks: deadlineTicks - (clock.now() - started) / 50 })
  const q = quote()
  if (!q) return no('no_safe_web')
  const slot = bot.quickBarSlot
  try {
    bot.clearControlStates?.()
    bot.setQuickBarSlot(q.item.slot - 36)
    await bot.lookAt(q.aim, true)
    const fresh = quote()
    if (ctl?.aborted || !fresh || !fresh.at.equals(q.at) || !fresh.ref.position.equals(q.ref.position) || !fresh.face.equals(q.face) || !fresh.aim.equals(q.aim) || bot.heldItem?.name !== 'cobweb') return no('prediction_changed')
    // exact delta и forceLook:ignore не дают mineflayer прицелиться второй раз в другую точку.
    await withTimeout(bot._placeBlockWithOptions(q.ref, q.face, { forceLook: 'ignore', swingArm: 'right', delta: q.aim.minus(q.ref.position) }),
      Math.max(1, Math.min(200, (fresh.ticks - (Number.isFinite(shieldTicks) ? shieldTicks : 1) - 1) * 50 - (clock.now() - started))))
  } catch {} finally {
    if (!ctl?.aborted && Number.isInteger(slot) && bot.heldItem?.name === 'cobweb') bot.setQuickBarSlot(slot)
  }
  return { attempted: true, placed: !ctl?.aborted && bot.blockAt(q.at, false)?.name === 'cobweb', at: q.at,
    ticks: Math.max(0, q.ticks - (clock.now() - started) / 50) }
}
