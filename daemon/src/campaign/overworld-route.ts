type CampaignRouteContext = Record<string, any>

export function createOverworldRoute(ctx: CampaignRouteContext) {
function routeInfoGet () {
  if (ctx.routeInfoV === undefined) ctx.routeInfoV = (ctx.ROUTE && ctx.routeMod && ctx.process.env.ND_WORLD_SEED) ? ctx.routeMod.routeInfo(ctx.process.env.ND_WORLD_SEED) : null
  return ctx.routeInfoV
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

function routeBlockTarget (legacy = 24) {
  return ctx.process.env.ND_ROUTE === '1' && ctx.process.env.ND_ROUTE_QUOTAS !== '0' && ctx.routeMod.BUCKETS() === 1 ? 12 : legacy
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

async function routeWater (near) {
  if (ctx.have('water_bucket') || ctx.have('lava_bucket')) return true
  if (!ctx.have('bucket')) return false
  const r0 = await ctx.act('bucket', { fluid: 'water', radius: 48 })
  if (ctx.have('water_bucket')) return true
  void r0
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
    await ctx.act('bucket', { fluid: 'water', radius: 16 })
    if (ctx.have('water_bucket')) { ctx.rlog(`вода по карте у ${w.x},${w.y},${w.z}`); return true }
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
    if (!ctx.died) await ctx.rest()
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

async function routeStep (s) {
  await ctx.refresh()
  const ironNow = () => ctx.have('iron_ingot') + ctx.have('raw_iron') + Math.floor(ctx.have('iron_nugget') / 9)
  switch (s.kind) {
    case 'wood': {
      if (ctx.process.env.ND_ROUTE_STARTER_CHECKPOINT !== '0' && ctx.have(/_pickaxe$/) && ctx.have('crafting_table')) return true
      await ctx.routeLeaveOutpost(s.at || null)
      if (s.at && !(await ctx.routeGo(s.at, 6))) return false
      if (s.src === 'mapwood' && Number.isFinite(s.at?.y) && !(await ctx.act('goto', { x: s.at.x, y: s.at.y, z: s.at.z, range: 2, surface: 'strict', timeoutSeconds: 60 })).status.match(/^done$/)) return false
      if (s.src === 'village' && !ctx.died) {
        await ctx.act('mine', { block: 'any_log', count: 4, radius: 32, timeoutSeconds: 90 })
        await ctx.refresh()
        if (ctx.woodNow() < 3) await ctx.act('mine', { block: 'any_planks', count: 12 - Math.floor(ctx.have(/_planks$/)), radius: 32, timeoutSeconds: 90 })
        await ctx.refresh()
        ctx.rlog(`дерево из деревни: брёвен ${ctx.have(ctx.LOGS)}, досок ${ctx.have(/_planks$/)}`)
      }
      if (s.src === 'mapwood') {
        // ND_ROUTE_WOODN=N — брёвен с рощи N (спидраннер берёт 5–6; было 12: s8-r1-1 — 9 брёвен за 75 с до таймаута); доски дома — 12.
        await ctx.act('mine', { block: 'any_log,any_planks', count: s.in ? 12 : woodN(), radius: 12, timeoutSeconds: 75 })
        await ctx.refresh()
        // Тело над рощей (на кронах: goto «done» на y 91 при стволах на 83, s8-r2-7) — брёвен сквозь листву не видно: вниз к
        // уровню стволов лесенкой и ещё раз, а не к следующей роще в 60 м.
        if (ctx.woodNow() < 3 && Number.isFinite(s.at?.y) && ctx.y() > s.at.y + 3 && !ctx.died && ctx.process.env.ND_ROUTE_WOODDOWN !== '0') {
          ctx.rlog(`над рощей: тело y ${Math.round(ctx.y())}, стволы ${s.at.y} — вниз к ним`)
          await ctx.act('dig_down', { mode: 'stairs', depth: Math.min(8, Math.round(ctx.y() - s.at.y)), torchEvery: 0, timeoutSeconds: 40 })
          await ctx.act('mine', { block: 'any_log', count: woodN(), radius: 12, timeoutSeconds: 75 })
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
      const want = woodN()
      const seen = new Set()
      for (let k = 0; k < 8 && ctx.woodNow() < want && trees.length && !ctx.died; k++) {
        await ctx.act('mine', { block: 'any_log', count: want - ctx.woodNow(), radius: 32, timeoutSeconds: 120 })
        await ctx.refresh()
        if (ctx.woodNow() >= want) break
        const me = ctx.state.pos
        const pick = band => trees.filter(q => !seen.has(`${q.x},${q.z}`) && me && Math.hypot(q.x - me.x, q.z - me.z) > 6 && Math.hypot(q.x - me.x, q.z - me.z) <= (band > 8 ? 120 : 200) && Math.abs(q.y - (me.y + 3)) <= band)
          .sort((a, b) => Math.hypot(a.x - me.x, a.z - me.z) - b.n * 2 - Math.hypot(b.x - me.x, b.z - me.z) + a.n * 2)[0]
        const t = pick(8) || pick(25)
        if (!t) break
        seen.add(`${t.x},${t.z}`)
        await ctx.routeGo(t, 4)
      }
      await ctx.stageRun('wood')()
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
      if (ctx.have(ctx.PICK_STONE) && ctx.fillerCount() < ctx.routeBlockTarget(22)) await ctx.routeBlocks(ctx.routeBlockTarget(22))
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
        const g = await ctx.act('golem', { mode: 'kill', radius: 64, timeoutSeconds: 85 })
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
              await ctx.act('mine', { block: 'gravel', count: ctx.process.env.ND_ROUTE_FLINTBAG !== '0' ? 2 : 12, radius: 5, timeoutSeconds: 45 })
              await ctx.refresh()
              if (ctx.process.env.ND_ROUTE_FLINTBAG !== '0' && needFlint() && ctx.have('gravel')) await ctx.routeFlintFromBag()
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
        if (ctx.have('water_bucket') || (r.detail && r.detail.need)) break
        const w = ctx.routeInfoGet() && ctx.routeInfoGet().ores && (ctx.routeInfoGet().ores.water || []).filter(q => ctx.state.pos && Math.hypot(q.x - ctx.state.pos.x, q.z - ctx.state.pos.z) <= 120 && Math.hypot(q.x - ctx.state.pos.x, q.z - ctx.state.pos.z) > 6 && !(ctx.routeMod.outpostNear && ctx.routeMod.outpostNear(ctx.routeInfoGet(), q, 8)))
          .sort((a, b) => Math.hypot(a.x - ctx.state.pos.x, a.z - ctx.state.pos.z) - Math.hypot(b.x - ctx.state.pos.x, b.z - ctx.state.pos.z))[0]
        if (w) { await ctx.routeGo(w.stand || w, 4); continue }
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
return { routeInfoGet, routeGo, routeShaftBackOn, routeRememberShaft, routeFurnaceSupply, routeReturnShaft, routeGoPush, routeBlockTarget, routeBlocks, routeCookedHunger, routeCookHunger, routeFood, routeHunt, routeWater, castOneAt, routeSleep, routeBedLate, routeLeaveOutpost, routeAroundOutpost, routeFlintFromBag, routeRecover, routeHealToEnter, routeStep }
}
