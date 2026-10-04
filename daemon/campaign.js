'use strict'
// Честный прогон «от пустого рюкзака до дракона»: мозг-автомат по RPC.
//
// Играет тем же набором намерений, что и мозг через MCP, и так же, как мозг
// должен: смотрит в рюкзак, выбирает следующий шаг, читает stopped/need и
// меняет решение, а не повторяет упавший вызов. Никаких команд оператора —
// бот на своём сервере не оп (server-run, ops.json пуст).
//
// Этапы идут по порядку, но каждый сам проверяет, нужен ли он (по рюкзаку и
// памяти мира), так что прогон можно оборвать и запустить снова — продолжит с
// того, чего не хватает. Журнал — campaign.log рядом, строка на каждый вызов;
// строки «ВЕХА» — пройденные этапы со временем от старта.
//
// Обстановку читает у демона (RPC situation — то же, что видит директор):
// под крышей ли (порода над головой, а не y<50 — в горах y=100 это ещё
// поверхность), ночь и сумерки, враги с вердиктом assess, кровать.
//
//   node campaign.js                  всё подряд
//   node campaign.js wood,stone       только эти этапы
//   ND_WS=ws://127.0.0.1:8769 node campaign.js
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

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
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

const T0 = Date.now()
let stage = '-'
let lastStage = '-'
// Политика повторов (главный цикл): паузы этапа по счёту пустых заходов и сторож прогресса.
const PAUSE_MIN = [5, 10, 20, 40]
const WATCHDOG_MIN = Math.max(1, Number(process.env.ND_WATCHDOG_MIN) || 45)
let manualControl = false
let state = {}
let sit = {}
// Сквозной измеритель: opt-in, ND_E2E=0 — обычная возобновляемая кампания.
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
  log(`СТЫК ${JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - T0) / 1000),
    seam, stage, body: { dimension: state.dimension, pos: state.pos, health: state.health, food: state.food,
      inventory: state.inventory || {}, armor: state.armor || {}, offHand: state.offHand || null,
      potions: state.potions || null, effects: state.effects || null },
    situation: { tod: sit.tod ?? null, night: sit.night ?? null, surface: sit.surface ?? null },
    memory: memorySnapshot, known, flagsExplicit: Object.fromEntries(SEAM_FLAGS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]])) })}`)
}
// Разделитель запуска с датой: в строках журнала только время, а файл копится
// днями — без него вчерашние строки легко принять за сегодняшние (29.09).
if (require.main === module) { try { fs.appendFileSync(LOG, `==== ${new Date().toISOString().slice(0, 10)} ${new Date().toTimeString().slice(0, 8)} запуск кампании, pid ${process.pid}, этапы: ${process.argv[2] || 'все'} ====
`) } catch {} }
function log (line) {
  const t = new Date().toTimeString().slice(0, 8)
  const m = Math.round((Date.now() - T0) / 60000)
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
  // Первое чтение задаёт исходную запись: прежняя смерть не прерывает запуск.
  if (stamp !== undefined) lastDeathSeen = stamp
  if (r.state) state = r.state
  if (E2E && (event || changed)) {
    seamSnapshot('death')
    throw Object.assign(new Error('E2E_DEATH: смерть = провал сквозного прогона'), { stopCampaign: true, code: 'E2E_DEATH' })
  }
  // Аварийный отход автопилота: начало (emergency) и итог (refuge {how, code, hp, healed}) — события шины.
  for (const e of [...(r.by ? [r.by] : []), ...(r.events || [])]) {
    if (e && e.type === 'emergency') refugeSeenAt = Date.now()
    if (e && e.type === 'refuge') { lastRefuge = e; refugeSeenAt = 0 }
  }
}

// Аварийный отход автопилота (autopilot.emergency → survival.refuge, research/dev-B-refuge.md). Пока он идёт, любое
// новое намерение кампании его обрывает (runIntent exclusive), а answerThreat/rest поверх него — это нора и бой там,
// где отход уже строит коробку. Поэтому: ждать его конца опросом status (immediate — тело и current не трогает; не
// wait), после — драться, только если врагов 1–2, и повторить шаг. Отход видно по state.busy === 'refuge' и по
// событию emergency (оно приходит раньше, чем отход займёт тело: автопилот 0.2 с отпускает руки).
let refugeSeenAt = 0
let lastRefuge = null
// Эти вызовы тело не двигают и отход не рвут.
const REFUGE_PASS = new Set(['status', 'situation', 'recall', 'remember', 'stop', 'connect', 'disconnect', 'play_mode'])
// Эти после отхода не повторять: обстановка другая, решает тот, кто звал.
const NO_REPEAT = new Set(['wait', 'flee', 'fight', 'refuge', 'shelter', 'sleep', 'eat', 'escape_fire', 'surface'])
const refugeRunning = () => state.busy === 'refuge' || refugeSeenAt > 0
async function awaitRefuge (why = '') {
  log(`идёт аварийный отход автопилота${why ? ` (${why})` : ''} — жду его конца, своё не зову`)
  // До 10 мин: отход может сидеть в коробке, пока снаружи толпа или ночь (survival.sitTight, ND_REFUGE_SIT, ≤ 9.5 мин).
  for (let i = 0; i < 1200 && !died; i++) {
    // Событие есть, а отход ещё не в current — дать ему начаться (до 2 с), потом верить busy.
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
// После отхода: враги рядом — драться, только если их 1–2 и есть чем; толпа — уйти и дальше дело (dev-B, сцена H:
// после удачного отхода четыре зомби у стен добивали в бою).
async function afterRefuge () {
  if (died) return
  await sense()
  if (!sit.foes || died) return
  const was = fighting
  fighting = true
  try {
    const first = (sit.fight && sit.fight.first) || {}
    // Утопленник — не в бой: трезубец в руке бьёт 11 хп, издали 8 (MOBS.md §3; trap4 02.10: после коробки 20 → 0 за 8 с).
    // Крипер рядом после уклона (ND_CREEPER_DODGE): не бегство с возвратом к той же работе (trapH 02.10: dodge → flee →
    // «повторяю dig_down» → крипер вплотную, CORNERED ×3), а закрытая коробка — без видимости SwellGoal не шипит
    // (MOBS.md), sitTight сидит, пока крипер у стен (≤ 8 бл.).
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
      // Под землёй бегство по пещере — в руки остальным: коробка и вниз из неё (ND_CROWD_REFUGE).
      if (!sit.surface && process.env.ND_CROWD_REFUGE !== '0' && await boxAndDown(`после отхода рядом ${sit.foes} — коробка и вниз`)) return
      await act('flee', { timeoutSeconds: 20 })
    }
  } finally { fighting = was }
}
// Свой отход кампании (rest, невидимый стрелок, неудачная нора): не звать при здоровом теле без врагов — коробка
// ставится и тут же ломается, блоки и секунды впустую.
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

// Под землёй отход кончился «лечиться нечем» (NO_FOOD), а враги рядом: не бой и не бегство по пещере, а штрек в сплошную
// породу прочь (mining.tunnel сам закладывается, если моб идёт следом) — ND_CROWD_REFUGE (pool2 02.10, слот 17: y 3, скелет,
// коробка NO_FOOD 184 с → «бой не принят» → коробка 169 с → ещё 189 с → 4 рядом → бегство → смерть). true — ушёл.
// Коробка (stayIn — из неё не выходить) и нора на 3 прямо из неё, под крышей коробки: дальше этап работает уже снизу
// (лесенка/штрек от дна норы). true — сидит в закрытой норе.
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

// Один вызов намерения: лог, состояние, события, которые важны прогону.
// again — повтор шага после аварийного отхода (не больше двух).
async function act (method, params = {}, again = 0) {
  // Отход идёт — новое намерение его оборвёт: дождаться конца (и ответить на остаток угрозы) до вызова.
  if (!REFUGE_PASS.has(method) && refugeRunning() && !died) {
    await awaitRefuge()
    if (!died && !fighting) await afterRefuge()
    if (died && stage !== '-' && method !== 'stop') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
  }
  // Сумерки/ночь, кровать есть — сон перед каждым переходом маршрута, а не только между шагами: длинный шаг (переход
  // 2 мин) въезжал в ночь, и кровать ставилась уже под зомби (rt3-A3 слот 27: «не смог поставить кровать», смерть).
  if (stage === 'route' && method === 'goto' && !routeSleeping && ROUTE_SLEEP && dim() === 'overworld' && (have(/_bed$/) > 0 || have(/_wool$/) >= 3)) {
    await sense()
    const t = todNow()
    if (t !== null && t >= 12300 && t <= 23459) {
      routeSleeping = true
      try { await routeSleep('перед переходом') } finally { routeSleeping = false }
    }
  }
  // Срок ограничивает и вложенную охоту/литьё, но не аварийное спасение.
  const routeSafety = REFUGE_PASS.has(method) || /^(observe|eat|flee|refuge|shelter|sleep|escape_fire|surface|wait)$/.test(method) ||
    (method === 'fight' && !/^(food|resource)$/.test(params.purpose || ''))
  if (stage === 'route' && routeDeadline && process.env.ND_ROUTE_DEADLINE !== '0' && !routeSafety) {
    const left = Math.floor((routeDeadline - Date.now()) / 1000)
    if (left < 1) throw Object.assign(new Error(`ROUTE_BUDGET: шаг вышел за бюджет (${method})`), { routeBudget: true })
    params = { ...params, timeoutSeconds: Math.min(params.timeoutSeconds ?? left, left) }
  }
  // Маршрут (раунд 3, Codex rt-deaths правка 1): копка камня/руды, лесенка и спуск — не на малом хп и не при враге/в воде.
  // 7 из 24 смертей R7/rtV — в пещерах и забоях после отхода «NO_FOOD» на 4–12 хп (тот же шаг снова). Сначала лечение.
  if (process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_SAFE !== '0' && stage === 'route' && !resting && !fighting && !hunting && dim() === 'overworld') {
    const mining = method === 'dig_down' || method === 'mine_seen' || (method === 'mine' && /stone|_ore/.test(String(params.block || '')))
    const descent = method === 'goto' && Number.isFinite(params.y) && state.pos && params.y < state.pos.y - 3
    if (mining || descent) {
      await sense()
      const why = (state.health ?? 20) < 13 ? `хп ${Math.round(state.health ?? 0)}` : sit.foes ? `врагов ${sit.foes}` : sit.inWater ? 'в воде' : sit.buried ? 'завалило' : ''
      if (why) throw Object.assign(new Error(`ROUTE_UNSAFE: ${method} при «${why}» — сперва лечение/уход`), { routeUnsafe: true })
    }
  }
  if (method === 'portal' && params.mode === 'enter') seamSnapshot('before-portal')
  if (method === 'stronghold' && params.mode === 'fill' && params.enter) seamSnapshot('before-end')
  let r
  const dimBefore = state.dimension || 'overworld'
  try {
    r = await call(method, params)
  } catch (e) {
    log(`${method} RPC-ОШИБКА ${e.message}`)
    return { status: 'failed', error: e.message, detail: {} }
  }
  acceptResult(r)
  if (state.dimension && state.dimension !== dimBefore) seamSnapshot(`${dimBefore}->${state.dimension}`)
  // Был в Аду (хоть на секунду) — первый вход маршрута состоялся (routeEnter не тащит обратно второй раз).
  if (state.dimension === 'the_nether' || /Мир сменился \(верхний мир → Ад\)/.test(String((r.detail && r.detail.stopped) || ''))) routeEntered = true
  if (stage !== '-' && state.playPolicy?.mode === 'free') {
    manualControl = true
    throw new Error('игрок переключил free — передаю управление, кампанию прекращаю')
  }
  const d = r.detail || {}
  const bits = []
  if (r.error) bits.push(`ошибка: ${String(r.error).slice(0, 300)}`)
  if (d.stopped) bits.push(`stopped: ${String(d.stopped).slice(0, 300)}`)
  if (d.need) bits.push(`need: ${JSON.stringify(d.need)}`)
  if (d.note) bits.push(`note: ${String(d.note).slice(0, 200)}`)
  if (d.gained && Object.keys(d.gained).length) bits.push(`+${JSON.stringify(d.gained)}`)
  if (Array.isArray(d.kills) && d.kills.length) bits.push(`убиты: ${d.kills.join(',')}`)
  if (typeof d.picked === 'number') bits.push(`подобрано: ${d.picked}`)
  // Разбор проигранных боёв по журналу (2026-09-29 12:48: зомби убил с 20 хп,
  // а в строке fight не было ни цели, ни взмахов).
  if (method === 'fight' && (d.target || d.swings !== undefined)) bits.push(`бой: ${d.target || '?'}, взмахов ${d.swings ?? 0}, попаданий ${d.landed ?? '?'}`)
  if (d.arrows) bits.push(`выстрелы: ${d.arrows}`)
  // Литьё: сколько отлито, черпаков, копки, окон, где место (разбор глубокого литья, поток overworld).
  if (method === 'portal' && Array.isArray(d.cast)) bits.push(`литьё: ${d.frame || ''} отлито ${d.cast.length}, черпаков ${d.refills ?? 0}, копано ${d.dug ?? 0}, окон ${d.windows ?? 0}${d.skipped ? `, пропущено ${d.skipped}` : ''}${d.site ? `, место ${JSON.stringify(d.site)}` : ''}${d.lit !== undefined ? `, зажёг ${d.lit}` : ''}${Array.isArray(d.trace) && d.trace.length ? `; след: ${d.trace.slice(-8).join(' / ')}` : ''}`)
  const evs = (r.events || []).filter(e => /death|УМЕР|fleeing|retaliat|no_tool|buried|stuck|looted|dimension/.test(e.type))
  if (evs.length) bits.push(`события: ${evs.map(e => e.type).join(',')}`)
  if (r.by) bits.push(`прервано: ${r.by.type}`)
  // Машинная причина исхода (session.resultCode): сцены фермы классифицируют провалы по ней, не по прозе.
  if (r.code && r.code !== 'OK') bits.push(`код ${r.code}`)
  const p = state.pos ? `(${state.pos.x},${state.pos.y},${state.pos.z})` : ''
  log(`${method} ${JSON.stringify(params)} → ${r.status} hp${Math.round(state.health ?? 0)} еда${state.food ?? '?'} ${p} ${bits.join(' | ')}`)
  if (died && stage !== '-' && method !== 'stop') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
  // Шаг оборвал аварийный отход автопилота (или тело уже в нём) — не отвечать поверх (answerThreat/rest рвали бы
  // коробку), дождаться конца, врагов 1–2 — бой, толпа — уход; потом тот же шаг ещё раз.
  const cut = !REFUGE_PASS.has(method) && method !== 'refuge' && ((r.by && r.by.type === 'emergency') || state.busy === 'refuge')
  if (cut) {
    const ref = await awaitRefuge(r.by && r.by.type === 'emergency' ? (r.by.why || r.by.from || '') : '')
    if (!died && !fighting && !(await tunnelAway(ref && ref.code))) await afterRefuge()
    if (died && stage !== '-') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
    // Отход не вылечил (бегство прижали, есть нечего): на малом хп — своя отлёжка (отход кампании до 16), а не
    // тот же шаг под стрелами (A5 слот 13, 21:31: «flee CORNERED, хп 14 → 9» и сразу mine со скелетом рядом).
    // Маршрут (ND_ROUTE_SAFE): порог отлёжки и повтора — 13, а не 10 (тот же шаг на 10–12 хп кончался пещерой/стрелой).
    const hpLine = process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_SAFE !== '0' && stage === 'route' ? 13 : 10
    if (!died && !resting && !fighting && (state.health ?? 20) < hpLine) await rest()
    if (died && stage !== '-') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
    // Повтор — только оборванного шага: кончился сам, а отход начался после — не повторять (крафт дважды).
    // Мир сменился посреди шага (портал сработал, а потом отход) — не повторять: повтор portal enter вёл обратно домой
    // (rt3-A2 слот 27: вход в Ад на 18-й мин, крипер у портала, повтор шага — снова в верхний мир, второй вход на 27-й).
    if (!died && r.status !== 'done' && (state.health ?? 20) >= hpLine && !NO_REPEAT.has(method) && again < 2 && (state.dimension || 'overworld') === dimBefore) {
      log(`повторяю шаг после отхода: ${method}`)
      return act(method, params, again + 1)
    }
    return r
  }
  // Лава, увиденная по дороге (observe на охоте, explore) — запомнить: портал
  // льётся у лавы, а искать её вслепую — прогулка на полчаса.
  if (dim() === 'overworld' && r.detail) {
    // blocks у разных намерений — разное (у observe массив, у копки — число):
    // «(r.detail.blocks || []).find is not a function» валил этап железа.
    // Лава, упёршая копку («лава у -414,5,431 — дальше не копаю» штрека и лесенки), — тоже увиденная лава.
    const dugInto = /лава (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String(r.detail.stopped || ''))
    const seenLava = (Array.isArray(r.detail.blocks) ? r.detail.blocks : []).find(b => b && b.name === 'lava') ||
      (r.detail.found === 'lava' && r.detail.at ? { nearest: r.detail.at } : null) ||
      (dugInto ? { nearest: { x: +dugInto[1], y: +dugInto[2], z: +dugInto[3] } } : null)
    // Глубокий путь (ND_OW_DEEP): ближняя лава важнее давно виденной — литьё идёт у той, что рядом с телом.
    const closer = q => OW_DEEP && !!known.lava && !!state.pos && Math.hypot(q.x - state.pos.x, (q.y ?? y()) - state.pos.y, q.z - state.pos.z) + 8 <
      Math.hypot(known.lava.x - state.pos.x, (known.lava.y ?? y()) - state.pos.y, known.lava.z - state.pos.z)
    if (seenLava && seenLava.nearest && (!known.lava || closer(seenLava.nearest))) {
      known.lava = seenLava.nearest
      log(`видел лаву на ${known.lava.x},${known.lava.y},${known.lava.z} — запомнил`)
      try { await call('remember', { kind: 'лава', text: `лава на ${known.lava.x},${known.lava.y},${known.lava.z}`, place: 'лава' }) } catch {}
    }
    // Глубокий путь: вода, у которой встали штрек/колодец/лесенка или которую видно в обзоре, — для ведра потом
    // (deepWater идёт к ближней известной, а не ищет штреками вслепую: ow-E1 слот 13 — 5 штреков без воды и подъём).
    if (OW_DEEP && !known.portal && !have('water_bucket')) {
      const wet = /вода (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String(r.detail.stopped || ''))
      const seenW = (Array.isArray(r.detail.blocks) ? r.detail.blocks : []).find(b => b && b.name === 'water' && b.nearest)
      const q = wet ? { x: +wet[1], y: +wet[2], z: +wet[3] } : seenW ? seenW.nearest : null
      if (q && state.pos && y() < 60 && (!knownWater || Math.hypot(q.x - state.pos.x, q.y - state.pos.y, q.z - state.pos.z) < Math.hypot(knownWater.x - state.pos.x, knownWater.y - state.pos.y, knownWater.z - state.pos.z))) knownWater = q
    }
  }
  // Завалило посреди работы (штрек или колодец под гравием) — следующее
  // копающее намерение этапа сорвало бы откапывание автопилота: сначала ждать.
  if (!died && !fighting && (r.events || []).some(e => /^(buried|digging_out|still_buried)$/.test(e.type))) {
    await sense()
    if (sit.buried) await waitDugOut()
  }
  // Бьют — ответить: мозг на урон дерётся или уходит, а не идёт дальше гулять
  // (кампания 2026-09-25: десять прогулок подряд под ударами, 17→11 хп).
  // Решение — по вердикту assess (situation), а не по одному «есть ли меч».
  const hurt = (r.by && (r.by.type === 'damage' || r.by.type === 'low_health')) || (r.events || []).some(e => e.type === 'damage')
  if (hurt && !fighting && !died && !SELF_GUARDED.has(method)) {
    fighting = true
    try { await answerThreat(hurtCause(r), hurtSource(r)) } finally { fighting = false }
  }
  // Жизнь дороже этапа: ранен — прервать план и отлежаться (в норе, если
  // рядом враги или темно), а не слать тело дальше. Кампания 2026-09-25
  // умерла именно так: четыре прогулки подряд по пещере на 17→13→2 хп.
  if (!resting && !fighting && method !== 'wait' && (state.health ?? 20) < 10 && !died &&
    (Date.now() > restIdleUntil || have(FOOD) || have(RAW))) await rest()
  // Ранен и есть нечего, а этап — не охота: бросить этап, выбор начнёт с еды.
  // 2026-09-26 (13:22-13:27) этап камня копал на 5 → 1 → 2 хп без куска в
  // рюкзаке и кончился «NeuroRun drowned» в карьере у воды.
  if (!died && !resting && !fighting && !hunting && stage !== '-' && stage !== 'food' && weakAndHungry()) {
    throw new Error(`хп ${Math.round(state.health ?? 0)} и еды нет — бросаю «${stage}», сначала еда`)
  }
  return r
}
let hunting = false
// До этого часа отлёжка не зовётся: днём без еды она ничего не лечит (rest).
let restIdleUntil = 0
// Эти намерения сами следят за боем и хп — отвечать поверх них не надо.
// wait — НЕ из них: 2026-09-26 бот «отлёживался» ожиданием на 6 хп в пещере,
// скелет из темноты бил сквозь каждое wait (7 → 3 → 0), и ни одного ответа.
const SELF_GUARDED = new Set(['fight', 'flee', 'refuge', 'blaze', 'pearls', 'dragon', 'sleep', 'bastion'])
let died = false
let lostBag = null
let lostAt = null
let resting = false
let fighting = false

// Обстановка у демона (director.situation): под крышей, ночь, враги, вердикт.
async function sense () {
  try {
    const r = await call('situation')
    acceptResult(r)
    if (r.detail) sit = r.detail
  } catch (e) { log(`situation RPC-ОШИБКА ${e.message}`) }
  return sit
}

// Тип урона (session.wireHealth → damage.cause, реестр damage_type 1.21.11). Не нападение: свой голод,
// падение, удушье, огонь и лава, вода, холод, кактус, эффекты (яд и иссушение тикают типом magic/wither —
// сам удар моба пришёл раньше своим типом). От такого урона нора не спасает — 2026-09-30 разбор: голод
// звал answerThreat → нора → отказ → БЛОКЕР.
const ENV_DAMAGE = new Set(['starve', 'fall', 'in_wall', 'on_fire', 'in_fire', 'lava', 'hot_floor', 'campfire', 'drown', 'dry_out',
  'freeze', 'cactus', 'sweet_berry_bush', 'cramming', 'fly_into_wall', 'stalagmite', 'falling_block', 'falling_anvil',
  'falling_stalactite', 'out_of_world', 'outside_border', 'generic', 'generic_kill', 'lightning_bolt', 'ender_pearl', 'magic',
  'wither', 'dragon_breath', 'bad_respawn_point'])
// Причина урона по ответу намерения: удар моба (или неизвестный тип) важнее среды, если были оба.
function hurtCause (r) {
  const evs = [...(r.by && r.by.type === 'damage' ? [r.by] : []), ...(r.events || []).filter(e => e.type === 'damage')]
  const causes = evs.map(e => e.cause || 'unknown')
  return causes.find(c => !ENV_DAMAGE.has(c)) || causes[0] || 'unknown'
}
// Кто ударил (session.wireHealth: damage.source — имя сущности-виновника).
function hurtSource (r) {
  const evs = [...(r.by && r.by.type === 'damage' ? [r.by] : []), ...(r.events || []).filter(e => e.type === 'damage')]
  return (evs.reverse().find(e => e.source) || {}).source || null
}

// Уйти от воды на dist блоков поверху: от ближайшей видимой воды, не видно — по курсу прогулки.
async function awayFromWater (dist = 20) {
  const o = await act('observe', { radius: 16 })
  const wet = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'water')
  if (died) return
  try { await awayFrom(wet && wet.nearest ? wet.nearest : null, dist) } catch (e) { log(`от воды не ушёл: ${e.message}`) }
}

// Ходячие рядом по списку сущностей (RPC peek: flee.hostilesAround, без луча): горизонталь ≤ r, по высоте ±4, стрелки и
// крипер не в счёт.
async function nearWalkers (r = 10) {
  try {
    const p = await call('peek')
    return ((p && p.detail && p.detail.foes) || []).filter(f => f && f.d <= r && Math.abs(f.dy || 0) <= 4 &&
      !/^(skeleton|stray|bogged|parched|pillager|witch|blaze|ghast|creeper|enderman|zombified_piglin|piglin)$/.test(f.name)).length
  } catch { return 0 }
}
async function answerThreat (cause = 'unknown', source = null) {
  await sense()
  // Завалило (голова в блоке) — урон от удушья, а не от врага. Откапывает
  // автопилот, и всякое копающее намерение поверх него рвёт его взмах: не
  // копать, только ждать (2026-09-26, «suffocated in a wall» — кампания на
  // каждый тик урона звала нору и колодец).
  if (sit.buried) { await waitDugOut(); return }
  // Горит или в лаве — вон оттуда, а не нору копать: 2026-09-26 бот на уроне
  // от лавы «зарылся» прямо в ней («tried to swim in lava»).
  if (sit.inLava || sit.onFire) {
    await act('escape_fire')
    await sense()
    if (sit.inLava) await act('escape_fire')
    return
  }
  if (ENV_DAMAGE.has(cause)) {
    // Голод: поесть, если есть что; нечего — этап бросит act (weakAndHungry), выбор начнёт с еды.
    if (cause === 'starve') {
      if (have(FOOD) || have(RAW)) await act('eat')
      else log('урон от голода, еды нет — нора не лечит, нужна еда')
      return
    }
    if (cause === 'drown' && sit.inWater) { await act('surface', { targetY: y() + 2, timeoutSeconds: 20, preferPillar: false }); return }
    log(`урон «${cause}» — не нападение, нору не копаю`)
    return
  }
  // Первый в очереди боя — assess.plan (situation.fight.first); поля sit.first у обстановки нет, и ветки крипера и
  // стрелка ниже не срабатывали никогда.
  const first = (sit.fight && sit.fight.first) || sit.first || {}
  // Утопленник, а я в воде или у самой воды: в воде тело медленное, трезубец бьёт издали, из воды лезут новые —
  // не драться там, а уйти на сушу прочь от воды (fresh-A1/A2 30.09: «slain by Drowned» — частая смерть у рек
  // и морей; одна схватка у реки днём — 20 → 4 хп за 12 с). Утопленник под водой часто не виден (foes 0) — тип
  // и виновник урона его называют. На суше догнавшего — обычным боем, следующим уроном.
  // Уход — бегом (flee уроном не рвётся): goto прочь от воды рвался каждым ударом трезубца, и тело за 20 с
  // сдвигалось на 2–3 блока (fresh-A3 слот 11, 30.09: четыре «ухода» подряд — смерть). Утопленник на виду, а я на
  // суше — обычный бой ниже («он тут один — дерись прямо здесь»).
  const drowned = source === 'drowned' || first.name === 'drowned'
  if (drowned && sit.inWater) {
    // Бегом (flee 15 с) тело плыло вдоль воды и оставалось в ней (разбор смертей A1–A4: 31 из 98 — вода) — на сушу:
    // всплыть, к берегу; не вышло — аварийный отход (он тоже начинает с выхода из воды).
    log('бьёт утопленник, я в воде — в воде не дерусь, на сушу')
    if (!(await leaveWater()) && !died) await refugeRun('утопленник, я в воде')
    return
  }
  if (drowned && !sit.foes && await waterNear(6)) {
    log('бьёт невидимый утопленник у воды — ухожу на сушу подальше от воды')
    await awayFromWater(24)
    return
  }
  // Утопленник на виду, я на суше (ND_REFUGE_SHORE): не бой — у него трезубец (11 хп вблизи, 8 издали), он в воде
  // быстрее; на суше он вдвое медленнее нас — прочь от воды (trap4 02.10: бой с утопленником после коробки, 20 → 0 за 8 с).
  if (process.env.ND_REFUGE_SHORE !== '0' && drowned && !sit.inWater) {
    log('утопленник рядом, я на суше — не дерусь, ухожу от воды')
    if ((state.health ?? 20) < 12) await refugeRun('утопленник, хп мало')
    else await awayFromWater(24)
    return
  }
  // Бьют, а врага не видно (скелет в темноте пещеры дальше 16 блоков,
  // assess его не считает) — не стоять. Так умер прогон 2026-09-26: «was shot by Skeleton».
  // Раньше — нора на 2 при любом хп (и тут же выход следующим шагом); теперь аварийный отход (survival.refuge:
  // из-под прицела бегом, коробка у стены, нора; внутри лечение до 16) — когда хп уже ниже 16. Выше — дальше дело:
  // ещё удар — снова сюда.
  if (!sit.foes) {
    if (sit.inWater || dim() === 'the_end') return
    if ((state.health ?? 20) < 16) await refugeRun(`бьёт невидимый (${cause}${source ? ' ' + source : ''})`)
    else log(`бьёт невидимый (${cause}${source ? ' ' + source : ''}), хп ${Math.round(state.health ?? 0)} — дальше дело`)
    return
  }
  if (first.swelling) { await act('flee', { timeoutSeconds: 15 }); return }
  // Толпа ходячих (≥ 3 ближе 10 бл.) — в коробку и пересидеть (refuge + sitTight), а не в бой: один на один каменным
  // мечом выходит, когда бьют трое — нет (trap0 02.10, пещера: 1 из 5 выжил — бой с зомби при пауке и скелете рядом,
  // 20 → 2 за 16 с). по умолчанию так (ND_CROWD_REFUGE=0 — выкл.; нужен и ND_REFUGE_SIT у демона, тоже по умолчанию).
  if (process.env.ND_CROWD_REFUGE !== '0') {
    // Под землёй видимость врёт: из своей лесенки толпу в пещере не видно (trapH 02.10, пещера: видел одного зомби — бой,
    // в бою подошли паук, зомби и скелет, 20 → 8 за 8 с). Там — счёт по сущностям рядом (peek, без луча), как у сцены.
    const seen = ((sit.fight && sit.fight.order) || []).filter(f => f && f.dist <= 10 && !f.ranged).length
    const walkers = sit.surface ? seen : Math.max(seen, await nearWalkers(10))
    if (walkers >= 3) {
      // Под землёй толпа не расходится (тёмная пещера — спавн без конца): коробка и из неё вниз, работа уже оттуда
      // (trapI 02.10, пещера: коробка 189 с → «рядом 4 — ухожу» → бегство по закрытой комнате → смерть).
      if (!sit.surface && await boxAndDown(`толпа: ${walkers} ходячих ближе 10 бл. — коробка и вниз из неё`)) return
      await refugeRun(`толпа: ${walkers} ходячих ближе 10 бл.`, { minHp: 20 }); return
    }
  }
  // Стрелок, а в левой руке щит: бежать — значит подставлять спину (обе смерти
  // 2026-09-26 — «shot by Skeleton», вторая на бегу с 8 хп). Щит гасит стрелы
  // спереди, и fight сам поднимает его на сближении со стрелком.
  const shield = have('shield') > 0 || /shield/.test(JSON.stringify(state.offHand || ''))
  if (first.ranged && shield && sit.armed && (state.health ?? 20) >= 5) {
    const f = await fightOrLeave({ timeoutSeconds: 45, retreatAtHealth: 4, shield: 'always' })
    return f
  }
  if (sit.armed && (state.health ?? 20) >= 10 && sit.verdict !== 'уходить') {
    const f = await fightOrLeave({ timeoutSeconds: 45, retreatAtHealth: 7 })
    if (f && f.detail && (f.detail.kills || f.detail.killed)) log(`отбился: ${JSON.stringify(f.detail.kills || f.detail.killed)}`)
    // Одного убил, а рядом ещё двое и больше (или стрелок при ходячем) — не к работе спиной к ним, а в укрытие и
    // пересидеть (trap2 02.10, пещера: после убитого зомби — лесенка дальше, скелет и паук вплотную, смерть).
    if (process.env.ND_CROWD_REFUGE !== '0' && !died) {
      // ND_CROWD_CHAIN=1: не к работе, пока рядом есть кто-то ещё — следующий один на один (меч, хп ≥ 12), иначе
      // укрытие; до трёх раз (trap5 02.10, пещера: зомби → лесенка → паук → лесенка → зомби+скелет, смерть).
      const chain = process.env.ND_CROWD_CHAIN !== '0' ? 3 : 1
      for (let k = 0; k < chain && !died; k++) {
        await sense()
        const left = ((sit.fight && sit.fight.order) || []).filter(o => o && o.dist <= (chain > 1 ? 12 : 10))
        // Под землёй — и те, кого из лесенки не видно (peek): trapH 02.10, пещера r12 — после зомби и скелета «рядом никого»,
        // лесенка → зомби вплотную и паук, 13 → 0.
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
  // На малом хп — аварийный отход (коробка у стены / бегство, внутри лечение), а не голый бег на 40 с.
  if ((state.health ?? 20) < 16) { await refugeRun(`враги ${sit.foes}, хп ${Math.round(state.health ?? 0)}`); return }
  // Толпа не по силам (вердикт assess «уходить») — коробка и пересидеть, а не бегство по кругу (trapH 02.10, пещера:
  // закрытая комната, «flee 40 с» от паука, зомби и скелета → 13 → 0). ND_CROWD_REFUGE.
  if (process.env.ND_CROWD_REFUGE !== '0' && sit.verdict === 'уходить') { await refugeRun(`враги ${sit.foes} не по силам`, { minHp: 20 }); return }
  const f = await act('flee', { timeoutSeconds: 40 })
  // Прижали — бежать некуда: драться тем, что есть.
  if (f.detail && f.detail.cornered && sit.armed) await act('fight', { timeoutSeconds: 40, retreatAtHealth: 4 })
}

// Бой, который бот не принимает: fight отвечает done без ударов, если сытость < 18, еды мало или запас хп меньше
// размена (combat-safety.evaluate). Разбор смертей A1–A4 (98): в 53 fight отказался за минуту до смерти, и моб
// добивал стоящее тело. Поэтому: сытость ниже 18 и еда есть — сперва доесть; отказ — не стоять, а уйти
// (хп < 16 — аварийный отход, выше — бегом).
const FIGHT_REFUSED = /размена|сытость не позволяет|запаса еды|нечем восстановить|не переживу|опасность под ногами|бросил бой/
async function fightOrLeave (params) {
  // Доедать под ударами — кусок 1.6 с, это удар зомби (3 хп): с 8 хп и выше — доесть и драться; меньше — отход.
  // Порог был 14 — A5 слот 10 (21:43): зомби в штреке, хп 13, сытость 17 → отход «укрыться не вышло» и смерть за 6 с,
  // где один кусок и бой каменным мечом его бы убили.
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

// Из воды на сушу: всплыть (surface ищет сухую клетку рядом), не вышло — к берегу двумя отрезками. true — на суше.
async function leaveWater () {
  await sense()
  if (!sit.inWater) return true
  const was = fighting
  fighting = true
  try {
    // ND_REFUGE_SHORE=1: к берегу подальше от утопленников отходом (survival.toShore; урон его не рвёт), а не
    // «всплыть» (surface рвался каждым ударом трезубца: A6 30.09 — «поднялся на −1 … прервано», смерть в воде).
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

// Ждать, пока автопилот откопает голову: wait не копает и его не рвёт.
async function waitDugOut () {
  log('завалило — не копаю, жду, пока автопилот откопает')
  // fighting: урон удушья посреди wait не должен звать ответ заново (рекурсия).
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

async function rest () {
  resting = true
  try {
    await sense()
    if (sit.buried) await waitDugOut()
    // В воде ждать регенерации нельзя: открытый воздух важнее норы.
    if (sit.inWater) {
      const was = fighting
      fighting = true
      try { await act('surface', { targetY: y() + 2, timeoutSeconds: 30, preferPillar: false }) } finally { fighting = was }
      await sense()
      // Не всплыл на сушу — к берегу, как ночной сторож: до двух отрезков прочь.
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
    // Враг рядом — аварийный отход (survival.refuge: коробка у стены, бегство, нора; внутри еда до 16 хп), а не бой
    // на малом хп и не нора под ним (research/dev-B-refuge.md, правка 2; fresh-A4 слот 13: нора под зомби 20 → 6).
    if (sit.foes > 0) await refugeRun(`мало хп (${Math.round(state.health ?? 0)}), врагов ${sit.foes}`)
    if (died || (state.health ?? 0) >= 16) return
    // Днём без еды нора ничего не лечит (регенерация — с сытости 18): лечение
    // тут — охота. Иначе каждая прогулка за животными кончалась норой и
    // пятнадцатью секундами ожидания (2026-09-26, 8 хп, сытость 17).
    await sense()
    if (!have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 && !sit.night) {
      // Рассвет, а ходячие ещё рядом (горят не сразу) и хп < 10 — не на охоту к ним, а ещё посидеть в коробке
      // (ND_REFUGE_SIT; trapH 02.10, lowhp: 8 мин в коробке → «день, иду на охоту» на 5 хп → зомби в 5 бл. → смерть).
      if (process.env.ND_REFUGE_SIT !== '0' && sit.foes > 0 && (state.health ?? 20) < 10 && !died) {
        log(`еды нет, рассвет, хп ${Math.round(state.health ?? 0)}, врагов рядом ${sit.foes} — сижу, пока не сгорят или уйдут`)
        await refugeRun(`рассвет, хп мало, врагов ${sit.foes}`, { minHp: 20, maxSeconds: 120 })
        if (died) return
        await sense()
      }
      log('еды нет, день — лечит только охота, иду')
      // Не звать отлёжку на каждом шаге охоты, пока нечем лечиться (act).
      restIdleUntil = Date.now() + 60000
      return
    }
    // Поесть сразу: автопилот ест, только когда тело свободно, а тут шаг за
    // шагом — бегство, нора, ожидание. 2026-09-26 бот умер на 6 хп с десятью
    // кусками жареного в рюкзаке. Сытость ≥18 — это и есть лечение.
    // Сырое — сперва в печь (печь в рюкзаке): жареное втрое сытнее.
    if (have(RAW) && !sit.foes && !(routeHealing && process.env.ND_ROUTE_ENTERHEAL !== '0')) await cook()
    if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
    // Respawn/healing can finish during a bite. Do not dig a new shelter
    // after the reason for resting has already disappeared.
    if ((state.health ?? 0) >= 16) return
    // Ночь без еды не лечит. Близкая кровать позволяет пропустить её, даже
    // если здоровье пока не разрешает охоту. Дальнюю дорогу на 6 хп не начинаем.
    if (dim() === 'overworld' && sit.night && sit.foes === 0 && !sit.buried) {
      await readMemory()
      const sb = known.spawnBed
      const closeBed = sb && state.pos && Math.hypot(sb.x - state.pos.x, sb.y - state.pos.y, sb.z - state.pos.z) <= 8
      if (closeBed || sit.bed || have(/_bed$/)) {
        log('восстановление ночью — сначала пробую ближайшую кровать')
        // Маршрут: кровать из рюкзака — как у сторожа ночи (take, бункер по месту): с take:false/bunker:false сон падал
        // «invalid operation», и тело 4 мин сидело в норе с кроватью в рюкзаке (rt3-V1 слот 10).
        const r = await act('sleep', process.env.ND_ROUTE === '1' && have(/_bed$/) > 0 && !closeBed
          ? { untilMorning: true, take: true, timeoutSeconds: 120 }
          : { untilMorning: true, take: false, bunker: false, invite: false, waitSeconds: 10, timeoutSeconds: 60 })
        await sense()
        if ((state.health ?? 0) >= 16) return
        if (r.detail?.morning && !sit.night && !have(FOOD) && !have(RAW) && (state.food ?? 20) < 18) {
          restIdleUntil = Date.now() + 60000
          await act('shelter', { mode: 'exit' })
          log('ночь пропущена — иду за едой, ожидание не восстановит хп')
          return
        }
      }
    }
    // В Аду нора — это яма в незераке над лавой, а огонь и гасты не ждут:
    // лечиться — домой по проверенному пути к порталу.
    // 2026-09-26 (11:31-11:32) бот дважды отлёживался в Аду на 6-7 хп, горел,
    // и умер, так и не дойдя до портала в 120 блоках.
    // ND_NE_STAY=1 (поток nether 03.10): еда есть — лечиться в толще Ада (ne_burrow: карман 1×2 в сплошном камне, без
    // жидкостей рядом), а не дорога домой через пол-Ада (B0-6: «мало хп — домой», B0-1/21/24: смерти после возврата).
    if (process.env.ND_NE_STAY === '1' && dim() === 'the_nether' && (have(FOOD) || (state.food ?? 0) >= 18)) {
      const bw = await act('ne_burrow', { why: 'лечиться в Аду' })
      await refresh()
      const bd = bw.detail || {}
      if (!died && dim() === 'the_nether' && (bd.ok || /уже в своём штреке/.test(bd.why || ''))) {
        log('в Аду мало хп — лечусь в толще (ND_NE_STAY)')
        for (let i = 0; i < 12 && (state.health ?? 20) < 16 && !died; i++) {
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
        for (let i = 0; i < 12 && (state.health ?? 20) < 16 && !died; i++) {
          const w = await act('wait', { seconds: 10 })
          if (w.by && w.by.type === 'damage') break
          if ((state.food ?? 20) < 18 && (have(FOOD) || have(RAW))) await act('eat')
        }
        return
      }
    }
    // Лечиться нечем, а наверху ночь — сидеть в норе до утра: выйти на 5 хп в темноту за едой — смерть
    // (2026-09-26, «shot by Skeleton» на 1 хп). Отход на это не годится: он длится ≤ 2 мин и выходит, когда есть нечего.
    if (!have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 && sit.night && dim() === 'overworld') {
      await holeTillMorning()
      return
    }
    // Отлёжка — аварийным отходом (survival.refuge, research/dev-B-refuge.md, правка 2), а не норой с ожиданием:
    // коробка у стены / нора / бегство по месту и врагам, внутри еда до сытости и ожидание до 16 хп (≤ 2 мин), выход.
    // Сцена refuge L+M: 55/56 выжили и вылечились; нора кампании — 20 → 6 под зомби за 10 с копки (fresh-A4 слот 13).
    await refugeRun(`отлёжка: хп ${Math.round(state.health ?? 0)}`, { minHp: 16, maxSeconds: 120 })
  } finally { resting = false }
}

// Ночь без еды на малом хп: нора до рассвета (лечения нет — сидеть, пока светло не станет).
// ND_NIGHT_DOWN: аварийная пересидка — одна за ночь (до 4 мин); второй зов (rest с другого места) — работа внизу, а не
// ещё 4 мин (trapH 02.10, lowhp: 4 мин + 4 мин в норе подряд).
let nightSatUntil = 0
async function holeTillMorning () {
  // Нора недавно не вышла (shelterFailed) — не копать ту же яму снова.
  if (Date.now() < shelterFailUntil) return
  if (NIGHT_DOWN && Date.now() < nightSatUntil) { log('ночь: аварийно уже отсидел — работаю внизу'); restIdleUntil = Math.max(restIdleUntil, nightSatUntil); return }
  // Нора в камне — только киркой: без неё «stone голыми руками не
  // ломается», и ночь на 1 хп в неглубокой яме (2026-09-26, 13:31). Кирка —
  // из того, что в рюкзаке (ensurePick).
  if (!have(/_pickaxe$/)) await ensurePick()
  if (!(await restShelter())) return
  // ND_NIGHT_DOWN: авария (мало хп, лечиться нечем) — сидеть не до утра, а до 4 мин, дальше работа внизу (nightBelow).
  log(NIGHT_DOWN ? 'еды нет, ночь — авария: сижу в норе до 4 мин, потом работаю внизу' : 'еды нет, ночь — сижу в норе до утра')
  for (let k = 0; k < (NIGHT_DOWN ? 8 : 40) && !died; k++) {
    const w2 = await act('wait', { seconds: 30 })
    if (w2.by && w2.by.type === 'damage' && !died && !(await restShelter())) return
    await sense()
    if (!sit.night) break
  }
  // Отлёжка не зовётся снова 10 мин: иначе следующий же шаг на хп < 10 вернул бы сюда (act → rest).
  if (NIGHT_DOWN && sit.night && !died) { nightIdleS += 240; restIdleUntil = Date.now() + 600000; nightSatUntil = Date.now() + 600000; log('ночь: 4 мин в норе — дальше работаю внизу, наверх не лезу'); return }
  log('еды нет — лечиться нечем, иду за едой')
  if (!died) await act('shelter', { mode: 'exit' })
}

const closedShelter = r => r.status === 'done' && r.detail?.sealed === true
async function restShelter () {
  let r = await act('shelter', { mode: 'enter', depth: 3 })
  // Нора не закрылась (вода, край, ферма 30.09 chain1-8: «я в воде — тут не окопаешься» на 12 хп → БЛОКЕР и
  // отключение): из воды — к берегу, иначе наверх, и ещё раз; не вышло — лечиться едой без норы.
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
    if ((state.health ?? 0) >= 8) { log(`нора не закрылась, хп ${Math.round(state.health)} — дальше без отлёжки`); restIdleUntil = Date.now() + 90000; return false }
    await shelterFailed('NO_SEAL', 'укрытие не закрыто — лечение ожиданием небезопасно')
    return false
  }
  return true
}

// Укрытие не вышло (вода, песок, нет кирки, Ад). Раньше — БЛОКЕР и отключение тела (abortUnsafe): 32 % провалов
// фермы и 10 из 16 остановок основного мира. Решение пользователя 30.09: неудачная нора не отключает бота —
// РИСК с классом в журнал (сцены его считают, провал не маскируется), от угроз — бегом, и жить дальше;
// три минуты без новых нор на том же месте. Останов кампании — только сторож прогресса.
let shelterFailUntil = 0
let shelterRisks = 0
async function shelterFailed (klass, reason) {
  shelterRisks++
  shelterFailUntil = Date.now() + 180000
  restIdleUntil = Math.max(restIdleUntil, Date.now() + 90000)
  log(`РИСК укрытие:${klass} — ${reason}; не отключаюсь: ухожу от угроз и продолжаю (${shelterRisks}-й за запуск)`)
  await sense()
  // От угроз и на малом хп — аварийный отход (коробка у стены / бегство; research/dev-B-refuge.md, правка 2), а не
  // голый бег: коробка держит, пока ходячие не разойдутся, и лечит до 16.
  if ((sit.foes > 0 || (state.health ?? 20) < 16) && !died) await refugeRun(`укрытие:${klass} — ${reason}`)
}
let detached = false
async function abortUnsafe (reason) {
  reason = `БЛОКЕР: ${reason}`
  log(reason)
  // Отменить работу и убрать своё тело из опасности, пока мозг остановлен.
  // Управляющие вызовы не запускают отлёжку или новую реакцию на урон.
  try { await call('stop') } catch (e) { log(`stop RPC-ОШИБКА ${e.message}`) }
  try { await call('disconnect', { reason }); detached = true } catch (e) { log(`disconnect RPC-ОШИБКА ${e.message}`) }
  const error = new Error(reason)
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
  let n = 0
  for (const [k, v] of Object.entries(inv)) if (typeof re === 'string' ? k === re : re.test(k)) n += v
  return n
}
const y = () => (state.pos ? state.pos.y : 64)
const dim = () => state.dimension || 'overworld'

const LOGS = /_(log|stem)$/
const COBBLE = /^(cobblestone|cobbled_deepslate|blackstone)$/
const RAW = /^(beef|porkchop|mutton|chicken|rabbit|cod|salmon)$/
const FOOD = /^(cooked_[a-z_]+|bread|baked_potato|golden_carrot|apple|carrot|sweet_berries|melon_slice|pumpkin_pie|golden_apple|mushroom_stew|beetroot_soup|rabbit_stew|dried_kelp|cookie)$/
// Запас еды — в «кусках» по сытости (src/play-policy foodUnits), не в штуках:
// с 5 дольками арбуза «6 из 8» пускало в бой, которому нужна втрое большая
// сытость (2026-09-29, 12:28: баранина и 4 дольки ушли за один отдых).
const { foodUnits: unitsOfFood } = require(path.join(__dirname, 'src', 'play-policy'))
const foodUnits = () => unitsOfFood(state.inventory)
const PICK_STONE = /^(stone|iron|diamond|netherite)_pickaxe$/
const PICK_IRON = /^(iron|diamond|netherite)_pickaxe$/
const PICK_DIAMOND = /^(diamond|netherite)_pickaxe$/

// One small portion may leave hunger below the regeneration threshold.
// Stop on a refused bite instead of repeating it or entering combat hungry.
async function eatTo (target = 18) {
  for (let i = 0; i < 6 && !died && (state.food ?? 20) < target && have(FOOD); i++) {
    const before = state.food ?? 20
    await act('eat')
    if ((state.food ?? 20) <= before) break
  }
  return (state.food ?? 20) >= target
}

// Какие доски из какого бревна: oak_log → oak_planks, crimson_stem → crimson_planks.
function planksFor () {
  const inv = state.inventory || {}
  // Ободранное — тоже бревно: рецепт досок берёт тег #oak_logs (с ним и
  // stripped_oak_log), а недостающие в minecraft-data варианты добавляет
  // gamedata.fixPlanks. Обычное — первым.
  const log = Object.keys(inv).find(k => LOGS.test(k) && !/^stripped_/.test(k)) || Object.keys(inv).find(k => LOGS.test(k))
  if (!log) return null
  return log.replace(/^stripped_/, '').replace(/_(log|stem)$/, '_planks')
}

// Память мира: портал, крепости — из памяти демона (recall → places), а не из
// рюкзака и не из этого процесса: перезапуск кампании их не теряет. Имена мест
// — те, что пишут модули: worlds.PORTAL_KEYS, fortress.PLACE, endportal.PLACE/ROOM.
const known = { portal: null, netherPortal: null, fortress: null, bastion: null, stronghold: null, endPortal: null, dragonWon: false, spawnBed: null }
async function readMemory () {
  try {
    const r = await call('recall', { lines: 1 })
    const memory = (r.detail && r.detail.state) || {}
    memorySnapshot = { updatedAt: memory.updatedAt || null, places: memory.places || {}, deaths: (memory.deaths || []).length }
    const places = { ...(memory.places || {}) }
    // Ферма (сцена кампании на копии мира): места из ND_EXTRA_PLACES (JSON) поверх памяти тела.
    if (process.env.ND_EXTRA_PLACES) { try { Object.assign(places, JSON.parse(process.env.ND_EXTRA_PLACES)) } catch {} }
    known.portal = places['портал'] || null
    known.netherPortal = places['портал (ад)'] || null
    known.fortress = places['крепость (ад)'] || known.fortress
    known.bastion = places['бастион (ад)'] || known.bastion
    // Бастионы по порядку: первый — «бастион (ад)», дальше «бастион 2 (ад)», «бастион 3 (ад)».
    known.bastions = BASTION_KEYS.filter(k => places[k]).map(k => ({ key: k, ...places[k] }))
    // Пройденный бартер переживает перезапуск мозга. Запись живёт в памяти этого мира;
    // другой бастион с тем же именем и иными координатами не считается выработанным.
    for (const b of known.bastions) {
      const checkpoint = places[`выработан: ${b.key}`]
      if (checkpoint?.dimension === 'the_nether' && (b.dimension || 'the_nether') === 'the_nether' &&
        Math.hypot(checkpoint.x - b.x, checkpoint.z - b.z) <= 100) bState(b).spent = true
    }
    known.stronghold = places['крепость'] || known.stronghold
    known.endPortal = places['портал в Край'] || known.endPortal
    // Кровать — точка возрождения (bedtime.rememberSpawnBed); сломали —
    // сервер сбросил точку, и место стёрто (bedtime.install, spawnReset).
    known.spawnBed = places['точка возрождения'] || null
    // «лава» пишется с позиции тела (session.remember), а тело видело её
    // оттуда — дойти туда и смотреть.
    if (!known.lava && places['лава'] && (places['лава'].dimension || 'overworld') === 'overworld') known.lava = places['лава']
  } catch {}
}

// Ночь на поверхности: кровать — настоящий ответ (пропускает ночь целиком),
// нора — запасной. Под крышей (штрек, лесенка) ночь не мешает.
// Один сторож на ночь: переход к своей кровати (goToward) сам зовёт сторожа.
let guarding = false
// ND_NIGHT_DOWN=2 (поток survival): ночью наверху работать нельзя и с мечом — кроме этапа дерева (без кирки вниз не
// уйти). pool0b 02.10 (флаги выкл., хорошие сиды): первая смерть в 4 прогонах из 5 — на 12–14-й минуте, в начале первой
// ночи, наверху (охота, копка у поверхности, нора под стрелами). Тогда nightWork() отложит охоту и воду, а nightGuard
// уведёт в нору → вниз.
const canWorkAtNight = () => sit.foes === 0 && !sit.inWater && !sit.buried &&
  (state.health ?? 0) >= 16 && (state.food ?? 0) >= 14 &&
  (!sit.surface || (NIGHT_DOWN2() ? stage === 'wood' || !sit.night : have(/_(sword|axe)$/) > 0 || stage === 'wood' || stage === 'stone'))
let nightWorkSaidAt = 0
async function nightGuard (opts = {}) {
  if (guarding) return
  guarding = true
  try { await nightGuardBody(opts) } finally { guarding = false }
}
// opts.afterDeath — возрождение ночью наверху: не «работать ночью», а сразу кровать или нора до рассвета.
// dusk — зов из простоя «нет шага» (ND_NIGHT_DOWN=2): сумерки наверху без кровати — в нору сразу, пока мобов нет (спавн —
// с темноты ~13188, сумерки 11840–12542); pool1 02.10 слот 19: «жду изменения обстановки» 60 с наверху в сумерки →
// ночь, зомби у места норы → бой/бегство → смерть (20 → 0).
async function nightGuardBody ({ afterDeath = false, dusk = false } = {}) {
  await sense()
  if (dim() !== 'overworld') return
  if (sit.night || sit.dusk) await makeBed()
  // Кровать-точка возрождения недалеко — спать в ней. Сон в другой кровати
  // переносит точку туда, а утром ту кровать уносили в рюкзак — и следующая
  // смерть кончалась на спавне мира (прогон 2026-09-26: четыре смерти —
  // четыре возрождения за 150-250 блоков от вещей).
  await readMemory()
  const sb = known.spawnBed
  const sbFar = sb && state.pos ? Math.hypot(sb.x - state.pos.x, sb.z - state.pos.z) : Infinity
  // Идти к своей кровати — в сумерки (ещё светло, 35 с до ночи), а не ночью:
  // 86 блоков в темноте без брони — 20 → 6 хп от мобов, и дошёл к рассвету
  // (2026-09-26, 13:18-13:20). Ночью — только если она рядом.
  const homeBed = sbFar <= (sit.night ? 24 : 96)
  const bed = have(/_bed$/) > 0 || sit.bed || homeBed
  if (!sit.night) nightHoles = 0
  const duskDown = dusk && NIGHT_DOWN2() && sit.dusk && sit.surface && !sit.night
  if (!(sit.night || duskDown || (sit.dusk && bed))) return
  if (!bed && !afterDeath && !duskDown && canWorkAtNight()) {
    if (Date.now() - nightWorkSaidAt > 60000) {
      log('ночь без видимых угроз: продолжаю работу; кровать — ближайшая цель охоты')
      nightWorkSaidAt = Date.now()
    }
    return
  }
  // Под крышей (своя нора, пещера) — сидеть до утра, а не идти работать
  // наверх: зовут сюда только этапы, которым нужна поверхность. Раньше «не
  // наверху» значило «ночь не мешает», и кампания 2026-09-26 вышла из норы с
  // пустым рюкзаком за брёвнами в темноте.
  if (!sit.surface && !bed) {
    if (!sit.night) return
    if (NIGHT_DOWN) { await nightBelow('под крышей'); return }
    log('ночь, я под крышей — жду утра здесь')
    for (let i = 0; i < 40 && !died; i++) {
      await act('wait', { seconds: 30 })
      await sense()
      if (!sit.night) break
    }
    // Утро: из своей норы — наружу (не в норе — «и так не был заперт»).
    if (!died) await act('shelter', { mode: 'exit' })
    return
  }
  if (bed) {
    if (homeBed && sbFar > 6) {
      log(`к своей кровати-точке ${sb.x},${sb.y},${sb.z} (${Math.round(sbFar)} блоков)`)
      await goToward(sb, 3)
    }
    log(sit.night ? 'ночь — сплю' : 'сумерки — ставлю кровать, лягу с темнотой')
    // Кровать после сна остаётся стоять (take:false) — в ней точка
    // возрождения: смерть вернёт сюда, к вещам. Следующая ночь — в ней же,
    // если рядом (выше); шерсть на новую — makeBed.
    // Своя кровать-точка рядом — спать в ней (остаётся стоять). Далеко от неё —
    // кровать из рюкзака: поставить, лечь, забрать (take:true) — ночь за ~10 с,
    // как у спидраннеров, и кровати (на дракона их 6) не остаются по дороге.
    // Спавн мира — в 35 блоках от портала, так что точку у портала это не
    // ломает.
    await refresh()
    const nearHome = sb && state.pos ? Math.hypot(sb.x - state.pos.x, sb.z - state.pos.z) <= 8 : false
    const carry = !nearHome && have(/_bed$/) > 0
    const r = await act('sleep', { untilMorning: true, timeoutSeconds: 420, take: carry })
    // Верить часам, а не «лёг»: sleeping=true бывает и у сна, прерванного за
    // секунды (разбудили, не проскочила), — кампания 2026-09-26 так вышла в
    // ночь на 5 хп и была застрелена скелетом.
    if (r.detail && r.detail.morning) return
    // «Рядом монстры» (Player.startSleepInBed: монстр в 8 по горизонтали и 5 по
    // высоте) — отойти от них и попробовать снова, один раз.
    if (/монстр/.test(String((r.detail && (r.detail.note || r.detail.stopped)) || r.error || '')) && have(/_bed$/) > 0) {
      await act('flee', { timeoutSeconds: 12 })
      const r2 = await act('sleep', { untilMorning: true, timeoutSeconds: 420, take: true })
      if (r2.detail && r2.detail.morning) return
    }
    // Кровать не встала (в воде, на склоне) — отойти и ещё раз, один раз:
    // 2026-09-29 13:11 ночь застала в реке — нора на берегу и семь минут
    // ожидания при кровати в рюкзаке.
    if (/негде поставить кровать/.test(String((r.detail && (r.detail.stopped || r.detail.note)) || r.error || '')) && have(/_bed$/) > 0) {
      await walkAway(12)
      const r3 = await act('sleep', { untilMorning: true, timeoutSeconds: 420, take: true })
      if (r3.detail && r3.detail.morning) return
    }
    await sense()
    if (!sit.night) return
  }
  // ND_NIGHT_BOX=1: ночь наверху без кровати — сразу укрытие отхода (коробка/ниша/нора, survival.refuge) и сидеть до
  // рассвета (untilDawn), а не «бой с двумя, потом нора под третьим» (trap0–3 02.10, ночь: 8 смертей из 14 — бой с
  // зомби, пока паук и скелет рядом; нора под пауком; выход из коробки к стрелку). Дорого (до ~8 мин), но ночь без
  // брони и кровати для бота — это смерти, а смерть — 3–6 мин и вещи у спавна.
  if (process.env.ND_NIGHT_BOX === '1' && !NIGHT_DOWN && !died && dim() === 'overworld') {
    log('ночь наверху без кровати — укрытие до рассвета')
    const r = await refugeRun('ночь наверху: до рассвета', { minHp: 20, untilDawn: true, force: true })
    await sense()
    if (died || !sit.night || (r && r.detail && r.detail.code === 'OK' && r.detail.how !== 'flee')) return
  }
  // Нора здесь недавно не вышла (shelterFailed) — не копать снова: работать дальше, от угроз — бегом.
  if (Date.now() < shelterFailUntil) return
  // Нору под мобом не копать: копка 8–15 с, урон её не рвёт (разбор A1–A4: 17 смертей в норе рядом с бьющим
  // мобом; A4 слот 13 — 20 → 6 хп за копку). Враги рядом — сперва ответ: 1–2 и есть меч — бой, иначе отход.
  await sense()
  if (sit.foes > 0 && !died) {
    log(`ночь, врагов рядом ${sit.foes} — нору под ними не копаю, сперва ответ`)
    // ND_NIGHT_DOWN: не бой первым (ночью наверху к двум идут ещё; trapH 02.10, ночь: бой 30 с с двумя → коробка → нора
    // в пещеру → смерть), а сразу коробка и вниз из неё; бой — только если коробка не встала.
    if (!NIGHT_DOWN) await afterRefuge()
    await sense()
    // ND_NIGHT_DOWN: враги всё ещё тут — коробка и из неё же вниз (stayIn): копка норы рядом с ними — урон за урон (trapG
    // 02.10, ночь: после коробки «в нору» — зомби подошёл, 20 → 13 за копку, потом 12 → 0).
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
      // Коробка не встала (нечем, не к чему) — прежний ответ: бой с 1–2 или уход.
      if (!(r.detail && r.detail.stayed) && sit.foes > 0 && !died) { await afterRefuge(); await sense() }
    } else if (sit.foes > 0 && !died) await refugeRun(`ночь: врагов ${sit.foes} у норы`)
    if (died) return
  }
  log('ночь на поверхности — в нору до рассвета')
  if (!have(/_pickaxe$/)) await ensurePick()
  let s = await act('shelter', { mode: 'enter', depth: 3 })
  // Нора не вышла (пещера под ногами, песок) — отойти и копать там.
  // Или вовсе отказ («я в воде — тут не окопаешься»): 2026-09-27 (00:57) нора
  // у воды — «slain by Drowned».
  if (!closedShelter(s)) {
    // В воде нора не копается — сначала на сушу (до трёх отрезков), а на суше при
    // полном хп и без угроз — работать дальше (29.09 15:47: ночь застала в озере по
    // пути к порталу, обе норы «я в воде», блокер и отключение).
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
  // ND_NIGHT_DOWN: закрытая нора — вход вниз, не место ожидания: дальше этап работает под землёй (nightBelow).
  // Третья нора за ночь (этап снова и снова лезет наверх, а там нельзя) — прежнее ожидание, с РИСКом в журнал.
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

// Ночь не пережидать (правило пользователя 02.10, указание главного 17:11; ND_NIGHT_DOWN=1, поток survival): под
// землёй ночь не мешает — этап работает дальше. Ждать — только пока ожидание лечит (сытость ≥ 18 или есть еда: реген
// FoodData.tick — с 18) и хп < 16, до 3 мин; или авария — хп < 10 и лечиться нечем: до 4 мин в закрытой норе (наверху
// темно, внизу без хп копать — пещеры). Выход — сразу, как можно работать (canWorkAtNight).
const NIGHT_DOWN = process.env.ND_NIGHT_DOWN !== '0'
// Уровень 2 (по умолчанию; ND_NIGHT_DOWN=1 — мягкий, =0 — выкл.): ночью наверху не работать, сумерки в простое — вниз.
function NIGHT_DOWN2 () { const v = process.env.ND_NIGHT_DOWN; return v === undefined || v === '' || v === '2' }
let nightHoles = 0
let nightIdleS = 0
async function nightBelow (why) {
  log(`ночь (${why}) — утра не жду, работаю внизу; хп ${Math.round(state.health ?? 0)}, еда ${state.food ?? '?'}`)
  const t0 = Date.now()
  for (let i = 0; i < 8 && !died; i++) {
    await sense()
    if (!sit.night || canWorkAtNight()) break
    // Враги «рядом» в закрытой норе — это те, кто стоит над ней (assess.inSight: ближе 4 бл. — «видно» и сквозь блоки):
    // не выходить к ним в бой (trapH 02.10, ночь: из норы «после отхода рядом 1 — дерусь» → бой наверху 20 → 6, смерть).
    // Мешают работе — ответит этап (mobInTheWay).
    if (sit.foes > 0) break
    const hp = state.health ?? 20
    const food = have(FOOD) || have(RAW)
    if (food && (state.food ?? 20) < 20 && hp < 16) { await act('eat'); continue }
    const heals = hp < 16 && ((state.food ?? 0) >= 18 || food)
    const emergency = hp < 10 && !food
    const capS = emergency ? 240 : 180
    if (!(heals || emergency) || Date.now() - t0 > capS * 1000) break
    if (i === 0) log(emergency ? `хп ${Math.round(hp)} и лечиться нечем — авария: сижу в норе (до ${capS / 60} мин)` : `хп ${Math.round(hp)} — отлёживаюсь (реген), до ${capS / 60} мин`)
    await act('wait', { seconds: 30 })
  }
  const s = Math.round((Date.now() - t0) / 1000)
  nightIdleS += s
  if (s >= 20) log(`ночь: ожидание ${s} с (за запуск ${nightIdleS} с) — дальше работа`)
}

// Отойти на dist блоков в сторону (случайную или по курсу прогулки).
let heading = Math.random() * 2 * Math.PI
// Верхний мир — у портала: вся работа в ~180 блоках от него, смерть стоит
// минут (возрождение у базы, сундук с запасом), а не часа. 2026-09-27 (00:57)
// охота «прочь от спавна» увела на 1400 блоков, и дорога к порталу кончилась
// утопленником.
// 660, а не 180: у портала за два дня всё выбито, а дела — дальше (руины портала
// за золотом в 421 блоке: перезапуск кампании в 50 блоках от руин тянул тело
// «назад к базе» — 2026-09-28, 13:41).
const LEASH = 660
const HUNT_LEASH = 660
const portalFar = () => (known.portal && state.pos && dim() === 'overworld') ? Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) : 0
async function homeLeash () {
  // Дорога к крепости и Энд — не на поводке: крепость в 1800+ блоках от портала.
  if (stage === 'stronghold' || stage === 'dragon' || (have('ender_eye') >= Math.min(10, EYES_NEED) && known.stronghold)) return
  // Охота — на своём поводке (HUNT_LEASH): иначе recoverGuard в начале каждого
  // шага охоты тянул тело «назад к базе» с 239 блоков, где звери ещё есть
  // (2026-09-28, 12:27).
  if (portalFar() > (hunting ? HUNT_LEASH : LEASH) + 30) { log(`далеко от портала (${Math.round(portalFar())}) — назад к базе`); await goToward(known.portal, 24) }
}
async function walkAway (dist, turn = 0) {
  heading += turn
  let x = Math.round(state.pos.x + Math.cos(heading) * dist)
  let z = Math.round(state.pos.z + Math.sin(heading) * dist)
  // Охота — на длинном поводке: за два дня звери в 180 блоках от портала выбиты,
  // и на 1 хп тело 25 минут ходило кругами по пустой округе (2026-09-28,
  // 12:04-12:30: 20 осмотров по 64 блока — ни одного зверя). Новая земля — дальше.
  const leash = hunting ? HUNT_LEASH : LEASH
  if (known.portal && dim() === 'overworld' && Math.hypot(x - known.portal.x, z - known.portal.z) > leash) {
    heading = Math.atan2(known.portal.z - state.pos.z, known.portal.x - state.pos.x) + (Math.random() - 0.5) * 1.6
    x = Math.round(state.pos.x + Math.cos(heading) * dist)
    z = Math.round(state.pos.z + Math.sin(heading) * dist)
  }
  // Прогулка — поверху и без копки (surface:'strict'): гора на пути — отказ
  // сразу, а не штрек сквозь неё на две минуты.
  return act('goto', { x, z, range: 4, timeoutSeconds: Math.max(30, Math.round(dist * 1.5)), surface: 'strict' })
}

// Уйти от точки p (x,z) на dist блоков, по прямой от неё; p нет — по курсу
// прогулки. Под землёй сначала наверх: уходят поверху.
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

// К точке отрезками по 64 блока: дальний путь pathfinder не решает целиком
// («Took to long to decide path»). Поверху — сначала наверх.
// Маршруты штрека по Аду из памяти: у места цепочки «портал (ад) → бастион (ад) → бастион 2 (ад)» поле via —
// точки маршрута сквозь толщу от предыдущего места (по карте копии мира, 30.09: между бастионами на y 34–46
// открытая пещера над лавовым морем, штрек идёт под ним на y 6–17). Путь от места у тела к месту у цели.
// Где тело на цепочке — по ближней точке всей полилинии маршрута (не только по местам: посреди пути под лавовым
// морем до мест > 160 блоков — ревью Codex 30.09: 16 из 37 точек без маршрута, а без него штрек держится y ≥ 33).
function netherVia (from, to) {
  const chain = [known.netherPortal, ...(known.bastions || [])].filter(Boolean)
  if (chain.length < 2 || !from || !to) return []
  // Сплошной кусок цепочки с маршрутами: P — точки подряд, at[k] — индекс в P, где стоит место k.
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
  // Цель — место цепочки у точки to.
  let j = -1; let bj = Infinity
  chain.forEach((c, k) => { if (at[k] < 0) return; const d = Math.hypot(c.x - to.x, c.z - to.z); if (d < bj) { bj = d; j = at[k] } })
  if (i < 0 || j < 0 || bj > 160 || i === j || k0 < 0) return []
  return i < j ? P.slice(i, j + 1) : P.slice(j, i + 1).reverse()
}
// Блоки на стройку в Аду (build.js FILLER_NETHER без сыпучих).
const fillersNow = () => have(/^(netherrack|dirt|basalt|blackstone|stone|andesite|diorite|granite|tuff|cobbled_deepslate|cobblestone|deepslate|polished_blackstone_bricks|cracked_polished_blackstone_bricks|polished_blackstone|end_stone|mossy_cobblestone|soul_soil|warped_wart_block|nether_wart_block|soul_sand)$/)
const nearBastion = (p, r = 100) => !!p && (known.bastions || []).some(b => Math.hypot(b.x - p.x, b.z - p.z) < r)

async function goToward (p, range = 6) {
  const fromWorld = dim()
  // Поток nether (03.10): по Аду и сетка копии мира есть (ND_NE_ROUTE=1) — весь путь одним планом (RPC ne_route:
  // штрек/мосты/спрыгивания, без лавы у тела); не довёл — дальше прежним штреком.
  if (fromWorld === 'the_nether' && process.env.ND_NE_ROUTE === '1' && state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) > range + 2 && !died) {
    const far = Math.hypot(p.x - state.pos.x, p.z - state.pos.z)
    const yKnown = typeof p.y === 'number'
    const r = await act('ne_route', { x: p.x, y: yKnown ? p.y : 64, z: p.z, r: Math.max(range, 3), dy: yKnown ? 4 : 50, frKeep: 1, ironOk: !nextBastion() || (process.env.ND_NE_STAY === '1' && pearlsNow() >= eyesWant()), timeoutSeconds: Math.min(1200, Math.round(120 + far * 2.5)) })
    await refresh()
    if (died || dim() !== fromWorld) return false
    if (state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) <= range + 2) return true
    log(`по сетке не довёл: ${(r.detail && r.detail.why) || r.error || '?'} — дальше штреком`)
  }
  // По Аду далеко — закрытым штреком на высоте ~40 (tunnel.js): пешком тело падало в лаву и с обрывов
  // (ферма 30.09: до второго бастиона гибло в каждой второй попытке). Не вышло — пешком, как раньше.
  if (fromWorld === 'the_nether' && state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) > 60 && !died) {
    const far = Math.hypot(p.x - state.pos.x, p.z - state.pos.z)
    // Бастионы позади — железную кирку беречь не для чего: кончатся каменные — копать и ею (ironOk).
    const via = netherVia(state.pos, p)
    const tArgs = () => ({ x: p.x, y: p.y, z: p.z, radius: Math.max(range, 5), ...(via.length ? { via } : {}), ironOk: !nextBastion() || (process.env.ND_NE_STAY === '1' && pearlsNow() >= eyesWant()), timeoutSeconds: Math.min(via.length ? 2700 : 1800, Math.round(120 + far * (via.length ? 3 : 1.6))) })
    let t = await act('nether_tunnel', tArgs())
    await refresh()
    if (died || dim() !== fromWorld) return false
    if (state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) <= range + 2) return true
    // Штрек не начался (открытое место: «со старта не войти»/«куска нет», ни куска, ни копки) — закопаться в толщу и
    // штрек снова; пешком по Аду — только если и так не вышло (neF-Pa24-1 02.10: «дальше пешком» к порталу — лава).
    const td0 = t.detail || {}
    if (!td0.ok && !td0.segs && !td0.dug && process.env.ND_BURROW !== '0') {
      const bw = await act('ne_burrow', { why: 'штрек по Аду не начался' })
      await refresh()
      if (died || dim() !== fromWorld) return false
      if (bw.detail && bw.detail.ok) {
        t = await act('nether_tunnel', tArgs())
        await refresh()
        if (died || dim() !== fromWorld) return false
        if (state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) <= range + 2) return true
      }
    }
    // Пешком у бастиона — к брутам и хоглинам (chain6 30.09: 3 смерти из 7 — «дальше пешком» от ямы бастиона).
    if (nearBastion(state.pos)) { log(`штрек по Аду не довёл: ${(t.detail && t.detail.why) || t.error || '?'} — у бастиона пешком не иду`); return false }
    log(`штрек по Аду не довёл: ${(t.detail && t.detail.why) || t.error || '?'} — дальше пешком`)
  }
  // Отрезок не прошёл (гора, ущелье, «Took to long to decide path») — следующий
  // под углом 30°, 60°, 90° то вправо, то влево, как обходит человек; прошёл —
  // снова прямо. Прямой отрезок на ту же гору падал так же (2026-09-26,
  // переход к порталу: два «не дошёл» подряд — и конец).
  const detour = [0, 0.5, -0.5, 1.0, -1.0, 1.5, -1.5]
  let turn = 0
  for (let k = 0; k < 12 && !died; k++) {
    await refresh()
    if (died || dim() !== fromWorld) return false
    // На длинном переходе кирки стираются и в Аду, и в пещерах верхнего мира.
    // Между intents автопилот не успевает их заменить (sh2: y43, булыжник и палки
    // есть, но следующие пути снова требуют копать камень голыми руками).
    if (!have(/_pickaxe$/)) await ensurePick()
    const dx = p.x - state.pos.x
    const dz = p.z - state.pos.z
    const far = Math.hypot(dx, dz)
    if (far <= range + 2) return true
    // Ночь посреди перехода — переждать (кровать или нора), а не идти дальше:
    // 2026-09-26 (19:11-19:13) переход к порталу в 330 блоков шёл в темноте,
    // зомби у ущелья на y=58 — «slain by Zombie» со всем снаряжением.
    if (dim() === 'overworld' && far > 24) {
      await sense()
      if (sit.night && sit.surface) await nightGuard()
      if (died) return false
    }
    let leg
    if (far > 72 || turn) {
      const a = Math.atan2(dz, dx) + detour[turn % detour.length]
      const step = Math.min(64, far)
      leg = { x: Math.round(state.pos.x + Math.cos(a) * step), z: Math.round(state.pos.z + Math.sin(a) * step) }
    } else leg = { x: p.x, z: p.z }
    const direct = far <= 72 && !turn
    // Отрезок — со своим допуском: допуск цели (к крепости — 150) на отрезок в 64 блока давал «дошёл» на месте,
    // 72 goto за 4 с без шага (sh1 30.09: «к крепости 1841 блоков» ×6, тело у портала).
    const r = await act('goto', { x: leg.x, ...(direct && typeof p.y === 'number' ? { y: p.y } : {}), z: leg.z, range: direct ? range : Math.min(range, 8), timeoutSeconds: 120 })
    turn = r.status === 'done' ? 0 : turn + 1
    if (turn >= detour.length) return false
  }
  return false
}

async function returnFromNether () {
  if (dim() !== 'the_nether') return dim() === 'overworld'
  await unclutter()
  const reached = known.netherPortal ? await goToward(known.netherPortal, 4) : true
  // Урон/возрождение или попадание в раму на пути уже могли сменить мир.
  // Повторный enter в таком случае отправлял голого бота обратно в Ад.
  if (dim() !== 'the_nether') return dim() === 'overworld'
  if (!reached) { log('безопасный путь к порталу не пройден — переход пешком не запускаю'); return false }
  await act('portal', { mode: 'enter', timeoutSeconds: 120 })
  return dim() === 'overworld'
}

// Умер — сходить за вещами (если дорога по силам); ранен — отлежаться.
async function recoverGuard () {
  await refresh()
  if (died) {
    died = false
    // Inventory may already be preserved while respawn packets are still
    // arriving. Confirm a living body before sleeping, eating or digging.
    for (let k = 0; k < 20 && (state.health ?? 0) <= 0; k++) { await sleep(500); await refresh() }
    if ((state.health ?? 0) <= 0) await abortUnsafe('возрождение не подтвердилось — действия мёртвым телом не начинаю')
    // На run-сервере включён keep_inventory (решение координатора 2026-09-27,
    // «помогай командами»; в отчёте): вещи при себе — к делу, без похода за
    // кучей.
    await refresh()
    if (Object.keys(state.inventory || {}).length >= 3) {
      log('умер, но вещи при мне (keep_inventory) — к делу')
      // Возродился ночью наверху: у точки возрождения те же мобы, что только что убили, — сразу кровать или нора
      // до рассвета, не работа. fresh-A1 слот 16 (30.09): три смерти за 45 с у спавна мира, пятая — провал прогона.
      await sense()
      if (dim() === 'overworld' && sit.night && sit.surface) {
        log('ночь, я наверху после возрождения — в укрытие до рассвета')
        if (sit.foes > 0) await afterRefuge()
        await nightGuard({ afterDeath: true })
      }
      return
    }
    // Дождаться возрождения: до него state.pos — ещё место смерти, и
    // «далеко ли куча» выходило 0 блоков при 750 настоящих (2026-09-26, 13:17).
    // Куча из дерева, камня и меди не стоит дороги: 2026-09-26 (09:14) после
    // смерти в 900 блоках от спавна recover пошёл через ночь к тому же озеру
    // с утопленником — за двумя каменными кирками. Идти — только за железом,
    // золотом, алмазами, вёдрами, бронёй, кроватью, жемчугом и стержнями, и
    // не дальше 400 блоков (куча живёт 5 минут).
    const worth = Object.keys(lostBag || {}).filter(k => /iron|gold|diamond|obsidian|bucket|_bed$|ender|blaze|shield|bow|arrow|flint_and_steel|netherite|emerald|cooked_/.test(k))
    const far = lostAt && state.pos ? Math.hypot(lostAt.x - state.pos.x, lostAt.z - state.pos.z) : 0
    // Куча живёт 5 минут (6000 тиков); ходьба ~4 блока/с, recover — 240 с:
    // до 600 блоков успеть можно. 574 блока с железной бронёй, мечом, киркой и
    // семью слитками золота — «далеко» по старому порогу 400 (2026-09-26, 12:11).
    if (!worth.length || far > 600) {
      log(`умер; за вещами не иду — ${worth.length ? `далеко (${Math.round(far)} блоков)` : 'ценного не было'}, собираю заново`)
      return
    }
    log(`умер — пробую забрать вещи (${worth.join(', ')}; ${Math.round(far)} блоков)`)
    const r = await act('recover', { timeoutSeconds: far > 300 ? 300 : 240 })
    if (r.detail && r.detail.stopped) log('за вещами не пройти — собираю заново')
  }
  // Возродился у базы — запас из её сундука (кирка, еда, блоки, железо).
  // (Сундук ищется рядом: нет его — отказ за секунду.)
  if (dim() === 'overworld' && known.portal && portalFar() < 48 && !have(/_pickaxe$/)) await sense()
  if (dim() === 'overworld' && known.portal && portalFar() < 48 && !have(/_pickaxe$/) && !sit.night) {
    // Сундук стоит у портала, а спавн мира — в 30 блоках от него: сперва к
    // порталу (поиск сундука — в 16 блоках от тела).
    if (portalFar() > 10) await act('goto', { x: known.portal.x, y: known.portal.y, z: known.portal.z, range: 3, timeoutSeconds: 40 })
    const t = await act('chest_take', { item: 'all' })
    if (t.status === 'done') { log('взял запас из сундука базы'); baseStocked = false }
  }
  if ((state.health ?? 20) < 12 && !resting) await rest()
  await homeLeash()
}

// Сундук базы у портала: лишнее перед Адом — туда (после смерти возрождение у
// кровати рядом, и запас на месте). Держим при себе: слиток на огниво, еду до
// 16, блоков до 96, кирок две.
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
  for (const [k, v] of Object.entries(state.inventory || {})) {
    if (keep[k] !== undefined && v > keep[k]) put.push([k, v - keep[k]])
    else if (/^(raw_iron|raw_copper|raw_gold|diamond|lapis_lazuli|coal)$/.test(k)) put.push([k, v])
  }
  const food = Object.entries(state.inventory || {}).filter(([k]) => FOOD.test(k)).sort((a, b) => a[1] - b[1])
  let extra = have(FOOD) - 16
  for (const [k, v] of food) { if (extra <= 0) break; const n = Math.min(v, extra); put.push([k, n]); extra -= n }
  if (have('stone_pickaxe') > 2) put.push(['stone_pickaxe', have('stone_pickaxe') - 2])
  for (const [item, count] of put) await act('chest_put', { item, count })
  if (put.length) { baseStocked = true; log(`база: в сундук — ${put.map(([k, n]) => k + '×' + n).join(', ')}`) }
}

// Верстак в рюкзаке: крафт ставит его сам и забирает обратно, но если стол
// потерялся, а досок меньше четырёх — сделать из брёвен.
const TABLE_ITEMS = /_(pickaxe|sword|axe|shovel|hoe|chestplate|leggings|helmet|boots)$|^(shield|bucket|furnace|flint_and_steel|bow|chest|_bed)$|_bed$/
async function ensureTable () {
  if (have('crafting_table')) return
  if (have(/_planks$/) < 4) { const p = planksFor(); if (p) await act('craft', { item: p, count: 4 }) }
  // Стол в сетке 2×2 на 1.21.11 иногда «прошёл без ошибки, а не прибавилось»
  // (2026-09-26, 17:44: в штреке без верстака — пять провалов каменной кирки
  // подряд). Повтор проходит — до трёх раз.
  for (let k = 0; k < 3 && !have('crafting_table'); k++) {
    const r = await act('craft', { item: 'crafting_table', count: 1 })
    if (r.status === 'done') break
    await sleep(1200)
    await refresh()
  }
}

async function craft (item, count = 1) {
  // Полный рюкзак выбрасывает результат на землю. Повтор рецепта теряет
  // материалы: освобождаем место до установки верстака и первого крафта.
  await unclutter()
  if (TABLE_ITEMS.test(item) && item !== 'crafting_table') { await refresh(); await ensureTable() }
  let r = await act('craft', { item, count })
  // Верстак промолчал (крафт теперь сверяет рюкзак и честно говорит «не
  // прибавилось») или автопилот занял окно — ещё раз, это не нехватка.
  // «нужен верстак, а его нет» при верстаке в рюкзаке — тоже гонка: сразу после
  // крафта досок и палок в окне рюкзака рецепт не находится (2026-09-26, тот же
  // вызов через секунду прошёл).
  if (r.status !== 'done' && /не прибавилось|не открылся|автопилот сейчас|нужен верстак|missing ingredient/.test(String(r.error || ''))) {
    await sleep(1500)
    r = await act('craft', { item, count })
  }
  // Верстак не встаёт здесь (тесная лестница вниз на y 16: «blockUpdate did not fire» 3 раза подряд на
  // одной клетке → этап железа «без прогресса» → БЛОКЕР; ферма 30.09 chain1-15) — выйти к открытому
  // месту и повторить.
  if (r.status !== 'done' && /не смог поставить|некуда поставить/.test(String(r.error || ''))) {
    await act('surface', { timeoutSeconds: 60, preferPillar: true })
    await refresh()
    r = await act('craft', { item, count })
  }
  // Верстак не вернулся в рюкзак — забрать: дроп лежит рядом (крафт называет
  // где) или блок не сломался и стоит. Брошенный в штреке верстак дважды за
  // день оставлял тело на глубине без кирки (2026-09-26, 12:52 и 13:59).
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

// Палки: из досок, доски — из брёвен.
async function sticks (n) {
  if (have('stick') >= n) return
  if (have(/_planks$/) < 2) { const p = planksFor(); if (p) await craft(p, 4) }
  await craft('stick', Math.max(4, n - have('stick')))
}

// Запас кирок перед долгой копкой. Автопилот кует замену сам, но только когда
// тело свободно (autopilot.keepTools → bodyBusy), а кампания зовёт намерения
// одно за другим без просвета — замены не будет никогда. Лесенка стоит ~4 удара
// на уровень: спуск с 64 до 16 — ~190 ударов, каменная кирка — 131. Поэтому
// сама: палки из досок, вторая каменная кирка из булыжника (его внизу горы).
// Считаем удары, а не штуки: две стёртые кирки — это 42 удара, и штрек встаёт
// на первом блоке «останавливаюсь заранее» (situation.pickLeft — сумма по всем
// киркам, как её считает сама лесенка).
// Запас на кирки в дорогу: 12 палок (из досок или брёвен) и 24 булыжника.
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
    // Две палки — на железную кирку, пока её нет, а железо есть (chain6-6 30.09: палки ушли на каменные).
    if (!have(PICK_IRON) && (have('iron_ingot') + have('raw_iron') > 0 || have('iron_nugget') >= 9) && have('stick') + 4 * Math.floor(have(/_planks$/) / 2) < 4 && !have(LOGS)) break
    // Старая кирка может ещё числиться в рюкзаке, но не хватать даже на шаг.
    // Без булыжника — деревянная из запаса, а не тот же отказ подъёма 4 раза.
    if (have(COBBLE) >= 3) {
      if (!(await craft('stone_pickaxe'))) break
    } else if (have('iron_ingot') >= 3 && have('stick') >= 2) {
      // Камня нет (в Аду — один незерак), а железо из бартера/сундуков есть — железная (neF-Sc21-2 02.10: 12 слитков
      // железа, 3 палки, ни одной кирки — «бой у спавнера: не хватает кирки»).
      if (!(await craft('iron_pickaxe'))) break
    } else {
      if (have(/_planks$/) < 3) { const p = planksFor(); if (p) await craft(p, 4) }
      if (have(/_planks$/) < 3 || !(await craft('wooden_pickaxe'))) break
    }
  }
}

// Дерево про запас, пока наверху: доски на щит (6), палки на кирки внизу
// (каждая каменная кирка — 2 палки), верстак на новом месте. Внизу дерева нет.
async function lumber (want = 10) {
  await refresh()
  if (have(LOGS) + Math.floor(have(/_planks$/) / 4) >= want) return
  for (let i = 0; i < 3 && have(LOGS) + Math.floor(have(/_planks$/) / 4) < want; i++) {
    await sense()
    if (!sit.surface || (sit.night && !canWorkAtNight())) return
    const m = await act('mine', { block: 'any_log', count: want - have(LOGS), radius: 40, timeoutSeconds: 180 })
    if (!(m.detail && m.detail.dug)) {
      const e = await act('explore', { block: 'any_log', radius: 48, stepDistance: 60, timeoutSeconds: 90 })
      if (!(e.detail && e.detail.found)) return
    }
  }
}

// Рюкзак забит породой — руда из штрека остаётся лежать: 2026-09-26 бот стоял
// в россыпи дропа и не подбирал ничего (444 булыжника, 66 гранита, 65
// андезита...). Хлам и булыжник сверх 128 — прочь (pack tidy уводит тело от
// броска, иначе через 2 с всё вернётся).
async function unclutter () {
  await sense()
  if ((sit.free ?? 36) < 8) {
    // Это запас для маршрута, а не общая цена предметов MCP: медь, листва и
    // декор Ада не продвигают прохождение. Ценности и снаряжение не трогаем.
    const netherrack = dim() === 'the_nether' ? 128 : 64
    // Замещённое снаряжение и мелочь без применения в маршруте: 29.09 15:08
    // этап iron добыл железо «в рюкзаке 0 — РЮКЗАК ПОЛОН» при 36 занятых
    // клетках (каменный меч при железном, деревянная кирка при трёх каменных,
    // wildflowers, кварц, 2 золотых самородка — tidy их не трогал).
    // Золотые самородки не выбрасывать: из них (руда Ада) слитки на золотой шлем.
    const extra = ['quartz:0', 'wildflowers:0', 'bone_meal:0']
    if (have(/^(iron|diamond|netherite)_sword$/) > 0) extra.push('stone_sword:0', 'wooden_sword:0', 'golden_sword:0')
    // Деревянные — прочь, только если каменных хватает: при одной железной (бережётся для золота бастиона) они
    // и есть кирки штрека (chain6-15 30.09: spares делал деревянную, tidy выбрасывал — три по кругу).
    if (have(/^stone_pickaxe$/) >= 2 || have(/^(diamond|netherite)_pickaxe$/) > 0) extra.push('wooden_pickaxe:0')
    await act('pack', { mode: 'tidy', also: `cobblestone:128, cobbled_deepslate:128, netherrack:${netherrack}, raw_copper:0, copper_ingot:0, leaf_litter:0, magma_block:0, nether_brick_fence:0, nether_bricks:0, crafting_table:1, furnace:1, bowl:1, leather:0, lapis_lazuli:0, ${extra.join(', ')}` })
  }
}

// Вниз до y=toY. Колодцем — блок на уровень (~1.5 с), а не лесенкой (~4 удара и
// 7-8 с на уровень): спуск с поверхности до алмазов лесенкой — четверть часа.
// Колодец сам смотрит на два блока вниз и не идёт в лаву и воду, в пещеру
// прыгает только на maxFallHp; отказал — отрезок лесенкой (по ней обходит).
// Наверх потом не по колодцу, а mc_surface — он режет свою лесенку.
// Работа встала из-за моба рядом (штрек, лесенка: «… в N блоках впереди,
// дойдёт до меня за K шагов») — ответить: бой или бег по вердикту.
async function mobInTheWay (r) {
  const why = String((r && r.detail && r.detail.stopped) || '')
  // «… бл. на моём уровне, вплотную» (лесенка встала из-за моба вплотную) — тоже ответ, а не та же лесенка снова (trapH 02.10,
  // пещера: скелет в 1.6 и 1 бл. — две лесенки подряд, потом бой с пауком под стрелами 15 → 4).
  if (died || !/дойдёт до меня|блоках (впереди|позади|снизу|сверху)|бл. (снизу|сверху)|бл. на моём уровне, вплотную/.test(why)) return false
  log(`моб мешает работе — отвечаю: ${why.slice(0, 80)}`)
  fighting = true
  try {
    await answerThreat()
    // Моба, из-за которого встала работа, глазами не видно (за углом штрека): «дальше дело» тут же встаёт снова — круг
    // в миллисекунды, пока он не дойдёт и не ударит в спину (trap5 02.10, штрек: десятки tunnel → стоп → «бьёт
    // невидимый» за секунду). Дать ему выйти на вид — 3 с ожидания (урон его рвёт, и тогда ответ — по виду).
    if (process.env.ND_CROWD_REFUGE !== '0' && !died && !sit.foes) await act('wait', { seconds: 3 })
  } finally { fighting = false }
  return true
}

// Запас на глубину: верстак и ~8 брёвен (32 доски: верстак, кирки, палки,
// печь топить). Внизу дерева нет, и без него — ни кирки, ни верстака:
// 2026-09-26 (12:59) тело встало на y=29 с 13 сырого железа, без кирки,
// верстака и дерева.
const woodNow = () => have(LOGS) + Math.floor(have(/_planks$/) / 4)
async function reserve () {
  await sense()
  if (!sit.surface || sit.night || dim() !== 'overworld') return
  // Глубокий путь: дерево внизу — на верстак и палки запасных кирок; 4 хватает (ow-L1 02.10, слот 8: 6 брёвен < 8 —
  // поиск деревьев и 90 с разведки перед спуском).
  if (woodNow() < (OW_DEEP ? 4 : 8)) await lumber(OW_DEEP ? 6 : 10)
  await refresh()
  if (!have('crafting_table')) await ensureTable()
}

// Внизу без кирки: из запаса — доски, верстак, палки, кирка (каменная из
// булыжника, иначе деревянная). Нечем — подъём рукой (surface hand:true).
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

// Враги в обзоре (observe.entities) в 24 блоках — строка «zombie, skeleton» или пусто.
const CAVE_FOES = /^(zombie|husk|drowned|skeleton|stray|creeper|spider|cave_spider|enderman|witch|zombie_villager|slime|silverfish|bogged)$/
function cavesFoes (o) {
  const ents = (o && o.detail && Array.isArray(o.detail.entities)) ? o.detail.entities : []
  const f = ents.filter(e => CAVE_FOES.test(String(e.name || '').toLowerCase()) && (e.dist ?? 99) <= 24)
  return f.length ? f.map(e => e.name).slice(0, 4).join(', ') : ''
}
// stopAtLava — спуск ради лавы (глубокое литьё): лава у колодца или лесенки — это и есть цель, спуск кончается, а её
// место — в descendLava (ow-L1 02.10, слот 15: лава у лесенки на −48, спуск обошёл её и ушёл к −54 мимо).
let descendLava = null
async function descend (toY, { stopAtLava = false } = {}) {
  const dirs = ['north', 'east', 'south', 'west']
  descendLava = null
  await reserve()
  const lavaStop = r => {
    if (!stopAtLava) return false
    const m = /лава (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String((r && r.detail && r.detail.stopped) || ''))
    if (!m) return false
    descendLava = { x: +m[1], y: +m[2], z: +m[3] }
    log(`спуск: лава у ${m[1]},${m[2]},${m[3]} — её и надо, спуск кончаю на y ${Math.round(y())}`)
    return true
  }
  let surfaceWet = 0
  const wetStops = []
  let caveSkips = 0
  for (let i = 0; i < 8 && y() > toY + 2; i++) {
    await recoverGuard()
    if (died) return
    // Рюкзак забит породой (640 булыжника, андезит, диорит...) — внизу руду
    // некуда будет класть: лишнее сверх запасов выбросить (pack tidy).
    // Булыжник сверх 128 — прочь: мост и столб к дракону (64), подпорки рамы,
    // заслоны от мобов — хватает.
    await unclutter()
    await spares(Math.min(260, (y() - toY) * 2 + 60))
    // maxFallHp 0: в пещеру глубже трёх блоков (там прыжок бесплатен) не
    // прыгать вовсе — обойти штреком (ниже).
    // Лесенкой, а не колодцем: колодец смотрит только под ноги, и карман лавы
    // сбоку заливал его — 2026-09-26 (20:44) с y=66 на 50: 20 → 2 хп, «tried to
    // swim in lava». Лесенка вскрывает впереди и встаёт на лаве и воде рядом.
    if (!(await ensurePick())) { log('кирки нет и не из чего — вниз не иду'); return }
    // Глубокий путь: колодец 1×1 со своим чутьём (mining.shaftDown, ~1–1.5 с на уровень против 3.25 у лесенки);
    // встал (лава/вода сбоку, пещера, моб) — один отрезок лесенкой в сторону, дальше снова колодец.
    let stairsDepth = 24
    if (OW_DEEP && OW_SHAFT) {
      const shTop = state.pos ? { x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z) } : null
      const shSurface = sit.surface
      const sh = await act('tunnel', { direction: 'down', length: Math.min(64, Math.round(y() - toY)), timeoutSeconds: 240 })
      if (died) return
      // Колодец от самой поверхности (≥ 10 уровней одной колонной) — запомнить: по нему же можно подняться за водой
      // (mining.shaftUp, 0.6 с на уровень) и спуститься обратно.
      if (OW_DEEP && shTop && shSurface && sh.detail && (sh.detail.descended || 0) >= 10 && sh.detail.depth && sh.detail.depth.x === shTop.x && sh.detail.depth.z === shTop.z) {
        surfaceShaft = { x: shTop.x, z: shTop.z, top: shTop.y, bottom: sh.detail.depth.y }
      }
      if (lavaStop(sh)) return
      // Колодец вскрыл пещеру — оглядеться: лава на дне больших пещер видна издалека (честно, лучом).
      if (OW_DEEP && /пустота|пещер/.test(String((sh.detail && sh.detail.stopped) || ''))) {
        // Сперва оглядеться, потом руда: в пещере с врагами за рудой не ходить (ow-P1 02.10, слот 9 — зомби и скелет
        // в пещере на y 27, смерть на 6-й мин).
        const o = await act('observe', { radius: 48 })
        // Пещера — руда на её стенах видна: железо на вёдра (пока нужно) и уголь на плавку — сразу, без штреков.
        if (!cavesFoes(o)) {
          if (!known.portal && have(/bucket$/) < 2 && have(/^(raw_iron|iron_ingot)$/) < 7) await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: 7 - have(/^(raw_iron|iron_ingot)$/), radius: 14, timeoutSeconds: 90 })
          if (!known.portal && have(/^(coal|charcoal)$/) < 2) await act('mine', { block: 'coal_ore,deepslate_coal_ore', count: 3, radius: 16, timeoutSeconds: 45 })
        } else log(`спуск: в пещере ${cavesFoes(o)} — руду в ней не беру`)
        const lv = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
        // В пещере враги — к лаве через неё не ходить (ow-L2 02.10, слот 9: лава в 10 бл. ниже, по пещере 4 врага,
        // смерть за 2 мин), спуск — дальше колодцем; лаву дальше 32 по горизонтали — тоже мимо.
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
      // Колодец вышел в потолок пещеры — не лесенкой в неё (в пещере мобы: ow-P1 02.10, слот 9 — лесенка вниз в пещеру
      // на y 27, зомби вплотную и скелет, смерть на 6-й мин), а штрек 8 вбок по твёрдому и колодец оттуда, до 3 раз.
      // Тело стоит на потолке пещеры (пол в 1 блок над пустотой): штрек на этой высоте — «под ногами дыра», лесенка
      // проваливается (ow-P2 02.10, слот 10: лесенкой с потолка пещеры y 26 → 4 → −2, «fell from a high place»).
      // Сперва 3 уровня вверх своим колодцем (tunnel up), оттуда штрек 8 вбок по целому полу.
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
      // Вода под колодцем у поверхности (берег, болото, мелководье) — лесенка там встанет так же: уйти от воды поверху.
      const shWet = /вода на (-?\d+),(-?\d+),(-?\d+)/.exec(String((sh.detail && sh.detail.stopped) || ''))
      if (shWet) wetStops.push({ x: +shWet[1], z: +shWet[3] })
      // Колодец встал у воды, а ведро воды ещё не набрано — набрать тут же (черпак, стенку ломает obsidian.breachWall).
      if (shWet && OW_DEEP && !known.portal && have(/^bucket$/) && !have('water_bucket')) {
        await act('portal', { mode: 'cast', waterHint: { x: +shWet[1], y: +shWet[2], z: +shWet[3] }, timeoutSeconds: 60 })
        if (have('water_bucket')) log(`спуск: вода у колодца ${shWet[1]},${shWet[2]},${shWet[3]} — ведро полное`)
      }
      if (shWet && y() >= 50 && surfaceWet < 3) {
        await sense()
        if (sit.surface || y() >= 58) {
          surfaceWet++
          // Колодец подсказал сухое возвышение (mining.dryGround: холм выше воды в 12–44 бл., по верху рельефа) — туда;
          // нет — прочь от воды, как раньше.
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
    if (lavaStop(d)) return
    if (await mobInTheWay(d)) continue
    if (died) return
    if (d.detail && ((d.detail.dug ?? 0) >= 3 || (d.detail.steps ?? 0) >= 2) && !d.detail.stopped) continue
    const why = String((d.detail && d.detail.stopped) || d.error || '')
    // Вода рядом (берег озера): вокруг та же вода, и лесенка на все четыре
    // стороны отвечала «вода у … — дальше не копаю», пока утопленники били с
    // дистанции (2026-09-26, девять минут на одном месте, 18 → 2 хп). Уйти от
    // воды — прочь от названной клетки на 24 блока, поверху, — и копать там.
    const wet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    // Глубокий путь: вода у лесенки (не в ней) — штрек вбок на 8 прочь от воды и лесенка оттуда, без подъёма
    // наверх и 24 блоков поверху (ow-E0 слот 13: с y 44 наверх и снова вниз — 2.5 мин).
    // ND_NIGHT_DOWN=2 (survival): ночью так же — штрек вбок, а не наверх и 24 бл. поверху (trapH 02.10, ночь: вода у лесенки
    // на y 26 → подъём наверх ночью → утопленник у берега, смерть).
    if ((OW_DEEP || (NIGHT_DOWN2() && sit.night)) && wet && !/под ногами вода|я в воде/.test(why) && state.pos && y() < 55) {
      // Прочь от ВСЕХ мест, где колодец и лесенка встали у воды за этот спуск, а не только от последнего: иначе штрек
      // на 8 ходил север-юг между двумя краями водоносного кармана (ow-E3 02.10, слот 13: 8 кругов у 373,19,88/96).
      wetStops.push({ x: +wet[1], z: +wet[3] })
      const opts = [['east', 1, 0], ['west', -1, 0], ['south', 0, 1], ['north', 0, -1]].map(([d, vx, vz]) => {
        const nx = state.pos.x + vx * 12; const nz = state.pos.z + vz * 12
        return { d, score: Math.min(...wetStops.map(w => Math.hypot(w.x - nx, w.z - nz))) }
      }).sort((a, b) => b.score - a.score)
      await spares(80)
      await act('tunnel', { direction: opts[0].d, length: 12, torchEvery: 0, timeoutSeconds: 90 })
      continue
    }
    if (wet || /под ногами вода|я в воде/.test(why)) {
      const away = await awayFrom(wet ? { x: +wet[1], z: +wet[3] } : null, 24)
      if (away.status !== 'done') throw new Error('не смог отойти от воды — спуск здесь прекращаю')
      continue
    }
    // Стреляют (утопленник с трезубцем, скелет) — ответить и уйти с этого места.
    if (/бьёт с дистанции|стреляет/.test(why)) {
      fighting = true
      try { await answerThreat() } finally { fighting = false }
      if (died) return
      await awayFrom(null, 20)
      continue
    }
    // Под ногами пещера или лава — в неё не лезть: в тёмной пещере
    // спавнятся скелеты. 2026-09-26 колодец встал над пещерой на y=-25,
    // лесенка «вбок» шагнула в неё же (под ступенькой пусто), и в пещере бота
    // застрелили. Штрек в сторону на 8 блоков (он сам не вскрывает лаву и
    // воду, дыры в полу мостит) — и колодец уже оттуда.
    if (/пещер|пустот|лава/.test(why)) {
      await spares(80)
      await act('tunnel', { direction: dirs[i % 4], length: 8, torchEvery: 0, timeoutSeconds: 90 })
      continue
    }
    // Иное (кирка, бедрок, время) — отрезок лесенкой в сторону.
    await spares(120)
    await act('dig_down', { mode: 'stairs', depth: Math.min(12, y() - toY), direction: dirs[i % 4], torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 240 })
    await torches()
  }
}

// Наверх: отрезками, пока не выйдет (out) или не встанет.
async function toSurface (tries = 4) {
  let stalled = 0
  let shovelTried = false
  const wetTried = new Set()
  for (let i = 0; i < tries; i++) {
    await sense()
    if (sit.surface) return true
    // Подъём — та же лесенка: ~3 удара на уровень, и без запаса он встаёт.
    await spares(120)
    const pick = await ensurePick()
    if (!pick) log('кирки нет и не из чего — лезу наверх рукой (камень 7.5 с за блок)')
    const from = state.pos && { ...state.pos }
    const r = await act('surface', { timeoutSeconds: pick ? 120 : 600, hand: !pick, preferPillar: pick })
    if (died) return false
    if (r.detail && r.detail.out) return true
    // Сверху снег (горы): подъём не ломает snow_block без лопаты (items.missingHarvestTool) — сделать лопату из
    // того, что в рюкзаке, и лезть снова. fresh-A1 слот 18 (30.09): «snow_block голыми руками не ломается, а
    // лопаты в рюкзаке нет вовсе» при 35 булыжника и палках — 3 хп, пустые паузы еды 20 минут.
    const why0 = String((r.detail && r.detail.stopped) || '')
    if (/лопат[аы]? в рюкзаке нет|нужна лопата|_shovel/.test(why0) && !have(/_shovel$/) && !shovelTried) {
      shovelTried = true
      await sticks(2)
      if (await craft(have(COBBLE) >= 1 ? 'stone_shovel' : 'wooden_shovel')) { log('сделал лопату — снег сверху копается'); continue }
    }
    // Сверху вода (дно озера): подъём отходит на 4 и упирается снова. Уйти
    // штреком на 10 прочь от названной воды (штрек воду не вскрывает) и лезть
    // оттуда — 2026-09-26 подъём на y=91 под озером четырежды ответил одно и то же.
    const wet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(String((r.detail && r.detail.stopped) || ''))
    if (wet && state.pos) {
      const dx = state.pos.x - +wet[1]
      const dz = state.pos.z - +wet[3]
      // Вода прямо над головой (dx=dz=0 — всегда «east») или та сторона уже отказала водой — следующая сторона.
      // fresh-A0 слот 6 (30.09): пузырь под рекой, «вода у 197,60,689» над головой, штрек на восток — «вода
      // впереди сверху», и так по кругу до конца прогона.
      let dir = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north')
      if (Math.hypot(dx, dz) < 1 || wetTried.has(dir)) dir = ['east', 'south', 'west', 'north'].find(d => !wetTried.has(d)) || dir
      wetTried.add(dir)
      await act('tunnel', { direction: dir, length: 10, torchEvery: 0, timeoutSeconds: 90 })
      continue
    }
    // Под сыпучим подъём просит отойти в сторону.
    if (r.detail && /сыпуч|гравий|отойти/.test(String(r.detail.stopped || ''))) await walkAway(4, Math.PI / 2)
    // Ни лесенки, ни столба с этой клетки (развилка штреков: факелы на полу,
    // печь рядом — 2026-09-26, 10:26-10:31, пять подъёмов подряд «столб не
    // встал; лестница — не смог шагнуть») — в десяти блоках по штреку тот же
    // подъём прошёл 40 уровней. Отойти по своему ходу и лезть оттуда.
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

// Железо в дело по очереди пользы: кирка, ведро (два — вода и лава), щит,
// огниво, меч, нагрудник, поножи, ботинки, шлем. Броня по защите на слиток:
// нагрудник 6/8, поножи 5/7, ботинки 2/4, шлем 2/5 (items: armor, recipe).
async function spendIron () {
  await refresh()
  // Нагрудник раньше меча: каменный меч бьёт 5 против 6 у железного, а 6 брони
  // нагрудника — это каждый удар скелета и зомби (2026-09-26 бот умер в пещере
  // без брони с железным мечом и двумя вёдрами).
  // Второе ведро — сразу за огнивом: литьё портала (cast.js) без него не идёт
  // (одно под воду, одно под лаву), а третье — меньше ходок к лаве.
  // Путь без алмазов (литьё портала, cast.js): два ведра и огниво — раньше
  // железной кирки. Железа на y=16 здесь мало (2026-09-26: 3-4 сырых за
  // восемь штреков), и кирка первой съедала те слитки, без которых нет
  // портала; кирка нужна потом — на золото пиглинам и алмазы.
  const noShield = () => !have('shield') && !(state.offHand && /shield/.test(JSON.stringify(state.offHand)))
  // Обязательное — только то, без чего нет портала и входа (решение пользователя 30.09, путь спидраннеров): два
  // ведра (литьё: вода и лава) и огниво; после портала — кирка (золото бастиона) и ведро. Щит, кирка, меч — из
  // остатка, без отдельного похода. Броня — по расчёту «время против риска» (gearWorth): крафт из того, что уже
  // в рюкзаке, — если польза в минутах больше цены; за недостающим железом ради брони не ходим, когда поход дороже.
  const plan = known.portal ? [
    ['flint_and_steel', 1, () => !have('flint_and_steel') && have('flint') > 0],
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
    ['flint_and_steel', 1, () => !have('flint_and_steel') && have('flint') > 0],
    ['bucket', 3, () => have(/bucket$/) < 2],
    ['shield', 1, noShield],
    ['iron_pickaxe', 3, () => !have(PICK_IRON)],
    ['iron_chestplate', 8, () => !worn('torso')],
    ['iron_sword', 2, () => !have(/^(iron|diamond|netherite)_sword$/)],
    ['iron_leggings', 7, () => !worn('legs')],
    ['iron_boots', 4, () => !worn('feet')],
    ['iron_helmet', 5, () => !worn('head')]
  ]
  for (const [item, cost, want] of plan) {
    await refresh()
    // Слиток на огниво держим, пока огнива нет: кремень найдётся позже, а без
    // огнива отлитую раму нечем зажечь, а в Ад portal enter без него не пускает.
    const keep = (item !== 'flint_and_steel' && !have('flint_and_steel') && !have('fire_charge')) ? 1 : 0
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

// Броня — по расчёту «время против риска» (решение пользователя 30.09: не «всегда» и не «никогда»; цифры — в журнал).
// Цена, минуты: железо (золото) уже в рюкзаке — крафт, CRAFT_MIN; не хватает — поход: TRIP_MIN + недостача ×
// MIN_PER_INGOT. Калибровка по ферме: этап железа fresh-A0..A4 — 17 слитков, медиана 18 мин (n=30) ≈ 1.1 мин/слиток;
// вход/выход шахты — ~4 мин. Польза: ожидаемые смерти в Аду за этап стержней (NETHER_H) × цена смерти. Смертей в
// час — 4 при 8 очках брони (ферма 29.09: бой у спавнера в нагруднике и ботинках); на других очках — пропорционально
// доле урона, которую пропускает броня (CombatRules 1.21.11, удар ифрита 6, прочность 0: снятие = max(очки/5,
// очки − 4·6/8)/25). Цена смерти — DEATH_COST_MIN: возрождение у портала, дорога назад, повторный вход (оценка;
// уточнять по партиям с входом в Ад). Золотая вещь (пиглины) — та же цена, а польза — бастион/бартер без драки.
const GEAR_CALC = { MIN_PER_INGOT: 1.1, TRIP_MIN: 4, CRAFT_MIN: 0.3, DEATHS_PER_H_AT8: 4, NETHER_H: 0.5, DEATH_COST_MIN: 6, HIT: 6 }
const ARMOR_POINTS = { iron_chestplate: 6, iron_leggings: 5, iron_helmet: 2, iron_boots: 2,
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
// Доля урона, которую снимает броня (удар HIT, прочность 0).
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

// ------------------------------------------------------------------ этапы

// needed — нужен ли итог этапа (по рюкзаку и памяти); ready — есть ли, из чего
// его делать. Нужный, но не готовый этап не берётся и провалом не считается:
// без этого стёртая кирка на подъёме валила железо, алмазы и обсидиан за пять
// секунд подряд, и кампания вставала «восемь провалов» (2026-09-26).
const STAGES = []
// Этапы, которые идут не только в верхнем мире.
const OTHER_WORLD = new Set(['bastion', 'nether', 'pearls', 'eyes', 'stronghold', 'dragon'])
// Вниз — только с едой (все три смерти 2026-09-26 — внизу, две из них без
// еды: лечиться было нечем). Сытость ≥17 без еды — ещё можно: железо близко.
// Сырое при печи (или 8 булыжника на неё) — тоже запас: жарится по дороге
// (cook в начале железа, rest). Без этого 17 кусков сырого не пускали вниз, а
// жарить было некому — этап еды «сыт» (2026-09-26, 12:33).
const fed = (items, level) => have(FOOD) + ((have('furnace') || have(COBBLE) >= 8) ? have(RAW) : 0) >= items || (state.food ?? 20) >= level
// Ранен и лечиться нечем (сытость < 18, в рюкзаке ни куска): днём вниз не
// идти — этап, начатый ночью, после ночи в норе шёл в штреки на 7 хп
// (2026-09-26, 08:35). Сначала охота — её берёт следующий ход.
// Глубокий путь до портала: порог 6, а не 12 — охота в горах/снегах пуста, и «хп 3–11, еды нет» держало этапы на
// паузах по 25–30 мин (ow-E1 02.10, слоты 8, 11, 14), хотя внизу (штреки, колодец) бьют реже, чем на охоте поверху.
const weakAndHungry = () => (state.health ?? 20) < (process.env.ND_OW_DEEP === '1' && !known.portal && (state.dimension || 'overworld') === 'overworld' ? 6 : 12) &&
  !have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 && !sit.night
let ironRuns = 0
let ironLeg = 0 // сквозной номер штрека этапа iron (змейка между заходами)
const ironBlocked = new Set() // «x,z:сторона» — штрек отсюда туда не пошёл (глубокий путь)
const READY = {
  stone: () => have(/_pickaxe$/) > 0,
  // Сытость 15 без еды — ещё можно: ночь в норе без дела стоит девяти минут,
  // а внизу теперь есть ответы на то, от чего умирали (урон рвёт добор,
  // пещерную руду не берём, от воды уходим, без еды ночью сидим в норе).
  // Охота пуста дважды подряд (горы: fresh-A5 30.09, слоты 12/14/16 — 8 обзоров по 64 бл. без единого зверя, 50 мин
  // без прогресса до сторожа) — железо и при сытости ≥ 8: в горах оно на склонах, а 7 слитков — несколько минут.
  iron: () => have(PICK_STONE) > 0 && (fed(3, 15) || (foodHuntEmpty >= 2 && (state.food ?? 20) >= 8)),
  // Огниво — не условие: этап сам ищет кремень (ensureFlint), а раму можно
  // отлить и без него, зажечь потом.
  cast: () => (have(/^bucket$/) + have('water_bucket') + have('lava_bucket')) >= 2 && (have('flint_and_steel') || have('fire_charge') || have('iron_ingot')) > 0,
  diamond: () => have(PICK_IRON) > 0 && fed(5, 19),
  obsidian: () => have(PICK_DIAMOND) > 0 && have(/bucket$/) > 0,
  portal: () => have('obsidian') >= 10,
  // Сборы и Ад — после железного захода: без кирки и брони сборы бродили за
  // железом с деревянной киркой, а печь не из чего (2026-09-26, 12:26, после
  // смерти от крипера — камень отдыхал, и первым готовым оказались сборы).
  prep: () => have(PICK_STONE) > 0,
  // Уже в Аду — любая кирка (каменные из булыжника); наверху — железная.
  // Для Ада хватает каменной кирки (незерак, золотая руда Ада — любой киркой;
  // запас кирок из булыжника — spares): железная стиралась в сборах, и этап
  // стоял «нечем» при кирках из сундука (2026-09-27, 04:53).
  // Открытый бой расходует броню, щит и еду: сытость не заменяет запас
  // лечения. После износа возвращаемся за недостающим, сохраняя стержни.
  // Поножи и шлем — до боя у спавнера, пока железный заход не провалился
  // восемь раз (двух мало: 14:44–14:51 заход дважды упал на зомби у выхода,
  // и бот снова погиб у спавнера). С нагрудником и ботинками — 4 смерти за час.
  // Путь спидраннеров (решение пользователя 30.09): в Ад — кирка + ведро + еда. Броня и щит — не условие входа:
  // что из них стоит времени, решает расчёт «время против риска» (gearWorth) при крафте, а не этот порог.
  nether: () => have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0 && foodUnits() >= netherFoodNeed(),
  // Эндермены и пиглины — не с каменным мечом без брони.
  // Кирка тут ни при чём — нужен меч не хуже железного (29.09 16:19: кирка
  // стёрлась о незерак, и при 7 стержнях и железном мече — «pearls·нечем»).
  pearls: () => (have(PICK_IRON) > 0 || have(/^(iron|diamond|netherite)_sword$/) > 0),
  // Золотой блок — только железной киркой (needs_iron_tool); без брони в
  // бастион не ходят (бруты, злые пиглины).
  // Без железной кирки — один заход за железом в сундуки бастиона (bastion.js chestsOnly: основному не хватает
  // 2 самородков, в двух сундуках железо с P≈0.77), уже в Аду; не вышло — наверх, этап железа.
  bastion: () => (have(PICK_IRON) > 0 || (!ironChestTried && dim() === 'the_nether' && have('iron_ingot') + have('raw_iron') + have('iron_nugget') / 9 >= 1)) && (foodUnits() >= 6 || (state.food ?? 0) >= 18)
}
// Чего именно не хватает для READY.nether: журнал писал «еды/щита/брони», а
// не хватало стёртой о незерак кирки (2026-09-29, 12:22).
// Еды на бой у спавнера — 6 кусков, но за последним стержнем (или двумя) хватит
// трёх: 29.09 16:10 при 6 стержнях из 7 и 5.17 куска бот пошёл за едой домой —
// 460 блоков по Аду в одну сторону.
// Ночь наверху, а портал горит рядом под землёй (ND_OW_DEEP) — за едой наверх не лезть (ow-P1 02.10, слот 13: портал
// на 14-й мин у дна, еды 0, этап food потащил наверх ночью и застрял в стене): хватит 3, добор — в Аду (хоглины,
// сундуки бастиона). Решение главного 02.10: 0 нельзя — при keep_inventory=false голод без регена = смерть в бою.
function netherFoodNeed () {
  const base = rodsNow() >= 5 ? 3 : 6
  // Маршрут (ND_ROUTE, раунд 3): после поджига — сразу в Ад, еда добирается там (хоглины, сундуки бастиона): 2 куска.
  // rtV 03.10: 3 портала горели на 21–22-й мин, а кампания ушла в этап еды (охота до конца прогона) — входа не было;
  // и вошедший с < 6 тут же шёл «домой за едой» (rt-L2 слот 14).
  if (process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_FOOD2 !== '0') return Math.min(base, 2)
  if (sit.night && !sit.surface && known.portal && portalFar() < 48) return Math.min(base, 3)
  return base
}
const netherLack = () => [
  have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0 ? '' : 'кирки',
  foodUnits() >= netherFoodNeed() ? '' : `еды (${foodUnits()} из ${netherFoodNeed()})`
].filter(Boolean).join(', ') || 'ничего'
// Бой у спавнера — другое дело, чем вход в Ад: по данным фермы 29.09 с нагрудником и ботинками (8 очков брони)
// 0 из 8 боёв и 4 смерти, с поножами и шлемом бой выигрывался. Поэтому порог боя — прежний (нагрудник, щит, поножи
// и шлем, или железо не дало их за 8 заходов), а вход в Ад (READY.nether) — без брони: разведка крепости идёт
// сразу, а за бронёй — домой, только когда бой упёрся в неё (fightGearWanted), с расчётом в журнале (gearWorth).
const fightReady = () => READY.nether() && worn('torso') && shieldOn() && ((worn('legs') && worn('head')) || ironRuns >= 8)
const fightLack = () => [
  netherLack() === 'ничего' ? '' : netherLack(),
  worn('torso') ? '' : 'нагрудника',
  shieldOn() ? '' : 'щита',
  (worn('legs') && worn('head')) || ironRuns >= 8 ? '' : 'поножей или шлема'
].filter(Boolean).join(', ') || 'ничего'
let fightGearWanted = false
// defer — «не сейчас» (ночь для охоты): этап пропускается, но готовым не
// считается — иначе ночной пропуск еды писался в журнал «ВЕХА food».
const DEFER = {
  // Под землёй с запасом (3 куска, сытость ≥14) за едой наверх не лезть: подъём
  // с y=9 — четыре минуты, и железо бросалось на полпути (2026-09-26). Охота —
  // в следующий заход наверх (за водой, к порталу).
  // Запас — 6: трёх кусков не хватило — автопилот доел их, пока лечился, и на
  // 8 хп «лечиться нечем» (2026-09-26, вторая смерть).
  // Ночью под крышей с едой — не наверх: там девять минут ночи, а внизу
  // работа (железо в вёдра). 2026-09-26 (10:27): 17 слитков лежали, пока этап
  // еды ждал утра в штреке.
  food: () => nightWork() || (!sit.surface && have(FOOD) >= 6 && (state.food ?? 20) >= 14) ||
    // Глубокий путь: две пустые охоты — хватит бродить поверху; дальше еда — только «на виду» (quickHunt). Одной мало:
    // без еды бой не принимается («нет запаса еды») — ow-P2 02.10, слот 9: охота 60 с с горы впустую, на y 16 скелет
    // в штреке, бой не принят, бегство по кругу.
    (OW_DEEP && !known.portal && foodHuntEmpty >= 2 && !weakAndHungry()) ||
    (OW_DEEP && !known.portal && foodSpentMs >= FOOD_CAP_MS && foodUnits() >= 3 && !weakAndHungry()) ||
    // Портал у дна горит, снаружи ночь — наверх за едой не лезть (ow-P1 02.10, слот 13: портал на 14-й мин, охота
    // ночью — застрял в стене на подъёме, смерть на 22-й).
    (OW_DEEP && !!known.portal && (known.portal.y ?? 64) < 40 && near3(known.portal, 48) && !sit.surface && y() < 40 && (sit.night || READY.nether()) && !weakAndHungry()) ||
    (sit.night && !sit.surface && foodUnits() >= 4) ||
    // Глубокий путь (ND_OW_DEEP): до портала из-под земли за едой не подниматься, пока сытость ≥ 10 — подъём с y 16
    // или −54 и спуск обратно дороже голода; охота — до спуска (этап еды, quickHunt).
    (OW_DEEP && !known.portal && !sit.surface && y() < 50 && (state.food ?? 20) >= 10 && !weakAndHungry()),
  // Воду искать ходьбой поверху — днём; ночью с железной киркой — вниз за
  // алмазами (они воды не ждут, ждёт только обсидиан).
  water: () => (nightWork() && have(PICK_IRON) > 0) ||
    (OW_DEEP && !known.portal && !sit.surface && y() < 50 && Date.now() - waterDeepFailAt < 8 * 60000),
  // Лаву искать поверху ночью — это ходить среди мобов; под землёй — можно.
  // Глубоко с алмазной киркой — обсидиан ведром (этап obsidian), а не литьё: под землёй раме негде расти
  // («столб не вырос (потолок cobblestone)» ×3 на месте), fresh-A1 слот 12 30.09 — литьё на y −53 сорок минут,
  // обсидиан после паузы литья — за 20.
  cast: () => (sit.night && sit.surface && dim() === 'overworld' && !(OW_DEEP && !surfaceLavaNear())) ||
    (have(PICK_DIAMOND) > 0 && have(/bucket$/) > 0 && y() < 0) ||
    (castSurfaceFailed && !known.lava)
}
// done — итог этапа есть по состоянию мира (рюкзак, память). «Не нужен» ≠ «сделан»: этап снимается и
// тогда, когда сдан или нельзя (eyes без жемчуга, бастион после сухих заходов, endkit после трёх заходов,
// prep после захода). ВЕХА и «готов» — только по done() (research/05-synthesis.md F.3-1); без своего
// done — прежнее «не нужен».
const DONE = {}
function defStage (name, needed, run) { STAGES.push({ name, needed, run, ready: READY[name] || (() => true), defer: DEFER[name] || (() => false), done: () => (DONE[name] ? DONE[name]() : !needed()) }) }

// Смотрим на полезный результат этапа, а не на статус RPC «done» и не на
// накопленный при ходьбе хлам. Частичная добыча — продолжение, потеря вещей
// и ходьба по кругу — нет. Снимок чисел не меняется вместе с state.inventory.
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
  const result = {}
  const re = resources[name]
  if (re) for (const [item, count] of Object.entries(state.inventory || {})) if (re.test(item)) result[item] = count
  for (const key of ['portal', 'fortress', 'stronghold', 'endPortal', 'dragonWon']) result[`known:${key}`] = known[key] ? 1 : 0
  if (dim() === 'the_end') result.end = 1
  return result
}

// 1. Дерево: 14 брёвен (верстак, палки, кирка, топливо печи, щит, кровать),
// доски, верстак, палки, деревянная кирка.
defStage('wood', () => !have(/_pickaxe$/) ||
  (!!known.portal && rodsNow() < 7 && woodNow() < 4 && ((!shieldOn() && have('iron_ingot') > 0) || have(/_pickaxe$/) <= 2)), async () => {
  const recovering = !!known.portal
  // Mining may already have made the starter toolkit. Five actual logs
  // retain the existing charcoal threshold and four-log replacement reserve.
  const starter = process.env.ND_ROUTE === '1' && !recovering && process.env.ND_ROUTE_WOOD_ONCE !== '0' &&
    have(/_pickaxe$/) && have('crafting_table') && have('stick') >= 2
  const stock = () => starter ? have(LOGS) : woodNow()
  // 14 и на глубоком пути: 10 не хватило (ow-P1 02.10, слот 12 — на y −12 ни досок, ни верстака, три деревянные
  // кирки и 319 булыжника: каменные кирки стёрлись о колодец и штреки, а делать новые не из чего).
  // Маршрут (ND_ROUTE): 8 — верстак, палки, кирки, уголь на плавку вёдер; щит и кровати — после портала (поток route).
  const want = starter ? 5 : recovering ? 4 : (process.env.ND_ROUTE === '1' && !known.portal ? 8 : 14)
  // Утро в норе (после ночи или смерти) — сначала наружу: из-под крышки
  // деревьев не видно («не вижу any_log»).
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  for (let i = 0; i < 10 && stock() < want; i++) {
    await nightGuard()
    await recoverGuard()
    // Внизу (штрек, колодец) деревьев нет — наверх: киркой из запаса или
    // рукой (toSurface → ensurePick → surface hand:true). 2026-09-26 (12:59)
    // этап дерева на y=29 искал брёвна по штрекам.
    await sense()
    if (!sit.surface && (!sit.night || canWorkAtNight()) && dim() === 'overworld' && !(await toSurface())) break
    const m = await act('mine', { block: 'any_log', count: want - stock(), radius: 48, timeoutSeconds: 240 })
    if (stock() >= want) break
    if (m.status !== 'done' || !(m.detail && m.detail.dug)) {
      // Видно, но не подойти (макушка дерева, обрыв) — explore ответит «уже
      // видно отсюда» и не сдвинется: отойти самому и смотреть оттуда.
      if (!/не вижу/.test(String(m.error || ''))) { await walkAway(20, Math.PI / 2); continue }
      const e = await act('explore', { block: 'any_log', radius: 48, stepDistance: 80, timeoutSeconds: 120 })
      if (!(e.detail && e.detail.found)) await walkAway(60, Math.PI / 3)
    }
  }
  // При восстановлении с каменными кирками нужен древесный запас, а не
  // повтор стартового набора. Доски/палки сделает конкретный следующий рецепт.
  if (recovering && have(/_pickaxe$/)) return
  if (starter && stock() >= want) {
    if (!known.lava) await act('observe', { radius: 48 })
    return
  }
  // count у craft — число ПРЕДМЕТОВ на выходе (4 доски с бревна).
  const planks = planksFor()
  if (!planks) throw new Error('брёвен нет')
  if (have(/_planks$/) < 12) await craft(planks, 12 - have(/_planks$/))
  if (!have('crafting_table')) await craft('crafting_table')
  await sticks(6)
  await craft('wooden_pickaxe')
  // Оглядеться: лава у спавна — это будущий портал (литьё), а видна она
  // только тем, кто смотрит (act запомнит место).
  if (!known.lava && !known.portal) await act('observe', { radius: 48 })
})

// 2. Камень: булыжник на кирку, меч, топор и печь (8). Камень, который видно
// (склон, обрыв, пещера), — сходить к нему; не видно — лесенкой вниз: под
// дёрном камень почти везде, и каждая ступень сама даёт булыжник.
defStage('stone', () => !have(PICK_STONE) || !have(/_sword$/), async () => {
  // Глубокий путь: булыжник — на кирку, меч и печь (13); остальное даст колодец и штреки.
  const want = OW_DEEP ? 13 : 24
  // Маршрут (ND_ROUTE): камень — ближний (14) и только пока не били; дальше — своя лесенка вниз, не чужая пещера
  // (rt-R6/R6b: за камнем в 32 бл. в тёмную пещеру — скелет/зомби, смерть на 2-й и 6-й мин).
  const safeStone = process.env.ND_ROUTE === '1'
  const pickFirst = safeStone && process.env.ND_ROUTE_PICK_FIRST !== '0'
  let hurt = false
  for (let i = 0; i < 8 && have(COBBLE) < want; i++) {
    await nightGuard()
    await recoverGuard()
    if (died) return
    // Булыжника на каменную кирку уже хватает — сразу она (раунд 3: rtV-B 14 — 10 мин кругов «У кирки осталось ~43
    // удара … можно скрафтить stone_pickaxe» с булыжником в рюкзаке: деревянная не пускала лесенку дальше).
    if (!have(PICK_STONE) && have(COBBLE) >= 3 && process.env.ND_ROUTE === '1') { await sticks(2); await craft('stone_pickaxe') }
    const firstPick = pickFirst && !have(PICK_STONE)
    const batch = firstPick ? Math.min(want - have(COBBLE), Math.max(1, 3 - have(COBBLE))) : want - have(COBBLE)
    const m = hurt ? { detail: {} } : await act('mine', { block: 'stone', count: batch, radius: safeStone ? 14 : 32, timeoutSeconds: 180 })
    if (have(COBBLE) >= want) break
    if (safeStone && (m.code === 'DAMAGE' || m.status === 'interrupted')) { hurt = true; log(`камень: ${m.code || m.status} в забое — дальше своей лесенкой`); await act('surface', { timeoutSeconds: 40, hand: false, preferPillar: true }) }
    else if (m.detail && m.detail.dug) continue
    // Маршрут: лесенка у воды уходит в водоносный слой (сид 1619383808589565669: яма с водой у берега — утонул/задохнулся
    // в базе, A1, A3 на 3–7-й мин) — вода в 7 бл. на виду: сперва отойти на 24 бл. от неё.
    if (safeStone) {
      const ob = await act('observe', { radius: 7 })
      if ((Array.isArray(ob.detail && ob.detail.blocks) ? ob.detail.blocks : []).some(b => b && b.name === 'water')) { log('камень: вода рядом — лесенку копаю подальше от неё'); await awayFromWater(24); await sense(); if (sit.inWater) await leaveWater() }
    }
    const d = await act('dig_down', { mode: 'stairs', depth: firstPick ? 3 : 10, torchEvery: 0, timeoutSeconds: 180 })
    // Лесенка встала у воды (берег, болото) — то же место даст тот же отказ: сперва отойти от воды (ow-P1 02.10,
    // слот 8: две одинаковые лесенки «вода у … — дальше не копаю» подряд и разведка, камень на 7-й мин).
    const dWet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(String((d.detail && d.detail.stopped) || ''))
    if (dWet && !(d.detail && d.detail.steps >= 3)) { await awayFrom({ x: +dWet[1], z: +dWet[3] }, 20).catch(() => null); continue }
    if (d.detail && d.detail.steps) continue
    // Деревянная кирка на исходе («У кирки осталось ~N ударов, а дальше нужно больше»): новая из досок — или ступени
    // покороче (ow-E2 02.10, слот 15: 30 мин по кругу «mine → лесенка отказ → разведка» на пляже).
    if (/У кирки осталось/.test(String((d.detail && d.detail.stopped) || ''))) {
      if (have(/_planks$/) >= 3 || have(LOGS)) { await sticks(2); if (await craft('wooden_pickaxe')) continue }
      const d2 = await act('dig_down', { mode: 'stairs', depth: 3, torchEvery: 0, timeoutSeconds: 90 })
      if (d2.detail && d2.detail.steps) continue
    }
    // Вниз не копается (песок, вода, пещера под ногами) — искать склон или отойти.
    const e = await act('explore', { block: 'stone', radius: 48, stepDistance: 60, timeoutSeconds: 120 })
    // «Уже видно отсюда», а mine его не берёт (камень под ногами, недосягаемый
    // склон), и лесенку держит скелет в пещере снизу — тот же круг шесть раз за
    // две секунды (2026-09-26, 12:16). Отойти и смотреть оттуда.
    if (!(e.detail && e.detail.found) || /уже видно/.test(String((e.detail && e.detail.note) || ''))) await walkAway(40, Math.PI / 2)
  }
  await sticks(5)
  // Только недостающее: этап, повторённый после сбоя, ковал второй и третий
  // меч и топор (2026-09-26: по три штуки).
  if (!have(PICK_STONE)) await craft('stone_pickaxe')
  if (!have(/_sword$/)) await craft('stone_sword')
  if (!have(/_axe$/) && have(COBBLE) >= 11) await craft('stone_axe')
  if (!have('furnace') && have(COBBLE) >= 8) await craft('furnace')
  if (!known.lava && !known.portal) await act('observe', { radius: 48 })
})

// 3. Еда: мясо с животных (овцы вперёд — шерсть на кровать), пожарить.
// Кровать — это пропущенная ночь вместо семи минут в норе, и точка
// возрождения у портала потом.
// Ночью, сытым и с каменной киркой, за едой не ходить: наверху ночь — это девять
// минут в норе (тики 12542..23459), а под землёй ночи нет — железо (этап iron,
// колодцем вниз) идёт своим чередом, охота — с рассветом, следующим ходом.
// ND_NIGHT_DOWN=2: ночью наверху не охотиться и при сытости 6–11 — внизу ещё есть минуты работы, голод бьёт только с 0
// (pool2 02.10, слот 16: сытость 11 — охота ночью: нора → наверх → вода → утопленник).
const nightWork = () => sit.night && !canWorkAtNight() && (state.food ?? 20) >= (NIGHT_DOWN2() ? 6 : 12) && have(PICK_STONE) > 0 && !have(/_bed$/)
// Сырое — тоже еда: его жарят (cook) там же, где печь; этап, считавший только
// жареное, гнал наверх с шестью кусками баранины в рюкзаке (2026-09-26, 10:26).
// Охота не бросается ради охоты (act: «ранен и голоден — сначала еда»).
const FOOD_STOCK = 8
// Кровать — не еда (H4): «запас еды набран, но кровати нет» держал этап нужным — 15 % пустых итогов еды во всех
// журналах. Кровать у портала — в сборах (prep: точка возрождения), шесть — в наборе на дракона (endkit);
// овцу охота берёт первой и так, пока шерсти мало (woolFor). Минимум для шага — у самих шагов (READY.iron fed,
// READY.nether netherFoodNeed), а пустая охота теперь — пауза этапа, а не остановка.
// Сколько заходов охоты подряд не дали еды (сброс — первая добыча).
let foodHuntEmpty = 0
// Глубокий путь до портала: охота поверху — не дольше 3 мин суммарно (ow-E3 02.10, слот 11: три хода охоты подряд,
// каждый с частичной добычей, увели тело на 580 бл. от спавна в болото — спуск там встал на воде). Дальше — еда
// «на виду» (quickHunt) перед спуском и запас для Ада после портала.
let foodSpentMs = 0
const FOOD_CAP_MS = 180000
defStage('food', () => foodUnits() < FOOD_STOCK, async () => {
  hunting = true
  const before = foodUnits()
  const t0 = Date.now()
  try { await foodRun() } finally { hunting = false; if (OW_DEEP && !known.portal) foodSpentMs += Date.now() - t0 }
  if (foodUnits() > before) foodHuntEmpty = 0
  else if (!died && ++foodHuntEmpty === 2) log('охота пуста дважды подряд — железо пойдёт и при сытости ≥ 8 (в горах оно на склонах)')
})
async function foodRun () {
  await cook()
  await makeBed()
  const woolMax = () => Math.max(0, ...Object.entries(state.inventory || {}).filter(([k]) => /_wool$/.test(k)).map(([, v]) => v))
  // Шерсть на первую кровать — попутно, в том же заходе охоты (ночь в кровати — 10 с вместо 9 мин норы или работы
  // среди мобов: fresh-A1 30.09 — смерти первой ночи наверху от зомби, скелета, утопленников). Нужным этап
  // еды она не делает (H4): запас еды набран — этап готов, кровать или нет.
  const wantWool = () => (huntWool || !have(/_bed$/)) && have(/_bed$/) + Math.floor(woolMax() / 3) < wantBeds
  if (foodUnits() >= FOOD_STOCK && !wantWool()) return
  // Глубокий путь: портал отлит у дна, сборы (prep) зовут охоту до 8 — это подъём с −54 и спуск обратно (~10 мин).
  // Хватает на вход в Ад (READY.nether: 6) — не лезть наверх ради запаса.
  await sense()
  if (OW_DEEP && known.portal && !sit.surface && y() < 40 && foodUnits() >= netherFoodNeed()) { log(`еды ${foodUnits()} — на вход в Ад хватает, с глубины за запасом не поднимаюсь`); return }
  // Глубокий путь до портала: охота короткая (60 с) и не в снегах (рыхлый снег — «froze to death», ow-E1 слоты 10, 14).
  const deepEarly = OW_DEEP && !known.portal
  // Рыхлый снег — только на склонах, в рощах и пиках; заснеженные равнина и тайга (половина пула хороших сидов) —
  // кролики, лисы, коровы у кромки: охота 60 с, как везде (без еды вход в Ад — READY.nether — не пускает).
  if (deepEarly && /frozen|peaks|ice_spikes|snowy_slopes|grove/.test(String(state.biome || ''))) { log(`охота: ${state.biome} — рыхлый снег, звери редки; без охоты`); return }
  const remaining = deepEarly ? Math.max(0, FOOD_CAP_MS - foodSpentMs) : 120000
  if (deepEarly && remaining < 10000 && !weakAndHungry()) { log('охота: бюджет до портала (3 мин) исчерпан'); return }
  const deadline = Date.now() + (deepEarly ? Math.min(60000, remaining) : 120000)
  if (!(await toSurface())) { log('за едой не вышел на поверхность — сначала устранить причину подъёма'); return }
  // Без места под новое мясо даже успешный бой не даёт запас еды.
  await unclutter()
  // Раз уж наверху — вода, если видно (иначе за ней отдельный подъём с -54).
  if (have(/^bucket$/) && !have('water_bucket')) await act('bucket', { fluid: 'water', radius: 32 })
  await lumber(4)
  let blocked = false
  let climbing = false
  let searchedMelons = false
  // Сборы в Ад (prep) охотятся и за шерстью: кровать у портала — точка
  // возрождения. Три шерсти одного цвета — одна кровать.
  for (let i = 0; i < 4 && Date.now() < deadline && (foodUnits() < FOOD_STOCK || wantWool()); i++) {
    await sense()
    // Стемнело посреди охоты — жарить, что есть, и вниз работать (см. nightWork).
    if (nightWork()) break
    await nightGuard()
    await recoverGuard()
    if (died) return
    if (Date.now() >= deadline) break
    // 64, а не 32: на равнине стадо видно издалека, а каждая пустая прогулка
    // в 60 блоков — минута (охота была узким местом прогона 2026-09-26).
    const o = await act('observe', { radius: 64 })
    const ents = (o.detail && o.detail.entities) || []
    // В джунглях еда растёт на земле. Отсутствие коровы не означает пустой
    // участок: целевой mine тоже проверяет видимость, скрытые арбузы не выдаёт.
    const melons = (Array.isArray(o.detail?.blocks) ? o.detail.blocks : []).some(b => b.name === 'melon')
    if (foodUnits() < FOOD_STOCK && (melons || (!searchedMelons && /jungle/.test(state.biome || '')))) {
      searchedMelons = true
      await act('mine', { block: 'melon', count: Math.min(4, Math.ceil((FOOD_STOCK - foodUnits()) / 1.5)),
        radius: 64, timeoutSeconds: 30 })
      if (died) return
      if (foodUnits() >= FOOD_STOCK && !wantWool()) break
    }
    // Ранен у воды — прочь от неё: утопленник бьёт из воды, и днём он не
    // горит. 2026-09-26 (09:11-09:14) охота по берегу озера: 6 → 3 → 2 → 0,
    // «slain by Drowned».
    const wet = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).find(b => b && b.name === 'water' && (b.dist ?? 99) < 12)
    if (wet && wet.nearest && (state.health ?? 20) < 10) {
      log(`ранен (${Math.round(state.health ?? 0)} хп) у воды — ухожу от неё`)
      await awayFrom(wet.nearest, 32)
      continue
    }
    // Зверь внизу (в пещере под склоном, на дне оврага) — не наш: погоня за
    // ним — та же дорога в темноту. Только те, что в шести блоках по высоте.
    const myY = y()
    const animals = ents.filter(e => /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(String(e.name || '').toLowerCase()) &&
      !(e.pos && Math.abs(e.pos.y - myY) > 6))
    // Шерсть — на две кровати: одна стоит точкой возрождения, другая в рюкзаке.
    const woolFor = have(/_bed$/) + Math.floor(have(/_wool$/) / 3) < Math.max(2, wantBeds)
    // Еды хватает, а охота — за шерстью: не овца — не добыча (2026-09-26,
    // 11:24: четыре курицы, потом шесть осмотров на месте без шага — бой не
    // начинался, «еды уже 14»).
    const foodFull = foodUnits() >= FOOD_STOCK
    const prey = (woolFor && animals.find(e => /^sheep$/i.test(e.name))) || (foodFull ? null : animals[0])
    if (prey) {
      // Стадо рядом — бить подряд, без осмотра на каждую голову: fight сам
      // берёт ближайшего такого (findTarget), а «не вижу» — конец стада.
      const kind = String(prey.name).toLowerCase()
      // fight ищет цель в 24 блоках (combat.findTarget), а осмотр — в 64:
      // дальний зверь давал «не вижу цель» ход за ходом, без единого шага к
      // нему. Сначала подойти.
      if ((prey.dist ?? 0) > 20 && prey.pos) await act('goto', { x: prey.pos.x, z: prey.pos.z, range: 8, timeoutSeconds: 45, surface: 'strict' })
      for (let k = 0; k < 4 && Date.now() < deadline && (foodUnits() < FOOD_STOCK || (kind === 'sheep' && wantWool())) && !died; k++) {
        // retreatAtHealth 0: овца не бьёт, а порог отхода (pvp.duel, 4-6 хп) на
        // малом хп кончал бой с ней за секунду — «done» без мяса (2026-09-26,
        // 09:34: четыре овцы, корова и курица на 1-2 хп, ноль добычи).
        const f = await act('fight', { target: kind, timeoutSeconds: 40, retreatAtHealth: 0,
          purpose: kind === 'sheep' && wantWool() ? 'resource' : 'food',
          ...(kind === 'sheep' && wantWool() ? { resourceGoal: { item: 'wool', count: wantBeds * 3 } } : {}) })
        if (f.status !== 'done' || (state.health ?? 20) < 10) break
      }
      // Ранен или голоден, а сырое есть — жарить сейчас, не в конце охоты:
      // жареная баранина втрое сытнее сырой, а лечит только сытость ≥ 18.
      await refresh()
      if (have(RAW) >= 1 && ((state.health ?? 20) < 14 || (state.food ?? 20) < 14)) {
        await cook()
        if (have(FOOD) && (state.food ?? 20) < 20) await act('eat')
      }
    } else {
      // Никого не видно — дальше по прямой, в новую землю: звери — от
      // генерации чанка, а круг «три отрезка и поворот» водил по уже выбитой
      // округе (2026-09-26, 08:28-08:32: восемь отрезков — ни одного зверя).
      // Поворот — только когда отрезок не прошёл (вода, обрыв).
      if (!(await toSurface())) break
      // В гору — не туда: звери — на равнинах и в лесах ниже (горы 1.21 — козы, мяса нет). Отрезок поднял выше
      // на 12+ или мы уже выше 100 и не спускаемся — поворот.
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

// Звери на виду рядом (≤ 24 бл., по высоте ±4) — до трёх, без прогулок, ≤ 60 с; сырое — в печь сразу.
async function quickHunt () {
  await sense()
  if (!sit.surface || sit.night || (state.health ?? 20) < 10) return
  const until = Date.now() + 60000
  hunting = true
  try {
    for (let k = 0; k < 3 && Date.now() < until && !died; k++) {
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

// Кровать из 3 шерсти одного цвета + 3 досок. Две: одна остаётся точкой
// возрождения (nightGuard, take:false), другая — в рюкзаке на следующую ночь.
async function makeBed () {
  if (have(/_bed$/) >= Math.max(2, wantBeds)) return
  if (have(/_wool$/) < 3) return
  await unclutter()
  const inv = state.inventory || {}
  let wool = Object.entries(inv).filter(([k]) => /_wool$/.test(k)).sort((a, b) => b[1] - a[1])[0]
  // Три разных цвета уже есть, но кровать требует одинаковый. Одна кость
  // даёт три красителя: перекрасить дешевле, чем ещё охота или 9 минут ночи.
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
    wool = Object.entries(state.inventory || {}).filter(([k]) => /_wool$/.test(k)).sort((a, b) => b[1] - a[1])[0]
  }
  if (!wool || wool[1] < 3) return
  // Доски — 3 ОДНОГО вида (рецепт в minecraft-data — по варианту доски), и ещё 4 на верстак, если его нет: rt3-A1 слот 13 —
  // «нужен верстак» → верстак съел доски → «не хватает birch_planks×2» при 3 шерсти (кровать на 4 мин позже).
  const sameMax = () => Math.max(0, ...Object.entries(state.inventory || {}).filter(([k]) => /_planks$/.test(k)).map(([, v]) => v))
  const tableNeed = have('crafting_table') ? 0 : 4
  if (sameMax() < 3 + tableNeed) { const p = planksFor(); if (p) await craft(p, have(p) >= 3 + tableNeed ? 0 : 4 * Math.ceil((3 + tableNeed - have(p)) / 4)) }
  await refresh()
  await craft(wool[0].replace(/_wool$/, '_bed'))
  if (!have(/_bed$/) && sameMax() < 3) { const p = planksFor(); if (p) { await craft(p, 4); await craft(wool[0].replace(/_wool$/, '_bed')) } }
}

// Пожарить всё сырое. Печь: в рюкзаке, рядом или из 8 булыжника (smelt сам).
// Топливо: уголь; нет — брёвна сверх двух; нет — доски сверх восьми.
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
  // Сначала — печью, что есть: smelt сам находит поставленную рядом (прошлая
  // готовка оставила её стоять). Булыжник на новую — только если не вышло:
  // иначе 20 с «не вижу stone» и лесенка, а печь стояла в восьми блоках
  // (2026-09-26, 09:48).
  await batch()
  await refresh()
  if (complete() || have('furnace') || have(COBBLE) >= 8) { if (complete()) await furnaceBack(); return }
  await act('mine', { block: 'stone', count: 8, radius: 32, timeoutSeconds: 120 })
  if (have(COBBLE) < 8) await act('dig_down', { mode: 'stairs', depth: 6, torchEvery: 0, timeoutSeconds: 120 })
  await batch()
  await refresh()
  if (complete()) await furnaceBack()
}
// Глубокий путь до портала: печь, поставленную для готовки, — забрать (внизу на ней плавить железо на вёдра; ow-E3
// 02.10, слот 11: печь осталась у первой охоты, дальше 30 вызовов «печки нет» и 8 булыжника на новую в болоте).
async function furnaceBack () {
  if (!OW_DEEP || known.portal || have('furnace') || dim() !== 'overworld') return
  await refresh()
  if (have('furnace') || !have(/_pickaxe$/)) return
  await act('mine', { block: 'furnace', count: 1, radius: 6, timeoutSeconds: 20 })
}

// 4. Железо: вниз лесенкой к y≈16, штреки, переплавка, кирка и ведро, потом
// всё, на что хватит (spendIron). Уголь — на факелы и печь.
// Цель 17: кирка 3 + ведро 3 + щит 1 + огниво 1 + нагрудник 8 и запас. Без
// брони вниз не идти: 2026-09-26 бот с 9 железа ушёл к алмазам без нагрудника
// и был застрелен скелетом в пещере. Остальная броня — с алмазного уровня
// (deepslate_iron_ore в тех же штреках). Прошлый заход: 19 железа за 6 штреков.
// Нужно: до портала — два ведра (литьё), после — железная кирка (золото, алмазы).
// Поножи и шлем до ифритов и эндерменов: ферма 2026-09-29 (одна крепость,
// один спавнер) — с нагрудником и ботинками 0 из 8 и 4 смерти, 1 стержень на
// всех; в полной железной 2 из 6 без смерти, 3 стержня в среднем, до 8.
defStage('iron', () => (!known.portal && have(/bucket$/) < 2) ||
  (!!known.portal && rodsNow() >= 7 && !have(PICK_IRON)) ||
  // Бой у спавнера упёрся в броню (fightGearWanted) — заход за ней, стержней ещё нет.
  (!!known.portal && fightGearWanted && rodsNow() < 7 && !fightReady() && ironRuns < 8) ||
  // Литьё поверху не нашло лавы — запасной путь через алмазы: нужна железная кирка.
  (!known.portal && castSurfaceFailed && !have(PICK_IRON)) ||
  (!known.portal && !have(/bucket$/)), async () => {
  ironRuns++
  // Сколько железа нужно — по тому, чего нет: кирка 3, нагрудник 8, щит 1,
  // ведро 3 (на дракона — ведро воды), до портала — ещё два ведра и огниво.
  // До стержней железная кирка не требуется: незерак и открытый бой идут с
  // каменной. В шахту за заменой — после стержней, к золоту бастиона.
  // Раньше всегда 17: кирка стёрлась в Аду при надетом нагруднике — и 25 минут
  // штреков за 12 слитками (2026-09-28, 14:27-14:50).
  // Путь спидраннеров (решение пользователя 30.09): до портала — два ведра и огниво (7), броня — не поход, а расчёт
  // (gearWorth, пишется в журнал); кирка — только когда литьё сдалось и нужен запасной путь через алмазы.
  // Раньше 17 (с нагрудником): этап железа — медиана 18 мин на ферме, второй заход за бронёй — ещё ~25.
  const ironBase = known.portal
    ? Math.max(3, (have(PICK_IRON) ? 0 : 3) + ((have(/bucket$/) || have('water_bucket')) ? 0 : 3) +
      (fightGearWanted ? (worn('torso') ? 0 : 8) + (worn('legs') ? 0 : 7) + (worn('head') ? 0 : 5) + (shieldOn() ? 0 : 1) : 0))
    : (process.env.ND_ROUTE === '1' && stage === 'route' && routeMod && !(castSurfaceFailed && !have(PICK_IRON))
      // Маршрут (раунд 3): литьё одним ведром — железо только на ведро и огниво (rtV-B 12: этап железа 738 с за вторым ведром).
      ? 3 * routeMod.BUCKETS() + (lighter() ? 0 : 1)
      : 7 + ((castSurfaceFailed && !have(PICK_IRON)) ? 3 : 0))
  let want = ironBase
  for (const item of ['iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots']) {
    if (worn(ARMOR_SLOT[item.split('_').pop()])) continue
    const g = gearWorth(item)
    if (g.missing) { log(g.line); if (g.take) want += ARMOR_COST[item] }
  }
  // Глубокий путь до портала: уже сделанные вёдра и огниво — тоже железо этапа (ведро крафтится сразу, по пути).
  const ironNow = () => have(/^(raw_iron|iron_ingot)$/) + 9 * have('iron_block') + 9 * have('raw_iron_block') +
    (OW_DEEP && !known.portal ? 3 * have(/bucket$/) + have('flint_and_steel') : 0)
  // Сначала поверху, днём: железо выходит на склонах (верхняя трапеция руды
  // 80..384 с пиком на 232 — worldmap ORES; холмы у спавна до y=120), и
  // склон при свете безопаснее штреков — все шесть смертей 2026-09-26 были
  // внизу. Видно сквозь отсечку теперь честно (sight.visibleOf).
  await sense()
  if (weakAndHungry()) { log(`хп ${Math.round(state.health ?? 0)} и еды нет — вниз не иду, сначала охота`); return }
  // Сырое — пожарить до спуска: внизу лечит только жареное (сытость ≥ 18).
  await cook()
  if ((state.food ?? 20) < 18 && have(FOOD)) await act('eat')
  if (OW_DEEP && !known.portal && ironNow() < want && sit.surface && !sit.night && dim() === 'overworld') {
    // Глубокий путь: поверху — только то, что видно сейчас и рядом, без разведки (ow-E0 02.10, слот 13: разведка
    // железа и подход к далёкой руде — 5 мин поверху, потом всё равно штреки на 16). Уголь — так же.
    // В горах (y > 90) железо выходит на склоны густо (ore_iron_upper: 90 на чанк, пик 232) — радиус 48, два захода.
    const high = y() > 90
    for (let k = 0; k < (high ? 2 : 1) && ironNow() < want && !died; k++) {
      // Радиус 32, не 48: к руде на дальнем склоне горы идти долго и под скелетами (ow-P4 02.10, слот 9: mine iron_ore
      // радиусом 48 на y 100 — урон, бой не принят «нет еды», бегство, смерть на 4.5 мин).
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
  // Точка возрождения — у входа в шахту: все четыре смерти 2026-09-26 были
  // между камнем и железом, и возрождение у входа — это вещи через минуту, а
  // не через полмира. Клик по кровати ставит точку и днём (bedtime.setSpawn),
  // кровать остаётся стоять.
  if (ironNow() < want && y() > 24 && have(/_bed$/)) {
    await sense()
    await readMemory()
    const sb = known.spawnBed
    // И не только наверху: этап часто начинается на дне своей лесенки (камень,
    // печь), и точка у входа в штреки лучше, чем на спавне мира за 1500 блоков.
    if (dim() === 'overworld' && (!sb || Math.hypot(sb.x - state.pos.x, sb.z - state.pos.z) > 48)) {
      await act('sleep', { mode: 'spawn', why: 'у шахты за железом' })
    }
  }
  // Дерево — наверху: на глубине верстак, палки на кирки и топливо печи
  // брать неоткуда (2026-09-26, 12:55: 13 сырого железа на y=15 — ни доски,
  // ни угля, ни верстака).
  if (ironNow() < want && y() > 24 && !(OW_DEEP && woodNow() >= 6)) { await sense(); if (sit.surface && !sit.night) await lumber(8) }
  // Глубокий путь: под землёй еды нет, а вход в Ад требует запаса (READY.nether, сборы prep — 8): звери на виду рядом —
  // взять до спуска, без прогулок (охота этапа еды уже была).
  if (OW_DEEP && !known.portal && ironNow() < want && y() > 24 && foodUnits() < FOOD_STOCK + 2) await quickHunt()
  // Перед спуском — столб обзора: лава под небом в 128 бл. (литьё будет поверху у неё, naturalCast).
  if (OW_DEEP && !known.portal && ironNow() < want && y() > 24 && !skyLavaSeen) await surfaceLavaSurvey()
  // Перед спуском — какая вода видна с устья (за ней можно будет подняться своим колодцем, waterViaShaft).
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
  // Глубокий путь: колодец часто кончается в пещере — руда на её стенах видна сразу, до штреков.
  if (OW_DEEP && ironNow() < want) await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: want - ironNow(), radius: 14, timeoutSeconds: 120 })
  if (died) return
  await lightUp()
  // Змейка, а не квадрат: север-восток-юг-запад по 32 замыкались в тот же
  // квадрат, и каждый следующий круг — и каждый новый заход этапа с того же
  // места — шёл по своим штрекам (29.09 15:05–15:13: трижды x −187..−155,
  // z −283..−247, руды «не вижу»). Главное направление и стороны по очереди:
  // С, В, С, З, С, В… — каждый штрек в нетронутой породе; счёт сквозной.
  const ironDir = n => (n % 2 === 0 ? 'north' : n % 4 === 1 ? 'east' : 'west')
  for (let i = 0; i < 14 && ironNow() < want; i++) {
    await recoverGuard()
    if (died) return
    await unclutter()
    await spares()
    // Кирка на исходе, а палок и досок нет — наверх за деревом, ПОКА есть чем
    // копать: иначе последняя кирка ломается на глубине и подъём рукой идёт по
    // 7.5 с за блок (2026-09-28, 14:56-15:07: с y=15 за 10 минут на 23 блока).
    await sense()
    if ((sit.pickLeft ?? 0) < 120 && have('stick') < 2 && have(/_planks$/) < 2 && !have(LOGS)) {
      log(`кирке осталось ${sit.pickLeft ?? 0} ударов, палок нет — наверх за деревом, пока есть чем копать`)
      if (await toSurface()) { await nightGuard(); await lumber(10); await spares(300) }
      break
    }
    // Глубокий путь: сторона, где штрек с этого же места уже не пошёл (вода/лава впереди), — мимо: иначе змейка С-З-С
    // упиралась в ту же воду и крутилась на месте (ow-P4 02.10, слот 13: 4 штрека подряд «вода на … (в 1 впереди)»).
    let tdir = ironDir(ironLeg++)
    if (OW_DEEP && state.pos) {
      const here = `${Math.floor(state.pos.x)},${Math.floor(state.pos.z)}`
      for (let k = 0; k < 4 && ironBlocked.has(`${here}:${tdir}`); k++) tdir = ['north', 'east', 'south', 'west'][(['north', 'east', 'south', 'west'].indexOf(tdir) + 1) % 4]
    }
    const tFrom = state.pos ? `${Math.floor(state.pos.x)},${Math.floor(state.pos.z)}` : ''
    const t = await act('tunnel', { direction: tdir, length: 32, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    if (OW_DEEP && t.detail && t.detail.stopped && !(t.detail.walked > 0)) ironBlocked.add(`${tFrom}:${tdir}`)
    // Штрек встал из-за моба рядом («creeper в 5.1 блоках впереди, дойдёт до
    // меня за 4 шага») — ответить ему, а не крутить штрек по четырём сторонам:
    // 2026-09-26 (12:48) весь заход железа кончился за секунду, крипер стоял.
    if (await mobInTheWay(t)) continue
    if (OW_DEEP && OW_HEAR && !known.portal) await listenForLava('штрек за железом')
    await mineSeenAll('iron_ore')
    await mineSeenAll('deepslate_iron_ore')
    // Глубокий путь: первое ведро — как только хватит железа, и вода — тут же, где штрек её встретил (на y 16 водоносные
    // пещеры часто): иначе после железа отдельный поиск воды 5–14 мин (ow-E2).
    if (OW_DEEP && !known.portal && !have('water_bucket')) await bucketOnTheWay(t)
    // Золото на шлем (пиглины не трогают игрока в золотой вещи — PiglinAi.
    // isWearingSafeArmor): без него 2026-09-27 (00:04) у крепости — «slain by
    // Piglin». Руда в стенах штрека — брать сразу (железная кирка есть).
    if (known.portal && have(PICK_IRON) && !goldOn() && have(/^(raw_gold|gold_ingot)$/) < 5) await mineSeenAll('gold_ore,deepslate_gold_ore')
    // Штрек вскрыл пещеру — руда на её стенах видна глазами (sight.visibleOf). Глубокий путь — только рядом со штреком
    // (12): mine идёт к видимой руде в 32 бл. и по высоте — ow-P1 02.10, слот 10: со штрека на y 16 к руде в пещере на
    // y −20, «tried to swim in lava» на 9-й мин.
    await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: 8, radius: OW_DEEP ? 16 : 32, timeoutSeconds: 150 })
    // Оглядеться: штрек вскрывает пещеры, а в них бывает лава — её место
    // запомнит act (портал льётся у лавы, и искать её потом вслепую не придётся).
    if ((!known.lava || OW_DEEP) && !known.portal) await act('observe', { radius: 32 })
    if (have(/^(coal|charcoal)$/) < 12) await mineSeenAll('coal_ore')
    // Кремень — из гравия с шансом 1/10: горсть, а не три блока, пока огнива
    // нет (без огнива portal enter в Ад не пускает).
    if (!have('flint') && !have('flint_and_steel')) await act('mine', { block: 'gravel', dry: true, count: 8, radius: 16, timeoutSeconds: 90 })
    await torches()
    if (t.detail && t.detail.need) break
    // Кирка, ведро, щит, огниво и нагрудник есть — хватит бродить.
    // Два ведра, огниво и щит — 8 слитков: литью хватает; кирка и нагрудник —
    // со следующего захода.
    // Портал горит — в Ад: кирка, щит и нагрудник (12).
    // Портал горит — ещё и золото на шлем, до десяти штреков.
    const goldDone = !known.portal || goldOn() || have(/^(raw_gold|gold_ingot)$/) >= 5
    if (i >= (known.portal ? 1 : 4) && ironNow() >= (known.portal ? want : 8) && (goldDone || i >= (known.portal ? 5 : 10))) break
  }
  // Плавить нечем (ни угля, ни дерева на топливо и верстак) — наверх за
  // деревом: сырое железо без печи — это ноль слитков.
  if (have('raw_iron') && !have(/^(coal|charcoal)$/) && woodNow() < 6 && ironToSmelt() > 0) {
    await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
    if (have('raw_iron') && ironToSmelt() > 0 && await toSurface()) { await nightGuard(); await lumber(12) }
  }
  await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true, max: ironToSmelt() })
  await spendIron()
  // Золото на шлем: пиглины не трогают игрока хоть в одной вещи из
  // #piglin_safe_armor (PiglinAi.isWearingSafeArmor, paper-1.21.11 — см.
  // armor.js), а без неё бастион и бартер — драка. Золотую руду роняет только
  // железная кирка и выше — поэтому после неё.
  if (have(PICK_IRON) && have(/^(raw_gold|gold_ingot)$/) < 5) {
    await mineSeenAll('gold_ore')
    await mineSeenAll('deepslate_gold_ore')
  }
  // Плавить золото всегда (раньше — только когда его было меньше 5, и восемь
  // сырого так и лежали), и шлем — сразу, пока верстак и печь под рукой.
  await smeltAll('raw_gold', 'gold_ingot')
  if (known.portal && !goldOn() && have('gold_ingot') >= 5) { await craft('golden_helmet'); await act('armor') }
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

// Руда из памяти — только ближняя. mine_seen по имени берёт ближайшую из
// помнящихся, а она бывает и в восьмидесяти блоках: за золотом тело ушло по
// старым тёмным штрекам, и там его застрелил скелет (2026-09-26, 05:03). Список
// памяти (mine_seen без аргументов) даёт fromMe — берём жилу по координатам,
// только если она ближе maxDist. До трёх жил подряд.
async function mineSeenAll (block, maxDist = 24) {
  const names = block.split(',').map(s => s.trim())
  for (let i = 0; i < 3; i++) {
    let spots = []
    try {
      const r = await call('mine_seen', { limit: 40 })
      spots = (r.detail && r.detail.spots) || []
    } catch { return }
    // Руда, увиденная через пещеру (why «в прямой видимости»), — не наша
    // стена штрека: за ней ходят в тёмную пещеру. 2026-09-26 такой добор у края
    // пещеры кончился смертью от зомби. Только стены своих штреков и жилы, а
    // из пещерных — лишь то, что в пяти блоках.
    // Глубокий путь: только руда почти на своей высоте (±4) и не дальше 16 — за рудой выше/ниже дорога идёт краем
    // пещеры (ow-P3 02.10, слот 10: mine_seen к руде на 11 бл. выше через край оврага, падение на 34 бл.).
    const levelOk = p => !OW_DEEP || (Math.abs(((p.at && p.at.y) ?? y()) - y()) <= 4 && (p.fromMe ?? 99) <= 16)
    const s = spots.find(p => names.includes(p.name) && (p.fromMe ?? 99) <= maxDist && levelOk(p) &&
      (p.why !== 'в прямой видимости' || (p.fromMe ?? 99) <= 5))
    if (!s) return
    const r = await act('mine_seen', { at: s.at, timeoutSeconds: 120 })
    if (r.status !== 'done' || died) return
  }
}

// Переплавить всё: уголь вперёд (8 предметов на кусок). Без угля smelt
// честно отказывает — доски он бережёт (keep 24 в containers.FUELS), брёвна
// тоже (8), — поэтому сначала добрать уголь, что видели, а нет — назвать
// дерево топливом явно (явное имя снимает запас).
// Глубокий путь до портала: плавить только на два ведра, огниво и щит — остальное железо лежит сырым до сборов после
// портала (ow-E3 02.10: плавка — 2.8 мин на прогон в этапе железа, жила давала 8–11 сырого при нужных 7; 10 с на слиток).
const ironToSmelt = () => {
  if (!(OW_DEEP && !known.portal)) return Infinity
  const noShield = !have('shield') && !(state.offHand && /shield/.test(JSON.stringify(state.offHand)))
  const need = 3 * Math.max(0, 2 - have(/bucket$/)) + (lighter() ? 0 : 1) + (noShield ? 1 : 0)
  return Math.max(0, need - have('iron_ingot'))
}
async function smeltAll (from, into, { fetchCoal = false, max = Infinity } = {}) {
  await refresh()
  if (!have(from) || max <= 0) return
  // Сколько всего должно стать «into» — с потолком max (глубокий путь: только нужное).
  const target = have(into) + Math.min(have(from), max)
  const left = () => Math.min(have(from), Math.max(0, target - have(into)))
  await unclutter()
  if (!have('furnace')) await ensureTable()
  // За углём по памяти — только внизу, где он рядом (у печи наверху mine_seen
  // повёл бы обратно в шахту).
  if (fetchCoal && have(/^(coal|charcoal)$/) * 8 < left()) {
    // Только ближний уголь: по имени mine_seen пошёл к углю за 160 блоков и
    // потратил полторы минуты на дорогу (2026-09-26).
    await mineSeenAll('coal_ore,deepslate_coal_ore', 24)
    if (have(/^(coal|charcoal)$/) * 8 < left()) await act('mine', { block: 'coal_ore,deepslate_coal_ore', count: 3, radius: 16, timeoutSeconds: 60 })
  }
  // Угля нет, а плавить много — сперва древесный уголь: бревно в печь, доски
  // топливом (1.5 предмета на доску) → уголь на 8 предметов (containers.FUELS:
  // coal/charcoal 8, дерево 1.5). Восемь сырого железа — полтора бревна вместо
  // шести. Топливо — доски, а не то же бревно: одно имя во входе и в топливе
  // печь не приняла («birch_log в печку не лёг», 2026-09-26), и все брёвна
  // ушли в огонь как есть.
  const inv = () => Object.keys(state.inventory || {})
  if (!have(/^(coal|charcoal)$/) && !have('lava_bucket') && left() >= 4 && have(LOGS) >= 5) {
    // Запас на глубину (reserve) — 4 бревна не жечь.
    const want = Math.min(Math.ceil(left() / 8), have(LOGS) - 4)
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
    // Ведро лавы — 100 предметов (FUELS: lava_bucket, только если назвать).
    const logK = inv().find(k => LOGS.test(k))
    const plankK = inv().find(k => /_planks$/.test(k))
    // Дерево — сверх запаса на глубину: 4 бревна и 8 досок остаются на
    // верстак и кирку (2026-09-26, 12:59: последнее дерево ушло в печь, и на
    // y=29 не из чего стало ни кирки, ни верстака).
    // Глубокий путь: железо на вёдра — главная дорога, запас дерева тут меньше (1 бревно, 2 доски, палки сверх 4):
    // ow-E1 02.10, слот 15 — 11 сырого железа, 2 бревна и 2 доски, «плавить нечем», этап железа встал на паузы.
    const keepLogs = OW_DEEP && from === 'raw_iron' ? 1 : 4
    const keepPlanks = OW_DEEP && from === 'raw_iron' ? 2 : 8
    if (OW_DEEP && from === 'raw_iron' && !coal && have(LOGS) <= keepLogs && have(/_planks$/) <= keepPlanks && have(LOGS) >= 1) {
      const p = planksFor(); if (p) await craft(p, 4)
    }
    const stickK = OW_DEEP && from === 'raw_iron' && have('stick') > 4 ? 'stick' : null
    const wood = have('lava_bucket') ? 'lava_bucket'
      : (logK && have(LOGS) > keepLogs) ? logK
        : (inv().find(k => /_planks$/.test(k)) && have(/_planks$/) > keepPlanks) ? inv().find(k => /_planks$/.test(k))
          : stickK
    if (!coal && !wood) { log(`плавить ${from} нечем: угля нет, а дерево — запас на глубину`); break }
    const r = await act('smelt', { item: into, count: left(), fuel: coal ? undefined : wood, timeoutSeconds: 400 })
    await refresh()
    if (r.status !== 'done' && !coal && !wood) break
  }
}

// Факелы без угля: древесный уголь из брёвен (два бревна в печь, доска
// топливом → два угля → восемь факелов). Угля на y=16 прошлый заход не видел
// ни разу, и все штреки шли в темноте.
async function lightUp () {
  await refresh()
  if (have('torch') >= 8 || have(/^(coal|charcoal)$/) >= 2) return torches()
  if (have(LOGS) < 4) return
  await unclutter()
  // Печь внизу крафтится из булыжника, а для неё нужен верстак: стол, забытый
  // наверху, срывал уголь, и штреки шли без факелов (2026-09-26).
  if (!have('furnace')) await ensureTable()
  if (have(/_planks$/) < 2) { const p = planksFor(); if (p) await craft(p, 4) }
  const plank = Object.keys(state.inventory || {}).find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k))
  if (plank) await act('smelt', { item: 'charcoal', count: 2, fuel: plank, timeoutSeconds: 90 })
  await torches()
}

// Факелы из угля: штрек и лесенка без света — это спавнер мобов за спиной.
async function torches () {
  await refresh()
  if (have('torch') >= 16 || have(/^(coal|charcoal)$/) < 2) return
  await sticks(2)
  await craft('torch', 8)
}

// 5. Вода в ведро: на обсидиан, от лавы и от падения.
defStage('water', () => have(/^bucket$/) > 0 && !have('water_bucket') && !known.portal, async () => {
  // Глубокий путь (ND_OW_DEEP): под землёй воду ищем здесь же — штреком, окно над источником за блоком (вода, как
  // и лава, вверх не течёт). Подъём наверх и назад к лаве — две лесенки по 3 с на уровень, а ночью наверху нора.
  await sense()
  if (OW_DEEP && !sit.surface && y() < 50) {
    // Свой колодец от поверхности рядом — штреков за водой меньше (2), дальше подъём им: поверху вода почти всегда видна.
    // Только если с устья перед спуском была видна вода (ow-P3 02.10, слот 13: подъём 21 → 85 без видимой воды —
    // «поверху не набралась», дальше поиск ночью поверху на 6 хп).
    const viaShaft = surfaceShaftNear() && !!shaftWaterSeen
    if (await deepWater({ legs: viaShaft ? 2 : 5 })) return
    if (viaShaft && !died && await waterViaShaft()) return
    // Не нашлась штреками — не наверх (ночью там нора и мобы, ow-E3: смерти на 2-й ночи поверху): вода ищется дальше
    // попутно в литье у дна (deepCast берёт её у штрека), этап воды отложен на 8 мин.
    // Третий пустой заход подряд — наверх (поверху вода почти всегда видна).
    if (!died && have(/bucket$/) >= 2 && ++waterDeepFails < 3) { waterDeepFailAt = Date.now(); log(`вода глубоко: штреками не нашлась (${waterDeepFails}-й раз) — ищу попутно у лавы, наверх не иду`); return }
  }
  for (let i = 0; i < 6 && !have('water_bucket'); i++) {
    await recoverGuard()
    if (died) return
    // Сначала там, где стою (подземные источники тоже годятся).
    const r = await act('bucket', { fluid: 'water', radius: 32 })
    if (have('water_bucket')) break
    if (r.detail && r.detail.need) break
    // Искать ходьбой — только поверху: explore и goto под землёй ведут по
    // пещерам, в темноту к мобам (кампания 2026-09-25).
    if (!(await toSurface())) break
    await nightGuard()
    const r2 = await act('bucket', { fluid: 'water', radius: 32 })
    if (have('water_bucket') || (r2.detail && r2.detail.need)) break
    const e = await act('explore', { block: 'water', radius: 48, stepDistance: 80, timeoutSeconds: 150 })
    if (!(e.detail && e.detail.found)) await walkAway(60, Math.PI / 4)
  }
})

// Огниво: кремень выпадает из гравия не всегда, поэтому гравия — горсть, а
// не три блока «если видно». Слиток на огниво spendIron держит в запасе.
// Поиск кремня — не больше двух заходов за запуск и трёх минут на заход:
// 2026-09-29 12:59–13:28 сборы полчаса плавали за гравием у дна реки, а в Ад
// теперь можно и без огнива (enterNether).
let flintTries = 0
async function ensureFlint () {
  if (have('flint_and_steel') || have('fire_charge')) return true
  if (flintTries >= 2) return false
  flintTries++
  const until = Date.now() + 180000
  // Гравий в рюкзаке — поставить и сломать, пока не выпадет кремень: 10% за
  // блок без удачи (loot_table/blocks/gravel.json, table_bonus [0.1, …] — jar
  // 1.21.11). 2026-09-27 (01:53) в Ад не пустили без огнива при 12 гравия.
  for (let k = 0; k < 30 && !have('flint') && have('gravel') && !died; k++) {
    const p = await act('place', { block: 'gravel' })
    if (p.status !== 'done') break
    await act('mine', { block: 'gravel', dry: true, count: 1, radius: 6, timeoutSeconds: 20 })
    await refresh()
  }
  for (let k = 0; k < 4 && !have('flint') && !died && Date.now() < until; k++) {
    // Бьют (урон прервал копку) или мало хп — прекратить: 2026-09-29 13:40
    // поиск гравия четырежды подряд звал mine под ударами, 18 → 6 хп.
    if ((state.health ?? 20) < 12) { log('кремень: мало хп — поиск гравия прекращаю'); break }
    const g = await act('mine', { block: 'gravel', dry: true, count: 8, radius: 40, timeoutSeconds: 60 })
    if (g.status === 'interrupted') { log('кремень: копку прервали — поиск гравия прекращаю'); break }
    if (!(g.detail && g.detail.dug)) {
      const e = await act('explore', { block: 'gravel', dry: true, radius: 48, stepDistance: 60, timeoutSeconds: 60 })
      if (!(e.detail && e.detail.found)) break
    }
  }
  // Слитка нет (последний ушёл на щит) — из сундука базы: 2026-09-27 (02:25) в
  // Ад не пустили без огнива при кремне в рюкзаке и слитках в сундуке у портала.
  if (have('flint') && !have('iron_ingot') && known.portal && portalFar() < 48) await act('chest_take', { item: 'iron_ingot', count: 1 })
  if (have('flint') && have('iron_ingot')) await craft('flint_and_steel')
  return have('flint_and_steel') > 0
}

// 5а. Портал литьём у лавы (cast.js) — без алмазов, как спидраннеры: два ведра,
// огниво, булыжник. Лава не видна — искать: разведка отрезками (поверху дёшево
// и далеко видно озёра и лавопады; под землёй pathfinder прокапывает ход, но
// жидкость не вскрывает — dontCreateFlow), дважды не нашлось — ниже: в пещерах
// под y=0 лава чаще всего (lake_lava_underground, лава в пещерах ниже -54).
// Не вышло за шесть заходов — этап отдыхает, и следующим нужным берутся алмазы:
// старый путь (обсидиан алмазной киркой) остаётся запасным.
let castRuns = 0
// Литьё поверху не нашло лавы — запасной путь (кирка → алмазы → обсидиан ведром у лавы глубоко). По A0–A4: литьё
// не удалось ни разу (≈40 прогонов, 281 ответ «не вижу лавы» из 380), поверхностные лавовые озёра 1.21.11 — 1 на
// 200 чанков (SPEEDRUN.md), а единственный вход в Ад (A1 слот 12) — через алмазы. Поэтому поверху — одна разведка
// (обзор 48 и два explore ≈ 5 мин), дальше литьё ждёт, пока лава не станет известна (штреки её называют).
let castSurfaceFailed = false

// Глубокое литьё (поток overworld, 02.10.2026; ND_OW_DEEP=1). Поверхностная лава в 1.21.11 редка (lake_lava_surface —
// 1 на 200 чанков, jar: worldgen/placed_feature), а у дна она есть почти всюду: водоносные пласты ниже y −54 заливают
// пещеры лавой (поверхность −55), карверы — ниже −56. Поэтому, если лавы поверху не видно и не помнится рядом, —
// лесенкой к −54 и штреками на этой высоте: штрек встаёт над лавой («лава на X (в 1 впереди)»), литьё открывает окно
// над источником (cast.openWindow — только блок над лавой, без жидкости по бокам) и льёт раму в штреке за 7+ блоков от
// лавы (keep 8: вода с ведра по ровному полу течёт на 7 клеток — Codex по байткоду WaterFluid), копая место до 64 клеток.
const OW_DEEP = process.env.ND_OW_DEEP === '1'
const OW_SHAFT = process.env.ND_OW_SHAFT !== '0'
// Слух — по умолчанию ВКЛ. (решение пользователя 03.10: «да, включай»); ND_OW_HEAR=0 — выкл.
const OW_HEAR = process.env.ND_OW_HEAR !== '0'
const DEEP_Y = -54
let deepLava = null // лава за блоком у штрека (чутьё безопасности) — ориентир окна
const deepBad = [] // лава, у которой окно или место не вышли
const near3 = (p, r) => !!p && !!state.pos && Math.hypot(p.x - state.pos.x, (p.y ?? y()) - state.pos.y, p.z - state.pos.z) <= r
// Лава поверху, ради которой не спускаться: видна или помнится в 96 блоках по горизонтали, не глубже y 0.
const surfaceLavaNear = () => !!known.lava && (known.lava.y ?? 64) >= 0 && !!state.pos && Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) <= 96
// Лава под небом для литья поверху (поток overworld 02.10 вечер). У дна лавы может не быть вовсе (ow-P3: 128×128 вокруг
// слота 12 — 4 клетки лавы на −55), а у хороших сидов поверхностное озеро или руины с лавой — в ~100–180 м. Утром,
// пока светло и тело наверху, — столб +10 своими блоками, survey портал-модуля (portal_natural, только чтение: лава
// под небом в 128, тело озера ≥ 12 открытых источников), столб долой. Видна — после вёдер подняться и лить у неё
// (portal_natural run, ND_PORTAL_NATURAL=1 в демоне); не видна — литьё глубоко, как было.
// ND_OW_LAVA_HINT={"x":..,"y":..,"z":..} — то же место из карты копии мира (скан сида), правило AGENTS.md о карте копии.
let skyLavaSeen = (() => { try { const h = process.env.ND_OW_LAVA_HINT ? JSON.parse(process.env.ND_OW_LAVA_HINT) : null; return h && Number.isFinite(h.x) ? { x: h.x, y: h.y, z: h.z, hint: true } : null } catch { return null } })()
const NATURAL = process.env.ND_PORTAL_NATURAL === '1'
let naturalTried = 0
let surveyDone = false
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
// К низу своего колодца — только штреками по осям (идут по прорытому, новое копают с чутьём), без goto: goto из
// тупика штрека «вылезает из ямы» вверх (escapePit, до 24 уровней) — ow-P4 02.10, слот 10: с y 16 на 27, гравий
// сверху, «suffocated in a wall» на 18-й мин.
async function toShaftColumn (S) {
  for (let k = 0; k < 3 && !died; k++) {
    await refresh()
    if (!state.pos) return
    const dx = S.x - Math.floor(state.pos.x)
    const dz = S.z - Math.floor(state.pos.z)
    if (!dx && !dz) return
    // Сначала по той оси, где расстояние больше (обычно это и есть свой штрек от колодца).
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
// Подняться своим колодцем (от поверхности одной колонной): к низу колонны — goto до соседней клетки, шаг штреком, вверх.
async function climbOwnShaft (why) {
  const S = surfaceShaft
  // Колонна должна кончаться на моей высоте (±3): иначе подъём — копка вверх сквозь породу (ow-P5 02.10, слот 11:
  // колонна 68 → 44 до пещеры, тело на y 16 — «до низа колодца не дошёл»).
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
// Литьё поверху у увиденной лавы: наверх (своим колодцем), portal_natural run с подсказкой места (без лучей).
async function naturalCast () {
  if (!NATURAL || !skyLavaSeen || naturalTried >= 1 || known.portal) return false
  naturalTried++
  await sense()
  if (!sit.surface && y() < 50) {
    if (!(await climbOwnShaft('литьё поверху'))) {
      // Своей колонны нет на этой высоте — наверх обычным подъёмом (survival.surface, ~2 с на уровень).
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

// Слух по пути (ND_OW_HEAR): подземные лавовые озёра (lake_lava_underground — 1 на 9 чанков, y ≥ 0, нижняя половина
// чаши — лава, верхняя — воздух) у штреков за железом и водой на y 16 — ближе, чем водоносная лава у дна. ow-P3 02.10,
// слот 12: 12 штреков по 32 на −54 за 18 мин без лавы — замер вокруг (128×128, y −55…−62): лавы 4 клетки, у дна сплошной
// сланец. Услышанное — направление, дальность и высота от места, где слышал (cast.hearLava); литьё идёт к нему до спуска.
let heardLava = null
async function listenForLava (where) {
  if (heardLava && Date.now() - heardLava.t < 20 * 60000 && near3(heardLava.from, 32)) return
  const h = await act('portal', { mode: 'cast', listen: 16, timeoutSeconds: 30 })
  const heard = h.detail && Array.isArray(h.detail.heard) && h.detail.heard[0]
  if (!heard || !state.pos) return
  heardLava = { ...heard, from: { x: Math.floor(state.pos.x), y: Math.floor(state.pos.y), z: Math.floor(state.pos.z) }, t: Date.now() }
  log(`слышу лаву (${where}): ${heard.dir}, ~${heard.dist} бл., высота ${heard.height ?? '?'} — запомнил для литья`)
}
// К услышанной по пути лаве: вернуться туда, где слышал, подойти по оценке (сторона × flat, высота), оглядеться.
async function toHeardLava () {
  const H = heardLava
  heardLava = null
  if (!H || !state.pos || Date.now() - H.t > 30 * 60000 || !near3(H.from, 96)) return null
  log(`литьё: к лаве, услышанной у ${H.from.x},${H.from.y},${H.from.z} (${H.dir}, ~${H.dist} бл.)`)
  if (!near3(H.from, 3)) await act('goto', { x: H.from.x, y: H.from.y, z: H.from.z, range: 2, timeoutSeconds: 90 })
  if (died || !near3(H.from, 6)) return null
  const v = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }[H.dir] || [0, 0]
  const flat = H.flat || 0
  const dy = Number.isFinite(H.height) ? H.height : 0
  const T = { x: Math.round(state.pos.x + v[0] * flat), y: Math.round(state.pos.y + 1.62 + dy), z: Math.round(state.pos.z + v[1] * flat) }
  // Почти на своей высоте — штрек в её сторону (встанет у лавы и назовёт её); иначе подход pathfinder'ом к оценке.
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
  // Лава уже известна рядом (штрек за железом или водой встал у неё, видна в пещере) — литьё у неё, без спуска.
  if (deepLava && !near3(deepLava, 48)) deepLava = null
  // Лава, услышанная по пути (штреки на y 16), — сперва к ней.
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
  // Лесенка по пути встала у лавы (её место запомнил act) — она и есть ориентир.
  if (!deepLava && known.lava && near3(known.lava, 10) && !deepBad.some(q => Math.hypot(q.x - known.lava.x, q.y - known.lava.y, q.z - known.lava.z) < 6)) deepLava = known.lava
  // descend кончает на 2 выше цели: штрек — ровно на −54 (ноги), над поверхностью водоносной лавы −55, иначе он
  // проходит над озером под двумя блоками сланца и его не замечает.
  if (!deepLava && y() > DEEP_Y && y() <= DEEP_Y + 12) {
    const d = await act('dig_down', { mode: 'stairs', depth: Math.round(y() - DEEP_Y), torchEvery: 0, timeoutSeconds: 120 })
    const lv = /лава (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String((d.detail && d.detail.stopped) || ''))
    if (lv) deepLava = { x: +lv[1], y: +lv[2], z: +lv[3] }
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
  // Слух без «пинг-понга» (ow-E3 02.10, слот 8: 30 штреков по 7 бл. восток-запад за 2 мин — лава «~8 бл., выше»
  // между концами, штрек на −54 проходит под ней): лава выше/ниже или сторона сменилась на обратную на месте —
  // дойти к ней по оценке места (сторона, дальность, высота), раз на заход; не вышло — слух молчит два штрека.
  let lastHeard = null
  let hearOff = 0
  let upTried = 0
  for (let i = 0; i < 10 && !known.portal && !died; i++) {
    await recoverGuard()
    if (died) return
    await unclutter()
    await spares(200)
    if (deepLava && near3(deepLava, 8)) {
      // Лава есть, воды нет (этап воды отложен — ищу попутно): вода штреками здесь же, у дна, потом литьё.
      if (!have('water_bucket') && have(/^bucket$/)) {
        const lavaKeep = deepLava
        log('литьё глубоко: лава рядом, ведро воды пустое — вода штреками отсюда')
        await deepWater()
        if (died) return
        if (!have('water_bucket')) {
          // Один поиск воды на заход (Codex ow-review1: иначе до 10 вызовов deepWater по 5 штреков за один заход литья).
          waterDeepFailAt = Date.now()
          log('литьё глубоко: воды у дна не нашёл — заход кончаю, без повторных штреков')
          return
        }
        if (!near3(lavaKeep, 8)) await act('goto', { x: lavaKeep.x, y: lavaKeep.y + 1, z: lavaKeep.z, range: 3, timeoutSeconds: 90 })
        deepLava = lavaKeep
      }
      const r = await act('portal', { mode: 'cast', windows: true, hint: deepLava, maxDig: 64, keep: 8, radius: 12, timeoutSeconds: 540 })
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
      if (/не вижу лавы|места под раму|лава далеко|расчистить место/.test(why)) {
        log(`литьё глубоко: у лавы ${deepLava.x},${deepLava.y},${deepLava.z} не вышло (${why.slice(0, 120)}) — штрек дальше`)
        deepBad.push(deepLava)
        deepLava = null
        dir = (dir + 1) % 4
      }
      // Иначе недолито (время, клетка) — следующий заход продолжит ту же раму.
      continue
    }
    deepLava = null
    // Штрек сползает вверх (обход препятствия) — вернуть ноги на −54: на −52 пол над лавой −55 в два блока, и штрек
    // её не замечает (ow-E1 слот 9: 14 штреков на −52, лавы нет).
    if (y() > DEEP_Y && y() <= DEEP_Y + 6) await act('dig_down', { mode: 'stairs', depth: Math.round(y() - DEEP_Y), torchEvery: 0, timeoutSeconds: 90 })
    // Ниже −54 (лесенка, колодец) — наверх на −54 своим колодцем: ниже лава сбоку, окна к ней нет.
    if (y() < DEEP_Y - 0.5) await act('tunnel', { direction: 'up', length: 8, toY: DEEP_Y, timeoutSeconds: 40 })
    if (died) return
    // Слух (ND_OW_HEAR=1): лава с воздухом над ней в 16 бл. «булькает» — штрек в её сторону и на её дальность
    // (cast.hearLava: только сторона света и дальность, как у человека по звуку).
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
        // Высота — отдельным полем слуха (cast.hearLava height), не sqrt двух округлённых дальностей.
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
        // Обратно на −54, если подъём увёл выше.
        if (y() > DEEP_Y && y() <= DEEP_Y + 12) await act('dig_down', { mode: 'stairs', depth: Math.round(y() - DEEP_Y), torchEvery: 0, timeoutSeconds: 90 })
      }
      else if (heard && (heard.above || flip)) {
        // Подходы по слуху кончились — та же лава снова «выше»/«с обратной стороны»: не мотаться, новая сторона.
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
        // Булькает прямо внизу — колодцем к ней (он встанет у лавы и назовёт место). Не ниже −54: водоносная лава —
        // ниже −54, и ниже этого уровня тело оказывается сбоку от неё, а не над ней — окно к источнику не открыть
        // (ow-P3 02.10, слоты 9 и 15: на −57 «лава в 1 впереди сверху», литьё «не вижу лавы-источника», круги).
        if (heard.below && (heard.flat || 0) <= 2 && y() > DEEP_Y + 0.5) {
          const sh = await act('tunnel', { direction: 'down', length: Math.max(1, Math.min(8, heard.dist + 1, Math.floor(y() - DEEP_Y))), timeoutSeconds: 60 })
          const lv = /лава (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String((sh.detail && sh.detail.stopped) || ''))
          if (lv) { deepLava = { x: +lv[1], y: +lv[2], z: +lv[3] }; log(`литьё глубоко: колодец встал у лавы ${lv[1]},${lv[2]},${lv[3]}`); continue }
        }
        // Внизу и в стороне — лесенкой вниз в её сторону: лесенка встаёт у лавы и называет место (ow-P1 02.10, слот 14:
        // «north, ~10 бл., ниже» — штрек на −54 шёл над ней, упёрся в обсидиан и крутился на месте).
        if (heard.below && (heard.flat || 0) > 2 && y() > DEEP_Y + 1.5) {
          const dy = Number.isFinite(heard.height) ? Math.abs(heard.height) : Math.round(Math.sqrt(Math.max(0, (heard.dist || 0) ** 2 - (heard.flat || 0) ** 2)))
          const st = await act('dig_down', { mode: 'stairs', depth: Math.max(1, Math.min(8, dy + 1, Math.floor(y() - DEEP_Y))), direction: heard.dir, torchEvery: 0, timeoutSeconds: 120 })
          const lv = /лава (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String((st.detail && st.detail.stopped) || ''))
          if (lv) { deepLava = { x: +lv[1], y: +lv[2], z: +lv[3] }; log(`литьё глубоко: лесенка встала у лавы ${lv[1]},${lv[2]},${lv[3]}`); continue }
        }
      }
    }
    const t = await act('tunnel', { direction: dirs[dir], length: len, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    if (died) return
    if (await mobInTheWay(t)) continue
    const why = String((t.detail && t.detail.stopped) || t.error || '')
    // Штрек не пошёл вовсе (обсидиан или руда не по кирке впереди) — та же сторона даст тот же отказ: повернуть, слух
    // на ход выключить (ow-P1 слот 14: 30 одинаковых «для obsidian нужна кирка получше» за 3 с).
    if (t.status === 'failed' && !((t.detail && t.detail.walked) > 0)) { log(`литьё глубоко: штрек на ${dirs[dir]} не идёт (${why.slice(0, 80)}) — поворачиваю`); dir = (dir + 1) % 4; hearOff = Math.max(hearOff, 1); lastHeard = null; continue }
    const lava = /лава на (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    if (lava) {
      const p = { x: +lava[1], y: +lava[2], z: +lava[3] }
      if (!deepBad.some(b => Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) < 6)) { deepLava = p; log(`литьё глубоко: штрек встал у лавы ${p.x},${p.y},${p.z}`); continue }
    }
    // Штрек у дна встал у воды, а ведро воды ещё не набрано (этап воды наверху не нашёл, или его пропустили ночью) —
    // набрать здесь же: окно/стенка и черпак (cast waterHint + obsidian.breachWall).
    const wetHere = /вода на (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    if (wetHere && !have('water_bucket') && have(/^bucket$/)) {
      await act('portal', { mode: 'cast', waterHint: { x: +wetHere[1], y: +wetHere[2], z: +wetHere[3] }, timeoutSeconds: 120 })
      if (have('water_bucket')) log(`литьё глубоко: вода у штрека ${wetHere[1]},${wetHere[2]},${wetHere[3]} — ведро полное`)
    }
    // Штрек встал на месте (опасность впереди, не лава/вода) — повернуть и слух на ход выключить.
    if (t.detail && t.detail.stopped && !(t.detail.walked > 0) && !(t.detail.dug > 0)) { dir = (dir + 1) % 4; hearOff = Math.max(hearOff, 1); lastHeard = null; continue }
    // Кремень — из гравия в стенах (огнива нет — отлитую раму нечем зажечь).
    if (!lighter() && !have('flint')) await act('mine', { block: 'gravel', dry: true, count: 6, radius: 16, timeoutSeconds: 45 })
    if (!lighter() && have('flint') && have('iron_ingot')) await craft('flint_and_steel')
    // Лава на виду (штрек вскрыл пещеру с лавовым дном).
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
    // Штрек встал не на лаве (вода, бедрок, моб, пещера) — повернуть; прошёл весь — дальше тем же курсом.
    if (why) dir = (dir + 1) % 4
  }
}

let waterDeepFails = 0
let surfaceShaft = null // колодец глубокого пути от поверхности одной колонной: { x, z, top, bottom }
let shaftWaterSeen = null // вода, видная с устья этого колодца перед спуском
let waterDeepFailAt = 0 // глубокий путь: вода штреками не нашлась — этап воды ждёт, вода — попутно в литье
let knownWater = null // вода под землёй, у которой вставали или которую видели (глубокий путь)
const surfaceShaftNear = () => !!surfaceShaft && !!state.pos && dim() === 'overworld' && Math.hypot(surfaceShaft.x - state.pos.x, surfaceShaft.z - state.pos.z) <= 64 && y() < surfaceShaft.top - 8 && Math.abs(y() - surfaceShaft.bottom) <= 3
// Вода поверху через свой колодец (ow-P1 02.10: у дна и на y 16 воды не нашлось в 2 из 8 прогонов, а наверху она была
// видна с устья). Дойти до низа колодца, подняться им (tunnel up, 0.6 с на уровень — лаборатория 02.10: 40 уровней за
// 25 с), зачерпнуть рядом с устьем или у видимой перед спуском воды. Обратно вниз — следующий этап (литьё у дна).
async function waterViaShaft () {
  const S = surfaceShaft
  if (!S || have('water_bucket') || !have(/^bucket$/)) return false
  // Столб под ноги — по блоку на уровень: не хватит наполнителя — подъём встанет на полпути.
  if (have(COBBLE) + have(/^(dirt|andesite|diorite|granite|tuff|cobbled_deepslate)$/) < S.top - S.bottom + 4) { log('вода: на подъём колодцем не хватит блоков'); return false }
  log(`вода: штреками нет — поднимаюсь своим колодцем ${S.x},${S.z} (${S.bottom} → ${S.top}), поверху черпаю`)
  // К низу колодца: goto — до соседней клетки (в саму клетку колонны pathfinder не входит: лаборатория 02.10 —
  // «застрял на air у stone» в 1 бл. за 68 с), последний шаг — штреком по оси (идёт по прорытому, 16 бл. за 5.5 с).
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
  // Известная вода рядом — к ней и окно/черпак у неё.
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
    // Слух (ND_OW_HEAR=1): ручей (текущая вода) шумит до 16 бл. — штрек в его сторону.
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
      // Штрек встал за 2–3 клетки от воды («в 2 впереди»), и из забоя источник не виден — ещё шаг штреком туда же
      // (он сам встанет вплотную) и снова черпак; стенку между забоем и водой черпак ломает сам (obsidian.breachWall).
      // Раньше — поворот штрека прочь от найденной воды (лаборатория ow-W1–W3 02.10: 0/2 → 3/3).
      if (!have('water_bucket') && /не вижу источника/.test(String((w.detail && w.detail.stopped) || ''))) {
        const closer = await act('tunnel', { direction: dirs[dir], length: 3, torchEvery: 0, timeoutSeconds: 60 })
        if (died) return false
        // Повтор черпака — только если штрек сдвинулся (Codex: та же опасность впереди останавливает его до удара).
        if (((closer.detail && closer.detail.walked) || 0) > 0) w = await act('portal', { mode: 'cast', waterHint: hint, timeoutSeconds: 120 })
      }
      if (have('water_bucket')) { log(`вода глубоко: окно у ${wet[1]},${wet[2]},${wet[3]} — ведро полное`); break }
      log(`вода глубоко: у ${wet[1]},${wet[2]},${wet[3]} не набралась (${String((w.detail && w.detail.stopped) || w.error || '').slice(0, 160)})`)
    }
    // Лава у штрека — запомнить для литья (глубокое литьё начнёт с неё).
    const lava = /лава на (-?\d+),(-?\d+),(-?\d+)/.exec(why)
    if (lava && !deepLava) deepLava = { x: +lava[1], y: +lava[2], z: +lava[3] }
    if (why) dir = (dir + 1) % 4
  }
  return have('water_bucket') > 0
}

defStage('cast', () => !known.portal, async () => {
  castRuns++
  let blocksTried = false
  let surfaceLooks = 0
  await sense()
  if (weakAndHungry()) { log(`хп ${Math.round(state.health ?? 0)} и еды нет — к лаве не иду, сначала охота`); return }
  if (OW_DEEP) {
    await readMemory()
    // Лава под небом видна со столба (или из карты копии мира) — литьё поверху у неё, раньше спуска к дну.
    if (skyLavaSeen && NATURAL && naturalTried < 1) { if (await naturalCast()) return; if (died) return }
    if (!known.lava && sit.surface) await act('observe', { radius: 64 })
    // Лава под землёй рядом (видели из штрека) — глубокое литьё у неё, без спуска к −54.
    if (!deepLava && known.lava && !sit.surface && near3(known.lava, 48) && !deepBad.some(b => Math.hypot(b.x - known.lava.x, b.y - known.lava.y, b.z - known.lava.z) < 6)) deepLava = known.lava
    if (deepLava || !surfaceLavaNear()) { await deepCast(); return }
  }
  // Из норы лавы не видно: 2026-09-26 (11:07) этап начался в закрытой норе в
  // девяти блоках от лавы, литьё ответило «не вижу лавы», и разведка увела
  // тело на 90 блоков прочь. Сначала наружу и оглядеться — act запомнит лаву —
  // и к ней, если она дальше досягаемости литья.
  if (!sit.surface && dim() === 'overworld' && !sit.night) await act('shelter', { mode: 'exit' })
  await readMemory()
  if (!known.lava) await act('observe', { radius: 48 })
  if (known.lava && state.pos && Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) > 16) await goToward(known.lava, 8)
  await ensureFlint()
  for (let i = 0; i < 6 && !known.portal; i++) {
    await recoverGuard()
    if (died) return
    await sense()
    if (sit.night && sit.surface && dim() === 'overworld') { await nightGuard(); continue }
    await unclutter()
    const r = await act('portal', { mode: 'cast', timeoutSeconds: 540 })
    await readMemory()
    if (known.portal || died) break
    const why = String((r.detail && r.detail.stopped) || r.error || '')
    // Блоков на углы, столбы и подпорки не хватает (need cobblestone) — набрать булыжник здесь же и лить снова:
    // ни один этап его не добирает, и литьё уходило в паузы до сторожа (fresh-A3 слот 11, 30.09: «нужно блоков
    // 10» при 13 земли в рюкзаке).
    const needWhat = String((r.detail && r.detail.need && r.detail.need.what) || '')
    if (/cobblestone|stone/.test(needWhat) && !blocksTried && have(PICK_STONE)) {
      blocksTried = true
      const want = Math.max(12, Number(r.detail.need.count) || 10) + 4
      await act('mine', { block: 'stone', count: want, radius: 32, timeoutSeconds: 150 })
      if (have(COBBLE) < want) await act('dig_down', { mode: 'stairs', depth: 8, torchEvery: 0, timeoutSeconds: 180 })
      continue
    }
    if (r.detail && r.detail.need) break
    if (/не вижу лавы/.test(why)) {
      // Видел её раньше — сначала туда (отрезками по 64, как ходит директор).
      // Расстояние — с высотой: лава в пещере под штреком «в 10 блоках по горизонтали» не видна из него.
      if (known.lava && state.pos && Math.hypot(known.lava.x - state.pos.x, (known.lava.y ?? y()) - state.pos.y, known.lava.z - state.pos.z) > 12 && i < 3) {
        await goToward(known.lava, 8)
        continue
      }
      // Глубоко (y < 0) разведка ходьбой лавы не видит — кругом порода (fresh-A1 30.09, слоты 5 и 12: на y −53..−56
      // explore «не нашёл» 13 минут подряд с алмазной киркой). Лава тут — в пещерах ниже −54 (карверы 1.18+):
      // вскрывать штреком, он встаёт у лавы и называет её место (act запоминает), дальше — к ней.
      if (y() < 0) {
        await spares(120)
        await act('tunnel', { direction: ['north', 'east', 'south', 'west'][i % 4], length: 32, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
        if (!known.lava) await act('observe', { radius: 32 })
        continue
      }
      const e = await act('explore', { block: 'lava', radius: 48, stepDistance: 60, timeoutSeconds: 150 })
      if (e.detail && e.detail.found) continue
      // Сперва поверху (решение пользователя 30.09: литьё у лавы на поверхности — путь спидраннеров) — два захода
      // разведки; не нашлась — запасной путь через алмазы (castSurfaceFailed), а не штреки на −50 выше слоя лавы.
      if (++surfaceLooks >= 2 && !known.lava) {
        castSurfaceFailed = true
        log('литьё: поверху лавы нет (обзор и две разведки) — запасной путь: железная кирка, алмазы, обсидиан ведром у лавы глубоко')
        return
      }
      continue
    }
    // Лава видна, а места у неё нет — отойти и искать место оттуда.
    if (/места под раму/.test(why)) { await walkAway(12, Math.PI / 2); continue }
    // Недолито (время, клетка не вышла) — следующий заход продолжит ту же раму.
  }
})

// 6. Алмазы: вниз к y≈-54, штреки, алмазная кирка.
defStage('diamond', () => !have(PICK_DIAMOND) && !known.portal, async () => {
  // Штреки — на −57: алмазы 1.21.11 гуще всего у дна, а лава карверов — только ниже −56 (SPEEDRUN.md): на −50
  // штрек обсидианового этапа 20 мин не видел лавы (fresh-A4 слоты 11 и 13), на −57 он в неё упирается и называет.
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
    // Алмаз стоит дороги подальше (48), но не похода по чужим тёмным штрекам.
    await mineSeenAll('deepslate_diamond_ore,diamond_ore', 48)
    if (!known.lava && !known.portal) await act('observe', { radius: 32 })
    await act('mine', { block: 'deepslate_diamond_ore,diamond_ore', count: 6, radius: 32, timeoutSeconds: 180 })
    if (have('raw_iron') + have('iron_ingot') < 8) await mineSeenAll('deepslate_iron_ore,iron_ore', 24)
    // Золото на шлем от пиглинов — тут же, рядом со штреком.
    if (have(/^(raw_gold|gold_ingot)$/) < 5) await mineSeenAll('deepslate_gold_ore,gold_ore', 24)
    await torches()
    if (t.detail && t.detail.need) break
  }
  if (have('diamond') >= 3) {
    await sticks(2)
    await craft('diamond_pickaxe')
  }
})

// 7. Обсидиан: лава на глубине, вода из ведра, алмазная кирка.
defStage('obsidian', () => have('obsidian') < 10 && !known.portal, async () => {
  // Сырьё переплавить здесь же, у лавы: ведро лавы — топливо на 100 предметов
  // (containers.FUELS), пустое ведро печь возвращает (restFuel → takeFuel).
  // Железо — в броню (spendIron), золото — на шлем от пиглинов.
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
    // Лавы не видно — штрек, пока не вскроем.
    if (/лав/.test(why) || /не вижу/.test(why) || !(r.detail && r.detail.got)) {
      await unclutter()
      await act('tunnel', { direction: ['north', 'east', 'south', 'west'][i % 4], length: 32, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    }
  }
})

// 8. Портал: огниво, наверх, рама.
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

// 7а. Маршрут спидраннера по знанию карты (поток route, 03.10.2026; ND_ROUTE=1, по умолчанию выкл. до замера).
// План — daemon/src/route.js по сиду мира (ND_WORLD_SEED: ферма — farm/slots.json через сцену; основной мир — level.dat):
// постройки по seedtool (руины, деревня, клад, корабль), лава по скану копии этого же мира (good-v2: видимая сверху —
// литьё поверху portal_natural; в пещере — вниз к ней и литьё с окнами), руда на виду — farm/route-scan (если есть).
// Знание карты из копии этого же мира — правило AGENTS.md. Шаг пишет «МАРШРУТ шаг <id> ok|НЕ ВЫШЕЛ за N с (бюджет B)»;
// провал — шаг в avoid и новый план с того места и рюкзака; план кончился без портала — дальше обычные этапы.
const ROUTE = process.env.ND_ROUTE === '1'
const routeMod = (() => { try { return require('./src/route') } catch (e) { return null } })()
let routeInfoV
let routeDone = false
let routeT0 = 0
let routeStructureSeconds = 0
const routeAvoid = new Set()
// ND_ROUTE_SKIP=wood,stone,… — шаги, которые считать сделанными (лаборатория отрезка: набор выдан, сразу к лаве).
const routeDoneIds = new Set(String(process.env.ND_ROUTE_SKIP || '').split(',').map(x => x.trim()).filter(Boolean))
const routeFails = new Map()
function routeInfoGet () {
  if (routeInfoV === undefined) routeInfoV = (ROUTE && routeMod && process.env.ND_WORLD_SEED) ? routeMod.routeInfo(process.env.ND_WORLD_SEED) : null
  return routeInfoV
}
const rlog = line => log(`МАРШРУТ ${line}`)
const fillerCount = () => have(/^(cobblestone|cobbled_deepslate|dirt|stone|deepslate|andesite|diorite|granite|tuff|netherrack|blackstone|basalt)$/)
// Дойти до точки маршрута (по XZ), с обходом (goToward) и сторожем ночи.
async function routeGo (at, range = 12) {
  if (!at || !state.pos) return false
  await sense()
  // Ночь наверху — не пережидать (правило пользователя): идти дальше отрезками без норы, пока хп ≥ 10 (rt-R4 слот 14:
  // «3-я нора за ночь — жду утра» 10 мин у самой лавы, потом литьё 23 с и вход на 22.6 мин вместо ~12).
  // В воде (яма с водой, река) — сперва на берег: подъём из воды «на сухой берег не вышел» крутился на месте (rt3-A3 слот 9).
  if (sit.inWater) { await leaveWater(); await sense(); if (sit.inWater && process.env.ND_ROUTE_SHORE !== '0') return false }
  if (!sit.surface && !(await toSurface())) return false
  await sense()
  // Ночь, а кровать есть — сперва сон (секунды), потом путь при свете (раунд 3: ночью путь без кровати — смерти).
  if (sit.night || sit.dusk) { await routeSleep('перед переходом'); await sense() }
  // Аванпост на прямой — обход сбоку (пиллагеры бьют с 15+ бл.).
  await routeAroundOutpost(at)
  if (sit.night && (state.health ?? 20) >= 10) {
    const okN = await routeGoPush({ x: at.x, z: at.z }, range)
    await refresh()
    return okN || (!!state.pos && Math.hypot(at.x - state.pos.x, at.z - state.pos.z) <= range + 8)
  }
  const ok = await goToward({ x: at.x, z: at.z }, range)
  await refresh()
  return ok || (!!state.pos && Math.hypot(at.x - state.pos.x, at.z - state.pos.z) <= range + 8)
}
// Последний переход к лаве — без ночёвки: всё для портала с собой, литьё одним ведром ~30 с, а в Аду ночи нет. Нора у
// цели ночью (nightGuard в goToward) стоила смерти (rt-R3 слот 14: «в нору до рассвета» у воды — утонул на 12-й мин).
// Отрезки по 64 с обходом, как goToward, но без сторожа ночи (сам сторож — дело survival, его не трогаю).
// Record only a measured vertical descent, never the requested length.
function routeShaftBackOn () { return process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_SHAFT_BACK !== '0' }
function routeRememberShaft (from, extend = false) {
  if (!routeShaftBackOn()) return
  const next = require('./src/movement').shaftFromDescent(from, state.pos)
  if (!extend) { surfaceShaft = next; return }
  const old = surfaceShaft
  surfaceShaft = old && next && old.x === next.x && old.z === next.z && Math.abs(old.bottom - next.top) <= 1
    ? { ...old, bottom: next.bottom } : null
}
async function routeReturnShaft (why) {
  try { if (!sit.surface && !(await climbOwnShaft(why))) await toSurface() }
  finally { if (routeShaftBackOn()) surfaceShaft = null }
}
async function routeGoPush (at, range = 10) {
  const detour = [0, 0.5, -0.5, 1.0, -1.0]
  let turn = 0
  for (let k = 0; k < 10 && !died; k++) {
    await refresh()
    if (!state.pos) return false
    const dx = at.x - state.pos.x; const dz = at.z - state.pos.z
    const far = Math.hypot(dx, dz)
    if (far <= range + 2) return true
    const a = Math.atan2(dz, dx) + detour[turn % detour.length]
    const step = Math.min(64, far)
    const leg = far <= 64 && !turn ? { x: at.x, z: at.z } : { x: Math.round(state.pos.x + Math.cos(a) * step), z: Math.round(state.pos.z + Math.sin(a) * step) }
    const r = await act('goto', { x: leg.x, z: leg.z, range: far <= 64 && !turn ? range : 6, timeoutSeconds: 60 })
    turn = r.status === 'done' ? 0 : turn + 1
    if (turn >= detour.length) return false
  }
  return !!state.pos && Math.hypot(at.x - state.pos.x, at.z - state.pos.z) <= range + 8
}
// Блоки на литьё (углы, подпорки, столб обзора portal_natural): 24 любого «твёрдого» наполнителя.
function routeBlockTarget (legacy = 24) {
  return process.env.ND_ROUTE === '1' && process.env.ND_ROUTE_QUOTAS !== '0' && routeMod.BUCKETS() === 1 ? 12 : legacy
}
async function routeBlocks (want = 24) {
  for (let i = 0; i < 3 && fillerCount() < want && !died; i++) {
    // Камень — ближний (16, не 24) и без упрямства: урон в забое — хватит (rt-R6 слот 27: за 22 блоками в тёмную пещеру
    // дважды, хп 15 → 3, смерть на 6-й мин; литьё и так добирает блоки расчисткой места).
    await refresh()
    if ((state.health ?? 20) < 12) { rlog(`блоки: хп ${state.health} — за камнем не лезу`); break }
    // Без камня под водой (dry): у озера литья забой уходил под воду — утонул (rt3-V2 слоты 14, 20 на 7-й и 13-й мин).
    const m = await act('mine', { block: 'stone', count: want - fillerCount(), radius: 16, dry: true, timeoutSeconds: 75 })
    if (fillerCount() >= want) break
    if (m.code === 'DAMAGE' || m.status === 'interrupted') { rlog(`блоки: ${m.code || m.status} в забое — хватит (${fillerCount()})`); break }
    // Камня не видно (берег озера, равнина) — дёрн и земля: блок дёрна даёт землю.
    if (!(m.detail && m.detail.dug)) await act('mine', { block: 'grass_block,dirt,coarse_dirt', count: want - fillerCount(), radius: 16, timeoutSeconds: 60 })
  }
  return fillerCount() >= Math.min(want, 12)
}
// Hunger values from the local Java 1.21.11 food data; raw food is
// deliberately excluded from the ready-to-eat reserve.
const ROUTE_COOKED_HUNGER = { cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6,
  cooked_chicken: 6, cooked_salmon: 6, cooked_cod: 5, cooked_rabbit: 5,
  bread: 5, baked_potato: 5, golden_carrot: 6 }
function routeCookedHunger () {
  return Object.entries(ROUTE_COOKED_HUNGER).reduce((n, [k, value]) => n + have(k) * value, 0)
}
function routeCookHunger () {
  if (process.env.ND_ROUTE !== '1' || known.portal || process.env.ND_ROUTE_COOK_RESERVE === '0' ||
      !Number.isFinite(state.health) || !Number.isFinite(state.food) || state.health < 16 || state.food <= 6) return Infinity
  return Math.max(12, 20 - state.food + 4)
}
// Еда из рюкзака: сено → пшеница → хлеб, сырое — в печь.
// cook — false у портала: жарка без угля копала камень на печь у самого горящего портала, а вход потом шёл сквозь огонь
// (rt3-V3 слот 19: портал на 9.6-й мин, «mine stone 8» на печь, сгорел на входе). Сырое мясо (кроме курицы) едят и так.
async function routeFood ({ cookRaw = true } = {}) {
  await refresh()
  if (have('hay_block')) await craft('wheat', have('hay_block') * 9)
  if (have('wheat') >= 3) await craft('bread', Math.floor(have('wheat') / 3))
  if (cookRaw && have(RAW) && (have('furnace') || have(/^(coal|charcoal)$/))) await cook({ reserveHunger: routeCookHunger() })
  await refresh()
}
// Охота по пути: звери на виду в r бл. (по высоте ±6), до limitS с, без прогулок за горизонт.
async function routeHunt (r = 40, limitS = 60) {
  await sense()
  if (!sit.surface || (state.health ?? 20) < 10) return
  const until = Date.now() + limitS * 1000
  hunting = true
  try {
    for (let k = 0; k < 4 && Date.now() < until && foodUnits() < 8 && !died; k++) {
      const o = await act('observe', { radius: 48 })
      const ents = (o.detail && o.detail.entities) || []
      // Кровати нет — овцы первыми: ночь (~10-я мин) в кровати — 10 с, без неё — нора и работа внизу.
      const woolWant = !have(/_bed$/) && have(/_wool$/) < 3
      const all = ents.filter(e => /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(String(e.name || '').toLowerCase()) &&
        (e.dist ?? 99) <= r && !(e.pos && Math.abs(e.pos.y - y()) > 6)).sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99))
      const prey = (woolWant && all.find(e => /^sheep$/i.test(e.name))) || all[0]
      if (!prey) break
      if ((prey.dist ?? 0) > 20 && prey.pos) await act('goto', { x: prey.pos.x, z: prey.pos.z, range: 6, timeoutSeconds: 25, surface: 'strict' })
      const sheep = /^sheep$/i.test(prey.name)
      const f = await act('fight', { target: String(prey.name).toLowerCase(), timeoutSeconds: 25, retreatAtHealth: 0, purpose: sheep && woolWant ? 'resource' : 'food', ...(sheep && woolWant ? { resourceGoal: { item: 'wool', count: 3 } } : {}) })
      if (f.status !== 'done') break
    }
  } finally { hunting = false }
  await refresh()
  if (have(RAW)) await cook({ reserveHunger: routeCookHunger() })
  await makeBed()
}
// Вода в ведро перед литьём одним ведром (без неё каждая лава «не вышла» и уходила в avoid — rt-R3 слот 28: три пещерные
// лавы подряд «нет воды в ведре»): видимая в 48 → вода из скана копии в 250 м (ближняя к телу или к лаве) → разведка.
async function routeWater (near) {
  if (have('water_bucket') || have('lava_bucket')) return true
  if (!have('bucket')) return false
  const r0 = await act('bucket', { fluid: 'water', radius: 48 })
  if (have('water_bucket')) return true
  void r0
  const info = routeInfoGet()
  const ws = (info && info.ores && info.ores.water) || []
  const me = state.pos
  const cand = ws.filter(w => me && Math.hypot(w.x - me.x, w.z - me.z) <= 250 && !(routeMod.outpostNear && routeMod.outpostNear(info, w, 8)))
    .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) + (near ? Math.hypot(a.x - near.x, a.z - near.z) : 0) - Math.hypot(b.x - me.x, b.z - me.z) - (near ? Math.hypot(b.x - near.x, b.z - near.z) : 0))
  // Разные места берега (≥ 8 бл. друг от друга и от тела): у одного места «черпак мимо» шёл по всем 6 источникам подряд
  // (rt3-A6 слот 20) — повтор того же места не помогает.
  const picks = []
  for (const w of cand) { const st0 = w.stand || w; if (Math.hypot(st0.x - me.x, st0.z - me.z) > 4 && picks.every(q => Math.hypot((q.stand || q).x - st0.x, (q.stand || q).z - st0.z) >= 8)) picks.push(w); if (picks.length >= 3) break }
  for (const w of picks) {
    const st = w.stand || w
    await routeGo(st, 3)
    await act('goto', { x: st.x, y: st.y, z: st.z, range: 1, timeoutSeconds: 30 })
    await act('bucket', { fluid: 'water', radius: 16 })
    if (have('water_bucket')) { rlog(`вода по карте у ${w.x},${w.y},${w.z}`); return true }
  }
  const e = await act('explore', { block: 'water', radius: 48, stepDistance: 60, timeoutSeconds: 90 })
  if (e.detail && e.detail.found) await act('bucket', { fluid: 'water', radius: 48 })
  return have('water_bucket') > 0
}
// Литьё одним ведром у лавы L (cast1.js через portal cast {one}): подойти к ней, вода — в ведре; до двух заходов
// (второй — с новым местом, если первое не годилось). true — портал горит.
async function castOneAt (L, { maxDig = 60 } = {}) {
  if (!L) return false
  await refresh()
  if (state.pos && Math.hypot(L.x - state.pos.x, L.z - state.pos.z) > 14) {
    await sense()
    if (sit.night && sit.surface) { rlog('ночь, но всё для портала с собой — к лаве без норы'); await routeGoPush(L, 10) } else await routeGo(L, 10)
    await act('goto', { x: L.x, y: L.y + 1, z: L.z, range: 6, timeoutSeconds: 40 })
  }
  for (let k = 0; k < 3 && !died && !known.portal; k++) {
    const r = await act('portal', { mode: 'cast', one: true, hint: { x: L.x, y: L.y, z: L.z }, maxDig, timeoutSeconds: 300 })
    await readMemory()
    const d = r.detail || {}
    if (/CAST_UNSAFE/.test(String(d.stopped || ''))) throw new Error(String(d.stopped))
    // Место выбрано, а встать на берег литьё не смогло (путь литья не копает вниз: пещера под нами) — дойти обычным
    // goto с копкой и тем же местом ещё раз (план литья — в памяти мира).
    const stand = /не встал на берег (-?\d+),(-?\d+),(-?\d+)/.exec(String(d.stopped || ''))
    if (stand && k < 2) {
      await act('goto', { x: +stand[1], y: +stand[2], z: +stand[3], range: 0, timeoutSeconds: 90 })
      continue
    }
    rlog(`литьё одним ведром: ${d.lit ? 'горит' : 'нет'}${d.frame ? `, рама ${d.frame}` : ''}${d.stopped ? `; ${String(d.stopped).slice(0, 140)}` : ''}${d.seconds ? ` (${d.seconds} с)` : ''}`)
    if (known.portal || d.lit) return true
    // Рама готова, а зажечь нечем — кремень (гравий по карте/на виду), огниво из слитка, поджечь ту же раму.
    if (d.built && !d.lit) {
      if (!lighter()) { await ensureFlint(); await refresh(); if (!lighter() && have('flint') && have('iron_ingot')) await craft('flint_and_steel') }
      if (lighter()) {
        if (d.site && d.site.origin) await act('goto', { x: d.site.origin.x, y: d.site.origin.y, z: d.site.origin.z, range: 4, timeoutSeconds: 40 })
        const lit = await act('portal', { mode: 'build', timeoutSeconds: 60 })
        await readMemory()
        rlog(`рама готова, поджиг: ${(lit.detail && lit.detail.lit) || known.portal ? 'горит' : 'нет'}`)
        if (known.portal) return true
      }
      // Рама цела, огня нет — запомнить её: план дальше — огонь (кремень/руины) и поджиг этой же рамы, а не новая лава
      // (rt3-A1: «рама 10/10» без огнива у 4 прогонов, дальше чужая лава и ещё рамы).
      if (process.env.ND_ROUTE_FRAME !== '0') {
        const o = (d.site && d.site.origin) || state.pos
        if (o) { routeFrame = { x: Math.round(o.x), y: Math.round(o.y), z: Math.round(o.z) }; rlog(`рама без огня у ${routeFrame.x},${routeFrame.y},${routeFrame.z} — сперва огонь, потом поджиг её`) }
      }
      break
    }
    // Лавы у этого берега больше нет (со столба/с земли) — повтор тем же местом не поможет: к следующей лаве маршрута.
    if (/места на берегу нет|не вижу лавы|нужно ведро|нет воды|лавы со столба не достать|лавы в досягаемости нет/.test(String(d.stopped || r.error || ''))) break
  }
  return !!known.portal
}
// Ночь и кровать (поток route, 03.10, раунд 3): rtV/R7 — 17 из 24 смертей ночью (11–22-я мин), а кровать к 10-й мин
// была в 7 прогонах из 48. Кровать переводит ночь за секунды (это не «пережидание», правило пользователя), поэтому:
// кровать есть — с темнотой (сумерки ≥ 12300, сон с 12542) сразу спать там, где тело, и дальше по маршруту.
// Часы — situation.tod (index.js); нет их (старый демон) — по флагам night/dusk.
const ROUTE_SLEEP = process.env.ND_ROUTE_SLEEP !== '0'
const BED_BLOCKS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'].map(c => `${c}_bed`).join(',')
const todNow = () => (Number.isFinite(sit.tod) ? sit.tod : null)
const nightNow = () => { const t = todNow(); return t === null ? !!sit.night : (t >= 12542 && t <= 23459) }
let routeSleptAt = 0
let routeSleeping = false
async function routeSleep (why = '') {
  if (!ROUTE_SLEEP || died) return false
  await sense()
  if (dim() !== 'overworld') return false
  const t = todNow()
  const dusk = t === null ? !!sit.dusk : (t >= 12300 && t < 12542)
  if (!(nightNow() || dusk)) return false
  if (!have(/_bed$/) && have(/_wool$/) >= 3) { await makeBed(); await refresh() }
  if (!have(/_bed$/) && !sit.bed) return false
  if (Date.now() - routeSleptAt < 20000) return false
  routeSleptAt = Date.now()
  const t0 = Date.now()
  // В зоне аванпоста не спать: пиллагеры стреляют в кровать (rt3-A5 слот 10) — сперва выйти из зоны.
  await routeLeaveOutpost(null)
  rlog(`ночь (${t ?? '?'} тиков${why ? `, ${why}` : ''}) — кровать есть, сплю здесь`)
  await nightGuard()
  await sense()
  rlog(`сон: ${nightNow() ? 'ночь не проскочила' : 'утро'} за ${Math.round((Date.now() - t0) / 1000)} с`)
  return !nightNow()
}
// Кровать поздно (шага bed не было или он не вышел): к вечеру (≥ 9000 тиков, ~6.7 мин от утра 1000) — стадо одного
// цвета на виду (wool сам выберет цвет и откажется, если овец этого цвета мало), до 3 попыток за прогон.
let routeBedTries = 0
async function routeBedLate () {
  if (died || have(/_bed$/) || routeBedTries >= 3 || dim() !== 'overworld' || process.env.ND_ROUTE_BED === '0') return
  const t = todNow()
  if (t === null || t < 9000 || t > 12400) return
  await sense()
  if (!sit.surface || (state.health ?? 20) < 10) return
  routeBedTries++
  const r = await act('wool', { count: 3, radius: 48, timeoutSeconds: 60 })
  const d = r.detail || {}
  await refresh()
  if (have(/_wool$/) >= 3) await makeBed()
  await refresh()
  rlog(`кровать к ночи (${t} тиков, попытка ${routeBedTries}): ${have(/_bed$/) ? 'есть' : 'нет'}; овец на виду ${d.seen ?? 0}, цвет ${d.color || '—'}, шерсти ${d.wool ?? 0}${Array.isArray(d.steps) && d.steps.length ? ` [${d.steps.slice(-3).join(' / ')}]` : ''}`)
}
// Тело в зоне аванпоста — уйти на r + 24 от его центра (в сторону цели, если она есть и не за аванпостом).
async function routeLeaveOutpost (toward = null) {
  const info = routeInfoGet()
  await refresh()
  if (!info || !routeMod.outpostNear || !state.pos) return
  const hit = routeMod.outpostNear(info, state.pos)
  if (!hit) return
  const o = hit.o
  let ax = state.pos.x - o.x; let az = state.pos.z - o.z
  if (toward) { const tx = toward.x - o.x; const tz = toward.z - o.z; if (Math.hypot(tx, tz) > o.r) { ax = tx; az = tz } }
  const n = Math.hypot(ax, az) || 1
  const to = { x: Math.round(o.x + ax / n * (o.r + 24)), z: Math.round(o.z + az / n * (o.r + 24)) }
  rlog(`в зоне аванпоста ${o.x},${o.z} (${Math.round(hit.d)} из ${o.r} бл.) — ухожу к ${to.x},${to.z}`)
  await act('goto', { x: to.x, z: to.z, range: 6, timeoutSeconds: 60 })
  await refresh()
}
// Аванпост на пути (route.outpostWaypoint): сперва к точке обхода сбоку, потом к цели.
async function routeAroundOutpost (at) {
  const info = routeInfoGet()
  if (!info || !routeMod.outpostWaypoint || !state.pos) return
  const wp = routeMod.outpostWaypoint(info, state.pos, at)
  if (!wp) return
  rlog(`аванпост ${wp.outpost.x},${wp.outpost.z} (r ${wp.outpost.r}) на пути — обход через ${wp.x},${wp.z}`)
  await goToward({ x: wp.x, z: wp.z }, 8)
  await refresh()
}
let routeEntered = false
// Кремень из гравия в рюкзаке: поставить под себя/рядом и сломать, пока не выпадет (как ensureFlint, но без его лимита
// попыток flintTries — тот исчерпывается поиском гравия на местности).
async function routeFlintFromBag () {
  const g0 = have('gravel')
  for (let k = 0; k < 40 && !have('flint') && have('gravel') && !died; k++) {
    const p = await act('place', { block: 'gravel' })
    if (p.status !== 'done') break
    await act('mine', { block: 'gravel', count: 1, radius: 6, timeoutSeconds: 20 })
    await refresh()
  }
  rlog('кремень из гравия рюкзака: ' + (have('flint') ? 'есть' : 'нет') + ' (гравия было ' + g0 + ', осталось ' + have('gravel') + ')')
  if (!lighter() && have('flint') && have('iron_ingot')) await craft('flint_and_steel')
}
// Готовая рама без огня (castOneAt): план — огонь и поджиг её (route.plan opts.frame).
let routeFrame = null
// Срок шага маршрута (act бросает ROUTE_BUDGET после него): 3× бюджет, не меньше 150 с; дерево и камень — 600 с.
let routeDeadline = 0
let routeHealing = false
// Лечение и уход перед опасной работой маршрута (ROUTE_UNSAFE): вода → берег, завал → откопаться, враги → ответ,
// хп < 13 → еда (сытость 18 даёт реген) или охота, отлёжка.
async function routeRecover () {
  await sense()
  rlog(`перед копкой/спуском: хп ${Math.round(state.health ?? 0)}, еда ${state.food ?? '?'}, врагов ${sit.foes || 0}${sit.inWater ? ', в воде' : ''}${sit.buried ? ', завалило' : ''} — сперва лечение`)
  if (sit.inWater) await leaveWater()
  await sense()
  if (sit.buried) await waitDugOut()
  await sense()
  if (sit.foes && !died) await answerThreat()
  await refresh()
  if (!died && (state.health ?? 20) < 13) {
    if ((state.food ?? 20) < 18 && (have(FOOD) || have(RAW))) { if (!have(FOOD)) await cook(); await act('eat', {}) }
    await refresh()
    if (!have(FOOD) && (state.food ?? 20) < 18 && !died) { try { await stageRun('food')() } catch (e2) { if (e2.stopCampaign || manualControl) throw e2 } }
    if (!died) await rest()
  }
}
// Портал не пускает с хп < 10 (nether.enter MIN_ENTER_HP): rtV-C 10 — портал горел на 21-й мин, 16 отказов «На 6 хп в
// портал не шагаю» за 3 с и конец прогона. Отлёжка (rest: еда до сытости 18, коробка от врагов), потом вход.
async function routeHealToEnter () {
  await refresh()
  routeHealing = true
  try {
    for (let k = 0; k < 3 && (state.health ?? 20) < 10 && !died; k++) {
      rlog(`хп ${Math.round(state.health ?? 0)} — лечение перед порталом (вход с 10+)`)
      if (process.env.ND_ROUTE_ENTERHEAL === '0') {
        if ((state.food ?? 20) < 18 && (have(FOOD) || have(RAW))) { if (!have(FOOD)) await cook(); await act('eat', {}) }
      } else {
        // Регенерация требует сытости 18. Сырое съедаем сразу; печь/камень у огня не добываем.
        for (let n = 0; n < 6 && (state.food ?? 20) < 20 && (have(FOOD) || have(RAW)) && !died; n++) {
          const before = state.food
          await act('eat', {})
          await refresh()
          if (state.food <= before) break
        }
        if ((state.food ?? 0) < 18) { rlog('на лечение нет еды: вход отложен, без бессмысленной отлёжки'); return false }
      }
      await rest()
      await refresh()
    }
    return !died && (process.env.ND_ROUTE_ENTERHEAL === '0' || (state.health ?? 0) >= 10)
  } finally { routeHealing = false }
}
async function routeStep (s) {
  await refresh()
  const ironNow = () => have('iron_ingot') + have('raw_iron') + Math.floor(have('iron_nugget') / 9)
  switch (s.kind) {
    case 'wood': {
      // Брёвна — по рощам из скана копии (ближняя непосещённая), а не разведкой на 2 мин: на равнине с редкими дубами по
      // 2 бревна этап дерева ходил 711 с (rt-R3 слот 15). Нет скана — как раньше (этап дерева с разведкой).
      // Спавн в зоне аванпоста — сперва выйти из неё (rt3-A1 слот 10: брёвна у аванпоста, смерть на 1-й мин).
      await routeLeaveOutpost(s.at || null)
      if (s.at && !(await routeGo(s.at, 6))) return false
      if (s.src === 'mapwood' && Number.isFinite(s.at?.y) && !(await act('goto', { x: s.at.x, y: s.at.y, z: s.at.z, range: 2, surface: 'strict', timeoutSeconds: 60 })).status.match(/^done$/)) return false
      // Рощ рядом нет — дома деревни: брёвна столбов, иначе доски стен (доска = доска, 4 на верстак, 2 на палки, 3 на кирку).
      if (s.src === 'village' && !died) {
        await act('mine', { block: 'any_log', count: 4, radius: 32, timeoutSeconds: 90 })
        await refresh()
        if (woodNow() < 3) await act('mine', { block: 'any_planks', count: 12 - Math.floor(have(/_planks$/)), radius: 32, timeoutSeconds: 90 })
        await refresh()
        rlog(`дерево из деревни: брёвен ${have(LOGS)}, досок ${have(/_planks$/)}`)
      }
      if (s.src === 'mapwood') {
        await act('mine', { block: 'any_log,any_planks', count: 12, radius: 12, timeoutSeconds: 75 })
        await refresh()
      }
      // 3 бревна дают 12 досок: верстак 4, палки 2, кирка 3. Не ищем 8 бревен ради старта.
      if (process.env.ND_ROUTE_WOODMAP !== '0' && woodNow() >= 3) {
        const pl = planksFor(); if (pl && have(pl) < 9) await craft(pl, 4 * Math.ceil((9 - have(pl)) / 4))
        if (!have('crafting_table')) await craft('crafting_table')
        if (have('stick') < 2) await craft('stick', 4)
        if (!have(/_pickaxe$/)) await craft('wooden_pickaxe')
        await refresh()
        if (have(/_pickaxe$/)) return true
      }
      const info = routeInfoGet()
      const trees = ((info && info.ores && info.ores.trees) || []).filter(q => !(routeMod.outpostNear && routeMod.outpostNear(info, q, 8)))
      const want = 8
      const seen = new Set()
      for (let k = 0; k < 8 && woodNow() < want && trees.length && !died; k++) {
        await act('mine', { block: 'any_log', count: want - woodNow(), radius: 32, timeoutSeconds: 120 })
        await refresh()
        if (woodNow() >= want) break
        const me = state.pos
        // Роща по высоте рядом с телом (брёвна — на 0…+6 над ногами): роща на утёсе в 40 бл. над спавном вела в овраг под
        // утёсом (rt-R4 слот 15: «кирки нет — лезу наверх рукой» на 0-й мин).
        // Нет рощ вровень — ближняя в ±25 по высоте (rt-R6c слот 15: все рощи на плато в 45 бл. над спавном — 11 мин
        // разведки вслепую «не вижу брёвен»; путь наверх ищет goto, склон обычно проходим).
        const pick = band => trees.filter(q => !seen.has(`${q.x},${q.z}`) && me && Math.hypot(q.x - me.x, q.z - me.z) > 6 && Math.hypot(q.x - me.x, q.z - me.z) <= (band > 8 ? 120 : 200) && Math.abs(q.y - (me.y + 3)) <= band)
          .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - b.n * 2 - Math.hypot(b.x - me.x, b.z - me.z) + a.n * 2)[0]
        const t = pick(8) || pick(25)
        if (!t) break
        seen.add(`${t.x},${t.z}`)
        await routeGo(t, 4)
      }
      await stageRun('wood')()
      return have(/_pickaxe$/) > 0
    }
    case 'bed': {
      // Кровать до ночи (route.bedCands): кровать постройки по карте — дойти и сломать (кровать падает целиком), или
      // стадо одного цвета по карте — wool (убить/остричь) и makeBed.
      if (have(/_bed$/)) return true
      if (s.how === 'village') {
        if (!(await routeGo(s.at, 24))) return false
        await act('structure', { mode: 'explore', kind: 'village', x: s.at.x, z: s.at.z, fromMap: true, maxDistance: 120, beds: 1, food: false, timeoutSeconds: 100 })
        await refresh()
        return have(/_bed$/) > 0
      }
      if (s.how === 'block') {
        if (!(await routeGo(s.at, 8))) return false
        // Вплотную к клетке кровати (иглу: снаружи, на куполе, её не видно — rt3-A1 слот 11), потом сломать видимую.
        await act('goto', { x: s.at.x, y: s.at.y, z: s.at.z, range: 1, timeoutSeconds: 45 })
        await act('mine', { block: BED_BLOCKS, count: 1, radius: 6, timeoutSeconds: 30 })
        await refresh()
        if (!have(/_bed$/) && /village/.test(s.in || '')) await act('structure', { mode: 'explore', kind: 'village', x: s.at.x, z: s.at.z, fromMap: true, maxDistance: 80, beds: 1, food: false, timeoutSeconds: 60 })
        await refresh()
        return have(/_bed$/) > 0
      }
      if (!(await routeGo(s.at, 14))) return false
      const colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
      const r = await act('wool', { count: 3, radius: 40, x: s.at.x, z: s.at.z, timeoutSeconds: 90 })
      const d = r.detail || {}
      await refresh()
      if (have(/_wool$/) >= 3) await makeBed()
      await refresh()
      rlog(`кровать: ${have(/_bed$/) ? 'есть' : 'нет'}; овец на виду ${d.seen ?? 0}, цвет ${d.color || '—'} (по карте ${colors[s.color] || s.color}), шерсти ${d.wool ?? 0}, убито ${d.killed ?? 0}, острижено ${d.sheared ?? 0}, ${d.seconds ?? '?'} с${Array.isArray(d.steps) && d.steps.length ? ` [${d.steps.slice(-4).join(' / ')}]` : ''}`)
      if (have(RAW)) await cook({ reserveHunger: routeCookHunger() })
      return have(/_bed$/) > 0
    }
    case 'stone':
      await stageRun('stone')()
      // Блоки на маршрут сразу, пока камень под рукой (у лесенки): столб на голема 4, литьё 10, столб обзора 10.
      if (have(PICK_STONE) && fillerCount() < routeBlockTarget(22)) await routeBlocks(routeBlockTarget(22))
      // Еда рано и рядом: без запаса еды бой не принимается («бой не принят: нет запаса еды» — rt-R1 слоты 9, 11) и
      // тело бегает от первого же зомби. Звери на виду в 32 бл., до 45 с.
      if (foodUnits() < 3) { await sense(); if (sit.surface) await routeHunt(32, 45) }
      return have(PICK_STONE) > 0
    case 'ruin': {
      if (!(await routeGo(s.at, 16))) return false
      const r = await act('structure', { mode: 'explore', kind: 'ruined_portal', x: s.at.x, z: s.at.z, ...(Number.isFinite(s.at.y) ? { y: s.at.y } : {}), fromMap: true, maxDistance: 80, gold: false, timeoutSeconds: 120 })
      const took = (r.detail && r.detail.took) || {}
      if (!Object.keys(took).length) {
        // Не узнал глазами с подхода — к центру и ещё раз.
        await act('goto', { x: s.at.x, z: s.at.z, range: 4, timeoutSeconds: 40 })
        await act('structure', { mode: 'explore', kind: 'ruined_portal', maxDistance: 40, gold: false, timeoutSeconds: 90 })
      }
      await refresh()
      return lighter() || have('obsidian') > 0 || have('iron_nugget') > 0 || have(/^golden_/) > 0
    }
    case 'village': {
      const iron0 = ironNow()
      if (!(await routeGo(s.at, 24))) return false
      // Голем первым (железо — главное), потом сундуки, кровать и сено: обход деревни до 185 с уводил тело в пещеру под
      // деревней (rt-R3 слот 10: y −36, голема потом не видно). Столб — 3 блока + запас.
      if (fillerCount() < 6) await routeBlocks(8)
      let angry = false
      for (let k = 0; k < (angry ? 5 : 3) && ironNow() - iron0 < 3 && !died; k++) {
        await sense()
        const g = await act('golem', { mode: 'kill', radius: 64, timeoutSeconds: 85 })
        const d = g.detail || {}
        // Голем уже бит и жив — он зол: следующий заход — с того же столба (fauna.golemKill «уже на столбе»), не слезать.
        angry = angry || ((d.hits || 0) > 0 && !d.killed)
        rlog(`голем: ${d.killed ? 'убит' : 'жив'}, ударов ${d.hits ?? 0}${d.blocked ? ` (мимо прицела ${d.blocked})` : ''}, железа +${d.iron ?? 0}${d.hpLost ? `, урон ${d.hpLost}` : ''}${d.stopped ? `; ${d.stopped}` : ''}${Array.isArray(d.steps) ? ` [${d.steps.slice(-5).join(' / ')}]` : ''}`)
        if (d.killed || died) break
        if (/не вижу/.test(String(d.stopped || ''))) {
          // Голем бродит — к его месту по карте (скан копии: голем при генерации) или к центру деревни, оглядеться.
          const info = routeInfoGet()
          const gm = info && info.ores && (info.ores.golems || []).filter(q => Math.hypot(q.x - s.at.x, q.z - s.at.z) <= 96)[0]
          const to = gm || s.at
          await act('goto', { x: to.x, z: to.z, range: 6, timeoutSeconds: 40 })
          await act('observe', { radius: 48 })
        }
      }
      await act('structure', { mode: 'explore', kind: 'village', x: s.at.x, z: s.at.z, ...(Number.isFinite(s.at.y) ? { y: s.at.y } : {}), fromMap: true, maxDistance: 120, beds: 1, timeoutSeconds: 100 })
      if (died) return false
      await sense()
      if (!sit.surface && !sit.night) await toSurface()
      await routeFood()
      return ironNow() > iron0 || foodUnits() >= 6
    }
    case 'treasure': {
      const iron0 = ironNow()
      if (!(await routeGo(s.at, 6))) return false
      await act('structure', { mode: 'explore', kind: 'buried_treasure', x: s.at.x, z: s.at.z, maxDistance: 40, timeoutSeconds: 120 })
      await refresh()
      if (died) return false
      // Из ямы клада — наверх.
      await sense()
      if (!sit.surface) await toSurface()
      return ironNow() > iron0
    }
    case 'ship': {
      const iron0 = ironNow()
      if (!(await routeGo(s.at, 20))) return false
      await act('structure', { mode: 'explore', kind: 'shipwreck', x: s.at.x, z: s.at.z, ...(Number.isFinite(s.at.y) ? { y: s.at.y } : {}), fromMap: true, maxDistance: 80, timeoutSeconds: 180 })
      await refresh()
      await leaveWater()
      return ironNow() > iron0
    }
    case 'ore': {
      // Руда у пещерного воздуха по скану копии: к месту поверху, колодцем вниз до её высоты (descend: чутьё колодца,
      // в пещере — обзор и видимая руда), к клетке у руды, копать видимое, наверх.
      const quota = process.env.ND_ROUTE_QUOTAS !== '0'
      if (quota && routeMod.ironNeed(state.inventory || {}) === 0) return true
      const iron0 = ironNow()
      const st = s.at
      // Закрытая жила по скану (ironBuried): встать над ней, свой колодец вниз до неё (столбец без пещер — проверен
      // сканом), копать видимую руду, назад своим колодцем.
      if (s.buried && s.ore) {
        const o = s.ore
        if (!(await routeGo(s.at, 3))) return false
        // Ровно над жилой: goto по x,z с range 0 ставил тело на соседний столбец (rt3-A4: колодец рядом с жилой, «не вижу
        // iron_ore» у всех) — к клетке над рельефом этого столбца (скан: top), с проверкой столбца.
        const onCol = () => state.pos && Math.floor(state.pos.x) === o.x && Math.floor(state.pos.z) === o.z
        for (let k = 0; k < 2 && !onCol() && !died; k++) {
          await act('goto', Number.isFinite(s.top) ? { x: o.x, y: s.top + 1, z: o.z, range: 0, timeoutSeconds: 30 } : { x: o.x, z: o.z, range: 0, timeoutSeconds: 30 })
          await refresh()
        }
        if (!onCol()) { rlog(`над жилой не встал (${state.pos ? Math.floor(state.pos.x) + ',' + Math.floor(state.pos.z) : '?'} вместо ${o.x},${o.z})`); return false }
        // Колодец 1×1 ровно до верха жилы (ноги на её верхней клетке): лесенка (descend) при отказе колодца уводила на 20+
        // бл. в сторону, и жилы оттуда не видно (rt3-A3: «не вижу iron_ore» у 3 из 7). Отказ колодца (вода у ствола) —
        // шаг не вышел, следующая жила.
        const len = Math.round(y() - (o.y + 1))
        const from = state.pos && { ...state.pos }
        if (routeShaftBackOn()) surfaceShaft = null
        if (len > 0) await act('tunnel', { direction: 'down', length: len, timeoutSeconds: 120 })
        if (died) return false
        await refresh()
        routeRememberShaft(from)
        rlog(`колодец к жиле: ноги y ${Math.round(y())}, жила y ${o.y} (${s.depth} под рельефом)`)
        if (y() > o.y + 3) {
          await sense()
          if (routeShaftBackOn()) await routeReturnShaft('колодец к жиле не дошёл')
          else if (!sit.surface) await climbOwnShaft('колодец к жиле не дошёл')
          return false
        }
        // Руда: mine не берёт блок под ногами и не видит руду на уровне ног, если над ней порода (луч к центру упирается),
        // — видна та, что на уровне глаз. Поэтому: копать видимое, потом колодец ещё на 1 вниз (сквозь жилу; руда в стволе
        // падает в рюкзак) и снова — до 5 уровней или пока железа не хватит (проверено на слоте 20: 0 → 4 сырого за 2 уровня).
        for (let lv = 0; lv < 5 && !died; lv++) {
          for (let k = 0; k < 3 && !died; k++) {
            const before = ironNow()
            const count = quota ? Math.min(10, routeMod.ironNeed(state.inventory || {})) : 10
            if (count <= 0) break
            await act('mine', { block: 'iron_ore,deepslate_iron_ore', count, radius: 5, timeoutSeconds: 60 })
            await refresh()
            if (ironNow() <= before || (quota && routeMod.ironNeed(state.inventory || {}) === 0)) break
          }
          if (routeMod.ironNeed(state.inventory || {}) === 0 || ironNow() - iron0 >= 6) break
          const from = state.pos && { ...state.pos }
          await act('tunnel', { direction: 'down', length: 1, timeoutSeconds: 30 })
          await refresh()
          routeRememberShaft(from, true)
        }
        const gotB = ironNow() > iron0
        rlog(`жила под землёй: железа +${ironNow() - iron0}`)
        await sense()
        await routeReturnShaft('жила по карте: наверх')
        return gotB
      }
      // Пещера «руды на виду» — только при безопасности (раунд 3: скелет в пещере при хп 8 на 5-й мин — rtV-B 28; спайдер
      // и крипер внизу ночью — R7 27, rtV-A 13): глубже 6 бл. — хп ≥ 14, еда есть, не ночь (кровать — сперва сон).
      if ((s.depth || 0) > 6 && process.env.ND_ROUTE_ORE_SAFE !== '0') {
        await sense()
        if (nightNow()) await routeSleep('перед пещерой')
        await sense()
        const why = (state.health ?? 20) < 14 ? `хп ${state.health}` : foodUnits() < 1 && (state.food ?? 20) < 16 ? 'еды нет' : nightNow() ? 'ночь' : ''
        if (why) { rlog(`руда в пещере (глубина ${s.depth}) — не иду: ${why}`); return false }
      }
      if (!(await routeGo(st, 4))) return false
      // Скан v4 знает путь пещерой (walk) — идти ногами; без него (старый скан, руда у поверхности) — колодцем вниз.
      if (!Number.isFinite(s.walk) && Number.isFinite(st.y) && y() > st.y + 2) await descend(st.y + 1)
      if (died) return false
      if (Number.isFinite(st.y)) await act('goto', { x: st.x, y: st.y, z: st.z, range: 1, timeoutSeconds: Number.isFinite(s.walk) ? 60 : 45 })
      const count = quota ? Math.min(10, routeMod.ironNeed(state.inventory || {})) : 10
      if (count > 0) await act('mine', { block: 'iron_ore,deepslate_iron_ore', count, radius: 10, timeoutSeconds: 90 })
      await refresh()
      const got = ironNow() > iron0
      // Наверх: своим колодцем (0.6 с на уровень), иначе подъём survival.
      await sense()
      if (!sit.surface && !(await climbOwnShaft('руда по карте: наверх'))) await toSurface()
      return got
    }
    case 'mine': {
      const iron0 = ironNow()
      const need = Math.max(1, routeMod.ironNeed(state.inventory || {}))
      await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: need, radius: 48, timeoutSeconds: 150 })
      if (ironNow() - iron0 < need) await mineSeenAll('iron_ore,deepslate_iron_ore', 32)
      await refresh()
      return ironNow() - iron0 >= need
    }
    case 'smelt': {
      // Плавить только нужное: 3 на ведро (сколько ещё нет), 1 на огниво (если огня нет) — 10 с на слиток.
      const wantB = routeMod.BUCKETS()
      const wantIngots = 3 * Math.max(0, wantB - have(/bucket$/)) + (lighter() ? 0 : 1)
      await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: false, max: Math.max(0, wantIngots - have('iron_ingot') - Math.floor(have('iron_nugget') / 9)) })
      await refresh()
      if (have('iron_nugget') >= 9 && have('iron_ingot') < 6) { await ensureTable(); await act('craft', { item: 'iron_ingot', count: Math.floor(have('iron_nugget') / 9) }); await refresh() }
      for (let k = 0; k < 2 && have(/bucket$/) < wantB && have('iron_ingot') >= 3; k++) await craft('bucket')
      await refresh()
      if (!lighter() && have('iron_ingot') >= 1 && have('flint')) await craft('flint_and_steel')
      await refresh()
      return have(/bucket$/) >= wantB
    }
    case 'flint': {
      if (lighter()) return true
      // Гравий уже в рюкзаке (копка камня/колодцев его набирает: V1 слот 9 — 26 гравия, кремня нет, поиск исчерпан) —
      // поставить и сломать до кремня (10 % за блок, loot_table/blocks/gravel.json): 26 блоков — 94 %, ~1.5 с на блок.
      if (!have('flint') && have('gravel')) await routeFlintFromBag()
      // Закрытая залежь гравия по скану (gravelBuried): ровно над ней, колодец до верха, копать гравий (кремень 10 %/блок),
      // колодец на 1 глубже и снова (до 6 уровней), потом гравий рюкзака — поставить и сломать; наверх своим колодцем.
      if (s.buried && s.ore && !have('flint') && !died) {
        const o = s.ore
        if (await routeGo(s.at, 3)) {
          const onCol = () => state.pos && Math.floor(state.pos.x) === o.x && Math.floor(state.pos.z) === o.z
          for (let k = 0; k < 2 && !onCol() && !died; k++) { await act('goto', { x: o.x, y: s.top + 1, z: o.z, range: 0, timeoutSeconds: 30 }); await refresh() }
          if (onCol()) {
            const len = Math.round(y() - (o.y + 1))
            const from = state.pos && { ...state.pos }
            if (routeShaftBackOn()) surfaceShaft = null
            if (len > 0) await act('tunnel', { direction: 'down', length: len, timeoutSeconds: 120 })
            await refresh()
            routeRememberShaft(from)
            for (let lv = 0; lv < 6 && !have('flint') && !died; lv++) {
              await act('mine', { block: 'gravel', count: 12, radius: 5, timeoutSeconds: 45 })
              await refresh()
              if (have('flint')) break
              const from = state.pos && { ...state.pos }
              await act('tunnel', { direction: 'down', length: 1, timeoutSeconds: 30 })
              await refresh()
              routeRememberShaft(from, true)
            }
            if (!have('flint') && have('gravel')) await routeFlintFromBag()
            rlog(`залежь гравия ${o.x},${o.y},${o.z}: кремень ${have('flint') ? 'есть' : 'нет'}, гравия ${have('gravel')}`)
            await sense()
            await routeReturnShaft('гравий по карте: наверх')
          } else rlog(`над залежью гравия не встал (${o.x},${o.z})`)
        }
      }
      // К клетке скана, откуда гравий виден (с y): по одним x,z тело вставало на гребне в 20 бл. над ним (rt-R3 слот 28);
      // не видно оттуда — следующая жила из скана (до трёх запасных).
      for (const at of [s.at, ...(s.alts || [])].filter(Boolean)) {
        if (have('flint') || died) break
        await routeGo(at, 4)
        if (Number.isFinite(at.y)) await act('goto', { x: at.x, y: at.y, z: at.z, range: 1, timeoutSeconds: 45 })
        for (let k = 0; k < 4 && !have('flint') && !died; k++) {
          const g = await act('mine', { block: 'gravel', dry: true, count: 6, radius: 12, timeoutSeconds: 60 })
          if (!(g.detail && g.detail.dug)) break
        }
      }
      for (let k = 0; k < 2 && !have('flint') && !s.at && !died; k++) {
        const g = await act('mine', { block: 'gravel', dry: true, count: 6, radius: 40, timeoutSeconds: 60 })
        if (!(g.detail && g.detail.dug)) break
      }
      // Гравий в рюкзаке — ставить и бить, пока не выпадет (ensureFlint).
      if (!have('flint')) await ensureFlint()
      await refresh()
      if (!lighter() && have('flint') && have('iron_ingot')) await craft('flint_and_steel')
      await refresh()
      return lighter()
    }
    case 'food': {
      await routeFood()
      const target = Number.isFinite(routeCookHunger()) ? 4 : 6
      if (foodUnits() < target) await routeHunt(40, 60)
      await routeFood()
      return foodUnits() >= 4
    }
    case 'water': {
      if (have('water_bucket')) return true
      if (!have('bucket')) return false
      // Под землёй (после колодца к жиле тело осталось внизу) воду не видно — сперва наверх (rt3-V1 слот 12: шаг воды на y 39).
      await sense()
      if (!sit.surface && !s.at) await toSurface()
      if (s.at) { await routeGo(s.at, 3); if (Number.isFinite(s.at.y)) await act('goto', { x: s.at.x, y: s.at.y, z: s.at.z, range: 1, timeoutSeconds: 30 }) }
      for (let i = 0; i < 2 && !have('water_bucket') && !died; i++) {
        const r = await act('bucket', { fluid: 'water', radius: 48 })
        if (have('water_bucket') || (r.detail && r.detail.need)) break
        const w = routeInfoGet() && routeInfoGet().ores && (routeInfoGet().ores.water || []).filter(q => state.pos && Math.hypot(q.x - state.pos.x, q.z - state.pos.z) <= 120 && Math.hypot(q.x - state.pos.x, q.z - state.pos.z) > 6 && !(routeMod.outpostNear && routeMod.outpostNear(routeInfoGet(), q, 8)))
          .sort((a, b) => Math.hypot(a.x - state.pos.x, a.z - state.pos.z) - Math.hypot(b.x - state.pos.x, b.z - state.pos.z))[0]
        if (w) { await routeGo(w.stand || w, 4); continue }
        const e = await act('explore', { block: 'water', radius: 48, stepDistance: 60, timeoutSeconds: 90 })
        if (!(e.detail && e.detail.found)) break
      }
      return have('water_bucket') > 0
    }
    case 'castSky': {
      if (have(/bucket$/) < 1) return false
      if (!(await routeWater(s.at))) return 'water'
      await routeBlocks(routeBlockTarget())
      // Одним ведром с берега (cast1.js): к озеру, вода в ведре — с собой, литьё за ~20 с. Не вышло (берега нет) и вёдер
      // два — как раньше, portal_natural с литьём cast.js.
      if (await castOneAt(s.at)) return true
      if (have(/bucket$/) < 2) return false
      const r = await act('portal_natural', { mode: 'run', hint: { x: s.at.x, y: s.at.y, z: s.at.z }, legs: 0, pillar: 10, timeoutSeconds: 480 })
      await readMemory()
      const d = r.detail || {}
      rlog(`литьё поверху: ${d.lit ? 'горит' : 'нет'}${d.cast ? `, рама ${d.cast.frame}, черпаков ${d.cast.refills}` : ''}${d.stopped ? `; ${String(d.stopped).slice(0, 120)}` : ''}${d.cast && d.cast.stopped ? `; литьё: ${String(d.cast.stopped).slice(0, 120)}` : ''} (${d.seconds ?? '?'} с)`)
      return !!known.portal
    }
    case 'castCave': {
      if (have(/bucket$/) < 1) return false
      if (!(await routeWater(s.at))) return 'water'
      await routeBlocks(routeBlockTarget())
      const L = s.at
      // Над местом лавы — поверху. Место на берегу cast1 считает по блокам прогруженных чанков (тело лавы у подсказки
      // карты копии мира — по связности), подход к нему — путём с копкой; не вышло отсюда — колодцем вниз к её высоте
      // (descend) и ещё раз; потом прежнее литьё с окнами (deepCast, два ведра).
      if (!(await routeGo(L, 10))) return false
      if (process.env.ND_ROUTE_CAVE !== 'descend' && await castOneAt(L, { maxDig: 80 })) return true
      if (died) return false
      if (y() > L.y + 4) await descend(L.y + 1, { stopAtLava: true })
      if (died) return false
      // Спуск съел булыжник на лесенку/столбы (rt-L2 слот 9: 3 блока у озера — «нужно блоков 6+») — добрать камнем пещеры.
      if (fillerCount() < 16) await routeBlocks(16)
      if (await castOneAt(descendLava || L, { maxDig: 80 })) return true
      if (have(/bucket$/) < 2) return false
      deepLava = descendLava || { x: L.x, y: L.y, z: L.z }
      await deepCast()
      await readMemory()
      return !!known.portal
    }
    case 'castDeep':
    case 'giveup':
      return 'delegate'
    case 'light': {
      // Поджиг готовой рамы: огонь в рюкзаке (кремень + слиток), к раме, portal build.
      if (!routeFrame) return false
      // Слиток на огниво — из сырого, если слитка нет.
      if (!lighter() && !have('iron_ingot') && have('raw_iron')) { await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: false, max: 1 }); await refresh() }
      // Готовая рама — ценнее, чем лимит поиска кремня: ещё один заход ensureFlint (гравий в 40, разведка), даже если
      // кремень уже искали дважды (rt3-A3 слот 17: рама 10/10, 13 слитков, «light✗ 0 с» дважды — кремень исчерпан).
      if (!lighter() && !have('flint')) flintTries = Math.min(flintTries, 1)
      if (!lighter() && !have('flint') && have('gravel')) await routeFlintFromBag()
      if (!lighter()) { await ensureFlint(); await refresh(); if (!lighter() && have('flint') && have('iron_ingot')) await craft('flint_and_steel'); await refresh() }
      if (!lighter()) return false
      await routeGo(routeFrame, 6)
      await act('goto', { x: routeFrame.x, y: routeFrame.y, z: routeFrame.z, range: 4, timeoutSeconds: 40 })
      const lit = await act('portal', { mode: 'build', timeoutSeconds: 60 })
      await readMemory()
      rlog('поджиг рамы ' + routeFrame.x + ',' + routeFrame.y + ',' + routeFrame.z + ': ' + ((lit.detail && lit.detail.lit) || known.portal ? 'горит' : 'нет'))
      if (known.portal) { routeFrame = null; return true }
      return false
    }
    case 'ironStage': {
      // Этап железа кампании (лесенка к y 16, штреки, плавка) — до вёдер маршрута (одно при литье одним ведром).
      const t0 = Date.now()
      for (let k = 0; k < 3 && have(/bucket$/) < routeMod.BUCKETS() && routeMod.ironNeed(state.inventory || {}) > 0 && Date.now() - t0 < 600000 && !died; k++) {
        try { await stageRun('iron')() } catch (e) { if (e.stopCampaign || manualControl || e.routeBudget || /умер/.test(e.message)) throw e; rlog(`этап железа: ${e.message}`) }
        await refresh()
      }
      return have(/bucket$/) >= routeMod.BUCKETS() || routeMod.ironNeed(state.inventory || {}) === 0
    }
    case 'enter': {
      if (!known.portal) return false
      await routeFood({ cookRaw: false })
      // Еда добирается в Аду (READY.nether под маршрутом — 2 куска): здесь охота, только если совсем пусто.
      if (foodUnits() < 2) await quickHunt()
      if (!(await routeHealToEnter())) return false
      await enterNether()
      await refresh()
      if (dim() === 'the_nether') routeEntered = true
      return dim() === 'the_nether'
    }
  }
  return false
}
defStage('route', () => ROUTE && !routeDone && dim() === 'overworld' && (!known.portal || !routeDoneIds.has('enter')) && !!routeInfoGet(), async () => {
  const info = routeInfoGet()
  if (!routeT0) routeT0 = Date.now()
  let first = true
  for (let round = 0; round < 24 && !died && dim() === 'overworld'; round++) {
    await refresh()
    // Ночь и кровать есть — сон перед шагом; к вечеру без кровати — стадо на виду (раунд 3).
    await routeSleep('перед шагом')
    await routeBedLate()
    if (died) break
    await sense()
    // Время от утра (план кровати): часы мира (старт сцены — 1000 тиков), иначе — от начала маршрута.
    const elapsed = todNow() !== null ? Math.max(0, Math.round((todNow() - 1000) / 20)) : Math.round((Date.now() - routeT0) / 1000)
    // Портал уже горит — только вход.
    const p = routeMod.plan(info, { from: state.pos, fromY: state.pos ? state.pos.y : undefined, have: state.inventory || {}, avoid: routeAvoid, done: routeDoneIds, portal: !!known.portal, elapsed, structureSeconds: routeStructureSeconds, frame: known.portal ? null : routeFrame })
    if (first) { rlog(routeMod.describe(p)); first = false }
    const s = p.steps.find(x => !routeDoneIds.has(x.id))
    if (!s) break
    const t0 = Date.now()
    let ok = false
    rlog(`шаг ${s.id}: ${s.why || ''} (бюджет ${s.budget} с)`)
    routeDeadline = Date.now() + (/^(wood|stone)$/.test(s.kind) ? (process.env.ND_ROUTE_DEADLINE === '0' ? 600 : Math.min(300, Math.max(150, (s.budget || 60) * 2))) : Math.max(150, (s.budget || 60) * 3)) * 1000
    const structureStep = /^(ruin|village|treasure|ship)$/.test(s.kind)
    const structureLeft = routeMod.structureSearchLeft(routeStructureSeconds)
    if (structureStep && Number.isFinite(structureLeft)) {
      routeDeadline = Math.min(routeDeadline, Date.now() + structureLeft * 1000)
      rlog(`постройки: использовано ${Math.round(routeStructureSeconds)} из 180 с, осталось ${Math.floor(structureLeft)} с; затем руда`)
    }
    try { ok = await routeStep(s) } catch (e) {
      routeDeadline = 0
      if (e.stopCampaign || manualControl) throw e
      rlog(`шаг ${s.id} упал: ${e.message}`)
      // Копка/спуск на малом хп, при враге, в воде (act: ROUTE_UNSAFE) — сперва лечение и уход, потом тот же шаг; не более
      // 4 раз за прогон, дальше шаг проваливается как обычно.
      if (e.routeUnsafe && !died) {
        const n = (routeFails.get('unsafe!') || 0) + 1
        routeFails.set('unsafe!', n)
        if (n <= 4) { await routeRecover(); continue }
      }
      // Ранен и голоден (act бросил шаг) — еда и тот же шаг снова, без провала.
      if (/сначала еда/.test(e.message) && !died) {
        try { await stageRun('food')() } catch (e2) { if (e2.stopCampaign || manualControl) throw e2 }
        continue
      }
    } finally {
      if (structureStep) routeStructureSeconds += (Date.now() - t0) / 1000
    }
    routeDeadline = 0
    const sec = Math.round((Date.now() - t0) / 1000)
    if (ok === 'delegate') { rlog(`шаг ${s.id}: дальше обычные этапы (глубокое литьё) — с начала ${Math.round((Date.now() - routeT0) / 1000)} с`); break }
    if (ok === 'water') {
      // Воды не нашлось — лава не виновата: не в avoid; второй раз подряд — дальше обычные этапы (там поиск воды шире).
      const n = (routeFails.get('water!') || 0) + 1
      routeFails.set('water!', n)
      rlog(`шаг ${s.id}: воды в ведро не нашлось (${n}-й раз) за ${Math.round((Date.now() - t0) / 1000)} с`)
      if (n >= 2) break
      continue
    }
    rlog(`шаг ${s.id} ${ok ? 'ok' : 'НЕ ВЫШЕЛ'} за ${sec} с (бюджет ${s.budget} с), с начала ${Math.round((Date.now() - routeT0) / 1000)} с; рюкзак: ${bag()}`)
    if (ok) routeDoneIds.add(s.id)
    else if (/^(food|water)$/.test(s.id)) routeDoneIds.add(s.id) // мягкие: еда — ещё перед входом, вода — у литья (ensureWater)
    else if (s.id === 'smelt' && (routeFails.get('smelt') || 0) < 2) { routeFails.set('smelt', (routeFails.get('smelt') || 0) + 1) /* железа не хватило — следующий план позовёт копку */ }
    else if (s.id === 'smelt') { rlog('плавка не вышла трижды — дальше обычные этапы'); break }
    else {
      const n = (routeFails.get(s.id) || 0) + 1
      routeFails.set(s.id, n)
      // Шаг повторяем один раз (бой, ночь, отход — обстановка сменилась), второй провал — мимо.
      if (n >= 2 || /^(ruin|village|treasure|ship|ore:|dig:|mine|ironStage|lava:)/.test(s.id)) routeAvoid.add(s.id)
    }
    if (s.kind === 'giveup') break
    if (s.kind === 'enter' && ok) break
    if (died) break
  }
  routeDone = true
  rlog(`маршрут кончился: ${dim() === 'the_nether' ? 'в Аду' : known.portal ? 'портал горит' : 'без портала — дальше обычные этапы'}, ${Math.round((Date.now() - routeT0) / 1000)} с`)
  // Маршрут кончился у лавового озера (литьё не вышло) — обычные этапы начинали тут же: кровать-точка, верстак, плавка на
  // краю лавы (rt3-A5: 2 смерти «tried to swim in lava» на 7-й и 25-й мин). Сперва отойти от лавы на 12 бл.
  if (!died && dim() === 'overworld' && !known.portal && process.env.ND_ROUTE_LAVAEDGE !== '0') {
    try {
      const ob = await act('observe', { radius: 5 })
      const lv = (Array.isArray(ob.detail && ob.detail.blocks) ? ob.detail.blocks : []).find(b => b && b.name === 'lava')
      if (lv && lv.nearest) { rlog(`лава в ${lv.dist ?? '?'} бл. — отхожу от неё перед обычными этапами`); await awayFrom(lv.nearest, 12) }
    } catch (e) { if (e.stopCampaign || manualControl) throw e }
  }
})
// Маршрут — первым этапом (STAGES идут по порядку объявления).
{ const i = STAGES.findIndex(x => x.name === 'route'); if (i > 0) STAGES.unshift(STAGES.splice(i, 1)[0]) }
// После поджига — сразу вход (раунд 3): маршрут кончился, а портал зажгли обычные этапы (cast, portal_natural) — не
// уходить в этап еды/сборов (rtV-B 9, rtV-C 10, rtV-Abase 8: портал горел на 21–22-й мин, охота до конца прогона).
// Один раз за прогон: первый вход; дальше (возврат из Ада) — обычные этапы.
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

// 8а. Сборы в Ад (портал уже горит): еда, щит, кровать. Щит держит спереди
// стрелы скелетов-иссушителей и шары блейзов (blaze.js: «щит — держит
// спереди»); кровать у портала — точка возрождения: смерть в Аду вернёт к
// порталу, а не к старой кровати у шахты за 1700 блоков. Золото на шлем —
// уже в Аду (netherGold). Не собралось за два захода — этап отдыхает, и Ад
// берётся с тем, что есть.
const rodsNow = () => have('blaze_rod') + Math.floor(have('blaze_powder') / 2) + Math.floor(have('ender_eye') / 2)
const goldOn = () => /golden_(helmet|chestplate|leggings|boots)/.test(JSON.stringify(state.armor || {}))
const shieldOn = () => have('shield') > 0 || /shield/.test(JSON.stringify(state.offHand || ''))
const shieldLow = () => { const o = state.offHand; return !!o && /shield/.test(o.item || '') && (o.durability ?? 100) < 35 }
const spawnAtPortal = () => !!(known.spawnBed && known.portal && Math.hypot(known.spawnBed.x - known.portal.x, known.spawnBed.z - known.portal.z) <= 48)
const stageRun = name => STAGES.find(s => s.name === name).run
let huntWool = false
// Сколько кроватей держать: 2 — ночь и точка возрождения; на дракона — 6.
let wantBeds = 1
// Один заход сборов: железо и шерсть не везде рядом, а второй заход того же —
// ещё 10 минут ходьбы; не собралось — в Ад с тем, что есть.
let prepRuns = 0
const lighter = () => have('flint_and_steel') > 0 || have('fire_charge') > 0
// Вход в Ад из верхнего мира. Огнива нет и гравия не нашлось (ensureFlint
// уже звали) — всё равно в Ад: без огнива этапы стояли бы до блокера. Риск:
// портал Ада, погашенный гастом, — возврат смертью к кровати у портала
// (keep_inventory). 2026-09-29 12:51: последнее огниво сгорело на охоте.
async function enterNether () {
  if (!lighter()) log('огнива нет и сделать не из чего — вхожу без него (погасший портал = возврат через кровать)')
  // Из шахты под базой путь к порталу не находится: «до портала не дошёл: Took to
  // long to decide path» / «pathfinder не нашёл ни шага» (2026-09-29, 17:02,
  // 17:04, 17:42 — два блокера подряд). Сперва наверх, потом ногами к порталу.
  await refresh()
  if (known.portal && state.pos && dim() === 'overworld' && state.pos.y < (known.portal.y ?? 64) - 5) {
    log(`к порталу из-под земли (y ${Math.round(state.pos.y)}) — сперва наверх`)
    await act('surface', { timeoutSeconds: 120, hand: false, preferPillar: true })
    await refresh()
    for (let k = 0; k < 3 && !died; k++) if (await goToward(known.portal, 4)) break
  }
  return act('portal', { mode: 'enter', timeoutSeconds: 120, ...(lighter() ? {} : { noIgniter: true }) })
}
// Сборы перед Адом — путь спидраннеров (решение пользователя 30.09): огниво и еда; щит — только из железа в рюкзаке,
// кровать — только из шерсти в рюкзаке (охота за шерстью и поход за железом — не условие входа).
defStage('prep', () => !!known.portal && dim() === 'overworld' && rodsNow() < 7 && (prepRuns < 1 || (!lighter() && flintTries < 2)) &&
  ((!lighter() && flintTries < 2) || foodUnits() < FOOD_STOCK || (!shieldOn() && have('iron_ingot') > 0)), async () => {
  prepRuns++
  // Глубокий путь (ND_OW_DEEP): портал отлит у дна, тело рядом с ним под землёй, огниво есть и еды на вход хватает —
  // сборы наверху (охота, кровать, щит) не нужны: в Ад сразу. Раньше здесь ночью «я под крышей — жду утра» на −54 у
  // горящего портала (ow-E3 02.10, слоты 9 и 12: портал на 31 и 35 мин, дальше ожидание и смерть на подъёме).
  await sense()
  // И портал поверху (литьё у лавы под небом): рядом, огниво есть, еды на вход хватает — в Ад, без охоты до 8 и кровати
  // (ow-P6 02.10, слот 11: портал на 27-й мин, дальше дерево, охота на 350 бл. от портала ночью).
  if (OW_DEEP && known.portal && near3(known.portal, 48) && lighter() && foodUnits() >= netherFoodNeed()) {
    log(`сборы: портал в ${Math.round(portalFar())} бл., огниво есть, еды ${foodUnits()} — в Ад без сборов`)
    return
  }
  // Ночью наверху сборы не идут: разведка за железом и гравием в темноте —
  // это крипер (2026-09-26, 12:11, «blown up by Creeper», вся броня и золото
  // остались в 574 блоках).
  await nightGuard()
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  // Еда — охота; шерсть попутно (овца первой), но отдельно за кроватью не ходим.
  huntWool = !spawnAtPortal()
  try {
    if (foodUnits() < FOOD_STOCK) await stageRun('food')()
  } finally { huntWool = false }
  await cook()
  await makeBed()
  // Огниво (без него portal enter в Ад не пускает: гаст гасит портал взрывом)
  // и щит — по слитку. Смерть в Аду унесла огниво, а железный заход отдал все
  // 23 слитка броне и ведру (2026-09-26, 12:08).
  const ironWant = lighter() ? 0 : 1
  if (ironWant) {
    await refresh()
    // Девять самородков — слиток без похода за рудой (2026-09-29 12:59: огниво
    // пропало, в рюкзаке 16 самородков, а сборы пошли искать руду на 48 бл.).
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
    // Щит — из слитка в рюкзаке, если он есть (за железом ради щита не ходим).
    await refresh()
    if (!shieldOn() && have('iron_ingot')) {
      if (have(/_planks$/) < 6 && !have(LOGS)) await lumber(2)
      if (have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
      await craft('shield')
      await act('armor')
    }
  }
  // Кровать — к порталу, точкой возрождения (сломать её — потерять точку).
  await readMemory()
  if (have(/_bed$/) && !spawnAtPortal() && known.portal) {
    await goToward(known.portal, 6)
    await act('sleep', { mode: 'spawn', why: 'у портала в Ад' })
    await readMemory()
  }
})

// 8б. Бастион — путь спидраннеров (SPEEDRUN.md): золотые блоки бастиона →
// бартер с пиглинами: огнестойкость (блейзы без неё — 4 из 11 в лаборатории),
// жемчуг (0.064 на слиток), обсидиан, нить на кровати, огненные заряды. Нужен,
// пока жемчуга меньше 12 или огнестойкости нет, а стержней ещё нет — и пока
// бастион не выбран: вызов без золота и без сделок дважды подряд — хватит.
// Зелья кампания видит по state.potions (perception.stateSummary).
const fireResNow = () => { const p = state.potions || {}; return Object.entries(p).filter(([k]) => /fire_resistance$/.test(k)).reduce((n, [, v]) => n + v, 0) }
const pearlsNow = () => have('ender_pearl') + have('ender_eye')
// ND_OBS_EXIT=1 (поток nether 03.10, ревью Codex ne-deaths.md №5): выход у крепости Края из Ада (ND_SH_NETHER) — рама из 10
// обычного обсидиана; без него (D6-31/D7-31: обсидиана 2) — домой и 1.4 тыс. бл. поверху, ночью смерть. Обсидиан — бартер
// (40/459 за слиток) и сундуки бастиона: бастион нужен, пока его меньше 10.
const EXIT_KIT = process.env.ND_EXIT_KIT !== '0' && process.env.ND_SH_NETHER === '1'
const exitKitNow = () => require(path.join(__dirname, 'src/nether')).exitKit(state.inventory || {})
let exitFrameTarget = null
const pendingExitFrame = () => !!exitFrameTarget && dim() === 'the_nether' && lighter() && !!state.pos && Math.hypot(state.pos.x - Math.floor(exitFrameTarget.x / 8), state.pos.z - Math.floor(exitFrameTarget.z / 8)) <= 12
const obsShort = () => !known.endPortal && (EXIT_KIT ? !pendingExitFrame() && !exitKitNow().ready : process.env.ND_OBS_EXIT === '1' && process.env.ND_SH_NETHER === '1' && !have(PICK_DIAMOND) && have('obsidian') < 10)
// Сколько очей нужно: пустых рамок в комнате портала (12 минус уже вставленные). Мир
// прохождения server-run: рамки крепости A прочитаны из региона (29.09) — глаз уже в 2,
// нужно 10 (ND_EYES_NEED=10). Крепость не записана в памяти — будут броски find, каждое
// брошенное око разбивается в 20%: тогда +2 про запас.
const EYES_NEED = Math.max(1, Math.min(12, Number(process.env.ND_EYES_NEED) || 12))
const eyesWant = () => EYES_NEED + (known.stronghold ? 0 : 2)
const barterFlow = require(path.join(__dirname, 'src', 'barter-flow'))
let barterRetryPending = false
let bastionDry = 0
let ironChestTried = false
// Несколько бастионов: одного на 10 жемчуга с P≥85% не хватает (бастион 105,87 — 17 блоков стен ≈ 153
// слитка, P≈46%; второй 672,272 — «units», 18 блоков). Выработан — золото кончилось после добычи или
// два сухих захода подряд; тогда этап идёт к следующему по памяти.
const BASTION_KEYS = ['бастион (ад)', 'бастион 2 (ад)', 'бастион 3 (ад)']
const bastionState = new Map()
const bState = b => {
  const key = `${b.key}:${b.dimension || 'the_nether'}:${b.x}:${b.z}`
  if (!bastionState.has(key)) bastionState.set(key, { dry: 0, spent: false, runs: 0 })
  return bastionState.get(key)
}
const nextBastion = () => {
  const left = (known.bastions || []).filter(b => !bState(b).spent)
  return left.find(b => !barterFlow.enabled() || (bState(b).barterUntil || 0) <= Date.now()) || left[0] || null
}
// Поиск бастиона (fortress mode=bastion: обход регионов, как у крепости): на новых мирах «бастион (ад)» в памяти бывал,
// только если разведка крепости случайно его видела, — крепость в регионе портала, и после стержней шли эндермены
// (dev-F 02.10). До трёх заходов; «обошёл три кольца» — больше не искать.
let bastionSearchRuns = 0
// Все известные выработаны — искать следующий (fortress mode=bastion пропускает выработанные): эндермены — только после
// всех бастионов (правило пользователя), а «все» — это и не найденные ещё рядом.
// Бастионы известны по карте копии мира (запись с золотом — try-lab-ne-map / память основного тела): искать новые
// незачем — карта полная, все известные выработаны → добор (эндермены). Поиск — только без карты (разведка).
const bastionsFromMap = () => (known.bastions || []).some(b => Array.isArray(b.gold) && b.gold.length > 0)
const bastionSearchWanted = () => !nextBastion() && bastionSearchRuns < 3 && !bastionsFromMap()
// После стержней, а не до (порядок спидраннеров — бастион, потом крепость —
// здесь не окупается): репетиция на двойнике мира прохождения (тот же сид,
// server-twin) — в этом бастионе 10 брутов и 5 хоглинов, золото в стенах над
// лавовым озером; три прогона — 0 золотых блоков. Стержни — известный путь;
// бастион — потом, за жемчугом (если он не взят эндерменами).
// Сухой заход (ни золота, ни сделок, ни сундуков) бывает случайным — вход штреком или вышка не
// узнала стены (ферма 29.09: 3 из 6 попыток). Сдаёмся после трёх подряд, а не после одного.
// ND_BASTION_FIRST=1 — порядок спидраннеров (SPEEDRUN.md R1): бастион до крепости Ада — огнестойкость из бартера
// (огненный шар блейза — #is_fire, под зельем не жжёт) и обсидиан на раму у крепости Края. По умолчанию выкл. до замера.
const BASTION_FIRST = process.env.ND_BASTION_FIRST === '1'
// ND_SCOUT_HIGH=1 — разведка крепости/бастиона со взглядом с вышки и радиусом 128 (fortress.js highLook). До замера выкл.
const SCOUT_HIGH = process.env.ND_SCOUT_HIGH === '1'
defStage('bastion', () => !!known.portal && (!!nextBastion() || bastionSearchWanted()) && bastionDry < 3 && !known.endPortal &&
  (BASTION_FIRST || rodsNow() >= 7) && (pearlsNow() < eyesWant() || obsShort() || (barterFlow.enabled() && process.env.ND_FR_STRICT === '1' && rodsWanted() && fireResNow() < 2)), async () => {
  if (dim() !== 'the_nether') {
    await refresh()
    if (!goldOn() && have('gold_ingot') >= 5) { await craft('golden_helmet'); await act('armor') }
    // За золотом идём перед пиглинами на этапе bastion. Для блейзов
    // отдельный поиск шлема не нужен и только расходует еду и кирки.
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
    }
    if (!lighter()) await ensureFlint()
    await baseDeposit()
    await sticksReserve()
    await act('kit', { for: 'bastion' })
    if (have(/_bed$/) && !spawnAtPortal()) await act('sleep', { mode: 'spawn', why: 'у портала в Ад' })
    const e = await enterNether()
    if (!(e.detail && e.detail.went)) throw new Error('в Ад не прошёл')
  }
  if (!nextBastion() && bastionSearchWanted() && dim() === 'the_nether' && !died) {
    bastionSearchRuns++
    await spares(260)
    const f = await act('fortress', { mode: 'bastion', timeoutSeconds: 420, ...(SCOUT_HIGH ? { high: true } : {}) })
    await readMemory()
    const fd = f.detail || {}
    if (/обошёл регионы/.test(fd.stopped || '')) bastionSearchRuns = 99
    log(`поиск бастиона: ${fd.found ? `найден ${JSON.stringify((fd.bastion && fd.bastion.nearest) || {})}` : 'не найден' + (fd.stopped ? ' — ' + fd.stopped : '')} (заход ${Math.min(bastionSearchRuns, 3)}, ${fd.seconds ?? '?'} с)`)
    if (!nextBastion()) return
  }
  if (!goldOn()) await netherGold()
  if (!goldOn()) { log('золотой брони нет и не из чего — в бастион не иду'); bastionDry++; return }
  for (let i = 0; i < 4 && !died && dim() === 'the_nether'; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    if ((state.health ?? 20) < 12) { if (have(FOOD)) await act('eat'); if ((state.health ?? 20) < 10) break }
    const b = nextBastion()
    if (!b) { log('все известные бастионы выработаны'); break }
    const bs = bState(b)
    bs.runs++
    // Штрек бастиона — сотни копок (ферма 30.09: 350–450 на бастион); каменные кирки берут камень и
    // незерак, железная — только золото. Запас кирок — до захода (у основного тела 5 каменных, верстак,
    // булыжник и доски: spares сам сделает ещё). Не в яме у пиглинов: верстак в штреке (camp-11 30.09 —
    // «верстак сломал, но подобрать не успел»), и следующий вызов начался с брута в штреке.
    const nearAny = !!state.pos && (known.bastions || []).some(x => Math.hypot(x.x - state.pos.x, x.z - state.pos.z) < 80)
    // Ход по сетке (ND_NE_ROUTE) сам пополняет каменные кирки по дороге; крафт здесь — верстак у портала прибытия, рядом
    // бывает лава (D3-22 03.10: крафт кирки через 5 с после входа — хп 2, «tried to swim in lava»).
    if (!nearAny && process.env.ND_NE_ROUTE !== '1') await spares(600)
    // Дальний бастион с маршрутом из памяти (via): сперва штрек по маршруту до его конца у бастиона — своё время
    // (до 45 мин: ~750 ходов под лавовым морем), потом bastion() на месте.
    // Отказ маршрута или нехватка кирок не означают, что бартер завершён:
    // бастион остаётся нужным, а добор эндерменами ждёт его настоящего прохождения.
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
    // До дальнего бастиона — сотни блоков по Аду: подход в bastion() идёт отрезками, ему нужно время.
    const far = state.pos ? Math.hypot(b.x - state.pos.x, b.z - state.pos.z) : 0
    const r = await act('bastion', { x: b.x, y: b.y, z: b.z, vantage: b.vantage, knownGold: b.gold, knownChests: b.chests, starts: b.starts, timeoutSeconds: process.env.ND_GOLD_FAST_SAFE === '1' ? 720 : 1200 + Math.min(600, Math.round(far)), tripSeconds: far > 200 ? Math.min(480, Math.round(far / 1.3)) : 0, pearls: Math.max(0, eyesWant() - have('ender_eye')), fireRes: 3, ...(process.env.ND_SH_NETHER === '1' ? { obsidian: 10 } : {}), ...(EXIT_KIT ? { exit: false } : {}), sealed: true, ...(process.env.ND_SEALED_BREACH === '1' ? { breach: true } : {}), ...(process.env.ND_GOLD_FAST_SAFE === '1' ? { fastSafe: true } : {}) })
    const d = r.detail || {}
    if (barterFlow.enabled() && barterFlow.retry(d, state.inventory || {})) {
      barterRetryPending = true; bastionDry = 0; bs.dry = 0
      bs.barterUntil = Date.now() + 60000
      log(`${b.key}: золото сохранено, нужен другой этаж/торговцы — повтор без многоминутной паузы`)
      // A temporary routing failure is never an exhaustion checkpoint. Prefer another mapped bastion on the next call.
      break
    }
    if (d.need && d.need.what === 'iron_pickaxe') { ironChestTried = true; log('в сундуках бастиона железа на кирку не хватило — за железом наверх'); break }
    log(`${b.key}: золотых блоков ${d.goldBlocksDug ?? '?'}, слитков пиглинам ${d.ingotsTraded ?? '?'}, в рюкзаке ${JSON.stringify(d.bag || {})}${d.stopped ? ' — ' + d.stopped : ''}`)
    const got = d.goldBlocksDug > 0 || d.ingotsTraded > 0 || (Array.isArray(d.chests) && d.chests.some(c => c && Object.values(c.took || {}).some(n => n > 0)))
    if (!got) { bastionDry++; bs.dry++ } else { bastionDry = 0; bs.dry = 0 }
    const mappedLeft = process.env.ND_GOLD_FAST_SAFE === '1' &&
      ((d.knownGoldLeft ?? d.predLeft ?? 0) > 0 || /золото по памяти осталось|пути.*нет|не дошёл|время вышло|заплатка/.test(d.stopped || ''))
    // ND_GOLD_ROUTE: золото карты почти выбрано (≤ 3 блока), золота в рюкзаке нет, а жемчуга мало — бастион выработан,
    // сразу ко второму (карта: часто в 150–260 бл.), а не пауза и «сухие» заходы (D2-24 03.10: после 9 жемчуга — 4 сухих
    // захода к 28-й мин; бартер 0.064 жемчуга/слиток — одного бастиона часто мало).
    const nearlyDry = process.env.ND_GOLD_ROUTE === '1' && (d.knownGoldLeft ?? d.predLeft ?? 99) <= 3 && have('gold_block') === 0 && have('gold_ingot') < 9 && pearlsNow() < eyesWant()
    if (mappedLeft && nearlyDry) {
      bs.spent = true
      log(`${b.key} выработан (золота карты осталось ${d.knownGoldLeft ?? d.predLeft ?? '?'}, жемчуга ${pearlsNow()} из ${eyesWant()}) — ко второму`)
      await act('remember', { kind: 'прогресс', place: `выработан: ${b.key}`, text: 'Бартер завершён: золото карты выбрано' })
      await refresh()
      continue
    }
    // ND_NE_STAY=1: золото карты осталось, но два захода подряд пустые (недоступно: «видимых блоков больше нет») — бастион
    // выработан, ко второму; иначе этап вставал на паузу 5 мин и тело уходило домой (B1-24 03.10).
    if (mappedLeft && process.env.ND_NE_STAY === '1' && !got && bs.dry >= 2 && have('gold_ingot') + 9 * have('gold_block') < 9) {
      bs.spent = true
      log(`${b.key}: два пустых захода при золоте карты — считаю выработанным, ко второму (ND_NE_STAY)`)
      await act('remember', { kind: 'прогресс', place: `выработан: ${b.key}`, text: 'Бартер завершён: два пустых захода' })
      await refresh()
      continue
    }
    if (mappedLeft) {
      log(`${b.key}: не выработан — осталось золото или путь не закончен`)
      // Ограничить текущую попытку; не записывать постоянный checkpoint «выработан».
      break
    }
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

// Золото на шлем без пиглинов — руины портала верхнего мира: сундук (4–8
// бросков из 398: каждая золотая вещь брони по 15, самородки 4–24, золотое
// яблоко 15, слитки 2–8, обсидиан, огниво, огненный заряд —
// loot_table/chests/ruined_portal.json в server-1.21.11.jar) и золотые блоки
// рамки (structures.js ломает их сам). Один заход, до 650 блоков от портала.
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
  if (!goldOn() && have('gold_ingot') >= 5) { await craft('golden_helmet'); await act('armor') }
  log(`руины: ${JSON.stringify((e.detail && e.detail.took) || {})}; золото на мне: ${goldOn() ? 'да' : 'нет'}`)
  if (known.portal) for (let k = 0; k < 6 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
}

// Золото на шлем — из золотой руды Ада (nether_gold_ore: 2-6 самородков,
// любая кирка). Руда — из #guarded_by_piglins: сломать её на глазах у
// пиглина — разозлить всех в 16 блоках (PiglinAi.angerNearbyPiglins с
// requireLineOfSight). Поэтому — только когда пиглинов не видно.
async function netherGold () {
  for (let i = 0; i < 6 && !goldOn() && dim() === 'the_nether' && !died; i++) {
    const nuggets = have('gold_nugget') + 9 * have('gold_ingot')
    if (nuggets >= 45) break
    const o = await act('observe', { radius: 24 })
    const ents = (o.detail && o.detail.entities) || []
    if (ents.some(e => /^piglin( brute)?$/i.test(String(e.name || '')))) { log('пиглины рядом — золотую руду не трогаю'); break }
    const m = await act('mine', { block: 'nether_gold_ore', count: Math.max(2, Math.ceil((45 - nuggets) / 4)), radius: 40, timeoutSeconds: 120 })
    if (!(m.detail && m.detail.dug)) {
      // explore «уже видно отсюда», а mine не берёт (радиус у explore больше) —
      // не крутить по кругу (2026-09-28, 16:21: шесть кругов за секунду).
      if (/не вижу/.test(String(m.error || '')) && i > 0) break
      // Не видно — разведкой (в Аду золотой руды по ~10 жил на чанк): иначе
      // шлема не было, и бастион отменялся (2026-09-27: «не вижу nether_gold_ore»).
      const e = await act('explore', { block: 'nether_gold_ore', radius: 32, stepDistance: 40, timeoutSeconds: 90 })
      if (!(e.detail && e.detail.found)) break
    }
  }
  await refresh()
  if (have('gold_nugget') >= 9) await craft('gold_ingot', Math.floor(have('gold_nugget') / 9))
  if (have('gold_ingot') >= 5 && !goldOn()) { await craft('golden_helmet'); await act('armor') }
}

// 9. Ад: стержни с блейзов (7 — 12 оков и запас).
// Сколько стержней ещё нужно на недостающие очи (порошок — 2 с стержня; 7 — это 14 очей без единого готового).
// Очей уже на попытку (≥ 10) и жемчуга без порошка нет — за стержнями в Ад не идти: 02.10 (neF-sh-1, слот 25) смерть
// по дороге к крепости унесла одно око в броске, 11 из 12, и кампания пошла в Ад за блейзами при 0 жемчуга.
const rodsShort = () => Math.max(0, Math.ceil((eyesWant() - have('ender_eye') - have('blaze_powder')) / 2) - have('blaze_rod'))
const rodsWanted = () => rodsShort() > 0 && (have('ender_eye') < Math.min(10, EYES_NEED) || have('ender_pearl') > 2 * have('blaze_rod') + have('blaze_powder'))
defStage('nether', () => !!known.portal && rodsWanted(), async () => {
  if (dim() !== 'the_nether') {
    // Золото уже есть (железный заход приносит и его) — шлем сейчас: kit,
    // прерванный уроном, не успевал (2026-09-26, 12:07: 7 слитков, шлема нет).
    await refresh()
    if (!goldOn() && have('gold_ingot') >= 5) { await craft('golden_helmet'); await act('armor') }
    if (!goldOn()) await ruinedPortalGold()
    // До портала — отрезками поверху: portal enter ходит в пределах своих
    // 120 с, а железо и охота уводят за тысячу блоков (12:07 — 1060 блоков).
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) {
        await nightGuard()
        if (await goToward(known.portal, 6)) break
      }
    }
    // Огниво — до портала: без него portal enter в Ад не пускает.
    if (!lighter()) await ensureFlint()
    await baseDeposit()
    // Палки и булыжник на запасные кирки: в Аду незерак стёр железную и три
    // каменные за один поход, а палок не было (2026-09-28, 14:04).
    await sticksReserve()
    // Щит на исходе (< 35%: блок шара ифрита стоит ~6 прочности из 336) — запасной
    // из слитка, пока железо в рюкзаке: 29.09 15:35 бот пошёл к порталу со щитом
    // 23% и слитком в рюкзаке, а бой у спавнера держится на щите.
    if (shieldLow() && !have('shield') && have('iron_ingot')) {
      if (have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
      await craft('shield')
      log(`запасной щит: ${have('shield') ? 'есть' : 'не вышел'}`)
    }
    await act('kit', { for: 'nether' })
    // Кровать в Аду взрывается — пусть сторожит выход наверху: смерть в Аду
    // вернёт к порталу, а не на спавн мира.
    if (have(/_bed$/) && !spawnAtPortal()) await act('sleep', { mode: 'spawn', why: 'у портала в Ад' })
    const e = await enterNether()
    if (!(e.detail && e.detail.went)) throw new Error('в Ад не прошёл')
  }
  // Крепость в памяти — к ней отрезками (пол в Аду держит pathfinder), а не
  // обходом регионов заново: blaze от портала за 470 блоков её не находит.
  // (Путь к крепости из памяти — сам fortress mode=spawner: отрезки legTo.)
  for (let i = 0; i < 6 && !known.fortress; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    // Разведка в Аду идёт сквозь незерак (pathfinder копает прямо, это дёшево)
    // и стирает кирки: за 5 минут — все четыре, 349 незерака в рюкзаке, и
    // нору уже не выкопать (2026-09-26, 14:34). Запас каменных кирок из
    // булыжника — перед каждым заходом (spares: палки, верстак в рюкзаке).
    await spares(260)
    const f = await act('fortress', { timeoutSeconds: 300, ...(SCOUT_HIGH ? { high: true } : {}) })
    if (f.detail && f.detail.found) known.fortress = f.detail.fortress || true
  }
  // Блейзы — у крепости: без неё blaze шесть раз за 30 с отвечал «блейзов в
  // 20 блоках не вижу» (2026-09-26, 17:32). Крепость не нашлась — этап кончен,
  // следующий заход продолжит обход регионов с того же места.
  // Сначала к спавнеру (fortress mode=spawner: спавнер виден клиенту в
  // прогруженных чанках), потом бой (blaze.js лаборатории ждёт старта у
  // спавнера). Три захода, хп < 10 — домой лечиться (rest через портал).
  // Порядок спидраннеров (ND_BASTION_FIRST): к крепости — с огнестойкостью из бартера. Бастион ещё не сдан, а зелий нет
  // — к спавнеру не идти (neF-Sc26-1 02.10: бастион на паузе, тело пошло ногами к спавнеру в 230 бл. без зелья —
  // «tried to swim in lava to escape Ghast» на 8-й мин). Ждём бастион (его пауза кончится раньше).
  // Золото в рюкзаке не отдано (бартер «встал»: D2-21 03.10 — 19 золотых блоков, огнестойкости 0, к спавнеру — смерть от
  // шаров) — тоже сперва бастион: бартер даст и огнестойкость.
  const goldLeft = have('gold_block') * 9 + have('gold_ingot')
  if (BASTION_FIRST && process.env.ND_SPAWNER_TUNNEL === '1' && (!only || only.includes('bastion')) && fireResNow() === 0 && (nextBastion() || goldLeft >= 18) && bastionDry < 3 && !have('blaze_rod')) {
    log(`к крепости без огнестойкости не иду: сперва бастион${goldLeft >= 18 ? ` (золота в рюкзаке ${goldLeft} слитков)` : ''}`)
    return
  }
  // ND_FR_STRICT=1 (поток nether 03.10): к спавнеру — только с зельем огнестойкости в рюкзаке (бой без неё кончался огнём:
  // VR25-1/VR31-1 «burned to a crisp while fighting Blaze»). Нет зелья — сперва бастион/бартер, иначе этап ждёт.
  if (process.env.ND_FR_STRICT === '1' && rodsWanted() && fireResNow() === 0) {
    log(`к спавнеру без огнестойкости не иду (ND_FR_STRICT): зелий 0, золота ${goldLeft} слитков`)
    return
  }
  for (let i = 0; i < 3 && rodsWanted() && known.fortress; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    // ND_FR_STRICT: и каждый следующий заход — только с зельем (ревью Codex ne-deaths.md №3: повтор без огнестойкости).
    if (process.env.ND_FR_STRICT === '1' && fireResNow() === 0) { log('к спавнеру снова не иду: зелий огнестойкости нет (ND_FR_STRICT)'); return }
    // Кирки стёрлись о незерак по дороге к дальнему спавнеру (карта: 400–600 бл.) — запасные из булыжника до проверки
    // готовности, а не после (neF-fort25-1 02.10: «бой у спавнера: не хватает кирки» при 61 булыжнике и 8 палках).
    if (!have(/^(stone|iron|diamond|netherite)_pickaxe$/)) await spares(200)
    if (!fightReady()) {
      if (READY.nether()) {
        fightGearWanted = true
        for (const item of ['iron_chestplate', 'iron_leggings', 'iron_helmet']) if (!worn(ARMOR_SLOT[item.split('_').pop()])) log(gearWorth(item).line)
      }
      log(`бой у спавнера: не хватает ${fightLack()} — сохраняю добытые стержни`)
      return
    }
    if (!(await eatTo(18))) { log('сытость не восстановилась — путь к спавнеру не начинаю'); return }
    await spares(200)
    // Дальний спавнер (карта копии мира — 300–600 бл. от портала): время на дорогу, ~1 бл/с.
    const spFar = known.fortress && known.fortress.x != null && state.pos ? Math.hypot(known.fortress.x - state.pos.x, known.fortress.z - state.pos.z) : 0
    // Лук — до дороги к спавнеру, а не у него: крафт у спавнера (8 с, верстак) — под ударами иссушителя (neF-Sb26-1 02.10:
    // «craft bow → interrupted, бьёт wither_skeleton», хп 12 → 0).
    if (!have('bow') && have('string') >= 3) { await sticks(3); await craft('bow'); await refresh() }
    // ND_SPAWNER_TUNNEL=1 — к известному дальнему спавнеру закрытым штреком (fortress.js toSpawner tunnel), а не ногами legTo.
    const s = await act('fortress', { mode: 'spawner', timeoutSeconds: Math.min(600, 300 + Math.round(spFar / 2)), ...(process.env.ND_SPAWNER_TUNNEL === '1' ? { tunnel: true } : {}) })
    if (!(s.detail && s.detail.reached)) { log(`к спавнеру не дошёл: ${String((s.detail && s.detail.stopped) || s.error || '').slice(0, 120)}`); if (i >= 1) break; continue }
    log(`у спавнера ${JSON.stringify(s.detail.spawner)} (${s.detail.dist} бл.)`)
    if (!(await eatTo(18))) { log('сытость не восстановилась — бой с блейзами не начинаю'); return }
    // Лук из нити бартера (3 нити + 3 палки; бастион до крепости — ND_BASTION_FIRST): блейз в дальнем бою к игроку не
    // подлетает, меч ждёт зря (разбор Codex ne-blaze.md); ферма 02.10 neF-blz-5 (лук + огнестойкость) — 6 стержней за 79 с
    // против 2 убийств/мин мечом. Спектральные стрелы бартера — тоже стрелы (blaze.arrowsHave /arrow$/).
    if (!have('bow') && have('string') >= 3) { await sticks(3); await craft('bow'); await refresh() }
    // Передача 2026-09-28: открытый бой на двойниках 4/4, коробка — ноль
    // стержней. Сразу проверенный способ, без возврата за стрелами.
    await act('blaze', { rods: Math.max(1, have('blaze_rod') + rodsShort()), timeoutSeconds: 400, box: false, ...(have('bow') ? { allowRanged: true } : {}) })
    await refresh()
    log(`стержней: ${have('blaze_rod')}`)
    if ((state.health ?? 20) < 10) break
  }
})

// 10. Жемчуг: бартер, если есть золото и пиглины, иначе эндермены.
// 14, а не 12: брошенные очи теряются и при точном решении (лаборатория
// этапов, TODO.md).
// Охота на эндерменов (окоп) — только с разрешения пользователя (29.09: «жемчуг только
// бартером в бастионе»). ND_ENDERMEN=1 (run-campaign.ps1 -Endermen) включает этап.
const ENDERMEN_OK = process.env.ND_ENDERMEN === '1'
// Эндермены — только добор после всего бартера (решение пользователя 30.09): известные бастионы
// выработаны или сданы (bastionDry), жемчуга с очами меньше нужного — добрать недостачу.
// Бастион остался, но этап бастиона выключен сухими заходами (bastionDry ≥ 3) — добор всё равно (иначе оба
// этапа стоят: ревью Codex 30.09).
defStage('pearls', () => ENDERMEN_OK && !!known.portal && rodsNow() >= 7 && have('ender_pearl') + have('ender_eye') < eyesWant() && ((!nextBastion() && !bastionSearchWanted()) || bastionDry >= 3), async () => {
  // Эндермены — в Аду, в искажённом лесу (мир прохождения: в 32 блоках от
  // портала Ада; на двойнике — 20+ эндерменов в 48 блоках).
  if (dim() !== 'the_nether') {
    if (known.portal && state.pos && Math.hypot(known.portal.x - state.pos.x, known.portal.z - state.pos.z) > 48) {
      for (let k = 0; k < 4 && !died; k++) { await nightGuard(); if (await goToward(known.portal, 6)) break }
    }
    await sticksReserve()
    await act('kit', { for: 'nether' })
    const e = await enterNether()
    if (!(e.detail && e.detail.went)) throw new Error('в Ад не прошёл')
  }
  if (known.netherPortal && state.pos && Math.hypot(known.netherPortal.x - state.pos.x, known.netherPortal.z - state.pos.z) > 48) await goToward(known.netherPortal, 6)
  for (let i = 0; i < 8 && have('ender_pearl') + have('ender_eye') < eyesWant(); i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    if ((state.health ?? 20) < 14 && have(FOOD)) await act('eat')
    // Окоп копает много (яма, стенки из нилия, крыша на выходе): железная и каменная
    // кирки основного ушли за 6 минут охоты (2026-09-29, 17:54–18:00). Запас каменных
    // из булыжника перед каждым заходом, как у блейзов.
    await spares(400)
    // Окопу нужны блоки (засыпка ямки, опора крыши): после бастиона незерака в рюкзаке бывает 0 (chain6-15 30.09:
    // «ямку у окопа не засыпал: нечем строить» ×8 подряд) — набрать незерака рядом.
    // У бастиона незерак в открытую не копаем (бруты рядом; разбор Codex 30.09).
    if (fillersNow() < 12 && !nearBastion(state.pos, 90)) {
      await act('mine', { block: 'netherrack', count: 24, radius: 8, timeoutSeconds: 90 })
      await refresh()
    }
    if (fillersNow() < 6) { log(`блоков на окоп нет (${fillersNow()}) — охоту не начинаю`); break }
    // Окоп и «подкрасться» (pearls.js huntFoxhole): яма в 1 блок с крышей строится
    // в 1–3 блоках от спокойного эндермена, и он бьётся мечом из ямы — луча к
    // нам нет, ответить не может. Ферма 29.09 (foxhole-13, 12 слотов, ~7 мин):
    // 22 убийства, 11 жемчуга, 0 смертей. Дуэль (duel-keep-2/3): 0.9 смерти и
    // 1.2 жемчуга на прогон — смерть почти всегда от второго злого.
    await act('pearls', { count: eyesWant() - have('ender_eye') - have('ender_pearl'), timeoutSeconds: 400, style: 'foxhole' })
    await refresh()
    log(`жемчуг: ${have('ender_pearl')} (+очей ${have('ender_eye')})`)
  }
})

// 11. Око эндера: порошок из стержней, око из жемчуга и порошка.
// 14, а не 12: рамок пустых обычно 11–12 (с оком каждая с шансом 10%), и
// броски find разбивают око в 20% (двойник 2: 12 пустых рамок, 10 глаз после find).
defStage('eyes', () => have('ender_eye') < eyesWant() && have('ender_pearl') > 0 && (have('blaze_rod') + have('blaze_powder')) > 0, async () => {
  const want = Math.min(eyesWant() - have('ender_eye'), have('ender_pearl'))
  if (have('blaze_powder') < want) await craft('blaze_powder', Math.min(2 * have('blaze_rod'), want - have('blaze_powder') + 1))
  await craft('ender_eye', Math.min(want, have('blaze_powder')))
})

// Стрелы: кремень (гравий, 10% за блок) + перо (курица, 0–2) + палка → 4.
// Без стрел блейзов из коробки не взять: «стрелы кончились, а к окну коробки
// блейзы не подлетают» (кампания 2026-09-28, 13:58: 0 стержней за 400 с при 2
// стрелах; лаборатория — 64 стрелы на 7 стержней).
async function arrowsRun (want = 48) {
  const t0 = Date.now()
  for (let k = 0; k < 24 && arrowsNow() < want && !died && Date.now() - t0 < 12 * 60000; k++) {
    await nightGuard()
    await refresh()
    if (have('stick') < 1) await sticks(4)
    if (!have('flint')) {
      // Гравий в рюкзаке — поставить и сломать (10% кремня за раз).
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
    const c = await craft('arrow', 4)
    await refresh()
    if (c && c.status && c.status !== 'done') break
  }
  log(`стрелы: ${arrowsNow()} (перьев ${have('feather')}, кремня ${have('flint')})`)
}

// 12а. Набор на дракона — до дороги к крепости (всё несём с собой). Агент
// дракона (TODO.md, «Дракон как отдельный этап»): кровати 6–8 (станция у
// фонтана — ~60 урона за кровать), лук и 32–64 стрелы (кристаллы), ведро воды
// (сброс со столба у клетки), от 44 блоков, еда от 6, 1–2 золотых яблока.
// 01.10: бой только кроватями — станция у центрального столба (dragon.js
// pillarPlan, ферма pil9 24/24): ~10 кроватей на бой, с запасом 20; опора и
// заслон — обсидиан или плачущий, от 4. Лук и стрелы бою не нужны (добивание —
// если есть), набор их больше не ждёт.
// 03.10: станция раннера + меч — 5 кроватей 40/42 (rs8/rs9), 4 — 70 %; берём 5 + 1 запас (было 20: деревни и овцы — долго)
const BEDS_END = 5 // 03.10: с кристаллами 4 кровати — 18/21 и 18/21 (ca3, проверка xda1), берём 4 + 1 запас
const OBSIDIAN_END = 4
const obsidianEnd = () => have('obsidian') + have('crying_obsidian')
const ARROWS_END = 32
// Агент дракона (~65 боёв с набором кампании, 30.09): два ведра воды (второе — сброс со столба у
// клетки), +64 блока стройки к 44 (мост и столбы у клеток съедают 64 — бот копал эндерняк посреди боя).
const BUCKETS_END = 2
const FILL_END = 108
const END_FILL_RE = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone)$/
const fillNow = () => have(END_FILL_RE)
const arrowsNow = () => have('arrow') + have('spectral_arrow')
let endkitRuns = 0
// ND_ENDKIT=0 — без набора на дракона (лаборатория dev-F «вход в Ад → вход в Энд»: набор — забота потока дракона).
const ENDKIT_OFF = process.env.ND_ENDKIT === '0'
// Боевые кровати не оставлять точками возрождения; после дороги проверять набор заново.
// ND_END_SEAM=0 — прежний контракт (для сравнения). ND_ENDKIT=0 — лаборатория отдельного этапа.
const END_SEAM = process.env.ND_END_SEAM !== '0'
function endCoreLack () {
  return [
    have(/_bed$/) < BEDS_END ? `beds:${have(/_bed$/)}/${BEDS_END}` : '',
    obsidianEnd() < OBSIDIAN_END ? `obsidian:${obsidianEnd()}/${OBSIDIAN_END}` : '',
    have('water_bucket') < BUCKETS_END ? `water:${have('water_bucket')}/${BUCKETS_END}` : '',
    fillNow() < FILL_END ? `blocks:${fillNow()}/${FILL_END}` : ''
  ].filter(Boolean)
}
async function checkEndEntry () {
  if (!END_SEAM || ENDKIT_OFF) return
  await eatTo(18)
  if ((state.health ?? 0) < 16) await rest()
  await refresh()
  if (died) return
  const lack = [...endCoreLack(),
    have(FOOD) < FOOD_STOCK ? `food:${have(FOOD)}/${FOOD_STOCK}` : '',
    !have(/_sword$/) ? 'sword:0/1' : '',
    !have(/^(iron|diamond|netherite)_pickaxe$/) ? 'pick:0/1' : '',
    (state.health ?? 0) < 16 ? `hp:${state.health ?? 0}/16` : '',
    (state.food ?? 0) < 18 ? `hunger:${state.food ?? 0}/18` : ''
  ].filter(Boolean)
  if (lack.length) {
    const msg = `END_SEAM_NOT_READY: ${lack.join(', ')}; сборов ${endkitRuns}/3 — в Энд не вхожу`
    log(`БЛОКЕР: ${msg}`)
    throw Object.assign(new Error(msg), { stopCampaign: true, code: 'END_SEAM_NOT_READY' })
  }
  // Лук/стрелы и яблоки — не выдача kit и не обязательная механика входа. Неполный профиль явно отмечаем.
  if (!have('bow') || arrowsNow() < ARROWS_END || have(/^(enchanted_)?golden_apple$/) < 3) {
    log(`РИСК END_PROFILE: лук ${have('bow')}, стрел ${arrowsNow()}/${ARROWS_END}, яблок ${have(/^(enchanted_)?golden_apple$/)}/3; броня ${JSON.stringify(state.armor || {})} — это не набор campaign2 с Protection II`)
  }
}
const endkitPending = () => END_SEAM
  // Очи уже скрафчены — стержни как условие больше не нужны (карта комнаты бывает на 7 пустых рамок).
  // В Аду сперва выйти у крепости; наверху собрать набор. Сохранённая комната сборы не отменяет.
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
  // Вёдра: по 3 железа на ведро (руда, что видно; разведка — если нет). Два ведра воды.
  const bucketsLack = () => Math.max(0, BUCKETS_END - have('water_bucket') - have(/^bucket$/))
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
  // Блоки стройки на Край: камень рядом (из Ада обычно несём незерак и чернокамень — яма оставляет 128).
  if (fillNow() < FILL_END) {
    const m = await act('mine', { block: 'stone,deepslate,andesite,diorite,granite,tuff', count: Math.min(64, FILL_END - fillNow()), radius: 24, timeoutSeconds: 120 })
    await refresh()
    log(`блоки на Край: ${fillNow()} из ${FILL_END}${m.detail && m.detail.dug ? '' : ' (не добыл)'}`)
  }
  // Золотые яблоки — из золота, что осталось после жемчуга (8 слитков + яблоко), до двух.
  for (let k = 0; k < 2 && have('golden_apple') < 2 && have('apple') > 0 && have('gold_ingot') + 9 * have('gold_block') >= 8 && !died; k++) {
    if (have('gold_ingot') < 8 && have('gold_block')) await craft('gold_ingot', 9)
    const n = have('golden_apple')
    await craft('golden_apple')
    await refresh()
    if (have('golden_apple') <= n) break
  }
  // Кровати — сперва из деревни (так делают спидраннеры: кровать в каждом
  // доме жителя), structures.js village берёт до p.beds; потом — овцы.
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
  // Кровати: овцы — охота за шерстью (одного цвета по 3), доски — из брёвен.
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
  // Лук: 3 нити + 3 палки. Стрелы: кремень (гравий) + перо (курица) + палка → 4.
  if (!have('bow') && have('string') >= 3) { await sticks(3); await craft('bow') }
  for (let k = 0; k < 8 && arrowsNow() < ARROWS_END && have('feather') && !died; k++) {
    if (!have('flint')) {
      const g = await act('mine', { block: 'gravel', dry: true, count: 6, radius: 40, timeoutSeconds: 120 })
      if (!(g.detail && g.detail.dug)) break
      await refresh()
      if (!have('flint')) continue
    }
    await sticks(2)
    const c = await craft('arrow', 4)
    if (c && c.status !== 'done') break
  }
  // Лодка — через озёра и море по дороге к крепости (ферма: к крепости A с
  // севера «воды 94–96+ блоков по прямой»; endportal.walkOrBridge плывёт сам).
  if (!have(/_boat$/)) {
    if (have(/_planks$/) < 5 && !have(LOGS)) await lumber(3)
    if (have(/_planks$/) < 5) { const p = planksFor(); if (p) await craft(p, 8) }
    await act('ride', { kind: 'boat', mode: 'craft' })
    await refresh()
  }
  // Обсидиан на станцию у столба: плачущий бастион оставляет (bastion JUNK_KEEP),
  // не хватает — добыть алмазной киркой, как этап obsidian.
  if (obsidianEnd() < OBSIDIAN_END && have(/^(diamond|netherite)_pickaxe$/) && !died) {
    await act('obsidian', { count: OBSIDIAN_END - obsidianEnd(), radius: 24, timeoutSeconds: 300 })
  }
  log(`набор на дракона: кроватей ${have(/_bed$/)}, обсидиана ${obsidianEnd()}, стрел ${arrowsNow()}, вёдер воды ${have('water_bucket')}, блоков ${fillNow()}, золотых яблок ${have('golden_apple')}, лук ${have('bow') ? 'есть' : 'нет'}, лодка ${have(/_boat$/) ? 'есть' : 'нет'}`)
})

// 12. Домой из Ада и к крепости.
// Через Ад к дальней крепости Края (SPEEDRUN.md «Дорога к крепости через Ад»): блок Ада — 8 верхнего мира, поэтому
// 1400–2700 блоков поверху (первое кольцо) — это 175–340 по Аду штреком и рама у точки крепость/8 (stronghold travel:
// 10 обсидиана + огниво, выход в ~16–24 блоках от цели). ND_SH_NETHER=1 — так; иначе прежнее «поверху отрезками».
// ND_SH_BLIND=1 — ещё и слепой выход прямо из Ада (крепость не известна): рама на радиусе ~1750 по своему лучу
// (stronghold.blindPlan), броски ока уже наверху. Включать по умолчанию — только после замера (dev-F).
const SH_NETHER = process.env.ND_SH_NETHER === '1'
const SH_BLIND = process.env.ND_SH_BLIND === '1'
const SH_NETHER_MIN = 500
let shNetherTries = 0
const canLink = () => pendingExitFrame() || (shNetherTries < 2 && lighter() && (have('obsidian') >= 10 || have(PICK_DIAMOND) > 0))
// Не начинаем длинную дорогу с изношенными кирками и без переносного верстака.
// Крафты напрямую: отказ тесного места не должен отправлять тело наверх.
async function prepareExitSupply (T) {
  await refresh(); await sense()
  const n = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
  const me = state.pos || n
  const want = Math.ceil(2 * (Math.abs(n.x - me.x) + Math.abs(n.z - me.z))) + 128
  // Fully made tools already cover the journey: loose sticks are materials,
  // not an additional gate after those materials have become pickaxes.
  if ((sit.pickLeft || 0) >= want && have('crafting_table')) return true
  const until = Date.now() + 180000
  const step = async (method, args = {}) => {
    if (died || Date.now() >= until) return null
    const p = { ...args }
    if (p.timeoutSeconds) p.timeoutSeconds = Math.max(1, Math.min(p.timeoutSeconds, Math.floor((until - Date.now()) / 1000)))
    const r = await act(method, p); await refresh(); return r
  }
  log('набор на выход: пополнение ≤180 с; сначала сундуки и железо, затем чёрный камень; дерево из сундука ≤20 с, стебли ≤60 с')
  if (sit.foes) {
    const r = await step('ne_burrow', { why: 'набор на выход: крафт под укрытием', timeoutSeconds: 30 })
    if (!r?.detail?.ok) { log('набор на выход: укрытие не подтвердилось — пополнение не начинаю'); return false }
    await sense()
  }
  // Structure loot first. An iron block/nuggets are not a shortage of iron.
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
  while (!died && Date.now() < until && have(/_planks$/) < planksNeeded() && have(LOGS)) {
    const item = planksFor(); if (!item) break
    const before = have(/_planks$/); await step('craft', { item, count: 4 })
    if (have(/_planks$/) <= before) break
  }
  if (!have('crafting_table') && have(/_planks$/) >= 4) await step('craft', { item: 'crafting_table', count: 1 })
  if (!have('crafting_table')) return false
  const sticks = 4 * Math.ceil(Math.max(0, 2 * picks - have('stick')) / 4)
  if (sticks && have(/_planks$/) >= sticks / 2) await step('craft', { item: 'stick', count: sticks })
  // Blackstone is a stone-tool ingredient in 1.21.11; the bastion is the first
  // source at this seam. The existing mine action keeps pick/LOS validation.
  for (let i = 0; i < picks && !died && Date.now() < until; i++) {
    await sense()
    if ((sit.pickLeft || 0) >= want) break
    // Craft the iron pick before mining blackstone: it is also the bootstrap
    // when all old picks have broken (col04N3ax25, iron nuggets still in bag).
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
  if (sit.foes) { log('набор на выход: сначала закончить бой, крафт не начинаю'); return false }
  const n = { x: Math.floor(T.x / 8), z: Math.floor(T.z / 8) }
  const me = state.pos || n
  const want = Math.ceil(2 * (Math.abs(n.x - me.x) + Math.abs(n.z - me.z))) + 128
  // Два блока на шаг штрека + 128 ударов на спуск/проходы у комнаты.
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
  const ok = (sit.pickLeft || 0) >= want && have('stick') >= 12 && !!have('crafting_table')
  log(`набор на выход: обсидиан ${have('obsidian')}/10, огонь ${lighter() ? 'есть' : 'нет'}, удары кирок ${sit.pickLeft || 0}/${want}, палки ${have('stick')}/12, верстак ${have('crafting_table')}; ${ok ? 'готов' : 'нужно пополнить, пешком домой не иду'}`)
  return ok
}
// К точке верхнего мира T (x, z) через Ад: свой портал → штрек к T/8 → рама там (travel, цель «задано») → выход.
// true — вышли наверх у T (≤ 160 бл.).
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
    const e = await enterNether()
    await refresh()
    if (!(e.detail && e.detail.went) || dim() !== 'the_nether') { log(`${why}: в Ад не вошёл`); return false }
  }
  if (dim() !== 'the_nether') return false
  // Без 10 обсидиана — алмазной киркой разобрать раму прибытия (travel takeFrame) прямо отсюда.
  if (have('obsidian') >= 10) {
    await goToward({ x: N.x, z: N.z }, 6)
    await refresh()
    if (died || dim() !== 'the_nether') return false
  }
  for (let k = 0; k < 2 && dim() === 'the_nether' && !died; k++) {
    const obsBefore = have('obsidian')
    const t = await act('stronghold', { mode: 'travel', x: T.x, z: T.z, go: false, timeoutSeconds: 420 })
    await refresh()
    const td = t.detail || {}
    if (dim() === 'the_nether' && have('obsidian') < obsBefore && (td.build || td.link)) exitFrameTarget = { ...T }
    if (dim() === 'overworld') exitFrameTarget = null
    log(`${why}: travel — ${dim() === 'overworld' ? 'вышел наверх' : 'ещё в Аду'}${td.stopped ? ': ' + td.stopped : ''}`)
  }
  await readMemory()
  return dim() === 'overworld' && !!state.pos && Math.hypot(T.x - state.pos.x, T.z - state.pos.z) <= 160
}
defStage('stronghold', () => dim() !== 'the_end' && (have('ender_eye') >= Math.min(10, EYES_NEED) || !!known.endPortal) && (!known.endPortal || process.env.ND_END_ENTRY !== '0') && !endkitPending(), async () => {
  if (known.endPortal && process.env.ND_END_ENTRY !== '0') {
    if (dim() !== 'overworld') return
    await act('stronghold', { mode: 'room', timeoutSeconds: 120 })
    await act('stronghold', { mode: 'fill', enter: true, timeoutSeconds: 90 })
    await refresh()
    return
  }
  // Из Ада — домой и сразу выйти из этапа: следующий ход сперва соберёт набор
  // на дракона (endkit — наверху, до дороги к крепости), и только потом сюда.
  if (dim() === 'the_nether') {
    // Крепость известна — сразу к ней через Ад; не известна — слепой выход (ND_SH_BLIND).
    // ND_SH_STAY=1: вышли наверх у крепости — дальше в этом же ходе (комната), а не выход из этапа: следующий ход
    // выбирал wood (дерева нет) и уводил прочь (D7-25 03.10: 10 очей и выход у крепости на 43.5 мин, потом 12 мин поиска
    // брёвен в 170 бл. от крепости, ночь, смерть).
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
  // Далеко (> SH_NETHER_MIN) и есть чем связать портал — через Ад (ND_SH_NETHER); не вышло — поверху, как раньше.
  if (SH_NETHER && known.stronghold && state.pos && dim() === 'overworld' && !died && canLink() &&
    Math.hypot(known.stronghold.x - state.pos.x, known.stronghold.z - state.pos.z) > SH_NETHER_MIN) {
    await viaNetherTo({ x: known.stronghold.x, z: known.stronghold.z }, 'к крепости Края')
    await refresh()
    if (dim() === 'the_nether') { await returnFromNether(); return }
  }
  // Дальняя дорога (до 1800+ блоков поверху) — отрезками goToward (64 блока,
  // обход под углом, ночь — в нору/кровать); room сам ходит только последние
  // сотню-другую блоков: его goStronghold за 300 с на 1800 блоков не успевает,
  // а ночь не пережидает. Точка — угол чанка старта из find.
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
  // Точка возрождения — у крепости (кровать из набора на дракона остаётся
  // стоять): смерть в коридорах (крипер, чешуйницы, лава у рамок — ферма, 3 из
  // 5 подходов к крепости A) вернёт сюда, а не к порталу за 1800 блоков.
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
    // Дорога к крепости — сотни и тысячи блоков поверху: ночь — в нору/кровать. Под землёй (крепость, лесенка к ней)
    // ночь не мешает: neF-shn-3 02.10 — тело на y −34 у крепости 7 мин пересидело ночь в норе.
    if (dim() === 'overworld') { await sense(); if (sit.surface) await nightGuard() }
    const r = await act('stronghold', { mode: 'room', timeoutSeconds: 500 })
    if (r.detail && r.detail.room) { known.endPortal = r.detail.room.centre || r.detail.room; break }
    if (process.env.ND_ROOM_MAP !== '0' && require(path.join(__dirname, 'src/stronghold')).mappedRoom(known.stronghold)) {
      log(`подход к комнате по карте остановлен: ${(r.detail || {}).stopped || r.error || 'нет прогресса'} — одинаковый вызов в этом ходе не повторяю`)
      break
    }
    // Крепость под морем (endportal.goStronghold: над лестницей старта вода,
    // суши рядом нет, или на прямой к ней море без берега) — у кольца 0 ещё две
    // крепости, на ±120° от 0,0, радиус 1408..2688 (ChunkGeneratorStructureState).
    // Дойти до ближайшей из двух точек на радиусе ~1900 и бросить око оттуда:
    // оно покажет ту крепость. Мир прохождения: ближайшая к порталу — под морем
    // (правда /locate для сверки), вторая — на суше.
    const went = r.detail && r.detail.went
    const ocean = went && went.ocean
    // Море — только на прямой к крепости (сама она на суше: двойник мира
    // прохождения, −1616,−1632 с северо-востока — «воды 94+ блоков»): обойти
    // крюком вбок на 150 блоков от середины пути, по очереди с двух сторон.
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
    await refresh()
    log(`вход в Энд после комнаты: ${(r.detail || {}).entered && dim() === 'the_end' ? 'подтверждён' : 'не завершён'}`)
  }
})
let altTried = false
let detours = 0

// Итоги этапов, у которых «не нужен» бывает и без итога (см. DONE у defStage).
DONE.prep = () => shieldOn() && lighter() && foodUnits() >= FOOD_STOCK && (spawnAtPortal() || have(/_bed$/) > 0)
DONE.nether = () => !rodsWanted()
DONE.bastion = () => pearlsNow() >= eyesWant() && !obsShort() && (!barterFlow.enabled() || process.env.ND_FR_STRICT !== '1' || !rodsWanted() || fireResNow() >= 2)
DONE.pearls = () => have('ender_pearl') + have('ender_eye') >= eyesWant()
DONE.eyes = () => have('ender_eye') >= eyesWant()
DONE.endkit = () => have(/_bed$/) >= BEDS_END && obsidianEnd() >= OBSIDIAN_END && have('water_bucket') >= BUCKETS_END &&
  have(/_boat$/) > 0 && fillNow() >= FILL_END
DONE.stronghold = () => process.env.ND_END_ENTRY !== '0' ? dim() === 'the_end' : !!known.endPortal

// 13. Энд: сборы, точка у портала, вставить очи и войти, дракон.
// Портал уже зажжён — глаза для входа не нужны: после смерти в Энде (все глаза
// в рамках) этап раньше не выбирался вовсе — «have ender_eye > 0».
defStage('dragon', () => !known.dragonWon && (dim() === 'the_end' || !!known.endPortal), async () => {
  if (dim() !== 'the_end') {
    // Из Ада (возрождение у портала, дорога) — сперва наверх.
    if (dim() === 'the_nether' && !(await returnFromNether())) return
    // Комната далеко (возродились у кровати) — дойти до неё: fill зовёт с 12
    // блоков, а издалека отвечает «сначала дойди».
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
    if (!(f.detail && f.detail.entered)) throw new Error('в Энд не вошёл')
  }
  for (let i = 0; i < 6 && !known.dragonWon; i++) {
    if (died || dim() !== 'the_end') return
    const r = await act('dragon', { timeoutSeconds: 600 })
    if (r.detail && r.detail.dragon && r.detail.dragon.won) { known.dragonWon = true; log('ДРАКОН УБИТ') }
  }
})

// ------------------------------------------------------------------- ход

ws.on('open', async () => {
  try {
    await act('connect')
    await act('play_mode', { mode: 'speedrun', foodTarget: FOOD_STOCK })
    await act('set_goal', { text: 'Пройти игру честно: дерево → камень → еда → железо → вода → алмазы → обсидиан → портал → Ад → жемчуг → око → крепость → дракон' })
    await refresh()
    await readMemory()
    // Курс прогулок — прочь от спавна мира: звери там выбиты прошлыми
    // заходами, а новый (случайный) курс после перезапуска водил обратно
    // (2026-09-26, 09:06: с -137,-559 назад к -67,-455).
    if (!known.portal && state.pos && Math.hypot(state.pos.x, state.pos.z) > 32) heading = Math.atan2(state.pos.z, state.pos.x)
    log(`старт: ${bag()}${known.portal ? `; портал в памяти ${known.portal.x},${known.portal.y},${known.portal.z}` : ''}`)
    seamSnapshot('start')
    // Политика повторов (решение пользователя 30.09, research/05-synthesis.md F.3-2, H3). Провал не маскируем:
    // каждый пустой заход, пауза и РИСК пишутся в журнал своим классом, сцены фермы их считают. Но локальный
    // провал не останавливает прогон: два пустых захода подряд — пауза этапа 5 мин, каждый следующий пустой после
    // паузы — 10, 20, 40 (потолок). Паузы сбрасываются полезным результатом этапа, сменой измерения, смертью и
    // рассветом — обстановка другая, прежний отказ ничего не говорит. «Нет доступного шага» — ожидание (нора ночью,
    // минута днём), а не остановка. Неудачная нора — РИСК и жить дальше (shelterFailed). Единственный останов
    // кампании — сторож: WATCHDOG_MIN (45) минут без ВЕХИ и без полезного результата ни в одном этапе.
    const fails = new Map()
    const cooling = s => { const f = fails.get(s.name); return !!f && f.until > Date.now() }
    const failStage = name => {
      const f = fails.get(name) || { n: 0, level: 0, until: 0 }
      f.n++
      f.at = Date.now()
      if (f.n >= (f.level ? 1 : 2)) {
        // ND_NE_STAY=1: в Аду паузы короткие (1–4 мин) — 5–40 мин ожидания съедали прогон (B2 03.10: 4 тела по 15+ мин в толще).
        const PM = process.env.ND_NE_STAY === '1' && dim() === 'the_nether' ? [1, 2, 3, 4] : PAUSE_MIN
        const min = PM[Math.min(f.level, PM.length - 1)]
        f.until = Date.now() + min * 60000
        f.level++
        f.n = 0
        log(`этап ${name}: ${f.level > 1 ? 'снова пустой заход' : 'два пустых захода подряд'} — пауза ${min} мин`)
      }
      fails.set(name, f)
    }
    const resetPauses = why => { if (fails.size) { log(`паузы этапов сняты: ${why}`); fails.clear() } }
    let lastProgressAt = Date.now()
    let lastDim = dim()
    let wasNight = !!sit.night
    for (let turn = 1; turn <= 5000; turn++) {
      await refresh()
      await sense()
      if (state.playPolicy?.mode === 'free') { log('режим free — кампания уступает управление игроку'); break }
      // Тело выпало из игры (связь оборвалась, не наш disconnect) — переподключить, а не крутить этапы на пустом
      // рюкзаке «бот не в игре» до сторожа (fresh-A2 слот 8, 30.09: связь пропала на 24-й мин, 43 мин пустых ходов).
      if (state.connected === false) {
        stage = '-'
        log('тело не в игре — переподключаюсь')
        await act('connect')
        await refresh()
        if (state.connected === false) await sleep(30000)
        continue
      }
      if (dim() !== lastDim) { resetPauses(`смена измерения ${lastDim} → ${dim()}`); await readMemory(); seamSnapshot(`observed:${lastDim}->${dim()}`); lastDim = dim() }
      if (wasNight && !sit.night && dim() === 'overworld') resetPauses('рассвет')
      wasNight = !!sit.night
      // Умер между этапами (в ожидании, по дороге домой из Ада) — возрождение и вещи сразу (recoverGuard сбрасывает
      // died). Иначе флаг смерти висел до следующего этапа, ожидание «нет шага» пропускалось, и ходы крутились по
      // 250 в секунду до лимита 5000 — выход кампании (fresh-A2 слот 7, 30.09, 96-я мин, обсидиан на подходе).
      if (died) {
        stage = '-'
        try { await recoverGuard() } catch (e) { if (e.stopCampaign) throw e; log(`после смерти: ${e.message}`) }
      }
      // Сторож прогресса — единственная остановка кампании.
      if (Date.now() - lastProgressAt >= WATCHDOG_MIN * 60000) {
        stage = '-'
        log(`БЛОКЕР: сторож — ${Math.round((Date.now() - lastProgressAt) / 60000)} мин без прогресса ни в одном этапе (последний этап ${lastStage}); останавливаю кампанию`)
        await act('stop')
        process.exitCode = 2
        break
      }
      const turnStart = Date.now()
      // В Аду и Энде — только свои этапы: дерево, камень, еда и железо — этапы
      // верхнего мира. 2026-09-26 (14:34): кирки стёрлись о незерак, и первым
      // «нужным» оказалось дерево — разведка за брёвнами по Аду кончилась на
      // y=24 в лаве. Там без кирки — сперва кирка из булыжника (ensurePick).
      if (dim() !== 'overworld' && !have(/_pickaxe$/)) { stage = '-'; await ensurePick() }
      const need = STAGES.filter(s => !(only && !only.includes(s.name)) && s.needed() && (dim() === 'overworld' || OTHER_WORLD.has(s.name)))
      if (dim() === 'the_nether' && need.some(s => s.name === 'nether') && (!READY.nether() || (fightGearWanted && !fightReady()))) {
        stage = '-'
        log(`для ифритов не хватает ${fightGearWanted ? fightLack() : netherLack()} — домой за недостающим`)
        await returnFromNether()
        continue
      }
      if (!need.length && dim() === 'the_nether') {
        stage = '-'
        log('в Аду делать нечего (кирки нет или стержни есть) — домой через портал')
        // Сначала дойти: portal enter ходит в своих 120 с, и из 94 блоков трижды
        // не успел (2026-09-26, 17:34-17:38).
        await returnFromNether()
        continue
      }
      if (!need.length) {
        stage = '-'
        if (known.dragonWon) { log('все этапы готовы'); break }
        // Фильтр этапов (node campaign.js bastion) — список пройден: конец запуска, а не ожидание.
        if (only) { log(`нужных этапов нет среди ${only.join(',')} — запуск окончен (дракон жив: жемчуга ${pearlsNow()} из ${EYES_NEED}, очей ${have('ender_eye')})`); break }
        // Нужных этапов нет, а дракон жив (бастион сдался, эндермены закрыты) — не победа: ждать перемены
        // (паузы, рассвет), остановит сторож.
        log(`нужных этапов нет, а дракон жив (жемчуга ${pearlsNow()} из ${EYES_NEED}, очей ${have('ender_eye')}) — жду перемены, остановит сторож`)
        if (dim() === 'overworld') await leaveWater()
        await act('wait', { seconds: 60 })
        continue
      }
      // Ранен и есть нечего — еда первой, мимо порядка (act бросает прочие этапы).
      // Пауза еды тут не держит: ранен и голоден — хп не восстановится ожиданием (реген — с сытости 18), а прочие
      // этапы act бросит сразу («сначала еда»). Пустые охоты подряд остановит сторож. Но не чаще раза в 90 с:
      // охота, отказавшая за секунду (не вышел наверх), иначе крутится по ходу в секунду (fresh-A2 слот 15:
      // 30 ходов еды за минуту).
      const foodFail = fails.get('food')
      const urgentOk = x => !cooling(x) || !foodFail || Date.now() - (foodFail.at || 0) > 90000
      const urgent = weakAndHungry() ? need.find(x => x.name === 'food' && urgentOk(x) && x.ready() && !x.defer()) : null
      const s = urgent || need.find(x => !cooling(x) && x.ready() && !x.defer())
      if (!s) {
        stage = '-'
        // В Аду нечем, а наверху есть что делать (железо на кирку для бастиона) —
        // домой, а не блокер с отключением посреди Ада (29.09 16:19, у спавнера).
        const upNeed = dim() === 'the_nether' ? STAGES.filter(x => !(only && !only.includes(x.name)) && !OTHER_WORLD.has(x.name) && x.needed()) : []
        // ND_NE_STAY=1: этапы Ада только на паузе (не «нечем») — ждать паузу в толще Ада, а не домой: B1-24 03.10 — бастион и
        // ифриты на паузе 5 мин → «домой за: wood» → портала в памяти нет → кампания вышла на 17-й мин.
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
        const paused = need.filter(x => cooling(x)).map(x => Math.ceil((fails.get(x.name).until - Date.now()) / 60000))
        const blocked = need.every(x => !x.defer() && (cooling(x) || !x.ready()))
        log(`${blocked ? 'нет доступного шага' : 'нужные этапы отложены'} (${need.map(x => `${x.name}${cooling(x) ? '·пауза' : ''}${x.ready() ? '' : '·нечем'}${x.defer() ? '·отложен' : ''}`).join(', ')}) — жду${paused.length ? `: ближайшая пауза кончится через ${Math.min(...paused)} мин` : ' изменения обстановки'}`)
        // Ждать ночью наверху — в норе, не посреди поля. В Аду не ждать —
        // домой через портал.
        // ND_NE_STAY=1: этапы на паузе — ждать в толще Ада, а не дорога домой и назад (B0-32: «пауза 1 мин» → портал туда-обратно).
        if (dim() === 'the_nether' && process.env.ND_NE_STAY === '1') { await act('ne_burrow', { why: 'жду конца паузы' }); await refresh() } else
        if (dim() === 'the_nether') await returnFromNether()
        else if ((sit.night || (NIGHT_DOWN2() && sit.dusk)) && sit.surface && dim() === 'overworld') await nightGuard({ dusk: true })
        // Ход без ожидания (нора не нужна или не вышла, портал не дошёл) — всё равно ждать: иначе круг ходов
        // без паузы жжёт процессор до сторожа.
        // Ждать — не в воде (A4 слот 20: wait 60 в реке, утопленник добил за три ожидания).
        if (Date.now() - turnStart < 20000) { if (dim() === 'overworld') await leaveWater(); await act('wait', { seconds: 60 }) }
        continue
      }
      stage = s.name
      lastStage = s.name
      log(`ход ${turn}: начинаю; рюкзак: ${bag()}`)
      const before = stageProgress(s.name)
      try {
        await recoverGuard()
        await s.run()
      } catch (e) {
        if (e.stopCampaign) throw e
        log(`этап упал: ${e.message}`)
      }
      if (manualControl) break
      await refresh()
      await sense()
      await readMemory()
      const off = !s.needed()
      const ok = off && s.done()
      const after = stageProgress(s.name)
      const progressed = Object.entries(after).some(([key, value]) => value > (before[key] || 0))
      if (!off && s.defer()) {
        log(`этап отложен (${s.name === 'food' ? 'ночь — охота с рассветом' : 'не сейчас'}); рюкзак: ${bag()}`)
        continue
      }
      log(`итог этапа: ${ok ? 'готов' : off ? 'снят без итога (сдан или нельзя)' : 'НЕ ГОТОВ'}; рюкзак: ${bag()}`)
      if (off) {
        fails.delete(s.name)
        if (ok) {
          lastProgressAt = Date.now()
          log(`ВЕХА ${s.name}: готово в ${new Date().toTimeString().slice(0, 8)}, ${Math.round((Date.now() - T0) / 60000)} мин от запуска`)
        }
      } else if (progressed) {
        fails.delete(s.name)
        lastProgressAt = Date.now()
        log('частичный полезный результат — продолжаю без ожидания и отката')
      } else if (s.name === 'bastion' && barterFlow.enabled() && barterRetryPending) {
        barterRetryPending = false
        fails.delete(s.name)
        log('бартер: золото есть — 15 с в закрытом укрытии и другой поиск, FR-гейт сохраняю')
        await act('ne_burrow', { why: 'бартер: смена торговцев' })
        await sleep(15000)
      } else failStage(s.name)
      if (died) { log('умер — проверяю, какие ресурсы действительно потеряны'); resetPauses('смерть') }
    }
  } catch (e) {
    log(`прогон упал: ${e.stack || e.message}`)
    process.exitCode = 1
  } finally {
    // Тело без мозга в мире — лёгкая добыча: 2026-09-29 11:15 после остановки
    // кампании зомби убил стоявшего NeuroRun. Уходя (блокер, падение, конец),
    // убираю тело из мира; исключение — free, управление у живого игрока.
    // Отключение само отменяет текущее намерение (session.disconnect → cancel).
    if (!detached && !manualControl && state.playPolicy?.mode !== 'free') {
      try {
        await Promise.race([call('disconnect', { reason: 'кампания завершена' }), sleep(15000)])
        log('кампания завершена — бот отключён от сервера')
      } catch (e) { log(`disconnect RPC-ОШИБКА ${e.message}`) }
    }
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
