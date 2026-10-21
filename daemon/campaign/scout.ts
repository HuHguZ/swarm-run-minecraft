'use strict'
// Разведка поверху: лава днём и с высоты, лава у руин, лут построек, своя шахта, литьё у природной лавы.
import { OW_HEAR, BEDS_END } from './flags'
import { call } from './rpc'
import { strategyInterrupted, state, sit, died, known, stairEntrance, skyLavaSeen, naturalTried, skyLookAt,
  lavaSourceKnown, surfaceShaft, setLavaSourceKnown, setNaturalTried, setSkyLavaSeen, setSkyLookAt, setSurfaceShaft } from './state'
import { log } from './log'
import { have, y, dim, COBBLE, foodUnits, PICK_IRON, goldOn, shieldOn, lighter } from './queries'
import { sense, refresh, readMemory, lavaBad } from './observe'
import { lavaApproachSeconds } from './stages/table'
import { act } from './act'
import { goToward } from './travel'
import { leaveWater } from './danger'
import { craft, spares } from './kit'
import { graphFact, intelligence } from './strategy-bridge'
import * as gameClock from '../src/game-clock'
const NATURAL = process.env.ND_PORTAL_NATURAL === '1'
function dayLavaActive () {
  return process.env.ND_OW_DAY_LAVA !== '0' && !died && dim() === 'overworld' && !sit.night && !!state.pos &&
    !known.portal && !known.lava && have('water_bucket') > 0 && !!lighter()
}

function dayLavaQuotes (view: any) {
  const { pos, terrain } = view
  const jobs = [], dirs = [['east', 1, 0], ['south', 0, 1], ['west', -1, 0], ['north', 0, -1],
    ['southeast', 1, 1], ['southwest', -1, 1], ['northwest', -1, -1], ['northeast', 1, -1]]
  const route = to => Math.hypot(to.x - pos.x, to.z - pos.z) / 4.317 + Math.abs((to.y ?? pos.y) - pos.y) * 2
  const levelSeconds = n => 3 * n + Math.SQRT2 / 4.317
  // ND_OW_LAVA_SHAFT=1: вниз за лавой — колодцем (блок на уровень и падение, ~1.2 с), а не лестницей по 8 (3 блока на уровень): у −9170
  // лавы под небом у спавна нет, а у бедрока (y −56…−64) в R48 — ~970 клеток лавы (оракул 21.10); лестницей это ~560 с, «фронтир» дешевле
  // и уводил по поверхности на 13 мин впустую (owG1-06).
  const shaftLevel = n => n + 0.6
  const down = y => process.env.ND_OW_LAVA_SHAFT === '1'
    ? Math.max(0, y) * shaftLevel(terrain.stoneSeconds) + Math.max(0, Math.min(y, 0) + 54) * shaftLevel(terrain.deepslateSeconds) + view.searchSeconds
    : Math.max(0, y) * levelSeconds(terrain.stoneSeconds) + Math.max(0, Math.min(y, 0) + 54) * levelSeconds(terrain.deepslateSeconds) + view.searchSeconds
  const add = (id, kind, seconds, mine, extra: any = {}) => {
    const hazard = mine ? view.mineHazard : view.scoutHazard
    jobs.push({ id, kind, seconds, price: seconds - Math.expm1(-hazard * seconds) * view.deathSeconds, ...extra })
  }
  const overlap = (r, R, d) => {
    if (d >= r + R) return 0
    if (d <= Math.abs(r - R)) return Math.PI * Math.min(r, R) ** 2
    const a = Math.acos(Math.max(-1, Math.min(1, (d * d + r * r - R * R) / (2 * d * r))))
    const b = Math.acos(Math.max(-1, Math.min(1, (d * d + R * R - r * r) / (2 * d * R))))
    return r * r * a + R * R * b - Math.sqrt((-d + r + R) * (d + r - R) * (d - r + R) * (d + r + R)) / 2
  }
  // shortcut: lake attempts and the largest overlap give an optimistic ETA; calibrate visibility/union after paired scenes.
  const chance = (to, radius) => {
    const area = Math.PI * radius * radius
    const old = Math.max(0, ...view.views.map(v => overlap(radius, v.radius,
      Math.hypot(to.x - v.pos.x, to.z - v.pos.z))))
    return -Math.expm1(-Math.max(0, area - old) / 256 / 200)
  }
  const horizon = Math.max(1, Math.min(128, terrain.horizon))
  for (const p of terrain.points) {
    if (p.at.y < pos.y - 3) add(`cave:${JSON.stringify(p.at)}`, 'cave', route(p.at) + down(p.at.y), true, { to: p.at })
    else if (view.surface && p.at.y > pos.y + 3) {
      // Clearing the actually observed occluders can reveal the full skyline; this is a value estimate, not a hidden-height scan.
      const radius = p.at.y + 1.62 > terrain.occluderTop ? 128 : horizon
      add(`view:${JSON.stringify(p.at)}`, 'view', (route(p.at) + 1) / chance(p.at, radius), false, { to: p.at })
    }
  }
  for (const r of view.ruins) add(`ruin:${JSON.stringify(r.at)}`, 'ruin', (route(r.at) + 1) / 0.715, false, { to: r.at })
  const h = view.heard
  if (h) add(`sound:${h.dir}:${!!h.above}:${!!h.below}`, 'sound', Math.min(8, h.dist) * levelSeconds(terrain.stoneSeconds), true,
    { direction: h.dir, depth: Math.max(1, Math.min(8, h.dist)), above: !!h.above, below: !!h.below })
  for (const [direction, dx, dz] of dirs) {
    const norm = Math.hypot(+dx, +dz), to = { x: pos.x + +dx * 64 / norm, z: pos.z + +dz * 64 / norm }
    const exit = view.surface ? 0 : Math.max(0, view.exitY - pos.y) * levelSeconds(terrain.stoneSeconds)
    add(`frontier:${direction}`, 'frontier', exit + (64 / 4.317 + 1) / chance(to, horizon), false, { to, direction })
  }
  for (const direction of ['north', 'east', 'south', 'west']) {
    if (pos.y > -54) add(`down:${direction}`, 'down', down(pos.y), true, { direction, depth: Math.min(process.env.ND_OW_LAVA_SHAFT === '1' ? 64 : 8, Math.ceil(pos.y + 54)) })
    else add(`drift:${direction}`, 'drift', view.searchSeconds, true, { direction })
  }
  return jobs.filter(j => Number.isFinite(j.price)).sort((a, b) => a.price - b.price)
}

const dayLavaViews = []
const dayLavaFailures = new Set()
async function dayLavaStep () {
  if (!dayLavaActive()) return false
  await sense()
  if (!dayLavaActive() || strategyInterrupted) return false
  await readMemory()
  if (known.lava || known.portal) return false
  const scan = await act('portal_natural', { mode: 'survey', radius: 128, need: 1, terrain: true })
  if (died || strategyInterrupted || scan.status === 'interrupted') return true
  const site = [scan.detail?.best, ...(scan.detail?.sites || []), ...(scan.detail?.terrain?.sources || [])].find(s => s?.at && !lavaBad(s.at))
  if (site) {
    known.lava = { ...site.at }; setLavaSourceKnown(true)
    const at = `${site.at.x},${site.at.y},${site.at.z}`
    log(`день: вижу источник лавы ${at} — к литью`)
    try { await call('remember', { kind: 'лава', text: `лава на ${at}`, place: 'лава' }) } catch {}
    return true
  }
  const terrain = scan.detail?.terrain
  if (!terrain) return false
  const eye = { ...state.pos }
  if (!dayLavaViews.some(v => v.signature === terrain.signature && Math.hypot(v.pos.x - eye.x, v.pos.y - eye.y, v.pos.z - eye.z) < 1)) {
    dayLavaViews.push({ pos: eye, radius: Math.max(1, terrain.horizon), signature: terrain.signature })
  }
  let heard = null
  if (OW_HEAR) {
    const h = await act('portal', { mode: 'cast', listen: 16, timeoutSeconds: 30 })
    if (died || strategyInterrupted || h.status === 'interrupted') return true
    heard = h.detail?.heard?.[0] || null
  }
  const structures = await act('structure', { mode: 'list' })
  if (died || strategyInterrupted || structures.status === 'interrupted') return true
  const s = await intelligence.environment.observe()
  const scout = intelligence.registry.get('ScoutLava'), mine = intelligence.registry.get('MineIron')
  const hazard = model => -Math.log1p(-Math.min(0.99, Math.max(0, model.estimateRisk(s)))) / Math.max(1, model.estimateCost(s) / 20)
  const jobs = dayLavaQuotes({ pos: { ...state.pos }, surface: !!sit.surface,
    exitY: stairEntrance?.y ?? surfaceShaft?.top ?? Math.max(63, ...dayLavaViews.map(v => v.pos.y)), terrain, heard,
    ruins: [...(structures.detail?.known || []).filter(r => r.kind === 'ruined_portal' && r.at), ...(scan.detail?.ruins || [])], views: dayLavaViews,
    searchSeconds: Math.max(1, scout.estimateCost(s) / 20), scoutHazard: hazard(scout), mineHazard: hazard(mine),
    deathSeconds: (Number(process.env.ND_DEATH_COST_MIN) || 60) * 60 })
  const cause = () => JSON.stringify([['x', 'y', 'z'].map(k => Math.floor(state.pos[k])), terrain.signature, terrain.tools, heard])
  const key = cause(), job = jobs.find(j => !dayLavaFailures.has(`${j.id}:${key}`))
  if (!job) { log('день: причины отказов поиска лавы не изменились — нужен другой ход планировщика'); return true }
  log(`день: поиск лавы ${job.id}, цена ≈ ${Math.round(job.price)} с; альтернативы ${jobs.slice(0, 4).map(j => `${j.kind}:${Math.round(j.price)}`).join(', ')}`)
  const before = { ...state.pos }
  let r
  if (job.kind === 'down' || job.kind === 'sound' && job.below) {
    await spares(3 * job.depth)
    if (died || strategyInterrupted) return true
    await sense()
    if (!dayLavaActive() || strategyInterrupted || Math.hypot(state.pos.x - before.x, state.pos.y - before.y, state.pos.z - before.z) >= 0.5) return true
    r = process.env.ND_OW_LAVA_SHAFT === '1' && job.kind === 'down'
      ? await act('tunnel', { direction: 'down', length: job.depth, timeoutSeconds: 240 })
      : await act('dig_down', { mode: 'stairs', depth: job.depth, direction: job.direction, maxFallHp: 0, torchEvery: 0, timeoutSeconds: 90 })
    // Колодец встал (пещера, вода снизу) — осмотреться: лава в пещере видна сверху.
    if (process.env.ND_OW_LAVA_SHAFT === '1' && job.kind === 'down' && !died && !strategyInterrupted && r.status !== 'interrupted') await act('observe', { radius: 48 })
    // ND_OW_LAVA_DOWN_CONTINUE=1 (owC12-11): лестница была своя — тело сошло по ней, не вскрыв ни блока; новый спуск — от её низа,
    // иначе цикл «вниз по своей лестнице → пустой заход → наверх к новому обзору → снова вниз» шёл 19 игр. мин.
    for (let k = 0; k < 2 && process.env.ND_OW_LAVA_DOWN_CONTINUE === '1' && r.status === 'done' && !(r.detail?.dug > 0) && !r.detail?.stopped &&
      state.pos.y <= before.y - 4 && state.pos.y > -54 && !died && !strategyInterrupted; k++) {
      log(`день: поиск лавы — своя лестница до y ${Math.round(state.pos.y)}, продолжаю вниз отсюда`)
      r = await act('dig_down', { mode: 'stairs', depth: Math.min(8, Math.ceil(state.pos.y + 54)), direction: job.direction, maxFallHp: 0, torchEvery: 0, timeoutSeconds: 90 })
      if (died || strategyInterrupted || r.status === 'interrupted') return true
    }
  } else if (job.kind === 'drift' || job.kind === 'sound') {
    r = await act('tunnel', { direction: job.above ? 'up' : job.direction, length: job.depth || 8, torchEvery: 0, timeoutSeconds: 90 })
  } else {
    r = await act('goto', { ...job.to, range: job.kind === 'ruin' ? 8 : 2, surface: job.kind === 'frontier' || job.kind === 'view' ? 'strict' : false, timeoutSeconds: 60 })
  }
  if (died || strategyInterrupted || r.status === 'interrupted') return true
  const moved = Math.hypot(state.pos.x - before.x, state.pos.y - before.y, state.pos.z - before.z)
  if (moved < 0.5 && !(r.detail?.dug > 0) && !(r.detail?.walked > 0)) dayLavaFailures.add(`${job.id}:${key}`)
  if (job.kind === 'ruin' && moved >= 0.5) await lootSeenStructures(24)
  if (!died && !strategyInterrupted && moved >= 0.5) await act('observe', { radius: 32 })
  return true
}
let lavaStartTried = false
async function earlyLavaLookout () {
  if (process.env.ND_OW_LAVA_LOOK_EARLY !== '1' || lavaStartTried) return false
  lavaStartTried = true
  await sense()
  if (dim() !== 'overworld' || known.portal || lavaSourceKnown || !sit.surface || sit.night || sit.inWater ||
      died || strategyInterrupted || !state.pos || 55 * 20 / Math.max(1, state.health ?? 20) > 90) return true
  const base = { ...state.pos }
  // Без кирки годится земля: pickFiller выбирает имеющийся булыжник раньше неё.
  if (!have(/_pickaxe$/) && have(COBBLE)) return true
  // Ранняя вышка — из 10 блоков земли (owG1-02: при ND_OW_LAVA_TOWER=20 двадцати блоков земли в 8 бл. за 30 с не набралось — ранний
  // обзор пропущен, озеро 5730 в 45 бл. не увидено за весь прогон); выше — уже из булыжника (lavaLookout берёт сколько есть).
  const need = 10 - have(COBBLE) - have('dirt')
  if (need > 0) await act('mine', { block: 'dirt,grass_block', count: need, radius: 8, dry: true, timeoutSeconds: 20, minY: Math.floor(state.pos.y) - 1 })
  if (died || strategyInterrupted) return true
  await sense()
  if (!state.pos || have(COBBLE) + have('dirt') < 10) return true
  const moved = () => Math.hypot(state.pos.x - base.x, state.pos.y - base.y, state.pos.z - base.z)
  // Вышка — там, где стою после добычи (21.10 owB4-05: возврат на 0.5 бл. к исходной точке из своей ямки «не дошёл» — обзор пропущен);
  // возврат только если ушёл далеко от исходного вида (> 8 бл.).
  if (moved() > 8) await act('goto', { ...base, range: 2, surface: 'strict', timeoutSeconds: 15 })
  if (died || strategyInterrupted) return true
  await sense()
  if (!state.pos || moved() > 10 || !sit.surface || sit.inWater) return true
  log('ранний обзор лавы: свои 10 блоков, вышка у стартового обзора; бюджеты добыча/возврат/подъём/спуск 20/15/25/30 с')
  await lavaLookout()
  return true
}
let surveyDone = false
const lavaLookoutCells = new Set()
async function lavaLookout (force = false) {
  await sense()
  if (dim() !== 'overworld' || known.portal || (lavaSourceKnown && !force) || !sit.surface || sit.inWater || died || !state.pos ||
      (!have(/_pickaxe$/) && !((process.env.ND_OW_LAVA_LOOK === '1' || process.env.ND_OW_LAVA_LOOK_EARLY === '1') && !have(COBBLE) && have('dirt') >= 10)) ||
      have(COBBLE) + have('dirt') < 10) return
  // Existing command budgets: 25 s up + 30 s down versus a 90 s surface search; wounds raise the tower's price.
  if (55 * 20 / Math.max(1, state.health ?? 20) > 90) return
  const key = [state.pos.x, state.pos.y, state.pos.z].map(Math.floor).join(':')
  if (lavaLookoutCells.has(key)) return
  lavaLookoutCells.add(key)
  const y0 = y()
  // Шахта вверх/вниз не ставит факелы (mining/drift.ts); preflight не должен требовать их для вышки.
  const light = process.env.ND_OW_LAVA_LOOK === '1' || process.env.ND_OW_LAVA_LOOK_EARLY === '1' ? { torchEvery: 0 } : {}
  try {
    // ND_OW_LAVA_TOWER=<бл.> (по умолч. 10): в лесу озеро на холме за кронами с 10 не видно (owE1-01: озеро −2642 в 30 бл. на 6 выше,
    // «лавы под небом не видно» трижды за прогон).
    const tower = Math.max(4, Math.min(32, Number(process.env.ND_OW_LAVA_TOWER) || 10, have(COBBLE) + have('dirt')))
    await act('tunnel', { direction: 'up', length: tower, timeoutSeconds: Math.round(tower * 2.5), ...light })
    if (y() - y0 >= 4 && !died) await skyLavaLook()
  } finally {
    const climbed = Math.round(y() - y0)
    if (climbed > 0 && !died && !strategyInterrupted) await act('tunnel', { direction: 'down', length: climbed, timeoutSeconds: 30, ...light })
  }
}
async function skyLavaLook () {
  if (dim() !== 'overworld' || known.portal || process.env.ND_SKY_LAVA === '0') return null
  await sense()
  if (!sit.surface || !state.pos) return null
  // Тот же вид с того же места второй раз ничего не даст.
  if (skyLookAt && Math.hypot(skyLookAt.x - state.pos.x, skyLookAt.z - state.pos.z) < 24 && Math.abs(skyLookAt.y - state.pos.y) < 4) return null
  setSkyLookAt({ x: state.pos.x, y: state.pos.y, z: state.pos.z })
  const sv = await act('portal_natural', { mode: 'survey', radius: 128 })
  const best = sv.detail && [sv.detail.best, ...(sv.detail.sites || [])].find(site => site && site.usable !== false && site.at && !lavaBad(site.at))
  if (!best || !best.at || !state.pos) { log('обзор вдаль: лавы под небом в 128 бл. не видно'); return null }
  // ND_OW_SKY_LAVA_FIRST=1: увиденное озеро под небом держится отдельно (skyLavaSeen) — пещерная лава штреков перезаписывает known.lava.
  if (process.env.ND_OW_SKY_LAVA_FIRST === '1' && /surface|rp/.test(best.kind || '') && !lavaBad(best.at) &&
      (!skyLavaSeen || skyLavaSeen.hint || Math.hypot(best.at.x - state.pos.x, best.at.z - state.pos.z) < Math.hypot(skyLavaSeen.x - state.pos.x, skyLavaSeen.z - state.pos.z))) {
    setSkyLavaSeen({ ...best.at, kind: best.kind, open: best.open })
  }
  const far = q => Math.hypot(q.x - state.pos.x, q.z - state.pos.z)
  if (!known.lava || (process.env.ND_OW_KIT_LAVA !== '0'
    ? lavaApproachSeconds(best.at, true) < lavaApproachSeconds(known.lava, lavaSourceKnown)
    : far(best.at) + 8 < far(known.lava) || !lavaSourceKnown)) {
    known.lava = { x: best.at.x, y: best.at.y, z: best.at.z }
    setLavaSourceKnown(true)
    const at = `${best.at.x},${best.at.y},${best.at.z}`
    log(`обзор вдаль: лава под небом ${best.kind} ${at} (${best.dist} бл., открытых ${best.open}) — запомнил`)
    try { await call('remember', { kind: 'лава', text: `лава на ${at}`, place: 'лава' }) } catch {}
  }
  return best
}
const castSiteFails = new Map()
const castSiteFailAt = new Map()
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
  await lootSeenStructures(24)
  if (died) return false
  setSkyLookAt(null)
  await skyLavaLook()
  if (!lavaSourceKnown) await act('observe', { radius: 32 })
  return lavaSourceKnown
}
// Постройки на виду — лут ценой (пользователь 14.10: «клады разные искать по структурам основного мира — это время экономит, если
// они рядом»): руины портала (огниво, обсидиан, золото), деревни (еда, железо, кровати), храмы, иглу, корабли, клад по карте
// сокровищ. Идти или нет — выгода предметов при текущих нуждах против пути и работы до сундуков (src/campaign/structure-value.ts,
// таблицы лута 1.21.11), числа — в журнал. Находит глаз (structure scan): постройки, которые бот видел сам; видно отсюда —
// шаблон (structure fit, «как спидраннер знает устройство»): цена по всем сундукам шаблона, видимым и нет; карта корабля —
// цепочкой до клада. Взятая (done) или уже испробованная — мимо.
import * as structureValue from '../src/campaign/structure-value'
// Секунды до сумерек (11840) по часам situation: ночью и в сумерках — 0, вне верхнего мира и без часов — бесконечность.
function dayLeft () {
  const t = Number.isFinite(sit.tod) ? sit.tod : null
  if (t === null || dim() !== 'overworld') return Infinity
  return t < 11840 ? (11840 - t) / 20 : t >= 23460 ? (24000 - t + 11840) / 20 : 0
}
const structLootTried = new Set()
const structLootRetried = new Set()
function structureNeeds () {
  const kitIron = (have(/bucket$/) ? 0 : 3) + (lighter() ? 0 : 1) + (shieldOn() ? 0 : 1) + (have(PICK_IRON) ? 0 : 3)
  const iron = have(/^(raw_iron|iron_ingot)$/) + Math.floor(have('iron_nugget') / 9)
  // Золотые ботинки на вход в Ад (набор координатора 14.10): золотая вещь уже есть — нужды нет, иначе слитков до 4.
  const gold = goldOn() || have(/^golden_(helmet|chestplate|leggings|boots)$/) ? 0 : Math.max(0, 4 - have(/^(gold_ingot|raw_gold)$/) - Math.floor(have('gold_nugget') / 9))
  return { iron: known.portal ? 0 : Math.max(0, kitIron - iron), lighter: !known.portal && !lighter(), food: Math.max(0, 8 - foodUnits()),
    portal: !!known.portal, diamondPick: !known.portal && !have('diamond_pickaxe'), beds: Math.max(0, BEDS_END - have(/_bed$/)), gold }
}
async function lootSeenStructures (radius = 160) {
  if (dim() !== 'overworld' || died || !state.pos || process.env.ND_STRUCT_LOOT === '0') return false
  await act('structure', { mode: 'scan', radius: 96 })
  const far = x => Math.hypot(x.at.x - state.pos.x, x.at.z - state.pos.z)
  const keyOf = x => `${x.kind}:${x.at.x},${x.at.z}`
  const list = ((await act('structure', { mode: 'list' })).detail?.known || [])
    .filter(x => x && x.at && Number.isFinite(x.at.x) && !x.done && structureValue.PRIOR[x.kind] && !structLootTried.has(keyOf(x)) && far(x) <= (x.kind === 'buried_treasure' && radius >= 160 ? 480 : radius))
  if (!list.length || died) return false
  // Видно отсюда — узнать шаблон (structure-fit): цена по всем сундукам шаблона, а не по среднему вариантов.
  for (const x of list.filter(q => !q.fit && far(q) <= 64 && process.env.ND_STRUCT_TEMPLATES !== '0').slice(0, 2)) {
    const f = await act('structure', { mode: 'fit', kind: x.kind, x: x.at.x, z: x.at.z })
    if (f.detail?.fit) x.fit = f.detail.fit
  }
  const needs = structureNeeds()
  // Сундуки глубже 16 бл. под водой (уровень моря 62) без кармана воздуха тело не берёт (structures.lootAll) — в цене их нет.
  // Под водой глубже 16 бл. (с дверями на карман — 26) не ныряю: те же пределы, что у lootAll (море на 62).
  const reachable = c => !c.wet || !Number.isFinite(c.y) || c.y >= (process.env.ND_AIR_POCKET === '1' ? 36 : 46)
  // Увидена ниже уровня моря (58) — под водой: нырок в цене (руины портала в океане).
  const sunk = x => Number.isFinite(x.at.y) && x.at.y < 58 && x.kind !== 'buried_treasure'
  // Деревня узнана (3+ дома) — кровати и сено по шаблонам домов (сено ≈ 2.5 ед. еды), а не среднее деревни.
  const outside = x => x.kind === 'village' && x.fit && x.fit.houses >= 3 ? { food: (x.fit.hay || 0) * 2.5, bed: x.fit.beds || 0 } : null
  // Хвост захода за сумерками — цена ночи поверху (structure-value.withNight).
  const day = dayLeft()
  const scored = list.map(x => ({ x, w: structureValue.withNight(structureValue.structureWorth(x.kind, far(x), needs, x.fit ? x.fit.chests.filter(reachable) : null, sunk(x), outside(x)), day) })).sort((a, b) => b.w.net - a.w.net)
  for (const s of scored.slice(0, 3)) log(`постройка ${s.x.name || s.x.kind} в ${Math.round(s.w.distance)} бл.: ${structureValue.describeWorth(s.w)} — ${s.w.net > 0 ? 'иду' : 'мимо'}`)
  const best = scored[0]
  if (!(best.w.net > 0)) return false
  // В воде к сухой постройке не начинать: тактика рвёт заход сразу (ферма 14.10, cs-3: дважды «1 с, прервано» с поверхности моря).
  await sense()
  if (sit.inWater && !sunk(best.x) && !/^(shipwreck|ocean_ruin)$/.test(best.x.kind)) {
    log(`постройка ${best.x.name || best.x.kind}: я в воде — сперва на берег`)
    if (process.env.ND_OW_DESERT_SHORE !== '1' || !(await leaveWater()) || died) return false
    // Re-price from the actual shore next turn; don't mark this structure tried while escaping.
    return false
  }
  structLootTried.add(keyOf(best.x))
  // Глубоко под водой (сундуки ниже y 52 — больше 10 бл. воды) — двери на карманы воздуха, пока на суше: 6 досок → 3 двери.
  const deepest = Math.min(...((best.x.fit && best.x.fit.chests) || []).map(c => Number.isFinite(c.y) ? c.y : 99), Number.isFinite(best.x.at.y) ? best.x.at.y : 99)
  if (process.env.ND_AIR_POCKET === '1' && /^(shipwreck|ocean_ruin)$/.test(best.x.kind) && deepest < 52 && !have(/_door$/) && !sit.inWater) {
    const wood = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'].find(w => have(`${w}_planks`) >= 6 || have(new RegExp(`^${w}_log$`)) >= 2)
    if (wood) await craft(`${wood}_door`, 3)
  }
  const bag0 = { ...(state.inventory || {}) }
  const t0 = gameClock.now()
  // Далеко (за 48 бл.) — сперва дорогой кампании (отрезки, обходы, выход из-под крыши — goToward), explore — с подхода: шагом
  // pathfinder'а explore через 400 бл. моря рвался тактикой (ферма 14.10, клад по карте корабля −1,13 → 313,249).
  if (far(best.x) > 48 && !(await goToward(best.x.at, 24))) {
    log(`постройка ${best.x.name || best.x.kind}: дорогой не дошёл${structLootRetried.has(keyOf(best.x)) ? '' : ' — ещё раз потом'}`)
    if (!structLootRetried.has(keyOf(best.x))) { structLootRetried.add(keyOf(best.x)); structLootTried.delete(keyOf(best.x)) }
    return true
  }
  const e = await act('structure', { mode: 'explore', kind: best.x.kind, x: best.x.at.x, z: best.x.at.z, ...(Number.isFinite(best.x.at.y) ? { y: best.x.at.y } : {}),
    ...(best.x.kind === 'village' && needs.beds > 0 ? { beds: 1 } : {}), maxDistance: Math.ceil(far(best.x)) + 24, timeoutSeconds: Math.round(Math.min(420, best.w.cost * 2 + 60)) })
  await refresh()
  if (have('gold_block')) await craft('gold_ingot', 9 * have('gold_block'))
  if (have('gold_nugget') >= 9) await craft('gold_ingot', Math.floor(have('gold_nugget') / 9))
  if (!goldOn() && have(/^golden_(helmet|chestplate|leggings|boots)$/)) await act('armor')
  const got = Object.entries(state.inventory || {}).filter(([k, n]) => (Number(n) || 0) > (Number(bag0[k]) || 0)).map(([k, n]) => `${k}+${Number(n) - (Number(bag0[k]) || 0)}`)
  log(`постройка ${best.x.name || best.x.kind}: ${Math.round((gameClock.now() - t0) / 1000)} с (оценка ${Math.round(best.w.cost)} с), взял ${got.join(', ') || 'ничего'}${e.detail?.stopped ? ' — ' + String(e.detail.stopped).slice(0, 80) : ''}`)
  // Шаблон и сундуки по нему (structures.explore): что узнал, сколько открыл, что не вскрыл — для замера.
  const tLines = (e.detail?.lines || []).filter(l => /шаблон|сундук шаблона|колодец|подвал|карта сокровищ|не ныряю|плита/.test(l)).slice(0, 6)
  const planned = (e.detail?.chests || []).filter(c => c.planned)
  if (tLines.length || planned.length) log(`постройка ${best.x.name || best.x.kind}: ${tLines.map(l => l.replace(/^[▸⚠] /, '')).join('; ')}${planned.length ? `; сундуков по шаблону открыто ${planned.filter(c => c.took).length} из ${planned.length}` : ''}`)
  // Заход оборван тактикой (воздух, моб) — постройка не взята: ещё один заход потом, не больше.
  if (e.status === 'interrupted' && !structLootRetried.has(keyOf(best.x))) { structLootRetried.add(keyOf(best.x)); structLootTried.delete(keyOf(best.x)); return true }
  // Исчерпана — только взятая целиком (explore done); оборванный или неполный заход ресурс не закрывает (ревью Codex q2).
  if (e.status === 'done' && e.detail?.done && /^(village|shipwreck|buried_treasure)$/.test(best.x.kind)) graphFact(best.x.kind === 'buried_treasure' ? 'treasure_exhausted' : `${best.x.kind}_exhausted`, true)
  return true
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
    setSkyLavaSeen({ ...best.at, kind: best.kind, open: best.open })
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
  if (!state.pos || Math.floor(state.pos.x) !== S.x || Math.floor(state.pos.z) !== S.z) { log(`${why}: до низа колодца не дошёл`); setSurfaceShaft(null); return false }
  const up = await act('tunnel', { direction: 'up', length: 96, toY: S.top, timeoutSeconds: 150 })
  await refresh()
  setSurfaceShaft(null)
  if (died || y() < S.top - 2) { log(`${why}: подъём встал на y ${Math.round(y())} (${String((up.detail && up.detail.stopped) || up.error || '').slice(0, 80)})`); return false }
  return true
}
async function naturalCast () {
  if (!NATURAL || !skyLavaSeen || naturalTried >= 1 || known.portal) return false
  setNaturalTried(naturalTried + 1)
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

export { NATURAL, dayLavaActive, dayLavaStep, earlyLavaLookout, lavaLookout, skyLavaLook, castSiteFails, castSiteFailAt,
  lavaAtSeenRuins, structureValue, dayLeft, lootSeenStructures, surfaceLavaSurvey, toShaftColumn, climbOwnShaft,
  naturalCast }
