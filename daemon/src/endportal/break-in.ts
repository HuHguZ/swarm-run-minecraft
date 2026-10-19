'use strict'
// Крепость и портал в Край (endportal.ts): из своей шахты внутрь крепости: клетка внутри, вход по кирпичу, пролом.
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { sleep, xyz }: typeof import('../movement') = require('../movement')
const { equipBestTool, missingHarvestTool }: typeof import('../items') = require('../items')
const { walkable }: typeof import('../walkable') = require('../walkable')
import { BRICKS, honestDescent, log, walkTo, INFESTED } from './common'

// Шахта остановилась у кирпича — но тело ещё в своей шахте 1x1, а не в
// крепости: разведке оттуда идти некуда (прогон 2026-09-25: «куда идти
// дальше, не вижу» за 0 секунд). Стена крепости в один кирпич, коридор за ней
// высотой 3: пробить ногами и головой в сторону кирпича и шагнуть, пока вокруг
// не станет просторно; кирпич под ногами — потолок, его вниз.
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// Клетка внутри крепости: воздух на ноги и голову, пол — кирпич крепости, и
// вокруг (5x3x5) не меньше 10 блоков крепости (коридор, а не пещера рядом:
// прогон 25 — «внутри» по 13 клеткам пещеры).
const HOLD = /stone_brick|infested_|^iron_bars$|^oak_planks$|^bookshelf$|^end_portal_frame$|_door$/
// Дёшево: воздух на ноги и голову, пол — кирпич, над головой в 2..4 — потолок
// крепости (дно своей шахты на крыше крепости не проходит: над ним шахта).
const FLOOR = /stone_brick|infested_|^oak_planks$|^end_portal_frame$/
function interiorCell (bot, c) {
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/water|lava/.test(b.name) }
  if (!air(c) || !air(c.offset(0, 1, 0))) return 0
  const fl = bot.blockAt(c.offset(0, -1, 0))
  if (!fl || !FLOOR.test(fl.name)) return 0
  let roof = false
  for (let dy = 2; dy <= 4 && !roof; dy++) { const b = bot.blockAt(c.offset(0, dy, 0)); if (b && HOLD.test(b.name)) roof = true }
  if (!roof) return 0
  let n = 0
  for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 3; dy++) for (let dz = -2; dz <= 2; dz++) {
    const b = bot.blockAt(c.offset(dx, dy, dz))
    if (b && HOLD.test(b.name)) n++
  }
  return n >= 10 ? n : 0
}

// Точно: заливка «куда дойду» от клетки (6 блоков, до 80) — 8+ клеток, и у
// 60%+ из них пол — кирпич крепости (коридор; дно шахты — 2 клетки, пещера —
// камень под ногами). Прогон 26: дно шахты на крыше крепости считалось «внутри».
function insideHold (bot, c) {
  const nodes = walkable(bot, c, { radius: 6, maxNodes: 80, doors: true })
  if (nodes.length < 8) return false
  const brick = nodes.filter(n => { const fl = bot.blockAt(n.pos.offset(0, -1, 0)); return fl && FLOOR.test(fl.name) }).length
  return brick / nodes.length >= 0.6
}

// Внутрь по кирпичу: ближайшая клетка коридора в 8 блоках (по видимому и
// соседнему кирпичу шахты), путь к ней — pathfinder с копанием, но без
// infested; не вышло — следующая (до 4).
async function enterByBricks (session, ctl, { deadline }: any) {
  const bot = session.bot
  const f0 = bot.entity.position.floored()
  if (insideHold(bot, f0)) return { inside: true, already: true }
  const honest = honestDescent()
  let cands = []
  for (let dx = -8; dx <= 8; dx++) for (let dy = -6; dy <= 6; dy++) for (let dz = -8; dz <= 8; dz++) {
    if (!dx && !dz) continue
    const c = f0.offset(dx, dy, dz)
    // Честно — только клетки коридора, которые видно (за стеной шахты коридор не знаем).
    if (honest && !(require('../perception/eyes') as typeof import('../perception/eyes')).seesNow(bot, c)) continue
    const n = interiorCell(bot, c)
    if (n) cands.push({ c, n, d: Math.abs(dx) + Math.abs(dy) * 1.5 + Math.abs(dz) })
  }
  cands.sort((a, b) => a.d - b.d)
  const cheap = cands.length
  cands = cands.slice(0, 16).filter(k => insideHold(bot, k.c))
  const tries = []
  for (const k of cands.slice(0, 4)) {
    if (ctl.aborted || gameClock.now() > deadline) break
    const w = await walkTo(bot, ctl, k.c, 0, Math.min(30000, Math.max(3000, deadline - gameClock.now())))
    const f = bot.entity.position.floored()
    const inside = insideHold(bot, f)
    tries.push({ to: xyz(k.c), ok: w.ok, inside, why: w.ok ? undefined : w.error })
    if (inside) return { inside: true, tries, cands: cands.length, cheap }
  }
  return { inside: false, tries, cands: cands.length, cheap }
}

async function breakIn (session, ctl, { deadline, tries = 8, toward = null, allowDescent = true }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const steps = []
  const roomy = () => walkable(bot, bot.entity.position, { radius: 8, maxNodes: 60, doors: true }).length >= 12
  // Честно: за стеной коридор не видно — пробить видимый кирпич и смотреть (endportal-descent.honestEnter).
  if (honestDescent()) {
    // «Внутри» — клетки с полом крепости (кирпич, доски, рамки), а не просторно вообще: винтовая лестница 2×2 сама даёт 10+
    // клеток стояния в 8 бл. (ложное «внутри» — разведка ходила бы по своей лестнице).
    const inHold = () => walkable(bot, bot.entity.position, { radius: 8, maxNodes: 80, doors: true })
      .filter(n => { const fl = bot.blockAt(n.pos.offset(0, -1, 0)); return fl && FLOOR.test(fl.name) }).length >= 6
    const r = await (require('../endportal-descent') as typeof import('../endportal-descent')).honestEnter(session, ctl, { deadline, toward, bricks: BRICKS, roomy: inHold, tries: tries + 2, allowDescent })
    log('внутрь (честно)', { inside: r.inside, at: xyz(bot.entity.position.floored()), toward, steps: r.steps.slice(-6) })
    return r
  }
  const at = p => bot.blockAt(p)
  const isAir = b => !!b && b.boundingBox === 'empty' && !/lava|water|fire|portal/.test(b.name)
  const isBrick = b => !!b && BRICKS.test(b.name)
  const dig = async (c) => {
    const b = at(c)
    if (!b || b.boundingBox === 'empty') return true
    if (/lava|water|end_portal/.test(b.name) || b.name === 'bedrock' || INFESTED.test(b.name)) { steps.push(`стоп: ${b.name}`); return false }
    const problem = missingHarvestTool(bot, b, mcData)
    if (problem) { steps.push(`стоп: ${problem}`); return false }
    try { await equipBestTool(bot, b); await bot.dig(b) } catch (e) { steps.push(`стоп: ${e.message}`); return false }
    steps.push(`${b.name}@${c.x},${c.y},${c.z}`)
    return true
  }
  // Шаг клавишами в соседнюю клетку: pathfinder'у в шахте 1x1 не развернуться.
  const stepInto = async (cell) => {
    const target = cell.offset(0.5, 0, 0.5)
    const t0 = gameClock.now()
    try {
      while (gameClock.now() - t0 < 1500 && bot.entity.position.floored().distanceTo(cell) >= 0.5) {
        await bot.lookAt(target.offset(0, 1.6, 0), true)
        bot.setControlState('forward', true)
        await sleep(50)
      }
    } finally { bot.setControlState('forward', false) }
    await sleep(300)
  }
  // Сколько воздуха под клеткой, прежде чем пол (прыжок в комнату).
  const dropUnder = (c) => {
    let n = 0
    for (let d = 1; d <= 6; d++) {
      const b = at(c.offset(0, -d, 0))
      if (!b) return 99
      if (/lava/.test(b.name)) return 99
      if (b.boundingBox !== 'empty') return n
      n++
    }
    return n
  }
  for (let i = 0; i < tries && !ctl.aborted && gameClock.now() < deadline; i++) {
    if (roomy()) return { inside: true, steps }
    const feet = bot.entity.position.floored()
    const down = feet.offset(0, -1, 0)
    // 1. Потолок крепости прямо под ногами, под ним воздух — вниз.
    if (isBrick(at(down)) && isAir(at(down.offset(0, -1, 0))) && dropUnder(down) <= 4) {
      if (!(await dig(down))) break
      await sleep(600)
      continue
    }
    let done = false
    for (const [dx, dz] of CARDINAL) {
      const f = feet.offset(dx, 0, dz)
      const h = feet.offset(dx, 1, dz)
      const fd = f.offset(0, -1, 0)
      // 2. Потолок наискосок: шагнуть туда (пробив ноги и голову) и вниз.
      if (isBrick(at(fd)) && isAir(at(fd.offset(0, -1, 0))) && dropUnder(fd) <= 4) {
        if (!(await dig(h)) || !(await dig(f))) { done = true; break }
        await stepInto(f)
        if (!bot.entity.position.floored().equals(f)) continue
        if (!(await dig(fd))) { done = true; break }
        await sleep(600)
        done = true
        break
      }
      // 3. Стена сбоку, за ней воздух — пробить ноги и голову и шагнуть.
      const f2 = feet.offset(2 * dx, 0, 2 * dz)
      const h2 = feet.offset(2 * dx, 1, 2 * dz)
      if ((isBrick(at(f)) || isBrick(at(h))) && (isAir(at(f2)) || isAir(at(h2)))) {
        if (!(await dig(h)) || !(await dig(f))) { done = true; break }
        await stepInto(f)
        done = true
        break
      }
    }
    if (!done && toward) {
      // Лестница старта (StrongholdPieces.StartPiece = StairsDown 5x11x5 с
      // началом в углу чанка + 2): стены — весь периметр 5x5 на все 11 высот,
      // середина (угол + 4) — воздух сверху донизу, ступени по краю. Шахта,
      // промахнувшаяся оком на 1–2 блока, идёт вниз внутри стены (лаборатория
      // 2026-09-27, прогон 18: 6 блоков кирпича вниз в 2 блоках от середины,
      // «куда идти дальше, не вижу»). Вбок к середине — в пролёт лестницы.
      const ddx = toward.x - feet.x; const ddz = toward.z - feet.z
      if (Math.abs(ddx) + Math.abs(ddz) >= 1 && Math.abs(ddx) <= 4 && Math.abs(ddz) <= 4) {
        const [sx, sz] = Math.abs(ddx) >= Math.abs(ddz) ? [Math.sign(ddx), 0] : [0, Math.sign(ddz)]
        const f = feet.offset(sx, 0, sz)
        const h = f.offset(0, 1, 0)
        if (!(await dig(h)) || !(await dig(f))) break
        await stepInto(f)
        steps.push(`к середине лестницы ${f.x},${f.z}`)
        continue
      }
    }
    if (!done) {
      // Ничего не подошло: кирпич под ногами — копать вниз, иначе — в сторону
      // ближайшего видимого кирпича.
      if (isBrick(at(down)) || !isAir(at(down))) {
        if (!(await dig(down))) break
        await sleep(600)
      } else break
    }
  }
  const inside = roomy()
  try {
    const f = bot.entity.position.floored()
    const around = []
    for (const [dx, dz] of CARDINAL) for (const dy of [-1, 0, 1]) { const b = bot.blockAt(f.offset(dx, dy, dz)); around.push(b ? b.name.replace(/_bricks?$|stone_brick/, 'B').slice(0, 12) : '?') }
    log('внутрь', { inside, at: xyz(f), toward, nodes: walkable(bot, bot.entity.position, { radius: 8, maxNodes: 60, doors: true }).length, below: (bot.blockAt(f.offset(0, -1, 0)) || {}).name, around: around.join(' '), steps: steps.slice(-6) })
  } catch {}
  return { inside, steps }
}

export {
  CARDINAL, HOLD, FLOOR, interiorCell, insideHold, enterByBricks, breakIn
}
