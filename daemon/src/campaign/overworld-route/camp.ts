'use strict'
// Привалы маршрута: сон и поздняя кровать, обход аванпоста, кремень из гравия, восстановление, лечение перед входом в Ад.
import type { CampaignRouteContext } from './types'

export function routeCamp (ctx: CampaignRouteContext) {

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
return { routeSleep, routeBedLate, routeLeaveOutpost, routeAroundOutpost, needFlint, routeFlintFromBag, routeRecover, routeHealToEnter }
}
