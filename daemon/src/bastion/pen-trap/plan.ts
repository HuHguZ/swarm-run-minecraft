'use strict'
// Загон пиглинов «люк за окном» (bastion/pen-trap.ts) — геометрия загона и мелкие действия: план у ямы, где загон
// или яма сейчас, полосы и траншея, видимые грани, копка, журнал бросков, вручение. Торг — pen-trap.ts и pen-trap/*.
import { gameClock, Vec3, mobs, isBaby, xyz } from '../take-gold-block'
import PG = require('../predict-gold')

const ADMIRE_MS = 119 * 50 // PiglinAi.admireGoldItem: ADMIRING_ITEM на 119 тиков
const FACES6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const at = (q, dx = 0, dy = 0, dz = 0) => ({ x: q.x + dx, y: q.y + dy, z: q.z + dz })
const V = q => new Vec3(q.x, q.y, q.z)

// Геометрия загона у ямы bo {P,H,M,O,d}. cls(x,y,z) → класс sealed; own(x,y,z) — наш штрек (воздух, закрытый снаружи).
// Чистая функция: { F, M, P, H, Bf, Bh, lanes:[{k,T,Y,Z,W}] } или { why }.
function penPlan (bo, cls, { own = (_x, _y, _z) => false, lanes: want = 3 }: any = {}) {
  const SL: typeof import('../../sealed') = require('../../sealed')
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
  const SL: typeof import('../../sealed') = require('../../sealed')
  const { SIDES4 }: typeof import('../take-gold-block') = require('../take-gold-block')
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
  const SL: typeof import('../../sealed') = require('../../sealed')
  const { SIDES4 }: typeof import('../take-gold-block') = require('../take-gold-block')
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
  const pick: typeof import('../../pick') = require('../../pick')
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
async function digSeen (bot, q, opts: any = {}) {
  const SL: typeof import('../../sealed') = require('../../sealed')
  const v = V(q)
  const b = bot.blockAt(v)
  if (!b) return 'unloaded'
  if (SL.classOf(b) === SL.AIR) return 'air'
  const sf = seenFace(bot, v)
  if (!sf) return 'unseen'
  return SL.digCell(bot, v, { ...opts, face: sf.face, aim: sf.aim })
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

export {
  ADMIRE_MS, FACES6, at, V, penPlan, pitHere, penHere, inStrip, lanesUnder, inPen, trenchAim, seenFace, digSeen, digSeenAll,
  throwJournal, handOne
}
