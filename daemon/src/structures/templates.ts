'use strict'
import * as gameClock from '../game-clock'
import { biomeName } from '../perception'
import { dimOf, flat } from './common'
import { KINDS, TEMPLATE_KINDS } from './kinds'
import { listOf, patchRec } from './memory'
import { swimming } from './water'

// Узнать шаблон постройки из памяти, которую видно отсюда (для цены до захода): ближайшая запись вида kind у x,z.
function fitKnown (session, { kind = null, x, z, maxDistance = 64, debug = false }: any = {}) {
  const bot = session.bot
  const rec = pickTarget(session, { kind, x, z, again: true })
  if (!rec || !TEMPLATE_KINDS[rec.kind] || flat(bot.entity.position, rec) > maxDistance) return { fit: null, why: rec ? 'далеко или без шаблона' : 'нет записи' }
  session._fitDebug = debug ? [] : null
  const tf = templateFit(session, debug ? { ...rec, fit: null } : rec)
  const dbg = session._fitDebug
  session._fitDebug = null
  const ex = tf && tf.extra
  return { fit: tf ? { name: tf.name, chests: tf.chests.filter(c => Number.isFinite(c.y) || c.basement).map(c => ({ x: c.x, y: c.y, z: c.z, table: c.table, p: c.p, wet: !!c.wet })), ...(ex && Number.isFinite(ex.houses) ? { houses: ex.houses, beds: ex.beds || 0, hay: ex.hay || 0 } : {}) } : null, debug: dbg || undefined }
}
function templatesOn () { return process.env.ND_STRUCT_TEMPLATES !== '0' }

// Узнать шаблон записи по видимому: { chests: [{x,y,z,table,p,wet}], name, extra } (и записать в память — для цены).
function templateFit (session, rec, out = null) {
  const bot = session.bot
  const R = TEMPLATE_KINDS[rec.kind]
  if (!R || !templatesOn()) return null
  const F: typeof import('../structure-fit') = require('../structure-fit')
  const center = { x: rec.x, y: rec.y, z: rec.z }
  let chests = []
  let name = null
  let extra: any = {}
  const t0 = Date.now()
  if (rec.kind === 'village') {
    const houses = F.fitHouses(bot, center, { radius: R, biome: F.villageBiome(bot, center) })
    for (const h of houses) chests.push(...h.chests.map(c => ({ ...c, from: h.name })))
    name = houses.map(h => h.name.split('/').pop()).join(', ') || null
    // Кровати и сено узнанных домов — по их шаблонам (цена деревни — не по среднему; ферма 14.10, cs-7: «+2 с — иду», 146 с, ничего).
    let beds = 0
    let hay = 0
    for (const h of houses) { beds += templateCells(h, /_bed$/).length / 2; hay += templateCells(h, /^hay_block$/).length }
    extra = { houses: houses.length, beds: Math.floor(beds), hay }
  } else {
    // Под водой или на пляже — по биому места (океан — затонувший, пляж — на мели: has_structure/shipwreck(_beached)).
    const biome = (() => { try { return biomeName(bot, bot.entity.position.floored()) || '' } catch { return '' } })()
    const wetShip = rec.kind === 'ocean_ruin' || (rec.kind === 'shipwreck' && (/ocean|river/.test(biome) || (!biome && swimming(bot))))
    const r = F.fit(bot, rec.kind, center, { radius: R, env: rec.kind === 'shipwreck' ? (wetShip ? 'ocean' : 'beached') : null, debug: session._fitDebug || null })
    if (session._fitDebug && r) session._fitDebug.push({ seen: r.seen, voters: r.voters, best: r.best && r.best.name })
    if (r && r.best) {
      name = r.best.name
      if (rec.kind === 'igloo') {
        const b = F.iglooBasement(r.best)
        extra = { igloo: b }
        if (b) chests = [{ x: b.chest.x, y: null, z: b.chest.z, table: b.chest.table, p: 0.5, basement: true }]
      } else chests = F.chestsOf(r)
      extra.score = r.best.score
      extra.match = r.best.match
      extra.miss = r.best.miss
      if (rec.kind === 'desert_pyramid') extra.plate = templateCells(r.best, /^stone_pressure_plate$/)[0] || null
      if (rec.kind === 'jungle_pyramid') extra.traps = templateCells(r.best, /^(tripwire_hook|tripwire)$/)
    }
    // Руины портала и прочее в океане (биом под ногами, F3) ниже уровня моря — тоже под водой: нырок, сторож воздуха.
    for (const c of chests) c.wet = wetShip || (Number.isFinite(c.y) && c.y < 61 && /ocean|river/.test(biome))
  }
  const ms = Date.now() - t0
  // Узнан раньше (с лучшего места подхода: под водой видно на ~20 бл.) — то узнавание и берём.
  if (!name && rec.fit && rec.fit.name) {
    if (out) out.lines.push(`▸ шаблон: ${rec.fit.name} — узнан раньше (отсюда не видно, ${ms} мс)`)
    return { name: rec.fit.name, chests: (rec.fit.chests || []).map(([x, y, z, table, p, wet]) => ({ x, y, z, table, p, wet: !!wet, basement: y === null })), extra: rec.fit.extra || {}, old: true }
  }
  if (out) out.lines.push(name ? `▸ шаблон: ${name} (сундуков по шаблону ${chests.length}, ${ms} мс)` : `▸ шаблон не узнан (${ms} мс)`)
  if (name) patchRec(session, rec, r => { r.fit = { name, chests: chests.map(c => [c.x, c.y, c.z, c.table, c.p, c.wet ? 1 : 0]), extra, t: gameClock.now() } })
  return name ? { chests, name, extra } : null
}
// Клетки шаблона гипотезы с именем блока по re → мир.
function templateCells (h, re) {
  const F: typeof import('../structure-fit') = require('../structure-fit')
  const T = F.lib()[h.name]
  const CHR = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-/:;<=>?@[]^_`{|}~'
  const ids = new Set(T.pal.map((n, i) => re.test(n) ? CHR[i] : null).filter(Boolean))
  const [X, Y, Z] = T.size
  const out = []
  for (let i = 0; i < T.grid.length; i++) {
    if (!ids.has(T.grid[i])) continue
    const x = i % X; const z = Math.floor(i / X) % Z; const y = Math.floor(i / (X * Z))
    out.push(F.toWorld(h, x, y, z))
  }
  return out
}

// ------------------------------------------------------------------ намерение

function pickTarget (session, p) {
  const bot = session.bot
  const dim = dimOf(bot)
  const me = bot.entity.position
  const list = listOf(session).filter(r => r.dim === dim && (!p.kind || r.kind === p.kind))
  if (typeof p.x === 'number' && typeof p.z === 'number') {
    const pos = { x: p.x, y: p.y ?? me.y, z: p.z }
    return list.filter(r => flat(r, pos) <= Math.max(24, (KINDS[r.kind] || {}).lootR || 0)).sort((a, b) => flat(a, pos) - flat(b, pos))[0] || null
  }
  return list.filter(r => !r.done || p.again).sort((a, b) => flat(a, me) - flat(b, me))[0] || null
}

export { fitKnown, templatesOn, templateFit, pickTarget }
