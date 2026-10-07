'use strict'
const gameClock = require('./game-clock')
// Крепость Ада: увидеть её честно и дойти до неё (mc_fortress). Зрение — как у
// человека: блок засчитан, только если луч от глаз упирается в него
// (bot.canSeeBlock), кирпич за стеной не подсказывает ничего.
//
// Почему своё сканирование, а не observe. observe делает один findBlocks на все
// «интересные» виды с count 300 и фильтрует видимость ПОСЛЕ отсечки (NETHER.md,
// срез 5а): в Аду лава съедает весь бюджет, и спавнер в 21 блоке при лаве под
// полом не виден, хотя луч до него есть. Здесь у каждого вида свой бюджет, и в
// ответе — сколько кандидатов проверено лучом (это нижняя граница «видно»).
//
// Факты (байткод и данные paper-1.21.11):
//   * крепость строится из nether_bricks, nether_brick_fence и
//     nether_brick_stairs (NetherFortressPieces); в самом Аду эти блоки больше
//     нигде не растут — увидел кирпич, значит, крепость (бастион — из blackstone);
//   * nether_complexes: регион 27x27 чанков (432 блока), в каждом одна постройка,
//     крепость с весом 2 из 5 (40%), бастион — 60%;
//   * спидраннеры идут от портала вдоль оси X: коридоры крепости длинные, их
//     легче пересечь поперёк (SPEEDRUN.md);
//   * тронный зал блейзов (MonsterThrone 7x8x9) — спавнер на подиуме, в
//     открытой части крепости; блейз, скелет-иссушитель, зомби-пиглин, скелет и
//     магмовый куб спавнятся по всей коробке кусков крепости.

const Vec3 = require('vec3')
const { xyz, travelXZ, sleep } = require('./movement')
const { canSeePoint } = require('./perception')
const { seesBlock } = require('./sight')
const worlds = require('./worlds')

const PLACE = 'крепость (ад)'
const SPAWNER_PLACE = 'спавнер блейзов'
const FORTRESS_BLOCKS = ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs']
const BASTION_BLOCKS = ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'gilded_blackstone']
const BASTION_PLACE = 'бастион (ад)'
const DIRS = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }
const WORDS = { east: 'восток', west: 'запад', south: 'юг', north: 'север' }

// Время (ЧЧ:ММ:СС) — для разбора, куда ушли минуты этапа (dev-F 02.10).
const log = (what, o) => console.log('[fortress]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))
function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// Сторона света по смещению: 0° — юг (+z), 90° — восток (+x), как у stronghold.js.
function bearingWords (dx, dz) {
  const a = (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360
  const names = ['юг', 'юго-восток', 'восток', 'северо-восток', 'север', 'северо-запад', 'запад', 'юго-запад']
  return names[Math.round(a / 45) % 8]
}

// Один взгляд вокруг: для каждого вида — свой findBlocks и свой бюджет лучей.
function look (bot, mcData, { radius = 64, perKind = 400, rayBudget = 500 }: any = {}) {
  const me = bot.entity.position
  const ids = FORTRESS_BLOCKS.map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
  let candidates = []
  for (const id of ids) candidates.push(...bot.findBlocks({ matching: [id], maxDistance: radius, count: perKind }))
  candidates.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  const found = candidates.length
  // Лучи — поровну ближним и дальним: крепость видно с края, а ближние
  // кандидаты за стеной съели бы весь бюджет.
  let pick = candidates
  if (candidates.length > rayBudget) {
    const step = candidates.length / rayBudget
    pick = []
    for (let i = 0; i < rayBudget; i++) pick.push(candidates[Math.floor(i * step)])
  }
  const seen = []
  for (const p of pick) {
    const b = bot.blockAt(p)
    if (b && seesBlock(bot, b)) seen.push(p)
  }
  const spawnerId = mcData.blocksByName.spawner.id
  const spawners = bot.findBlocks({ matching: [spawnerId], maxDistance: Math.min(radius, 48), count: 16 })
    .filter(p => { const b = bot.blockAt(p); return b && seesBlock(bot, b) })
  const blazes = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'blaze' && e.position &&
    e.position.distanceTo(me) <= radius && canSeePoint(bot, e.position.offset(0, 0.9, 0)))
  const out: any = { candidates: found, rayChecked: pick.length, seen: seen.length, seenList: seen }
  // Бастион: полированный блэкстоун-кирпич и позолоченный блэкстоун. Кирпич
  // бывает и в разрушенном портале (BlackstoneReplaceProcessor меняет
  // stone_bricks на polished_blackstone_bricks), но там его десяток — поэтому
  // порог 24 видимых. В регионе одна постройка: бастион — крепости тут нет.
  const bIds = BASTION_BLOCKS.map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
  const bCand = bot.findBlocks({ matching: bIds, maxDistance: radius, count: 200 })
  const bSeen = []
  for (let i = 0; i < bCand.length && bSeen.length < 40; i += Math.max(1, Math.floor(bCand.length / 120))) {
    const b = bot.blockAt(bCand[i])
    if (b && seesBlock(bot, b)) bSeen.push(bCand[i])
  }
  if (bSeen.length >= 24) {
    bSeen.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    out.bastion = { seen: bSeen.length, nearest: xyz(bSeen[0]), dist: Math.round(bSeen[0].distanceTo(me)), bearing: bearingWords(bSeen[0].x - me.x, bSeen[0].z - me.z) }
  }
  if (seen.length) {
    const near = seen[0]
    out.nearest = xyz(near)
    out.dist = Math.round(near.distanceTo(me))
    out.bearing = bearingWords(near.x - me.x, near.z - me.z)
    out.spanY = [Math.min(...seen.map(p => p.y)), Math.max(...seen.map(p => p.y))]
  }
  if (spawners.length) out.spawners = spawners.map(p => ({ ...xyz(p), dist: Math.round(p.distanceTo(me)) }))
  if (blazes.length) out.blazes = { seen: blazes.length, nearest: Math.round(Math.min(...blazes.map((e : any) => e.position.distanceTo(me)))) }
  if (blazes.length) out.blazeList = blazes.map((e : any) => e.position.floored())
  return out
}

function remember (session, seenAt, what) {
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[PLACE] = { ...seenAt, dimension: 'the_nether', note: what }
  })
  session.journal.append(PLACE, what, new Vec3(seenAt.x, seenAt.y, seenAt.z))
}

// Бастионы по порядку (campaign.js BASTION_KEYS): второй увиденный — «бастион 2 (ад)», а не поверх первого (раньше новый
// затирал старый — первый, ещё не пройденный, терялся; выработанный — «находился» снова).
const BASTION_KEYS_ALL = [BASTION_PLACE, 'бастион 2 (ад)', 'бастион 3 (ад)']
// Выработан ли бастион у точки p: запись кампании «выработан: <ключ>» в 100 блоках (campaign.js readMemory).
function bastionSpentNear (session, p) {
  const places = (session.journal.state && session.journal.state.places) || {}
  return (Object.entries(places) as [string, any][]).some(([k, v]: any) => /^выработан: бастион/.test(k) && v && worlds.worldOfRecord(v) === 'the_nether' && Math.hypot(v.x - p.x, v.z - p.z) <= 100)
}
// Узнать бастион издалека в момент, когда он виден (с вышки разведки обзор лучше, чем с подхода): predictGold радиусом 112
// → гипотезы старта (тип, поворот, сдвиг) — в запись бастиона; bastion() по ним сразу знает золото (p.starts).
function recognizeFar (session) {
  try {
    const pg = require('./bastion').predictGold(session.bot, 112)
    const all = pg && pg.start && pg.start.all
    if (all && all.length) { log('бастион узнан издалека', { starts: all, basalt: pg.basalt, chests: pg.chests }); return all }
  } catch (e) { log('бастион издалека', { error: e.message }) }
  return null
}
function rememberBastion (session, b) {
  const places = (session.journal.state && session.journal.state.places) || {}
  if (BASTION_KEYS_ALL.some(k => places[k] && Math.hypot(places[k].x - b.nearest.x, places[k].z - b.nearest.z) < 64)) return
  if (bastionSpentNear(session, b.nearest)) return
  const key = BASTION_KEYS_ALL.find(k => !places[k])
  if (!key) return
  const starts = recognizeFar(session)
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[key] = { ...b.nearest, dimension: 'the_nether', ...(starts ? { starts } : {}), note: 'похоже на бастион (блэкстоун-кирпич): пиглины и золото — бартер жемчуга (mc_pearls mode=barter), золотая броня обязательна; крепости в этом регионе нет' }
  })
  session.journal.append(key, `похоже на бастион: ${b.seen} видимых блоков блэкстоун-кирпича, ближайший ${b.nearest.x},${b.nearest.y},${b.nearest.z}`, new Vec3(b.nearest.x, b.nearest.y, b.nearest.z))
}

function rememberSpawner (session, sp) {
  const places = (session.journal.state && session.journal.state.places) || {}
  const old = places[SPAWNER_PLACE]
  if (old && old.x === sp.x && old.y === sp.y && old.z === sp.z) return
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[SPAWNER_PLACE] = { x: sp.x, y: sp.y, z: sp.z, dimension: 'the_nether', note: 'спавнер в крепости Ада (тронный зал блейзов): стоять в 16 блоках, чтобы работал' }
  })
  session.journal.append(SPAWNER_PLACE, `видел спавнер в крепости на ${sp.x},${sp.y},${sp.z}`, new Vec3(sp.x, sp.y, sp.z))
}

// Крепость Ада стоит в полосе y 48..70 (NetherFortressStructure:
// moveInsideHeights(random, 48, 70)). Сверху её кирпич закрыт породой: прогон
// 2026-09-25 прошёл прямо над крепостью по y=115 — лучом проверено 473 места,
// видно 0. Поэтому, пока тело выше 80, отрезок целится на 12 ниже (до 64):
// pathfinder сам ищет спуск и копает — ломать блок у жидкости он не станет
// (Movements.dontCreateFlow). Не вышло вниз — тот же отрезок по горизонтали.
async function legTo (session, ctl, tx, tz, deadline) {
  const nether = require('./nether')
  // Отрезок под охраной: ударили — бой с обидчиком, а не следующий отрезок
  // (nether.js guarded: эндермен убил тело посреди разведки, 2026-09-25).
  const w = await nether.guarded(session, ctl, sub => walkLeg(session.bot, sub, tx, tz, deadline))
  if (w.fought) return w
  if (w.ok || ctl.aborted || gameClock.now() > deadline) return w
  // Ногами не вышло (лавовое озеро, обрыв, «путь длиной 0») — штреком по
  // netherrack на высоту крепости (nether.js bore): забой сам не трогает лаву.
  const b = await nether.bore(session, ctl, { x: tx, z: tz }, {
    deadline: Math.min(deadline, gameClock.now() + 40000), maxSteps: 20, minY: 64
  })
  if (b.ok || b.moved >= 8) return { ok: true, bored: b.dug, bricks: b.bricks }
  return { ok: false, error: `${w.error}; штрек: ${b.why}`, bored: b.dug || undefined }
}

async function walkLeg (bot, ctl, tx, tz, deadline) {
  const y = bot.entity.position.floored().y
  if (y > 80) {
    const ty = Math.max(64, y - 12)
    const { goals } = require('mineflayer-pathfinder')
    const { stuckGuard } = require('./movement')
    const guard = stuckGuard(bot, ctl, 8000)
    let timer = null
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, 4)),
        guard.promise,
        new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), Math.max(1000, Math.min(15000, deadline - gameClock.now()))) })
      ])
      const p = bot.entity.position
      if (Math.hypot(p.x - tx, p.z - tz) <= 6 && p.y < y) return { ok: true, down: Math.round(y - p.y) }
    } catch {
      try { bot.pathfinder.setGoal(null) } catch {}
    } finally {
      guard.stop()
      if (timer) gameClock.clearTimeout(timer)
    }
  }
  // 20 с на отрезок в 16 блоков: дольше — это pathfinder, копающий путь с
  // перерасчётом на каждый сломанный блок («reset: block_updated», прогон 7:
  // минута на 8 блоков); штрек (bore) то же пройдёт за 15 с.
  return travelXZ(bot, ctl, tx, tz, { range: 3, retries: 0, deadline: Math.min(deadline, gameClock.now() + 20000) })
}

// mode=look — только глаза, тело не двигается. mode=explore — ноги по прямой
// вдоль направления отрезками по 16 блоков, взгляд после каждого, пока
// кирпич не увиден или не кончились distance/время.
// Разведка — с полом (worlds.tuneMovements): не ниже y=40 и не ниже того, где
// начали. Пол держится весь вызов и снимается в конце, как бы он ни кончился.
async function scout (session, ctl, p: any = {}) {
  const bot = session.bot
  if (worlds.worldOf(bot) !== 'the_nether' || p.mode === 'look' || p.mode === 'forget') return scoutBody(session, ctl, p)
  const feet = Math.floor(bot.entity.position.y)
  bot._ndNetherFloor = Math.min(40, feet)
  try {
    return await scoutBody(session, ctl, p)
  } finally {
    bot._ndNetherFloor = 0
  }
}

async function scoutBody (session, ctl, p: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const t0 = gameClock.now()
  const deadline = t0 + clamp(p.timeoutSeconds ?? 240, 20, 600) * 1000 - 4000
  // В обходе — 96: при 64 полоса z=176 прошла в 131 блоке от крепости и не
  // задела ни одного кирпича, а в 96 от той же линии их 418 (прогон 8, замер
  // findBlocks с крыши). Для look и explore — прежние 64.
  // high (ND_SCOUT_HIGH или p.high): взгляд с вышки и радиус 128 (дальность прогрузки чанков фермы — 8 чанков).
  const high = !!p.high || process.env.ND_SCOUT_HIGH === '1'
  const radius = clamp(p.radius ?? (['look', 'explore', 'forget'].includes(p.mode) ? 64 : high ? 128 : 96), 16, high ? 128 : 96)
  const here = worlds.worldOf(bot)
  if (p.mode === 'spawner') return toSpawner(session, ctl, { deadline, tunnel: p.tunnel === true || process.env.ND_SPAWNER_TUNNEL === '1' })
  // map — знание карты из копии этого же мира (AGENTS.md разрешает его основному телу; на ферме записи снимает
  // try-lab-ne-map.js с правды мира): крепость, спавнер, бастионы (с золотом и сундуками) — только записи Ада.
  if (p.mode === 'map') {
    const allow = new Set([PLACE, SPAWNER_PLACE, ...BASTION_KEYS_ALL, 'искажённый лес (ад)'])
    // «крепость» (Края) — тоже по карте копии мира (сцены MAP_SH): запись как после броска ока у лестницы (refined).
    const put = (Object.entries(p.places || {}) as [string, any][]).filter(([k, v]: any) => v && [v.x, v.y, v.z].every(Number.isFinite) &&
      ((allow.has(k) && v.dimension === 'the_nether') || (k === 'крепость' && v.dimension === 'overworld')))
    session.journal.patch(s => { if (!s.places) s.places = {}; for (const [k, v] of put) s.places[k] = { ...v } })
    return { mapped: put.map(([k]) => k), note: `Записал по карте: ${put.map(([k]) => k).join(', ') || 'ничего'}.` }
  }
  // forget — крепость разграблена, спавнер сломан или запись от другой игры:
  // стереть «крепость (ад)», «спавнер блейзов» и план обхода регионов.
  if (p.mode === 'forget') {
    const had = [PLACE, SPAWNER_PLACE].filter(k => placeOf(session, k))
    const hadSearch = !!(session.journal.state && session.journal.state.fortressSearch)
    session.journal.patch(s => {
      if (s.places) { delete s.places[PLACE]; delete s.places[SPAWNER_PLACE] }
      delete s.fortressSearch
    })
    return { mode: 'forget', found: false, forgot: had, search: hadSearch, note: `Забыл: ${had.join(', ') || 'крепости в памяти не было'}${hadSearch ? ', и план обхода регионов' : ''}.` }
  }
  if (here !== 'the_nether') {
    return { found: false, stopped: `крепость Ада бывает только в Аду, а я ${worlds.inWorld(here)} — сначала mc_portal mode=enter` }
  }
  if (p.mode === 'bastion') return bastionSearch(session, ctl, { deadline, radius, t0, high })
  const start = bot.entity.position.floored()
  const views = []
  let bastion = null
  const glance = () => {
    const v: any = look(bot, mcData, { radius })
    views.push({ at: xyz(bot.entity.position), seen: v.seen, rayChecked: v.rayChecked })
    console.log('[fortress] взгляд', JSON.stringify({ at: xyz(bot.entity.position), seen: v.seen, candidates: v.candidates, rayChecked: v.rayChecked }))
    for (const sp of v.spawners || []) rememberSpawner(session, sp)
    if (v.bastion) { bastion = v.bastion; rememberBastion(session, v.bastion) }
    return v
  }

  let v: any = glance()
  if (high && !v.seen && p.mode !== 'look' && !placeOf(session, PLACE)) { const h = await highLook(session, ctl, glance); console.log('[fortress] взгляд с вышки', JSON.stringify({ ...h, v: undefined })); if (h.v && (h.v.seen || h.v.bastion)) v = h.v }
  // Без mode — auto: так зовёт автомат (director.js: fortress без параметров),
  // и «только оглядеться» там значило бы стоять у портала вечно.
  const mode = ['look', 'explore'].includes(p.mode) ? p.mode : 'auto'
  const legs = []
  let stopped = null
  let fromMemory = null
  let search = null
  if (mode === 'explore' && !v.seen) {
    const dirName = DIRS[p.direction] ? p.direction : 'east'
    const r = await walkLine(session, ctl, { start, dirName, along: 0, maxWalk: clamp(p.distance ?? 160, 16, 600), deadline, glance, legs })
    v = r.v
    stopped = r.stopped
  }
  if (mode === 'auto' && !v.seen) {
    const rec = placeOf(session, PLACE)
    if (rec && worlds.worldOfRecord(rec) === here) {
      fromMemory = rec
    } else {
      const r = await sweep(session, ctl, { deadline, glance, legs, v, high })
      v = r.v
      stopped = r.stopped
      search = r.plan
    }
  }

  const detail: any = {
    found: v.seen > 0 || !!fromMemory,
    mode,
    // Сколько кирпича нашёл findBlocks за стенами — НЕ мозгу: это рентген
    // (fairPlay). Мозг получает только проверенное лучом; полное число — в
    // лог демона для разбора.
    fortress: v.seen
      ? { seen: v.seen, rayChecked: v.rayChecked, nearest: v.nearest, dist: v.dist, bearing: v.bearing, spanY: v.spanY }
      : fromMemory
        ? { fromMemory: true, nearest: { x: fromMemory.x, y: fromMemory.y, z: fromMemory.z }, dist: Math.round(bot.entity.position.distanceTo(new Vec3(fromMemory.x, fromMemory.y, fromMemory.z))) }
        : { seen: 0, rayChecked: v.rayChecked },
    spawners: v.spawners,
    blazes: v.blazes,
    bastion: bastion || undefined,
    walked: Math.round(bot.entity.position.distanceTo(start)),
    looks: views.length,
    legs: legs.length ? legs.slice(-10) : undefined,
    search: search || undefined,
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (v.seen) {
    remember(session, v.nearest, `крепость Ада: кирпич виден на ${v.nearest.x},${v.nearest.y},${v.nearest.z} (${v.dist} бл. на ${v.bearing} от ${detail.at.x},${detail.at.z})`)
    detail.note = `Вижу крепость Ада: nether_bricks ${v.seen} блок(ов), ближайший в ${v.dist} бл. на ${v.bearing} ` +
      `(${v.nearest.x},${v.nearest.y},${v.nearest.z}); луч проверил ${v.rayChecked} мест — видимое это нижняя граница. ` +
      `Записал «${PLACE}».` +
      (v.spawners ? ` Спавнер виден: ${v.spawners.map(s => `${s.x},${s.y},${s.z}`).join('; ')} — это тронный зал, mc_blaze.` : ' Спавнера отсюда не видно — mc_blaze сам обойдёт крепость по видимому кирпичу.') +
      (v.blazes ? ` Блейзов видно ${v.blazes.seen}.` : '')
  } else if (fromMemory) {
    const sp = placeOf(session, SPAWNER_PLACE)
    detail.note = `Крепость в памяти: «${PLACE}» на ${fromMemory.x},${fromMemory.y},${fromMemory.z} (${detail.fortress.dist} бл.). ` +
      (sp && worlds.worldOfRecord(sp) === here ? `Спавнер в памяти: ${sp.x},${sp.y},${sp.z}. ` : '') +
      'mc_blaze дойдёт туда сам. Искать другую — mode=explore с направлением.'
  } else {
    detail.stopped = stopped || `кирпича крепости в ${radius} блоках не видно`
    detail.note = mode === 'look'
      ? 'Отсюда крепости не видно. Искать — без mode (обход регионов от портала, продолжает с того же места) или mode=explore с направлением: крепости Ада — длинные коридоры, их пересекают, идя вдоль оси X (east/west).'
      : mode === 'auto'
        ? `Не нашёл за этот вызов — обход запомнен (регион ${search ? search.region.join(',') : '?'}, точка ${search ? search.point + 1 : '?'} из ${search ? search.of : '?'}), следующий вызов продолжит. В каждом регионе 432x432 одна постройка, крепость — в 40%.`
        : 'Не нашёл. Попробуй другое направление (east/west, потом north/south) — в каждом регионе 432x432 одна постройка, и это крепость лишь в 40%.'
  }
  if (bastion) detail.note += ` Похоже на бастион: ${bastion.seen} видимых блоков блэкстоун-кирпича, ближайший в ${bastion.dist} бл. на ${bastion.bearing} (${bastion.nearest.x},${bastion.nearest.y},${bastion.nearest.z}) — записал «${BASTION_PLACE}»: пиглины и золото, жемчуг бартером.`
  return detail
}

// mode=bastion — найти бастион обходом регионов, как крепость (sweep want=bastion): жемчуг — бартером в бастионах
// (правило пользователя), а «бастион (ад)» в памяти бывал, только если разведка крепости случайно его видела (ферма
// 02.10, новые миры: крепость в регионе портала — бастиона в памяти нет, и после стержней шли эндермены).
async function bastionSearch (session, ctl, { deadline, radius, t0, high = false }: any) {
  const bot = session.bot
  const mcData = session.mcData
  // В памяти — непройденный бастион: он и есть ответ; выработанные (кампания записала «выработан: …») — искать новый.
  const recKey = BASTION_KEYS_ALL.find(k => { const r = placeOf(session, k); return r && worlds.worldOfRecord(r) === 'the_nether' && !bastionSpentNear(session, r) })
  const rec = recKey ? placeOf(session, recKey) : null
  if (rec) {
    const dist = Math.round(Math.hypot(rec.x - bot.entity.position.x, rec.z - bot.entity.position.z))
    return { mode: 'bastion', found: true, bastion: { fromMemory: true, nearest: { x: rec.x, y: rec.y, z: rec.z }, dist }, note: `Бастион в памяти: «${recKey}» на ${rec.x},${rec.y},${rec.z} (${dist} бл.).` }
  }
  const start = bot.entity.position.floored()
  let bastion = null
  let looks = 0
  const glance = () => {
    const v: any = look(bot, mcData, { radius })
    looks++
    // Кирпич выработанного бастиона — не находка.
    if (v.bastion && bastionSpentNear(session, v.bastion.nearest)) v.bastion = null
    console.log('[fortress] бастион: взгляд', JSON.stringify({ at: xyz(bot.entity.position), bastion: v.bastion ? v.bastion.seen : 0, bricks: v.seen }))
    for (const sp of v.spawners || []) rememberSpawner(session, sp)
    if (v.bastion) { bastion = v.bastion; rememberBastion(session, v.bastion) }
    if (v.seen && !placeOf(session, PLACE)) remember(session, v.nearest, `крепость Ада: кирпич виден на ${v.nearest.x},${v.nearest.y},${v.nearest.z} (${v.dist} бл.), попутно с поиском бастиона`)
    return v
  }
  let v: any = glance()
  const legs = []
  let stopped = null
  let search = null
  if (!v.bastion && high) { const h = await highLook(session, ctl, glance); log('бастион: взгляд с вышки', { ...h, v: undefined }); if (h.v) v = h.v }
  if (!v.bastion) {
    const r = await sweep(session, ctl, { deadline, glance, legs, v, want: 'bastion', high })
    stopped = r.stopped
    search = r.plan
  }
  const detail: any = {
    mode: 'bastion',
    found: !!bastion,
    bastion: bastion || undefined,
    walked: Math.round(bot.entity.position.distanceTo(start)),
    looks,
    legs: legs.length ? legs.slice(-10) : undefined,
    search: search || undefined,
    at: xyz(bot.entity.position),
    seconds: Math.round((gameClock.now() - t0) / 1000)
  }
  if (bastion) {
    detail.note = `Вижу бастион: ${bastion.seen} видимых блоков блэкстоун-кирпича, ближайший в ${bastion.dist} бл. на ${bastion.bearing} (${bastion.nearest.x},${bastion.nearest.y},${bastion.nearest.z}) — записал «${BASTION_PLACE}».`
  } else {
    detail.stopped = stopped || 'бастиона не видно'
    detail.note = `Бастиона не нашёл за этот вызов — обход запомнен (регион ${search ? search.region.join(',') : '?'}, точка ${search ? search.point + 1 : '?'} из ${search ? search.of : '?'}), следующий вызов mode=bastion продолжит.`
  }
  return detail
}

// Взгляд сверху (как игрок с вышки): столб до +20 (под потолком Ада не выше 118), взгляд, вниз — разбирая свой столб.
// Мост крепости (y 48–70) и вал бастиона над лавовым морем с высоты видны через полкарты, с земли — нет: на новых мирах
// 02.10 разведка 5 мин «кирпича не видно» в 4 мирах из 6 (крепость в 250–415 бл.). Только где над головой открыто ≥ 8.
async function highLook (session, ctl, glance, { up = 20 }: any = {}) {
  const bot = session.bot
  const { towerUp } = require('./build')
  const base = bot.entity.position.floored()
  let free = 0
  for (let y = 2; y <= up + 2; y++) { const b = bot.blockAt(base.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || /lava/.test(b.name)) break; free++ }
  const n = Math.min(up, free - 1, 118 - base.y)
  if (n < 8) return { skipped: `над головой открыто ${free}` }
  const t = await towerUp(bot, ctl, n, { sneak: true }).catch(e => ({ ok: false, reason: e.message }))
  const top = bot.entity.position.floored()
  const v = glance()
  for (let i = 0; i < n + 6 && !ctl.aborted; i++) {
    const f = bot.entity.position.floored()
    if (f.y <= base.y) break
    const below = bot.blockAt(f.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') { await sleep(300); continue }
    try { await bot.dig(below, true) } catch { break }
    await sleep(250)
  }
  return { up: top.y - base.y, placed: t && t.placed, seen: v.seen, bastion: !!v.bastion, v }
}

function placeOf (session, key) {
  const places = (session.journal.state && session.journal.state.places) || {}
  return places[key] || null
}

// Прямая по направлению отрезками по 16 блоков, взгляд после каждого, пока
// кирпич не увиден или не кончились maxWalk/время. start и along — откуда
// считать отрезки. stopWhen(v) — когда взгляд кончает прямую (по умолчанию — кирпич крепости или бастион).
async function walkLine (session, ctl, { start, dirName, along = 0, maxWalk, deadline, glance, legs, onStep = null, stopWhen = null }: any) {
  const bot = session.bot
  const [dx, dz] = DIRS[dirName]
  let side = 0
  let fails = 0
  let v: any = { seen: 0 }
  let stopped = null
  while (!ctl.aborted && gameClock.now() < deadline && along < maxWalk) {
    const step = 16
    const me = bot.entity.position
    // Цель — впереди по направлению, со сдвигом вбок, если прямо не пройти.
    const tx = Math.round(start.x + dx * (along + step) + (dz !== 0 ? side : 0))
    const tz = Math.round(start.z + dz * (along + step) + (dx !== 0 ? side : 0))
    const w = await legTo(session, ctl, tx, tz, deadline)
    legs.push({ to: { x: tx, z: tz }, ok: w.ok, down: w.down, bored: w.bored, fought: w.fought, error: w.ok ? undefined : w.error, from: xyz(me) })
    if (w.fought) {
      // Отбился — тот же отрезок заново; не отбился и хп мало — стоп.
      if ((bot.health ?? 0) < 8) { stopped = w.error + `, хп ${Math.round(bot.health ?? 0)} — дальше не иду`; break }
    } else if (w.ok) {
      along += step
      side = 0
      if (onStep) onStep(along)
    } else if (Math.abs(side) < 24 && ++fails <= 6) {
      // Прямо не прошёл (лавовое озеро, обрыв) — то же расстояние, но вбок.
      side = side <= 0 ? -side + 8 : -side
    } else {
      stopped = `на ${WORDS[dirName]} дороги нет ни прямо, ни в стороны на 24 блока: ${w.error}`
      break
    }
    v = glance()
    if (stopWhen ? stopWhen(v) : (v.seen || v.bastion)) break
  }
  if (!v.seen && !stopped) stopped = ctl.aborted ? 'прервано' : (along >= maxWalk ? `прошёл ${along} блоков на ${WORDS[dirName]} — кирпича не видно` : 'время вышло')
  return { v, along, stopped }
}

// Поиск по регионам nether_complexes (байткод paper-1.21.11,
// RandomSpreadStructurePlacement.getPotentialStructureChunk): стартовый чанк
// постройки = floorDiv(чанк, 27)·27 + nextInt(27 − 4), то есть в каждом
// регионе 432x432 ровно одна постройка, и её старт лежит в квадрате 368x368 у
// северо-западного угла региона (23 чанка). Куски крепости — до 112 блоков от
// старта (NetherBridgePiece: bipush 112). Поэтому поиск — «газонокосилкой» по
// этому квадрату: три полосы вдоль X (совет спидраннеров — идти по X) на
// z0+48, z0+176, z0+304: взгляд в 64 блока покрывает квадрат целиком. Регион
// пройден (или в нём виден бастион — тогда крепости в нём нет) — соседний,
// ближайший к порталу Ада. План — в памяти (fortressSearch): следующий вызов
// продолжает с той же точки. Отрезок закрыт (лава во всю ширину) — следующая
// точка от того места, где тело стоит.
const REGION = 432
const ZONE = 23 * 16
const STRIPES = [48, 176, 304]
function regionOf (x, z) { return [Math.floor(x / REGION), Math.floor(z / REGION)] }
function stripesOf (rx, rz, me) {
  const x0 = rx * REGION - 16
  const x1 = rx * REGION + ZONE + 16
  let rows = STRIPES.map(o => rz * REGION + o)
  // Ближняя полоса первой, ближний край первым — змейкой.
  if (Math.abs(me.z - rows[2]) < Math.abs(me.z - rows[0])) rows = rows.reverse()
  let west = Math.abs(me.x - x0) <= Math.abs(me.x - x1)
  const wps = []
  for (const z of rows) {
    wps.push(west ? { x: x0, z } : { x: x1, z }, west ? { x: x1, z } : { x: x0, z })
    west = !west
  }
  return wps
}
// Соседи по кольцам вокруг региона портала, ближние первыми.
function nextRegion (plan) {
  const [ox, oz] = regionOf(plan.origin.x, plan.origin.z)
  const done = new Set(plan.done.map(r => r.join(',')))
  for (let ring = 1; ring <= 3; ring++) {
    const cand = []
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
        const r = [ox + dx, oz + dz]
        if (!done.has(r.join(','))) cand.push(r)
      }
    }
    if (cand.length) {
      const c = [(0.5) * REGION, (0.5) * REGION]
      cand.sort((a, b) => Math.hypot(a[0] * REGION + c[0] - plan.origin.x, a[1] * REGION + c[1] - plan.origin.z) -
        Math.hypot(b[0] * REGION + c[0] - plan.origin.x, b[1] * REGION + c[1] - plan.origin.z))
      return cand[0]
    }
  }
  return null
}

// До точки по прямым: сначала по оси, где дальше, потом по другой — отрезками
// по 16 со взглядом после каждого (walkLine).
async function walkTo (session, ctl, to, { deadline, glance, legs, stopWhen = null }: any) {
  const bot = session.bot
  let v: any = { seen: 0 }
  let stopped = null
  // Ось закрыта (лава, обрыв) — другая ось, потом снова первая: полосу в 128
  // блоков можно пройти и на 40 блоков севернее — взгляд в 64 её покроет
  // (прогон 8: юг с z=263 закрыт, и вся последняя полоса ушла в «пройдено»).
  const closed = new Set()
  for (let turn = 0; turn < 6 && !ctl.aborted && gameClock.now() < deadline; turn++) {
    const me = bot.entity.position
    const dx = to.x - me.x
    const dz = to.z - me.z
    if (Math.abs(dx) <= 8 && Math.abs(dz) <= 8) { stopped = null; break }
    const axes = (Math.abs(dx) >= Math.abs(dz) ? ['x', 'z'] : ['z', 'x'])
      .filter(a => Math.abs(a === 'x' ? dx : dz) > 8 && !closed.has(a))
    if (!axes.length) break
    const ax = axes[0]
    const dirName = ax === 'x' ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
    const dist = Math.abs(ax === 'x' ? dx : dz)
    const r = await walkLine(session, ctl, {
      start: { x: Math.round(me.x), z: Math.round(me.z) },
      dirName,
      along: 0,
      maxWalk: Math.max(16, Math.round(dist / 16) * 16),
      deadline,
      glance,
      legs,
      stopWhen
    })
    v = r.v
    if (stopWhen ? stopWhen(v) : (v.seen || v.bastion)) { stopped = null; break }
    if (r.along < dist - 8) {
      stopped = r.stopped
      closed.add(ax)
    } else {
      // Прошёл по оси — закрытая раньше может открыться с нового места.
      closed.clear()
    }
  }
  return { v, stopped }
}

// want='bastion' — тот же обход регионов, но цель — бастион (fortress mode=bastion): свой план в памяти (bastionSearch),
// регион известной крепости и регионы, пройденные обходом крепости, пропускаются (в регионе одна постройка), стоп —
// когда взгляд увидел бастион; кирпич крепости обход не останавливает.
async function sweep (session, ctl, { deadline, glance, legs, v, want = 'fortress', high = false }: any) {
  const bot = session.bot
  const forBastion = want === 'bastion'
  const KEY = forBastion ? 'bastionSearch' : 'fortressSearch'
  const hit = forBastion ? (x => !!(x && x.bastion)) : (x => !!(x && x.seen))
  let plan = session.journal.state && session.journal.state[KEY]
  if (!plan || plan.world !== 'the_nether' || !plan.origin || !plan.region) {
    const portal = placeOf(session, worlds.portalKey('the_nether'))
    const o = portal && worlds.worldOfRecord(portal) === 'the_nether' ? portal : xyz(bot.entity.position)
    const region = regionOf(o.x, o.z)
    plan = { world: 'the_nether', origin: { x: o.x, z: o.z }, region, done: [], wps: stripesOf(region[0], region[1], o), i: 0 }
    if (forBastion) {
      const skip = []
      const fort = placeOf(session, PLACE)
      if (fort && worlds.worldOfRecord(fort) === 'the_nether') skip.push(regionOf(fort.x, fort.z))
      const fs0 = session.journal.state && session.journal.state.fortressSearch
      if (fs0 && fs0.world === 'the_nether' && Array.isArray(fs0.done)) skip.push(...fs0.done)
      plan.done = skip.filter((r, k) => skip.findIndex(q => q[0] === r[0] && q[1] === r[1]) === k)
      if (plan.done.some(r => r[0] === region[0] && r[1] === region[1])) {
        const next = nextRegion(plan)
        if (next) { plan.region = next; plan.wps = stripesOf(next[0], next[1], bot.entity.position) }
      }
    }
  } else {
    plan = { ...plan, done: [...(plan.done || [])], wps: [...(plan.wps || [])] }
  }
  const save = () => session.journal.patch(s => { s[KEY] = { ...plan } })
  // high: сначала кольца точек обзора вокруг портала (128 и 256 бл., 8 направлений, ближняя первой), на каждой —
  // взгляд с вышки радиусом 128; полосы региона — потом. Полосы одного региона — 1200+ бл. ходьбы (~0.85 бл/с на
  // новых мирах 02.10), а крепость часто в соседнем регионе через границу (портал у z=−2, крепость у z=288).
  if (high && !plan.rings) {
    const pts = []
    for (const R of [128, 256]) for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; pts.push({ x: Math.round(plan.origin.x + R * Math.cos(a)), z: Math.round(plan.origin.z + R * Math.sin(a)) }) }
    const order = []
    let cur = { x: bot.entity.position.x, z: bot.entity.position.z }
    while (pts.length) {
      let bi = 0
      for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i].x - cur.x, pts[i].z - cur.z) < Math.hypot(pts[bi].x - cur.x, pts[bi].z - cur.z)) bi = i
      cur = pts.splice(bi, 1)[0]
      order.push(cur)
    }
    plan.rings = { wps: order, i: 0 }
  }
  save()
  let stopped = null
  let blocked = 0
  while (high && plan.rings && plan.rings.i < plan.rings.wps.length && !ctl.aborted && gameClock.now() < deadline) {
    const to = plan.rings.wps[plan.rings.i]
    const r = await walkTo(session, ctl, to, { deadline, glance, legs, stopWhen: hit })
    v = r.v
    if (hit(v)) { stopped = null; save(); return { v, stopped, plan: { origin: plan.origin, rings: plan.rings.i, of: plan.rings.wps.length } } }
    if (ctl.aborted || gameClock.now() >= deadline) break
    const h = await highLook(session, ctl, glance)
    log(forBastion ? 'бастион: точка обзора' : 'точка обзора', { i: plan.rings.i, to, at: xyz(bot.entity.position), up: h.up, skipped: h.skipped, seen: h.seen, bastion: h.bastion })
    plan.rings.i++
    save()
    if (h.v && hit(h.v)) { v = h.v; return { v, stopped: null, plan: { origin: plan.origin, rings: plan.rings.i, of: plan.rings.wps.length } } }
  }
  while (!ctl.aborted && gameClock.now() < deadline) {
    if (plan.i >= plan.wps.length || (!forBastion && v && v.bastion)) {
      // Регион пройден, или в нём бастион (одна постройка на регион) — дальше.
      plan.done.push(plan.region)
      const next = nextRegion(plan)
      if (!next) { stopped = `обошёл регионы в трёх кольцах вокруг портала — ${forBastion ? 'бастиона' : 'крепости'} не видел`; break }
      plan.region = next
      plan.wps = stripesOf(next[0], next[1], bot.entity.position)
      plan.i = 0
      v = { seen: 0 }
      save()
      if (high) { const h = await highLook(session, ctl, glance); if (h.v && hit(h.v)) { v = h.v; stopped = null; break } }
    }
    const to = plan.wps[plan.i]
    const r = await walkTo(session, ctl, to, { deadline, glance, legs, stopWhen: forBastion ? hit : null })
    v = r.v
    stopped = r.stopped
    if (hit(v)) { stopped = null; break }
    if (ctl.aborted || gameClock.now() >= deadline) break
    if (r.stopped) blocked++
    else blocked = 0
    plan.i++
    save()
    if (blocked >= 4) break
  }
  return {
    v,
    stopped,
    plan: { origin: plan.origin, region: plan.region, regionsDone: plan.done.length, point: plan.i, of: plan.wps.length, next: plan.wps[plan.i] || null }
  }
}

// Тронный зал по видимому кирпичу: подойти к видимому кирпичу, оглядеться,
// следующий — самый далёкий от уже пройденных мест, пока не увиден спавнер
// или не кончились шаги. Для blaze.js, когда крепость найдена, а спавнера
// не видно ни глазами, ни в памяти.
async function climbTo (session, ctl, top, deadline) {
  const w = await climbWalk(session, ctl, top, deadline)
  if (w.ok || w.fought || ctl.aborted || gameClock.now() > deadline) return w
  const bot = session.bot
  if (top.y + 1 - bot.entity.position.y < 3) return w
  // Ногами наверх не вышло (в Аду pathfinder без столба 1x1, worlds.js) —
  // ступеньками штрека: вверх на 1 за шаг к точке, пустоту под ногами
  // закладывает наш placeBlockAt.
  const b = await require('./nether').bore(session, ctl, { x: top.x, z: top.z }, {
    deadline: Math.min(deadline, gameClock.now() + 60000), maxSteps: 40, maxY: top.y + 1, throughBricks: true
  })
  const p = bot.entity.position
  return p.y >= top.y - 1 && Math.hypot(p.x - top.x, p.z - top.z) <= 6
    ? { ok: true, bored: b.dug, placed: b.placed }
    : { ok: false, error: `${w.error}; ступеньками: ${b.why || 'не дошёл'}`, bored: b.dug }
}

async function climbWalk (session, ctl, top, deadline) {
  const bot = session.bot
  const { goals } = require('mineflayer-pathfinder')
  const { stuckGuard } = require('./movement')
  return require('./nether').guarded(session, ctl, async sub => {
    const guard = stuckGuard(bot, sub, 10000)
    let timer = null
    // Подъём на 20–30 блоков столбом — длинный поиск: 5 с по умолчанию
    // pathfinder'у не хватало («Took to long to decide path»).
    const think = bot.pathfinder.thinkTimeout
    bot.pathfinder.thinkTimeout = Math.max(think || 0, 12000)
    try {
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNear(top.x, top.y + 1, top.z, 3)),
        guard.promise,
        new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('время вышло')), Math.max(1000, Math.min(40000, deadline - gameClock.now()))) })
      ])
      const p = bot.entity.position
      return p.distanceTo(new Vec3(top.x + 0.5, top.y + 1, top.z + 0.5)) <= 5 ? { ok: true } : { ok: false, error: 'на мост не вышел' }
    } catch (e) {
      try { bot.pathfinder.setGoal(null) } catch {}
      return { ok: false, error: e.message }
    } finally {
      bot.pathfinder.thinkTimeout = think
      guard.stop()
      if (timer) gameClock.clearTimeout(timer)
    }
  })
}

async function tour (session, ctl, { deadline, hops = 8 }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const here = worlds.worldOf(bot)
  const visited = []
  const path = []
  let pillars = 0
  const lookNow = () => {
    const v: any = look(bot, mcData, { radius: 64 })
    for (const sp of v.spawners || []) rememberSpawner(session, sp)
    console.log('[fortress] обход', JSON.stringify({ at: xyz(bot.entity.position), seen: v.seen, spawners: (v.spawners || []).length, blazes: v.blazes }))
    return v
  }
  let v: any = lookNow()
  for (let i = 0; i < hops && !v.spawners && !ctl.aborted && gameClock.now() < deadline; i++) {
    const me = bot.entity.position
    visited.push(me.clone())
    // Видны блейзы — к ним: они висят у спавнера (±4 от него), а спавнер
    // виден глазами только ближе 48 (прогон 12: блейзы в 36, спавнера нет).
    const far = (v.blazeList || []).filter(b => b.distanceTo(me) > 12)
    if (far.length) {
      const b = far.reduce((a, c) => (c.distanceTo(me) < a.distanceTo(me) ? c : a))
      const w = await climbTo(session, ctl, b.offset(0, -3, 0), deadline)
      path.push({ to: xyz(b), blaze: true, ok: w.ok, y: Math.floor(bot.entity.position.y), error: w.ok ? undefined : w.error })
      v = lookNow()
      continue
    }
    let pool = (v.seenList || []).filter(p => p.distanceTo(me) <= 64)
    if (!pool.length) {
      // Кирпича не видно — к крепости из памяти.
      const rec = placeOf(session, PLACE)
      if (!rec || worlds.worldOfRecord(rec) !== here) break
      pool = [new Vec3(rec.x, rec.y, rec.z)]
    }
    const score = p => Math.min(...visited.map(q => Math.hypot(p.x - q.x, p.z - q.z)))
    const pick = pool.reduce((a, b) => (score(b) > score(a) ? b : a))
    if (score(pick) < 8) {
      // Всё видимое рядом, а крепость над головой: разведка с полом y=40 видит
      // её снизу — опоры и днище мостов, а мосты и тронный зал на 64+. Как
      // игрок: к ближайшей опоре и столбом вверх до верхнего видимого кирпича
      // (build.towerUp, блок под себя с проверкой), оттуда — снова взгляд.
      // 2026-09-26 (22:48): крепость найдена с y=41, обход кончался за один
      // шаг («видно 6, спавнеров 0») пять вызовов подряд.
      const feet = bot.entity.position.floored()
      // Выше палубы не лезем; ниже — вверх, даже если кирпич сверху не виден:
      // снизу видны 3-4 блока днища, и «над головой ничего» — это не правда
      // (прогон 00:00: y=45, «видно 3», столба не было).
      const above0 = pool.filter(p => Math.hypot(p.x - feet.x, p.z - feet.z) <= 16 && p.y >= feet.y + 3)
      const above = above0.length ? above0 : (feet.y < 60 ? pool : [])
      if (!above.length || pillars >= 2) break
      const base = above.reduce((a, b) => (Math.hypot(b.x - feet.x, b.z - feet.z) < Math.hypot(a.x - feet.x, a.z - feet.z) ? b : a))
      await climbWalk(session, ctl, new Vec3(base.x, Math.max(feet.y - 1, bot.entity.position.y - 1), base.z), deadline)
      // Снизу видно только низ опор — до него мало (прогон 23:04: +4 блока, и
      // опять «видно 3»). Мосты и зал — на 48..70 (NetherBridgePieces:
      // moveInsideHeights 48, 70): столб до 66, оттуда видно палубу.
      const topY = Math.max(66, ...above.map(p => p.y))
      const from = Math.floor(bot.entity.position.y)
      const up = await require('./build').towerUp(bot, ctl, Math.max(1, Math.min(28, topY + 1 - from)), { sneak: true })
      pillars++
      path.push({ pillar: up.placed, from, y: Math.floor(bot.entity.position.y), ok: up.ok, error: up.ok ? undefined : up.reason })
      v = lookNow()
      continue
    }
    // НА мост, а не под него: тронный зал и блейзы — на палубе крепости
    // (y 48..70), а GoalNearXZ высоты не спрашивает — прогон 9 обошёл крепость
    // по дну на y=34 и видел только опоры. Цель — верх самого высокого
    // видимого кирпича у выбранной точки; не вышло — хотя бы по x,z.
    const top = pool.filter(p => Math.hypot(p.x - pick.x, p.z - pick.z) <= 4).reduce((a, b) => (b.y > a.y ? b : a), pick)
    let w = await climbTo(session, ctl, top, deadline)
    if (!w.ok && !w.fought) w = await legTo(session, ctl, pick.x, pick.z, deadline)
    path.push({ to: xyz(top), ok: w.ok, y: Math.floor(bot.entity.position.y), error: w.ok ? undefined : w.error })
    v = lookNow()
  }
  return { spawners: v.spawners, blazes: v.blazes, seen: v.seen, hops: path, at: xyz(bot.entity.position) }
}

// mode=spawner — дойти до спавнера блейзов. Спавнер виден клиенту, как только
// прогружен его чанк (findBlocks по загруженным чанкам — так решил
// координатор: «виден» без луча), а тур по видимому кирпичу до тронного зала
// не доходил: у найденной крепости «блейзов в 20 блоках не вижу» 20+ раз
// (2026-09-26/27). Дальний — отрезками (legTo: ноги, штрек), ближний —
// climbTo (pathfinder к клетке над спавнером, столб/ступени). Стоп в 10 блоках:
// бой у спавнера ведёт blaze.js (коробка с окном у спавнера).
// Над залом спавнера (штрек вывел на крышу крепости — neF-Q26-1 02.10: 18 бл. над спавнером в 4 бл. по горизонтали,
// 14 вызовов climbTo «на мост не вышел», потом иссушитель): копать вниз под собой, пока ноги выше уровня спавнера.
// Не копать: над лавой (без огнестойкости), у лавы сбоку от клетки (затечёт в шахту), если падение > 6, сам спавнер.
async function digDownTo (session, ctl, sp, deadline) {
  const bot = session.bot
  const SL = require('./sealed')
  const fireproof = () => !!(bot.entity.effects && (Object.values(bot.entity.effects) as any[]).some((e : any) => e && (e.id === 12 || /fire_resistance/.test(String(e.name || '')))))
  const lavaAt = v => { const b = bot.blockAt(v); return !!b && /lava/.test(b.name) }
  let dug = 0
  for (let k = 0; k < 40 && !ctl.aborted && gameClock.now() < deadline; k++) {
    const f = bot.entity.position.floored()
    if (f.y <= sp.y + 1) return { ok: true, dug }
    const c = f.offset(0, -1, 0)
    const b1 = bot.blockAt(c)
    if (!b1) return { ok: false, dug, why: 'непрогруженный мир' }
    if (/lava|water|fire/.test(b1.name)) return { ok: false, dug, why: `под ногами ${b1.name}` }
    if (b1.boundingBox === 'empty') { await sleep(300); continue }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (lavaAt(c.offset(dx, 0, dz))) return { ok: false, dug, why: 'лава у шахты' }
    let depth = 0; let land = null
    for (let d = 2; d <= 14; d++) {
      const b = bot.blockAt(f.offset(0, -d, 0))
      if (!b) break
      if (b.boundingBox !== 'empty' || /lava|water/.test(b.name)) { land = b; break }
      depth++
    }
    if (land && /lava/.test(land.name) && !fireproof()) return { ok: false, dug, why: 'под колонной лава' }
    // Падение глубже 6 — только с полным здоровьем (урон = высота − 3: до 9 при 11 клетках воздуха под копкой).
    const maxDepth = (bot.health ?? 20) >= 18 ? 11 : 6
    if (!land || depth > maxDepth) return { ok: false, dug, why: `падение ${land ? depth : depth + '+'}` }
    const r = await SL.digCell(bot, c, { allowGuard: false })
    if (r !== 'ok' && r !== 'air') return { ok: false, dug, why: `копка: ${r}` }
    dug++
    for (let i = 0; i < 30 && !bot.entity.onGround; i++) await sleep(100)
    await sleep(150)
  }
  return { ok: false, dug, why: 'не спустился' }
}

// Тело у зала в толще (штрек/ноги довели «на уровень» в 2–9 бл.), а спавнер не виден: прямой ход 1×2 к клетке
// помоста рядом со спавнером (MonsterThrone: помост 5×5 вокруг спавнера, ноги — на его высоте). neF-XF21-2 03.10: тело
// в 5 бл. (120,67,69 при спавнере 123,67,73) за стеной зала — 3 боя по 400 с «ифриты за стеной», 0 убийств.
// Копает только клетки хода (лицо впереди — его видно), у лавы и над обрывом — стоп. Вкл. — ND_SPAWNER_BREACH=1.
async function breachToSpawner (session, ctl, sp, deadline) {
  const bot = session.bot
  const SL = require('./sealed')
  const seesSp = () => { try { const b = bot.blockAt(sp); return !!b && bot.canSeeBlock(b) } catch { return false } }
  const solid = b => !!b && b.boundingBox === 'block'
  const hot = b => !!b && /lava|fire|magma/.test(b.name)
  const me0 = bot.entity.position.floored()
  // Цель — соседняя со спавнером клетка помоста, ближняя к телу (ноги на sp.y, под ногами — твёрдое, не лава).
  const goals0 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    .map(([dx, dz]) => sp.offset(dx, 0, dz))
    .filter(c => !hot(bot.blockAt(c.offset(0, -1, 0))) && solid(bot.blockAt(c.offset(0, -1, 0))))
    .sort((a, b) => a.distanceTo(me0) - b.distanceTo(me0))
  const goal = goals0[0] || sp.offset(Math.sign(me0.x - sp.x) || 1, 0, 0)
  const out: any = { ok: false, steps: 0, dug: 0, goal: xyz(goal) }
  const lavaAround = c => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([x, y, z]) => { const b = bot.blockAt(c.offset(x, y, z)); return !!b && /lava/.test(b.name) })
  for (let s = 0; s < 16 && !ctl.aborted && gameClock.now() < deadline; s++) {
    if (seesSp()) { out.ok = true; break }
    const f = bot.entity.position.floored()
    if (f.equals(goal)) break
    const dx = goal.x - f.x; const dz = goal.z - f.z; const dy = goal.y - f.y
    // Сперва по высоте (ступенью), потом по длинной оси.
    let step
    if (Math.abs(dx) >= Math.abs(dz) && dx !== 0) step = [Math.sign(dx), 0]
    else if (dz !== 0) step = [0, Math.sign(dz)]
    else step = [0, 0]
    const up = dy > 0 ? 1 : dy < 0 ? -1 : 0
    if (!step[0] && !step[1] && !up) break
    const next = f.offset(step[0], up, step[1])
    // Клетки хода: ноги и голова следующей клетки; ступень вверх — ещё над своей головой.
    const cells = [next.offset(0, 1, 0), next]
    if (up > 0) cells.unshift(f.offset(0, 2, 0))
    if (up < 0) cells.unshift(next.offset(0, 2, 0))
    let bad = ''
    for (const c of cells) {
      const b = bot.blockAt(c)
      if (!b) { bad = 'не прогружено'; break }
      if (/lava/.test(b.name) || lavaAround(c)) { bad = 'лава у хода'; break }
      if (b.boundingBox === 'empty') continue
      if (c.equals(sp)) { bad = 'спавнер на пути'; break }
      const r = await SL.digCell(bot, c)
      if (r === 'ok' || r === 'air') { out.dug++; continue }
      bad = `${b.name}: ${r}`; break
    }
    if (bad) { out.why = bad; break }
    // Пол под следующей клеткой: воздух — обрыв (через ограду зала не прыгать), лава — нельзя.
    const floor = bot.blockAt(next.offset(0, -1, 0))
    if (!floor || hot(floor)) { out.why = 'пол у хода — лава'; break }
    if (floor.boundingBox === 'empty') {
      const f2 = bot.blockAt(next.offset(0, -2, 0))
      if (!solid(f2) || hot(f2)) { out.why = 'обрыв у хода'; break }
    }
    const moved = await SL.stepMove(bot, ctl, { kind: up > 0 ? 'up' : 'flat', to: next })
    out.steps++
    if (!moved && !bot.entity.position.floored().equals(next)) { out.why = 'не шагнул'; break }
  }
  out.ok = out.ok || seesSp()
  out.at = xyz(bot.entity.position.floored())
  log('ход к спавнеру сквозь стену', out)
  return out
}

// ND_NE_ROUTE=1: аварийный отход автопилота у тронного зала (бег на месте под блейзами/иссушителями) кончался смертью
// (neF-B4f22, B6f22, B7f31 03.10) — на время пути к спавнеру тело бережёт себя само (бой на ходу, огнестойкость).
async function toSpawner (session, ctl, opts) {
  // Только при сетке копии мира (ход по ней) — иначе как было.
  if (process.env.ND_NE_ROUTE === '0' || !require('./nether-route').gridOf(session)) return toSpawnerBody(session, ctl, opts)
  const em0 = session.emergencyOff
  session.emergencyOff = true
  try { return await toSpawnerBody(session, ctl, opts) } finally { session.emergencyOff = em0 }
}

async function toSpawnerBody (session, ctl, { deadline, tunnel = false }: any) {
  const bot = session.bot
  const id = session.mcData.blocksByName.spawner.id
  const found = bot.findBlocks({ matching: id, maxDistance: 160, count: 6 })
  const rec = placeOf(session, SPAWNER_PLACE)
  let sp = null
  if (found.length) {
    const me = bot.entity.position
    // Спавнер крепости — на высоте мостов (48..90), ниже 40 — не наш.
    const ok = found.filter(p => p.y >= 40).sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    if (ok.length) sp = ok[0]
  }
  if (!sp && rec && worlds.worldOfRecord(rec) === 'the_nether') sp = new Vec3(rec.x, rec.y, rec.z)
  const legs = []
  // ND_NE_ROUTE=1 и сетка копии мира есть — весь путь к помосту спавнера одним планом (nether-route: штрек, мосты,
  // спрыгивания по 2–3, без лавы в клетке от тела), а не отрезками legTo/штреком по живым чанкам (neF-A0f22-2 03.10:
  // штрек вывел на крышу над залом в 18 бл., вниз «падение 13+», иссушитель — смерть на 5-й мин).
  const NR = require('./nether-route')
  if (sp && NR.enabled() && NR.gridOf(session) && !ctl.aborted) {
    const B = require('./blaze')
    const { potionOf } = require('./pvp')
    const frN = () => bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
    // Цель — клетка в 3 бл. НАД помостом (ноги на высоте спавнера +3) в 3 бл. от спавнера: иссушители помоста не
    // достают (рамка удара — только вширь), блейзы — в досягаемости меча (neF-B5f22/B6f22 03.10: на самом помосте два
    // иссушителя убивали за 16 с). План сам решит: мост сверху или столб с помоста.
    // Огнестойкость — на опасные шаги пути (открыто у края/лавы), бою у спавнера оставить 2 зелья (routeTo frKeep).
    const hole = process.env.ND_BLAZE_HOLE === '1' || process.env.ND_BLAZE_CAMP !== '1'
    // Зал открыт сверху (по сетке копии: над помостом на +3..+5 воздух) — сперва точка на +3 над помостом: иссушители на
    // помосте её не достают; оттуда луком всех видимых иссушителей/брутов, и только потом на помост (D2-32/B15o22/B11f22
    // 03.10, сид 6: спуск прямо на помост — 2–3 иссушителя, смерть за 2–7 с).
    const G0 = NR.gridOf(session)
    const NGm = require('./nether-grid')
    let air = 0; let tot = 0
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = 3; dy <= 5; dy++) { tot++; if (NGm.passable(G0.get(sp.x + dx, sp.y + dy, sp.z + dz))) air++ }
    const openAbove = air / tot > 0.8
    if (hole && openAbove && !ctl.aborted) {
      // ND_THRONE_HOT=1: открытое на уровне помоста (ноги от −2 до +2 к спавнеру, ±7 по горизонтали) — +12 за шаг: к точке
      // +3 — мостом сверху или штреком в толще, а не подъёмом с помоста (D6-26 03.10, сид 6: подъём у помоста — иссушитель, смерть).
      const hot = process.env.ND_THRONE_HOT === '1' ? [[sp.x - 7, sp.y - 2, sp.z - 7, sp.x + 7, sp.y + 2, sp.z + 7, 12]] : undefined
      const r0 = await NR.routeTo(session, ctl, { x: sp.x, y: sp.y + 3, z: sp.z, r: 3, dy: 0, solidFloor: true, frKeep: 3, frNear: { x: sp.x, y: sp.y, z: sp.z, r: 22 }, ironOk: true, hot, timeoutSeconds: Math.max(60, Math.round((deadline - gameClock.now()) / 1000) - 60) })
      log('к спавнеру: точка над помостом', { ok: r0.ok, why: r0.why, steps: r0.steps, s: r0.seconds })
      if (r0.ok) {
        const c0 = await NR.rangedClear(session, ctl, { ranged: 0 }, { radius: 14, maxMs: 45000, tower: false }).catch(e => e.message)
        log('к спавнеру: помост сверху луком', { done: c0 })
      }
    }
    const rr = await NR.routeTo(session, ctl, { x: sp.x, y: hole ? sp.y : sp.y + 3, z: sp.z, r: hole ? 2 : 3, dy: 0, solidFloor: true, frKeep: 3, frNear: { x: sp.x, y: sp.y, z: sp.z, r: 22 }, ironOk: true, timeoutSeconds: Math.max(60, Math.round((deadline - gameClock.now()) / 1000) - 30) })
    const seen = (() => { try { const b = bot.blockAt(sp); return !!b && bot.canSeeBlock(b) } catch { return false } })()
    log('к спавнеру по сетке', { ok: rr.ok, why: rr.why, steps: rr.steps, dug: rr.dug, placed: rr.placed, plans: rr.plans, s: rr.seconds, seen })
    // Дошёл до точки над помостом — «дошёл», даже если сам спавнер не виден (стоим на блоках над ним: B8f23 03.10).
    if (rr.ok) return { found: true, reached: true, spawner: xyz(sp), dist: Math.round(bot.entity.position.distanceTo(sp.offset(0.5, 0.5, 0.5))), legs, seen, route: { steps: rr.steps, s: rr.seconds } }
  }
  // Спавнера не знаем, а крепость в памяти — к ней отрезками legTo (ноги под
  // охраной боя, штрек по незераку на 64+, если ногами не пройти), после
  // каждого — искать спавнер. goto «по прямой» отрезками в 64 от портала
  // кончился огнём и лавой на y=41-58 (2026-09-27, 08:49).
  const fort = placeOf(session, PLACE)
  const spawnerNear = () => {
    const me = bot.entity.position
    const got = bot.findBlocks({ matching: id, maxDistance: 160, count: 6 }).filter(p => p.y >= 40)
    got.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    return got[0] || null
  }
  for (let i = 0; !sp && fort && worlds.worldOfRecord(fort) === 'the_nether' && i < 40 && !ctl.aborted && gameClock.now() < deadline; i++) {
    const me = bot.entity.position
    const flat = Math.hypot(fort.x - me.x, fort.z - me.z)
    if (flat <= 24) break
    const k = Math.min(1, 24 / flat)
    const w = await legTo(session, ctl, Math.round(me.x + (fort.x - me.x) * k), Math.round(me.z + (fort.z - me.z) * k), deadline)
    legs.push({ ok: !!w.ok, at: xyz(bot.entity.position), error: w.ok ? undefined : w.error })
    if (w.fought && (bot.health ?? 0) < 10) return { found: false, reached: false, stopped: `бой по дороге к крепости, хп ${Math.round(bot.health ?? 0)}`, legs }
    sp = spawnerNear()
  }
  if (!sp) sp = spawnerNear()
  if (!sp) return { found: false, stopped: fort ? 'у крепости спавнера в прогруженных чанках не видно' : 'крепости в памяти нет — сперва найти (fortress без mode)', legs }
  rememberSpawner(session, { x: sp.x, y: sp.y, z: sp.z })
  // «Дошёл» — на уровне спавнера (±2) и в 6 блоках по горизонтали: блейзы
  // спавнятся в коробке 9×3×9 вокруг него, и из-под пола (8 блоков, но на 7
  // ниже — 2026-09-27, 10:32) их не видно и не достать: 400 с, ноль убитых.
  // И не под ним: из-под спавнера (над головой — он сам) коробка лаборатории
  // не закрылась, и блейз убил тело (2026-09-27, 10:42). Стоять на полу его
  // зала: ноги на уровне спавнера или на блок ниже, в 2..6 блоках сбоку.
  const atLevel = () => {
    const p = bot.entity.position
    const h = Math.hypot(p.x - sp.x - 0.5, p.z - sp.z - 0.5)
    // 02.10 (слот 21, новый мир): штрек поднял тело на уровень зала в 7 блоках от спавнера, а «дошёл» требовал ≤ 6 —
    // вызов кончился «не на его уровне». Точку боя у спавнера blaze.choosePost и так ищет в 1.4..9 бл. и ±2 по высоте.
    const dy = Math.floor(p.y) - sp.y
    // Вплотную сбоку (по диагонали, 1.4 бл.) — тоже «дошёл»: neF-e2e-3 02.10 тело у 93,70,23 при спавнере 92,70,24 —
    // 12 шагов «ok» на месте и «не на его уровне» раз в 4 с. Под/над спавнером не бывает: |dy| ≤ 2 и h ≥ 1.2.
    return dy >= -2 && dy <= 2 && h >= 1.2 && h <= 9
  }
  // Клетка пола зала: ноги в воздухе, голова в воздухе, под ногами твёрдое,
  // в 3..5 блоках от спавнера на его уровне (или на блок ниже).
  const floorCells = () => {
    const out = []
    for (let dx = -5; dx <= 5; dx++) {
      for (let dz = -5; dz <= 5; dz++) {
        const h = Math.hypot(dx, dz)
        // Помост MonsterThrone — 5×5 вокруг спавнера: дальше 2.8 по нему не встать (слот 22 02.10, срез мира).
        if (h < 1.9 || h > 5) continue
        // Пол зала MonsterThrone — на 2 ниже спавнера (он на помосте): ноги на sp.y−2 тоже.
        for (const dy of [0, -1, -2]) {
          const c = sp.offset(dx, dy, dz)
          const a0 = bot.blockAt(c)
          const b0 = bot.blockAt(c.offset(0, 1, 0))
          const u0 = bot.blockAt(c.offset(0, -1, 0))
          if (a0 && b0 && u0 && a0.boundingBox === 'empty' && b0.boundingBox === 'empty' && u0.boundingBox === 'block' && !/lava|fire/.test(a0.name + u0.name)) out.push(c)
        }
      }
    }
    const me = bot.entity.position
    return out.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  }
  // Пол зала виден, но снизу к нему пути нет: 2026-09-29 14:11–14:16 бот в
  // коридоре на 18 ниже спавнера 300 с звал pathfinder к полу зала (по 40 с) и
  // не сдвинулся. После первого такого провала — столбом вверх, как без пола.
  let floorFails = 0
  const badFloor = new Set()
  let tunnelTries = 0
  let digDowns = 0
  let towerFails = 0
  let viewTries = 0
  let breachTries = 0
  const seesSp = () => { try { const b = bot.blockAt(sp); return !!b && bot.canSeeBlock(b) } catch { return false } }
  let walkFr = false
  let walkDrinks = 0
  let nearDrinks = 0
  let frWalkFails = 0
  const frCount = () => { const { potionOf } = require('./pvp'); return bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0) }
  // Бюджет зелий: бою у спавнера — 2 (≈ 6 мин), подходу к крепости — 1, ногам — только сверх этого (≥ 4).
  const frWalk = () => frWalkFails < 4 && (require('./blaze').hasEffect(bot, 'fire_resistance') || (walkDrinks < 2 && frCount() >= 4))
  // Спавнер из памяти далеко (карта копии мира: neF-map21-1 02.10 — 589 бл.): 12 отрезков по 24 бл. кончались на
  // 404 бл. «не на его уровне». Отрезков — сколько нужно на расстояние, плюс 12 на сам зал.
  const legsMax = 12 + Math.ceil(Math.hypot(sp.x - bot.entity.position.x, sp.z - bot.entity.position.z) / 24)
  for (let i = 0; i < legsMax && !ctl.aborted && gameClock.now() < deadline; i++) {
    const me = bot.entity.position
    const d = me.distanceTo(sp.offset(0.5, 0.5, 0.5))
    // Штреком дошли «на уровень», но тело в толще у зала, спавнер не виден (neF-Sb23-1 02.10: 6 бл. от спавнера в своём
    // штреке, 6 блейзов в 7–15 бл. — vis 0, 4 мин «ифриты за стеной», 0 стержней). В tunnel-режиме «дошёл» — когда
    // спавнер виден; иначе к полу зала (pathfinder с копкой, ветка floorCells ниже), до 3 раз.
    // Спавнер рядом (≤ 9 бл.), на уровне, но не виден — ход сквозь стену зала к помосту (до 2 раз), а не «дошёл» за стеной.
    if (atLevel() && !seesSp() && breachTries < 2 && process.env.ND_SPAWNER_BREACH === '1') {
      breachTries++
      const br = await breachToSpawner(session, ctl, sp, Math.min(deadline, gameClock.now() + 60000))
      if (br.ok) return { found: true, reached: true, spawner: xyz(sp), dist: Math.round(bot.entity.position.distanceTo(sp.offset(0.5, 0.5, 0.5))), legs, seen: true, breach: br }
    }
    if (atLevel() && (!tunnel || seesSp() || viewTries >= 3)) return { found: true, reached: true, spawner: xyz(sp), dist: Math.round(d), legs, seen: seesSp() }
    if (atLevel()) { viewTries++; console.log('[fortress] у спавнера, но не вижу его — к полу зала', JSON.stringify({ viewTries, at: xyz(bot.entity.position.floored()) })) }
    const flat = Math.hypot(sp.x - me.x, sp.z - me.z)
    // Иссушитель рядом и видит нас — бой мечом под щитом, пока хп высокое, а не ждать аварийного отхода: «сперва
    // отрываюсь» в коридоре крепости при иссушителе в 0.3 бл. кончался смертью (neF-F22-2 02.10, neF-Sb26-1).
    if (tunnel && (bot.health ?? 20) >= 12) {
      const { raySees, eyePos } = require('./perception')
      const ws: any = (Object.values(bot.entities || {}) as any[]).filter((e : any) => e && e.name === 'wither_skeleton' && e.position && e.isValid !== false &&
        e.position.distanceTo(bot.entity.position) < 8 && raySees(bot, eyePos(bot), e.position.offset(0, 1.6, 0)))
        .sort((a: any, b: any) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (ws) {
        const r = await require('./combat').fight(session, ctl, { target: '#' + ws.id, timeoutSeconds: 25, retreatAtHealth: 7, shield: 'always', clearArea: 0 }).catch(e => ({ error: e.message }))
        console.log('[fortress] иссушитель рядом — бой', JSON.stringify({ killed: !!(r && (r.killed || (r.kills && r.kills.length))), hp: Math.round(bot.health ?? 0), error: r && r.error }))
        continue
      }
    }
    // У крепости (≤ 64 бл.) — под огнестойкостью: мосты над лавовым морем, блейзы и бой с откидыванием (neF-S26-1 02.10:
    // бой с блейзом на мосту y 74, тело слетело к лаве на y 24 после конца зелья — «tried to swim in lava»).
    if (tunnel && flat <= 64 && nearDrinks < 2 && frCount() >= 3 && !require('./blaze').hasEffect(bot, 'fire_resistance')) {
      nearDrinks++
      const d0 = await require('./blaze').drinkFireResistance(bot).catch(e => e.message)
      console.log('[fortress] у крепости: огнестойкость', JSON.stringify({ d: d0, left: frCount(), flat: Math.round(flat) }))
    }
    let w
    if (Math.floor(me.y) > sp.y + 2 && flat <= 10 && digDowns < 3) {
      // Над залом (штрек/ноги вывели на крышу крепости) — к колонне в 2.5..5 бл. от спавнера на своей высоте, оттуда
      // копкой вниз сквозь крышу в зал (digDownTo: не над лавой, без лавы у шахты, падение ≤ 6).
      digDowns++
      const fy = Math.floor(me.y)
      let col = null
      for (let r = 3; r <= 5 && !col; r++) {
        for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r - 1, r - 1], [1 - r, r - 1], [r - 1, 1 - r], [1 - r, 1 - r]]) {
          const c = new Vec3(sp.x + dx, fy, sp.z + dz)
          const a0 = bot.blockAt(c); const b0 = bot.blockAt(c.offset(0, 1, 0)); const u0 = bot.blockAt(c.offset(0, -1, 0))
          if (!(a0 && b0 && u0 && a0.boundingBox === 'empty' && b0.boundingBox === 'empty' && u0.boundingBox === 'block' && !/lava|fire/.test(a0.name + u0.name))) continue
          // Сколько падать в этой колонне: твёрдое под ногами копаем, потом воздух до пола; лава — не годится.
          let y = fy - 1; while (y > sp.y - 3) { const b = bot.blockAt(new Vec3(c.x, y, c.z)); if (!b || b.boundingBox === 'empty' || /lava/.test(b.name)) break; y-- }
          let air = 0; let lava = false; while (y > sp.y - 4) { const b = bot.blockAt(new Vec3(c.x, y, c.z)); if (!b) break; if (/lava/.test(b.name)) { lava = true; break } if (b.boundingBox !== 'empty') break; air++; y-- }
          if (lava) continue
          const cost = air * 4 + c.distanceTo(me)
          if (!col || cost < col.cost) col = Object.assign(c, { cost, air })
        }
      }
      if (col && col.distanceTo(me.floored()) > 0.5) {
        const { goals } = require('mineflayer-pathfinder')
        let t = null
        try { await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(col.x, col.y, col.z)), new Promise<any>((_r, rej) => { t = gameClock.setTimeout(() => rej(new Error('время')), 10000) })]) } catch { try { bot.pathfinder.setGoal(null) } catch {} } finally { if (t) gameClock.clearTimeout(t) }
      }
      const dh = Math.hypot(bot.entity.position.x - sp.x - 0.5, bot.entity.position.z - sp.z - 0.5)
      if (dh >= 1.6) {
        const dw = await digDownTo(session, ctl, sp, Math.min(deadline, gameClock.now() + 60000))
        console.log('[fortress] вниз к залу', JSON.stringify({ col: col ? xyz(col) : null, ...dw, at: xyz(bot.entity.position.floored()) }))
        w = { ok: dw.ok, error: dw.ok ? undefined : `вниз к залу: ${dw.why}` }
      } else w = { ok: false, error: 'над самым спавнером — колонны рядом нет' }
    } else if (flat <= 6 && Math.floor(me.y) < sp.y - 2 && towerFails < 3 && (!floorCells().length || floorFails >= 1)) {
      // Под спавнером — столбом вверх до его уровня (блок под себя; кирпич над
      // головой towerUp ломает). Прямо под ним столб упрётся в сам спавнер —
      // сперва на соседнюю клетку в 2 блоках (2026-09-27, 10:32: тело в
      // полости на 7 ниже, над ним три ряда кирпича и спавнер).
      if (Math.hypot(me.x - sp.x - 0.5, me.z - sp.z - 0.5) < 1.6) {
        const { goals } = require('mineflayer-pathfinder')
        const fy = Math.floor(me.y)
        for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
          const c = new Vec3(sp.x + dx, fy, sp.z + dz)
          const a0 = bot.blockAt(c)
          const b0 = bot.blockAt(c.offset(0, 1, 0))
          const u0 = bot.blockAt(c.offset(0, -1, 0))
          if (!a0 || !b0 || !u0 || a0.boundingBox !== 'empty' || b0.boundingBox !== 'empty' || u0.boundingBox !== 'block') continue
          let t = null
          try {
            await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(c.x, c.y, c.z)), new Promise<any>((_r, rej) => { t = gameClock.setTimeout(() => rej(new Error('время')), 8000) })])
          } catch { try { bot.pathfinder.setGoal(null) } catch {} } finally { if (t) gameClock.clearTimeout(t) }
          break
        }
      }
      // Столб по одному блоку; над головой твёрдое (пол зала над нами) — сломать его (видно прямо над головой), лава выше
      // — стоп. towerUp сам потолок не ломает («потолок nether_bricks»; neF-F22 02.10: 12 шагов подряд на месте в 9 бл.
      // под спавнером).
      const SL = require('./sealed')
      const need = Math.min(12, sp.y - Math.floor(bot.entity.position.y))
      let climbed = 0; let why = ''
      for (let s2 = 0; s2 < need && !ctl.aborted && gameClock.now() < deadline; s2++) {
        const f0 = bot.entity.position.floored()
        const h2 = f0.offset(0, 2, 0)
        const hb = bot.blockAt(h2)
        if (hb && hb.boundingBox === 'block') {
          const above = bot.blockAt(h2.offset(0, 1, 0))
          if (above && /lava/.test(above.name)) { why = 'над потолком лава'; break }
          if (sp.x === h2.x && sp.z === h2.z && sp.y === h2.y) { why = 'над головой спавнер'; break }
          const r = await SL.digCell(bot, h2)
          if (r !== 'ok' && r !== 'air') { why = `потолок ${hb.name}: ${r}`; break }
        }
        const up1 = await require('./build').towerUp(bot, ctl, 1, { sneak: true })
        if (!up1.ok) { why = up1.reason || 'столб не вырос'; break }
        climbed++
      }
      w = climbed > 0 ? { ok: true, climbed } : { ok: false, error: why || 'столб не вырос' }
      if (!w.ok) towerFails++
    } else if (flat > 24 && tunnel && frWalk()) {
      // Под огнестойкостью — ногами (legTo, ~2–3 бл/с): штрек по Аду ~0.2–1 бл/с (neF-R23-1 02.10: 170 бл. за 16 мин),
      // а лава под зельем не убивает. Зелье на ход — только пока на бой у спавнера остаётся ≥ 2.
      const B = require('./blaze')
      if (!B.hasEffect(bot, 'fire_resistance')) { walkDrinks++; const d = await B.drinkFireResistance(bot).catch(e => e.message); for (let q = 0; q < 40 && !B.hasEffect(bot, 'fire_resistance'); q++) await sleep(100); console.log('[fortress] ногами к спавнеру: огнестойкость', JSON.stringify({ d, left: frCount() })) }
      const k = 24 / flat
      w = await legTo(session, ctl, Math.round(me.x + (sp.x - me.x) * k), Math.round(me.z + (sp.z - me.z) * k), deadline)
      if (!w.ok) frWalkFails++
    } else if (flat > 24 && tunnel && tunnelTries < 2) {
      // Спавнер известен (карта копии мира) и далеко — закрытым штреком (tunnel.js) к точке в 4 бл. от него со своей
      // стороны, на его высоте: ноги legTo по Аду гибли в лаве и падали (neF-Pa24-1 02.10: «не на его уровне» в 238 бл.,
      // потом пешком — «tried to swim in lava»). Штрек не начался с открытого — закопаться (bastion.burrow) и снова.
      tunnelTries++
      const hx = me.x - sp.x - 0.5; const hz = me.z - sp.z - 0.5; const hd = Math.hypot(hx, hz) || 1
      const P = { x: Math.floor(sp.x + 0.5 + hx / hd * 4), y: sp.y, z: Math.floor(sp.z + 0.5 + hz / hd * 4) }
      const { tunnelTo } = require('./tunnel')
      // ironOk: к спавнеру идут после бастиона (порядок BASTION_FIRST) — железная кирка золоту больше не нужна; без неё
      // каменные кончались, и штрек копал рукой (neF-R23-1 02.10: «кирок нет — копаю чем есть», 0.2 бл/с).
      const tOpts = () => ({ radius: 6, band: Math.max(40, Math.min(100, sp.y)), ironOk: true, deadline: Math.min(deadline - 20000, gameClock.now() + 90000 + flat * 2500), log: (wh, d) => console.log('[fortress] ' + wh, JSON.stringify(d)) })
      let tr = await tunnelTo(session, ctl, P, tOpts())
      if (!tr.ok && !tr.segs && !tr.dug && !ctl.aborted) {
        const bw = await require('./bastion').burrow(session, ctl, {}, 'штрек к спавнеру не начался')
        if (bw.ok) tr = await tunnelTo(session, ctl, P, tOpts())
      }
      delete tr.own
      console.log('[fortress] штрек к спавнеру', JSON.stringify({ ok: tr.ok, why: tr.why, segs: tr.segs, dug: tr.dug, breach: tr.breach, at: tr.at, to: P }))
      w = { ok: tr.ok, error: tr.ok ? undefined : `штрек: ${tr.why}` }
    } else if (flat > 24 && tunnel && !require('./blaze').hasEffect(bot, 'fire_resistance') && frCount() === 0) {
      // Штрек не довёл, а огнестойкости нет — ногами по Аду не идти (neF-Sc26-1 02.10: без зелья к спавнеру в 230 бл. по
      // уровню лавового моря — гаст, «tried to swim in lava»). Этап кончится неудачей, а не смертью.
      return { found: true, reached: false, spawner: xyz(sp), legs, stopped: `штрек к спавнеру не довёл, огнестойкости нет — ногами по Аду не иду (${Math.round(flat)} бл.)` }
    } else if (flat > 24) {
      // Ногами по Аду к дальнему спавнеру — под огнестойкостью, если зелий хватает и на бой (≥ 3): лава на пути ногами
      // — главная смерть перехода (neF-Pa24-1 02.10: «tried to swim in lava»). Шар блейза под ней тоже не жжёт.
      if (tunnel && !walkFr) {
        walkFr = true
        const B = require('./blaze')
        const { potionOf } = require('./pvp')
        const frN = bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
        if (frN >= 3 && !B.hasEffect(bot, 'fire_resistance')) { const d = await B.drinkFireResistance(bot).catch(e => e.message); console.log('[fortress] ногами к спавнеру: огнестойкость', JSON.stringify({ d, left: frN - 1 })) }
      }
      // Отрезок в 24 блока к спавнеру (ноги, штрек — legTo).
      const k = 24 / flat
      w = await legTo(session, ctl, Math.round(me.x + (sp.x - me.x) * k), Math.round(me.z + (sp.z - me.z) * k), deadline)
    } else {
      // Пол зала, к которому pathfinder уже не нашёл пути, второй раз не берём: 02.10 (слот 21, новый мир) тело в 20
      // блоках под залом звало pathfinder к той же клетке 12 раз за 4 с («No path»), вызов и этап — пусто, пауза 5 мин.
      const cells = floorCells().filter(c => !badFloor.has(`${c.x},${c.y},${c.z}`))
      if (cells.length && floorFails < 2) {
        const c = cells[0]
        const { goals } = require('mineflayer-pathfinder')
        let t = null
        try {
          await Promise.race([bot.pathfinder.goto(new goals.GoalBlock(c.x, c.y, c.z)), new Promise<any>((_r, rej) => { t = gameClock.setTimeout(() => rej(new Error('время')), 40000) })])
          // goto «дошёл», а тело на месте (neF-map21-1 02.10: 4 шага «ok» у 554,27,105 при поле зала на y 67–69) — провал.
          const f = bot.entity.position
          if (Math.hypot(f.x - c.x - 0.5, f.z - c.z - 0.5) > 1.6 || Math.abs(Math.floor(f.y) - c.y) > 1) throw new Error(`goto кончился в ${Math.round(f.x)},${Math.floor(f.y)},${Math.round(f.z)}`)
          w = { ok: true }
        } catch (e) { try { bot.pathfinder.setGoal(null) } catch {} floorFails++; badFloor.add(`${c.x},${c.y},${c.z}`); w = { ok: false, error: `к полу зала ${c.x},${c.y},${c.z}: ${e.message}` } } finally { if (t) gameClock.clearTimeout(t) }
      } else {
        // Ногами к полу не выйти — подъём ступеньками штрека (climbTo → nether.bore) не к самому спавнеру (штрек
        // встал бы вплотную к нему, а «дошёл» — это 2..6 сбоку), а к точке в 3.5 блока от него со своей стороны.
        const hx = me.x - sp.x - 0.5; const hz = me.z - sp.z - 0.5; const hd = Math.hypot(hx, hz) || 1
        const P = { x: Math.floor(sp.x + 0.5 + hx / hd * 3.5), y: sp.y - 1, z: Math.floor(sp.z + 0.5 + hz / hd * 3.5) }
        w = await climbTo(session, ctl, P, deadline)
      }
    }
    legs.push({ ok: !!w.ok, at: xyz(bot.entity.position), error: w.ok ? undefined : w.error })
    console.log('[fortress] к спавнеру', JSON.stringify({ i, floorFails, aborted: ctl.aborted, left: Math.round((deadline - gameClock.now()) / 1000), at: xyz(bot.entity.position), sp: xyz(sp), ok: !!w.ok, error: w.ok ? undefined : String(w.error || '').slice(0, 120) }))
    if (w.fought && (bot.health ?? 0) < 10) return { found: true, reached: false, spawner: xyz(sp), stopped: `бой по дороге, хп ${Math.round(bot.health ?? 0)}`, legs }
  }
  const d = bot.entity.position.distanceTo(sp.offset(0.5, 0.5, 0.5))
  const lvl = atLevel()
  return { found: true, reached: lvl, spawner: xyz(sp), dist: Math.round(d), legs, stopped: lvl ? undefined : `до спавнера ${Math.round(d)} блоков, по высоте ${Math.floor(bot.entity.position.y) - sp.y} — не на его уровне` }
}

module.exports = { scout, look, tour, toSpawner, placeOf, FORTRESS_BLOCKS, BASTION_BLOCKS, PLACE, SPAWNER_PLACE, BASTION_PLACE }
