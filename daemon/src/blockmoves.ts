'use strict'
const gameClock = require('./game-clock')
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

const { Vec3 } = require('vec3')
// Ход pathfinder'а — один раз, не require() на каждый ход моста/спуска внутри A* (S9).
let MoveCls
const MoveOf = () => MoveCls || (MoveCls = require('mineflayer-pathfinder/lib/move'))

// Мост по частичному пути над пустотой: ждать конца поиска не дольше (pathfinder сбрасывает путь «stuck» через 3.5 с).
const HOLD_MS = Number(process.env.ND_BRIDGE_HOLD_MS || 2500)
const REPLACE = /^(air|cave_air|void_air|water|short_grass|tall_grass|fern|large_fern|dead_bush|snow)$/
const INTERACTIVE = /chest|barrel|furnace|crafting_table|enchanting_table|anvil|door|trapdoor|button|lever|bed|shulker|hopper|dispenser|dropper|smoker|loom|stonecutter|grindstone|cartography_table|smithing_table|composter|note_block|jukebox|respawn_anchor|fence|wall|gate/
const FILLER = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt|[a-z_]+_planks)$/
const EYE = 1.62
const key = p => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

// По умолчанию включено (02.10, после серий mv-gap-1..4, mv-terr-1..3, MLG 24/24); ND_BRIDGE=0 — выключить.
function on () { return process.env.ND_BRIDGE !== '0' }

function replaceable (b) {
  return !!(b && REPLACE.test(b.name) && (b.name !== 'snow' || Number(b.getProperties?.().layers) === 1))
}
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

// Предел перестроек с одного места (S8b; S8c 07.10, замечание проверки в): подпись — причина и клетка (узел, клетка моста/ступени
// или опора; у причин без узла раньше была одна подпись на все клетки), счёт снимают сдвиг тела на 2+ бл. (продвинулись),
// новая цель и достигнутая цель (onGoal/onReached в install).
function replanSig (why, info?: any) {
  const c = info && (info.node || info.cell || info.ref)
  return `${why}|${Array.isArray(c) ? c.join(',') : ''}`
}
function replanCount (st, sig, pos) {
  const moved = !!(st.replanPos && pos && Math.hypot(pos.x - st.replanPos.x, pos.y - st.replanPos.y, pos.z - st.replanPos.z) >= 2)
  st.replanSame = sig === st.replanSig && !moved ? (st.replanSame || 0) + 1 : 1
  st.replanSig = sig
  if (st.replanSame === 1 && pos) st.replanPos = { x: pos.x, y: pos.y, z: pos.z }
  return st.replanSame
}
const goalKey = g => g ? JSON.stringify([g.constructor && g.constructor.name, g.x, g.y, g.z, g.rangeSq, g.goals && g.goals.length]) : ''

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
  let cost = 1 + (u.water ? (opts.waterCost ?? 0.5) : (opts.blockCost ?? 1.5))
  if (!u.water && u.depth >= 4) cost += opts.deepCost ?? 0.5
  // Без дна в пределах depthMax (небо, бездонный обрыв) — сорвался, и не спасёт уже ничто: дороже (ферма 02.10,
  // mv-gap-6: на лавовом озере A* обходил лаву мостом над пустотой за стендом, своя постановка pathfinder'а там
  // сорвалась — падение 120 блоков).
  if (u.void) cost += opts.voidCost ?? 2.5
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
  let cost = 1 + (opts.blockCost ?? 1.5) + (opts.descendCost ?? 1.5)
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
    if (!m) return
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

// postProcessPath pathfinder'а ставит узлу без опоры y − 1 (узел-мост висит над воздухом), и узел никогда не
// «достигается» (|dy| < 1). Вернуть высоту и центр клетки — на path_update, до того как исполнитель возьмёт путь.
function fixPath (path) {
  if (!Array.isArray(path)) return 0
  let n = 0
  for (const p of path) {
    const tag = p && (p.ndBridge || p.ndDescend)
    if (!tag) continue
    p.x = Math.floor(p.x) + 0.5
    p.y = tag.y
    p.z = Math.floor(p.z) + 0.5
    n++
  }
  return n
}

// ---------------------------------------------------------------- геометрия исполнителя
// s — насколько центр тела ушёл за плоскость боковой грани опоры (по ходу моста); 0 < s ≤ 0.3 — окно щелчка:
// глаза уже над пустотой (грань видна), а хитбокс ещё на опоре.
function geometry (pos, ref, dir) {
  const ax = dir.x ? 'x' : 'z'
  const sg = dir.x || dir.z
  const plane = ref[ax] + (sg > 0 ? 1 : 0)
  const lat = ax === 'x' ? 'z' : 'x'
  return { s: (pos[ax] - plane) * sg, off: pos[lat] - (ref[lat] + 0.5), ax, lat, plane }
}

// Клавиши и взгляд на тик: спиной по ходу моста («назад»), курс — на точку на оси моста впереди, взгляд — на
// центр боковой грани опоры. Окно — щёлкнуть после пакета этого тика.
function decide ({ pos, onGround, ref, dir, cellSolid, refSolid, pending, eye = EYE }: any) {
  const g = geometry(pos, ref, dir)
  // Лицом строго против хода (взгляд (−sin, −cos) = −dir), вбок — клавишей: «вправо» ведёт по (cos yaw, −sin yaw)
  // (prismarine-physics applyHeading). Тело, вошедшее в мост наискось, к оси подтягивается раньше края: иначе
  // pathfinder не засчитывает узел (|dz| > 0.35) и тело проезжает клетку (ферма 02.10, mv-gap-1 река: смещение 0.78).
  const yaw = Math.atan2(dir.x, dir.z)
  let strafe = null
  if (Math.abs(g.off) > 0.08) {
    const c = { x: 0, z: 0 }; c[g.lat] = -Math.sign(g.off)
    strafe = (Math.cos(yaw) * c.x - Math.sin(yaw) * c.z) > 0 ? 'right' : 'left'
  }
  const fx = g.ax === 'x' ? g.plane : ref.x + 0.5
  const fz = g.ax === 'z' ? g.plane : ref.z + 0.5
  const dy = (ref.y + 0.5) - (pos.y + eye)
  const pitch = Math.atan2(dy, Math.max(0.05, Math.hypot(fx - pos.x, fz - pos.z)))
  let place = false
  // Окно: глаза за гранью (s > 0), тело ещё на земле. Обычно это s ∈ (0, 0.3) — хитбокс 0.6 на опоре; дальше — только если
  // тело перенесли (fullStop pathfinder'а центрирует его в клетке без опоры, ревью Codex 02.10): поставить сейчас,
  // до следующего тика физики, — иначе падение.
  if (!cellSolid && !pending && refSolid && onGround && g.s > 1e-4 && g.s < 0.85 && Math.abs(g.off) < 0.75) place = true
  return { yaw, pitch, place, s: g.s, off: g.off, strafe }
}

// ---------------------------------------------------------------- исполнитель
function install (session, deps: any = {}) {
  const bot = session.bot
  if (!bot || bot._ndBridgeExec) return bot && bot._ndBridgeExec
  const faceAim = deps.faceAim || require('./pick').faceAim
  const now = deps.now || gameClock.now
  const hand = deps.hand || bot._ndHandLock || { hold () {}, on: () => false, as: fn => fn() }
  const log = deps.log || ((m, o) => console.log('[bridge] ' + m, o ? JSON.stringify(o) : ''))
  const stats: any = { placed: 0, confirmed: 0, denied: 0, timeout: 0, noFace: 0, stale: 0, noItem: 0, segments: 0, fell: 0 }
  const pending = new Map()
  const st: any = { stats, pending, seg: null, scheduled: null, stopped: false, replanAt: 0 }

  const nodes = () => (deps.nodes ? deps.nodes() : session.pathNodes)
  const moving = () => { try { return !!(bot.pathfinder && bot.pathfinder.isMoving()) } catch { return false } }
  const solidAt = (p) => { const b = bot.blockAt(p, false); return !!(b && b.boundingBox === 'block') }

  function filler () {
    const mv = bot.pathfinder && bot.pathfinder.movements
    const ids = new Set((mv && mv.scafoldingBlocks) || [])
    const bar = bot.inventory.slots.slice(36, 45).filter(i => i && FILLER.test(i.name))
    const sel = bot.inventory.slots[36 + bot.quickBarSlot]
    if (sel && FILLER.test(sel.name) && (!ids.size || ids.has(sel.type))) return sel
    return bar.find(i => !ids.size || ids.has(i.type)) || bar[0] || null
  }
  let preparing = false
  function prepare () {
    if (preparing || filler() || bot.currentWindow || hand.on()) return
    const mv = bot.pathfinder && bot.pathfinder.movements
    const ids = new Set((mv && mv.scafoldingBlocks) || [])
    const it = bot.inventory.items().find(i => i.slot < 36 && FILLER.test(i.name) && (!ids.size || ids.has(i.type)))
    if (!it) return
    let dest = -1
    for (let i = 36; i <= 44; i++) if (!bot.inventory.slots[i] && i !== 36 + bot.quickBarSlot) { dest = i; break }
    preparing = true
    const p = dest >= 0 ? bot.moveSlotItem(it.slot, dest) : bot.equip(it, 'hand')
    Promise.resolve(p).catch(() => {}).finally(() => { preparing = false })
  }

  function silentSet (p, id) {
    try {
      const col = bot.world.getColumnAt(p)
      if (!col) return false
      col.setBlockStateId(new Vec3(p.x & 15, p.y, p.z & 15), id)
      // Мимо событий мира — кеш блоков pathfinder'а (fastblocks.ts, S9) сбросить самим.
      if (bot._ndFastBlocks) bot._ndFastBlocks.invalidate(p.x, p.y, p.z)
      return true
    } catch { return false }
  }
  function receipt (p, id) {
    const k = key(p); const r = pending.get(k)
    if (!r) return
    pending.delete(k)
    // Тот же блок с другим состоянием (базальт/глубинный сланец — ось по грани) — тоже подтверждение (ревью Codex).
    const got = bot.registry.blocksByStateId && bot.registry.blocksByStateId[id]
    if (id === r.stateId || (got && got.name === r.name)) { stats.confirmed++; if (st.seg) st.seg.confirmed++ } else { stats.denied++; if (st.seg) st.seg.denied++; log('отказ сервера', { cell: [r.cell.x, r.cell.y, r.cell.z], got: got ? got.name : id }) }
  }
  const single = (pk) => { try { receipt(new Vec3(pk.location.x, pk.location.y, pk.location.z), pk.type) } catch {} }
  const multi = (pk) => {
    try {
      if (!pk.chunkCoordinates) return
      for (const r of pk.records) receipt(new Vec3(pk.chunkCoordinates.x * 16 + ((r >> 8) & 15), pk.chunkCoordinates.y * 16 + (r & 15), pk.chunkCoordinates.z * 16 + ((r >> 4) & 15)), r >> 12)
    } catch {}
  }
  function expire () {
    for (const [k, r] of [...pending]) {
      if (now() - r.sentAt < (deps.confirmMs ?? 1500)) continue
      pending.delete(k)
      stats.timeout++
      // Тишина сервера: своё предсказание — назад, уже с событием (pathfinder перестроит путь).
      try { const b = bot.blockAt(r.cell, false); if (b && b.stateId === r.stateId) bot.world.setBlockStateId(r.cell, r.oldStateId) } catch {}
    }
  }
  function cancelScheduled () {
    if (st.scheduled) { bot.removeListener('move', st.scheduled); st.scheduled = null }
  }
  function finish () {
    const s = st.seg
    if (!s) return
    st.seg = null
    const fell = bot.entity && bot.entity.position.y < s.y0 - 0.9
    if (fell) stats.fell++
    if (process.env.ND_DEBUG_BRIDGE) st.after = 30
    log('мост', { cells: s.cells, placed: s.placed, confirmed: s.confirmed, denied: s.denied, ms: now() - s.t0, fell: !!fell, y: bot.entity && Math.round(bot.entity.position.y * 100) / 100, stats })
    // Свои клавиши — отпустить: pathfinder «назад» не трогает никогда, и тело пятилось бы дальше (mv-gap-dbg6).
    try { for (const k of ['back', 'left', 'right']) bot.setControlState(k, false) } catch {}
  }
  function replan (why, info?: any) {
    if (now() - st.replanAt < 1000) return
    // Тот же отказ с того же места — новый поиск даёт тот же путь (s8b-a1-3: «путь не отсюда» узел 87.5,67 при теле 87.7,65 —
    // 62 перестройки подряд, 2.5 мин на месте): после трёх — не перестраивать, решают stuck и goto (ND_BRIDGE_REPLAN3=0 — выкл.).
    const e = bot.entity
    if (replanCount(st, replanSig(why, info), e && e.position) > 3 && process.env.ND_BRIDGE_REPLAN3 !== '0') return
    st.replanAt = now()
    log('перестроить путь', { why, ...info })
    try { bot.pathfinder.setMovements(bot.pathfinder.movements) } catch {}
  }
  function fire (snap, ref, dir, cell, item) {
    st.scheduled = null
    const e = bot.entity
    const skip = (why, extra?: any) => { stats.skip = (stats.skip || 0) + 1; if (process.env.ND_DEBUG_BRIDGE) log('не щёлкнул', { why, cell: [cell.x, cell.y, cell.z], ...extra }) }
    if (!e || e.position.distanceTo(snap) > 1e-7) { stats.stale++; return skip('позиция сменилась', { d: e && e.position.distanceTo(snap) }) }
    if (solidAt(cell) || pending.has(key(cell))) return skip('уже стоит')
    const rb = bot.blockAt(ref, false); const cb = bot.blockAt(cell, false)
    if (!rb || rb.boundingBox !== 'block') return skip('нет опоры', { ref: rb && rb.name })
    if (!replaceable(cb)) return skip('клетка занята', { cell: cb && cb.name })
    const face = new Vec3(dir.x, 0, dir.z)
    const eye = e.position.offset(0, EYE, 0)
    const point = faceAim(bot, ref, face, { eye, range: 4.5 })
    if (!point) { stats.noFace++; return skip('грань не видна', { eye: [eye.x, eye.y, eye.z] }) }
    const def = bot.registry.blocksByName[item.name]
    if (!def) return skip('нет блока ' + item.name)
    // Рука — на этот пакет: дольше держать нельзя, следующий блок через ~4.6 тика (230 мс) — свой же замок
    // пропустил бы окно (mv-gap-dbg4: щелчок на s 0.26 вместо 0.05).
    hand.hold(50)
    hand.as(() => {
      const d = point.minus(eye)
      const yaw = Math.atan2(-d.x, -d.z); const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
      try {
        bot._client.write('look', { yaw: 180 - yaw * 180 / Math.PI, pitch: -pitch * 180 / Math.PI, onGround: !!e.onGround, flags: { onGround: !!e.onGround, hasHorizontalCollision: !!e.isCollidedHorizontally } })
      } catch {}
      if (bot.quickBarSlot !== item.slot - 36) bot.setQuickBarSlot(item.slot - 36)
      if (!bot.heldItem || bot.heldItem.name !== item.name) { skip('в руке не блок', { held: bot.heldItem && bot.heldItem.name }); return }
      const rec = { cell: cell.clone(), name: def.name, stateId: def.defaultState, oldStateId: cb.stateId, sentAt: now() }
      const k = key(cell)
      try {
        const sent = bot._genericPlace(rb, face, { delta: point.minus(ref), forceLook: 'ignore', swingArm: 'right' })
        // _genericPlace — async: ошибка записи/руки приходит отказом промиса, уже после предсказания — откатить сразу,
        // а не через 1.5 с тишины (ревью Codex: блок-призрак под ногами).
        Promise.resolve(sent).catch(err => {
          if (pending.get(k) !== rec) return
          pending.delete(k); stats.sendErr = (stats.sendErr || 0) + 1
          log('не отправил', { err: err && err.message })
          try { const b = bot.blockAt(rec.cell, false); if (b && b.stateId === rec.stateId) bot.world.setBlockStateId(rec.cell, rec.oldStateId) } catch {}
        })
      } catch (err) { log('не отправил', { err: err.message }); return }
      pending.set(k, rec)
      silentSet(cell, def.defaultState)
      stats.placed++
      if (st.seg) st.seg.placed++
    })
  }

  // Очередь клеток моста: pathfinder засчитывает узел, когда тело в 0.35 от центра клетки, — а это уже внутри окна
  // щелчка (центр за гранью на 0.15–0.3). Узел может «пройти» раньше, чем под ним встал блок: такую клетку
  // ставим всё равно, первой (её опора настоящая), и только потом следующую.
  const cellKey = (br) => `${br.ref.x + br.dir.x},${br.ref.y},${br.ref.z + br.dir.z}`
  function near (br, pos) {
    const g = geometry(pos, br.ref, br.dir)
    return g.s > -1.6 && g.s < 0.6 && Math.abs(g.off) < 1
  }
  st.queue = []
  // ---- спуск блоками (ход ndDescend): фаза 1 — присев к краю (присед не даёт сорваться) и щелчок по грани стены,
  // как только она видна; фаза 2 — без приседа шаг с края и полёт на 2 к центру своего блока. Руль — «разгон-
  // торможение» из расчёта Codex (codex-lab/mv-descent/sim.js walk-brake): нужное изменение скорости → взгляд по
  // нему и «вперёд», если оно больше половины разгона за тик (на земле и в воздухе — свои коэффициенты физики).
  st.desc = null
  function steerTo (e, dest, sneak) {
    const ph = bot.physics || {}
    const onG = !!e.onGround
    const slip = ph.defaultSlipperiness ?? 0.6
    const inertia = onG ? slip * 0.91 : (ph.airborneInertia ?? 0.91)
    const base = onG ? (ph.playerSpeed ?? 0.1) * 0.1627714 / inertia ** 3 : (ph.airborneAcceleration ?? 0.02)
    const acc = base * 0.98 * (sneak ? (ph.sneakSpeed ?? 0.3) : 1)
    const dx = dest.x - e.position.x; const dz = dest.z - e.position.z
    const len = Math.hypot(dx, dz); const speed = Math.hypot(e.velocity.x, e.velocity.z)
    const want = Math.min(sneak ? 0.06 : 0.19, len * 0.5)
    const ax = (len ? dx / len * want / inertia : 0) - e.velocity.x
    const az = (len ? dz / len * want / inertia : 0) - e.velocity.z
    return { yaw: Math.atan2(-ax, -az), forward: Math.hypot(ax, az) > acc * 0.5 && !(len < 0.03 && speed < 0.015) }
  }
  function descTick (e) {
    const d = st.desc
    const C = d.cell
    const T = new Vec3(C.x + 0.5, C.y + 1, C.z + 0.5)
    const p = e.position
    const keys = (fwd, sneak) => {
      bot.setControlState('forward', !!fwd)
      for (const k of ['back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(k, false)
      bot.jumpQueued = false
      bot.setControlState('sneak', !!sneak)
    }
    // Встал на свой блок — ступень пройдена.
    if (e.onGround && Math.abs(p.y - T.y) < 0.01 && Math.abs(p.x - T.x) < 0.8 && Math.abs(p.z - T.z) < 0.8) { d.done = 'landed'; return null }
    if (p.y < C.y - 0.5) { d.done = 'fell'; stats.descFell = (stats.descFell || 0) + 1; return null }
    if (now() - d.t0 > 6000 || Math.hypot(p.x - T.x, p.z - T.z) > 3.5) { d.done = 'lost'; replan('спуск: не вышло', { cell: [C.x, C.y, C.z] }); return null }
    const placed = solidAt(C) || pending.has(key(C))
    if (!placed) {
      if (!e.onGround) { d.done = 'air'; return null } // в воздухе без блока — ловит сторож падения
      // Тело не на исходной клетке ступени (путь перестроен из воздуха, из ямки) — ступень не про нас: перестроить.
      const org = d.tag.from
      if (Math.abs(p.y - org.y) > 0.6 || Math.hypot(p.x - (org.x + 0.5), p.z - (org.z + 0.5)) > 1.3) {
        d.done = 'moved'; stats.descMoved = (stats.descMoved || 0) + 1
        replan('спуск: тело не на ступени', { cell: [C.x, C.y, C.z], from: [org.x, org.y, org.z] })
        return null
      }
      const item = filler()
      if (!item) { stats.noItem++; prepare(); keys(false, true); replan('спуск: нет блоков в хотбаре'); return { stop: true } }
      // Опора — стена под краем (C − d): грань видна только со свесом за край — к краю (присед держит). Стена сбоку:
      // грань видна из центра своей ступени, а с её края луч цепляет саму ступень — стоять в центре.
      const edge = d.ref.x === C.x - d.tag.dir.x && d.ref.z === C.z - d.tag.dir.z
      const from = d.tag.from
      const st2 = steerTo(e, edge ? T : new Vec3(from.x + 0.5, p.y, from.z + 0.5), true)
      const eye = p.offset(0, EYE, 0)
      const fp = d.ref.offset(0.5 + d.face.x * 0.5, 0.5, 0.5 + d.face.z * 0.5)
      const pitch = Math.atan2(fp.y - eye.y, Math.max(0.05, Math.hypot(fp.x - eye.x, fp.z - eye.z)))
      bot.look(st2.yaw, pitch, true)?.catch?.(() => {})
      keys(st2.forward, true)
      if (!hand.on()) {
        const snap = p.clone()
        st.scheduled = () => fire(snap, d.ref, { x: C.x - d.ref.x, z: C.z - d.ref.z }, C, item)
        bot.once('move', st.scheduled)
      }
      d.ticksA = (d.ticksA || 0) + 1
      return { phase: 'place' }
    }
    const st2 = steerTo(e, T, false)
    bot.look(st2.yaw, 0, true)?.catch?.(() => {})
    keys(st2.forward, false)
    if (!d.stepAt) d.stepAt = now()
    return { phase: 'step' }
  }
  st.step = () => {
    if (st.stopped) return null
    cancelScheduled()
    expire()
    const ns = nodes()
    const e = bot.entity
    if (st.after > 0 && e && !st.seg) {
      st.after--
      const p = e.position; const n0 = Array.isArray(ns) && ns[0]
      const c = {}; for (const k of ['forward', 'back', 'jump', 'sneak', 'sprint']) c[k] = bot.getControlState(k)
      log('после', { p: [p.x, p.y, p.z].map(v => Math.round(v * 1000) / 1000), g: e.onGround, yaw: Math.round(e.yaw * 100) / 100, c, node: n0 ? [n0.x, n0.y, n0.z, n0.toPlace.length, n0.toBreak.length, !!n0.parkour] : null, len: Array.isArray(ns) ? ns.length : -1, mv: moving() })
    }
    if (!e || !e.position) { st.queue = []; st.desc = null; finish(); return null }
    const going = Array.isArray(ns) && ns.length > 0 && moving()
    // Спуск блоками: ступень ведём до посадки на свой блок, даже если pathfinder уже засчитал узел (|dy| < 1 в полёте).
    const startDesc = (nd) => {
      const t = nd.ndDescend
      st.desc = { tag: t, cell: new Vec3(t.cell.x, t.cell.y, t.cell.z), ref: new Vec3(t.ref.x, t.ref.y, t.ref.z), face: t.face, t0: now() }
      stats.descSteps = (stats.descSteps || 0) + 1
    }
    const nd = going ? ns[0] : null
    // Новый мост — не по частичному пути, пока поиск ещё идёт (status 'partial'): по нему тело строило мост в пустоту
    // там, где пути вниз так и не нашлось (mv-mlg-3) — стоять присев у края, пока поиск не кончится. Итог поиска
    // ('success', 'timeout' с лучшим путём) — идти. Спуск не ждёт: на обрыве 20 полный путь не находился за 5 с, и тело
    // стояло наверху 80–90 с (mv-gap-6); мосты в небо теперь отсекает высота цели (goalY).
    const status = deps.status ? deps.status() : (session.lastPath && session.lastPath.status)
    const settled = status !== 'partial'
    const hold = () => {
      for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false)
      bot.jumpQueued = false
      bot.setControlState('sneak', true)
      stats.held = (stats.held || 0) + 1
      return { hold: true }
    }
    // Путь «не отсюда»: A* ищет от места, где начался поиск, а тело тем временем ушло вниз по частичному пути (спуск
    // блоками) — итоговый путь ведёт к узлу выше прыжка над телом, и тело прыгает на месте до «stuck»/сторожа goto
    // (обрыв 20, mv-gap-fin2 и mv-cliff-dbg4: 16–30 с вместо 11, «ступень: fell» по клетке над телом). Перестроить
    // отсюда сразу (не чаще раза в секунду): узел выше тела на 1.3+, без постановки (столб), тело на земле не в воде.
    const climb = (p) => { const b = bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), false); return !!(b && /ladder|vine|scaffolding/.test(b.name)) }
    if (!st.desc && nd && e.onGround && !e.isInWater && !e.isInLava && !(nd.toPlace && nd.toPlace.length) && nd.y - e.position.y > 1.3 && !climb(e.position) && !climb(nd)) {
      stats.notHere = (stats.notHere || 0) + 1
      replan('путь не отсюда', { node: [nd.x, nd.y, nd.z], pos: [e.position.x, e.position.y, e.position.z].map(v => Math.round(v * 100) / 100) })
      return null
    }
    if (!st.desc && nd && nd.ndDescend) startDesc(nd)
    for (let pass = 0; st.desc && pass < 2; pass++) {
      if (!e.isInWater && !e.isInLava) {
        const r = descTick(e)
        if (!st.desc.done) return r
      }
      if (process.env.ND_DEBUG_BRIDGE) { const dd = st.desc; log('ступень: ' + (dd.done || 'вода'), { cell: [dd.cell.x, dd.cell.y, dd.cell.z], ms: now() - dd.t0, placeMs: dd.stepAt ? dd.stepAt - dd.t0 : null, ticksA: dd.ticksA || 0, pos: [e.position.x, e.position.y, e.position.z].map(v => Math.round(v * 100) / 100) }) }
      const landed = st.desc.done === 'landed'
      if (landed) stats.descLanded = (stats.descLanded || 0) + 1
      st.desc = null
      try { bot.setControlState('sneak', false); bot.setControlState('forward', false); bot.setControlState('jump', false); bot.jumpQueued = false } catch {}
      // Встали на ступень — следующую начинаем в этом же тике (иначе прыжок pathfinder'а с края ступени, mv-descent:
      // +1.25 к падению). Узел, уже засчитанный pathfinder'ом, пропускаем.
      if (!landed || !going) break
      let k = 0
      while (k < ns.length && ns[k] && ns[k].ndDescend && Math.abs(ns[k].y - e.position.y) < 0.01 && Math.abs(ns[k].x - e.position.x) < 0.8 && Math.abs(ns[k].z - e.position.z) < 0.8) k++
      const next = ns[k]
      // Засчитать ступень pathfinder'у: тело садится в 0.4–0.8 от центра узла, а «прибытие» у исполнителя pathfinder'а —
      // 0.35, и только оно обновляет его lastNodeTime: через 3.5 с — «stuck» посреди спуска и поиск с нуля
      // (mv-cliff-dbg6: три «stuck» на обрыве 20, 26 с вместо 10). Пройденные ступени — долой, первой — метка в точке
      // тела: исполнитель засчитает её на следующем тике (тело стоит) и пойдёт к следующей ступени.
      if (k > 0) {
        const m = new Vec3(e.position.x, e.position.y, e.position.z)
        m.toBreak = []; m.toPlace = []; m.parkour = false; m.cost = 0; m.remainingBlocks = (ns[0] && ns[0].remainingBlocks) || 0; m.ndKeep = true
        ns.splice(0, k, m)
        stats.descMarks = (stats.descMarks || 0) + 1
      }
      if (next && next.ndDescend) startDesc(next)
    }
    let n = going ? ns[0] : null
    // Узел-мост, чья клетка уже стоит, а тело его проехало (сбоку дальше 0.35 — pathfinder не засчитал): сдвинуть
    // самим (это тот же массив, что у исполнителя pathfinder'а), иначе тело пятится дальше без опоры.
    if (n && n.ndBridge && e.onGround) {
      const c = new Vec3(n.ndBridge.ref.x + n.ndBridge.dir.x, n.ndBridge.ref.y, n.ndBridge.ref.z + n.ndBridge.dir.z)
      const past = geometry(e.position, c, n.ndBridge.dir)
      if (past.s > -0.4 && Math.abs(past.off) < 0.7 && solidAt(c)) { ns.shift(); stats.selfShift = (stats.selfShift || 0) + 1; n = ns[0] }
    }
    if (n && n.ndBridge && !st.queue.some(q => cellKey(q) === cellKey(n.ndBridge))) st.queue.push(n.ndBridge)
    // Поставленные (или в пути к серверу) и далёкие (путь сменился) — из очереди долой.
    st.queue = st.queue.filter(q => {
      const c = new Vec3(q.ref.x + q.dir.x, q.ref.y, q.ref.z + q.dir.z)
      return !solidAt(c) && !pending.has(key(c)) && near(q, e.position)
    })
    // Опора первой клетки — воздух, а перед ней твёрдое по той же оси: узел-предшественник срезан pathFromPlayer ещё
    // до fixPath (ревью Codex) — поставить его клетку первой.
    const q0 = st.queue[0]
    if (q0) {
      const r0 = new Vec3(q0.ref.x, q0.ref.y, q0.ref.z)
      const back = r0.offset(-q0.dir.x, 0, -q0.dir.z)
      if (!solidAt(r0) && !pending.has(key(r0)) && replaceable(bot.blockAt(r0, false)) && solidAt(back)) {
        const pre = { ref: { x: back.x, y: back.y, z: back.z }, dir: q0.dir, y: q0.y, synth: true }
        if (near(pre, e.position)) { st.queue.unshift(pre); stats.synth = (stats.synth || 0) + 1 }
      }
    }
    // Опора клетки не стоит и не появится (её нет в очереди перед ней) — устаревшая запись (путь сменился, отказ).
    st.queue = st.queue.filter((q, i) => {
      if (solidAt(new Vec3(q.ref.x, q.ref.y, q.ref.z)) || pending.has(key(q.ref))) return true
      return st.queue.slice(0, i).some(o => cellKey(o) === key(q.ref))
    })
    if (!st.queue.length && n && n.ndBridge) st.queue.push(n.ndBridge) // её клетка уже стоит — идти по ней
    const br = st.queue[0]
    if (!br) {
      if (going && ns.slice(1, 4).some(q => q && q.ndBridge)) prepare()
      finish()
      return null
    }
    if (e.isInWater || e.isInLava) return null
    const dir = br.dir
    const ref = new Vec3(br.ref.x, br.ref.y, br.ref.z)
    const cell = ref.offset(dir.x, 0, dir.z)
    // Ждать конца поиска — только над пустотой и не дольше HOLD_MS: pathfinder сам сбрасывает путь «stuck» через
    // 3.5 с без нового узла, и поиск начинается заново — «до конца поиска» не наступало никогда (рельеф, mv-spr-dbg2:
    // цель в 70 бл., у реки тело стояло присев, stuck → тот же частичный путь → goto «застрял» за 27 с). Над водой не
    // ждать вовсе: сорвался — в воду, а мост по частичному пути стоит лишь пары блоков.
    // В воздухе отрезок не начинаем (дальше всё равно «в воздухе — не наше»): иначе ожидание поиска пропускалось,
    // если первый тик отрезка пришёлся на прыжок pathfinder'а у края.
    if (!st.seg && !e.onGround) return null
    if (!st.seg && !settled && !solidAt(cell)) {
      const hk = key(cell)
      if (st.holdKey !== hk) { st.holdKey = hk; st.holdT0 = now() }
      if (!br.water && now() - st.holdT0 < HOLD_MS) return hold()
      stats.holdGo = (stats.holdGo || 0) + 1
    }
    if (!st.seg) { st.seg = { t0: now(), y0: e.position.y, cells: 0, placed: 0, confirmed: 0, denied: 0, last: null }; stats.segments++ }
    if (st.seg.last !== key(cell)) { st.seg.last = key(cell); st.seg.cells++ }
    // В воздухе — не наше: сорвались — ловит сторож падения (clutch.js), не мешать его клавишам.
    if (!e.onGround) return null
    const item = filler()
    const refSolid = solidAt(ref)
    const cellSolid = solidAt(cell)
    if (!cellSolid && (!item || !refSolid)) {
      if (!item) { stats.noItem++; prepare() }
      // Стоять на краю присев, пока путь не перестроится.
      for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false)
      bot.setControlState('sneak', true)
      const p = e.position
      replan(!item ? 'нет блоков в хотбаре' : 'нет опоры', { ref: [ref.x, ref.y, ref.z], cell: [cell.x, cell.y, cell.z], pos: [p.x, p.y, p.z].map(v => Math.round(v * 100) / 100),
        refBlock: (bot.blockAt(ref, false) || {}).name, node: n ? [n.x, n.y, n.z, !!n.ndBridge] : null, queue: st.queue.map(cellKey) })
      return { stop: true }
    }
    const d = decide({ pos: e.position, onGround: e.onGround, ref, dir, cellSolid, refSolid, pending: pending.has(key(cell)) })
    bot.look(d.yaw, d.pitch, true)?.catch?.(() => {})
    if (!going) {
      // Путь кончился на узле-мосте или сброшен посреди моста (block_updated, chunk_loaded, goal_moved: clearStates=false
      // — клавиши остались нажатыми; ревью Codex): не идти; клетка под нависшим телом — поставить; иначе стоять присев.
      for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false)
      bot.jumpQueued = false
      bot.setControlState('sneak', !cellSolid && d.s > -0.6 && !d.place)
      if (d.place && item && !hand.on()) {
        const snap = e.position.clone()
        st.scheduled = () => fire(snap, ref, dir, cell, item)
        bot.once('move', st.scheduled)
      }
      if (cellSolid || d.s <= -0.6) { st.queue = []; finish() }
      return d
    }
    bot.setControlState('forward', false)
    bot.setControlState('back', true)
    bot.setControlState('left', d.strafe === 'left')
    bot.setControlState('right', d.strafe === 'right')
    bot.setControlState('jump', false)
    // pathfinder в этом же тике мог нажать прыжок (canWalkJump над пустотой): mineflayer запоминает нажатие в
    // jumpQueued, и тело прыгнет, даже если клавишу отпустить (ферма 02.10, mv-gap-dbg3: прыжок с края моста).
    bot.jumpQueued = false
    bot.setControlState('sprint', false)
    bot.setControlState('sneak', false)
    if (d.place && item && hand.on()) stats.handBusy = (stats.handBusy || 0) + 1
    if (d.place && item && !hand.on()) {
      const snap = e.position.clone()
      st.scheduled = () => fire(snap, ref, dir, cell, item)
      bot.once('move', st.scheduled)
    }
    if (process.env.ND_DEBUG_BRIDGE && st.seg && (st.seg.dbg = (st.seg.dbg || 0) + 1) <= 40) {
      const p = e.position
      log('тик', { p: [p.x, p.y, p.z].map(v => Math.round(v * 1000) / 1000), v: [e.velocity.x, e.velocity.y, e.velocity.z].map(v => Math.round(v * 1000) / 1000), g: e.onGround, s: Math.round(d.s * 1000) / 1000, place: d.place, cell: cellKey(br), node: n ? [n.x, n.y, n.z, !!n.ndBridge] : null, q: st.queue.length })
    }
    return d
  }
  const onPath = (r) => { fixPath(r && r.path) }
  // Сброс пути посреди моста: клавиши «назад»/вбок pathfinder не отпускает (clearStates=false) — отпустить сразу,
  // не ждать тика; клетку под нависшим телом поставит следующий тик (ветка !going).
  const onReset = () => {
    if (!st.seg && !st.queue.length) return
    cancelScheduled()
    try { for (const k of ['back', 'left', 'right', 'forward']) bot.setControlState(k, false); bot.jumpQueued = false } catch {}
  }
  // Телепорт, возрождение — ступень и очередь моста больше не про это место: забыть и отпустить свои клавиши.
  const onTeleport = () => {
    if (!st.desc && !st.queue.length && !st.seg) return
    cancelScheduled()
    st.desc = null; st.queue = []
    finish()
    try { for (const k of ['forward', 'back', 'left', 'right', 'sneak']) bot.setControlState(k, false); bot.jumpQueued = false } catch {}
  }
  // Счёт одинаковых перестроек снимают новая цель (другая, не та же после рефлекса) и достигнутая цель.
  const onGoal = (g) => { const k = goalKey(g); if (k !== st.replanGoal) { st.replanGoal = k; st.replanSame = 0; st.replanSig = null } }
  const onReached = () => { st.replanSame = 0; st.replanSig = null }
  st.stop = () => {
    st.stopped = true
    cancelScheduled()
    finish()
    bot.removeListener('goal_updated', onGoal)
    bot.removeListener('goal_reached', onReached)
    bot.removeListener('physicsTick', st.step)
    bot.removeListener('path_update', onPath)
    bot.removeListener('path_reset', onReset)
    bot.removeListener('forcedMove', onTeleport)
    bot.removeListener('spawn', onTeleport)
    bot.removeListener('end', st.stop)
    try { bot._client.removeListener('block_change', single); bot._client.removeListener('multi_block_change', multi) } catch {}
    if (bot._ndBridgeExec === st) delete bot._ndBridgeExec
  }
  // path_update — раньше исполнителя (prepend): узлы надо поправить до первого тика по новому пути.
  bot.prependListener('path_update', onPath)
  bot.on('goal_updated', onGoal)
  bot.on('goal_reached', onReached)
  bot.on('physicsTick', st.step)
  bot.on('path_reset', onReset)
  bot.on('forcedMove', onTeleport)
  bot.on('spawn', onTeleport)
  try { bot._client.on('block_change', single); bot._client.on('multi_block_change', multi) } catch {}
  bot.once('end', st.stop)
  bot._ndBridgeExec = st
  return st
}

module.exports = { replanSig, replanCount, goalKey, on, addBridge, bridgeMove, cellOf, fixPath, geometry, decide, install, below, fullCube, replaceable, REPLACE, FILLER }
