'use strict'
// Лук (bow.ts): спуск выстрела — слушатели своей стрелы и попадания и сам спуск тетивы (armRelease), финальный
// прицел на позднем physicTick и спуск после пакета движения (lateRelease). Оба синхронны: слушатели ставятся
// в тот же миг, что и раньше в shoot (догоняющая пачка тиков после вызова не теряется).
import { AsyncResource } from 'node:async_hooks'
import * as gameClock from '../game-clock'
import { afterPacket as afterMovePacket } from '../edges'
import { blockedAt } from './ballistics'
import { hasObservedVelocity } from './track'
import type { ShotState } from './shot-state'

// Слушатели своей стрелы и попадания и спуск release(s, shut, checkedAt, position). Пишет S.arrow, S.me,
// S.spawnPkt, S.hit, S.releasedAt; при спуске — S.sol и S.sent.
function armRelease (S: ShotState) {
  const { bot, entity, charge, cancelDraw, shouldStop, onRelease, onHit, follow, point, traceAim, short } = S
  // Финальный прицел — на позднем physicTick после planning, перед updatePosition.
  // Сервер берёт взгляд и known movement из пакета движения (1.21.11).
  // Тетива отпускается на ndMovementSent, после movement/tick_end этого кадра.
  // Ловим свою стрелу: появится у глаз в ближайшие тики.
  S.arrow = null
  S.me = bot.entity.position.clone()
  const onSpawn = (e) => {
    if (!S.arrow && e && /arrow$/.test(e.name) && e.position && e.position.distanceTo(S.me) < 3) S.arrow = e
  }
  // Настоящая начальная скорость стрелы — из пакета появления: позиции летящей
  // стрелы mineflayer почти не обновляет, по ним ничего не измерить.
  // Только для разбора (follow): в бою без него каждый выстрел оставлял
  // слушателя висеть — MaxListenersExceededWarning после десятка стрел.
  S.spawnPkt = null
  const onRaw = (pkt, meta, bytes) => {
    if (S.spawnPkt || !pkt || meta?.name !== 'spawn_entity' || pkt.type !== bot.registry?.entitiesByName?.arrow?.id) return
    const px = pkt.x; const pz = pkt.z
    if (typeof px !== 'number' || Math.hypot(px - S.me.x, pz - S.me.z) > 3) return
    S.spawnPkt = { ...pkt, velocity: (require('../drops') as typeof import('../drops')).velocityFromRaw(bytes, 'spawn') }
  }
  S.hit = false
  // Урон цели в ближайшие ~2 с после спуска — наша стрела (ближний бой в это
  // время не идёт: стреляем с дистанции).
  const onHurt = (victim) => {
    if (victim?.id !== entity.id || S.hit) return
    S.hit = true
    if (onHit) { try { onHit() } catch {} }
  }
  S.releasedAt = null
  const release = (s, shut, checkedAt, position) => {
    // Send inside the packet-boundary callback. Awaiting its Promise first
    // lets a synchronous catch-up burst change the server's last movement.
    if (s && !shut) shut = blockedAt(bot, S.eye(), s, S.mode === 'compensate' ? S.myVel() : undefined, S.speed)
    if (!s || shut) { S.stopTick(); cancelDraw(); return { s, shut, checkedAt } }
    if (shouldStop?.()) { S.stopTick(); cancelDraw(); return { s, stopped: true } }
    const ranged: typeof import('../ranged') = require('../ranged')
    if (!ranged.offensiveArrow(ranged.firstArrow(bot), !!entity?.username || entity?.type === 'player')) { S.stopTick(); cancelDraw(); return { s, stopped: true } }
    if (!charge.ready(short ? 0 : 20)) { S.stopTick(); cancelDraw(); return { s, chargeError: charge.why() || 'bow_charge_not_confirmed' } }
    if (!point && !hasObservedVelocity(entity)) { S.stopTick(); cancelDraw(); return { s, unobserved: true } }
    // release_use_item поворота не несёт: стрела летит по последнему отправленному look, а он — из тела. Голова не там,
    // где решение (сторож взгляда эндермена опустил её, поворот под замком не успел) — не стрелять мимо (s5c 06.10).
    if (bot.entity && (Math.abs(bot.entity.pitch - s.pitch) > 0.05 || Math.abs(Math.atan2(Math.sin(bot.entity.yaw - s.yaw), Math.cos(bot.entity.yaw - s.yaw))) > 0.05)) {
      S.stopTick(); cancelDraw(); return { s, stopped: true }
    }
    S.sol = s; S.me = position
    bot.on('entitySpawn', onSpawn); bot.on('entityHurt', onHurt)
    if (follow) { try { bot._client.on('packet', onRaw) } catch {} }
    S.releasedAt = traceAim ? gameClock.serverNow() : null
    if (onRelease) { try { onRelease(S.moved) } catch {} }
    S.stopTick()
    bot.deactivateItem()
    S.sent = true
    charge.close()
    return { s, checkedAt, released: true }
  }
  return { onSpawn, onRaw, onHurt, release }
}

// Финальный прицел и спуск на ближайшем позднем physicTick (не дольше 300 мс). Обещание: итог release, отказ
// ({ stopped } / { chargeError } / { unobserved }) или null — тик не пришёл, спускать без него.
function lateRelease (S: ShotState, release) {
  const { bot, entity, charge, cancelDraw, shouldStop, onDraw, mode, point, traceAim, speed, eye, t0, solve, myVel } = S
  return new Promise<any>(resolve => {
    let done = false
    charge.cancelled.then(why => {
      if (!why || done) return
      done = true; bot.removeListener('physicTick', onT); gameClock.clearTimeout(timer)
      S.stopTick(); cancelDraw(); resolve({ chargeError: why })
    })
    const onT = AsyncResource.bind(() => {
      if (done) return
      if (shouldStop?.()) {
        done = true; bot.removeListener('physicTick', onT); gameClock.clearTimeout(timer)
        S.stopTick(); cancelDraw(); resolve({ stopped: true }); return
      }
      if (!point && !hasObservedVelocity(entity)) {
        if (onDraw) onDraw(gameClock.now() - t0)
        return
      }
      done = true
      bot.removeListener('physicTick', onT)
      gameClock.clearTimeout(timer)
      const position = bot.entity.position.clone()
      let s = solve()
      let shut = s ? blockedAt(bot, eye(), s, mode === 'compensate' ? myVel() : undefined, speed) : null
      // Refresh once after solve/LOS work, then verify the new path too.
      if (s && !shut) {
        s = solve()
        shut = s ? blockedAt(bot, eye(), s, mode === 'compensate' ? myVel() : undefined, speed) : null
      }
      if (s && !shut) bot.look(s.yaw, s.pitch, true).catch(() => {})
      const checkedAt = traceAim ? gameClock.serverNow() : null
      afterMovePacket(bot, () => resolve(release(s, shut, checkedAt, position)))
    })
    // Installed physics emits this existing late boundary after all planning
    // callbacks, immediately before updatePosition. Keep the movement observer
    // on physicsTick; release still follows the actual movement/tick_end packet.
    Object.defineProperty(onT, '_ndLatePacketAim', { value: true })
    bot.on('physicTick', onT)
    const timer = gameClock.setTimeout(() => {
      if (done) return
      done = true; bot.removeListener('physicTick', onT)
      if (!point && !hasObservedVelocity(entity)) {
        S.stopTick(); cancelDraw(); resolve({ unobserved: true })
      } else resolve(null)
    }, 300)
  })
}

export { armRelease, lateRelease }
