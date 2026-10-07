type CampaignRouteContext = Record<string, any>

export function createOverworldRoute(ctx: CampaignRouteContext) {
// Вслепую (ND_MAP=0 — главная метрика с 07.10 09:24) маршрут идёт по тому, что тело увидело: план строится из seenInfo
// (постройки по взгляду, лава на виду/по слуху), обновляется перед каждым шагом (routeSeenRefresh). ND_ROUTE_SEEN=0 — без маршрута.
const seenMode = () => !!(ctx.ROUTE && ctx.routeMod && ctx.routeMod.mapLevel && ctx.routeMod.mapLevel() === 'blind' && ctx.process.env.ND_ROUTE_SEEN !== '0')
function routeInfoGet () {
  if (ctx.routeInfoV === undefined) {
    if (seenMode()) { if (ctx.state.pos) ctx.routeInfoV = ctx.routeMod.seenInfo({ spawn: { x: Math.round(ctx.state.pos.x), z: Math.round(ctx.state.pos.z) } }) }
    else ctx.routeInfoV = (ctx.ROUTE && ctx.routeMod && ctx.process.env.ND_WORLD_SEED) ? ctx.routeMod.routeInfo(ctx.process.env.ND_WORLD_SEED) : null
  }
  return ctx.routeInfoV ?? null
}
let seenSky = null
// Лава, замеченная шагами маршрута (explore/observe/штрек): known.lava меняется только на БЛИЖНЮЮ, а после неудачи у первой
// нужна любая другая (S8c, s8c-f-v1-13).
const seenLavas = []
const lavaAvoided = q => !!q && !!(ctx.routeAvoid && (ctx.routeAvoid.has(`lava:sky:${q.x},${q.z}`) || ctx.routeAvoid.has(`lava:cave:${q.x},${q.z}`)))
function noteLava (q) {
  if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y) || lavaAvoided(q)) return false
  if (seenLavas.some(l => Math.hypot(l.x - q.x, l.z - q.z) < 8)) return false
  seenLavas.push({ x: q.x, y: q.y, z: q.z })
  return true
}
function lavaOf (r) {
  const d = (r && r.detail) || {}
  if (d.found === 'lava' && d.at) return d.at
  const lv = (Array.isArray(d.blocks) ? d.blocks : []).find(b => b && b.name === 'lava' && b.nearest)
  if (lv) return lv.nearest
  const m = /лава (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String(d.stopped || ''))
  return m ? { x: +m[1], y: +m[2], z: +m[3] } : null
}
async function routeSeenRefresh () {
  const info = ctx.routeInfoGet()
  if (!info || info.map !== 'blind') return
  await ctx.sense()
  // Взгляд с поверхности на 96 бл.: постройки (колокол, кровати, обсидиан руин… — structures.scan по лучам) и лава на виду.
  if (ctx.sit.surface && !ctx.died) {
    await ctx.act('structure', { mode: 'scan', radius: 96 })
    if (!ctx.known.lava && !ctx.skyLavaSeen) await ctx.act('observe', { radius: 96 })
  }
  const list = (await ctx.act('structure', { mode: 'list' })).detail?.known || []
  const me = ctx.state.pos
  // Слышал лаву (штрек, ND_OW_HEAR: сторона, дальность по земле, высота) — место примерно, как пещерная лава.
  const H = ctx.heardLava
  const hv = H && H.from ? ({ east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }[H.dir] || null) : null
  const heard = hv ? { x: H.from.x + hv[0] * (H.flat || H.dist || 8), y: H.from.y + (Number.isFinite(H.height) ? H.height : 0), z: H.from.z + hv[1] * (H.flat || H.dist || 8) } : null
  // Лава поверху (y ≥ 58), увиденная раз, держится: known.lava потом перезаписывает ближняя пещерная (s8c-d-v1-2: лава со столба
  // 216,76 сменилась лавой y 16 из штрека и пошла в план «поверху»). Пещерная — только если поверху ничего.
  const K = ctx.known.lava
  // Лава поверху уже не вышла (её шаг в avoid) — место свободно для следующей увиденной (s8c-f-v1-13: «берег не твёрдый» у малой
  // лавы, а новой в план уже не взять — маршрут кончился).
  const avoided = lavaAvoided
  if (avoided(seenSky)) seenSky = null
  if (K && Number.isFinite(K.y) && K.y >= 58 && !seenSky && !avoided(K)) seenSky = { x: K.x, y: K.y, z: K.z }
  if (!seenSky) { const q = seenLavas.find(l => l.y >= 58 && !avoided(l)); if (q) seenSky = { ...q } }
  const S = ctx.skyLavaSeen || seenSky
  const C = (K && Number.isFinite(K.y) && K.y < 58 && !avoided(K) ? K : null) || seenLavas.find(l => l.y < 58 && !avoided(l)) || heard
  const lava = S && Number.isFinite(S.x) ? { x: S.x, y: S.y, z: S.z, sky: true } : null
  const cave = C && Number.isFinite(C.x) ? { x: C.x, y: C.y, z: C.z, sky: false } : null
  const next = ctx.routeMod.seenInfo({ spawn: info.spawn, structures: list.filter(q => !q.dim || q.dim === 'overworld'), lava: lava || cave, cave: lava ? cave : null })
  next.outposts = list.filter(q => q.kind === 'outpost' && q.at).map(q => ({ x: q.at.x, z: q.at.z, r: 72, src: 'видел' }))
  const was = [info.rp, info.village, info.ship, info.sky, info.lava].map(q => q ? `${q.x},${q.z}` : '-').join('|')
  const now = [next.rp, next.village, next.ship, next.sky, next.lava].map(q => q ? `${q.x},${q.z}` : '-').join('|')
  if (was !== now) ctx.rlog(`вижу: ${[next.rp && `руины ${next.rp.x},${next.rp.z}`, next.village && `деревня ${next.village.x},${next.village.z}`, next.ship && `корабль ${next.ship.x},${next.ship.z}`, next.sky && `лава поверху ${next.sky.x},${next.sky.y},${next.sky.z}`, next.lava && `лава ${next.lava.x},${next.lava.y},${next.lava.z}`].filter(Boolean).join('; ') || 'пока ничего'}`)
  ctx.routeInfoV = next
}

async function routeGo (at, range = 12) {
  if (!at || !ctx.state.pos) return false
  await ctx.sense()
  if (ctx.sit.inWater) { await ctx.leaveWater(); await ctx.sense(); if (ctx.sit.inWater && ctx.process.env.ND_ROUTE_SHORE !== '0') return false }
  if (!ctx.sit.surface && !(await ctx.toSurface())) return false
  await ctx.sense()
  if (ctx.sit.night || ctx.sit.dusk) { await ctx.routeSleep('перед переходом'); await ctx.sense() }
  await ctx.routeAroundOutpost(at)
  if (ctx.sit.night && (ctx.state.health ?? 20) >= 10) {
    const okN = await ctx.routeGoPush({ x: at.x, z: at.z }, range)
    await ctx.refresh()
    return okN || (!!ctx.state.pos && Math.hypot(at.x - ctx.state.pos.x, at.z - ctx.state.pos.z) <= range + 8)
  }
  const ok = await ctx.goToward({ x: at.x, z: at.z }, range)
  await ctx.refresh()
  return ok || (!!ctx.state.pos && Math.hypot(at.x - ctx.state.pos.x, at.z - ctx.state.pos.z) <= range + 8)
}

// Брёвен на старте маршрута: ND_ROUTE_WOODN (умолчание 6 — спидраннер берёт 5–6; с рощи было 12 — 75 с до таймаута, s8-r1-1).
// На вход в Ад хватает: «инструменты Ада: дерево 7/4 досок» (s8-f1-9).
function woodN () { const n = Number(ctx.process.env.ND_ROUTE_WOODN); return n > 0 ? n : 6 }

function routeShaftBackOn () { return ctx.process.env.ND_ROUTE === '1' && ctx.process.env.ND_ROUTE_SHAFT_BACK !== '0' }

function routeRememberShaft (from, extend = false) {
  if (!ctx.routeShaftBackOn()) return
  const next = ctx.require('./src/movement').shaftFromDescent(from, ctx.state.pos)
  if (!extend) { ctx.surfaceShaft = next; return }
  const old = ctx.surfaceShaft
  ctx.surfaceShaft = old && next && old.x === next.x && old.z === next.z && Math.abs(old.bottom - next.top) <= 1
    ? { ...old, bottom: next.bottom } : null
}

async function routeFurnaceSupply () {
  await ctx.refresh()
  if (ctx.have('furnace')) return true
  await ctx.furnaceBack()
  await ctx.refresh()
  if (!ctx.have('furnace') && ctx.have(ctx.COBBLE) < 8) {
    await ctx.act('mine', { block: 'stone', count: 8 - ctx.have(ctx.COBBLE), radius: 14, dry: true, timeoutSeconds: 75 })
    await ctx.refresh()
  }
  // Камня на виду нет (тело наверху) — лесенкой вниз в камень, как этап камня (s8-r2-4: «не вижу stone в 14» ×3 — маршрут кончился).
  // ND_ROUTE_FURNDIR=1: лесенка упёрлась в воду («вода у … — дальше не копаю», s8-f2-13: ×6 на месте → «плавка не вышла трижды» →
  // маршрут кончился с 6 сырого железа) — другая сторона света; спустился — штрек вперёд (камень на уровне — без ходьбы).
  const dirs = ctx.process.env.ND_ROUTE_FURNDIR !== '0' ? ['north', 'east', 'south', 'west'] : [undefined, undefined]
  for (let k = 0; k < dirs.length && !ctx.have('furnace') && ctx.have(ctx.COBBLE) < 8 && !ctx.died; k++) {
    const d = await ctx.act('dig_down', { mode: 'stairs', depth: 4, torchEvery: 0, timeoutSeconds: 90, ...(dirs[k] ? { direction: dirs[k] } : {}) })
    await ctx.refresh()
    if (dirs[k] && ctx.have(ctx.COBBLE) < 8 && d.detail && d.detail.steps) await ctx.act('tunnel', { length: Math.min(6, Math.ceil((8 - ctx.have(ctx.COBBLE)) / 2) + 1), torchEvery: 0, timeoutSeconds: 40 })
    await ctx.refresh()
    if (ctx.have(ctx.COBBLE) < 8) await ctx.act('mine', { block: 'stone', count: 8 - ctx.have(ctx.COBBLE), radius: 6, dry: true, timeoutSeconds: 45 })
    await ctx.refresh()
  }
  if (!ctx.have('furnace') && ctx.have(ctx.COBBLE) >= 8) { await ctx.ensureTable(); await ctx.craft('furnace'); await ctx.refresh() }
  return ctx.have('furnace') > 0
}

async function routeReturnShaft (why) {
  try {
    if (!ctx.sit.surface && ctx.routeShaftBackOn() && ctx.process.env.ND_ROUTE_FURNACE_SUPPLY !== '0' &&
        ctx.have('raw_iron') && !ctx.have('furnace') && ctx.have(ctx.COBBLE) >= 8 && !(await ctx.routeFurnaceSupply())) {
      await ctx.toSurface()
      return
    }
    if (!ctx.sit.surface && !(await ctx.climbOwnShaft(why))) await ctx.toSurface()
  }
  finally { if (ctx.routeShaftBackOn()) ctx.surfaceShaft = null }
}

async function routeGoPush (at, range = 10) {
  const detour = [0, 0.5, -0.5, 1.0, -1.0]
  let turn = 0
  for (let k = 0; k < 10 && !ctx.died; k++) {
    await ctx.refresh()
    if (!ctx.state.pos) return false
    const dx = at.x - ctx.state.pos.x; const dz = at.z - ctx.state.pos.z
    const far = Math.hypot(dx, dz)
    if (far <= range + 2) return true
    const a = Math.atan2(dz, dx) + detour[turn % detour.length]
    const step = Math.min(64, far)
    const leg = far <= 64 && !turn ? { x: at.x, z: at.z } : { x: Math.round(ctx.state.pos.x + Math.cos(a) * step), z: Math.round(ctx.state.pos.z + Math.sin(a) * step) }
    const r = await ctx.act('goto', { x: leg.x, z: leg.z, range: far <= 64 && !turn ? range : 6, timeoutSeconds: 60 })
    turn = r.status === 'done' ? 0 : turn + 1
    if (turn >= detour.length) return false
  }
  return !!ctx.state.pos && Math.hypot(at.x - ctx.state.pos.x, at.z - ctx.state.pos.z) <= range + 8
}

function routeBlockTarget (legacy = 24, atLava = true) {
  // Одно ведро: у лавы 16 (S8b 07.10; было 12 — s8b-b2-5: рама 8/10, «подпорка не встала: нечем строить», добор и новая попытка
  // потеряли раму — на стенки жёлоба, перемычки, подпорки и столб уходит до 20, расчистка даёт не всегда). На этапе камня — 12:
  // в s8b-c добор до 16 под землёй стоил ~25 с медианы фазы камня (mine stone 44 с/прогон против 12–19); у лавы — земля рядом.
  return ctx.process.env.ND_ROUTE === '1' && ctx.process.env.ND_ROUTE_QUOTAS !== '0' && ctx.routeMod.BUCKETS() === 1 ? (atLava ? 16 : 12) : legacy
}

async function routeBlocks (want = 24) {
  for (let i = 0; i < 3 && ctx.fillerCount() < want && !ctx.died; i++) {
    await ctx.refresh()
    if ((ctx.state.health ?? 20) < 12) { ctx.rlog(`блоки: хп ${ctx.state.health} — за камнем не лезу`); break }
    // На поверхности — сперва земля рядом (копается мгновенно, наполнитель не хуже): «mine stone» уводил тело в пещеру на y 47
    // и выход оттуда к лаве в 180 м стоил 83 с (s8-r2-3). ND_ROUTE_DIRTFIRST=0 — прежний порядок.
    if (ctx.process.env.ND_ROUTE_DIRTFIRST !== '0') {
      await ctx.sense()
      if (ctx.sit.surface) {
        await ctx.act('mine', { block: 'grass_block,dirt,coarse_dirt,sandstone,red_sandstone', count: want - ctx.fillerCount(), radius: 10, timeoutSeconds: 40 })
        await ctx.refresh()
        if (ctx.fillerCount() >= want) break
      }
    }
    const m = await ctx.act('mine', { block: 'stone', count: want - ctx.fillerCount(), radius: 16, dry: true, timeoutSeconds: 75 })
    if (ctx.fillerCount() >= want) break
    if (m.code === 'DAMAGE' || m.status === 'interrupted') { ctx.rlog(`блоки: ${m.code || m.status} в забое — хватит (${ctx.fillerCount()})`); break }
    if (!(m.detail && m.detail.dug)) await ctx.act('mine', { block: 'grass_block,dirt,coarse_dirt,sandstone,red_sandstone', count: want - ctx.fillerCount(), radius: 16, timeoutSeconds: 60 })
  }
  return ctx.fillerCount() >= Math.min(want, 12)
}

function routeCookedHunger () {
  return Object.entries(ctx.ROUTE_COOKED_HUNGER).reduce((n, [k, value]: any) => n + ctx.have(k) * value, 0)
}

function routeCookHunger () {
  if (ctx.process.env.ND_ROUTE !== '1' || ctx.known.portal || ctx.process.env.ND_ROUTE_COOK_RESERVE === '0' ||
      !Number.isFinite(ctx.state.health) || !Number.isFinite(ctx.state.food) || ctx.state.health < 16 || ctx.state.food <= 6) return Infinity
  return Math.max(12, 20 - ctx.state.food + 4)
}

// Жарить есть чем: сырое, печь (или уголь) и топливо — как у smeltAll (уголь или дерево сверх запаса 4 брёвен / 8 досок).
// Без топлива cook копал камень на печь и всё равно не жарил (s8-r1-1, s8-r2-1: «плавить beef нечем», mine + dig_down 23 с
// впустую). Сырое мясо — тоже еда на вход.
function canCook () {
  const fuel = ctx.have(/^(coal|charcoal)$/) > 0 || ctx.have(ctx.LOGS) > 4 || ctx.have(/_planks$/) > 8
  return fuel && ctx.have(ctx.RAW) > 0 && (ctx.have('furnace') > 0 || ctx.have(/^(coal|charcoal)$/) > 0)
}

async function routeFood ({ cookRaw = true } = {}) {
  await ctx.refresh()
  if (ctx.have('hay_block')) await ctx.craft('wheat', ctx.have('hay_block') * 9)
  if (ctx.have('wheat') >= 3) await ctx.craft('bread', Math.floor(ctx.have('wheat') / 3))
  if (cookRaw && canCook()) await ctx.cook({ reserveHunger: ctx.routeCookHunger() })
  await ctx.refresh()
}

async function routeHunt (r = 40, limitS = 60) {
  await ctx.sense()
  if (!ctx.sit.surface || (ctx.state.health ?? 20) < 10) return
  const until = ctx.gameClock.now() + limitS * 1000
  ctx.hunting = true
  try {
    for (let k = 0; k < 4 && ctx.gameClock.now() < until && ctx.foodUnits() < 8 && !ctx.died; k++) {
      const o = await ctx.act('observe', { radius: 48 })
      const ents = (o.detail && o.detail.entities) || []
      // Шерсть на кровать — только если кровать в маршруте нужна (ND_ROUTE_BED=0 — спидран без сна: кровать не нужна).
      const woolWant = ctx.process.env.ND_ROUTE_BED === '1' && !ctx.have(/_bed$/) && ctx.have(/_wool$/) < 3
      const all = ents.filter(e => /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/.test(String(e.name || '').toLowerCase()) &&
        (e.dist ?? 99) <= r && !(e.pos && Math.abs(e.pos.y - ctx.y()) > 6)).sort((a, b) => (a.dist ?? 99) - (b.dist ?? 99))
      const prey = (woolWant && all.find(e => /^sheep$/i.test(e.name))) || all[0]
      if (!prey) break
      if ((prey.dist ?? 0) > 20 && prey.pos) await ctx.act('goto', { x: prey.pos.x, z: prey.pos.z, range: 6, timeoutSeconds: 25, surface: 'strict' })
      const sheep = /^sheep$/i.test(prey.name)
      const f = await ctx.act('fight', { target: String(prey.name).toLowerCase(), timeoutSeconds: 25, retreatAtHealth: 0, purpose: sheep && woolWant ? 'resource' : 'food', ...(sheep && woolWant ? { resourceGoal: { item: 'wool', count: 3 } } : {}) })
      if (f.status !== 'done') break
    }
  } finally { ctx.hunting = false }
  await ctx.refresh()
  if (canCook()) await ctx.cook({ reserveHunger: ctx.routeCookHunger() })
  if (ctx.process.env.ND_ROUTE_BED === '1') await ctx.makeBed()
}

// Источники воды рядом есть, а на виду ни одного (холодный биом: озеро за минуты покрылось льдом — s8b-a1-6: у воды карты
// «источников 400, видно 0» ×19, 8 мин до ночи): сломать лёд (под ним — вода) и черпнуть. ND_ROUTE_ICE=0 — выкл.
async function waterUnderIce (r) {
  const why = String((r && r.detail && r.detail.stopped) || '')
  if (ctx.have('water_bucket') || !ctx.have('bucket') || !/источников [1-9]\d*, видно 0/.test(why) || ctx.process.env.ND_ROUTE_ICE === '0') return false
  const m = await ctx.act('mine', { block: 'ice', count: 1, radius: 6, collect: false, timeoutSeconds: 15 })
  if (!(m.detail && m.detail.dug)) return false
  await ctx.act('bucket', { fluid: 'water', radius: 8 })
  if (ctx.have('water_bucket')) { ctx.rlog('вода подо льдом — лёд сломан, ведро полное'); return true }
  return false
}

// Дальний взгляд (S8c 07.10): без воды и деревьев по карте (уровень struct, вслепую) — честный осмотр на 96 бл. (лучи из глаз,
// observe), ближайший видимый блок — цель; ведро/топор дальше 48 не смотрят. ND_ROUTE_FARSIGHT=0 — выкл.
async function farSight (names, radius = 96) {
  if (ctx.process.env.ND_ROUTE_FARSIGHT === '0') return null
  const o = await ctx.act('observe', { radius })
  const me = ctx.state.pos
  const bl = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).filter(b => b && names.test(b.name) && b.nearest &&
    !(me && Math.hypot(b.nearest.x - me.x, b.nearest.z - me.z) < 3)).sort((a, b) => a.dist - b.dist)[0]
  if (bl) ctx.rlog(`вижу ${bl.name} в ${Math.round(bl.dist)} бл. (${bl.nearest.x},${bl.nearest.y},${bl.nearest.z}) — к нему`)
  return bl ? bl.nearest : null
}
async function farWater () {
  const w = await farSight(/^water$/)
  if (!w || ctx.died) return false
  await ctx.routeGo(w, 4)
  const r = await ctx.act('bucket', { fluid: 'water', radius: 16 })
  return ctx.have('water_bucket') > 0 || await waterUnderIce(r)
}

async function routeWater (near) {
  if (ctx.have('water_bucket') || ctx.have('lava_bucket')) return true
  if (!ctx.have('bucket')) return false
  const r0 = await ctx.act('bucket', { fluid: 'water', radius: 48 })
  if (ctx.have('water_bucket') || await waterUnderIce(r0)) return true
  if (await farWater()) return true
  const info = ctx.routeInfoGet()
  const ws = (info && info.ores && info.ores.water) || []
  const me = ctx.state.pos
  const cand = ws.filter(w => me && Math.hypot(w.x - me.x, w.z - me.z) <= 250 && !(ctx.routeMod.outpostNear && ctx.routeMod.outpostNear(info, w, 8)))
    .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) + (near ? Math.hypot(a.x - near.x, a.z - near.z) : 0) - Math.hypot(b.x - me.x, b.z - me.z) - (near ? Math.hypot(b.x - near.x, b.z - near.z) : 0))
  const picks = []
  for (const w of cand) { const st0 = w.stand || w; if (Math.hypot(st0.x - me.x, st0.z - me.z) > 4 && picks.every(q => Math.hypot((q.stand || q).x - st0.x, (q.stand || q).z - st0.z) >= 8)) picks.push(w); if (picks.length >= 3) break }
  for (const w of picks) {
    const st = w.stand || w
    await ctx.routeGo(st, 3)
    await ctx.act('goto', { x: st.x, y: st.y, z: st.z, range: 1, timeoutSeconds: 30 })
    const rw = await ctx.act('bucket', { fluid: 'water', radius: 16 })
    if (ctx.have('water_bucket') || await waterUnderIce(rw)) { ctx.rlog(`вода по карте у ${w.x},${w.y},${w.z}`); return true }
  }
  const e = await ctx.act('explore', { block: 'water', radius: 48, stepDistance: 60, timeoutSeconds: 90 })
  if (e.detail && e.detail.found) await ctx.act('bucket', { fluid: 'water', radius: 48 })
  return ctx.have('water_bucket') > 0
}

async function castOneAt (L, { maxDig = 60 } = {}) {
  if (!L) return false
  await ctx.refresh()
  if (ctx.state.pos && Math.hypot(L.x - ctx.state.pos.x, L.z - ctx.state.pos.z) > 14) {
    await ctx.sense()
    if (ctx.sit.night && ctx.sit.surface) { ctx.rlog('ночь, но всё для портала с собой — к лаве без норы'); await ctx.routeGoPush(L, 10) } else await ctx.routeGo(L, 10)
    await ctx.act('goto', { x: L.x, y: L.y + 1, z: L.z, range: 6, timeoutSeconds: 40 })
  }
  // Озеро ниже тела на 5+ (котловина под холмом: s8-r2-3 — тело на y 81–91, берег на 67, три захода «не встал на берег»
  // под зомби ночью) — колодцем вниз к уровню лавы, как в castCave.
  await ctx.refresh()
  if (ctx.process.env.ND_ROUTE_CAVEDOWN !== '0' && Number.isFinite(L.y) && ctx.y() > L.y + 4 && !ctx.died) {
    ctx.rlog(`к лаве: тело на y ${Math.round(ctx.y())}, лава на ${L.y} — колодцем вниз`)
    await ctx.descend(L.y + 1, { stopAtLava: true, short: ctx.process.env.ND_ROUTE_CAVEDOWN !== '0' })
    if (ctx.died) return false
  }
  let prevWhy = ''
  for (let k = 0; k < 3 && !ctx.died && !ctx.known.portal; k++) {
    const r = await ctx.act('portal', { mode: 'cast', one: true, hint: { x: L.x, y: L.y, z: L.z }, maxDig, timeoutSeconds: 300 })
    await ctx.readMemory()
    const d = r.detail || {}
    if (/CAST_UNSAFE/.test(String(d.stopped || ''))) throw new Error(String(d.stopped))
    const stand = /не встал на берег (-?\d+),(-?\d+),(-?\d+)/.exec(String(d.stopped || ''))
    if (stand && k < 2) {
      // Берег ниже тела на 3+ (лава в чаше/пещере): goto с y отвечает «done» и на 10 бл. выше (s8-r1-1) — колодцем вниз над
      // берегом, потом к нему.
      await ctx.refresh()
      if (ctx.state.pos && ctx.state.pos.y > +stand[2] + 2 && ctx.process.env.ND_ROUTE_CAVEDOWN !== '0') {
        await ctx.act('goto', { x: +stand[1], z: +stand[3], range: 1, timeoutSeconds: 40 })
        await ctx.descend(+stand[2] - 2, { stopAtLava: true, short: ctx.process.env.ND_ROUTE_CAVEDOWN !== '0' })
        if (ctx.died) return false
      }
      await ctx.act('goto', { x: +stand[1], y: +stand[2], z: +stand[3], range: 0, timeoutSeconds: 90 })
      continue
    }
    ctx.rlog(`литьё одним ведром: ${d.lit ? 'горит' : 'нет'}${d.frame ? `, рама ${d.frame}` : ''}${d.stopped ? `; ${String(d.stopped).slice(0, 140)}` : ''}${d.seconds ? ` (${d.seconds} с)` : ''}` +
      (!d.lit && Array.isArray(d.trace) && d.trace.length ? ` [след: ${d.trace.slice(-4).join(' / ').slice(-500)}]` : ''))
    if (ctx.known.portal || d.lit) return true
    // Тот же отказ, что в прошлой попытке, — повтор ничего не меняет (S8c, s8c-a-s1-4: «пол берега не встал» трижды подряд).
    const why = String(d.stopped || r.error || '')
    if (why && why === prevWhy) break
    prevWhy = why
    // Вода кончилась посреди рамы (лава не застыла → лава назад в озеро → ведро пустое) — набрать воду и продолжить ЭТУ раму
    // (план литья в памяти сессии), а не бросать 7/10 ради другой лавы (s8-r2-10: 7/10 у озера → пещера, +220 с).
    if (/нет воды в ведре|воды в ведре нет/.test(String(d.stopped || '')) && ctx.have('bucket') && k < 2 && ctx.process.env.ND_ROUTE_CAST_RESUPPLY !== '0') {
      await ctx.refresh()
      if (await ctx.routeWater(L)) { await ctx.routeGo(L, 10); continue }
    }
    if (ctx.process.env.ND_ROUTE_CAST_RESUPPLY !== '0' && d.need?.what === 'cobblestone' &&
        Number.isFinite(d.need.count) && d.need.count > 0) {
      await ctx.routeBlocks(Math.max(ctx.routeBlockTarget(), d.need.count))
      if (ctx.fillerCount() < d.need.count) return false
      continue
    }
    if (d.built && !d.lit) {
      if (!ctx.lighter()) { await ctx.ensureFlint(); await ctx.refresh(); if (!ctx.lighter() && ctx.have('flint') && ctx.have('iron_ingot')) await ctx.craft('flint_and_steel') }
      if (ctx.lighter()) {
        if (d.site && d.site.origin) await ctx.act('goto', { x: d.site.origin.x, y: d.site.origin.y, z: d.site.origin.z, range: 4, timeoutSeconds: 40 })
        const lit = await ctx.act('portal', { mode: 'build', timeoutSeconds: 60 })
        await ctx.readMemory()
        ctx.rlog(`рама готова, поджиг: ${(lit.detail && lit.detail.lit) || ctx.known.portal ? 'горит' : 'нет'}`)
        if (ctx.known.portal) return true
      }
      if (ctx.process.env.ND_ROUTE_FRAME !== '0') {
        const o = (d.site && d.site.origin) || ctx.state.pos
        if (o) { ctx.routeFrame = { x: Math.round(o.x), y: Math.round(o.y), z: Math.round(o.z) }; ctx.rlog(`рама без огня у ${ctx.routeFrame.x},${ctx.routeFrame.y},${ctx.routeFrame.z} — сперва огонь, потом поджиг её`) }
      }
      break
    }
    if (/места на берегу нет|не вижу лавы|нужно ведро|нет воды|лавы со столба не достать|лавы в досягаемости нет/.test(String(d.stopped || r.error || ''))) break
  }
  return !!ctx.known.portal
}

async function routeSleep (why = '') {
  if (!ctx.ROUTE_SLEEP || ctx.died) return false
  await ctx.sense()
  if (ctx.dim() !== 'overworld' || ctx.state.playPolicy?.mode === 'speedrun') return false
  const t = ctx.todNow()
  const dusk = t === null ? !!ctx.sit.dusk : (t >= 12300 && t < 12542)
  if (!(ctx.nightNow() || dusk)) return false
  if (!ctx.have(/_bed$/) && ctx.have(/_wool$/) >= 3) { await ctx.makeBed(); await ctx.refresh() }
  if (!ctx.have(/_bed$/) && !ctx.sit.bed) return false
  if (ctx.gameClock.now() - ctx.routeSleptAt < 20000) return false
  ctx.routeSleptAt = ctx.gameClock.now()
  const t0 = ctx.gameClock.now()
  await ctx.routeLeaveOutpost(null)
  ctx.rlog(`ночь (${t ?? '?'} тиков${why ? `, ${why}` : ''}) — кровать есть, сплю здесь`)
  await ctx.nightGuard()
  await ctx.sense()
  ctx.rlog(`сон: ${ctx.nightNow() ? 'ночь не проскочила' : 'утро'} за ${Math.round((ctx.gameClock.now() - t0) / 1000)} с`)
  return !ctx.nightNow()
}

async function routeBedLate () {
  if (ctx.died || ctx.have(/_bed$/) || ctx.routeBedTries >= 3 || ctx.dim() !== 'overworld' || ctx.process.env.ND_ROUTE_BED !== '1') return
  const t = ctx.todNow()
  if (t === null || t < 9000 || t > 12400) return
  await ctx.sense()
  if (!ctx.sit.surface || (ctx.state.health ?? 20) < 10) return
  ctx.routeBedTries++
  const r = await ctx.act('wool', { count: 3, radius: 48, timeoutSeconds: 60 })
  const d = r.detail || {}
  await ctx.refresh()
  if (ctx.have(/_wool$/) >= 3) await ctx.makeBed()
  await ctx.refresh()
  ctx.rlog(`кровать к ночи (${t} тиков, попытка ${ctx.routeBedTries}): ${ctx.have(/_bed$/) ? 'есть' : 'нет'}; овец на виду ${d.seen ?? 0}, цвет ${d.color || '—'}, шерсти ${d.wool ?? 0}${Array.isArray(d.steps) && d.steps.length ? ` [${d.steps.slice(-3).join(' / ')}]` : ''}`)
}

async function routeLeaveOutpost (toward = null) {
  const info = ctx.routeInfoGet()
  await ctx.refresh()
  if (!info || !ctx.routeMod.outpostNear || !ctx.state.pos) return
  const hit = ctx.routeMod.outpostNear(info, ctx.state.pos)
  if (!hit) return
  const o = hit.o
  let ax = ctx.state.pos.x - o.x; let az = ctx.state.pos.z - o.z
  if (toward) { const tx = toward.x - o.x; const tz = toward.z - o.z; if (Math.hypot(tx, tz) > o.r) { ax = tx; az = tz } }
  const n = Math.hypot(ax, az) || 1
  const to = { x: Math.round(o.x + ax / n * (o.r + 24)), z: Math.round(o.z + az / n * (o.r + 24)) }
  ctx.rlog(`в зоне аванпоста ${o.x},${o.z} (${Math.round(hit.d)} из ${o.r} бл.) — ухожу к ${to.x},${to.z}`)
  await ctx.act('goto', { x: to.x, z: to.z, range: 6, timeoutSeconds: 60 })
  await ctx.refresh()
}

async function routeAroundOutpost (at) {
  const info = ctx.routeInfoGet()
  if (!info || !ctx.routeMod.outpostWaypoint || !ctx.state.pos) return
  const wp = ctx.routeMod.outpostWaypoint(info, ctx.state.pos, at)
  if (!wp) return
  ctx.rlog(`аванпост ${wp.outpost.x},${wp.outpost.z} (r ${wp.outpost.r}) на пути — обход через ${wp.x},${wp.z}`)
  await ctx.goToward({ x: wp.x, z: wp.z }, 8)
  await ctx.refresh()
}

// Кремень ещё нужен: огня нет и кремня нет. Огниво крафтится сразу из кремня — после него кремня 0, и циклы «пока нет
// кремня» крутили гравий дальше (s8-f3-2: огниво на 8-й мин, place+mine гравия до 15-й, смерть).
function needFlint () { return !ctx.lighter() && !ctx.have('flint') }

async function routeFlintFromBag () {
  const g0 = ctx.have('gravel')
  // Сперва на месте одним навыком (flint_grind: постановка и копка у ног, ~1–2 с на попытку против ~10 с у place + mine).
  if (ctx.process.env.ND_ROUTE_FLINTGRIND !== '0' && ctx.have('gravel') && needFlint()) {
    const r = await ctx.act('flint_grind', { max: 40, timeoutSeconds: 90 })
    await ctx.refresh()
    ctx.rlog(`кремень на месте: ${ctx.have('flint') ? 'есть' : 'нет'} за ${r.detail?.tries ?? '?'} попыток${r.detail?.stopped ? ` (${String(r.detail.stopped).slice(0, 80)})` : ''}`)
  }
  for (let k = 0; k < 40 && needFlint() && ctx.have('gravel') && !ctx.died; k++) {
    const p = await ctx.act('place', { block: 'gravel' })
    if (p.status !== 'done') break
    await ctx.act('mine', { block: 'gravel', count: 1, radius: 6, timeoutSeconds: 20 })
    await ctx.refresh()
  }
  ctx.rlog('кремень из гравия рюкзака: ' + (ctx.have('flint') ? 'есть' : 'нет') + ' (гравия было ' + g0 + ', осталось ' + ctx.have('gravel') + ')')
  if (!ctx.lighter() && ctx.have('flint') && ctx.have('iron_ingot')) await ctx.craft('flint_and_steel')
}

async function routeRecover () {
  await ctx.sense()
  ctx.rlog(`перед копкой/спуском: хп ${Math.round(ctx.state.health ?? 0)}, еда ${ctx.state.food ?? '?'}, врагов ${ctx.sit.foes || 0}${ctx.sit.inWater ? ', в воде' : ''}${ctx.sit.buried ? ', завалило' : ''} — сперва лечение`)
  if (ctx.sit.inWater) await ctx.leaveWater()
  await ctx.sense()
  if (ctx.sit.buried) await ctx.waitDugOut()
  await ctx.sense()
  if (ctx.sit.foes && !ctx.died) await ctx.answerThreat()
  await ctx.refresh()
  if (!ctx.died && (ctx.state.health ?? 20) < 13) {
    if ((ctx.state.food ?? 20) < 18 && (ctx.have(ctx.FOOD) || ctx.have(ctx.RAW))) { if (!ctx.have(ctx.FOOD)) await ctx.cook(); await ctx.act('eat', {}) }
    await ctx.refresh()
    if (!ctx.have(ctx.FOOD) && (ctx.state.food ?? 20) < 18 && !ctx.died) { try { await ctx.stageRun('food')() } catch (e2) { if (e2.stopCampaign || ctx.manualControl) throw e2 } }
    // Отлёжка — только если риск продолжать дороже лечения (S8c, замечание г; ND_ROUTE_RISK=0 — всегда при хп < 13): регенерация
    // идёт и по ходу шага при сытости ≥ 18.
    const canEat = !!(ctx.have(ctx.FOOD) || ctx.have(ctx.RAW)) || (ctx.state.food ?? 20) >= 18
    if (!ctx.died && (ctx.process.env.ND_ROUTE_RISK === '0' || ctx.routeMod.digRefuse(ctx.state.health ?? 20, canEat).refuse)) await ctx.rest()
  }
}

async function routeHealToEnter () {
  await ctx.refresh()
  ctx.routeHealing = true
  try {
    for (let k = 0; k < 3 && (ctx.state.health ?? 20) < 10 && !ctx.died; k++) {
      ctx.rlog(`хп ${Math.round(ctx.state.health ?? 0)} — лечение перед порталом (вход с 10+)`)
      if (ctx.process.env.ND_ROUTE_ENTERHEAL === '0') {
        if ((ctx.state.food ?? 20) < 18 && (ctx.have(ctx.FOOD) || ctx.have(ctx.RAW))) { if (!ctx.have(ctx.FOOD)) await ctx.cook(); await ctx.act('eat', {}) }
      } else {
        for (let n = 0; n < 6 && (ctx.state.food ?? 20) < 20 && (ctx.have(ctx.FOOD) || ctx.have(ctx.RAW)) && !ctx.died; n++) {
          const before = ctx.state.food
          await ctx.act('eat', {})
          await ctx.refresh()
          if (ctx.state.food <= before) break
        }
        if ((ctx.state.food ?? 0) < 18) { ctx.rlog('на лечение нет еды: вход отложен, без бессмысленной отлёжки'); return false }
      }
      await ctx.rest()
      await ctx.refresh()
    }
    return !ctx.died && (ctx.process.env.ND_ROUTE_ENTERHEAL === '0' || (ctx.state.health ?? 0) >= 10)
  } finally { ctx.routeHealing = false }
}

// К стволу из скана — клетка рядом с ним на его высоте: цель в самой клетке ствола goto поднимает до первого места, где
// можно стоять, — на крону (s8b-a1-1/b2-1: «goto 172,70,86» 32 с и тело на листве на 4 выше, «не вижу any_log»).
async function nearTrunk (t, timeoutSeconds) {
  if (ctx.process.env.ND_ROUTE_TRUNK === '0') return /^done$/.test((await ctx.act('goto', { x: t.x, y: t.y, z: t.z, range: 2, surface: 'strict', timeoutSeconds })).status)
  let ok = false
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]].slice(0, 3)) {
    const r = await ctx.act('goto', { x: t.x + dx, y: t.y, z: t.z + dz, range: 1, surface: 'strict', timeoutSeconds: Math.max(10, Math.round(timeoutSeconds / 3)) })
    ok = ok || /^done$/.test(r.status)
    await ctx.refresh()
    if (ctx.died || (ok && ctx.y() <= t.y + 2)) break
  }
  return ok
}

async function routeStep (s) {
  await ctx.refresh()
  const ironNow = () => ctx.have('iron_ingot') + ctx.have('raw_iron') + Math.floor(ctx.have('iron_nugget') / 9)
  switch (s.kind) {
    case 'wood': {
      if (ctx.process.env.ND_ROUTE_STARTER_CHECKPOINT !== '0' && ctx.have(/_pickaxe$/) && ctx.have('crafting_table')) return true
      await ctx.routeLeaveOutpost(s.at || null)
      if (s.at && !(await ctx.routeGo(s.at, 6))) return false
      if (s.src === 'mapwood' && Number.isFinite(s.at?.y) && !(await nearTrunk(s.at, 60))) return false
      // Роща на чужой высоте (TREEANYY: деревья только на горе) — 2D-ход приводит под гору (s8b-a1-7/b2-7, −4303…: роща на
      // y 106, тело на 68 под навесом, «не вижу any_log», 8 мин разведки вслепую) — к стволу с высотой.
      if (s.src !== 'mapwood' && Number.isFinite(s.at?.y) && ctx.y() < s.at.y - 4 && ctx.process.env.ND_ROUTE_TRUNK !== '0') await nearTrunk(s.at, 90)
      if (s.src === 'village' && !ctx.died) {
        await ctx.act('mine', { block: 'any_log', count: 4, radius: 32, timeoutSeconds: 90 })
        await ctx.refresh()
        if (ctx.woodNow() < 3) await ctx.act('mine', { block: 'any_planks', count: 12 - Math.floor(ctx.have(/_planks$/)), radius: 32, timeoutSeconds: 90 })
        await ctx.refresh()
        ctx.rlog(`дерево из деревни: брёвен ${ctx.have(ctx.LOGS)}, досок ${ctx.have(/_planks$/)}`)
      }
      if (s.src === 'mapwood') {
        // ND_ROUTE_WOODN=N — брёвен с рощи N (спидраннер берёт 5–6; было 12: s8-r1-1 — 9 брёвен за 75 с до таймаута); доски дома — 12.
        await ctx.act('mine', { block: 'any_log,any_planks', count: s.in ? 12 : (s.logs || woodN()), radius: 12, timeoutSeconds: 75 })
        await ctx.refresh()
        // Тело над рощей (на кронах: goto «done» на y 91 при стволах на 83, s8-r2-7) — брёвен сквозь листву не видно: вниз к
        // уровню стволов лесенкой и ещё раз, а не к следующей роще в 60 м.
        if (ctx.woodNow() < 3 && Number.isFinite(s.at?.y) && ctx.y() > s.at.y + 3 && !ctx.died && ctx.process.env.ND_ROUTE_WOODDOWN !== '0') {
          ctx.rlog(`над рощей: тело y ${Math.round(ctx.y())}, стволы ${s.at.y} — вниз к ним`)
          // Кирки ещё нет (дерево — первый шаг): лесенка отказывает «Кирки нет вовсе» (s8b-a1-8: тело на кронах тёмного леса y 91,
          // стволы 83 — 2 мин по кронам, ведьма). Листва и земля ломаются рукой — шахтой, падение до 4 хп в начале дёшево.
          const pick = ctx.have(/_pickaxe$/) > 0
          await ctx.act('dig_down', { mode: pick ? 'stairs' : 'shaft', depth: Math.min(8, Math.round(ctx.y() - s.at.y)), torchEvery: 0, ...(pick ? {} : { maxFallHp: 4 }), timeoutSeconds: 40 })
          await ctx.act('mine', { block: 'any_log', count: s.logs || woodN(), radius: 12, timeoutSeconds: 75 })
          await ctx.refresh()
        }
      }
      if (ctx.process.env.ND_ROUTE_WOODMAP !== '0' && ctx.woodNow() >= 3) {
        const pl = ctx.planksFor(); if (pl && ctx.have(pl) < 9) await ctx.craft(pl, 4 * Math.ceil((9 - ctx.have(pl)) / 4))
        if (!ctx.have('crafting_table')) await ctx.craft('crafting_table')
        if (ctx.have('stick') < 2) await ctx.craft('stick', 4)
        if (!ctx.have(/_pickaxe$/)) await ctx.craft('wooden_pickaxe')
        await ctx.refresh()
        if (ctx.have(/_pickaxe$/)) return true
      }
      const info = ctx.routeInfoGet()
      const trees = ((info && info.ores && info.ores.trees) || []).filter(q => !(ctx.routeMod.outpostNear && ctx.routeMod.outpostNear(info, q, 8)))
      const want = s.logs || woodN()
      const seen = new Set()
      // Кирка уже есть (крафт прошёл, а рюкзак отстал — «server did not confirm click»; s8b-c-2: 3.5 мин разведки за 5 брёвнами
      // при кирке в руках) и дерева на топливо хватает — дальше не искать.
      const enough = () => ctx.have(/_pickaxe$/) > 0 && ctx.woodNow() >= 3 && ctx.process.env.ND_ROUTE_WOODENOUGH !== '0'
      for (let k = 0; k < 8 && ctx.woodNow() < want && trees.length && !ctx.died && !enough(); k++) {
        await ctx.act('mine', { block: 'any_log', count: want - ctx.woodNow(), radius: 32, timeoutSeconds: 120 })
        await ctx.refresh()
        if (ctx.woodNow() >= want || enough()) break
        const me = ctx.state.pos
        const pick = band => trees.filter(q => !seen.has(`${q.x},${q.z}`) && me && Math.hypot(q.x - me.x, q.z - me.z) > 6 && Math.hypot(q.x - me.x, q.z - me.z) <= (band > 8 ? 120 : 200) && Math.abs(q.y - (me.y + 3)) <= band)
          .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - b.n * 2 - Math.hypot(b.x - me.x, b.z - me.z) + a.n * 2)[0]
        const t = pick(8) || pick(25) || (ctx.process.env.ND_ROUTE_TRUNK !== '0' ? pick(64) : null)
        if (!t) break
        seen.add(`${t.x},${t.z}`)
        await ctx.routeGo(t, 4)
        // Ствол из скана — вплотную: с 4 бл. его закрывает листва, «не вижу any_log» (s8b-a1-1: 3 попытки и обход до ствола,
        // ~30 с). ND_ROUTE_TRUNK=0 — выкл.
        if (Number.isFinite(t.y) && ctx.process.env.ND_ROUTE_TRUNK !== '0') await nearTrunk(t, 20)
      }
      await ctx.refresh()
      // Рощ по карте нет (struct, вслепую): брёвна на виду до 96 бл. — к ближнему дереву, а не разведка этапа wood.
      for (let k = 0; k < 2 && !trees.length && ctx.woodNow() < want && !enough() && !ctx.died; k++) {
        await ctx.act('mine', { block: 'any_log', count: want - ctx.woodNow(), radius: 32, timeoutSeconds: 90 })
        await ctx.refresh()
        if (ctx.woodNow() >= want || enough()) break
        const t = await farSight(/_log$/)
        if (!t) break
        await ctx.routeGo(t, 4)
      }
      await ctx.refresh()
      if (!enough()) await ctx.stageRun('wood')()
      return ctx.have(/_pickaxe$/) > 0
    }
    case 'bed': {
      if (ctx.have(/_bed$/)) return true
      if (s.how === 'village') {
        if (!(await ctx.routeGo(s.at, 24))) return false
        await ctx.act('structure', { mode: 'explore', kind: 'village', x: s.at.x, z: s.at.z, fromMap: true, maxDistance: 120, beds: 1, food: false, timeoutSeconds: 100 })
        await ctx.refresh()
        return ctx.have(/_bed$/) > 0
      }
      if (s.how === 'block') {
        if (!(await ctx.routeGo(s.at, 8))) return false
        await ctx.act('goto', { x: s.at.x, y: s.at.y, z: s.at.z, range: 1, timeoutSeconds: 45 })
        await ctx.act('mine', { block: ctx.BED_BLOCKS, count: 1, radius: 6, timeoutSeconds: 30 })
        await ctx.refresh()
        if (!ctx.have(/_bed$/) && /village/.test(s.in || '')) await ctx.act('structure', { mode: 'explore', kind: 'village', x: s.at.x, z: s.at.z, fromMap: true, maxDistance: 80, beds: 1, food: false, timeoutSeconds: 60 })
        await ctx.refresh()
        return ctx.have(/_bed$/) > 0
      }
      if (!(await ctx.routeGo(s.at, 14))) return false
      const colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
      const r = await ctx.act('wool', { count: 3, radius: 40, x: s.at.x, z: s.at.z, timeoutSeconds: 90 })
      const d = r.detail || {}
      await ctx.refresh()
      if (ctx.have(/_wool$/) >= 3) await ctx.makeBed()
      await ctx.refresh()
      ctx.rlog(`кровать: ${ctx.have(/_bed$/) ? 'есть' : 'нет'}; овец на виду ${d.seen ?? 0}, цвет ${d.color || '—'} (по карте ${colors[s.color] || s.color}), шерсти ${d.wool ?? 0}, убито ${d.killed ?? 0}, острижено ${d.sheared ?? 0}, ${d.seconds ?? '?'} с${Array.isArray(d.steps) && d.steps.length ? ` [${d.steps.slice(-4).join(' / ')}]` : ''}`)
      if (ctx.have(ctx.RAW)) await ctx.cook({ reserveHunger: ctx.routeCookHunger() })
      return ctx.have(/_bed$/) > 0
    }
    case 'stone':
      await ctx.stageRun('stone')()
      if (ctx.have(ctx.PICK_STONE) && ctx.fillerCount() < ctx.routeBlockTarget(22, false)) await ctx.routeBlocks(ctx.routeBlockTarget(22, false))
      if (ctx.foodUnits() < 3) { await ctx.sense(); if (ctx.sit.surface) await ctx.routeHunt(32, 45) }
      return ctx.have(ctx.PICK_STONE) > 0
    case 'ruin': {
      if (!(await ctx.routeGo(s.at, 16))) return false
      const r = await ctx.act('structure', { mode: 'explore', kind: 'ruined_portal', x: s.at.x, z: s.at.z, ...(Number.isFinite(s.at.y) ? { y: s.at.y } : {}), fromMap: true, maxDistance: 80, gold: false, timeoutSeconds: 120 })
      const took = (r.detail && r.detail.took) || {}
      if (!Object.keys(took).length) {
        await ctx.act('goto', { x: s.at.x, z: s.at.z, range: 4, timeoutSeconds: 40 })
        await ctx.act('structure', { mode: 'explore', kind: 'ruined_portal', maxDistance: 40, gold: false, timeoutSeconds: 90 })
      }
      await ctx.refresh()
      return ctx.lighter() || ctx.have('obsidian') > 0 || ctx.have('iron_nugget') > 0 || ctx.have(/^golden_/) > 0
    }
    case 'village': {
      const iron0 = ironNow()
      if (!(await ctx.routeGo(s.at, 24))) return false
      if (ctx.fillerCount() < 6) await ctx.routeBlocks(8)
      let angry = false
      for (let k = 0; k < (angry ? 5 : 3) && ironNow() - iron0 < 3 && !ctx.died; k++) {
        await ctx.sense()
        const g = await ctx.act('golem', { mode: 'kill', radius: 64, timeoutSeconds: 85, ...(angry ? { angry: true } : {}) })
        const d = g.detail || {}
        angry = angry || ((d.hits || 0) > 0 && !d.killed)
        ctx.rlog(`голем: ${d.killed ? 'убит' : 'жив'}, ударов ${d.hits ?? 0}${d.blocked ? ` (мимо прицела ${d.blocked})` : ''}, железа +${d.iron ?? 0}${d.hpLost ? `, урон ${d.hpLost}` : ''}${d.stopped ? `; ${d.stopped}` : ''}${Array.isArray(d.steps) ? ` [${d.steps.slice(-5).join(' / ')}]` : ''}`)
        if (d.killed || ctx.died) break
        if (/не вижу/.test(String(d.stopped || ''))) {
          const info = ctx.routeInfoGet()
          const gm = info && info.ores && (info.ores.golems || []).filter(q => Math.hypot(q.x - s.at.x, q.z - s.at.z) <= 96)[0]
          const to = gm || s.at
          await ctx.act('goto', { x: to.x, z: to.z, range: 6, timeoutSeconds: 40 })
          await ctx.act('observe', { radius: 48 })
        }
      }
      await ctx.act('structure', { mode: 'explore', kind: 'village', x: s.at.x, z: s.at.z, ...(Number.isFinite(s.at.y) ? { y: s.at.y } : {}), fromMap: true, maxDistance: 120, beds: 1, timeoutSeconds: 100 })
      if (ctx.died) return false
      await ctx.sense()
      if (!ctx.sit.surface && !ctx.sit.night) await ctx.toSurface()
      await ctx.routeFood()
      return ironNow() > iron0 || ctx.foodUnits() >= 6
    }
    case 'treasure': {
      const iron0 = ironNow()
      if (!(await ctx.routeGo(s.at, 6))) return false
      await ctx.act('structure', { mode: 'explore', kind: 'buried_treasure', x: s.at.x, z: s.at.z, maxDistance: 40, timeoutSeconds: 120 })
      await ctx.refresh()
      if (ctx.died) return false
      await ctx.sense()
      if (!ctx.sit.surface) await ctx.toSurface()
      return ironNow() > iron0
    }
    case 'ship': {
      const iron0 = ironNow()
      if (!(await ctx.routeGo(s.at, 20))) return false
      await ctx.act('structure', { mode: 'explore', kind: 'shipwreck', x: s.at.x, z: s.at.z, ...(Number.isFinite(s.at.y) ? { y: s.at.y } : {}), fromMap: true, maxDistance: 80, timeoutSeconds: 180 })
      await ctx.refresh()
      await ctx.leaveWater()
      return ironNow() > iron0
    }
    case 'ore': {
      const quota = ctx.process.env.ND_ROUTE_QUOTAS !== '0'
      if (quota && ctx.routeMod.ironNeed(ctx.state.inventory || {}) === 0) return true
      const iron0 = ironNow()
      const st = s.at
      if (s.buried && s.ore) {
        const o = s.ore
        if (!(await ctx.routeGo(s.at, 3))) return false
        const onCol = () => ctx.state.pos && Math.floor(ctx.state.pos.x) === o.x && Math.floor(ctx.state.pos.z) === o.z
        for (let k = 0; k < 2 && !onCol() && !ctx.died; k++) {
          await ctx.act('goto', Number.isFinite(s.top) ? { x: o.x, y: s.top + 1, z: o.z, range: 0, timeoutSeconds: 30 } : { x: o.x, z: o.z, range: 0, timeoutSeconds: 30 })
          await ctx.refresh()
        }
        if (!onCol()) { ctx.rlog(`над жилой не встал (${ctx.state.pos ? Math.floor(ctx.state.pos.x) + ',' + Math.floor(ctx.state.pos.z) : '?'} вместо ${o.x},${o.z})`); return false }
        const len = Math.round(ctx.y() - (o.y + 1))
        const from = ctx.state.pos && { ...ctx.state.pos }
        if (ctx.routeShaftBackOn()) ctx.surfaceShaft = null
        if (len > 0) await ctx.act('tunnel', { direction: 'down', length: len, timeoutSeconds: 120 })
        if (ctx.died) return false
        await ctx.refresh()
        ctx.routeRememberShaft(from)
        ctx.rlog(`колодец к жиле: ноги y ${Math.round(ctx.y())}, жила y ${o.y} (${s.depth} под рельефом)`)
        if (ctx.y() > o.y + 3) {
          await ctx.sense()
          if (ctx.routeShaftBackOn()) await ctx.routeReturnShaft('колодец к жиле не дошёл')
          else if (!ctx.sit.surface) await ctx.climbOwnShaft('колодец к жиле не дошёл')
          return false
        }
        for (let lv = 0; lv < 5 && !ctx.died; lv++) {
          for (let k = 0; k < 3 && !ctx.died; k++) {
            const before = ironNow()
            const count = quota ? Math.min(10, ctx.routeMod.ironNeed(ctx.state.inventory || {})) : 10
            if (count <= 0) break
            await ctx.act('mine', { block: 'iron_ore,deepslate_iron_ore', count, radius: 5, timeoutSeconds: 60 })
            await ctx.refresh()
            if (ironNow() <= before || (quota && ctx.routeMod.ironNeed(ctx.state.inventory || {}) === 0)) break
          }
          if (ctx.routeMod.ironNeed(ctx.state.inventory || {}) === 0 || ironNow() - iron0 >= 6) break
          const from = ctx.state.pos && { ...ctx.state.pos }
          await ctx.act('tunnel', { direction: 'down', length: 1, timeoutSeconds: 30 })
          await ctx.refresh()
          ctx.routeRememberShaft(from, true)
        }
        // Печь из камня у жилы (булыжник здесь — в стенах колодца, без ходьбы): этап камня при ND_ROUTE_STONETUN=1 её не делает.
        if (ctx.process.env.ND_ROUTE_STONETUN !== '0' && ctx.have('raw_iron') && !ctx.have('furnace') && ctx.have(ctx.COBBLE) < 8 && !ctx.died) {
          // Штрек вбок на уровне жилы (2×4 — ~8 блоков камня), а не «mine stone r 3»: тот в колодце 1×1 стоял 30 с до таймаута
          // (s8-r2-8/10). Назад к колодцу routeReturnShaft выводит сам.
          await ctx.act('tunnel', { length: Math.min(6, Math.ceil((8 - ctx.have(ctx.COBBLE)) / 2) + 1), torchEvery: 0, timeoutSeconds: 30 })
          await ctx.refresh()
          // Печь — сразу здесь: подъём своим колодцем тратит булыжник на столб (s8-r2-4: 7 булыжника у жилы → 0 наверху,
          // «печь не подготовлена» ×3 → маршрут бросил).
          if (ctx.have(ctx.COBBLE) >= 8 && !ctx.have('furnace')) { await ctx.ensureTable(); await ctx.craft('furnace'); await ctx.refresh() }
        }
        const gotB = ironNow() > iron0
        ctx.rlog(`жила под землёй: железа +${ironNow() - iron0}`)
        await ctx.sense()
        await ctx.routeReturnShaft('жила по карте: наверх')
        return gotB
      }
      if ((s.depth || 0) > 6 && ctx.process.env.ND_ROUTE_ORE_SAFE !== '0') {
        await ctx.sense()
        if (ctx.nightNow()) await ctx.routeSleep('перед пещерой')
        await ctx.sense()
        const why = (ctx.state.health ?? 20) < 14 ? `хп ${ctx.state.health}` : ctx.foodUnits() < 1 && (ctx.state.food ?? 20) < 16 ? 'еды нет' : ctx.nightNow() ? 'ночь' : ''
        if (why) { ctx.rlog(`руда в пещере (глубина ${s.depth}) — не иду: ${why}`); return false }
      }
      if (!(await ctx.routeGo(st, 4))) return false
      if (!Number.isFinite(s.walk) && Number.isFinite(st.y) && ctx.y() > st.y + 2) await ctx.descend(st.y + 1, { short: ctx.process.env.ND_ROUTE_CAVEDOWN !== '0' })
      if (ctx.died) return false
      if (Number.isFinite(st.y)) await ctx.act('goto', { x: st.x, y: st.y, z: st.z, range: 1, timeoutSeconds: Number.isFinite(s.walk) ? 60 : 45 })
      const count = quota ? Math.min(10, ctx.routeMod.ironNeed(ctx.state.inventory || {})) : 10
      if (count > 0) await ctx.act('mine', { block: 'iron_ore,deepslate_iron_ore', count, radius: 10, timeoutSeconds: 90 })
      await ctx.refresh()
      const got = ironNow() > iron0
      await ctx.sense()
      if (!ctx.sit.surface && !(await ctx.climbOwnShaft('руда по карте: наверх'))) await ctx.toSurface()
      return got
    }
    case 'mine': {
      const iron0 = ironNow()
      const need = Math.max(1, ctx.routeMod.ironNeed(ctx.state.inventory || {}))
      await ctx.act('mine', { block: 'iron_ore,deepslate_iron_ore', count: need, radius: 48, timeoutSeconds: 150 })
      if (ironNow() - iron0 < need) await ctx.mineSeenAll('iron_ore,deepslate_iron_ore', 32)
      // Руда на склоне дальше 48 (горы: верхняя жила y 80+) — на виду до 96 бл. (S8c, вслепую).
      for (let k = 0; k < 2 && ironNow() - iron0 < need && !ctx.died; k++) {
        const o = await farSight(/^(deepslate_)?iron_ore$/)
        if (!o) break
        await ctx.routeGo(o, 4)
        await ctx.act('mine', { block: 'iron_ore,deepslate_iron_ore', count: need - (ironNow() - iron0), radius: 16, timeoutSeconds: 90 })
        await ctx.refresh()
      }
      await ctx.refresh()
      return ironNow() - iron0 >= need
    }
    case 'smelt': {
      const wantB = ctx.routeMod.BUCKETS()
      const wantIngots = 3 * Math.max(0, wantB - ctx.have(/bucket$/)) + (ctx.lighter() ? 0 : 1)
      const max = Math.max(0, wantIngots - ctx.have('iron_ingot') - Math.floor(ctx.have('iron_nugget') / 9))
      if (max > 0 && ctx.have('raw_iron') && ctx.process.env.ND_ROUTE_FURNACE_SUPPLY !== '0' && !(await ctx.routeFurnaceSupply())) {
        ctx.rlog('плавка: печь не подготовлена — одинаковые вызовы smelt не повторяю')
        return false
      }
      await ctx.smeltAll('raw_iron', 'iron_ingot', { fetchCoal: false, max })
      await ctx.refresh()
      if (ctx.have('iron_nugget') >= 9 && ctx.have('iron_ingot') < 6) { await ctx.ensureTable(); await ctx.act('craft', { item: 'iron_ingot', count: Math.floor(ctx.have('iron_nugget') / 9) }); await ctx.refresh() }
      for (let k = 0; k < 2 && ctx.have(/bucket$/) < wantB && ctx.have('iron_ingot') >= 3; k++) await ctx.craft('bucket')
      await ctx.refresh()
      if (!ctx.lighter() && ctx.have('iron_ingot') >= 1 && ctx.have('flint')) await ctx.craft('flint_and_steel')
      await ctx.refresh()
      // Лишний слиток (ведро и огонь уже есть или огню слиток оставлен) — щит: стрелы скелетов и взрыв крипера (тактика S4d
      // держит щит лицом к взрыву); смерти вслепую — пещеры и ночь (s8c-f-v1: 7 из 15). Только из лишнего, без копки за ним.
      // ND_ROUTE_SHIELD=0 — выкл.
      const spare = ctx.have('iron_ingot') - (ctx.lighter() ? 0 : 1)
      const noShield = !ctx.have('shield') && !(ctx.state.offHand && /shield/.test(JSON.stringify(ctx.state.offHand)))
      if (ctx.process.env.ND_ROUTE_SHIELD !== '0' && ctx.have(/bucket$/) >= wantB && spare >= 1 && noShield && !ctx.died) {
        const pl = ctx.planksFor()
        if (ctx.have(/_planks$/) < 6 && pl && ctx.have(ctx.LOGS) >= 2) await ctx.craft(pl, 8)
        await ctx.refresh()
        if (ctx.have(/_planks$/) >= 6) { await ctx.craft('shield'); await ctx.act('armor', {}) }
        await ctx.refresh()
      }
      return ctx.have(/bucket$/) >= wantB
    }
    case 'flint': {
      if (ctx.lighter()) return true
      // поставить и сломать до кремня (10 % за блок, loot_table/blocks/gravel.json): 26 блоков — 94 %, ~1.5 с на блок.
      if (needFlint() && ctx.have('gravel')) await ctx.routeFlintFromBag()
      if (s.buried && s.ore && needFlint() && !ctx.died) {
        const o = s.ore
        if (await ctx.routeGo(s.at, 3)) {
          const onCol = () => ctx.state.pos && Math.floor(ctx.state.pos.x) === o.x && Math.floor(ctx.state.pos.z) === o.z
          for (let k = 0; k < 2 && !onCol() && !ctx.died; k++) { await ctx.act('goto', { x: o.x, y: s.top + 1, z: o.z, range: 0, timeoutSeconds: 30 }); await ctx.refresh() }
          if (onCol()) {
            const len = Math.round(ctx.y() - (o.y + 1))
            const from = ctx.state.pos && { ...ctx.state.pos }
            if (ctx.routeShaftBackOn()) ctx.surfaceShaft = null
            if (len > 0) await ctx.act('tunnel', { direction: 'down', length: len, timeoutSeconds: 120 })
            await ctx.refresh()
            ctx.routeRememberShaft(from)
            for (let lv = 0; lv < 6 && needFlint() && !ctx.died; lv++) {
              // В залежи каждый блок стенки — честный бросок 10 % без ходьбы (~1 с): копать её по 6, а рюкзак крутить, только
              // когда стенки кончились (s8b-b2-9: в колодце 1×1 flint_grind «некуда поставить», цикл place/mine — 216+177 с без
              // кремня, настоящих бросков ~10). ND_ROUTE_DEPOSIT=0 — прежний ход (по 2 и рюкзак).
              const deposit = ctx.process.env.ND_ROUTE_DEPOSIT !== '0'
              const m = await ctx.act('mine', { block: 'gravel', count: ctx.process.env.ND_ROUTE_FLINTBAG !== '0' ? (deposit ? 6 : 2) : 12, radius: 5, timeoutSeconds: 45 })
              await ctx.refresh()
              const dug = (m && m.detail && m.detail.dug) || 0
              if (ctx.process.env.ND_ROUTE_FLINTBAG !== '0' && needFlint() && ctx.have('gravel') && (!deposit || dug < 6)) await ctx.routeFlintFromBag()
              if (ctx.have('flint')) break
              const from = ctx.state.pos && { ...ctx.state.pos }
              await ctx.act('tunnel', { direction: 'down', length: 1, timeoutSeconds: 30 })
              await ctx.refresh()
              ctx.routeRememberShaft(from, true)
            }
            if (needFlint() && ctx.have('gravel')) await ctx.routeFlintFromBag()
            ctx.rlog(`залежь гравия ${o.x},${o.y},${o.z}: кремень ${ctx.have('flint') ? 'есть' : 'нет'}, гравия ${ctx.have('gravel')}`)
            await ctx.sense()
            await ctx.routeReturnShaft('гравий по карте: наверх')
          } else ctx.rlog(`над залежью гравия не встал (${o.x},${o.z})`)
        }
      }
      for (const at of [s.at, ...(s.alts || [])].filter(Boolean)) {
        if (ctx.have('flint') || ctx.died) break
        await ctx.routeGo(at, 4)
        if (Number.isFinite(at.y)) await ctx.act('goto', { x: at.x, y: at.y, z: at.z, range: 1, timeoutSeconds: 45 })
        // Гравий по одному блоку «mine» — 7 с на блок ходьбы (s8-r2-5: 16 гравия за 140 с, кремень 2), а поставить и сломать
        // из рюкзака — ~2 с, шанс тот же 10 %: копать 2 и крутить рюкзак. ND_ROUTE_FLINTBAG=0 — прежний ход.
        const bag = ctx.process.env.ND_ROUTE_FLINTBAG !== '0'
        for (let k = 0; k < 4 && needFlint() && !ctx.died; k++) {
          const g = await ctx.act('mine', { block: 'gravel', dry: true, count: bag ? 2 : 6, radius: 12, timeoutSeconds: 60 })
          await ctx.refresh()
          if (bag && needFlint() && ctx.have('gravel')) await ctx.routeFlintFromBag()
          if (!(g.detail && g.detail.dug)) break
        }
      }
      for (let k = 0; k < 2 && needFlint() && !s.at && !ctx.died; k++) {
        const g = await ctx.act('mine', { block: 'gravel', dry: true, count: 6, radius: 40, timeoutSeconds: 60 })
        if (!(g.detail && g.detail.dug)) break
      }
      // Поверху гравия не видно (вслепую, s8c-b-v1-1: деревня дала железо, штреков не было — и кремня тоже): гравий в толще
      // частый (ore_gravel 14 залежей на чанк по всей высоте) — лестница вниз на 12 и два штрека по 16 с осмотром, назад той же
      // лестницей пешком. ND_ROUTE_FLINTDIG=0 — выкл.
      // Гравий на виду дальше 40 (берег, склон; observe до 96) — к нему (S8c, вслепую).
      for (let k = 0; k < 2 && needFlint() && !ctx.have('gravel') && !ctx.died; k++) {
        await ctx.sense()
        if (!ctx.sit.surface) break
        const g = await farSight(/^gravel$/)
        if (!g) break
        await ctx.routeGo(g, 4)
        await ctx.act('mine', { block: 'gravel', dry: true, count: 6, radius: 16, timeoutSeconds: 60 })
        await ctx.refresh()
        if (needFlint() && ctx.have('gravel')) await ctx.routeFlintFromBag()
      }
      if (needFlint() && !ctx.have('gravel') && ctx.have(/_pickaxe$/) && !ctx.died && ctx.process.env.ND_ROUTE_FLINTDIG !== '0') {
        await ctx.sense()
        // Уже под землёй (после этапа железа) — штреками отсюда, а не explore по пещерам (s8c-b-v1-4: explore гравия с y 16 увёл в
        // пещеру на y 6 — зомби, смерть на 7.5 мин).
        {
          ctx.rlog(ctx.sit.surface ? 'кремень: поверху гравия нет — лестницей вниз за ним' : 'кремень: под землёй — штреками отсюда')
          if (ctx.sit.surface) await ctx.act('dig_down', { mode: 'stairs', depth: 12, torchEvery: 0, timeoutSeconds: 90 })
          for (const dir of ['north', 'south']) {
            if (!needFlint() || ctx.have('gravel') || ctx.died) break
            await ctx.act('mine', { block: 'gravel', count: 4, radius: 16, timeoutSeconds: 45 })
            await ctx.refresh()
            if (!needFlint() || ctx.have('gravel')) break
            await ctx.act('tunnel', { direction: dir, length: 16, torchEvery: 0, timeoutSeconds: 90 })
            await ctx.act('mine', { block: 'gravel', count: 4, radius: 16, timeoutSeconds: 45 })
            await ctx.refresh()
          }
          if (needFlint() && ctx.have('gravel')) await ctx.routeFlintFromBag()
          // Попутно слушать лаву (литьё после кремня; вслепую лаву надо ещё найти).
          if (ctx.process.env.ND_OW_HEAR !== '0' && !ctx.known.portal) await ctx.listenForLava('штрек за гравием')
          await ctx.refresh()
          ctx.rlog(`кремень под землёй: ${ctx.have('flint') || ctx.lighter() ? 'есть' : 'нет'}, гравия ${ctx.have('gravel')}`)
          await ctx.sense()
          if (!ctx.sit.surface) await ctx.toSurface()
        }
      }
      if (needFlint()) await ctx.ensureFlint()
      await ctx.refresh()
      if (!ctx.lighter() && ctx.have('flint') && ctx.have('iron_ingot')) await ctx.craft('flint_and_steel')
      await ctx.refresh()
      return ctx.lighter()
    }
    case 'food': {
      await ctx.routeFood()
      // Стадо по карте — дойти к нему, если еды мало (зверей в 40 бл. от места после плавки обычно нет).
      if (s.at && ctx.foodUnits() < 6) { await ctx.sense(); if (!ctx.sit.surface) await ctx.toSurface(); await ctx.routeGo(s.at, 12) }
      const target = Number.isFinite(ctx.routeCookHunger()) ? 4 : 6
      if (ctx.foodUnits() < target) await ctx.routeHunt(40, 60)
      await ctx.routeFood()
      return ctx.foodUnits() >= 4
    }
    case 'water': {
      if (ctx.have('water_bucket')) return true
      if (!ctx.have('bucket')) return false
      await ctx.sense()
      if (!ctx.sit.surface && !s.at) await ctx.toSurface()
      // Вода на виду здесь — сразу в ведро, а не крюк к воде карты (s8-r1-1: от 295,75 назад к 177,51 и снова к лаве 315,18 —
      // ~200 м лишних). ND_ROUTE_WATERNEAR=0 — прежний ход.
      if (s.at && ctx.process.env.ND_ROUTE_WATERNEAR !== '0') {
        await ctx.act('bucket', { fluid: 'water', radius: 24 })
        if (ctx.have('water_bucket')) return true
      }
      if (s.at) { await ctx.routeGo(s.at, 3); if (Number.isFinite(s.at.y)) await ctx.act('goto', { x: s.at.x, y: s.at.y, z: s.at.z, range: 1, timeoutSeconds: 30 }) }
      for (let i = 0; i < 2 && !ctx.have('water_bucket') && !ctx.died; i++) {
        const r = await ctx.act('bucket', { fluid: 'water', radius: 48 })
        if (ctx.have('water_bucket') || (r.detail && r.detail.need) || await waterUnderIce(r)) break
        const w = ctx.routeInfoGet() && ctx.routeInfoGet().ores && (ctx.routeInfoGet().ores.water || []).filter(q => ctx.state.pos && Math.hypot(q.x - ctx.state.pos.x, q.z - ctx.state.pos.z) <= 120 && Math.hypot(q.x - ctx.state.pos.x, q.z - ctx.state.pos.z) > 6 && !(ctx.routeMod.outpostNear && ctx.routeMod.outpostNear(ctx.routeInfoGet(), q, 8)))
          .sort((a, b) => Math.hypot(a.x - ctx.state.pos.x, a.z - ctx.state.pos.z) - Math.hypot(b.x - ctx.state.pos.x, b.z - ctx.state.pos.z))[0]
        if (w) { await ctx.routeGo(w.stand || w, 4); continue }
        if (await farWater()) break
        const e = await ctx.act('explore', { block: 'water', radius: 48, stepDistance: 60, timeoutSeconds: 90 })
        if (!(e.detail && e.detail.found)) break
      }
      return ctx.have('water_bucket') > 0
    }
    case 'castSky': {
      if (ctx.have(/bucket$/) < 1) return false
      if (!(await ctx.routeWater(s.at))) return 'water'
      await ctx.routeBlocks(ctx.routeBlockTarget())
      if (await ctx.castOneAt(s.at)) return true
      if (ctx.have(/bucket$/) < 2) return false
      const r = await ctx.act('portal_natural', { mode: 'run', hint: { x: s.at.x, y: s.at.y, z: s.at.z }, legs: 0, pillar: 10, timeoutSeconds: 480 })
      await ctx.readMemory()
      const d = r.detail || {}
      ctx.rlog(`литьё поверху: ${d.lit ? 'горит' : 'нет'}${d.cast ? `, рама ${d.cast.frame}, черпаков ${d.cast.refills}` : ''}${d.stopped ? `; ${String(d.stopped).slice(0, 120)}` : ''}${d.cast && d.cast.stopped ? `; литьё: ${String(d.cast.stopped).slice(0, 120)}` : ''} (${d.seconds ?? '?'} с)`)
      return !!ctx.known.portal
    }
    case 'castCave': {
      if (ctx.have(/bucket$/) < 1) return false
      if (!(await ctx.routeWater(s.at))) return 'water'
      await ctx.routeBlocks(ctx.routeBlockTarget())
      const L = s.at
      if (!(await ctx.routeGo(L, 10))) return false
      // Лава глубже тела на 5+ — сперва вниз к ней: литьё сверху ищет берег на уровне лавы, путь к нему по рельефу «partial/
      // stuck» и рвётся рефлексом падения (s8-r1-1: 3 захода по 20–40 с «не встал на берег 323,69,17» с высоты 79–88; после
      // колодца вниз — 10/10 за 44 с). ND_ROUTE_CAVEDOWN=0 — прежний заход сверху.
      const deepBelow = ctx.y() > L.y + 4 && ctx.process.env.ND_ROUTE_CAVEDOWN !== '0'
      if (!deepBelow && ctx.process.env.ND_ROUTE_CAVE !== 'descend' && await ctx.castOneAt(L, { maxDig: 80 })) return true
      if (ctx.died) return false
      if (ctx.y() > L.y + 4) await ctx.descend(L.y + 1, { stopAtLava: true, short: ctx.process.env.ND_ROUTE_CAVEDOWN !== '0' })
      if (ctx.died) return false
      if (ctx.fillerCount() < 16) await ctx.routeBlocks(16)
      if (await ctx.castOneAt(ctx.descendLava || L, { maxDig: 80 })) return true
      if (ctx.have(/bucket$/) < 2) return false
      ctx.deepLava = ctx.descendLava || { x: L.x, y: L.y, z: L.z }
      await ctx.deepCast()
      await ctx.readMemory()
      return !!ctx.known.portal
    }
    case 'scoutIron': {
      // Вслепую: разведка построек (structure-search, как ScoutStructures графа: scan 96, ноги к колоколу/сундукам), ≤ 150 с; днём.
      await ctx.sense()
      if (ctx.sit.night || ctx.died) return false
      if (!ctx.sit.surface && !(await ctx.toSurface())) return false
      const search = await require('./structure-search').scoutStructures({
        now: () => ctx.gameClock.now(), position: () => ctx.state.pos,
        scan: async () => { await ctx.act('structure', { mode: 'scan', radius: 96 }) },
        list: async () => (await ctx.act('structure', { mode: 'list' })).detail?.known || [],
        explore: async (direction, timeoutSeconds) => { await ctx.act('explore', { block: 'bell,chest,barrel', radius: 48, stepDistance: 60, direction, timeoutSeconds, dry: true }) },
        move: async (at, timeoutSeconds) => { await ctx.act('goto', { ...at, range: 6, surface: 'strict', timeoutSeconds }) },
        interrupted: () => ctx.died, fact: () => {}, log: m => ctx.rlog(m)
      }, 0, 150000)
      return !!search.found
    }
    case 'lookout': {
      // Вслепую: столб +10 и честный осмотр на 128 бл. (постройки — structures scan; лава/вода/руда — observe), назад вниз.
      await ctx.sense()
      if (!ctx.sit.surface && !(await ctx.toSurface())) return false
      await ctx.sense()
      if (!ctx.sit.surface || ctx.fillerCount() < 4 || ctx.died) return false
      const y0 = ctx.y()
      await ctx.act('tunnel', { direction: 'up', length: 10, timeoutSeconds: 25 })
      await ctx.refresh()
      const up = Math.round(ctx.y() - y0)
      await ctx.act('structure', { mode: 'scan', radius: 128 })
      await ctx.act('observe', { radius: 128 })
      if (up > 0) await ctx.act('tunnel', { direction: 'down', length: up, timeoutSeconds: 30 })
      await ctx.refresh()
      ctx.rlog(`осмотр со столба +${up}: ${ctx.known.lava ? `лава ${ctx.known.lava.x},${ctx.known.lava.y},${ctx.known.lava.z}` : 'лавы не видно'}`)
      return up > 0
    }
    case 'scoutLava': {
      // Вслепую (S8c): лава по виду — ноги разведки поверху (explore видит до 64) с осмотром на 96 бл. после каждой; увиденная
      // (act запоминает known.lava) идёт в план следующего шага как castSky/castCave.
      // Ночью поверху ноги рвёт тактика (s8c-b-v1-1: explore прерван ×15 за 8 мин) — тогда и после пустых ног: под землю, лестницей
      // на 16 и штреки по 24 со слухом (ND_OW_HEAR: лава за стеной в 16 бл.) и взглядом в пещеры; услышанная — в план как пещерная.
      // Успех — НОВАЯ лава (увиденная/услышанная после начала шага), а не та, что уже не вышла (s8c-f-v1-13: «ok за 0 с» по старой).
      const heard0 = ctx.heardLava
      let found = false
      const note = r => { if (noteLava(lavaOf(r))) found = true }
      const seen = () => found || ctx.heardLava !== heard0
      await ctx.sense()
      for (let k = 0; k < 4 && !seen() && !ctx.died && !ctx.sit.night; k++) {
        if (!ctx.sit.surface && !(await ctx.toSurface())) break
        note(await ctx.act('explore', { block: 'lava', radius: 64, stepDistance: 80, timeoutSeconds: 60 }))
        await ctx.refresh()
        if (!seen()) note(await ctx.act('observe', { radius: 96 }))
        await ctx.sense()
      }
      if (!seen() && !ctx.died && ctx.have(/_pickaxe$/) && ctx.process.env.ND_ROUTE_LAVADIG !== '0') {
        ctx.rlog(`лава: ${ctx.sit.night ? 'ночь' : 'поверху не видно'} — вниз, слушаю в штреках`)
        await ctx.act('dig_down', { mode: 'stairs', depth: 16, torchEvery: 0, timeoutSeconds: 120 })
        if (ctx.process.env.ND_OW_HEAR !== '0') await ctx.listenForLava('лестница за лавой')
        for (const dir of ['north', 'east', 'south']) {
          if (seen() || ctx.died) break
          note(await ctx.act('tunnel', { direction: dir, length: 24, torchEvery: 0, timeoutSeconds: 120 }))
          note(await ctx.act('observe', { radius: 32 }))
          if (ctx.process.env.ND_OW_HEAR !== '0') await ctx.listenForLava('штрек за лавой')
        }
      }
      return seen()
    }
    case 'castDeep':
    case 'giveup':
      return 'delegate'
    case 'light': {
      if (!ctx.routeFrame) return false
      if (!ctx.lighter() && !ctx.have('iron_ingot') && ctx.have('raw_iron')) { await ctx.smeltAll('raw_iron', 'iron_ingot', { fetchCoal: false, max: 1 }); await ctx.refresh() }
      if (!ctx.lighter() && !ctx.have('flint')) ctx.flintTries = Math.min(ctx.flintTries, 1)
      if (!ctx.lighter() && !ctx.have('flint') && ctx.have('gravel')) await ctx.routeFlintFromBag()
      if (!ctx.lighter()) { await ctx.ensureFlint(); await ctx.refresh(); if (!ctx.lighter() && ctx.have('flint') && ctx.have('iron_ingot')) await ctx.craft('flint_and_steel'); await ctx.refresh() }
      if (!ctx.lighter()) return false
      await ctx.routeGo(ctx.routeFrame, 6)
      await ctx.act('goto', { x: ctx.routeFrame.x, y: ctx.routeFrame.y, z: ctx.routeFrame.z, range: 4, timeoutSeconds: 40 })
      const lit = await ctx.act('portal', { mode: 'build', timeoutSeconds: 60 })
      await ctx.readMemory()
      ctx.rlog('поджиг рамы ' + ctx.routeFrame.x + ',' + ctx.routeFrame.y + ',' + ctx.routeFrame.z + ': ' + ((lit.detail && lit.detail.lit) || ctx.known.portal ? 'горит' : 'нет'))
      if (ctx.known.portal) { ctx.routeFrame = null; return true }
      return false
    }
    case 'ironStage': {
      const t0 = ctx.gameClock.now()
      for (let k = 0; k < 3 && ctx.have(/bucket$/) < ctx.routeMod.BUCKETS() && ctx.routeMod.ironNeed(ctx.state.inventory || {}) > 0 && ctx.gameClock.now() - t0 < 600000 && !ctx.died; k++) {
        try { await ctx.stageRun('iron')() } catch (e) { if (e.stopCampaign || ctx.manualControl || e.routeBudget || /умер/.test(e.message)) throw e; ctx.rlog(`этап железа: ${e.message}`) }
        await ctx.refresh()
      }
      return ctx.have(/bucket$/) >= ctx.routeMod.BUCKETS() || ctx.routeMod.ironNeed(ctx.state.inventory || {}) === 0
    }
    case 'enter': {
      if (!ctx.known.portal) return false
      await ctx.routeFood({ cookRaw: false })
      if (ctx.foodUnits() < 2) await ctx.quickHunt()
      if (!(await ctx.routeHealToEnter())) return false
      await ctx.enterNether()
      await ctx.refresh()
      if (ctx.dim() === 'the_nether') ctx.routeEntered = true
      return ctx.dim() === 'the_nether'
    }
  }
  return false
}
return { routeSeenRefresh, routeInfoGet, routeGo, routeShaftBackOn, routeRememberShaft, routeFurnaceSupply, routeReturnShaft, routeGoPush, routeBlockTarget, routeBlocks, routeCookedHunger, routeCookHunger, routeFood, routeHunt, routeWater, castOneAt, routeSleep, routeBedLate, routeLeaveOutpost, routeAroundOutpost, routeFlintFromBag, routeRecover, routeHealToEnter, routeStep }
}
