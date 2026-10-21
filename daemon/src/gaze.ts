'use strict'
// Не смотреть эндермену в глаза между делом. Правило сервера (javap 1.21.11, см. dragon/dig-down-to starer): EnderMan злится,
// если взгляд игрока ближе acos(1 − 0.025/d) к его глазам (2.55 над ногами) при прямой видимости, до 64 бл., — и держится
// несколько тиков подряд. Игрок отводит глаза; бот на ходу и в простое смотрел перед собой и злил их (cl-al 14.10: ночью наверху,
// хп 20 → 4 → 0 от одного эндермена). Сторож опускает (или поднимает) голову ровно настолько, чтобы взгляд ушёл с его глаз.
// Не трогает прицел: копка, предмет в руке, окно, сторож падения, эндермен ближе 6 бл. (там уже бой) и навыки, где взгляд
// в глаза нужен или свой (жемчуг — злить нарочно, дракон, выстрелы).
const OWN_GAZE = /^(pearls|dragon|shoot|peek_shot)$/

function install (session, bot) {
  if (bot._ndGaze || process.env.ND_GAZE === '0') return
  bot._ndGaze = true
  const { starer, safePitch }: typeof import('./dragon/dig-down-to') = require('./dragon/dig-down-to')
  // Поздняя граница тика (physicTick, перед пакетом движения): pathfinder ставит взгляд на ходу в своём physicsTick.
  const late = () => {
    try {
      if (session.bot !== bot || !bot.entity || bot.targetDigBlock || bot.usingHeldItem || bot.currentWindow) return
      if (bot._ndHandLock && bot._ndHandLock.on && bot._ndHandLock.on()) return
      const cur = session.current && session.current.name
      // pearls mode=barter/seek — торг с пиглинами, взгляд эндермену в глаза там не нужен (nbk34-0528: смерть от эндермена в
      // искажённом лесу на поиске торговцев — сторож был выключен на всём навыке pearls).
      if (cur && OWN_GAZE.test(cur) && !(cur === 'pearls' && /^(barter|seek)$/.test(String(session.current.params?.mode || '')))) return
      const e = starer(bot, bot.entity.yaw, bot.entity.pitch)
      if (!e || e.position.distanceTo(bot.entity.position) < 6) return
      // force — в пакет этого же тика (позиция уходит после physicsTick); плавный поворот дотянул бы взгляд через тики.
      bot.look(bot.entity.yaw, safePitch(bot, bot.entity.yaw, bot.entity.pitch), true).catch(() => {})
    } catch {}
  }
  Object.defineProperty(late, '_ndLatePacketAim', { value: true })
  bot.on('physicTick', late)
}

export { install, OWN_GAZE }
