'use strict'
const Vec3 = require('vec3')
const { goals } = require('mineflayer-pathfinder')
const { withTimeout, placeBlockAt, pickFiller } = require('./build')
const { itemNamed, countItems, diffItems, equipBestTool } = require('./items')

// Механизмы из чертежа, которые тело строит само и потом ими пользуется.
//
// kind 'cane' — самосрез тростника: ряд из n столбцов, каждый сам срезает
// тростник, когда тот дорастёт до третьего блока. Раскладка проверена в игре
// (/setblock на build-сервере, 2026-09-25), а не взята из памяти: три
// «классических» варианта с наблюдателем прямо над поршнем НЕ срабатывают —
// импульс наблюдателя (ObserverBlock.tick: setBlock с флагом 2 и
// updateNeighborsInFront — только блок за спиной и его соседи) до поршня не
// доходит, а наблюдатель, глядящий на клетку, куда входит голова поршня,
// видит эту голову и зацикливается в часы. Рабочий столбец, в координатах
// u (вдоль ряда), y (над почвой), v (от дорожки к воде):
//
//      v: -1        0          1                 2
//  y=3:  .       (рост 3)   observer→v-1       redstone_wire
//  y=2:  воздух  (рост 2)   piston→v-1         камень
//  y=1:  ТЕЛО    тростник   камень             камень
//  y=0:  дорожка почва      ВОДА               камень (стенка)
//  y=-1:  .        .        камень (дно)        .
//
// Наблюдатель (FACING = куда смотрит игрок, ObserverBlock.getStateForPlacement)
// смотрит на третий блок тростника; его спина — в провод; провод по верху
// камня за поршнем сильно запитывает этот камень (RedStoneWireBlock.
// getDirectSignal вверх), камень — соседа, поршень (FACING = против взгляда,
// PistonBaseBlock). Поршень ломает второй блок (у тростника PushReaction
// DESTROY), третий осыпается без опоры, корень остаётся. Провод идёт по всему
// ряду: сработал один столбец — срезаются все, что доросли до двух.
// Дроп падает на почву у корня и на дорожку — собирать с дорожки (подбор —
// коробка игрока +1 блок вбок).
// Водяной жёлоб — из двух вёдер: вода в чётные клетки, нечётные становятся
// источником сами (две соседних воды и твёрдое дно), дальше черпать из
// клетки 1 — она опять наполняется.

const DIRS = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }
const LEFT = { north: 'west', south: 'east', east: 'north', west: 'south' }
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east' }
// mineflayer: yaw 0 — север, против часовой.
const YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 }
const SOIL = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|moss_block|pale_moss_block|mycelium|sand|red_sand|suspicious_sand|muddy_mangrove_roots)$/
const AIRISH = b => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'
const SOLID = b => !!b && b.boundingBox === 'block' && !/water|lava/.test(b.name)
const isWaterSource = b => !!b && b.name === 'water' && Number((b.getProperties && b.getProperties().level) || 0) === 0

function sleep (ms, ctl) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { clearTimeout(t); resolve() })
  })
}
const xyz = p => ({ x: p.x, y: p.y, z: p.z })
const k3 = p => `${p.x},${p.y},${p.z}`

// Ряд тростника: где что стоит.
function caneLayout (at, facing, n) {
  const v = DIRS[facing]; const u = DIRS[LEFT[facing]]
  const w = (i, y, vv) => new Vec3(at.x + u[0] * i + v[0] * vv, at.y + y, at.z + u[2] * i + v[2] * vv)
  const cols = []
  for (let i = 0; i < n; i++) {
    cols.push({
      i,
      soil: w(i, 0, 0),
      water: w(i, 0, 1),
      floor: w(i, -1, 1),
      wall: w(i, 0, 2),
      walk: w(i, 0, -1),
      stand: w(i, 1, -1),
      head: w(i, 2, -1),
      cane: [w(i, 1, 0), w(i, 2, 0), w(i, 3, 0)],
      under: w(i, 1, 1),
      back1: w(i, 1, 2),
      back2: w(i, 2, 2),
      piston: w(i, 2, 1),
      observer: w(i, 3, 1),
      wire: w(i, 3, 2)
    })
  }
  const caps = [w(-1, 0, 1), w(n, 0, 1)]
  return { cols, caps, face: OPP[facing], facing }
}

// ------------------------------------------------------------------ руки

async function goNear (bot, pos, range = 3, ms = 15000) {
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 0.5) return true
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, range)), ms, 'не дошёл')
    return true
  } catch {
    try { bot.pathfinder.setGoal(null) } catch {}
    return bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= range + 1.5
  }
}

async function clearCell (bot, pos) {
  const b = bot.blockAt(pos)
  if (AIRISH(b) || /^(water|lava)$/.test(b.name)) return true
  if (b.hardness === null || b.hardness < 0) return false
  if (!(await goNear(bot, pos, 3))) return false
  try { await equipBestTool(bot, b) } catch {}
  try { await withTimeout(bot.dig(b, true), 10000) } catch {}
  return AIRISH(bot.blockAt(pos))
}

function waitLook (bot) {
  return new Promise(resolve => {
    const t = setTimeout(done, 160)
    function done () { clearTimeout(t); bot.removeListener('move', done); resolve() }
    bot.once('move', done)
  })
}

async function waitBlock (bot, pos, pred, ms = 1500) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const b = bot.blockAt(pos)
    if (pred(b)) return b
    await sleep(50)
  }
  return bot.blockAt(pos)
}

// Поставить блок, кликнув грань соседа ref; взгляд (yaw, pitch) — отдельно:
// им сервер выбирает поворот поршня/наблюдателя (getNearestLookingDirection).
async function placeOn (bot, pos, item, ref, { yaw = null, pitch = null } = {}) {
  const stack = itemNamed(bot, item)
  if (!stack) return { ok: false, why: `нет ${item}` }
  if (!(await goNear(bot, pos, 3))) return { ok: false, why: 'не дошёл' }
  try { if (!bot.heldItem || bot.heldItem.name !== item) await bot.equip(stack, 'hand') } catch (e) { return { ok: false, why: e.message } }
  const face = pos.minus(ref)
  const cursor = new Vec3(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
  const aim = ref.plus(cursor)
  const eye = bot.entity.position.offset(0, 1.62, 0)
  const dx = aim.x - eye.x; const dy = aim.y - eye.y; const dz = aim.z - eye.z
  await bot.look(yaw ?? Math.atan2(-dx, -dz), pitch ?? Math.atan2(dy, Math.hypot(dx, dz)), true)
  await waitLook(bot)
  const before = (bot.blockAt(pos) || {}).name
  try { await bot._genericPlace(bot.blockAt(ref), face, { forceLook: 'ignore', delta: cursor, swingArm: 'right' }) } catch (e) { /* проверим мир */ }
  const got = await waitBlock(bot, pos, b => b && b.name !== before)
  return got && got.name !== before ? { ok: true, name: got.name, props: got.getProperties() } : { ok: false, why: `сервер не поставил ${item}` }
}

// Вода вёдрами: BucketItem.use — луч из глаз по взгляду (для полного ведра
// Fluid.NONE), вода встаёт в клетку перед гранью, в которую попал луч. Целимся
// в переднюю грань стенки за жёлобом: луч проходит над почвой и входит в
// пустой жёлоб.
async function pourAt (bot, col) {
  const b = bot.blockAt(col.water)
  if (isWaterSource(b)) return true
  const bucket = itemNamed(bot, 'water_bucket')
  if (!bucket) return false
  if (!(await goNear(bot, col.stand, 1))) return false
  try { await bot.equip(bucket, 'hand') } catch { return false }
  const face = col.water.minus(col.wall)
  const aim = col.wall.offset(0.5 + face.x * 0.5, 0.5, 0.5 + face.z * 0.5)
  await bot.lookAt(aim, true)
  await waitLook(bot)
  try { bot.activateItem() } catch {}
  const got = await waitBlock(bot, col.water, x => x && x.name === 'water', 1500)
  return !!got && got.name === 'water'
}

// Зачерпнуть из источника (луч Fluid.SOURCE_ONLY — в гладь воды).
async function scoop (bot, col) {
  const bucket = itemNamed(bot, 'bucket')
  if (!bucket) return false
  if (!isWaterSource(bot.blockAt(col.water))) return false
  if (!(await goNear(bot, col.stand, 1))) return false
  try { await bot.equip(bucket, 'hand') } catch { return false }
  await bot.lookAt(col.water.offset(0.5, 0.85, 0.5), true)
  await waitLook(bot)
  const before = countItems(bot).water_bucket || 0
  try { bot.activateItem() } catch {}
  const t0 = Date.now()
  while (Date.now() - t0 < 1500 && (countItems(bot).water_bucket || 0) <= before) await sleep(50)
  return (countItems(bot).water_bucket || 0) > before
}

// ------------------------------------------------------------------ тростник

function caneNeeds (bot, L) {
  const stock = countItems(bot)
  const need = {}
  const add = (k, n = 1) => { need[k] = (need[k] || 0) + n }
  let filler = 0
  for (const c of L.cols) {
    if (!SOIL.test((bot.blockAt(c.soil) || {}).name || '')) add('dirt')
    for (const p of [c.floor, c.wall, c.walk]) if (!SOLID(bot.blockAt(p))) filler++
    for (const p of [c.under, c.back1, c.back2]) if (!SOLID(bot.blockAt(p))) filler++
    const nm = p => (bot.blockAt(p) || {}).name
    if (nm(c.piston) !== 'piston') add('piston')
    if (nm(c.observer) !== 'observer') add('observer')
    if (nm(c.wire) !== 'redstone_wire') add('redstone')
    if (nm(c.cane[0]) !== 'sugar_cane') add('sugar_cane')
  }
  for (const p of L.caps) if (!SOLID(bot.blockAt(p))) filler++
  const dry = L.cols.filter(c => !isWaterSource(bot.blockAt(c.water))).length
  const buckets = dry === 0 ? 0 : (L.cols.length === 1 ? 1 : 2)
  const short = []
  for (const [k, n] of Object.entries(need)) {
    const have = k === 'dirt' ? ['dirt', 'sand', 'grass_block', 'coarse_dirt', 'red_sand'].reduce((s, x) => s + (stock[x] || 0), 0) : (stock[k] || 0)
    if (have < n) short.push({ what: k, count: n, have })
  }
  const fillers = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'netherrack', 'dirt']
  const fillHave = fillers.reduce((s, x) => s + (stock[x] || 0), 0) - (need.dirt ? Math.min(need.dirt, stock.dirt || 0) : 0)
  if (fillHave < filler) short.push({ what: 'cobblestone', count: filler, have: Math.max(0, fillHave) })
  if ((stock.water_bucket || 0) < buckets) short.push({ what: 'water_bucket', count: buckets, have: stock.water_bucket || 0 })
  return { need: { ...need, filler, water_bucket: buckets }, short }
}

function caneCheck (bot, L) {
  const nm = p => (bot.blockAt(p) || {}).name
  const pr = p => { try { return bot.blockAt(p).getProperties() } catch { return {} } }
  return L.cols.map(c => {
    const bad = []
    if (!SOIL.test(nm(c.soil) || '')) bad.push(`почва ${nm(c.soil)}`)
    if (!isWaterSource(bot.blockAt(c.water))) bad.push(`вода ${nm(c.water)}`)
    if (nm(c.piston) !== 'piston' || pr(c.piston).facing !== L.face) bad.push(`поршень ${nm(c.piston)}[${pr(c.piston).facing}]`)
    if (nm(c.observer) !== 'observer' || pr(c.observer).facing !== L.face) bad.push(`наблюдатель ${nm(c.observer)}[${pr(c.observer).facing}]`)
    if (nm(c.wire) !== 'redstone_wire') bad.push(`провод ${nm(c.wire)}`)
    if (!SOLID(bot.blockAt(c.back2))) bad.push(`камень за поршнем ${nm(c.back2)}`)
    const height = c.cane.filter(p => nm(p) === 'sugar_cane').length
    return { i: c.i, ok: bad.length === 0, height, bad: bad.length ? bad : undefined, at: xyz(c.soil) }
  })
}

async function buildCane (session, ctl, p, report) {
  const bot = session.bot
  const n = Math.max(1, Math.min(8, p.length ?? 4))
  const facing = DIRS[p.facing] ? p.facing : null
  // По умолчанию: ряд начинается в двух шагах перед телом, вода — дальше от тела.
  let at = p.at ? new Vec3(Math.floor(p.at.x), Math.floor(p.at.y), Math.floor(p.at.z)) : null
  const f = facing || (() => {
    const yaw = bot.entity.yaw
    const dx = -Math.sin(yaw); const dz = -Math.cos(yaw)
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north')
  })()
  if (!at) {
    const me = bot.entity.position.floored()
    at = me.offset(DIRS[f][0] * 2, -1, DIRS[f][2] * 2)
  }
  const L = caneLayout(at, f, n)
  report.at = xyz(at)
  report.facing = f
  report.length = n
  const { need, short } = caneNeeds(bot, L)
  report.materials = need
  if (short.length && !p.force) {
    report.need = short[0]
    report.short = short
    report.stopped = `не хватает на ряд из ${n}: ${short.map(s => `${s.what} ${s.have}/${s.count}`).join(', ')} — поршень: 3 доски + 4 булыжника + железо + редстоун; наблюдатель: 6 булыжника + 2 редстоуна + кварц`
    return report
  }
  const steps = { dug: 0, placed: 0, fails: [] }
  report.steps = steps
  const fail = (what, why) => { steps.fails.push(`${what}: ${why}`); return false }
  const filler = () => { const it = pickFiller(bot, { steady: true }); return it ? it.name : null }
  const solidAt = async (pos, what) => {
    if (SOLID(bot.blockAt(pos))) return true
    const b = bot.blockAt(pos)
    if (b && !AIRISH(b) && !/water|lava/.test(b.name)) await clearCell(bot, pos)
    const item = filler()
    if (!item) return fail(what, 'нечем заложить')
    if (!(await goNear(bot, pos, 3))) return fail(what, 'не дошёл')
    const r = await placeBlockAt(bot, pos, { item, steady: true })
    if (r.ok) { steps.placed++; return true }
    return fail(what, r.reason || 'не поставил')
  }

  // 1. Место: всё, что должно быть пустым, — вынуть (сверху вниз). Над сухим
  // жёлобом — тоже: луч ведра идёт к стенке через эту клетку.
  for (const c of L.cols) {
    const dry = !isWaterSource(bot.blockAt(c.water))
    for (const pos of [c.observer, c.wire, c.cane[2], c.piston, c.back2, c.cane[1], c.head, c.stand, c.cane[0], ...(dry ? [c.under] : [])]) {
      if (ctl.aborted) return report
      const b = bot.blockAt(pos)
      const keep = (pos === c.observer && b && b.name === 'observer') || (pos === c.piston && b && b.name === 'piston') ||
        (pos === c.wire && b && b.name === 'redstone_wire') || (pos === c.back2 && SOLID(b)) || (pos === c.cane[0] && b && b.name === 'sugar_cane')
      if (keep || AIRISH(b)) continue
      if (await clearCell(bot, pos)) steps.dug++
      else fail(k3(pos), `не вынул ${b.name}`)
    }
  }
  // 2. Твёрдое: дорожка, дно и стенка жёлоба, заглушки по концам.
  for (const c of L.cols) {
    if (ctl.aborted) return report
    await solidAt(c.walk, 'дорожка')
    if (!isWaterSource(bot.blockAt(c.water)) && !AIRISH(bot.blockAt(c.water)) && bot.blockAt(c.water).name !== 'water') { if (await clearCell(bot, c.water)) steps.dug++ }
    await solidAt(c.floor, 'дно жёлоба')
    await solidAt(c.wall, 'стенка жёлоба')
  }
  for (const cap of L.caps) {
    const b = bot.blockAt(cap)
    if (b && b.name === 'water') continue
    await solidAt(cap, 'заглушка жёлоба')
  }
  // 3. Почва.
  for (const c of L.cols) {
    if (SOIL.test((bot.blockAt(c.soil) || {}).name || '')) continue
    await clearCell(bot, c.soil)
    const item = ['dirt', 'sand', 'grass_block', 'coarse_dirt', 'red_sand'].find(x => itemNamed(bot, x))
    if (!item) { fail('почва', 'нет земли/песка'); continue }
    if (!(await goNear(bot, c.soil, 3))) { fail('почва', 'не дошёл'); continue }
    const r = await placeBlockAt(bot, c.soil, { item })
    if (r.ok) steps.placed++; else fail('почва', r.reason)
  }
  // 4. Вода: чётные клетки из вёдер, нечётные станут источником сами.
  const targets = []
  for (let i = 0; i < n; i += 2) targets.push(i)
  if ((n - 1) % 2 === 1) targets.push(n - 1)
  for (const i of targets) {
    if (ctl.aborted) return report
    const c = L.cols[i]
    if (isWaterSource(bot.blockAt(c.water))) continue
    if (!itemNamed(bot, 'water_bucket') && n >= 3) {
      await sleep(600, ctl)
      await scoop(bot, L.cols[1])
    }
    if (await pourAt(bot, c)) steps.poured = (steps.poured || 0) + 1
    else fail(`вода ${i}`, 'не налил')
  }
  const w0 = Date.now()
  while (Date.now() - w0 < 4000 && L.cols.some(c => !isWaterSource(bot.blockAt(c.water)))) await sleep(200, ctl)
  // 5. Камни под механикой: за жёлобом, над водой, за поршнем.
  for (const c of L.cols) {
    if (ctl.aborted) return report
    await solidAt(c.back1, 'камень за жёлобом')
    await solidAt(c.under, 'камень над водой')
    await solidAt(c.back2, 'камень за поршнем')
  }
  // 6. Поршни: смотреть от дорожки к воде — поршень встанет головой к тростнику.
  for (const c of L.cols) {
    if (ctl.aborted) return report
    if ((bot.blockAt(c.piston) || {}).name === 'piston') continue
    if (!(await goNear(bot, c.stand, 1))) { fail('поршень', 'не дошёл до дорожки'); continue }
    const r = await placeOn(bot, c.piston, 'piston', c.under, { yaw: YAW[f], pitch: 0 })
    if (r.ok) steps.placed++; else fail('поршень', r.why)
  }
  // 7. Провод по камням за поршнями.
  for (const c of L.cols) {
    if (ctl.aborted) return report
    if ((bot.blockAt(c.wire) || {}).name === 'redstone_wire') continue
    const r = await placeOn(bot, c.wire, 'redstone', c.back2)
    if (r.ok) steps.placed++; else fail('провод', r.why)
  }
  // 8. Наблюдатели на поршнях: смотреть к дорожке — наблюдатель уставится на
  // третий блок тростника, спиной в провод.
  for (const c of L.cols) {
    if (ctl.aborted) return report
    if ((bot.blockAt(c.observer) || {}).name === 'observer') continue
    const r = await placeOn(bot, c.observer, 'observer', c.piston, { yaw: YAW[L.face], pitch: 0 })
    if (r.ok) steps.placed++; else fail('наблюдатель', r.why)
  }
  // 9. Тростник на почву.
  for (const c of L.cols) {
    if (ctl.aborted) return report
    if ((bot.blockAt(c.cane[0]) || {}).name === 'sugar_cane') continue
    if (!(await goNear(bot, c.stand, 1))) { fail('тростник', 'не дошёл'); continue }
    const r = await placeOn(bot, c.cane[0], 'sugar_cane', c.soil)
    if (r.ok) steps.planted = (steps.planted || 0) + 1; else fail('тростник', r.why)
  }
  const cols = caneCheck(bot, L)
  report.columns = cols
  report.ok = cols.filter(c => c.ok).length
  if (!steps.fails.length) delete steps.fails
  if (report.ok < n && !report.stopped) report.stopped = `собрано ${report.ok} из ${n} столбцов: ${cols.filter(c => !c.ok).map(c => `#${c.i} ${c.bad.join(', ')}`).join('; ')}`
  remember(session, L, at)
  return report
}

// Запомнить ферму: collect и status потом найдут её без координат.
function remember (session, L, at) {
  try {
    session.journal.patch(s => {
      s.mechanisms = (s.mechanisms || []).filter(m => !(m.kind === 'cane' && m.at.x === at.x && m.at.y === at.y && m.at.z === at.z))
      s.mechanisms.push({ kind: 'cane', at: xyz(at), facing: L.facing, length: L.cols.length })
    })
  } catch {}
}

function findFarm (session, p) {
  const bot = session.bot
  if (p.at) return { at: new Vec3(Math.floor(p.at.x), Math.floor(p.at.y), Math.floor(p.at.z)), facing: p.facing || 'south', length: p.length ?? 4 }
  let list = []
  try { list = (session.journal.state.mechanisms || []).filter(m => m.kind === 'cane') } catch {}
  const me = bot.entity.position
  const best = list.map(m => ({ ...m, d: me.distanceTo(new Vec3(m.at.x, m.at.y, m.at.z)) })).sort((a, b) => a.d - b.d)[0]
  if (!best) return null
  return { at: new Vec3(best.at.x, best.at.y, best.at.z), facing: best.facing, length: best.length }
}

// Пройти по дорожке и подобрать срезанное.
async function collectCane (session, ctl, p, report) {
  const bot = session.bot
  const farm = findFarm(session, p)
  if (!farm) { report.stopped = 'ферм тростника не знаю: at, facing, length — или сначала mode=build'; return report }
  const L = caneLayout(farm.at, farm.facing, farm.length)
  report.at = xyz(farm.at)
  const before = countItems(bot)
  const drops = () => Object.values(bot.entities).filter(e => e && e.name === 'item' && L.cols.some(c => e.position.distanceTo(c.cane[0].offset(0.5, 0, 0.5)) < 2.5))
  report.seen = drops().length
  const order = [...L.cols]
  if (order.length > 1 && bot.entity.position.distanceTo(order[0].stand) > bot.entity.position.distanceTo(order[order.length - 1].stand)) order.reverse()
  for (let pass = 0; pass < 2 && drops().length && !ctl.aborted; pass++) {
    for (const c of order) {
      if (ctl.aborted) break
      if (!drops().some(e => e.position.distanceTo(c.cane[0].offset(0.5, 0, 0.5)) < 2)) continue
      try { await withTimeout(bot.pathfinder.goto(new goals.GoalBlock(c.stand.x, c.stand.y, c.stand.z)), 8000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
      await sleep(350, ctl)
    }
    order.reverse()
  }
  // Что откатилось за край ряда или дальше руки с дорожки — к самому предмету.
  for (const e of drops().slice(0, 8)) {
    if (ctl.aborted) break
    if (!bot.entities[e.id]) continue
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(e.position.x, e.position.y, e.position.z, 1)), 5000) } catch { try { bot.pathfinder.setGoal(null) } catch {} }
    await sleep(300, ctl)
  }
  report.gained = diffItems(before, countItems(bot))
  report.left = drops().length
  report.columns = caneCheck(bot, L)
  if (!report.seen) report.note = 'срезанного не лежит: тростник ещё не дорос до трёх'
  return report
}

function statusCane (session, p, report) {
  const bot = session.bot
  const farm = findFarm(session, p)
  if (!farm) { report.stopped = 'ферм тростника не знаю: at, facing, length — или mode=build'; return report }
  const L = caneLayout(farm.at, farm.facing, farm.length)
  report.at = xyz(farm.at)
  report.facing = farm.facing
  report.columns = caneCheck(bot, L)
  report.ok = report.columns.filter(c => c.ok).length
  report.drops = Object.values(bot.entities).filter(e => e && e.name === 'item' && L.cols.some(c => e.position.distanceTo(c.cane[0].offset(0.5, 0, 0.5)) < 2.5)).length
  return report
}

async function run (session, ctl, p = {}) {
  const kind = String(p.kind || 'cane').toLowerCase()
  const mode = String(p.mode || 'status').toLowerCase()
  const report = { kind, mode }
  if (kind !== 'cane') throw new Error(`механизм ${kind} не знаю: cane (самосрез тростника)`)
  if (mode === 'build') return buildCane(session, ctl, p, report)
  if (mode === 'collect') return collectCane(session, ctl, p, report)
  if (mode === 'status') return statusCane(session, p, report)
  if (mode === 'plan') {
    const at = p.at ? new Vec3(Math.floor(p.at.x), Math.floor(p.at.y), Math.floor(p.at.z)) : session.bot.entity.position.floored().offset(0, -1, 2)
    const L = caneLayout(at, DIRS[p.facing] ? p.facing : 'south', Math.max(1, Math.min(8, p.length ?? 4)))
    const { need, short } = caneNeeds(session.bot, L)
    return { ...report, at: xyz(at), materials: need, short: short.length ? short : undefined }
  }
  throw new Error(`режим ${mode} не знаю: build / collect / status / plan`)
}

module.exports = { run, caneLayout, caneCheck }
