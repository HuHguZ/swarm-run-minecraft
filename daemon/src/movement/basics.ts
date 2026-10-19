'use strict'
// Ходьба: сон, координаты клетки, шахта спуска, высота стояния, сторож застревания, встряска, центр клетки.
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as geometry from '../navigation/geometry'

export const sleep = (ms) => gameClock.sleep(ms)
export const waterBudgetOn = () => process.env.ND_WATER_ESCAPE_BUDGET !== '0'
// Floor, not round. An entity standing at x=121.5 is in block 121, but rounding
// reports 122 — and the brain then hands 122 to /setblock or to its own
// coordinate arithmetic and acts on the block next door. This is what the game
// itself shows on the F3 "Block" line, and block positions are integers already,
// so nothing else changes.
export const xyz = v => (v ? { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) } : null)

// A route shaft is usable only after an actual descent in one block column.
export function shaftFromDescent (from, to) {
  if (![from, to].every(p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k])))) return null
  const a = xyz(from); const b = xyz(to)
  if (a.x !== b.x || a.z !== b.z || a.y <= b.y) return null
  return { x: a.x, z: a.z, top: a.y, bottom: b.y }
}

// Coordinates handed to us usually come from observe(), which reports the
// position of a block, not of a place you can stand. Asking pathfinder to
// reach the inside of a stone block means no valid node exists, and with
// canDig enabled A* will happily explore twenty thousand nodes before giving
// up. So snap to the nearest standable column first.
export function standableY (bot, x, y, z) {
  return geometry.standPositions(bot, new Vec3(x, y, z), { rise: 8, drop: 8 })[0]?.y ?? null
}

// What the bot is physically sitting in when it refuses to move. A valid path
// the bot cannot walk almost always means the body is caught on something.
export function describeStall (bot) {
  const name = b => (b ? b.name : 'void')
  const p = bot.entity.position
  return {
    pos: xyz(p),
    ground: name(bot.blockAt(p.offset(0, -1, 0))),
    legs: name(bot.blockAt(p)),
    head: name(bot.blockAt(p.offset(0, 1, 0))),
    ahead: (() => { try { const b = bot.blockAtCursor(4); return b ? b.name : 'air' } catch { return '?' } })(),
    inWater: !!bot.entity.isInWater,
    onGround: !!bot.entity.onGround
  }
}

// Pathfinder reports "partial" forever when the goal is unreachable; the bot
// just stands there. Fail loudly instead of burning the whole timeout.
export function stuckGuard (bot, ctl, stagnantLimitMs = 8000) {
  let last = bot.entity.position.clone()
  let stagnant = 0
  let timer = null
  const promise = new Promise<any>((_resolve, reject) => {
    timer = gameClock.setInterval(() => {
      const now = bot.entity.position
      if (now.distanceTo(last) > 0.6) {
        last = now.clone()
        stagnant = 0
      } else {
        stagnant += 1500
      }
      if (stagnant >= stagnantLimitMs) {
        gameClock.clearInterval(timer)
        const diag = describeStall(bot)
        console.log('[stuck]', JSON.stringify(diag))
        try { bot.pathfinder.setGoal(null) } catch {}
        reject(new Error(`застрял на ${diag.legs} у ${diag.ahead}: за ${stagnantLimitMs / 1000}с не сдвинулся`))
      }
    }, 1500)
  })
  ctl.onAbort.push(() => gameClock.clearInterval(timer))
  return { promise, stop: () => gameClock.clearInterval(timer) }
}

// mineflayer-pathfinder is a 2023-era library driving a 2026 game; it
// regularly plans a route the body then fails to walk. Rather than chase every
// individual mismatch, shake the bot loose and let it re-plan from a slightly
// different spot — which is what a person does when they snag on a corner.
function groundBehind (bot) {
  try {
    const yaw = bot.entity.yaw
    // mineflayer: взгляд вперёд — (-sin yaw, -cos yaw); назад — наоборот.
    const bx = Math.sin(yaw)
    const bz = Math.cos(yaw)
    const p = bot.entity.position
    for (const d of [1, 2]) {
      const c = p.offset(bx * d, 0, bz * d).floored()
      let ok = false
      for (let dy = 0; dy <= 3; dy++) {
        const b = bot.blockAt(c.offset(0, -dy - 1, 0))
        if (!b) break
        if (/lava/.test(b.name)) return false
        if (b.boundingBox === 'block') { ok = true; break }
      }
      if (!ok) return false
    }
    return true
  } catch { return false }
}

export async function unstick (bot) {
  try { bot.pathfinder.setGoal(null) } catch {}
  try {
    bot.clearControlStates()
    await sleep(150)
    bot.setControlState('jump', true)
    // Назад — только если за спиной есть пол в трёх блоках вниз: рывок назад
    // с прыжком у края обрыва — это падение, а не освобождение.
    if (groundBehind(bot)) bot.setControlState('back', true)
    await sleep(600)
    bot.setControlState('back', false)
    bot.setControlState('jump', false)
    await bot.look(bot.entity.yaw + Math.PI / 2, 0, true)
    await sleep(250)
  } catch {
  } finally {
    try { bot.clearControlStates() } catch {}
  }
}

// Jumping against a shaft wall can repeatedly be rejected by the server.
// Walk to the middle of the same supported cell before jumping; no position
// packets or local onGround overrides, just ordinary movement controls.
export async function centerOnFloor (bot, ctl, timeoutMs = 1000, { water = false } = {}) {
  const support = geometry.supportAt(bot, bot.entity.position, .04)
  if (!support) return false
  const target = new Vec3((support.box.minX + support.box.maxX) / 2, support.top, (support.box.minZ + support.box.maxZ) / 2)
  if (!geometry.bodyClear(bot, target, { water })) return false
  const away = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z)
  if (away() <= 0.08) return true
  const end = gameClock.now() + timeoutMs
  try {
    bot.clearControlStates()
    while (!(ctl && ctl.aborted) && gameClock.now() < end && away() > 0.08) {
      await bot.lookAt(target.offset(0, 1.62, 0), true)
      if (ctl?.aborted) break
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false) }
  await sleep(100)
  return away() <= 0.12
}
