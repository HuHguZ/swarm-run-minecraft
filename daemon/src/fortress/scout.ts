'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz } from '../movement'
import * as worlds from '../worlds'
import {
  PLACE, SPAWNER_PLACE, BASTION_PLACE, DIRS, log, clamp, look, remember, BASTION_KEYS_ALL, bastionSpentNear,
  rememberBastion, rememberSpawner, highLook, placeOf
} from './look'
import { walkLine, sweep } from './sweep'
import { continueFortress, tour } from './tour'
import { toSpawner } from './spawner'

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
  // Обход по открытому Аду — под гастами: отбивать их шары (ne-guard.swatInstall) и здесь, а не только в bastion/blaze/ходе по сетке.
  try { (require('../ne-guard') as typeof import('../ne-guard')).swatInstall(bot) } catch {}
  // Обход разведки — со строгим обходом лавы (session.lavaStepCost: шаг над обрывом к лаве в 14 бл. — 1000, у лавы — 200), как
  // подход бастиона: на краю над лавовым морем шар гаста сбрасывал тело в лаву (ne-a, ne-c, b1-5-2, b4g-6-2 14.10: падение с y 70–83).
  const strict0 = bot._ndLavaStrict
  bot._ndLavaStrict = process.env.ND_SCOUT_LAVA_STRICT !== '0'
  // Базальтовые дельты — и для крепости: тонкие колонны над лавой, падение в 26 бл. (b14-6-3 14.10: поиск крепости по базальту, y 56 → лава).
  const deltas0 = bot._ndAvoidDeltas
  bot._ndAvoidDeltas = true
  try {
    return await scoutBody(session, ctl, p)
  } finally {
    bot._ndNetherFloor = 0
    bot._ndLavaStrict = strict0
    bot._ndAvoidDeltas = deltas0
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
  if (p.mode === 'spawner') return toSpawner(session, ctl, { deadline, tunnel: p.tunnel === true || process.env.ND_SPAWNER_TUNNEL === '1', breach: p.breach === true })
  if (p.mode === 'advance' && process.env.ND_FORTRESS_FRONTIER === '0') return { advanced: false, frontierTried: 0, disabled: true }
  if (p.mode === 'advance' && here === 'the_nether') {
    return tour(session, ctl, { deadline, hops: 14, pie: true, advance: true })
  }
  if (p.mode === 'continue' && here === 'the_nether') return continueFortress(session, ctl, { ...p, deadline })
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
  // Бастион — с вышки и кольцами вокруг портала по умолчанию (ND_BASTION_HIGH=0 — прежний обход полос региона): полосы региона
  // уводили от бастиона в 51 бл. на север и за 430 бл. (b1-5-1, b0-5-2 14.10), а бастионы пула — в 70–144 бл. от входа.
  if (p.mode === 'bastion') {
    const highB = p.high ?? (high || process.env.ND_BASTION_HIGH !== '0')
    return bastionSearch(session, ctl, { deadline, radius: highB ? clamp(p.radius ?? 128, 16, 128) : radius, t0, high: highB })
  }
  const start = bot.entity.position.floored()
  const views = []
  let bastion = null
  const glance = async () => {
    const v: any = look(bot, mcData, { radius })
    views.push({ at: xyz(bot.entity.position), seen: v.seen, rayChecked: v.rayChecked })
    console.log('[fortress] взгляд', JSON.stringify({ gameMs: gameClock.now(), at: xyz(bot.entity.position), seen: v.seen, spawners: (v.spawners || []).length, candidates: v.candidates, rayChecked: v.rayChecked }))
    for (const sp of v.spawners || []) rememberSpawner(session, sp)
    if (v.bastion) { bastion = v.bastion; await rememberBastion(session, v.bastion, ctl) }
    return v
  }

  let v: any = await glance()
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
  const glance = async () => {
    const v: any = look(bot, mcData, { radius })
    looks++
    // Кирпич выработанного бастиона — не находка.
    if (v.bastion && bastionSpentNear(session, v.bastion.nearest)) v.bastion = null
    console.log('[fortress] бастион: взгляд', JSON.stringify({ at: xyz(bot.entity.position), bastion: v.bastion ? v.bastion.seen : 0, bricks: v.seen }))
    for (const sp of v.spawners || []) rememberSpawner(session, sp)
    if (v.bastion) { bastion = v.bastion; await rememberBastion(session, v.bastion, ctl) }
    if (v.seen && !placeOf(session, PLACE)) remember(session, v.nearest, `крепость Ада: кирпич виден на ${v.nearest.x},${v.nearest.y},${v.nearest.z} (${v.dist} бл.), попутно с поиском бастиона`)
    return v
  }
  let v: any = await glance()
  const legs = []
  let stopped = null
  let search = null
  if (!v.bastion && high) { const h = await highLook(session, ctl, glance); log('бастион: взгляд с вышки', { ...h, v: undefined }); if (h.v) v = h.v }
  if (!v.bastion) {
    // Кольца 56 и 112 бл. вокруг портала (а не 128/256 крепости): бастионы пула good-v2 — в 70–144 бл. от входа (квартили 93/116/136),
    // с точки кольца вышка видит на 128.
    const r = await sweep(session, ctl, { deadline, glance, legs, v, want: 'bastion', high, rings: [56, 112] })
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

export { scout }
