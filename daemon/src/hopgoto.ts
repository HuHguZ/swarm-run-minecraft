'use strict'
const gameClock = require('./game-clock')
// Жемчуг как ход goto (TODO.md «Жемчуг как перемещение», п. 1, общий ход; поток movement, 02.10.2026).
// Включается параметром goto { pearl: true | {reserve, hpMin, hpSec, minGain, minShare, maxHops} } или ND_PEARL_GOTO=1.
//
// Решение — по НАСТОЯЩЕМУ пешему пути: A* pathfinder'а считаем заранее (по кускам, не блокируя физику), время пути
// — по его узлам (pathSeconds), а не по прямой. Жемчуг — pearl-hop.planHop (посадка у линии на цель, проверка
// траектории по блокам и разброса, не край пустоты) и hopTo (бросок через throw.throwAt, проверка факта переноса).
// Цена броска: прицел/полёт/приход в себя (hopSeconds) + остаток пути от посадки + урон 5 хп × hpSec. Бросаем, если
// выигрыш ≥ minGain секунд И ≥ minShare пешего времени. Резерв жемчуга — на очи Края: его задаёт зовущий (кампания
// знает, сколько нужно); по умолчанию резерв 12 — без явного резерва жемчуг на ходьбу почти не тратится.
// Сорвались с края после посадки — ловит сторож падения (clutch.js), блок под ноги.

const Vec3 = require('vec3')
const pearlHop = require('./pearl-hop')

const WALK = 4.317 // бл/с — шаг без спринта (pathfinder: allowSprinting = false)
// Бег (allowSprinting): 5.612 по прямой, но pathfinder бежит только на прямых отрезках (canStraightLine) — в среднем
// по пути меньше; 5.0 — середина (рельеф mv-spr-1: по прямой до цели бег быстрее шага на 12–15 %).
const RUN = 5.0

// Время по узлам пути pathfinder'а, с. Шаг — по горизонтали; вода — вдвое медленнее; прыжок вверх +0.25;
// копка — по цене узла (1 + 3·digTime на блок: digTime ≈ (cost − 1)/3); постановка pathfinder'ом (стоя, с
// ожиданием сервера) — 0.8 с за блок; мост на ходу (ndBridge) — как шаг.
function pathSeconds (path, from, { liquidAt = null, speed = WALK }: any = {}) {
  if (!Array.isArray(path) || !path.length) return 0
  let t = 0
  let p = from
  for (const n of path) {
    const d = Math.hypot(n.x - p.x, n.z - p.z)
    const wet = liquidAt ? liquidAt(n) : false
    t += d / (wet ? WALK / 2 : speed)
    if (n.y - p.y > 0.5) t += 0.25 * (n.y - p.y)
    if (n.toBreak && n.toBreak.length) t += Math.max(0.3, ((n.cost || 1) - 1) / 3)
    if (n.toPlace && n.toPlace.length) t += 0.8 * n.toPlace.length
    p = n
  }
  return Math.round(t * 10) / 10
}

// A* без блокировки физики: генератор pathfinder'а по кусочкам (tickTimeout мс), между ними — отдать цикл.
async function planWalk (bot, goal, { ms = 3000, slice = 30, abortIf = null }: any = {}) {
  const pf = bot.pathfinder
  if (!pf || !pf.movements || typeof pf.getPathFromTo !== 'function') return null
  const gen = pf.getPathFromTo(pf.movements, bot.entity.position, goal, { timeout: ms, tickTimeout: slice })
  let res = null
  const t0 = gameClock.wall.now()
  while (gameClock.wall.now() - t0 < ms + 500) {
    if (abortIf && abortIf()) return res
    const it = gen.next()
    if (it.done) break
    res = it.value.result
    if (res.status !== 'partial') break
    await new Promise<any>(resolve => gameClock.wall.setTimeout(resolve, 10))
  }
  return res
}

function options (p) {
  const o = typeof p === 'object' && p ? p : {}
  return {
    reserve: o.reserve ?? 12,
    hpMin: o.hpMin ?? 12,
    hpSec: o.hpSec ?? 1.0,
    minGain: o.minGain ?? 4,
    minShare: o.minShare ?? 0.2,
    maxHops: o.maxHops ?? 4,
    planMs: o.planMs ?? 3000
  }
}

const countPearls = (bot) => bot.inventory.items().filter(i => i.name === 'ender_pearl').reduce((n, i) => n + i.count, 0)

// Решить и, если стоит, бросить. goalXYZ — точка цели (y может быть null), goal — цель pathfinder'а.
// -> { hopped, why, walkSec, hop }
async function maybeHop (session, ctl, goalXYZ, goal, opt: any = {}) {
  const bot = session.bot
  const o = options(opt)
  const log = (m) => console.log('[pearl-goto] ' + m)
  const pearls = countPearls(bot)
  if (pearls - o.reserve <= 0) return { hopped: false, why: `жемчуга ${pearls}, резерв ${o.reserve}` }
  if (bot.entity.isInWater || bot.entity.isInLava || !bot.entity.onGround) return { hopped: false, why: 'не на земле' }
  if (session.current && session.current.name === 'dragon') return { hopped: false, why: 'бой с драконом' }
  const tgt = new Vec3(goalXYZ.x + 0.5, goalXYZ.y ?? bot.entity.position.y, goalXYZ.z + 0.5)
  const flat = Math.hypot(tgt.x - bot.entity.position.x, tgt.z - bot.entity.position.z)
  if (Math.hypot(flat, tgt.y - bot.entity.position.y) < 8) return { hopped: false, why: 'цель рядом' }
  const t0 = gameClock.wall.now()
  const walk = await planWalk(bot, goal, { ms: o.planMs, abortIf: () => ctl && ctl.aborted })
  const planMs = gameClock.wall.now() - t0
  const liquidAt = (n) => { const b = bot.blockAt(new Vec3(Math.floor(n.x), Math.floor(n.y), Math.floor(n.z))); return !!(b && /water/.test(b.name)) }
  const speed = bot.pathfinder.movements && bot.pathfinder.movements.allowSprinting ? RUN : WALK
  let walkSec
  let walkWhy
  if (walk && walk.status === 'success') { walkSec = pathSeconds(walk.path, bot.entity.position, { liquidAt, speed }); walkWhy = `путь ${walk.path.length} узлов` } else {
    // Пути нет за planMs — пешком «долго»: оценка по прямой ×3 (обход не найден).
    walkSec = Math.round(flat / speed * 3 * 10) / 10
    walkWhy = `пути нет (${walk ? walk.status : '—'})`
  }
  const world = pearlHop.worldOf(bot)
  const me = bot.entity.position
  const dmg = pearlHop.pearlDamage(bot)
  const route = pearlHop.planRoute(world, me, tgt, { ...o, speed, pearls, hp: bot.health, dmg, obstacles: pearlHop.obstaclesOf(bot) })
  const ph = { plan: route.plans[0], why: 'no safe worthwhile chain' }
  if (!ph.plan) { log(`нет броска (${walkWhy}, пешком ~${walkSec} с): ${JSON.stringify(ph.why)}`); return { hopped: false, why: 'нет броска', walkSec } }
  const hopSec = pearlHop.hopSeconds(ph.plan.ticks)
  const rest = { sec: route.seconds - hopSec - dmg * o.hpSec }
  const cost = route.seconds
  const gain = Math.round((walkSec - cost) * 10) / 10
  const line = `пешком ~${walkSec} с (${walkWhy}, план ${planMs} мс); жемчугом ${Math.round(hopSec * 10) / 10} + остаток ${rest.sec} + хп ${dmg}×${o.hpSec} = ${Math.round(cost * 10) / 10} с; выигрыш ${gain} с; посадка ${ph.plan.feet.x.toFixed(1)},${ph.plan.feet.y.toFixed(1)},${ph.plan.feet.z.toFixed(1)}`
  if (bot.health - dmg < o.hpMin) { log(line + ' — НЕТ: хп'); return { hopped: false, why: 'хп', walkSec, gain } }
  if (gain < o.minGain || gain < o.minShare * walkSec) { log(line + ' — НЕТ: мал выигрыш'); return { hopped: false, why: 'мал выигрыш', walkSec, gain } }
  log(line + ' — бросаю')
  try { bot.pathfinder.setGoal(null) } catch {}
  const hop = await pearlHop.hopTo(bot, tgt, {
    reserve: o.reserve, hpMin: o.hpMin, hpSec: o.hpSec, minGain: o.minGain, maxHops: o.maxHops, arriveR: 3,
    walkSec, abortIf: () => !!(ctl && ctl.aborted), log: (m) => log(m)
  })
  return { hopped: hop.hops > 0, why: hop.stop || null, walkSec, gain, hop: { hops: hop.hops, pearls: hop.pearls, hpLost: hop.hpLost, misses: hop.misses, ms: hop.ms } }
}

function on (p) { return p !== undefined ? !!p : process.env.ND_PEARL_GOTO !== '0' }

module.exports = { pathSeconds, planWalk, maybeHop, options, on, WALK, RUN }
