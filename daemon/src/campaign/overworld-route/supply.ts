'use strict'
// Снабжение маршрута: еда и охота, вода (подо льдом, вдали), литьё портала у лавы, ствол дерева вплотную.
import type { CampaignRouteContext } from './types'

export function routeSupply (ctx: CampaignRouteContext) {

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
  // Запомненное глубоко под телом (видел из штрека/колодца) поверху не достать — ход к x,z над ним впустую (S8d, s8d-a-v1-2:
  // гравий y 46 из штрека, тело на y 68 — 4 захода «вижу gravel — к нему» → «не вижу gravel»).
  const bl = (Array.isArray(o.detail && o.detail.blocks) ? o.detail.blocks : []).filter(b => b && names.test(b.name) && b.nearest &&
    !(me && Math.hypot(b.nearest.x - me.x, b.nearest.z - me.z) < 3) && !(b.remembered && me && b.nearest.y < me.y - 6)).sort((a, b) => a.dist - b.dist)[0]
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
  const e = await ctx.act('explore', { block: 'water', waterSource: true, radius: 48, stepDistance: 60, timeoutSeconds: 90 })
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
return { routeCookedHunger, routeCookHunger, canCook, routeFood, routeHunt, waterUnderIce, farSight, farWater, routeWater, castOneAt, nearTrunk }
}
