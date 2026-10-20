'use strict'
// Окоп (huntFoxhole) — место под окоп, постройка, вход и выход. Сама охота — pearls/foxhole.ts и соседние части.
import * as gameClock from '../../game-clock'
import { sleep } from '../../movement'
import { HOLDABLE, ents, walkTo, CARDINAL, digCell, hazardNear, stepInto, solidAt, diggable } from '../common'

// ------------------------------------------------------------ окоп
// Окоп под крышей (style: 'foxhole'). Сверка с байткодом paper-1.21.11
// (2026-09-29): эндермен бьёт, только если (1) его коробка, раздутая на 0.828
// ТОЛЬКО по горизонтали (Mob.getAttackBoundingBox → inflate(r, 0, r)),
// пересекает нашу и (2) луч от его глаз (2.55) к нашим глазам чист по COLLIDER
// (MeleeAttackGoal.canPerformAttack → Sensing.hasLineOfSight →
// LivingEntity.hasLineOfSight(target, COLLIDER, NONE, target.eyeY)).
// Мы — в яме глубиной 1 (ноги на 1 ниже земли), над ямой крыша на +1 от земли
// (потолок в 2 блока над нашими ногами). Эндермен на земле рядом: коробка
// достаёт, но луч «глаза → глаза» (2.55 → 0.62 над землёй) пересекает y = +1
// внутри клетки ямы — в крыше. Перебор его позиций вокруг с шагом 0.05
// (scratch foxhole.js): 0 опасных при ровной земле; опасна только соседняя
// клетка НИЖЕ земли (его ноги на нашем уровне, луч проходит под крышей) —
// такое место не берём. Наш меч достаёт его ноги сквозь щель между землёй и
// крышей (луч на высоте ~0.6), в клетку ямы он не влезает (2.9 > 2), на крыше
// стоит выше нас (коробка удара вниз не растёт). Злим взглядом издали (от 5
// блоков: ближе 4 взгляд в глаза телепортирует его — EndermanLookForPlayerGoal),
// глаза ближних закрывает та же крыша, а удар мечом (живой обидчик) телепорта не
// вызывает (EnderMan.hurtServer). Выпавший рядом жемчуг подбирается из ямы сам
// (подбор — коробка тела +1 по горизонтали).
function foxSite (bot, mcData, P, why = null) {
  const no = r => { if (why) why[r] = (why[r] || 0) + 1; return null }
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
  const solid = q => solidAt(bot, q)
  const H = P.offset(0, -1, 0)
  const R = P.offset(0, 1, 0)
  if (!air(P) || !air(R) || !solid(H) || !solid(H.offset(0, -1, 0))) return no('клетка')
  if (!diggable(bot, mcData, H)) return no('не копается')
  const hb = bot.blockAt(H)
  if (hb && /magma|soul_sand|soul_soil|powder_snow|gravel|sand$/.test(hb.name)) return no('пол')
  // Стенки ямы — 4 соседа на уровне ног; вокруг — ровно: у каждого из 8 соседей
  // пол на уровне земли или сам сосед — стена (ниже земли — опасная клетка).
  // Ямку у соседа (пол ниже земли, сама клетка пола — воздух) засыпаем блоком,
  // до 4 штук: «ровного места нет» было главной причиной простоя (ферма 29.09,
  // foxhole-5: из 9 переездов 6 — «мест нет»).
  const fills = []
  const addFill = F => { if (!fills.some(f => f.equals(F))) fills.push(F) }
  for (const [dx, dz] of CARDINAL) {
    const W = H.offset(dx, 0, dz)
    if (solid(W)) continue
    if (!air(W)) return no('стенки ямы')
    addFill(W)
  }
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      const N = P.offset(dx, 0, dz)
      if (solid(N)) continue
      const F = N.offset(0, -1, 0)
      if (solid(F)) continue
      if (!air(F)) return no('сосед ниже')
      addFill(F)
    }
  }
  if (fills.length > 4) return no('ровнять много')
  const solidOrFill = q => solid(q) || fills.some(f => f.equals(q))
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -3; dy <= 2; dy++) {
    const b = bot.blockAt(P.offset(dx, dy, dz))
    if (b && /lava|water/.test(b.name)) return no('жидкость')
  }
  // Опора крыши: готовый твёрдый сосед у R — или стенка A (земля) + A2 (на ней).
  let dir = null
  let needProp = true
  for (const [dx, dz] of CARDINAL) if (solid(R.offset(dx, 0, dz))) { dir = [dx, dz]; needProp = false; break }
  if (needProp && solid(R.offset(0, 1, 0))) needProp = false
  if (needProp) {
    for (const [dx, dz] of CARDINAL) {
      const A = P.offset(dx, 0, dz)
      if ((air(A) || solid(A)) && (air(A.offset(0, 1, 0)) || solid(A.offset(0, 1, 0)))) { dir = [dx, dz]; break }
    }
    if (!dir) return no('опора')
  }
  // Выход — сосед на земле с другой стороны (две клетки воздуха, пол).
  let out = null
  for (const [dx, dz] of CARDINAL) {
    if (dir && dx === dir[0] && dz === dir[1]) continue
    const N = P.offset(dx, 0, dz)
    if (air(N) && air(N.offset(0, 1, 0)) && solidOrFill(N.offset(0, -1, 0))) { out = N; break }
  }
  if (!out) return no('выход')
  const A = dir ? P.offset(dir[0], 0, dir[1]) : null
  return { P, H, R, A, A2: A ? A.offset(0, 1, 0) : null, needProp, out, dir, fills }
}

// Уже сидим в окопе (прошлый вызов): над головой +1 воздух, +2 крыша, стенки.
function foxHere (bot, mcData) {
  const F = bot.entity.position.floored()
  const air = q => { const b = bot.blockAt(q); return !!b && b.boundingBox === 'empty' && !/lava|water|fire/.test(b.name) }
  if (!solidAt(bot, F.offset(0, 2, 0)) || !air(F.offset(0, 1, 0)) || !air(F)) return null
  for (const [dx, dz] of CARDINAL) if (!solidAt(bot, F.offset(dx, 0, dz))) return null
  const P = F.offset(0, 1, 0)
  let out = null
  for (const [dx, dz] of CARDINAL) {
    const N = P.offset(dx, 0, dz)
    if (air(N) && air(N.offset(0, 1, 0)) && solidAt(bot, N.offset(0, -1, 0))) { out = N; break }
  }
  if (!out) return null
  return { P, H: F, R: F.offset(0, 2, 0), out, reused: true }
}

async function foxDropIn (bot, fox) {
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 2500 && !bot.entity.position.floored().equals(fox.H)) {
      await bot.lookAt(fox.P.offset(0.5, 0.2, 0.5), true)
      bot.setControlState('forward', bot.entity.position.floored().y > fox.H.y)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false) }
  try { await (require('../../fortify') as typeof import('../../fortify')).centerInCell(bot, 500) } catch {}
  return bot.entity.position.floored().equals(fox.H)
}

async function foxRoof (bot, fox) {
  const { placeBlockAt }: typeof import('../../build') = require('../../build')
  let r = null
  for (let k = 0; k < 3 && !(r && r.ok); k++) r = await placeBlockAt(bot, fox.R, { timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
  return solidAt(bot, fox.R) ? { ok: true } : { ok: false, why: `крыша не встала: ${r ? r.reason : '?'}` }
}

async function foxBuild (bot, ctl, mcData, site, danger = null) {
  const { placeBlockAt }: typeof import('../../build') = require('../../build')
  const fortify: typeof import('../../fortify') = require('../../fortify')
  // Сами под потолком в яме (старый окоп прошлого вызова, пол ниже земли) —
  // потолок долой, иначе прыжок из ямы упирается в него: pathfinder «stuck»
  // (ферма 29.09, foxhole-4: «до места окопа не дошёл» с 50,53,19).
  {
    const F = bot.entity.position.floored()
    const up = F.offset(0, 2, 0)
    if (!F.equals(site.P) && solidAt(bot, up) && !hazardNear(bot, up) && solidAt(bot, F.offset(0, -1, 0))) await digCell(bot, mcData, up)
  }
  if (!bot.entity.position.floored().equals(site.P)) await walkTo(bot, ctl, site.P, 0, 12000)
  if (!bot.entity.position.floored().equals(site.P) && bot.entity.position.distanceTo(site.P.offset(0.5, 0, 0.5)) < 3) await stepInto(bot, site.P)
  if (!bot.entity.position.floored().equals(site.P)) return { ok: false, why: 'до места окопа не дошёл' }
  let placed = 0
  // В середину клетки ДО опоры: край тела в клетке опоры — «ответа от сервера
  // нет» (ферма 29.09, pearls-foxhole-3: 2 окопа из 9 не встали так).
  try { await fortify.centerInCell(bot, 700) } catch {}
  // Эндермен в клетке засыпки, опоры или крыши — не строить здесь: блок не встанет,
  // а возня у самых его ног кончалась боем в открытую (foxhole-11, слот 8: смерть
  // после «ямку не засыпал: в клетке стоит enderman»).
  const busyCell = c => ents(bot).some((e : any) => e && e.name === 'enderman' && e.position &&
    Math.abs(e.position.x - (c.x + 0.5)) < 0.9 && Math.abs(e.position.z - (c.z + 0.5)) < 0.9 && e.position.y < c.y + 1 && e.position.y + 2.9 > c.y)
  for (const c of [...(site.fills || []), site.A, site.A2, site.R].filter(Boolean)) if (!solidAt(bot, c) && busyCell(c)) return { ok: false, why: 'в клетке эндермен' }
  for (const c of site.fills || []) {
    if (danger && danger()) return { ok: false, why: 'злой рядом' }
    if (solidAt(bot, c)) continue
    let r = null
    for (let k = 0; k < 2 && !(r && r.ok); k++) r = await placeBlockAt(bot, c, { timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
    if (!solidAt(bot, c)) return { ok: false, why: `ямку у окопа не засыпал: ${r ? r.reason : '?'}` }
    placed++
  }
  if (site.needProp) {
    for (const c of [site.A, site.A2]) {
      if (danger && danger()) return { ok: false, why: 'злой рядом' }
      if (solidAt(bot, c)) continue
      let r = null
      for (let k = 0; k < 2 && !(r && r.ok); k++) r = await placeBlockAt(bot, c, { timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
      if (!solidAt(bot, c)) return { ok: false, why: `опора крыши не встала: ${r ? r.reason : '?'}` }
      placed++
    }
  }
  try { await fortify.centerInCell(bot, 700) } catch {}
  const e = await digCell(bot, mcData, site.H)
  if (e) return { ok: false, why: `яма не копается: ${e}` }
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1500 && !bot.entity.position.floored().equals(site.H)) await sleep(50)
  if (!bot.entity.position.floored().equals(site.H) && !(await foxDropIn(bot, site))) return { ok: false, why: 'в яму не спустился' }
  try { await fortify.centerInCell(bot, 500) } catch {}
  // Стенки ямы из того, что эндермен уносит (#enderman_holdable: нилий, земля,
  // гравий…), — заменить незераком/булыжником: вынутая стенка открывает сбоку
  // клетку на нашем уровне, и луч к нам проходит под крышей (foxhole-13, слот 15:
  // в яме 6 ударов по нам и смерть). Своя стенка — копать и ставить обратно.
  let swapped = 0
  for (const [dx, dz] of CARDINAL) {
    const W = site.H.offset(dx, 0, dz)
    const wb = bot.blockAt(W)
    if (!wb || !HOLDABLE.test(wb.name)) continue
    if (danger && danger()) break
    const e = await digCell(bot, mcData, W)
    if (e) continue
    let r = null
    for (let k = 0; k < 2 && !(r && r.ok); k++) r = await placeBlockAt(bot, W, { timeoutMs: 1500 }).catch(err => ({ ok: false, reason: err.message }))
    if (solidAt(bot, W)) swapped++
    else return { ok: false, why: `стенку ямы не вернул: ${r ? r.reason : '?'}` }
  }
  const roof = await foxRoof(bot, site)
  if (!roof.ok) return { ok: false, why: roof.why }
  return { ok: true, placed: placed + 1 + swapped, swapped }
}

// Из ямы на землю к выходу — прыжком вперёд сами. Pathfinder из ямы глубиной 1
// отвечал «goal_reached» или «stuck», а тело так и стояло на дне (ферма 29.09,
// foxhole-4: новое место не искалось — заливка из ямы не выходила наружу).
async function leaveFoxhole (bot, fox) {
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 1800 && bot.entity.position.floored().y < fox.P.y) {
      await bot.lookAt(fox.out.offset(0.5, 1.6, 0.5), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
  await sleep(150)
  return bot.entity.position.floored().y >= fox.P.y
}

async function foxExit (bot, ctl, mcData, fox) {
  if (bot.entity.position.floored().y >= fox.P.y) return true
  if (solidAt(bot, fox.R)) { const e = await digCell(bot, mcData, fox.R); if (e) return false }
  await sleep(150)
  if (await leaveFoxhole(bot, fox)) return true
  await walkTo(bot, ctl, fox.out, 0, 4000)
  return bot.entity.position.floored().y >= fox.P.y
}

async function foxEnter (bot, ctl, fox) {
  if (!bot.entity.position.floored().equals(fox.H)) {
    if (bot.entity.position.distanceTo(fox.P.offset(0.5, 0, 0.5)) > 1.6) await walkTo(bot, ctl, fox.out, 0, 8000)
    if (!(await foxDropIn(bot, fox))) return false
  }
  if (!solidAt(bot, fox.R)) return (await foxRoof(bot, fox)).ok
  return true
}

export { foxSite, foxHere, foxBuild, foxExit, foxEnter }
