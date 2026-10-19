'use strict'
// Литьё одним ведром (cast1.ts): раскладка рамы, жёлоба и берега, лучи к озеру, состояние источников, клик ведром.
import { Vec3 } from 'vec3'
import * as gameClock from '../game-clock'
import { sleep } from '../movement'


export const UP = new Vec3(0, 1, 0)
export const DOWN = new Vec3(0, -1, 0)
export const SIDES4 = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
export const AX = { x: new Vec3(1, 0, 0), z: new Vec3(0, 0, 1) }
export const PLACE1 = 'литьё портала (одно ведро)'
export const FILLER = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack', 'blackstone', 'basalt', 'sandstone', 'red_sandstone']

export function C () { return require('../cast')._in }

export function geom1 (origin, axis, side) {
  const u = AX[axis]
  const perp = axis === 'x' ? AX.z : AX.x
  const at = (i, j) => origin.offset(u.x * i, j, u.z * i)
  const off = (i, j, k) => at(i, j).offset(perp.x * side * k, 0, perp.z * side * k)
  return { origin, axis, side, u, perp, pv: new Vec3(perp.x * side, 0, perp.z * side), at, F: (i, j) => off(i, j, 1), G: (i, j) => off(i, j, 2), H: (i, j) => off(i, j, 3), I: (i, j) => off(i, j, 4), J: (i, j) => off(i, j, 5), K: (i, j) => off(i, j, 6), B: (i, j) => off(i, j, -1) }
}

// Клетки рамы и откуда что лить. water: [ref, face] — вода ляжет в ref+face = w; lava: [ref, face] — лава в ref+face = c.
// h — высота столба тела в G(0): 0 — с земли, 2 — со столба.
export function cells (g) {
  const u = g.u
  const mu = u.scaled(-1)
  return [
    { c: g.at(0, -1), w: g.F(0, -1), water: [[g.F(0, -2), UP]], lava: [[g.at(0, -2), UP]], h: 0 },
    { c: g.at(1, -1), w: g.F(1, -1), water: [[g.F(1, -2), UP]], lava: [[g.at(1, -2), UP]], h: 0 },
    { c: g.at(-1, 0), w: g.F(-1, 0), water: [[g.F(-2, 0), u]], lava: [[g.at(-1, -1), UP]], h: 0 },
    { c: g.at(2, 0), w: g.F(2, 0), water: [[g.F(3, 0), mu]], lava: [[g.at(2, -1), UP]], h: 0 },
    { c: g.at(-1, 1), w: g.F(-1, 1), water: [[g.F(-2, 1), u]], lava: [[g.at(-1, 0), UP]], h: 0 },
    { c: g.at(2, 1), w: g.F(2, 1), water: [[g.F(3, 1), mu]], lava: [[g.at(2, 0), UP]], h: 0 },
    { c: g.at(-1, 2), w: g.F(-1, 2), water: [[g.F(-2, 2), u]], lava: [[g.at(-1, 1), UP]], h: 2 },
    { c: g.at(2, 2), w: g.F(2, 2), water: [[g.F(3, 2), mu]], lava: [[g.at(2, 1), UP]], h: 2 },
    { c: g.at(0, 3), w: g.F(0, 3), water: [[g.F(-1, 3), u]], lava: [[g.at(0, 2), UP]], h: 2, top: true },
    { c: g.at(1, 3), w: g.F(1, 3), water: [[g.F(2, 3), mu]], lava: [[g.at(1, 2), UP]], h: 2, top: true }
  ]
}

export const isAirB = b => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')
export const fluid = b => { const f = C().hasFluid; return f(b) }
export const solid = b => C().isSolid(b)
export const FALL = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$/
export const keyOf = p => `${p.x},${p.y},${p.z}`

// Досягаемость черпака по геометрии (без лучей — часть мешающего ещё будет выкопана): ближайшая из точек верха клетки
// не дальше r от глаз. Глаза тела в G(0): с земли h=0, со столба h=2.
const SCOOP_PTS = [[0.5, 0.8, 0.5], [0.2, 0.8, 0.2], [0.8, 0.8, 0.2], [0.2, 0.8, 0.8], [0.8, 0.8, 0.8]]
const reachOf = (eye, p, r = 4.35) => SCOOP_PTS.some(([a, b, c]) => eye.distanceTo(p.offset(a, b, c)) <= r)
const eyesAt = (g, h, col = 0) => g.G(col, 0).offset(0.5, h + 1.62, 0.5)
// Колонки столба: G(0); со сдвигом (ND_CAST1_SHIFT, S8b 07.10) верх рамы льётся и со столба в G(±1).
export const shiftOn = () => process.env.ND_CAST1_SHIFT !== '0'
// Источники озера (ряды H…K, уровень берега −1 и −2, воздух сверху): досягаемые с земли и со столба.
// Луч черпака от глаз до точки P клетки target: нет твёрдого (кроме клеток dig — их выкопают) и чужого источника.
function rayFree (read, eye, P, target, dig = null) {
  const d = P.minus(eye)
  const n = Math.ceil(d.norm() / 0.08)
  let last = null
  for (let k = 1; k < n; k++) {
    const q = eye.plus(d.scaled(k / n)).floored()
    if (last && q.equals(last)) continue
    last = q
    if (q.equals(target)) return true
    if (dig && dig.has(keyOf(q))) continue
    const b = read(q)
    if (!b) return false
    if (/^(lava|water)$/.test(b.name)) { if (C().levelOf(b) === 0) return false; continue }
    if (b.boundingBox === 'block') return false
  }
  return true
}
// rays — с проверкой луча (пещера: порода над озером закрывает лаву со столба — rt-L2 слот 10: «со столба 5» по
// расстоянию, ни одного по лучу).
export function lakeReach (read, g, { rays = false, dig = null, cols = [0] }: any = {}) {
  const e0 = eyesAt(g, 0)
  const tops = cols.map(c => eyesAt(g, 2, c))
  const ground = new Set()
  const top = new Set()
  const ok = (eye, p) => SCOOP_PTS.some(([a, b, c]) => { const P = p.offset(a, b, c); return eye.distanceTo(P) <= 4.35 && (!rays || rayFree(read, eye, P, p, dig)) })
  for (let i = -4; i <= 5; i++) {
    for (const row of ['H', 'I', 'J', 'K']) {
      for (const dy of [-1, -2]) {
        const p = g[row](i, dy)
        const b = read(p)
        if (!b || b.name !== 'lava' || C().levelOf(b) !== 0 || !isAirB(read(p.plus(UP)))) continue
        if (ok(e0, p)) ground.add(keyOf(p))
        if (tops.some(e => ok(e, p))) top.add(keyOf(p))
      }
    }
  }
  return { ground, top }
}

export function sourceState1 (bot, plan) {
  const g = geomOf1(plan)
  const pending = cells(g).filter(t => (bot.blockAt(t.c) || {}).name !== 'obsidian')
  const reach = lakeReach(p => bot.blockAt(p), g, { rays: true, dig: new Set((plan.dig || []).map(keyOf)), cols: shiftOn() ? [0, -1, 1] : [0] })
  const carried = C().countOf(bot, 'lava_bucket')
  return { frame: `${10 - pending.length}/10 обсидиан`, key: JSON.stringify([[...reach.ground].sort(), [...reach.top].sort(), carried]),
    short: pending.filter(t => t.h > 0).length > reach.top.size + carried ||
    pending.length > new Set([...reach.ground, ...reach.top]).size + carried }
}

// Клик ведром: взгляд (force — пакет взгляда не уходит, поворот едет в самом use_item, 1.21.2+), клик, ждать ответа
// сервера — убыли предмета from в рюкзаке (опрос 10 мс; слот приходит через ~15 мс). Paper 1.21.11 молча роняет
// use_item чаще раза в тик (лаб ow-c1l/m, 03.10: без паузы ~каждый 6–9-й клик пропал, пауза 30 мс — пропуски, 55 мс —
// ни одного за 20 клеток): между кликами не меньше GAP (55 мс). Нет ответа за wait — клик пропал (не задержался:
// при повторе через 1.1 с предмет был прежний) — ещё раз тем же прицелом, до tries.
const GAP = () => Number(process.env.ND_CAST1_GAP || 55)
export async function useAt (bot, aim, from, { tries = 2, wait = 260 }: any = {}) {
  if (!aim || !(await C().hold(bot, from))) return false
  const before = C().countOf(bot, from)
  for (let k = 0; k < tries; k++) {
    // С флагом =0 сохраняется прежний порядок для парной проверки.
    if (process.env.ND_CAST1_AIM === '0') { try { await bot.lookAt(aim, true) } catch {} }
    const gap = GAP()
    if (gap > 0 && bot._ndCast1Last) { const w = bot._ndCast1Last + gap - gameClock.now(); if (w > 0) await sleep(w) }
    // Между наведением и use_item нет таймера: пакет несёт текущие yaw/pitch.
    if (process.env.ND_CAST1_AIM !== '0') { try { await bot.lookAt(aim, true) } catch { return false } }
    bot._ndCast1Last = gameClock.now()
    try { bot.activateItem() } catch {}
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < wait) {
      if (C().countOf(bot, from) < before) { if (k) bot._ndCast1Resent = (bot._ndCast1Resent || 0) + 1; return true }
      await sleep(10)
    }
    if (!bot.heldItem || bot.heldItem.name !== from) break
  }
  const L = bot._ndHandLock
  bot._ndCast1Drop = `${from}: рука ${bot.heldItem ? bot.heldItem.name : 'пусто'}, замок ${L ? `${L.on() ? 'взведён' : 'снят'}, отменено use ${L.blocked.use}` : 'нет'}`
  return false
}

export function geomOf1 (plan) { return geom1(new Vec3(plan.origin.x, plan.origin.y, plan.origin.z), plan.axis, plan.side) }
