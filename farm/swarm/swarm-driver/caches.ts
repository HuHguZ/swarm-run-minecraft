// Рой: тайники в толще (пользователь 21.10: «в стенах Колизея спрятано 2–3 тайника»). Модель команды — честное знание
// (daemon/src/swarm/cache-model: лучи глаз, «пирог» с наклоном, где прошли тела), кто копает — числами планировщика
// (plan-jobs.cacheJobs), копка — ходами 1×2 (dig_to) к выгоднейшей точке, после каждого отрезка — скан: что открылось.
// Тайник найден, только когда его сундук виден (cache_scan.chests — pick.blockSeen). Взять: открыть; крышку держит блок
// над сундуком — снять его, если виден; иначе сломать сундук (вещи выпадают) и подобрать. Находка — на доску команды.
// Нашедший надевает лучшее и дальше идёт по плану (сильный — в бой); лишнее раздают передачи (нужды бойцов).
// ARMS_CACHE_SEARCH=0 — не искать; ARMS_CACHE_PIE=0 — без «пирога» (только толща и узор ходов).
import { CacheModel } from '../../../daemon/src/swarm/cache-model'
import { cacheJobs } from '../../../daemon/src/swarm/plan-jobs'
import { WEAPON, distance, cellKey, underArrowFire } from './common'
import type { SwarmDriverCtx } from './common'
import { REPO_ROOT } from '../../../daemon/src/paths'
import * as fs from 'fs'
import * as path from 'path'

// Секунд на блок гладкого песчаника (твёрдость 2.0, нужна кирка; 1.21.11: скорость/твёрдость/30 за тик) с взмахом:
// дерево 1.5, камень 0.75, железо 0.5, алмаз 0.4, незерит 0.35, золото 0.25 (+0.15).
const DIG_S: Record<string, number> = { netherite_pickaxe: .5, diamond_pickaxe: .55, iron_pickaxe: .65, golden_pickaxe: .4, stone_pickaxe: .9, wooden_pickaxe: 1.65 }
const PICKS = Object.keys(DIG_S)

export function swarmCaches (sw: SwarmDriverCtx) {
  const { now, pos, log, arena, detail, go, boardOf, teamOf, alive, bots } = sw
  const ON = process.env.ARMS_CACHE_SEARCH !== '0' && !!sw.arms
  const PIE = process.env.ARMS_CACHE_PIE !== '0'
  const models = new Map<string, { gen: number; m: CacheModel }>()
  const lastScan = new Map<string, { at: number; p: any }>()
  const jobs = new Map<string, { at: number; gen: number; map: Map<string, any> }>()
  const diggers = new Map<string, Set<string>>()
  const summaryAt = new Map<string, number>()
  const lastOffer = new Map<string, any>()
  const stats: Record<string, number> = { scans: 0, digs: 0, dug: 0, found: 0, took: 0, calls: 0, chosen: 0, noPick: 0, walks: 0 }
  // Коробка поиска: арена по горизонтали, по высоте — от пола (слой y−1) на 44 бл. вверх.
  const box = () => { const r = Math.ceil(arena.r), x = Math.floor(arena.x), z = Math.floor(arena.z), y = Math.floor(arena.y); return { x0: x - r, x1: x + r, y0: y - 1, y1: y + 44, z0: z - r, z1: z + r } }
  // Память увиденных сундуков команды — через раунды (карта та же, восстанавливается копией: обычные сундуки стоят на тех же
  // местах; тайники каждый раунд новые — взятые в память не идут). Как у игрока: «что раньше видел сам». Со второго раунда
  // лишние в «пироге» — почти одни тайники, а не невиданные комнаты (стенд 21.10: 92 из 93 ходов целили в обычные сундуки).
  // Память — и между запусками драйвера (стенд 15×15 идёт по раунду на запуск: память в процессе не копилась): файл на карту
  // (SEED, центр арены) и команду — только то, что видела сама команда. Только в Колизее гонки (ARMS_MAP=colosseum; тесты
  // драйвера файлов не пишут); ARMS_CACHE_MEMORY=0 — без файла.
  const memory = new Map<string, Map<string, any>>()
  // Слот фермы — в имени (ffa.js arms <слот>): у каждого стенда свои боты, чужие наблюдения — не их память.
  const slot = process.env.ARMS_CACHE_MEMORY_TAG || process.argv[3] || 'x'
  const memFile = t => path.join(REPO_ROOT, 'farm', 'memory-caches', `${slot}-${process.env.SEED || 'team1'}-${Math.floor(arena.x)}-${Math.floor(arena.z)}-${t}.json`)
  const FILE = process.env.ARMS_CACHE_MEMORY !== '0' && process.env.ARMS_MAP === 'colosseum'
  const memOf = t => {
    let m = memory.get(t)
    if (!m) {
      m = new Map()
      if (FILE) try { for (const c of JSON.parse(fs.readFileSync(memFile(t), 'utf8'))) m.set(`${c.x},${c.y},${c.z}`, c) } catch {}
      memory.set(t, m)
    }
    return m
  }
  const savedAt = new Map<string, number>()
  const saveMem = (t, force = false) => {
    if (!FILE || !force && now() - (savedAt.get(t) || 0) < 15000) return
    savedAt.set(t, now())
    try { fs.mkdirSync(path.dirname(memFile(t)), { recursive: true }); fs.writeFileSync(memFile(t), JSON.stringify([...memOf(t).values()])) } catch {}
  }
  const remember = (b, list) => { const t = teamOf(b), mem = memOf(t), n = mem.size; for (const c of list) mem.set(`${c.x},${c.y},${c.z}`, { x: c.x, y: c.y, z: c.z }); if (mem.size !== n) saveMem(t) }
  const modelOf = b => {
    const t = teamOf(b); let e = models.get(t)
    if (!e || e.gen !== sw.generation) {
      // Итог раунда для замера (раз на команду): сколько раз ход дошёл до копки, сколько из них копатель, сколько ходов.
      if (e && stats.calls) log(`⛏ итог раунда (обе команды): ход звал копку ${stats.calls}, копатель ${stats.chosen}, без кирки ${stats.noPick}, к началу хода ${stats.walks}, ходов ${stats.digs} (${stats.dug} бл.), сканов ${stats.scans}, сундуков в толще ${stats.found}, тайников ${stats.took}`)
      if (e) for (const k of Object.keys(stats)) stats[k] = 0
      lastOffer.clear()
      e = { gen: sw.generation, m: new CacheModel(box()) }; e.m.minGapMs = 2500; models.set(t, e); diggers.delete(t); jobs.delete(t)
      for (const [k, c] of memOf(t)) e.m.known.set(k, { ...c })
    }
    return e.m
  }
  const inv = b => pos[b.name]?.inv || {}
  const pickOf = b => PICKS.find(n => (inv(b)[n] || 0) > 0)
  // Чем копать: своя кирка или та, что скрафтит из рюкзака (палки 2 + 3 алмаза/слитка/булыжника/доски; доски — из брёвен).
  const craftable = b => {
    const v = inv(b), planks = Object.entries(v).filter(([n]) => /_planks$/.test(n)).reduce((s, [, c]: any) => s + c, 0) + 4 * Object.entries(v).filter(([n]) => /_log$/.test(n)).reduce((s, [, c]: any) => s + c, 0)
    const sticks = (v.stick || 0) + 4 * Math.floor(Math.max(0, planks - 3) / 2)
    if (sticks < 2) return null
    return (v.diamond || 0) >= 3 ? 'diamond_pickaxe' : (v.iron_ingot || 0) >= 3 ? 'iron_pickaxe' : (v.cobblestone || 0) >= 3 ? 'stone_pickaxe' : planks >= 5 ? 'wooden_pickaxe' : null
  }
  const digSeconds = b => { const p = pickOf(b) || craftable(b); return p ? DIG_S[p] : 0 }
  const gearOf = b => { const worn = Object.values(pos[b.name]?.armor || {}).filter(Boolean).length; return Math.min(1, worn / 4 * .6 + (Object.keys(inv(b)).some(n => WEAPON.test(n)) ? .4 : 0)) }
  const center = c => ({ x: c.x + .5, y: c.y, z: c.z + .5 })
  const center3 = c => ({ x: c.x + .5, y: c.y + .5, z: c.z + .5 })
  // Клетки отрезка a → b по порядку (шаг 0.2 бл.), без повторов и без клетки глаз.
  const lineCells = (a, b) => {
    const out: any[] = [], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 0.2), seen = new Set([cellKey({ x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) })])
    for (let k = 1; k <= n; k++) { const c = { x: Math.floor(a.x + (b.x - a.x) * k / n), y: Math.floor(a.y + (b.y - a.y) * k / n), z: Math.floor(a.z + (b.z - a.z) * k / n) }; if (!seen.has(cellKey(c))) { seen.add(cellKey(c)); out.push(c) } }
    return out
  }
  // Неудача хода — повтор по причине (retry.ts), не по сроку. Ключи — по паре «откуда → куда» и по самой цели: каждая
  // неудача помнится своей записью (одна запись на бота затиралась следующей — 542,120,568 ↔ 543,120,567 по кругу дважды в
  // секунду, стенд 31, раунд a28). Пока бот в 2 бл. от места неудачи: та же пара и та же цель — нет; чужие места старта —
  // нет (дошёл бы — не стоял бы тут), только ход от своих ног. Ушёл с места — всё снова можно. Копатель снимается с дела.
  const pairKey = (b, from, to) => `cacheApproach:${b.name}:${cellKey(from)}>${cellKey(to)}`
  const planBlocked = (o, from, to) => {
    const feet = pos[o.name]?.p, own = !!feet && from.x === Math.floor(feet.x) && from.y === Math.floor(feet.y) && from.z === Math.floor(feet.z)
    return sw.blocked(o, pairKey(o, from, to)) || sw.blocked(o, `cacheTo:${o.name}:${cellKey(to)}`) || !own && sw.blocked(o, `cacheWalk:${o.name}`)
  }
  const approachFailed = (b, plan) => {
    sw.failed(b, pairKey(b, plan.from, plan.to)); sw.failed(b, `cacheTo:${b.name}:${cellKey(plan.to)}`)
    if (distance(pos[b.name]?.p || plan.from, center(plan.from)) > 1.6) sw.failed(b, `cacheWalk:${b.name}`)
    diggers.get(teamOf(b))?.delete(b.name); jobs.delete(teamOf(b))
  }

  // Глаза: раз в 5 с и со сдвига на 3+ бл. (или раз в 20 с на месте) — лучи и «пирог» в модель команды. Без ожидания хода.
  async function scan (b, force = false) {
    const me = pos[b.name]?.p
    if (!ON || !me || !alive(b.name)) return null
    const ls = lastScan.get(b.name)
    if (!force && ls && (now() - ls.at < 5000 || distance(ls.p, me) < 3 && now() - ls.at < 20000)) return null
    lastScan.set(b.name, { at: now(), p: { ...me } })
    const gen = sw.generation
    const r = detail(await b.c.call('cache_scan', { rays: 700, pie: PIE, chestRange: 64 }).catch(() => null))
    if (!r?.hits || gen !== sw.generation) return null
    modelOf(b).addScan(r)
    remember(b, (r.chests || []).map(c => ({ x: c[0], y: c[1], z: c[2] })))
    stats.scans++
    return r
  }
  // Каждый ход любого бота (драйвер зовёт из chestAtHand): где стоит тело — воздух, грани вокруг видны; скан — по расписанию.
  const observe = b => {
    if (!ON || !pos[b.name]?.p) return
    modelOf(b).markWalked(pos[b.name].p)
    void scan(b)
  }

  // Кто копает (раз в 2 с на команду): планы копателей — по очереди, у каждого свой сектор (не ближе 10 бл. к чужой цели)
  // и без клеток, что откроют чужие ходы; выбор — plan-jobs.cacheJobs (ценность копки против боя и лута).
  function jobsOf (b) {
    const t = teamOf(b), m = modelOf(b), j = jobs.get(t)
    if (j && j.gen === sw.generation && now() - j.at < 2000) return j.map
    const members = bots.filter(o => teamOf(o) === t && alive(o.name) && pos[o.name]?.p)
    const cur = diggers.get(t) || new Set<string>()
    const offers = new Map<string, any>(), reserved = new Set<number>(), away: any[] = []
    // Планы — тем, кому копка сейчас возможна (не бой, не уход, есть чем копать), копающим первым, не больше четырёх: план —
    // десятки мс, а драйвер один на всех (его пауза — пауза всех тел).
    // Боец (задача fight) свободен для копки, пока не в бою: свежий враг (виден ≤ 3 с) дальше 16 бл. от него.
    const engaged = o => boardOf(o).enemies().some(e => now() - e.seenAt < 3000 && distance(e.position, pos[o.name].p) < 16)
    const free = o => !/^(flee|recover|heal)$/.test(o.swarmTask?.kind || '') && !!digSeconds(o) && !(o.swarmTask?.kind === 'fight' && engaged(o))
    let planned = 0
    for (const o of [...members].sort((a, c) => Number(cur.has(c.name)) - Number(cur.has(a.name)) || a.name.localeCompare(c.name))) {
      if (!free(o) || planned >= 4) { offers.set(o.name, null); continue }
      // Копает прямо сейчас (dig_to идёт) — его ход тот же: план не меняется посреди хода, клетки хода остаются за ним (иначе
      // второго копателя слали в тот же ход).
      const last = lastOffer.get(o.name)
      if (o.cacheDigging && last) { offers.set(o.name, last); for (const i of last.exposed || []) reserved.add(i); away.push(last.to); continue }
      planned++
      const digS = digSeconds(o)
      // Ход, что не вышел (не дошёл до начала, копка без шага), — не тот же с того же места (retry.ts), другой — можно.
      const plan = digS ? m.planDig(pos[o.name].p, { digS, reserved, away, skip: (to, from) => planBlocked(o, from, to) }) : null
      offers.set(o.name, plan && { ...plan, share: m.share })
      if (plan) lastOffer.set(o.name, { ...plan, share: m.share }); else lastOffer.delete(o.name)
      if (plan) { for (const i of plan.exposed) reserved.add(i); away.push(plan.to) }
    }
    const team = members.map(o => ({ id: o.name, position: pos[o.name].p, health: pos[o.name].hp ?? 20, gear: gearOf(o), canDig: free(o), fighting: o.swarmTask?.kind === 'fight' }))
    const map = cacheJobs(team, boardOf(b).enemies(), offers, now(), cur)
    // Сводка раз в 20 с на команду (замер): сколько планов, лучшая копка, сколько выбрано.
    if (now() - (summaryAt.get(t) || 0) > 20000) {
      summaryAt.set(t, now())
      const best = [...offers.values()].filter(Boolean).sort((a, c) => c.rate - a.rate)[0]
      const fresh = boardOf(b).enemies().filter(e => now() - e.seenAt < 30000).length
      log(`⛏ ${t}: планов ${[...offers.values()].filter(Boolean).length}/${members.length}, свободных ${members.filter(free).length}, лучший ${best ? (best.rate * 60).toFixed(3) + '/мин' : '—'}, доля тайников ${m.share.toFixed(2)}, невиданных ≈ ${Math.round(m.unknown)}, врагов свежих ${fresh}, копают ${map.size}`)
    }
    for (const [id, job] of map) if (!cur.has(id)) log(`⛏ ${id}: ищу тайники — ${job.reason}; ход ${cellKey(job.offer.from)} → ${cellKey(job.offer.to)}; невиданных сундуков ≈ ${Math.round(m.unknown)}, известно ${m.known.size} (память ${memOf(t).size}), сканов ${m.scans}`)
    diggers.set(t, new Set(map.keys()))
    jobs.set(t, { at: now(), gen: sw.generation, map })
    return map
  }

  async function craftPick (b) {
    const want = craftable(b)
    // Не скрафтилось — не повторять, пока те же запасы и то же место (retry.ts).
    const sig = `${want}|${JSON.stringify(inv(b))}`
    if (!want || sw.blocked(b, `cacheCraft:${b.name}`, sig)) return false
    const r = detail(await b.c.call('craft', { item: want, count: 1, timeoutSeconds: 20 }).catch(e => ({ why: e.message })))
    if (!(r.crafted || r.made || r.ok)) sw.failed(b, `cacheCraft:${b.name}`, sig)
    log(`🔨 ${b.name}: кирка для тайников (${want}) — ${r.crafted || r.made || r.ok ? 'готова' : String(r.why || r.error || r.message || 'нет').slice(0, 60)}`)
    return true
  }

  // Взять тайник at: открыть; не открылся — снять крышку (блок над ним, если виден) и снова; нет — сломать сундук и подобрать.
  // Место в рюкзаке под находку: свободных ячеек меньше need — выбросить лишнее (стройматериал сверх стопки, паутину, удочки,
  // склянки, слабую броню и оружие) по стопке, пока не хватит. Находка тайника дороже любой из этих вещей.
  const JUNK = /^(cobweb|glass_bottle|fishing_rod|stick|.*_log|.*_planks|ladder|.*sandstone.*|cobblestone|sand|dirt|flint_and_steel|fire_charge|fermented_spider_eye|nether_wart|glistering_melon_slice|glowstone_dust|gunpowder|blaze_powder|lava_bucket|water_bucket|(leather|chainmail|wooden|stone|golden)_w+)$/
  async function makeRoom (b, need) {
    const storage = detail(await b.c.call('status', { items: true }).catch(() => null))?.storage
    // Нет ответа о ячейках — оценка сверху: 36 минус по ячейке на каждое имя в рюкзаке (стопок не меньше, чем имён).
    let free = Array.isArray(storage) ? storage.filter(x => !x).length : Math.max(0, 36 - Object.keys(inv(b)).length)
    const junk = Object.entries(inv(b)).filter(([n]) => JUNK.test(n)).sort((a: any, c: any) => c[1] - a[1])
    let dropped = 0
    for (const [n] of junk) { if (free >= need || underArrowFire(b, now())) break; const r = detail(await b.c.call('drop', { item: n }).catch(() => ({}))); if (r.dropped) { free++; dropped++ } }
    return dropped
  }
  // Сундуки, открытые своими (взятием тайника и обычным лутом), — повторно не брать (их содержимое команда уже знает). Свой
  // набор у команды (общий emptyChests драйвера — на обе команды, его копатель не трогает). Отмечается после того, как окно
  // открылось или вещи подобраны; неудача взятия — retry.ts (с того же места не повторять).
  const teamOpened = new Map<string, Set<string>>()
  const openedBy = b => { const t = teamOf(b) + ':' + sw.generation; let set = teamOpened.get(t); if (!set) { set = new Set(); teamOpened.set(t, set) } return set }
  const noteOpened = (b, at) => { if (at) openedBy(b).add(cellKey(at)) }
  // Тайник по тому, что видно: крышку держал сплошной блок (снимал) — точно; иначе — сундука нет в памяти обычных (прошлые
  // раунды) и из него пришло редкое (незерит, трезубец, булава, тотем, зачарованное яблоко; на нижних ярусах в обычных их нет).
  const RARE = /^(netherite_w+|trident|mace|totem_of_undying|enchanted_golden_apple)$/
  async function take (b, board, at) {
    if (underArrowFire(b, now())) return false
    const round = sw.generation
    const k = cellKey(at), allies = bots.filter(o => teamOf(o) === teamOf(b)).map(o => o.name)
    const before = { ...inv(b) }, wornBefore = new Set(Object.values(pos[b.name]?.armor || {}).filter(Boolean) as string[])
    const opened = r => !!r && (r.contents !== undefined || Object.values(r.took || r.moved || {}).some((n: any) => Number(n) > 0))
    const open = async () => detail(await b.c.call('chest_take', { item: 'all', x: at.x, y: at.y, z: at.z, timeoutSeconds: 6, visibleOnly: true, stay: true }).catch(e => ({ why: e.message })))
    if (distance(pos[b.name].p, center(at)) > 3) {
      const r = await go(b, center(at), 1.5, 5, sw.lootArena(b), true)
      if (round !== sw.generation || !alive(b.name) || r?.status !== 'done' || !detail(r).arrived) return false
    }
    if (underArrowFire(b, now())) return false
    let r = await open(), how = 'открыл', picked = 0
    // Крышка: блок над сундуком. Снят (был виден) — открыть снова; над ним воздух — сундук обычный, просто не дотянулся или
    // не в прицеле отсюда: подойти вплотную и открыть с подходом, не ломать (ломать чужой сундук комнаты — терять двойной).
    let lid: any = null
    if (underArrowFire(b, now())) return false
    if (!opened(r)) {
      lid = detail(await b.c.call('swarm_work', { kind: 'dig', at: { x: at.x, y: at.y + 1, z: at.z }, allies, timeoutSeconds: 8 }).catch(e => ({ why: e.message })))
      if (underArrowFire(b, now())) return false
      if (lid.done && !lid.already) { r = await open(); how = 'снял крышку и открыл' }
      else if (lid.already) { r = detail(await b.c.call('chest_take', { item: 'all', x: at.x, y: at.y, z: at.z, timeoutSeconds: 8, visibleOnly: true }).catch(e => ({ why: e.message }))); how = 'подошёл и открыл' }
    }
    if (!opened(r) && !lid?.already) {
      await makeRoom(b, 7) // вещи выпадут — подобрать некуда, если рюкзак полон
      if (underArrowFire(b, now())) return false
      const br = detail(await b.c.call('swarm_work', { kind: 'dig', at, allies, timeoutSeconds: 12 }).catch(e => ({ why: e.message })))
      how = br.done ? 'сломал' : `не взял (${String(br.why || r.why || '?').slice(0, 40)})`
      // Подбор выпавшего: до 10 попыток, конец — две пустые подряд (одна мимо — вещь ещё летит или за спиной).
      if (br.done) for (let n = 0, miss = 0; n < 10 && miss < 2 && alive(b.name) && !underArrowFire(b, now()); n++) { const p = detail(await b.c.call('assist', { mode: 'pickup', maxD: 5 }).catch(() => ({}))); if (p.ok) { picked++; miss = 0 } else miss++ }
    }
    if (underArrowFire(b, now())) return false
    // Тайник (крышку держал сплошной блок), открыл, а взять не вышло (в сундуке осталось, взято ничего) — рюкзак полон:
    // освободить место и взять снова. Ради обычного сундука рюкзак не чистится.
    if (/крышку/.test(how) && opened(r) && r.contents && Object.keys(r.contents).length && !Object.values(r.took || {}).some((n: any) => Number(n) > 0)) {
      const dropped = await makeRoom(b, Math.min(9, Object.keys(r.contents).length + 1))
      if (dropped && !underArrowFire(b, now())) { r = await open(); how += `, выбросил ${dropped} стоп. и взял` }
    }
    if (!opened(r) && !picked) { sw.failed(b, `take:${b.name}:${k}`); log(`🗝 ${b.name}: сундук в толще ${k} — ${how}`); return }
    noteOpened(b, at)
    if (underArrowFire(b, now())) return true
    await b.c.call('armor', {}).catch(() => {})
    // Что прибавилось в рюкзаке и на теле (взятое из окна, подобранное после слома, надетое) — для журнала и для признака тайника.
    const st = await b.c.call('status').catch(() => null)
    if (st?.state?.inventory) { pos[b.name].inv = st.state.inventory; pos[b.name].armor = st.state.armor || pos[b.name].armor }
    const gained = [...Object.entries(inv(b)).filter(([n, c]: any) => c > (before[n] || 0)).map(([n]) => n),
      ...(Object.values(pos[b.name]?.armor || {}).filter(n => n && !wornBefore.has(n as string)) as string[])]
    const enclosed = /крышку/.test(how) || !memOf(teamOf(b)).has(k) && gained.some(n => RARE.test(n))
    if (enclosed) {
      modelOf(b).markFound(at)
      memOf(teamOf(b)).delete(k) // тайник — в этом раунде; в следующем на его месте снова камень
      saveMem(teamOf(b), true)
      board.recordFact(b.name, now(), { id: 'cache:' + k, kind: 'mark', position: { ...at } }, 600000)
      stats.took++
    } else remember(b, [at])
    log(`🗝 ${b.name}: ${enclosed ? 'тайник' : 'сундук'} в толще ${k} — ${how}${picked ? `, подобрал ${picked}` : ''}; прибавилось: ${gained.join(', ') || '—'}`)
  }

  // Ход копателя (зовёт драйвер: лут-задача или свободный боец). false — не копатель или копать нечем: дальше обычный ход.
  async function turn (b, board) {
    if (!ON || !pos[b.name]?.p || underArrowFire(b, now())) return false
    stats.calls++
    const job = jobsOf(b).get(b.name)
    if (!job) return false
    // Боец, к которому подошёл враг (16 бл., виден ≤ 3 с), — в бой, даже если выбран копать (выбор раз в 2 с — мог устареть).
    if (b.swarmTask?.kind === 'fight' && boardOf(b).enemies().some(e => now() - e.seenAt < 3000 && distance(e.position, pos[b.name].p) < 16)) return false
    stats.chosen++
    if (!pickOf(b)) { stats.noPick++; return craftPick(b) }
    const plan = job.offer, me = pos[b.name].p, gen = sw.generation
    b.cacheDigging = true
    try {
      if (distance(me, center(plan.from)) > 1.6) {
        stats.walks++
        const raw: any = await go(b, center(plan.from), 0.8, 10, sw.lootArena(b), true).catch(e => ({ status: 'failed', why: e.message }))
        const r = detail(raw)
        // Поход оборвали (смена фазы, тревога, «лезу к цели») — не неудача места: ход окончен, решит следующий.
        if (raw?.status && raw.status !== 'done' && raw.status !== 'failed' && raw.status !== 'timeout') return true
        if (!r.arrived) { approachFailed(b, plan); log(`⛏ ${b.name}: к началу хода ${cellKey(plan.from)} не дошёл — ${String(r.why || r.stopped || raw?.status || '?').slice(0, 50)}`) }
        return true
      }
      const r = detail(await b.c.call('dig_to', { at: center(plan.to), maxSteps: 6, timeoutSeconds: 20 }).catch(e => ({ why: e.message })))
      if (gen !== sw.generation || !alive(b.name)) return true
      if (underArrowFire(b, now())) return true
      stats.digs++; stats.dug += r.dug || 0
      log(`⛏ ${b.name}: ход к ${cellKey(plan.to)} — ${r.dug ?? 0} бл. за ${r.steps ?? 0} шаг.${r.why ? ` (${String(r.why).slice(0, 40)})` : ''}, стою ${cellKey(r.at || {})}`)
      if (!r.steps && !r.dug) approachFailed(b, plan)
      // Дошёл до цели, а она так и не видна (dig_to считает «дошёл» по лучу к углу клетки — облицовка ниши, плита перед ней
      // остаются): пробить по лучу от глаз к её середине первые непрозрачные клетки (до 3; swarm_work копает только видимую грань).
      let s = await scan(b, true)
      const m = modelOf(b), ti = m.idx(plan.to.x, plan.to.y, plan.to.z)
      const eye0 = s?.eye
      if (eye0 && ti >= 0 && m.state[ti] === 0 && Math.hypot(plan.to.x + .5 - eye0.x, plan.to.y + .5 - eye0.y, plan.to.z + .5 - eye0.z) < 4.5) {
        const allies = bots.filter(o => teamOf(o) === teamOf(b)).map(o => o.name)
        let opened = 0
        for (const c of lineCells(eye0, center3(plan.to))) {
          if (underArrowFire(b, now()) || opened >= 3 || c.x === plan.to.x && c.y === plan.to.y && c.z === plan.to.z) break
          const st = m.stateAt(c.x, c.y, c.z)
          if (st === 1 || st === 3) continue
          const w = detail(await b.c.call('swarm_work', { kind: 'dig', at: c, allies, timeoutSeconds: 8 }).catch(e => ({ why: e.message })))
          if (!w.done) break
          if (!w.already) opened++
          m.markDug([c])
        }
        if (opened) { log(`⛏ ${b.name}: к цели ${cellKey(plan.to)} — пробил ${opened} бл. по лучу`); s = await scan(b, true) }
      }
      const eye = s?.eye || me
      const fresh = (s?.chests || []).map(c => ({ x: c[0], y: c[1], z: c[2] })).filter(c => !openedBy(b).has(cellKey(c)) && !sw.blocked(b, `take:${b.name}:${cellKey(c)}`) && Math.hypot(c.x + .5 - eye.x, c.y + .5 - eye.y, c.z + .5 - eye.z) < 5)
      if (fresh.length) { stats.found++; for (const c of fresh) await take(b, board, c) }
      return true
    } finally { delete b.cacheDigging }
  }
  // Сундуки, увиденные лутом (blocks_around seen), — в известные команде: «пирог» вычитает их из окон.
  const seenChests = (b, list) => { if (!ON || !list?.length) return; const m = modelOf(b); for (const c of list) m.known.set(`${c.x},${c.y},${c.z}`, { x: c.x, y: c.y, z: c.z }); m.dirty = true; remember(b, list) }
  return { cacheObserve: observe, cacheTurn: turn, cacheSeen: seenChests, cacheOpened: noteOpened, cacheStats: stats, cacheModelOf: modelOf }
}
