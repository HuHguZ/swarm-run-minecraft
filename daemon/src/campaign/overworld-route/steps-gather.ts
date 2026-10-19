'use strict'
// Шаги маршрута: дерево, кровать, камень, руины, деревня, клад, корабль.
import type { CampaignRouteContext, RouteState } from './types'
import type { RouteHelpers } from './steps'

export function routeStepsGather (ctx: CampaignRouteContext, rs: RouteState, { nearTrunk, woodN, farSight, retreatFromGolem, ironNow }: RouteHelpers) {
// case 'wood'
async function stepWood (s) {
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

// case 'bed'
async function stepBed (s) {
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

// case 'stone'
async function stepStone (s) {
  await ctx.stageRun('stone')()
  if (ctx.have(ctx.PICK_STONE) && ctx.fillerCount() < ctx.routeBlockTarget(22, false)) await ctx.routeBlocks(ctx.routeBlockTarget(22, false))
  if (ctx.foodUnits() < 3) { await ctx.sense(); if (ctx.sit.surface) await ctx.routeHunt(32, 45) }
  return ctx.have(ctx.PICK_STONE) > 0
}

// case 'ruin'
async function stepRuin (s) {
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

// case 'village'
async function stepVillage (s) {
  const iron0 = ironNow()
  if (!(await ctx.routeGo(s.at, 24))) return false
  if (ctx.fillerCount() < 6) await ctx.routeBlocks(8)
  let angry = false
  for (let k = 0; k < (angry ? 5 : 3) && ironNow() - iron0 < 3 && !ctx.died; k++) {
    await ctx.sense()
    const g = await ctx.act('golem', { mode: 'kill', radius: 64, timeoutSeconds: 85, ...(angry ? { angry: true } : {}) })
    const d = g.detail || {}
    angry = angry || ((d.hits || 0) > 0 && !d.killed)
    if (d.killed) rs.golemEncounter = null
    else if ((d.hits || 0) > 0 && ctx.state.pos && !rs.golemEncounter) {
      const me = ctx.state.pos, az = me.z - s.at.z, ax = me.x - s.at.x || (az ? 0 : 1), n = Math.hypot(ax, az)
      rs.golemEncounter = { to: { x: Math.round(me.x + ax / n * 40), z: Math.round(me.z + az / n * 40) } }
    }
    ctx.rlog(`голем: ${d.killed ? 'убит' : 'жив'}, ударов ${d.hits ?? 0}${d.blocked ? ` (мимо прицела ${d.blocked})` : ''}, железа +${d.iron ?? 0}${d.hpLost ? `, урон ${d.hpLost}` : ''}${d.stopped ? `; ${d.stopped}` : ''}${Array.isArray(d.steps) ? ` [${d.steps.slice(-5).join(' / ')}]` : ''}`)
    if (d.killed || ctx.died) break
    // The unchanged canopy/fence geometry cannot improve between identical calls.
    // Try the village's other resources; a later view may offer a new supported perch.
    if (d.noSpot && !angry) break
    // S8d (замечание «д»): голем злой и достаёт тело (урон за заход или хп < 16 — столб не держит: s8c-g-s1-1, s2-5, s2-8 — 3
    // смерти, у всех удары по голему с уроном 8–19 до гибели) — уход от деревни, а не следующий бой. Удар голема на normal 7.5–21.5:
    // ещё один заход с таким столбом — ставка жизнью (риск × 3600 с) против копки (~460 с). ND_ROUTE_GOLEM_FREE=1 — прежнее.
    if ((d.hits || 0) > 0 && ((d.hpLost || 0) > 0 || (ctx.state.health ?? 20) < 16) && ctx.process.env.ND_ROUTE_GOLEM_FREE !== '1') {
      await ctx.refresh()
      const to = rs.golemEncounter?.to
      if (to) {
        ctx.rlog(`голем злой и достаёт (хп ${Math.round(ctx.state.health ?? 0)}) — ухожу от деревни к ${to.x},${to.z}`)
        await retreatFromGolem()
      }
      return false
    }
    if (/не вижу/.test(String(d.stopped || ''))) {
      const info = ctx.routeInfoGet()
      const gm = info && info.ores && (info.ores.golems || []).filter(q => Math.hypot(q.x - s.at.x, q.z - s.at.z) <= 96)[0]
      const to = gm || s.at
      await ctx.act('goto', { x: to.x, z: to.z, range: 6, timeoutSeconds: 40 })
      await ctx.act('observe', { radius: 48 })
    }
  }
  if (rs.golemEncounter && !(await retreatFromGolem())) return false
  await ctx.act('structure', { mode: 'explore', kind: 'village', x: s.at.x, z: s.at.z, ...(Number.isFinite(s.at.y) ? { y: s.at.y } : {}), fromMap: true, maxDistance: 120, beds: 1, timeoutSeconds: 100 })
  if (ctx.died) return false
  await ctx.sense()
  if (!ctx.sit.surface && !ctx.sit.night) await ctx.toSurface()
  await ctx.routeFood()
  return ironNow() > iron0 || ctx.foodUnits() >= 6
}

// case 'treasure'
async function stepTreasure (s) {
  const iron0 = ironNow()
  if (!(await ctx.routeGo(s.at, 6))) return false
  await ctx.act('structure', { mode: 'explore', kind: 'buried_treasure', x: s.at.x, z: s.at.z, maxDistance: 40, timeoutSeconds: 120 })
  await ctx.refresh()
  if (ctx.died) return false
  await ctx.sense()
  if (!ctx.sit.surface) await ctx.toSurface()
  return ironNow() > iron0
}

// case 'ship'
async function stepShip (s) {
  const iron0 = ironNow()
  if (!(await ctx.routeGo(s.at, 20))) return false
  await ctx.act('structure', { mode: 'explore', kind: 'shipwreck', x: s.at.x, z: s.at.z, ...(Number.isFinite(s.at.y) ? { y: s.at.y } : {}), fromMap: true, maxDistance: 80, timeoutSeconds: 180 })
  await ctx.refresh()
  await ctx.leaveWater()
  return ironNow() > iron0
}

return { stepWood, stepBed, stepStone, stepRuin, stepVillage, stepTreasure, stepShip }
}
