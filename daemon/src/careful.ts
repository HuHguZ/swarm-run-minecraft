'use strict'
// Магма жжёт, только если не красться: MagmaBlock.stepOn (javap 1.21.11) — урон hot_floor лишь при !isSteppingCarefully(), а у
// игрока это isShiftKeyDown. Бот шёл к сундуку руин портала по их магме — тактика рвала навык «сойти с магмы», сундук не
// открывался (ферма 14.10, руины у спавна 4961758722860627209: «сундуков не нашёл», TACTICAL hot floor). На магме и в шаге от
// неё — присесть; сошёл — встать (только если присел сам). ND_MAGMA_SNEAK=0 — выкл.
// Пол вокруг на клетку во все стороны (и по диагонали) и на уступ ниже: шаг с разбега и спрыгивание на магму — первое касание
// без приседа уже урон (ферма 14.10: один удар hot_floor — и тактика рвёт навык).
import { owAirEmergency, owDeathWaterOn, inWater } from './movement/water'
const locks: typeof import('./reflex-lock') = require('./reflex-lock')
const AROUND = [-1, 0, 1].flatMap(dx => [-1, 0, 1].flatMap(dz => [[dx, 0.5, dz], [dx, -0.5, dz], [dx, -1.5, dz]]))

function install (session, bot) {
  if (bot._ndCareful || process.env.ND_MAGMA_SNEAK === '0' && process.env.ND_MAGMA_ESCAPE !== '1') return
  bot._ndCareful = true
  let mine = false
  // Поздняя граница тика (physicTick — после всех planning-колбэков, прямо перед пакетом движения, как прицел лука): pathfinder
  // сбрасывает управление в своём physicsTick, и присед, поставленный раньше него, до пакета не доживал (ферма 14.10: «присел» —
  // и всё равно hot_floor на первом шаге).
  const late = () => {
    try {
      if (session.bot !== bot || !bot.entity) return
      // Shift lowers the eyes and slows swimming; the air rescue owns that key.
      if (owAirEmergency(bot) || owDeathWaterOn(bot) && inWater(bot) && locks.owner(session)?.source === 'Surface') {
        if (mine) bot.setControlState('sneak', false)
        mine = false
        return
      }
      // Only Shift is a passive floor safety constraint; it must survive a foreign lease.
      if (locks.keepMagmaSneak(session)) { mine = true; return }
      const p = bot.entity.position
      const near = process.env.ND_MAGMA_SNEAK !== '0' && AROUND.some(([dx, dy, dz]) => bot.blockAt(p.offset(dx, dy, dz))?.name === 'magma_block')
      if (near && !bot.getControlState('sneak')) { bot.setControlState('sneak', true); if (!mine) console.log('[careful] присел у магмы', JSON.stringify({ at: p.floored() })); mine = true } else if (!near && mine) { bot.setControlState('sneak', false); mine = false }
    } catch {}
  }
  Object.defineProperty(late, '_ndLatePacketAim', { value: true })
  bot.on('physicTick', late)
}

export { install }
