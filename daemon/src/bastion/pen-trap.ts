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
// penTrade — оркестр вызова: состояние — объект pt (pen-trap/state.ts), геометрия и мелкие действия — pen-trap/plan.ts,
// стройка, яма до поимки и поимка — pen-trap/capture.ts, торг с загоном — pen-trap/barter.ts.
import { gameClock, countOf, Vec3, mobs, isBaby, aggressive, sleep, xyz, centerIn } from './take-gold-block'
import { ADMIRE_MS, FACES6, at, V, penPlan, pitHere, penHere, inStrip, lanesUnder, inPen, trenchAim, seenFace, digSeen, digSeenAll, throwJournal } from './pen-trap/plan'
import { type PenTrade, penOpen, penRefuse, penArm, penModes, penResume, penClose } from './pen-trap/state'
import { penBuild, penLure, penCapture } from './pen-trap/capture'
import { penBarter } from './pen-trap/barter'

// Фазы до торга с загоном (загон ещё не стоит): фаза возвращает итог вызова (r — конец) или ничего (дальше).
const PEN_PHASES: ((pt: PenTrade) => Promise<any>)[] = [penBuild, penLure, penCapture]

// Загон и торг. opts: plan (иначе по месту), seconds, keep (слитков оставить), done(), want (сколько ловить разом),
// catchSeconds (сколько ждать кандидатов в фазе ямы).
async function penTrade (session, ctl, bo, opts: any = {}) {
  const pt = penOpen(session, ctl, bo, opts)
  const refused = penRefuse(pt)
  if (refused) return refused
  penArm(pt)
  try {
    penModes(pt)
    if (pt.plan.ready) penResume(pt)
    else {
      for (const phase of PEN_PHASES) {
        const out = await phase(pt)
        if (out) return out
      }
    }
    return await penBarter(pt)
  } finally {
    await penClose(pt)
  }
}

// Для выбора места (S1): строится ли загон у ямы bo и сколько взрослых сейчас в 5 бл. от люка. Загон быстрее ямы,
// когда торговцев у люка много (арена 5–8 → 0.72–0.78 сл/с против 0.55 у ямы); в бастионе с 1–3 у люка — 0.15–0.41,
// не быстрее ямы (s2-bast03/04), зато доставка 100 % и удержание между пакетами. own(x,y,z) — свой штрек.
function penCheck (bot, bo, own = undefined) {
  const SL: typeof import('../sealed') = require('../sealed')
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
async function trade (session, ctl, st, bo, until, { keep = 8, done = () => false, want, refill, penMax, capture, patience }: any = {}) {
  const own = st && st.sealedState && st.sealedState.own
  const seconds = Math.max(0, (until - gameClock.now()) / 1000)
  const ready = penHere(session.bot)
  const r = await penTrade(session, ctl, ready || bo, { plan: ready || undefined, until, seconds, keep, done, want, refill, penMax, capture, patience, st, own: own ? (x, y, z) => own.has(`${x},${y},${z}`) : undefined })
  if (own && r.own) for (const key of r.own) own.add(key)
  if (!ready && r.ok === false && !r.spent && /^(загон не строится|нет блоков)/.test(r.stopped || '')) {
    const bt = await (require('./booth-trade') as typeof import('./booth-trade')).boothTrade(session, ctl, st, bo, until, { keep, done })
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
  const SL: typeof import('../sealed') = require('../sealed')
  const { stepCell }: typeof import('./booth-trade') = require('./booth-trade')
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
    const BT: typeof import('./booth-trade') = require('./booth-trade')
    const st = { traded: 0, gained: {}, barters: [], tossed: [] }
    const t0 = gameClock.now()
    const r = await BT.boothTrade(session, ctl, st, bo, t0 + seconds * 1000, { keep: p.keep ?? 0, done })
    return { mode: 'pit', ok: true, ...r, ingotsPerSec: r.seconds ? +(r.spent / r.seconds).toFixed(3) : null }
  }
  // own — ключи «x,y,z» своего замкнутого воздуха (сцена: стройка прошлого вызова и штрек ухода), как st.sealedState.own.
  const own = Array.isArray(p.own) ? new Set(p.own) : null
  return penTrade(session, ctl, bo, { plan: ready || undefined, seconds, keep: p.keep, done, want: p.want, catchSeconds: p.catchSeconds, lanes: p.lanes, refill: p.refill, penMax: p.penMax, capture: p.capture, patience: p.patience, own: own ? (x, y, z) => own.has(`${x},${y},${z}`) : undefined })
}

export { penHere, penPlan, trenchAim, pitHere, inStrip, lanesUnder, inPen, digSeen, digSeenAll, seenFace, throwJournal, ADMIRE_MS } from './pen-trap/plan'
export { trade, penCheck, penTrade, penIntent, penAway }
