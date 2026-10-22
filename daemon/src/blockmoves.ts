'use strict'
// Спидраннерские ходы блоками как ходы pathfinder'а (TODO.md «Спидраннерское перемещение блоками», шаги 2–4;
// поток movement, 02.10.2026). Включается ND_BRIDGE=1 (по умолчанию — выкл. до замера на ферме).
//
// Мост на ходу. mineflayer-pathfinder мостит так: на каждый блок fullStop, присед и шаг назад к краю
// (moveToEdge), equip, placeBlock с ожиданием ответа сервера, возврат в центр клетки — и пересчёт всего пути
// (blockUpdate рядом с путём → resetPath('block_updated')). Над пустотой глубже пяти клеток мост у нас вообще
// запрещён (session.updateMovements, цена 100 — после падения с моста на 52 блока 26.09). Спидраннер мостит
// иначе: идёт спиной к пропасти, не приседая, взгляд вниз на свою опору, и щёлкает по её боковой грани в тот
// тик, когда тело уже нависло над краем, а опора ещё держит (хитбокс 0.6: центр тела может уйти за край на
// 0.3). Новый блок встаёт под ноги до следующего тика физики — тело идёт дальше с той же скоростью.
//
// Механика (байткод Paper 1.21.11, codex-lab/clutch/placement-mechanics.md):
//   * UseItemOn: reach — от текущих глаз до AABB опоры < 5.5 (честно — 4.5); направление/взгляд/луч сервер
//     не проверяет — видимость грани проверяем сами (pick.faceAim: прицел клиента, не сквозь стену);
//   * BlockItem.canPlace → Level.checkEntityCollision по ТЕКУЩЕМУ AABB игрока, касание граней (ноги ровно на
//     верхней грани клетки, ±1e-7) разрешено — ставить под себя, стоя на краю опоры, можно;
//   * клетка-цель: воздух, вода (replaceable), трава, снег в 1 слой; лава — тоже replaceable, но над лавой не
//     мостим (провал = смерть);
//   * ответ сервера — block_update опоры и клетки; отказ — тот же пакет с прежним состоянием.
// Порядок тика mineflayer: simulatePlayer → physicsTick → пакет позиции → событие move. Решение — на physicsTick
// по позиции, которая уйдёт пакетом этого тика; щелчок — на move (сервер проверит его по той же позиции).
// Своё предсказание блока кладём в мир тихо (без blockUpdate): иначе pathfinder сбрасывает путь на каждом блоке.
// Ответ сервера с тем же состоянием путь не сбрасывает (тип не изменился), отказ — сбрасывает (это и нужно).
//
// Сорвалось (отказ, нет грани) — тело падает, а там уже сторож падения: блочный клатч (clutch.js) и ведро.

import { Vec3 } from 'vec3'
import { REPLACE, FILLER, replaceable, replanSig, replanCount, goalKey, fixPath } from './blockmoves/cells'
import { geometry, decide, steerTo } from './blockmoves/geometry'
import { install } from './blockmoves/exec'
// Ход pathfinder'а — один раз, не require() на каждый ход моста/спуска внутри A* (S9).
let MoveCls
const MoveOf = () => MoveCls || (MoveCls = require('mineflayer-pathfinder/lib/move'))

const INTERACTIVE = /chest|barrel|furnace|crafting_table|enchanting_table|anvil|door|trapdoor|button|lever|bed|shulker|hopper|dispenser|dropper|smoker|loom|stonecutter|grindstone|cartography_table|smithing_table|composter|note_block|jukebox|respawn_anchor|fence|wall|gate/

// По умолчанию включено (02.10, после серий mv-gap-1..4, mv-terr-1..3, MLG 24/24); ND_BRIDGE=0 — выключить.
function on () { return process.env.ND_BRIDGE !== '0' }

// Опора, по грани которой щёлкаем: полный куб, не «интерактивный» (сундук открылся бы вместо постановки).
function fullCube (b) {
  return !!(b && b.boundingBox === 'block' && !INTERACTIVE.test(b.name || '') && Array.isArray(b.shapes) &&
    b.shapes.length === 1 && b.shapes[0].every((v, i) => v === (i < 3 ? 0 : 1)))
}

// Что под клеткой моста: глубина воздуха до опоры, вода, лава (до max клеток вниз).
function below (getBlock, x, y, z, max = 24) {
  for (let d = 1; d <= max; d++) {
    const b = getBlock(x, y - d, z)
    if (!b) return { depth: d, unknown: true }
    if (/lava/.test(b.name || '')) return { depth: d, lava: true }
    if (/water|bubble_column/.test(b.name || '')) return { depth: d, water: true }
    if (b.boundingBox === 'block') return { depth: d }
  }
  return { depth: max + 1, void: true }
}

// ---------------------------------------------------------------- A*: ход «мост»
// Ход вперёд на клетку, под которой пусто: блок под ноги на ходу. Цена — во «времени шага» pathfinder'а
// (1 ≈ 0.23 с пешком без спринта): шаг 1 + блок (добыть его стоит времени) + риск над глубокой пустотой.
// Исходный медленный мост pathfinder'а в ту же клетку убираем — исполнять будет наш исполнитель.
// Целые координаты узла. postProcessPath pathfinder'а правит x/y/z узлов частичного пути на месте (центр клетки,
// верх опоры), а это те же объекты, что раскрывает A*, — исходные координаты сохранены в hash ("x,y,z").
function cellOf (node) {
  if (typeof node.hash === 'string') {
    const [x, y, z] = node.hash.split(',').map(Number)
    if (Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z)) return { x, y, z }
  }
  return { x: Math.floor(node.x), y: Math.floor(node.y), z: Math.floor(node.z) }
}

// Цена блока — от запаса (агент Ада 14.10, b8-6-3: мосты поиска бастиона съели 128 → 17 за 6 мин, затем 0 и тупик «пути нет»):
// пока запас втрое больше резерва — прежняя цена, дальше растёт обратно остатку сверх резерва; у резерва — запрет (как было).
// ND_BLOCK_SCARCITY=0 — прежняя постоянная цена.
function scarceCost (base, remaining, reserve = 0) {
  if (process.env.ND_BLOCK_SCARCITY === '0' || !Number.isFinite(remaining)) return base
  const spare = Math.max(1, remaining - reserve)
  return base * Math.max(1, 48 / spare)
}

function bridgeMove (mv, node, dir, opts: any = {}) {
  if (!(node.remainingBlocks > (opts.reserve ?? 0))) return null
  const o = cellOf(node)
  const B = mv.getBlock(o, dir.x, 1, dir.z)
  const C = mv.getBlock(o, dir.x, 0, dir.z)
  const D = mv.getBlock(o, dir.x, -1, dir.z)
  if (!D || !D.position || D.physical || !replaceable(D)) return null
  if (!C.position || C.liquid || !C.safe || !B.safe) return null
  if (mv.getNumEntitiesAt(D.position, 0, 0, 0) > 0 || mv.getNumEntitiesAt(C.position, 0, 0, 0) > 0) return null
  // Опора: настоящий полный куб под узлом или блок нашего же моста (узел-мост, его блок встанет раньше).
  if (node.ndDescend) return null // со ступени спуска — не мостить (ветвление)
  if (!node.ndBridge && !fullCube(mv.getBlock(o, 0, -1, 0))) return null
  // Длина моста над пустотой — не больше maxChain: иначе в открытом небе (столб, обрыв) A* обходит бескрайнюю
  // «летающую плоскость» из узлов-мостов и не находит пути за 5 с (ферма 02.10, mv-mlg-3: столб 60 на листве, 2100
  // частичных путей и 24 блока моста в пустоту). Над водой — длиннее (река).
  const chain = (node.ndBridge ? node.ndBridge.n || 1 : 0) + 1
  const u = below((x, y, z) => mv.bot.blockAt(new Vec3(x, y, z), false), D.position.x, D.position.y, D.position.z, opts.depthMax ?? 24)
  if (u.lava || u.unknown) return null
  // Арена по поверхности (session.updateMovements, surfaceStrict): только мост над водой — над ямами и обрывами нет.
  if (opts.waterOnly && !u.water) return null
  // Мелкая яма (твёрдое в 1–2 под клеткой) — шагнуть вниз и вверх дешевле блока, а лишние ходы над каждым склоном
  // раздувают поиск на холмах: на рельефе A* с мостами искал в 1.5 раза дольше (ферма 02.10, mv-terr-2: 4.5 с против
  // 2.9, 11.8 против 7.3). Мост — только над провалом от 3 (обрыв, овраг, пустота) и над водой.
  if (!u.water && u.depth < (opts.minDepth ?? 3)) return null
  // Пустота без дна (Край: падение = смерть) — только если разрешено.
  if (u.void && opts.voidOk === false) return null
  if (chain > (u.water ? (opts.maxChainWater ?? 32) : (opts.maxChain ?? 8))) return null
  // Цель goto заметно ниже (выше) уровня моста — мост её не приближает, а в открытом небе (столб, обрыв) A* утекал в
  // мосты и не находил спуска (ферма 02.10, mv-mlg-4: столб 20 без ведра — 40 с вместо 12.5). Мост — у высоты цели ±3.
  const gy = typeof opts.goalY === 'function' ? opts.goalY() : null
  if (gy != null && Math.abs(C.position.y - gy) > (opts.goalBand ?? 3)) return null
  // Над водой мост дешевле: плыть вдвое медленнее шага, а из глубокой реки pathfinder выплывал через раз (mv-gap-1:
  // wait 2/6, base 1/6); при цене 2.5 за клетку A* выбирал то мост, то плавание (mv-gap-3: 0 блоков, 7.7 с).
  let cost = 1 + scarceCost(u.water ? (opts.waterCost ?? 0.5) : (opts.blockCost ?? 1.5), node.remainingBlocks, opts.reserve ?? 0)
  if (!u.water && u.depth >= 4) cost += opts.deepCost ?? 0.5
  // Без дна в пределах depthMax (небо, бездонный обрыв) — сорвался, и не спасёт уже ничто: дороже (ферма 02.10,
  // mv-gap-6: на лавовом озере A* обходил лаву мостом над пустотой за стендом, своя постановка pathfinder'а там
  // сорвалась — падение 120 блоков).
  if (u.void) cost += opts.voidCost ?? 2.5
  // S1f: над смертельной высотой (lethalDepth: падение ≥ хп) отказ сервера или срыв = смерть (s1f-A2-1: мост в Аду на y 80 над
  // провалом 26, «отказ сервера», падение — смерть на 12-й с). Цена риска (P(срыв) ~0.01 × час) больше любого обхода — такой мост
  // не строим; копка и обход дешевле. Над водой — можно.
  if (opts.lethalDepth && !u.water && u.depth >= opts.lethalDepth) return null
  cost += mv.exclusionStep(C)
  if (cost >= 100) return null
  const Move = opts.Move || MoveOf()
  const m = new Move(C.position.x, C.position.y, C.position.z, node.remainingBlocks - 1, cost, [], [], false)
  m.ndBridge = { ref: { x: o.x, y: o.y - 1, z: o.z }, dir: { x: dir.x, z: dir.z }, y: C.position.y, depth: u.depth, water: !!u.water, n: chain }
  return m
}

// ---------------------------------------------------------------- A*: ход «спуск блоками»
// Обрыв без воды: стоя на краю (или на блоке своей лестницы), поставить блок на БОКОВУЮ грань стены на 3 ниже ног
// (клетка C = узел + d, y − 3), шагнуть — падение 2 (без урона: floor(2 − 3) < 0), встать на блок. Следующая
// ступень — вдоль стены (опора — грань стены сбоку от C). Расчёт Codex на prismarine-physics
// (codex-lab/mv-descent/sim.js): ступень 10–13 тиков, 20 блоков высоты — 6.8 с и 9 блоков; грань видна с края (свес
// s > 0) для первой ступени и из центра блока — для ступеней вдоль стены (4.05 ≤ 4.5).
function descendMove (mv, node, dir, opts: any = {}) {
  if (!(node.remainingBlocks > (opts.reserve ?? 0))) return null
  const o = cellOf(node)
  if (node.ndBridge) return null // с моста — не спускаться (ветвление поиска)
  // Сразу после копки (узел с toBreak: «прокопать под собой и спуститься из ямки») — нет: частичный путь с такой копкой
  // pathfinder начинает исполнять, пока ищет, и роет край обрыва из-под себя (ферма 02.10, mv-cliff-dbg2).
  if (node.toBreak && node.toBreak.length) return null
  // Разворот лестницы (зигзаг) — нет: голова упрётся в свою же прошлую ступень, которой на плане ещё нет (Codex,
  // mv-descent: «zigzag reversal must be blocked by old support above head»).
  if (node.ndDescend && node.ndDescend.dir.x === -dir.x && node.ndDescend.dir.z === -dir.z) return null
  const supportOk = node.ndDescend || fullCube(mv.getBlock(o, 0, -1, 0))
  if (!supportOk) return null
  // Шаг: ноги и голова над краем, потом 2 клетки падения (ноги и голова цели).
  for (const dy of [1, 0, -1, -2]) {
    const b = mv.getBlock(o, dir.x, dy, dir.z)
    if (!b.position || !b.safe || b.liquid || b.climbable) return null
  }
  const C = mv.getBlock(o, dir.x, -3, dir.z)
  if (!C.position || C.physical || !replaceable(C) || /lava|water/.test(C.name || '')) return null
  if (mv.getNumEntitiesAt(C.position, 0, 0, 0) > 0) return null
  // Под клеткой не лава (сорвался — не в лаву).
  const u = below((x, y, z) => mv.bot.blockAt(new Vec3(x, y, z), false), C.position.x, C.position.y, C.position.z, opts.depthMax ?? 24)
  if (u.lava || u.unknown) return null
  if (u.void && opts.voidOk === false) return null
  // Пол близко (обычный спрыгнуть ≤ 3 справится) или вода внизу — спуск не нужен.
  if (u.water || u.depth <= 1) return null
  // Опора для щелчка: стена под краем (C − d) или стена сбоку (C ± p). Только настоящий полный куб.
  const p = { x: dir.z, z: -dir.x }
  let ref = null
  for (const r of [{ x: -dir.x, z: -dir.z }, p, { x: -p.x, z: -p.z }]) {
    const b = mv.bot.blockAt(C.position.offset(r.x, 0, r.z), false)
    if (fullCube(b)) { ref = { pos: b.position, face: { x: -r.x, y: 0, z: -r.z } }; break }
  }
  if (!ref) return null
  let cost = 1 + scarceCost(opts.blockCost ?? 1.5, node.remainingBlocks, opts.reserve ?? 0) + (opts.descendCost ?? 1.5)
  const T = mv.getBlock(o, dir.x, -2, dir.z)
  cost += mv.exclusionStep(T)
  if (cost >= 100) return null
  const Move = opts.Move || MoveOf()
  const m = new Move(T.position.x, T.position.y, T.position.z, node.remainingBlocks - 1, cost, [], [], false)
  m.ndDescend = { cell: { x: C.position.x, y: C.position.y, z: C.position.z }, ref: { x: ref.pos.x, y: ref.pos.y, z: ref.pos.z }, face: ref.face, dir: { x: dir.x, z: dir.z }, from: o, y: T.position.y }
  return m
}

function addBridge (mv, opts: any = {}) {
  if (!mv || mv._ndBridge) return mv
  mv._ndBridge = opts
  const fwd = mv.getMoveForward
  mv.getMoveForward = function (node, dir, neighbors) {
    const n0 = neighbors.length
    fwd.call(this, node, dir, neighbors)
    let m = null
    try { m = bridgeMove(this, node, dir, opts) } catch { m = null }
    if (!m) {
      // Custom rejected this bridge: do not retain the stock building move that it replaces.
      if (process.env.ND_LAVA_NAV_GUARD === '1' && /nether/.test(String(this.bot?.game?.dimension))) {
        for (let i = neighbors.length - 1; i >= n0; i--) {
          // useOne opens a gate; it does not place a support block.
          if (neighbors[i].toPlace?.some(p => !p.useOne)) neighbors.splice(i, 1)
        }
      }
      return
    }
    for (let i = neighbors.length - 1; i >= n0; i--) {
      const o = neighbors[i]
      if (o.x === m.x && o.y === m.y && o.z === m.z) neighbors.splice(i, 1)
    }
    neighbors.push(m)
  }
  // Спуск блоками — рядом с обычным «спрыгнуть» (getMoveDropDown вызывается для каждой стороны света).
  if (opts.descend !== false) {
    const drop = mv.getMoveDropDown
    mv.getMoveDropDown = function (node, dir, neighbors) {
      drop.call(this, node, dir, neighbors)
      let m = null
      try { m = descendMove(this, node, dir, opts) } catch { m = null }
      if (m && !neighbors.some(o => o.x === m.x && o.y === m.y && o.z === m.z)) neighbors.push(m)
    }
  }
  // Вниз сквозь свой же блок (getMoveDown: на плане под узлом-мостом воздух) — нет: тело стоит на настоящем блоке.
  const down = mv.getMoveDown
  if (typeof down === 'function') {
    mv.getMoveDown = function (node, neighbors) {
      if (node && (node.ndBridge || node.ndDescend)) return
      return down.call(this, node, neighbors)
    }
  }
  // Паркур с блока моста — нет: A* берёт его на последней щели в 1 (дешевле блока), а прыжок с только что
  // поставленного блока, когда тело идёт спиной, срывался (ферма 02.10, mv-gap-dbg4: «stuck» и падение в щель).
  const park = mv.getMoveParkourForward
  if (typeof park === 'function') {
    mv.getMoveParkourForward = function (node, dir, neighbors) {
      if (node && (node.ndBridge || node.ndDescend)) return
      return park.call(this, node, dir, neighbors)
    }
  }
  return mv
}

// Исполнитель моста и спуска блоками (install) — blockmoves/exec*.ts; клетки и путь — blockmoves/cells.ts, геометрия
// исполнителя — blockmoves/geometry.ts.
export {
  steerTo, replanSig, replanCount, goalKey, on, addBridge, bridgeMove, scarceCost, cellOf, fixPath, geometry,
  decide, install, below, fullCube, replaceable, REPLACE, FILLER
}
