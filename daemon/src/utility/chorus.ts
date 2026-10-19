'use strict'
// Подручное (utility.ts): хорус — куда перенесёт (прогон 16 попыток сервера), хорус или жемчуг, съесть и проверить перенос.
import * as gameClock from '../game-clock'
import * as edges from '../edges'
import { sleep } from '../movement'
import { TICK_MS, findItem, countOf } from './common'
import { Vec3 } from './common'

// ================================================================ хорус

// Куда перенесёт хорус отсюда: те же 16 попыток, что у сервера (±8 по x, y, z,
// вниз до опоры хоть до дна мира, место без блоков и жидкости), n прогонов.
// Итог: доля «перенёсся», «сел ниже ног на 4+» (на небесной арене — вылет на
// землю под ней), средний сдвиг и сколько раз ушёл от ближайшего врага на 6+.
function chorusOdds (bot, foes: any = [], { n = 300 }: any = {}) {
  const me = bot.entity.position
  const minY = (bot.game && bot.game.minY) ?? -64
  const maxY = minY + ((bot.game && bot.game.height) || 384) - 1
  const cache = new Map()
  const bm = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (cache.has(k)) return cache.get(k)
    const b = bot.blockAt(new Vec3(x, y, z), false)
    const v = !b ? 'unknown' : b.boundingBox === 'block' ? 'solid' : /water|lava|bubble_column/.test(b.name) ? 'liquid' : 'free'
    cache.set(k, v)
    return v
  }
  const fits = (x, y, z) => {
    // Рамка игрока 0.6 × 1.8 без блоков и жидкости.
    for (const [ox, oz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
      for (const oy of [0, 0.9, 1.79]) {
        const c = bm(Math.floor(x + ox), Math.floor(y + oy), Math.floor(z + oz))
        if (c !== 'free') return false
      }
    }
    return true
  }
  const out = { n, tp: 0, low: 0, away6: 0, sumMove: 0, sumFoe: 0, lava: 0, walled: 0 }
  // Между нами и точкой прыжка — барьер (стена поля в Колизее, 2026-09-26):
  // хорус переносит сквозь неё, на трибуны, а это вылет с ринга.
  const barrierCache = new Map()
  const isBarrier = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (barrierCache.has(k)) return barrierCache.get(k)
    const b = bot.blockAt(new Vec3(x, y, z), false)
    const v = !!b && b.name === 'barrier'
    barrierCache.set(k, v)
    return v
  }
  const walledOff = (to) => {
    const dx = to.x - me.x; const dz = to.z - me.z
    const len = Math.hypot(dx, dz)
    for (let t = 0.5; t < len; t += 0.5) {
      const x = Math.floor(me.x + dx * t / len); const z = Math.floor(me.z + dz * t / len)
      for (const y of [Math.floor(me.y + 0.5), Math.floor(me.y + 1.5), Math.floor(to.y + 0.5)]) if (isBarrier(x, y, z)) return true
    }
    return false
  }
  for (let s = 0; s < n; s++) {
    let land = null
    for (let a = 0; a < 16 && !land; a++) {
      const x = me.x + (Math.random() - 0.5) * 16
      let y = Math.max(minY, Math.min(maxY, me.y + (Math.random() - 0.5) * 16))
      const z = me.z + (Math.random() - 0.5) * 16
      let by = Math.floor(y)
      let found = false
      while (by > minY) {
        const below = bm(Math.floor(x), by - 1, Math.floor(z))
        if (below === 'unknown') break
        if (below === 'solid') { found = true; break }
        y -= 1; by -= 1
      }
      if (found && fits(x, y, z)) land = new Vec3(x, y, z)
    }
    if (!land) continue
    out.tp++
    out.sumMove += Math.hypot(land.x - me.x, land.z - me.z)
    if (me.y - land.y > 4) out.low++
    const df = foes.length ? Math.min(...foes.map(f => Math.hypot(f.position.x - land.x, f.position.z - land.z))) : 99
    out.sumFoe += Math.min(df, 30)
    if (df >= 6) out.away6++
    try { if (edges.hazardAround(bot, land, 1, new Map())) out.lava++ } catch {}
    if (walledOff(land)) out.walled++
  }
  const p = k => Math.round(out[k] / n * 100)
  return {
    n,
    tp: p('tp'),
    low: p('low'),
    away6: p('away6'),
    hazard: p('lava'),
    walled: p('walled'),
    move: out.tp ? Math.round(out.sumMove / out.tp * 10) / 10 : 0,
    foeDist: out.tp ? Math.round(out.sumFoe / out.tp * 10) / 10 : 0
  }
}

// Чем уходить: хорус или жемчуг (или ничем). Жемчуг — 5 хп (ThrownEnderpearl.
// onHit, мимо брони), летит куда бросил, но из коробки и из-под потолка не
// вылетит; хорус — 0 хп и сквозь стены, но 1.6 с жевать и куда выпадет.
//  · заперт (паутина, которую не срезать, яма, коробка) — хорус;
//  · хп ≤ 6 — жемчуг сам почти убивает — хорус;
//  · жемчуга нет, лечиться нечем, хп на исходе — хорус;
//  · хорус ведёт за край (≥ 15% прогонов ниже ног на 4+) — нет.
// Жевать под ударами можно (урон еду не прерывает), если за 1.6 с он не снимет
// всё: ожидаемый урон — по его заряду и оружию (totem.burstOf).
function escapeChoice (bot, { hp, foes = [], trapped = null, pearls = 0, canHeal = false, pearlAt = 9, burst = 4 }: any = {}) {
  if (!findItem(bot, i => i.name === 'chorus_fruit')) return null
  if (gameClock.now() < (bot._ndChorusCd || 0)) return null
  // Жемчуг сам почти убивает: 5 хп, меньше с «Невесомостью» и «Защитой»
  // (tempo.pearlDamage — арена с чарами).
  let pd = 5
  try { pd = (require('../tempo') as typeof import('../tempo')).pearlDamage(bot) } catch {}
  const low = hp <= pd + 1
  const want = trapped || (low && hp <= pearlAt) || (!pearls && !canHeal && hp <= pearlAt)
  if (!want) return null
  const odds = chorusOdds(bot, foes, { n: 160 })
  if (odds.tp < 60 || odds.low >= 15 || odds.hazard >= 20) return { use: null, odds, why: 'хорус ведёт за край или некуда' }
  if (odds.walled >= 5) return { use: null, odds, why: 'хорус уведёт за стену поля' }
  const near = foes.filter(f => f.position.distanceTo(bot.entity.position) < 4).length
  const expect = near * burst * 1.6
  if (hp - expect < 1.5 && !trapped) return { use: null, odds, why: 'не дожую — забьют' }
  return { use: 'chorus', odds, why: trapped ? `заперт (${trapped})` : low ? `мало хп (${Math.round(hp)}) — жемчуг сам снял бы ${pd.toFixed(1)}` : 'уйти больше нечем' }
}

async function chorusEscape (bot, ctl) {
  const fruit = findItem(bot, i => i.name === 'chorus_fruit')
  if (!fruit) return { ok: false, why: 'хоруса нет' }
  try { await bot.equip(fruit, 'hand') } catch (err) { return { ok: false, why: err.message } }
  const had = countOf(bot, 'chorus_fruit')
  const from = bot.entity.position.clone()
  let tpAt = null
  const onMove = () => { if (!tpAt && bot.entity.position.distanceTo(from) > 1.5) tpAt = gameClock.now() }
  bot.on('forcedMove', onMove)
  bot.activateItem()
  const t0 = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() - t0 < 2400 && countOf(bot, 'chorus_fruit') >= had) await sleep(TICK_MS)
    await sleep(150)
  } finally {
    bot.removeListener('forcedMove', onMove)
  }
  if (countOf(bot, 'chorus_fruit') >= had) { try { bot.deactivateItem() } catch {} return { ok: false, why: 'не доел' } }
  bot._ndChorusCd = gameClock.now() + 1000
  const moved = bot.entity.position.distanceTo(from)
  return { ok: moved > 1.5, moved: Math.round(moved * 10) / 10, ms: gameClock.now() - t0 }
}

export { chorusOdds, escapeChoice, chorusEscape }
