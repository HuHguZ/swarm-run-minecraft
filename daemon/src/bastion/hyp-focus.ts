'use strict'
// Отсев гипотез шаблона бастиона (ND_BASTION_HYP_FOCUS, по умолчанию вкл. с 21.10 06:20, =0 — выкл.; поток ne). Прежде цели всех четырёх гипотез старта шли в план
// вперемешку (98 целей): план брал ближнюю — чаще чужой гипотезы, промах снимал одну цель. Теперь:
//  · гипотезы — только на сетке генератора (jar 1.21.11: корень jigsaw на минимуме X/Z чанка, Y=32 — bp.startFitsGenerator);
//    правда ферм 21.10: 5408 — units r1 (32,32,32) был вторым после units r2 (-17,24,49), 5974 — hoglin r1 (64,32,32) четвёртым
//    после трёх units с x=66 — оба верных остаются первыми после отсева по сетке;
//  · цели плана — одной гипотезы (первой живой по порядку), видимое золото и увиденные сундуки — всегда;
//  · промах у цели снимает гипотезу целиком: на месте золота не золото и не треснутый кирпич (процессоры бастиона 1.21.11 меняют
//    золото только на cracked_polished_blackstone_bricks, 10–30 %) или на месте сундука не сундук (у сундуков процессоров нет).
//    Кусок слота с долей < 1 (варианты валов, центров, боковых стен) снимается сам, гипотеза — нет.
// Отсеянные гипотезы помнятся телом между вызовами (тот же мир и измерение).
import { log, gameClock } from './take-gold-block'

const on = () => process.env.ND_BASTION_HYP_FOCUS !== '0'
const hypKey = s => `${s.type}|${s.r}|${s.t.x},${s.t.y},${s.t.z}`
const pieceKey = c => `${c.piece}|${c.r}|${c.t.x},${c.t.y},${c.t.z}`
const SURE = 0.99

function refutedOf (bot) {
  const m = bot._ndBastionRefuted
  if (!m || m.world !== bot.world || m.dimension !== bot.game?.dimension) bot._ndBastionRefuted = { world: bot.world, dimension: bot.game?.dimension, hyps: new Set<string>(), pieces: new Set<string>() }
  return bot._ndBastionRefuted
}

// Гипотезы старта между вызовами: новые — первыми, прежние (не повторённые новым обзором) — за ними; не больше 6.
function remember (bot, list) {
  const r = refutedOf(bot)
  const old = r.list || []
  const seen = new Set<string>()
  r.list = [...list, ...old].filter(s => { const k = hypKey(s); if (seen.has(k)) return false; seen.add(k); return true }).slice(0, 6)
  return r.list
}

const sourcesOf = v => v.sources || (v.wall ? [{ rank: v.rank, wall: v.wall }] : [])
const hypsOf = v => new Set<string>(sourcesOf(v).map(s => s.wall?.hyp).filter(Boolean))

// Гипотеза, чьи цели сейчас в плане: первая по порядку rememberStarts, у которой остались цели.
function focus (st) {
  let best = null; let bi = Infinity
  const order = st.hypOrder || new Map()
  const see = h => { const i = order.get(h) ?? 99; if (i < bi) { bi = i; best = h } }
  for (const v of st.pred.values()) for (const h of hypsOf(v)) see(h)
  for (const [k, c] of st.chestSeen) if (c.pred && c.hyp && !st.looted.has(k)) see(c.hyp)
  st.focusHyp = best
  return best
}

// Цель в плане при фокусе: видимое/память — всегда; гипотезы — только фокус; без происхождения (стены вышки, сундук-кусок) — нет.
function predAllowed (st, v) {
  if (!on() || v.piece === 'видно' || v.piece === 'память') return true
  return !!st.focusHyp && hypsOf(v).has(st.focusHyp)
}
function chestAllowed (st, c) {
  if (!on() || !c.pred) return true
  return !!c.hyp && c.hyp === st.focusHyp
}

function dropWhere (st, test: (wall: any) => boolean) {
  let n = 0
  for (const [k, v] of [...st.pred.entries()]) {
    const src = sourcesOf(v)
    if (!src.length) continue
    const left = src.filter(s => !test(s.wall))
    if (left.length === src.length) continue
    n++
    if (!left.length) st.pred.delete(k)
    else { v.sources = left; v.rank = left[0].rank; v.wall = left[0].wall; v.piece = left[0].wall.piece }
  }
  for (const [k, c] of [...st.chestSeen.entries()]) if (c.pred && c.wall && test(c.wall)) { st.chestSeen.delete(k); n++ }
  st.pieces = (st.pieces || []).filter(c => !test(c))
  return n
}

function refuteHyp (bot, st, hyp, why) {
  if (!hyp) return
  refutedOf(bot).hyps.add(hyp)
  const n = dropWhere(st, w => w?.hyp === hyp)
  log('гипотеза бастиона снята', { hyp, why, targets: n, next: focus(st) })
}
function refutePiece (bot, st, wall, why) {
  const pk = pieceKey(wall)
  refutedOf(bot).pieces.add(pk)
  const n = dropWhere(st, w => w && pieceKey(w) === pk && w.hyp === wall.hyp)
  log('вариант куска снят', { piece: wall.piece, p: wall.p, hyp: wall.hyp, why, targets: n })
}

// Стоим у цели и видим клетку: name — блок на месте предсказанного золота.
function judgeGold (bot, st, v, name) {
  if (!on() || !v || name === 'gold_block' || name === 'cracked_polished_blackstone_bricks') return
  for (const s of sourcesOf(v)) {
    if (!s.wall?.hyp) continue
    const why = `на месте золота ${name}`
    if ((s.wall.p ?? 1) >= SURE) refuteHyp(bot, st, s.wall.hyp, why)
    else refutePiece(bot, st, s.wall, why)
  }
}
function judgeChest (bot, st, c, name) {
  if (!on() || !c?.pred || !c.wall?.hyp || /^(chest|trapped_chest|barrel)$/.test(name || '')) return
  const why = `на месте сундука ${name}`
  if ((c.wall.p ?? 1) >= SURE) refuteHyp(bot, st, c.wall.hyp, why)
  else refutePiece(bot, st, c.wall, why)
}

// Цели фокуса в r бл. от тела (гнездо золота, которое дешевле добрать сейчас).
function clusterLeft (bot, st, r) {
  if (!on() || !bot.entity) return 0
  focus(st)
  let n = 0
  for (const [k, v] of st.pred) if ((st.skip.get(k) || 0) < gameClock.now() && predAllowed(st, v) && v.pos.distanceTo(bot.entity.position) <= r) n++
  return n
}

// Посты брутов шаблона первой живой гипотезы, которую тело помнит между вызовами (кускам со снятым вариантом — нет): маркеры пула
// piglin_melee (bastion-pieces.brutesOf). Для цены целей, обхода и торга — где брут стоит по шаблону, пока его не видно.
function brutePosts (bot): Array<{ x: number, y: number, z: number }> {
  if (!on() || !bot) return []
  const r = refutedOf(bot)
  const s = (r.list || []).find(h => !r.hyps.has(hypKey(h)))
  if (!s) return []
  const bp: typeof import('../bastion-pieces') = require('../bastion-pieces')
  try { return bp.piecesFromStart(s).filter(c => !r.pieces.has(pieceKey(c))).flatMap(c => bp.brutesOf(c)) } catch { return [] }
}

export { clusterLeft, on, hypKey, pieceKey, refutedOf, remember, focus, brutePosts, predAllowed, chestAllowed, refuteHyp, refutePiece, judgeGold, judgeChest, sourcesOf }
