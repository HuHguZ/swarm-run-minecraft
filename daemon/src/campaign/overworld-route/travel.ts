'use strict'
// Дорога маршрута: отрезки поверху, своя шахта, печь у шахты, отрезок с напором, столбы и блоки.
import type { CampaignRouteContext } from './types'

export function routeTravel (ctx: CampaignRouteContext) {

async function routeGo (at, range = 12) {
  if (!at || !ctx.state.pos) return false
  await ctx.sense()
  if (ctx.sit.inWater) { await ctx.leaveWater(); await ctx.sense(); if (ctx.sit.inWater && ctx.process.env.ND_ROUTE_SHORE !== '0') return false }
  // S8d: под землёй, цель с высотой рядом (пещерная лава/вода в 48 бл., не выше на 10+) — к ней здесь, без подъёма наверх и
  // спуска обратно. ND_ROUTE_UNDERGO=0 — прежнее (сперва наверх).
  if (!ctx.sit.surface && Number.isFinite(at.y) && ctx.state.pos && Math.hypot(at.x - ctx.state.pos.x, at.y - ctx.state.pos.y, at.z - ctx.state.pos.z) <= 48 &&
      at.y < ctx.state.pos.y + 10 && ctx.process.env.ND_ROUTE_UNDERGO !== '0') {
    const g = await ctx.act('goto', { x: at.x, y: at.y + 1, z: at.z, range, timeoutSeconds: 60 })
    await ctx.refresh()
    if (g.status === 'done' || (ctx.state.pos && Math.hypot(at.x - ctx.state.pos.x, at.z - ctx.state.pos.z) <= range + 4)) return true
  }
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
  const next = (require('../../movement') as typeof import('../../movement')).shaftFromDescent(from, ctx.state.pos)
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
return { routeGo, woodN, routeShaftBackOn, routeRememberShaft, routeFurnaceSupply, routeReturnShaft, routeGoPush, routeBlockTarget, routeBlocks }
}
