'use strict'
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')
const gameClock = require('./src/game-clock')
const telemetry = (() => { try { return require('./src/telemetry') } catch { return { on: () => false, snapshot: () => null, delta: () => ({}), outcome: () => ({}), record () {} } } })()
const telParams = p => { try { return JSON.stringify(p).slice(0, 300) } catch { return null } }

const WS = process.env.ND_WS || 'ws://127.0.0.1:8769'
const LOG = process.env.ND_CAMPAIGN_LOG || path.join(__dirname, 'campaign.log')
const only = process.argv[2] ? process.argv[2].split(',') : null

const ws = new WebSocket(WS)
let rid = 0
const pending = new Map()
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++rid
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
ws.on('message', raw => {
  const m = JSON.parse(raw.toString())
  gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  if (m.type === 'clock') return
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => gameClock.sleep(ms)

let T0 = gameClock.now()
gameClock.changes.once('bound', clock => { if (clock) T0 = clock.now() })
let stage = '-'
let lastStage = '-'
const PAUSE_MIN = [5, 10, 20, 40]
const WATCHDOG_MIN = Math.max(1, Number(process.env.ND_WATCHDOG_MIN) || 45)
let manualControl = false
let strategyExecuting = false
let strategyInterrupted = false
let tacticalRevision = 0
let state: any = {}
let sit: any = {}
const E2E = process.env.ND_E2E === '1'
let memorySnapshot = null
const SEAM_FLAGS = ['ND_E2E', 'ND_END_SEAM', 'ND_ENDKIT', 'ND_WORLD_SEED', 'ND_EYES_NEED',
  'ND_ROUTE', 'ND_ROUTE_FOOD2', 'ND_OW_DEEP', 'ND_OW_HEAR', 'ND_PORTAL_NATURAL',
  'ND_BASTION_FIRST', 'ND_NE_ROUTE', 'ND_NE_STAY', 'ND_SH_NETHER', 'ND_SH_STAY', 'ND_SH_BLIND', 'ND_OBS_EXIT',
  'ND_SEALED_BREACH', 'ND_SPAWNER_TUNNEL', 'ND_GOLD_FAST_SAFE', 'ND_GUARD', 'ND_BLAZE_FP', 'ND_ENDERMEN',
  'ND_EMERGENCY', 'ND_UNSTUCK', 'ND_BRIDGE', 'ND_SPRINT', 'ND_PEARL_GOTO',
  'ND_RUNNER', 'ND_RUN_SWORD', 'ND_RUN_SWORD_PED', 'ND_CRYSTALS', 'ND_CRYS_KEEP', 'ND_DIGUP', 'ND_DIGUP_FIRST']
function seamSnapshot (seam) {
  if (!E2E) return
  log(`СТЫК ${JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((gameClock.now() - T0) / 1000),
    seam, stage, body: { dimension: state.dimension, pos: state.pos, health: state.health, food: state.food,
      inventory: state.inventory || {}, armor: state.armor || {}, offHand: state.offHand || null,
      potions: state.potions || null, effects: state.effects || null },
    situation: { tod: sit.tod ?? null, night: sit.night ?? null, surface: sit.surface ?? null },
    memory: memorySnapshot, known, flagsExplicit: Object.fromEntries(SEAM_FLAGS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])) })}`)
}
if (require.main === module) { try { fs.appendFileSync(LOG, `==== ${new Date().toISOString().slice(0, 10)} ${new Date().toTimeString().slice(0, 8)} запуск кампании, pid ${process.pid}, этапы: ${process.argv[2] || 'все'} ====
`) } catch {} }
function log (line) {
  const t = new Date().toTimeString().slice(0, 8)
  const m = Math.round((gameClock.now() - T0) / 60000)
  const s = `[${t} +${String(m).padStart(3)}м] ${stage.padEnd(10)} ${line}`
  console.log(s)
  try { fs.appendFileSync(LOG, s + '\n') } catch {}
}
function bag () {
  const inv = state.inventory || {}
  return Object.entries(inv).map(([k, v]) => `${k}×${v}`).join(' ') || 'пусто'
}

let lastDeathSeen
function acceptResult (r) {
  const event = r.by?.type === 'death' ? r.by : (r.events || []).find(e => e.type === 'death')
  const stamp = r.state?.lastDeathAt
  const changed = stamp && lastDeathSeen !== undefined && stamp !== lastDeathSeen
  if (event || changed) {
    lostBag = state.inventory || {}
    lostAt = event?.pos || state.pos || null
    died = true
  }
  if (stamp !== undefined) lastDeathSeen = stamp
  if (r.state) {
    const revision = r.state.replanRevision ?? r.state.tactics?.replanRevision ?? tacticalRevision
    if (strategyExecuting && revision !== tacticalRevision) strategyInterrupted = true
    tacticalRevision = revision
    state = r.state
  }
  if (strategyExecuting && (r.status === 'interrupted' || [...(r.by ? [r.by] : []), ...(r.events || [])].some(e => /^(tactical|tactical_released|emergency)$/.test(e.type)))) strategyInterrupted = true
  if (E2E && (event || changed)) {
    seamSnapshot('death')
    throw Object.assign(new Error('E2E_DEATH: смерть = провал сквозного прогона'), { stopCampaign: true, code: 'E2E_DEATH' })
  }
  for (const e of [...(r.by ? [r.by] : []), ...(r.events || [])]) {
    if (e && e.type === 'emergency') refugeSeenAt = gameClock.now()
    if (e && e.type === 'refuge') { lastRefuge = e; refugeSeenAt = 0 }
  }
}

let refugeSeenAt = 0
let lastRefuge = null
const REFUGE_PASS = new Set(['status', 'situation', 'recall', 'remember', 'stop', 'connect', 'disconnect', 'play_mode'])
const NO_REPEAT = new Set(['wait', 'flee', 'fight', 'refuge', 'shelter', 'sleep', 'eat', 'escape_fire', 'surface'])
const refugeRunning = () => state.busy === 'refuge' || refugeSeenAt > 0
async function awaitRefuge (why = '') {
  log(`идёт аварийный отход автопилота${why ? ` (${why})` : ''} — жду его конца, своё не зову`)
  for (let i = 0; i < 1200 && !died; i++) {
    if (state.busy !== 'refuge' && !(refugeSeenAt && i < 4)) break
    await sleep(500)
    try { acceptResult(await call('status')) } catch { break }
  }
  refugeSeenAt = 0
  const e = lastRefuge
  lastRefuge = null
  log(`отход кончился${e ? `: ${e.how || '?'}${e.code ? ' ' + e.code : ''}, хп ${e.hp0 ?? '?'} → ${e.hp ?? '?'}${e.healed ? ' (вылечился)' : ''}, ${e.seconds ?? '?'} с` : ''}; хп ${Math.round(state.health ?? 0)}`)
  return e
}
async function afterRefuge () {
  if (died) return
  await sense()
  if (!sit.foes || died) return
  const was = fighting
  fighting = true
  try {
    const first = (sit.fight && sit.fight.first) || {}
    if (process.env.ND_CREEPER_DODGE !== '0' && ((sit.fight && sit.fight.order) || []).some(o => o && o.name === 'creeper' && o.dist <= 8)) {
      log('после отхода рядом крипер — в коробку и пересидеть, а не бегом к той же работе')
      await act('refuge', { minHp: 20, maxSeconds: 60, why: 'крипер рядом после уклона' })
      return
    }
    const noFight = first.name === 'drowned' || ((sit.fight && sit.fight.order) || []).some(o => o && o.name === 'drowned' && o.dist <= 10)
    if (sit.foes <= 2 && sit.armed && !sit.inWater && !first.swelling && !noFight && (state.health ?? 0) >= 10 && sit.verdict !== 'уходить') {
      log(`после отхода рядом ${sit.foes} — дерусь`)
      await fightOrLeave({ timeoutSeconds: 30, retreatAtHealth: 7 })
    } else {
      log(`после отхода рядом ${sit.foes} — не дерусь, ухожу`)
      if (!sit.surface && process.env.ND_CROWD_REFUGE !== '0' && await boxAndDown(`после отхода рядом ${sit.foes} — коробка и вниз`)) return
      await act('flee', { timeoutSeconds: 20 })
    }
  } finally { fighting = was }
}
async function refugeRun (why, { minHp = 16, maxSeconds = 120, untilDawn = false, force = false } = {}) {
  if ((state.health ?? 0) >= minHp && !sit.foes && !force) return null
  const was = fighting
  fighting = true
  let r
  try { r = await act('refuge', { minHp, maxSeconds, why, ...(untilDawn ? { untilDawn: true } : {}) }) } finally { fighting = was }
  const d = (r && r.detail) || {}
  if (d.how) log(`отход: ${d.note || d.how}${d.code && d.code !== 'OK' ? ` [${d.code}]` : ''}`)
  if (await tunnelAway(d.code)) return r
  await afterRefuge()
  return r
}

let boxingDown = false
async function boxAndDown (why) {
  if (boxingDown || died) return false
  boxingDown = true
  const was = fighting
  fighting = true
  try {
    const r = await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why })
    if (died || !(r && r.detail && r.detail.stayed)) return false
    if (!have(/_pickaxe$/)) await ensurePick()
    const h = await act('shelter', { mode: 'enter', depth: 3 })
    if (died) return true
    if (closedShelter(h)) { log('коробка → нора из неё: дальше работаю снизу'); return true }
    log('из коробки вниз не вышло')
    return false
  } finally { fighting = was; boxingDown = false }
}

let tunnelingAway = false
async function tunnelAway (code) {
  if (process.env.ND_CROWD_REFUGE === '0' || code !== 'NO_FOOD' || died || tunnelingAway) return false
  tunnelingAway = true
  try { return await tunnelAwayBody() } finally { tunnelingAway = false }
}
async function tunnelAwayBody () {
  await sense()
  if (sit.surface || dim() !== 'overworld' || sit.inWater || (!sit.foes && (await nearWalkers(12)) < 1)) return false
  log('под землёй, лечиться нечем, враги рядом — штрек прочь в породу')
  for (const dir of ['north', 'east', 'south', 'west']) {
    const t = await act('tunnel', { direction: dir, length: 10, torchEvery: 0, timeoutSeconds: 60 })
    if (died) return true
    if (((t.detail && t.detail.walked) || 0) >= 5) return true
  }
  return false
}

async function act (method, params: any = {}, again = 0) {
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
      stage !== '-' && !fighting && !resting && !died && !NIGHT_STAGES.has(stage) && !(stage === 'cast' && castNear() && method !== 'explore') && nightHold()) {
    throw Object.assign(new Error(`ночь, брони нет — наверху ${method} не начинаю, работа под землёй`), { strategyInterrupted: true })
  }
  // Вход своей лестницы с поверхности: наверх потом — ею, без копки нового колодца (cl-q 14.10: подъём столбом с y 16 съел
  // последнюю кирку, 8 мин рукой сквозь камень).
  if (method === 'dig_down' && params.mode === 'stairs' && sit.surface && state.pos && dim() === 'overworld') stairEntrance = { x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z), dim: dim() }
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
  if (!REFUGE_PASS.has(method) && refugeRunning() && !died) {
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
      routeSleeping = true
      try { await routeSleep('перед переходом') } finally { routeSleeping = false }
    }
  }
  const routeSafety = REFUGE_PASS.has(method) || /^(observe|eat|flee|refuge|shelter|sleep|escape_fire|surface|wait)$/.test(method) ||
    (method === 'fight' && !/^(food|resource)$/.test(params.purpose || '')) ||
    // Злой голем (ударен, не убит) — уже защита, не добыча: бюджет шага его не обрывает (S8c, s8c-a-v1-1: голем жив после 2 ударов
    // по бюджету построек 73 с, тело ушло копать — убито им через 2 с).
    // S8d (замечание «д»): злой голем вне бюджета — 3 смерти в s8c-g-s (бой шёл, пока не убьёт тело); теперь маршрут уходит от
    // злого голема (goto retreat вне бюджета), а бой с ним — в бюджете шага. ND_ROUTE_GOLEM_FREE=1 — прежнее.
    (method === 'golem' && params.angry === true && process.env.ND_ROUTE_GOLEM_FREE === '1') ||
    (method === 'goto' && params.retreat === true)
  if (stage === 'route' && routeDeadline && process.env.ND_ROUTE_DEADLINE !== '0' && !routeSafety) {
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
  const tel = telemetry.on() ? { t0: gameClock.now(), wallT0: gameClock.wall.now(), before: telemetry.snapshot(state, sit) } : null
  try {
    r = await call(method, params)
  } catch (e) {
    log(`${method} RPC-ОШИБКА ${e.message}`)
    if (tel) telemetry.record({ level: 'act', skill: method, stage, step: routeStepNow, again, params: telParams(params), sec: Math.round((gameClock.now() - tel.t0) / 100) / 10, wallSec: (gameClock.wall.now() - tel.wallT0) / 1000, ok: false, status: 'rpc_error', why: String(e.message).slice(0, 240), before: tel.before })
    return { status: 'failed', error: e.message, detail: {} }
  }
  acceptResult(r)
  const eatFailure = method === 'eat' && r.detail?.ate === null
    ? Object.fromEntries(['error', 'during', 'held', 'offHand', 'windowOpen', 'busy', 'tried', 'food', 'note']
      .filter(key => Object.prototype.hasOwnProperty.call(r.detail, key)).map(key => [key, r.detail[key]])) : null
  if (method === 'fortress' && dim() === 'the_nether' && Number.isFinite(r.detail?.explored)) netherExplored = Math.max(netherExplored, r.detail.explored)
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
  if (state.dimension === 'the_nether' || /Мир сменился \(верхний мир → Ад\)/.test(String((r.detail && r.detail.stopped) || ''))) routeEntered = true
  if (stage !== '-' && state.playPolicy?.mode === 'free') {
    manualControl = true
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
  const cut = !REFUGE_PASS.has(method) && method !== 'refuge' && ((r.by && r.by.type === 'emergency') || state.busy === 'refuge')
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
    if (!died && !resting && !fighting && hpLow()) await rest()
    if (died && stage !== '-') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
    if (!strategyExecuting && !died && r.status !== 'done' && !hpLow() && !NO_REPEAT.has(method) && again < 2 && (state.dimension || 'overworld') === dimBefore) {
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
    const closer = q => OW_DEEP && !!known.lava && !!state.pos && Math.hypot(q.x - state.pos.x, (q.y ?? y()) - state.pos.y, q.z - state.pos.z) + 8 <
      Math.hypot(known.lava.x - state.pos.x, (known.lava.y ?? y()) - state.pos.y, known.lava.z - state.pos.z)
    if (seenLava && seenLava.nearest && (!known.lava || closer(seenLava.nearest)) && !lavaBad(seenLava.nearest)) {
      known.lava = seenLava.nearest
      log(`видел лаву на ${known.lava.x},${known.lava.y},${known.lava.z} — запомнил`)
      try { await call('remember', { kind: 'лава', text: `лава на ${known.lava.x},${known.lava.y},${known.lava.z}`, place: 'лава' }) } catch {}
    }
    if (OW_DEEP && !known.portal && !have('water_bucket')) {
      const wet = /вода (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String(r.detail.stopped || ''))
      const seenW = (Array.isArray(r.detail.blocks) ? r.detail.blocks : []).find(b => b && b.name === 'water' && b.nearest)
      const q = wet ? { x: +wet[1], y: +wet[2], z: +wet[3] } : seenW ? seenW.nearest : null
      if (q && state.pos && y() < 60 && (!knownWater || Math.hypot(q.x - state.pos.x, q.y - state.pos.y, q.z - state.pos.z) < Math.hypot(knownWater.x - state.pos.x, knownWater.y - state.pos.y, knownWater.z - state.pos.z))) knownWater = q
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
    fighting = true
    try { await answerThreat(hurtCause(r), hurtSource(r)) } finally { fighting = false }
  }
  if (!resting && !fighting && method !== 'wait' && (state.health ?? 20) < 10 && !died &&
    (gameClock.now() > restIdleUntil || have(FOOD) || have(RAW))) await rest()
  if (!died && !resting && !fighting && !hunting && stage !== '-' && stage !== 'food' && weakAndHungry()) {
    throw new Error(`хп ${Math.round(state.health ?? 0)} и еды нет — бросаю «${stage}», сначала еда`)
  }
  return r
}
let hunting = false
let restIdleUntil = 0
const SELF_GUARDED = new Set(['fight', 'flee', 'refuge', 'blaze', 'pearls', 'dragon', 'sleep', 'bastion'])
let died = false
let lostBag = null
let lostAt = null
let resting = false
let fighting = false

async function sense () {
  try {
    const r: any = await call('situation')
    acceptResult(r)
    if (r.detail) sit = r.detail
  } catch (e) { log(`situation RPC-ОШИБКА ${e.message}`) }
  return sit
}

const ENV_DAMAGE = new Set(['starve', 'fall', 'in_wall', 'on_fire', 'in_fire', 'lava', 'hot_floor', 'campfire', 'drown', 'dry_out',
  'freeze', 'cactus', 'sweet_berry_bush', 'cramming', 'fly_into_wall', 'stalagmite', 'falling_block', 'falling_anvil',
  'falling_stalactite', 'out_of_world', 'outside_border', 'generic', 'generic_kill', 'lightning_bolt', 'ender_pearl', 'magic',
  'wither', 'dragon_breath', 'bad_respawn_point'])
function hurtCause (r) {
  const evs = [...(r.by && r.by.type === 'damage' ? [r.by] : []), ...(r.events || []).filter(e => e.type === 'damage')]
  const causes = evs.map(e => e.cause || 'unknown')
  return causes.find(c => !ENV_DAMAGE.has(c)) || causes[0] || 'unknown'
}
function hurtSource (r) {
  const evs = [...(r.by && r.by.type === 'damage' ? [r.by] : []), ...(r.events || []).filter(e => e.type === 'damage')]
  return (evs.reverse().find(e => e.source) || {}).source || null
}

async function awayFromWater (dist = 20) {
  const o = await act('observe', { radius: 16 })
  const wet = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'water')
  if (died) return
  try { await awayFrom(wet && wet.nearest ? wet.nearest : null, dist) } catch (e) { log(`от воды не ушёл: ${e.message}`) }
}

async function nearWalkers (r = 10) {
  try {
    const p: any = await call('peek')
    return ((p && p.detail && p.detail.foes) || []).filter(f => f && f.d <= r && Math.abs(f.dy || 0) <= 4 &&
      !/^(skeleton|stray|bogged|parched|pillager|witch|blaze|ghast|creeper|enderman|zombified_piglin|piglin)$/.test(f.name)).length
  } catch { return 0 }
}
// Место нападения из воды (утопленник с трезубцем): разведка туда не ходит 5 игр. мин. cl-o 14.10: тактика отбегала на 1–7 бл.,
// этап литья звал ту же разведку вдоль берега — пять попаданий, смерть днём на 26-й мин (утопленники: 6 смертей из 30 прогонов).
let dangerZone = null
function markDanger (why) {
  if (state.pos) dangerZone = { x: state.pos.x, z: state.pos.z, until: gameClock.now() + 300000, why }
}
function awayFromDanger () {
  if (!dangerZone || gameClock.now() >= dangerZone.until || !state.pos) return null
  const dx = state.pos.x - dangerZone.x, dz = state.pos.z - dangerZone.z
  if (Math.hypot(dx, dz) > 64) return null
  if (Math.abs(dx) < 1 && Math.abs(dz) < 1) return null
  return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
}
async function answerThreat (cause = 'unknown', source = null) {
  await sense()
  if (sit.buried) { await waitDugOut(); return }
  if (sit.inLava || sit.onFire) {
    await act('escape_fire')
    await sense()
    if (sit.inLava) await act('escape_fire')
    return
  }
  if (ENV_DAMAGE.has(cause)) {
    if (cause === 'starve') {
      if (have(FOOD) || have(RAW)) await act('eat')
      else log('урон от голода, еды нет — нора не лечит, нужна еда')
      return
    }
    if (cause === 'drown' && sit.inWater) { await act('surface', { targetY: y() + 2, timeoutSeconds: 20, preferPillar: false }); return }
    // Магма под ногами жжёт каждые полсекунды; под водой над ней столб пузырей тянет вниз (cl-w 14.10: «floor was lava», хп 17 → 0,
    // а этап звал штрек, руду и гравий): сойти с неё — из воды на берег, на суше — отбежать.
    if (cause === 'hot_floor') {
      if (sit.inWater) await leaveWater()
      else await act('flee', { timeoutSeconds: 6 })
      return
    }
    log(`урон «${cause}» — не нападение, нору не копаю`)
    return
  }
  const first = (sit.fight && sit.fight.first) || sit.first || {}
  const drowned = source === 'drowned' || first.name === 'drowned'
  if (drowned) markDanger('утопленник')
  if (drowned && sit.inWater) {
    log('бьёт утопленник, я в воде — в воде не дерусь, на сушу')
    if (!(await leaveWater()) && !died) await refugeRun('утопленник, я в воде')
    return
  }
  if (drowned && !sit.foes && await waterNear(6)) {
    log('бьёт невидимый утопленник у воды — ухожу на сушу подальше от воды')
    await awayFromWater(24)
    return
  }
  if (process.env.ND_REFUGE_SHORE !== '0' && drowned && !sit.inWater) {
    log('утопленник рядом, я на суше — не дерусь, ухожу от воды')
    if ((state.health ?? 20) < 12) await refugeRun('утопленник, хп мало')
    else await awayFromWater(24)
    return
  }
  if (!sit.foes) {
    if (sit.inWater || dim() === 'the_end') return
    if ((state.health ?? 20) < 16) await refugeRun(`бьёт невидимый (${cause}${source ? ' ' + source : ''})`)
    else log(`бьёт невидимый (${cause}${source ? ' ' + source : ''}), хп ${Math.round(state.health ?? 0)} — дальше дело`)
    return
  }
  if (first.swelling) { await act('flee', { timeoutSeconds: 15 }); return }
  if (process.env.ND_CROWD_REFUGE !== '0') {
    const seen = ((sit.fight && sit.fight.order) || []).filter(f => f && f.dist <= 10 && !f.ranged).length
    const walkers = sit.surface ? seen : Math.max(seen, await nearWalkers(10))
    if (walkers >= 3) {
      if (!sit.surface && await boxAndDown(`толпа: ${walkers} ходячих ближе 10 бл. — коробка и вниз из неё`)) return
      await refugeRun(`толпа: ${walkers} ходячих ближе 10 бл.`, { minHp: 20 }); return
    }
  }
  // Иссушитель/брут в Аду — не открытый бой: удар 9 (брут) / 4.8 + иссушение, наш меч 6 — проигрыш с 11 хп (s1c-F-2 06.10:
  // «fight» с иссушителем на 11 хп — смерть). В толщу: в замкнутой норе его рамка удара (раздута только вширь) не достаёт.
  // S1e (проверка S1d (в)): не «брут — всегда в толщу», а цена: ожидаемый урон боя (assess.plan: его удар после нашей брони × время
  // убийства; брут 13 = 7 + золотой топор, javap S4d; иссушитель + иссушение ~4) против запаса хп 6. Полный брут в железе — ~19 урона
  // (s1d-G22-5: LastStand с 20 хп — смерть) → в толщу; добитый брут или иссушитель на полном хп — бой.
  const expectDmg = (Number.isFinite(sit.fight?.expectedDamage) ? sit.fight.expectedDamage : first.name === 'piglin_brute' ? 19 : 8) + (first.name === 'wither_skeleton' ? 4 : 0)
  if (dim() === 'the_nether' && /^(wither_skeleton|piglin_brute)$/.test(String(first.name || '')) && expectDmg >= (state.health ?? 20) - 6 && !died) {
    log(`${first.name} в Аду, хп ${Math.round(state.health ?? 0)}, ожидаю ~${Math.round(expectDmg)} урона в бою — в толщу, не открытый бой`)
    await act('ne_burrow', { why: `${first.name}: в толщу` })
    return
  }
  const shield = have('shield') > 0 || /shield/.test(JSON.stringify(state.offHand || ''))
  if (first.ranged && shield && sit.armed && (state.health ?? 20) >= 5) {
    const f = await fightOrLeave({ timeoutSeconds: 45, retreatAtHealth: 4, shield: 'always' })
    return f
  }
  if (sit.armed && (state.health ?? 20) >= 10 && sit.verdict !== 'уходить') {
    const f = await fightOrLeave({ timeoutSeconds: 45, retreatAtHealth: 7 })
    if (f && f.detail && (f.detail.kills || f.detail.killed)) log(`отбился: ${JSON.stringify(f.detail.kills || f.detail.killed)}`)
    if (process.env.ND_CROWD_REFUGE !== '0' && !died) {
      const chain = process.env.ND_CROWD_CHAIN !== '0' ? 3 : 1
      for (let k = 0; k < chain && !died; k++) {
        await sense()
        const left = ((sit.fight && sit.fight.order) || []).filter(o => o && o.dist <= (chain > 1 ? 12 : 10))
        const hidden = sit.surface ? 0 : await nearWalkers(10)
        const hp = state.health ?? 20
        if (!left.length) {
          if (hidden >= 2 || (hidden >= 1 && hp < 16)) await refugeRun(`после боя рядом ещё ${hidden} (из-за угла)`, { minHp: 20 })
          break
        }
        const walk = Math.max(left.filter(o => !o.ranged).length, hidden)
        if (walk >= 2 || (walk >= 1 && left.length >= 2 && hp < 16)) { await refugeRun(`после боя рядом ещё ${left.length}`, { minHp: 20 }); break }
        if (chain === 1) break
        if (sit.armed && hp >= 12 && !left.some(o => o.name === 'drowned' || o.swelling)) {
          log(`после боя рядом ещё ${left[0].name} — и его`)
          const f2 = await fightOrLeave({ timeoutSeconds: 30, retreatAtHealth: 7 })
          if (!(f2 && f2.detail && (f2.detail.kills || f2.detail.killed))) break
        } else { await refugeRun(`после боя рядом ${left[0].name}, хп ${Math.round(hp)}`, { minHp: 20 }); break }
      }
    }
    return
  }
  if ((state.health ?? 20) < 16) { await refugeRun(`враги ${sit.foes}, хп ${Math.round(state.health ?? 0)}`); return }
  if (process.env.ND_CROWD_REFUGE !== '0' && sit.verdict === 'уходить') { await refugeRun(`враги ${sit.foes} не по силам`, { minHp: 20 }); return }
  const f = await act('flee', { timeoutSeconds: 40 })
  if (f.detail && f.detail.cornered && sit.armed) await act('fight', { timeoutSeconds: 40, retreatAtHealth: 4 })
}

const FIGHT_REFUSED = /размена|сытость не позволяет|запаса еды|нечем восстановить|не переживу|опасность под ногами|бросил бой/
async function fightOrLeave (params) {
  if ((state.food ?? 20) < 18 && have(FOOD)) {
    if ((state.health ?? 20) < 8) { await refugeRun(`сытость ${state.food ?? '?'} — бой не примут, хп ${Math.round(state.health ?? 0)}`); return null }
    await eatTo(18)
  }
  if (died) return null
  const f = await act('fight', params)
  const d = (f && f.detail) || {}
  const refused = f && f.status === 'done' && !(d.swings > 0) && !(d.kills && d.kills.length) && FIGHT_REFUSED.test(String(d.stopped || ''))
  if (!refused || died) return f
  log(`бой не принят (${String(d.stopped).slice(0, 60)}) — ухожу, а не стою`)
  if ((state.health ?? 20) < 16) await refugeRun('бой не принят')
  else await act('flee', { timeoutSeconds: 20 })
  return f
}

async function leaveWater () {
  await sense()
  if (!sit.inWater) return true
  const was = fighting
  fighting = true
  try {
    if (process.env.ND_REFUGE_SHORE !== '0') await act('refuge', { shore: true, minHp: 16, maxSeconds: 25, why: 'из воды на берег' })
    else await act('surface', { targetY: y() + 2, timeoutSeconds: 20, preferPillar: false })
    await sense()
    for (let k = 0; k < 2 && sit.inWater && !died && state.pos; k++) {
      await walkAway(12, k ? 1.2 : 0)
      await sense()
    }
  } finally { fighting = was }
  return !sit.inWater
}

async function waterNear (r = 6) {
  const o = await act('observe', { radius: Math.max(r, 8) })
  return (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).some(b => b && b.name === 'water' && (b.dist ?? 99) <= r)
}

async function waitDugOut () {
  log('завалило — не копаю, жду, пока автопилот откопает')
  const was = fighting
  fighting = true
  try {
    for (let i = 0; i < 8 && !died; i++) {
      await act('wait', { seconds: 2 })
      await sense()
      if (!sit.buried) return
    }
  } finally { fighting = was }
}

async function rest (minHp = 16) {
  resting = true
  try {
    await sense()
    if (sit.buried) await waitDugOut()
    if (sit.inWater) {
      const was = fighting
      fighting = true
      try { await act('surface', { targetY: y() + 2, timeoutSeconds: 30, preferPillar: false }) } finally { fighting = was }
      await sense()
      for (let k = 0; k < 2 && sit.inWater && !died && state.pos; k++) {
        fighting = true
        try { await walkAway(12, k ? 1.2 : 0) } finally { fighting = was }
        await sense()
      }
      if (died) return
      if (sit.inWater) {
        if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
        await shelterFailed('WATER', 'не вышел из воды — лечение ожиданием небезопасно')
        return
      }
    }
    log(`мало хп (${Math.round(state.health)}) — прячусь и отлёживаюсь`)
    // Навык blaze оставил тело в своей яме под ифритами — укрытие уже есть: refuge выводил из ямы под шары (S1d s1d-N-3: хп 8 → 3 → 0
    // за секунду, «CORNERED»). Лечиться в яме: еда и ожидание.
    const inBlazePit = dim() === 'the_nether' && gameClock.now() - blazeDugInAt < 180000 && !!blazeDugInPos && !!state.pos &&
      Math.hypot(blazeDugInPos.x - state.pos.x, blazeDugInPos.z - state.pos.z) < 1.5 && Math.abs(blazeDugInPos.y - state.pos.y) < 1.5
    if (inBlazePit) {
      log('в яме навыка blaze — лечусь в ней, не выхожу')
      if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
      await act('wait', { seconds: 20 })
      return
    }
    if (sit.foes > 0) await refugeRun(`мало хп (${Math.round(state.health ?? 0)}), врагов ${sit.foes}`)
    if (died || (state.health ?? 0) >= minHp) return
    await sense()
    if (!have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 &&
        (!sit.night || (dim() === 'overworld' && state.playPolicy?.mode === 'speedrun'))) {
      if (!sit.night && process.env.ND_REFUGE_SIT !== '0' && sit.foes > 0 && (state.health ?? 20) < 10 && !died) {
        log(`еды нет, рассвет, хп ${Math.round(state.health ?? 0)}, врагов рядом ${sit.foes} — сижу, пока не сгорят или уйдут`)
        await refugeRun(`рассвет, хп мало, врагов ${sit.foes}`, { minHp: 20, maxSeconds: 120 })
        if (died) return
        await sense()
      }
      log(`еды нет, ${sit.night ? 'ночь спидрана' : 'день'} — лечит только охота, иду`)
      restIdleUntil = gameClock.now() + 60000
      return
    }
    if (have(RAW) && !sit.foes && !(routeHealing && process.env.ND_ROUTE_ENTERHEAL !== '0')) await cook()
    if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
    if ((state.health ?? 0) >= minHp) return
    if (dim() === 'overworld' && state.playPolicy?.mode !== 'speedrun' && sit.night && sit.foes === 0 && !sit.buried) {
      await readMemory()
      const sb = known.spawnBed
      const closeBed = sb && state.pos && Math.hypot(sb.x - state.pos.x, sb.y - state.pos.y, sb.z - state.pos.z) <= 8
      if (closeBed || sit.bed || have(/_bed$/)) {
        log('восстановление ночью — сначала пробую ближайшую кровать')
        const r = await act('sleep', process.env.ND_ROUTE === '1' && have(/_bed$/) > 0 && !closeBed
          ? { untilMorning: true, take: true, timeoutSeconds: 120 }
          : { untilMorning: true, take: false, bunker: false, invite: false, waitSeconds: 10, timeoutSeconds: 60 })
        await sense()
        if ((state.health ?? 0) >= minHp) return
        if (r.detail?.morning && !sit.night && !have(FOOD) && !have(RAW) && (state.food ?? 20) < 18) {
          restIdleUntil = gameClock.now() + 60000
          await act('shelter', { mode: 'exit' })
          log('ночь пропущена — иду за едой, ожидание не восстановит хп')
          return
        }
      }
    }
    // Домой с малым хп — только если портал рядом: путь по Аду в 100+ бл. с 4–8 хп кончался смертью (s1c-A-7 06.10: хп 8 у спавнера,
    // «домой через портал» 170 бл., иссушитель на первых шагах). Далеко — в толщу на месте и лечиться (цена пути против риска).
    const portalFar = !known.netherPortal || !state.pos || Math.hypot(known.netherPortal.x - state.pos.x, known.netherPortal.z - state.pos.z) > 64
    if ((process.env.ND_NE_STAY === '1' || portalFar) && dim() === 'the_nether' && (have(FOOD) || (state.food ?? 0) >= 18)) {
      const bw = await act('ne_burrow', { why: 'лечиться в Аду' })
      await refresh()
      const bd = bw.detail || {}
      if (!died && dim() === 'the_nether' && (bd.ok || /уже в своём штреке/.test(bd.why || ''))) {
        log(`в Аду мало хп — лечусь в толще${portalFar ? ' (портал далеко)' : ' (ND_NE_STAY)'}`)
        for (let i = 0; i < 12 && (state.health ?? 20) < minHp && !died; i++) {
          if ((state.food ?? 20) < 20 && (have(FOOD) || have(RAW))) await act('eat')
          const w = await act('wait', { seconds: 10 })
          if (w.by && w.by.type === 'damage') break
        }
        return
      }
    }
    if (dim() === 'the_nether' && known.netherPortal) {
      log('в Аду мало хп — домой через портал, лечиться там')
      if (await returnFromNether()) {
        if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
        for (let i = 0; i < 12 && (state.health ?? 20) < minHp && !died; i++) {
          const w = await act('wait', { seconds: 10 })
          if (w.by && w.by.type === 'damage') break
          if ((state.food ?? 20) < 18 && (have(FOOD) || have(RAW))) await act('eat')
        }
        return
      }
    }
    if (!have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 && sit.night && dim() === 'overworld') {
      await holeTillMorning()
      return
    }
    await refugeRun(`отлёжка: хп ${Math.round(state.health ?? 0)}`, { minHp, maxSeconds: 120 })
  } finally { resting = false }
}

let nightSatUntil = 0
async function holeTillMorning () {
  if (gameClock.now() < shelterFailUntil) return
  if (NIGHT_DOWN && gameClock.now() < nightSatUntil) { log('ночь: аварийно уже отсидел — работаю внизу'); restIdleUntil = Math.max(restIdleUntil, nightSatUntil); return }
  if (!have(/_pickaxe$/)) await ensurePick()
  if (!(await restShelter())) return
  log(NIGHT_DOWN ? 'еды нет, ночь — авария: сижу в норе до 4 мин, потом работаю внизу' : 'еды нет, ночь — сижу в норе до утра')
  for (let k = 0; k < (NIGHT_DOWN ? 8 : 40) && !died; k++) {
    const w2 = await act('wait', { seconds: 30 })
    if (w2.by && w2.by.type === 'damage' && !died && !(await restShelter())) return
    await sense()
    if (!sit.night) break
  }
  if (NIGHT_DOWN && sit.night && !died) { nightIdleS += 240; restIdleUntil = gameClock.now() + 600000; nightSatUntil = gameClock.now() + 600000; log('ночь: 4 мин в норе — дальше работаю внизу, наверх не лезу'); return }
  log('еды нет — лечиться нечем, иду за едой')
  if (!died) await act('shelter', { mode: 'exit' })
}

const closedShelter = r => r.status === 'done' && r.detail?.sealed === true
async function restShelter () {
  let r = await act('shelter', { mode: 'enter', depth: 3 })
  if (!closedShelter(r) && !died) {
    const why = String((r.detail && r.detail.stopped) || r.error || '')
    await sense()
    if (sit.inWater || /вод/.test(why)) {
      for (let k = 0; k < 2 && !died && state.pos; k++) { await walkAway(12, k ? 1.2 : 0); await sense(); if (!sit.inWater) break }
    } else {
      try { await act('surface', { targetY: y() + 2, timeoutSeconds: 30, preferPillar: false }) } catch {}
    }
    if (!died) r = await act('shelter', { mode: 'enter', depth: 3 })
  }
  if (!closedShelter(r)) {
    await refresh()
    if (died) return false
    if ((state.health ?? 0) >= 8) { log(`нора не закрылась, хп ${Math.round(state.health)} — дальше без отлёжки`); restIdleUntil = gameClock.now() + 90000; return false }
    await shelterFailed('NO_SEAL', 'укрытие не закрыто — лечение ожиданием небезопасно')
    return false
  }
  return true
}

let shelterFailUntil = 0
let shelterRisks = 0
async function shelterFailed (klass, reason) {
  shelterRisks++
  shelterFailUntil = gameClock.now() + 180000
  restIdleUntil = Math.max(restIdleUntil, gameClock.now() + 90000)
  log(`РИСК укрытие:${klass} — ${reason}; не отключаюсь: ухожу от угроз и продолжаю (${shelterRisks}-й за запуск)`)
  await sense()
  if ((sit.foes > 0 || (state.health ?? 20) < 16) && !died) await refugeRun(`укрытие:${klass} — ${reason}`)
}
let detached = false
async function abortUnsafe (reason) {
  reason = `БЛОКЕР: ${reason}`
  log(reason)
  try { await call('stop') } catch (e) { log(`stop RPC-ОШИБКА ${e.message}`) }
  try { await call('disconnect', { reason }); detached = true } catch (e) { log(`disconnect RPC-ОШИБКА ${e.message}`) }
  const error: any = new Error(reason)
  error.stopCampaign = true
  throw error
}

async function refresh () {
  const r = await call('status')
  acceptResult(r)
  return state
}
const have = (re) => {
  const inv = state.inventory || {}
  let n: any = 0
  for (const [k, v] of Object.entries(inv)) if (typeof re === 'string' ? k === re : re.test(k)) n += v
  return n
}
const y = () => (state.pos ? state.pos.y : 64)
const dim = () => state.dimension || 'overworld'

const LOGS = /_(log|stem)$/
const COBBLE = /^(cobblestone|cobbled_deepslate|blackstone)$/
const RAW = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
const FOOD = /^(cooked_[a-z_]+|bread|baked_potato|golden_carrot|apple|carrot|sweet_berries|melon_slice|pumpkin_pie|golden_apple|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|cookie)$/
const { foodUnits: unitsOfFood } = require(path.join(__dirname, 'src', 'play-policy'))
const foodUnits = () => unitsOfFood(state.inventory)
const PICK_STONE = /^(stone|iron|diamond|netherite)_pickaxe$/
const PICK_IRON = /^(iron|diamond|netherite)_pickaxe$/
const PICK_DIAMOND = /^(diamond|netherite)_pickaxe$/

async function eatTo (target = 18, interrupted = () => false) {
  // Each iteration must confirm a rising bar or a spent item; delayed slot ACKs are not extra bites.
  while (!died && !interrupted() && (state.food ?? 20) < target && (have(FOOD) || have(RAW))) {
    const before = state.food ?? 20
    const receipt = await act('eat')
    if ((state.food ?? 20) <= before && !(receipt?.detail?.spent > 0)) break
  }
  return (state.food ?? 20) >= target
}

function planksFor () {
  const inv = state.inventory || {}
  const log = Object.keys(inv).find(k => LOGS.test(k) && !/^stripped_/.test(k)) || Object.keys(inv).find(k => LOGS.test(k))
  if (!log) return null
  return log.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks')
}

const known: any = { portal: null, netherPortal: null, fortress: null, bastion: null, stronghold: null, endPortal: null, dragonWon: false, spawnBed: null }
async function readMemory () {
  try {
    const r: any = await call('recall', { lines: 1 })
    const memory = (r.detail && r.detail.state) || {}
    memorySnapshot = { updatedAt: memory.updatedAt || null, places: memory.places || {}, deaths: (memory.deaths || []).length }
    const places = { ...(memory.places || {}) }
    if (process.env.ND_EXTRA_PLACES) { try { Object.assign(places, JSON.parse(process.env.ND_EXTRA_PLACES)) } catch {} }
    known.portal = places['портал'] || null
    known.netherPortal = places['портал (ад)'] || null
    known.fortress = places['крепость (ад)'] || known.fortress
    known.bastion = places['бастион (ад)'] || known.bastion
    known.bastions = BASTION_KEYS.filter(k => places[k]).map(k => ({ key: k, ...places[k] }))
    for (const b of known.bastions) {
      const checkpoint = places[`выработан: ${b.key}`]
      if (checkpoint?.dimension === 'the_nether' && !/два сухих захода/.test(checkpoint.note || '') && (b.dimension || 'the_nether') === 'the_nether' &&
        Math.hypot(checkpoint.x - b.x, checkpoint.z - b.z) <= 100) bState(b).spent = true
    }
    known.stronghold = places['крепость'] || known.stronghold
    known.endPortal = places['портал в Край'] || known.endPortal
    known.spawnBed = places['точка возрождения'] || null
    if (!known.lava && places['лава'] && (places['лава'].dimension || 'overworld') === 'overworld') known.lava = places['лава']
  } catch {}
}

let guarding = false
const canWorkAtNight = () => sit.foes === 0 && !sit.inWater && !sit.buried &&
  (state.health ?? 0) >= 16 && (state.food ?? 0) >= 14 &&
  (!sit.surface || (NIGHT_DOWN2() ? stage === 'wood' || !sit.night : have(/_(sword|axe)$/) > 0 || stage === 'wood' || stage === 'stone'))
let nightWorkSaidAt = 0
async function nightGuard (opts = {}) {
  if (guarding) return
  guarding = true
  try { await nightGuardBody(opts) } finally { guarding = false }
}
async function nightGuardBody ({ afterDeath = false, dusk = false } = {}) {
  await sense()
  if (dim() !== 'overworld') return
  if (state.playPolicy?.mode === 'speedrun') return
  if (sit.night || sit.dusk) await makeBed()
  await readMemory()
  const sb = known.spawnBed
  const sbFar = sb && state.pos ? Math.hypot(sb.x - state.pos.x, sb.z - state.pos.z) : Infinity
  const homeBed = sbFar <= (sit.night ? 24 : 96)
  const bed = have(/_bed$/) > 0 || sit.bed || homeBed
  if (!sit.night) nightHoles = 0
  const duskDown = dusk && NIGHT_DOWN2() && sit.dusk && sit.surface && !sit.night
  if (!(sit.night || duskDown || (sit.dusk && bed))) return
  if (!bed && !afterDeath && !duskDown && canWorkAtNight()) {
    if (gameClock.now() - nightWorkSaidAt > 60000) {
      log('ночь без видимых угроз: продолжаю работу; кровать — ближайшая цель охоты')
      nightWorkSaidAt = gameClock.now()
    }
    return
  }
  if (!sit.surface && !bed) {
    if (!sit.night) return
    if (NIGHT_DOWN) { await nightBelow('под крышей'); return }
    log('ночь, я под крышей — жду утра здесь')
    for (let i = 0; i < 40 && !died; i++) {
      await act('wait', { seconds: 30 })
      await sense()
      if (!sit.night) break
    }
    if (!died) await act('shelter', { mode: 'exit' })
    return
  }
  if (bed) {
    if (homeBed && sbFar > 6) {
      log(`к своей кровати-точке ${sb.x},${sb.y},${sb.z} (${Math.round(sbFar)} блоков)`)
      await goToward(sb, 3)
    }
    log(sit.night ? 'ночь — сплю' : 'сумерки — ставлю кровать, лягу с темнотой')
    await refresh()
    const nearHome = sb && state.pos ? Math.hypot(sb.x - state.pos.x, sb.z - state.pos.z) <= 8 : false
    const carry = !nearHome && have(/_bed$/) > 0
    const r = await act('sleep', { untilMorning: true, timeoutSeconds: 420, take: carry })
    if (r.detail && r.detail.morning) return
    if (/монстр/.test(String((r.detail && (r.detail.note || r.detail.stopped)) || r.error || '')) && have(/_bed$/) > 0) {
      await act('flee', { timeoutSeconds: 12 })
      const r2 = await act('sleep', { untilMorning: true, timeoutSeconds: 420, take: true })
      if (r2.detail && r2.detail.morning) return
    }
    if (/негде поставить кровать/.test(String((r.detail && (r.detail.stopped || r.detail.note)) || r.error || '')) && have(/_bed$/) > 0) {
      await walkAway(12)
      const r3 = await act('sleep', { untilMorning: true, timeoutSeconds: 420, take: true })
      if (r3.detail && r3.detail.morning) return
    }
    await sense()
    if (!sit.night) return
  }
  if (process.env.ND_NIGHT_BOX === '1' && !NIGHT_DOWN && !died && dim() === 'overworld') {
    log('ночь наверху без кровати — укрытие до рассвета')
    const r = await refugeRun('ночь наверху: до рассвета', { minHp: 20, untilDawn: true, force: true })
    await sense()
    if (died || !sit.night || (r && r.detail && r.detail.code === 'OK' && r.detail.how !== 'flee')) return
  }
  if (gameClock.now() < shelterFailUntil) return
  await sense()
  if (sit.foes > 0 && !died) {
    log(`ночь, врагов рядом ${sit.foes} — нору под ними не копаю, сперва ответ`)
    if (!NIGHT_DOWN) await afterRefuge()
    await sense()
    if (NIGHT_DOWN && sit.foes > 0 && !died) {
      const r = await act('refuge', { minHp: 16, maxSeconds: 60, stayIn: true, why: `ночь: врагов ${sit.foes} у норы — коробка и вниз из неё` })
      if (died) return
      if (r.detail && r.detail.stayed) {
        if (!have(/_pickaxe$/)) await ensurePick()
        const h = await act('shelter', { mode: 'enter', depth: 3 })
        if (died) return
        if (closedShelter(h)) { nightHoles++; await nightBelow('нора из коробки'); return }
        log('из коробки вниз не вышло — дальше по-старому')
      }
      await sense()
      if (!(r.detail && r.detail.stayed) && sit.foes > 0 && !died) { await afterRefuge(); await sense() }
    } else if (sit.foes > 0 && !died) await refugeRun(`ночь: врагов ${sit.foes} у норы`)
    if (died) return
  }
  log('ночь на поверхности — в нору до рассвета')
  if (!have(/_pickaxe$/)) await ensurePick()
  let s = await act('shelter', { mode: 'enter', depth: 3 })
  if (!closedShelter(s)) {
    for (let k = 0; k < 3; k++) {
      await walkAway(k ? 16 : 12, k ? 1.2 : 0)
      await sense()
      if (!sit.night) return
      if (!sit.inWater) break
    }
    if (!sit.inWater && !afterDeath && canWorkAtNight()) { log('на суше, угроз нет — работаю ночью'); return }
    s = await act('shelter', { mode: 'enter', depth: 3 })
  }
  if (!closedShelter(s)) { await shelterFailed('NIGHT', 'обе норы не закрыты — ночное ожидание небезопасно'); return }
  if (NIGHT_DOWN && !died) {
    nightHoles++
    if (nightHoles <= 2) { await nightBelow('нора закрыта'); return }
    log(`РИСК ночь: ${nightHoles}-я нора за ночь — наверху работать нельзя, жду утра в норе`)
  }
  for (let i = 0; i < 40; i++) {
    await act('wait', { seconds: 30 })
    if (died) return
    await sense()
    if (!sit.night) break
  }
  await act('shelter', { mode: 'exit' })
}

const NIGHT_DOWN = process.env.ND_NIGHT_DOWN !== '0'
function NIGHT_DOWN2 () { const v = process.env.ND_NIGHT_DOWN; return v === undefined || v === '' || v === '2' }
let nightHoles = 0
let nightIdleS = 0
async function nightBelow (why) {
  log(`ночь (${why}) — утра не жду, работаю внизу; хп ${Math.round(state.health ?? 0)}, еда ${state.food ?? '?'}`)
  const t0 = gameClock.now()
  for (let i = 0; i < 8 && !died; i++) {
    await sense()
    if (!sit.night || canWorkAtNight()) break
    if (sit.foes > 0) break
    const hp = state.health ?? 20
    const food = have(FOOD) || have(RAW)
    if (food && (state.food ?? 20) < 20 && hp < 16) { await act('eat'); continue }
    const heals = hp < 16 && ((state.food ?? 0) >= 18 || food)
    const emergency = hp < 10 && !food
    const capS = emergency ? 240 : 180
    if (!(heals || emergency) || gameClock.now() - t0 > capS * 1000) break
    if (i === 0) log(emergency ? `хп ${Math.round(hp)} и лечиться нечем — авария: сижу в норе (до ${capS / 60} мин)` : `хп ${Math.round(hp)} — отлёживаюсь (реген), до ${capS / 60} мин`)
    await act('wait', { seconds: 30 })
  }
  const s = Math.round((gameClock.now() - t0) / 1000)
  nightIdleS += s
  if (s >= 20) log(`ночь: ожидание ${s} с (за запуск ${nightIdleS} с) — дальше работа`)
}

let heading = Math.random() * 2 * Math.PI
const LEASH = 660
const HUNT_LEASH = 660
const portalFar = () => (known.portal && state.pos && dim() === 'overworld') ? Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) : 0
async function homeLeash () {
  if (stage === 'stronghold' || stage === 'dragon' || (have('ender_eye') >= Math.min(10, EYES_NEED) && known.stronghold)) return
  if (portalFar() > (hunting ? HUNT_LEASH : LEASH) + 30) { log(`далеко от портала (${Math.round(portalFar())}) — назад к базе`); await goToward(known.portal, 24) }
}
async function walkAway (dist, turn = 0, targetY?: number) {
  heading += turn
  let x = Math.round(state.pos.x + Math.cos(heading) * dist)
  let z = Math.round(state.pos.z + Math.sin(heading) * dist)
  const leash = hunting ? HUNT_LEASH : LEASH
  if (known.portal && dim() === 'overworld' && Math.hypot(x - known.portal.x, z - known.portal.z) > leash) {
    heading = Math.atan2(known.portal.z - state.pos.z, known.portal.x - state.pos.x) + (Math.random() - 0.5) * 1.6
    x = Math.round(state.pos.x + Math.cos(heading) * dist)
    z = Math.round(state.pos.z + Math.sin(heading) * dist)
  }
  const r = await act('goto', { x, y: targetY, z, range: 4, timeoutSeconds: Math.max(30, Math.round(dist * 1.5)), surface: 'strict' })
  // Поверху пути нет ни в одну сторону (берег, остров: s8c-b-v1-2 — 8 мин «No path» с одной клетки за брёвнами) — тот же отход
  // обычным goto (вплавь, через холм), не стоять на месте. ND_WALK_LOOSE=0 — прежнее.
  if (r.status !== 'done' && /No path|нечем строить/i.test(String(r.error || '')) && process.env.ND_WALK_LOOSE !== '0' && !died) {
    // Из ямы не вылезти — «нечем строить» (s8c-c-v1-2: яма без кирки и блоков, 8 мин на месте): земля/песок рукой — блоки на ступень.
    if (/нечем строить/.test(String(r.error || '')) && fillerCount() < 4) await act('mine', { block: 'dirt,grass_block,coarse_dirt,podzol,rooted_dirt,sand,red_sand,gravel,mud,clay', count: 6, radius: 8, timeoutSeconds: 40 })
    return act('goto', { x, y: targetY, z, range: 4, timeoutSeconds: Math.max(30, Math.round(dist * 1.5)), surface: targetY === undefined ? undefined : 'strict' })
  }
  return r
}

async function awayFrom (p, dist = 24) {
  await sense()
  if (!sit.surface && dim() === 'overworld' && !(await toSurface(2))) {
    throw new Error('не вышел наверх — отход поверху не запускаю')
  }
  await refresh()
  if (!p) return walkAway(dist, Math.PI / 2)
  let dx = state.pos.x - p.x
  let dz = state.pos.z - p.z
  const n = Math.hypot(dx, dz)
  if (n < 0.5) { dx = Math.cos(heading); dz = Math.sin(heading) } else { dx /= n; dz /= n }
  return act('goto', { x: Math.round(state.pos.x + dx * dist), z: Math.round(state.pos.z + dz * dist), range: 4, timeoutSeconds: 60, surface: 'strict' })
}

function netherVia (from, to) {
  const chain = [known.netherPortal, ...(known.bastions || [])].filter(Boolean)
  if (chain.length < 2 || !from || !to) return []
  const P = []; const at = new Array(chain.length).fill(-1)
  let k0 = 0
  for (let k = 1; k < chain.length; k++) {
    const leg = chain[k].via
    if (!Array.isArray(leg) || !leg.length) { if (P.length) break; k0 = k; continue }
    if (!P.length) at[k - 1] = 0
    P.push(...leg); at[k] = P.length - 1
  }
  if (P.length < 2) return []
  const d3 = (a, p) => Math.hypot(a[0] - p.x, a[2] - p.z) + Math.abs(a[1] - (Number.isFinite(p.y) ? p.y : a[1])) * 0.5
  let i = -1; let bd = Infinity
  P.forEach((a, n) => { const d = d3(a, from); if (d < bd) { bd = d; i = n } })
  if (bd > 160) i = -1
  let j = -1; let bj = Infinity
  chain.forEach((c, k) => { if (at[k] < 0) return; const d = Math.hypot(c.x - to.x, c.z - to.z); if (d < bj) { bj = d; j = at[k] } })
  if (i < 0 || j < 0 || bj > 160 || i === j || k0 < 0) return []
  return i < j ? P.slice(i, j + 1) : P.slice(j, i + 1).reverse()
}
const fillersNow = () => have(/^(netherrack|dirt|basalt|blackstone|stone|andesite|diorite|granite|tuff|cobbled_deepslate|cobblestone|deepslate|polished_blackstone_bricks|cracked_polished_blackstone_bricks|polished_blackstone|end_stone|mossy_cobblestone|soul_soil|warped_wart_block|nether_wart_block|soul_sand)$/)
const nearBastion = (p, r = 100) => !!p && (known.bastions || []).some(b => Math.hypot(b.x - p.x, b.z - p.z) < r)

let bastionWalkRefusals = 0
async function goToward (p, range = 6, frKeep = 1) {
  const fromWorld = dim()
  const fromRevision = tacticalRevision
  const interrupted = r => tacticalRevision !== fromRevision || r.status === 'interrupted' || r.code === 'TACTICAL' ||
    /^(tactical|damage|low_health|emergency)$/.test(r.by?.type || '')
  if (fromWorld === 'the_nether' && process.env.ND_NE_ROUTE === '1' && state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) > range + 2 && !died) {
    const far = Math.hypot(p.x - state.pos.x, p.z - state.pos.z)
    const yKnown = typeof p.y === 'number'
    // p.ry/p.rdy — высота цели только для хода по сетке (точка выхода у крепости, S5d), штрек без сетки её не берёт.
    const r = await act('ne_route', { x: p.x, y: typeof p.ry === 'number' ? p.ry : yKnown ? p.y : 64, z: p.z, r: Math.max(range, 3), dy: typeof p.rdy === 'number' ? p.rdy : yKnown ? 4 : 50, frKeep, ironOk: !nextBastion() || (process.env.ND_NE_STAY === '1' && pearlsNow() >= eyesWant()), ...(nearBastion(state.pos, 120) ? { zoneExpo: 14 } : {}), timeoutSeconds: Math.min(1200, Math.round(120 + far * 2.5)) })
    await refresh()
    if (died || dim() !== fromWorld) return false
    if (interrupted(r)) { log('переход прерван — возвращаю управление для нового наблюдения'); return false }
    if (state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) <= range + 2) return true
    log(`по сетке не довёл: ${(r.detail && r.detail.why) || r.error || '?'} — дальше штреком`)
  }
  if (fromWorld === 'the_nether' && state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) > 60 && !died) {
    const far = Math.hypot(p.x - state.pos.x, p.z - state.pos.z)
    const via = netherVia(state.pos, p)
    const tArgs = () => ({ x: p.x, y: p.y, z: p.z, radius: Math.max(range, 5), ...(via.length ? { via } : {}), ironOk: !nextBastion() || (process.env.ND_NE_STAY === '1' && pearlsNow() >= eyesWant()), timeoutSeconds: Math.min(via.length ? 2700 : 1800, Math.round(120 + far * (via.length ? 3 : 1.6))) })
    let t = await act('nether_tunnel', tArgs())
    await refresh()
    if (died || dim() !== fromWorld) return false
    if (interrupted(t)) { log('штрек прерван — возвращаю управление для нового наблюдения'); return false }
    if (state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) <= range + 2) return true
    const td0 = t.detail || {}
    if (!td0.ok && !td0.segs && !td0.dug && process.env.ND_BURROW !== '0') {
      const bw = await act('ne_burrow', { why: 'штрек по Аду не начался' })
      await refresh()
      if (died || dim() !== fromWorld) return false
      if (interrupted(bw)) return false
      if (bw.detail && bw.detail.ok) {
        t = await act('nether_tunnel', tArgs())
        await refresh()
        if (died || dim() !== fromWorld) return false
        if (interrupted(t)) return false
        if (state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) <= range + 2) return true
      }
    }
    // S1f: от бастиона — пешком можно (путь уводит от ближнего бастиона), и третий отказ подряд — тоже: стоять у бастиона
    // с «пути нет» дороже риска хода (s1f-FA-5/FB-4: 7 отказов подряд за 5 игр. мин, тело стояло у бастиона, найденного глазами).
    // ND_NE_BASTION_AWAY=0 — прежнее (у бастиона никогда).
    // Прочь — путь тело → цель не подходит к ближнему бастиону ближе, чем тело сейчас (угол с направлением «от бастиона» ≤ 90°).
    const nearB = nearBastion(state.pos)
    const bNear = nearB && state.pos ? (known.bastions || []).reduce((m, b) => !m || Math.hypot(b.x - state.pos.x, b.z - state.pos.z) < Math.hypot(m.x - state.pos.x, m.z - state.pos.z) ? b : m, null) : null
    const awayDir = !!bNear && (p.x - state.pos.x) * (state.pos.x - bNear.x) + (p.z - state.pos.z) * (state.pos.z - bNear.z) >= 0
    const awayOk = process.env.ND_NE_BASTION_AWAY !== '0' && nearB && !!state.pos && (awayDir || ++bastionWalkRefusals >= 3)
    if (awayOk) { bastionWalkRefusals = 0; log(`штрек по Аду не довёл у бастиона — пешком (${awayDir ? 'прочь от бастиона' : 'третий отказ подряд'})`) }
    else if (nearB) { log(`штрек по Аду не довёл: ${(t.detail && t.detail.why) || t.error || '?'} — у бастиона пешком не иду`); return false }
    // Бастион глазами (S5e 07.10, честно: видимые блоки бастиона из памяти глаз, бруты — видимые/слышимые): пешком мимо него не идти
    // (s5e-M-3: штрек «пути нет» в 70 бл. от точки выхода → goto сквозь бастион → «slain by Piglin Brute» за 16 игр. с).
    // ND_NE_BASTION_EYES=0 — прежнее.
    if (!awayOk && process.env.ND_NE_BASTION_EYES !== '0') {
      const sb = await act('perceive', { mode: 'seen', re: '^(gilded_blackstone|polished_blackstone_bricks|cracked_polished_blackstone_bricks|chiseled_polished_blackstone)$', max: 1, maxDist: 40 })
      const en = await act('perceive', { mode: 'entities', radius: 32 })
      const brute = ((en.detail && en.detail.entities) || []).some(e => e && /piglin_brute/.test(e.name || e.kind || ''))
      const seenB = ((sb.detail && sb.detail.seen) || []).length > 0
      if (brute || seenB) { log(`штрек по Аду не довёл: ${(td0.why) || t.error || '?'} — рядом бастион (${brute ? 'брут' : 'блоки бастиона'}), пешком не иду`); return false }
    }
    log(`штрек по Аду не довёл: ${(t.detail && t.detail.why) || t.error || '?'} — дальше пешком`)
  }
  const detour = [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5]
  let turn = 0
  // S1f (вслепую, без сетки): в Аду отрезки по 32, а не 64 — длинная цель в изрезанном рельефе Ада «Took to long to decide path»
  // (s1f-E1-1: к бастиону в 59 бл. 6 goto по 120 с — «не дошёл», 15 мин у бастиона). ND_NE_LEG=64 — прежнее.
  const LEG = fromWorld === 'the_nether' ? Math.max(16, Number(process.env.ND_NE_LEG) || 32) : 64
  let surfaceTried = false
  for (let k = 0; k < Math.round(12 * 64 / LEG) && !died; k++) {
    await refresh()
    if (died || dim() !== fromWorld || tacticalRevision !== fromRevision) return false
    if (!have(/_pickaxe$/)) await ensurePick()
    const dx = p.x - state.pos.x
    const dz = p.z - state.pos.z
    const far = Math.hypot(dx, dz)
    if (far <= range + 2) return true
    if (dim() === 'overworld' && far > 24) {
      await sense()
      if (!sit.surface && !surfaceTried && typeof p.y !== 'number') {
        surfaceTried = true
        // Spend at most the remaining open-ground running time on getting out. A failed
        // climb still leaves the cave route available instead of becoming a resource gate.
        const seconds = Math.min(120, Math.max(10, Math.ceil(far / require(path.join(__dirname, 'src', 'hopgoto')).RUN)))
        log(`наземная дорога ${Math.round(far)} бл. из-под крыши — выход до ${seconds}с, затем путь`)
        const up = await act('surface', { timeoutSeconds: seconds, preferPillar: true })
        if (died || interrupted(up)) return false
        k--; continue // re-observe the new position, including a partial climb or a dimension change
      }
      if (sit.night && sit.surface) await nightGuard()
      if (died) return false
    }
    let leg
    if (far > LEG + 8 || turn) {
      const a = Math.atan2(dz, dx) + detour[turn % detour.length]
      const step = Math.min(LEG, far)
      leg = { x: Math.round(state.pos.x + Math.cos(a) * step), z: Math.round(state.pos.z + Math.sin(a) * step) }
    } else leg = { x: p.x, z: p.z }
    const direct = far <= LEG + 8 && !turn
    // В Аду — без быстрого спуска со скалы (S1d s1d-G21-2: descent «ledges → no_ledge, down 25» — в лавовое море, смерть).
    const r = await act('goto', { x: leg.x, ...(direct && typeof p.y === 'number' ? { y: p.y } : {}), z: leg.z, range: direct ? range :Math.min(range, 8), timeoutSeconds: 120, ...(dim() === 'the_nether' ? { descent: false } : dim() === 'overworld' && typeof p.y !== 'number' ? { surface: true } : {}) })
    if (interrupted(r)) { log('ход прерван — возвращаю управление для нового наблюдения'); return false }
    turn = r.status === 'done' ? 0 : turn + 1
    if (turn >= detour.length) return false
  }
  return false
}

async function returnFromNether () {
  if (dim() !== 'the_nether') return dim() === 'overworld'
  await unclutter()
  // «портал (ад)» не записан (вход прерван тактикой) — портал прибытия рядом с x/8, z/8 портала верхнего мира: туда,
  // а там portal enter сам найдёт горящий в 16 бл. (s1-post08 06.10: 10 очей, «ПЕРЕХОДА НЕТ» в 150 бл. от портала).
  const home = known.netherPortal || (known.portal && Number.isFinite(known.portal.x) ? { x: Math.round(known.portal.x / 8), z: Math.round(known.portal.z / 8) } : null)
  if (!known.netherPortal && home) log(`«портал (ад)» в памяти нет — иду к ${home.x},${home.z} (портал верхнего мира / 8)`)
  // S1e: далеко до своего портала, а обсидиан и огниво при себе — новый портал на месте дешевле пешего хода по Аду (цена, nether-pause.exitChoice).
  if (home && state.pos && process.env.ND_EXIT_LOCAL !== '0') {
    const ch = require(path.join(__dirname, 'src', 'campaign', 'nether-pause')).exitChoice({ homeDistance: Math.hypot(home.x - state.pos.x, home.z - state.pos.z), obsidian: have('obsidian'), lighter: !!lighter() })
    log(`выход: ${ch.why}`)
    if (ch.build) {
      const b = await act('portal', { timeoutSeconds: 150 })
      await refresh()
      if (dim() === 'the_nether' && !died && b.detail && b.detail.lit) await act('portal', { mode: 'enter', anyPortal: true, timeoutSeconds: 60 })
      await refresh()
      if (dim() !== 'the_nether') return dim() === 'overworld'
      log('новый портал на месте не вывел — к своему')
    }
  }
  const reached = home ? await goToward(home, 4) : true
  if (dim() !== 'the_nether') return dim() === 'overworld'
  if (!reached) { log('безопасный путь к порталу не пройден — переход пешком не запускаю'); return false }
  await act('portal', { mode: 'enter', timeoutSeconds: 120 })
  return dim() === 'overworld'
}

async function recoverGuard () {
  await refresh()
  if (died) {
    died = false
    for (let k = 0; k < 20 && (state.health ?? 0) <= 0; k++) { await sleep(500); await refresh() }
    if ((state.health ?? 0) <= 0) await abortUnsafe('возрождение не подтвердилось — действия мёртвым телом не начинаю')
    await refresh()
    if (Object.keys(state.inventory || {}).length >= 3) {
      log('умер, но вещи при мне (keep_inventory) — к делу')
      await sense()
      if (dim() === 'overworld' && sit.night && sit.surface) {
        log('ночь, я наверху после возрождения — в укрытие до рассвета')
        if (sit.foes > 0) await afterRefuge()
        await nightGuard({ afterDeath: true })
      }
      return
    }
    const worth = Object.keys(lostBag || {}).filter(k => /iron|gold|diamond|obsidian|bucket|_bed$|ender|blaze|shield|bow|arrow|flint_and_steel|netherite|emerald|cooked_/.test(k))
    const far = lostAt && state.pos ? Math.hypot(lostAt.x - state.pos.x, lostAt.z - state.pos.z) : 0
    if (!worth.length || far > 600) {
      log(`умер; за вещами не иду — ${worth.length ? `далеко (${Math.round(far)} блоков)` : 'ценного не было'}, собираю заново`)
      return
    }
    log(`умер — пробую забрать вещи (${worth.join(', ')}; ${Math.round(far)} блоков)`)
    const r = await act('recover', { timeoutSeconds: far > 300 ? 300 : 240 })
    if (r.detail && r.detail.stopped) log('за вещами не пройти — собираю заново')
  }
  if (dim() === 'overworld' && known.portal && portalFar() < 48 && !have(/_pickaxe$/)) await sense()
  if (dim() === 'overworld' && known.portal && portalFar() < 48 && !have(/_pickaxe$/) && !sit.night) {
    if (portalFar() > 10) await act('goto', { x: known.portal.x, y: known.portal.y, z: known.portal.z, range: 3, timeoutSeconds: 40 })
    const t = await act('chest_take', { item: 'all' })
    if (t.status === 'done') { log('взял запас из сундука базы'); baseStocked = false }
  }
  if ((state.health ?? 20) < 12 && !resting) await rest()
  await homeLeash()
}

let baseStocked = false
async function baseDeposit () {
  if (!known.portal || dim() !== 'overworld') return
  if (portalFar() > 8) await goToward(known.portal, 4)
  await refresh()
  const list = await act('chest_list', {})
  if (list.status !== 'done') {
    if (!have('chest')) {
      if (have(/_planks$/) < 8) { const p = planksFor(); if (p) await craft(p, 8) }
      await craft('chest')
    }
    if (have('chest')) await act('place', { block: 'chest' })
  }
  const keep = { iron_ingot: 2, cobblestone: 96 }
  const put = []
  for (const [k, v] of (Object.entries(state.inventory || {}) as any)) {
    if (keep[k] !== undefined && v > keep[k]) put.push([k, v - keep[k]])
    else if (/^(raw_iron|raw_copper|raw_gold|diamond|lapis_lazuli|coal)$/.test(k)) put.push([k, v])
  }
  const food = Object.entries(state.inventory || {}).filter(([k]) => FOOD.test(k)).sort((a: any, b: any) => a[1] - b[1])
  let extra = have(FOOD) - 16
  for (const [k, v] of food) { if (extra <= 0) break; const n = Math.min(Number(v), extra); put.push([k, n]); extra -= n }
  if (have('stone_pickaxe') > 2) put.push(['stone_pickaxe', have('stone_pickaxe') - 2])
  for (const [item, count] of put) await act('chest_put', { item, count })
  if (put.length) { baseStocked = true; log(`база: в сундук — ${put.map(([k, n]) => k + '×' + n).join(', ')}`) }
}

const TABLE_ITEMS = /_(pickaxe|sword|axe|shovel|hoe|chestplate|leggings|helmet|boots)$|^(shield|bucket|furnace|flint_and_steel|bow|chest|_bed)$|_bed$/
async function ensureTable () {
  if (have('crafting_table')) return true
  if (died || strategyInterrupted) return false
  if ((state.health ?? 20) >= 12) {
    const recovered = await act('mine', { block: 'crafting_table', count: 1, radius: 3, fair: true, dry: true, timeoutSeconds: 15 })
    await refresh()
    if (recovered.status === 'interrupted' || died || strategyInterrupted) return false
    if (have('crafting_table')) return true
  }
  if (have(/_planks$/) < 4) { const p = planksFor(); if (p) await act('craft', { item: p, count: 4 }) }
  for (let k = 0; k < 3 && !have('crafting_table'); k++) {
    const r = await act('craft', { item: 'crafting_table', count: 1 })
    if (r.status === 'interrupted' || died || strategyInterrupted) return false
    if (r.status === 'done') break
    await sleep(1200)
    await refresh()
  }
  return have('crafting_table') > 0
}

async function craft (item, count = 1) {
  await unclutter()
  if (TABLE_ITEMS.test(item) && item !== 'crafting_table') { await refresh(); if (!(await ensureTable())) return false }
  let r = await act('craft', { item, count })
  if (r.status !== 'done' && /не прибавилось|не открылся|автопилот сейчас|нужен верстак|missing ingredient/.test(String(r.error || ''))) {
    await sleep(1500)
    r = await act('craft', { item, count })
  }
  if (r.status !== 'done' && /не смог поставить|некуда поставить/.test(String(r.error || ''))) {
    await act('surface', { timeoutSeconds: 60, preferPillar: true })
    await refresh()
    r = await act('craft', { item, count })
  }
  if (r.detail && r.detail.tableBack === false) {
    await refresh()
    const note = String(r.detail.note || '')
    const m = /crafting_table@(-?\d+),(-?\d+),(-?\d+)/.exec(note)
    if (!have('crafting_table') && m) await act('goto', { x: +m[1], y: +m[2], z: +m[3], range: 0, timeoutSeconds: 20, surface: false })
    await refresh()
    if (!have('crafting_table')) await act('mine', { block: 'crafting_table', count: 1, radius: 8, timeoutSeconds: 30 })
    await refresh()
    if (!have('crafting_table')) log(`верстак не вернул (${note.slice(0, 120)}) — новый сделаю из запаса`)
  }
  return r.status === 'done' && !(r.detail && r.detail.need)
}

async function sticks (n) {
  if (have('stick') >= n) return
  if (have(/_planks$/) < 2) { const p = planksFor(); if (p) await craft(p, 4) }
  await craft('stick', Math.max(4, n - have('stick')))
}

async function sticksReserve () {
  await refresh()
  if (have('stick') < 12) {
    if (have(/_planks$/) < 6 && !have(LOGS)) { await sense(); if (dim() === 'overworld' && sit.surface && !sit.night) await lumber(4) }
    await sticks(12)
  }
  if (have(COBBLE) < 24 && known.portal && portalFar() < 48) await act('chest_take', { item: 'cobblestone', count: 32 })
}

async function spares (wantSwings = 200) {
  await refresh()
  await sense()
  if ((sit.pickLeft ?? 0) >= wantSwings) return
  if (have('stick') < 4 && (have(/_planks$/) >= 2 || have(LOGS))) await sticks(4)
  for (let i = 0; i < 3; i++) {
    await sense()
    if ((sit.pickLeft ?? 0) >= wantSwings) break
    if (have('stick') < 2) { if (have(/_planks$/) >= 2 || have(LOGS)) await sticks(4); else break }
    if (!have(PICK_IRON) && (have('iron_ingot') + have('raw_iron') > 0 || have('iron_nugget') >= 9) && have('stick') + 4 * Math.floor(have(/_planks$/) / 2) < 4 && !have(LOGS)) break
    if (have(COBBLE) >= 3) {
      if (!(await craft('stone_pickaxe'))) break
    } else if (have('iron_ingot') >= 3 && have('stick') >= 2) {
      if (!(await craft('iron_pickaxe'))) break
    } else {
      if (have(/_planks$/) < 3) { const p = planksFor(); if (p) await craft(p, 4) }
      if (have(/_planks$/) < 3 || !(await craft('wooden_pickaxe'))) break
    }
  }
}

// S1f: запас блоков в Аду (незерак под ногами — везде): без него не встаёт ни коробка отхода, ни столб обзора (s1f-B0b-1: мост и
// штрек разведки съели 127 булыжника за 3 мин, через 4 мин «на коробку блоков нет (0)» под шаром гаста — падение в лаву). Перед
// разведкой и ходом к спавнеру/бастиону — добрать до want, если меньше min. ND_NE_FILLERS=0 — выкл.
let fillersRetryAt = 0
async function netherFillers (min = 24, want = 48) {
  if (process.env.ND_NE_FILLERS === '0' || dim() !== 'the_nether' || died) return
  if (fillersNow() >= min || (state.pos && nearBastion(state.pos, 90)) || gameClock.now() < fillersRetryAt) return
  const before = fillersNow()
  const r = await act('mine', { block: 'netherrack', count: want - before, radius: 16, timeoutSeconds: 60 })
  await refresh()
  // Не добыл (незерака на виду нет: мост над лавой, крепость) — не повторять до следующих 2 игр. мин (s1f-C1-1: 6 пустых попыток подряд).
  if (fillersNow() <= before) fillersRetryAt = gameClock.now() + 120000
  log(`запас блоков в Аду: ${before} → ${fillersNow()}${r.error ? ' — ' + String(r.error).slice(0, 80) : ''}`)
}

async function lumber (want = 10) {
  await refresh()
  if (have(LOGS) + Math.floor(have(/_planks$/) / 4) >= want) return
  for (let i = 0; i < 3 && have(LOGS) + Math.floor(have(/_planks$/) / 4) < want; i++) {
    await sense()
    // Под кроной небо закрыто листвой — «не на поверхности», а брёвна вот они (cl-h 14.10: спуск за железом с 2 брёвнами,
    // внизу «плавить нечем» и кирки кончились). Глубоко под землёй (y < 50) — не рубить.
    if ((!sit.surface && y() < 50) || (sit.night && !canWorkAtNight())) return
    const m = await act('mine', { block: 'any_log', count: want - have(LOGS), radius: 40, timeoutSeconds: 180 })
    if (!(m.detail && m.detail.dug)) {
      const e = await act('explore', { block: 'any_log', radius: 48, stepDistance: 60, timeoutSeconds: 90 })
      if (!(e.detail && e.detail.found)) return
    }
  }
}

async function unclutter () {
  await sense()
  if ((sit.free ?? 36) < 8) {
    const netherrack = dim() === 'the_nether' ? 128 : 64
    const extra = ['quartz:0', 'wildflowers:0', 'bone_meal:0']
    if (have(/^(iron|diamond|netherite)_sword$/) > 0) extra.push('stone_sword:0', 'wooden_sword:0', 'golden_sword:0')
    if (have(/^stone_pickaxe$/) >= 2 || have(/^(diamond|netherite)_pickaxe$/) > 0) extra.push('wooden_pickaxe:0')
    await act('pack', { mode: 'tidy', also: `cobblestone:128, cobbled_deepslate:128, netherrack:${netherrack}, raw_copper:0, copper_ingot:0, leaf_litter:0, magma_block:0, nether_brick_fence:0, nether_bricks:0, crafting_table:1, furnace:1, bowl:1, leather:0, lapis_lazuli:0, ${extra.join(', ')}` })
  }
}

// Навык отказал из-за моба рядом: штрек («дойдёт до меня»), литьё (CAST_UNSAFE), подъём («видит меня — спиной не полезу»).
const MOB_BLOCKED = /дойдёт до меня|блоках (впереди|позади|снизу|сверху)|бл. (снизу|сверху)|бл. на моём уровне, вплотную|CAST_UNSAFE|видит меня — спиной/
async function mobInTheWay (r) {
  const why = String((r && r.detail && r.detail.stopped) || '')
  if (died || !MOB_BLOCKED.test(why)) return false
  if (r.mobAnswered) return true
  r.mobAnswered = true
  log(`моб мешает работе — отвечаю: ${why.slice(0, 80)}`)
  fighting = true
  try {
    await answerThreat()
    if (process.env.ND_CROWD_REFUGE !== '0' && !died && !sit.foes) await act('wait', { seconds: 3 })
  } finally { fighting = false }
  return true
}

const woodNow = () => have(LOGS) + Math.floor(have(/_planks$/) / 4)
async function reserve () {
  await sense()
  if ((!sit.surface && y() < 50) || sit.night || dim() !== 'overworld') return
  if (woodNow() < (OW_DEEP ? 4 : 8)) await lumber(OW_DEEP ? 6 : 10)
  await refresh()
  if (!have('crafting_table')) await ensureTable()
}

async function ensurePick () {
  await refresh()
  if (have(/_pickaxe$/)) return true
  if (have(/_planks$/) < 9 && have(LOGS)) { const p = planksFor(); if (p) await craft(p, Math.min(16, have(LOGS) * 4)) }
  await refresh()
  if (!have('crafting_table') && have(/_planks$/) >= 4) await craft('crafting_table')
  if (have('crafting_table')) {
    await sticks(2)
    if (have(COBBLE) >= 3 && await craft('stone_pickaxe')) return true
    if (have(/_planks$/) >= 3 && await craft('wooden_pickaxe')) return true
  }
  await refresh()
  return have(/_pickaxe$/) > 0
}

const CAVE_FOES = /^(zombie|husk|drowned|skeleton|stray|creeper|spider|cave_spider|enderman|witch|zombie_villager|slime|silverfish|bogged)$/
function cavesFoes (o) {
  const ents = (o && o.detail && Array.isArray(o.detail.entities)) ? o.detail.entities : []
  const f = ents.filter(e => CAVE_FOES.test(String(e.name || '').toLowerCase()) && (e.dist ?? 99) <= 24)
  return f.length ? f.map(e => e.name).slice(0, 4).join(', ') : ''
}
let descendLava = null
async function descend (toY, { stopAtLava = false, short = false } = {}) {
  const dirs = ['north', 'east', 'south', 'west']
  descendLava = null
  // short — короткий спуск маршрута к лаве (≤ 24 бл.): запас дерева на кирки под землёй не нужен (s8-r2-9: reserve → lumber 6
  // брёвен за 109 с перед спуском на 13).
  if (!(short && y() - toY <= 24 && have(PICK_STONE))) await reserve()
  const lavaStop = async r => {
    if (!stopAtLava) return false
    const q = await stopLava(r)
    if (!q) return false
    descendLava = q
    log(`спуск: лава у ${q.x},${q.y},${q.z} — её и надо, спуск кончаю на y ${Math.round(y())}`)
    return true
  }
  let surfaceWet = 0
  const wetStops = []
  let caveSkips = 0
  for (let i = 0; i < 8 && y() > toY + 2; i++) {
    await recoverGuard()
    if (died) return
    await unclutter()
    await spares(Math.min(260, (y() - toY) * 2 + 60))
    if (!(await ensurePick())) { log('кирки нет и не из чего — вниз не иду'); return }
    let stairsDepth = 24
    if (OW_DEEP && OW_SHAFT) {
      const shTop = state.pos ? { x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z) } : null
      const shSurface = sit.surface
      const sh = await act('tunnel', { direction: 'down', length: Math.min(64, Math.round(y() - toY)), timeoutSeconds: 240 })
      if (died) return
      if (OW_DEEP && shTop && shSurface && sh.detail && (sh.detail.descended || 0) >= 10 && sh.detail.depth && sh.detail.depth.x === shTop.x && sh.detail.depth.z === shTop.z) {
        surfaceShaft = { x: shTop.x, z: shTop.z, top: shTop.y, bottom: sh.detail.depth.y }
      }
      if (await lavaStop(sh)) return
      if (OW_DEEP && /пустота|пещер/.test(String((sh.detail && sh.detail.stopped) || ''))) {
        const o = await act('observe', { radius: 48 })
        if (!cavesFoes(o)) {
          if (!known.portal && have(/bucket$/) < 2 && have(/^(raw_iron|iron_ingot)$/) < 7) await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: 7 - have(/^(raw_iron|iron_ingot)$/), radius: process.env.ND_IRON_WIDE !== '0' ? 24 : 14, timeoutSeconds: 90 })
          if (!known.portal && have(/^(coal|charcoal)$/) < 2) await act('mine', { block: 'coal_ore,deepslate_coal_ore', count: 3, radius: 16, timeoutSeconds: 45 })
        } else log(`спуск: в пещере ${cavesFoes(o)} — руду в ней не беру`)
        const lv = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
        const foesNear = cavesFoes(o)
        if (lv && foesNear && stopAtLava) log(`спуск: в пещере видна лава ${lv.nearest.x},${lv.nearest.y},${lv.nearest.z}, но там ${foesNear} — мимо, вниз`)
        if (stopAtLava && lv && !foesNear && lv.nearest.y < y() + 4 && Math.hypot(lv.nearest.x - state.pos.x, lv.nearest.z - state.pos.z) <= 32) {
          descendLava = { ...lv.nearest }
          log(`спуск: в пещере видна лава ${lv.nearest.x},${lv.nearest.y},${lv.nearest.z} — к ней, спуск кончаю`)
          return
        }
      }
      if (await mobInTheWay(sh)) continue
      if (y() <= toY + 2) break
      if (OW_DEEP && /пустота|пещер/.test(String((sh.detail && sh.detail.stopped) || ''))) {
        let moved = false
        if (caveSkips < 3) {
          caveSkips++
          await act('tunnel', { direction: 'up', length: 3, timeoutSeconds: 20 })
          for (let k = 0; k < 4 && !moved && !died; k++) {
            const dirAway = dirs[(i + caveSkips + k) % 4]
            const t = await act('tunnel', { direction: dirAway, length: 8, torchEvery: 0, timeoutSeconds: 60 })
            moved = ((t.detail && t.detail.walked) || 0) >= 3
          }
        }
        log(`спуск: колодец вышел в пещеру на y ${Math.round(y())} — ${moved ? 'штрек вбок, колодец оттуда' : 'вбок не вышло — спуск здесь кончаю (лесенкой в пещеру не иду)'}`)
        if (moved) { i--; continue }
        return
      }
      const shWet = /вода на (-?\d+),(-?\d+),(-?\d+)/.exec(String((sh.detail && sh.detail.stopped) || ''))
      if (shWet) wetStops.push({ x: +shWet[1], z: +shWet[3] })
      if (shWet && OW_DEEP && !known.portal && have(/^bucket$/) && !have('water_bucket')) {
        await act('portal', { mode: 'cast', waterHint: { x: +shWet[1], y: +shWet[2], z: +shWet[3] }, timeoutSeconds: 60 })
        if (have('water_bucket')) log(`спуск: вода у колодца ${shWet[1]},${shWet[2]},${shWet[3]} — ведро полное`)
      }
      if (shWet && y() >= 50 && surfaceWet < 3) {
        await sense()
        if (sit.surface || y() >= 58) {
          surfaceWet++
          const dry = sh.detail && sh.detail.dryAt
          if (dry) {
            log(`спуск: вода под дёрном — к сухому возвышению ${dry.x},${dry.y},${dry.z}`)
            const g = await act('goto', { x: dry.x, y: dry.y, z: dry.z, range: 2, timeoutSeconds: 60, surface: 'strict' })
            if (g && g.status === 'done') { i--; continue }
          }
          const away = await awayFrom({ x: +shWet[1], z: +shWet[3] }, 24 + 12 * surfaceWet).catch(() => null)
          if (away && away.status === 'done') { i--; continue }
        }
      }
      if (!(sh.detail && sh.detail.stopped) && (sh.detail && sh.detail.descended) > 0) { i--; continue }
      stairsDepth = 6
    }
    const d = await act('dig_down', { mode: 'stairs', depth: Math.min(stairsDepth, y() - toY), torchEvery: have('torch') ? 8 : 0, direction: dirs[i % 4], timeoutSeconds: 300 })
    if (await lavaStop(d)) return
    if (await mobInTheWay(d)) continue
    if (died) return
    if (d.detail && ((d.detail.dug ?? 0) >= 3 || (d.detail.steps ?? 0) >= 2) && !d.detail.stopped) continue
    const why = String((d.detail && d.detail.stopped) || d.error || '')
    const wet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    if ((OW_DEEP || (NIGHT_DOWN2() && sit.night)) && wet && !/под ногами вода|я в воде/.test(why) && state.pos && y() < 55) {
      wetStops.push({ x: +wet[1], z: +wet[3] })
      const opts = [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]].map(([d, vx, vz]: any) => {
        const nx = state.pos.x + vx * 12; const nz = state.pos.z + vz * 12
        return { d, score: Math.min(...wetStops.map(w => Math.hypot(w.x - nx, w.z - nz))) }
      }).sort((a, b) => b.score - a.score)
      await spares(80)
      await act('tunnel', { direction: opts[0].d, length: 12, torchEvery: 0, timeoutSeconds: 90 })
      continue
    }
    if (wet || /под ногами вода|я в воде/.test(why)) {
      // Ночью поверху каждый переход к сухому месту — под мобами (cl-p 14.10: 6 попыток у болота, смерть): после второго отказа
      // спуск ночью здесь кончаю — главный цикл держит ночь в коробке.
      if (wet) wetStops.push({ x: +wet[1], z: +wet[3] })
      if (nightHold() && wetStops.length >= 2) throw new Error('ночь, вода под дёрном — вниз здесь не выйдет, до рассвета в укрытии')
      const away = await awayFrom(wet ? { x: +wet[1], z: +wet[3] } : null, 24)
      if (away.status !== 'done') throw new Error('не смог отойти от воды — спуск здесь прекращаю')
      continue
    }
    if (/бьёт с дистанции|стреляет/.test(why)) {
      fighting = true
      try { await answerThreat() } finally { fighting = false }
      if (died) return
      await awayFrom(null, 20)
      continue
    }
    if (/пещер|пустот|лава/.test(why)) {
      await spares(80)
      await act('tunnel', { direction: dirs[i % 4], length: 8, torchEvery: 0, timeoutSeconds: 90 })
      continue
    }
    await spares(120)
    await act('dig_down', { mode: 'stairs', depth: Math.min(12, y() - toY), direction: dirs[i % 4], torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 240 })
    await torches()
  }
}

let stairEntrance = null
async function toSurface (tries = 4) {
  await sense()
  const e = stairEntrance
  if (!sit.surface && e && e.dim === dim() && state.pos && e.y > y() + 2 && Math.hypot(e.x - state.pos.x, e.z - state.pos.z) <= 64) {
    log(`наверх своей лестницей к ${e.x},${e.y},${e.z}`)
    await act('goto', { x: e.x, y: e.y, z: e.z, range: 1, timeoutSeconds: 90 })
    if (died) return false
    await sense()
    if (sit.surface) return true
  }
  let stalled = 0
  let shovelTried = false
  let blocksTried = false
  const wetTried = new Set()
  for (let i = 0; i < tries; i++) {
    await sense()
    if (sit.surface) return true
    await spares(120)
    const pick = await ensurePick()
    if (!pick) log('кирки нет и не из чего — лезу наверх рукой (камень 7.5 с за блок)')
    const from = state.pos && { ...state.pos }
    const r = await act('surface', { timeoutSeconds: pick ? 120 : 600, hand: !pick, preferPillar: pick })
    if (died) return false
    if (r.detail && r.detail.out) return true
    const why0 = String((r.detail && r.detail.stopped) || '')
    if (/лопат[аы]? в рюкзаке нет|нужна лопата|_shovel/.test(why0) && !have(/_shovel$/) && !shovelTried) {
      shovelTried = true
      await sticks(2)
      if (await craft(have(COBBLE) >= 1 ? 'stone_shovel' : 'wooden_shovel')) { log('сделал лопату — снег сверху копается'); continue }
    }
    const wet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(String((r.detail && r.detail.stopped) || ''))
    if (wet && state.pos) {
      const dx = state.pos.x - +wet[1]
      const dz = state.pos.z - +wet[3]
      let dir = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north')
      if (Math.hypot(dx, dz) < 1 || wetTried.has(dir)) dir = ['east', 'south', 'west', 'north'].find(d => !wetTried.has(d)) || dir
      wetTried.add(dir)
      const before = state.pos && { ...state.pos }
      const t = await act('tunnel', { direction: dir, length: 10, torchEvery: 0, timeoutSeconds: 90 })
      // Под озером штрек на этом уровне тоже упирается в воду над следующей клеткой (cl-b 14.10: десять кругов «подъём —
      // штрек» на месте, пауза этапа). Ниже на 3 и вбок на 16 — из-под воды, потом снова наверх.
      if (!died && before && state.pos && Math.hypot(state.pos.x - before.x, state.pos.z - before.z) < 2 && /вод/.test(String(t.detail?.stopped || t.error || ''))) {
        await act('dig_down', { mode: 'stairs', depth: 3, direction: dir, torchEvery: 0, timeoutSeconds: 60 })
        if (!died) await act('tunnel', { direction: dir, length: 16, torchEvery: 0, timeoutSeconds: 120 })
      }
      continue
    }
    // Столб и ступени не из чего (cl-c 14.10: 0 булыжника в пещере, «строить нечем» — 3 паузы этапов и простой): добыть
    // породы вокруг себя киркой, потом снова наверх.
    if (/строить нечем|нечем строить/.test(why0) && fillerCount() < 8 && pick && !blocksTried) {
      blocksTried = true
      await act('mine', { block: 'stone,deepslate,andesite,diorite,granite,tuff,dirt,grass_block,cobblestone,sandstone,netherrack', count: 12, radius: 8, timeoutSeconds: 45 })
      if (fillerCount() > 0) continue
    }
    // Над головой руда не по кирке (медь/железо деревянной; cl-f 14.10: «для copper_ore нужна кирка получше» — 18 мин на y 25):
    // шаг вбок штреком и снова наверх, по очереди во все стороны.
    // Над головой колонка песка/гравия (пустыня: 3–5 бл. песка над песчаником): подъём здесь её не прокопает — шаг вбок
    // штреком и снова наверх (cl-r 14.10: 100 мин под пустыней, голод до 0 и хп 1, все этапы «пустой заход»).
    if (/сыплется в забой/.test(why0) && i < tries - 1) {
      await act('tunnel', { direction: ['east', 'south', 'west', 'north'][i % 4], length: 6, torchEvery: 0, timeoutSeconds: 45 })
      continue
    }
    if (/нужна кирка получше/.test(why0) && i < tries - 1) {
      await act('tunnel', { direction: ['east', 'south', 'west', 'north'][i % 4], length: 4, torchEvery: 0, timeoutSeconds: 40 })
      continue
    }
    if (r.detail && /сыпуч|гравий|отойти/.test(String(r.detail.stopped || ''))) await walkAway(4, Math.PI / 2)
    else if (r.detail && /столб не встал|не смог шагнуть/.test(String(r.detail.stopped || '')) && state.pos) {
      const [dx, dz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][i % 4]
      await act('goto', { x: state.pos.x + dx * 10, y: state.pos.y, z: state.pos.z + dz * 10, range: 3, timeoutSeconds: 30, surface: false })
    }
    else if (r.detail && r.detail.stopped && from && state.pos &&
      Math.hypot(state.pos.x - from.x, state.pos.y - from.y, state.pos.z - from.z) < 1) {
      log(`подъём без прогресса — повтор не поможет: ${String(r.detail.stopped).slice(0, 180)}`)
      return false
    }
    if (from && state.pos && Math.hypot(state.pos.x - from.x, state.pos.y - from.y, state.pos.z - from.z) < 1) stalled++
    else stalled = 0
    if (stalled >= 2) { log('подъём и обход дважды без движения — прекращаю тратить сытость'); return false }
  }
  await sense()
  return !!sit.surface
}

const portalBuckets = () => process.env.ND_ROUTE_ONE === '0' ? 2 : 1
// A carried second bucket costs no extra iron; it can rescue a shore the one-bucket geometry cannot use.
async function castForKit (params) {
  const one = portalBuckets() === 1
  const r = await act('portal', { ...params, ...(one ? { one: true, hint: undefined } : {}) })
  if (one && r.status !== 'interrupted' && !died && have(/bucket$/) >= 2 && /места на берегу нет/.test(String(r.detail?.stopped || ''))) {
    log('литьё: берег для одного ведра не подходит, два ведра уже с собой — другая раскладка')
    return act('portal', { ...params, hint: undefined, windows: false })
  }
  return r
}
async function spendIron () {
  await refresh()
  if (have('iron_block')) await craft('iron_ingot', 9 * have('iron_block'))
  if (have('iron_nugget') >= 9) await craft('iron_ingot', Math.floor(have('iron_nugget') / 9))
  const noShield = () => !have('shield') && !(state.offHand && /shield/.test(JSON.stringify(state.offHand)))
  const plan = known.portal ? [
    ['flint_and_steel', 1, () => !lighter() && have('flint') > 0],
    ['iron_pickaxe', 3, () => !have(PICK_IRON)],
    ['bucket', 3, () => have(/bucket$/) < 1],
    ['shield', 1, noShield],
    ['iron_chestplate', 8, () => !worn('torso')],
    ['iron_sword', 2, () => !have(/^(iron|diamond|netherite)_sword$/)],
    ['iron_leggings', 7, () => !worn('legs')],
    ['iron_helmet', 5, () => !worn('head')],
    ['iron_boots', 4, () => !worn('feet')]
  ] : [
    ['bucket', 3, () => have(/bucket$/) < 1],
    ['flint_and_steel', 1, () => !lighter() && have('flint') > 0],
    ['bucket', 3, () => have(/bucket$/) < portalBuckets()],
    ['shield', 1, noShield],
    ['iron_pickaxe', 3, () => !have(PICK_IRON)],
    ['iron_chestplate', 8, () => !worn('torso')],
    ['iron_sword', 2, () => !have(/^(iron|diamond|netherite)_sword$/)],
    ['iron_leggings', 7, () => !worn('legs')],
    ['iron_boots', 4, () => !worn('feet')],
    ['iron_helmet', 5, () => !worn('head')]
  ]
  for (const [item, cost, want] of (plan as any)) {
    await refresh()
    const keep = (item !== 'flint_and_steel' && !lighter() ? 1 : 0) +
      (!known.portal && item !== 'bucket' ? 3 * Math.max(0, portalBuckets() - have(/bucket$/)) : 0)
    if (!want() || have('iron_ingot') < cost + keep) continue
    if (ARMOR_POINTS[item]) {
      const g = gearWorth(item, { inBag: true })
      const forFight = fightGearWanted && /chestplate|leggings|helmet/.test(item)
      log(g.line + (forFight && !g.take ? ' — но бой у спавнера без неё не выигрывался (ферма 29.09: 0 из 8) — беру' : ''))
      if (!g.take && !forFight) continue
    }
    if (item === 'shield' && have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
    if (/_(pickaxe|sword)$/.test(item)) await sticks(2)
    await craft(item)
  }
  await act('armor')
}

// Цена смерти — та же, что у графа (riskPenalty 72000 тиков = 60 мин, core/strategy.ts): при keep_inventory=false смерть —
// потеря рюкзака и прогона (правило пользователя 02.10). Прежние 6 мин считали её мелкой задержкой — броня «не окупалась»
// никогда, и тело шло в ночь и в Ад голым (cl-a…cl-d 14.10). ND_DEATH_COST_MIN — для сравнения.
const GEAR_CALC = { MIN_PER_INGOT: 1.1, TRIP_MIN: 4, CRAFT_MIN: 0.3, DEATHS_PER_H_AT8: 4, NETHER_H: 0.5, DEATH_COST_MIN: Number(process.env.ND_DEATH_COST_MIN) || 60, HIT: 6 }
const ARMOR_POINTS: any = { iron_chestplate: 6, iron_leggings: 5, iron_helmet: 2, iron_boots: 2,
  golden_chestplate: 5, golden_leggings: 3, golden_helmet: 2, golden_boots: 1,
  diamond_chestplate: 8, diamond_leggings: 6, diamond_helmet: 3, diamond_boots: 3,
  leather_chestplate: 3, leather_leggings: 2, leather_helmet: 1, leather_boots: 1,
  chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_helmet: 2, chainmail_boots: 1 }
const ARMOR_COST = { iron_chestplate: 8, iron_leggings: 7, iron_helmet: 5, iron_boots: 4, golden_helmet: 5 }
const ARMOR_SLOT = { chestplate: 'torso', leggings: 'legs', helmet: 'head', boots: 'feet' }
function armorPointsNow () {
  let n = 0
  for (const v of Object.values(state.armor || {})) if (v) n += ARMOR_POINTS[String(v).replace(/^minecraft:/, '')] || 0
  return n
}
const armorCut = pts => Math.min(20, Math.max(pts / 5, pts - 4 * GEAR_CALC.HIT / 8)) / 25
function gearWorth (item, { inBag = false } = {}) {
  const C = GEAR_CALC
  const pts0 = armorPointsNow()
  const slot = ARMOR_SLOT[item.split('_').pop()]
  const wornName = (state.armor || {})[slot]
  const pts1 = pts0 - (wornName ? (ARMOR_POINTS[String(wornName)] || 0) : 0) + (ARMOR_POINTS[item] || 0)
  const rate = pts => C.DEATHS_PER_H_AT8 * (1 - armorCut(pts)) / (1 - armorCut(8))
  const d0 = rate(pts0) * C.NETHER_H
  const d1 = rate(pts1) * C.NETHER_H
  const gain = Math.max(0, d0 - d1) * C.DEATH_COST_MIN
  const need = ARMOR_COST[item] || 0
  const gold = /^golden_/.test(item)
  const haveBars = gold ? have('gold_ingot') + have('raw_gold') : have('iron_ingot') + have('raw_iron')
  const missing = inBag ? 0 : Math.max(0, need - haveBars)
  const cost = missing ? C.TRIP_MIN + missing * C.MIN_PER_INGOT : C.CRAFT_MIN
  const take = pts1 > pts0 && gain > cost
  const f = x => (Math.round(x * 10) / 10).toString()
  return {
    take, cost, gain, missing,
    line: `броня по расчёту: ${item} — ${missing ? `поход за ${missing} слитк. ≈ ${f(cost)} мин` : `из рюкзака ≈ ${f(cost)} мин`} против пользы ${f(gain)} мин ` +
      `(смертей в Аду за ${f(C.NETHER_H * 60)} мин: ${f(d0)} → ${f(d1)} при броне ${pts0} → ${pts1}, смерть ${C.DEATH_COST_MIN} мин) — ${take ? 'беру' : 'не беру'}`
  }
}
function worn (slot) {
  const a = state.armor || {}
  if (a[slot]) return true
  const names = { torso: /_chestplate$/, legs: /_leggings$/, feet: /_boots$/, head: /_helmet$/ }
  return have(names[slot]) > 0
}

const STAGES = []
const OTHER_WORLD = new Set(['bastion', 'nether', 'pearls', 'eyes', 'stronghold', 'dragon'])
const fed = (items, level) => have(FOOD) + ((have('furnace') || have(COBBLE) >= 8) ? have(RAW) : 0) >= items || (state.food ?? 20) >= level
// Набор литья готов и лава видена рядом — портал важнее ночной копки (cl-h 14.10: в 24.5 бл. от лавы ушёл копать, погиб внизу).
// Только проверенный источник (обзор вдаль видел годное озеро): лава из обзора 64 бывает текущей, ночью к ней шёл и искал
// источник разведкой — смерть от скелета (cl-s 14.10, 52-я мин).
const castNear = () => !!known.lava && lavaSourceKnown && !!state.pos && Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) <= 96 &&
  have('water_bucket') > 0 && READY.cast()
// Ночь спидрана до портала без брони: поверху — смерть (cl-a…cl-k 14.10: 15 смертей из 22 прогонов, почти все ночью — охота,
// поиск воды, берег). Есть кирка и дерево на кирки — ночь идёт работой под землёй (главный цикл), наземные этапы — с рассветом.
// Дерево на кирки: спуск без запаса кончался «палок нет — наверх за деревом» на y 25 (cl-f 14.10, 18 мин простоя).
// Лава с набором рядом (castNear) ночь не снимает: литьё зовёт сам главный цикл, остальные наземные этапы — с рассветом (cl-p
// 14.10: с ведром у лавы граф выбрал охоту, ночью поверху — смерть от скелета).
// Броня: один железный нагрудник (6) ночь не держит — с ним охота ночью кончилась смертью от зомби (cl-r 14.10, 36-я мин);
// поверху ночью работаю в полном железе (15).
// С сумерек (11840), а не с ночи: нору копать до спавна мобов, а не под стрелами (cl-u 14.10: смерть на 10-й мин, через минуту
// после темноты, пока искалось сухое место; cl-z: паук на 9.8).
// И после литья портала: сборы (еда, кровать) ночью поверху — смерть от скелета на 173-й мин (cl-af 14.10). С порталом ночь
// уходит в Ад, если готов, иначе — та же нора/коробка/работа внизу.
const nightHold = () => dim() === 'overworld' && (!!sit.night || !!sit.dusk) && state.playPolicy?.mode === 'speedrun' &&
  armorPointsNow() < 15 && have(/_pickaxe$/) > 0 && process.env.ND_NIGHT_DIG !== '0'
// Копать ночью вниз — только с деревом на сменные кирки: каменной хватает на один спуск лестницей (131 удар), без палок она
// ломалась внизу, подъём рукой сквозь камень — 8 мин (cl-q 14.10). Без дерева ночь — в норе или коробке.
const nightDigWood = () => woodNow() >= 2 || have('stick') >= 4
// Этапы, которые ночь ведут сами (iron: вниз и штреки) или не ходят поверху (крафт, еда, лечение).
const NIGHT_STAGES = new Set(['iron', 'MineIron', 'stone', 'AcquireStoneTools', 'CraftPortalKit', 'EatFood', 'Heal', 'PrepareBread'])
// Ночью без еды наверх за охотой не иду, пока хп хватает на работу внизу (≥ 6): охота ночью — главная из смертей серии.
const weakAndHungry = () => (state.health ?? 20) < (process.env.ND_OW_DEEP === '1' && !known.portal && (state.dimension || 'overworld') === 'overworld' ? 6 : 12) &&
  !have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 && (!sit.night || state.playPolicy?.mode === 'speedrun') && !((state.health ?? 20) >= 6 && nightHold())
let ironRuns = 0
let ironLeg = 0 // сквозной номер штрека этапа iron (змейка между заходами)
const ironBlocked = new Set() // «x,z:сторона» — штрек отсюда туда не пошёл (глубокий путь)
const READY = {
  stone: () => have(/_pickaxe$/) > 0,
  iron: () => have(PICK_STONE) > 0 && (fed(3, 15) || (foodHuntEmpty >= 2 && (state.food ?? 20) >= 8)),
  cast: () => have(/bucket$/) >= portalBuckets() && (have('flint_and_steel') || have('fire_charge') || have('iron_ingot')) > 0,
  diamond: () => have(PICK_IRON) > 0 && fed(5, 19),
  obsidian: () => have(PICK_DIAMOND) > 0 && have(/bucket$/) > 0,
  portal: () => have('obsidian') >= 10,
  prep: () => have(PICK_STONE) > 0,
  nether: () => have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0 && foodUnits() >= netherFoodNeed(),
  pearls: () => (have(PICK_IRON) > 0 || have(/^(iron|diamond|netherite)_sword$/) > 0),
  bastion: () => (have(PICK_IRON) > 0 || (!ironChestTried && dim() === 'the_nether' && have('iron_ingot') + have('raw_iron') + have('iron_nugget') / 9 >= 1)) && (foodUnits() >= 6 || (state.food ?? 0) >= 18)
}
function netherFoodNeed () {
  const base = rodsNow() >= 5 ? 3 : 6
  if (process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_FOOD2 !== '0') return Math.min(base, 2)
  if (sit.night && !sit.surface && known.portal && portalFar() < 48) return Math.min(base, 3)
  return base
}
const netherLack = () => [
  have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0 ? '' : 'кирки',
  foodUnits() >= netherFoodNeed() ? '' : `еды (${foodUnits()} из ${netherFoodNeed()})`
].filter(Boolean).join(', ') || 'ничего'
const fightReady = () => READY.nether() && worn('torso') && shieldOn() && ((worn('legs') && worn('head')) || ironRuns >= 8)
const fightLack = () => [
  netherLack() === 'ничего' ? '' : netherLack(),
  worn('torso') ? '' : 'нагрудника',
  shieldOn() ? '' : 'щита',
  (worn('legs') && worn('head')) || ironRuns >= 8 ? '' : 'поножей или шлема'
].filter(Boolean).join(', ') || 'ничего'
let fightGearWanted = false
const DEFER = {
  food: () => nightWork() || (!sit.surface && have(FOOD) >= 6 && (state.food ?? 20) >= 14) ||
    (OW_DEEP && !known.portal && foodHuntEmpty >= 2 && !weakAndHungry()) ||
    (OW_DEEP && !known.portal && foodSpentMs >= FOOD_CAP_MS && foodUnits() >= 3 && !weakAndHungry()) ||
    (OW_DEEP && !!known.portal && (known.portal.y ?? 64) < 40 && near3(known.portal, 48) && !sit.surface && y() < 40 && (sit.night || READY.nether()) && !weakAndHungry()) ||
    (sit.night && !sit.surface && foodUnits() >= 4) ||
    (OW_DEEP && !known.portal && !sit.surface && y() < 50 && (state.food ?? 20) >= 10 && !weakAndHungry()),
  water: () => (nightWork() && have(PICK_IRON) > 0) ||
    (OW_DEEP && !known.portal && !sit.surface && y() < 50 && gameClock.now() - waterDeepFailAt < 8 * 60000),
  cast: () => (state.playPolicy?.mode !== 'speedrun' && sit.night && sit.surface && dim() === 'overworld' && !(OW_DEEP && !surfaceLavaNear())) ||
    (have(PICK_DIAMOND) > 0 && have(/bucket$/) > 0 && y() < 0) ||
    (castSurfaceFailed && !known.lava)
}
const DONE: any = {}
function defStage (name, needed, run) { STAGES.push({ name, needed, run, ready: READY[name] || (() => true), defer: DEFER[name] || (() => false), done: () => (DONE[name] ? DONE[name]() : !needed()) }) }

let netherExplored = 0
function stageProgress (name) {
  const resources = {
    wood: /_log$|_stem$|_planks$|_pickaxe$/,
    stone: /^cobblestone$|^cobbled_deepslate$|_pickaxe$|_sword$/,
    food: /^(cooked_.+|beef|porkchop|mutton|chicken|rabbit|cod|salmon|bread|baked_potato|golden_carrot|apple|carrot|sweet_berries|melon_slice|pumpkin_pie|golden_apple|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|cookie)$|_wool$|_bed$/,
    iron: /^(raw_iron|iron_ingot|iron_block|raw_iron_block|bucket|water_bucket|shield|flint_and_steel|raw_gold|gold_ingot|golden_helmet)$|^iron_(pickaxe|chestplate|leggings|boots|sword)$/,
    water: /^water_bucket$/,
    cast: /^obsidian$/,
    diamond: /^diamond$|^diamond_pickaxe$/,
    obsidian: /^obsidian$/,
    portal: /^obsidian$/,
    prep: /^(cooked_.+|gold_ingot|golden_helmet|arrow|stick|flint_and_steel|shield)$|_bed$|_pickaxe$/,
    bastion: /^(gold_block|gold_ingot|ender_pearl|potion|splash_potion)$/,
    nether: /^blaze_rod$|^blaze_powder$/,
    pearls: /^ender_pearl$|^ender_eye$/,
    eyes: /^ender_eye$/,
    endkit: /_bed$|_wool$|_boat$|^(arrow|spectral_arrow|bow|water_bucket|bucket|iron_ingot|raw_iron|string|feather|flint|golden_apple|cobblestone|cobbled_deepslate|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|dirt|end_stone)$/
  }
  const result: any = {}
  const re = resources[name]
  if (re) for (const [item, count] of Object.entries(state.inventory || {})) if (re.test(item)) result[item] = count
  for (const key of ['portal', 'fortress', 'stronghold', 'endPortal', 'dragonWon']) result[`known:${key}`] = known[key] ? 1 : 0
  if (dim() === 'the_end') result.end = 1
  if (name === 'nether') result.explored = netherExplored
  return result
}

let woodRoofed = 0
defStage('wood', () => !have(/_pickaxe$/) ||
  (!!known.portal && rodsNow() < 7 && woodNow() < 4 && ((!shieldOn() && have('iron_ingot') > 0) || have(/_pickaxe$/) <= 2)), async (bootstrap = null) => {
  const recovering = !!known.portal
  const starter = process.env.ND_ROUTE === '1' && !recovering && process.env.ND_ROUTE_WOOD_ONCE !== '0' &&
    have(/_pickaxe$/) && have('crafting_table') && have('stick') >= 2
  const stock = () => starter ? have(LOGS) : woodNow()
  // Спидран: 6 брёвен на старте хватает на верстак, кирки и палки, остальное — reserve() по ходу; 14 гоняли по редколесью
  // 15 мин до первой ночи (cl-u 14.10: 4 бревна, ещё 10 искал — смерть от утопленника на 15-й мин).
  const want = bootstrap ?? (starter ? 5 : recovering ? 4 : (process.env.ND_ROUTE === '1' && !known.portal ? (Number(process.env.ND_ROUTE_WOODN) > 0 ? Number(process.env.ND_ROUTE_WOODN) : 6) : state.playPolicy?.mode === 'speedrun' ? 6 : 14))
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  for (let i = 0; i < 10 && stock() < want; i++) {
    await nightGuard()
    await recoverGuard()
    await sense()
    // Наверх не вышло (кирки нет, свод скалы/навес над головой — s8b-a1-7: роща карты под навесом, «лезу рукой» отказ → дерево
    // брошено, камень с пустым рюкзаком, пещера на y −23, зомби): брёвна по видимости и в сторону по поверхности, до 3 раз.
    if (!sit.surface && (!sit.night || canWorkAtNight()) && dim() === 'overworld' && !(await toSurface())) {
      if (process.env.ND_ROUTE === '1' && process.env.ND_WOOD_ROOFED !== '0' && !have(/_pickaxe$/) && ++woodRoofed <= 3 && !died) {
        log(`дерево: наверх не выйти — брёвна на виду, потом в сторону (${woodRoofed}/3)`)
        const m0 = await act('mine', { block: 'any_log', count: want - stock(), radius: 32, timeoutSeconds: 90 })
        if (stock() < want && !(m0.detail && m0.detail.dug)) await walkAway(24, Math.PI / 2)
        continue
      }
      break
    }
    const m = await act('mine', { block: 'any_log', count: want - stock(), radius: 48, timeoutSeconds: 240 })
    if (stock() >= want) break
    if (m.status !== 'done' || !(m.detail && m.detail.dug)) {
      if (!/не вижу/.test(String(m.error || ''))) { await walkAway(20, Math.PI / 2); continue }
      // Дерево видно дальше 48 (прорисовка фермы 128): пустыня и степь — деревья у горизонта (cl-c/cl-d 14.10: 8–18 мин без
      // единого бревна). Видимое — дойти до него, потом рубить.
      const e = await act('explore', { block: 'any_log', radius: 96, stepDistance: 80, timeoutSeconds: 120 })
      const at = e.detail && e.detail.found && e.detail.at
      if (at && state.pos && Math.hypot(at.x - state.pos.x, at.z - state.pos.z) > 40) await act('goto', { x: at.x, z: at.z, range: 8, timeoutSeconds: 90, surface: 'strict' })
      else if (!at) await walkAway(60, Math.PI / 3)
    }
  }
  if (recovering && have(/_pickaxe$/)) return
  if (starter && stock() >= want) {
    if (!known.lava) await act('observe', { radius: 48 })
    return
  }
  const planks = planksFor()
  if (!planks) throw new Error('брёвен нет')
  if (have(/_planks$/) < 12) await craft(planks, 12 - have(/_planks$/))
  if (!have('crafting_table')) await craft('crafting_table')
  await sticks(6)
  await craft('wooden_pickaxe')
  if (!known.lava && !known.portal) await act('observe', { radius: 48 })
})

defStage('stone', () => !have(PICK_STONE) || !have(/_sword$/), async () => {
  // Маршрут (ND_ROUTE_STONETUN=0 — выкл.): в этапе камня — только кирка и меч (5 булыжника); печь — по нужде у жилы под землёй
  // (routeStep ore) или routeFurnaceSupply: «mine stone 13» у поверхности — 83–100 с ходьбы (s8-r1-1, s8-r2-1), а железо из
  // сундуков и голема печи не требует.
  const light = process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_STONETUN !== '0' && !known.portal
  // Сколько булыжника ещё нужно сейчас: в лёгком режиме — 3 на кирку, пока её нет, и 2 на меч, пока его нет.
  let want = light ? 5 : OW_DEEP ? 13 : 24
  const wantNow = () => light ? (have(PICK_STONE) ? 0 : 3) + (have(/_sword$/) ? 0 : 2) : want
  const safeStone = process.env.ND_ROUTE === '1'
  const pickFirst = safeStone && process.env.ND_ROUTE_PICK_FIRST !== '0'
  let hurt = false
  for (let i = 0; i < 8 && have(COBBLE) < (want = wantNow()); i++) {
    await nightGuard()
    await recoverGuard()
    if (died) return
    if (!have(PICK_STONE) && have(COBBLE) >= 3 && process.env.ND_ROUTE === '1') { await sticks(2); await craft('stone_pickaxe') }
    if (light) { want = wantNow(); if (have(COBBLE) >= want) break }
    const firstPick = pickFirst && !have(PICK_STONE)
    const batch = firstPick ? Math.min(want - have(COBBLE), Math.max(1, 3 - have(COBBLE))) : want - have(COBBLE)
    // Булыжник после каменной кирки — штреком вперёд под землёй, а не «mine stone» по видимым блокам: штрек 8 даёт 16 за
    // 24–38 с, mine 13 — 83–100 с ходьбы от блока к блоку (s8-base/s8-r1 06–07.10). ND_ROUTE_STONETUN=0 — выкл.
    if (!firstPick && !hurt && have(PICK_STONE) && process.env.ND_ROUTE_STONETUN !== '0') {
      await sense()
      if (!sit.surface) {
        await act('tunnel', { length: Math.min(10, Math.ceil(batch / 2) + 1), torchEvery: 0, timeoutSeconds: 60 })
        if (have(COBBLE) >= want) break
      }
    }
    const m = hurt ? { detail: {} } : await act('mine', { block: 'stone', count: batch, radius: safeStone ? 14 : 32, dry: true, timeoutSeconds: 180 })
    if (have(COBBLE) >= want) break
    if (safeStone && (m.code === 'DAMAGE' || m.status === 'interrupted')) { hurt = true; log(`камень: ${m.code || m.status} в забое — дальше своей лесенкой`); await act('surface', { timeoutSeconds: 40, hand: false, preferPillar: true }) }
    else if (m.detail && m.detail.dug) continue
    if (safeStone) {
      const ob = await act('observe', { radius: 7 })
      if ((Array.isArray(ob.detail && ob.detail.blocks) ? ob.detail.blocks : []).some(b => b && b.name === 'water')) { log('камень: вода рядом — лесенку копаю подальше от неё'); await awayFromWater(24); await sense(); if (sit.inWater) await leaveWater() }
    }
    const d = await act('dig_down', { mode: 'stairs', depth: firstPick ? 3 : 10, torchEvery: 0, timeoutSeconds: 180 })
    const dWet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(String((d.detail && d.detail.stopped) || ''))
    if (dWet && !(d.detail && d.detail.steps >= 3)) { await awayFrom({ x: +dWet[1], z: +dWet[3] }, 20).catch(() => null); continue }
    if (d.detail && d.detail.steps) continue
    // «Digging aborted» — копку на первом же блоке сорвал крафт автопилота (деревянный меч, s8-base-2/4: +wooden_sword в том
    // же ответе), а не порода: ещё раз здесь же, а не разведка камня за 60 м (там — вода и ночь).
    if (/aborted/i.test(String((d.detail && d.detail.stopped) || '')) && i < 3) continue
    if (/У кирки осталось/.test(String((d.detail && d.detail.stopped) || ''))) {
      if (have(/_planks$/) >= 3 || have(LOGS)) { await sticks(2); if (await craft('wooden_pickaxe')) continue }
      const d2 = await act('dig_down', { mode: 'stairs', depth: 3, torchEvery: 0, timeoutSeconds: 90 })
      if (d2.detail && d2.detail.steps) continue
    }
    const e = await act('explore', { block: 'stone', radius: 48, stepDistance: 60, timeoutSeconds: 120 })
    if (!(e.detail && e.detail.found) || /уже видно/.test(String((e.detail && e.detail.note) || ''))) await walkAway(40, Math.PI / 2)
  }
  await sticks(5)
  if (!have(PICK_STONE)) await craft('stone_pickaxe')
  if (!have(/_sword$/)) await craft('stone_sword')
  if (!have(/_axe$/) && have(COBBLE) >= 11) await craft('stone_axe')
  if (!have('furnace') && have(COBBLE) >= 8) await craft('furnace')
  if (!known.lava && !known.portal) await act('observe', { radius: 48 })
})

const nightWork = () => state.playPolicy?.mode !== 'speedrun' && sit.night && !canWorkAtNight() && (state.food ?? 20) >= (NIGHT_DOWN2() ? 6 : 12) && have(PICK_STONE) > 0 && !have(/_bed$/)
const FOOD_STOCK = 8
let foodHuntEmpty = 0
let foodSpentMs = 0
const FOOD_CAP_MS = 180000
defStage('food', () => foodUnits() < FOOD_STOCK, async () => {
  hunting = true
  const before = foodUnits()
  const t0 = gameClock.now()
  try { await foodRun() } finally { hunting = false; if (OW_DEEP && !known.portal) foodSpentMs += gameClock.now() - t0 }
  if (foodUnits() > before) foodHuntEmpty = 0
  else if (!died && ++foodHuntEmpty === 2) log('охота пуста дважды подряд — железо пойдёт и при сытости ≥ 8 (в горах оно на склонах)')
})
async function foodRun () {
  await cook()
  await makeBed()
  const woolMax = () => Math.max(0, ...Object.entries(state.inventory || {}).filter(([k]) => /_wool$/.test(k)).map(([, v]) => Number(v)))
  const wantWool = () => (huntWool || !have(/_bed$/)) && have(/_bed$/) + Math.floor(woolMax() / 3) < wantBeds
  if (foodUnits() >= FOOD_STOCK && !wantWool()) return
  await sense()
  if (OW_DEEP && known.portal && !sit.surface && y() < 40 && foodUnits() >= netherFoodNeed()) { log(`еды ${foodUnits()} — на вход в Ад хватает, с глубины за запасом не поднимаюсь`); return }
  // В спидране охоту уже выбрал граф по цене; старый общий бюджет не отменяет его шаг без действий.
  const deepEarly = OW_DEEP && !known.portal && state.playPolicy?.mode !== 'speedrun'
  if (deepEarly && /frozen|peaks|ice_spikes|snowy_slopes|grove/.test(String(state.biome || ''))) { log(`охота: ${state.biome} — рыхлый снег, звери редки; без охоты`); return }
  const remaining = deepEarly ? Math.max(0, FOOD_CAP_MS - foodSpentMs) : 120000
  if (deepEarly && remaining < 10000 && !weakAndHungry()) { log('охота: бюджет до портала (3 мин) исчерпан'); return }
  const deadline = gameClock.now() + (deepEarly ? Math.min(60000, remaining) : 120000)
  if (!(await toSurface())) { log('за едой не вышел на поверхность — сначала устранить причину подъёма'); return }
  await unclutter()
  if (have(/^bucket$/) && !have('water_bucket')) await act('bucket', { fluid: 'water', radius: 32 })
  let blocked = false
  let climbing = false
  let searchedMelons = false
  for (let i = 0; i < 4 && gameClock.now() < deadline && (foodUnits() < FOOD_STOCK || wantWool()); i++) {
    await sense()
    if (nightWork()) break
    await nightGuard()
    await recoverGuard()
    if (died) return
    if (gameClock.now() >= deadline) break
    const o = await act('observe', { radius: 64 })
    const ents = (o.detail && o.detail.entities) || []
    const melons = (Array.isArray(o.detail?.blocks) ? o.detail.blocks : []).some(b => b.name === 'melon')
    if (foodUnits() < FOOD_STOCK && (melons || (!searchedMelons && /jungle/.test(state.biome || '')))) {
      searchedMelons = true
      await act('mine', { block: 'melon', count: Math.min(4, Math.ceil((FOOD_STOCK - foodUnits()) / 1.5)),
        radius: 64, timeoutSeconds: 30 })
      if (died) return
      if (foodUnits() >= FOOD_STOCK && !wantWool()) break
    }
    // Visible water alone is no attacker. Actual drowning/hostiles remain handled by act and the body's reflexes.
    const myY = y()
    const animals = ents.filter(e => /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(String(e.name || '').toLowerCase()) &&
      !(e.pos && Math.abs(e.pos.y - myY) > 6))
    const woolFor = have(/_bed$/) + Math.floor(woolMax() / 3) < Math.max(2, wantBeds)
    const foodFull = foodUnits() >= FOOD_STOCK
    const prey = (woolFor && animals.find(e => /^sheep$/i.test(e.name))) || (foodFull ? null : animals[0])
    if (prey) {
      const kind = String(prey.name).toLowerCase()
      if ((prey.dist ?? 0) > 20 && prey.pos) await act('goto', { x: prey.pos.x, z: prey.pos.z, range: 8, timeoutSeconds: 45, surface: 'strict' })
      for (let k = 0; k < 4 && gameClock.now() < deadline && (foodUnits() < FOOD_STOCK || (kind === 'sheep' && wantWool())) && !died; k++) {
        const f = await act('fight', { target: kind, timeoutSeconds: 40, retreatAtHealth: 0,
          purpose: kind === 'sheep' && wantWool() && foodUnits() >= FOOD_STOCK ? 'resource' : 'food',
          ...(kind === 'sheep' && wantWool() && foodUnits() >= FOOD_STOCK ? { resourceGoal: { item: 'wool', count: have(/_wool$/) + wantBeds * 3 - woolMax() } } : {}) })
        if (f.status !== 'done' || (state.health ?? 20) < 10) break
      }
      await refresh()
      if (have(RAW) >= 1 && ((state.health ?? 20) < 14 || (state.food ?? 20) < 14)) {
        await cook()
        if (have(FOOD) && (state.food ?? 20) < 20) await act('eat')
      }
    } else {
      if (!(await toSurface())) break
      const y0 = y()
      const w = await walkAway(64, blocked || climbing ? Math.PI / 2 : 0)
      blocked = !(w && w.status === 'done')
      climbing = y() - y0 >= 12 || (y() > 100 && y() >= y0)
    }
    await makeBed()
  }
  await cook()
  await makeBed()
}

let quickHuntAt = 0
let nightDigAt = 0
let nightCastAt = 0
let nightHeld = false
let nightEnterAt = 0
let foodSearchAt = 0
async function quickHunt () {
  await sense()
  if (!sit.surface || sit.night || (state.health ?? 20) < 10) return
  const until = gameClock.now() + 60000
  hunting = true
  try {
    for (let k = 0; k < 3 && gameClock.now() < until && !died; k++) {
      const o = await act('observe', { radius: 32 })
      const ents = (o.detail && o.detail.entities) || []
      const prey = ents.filter(e => /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(String(e.name || '').toLowerCase()) &&
        (e.dist ?? 99) <= 24 && !(e.pos && Math.abs(e.pos.y - y()) > 4)).sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99))[0]
      if (!prey) break
      const f = await act('fight', { target: String(prey.name).toLowerCase(), timeoutSeconds: 25, retreatAtHealth: 0, purpose: 'food' })
      if (f.status !== 'done') break
    }
  } finally { hunting = false }
  await refresh()
  if (have(RAW)) await cook()
}

async function makeBed () {
  if (have(/_bed$/) >= Math.max(2, wantBeds)) return
  if (have(/_wool$/) < 3) return
  await unclutter()
  const inv = state.inventory || {}
  let wool: any = Object.entries(inv).filter(([k]) => /_wool$/.test(k)).sort((a: any, b: any) => b[1] - a[1])[0]
  if ((!wool || wool[1] < 3) && have(/_wool$/) >= 3 &&
    have('white_dye') + have('bone_meal') + have('bone') * 3 >= 3 - have('white_wool')) {
    const need = 3 - have('white_wool')
    for (let i = 0; i < 3 && have('white_dye') < need; i++) {
      const before = have('white_dye')
      const meal = Math.max(0, need - before)
      if (have('bone_meal') < meal) await craft('bone_meal', Math.ceil((meal - have('bone_meal')) / 3) * 3)
      if (have('white_dye') < need) await craft('white_dye', need - have('white_dye'))
      if (have('white_dye') <= before) break
    }
    for (let i = 0; i < 3 && have('white_wool') < 3 && have('white_dye'); i++) {
      const before = have('white_wool')
      await craft('white_wool', Math.min(3 - before, have('white_dye')))
      if (have('white_wool') <= before) break
    }
    wool = Object.entries(state.inventory || {}).filter(([k]) => /_wool$/.test(k)).sort((a: any, b: any) => b[1] - a[1])[0]
  }
  if (!wool || wool[1] < 3) return
  const sameMax = () => Math.max(0, ...Object.entries(state.inventory || {}).filter(([k]) => /_planks$/.test(k)).map(([, v]) => Number(v)))
  const tableNeed = have('crafting_table') ? 0 : 4
  if (sameMax() < 3 + tableNeed) { const p = planksFor(); if (p) await craft(p, have(p) >= 3 + tableNeed ? 0 : 4 * Math.ceil((3 + tableNeed - have(p)) / 4)) }
  await refresh()
  await craft(wool[0].replace(/_wool$/, '_bed'))
  if (!have(/_bed$/) && sameMax() < 3) { const p = planksFor(); if (p) { await craft(p, 4); await craft(wool[0].replace(/_wool$/, '_bed')) } }
}

async function cook ({ reserveHunger = Infinity } = {}) {
  await refresh()
  const raw = () => Object.keys(state.inventory || {}).filter(k => RAW.test(k) && have(k) > 0)
  const needed = r => r === 'chicken' || !Number.isFinite(reserveHunger) ? have(r) :
    Math.min(have(r), Math.max(0, Math.ceil((reserveHunger - routeCookedHunger()) / ROUTE_COOKED_HUNGER[`cooked_${r}`])))
  const complete = () => raw().every(r => needed(r) === 0)
  const batch = async () => {
    for (const r of raw()) {
      const max = needed(r)
      if (max > 0) { await smeltAll(r, `cooked_${r}`, { max }); await refresh() }
    }
  }
  if (!raw().length) return
  await batch()
  await refresh()
  if (complete() || have('furnace') || have(COBBLE) >= 8) { if (complete()) await furnaceBack(); return }
  // Без настоящего топлива новая печь не поможет: камень на неё не копать.
  // (s8-r2-8: quickHunt у портала → cook → mine stone 8 за 34 с, жарить всё равно нечем).
  if (!have(/^(coal|charcoal)$/) && !have('lava_bucket') && !have(/^(?!crimson_|warped_).*_(log|planks)$/)) { log('жарить нечем: топлива нет — печь не копаю'); return }
  await act('mine', { block: 'stone', count: 8, radius: 32, dry: true, timeoutSeconds: 120 })
  if (have(COBBLE) < 8) await act('dig_down', { mode: 'stairs', depth: 6, torchEvery: 0, timeoutSeconds: 120 })
  await batch()
  await refresh()
  if (complete()) await furnaceBack()
}
async function furnaceBack () {
  if (!OW_DEEP || known.portal || have('furnace') || dim() !== 'overworld') return
  await refresh()
  if (have('furnace') || !have(/_pickaxe$/)) return
  await act('mine', { block: 'furnace', count: 1, radius: 6, timeoutSeconds: 20 })
}

defStage('iron', () => (!known.portal && have(/bucket$/) < portalBuckets()) ||
  (!!known.portal && rodsNow() >= 7 && !have(PICK_IRON)) ||
  (!!known.portal && fightGearWanted && rodsNow() < 7 && !fightReady() && ironRuns < 8) ||
  (!known.portal && castSurfaceFailed && !have(PICK_IRON)) ||
  (!known.portal && !have(/bucket$/)), async () => {
  ironRuns++
  if (!known.portal && have('raw_iron')) {
    const buckets = have(/bucket$/)
    await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
    await spendIron()
    if (!(castSurfaceFailed && !have(PICK_IRON)) && (have(/bucket$/) > buckets || (have(/bucket$/) && lighter()))) return
  }
  const ironBase = known.portal
    ? Math.max(3, (have(PICK_IRON) ? 0 : 3) + ((have(/bucket$/) || have('water_bucket')) ? 0 : 3) +
      (fightGearWanted ? (worn('torso') ? 0 : 8) + (worn('legs') ? 0 : 7) + (worn('head') ? 0 : 5) + (shieldOn() ? 0 : 1) : 0))
    : 3 * portalBuckets() + 1 + ((castSurfaceFailed && !have(PICK_IRON)) ? 3 : 0)
  let want = ironBase
  for (const item of ['iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots']) {
    if (worn(ARMOR_SLOT[item.split('_').pop()])) continue
    const g = gearWorth(item)
    if (g.missing) { log(g.line); if (g.take) want += ARMOR_COST[item] }
  }
  const ironNow = () => have(/^(raw_iron|iron_ingot)$/) + Math.floor(have('iron_nugget') / 9) + 9 * have('iron_block') + 9 * have('raw_iron_block') +
    (!known.portal ? 3 * Math.min(portalBuckets(), have(/bucket$/)) + (lighter() ? 1 : 0) : 0)
  await sense()
  if (weakAndHungry()) { log(`хп ${Math.round(state.health ?? 0)} и еды нет — вниз не иду, сначала охота`); return }
  await cook()
  if ((state.food ?? 20) < 18 && have(FOOD)) await act('eat')
  if (OW_DEEP && !known.portal && ironNow() < want && sit.surface && !sit.night && dim() === 'overworld') {
    const high = y() > 90
    for (let k = 0; k < (high ? 2 : 1) && ironNow() < want && !died; k++) {
      const m = await act('mine', { block: 'iron_ore', count: want - ironNow(), radius: high ? 32 : 24, timeoutSeconds: high ? 90 : 60 })
      if (!(m.detail && m.detail.dug)) break
    }
    if (have(/^(coal|charcoal)$/) < 4) await act('mine', { block: 'coal_ore', count: 6, radius: 24, timeoutSeconds: 60 })
  } else if (ironNow() < want && sit.surface && !sit.night && dim() === 'overworld') {
    for (let k = 0; k < 4 && ironNow() < want && !died; k++) {
      const m = await act('mine', { block: 'iron_ore', count: want - ironNow(), radius: 48, timeoutSeconds: 180 })
      if (m.detail && m.detail.dug) continue
      await sense()
      if (sit.night) break
      const e = await act('explore', { block: 'iron_ore', radius: 48, stepDistance: 60, timeoutSeconds: 120 })
      if (!(e.detail && e.detail.found)) break
    }
    if (have(/^(coal|charcoal)$/) < 4) await act('mine', { block: 'coal_ore', count: 6, radius: 32, timeoutSeconds: 90 })
  }
  if (died) return
  if (ironNow() < want && y() > 24 && have(/_bed$/)) {
    await sense()
    await readMemory()
    const sb = known.spawnBed
    if (dim() === 'overworld' && (!sb || Math.hypot(sb.x - state.pos.x, sb.z - state.pos.z) > 48)) {
      await act('sleep', { mode: 'spawn', why: 'у шахты за железом' })
    }
  }
  // Дерева на глубину: маршруту хватает 4 (плавка ~5 слитков — 4 доски, палки на кирку/факелы — одно бревно); s8c-g: лесоповал перед
  // спуском при 4–5 брёвнах — 43 с/прогон. ND_ROUTE_IRONWOOD=0 — прежние 6.
  const woodFloor = process.env.ND_ROUTE === '1' && stage === 'route' && process.env.ND_ROUTE_IRONWOOD !== '0' ? 4 : 6
  if (ironNow() < want && y() > 24 && !(OW_DEEP && woodNow() >= woodFloor)) { await sense(); if (sit.surface && !sit.night) await lumber(8) }
  if (OW_DEEP && !known.portal && ironNow() < want && y() > 24 && foodUnits() < FOOD_STOCK + 2) await quickHunt()
  if (OW_DEEP && !known.portal && ironNow() < want && y() > 24 && !skyLavaSeen) await surfaceLavaSurvey()
  if (OW_DEEP && !known.portal && ironNow() < want && y() > 24 && !have('water_bucket')) {
    await sense()
    if (sit.surface) {
      const o = await act('observe', { radius: 48 })
      const w = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'water' && b.nearest)
      shaftWaterSeen = w ? w.nearest : null
    }
  }
  if (ironNow() < want && y() > 24) await descend(16)
  if (died) return
  if (OW_DEEP && OW_HEAR && !known.portal && y() < 40) await listenForLava('низ колодца')
  if (OW_DEEP && ironNow() < want) await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: want - ironNow(), radius: process.env.ND_IRON_WIDE !== '0' ? 24 : 14, timeoutSeconds: 120 })
  if (died) return
  await lightUp()
  const ironDir = n => ['north', 'east', 'south', 'west'][n % 4]
  for (let i = 0; i < 14 && ironNow() < want; i++) {
    await recoverGuard()
    if (died) return
    await unclutter()
    await spares()
    await sense()
    if ((sit.pickLeft ?? 0) < 120 && have('stick') < 2 && have(/_planks$/) < 2 && !have(LOGS)) {
      log(`кирке осталось ${sit.pickLeft ?? 0} ударов, палок нет — наверх за деревом, пока есть чем копать`)
      // Ночью наверх за деревом — под мобов: кирку беречь, внизу ждать рассвета (главный цикл держит ночь).
      if (nightHold()) { log('ночь — за деревом с рассветом, кирку берегу'); break }
      if (await toSurface()) { await nightGuard(); await lumber(10); await spares(300) }
      break
    }
    let tdir = ironDir(ironLeg++)
    if (state.pos) {
      const here = `${Math.floor(state.pos.x)},${Math.floor(state.pos.z)}`
      for (let k = 0; k < 4 && ironBlocked.has(`${here}:${tdir}`); k++) tdir = ['north', 'east', 'south', 'west'][(['north', 'east', 'south', 'west'].indexOf(tdir) + 1) % 4]
    }
    const tFrom = state.pos ? `${Math.floor(state.pos.x)},${Math.floor(state.pos.z)}` : ''
    const t = await act('tunnel', { direction: tdir, length: 32, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    if (t.detail && t.detail.stopped && !(t.detail.walked > 0)) ironBlocked.add(`${tFrom}:${tdir}`)
    if (await mobInTheWay(t)) continue
    if (OW_DEEP && OW_HEAR && !known.portal) await listenForLava('штрек за железом')
    await mineSeenAll('iron_ore')
    await mineSeenAll('deepslate_iron_ore')
    if (OW_DEEP && !known.portal && !have('water_bucket')) await bucketOnTheWay(t)
    if (known.portal && have(PICK_IRON) && !goldOn() && have(/^(raw_gold|gold_ingot)$/) < 5) await mineSeenAll('gold_ore,deepslate_gold_ore')
    if (ironNow() < want) await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: Math.min(8, want - ironNow()), radius: OW_DEEP ? (process.env.ND_IRON_WIDE !== '0' ? 24 : 16) : 32, timeoutSeconds: 150 })
    if ((!known.lava || OW_DEEP) && !known.portal) await act('observe', { radius: 32 })
    if (have(/^(coal|charcoal)$/) < 12) await mineSeenAll('coal_ore')
    if (!have('flint') && !have('flint_and_steel')) await act('mine', { block: 'gravel', dry: true, count: 8, radius: 16, timeoutSeconds: 90 })
    await torches()
    if (t.detail && t.detail.need) break
    const goldDone = !known.portal || goldOn() || have(/^(raw_gold|gold_ingot)$/) >= 5
    if (i >= (known.portal ? 1 : 4) && ironNow() >= (known.portal ? want : 8) && (goldDone || i >= (known.portal ? 5 : 10))) break
  }
  if (have('raw_iron') && !have(/^(coal|charcoal)$/) && woodNow() < 6 && ironToSmelt() > 0) {
    await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
    if (have('raw_iron') && ironToSmelt() > 0 && await toSurface()) { await nightGuard(); await lumber(12) }
  }
  await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
  await spendIron()
  // #piglin_safe_armor (PiglinAi.isWearingSafeArmor, paper-1.21.11 — см.
  if (have(PICK_IRON) && have(/^(raw_gold|gold_ingot)$/) < 5) {
    await mineSeenAll('gold_ore')
    await mineSeenAll('deepslate_gold_ore')
  }
  await smeltAll('raw_gold', 'gold_ingot')
  if (known.portal && !goldOn() && have('gold_ingot') >= 4) await wearGold()
})

async function bucketOnTheWay (t) {
  if (!have(/bucket$/) && have(/^(raw_iron|iron_ingot)$/) >= 3) {
    await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
    if (have('iron_ingot') >= 3 && !have(/bucket$/)) await craft('bucket')
  }
  if (!have('bucket') || have('water_bucket')) return
  const why = String((t && t.detail && t.detail.stopped) || '')
  const wet = /вода (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(why)
  const r = await act('bucket', { fluid: 'water', radius: 24 })
  if (have('water_bucket')) { log('вода по пути: ведро полное'); return }
  const q = wet ? { x: +wet[1], y: +wet[2], z: +wet[3] } : (knownWater && state.pos && Math.hypot(knownWater.x - state.pos.x, knownWater.y - state.pos.y, knownWater.z - state.pos.z) <= 8 ? knownWater : null)
  if (q && !(r.detail && r.detail.need)) {
    await act('portal', { mode: 'cast', waterHint: q, timeoutSeconds: 90 })
    if (have('water_bucket')) log(`вода по пути: окно у ${q.x},${q.y},${q.z} — ведро полное`)
  }
}

async function mineSeenAll (block, maxDist = 24) {
  const names = block.split(',').map(s => s.trim())
  for (let i = 0; i < 3; i++) {
    let spots = []
    try {
      const r: any = await call('mine_seen', { limit: 40 })
      spots = (r.detail && r.detail.spots) || []
    } catch { return }
    // S8c (вслепую железо только копкой): виденная руда до 8 по высоте и 24 бл. (было 4 и 16 — жила в стене пещеры рядом
    // оставалась). ND_IRON_WIDE=0 — прежнее.
    const wide = process.env.ND_IRON_WIDE !== '0'
    const levelOk = p => !OW_DEEP || (Math.abs(((p.at && p.at.y) ?? y()) - y()) <= (wide ? 8 : 4) && (p.fromMe ?? 99) <= (wide ? 24 : 16))
    const s = spots.find(p => names.includes(p.name) && (p.fromMe ?? 99) <= maxDist && levelOk(p) &&
      (p.why !== 'в прямой видимости' || (p.fromMe ?? 99) <= 5))
    if (!s) return
    const r = await act('mine_seen', { at: s.at, timeoutSeconds: 120 })
    if (r.status !== 'done' || died) return
  }
}

const ironToSmelt = () => {
  if (!(OW_DEEP && !known.portal)) return Infinity
  const noShield = !have('shield') && !(state.offHand && /shield/.test(JSON.stringify(state.offHand)))
  const wantB = portalBuckets()
  const need = 3 * Math.max(0, wantB - have(/bucket$/)) + (lighter() ? 0 : 1) + (noShield ? 1 : 0) + (castSurfaceFailed && !have(PICK_IRON) ? 3 : 0)
  return Math.max(0, need - have('iron_ingot'))
}
async function smeltAll (from, into, { fetchCoal = false, max = Infinity } = {}) {
  await refresh()
  if (!have(from) || max <= 0) return
  const target = have(into) + Math.min(have(from), max)
  const left = () => Math.min(have(from), Math.max(0, target - have(into)))
  await unclutter()
  if (!have('furnace')) await ensureTable()
  if (fetchCoal && have(/^(coal|charcoal)$/) * 8 < left()) {
    await mineSeenAll('coal_ore,deepslate_coal_ore', 24)
    if (have(/^(coal|charcoal)$/) * 8 < left()) await act('mine', { block: 'coal_ore,deepslate_coal_ore', count: 3, radius: 16, timeoutSeconds: 60 })
  }
  const inv = () => Object.keys(state.inventory || {})
  const cooking = RAW.test(from)
  const fireLogs = inv().filter(k => LOGS.test(k) && !/crimson|warped/.test(k)).reduce((n, k) => n + have(k), 0)
  if (!have(/^(coal|charcoal)$/) && !have('lava_bucket') && left() >= 4 && fireLogs >= 5) {
    const want = Math.min(Math.ceil(left() / 8), fireLogs - 4)
    if (want > 0) {
      if (have(/_planks$/) * 1.5 < want) { const p = planksFor(); if (p) await craft(p, 4) }
      const plank = inv().find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k))
      if (plank) await act('smelt', { item: 'charcoal', count: want, fuel: plank, timeoutSeconds: 120 })
    }
    await refresh()
  }
  for (let i = 0; i < 3 && left() > 0; i++) {
    await unclutter()
    const coal = have(/^(coal|charcoal)$/) > 0
    const logK = inv().find(k => LOGS.test(k) && (!cooking || !/crimson|warped/.test(k)) && have(k) > 0)
    let plankK = inv().find(k => /_planks$/.test(k) && (!cooking || !/^(crimson|warped)_/.test(k)) && have(k) > 0)
    // Еда нужна телу сейчас. Печь/верстак уже проверяются перед топливом;
    // четыре будущих бревна не должны запрещать готовку имеющегося мяса.
    // Бревно превращается в четыре доски: в печи это вчетверо больше топлива.
    if (cooking && !coal && !have('lava_bucket') && logK && (plankK ? have(plankK) : 0) * 1.5 < left()) {
      await craft(logK.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks'), 4)
      plankK = inv().find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k) && have(k) > 0)
    }
    // Сырое железо/золото — узкое место маршрута (ведро, огниво, кирка): запас дерева на будущее — одно бревно или две доски,
    // остальное в печь. Прежний резерв 4 бревна / 8 досок без ND_OW_DEEP запрещал плавку вовсе (cl-b 14.10: 6 сырого железа,
    // «плавить нечем», подъём за деревом под озеро и 5-минутная пауза этапа).
    const metal = /^raw_(iron|gold)$/.test(from)
    const keepLogs = cooking ? 0 : metal ? 1 : 4
    const keepPlanks = cooking ? 0 : metal ? 2 : 8
    // Бревно в доски перед печью: доска горит 1.5 предмета, бревно — тоже 1.5, а досок из него четыре.
    if (metal && !coal && have(LOGS) >= 1 && (have(/_planks$/) - keepPlanks) * 1.5 < left()) {
      const p = planksFor(); if (p) { await craft(p, 4); plankK = inv().find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k) && have(k) > 0) }
    }
    const stickK = metal && have('stick') > 4 ? 'stick' : null
    const wood = have('lava_bucket') ? 'lava_bucket'
      : cooking && plankK ? plankK
      : metal && plankK && have(/_planks$/) > keepPlanks ? plankK
      : (logK && have(LOGS) > keepLogs) ? logK
        : (plankK && have(/_planks$/) > keepPlanks) ? plankK
          : stickK
    if (!coal && !wood) { log(`плавить ${from} нечем: угля нет, а дерево — запас на глубину`); break }
    const r = await act('smelt', { item: into, count: left(), fuel: coal ? undefined : wood, timeoutSeconds: 400 })
    await refresh()
    if (r.status !== 'done' && !coal && !wood) break
  }
}

async function lightUp () {
  await refresh()
  if (have('torch') >= 8 || have(/^(coal|charcoal)$/) >= 2) return torches()
  if (have(LOGS) < 4) return
  await unclutter()
  if (!have('furnace')) await ensureTable()
  if (have(/_planks$/) < 2) { const p = planksFor(); if (p) await craft(p, 4) }
  const plank = Object.keys(state.inventory || {}).find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k))
  if (plank) await act('smelt', { item: 'charcoal', count: 2, fuel: plank, timeoutSeconds: 90 })
  await torches()
}

async function torches () {
  await refresh()
  if (have('torch') >= 16 || have(/^(coal|charcoal)$/) < 2) return
  await sticks(2)
  await craft('torch', 8)
}

defStage('water', () => have(/^bucket$/) > 0 && !have('water_bucket') && !known.portal, async () => {
  await sense()
  if (OW_DEEP && !sit.surface && y() < 50) {
    const viaShaft = surfaceShaftNear() && !!shaftWaterSeen
    if (await deepWater({ legs: viaShaft ? 2 : 5 })) return
    if (viaShaft && !died && await waterViaShaft()) return
    if (!died && have(/bucket$/) >= 2 && ++waterDeepFails < 3) { waterDeepFailAt = gameClock.now(); log(`вода глубоко: штреками не нашлась (${waterDeepFails}-й раз) — ищу попутно у лавы, наверх не иду`); return }
  }
  for (let i = 0; i < 6 && !have('water_bucket'); i++) {
    await recoverGuard()
    if (died) return
    const r = await act('bucket', { fluid: 'water', radius: 32 })
    if (have('water_bucket')) break
    if (r.detail && r.detail.need) break
    if (!(await toSurface())) break
    await nightGuard()
    const r2 = await act('bucket', { fluid: 'water', radius: 32 })
    if (have('water_bucket') || (r2.detail && r2.detail.need)) break
    const e = await act('explore', { block: 'water', waterSource: true, radius: 48, stepDistance: 80, timeoutSeconds: 150 })
    if (!(e.detail && e.detail.found)) await walkAway(60, Math.PI / 4)
    // Источник виден дальше радиуса ведра (32) — explore отвечает «уже видно», ведро «не вижу»: подойти к нему.
    else if (e.detail.at && state.pos && Math.hypot(e.detail.at.x - state.pos.x, e.detail.at.y - state.pos.y, e.detail.at.z - state.pos.z) > 6) {
      await act('goto', { x: e.detail.at.x, y: e.detail.at.y, z: e.detail.at.z, range: 4, timeoutSeconds: 60 })
    }
  }
})

const flintSearchSeen = new Set<string>()
let flintSearchViews = 0
async function ensureFlint () {
  if (have('flint_and_steel') || have('fire_charge')) return true
  // Current body pose after an actual search look, never coordinates of hidden gravel.
  const view = () => state.pos && ['x', 'y', 'z'].every(axis => Number.isFinite(state.pos[axis]))
    ? [dim(), ...['x', 'y', 'z'].map(axis => Math.floor(state.pos[axis] / 16))].join(':') : null
  const initialView = view()
  if (initialView) flintSearchSeen.add(initialView)
  const until = gameClock.now() + 180000
  if (!have('flint') && have('gravel') && !died) {
    const r = await act('flint_grind', { max: 40, timeoutSeconds: 90 })
    await refresh()
    if (r.status === 'interrupted') return false
  }
  for (let k = 0; k < 4 && !have('flint') && !died && gameClock.now() < until; k++) {
    if ((state.health ?? 20) < 12) { log('кремень: мало хп — поиск гравия прекращаю'); break }
    const g = await act('mine', { block: 'gravel', dry: true, count: 8, radius: 48, timeoutSeconds: Math.min(60, (until - gameClock.now()) / 1000) })
    if (g.status === 'interrupted') { log('кремень: копку прервали — поиск гравия прекращаю'); break }
    await refresh()
    if (!have('flint') && have('gravel') && gameClock.now() + 5000 < until) {
      const r = await act('flint_grind', { max: 40, timeoutSeconds: Math.min(90, (until - gameClock.now()) / 1000) })
      await refresh()
      if (r.status === 'interrupted') return false
    }
    if (have('flint') || died || gameClock.now() >= until) break
    if (!(g.detail && g.detail.dug)) {
      const e = await act('explore', { block: 'gravel', dry: true, surface: true, radius: 48, stepDistance: 60, timeoutSeconds: Math.min(60, (until - gameClock.now()) / 1000) })
      if (e.status === 'interrupted') return false
      const seen = view()
      const fresh = seen && e.status === 'done' && !e.detail?.stuck && !strategyInterrupted && !died && !flintSearchSeen.has(seen)
      if (fresh) { flintSearchSeen.add(seen); flintSearchViews++; graphFact('flint_search_views', flintSearchViews) }
      if (!e.detail?.found && !fresh) break
    }
  }
  if (have('flint') && !have('iron_ingot') && known.portal && portalFar() < 48) await act('chest_take', { item: 'iron_ingot', count: 1 })
  if (have('flint') && have('iron_ingot')) await craft('flint_and_steel')
  return have('flint_and_steel') > 0
}

let castRuns = 0
let castSurfaceFailed = false

const OW_DEEP = process.env.ND_OW_DEEP === '1'
const OW_SHAFT = process.env.ND_OW_SHAFT !== '0'
const OW_HEAR = process.env.ND_OW_HEAR !== '0'
const DEEP_Y = -54
let deepLava = null // лава за блоком у штрека (чутьё безопасности) — ориентир окна
const deepBad = [] // лава, у которой окно или место не вышли
const near3 = (p, r) => !!p && !!state.pos && Math.hypot(p.x - state.pos.x, (p.y ?? y()) - state.pos.y, p.z - state.pos.z) <= r
const surfaceLavaNear = () => !!known.lava && (known.lava.y ?? 64) >= 0 && !!state.pos && Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) <= 96
let skyLavaSeen = (() => { try { const h = process.env.ND_OW_LAVA_HINT ? JSON.parse(process.env.ND_OW_LAVA_HINT) : null; return h && Number.isFinite(h.x) ? { x: h.x, y: h.y, z: h.z, hint: true } : null } catch { return null } })()
const NATURAL = process.env.ND_PORTAL_NATURAL === '1'
let naturalTried = 0
let surveyDone = false
// Взгляд вдаль на лаву под небом (portal_natural survey: верх столбцов в 128 бл., луч видимости из глаз — как игрок, который
// осмотрелся): озеро лавы светится и видно издалека, а observe 64 и explore 48 его не видели (cl-k 14.10: озеро в 50 бл. от
// спавна, разведка ушла на север; ни один из 22 прогонов cl-a…cl-k не дошёл до литья). Годное озеро — в known.lava.
let skyLookAt = null
let skyLookNext = 0
let lookoutsDone = 0
async function skyLavaLook () {
  if (dim() !== 'overworld' || known.portal || process.env.ND_SKY_LAVA === '0') return null
  await sense()
  if (!sit.surface || !state.pos) return null
  // Тот же вид с того же места второй раз ничего не даст.
  if (skyLookAt && Math.hypot(skyLookAt.x - state.pos.x, skyLookAt.z - state.pos.z) < 24) return null
  skyLookAt = { x: state.pos.x, z: state.pos.z }
  const sv = await act('portal_natural', { mode: 'survey', radius: 128 })
  const best = sv.detail && [sv.detail.best, ...(sv.detail.sites || [])].find(site => site && site.usable !== false && site.at && !lavaBad(site.at))
  if (!best || !best.at || !state.pos) { log('обзор вдаль: лавы под небом в 128 бл. не видно'); return null }
  const far = q => Math.hypot(q.x - state.pos.x, q.z - state.pos.z)
  if (!known.lava || far(best.at) + 8 < far(known.lava) || !lavaSourceKnown) {
    known.lava = { x: best.at.x, y: best.at.y, z: best.at.z }
    lavaSourceKnown = true
    const at = `${best.at.x},${best.at.y},${best.at.z}`
    log(`обзор вдаль: лава под небом ${best.kind} ${at} (${best.dist} бл., открытых ${best.open}) — запомнил`)
    try { await call('remember', { kind: 'лава', text: `лава на ${at}`, place: 'лава' }) } catch {}
  }
  return best
}
let lavaSourceKnown = false
const castSiteFails = new Map()
const lavaBadSites = []
const lavaBad = q => lavaBadSites.some(b => Math.hypot(b.x - q.x, b.z - q.z) < 24)
// Руины портала, увиденные по пути (память построек — глаза): у руин часто лава (portal_2/7/8/10 и giant — 15–26 источников,
// research/07), огниво и обсидиан. cl-o 14.10: сундук руин взят на 4-й мин, озеро у них не замечено, литьё искало за 300 бл.
// К ближним руинам (≤ 400 бл.) один раз — и осмотреться оттуда, прежде чем искать вслепую.
let ruinsLavaTried = false
async function lavaAtSeenRuins () {
  if (lavaSourceKnown || ruinsLavaTried || dim() !== 'overworld' || !state.pos) return false
  const list = ((await act('structure', { mode: 'list' })).detail?.known || []).filter(e => e && e.kind === 'ruined_portal' && e.at && Number.isFinite(e.at.x))
  const far = e => Math.hypot(e.at.x - state.pos.x, e.at.z - state.pos.z)
  const rp = list.sort((a, b) => far(a) - far(b))[0]
  if (!rp || far(rp) > 400) return false
  ruinsLavaTried = true
  log(`к руинам портала ${rp.at.x},${rp.at.z} (${Math.round(far(rp))} бл.) — у руин бывает лава`)
  await goToward(rp.at, 8)
  if (died) return false
  skyLookAt = null
  await skyLavaLook()
  if (!lavaSourceKnown) await act('observe', { radius: 32 })
  return lavaSourceKnown
}
async function surfaceLavaSurvey () {
  if (process.env.ND_OW_SURVEY === '0' || !NATURAL || surveyDone) return
  surveyDone = true
  await sense()
  if (!sit.surface || sit.night || dim() !== 'overworld') return
  const y0 = y()
  const up = await act('tunnel', { direction: 'up', length: 10, timeoutSeconds: 25 })
  const climbed = Math.round(y() - y0)
  const sv = await act('portal_natural', { mode: 'survey', radius: 128 })
  const best = sv.detail && sv.detail.best
  if (best && best.at && /surface|rp/.test(best.kind || '')) {
    skyLavaSeen = { ...best.at, kind: best.kind, open: best.open }
    log(`обзор со столба: лава под небом ${best.kind} ${best.at.x},${best.at.y},${best.at.z} (${best.dist} бл., открытых ${best.open}) — литьё будет у неё`)
  } else log(`обзор со столба (+${climbed}): лавы под небом в 128 бл. не видно${(up.detail && up.detail.stopped) ? ' (' + String(up.detail.stopped).slice(0, 60) + ')' : ''}`)
  if (climbed > 0) await act('tunnel', { direction: 'down', length: climbed, timeoutSeconds: 30 })
}
async function toShaftColumn (S) {
  for (let k = 0; k < 3 && !died; k++) {
    await refresh()
    if (!state.pos) return
    const dx = S.x - Math.floor(state.pos.x)
    const dz = S.z - Math.floor(state.pos.z)
    if (!dx && !dz) return
    const xFirst = Math.abs(dx) >= Math.abs(dz)
    for (const ax of xFirst ? ['x', 'z'] : ['z', 'x']) {
      await refresh()
      const d = ax === 'x' ? S.x - Math.floor(state.pos.x) : S.z - Math.floor(state.pos.z)
      if (!d) continue
      await act('tunnel', { direction: ax === 'x' ? (d > 0 ? 'east' : 'west') : (d > 0 ? 'south' : 'north'), length: Math.abs(d), torchEvery: 0, timeoutSeconds: 60 })
      if (died) return
    }
  }
}
async function climbOwnShaft (why) {
  const S = surfaceShaft
  if (!S || !state.pos || Math.hypot(S.x - state.pos.x, S.z - state.pos.z) > 64 || Math.abs(y() - S.bottom) > 3) return false
  if (have(COBBLE) + have(/^(dirt|andesite|diorite|granite|tuff|cobbled_deepslate)$/) < S.top - y() + 4) { log(`${why}: на подъём колодцем не хватит блоков`); return false }
  log(`${why}: поднимаюсь своим колодцем ${S.x},${S.z} (${Math.round(y())} → ${S.top})`)
  await toShaftColumn(S)
  await refresh()
  if (!state.pos || Math.floor(state.pos.x) !== S.x || Math.floor(state.pos.z) !== S.z) { log(`${why}: до низа колодца не дошёл`); surfaceShaft = null; return false }
  const up = await act('tunnel', { direction: 'up', length: 96, toY: S.top, timeoutSeconds: 150 })
  await refresh()
  surfaceShaft = null
  if (died || y() < S.top - 2) { log(`${why}: подъём встал на y ${Math.round(y())} (${String((up.detail && up.detail.stopped) || up.error || '').slice(0, 80)})`); return false }
  return true
}
async function naturalCast () {
  if (!NATURAL || !skyLavaSeen || naturalTried >= 1 || known.portal) return false
  naturalTried++
  await sense()
  if (!sit.surface && y() < 50) {
    if (!(await climbOwnShaft('литьё поверху'))) {
      for (let k = 0; k < 3 && !died; k++) {
        await act('surface', { timeoutSeconds: 150, hand: false, preferPillar: true })
        await sense()
        if (sit.surface) break
      }
      if (!sit.surface) { log('литьё поверху: наверх не поднялся — литьё глубоко'); return false }
    }
  }
  const L = skyLavaSeen
  log(`литьё поверху: к лаве ${L.x},${L.y},${L.z}${L.hint ? ' (карта копии мира)' : ' (видел со столба)'}`)
  const r = await act('portal_natural', { mode: 'run', hint: { x: L.x, y: L.y, z: L.z }, legs: 0, pillar: 10, timeoutSeconds: 480 })
  await readMemory()
  if (known.portal) return true
  log(`литьё поверху не вышло (${String((r.detail && (r.detail.stopped || r.detail.why)) || r.error || '').slice(0, 120)}) — литьё глубоко`)
  return false
}

let heardLava = null
// S8d: до берега по горизонтали — лучи глаз (perceive surface) вниз-вбок по 8 сторонам: первая непрозрачная клетка, к которой
// луч шёл не сквозь воду, — суша. Нет такой в 24 бл. — 20.
async function shoreDistance () {
  let best = 20
  for (let yaw = 0; yaw < 360; yaw += 45) {
    try {
      const r: any = await call('perceive', { mode: 'surface', yaw, pitch: 35, maxDist: 24 })
      acceptResult(r)
      const s = r && r.detail && r.detail.surface
      // Берег — пол не выше ног (на него выйти), а не стенка ямы на уровне головы (s8d-a-v1-1: в своей лесенке с водой стенки в
      // 1 бл. считались берегом — «выйти 2 с», копка запрещалась, тело утонуло).
      const feetY = state.pos ? Math.floor(state.pos.y) : 0
      if (s && !s.water && s.pos && s.pos.y <= feetY && !/water|ice|kelp|seagrass/.test(String(s.name))) best = Math.min(best, Math.round(s.dist * Math.cos(35 * Math.PI / 180)))
    } catch {}
  }
  return best
}
// S8d (замечание проверки S8c «а», аудит S10 №13): «лава у/на x,y,z» в строке стопа колодца/лесенки/штрека — чутьё безопасности
// (hazardAt смотрит сквозь камень и может только ОТКАЗАТЬ копать). Целью литья и known.lava такая клетка становится, только если
// лаву видно (память глаз: увиденная клетка лавы в 3 бл.) или слышно (heardLava: место слуха не дальше услышанной дальности + 6).
// На уровне знания scan и при ND_HONEST_LAVA=0 — как было (клетка из строки).
async function stopLava (r) {
  const m = /лава (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String((r && r.detail && r.detail.stopped) || ''))
  if (!m) return null
  const q = { x: +m[1], y: +m[2], z: +m[3] }
  let level = 'rsg'
  try { level = require('./src/perception/knowledge').level() } catch {}
  if (process.env.ND_HONEST_LAVA === '0' || level === 'scan') return q
  try {
    const s: any = await call('perceive', { mode: 'seen', block: 'lava', max: 1, maxDist: 3, from: q })
    acceptResult(s)
    const c = s && s.detail && Array.isArray(s.detail.seen) && s.detail.seen[0]
    if (c) return { x: c.x, y: c.y, z: c.z }
  } catch {}
  const H = heardLava
  if (H && H.from && gameClock.now() - H.t < 5 * 60000 && Math.hypot(H.from.x - q.x, H.from.y - q.y, H.from.z - q.z) <= (H.dist || 8) + 6) return q
  log(`чутьё: лава за блоком у ${q.x},${q.y},${q.z} — не видна и не слышна, целью не беру`)
  return null
}
async function listenForLava (where) {
  if (heardLava && gameClock.now() - heardLava.t < 20 * 60000 && near3(heardLava.from, 32)) return
  const h = await act('portal', { mode: 'cast', listen: 16, timeoutSeconds: 30 })
  const heard = h.detail && Array.isArray(h.detail.heard) && h.detail.heard[0]
  if (!heard || !state.pos) return
  heardLava = { ...heard, from: { x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z) }, t: gameClock.now() }
  log(`слышу лаву (${where}): ${heard.dir}, ~${heard.dist} бл., высота ${heard.height ?? '?'} — запомнил для литья`)
}
async function toHeardLava () {
  const H = heardLava
  heardLava = null
  if (!H || !state.pos || gameClock.now() - H.t > 30 * 60000 || !near3(H.from, 96)) return null
  log(`литьё: к лаве, услышанной у ${H.from.x},${H.from.y},${H.from.z} (${H.dir}, ~${H.dist} бл.)`)
  if (!near3(H.from, 3)) await act('goto', { x: H.from.x, y: H.from.y, z: H.from.z, range: 2, timeoutSeconds: 90 })
  if (died || !near3(H.from, 6)) return null
  const v = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }[H.dir] || [0, 0]
  const flat = H.flat || 0
  const dy = Number.isFinite(H.height) ? H.height : 0
  const T = { x: Math.round(state.pos.x + v[0] * flat), y: Math.round(state.pos.y + 1.62 + dy), z: Math.round(state.pos.z + v[1] * flat) }
  if (Math.abs(dy) <= 2) {
    const t = await act('tunnel', { direction: H.dir, length: Math.max(3, Math.min(20, flat + 2)), torchEvery: 0, timeoutSeconds: 120 })
    const lv = /лава на (-?\d+),(-?\d+),(-?\d+)/.exec(String((t.detail && t.detail.stopped) || ''))
    if (lv) return { x: +lv[1], y: +lv[2], z: +lv[3] }
  } else {
    await act('goto', { x: T.x, y: T.y + 1, z: T.z, range: 3, timeoutSeconds: 60 })
  }
  if (died) return null
  const o = await act('observe', { radius: 32 })
  const sv = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
  if (sv && !cavesFoes(o)) return sv.nearest
  return null
}
async function deepCast () {
  if (deepLava && !near3(deepLava, 48)) deepLava = null
  if (!deepLava && heardLava) {
    const lv = await toHeardLava()
    if (died) return
    if (lv && !deepBad.some(b => Math.hypot(b.x - lv.x, b.y - lv.y, b.z - lv.z) < 6)) { deepLava = lv; log(`литьё: лава по слуху у ${lv.x},${lv.y},${lv.z} — лью здесь, без спуска к ${DEEP_Y}`) }
  }
  for (let k = 0; k < 3 && !deepLava && y() > DEEP_Y + 3 && !died; k++) {
    log(`литьё глубоко: ${k ? 'спуск ещё раз' : 'лавы поверху не вижу'} — вниз к ${DEEP_Y} (водоносная лава ниже −54)`)
    await descend(DEEP_Y, { stopAtLava: true })
    if (descendLava) deepLava = descendLava
    if (y() <= DEEP_Y + 12) break
  }
  if (died) return
  if (!deepLava && known.lava && near3(known.lava, 10) && !deepBad.some(q => Math.hypot(q.x - known.lava.x, q.y - known.lava.y, q.z - known.lava.z) < 6)) deepLava = known.lava
  if (!deepLava && y() > DEEP_Y && y() <= DEEP_Y + 12) {
    const d = await act('dig_down', { mode: 'stairs', depth: Math.round(y() - DEEP_Y), torchEvery: 0, timeoutSeconds: 120 })
    const lv = await stopLava(d)
    if (lv) deepLava = lv
  }
  if (died) return
  if (!deepLava && y() > DEEP_Y + 12) { log(`литьё глубоко: спуск встал на y ${Math.round(y())}`); return }
  if (deepLava && !near3(deepLava, 6)) {
    log(`литьё глубоко: к известной лаве ${deepLava.x},${deepLava.y},${deepLava.z}`)
    await act('goto', { x: deepLava.x, y: deepLava.y + 1, z: deepLava.z, range: 3, timeoutSeconds: 90 })
    if (!near3(deepLava, 8)) { deepBad.push(deepLava); deepLava = null }
  }
  const dirs = ['north', 'east', 'south', 'west']
  let dir = Math.floor(Math.random() * 4)
  let cobbleTried = false
  let lastHeard = null
  let hearOff = 0
  let upTried = 0
  for (let i = 0; i < 10 && !known.portal && !died; i++) {
    await recoverGuard()
    if (died) return
    await unclutter()
    await spares(200)
    if (deepLava && near3(deepLava, 8)) {
      if (!have('water_bucket') && have(/^bucket$/)) {
        const lavaKeep = deepLava
        log('литьё глубоко: лава рядом, ведро воды пустое — вода штреками отсюда')
        await deepWater()
        if (died) return
        if (!have('water_bucket')) {
          waterDeepFailAt = gameClock.now()
          log('литьё глубоко: воды у дна не нашёл — заход кончаю, без повторных штреков')
          return
        }
        if (!near3(lavaKeep, 8)) await act('goto', { x: lavaKeep.x, y: lavaKeep.y + 1, z: lavaKeep.z, range: 3, timeoutSeconds: 90 })
        deepLava = lavaKeep
      }
      const r = await castForKit({ mode: 'cast', windows: true, hint: deepLava, maxDig: 64, keep: 8, radius: 12, timeoutSeconds: 540 })
      await readMemory()
      if (known.portal || died) return
      const why = String((r.detail && r.detail.stopped) || r.error || '')
      const needWhat = String((r.detail && r.detail.need && r.detail.need.what) || '')
      if (/cobblestone|stone/.test(needWhat) && !cobbleTried) {
        cobbleTried = true
        await act('tunnel', { direction: dirs[(dir + 2) % 4], length: 8, torchEvery: 0, timeoutSeconds: 90 })
        continue
      }
      if (r.detail && r.detail.need) { log(`литьё глубоко: не хватает ${JSON.stringify(r.detail.need)}`); return }
      if (/не вижу лавы|места под раму|места на берегу нет|лава далеко|расчистить место/.test(why)) {
        log(`литьё глубоко: у лавы ${deepLava.x},${deepLava.y},${deepLava.z} не вышло (${why.slice(0, 120)}) — штрек дальше`)
        deepBad.push(deepLava)
        deepLava = null
        dir = (dir + 1) % 4
      }
      continue
    }
    deepLava = null
    if (y() > DEEP_Y && y() <= DEEP_Y + 6) await act('dig_down', { mode: 'stairs', depth: Math.round(y() - DEEP_Y), torchEvery: 0, timeoutSeconds: 90 })
    if (y() < DEEP_Y - 0.5) await act('tunnel', { direction: 'up', length: 8, toY: DEEP_Y, timeoutSeconds: 40 })
    if (died) return
    let len = 32
    if (OW_HEAR && hearOff > 0) hearOff--
    else if (OW_HEAR) {
      const h = await act('portal', { mode: 'cast', listen: 16, timeoutSeconds: 30 })
      let heard = h.detail && Array.isArray(h.detail.heard) && h.detail.heard[0]
      const OPP = { east: 'west', west: 'east', north: 'south', south: 'north' }
      const flip = heard && lastHeard && OPP[lastHeard.dir] === heard.dir && near3(lastHeard.at, 16)
      if (heard && (heard.above || flip) && upTried < 2 && state.pos) {
        upTried++
        const v = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }[heard.dir]
        const flat = heard.flat || 0
        const dy = Number.isFinite(heard.height) ? heard.height : (heard.below ? -1 : 1) * Math.round(Math.sqrt(Math.max(0, (heard.dist || 0) ** 2 - flat ** 2)))
        const T = { x: Math.round(state.pos.x + v[0] * flat), y: Math.round(state.pos.y + 1.62 + dy), z: Math.round(state.pos.z + v[1] * flat) }
        log(`литьё глубоко: слышу лаву ${heard.dir}, ~${heard.dist} бл.${heard.above ? ', выше' : heard.below ? ', ниже' : ''}${flip ? ' (сторона сменилась — она между концами штрека)' : ''} — к ней ~${T.x},${T.y},${T.z}`)
        await act('goto', { x: T.x, y: T.y + 1, z: T.z, range: 3, timeoutSeconds: 45 })
        if (died) return
        const o2 = await act('observe', { radius: 32 })
        const sv = (Array.isArray(o2.detail && o2.detail.blocks) ? o2.detail.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
        if (sv && !cavesFoes(o2) && !deepBad.some(b => Math.hypot(b.x - sv.nearest.x, b.y - sv.nearest.y, b.z - sv.nearest.z) < 6)) {
          deepLava = sv.nearest
          log(`литьё глубоко: вижу лаву ${deepLava.x},${deepLava.y},${deepLava.z} (по слуху)`)
          continue
        }
        log('литьё глубоко: по слуху не дошёл/не увидел — слух молчит два штрека, штрек в новую сторону')
        hearOff = 2
        lastHeard = null
        dir = (dirs.indexOf(heard.dir) + 1) % 4
        heard = null
        if (y() > DEEP_Y && y() <= DEEP_Y + 12) await act('dig_down', { mode: 'stairs', depth: Math.round(y() - DEEP_Y), torchEvery: 0, timeoutSeconds: 90 })
      }
      else if (heard && (heard.above || flip)) {
        hearOff = 2
        lastHeard = null
        dir = (dirs.indexOf(heard.dir) + 1) % 4
        heard = null
      }
      if (heard) lastHeard = { dir: heard.dir, at: { ...state.pos } }
      if (heard) {
        dir = dirs.indexOf(heard.dir)
        len = Math.max(4, Math.min(32, (heard.flat || 0) + 3))
        log(`литьё глубоко: слышу лаву — ${heard.dir}, ~${heard.dist} бл.${heard.below ? ', ниже' : heard.above ? ', выше' : ''}`)
        if (heard.below && (heard.flat || 0) <= 2 && y() > DEEP_Y + 0.5) {
          const sh = await act('tunnel', { direction: 'down', length: Math.max(1, Math.min(8, heard.dist + 1, Math.floor(y() - DEEP_Y))), timeoutSeconds: 60 })
          const lv = await stopLava(sh)
          if (lv) { deepLava = lv; log(`литьё глубоко: колодец встал у лавы ${lv.x},${lv.y},${lv.z}`); continue }
        }
        if (heard.below && (heard.flat || 0) > 2 && y() > DEEP_Y + 1.5) {
          const dy = Number.isFinite(heard.height) ? Math.abs(heard.height) : Math.round(Math.sqrt(Math.max(0, (heard.dist || 0) ** 2 - (heard.flat || 0) ** 2)))
          const st = await act('dig_down', { mode: 'stairs', depth: Math.max(1, Math.min(8, dy + 1, Math.floor(y() - DEEP_Y))), direction: heard.dir, torchEvery: 0, timeoutSeconds: 120 })
          const lv = await stopLava(st)
          if (lv) { deepLava = lv; log(`литьё глубоко: лесенка встала у лавы ${lv.x},${lv.y},${lv.z}`); continue }
        }
      }
    }
    const t = await act('tunnel', { direction: dirs[dir], length: len, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    if (died) return
    if (await mobInTheWay(t)) continue
    const why = String((t.detail && t.detail.stopped) || t.error || '')
    if (t.status === 'failed' && !((t.detail && t.detail.walked) > 0)) { log(`литьё глубоко: штрек на ${dirs[dir]} не идёт (${why.slice(0, 80)}) — поворачиваю`); dir = (dir + 1) % 4; hearOff = Math.max(hearOff, 1); lastHeard = null; continue }
    const p = /лава на (-?\d+),(-?\d+),(-?\d+)/.test(why) ? await stopLava(t) : null
    if (p) {
      if (!deepBad.some(b => Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) < 6)) { deepLava = p; log(`литьё глубоко: штрек встал у лавы ${p.x},${p.y},${p.z}`); continue }
    }
    const wetHere = /вода на (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    if (wetHere && !have('water_bucket') && have(/^bucket$/)) {
      await act('portal', { mode: 'cast', waterHint: { x: +wetHere[1], y: +wetHere[2], z: +wetHere[3] }, timeoutSeconds: 120 })
      if (have('water_bucket')) log(`литьё глубоко: вода у штрека ${wetHere[1]},${wetHere[2]},${wetHere[3]} — ведро полное`)
    }
    if (t.detail && t.detail.stopped && !(t.detail.walked > 0) && !(t.detail.dug > 0)) { dir = (dir + 1) % 4; hearOff = Math.max(hearOff, 1); lastHeard = null; continue }
    if (!lighter() && !have('flint')) await act('mine', { block: 'gravel', dry: true, count: 6, radius: 16, timeoutSeconds: 45 })
    if (!lighter() && have('flint') && have('iron_ingot')) await craft('flint_and_steel')
    const o = await act('observe', { radius: 48 })
    const seen = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
    if (seen && cavesFoes(o)) log(`литьё глубоко: лава ${seen.nearest.x},${seen.nearest.y},${seen.nearest.z} видна, но рядом ${cavesFoes(o)} — мимо`)
    if (seen && !cavesFoes(o) && !deepBad.some(b => Math.hypot(b.x - seen.nearest.x, b.y - seen.nearest.y, b.z - seen.nearest.z) < 6)) {
      deepLava = seen.nearest
      log(`литьё глубоко: вижу лаву ${deepLava.x},${deepLava.y},${deepLava.z}`)
      if (!near3(deepLava, 8)) await act('goto', { x: deepLava.x, y: deepLava.y + 1, z: deepLava.z, range: 4, timeoutSeconds: 90 })
      if (!near3(deepLava, 10)) { log('литьё глубоко: к видимой лаве не дошёл — штрек дальше'); deepBad.push(deepLava); deepLava = null }
      continue
    }
    if (why) dir = (dir + 1) % 4
  }
}

let waterDeepFails = 0
let surfaceShaft = null // колодец глубокого пути от поверхности одной колонной: { x, z, top, bottom }
let shaftWaterSeen = null // вода, видная с устья этого колодца перед спуском
let waterDeepFailAt = 0 // глубокий путь: вода штреками не нашлась — этап воды ждёт, вода — попутно в литье
let knownWater = null // вода под землёй, у которой вставали или которую видели (глубокий путь)
const surfaceShaftNear = () => !!surfaceShaft && !!state.pos && dim() === 'overworld' && Math.hypot(surfaceShaft.x - state.pos.x, surfaceShaft.z - state.pos.z) <= 64 && y() < surfaceShaft.top - 8 && Math.abs(y() - surfaceShaft.bottom) <= 3
async function waterViaShaft () {
  const S = surfaceShaft
  if (!S || have('water_bucket') || !have(/^bucket$/)) return false
  if (have(COBBLE) + have(/^(dirt|andesite|diorite|granite|tuff|cobbled_deepslate)$/) < S.top - S.bottom + 4) { log('вода: на подъём колодцем не хватит блоков'); return false }
  log(`вода: штреками нет — поднимаюсь своим колодцем ${S.x},${S.z} (${S.bottom} → ${S.top}), поверху черпаю`)
  await toShaftColumn(S)
  await refresh()
  if (!state.pos || Math.floor(state.pos.x) !== S.x || Math.floor(state.pos.z) !== S.z) { log('вода: до низа колодца не дошёл'); surfaceShaft = null; return false }
  const up = await act('tunnel', { direction: 'up', length: 96, toY: S.top, timeoutSeconds: 150 })
  if (died) return false
  await refresh()
  if (y() < S.top - 2) { log(`вода: подъём колодцем встал на y ${Math.round(y())} (${String((up.detail && up.detail.stopped) || up.error || '').slice(0, 80)})`); surfaceShaft = null; return false }
  surfaceShaft = null // колонна теперь забита столбом
  await act('bucket', { fluid: 'water', radius: 32 })
  if (!have('water_bucket') && shaftWaterSeen && Math.hypot(shaftWaterSeen.x - state.pos.x, shaftWaterSeen.z - state.pos.z) > 4) {
    await act('goto', { x: shaftWaterSeen.x, z: shaftWaterSeen.z, range: 3, timeoutSeconds: 45, surface: 'strict' })
    await act('bucket', { fluid: 'water', radius: 16 })
  }
  if (!have('water_bucket')) await act('bucket', { fluid: 'water', radius: 32 })
  log(have('water_bucket') ? 'вода: ведро полное (поверху у колодца)' : 'вода: поверху у колодца не набралась')
  return have('water_bucket') > 0
}
async function deepWater ({ legs = 5 } = {}) {
  const dirs = ['north', 'east', 'south', 'west']
  let dir = Math.floor(Math.random() * 4)
  if (knownWater && state.pos && Math.hypot(knownWater.x - state.pos.x, knownWater.y - state.pos.y, knownWater.z - state.pos.z) <= 64) {
    const kw = knownWater
    log(`вода глубоко: к известной ${kw.x},${kw.y},${kw.z}`)
    if (Math.hypot(kw.x - state.pos.x, kw.y - state.pos.y, kw.z - state.pos.z) > 4) await act('goto', { x: kw.x, y: kw.y, z: kw.z, range: 3, timeoutSeconds: 90 })
    await act('bucket', { fluid: 'water', radius: 16 })
    if (!have('water_bucket')) await act('portal', { mode: 'cast', waterHint: kw, timeoutSeconds: 120 })
    if (have('water_bucket')) { log('вода глубоко: ведро полное (известная вода)'); return true }
    knownWater = null
  }
  for (let i = 0; i < legs && !have('water_bucket') && !died; i++) {
    await recoverGuard()
    if (died) return false
    const r = await act('bucket', { fluid: 'water', radius: 32 })
    if (have('water_bucket')) break
    if (r.detail && r.detail.need) return false
    await unclutter()
    await spares(120)
    let len = 32
    if (OW_HEAR) {
      const h = await act('portal', { mode: 'cast', listen: 16, fluid: 'water', timeoutSeconds: 30 })
      const heard = h.detail && Array.isArray(h.detail.heard) && h.detail.heard[0]
      if (heard) { dir = dirs.indexOf(heard.dir); len = Math.max(4, Math.min(32, (heard.flat || 0) + 3)); log(`вода глубоко: слышу ручей — ${heard.dir}, ~${heard.dist} бл.`) }
    }
    const t = await act('tunnel', { direction: dirs[dir], length: len, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    if (died) return false
    if (await mobInTheWay(t)) continue
    if (OW_HEAR && !known.portal) await listenForLava('штрек за водой')
    const why = String((t.detail && t.detail.stopped) || t.error || '')
    const wet = /вода на (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    if (wet) {
      const hint = { x: +wet[1], y: +wet[2], z: +wet[3] }
      let w = await act('portal', { mode: 'cast', waterHint: hint, timeoutSeconds: 120 })
      if (!have('water_bucket') && /не вижу источника/.test(String((w.detail && w.detail.stopped) || ''))) {
        const closer = await act('tunnel', { direction: dirs[dir], length: 3, torchEvery: 0, timeoutSeconds: 60 })
        if (died) return false
        if (((closer.detail && closer.detail.walked) || 0) > 0) w = await act('portal', { mode: 'cast', waterHint: hint, timeoutSeconds: 120 })
      }
      if (have('water_bucket')) { log(`вода глубоко: окно у ${wet[1]},${wet[2]},${wet[3]} — ведро полное`); break }
      log(`вода глубоко: у ${wet[1]},${wet[2]},${wet[3]} не набралась (${String((w.detail && w.detail.stopped) || w.error || '').slice(0, 160)})`)
    }
    const lava = !deepLava && /лава на (-?\d+),(-?\d+),(-?\d+)/.test(why) ? await stopLava(t) : null
    if (lava) deepLava = lava
    if (why) dir = (dir + 1) % 4
  }
  return have('water_bucket') > 0
}

defStage('cast', () => !known.portal, async () => {
  castRuns++
  let surfaceLooks = 0
  await sense()
  if (weakAndHungry()) { log(`хп ${Math.round(state.health ?? 0)} и еды нет — к лаве не иду, сначала охота`); return }
  if (OW_DEEP) {
    await readMemory()
    if (portalBuckets() === 2 && skyLavaSeen && NATURAL && naturalTried < 1) { if (await naturalCast()) return; if (died) return }
    if (!known.lava && sit.surface) await act('observe', { radius: 64 })
    if (!deepLava && known.lava && !sit.surface && near3(known.lava, 48) && !deepBad.some(b => Math.hypot(b.x - known.lava.x, b.y - known.lava.y, b.z - known.lava.z) < 6)) deepLava = known.lava
    if (deepLava || !surfaceLavaNear()) { await deepCast(); return }
  }
  if (!sit.surface && dim() === 'overworld' && !sit.night) await act('shelter', { mode: 'exit' })
  await readMemory()
  await skyLavaLook()
  if (!known.lava) await act('observe', { radius: 48 })
  if (known.lava && state.pos && Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) > 16) await goToward(known.lava, 8)
  await ensureFlint()
  for (let i = 0; i < 6 && !known.portal; i++) {
    await recoverGuard()
    if (died) return
    await sense()
    if (state.playPolicy?.mode !== 'speedrun' && sit.night && sit.surface && dim() === 'overworld') { await nightGuard(); continue }
    await unclutter()
    const r = await castForKit({ mode: 'cast', timeoutSeconds: 540 })
    await readMemory()
    if (known.portal || died) break
    const why = String((r.detail && r.detail.stopped) || r.error || '')
    // Литьё у этого озера не встаёт (лава под навесом, берег из жидкости — cl-ai 14.10: 100 мин «не вижу лавы-источника» и
    // «места на берегу нет» у одной и той же пещерной лавы): после 4 отказов место плохое, ищем другое озеро.
    if (known.lava && state.pos && /не вижу лавы|места на берегу нет|места под раму/.test(why) &&
        Math.hypot(known.lava.x - state.pos.x, (known.lava.y ?? state.pos.y) - state.pos.y, known.lava.z - state.pos.z) <= 12) {
      const key = `${Math.round(known.lava.x / 8)},${Math.round(known.lava.z / 8)}`
      castSiteFails.set(key, (castSiteFails.get(key) || 0) + 1)
      if (castSiteFails.get(key) >= 4) {
        log(`литьё: у лавы ${known.lava.x},${known.lava.y},${known.lava.z} рама не встаёт (4 отказа) — ищу другое озеро`)
        lavaBadSites.push({ ...known.lava })
        known.lava = null; lavaSourceKnown = false; skyLookAt = null
        break
      }
    }
    const needWhat = String((r.detail && r.detail.need && r.detail.need.what) || '')
    if (/cobblestone|stone/.test(needWhat)) {
      const filler = /^(cobblestone|cobbled_deepslate|dirt|stone|deepslate|andesite|diorite|granite|tuff|netherrack|blackstone|basalt|sandstone|red_sandstone)$/
      const want = Number(r.detail.need.count) || 3
      const before = have(filler)
      await act('mine', { block: 'dirt,grass_block,stone,deepslate,andesite,diorite,granite,tuff,sandstone,red_sandstone', count: Math.max(1, want - have(filler)), radius: 32, dry: true, timeoutSeconds: 35 })
      if (have(filler) < want) await act('dig_down', { mode: 'stairs', depth: 8, torchEvery: 0, maxFallHp: 0, timeoutSeconds: 90 })
      if (have(filler) <= before) break
      continue
    }
    if (r.detail && r.detail.need) break
    if (/не вижу лавы/.test(why)) {
      if (known.lava && state.pos && i < 3) {
        const before = { ...state.pos }
        const dx = known.lava.x - before.x
        const dz = known.lava.z - before.z
        const lower = typeof known.lava.y === 'number' && known.lava.y < before.y - 3
        if (lower && Math.hypot(dx, dz) <= 16) {
          const direction = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
          await act('dig_down', { mode: 'stairs', depth: Math.min(12, before.y - known.lava.y - 3), direction, timeoutSeconds: 90, maxFallHp: 0, torchEvery: 0 })
          await act('observe', { radius: 32 })
        } else if (Math.hypot(dx, (known.lava.y ?? y()) - before.y, dz) > 12) await goToward(known.lava, 8)
        // Рядом, но источника не видно (лава выше ног, за краем — cl-i 14.10: в 4.5 бл. «не вижу лавы-источника» и уход):
        // встать у самой лавы на её высоте.
        else await act('goto', { x: known.lava.x, y: known.lava.y, z: known.lava.z, range: 2, timeoutSeconds: 60 })
        if (died) return
        if (['x', 'y', 'z'].some(axis => Math.floor(state.pos[axis]) !== Math.floor(before[axis]))) continue
      }
      if (y() < 0) {
        await spares(120)
        await act('tunnel', { direction: ['north', 'east', 'south', 'west'][i % 4], length: 32, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
        if (!known.lava) await act('observe', { radius: 32 })
        continue
      }
      if (await skyLavaLook()) continue
      if (await lavaAtSeenRuins()) continue
      const e = await act('explore', { block: 'lava', lavaSource: true, radius: 48, stepDistance: 60, timeoutSeconds: 150, surface: true })
      if (e.detail && e.detail.found) continue
      if (++surfaceLooks >= 2 && !known.lava) {
        castSurfaceFailed = true
        log('литьё: поверху лавы нет (обзор и две разведки) — запасной путь: железная кирка, алмазы, обсидиан ведром у лавы глубоко')
        return
      }
      continue
    }
    if (/места под раму|места на берегу нет/.test(why)) { await walkAway(12, Math.PI / 2, y()); continue }
  }
})

defStage('diamond', () => !have(PICK_DIAMOND) && !known.portal, async () => {
  if (y() > -55) await descend(-57)
  if (died) return
  await lightUp()
  const dirs = ['north', 'east', 'south', 'west']
  for (let i = 0; i < 14 && have('diamond') < 3; i++) {
    await recoverGuard()
    if (died) return
    await unclutter()
    await spares()
    const t = await act('tunnel', { direction: dirs[i % 4], length: 40, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 360 })
    await mineSeenAll('deepslate_diamond_ore,diamond_ore', 48)
    if (!known.lava && !known.portal) await act('observe', { radius: 32 })
    await act('mine', { block: 'deepslate_diamond_ore,diamond_ore', count: 6, radius: 32, timeoutSeconds: 180 })
    if (have('raw_iron') + have('iron_ingot') < 8) await mineSeenAll('deepslate_iron_ore,iron_ore', 24)
    if (have(/^(raw_gold|gold_ingot)$/) < 5) await mineSeenAll('deepslate_gold_ore,gold_ore', 24)
    await torches()
    if (t.detail && t.detail.need) break
  }
  if (have('diamond') >= 3) {
    await sticks(2)
    await craft('diamond_pickaxe')
  }
})

defStage('obsidian', () => have('obsidian') < 10 && !known.portal, async () => {
  if (have(/^raw_(iron|gold)$/) >= 3 && have(/^bucket$/) >= 1) {
    await act('bucket', { fluid: 'lava', radius: 24 })
    await smeltAll('raw_iron', 'iron_ingot')
    await smeltAll('raw_gold', 'gold_ingot')
    await spendIron()
  }
  for (let i = 0; i < 8 && have('obsidian') < 10; i++) {
    await recoverGuard()
    if (died) return
    const r = await act('obsidian', { count: 10 - have('obsidian'), radius: 24, timeoutSeconds: 300 })
    if (have('obsidian') >= 10) break
    const why = String((r.detail && r.detail.stopped) || r.error || '')
    if (r.detail && r.detail.need && r.detail.need.what === 'water_bucket') break
    if (r.detail && r.detail.need && /pickaxe/.test(r.detail.need.what)) break
    if (/лав/.test(why) || /не вижу/.test(why) || !(r.detail && r.detail.got)) {
      await unclutter()
      await act('tunnel', { direction: ['north', 'east', 'south', 'west'][i % 4], length: 32, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    }
  }
})

defStage('portal', () => !known.portal, async () => {
  if (have('obsidian') < 10) throw new Error(`обсидиана ${have('obsidian')} из 10`)
  if (!have('flint_and_steel') && !have('fire_charge')) {
    for (let i = 0; i < 4 && !have('flint'); i++) {
      const g = await act('mine', { block: 'gravel', dry: true, count: 6, radius: 32, timeoutSeconds: 150 })
      if (!(g.detail && g.detail.dug)) break
    }
    if (have('flint') && have('iron_ingot')) await craft('flint_and_steel')
  }
  await toSurface()
  await nightGuard()
  if (!have('flint_and_steel') && !have('fire_charge')) {
    for (let i = 0; i < 4 && !have('flint'); i++) {
      const g = await act('mine', { block: 'gravel', dry: true, count: 6, radius: 32, timeoutSeconds: 150 })
      if (!(g.detail && g.detail.dug)) await act('explore', { block: 'gravel', dry: true, radius: 48, stepDistance: 60, timeoutSeconds: 120 })
    }
    if (have('flint') && have('iron_ingot')) await craft('flint_and_steel')
  }
  const r = await act('portal', { mode: 'build', timeoutSeconds: 300 })
  if (r.detail && r.detail.lit) await readMemory()
})

const ROUTE = process.env.ND_ROUTE === '1'
const routeMod = (() => { try { return require('./src/route') } catch (e) { return null } })()
let routeInfoV
let routeDone = false
let routeT0 = 0
let routeStructureSeconds = 0
const routeAvoid = new Set()
const routeDoneIds = new Set(String(process.env.ND_ROUTE_SKIP || '').split(',').map(x => x.trim()).filter(Boolean))
const routeFails = new Map()
function routeInfoGet (...args) { return routeSkills.routeInfoGet(...args) }
const rlog = line => log(`МАРШРУТ ${line}`)
const fillerCount = () => have(/^(cobblestone|cobbled_deepslate|dirt|stone|deepslate|andesite|diorite|granite|tuff|netherrack|blackstone|basalt|sandstone|red_sandstone)$/)
async function routeGo (...args) { return routeSkills.routeGo(...args) }
function routeShaftBackOn (...args) { return routeSkills.routeShaftBackOn(...args) }
function routeRememberShaft (...args) { return routeSkills.routeRememberShaft(...args) }
async function routeFurnaceSupply (...args) { return routeSkills.routeFurnaceSupply(...args) }
async function routeReturnShaft (...args) { return routeSkills.routeReturnShaft(...args) }
async function routeGoPush (...args) { return routeSkills.routeGoPush(...args) }
function routeBlockTarget (...args) { return routeSkills.routeBlockTarget(...args) }
async function routeBlocks (...args) { return routeSkills.routeBlocks(...args) }
const ROUTE_COOKED_HUNGER = { cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6,
  cooked_chicken: 6, cooked_salmon: 6, cooked_cod: 5, cooked_rabbit: 5,
  bread: 5, baked_potato: 5, golden_carrot: 6 }
function routeCookedHunger (...args) { return routeSkills.routeCookedHunger(...args) }
function routeCookHunger (...args) { return routeSkills.routeCookHunger(...args) }
async function routeFood (...args) { return routeSkills.routeFood(...args) }
async function routeHunt (...args) { return routeSkills.routeHunt(...args) }
async function routeWater (...args) { return routeSkills.routeWater(...args) }
async function castOneAt (...args) { return routeSkills.castOneAt(...args) }
const ROUTE_SLEEP = process.env.ND_ROUTE_SLEEP !== '0'
const BED_BLOCKS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(c => `${c}_bed`).join(',')
const todNow = () => (Number.isFinite(sit.tod) ? sit.tod : null)
const nightNow = () => { const t = todNow(); return t === null ? !!sit.night : (t >= 12542 && t <= 23459) }
let routeSleptAt = 0
let routeSleeping = false
async function routeSleep (...args) { return routeSkills.routeSleep(...args) }
let routeBedTries = 0
async function routeBedLate (...args) { return routeSkills.routeBedLate(...args) }
async function routeLeaveOutpost (...args) { return routeSkills.routeLeaveOutpost(...args) }
async function routeAroundOutpost (...args) { return routeSkills.routeAroundOutpost(...args) }
let routeEntered = false
async function routeFlintFromBag (...args) { return routeSkills.routeFlintFromBag(...args) }
let routeFrame = null
let routeDeadline = 0
let routeStepNow = null // id текущего шага плана маршрута — для телеметрии вызовов внутри шага
let routeHealing = false
async function routeRecover (...args) { return routeSkills.routeRecover(...args) }
async function routeHealToEnter (...args) { return routeSkills.routeHealToEnter(...args) }
async function routeStep (...args) { return routeSkills.routeStep(...args) }
defStage('route', () => ROUTE && !routeDone && dim() === 'overworld' && (!known.portal || !routeDoneIds.has('enter')) && !!routeInfoGet(), async () => {
  if (!routeT0) routeT0 = gameClock.now()
  let first = true
  for (let round = 0; round < 24 && !died && dim() === 'overworld'; round++) {
    await refresh()
    await routeSleep('перед шагом')
    await routeBedLate()
    if (died) break
    // Вслепую — план из увиденного (S8c): осмотр построек/лавы перед шагом, info каждый раунд заново.
    await routeSkills.routeSeenRefresh()
    const info = routeInfoGet()
    if (!info) break
    await sense()
    const elapsed = todNow() !== null ? Math.max(0, Math.round((todNow() - 1000) / 20)) : Math.round((gameClock.now() - routeT0) / 1000)
    const p = routeMod.plan(info, { from: state.pos, fromY: state.pos ? state.pos.y : undefined, have: state.inventory || {}, avoid: routeAvoid, done: routeDoneIds, portal: !!known.portal, elapsed, structureSeconds: routeStructureSeconds, frame: known.portal ? null : routeFrame })
    if (first) { rlog(routeMod.describe(p)); first = false }
    const s = p.steps.find(x => !routeDoneIds.has(x.id))
    if (!s) break
    const t0 = gameClock.now()
    let ok: any = false
    const telStepWall = gameClock.wall.now()
    const telStep = telemetry.on() ? telemetry.snapshot(state, sit) : null
    let telErr = null
    // Долгий переход почти без блоков: путь pathfinder'а с мостом/столбом, а ставить нечем — «блок под ноги не ставится» ×6 и
    // минуты в горах (s8b-a1-11: кремень 250 + 264 с, dirt×1). По умолчанию ВЫКЛ. (ND_ROUTE_WALKBLOCKS=1 — вкл.): в s8b-b2 добор
    // стоил 18 с на прогон (15 вызовов по ~19 с) при пользе ~9 с на прогон — дороже, чем помогает.
    if (s.at && state.pos && Math.hypot(s.at.x - state.pos.x, s.at.z - state.pos.z) > 48 && fillerCount() < 6 && have(/_pickaxe$/) && !died && process.env.ND_ROUTE_WALKBLOCKS === '1') {
      try { await routeBlocks(8) } catch (e) { if (e.stopCampaign || manualControl || e.strategyInterrupted) throw e }
    }
    routeStepNow = s.id
    rlog(`шаг ${s.id}: ${s.why || ''} (бюджет ${s.budget} с)`)
    routeDeadline = gameClock.now() + (/^(wood|stone)$/.test(s.kind) ?
      (process.env.ND_ROUTE_BOOTSTRAP_LIMIT === '1' && process.env.ND_ROUTE_DEADLINE !== '0' ? Math.min(300, Math.max(150, (s.budget || 60) * 2)) : 600) :
      Math.max(150, (s.budget || 60) * 3)) * 1000
    const structureStep = /^(ruin|village|treasure|ship)$/.test(s.kind)
    // Остаток бюджета построек — из плана (S8c: без руды по карте он равен цене копки, а не 180 с).
    const structureLeft = Number.isFinite(p.structureBudgetSeconds) ? p.structureBudgetSeconds : routeMod.structureSearchLeft(routeStructureSeconds)
    if (structureStep && Number.isFinite(structureLeft)) {
      routeDeadline = Math.min(routeDeadline, gameClock.now() + structureLeft * 1000)
      rlog(`постройки: использовано ${Math.round(routeStructureSeconds)} с, осталось ${Math.floor(structureLeft)} с; затем руда`)
    }
    try { ok = await routeStep(s) } catch (e) {
      routeDeadline = 0
      telErr = String(e.message).slice(0, 240)
      // S8d: срыв тактикой бывает и исключением (граф: «навык прерван») — тот же счёт срывов шага (s8d-d-v1-1: «пещера» ×10 за 10 мин,
      // каждый раз заново колодец — счёт ниже по циклу его не видел).
      if (e.strategyInterrupted && !died && !manualControl) {
        const nInt = (routeFails.get(`int:${s.id}`) || 0) + 1
        routeFails.set(`int:${s.id}`, nInt)
        if (routeMod.interruptCap(s.kind, nInt, Number(process.env.ND_ROUTE_INTERRUPT_MAX ?? 3))) {
          rlog(`шаг ${s.id} сорван тактикой ${nInt}-й раз — считаю провалом`)
          routeMod.bookStep(s.id, false, { done: routeDoneIds, fails: routeFails, avoid: routeAvoid })
          routeMod.bookStep(s.id, false, { done: routeDoneIds, fails: routeFails, avoid: routeAvoid })
        }
      }
      if (e.stopCampaign || manualControl || e.strategyInterrupted) throw e
      rlog(`шаг ${s.id} упал: ${e.message}`)
      if (e.routeUnsafe && !died) {
        const n = (routeFails.get('unsafe!') || 0) + 1
        routeFails.set('unsafe!', n)
        if (n <= 4) { await routeRecover(); continue }
      }
      if (/сначала еда/.test(e.message) && !died) {
        try { await stageRun('food')() } catch (e2) { if (e2.stopCampaign || manualControl) throw e2 }
        continue
      }
    } finally {
      if (structureStep) routeStructureSeconds += (gameClock.now() - t0) / 1000
      routeStepNow = null
      if (telStep) {
        const after = telemetry.snapshot(state, sit)
        telemetry.record({ level: 'step', stage, step: s.id, kind: s.kind, budget: s.budget ?? null, cost: s.cost ?? null, why: s.why ? String(s.why).slice(0, 200) : null,
          sec: Math.round((gameClock.now() - t0) / 100) / 10, wallSec: (gameClock.wall.now() - telStepWall) / 1000, ok: ok === true, result: typeof ok === 'string' ? ok : (ok ? 'ok' : 'fail'), error: telErr, death: !!died,
          sinceStart: Math.round((gameClock.now() - routeT0) / 1000), before: telStep, after, gained: telemetry.delta(telStep, after) })
      }
    }
    routeDeadline = 0
    const sec = Math.round((gameClock.now() - t0) / 1000)
    // Шаг сорвала тактика (враги, рефлекс) — это не провал шага: без счёта в avoid, граф перезапустит маршрут после неё
    // (s8-r2-0: два «wood НЕ ВЫШЕЛ» от прерываний зомби на 1-й мин → дерево в avoid → камень с пустым рюкзаком).
    if (!ok && strategyInterrupted && !died) {
      // S8d: тот же шаг сорван тактикой N раз — угроза у места шага постоянная (s8d-a-v1-5: корабль ×9 по 33 с, 5 мин без железа) —
      // шаг в провал (постройка — в avoid), а не бесконечное «жду конца угрозы». ND_ROUTE_INTERRUPT_MAX=0 — прежнее.
      const maxInt = Number(process.env.ND_ROUTE_INTERRUPT_MAX ?? 3)
      const nInt = (routeFails.get(`int:${s.id}`) || 0) + 1
      routeFails.set(`int:${s.id}`, nInt)
      if (!routeMod.interruptCap(s.kind, nInt, maxInt)) { rlog(`шаг ${s.id} прерван тактикой за ${sec} с — не провал, жду конца угрозы`); return }
      rlog(`шаг ${s.id} сорван тактикой ${nInt}-й раз — считаю провалом`)
    }
    if (ok === 'delegate') { rlog(`шаг ${s.id}: дальше обычные этапы (глубокое литьё) — с начала ${Math.round((gameClock.now() - routeT0) / 1000)} с`); break }
    if (ok === 'water') {
      const n = (routeFails.get('water!') || 0) + 1
      routeFails.set('water!', n)
      rlog(`шаг ${s.id}: воды в ведро не нашлось (${n}-й раз) за ${Math.round((gameClock.now() - t0) / 1000)} с`)
      if (n >= 2) break
      continue
    }
    rlog(`шаг ${s.id} ${ok ? 'ok' : 'НЕ ВЫШЕЛ'} за ${sec} с (бюджет ${s.budget} с), с начала ${Math.round((gameClock.now() - routeT0) / 1000)} с; рюкзак: ${bag()}`)
    if (routeMod.bookStep(s.id, ok, { done: routeDoneIds, fails: routeFails, avoid: routeAvoid }) === 'break') { rlog('плавка не вышла трижды — дальше обычные этапы'); break }
    // Пустое ведро, а вода на виду рядом — набрать сейчас, как раннер по пути (s8-r2-2: вода карты у спавна, лава в 230 м в
    // другую сторону — крюк и смерть от утопленника ночью). Воды не видно — ответ сразу. ND_ROUTE_WATERNEAR=0 — выкл.
    if (ok && !died && have(/^bucket$/) && !have('water_bucket') && !have('lava_bucket') && !known.portal && process.env.ND_ROUTE_WATERNEAR !== '0') {
      try { await act('bucket', { fluid: 'water', radius: 12 }) } catch (e) { if (e.stopCampaign || manualControl || e.strategyInterrupted) throw e }
      if (have('water_bucket')) rlog('вода по пути — ведро полное')
    }
    // Еды почти нет, а зверь рядом — взять по пути (≤ 16 бл., ≤ 20 с): шаг еды часто пуст (зверей в 40 нет), а без еды ночью
    // тело не лечится (s8-f1-2: паук, хп 1 «еды нет» до конца прогона). ND_ROUTE_FOODNEAR=0 — выкл.
    // S8c: смерти ночью — хп ≤ 10 без еды (регенерации нет): брать зверя на виду смелее — до 4 единиц еды и в 24 бл.
    // (ND_ROUTE_FOODNEAR2=0 — прежние 3 и 16).
    const foodNear2 = process.env.ND_ROUTE_FOODNEAR2 !== '0'
    if (ok && !died && foodUnits() < (foodNear2 ? 4 : 3) && !known.portal && process.env.ND_ROUTE_FOODNEAR !== '0') {
      try { await routeHunt(foodNear2 ? 24 : 16, foodNear2 ? 25 : 20) } catch (e) { if (e.stopCampaign || manualControl || e.strategyInterrupted) throw e }
    }
    if (s.kind === 'giveup') break
    if (s.kind === 'enter' && ok) break
    if (died) break
  }
  routeDone = true
  rlog(`маршрут кончился: ${dim() === 'the_nether' ? 'в Аду' : known.portal ? 'портал горит' : 'без портала — дальше обычные этапы'}, ${Math.round((gameClock.now() - routeT0) / 1000)} с`)
  if (!died && dim() === 'overworld' && !known.portal && process.env.ND_ROUTE_LAVAEDGE !== '0') {
    try {
      const ob = await act('observe', { radius: 5 })
      const lv = (Array.isArray(ob.detail && ob.detail.blocks) ? ob.detail.blocks : []).find(b => b && b.name === 'lava')
      if (lv && lv.nearest) { rlog(`лава в ${lv.dist ?? '?'} бл. — отхожу от неё перед обычными этапами`); await awayFrom(lv.nearest, 12) }
    } catch (e) { if (e.stopCampaign || manualControl) throw e }
  }
})
{ const i = STAGES.findIndex(x => x.name === 'route'); if (i > 0) STAGES.unshift(STAGES.splice(i, 1)[0]) }
defStage('routeEnter', () => {
  if (dim() === 'the_nether') routeEntered = true
  return ROUTE && routeDone && !routeEntered && !!known.portal && dim() === 'overworld' && !!routeInfoGet() && process.env.ND_ROUTE_ENTER !== '0'
}, async () => {
  await refresh()
  rlog(`портал горит (${known.portal.x},${known.portal.y},${known.portal.z}) — вход сразу; еды ${foodUnits()}, сытость ${state.food ?? '?'}`)
  await routeSleep('у портала')
  await routeFood({ cookRaw: false })
  if (foodUnits() < 2) await quickHunt()
  if (!(await routeHealToEnter())) return
  await enterNether()
  await refresh()
  if (dim() === 'the_nether') routeEntered = true
  else { routeEnterFails++; if (routeEnterFails >= 3) { routeEntered = true; rlog('вход трижды не вышел — дальше обычные этапы') } }
})
let routeEnterFails = 0
{ const i = STAGES.findIndex(x => x.name === 'routeEnter'); if (i > 0) STAGES.unshift(STAGES.splice(i, 1)[0]) }

const rodsNow = () => have('blaze_rod') + Math.floor(have('blaze_powder') / 2) + Math.floor(have('ender_eye') / 2)
const goldOn = () => /golden_(helmet|chestplate|leggings|boots)/.test(JSON.stringify(state.armor || {}))
const shieldOn = () => have('shield') > 0 || /shield/.test(JSON.stringify(state.offHand || ''))
const shieldLow = () => { const o = state.offHand; return !!o && /shield/.test(o.item || '') && (o.durability ?? 100) < 35 }
const spawnAtPortal = () => !!(known.spawnBed && known.portal && Math.hypot(known.spawnBed.x - known.portal.x, known.spawnBed.z - known.portal.z) <= 48)
const stageRun = name => STAGES.find(s => s.name === name).run
let huntWool = false
let wantBeds = 1
let prepRuns = 0
const lighter = () => have('flint_and_steel') > 0 || have('fire_charge') > 0
async function enterNether () {
  if (!lighter()) log('огнива нет и сделать не из чего — вхожу без него (погасший портал = возврат через кровать)')
  await refresh()
  if (known.portal && state.pos && dim() === 'overworld' && state.pos.y < (known.portal.y ?? 64) - 5) {
    log(`к порталу из-под земли (y ${Math.round(state.pos.y)}) — сперва наверх`)
    await act('surface', { timeoutSeconds: 120, hand: false, preferPillar: true })
    await refresh()
    for (let k = 0; k < 3 && !died; k++) if (await goToward(known.portal, 4)) break
  }
  // Дешёвое снаряжение на Ад до входа: щит (слиток + доски) и золото, если есть из чего (cl-ab 14.10: вход на 25-й мин без щита
  // при слитке в рюкзаке — у бастиона «нет брони», у крепости «нет щита», обратно домой через 7 мин).
  if (dim() === 'overworld' && !died) {
    if (!shieldOn() && !have('shield') && have('iron_ingot') >= 1) {
      if (have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
      if (have(/_planks$/) >= 6 && await craft('shield')) await act('armor')
    }
    if (!goldOn() && have('gold_nugget') >= 9) await craft('gold_ingot', Math.floor(have('gold_nugget') / 9))
    if (!goldOn() && have('gold_ingot') >= 4) await wearGold()
  }
  return act('portal', { mode: 'enter', timeoutSeconds: 120, ...(lighter() ? {} : { noIgniter: true }) })
}
defStage('prep', () => !!known.portal && dim() === 'overworld' && rodsNow() < 7 && (prepRuns < 1 || !lighter()) &&
  (!lighter() || foodUnits() < FOOD_STOCK || (!shieldOn() && have('iron_ingot') > 0)), async () => {
  prepRuns++
  await sense()
  if (OW_DEEP && known.portal && near3(known.portal, 48) && lighter() && foodUnits() >= netherFoodNeed()) {
    log(`сборы: портал в ${Math.round(portalFar())} бл., огниво есть, еды ${foodUnits()} — в Ад без сборов`)
    return
  }
  await nightGuard()
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  huntWool = !spawnAtPortal()
  try {
    if (foodUnits() < FOOD_STOCK) await stageRun('food')()
  } finally { huntWool = false }
  await cook()
  await makeBed()
  const ironWant = lighter() ? 0 : 1
  if (ironWant) {
    await refresh()
    for (let k = 0; k < 2 && have('iron_ingot') + have('raw_iron') < ironWant && have('iron_nugget') >= 9; k++) {
      const before = have('iron_ingot')
      await ensureTable()
      await act('craft', { item: 'iron_ingot', count: 1 })
      await refresh()
      if (have('iron_ingot') <= before) break
    }
    if (have('iron_ingot') + have('raw_iron') < ironWant) {
      for (let k = 0; k < 3 && have('iron_ingot') + have('raw_iron') < ironWant && !died; k++) {
        await nightGuard()
        const m = await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: ironWant, radius: 48, timeoutSeconds: 150 })
        if (m.detail && m.detail.dug) continue
        await mineSeenAll('iron_ore,deepslate_iron_ore', 48)
        if (have('iron_ingot') + have('raw_iron') >= ironWant) break
        const e = await act('explore', { block: 'iron_ore', radius: 48, stepDistance: 60, timeoutSeconds: 120 })
        if (!(e.detail && e.detail.found)) break
      }
    }
    await smeltAll('raw_iron', 'iron_ingot')
    if (!lighter()) { await nightGuard(); await ensureFlint() }
  }
  {
    await refresh()
    if (!shieldOn() && have('iron_ingot')) {
      if (have(/_planks$/) < 6 && !have(LOGS)) await lumber(2)
      if (have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
      await craft('shield')
      await act('armor')
    }
  }
  await readMemory()
  if (have(/_bed$/) && !spawnAtPortal() && known.portal) {
    await goToward(known.portal, 6)
    await act('sleep', { mode: 'spawn', why: 'у портала в Ад' })
    await readMemory()
  }
})

const fireResNow = () => { const p = state.potions || {}; return Object.entries(p).filter(([k]) => /fire_resistance$/.test(k)).reduce((n: any, [, v]) => n + v, 0) }
const fireResReady = () => fireResNow() > 0 || state.fireResistance === true || state.tactics?.state?.fireResistance === true
const pearlsNow = () => have('ender_pearl') + have('ender_eye')
const EXIT_KIT = process.env.ND_EXIT_KIT !== '0' && process.env.ND_SH_NETHER === '1'
const exitKitNow = () => require(path.join(__dirname, 'src/nether')).exitKit(state.inventory || {})
let exitFrameTarget = null
const pendingExitFrame = () => !!exitFrameTarget && dim() === 'the_nether' && lighter() && !!state.pos && Math.hypot(state.pos.x - Math.floor(exitFrameTarget.x / 8), state.pos.z - Math.floor(exitFrameTarget.z / 8)) <= 12
// Обсидиан на раму выхода нужен только в Аду: наверху с очами — к крепости, а не обратно в бастион (S5d s5d-p4-1 07.10: после
// выхода у крепости рама съела 10, граф увёл обратно в Ад за обсидианом — 11 игр. мин впустую).
const obsShort = () => !known.endPortal && dim() === 'the_nether' && (EXIT_KIT ? !pendingExitFrame() && !exitKitNow().ready : process.env.ND_OBS_EXIT === '1' && process.env.ND_SH_NETHER === '1' && !have(PICK_DIAMOND) && have('obsidian') < 10)
const EYES_NEED = Math.max(1, Math.min(12, Number(process.env.ND_EYES_NEED) || 12))
// Очей нужно — пустых рамок: после комнаты/частичной вставки — 12 минус уже вставленные (S5e 07.10, s5e-G-1: вставил 7 из 12, fill
// оборвала лава, у тела 7 очей на 5 пустых рамок, а граф по «12 очей» увёл в legacy-этап nether из крепости). ND_EYES_FRAMES=0 — прежнее.
const eyesWant = () => known.endPortal && Number.isFinite(known.portalEyes) && process.env.ND_EYES_FRAMES !== '0'
  ? Math.max(0, EYES_NEED - known.portalEyes) : EYES_NEED + (known.stronghold ? 0 : 2)
const notePortalEyes = r => { const d = r && r.detail; const w = d && (Number.isFinite(d.withEye) ? d.withEye : d.room && d.room.withEye); if (Number.isFinite(w)) known.portalEyes = w }
const barterFlow = require(path.join(__dirname, 'src', 'barter-flow'))
let barterRetryPending = false
let bastionDry = 0
let bastionGoldDug = 0
let bastionIngotsTraded = 0
let ironChestTried = false
const BASTION_KEYS = ['бастион (ад)', 'бастион 2 (ад)', 'бастион 3 (ад)']
const bastionState = new Map()
const bState = b => {
  const key = `${b.key}:${b.dimension || 'the_nether'}:${b.x}:${b.z}`
  if (!bastionState.has(key)) bastionState.set(key, { dry: 0, spent: false, runs: 0 })
  return bastionState.get(key)
}
function deferBastionMining (b) {
  bState(b).miningDeferredUntil = Math.max(bState(b).miningDeferredUntil || 0, gameClock.now() + 2700000)
  bastionDry = 0
  log(`${b.key}: два законченных захода без добычи — отложен на бюджет следующего маршрута 2700 с; остаток известного золота сохранён`)
}
const nextBastion = () => {
  const left = (known.bastions || []).filter(b => !bState(b).spent)
  if (barterFlow.enabled() && pearlsNow() < eyesWant() && have('gold_ingot') + 9 * have('gold_block') >= 8 && state.pos) {
    // Свои слитки — и к выработанному бастиону (10.10 server-run: «выработан» после 50 слитков — кончилось НАШЕ золото, пиглины
    // на месте; с 85 слитками кампания шла копать к бастиону 2 за 570 бл. и без кирок — домой).
    const nearby = (known.bastions || []).filter(b => Math.hypot(b.x - state.pos.x, b.z - state.pos.z) < 96)
      .sort((a, b) => Math.hypot(a.x - state.pos.x, a.z - state.pos.z) - Math.hypot(b.x - state.pos.x, b.z - state.pos.z))
    if (nearby[0]) return nearby[0]
  }
  return left.find(b => (bState(b).miningDeferredUntil || 0) <= gameClock.now() &&
    (!barterFlow.enabled() || (bState(b).barterUntil || 0) <= gameClock.now())) ||
    left.slice().sort((a, b) => (bState(a).miningDeferredUntil || 0) - (bState(b).miningDeferredUntil || 0))[0] || null
}
// Бастион «в работе» — не выработан и копка не отложена. nextBastion() отдаёт и отложенные (ход туда, когда больше нечего
// делать), а ворота графа и этапов («жемчуг прежде ифритов», эндермены после бастионов) смотрят сюда: отложенный бастион
// ждёт срока, тело тем временем идёт за стержнями или жемчугом (разбор 06.10: ворота без выхода, стержней 0 во всех Full).
const activeBastion = () => (known.bastions || []).find(b => !bState(b).spent && (bState(b).miningDeferredUntil || 0) <= gameClock.now()) || null
// Бартер исчерпан: два захода подряд с сохранённым золотом не отдали ни слитка (укрытие не встало, торговцы не подходят).
let barterZero = 0
const barterExhausted = () => barterZero >= 2
// Огнестойкость в рюкзаке и нечего отдать пиглинам — к ифритам, не дожидаясь жемчуга; потом добор (бастион, эндермены).
const blazeBeforePearls = () => fireResReady() && have('gold_ingot') + 9 * have('gold_block') < 8
function barterSite () {
  const position = state.pos
  if (!position) return {}
  const sites = (known.bastions || []).filter(b => [b.x, b.y ?? 64, b.z].every(Number.isFinite))
  const distance = b => Math.hypot(b.x - position.x, (b.y ?? 64) - position.y, b.z - position.z)
  const nearest = sites.reduce((best, site) => !best || distance(site) < distance(best) ? site : best, null)
  return nearest ? { x: nearest.x, y: nearest.y ?? 64, z: nearest.z,
    knownChests: nearest.chests, starts: nearest.starts } : {}
}
let bastionSearchRuns = 0
const bastionsFromMap = () => (known.bastions || []).some(b => Array.isArray(b.gold) && b.gold.length > 0)
// S1e: бюджет поиска бастиона — игровое время обхода (900 с) и не больше 8 вызовов, а не «3 вызова»: вслепую вызовы рвутся за 3–24 с
// («прервано», «бастиона не видно» после отрезка без пути — s1e-B0-4: 3 вызова за 30 с, бастион не найден, дальше его не искали).
let bastionSearchSeconds = 0
const BASTION_SEARCH_S = Number(process.env.ND_BASTION_SEARCH_S) || 900
const bastionSearchWanted = () => !nextBastion() && bastionSearchRuns < 8 && bastionSearchSeconds < BASTION_SEARCH_S && !bastionsFromMap()
const BASTION_FIRST = process.env.ND_BASTION_FIRST !== '0'
// Бастион на паузе (пустые заходы) — паузу занять ифритами, а не ждать её у портала или дома (S1d s1d-M-2: 4/12 жемчуга на 14-й мин,
// «к крепости пока не иду» при паузе бастиона → граф unreachable → домой и обратно).
let bastionPausedUntil = 0
// Бастион и «нечем» (нет железной кирки на золото, мало еды) — то же: ждать нечего (s1d-M-4: 45 мин «нет доступного шага» на 4120…).
// Пауза бастиона и ифриты — цена (S1e, проверка S1d (б)): без огнестойкости риск этапа 0.7 против 0.35 с ней (калибровка s1c; S1d
// s1d-H22-3/H22-4: ифриты на 20–25-й мин без FR в паузу — обе смерти), но ждать паузу стоит, только если сделки после неё правда
// могут дать FR: выигрыш (риск сейчас − ожидаемый после) × час дороже оставшейся паузы (campaign/nether-pause.pauseBlazeChoice).
let lastBastionGoldLeft = 0
// Бастион ждёт пополнения инструментов, а пополнить здесь нечем (нет безопасного дерева, S1e s1e-B0-3: 70 игр. мин «откладываю до
// пополнения» ↔ «к крепости пока не иду, жемчуга 0/14» до таймаута) — «сперва жемчуг» не держит ифритов, как при READY.bastion «нечем».
let supplyBlockedAt = -Infinity
const bastionSupplyBlocked = () => gameClock.now() - supplyBlockedAt < 300000 && !netherSupply.netherToolsReady(netherSupplyState())
let lastPauseWhy = ''
function pauseWaitPays () {
  if (gameClock.now() >= bastionPausedUntil) return true
  // Слитки после паузы: в рюкзаке + половина известного оставшегося золота бастиона (после пустых заходов путь к нему не гарантирован).
  // ponytail: доля 0.5 — грубая; уточнять по телеметрии «золото по памяти осталось → взято после паузы».
  const goldLeft = lastBastionGoldLeft || (activeBastion()?.gold?.length ?? 0)
  const ingots = have('gold_ingot') + 9 * have('gold_block') + Math.round(9 * goldLeft * 0.5)
  const c = require(path.join(__dirname, 'src', 'campaign', 'nether-pause')).pauseBlazeChoice({ fireRes: fireResReady(),
    pauseLeftSeconds: (bastionPausedUntil - gameClock.now()) / 1000, ingotsAfterPause: ingots, shield: have('shield') > 0 || /shield/.test(JSON.stringify(state.offHand || '')), hp: state.health ?? 20 })
  const key = `${c.wait}|${Math.round(c.gainSeconds / 60)}|${ingots}`
  if (key !== lastPauseWhy) { lastPauseWhy = key; log(`пауза бастиона: ${c.why}`) }
  return c.wait
}
const bastionPearlsPending = () => BASTION_FIRST && (!only || only.includes('bastion')) && pearlsNow() < eyesWant() && !blazeBeforePearls() &&
  pauseWaitPays() && READY.bastion() && !bastionSupplyBlocked() &&
  (!!activeBastion() || (have('gold_block') * 9 + have('gold_ingot') >= 8 && !barterExhausted()))
const SCOUT_HIGH = process.env.ND_SCOUT_HIGH === '1'
let rodsFirstSkips = 0 // не больше 3 отказов бастиона ради стержней: путь к спавнеру тоже может не открыться
defStage('bastion', () => !!known.portal && (!!nextBastion() || bastionSearchWanted()) && bastionDry < 3 && !known.endPortal &&
  (BASTION_FIRST || rodsNow() >= 7) && (pearlsNow() < eyesWant() || obsShort()), async (searchOnly = false) => {
  if (dim() !== 'the_nether') {
    await refresh()
    if (!goldOn() && have('gold_ingot') >= 4) await wearGold()
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
    }
    if (!lighter()) await ensureFlint()
    if (state.playPolicy?.mode !== 'speedrun') {
      await baseDeposit()
      await sticksReserve()
    }
    await act('kit', { for: 'bastion' })
    if (have(/_bed$/) && !spawnAtPortal()) await act('sleep', { mode: 'spawn', why: 'у портала в Ад' })
    const e = await enterNether()
    if (!(e.detail && e.detail.went)) throw new Error('в Ад не прошёл')
  }
  // S1f: огнестойкость в рюкзаке (≥ 2 зелий — ~6 мин боя), жемчуга уже ≥ 6, крепость известна, стержней не хватает, золота на бартер
  // нет — сперва стержни: бой у спавнера под FR — риск 0.35 против 0.7 без неё (калибровка s1c), а дальнейшие заходы в бастион
  // уносили и FR, и жемчуг (s1f-G3-1: 10 жемч./6 FR — брут на 40 мин; S1-2: 11/9 — брут на 51; I1-3: 8/2 — куб магмы на 46; план всё
  // время «BastionBarter → GetBlazeRods»). Неудача этапа — директор берёт стержни. ND_RODS_FIRST_FR=0 — прежнее.
  if (!searchOnly && dim() === 'the_nether' && process.env.ND_RODS_FIRST_FR !== '0' && fireResNow() >= 2 && rodsShort() > 0 && pearlsNow() >= 6 && known.fortress &&
    have('gold_ingot') + 9 * have('gold_block') < 8 && rodsFirstSkips < 3 && !died) {
    rodsFirstSkips++
    log(`бастион подождёт: огнестойкость ×${fireResNow()}, жемчуг ${pearlsNow()}/${eyesWant()}, стержней не хватает ${rodsShort()} — сперва ифриты под FR`)
    throw new Error('сперва стержни под огнестойкостью')
  }
  if (!nextBastion() && bastionSearchWanted() && dim() === 'the_nether' && !died) {
    bastionSearchRuns++
    await spares(260)
    await netherFillers()
    const f = await act('fortress', { mode: 'bastion', timeoutSeconds: 420, ...(SCOUT_HIGH ? { high: true } : {}) })
    await readMemory()
    const fd = f.detail || {}
    if (/обошёл регионы/.test(fd.stopped || '')) bastionSearchRuns = 99
    bastionSearchSeconds += Math.max(30, Number(fd.seconds) || 0)
    log(`поиск бастиона: ${fd.found ? `найден ${JSON.stringify((fd.bastion && fd.bastion.nearest) || {})}` : 'не найден' + (fd.stopped ? ' — ' + fd.stopped : '')} (заход ${Math.min(bastionSearchRuns, 8)}, ${fd.seconds ?? '?'} с, бюджет ${Math.round(bastionSearchSeconds)}/${BASTION_SEARCH_S} с)`)
    if (!nextBastion()) return
  }
  if (searchOnly) return
  if (!goldOn() && have(/^golden_(helmet|chestplate|leggings|boots)$/)) await act('armor')
  if (!goldOn()) await netherGold()
  if (!goldOn()) { log('золотой брони нет и не из чего — в бастион не иду'); bastionDry++; return }
  for (let i = 0; i < 4 && !died && dim() === 'the_nether'; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    if ((state.health ?? 20) < 12) { if (have(FOOD)) await act('eat'); if ((state.health ?? 20) < 10) break }
    const b = nextBastion()
    if (!b) { log('все известные бастионы выработаны'); break }
    // Нести слитки к ДАЛЁКОМУ бастиону в режиме бартера — потерять его золото (S1d s1d-AB-1 слот 22: 9 слитков, бастион 2 в 170 бл.,
    // barter 540 с «подход к защищённому бартеру не завершён» → «два бартера без слитка» → бастион отложен, к ифритам с 0 жемчуга).
    // Далёкий бастион — обычным заходом: копка и торг всего, включая принесённое.
    const carriedTrade = barterFlow.enabled() && pearlsNow() < eyesWant() && have('gold_ingot') + 9 * have('gold_block') >= 8 &&
      (!state.pos || Math.hypot(b.x - state.pos.x, b.z - state.pos.z) <= 64)
    if (!carriedTrade && !netherSupply.netherToolsReady(netherSupplyState())) {
      const supply = await replenishNetherSupply()
      if (!supply.ready) { supplyBlockedAt = gameClock.now(); log(`копку и путь к бастиону откладываю до пополнения инструментов: ${supply.reason}`); return }
    }
    const bs = bState(b)
    bs.runs++
    const nearAny = !!state.pos && (known.bastions || []).some(x => Math.hypot(x.x - state.pos.x, x.z - state.pos.z) < 80)
    if (!nearAny && process.env.ND_NE_ROUTE !== '1') await spares(600)
    const via0 = dim() === 'the_nether' && state.pos ? netherVia(state.pos, b) : []
    if (via0.length && state.pos && Math.hypot(b.x - state.pos.x, b.z - state.pos.z) > 100) {
      const end = via0[via0.length - 1]
      const t = await act('nether_tunnel', { x: end[0], y: end[1], z: end[2], radius: 5, via: via0, budgetCheck: true, noBreachNear: { x: b.x, z: b.z, r: 48 }, timeoutSeconds: 2700 })
      await refresh()
      if (died || dim() !== 'the_nether') return
      const td = t.detail || {}
      const why = td.why || t.error || ''
      if (/кирок на дорогу не хватит/.test(why)) { log(`${b.key}: ${why} — сначала пополнить кирки`); break }
      log(`${b.key}: штрек по маршруту — ${td.ok ? 'дошёл' : 'не дошёл: ' + why} (точек ${td.viaDone ?? '?'}/${via0.length}, копок ${td.dug ?? '?'})`)
      if (!td.ok && state.pos && Math.hypot(b.x - state.pos.x, b.z - state.pos.z) > 100) { log(`${b.key}: до бартера не дошёл — бастион остаётся нужен`); break }
    }
    // S1e (вслепую): бастион узнан глазами издалека, золото не известно — сперва подойти к нему (на 20 бл.), а не начинать закрытый
    // штрек с уступа за лавовым морем (s1e-M2-1: с 31 бл. «штрек: пути нет», заливка старта 29 клеток, 2 сухих захода за секунду —
    // «выработан» при 142 блоках золота шаблона стен). До 3 подходов на бастион.
    if (!(b.gold && b.gold.length) && state.pos && Math.hypot(b.x - state.pos.x, b.z - state.pos.z) > 28 && (bs.blindApproach || 0) < 3 && dim() === 'the_nether') {
      bs.blindApproach = (bs.blindApproach || 0) + 1
      log(`${b.key}: золото не известно, до него ${Math.round(Math.hypot(b.x - state.pos.x, b.z - state.pos.z))} бл. — сперва подхожу (${bs.blindApproach}/3)`)
      await goToward({ x: b.x, y: b.y ?? 64, z: b.z }, 20)
      await refresh()
      if (died || dim() !== 'the_nether') return
    }
    const far = state.pos ? Math.hypot(b.x - state.pos.x, b.z - state.pos.z) : 0
    const beforeApproach = state.pos ? { ...state.pos } : null
    const r = await act('bastion', { x: b.x, y: b.y, z: b.z, vantage: b.vantage, knownGold: b.gold, knownChests: b.chests, starts: b.starts,
      ...(carriedTrade ? { mode: 'barter' } : {}), timeoutSeconds: carriedTrade ? 540 : process.env.ND_GOLD_FAST_SAFE === '1' ? 720 : 1200 + Math.min(600, Math.round(far)), tripSeconds: far > 200 ? Math.min(480, Math.round(far / 1.3)) : 0, pearls: Math.max(0, eyesWant() - have('ender_eye')), fireRes: 3, ...(process.env.ND_SH_NETHER === '1' ? { obsidian: 10 } : {}), ...(EXIT_KIT ? { exit: false } : {}), sealed: !bs.openNext, ...(process.env.ND_SEALED_BREACH === '1' ? { breach: true } : {}), ...(process.env.ND_GOLD_FAST_SAFE === '1' ? { fastSafe: true } : {}) })
    const d = r.detail || {}
    lastBastionGoldLeft = Math.max(0, Number(d.knownGoldLeft ?? d.predLeft) || 0)
    bastionGoldDug += Number(d.goldBlocksDug) || 0
    bastionIngotsTraded += Number(d.ingotsTraded) || 0
    if ((Number(d.ingotsTraded) || 0) > 0) barterZero = 0
    if (d.supplyNeeded) await sense()
    if (strategyInterrupted || r.status === 'interrupted' || r.code === 'TACTICAL' || r.by?.type === 'tactical') {
      throw Object.assign(new Error('STRATEGY_INTERRUPTED: бастион прерван, исчерпание не подтверждено'), { strategyInterrupted: true })
    }
    if (d.supplyNeeded && netherSupplyState().pickSwings < 260) {
      log(`${b.key}: ресурсный запас ${netherSupplyState().pickSwings}/260 — пополнение и новый план; сухой заход не засчитываю`)
      throw Object.assign(new Error('STRATEGY_INTERRUPTED: ресурсный запас требует пополнения и перепланирования'), { strategyInterrupted: true })
    }
    const approached = dim() === 'the_nether' && require(path.join(__dirname, 'src', 'campaign', 'nether-progress'))
      .bastionApproachProgress(beforeApproach, state.pos, b)
    if (carriedTrade) {
      bastionDry = 0; bs.dry = 0
      barterZero = (Number(d.ingotsTraded) || 0) > 0 ? 0 : barterZero + 1
      if (barterExhausted() && pearlsNow() < eyesWant()) {
        if ((bs.miningDeferredUntil || 0) <= gameClock.now()) log(`${b.key}: два бартера подряд без единого слитка (${String(d.stopped || r.error || '').slice(0, 100)}) — бартер исчерпан, бастион отложен`)
        deferBastionMining(b)
      }
      if (pearlsNow() < eyesWant() && have('gold_ingot') + 9 * have('gold_block') >= 8) {
        barterRetryPending = true
        bs.barterUntil = approached ? 0 : gameClock.now() + 60000
      }
      log(`${b.key}: бартер с сохранённым золотом — слитков ${d.ingotsTraded ?? 0}, жемчуг ${pearlsNow()}/${eyesWant()}; добыча другого бастиона отложена`)
      break
    }
    if (barterFlow.enabled() && barterFlow.retry(d, state.inventory || {})) {
      barterRetryPending = true; bastionDry = 0; bs.dry = 0
      // Подход продвинулся — то же место без минутной паузы (как у бартера с принесённым золотом выше).
      bs.barterUntil = approached ? 0 : gameClock.now() + 60000
      log(`${b.key}: золото сохранено, нужен другой этаж/торговцы — повтор без многоминутной паузы`)
      break
    }
    if (d.need && d.need.what === 'iron_pickaxe') { ironChestTried = true; log('в сундуках бастиона железа на кирку не хватило — за железом наверх'); break }
    log(`${b.key}: золотых блоков ${d.goldBlocksDug ?? '?'}, слитков пиглинам ${d.ingotsTraded ?? '?'}, в рюкзаке ${JSON.stringify(d.bag || {})}${d.stopped ? ' — ' + d.stopped : ''}`)
    const got = d.goldBlocksDug > 0 || d.ingotsTraded > 0 || (Array.isArray(d.chests) && d.chests.some(c => c && Object.values(c.took || {}).some((n : any) => n > 0)))
    if (!got && !approached) { bastionDry++; bs.dry++ } else { bastionDry = 0; bs.dry = 0; bs.miningDeferredUntil = 0 }
    // Заходы без золота и сделок, где «подход» — лишь шаги внутри бастиона: 3 подряд — отложить (S1d s1d-M-1: 8340… с 31-й по
    // 56-ю мин ~10 вызовов «золото кончилось: видимых блоков больше нет», каждый засчитан подходом — бастион не откладывался).
    bs.noGain = got ? 0 : (bs.noGain || 0) + 1
    if (bs.noGain >= 3 && (bs.miningDeferredUntil || 0) <= gameClock.now()) { log(`${b.key}: ${bs.noGain} захода подряд без золота и сделок`); deferBastionMining(b); bs.noGain = 0; break }
    if (approached && !got) log(`${b.key}: приблизился к известному золоту/сундуку — сухой заход не засчитываю`)
    const mappedLeft = process.env.ND_GOLD_FAST_SAFE === '1' &&
      ((d.knownGoldLeft ?? d.predLeft ?? b.gold?.length ?? 0) > 0 || /золото по памяти осталось|пути.*нет|не дошёл|время вышло|заплатка/.test(d.stopped || ''))
    if (mappedLeft) {
      // Два сухих захода — отложить и без второго бастиона: дальше граф берёт стержни/эндерменов, а не крутит тот же бастион
      // (s1c-B-1 06.10: 4 захода по 4–10 мин с нулём золота, 27→57 мин; по std раунда 1 «пути нет»/«золото кончилось» — 85
      // вызовов, 362 мин).
      if (!got && !approached && bs.dry >= 2) {
        deferBastionMining(b)
      }
      log(`${b.key}: не выработан — осталось золото или путь не закончен`)
      break
    }
    // S1e: вслепую два сухих захода издалека (> 28 бл. до бастиона на старте захода) — не «выработан», а ближе и снова (до 3 подходов).
    if (!got && bs.dry >= 2 && far > 28 && !(b.gold && b.gold.length) && (bs.blindApproach || 0) < 3) {
      log(`${b.key}: два сухих захода с ${Math.round(far)} бл. — не выработан, подойду ближе`)
      bs.dry = 0
      break
    }
    // S1f: вслепую (золото бастиона не известно) закрытый штрек по шаблону ничего не дал (шаблон не попал: s1f-B0-2 сокровищница,
    // s1f-A2-3 мост — «не золото» по всем целям, 0 блоков ×2 → «выработан» на 5-й мин; S1e M4/M5 — то же в 9 из 21) — прежде чем
    // бросить бастион, один заход открытым обзором, как игрок в золотой броне: видимое золото и сундуки с точек обзора. Риск обзора
    // меньше потери единственного источника жемчуга. По умолчанию ВЫКЛ. (ND_BASTION_OPEN=1 — вкл.): нативно 3 открытых захода (s1f-FA-1,
    // G1-2, D1-1) — 2 смерти (брут; лава у y 25), 0 золота в рюкзак — цена риска выше выгоды.
    if (!got && far <= 48 && !/не дош/.test(String(d.stopped || '')) && !(b.gold && b.gold.length) && !bs.openTried && !bs.openNext && process.env.ND_BASTION_OPEN === '1' && dim() === 'the_nether' && !died) {
      bs.openNext = true
      log(`${b.key}: закрытый штрек по шаблону ничего не дал — следующий заход открытым обзором (видимое золото, сундуки)`)
      bs.dry = 0
      continue
    }
    if (bs.openNext) { bs.openNext = false; bs.openTried = true }
    if ((got && /золото кончилось/.test(d.stopped || '')) || bs.dry >= 2) {
      bs.spent = true
      log(`${b.key} выработан`)
      await act('remember', { kind: 'прогресс', place: `выработан: ${b.key}`, text: 'Бартер завершён: золото выработано или два сухих захода подряд' })
    }
    if (!got && !bs.spent) break
    if (!(pearlsNow() < eyesWant() || fireResNow() < 1 || obsShort())) break
    await refresh()
  }
})

// loot_table/chests/ruined_portal.json в server-1.21.11.jar) и золотые блоки
let ruinTried = false
async function ruinedPortalGold () {
  if (ruinTried || dim() !== 'overworld' || goldOn()) return
  ruinTried = true
  const r = await act('structure', { mode: 'list' })
  const ruins = ((r.detail && r.detail.known) || []).filter(x => x.kind === 'ruined_portal' && !x.done && x.dist != null && x.dist < 650)
  if (!ruins.length) { log('руин портала в памяти нет — золото на шлем в Аду'); return }
  const t = ruins[0]
  log(`за золотом на шлем — руины портала ${t.at.x},${t.at.z} (${t.dist} бл.)`)
  for (let k = 0; k < 6 && !died; k++) { await nightGuard(); if (await goToward(t.at, 24)) break }
  const e = await act('structure', { mode: 'explore', kind: 'ruined_portal', x: t.at.x, z: t.at.z, timeoutSeconds: 180 })
  await refresh()
  if (have('gold_nugget') >= 9) await craft('gold_ingot', Math.floor(have('gold_nugget') / 9))
  if (have('gold_block')) await craft('gold_ingot', 9 * have('gold_block'))
  if (!goldOn() && have(/^golden_(helmet|chestplate|leggings|boots)$/)) await act('armor')
  if (!goldOn() && have('gold_ingot') >= 4) await wearGold()
  log(`руины: ${JSON.stringify((e.detail && e.detail.took) || {})}; золото на мне: ${goldOn() ? 'да' : 'нет'}`)
  if (known.portal) for (let k = 0; k < 6 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
}

// Пиглинам хватает любой золотой вещи: ботинки — 4 слитка, шлем — 5 (броня 1 против 2); из 4 слитков — ботинки, а не ещё одна руда.
async function wearGold () {
  await craft(have('gold_ingot') >= 5 ? 'golden_helmet' : 'golden_boots')
  await act('armor')
}
// Native 1.21.11 Block.playerWillDestroy: guarded ore angers adults in the
// player AABB +16 blocks without line of sight. This is the cautious ore
// variant; the body repeats its visible-piglin check at each actual swing.
async function netherGold () {
  let goldAway = 0
  await refresh()
  if (!goldOn() && have('gold_block') && have('gold_ingot') < 5) {
    await craft('gold_ingot', 9 * have('gold_block'))
    await refresh()
  }
  for (let i = 0; i < 6 && !goldOn() && dim() === 'the_nether' && !died; i++) {
    const nuggets = have('gold_nugget') + 9 * have('gold_ingot')
    if (nuggets >= 36) break
    const o = await act('observe', { radius: 24 })
    const ents = (o.detail && o.detail.entities) || []
    const piglin = ents.find(e => /^piglin( brute)?$/i.test(String(e.name || '')))
    // Пиглины у руды — уйти от них за другой рудой (её в незераке много), а не бросать золото: без брони в бастион не иду, и
    // поход домой за железом съедал прогон (cl-ab 14.10: бастион найден на 27-й мин, «пиглины рядом — руду не трогаю», домой).
    if (piglin) {
      if (++goldAway > 2 || !state.pos || !piglin.pos) { log('пиглины рядом — золотую руду не трогаю'); break }
      const dx = state.pos.x - piglin.pos.x, dz = state.pos.z - piglin.pos.z
      const direction = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north')
      log(`пиглины рядом — ухожу от них (${direction}) за другой золотой рудой`)
      await act('explore', { block: 'nether_gold_ore', radius: 32, stepDistance: 40, direction, timeoutSeconds: 60 })
      continue
    }
    const m = await act('mine', { block: 'nether_gold_ore', count: Math.max(2, Math.ceil((36 - nuggets) / 4)), radius: 40, timeoutSeconds: 120, avoidPiglinAggro: true })
    if (!(m.detail && m.detail.dug)) {
      if (/не вижу/.test(String(m.error || '')) && i > 0) break
      const e = await act('explore', { block: 'nether_gold_ore', radius: 32, stepDistance: 40, timeoutSeconds: 90 })
      if (!(e.detail && e.detail.found)) break
    }
  }
  await refresh()
  if (have('gold_nugget') >= 9) await craft('gold_ingot', Math.floor(have('gold_nugget') / 9))
  if (have('gold_ingot') >= 4 && !goldOn()) await wearGold()
}

// Сытость перед боем у спавнера: еда прерывается тактикой/ифритами («не поел»), а уход из боя без защиты навыка у спавнера
// гибелен (s1-post13 06.10: blaze вернулся на 19 хп, «сытость не восстановилась», ожидание тактики — смерть). Под огнестойкостью
// (или с зельем в рюкзаке) и с 12+ хп бой не откладываем.
async function fedForBlazes () {
  if (await eatTo(18)) return true
  // Без огнестойкости — тот же бой (щит на залп, коробка, отход), лишь запас хп выше: недоеденная сытость — не запрет.
  return (state.health ?? 0) >= (fireResReady() ? 12 : 14)
}
const rodsShort = () => Math.max(0, Math.ceil((eyesWant() - have('ender_eye') - have('blaze_powder')) / 2) - have('blaze_rod'))
const rodsWanted = () => rodsShort() > 0 && (have('ender_eye') < Math.min(10, EYES_NEED) || have('ender_pearl') > 2 * have('blaze_rod') + have('blaze_powder'))
defStage('nether', () => !!known.portal && rodsWanted(), async () => {
  if (bastionPearlsPending()) {
    log(`к крепости пока не иду: жемчуга ${pearlsNow()}/${eyesWant()}, сперва бартер имеющегося золота и известные бастионы`)
    return
  }
  if (dim() !== 'the_nether') {
    await refresh()
    if (!goldOn() && have('gold_ingot') >= 4) await wearGold()
    if (!goldOn()) await ruinedPortalGold()
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) {
        await nightGuard()
        if (await goToward(known.portal, 6)) break
      }
    }
    if (!lighter()) await ensureFlint()
    await baseDeposit()
    await sticksReserve()
    if (shieldLow() && !have('shield') && have('iron_ingot')) {
      if (have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
      await craft('shield')
      log(`запасной щит: ${have('shield') ? 'есть' : 'не вышел'}`)
    }
    await act('kit', { for: 'nether' })
    if (have(/_bed$/) && !spawnAtPortal()) await act('sleep', { mode: 'spawn', why: 'у портала в Ад' })
    const e = await enterNether()
    if (!(e.detail && e.detail.went)) throw new Error('в Ад не прошёл')
  }
  for (let i = 0; i < 6 && !known.fortress; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    await spares(260)
    await netherFillers()
    const f = await act('fortress', { timeoutSeconds: 300, ...(SCOUT_HIGH ? { high: true } : {}) })
    if (f.detail && f.detail.found) known.fortress = f.detail.fortress || true
  }
  for (let i = 0; i < 3 && rodsWanted() && known.fortress; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    if (!have(/^(stone|iron|diamond|netherite)_pickaxe$/)) await spares(200)
    if (!fightReady()) {
      if (READY.nether()) {
        fightGearWanted = true
        for (const item of ['iron_chestplate', 'iron_leggings', 'iron_helmet']) if (!worn(ARMOR_SLOT[item.split('_').pop()])) log(gearWorth(item).line)
      }
      log(`бой у спавнера: не хватает ${fightLack()} — сохраняю добытые стержни`)
      return
    }
    if (!(await fedForBlazes())) { log('сытость не восстановилась — путь к спавнеру не начинаю'); return }
    if (!netherSupply.netherToolsReady(netherSupplyState())) {
      const supply = await replenishNetherSupply()
      if (!supply.ready) { log(`путь к спавнеру отложен: ${supply.reason}`); return }
    }
    await spares(200)
    await netherFillers()
    const spFar = known.fortress && known.fortress.x != null && state.pos ? Math.hypot(known.fortress.x - state.pos.x, known.fortress.z - state.pos.z) : 0
    if (!have('bow') && have('string') >= 3) { await sticks(3); await craft('bow'); await refresh() }
    // Уже у спавнера (в яме у помоста или в 8 бл. на его уровне) — подход не нужен: fortress уводил из ямы под ифритов.
    const spHere = memorySnapshot?.places?.['спавнер блейзов']
    // В 40 бл. от спавнера подход ведёт сам blaze (ход по сетке под защитой навыка, с огнестойкостью и отбоем), а не fortress:
    // последний отрезок fortress рвала тактика, тело доходило с 6–10 хп (s1-LC-1/LD-1 06.10, крепость в 2–24 бл. от входа).
    const atSpawner = !!(spHere && state.pos && Math.hypot(spHere.x - state.pos.x, spHere.z - state.pos.z) <= 40 && Math.abs(spHere.y - state.pos.y) <= 24)
    // Спавнер известен (карта копии), а до него > 40 бл. — сперва ходом по сетке до 36 бл., дальше — blaze (см. выше).
    if (!atSpawner && spHere && state.pos && process.env.ND_NE_ROUTE === '1' && Math.hypot(spHere.x - state.pos.x, spHere.z - state.pos.z) > 40) {
      // Огнестойкость — бою у спавнера: ход не пьёт зелья (frKeep 3, как fortress), s1-LE-3 06.10 — 2 зелья ушли на ход, на бой одно.
      await goToward({ x: spHere.x, y: spHere.y, z: spHere.z }, 36, 3)
      await refresh()
      if (died || dim() !== 'the_nether') return
      if (state.pos && Math.hypot(spHere.x - state.pos.x, spHere.z - state.pos.z) <= 40) { i--; continue }
    }
    const s = atSpawner ? { detail: { reached: true, spawner: { x: spHere.x, y: spHere.y, z: spHere.z }, dist: 0 } } as any
      : await act('fortress', { mode: 'spawner', timeoutSeconds: Math.min(600, 300 + Math.round(spFar / 2)), ...(process.env.ND_SPAWNER_TUNNEL === '1' ? { tunnel: true } : {}) })
    // Не «дошёл», но спавнер в 24 бл. (ифриты уже бьют: s1-post01b 06.10 — 15 бл. над спавнером, подход рвала тактика,
    // кампания шла домой и умерла) — бой отсюда: blaze сам ищет точку боя и стреляет из лука.
    const spAt = (s.detail && s.detail.spawner) || memorySnapshot?.places?.['спавнер блейзов'] || null
    const spNear = !!(spAt && state.pos && Math.hypot(spAt.x - state.pos.x, spAt.z - state.pos.z) <= 24 && Math.abs(spAt.y - state.pos.y) <= 24)
    // S1f (вслепую): спавнер не увиден, но обход крепости видел ифритов рядом (≤ 24 бл.) — бой с ними отсюда: ифриты держатся у спавнера,
    // навык blaze бьёт видимых и сам ищет спавнер (s1f-A2-3: тело под тронным залом, ифриты били — смерть без боя на 19-й мин).
    // ND_BLAZE_SEEN=0 — прежнее (только у спавнера).
    const blazesNear = process.env.ND_BLAZE_SEEN !== '0' && !!(s.detail && s.detail.blazes && s.detail.blazes.seen > 0 && s.detail.blazes.nearest <= 24)
    if (!(s.detail && s.detail.reached) && !spNear && !blazesNear) { log(`к спавнеру не дошёл: ${String((s.detail && s.detail.stopped) || s.error || '').slice(0, 120)}`); if (i >= 1) break; continue }
    if (!(s.detail && s.detail.reached)) log(`к спавнеру не дошёл (${String((s.detail && s.detail.stopped) || s.error || '').slice(0, 80)}), но ${spNear ? 'он в 24 бл.' : `ифриты видны (${s.detail.blazes.seen}, ближний в ${s.detail.blazes.nearest} бл.)`} — бой отсюда`)
    else log(`у спавнера ${JSON.stringify(s.detail.spawner)} (${s.detail.dist} бл.)`)
    if (!(await fedForBlazes())) { log('сытость не восстановилась — бой с блейзами не начинаю'); return }
    if (!have('bow') && have('string') >= 3) { await sticks(3); await craft('bow'); await refresh() }
    // Коробка с окном — укрытие боя без огнестойкости (ифрит стреляет только по лучу); под огнестойкостью — открытый бой.
    const bz = await act('blaze', { rods: Math.max(1, have('blaze_rod') + rodsShort()), timeoutSeconds: 400, ...(fireResReady() ? { box: false } : {}), ...(have('bow') ? { allowRanged: true } : {}) })
    // blaze закопался на месте (яма 2 вниз с крышкой) — ne_burrow уже не нужен: он уводил тело из ямы под ифритов.
    if (bz && bz.detail && bz.detail.dugIn) { blazeDugInAt = gameClock.now(); blazeDugInPos = bz.detail.dugIn.at || null }
    await refresh()
    log(`стержней: ${have('blaze_rod')}`)
    // S1e: «ифриты за стеной, доступной точки обзора нет» раз за разом (s1e-B0-4: 20+ игр. мин вызовов blaze по 1–3 мин, 0 стержней,
    // тело на 4 бл. ниже помоста) — после двух таких подряд заново к спавнеру штреком со вскрытием стены зала (fortress tunnel+breach),
    // а не тот же вызов с того же места.
    const bzd = (bz && bz.detail) || {}
    blazeNoView = /доступной точки обзора нет/.test(String(bzd.stopped || '')) && !(Number(bzd.kills) > 0) ? blazeNoView + 1 : 0
    if (blazeNoView >= 2 && rodsWanted() && dim() === 'the_nether' && !died) {
      log(`ифриты за стеной ${blazeNoView}-й вызов подряд — к спавнеру штреком со вскрытием зала`)
      await act('fortress', { mode: 'spawner', tunnel: true, breach: true, timeoutSeconds: 300 })
      await refresh()
      if (blazeNoView >= 4) { log('за стеной и после штрека — этап ифритов отдаю графу'); blazeNoView = 0; return }
    }
    // Без огнестойкости бой продолжается (навык blaze сам держит щит на залп, коробку с окном, отход и возврат) — решение
    // пользователя 06.10 22:33. Закопаться — только когда навык вернул тело с малым хп и сам не ушёл в толщу.
    if (rodsWanted() && (state.health ?? 20) < 10 && !(bz && bz.detail && bz.detail.dugIn) && dim() === 'the_nether' && !died) { log(`хп ${Math.round(state.health ?? 0)} у спавнера — закапываюсь лечиться`); await act('ne_burrow', { why: 'мало хп у спавнера' }); await refresh(); break }
    // Огнестойкость кончилась, а её можно добыть (бастион в работе или золото на руках) — решает граф по цене: купить FR
    // (AcquireFireResistance) или бой без неё; не крутить вызовы blaze без FR внутри этапа (s1c-I-6 06.10: 12 жемчуга к 11.5 мин,
    // FR кончилась после 1 стержня, 4 вызова без FR — 3 стержня и смерть на 30.9 мин).
    if (rodsWanted() && !fireResReady() && bz && (activeBastion() || have('gold_ingot') + 9 * have('gold_block') >= 8) && dim() === 'the_nether' && !died) {
      log('огнестойкость кончилась — решает граф: купить её или бой без неё')
      if (!(bz.detail && bz.detail.dugIn)) await act('ne_burrow', { why: 'FR кончилась — к решению графа' })
      await refresh()
      break
    }
    // Набрал — сразу в толщу (ифриты у спавнера остаются; после этапа граф молчит из-за угрозы, а тактика у спавнера гибнет).
    if (!rodsWanted() && dim() === 'the_nether' && !died && gameClock.now() - blazeDugInAt > 60000) { log('стержни набраны — закапываюсь от ифритов'); await act('ne_burrow', { why: 'стержни набраны — ухожу от ифритов' }); await refresh(); break }
    if ((state.health ?? 20) < 10) break
  }
})

let blazeDugInAt = -Infinity
let blazeNoView = 0
let blazeDugInPos = null
let homeForGearAfter = -Infinity
const ENDERMEN_OK = process.env.ND_ENDERMEN === '1'
defStage('pearls', () => ENDERMEN_OK && !!known.portal && rodsShort() === 0 && have('ender_pearl') + have('ender_eye') < eyesWant() && !activeBastion() && !bastionSearchWanted(), async () => {
  if (dim() !== 'the_nether') {
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
    }
    await sticksReserve()
    await act('kit', { for: 'nether' })
    const e = await enterNether()
    if (!(e.detail && e.detail.went)) throw new Error('в Ад не прошёл')
  }
  // Эндермены в Аду живут в искажённом лесу (WarpedForest спавнит только их и страйдеров) — охота там, а не у портала (s1-SB-1/s1c-A-6
  // 06.10: «foxhole» у портала — 0 убийств за 5 заходов). S1e: лес — по видимости (nether-forest.js: видимый нилий + биом F3 под
  // ногами, решение пользователя 09:19/09:24), не по /locate biome (S1d: «лес» по locate на y 70 — 0 нилия в 24 бл., 34 окопа без
  // единого эндермена). Не видел леса — разведка обзором (глаза пишут лес сами), а не охота где попало.
  let warped = forestToHunt()
  if (!warped && dim() === 'the_nether' && !died) {
    log('эндермены: искажённого леса глазами не видел (или видел пустым) — разведка обзором до видимого нилия')
    const ex = await act('explore', { block: 'warped_nylium', radius: 96, stepDistance: 64, timeoutSeconds: 240 })
    await readMemory()
    warped = forestToHunt()
    const at = ex && ex.detail && ex.detail.found && ex.detail.at
    if (!warped && at && !forestEmpty(at)) warped = { x: at.x, y: at.y + 1, z: at.z, note: 'увидел нилий разведкой' }
    // S1f: не нашёл — неудача стратегии (директор отступает по времени и берёт другие: стержни), а не «успех без прогресса»: s1f-H1-1 —
    // HuntEndermen выбран 17 раз подряд, 45 игр. мин разведки нилия без леса, крепость известна, к спавнеру не вернулся. ND_EM_FAIL=0 — прежнее.
    if (!warped) { pearlTrips.zero = 2; log('эндермены: леса не нашёл — охоту не начинаю'); if (process.env.ND_EM_FAIL !== '0') throw new Error('эндермены: искажённого леса не нашёл'); return }
  }
  if (warped && dim() === 'the_nether' && state.pos && Math.hypot(warped.x - state.pos.x, warped.z - state.pos.z) > 4) {
    log(`эндермены: к искажённому лесу ${warped.x},${warped.y},${warped.z} (${Math.round(Math.hypot(warped.x - state.pos.x, warped.z - state.pos.z))} бл., ${warped.note || ''})`)
    await goToward({ x: warped.x, y: warped.y, z: warped.z }, 16)
    await refresh()
    // Штрек кончается в толще у леса — окопу нужен открытый пол леса (s1c-E-1 06.10: «эндерменов не вижу», 5 заходов по 400 с
    // из штрека, 0 убийств): на сам увиденный нилий (запись — видимый блок + 1).
    if (!died && dim() === 'the_nether') { await act('goto', { x: warped.x, y: warped.y, z: warped.z, range: 2, timeoutSeconds: 60 }); await refresh() }
  }
  for (let i = 0; i < 8 && have('ender_pearl') + have('ender_eye') < eyesWant(); i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    if ((state.health ?? 20) < 14 && have(FOOD)) await act('eat')
    await spares(400)
    if (fillersNow() < 12 && !nearBastion(state.pos, 90)) {
      await act('mine', { block: 'netherrack', count: 24, radius: 8, timeoutSeconds: 90 })
      await refresh()
    }
    if (fillersNow() < 6) { log(`блоков на окоп нет (${fillersNow()}) — охоту не начинаю`); break }
    const p0 = have('ender_pearl')
    const tHunt = gameClock.now()
    const h = await act('pearls', { count: eyesWant() - have('ender_eye') - have('ender_pearl'), timeoutSeconds: 400, style: PEARL_STYLE })
    await refresh()
    const hd = (h && h.detail) || {}
    pearlTrips.seconds += (gameClock.now() - tHunt) / 1000
    pearlTrips.pearls += Math.max(0, have('ender_pearl') - p0)
    pearlTrips.zero = (Number(hd.seenEndermen) || 0) > 0 ? 0 : pearlTrips.zero + 1
    log(`жемчуг: ${have('ender_pearl')} (+очей ${have('ender_eye')}); эндерменов в виду за заход ${hd.seenEndermen ?? '?'}; цена ${Math.round(endermenSecondsPerPearl())} с/жемчуг`)
    // Два захода подряд без единого эндермена в виду — место пустое (S1d: 23–40 мин охоты без единого): лес помечен, охота кончена.
    if (pearlTrips.zero >= 2) {
      pearlTrips.zero = 0
      log('эндермены: 2 захода подряд без единого в виду — место пустое, охоту прекращаю')
      if (state.pos) emptyForests.push({ x: state.pos.x, z: state.pos.z })
      break
    }
  }
})
// S1e: цена жемчуга эндерменами — по факту заходов (секунды охоты / жемчуг; приор 240 с на 2 жемчуга), лес не видел — дороже
// (разведка), два пустых захода — практически стоп. Граф (HuntEndermen, barterPlan action endermen) берёт её как факт.
const PEARL_STYLE = process.env.ND_PEARL_STYLE || 'foxhole'
const pearlTrips = { seconds: 0, pearls: 0, zero: 0 }
// Пустые места (2 захода без эндерменов в виду): лес в 48 бл. от них не берём снова; запись глаз хранит и другие увиденные леса (alts).
const emptyForests = []
const forestEmpty = p => emptyForests.some(e => Math.hypot(e.x - p.x, e.z - p.z) < 48)
function forestToHunt () {
  const rec = memorySnapshot?.places?.['искажённый лес (ад)']
  // Место, откуда глаза видели больше всего эндерменов разом (nether-forest.js), — первым: окоп отдаёт столько, сколько видно с места.
  const em = memorySnapshot?.places?.['эндермены (ад)']
  const seenAt = em && Number.isFinite(em.x) && (em.count || 0) >= 3 ? [{ ...em, score: 1000 + em.count }] : []
  if (!rec && !seenAt.length) return null
  const all = [...seenAt, ...(rec ? [rec, ...(Array.isArray(rec.alts) ? rec.alts : [])] : [])].filter(f => f && Number.isFinite(f.x) && !forestEmpty(f))
  return all.sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null
}
function endermenSecondsPerPearl () {
  if (pearlTrips.zero >= 2) return 3600
  const prior = forestToHunt() ? 240 : 900
  return (pearlTrips.seconds + prior * 2) / (pearlTrips.pearls + 2)
}

defStage('eyes', () => have('ender_eye') < eyesWant() && have('ender_pearl') > 0 && (have('blaze_rod') + have('blaze_powder')) > 0, async () => {
  const want = Math.min(eyesWant() - have('ender_eye'), have('ender_pearl'))
  if (have('blaze_powder') < want) await craft('blaze_powder', Math.min(2 * have('blaze_rod'), want - have('blaze_powder') + 1))
  await craft('ender_eye', Math.min(want, have('blaze_powder')))
})

async function arrowsRun (want = 48) {
  const t0 = gameClock.now()
  for (let k = 0; k < 24 && arrowsNow() < want && !died && gameClock.now() - t0 < 12 * 60000; k++) {
    await nightGuard()
    await refresh()
    if (have('stick') < 1) await sticks(4)
    if (!have('flint')) {
      if (have('gravel')) {
        const p = await act('place', { block: 'gravel' })
        if (p.status === 'done') { await act('mine', { block: 'gravel', dry: true, count: 1, radius: 6, timeoutSeconds: 20 }); continue }
      }
      const g = await act('mine', { block: 'gravel', dry: true, count: 8, radius: 40, timeoutSeconds: 120 })
      if (!(g.detail && g.detail.dug)) {
        const e = await act('explore', { block: 'gravel', dry: true, radius: 48, stepDistance: 60, timeoutSeconds: 90 })
        if (!(e.detail && e.detail.found)) break
      }
      continue
    }
    if (!have('feather')) {
      const o = await act('observe', { radius: 64 })
      const hen = ((o.detail && o.detail.entities) || []).find(e => /^chicken$/i.test(String(e.name || '')))
      if (hen) {
        if ((hen.dist ?? 0) > 20 && hen.pos) await act('goto', { x: hen.pos.x, z: hen.pos.z, range: 8, timeoutSeconds: 45, surface: 'strict' })
        for (let j = 0; j < 4 && !have('feather'); j++) {
          const f = await act('fight', { target: 'chicken', timeoutSeconds: 30, retreatAtHealth: 0 })
          if (f.status !== 'done') break
          await refresh()
        }
      } else await walkAway(64, 0)
      continue
    }
    const c: any = await craft('arrow', 4)
    await refresh()
    if (c && c.status && c.status !== 'done') break
  }
  log(`стрелы: ${arrowsNow()} (перьев ${have('feather')}, кремня ${have('flint')})`)
}

const BEDS_END = 5 // 03.10: с кристаллами 4 кровати — 18/21 и 18/21 (ca3, проверка xda1), берём 4 + 1 запас
const OBSIDIAN_END = 4
const obsidianEnd = () => have('obsidian') + have('crying_obsidian')
const ARROWS_END = 32
// Одно ведро воды — допуск (клатч, МЛГ); второе — не повод охотиться за железом посреди пути к крепости (s5c-f4-1 06.10:
// ведро ушло на клатч по дороге → endkit «mine iron_ore» и разведка 11 мин). Бой с драконом воду не требует (dragon missing()).
const BUCKETS_END = 1
const FILL_END = 108
const END_FILL_RE = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone)$/
const fillNow = () => have(END_FILL_RE)
// Блоки на Край — до комнаты крепости не держат её поиск (s5c 06.10, f1-3/e02: мосты по пути съели набор, endkit копал
// камень у моря 20+ мин и в затопленной шахте): шахта к комнате сама даёт камень. Полный запас — к входу в Энд
// (known.endPortal: endkit копает под землёй у комнаты). Кровати, обсидиан, вода, лодка — как были.
const fillWant = () => known.endPortal ? FILL_END : 0
// Вода — так же: до комнаты не держит поиск крепости (у комнаты под землёй железо рядом).
const waterWant = () => known.endPortal ? BUCKETS_END : 0
const arrowsNow = () => have('arrow') + have('spectral_arrow')
let endkitRuns = 0
const ENDKIT_OFF = process.env.ND_ENDKIT === '0'
const END_SEAM = process.env.ND_END_SEAM !== '0'
function endCoreLack () {
  return [
    have(/_bed$/) < BEDS_END ? `beds:${have(/_bed$/)}/${BEDS_END}` : '',
    obsidianEnd() < OBSIDIAN_END ? `obsidian:${obsidianEnd()}/${OBSIDIAN_END}` : '',
    have('water_bucket') < waterWant() ? `water:${have('water_bucket')}/${waterWant()}` : '',
    fillNow() < fillWant() ? `blocks:${fillNow()}/${fillWant()}` : ''
  ].filter(Boolean)
}
async function checkEndEntry () {
  if (!END_SEAM || ENDKIT_OFF) return
  // Еда и отдых — до 3 заходов: у комнаты еду рвёт тактика (чешуйницы), один отказ ещё не голод (S5d s5d-N-5: «hunger 17/18» → БЛОКЕР).
  for (let k = 0; k < 3 && !died; k++) {
    await eatTo(18)
    if ((state.health ?? 0) < 16) await rest()
    await refresh()
    if ((state.food ?? 0) >= 18 && (state.health ?? 0) >= 16) break
  }
  if (died) return
  const lackNow = () => [...endCoreLack(),
    have(FOOD) < FOOD_STOCK ? `food:${have(FOOD)}/${FOOD_STOCK}` : '',
    !have(/_sword$/) ? 'sword:0/1' : '',
    !have(/^(iron|diamond|netherite)_pickaxe$/) ? 'pick:0/1' : '',
    (state.health ?? 0) < 16 ? `hp:${state.health ?? 0}/16` : '',
    (state.food ?? 0) < 18 ? `hunger:${state.food ?? 0}/18` : ''
  ].filter(Boolean)
  let lack = lackNow()
  // Снимок рюкзака бывает пустым посреди клика окна (s5d-R-7/R-9 07.10: «food:0/8» при 15 стейках, «sword:0/1» с мечом в руке) —
  // при любой нехватке перечитать один раз, прежде чем стоп.
  if (lack.length) { await act('wait', { seconds: 1 }); await refresh(); lack = lackNow() }
  // Хп, сытость и запас еды — цена входа, а не допуск (гибкость, AGENTS.md 06.10): хп ≥ 10 и хоть 2 еды — вхожу с отметкой риска.
  const soft = lack.filter(x => /^(hp|hunger|food):/.test(x))
  if (soft.length && soft.length === lack.length && (state.health ?? 0) >= 10 && have(FOOD) >= 2) {
    log(`РИСК END_SEAM: ${soft.join(', ')} — вхожу (цена, не допуск)`)
    lack.length = 0
  }
  // Нехватка снаряжения (блоки, кровати, обсидиан станции, вода, меч, кирка) — тоже цена (S5e 07.10, правило гибкости): сборы
  // endkit уже исчерпаны (3 захода) или их нет, а стоп у портала — такой же провал прогона, как неудачный бой (s5d-O-2/O-3: «blocks
  // 101/108», «47/108» → БЛОКЕР). Стоп — только физически без средства боя: ни кровати, ни лука со стрелами, ни меча/топора.
  // ND_END_GEAR_PRICE=0 — прежний стоп.
  if (lack.length && process.env.ND_END_GEAR_PRICE !== '0') {
    const canHurt = have(/_bed$/) > 0 || (have('bow') && arrowsNow() > 0) || have(/_(sword|axe)$/) > 0
    if (canHurt) {
      if ((state.health ?? 0) < 10) { await rest(); await refresh() }
      log(`РИСК END_SEAM: ${lack.join(', ')} — вхожу (снаряжение — цена: сборов ${endkitRuns}/3, кроватей ${have(/_bed$/)}, стрел ${arrowsNow()}, меч ${have(/_sword$/) ? 'есть' : 'нет'})`)
      lack.length = 0
    }
  }
  if (lack.length) {
    const msg = `END_SEAM_NOT_READY: ${lack.join(', ')}; сборов ${endkitRuns}/3 — в Энд не вхожу`
    log(`БЛОКЕР: ${msg}`)
    throw Object.assign(new Error(msg), { stopCampaign: true, code: 'END_SEAM_NOT_READY' })
  }
  if (!have('bow') || arrowsNow() < ARROWS_END || have(/^(enchanted_)?golden_apple$/) < 3) {
    log(`РИСК END_PROFILE: лук ${have('bow')}, стрел ${arrowsNow()}/${ARROWS_END}, яблок ${have(/^(enchanted_)?golden_apple$/)}/3; броня ${JSON.stringify(state.armor || {})} — это не набор campaign2 с Protection II`)
  }
}
const endkitPending = () => END_SEAM
  ? !ENDKIT_OFF && !known.dragonWon && dim() === 'overworld' && endkitRuns < 3 &&
    (!!known.endPortal || have('ender_eye') >= EYES_NEED ||
      (have('ender_eye') + have('ender_pearl') >= EYES_NEED && have(/^(blaze_rod|blaze_powder)$/) > 0)) &&
    (endCoreLack().length > 0 || (!known.endPortal && !have(/_boat$/)))
  : !ENDKIT_OFF && !known.dragonWon && !known.endPortal && have('ender_eye') + have('ender_pearl') >= EYES_NEED &&
    rodsNow() >= 6 && endkitRuns < 3 && (have(/_bed$/) < BEDS_END || obsidianEnd() < OBSIDIAN_END || have('water_bucket') < BUCKETS_END || !have(/_boat$/) || fillNow() < FILL_END)
defStage('endkit', () => endkitPending() && dim() === 'overworld', async () => {
  endkitRuns++
  await nightGuard()
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  const bucketsLack = () => Math.max(0, waterWant() - have('water_bucket') - have(/^bucket$/))
  if (bucketsLack() > 0) {
    await refresh()
    const ironWant = () => 3 * bucketsLack()
    for (let k = 0; k < 5 && have('iron_ingot') + have('raw_iron') < ironWant() && !died; k++) {
      await nightGuard()
      const m = await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: ironWant() - have('iron_ingot') - have('raw_iron'), radius: 48, timeoutSeconds: 150 })
      if (m.detail && m.detail.dug) continue
      await mineSeenAll('iron_ore,deepslate_iron_ore', 48)
      if (have('iron_ingot') + have('raw_iron') >= ironWant()) break
      const e = await act('explore', { block: 'iron_ore', radius: 48, stepDistance: 60, timeoutSeconds: 120 })
      if (!(e.detail && e.detail.found)) break
    }
    await smeltAll('raw_iron', 'iron_ingot')
    for (let k = 0; k < BUCKETS_END && bucketsLack() > 0 && have('iron_ingot') >= 3; k++) { await craft('bucket'); await refresh() }
  }
  for (let k = 0; k < BUCKETS_END && have(/^bucket$/) && have('water_bucket') < BUCKETS_END && !died; k++) {
    const n = have('water_bucket')
    await act('bucket', { fluid: 'water', radius: 48 })
    await refresh()
    if (have('water_bucket') <= n) break
  }
  if (fillNow() < fillWant()) {
    const m = await act('mine', { block: 'stone,deepslate,andesite,diorite,granite,tuff', count: Math.min(64, fillWant() - fillNow()), radius: 24, timeoutSeconds: 120 })
    await refresh()
    log(`блоки на Край: ${fillNow()} из ${fillWant()}${m.detail && m.detail.dug ? '' : ' (не добыл)'}`)
  }
  for (let k = 0; k < 2 && have('golden_apple') < 2 && have('apple') > 0 && have('gold_ingot') + 9 * have('gold_block') >= 8 && !died; k++) {
    if (have('gold_ingot') < 8 && have('gold_block')) await craft('gold_ingot', 9)
    const n = have('golden_apple')
    await craft('golden_apple')
    await refresh()
    if (have('golden_apple') <= n) break
  }
  if (have(/_bed$/) < BEDS_END) {
    const l = await act('structure', { mode: 'list' })
    const v = ((l.detail && l.detail.known) || []).filter(x => x.kind === 'village' && x.dist != null && x.dist < 800).sort((a, b) => a.dist - b.dist)[0]
    if (v) {
      log(`за кроватями — деревня ${v.at.x},${v.at.z} (${v.dist} бл.)`)
      for (let k = 0; k < 8 && !died; k++) { await nightGuard(); if (await goToward(v.at, 24)) break }
      await act('structure', { mode: 'explore', kind: 'village', x: v.at.x, z: v.at.z, beds: BEDS_END, timeoutSeconds: 240 })
      await refresh()
      log(`деревня: кроватей ${have(/_bed$/)}`)
    }
  }
  if (have(/_bed$/) < BEDS_END) {
    wantBeds = BEDS_END
    huntWool = true
    try { await stageRun('food')() } finally { huntWool = false }
    for (let k = 0; k < BEDS_END && have(/_bed$/) < BEDS_END; k++) {
      const n = have(/_bed$/)
      if (have(/_planks$/) < 3 && !have(LOGS)) await lumber(2)
      await makeBed()
      await refresh()
      if (have(/_bed$/) <= n) break
    }
    wantBeds = 1
  }
  if (!have('bow') && have('string') >= 3) { await sticks(3); await craft('bow') }
  for (let k = 0; k < 8 && arrowsNow() < ARROWS_END && have('feather') && !died; k++) {
    if (!have('flint')) {
      const g = await act('mine', { block: 'gravel', dry: true, count: 6, radius: 40, timeoutSeconds: 120 })
      if (!(g.detail && g.detail.dug)) break
      await refresh()
      if (!have('flint')) continue
    }
    await sticks(2)
    const c: any = await craft('arrow', 4)
    if (c && c.status !== 'done') break
  }
  if (!have(/_boat$/)) {
    if (have(/_planks$/) < 5 && !have(LOGS)) await lumber(3)
    if (have(/_planks$/) < 5) { const p = planksFor(); if (p) await craft(p, 8) }
    await act('ride', { kind: 'boat', mode: 'craft' })
    await refresh()
  }
  if (obsidianEnd() < OBSIDIAN_END && have(/^(diamond|netherite)_pickaxe$/) && !died) {
    await act('obsidian', { count: OBSIDIAN_END - obsidianEnd(), radius: 24, timeoutSeconds: 300 })
  }
  log(`набор на дракона: кроватей ${have(/_bed$/)}, обсидиана ${obsidianEnd()}, стрел ${arrowsNow()}, вёдер воды ${have('water_bucket')}, блоков ${fillNow()}, золотых яблок ${have('golden_apple')}, лук ${have('bow') ? 'есть' : 'нет'}, лодка ${have(/_boat$/) ? 'есть' : 'нет'}`)
})

// К крепости Края через Ад — по умолчанию (S5d 07.10, ND_SH_NETHER=0 — пешком поверху): при раме (10 обсидиана или алмазная кирка)
// и огниве выход у крепости. s5d-H (10 сидов, пошаговый): путь до крепости медиана 5.1 игр. мин против 13.4 поверху у S5c (s5c-f2..g3),
// смертей в Аду на этом участке 0. Цели бартера на раму (EXIT_KIT, obsidian 10 в бастионе) по-прежнему за ND_SH_NETHER=1 / ND_EXIT_KIT.
const SH_NETHER = process.env.ND_SH_NETHER !== '0'
const SH_BLIND = process.env.ND_SH_BLIND === '1'
const SH_NETHER_MIN = 500
let shNetherTries = 0
const atExitTarget = () => process.env.ND_EXIT_LOCAL_RETRY !== '0' && dim() === 'the_nether' && known.stronghold && state.pos &&
  Math.hypot(state.pos.x - Math.floor(known.stronghold.x / 8), state.pos.z - Math.floor(known.stronghold.z / 8)) <= 12
const canLink = () => pendingExitFrame() || ((shNetherTries < 2 || atExitTarget()) && lighter() && (have('obsidian') >= 10 || have(PICK_DIAMOND) > 0))
async function prepareExitSupply (T) {
  await refresh(); await sense()
  const n = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
  const me = state.pos || n
  const want = Math.ceil(2 * (Math.abs(n.x - me.x) + Math.abs(n.z - me.z))) + 128
  if ((sit.pickLeft || 0) >= want && have('crafting_table')) return true
  const until = gameClock.now() + 180000
  const step = async (method, args = {}) => {
    if (died || gameClock.now() >= until) return null
    const p: any = { ...args }
    if (p.timeoutSeconds) p.timeoutSeconds = Math.max(1, Math.min(p.timeoutSeconds, Math.floor((until - gameClock.now()) / 1000)))
    const r = await act(method, p); await refresh(); return r
  }
  log('набор на выход: пополнение ≤180 с; сначала сундуки и железо, затем чёрный камень; дерево из сундука ≤20 с, стебли ≤60 с')
  if (sit.foes) {
    const r = await step('ne_burrow', { why: 'набор на выход: крафт под укрытием', timeoutSeconds: 30 })
    if (!r?.detail?.ok) { log('набор на выход: укрытие не подтвердилось — пополнение не начинаю'); return false }
    await sense()
  }
  for (let k = 0; k < 2; k++) {
    const iron = have('iron_block') * 9 + Math.floor(have('iron_nugget') / 9)
    if (!iron) break
    const before = have('iron_ingot'); await step('craft', { item: 'iron_ingot', count: iron })
    if (have('iron_ingot') <= before) break
  }
  await sense()
  const deficit = Math.max(0, want - (sit.pickLeft || 0))
  const ironPicks = Math.min(Math.floor(have('iron_ingot') / 3), Math.ceil(deficit / 250))
  const stonePicks = Math.ceil(Math.max(0, deficit - ironPicks * 250) / 131)
  const picks = ironPicks + stonePicks
  if (picks > 8) { log(`набор на выход: нужно ${picks} кирок — отдельный путь пополнения, один крафт не решит`); return false }
  const planksNeeded = () => (!have('crafting_table') ? 4 : 0) + 2 * Math.ceil(Math.max(0, 2 * picks - have('stick')) / 4)
  if (have(/_planks$/) + 4 * have(LOGS) < planksNeeded()) {
    await step('chest_take', { item: 'all', timeoutSeconds: 20 })
    if (have(/_planks$/) + 4 * have(LOGS) < planksNeeded()) await step('mine', {
      block: 'crimson_stem,warped_stem', count: Math.ceil((planksNeeded() - have(/_planks$/)) / 4), radius: 32, timeoutSeconds: 60
    })
  }
  while (!died && gameClock.now() < until && have(/_planks$/) < planksNeeded() && have(LOGS)) {
    const item = planksFor(); if (!item) break
    const before = have(/_planks$/); await step('craft', { item, count: 4 })
    if (have(/_planks$/) <= before) break
  }
  if (!have('crafting_table') && have(/_planks$/) >= 4) await step('craft', { item: 'crafting_table', count: 1 })
  if (!have('crafting_table')) return false
  const sticks = 4 * Math.ceil(Math.max(0, 2 * picks - have('stick')) / 4)
  if (sticks && have(/_planks$/) >= sticks / 2) await step('craft', { item: 'stick', count: sticks })
  for (let i = 0; i < picks && !died && gameClock.now() < until; i++) {
    await sense()
    if ((sit.pickLeft || 0) >= want) break
    if (have('iron_ingot') < 3 && have(COBBLE) < 3) await step('mine', {
      block: 'blackstone', count: Math.max(3, 3 * stonePicks - have(COBBLE)), radius: 16, timeoutSeconds: 45
    })
    const item = have('iron_ingot') >= 3 ? 'iron_pickaxe' : have(COBBLE) >= 3 ? 'stone_pickaxe' : null
    if (!item || have('stick') < 2) break
    const before = have(item); await step('craft', { item, count: 1 })
    if (have(item) <= before) break
  }
  await refresh(); await sense()
  const ok = !died && (sit.pickLeft || 0) >= want && !!have('crafting_table')
  log(`набор на выход: удары ${sit.pickLeft || 0}/${want}, верстак ${have('crafting_table')}, палки ${have('stick')}; ${ok ? 'готов' : 'пополнение не завершено за один бюджет'}`)
  return ok
}
async function prepareExitTools (T) {
  if (process.env.ND_EXIT_SUPPLY !== '0' && state.dimension === 'the_nether') return prepareExitSupply(T)
  await refresh(); await sense()
  const n = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
  const me = state.pos || n
  const want = Math.ceil(2 * (Math.abs(n.x - me.x) + Math.abs(n.z - me.z))) + 128
  // Враг рядом — крафт не начинаю, но и путь через Ад не отменяю, если взмахов кирок хватает хотя бы на 60 % (докрафт — в Аду,
  // prepareExitSupply/restockPicks): s5d-N-1 07.10 — моб у портала на старте, «сначала закончить бой» → 1461 бл. пешком.
  if (sit.foes) { const ok = (sit.pickLeft || 0) >= 0.6 * want; log(`набор на выход: рядом враг — крафт не начинаю; взмахов ${sit.pickLeft || 0}/${want}${ok ? ', хватит — иду' : ''}`); return ok }
  const needPicks = Math.max(0, Math.ceil((want - (sit.pickLeft || 0)) / 131))
  let planks = (!have('crafting_table') ? 4 : 0) + 2 * Math.ceil(Math.max(0, 2 * needPicks + 12 - have('stick')) / 4)
  while (have(/_planks$/) < planks && have(LOGS) && !died) {
    const item = planksFor(); if (!item) break
    const before = have(/_planks$/)
    await act('craft', { item, count: 4 }); await refresh()
    if (have(/_planks$/) <= before) break
  }
  if (!have('crafting_table') && have(/_planks$/) >= 4) await act('craft', { item: 'crafting_table', count: 1 })
  await refresh()
  if (!have('crafting_table')) { log('набор на выход: нет переносного верстака — остаюсь до пополнения'); return false }
  if (have('stick') < 2 * needPicks + 12 && have(/_planks$/) >= 2) await act('craft', { item: 'stick', count: 4 * Math.ceil((2 * needPicks + 12 - have('stick')) / 4) })
  for (let i = 0; i < needPicks && !died && have(COBBLE) >= 3 && have('stick') >= 2; i++) {
    const before = have('stone_pickaxe')
    await act('craft', { item: 'stone_pickaxe', count: 1 }); await refresh()
    if (have('stone_pickaxe') <= before) break
  }
  await sense(); await refresh()
  // Взмахов кирок на дорогу хватает — иду и без верстака/палок (запас на ремонт — цена, а не допуск; s5d-H-3 07.10: «верстак сломал,
  // но подобрать не успел» при 774/654 взмахах → 1435 бл. пешком).
  const ok = (sit.pickLeft || 0) >= want && (process.env.ND_EXIT_SUPPLY !== '0' || (have('stick') >= 12 && !!have('crafting_table')))
  log(`набор на выход: обсидиан ${have('obsidian')}/10, огонь ${lighter() ? 'есть' : 'нет'}, удары кирок ${sit.pickLeft || 0}/${want}, палки ${have('stick')}/12, верстак ${have('crafting_table')}; ${ok ? 'готов' : 'нужно пополнить, пешком домой не иду'}`)
  return ok
}
async function viaNetherTo (T, why) {
  if (EXIT_KIT) {
    await refresh()
    const kit = exitKitNow()
    const resuming = pendingExitFrame() && exitFrameTarget.x === T.x && exitFrameTarget.z === T.z
    if (!kit.ready && !resuming) { log(`${why}: набор на выход не готов: ${JSON.stringify(kit.need)} — до точки Края не иду`); return false }
    if (!resuming && !(await prepareExitTools(T))) return false
  }
  shNetherTries++
  const N = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
  log(`${why}: через Ад к ${T.x},${T.z} — точка Ада ${N.x},${N.z}; обсидиана ${have('obsidian')}, огниво ${lighter() ? 'есть' : 'нет'}`)
  if (dim() === 'overworld') {
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
    }
    let e = await enterNether()
    await refresh()
    // Не дошёл до своего портала в 48 бл. (джунгли: лоза и листва — «stuck» на месте, s5e-A-3 07.10: 1456 бл. поверху и море у
    // крепости вместо 180 бл. Ада) — ещё раз через goto к раме (копает листву), прежде чем отказаться от пути через Ад.
    if (dim() === 'overworld' && known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) <= 48 && !died) {
      log(`${why}: в портал не вошёл (${(e.detail && e.detail.stopped) || e.error || 'нет'}) — ещё раз к раме`)
      await act('goto', { x: known.portal.x, y: known.portal.y, z: known.portal.z, range: 2, timeoutSeconds: 60 })
      e = await enterNether()
      await refresh()
    }
    if (!(e.detail && e.detail.went) || dim() !== 'the_nether') { log(`${why}: в Ад не вошёл`); return false }
  }
  if (dim() !== 'the_nether') return false
  if (have('obsidian') >= 10) {
    // В 3 бл. от точки Ада, а не в 6: рама в 6–7 бл. — выход наверху в 50–80 бл. от крепости (S5d s5d-p4/p5).
    // Рама выхода повыше (y 80–112): сервер ставит выход наверху у ближайшей к (8x, y, 8z) годной точки — с рамы на y 23–65
    // выход попадал в пещеры у крепости (s5d-p5-1: вода и зомби; s5d-N-1: капельник), с высокой — на поверхность. ND_EXIT_HIGH=0 — выкл.
    await goToward({ x: N.x, z: N.z, ...(process.env.ND_EXIT_HIGH !== '0' ? { ry: 96, rdy: 16 } : {}) }, 3)
    await refresh()
    if (died || dim() !== 'the_nether') return false
    // Сетка не довела, а до точки ≤ 60 бл. (goToward штрекует только дальше 60) — штрек к точке: s5d-H-8 07.10 — «по сетке дальше пути
    // нет» в 24 бл., link пешком «pathfinder не нашёл» 4.5 игр. мин, потом домой и поверху.
    const left = state.pos ? Math.hypot(state.pos.x - N.x, state.pos.z - N.z) : 0
    if (left > 8 && left <= 60) {
      await act('nether_tunnel', { x: N.x, z: N.z, radius: 4, ironOk: !nextBastion(), timeoutSeconds: Math.round(120 + left * 3) })
      await refresh()
      if (died || dim() !== 'the_nether') return false
    }
  }
  // Точка выхода у бастиона (S5e 07.10, честно — по видимому: блоки бастиона в памяти глаз в 32 бл., брут видим/слышим): рама там —
  // бруты (s5d-R-3/T-3, s5e-M-3/G-3 на сиде −7145914149339214824: «slain by Piglin Brute»). Отойти от центра увиденного бастиона на
  // 40 бл. (в Аду; наверху это ~320 бл. дальше от крепости — дешевле смерти) и раму ставить там. ND_EXIT_BASTION=0 — прежнее.
  let TT = T
  if (dim() === 'the_nether' && process.env.ND_EXIT_BASTION !== '0' && state.pos && !died) {
    const sb = await act('perceive', { mode: 'seen', re: '^(gilded_blackstone|polished_blackstone_bricks|cracked_polished_blackstone_bricks|chiseled_polished_blackstone|polished_blackstone_brick_(slab|stairs|wall))$', max: 40, maxDist: 32 })
    const en = await act('perceive', { mode: 'entities', radius: 24 })
    const seen = (sb.detail && sb.detail.seen) || []
    const brutes = ((en.detail && en.detail.entities) || []).filter(e => e && /piglin_brute/.test(e.name || ''))
    if (seen.length >= 3 || brutes.length) {
      const pts = seen.length ? seen : brutes.map(e => e.pos || e.lastPos).filter(Boolean)
      const C = pts.length ? { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, z: pts.reduce((s, q) => s + q.z, 0) / pts.length } : state.pos
      const N0 = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
      let dx = N0.x - C.x; let dz = N0.z - C.z
      const L = Math.hypot(dx, dz)
      if (L < 1) { dx = -(T.z / 8 - state.pos.z); dz = T.x / 8 - state.pos.x }
      const n = Math.hypot(dx, dz) || 1
      const N2 = { x: Math.round(C.x + dx / n * 40), z: Math.round(C.z + dz / n * 40) }
      log(`${why}: у точки выхода бастион (блоков ${seen.length}, брутов ${brutes.length}) — рама в 40 бл. от него: точка Ада ${N2.x},${N2.z}`)
      await goToward({ x: N2.x, z: N2.z }, 3)
      await refresh()
      if (died || dim() !== 'the_nether') return false
      TT = { x: N2.x * 8 + 4, z: N2.z * 8 + 4 }
    }
  }
  for (let k = 0; k < 2 && dim() === 'the_nether' && !died; k++) {
    const obsBefore = have('obsidian')
    const t = await act('stronghold', { mode: 'travel', x: TT.x, z: TT.z, go: false, timeoutSeconds: 420 })
    await refresh()
    const td = t.detail || {}
    if (dim() === 'the_nether' && have('obsidian') < obsBefore && (td.build || td.link)) exitFrameTarget = { ...TT }
    if (dim() === 'overworld') exitFrameTarget = null
    log(`${why}: travel — ${dim() === 'overworld' ? 'вышел наверх' : 'ещё в Аду'}${td.stopped ? ': ' + td.stopped : ''}`)
  }
  await readMemory()
  return dim() === 'overworld' && !!state.pos && Math.hypot(T.x - state.pos.x, T.z - state.pos.z) <= (TT === T ? 160 : 480)
}
defStage('stronghold', () => dim() !== 'the_end' && (have('ender_eye') >= Math.min(10, EYES_NEED) || !!known.endPortal) && (!known.endPortal || process.env.ND_END_ENTRY !== '0') && !endkitPending(), async () => {
  if (known.endPortal && process.env.ND_END_ENTRY !== '0') {
    if (dim() !== 'overworld') return
    notePortalEyes(await act('stronghold', { mode: 'room', timeoutSeconds: 120 }))
    notePortalEyes(await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 90 }))
    await refresh()
    return
  }
  if (dim() === 'the_nether') {
    const stay = process.env.ND_SH_STAY === '1' || process.env.ND_END_ENTRY !== '0'
    let out = false
    if (obsShort() && (EXIT_KIT || (nextBastion() && bastionDry < 3))) {
      log(`выход у крепости Края — нужно 10 обсидиана, есть ${have('obsidian')}: сперва бартер (ND_OBS_EXIT)`)
      return
    }
    if (SH_NETHER && known.stronghold && canLink()) {
      out = await viaNetherTo({ x: known.stronghold.x, z: known.stronghold.z }, 'к крепости Края')
      if (out && !stay) return
    } else if (SH_BLIND && !known.stronghold && canLink() && state.pos) {
      const b = await act('stronghold', { mode: 'blind' })
      const plan = (b.detail && b.detail.overworld) ? b.detail : null
      out = !!(plan && await viaNetherTo(plan.overworld, `слепой выход (в среднем ~${plan.expectThere} бл. до крепости)`))
      if (out && !stay) return
    }
    if (!out || dim() !== 'overworld') {
      if (EXIT_KIT && SH_NETHER && known.stronghold) { log('переход у комнаты не закончен — продолжаю отсюда, путь домой не начинаю'); return }
      if (dim() === 'the_nether') await returnFromNether()
      return
    }
    log('у крепости Края: дальше в этом же ходе (ND_SH_STAY)')
    if (END_SEAM && endkitPending()) { log('перед комнатой — сборы на дракона здесь, наверху'); return }
  }
  if (have(/_bed$/)) await act('sleep', { mode: 'take' })
  if (!known.stronghold) {
    const r = await act('stronghold', { mode: 'find', timeoutSeconds: 400 })
    if (r.detail && (r.detail.at || r.detail.estimate)) known.stronghold = r.detail.at || r.detail.estimate
  }
  if (SH_NETHER && known.stronghold && state.pos && dim() === 'overworld' && !died && canLink() &&
    Math.hypot(known.stronghold.x - state.pos.x, known.stronghold.z - state.pos.z) > SH_NETHER_MIN) {
    await viaNetherTo({ x: known.stronghold.x, z: known.stronghold.z }, 'к крепости Края')
    await refresh()
    if (dim() === 'the_nether') { await returnFromNether(); return }
  }
  for (let k = 0; k < 6 && known.stronghold && state.pos && !died && dim() === 'overworld'; k++) {
    await refresh()
    const far = Math.hypot(known.stronghold.x - state.pos.x, known.stronghold.z - state.pos.z)
    if (far <= 160) break
    log(`к крепости ${known.stronghold.x},${known.stronghold.z}: ${Math.round(far)} блоков`)
    await nightGuard()
    await recoverGuard()
    if ((state.health ?? 20) < 12 && have(FOOD)) await act('eat')
    await goToward({ x: known.stronghold.x, z: known.stronghold.z }, 150)
  }
  if (!END_SEAM && known.stronghold && state.pos && dim() === 'overworld' && have(/_bed$/) >= 2) {
    await readMemory()
    const sb = known.spawnBed
    const nearS = Math.hypot(known.stronghold.x - state.pos.x, known.stronghold.z - state.pos.z) <= 200
    const sbNear = sb && Math.hypot(sb.x - known.stronghold.x, sb.z - known.stronghold.z) <= 220
    if (nearS && !sbNear) await act('sleep', { mode: 'spawn', why: 'у крепости Края' })
  }
  for (let i = 0; i < 6 && !known.endPortal; i++) {
    await recoverGuard()
    if (died) return
    if (dim() === 'overworld') { await sense(); if (sit.surface) await nightGuard() }
    const r = await act('stronghold', { mode: 'room', timeoutSeconds: 500 })
    notePortalEyes(r)
    if (r.detail && r.detail.room) { known.endPortal = r.detail.room.centre || r.detail.room; break }
    if (process.env.ND_ROOM_MAP !== '0' && require(path.join(__dirname, 'src/stronghold')).mappedRoom(known.stronghold)) {
      log(`подход к комнате по карте остановлен: ${(r.detail || {}).stopped || r.error || 'нет прогресса'} — одинаковый вызов в этом ходе не повторяю`)
      break
    }
    const went = r.detail && r.detail.went
    const ocean = went && went.ocean
    if (ocean && ocean.onTheWay && detours < 2 && known.stronghold && state.pos) {
      const S = known.stronghold
      const me = state.pos
      const mx = (me.x + S.x) / 2; const mz = (me.z + S.z) / 2
      const d = Math.hypot(S.x - me.x, S.z - me.z) || 1
      const side = detours === 0 ? 1 : -1
      const P = { x: Math.round(mx - (S.z - me.z) / d * 150 * side), z: Math.round(mz + (S.x - me.x) / d * 150 * side) }
      detours++
      log(`на прямой к крепости море — крюк через ${P.x},${P.z}`)
      for (let k = 0; k < 6 && !died; k++) { if (dim() === 'overworld') await nightGuard(); if (await goToward(P, 12)) break }
      continue
    }
    if (ocean && !ocean.onTheWay && Array.isArray(ocean.alternatives) && ocean.alternatives.length && !altTried) {
      altTried = true
      const me = state.pos || { x: 0, z: 0 }
      const pts = ocean.alternatives.map(a => { const b = a.bearingDeg * Math.PI / 180; return { x: Math.round(1900 * Math.sin(b)), z: Math.round(1900 * Math.cos(b)) } })
        .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - Math.hypot(b.x - me.x, b.z - me.z))
      const P = pts[0]
      log(`крепость под морем — иду к другой крепости кольца: точка ${P.x},${P.z} (${Math.round(Math.hypot(P.x - me.x, P.z - me.z))} бл.)`)
      for (let k = 0; k < 8 && !died; k++) {
        if (dim() === 'overworld') await nightGuard()
        const t = await act('stronghold', { mode: 'travel', x: P.x, z: P.z, go: false, timeoutSeconds: 500 })
        if (t.detail && t.detail.arrived) break
        await recoverGuard()
      }
      const f = await act('stronghold', { mode: 'find', timeoutSeconds: 400 })
      if (f.detail && (f.detail.at || f.detail.estimate)) known.stronghold = f.detail.at || f.detail.estimate
      log(`новая крепость: ${JSON.stringify(known.stronghold)}`)
    }
  }
  if (known.endPortal && process.env.ND_END_ENTRY !== '0' && !died && dim() === 'overworld') {
    const r = await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 90 })
    notePortalEyes(r)
    await refresh()
    log(`вход в Энд после комнаты: ${(r.detail || {}).entered && dim() === 'the_end' ? 'подтверждён' : 'не завершён'}`)
  }
})
let altTried = false
let detours = 0

DONE.prep = () => shieldOn() && lighter() && foodUnits() >= FOOD_STOCK && (spawnAtPortal() || have(/_bed$/) > 0)
DONE.nether = () => !rodsWanted()
DONE.bastion = () => pearlsNow() >= eyesWant() && !obsShort()
DONE.pearls = () => have('ender_pearl') + have('ender_eye') >= eyesWant()
DONE.eyes = () => have('ender_eye') >= eyesWant()
DONE.endkit = () => have(/_bed$/) >= BEDS_END && obsidianEnd() >= OBSIDIAN_END && have('water_bucket') >= waterWant() &&
  have(/_boat$/) > 0 && fillNow() >= fillWant()
DONE.stronghold = () => process.env.ND_END_ENTRY !== '0' ? dim() === 'the_end' : !!known.endPortal

defStage('dragon', () => !known.dragonWon && (dim() === 'the_end' || !!known.endPortal), async () => {
  if (dim() !== 'the_end') {
    if (dim() === 'the_nether' && !(await returnFromNether())) return
    const E = known.endPortal
    for (let k = 0; k < 8 && E && state.pos && !died && Math.hypot(E.x - state.pos.x, E.z - state.pos.z) > 12; k++) {
      await nightGuard()
      await goToward(E, 4)
      await refresh()
    }
    await act('kit', { for: 'end' })
    if (!END_SEAM && have(/_bed$/) >= 2) await act('sleep', { mode: 'spawn', why: 'у портала в Энд' })
    await checkEndEntry()
    if (died) return
    const f = await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 200 })
    notePortalEyes(f)
    if (!(f.detail && f.detail.entered)) throw new Error('в Энд не вошёл')
  }
  let dragonHp = null
  for (let i = 0; i < 6 && !known.dragonWon; i++) {
    if (died || dim() !== 'the_end') return
    // Кровати кончились — бой не бросать: лук по кристаллам и меч по сидящему (режим full; S5d s5d-N-2 07.10: 5 кроватей мимо
    // головы, навык «ни шагу» без кроватей ×6, граф ушёл в legacy-этап nether прямо в Энде). ND_DRAGON_FALLBACK=0 — прежнее.
    const noBeds = !have(/_bed$/) && process.env.ND_DRAGON_FALLBACK !== '0'
    // S5e (07.10): без кроватей — оценка, а не безусловный бой (s5d-T-5: full с 20 хп дракона — «killed by Ender Dragon using magic»;
    // T-6: кровати сняли ~190, full с 11 стрелами 20 мин по кристаллам — время). Хп дракона (моба — можно точно): ≤ 40 — добить его
    // самого сразу (режим dragon: меч по сидящему, лук), пока кристаллы не вылечили; иначе — кристаллы и бой (full). Своё хп < 14 —
    // сперва поесть и отлежаться (ждать), потом бить. ND_DRAGON_FINISH=0 — всегда full.
    let mode = noBeds ? 'full' : null
    if (noBeds && process.env.ND_DRAGON_FINISH !== '0') {
      if ((state.health ?? 20) < 14) {
        log(`без кроватей, хп ${Math.round(state.health ?? 0)} — сперва ем и отлёживаюсь, потом бой`)
        if (have(FOOD) && (state.food ?? 20) < 20) await act('eat')
        await act('wait', { seconds: 15 })
        await refresh()
        if (died || dim() !== 'the_end') return
      }
      if (dragonHp !== null && dragonHp <= 40) mode = 'dragon'
    }
    if (noBeds) log(`кроватей нет — бой с драконом (${mode}): хп дракона ${dragonHp ?? '?'}, стрел ${arrowsNow()}, меч ${have(/_sword$/) ? 'есть' : 'нет'}`)
    const r = await act('dragon', { timeoutSeconds: 600, ...(mode ? { mode } : {}) })
    const dd = r.detail && r.detail.dragon
    if (dd && Number.isFinite(dd.hpNow)) dragonHp = dd.hpNow
    if (dd && dd.won) { known.dragonWon = true; log('ДРАКОН УБИТ') }
  }
})

const routeSkills = require(path.join(__dirname, 'src', 'campaign', 'overworld-route')).createOverworldRoute({
get BED_BLOCKS () { return BED_BLOCKS },
get COBBLE () { return COBBLE },
get FOOD () { return FOOD },
get LOGS () { return LOGS },
get PICK_STONE () { return PICK_STONE },
get RAW () { return RAW },
get ROUTE () { return ROUTE },
get ROUTE_COOKED_HUNGER () { return ROUTE_COOKED_HUNGER },
get ROUTE_SLEEP () { return ROUTE_SLEEP },
get act () { return act },
get call () { return call },
get acceptResult () { return acceptResult },
get answerThreat () { return answerThreat },
get castOneAt () { return castOneAt },
get climbOwnShaft () { return climbOwnShaft },
get cook () { return cook },
get craft () { return craft },
get deepCast () { return deepCast },
get deepLava () { return deepLava }, set deepLava (value) { deepLava = value },
get descend () { return descend },
get descendLava () { return descendLava }, set descendLava (value) { descendLava = value },
get died () { return died }, set died (value) { died = value },
get dim () { return dim },
get ensureFlint () { return ensureFlint },
get ensureTable () { return ensureTable },
get enterNether () { return enterNether },
get fillerCount () { return fillerCount },
get foodUnits () { return foodUnits },
get furnaceBack () { return furnaceBack },
get gameClock () { return gameClock },
get goToward () { return goToward },
get have () { return have },
get hunting () { return hunting }, set hunting (value) { hunting = value },
get known () { return known },
get leaveWater () { return leaveWater },
get lighter () { return lighter },
get makeBed () { return makeBed },
get manualControl () { return manualControl }, set manualControl (value) { manualControl = value },
get mineSeenAll () { return mineSeenAll },
get nightGuard () { return nightGuard },
get nightNow () { return nightNow },
get planksFor () { return planksFor },
get process () { return process },
get quickHunt () { return quickHunt },
get readMemory () { return readMemory },
get refresh () { return refresh },
get require () { return require },
get rest () { return rest },
get rlog () { return rlog },
get routeAroundOutpost () { return routeAroundOutpost },
get routeBedTries () { return routeBedTries }, set routeBedTries (value) { routeBedTries = value },
get routeBlockTarget () { return routeBlockTarget },
get routeBlocks () { return routeBlocks },
get routeCookHunger () { return routeCookHunger },
get routeEntered () { return routeEntered }, set routeEntered (value) { routeEntered = value },
get routeFlintFromBag () { return routeFlintFromBag },
get routeFood () { return routeFood },
get routeFrame () { return routeFrame }, set routeFrame (value) { routeFrame = value },
get routeFurnaceSupply () { return routeFurnaceSupply },
get routeGo () { return routeGo },
get routeGoPush () { return routeGoPush },
get routeHealToEnter () { return routeHealToEnter },
get routeHealing () { return routeHealing }, set routeHealing (value) { routeHealing = value },
get routeHunt () { return routeHunt },
get routeInfoGet () { return routeInfoGet },
get skyLavaSeen () { return skyLavaSeen }, get heardLava () { return heardLava }, get listenForLava () { return listenForLava }, get routeAvoid () { return routeAvoid },
get routeInfoV () { return routeInfoV }, set routeInfoV (value) { routeInfoV = value },
get routeLeaveOutpost () { return routeLeaveOutpost },
get routeMod () { return routeMod },
get routeRememberShaft () { return routeRememberShaft },
get routeReturnShaft () { return routeReturnShaft },
get routeShaftBackOn () { return routeShaftBackOn },
get routeSleep () { return routeSleep },
get routeSleptAt () { return routeSleptAt }, set routeSleptAt (value) { routeSleptAt = value },
get routeWater () { return routeWater },
get sense () { return sense },
get sit () { return sit }, set sit (value) { sit = value },
get smeltAll () { return smeltAll },
get stageRun () { return stageRun },
get state () { return state }, set state (value) { state = value },
get surfaceShaft () { return surfaceShaft }, set surfaceShaft (value) { surfaceShaft = value },
get toSurface () { return toSurface },
get todNow () { return todNow },
get waitDugOut () { return waitDugOut },
get woodNow () { return woodNow },
get y () { return y }
})

const graphFacts: Record<string, import('./src/core/world-state').Fact> = {}
const netherSupply = require(path.join(__dirname, 'src', 'campaign', 'nether-supply'))
const netherSupplyState = () => ({ dimension: dim(), health: state.health ?? 20, inventory: state.inventory || {}, pickSwings: sit.pickLeft ?? 0, woodAt: netherWoodSeen() })
// Стебли, увиденные глазами (nether-forest.js), — в 200 бл. по горизонтали (S1e).
function netherWoodSeen () {
  const w = memorySnapshot?.places?.['стебли (ад)']
  if (!w || dim() !== 'the_nether' || !state.pos || !Number.isFinite(w.x)) return null
  return Math.hypot(w.x - state.pos.x, w.z - state.pos.z) <= 200 ? { x: w.x, y: w.y, z: w.z } : null
}
async function replenishNetherSupply () {
  let interrupted = false
  return netherSupply.replenishNetherTools({
    observe: async () => { await refresh(); await sense(); return netherSupplyState() },
    act: async (method, params) => { const result = await act(method, params); interrupted ||= result.status === 'interrupted' }, craft,
    now: () => gameClock.now(), interrupted: () => interrupted || strategyInterrupted || died, log
  })
}
const graphFact = (name: string, value: import('./src/core/world-state').FactValue | null, source: import('./src/core/world-state').FactSource = 'observed') => { graphFacts[name] = { status: value === null ? 'unknown' : 'known', value, source, at: gameClock.now(), confidence: value === null ? 0 : 1 } }
let strategyMap
function campaignMap () {
  // ND_MAP=0 — вслепую (S8b 07.10): сид идёт в телеметрию, но постройки копии графу не даются.
  if (strategyMap === undefined) strategyMap = routeMod && process.env.ND_WORLD_SEED && process.env.ND_MAP !== '0' ? routeMod.routeInfo(process.env.ND_WORLD_SEED) : null
  return strategyMap
}
async function intelligenceObservation () {
  await refresh()
  await sense()
  await readMemory()
  graphFact('nether_ready', READY.nether())
  graphFact('nether_tools_ready', netherSupply.netherToolsReady(netherSupplyState()))
  graphFact('nether_pick_swings', sit.pickLeft ?? 0)
  graphFact('fortress_explored', netherExplored)
  graphFact('fire_resistance_count', fireResNow())
  graphFact('fire_resistance_active', state.fireResistance === true || state.tactics?.state?.fireResistance === true)
  graphFact('bastion_gold_dug', bastionGoldDug)
  graphFact('bastion_traded', bastionIngotsTraded)
  graphFact('barter_exhausted', barterExhausted())
  // Огнестойкость — не допуск к ифритам, а риск/цена GetBlazeRods в графе (speedrun.ts, решение пользователя 06.10 22:33).
  graphFact('blaze_allowed', !bastionPearlsPending())
  graphFact('end_ready', DONE.endkit())
  graphFact('endermen_allowed', ENDERMEN_OK)
  graphFact('endermen_seconds_per_pearl', Math.round(endermenSecondsPerPearl()))
  graphFact('bastions_exhausted', !activeBastion() && !bastionSearchWanted())
  const next = nextBastion()
  if (next) {
    graphFact('bastion', true, 'map')
    graphFact('bastion_position', { x: next.x, y: next.y ?? 64, z: next.z }, 'map')
  }
  if (!nextBastion() && !bastionSearchWanted()) graphFact('bastion', false)
  return { state, situation: sit, known, facts: graphFacts, map: campaignMap(), elapsedMs: gameClock.now() - T0, structureSearchMs: routeStructureSeconds * 1000 }
}
const lavaScoutCells = new Set<string>()
let lavaScoutViews = 0
async function executeStrategy (command, signal) {
  if (signal.aborted) return { outcome: 'INTERRUPTED', reason: String(signal.reason), events: [] }
  strategyExecuting = true
  strategyInterrupted = false
  const onAbort = () => { strategyInterrupted = true }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const skill = command.skill
    if (skill === 'structureIron') {
      const place = String(command.params.kind)
      const mapKey = { village: 'village', shipwreck: 'ship', treasure: 'treasure' }[place]
      const at = campaignMap()?.[mapKey] || graphFacts[`${place}_position`]?.value
      if (!at) return { outcome: 'FAILURE', reason: 'постройка без известного места', events: [] }
      const left = Math.max(0, 180 - routeStructureSeconds)
      log(`граф ${command.strategy}: постройки ${Math.round(routeStructureSeconds)}/180 с, осталось ${Math.floor(left)} с; затем руда`)
      const t0 = gameClock.now()
      routeDeadline = t0 + left * 1000
      const oldStage = stage
      stage = 'route'
      let visited = false
      try { visited = await routeStep({ kind: mapKey, at, id: command.strategy, budget: left }) }
      finally {
        routeStructureSeconds += (gameClock.now() - t0) / 1000
        routeDeadline = 0
        stage = oldStage
      }
      if (!visited && !strategyInterrupted) return { outcome: 'FAILURE', reason: 'подход или посещение постройки не завершены', events: [] }
      if (visited && !strategyInterrupted) graphFact(`${place}_exhausted`, true)
    } else if (skill === 'scoutStructures') {
      const search = await require(path.join(__dirname, 'src', 'campaign', 'structure-search')).scoutStructures({
        now: () => gameClock.now(), position: () => state.pos,
        scan: async () => { await act('structure', { mode: 'scan', radius: 96 }) },
        list: async () => ((await act('structure', { mode: 'list' })).detail?.known || []).map(entry => ({ ...entry,
          done: entry.done || graphFacts[`${entry.kind === 'buried_treasure' ? 'treasure' : entry.kind}_exhausted`]?.value === true })),
        explore: async (direction, timeoutSeconds) => (await act('explore', { block: 'bell,chest,barrel', radius: 48, stepDistance: 60, direction, timeoutSeconds, dry: true, surface: true, unlootedContainers: true })).detail,
        loot: async (at, timeoutSeconds) => Object.values((await act('loot', { ...at, visibleOnly: true, timeoutSeconds })).detail?.took || {}).some(n => Number(n) > 0),
        move: async (at, timeoutSeconds) => { await act('goto', { ...at, range: 6, surface: 'strict', timeoutSeconds }) },
        interrupted: () => signal.aborted || strategyInterrupted || died, fact: graphFact, log
      }, routeStructureSeconds * 1000)
      routeStructureSeconds = search.spentMs / 1000
      if (search.blocked) return { outcome: 'FAILURE', reason: 'путь поиска построек заблокирован до исчерпания бюджета', events: [] }
    } else if (skill === 'netherTools') {
      const supply = await replenishNetherSupply()
      if (!supply.ready) return { outcome: supply.interrupted ? 'INTERRUPTED' : 'FAILURE', reason: supply.reason, events: [] }
    } else if (skill === 'bastionSupply') {
      if (have('gold_block') && have('gold_ingot') < 8) await craft('gold_ingot', 9 * have('gold_block'))
      if (have('gold_ingot') >= 8) {
        const barter = await act('bastion', { ...barterSite(), mode: 'barter', pearls: have('ender_pearl'), fireRes: 1, timeoutSeconds: 540, sealed: true })
        bastionIngotsTraded += Number(barter.detail?.ingotsTraded) || 0
      }
      await refresh()
      if (!fireResReady() && nextBastion()) await stageRun('bastion')()
    } else if (skill === 'portalKit') {
      await spendIron()
      if (!have(/bucket$/) && have('iron_ingot') >= 3) await craft('bucket')
      if (!lighter()) await ensureFlint()
    } else if (skill === 'scoutLava') {
      const cell = () => state.pos && [dim(), ...['x', 'y', 'z'].map(axis => Math.floor(state.pos[axis] / 16))].join(':')
      if (cell()) lavaScoutCells.add(cell())
      await skyLavaLook()
      if (!lavaSourceKnown) await lavaAtSeenRuins()
      await act('observe', { radius: 64 })
      if (!known.lava) await act('explore', { block: 'lava', lavaSource: true, radius: 48, stepDistance: 60, timeoutSeconds: 90, surface: true })
      const viewed = cell()
      if (viewed && !lavaScoutCells.has(viewed)) { lavaScoutCells.add(viewed); lavaScoutViews++ }
      graphFact('lava_scout_views', lavaScoutViews)
    } else if (skill === 'ruinedPortal') {
      const at = campaignMap()?.rp
      if (!at) return { outcome: 'FAILURE', reason: 'руины без известного места', events: [] }
      await routeStep({ kind: 'ruin', at })
      if (have('obsidian') >= 10) await stageRun('portal')()
      else if (!known.portal) await stageRun('cast')()
      graphFact('ruined_portal_exhausted', true)
    } else if (skill === 'enterNether') await enterNether()
    // LeaveNether к точке выхода у крепости Края, а не домой (COORD 00:55 S5c: s5c-f3-1 — граф уводил к порталу дома, 12 мин
    // впустую, дальше пешком): при ND_SH_NETHER и известной крепости выход ведёт этап stronghold (viaNetherTo; не вышло — он сам домой).
    else if (skill === 'leaveNether') {
      if (SH_NETHER && known.stronghold && !known.endPortal && canLink() && !obsShort()) { await stageRun('stronghold')(); await refresh() }
      if (dim() === 'the_nether' && !died && !pendingExitFrame()) await returnFromNether()
    }
    else if (skill === 'enterEnd') { await checkEndEntry(); await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 120 }) }
    else if (skill === 'heal') await rest(18)
    else if (skill === 'eatFood') await eatTo(20, () => signal.aborted || strategyInterrupted)
    else if (skill === 'prepareBread') {
      const bread = require(path.join(__dirname, 'src', 'campaign', 'bread')).carriedBread(state.inventory || {})
      if (!bread || !(await craft('bread', bread.count))) return { outcome: 'FAILURE', reason: 'хлеб из принесённых ингредиентов не подтверждён', events: [] }
    }
    else if (skill === 'piglinBarter') {
      if (have('gold_block') && have('gold_ingot') < 8) await craft('gold_ingot', 9 * have('gold_block'))
      if (have('gold_ingot') < 8) return { outcome: 'FAILURE', reason: 'сервер не подтвердил восемь слитков для бартера', events: [] }
      const barter = await act('bastion', { ...barterSite(), mode: 'barter', pearls: Math.max(0, eyesWant() - have('ender_eye')), fireRes: 1,
        ...(process.env.ND_SH_NETHER === '1' ? { obsidian: 10 } : {}), ...(EXIT_KIT ? { exit: false } : {}), sealed: true, timeoutSeconds: 540 })
      bastionIngotsTraded += Number(barter.detail?.ingotsTraded) || 0
      barterZero = (Number(barter.detail?.ingotsTraded) || 0) > 0 ? 0 : barterZero + 1
    }
    else if (skill === 'findBastions') {
      const r = await act('structure', { mode: 'scan', radius: 96 })
      await stageRun('bastion')(true)
      await readMemory()
      if (!nextBastion() && !bastionSearchWanted()) graphFact('bastion', false)
    } else if (skill === 'findFortress') await stageRun('nether')()
    else {
      const executor = STAGES.find(entry => entry.name === skill)
      if (!executor) return { outcome: 'FAILURE', reason: `нет навыка ${skill}`, events: [] }
      await executor.run(command.strategy === 'AcquireWood' ? 5 : undefined)
    }
    return { outcome: strategyInterrupted ? 'INTERRUPTED' : 'SUCCESS', events: strategyInterrupted ? [{ type: 'tactical_released' }] : [] }
  } catch (error) {
    if (error.stopCampaign) throw error
    return { outcome: error.strategyInterrupted || strategyInterrupted ? 'INTERRUPTED' : 'FAILURE', reason: error.message, events: [] }
  } finally { signal.removeEventListener('abort', onAbort); strategyExecuting = false; strategyInterrupted = false }
}
const intelligence = require(path.join(__dirname, 'src', 'campaign', 'intelligence')).createCampaignIntelligence({
  observe: intelligenceObservation, call, execute: executeStrategy, now: () => gameClock.now(), sleep,
  eyes: EYES_NEED, beds: BEDS_END,
  record: decision => {
    telemetry.record({ ...decision, sec: decision.seconds, stage, sinceStart: Math.round((gameClock.now() - T0) / 1000) })
    if (decision.level === 'decision') log(`ГРАФ ${decision.reason}: ${(decision.plan || []).join(' → ')}`)
  }
})

ws.on('open', async () => {
  try {
    await act('connect')
    await act('play_mode', { mode: 'speedrun', foodTarget: FOOD_STOCK })
    await act('set_goal', { text: 'Пройти игру честно: дерево → камень → еда → железо → вода → алмазы → обсидиан → портал → Ад → жемчуг → око → крепость → дракон' })
    await refresh()
    await readMemory()
    if (!known.portal && state.pos && Math.hypot(state.pos.x, state.pos.z) > 32) heading = Math.atan2(state.pos.z, state.pos.x)
    log(`старт: ${bag()}${known.portal ? `; портал в памяти ${known.portal.x},${known.portal.y},${known.portal.z}` : ''}`)
    seamSnapshot('start')
    const fails = new Map()
    let netherThreatWaits = 0
    const failureKey = name => {
      const site = name === 'bastion' ? nextBastion() : null
      return site ? `${name}:${site.dimension || 'the_nether'}:${site.x}:${site.z}` : name
    }
    const cooling = s => { const f = fails.get(failureKey(s.name)); return !!f && f.until > gameClock.now() }
    const failStage = (name, key) => {
      const f = fails.get(key) || { n: 0, level: 0, until: 0 }
      f.n++
      f.at = gameClock.now()
      if (f.n >= (f.level ? 1 : 2)) {
        const PM = process.env.ND_NE_STAY === '1' && dim() === 'the_nether' ? [1, 2, 3, 4] : PAUSE_MIN
        const min = PM[Math.min(f.level, PM.length - 1)]
        f.until = gameClock.now() + min * 60000
        f.level++
        f.n = 0
        log(`этап ${name}: ${f.level > 1 ? 'снова пустой заход' : 'два пустых захода подряд'} — пауза ${min} мин`)
        if (/^(bastion|BastionBarter|PiglinBarter)$/.test(name)) bastionPausedUntil = Math.max(bastionPausedUntil, f.until)
        if (name === 'bastion' && dim() === 'the_nether' && have('gold_ingot') + 9 * have('gold_block') < 8) {
          const attempted = (known.bastions || []).find(b => key === `${name}:${b.dimension || 'the_nether'}:${b.x}:${b.z}`)
          if (attempted?.gold?.length && (known.bastions || []).some(other => other !== attempted &&
            Number.isFinite(other.x) && Number.isFinite(other.z) && !bState(other).spent &&
            (bState(other).miningDeferredUntil || 0) <= gameClock.now() &&
            (!barterFlow.enabled() || (bState(other).barterUntil || 0) <= gameClock.now()))) deferBastionMining(attempted)
        }
      }
      fails.set(key, f)
    }
    const resetPauses = why => { if (fails.size) { log(`паузы этапов сняты: ${why}`); fails.clear() } }
    let lastProgressAt = gameClock.now()
    let lastDim = dim()
    let wasNight = !!sit.night
    for (let turn = 1; turn <= 5000; turn++) {
      await refresh()
      await sense()
      if (state.playPolicy?.mode === 'free') { log('режим free — кампания уступает управление игроку'); break }
      if (state.connected === false) {
        stage = '-'
        log('тело не в игре — переподключаюсь')
        await act('connect')
        await refresh()
        if (state.connected === false) await gameClock.wall.sleep(30000)
        continue
      }
      if (dim() !== lastDim) { resetPauses(`смена измерения ${lastDim} → ${dim()}`); await readMemory(); seamSnapshot(`observed:${lastDim}->${dim()}`); lastDim = dim() }
      if (wasNight && !sit.night && dim() === 'overworld') resetPauses('рассвет')
      wasNight = !!sit.night
      if (died) {
        stage = '-'
        try { await recoverGuard() } catch (e) { if (e.stopCampaign) throw e; log(`после смерти: ${e.message}`) }
      }
      if (gameClock.now() - lastProgressAt >= WATCHDOG_MIN * 60000) {
        stage = '-'
        log(`БЛОКЕР: сторож — ${Math.round((gameClock.now() - lastProgressAt) / 60000)} мин без прогресса ни в одном этапе (последний этап ${lastStage}); останавливаю кампанию`)
        await act('stop')
        process.exitCode = 2
        break
      }
      const turnStart = gameClock.now()
      // Прерванная плавка оставила сырьё/слитки в своей печке — забрать, пока рядом (containers.takeFurnace; cl-a 14.10:
      // таймаут MineIron отменил плавку 13 железа, тело копало его заново).
      const furnaceLeft = state.furnaceLeft
      if (furnaceLeft && furnaceLeft.dimension === dim() && state.pos && (state.tactics?.threatLevel ?? 0) < 2 &&
          Math.hypot(furnaceLeft.at.x - state.pos.x, furnaceLeft.at.y - state.pos.y, furnaceLeft.at.z - state.pos.z) <= 48) {
        stage = '-'
        await act('furnace_take', {})
      }
      // Лава светится: осмотр вдаль с поверхности по ходу дела (не чаще раза в минуту, с нового места) — где озеро, знать
      // заранее, к литью идти туда (cl-o 14.10: озеро у руин в 26 бл. от спавна не заметил, литьё искал за 300 бл.).
      if (dim() === 'overworld' && !known.portal && !lavaSourceKnown && !died && sit.surface && !sit.night && gameClock.now() >= skyLookNext) {
        skyLookNext = gameClock.now() + 60000
        try {
          await skyLavaLook()
          // С земли озеро часто закрыто рельефом и деревьями (замер слота 1 14.10: 5 открытых клеток озера в 54 бл., ни одна не видна
          // с земли): раз-два за прогон — столб на 10 вверх своими блоками, осмотр, спуск (как игрок с вышки). Блоки — после камня.
          if (!lavaSourceKnown && lookoutsDone < 2 && have(COBBLE) + have('dirt') >= 12 && !died && !sit.inWater && y() >= 60) {
            lookoutsDone++
            const y0 = y()
            await act('tunnel', { direction: 'up', length: 10, timeoutSeconds: 25 })
            const climbed = Math.round(y() - y0)
            if (climbed >= 4) { skyLookAt = null; await skyLavaLook() }
            if (climbed > 0 && !died) await act('tunnel', { direction: 'down', length: climbed, timeoutSeconds: 30 })
          }
        } catch (e) { if (e.stopCampaign) throw e }
      }
      // Еда по пути, как у игрока: днём, звери на виду, запас мал — добыть сейчас (quickHunt: только видимые в 24 бл., ≤ 60 с).
      // Граф ставит FindFood перед входом в Ад; cl-a/cl-c 14.10: первые 15–18 мин без еды, урон не лечится, смерть ночью.
      if (dim() === 'overworld' && !died && foodUnits() < 4 && gameClock.now() >= quickHuntAt && (state.tactics?.threatLevel ?? 0) < 1 &&
          (state.health ?? 20) >= 8 && process.env.ND_QUICK_HUNT !== '0') {
        quickHuntAt = gameClock.now() + 90000
        await sense()
        if (sit.surface && !sit.night) {
          stage = 'food'
          try { await quickHunt() } catch (e) { if (e.stopCampaign) throw e; log(`охота по пути: ${e.message}`) }
          // Зверей на виду нет, а еды нет совсем и сытость уже не лечит (≤ 15): днём — охота с поиском (этап food, ≤ 2 мин),
          // пока светло, а не ночью с 4 хп (cl-g 14.10: обе смерти — ночью без единой еды за 13–23 мин).
          await refresh()
          if (!died && foodUnits() < 2 && (state.food ?? 20) <= 15 && gameClock.now() >= foodSearchAt && !cooling(STAGES.find(x => x.name === 'food'))) {
            foodSearchAt = gameClock.now() + 300000
            log(`еды ${foodUnits()}, сытость ${state.food} — днём ищу зверей, пока светло`)
            const before = stageProgress('food')
            try { await stageRun('food')() } catch (e) { if (e.stopCampaign) throw e; log(`поиск еды днём: ${e.message}`) }
            await refresh()
            if (Object.entries(stageProgress('food')).some(([key, value]) => Number(value) > (before[key] || 0))) lastProgressAt = gameClock.now()
          }
        }
      }
      // Ночь до портала без брони (nightHold): работа под землёй той же цепочкой этапа iron (лесенкой к y 16, штреки: железо на
      // броню и щит, уголь, гравий); пережидать нельзя (правило пользователя), поверху — смерть (обе смерти cl-e 14.10 — ночью
      // поверху). Литьё у видимой лавы с готовым набором не прерываю (castNear).
      // Ночь кончилась, а тело внизу: наверх своей лестницей до наземных этапов — разведка поверху из глубины шла пещерами
      // (cl-t 14.10: с y 16 explore поднял в пещеру с тремя зомби, смерть на рассвете).
      if (nightHeld && !nightHold() && !died) {
        nightHeld = false
        await sense()
        if (!sit.surface && !sit.night && dim() === 'overworld') { stage = '-'; log('рассвет — наверх своей лестницей'); await toSurface() }
      }
      if (!died && nightHold()) {
        nightHeld = true
        if (!known.portal && castNear() && gameClock.now() >= nightCastAt) {
          nightCastAt = gameClock.now() + 120000
          stage = 'cast'
          log('ночь, но лава рядом и набор литья готов — литьё')
          try { await stageRun('cast')() } catch (e) { if (e.stopCampaign) throw e; log(`ночное литьё: ${e.message}`) }
          continue
        }
        // Портал есть и в Ад готов — ночь не пережидать, а уйти в Ад (там нет ночи); портал рядом.
        if (known.portal && READY.nether() && portalFar() < 96 && gameClock.now() >= nightEnterAt) {
          nightEnterAt = gameClock.now() + 120000
          stage = 'nether'
          log('ночь, портал рядом и в Ад готов — ухожу в Ад')
          try { await enterNether() } catch (e) { if (e.stopCampaign) throw e; log(`ночью в Ад: ${e.message}`) }
          continue
        }
        // Поверху ночью — сначала нора на месте (3 вниз, крыша), работа вниз — уже из неё: скелет бьёт за 15 бл., пока тело ищет
        // сухое место для лестницы (cl-u 14.10: смерть через минуту после темноты, у воды). Нора не копается — коробка.
        if (sit.surface) {
          stage = '-'
          const hole = await act('shelter', { mode: 'enter', depth: 3 })
          await sense()
          // Нора с открытым боком у воды заливается: из воды — и коробку (cl-y 14.10).
          if (sit.inWater && !died) { await leaveWater(); await sense() }
          if (!sit.surface && !died && !sit.inWater && /ПОТОЛОК ОТКРЫТ/.test(String(hole.detail?.note || ''))) {
            await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why: 'ночь: нора открыта — коробка' })
            continue
          }
          // Вниз не вышло (вода под дёрном, болото, берег — cl-p 14.10: 3 мин ночью поверху в поисках сухого места, смерть от
          // зомби): коробка на месте — стены от ходячих, крыша от стрел, до рассвета.
          if (sit.surface && !died) {
            const r = await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why: 'ночь: вниз здесь нельзя — коробка' })
            if (!(r && r.detail && r.detail.stayed)) await act('wait', { seconds: 5 })
          }
          continue
        }
        if (gameClock.now() >= nightDigAt && nightDigWood()) {
          nightDigAt = gameClock.now() + 120000
          // Кирки по камню ещё нет — ночь на лестнице за камнем (этап stone копает вниз), есть — штреки этапа iron.
          const work = have(PICK_STONE) > 0 ? 'iron' : 'stone'
          stage = work
          log(work === 'iron' ? 'ночь, брони нет — работаю под землёй (железо на броню, уголь, гравий), поверху — с рассветом' : 'ночь, кирки по камню нет — камень под землёй, поверху — с рассветом')
          const before = stageProgress(work)
          try { await stageRun(work)() } catch (e) { if (e.stopCampaign) throw e; log(`ночная работа внизу: ${e.message}`) }
          // Железо, ведро, щит ночной работы — прогресс для сторожа (cl-k 14.10: 9 слитков и ведро за ночь, а сторож через 48 мин
          // «без прогресса» остановил кампанию: этапы вне хода не обновляли его отметку).
          await refresh()
          if (Object.entries(stageProgress(work)).some(([key, value]) => Number(value) > (before[key] || 0))) lastProgressAt = gameClock.now()
          continue
        }
        // Работа внизу сделана или отказала — наземные этапы графа (вода, охота, разведка) ночью не зову (cl-k 14.10: вода ночью
        // вывела наверх, cl-h/cl-j: охота и берег ночью — смерть): короткое ожидание в выработке. Залило — сперва из воды
        // (cl-y 14.10: нора у воды с открытым боком залилась, ожидание по 20 с под водой — утонул).
        stage = '-'
        await sense()
        if (sit.inWater) await leaveWater()
        else {
          // Ждать — в закрытом: на ступенях своей лестницы скелет из пещеры стрелял, а ожидание шло по 20 с под стрелами (cl-an2
          // 14.10: «wait 20» ×5 между боями со скелетом, смерть на 12-й мин). Замкнутый карман refuge признаёт сразу, коробка — 2–3 с.
          const r = await act('refuge', { minHp: 20, maxSeconds: 60, stayIn: true, why: 'ночь: жду внизу в закрытом' })
          const shut = !!(r && r.detail && (r.detail.stayed || r.detail.how === 'pocket'))
          await act('wait', { seconds: shut ? 20 : 5 })
        }
        continue
      }
      if (only && dim() !== 'overworld' && !have(/_pickaxe$/)) { stage = '-'; await ensurePick() }
      const need = STAGES.filter(s => !(only && !only.includes(s.name)) && s.needed() && (dim() === 'overworld' || OTHER_WORLD.has(s.name)))
      const selection = only ? null : await intelligence.select(need, cooling)
      if (!selection && dim() === 'the_nether' && !bastionPearlsPending() && need.some(s => s.name === 'nether') && (!READY.nether() || (fightGearWanted && !fightReady())) &&
          gameClock.now() >= homeForGearAfter) {
        stage = '-'
        log(`для ифритов не хватает ${fightGearWanted ? fightLack() : netherLack()} — домой за недостающим`)
        await returnFromNether()
        // Портал не дался (s1c-F-17 06.10: «до порога портала не дошёл» 2 883 раза за секунды, 38 МБ телеметрии) — пауза 5 игр. мин.
        if (dim() === 'the_nether') { homeForGearAfter = gameClock.now() + 300000; await act('ne_burrow', { why: 'домой не вышло' }) }
        continue
      }
      if (!selection && !need.length && dim() === 'the_nether') {
        stage = '-'
        log('в Аду делать нечего (кирки нет или стержни есть) — домой через портал')
        await returnFromNether()
        continue
      }
      if (!selection && !need.length) {
        stage = '-'
        if (known.dragonWon) { log('все этапы готовы'); break }
        if (only) { log(`нужных этапов нет среди ${only.join(',')} — запуск окончен (дракон жив: жемчуга ${pearlsNow()} из ${EYES_NEED}, очей ${have('ender_eye')})`); break }
        log(`нужных этапов нет, а дракон жив (жемчуга ${pearlsNow()} из ${EYES_NEED}, очей ${have('ender_eye')}) — жду перемены, остановит сторож`)
        if (dim() === 'overworld') await leaveWater()
        await act('wait', { seconds: 60 })
        continue
      }
      const foodFail = fails.get('food')
      const urgentOk = x => !cooling(x) || !foodFail || gameClock.now() - (foodFail.at || 0) > 90000
      const urgent = weakAndHungry() ? need.find(x => x.name === 'food' && urgentOk(x) && x.ready() && !x.defer()) : null
      const legacy = only && (urgent || need.find(x => !cooling(x) && x.ready() && !x.defer()))
      const s = legacy ? (only ? legacy : intelligence.wrap(legacy)) : selection?.stage
      if (!s && dim() === 'the_nether' && (state.tactics?.threatLevel ?? 0) >= 2 && netherThreatWaits < 20 && !died) {
        // Граф молчит из-за угрозы (intelligence.select: threatLevel ≥ 2) — не повод идти домой: путь к порталу под
        // ифритами рвёт тактика и тело гибнет на ходу (s1-post01b 06.10). Ифриты, а стержни нужны — бой у спавнера;
        // иначе короткое ожидание, пока тактика не снимет угрозу.
        netherThreatWaits++
        stage = '-'
        // У спавнера (в 24 бл. по памяти) угроза — это ифриты, даже если sit.fight их не перечислил: бой ведёт blaze, а не тактика
        // (s1-post21hole 06.10: навык вернулся по времени с 3 стержнями, кампания ждала тактику у спавнера — смерть).
        const spMem = memorySnapshot?.places?.['спавнер блейзов']
        const nearSpawner = !!(spMem && state.pos && dim() === 'the_nether' && Math.hypot(spMem.x - state.pos.x, spMem.z - state.pos.z) <= 24 && Math.abs(spMem.y - state.pos.y) <= 24)
        const blazes = (sit.fight?.order || []).some(o => o && o.name === 'blaze') || nearSpawner
        if (blazes && rodsWanted() && !bastionPearlsPending() && known.fortress && fightReady()) {
          log('ифриты рядом, стержни нужны — бой у спавнера, а не путь домой')
          stage = 'nether'
          try { await stageRun('nether')() } catch (e) { if (e.stopCampaign) throw e; log(`бой у спавнера: ${e.message}`) }
        } else if (dim() === 'the_nether' && known.netherPortal && state.pos && Math.hypot(known.netherPortal.x - state.pos.x, known.netherPortal.z - state.pos.z) <= 6 &&
          !rodsWanted() && have('ender_eye') + have('ender_pearl') >= eyesWant()) {
          // У портала домой, всё собрано — угроза не повод ждать: вход в портал и есть уход (s1-LG-10 06.10: 5 стержней, 10 очей,
          // «прервано у портала», 7 мин ожидания тактики у рамы — смерть).
          log('у портала домой, всё собрано — ухожу через портал, не жду тактику')
          await act('portal', { mode: 'enter', timeoutSeconds: 60 })
        } else if (dim() === 'the_nether' && gameClock.now() - blazeDugInAt < 300000 && !rodsWanted()) {
          // В яме у спавнера после «набрал» граф молчит из-за угрозы (ифриты видны в открытый верх), а ожидание кончалось шарами
          // после конца FR (s1-LL-6 06.10: 5 стержней, яма без крышки, «жду её конца» — смерть). Очи — крафт в рюкзаке прямо в
          // яме; готово — домой ходом (у спавнера план идёт штреком, expoMul).
          if (have('ender_eye') < eyesWant() && have('ender_pearl') > 0 && have('blaze_rod') + have('blaze_powder') > 0) {
            log('в яме у спавнера: крафт очей, не жду тактику')
            const want = Math.min(eyesWant() - have('ender_eye'), have('ender_pearl'))
            if (have('blaze_powder') < want) await craft('blaze_powder', Math.min(2 * have('blaze_rod'), want - have('blaze_powder') + 1))
            await craft('ender_eye', Math.min(want, have('blaze_powder')))
          } else {
            log('в яме у спавнера, всё собрано — домой, не жду тактику')
            blazeDugInAt = -Infinity
            await returnFromNether()
          }
        } else if (nearSpawner && !rodsWanted() && netherThreatWaits <= 2 && gameClock.now() - blazeDugInAt > 60000) {
          // Стержни набраны, а у спавнера ифриты — в толщу, а не ждать тактику (s1-LE-4 06.10: 5 стержней на 5-й мин, затем LastStand/
          // BlockOff у спавнера — смерть через секунды).
          log('стержни набраны, у спавнера ифриты — закапываюсь')
          await act('ne_burrow', { why: 'стержни набраны — ухожу от ифритов' })
        } else {
          log(`в Аду угроза (тактика ${state.tactics?.action || '?'}) — домой не иду, жду её конца`)
          await act('wait', { seconds: 3 })
        }
        continue
      }
      if (s || (state.tactics?.threatLevel ?? 0) < 2) netherThreatWaits = 0
      if (!s) {
        stage = '-'
        const upNeed = dim() === 'the_nether' ? STAGES.filter(x => !(only && !only.includes(x.name)) && !OTHER_WORLD.has(x.name) && x.needed()) : []
        if (process.env.ND_NE_STAY === '1' && dim() === 'the_nether' && need.length && need.every(x => cooling(x))) {
          log(`в Аду этапы на паузе (${need.map(x => x.name).join(', ')}) — жду в толще (ND_NE_STAY)`)
          await act('ne_burrow', { why: 'жду конца паузы' })
          await refresh()
          await act('wait', { seconds: 45 })
          continue
        }
        if (upNeed.length && need.every(x => !x.defer() && (cooling(x) || !x.ready()))) {
          log(`в Аду нечем (${need.map(x => x.name).join(', ')}) — домой за: ${upNeed.map(x => x.name).join(', ')}`)
          await returnFromNether()
          continue
        }
        const paused = need.filter(x => cooling(x)).map(x => Math.ceil((fails.get(failureKey(x.name)).until - gameClock.now()) / 60000))
        const blocked = need.every(x => !x.defer() && (cooling(x) || !x.ready()))
        log(`${blocked ? 'нет доступного шага' : 'нужные этапы отложены'} (${need.map(x => `${x.name}${cooling(x) ? '·пауза' : ''}${x.ready() ? '' : '·нечем'}${x.defer() ? '·отложен' : ''}`).join(', ')}) — жду${paused.length ? `: ближайшая пауза кончится через ${Math.min(...paused)} мин` : ' изменения обстановки'}`)
        if (dim() === 'the_nether' && process.env.ND_NE_STAY === '1') { await act('ne_burrow', { why: 'жду конца паузы' }); await refresh() } else
        if (dim() === 'the_nether') await returnFromNether()
        else if ((sit.night || (NIGHT_DOWN2() && sit.dusk)) && sit.surface && dim() === 'overworld') await nightGuard({ dusk: true })
        // Верхний мир: граф молчит из-за угрозы (select: threatLevel ≥ 2), тело у тактики — короткое ожидание, а не 60 с: угроза
        // снята через секунды, и ожидание шло впустую (S8b s8b-a1-3: ×10+ «жду» по 60 с ночью, ~6 игр. мин без хода; S8c).
        const threatWait = dim() === 'overworld' && (state.tactics?.threatLevel ?? 0) >= 1 && process.env.ND_OW_THREAT_WAIT !== '0'
        // Все нужные этапы на паузе после пустых заходов — не стоять по 60 с (cl-a/cl-b/cl-c 14.10: 15–45 мин простоя до сторожа):
        // новое место — новый обзор (звери, вода, лава, руда, постройки). Ночью при малом хп — по-прежнему ждать.
        if (dim() === 'overworld' && blocked && !threatWait && !died && ((state.health ?? 20) >= 14 || !sit.night) && process.env.ND_IDLE_RELOCATE !== '0') {
          const from = state.pos && { ...state.pos }
          log('все нужные этапы на паузе — не стою: меняю место для нового обзора')
          if (!sit.surface) await toSurface()
          else await walkAway(64, Math.PI / 3)
          await refresh()
          const moved = from && state.pos ? Math.hypot(state.pos.x - from.x, state.pos.y - from.y, state.pos.z - from.z) : 0
          if (moved >= 32) resetPauses('новое место')
          if (moved >= 8 || died) continue
        }
        if (gameClock.now() - turnStart < 20000) { if (dim() === 'overworld') await leaveWater(); await act('wait', { seconds: threatWait ? 3 : 60 }) }
        continue
      }
      stage = s.name
      lastStage = s.name
      log(`ход ${turn}: начинаю; рюкзак: ${bag()}`)
      const attemptedKey = failureKey(s.name)
      const before = stageProgress(s.name)
      const telStage = telemetry.on() ? { t0: gameClock.now(), wallT0: gameClock.wall.now(), before: telemetry.snapshot(state, sit), dead: died } : null
      let telStageErr = null
      let attemptInterrupted = false
      try {
        if (only) await recoverGuard()
        await s.run()
      } catch (e) {
        if (telStage) telStageErr = String(e.message).slice(0, 240)
        if (e.stopCampaign) throw e
        attemptInterrupted = !!e.strategyInterrupted
        log(`этап упал: ${e.message}`)
      }
      if (manualControl) break
      await refresh()
      await sense()
      await readMemory()
      const off = !s.needed()
      const ok = off && s.done()
      const after = stageProgress(s.name)
      const progressed = s.progressed ? s.progressed() : Object.entries(after).some(([key, value]) => value > (before[key] || 0))
      if (attemptInterrupted || s.interrupted?.()) { log('навык прерван — новое наблюдение и план'); continue }
      if (telStage) {
        const snap = telemetry.snapshot(state, sit)
        telemetry.record({ level: 'stage', stage: s.name, turn, sec: Math.round((gameClock.now() - telStage.t0) / 100) / 10, wallSec: (gameClock.wall.now() - telStage.wallT0) / 1000, ok, off, progressed,
          error: telStageErr, death: died && !telStage.dead, sinceStart: Math.round((gameClock.now() - T0) / 1000), before: telStage.before, after: snap,
          gained: telemetry.delta(telStage.before, snap) })
      }
      if (!off && s.defer()) {
        log(`этап отложен (${s.name === 'food' ? 'ночь — охота с рассветом' : 'не сейчас'}); рюкзак: ${bag()}`)
        continue
      }
      log(`итог этапа: ${ok ? 'готов' : off ? 'снят без итога (сдан или нельзя)' : 'НЕ ГОТОВ'}; рюкзак: ${bag()}`)
      if (off) {
        fails.delete(attemptedKey)
        if (ok || progressed) lastProgressAt = gameClock.now()
        if (ok) {
          log(`ВЕХА ${s.name}: готово в ${new Date().toTimeString().slice(0, 8)}, ${Math.round((gameClock.now() - T0) / 60000)} мин от запуска`)
        }
      } else if (progressed) {
        fails.delete(attemptedKey)
        lastProgressAt = gameClock.now()
        log('частичный полезный результат — продолжаю без ожидания и отката')
      } else if (s.name === 'bastion' && barterFlow.enabled() && barterRetryPending) {
        barterRetryPending = false
        fails.delete(attemptedKey)
        log('бартер: золото есть — 15 с в закрытом укрытии и другой поиск, FR-гейт сохраняю')
        await act('ne_burrow', { why: 'бартер: смена торговцев' })
        await sleep(15000)
      } else failStage(s.name, attemptedKey)
      if (died) { log('умер — проверяю, какие ресурсы действительно потеряны'); resetPauses('смерть') }
    }
  } catch (e) {
    log(`прогон упал: ${e.stack || e.message}`)
    process.exitCode = 1
  } finally {
    if (!detached && !manualControl && state.playPolicy?.mode !== 'free') {
      let disconnectTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([call('disconnect', { reason: 'кампания завершена' }),
          new Promise<void>(resolve => { disconnectTimer = gameClock.wall.setTimeout(resolve, 15000) })])
        log('кампания завершена — бот отключён от сервера')
      } catch (e) { log(`disconnect RPC-ОШИБКА ${e.message}`) }
      finally { if (disconnectTimer !== undefined) gameClock.wall.clearTimeout(disconnectTimer) }
    }
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
