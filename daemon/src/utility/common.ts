'use strict'
// Подручное (utility.ts): общие числа и помощники — предметы, хп по метаданным, блоки, тик физики и действие после пакета.
import * as gameClock from '../game-clock'
import * as read from '../read'
import { afterPacket } from '../mace'
import vec3 from 'vec3'
// Фабрика vec3 (parseFloat, null → 0,0,0), как прежний require('vec3'); тип — класс Vec3.
const Vec3 = vec3 as unknown as typeof import('vec3').Vec3

const EYE = 1.62
const USE_RANGE = 4.4
const TICK_MS = 50

function findItem (bot, test) { return bot.inventory.items().find(test) || null }
function countOf (bot, name) { return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0) }
function isPlayer (e) { return !!e && (e.type === 'player' || !!e.username) }
function hpOf (bot, e) { const h = read.healthRaw(bot, e); return h == null ? null : h + read.absorptionOf(bot, e) }
function solidAt (bot, p) { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
function nameAt (bot, p) { const b = bot.blockAt(p); return b ? b.name : null }
function airAt (bot, p) { const b = bot.blockAt(p); return !!b && (b.name === 'air' || b.name === 'cave_air') }

// Тик, на котором физика посчитана, — и действие после пакета позиции этого тика.
function onTickThen (bot, compute, act, timeoutMs = 400) {
  return new Promise<any>(resolve => {
    let done = false
    const onT = () => {
      if (done) return
      done = true
      gameClock.clearTimeout(t)
      bot.removeListener('physicsTick', onT)
      let sol = null
      try { sol = compute() } catch {}
      if (!sol) return resolve(null)
      if (sol.yaw != null) bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      afterPacket(bot, () => { try { act(sol) } catch {} resolve(sol) })
    }
    const t = gameClock.setTimeout(() => { if (!done) { done = true; bot.removeListener('physicsTick', onT); resolve(null) } }, timeoutMs)
    bot.on('physicsTick', onT)
  })
}

export { Vec3, EYE, USE_RANGE, TICK_MS, findItem, countOf, isPlayer, hpOf, solidAt, nameAt, airAt, onTickThen }
