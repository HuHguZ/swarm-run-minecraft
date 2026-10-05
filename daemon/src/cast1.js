'use strict'
const gameClock = require('./game-clock')
// Литьё рамы ОДНИМ ведром, стоя на берегу лавового озера (поток route, 03.10.2026) — раннерский приём.
//
// Зачем. cast.js льёт двумя вёдрами (лава + вода, 6 железа) и ходит к лаве на каждую клетку, со столбами у рамы
// (2.2–3 мин; «столб не вырос» — частый срыв). Голем деревни даёт 3–5 железа — одно ведро. Здесь одно ведро и почти
// без ходьбы: тело стоит на берегу, озеро — за спиной, рама — перед ним через жёлоб.
//
// Механика 1.21.11 (как в шапке cast.js): источник лавы, поставленный рядом с водой (сбоку или сверху), сразу
// становится obsidian (LiquidBlock.onPlace → shouldSpreadLiquid). Полное ведро кладёт жидкость в клетку за гранью,
// в которую упёрся луч (жидкости насквозь — Fluid.NONE); пустое — берёт только источник (SOURCE_ONLY, текущую
// жидкость луч проходит). Источник воды над пустотой течёт только вниз (FlowingFluid.spread: вбок — лишь при трёх
// соседях-источниках), падающая вода вбок не растекается, растекается только с пола.
//
// Раскладка (O — левая нижняя клетка проёма; i вдоль рамы, j вверх; p — от рамы к озеру):
//   at(i,j) — рама и проём; F(i,j) = at + p — жёлоб с водой перед рамой; G(i,j) = at + 2p — берег, тело стоит в G(i,0)
//   на полу G(i,-1); H(i,j) = at + 3p — озеро (лава вровень с берегом: H(i,-1) — источники, верх на уровне ног).
//   Низ рамы и дно жёлоба вкопаны на уровень берега (y0 = уровень лавы): вода в жёлобе заперта землёй, полом берега
//   G(·,-1) и стенками жёлоба F(-2,·), F(3,·) — до озера не дотекает.
// Клетка рамы c и её вода w (клетка жёлоба перед c):
//   1. ведро воды → в w (луч в грань соседа w: пол жёлоба, стенка жёлоба, блок над/сбоку);
//   2. пустым ведром — лаву из озера (с той же клетки, только поворот);
//   3. лаву → в c (грань соседа c: пол рамы, верх клетки ниже, временная подпорка в проёме) — сразу obsidian;
//   4. воду из w — назад в ведро.
// С земли (глаза y0+1.62) — низ и стойки j=0,1; со столба 2 в G(0) (глаза y0+3.62) — стойки j=2 и верх; лава с
// высоты достаётся из H(−2..2)/I(−1..1).
//
// Окно воды (rt-L1, 03.10, 9 срывов из 12). Источник воды над пустым жёлобом течёт вниз, а через тик воды (5 тиков)
// после того, как клетка под ним заполнилась, — вбок (FlowingFluid.spread: вниз нельзя — «вода в воду» не заменяется,
// источник → spreadToSides): на берег G и над озером → лава у берега в obsidian/булыжник («лавы нет»), тело в воде
// («не подпрыгнул (+0.20)»), вода по берегу. Поэтому четыре клика ведром идут подряд без пауз (поворот уходит в самом
// пакете use_item, 1.21.2+; mineflayer lookAt(force) пакета взгляда не шлёт) — окно ~3 тика вместо 8–12, а лава
// и все прицелы считаются ДО воды; лавы со столба нет — вода не льётся вовсе.

const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { sleep, xyz } = require('./movement')
const { equipBestTool, missingHarvestTool } = require('./items')
const { placeBlockAt, towerUp } = require('./build')

const UP = new Vec3(0, 1, 0)
const DOWN = new Vec3(0, -1, 0)
const SIDES4 = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const AX = { x: new Vec3(1, 0, 0), z: new Vec3(0, 0, 1) }
const PLACE1 = 'литьё портала (одно ведро)'
const FILLER = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack', 'blackstone', 'basalt']

function C () { return require('./cast')._in }

function geom1 (origin, axis, side) {
  const u = AX[axis]
  const perp = axis === 'x' ? AX.z : AX.x
  const at = (i, j) => origin.offset(u.x * i, j, u.z * i)
  const off = (i, j, k) => at(i, j).offset(perp.x * side * k, 0, perp.z * side * k)
  return { origin, axis, side, u, perp, pv: new Vec3(perp.x * side, 0, perp.z * side), at, F: (i, j) => off(i, j, 1), G: (i, j) => off(i, j, 2), H: (i, j) => off(i, j, 3), I: (i, j) => off(i, j, 4), J: (i, j) => off(i, j, 5), K: (i, j) => off(i, j, 6), B: (i, j) => off(i, j, -1) }
}

// Клетки рамы и откуда что лить. water: [ref, face] — вода ляжет в ref+face = w; lava: [ref, face] — лава в ref+face = c.
// h — высота столба тела в G(0): 0 — с земли, 2 — со столба.
function cells (g) {
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

const isAirB = b => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')
const fluid = b => { const f = C().hasFluid; return f(b) }
const solid = b => C().isSolid(b)
const FALL = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel)$/
const keyOf = p => `${p.x},${p.y},${p.z}`

// Досягаемость черпака по геометрии (без лучей — часть мешающего ещё будет выкопана): ближайшая из точек верха клетки
// не дальше r от глаз. Глаза тела в G(0): с земли h=0, со столба h=2.
const SCOOP_PTS = [[0.5, 0.8, 0.5], [0.2, 0.8, 0.2], [0.8, 0.8, 0.2], [0.2, 0.8, 0.8], [0.8, 0.8, 0.8]]
const reachOf = (eye, p, r = 4.35) => SCOOP_PTS.some(([a, b, c]) => eye.distanceTo(p.offset(a, b, c)) <= r)
const eyesAt = (g, h) => g.G(0, 0).offset(0.5, h + 1.62, 0.5)
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
function lakeReach (read, g, { rays = false, dig = null } = {}) {
  const e0 = eyesAt(g, 0)
  const e2 = eyesAt(g, 2)
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
        if (ok(e2, p)) top.add(keyOf(p))
      }
    }
  }
  return { ground, top }
}

// Клик ведром: взгляд (force — пакет взгляда не уходит, поворот едет в самом use_item, 1.21.2+), клик, ждать ответа
// сервера — убыли предмета from в рюкзаке (опрос 10 мс; слот приходит через ~15 мс). Paper 1.21.11 молча роняет
// use_item чаще раза в тик (лаб ow-c1l/m, 03.10: без паузы ~каждый 6–9-й клик пропал, пауза 30 мс — пропуски, 55 мс —
// ни одного за 20 клеток): между кликами не меньше GAP (55 мс). Нет ответа за wait — клик пропал (не задержался:
// при повторе через 1.1 с предмет был прежний) — ещё раз тем же прицелом, до tries.
const GAP = () => Number(process.env.ND_CAST1_GAP || 55)
async function useAt (bot, aim, from, { tries = 2, wait = 260 } = {}) {
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

// Оценка места. read(p) — блок или null. Возвращает { plan } или { why }.
function judge1 (read, g, { me = null, maxDig = 40 } = {}) {
  const dig = []
  const place = []
  const bad = why => ({ why })
  const blockAt = p => read(p)
  const need = (p, ok, why) => { const b = blockAt(p); if (!b) return 'чанк не прогружен'; return ok(b) ? null : why }
  // Озеро за берегом: источники с воздухом сверху В ДОСЯГАЕМОСТИ черпака — с земли на 6 нижних клеток, со столба на 4
  // верхние, всего 10 + 1 запас (rt-L1: «лавы у берега 18», а достать с G(0) — 6–7, дальние ряды J/K не в счёт;
  // со столба лавы нет — вниз с водой в жёлобе нельзя, она растекается).
  const R = lakeReach(read, g)
  const union = new Set([...R.ground, ...R.top])
  const lava = union.size
  const high = R.top.size
  if (R.ground.size < 6 || high < 4 || lava < 11) return bad(`лавы в досягаемости: с земли ${R.ground.size}, со столба ${high}, всего ${lava}`)
  // Берег: пол G(i,-1) твёрдый и не сыпучий (сыпучий, если держится); над ним 2 (у G(0) — 5) воздуха.
  for (let i = -1; i <= 2; i++) {
    const fl = blockAt(g.G(i, -1))
    if (!fl) return bad('чанк не прогружен')
    if (!solid(fl) || (FALL.test(fl.name) && !solid(blockAt(g.G(i, -2))))) return bad('берег не твёрдый')
    // Над берегом: столб G(0) — 5 воздуха; G(±1) — 4: со столба луч воды к стенкам жёлоба F(−2,2)/F(3,2) и опорам
    // F(−1,3)/F(2,3) идёт через G(−1,3)/G(1,3) (rt-L1, пещеры 11/27/28: «луч к грани … упирается в G(−1,3)»).
    const hmax = i === 0 ? 4 : (i === 2 ? 1 : 3)
    for (let j = 0; j <= hmax; j++) {
      const b = blockAt(g.G(i, j))
      if (!b) return bad('чанк не прогружен')
      if (fluid(b)) return bad('жидкость на берегу')
      if (!isAirB(b)) { if (b.boundingBox === 'block') dig.push(g.G(i, j)); else dig.push(g.G(i, j)) }
    }
  }
  // Дно жёлоба и пол рамы — твёрдые.
  for (let i = -1; i <= 2; i++) { const w = need(g.F(i, -2), b => solid(b), 'нет дна жёлоба'); if (w) return bad(w) }
  for (let i = 0; i <= 1; i++) { const w = need(g.at(i, -2), b => solid(b), 'нет пола рамы'); if (w) return bad(w) }
  // Перемычки, которые держат воду в жёлобе на уровне y0: концы жёлоба, пол берега (выше), углы рамы, за низом рамы.
  for (const p of [g.F(-2, -1), g.F(3, -1), g.B(0, -1), g.B(1, -1)]) {
    const b = blockAt(p)
    if (!b) return bad('чанк не прогружен')
    if (fluid(b)) return bad('жидкость у жёлоба')
    if (!solid(b)) place.push(p)
  }
  for (const p of [g.at(-1, -1), g.at(2, -1)]) {
    const b = blockAt(p)
    if (!b) return bad('чанк не прогружен')
    if (fluid(b)) return bad('жидкость в углу рамы')
    if (!solid(b) || FALL.test(b.name)) { if (!isAirB(b) && b.boundingBox !== 'empty') dig.push(p); place.push(p) }
  }
  // Жёлоб F(i,-1..4), рама и проём at(i,-1..3) (кроме углов) — воздух; стенки жёлоба F(-2,0..3), F(3,0..3) — блоки.
  for (let i = -1; i <= 2; i++) {
    for (let j = -1; j <= 4; j++) {
      const p = g.F(i, j)
      const b = blockAt(p)
      if (!b) return bad('чанк не прогружен')
      if (fluid(b)) return bad('жидкость в жёлобе')
      if (!isAirB(b)) dig.push(p)
    }
    for (let j = -1; j <= 3; j++) {
      if ((i === -1 || i === 2) && (j === -1 || j === 3)) continue
      const p = g.at(i, j)
      const b = blockAt(p)
      if (!b) return bad('чанк не прогружен')
      if (fluid(b)) return bad('жидкость в раме')
      if (b.name === 'obsidian' || /chest|portal|bedrock/.test(b.name)) return bad(`в раме ${b.name}`)
      if (!isAirB(b)) dig.push(p)
    }
  }
  for (const i of [-2, 3]) {
    for (let j = 0; j <= 3; j++) {
      const p = g.F(i, j)
      const b = blockAt(p)
      if (!b) return bad('чанк не прогружен')
      if (fluid(b)) return bad('жидкость у стенки жёлоба')
      if (!solid(b)) place.push(p)
    }
  }
  if (dig.length > maxDig) return bad(`копать ${dig.length}`)
  // Лава по лучу — с учётом того, что будет выкопано.
  const R2 = lakeReach(read, g, { rays: true, dig: new Set(dig.map(keyOf)) })
  const union2 = new Set([...R2.ground, ...R2.top])
  if (R2.ground.size < 6 || R2.top.size < 4 || union2.size < 11) return bad(`лава за породой: по лучу с земли ${R2.ground.size}, со столба ${R2.top.size}, всего ${union2.size}`)
  // Копка рядом с жидкостью и под сыпучим — нельзя (то же чутьё, что у cast.js).
  for (const p of dig) {
    const r = C().digRisk(read, p)
    if (r && !/жидкость сбоку/.test(r)) return bad(r)
    // Сбоку жидкость — только если это не наша будущая вода/лава озера: у клетки жёлоба сосед — пол берега, не лава.
    for (const v of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), UP]) {
      const n = blockAt(p.plus(v))
      if (n && /lava/.test(n.name)) return bad('лава у клетки копки')
    }
  }
  const score = dig.length * 2 + place.length * 3 - union2.size - Math.min(R2.top.size, 6) * 3 + (me ? Math.round(g.G(0, 0).distanceTo(me)) : 0)
  return { plan: { axis: g.axis, side: g.side, origin: xyz(g.origin), dig: dig.map(xyz), place: place.map(xyz), lava: union2.size, high: R2.top.size, score } }
}

// Места у берега: для каждого открытого источника лавы L и направления p — рамы, у которых L в H/I-ряду.
function plan1 (bot, lavaCells, { maxCand = 60, maxDig = 40 } = {}) {
  const read = p => bot.blockAt(p)
  const me = bot.entity.position
  let best = null
  const why = new Map()
  const seen = new Set()
  for (const L of lavaCells.slice(0, maxCand)) {
    for (const axis of ['x', 'z']) {
      for (const side of [1, -1]) {
        for (let k = -1; k <= 2; k++) {
          // H(k,-1) = L → at(k,-1) = L − 3p → O = at(0,0) = L − 3p − k·u + UP.
          const perp = axis === 'x' ? AX.z : AX.x
          const u = AX[axis]
          const O = L.offset(-perp.x * side * 3 - u.x * k, 1, -perp.z * side * 3 - u.z * k)
          const key = `${O.x},${O.y},${O.z},${axis},${side}`
          if (seen.has(key)) continue
          seen.add(key)
          const g = geom1(O, axis, side)
          const r = judge1(read, g, { me, maxDig })
          if (r.why) { why.set(r.why, (why.get(r.why) || 0) + 1); continue }
          if (!best || r.plan.score < best.score) best = r.plan
        }
      }
    }
  }
  if (best) return { ok: true, plan: best }
  return { ok: false, reasons: [...why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} (${n})`) }
}

// Открытые сверху источники тела лавы у клетки hint (±2), по связности, до cap клеток.
function lavaBodyOpen (bot, hint, { cap = 1500, limit = 80 } = {}) {
  const key = p => `${p.x},${p.y},${p.z}`
  const seen = new Set()
  const q = []
  for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
    const p = hint.offset(dx, dy, dz)
    const b = bot.blockAt(p)
    if (b && b.name === 'lava' && !seen.has(key(p))) { seen.add(key(p)); q.push(p) }
  }
  const out = []
  for (let i = 0; i < q.length && seen.size < cap; i++) {
    const p = q[i]
    const b = bot.blockAt(p)
    if (b && C().levelOf(b) === 0 && isAirB(bot.blockAt(p.plus(UP)))) out.push(p)
    for (const v of [...SIDES4, UP, DOWN]) {
      const n = p.plus(v)
      if (seen.has(key(n))) continue
      const nb = bot.blockAt(n)
      if (nb && nb.name === 'lava') { seen.add(key(n)); q.push(n) }
    }
  }
  const me = bot.entity.position
  return out.sort((a, b) => a.distanceTo(me) - b.distanceTo(me)).slice(0, limit)
}

function geomOf1 (plan) { return geom1(new Vec3(plan.origin.x, plan.origin.y, plan.origin.z), plan.axis, plan.side) }

// Лава в досягаемости черпака отсюда: источник с воздухом сверху, луч черпака есть. С земли — сперва дальние (ряды
// I…K и края H): ближние к столбу H(−2..2), I(0) — запас на верхние клетки, со столба 2 до других не достать
// (lab ow-c1a: 8/10 — «лавы в досягаемости нет» на верхней клетке, ближнюю лаву вычерпали с земли).
// Запас — источники, досягаемые со столба (lakeReach.top, живьём); с земли из запаса берётся не больше, чем его
// останется сверх keep — числа ещё не отлитых верхних клеток.
function lavaInReach (bot, g, avoid = new Set(), { high = false, keep = 0, dig = null } = {}) {
  const free = []
  const res = []
  const me = C().eyes(bot)
  // Запас по лучу с учётом ещё не выкопанного верха (G(±1,2..3) копаются со столба): без этого лава «за невыкопанным»
  // уходила на нижние клетки, а со столба её потом не было (rt-L3, пещеры 10/11/13/27: рамы 8–9/10, «со столба 1»).
  const reserve = high ? new Set() : new Set([...lakeReach(p => bot.blockAt(p), g, { rays: true, dig }).top].filter(k => process.env.ND_CAST1_RESERVE === '0' || !avoid.has(k)))
  for (let i = -4; i <= 5; i++) {
    for (const row of ['H', 'I', 'J', 'K']) {
      if (!g[row]) continue
      for (const dy of [-1, -2]) {
        const p = g[row](i, dy)
        const k = keyOf(p)
        if (avoid.has(k)) continue
        const b = bot.blockAt(p)
        if (!b || b.name !== 'lava' || C().levelOf(b) !== 0) continue
        if (!isAirB(bot.blockAt(p.plus(UP)))) continue
        const aim = C().scoopAim(bot, p)
        if (!aim) continue
        ;(reserve.has(k) ? res : free).push({ p, aim, d: p.offset(0.5, 0.5, 0.5).distanceTo(me) })
      }
    }
  }
  free.sort((a, b) => a.d - b.d)
  // Из запаса — дальние от столба первыми не выйдет (запас и так ближний): по расстоянию, но не больше лишка.
  res.sort((a, b) => b.d - a.d)
  const spare = Math.max(0, reserve.size - keep)
  return [...free, ...res.slice(0, spare)]
}

// Налить из полного ведра в клетку target — через первую подходящую грань из списка refs.
async function pourInto (bot, full, refs) {
  let last = null
  for (const [ref, face] of refs) {
    const r = await C().pour(bot, full, ref, face)
    if (r.ok) return r
    last = r
  }
  return last || { ok: false, why: 'нет грани' }
}

async function castOne (session, ctl, p = {}) {
  const bot = session.bot
  const t0 = gameClock.now()
  const deadline = t0 + Math.max(1, Math.min(600, p.timeoutSeconds || 420)) * 1000
  const late = () => gameClock.now() > deadline || ctl.aborted
  const report = { mode: 'one', cast: [], refills: 0, placed: 0, dug: 0, trace: [] }
  const hazard = at => process.env.ND_CAST1_SAFE === '0' ? null : require('./fauna').castHazard(bot, at)
  const firstThreat = hazard(bot.entity.position)
  if (firstThreat) return { ...report, code: 'CAST_UNSAFE', hazard: firstThreat, built: false, stopped: `CAST_UNSAFE: ${firstThreat.name}` }
  const tr = m => { report.trace.push(`${Math.round((gameClock.now() - t0) / 100) / 10}с ${m}`); if (report.trace.length > 60) report.trace.shift() }
  const cnt = n => C().countOf(bot, n)
  ctl.onAbort.push(() => { try { bot.pathfinder.setGoal(null) } catch {} try { bot.clearControlStates() } catch {} })
  const buckets = cnt('bucket') + cnt('water_bucket') + cnt('lava_bucket')
  if (buckets < 1) return { ...report, built: false, stopped: 'нужно ведро', need: { what: 'bucket', count: 1, have: 0 } }
  const fill = () => FILLER.reduce((n, x) => n + cnt(x), 0)
  // Блоки: стенки жёлоба 8, перемычки до 6, подпорки и уголки 4, столб 2 — ~20, но расчистка места сама даёт землю и
  // камень (rt-R2: «нужно блоков 16» при 8–15 и озере за спиной — литьё не начиналось). До расчистки — хотя бы 6.
  if (fill() < 3) return { ...report, built: false, stopped: 'на стенки жёлоба, подпорки и столб нужно блоков 3+ (остальное даст расчистка)', need: { what: 'cobblestone', count: 3, have: fill() } }
  // Вода в ведре — с собой (одно ведро: её не из чего набрать у рамы, кроме своей же). С лавой в ведре (прошлый заход
  // оборвался) — разобраться у рамы, ниже.
  if (!cnt('water_bucket') && !cnt('lava_bucket')) {
    const r = await require('./obsidian').fillBucket(session, ctl, { fluid: 'water', radius: 32 })
    if (!(r && (r.filled || r.already)) && !cnt('water_bucket')) return { ...report, built: false, stopped: 'нет воды в ведре (одно ведро: вода с собой)', need: { what: 'water_bucket', count: 1, have: 0 } }
  }
  // План: прошлый (в памяти мира), если рядом, иначе новый у видимой лавы.
  let plan = session.castPlan1
  if (!plan) {
    const rec = ((session.journal.state && session.journal.state.places) || {})[PLACE1]
    if (rec && rec.axis) plan = { axis: rec.axis, side: rec.side, origin: { x: rec.x, y: rec.y, z: rec.z }, dig: rec.dig || [], place: rec.place || [] }
  }
  if (plan && geomOf1(plan).G(0, 0).distanceTo(bot.entity.position) > 24) plan = null
  if (!plan) {
    const hint = p.hint ? new Vec3(Math.floor(p.hint.x), Math.floor(p.hint.y), Math.floor(p.hint.z)) : null
    let lava = C().lavaSources(bot, 24).map(b => b.position)
    if (hint) {
      // Тело лавы у подсказки (карта копии мира) по связности — без требования «есть где встать с черпаком»: в закрытой
      // пещере стоять негде, пока место не выкопано (rt-R4 слот 10: «не вижу лавы» в 8 бл. от озера под породой).
      const seen = new Set(lava.map(q => `${q.x},${q.y},${q.z}`))
      for (const q of lavaBodyOpen(bot, hint)) if (!seen.has(`${q.x},${q.y},${q.z}`)) { seen.add(`${q.x},${q.y},${q.z}`); lava.push(q) }
    }
    lava = lava.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    if (!lava.length) return { ...report, built: false, stopped: 'не вижу лавы-источника в 24 блоках — подойди к озеру' }
    const found = plan1(bot, lava, { maxDig: Math.max(20, Math.min(90, p.maxDig || 40)) })
    if (!found.ok) return { ...report, built: false, stopped: `места на берегу нет: ${found.reasons.join(', ')}` }
    plan = found.plan
    session.castPlan1 = plan
    try { session.journal.patch(s => { if (!s.places) s.places = {}; s.places[PLACE1] = { ...plan.origin, dimension: bot.game ? bot.game.dimension : null, axis: plan.axis, side: plan.side, dig: plan.dig, place: plan.place, note: 'литьё одним ведром' } }) } catch {}
  }
  const g = geomOf1(plan)
  const siteThreat = hazard(g.G(0, 0))
  if (siteThreat) return { ...report, code: 'CAST_UNSAFE', hazard: siteThreat, built: false, stopped: `CAST_UNSAFE: ${siteThreat.name}` }
  report.site = { origin: plan.origin, axis: plan.axis, side: plan.side, lava: plan.lava }
  const dropPlan = r => { session.castPlan1 = null; try { session.journal.patch(st => { if (st.places) delete st.places[PLACE1] }) } catch {}; return r }
  const goG = async (i = 0) => {
    const S = g.G(i, 0)
    const f = bot.entity.position.floored()
    if (f.x === S.x && f.z === S.z && f.y >= S.y && f.y <= S.y + 3) return true
    const ok = await C().walk(bot, ctl, new goals.GoalBlock(S.x, S.y, S.z), 20000, { clearance: true })
    return ok && bot.entity.position.floored().equals(S)
  }
  // 2. Расчистка снизу вверх (видимые грани; трава и снег — контуром).
  const digOne = async q => {
    const threat = hazard(bot.entity.position)
    if (threat) return `CAST_UNSAFE: ${threat.name}`
    const b = bot.blockAt(q)
    if (!b || isAirB(b) || fluid(b)) return null
    // Своя рама (повторный заход) не копается.
    if (b.name === 'obsidian') return null
    // Огонь (лава поджигает траву у берега — rt-L2 слот 9: «клетка занята (fire): не выкопано») — потушить ударом; не
    // вышло — не беда: жидкость из ведра огонь заменяет.
    if (/^(fire|soul_fire)$/.test(b.name)) {
      try { await bot.dig(b, true) } catch {}
      await sleep(80)
      return /fire/.test((bot.blockAt(q) || {}).name || '') ? 'огонь не потушен' : null
    }
    const risk = C().digRisk(x => bot.blockAt(x), q)
    if (risk && !/жидкость сбоку/.test(risk)) return risk
    const problem = b.boundingBox === 'empty' ? null : missingHarvestTool(bot, b, session.mcData)
    if (problem) return problem
    try { await equipBestTool(bot, b); await C().digVisible(bot, b, 8000); report.dug++ } catch {}
    return isAirB(bot.blockAt(q)) ? null : 'не выкопано'
  }
  // 1. К берегу. Берег ниже ног (озеро в чаше, «low»: путь литья вниз не копает) — сперва выкопать досягаемое из плана
  // (клетки берега, столб, жёлоб), потом ещё раз (лаб ow-c1n: «не встал на берег» в 1-м вызове из 2).
  if (!(await goG(0))) {
    const near = plan.dig.map(q => new Vec3(q.x, q.y, q.z)).filter(q => C().eyes(bot).distanceTo(q.offset(0.5, 0.5, 0.5)) <= 4.3).sort((a, b) => b.y - a.y)
    for (const q of near.slice(0, 12)) { if (late()) break; await digOne(q) }
    if (!(await goG(0))) return { ...report, built: false, stopped: `не встал на берег ${g.G(0, 0).x},${g.G(0, 0).y},${g.G(0, 0).z}` }
  }
  await C().centreOn(bot, ctl, g.G(0, 0))
  tr('на берегу')
  // С земли — всё, до чего достать (до O.y+1) и столб тела G(0,·) целиком (иначе «потолок» у столба); выше — со столба.
  const allDigs = plan.dig.map(q => new Vec3(q.x, q.y, q.z))
  const g0 = g.G(0, 0)
  const lowDig = q => q.y <= g.origin.y + 1 || (q.x === g0.x && q.z === g0.z)
  const digs = allDigs.filter(lowDig).sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  const highDigs = allDigs.filter(q => !lowDig(q)).sort((a, b) => a.y - b.y || a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
  for (let pass = 0; pass < 2 && !late(); pass++) {
    let left = 0
    for (const q of digs) { const w = await digOne(q); if (w && w !== 'не выкопано') return dropPlan({ ...report, built: false, stopped: `расчистка: ${w}` }); if (w) left++ }
    if (!left) break
  }
  // 3. Перемычки и стенки жёлоба внизу (с земли: j ≤ 1).
  const placeOne = async q => {
    if (solid(bot.blockAt(q))) return true
    const r = await placeBlockAt(bot, q, { steady: true, honest: true })
    if (r.ok) { report.placed++; return true }
    tr(`не поставил ${q.x},${q.y},${q.z}: ${r.reason}`)
    return false
  }
  for (const q of [g.F(-2, -1), g.F(3, -1), g.B(0, -1), g.B(1, -1), g.at(-1, -1), g.at(2, -1), g.F(-2, 0), g.F(3, 0), g.F(-2, 1), g.F(3, 1)]) {
    if (late()) break
    if (!(await placeOne(q)) && q.y <= g.origin.y - 1) return dropPlan({ ...report, built: false, stopped: `перемычка ${q.x},${q.y},${q.z} не встала — вода уйдёт` })
  }
  // Своё не копать: рама, опоры, стенки и дно жёлоба, пол берега, перемычки; столб под ногами.
  const own = new Set()
  for (let i = -1; i <= 2; i++) for (const j of [-1, 0, 1, 2, 3]) if (!((i === 0 || i === 1) && j >= 0 && j <= 1)) own.add(keyOf(g.at(i, j)))
  for (const i of [-2, 3]) for (let j = -1; j <= 3; j++) own.add(keyOf(g.F(i, j)))
  for (let i = -2; i <= 3; i++) { own.add(keyOf(g.F(i, -2))); own.add(keyOf(g.G(i, -1))); own.add(keyOf(g.at(i, -2))) }
  for (const q of [g.F(-1, 3), g.F(2, 3), g.B(0, -1), g.B(1, -1)]) own.add(keyOf(q))
  let h = 0
  const isOwn = q => own.has(keyOf(q)) || (q.x === g0.x && q.z === g0.z && q.y < g0.y + h)
  // Прицел в грань refs (жидкость ляжет в expect); луч упёрся в постороннее ближе грани — выкопать и ещё раз (rt-L1:
  // невыкопанная клетка жёлоба, порода над берегом в пещере).
  const aimClear = async (refs, expect) => {
    let why = 'нет грани'
    for (let k = 0; k < 3; k++) {
      for (const [ref, face] of refs) { const a = C().aimFor(bot, ref, face, expect); if (a) return { aim: a } }
      const [ref, face] = refs[0]
      if (!solid(bot.blockAt(ref))) {
        if (!(await placeOne(ref))) return { why: `опоры ${ref.x},${ref.y},${ref.z} нет` }
        continue
      }
      const c = ref.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
      const e = C().eyes(bot)
      const d = e.distanceTo(c)
      if (d > 4.4) return { why: `до грани ${Math.round(d * 10) / 10} бл. — не достать` }
      const l = C().landing(bot, c)
      if (!l) return { why: `луч к грани ${ref.x},${ref.y},${ref.z} — в пустоту` }
      const hit = l.hit
      why = `луч к грани ${ref.x},${ref.y},${ref.z} упирается в ${hit.x},${hit.y},${hit.z}`
      if (hit.equals(ref) || isOwn(hit) || e.distanceTo(hit.offset(0.5, 0.5, 0.5)) > d + 0.3) return { why }
      const w = await digOne(hit)
      if (w) return { why: `${why}: ${w}` }
      tr(`луч: выкопал ${hit.x},${hit.y},${hit.z}`)
    }
    return { why }
  }
  // Вода в ведро из любого источника рядом (своя в жёлобе, легла не туда — rt-L1 слот 8 «вода не видна за 1.2 с»).
  const regainWater = async () => {
    if (cnt('water_bucket')) return true
    if (!cnt('bucket')) return false
    const me = C().eyes(bot)
    const e = me.floored()
    const cand = []
    for (let dx = -5; dx <= 5; dx++) {
      for (let dy = -5; dy <= 4; dy++) {
        for (let dz = -5; dz <= 5; dz++) {
          const q = e.offset(dx, dy, dz)
          const b = bot.blockAt(q)
          if (b && b.name === 'water' && C().levelOf(b) === 0) cand.push(q)
        }
      }
    }
    cand.sort((a, b) => a.offset(0.5, 0.5, 0.5).distanceTo(me) - b.offset(0.5, 0.5, 0.5).distanceTo(me))
    for (const q of cand.slice(0, 10)) {
      const aim = C().scoopAim(bot, q)
      if (!aim) continue
      await useAt(bot, aim, 'bucket')
      if (cnt('water_bucket')) { tr(`вода в ведро из ${q.x},${q.y},${q.z}`); return true }
      if (cnt('lava_bucket')) return false
    }
    return false
  }
  // Лаву из ведра — назад в озеро: клетка озера без источника (воздух, текущая лава) с опорой под или сбоку.
  const dumpLava = async () => {
    if (!cnt('lava_bucket')) return true
    for (let i = -4; i <= 5; i++) {
      for (const row of ['H', 'I', 'J', 'K']) {
        for (const dy of [-1, -2]) {
          const q = g[row](i, dy)
          const b = bot.blockAt(q)
          if (!b || !(isAirB(b) || (b.name === 'lava' && C().levelOf(b) !== 0))) continue
          for (const [ref, face] of [[q.offset(0, -1, 0), UP], ...SIDES4.map(v => [q.minus(v), v])]) {
            if (!solid(bot.blockAt(ref))) continue
            const aim = C().aimFor(bot, ref, face, q)
            if (aim && await useAt(bot, aim, 'lava_bucket')) { tr(`лава назад в озеро ${q.x},${q.y},${q.z}`); return true }
          }
        }
      }
    }
    return false
  }
  // Со столба лавы по лучу нет, а по расстоянию есть — выкопать то, что закрывает луч (порода над озером в пещере), если
  // рядом с ним нет лавы (вскрыть озеро сбоку — нельзя).
  const clearLavaRay = async () => {
    const e = C().eyes(bot)
    const cands = []
    for (let i = -4; i <= 5; i++) {
      for (const row of ['H', 'I', 'J', 'K']) {
        for (const dy of [-1, -2]) {
          const p = g[row](i, dy)
          const b = bot.blockAt(p)
          if (!b || b.name !== 'lava' || C().levelOf(b) !== 0 || used.has(keyOf(p)) || !isAirB(bot.blockAt(p.plus(UP)))) continue
          const P = p.offset(0.5, 0.8, 0.5)
          if (e.distanceTo(P) <= 4.3) cands.push({ p, P, d: e.distanceTo(P) })
        }
      }
    }
    cands.sort((a, b) => a.d - b.d)
    for (const c of cands.slice(0, 4)) {
      for (let k = 0; k < 3 && !late(); k++) {
        if (C().scoopAim(bot, c.p)) return true
        const d = c.P.minus(e)
        const n = Math.ceil(d.norm() / 0.08)
        let hit = null
        let last = null
        for (let m = 1; m < n; m++) {
          const q = e.plus(d.scaled(m / n)).floored()
          if (last && q.equals(last)) continue
          last = q
          if (q.equals(c.p)) break
          const b = bot.blockAt(q)
          if (b && b.boundingBox === 'block' && !fluid(b)) { hit = q; break }
        }
        if (!hit || isOwn(hit)) break
        if ([...SIDES4, UP, DOWN].some(v => /lava/.test((bot.blockAt(hit.plus(v)) || {}).name || ''))) break
        const w = await digOne(hit)
        if (w) break
        tr(`луч к лаве ${c.p.x},${c.p.y},${c.p.z}: выкопал ${hit.x},${hit.y},${hit.z}`)
      }
    }
    return false
  }
  // 3а. Лава в ведре (прошлый заход оборвался между лавой и водой): долить ею клетку, у которой вода ещё стоит в жёлобе,
  // иначе назад в озеро. Потом воду — в ведро.
  if (cnt('lava_bucket') && !cnt('water_bucket')) {
    let fixed = false
    for (const t of cells(g)) {
      if (t.h > 0 || (bot.blockAt(t.c) || {}).name === 'obsidian') continue
      const wb = bot.blockAt(t.w)
      if (!wb || !/water/.test(wb.name)) continue
      const lr = await pourInto(bot, 'lava_bucket', t.lava)
      if (lr.ok) {
        const tq = gameClock.now()
        while (gameClock.now() - tq < 800 && (bot.blockAt(t.c) || {}).name !== 'obsidian') await sleep(40)
        tr(`лава из ведра → ${t.c.x},${t.c.y},${t.c.z}: ${(bot.blockAt(t.c) || {}).name}`)
        if ((bot.blockAt(t.c) || {}).name === 'obsidian') report.cast.push(xyz(t.c))
        fixed = true
        break
      }
    }
    if (!fixed) fixed = await dumpLava()
    if (!cnt('water_bucket')) await regainWater()
    if (!cnt('water_bucket') && cnt('bucket')) await require('./obsidian').fillBucket(session, ctl, { fluid: 'water', radius: 32 })
    if (!cnt('water_bucket')) return { ...report, built: false, stopped: cnt('lava_bucket') ? 'в ведре лава — вылить некуда' : 'нет воды в ведре' }
  }
  // 4. Клетки.
  const used = new Set()
  const digKeys = new Set(plan.dig.map(q => `${q.x},${q.y},${q.z}`))
  const syncH = () => { const f = bot.entity.position.floored(); h = (f.x === g0.x && f.z === g0.z) ? Math.max(0, f.y - g0.y) : 0 }
  const climb = async want => {
    let fails = 0
    while (h < want && !late()) {
      await C().dryFeet(bot, ctl, 2500)
      // Потолок над головой (клетка столба не выкопалась с земли) — выкопать до прыжка.
      const f0 = bot.entity.position.floored()
      const hd = bot.blockAt(f0.offset(0, 2, 0))
      if (hd && hd.boundingBox === 'block' && !fluid(hd) && !isOwn(hd.position)) await digOne(hd.position)
      const t = await towerUp(bot, ctl, 1, { sneak: true })
      report.placed += t.placed || 0
      await sleep(120)
      syncH()
      if (t.placed) continue
      const why = (t.why || []).join('; ') || t.reason || '?'
      if (++fails >= 3) return `столб не вырос (${why})`
      tr(`столб: ${why} — ещё раз`)
      const f = bot.entity.position.floored()
      const head = bot.blockAt(f.offset(0, 2, 0))
      if (head && !isAirB(head) && !fluid(head) && !isOwn(head.position)) await digOne(head.position)
      await C().centreOn(bot, ctl, f)
    }
    return h >= want ? null : 'время вышло на столбе'
  }
  // Высота по факту: прошлый заход мог оставить тело на своём столбе (rt-L3 слот 14: h считалось 0 — «луч к грани»).
  syncH()
  const topLeft = () => cells(g).filter(t => t.h > 0 && (bot.blockAt(t.c) || {}).name !== 'obsidian').length
  // Вода вне жёлоба (берег, над озером, за рамой): где и какая — для разбора.
  const strayWater = () => {
    const out = []
    for (let i = -3; i <= 4; i++) {
      for (let j = -1; j <= 4; j++) {
        for (const q of [g.G(i, j), g.H(i, j), g.I(i, j), g.B(i, j), g.at(i, j)]) {
          const b = bot.blockAt(q)
          if (b && /water/.test(b.name)) out.push(`${q.x},${q.y},${q.z}(${C().levelOf(b)})`)
        }
      }
    }
    return out
  }
  const castCell = async t => {
    if ((bot.blockAt(t.c) || {}).name === 'obsidian') return { ok: true, already: true }
    // Мусор в клетке и в её воде (застыло камнем, не выкопано) — выкопать.
    for (const q of [t.c, t.w]) {
      const b = bot.blockAt(q)
      if (b && !isAirB(b) && !fluid(b)) { const w = await digOne(q); if (w && !/огонь/.test(w)) return { ok: false, why: `клетка ${q.x},${q.y},${q.z} занята (${b.name}): ${w}` } }
    }
    if (!cnt('water_bucket') && !(await regainWater())) return { ok: false, fatal: true, why: 'воды в ведре нет' }
    // Всё — до воды: прицелы воды и лавы, источник в озере и луч к нему.
    const dbgWater = () => { const out = []; const o = g.G(0, 0); for (let dx = -5; dx <= 5; dx++) for (let dy = -2; dy <= 5; dy++) for (let dz = -5; dz <= 5; dz++) { const b = bot.blockAt(o.offset(dx, dy, dz)); if (b && /water/.test(b.name)) out.push(`${o.x + dx},${o.y + dy},${o.z + dz}:${C().levelOf(b)}`) } return out.join(' ') || 'нет' }
    if (process.env.ND_CAST1_DEBUG === '2') tr(`до клетки ${t.c.x},${t.c.y},${t.c.z}: вода ${dbgWater()}`)
    const wa = await aimClear(t.water, t.w)
    if (!wa.aim) return { ok: false, why: `вода: ${wa.why}` }
    if (process.env.ND_CAST1_DEBUG === '2') tr(`прицел воды готов: вода ${dbgWater()}`)
    const ca = await aimClear(t.lava, t.c)
    if (!ca.aim) return { ok: false, why: `лава: ${ca.why}` }
    let Ls = lavaInReach(bot, g, used, { high: h > 0, keep: h > 0 ? 0 : topLeft(), dig: digKeys })
    if (!Ls.length && h > 0 && await clearLavaRay()) Ls = lavaInReach(bot, g, used, { high: true })
    if (!Ls.length) { const R = lakeReach(p => bot.blockAt(p), g); return { ok: false, fatal: true, why: `${h > 0 ? 'лавы со столба не достать' : 'лавы в досягаемости нет'} (h ${h}; источников по геометрии: с земли ${R.ground.size}, со столба ${R.top.size})` } }
    const L = Ls[0]
    const sAim = C().scoopAim(bot, t.w) || t.w.offset(0.5, 0.5, 0.5)
    // Четыре клика подряд: вода → черпак лавы → лава в клетку → вода назад.
    const t1 = gameClock.now()
    if (!(await useAt(bot, wa.aim, 'water_bucket'))) return { ok: false, why: 'ведро воды не опустело — луч упёрся не туда' }
    const st = [gameClock.now() - t1]
    if (!(await useAt(bot, L.aim, 'bucket')) || !cnt('lava_bucket')) {
      used.add(keyOf(L.p))
      if (!cnt('water_bucket')) await useAt(bot, sAim, 'bucket')
      if (!cnt('water_bucket')) await regainWater()
      return { ok: false, why: `лава ${L.p.x},${L.p.y},${L.p.z} не зачерпнулась` }
    }
    used.add(keyOf(L.p))
    report.refills++
    st.push(gameClock.now() - t1)
    if (!(await useAt(bot, ca.aim, 'lava_bucket'))) {
      await dumpLava()
      await useAt(bot, sAim, 'bucket')
      if (!cnt('water_bucket')) await regainWater()
      return { ok: false, why: 'лава не вылилась в клетку' }
    }
    st.push(gameClock.now() - t1)
    let nowC = bot.blockAt(t.c)
    if (!nowC || nowC.name !== 'obsidian') {
      const tq = gameClock.now()
      while (gameClock.now() - tq < 120 && (bot.blockAt(t.c) || {}).name !== 'obsidian') await sleep(10)
      nowC = bot.blockAt(t.c)
    }
    if (nowC && nowC.name === 'obsidian') {
      let back = await useAt(bot, sAim, 'bucket')
      const win = gameClock.now() - t1
      const wb = bot.blockAt(t.w)
      const dbg = [`шаги ${st.join('/')}/${win} мс, w ${wb ? wb.name : '?'}${wb && /water/.test(wb.name) ? C().levelOf(wb) : ''}, вёдра в${cnt('water_bucket')} л${cnt('lava_bucket')} п${cnt('bucket')}`]
      if (process.env.ND_CAST1_DEBUG === '1') { await sleep(300); const wb2 = bot.blockAt(t.w); const ch = []; for (let i = -1; i <= 2; i++) for (let j = -1; j <= 4; j++) { const b = bot.blockAt(g.F(i, j)); if (b && /water/.test(b.name)) ch.push(`F${i},${j}:${C().levelOf(b)}`) } dbg.push(`через 300 мс w ${wb2 ? wb2.name : '?'}; жёлоб ${ch.join(' ') || 'сух'}; вне ${strayWater().length}`) }
      if (!back || !cnt('water_bucket')) back = await regainWater()
      report.cast.push(xyz(t.c))
      report.win = Math.max(report.win || 0, win)
      if (!back) return { ok: false, fatal: true, why: `свою воду не забрал (${t.w.x},${t.w.y},${t.w.z})` }
      return { ok: true, win, dbg: dbg.join('; ') }
    }
    // Не застыла: вода легла не туда. Лаву из клетки — в ведро и в озеро, воду найти.
    const lb = bot.blockAt(t.c)
    tr(`лава не застыла в ${t.c.x},${t.c.y},${t.c.z} (${lb && lb.name}); у w ${(bot.blockAt(t.w) || {}).name}`)
    if (lb && lb.name === 'lava') { const a = C().scoopAim(bot, t.c); if (a) await useAt(bot, a, 'bucket') }
    await dumpLava()
    if (!cnt('water_bucket')) await regainWater()
    if (cnt('lava_bucket')) return { ok: false, fatal: true, why: 'лава не застыла, в ведре лава' }
    return { ok: false, why: 'лава не застыла (вода не рядом?)' }
  }
  let stopped = null
  let wet = false
  for (const t of cells(g)) {
    const threat = hazard(bot.entity.position)
    if (threat) { stopped = `CAST_UNSAFE: ${threat.name}`; break }
    if (late()) { stopped = 'время вышло — позови ещё раз, продолжу с этой рамы'; break }
    if ((bot.blockAt(t.c) || {}).name === 'obsidian') { tr(`${t.c.x},${t.c.y},${t.c.z}: obsidian`); continue }
    // Нижняя клетка, а тело на столбе (прошлый заход) — вниз.
    if (t.h === 0 && h > 0) { await C().descend(bot, ctl, g0.y, report); syncH() }
    if (t.h > h) {
      // Наверх: столб 2 в G(0), стенки жёлоба j=2,3, после стоек — подпорки в проёме и уголки жёлоба.
      if (h === 0) { await goG(0); await C().centreOn(bot, ctl, g.G(0, 0)) }
      const w = await climb(t.h)
      if (w) { stopped = w; break }
      // Со столба — расчистка верха (чаша озера ниже рельефа: жёлоб и рама выше земли — в породе; lab ow-c1c bowl).
      for (let pass = 0; pass < 2 && !late(); pass++) {
        let left = 0
        for (const q of highDigs) { const w2 = await digOne(q); if (w2 && w2 !== 'не выкопано') { stopped = `расчистка верха: ${w2}`; break } if (w2) left++ }
        if (stopped || !left) break
      }
      if (stopped) break
      for (const q of [g.F(-2, 2), g.F(3, 2), g.F(-2, 3), g.F(3, 3)]) await placeOne(q)
    }
    if (t.top) {
      for (const q of [g.at(0, 2), g.at(1, 2), g.F(-1, 3), g.F(2, 3)]) {
        if (!(await placeOne(q))) { stopped = `подпорка ${q.x},${q.y},${q.z} не встала`; break }
      }
      if (stopped) break
    }
    let r = await castCell(t)
    for (let k = 0; k < 2 && !r.ok && !r.fatal && !late(); k++) { tr(`${t.c.x},${t.c.y},${t.c.z}: ${r.why} — ещё раз${bot._ndCast1Drop ? ` [${bot._ndCast1Drop}]` : ''}`); bot._ndCast1Drop = null; r = await castCell(t) }
    tr(`${t.c.x},${t.c.y},${t.c.z}: ${r.ok ? `obsidian${r.dbg ? ` (${r.dbg})` : ''}` : r.why}`)
    if (!wet) { const sw = strayWater(); if (sw.length) { wet = true; tr(`вода вне жёлоба: ${sw.slice(0, 6).join(' ')}${sw.length > 6 ? ` …всего ${sw.length}` : ''}`) } }
    if (!r.ok) { stopped = `клетка ${t.c.x},${t.c.y},${t.c.z}: ${r.why}`; break }
  }
  // 5. Подпорки из проёма долой, вниз со столба.
  if (!stopped) {
    for (const q of [g.at(0, 2), g.at(1, 2)]) {
      const b = bot.blockAt(q)
      if (b && !isAirB(b) && !fluid(b)) await digOne(q)
    }
  }
  if (h > 0) await C().descend(bot, ctl, g.G(0, 0).y, report)
  const frame = [g.at(0, -1), g.at(1, -1), g.at(-1, 0), g.at(-1, 1), g.at(-1, 2), g.at(2, 0), g.at(2, 1), g.at(2, 2), g.at(0, 3), g.at(1, 3)]
  const done = frame.filter(q => (bot.blockAt(q) || {}).name === 'obsidian').length
  const built = done === 10
  return { ...report, built, frame: `${done}/10 обсидиан`, seconds: Math.round((gameClock.now() - t0) / 1000), stopped: built ? undefined : (stopped || `рама не собралась: ${done}/10`) }
}

module.exports = { castOne, plan1, judge1, geom1, cells, lakeReach, useAt, PLACE1 }
