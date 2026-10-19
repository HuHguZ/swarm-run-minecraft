'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep as movementSleep } from '../movement'

// Пауза, которую рвёт ctl (ревью Codex q2: под водой и на остановленных часах ожидания держали тело после abort).
function sleep (ms, ctl = null) {
  if (!ctl || !Array.isArray(ctl.onAbort)) return movementSleep(ms)
  if (ctl.aborted) return Promise.resolve()
  let stop
  return new Promise<void>(resolve => {
    const timer = gameClock.setTimeout(resolve, ms)
    stop = () => { gameClock.clearTimeout(timer); resolve() }
    ctl.onAbort.push(stop)
  }).finally(() => { const i = ctl.onAbort.indexOf(stop); if (i >= 0) ctl.onAbort.splice(i, 1) })
}

// ------------------------------------------------------------------ helpers

function dimOf (bot) { return (bot.game && bot.game.dimension ? String(bot.game.dimension) : 'overworld').replace(/^minecraft:/, '') }
function flat (a, b) { return Math.hypot(a.x - b.x, a.z - b.z) }
function v3 (p) { return new Vec3(p.x, p.y, p.z) }
function keyOf (p) { return `${p.x},${p.y},${p.z}` }
function groupNames (g) { return Array.isArray(g) ? g : g.names }
function groupMin (g) { return Array.isArray(g) ? 1 : (g.min || 1) }
function withTimeout (p, ms, what = 'время вышло') {
  let t
  return Promise.race([p, new Promise<any>((resolve, reject) => { t = gameClock.setTimeout(() => reject(new Error(what)), ms) })]).finally(() => gameClock.clearTimeout(t))
}

function count (bot, re) {
  let n = 0
  for (const it of bot.inventory.items()) if (typeof re === 'string' ? it.name === re : re.test(it.name)) n += it.count
  return n
}

const WET = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/

// Довести клетку шаблона до вида: подойти (по воде — вплавь) и копать то, что прицел видит на луче к ней, пока сама
// клетка не окажется в прицеле на досягаемости (pick.blockSeen — как клиент). Скрытое не читается: копается только
// первый блок на луче (виден), ловушки (TNT, нажимная плита, растяжка), лава и спавнер — не копаются.
const NO_DIG = /^(tnt|stone_pressure_plate|tripwire|tripwire_hook|lava|bedrock|spawner|trial_spawner|chest|trapped_chest|barrel)$/

export { sleep, dimOf, flat, v3, keyOf, groupNames, groupMin, withTimeout, count, WET, NO_DIG }
