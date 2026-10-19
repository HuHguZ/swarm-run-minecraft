'use strict'
// Крепость и портал в Край (endportal.ts): вода и лава у входа: сухая колонка, обход, штрек под водой.
import * as gameClock from '../game-clock'
import { Vec3 } from 'vec3'
import { sleep, xyz, travelXZ } from '../movement'
import { equipBestTool, missingHarvestTool } from '../items'
import { walkable } from '../walkable'
import { BRICKS, honestDescent, look } from './common'
import { shaftToBricks } from './shaft'

// Верх земли в колонке: первая клетка сверху, где можно стоять (пол твёрдый или
// вода — её тоже надо увидеть), в окне ±20 от высоты тела.
function surfaceY (bot, x, z, fromY) {
  for (let y = fromY + 20; y >= fromY - 20; y--) {
    const g = look(bot, new Vec3(x, y - 1, z))
    const f = look(bot, new Vec3(x, y, z))
    if (!g || !f) continue
    // Листва и стволы — не земля: крона дерева у озера давала «сушу» на y 86 над
    // водой на y 62 (room-A-7), и шахту копали у самой воды.
    if (/leaves|_log$|_wood$|vine/.test(g.name)) continue
    if (f.boundingBox === 'empty' && !/water|lava/.test(f.name) && (g.boundingBox === 'block' || /water|lava/.test(g.name))) return y
  }
  return null
}

// Жидкость в колонке или рядом в верхних 8 блоках — копать здесь нельзя.
function wetColumn (bot, x, z, topY) {
  // Честно — видимая вода/лава у поверхности (озеро сверху видно, подземная — нет: её покажет копка, заложим).
  const low = honestDescent() ? topY - 1 : topY - 8
  for (let y = topY + 1; y >= low; y--) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const b = look(bot, new Vec3(x + dx, y, z + dz))
        if (b && /water|lava/.test(b.name)) return b.name === 'lava' ? 'лава' : 'вода'
      }
    }
  }
  return null
}

// Ближайшая к входу комнаты сухая колонка: кольца до DRY_FAR бл., точки через 2 бл. по периметру, только прогруженные
// чанки (непрогруженная — не суша). { x, z, r } или null.
// До 96 бл. (s5c-g2-1: комната под морем, суши в 48 нет — 60 мин у воды): дальше 48 — точки через 4 бл. (дешевле), чанки
// в обзоре (8 = 128 бл.) у тела, подошедшего к комнате, прогружены; штрек под дном до 96+ шагов.
const DRY_FAR = 96

// Целая колонка шахты: от поверхности до уровня комнаты всё твёрдое (пещера ≤ 1 клетки — цена), жидкости рядом нет — по
// прогруженным чанкам, как и сухой вход (знание карты: режим MAP_SH). S5d s5d-p4-1 (07.10): шахта у входа вскрыла пещеру
// (11 бл.) — тактика рвала подход ×8, refuge 191 с, тело ниже уровня комнаты; капельник рядом — тоже не колонка (s5d-N-1:
// «skewered by a falling stalactite» на 5-й мин). null — колонка годна, иначе причина.
function shaftFlaw (bot, x, z, topY, toY, maxGap = 1) {
  let gap = 0
  for (let y = topY - 1; y >= toY - 1; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b) return 'не прогружено'
    if (/water|lava|bubble_column|pointed_dripstone/.test(b.name)) return b.name
    if (b.boundingBox === 'block') gap = 0
    else if (++gap > maxGap) return `пещера на y ${y}`
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const s = bot.blockAt(new Vec3(x + dx, y, z + dz))
      if (s && /water|lava|bubble_column|pointed_dripstone/.test(s.name)) return `${s.name} рядом на y ${y}`
      // Первый круг — шахта в сплошной породе: ниже 3 бл. от поверхности стенки целые (s5d-T-1 07.10: шахта шла по краю пещеры,
      // тактика на y 45 увела тело вбок — падение на 24 бл., капельник). Пещера рядом — второй круг.
      if (maxGap <= 1 && y < topY - 3 && s && s.boundingBox !== 'block') return `пустота рядом на y ${y}`
    }
  }
  return null
}

// Штрек от колонки к цели на уровне комнаты — без жидкости рядом (s5d-p7-1: целая колонка, а на уровне комнаты «water у забоя —
// обход» со всех сторон). Прямая с шагом 0.5 бл.; клетки ног и головы, под и над ними и по бокам.
function tunnelFlaw (bot, from, to) {
  const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) * 2))
  for (let i = 0; i <= n; i++) {
    const x = Math.floor(from.x + (to.x - from.x) * i / n); const z = Math.floor(from.z + (to.z - from.z) * i / n)
    for (let dy = -1; dy <= 2; dy++) {
      for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const b = bot.blockAt(new Vec3(x + dx, to.y + dy, z + dz))
        if (!b) return 'не прогружено'
        if (/water|lava|bubble_column/.test(b.name)) return `${b.name} на штреке у ${x + dx},${to.y + dy},${z + dz}`
      }
    }
  }
  return null
}

const SOUND_FAR = 48
function dryEntry (bot, shaft, maxR = DRY_FAR, toY = null, to = null) {
  const fromY = bot.entity.position.floored().y
  // Сначала — сухая И целая до комнаты колонка в SOUND_FAR (лишний штрек на уровне комнаты дешевле пещеры в шахте).
  // Второй круг — пещеры до 4 бл. (спуск в них — цена, shaftToBricks), но без жидкости и капельника (s5d-R-1: целой в 48 нет —
  // сухая колонка в пещеру с капельником, «impaled on a stalagmite»).
  for (const maxGap of Number.isFinite(toY) && process.env.ND_SOUND_SHAFT !== '0' && !honestDescent() ? [1, 4] : []) {
    for (let r = 0; r <= Math.min(SOUND_FAR, maxR); r += r < 24 ? 2 : 4) {
      const step = r < 24 ? 2 : 4
      const pts = r === 0 ? [[0, 0]] : []
      for (let d = -r; d < r; d += step) pts.push([d, -r], [r, d], [-d, r], [-r, -d])
      for (const [dx, dz] of pts) {
        const x = shaft.x + dx; const z = shaft.z + dz
        const y = surfaceY(bot, x, z, fromY)
        if (y !== null && !wetColumn(bot, x, z, y) && !shaftFlaw(bot, x, z, y, toY, maxGap) && !(to && tunnelFlaw(bot, { x: x + 0.5, z: z + 0.5 }, to))) return { x, z, r, sound: maxGap <= 1 ? true : 'caves' }
      }
    }
  }
  for (let r = 0; r <= maxR; r += r < 48 ? 2 : 4) {
    const step = r < 48 ? 2 : 4
    const pts = r === 0 ? [[0, 0]] : []
    for (let d = -r; d < r; d += step) pts.push([d, -r], [r, d], [-d, r], [-r, -d])
    for (const [dx, dz] of pts) {
      const x = shaft.x + dx; const z = shaft.z + dz
      const y = surfaceY(bot, x, z, fromY)
      if (y !== null && !wetColumn(bot, x, z, y)) return { x, z, r }
    }
  }
  return null
}

// Самая низкая жидкость в колонке цели и вокруг (±2), сверху вниз до 40 блоков.
function lowestLiquid (bot, x, z, fromY) {
  let low = null
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let y = fromY + 2; y >= fromY - 40; y--) {
        const b = look(bot, new Vec3(x + dx, y, z + dz))
        if (!b) break
        if (/water|lava/.test(b.name)) low = low === null ? y : Math.min(low, y)
      }
    }
  }
  return low
}

// Сухая клетка рядом → шахта вниз под дно → штрек 1x2 под целью → дальше вниз
// тем же shaftToBricks. Штрек копается только там, где вокруг нет жидкости
// (вода в озере над потолком не течёт сквозь блок).
function wetNear (bot, x, y, z, r) {
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -3; dy <= 0; dy++) {
    const b = look(bot, new Vec3(x + dx, y + dy, z + dz))
    if (b && /water/.test(b.name)) return true
  }
  return false
}

// Вода в радиусе r от колонки x,z на глубину depth ниже y (озеро под берегом).
function wetNearDeep (bot, x, y, z, r, depth) {
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = 1; dy >= -depth; dy--) {
    const b = look(bot, new Vec3(x + dx, y + dy, z + dz))
    if (b && /water/.test(b.name)) return true
  }
  return false
}

async function goAround (session, ctl, target, { deadline, far = 20, fromHere = false, fromY = null }: any) {
  const bot = session.bot
  const mcData = session.mcData
  const me = bot.entity.position.floored()
  // fromHere — продолжение начатого обхода (тело уже в своей шахте/штреке от сухой клетки): без поиска и перехода.
  let from = fromHere ? me.clone() : null
  // Шахта пойдёт ниже дна озера: берег проверять на воду на всю эту глубину, а
  // не на 3 блока. Крепость A (-400,1776): озеро 6+ блоков, под берегом вода на
  // y 57–61 — шахта у кромки упиралась «вода у шахты — заложил 0 из 1» (ферма
  // 29.09, room-A-7: 4 из 4 заходов, по 4 вызова одинаково).
  const bottom0 = lowestLiquid(bot, target.x, target.z, me.y)
  const depth = bottom0 !== null ? Math.min(16, Math.max(4, me.y - bottom0 + 3)) : 4
  // Сначала — сухие клетки, до которых точно дойдём (заливка «куда дойду»):
  // выбранная по кругу клетка бывала за озером или на скале — «до сухой клетки
  // не дошёл: Took to long to decide path» (room-A-9).
  try {
    const { walkable }: typeof import('../walkable') = require('../walkable')
    const dH = q => Math.hypot(q.x - target.x, q.z - target.z)
    const nodes = walkable(bot, bot.entity.position, { radius: 40, maxNodes: 8000 })
      .map(n => n.pos).filter(q => dH(q) >= 2 && dH(q) <= 20).sort((a, c) => dH(a) - dH(c))
    const avoid = session._wetAvoid || []
    const mr = honestDescent() ? 4 : 2
    for (const q of nodes) {
      if (avoid.some(v => Math.hypot(v.x - q.x, v.z - q.z) < 8)) continue
      if (!wetColumn(bot, q.x, q.z, q.y) && !wetNear(bot, q.x, q.y, q.z, mr) && !wetNearDeep(bot, q.x, q.y, q.z, mr, depth)) { from = q.clone(); break }
    }
  } catch {}
  // far > 20 (крепость под морем, S5e 07.10): суша дальше — кольца через 4 бл.; штрек под дном туда длиннее, но это 1–2 мин
  // против «другой крепости кольца» в 2000+ бл.
  if (!from) for (let r = 2; r <= far && !from; r += r < 20 ? 1 : 4) {
    for (let dx = -r; dx <= r && !from; dx += r < 20 ? 1 : 2) {
      for (const dz of [-r, r]) {
        for (const [x, z] of [[target.x + dx, target.z + dz], [target.x + dz, target.z + dx]]) {
          const y = surfaceY(bot, x, z, me.y)
          // Сухо и в 2 блоках вокруг нет воды: с кромки озера вода течёт в шахту,
          // и копка рвётся («не сломал dirt: Digging aborted» — ферма, крепость
          // A, 2 из 5 подходов). Честно — 4 бл. (лестница 2×2 шире шахты 1×1) и не у залитых мест.
          const mr = honestDescent() ? 4 : 2
          if ((session._wetAvoid || []).some(v => Math.hypot(v.x - x, v.z - z) < 8)) continue
          if (y !== null && !wetColumn(bot, x, z, y) && !wetNear(bot, x, y, z, mr) && !wetNearDeep(bot, x, y, z, mr, depth)) { from = new Vec3(x, y, z); break }
        }
        if (from) break
      }
    }
  }
  if (!from) return { ok: false, why: `сухой земли (без воды в 2 блоках) в ${far} блоках нет` }
  const avoidHere = (why): any => {
    (session._wetAvoid || (session._wetAvoid = [])).push({ x: from.x, z: from.z })
    // Залитое место не продолжать из своей шахты (s5e-I-8 07.10: «вода со всех сторон» ×N в той же шахте → утонул).
    if (session._seaDig && session._seaDig.key === `${target.x},${target.z}`) session._seaDig.failed = true
    return { ok: false, from: xyz(from), why, wet: true, dug: 0 }
  }
  if (!fromHere) {
    session._seaDig = { key: `${target.x},${target.z}`, from: xyz(from) }
    const w = await travelXZ(bot, ctl, from.x, from.z, { range: 0, retries: 2, deadline })
    if (!w.ok) return { ok: false, from: xyz(from), why: `до сухой клетки не дошёл: ${w.error}` }
    // Издали вода у клетки могла быть не видна (честно: суждение по видимому) — пришёл, посмотрел: вода в 4 бл. — другое место.
    if (honestDescent()) {
      const f = bot.entity.position.floored()
      if (wetNear(bot, f.x, f.y, f.z, 4) || wetColumn(bot, f.x, f.z, f.y)) return avoidHere('у сухой клетки вблизи вода — другое место')
    }
  }
  // Вниз — ниже дна: дно видно сквозь воду, его и берём (у -3760,-3408
  // озеро было 10 блоков глубиной, и штрек на «суша минус 10» шёл по дну и
  // затопился). Кирпич раньше — тем лучше.
  const start = bot.entity.position.floored()
  const top = Number.isFinite(fromY) ? fromY : start.y
  const bottom = lowestLiquid(bot, target.x, target.z, top)
  const down = await shaftToBricks(session, ctl, { minY: Math.min(top - 10, bottom !== null ? bottom - 4 : Infinity), deadline })
  if ((down as any).wet) {
    if ((down as any).drowning || (require('../movement') as typeof import('../movement')).inWater(bot)) { try { await require('../survival/surface-body').surface(session, ctl, { timeoutSeconds: 40, preferPillar: true }) } catch {} }
    return { ...avoidHere(`спуск у сухой клетки залило: ${down.stopped}`), dug: down.dug || 0 }
  }
  let dug = down.dug || 0
  if (down.found) return { ok: true, from: xyz(from), dug, bricks: down }
  if (down.stopped && !/кирпича так и не встретил/.test(down.stopped)) return { ok: false, from: xyz(from), dug, why: down.stopped }
  // Штрек под целью; упёрся в воду над головой — ещё на 6 глубже и снова
  // (прогон у -3760,-3408: штрек на 10 ниже суши шёл под самым дном озера).
  for (let tries = 0; tries < 5; tries++) {
    const r = await tunnelUnder(session, ctl, target, deadline, Math.max(40, Math.ceil(Math.abs(target.x - bot.entity.position.x) + Math.abs(target.z - bot.entity.position.z)) + 20))
    dug += r.dug || 0
    if (r.ok || r.bricks) return { ok: true, from: xyz(from), dug, bricks: r.bricks }
    if (!r.wet || ctl.aborted || gameClock.now() > deadline) return { ok: false, from: xyz(from), dug, why: r.why }
    const cur = bot.entity.position.floored()
    const deeper = await shaftToBricks(session, ctl, { minY: cur.y - 6, deadline })
    dug += deeper.dug || 0
    if (deeper.found) return { ok: true, from: xyz(from), dug, bricks: deeper }
    if (deeper.stopped && !/кирпича так и не встретил/.test(deeper.stopped)) return { ok: false, from: xyz(from), dug, why: deeper.stopped }
  }
  return { ok: false, from: xyz(from), dug, why: 'под водой пройти не вышло и на 30 блоков ниже' }
}

async function tunnelUnder (session, ctl, target, deadline, maxSteps = 40) {
  const bot = session.bot
  const mcData = session.mcData
  let dug = 0
  let wet = false
  for (let steps = 0; steps < maxSteps && !ctl.aborted && gameClock.now() < deadline; steps++) {
    const f = bot.entity.position.floored()
    const ddx = target.x - f.x
    const ddz = target.z - f.z
    if (ddx === 0 && ddz === 0) return { ok: true, dug }
    const axes = Math.abs(ddx) >= Math.abs(ddz)
      ? [[Math.sign(ddx), 0], [0, Math.sign(ddz)]]
      : [[0, Math.sign(ddz)], [Math.sign(ddx), 0]]
    let moved = false
    for (const [sx, sz] of axes) {
      if (!sx && !sz) continue
      const feet = f.offset(sx, 0, sz)
      const head = feet.offset(0, 1, 0)
      if (honestDescent()) {
        // Честно: копать и смотреть; увиденную воду/лаву — заложить; кирпич в забое — пришли.
        const r = await (require('../endportal-descent') as typeof import('../endportal-descent')).honestTunnelStep(session, ctl, feet, { bricks: BRICKS, throughBricks: false })
        dug += r.dug || 0
        if (r.brick) return { ok: true, dug, bricks: { found: r.brick, at: xyz(feet), dug } }
        if (r.ok) { moved = true; break }
        if (r.wet || /заложил|вода|water|lava/.test(r.why || '')) wet = true
        continue
      }
      if (wetColumn(bot, feet.x, feet.z, feet.y + 2) === 'лава') continue
      let bad = null
      for (const c of [head, feet]) {
        for (const n of [c, c.offset(1, 0, 0), c.offset(-1, 0, 0), c.offset(0, 0, 1), c.offset(0, 0, -1), c.offset(0, 1, 0)]) {
          const b = bot.blockAt(n)
          if (b && /water|lava/.test(b.name)) bad = b.name
        }
      }
      if (bad) { wet = true; continue }
      let err = null
      for (const c of [head, feet]) {
        const b = bot.blockAt(c)
        if (!b || b.boundingBox === 'empty') continue
        if (BRICKS.test(b.name)) return { ok: true, dug, bricks: { found: b.name, at: xyz(c), dug } }
        const problem = missingHarvestTool(bot, b, mcData)
        if (problem) { err = problem; break }
        try { await equipBestTool(bot, b); await bot.dig(b); dug++ } catch (e) { err = e.message; break }
      }
      if (err) continue
      const t0 = gameClock.now()
      try {
        while (gameClock.now() - t0 < 1500 && !bot.entity.position.floored().equals(feet)) {
          await bot.lookAt(feet.offset(0.5, 1.6, 0.5), true)
          bot.setControlState('forward', true)
          await sleep(50)
        }
      } finally { bot.setControlState('forward', false) }
      if (bot.entity.position.floored().equals(feet)) { moved = true; break }
    }
    if (!moved) return { ok: false, dug, wet, why: wet ? 'над штреком вода' : 'штрек не пошёл: не шагнуть' }
  }
  return { ok: false, dug, why: `штрек не дошёл за ${maxSteps} шагов` }
}

// Сухая по видимому колонка для шахты: кольца rMin..rMax от center (16 точек на кольцо), ближе к prefer; поверхность видна, воды
// у неё нет и в 4 бл. вокруг; дальше 8 бл. от мест, где спуск уже залило (avoid). null — нет.
function pickDryShaft (bot, center, prefer, avoid = [], rMin = 5, rMax = 24) {
  const me = bot.entity.position
  for (let r = rMin; r <= rMax; r += 2) {
    const ring = []
    for (let a = 0; a < 16; a++) ring.push({ x: Math.round(center.x + r * Math.sin(a * Math.PI / 8)), z: Math.round(center.z + r * Math.cos(a * Math.PI / 8)) })
    ring.sort((p1, p2) => Math.hypot(p1.x - prefer.x, p1.z - prefer.z) - Math.hypot(p2.x - prefer.x, p2.z - prefer.z))
    for (const c of ring) {
      if (avoid.some(v => Math.hypot(v.x - c.x, v.z - c.z) < 8)) continue
      const y = surfaceY(bot, c.x, c.z, Math.floor(me.y))
      if (y !== null && !wetColumn(bot, c.x, c.z, y) && !wetNear(bot, c.x, y, c.z, 4)) return c
    }
  }
  return null
}

export {
  surfaceY, wetColumn, DRY_FAR, shaftFlaw, tunnelFlaw, SOUND_FAR, dryEntry, lowestLiquid, wetNear, wetNearDeep, goAround, tunnelUnder, pickDryShaft
}
