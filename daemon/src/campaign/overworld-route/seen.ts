'use strict'
// Маршрут вслепую по увиденному: план из seenInfo, лава и озёра глазами, осмотр вокруг, обновление плана перед шагом.
import type { CampaignRouteContext } from './types'

export function routeSeen (ctx: CampaignRouteContext) {
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
// Литьё у лавы не вышло (шаг lava:… в avoid) — эта лава и её озеро (в 8 бл.: клетка-представитель озера меняется, когда глаза
// видят больше его зеркала) больше не цель.
const lavaAvoided = q => {
  if (!q || !ctx.routeAvoid) return false
  for (const id of ctx.routeAvoid) {
    const m = /^lava:(?:sky|cave):(-?\d+),(-?\d+)$/.exec(String(id))
    if (m && Math.hypot(+m[1] - q.x, +m[2] - q.z) <= 8) return true
  }
  return false
}
// S8d: озёра лавы из памяти глаз (route.lavaLakes) — цель литья одним ведром, а не одиночная ближняя клетка лавы.
// ND_ROUTE_LAKES=0 — прежний выбор (ближняя увиденная лава); ND_ROUTE_LAKE_MIN — клеток зеркала (умолчание 5).
const LAKES = () => ctx.process.env.ND_ROUTE_LAKES !== '0'
const LAKE_MIN = () => { const n = Number(ctx.process.env.ND_ROUTE_LAKE_MIN); return Number.isFinite(n) && n > 0 ? n : 5 }
async function seenLakes () {
  let cells = []
  try {
    const r = await ctx.call('perceive', { mode: 'seen', block: 'lava', max: 800, maxDist: 220 })
    ctx.acceptResult(r)
    cells = (r && r.detail && Array.isArray(r.detail.seen)) ? r.detail.seen : []
  } catch {}
  return ctx.routeMod.lavaLakes(cells).filter(l => l.level >= LAKE_MIN() && !lavaAvoided(l))
}
const hasShield = () => ctx.have('shield') > 0 || !!(ctx.state.offHand && /shield/.test(JSON.stringify(ctx.state.offHand)))
// S8d: просветы вокруг — лучи глаз (perceive surface: первая непрозрачная клетка) по 12 сторонам на уровне взгляда и вниз на 25°.
async function lookAround (pitches = [0, 25], maxDist = 32) {
  const out = []
  for (const pitch of pitches) {
    for (let yaw = 0; yaw < 360; yaw += 30) {
      let sf = null
      try { const r = await ctx.call('perceive', { mode: 'surface', yaw, pitch, maxDist }); ctx.acceptResult(r); sf = r && r.detail ? r.detail.surface : null } catch {}
      out.push({ yaw, pitch, dist: sf ? sf.dist : maxDist, hit: sf ? sf.name : null })
    }
  }
  return out
}
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
  // Строка стопа штрека («лава у/на x,y,z») — чутьё безопасности, оно только отказывает копать (S8d, замечание «а»): не цель.
  return null
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
  let lava = S && Number.isFinite(S.x) ? { x: S.x, y: S.y, z: S.z, sky: true } : null
  let cave = C && Number.isFinite(C.x) ? { x: C.x, y: C.y, z: C.z, sky: false } : null
  if (LAKES()) {
    // Озёра из памяти глаз: поверху (y ≥ 58) и в пещере; услышанная лава (места нет — сторона и дальность) — пещерная, если озера нет.
    const lk = await seenLakes()
    const sk = lk.find(l => l.sky); const cv = lk.find(l => !l.sky)
    lava = sk ? { x: sk.x, y: sk.y, z: sk.z, sky: true, src: sk.level } as any : null
    cave = cv ? { x: cv.x, y: cv.y, z: cv.z, sky: false, src: cv.level } as any : (heard && !lavaAvoided(heard) ? { ...heard, sky: false } : null)
  }
  const next = ctx.routeMod.seenInfo({ spawn: info.spawn, structures: list.filter(q => !q.dim || q.dim === 'overworld'), lava: lava || cave, cave: lava ? cave : null })
  next.outposts = list.filter(q => q.kind === 'outpost' && q.at).map(q => ({ x: q.at.x, z: q.at.z, r: 72, src: 'видел' }))
  const was = [info.rp, info.village, info.ship, info.sky, info.lava].map(q => q ? `${q.x},${q.z}` : '-').join('|')
  const now = [next.rp, next.village, next.ship, next.sky, next.lava].map(q => q ? `${q.x},${q.z}` : '-').join('|')
  if (was !== now) ctx.rlog(`вижу: ${[next.rp && `руины ${next.rp.x},${next.rp.z}`, next.village && `деревня ${next.village.x},${next.village.z}`, next.ship && `корабль ${next.ship.x},${next.ship.z}`, next.sky && `лава поверху ${next.sky.x},${next.sky.y},${next.sky.z}`, next.lava && `лава ${next.lava.x},${next.lava.y},${next.lava.z}`].filter(Boolean).join('; ') || 'пока ничего'}`)
  ctx.routeInfoV = next
}
return { seenMode, routeInfoGet, lavaAvoided, LAKES, LAKE_MIN, seenLakes, hasShield, lookAround, noteLava, lavaOf, routeSeenRefresh }
}
