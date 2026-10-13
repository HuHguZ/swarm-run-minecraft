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
// Клетки у ног: 4 стороны, затем 4 диагонали (после копки гравия тело часто стоит в яме из гравия — сторон мало).
const AROUND = [...SIDES, [1, 1], [1, -1], [-1, 1], [-1, -1]]
const isAir = b => !!b && (b.name === 'air' || b.name === 'cave_air')
const FLUID = /water|lava|bubble_column/
const FALLING = /^(gravel|sand|red_sand)$/

// Клетка у ног или на блок выше: воздух, сверху воздух, снизу — полный твёрдый блок (сыпучий — только на твёрдом: гравий не упадёт), рядом нет
// жидкости (s8-f4-9: «некуда поставить» ×3 в яме из гравия — дальше place+mine по 4 с, 79 раз).
// На мелком берегу опора может занять воду над твёрдым дном; обе установки всё равно требуют видимой грани.
function grindSpot (bot) {
  const feet = bot.entity.position.floored()
  for (const dy of [0, 1]) for (const [dx, dz] of AROUND) {
    const c = feet.offset(dx, dy, dz)
    const b = bot.blockAt(c)
    const under = bot.blockAt(c.offset(0, -1, 0))
    const over = bot.blockAt(c.offset(0, 1, 0))
    if (!isAir(b) || !isAir(over) || !under || (under.boundingBox !== 'block' &&
      !(under.name === 'water' && bot.blockAt(c.offset(0, -2, 0))?.boundingBox === 'block')) || /lava/.test(under.name)) continue
    if (FALLING.test(under.name)) {
      let p = c.offset(0, -2, 0); let floor = bot.blockAt(p)
      while (floor?.boundingBox === 'block' && FALLING.test(floor.name) && p.y > (bot.game?.minY ?? -64)) {
        p = p.offset(0, -1, 0); floor = bot.blockAt(p)
      }
      if (floor?.boundingBox !== 'block' || FALLING.test(floor.name)) continue
    }
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
  let spot = grindSpot(bot)
  const digVisible = require('./cast')._in.digVisible
  // Места нет (колодец 1×1, тупик штрека — S8d, s8d-b-v1-3: «некуда поставить» ×6 подряд): вырыть нишу сбоку — клетку у ног и над ней
  // (видимые грани стенки), пол под ней остаётся. ND_GRIND_NICHE=0 — прежнее.
  if (!spot && process.env.ND_GRIND_NICHE !== '0') {
    const feet = bot.entity.position.floored()
    for (const [dx, dz] of SIDES) {
      const c = feet.offset(dx, 0, dz)
      const cells = [c, c.offset(0, 1, 0)].map(p => bot.blockAt(p))
      const under = bot.blockAt(c.offset(0, -1, 0))
      if (!under || under.boundingBox !== 'block' || FLUID.test(under.name) || cells.some(b => !b || FLUID.test(b.name) || /bedrock|obsidian/.test(b.name))) continue
      if (SIDES.some(([ex, ez]) => [0, 1].some(dy => FLUID.test((bot.blockAt(c.offset(ex, dy, ez)) || {}).name || '')))) continue
      try {
        for (const b of cells) if (b && !isAir(b)) { await equipBestTool(bot, b); await digVisible(bot, b, 4000) }
      } catch { continue }
      spot = grindSpot(bot)
      if (spot) break
    }
  }
  if (!spot) return { ok: false, tries: 0, flint: flint0, stopped: 'некуда поставить гравий рядом (нужен твёрдый пол и воздух у ног)' }
  let tries = 0
  let why = null
  while (tries < max && count('flint') === flint0 && count('gravel') > 0 && gameClock.now() < deadline && !ctl.aborted) {
    tries++
    // После подбора ходом тело ушло от клетки — новая клетка у ног.
    const s2 = grindSpot(bot)
    if (s2) spot = s2
    const before = count('gravel')
    const r = await placeBlockAt(bot, spot, { item: 'gravel', honest: true, prop: spot.offset(0, -1, 0), ctl })
    const g = bot.blockAt(spot)
    if (!g || g.name !== 'gravel') { why = `гравий не встал: ${r.reason || (g ? g.name : '?')}`; break }
    try { await equipBestTool(bot, g); await digVisible(bot, g, 4000) } catch (e) { why = `не копается: ${e.message}`; break }
    // Подбор: дроп падает в соседнюю клетку — подтянется за несколько тиков.
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && count('flint') === flint0 && count('gravel') < before && !ctl.aborted) await gameClock.sleep(50)
    // Дроп отлетел дальше досягаемости подбора (S8d, s8d-a-v1-3: 22 попытки — 10 гравия ушли на землю, «гравий кончился» без
    // кремня) — подобрать ходом, пока лежит рядом. ND_GRIND_PICKUP=0 — прежнее.
    if (count('flint') === flint0 && count('gravel') < before && process.env.ND_GRIND_PICKUP !== '0' && !ctl.aborted) {
      try { await require('./actions').collectNearbyDrops(bot, ctl, { radius: 4, timeoutMs: 3000, appearMs: 300 }) } catch {}
      try { bot.pathfinder.setGoal(null) } catch {}
    }
  }
  const flint = count('flint')
  return { ok: flint > flint0, tries, flint, gravel: count('gravel'), ...(flint > flint0 ? {} : { stopped: why || (count('gravel') ? 'кремень не выпал' : 'гравий кончился') }) }
}

module.exports = { flintGrind, grindSpot }
