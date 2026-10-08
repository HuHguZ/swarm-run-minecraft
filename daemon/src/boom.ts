'use strict'
const gameClock = require('./game-clock')
// «Динамит» на арене (просьба 2026-09-26: «про-игроки динамитом выстреливают и
// убивают им, очень быстро, механизм какой-то»). Это cart PvP 1.21: рельс под
// ноги, на него вагонетка с TNT, и горящая стрела из лука с «Огнём» — взрыв в
// тот же тик. Второе — кристаллы Края: ставятся только на обсидиан (а пол
// арены обсидиановый) и взрываются от любого удара или стрелы. Что умеет:
//  1. Мина: рельс и вагонетка между нами, отойти, стрела в неё, когда он
//     рядом с ней, а мы — нет (прогноз урона по формуле игры обоим).
//  2. Стрела в уже стоящую взрывчатку (свою или его), если урон ему больше и
//     нам не смертельно; толчок взрыва в яму — в счёт.
//  3. Кристалл у его ног — стрелой издалека или, если себе терпимо, ударом.
//  4. Защита: его вагонетка у меня в руке — ударить мечом (разобрать, выпадет
//     предметом); кристалл/вагонетка рядом и больно — отойти; его кристалл
//     ближе к нему, чем ко мне, — ударить первым.
//
// Числа — декомпиляция 1.21.11 (extremeheat/extracted_minecraft_data, ветка
// client1.21.11) и замеры на тестовом Paper:
//  * world/entity/vehicle/minecart/MinecartTNT: hurtServer — прямая сущность
//    AbstractArrow и isOnFire() → explode сразу, сила 4 + rand·1.5·min(|v
//    стрелы|, 5); destroy (урон > 40, VehicleEntity: урон ×10 — меч с одного
//    удара) без огня и без скорости — выпадает предметом, не взрывается;
//    падение ≥ 3 — взрыв; взрыв рядом — фитиль 0–38 тиков;
//  * world/entity/boss/enderdragon/EndCrystal.hurtServer: любой урон не от
//    взрыва — взрыв силой 6 в точке кристалла, приписан ударившему; урон
//    взрывом — исчезает без взрыва. world/item/EndCrystalItem.useOn: только
//    обсидиан или бедрок, клетка над ним пустая, в коробке 1×2 над ней нет
//    сущностей;
//  * world/level/ServerExplosion.hurtEntities: d = |ноги − центр| / 2P (> 1 —
//    мимо), видимость getSeenPercent (лучи из сетки его рамки к центру,
//    ClipContext.COLLIDER — паутина не заслоняет), урон ((1−d)·вид)²+(1−d)·вид
//    )/2·7·2P + 1 (ExplosionDamageCalculator); толчок — (1−d)·вид·(1 −
//    explosion_knockback_resistance) по «центр → глаза»; сначала урон и толчок,
//    потом блоки (explode: hurtEntities до interactWithBlocks);
//  * урон — броня (CombatRules), «Защита» 1 и «Взрывоустойчивость» 2 за
//    уровень (сумма ≤ 20, ×(1 − EPF/25)), сопротивление −20% за уровень;
//    сложность «нормально» не множит;
//  * блоки: светокамень и стекло — стойкость 0.3 (ломаются), обсидиан 1200 и
//    барьер 3600000 — нет: дыры в полу — там, где полосы светокамня.

const Vec3 = require('vec3')

const TICK_MS = 50
const EYE = 1.62
const REACH = 3.0
const BLOCK_REACH = 4.5
const CRYSTAL_P = 6
// Слабая стрела (натяжение ~8 тиков, скорость ≤ 1 б/т): вагонетка —
// 4…5.5 (радиус до 11). Полная — до 8.5 (радиус 17): себе не выжить.
const CART_DRAW_MS = 450
const CART_P_MAX = 5.5
const CART_P_AVG = 4.75
const DEBUG = !!process.env.ND_DEBUG_BOOM
// ND_BOOM=0 — не пользоваться взрывчаткой (прогон «до»); защита остаётся.
const ON = process.env.ND_BOOM !== '0'

const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
const r2 = (x) => Math.round(x * 100) / 100
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// ---------------------------------------------------------------- лучи

// Первый блок с коллизией на отрезке a→b (DDA по клеткам, формы блока). Как
// ClipContext.Block.COLLIDER: у паутины и рельса коллизии нет — не заслоняют.
function rayBox (o, d, lo, hi, tMax) {
  let t0 = 0; let t1 = tMax
  for (const a of ['x', 'y', 'z']) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) return null; continue }
    let ta = (lo[a] - o[a]) / d[a]; let tb = (hi[a] - o[a]) / d[a]
    if (ta > tb) { const s = ta; ta = tb; tb = s }
    if (ta > t0) t0 = ta
    if (tb < t1) t1 = tb
    if (t0 > t1) return null
  }
  return t0
}
function segmentBlocked (bot, a, b, cache) {
  const dx = b.x - a.x; const dy = b.y - a.y; const dz = b.z - a.z
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-6) return false
  const d = { x: dx / len, y: dy / len, z: dz / len }
  let x = Math.floor(a.x); let y = Math.floor(a.y); let z = Math.floor(a.z)
  const sx = d.x > 0 ? 1 : -1; const sy = d.y > 0 ? 1 : -1; const sz = d.z > 0 ? 1 : -1
  const nx = (c, s, dc, oc) => Math.abs(dc) < 1e-12 ? Infinity : ((s > 0 ? c + 1 : c) - oc) / dc
  let tx = nx(x, sx, d.x, a.x); let ty = nx(y, sy, d.y, a.y); let tz = nx(z, sz, d.z, a.z)
  const ix = Math.abs(d.x) < 1e-12 ? Infinity : Math.abs(1 / d.x)
  const iy = Math.abs(d.y) < 1e-12 ? Infinity : Math.abs(1 / d.y)
  const iz = Math.abs(d.z) < 1e-12 ? Infinity : Math.abs(1 / d.z)
  for (let i = 0; i < 64; i++) {
    const k = `${x},${y},${z}`
    let sh = cache ? cache.get(k) : undefined
    if (sh === undefined) {
      let bl = null
      try { bl = bot.blockAt(new Vec3(x, y, z), false) } catch {}
      sh = bl && bl.boundingBox === 'block' ? (bl.shapes && bl.shapes.length ? bl.shapes : [[0, 0, 0, 1, 1, 1]]) : null
      if (cache) cache.set(k, sh)
    }
    if (sh) {
      for (const s of sh) {
        const t = rayBox(a, d, { x: x + s[0], y: y + s[1], z: z + s[2] }, { x: x + s[3], y: y + s[4], z: z + s[5] }, len)
        if (t != null && t < len - 1e-7) return true
      }
    }
    const tn = Math.min(tx, ty, tz)
    if (tn > len) return false
    if (tx <= ty && tx <= tz) { x += sx; tx += ix } else if (ty <= tz) { y += sy; ty += iy } else { z += sz; tz += iz }
  }
  return false
}

// ServerExplosion.getSeenPercent: сетка точек по рамке (шаг 1/(2·размер+1),
// сдвиг по x и z), доля точек, от которых луч до центра не упирается в блок.
function seenPercent (bot, center, box, cache = new Map()) {
  const w = box.maxX - box.minX; const h = box.maxY - box.minY; const l = box.maxZ - box.minZ
  const sx = 1 / (w * 2 + 1); const sy = 1 / (h * 2 + 1); const sz = 1 / (l * 2 + 1)
  const ox = (1 - Math.floor(1 / sx) * sx) / 2; const oz = (1 - Math.floor(1 / sz) * sz) / 2
  let seen = 0; let all = 0
  for (let a = 0; a <= 1; a += sx) {
    for (let b = 0; b <= 1; b += sy) {
      for (let c = 0; c <= 1; c += sz) {
        const p = { x: box.minX + w * a + ox, y: box.minY + h * b, z: box.minZ + l * c + oz }
        if (!segmentBlocked(bot, p, center, cache)) seen++
        all++
      }
    }
  }
  return all ? seen / all : 0
}

// ---------------------------------------------------------------- урон

// Рамка игрока в точке pos: 0.6×1.8 (в полёте на элитрах — 0.6×0.6).
function playerBox (pos, h = 1.8) {
  return { minX: pos.x - 0.3, minY: pos.y, minZ: pos.z - 0.3, maxX: pos.x + 0.3, maxY: pos.y + h, maxZ: pos.z + 0.3 }
}

// Броня и чары: свои — слоты 5..8, чужие — equipment 2..5 (сапоги..шлем).
function defenseOf (bot, who) {
  const assess = require('./assess')
  const read = require('./read')
  const items = who === bot.entity ? [5, 6, 7, 8].map(s => bot.inventory.slots[s]) : ((who.equipment || []).slice(2, 6))
  const g = assess.gearOf(items)
  let epf = 0; let kbRes = 0
  for (const it of items) {
    if (!it) continue
    epf += read.enchLevel(bot, it, 'protection') + 2 * read.enchLevel(bot, it, 'blast_protection')
    kbRes += 0.15 * read.enchLevel(bot, it, 'blast_protection')
  }
  let resist = 0
  try {
    if (who === bot.entity) {
      const eff = bot.registry.effectsByName.resistance
      const e = eff && bot.entity.effects && bot.entity.effects[eff.id]
      if (e) resist = e.amplifier + 1
    } else {
      const r = read.effectsOf(bot, who)
      if (r && r.has && r.has('resistance')) resist = 1
    }
  } catch {}
  return { armor: g.armor, tough: g.tough, epf: Math.min(20, epf), kbRes: Math.min(1, kbRes), resist }
}

// Урон взрыва силы P с центром center по игроку с ногами в pos (рамка h) —
// после брони, чар и сопротивления; и толчок (вектор скорости).
function blast (bot, center, P, pos, { h = 1.8, eyeH = 1.62, def = null, cache = null, seen = null }: any = {}) {
  const dist = Math.hypot(pos.x - center.x, pos.y - center.y, pos.z - center.z) / (2 * P)
  if (dist > 1) return { raw: 0, dmg: 0, kb: new Vec3(0, 0, 0), seen: 0, dist }
  const vis = seen != null ? seen : seenPercent(bot, center, playerBox(pos, h), cache || new Map())
  const i = (1 - dist) * vis
  let raw = (i * i + i) / 2 * 7 * (2 * P) + 1
  // Сложность (2026-09-30, crystal.js): взрыв игроку масштабируется всегда
  // (Player.hurtServer, scalesWithDifficulty: «легко» min(f/2+1, f), «трудно»
  // ×1.5) — до окна неуязвимости и брони. Арена ставит «нормально», а в чужом
  // мире (ARENA_GENTLE) сложность его — модель не должна занижать себе урон.
  const diff = bot && bot.game && bot.game.difficulty
  if (diff === 'hard') raw *= 1.5
  else if (diff === 'easy') raw = Math.min(raw / 2 + 1, raw)
  else if (diff === 'peaceful') raw = 0
  const df = def || { armor: 0, tough: 0, epf: 0, kbRes: 0, resist: 0 }
  const assess = require('./assess')
  let dmg = assess.afterArmor(raw, df.armor, df.tough)
  dmg *= 1 - df.epf / 25
  dmg *= Math.max(0, 1 - 0.2 * df.resist)
  const eye = new Vec3(pos.x, pos.y + eyeH, pos.z)
  const dir = eye.minus(new Vec3(center.x, center.y, center.z))
  const n = dir.norm() || 1
  const k = (1 - dist) * vis * (1 - df.kbRes)
  return { raw: r2(raw), dmg: r2(dmg), kb: dir.scaled(k / n), seen: r2(vis), dist: r2(dist) }
}

function healthOf (bot, e) {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const hh = e.metadata[i >= 0 ? i : 9]
    return typeof hh === 'number' ? hh : null
  } catch { return null }
}
function absorptionOf (bot, e) { try { return require('./read').absorptionOf(bot, e) || 0 } catch { return 0 } }
function totemIn (e) {
  const eq = (e && e.equipment) || []
  return !!((eq[0] && eq[0].name === 'totem_of_undying') || (eq[1] && eq[1].name === 'totem_of_undying'))
}

// Толкнёт ли взрыв его в яму или пустоту (прогон тела edges.knockRun).
function knockedOff (bot, e, kb) {
  try {
    const edges = require('./edges')
    const cache = new Map()
    if (!edges.hazardAround(bot, e.position, 6, cache)) return false
    const base = edges.stateOf(bot)
    const grounded = edges.support(bot, e.position, cache).drop <= 0.05
    const r = edges.knockRun(bot, base, e.position, kb, grounded, e.yaw || 0, true, cache)
    return !!(r && r.fall)
  } catch { return false }
}

// ---------------------------------------------------------------- предметы

function findItem (bot, test) {
  const f = typeof test === 'string' ? (i => i.name === test) : test
  return bot.inventory.items().find(f) || null
}
function countOf (bot, name) { return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0) }
function flameBow (bot) {
  const read = require('./read')
  return bot.inventory.items().find(i => i.name === 'bow' && read.enchLevel(bot, i, 'flame') > 0) || null
}
function arrowsIn (bot) { return !!findItem(bot, i => /arrow$/.test(i.name)) }
function kitOf (bot) {
  const rails = countOf(bot, 'rail') + countOf(bot, 'powered_rail') + countOf(bot, 'detector_rail') + countOf(bot, 'activator_rail')
  return {
    carts: countOf(bot, 'tnt_minecart'),
    rails,
    crystals: countOf(bot, 'end_crystal'),
    flame: !!flameBow(bot),
    bow: !!findItem(bot, 'bow'),
    arrows: arrowsIn(bot)
  }
}
const hasBoom = (bot) => { const k = kitOf(bot); return (k.carts > 0 && k.rails > 0) || k.crystals > 0 }

// Предмет в хотбар (моментально — щелчками), вернуть номер слота.
const KEEP = /_sword$|_axe$|^mace$|^bow$|^crossbow$|^totem_of_undying$|golden_apple$|^water_bucket$|^ender_pearl$|^shield$/
async function toHotbar (bot, pred) {
  for (let i = 0; i < 9; i++) if (pred(bot.inventory.slots[36 + i])) return i
  const it = bot.inventory.items().find(pred)
  if (!it || bot.currentWindow) return -1
  let dest = -1
  for (let i = 0; i < 9; i++) if (i !== bot.quickBarSlot && !bot.inventory.slots[36 + i]) { dest = i; break }
  if (dest < 0) for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && !KEEP.test(s.name)) { dest = i; break } }
  if (dest < 0) return -1
  try { await bot.moveSlotItem(it.slot, 36 + dest) } catch { return -1 }
  return pred(bot.inventory.slots[36 + dest]) ? dest : -1
}

// «Использовать» предмет из слота idx на грань face блока pos: взгляд в
// точку грани (сила — сразу), пакет block_place. Честно: грань в 4.5 от глаз
// и луч к ней не упирается в другой блок.
function faceOk (bot, pos, face = { x: 0, y: 1, z: 0 }) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const pt = new Vec3(pos.x + 0.5 + face.x * 0.5, pos.y + 0.5 + face.y * 0.5, pos.z + 0.5 + face.z * 0.5)
  if (pt.distanceTo(eye) > BLOCK_REACH - 0.05) return null
  // Луч до точки грани: первым должен быть сам этот блок.
  const inner = pt.minus(new Vec3(face.x, face.y, face.z).scaled(0.02))
  const cache = new Map()
  cache.set(`${pos.x},${pos.y},${pos.z}`, null)
  if (segmentBlocked(bot, eye, inner, cache)) return null
  return pt
}
async function useOn (bot, idx, pos, face = { x: 0, y: 1, z: 0 }) {
  const pt = faceOk(bot, pos, face)
  if (!pt) return false
  if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
  try {
    const b = bot.blockAt(pos, false)
    if (!b) return false
    await bot._genericPlace(b, new Vec3(face.x, face.y, face.z), { forceLook: true, swingArm: 'right' })
    return true
  } catch { return false }
}

// Ждать сущность name рядом с точкой (появление на клиенте — тик после пакета).
function waitSpawn (bot, name, near, ms = 600) {
  return new Promise<any>(resolve => {
    const on = (e) => { if (e && e.name === name && e.position && e.position.distanceTo(near) < 1.6) { done(e) } }
    const t = gameClock.setTimeout(() => done(null), ms)
    function done (e) { gameClock.clearTimeout(t); bot.removeListener('entitySpawn', on); resolve(e) }
    bot.on('entitySpawn', on)
  })
}

// ---------------------------------------------------------------- взрывчатка вокруг

const BOOMS = { end_crystal: CRYSTAL_P, tnt_minecart: CART_P_MAX, tnt: 4 }
function explosives (bot, near, r = 14) {
  const out = []
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (!e || !e.position || !(e.name in BOOMS) || e.isValid === false) continue
    if (e.position.distanceTo(near) > r) continue
    out.push(e)
  }
  return out
}
// Центр взрыва: кристалл — его позиция (низ, на верхе обсидиана), вагонетка —
// её позиция (MinecartTNT.explode: getX/Y/Z).
const centerOf = (e) => new Vec3(e.position.x, e.position.y, e.position.z)

// Ударом или стрелой: вагонетку — только горящей стрелой, кристалл — чем
// угодно. meleeOk — достаём ли рукой.
function hitReach (bot, e) {
  const eye = bot.entity.position.offset(0, EYE, 0)
  const hw = (e.width || 1) / 2; const hh = e.height || 1
  const p = e.position
  const cx = clamp(eye.x, p.x - hw, p.x + hw); const cy = clamp(eye.y, p.y, p.y + hh); const cz = clamp(eye.z, p.z - hw, p.z + hw)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

// ---------------------------------------------------------------- решения

// Оценка взрыва ex (сущность или {name, at}) прямо сейчас: ему, мне, толчок
// в яму, убьёт ли. power — какой силы ждать (вагонетка от слабой стрелы).
function judge (bot, foe, center, P, { cache = new Map(), foeAt = null, meAt = null }: any = {}) {
  const me = meAt || bot.entity.position
  const fp = foeAt || foe.position
  const him = blast(bot, center, P, fp, { def: defenseOf(bot, foe), cache })
  const mine = blast(bot, center, P, me, { def: defenseOf(bot, bot.entity), cache })
  const hisHp = (healthOf(bot, foe) ?? 20) + absorptionOf(bot, foe)
  const myHp = (bot.health ?? 20) + absorptionOf(bot, bot.entity)
  const off = him.dmg > 0.5 && knockedOff(bot, foe, him.kb)
  const kill = him.dmg >= hisHp || off
  return { him, mine, off, kill: kill && !totemIn(foe), hisHp: r2(hisHp), myHp: r2(myHp) }
}

// Стоит ли взрывать: ему заметно, мне терпимо (не смертельно и не больше
// трети хп без тотема), размен в нашу пользу.
function worth (j, { totem = false }: any = {}) {
  const lim = totem ? j.myHp + 6 : Math.min(j.myHp - 5, Math.max(3, j.myHp * 0.35))
  if (j.mine.dmg > lim) return false
  if (j.kill) return true
  return j.him.dmg >= 6 && j.him.dmg >= j.mine.dmg * 2 + 2
}

// Клетка под рельс/кристалл рядом с ним: верх опоры на уровне его ног, клетка
// над ней пустая, до грани — рука, и (для кристалла) — обсидиан и 1×2 без его
// рамки. near — точка, у которой ищем (его ноги или середина между нами).
function spotsNear (bot, near, { crystal = false, foe = null, maxR = 2 }: any = {}) {
  const out = []
  const fy = Math.floor(near.y + 1e-6)
  for (let dx = -maxR; dx <= maxR; dx++) {
    for (let dz = -maxR; dz <= maxR; dz++) {
      const x = Math.floor(near.x) + dx; const z = Math.floor(near.z) + dz
      const base = new Vec3(x, fy - 1, z)
      const b = bot.blockAt(base, false)
      if (!b || b.boundingBox !== 'block') continue
      if (crystal && !/^(obsidian|bedrock)$/.test(b.name)) continue
      const up = bot.blockAt(base.offset(0, 1, 0), false)
      if (!up || up.name !== 'air') continue
      if (crystal) {
        // EndCrystalItem.useOn: в коробке [x, y+1, z]..[x+1, y+3, z+1] сущностей нет.
        const hitBox = (e) => e && e.position && e.position.x + 0.3 > x && e.position.x - 0.3 < x + 1 && e.position.z + 0.3 > z && e.position.z - 0.3 < z + 1 && e.position.y < fy + 2 && e.position.y + 1.8 > fy
        if (hitBox(foe) || hitBox(bot.entity)) continue
        if ((Object.values(bot.entities) as any[]).some((e : any) => e && e !== bot.entity && e.name !== 'player' && e.position && Math.abs(e.position.x - (x + 0.5)) < 1 && Math.abs(e.position.z - (z + 0.5)) < 1 && Math.abs(e.position.y - fy) < 2)) continue
      }
      if (!faceOk(bot, base)) continue
      out.push({ base, cell: base.offset(0, 1, 0), center: new Vec3(x + 0.5, crystal ? fy : fy + 0.0625, z + 0.5) })
    }
  }
  return out
}

// ---------------------------------------------------------------- действия

// Горящей (или любой — для кристалла) стрелой в точку взрывчатки. Натяжение
// короткое для вагонетки (сила взрыва растёт со скоростью стрелы).
async function shootAt (bot, ctl, ex, { drawMs = null, shouldStop = null, onDraw = null, anyBow = false }: any = {}) {
  const { shoot } = require('./bow')
  const isCart = ex.name === 'tnt_minecart' && !anyBow
  if (isCart && !flameBow(bot)) return { shot: false, why: 'нет лука с «Огнём»' }
  if (!isCart && !findItem(bot, 'bow')) return { shot: false, why: 'нет лука' }
  if (!arrowsIn(bot)) return { shot: false, why: 'стрел нет' }
  const held = bot.heldItem && bot.heldItem.name === 'bow' ? bot.heldItem : null
  const bow = isCart ? flameBow(bot) : anyBow ? (held || findItem(bot, 'bow')) : (flameBow(bot) || findItem(bot, 'bow'))
  try { if (!bot.heldItem || bot.heldItem !== bow) await bot.equip(bow, 'hand') } catch {}
  const aimY = (ex.height || 1) * 0.5
  const pt = () => ex.position.offset(0, aimY, 0)
  const r = await shoot(bot, ex, {
    point: () => pt(),
    follow: false,
    drawMs: drawMs || (isCart ? CART_DRAW_MS : 1150),
    shouldStop: () => ctl.aborted || ex.isValid === false || (shouldStop && shouldStop()),
    onDraw
  }).catch(e => ({ shot: false, why: e.message }))
  return r
}

// Рельс и вагонетка на клетку: два тика — рельс, потом вагонетка по рельсу
// (MinecartItem.useOn: кликнутый блок — рельс).
async function placeCart (bot, spot) {
  const rIdx = await toHotbar(bot, (it) => !!it && /(^|_)rail$/.test(it.name))
  const cIdx = await toHotbar(bot, (it) => !!it && it.name === 'tnt_minecart')
  if (rIdx < 0 || cIdx < 0) return { ok: false, why: 'рельс или вагонетка не в хотбаре' }
  const before = bot.quickBarSlot
  const cellB = bot.blockAt(spot.cell, false)
  if (!cellB || !/rail$/.test(cellB.name)) {
    if (!(await useOn(bot, rIdx, spot.base))) return { ok: false, why: 'рельс не поставить' }
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 400) { const b = bot.blockAt(spot.cell, false); if (b && /rail$/.test(b.name)) break; await sleep(25) }
  }
  const rail = bot.blockAt(spot.cell, false)
  if (!rail || !/rail$/.test(rail.name)) return { ok: false, why: 'рельса нет' }
  const w = waitSpawn(bot, 'tnt_minecart', spot.cell.offset(0.5, 0, 0.5))
  if (!(await useOn(bot, cIdx, spot.cell))) return { ok: false, why: 'вагонетку не поставить' }
  const cart = await w
  if (bot.quickBarSlot !== before && before >= 0) { try { bot.setQuickBarSlot(before) } catch {} }
  return cart ? { ok: true, cart } : { ok: false, why: 'вагонетка не появилась' }
}

async function placeCrystal (bot, spot) {
  const idx = await toHotbar(bot, (it) => !!it && it.name === 'end_crystal')
  if (idx < 0) return { ok: false, why: 'кристалла нет в хотбаре' }
  const w = waitSpawn(bot, 'end_crystal', spot.cell.offset(0.5, 0, 0.5))
  if (!(await useOn(bot, idx, spot.base))) return { ok: false, why: 'кристалл не поставить' }
  const c = await w
  return c ? { ok: true, crystal: c } : { ok: false, why: 'кристалл не появился' }
}

// Отойти от точки (клавиши, спринт) на ms: прочь от неё, не в яму.
async function backOff (bot, ctl, from, { ms = 900, until = null, stepSafe = null }: any = {}) {
  const t0 = gameClock.now()
  const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  while (gameClock.now() - t0 < ms && !ctl.aborted) {
    if (until && until()) break
    const me = bot.entity.position
    const yaw = Math.atan2(-(me.x - from.x), -(me.z - from.z))
    await bot.look(yaw, 0, true).catch(() => {})
    const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
    const ok = !stepSafe || stepSafe(fwd)
    set('forward', ok); set('sprint', ok && (bot.food ?? 20) > 6); set('back', false); set('left', false); set('right', false)
    await sleep(TICK_MS)
  }
  for (const k of ['forward', 'sprint', 'back', 'left', 'right', 'jump']) set(k, false)
}

// ---------------------------------------------------------------- в бою

// На бой: что взорвать сейчас и от чего уйти. pvp.js зовёт plan() в цикле
// (null — нечего), run() держит тело до выстрела; threat() — его взрывчатка
// рядом со мной, defend() — ответ на неё.
function create (bot: any, { enemy, used = () => {}, crystals = true, telemetryHp = e => healthOf(bot, e) }: any = {}) {
  // crystals: false — кристаллы ведёт crystal.js (2026-09-30), здесь только вагонетки.
  const st: any = { placed: {}, shots: 0, booms: 0, dealt: [], self: 0, kills: 0, defuse: 0, dodges: 0, counter: 0, broken: 0, holes: 0 }
  const mine = new Set<number>() // id своей взрывчатки
  let hpWatch = null
  // Взрывы: сколько блоков выбито (светокамень, стекло) — по blockUpdate рядом
  // с центром в тот же тик.
  const onExplosion = (pkt) => {
    try {
      const c = pkt && (pkt.center || pkt)
      const at = new Vec3(c.x ?? c.center?.x ?? 0, c.y ?? 0, c.z ?? 0)
      st.booms++
      const t0 = gameClock.now()
      const onB = (o, n) => {
        if (gameClock.now() - t0 > 120) { bot.removeListener('blockUpdate', onB); return }
        if (o && n && o.name !== 'air' && n.name === 'air' && o.position.distanceTo(at) < 12) { st.broken++; if (/glowstone/.test(o.name)) st.holes++ }
      }
      bot.on('blockUpdate', onB)
      gameClock.setTimeout(() => bot.removeListener('blockUpdate', onB), 150)
    } catch {}
  }
  try { bot._client.on('explosion', onExplosion) } catch {}
  const close = () => { try { bot._client.removeListener('explosion', onExplosion) } catch {} }

  // Урон ему после нашего взрыва: минимум его здоровья за 1 с.
  const watchHp = (e, why) => {
    const h0 = telemetryHp(e)
    const my0 = bot.health ?? 20
    let low = h0
    const t0 = gameClock.now()
    const iv = gameClock.setInterval(() => {
      const hh = telemetryHp(e)
      if (hh != null && (low == null || hh < low)) low = hh
      if (gameClock.now() - t0 > 1000 || e.isValid === false) {
        gameClock.clearInterval(iv)
        const dealt = h0 == null ? null : e.isValid === false ? h0 : low == null ? null : Math.max(0, h0 - low)
        if (dealt != null) st.dealt.push(r2(dealt))
        st.self = r2(st.self + Math.max(0, my0 - (bot.health ?? 20)))
        if (e.isValid === false || (low != null && low <= 0)) st.kills++
        if (DEBUG) console.log('[boom] итог взрыва', why, JSON.stringify({ dealt: dealt == null ? null : r2(dealt), self: r2(Math.max(0, my0 - (bot.health ?? 20))) }))
      }
    }, 50)
    hpWatch = iv
  }

  return {
    st,
    // Стоит ли что-то взорвать или заминировать сейчас.
    plan (ctx: any = {}) {
      if (!ON || !bot.entity) return null
      const e = enemy()
      if (!e || !e.position || e.isValid === false) return null
      const k = kitOf(bot)
      if (!k.bow || !k.arrows) {
        if (!(k.crystals > 0) || !crystals) return null
      }
      const me = bot.entity.position
      const d = me.distanceTo(e.position)
      const cache = new Map()
      const totem = !!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'totem_of_undying')
      // 1. Уже стоящая взрывчатка у него: стрелой (вагонку — горящей).
      for (const ex of explosives(bot, e.position, 7)) {
        if (ex.name === 'end_crystal' && !crystals) continue
        if (ex.name === 'tnt_minecart' && !k.flame) continue
        if (!k.bow || !k.arrows) continue
        const P = ex.name === 'end_crystal' ? CRYSTAL_P : CART_P_AVG
        const j = judge(bot, e, centerOf(ex), P, { cache })
        const jw = ex.name === 'end_crystal' ? j : judge(bot, e, centerOf(ex), CART_P_MAX, { cache })
        if (worth(j, { totem }) && worth({ ...jw, him: j.him, kill: j.kill }, { totem })) return { kind: 'shoot', ex, j }
      }
      // 2. Кристалл рядом с ним, ударить рукой (2–3 тика), если себе терпимо.
      if (crystals && k.crystals > 0 && d < 6 && ctx.onObsidian !== false) {
        const spots = spotsNear(bot, e.position, { crystal: true, foe: e, maxR: 2 })
        let best = null
        for (const s of spots) {
          const j = judge(bot, e, s.center, CRYSTAL_P, { cache })
          // Ударить сможем: рамка кристалла 2×2×2 над клеткой, рука 3.
          const eye = me.offset(0, EYE, 0)
          const cx = clamp(eye.x, s.center.x - 1, s.center.x + 1); const cy = clamp(eye.y, s.center.y, s.center.y + 2); const cz = clamp(eye.z, s.center.z - 1, s.center.z + 1)
          if (Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz) > REACH - 0.2) continue
          if (!worth(j, { totem })) continue
          const sc = j.him.dmg - j.mine.dmg * 1.5 + (j.kill ? 30 : 0)
          if (!best || sc > best.sc) best = { sc, s, j }
        }
        if (best) return { kind: 'crystal-hit', spot: best.s, j: best.j }
      }
      // 3. Мина: он идёт на нас (или стоит), между нами клетка — рельс и
      //    вагонетка (или кристалл), отходим; взорвём, когда он рядом с ней
      //    (ветка 1 на следующих проходах цикла).
      const closing = ctx.closing || 0
      const busy = !!ctx.busy
      const mineUp = [...mine].some(id => bot.entities[id] && bot.entities[id].isValid !== false)
      if (!mineUp && d > 2.5 && d < 9 && (closing > 0.05 || busy) && k.bow && k.arrows) {
        const mid = me.plus(e.position.minus(me).scaled(busy ? 0.75 : 0.35))
        // Только вагонетка: её рамка 0.7 — стрелы в него идут выше; кристалл
        // (2×2×2) на линии «я → он» ловит свою же стрелу — оба насмерть (замер
        // try-boom «кристалл» 2026-09-26: мина-кристалл между нами, моя стрела
        // в него, 20→0 у обоих).
        const wantCart = k.carts > 0 && k.rails > 0 && k.flame
        const wantCrystal = false
        if (wantCart || wantCrystal) {
          const spots = spotsNear(bot, mid, { crystal: wantCrystal, foe: e, maxR: 1 })
          // Ближе к линии «я → он» и подальше от меня.
          spots.sort((a, b) => b.center.distanceTo(me) - a.center.distanceTo(me))
          const s = spots[0]
          if (s) return { kind: wantCart ? 'mine-cart' : 'mine-crystal', spot: s }
        }
      }
      return null
    },
    async run (ctl, p, ctx: any = {}) {
      const e = enemy()
      const out = { ok: false, note: '' }
      if (p.kind === 'shoot') {
        const r = await shootAt(bot, ctl, p.ex, { shouldStop: () => ctx.stop && ctx.stop() })
        out.ok = !!r.shot
        if (r.shot) { st.shots++; watchHp(e, p.ex.name) }
        out.note = r.shot ? `взрывчатка: стрела в ${p.ex.name === 'end_crystal' ? 'кристалл' : 'вагонетку с TNT'} у него (прогноз ему ${p.j.him.dmg}, себе ${p.j.mine.dmg}${p.j.off ? ', толчок в яму' : ''})` : `взрывчатка: не выстрелил (${r.why || '?'})`
        return out
      }
      if (p.kind === 'crystal-hit') {
        const pc: any = await placeCrystal(bot, p.spot)
        if (!pc.ok) { out.note = 'кристалл: ' + pc.why; return out }
        st.placed.crystal = (st.placed.crystal || 0) + 1
        // Удар в тот же тик, как появился: честно — в прицеле (pick.canHit).
        let hit = false
        const t0 = gameClock.now()
        while (gameClock.now() - t0 < 250 && !hit) {
          if (pc.crystal.isValid === false) break
          if (hitReach(bot, pc.crystal) <= REACH) {
            await bot.lookAt(pc.crystal.position.offset(0, 1, 0), true).catch(() => {})
            try { bot.attack(pc.crystal) } catch {}
            hit = true
          } else await sleep(TICK_MS)
        }
        if (hit) { st.shots++; watchHp(e, 'end_crystal') }
        out.ok = hit
        out.note = hit ? `кристалл у его ног и удар (прогноз ему ${p.j.him.dmg}, себе ${p.j.mine.dmg}${p.j.off ? ', толчок в яму' : ''})` : 'кристалл поставил, ударить не успел'
        if (!hit) mine.add(pc.crystal.id)
        return out
      }
      if (p.kind === 'mine-cart' || p.kind === 'mine-crystal') {
        const pr: any = p.kind === 'mine-cart' ? await placeCart(bot, p.spot) : await placeCrystal(bot, p.spot)
        if (!pr.ok) { out.note = 'мина: ' + pr.why; return out }
        const ex = pr.cart || pr.crystal
        mine.add(ex.id)
        st.placed[p.kind === 'mine-cart' ? 'cart' : 'crystal'] = (st.placed[p.kind === 'mine-cart' ? 'cart' : 'crystal'] || 0) + 1
        // Отойти от мины, пока он идёт к ней; выйти, как только прогноз
        // говорит «стоит взрывать» (ветка 1 в следующем проходе цикла).
        const P = ex.name === 'end_crystal' ? CRYSTAL_P : CART_P_MAX
        await backOff(bot, ctl, ex.position, {
          ms: 1400,
          stepSafe: ctx.stepSafe,
          until: () => {
            if (!e || e.isValid === false) return true
            const j = judge(bot, e, centerOf(ex), P, {})
            return bot.entity.position.distanceTo(ex.position) > 6.5 && worth(j, {})
          }
        })
        out.ok = true
        out.note = `мина: ${ex.name === 'end_crystal' ? 'кристалл' : 'рельс и вагонетка с TNT'} между нами, отошёл`
        return out
      }
      return out
    },
    // Его взрывчатка у меня: вагонетка в руке — разобрать ударом; кристалл
    // ближе к нему, чем ко мне, и урон ему больше — ударить первым; иначе —
    // отойти, пока прогноз не станет терпимым.
    threat () {
      if (!bot.entity) return null
      const e = enemy()
      const me = bot.entity.position
      let worst = null
      for (const ex of explosives(bot, me, 12)) {
        if (mine.has(ex.id)) continue
        if (ex.name === 'end_crystal' && !crystals) continue
        const P = BOOMS[ex.name]
        const my = blast(bot, centerOf(ex), P, me, { def: defenseOf(bot, bot.entity) })
        if (my.dmg < 3) continue
        if (!worst || my.dmg > worst.my.dmg) worst = { ex, my, P }
      }
      if (!worst) return null
      if (e && e.position) {
        worst.his = blast(bot, centerOf(worst.ex), worst.P, e.position, { def: defenseOf(bot, e) })
      }
      return worst
    },
    async defend (ctl, t, ctx: any = {}) {
      const ex = t.ex
      const reach = hitReach(bot, ex)
      if (ex.name === 'tnt_minecart' && reach <= REACH - 0.1) {
        await bot.lookAt(ex.position.offset(0, 0.35, 0), true).catch(() => {})
        try { bot.attack(ex) } catch {}
        st.defuse++
        return 'разобрал его вагонетку с TNT ударом'
      }
      const myHp = (bot.health ?? 20) + absorptionOf(bot, bot.entity)
      // Вагонетка дальше руки, а лук есть: простая стрела её разбирает
      // (урон стрелы ×10 > 40 → destroy, стрела не горит — предметом); лук с
      // «Огнём» — взрывает: только если ему от этого больнее, чем мне.
      if (ex.name === 'tnt_minecart' && findItem(bot, 'bow') && arrowsIn(bot) && bot.entity.position.distanceTo(ex.position) < 24) {
        const fl = !!flameBow(bot)
        const ok = !fl || (t.his && t.his.dmg > t.my.dmg + 4 && t.my.dmg < myHp - 4)
        const plain = bot.inventory.items().find(i => i.name === 'bow' && require('./read').enchLevel(bot, i, 'flame') === 0)
        if (ok || plain) {
          const useBow = (plain && !(fl && ok)) ? plain : (flameBow(bot) || plain)
          try { if (useBow && bot.heldItem !== useBow) await bot.equip(useBow, 'hand') } catch {}
          const r = await shootAt(bot, ctl, ex, { drawMs: 700, anyBow: true })
          if (r.shot) { if (fl && ok && !plain) { st.counter++; const e = enemy(); if (e) watchHp(e, 'counter') } else st.defuse++ }
          if (r.shot) return fl && ok && !plain ? 'стрелой взорвал его вагонетку — ему ближе' : 'сбил его вагонетку стрелой'
        }
      }
      if (ex.name === 'end_crystal' && reach <= REACH - 0.1 && t.his && t.his.dmg > t.my.dmg + 4 && t.my.dmg < myHp - 4) {
        await bot.lookAt(ex.position.offset(0, 1, 0), true).catch(() => {})
        try { bot.attack(ex) } catch {}
        st.counter++
        const e = enemy()
        if (e) watchHp(e, 'counter')
        return 'ударил его кристалл первым — ему больнее'
      }
      // Уходить — только если он может взорвать сейчас: лук или арбалет в руке
      // (вагонетку — горящей стрелой), у кристалла — ещё и рукой, если достаёт.
      // Иначе вагонетку рядом — подойти и разобрать ударом; кристалл — не
      // трогать (бой идёт дальше). Раньше уходил от любой (замер try-boom
      // «мина»: 25 уходов за раунд, стоял в стороне, пока в него стреляли).
      const e = enemy()
      const hand = e && e.equipment && e.equipment[0] ? e.equipment[0].name : ''
      const canShoot = /^(bow|crossbow)$/.test(hand)
      const canHit = ex.name === 'end_crystal' && e && e.position && e.position.distanceTo(ex.position) < 4.2
      const hurts = t.my.dmg >= Math.max(4, myHp * 0.3)
      if (!(canShoot || canHit) || !hurts) {
        const dd = bot.entity.position.distanceTo(ex.position)
        if (ex.name === 'tnt_minecart' && dd < 6) {
          const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
          await bot.lookAt(ex.position.offset(0, 0.35, 0), true).catch(() => {})
          set('forward', !ctx.stepSafe || ctx.stepSafe({ x: -Math.sin(bot.entity.yaw), z: -Math.cos(bot.entity.yaw) }))
          await sleep(TICK_MS * 2)
          set('forward', false)
          if (hitReach(bot, ex) <= REACH - 0.1) { try { bot.attack(ex) } catch {} st.defuse++; return 'подошёл и разобрал его вагонетку с TNT' }
          return 'иду разобрать его вагонетку с TNT'
        }
        return null
      }
      await backOff(bot, ctl, ex.position, {
        ms: 600,
        stepSafe: ctx.stepSafe,
        until: () => blast(bot, centerOf(ex), t.P, bot.entity.position, { def: defenseOf(bot, bot.entity) }).dmg < 2.5
      })
      st.dodges++
      return `ухожу от его ${ex.name === 'end_crystal' ? 'кристалла' : 'взрывчатки'} (прогноз ${t.my.dmg})`
    },
    report () {
      const avg = st.dealt.length ? r2(st.dealt.reduce((s, x) => s + x, 0) / st.dealt.length) : undefined
      const out = {
        placed: Object.keys(st.placed).length ? st.placed : undefined,
        shots: st.shots || undefined,
        booms: st.booms || undefined,
        dealt: st.dealt.length ? st.dealt : undefined,
        avg,
        self: st.self || undefined,
        kills: st.kills || undefined,
        defuse: st.defuse || undefined,
        counter: st.counter || undefined,
        dodges: st.dodges || undefined,
        broken: st.broken || undefined,
        holes: st.holes || undefined
      }
      // Взрывы без взрывчатки (заряды ветра тоже шлют explosion) — не в отчёт.
      const active = out.placed || out.shots || out.defuse || out.counter || out.dodges || out.kills
      return active ? out : undefined
    },
    close () { close(); if (hpWatch) { /* пусть досчитает */ } }
  }
}

module.exports = { ON, create, blast, seenPercent, segmentBlocked, defenseOf, judge, worth, spotsNear, explosives, kitOf, hasBoom, placeCart, placeCrystal, shootAt, CRYSTAL_P, CART_P_MAX, CART_P_AVG }
