'use strict'
// Человек в бою (showman.ts): steer — в ближнем бою поверх решения pvp.js: наказать его промах, отход-сброс размена,
// финт на краю его досягаемости, поправка по фазе и живая пауза. Удар остаётся за pvp.js.
import * as gameClock from '../game-clock'
import { FIXP, HIT_REACH, THEIR_REACH, between } from './consts'
import { tally, ready, rest, tgt, release } from './body'
import { tickPhase } from './phase'
import type { Showman } from './state'

// ---------------------------------------------------------------- steer
function steer (H: Showman, k, c) {
  const { human, persona, stats, hits, tt } = H
  const now = gameClock.now()
  // Свои часы: pre зовут в том же проходе цикла раньше steer.
  const dt = Math.min(100, now - H.lastSteer)
  H.lastSteer = now
  tickPhase(H, c)
  if (H.driving) release(H)
  const out = { ...k }
  // Нажим (pvp.js): без отхода-сброса, финтов, пауз и пятящейся обороны.
  if (FIXP && c.press) { H.retreat = null; H.bait = null; H.pauseUntil = 0; return out }
  const ph = H.phase ? H.phase.name : 'напор'
  if (c.theirR < THEIR_REACH + 0.2) { H.lastExchange = now; H.engaged = true }
  // Наказать промах: его клиент 10 тиков не пропустит клик (missTime),
  // наш удар заряжен — шаг внутрь спринтом, удар сделает pvp.js.
  if (H.whiff && now - H.whiff.at < 450 && c.cooldownLeft <= 100) {
    if (!H.whiff.said) { H.whiff.said = true; H.bites++; tally(H, 'финт: он махнул мимо — наказываю') }
    out.forward = c.r > HIT_REACH - 0.15
    out.back = false
    out.sprint = out.forward
    stats.tacticMs += dt
    return out
  }
  if (H.whiff && now - H.whiff.at >= 450) H.whiff = null
  // Отход-сброс: два его удара подряд без нашего ответа — выйти из размена
  // (S-tap и шаг назад), дальше затишье и снова в бой.
  hits.took = hits.took.filter(t => now - t < 2500)
  hits.gave = hits.gave.filter(t => now - t < 2500)
  if (!H.retreat && hits.took.length >= 2 && hits.gave.length === 0 && ready(H, 'reset') && !(c.cooldownLeft === 0 && c.r <= HIT_REACH + 0.2)) {
    rest(H, 'reset', 7000)
    const p = ph === 'оборона' ? 0.85 : ph === 'хитрость' ? 0.6 : ph === 'напор' ? 0.2 : 0.45
    if (Math.random() < p) { H.retreat = { until: now + between(900, 1600) }; tally(H, 'отход: сбросить размен') }
  }
  if (H.retreat) {
    if (now > H.retreat.until || c.theirR > 6 || (c.cooldownLeft === 0 && c.r <= HIT_REACH)) H.retreat = null
    else if (!c.dodging) {
      out.forward = false; out.sprint = false; out.back = true
      if (!out.strafe) out.strafe = H.circleKey
      stats.tacticMs += dt
      return out
    }
  }
  // Финт на краю его досягаемости: заряжены, он в 3.1–4.6 — шаг на край,
  // пауза под его клик, шаг назад. Махнул мимо — наказание выше. Только
  // против человека: бот на mineflayer бьёт лишь в досягаемости и мимо не
  // машет, запирать нечего (арена 2026-09-26: 12 финтов против бота — 0
  // укусов, минус темп).
  if (human && !H.bait && !H.baitOff && c.cooldownLeft === 0 && c.theirR > 3.1 && c.theirR < 4.6 && !c.blocking && !c.vulnerable && !c.rush && !c.dodging && !c.flank && ready(H, 'bait')) {
    if (!H.baitRolled) {
      H.baitRolled = true
      const p = ph === 'хитрость' ? 0.55 : ph === 'оборона' ? 0.3 : ph === 'шоу' ? 0.2 : 0.08
      if (Math.random() < p * (0.5 + persona.cunning)) {
        H.bait = { stage: 'in', at: now, bit: false }
        H.baits++
        tally(H, 'финт: шаг на край его руки и назад')
      } else rest(H, 'bait', between(600, 1400))
    }
  }
  if (!H.bait && (c.cooldownLeft > 0 || c.theirR >= 4.6)) H.baitRolled = false
  if (H.bait) {
    const el = now - H.bait.at
    if (H.bait.bit || c.cooldownLeft > 0 || c.blocking || c.dodging || c.theirR > 5.5 || el > 1300) {
      H.bait = null
      rest(H, 'bait', between(1500, 3500))
      if (H.baits >= 3 && H.bites === 0 && !H.baitOff) { H.baitOff = true; tally(H, 'финт: не ведётся — бросил') }
    } else {
      if (H.bait.stage === 'in' && (c.theirR <= 3.2 || el > 380)) { H.bait.stage = 'hold'; H.bait.holdUntil = now + between(120, 260) }
      if (H.bait.stage === 'hold' && now >= H.bait.holdUntil) { H.bait.stage = 'out'; H.bait.outAt = now }
      if (H.bait.stage === 'out' && (c.theirR >= 3.75 || now - H.bait.outAt > 420)) { H.bait = null; rest(H, 'bait', between(1500, 3500)) }
      if (H.bait) {
        out.sprint = false
        out.forward = H.bait.stage === 'in'
        out.back = H.bait.stage === 'out'
        stats.tacticMs += dt
        return out
      }
    }
  }
  // Фаза.
  if (c.cooldownLeft > 150 && !c.vulnerable && !c.dodging) {
    if (ph === 'оборона' && c.theirR < 3.8 && c.cooldownLeft > 250 && !c.rush) { out.back = true; out.forward = false; out.sprint = false }
    if (ph === 'напор' && out.back && tt) {
      // Он тоже не заряжен (махнул позже нас) — не пятиться, давить.
      const s = tt.state(tgt(H))
      if (s.swung && s.swung.left > c.cooldownLeft + 50) out.back = false
    }
  }
  // Живая пауза: замереть на миг вне его руки, пока заряжаемся.
  // Пауза кончается раньше заряда: к готовности удара — снова в ходу.
  if (ph !== 'напор' && c.theirR > 3.9 && c.cooldownLeft > 450 && !c.dodging && now - H.pauseRolledAt > 1000) {
    H.pauseRolledAt = now
    if (Math.random() < 0.15 + persona.patience * 0.2) { H.pauseUntil = now + Math.min(between(150, 350), c.cooldownLeft - 150); stats.acts['пауза'] = (stats.acts['пауза'] || 0) + 1 }
  }
  if (now < H.pauseUntil && !c.dodging) { out.strafe = null; if (!out.back) out.forward = false }
  return out
}

export { steer }
