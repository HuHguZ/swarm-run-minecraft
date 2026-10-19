'use strict'
// Шаги маршрута: литьё поверху и в пещере, разведка железа и лавы, вышка, пещера, поджиг, этап железа, вход в Ад.
import type { CampaignRouteContext, RouteState } from './types'
import type { RouteHelpers } from './steps'

export function routeStepsCast (ctx: CampaignRouteContext, rs: RouteState, { hasShield, needFlint, farSight, findCaveMouth, LAKES, seenLakes, noteLava, lavaOf, mineRemembered, caveEnter, lookAround, ironNow }: RouteHelpers) {
// case 'castSky'
async function stepCastSky (s) {
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

// case 'castCave'
async function stepCastCave (s) {
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

// case 'scoutIron'
async function stepScoutIron (s) {
  // Вслепую: разведка построек (structure-search, как ScoutStructures графа: scan 96, ноги к колоколу/сундукам), ≤ 150 с; днём.
  await ctx.sense()
  if (ctx.died) return false
  // Ночью — цена отрезка поверху против подземной альтернативы (S8d, замечание «г»), а не отказ.
  if (ctx.sit.night) {
    const p = ctx.routeMod.scoutLegPrice({ night: true, hp: ctx.state.health ?? 20, shield: hasShield(), legS: 150 })
    ctx.rlog(`разведка построек ночью: ${p.surface} с (риск ${p.risk}) против копки ${p.under} с — ${p.pick === 'surface' ? 'иду' : 'не иду'}`)
    if (p.pick !== 'surface' || ctx.process.env.ND_ROUTE_NIGHTPRICE === '0') return false
  }
  if (!ctx.sit.surface && !(await ctx.toSurface())) return false
  const search = await (require('../structure-search') as typeof import('../structure-search')).scoutStructures({
    now: () => ctx.gameClock.now(), position: () => ctx.state.pos,
    scan: async () => { await ctx.act('structure', { mode: 'scan', radius: 96 }) },
    list: async () => (await ctx.act('structure', { mode: 'list' })).detail?.known || [],
    explore: async (direction, timeoutSeconds) => (await ctx.act('explore', { block: 'bell,chest,barrel', radius: 48, stepDistance: 60, direction, timeoutSeconds, dry: true, surface: true, unlootedContainers: true })).detail,
    loot: async (at, timeoutSeconds) => Object.values((await ctx.act('loot', { ...at, visibleOnly: true, timeoutSeconds })).detail?.took || {}).some(n => Number(n) > 0),
    move: async (at, timeoutSeconds) => { await ctx.act('goto', { ...at, range: 6, surface: 'strict', timeoutSeconds }) },
    interrupted: () => ctx.died, fact: () => {}, log: m => ctx.rlog(m)
  }, 0, 150000)
  return !!search.found
}

// case 'lookout'
async function stepLookout (s) {
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
  if (ctx.process.env.ND_ROUTE_CAVEMOUTH !== '0' && ctx.process.env.ND_ROUTE_CAVE !== '0' && !ctx.died) {
    rs.caveMouth = await findCaveMouth(y0)
    if (rs.caveMouth) ctx.rlog(`со столба: вход в пещеру/овраг у ${rs.caveMouth.x},${rs.caveMouth.y},${rs.caveMouth.z} (${rs.caveMouth.flat} бл., глубина ${rs.caveMouth.depth})`)
  }
  if (up > 0) await ctx.act('tunnel', { direction: 'down', length: up, timeoutSeconds: 30 })
  await ctx.refresh()
  ctx.rlog(`осмотр со столба +${up}: ${ctx.known.lava ? `лава ${ctx.known.lava.x},${ctx.known.lava.y},${ctx.known.lava.z}` : 'лавы не видно'}`)
  // S8d: кремень — гравий на виду рядом (≤ 48 бл.) берётся сейчас, до спуска за железом (потом он за горой/под землёй: шаг flint
  // вслепую 3 из 10 в s8c-g). ND_ROUTE_EARLYGRAVEL=0 — выкл.
  if (needFlint() && !ctx.have('gravel') && ctx.process.env.ND_ROUTE_EARLYGRAVEL !== '0' && !ctx.died) {
    const g = await farSight(/^gravel$/, 48)
    if (g) { await ctx.routeGo(g, 4); await ctx.act('mine', { block: 'gravel', dry: true, count: 4, radius: 12, timeoutSeconds: 40 }); await ctx.refresh() }
  }
  return up > 0
}

// case 'scoutLava'
async function stepScoutLava (s) {
  // Вслепую (S8c): лава по виду — ноги разведки поверху (explore видит до 64) с осмотром на 96 бл. после каждой; увиденная
  // (act запоминает known.lava) идёт в план следующего шага как castSky/castCave.
  // Ночью поверху ноги рвёт тактика (s8c-b-v1-1: explore прерван ×15 за 8 мин) — тогда и после пустых ног: под землю, лестницей
  // на 16 и штреки по 24 со слухом (ND_OW_HEAR: лава за стеной в 16 бл.) и взглядом в пещеры; услышанная — в план как пещерная.
  // Успех — НОВАЯ лава (увиденная/услышанная после начала шага), а не та, что уже не вышла (s8c-f-v1-13: «ok за 0 с» по старой).
  const heard0 = ctx.heardLava
  let found = false
  // S8d: с озёрами успех — годное озеро в памяти глаз (не одиночная лава, литьё у неё не выходит); без них — новая лава.
  const note = async r => { if (LAKES()) { if ((await seenLakes()).length) found = true } else if (noteLava(lavaOf(r))) found = true }
  const seen = () => found || ctx.heardLava !== heard0
  // Ночью поверху — цена, а не запрет (S8d, замечание «г»): отрезок поверху против подземного поиска со слухом (route.scoutLegPrice).
  const surfaceLeg = () => {
    const p = ctx.routeMod.scoutLegPrice({ night: !!ctx.sit.night, hp: ctx.state.health ?? 20, shield: hasShield() })
    if (ctx.sit.night) ctx.rlog(`лава ночью: отрезок поверху ${p.surface} с (риск ${p.risk}) против подземного ${p.under} с — ${p.pick === 'surface' ? 'поверху' : 'под землю'}`)
    return ctx.process.env.ND_ROUTE_NIGHTPRICE === '0' ? !ctx.sit.night : p.pick === 'surface'
  }
  await ctx.sense()
  for (let k = 0; k < 4 && !seen() && !ctx.died && surfaceLeg(); k++) {
    if (!ctx.sit.surface && !(await ctx.toSurface())) break
    await note(await ctx.act('explore', { block: 'lava', radius: 64, stepDistance: 80, timeoutSeconds: 60 }))
    await ctx.refresh()
    if (!seen()) await note(await ctx.act('observe', { radius: 96 }))
    await ctx.sense()
  }
  if (!seen() && !ctx.died && ctx.have(/_pickaxe$/) && ctx.process.env.ND_ROUTE_LAVADIG !== '0') {
    ctx.rlog(`лава: ${ctx.sit.night ? 'ночь' : 'поверху не видно'} — вниз, слушаю в штреках`)
    await ctx.act('dig_down', { mode: 'stairs', depth: 16, torchEvery: 0, timeoutSeconds: 120 })
    if (ctx.process.env.ND_OW_HEAR !== '0') await ctx.listenForLava('лестница за лавой')
    for (const dir of ['north', 'east', 'south']) {
      if (seen() || ctx.died) break
      await note(await ctx.act('tunnel', { direction: dir, length: 24, torchEvery: 0, timeoutSeconds: 120 }))
      await note(await ctx.act('observe', { radius: 32 }))
      if (ctx.process.env.ND_OW_HEAR !== '0') await ctx.listenForLava('штрек за лавой')
    }
  }
  return seen()
}

// case 'cave'
async function stepCave (s) {
  // S8d: железо вслепую, как игрок, — колодцем вниз до пещеры, войти в неё и брать руду в её стенах по виду (observe —
  // луч глаз, память), идя по пещере по самым длинным просветам (лучи глаз); попутно гравий (кремень), лава и вода в памяти.
  const iron0 = ironNow()
  const need = () => ctx.routeMod.ironNeed(ctx.state.inventory || {})
  const t0 = ctx.gameClock.now()
  const left = () => (s.budget || 240) * 1000 - (ctx.gameClock.now() - t0)
  if (!ctx.have(ctx.PICK_STONE)) return false
  const entered = await caveEnter(left)
  if (ctx.died) return false
  if (!entered) {
    await mineRemembered(need)
    ctx.rlog(`пещера: не нашлась (y ${Math.round(ctx.y())})${need() > 0 ? ' — дальше этап железа' : ', железо — по памяти глаз'}`)
    return need() === 0
  }
  ctx.rlog(`пещера: вошёл на y ${Math.round(ctx.y())}`)
  const visited = []
  let legs = 0
  let lookedFor = 0
  for (; legs < 12 && left() > 15000 && !ctx.died; legs++) {
    await ctx.refresh()
    const o = await ctx.act('observe', { radius: 32 })
    const bl = Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []
    const sees = re => bl.some(b => b && re.test(b.name) && !b.remembered)
    if (need() > 0 && sees(/^(deepslate_)?iron_ore$/)) {
      const before = ironNow()
      await ctx.act('mine', { block: 'iron_ore,deepslate_iron_ore', count: need(), radius: 32, timeoutSeconds: 90 })
      await ctx.refresh()
      if (ironNow() > before) { legs--; if (need() > 0) continue }
    }
    if (needFlint() && !ctx.have('gravel') && sees(/^gravel$/)) { await ctx.act('mine', { block: 'gravel', count: 3, radius: 24, dry: true, timeoutSeconds: 45 }); await ctx.refresh() }
    if (need() === 0 || ctx.died) break
    // Дальше по пещере: лучи глаз по 12 сторонам на уровне взгляда и вниз на 25°, самый длинный просвет, не туда, где был.
    const me = ctx.state.pos
    if (!me) break
    visited.push({ x: me.x, y: me.y, z: me.z })
    const rays = await lookAround()
    lookedFor++
    const eye = { x: me.x, y: me.y + 1.62, z: me.z }
    const scored = rays.map(r => {
      const d = Math.min(20, r.dist - 1.5)
      const v = { x: -Math.sin(r.yaw * Math.PI / 180) * Math.cos(r.pitch * Math.PI / 180), y: -Math.sin(r.pitch * Math.PI / 180), z: Math.cos(r.yaw * Math.PI / 180) * Math.cos(r.pitch * Math.PI / 180) }
      const end = { x: eye.x + v.x * d, y: eye.y + v.y * d, z: eye.z + v.z * d }
      const been = visited.some(p => Math.hypot(p.x - end.x, p.z - end.z) < 8)
      return { ...r, d, end, score: d - (been ? 30 : 0) }
    }).filter(r => r.d >= 6).sort((a, b) => b.score - a.score)
    const go = scored[0]
    if (!go || go.score < 0) { ctx.rlog(`пещера: дальше просвета нет (отрезков ${legs})`); break }
    await ctx.act('goto', { x: Math.round(go.end.x), y: Math.round(go.end.y - 1.62), z: Math.round(go.end.z), range: 3, timeoutSeconds: 30 })
  }
  if (need() > 0 && !ctx.died) await mineRemembered(need, 24)
  await ctx.refresh()
  ctx.rlog(`пещера: железа +${ironNow() - iron0} (нужно ещё ${need()}), отрезков ${legs}, осмотров ${lookedFor}, ${Math.round((ctx.gameClock.now() - t0) / 1000)} с`)
  return need() === 0
}

// case 'light'
async function stepLight (s) {
  if (!ctx.routeFrame) return false
  if (!ctx.lighter() && !ctx.have('iron_ingot') && ctx.have('raw_iron')) { await ctx.smeltAll('raw_iron', 'iron_ingot', { fetchCoal: false, max: 1 }); await ctx.refresh() }
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

// case 'ironStage'
async function stepIronStage (s) {
  const t0 = ctx.gameClock.now()
  for (let k = 0; k < 3 && ctx.have(/bucket$/) < ctx.routeMod.BUCKETS() && ctx.routeMod.ironNeed(ctx.state.inventory || {}) > 0 && ctx.gameClock.now() - t0 < 600000 && !ctx.died; k++) {
    try { await ctx.stageRun('iron')() } catch (e) { if (e.stopCampaign || ctx.manualControl || e.routeBudget || /умер/.test(e.message)) throw e; ctx.rlog(`этап железа: ${e.message}`) }
    await ctx.refresh()
    if (ctx.routeMod.ironNeed(ctx.state.inventory || {}) > 0 && ctx.have(/bucket$/) < ctx.routeMod.BUCKETS() && !ctx.died) await mineRemembered(() => ctx.routeMod.ironNeed(ctx.state.inventory || {}))
  }
  return ctx.have(/bucket$/) >= ctx.routeMod.BUCKETS() || ctx.routeMod.ironNeed(ctx.state.inventory || {}) === 0
}

// case 'enter'
async function stepEnter (s) {
  if (!ctx.known.portal) return false
  await ctx.routeFood({ cookRaw: false })
  if (ctx.foodUnits() < 2) await ctx.quickHunt()
  if (!(await ctx.routeHealToEnter())) return false
  await ctx.enterNether()
  await ctx.refresh()
  if (ctx.dim() === 'the_nether') ctx.routeEntered = true
  return ctx.dim() === 'the_nether'
}

return { stepCastSky, stepCastCave, stepScoutIron, stepLookout, stepScoutLava, stepCave, stepLight, stepIronStage, stepEnter }
}
