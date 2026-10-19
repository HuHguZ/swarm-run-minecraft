'use strict'
// Шаг маршрута «кремень»: гравий по плану и на виду, кремень, огниво.
import type { CampaignRouteContext, RouteState } from './types'
import type { RouteHelpers } from './steps'

export function routeStepsFlint (ctx: CampaignRouteContext, rs: RouteState, { needFlint, farSight, mineRemembered }: RouteHelpers) {
// case 'flint'
async function stepFlint (s) {
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
  // Сухого гравия нет — один блок со дна реки/озера (S8d): гравию воды копка ×5 — ~4 с за блок, а одного гравия хватает:
  // ставить и ломать его, пока не выпадет кремень (flint_grind, 10 % за раз). ND_ROUTE_WETGRAVEL=0 — выкл.
  if (needFlint() && !ctx.have('gravel') && !ctx.died && ctx.process.env.ND_ROUTE_WETGRAVEL !== '0') {
    await ctx.sense()
    if (ctx.sit.surface) {
      const g = await ctx.act('mine', { block: 'gravel', count: 1, radius: 32, timeoutSeconds: 60 })
      await ctx.refresh()
      if (ctx.have('gravel')) { ctx.rlog(`кремень: гравий со дна (${g.status})`); await ctx.leaveWater(); await ctx.routeFlintFromBag() }
    }
  }
  // S8d: под землёй — сперва гравий, который глаза видели (стенка колодца/штрека), потом наверх: поверху гравий чаще (берега, дно
  // рек — шаг выше), а штреки за ним у y 10 — 0 из 4 (s8d-b-v1-2: 2 мин штреков без гравия). ND_ROUTE_FLINTUP=0 — прежнее.
  if (needFlint() && !ctx.have('gravel') && !ctx.died && ctx.process.env.ND_ROUTE_FLINTUP !== '0') {
    await ctx.sense()
    if (!ctx.sit.surface) {
      await mineRemembered(() => (needFlint() && !ctx.have('gravel') ? 1 : 0), 48, ['gravel'])
      if (needFlint() && ctx.have('gravel')) await ctx.routeFlintFromBag()
      await ctx.sense()
      if (needFlint() && !ctx.have('gravel') && !ctx.sit.surface && !ctx.died) {
        await ctx.toSurface()
        await ctx.sense()
        for (let k = 0; k < 2 && needFlint() && !ctx.have('gravel') && ctx.sit.surface && !ctx.died; k++) {
          const g = await farSight(/^gravel$/)
          if (!g) { const w = await ctx.act('mine', { block: 'gravel', count: 1, radius: 32, timeoutSeconds: 60 }); await ctx.refresh(); if (ctx.have('gravel')) await ctx.leaveWater(); void w; break }
          await ctx.routeGo(g, 4)
          await ctx.act('mine', { block: 'gravel', count: 2, radius: 16, timeoutSeconds: 60 })
          await ctx.refresh()
        }
        if (needFlint() && ctx.have('gravel')) await ctx.routeFlintFromBag()
      }
    }
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

return { stepFlint }
}
