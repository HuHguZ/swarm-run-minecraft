'use strict'
// Человек в бою (showman.ts): его жесты — слушатели событий и тика физики (присед, взмах, удары, смерть, взгляд и
// прыжки) и чтение жеста в спокойном окне, на который ответить тем же.
import * as gameClock from '../game-clock'
import { THEIR_REACH, between } from './consts'
import { tally, tgt, seenTarget, theirReachNow, release } from './body'
import type { Showman } from './state'

// ------------------------------------------------------------ его жесты
// Всё на событиях и на тике физики: цикл pvp.js бывает занят луком или
// глотком по секунде, а кивок длится полсекунды.
// Слушатели — в H (onCrouch, onSwing, onHurt, onDead, onTick): close снимает их.
function watchHim (H: Showman) {
  const { bot, human, seen, hits } = H
  const onCrouch = (e) => { if (seenTarget(H, e)) seen.crouches.push(gameClock.now()) }
  // Взмах: вне его руки — промах (или дразнит), это и ловит финт.
  const onSwing = (e) => {
    if (!seenTarget(H, e)) return
    const now = gameClock.now()
    const tr = theirReachNow(H)
    seen.swings.push({ at: now, tr })
    if (tr > 3.08) {
      if (H.bait) H.bait.bit = true
      // Наказуемо, только если успеем дойти за его 10 тиков missTime: с 4.3
      // спринтом (0.28 бл/тик) — за 2-5 тиков.
      if (human && tr <= 4.3) H.whiff = { at: now, tr }
    }
  }
  const onHurt = (victim, source) => {
    const t = tgt(H)
    if (!t || !bot.entity || !victim) return
    const now = gameClock.now()
    if (victim === bot.entity && source && source.id === t.id) { hits.took.push(now); H.lastExchange = now }
    if (victim.id === t.id && source && source.id === bot.entity.id) { hits.gave.push(now); H.lastExchange = now }
  }
  const onDead = (e) => { const t = seenTarget(H, e); if (t?.position) H.deathSpot = t.position.clone() }
  const onTick = () => {
    // Cleanup also runs while sight is lost and the combat loop uses another skill.
    if (H.driving && gameClock.now() > H.lease) release(H)
    const e = tgt(H)
    if (!e || !e.position) return
    if (e._ndVisible === false) {
      seen.pitch.length = 0; seen.yaw.length = 0
      seen.ground = null; seen.peak = null; seen.lastY = null
      return
    }
    const now = gameClock.now()
    // Своя высота: прыгаем за критом — его голова ходит за нами вверх-вниз, и
    // это не кивок.
    if (bot.entity) { seen.myY.push({ t: now, y: bot.entity.position.y }); while (seen.myY.length > 40) seen.myY.shift() }
    seen.pitch.push({ t: now, v: e.pitch || 0, x: e.position.x, z: e.position.z })
    // Поворот головы без скачка через ±π: иначе переход 359°→0° читался бы
    // как «мотает головой».
    let yv = typeof e.headYaw === 'number' ? e.headYaw : (e.yaw || 0)
    const prevY = seen.yaw[seen.yaw.length - 1]
    if (prevY) { while (yv - prevY.v > Math.PI) yv -= 2 * Math.PI; while (yv - prevY.v < -Math.PI) yv += 2 * Math.PI }
    seen.yaw.push({ t: now, v: yv })
    while (seen.pitch.length > 40) seen.pitch.shift()
    while (seen.yaw.length > 40) seen.yaw.shift()
    // Прыжок на месте: подъём на 0.8+ над землёй и назад (как в gestures.js).
    const y = e.position.y
    if (seen.lastY !== null && Math.abs(y - seen.lastY) < 0.01) seen.ground = y
    seen.lastY = y
    if (seen.ground !== null && !seen.peak && y - seen.ground > 0.8) seen.peak = { at: now, x: e.position.x, z: e.position.z }
    else if (seen.peak && seen.ground !== null && y - seen.ground < 0.1) { seen.jumps.push(seen.peak); seen.peak = null }
    if (seen.peak && now - seen.peak.at > 1500) seen.peak = null
  }
  H.onCrouch = onCrouch; H.onSwing = onSwing; H.onHurt = onHurt; H.onDead = onDead; H.onTick = onTick
  bot.on('entityCrouch', onCrouch)
  bot.on('entitySwingArm', onSwing)
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('physicsTick', onTick)
}

// Колебания угла — сколько раз он сменил направление с размахом ≥ amp за ms.
function swingsOf (arr, ms, amp) {
  const now = gameClock.now()
  const xs = arr.filter(s => now - s.t <= ms)
  if (xs.length < 4) return 0
  let ext = xs[0].v; let dir = 0; let n = 0
  for (const s of xs) {
    const dv = s.v - ext
    if (dir >= 0 && dv <= -amp) { dir = -1; ext = s.v; n++ } else if (dir <= 0 && dv >= amp) { dir = 1; ext = s.v; n++ } else if ((dir > 0 && s.v > ext) || (dir < 0 && s.v < ext)) ext = s.v
  }
  return n
}
function readGestures (H: Showman, c) {
  const { human, style, t0, seen, mirrored } = H
  const now = gameClock.now()
  seen.crouches = seen.crouches.filter(t => now - t < 2500)
  seen.swings = seen.swings.filter(s => now - s.at < 2500)
  seen.jumps = seen.jumps.filter(j => now - j.at < 3500)
  // В рубке его прыжки — криты, а взмахи — удары, не жесты; и то, что
  // осталось в памяти от рубки, тоже не жест: считаем только то, что он
  // сделал в спокойном окне (разошлись больше чем на 1.5 с).
  if (c.d > 14 || H.mirror || c.theirR < THEIR_REACH + 1.1) return
  const calm = Math.max(H.lastExchange + 1500, t0)
  if (now - calm < 400) return
  const e = tgt(H)
  const pitch = seen.pitch.filter(s => s.t >= calm)
  const yaw = seen.yaw.filter(s => s.t >= calm)
  const still = pitch.length > 10 && Math.hypot(pitch[pitch.length - 1].x - pitch[pitch.length - 11].x, pitch[pitch.length - 1].z - pitch[pitch.length - 11].z) < 0.8
  const myYs = seen.myY.filter(s => now - s.t <= 1600).map(s => s.y)
  const meSteady = myYs.length > 4 && Math.max(...myYs) - Math.min(...myYs) < 0.4
  const jumps = seen.jumps.filter(j => j.at >= calm)
  let kind = null
  if (seen.crouches.filter(t => t >= calm).length >= 2) kind = 'присед'
  else if (meSteady && still && swingsOf(pitch, 1600, 0.4) >= 3) kind = 'кивок'
  else if (meSteady && still && swingsOf(yaw, 1400, 0.3) >= 3) kind = 'головой'
  else if (jumps.length >= 2 && e && Math.hypot(e.position.x - jumps[0].x, e.position.z - jumps[0].z) < 1.5) kind = 'прыжки'
  else if (seen.swings.filter(s => s.tr > 4.5 && s.at >= calm).length >= 2) kind = 'взмах'
  if (!kind || mirrored[kind]) return
  mirrored[kind] = true
  // Против человека отвечаем почти всегда, боту — через раз.
  if (Math.random() < (human ? 0.95 : 0.5)) H.mirror = { kind, at: now, after: now + (style.reactMs || 180) + between(150, 450) }
  tally(H, `вижу его жест: ${kind}`)
}

export { watchHim, swingsOf, readGestures }
