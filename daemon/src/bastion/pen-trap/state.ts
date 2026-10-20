'use strict'
// Загон пиглинов (penTrade, bastion/pen-trap.ts) — состояние вызова и его рамка. Прежние let и стрелки замыкания
// penTrade — поля объекта pt (PenTrade). Фаза возвращает итог вызова (r — конец) или ничего (дальше по фазам):
// стройка, яма до поимки, поимка — pen-trap/capture.ts, торг с загоном — pen-trap/barter.ts, оркестр — pen-trap.ts.
import { gameClock, countOf, Vec3, mobs, isBaby, aggressive, admiring, sleep, log, unpackGold } from '../take-gold-block'
import * as BF from '../../barter-flow'
import { V, penPlan, inPen, throwJournal } from './plan'
import PG = require('../predict-gold')

export interface PenTrade {
  session: any
  ctl: any
  bo: any
  opts: any
  bot: any
  SL: typeof import('../../sealed')
  t0: number
  until: number
  keep: number
  done: () => boolean
  r: any
  onHealth: () => void
  cls: (x: any, y: any, z: any) => any
  plan: any
  J: any
  handedAt: Map<any, number>
  busyUntil: Map<any, number>
  eye: () => any
  seenAdults: Map<any, any>
  seenBabies: Map<any, any>
  visible: (e: any) => any
  adults: (rad?: number) => any[]
  standingAt: any
  canContinue: () => Promise<boolean>
  goldLeft: () => Promise<boolean>
  mode: string
  lureFirst: boolean
  openAll: boolean
  T0: any
  nearN: number
  traceAt: number
  trace: () => void
  broke: Set<any>
  frozen: any[]
}

// Начало вызова: отчёт, план загона (прежнее начало penTrade).
export function penOpen (session, ctl, bo, opts: any = {}): PenTrade {
  const bot = session.bot
  const pt = { session, ctl, bo, opts, bot } as PenTrade
  pt.SL = require('../../sealed')
  pt.t0 = gameClock.now()
  pt.until = opts.until ?? pt.t0 + (opts.seconds ?? 240) * 1000
  pt.keep = opts.keep ?? 0
  pt.done = opts.done || (() => false)
  pt.r = { mode: 'pen', handed1: 0, handed3: 0, captured: 0, pearls0: countOf(bot, 'ender_pearl'), ingots0: countOf(bot, 'gold_ingot') + 9 * countOf(bot, 'gold_block'), hpMin: bot.health ?? 20, phases: {} }
  pt.onHealth = () => { pt.r.hpMin = Math.min(pt.r.hpMin, bot.health ?? 20) }
  bot.on('health', pt.onHealth)
  pt.cls = (x, y, z) => pt.SL.classOf(bot.blockAt(new Vec3(x, y, z)))
  pt.plan = opts.plan || penPlan(bo, pt.cls, { own: opts.own, lanes: opts.lanes ?? 3 })
  return pt
}

// Загон не строится или нечем заложить рот — отказ (итог r), иначе undefined.
export function penRefuse (pt: PenTrade) {
  const { bot } = pt
  if (!pt.plan.lanes) { bot.removeListener('health', pt.onHealth); return Object.assign(pt.r, { ok: false, stopped: 'загон не строится: ' + pt.plan.why }) }
  pt.r.lanes = pt.plan.lanes.length
  pt.r.plan = { B: pt.plan.Bf, lanes: pt.plan.lanes.map(l => l.T) }
  if (!pt.SL.fillerName(bot) || pt.SL.fillerCount(bot) < 2) { bot.removeListener('health', pt.onHealth); return Object.assign(pt.r, { ok: false, stopped: 'нет блоков заложить рот и клетку' }) }
}

// Журнал бросков, кто вручён и кто занят, видимые взрослые и малыши, можно ли продолжать, хватает ли слитков.
export function penArm (pt: PenTrade) {
  const { bot, session, ctl, opts } = pt
  pt.J = throwJournal(bot)
  pt.handedAt = new Map()
  pt.busyUntil = new Map()
  pt.eye = () => bot.entity.position.offset(0, 1.62, 0)
  pt.seenAdults = new Map()
  pt.seenBabies = new Map()
  pt.visible = e => PG.rayClear((require('../../drops') as typeof import('../../drops')).blockGetter(bot), pt.eye(), e.position.offset(0, PG.PIGLIN_EYE * (isBaby(bot, e) ? 0.5 : 1), 0))
  pt.adults = (rad = 16) => mobs(bot, 'piglin', rad).filter(e => {
    if (!pt.visible(e)) return false
    if (isBaby(bot, e)) { pt.seenBabies.set(e.id, { id: e.id, position: e.position.clone(), width: e.width }); pt.seenAdults.delete(e.id); return false }
    pt.seenBabies.delete(e.id)
    pt.seenAdults.set(e.id, { id: e.id, position: e.position.clone(), free: !aggressive(bot, e) && !admiring(e) })
    return true
  })
  pt.standingAt = bot.entity.position.clone()
  pt.canContinue = async () => {
    if (ctl.aborted || session.bot !== bot || (bot.health ?? 20) <= 0) return false
    if (gameClock.now() >= pt.until) { pt.r.stopped = 'время вышло'; return false }
    if (opts.st && BF.enabled()) {
      const G: typeof import('../../ne-guard') = require('../../ne-guard')
      if (G.busy(bot) || G.hot(bot)) { await G.react(session, ctl); pt.r.stopped = 'страж изменил место'; return false }
    }
    if (bot.entity.position.distanceTo(pt.standingAt) > 0.9) { pt.r.stopped = 'ушёл из места бартера'; return false }
    return true
  }
  // Пересчёт через паузу: стопка при перекладке в руку на миг вне inventory.items() (s2b-alt03 k=5: «слитки кончились»
  // при 27 слитках сверх запаса — второй пакет потом расторговал ещё 86).
  pt.goldLeft = async () => {
    for (let i = 0; i < 3; i++) {
      if (countOf(bot, 'gold_ingot') - pt.keep >= 1) return true
      if (countOf(bot, 'gold_block')) await unpackGold(session, ctl, pt.keep + 18)
      if (countOf(bot, 'gold_ingot') - pt.keep >= 1) return true
      await sleep(250)
    }
    return false
  }
}

// Режим поимки (lure, gather, freeze) и след сбора у люка (прежнее начало try).
export function penModes (pt: PenTrade) {
  const { opts } = pt
  pt.adults()
  // capture: 'lure' (умолчание) — открыть люки и приманить в траншею: вручённый вне полосы разглядывает золото
  // 119 тиков и остаётся снаружи. Явный 'gather' сохраняет торг из ямы до сбора у люка (когда дно издалека не видно),
  // 'freeze' — поимку вручённого над полосой. Готовый загон во всех вариантах сразу продолжает параллельный торг.
  pt.mode = opts.capture === 'gather' || opts.capture === 'freeze' ? opts.capture : 'lure'
  pt.lureFirst = pt.mode === 'lure'
  pt.openAll = pt.mode !== 'freeze'
  pt.r.capture = pt.mode
  pt.T0 = V(pt.plan.lanes.find(l => l.k === 0).T).offset(0.5, 0, 0.5)
  pt.nearN = 0
  pt.traceAt = 0
  pt.r.trace = []
  pt.trace = () => {
    if (gameClock.now() - pt.traceAt < 10000) return
    pt.traceAt = gameClock.now()
    const ds = pt.adults(24).map(e => e.position.distanceTo(pt.T0))
    pt.r.trace.push([Math.round((pt.traceAt - pt.t0) / 1000), ds.filter(x => x <= 4).length, ds.filter(x => x <= 9).length, ds.length, pt.adults(8).filter(e => inPen(pt.plan, e)).length])
  }
  pt.broke = new Set()
}

export function penResume (pt: PenTrade) {
  // Загон уже стоит (penHere: бот в B, рот и P заложены, люки открыты) — сразу торг: пиглины сидели, пока бот копал.
  for (const l of pt.plan.lanes) pt.broke.add(l.k)
  pt.r.resumed = true
  pt.r.captured = pt.adults(8).filter(e => inPen(pt.plan, e)).length
  pt.r.opened = [...pt.broke]
}

// Последние сделки и итог вызова (прежний finally).
export async function penClose (pt: PenTrade) {
  const { bot, ctl, opts } = pt
  // Последние сделки: добыча разглядывающих прилетит через ≤6 с, плюс задержка подбора.
  for (let i = 0; i < 14 && !ctl.aborted && gameClock.now() < pt.until && pt.adults(8).some(e => admiring(e)); i++) await sleep(Math.min(500, pt.until - gameClock.now()))
  if (!ctl.aborted && gameClock.now() < pt.until) await sleep(Math.min(1500, pt.until - gameClock.now()))
  pt.J.stop()
  bot.removeListener('health', pt.onHealth)
  pt.r.seconds = +((gameClock.now() - pt.t0) / 1000).toFixed(1)
  pt.r.spent = pt.r.ingots0 - countOf(bot, 'gold_ingot') - 9 * countOf(bot, 'gold_block')
  pt.r.pearls = countOf(bot, 'ender_pearl') - pt.r.pearls0
  const penIds = new Set(pt.adults(8).filter(e => inPen(pt.plan, e)).map(e => e.id))
  pt.r.all = pt.J.summary()
  // Поля как у boothTrade — для st.pitTrade/mergeTrades в bastion.ts.
  // Приманки обеих фаз (на пол в яме — lures1, в траншею — lures) — тоже вручённое золото.
  pt.r.handed = pt.r.handed1 + pt.r.handed3; pt.r.tossed = (pt.r.lures || 0) + (pt.r.lures1 || 0)
  // Честная доставка (замечание проверки раунда 1): по ВСЕМ броскам взрослых в 24 бл. (r.all) и на потраченный слиток
  // (perIngot = дошло / spent: слиток, поднятый вне загона, малышом или оставшийся лежать, — тоже потеря).
  // fromPen — только броски сидевших в загоне к концу вызова: отдельная метрика удержания, не «доставка».
  pt.r.barterReceipts = pt.r.all.receipts; pt.r.barterDelivered = pt.r.all.delivered; pt.r.delivery = pt.r.all.delivery
  pt.r.perIngot = pt.r.spent > 0 ? +(pt.r.all.delivered / pt.r.spent).toFixed(3) : null
  // boothTrade (фаза ямы в gather) сам считает st.traded.
  if (opts.st) opts.st.traded = (opts.st.traded || 0) + pt.r.handed + pt.r.tossed - (pt.r.pit ? pt.r.pit.handed + pt.r.pit.tossed : 0)
  pt.r.fromPen = pt.J.summary(t => penIds.has(t.pid) && t.y < (pt.plan.F ?? 0) - 1)
  pt.r.ingotsPerSec3 = pt.r.phases && pt.r.phases.trade ? +(pt.r.handed3 / pt.r.phases.trade).toFixed(3) : null
  pt.r.angry = mobs(bot, 'piglin', 16).filter(e => aggressive(bot, e)).length
  if (typeof bot.inventory.emptySlotCount === 'function') pt.r.emptySlots = bot.inventory.emptySlotCount()
  pt.r.hpMin = Math.round(pt.r.hpMin)
  log('загон', { ok: pt.r.ok, stopped: pt.r.stopped, captured: pt.r.captured, handed1: pt.r.handed1, handed3: pt.r.handed3, perSec: pt.r.ingotsPerSec3, spent: pt.r.spent, delivery: pt.r.delivery, perIngot: pt.r.perIngot, penDelivery: pt.r.fromPen.delivery })
}
