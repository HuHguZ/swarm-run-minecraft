'use strict'
// act — вызов навыка демона с отходом, ночной защитой и телеметрией.
import { OW_DEEP } from './flags'
import { call } from './rpc'
import { stage, strategyExecuting, strategyInterrupted, state, sit, hunting, restIdleUntil, died, resting, fighting,
  dangerZone, stairEntrance, known, netherExplored, netherViewRevision, lavaSourceKnown, knownWater, routeSleeping, routeDeadline,
  routeStepNow, setFighting, setKnownWater, setLavaSourceKnown, setManualControl, setNetherExplored,
  setNetherViewRevision, setRouteEntered, setRouteSleeping, setStairEntrance } from './state'
import { telemetry, telParams, seamSnapshot, log } from './log'
import { have, y, dim, RAW, FOOD, todNow } from './queries'
import { acceptResult, sense, refresh, lavaBad, shoreDistance, stopLava } from './observe'
import { castNear, nightHold, weakAndHungry, lavaApproachSeconds } from './stages/table'
import { pearlTrips } from './nether-plan'
import { refugeRunning, awaitRefuge, afterRefuge, tunnelAway, hurtCause, hurtSource, awayFromDanger, answerThreat,
  waitDugOut, mobInTheWay } from './danger'
import { rest } from './guards'
import { eatTo, ensurePick } from './kit'
import { toSurface } from './underground'
import { earlyShield } from './gear'
import { routeMod, ROUTE_SLEEP, routeSleep } from './route-wiring'
import * as gameClock from '../src/game-clock'
const REFUGE_PASS = new Set(['status', 'situation', 'recall', 'remember', 'stop', 'connect', 'disconnect', 'play_mode'])
const NO_REPEAT = new Set(['wait', 'flee', 'fight', 'refuge', 'shelter', 'sleep', 'eat', 'escape_fire', 'surface'])
// ND_OW_NIGHT_TRIP=1: ночной заход поверху, уже оценённый ценой (loop/night: набор есть, озеро под небом — вода и литьё ночью),
// общий ночной запрет наземных ходов не отменяет (f1 27.10, −2642: заход отклонён трижды, литьё на рассвете — Ад на 25.7 мин).
let nightTrip = false
function setNightTrip (v: boolean) { nightTrip = v }

async function act (method, params: any = {}, again = 0) {
  const wallEmergency = method === 'unstuck' && params.cause === 'in_wall' && process.env.ND_OW_BURIAL_STEP === '1' && dim() === 'overworld'
  const safeNight = stage === 'nightWork' && process.env.ND_NIGHT_WORK_SAFE !== '0'
  if (safeNight) {
    if (method === 'dig_down' || method === 'tunnel') params = { ...params, nightWork: true }
    if (method === 'bucket') params = { ...params, walk: false }
    if (method === 'mine' && /^(stone|stone_like|cobblestone)$/.test(params.block)) {
      return act('tunnel', { length: Math.min(8, Math.max(1, Math.ceil((params.count || 2) / 2))), torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 90 })
    }
  }
  // blaze — сам ответ на ифритов у спавнера (бой ведёт навык, тактика его не перебивает ниже уровня 3): прерывание
  // подхода тактикой не повод уходить из боя (s1-post02 06.10: «спавнер в 24 бл. — бой отсюда», а blaze не звался). ne_burrow —
  // уход в толщу, когда FR кончилась у спавнера (s1-post33: «закапываюсь» бросал STRATEGY_INTERRUPTED, смерть через секунды).
  if (strategyExecuting && strategyInterrupted && !REFUGE_PASS.has(method) && !/^(observe|eat|flee|refuge|shelter|escape_fire|surface|wait|blaze|ne_burrow)$/.test(method) && !fighting && !resting) {
    throw Object.assign(new Error('STRATEGY_INTERRUPTED: обстановка изменилась, нужно наблюдение и новый план'), { strategyInterrupted: true })
  }
  // Ночь наступила посреди наземного этапа (поиск, охота, вода, разведка, литьё без лавы рядом): новый переход поверху не
  // начинаю — назад в главный цикл, там ночь идёт под землёй (nightHold). cl-m 14.10: MineIron/вода в болоте ещё 2 мин после
  // темноты, хп 20 → 1 и смерть утром.
  if (sit.surface && (/^(goto|explore|loot|mine|structure)$/.test(method) || (method === 'fight' && /^(food|resource)$/.test(params.purpose || ''))) &&
      !params.netherWood && stage !== '-' && !fighting && !resting && !died && !NIGHT_STAGES.has(stage) && !(/^(cast|nightWork)$/.test(stage) && castNear() && method !== 'explore') && !nightTrip && nightHold()) {
    throw Object.assign(new Error(`ночь, брони нет — наверху ${method} не начинаю, работа под землёй`), { strategyInterrupted: true })
  }
  // Вход своей лестницы с поверхности: наверх потом — ею, без копки нового колодца (cl-q 14.10: подъём столбом с y 16 съел
  // последнюю кирку, 8 мин рукой сквозь камень).
  if (/^(goto|explore|mine|loot|structure)$/.test(method)) await earlyShield()
  // ND_OW_STAIR_HOME=1: вход лестницы и без открытого неба над головой (под кроной, в ложбине), если выше прежнего входа — иначе
  // подъём «столбом» через песок/дно озера (Codex G 21.10: owB1-04 5/5 спусков с surface=false, своя лестница потеряна).
  const stairHome = process.env.ND_OW_STAIR_HOME === '1' && !sit.surface && state.pos && y() >= 55 && (!stairEntrance || stairEntrance.dim !== dim() || y() > stairEntrance.y + 2 ||
    Math.hypot(stairEntrance.x - state.pos.x, stairEntrance.z - state.pos.z) > 96)
  if (method === 'dig_down' && params.mode === 'stairs' && (sit.surface || stairHome) && state.pos && dim() === 'overworld') setStairEntrance({ x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z), dim: dim() })
  // Блок под водой (вода прямо над ним) — не цель: подход вплавь, тактика всплывает и рвёт добычу, этап зовёт её снова
  // (cl-o/cl-q 14.10: камень и железо со дна озера — круги «из воды на берег» по 20+ мин).
  if (method === 'mine' && params.dry === undefined && dim() === 'overworld') params = { ...params, dry: true }
  // Разведка поверху из глубины шла пещерами (cl-z 14.10: поиск построек с y 14 — паук, смерть на 10-й мин; cl-t: с y 16 —
  // зомби): сперва наверх, своей лестницей, если она есть.
  if (method === 'explore' && params.surface === true && dim() === 'overworld' && !died && !fighting && !resting && state.pos) {
    await sense()
    if (!sit.surface && y() < 56) { log('разведка поверху, а я внизу — сперва наверх'); await toSurface() }
  }
  if (method === 'explore' && !params.direction && dim() === 'overworld') {
    const away = awayFromDanger()
    if (away) { log(`разведка — прочь от места нападения (${dangerZone.why}): ${away}`); params = { ...params, direction: away } }
  }
  if (!REFUGE_PASS.has(method) && !wallEmergency && refugeRunning() && !died) {
    await awaitRefuge()
    if (strategyExecuting && strategyInterrupted) throw Object.assign(new Error('STRATEGY_INTERRUPTED: отход завершён, нужно наблюдение и новый план'), { strategyInterrupted: true })
    if (!died && !fighting) await afterRefuge()
    if (died && stage !== '-' && method !== 'stop') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
  }
  if (method === 'stronghold' && params.mode === 'room') {
    await eatTo(18)
    if (!have(/_pickaxe$/)) await ensurePick()
    if (died) throw new Error('умер — поиск комнаты прерван')
    if (strategyExecuting && strategyInterrupted) throw Object.assign(new Error('STRATEGY_INTERRUPTED: обстановка изменилась, нужно наблюдение и новый план'), { strategyInterrupted: true })
  }
  if (stage === 'route' && method === 'goto' && !routeSleeping && ROUTE_SLEEP && dim() === 'overworld' && (have(/_bed$/) > 0 || have(/_wool$/) >= 3)) {
    await sense()
    const t = todNow()
    if (t !== null && t >= 12300 && t <= 23459) {
      setRouteSleeping(true)
      try { await routeSleep('перед переходом') } finally { setRouteSleeping(false) }
    }
  }
  const routeSafety = wallEmergency || REFUGE_PASS.has(method) || /^(observe|eat|flee|refuge|shelter|sleep|escape_fire|surface|wait)$/.test(method) ||
    (method === 'fight' && !/^(food|resource)$/.test(params.purpose || '')) ||
    // Злой голем (ударен, не убит) — уже защита, не добыча: бюджет шага его не обрывает (S8c, s8c-a-v1-1: голем жив после 2 ударов
    // по бюджету построек 73 с, тело ушло копать — убито им через 2 с).
    // S8d (замечание «д»): злой голем вне бюджета — 3 смерти в s8c-g-s (бой шёл, пока не убьёт тело); теперь маршрут уходит от
    // злого голема (goto retreat вне бюджета), а бой с ним — в бюджете шага. ND_ROUTE_GOLEM_FREE=1 — прежнее.
    (method === 'golem' && params.angry === true && process.env.ND_ROUTE_GOLEM_FREE === '1') ||
    (method === 'goto' && params.retreat === true)
  const deepBudget = stage === 'cast' && process.env.ND_OW_DEEP_LAVA === '1'
  // stage проверяется первым: песочницы тестов act() без routeDeadline (campaign-eat-receipt, night-recovery).
  if ((deepBudget || (stage === 'route' && process.env.ND_ROUTE_DEADLINE !== '0')) && routeDeadline && !routeSafety) {
    const left = Math.floor((routeDeadline - gameClock.now()) / 1000)
    if (left < 1) throw Object.assign(new Error(`ROUTE_BUDGET: шаг вышел за бюджет (${method})`), { routeBudget: true })
    params = { ...params, timeoutSeconds: Math.min(params.timeoutSeconds ?? left, left) }
  }
  if (process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_SAFE !== '0' && stage === 'route' && !resting && !fighting && !hunting && dim() === 'overworld') {
    const mining = method === 'dig_down' || method === 'mine_seen' || (method === 'mine' && /stone|_ore/.test(String(params.block || '')))
    const descent = method === 'goto' && Number.isFinite(params.y) && state.pos && params.y < state.pos.y - 3
    if (mining || descent) {
      await sense()
      // Хп — цена, а не порог (правило 06.10, S8b): риск смерти действия (хвост потерь хп по телеметрии × цена смерти) против
      // времени лечения (есть еда — съесть и регенерация; нечем — охота). ND_ROUTE_HPFLEX=0 — прежний порог 13.
      // Есть готовая еда, а сытость < 18 (регенерации нет) — съесть сперва: 1.6 с, и хп растёт и во время копки.
      if ((state.health ?? 20) < 13 && (state.food ?? 20) < 18 && have(FOOD) && process.env.ND_ROUTE_HPFLEX !== '0') { await act('eat', {}); await refresh() }
      const hp = state.health ?? 20
      const canEat = !!(have(FOOD) || have(RAW)) || (state.food ?? 20) >= 18
      const { refuse, riskT, healT } = routeMod.digRefuse(hp, canEat)
      const hpBad = process.env.ND_ROUTE_HPFLEX === '0' ? hp < 13 : refuse
      // Враги и вода — цена и риск (S8c, route.routeActRisk; ND_ROUTE_RISK=0 — прежние запреты «врагов N», «в воде»).
      const foeDamage = sit.foes ? Number(sit.fight && sit.fight.expectedDamage) || 0 : 0
      // В воде — цена копки от её объёма и расстояния до берега (S8d, замечание «г»): берег — лучи глаз вниз-вбок.
      const wet = !!sit.inWater && mining && process.env.ND_ROUTE_RISK !== '0'
      const rr = process.env.ND_ROUTE_RISK === '0' ? null : routeMod.routeActRisk({ hp, canEat, foeDamage, inWater: !!sit.inWater, digging: mining, buried: !!sit.buried,
        ...(wet ? { digBlocks: routeMod.digBlocksOf(method, params), shoreDist: await shoreDistance() } : {}) })
      const why = rr ? (process.env.ND_ROUTE_HPFLEX === '0' && hpBad ? `хп ${Math.round(hp)}` : rr.why)
        : hpBad ? `хп ${Math.round(hp)}${process.env.ND_ROUTE_HPFLEX === '0' ? '' : `: риск ${riskT} т > лечение ${healT} т`}` : sit.foes ? `врагов ${sit.foes}` : sit.inWater ? 'в воде' : sit.buried ? 'завалило' : ''
      if (!why && (hp < 13 || sit.foes)) log(`МАРШРУТ хп ${Math.round(hp)}${sit.foes ? `, врагов ${sit.foes} (урон ~${foeDamage})` : ''}: ${method} — риск ${rr ? rr.riskT : riskT} т ≤ лечение ${rr ? rr.healT : healT} т`)
      if (why) throw Object.assign(new Error(`ROUTE_UNSAFE: ${method} при «${why}» — сперва лечение/уход`), { routeUnsafe: true })
    }
  }
  if (method === 'portal' && params.mode === 'enter') seamSnapshot('before-portal')
  if (method === 'stronghold' && params.mode === 'fill' && params.enter) seamSnapshot('before-end')
  let r
  const dimBefore = state.dimension || 'overworld'
  const pearlTrial = method === 'pearls' && process.env.ND_EM_PRICE_RECEIPTS === '1' ? { at: gameClock.now(), pearls: have('ender_pearl') } : null
  const tel = telemetry.on() ? { t0: gameClock.now(), wallT0: gameClock.wall.now(), before: telemetry.snapshot(state, sit) } : null
  try {
    r = await call(method, params)
  } catch (e) {
    log(`${method} RPC-ОШИБКА ${e.message}`)
    if (tel) telemetry.record({ level: 'act', skill: method, stage, step: routeStepNow, again, params: telParams(params), sec: Math.round((gameClock.now() - tel.t0) / 100) / 10, wallSec: (gameClock.wall.now() - tel.wallT0) / 1000, ok: false, status: 'rpc_error', why: String(e.message).slice(0, 240), before: tel.before })
    return { status: 'failed', error: e.message, detail: {} }
  }
  acceptResult(r)
  if (pearlTrial) {
    pearlTrips.seconds += Math.max(0, gameClock.now() - pearlTrial.at) / 1000
    if (!died && (state.health ?? 0) > 0 && dimBefore === 'the_nether' && dim() === 'the_nether') {
      pearlTrips.pearls += Math.max(0, have('ender_pearl') - pearlTrial.pearls)
      if (Number(r.detail?.seenEndermen) > 0) pearlTrips.zero = 0
      else if (r.status === 'done' && r.detail?.seenEndermen === 0 && r.detail?.prepared !== false) pearlTrips.zero++
    }
  }
  const eatFailure = method === 'eat' && r.detail?.ate === null
    ? Object.fromEntries(['error', 'during', 'held', 'offHand', 'windowOpen', 'busy', 'tried', 'food', 'note']
      .filter(key => Object.prototype.hasOwnProperty.call(r.detail, key)).map(key => [key, r.detail[key]])) : null
  if (method === 'fortress' && dim() === 'the_nether' && Number.isFinite(r.detail?.explored)) setNetherExplored(Math.max(netherExplored, r.detail.explored))
  if (method === 'fortress' && dim() === 'the_nether' && Number.isFinite(r.detail?.frontierRevision)) setNetherViewRevision(Math.max(netherViewRevision, r.detail.frontierRevision))
  if (tel) {
    const after = telemetry.snapshot(state, sit)
    const barter = method === 'bastion' ? {
      barterMode: params.mode || 'auto', barterSite: { x: params.x, z: params.z },
      ...(r.detail?.pitTrade ? { barterReceipts: Number(r.detail.pitTrade.barterReceipts) || 0,
        barterDelivered: Number(r.detail.pitTrade.barterDelivered) || 0 } : {}),
      ...(r.detail?.barterRetry ? { barterRetry: String(r.detail.barterRetry).slice(0, 300) } : {}),
      ...(Array.isArray(r.detail?.sealed?.fails) ? { sealedFails: r.detail.sealed.fails.slice(-6).map(failure => String(failure).slice(0, 300)) } : {}),
      ...(r.detail?.barterCover ? { barterCover: r.detail.barterCover } : {})
    } : {}
    telemetry.record({ level: 'act', skill: method, stage, step: routeStepNow, again, params: telParams(params), sec: Math.round((gameClock.now() - tel.t0) / 100) / 10, wallSec: (gameClock.wall.now() - tel.wallT0) / 1000, ...telemetry.outcome(r), before: tel.before, after, gained: telemetry.delta(tel.before, after), ...barter, ...(eatFailure ? { eatFailure } : {}) })
  }
  if (state.dimension && state.dimension !== dimBefore) seamSnapshot(`${dimBefore}->${state.dimension}`)
  if (state.dimension === 'the_nether' || /Мир сменился \(верхний мир → Ад\)/.test(String((r.detail && r.detail.stopped) || ''))) setRouteEntered(true)
  if (stage !== '-' && state.playPolicy?.mode === 'free') {
    setManualControl(true)
    throw new Error('игрок переключил free — передаю управление, кампанию прекращаю')
  }
  const d = r.detail || {}
  const bits = []
  if (eatFailure) bits.push(`eatFailure: ${JSON.stringify(eatFailure)}`)
  if (r.error) bits.push(`ошибка: ${String(r.error).slice(0, 300)}`)
  if (d.stopped) bits.push(`stopped: ${String(d.stopped).slice(0, 300)}`)
  if (d.need) bits.push(`need: ${JSON.stringify(d.need)}`)
  if (method === 'bastion') {
    if (d.barterRetry) bits.push(`barterRetry: ${String(d.barterRetry).slice(0, 300)}`)
    if (Array.isArray(d.sealed?.fails) && d.sealed.fails.length) bits.push(`штрек: ${d.sealed.fails.slice(-2).map(failure => String(failure).slice(0, 300)).join(' / ')}`)
    if (d.barterCover?.position) bits.push(`укрытие: ${JSON.stringify(d.barterCover.position)}, земля ${d.barterCover.onGround}`)
  }
  if (d.note) bits.push(`note: ${String(d.note).slice(0, 200)}`)
  if (d.gained && Object.keys(d.gained).length) bits.push(`+${JSON.stringify(d.gained)}`)
  if (Array.isArray(d.kills) && d.kills.length) bits.push(`убиты: ${d.kills.join(',')}`)
  if (typeof d.picked === 'number') bits.push(`подобрано: ${d.picked}`)
  if (method === 'fight' && (d.target || d.swings !== undefined)) bits.push(`бой: ${d.target || '?'}, взмахов ${d.swings ?? 0}, попаданий ${d.landed ?? '?'}`)
  if (d.arrows) bits.push(`выстрелы: ${d.arrows}`)
  if (method === 'portal' && Array.isArray(d.cast)) bits.push(`литьё: ${d.frame || ''} отлито ${d.cast.length}, черпаков ${d.refills ?? 0}, копано ${d.dug ?? 0}, окон ${d.windows ?? 0}${d.skipped ? `, пропущено ${d.skipped}` : ''}${d.site ? `, место ${JSON.stringify(d.site)}` : ''}${d.lit !== undefined ? `, зажёг ${d.lit}` : ''}${Array.isArray(d.trace) && d.trace.length ? `; след: ${d.trace.slice(-8).join(' / ')}` : ''}`)
  const evs = (r.events || []).filter(e => /death|УМЕР|fleeing|retaliat|no_tool|buried|stuck|looted|dimension/.test(e.type))
  if (evs.length) bits.push(`события: ${evs.map(e => e.type).join(',')}`)
  if (r.by) bits.push(`прервано: ${r.by.type}`)
  if (r.code && r.code !== 'OK') bits.push(`код ${r.code}`)
  const p = state.pos ? `(${state.pos.x},${state.pos.y},${state.pos.z})` : ''
  log(`${method} ${JSON.stringify(params)} → ${r.status} hp${Math.round(state.health ?? 0)} еда${state.food ?? '?'} ${p} ${bits.join(' | ')}`)
  if (died && stage !== '-' && method !== 'stop') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
  // The tactical body keeps protecting us; return its interruption before legacy recovery takes over.
  if (strategyExecuting && strategyInterrupted) throw Object.assign(new Error('STRATEGY_INTERRUPTED: обстановка изменилась, нужно наблюдение и новый план'), { strategyInterrupted: true })
  const cut = !wallEmergency && !REFUGE_PASS.has(method) && method !== 'refuge' && ((r.by && r.by.type === 'emergency') || state.busy === 'refuge')
  if (cut) {
    const ref = await awaitRefuge(r.by && r.by.type === 'emergency' ? (r.by.why || r.by.from || '') : '')
    if (!died && !fighting && !(await tunnelAway(ref && ref.code))) await afterRefuge()
    if (died && stage !== '-') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
    // Маршрут: вместо порога 13 — риск (S8c, замечание г): отлёжка, только если риск продолжать дороже лечения (route.digRefuse);
    // еда есть, сытость < 18 — съесть (1.6 с, регенерация пойдёт по ходу шага); без еды отлёжка не лечит. ND_ROUTE_RISK=0 — порог 13.
    const routeSafe = process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_SAFE !== '0' && stage === 'route'
    const hpLow = () => {
      const hp = state.health ?? 20
      if (!routeSafe) return hp < 10
      if (process.env.ND_ROUTE_RISK === '0') return hp < 13
      return routeMod.digRefuse(hp, !!(have(FOOD) || have(RAW)) || (state.food ?? 20) >= 18).refuse
    }
    if (routeSafe && process.env.ND_ROUTE_RISK !== '0' && !died && (state.health ?? 20) < 13 && (state.food ?? 20) < 18 && have(FOOD)) { await act('eat', {}); await refresh() }
    if (!safeNight && !died && !resting && !fighting && hpLow()) await rest()
    if (died && stage !== '-') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
    if (!strategyExecuting && stage !== 'nightWork' && !died && r.status !== 'done' && !hpLow() && !NO_REPEAT.has(method) && again < 2 && (state.dimension || 'overworld') === dimBefore) {
      log(`повторяю шаг после отхода: ${method}`)
      return act(method, params, again + 1)
    }
    return r
  }
  if (dim() === 'overworld' && r.detail) {
    // Лава из строки стопа копки — только видимая/слышимая (stopLava, S8d: чутьё штрека может лишь отказать копать).
    const dugInto = !(Array.isArray(r.detail.blocks) && r.detail.blocks.some(b => b && b.name === 'lava')) && !(r.detail.found === 'lava') ? await stopLava(r) : null
    const seenLava = (Array.isArray(r.detail.blocks) ? r.detail.blocks : []).find(b => b && b.name === 'lava') ||
      (r.detail.found === 'lava' && r.detail.at ? { nearest: r.detail.at } : null) ||
      (dugInto ? { nearest: dugInto } : null)
    const seenIsSource = method === 'explore' && params.lavaSource === true
    const closer = q => !!known.lava && !!state.pos && (process.env.ND_OW_KIT_LAVA !== '0'
      ? lavaApproachSeconds(q, seenIsSource) < lavaApproachSeconds(known.lava, lavaSourceKnown)
      : OW_DEEP && Math.hypot(q.x - state.pos.x, (q.y ?? y()) - state.pos.y, q.z - state.pos.z) + 8 <
        Math.hypot(known.lava.x - state.pos.x, (known.lava.y ?? y()) - state.pos.y, known.lava.z - state.pos.z))
    if (seenLava && seenLava.nearest && (!known.lava || closer(seenLava.nearest)) && !lavaBad(seenLava.nearest)) {
      known.lava = seenLava.nearest
      if (process.env.ND_OW_KIT_LAVA !== '0') setLavaSourceKnown(seenIsSource)
      log(`видел лаву на ${known.lava.x},${known.lava.y},${known.lava.z} — запомнил`)
      try { await call('remember', { kind: 'лава', text: `лава на ${known.lava.x},${known.lava.y},${known.lava.z}`, place: 'лава' }) } catch {}
    }
    if ((OW_DEEP || process.env.ND_OW_KIT_WATER !== '0') && !known.portal) {
      const wet = /вода (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String(r.detail.stopped || ''))
      const seenW = (Array.isArray(r.detail.blocks) ? r.detail.blocks : []).find(b => b && b.name === 'water' && b.nearest)
      // M's route may pursue only seen water: hazardAt's hidden-liquid veto is not a map.
      const roundtrip = process.env.ND_OW_WATER_ROUNDTRIP === '1'
      // Rank the whole known route, not just the distance to the next bucket fill.
      // Same travel priors as lavaApproachSeconds; no new source or safe path is inferred.
      const waterPrice = p => roundtrip && lavaSourceKnown && known.lava
        ? Math.hypot(p.x - state.pos.x, p.z - state.pos.z) / 2.5 + Math.abs(p.y - y()) * 2 +
          Math.hypot(p.x - known.lava.x, p.z - known.lava.z) / 2.5 + Math.abs(p.y - (known.lava.y ?? y())) * 2
        : Math.hypot(p.x - state.pos.x, p.y - state.pos.y, p.z - state.pos.z)
      const lookout = process.env.ND_OW_LAKE_WATER_LOOK === '1'
      const surveyWater = lookout && method === 'portal_natural' && params.mode === 'survey' && Array.isArray(r.detail.waterSources)
        ? r.detail.waterSources : []
      const candidates = [seenW?.nearest, ...surveyWater].filter(p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k])))
      const q = roundtrip || lookout ? state.pos && candidates.sort((a, b) => waterPrice(a) - waterPrice(b))[0]
        : process.env.ND_NIGHT_KIT_ROUTE === '1' ? seenW?.nearest
        : wet ? { x: +wet[1], y: +wet[2], z: +wet[3] } : seenW ? seenW.nearest : null
      if (q && state.pos && !have('water_bucket') && (y() < 60 || process.env.ND_OW_KIT_WATER !== '0') &&
          (!knownWater || waterPrice(q) < waterPrice(knownWater))) {
        setKnownWater(q)
        if (roundtrip || lookout) log(`вода для литья: видел ${q.x},${q.y},${q.z}${roundtrip && lavaSourceKnown && known.lava ? `; путь через воду к лаве ≈ ${Math.round(waterPrice(q))} с` : ''}`)
      }
    }
  }
  if (!died && !fighting && (r.events || []).some(e => /^(buried|digging_out|still_buried)$/.test(e.type))) {
    await sense()
    if (sit.buried) await waitDugOut()
  }
  // Навык отказал из-за моба — ответить на моба, а не звать тот же навык снова (cl-b 14.10: 12 отказов литья CAST_UNSAFE подряд
  // при зомби в 2 бл., тот же отказ подъёма, ночь — смерть от скелета).
  if (!fighting && !died && !SELF_GUARDED.has(method) && method !== 'refuge' && await mobInTheWay(r)) return r
  const hurt = (r.by && (r.by.type === 'damage' || r.by.type === 'low_health')) || (r.events || []).some(e => e.type === 'damage')
  if (hurt && !fighting && !died && !SELF_GUARDED.has(method)) {
    setFighting(true)
    try { await answerThreat(hurtCause(r), hurtSource(r)) } finally { setFighting(false) }
  }
  if (!safeNight && !resting && !fighting && method !== 'wait' && (state.health ?? 20) < 10 && !died &&
    (gameClock.now() > restIdleUntil || have(FOOD) || have(RAW))) await rest()
  if (!safeNight && !died && !resting && !fighting && !hunting && stage !== '-' && stage !== 'food' && weakAndHungry()) {
    throw new Error(`хп ${Math.round(state.health ?? 0)} и еды нет — бросаю «${stage}», сначала еда`)
  }
  return r
}
const SELF_GUARDED = new Set(['fight', 'flee', 'refuge', 'blaze', 'pearls', 'dragon', 'sleep', 'bastion'])
// Этапы, которые ночь ведут сами (iron: вниз и штреки) или не ходят поверху (крафт, еда, лечение).
const NIGHT_STAGES = new Set(['iron', 'MineIron', 'stone', 'AcquireStoneTools', 'CraftPortalKit', 'EatFood', 'Heal', 'PrepareBread'])

export { act, setNightTrip }
