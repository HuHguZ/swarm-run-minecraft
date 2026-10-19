'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
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
import * as fs from 'fs'
import path = require('path')
const WebSocket = require("C:\\Users\\user\\Desktop\\work\\minecraft-claude\\daemon\\node_modules\\ws")

const WS = process.env.ND_WS || 'ws://127.0.0.1:8769'
const LOG = process.env.ND_CAMPAIGN_LOG || path.join(REPO_ROOT, 'farm/stronghold_route/campaign.log')
const only = process.argv[2] ? process.argv[2].split(',') : null

const ws = new WebSocket(WS)
let rid = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
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
const sleep = ms => new Promise<any>(r => setTimeout(r, ms))

const T0 = Date.now()
let stage = '-'
let manualControl = false
let state: Record<string, any> = {} as Record<string, any>
let sit: Record<string, any> = {} as Record<string, any>
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
  const inv = state.inventory || {} as Record<string, any>
  return Object.entries<any>(inv).map(([k, v]: any) => `${k}×${v}`).join(' ') || 'пусто'
}

let lastDeathSeen
function acceptResult (r) {
  const event = r.by?.type === 'death' ? r.by : (r.events || []).find(e => e.type === 'death')
  const stamp = r.state?.lastDeathAt
  const changed = stamp && lastDeathSeen !== undefined && stamp !== lastDeathSeen
  if (event || changed) {
    lostBag = state.inventory || {} as Record<string, any>
    lostAt = event?.pos || state.pos || null
    died = true
  }
  // Первое чтение задаёт исходную запись: прежняя смерть не прерывает запуск.
  if (stamp !== undefined) lastDeathSeen = stamp
  if (r.state) state = r.state
}

// Один вызов намерения: лог, состояние, события, которые важны прогону.
async function act (method, params: any = {} as Record<string, any>) {
  let r
  try {
    r = await call(method, params)
  } catch (e) {
    log(`${method} RPC-ОШИБКА ${e.message}`)
    return { status: 'failed', error: e.message, detail: {} as Record<string, any> }
  }
  acceptResult(r)
  if (stage !== '-' && state.playPolicy?.mode === 'free') {
    manualControl = true
    throw new Error('игрок переключил free — передаю управление, кампанию прекращаю')
  }
  const d = r.detail || {} as Record<string, any>
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
  const evs = (r.events || []).filter(e => /death|УМЕР|fleeing|retaliat|no_tool|buried|stuck|looted|dimension/.test(e.type))
  if (evs.length) bits.push(`события: ${evs.map(e => e.type).join(',')}`)
  if (r.by) bits.push(`прервано: ${r.by.type}`)
  const p = state.pos ? `(${state.pos.x},${state.pos.y},${state.pos.z})` : ''
  log(`${method} ${JSON.stringify(params)} → ${r.status} hp${Math.round(state.health ?? 0)} еда${state.food ?? '?'} ${p} ${bits.join(' | ')}`)
  if (died && stage !== '-' && method !== 'stop') throw new Error('умер — этап прерван, следующий шаг выбираю после возрождения')
  // Лава, увиденная по дороге (observe на охоте, explore) — запомнить: портал
  // льётся у лавы, а искать её вслепую — прогулка на полчаса.
  if (dim() === 'overworld' && r.detail) {
    // blocks у разных намерений — разное (у observe массив, у копки — число):
    // «(r.detail.blocks || []).find is not a function» валил этап железа.
    const seenLava = (Array.isArray(r.detail.blocks) ? r.detail.blocks : []).find(b => b && b.name === 'lava') ||
      (r.detail.found === 'lava' && r.detail.at ? { nearest: r.detail.at } : null)
    if (seenLava && seenLava.nearest && !known.lava) {
      known.lava = seenLava.nearest
      log(`видел лаву на ${known.lava.x},${known.lava.y},${known.lava.z} — запомнил`)
      try { await call('remember', { kind: 'лава', text: `лава на ${known.lava.x},${known.lava.y},${known.lava.z}`, place: 'лава' }) } catch {}
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
    try { await answerThreat() } finally { fighting = false }
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
const SELF_GUARDED = new Set(['fight', 'flee', 'blaze', 'pearls', 'dragon', 'sleep', 'bastion'])
let died = false
let lostBag = null
let lostAt = null
let resting = false
let fighting = false

// Обстановка у демона (director.situation): под крышей, ночь, враги, вердикт.
async function sense () {
  try {
    const r: any = await call('situation')
    acceptResult(r)
    if (r.detail) sit = r.detail
  } catch (e) { log(`situation RPC-ОШИБКА ${e.message}`) }
  return sit
}

async function answerThreat () {
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
  // Бьют, а врага не видно (скелет в темноте пещеры дальше 16 блоков,
  // assess его не считает) — не стоять: закопаться, нора с крышкой закрывает
  // и от стрел. Так умер прогон 2026-09-26: «was shot by Skeleton».
  if (!sit.foes) {
    if (!sit.inWater && dim() !== 'the_end') await act('shelter', { mode: 'enter', depth: 2 })
    return
  }
  const first = sit.first || {} as Record<string, any>
  if (first.swelling) { await act('flee', { timeoutSeconds: 15 }); return }
  // Стрелок, а в левой руке щит: бежать — значит подставлять спину (обе смерти
  // 2026-09-26 — «shot by Skeleton», вторая на бегу с 8 хп). Щит гасит стрелы
  // спереди, и fight сам поднимает его на сближении со стрелком.
  const shield = have('shield') > 0 || /shield/.test(JSON.stringify(state.offHand || ''))
  if (first.ranged && shield && sit.armed && (state.health ?? 20) >= 5) {
    await act('fight', { timeoutSeconds: 45, retreatAtHealth: 4, shield: 'always' })
    return
  }
  if (sit.armed && (state.health ?? 20) >= 10 && sit.verdict !== 'уходить') {
    const f = await act('fight', { timeoutSeconds: 45, retreatAtHealth: 7 })
    if (f.detail && (f.detail.kills || f.detail.killed)) log(`отбился: ${JSON.stringify(f.detail.kills || f.detail.killed)}`)
    return
  }
  const f = await act('flee', { timeoutSeconds: 40 })
  // Прижали — бежать некуда: драться тем, что есть.
  if (f.detail && f.detail.cornered && sit.armed) await act('fight', { timeoutSeconds: 40, retreatAtHealth: 4 })
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
      if (sit.inWater) await abortUnsafe('не вышел из воды — лечение ожиданием небезопасно')
    }
    log(`мало хп (${Math.round(state.health)}) — прячусь и отлёживаюсь`)
    // Враг рядом — сначала ответить (бой или бег по вердикту), потом в нору.
    // Нора — всегда, не только ночью наверху: в пещере стреляют из темноты.
    if (sit.foes > 0) { fighting = true; try { await answerThreat() } finally { fighting = false } }
    if (died) return
    // Днём без еды нора ничего не лечит (регенерация — с сытости 18): лечение
    // тут — охота. Иначе каждая прогулка за животными кончалась норой и
    // пятнадцатью секундами ожидания (2026-09-26, 8 хп, сытость 17).
    await sense()
    if (!have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 && !sit.night) {
      log('еды нет, день — лечит только охота, иду')
      // Не звать отлёжку на каждом шаге охоты, пока нечем лечиться (act).
      restIdleUntil = Date.now() + 60000
      return
    }
    // Поесть сразу: автопилот ест, только когда тело свободно, а тут шаг за
    // шагом — бегство, нора, ожидание. 2026-09-26 бот умер на 6 хп с десятью
    // кусками жареного в рюкзаке. Сытость ≥18 — это и есть лечение.
    // Сырое — сперва в печь (печь в рюкзаке): жареное втрое сытнее.
    if (have(RAW) && !sit.foes) await cook()
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
        const r = await act('sleep', { untilMorning: true, take: false, bunker: false,
          invite: false, waitSeconds: 10, timeoutSeconds: 60 })
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
    // лечиться — домой через портал (mc_portal enter сам дойдёт до рамы).
    // 2026-09-26 (11:31-11:32) бот дважды отлёживался в Аду на 6-7 хп, горел,
    // и умер, так и не дойдя до портала в 120 блоках.
    if (dim() === 'the_nether' && known.netherPortal) {
      log('в Аду мало хп — домой через портал, лечиться там')
      const h = await act('portal', { mode: 'enter', timeoutSeconds: 120 })
      if (h.detail && h.detail.went) {
        if ((have(FOOD) || have(RAW)) && (state.food ?? 20) < 20) await act('eat')
        for (let i = 0; i < 12 && (state.health ?? 20) < 16 && !died; i++) {
          const w = await act('wait', { seconds: 10 })
          if (w.by && w.by.type === 'damage') break
          if ((state.food ?? 20) < 18 && (have(FOOD) || have(RAW))) await act('eat')
        }
        return
      }
    }
    // Нора в камне — только киркой: без неё «stone голыми руками не
    // ломается», и ночь на 1 хп в неглубокой яме (2026-09-26, 13:31). Кирка —
    // из того, что в рюкзаке (ensurePick).
    if (!have(/_pickaxe$/)) await ensurePick()
    if (!(await restShelter())) return
    // Лечит только сытость ≥18 (FoodData.tick): без еды стоять бесполезно —
    // автопилот доест сам, если есть что.
    for (let i = 0; i < 24 && (state.health ?? 20) < 16 && !died; i++) {
      // Сытость ниже 18 не лечит (FoodData.tick), а один кусок сырого — это
      // +2: доедать, пока есть что. Иначе нора ждала шесть минут на сытости
      // 17 с бараниной в рюкзаке (2026-09-26, 08:26).
      if ((state.food ?? 20) < 18 && (have(FOOD) || have(RAW))) await act('eat')
      // Урон посреди ожидания act разбирает сам (answerThreat); здесь — только
      // зарыться заново, если нору вскрыли.
      const w = await act('wait', { seconds: 15 })
      if (w.by && w.by.type === 'damage' && !died && !(await restShelter())) return
      if ((state.food ?? 20) < 18 && !have(FOOD) && !have(RAW)) {
        // Лечиться нечем. Ночью — сидеть в норе до утра: выйти на 5 хп в
        // темноту за едой — смерть (2026-09-26, «shot by Skeleton» на 1 хп).
        await sense()
        if (sit.night && dim() === 'overworld') {
          log('еды нет, ночь — сижу в норе до утра')
          for (let k = 0; k < 40 && !died; k++) {
            const w2 = await act('wait', { seconds: 30 })
            if (w2.by && w2.by.type === 'damage' && !died && !(await restShelter())) return
            await sense()
            if (!sit.night) break
          }
        }
        log('еды нет — лечиться нечем, иду за едой')
        break
      }
    }
    if (!died) await act('shelter', { mode: 'exit' })
  } finally { resting = false }
}

const closedShelter = r => r.status === 'done' && r.detail?.sealed === true
async function restShelter () {
  let r = await act('shelter', { mode: 'enter', depth: 3 })
  // Нора не закрылась (вода, край, ферма 30.09 chain1-8: «я в воде — тут не окопаешься» на 12 хп → БЛОКЕР и
  // отключение): выйти наверх и попробовать ещё раз; не вышло, а хп не критичное — лечиться едой без норы.
  if (!closedShelter(r)) {
    try { await act('surface', { targetY: y() + 2, timeoutSeconds: 30, preferPillar: false }) } catch {}
    r = await act('shelter', { mode: 'enter', depth: 3 })
  }
  if (!closedShelter(r)) {
    await refresh()
    if ((state.health ?? 0) >= 8) { log(`нора не закрылась, хп ${Math.round(state.health)} — дальше без отлёжки`); restIdleUntil = Date.now() + 90000; return false }
    await abortUnsafe('укрытие не закрыто — лечение ожиданием небезопасно')
  }
  return true
}
let detached = false
async function abortUnsafe (reason) {
  reason = `БЛОКЕР: ${reason}`
  log(reason)
  // Отменить работу и убрать своё тело из опасности, пока мозг остановлен.
  // Управляющие вызовы не запускают отлёжку или новую реакцию на урон.
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
  const inv = state.inventory || {} as Record<string, any>
  let n = 0
  for (const [k, v] of Object.entries<any>(inv)) if (typeof re === 'string' ? k === re : re.test(k)) n += v
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
const { foodUnits: unitsOfFood } = require("C:\\Users\\user\\Desktop\\work\\minecraft-claude\\daemon\\src\\play-policy")
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
  const inv = state.inventory || {} as Record<string, any>
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
const known: Record<string, any> = { portal: null, netherPortal: null, fortress: null, bastion: null, stronghold: null, endPortal: null, dragonWon: false, spawnBed: null }
async function readMemory () {
  try {
    const r: any = await call('recall', { lines: 1 })
    const places = { ...((r.detail && r.detail.state && r.detail.state.places) || {} as Record<string, any>) }
    // Ферма (сцена кампании на копии мира): места из ND_EXTRA_PLACES (JSON) поверх памяти тела.
    if (process.env.ND_EXTRA_PLACES) { try { Object.assign(places, JSON.parse(process.env.ND_EXTRA_PLACES)) } catch {} }
    known.portal = places['портал'] || null
    known.netherPortal = places['портал (ад)'] || null
    known.fortress = places['крепость (ад)'] || known.fortress
    known.bastion = places['бастион (ад)'] || known.bastion
    // Бастионы по порядку: первый — «бастион (ад)», дальше «бастион 2 (ад)», «бастион 3 (ад)».
    known.bastions = BASTION_KEYS.filter(k => places[k]).map(k => ({ key: k, ...places[k] }))
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
const canWorkAtNight = () => sit.foes === 0 && !sit.inWater && !sit.buried &&
  (state.health ?? 0) >= 16 && (state.food ?? 0) >= 14 &&
  (!sit.surface || have(/_(sword|axe)$/) > 0 || stage === 'wood' || stage === 'stone')
let nightWorkSaidAt = 0
async function nightGuard () {
  if (guarding) return
  guarding = true
  try { await nightGuardBody() } finally { guarding = false }
}
async function nightGuardBody () {
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
  if (!(sit.night || (sit.dusk && bed))) return
  if (!bed && canWorkAtNight()) {
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
    if (!sit.inWater && canWorkAtNight()) { log('на суше, угроз нет — работаю ночью'); return }
    s = await act('shelter', { mode: 'enter', depth: 3 })
  }
  if (!closedShelter(s)) await abortUnsafe('обе норы не закрыты — ночное ожидание небезопасно')
  for (let i = 0; i < 40; i++) {
    await act('wait', { seconds: 30 })
    if (died) return
    await sense()
    if (!sit.night) break
  }
  await act('shelter', { mode: 'exit' })
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
  // По Аду далеко — закрытым штреком на высоте ~40 (tunnel.js): пешком тело падало в лаву и с обрывов
  // (ферма 30.09: до второго бастиона гибло в каждой второй попытке). Не вышло — пешком, как раньше.
  if (fromWorld === 'the_nether' && state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) > 60 && !died) {
    const far = Math.hypot(p.x - state.pos.x, p.z - state.pos.z)
    // Бастионы позади — железную кирку беречь не для чего: кончатся каменные — копать и ею (ironOk).
    const via = netherVia(state.pos, p)
    const t = await act('nether_tunnel', { x: p.x, y: p.y, z: p.z, radius: Math.max(range, 5), ...(via.length ? { via } : {} as Record<string, any>), ironOk: !nextBastion(), timeoutSeconds: Math.min(via.length ? 2700 : 1800, Math.round(120 + far * (via.length ? 3 : 1.6))) })
    await refresh()
    if (died || dim() !== fromWorld) return false
    if (state.pos && Math.hypot(p.x - state.pos.x, p.z - state.pos.z) <= range + 2) return true
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
    const r = await act('goto', { x: leg.x, ...(direct && typeof p.y === 'number' ? { y: p.y } : {} as Record<string, any>), z: leg.z, range: direct ? range : Math.min(range, 8), timeoutSeconds: 120 })
    turn = r.status === 'done' ? 0 : turn + 1
    if (turn >= detour.length) return false
  }
  return false
}

async function returnFromNether () {
  if (dim() !== 'the_nether') return dim() === 'overworld'
  await unclutter()
  if (known.netherPortal) await goToward(known.netherPortal, 4)
  // Урон/возрождение или попадание в раму на пути уже могли сменить мир.
  // Повторный enter в таком случае отправлял голого бота обратно в Ад.
  if (dim() !== 'the_nether') return dim() === 'overworld'
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
    if (Object.keys(state.inventory || {} as Record<string, any>).length >= 3) { log('умер, но вещи при мне (keep_inventory) — к делу'); return }
    // Дождаться возрождения: до него state.pos — ещё место смерти, и
    // «далеко ли куча» выходило 0 блоков при 750 настоящих (2026-09-26, 13:17).
    // Куча из дерева, камня и меди не стоит дороги: 2026-09-26 (09:14) после
    // смерти в 900 блоках от спавна recover пошёл через ночь к тому же озеру
    // с утопленником — за двумя каменными кирками. Идти — только за железом,
    // золотом, алмазами, вёдрами, бронёй, кроватью, жемчугом и стержнями, и
    // не дальше 400 блоков (куча живёт 5 минут).
    const worth = Object.keys(lostBag || {} as Record<string, any>).filter(k => /iron|gold|diamond|obsidian|bucket|_bed$|ender|blaze|shield|bow|arrow|flint_and_steel|netherite|emerald|cooked_/.test(k))
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
  const list = await act('chest_list', {} as Record<string, any>)
  if (list.status !== 'done') {
    if (!have('chest')) {
      if (have(/_planks$/) < 8) { const p = planksFor(); if (p) await craft(p, 8) }
      await craft('chest')
    }
    if (have('chest')) await act('place', { block: 'chest' })
  }
  const keep = { iron_ingot: 2, cobblestone: 96 }
  const put = []
  for (const [k, v] of Object.entries<any>(state.inventory || {} as Record<string, any>)) {
    if (keep[k] !== undefined && v > keep[k]) put.push([k, v - keep[k]])
    else if (/^(raw_iron|raw_copper|raw_gold|diamond|lapis_lazuli|coal)$/.test(k)) put.push([k, v])
  }
  const food = Object.entries<any>(state.inventory || {} as Record<string, any>).filter(([k]: any) => FOOD.test(k)).sort((a, b) => a[1] - b[1])
  let extra = have(FOOD) - 16
  for (const [k, v] of food) { if (extra <= 0) break; const n = Math.min(v, extra); put.push([k, n]); extra -= n }
  if (have('stone_pickaxe') > 2) put.push(['stone_pickaxe', have('stone_pickaxe') - 2])
  for (const [item, count] of put) await act('chest_put', { item, count })
  if (put.length) { baseStocked = true; log(`база: в сундук — ${put.map(([k, n]: any) => k + '×' + n).join(', ')}`) }
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
  if (died || !/дойдёт до меня|блоках (впереди|позади|снизу|сверху)|бл. (снизу|сверху)/.test(why)) return false
  log(`моб мешает работе — отвечаю: ${why.slice(0, 80)}`)
  fighting = true
  try { await answerThreat() } finally { fighting = false }
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
  if (woodNow() < 8) await lumber(10)
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

async function descend (toY) {
  const dirs = ['north', 'east', 'south', 'west']
  await reserve()
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
    const d = await act('dig_down', { mode: 'stairs', depth: Math.min(24, y() - toY), torchEvery: have('torch') ? 8 : 0, direction: dirs[i % 4], timeoutSeconds: 300 })
    if (await mobInTheWay(d)) continue
    if (died) return
    if (d.detail && ((d.detail.dug ?? 0) >= 3 || (d.detail.steps ?? 0) >= 2) && !d.detail.stopped) continue
    const why = String((d.detail && d.detail.stopped) || d.error || '')
    // Вода рядом (берег озера): вокруг та же вода, и лесенка на все четыре
    // стороны отвечала «вода у … — дальше не копаю», пока утопленники били с
    // дистанции (2026-09-26, девять минут на одном месте, 18 → 2 хп). Уйти от
    // воды — прочь от названной клетки на 24 блока, поверху, — и копать там.
    const wet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(why)
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
    // Сверху вода (дно озера): подъём отходит на 4 и упирается снова. Уйти
    // штреком на 10 прочь от названной воды (штрек воду не вскрывает) и лезть
    // оттуда — 2026-09-26 подъём на y=91 под озером четырежды ответил одно и то же.
    const wet = /вода у (-?\d+),(-?\d+),(-?\d+)/.exec(String((r.detail && r.detail.stopped) || ''))
    if (wet && state.pos) {
      const dx = state.pos.x - +wet[1]
      const dz = state.pos.z - +wet[3]
      const dir = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 'east' : 'west') : (dz >= 0 ? 'south' : 'north')
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
  // Портал уже горит (после смерти в Аду) — вёдра не нужны: кирка (золото
  // Ада), щит (шары блейзов), нагрудник и меч — в Ад. Шлем — золотой (пиглины).
  // Броня — раньше кирки: железа мало, а без поножей и шлема бой у спавнера
  // смертелен (ферма 2026-09-29); кирки из булыжника пока хватает.
  const plan = known.portal ? [
    ['flint_and_steel', 1, () => !have('flint_and_steel') && have('flint') > 0],
    ['shield', 1, noShield],
    ['iron_chestplate', 8, () => !worn('torso')],
    ['iron_sword', 2, () => !have(/^(iron|diamond|netherite)_sword$/)],
    ['iron_leggings', 7, () => !worn('legs')],
    ['iron_helmet', 5, () => !worn('head')],
    ['iron_boots', 4, () => !worn('feet')],
    ['iron_pickaxe', 3, () => !have(PICK_IRON)],
    ['bucket', 3, () => have(/bucket$/) < 1]
  ] : [
    ['bucket', 3, () => have(/bucket$/) < 1],
    ['flint_and_steel', 1, () => !have('flint_and_steel') && have('flint') > 0],
    ['bucket', 3, () => have(/bucket$/) < 2],
    ['shield', 1, noShield],
    ['iron_pickaxe', 3, () => !have(PICK_IRON)],
    ['iron_chestplate', 8, () => !worn('torso')],
    ['iron_sword', 2, () => !have(/^(iron|diamond|netherite)_sword$/)],
    ['bucket', 3, () => have(/bucket$/) < 3],
    ['iron_leggings', 7, () => !worn('legs')],
    ['iron_boots', 4, () => !worn('feet')],
    ['iron_helmet', 5, () => !worn('head')]
  ]
  for (const [item, cost, want] of (plan as Array<any>)) {
    await refresh()
    // Слиток на огниво держим, пока огнива нет: кремень найдётся позже, а без
    // огнива отлитую раму нечем зажечь, а в Ад portal enter без него не пускает.
    const keep = (item !== 'flint_and_steel' && !have('flint_and_steel') && !have('fire_charge')) ? 1 : 0
    if (!want() || have('iron_ingot') < cost + keep) continue
    if (item === 'shield' && have(/_planks$/) < 6) { const p = planksFor(); if (p) await craft(p, 8) }
    if (/_(pickaxe|sword)$/.test(item)) await sticks(2)
    await craft(item)
  }
  await act('armor')
}
function worn (slot) {
  const a = state.armor || {} as Record<string, any>
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
const weakAndHungry = () => (state.health ?? 20) < 12 && !have(FOOD) && !have(RAW) && (state.food ?? 20) < 18 && !sit.night
let ironRuns = 0
let ironLeg = 0 // сквозной номер штрека этапа iron (змейка между заходами)
const READY = {
  stone: () => have(/_pickaxe$/) > 0,
  // Сытость 15 без еды — ещё можно: ночь в норе без дела стоит девяти минут,
  // а внизу теперь есть ответы на то, от чего умирали (урон рвёт добор,
  // пещерную руду не берём, от воды уходим, без еды ночью сидим в норе).
  iron: () => have(PICK_STONE) > 0 && fed(3, 15),
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
  nether: () => have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0 &&
    worn('torso') && shieldOn() && foodUnits() >= netherFoodNeed() && ((worn('legs') && worn('head')) || ironRuns >= 8),
  // Эндермены и пиглины — не с каменным мечом без брони.
  // Кирка тут ни при чём — нужен меч не хуже железного (29.09 16:19: кирка
  // стёрлась о незерак, и при 7 стержнях и железном мече — «pearls·нечем»).
  pearls: () => (have(PICK_IRON) > 0 || have(/^(iron|diamond|netherite)_sword$/) > 0) && worn('torso'),
  // Золотой блок — только железной киркой (needs_iron_tool); без брони в
  // бастион не ходят (бруты, злые пиглины).
  // Без железной кирки — один заход за железом в сундуки бастиона (bastion.js chestsOnly: основному не хватает
  // 2 самородков, в двух сундуках железо с P≈0.77), уже в Аду; не вышло — наверх, этап железа.
  bastion: () => (have(PICK_IRON) > 0 || (!ironChestTried && dim() === 'the_nether' && have('iron_ingot') + have('raw_iron') + have('iron_nugget') / 9 >= 1)) && worn('torso') && (foodUnits() >= 6 || (state.food ?? 0) >= 18)
}
// Чего именно не хватает для READY.nether: журнал писал «еды/щита/брони», а
// не хватало стёртой о незерак кирки (2026-09-29, 12:22).
// Еды на бой у спавнера — 6 кусков, но за последним стержнем (или двумя) хватит
// трёх: 29.09 16:10 при 6 стержнях из 7 и 5.17 куска бот пошёл за едой домой —
// 460 блоков по Аду в одну сторону.
function netherFoodNeed () { return rodsNow() >= 5 ? 3 : 6 }
const netherLack = () => [
  have(/^(stone|iron|diamond|netherite)_pickaxe$/) > 0 ? '' : 'кирки',
  worn('torso') ? '' : 'нагрудника',
  shieldOn() ? '' : 'щита',
  (worn('legs') && worn('head')) || ironRuns >= 8 ? '' : 'поножей или шлема',
  foodUnits() >= netherFoodNeed() ? '' : `еды (${foodUnits()} из ${netherFoodNeed()})`
].filter(Boolean).join(', ') || 'ничего'
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
    (sit.night && !sit.surface && foodUnits() >= 4),
  // Воду искать ходьбой поверху — днём; ночью с железной киркой — вниз за
  // алмазами (они воды не ждут, ждёт только обсидиан).
  water: () => nightWork() && have(PICK_IRON) > 0,
  // Лаву искать поверху ночью — это ходить среди мобов; под землёй — можно.
  cast: () => sit.night && sit.surface && dim() === 'overworld'
}
function defStage (name, needed, run) { STAGES.push({ name, needed, run, ready: READY[name] || (() => true), defer: DEFER[name] || (() => false) }) }

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
  const result: Record<string, any> = {} as Record<string, any>
  const re = resources[name]
  if (re) for (const [item, count] of Object.entries<any>(state.inventory || {} as Record<string, any>)) if (re.test(item)) result[item] = count
  for (const key of ['portal', 'fortress', 'stronghold', 'endPortal', 'dragonWon']) result[`known:${key}`] = known[key] ? 1 : 0
  if (dim() === 'the_end') result.end = 1
  return result
}

// 1. Дерево: 14 брёвен (верстак, палки, кирка, топливо печи, щит, кровать),
// доски, верстак, палки, деревянная кирка.
defStage('wood', () => !have(/_pickaxe$/) ||
  (!!known.portal && rodsNow() < 7 && woodNow() < 4 && (!shieldOn() || !worn('torso'))), async () => {
  const recovering = !!known.portal
  const want = recovering ? 4 : 14
  // Утро в норе (после ночи или смерти) — сначала наружу: из-под крышки
  // деревьев не видно («не вижу any_log»).
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  for (let i = 0; i < 10 && woodNow() < want; i++) {
    await nightGuard()
    await recoverGuard()
    // Внизу (штрек, колодец) деревьев нет — наверх: киркой из запаса или
    // рукой (toSurface → ensurePick → surface hand:true). 2026-09-26 (12:59)
    // этап дерева на y=29 искал брёвна по штрекам.
    await sense()
    if (!sit.surface && (!sit.night || canWorkAtNight()) && dim() === 'overworld' && !(await toSurface())) break
    const m = await act('mine', { block: 'any_log', count: want - woodNow(), radius: 48, timeoutSeconds: 240 })
    if (woodNow() >= want) break
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
  const want = 24
  for (let i = 0; i < 8 && have(COBBLE) < want; i++) {
    await nightGuard()
    await recoverGuard()
    if (died) return
    const m = await act('mine', { block: 'stone', count: want - have(COBBLE), radius: 32, timeoutSeconds: 180 })
    if (have(COBBLE) >= want) break
    if (m.detail && m.detail.dug) continue
    const d = await act('dig_down', { mode: 'stairs', depth: 10, torchEvery: 0, timeoutSeconds: 180 })
    if (d.detail && d.detail.steps) continue
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
const nightWork = () => sit.night && !canWorkAtNight() && (state.food ?? 20) >= 12 && have(PICK_STONE) > 0 && !have(/_bed$/)
// Сырое — тоже еда: его жарят (cook) там же, где печь; этап, считавший только
// жареное, гнал наверх с шестью кусками баранины в рюкзаке (2026-09-26, 10:26).
// Охота не бросается ради охоты (act: «ранен и голоден — сначала еда»).
const FOOD_STOCK = 8
defStage('food', () => foodUnits() < FOOD_STOCK || !have(/_bed$/), async () => {
  hunting = true
  try { await foodRun() } finally { hunting = false }
})
async function foodRun () {
  await cook()
  await makeBed()
  const woolMax = () => Math.max(0, ...Object.entries<any>(state.inventory || {} as Record<string, any>).filter(([k]: any) => /_wool$/.test(k)).map(([, v]: any) => v))
  const wantWool = () => (huntWool || !have(/_bed$/)) && have(/_bed$/) + Math.floor(woolMax() / 3) < wantBeds
  if (foodUnits() >= FOOD_STOCK && !wantWool()) return
  const deadline = Date.now() + 120000
  if (!(await toSurface())) { log('за едой не вышел на поверхность — сначала устранить причину подъёма'); return }
  // Без места под новое мясо даже успешный бой не даёт запас еды.
  await unclutter()
  // Раз уж наверху — вода, если видно (иначе за ней отдельный подъём с -54).
  if (have(/^bucket$/) && !have('water_bucket')) await act('bucket', { fluid: 'water', radius: 32 })
  await lumber(4)
  let blocked = false
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
          ...(kind === 'sheep' && wantWool() ? { resourceGoal: { item: 'wool', count: wantBeds * 3 } } : {} as Record<string, any>) })
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
      const w = await walkAway(64, blocked ? Math.PI / 2 : 0)
      blocked = !(w && w.status === 'done')
    }
    await makeBed()
  }
  await cook()
  await makeBed()
}

// Кровать из 3 шерсти одного цвета + 3 досок. Две: одна остаётся точкой
// возрождения (nightGuard, take:false), другая — в рюкзаке на следующую ночь.
async function makeBed () {
  if (have(/_bed$/) >= Math.max(2, wantBeds)) return
  if (have(/_wool$/) < 3) return
  await unclutter()
  const inv = state.inventory || {} as Record<string, any>
  let wool = Object.entries<any>(inv).filter(([k]: any) => /_wool$/.test(k)).sort((a, b) => b[1] - a[1])[0]
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
    wool = Object.entries<any>(state.inventory || {} as Record<string, any>).filter(([k]: any) => /_wool$/.test(k)).sort((a, b) => b[1] - a[1])[0]
  }
  if (!wool || wool[1] < 3) return
  if (have(/_planks$/) < 3) { const p = planksFor(); if (p) await craft(p, 4) }
  await craft(wool[0].replace(/_wool$/, '_bed'))
}

// Пожарить всё сырое. Печь: в рюкзаке, рядом или из 8 булыжника (smelt сам).
// Топливо: уголь; нет — брёвна сверх двух; нет — доски сверх восьми.
async function cook () {
  await refresh()
  const raw = () => Object.keys(state.inventory || {} as Record<string, any>).filter(k => RAW.test(k))
  if (!raw().length) return
  // Сначала — печью, что есть: smelt сам находит поставленную рядом (прошлая
  // готовка оставила её стоять). Булыжник на новую — только если не вышло:
  // иначе 20 с «не вижу stone» и лесенка, а печь стояла в восьми блоках
  // (2026-09-26, 09:48).
  for (const r of raw()) await smeltAll(r, `cooked_${r}`)
  await refresh()
  if (!raw().length || have('furnace') || have(COBBLE) >= 8) return
  await act('mine', { block: 'stone', count: 8, radius: 32, timeoutSeconds: 120 })
  if (have(COBBLE) < 8) await act('dig_down', { mode: 'stairs', depth: 6, torchEvery: 0, timeoutSeconds: 120 })
  for (const r of raw()) await smeltAll(r, `cooked_${r}`)
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
  (!!known.portal && (!worn('torso') || !worn('legs') || !worn('head') || (rodsNow() >= 7 && !have(PICK_IRON)))) ||
  (!known.portal && !have(/bucket$/)), async () => {
  ironRuns++
  // Сколько железа нужно — по тому, чего нет: кирка 3, нагрудник 8, щит 1,
  // ведро 3 (на дракона — ведро воды), до портала — ещё два ведра и огниво.
  // До стержней железная кирка не требуется: незерак и открытый бой идут с
  // каменной. В шахту за заменой — после стержней, к золоту бастиона.
  // Раньше всегда 17: кирка стёрлась в Аду при надетом нагруднике — и 25 минут
  // штреков за 12 слитками (2026-09-28, 14:27-14:50).
  const want = known.portal
    ? Math.max(3, (have(PICK_IRON) ? 0 : 3) + (worn('torso') ? 0 : 8) + (worn('legs') ? 0 : 7) + (worn('head') ? 0 : 5) + (shieldOn() ? 0 : 1) + ((have(/bucket$/) || have('water_bucket')) ? 0 : 3))
    : 17 // с нагрудником; для литья портала хватит 11 (кирка, два ведра, щит, огниво)
  const ironNow = () => have(/^(raw_iron|iron_ingot)$/) + 9 * have('iron_block') + 9 * have('raw_iron_block')
  // Сначала поверху, днём: железо выходит на склонах (верхняя трапеция руды
  // 80..384 с пиком на 232 — worldmap ORES; холмы у спавна до y=120), и
  // склон при свете безопаснее штреков — все шесть смертей 2026-09-26 были
  // внизу. Видно сквозь отсечку теперь честно (sight.visibleOf).
  await sense()
  if (weakAndHungry()) { log(`хп ${Math.round(state.health ?? 0)} и еды нет — вниз не иду, сначала охота`); return }
  // Сырое — пожарить до спуска: внизу лечит только жареное (сытость ≥ 18).
  await cook()
  if ((state.food ?? 20) < 18 && have(FOOD)) await act('eat')
  if (ironNow() < want && sit.surface && !sit.night && dim() === 'overworld') {
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
  if (ironNow() < want && y() > 24) { await sense(); if (sit.surface && !sit.night) await lumber(8) }
  if (ironNow() < want && y() > 24) await descend(16)
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
    const t = await act('tunnel', { direction: ironDir(ironLeg++), length: 32, torchEvery: have('torch') ? 8 : 0, timeoutSeconds: 300 })
    // Штрек встал из-за моба рядом («creeper в 5.1 блоках впереди, дойдёт до
    // меня за 4 шага») — ответить ему, а не крутить штрек по четырём сторонам:
    // 2026-09-26 (12:48) весь заход железа кончился за секунду, крипер стоял.
    if (await mobInTheWay(t)) continue
    await mineSeenAll('iron_ore')
    await mineSeenAll('deepslate_iron_ore')
    // Золото на шлем (пиглины не трогают игрока в золотой вещи — PiglinAi.
    // isWearingSafeArmor): без него 2026-09-27 (00:04) у крепости — «slain by
    // Piglin». Руда в стенах штрека — брать сразу (железная кирка есть).
    if (known.portal && have(PICK_IRON) && !goldOn() && have(/^(raw_gold|gold_ingot)$/) < 5) await mineSeenAll('gold_ore,deepslate_gold_ore')
    // Штрек вскрыл пещеру — руда на её стенах видна глазами (sight.visibleOf).
    await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: 8, radius: 32, timeoutSeconds: 150 })
    // Оглядеться: штрек вскрывает пещеры, а в них бывает лава — её место
    // запомнит act (портал льётся у лавы, и искать её потом вслепую не придётся).
    if (!known.lava && !known.portal) await act('observe', { radius: 32 })
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
  if (have('raw_iron') && !have(/^(coal|charcoal)$/) && woodNow() < 6) {
    await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true })
    if (have('raw_iron') && await toSurface()) { await nightGuard(); await lumber(12) }
  }
  await smeltAll('raw_iron', 'iron_ingot', { fetchCoal: true })
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
      const r: any = await call('mine_seen', { limit: 40 })
      spots = (r.detail && r.detail.spots) || []
    } catch { return }
    // Руда, увиденная через пещеру (why «в прямой видимости»), — не наша
    // стена штрека: за ней ходят в тёмную пещеру. 2026-09-26 такой добор у края
    // пещеры кончился смертью от зомби. Только стены своих штреков и жилы, а
    // из пещерных — лишь то, что в пяти блоках.
    const s = spots.find(p => names.includes(p.name) && (p.fromMe ?? 99) <= maxDist &&
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
async function smeltAll (from, into, { fetchCoal = false }: any = {} as Record<string, any>) {
  await refresh()
  if (!have(from)) return
  await unclutter()
  if (!have('furnace')) await ensureTable()
  // За углём по памяти — только внизу, где он рядом (у печи наверху mine_seen
  // повёл бы обратно в шахту).
  if (fetchCoal && have(/^(coal|charcoal)$/) * 8 < have(from)) {
    // Только ближний уголь: по имени mine_seen пошёл к углю за 160 блоков и
    // потратил полторы минуты на дорогу (2026-09-26).
    await mineSeenAll('coal_ore,deepslate_coal_ore', 24)
    if (have(/^(coal|charcoal)$/) * 8 < have(from)) await act('mine', { block: 'coal_ore,deepslate_coal_ore', count: 3, radius: 16, timeoutSeconds: 60 })
  }
  // Угля нет, а плавить много — сперва древесный уголь: бревно в печь, доски
  // топливом (1.5 предмета на доску) → уголь на 8 предметов (containers.FUELS:
  // coal/charcoal 8, дерево 1.5). Восемь сырого железа — полтора бревна вместо
  // шести. Топливо — доски, а не то же бревно: одно имя во входе и в топливе
  // печь не приняла («birch_log в печку не лёг», 2026-09-26), и все брёвна
  // ушли в огонь как есть.
  const inv = () => Object.keys(state.inventory || {} as Record<string, any>)
  if (!have(/^(coal|charcoal)$/) && !have('lava_bucket') && have(from) >= 4 && have(LOGS) >= 5) {
    // Запас на глубину (reserve) — 4 бревна не жечь.
    const want = Math.min(Math.ceil(have(from) / 8), have(LOGS) - 4)
    if (want > 0) {
      if (have(/_planks$/) * 1.5 < want) { const p = planksFor(); if (p) await craft(p, 4) }
      const plank = inv().find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k))
      if (plank) await act('smelt', { item: 'charcoal', count: want, fuel: plank, timeoutSeconds: 120 })
    }
    await refresh()
  }
  for (let i = 0; i < 3 && have(from); i++) {
    await unclutter()
    const coal = have(/^(coal|charcoal)$/) > 0
    // Ведро лавы — 100 предметов (FUELS: lava_bucket, только если назвать).
    const logK = inv().find(k => LOGS.test(k))
    const plankK = inv().find(k => /_planks$/.test(k))
    // Дерево — сверх запаса на глубину: 4 бревна и 8 досок остаются на
    // верстак и кирку (2026-09-26, 12:59: последнее дерево ушло в печь, и на
    // y=29 не из чего стало ни кирки, ни верстака).
    const wood = have('lava_bucket') ? 'lava_bucket'
      : (logK && have(LOGS) > 4) ? logK
        : (plankK && have(/_planks$/) > 8) ? plankK
          : null
    if (!coal && !wood) { log(`плавить ${from} нечем: угля нет, а дерево — запас на глубину`); break }
    const r = await act('smelt', { item: into, count: have(from), fuel: coal ? undefined : wood, timeoutSeconds: 400 })
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
  const plank = Object.keys(state.inventory || {} as Record<string, any>).find(k => /_planks$/.test(k) && !/^(crimson|warped)_/.test(k))
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
defStage('cast', () => !known.portal, async () => {
  await sense()
  if (weakAndHungry()) { log(`хп ${Math.round(state.health ?? 0)} и еды нет — к лаве не иду, сначала охота`); return }
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
    if (r.detail && r.detail.need) break
    if (/не вижу лавы/.test(why)) {
      // Видел её раньше — сначала туда (отрезками по 64, как ходит директор).
      if (known.lava && state.pos && Math.hypot(known.lava.x - state.pos.x, known.lava.z - state.pos.z) > 16 && i < 3) {
        await goToward(known.lava, 8)
        continue
      }
      const e = await act('explore', { block: 'lava', radius: 48, stepDistance: 60, timeoutSeconds: 150 })
      if (e.detail && e.detail.found) continue
      if (i % 2 === 1 && y() > -30) await descend(Math.max(-40, y() - 30))
      continue
    }
    // Лава видна, а места у неё нет — отойти и искать место оттуда.
    if (/места под раму/.test(why)) { await walkAway(12, Math.PI / 2); continue }
    // Недолито (время, клетка не вышла) — следующий заход продолжит ту же раму.
  }
})

// 6. Алмазы: вниз к y≈-54, штреки, алмазная кирка.
defStage('diamond', () => !have(PICK_DIAMOND) && !known.portal, async () => {
  if (y() > -50) await descend(-54)
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

// 8а. Сборы в Ад (портал уже горит): еда, щит, кровать. Щит держит спереди
// стрелы скелетов-иссушителей и шары блейзов (blaze.js: «щит — держит
// спереди»); кровать у портала — точка возрождения: смерть в Аду вернёт к
// порталу, а не к старой кровати у шахты за 1700 блоков. Золото на шлем —
// уже в Аду (netherGold). Не собралось за два захода — этап отдыхает, и Ад
// берётся с тем, что есть.
const rodsNow = () => have('blaze_rod') + Math.floor(have('blaze_powder') / 2) + Math.floor(have('ender_eye') / 2)
const goldOn = () => /golden_(helmet|chestplate|leggings|boots)/.test(JSON.stringify(state.armor || {} as Record<string, any>))
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
  return act('portal', { mode: 'enter', timeoutSeconds: 120, ...(lighter() ? {} as Record<string, any> : { noIgniter: true }) })
}
defStage('prep', () => !!known.portal && dim() === 'overworld' && rodsNow() < 7 && (prepRuns < 1 || (!lighter() && flintTries < 2)) &&
  (!shieldOn() || (!lighter() && flintTries < 2) || foodUnits() < FOOD_STOCK || (!spawnAtPortal() && !have(/_bed$/))), async () => {
  prepRuns++
  // Ночью наверху сборы не идут: разведка за железом и гравием в темноте —
  // это крипер (2026-09-26, 12:11, «blown up by Creeper», вся броня и золото
  // остались в 574 блоках).
  await nightGuard()
  await sense()
  if (!sit.surface && !sit.night) await act('shelter', { mode: 'exit' })
  // Еда и шерсть — одна охота: пока нужна кровать, бьёт овец первыми.
  huntWool = !spawnAtPortal()
  try {
    if (foodUnits() < FOOD_STOCK || (!spawnAtPortal() && !have(/_bed$/))) await stageRun('food')()
  } finally { huntWool = false }
  await cook()
  await makeBed()
  // Огниво (без него portal enter в Ад не пускает: гаст гасит портал взрывом)
  // и щит — по слитку. Смерть в Аду унесла огниво, а железный заход отдал все
  // 23 слитка броне и ведру (2026-09-26, 12:08).
  const ironWant = (lighter() ? 0 : 1) + (shieldOn() ? 0 : 1)
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
const fireResNow = () => { const p = state.potions || {} as Record<string, any>; return Object.entries<any>(p).filter(([k]: any) => /fire_resistance$/.test(k)).reduce((n, [, v]: any) => n + v, 0) }
const pearlsNow = () => have('ender_pearl') + have('ender_eye')
// Сколько очей нужно: пустых рамок в комнате портала (12 минус уже вставленные). Мир
// прохождения server-run: рамки крепости A прочитаны из региона (29.09) — глаз уже в 2,
// нужно 10 (ND_EYES_NEED=10). Крепость не записана в памяти — будут броски find, каждое
// брошенное око разбивается в 20%: тогда +2 про запас.
const EYES_NEED = Math.max(1, Math.min(12, Number(process.env.ND_EYES_NEED) || 12))
const eyesWant = () => EYES_NEED + (known.stronghold ? 0 : 2)
let bastionDry = 0
let ironChestTried = false
// Несколько бастионов: одного на 10 жемчуга с P≥85% не хватает (бастион 105,87 — 17 блоков стен ≈ 153
// слитка, P≈46%; второй 672,272 — «units», 18 блоков). Выработан — золото кончилось после добычи или
// два сухих захода подряд; тогда этап идёт к следующему по памяти.
const BASTION_KEYS = ['бастион (ад)', 'бастион 2 (ад)', 'бастион 3 (ад)']
const bastionState = new Map()
const bState = b => { if (!bastionState.has(b.key)) bastionState.set(b.key, { dry: 0, spent: false, runs: 0 }); return bastionState.get(b.key) }
const nextBastion = () => (known.bastions || []).find(b => !bState(b).spent) || null
// После стержней, а не до (порядок спидраннеров — бастион, потом крепость —
// здесь не окупается): репетиция на двойнике мира прохождения (тот же сид,
// server-twin) — в этом бастионе 10 брутов и 5 хоглинов, золото в стенах над
// лавовым озером; три прогона — 0 золотых блоков. Стержни — известный путь;
// бастион — потом, за жемчугом (если он не взят эндерменами).
// Сухой заход (ни золота, ни сделок, ни сундуков) бывает случайным — вход штреком или вышка не
// узнала стены (ферма 29.09: 3 из 6 попыток). Сдаёмся после трёх подряд, а не после одного.
defStage('bastion', () => !!known.portal && !!nextBastion() && bastionDry < 3 && !known.endPortal &&
  rodsNow() >= 7 && pearlsNow() < eyesWant(), async () => {
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
    if (!nearAny) await spares(600)
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
      const td = t.detail || {} as Record<string, any>
      const why = td.why || t.error || ''
      if (/кирок на дорогу не хватит/.test(why)) { log(`${b.key}: ${why} — сначала пополнить кирки`); break }
      log(`${b.key}: штрек по маршруту — ${td.ok ? 'дошёл' : 'не дошёл: ' + why} (точек ${td.viaDone ?? '?'}/${via0.length}, копок ${td.dug ?? '?'})`)
      if (!td.ok && state.pos && Math.hypot(b.x - state.pos.x, b.z - state.pos.z) > 100) { log(`${b.key}: до бартера не дошёл — бастион остаётся нужен`); break }
    }
    // До дальнего бастиона — сотни блоков по Аду: подход в bastion() идёт отрезками, ему нужно время.
    const far = state.pos ? Math.hypot(b.x - state.pos.x, b.z - state.pos.z) : 0
    const r = await act('bastion', { x: b.x, y: b.y, z: b.z, vantage: b.vantage, knownGold: b.gold, knownChests: b.chests, timeoutSeconds: 1200 + Math.min(600, Math.round(far)), tripSeconds: far > 200 ? Math.min(480, Math.round(far / 1.3)) : 0, pearls: Math.max(0, eyesWant() - have('ender_eye')), fireRes: 3, sealed: true })
    const d = r.detail || {} as Record<string, any>
    if (d.need && d.need.what === 'iron_pickaxe') { ironChestTried = true; log('в сундуках бастиона железа на кирку не хватило — за железом наверх'); break }
    log(`${b.key}: золотых блоков ${d.goldBlocksDug ?? '?'}, слитков пиглинам ${d.ingotsTraded ?? '?'}, в рюкзаке ${JSON.stringify(d.bag || {} as Record<string, any>)}${d.stopped ? ' — ' + d.stopped : ''}`)
    const got = d.goldBlocksDug > 0 || d.ingotsTraded > 0 || (Array.isArray(d.chests) && d.chests.some(c => c && Object.values<any>(c.took || {} as Record<string, any>).some(n => n > 0)))
    if (!got) { bastionDry++; bs.dry++ } else { bastionDry = 0; bs.dry = 0 }
    if ((got && /золото кончилось/.test(d.stopped || '')) || bs.dry >= 2) { bs.spent = true; log(`${b.key} выработан`) }
    if (!got && !bs.spent) break
    if (!(pearlsNow() < eyesWant() || fireResNow() < 1)) break
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
  log(`руины: ${JSON.stringify((e.detail && e.detail.took) || {} as Record<string, any>)}; золото на мне: ${goldOn() ? 'да' : 'нет'}`)
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
defStage('nether', () => !!known.portal && rodsNow() < 7 && have('ender_eye') < 12, async () => {
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
    const f = await act('fortress', { timeoutSeconds: 300 })
    if (f.detail && f.detail.found) known.fortress = f.detail.fortress || true
  }
  // Блейзы — у крепости: без неё blaze шесть раз за 30 с отвечал «блейзов в
  // 20 блоках не вижу» (2026-09-26, 17:32). Крепость не нашлась — этап кончен,
  // следующий заход продолжит обход регионов с того же места.
  // Сначала к спавнеру (fortress mode=spawner: спавнер виден клиенту в
  // прогруженных чанках), потом бой (blaze.js лаборатории ждёт старта у
  // спавнера). Три захода, хп < 10 — домой лечиться (rest через портал).
  for (let i = 0; i < 3 && rodsNow() < 7 && known.fortress; i++) {
    await recoverGuard()
    if (died || dim() !== 'the_nether') return
    if (!READY.nether()) { log(`бой у спавнера: не хватает ${netherLack()} — сохраняю добытые стержни`); return }
    if (!(await eatTo(18))) { log('сытость не восстановилась — путь к спавнеру не начинаю'); return }
    await spares(200)
    const s = await act('fortress', { mode: 'spawner', timeoutSeconds: 300 })
    if (!(s.detail && s.detail.reached)) { log(`к спавнеру не дошёл: ${String((s.detail && s.detail.stopped) || s.error || '').slice(0, 120)}`); if (i >= 1) break; continue }
    log(`у спавнера ${JSON.stringify(s.detail.spawner)} (${s.detail.dist} бл.)`)
    if (!(await eatTo(18))) { log('сытость не восстановилась — бой с блейзами не начинаю'); return }
    // Передача 2026-09-28: открытый бой на двойниках 4/4, коробка — ноль
    // стержней. Сразу проверенный способ, без возврата за стрелами.
    await act('blaze', { rods: 7, timeoutSeconds: 400, box: false })
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
defStage('pearls', () => ENDERMEN_OK && !!known.portal && rodsNow() >= 7 && have('ender_pearl') + have('ender_eye') < eyesWant() && (!nextBastion() || bastionDry >= 3), async () => {
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
    const c: any = await craft('arrow', 4)
    await refresh()
    if (c && c.status && c.status !== 'done') break
  }
  log(`стрелы: ${arrowsNow()} (перьев ${have('feather')}, кремня ${have('flint')})`)
}

// 12а. Набор на дракона — до дороги к крепости (всё несём с собой). Агент
// дракона (TODO.md, «Дракон как отдельный этап»): кровати 6–8 (станция у
// фонтана — ~60 урона за кровать), лук и 32–64 стрелы (кристаллы), ведро воды
// (сброс со столба у клетки), от 44 блоков, еда от 6, 1–2 золотых яблока.
const BEDS_END = 6
const ARROWS_END = 32
// Агент дракона (~65 боёв с набором кампании, 30.09): два ведра воды (второе — сброс со столба у
// клетки), +64 блока стройки к 44 (мост и столбы у клеток съедают 64 — бот копал эндерняк посреди боя).
const BUCKETS_END = 2
const FILL_END = 108
const END_FILL_RE = /^(cobblestone|cobbled_deepslate|dirt|netherrack|stone|deepslate|andesite|diorite|granite|tuff|blackstone|end_stone)$/
const fillNow = () => have(END_FILL_RE)
const arrowsNow = () => have('arrow') + have('spectral_arrow')
let endkitRuns = 0
const endkitPending = () => !known.dragonWon && !known.endPortal && have('ender_eye') + have('ender_pearl') >= EYES_NEED &&
  rodsNow() >= 6 && endkitRuns < 3 && (have(/_bed$/) < BEDS_END || arrowsNow() < ARROWS_END || have('water_bucket') < BUCKETS_END || !have('bow') || !have(/_boat$/) || fillNow() < FILL_END)
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
    const c: any = await craft('arrow', 4)
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
  log(`набор на дракона: кроватей ${have(/_bed$/)}, стрел ${arrowsNow()}, вёдер воды ${have('water_bucket')}, блоков ${fillNow()}, золотых яблок ${have('golden_apple')}, лук ${have('bow') ? 'есть' : 'нет'}, лодка ${have(/_boat$/) ? 'есть' : 'нет'}`)
})

// 12. Домой из Ада и к крепости.
defStage('stronghold', () => have('ender_eye') >= Math.min(10, EYES_NEED) && !known.endPortal && !endkitPending(), async () => {
  // Из Ада — домой и сразу выйти из этапа: следующий ход сперва соберёт набор
  // на дракона (endkit — наверху, до дороги к крепости), и только потом сюда.
  if (dim() === 'the_nether') {
    if (known.netherPortal) await goToward(known.netherPortal, 4)
    await act('portal', { mode: 'enter', timeoutSeconds: 120 })
    return
  }
  if (have(/_bed$/)) await act('sleep', { mode: 'take' })
  if (!known.stronghold) {
    const r = await act('stronghold', { mode: 'find', timeoutSeconds: 400 })
    if (r.detail && (r.detail.at || r.detail.estimate)) known.stronghold = r.detail.at || r.detail.estimate
  }
  // Диагностический восточный обход горы, только на ферме.
  if (state.pos && state.pos.z < 620 && known.stronghold && known.stronghold.x === -400 && known.stronghold.z === 1776) {
    const route = [[32, -16], [64, 48], [64, 160], [32, 256], [16, 384], [-80, 496], [-144, 608]];
    for (const [x, z] of route) {
      if (died) return;
      if (state.pos.z > z + 16) continue;
      log('восточный маршрут: ' + x + ',' + z);
      await goToward({ x, z }, 8);
    }
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
  if (known.stronghold && state.pos && dim() === 'overworld' && have(/_bed$/) >= 2) {
    await readMemory()
    const sb = known.spawnBed
    const nearS = Math.hypot(known.stronghold.x - state.pos.x, known.stronghold.z - state.pos.z) <= 200
    const sbNear = sb && Math.hypot(sb.x - known.stronghold.x, sb.z - known.stronghold.z) <= 220
    if (nearS && !sbNear) await act('sleep', { mode: 'spawn', why: 'у крепости Края' })
  }
  for (let i = 0; i < 6 && !known.endPortal; i++) {
    await recoverGuard()
    if (died) return
    // Дорога к крепости — сотни и тысячи блоков поверху: ночь — в нору/кровать.
    if (dim() === 'overworld') await nightGuard()
    const r = await act('stronghold', { mode: 'room', timeoutSeconds: 500 })
    if (r.detail && r.detail.room) { known.endPortal = r.detail.room; break }
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
})
let altTried = false
let detours = 0

// 13. Энд: сборы, точка у портала, вставить очи и войти, дракон.
// Портал уже зажжён — глаза для входа не нужны: после смерти в Энде (все глаза
// в рамках) этап раньше не выбирался вовсе — «have ender_eye > 0».
defStage('dragon', () => !known.dragonWon && (dim() === 'the_end' || !!known.endPortal), async () => {
  if (dim() !== 'the_end') {
    // Из Ада (возрождение у портала, дорога) — сперва наверх.
    if (dim() === 'the_nether') { await act('portal', { mode: 'enter', timeoutSeconds: 120 }); if (dim() !== 'overworld') return }
    // Комната далеко (возродились у кровати) — дойти до неё: fill зовёт с 12
    // блоков, а издалека отвечает «сначала дойди».
    const E = known.endPortal
    for (let k = 0; k < 8 && E && state.pos && !died && Math.hypot(E.x - state.pos.x, E.z - state.pos.z) > 12; k++) {
      await nightGuard()
      await goToward(E, 4)
      await refresh()
    }
    await act('kit', { for: 'end' })
    if (have(/_bed$/) >= 2) await act('sleep', { mode: 'spawn', why: 'у портала в Энд' })
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
    // Недостающие ресурсы пополняем, но провал без результата не маскируем
    // десятиминутным ожиданием и сбросом истории. Две пустые попытки — блокер
    // до конца этого запуска; частичная полезная добыча снимает счётчик.
    const fails = new Map()
    const cooling = s => (fails.get(s.name)?.n || 0) >= 2
    let misses = 0
    for (let turn = 1; turn <= 400; turn++) {
      await refresh()
      await sense()
      if (state.playPolicy?.mode === 'free') { log('режим free — кампания уступает управление игроку'); break }
      // В Аду и Энде — только свои этапы: дерево, камень, еда и железо — этапы
      // верхнего мира. 2026-09-26 (14:34): кирки стёрлись о незерак, и первым
      // «нужным» оказалось дерево — разведка за брёвнами по Аду кончилась на
      // y=24 в лаве. Там без кирки — сперва кирка из булыжника (ensurePick).
      if (dim() !== 'overworld' && !have(/_pickaxe$/)) { stage = '-'; await ensurePick() }
      const need = STAGES.filter(s => !(only && !only.includes(s.name)) && s.needed() && (dim() === 'overworld' || OTHER_WORLD.has(s.name)))
      if (dim() === 'the_nether' && need.some(s => s.name === 'nether') && !READY.nether()) {
        stage = '-'
        log(`для ифритов не хватает ${netherLack()} — домой за недостающим`)
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
        // Нужных этапов нет, а дракон жив (фильтр -Stages, бастион сдался, эндермены закрыты) —
        // это блокер, а не победа.
        log(`БЛОКЕР: нужных этапов нет${only ? ` среди ${only.join(',')}` : ''}, а дракон жив (жемчуга ${pearlsNow()} из ${EYES_NEED}, очей ${have('ender_eye')})`)
        await act('stop')
        process.exitCode = 2
        break
      }
      // Ранен и есть нечего — еда первой, мимо порядка (act бросает прочие этапы).
      const urgent = weakAndHungry() ? need.find(x => x.name === 'food' && !cooling(x) && x.ready() && !x.defer()) : null
      const s = urgent || need.find(x => !cooling(x) && x.ready() && !x.defer())
      if (!s) {
        stage = '-'
        // В Аду нечем, а наверху есть что делать (железо на кирку для бастиона) —
        // домой, а не блокер с отключением посреди Ада (29.09 16:19, у спавнера).
        const upNeed = dim() === 'the_nether' ? STAGES.filter(x => !(only && !only.includes(x.name)) && !OTHER_WORLD.has(x.name) && x.needed()) : []
        if (upNeed.length && need.every(x => !x.defer() && (cooling(x) || !x.ready()))) {
          log(`в Аду нечем (${need.map(x => x.name).join(', ')}) — домой за: ${upNeed.map(x => x.name).join(', ')}`)
          await returnFromNether()
          continue
        }
        if (need.every(x => !x.defer() && (cooling(x) || !x.ready()))) {
          log(`БЛОКЕР: нет доступного шага (${need.map(x => `${x.name}${cooling(x) ? '·без прогресса' : '·нечем'}`).join(', ')}); одинаковые попытки прекращаю`)
          await act('stop')
          process.exitCode = 2
          break
        }
        log(`нужные этапы отложены или заблокированы (${need.map(x => `${x.name}${cooling(x) ? '·без прогресса' : ''}${x.ready() ? '' : '·нечем'}${x.defer() ? '·отложен' : ''}`).join(', ')}) — жду изменения обстановки минуту`)
        // Ждать ночью наверху — в норе, не посреди поля. В Аду не ждать —
        // домой через портал.
        if (dim() === 'the_nether') await returnFromNether()
        else if (sit.night && sit.surface && dim() === 'overworld') await nightGuard()
        else await act('wait', { seconds: 60 })
        continue
      }
      stage = s.name
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
      const ok = !s.needed()
      const after = stageProgress(s.name)
      const progressed = Object.entries<any>(after).some(([key, value]: any) => value > (before[key] || 0))
      if (!ok && s.defer()) {
        log(`этап отложен (${s.name === 'food' ? 'ночь — охота с рассветом' : 'не сейчас'}); рюкзак: ${bag()}`)
        continue
      }
      log(`итог этапа: ${ok ? 'готов' : 'НЕ ГОТОВ'}; рюкзак: ${bag()}`)
      if (ok) {
        fails.delete(s.name)
        misses = 0
        log(`ВЕХА ${s.name}: готово в ${new Date().toTimeString().slice(0, 8)}, ${Math.round((Date.now() - T0) / 60000)} мин от запуска`)
      } else if (progressed) {
        fails.delete(s.name)
        misses = 0
        log('частичный полезный результат — продолжаю без ожидания и отката')
      } else {
        const f = fails.get(s.name) || { n: 0, at: 0 }
        fails.set(s.name, { n: f.n + 1, at: Date.now() })
        misses++
      }
      if (died) { log('умер — проверяю, какие ресурсы действительно потеряны'); misses = 0 }
      if (misses >= 8) {
        log('БЛОКЕР: восемь попыток без полезного результата — нужен разбор причины')
        await act('stop')
        process.exitCode = 2
        break
      }
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
