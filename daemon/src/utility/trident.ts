'use strict'
// Подручное (utility.ts): трезубец — какой бросить, бросок по физике стрелы, дождь над точкой, «Тягун» рывком.
import * as gameClock from '../game-clock'
import * as read from '../read'
import * as bowMod from '../bow'
// Дождь и гроза — общий помощник по уровням (perception.raining/thundering,
// 2026-09-26): флаг bot.isRaining на Paper вывернут.
import { raining, thundering } from '../perception'
import { sleep } from '../movement'
import { EYE, TICK_MS, hpOf, onTickThen } from './common'
import { Vec3 } from './common'

// ================================================================ трезубец

const TRIDENT_SPEED = 2.5
const TRIDENT_G = 0.05
function tridents (bot) {
  return bot.inventory.items().filter(i => i.name === 'trident').map(i => ({
    item: i,
    loyalty: read.enchLevel(bot, i, 'loyalty'),
    riptide: read.enchLevel(bot, i, 'riptide'),
    channeling: read.enchLevel(bot, i, 'channeling')
  }))
}
// Под дождём ли точка: идёт дождь и над ней открытое небо (Entity.isInRain →
// Level.isRainingAt: canSeeSky). Идёт ли дождь — perception.raining: уровень
// дождя > 0.2, как Level.isRaining (флаг mineflayer на Paper вывернут: после
// дождя он встаёт в true — прежнее «флаг или уровень» видело бы дождь в сушь).
function rainAt (bot, pos) {
  if (!raining(bot)) return false
  const f = pos.floored()
  const observed = bot.blockAt(f)?.biome
  // prismarine-block's version-only Biome wrapper can omit modern climate
  // fields; use the same observed ID in this connection's negotiated registry.
  const biome = observed && (bot.registry?.biomes?.[observed.id] ?? observed)
  if (!biome || biome.has_precipitation !== true || biome.temperature < .15) return false
  const maxY = (bot.game?.minY ?? -64) + (bot.game?.height ?? 384)
  for (let y = f.y + 1; y < maxY; y++) {
    const b = bot.blockAt(new Vec3(f.x, y, f.z))
    if (!b) return false
    if (b.boundingBox === 'block' || /water|lava|leaves|glass|barrier/.test(b.name)) return false
  }
  return true
}
function wetOrRain (bot, state = null) {
  const pos = state?.pos ?? bot.entity?.position
  return !!(pos && ((state?.isInWater ?? bot.entity.isInWater) || rainAt(bot, pos) || rainAt(bot, pos.offset(0, bot.physics?.playerHeight ?? 1.8, 0))))
}

// Какой трезубец бросить: «Громовержец» в грозу по цели под небом; иначе с
// «Верностью» (вернётся сам); без чар — только добить (поднимать некогда).
// Трезубец с «Тягуном» не бросается вовсе (TridentItem.releaseUsing).
function tridentPlan (bot, e, { d, sees, finishing = false }: any = {}) {
  if (!sees || d < 5 || d > 24) return null
  const ts = tridents(bot).filter(t => !t.riptide)
  if (!ts.length) return null
  // Молния «Громовержца» — только в грозу (ThrownTrident: level.isThundering()
  // — уровень грозы > 0.9, Level.isThundering).
  const storm = thundering(bot)
  if (storm && rainAt(bot, e.position)) {
    const ch = ts.find(t => t.channeling)
    if (ch) return { t: ch, why: 'трезубец: молния в грозу' }
  }
  const loyal = ts.filter(t => t.loyalty).sort((a, b) => b.loyalty - a.loyalty)[0]
  if (loyal) return { t: loyal, why: `трезубец с «Верностью ${loyal.loyalty}»` }
  if (finishing) return { t: ts[0], why: 'трезубец: добить' }
  return null
}

// Бросок: натяжение 13 тиков (порог 10, запас на пакеты), прицел по физике
// стрелы (bow.aimMoving со скоростью 2.5) со своим смещением этого тика,
// спуск — после пакета позиции.
async function throwTrident (bot, e, t, { velFn = null, onDraw = null }: any = {}) {
  try { await bot.equip(t.item, 'hand') } catch (err) { return { ok: false, why: err.message } }
  if (!bot.heldItem || bot.heldItem.name !== 'trident') return { ok: false, why: 'не взял трезубец' }
  const target = bowMod.leadTarget(e, velFn)
  const eye = () => bot.entity.position.offset(0, EYE - 0.1, 0)
  const pre = bowMod.aim(eye(), target, TRIDENT_SPEED, TRIDENT_G)
  if (!pre) return { ok: false, why: 'не долетит' }
  if (bowMod.blockedAt(bot, eye(), pre, undefined, TRIDENT_SPEED)) return { ok: false, why: 'блок на линии' }
  let lastPos = bot.entity.position.clone()
  let moved = { x: 0, y: 0, z: 0 }
  const onTick = () => { const p = bot.entity.position; moved = { x: p.x - lastPos.x, y: p.y - lastPos.y, z: p.z - lastPos.z }; lastPos = p.clone() }
  bot.on('physicsTick', onTick)
  const hp0 = hpOf(bot, e)
  bot.activateItem()
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 650) {
      const s = bowMod.aimMoving(eye(), target, moved, !bot.entity.onGround, TRIDENT_SPEED, TRIDENT_G)
      if (s) bot.look(s.yaw, s.pitch, true).catch(() => {})
      if (onDraw) onDraw()
      await sleep(TICK_MS)
    }
    const fin: any = await onTickThen(bot, () => {
      const s = bowMod.aimMoving(eye(), target, moved, !bot.entity.onGround, TRIDENT_SPEED, TRIDENT_G)
      if (!s || bowMod.blockedAt(bot, eye(), s, moved, TRIDENT_SPEED)) return null
      return s
    }, () => bot.deactivateItem())
    if (!fin) { try { bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9) } catch { bot.deactivateItem() } return { ok: false, why: 'линия закрылась' } }
    return { ok: true, hp0, ticks: fin.ticks }
  } finally {
    bot.removeListener('physicsTick', onTick)
  }
}

// «Тягун»: рывок по взгляду (yaw, pitch). Сервер толкает только у себя
// (Entity.push без hurtMarked) — скорость и подъём прибавляем сами, как клиент.
// Без трезубца с «Тягуном» или воды — отказ { ok: false, why } без ticks; иначе итог runRiptide.
async function riptide (bot, yaw, pitch = 0, options: any = {}): Promise<Partial<import('../navigation/riptide').RiptideResult> & { ok: boolean }> {
  const t = tridents(bot).filter(x => x.riptide).sort((a, b) => b.riptide - a.riptide)[0]
  if (!t) return { ok: false, why: 'нет трезубца с «Тягуном»' }
  if (!wetOrRain(bot)) return { ok: false, why: 'не в воде и не под дождём' }
  return (require('../navigation/riptide') as typeof import('../navigation/riptide')).runRiptide(bot, options.ctl ?? { aborted: false }, t.item, t.riptide, yaw, pitch,
    state => wetOrRain(bot, state), release => onTickThen(bot, () => ({ yaw, pitch }), release), options.target, options.launch)
}
async function riptideTo(bot, ctl, target) {
  const trident = tridents(bot).filter(t => t.riptide).sort((a, b) => b.riptide - a.riptide)[0]
  if (!trident || !wetOrRain(bot) || ctl.aborted || bot._ndClutch?.waterPlan) return { ok: false, why: 'no_available_navigation_riptide', ticks: 0 }
  const chosen = await (require('../navigation/riptide') as typeof import('../navigation/riptide')).planRiptideTo(bot, ctl, trident.riptide, target, state => wetOrRain(bot, state))
  if (!chosen) return { ok: false, why: 'no_safe_navigation_riptide', ticks: 0 }
  return riptide(bot, chosen.yaw, chosen.pitch, { ctl, target })
}

export { tridents, rainAt, wetOrRain, tridentPlan, throwTrident, riptide, riptideTo }
