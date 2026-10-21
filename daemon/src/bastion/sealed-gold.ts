'use strict'
// Золото бастиона штреком: sealedGold — оркестр захода (состояние — sealed-gold/state.ts, объект sg; шаги оборота —
// sealed-gold/steps.ts, route.ts, gold.ts), гипотезы шаблона (rememberStarts), подход к предсказанному золоту (digToPredicted).
import { approachWallSide, approachWallTop } from './tower-scan'
import * as goldEvidence from './gold-evidence'
import * as HF from './hyp-focus'
import { log, xyz, mobs, seesMob, goals, walkGoal, gameClock, seesBlock, reachSet, angerSet, threatens, takeGoldBlock, keyOf } from './take-gold-block'
import { walkUnlessBrute, bruteComing, tunnelTo } from './booth-trade'
import { bruteDefense } from './defense'
import { type SealedRun, type SealTick, type Turn, sgOpen, routeRetryAt } from './sealed-gold/state'
import { sgVitals, sgGuard, sgTargets } from './sealed-gold/steps'
import { sgRoute } from './sealed-gold/route'
import { sgArrive, sgChest, sgMissing, sgWindow, sgTake } from './sealed-gold/gold'

// Порядок шагов оборота — порядок веток прежнего тела while: первая сработавшая ветка решает оборот.
const SG_STEPS: ((sg: SealedRun, tk: SealTick) => Promise<Turn>)[] = [
  sgVitals, sgGuard, sgTargets, sgRoute, sgArrive, sgChest, sgMissing, sgWindow, sgTake
]

// Координаты ниже — гипотезы шаблона из наблюдения fortress, не прочитанные клетки мира.
function rememberStarts (bot, st, starts) {
  const bp: typeof import('../bastion-pieces') = require('../bastion-pieces')
  const focus = HF.on()
  // При фокусе к гипотезам обзора (predictGold: якоря — сундуки, базальт, видимое золото, валы) — гипотезы сетки по всем видимым
  // блокам бастиона (entry-route.assess: маска кусков START_REL, кирпич стен тоже): nbf50-5974 — тело у боковой стены конюшен
  // (12 золота), якорей нет, гипотез 0 за 30 мин.
  const er = focus ? ((require('./entry-route') as typeof import('./entry-route')).memory(bot).assessment?.hypotheses || []).slice(0, 3)
    .map(h => ({ type: h.type, r: h.r, t: h.t, score: h.score, from: ['сетка'] })) : []
  const list = [...(Array.isArray(starts) ? starts : []), ...er]
  const grid = (process.env.ND_BASTION_ROOT_GRID === '1' || focus) && (require('../nether-cover') as typeof import('../nether-cover')).blind()
  const refuted = HF.refutedOf(bot)
  // При фокусе гипотезы помнит тело (HF.remember): изнутри стены обзор их не даёт, а MEMO хранит цели без кусков.
  const possible = (focus ? HF.remember(bot, grid ? list.filter(bp.startFitsGenerator) : list) : grid ? list.filter(bp.startFitsGenerator) : list)
    .filter(s => !focus || !refuted.hyps.has(HF.hypKey(s)))
  if (focus) {
    // Цели памяти прошлого вызова без куска (MEMO хранит только ранг) — заново из гипотез: иначе вид плана пуст, а фокус слеп.
    for (const [k, v] of [...st.pred.entries()]) if (!v.wall && /\//.test(v.piece || '')) st.pred.delete(k)
    st.hypOrder = new Map()
  }
  for (const [i, s] of possible.slice(0, 4).entries()) {
    if (!bp.START_REL[s?.type] || !Number.isInteger(s.r) || s.r < 0 || s.r > 3 ||
        !s.t || !['x', 'y', 'z'].every(k => Number.isFinite(s.t[k]))) continue
    const hyp = HF.hypKey(s)
    if (focus) st.hypOrder.set(hyp, i)
    for (const c of bp.piecesFromStart(s)) {
      const rank = 100 * (i + 1) + c.slot + 1
      if (goldEvidence.on() && st.goldRejected?.has(goldEvidence.pieceKey(c))) continue
      if (focus) { c.hyp = hyp; if (refuted.pieces.has(HF.pieceKey(c))) continue }
      ;(st.pieces ||= []).push(c)
      for (const pos of bp.goldOf(c)) {
        const k = keyOf(pos)
        if (goldEvidence.on()) goldEvidence.claimGold(st, pos, c, rank)
        else if (!st.pred.has(k) && !st.gold.has(k)) st.pred.set(k, { pos, piece: c.piece, rank, wall: c })
      }
      for (const [x, y, z] of bp.lib()[c.piece].chests) {
        const pos = bp.toWorld(c, x, y, z); const k = keyOf(pos)
        if (st.looted.has(k)) continue
        const old = st.chestSeen.get(k)
        if (focus && (!old || old.pred && !old.hyp)) st.chestSeen.set(k, { pos, pred: true, rank, wall: c, hyp })
        else if (!old) st.chestSeen.set(k, { pos, pred: true, rank })
      }
    }
  }
  if (focus) log('гипотезы бастиона', { all: possible.slice(0, 4).map(HF.hypKey), dropped: list.length - possible.length, focus: HF.focus(st), gold: st.pred.size })
}

async function sealedGold (session, ctl, st, until) {
  const sg = sgOpen(session, ctl, st, until)
  const { S } = sg
  turn: while (!ctl.aborted && gameClock.now() < until - 10000) {
    // Оборот без ввода-вывода (шаг ответил 'next' на уже решённых промисах: answerAttack → fight вернулся сразу) крутился в
    // микрозадачах: пакеты и keepalive не читались, часы игры стояли — nbf55-3818: «lost connection: Timed out», демон 2.5 ГБ.
    await new Promise<void>(resolve => setImmediate(resolve))
    const tk: SealTick = {}
    for (const step of SG_STEPS) {
      const r = await step(sg, tk)
      if (r === 'stop') break turn
      if (r === 'next') continue turn
    }
  }
  st.blocks += S.goldPassed + S.bonusBlocks
  S.goldPassed = 0
  S.bonusBlocks = 0
  return S
}

async function digToPredicted (session, ctl, st, t) {
  const bot = session.bot
  // Пол Ада для pathfinder (worlds.tuneMovements: не ниже min(40, где стоишь))
  const floor0 = bot._ndNetherFloor
  // Пол 32 (над морем лавы): к стенам ведут полы жилых блоков на y 35–40, и пол
  bot._ndNetherFloor = 32
  bot._ndMobAvoidOnly = new Set(['piglin_brute', 'hoglin'])
  bot._ndLavaStrict = true
  try { return await digToPredictedBody(session, ctl, st, t) } finally { bot._ndNetherFloor = floor0; bot._ndMobAvoidOnly = null; bot._ndLavaStrict = false }
}

async function digToPredictedBody (session, ctl, st, t) {
  const bot = session.bot
  // Стена известна — сперва на её кромку поверху (один раз за вызов).
  const pr = st.pred.get(t.k)
  if (st.outside && pr && pr.wall && !st.onWall && (st.wallTries || 0) < 2) {
    st.wallTries = (st.wallTries || 0) + 1
    // high — вход в толщу стены высоко над лавой (approachWallSide), иначе
    // прежний подход к низу внешних граней.
    const a = st.high ? await approachWallSide(session, ctl, pr.wall, t.pos) : await approachWallTop(session, ctl, pr.wall)
    st.onWall = a.ok
    log('на кромку стены', { top: xyz(a.top), ok: a.ok, error: a.error, at: xyz(bot.entity.position.floored()) })
  }
  // Брут видит нас — сначала он (столб, удары сверху: bruteDefense), а не
  // общий бой по дороге («бой без победы» с брутом и хоглином на ферме).
  if (mobs(bot, 'piglin_brute', 16).some(e => seesMob(bot, e))) { try { await bruteDefense(session, ctl, st) } catch {} }
  // Издалека — pathfinder к цели на 5 блоков (он ходит по бастиону и копает
  if (!st.onWall && t.pos.distanceTo(bot.entity.position) > 9) {
    const pf0 = bot.pathfinder
    const th0 = pf0 && pf0.thinkTimeout
    if (pf0) pf0.thinkTimeout = 12000
    try { await walkUnlessBrute(session, ctl, new goals.GoalNear(t.pos.x, t.pos.y, t.pos.z, 5), 45000, { dig: true }) } catch {} finally { if (pf0) pf0.thinkTimeout = th0 }
    if (bruteComing(bot)) return { walk: 'брут идёт', block: '?' }
  }
  // Сначала пешком (без копки) к ближайшей к цели клетке, куда можно дойти, и
  try {
    const { walkable }: typeof import('../walkable') = require('../walkable')
    let stage = null
    let bestD = Infinity
    for (const n of walkable(bot, bot.entity.position, { radius: 40, maxNodes: 8000 })) {
      const d = n.pos.distanceTo(t.pos)
      if (d < bestD) { bestD = d; stage = n.pos }
    }
    if (!st.onWall && stage && stage.distanceTo(bot.entity.position) > 2 && bestD + 3 < t.pos.distanceTo(bot.entity.position)) {
      await walkGoal(session, ctl, new goals.GoalBlock(stage.x, stage.y, stage.z), 30000, { dig: false })
    }
  } catch {}
  const trail = []
  const samp = gameClock.setInterval(() => { try { const f = bot.entity.position.floored(); const last = trail[trail.length - 1]; if (!last || !last.equals(f)) trail.push(f) } catch {} }, 200)
  let w
  // Свой штрек по шагу; упёрся — pathfinder с копкой (до 12 с на решение).
  let tun = null
  try {
    tun = await tunnelTo(session, ctl, t.pos)
    w = { ok: tun.ok, error: tun.why }
    // Из толщи стены (high) — только свой штрек: pathfinder с копкой уводил во двор.
    if (!tun.ok && !ctl.aborted && !(st.high && st.onWall)) {
      const pf = bot.pathfinder
      const think = pf && pf.thinkTimeout
      if (pf) pf.thinkTimeout = 12000
      try { w = await walkGoal(session, ctl, new goals.GoalGetToBlock(t.pos.x, t.pos.y, t.pos.z), 45000, { dig: true }) } finally { if (pf) pf.thinkTimeout = think }
    }
  } finally { gameClock.clearInterval(samp) }
  const b = bot.blockAt(t.pos)
  const res: any = { walk: w && w.ok ? 'ok' : (w && w.error) || '?', block: b ? b.name : '?', tunnel: tun ? { ok: tun.ok, steps: tun.steps, why: tun.why } : undefined }
  if (!(w && w.ok)) { st.skip.set(t.k, routeRetryAt(45000)); st.predMiss = (st.predMiss || 0) + 1; return res }
  if (b && b.boundingBox === 'empty' && st.blocks > 0 && t.pos.distanceTo(bot.entity.position) < 3) {
    // Воздух на месте предсказанного — уже выкопан (с видимого списка), не промах.
    st.pred.delete(t.k)
    return { ...res, r: 'уже выкопан' }
  }
  if (!b || b.name !== 'gold_block') {
    // Видим клетку, а золота нет — гипотеза этого ранга неверна целиком.
    const rank = (st.pred.get(t.k) || {}).rank
    if (b && seesBlock(bot, b)) HF.judgeGold(bot, st, st.pred.get(t.k), b.name)
    st.pred.delete(t.k)
    st.predWrong = (st.predWrong || 0) + 1
    // Два промаха одного ранга (процессор generic превращает 30% золота в
    // треснутый кирпич — один промах ещё не приговор).
    if (b && b.boundingBox === 'block' && seesBlock(bot, b)) {
      st.rankMiss = st.rankMiss || {}
      st.rankMiss[rank] = (st.rankMiss[rank] || 0) + 1
      if (st.rankMiss[rank] >= 2) for (const [k, v] of [...st.pred.entries()]) if (v.rank === rank || (rank >= 100 && rank % 100 === 0 && Math.floor((v.rank || 0) / 100) === rank / 100)) st.pred.delete(k)
    }
    return { ...res, r: 'не золото', rank }
  }
  // Злые дойдут по штреку — закрыть его за спиной (ноги и голова).
  const set = reachSet(bot)
  const pigs = angerSet(bot).filter(e => threatens(bot, e, set))
  if (pigs.length && trail.length >= 2) {
    const { placeBlockAt }: typeof import('../build') = require('../build')
    const me = bot.entity.position.floored()
    const back = [...trail].reverse().find(c => !c.equals(me) && c.distanceTo(me) <= 1.5)
    if (back) {
      for (const c of [back, back.offset(0, 1, 0)]) { try { await placeBlockAt(bot, c, { timeoutMs: 1500 }) } catch {} }
      res.sealed = xyz(back)
    }
  }
  st.pred.delete(t.k)
  st.gold.set(t.k, { pos: t.pos.clone(), seen: gameClock.now() })
  res.r = await takeGoldBlock(session, ctl, t.pos, st)
  return res
}

export { planView } from './sealed-gold/route'
export { rememberStarts, sealedGold, digToPredicted, digToPredictedBody }
