'use strict'
// Литьё портала (cast.ts): ходьба у рамы, окна к лаве, добор лавы и воды, стойка у клетки рамы.
import { withTimeout, placeBlockAt, towerUp } from '../build'
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import { Vec3 } from 'vec3'
import { faceAim } from '../pick'
import { missingHarvestTool, equipBestTool } from '../items'
import { goals } from 'mineflayer-pathfinder'
import {
  FALLING, PLACE, PROTECTED, REACH, SIDES4, UP, centre, countOf, digRisk, digVisible, eyes, feetCell, geomOf, hasFluid,
  isAir, isSolid, levelOf
} from './base'
import { scoop, scoopAim, scoopableSources, standNear, standSpots } from './bucket'


let lastWalkError = null
export async function walk (bot, ctl, goal, ms = 20000, { clearance = false }: any = {}) {
  const mv = bot.pathfinder.movements
  const saved = mv && { canDig: mv.canDig, towers: mv.allow1by1towers, scaffold: mv.scafoldingBlocks, breaks: mv.exclusionAreasBreak, steps: mv.exclusionAreasStep }
  if (mv) {
    mv.canDig = clearance && saved.canDig
    mv.allow1by1towers = false
    mv.scafoldingBlocks = []
    mv.exclusionAreasBreak = [...(saved.breaks || []), b =>
      b.position.y < feetCell(bot).y || digRisk(p => bot.blockAt(p), b.position) ? 100 : 0]
    mv.exclusionAreasStep = [...(saved.steps || []), b =>
      bot._ndCastHoles && bot._ndCastHoles.has(`${b.position.x},${b.position.y},${b.position.z}`) ? 100 : 0]
  }
  try {
    await withTimeout(bot.pathfinder.goto(goal), ms, 'не дошёл')
    lastWalkError = null
    return true
  } catch (e) {
    lastWalkError = String((e && e.message) || e).slice(0, 80)
    try { bot.pathfinder.setGoal(null) } catch {}
    return false
  } finally {
    if (mv && saved) {
      mv.canDig = saved.canDig
      mv.allow1by1towers = saved.towers
      mv.scafoldingBlocks = saved.scaffold
      mv.exclusionAreasBreak = saved.breaks
      mv.exclusionAreasStep = saved.steps
    }
  }
}

// Встать ровно в центр клетки: край тела у самой рамы коснётся лавы.
export async function centreOn (bot, ctl, cell) {
  const c = cell.offset(0.5, 0, 0.5)
  const flat = () => Math.hypot(bot.entity.position.x - c.x, bot.entity.position.z - c.z)
  if (flat() < 0.18) return true
  try {
    await bot.lookAt(c.offset(0, bot.entity.height || 1.62, 0), true)
    bot.setControlState('sneak', true)
    bot.setControlState('forward', true)
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && !ctl.aborted && flat() > 0.15) await sleep(30)
  } catch {} finally {
    try { bot.setControlState('forward', false) } catch {}
    try { bot.setControlState('sneak', false) } catch {}
  }
  await sleep(120)
  return flat() < 0.3
}
export function windowCandidates (bot, hint, { span = 3, reach = REACH, fluid = 'lava' }: any = {}) {
  const h = new Vec3(Math.floor(hint.x), Math.floor(hint.y), Math.floor(hint.z))
  const feet = feetCell(bot)
  const out = []
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -2; dy <= 1; dy++) {
      for (let dz = -span; dz <= span; dz++) {
        const s = h.offset(dx, dy, dz)
        const lb = bot.blockAt(s)
        if (!lb || lb.name !== fluid || levelOf(lb) !== 0) continue
        const w = s.plus(UP)
        const wb = bot.blockAt(w)
        if (!wb || !isSolid(wb) || PROTECTED.test(wb.name) || wb.name === 'obsidian' || wb.name === 'bedrock') continue
        // Свой пол и клетки тела не трогать.
        if (w.x === feet.x && w.z === feet.z && w.y >= feet.y - 1 && w.y <= feet.y + 1) continue
        const up = bot.blockAt(w.plus(UP))
        if (!up || hasFluid(up) || FALLING.test(up.name)) continue
        if (SIDES4.some(v => { const n = bot.blockAt(w.plus(v)); return !n || hasFluid(n) })) continue
        const d = eyes(bot).distanceTo(centre(w))
        if (d > reach + 0.5) continue
        // Видна ли хоть одна грань блока, открытая в пустоту (pick.faceAim: луч из глаз до точки грани, как прицел
        // клиента): в центр соседнего снизу-впереди блока луч упирается в клетку над ним, а грань со стороны штрека
        // видна.
        let aim = null
        let face = null
        for (const v of [...SIDES4, UP, new Vec3(0, -1, 0)]) {
          const nb = bot.blockAt(w.plus(v))
          if (!nb || nb.boundingBox !== 'empty' || /lava|water/.test(nb.name)) continue
          try { aim = faceAim(bot, w, v, { range: reach }) } catch {}
          if (aim) { face = v; break }
        }
        if (!aim) continue
        out.push({ w, s, d, aim, face })
      }
    }
  }
  return out.sort((a, b) => a.d - b.d)
}

export async function openWindow (session, ctl, hint, report, { max = 1, fluid = 'lava' }: any = {}) {
  const bot = session.bot
  if (!hint) return 0
  let opened = 0
  for (let k = 0; k < max && !ctl.aborted; k++) {
    const c = windowCandidates(bot, hint, { fluid })[0]
    if (!c) break
    const b = bot.blockAt(c.w)
    const problem = missingHarvestTool(bot, b, session.mcData)
    if (problem) break
    try {
      await equipBestTool(bot, b)
      // Keep the sampled visible point: dig(true, face) would aim at its centre.
      await bot.lookAt(c.aim, true)
      await withTimeout(bot.dig(b, 'ignore'), 8000, 'не копается')
      if (isSolid(bot.blockAt(c.w))) break
      if (!bot._ndCastHoles) bot._ndCastHoles = new Set()
      for (const p of [c.w, c.s]) bot._ndCastHoles.add(`${p.x},${p.y},${p.z}`)
      report.dug++
      report.windows = (report.windows || 0) + 1
      report.lastWindow = c.s
      opened++
    } catch { break }
    await sleep(250)
  }
  return opened
}

// Шаг над озером: источники в досягаемости от края вычерпаны, дальше — под потолком. Клетку под окном (вычерпанная —
// там текущая лава или пусто) — заложить блоком; окно над ней становится полом, на него — шаг, и окна открываются
// дальше (ow-M3, отладка 02.10: 9/10 отлито, десятому источнику не хватило досягаемости от края штрека).
async function advanceOver (session, ctl, report) {
  const bot = session.bot
  const holes = [...(bot._ndCastHoles || [])].map(k => { const [x, y, z] = k.split(',').map(Number); return new Vec3(x, y, z) })
  const me = feetCell(bot)
  // Окна (воздух), под которыми не источник, рядом с клеткой, где можно стоять; ближние к телу первыми.
  const cands = holes.filter(w => {
    const head = bot.blockAt(w.plus(UP))
    if (!isAir(bot.blockAt(w)) || !(isAir(head) || (isSolid(head) && !PROTECTED.test(head.name) && !digRisk(q => bot.blockAt(q), w.plus(UP))))) return false
    const below = bot.blockAt(w.offset(0, -1, 0))
    if (!below || (below.name === 'lava' && levelOf(below) === 0) || isSolid(below)) return false
    return SIDES4.some(v => { const n = w.plus(v); const f = bot.blockAt(n.offset(0, -1, 0)); return isAir(bot.blockAt(n)) && isAir(bot.blockAt(n.plus(UP))) && isSolid(f) })
  }).sort((a, b) => {
    // Коридором над озером: окно прямо по ходу от клетки тела (продолжение штрека к лаве) — первым; потом ближнее.
    const dir = session.castPlan && session.castPlan.lavaAt && session.castPlan.lavaAt.length ? (() => {
      const l = session.castPlan.lavaAt[session.castPlan.lavaAt.length - 1]
      const dx = l.x - me.x; const dz = l.z - me.z
      return Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
    })() : null
    const ahead = w => dir && (w.x - me.x) * dir.x + (w.z - me.z) * dir.z > 0 && ((dir.x && w.z === me.z) || (dir.z && w.x === me.x)) ? 0 : 1
    return ahead(a) - ahead(b) || a.distanceTo(me) - b.distanceTo(me)
  })
  const note = m => { report.trace = report.trace || []; report.trace.push(m); if (report.trace.length > 40) report.trace.shift() }
  if (!cands.length) note(`шаг: окон-кандидатов нет (дыр ${holes.length})`)
  for (const w of cands.slice(0, 3)) {
    const floor = w.offset(0, -1, 0)
    const sp = standNear(bot, w, 1).filter(S => !S.equals(w))
    let near = false
    for (const S of sp.slice(0, 2)) { if (await walk(bot, ctl, new goals.GoalBlock(S.x, S.y, S.z), 15000)) { near = true; break } }
    if (!near) { note(`шаг: к ${w.x},${w.y},${w.z} не подошёл (${lastWalkError || 'нет клетки'})`); continue }
    const r = await placeBlockAt(bot, floor, { steady: true })
    if (!r.ok || !isSolid(bot.blockAt(floor))) { note(`шаг: закладка ${floor.x},${floor.y},${floor.z} — ${r.reason || (bot.blockAt(floor) || {}).name}`); continue }
    report.placed++
    // Окно в одну клетку высотой (над ним порода) — голове нужен воздух: копать (видимая грань, без жидкости рядом).
    const hb = bot.blockAt(w.plus(UP))
    if (isSolid(hb)) { try { await equipBestTool(bot, hb); await digVisible(bot, hb, 8000); report.dug++ } catch (e) { note(`шаг: над окном не копается (${e.message})`); continue } }
    bot._ndCastHoles.delete(`${w.x},${w.y},${w.z}`)
    bot._ndCastHoles.delete(`${floor.x},${floor.y},${floor.z}`)
    if (await walk(bot, ctl, new goals.GoalBlock(w.x, w.y, w.z), 10000)) { report.advanced = (report.advanced || 0) + 1; return w }
  }
  return null
}

// Наполнить лавой пустые вёдра (кроме одного, если воды в руках нет — он под
// воду). Тело должно стоять на земле.
export async function refillLava (session, ctl, report) {
  const bot = session.bot
  if (!bot._ndCastHoles) bot._ndCastHoles = new Set()
  for (const p of ((session.castPlan && session.castPlan.lavaAt) || [])) {
    // Заложенное (шаг над озером) — уже пол, не дыра: иначе путь назад к окнам «No path to the goal» (ow-M4 02.10).
    if (isSolid(bot.blockAt(new Vec3(p.x, p.y, p.z)))) continue
    for (const dy of [0, 1]) bot._ndCastHoles.add(`${p.x},${p.y + dy},${p.z}`)
  }
  let want = countOf(bot, 'bucket') - (countOf(bot, 'water_bucket') ? 0 : 1)
  if (want <= 0) return countOf(bot, 'lava_bucket') > 0
  const tr = m => { report.trace = report.trace || []; report.trace.push(m); if (report.trace.length > 40) report.trace.shift() }
  let refreshed = false
  for (let tries = 0; want > 0 && tries < 7 && !ctl.aborted; tries++) {
    let src = scoopableSources(bot, ((session.castPlan && session.castPlan.lavaAt) || []).slice(0, 6))
    tr(`видно ${src.length}`)
    // Со стойки у рамы лаву заслоняет край ямы (2026-09-26, первый живой
    // прогон у спавна: место выбрано с -19,64,-25, а со стойки -21,64,-25
    // лавы не видно — «лава кончилась» за 0 с, двенадцать раз подряд). Идти к
    // лаве, которую видели при выборе места, и смотреть оттуда.
    if (!src.length) {
      const known = ((session.castPlan && session.castPlan.lavaAt) || []).map(p => new Vec3(p.x, p.y, p.z))
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      for (const k of known.slice(0, 3)) {
        if (ctl.aborted) break
        // Подойти к месту вычерпанной лавы — на клетку, где можно стоять (не над окном и не над озером).
        // Сперва клетки, откуда эта лава видна черпаку (у края окна), — иначе ближняя к телу клетка в 3 бл. от окна
        // смотрит на лаву под острым углом сквозь пол штрека: «дошёл, видно 0» и окна множатся (ow-M2, все «under»).
        let wk = false
        const sp0 = standSpots(bot, k).map(x => x.S)
        for (const sp of (sp0.length ? sp0 : standNear(bot, k)).slice(0, 3)) { if (await walk(bot, ctl, new goals.GoalBlock(sp.x, sp.y, sp.z), 15000)) { wk = true; break } }
        src = scoopableSources(bot, [k, ...known.slice(0, 6)])
        tr(`к ${k.x},${k.y},${k.z}: ${wk ? 'дошёл' : `НЕ дошёл (${lastWalkError || '?'})`}, видно ${src.length}`)
        // Глубоко: озеро под потолком — видимые через окно источники вычерпаны, рядом под тем же потолком есть
        // ещё. Новое окно над соседним источником (той же проверкой безопасности).
        if (!src.length && session.castPlan && session.castPlan.windows && await openWindow(session, ctl, k, report)) {
          src = scoopableSources(bot, [k, ...known.slice(0, 6)])
          // Новое окно не видно с этой клетки — встать туда, откуда черпак достаёт его лаву.
          const lw = report.lastWindow
          if (!src.length && lw) {
            for (const sp of standSpots(bot, lw).slice(0, 2)) { if (await walk(bot, ctl, new goals.GoalBlock(sp.S.x, sp.S.y, sp.S.z), 15000)) break }
            src = scoopableSources(bot, [lw, k, ...known.slice(0, 6)])
          }
          tr(`окно у ${k.x},${k.y},${k.z}: видно ${src.length}`)
        }
        if (src.length) break
      }
      // У края всё вычерпано — шаг над озером по заложенному окну и окна дальше.
      if (!src.length && session.castPlan && session.castPlan.windows) {
        const w = await advanceOver(session, ctl, report)
        if (w) {
          src = scoopableSources(bot, [w.offset(0, -1, 0), ...known.slice(0, 6)])
          if (!src.length && await openWindow(session, ctl, w.offset(0, -1, 0), report)) src = scoopableSources(bot, [w.offset(0, -1, 0), report.lastWindow || w, ...known.slice(0, 6)])
          tr(`шаг над озером на ${w.x},${w.y},${w.z}: видно ${src.length}`)
        } else tr('шаг над озером не вышел')
      }
    }
    // Всё видимое у плана вычерпано, а озеро живое: план знал только 12 источников, увиденных при выборе места
    // (07 §9.5: «лава кончилась» при 50+ открытых источниках того же тела). Обойти тело лавы от известных клеток по
    // связности и взять ближние к раме открытые источники, у которых есть где встать.
    if (!src.length && !refreshed && session.castPlan) {
      refreshed = true
      const seeds = ((session.castPlan.lavaAt) || []).map(p => new Vec3(p.x, p.y, p.z))
      const live = liveLava(bot, seeds, geomOf(session.castPlan).at(0, 0))
      tr(`живая лава тела: ${live.length}`)
      if (live.length) {
        session.castPlan.lavaAt = live.map(p => xyz(p))
        try { session.journal.patch(st => { const pl = st.places && st.places[PLACE]; if (pl) pl.lavaAt = session.castPlan.lavaAt }) } catch {}
        continue
      }
    }
    if (!src.length) break
    let got = false
    for (const s of src.slice(0, 5)) {
      const p = s.position
      if (!scoopAim(bot, p)) {
        const spots = standSpots(bot, p)
        if (!spots.length) { tr(`${p.x},${p.y},${p.z}: встать негде`); continue }
        let reached = false
        for (const sp of spots.slice(0, 3)) {
          if (await walk(bot, ctl, new goals.GoalBlock(sp.S.x, sp.S.y, sp.S.z), 15000)) { reached = true; break }
        }
        if (!reached) { tr(`${p.x},${p.y},${p.z}: не дошёл (${lastWalkError || '?'})`); continue }
      }
      const sc = await scoop(bot, p, 'lava')
      tr(`${p.x},${p.y},${p.z}: черпак ${sc ? 'да' : 'нет'}${sc ? '' : ` (прицел ${scoopAim(bot, p) ? 'есть' : 'нет'}, ${(bot.blockAt(p) || {}).name})`}`)
      if (sc) {
        got = true; report.refills++; want--
        // Вычерпанная клетка — ориентир следующего окна: соседние источники того же озера рядом с ней.
        if (session.castPlan && Array.isArray(session.castPlan.lavaAt)) session.castPlan.lavaAt.unshift(xyz(p))
        break
      }
    }
    if (!got) break
  }
  return countOf(bot, 'lava_bucket') > 0
}

// Открытые источники того же тела лавы (6-связность от известных клеток ±2), ближние к ref, у которых есть где встать
// с черпаком (standSpots). Только чтение мира — что видно, решает scoopableSources у самого черпака.
export function liveLava (bot, seeds, ref, { limit = 12, cap = 1500 }: any = {}) {
  const key = p => `${p.x},${p.y},${p.z}`
  const seen = new Set()
  const q = []
  for (const s of seeds) {
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) {
      const p = s.offset(dx, dy, dz)
      const b = bot.blockAt(p)
      if (b && b.name === 'lava' && !seen.has(key(p))) { seen.add(key(p)); q.push(p) }
    }
  }
  const open = []
  const DOWN = new Vec3(0, -1, 0)
  for (let i = 0; i < q.length && seen.size < cap; i++) {
    const p = q[i]
    const b = bot.blockAt(p)
    if (b && levelOf(b) === 0 && isAir(bot.blockAt(p.plus(UP))) &&
        (process.env.ND_OW_KIT_FRAME === '0' || (require('../sight') as typeof import('../sight')).seesBlock(bot, b))) open.push(p)
    for (const v of [...SIDES4, UP, DOWN]) {
      const n = p.plus(v)
      if (seen.has(key(n))) continue
      const nb = bot.blockAt(n)
      if (nb && nb.name === 'lava') { seen.add(key(n)); q.push(n) }
    }
  }
  open.sort((a, b) => a.distanceTo(ref) - b.distanceTo(ref))
  const out = []
  for (const p of open.slice(0, 48)) {
    if (standSpots(bot, p).length) out.push(p)
    if (out.length >= limit) break
  }
  return out
}

export async function ensureWater (session, ctl) {
  const bot = session.bot
  if (countOf(bot, 'water_bucket')) return true
  if (!countOf(bot, 'bucket')) return false
  const r = await (require('../obsidian') as typeof import('../obsidian')).fillBucket(session, ctl, { fluid: 'water', radius: 32 })
  return !!(r && (r.filled || r.already))
}

// Слезть со своего столба: копать блок под ногами, пока ноги не на земле.
export async function descend (bot, ctl, groundY, report) {
  for (let k = 0; k < 8 && !ctl.aborted; k++) {
    const feet = feetCell(bot)
    if (feet.y <= groundY) return true
    const under = bot.blockAt(feet.offset(0, -1, 0))
    if (!under || under.boundingBox !== 'block') { await sleep(300); continue }
    try {
      await equipBestTool(bot, under)
      await digVisible(bot, under, 6000)
      report.dug++
    } catch { return false }
    await sleep(450)
  }
  return feetCell(bot).y <= groundY
}

// Ноги и голова не в воде (остатки вычерпанной), до 3 с.
export async function dryFeet (bot, ctl, ms = 3000) {
  const wet = () => {
    const f = feetCell(bot)
    return [f, f.offset(0, 1, 0)].some(p => { const b = bot.blockAt(p); return !!b && /water|bubble_column/.test(b.name) }) || !!bot.entity.isInWater
  }
  const t0 = gameClock.now()
  while (wet() && gameClock.now() - t0 < ms && !ctl.aborted) await sleep(100)
  return !wet()
}

// Встать: h = -1 — на землю в клетку F(col,-1); h >= 0 — на столб в колонке
// col, ноги в F(col,h).
export async function stand (session, ctl, g, col, h, report) {
  const bot = session.bot
  const groundY = g.F(0, -1).y
  const base = g.F(col, -1)
  let feet = feetCell(bot)
  const onColumn = feet.x === base.x && feet.z === base.z
  // Копать вниз — только со СВОЕГО столба (ряд перед рамой): стоя на холме
  // рядом, тело прокопало бы себе яму.
  const onOwnPillar = [-1, 0, 1, 2].some(i => { const c = g.F(i, -1); return feet.x === c.x && feet.z === c.z }) && feet.y > groundY
  if (!onColumn && onOwnPillar) {
    if (!(await descend(bot, ctl, groundY, report))) return { ok: false, why: 'не слез со столба' }
    feet = feetCell(bot)
  }
  if (onColumn && feet.y > g.F(col, h).y) {
    // Столб выше, чем надо: копать вниз до нужной высоты.
    if (!(await descend(bot, ctl, g.F(col, h).y, report))) return { ok: false, why: 'не спустился по столбу' }
    feet = feetCell(bot)
  }
  if (!(feet.x === base.x && feet.z === base.z)) {
    const ok = (await walk(bot, ctl, new goals.GoalBlock(base.x, base.y, base.z), 20000)) ||
      (await walk(bot, ctl, new goals.GoalBlock(base.x, base.y, base.z), 20000, { clearance: true }))
    feet = feetCell(bot)
    if (!ok || !feet.equals(base)) return { ok: false, why: `не встал на ${base.x},${base.y},${base.z}` }
  }
  if (!(await centreOn(bot, ctl, feetCell(bot)))) return { ok: false, why: 'не центрировался перед литьём' }
  const need = g.F(col, h).y - feetCell(bot).y
  if (need > 0) {
    // По ступени: над головой должно быть пусто (towerUp иначе «потолок»), а клетку над головой с пола не всегда
    // достать — копается здесь, со столба, перед каждым прыжком.
    const whyAll = []
    for (let k = 0; k < need && !ctl.aborted; k++) {
      // В текущей воде прыжок — всплытие на 0.1–0.4 блока, столб не растёт (ow-L2 02.10, слот 8: 7/10 отлито,
      // «не подпрыгнул (+0.18)»): вычерпанная вода стекает остатками ещё до 35 тиков (Codex, WaterFluid). Ждать сухости.
      await dryFeet(bot, ctl)
      const head = bot.blockAt(feetCell(bot).offset(0, 2, 0))
      if (head && head.boundingBox === 'block' && !/lava|water/.test(head.name) && !PROTECTED.test(head.name)) {
        const risk = digRisk(p => bot.blockAt(p), head.position)
        if (risk) return { ok: false, why: `потолок: ${risk}` }
        try { await equipBestTool(bot, head); await digVisible(bot, head, 8000); report.dug++ } catch {}
      }
      let t = await towerUp(bot, ctl, 1, { sneak: true })
      if (!t.placed && !ctl.aborted) { if (t.why) whyAll.push(...t.why); t = await towerUp(bot, ctl, 1, { sneak: true }) }
      report.placed += t.placed || 0
      if (t.why && t.why.length) whyAll.push(...t.why)
      if (!t.placed) break
    }
    if (feetCell(bot).y !== g.F(col, h).y) return { ok: false, why: `столб не вырос (${whyAll.join('; ') || '?'})` }
    if (!(await centreOn(bot, ctl, feetCell(bot)))) return { ok: false, why: 'не центрировался на столбе' }
  }
  return { ok: true }
}
