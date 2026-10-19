'use strict'
// Человек в бою (showman.ts): засада за колонной от лучника или бегущего на нас (выключена без ND_HIDE=1) и её тик.
import * as gameClock from '../game-clock'
import { THEIR_REACH, between } from './consts'
import { tally, ready, rest, tgt, release, drive } from './body'
import type { Showman } from './state'

// ---------------------------------------------------------------- засада
async function hideStart (H: Showman, c) {
  const { bot, persona, t0, stopPath, cover, fillerCount } = H
  // Засада со стройкой выключена (2026-09-26, пользователь: «бессмысленно
  // строят колонну, чуть постоят и идут обратно»): колонна ставилась и
  // через 1–2 с бросалась («достали — выхожу»), оставляя мусор. ND_HIDE=1 —
  // вернуть.
  if (process.env.ND_HIDE !== '1') return false
  if (!cover || !fillerCount || fillerCount() < 4) return false
  if (!ready(H, 'hide') || !bot.entity.onGround || gameClock.now() - t0 < 1500) return false
  const cunningNow = H.phase && (H.phase.name === 'хитрость' || H.phase.name === 'оборона') ? persona.cunning : persona.cunning * 0.25
  // От лучника — всегда повод (стрела в колонну). От бегущего — только
  // издалека и в хитрости: смена предмета на блок сбрасывает заряд меча
  // (Player.tick → resetAttackStrengthTicker при смене предмета), и он
  // должен успеть вернуться (675 мс), пока тот обходит колонну.
  // 2026-09-26: засада не случилась ни разу — лучник тянет лук обычно с 8–20
  // бл., а она ждала его ближе 8.5 и бросала кубик «хитрость × 0.9», вне фазы
  // хитрости — ещё ×0.25 (≈ 0.1 на случай). От стрелы колонна разумна при
  // любом нраве и с любого расстояния, где стрела долетит, — до 16 бл. и шанс
  // 0.3 + 0.6·хитрость; от бегущего — как было (смена предмета стоит заряда).
  const bowWhy = c.theyBow && c.d >= 4.5 && c.d <= 16
  const why = bowWhy ? 'он тянет лук'
    : c.closingNow > 0.1 && c.d >= 6.5 && c.d <= 8.5 && H.phase && H.phase.name === 'хитрость' ? 'он идёт на меня' : null
  if (!why || c.theirR < 4.2 || c.hp < 6) return false
  rest(H, 'hide', 4000)
  const chance = bowWhy ? 0.3 + 0.6 * persona.cunning : cunningNow * 0.5
  if (Math.random() > chance) return false
  rest(H, 'hide', between(20000, 32000))
  release(H)
  stopPath()
  const e = tgt(H)
  const placed = await cover(e.position.clone())
  if (!placed) return false
  H.hide = { since: gameClock.now(), until: gameClock.now() + between(2500, 4200), hpAt: c.hp }
  tally(H, `засада: спрятался за колонной (${why})`)
  return true
}
function hideTick (H: Showman, c) {
  const { stats, aimTo, tt } = H
  const now = gameClock.now()
  const e = tgt(H)
  const end = (label) => { H.hide = null; release(H); if (label) tally(H, label) }
  if (!e || !e.isValid) { end(null); return false }
  if (c.seesBody && c.theirR < THEIR_REACH + 1.2) { end('засада: он вышел — бью первым'); return false }
  if (c.seesBody && c.theyBow) { end('засада: обошёл с луком — выхожу'); return false }
  if (gameClock.now() - (tt ? tt.myHurtAt : 0) < 400 || c.hp < H.hide.hpAt - 1) { end('засада: достали — выхожу'); return false }
  if (now > H.hide.until || c.d > 18) { end('засада: выглянул из-за колонны'); return false }
  stats.tacticMs += Math.min(100, now - H.lastTick)
  drive(H, { sneak: true })
  aimTo('target')
  return true
}

export { hideStart, hideTick }
