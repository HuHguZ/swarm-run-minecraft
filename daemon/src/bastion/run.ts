// Бастион (bastion()) — состояние вызова и общие мелочи над ним. Прежние const/let замыкания bastion() — поля объекта bx
// (BastionRun), прежние внутренние стрелки — функции с bx первым аргументом. Фазы вызова — run-setup (отладка, броня и
// кирка, память, бартер по памяти), run-approach (подход), run-trade (торговое место из штрека), run-loop (цикл добычи);
// оркестр — bastion/bastion.ts.
import { log, mobs, seesMob, gameClock, countOf, Vec3, isBaby, BF, clamp, fireRes, worlds, unpackGold, armGold } from './take-gold-block'
import { MEMO, exitReserveReady, barterRound, DAMAGE_TYPES } from './booth-trade'
import { goldMode } from './gold-mode'

export interface BastionRun {
  session: any
  ctl: any
  p: any
  bot: any
  t0: number
  deadline: number
  mode: string
  wantPearls: number
  wantFire: number
  wantObs: number
  keep: number
  st: any
  rec?: any
  memoKey?: string | null
  memo?: any
  batchRound?: number
  goldPhaseEnd?: number
  barterNext?: number
  lastHp?: number
  onDmg?: (pk: any) => void
  onHp?: () => void
  toolFilter0?: any
  center?: any
  points?: any[]
  idle?: number
  vantage?: number
  barterWalks?: number
  minedSinceRetry?: boolean
  // Итог вызова, найденный внутри цикла добычи (прежний return out(…) из while).
  ret?: any
}

// Итог шага цикла: 'next' — следующий оборот (прежний continue), 'stop' — конец цикла (прежний break; с bx.ret — возврат
// этого итога), undefined — дальше по шагам этого оборота.
export type Turn = 'next' | 'stop' | undefined

export function openRun (session, ctl, p: any): BastionRun {
  const bot = session.bot
  try { (require('.././ne-guard') as typeof import('.././ne-guard')).swatInstall(bot) } catch {}
  try { (require('.././ne-guard') as typeof import('.././ne-guard')).attach(session) } catch {}
  goldMode.fastSafe = p.fastSafe === true || process.env.ND_GOLD_FAST_SAFE === '1'
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 400, 30, 1800) * 1000 - 5000
  const mode = p.mode || 'auto'
  const wantPearls = p.pearls ?? 12
  const wantFire = p.fireRes ?? 3
  // Обсидиан на раму выхода у крепости Края (кампания ND_SH_NETHER: 10 на раму) — тоже цель бартера (вес 40/469, по 1).
  const wantObs = p.obsidian ?? 0
  // Слитки про запас не держим: без золотой брони на теле bastion не идёт (wearGold ниже), а
  // 8 оставленных — это 8 сделок, ~0.5 жемчуга (ревью Codex 29.09: 153 → 145 обменов).
  const keep = p.keep ?? 0
  const st: any = {
    gold: new Map(), chestSeen: new Map(), skip: new Map(), looted: new Set(),
    blocks: 0, bribed: 0, traded: 0, chests: [], fights: [], barters: [], gained: {}, tossed: [], brutes: 0,
    visited: new Set(), lastBlocked: null, bruteSeen: new Map(), bricks: new Map(), been: [],
    pred: new Map(), towered: 0, predWrong: 0, predMiss: 0,
    // outside — подход к стене снаружи (внешние грани шаблона): на ферме пока
    // не лучше подхода через двор, поэтому по параметру (route-10/11 против 6).
    outside: !!p.outside || !!p.high,
    high: !!p.high,
    // sealed — золото закрытым штреком (sealedGold), без обхода двора.
    sealed: p.sealed !== false,
    fastSafe: goldMode.fastSafe,
    // breach — второй план закрытого штрека со вскрытием у входа и у целей (ND_SEALED_BREACH=1 у кампании; 02.10, мерка идёт)
    breach: !!p.breach || process.env.ND_SEALED_BREACH === '1',
    lootChests: p.chests !== false,
    hitBrutes: !!p.hitBrutes
  }
  return { session, ctl, p, bot, t0, deadline, mode, wantPearls, wantFire, wantObs, keep, st }
}

// Итог вызова (прежний out замыкания bastion()).
export function report (bx: BastionRun, stopped = null) {
  const { bot, p, st, mode, t0 } = bx
  const d: any = {
    mode,
    seconds: Math.round((gameClock.now() - t0) / 1000),
    goldBlocksDug: st.blocks,
    bribed: st.bribed,
    ingotsTraded: st.traded,
    chests: st.chests,
    gained: st.gained,
    bag: { gold_ingot: countOf(bot, 'gold_ingot'), gold_block: countOf(bot, 'gold_block'), ender_pearl: countOf(bot, 'ender_pearl'), fire_res: fireRes(bot), obsidian: countOf(bot, 'obsidian'), string: countOf(bot, 'string'), fire_charge: countOf(bot, 'fire_charge') },
    goldSeenLeft: [...st.gold.keys()].length,
    predLeft: st.pred.size,
    ...(st.fastSafe ? { knownGoldLeft: (p.knownGold || []).filter(a => {
      const b = bot.blockAt(new Vec3(...(a as [number, number, number]))); return !b || b.name === 'gold_block'
    }).length } : {}),
    predWrong: st.predWrong || undefined,
    predMiss: st.predMiss || undefined,
    towered: st.towered || undefined,
    sealed: st.sealedState ? { dug: st.sealedState.dug, moves: st.sealedState.moves, fills: st.sealedState.fills, ores: st.sealedState.ores, plans: st.sealedState.plans, planMs: st.sealedState.planMs, walks: st.sealedState.walks, exposed: st.sealedState.exposed, fails: st.sealedState.fails.slice(-6), goldPickups: st.sealedState.goldPickups } : undefined,
    goldNuggets: countOf(bot, 'gold_nugget') || undefined,
    pit: st.pit || undefined,
    pitTrade: st.pitTrade || undefined,
    barterRetry: BF.enabled() && st.barterRetry ? st.barterRetry : undefined,
    barterPlans: st.plans && st.plans.length ? st.plans.slice(-6) : undefined,
    hurts: st.hurts && st.hurts.length ? st.hurts : undefined,
    exit: st.exit || undefined,
    fights: st.fights.length ? st.fights : undefined,
    brutesAvoided: st.brutes || undefined,
    tossed: st.tossed.length ? st.tossed : undefined,
    lastBlocked: st.lastBlocked || undefined,
    entryRoute: st.entryRoute || undefined,
    goldless: st.goldless || undefined
  }
  if (st.supplyNeeded) d.supplyNeeded = st.supplyNeeded
  if (stopped) d.stopped = stopped
  d.note = `Золотых блоков ${st.blocks}, сундуков ${st.chests.filter(c => !c.error && !c.stopped).length}, слитков пиглинам ${st.traded}. ` +
    `В рюкзаке: жемчуг ${d.bag.ender_pearl}, огнестойкость ${d.bag.fire_res}, слитков ${d.bag.gold_ingot} (+${d.bag.gold_block} блоков), обсидиан ${d.bag.obsidian}, нить ${d.bag.string}.`
  if (st.ironNeed) d.need = { what: 'iron_pickaxe', count: 1, have: 0 }
  return d
}

// Память между вызовами (MEMO и журнал: укрытие бартера) — записать.
export function memoSave (bx: BastionRun) {
  const { session, bot, st, memoKey, memo } = bx
  if (!memoKey || !st.sealed || !st.sealedState) return
  const old = memo || { pred: new Map(), mined: new Set() }
  for (const [k, v] of st.pred) old.pred.set(k, { rank: v.rank, piece: v.piece, pos: { x: v.pos.x, y: v.pos.y, z: v.pos.z } })
  for (const [k] of old.pred) if (!st.pred.has(k)) { const b = bot.blockAt(new Vec3(...(k.split(',').map(Number) as [number, number, number]))); if (b && b.name !== 'gold_block') old.mined.add(k) }
  MEMO.set(memoKey, { pred: old.pred, mined: old.mined, looted: new Set(st.looted), owner: bot, dimension: worlds.worldOf(bot), own: st.sealedState.own, filled: st.sealedState.filled, exposed: st.sealedState.exposed, entry: st.sealedState.entry, t: gameClock.now() })
  const CM: typeof import('./cover-memory') = require('./cover-memory')
  const feet = bot.entity.position.floored()
  const current = st.sealedState.own.has(`${feet.x},${feet.y},${feet.z}`) &&
    st.sealedState.own.has(`${feet.x},${feet.y + 1},${feet.z}`) ? feet : st.sealedState.entry
  const record = CM.coverRecord(memoKey, worlds.worldOf(bot), gameClock.wall.now(), st.sealedState.own, current)
  if (record && session.journal.patch) session.journal.patch(state => { state.bastionCovers = CM.storeCover(state.bastionCovers, record) })
}

export function spare (bx: BastionRun) { return countOf(bx.bot, 'gold_ingot') + 9 * countOf(bx.bot, 'gold_block') - bx.keep }
// Огнестойкость — плюс, не цель копки (решение пользователя 06.10 22:33): за неё отдаётся уже добытое золото (оно оплачено),
// но ни копки, ни ожидания ради неё (барьер-модель: слиток стоит 2.4 с торга + 2.5 с копки, FR даёт 0.034 на слиток).
export function done (bx: BastionRun) { const { bot, p } = bx; return countOf(bot, 'ender_pearl') >= bx.wantPearls && (fireRes(bot) >= bx.wantFire || spare(bx) <= 0) && countOf(bot, 'obsidian') >= bx.wantObs && exitReserveReady(bot, p) }
// Сколько слитков нужно на цели (таблица бартера 1.21.11): жемчуг 0.064 на
export function goldTarget (bx: BastionRun) {
  const { bot, p, wantPearls, wantObs } = bx
  return p.gold ?? Math.min(BF.enabled() ? 480 : 240, Math.max(
    BF.enabled() ? BF.pearlBudget(wantPearls - countOf(bot, 'ender_pearl')) : Math.ceil(Math.max(0, wantPearls - countOf(bot, 'ender_pearl')) / 0.064),
    Math.ceil(Math.max(0, wantObs - countOf(bot, 'obsidian')) / (40 / 469)),
    // Нет огня: 34 сделки дают >=95% хотя бы одного fire_charge (40/469).
    !exitReserveReady(bot, p) && !(require('.././nether') as typeof import('.././nether')).exitKit(bot).lighter ? 34 : 0))
}

// Пакет копки — от модели бартера S3 (core/barter-model.barterPlan через barter-flow.plan): при известном золоте бастиона
// (st.pred — карта копии или узнанные стены) копать пакет B* = √(2·S·E[копки]/c) и торговать, а не всё «на 85 % жемчуга» сразу.
// Модель считается на начало пакета (gold 0: добытое ещё не в рюкзаке), её строка — в лог и в итог (detail.plans).
export function batch (bx: BastionRun) {
  const { bot, st, wantPearls, wantFire } = bx
  if (bx.batchRound === st.round) return st.batch
  bx.batchRound = st.round
  const tr = st.pitTrade || {}
  const d = BF.plan({ pearls: countOf(bot, 'ender_pearl'), required: wantPearls, gold: 0, siteIngots: st.pred.size * 9,
    delivered: tr.barterDelivered, thrown: tr.barterReceipts,
    ...(st.traded ? { traded: { ingots: st.traded, seconds: tr.seconds || 0 } } : {}),
    fireRes: { have: fireRes(bot), want: wantFire, valueSeconds: 120 } })
  st.batch = d.action === 'mine' ? Math.max(9, d.batch) : 9
  ;(st.plans ||= []).push({ round: st.round, action: d.action, batch: d.batch, eSeconds: Math.round(d.eSeconds), pReach: Math.round(d.pReach * 100) / 100, why: d.why })
  log(d.line, { round: st.round, site: st.pred.size * 9, pearls: countOf(bot, 'ender_pearl'), want: wantPearls, spare: spare(bx), batch: st.batch })
  return st.batch
}

// Пакет копки, конец фазы золота и счётчик бартера — перед заходом (прежние let batchRound/goldPhaseEnd/barterNext).
export function planGold (bx: BastionRun) {
  const { p, st, mode, deadline, t0 } = bx
  st.round = 0
  bx.batchRound = -1
  st.stopMining = () => mode !== 'gold' && spare(bx) >= (BF.enabled() && st.pred.size && p.gold == null ? batch(bx) : BF.enabled() ? Math.min(144, goldTarget(bx)) : goldTarget(bx))
  if (BF.enabled()) st.fastSafe = true
  // Золоту — не больше 60% вызова: остальное — бартер (прогон 2 лаборатории
  // ходил по точкам обзора все 500 с, и на обмен не осталось ни секунды).
  bx.goldPhaseEnd = mode === 'gold' ? deadline : t0 + (deadline - t0) * 0.6
  bx.barterNext = 0
}

// Без брони: после каждой добычи — броня из неё; пока её нет, ни торга, ни хода по двору.
export async function goldReady (bx: BastionRun) {
  const { session, ctl, bot, st } = bx
  if (!st.goldless) return true
  if (!(await armGold(session, ctl))) return false
  st.goldless = false
  log('золотая броня из добычи бастиона — дальше как обычно', { ingots: countOf(bot, 'gold_ingot'), blocks: countOf(bot, 'gold_block') })
  return true
}

export function piglinsAround (bx: BastionRun) { return mobs(bx.bot, 'piglin', 16).filter(e => !isBaby(bx.bot, e) && seesMob(bx.bot, e)) }

export async function tryBarter (bx: BastionRun, force = false) {
  const { session, ctl, bot, st, mode, keep, deadline } = bx
  if (mode === 'gold' || done(bx) || gameClock.now() < bx.barterNext) return false
  if (!(await goldReady(bx))) return false
  if (!force && spare(bx) < 24) return false
  if (countOf(bot, 'gold_ingot') - keep < 8 && countOf(bot, 'gold_block')) await unpackGold(session, ctl, keep + 27)
  const can = countOf(bot, 'gold_ingot') - keep
  if (can <= 0 || !piglinsAround(bx).length) return false
  const r = await barterRound(session, ctl, st, Math.min(can, 24), deadline)
  log('бартер', { spent: r.spent, handed: r.handed, thrown: r.thrown, stopped: r.stopped, gained: r.gained, s: r.seconds })
  bx.barterNext = gameClock.now() + (r.spent > 0 ? 1500 : 20000)
  if (!(r.spent > 0)) st.lastBarter = r.stopped || 'пиглины не берут'
  return r.spent > 0
}

export function miningSnapshot (bx: BastionRun) {
  const { st } = bx
  return { goldBlocks: st.blocks, chests: st.chests.length,
    dug: st.sealedState?.dug || 0, ownCells: st.sealedState?.own.size || 0, gold: spare(bx) }
}

// Кто и чем бьёт (damage_event: тип урона из реестра 1.21.11, причина) — с позицией, хп и
// блоками вокруг: урон 20→5 за секунды у свалки ямы (pit-dump 30.09) остался без объяснения.
export function watchDamage (bx: BastionRun) {
  const { bot, st, t0 } = bx
  st.hurts = []
  bx.lastHp = bot.health ?? 20
  bx.onDmg = pk => {
    if (!pk || pk.entityId !== bot.entity.id || st.hurts.length >= 40) return
    const f = bot.entity.position
    const nm = v => { const b = bot.blockAt(v); return b ? b.name : '?' }
    const cause = id => { const e = bot.entities[id]; return e ? (e.name || e.username || e.type) : (id >= 0 ? '#' + id : null) }
    const src = bot.entities[(pk.sourceCauseId ?? 0) - 1]
    const rel = src && src.position ? [+(src.position.x - f.x).toFixed(2), +(src.position.y - f.y).toFixed(2), +(src.position.z - f.z).toFixed(2)] : null
    const rec = { t: Math.round((gameClock.now() - t0) / 1000), type: DAMAGE_TYPES[pk.sourceTypeId] || pk.sourceTypeId, by: cause((pk.sourceCauseId ?? 0) - 1), rel, hpBefore: Math.round(bx.lastHp), at: [+f.x.toFixed(2), +f.y.toFixed(2), +f.z.toFixed(2)], feet: nm(f), under: nm(f.offset(0, -0.5, 0)), head: nm(f.offset(0, 1.6, 0)), doing: st.doing || null }
    st.hurts.push(rec)
    log('урон', rec)
  }
  bx.onHp = () => { bx.lastHp = bot.health ?? bx.lastHp }
  bot._client.on('damage_event', bx.onDmg)
  bx.toolFilter0 = bot._ndToolFilter
  bot._ndToolFilter = (require('.././tunnel') as typeof import('.././tunnel')).makeToolFilter(bot, false)
  bot.on('health', bx.onHp)
}

// Конец вызова (прежний finally): слушатели, фильтр инструмента, строгий обход лавы, свои клетки и память.
export function closeRun (bx: BastionRun) {
  const { session, bot, st } = bx
  try { bot.setControlState('sneak', false) } catch {}
  bot._client.removeListener('damage_event', bx.onDmg)
  bot.removeListener('health', bx.onHp)
  bot._ndToolFilter = bx.toolFilter0
  if (st.lavaStrict0 !== undefined) bot._ndLavaStrict = st.lavaStrict0
  // Свои клетки бастиона (штрек к золоту и сундукам, яма) — в общую память штреков (и на диск): обратный путь
  // к порталу идёт по ним, а не вскрытием двора (разбор Codex 30.09: 2 смерти на обратном штреке у бастиона).
  try { if (st.sealedState && st.sealedState.own) (require('.././tunnel') as typeof import('.././tunnel')).rememberOwn(session, st.sealedState.own) } catch {}
  try { memoSave(bx) } catch {}
}

// Слово итога: почему вызов кончился (прерван, не узнан, золото по памяти/шаблону осталось, кончилось, время, бартер встал).
export function finalReport (bx: BastionRun) {
  const { ctl, st, deadline } = bx
  const leftGold = [...st.gold.keys()].length
  // Золото по памяти (карта копии мира), до которого не нашлось пути, — не «кончилось»: neF-Pa25-1 02.10 — 4 блока,
  // «штрек: пути нет» к 26 целям, и кампания пометила бастион выработанным при 24 известных.
  const memLeft = [...st.pred.values()].filter(v => v.piece === 'память').length
  const tplLeft = [...st.pred.entries()].filter(([k, v]) => v.piece !== 'память' && v.piece !== 'видно' && !(st.sealedState && st.sealedState.own && st.sealedState.own.has(k))).length
  let stopped = null
  if (ctl.aborted) stopped = 'прервано'
  else if (st.notRecognized) stopped = 'бастион не узнан — доступных целей после обзора нет'
  else if (done(bx)) stopped = null
  else if (spare(bx) <= 0 && leftGold === 0 && memLeft > 0) stopped = `золото по памяти осталось (${memLeft}), пути к нему нет${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  // S1f: цели шаблона (predictGold: тип и поворот бастиона узнаны) остались — не «кончилось» (вслепую кампания по этой фразе
  // помечала бастион выработанным после первого пакета: s1f-B0-1, 18 слитков при 54 целях шаблона).
  else if (spare(bx) <= 0 && leftGold === 0 && tplLeft > 0 && process.env.ND_BATCH_PHASE !== '0') stopped = `золото по шаблону осталось (${tplLeft}), заход кончился${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  else if (spare(bx) <= 0 && leftGold === 0) stopped = `золото кончилось: видимых блоков больше нет${st.lastBarter ? `; бартер: ${st.lastBarter}` : ''}`
  else if (gameClock.now() >= deadline - 20000) stopped = 'время вышло — позови ещё раз, продолжу'
  else if (st.lastBarter) stopped = `бартер встал: ${st.lastBarter}`
  return report(bx, stopped)
}
