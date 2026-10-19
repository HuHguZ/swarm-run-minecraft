'use strict'
// Шаги маршрута: руда по плану, шахта, плавка, еда, вода.
import type { CampaignRouteContext, RouteState } from './types'
import type { RouteHelpers } from './steps'

export function routeStepsOre (ctx: CampaignRouteContext, rs: RouteState, { ironNow, farSight, waterUnderIce, farWater }: RouteHelpers) {
// case 'ore'
async function stepOre (s) {
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

// case 'mine'
async function stepMine (s) {
  const iron0 = ironNow()
  const need = Math.max(1, ctx.routeMod.ironNeed(ctx.state.inventory || {}))
  await ctx.act('mine', { block: 'iron_ore,deepslate_iron_ore', count: need, radius: 48, timeoutSeconds: 150 })
  if (ironNow() - iron0 < need) await ctx.mineSeenAll('iron_ore,deepslate_iron_ore', 32)
  // Руда на склоне дальше 48 (горы: верхняя жила y 80+) — на виду до 96 бл. (S8c, вслепую).
  for (let k = 0; k < 2 && ironNow() - iron0 < need && !ctx.died; k++) {
    const o = await farSight(/^(deepslate_)?iron_ore$/)
    if (!o) break
    await ctx.routeGo(o, 4)
    const m = await ctx.act('mine', { block: 'iron_ore,deepslate_iron_ore', count: need - (ironNow() - iron0), radius: 16, timeoutSeconds: 90 })
    // Увиденная со столба руда отсюда не видна (грань к склону): к самой клетке — память, где она (S8d, s8d-a-v1-4: «вижу
    // iron_ore в 5 бл.» → «не вижу в 16» ×2).
    if (!(m.detail && m.detail.dug) && Number.isFinite(o.y) && !ctx.died) {
      await ctx.act('goto', { x: o.x, y: o.y, z: o.z, range: 2, timeoutSeconds: 40 })
      await ctx.act('mine', { block: 'iron_ore,deepslate_iron_ore', count: need - (ironNow() - iron0), radius: 8, timeoutSeconds: 60 })
    }
    await ctx.refresh()
  }
  await ctx.refresh()
  return ironNow() - iron0 >= need
}

// case 'smelt'
async function stepSmelt (s) {
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
  await ctx.earlyShield?.()
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

// case 'food'
async function stepFood (s) {
  await ctx.routeFood()
  // Стадо по карте — дойти к нему, если еды мало (зверей в 40 бл. от места после плавки обычно нет).
  if (s.at && ctx.foodUnits() < 6) { await ctx.sense(); if (!ctx.sit.surface) await ctx.toSurface(); await ctx.routeGo(s.at, 12) }
  const target = Number.isFinite(ctx.routeCookHunger()) ? 4 : 6
  if (ctx.foodUnits() < target) await ctx.routeHunt(40, 60)
  await ctx.routeFood()
  return ctx.foodUnits() >= 4
}

// case 'water'
async function stepWater (s) {
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
    const e = await ctx.act('explore', { block: 'water', waterSource: true, radius: 48, stepDistance: 60, timeoutSeconds: 90 })
    if (!(e.detail && e.detail.found)) break
  }
  return ctx.have('water_bucket') > 0
}

return { stepOre, stepMine, stepSmelt, stepFood, stepWater }
}
