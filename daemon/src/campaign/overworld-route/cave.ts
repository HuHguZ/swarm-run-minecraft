'use strict'
// Пещеры маршрута: устье, руда из памяти, «внутри ли пещеры», вход в пещеру.
import type { CampaignRouteContext, RouteState } from './types'
import type { routeSeen } from './seen'

export function routeCave (ctx: CampaignRouteContext, rs: RouteState, { lookAround }: ReturnType<typeof routeSeen>) {
// S8d: вход в пещеру/овраг, видимый сверху (со столба осмотра): луч глаз вниз-вбок уходит глубоко ниже рельефа (первая
// непрозрачная клетка на 8+ ниже ног стоящего на земле), не сквозь воду и дальше 6 бл. — дыра в земле. Ближняя — цель шага «пещера».
async function findCaveMouth (groundY) {
  const hits = []
  for (const pitch of [12, 20, 30, 45, 60]) {
    for (let yaw = 0; yaw < 360; yaw += 15) {
      let sf = null
      try { const r = await ctx.call('perceive', { mode: 'surface', yaw, pitch, maxDist: 96 }); ctx.acceptResult(r); sf = r && r.detail ? r.detail.surface : null } catch {}
      if (!sf || sf.water || !sf.pos || /water|lava|leaves|_log$/.test(String(sf.name))) continue
      const flat = sf.dist * Math.cos(pitch * Math.PI / 180)
      if (flat > 6 && sf.pos.y <= groundY - 8) hits.push({ x: sf.pos.x, y: sf.pos.y, z: sf.pos.z, flat: Math.round(flat), depth: Math.round(groundY - sf.pos.y) })
    }
  }
  hits.sort((a, b) => a.flat - b.flat)
  return hits[0] || null
}
// S8d: руда, которую глаза уже видели (стенка колодца, щель в мелкую пещеру по пути, конец штрека), а сейчас отсюда не видно, —
// к ней по памяти и копать (честно: место из увиденного). Не дальше maxDist и не глубже/выше 12 от тела.
async function mineRemembered (need, maxDist = 32, names = ['iron_ore', 'deepslate_iron_ore']) {
  let got = 0
  if (ctx.process.env.ND_ROUTE_ORE_MEMORY === '0' || need() <= 0) return 0
  let seen = []
  try { const r = await ctx.call('perceive', { mode: 'seen', block: names, max: 6, maxDist }); ctx.acceptResult(r); seen = (r && r.detail && r.detail.seen) || [] } catch {}
  const me = ctx.state.pos
  for (const o of seen.filter(q => me && Math.abs(q.y - me.y) <= 12).slice(0, 3)) {
    if (need() <= 0 || ctx.died) break
    const before = need()
    await ctx.act('goto', { x: o.x, y: o.y, z: o.z, range: 2, timeoutSeconds: 30 })
    await ctx.act('mine', { block: names.join(','), count: need(), radius: 6, timeoutSeconds: 45 })
    await ctx.refresh()
    got += Math.max(0, before - need())
  }
  if (got) ctx.rlog(`${names[0]} по памяти глаз: +${got}`)
  return got
}
// В пещере: на уровне взгляда хотя бы 2 стороны открыты на 8+ бл. (колодец 1×1 и штрек — 0–1).
// Под землёй: потолок над головой в 24 бл. (луч вверх) или тело на 8+ ниже места, откуда шаг начался (овраг под открытым небом);
// поверху на равнине стороны тоже открыты (s8d-b-v1-1: «вошёл на y 66» — 224 с «пещеры» по снежной равнине).
let caveTopY = null
async function inCave () {
  const open = (await lookAround([0], 16)).filter(r => r.dist >= 8).length >= 2
  if (!open) return false
  if (caveTopY !== null && ctx.y() <= caveTopY - 8) return true
  let up = null
  try { const r = await ctx.call('perceive', { mode: 'surface', yaw: 0, pitch: -90, maxDist: 24 }); ctx.acceptResult(r); up = r && r.detail ? r.detail.surface : null } catch {}
  return !!up
}
// S8d: вниз до пещеры. Колодец (tunnel down) встаёт над пустотой «глубже 3» — потолок пещеры: пробить его и спрыгнуть с оплатой
// хп (≤ 5, при хп ≥ 14: прыжок 4–8 бл. — 1–5 урона), не вышло — лесенкой вбок-вниз (вскрывает пещеру сбоку); вода/лава под
// колодцем — штрек вбок и снова колодец. Дошёл до y ≤ 10 без пещеры — нет.
async function caveEnter (left) {
  const dirs = ['north', 'east', 'south', 'west']
  caveTopY = ctx.y()
  // Вход, видный со столба, — сперва туда: к краю и вниз к дну дыры (pathfinder копает/ставит ступени сам).
  const M = rs.caveMouth
  rs.caveMouth = null
  if (M && !ctx.died) {
    ctx.rlog(`пещера: к входу ${M.x},${M.y},${M.z} (видел со столба)`)
    if (await ctx.routeGo({ x: M.x, z: M.z }, 6)) {
      await ctx.act('goto', { x: M.x, y: M.y + 1, z: M.z, range: 2, timeoutSeconds: 60 })
      await ctx.refresh()
      if (ctx.died) return false
      if (ctx.y() <= M.y + 4 && await inCave()) return true
      ctx.rlog(`пещера: у входа ${M.x},${M.y},${M.z} просвета нет (y ${Math.round(ctx.y())}) — колодцем отсюда`)
    }
  }
  for (let k = 0; k < 5 && left() > 60000 && !ctx.died; k++) {
    await ctx.refresh()
    if (k > 0 && await inCave()) return true
    if (ctx.y() <= 10) return false
    const from = ctx.state.pos && { ...ctx.state.pos }
    const sh = await ctx.act('tunnel', { direction: 'down', length: Math.max(3, Math.min(64, Math.round(ctx.y() - 10))), timeoutSeconds: 150 })
    if (ctx.died) return false
    if (from && k === 0) ctx.routeRememberShaft(from)
    await ctx.refresh()
    const why = String((sh.detail && sh.detail.stopped) || sh.error || '')
    if (/пещера/.test(why)) {
      const pay = Math.max(0, Math.min(5, Math.floor((ctx.state.health ?? 20) - 14)))
      const y0 = ctx.y()
      await ctx.act('dig_down', { mode: 'shaft', depth: 2, maxFallHp: pay, timeoutSeconds: 30 })
      await ctx.refresh()
      if (ctx.died) return false
      if (ctx.y() < y0 - 1.5 && await inCave()) return true
      await ctx.act('dig_down', { mode: 'stairs', depth: 8, torchEvery: 0, direction: dirs[k % 4], maxFallHp: pay, timeoutSeconds: 60 })
      await ctx.refresh()
      if (ctx.died) return false
      if (await inCave()) return true
      continue
    }
    if (/вода|лава|не идёт|не копается/.test(why)) { await ctx.act('tunnel', { direction: dirs[k % 4], length: 6, torchEvery: 0, timeoutSeconds: 40 }); continue }
    if (await inCave()) return true
    if (!why) return false
  }
  return false
}
return { findCaveMouth, mineRemembered, inCave, caveEnter }
}
