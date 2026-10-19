'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { sleep, xyz } from '../movement'
import { equipBestTool, missingHarvestTool, countItems, diffItems } from '../items'
import { withTimeout } from '../build'
import { reachOf } from '../reach'
import { MAX_LENGTH, MOB_RADIUS, LOW_HEALTH, at, isLava, isWater, clamp, quickBreak } from './dig-core'
import { hostilesWithin } from './seal'

// ---------------------------------------------------------------- shaft down

// Колодец 1×1 вниз (поток overworld 02.10.2026, кампания ND_OW_DEEP): лесенка — 3.25 с на уровень (медиана 467
// шагов A1–A5), колодец — один блок на уровень, ~1–1.5 с. Старая беда колодца — карман лавы СБОКУ (2026-09-26,
// y 66→50: «tried to swim in lava»): actions.digDown смотрит только под ноги. Здесь перед каждым ударом чутьё
// (как danger(): только «нет», никогда не находит) смотрит клетку под ногами, две ниже и их четыре стороны:
// лава или вода — стоп и место названо (кампания уходит лесенкой/штреком); пустота под ногами глубже 3 блоков
// (прыжок с уроном) — стоп; враг рядом — стоп. Копается только блок под ногами (его верхняя грань видна).
const SHAFT_FREE_FALL = 3
// Сухое возвышение рядом для колодца (поток overworld, 02.10 вечер): низина с водой под самым дёрном (заснеженная
// равнина у замёрзшей реки, болото — ow-P1 слот 8: 10 колодцев подряд «вода на … (снизу)» в 100 бл. вокруг, ночь, смерть).
// Смотрим только верх рельефа — то, что видно глазами с места (холм выше воды), под землю не заглядываем: кольца 12…44 бл.,
// 16 направлений, верхний твёрдый блок столбца (не листва, не бревно, не вода/лёд), клетка над ним — воздух. Выше на ≥ 4 —
// лучше; ближе — лучше. Возвращает { x, y, z } (клетка ног) или null.
function dryGround (bot, { minRise = 4, rings = [12, 20, 28, 36, 44] }: any = {}) {
  try {
    const me = bot.entity.position.floored()
    let best = null
    for (const r of rings) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2
        const x = me.x + Math.round(Math.cos(a) * r)
        const z = me.z + Math.round(Math.sin(a) * r)
        let top = null
        for (let yy = me.y + 24; yy >= me.y - 6; yy--) {
          const b = bot.blockAt(new Vec3(x, yy, z))
          if (!b) break
          if (b.boundingBox === 'empty' && !/water|lava/.test(b.name)) continue
          if (/leaves|_log$|_wood$|vine|snow$/.test(b.name) && b.name !== 'snow_block') continue
          top = b
          break
        }
        if (!top || /water|lava|ice|magma|powder_snow/.test(top.name)) continue
        const over = bot.blockAt(top.position.offset(0, 1, 0))
        const head = bot.blockAt(top.position.offset(0, 2, 0))
        if (!over || !head || over.boundingBox !== 'empty' || head.boundingBox !== 'empty' || /water|lava/.test(over.name)) continue
        const rise = top.position.y + 1 - me.y
        if (rise < minRise) continue
        const score = rise - r / 12
        if (!best || score > best.score) best = { score, x, y: top.position.y + 1, z }
      }
    }
    return best ? { x: best.x, y: best.y, z: best.z } : null
  } catch { return null }
}
async function shaftDown (session, ctl, { length = 16, timeoutSeconds = 180, nightWork = false }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const want = clamp(length, 1, MAX_LENGTH, 16)
  const deadline = gameClock.now() + clamp(timeoutSeconds, 10, 600, 180) * 1000
  const before = countItems(bot)
  const from = xyz(bot.entity.position)
  let dug = 0
  let stopped = null
  let stuck = 0
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const startY = bot.entity.position.floored().y
  let sealedAt = null
  let lidAt = null
  let lidNote = null
  const lidHolds = () => {
    if (!lidAt) return false
    const b = bot.blockAt(lidAt)
    if (!b || b.boundingBox !== 'block') return false
    return sides.every(([dx, dz]) => { const n = bot.blockAt(lidAt.offset(dx, 0, dz)); return n && n.boundingBox === 'block' })
  }
  for (let i = 0; i < want * 2 && !ctl.aborted; i++) {
    const feet = bot.entity.position.floored()
    if (startY - feet.y >= want) break
    if (nightWork) {
      const w: typeof import('../night-work') = require('../night-work'), v = w.profile(bot)
      if (w.price({ ...v, hp: bot.health, fight: (require('../assess') as typeof import('../assess')).plan(bot, { radius: 16 }) }, 3.25) > 3.25) { stopped = 'NIGHT_RISK: открытый или опасный колодец'; break }
    }
    if (gameClock.now() > deadline) { stopped = `время вышло на ${startY - feet.y}-м уровне`; break }
    if ((bot.health ?? 20) <= LOW_HEALTH) { stopped = `хп ${Math.round(bot.health ?? 0)} — колодец бросаю`; break }
    // Моб — помеха, только если может до нас добраться (reach.reachOf: удар, выстрел, путь) или стоит прямо под
    // колодцем (вскроем его следующим ударом). Крипер в пещере за камнем в 5 блоках ниже — фон (ow-L2 02.10, слот 12:
    // десять «колодец бросаю» за секунду на одном месте).
    const mob = hostilesWithin(bot, MOB_RADIUS).find(m => {
      // Колодец закрыт блоком над головой (крышка цела, все 4 стенки у неё) — кто выше крышки, до нас не доберётся.
      if (sealedAt !== null && m.position.y > sealedAt && lidHolds()) return false
      let r = null
      try { r = reachOf(bot, m) } catch {}
      if (r && r.reaches) return true
      const p = m.position
      return Math.abs(p.x - (feet.x + 0.5)) <= 1.5 && Math.abs(p.z - (feet.z + 0.5)) <= 1.5 && p.y < feet.y && p.y > feet.y - 4
    })
    // Моб сверху, а я уже в колодце (стенки вокруг головы) — крышка: блок над головой к стенке по видимой грани
    // (build.placeBlockAt honest), и копать дальше. Так делает человек; раньше колодец бросался и кампания отвечала
    // мобу наверху (ow-E3 02.10: «крипер/паук/зомби сверху — колодец бросаю» ×30 за ночь, спуск по кругу).
    if (mob && sealedAt === null && mob.position.y > feet.y + 1 && startY - feet.y >= 2) {
      const lid = feet.offset(0, 2, 0)
      const walls = sides.filter(([dx, dz]) => { const b = bot.blockAt(lid.offset(dx, 0, dz)); return b && b.boundingBox === 'block' }).length
      // Только в целом колодце (4 стенки у крышки) и стоя на опоре: верх тела ниже клетки крышки (Codex: floored()
      // ноги при y+0.3 — тело уже в клетке ноги+2, сервер установку откажет).
      const top = bot.entity.position.y + (bot.entity.height || 1.8)
      if (walls === 4 && bot.entity.onGround !== false && top <= lid.y + 0.001) {
        let r = null
        try { r = await (require('../build') as typeof import('../build')).placeBlockAt(bot, lid, { honest: true, steady: true, timeoutMs: 3000 }) } catch (e) { r = { ok: false, reason: e.message } }
        const lb = bot.blockAt(lid)
        if (r && r.ok && lb && lb.boundingBox === 'block') { sealedAt = lid.y; lidAt = lid; lidNote = `крышка над колодцем на ${at(lid)} (${mob.name} сверху)`; continue }
      }
    }
    if (mob) { stopped = `${mob.name} в ${mob.position.distanceTo(bot.entity.position).toFixed(1)} блоках ${mob.position.y < feet.y - 0.5 ? 'снизу' : 'сверху'} — колодец бросаю`; break }
    const below = bot.blockAt(feet.offset(0, -1, 0))
    if (!below) { stopped = `мир на ${at(feet.offset(0, -1, 0))} не прогружен`; break }
    if (below.name === 'bedrock') { stopped = `бедрок на ${at(below.position)} — ниже мира нет`; break }
    if (isLava(below)) { stopped = `лава на ${at(below.position)} (снизу) — не копаю`; break }
    if (isWater(below)) { stopped = `вода на ${at(below.position)} (снизу) — не копаю`; break }
    // Чутьё: клетка под ногами и та, что под ней, и их стороны.
    let hazard = null
    for (const dy of [-1, -2]) {
      const c = feet.offset(0, dy, 0)
      for (const [dx, dz] of [[0, 0], ...sides]) {
        if (dy === -1 && dx === 0 && dz === 0) continue
        const b = bot.blockAt(c.offset(dx, 0, dz))
        if (!b) { hazard = `мир на ${at(c.offset(dx, 0, dz))} не прогружен`; break }
        if (isLava(b)) { hazard = `лава на ${at(b.position)} (снизу) — колодец не копаю, обходи лесенкой или штреком`; break }
        if (isWater(b)) { hazard = `вода на ${at(b.position)} (снизу) — колодец не копаю, обходи лесенкой или штреком`; break }
      }
      if (hazard) break
    }
    if (hazard) { stopped = hazard; break }
    // Пустота под копаемым блоком: сколько лететь до опоры.
    const under = bot.blockAt(feet.offset(0, -2, 0))
    if (under && under.boundingBox === 'empty') {
      let fall = 1
      for (; fall <= 40; fall++) {
        const b = bot.blockAt(feet.offset(0, -1 - fall, 0))
        if (!b) break
        if (isLava(b) || isWater(b)) { fall = 99; break }
        if (b.boundingBox !== 'empty') break
      }
      if (fall > SHAFT_FREE_FALL) { stopped = `под ногами пустота (пещера) глубже ${SHAFT_FREE_FALL} — колодец бросаю на ${at(feet)}`; break }
    }
    const problem = quickBreak(bot, below) ? null : missingHarvestTool(bot, below, mcData)
    if (problem) { stopped = problem; break }
    try {
      await equipBestTool(bot, below)
      await withTimeout(bot.dig(below, true, new Vec3(0, 1, 0)), 8000, 'не копается')
      dug++
    } catch (e) { stopped = `не копается ${below.name}: ${e.message}`; break }
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1200 && bot.entity.position.floored().y >= feet.y && !ctl.aborted) await sleep(50)
    for (let k = 0; k < 10 && !bot.entity.onGround && !ctl.aborted; k++) await sleep(50)
    // Удар без спуска (листва кроны, трава, блок вернулся) — три подряд: колодец здесь не идёт (ow-E2 02.10, слот 9:
    // 3 мин на месте на кроне тёмного дуба).
    if (bot.entity.position.floored().y >= feet.y) { if (++stuck >= 3) { stopped = `колодец не идёт с ${at(feet)} (копаю — не опускаюсь)`; break } } else stuck = 0
  }
  // Встал у воды у самой поверхности — подсказать сухое возвышение рядом (dryGround: только верх рельефа).
  const wetTop = stopped && /^вода на/.test(stopped) && startY - bot.entity.position.floored().y <= 4
  const dryAt = wetTop ? dryGround(bot) : null
  return {
    dug,
    from,
    depth: xyz(bot.entity.position),
    descended: startY - bot.entity.position.floored().y,
    gained: diffItems(before, countItems(bot)),
    ...(lidNote ? { note: lidNote } : {}),
    ...(dryAt ? { dryAt } : {}),
    stopped: stopped || undefined
  }
}

// Колодец вверх (поток overworld, 02.10 вечер): подъём по своему колодцу 1×1 столбом под ноги — build.digUp (потолок
// копается, если надо, с проверкой жидкости за ним; прыжок и блок под ноги, towerUp). Нужен глубокому пути: вода
// штреками у y 16 не нашлась (ow-P1: 2 из 8 прогонов без воды до конца), а поверху она почти всегда видна — подняться
// своим колодцем, зачерпнуть и снова вниз. toY — до какой высоты ног (устье колодца); моб, который дотянется, — стоп.
async function shaftUp (session, ctl, { length = 16, timeoutSeconds = 120, toY = null, nightWork = false }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const build: typeof import('../build') = require('../build')
  const want = clamp(length, 1, MAX_LENGTH, 16)
  const deadline = gameClock.now() + clamp(timeoutSeconds, 10, 600, 120) * 1000
  const from = xyz(bot.entity.position)
  const startY = bot.entity.position.y
  let stopped = null
  const guard = () => {
    const m = hostilesWithin(bot, MOB_RADIUS).find(e => { try { const r = reachOf(bot, e); return r && r.reaches } catch { return false } })
    return m ? { who: m, dist: m.position.distanceTo(bot.entity.position) } : null
  }
  for (let i = 0; i < want * 2 && !ctl.aborted; i++) {
    const y = bot.entity.position.y
    if (toY !== null && Math.floor(y) >= toY) break
    if (y - startY >= want) break
    if (nightWork) {
      const w: typeof import('../night-work') = require('../night-work'), v = w.profile(bot)
      if (w.price({ ...v, hp: bot.health, fight: (require('../assess') as typeof import('../assess')).plan(bot, { radius: 16 }) }, 3.25) > 3.25) { stopped = 'NIGHT_RISK: открытый или опасный подъём'; break }
    }
    if (gameClock.now() > deadline) { stopped = `время вышло на +${Math.round(y - startY)}`; break }
    if ((bot.health ?? 20) <= LOW_HEALTH) { stopped = `хп ${Math.round(bot.health ?? 0)} — подъём бросаю`; break }
    const r = await build.digUp(bot, ctl, { blocks: 1, mcData, tower: true, guard })
    if (bot.entity.position.y - y < 0.5) { stopped = r.stopped || 'выше не поднимаюсь'; break }
  }
  return { from, to: xyz(bot.entity.position), climbed: Math.round(bot.entity.position.y - startY), stopped: stopped || undefined }
}

export { dryGround, shaftDown, shaftUp }
