'use strict'
// Загон пиглинов «люк за окном» (S2, 06.10.2026) — приём спидраннеров «скинуть торговцев в яму и торговать из-за
// стены», сделанный из нашей ямы со ртом (booth-trade.pitAt): бот в яме торгует как обычно; вручённый слиток держит
// взрослого на месте 119 тиков (PiglinAi.mobInteract → stopWalking, admireGoldItem 119). Если его рамка целиком над
// полосой из 1–3 клеток пола у стены рта — бот закладывает рот, шагает на клетку назад (B), закладывает свою прежнюю
// клетку ног (P) и из-за окна высотой 1 (H, W±p) ломает пол под ним. Пиглин падает на 2 в траншею (Z), выпрыгнуть
// (прыжок 1.25) и пролезть в окно (рост 1.95) не может, глаза его видят глаза бота — добыча летит к ногам
// (PiglinAi.throwItems → NEAREST_VISIBLE_PLAYER, цель — ноги+1). Дальше вручаем по кругу каждому свободному.
//
// Разрез вдоль d (от бота к пиглинам), F — уровень ног пиглинов:
//   y=F+1   [стена ] [R твёрдо] [      ]
//   y=F     [стена ] [M рот→блок] [T пол пиглина]      ← T: клетки полосы O, O±p
//   y=F-1   [B голова] [H окно]  [Y люк → воздух]     ← W±p = (M±p, F-1): окна к боковым полосам
//   y=F-2   [B ноги ] [P → блок] [Z траншея]
//   y=F-3   [твёрдо ] [твёрдо]   [твёрдо]
// Ставим и ломаем только видимые грани (pick.faceAim; fillCell honest). Ломаем обычные блоки — злости нет
// (злят только #guarded_by_piglins и удар). Расчёт полёта (predict-gold.throwLands) для 27 положений в трёх полосах —
// 27/27 к ногам в B (тест pen-trap.test).
const { gameClock, countOf, Vec3, mobs, isBaby, aggressive, admiring, sleep, xyz, log, centerIn, unpackGold } = require('./take-gold-block')
const PG = require('./predict-gold')

const ADMIRE_MS = 119 * 50 // PiglinAi.admireGoldItem: ADMIRING_ITEM на 119 тиков
const FACES6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const at = (q, dx = 0, dy = 0, dz = 0) => ({ x: q.x + dx, y: q.y + dy, z: q.z + dz })
const V = q => new Vec3(q.x, q.y, q.z)

// Геометрия загона у ямы bo {P,H,M,O,d}. cls(x,y,z) → класс sealed; own(x,y,z) — наш штрек (воздух, закрытый снаружи).
// Чистая функция: { F, M, P, H, Bf, Bh, lanes:[{k,T,Y,Z,W}] } или { why }.
function penPlan (bo, cls, { own = (_x, _y, _z) => false, lanes: want = 3 }: any = {}) {
  const SL = require('../sealed')
  const c = q => cls(q.x, q.y, q.z)
  const firm = q => { const k = c(q); return k === SL.SOLID || k === SL.HARD || k === SL.GUARD }
  const digg = q => c(q) === SL.SOLID
  const air = q => c(q) === SL.AIR
  const ownAir = q => air(q) && own(q.x, q.y, q.z)
  const [dx, dz] = bo.d; const px = dz; const pz = dx
  const M = bo.M; const O = bo.O
  const F = M.y
  if (!firm(at(M, 0, 1, 0))) return { why: 'над ртом не твёрдое' }
  const back = at(M, -dx, 0, -dz)
  if (!firm(back)) return { why: 'над клеткой B нет крыши' }
  const Bh = at(back, 0, -1, 0); const Bf = at(back, 0, -2, 0)
  if (!firm(at(Bf, 0, -1, 0))) return { why: 'под B нет пола' }
  for (const q of [Bf, Bh]) {
    if (!digg(q) && !ownAir(q)) return { why: `B ${q.x},${q.y},${q.z} не копается` }
    for (const n of [at(q, px, 0, pz), at(q, -px, 0, -pz), at(q, -dx, 0, -dz)]) if (!firm(n) && !ownAir(n)) return { why: `у B открыто ${n.x},${n.y},${n.z}` }
  }
  const lane = k => {
    const T = at(O, k * px, 0, k * pz); const Y = at(T, 0, -1, 0); const Z = at(T, 0, -2, 0)
    const W = k ? at(M, k * px, -1, k * pz) : at(M, 0, -1, 0)
    if (!air(T) || !air(at(T, 0, 1, 0))) return null // на T пиглин должен стоять
    // Траншея и окно могли быть выкопаны прошлым вызовом у этой ямы (загон не закрылся) — свой воздух годится.
    if (!digg(Y) || !(digg(Z) || ownAir(Z)) || !firm(at(Z, 0, -1, 0)) || !firm(at(Z, dx, 0, dz)) || !firm(at(Y, dx, 0, dz))) return null
    if (k) {
      // Окно сбоку от H: копается, над и под ним твёрдое, наружу (дальше по p) — твёрдое; у траншеи сзади — твёрдое.
      if (!(digg(W) || ownAir(W)) || !firm(at(W, 0, 1, 0)) || !firm(at(W, 0, -1, 0)) || !firm(at(W, k * px, 0, k * pz))) return null
      if (!firm(at(Z, -dx, 0, -dz))) return null
    }
    return { k, T, Y, Z, W }
  }
  const l0 = lane(0)
  if (!l0) return { why: 'под клеткой у рта не выйдет траншеи' }
  const out = [l0]
  if (want >= 3) for (const k of [1, -1]) {
    const l = lane(k)
    // Боковая полоса: снаружи от неё траншея закрыта (Z и пол Y дальше по p — твёрдые).
    if (l && firm(at(l.Z, k * px, 0, k * pz)) && firm(at(l.Y, k * px, 0, k * pz))) out.push(l)
  }
  // Без боковой полосы её клетки у Z0 и у люка Y0 — стенка загона: открытый Y0±p — ступень наружу (со дна Z0 на
  // блок Z0±p и в карман на уровне Y; s2b-alt05 k=9: под соседней с T клеткой пусто — 4 из загона ушли за 10 с).
  for (const k of [1, -1]) if (!out.some(l => l.k === k) && (!firm(at(l0.Z, k * px, 0, k * pz)) || !firm(at(l0.Y, k * px, 0, k * pz)))) return { why: 'траншея открыта вбок' }
  return { F, M, P: bo.P, H: bo.H, Bf, Bh, d: bo.d, p: [px, pz], lanes: out.sort((a, b) => a.k - b.k) }
}

// Яма, в которой стоит бот: P — ноги, H — голова, M — рот над головой, O — пол пиглинов перед ртом.
function pitHere (bot) {
  const SL = require('../sealed')
  const { SIDES4 } = require('./take-gold-block')
  const cls = q => SL.classOf(bot.blockAt(V(q)))
  const P = bot.entity.position.floored()
  const H = at(P, 0, 1, 0); const M = at(P, 0, 2, 0); const R = at(P, 0, 3, 0)
  if (cls(H) !== SL.AIR || cls(M) !== SL.AIR || ![SL.SOLID, SL.HARD, SL.GUARD].includes(cls(R))) return null
  const d = SIDES4.find(([dx, dz]) => cls(at(M, dx, 0, dz)) === SL.AIR && cls(at(M, dx, 1, dz)) === SL.AIR && cls(at(M, dx, -1, dz)) === SL.SOLID)
  if (!d) return null
  const O = at(M, d[0], 0, d[1])
  return { kind: 'pit', P: xyz(P), H, M, R, O, d, p: [d[1], d[0]], dump: null, F: xyz(P), W: M, C: H, sill: true }
}

// Готовый загон: бот в B (ноги Bf), впереди заложенная клетка P, над окном H — заложенный рот M, за окном открытый
// люк Y0 и траншея Z0. Полосы — открытые (Y и Z воздух). План с ready:true — penTrade сразу торгует.
function penHere (bot) {
  const SL = require('../sealed')
  const { SIDES4 } = require('./take-gold-block')
  const cls = q => SL.classOf(bot.blockAt(V(q)))
  const firm = q => [SL.SOLID, SL.HARD, SL.GUARD].includes(cls(q))
  const Bf = xyz(bot.entity.position.floored()); const Bh = at(Bf, 0, 1, 0)
  for (const [dx, dz] of SIDES4) {
    const P = at(Bf, dx, 0, dz); const H = at(Bh, dx, 0, dz); const M = at(H, 0, 1, 0)
    if (!firm(P) || cls(H) !== SL.AIR || !firm(M) || cls(Bh) !== SL.AIR) continue
    const O = at(M, dx, 0, dz)
    const px = dz; const pz = dx
    const lanes = []
    for (const k of [-1, 0, 1]) {
      const T = at(O, k * px, 0, k * pz); const Y = at(T, 0, -1, 0); const Z = at(T, 0, -2, 0)
      if (cls(Y) === SL.AIR && cls(Z) === SL.AIR && firm(at(Z, 0, -1, 0))) lanes.push({ k, T, Y, Z, W: k ? at(M, k * px, -1, k * pz) : H })
    }
    if (!lanes.some(l => l.k === 0)) continue
    return { ready: true, F: M.y, M, P, H, Bf, Bh, d: [dx, dz], p: [px, pz], lanes }
  }
  return null
}

// Рамка пиглина целиком внутри полосы клеток (прямоугольник лент) и он на полу F. Прижатый к стене рта (край рамки
// ровно на границе клетки) — внутри: опоры за полосой у него нет (пересечение AABB строгое).
function inStrip (plan, e, eps = -0.001) {
  const half = (e.width || 0.6) / 2
  const xs = plan.lanes.map(l => l.T.x); const zs = plan.lanes.map(l => l.T.z)
  const p = e.position
  return Math.abs(p.y - plan.F) < 0.3 &&
    p.x - half >= Math.min(...xs) + eps && p.x + half <= Math.max(...xs) + 1 - eps &&
    p.z - half >= Math.min(...zs) + eps && p.z + half <= Math.max(...zs) + 1 - eps
}

// Полосы, на клетки которых заходит рамка.
function lanesUnder (plan, e) {
  const half = (e.width || 0.6) / 2
  const p = e.position
  return plan.lanes.filter(l => p.x + half > l.T.x && p.x - half < l.T.x + 1 && p.z + half > l.T.z && p.z - half < l.T.z + 1)
}

function inPen (plan, e) {
  const p = e.position
  return p.y > plan.F - 2.6 && p.y < plan.F - 1.4 && plan.lanes.some(l => Math.floor(p.x) === l.T.x && Math.floor(p.z) === l.T.z)
}

// Прицел броска слитка из B в траншею открытой полосы (клетка Z): по физике Player.drop (tossLands) при разбросе
// ±0.04 по вертикали предмет ложится на дно Z. Z в 2 клетках от B по d — вне рамки подбора бота (1.3), слиток не вернётся.
function trenchAim (bot, plan, open, gb) {
  for (const l of plan.lanes.filter(l => open.includes(l.k)).sort((a, b) => Math.abs(a.k) - Math.abs(b.k))) {
    for (const hy of [0.6, 1.0, 0.3, 1.4]) {
      for (const ox of [0.5, 0.3, 0.7]) {
        for (const oz of [0.5, 0.3, 0.7]) {
          const aim = new Vec3(l.Z.x + ox, l.Z.y + hy, l.Z.z + oz)
          const ok = [-0.04, 0, 0.04].every(dvy => { const q = PG.tossLands(bot, aim, gb, dvy); return Math.floor(q.x) === l.Z.x && Math.floor(q.z) === l.Z.z && q.y < plan.F - 1 })
          if (ok) return { aim, k: l.k }
        }
      }
    }
  }
  return null
}

// Грань блока v и видимая прицелу точка на ней (pick.faceAim: луч из глаз по контурам до точки не упирается в другой
// блок или сущность, ≤4.5 бл.): сперва грани с видимым центром, затем ближайшая к глазам; null — блок прицелом не
// взять. Боковые траншеи Z±p из ямы видны только нижней частью грани (центр закрыт полом Y0 — тест pen-trap).
function seenFace (bot, v) {
  const pick = require('../pick')
  const eye = pick.eyeOf(bot)
  let best = null
  for (const [fx, fy, fz] of FACES6) {
    const n = bot.blockAt(v.offset(fx, fy, fz))
    if (!n || n.boundingBox !== 'empty') continue
    const face = new Vec3(fx, fy, fz)
    const aim = pick.faceAim(bot, v, face)
    if (!aim) continue
    const center = aim.distanceTo(v.offset(0.5 + fx * 0.5, 0.5 + fy * 0.5, 0.5 + fz * 0.5)) < 1e-6
    const d = aim.distanceTo(eye)
    if (!best || (center && !best.center) || (center === best.center && d < best.d)) best = { face, aim, center, d }
  }
  return best
}

// Сломать блок только через грань, которую видит прицел (seenFace): взгляд в видимую точку этой грани, в block_dig —
// эта грань (SL.digCell face+aim); иначе 'unseen'. Раньше хватало «какая-то точка видна», а копал SL.digCell с гранью
// 'auto' — взгляд в центр блока, у боковых траншей сквозь пол Y0 (замечание проверки раунда 1).
async function digSeen (bot, q) {
  const SL = require('../sealed')
  const v = V(q)
  const b = bot.blockAt(v)
  if (!b) return 'unloaded'
  if (SL.classOf(b) === SL.AIR) return 'air'
  const sf = seenFace(bot, v)
  if (!sf) return 'unseen'
  return SL.digCell(bot, v, { face: sf.face, aim: sf.aim })
}

// Несколько клеток подряд, каждая — через видимую грань (digSeen); порядок — какая сейчас видна: вниз по ступени сперва
// клетка перед головой, потом под ней (снизу-первой она закрыта полом под ногами и клеткой перед ней). Итог: 'ok' или
// '<x,y,z> <причина>'. dig — для тестов.
async function digSeenAll (bot, cells, dig = digSeen) {
  const todo = cells.map(V).filter(c => { const b = bot.blockAt(c); return !b || b.boundingBox !== 'empty' })
  while (todo.length) {
    let i = todo.findIndex(c => seenFace(bot, c))
    if (i < 0) i = 0 // ни одна не видна — digSeen ответит 'unseen' по первой
    const c = todo.splice(i, 1)[0]
    const r = await dig(bot, c)
    if (r !== 'ok' && r !== 'air') return `${c.x},${c.y},${c.z} ${r}`
  }
  return 'ok'
}

// Журнал бросков пиглинов: предмет появился у глаз−0.3 взрослого (BehaviorUtils.throwItem) → кто бросил, дошёл ли.
function throwJournal (bot) {
  const throws = new Map()
  const itemType = bot.registry.entitiesByName.item && bot.registry.entitiesByName.item.id
  const onSpawn = p => {
    if (p.type !== itemType) return
    const pg: any = mobs(bot, 'piglin', 24).find((e: any) => !isBaby(bot, e) && Math.hypot(e.position.x - p.x, e.position.z - p.z) < 0.35 && Math.abs(e.position.y + PG.PIGLIN_EYE - 0.3 - p.y) < 0.15)
    if (pg) throws.set(p.entityId, { t: gameClock.now(), pid: pg.id, y: pg.position.y })
  }
  const onMeta = p => {
    const t = throws.get(p.entityId)
    if (!t || t.name) return
    try { const it = bot.entities[p.entityId] && bot.entities[p.entityId].getDroppedItem(); if (it) { t.name = it.name; t.count = it.count } } catch {}
  }
  const onCollect = (collector, collected) => { if (collector === bot.entity && collected) { const t = throws.get(collected.id); if (t) t.got = true } }
  bot._client.on('spawn_entity', onSpawn)
  bot._client.on('entity_metadata', onMeta)
  bot.on('playerCollect', onCollect)
  return {
    throws,
    stop () { bot._client.removeListener('spawn_entity', onSpawn); bot._client.removeListener('entity_metadata', onMeta); bot.removeListener('playerCollect', onCollect) },
    summary (filter = (_t: any) => true) {
      const rs = [...throws.values()].filter(t => t.name && t.name !== 'gold_ingot' && t.count > 0 && filter(t))
      const got = rs.filter(t => t.got).length
      return { receipts: rs.length, delivered: got, delivery: rs.length ? +(got / rs.length).toFixed(3) : null }
    }
  }
}

// Вручить слиток: только видимому прицелом взрослому, не злому, без золота в левой руке, в досягаемости 2.9.
async function handOne (bot, list, eye) {
  for (const pg of list) {
    if (PG.distToBox(eye, pg) > 2.9) continue
    if (await PG.handNoWalk(bot, pg)) return pg
  }
  return null
}

// Загон и торг. opts: plan (иначе по месту), seconds, keep (слитков оставить), done(), want (сколько ловить разом),
// catchSeconds (сколько ждать кандидатов в фазе ямы).
async function penTrade (session, ctl, bo, opts: any = {}) {
  const bot = session.bot
  const SL = require('../sealed')
  const t0 = gameClock.now()
  const until = t0 + (opts.seconds ?? 240) * 1000
  const keep = opts.keep ?? 0
  const done = opts.done || (() => false)
  const r: any = { mode: 'pen', handed1: 0, handed3: 0, captured: 0, pearls0: countOf(bot, 'ender_pearl'), ingots0: countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block'), hpMin: bot.health ?? 20, phases: {} }
  const onHealth = () => { r.hpMin = Math.min(r.hpMin, bot.health ?? 20) }
  bot.on('health', onHealth)
  const cls = (x, y, z) => SL.classOf(bot.blockAt(new Vec3(x, y, z)))
  const plan: any = opts.plan || penPlan(bo, cls, { own: opts.own, lanes: opts.lanes ?? 3 })
  if (!plan.lanes) { bot.removeListener('health', onHealth); return Object.assign(r, { ok: false, stopped: 'загон не строится: ' + plan.why }) }
  r.lanes = plan.lanes.length
  r.plan = { B: plan.Bf, lanes: plan.lanes.map(l => l.T) }
  if (!SL.fillerName(bot) || SL.fillerCount(bot) < 2) { bot.removeListener('health', onHealth); return Object.assign(r, { ok: false, stopped: 'нет блоков заложить рот и клетку' }) }
  const J = throwJournal(bot)
  const handedAt = new Map()
  const eye = () => bot.entity.position.offset(0, 1.62, 0)
  const adults = (rad = 16) => mobs(bot, 'piglin', rad).filter(e => !isBaby(bot, e))
  // Пересчёт через паузу: стопка при перекладке в руку на миг вне inventory.items() (s2b-alt03 k=5: «слитки кончились»
  // при 27 слитках сверх запаса — второй пакет потом расторговал ещё 86).
  const goldLeft = async () => {
    for (let i = 0; i < 3; i++) {
      if (countOf(bot, 'gold_ingot') - keep >= 1) return true
      if (countOf(bot, 'gold_block')) await unpackGold(session, ctl, keep + 18)
      if (countOf(bot, 'gold_ingot') - keep >= 1) return true
      await sleep(250)
    }
    return false
  }
  try {
    // capture: 'gather' (умолчание) — сперва торг из ямы с приманками на пол, пока у люка не соберутся взрослые (или
    // вручённый не встанет над полосой), затем люки всех полос и приманки в траншею; 'lure' — люки сразу (арена
    // s2-lure02 5/5, но в бастионе s2-bast01 никто не упал: слиток на дне траншеи виден только вблизи); 'freeze' —
    // ловить вручённого над люком (s2-pen02 3/5: пол боковой полосы не виден из B, пиглин сходит с полосы).
    const mode = opts.capture === 'lure' || opts.capture === 'freeze' ? opts.capture : 'gather'
    const lureFirst = mode === 'lure'
    const openAll = mode !== 'freeze'
    r.capture = mode
    const T0 = V(plan.lanes.find(l => l.k === 0).T).offset(0.5, 0, 0.5)
    let nearN = 0
    let traceAt = 0
    r.trace = []
    const trace = () => {
      if (gameClock.now() - traceAt < 10000) return
      traceAt = gameClock.now()
      const ds = adults(24).map(e => e.position.distanceTo(T0))
      r.trace.push([Math.round((traceAt - t0) / 1000), ds.filter(x => x <= 4).length, ds.filter(x => x <= 9).length, ds.length, adults(8).filter(e => inPen(plan, e)).length])
    }
    const broke = new Set()
    if (plan.ready) {
      // Загон уже стоит (penHere: бот в B, рот и P заложены, люки открыты) — сразу торг: пиглины сидели, пока бот копал.
      for (const l of plan.lanes) broke.add(l.k)
      r.resumed = true
      r.captured = adults(8).filter(e => inPen(plan, e)).length
      r.opened = [...broke]
    } else {
    // 1. Стройка из ямы: B (голова, ноги), траншея Z0, окна W±p, траншеи Z±p через Z0.
    const tb = gameClock.now()
    const steps = [plan.Bh, plan.Bf, plan.lanes.find(l => l.k === 0).Z, ...plan.lanes.filter(l => l.k).flatMap(l => [l.W])]
    // r.own — выкопанное стройкой (замкнутый свой воздух): trade() добавляет его в st.sealedState.own, чтобы следующий
    // вызов у этой же ямы (загон не закрылся) построил загон на готовых клетках.
    r.own = []
    for (const q of steps) {
      const s = await digSeen(bot, q)
      if (s !== 'ok' && s !== 'air') return Object.assign(r, { ok: false, stopped: `стройка: ${q.x},${q.y},${q.z} ${s}` })
      r.own.push(`${q.x},${q.y},${q.z}`)
    }
    for (const l of plan.lanes.filter(l => l.k)) {
      const s = await digSeen(bot, l.Z)
      if (s !== 'ok' && s !== 'air') { plan.lanes = plan.lanes.filter(x => x !== l); r.laneDropped = (r.laneDropped || []).concat(`${l.k}:${s}`) } else r.own.push(`${l.Z.x},${l.Z.y},${l.Z.z}`)
    }
    r.lanes = plan.lanes.length
    r.phases.build = +((gameClock.now() - tb) / 1000).toFixed(1)
    // 2. Яма до поимки.
    const tl = gameClock.now()
    let frozen = []
    // Своя петля «ямы с терпением» (вручение + приманки на пол, ≤catchSeconds): freeze — всегда; gather — после того,
    // как boothTrade сдался («пиглины не подходят 30 с», «яма не работает»), а взрослые в 12 бл. от люка есть.
    let ownLoop = mode === 'freeze'
    let catchFrom = tl
    if (mode === 'gather') {
      // Обычная яма (boothTrade: вручение «чей бросок долетит», приманки, хлам, её правила остановки), пока у люка не
      // соберутся ≥gatherNear взрослых при запасе времени ≥40 с; не собрались — вызов и был торгом ямы (ok, penned:false).
      // Раунд 1 вместо этого торговал упрощённой ямой ≤90 с и отказывал «к люку не собрались» (s2-bast04/05: 3 из 13).
      const BT = require('./booth-trade')
      const st = opts.st || { traded: 0, gained: {}, barters: [], tossed: [] }
      const gathered = () => {
        trace()
        nearN = adults(12).filter(e => !aggressive(bot, e) && e.position.distanceTo(T0) <= (opts.gatherRadius ?? 4)).length
        return nearN >= (opts.gatherNear ?? 2) && until - gameClock.now() > 40000
      }
      const bt = await BT.boothTrade(session, ctl, st, bo, until, { keep, done: () => done() || gathered(), settle: false })
      r.pit = { handed: bt.handed || 0, tossed: bt.tossed || 0, stopped: bt.stopped, seconds: bt.seconds }
      r.handed1 = r.pit.handed; r.lures1 = r.pit.tossed
      r.phases.lure = +((gameClock.now() - tl) / 1000).toFixed(1)
      r.nearAtCapture = nearN
      const gaveUp = /не подходят|не работает|не доносит/.test(bt.stopped || '')
      const around = adults(16).filter(e => !aggressive(bot, e) && e.position.distanceTo(T0) <= 12).length
      if (gaveUp && opts.patience !== false && until - gameClock.now() > 60000 && around >= 1) { ownLoop = true; r.patience = { after: bt.stopped, around }; catchFrom = gameClock.now() }
      else if (bt.stopped !== 'цель' || done()) { r.ok = true; r.penned = false; r.stopped = bt.stopped; return r }
    }
    const want = Math.min(opts.want ?? plan.lanes.length, plan.lanes.length)
    const catchUntil = Math.min(until - (mode === 'gather' ? 40000 : 20000), catchFrom + (opts.catchSeconds ?? 90) * 1000)
    const gb = require('../drops').blockGetter(bot)
    // Подобравший слиток с пола тоже стоит 119 тиков (pickUpItem → stopWalking + admire): время — с первого взгляда.
    const since = new Map()
    let lastAct = catchFrom; let lures1 = r.lures1 || 0; const lures1Max = lures1 + 6; let lureAims = null
    while (ownLoop && !ctl.aborted && gameClock.now() < catchUntil) {
      if (done()) { r.stopped = 'цель'; break }
      if (!(await goldLeft())) { r.stopped = 'слитки кончились'; break }
      if ((bot.health ?? 20) < 8) { r.stopped = `хп ${Math.round(bot.health)}`; break }
      await PG.unholdGold(bot)
      const now = gameClock.now()
      for (const e of adults()) { if (!admiring(e)) since.delete(e.id); else if (!since.has(e.id)) since.set(e.id, handedAt.has(e.id) && now - handedAt.get(e.id) < ADMIRE_MS ? handedAt.get(e.id) : now) }
      frozen = adults().filter(e => since.has(e.id) && now - since.get(e.id) < ADMIRE_MS - 2500 && inStrip(plan, e))
      const oldest = Math.min(...frozen.map(e => since.get(e.id)))
      trace()
      if (mode === 'freeze' && (frozen.length >= want || (frozen.length && now - oldest > 2000))) break
      if (mode === 'gather') {
        nearN = adults(12).filter(e => !aggressive(bot, e) && e.position.distanceTo(T0) <= (opts.gatherRadius ?? 4)).length
        if (nearN >= (opts.gatherNear ?? 2)) { r.stopped = undefined; break }
      }
      if (mobs(bot, 'piglin_brute', 8, V(plan.lanes[0].T)).length) { await sleep(500); continue }
      const e0 = eye()
      const ready = adults(8).filter(e => !aggressive(bot, e) && !admiring(e) && PG.rayClear(gb, e0, e.position.offset(0, 1.6, 0)) && PG.throwLands(bot, e.position, bot.entity.position, gb).ok)
        .sort((a, b) => Number(inStrip(plan, b)) - Number(inStrip(plan, a)) || PG.distToBox(e0, a) - PG.distToBox(e0, b))
      const pg = await handOne(bot, ready, e0)
      if (pg) { handedAt.set(pg.id, gameClock.now()); r.handed1++; lastAct = gameClock.now() } else if (gameClock.now() - lastAct > 15000 && lures1 < lures1Max) {
        // 15 с никого в руке — приманка на пол у рта (прицелы ямы pitLures: бросок подобравшего долетит к нам).
        lureAims = lureAims || PG.pitLures(bot, bo)
        const L = lureAims.find(x => x.score >= 5)
        if (L && await PG.tossOut(bot, bo, 'gold_ingot', 1, L.aim)) { lures1++; r.lures1 = lures1 }
        lastAct = gameClock.now()
      }
      await sleep(pg ? 100 : 300)
    }
    if (ownLoop) r.phases.lure = +((gameClock.now() - tl) / 1000).toFixed(1)
    r.frozen = frozen.length
    r.nearAtCapture = nearN
    if (mode === 'freeze' && !frozen.length) { r.ok = false; r.stopped = r.stopped || 'никто не встал над люком'; return r }
    if (mode === 'gather' && nearN < (opts.gatherNear ?? 2)) { r.ok = true; r.penned = false; r.stopped = r.stopped || (r.patience ? r.patience.after + '; к люку не собрались' : 'к люку не собрались'); return r }
    // 3. Поимка: рот закрыть, шаг в B, закрыть P, сломать пол под замершими.
    const tc = gameClock.now()
    if (!(await SL.fillCell(bot, V(plan.M)))) { r.ok = false; r.stopped = 'рот не закрылся'; return r }
    const { stepCell } = require('./booth-trade')
    // Ноги на песке душ — на 0.125 ниже клетки (как sealed.feetCell).
    const inCell = c => { const p = bot.entity.position; const f = p.floored(); const y = bot.entity.onGround && p.y - f.y >= 0.8 ? f.y + 1 : f.y; return f.x === c.x && f.z === c.z && y === c.y }
    // Поимка сорвалась после закрытого рта — вернуть яму (шаг в P, рот открыть через видимую грань), чтобы торг ямы
    // мог продолжиться (s2b-alt06 k=1,5: «в B не шагнул» оставлял закрытую яму).
    const undo = async why => {
      if (!inCell(plan.P)) { await stepCell(bot, V(plan.P), false); await centerIn(bot, V(plan.P), 1500) }
      const m = inCell(plan.P) ? await digSeen(bot, plan.M) : 'не в P'
      r.reopened = m
      r.ok = false; r.stopped = why; return r
    }
    for (let i = 0; i < 3 && !inCell(plan.Bf) && !ctl.aborted; i++) {
      await stepCell(bot, V(plan.Bf), false)
      await centerIn(bot, V(plan.Bf), 1500)
    }
    if (!inCell(plan.Bf)) return undo('в B не шагнул')
    // Рамка тела ещё на краю P (центровка не успела) — сервер не ставит блок в тело: центровать и повторить
    // (s2b-alt03 k=13: «клетка P не закрылась» при закрытом рте).
    let pFilled = false
    for (let i = 0; i < 4 && !pFilled && !ctl.aborted; i++) {
      if (i) { await centerIn(bot, V(plan.Bf), 1500); await sleep(200) }
      pFilled = await SL.fillCell(bot, V(plan.P))
    }
    if (!pFilled) return undo('клетка P не закрылась')
    if (openAll) {
      for (const l of plan.lanes) {
        const s = await digSeen(bot, l.Y)
        if (s === 'ok' || s === 'air') broke.add(l.k); else r.trapdoor = (r.trapdoor || []).concat(`${l.k}:${s}`)
      }
      if (!broke.size) { r.ok = false; r.stopped = 'люки не открылись'; return r }
    }
    for (const e of frozen) {
      if (!bot.entities[e.id] || !inStrip(plan, e)) continue
      for (const l of lanesUnder(plan, e)) {
        if (broke.has(l.k)) continue
        if (mobs(bot, 'piglin', 6).some(b => isBaby(bot, b) && lanesUnder(plan, b).includes(l))) continue
        const s = await digSeen(bot, l.Y)
        if (s === 'ok' || s === 'air') broke.add(l.k); else r.trapdoor = (r.trapdoor || []).concat(`${l.k}:${s}`)
      }
    }
    for (let i = 0; i < 20 && !adults(8).some(e => inPen(plan, e)); i++) await sleep(100)
    await sleep(400)
    r.captured = adults(8).filter(e => inPen(plan, e)).length
    r.phases.capture = +((gameClock.now() - tc) / 1000).toFixed(1)
    r.opened = [...broke]
    if (!openAll && !r.captured) { r.ok = false; r.stopped = 'не упал'; return r }
    }
    // 4. Торг с загоном: каждому свободному — слиток, по кругу.
    r.penned = true
    const tt = gameClock.now()
    let lastPen = tt + (lureFirst ? Math.max(0, (opts.catchSeconds ?? 90) * 1000 - 20000) : openAll ? 40000 : 0)
    let lastLure = 0
    r.lures = 0; r.penMax = r.captured
    const open = [...broke]
    const isIngot = e => { try { const d = e.getDroppedItem && e.getDroppedItem(); return d && d.name === 'gold_ingot' } catch { return false } }
    while (!ctl.aborted && gameClock.now() < until - 3000) {
      if (done()) { r.stopped = 'цель'; break }
      if (!(await goldLeft())) { r.stopped = 'слитки кончились'; break }
      if ((bot.health ?? 20) < 8) { r.stopped = `хп ${Math.round(bot.health)}`; break }
      const pen = adults(8).filter(e => inPen(plan, e))
      trace()
      r.penMax = Math.max(r.penMax, pen.length)
      if (pen.length) lastPen = gameClock.now()
      else if (gameClock.now() - lastPen > 20000) { r.stopped = 'в загоне никого'; break }
      // Рюкзак почти полон — хлам ямы (pitJunk) в траншею: в полный рюкзак добыча не идёт и лежит у ног
      // (s2-lure03: 190 сделок, доставка 82–92 % против 100 % при 90 сделках).
      if (typeof bot.inventory.emptySlotCount === 'function' && bot.inventory.emptySlotCount() < 3) {
        const ta = trenchAim(bot, plan, open, require('../drops').blockGetter(bot))
        if (ta) for (const it of PG.pitJunk(bot)) { try { await bot.lookAt(ta.aim, true); await sleep(80); await bot.tossStack(it); r.junked = (r.junked || 0) + it.count } catch {} }
      }
      const free = pen.filter(e => !aggressive(bot, e) && !admiring(e))
      let n = 0
      for (const pg of free) if (await handOne(bot, [pg], eye())) { n++; r.handed3++ }
      // Пополнение (приём спидраннеров «скинуть в яму»): все в загоне разглядывают — второй слиток они не поднимут
      // (PiglinAi.wantsToPickup: золото в левой руке), малышей в загоне нет, снаружи взрослый в 9 бл. (GoToWantedItem 9)
      // — слиток в траншею: он пойдёт за ним и упадёт в загон.
      if (opts.refill !== false && !n && !free.length && pen.length < (opts.penMax ?? 6) && gameClock.now() - lastLure > 8000) {
        const Zc = V(plan.lanes.find(l => l.k === 0).Z).offset(0.5, 0, 0.5)
        const babyIn = mobs(bot, 'piglin', 8).some(e => isBaby(bot, e) && inPen(plan, e))
        const lying = (Object.values(bot.entities) as any[]).some(e => e.name === 'item' && e.position && inPen(plan, e) && isIngot(e))
        const outside = adults(14).filter(e => !inPen(plan, e) && !aggressive(bot, e) && !admiring(e) && e.position.distanceTo(Zc) <= 9)
        // Малыш ближе к траншее, чем ближайший взрослый, и в 5 бл. — успеет первым, слиток пропадёт; ждём (s2-lure06:
        // прежнее «малыш в 5 бл.» держало загон на 5–8 при 369–582 ожиданиях).
        const nearestAdult = Math.min(...outside.map(e => e.position.distanceTo(Zc)))
        const babyNear = mobs(bot, 'piglin', 14).some(e => isBaby(bot, e) && !inPen(plan, e) && e.position.distanceTo(Zc) <= Math.min(5, nearestAdult + 0.5))
        if (babyNear && !babyIn && !lying && outside.length) r.lureBabyWait = (r.lureBabyWait || 0) + 1
        if (!babyIn && !babyNear && !lying && outside.length) {
          const ta = trenchAim(bot, plan, open, require('../drops').blockGetter(bot))
          if (ta && await PG.tossOut(bot, plan, 'gold_ingot', 1, ta.aim)) { r.lures++; lastLure = gameClock.now() }
          else if (!ta) r.lureNoAim = (r.lureNoAim || 0) + 1
        }
      }
      await sleep(n ? 50 : 150)
    }
    r.phases.trade = +((gameClock.now() - tt) / 1000).toFixed(1)
    r.penNow = adults(8).filter(e => inPen(plan, e)).length
    r.babiesInPen = mobs(bot, 'piglin', 8).filter(e => isBaby(bot, e) && inPen(plan, e)).length
    r.ok = true
    return r
  } finally {
    // Последние сделки: добыча разглядывающих прилетит через ≤6 с, плюс задержка подбора.
    for (let i = 0; i < 14 && !ctl.aborted && mobs(bot, 'piglin', 8).some(e => admiring(e)); i++) await sleep(500)
    await sleep(1500)
    J.stop()
    bot.removeListener('health', onHealth)
    r.seconds = +((gameClock.now() - t0) / 1000).toFixed(1)
    r.spent = r.ingots0 - countOf(bot, 'gold_ingot') - 9 * countOf(bot, 'gold_block')
    r.pearls = countOf(bot, 'ender_pearl') - r.pearls0
    const penIds = new Set(adults(8).filter(e => inPen(plan, e)).map(e => e.id))
    r.all = J.summary()
    // Поля как у boothTrade — для st.pitTrade/mergeTrades в bastion.ts.
    // Приманки обеих фаз (на пол в яме — lures1, в траншею — lures) — тоже вручённое золото.
    r.handed = r.handed1 + r.handed3; r.tossed = (r.lures || 0) + (r.lures1 || 0)
    // Честная доставка (замечание проверки раунда 1): по ВСЕМ броскам взрослых в 24 бл. (r.all) и на потраченный слиток
    // (perIngot = дошло / spent: слиток, поднятый вне загона, малышом или оставшийся лежать, — тоже потеря).
    // fromPen — только броски сидевших в загоне к концу вызова: отдельная метрика удержания, не «доставка».
    r.barterReceipts = r.all.receipts; r.barterDelivered = r.all.delivered; r.delivery = r.all.delivery
    r.perIngot = r.spent > 0 ? +(r.all.delivered / r.spent).toFixed(3) : null
    // boothTrade (фаза ямы в gather) сам считает st.traded.
    if (opts.st) opts.st.traded = (opts.st.traded || 0) + r.handed + r.tossed - (r.pit ? r.pit.handed + r.pit.tossed : 0)
    r.fromPen = J.summary(t => penIds.has(t.pid) && t.y < (plan.F ?? 0) - 1)
    r.ingotsPerSec3 = r.phases && r.phases.trade ? +(r.handed3 / r.phases.trade).toFixed(3) : null
    r.angry = mobs(bot, 'piglin', 16).filter(e => aggressive(bot, e)).length
    if (typeof bot.inventory.emptySlotCount === 'function') r.emptySlots = bot.inventory.emptySlotCount()
    r.hpMin = Math.round(r.hpMin)
    log('загон', { ok: r.ok, stopped: r.stopped, captured: r.captured, handed1: r.handed1, handed3: r.handed3, perSec: r.ingotsPerSec3, spent: r.spent, delivery: r.delivery, perIngot: r.perIngot, penDelivery: r.fromPen.delivery })
  }
}

// Для выбора места (S1): строится ли загон у ямы bo и сколько взрослых сейчас в 5 бл. от люка. Загон быстрее ямы,
// когда торговцев у люка много (арена 5–8 → 0.72–0.78 сл/с против 0.55 у ямы); в бастионе с 1–3 у люка — 0.15–0.41,
// не быстрее ямы (s2-bast03/04), зато доставка 100 % и удержание между пакетами. own(x,y,z) — свой штрек.
function penCheck (bot, bo, own = undefined) {
  const SL = require('../sealed')
  const plan: any = penPlan(bo, (x, y, z) => SL.classOf(bot.blockAt(new Vec3(x, y, z))), { own })
  if (!plan.lanes) return { ok: false, why: plan.why, lanes: 0, near: 0 }
  const T0 = V(plan.lanes.find(l => l.k === 0).T).offset(0.5, 0, 0.5)
  const near = mobs(bot, 'piglin', 24).filter(e => !isBaby(bot, e) && !aggressive(bot, e) && e.position.distanceTo(T0) <= 5).length
  return { ok: true, lanes: plan.lanes.length, near, worth: plan.lanes.length >= 2 && near >= 3 }
}

// Для bastion.ts (S1): та же подпись, что у boothTrade(session, ctl, st, bo, until, {keep, done}); bo — яма со ртом
// (digPit/currentPit). Свой штрек (st.sealedState.own) считается воздухом-своим при проверке клетки B. Итог — r penTrade
// плюс поля boothTrade (handed, tossed, barterReceipts, barterDelivered, delivery, spent, seconds, stopped).
// Загон у ямы не строится (penPlan, нет блоков заложить рот) — тот же вызов торгует обычной ямой (boothTrade), так что
// подключение — замена boothTrade на trade для ям: penned говорит, закрылся ли загон.
async function trade (session, ctl, st, bo, until, { keep = 8, done = () => false, want, refill, penMax, capture }: any = {}) {
  const own = st && st.sealedState && st.sealedState.own
  const seconds = Math.max(20, (until - gameClock.now()) / 1000)
  const ready = penHere(session.bot)
  const r = await penTrade(session, ctl, ready || bo, { plan: ready || undefined, seconds, keep, done, want, refill, penMax, capture, st, own: own ? (x, y, z) => own.has(`${x},${y},${z}`) : undefined })
  if (own && r.own) for (const key of r.own) own.add(key)
  if (!ready && r.ok === false && !r.spent && /^(загон не строится|нет блоков)/.test(r.stopped || '')) {
    const bt = await require('./booth-trade').boothTrade(session, ctl, st, bo, until, { keep, done })
    return { ...bt, mode: 'pit', penned: false, pen: r.stopped }
  }
  return r
}

// RPC pen {mode:'away', back, side, seconds} (сцена S2b «торг → копка → возврат»): уход и возврат. Из клетки бота (B
// загона или P ямы) штрек назад по −d на back клеток и вбок на side (2 клетки высоты, только через видимые грани —
// digSeenAll; клетку, рядом с которой чужой воздух или жидкость, не копает — штрек закрыт), пауза seconds игровых,
// обратно тем же путём. Поворот вбок закрывает линию взгляда из траншеи/от рта. Итог: удержание загона и кто рядом.
async function penAway (session, ctl, p: any = {}) {
  const bot = session.bot
  const SL = require('../sealed')
  const { stepCell } = require('./booth-trade')
  const pen = penHere(bot); const pit = pen ? null : pitHere(bot)
  if (!pen && !pit) return { ok: false, stopped: 'не у загона и не в яме' }
  const home = bot.entity.position.floored()
  const [dx, dz] = (pen || pit).d; const px = dz; const pz = dx
  const T0 = V(pen ? at(pen.M, dx, 0, dz) : pit.O).offset(0.5, 0, 0.5)
  const adults = () => mobs(bot, 'piglin', 24).filter(e => !isBaby(bot, e))
  const census = () => ({ pen: pen ? adults().filter(e => inPen(pen, e)).length : null, near4: adults().filter(e => e.position.distanceTo(T0) <= 4).length, near9: adults().filter(e => e.position.distanceTo(T0) <= 9).length, angry: mobs(bot, 'piglin', 16).filter(e => aggressive(bot, e)).length, brutes: mobs(bot, 'piglin_brute', 16).length })
  const r: any = { ok: false, from: pen ? 'pen' : 'pit', home: xyz(home), atLeave: census(), hpMin: bot.health ?? 20, own: [] }
  const onHealth = () => { r.hpMin = Math.min(r.hpMin, bot.health ?? 20) }
  bot.on('health', onHealth)
  const own = new Set([home, home.offset(0, 1, 0)].map(SL.keyV))
  const firm = v => [SL.SOLID, SL.HARD, SL.GUARD].includes(SL.classOf(bot.blockAt(v)))
  const safe = q => firm(q.offset(0, -1, 0)) && [q, q.offset(0, 1, 0)].every(c => FACES6.every(([a, b, cz]) => { const n = c.offset(a, b, cz); return own.has(SL.keyV(n)) || n.equals(q) || n.equals(q.offset(0, 1, 0)) || firm(n) }))
  const path = []
  let c = home
  const t0 = gameClock.now()
  const go = async (ax, az, n) => {
    let k = 0
    for (; k < n && !ctl.aborted; k++) {
      const q = c.offset(ax, 0, az)
      if (!safe(q)) { r.walls = (r.walls || []).concat(SL.keyV(q)); break }
      const d = await digSeenAll(bot, [q.offset(0, 1, 0), q])
      if (d !== 'ok') { r.dig = d; break }
      own.add(SL.keyV(q)); own.add(SL.keyV(q.offset(0, 1, 0))); r.own.push(SL.keyV(q), SL.keyV(q.offset(0, 1, 0)))
      if (!(await stepCell(bot, q, false))) { r.step = SL.keyV(q); break }
      path.push(q); c = q
    }
    return k
  }
  try {
    r.back = await go(-dx, -dz, p.back ?? 2)
    r.side = await go(px, pz, p.side ?? 6)
    if (!r.side) r.side = -(await go(-px, -pz, p.side ?? 6))
    r.digSecs = +((gameClock.now() - t0) / 1000).toFixed(1)
    const until = gameClock.now() + (p.seconds ?? 60) * 1000
    while (!ctl.aborted && gameClock.now() < until) await sleep(500)
    r.atFar = census()
    for (const q of [...path.slice(0, -1).reverse(), home]) if (!(await stepCell(bot, q, false))) { r.stopped = `назад не шагнул ${SL.keyV(q)}`; break }
    await centerIn(bot, home, 1500)
    r.ok = bot.entity.position.floored().equals(home)
    r.atReturn = census()
    r.awaySecs = +((gameClock.now() - t0) / 1000).toFixed(1)
    return r
  } finally { bot.removeListener('health', onHealth); r.hpMin = Math.round(r.hpMin) }
}

// RPC pen: mode 'pen' — загон, 'pit' — прежний торг из ямы (boothTrade) для сравнения в той же лаборатории.
async function penIntent (session, ctl, p: any = {}) {
  const bot = session.bot
  if (p.mode === 'away') return penAway(session, ctl, p)
  const ready = p.mode !== 'pit' && !p.bo ? penHere(bot) : null
  const bo = p.bo || ready || pitHere(bot)
  if (!bo) return { ok: false, stopped: 'бот не в яме со ртом и не у загона' }
  const seconds = Math.max(20, Math.min(1200, Number(p.timeoutSeconds) || 240))
  const done = p.pearls ? () => countOf(bot, 'ender_pearl') >= p.pearls : () => false
  if ((p.mode || 'pen') === 'pit') {
    const BT = require('./booth-trade')
    const st = { traded: 0, gained: {}, barters: [], tossed: [] }
    const t0 = gameClock.now()
    const r = await BT.boothTrade(session, ctl, st, bo, t0 + seconds * 1000, { keep: p.keep ?? 0, done })
    return { mode: 'pit', ok: true, ...r, ingotsPerSec: r.seconds ? +(r.spent / r.seconds).toFixed(3) : null }
  }
  // own — ключи «x,y,z» своего замкнутого воздуха (сцена: стройка прошлого вызова и штрек ухода), как st.sealedState.own.
  const own = Array.isArray(p.own) ? new Set(p.own) : null
  return penTrade(session, ctl, bo, { plan: ready || undefined, seconds, keep: p.keep, done, want: p.want, catchSeconds: p.catchSeconds, lanes: p.lanes, refill: p.refill, penMax: p.penMax, capture: p.capture, own: own ? (x, y, z) => own.has(`${x},${y},${z}`) : undefined })
}

module.exports = { trade, penCheck, penHere, penPlan, trenchAim, pitHere, inStrip, lanesUnder, inPen, digSeen, digSeenAll, seenFace, throwJournal, penTrade, penIntent, penAway, ADMIRE_MS }
