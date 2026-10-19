'use strict'
// Человек в бою (showman.ts): общие помощники слоя — счёт жестов, перезарядки, кто цель и видна ли она, его досягаемость,
// клавиши тела (взять тело на тик и отдать) и взгляд на него.
import * as gameClock from '../game-clock'
import { EYE, clamp } from './consts'
import type { Showman } from './state'

function tally (H: Showman, label) { const { stats, used } = H; if (!label) return; stats.acts[label] = (stats.acts[label] || 0) + 1; used(label) }
function ready (H: Showman, k) { return gameClock.now() >= (H.cds[k] || 0) }
function rest (H: Showman, k, ms) { H.cds[k] = gameClock.now() + ms }

function tgt (H: Showman) { const { observe, target } = H; try { return observe(target()) } catch { return null } }
function seenTarget (H: Showman, e) { const t = tgt(H); return t && e?.id === t.id && t._ndVisible !== false ? t : null }
function theirReachNow (H: Showman) {
  const { bot } = H
  const e = tgt(H)
  if (!e || !e.position || !bot.entity) return 99
  const eye = e.position.offset(0, EYE, 0)
  const p = bot.entity.position
  const cx = clamp(eye.x, p.x - 0.3, p.x + 0.3)
  const cy = clamp(eye.y, p.y, p.y + 1.8)
  const cz = clamp(eye.z, p.z - 0.3, p.z + 0.3)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
function release (H: Showman) {
  const { set, aimTo } = H
  if (!H.driving) return
  H.driving = false
  for (const k of keys) set(k, false)
  aimTo('target')
}
function drive (H: Showman, ctl) {
  const { set } = H
  H.driving = true
  H.lease = gameClock.now() + 150
  for (const k of keys) set(k, !!ctl[k])
}

// Взгляд на него: yaw и pitch от глаз к его глазам.
function lookAtHim (H: Showman) {
  const { bot } = H
  const e = tgt(H)
  const me = bot.entity.position
  const dx = e.position.x - me.x
  const dz = e.position.z - me.z
  const dy = (e.position.y + EYE) - (me.y + EYE)
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
}

export { tally, ready, rest, tgt, seenTarget, theirReachNow, keys, release, drive, lookAtHim }
