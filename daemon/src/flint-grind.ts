'use strict'
// Кремень из гравия рюкзака на месте (S8, 07.10): поставить гравий на твёрдую клетку рядом с телом и сразу сломать его.
// Шанс кремня — 10 % за блок (loot_table/blocks/gravel.json 1.21.11, table_bonus без удачи); без удачи падает гравий,
// и его ставят снова. Кампания делала то же парой RPC place + mine (поиск блока, путь, подбор) — ~10 игр. с на попытку
// (s8-r2-11: 18 попыток за 200 с; s8-f1-2: шаг кремня 198 с); здесь — постановка и копка по видимой грани без ходьбы.
// Честно: ставится по видимой грани (placeBlockAt honest), копается по видимой грани (cast.digVisible).
const gameClock = require('./game-clock')
const { placeBlockAt } = require('./build')
const { equipBestTool } = require('./items')

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air')
const FLUID = /water|lava|bubble_column/

// Клетка у ног: воздух, сверху воздух, снизу — полный твёрдый блок (гравий не упадёт), рядом нет жидкости.
function grindSpot (bot) {
  const feet = bot.entity.position.floored()
  for (const [dx, dz] of SIDES) {
    const c = feet.offset(dx, 0, dz)
    const b = bot.blockAt(c)
    const under = bot.blockAt(c.offset(0, -1, 0))
    const over = bot.blockAt(c.offset(0, 1, 0))
    if (!isAir(b) || !isAir(over) || !under || under.boundingBox !== 'block' || FLUID.test(under.name) || /gravel|sand/.test(under.name)) continue
    if (SIDES.some(([ex, ez]) => FLUID.test((bot.blockAt(c.offset(ex, 0, ez)) || {}).name || ''))) continue
    return c
  }
  return null
}

async function flintGrind (session, ctl, { max = 40, timeoutSeconds = 90 }: any = {}) {
  const bot = session.bot
  const deadline = gameClock.now() + Math.max(5, Math.min(300, timeoutSeconds)) * 1000
  const count = name => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
  const flint0 = count('flint')
  const spot = grindSpot(bot)
  if (!spot) return { ok: false, tries: 0, flint: flint0, stopped: 'некуда поставить гравий рядом (нужен твёрдый пол и воздух у ног)' }
  const digVisible = require('./cast')._in.digVisible
  let tries = 0
  let why = null
  while (tries < max && count('flint') === flint0 && count('gravel') > 0 && gameClock.now() < deadline && !ctl.aborted) {
    tries++
    const before = count('gravel')
    const r = await placeBlockAt(bot, spot, { item: 'gravel', honest: true })
    const g = bot.blockAt(spot)
    if (!g || g.name !== 'gravel') { why = `гравий не встал: ${r.reason || (g ? g.name : '?')}`; break }
    try { await equipBestTool(bot, g); await digVisible(bot, g, 4000) } catch (e) { why = `не копается: ${e.message}`; break }
    // Подбор: дроп падает в соседнюю клетку — подтянется за несколько тиков.
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && count('flint') === flint0 && count('gravel') < before && !ctl.aborted) await gameClock.sleep(50)
  }
  const flint = count('flint')
  return { ok: flint > flint0, tries, flint, gravel: count('gravel'), ...(flint > flint0 ? {} : { stopped: why || (count('gravel') ? 'кремень не выпал' : 'гравий кончился') }) }
}

module.exports = { flintGrind, grindSpot }
