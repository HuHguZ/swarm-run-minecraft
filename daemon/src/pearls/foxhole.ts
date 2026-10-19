'use strict'
import * as gameClock from '../game-clock'
import { sleep, xyz } from '../movement'
import { countOf, bestWeapon } from '../items'
import {
  SWING_MS, POKE_R, HOLDABLE, FOX_AVOID, clamp, log, meta, ents, walkTo, pickUp, CARDINAL, digCell, hazardNear,
  stepInto, solidAt, diggable
} from './common'
import { clearRay, eyesSeen, safeAim, reachTo, lavaAround, openFight } from './aim'
import { trappedEm, endermanReach } from './shelter'

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
  try { await (require('../fortify') as typeof import('../fortify')).centerInCell(bot, 500) } catch {}
  return bot.entity.position.floored().equals(fox.H)
}

async function foxRoof (bot, fox) {
  const { placeBlockAt }: typeof import('../build') = require('../build')
  let r = null
  for (let k = 0; k < 3 && !(r && r.ok); k++) r = await placeBlockAt(bot, fox.R, { timeoutMs: 1500 }).catch(e => ({ ok: false, reason: e.message }))
  return solidAt(bot, fox.R) ? { ok: true } : { ok: false, why: `крыша не встала: ${r ? r.reason : '?'}` }
}

async function foxBuild (bot, ctl, mcData, site, danger = null) {
  const { placeBlockAt }: typeof import('../build') = require('../build')
  const fortify: typeof import('../fortify') = require('../fortify')
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

async function huntFoxhole (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 30, 600) * 1000 - 4000
  const pearls0 = countOf(bot, 'ender_pearl')
  const want = pearls0 + Math.max(1, p.count ?? 4)
  const hp0 = Math.round(bot.health ?? 20)
  const rounds = []
  const dead = new Set()
  const hurtAt = new Map()
  const onHurt = e => { if (e && e.name === 'enderman') hurtAt.set(e.id, gameClock.now()) }
  const onDead = (e, how) => {
    if (!e || e.name !== 'enderman' || !e.position || e.position.distanceTo(bot.entity.position) > 12) return
    if (how === 'gone' && !(gameClock.now() - (hurtAt.get(e.id) || 0) < 3000)) return
    dead.add(e.id)
  }
  const onGone = e => onDead(e, 'gone')
  // Взгляд вниз всегда, кроме нарочного взгляда в глаза выбранному (как в дуэли).
  let pitchCap = -0.35
  const capPitch = () => { if (pitchCap !== null && bot.entity && bot.entity.pitch > pitchCap) bot.entity.pitch = pitchCap }
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  bot.on('entityGone', onGone)
  bot.on('physicsTick', capPitch)
  let stopped = null
  let fox = null
  let kills = 0
  let aggros = 0
  let stares = 0
  let peeks = 0
  let moves = 0
  let hits = 0
  let hitsOnMe = 0
  const skip = new Map()
  const angrySince = new Map()
  // Кто был злым последние 45 с: злость эндермена (NeutralMob) живёт 20–39 с и
  // после того, как метка «злой» снята (цель потеряна без луча за 3 с), — увидит
  // нас снова и сразу бьёт. Таких не подкрадываться и из ямы при них не выходить.
  const recentAngry = new Map()
  const hot = e => angry(e) || gameClock.now() - (recentAngry.get(e.id) || 0) < 45000
  const ignore = new Map()
  const weapon = bestWeapon(bot)
  const isPearl = e => { try { const it = e.getDroppedItem && e.getDroppedItem(); return !!it && it.name === 'ender_pearl' } catch { return false } }
  const endermen = () => ents(bot).filter((e : any) => e && e.name === 'enderman' && e.position && e.isValid !== false && !dead.has(e.id))
  const skipped = e => (skip.get(e.id) || 0) > gameClock.now()
  const ignored = e => (ignore.get(e.id) || 0) > gameClock.now()
  const angry = e => !!meta(bot, e, 'creepy')
  const pending = () => endermen().filter((e : any) => angry(e) && !ignored(e) && e.position.distanceTo(bot.entity.position) < 40)
  let reach = null
  const canCome = e => e.position.distanceTo(bot.entity.position) > 16 || !reach || reach.has(`${Math.floor(e.position.x)},${Math.floor(e.position.y)},${Math.floor(e.position.z)}`)
  const onMeHurt = victim => { if (victim === bot.entity) hitsOnMe++ }
  bot.on('entityHurt', onMeHurt)
  const inHole = () => fox && bot.entity.position.floored().equals(fox.H) && solidAt(bot, fox.R)
  const stare = async (target, ms) => {
    stares++
    pitchCap = null
    const tS = gameClock.now()
    try {
      while (!ctl.aborted && gameClock.now() - tS < ms && !angry(target) && target.isValid !== false && bot.entities[target.id]) {
        if (target.position.distanceTo(bot.entity.position) < 5) break
        if (eyesSeen(bot, target)) await bot.lookAt(target.position.offset(0, 2.55, 0), true).catch(() => {})
        await sleep(100)
      }
    } finally {
      pitchCap = -0.35
      try { await bot.look(bot.entity.yaw, -0.5, true) } catch {}
    }
    const ok = angry(target)
    if (ok) aggros++
    else skip.set(target.id, gameClock.now() + 30000)
    return ok
  }
  const starePool = (maxD = 24) => {
    const me = bot.entity.position
    return endermen().filter(e => !skipped(e) && !angry(e) && !trappedEm(bot, e))
      .filter((e : any) => { const d = e.position.distanceTo(me); return d >= 5 && d <= maxD })
      .filter(e => canCome(e) && eyesSeen(bot, e))
      .sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))
  }
  // Места: bad — не построилось (исключаем саму клетку), used — ушли, потому
  // что рядом некого злить (исключаем 8 блоков вокруг). Раньше любое прошлое
  // место, даже не дошли, закрывало 10 блоков, и следующее выходило за 30–44
  // шага — pathfinder туда в лесу не доходил (ферма 29.09, foxhole-3: «до места
  // окопа не дошёл» 5 раз из 9).
  const bad = []
  const used = []
  // opts.near — окоп вплотную к этому месту (подкрасться к спокойному: из ямы
  // достать его мечом, и злой уже не бьёт — луча нет).
  const newSite = async (opts: any = {}) => {
    const { walkable }: typeof import('../walkable') = require('../walkable')
    const ems = endermen().filter(e => !trappedEm(bot, e))
    const cands = []
    let checked = 0
    let nodes = 0
    const rej = {}
    // Из ямы заливка наружу не выходит (прыжок упирается в крышу) — от выхода.
    // Только если стоим на дне этой самой ямы: после «к эндерменам» тело ниже
    // старой ямы, но далеко от неё — заливка от старого выхода давала 0 клеток.
    const from = fox && bot.entity.position.floored().equals(fox.H) ? fox.out : bot.entity.position
    let list = walkable(bot, from, { radius: 24, maxNodes: 4000 })
    if (list.length < 5 && from !== bot.entity.position) list = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 4000 })
    // Сидим в яме (чужая нора, старый окоп, провал): заливка — 1–2 клетки, мест нет
    // (foxhole-9, слоты 1 и 5: «мест нет, nodes 0–1»). Подняться столбом на 2 и снова.
    if (list.length < 5) {
      try { await (require('../build') as typeof import('../build')).towerUp(bot, ctl, 2) } catch {}
      list = walkable(bot, bot.entity.position, { radius: 24, maxNodes: 4000 })
    }
    for (const n of list) {
      if (bad.some(s => s.distanceTo(n.pos) < 1.5) || used.some(s => s.distanceTo(n.pos) < 1.5)) continue
      if (opts.near && (Math.hypot(n.pos.x + 0.5 - opts.near.x, n.pos.z + 0.5 - opts.near.z) > 2.6 || Math.hypot(n.pos.x + 0.5 - opts.near.x, n.pos.z + 0.5 - opts.near.z) < 1.2 || Math.abs(n.pos.y - Math.floor(opts.near.y)) > 1)) continue
      nodes++
      const site = foxSite(bot, mcData, n.pos, rej)
      if (!site) continue
      if (++checked > 250) break
      const eye = n.pos.offset(0.5, 0.62, 0.5)
      let seen = 0
      let around = 0
      let near = 0
      for (const e of (ems as any)) {
        const d = e.position.distanceTo(eye)
        if (d > 5 && d <= 24) { around++; if (clearRay(bot, eye, e.position.offset(0, 2.55, 0))) seen++ }
        if (d <= POKE_R) near++
      }
      // Рядом (до POKE_R) — под удар-вызов: глаз в лесу почти не видно. Близкое
      // к телу место дороже дальнего: дальние pathfinder в лесу часто не находил.
      // Рядом со старым местом (там уже звать некого) — дешевле, но не запрет: в
      // холмах заливка короткая, и запрет 8 блоков оставлял «мест нет» (слот 1).
      const stale = used.some(s => s.distanceTo(n.pos) < 8) ? 8 : 0
      const score = seen * 6 + near * 3 + around - n.d * 0.8 - (site.needProp ? 1 : 0) - site.fills.length * 0.7 - stale
      cands.push({ site, score, seen, around, near, steps: n.d })
    }
    if (!cands.length) { log('окоп: мест нет', { nodes, rej, at: xyz(bot.entity.position.floored()) }); return { ok: false, why: 'ровного места под окоп (яма 1x1, пол вокруг на уровне, без лавы) рядом нет', checked, nodes } }
    cands.sort((a, c) => c.score - a.score)
    let last = null
    for (const c of cands.slice(0, 3)) {
      if (ctl.aborted) break
      log('место окопа', { at: xyz(c.site.P), seen: c.seen, near: c.near, around: c.around, steps: c.steps, prop: c.site.needProp, checked })
      const b = await foxBuild(bot, ctl, mcData, c.site, () => endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 5))
      if (b.ok) {
        try { reach = endermanReach(bot, c.site.out, { radius: 28 }) } catch { reach = null }
        return { ok: true, fox: c.site, placed: b.placed }
      }
      bad.push(c.site.P)
      last = b
      log('окоп не встал', { at: xyz(c.site.P), why: b.why })
      // Злой уже рядом — не бродить по местам, бой решит основной цикл.
      if (endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 8)) break
    }
    return last || { ok: false, why: 'окоп не построился' }
  }
  let lastChance = gameClock.now()
  let lastPeek = gameClock.now()
  let lastPoke = 0
  let pokes = 0
  let lastNear = gameClock.now()
  let lastReach = gameClock.now()
  let stalks = 0
  let openFights = 0
  const avoid0 = bot._ndMobAvoidOnly
  bot._ndMobAvoidOnly = FOX_AVOID
  // Злой уже в 5 блоках, а мы не в яме (вышли за жемчугом, не вернулись) —
  // бой на месте со щитом (как дуэль), а не поиск места под окоп у него под рукой.
  const fightOpen = async () => {
    const me = bot.entity.position
    const em: any = endermen().filter((e : any) => angry(e) && !ignored(e) && e.position.distanceTo(me) < 5).sort((a: any, c: any) => a.position.distanceTo(me) - c.position.distanceTo(me))[0]
    if (!em) return false
    openFights++
    const hpA = bot.health ?? 20
    const f: any = await openFight(session, ctl, em, { retreatAt: 6, dead, maxMs: 30000 }).catch(e => ({ error: e.message }))
    const r: any = { id: em.id, open: true, killed: dead.has(em.id), swings: f && f.swings, hpLost: Math.round((hpA - (bot.health ?? 20)) * 10) / 10 }
    if (r.killed) {
      kills++
      await sleep(1500)
      await pickUp(bot, ctl, 6, 2500)
    }
    r.pearls = countOf(bot, 'ender_pearl')
    // Ни одного взмаха (не достать: выше, за блоком) — не крутиться на нём: 20 с мимо
    // (ферма 29.09, foxhole-8 слот 13: «бой снаружи» с 0 взмахов по кругу).
    if (!r.killed && !(f && f.swings)) ignore.set(em.id, gameClock.now() + 20000)
    rounds.push(r)
    log('окоп: бой снаружи', r)
    return true
  }
  // S1f (проверка S1e (г)): «тело в своём окопе» — для тактики: стрелков вдали (гаст, скелет) окоп держит сам (крыша), охоту не рвать.
  bot._ndInFoxhole = () => !!fox && !!inHole()
  try {
    fox = foxHere(bot, mcData)
    if (fox) { try { reach = endermanReach(bot, fox.out, { radius: 28 }) } catch {} ; log('окоп: уже в нём', { at: xyz(fox.P) }) }
    else {
      const s = await newSite()
      log('окоп', s.ok ? { at: xyz(s.fox.P), placed: s.placed } : s)
      if (!s.ok) stopped = s.why
      else fox = s.fox
    }
    while (fox && !ctl.aborted) {
      if (countOf(bot, 'ender_pearl') >= want) break
      if (gameClock.now() > deadline) { stopped = 'время вышло'; break }
      // Без кирки окоп не копается — выйти, пусть этап сделает запасные (campaign spares).
      if (!bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) { stopped = 'кирка кончилась'; break }
      if (!inHole()) {
        if (await fightOpen()) continue
        const ok = await foxEnter(bot, ctl, fox)
        if (!ok) {
          log('окоп: не вернулся', { at: xyz(bot.entity.position) })
          if (await fightOpen()) continue
          bad.push(fox.P)
          const s = await newSite()
          if (!s.ok) { stopped = `в окоп не вернулся, новый не вышел: ${s.why}`; break }
          fox = s.fox
          moves++
          continue
        }
      }
      // Есть и лечиться — в окопе безопасно.
      if ((bot.food ?? 20) <= 16 || ((bot.health ?? 20) < 16 && (bot.food ?? 20) < 20)) { try { await (require('../actions') as typeof import('../actions')).eat(session, {}) } catch {} }
      const all = endermen()
      for (const e of (all as any)) {
        if (!angry(e)) { angrySince.delete(e.id); continue }
        recentAngry.set(e.id, gameClock.now())
        if (!angrySince.has(e.id)) angrySince.set(e.id, gameClock.now())
        else if (gameClock.now() - angrySince.get(e.id) > 25000 && reachTo(bot, e) > 3.2) ignore.set(e.id, gameClock.now() + 60000)
      }
      // 1. В досягаемости — бить в тело (в глаза не смотреть).
      // Запас 0.2 до 3.0: сервер меряет досягаемость от своей позиции тела, и на краю
      // взмахи не засчитывались (foxhole-11, слот 19: 31 взмах, эндермен жив).
      const zpNear = ents(bot).filter((o : any) => o && o.name === 'zombified_piglin' && o.position && o.position.distanceTo(bot.entity.position) < 8)
      const near: any = all.filter((e : any) => reachTo(bot, e) <= 2.8 && safeAim(bot, e) && !zpNear.some((o : any) => o.position.distanceTo(e.position) < 3)).sort((a, b) => reachTo(bot, a) - reachTo(bot, b))[0]
      if (near) {
        lastReach = gameClock.now()
        if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
        const r: any = { id: near.id, t: Math.round((gameClock.now() - t0) / 1000), swings: 0, angry: angry(near) }
        const hpA = bot.health ?? 20
        const onMe0 = hitsOnMe
        let last = 0
        const tA = gameClock.now()
        let gone = 0
        // Сколько взмахов дошло (его entityHurt) — на ферме бывало 31–37 взмахов без
        // убийства, а он в это время бил нас в яме (foxhole-13, слоты 15 и 19).
        let landed = 0
        const onHit = e => { if (e && e.id === near.id) landed++ }
        bot.on('entityHurt', onHit)
        // Щит между взмахами: яма бережёт от луча, но не от всего (эндермен уносит
        // блоки стенки — нилий #enderman_holdable — и бьёт сбоку).
        const guard = (require('../combat') as typeof import('../combat')).makeShield(session, ctl, { shield: 'ranged' })
        try {
          await guard.wear()
          while (!ctl.aborted && gameClock.now() - tA < 30000 && near.isValid !== false && bot.entities[near.id] && !dead.has(near.id)) {
            const aim = reachTo(bot, near) <= 2.8 ? safeAim(bot, near) : null
            if (!aim) { if (!gone) gone = gameClock.now(); if (gameClock.now() - gone > 6000) break; await sleep(100); continue }
            gone = 0
            try { await bot.lookAt(aim.pt, true) } catch {}
            if (gameClock.now() - last >= SWING_MS) {
              await guard.raise(false)
              if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
              try { bot.attack(near); r.swings++; hits++; last = gameClock.now() } catch {}
            } else if (gameClock.now() - last > 150) await guard.raise(true)
            await sleep(60)
          }
        } finally {
          bot.removeListener('entityHurt', onHit)
          try { await guard.raise(false) } catch {}
          guard.close()
        }
        r.landed = landed
        pitchCap = -0.35
        await sleep(250)
        r.killed = dead.has(near.id)
        r.hpLost = Math.round((hpA - (bot.health ?? 20)) * 10) / 10
        r.hitsOnMe = hitsOnMe - onMe0
        if (r.killed) {
          kills++
          lastChance = gameClock.now()
          const at = near.position.clone()
          await sleep(1500)
          const had = countOf(bot, 'ender_pearl')
          const lying = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) && e.position.distanceTo(at) < 8 && !lavaAround(bot, e.position))
          r.drop = lying.length
          // Не подобралось из ямы само, злых рядом нет — выйти и подобрать.
          if (lying.length && !endermen().some((e : any) => angry(e) && !ignored(e) && e.position.distanceTo(bot.entity.position) < 12)) {
            if (await foxExit(bot, ctl, mcData, fox)) {
              for (const it of (lying as any)) {
                if (!bot.entities[it.id] || ctl.aborted) continue
                // S1e: до 1 бл. по горизонтали, а не «в клетку предмета» (лаборатория s1e-L3: 18 убийств → подобрано 2, «собрал лежащий
                // жемчуг got 0» ×122 — жемчуг на крыше окопа и на наростах, клетка недостижима); коробка подбора (+1 вширь, +0.5 вверх)
                // достаёт его с соседней клетки.
                await walkTo(bot, ctl, it.position, 1, 5000, () => endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 6), true)
                await sleep(300)
              }
              await foxEnter(bot, ctl, fox)
            }
          }
          r.got = countOf(bot, 'ender_pearl') - had
        } else skip.set(near.id, gameClock.now() + 15000)
        r.pearls = countOf(bot, 'ender_pearl')
        rounds.push(r)
        log('окоп: бой', r)
        continue
      }
      // 2. Злые идут — ждать (взгляд вниз).
      const pend = pending()
      if (pend.length) { lastChance = gameClock.now(); lastReach = gameClock.now(); await sleep(400); continue }
      // 3. Злить отсюда: глаза видно из ямы (щель под крышей).
      const pool = starePool()
      if (pool.length) {
        lastChance = gameClock.now()
        await stare(pool[0], 5000)
        continue
      }
      // 4. Глаз не видно и из ямы, и с земли (искажённый лес: на ферме 0 видимых
      // глаз при 4–7 эндерменах в 24 блоках) — удар-вызов ближнего спокойного:
      // выйти, дойти (до POKE_R от ямы), ударить раз и сразу назад под крышу.
      // Удар живого не телепортирует (EnderMan.hurtServer); злой идёт за нами
      // к яме и там уже не достаёт. Соседей у него в 3 блоках нет — взмах мечом
      // задевает соседей и злит и их. Дойти до ямы он должен уметь (reach).
      const hole = fox.P.offset(0.5, 0, 0.5)
      const pool2 = endermen()
      if (pool2.some((e : any) => !trappedEm(bot, e) && e.position.distanceTo(hole) <= POKE_R && canCome(e))) lastNear = gameClock.now()
      if (p.poke === true && gameClock.now() - lastPoke > 6000) {
        const calm: any = pool2.filter((e : any) => !angry(e) && !skipped(e) && !trappedEm(bot, e) && e.position.distanceTo(hole) <= POKE_R &&
          Math.abs(e.position.y - fox.P.y) <= 6 && canCome(e) && !pool2.some((o : any) => o !== e && o.position.distanceTo(e.position) < 3))
          .sort((a: any, c: any) => a.position.distanceTo(hole) - c.position.distanceTo(hole))[0]
        // Раз в 30 с — почему некого звать (кто в POKE_R и что мешает).
        if (!calm && gameClock.now() - (huntFoxhole._why || 0) > 30000) {
          huntFoxhole._why = gameClock.now()
          const why = {}
          const inc = k => { why[k] = (why[k] || 0) + 1 }
          for (const e of (pool2 as any)) {
            if (e.position.distanceTo(hole) > POKE_R) continue
            if (angry(e)) inc('злой')
            else if (skipped(e)) inc('пропуск')
            else if (trappedEm(bot, e)) inc('заперт')
            else if (Math.abs(e.position.y - fox.P.y) > 6) inc('высота')
            else if (!canCome(e)) inc('не дойдёт')
            else inc('сосед')
          }
          if (Object.keys(why).length) log('окоп: звать некого', why)
        }
        if (calm) {
          lastPoke = gameClock.now()
          pokes++
          const pk: any = { id: calm.id, from: Math.round(calm.position.distanceTo(hole)), hit: false }
          const hp1 = bot.health ?? 20
          if (await foxExit(bot, ctl, mcData, fox)) {
            const tP = gameClock.now()
            bot._ndNoMobAvoid = true
            try {
              while (!ctl.aborted && gameClock.now() - tP < 10000 && calm.isValid !== false && bot.entities[calm.id] && !angry(calm)) {
                if (reachTo(bot, calm) <= 2.9) {
                  const a = (require('../pick') as typeof import('../pick')).aim(bot, calm)
                  if (a && a.point) {
                    if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon.name)) { try { await bot.equip(weapon, 'hand') } catch {} }
                    try { await bot.lookAt(calm.position.offset(0, 0.6, 0), true) } catch {}
                    try { bot.attack(calm); pk.hit = true } catch {}
                    break
                  }
                }
                await walkTo(bot, ctl, calm.position.floored(), 1, 1500)
              }
            } finally { bot._ndNoMobAvoid = false }
            // Разозлили — бой тут же, лицом и со щитом (openFight: один на один,
            // двое злых в 6 блоках или мало хп — выход), а не бегом к яме спиной
            // к нему: на ферме злой догонял и бил по дороге (foxhole-9 слот 13:
            // −8.8 хп за обратный путь с 15 блоков, потом смерть у ямы).
            if (pk.hit && angry(calm) && calm.isValid !== false && bot.entities[calm.id]) {
              const f: any = await openFight(session, ctl, calm, { retreatAt: 10, dead, maxMs: 30000 }).catch(e => ({ error: e.message }))
              pk.fight = { killed: dead.has(calm.id), swings: f && f.swings, crowd: f && f.crowd || undefined, stale: f && f.stale || undefined }
              if (pk.fight.killed) {
                kills++
                await sleep(1500)
                await pickUp(bot, ctl, 6, 2500)
              }
            }
            await foxEnter(bot, ctl, fox)
            pk.angry = angry(calm)
            pk.s = Math.round((gameClock.now() - tP) / 1000)
            pk.hpLost = Math.round((hp1 - (bot.health ?? 20)) * 10) / 10
            pk.pearls = countOf(bot, 'ender_pearl')
            log('окоп: удар-вызов', pk)
            if (pk.angry) { aggros++; lastChance = gameClock.now() } else skip.set(calm.id, gameClock.now() + 30000)
          } else log('окоп: удар-вызов — из ямы не вышел', { id: calm.id, at: xyz(bot.entity.position) })
          continue
        }
      }
      // 5. Выглянуть: крышу долой, на землю, злить взглядом до двух с полного
      // роста, и сразу назад под крышу. Раз в 45 с: на ферме с земли глаза
      // видно редко (выглядывал 30+ раз — «seen 0»), а каждый выход — риск.
      // Злой рядом (даже «забытый» — застрял или 25 с не подходил) — из ямы не
      // выходить: он и выйдет нам навстречу. Злость эндермена гаснет за 20–39 с
      // (NeutralMob, PERSISTENT_ANGER_TIME). foxhole-11, слот 19: выход к новому
      // месту при злом рядом — 16 → 2 хп и смерть.
      if (endermen().some((e : any) => hot(e) && !trappedEm(bot, e) && e.position.distanceTo(bot.entity.position) < 20)) { await sleep(700); continue }
      // Выглядывать — только по просьбе (peek: true): глаз с земли в лесу почти не видно
      // (ферма: «seen 0» в 30+ выглядываниях), а каждый выход — копка крыши и износ кирки.
      if (p.peek === true && gameClock.now() - lastPeek > 45000) {
        lastPeek = gameClock.now()
        peeks++
        if (await foxExit(bot, ctl, mcData, fox)) {
          const out = starePool(28)
          let n = 0
          for (const t of out.slice(0, 4)) {
            if (n >= 2 || ctl.aborted) break
            if (endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 10)) break
            if (await stare(t, 4000)) n++
          }
          if (out.length) lastChance = gameClock.now()
          await foxEnter(bot, ctl, fox)
          log('окоп: выглянул', { seen: out.length, angered: n })
        }
        continue
      }
      // 6. Подкрасться: в досягаемости из ямы никого 5 с — к ближнему спокойному
      // (до 40 блоков), окоп вплотную к нему (1.2–2.6 блока), и бить его из ямы:
      // злой рядом, но луча к нам нет — не бьёт (MeleeAttackGoal: hasLineOfSight).
      // Бой в открытую (удар-вызов с 15 блоков) убивал: ферма 29.09, foxhole-9 —
      // 3 смерти из 4 после вызова («slain by Enderman», −9…−12 хп на обратном пути).
      // 5б. Жемчуг лежит рядом (выпал, а подобрать не дали злые, или с прошлого
      // вызова) — злых поблизости нет: выйти и собрать (основной бот 29.09 18:09:
      // «drop 1, got 0» — единственный за 400 с жемчуг остался лежать).
      {
        const lying = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'item' && e.position && isPearl(e) &&
          e.position.distanceTo(bot.entity.position) < 16 && !lavaAround(bot, e.position))
        if (lying.length && !endermen().some((e : any) => hot(e) && e.position.distanceTo(bot.entity.position) < 10)) {
          const had = countOf(bot, 'ender_pearl')
          if (await foxExit(bot, ctl, mcData, fox)) {
            for (const it of (lying as any)) {
              if (!bot.entities[it.id] || ctl.aborted) continue
              await walkTo(bot, ctl, it.position, 1, 6000, () => endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 6), true)
              await sleep(300)
            }
          }
          log('окоп: собрал лежащий жемчуг', { lying: lying.length, got: countOf(bot, 'ender_pearl') - had })
          continue
        }
      }
      if (gameClock.now() - lastReach > 5000 && stalks < 20) {
        const me = bot.entity.position
        // Зомби-пиглины рядом с целью — нет: взмах задевает соседей, и злится вся стая
        // (foxhole-14r: «slain by Zombified Piglin»; то же правило у дуэли).
        const zp = ents(bot).filter((o : any) => o && o.name === 'zombified_piglin' && o.position)
        // Только тех, к кому есть клетка «куда дойду» в 1.2–2.6 блока по горизонтали и
        // ±1 по высоте: выбор «ближайшего по прямой» слал к эндерменам на уступах —
        // «мест нет, nodes 0» и «время вышло» по кругу (основной бот 29.09, 18:02–18:09).
        const { walkable }: typeof import('../walkable') = require('../walkable')
        const from = bot.entity.position.floored().equals(fox.H) ? fox.out : me
        const flood = walkable(bot, from, { radius: 40, maxNodes: 12000 })
        const spotFor = e => {
          let best = null
          for (const n of flood) {
            const dh = Math.hypot(n.pos.x + 0.5 - e.position.x, n.pos.z + 0.5 - e.position.z)
            if (dh < 1.2 || dh > 2.6 || Math.abs(n.pos.y - Math.floor(e.position.y)) > 1) continue
            if (!best || n.d < best.d) best = n
          }
          return best
        }
        const pick = endermen().filter((e : any) => !hot(e) && !skipped(e) && !trappedEm(bot, e) && e.position.distanceTo(me) < 40 && !zp.some((o : any) => o.position.distanceTo(e.position) < 8))
          .map(e => ({ e, n: spotFor(e) })).filter(x => x.n).sort((a, c) => a.n.d - c.n.d)[0]
        const t: any = pick && pick.e
        // Брут, хоглин, гаст рядом — из окопа не выходить ни сдвинуться, ни подкрасться (chain6-14 30.09: окоп у
        // бастиона, «минуту некого злить — сдвинуться», вышел — брут; разбор Codex).
        const foesNear = ents(bot).some((e : any) => e && e.position && ((/^(piglin_brute|hoglin|zoglin|wither_skeleton)$/.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 24) || (e.name === 'ghast' && e.position.distanceTo(bot.entity.position) < 48)))
        if (foesNear) { lastChance = gameClock.now(); await sleep(700); continue }
        if (!t) {
          // Спокойных, к кому дойти, в 40 нет — старое правило: минуту некого злить — сдвинуться.
          if (gameClock.now() - lastChance > 60000 && moves < 6) {
            moves++
            used.push(fox.P)
            await foxExit(bot, ctl, mcData, fox)
            const s = await newSite()
            log('окоп: новое место', s.ok ? { at: xyz(s.fox.P), n: moves } : s)
            if (s.ok) fox = s.fox
            lastChance = gameClock.now()
          }
          await sleep(700)
          continue
        }
        stalks++
        lastReach = gameClock.now()
        used.push(fox.P)
        await foxExit(bot, ctl, mcData, fox)
        const st: any = { id: t.id, from: Math.round(t.position.distanceTo(bot.entity.position)), steps: pick.n.d }
        if (pick.n.pos.distanceTo(bot.entity.position) > 2) {
          const g = pick.n.pos
          const w = await walkTo(bot, ctl, g, 1, 15000, () => endermen().some((e : any) => angry(e) && e.position.distanceTo(bot.entity.position) < 6))
          st.walk = w.ok ? 'ok' : w.error
        }
        if (!bot.entities[t.id] || t.isValid === false || angry(t)) { st.why = 'ушёл или злой'; log('окоп: подкрасться', st); skip.set(t.id, gameClock.now() + 20000); continue }
        const s = await newSite({ near: t.position.clone() })
        st.site = s.ok ? xyz(s.fox.P) : s.why
        st.dist = s.ok ? Math.round(t.position.distanceTo(s.fox.P.offset(0.5, 0, 0.5)) * 10) / 10 : undefined
        log('окоп: подкрасться', st)
        if (s.ok) { fox = s.fox; lastChance = gameClock.now() } else skip.set(t.id, gameClock.now() + 30000)
        continue
      }
      await sleep(700)
    }
  } finally {
    bot._ndInFoxhole = null
    bot._ndMobAvoidOnly = avoid0
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('entityDead', onDead)
    bot.removeListener('entityGone', onGone)
    bot.removeListener('entityHurt', onMeHurt)
    bot.removeListener('physicsTick', capPitch)
  }
  // Жемчуга хватает — наружу (дальше идти ногами); нет — сидеть в окопе до следующего вызова.
  if (fox && countOf(bot, 'ender_pearl') >= want) await foxExit(bot, ctl, mcData, fox).catch(() => false)
  const pearls = countOf(bot, 'ender_pearl')
  const secs = Math.round((gameClock.now() - t0) / 1000)
  const detail: any = {
    mode: 'hunt',
    style: 'окоп',
    ...((process.env.ND_NE_RECOVER === '1' || process.env.ND_EM_PRICE_RECEIPTS === '1') ? { prepared: !!fox } : {}),
    pearls: { before: pearls0, now: pearls, gained: pearls - pearls0, want },
    kills,
    aggros,
    stares,
    peeks,
    pokes,
    stalks,
    openFights,
    moves,
    hits,
    hitsOnMe,
    killsPerHour: secs ? Math.round(kills * 3600 / secs) : 0,
    rounds: rounds.slice(-10),
    hpLost: Math.max(0, hp0 - Math.round(bot.health ?? 0)),
    seconds: secs
  }
  if (pearls < want) {
    detail.need = { what: 'ender_pearl', count: want - pearls, have: pearls }
    detail.stopped = `${stopped || 'встал'} — жемчуга ${pearls} из ${want} (убил ${kills})`
  }
  detail.note = `Жемчуг +${detail.pearls.gained}, убито ${kills} (разозлил ${aggros} из ${stares} взглядов, выглядывал ${peeks}) за ${secs} с (окоп под крышей).`
  return detail
}
declare namespace huntFoxhole {
  let _why: any
}

export { huntFoxhole }
