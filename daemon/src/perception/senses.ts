'use strict'
// F3, «пирог» F3 и слух — то, что игрок видит на экране и слышит (S10, 07.10; AGENTS.md «Что бот знает о мире»).
//
// F3 (f3): координаты, направление (как F3: yaw 0 — юг, 90 — запад), биом под ногами, свет клетки ног (небо/блоки),
//   число сущностей у клиента, загруженных столбцов, блок под прицелом (луч глаз, 20 бл. — как «Targeted Block»).
// «Пирог» F3 (pie): блок-сущности с отрисовщиком (сундук, спавнер, кровать, табличка… — eyes.PIE; у бочки и печи
//   отрисовщика нет, их «пирог» не показывает) в прорисовке — не дальше range (64: обычная дальность отрисовки
//   блок-сущностей клиентом) от глаз; только СЧЁТ по типу, без клетки. С yaw/fov — только в секторе взгляда (поле
//   зрения по горизонтали): так люди ищут клад и спавнер — крутят камерой и смотрят, когда появляется доля
//   blockentities (pie-ray). pieArcs — дуги поворота, где счёт > 0 (середина дуги — пеленг); triangulate — место по
//   пеленгам из нескольких точек (ходом). Клетки наружу не выходят. Отсечение заслонённых секций клиента не
//   моделируется: «пирог» видит и закопанный сундук, как у людей на практике.
// Слух (hearing): звуки сервера с позицией (sound_effect, entity_sound_effect) — их сервер шлёт только в 16·max(1,
//   громкость) бл. (SoundEvent.getRange, jar 1.21.11) — как субтитры: что, сторона (8 румбов от слушателя) и полоса
//   дальности, без точки. Лава и вода — по-прежнему cast.hearLava/hearWater (звуки клиента, ND_OW_HEAR).
import * as gameClock from '../game-clock'
import * as eyes from './eyes'

const DIR8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest']
const DIR4 = ['north', 'east', 'south', 'west']
// Румб от (dx, dz): север — −Z, восток — +X.
function dir8 (dx, dz) { const a = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360; return DIR8[Math.round(a / 45) % 8] }
function dir4 (dx, dz) { const a = (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360; return DIR4[Math.round(a / 90) % 4] }
function band (d) { return d <= 4 ? 'рядом' : d <= 8 ? 'близко' : d <= 16 ? 'средне' : 'далеко' }
// yaw в градусах F3 (0 — юг, 90 — запад, 180 — север, −90 — восток) из вектора и обратно.
function yawOf (dx, dz) { return Math.round(Math.atan2(-dx, dz) * 1800 / Math.PI) / 10 }
function vecOf (yaw) { const r = yaw * Math.PI / 180; return { x: -Math.sin(r), z: Math.cos(r) } }
const norm180 = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a }

// ---------------------------------------------------------------- F3

function f3 (bot) {
  if (!bot || !bot.entity) return null
  const p = bot.entity.position
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  const yaw = norm180(180 - bot.entity.yaw * 180 / Math.PI)
  const pitch = -bot.entity.pitch * 180 / Math.PI
  const v = vecOf(yaw)
  let light = null
  try { const b = bot.blockAt(p.floored()); if (b) light = { sky: b.skyLight, block: b.light } } catch {}
  let biome = null
  try { biome = (require('../perception') as typeof import('../perception')).biomeName(bot, p.floored()) } catch {}
  let chunks = null
  try { chunks = bot.world.getColumns ? bot.world.getColumns().length : null } catch {}
  let near = 0; let total = 0
  for (const e of Object.values(bot.entities || {}) as any[]) {
    if (!e || e === bot.entity || !e.position) continue
    total++
    if (e.position.distanceTo(p) <= 64) near++
  }
  return {
    xyz: { x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000, z: Math.round(p.z * 1000) / 1000 },
    block: feet,
    chunk: { x: feet.x >> 4, z: feet.z >> 4, in: { x: feet.x & 15, z: feet.z & 15 } },
    facing: { dir4: dir4(v.x, v.z), dir8: dir8(v.x, v.z), yaw: Math.round(yaw * 10) / 10, pitch: Math.round(pitch * 10) / 10 },
    dimension: eyes.dimOf(bot),
    biome,
    light,
    entities: { total, within64: near },
    chunks,
    target: eyes.surface(bot, { maxDist: 20 }),
    time: bot.time ? { day: bot.time.day, timeOfDay: bot.time.timeOfDay } : null
  }
}

// ---------------------------------------------------------------- «пирог»

const PIE_GROUP = n => /_bed$/.test(n) ? 'bed' : /sign$/.test(n) ? 'sign' : /banner$/.test(n) ? 'banner' : /(_head|_skull)$/.test(n) ? 'head' : /shulker_box$/.test(n) ? 'shulker_box' : n

// Клетки «пирога» в range от глаз (внутреннее: наружу — только счёт и пеленги).
function pieCells (bot, range) {
  const e = bot._ndEyes || new eyes.Eyes(bot)
  e.syncDim()
  const read = eyes.reader(bot)
  const p = bot.entity.position
  const o = { x: p.x, y: p.y + 1.62, z: p.z }
  const out = []
  for (const s of e.sectionsNear(read, o, range)) {
    const ent = e.section(read, s.cx, s.cz, s.sy)
    if (!ent) continue
    for (const c of ent.cells) {
      if (!c.pie) continue
      const dx = c.x + 0.5 - o.x; const dy = c.y + 0.5 - o.y; const dz = c.z + 0.5 - o.z
      if (dx * dx + dy * dy + dz * dz > range * range) continue
      out.push({ group: PIE_GROUP(c.name), dx, dz })
    }
  }
  return out
}

const inSector = (c, yaw, fov) => Math.abs(norm180(yawOf(c.dx, c.dz) - yaw)) <= fov / 2

// Счёт блок-сущностей по типу в прорисовке; yaw+fov — только в секторе взгляда.
function pie (bot, { range = 64, yaw = null, fov = null }: any = {}) {
  if (!bot || !bot.entity || !bot.registry) return null
  const byType: Record<string, number> = {}
  let total = 0
  for (const c of pieCells(bot, range)) {
    if (yaw !== null && fov && !inSector(c, yaw, fov)) continue
    byType[c.group] = (byType[c.group] || 0) + 1
    total++
  }
  return { total, byType, range, ...(yaw !== null && fov ? { yaw, fov } : {}) }
}

// Поворот камерой на 360° шагом step с полем fov: дуги, где счёт type > 0 (середина дуги — пеленг, F3-yaw).
function pieArcs (bot, type = 'chest', { range = 64, fov = 30, step = 2 }: any = {}): any[] {
  if (!bot || !bot.entity || !bot.registry) return []
  const cells = pieCells(bot, range).filter(c => c.group === type)
  if (!cells.length) return []
  const n = Math.round(360 / step)
  const counts = []
  for (let i = 0; i < n; i++) { const yaw = norm180(i * step); counts.push(cells.filter(c => inSector(c, yaw, fov)).length) }
  const arcs = []
  const start = counts.findIndex(c => c === 0)
  if (start < 0) return [{ from: -180, to: 180, center: null, max: Math.max(...counts), all: true }]
  let cur = null
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n
    if (counts[i] > 0) {
      if (!cur) cur = { i0: i, len: 0, max: 0 }
      cur.len++; cur.max = Math.max(cur.max, counts[i])
    } else if (cur) { arcs.push(cur); cur = null }
  }
  return arcs.map(a => {
    const from = norm180(a.i0 * step); const to = norm180((a.i0 + a.len - 1) * step)
    return { from, to, center: norm180(a.i0 * step + (a.len - 1) * step / 2), width: a.len * step, max: a.max }
  }).sort((a, b) => b.max - a.max || a.width - b.width)
}

// Место по пеленгам { x, z, yaw } из разных точек — пересечение прямых методом наименьших квадратов.
// { x, z, spread (СКО невязки, бл.), uncertainty (ошибка места, бл.), n } или null.
function triangulate (samples, { yawError = 1 }: any = {}) {
  let a11 = 0; let a12 = 0; let a22 = 0; let b1 = 0; let b2 = 0
  for (const s of samples) {
    const d = vecOf(s.yaw)
    // Проектор на нормаль прямой: I − d dᵀ.
    const m11 = 1 - d.x * d.x; const m12 = -d.x * d.z; const m22 = 1 - d.z * d.z
    a11 += m11; a12 += m12; a22 += m22
    b1 += m11 * s.x + m12 * s.z; b2 += m12 * s.x + m22 * s.z
  }
  const det = a11 * a22 - a12 * a12
  if (samples.length < 2 || Math.abs(det) < 1e-3) return null
  const x = (a22 * b1 - a12 * b2) / det
  const z = (a11 * b2 - a12 * b1) / det
  let r2 = 0; let range = 0
  for (const s of samples) {
    const d = vecOf(s.yaw)
    const px = x - s.x; const pz = z - s.z
    const along = px * d.x + pz * d.z
    if (along < 0) return null // точка позади одного из пеленгов — не то пересечение
    const across = px * d.z - pz * d.x
    r2 += across * across // без вычитания почти равных квадратов (оно давало отрицательное → NaN)
    range = Math.max(range, Math.hypot(px, pz))
  }
  const spread = Math.sqrt(r2 / samples.length)
  // Два луча всегда имеют нулевую невязку. Ошибка угла (половина шага пирога 2°) при слабом параллаксе даёт большую ошибку места.
  const weak = (a11 + a22 - Math.hypot(a11 - a22, 2 * a12)) / 2
  const uncertainty = Math.hypot(spread, range * Math.sin(yawError * Math.PI / 180) * Math.sqrt(samples.length / weak))
  if (![x, z, spread, uncertainty].every(Number.isFinite)) return null
  return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10, spread: Math.round(spread * 10) / 10, uncertainty: Math.round(uncertainty * 10) / 10, n: samples.length }
}

// ---------------------------------------------------------------- слух

// Имя звука пакета — melee.soundName (сдвиг номера 1.21.11: в minecraft-data номера звуков с 1; mineflayer
// soundEffectHeard его не делает — нативная сцена s10-e-1: хаск слышался «entity.hostile.swim» вместо entity.husk.ambient).
const soundName = (bot, holder) => holder ? (require('../melee') as typeof import('../melee')).soundName(bot, { sound: holder }) || null : null
// Субтитр: entity.<тип>.<событие> — моб, block.<блок>.<…> — блок.
function subtitle (name) {
  const m = /^(entity|block|item|ambient|weather|event)\.([a-z_]+)(?:\.([a-z_.]+))?/.exec(String(name || '').replace(/^minecraft:/, ''))
  if (!m) return { kind: 'other', who: null, what: null }
  return { kind: m[1] === 'entity' ? 'mob' : m[1], who: m[2], what: m[3] || null }
}

function installHearing (bot) {
  if (!bot || bot._ndEars) return bot && bot._ndEars
  const ears = { log: [], max: 256 }
  bot._ndEars = ears
  const push = (name, pos, volume, entityId = null) => {
    if (!bot.entity || !pos || !name) return
    const me = bot.entity.position
    const sub = subtitle(name)
    let id = entityId
    // Звук моба с позицией — того моба этого типа, что в 2 бл. от звука (внутреннее: наружу — сторона и полоса).
    if (id === null && sub.kind === 'mob') {
      let best = 4
      for (const e of Object.values(bot.entities || {}) as any[]) {
        if (!e || e === bot.entity || !e.position || e.name !== sub.who) continue
        const d = (e.position.x - pos.x) ** 2 + (e.position.y - pos.y) ** 2 + (e.position.z - pos.z) ** 2
        if (d < best) { best = d; id = e.id }
      }
    }
    ears.log.push({ name, sub, x: pos.x, y: pos.y, z: pos.z, lx: me.x, ly: me.y, lz: me.z, volume, t: gameClock.now(), id })
    if (ears.log.length > ears.max) ears.log.splice(0, ears.log.length - ears.max)
  }
  if (bot._client && typeof bot._client.on === 'function') {
    // Звук с позицией: координаты пакета ×8 (как в mineflayer sound.js).
    bot._client.on('sound_effect', pk => {
      try { push(soundName(bot, pk.sound || (pk.soundId !== undefined ? { soundId: pk.soundId } : null)), { x: pk.x / 8, y: pk.y / 8, z: pk.z / 8, distanceSquared: null }, pk.volume) } catch {}
    })
    bot._client.on('entity_sound_effect', pk => {
      try { const e = bot.entities && bot.entities[pk.entityId]; if (e && e.position) push(soundName(bot, pk.sound), e.position, pk.volume, pk.entityId) } catch {}
    })
  }
  return ears
}

const heardOf = (r, now) => {
  const dx = r.x - r.lx; const dz = r.z - r.lz
  const d = Math.sqrt(dx * dx + (r.y - r.ly) ** 2 + dz * dz)
  return { name: r.name, kind: r.sub.kind, who: r.sub.who, what: r.sub.what, dir8: dir8(dx, dz), dir4: dir4(dx, dz), band: band(d), ago: Math.round((now - r.t) / 100) / 10 }
}

// Что слышно за sinceMs игрового времени (новые первыми); match — RegExp по имени звука.
function heard (bot, { sinceMs = 3000, match = null }: any = {}) {
  const ears = bot && bot._ndEars
  if (!ears) return []
  const now = gameClock.now()
  const out = []
  for (let i = ears.log.length - 1; i >= 0; i--) {
    const r = ears.log[i]
    if (now - r.t > sinceMs) break
    if (match && !match.test(r.name)) continue
    out.push(heardOf(r, now))
  }
  return out
}

// Сущности, которых слышно (id → субтитр последнего звука) — для eyes.entities.
function heardEntities (bot, { sinceMs = 4000 }: any = {}) {
  const out = new Map()
  const ears = bot && bot._ndEars
  if (!ears) return out
  const now = gameClock.now()
  for (let i = ears.log.length - 1; i >= 0; i--) {
    const r = ears.log[i]
    if (now - r.t > sinceMs) break
    if (r.id !== null && r.id !== undefined && !out.has(r.id)) out.set(r.id, heardOf(r, now))
  }
  return out
}

// ---------------------------------------------------------------- звук → примерная точка

// Где примерно источник слышимого звука: субтитр (8 румбов, полоса) → точка на середине полосы по румбу, высота — ног.
const BAND_MID = { рядом: 3, близко: 6, средне: 12, далеко: 20 }
const DIR_V = { north: [0, -1], northeast: [0.7071, -0.7071], east: [1, 0], southeast: [0.7071, 0.7071], south: [0, 1], southwest: [-0.7071, 0.7071], west: [-1, 0], northwest: [-0.7071, -0.7071] }
function hearPoint (bot, h) {
  const v = DIR_V[h.dir8]; const d = BAND_MID[h.band] || 12
  const p = bot.entity.position
  return v ? { x: p.x + v[0] * d, y: p.y, z: p.z + v[1] * d } : null
}

// Лава, которую слышно: клиент сам играет её звуки (LavaFluid.animateTick: только у лавы с воздухом над ней) для клеток в
// 32 бл. (ClientLevel.animateTick) — сквозь стены. Наружу — как человек, повернувший голову на звук: румб 22.5°,
// дальность до 4 бл., высота до 4 бл. — и точка-оценка. skip(точка) — отброшенные места. null — не слышно.
function hearLavaPoint (bot, { radius = 32, maxDy = 12, skip = null }: any = {}) {
  if (!bot || !bot.entity || !bot.registry) return null
  const e = bot._ndEyes || new eyes.Eyes(bot)
  e.syncDim()
  const read = eyes.reader(bot)
  const p = bot.entity.position
  const o = { x: p.x, y: p.y + 1.62, z: p.z }
  const airS = s => s === 0 || /^(air|cave_air|void_air)$/.test(e.shapes.name(s))
  let best = null
  for (const sc of e.sectionsNear(read, o, radius)) {
    const ent = e.section(read, sc.cx, sc.cz, sc.sy)
    if (!ent) continue
    for (const c of ent.cells) {
      if (c.name !== 'lava' || Math.abs(c.y - p.y) > maxDy) continue
      const dx = c.x + 0.5 - o.x; const dy = c.y + 0.5 - o.y; const dz = c.z + 0.5 - o.z
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d > radius || (best && d >= best.d) || !airS(read.at(c.x, c.y + 1, c.z))) continue
      if (skip && skip({ x: c.x, y: c.y, z: c.z })) continue // отброшенные места (уже ходил туда) — следующий звук
      best = { d, dx, dy, dz }
    }
  }
  if (!best) return null
  const yaw = Math.round(yawOf(best.dx, best.dz) / 22.5) * 22.5
  const dist = Math.max(4, Math.round(best.d / 4) * 4)
  const flat = Math.sqrt(Math.max(0, dist * dist - best.dy * best.dy))
  const v = vecOf(yaw)
  const at = { x: Math.round(o.x + v.x * flat), y: Math.round(p.y + Math.round(best.dy / 4) * 4), z: Math.round(o.z + v.z * flat) }
  return { yaw, dist, at }
}

// ---------------------------------------------------------------- «пирог» ходом

// Найти блок-сущность type ходом, как люди: пеленг отсюда, шаг поперёк на base бл., второй пеленг, пересечение;
// ближе к нему — третий пеленг и уточнение. Итог — оценка места (x, z, разброс) и чанк; клетка не известна:
// дальше — глазами/копкой (клад: BuriedTreasure ставит сундук в клетку чанка 9,9 — treasure).
async function pieSeek (session, ctl, { type = 'chest', base = 24, fov = 30, timeoutSeconds = 120, near = 10, move = null, until = null, stop = null }: any = {}) {
  const bot = session.bot
  const { travelXZ }: typeof import('../movement') = require('../movement')
  const deadline = Math.min(until ?? Infinity, gameClock.now() + Math.max(20, Math.min(600, timeoutSeconds)) * 1000)
  const here = () => ({ x: bot.entity.position.x, z: bot.entity.position.z })
  const samples = []
  const legs = []
  // Caller may keep both the baseline and the approach in a covered tunnel.
  const stopped = () => ctl.aborted || gameClock.now() >= deadline || !!stop?.()
  const walk = async (x, z) => {
    if (stopped()) return false
    const r = move ? await move(x, z, deadline) : await travelXZ(bot, ctl, x, z, { range: 3, deadline })
    legs.push({ to: { x: Math.round(x), z: Math.round(z) }, ok: !!r.ok, error: r.error })
    return r.ok
  }
  // Пеленг отсюда, согласованный с прежними: дуга, при которой пересечение впереди всех и разброс меньше.
  const sample = () => {
    const arcs = pieArcs(bot, type, { fov })
    if (!arcs.length || arcs[0].all) return null
    const p = here()
    if (!samples.length) return { ...p, yaw: arcs[0].center }
    let best = null
    for (const a of arcs) {
      const t = triangulate([...samples, { ...p, yaw: a.center }])
      if (!t) continue
      const d = Math.hypot(t.x - p.x, t.z - p.z)
      const score = t.spread * 4 + d / 16
      if (!best || score < best.score) best = { score, s: { ...p, yaw: a.center } }
    }
    return best ? best.s : null
  }
  const s1 = sample()
  if (!s1) return { found: false, why: `«пирог»: ${type} в прорисовке не видно` }
  samples.push(s1)
  const d = vecOf(s1.yaw)
  for (const side of [1, -1]) {
    if (stopped()) break
    if (await walk(s1.x - d.z * base * side, s1.z + d.x * base * side)) break
  }
  const s2 = sample()
  if (s2) samples.push(s2)
  let est = triangulate(samples)
  if (est && !stopped()) {
    const p = here()
    const L = Math.hypot(est.x - p.x, est.z - p.z)
    if (L > near) {
      const k = (L - near) / L
      await walk(p.x + (est.x - p.x) * k, p.z + (est.z - p.z) * k)
      const s3 = sample()
      if (s3) { samples.push(s3); est = triangulate(samples) || est }
    }
  }
  const out: any = { found: !!est, type, samples: samples.map(s => ({ x: Math.round(s.x), z: Math.round(s.z), yaw: s.yaw })), legs }
  if (est) {
    const cx = Math.floor(est.x / 16); const cz = Math.floor(est.z / 16)
    out.estimate = est
    out.chunk = { x: cx, z: cz }
    out.treasure = { x: cx * 16 + 9, z: cz * 16 + 9 }
    out.dist = Math.round(Math.hypot(est.x - bot.entity.position.x, est.z - bot.entity.position.z))
  } else out.why = samples.length < 2 ? 'второго пеленга нет (ушёл из прорисовки или не дошёл)' : 'пеленги не пересеклись'
  return out
}

// ---------------------------------------------------------------- RPC perceive

function perceive (session, p: any = {}) {
  const bot = session.bot
  const knowledge: typeof import('./knowledge') = require('./knowledge')
  const mode = p.mode || 'summary'
  const what = p.re ? new RegExp(p.re) : (p.block || p.blocks || 'log')
  switch (mode) {
    case 'knowledge': return { level: knowledge.level(), describe: knowledge.describe() }
    case 'f3': return f3(bot)
    case 'pie': return pie(bot, p)
    case 'pie_arcs': return { arcs: pieArcs(bot, p.type || 'chest', p) }
    case 'heard': return { heard: heard(bot, { sinceMs: (p.sinceSeconds ?? 3) * 1000 }) }
    case 'seen': return { seen: eyes.nearest(bot, what, p) }
    case 'surface': return { surface: eyes.surface(bot, p) }
    case 'entities': return { entities: eyes.entities(bot, p) }
    case 'stats': return { stats: eyes.stats(bot) }
    case 'sweep': { const e = bot._ndEyes; return { sweep: e ? e.sweep({ rays: p.rays ?? 2000, maxMs: p.maxMs ?? 200, radius: p.radius }) : null } }
    default: {
      const st = eyes.stats(bot)
      return { knowledge: knowledge.level(), f3: f3(bot), pie: pie(bot), heard: heard(bot), remembered: st && st.remembered, cpu: st && st.cpu }
    }
  }
}

export { f3, pie, pieArcs, triangulate, installHearing, heard, heardEntities, hearPoint, hearLavaPoint, subtitle, dir8, dir4, band, yawOf, vecOf, pieSeek, perceive }
