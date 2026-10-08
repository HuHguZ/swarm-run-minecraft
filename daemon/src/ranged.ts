'use strict'
const gameClock = require('./game-clock')
const afterMovePacket = require('./edges').afterPacket
const { AsyncResource } = require('node:async_hooks')
// Арбалет, фейерверки и выбор стрел (PVP-RESEARCH б.4, б.5, б.14, в.5, в.11;
// просьба 2026-09-26: «все приёмы про-игроков, по максимуму того, что даёт
// версия»). Раньше бой искал только лук: арбалет в рюкзаке лежал мёртвым
// грузом, а стрелы уходили какие попадутся.
//
// Код игры — декомпилированный клиент 1.21.11 (github extremeheat/
// extracted_minecraft_data, ветка client1.21.11, пути от net/minecraft/):
//  * world/item/CrossbowItem: заряд floor((1.25 − 0.25·«Быстрая перезарядка»)·20)
//    = 25/20/15/10 тиков (getChargeDuration); снаряд кладётся в onUseTick, когда
//    (тики в ходу)/заряд ≥ 1, и ещё раз проверяется на отпускании
//    (LivingEntity.releaseUsingItem → updatingUsingItem); заряженный стреляет
//    следующим use_item сразу (use → performShooting), а поворот сервер берёт
//    из самого пакета use_item (ServerGamePacketListenerImpl.handleUseItem:
//    absSnapRotationTo) — mineflayer кладёт туда текущий взгляд;
//  * скорость: стрела 3.15, фейерверк 1.6 (getShootingPower), разброс 1.0
//    (Projectile.getMovementToShoot: треугольник ±0.0172·1.0); shootProjectile →
//    Projectile.shoot — своё движение стрелка НЕ прибавляется (у лука
//    прибавляется: BowItem → shootFromRotation);
//  * стрела из арбалета у игрока всегда крит (ProjectileWeaponItem.createProjectile:
//    setCritArrow(true)): ceil(3.15·2) = 7 + rand(0..4), появляется на глазах − 0.1
//    (AbstractArrow), физика стрелы та же, что у лука (гравитация 0.05, трение 0.99);
//  * «Тройной выстрел» — ещё 2 снаряда под ±10° вокруг вертикали
//    (ProjectileWeaponItem.shoot, processProjectileSpread), лишние не подобрать;
//  * «Пронзание» — у стрелы pierce_level > 0, и щит не блокирует её вовсе
//    (LivingEntity.applyItemBlocking: getPierceLevel() > 0 → 0);
//  * фейерверк (world/entity/projectile/FireworkRocketEntity): вылет с глаз − 0.15,
//    shotAtAngle — летит по прямой без гравитации и трения; жизнь 10·(1 + flight)
//    + rand(0..5) + rand(0..6) тиков; взрыв при попадании в сущность, в блок (если
//    есть звёзды) или в конце жизни: 5 + 2·звёзд всем живым в 5 блоках с прямой
//    видимостью, × √((5 − d)/5) — и нам тоже; 3 прочности арбалета за выстрел;
//  * боеприпас (world/entity/player/Player.getProjectile): сперва левая рука,
//    потом правая (getHeldProjectile: у арбалета — стрелы или фейерверк), потом
//    рюкзак по порядку 0..35 (хотбар, затем рюкзак) — только стрелы
//    (getAllSupportedProjectiles = ARROW_ONLY). Фейерверк в арбалет — только из
//    левой руки; какую стрелу возьмёт лук или арбалет — решает порядок слотов;
//  * стрелы с эффектом (world/entity/projectile/arrow/Arrow.doPostHurtEffects):
//    эффект зелья × 0.125 длительности (Items.TIPPED_ARROW: potion_duration_scale);
//    вред — мгновенный, по кадрам неуязвимости после самой стрелы проходит только
//    12 − (урон стрелы до брони) (LivingEntity.hurtServer: invulnerableTime > 10 —
//    урон сверх lastHurt); магия мимо брони.

const Vec3 = require('vec3')
const bowMod = require('./bow')
const pick = require('./pick')
const read = require('./read')
const assess = require('./assess')
const { sleep } = require('./movement')

const TICK_MS = 50
const ARROW_SPEED = Math.fround(3.15) // CrossbowItem.getShootingPower returns float.
const ROCKET_SPEED = 1.6
const ARROW_DROP = 0.1
const ROCKET_DROP = 0.15
const GRAVITY = 0.05
const BLAST_R = 5
const MULTI_DEG = 10
const ARROW_RE = /^(arrow|tipped_arrow|spectral_arrow)$/
const OFF = 45

// Порядок реестра зелий (world/item/alchemy/Potions.java 1.21.11): компонент
// potion_contents несёт номер.
const POTIONS = [
  'water', 'mundane', 'thick', 'awkward', 'night_vision', 'long_night_vision',
  'invisibility', 'long_invisibility', 'leaping', 'long_leaping', 'strong_leaping',
  'fire_resistance', 'long_fire_resistance', 'swiftness', 'long_swiftness',
  'strong_swiftness', 'slowness', 'long_slowness', 'strong_slowness',
  'turtle_master', 'long_turtle_master', 'strong_turtle_master', 'water_breathing',
  'long_water_breathing', 'healing', 'strong_healing', 'harming', 'strong_harming',
  'poison', 'long_poison', 'strong_poison', 'regeneration', 'long_regeneration',
  'strong_regeneration', 'strength', 'long_strength', 'strong_strength',
  'weakness', 'long_weakness', 'luck', 'slow_falling', 'long_slow_falling',
  'wind_charged', 'weaving', 'oozing', 'infested'
]

function tippedPotion (item) {
  if (!item || item.name !== 'tipped_arrow') return null
  try {
    const c = item.componentMap && item.componentMap.get('potion_contents')
    const d = c && c.data
    const raw = d && (d.potionId ?? d.potion ?? d.id)
    if (typeof raw === 'number') return POTIONS[raw] || null
    if (typeof raw === 'string') return raw.replace(/^minecraft:/, '')
  } catch {}
  return null
}
// Вид стрелы: 'arrow', 'spectral' или имя зелья стрелы с эффектом.
function arrowKind (item) {
  if (!item) return null
  if (item.name === 'arrow') return 'arrow'
  if (item.name === 'spectral_arrow') return 'spectral'
  if (item.name === 'tipped_arrow') return tippedPotion(item) || 'tipped'
  return null
}
const base = (k) => String(k || '').replace(/^(long|strong)_/, '')

function chargeTicks (qc) { return Math.max(0, Math.floor((1.25 - 0.25 * (qc || 0)) * 20)) }

function crossbows (bot) {
  const out = []
  const all = [...bot.inventory.items()]
  const off = bot.inventory.slots[OFF]
  if (off && off.name === 'crossbow') all.push(off)
  for (const it of all) {
    if (it.name !== 'crossbow') continue
    const info = read.crossbowInfo(bot, it)
    if (info) out.push({ item: it, info })
  }
  return out
}
function arrowCount (bot) { return bot.inventory.items().reduce((n, i) => n + (ARROW_RE.test(i.name) ? i.count : 0), 0) }
// Ракета для арбалета — с наибольшим числом звёзд; пустая (для элитр, 0 звёзд)
// не ранит вовсе (FireworkRocketEntity.dealExplosionDamage) — не годится.
function rocketsOf (bot) {
  const off = bot.inventory.slots[OFF]
  let best = null
  for (const it of [off, ...bot.inventory.items()]) {
    if (!it || it.name !== 'firework_rocket') continue
    if (rocketStars(it) > (best ? rocketStars(best) : 0)) best = it
  }
  return best
}
// Звёзд в ракете (компонент fireworks { flightDuration, explosions: [...] }).
function rocketStars (item) {
  try {
    const c = item && item.componentMap && item.componentMap.get('fireworks')
    return (c && c.data && c.data.explosions && c.data.explosions.length) || 0
  } catch { return 0 }
}

// Порядок, в каком сервер ищет стрелу в рюкзаке: контейнер 0..35 — это хотбар
// (окно 36..44), затем рюкзак (окно 9..35).
function containerOrder () {
  const out = []
  for (let i = 36; i <= 44; i++) out.push(i)
  for (let i = 9; i <= 35; i++) out.push(i)
  return out
}
function firstArrow (bot) {
  const off = bot.inventory.slots[OFF]
  if (off && ARROW_RE.test(off.name)) return off
  for (const s of containerOrder()) {
    const it = bot.inventory.slots[s]
    if (it && ARROW_RE.test(it.name)) return it
  }
  return null
}
const sameKind = (a, b) => !!a && !!b && a.name === b.name && arrowKind(a) === arrowKind(b)

// Поставить выбранную пачку первой в порядке поиска: поменять местами с той,
// что первая сейчас (два-три клика окна; курсор должен быть пуст).
async function readyArrow (bot, want) {
  if (!want) return false
  const first = firstArrow(bot)
  if (!first || sameKind(first, want) || first.slot === want.slot) return true
  if (first.slot === OFF) return false
  if (bot.currentWindow || bot.inventory.selectedItem) return false
  try { await bot.moveSlotItem(want.slot, first.slot) } catch { return false }
  const now = firstArrow(bot)
  return !!now && sameKind(now, want)
}

// Какую стрелу пустить. ctx: { d, fs (read.state), running, heavyArmor,
// strongHitter, forCrossbow }. Порядок — как у про-игроков: добить — вредом;
// убегает — медлительностью; сильно бьёт — слабостью; яд — издалека; иначе
// обычная, редкие не тратить.
function pickArrow (bot, ctx: any = {}) {
  const stacks = []
  const off = bot.inventory.slots[OFF]
  for (const it of [...bot.inventory.items(), ...(off ? [off] : [])]) if (ARROW_RE.test(it.name)) stacks.push(it)
  if (!stacks.length) return null
  const find = (test) => stacks.find(i => test(arrowKind(i)))
  const fs = ctx.fs || {}
  const eff = fs.effects || new Set()
  const plain = find(k => k === 'arrow') || find(k => k === 'spectral')
  const harm = !ctx.forCrossbow && find(k => base(k) === 'harming')
  // Нежить вред лечит (Harming → instant health у нежити): только по игрокам.
  const harmOk = harm && ctx.player !== false
  if (harmOk) {
    const kill = fs.ehp != null && fs.ehp <= (/strong_/.test(arrowKind(harm)) ? 12 : 6) + 2
    if ((fs.popAgo ?? Infinity) < read.TOTEM_WINDOW_MS || kill) {
      return { item: harm, why: kill ? 'вред — добить' : 'вред — после его тотема', harm: true }
    }
  }
  const slow = find(k => base(k) === 'slowness')
  if (slow && ctx.running && !eff.has('slowness')) return { item: slow, why: 'медлительность — он убегает' }
  const weak = find(k => base(k) === 'weakness')
  if (weak && ctx.strongHitter && !eff.has('weakness')) return { item: weak, why: 'слабость — он сильно бьёт' }
  // Вред коротким натяжением мимо брони (замер try-xbow tipped: 9.7–9.9 за
  // стрелу и по алмазу, и по железу, а полная обычная по алмазу — 2–3).
  if (harmOk && ctx.heavyArmor && (ctx.d || 99) <= 14) return { item: harm, why: 'вред — мимо брони', harm: true }
  const poison = find(k => base(k) === 'poison')
  if (poison && ctx.player !== false && !eff.has('poison') && !eff.has('regeneration') && (ctx.d || 0) >= 8) return { item: poison, why: 'яд издалека' }
  if (slow && !eff.has('slowness') && (ctx.d || 0) >= 10 && !plain) return { item: slow, why: 'медлительность' }
  if (plain) return { item: plain, why: null }
  return { item: stacks[0], why: null }
}

// Вред с коротким натяжением (PVP-RESEARCH б.14): сила лука (f²+2f)/3 при f =
// тики/20 (BowItem.getPowerForTime), урон стрелы ceil(3·сила·2) до брони, и вред II
// проходит сверх него: 12 − урон. Натяжение ~0.45 с даёт стрелу 2–3 хп и ~9–10
// магией мимо брони; держим там, где такая стрела ещё долетает.
function harmDrawMs (d) {
  if (d <= 7) return 400
  if (d <= 11) return 500
  if (d <= 15) return 600
  return 0 // дальше — полное натяжение
}
function bowPower (ticks) { const f = Math.min(1, ticks / 20); return Math.min(1, (f * f + 2 * f) / 3) }

// Урон по нему после брони: стрела арбалета (всегда крит, ~8.75 в среднем) или
// взрыв фейерверка при прямом попадании (d ≈ 1 → × √0.8).
// Чары его брони (арена с чарами, 2026-09-26): «Защита» — 1 EPF за уровень на
// куске, «Защита от снарядов» — 2 от стрелы, «Взрывоустойчивость» — 2 от
// фейерверка (fireworks в #is_explosion); урон ×(1 − EPF/25), EPF ≤ 20
// (CombatRules.getDamageAfterMagicAbsorb). Без них «добиваю» стрелял по
// зачарованной броне, когда выстрел уже не добивал.
function expectedDamage (bot, e, kind, stars = 3) {
  const eq = (e && e.equipment) || []
  const armor = eq.slice(2)
  const g = assess.gearOf(armor)
  if (kind === 'firework' && !(stars > 0)) return 0
  const raw = kind === 'firework' ? (5 + 2 * stars) * Math.sqrt(0.8) : 8.75
  const special = kind === 'firework' ? 'blast_protection' : 'projectile_protection'
  const epf = Math.min(20, armor.reduce((s, it) => s + (it ? read.enchLevel(bot, it, 'protection') + 2 * read.enchLevel(bot, it, special) : 0), 0))
  return assess.afterArmor(raw, g.armor, g.tough) * (1 - epf / 25)
}

// Точка прицела с упреждением: его позиция + скорость × тики, высота frac роста.
function lead (entity, velFn, frac = 0.55, bot = null) {
  return bowMod.leadTarget(entity, velFn, bot, frac)
}
// Фейерверк: прямая без гравитации, упреждение итерацией времени полёта.
function rocketAim (from, targetAt) {
  let P = targetAt(0)
  let t = from.distanceTo(P) / ROCKET_SPEED
  for (let i = 0; i < 4; i++) { P = targetAt(t); t = from.distanceTo(P) / ROCKET_SPEED }
  const dx = P.x - from.x; const dy = P.y - from.y; const dz = P.z - from.z
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)), ticks: t, at: P, dist: Math.hypot(dx, dy, dz) }
}
// Первый блок на прямой from → yaw/pitch в пределах len (или null).
function rayBlock (bot, from, yaw, pitch, len) {
  const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  try {
    const hit = bot.world.raycast(from, dir, len, b => b && b.boundingBox === 'block')
    if (!hit) return null
    const at = hit.intersect || hit.position.offset(0.5, 0.5, 0.5)
    return { pos: hit.position, at, dist: from.distanceTo(at) }
  } catch { return null }
}
// Взрыв не по нам: точка взрыва (у него или у первой стены) дальше 5.4 от наших
// ног — и так же для боковых ракет «Тройного выстрела» (±10°), которые уходят
// мимо и могут встретить стену рядом с нами.
function rocketSafe (bot, from, sol, multishot) {
  const feet = bot.entity.position
  const blast = (pt) => pt.distanceTo(feet) >= BLAST_R + 0.4
  const wall = rayBlock(bot, from, sol.yaw, sol.pitch, sol.dist)
  const P = wall ? wall.at : sol.at
  if (!blast(P)) return { ok: false, why: wall ? 'стена рядом — взрыв по мне' : 'он слишком близко для фейерверка' }
  if (multishot) {
    for (const s of [-1, 1]) {
      const w = rayBlock(bot, from, sol.yaw + s * MULTI_DEG * Math.PI / 180, sol.pitch, 12)
      if (w && !blast(w.at)) return { ok: false, why: 'боковая ракета упрётся в стену рядом' }
    }
  }
  return { ok: true, wall: !!wall }
}

// Фейерверк в обход его щита (s7b 06.10, javap 1.21.11 FireworkRocketEntity.dealExplosionDamage): урон
// (5 + 2·звёзд)·√((5 − d)/5) всем в 5 бл. с прямой видимостью от ракеты; щит (BlocksAttacks 90°) держит, только
// если точка взрыва (позиция ракеты — источник урона) у него спереди. Поэтому — в пол сбоку-сзади от него: луч из
// наших глаз до точки не задевает его рамку (+0.45), первым упирается в пол у точки; угол от его взгляда > 95°.
// { point, dist, raw } или null.
function shieldBypassPoint (bot, entity, from, stars = 3) {
  const p = entity.position
  const ux = from.x - p.x; const uz = from.z - p.z
  const ul = Math.hypot(ux, uz) || 1
  const u = { x: ux / ul, z: uz / ul }
  const n = { x: -u.z, z: u.x }
  const view = { x: -Math.sin(entity.yaw || 0), z: -Math.cos(entity.yaw || 0) }
  const box = { lo: { x: p.x - 0.75, y: p.y - 0.15, z: p.z - 0.75 }, hi: { x: p.x + 0.75, y: p.y + 2.0, z: p.z + 0.75 } }
  let best = null
  for (const side of [1, -1]) {
    for (const [s, b] of [[1.4, 0.8], [1.6, 0.5], [1.3, 1.2], [1.8, 0.9]]) {
      const pt = new Vec3(p.x + n.x * s * side - u.x * b, Math.floor(p.y + 0.01) + 0.02, p.z + n.z * s * side - u.z * b)
      const hx = pt.x - p.x; const hz = pt.z - p.z
      if ((hx * view.x + hz * view.z) / Math.hypot(hx, hz) > -0.087) continue
      const dist = Math.hypot(hx, pt.y - p.y, hz)
      if (dist >= BLAST_R - 0.5) continue
      const delta = pt.minus(from); const len = delta.norm()
      const d = delta.scaled(1 / len)
      if (pick.rayBox(from, d, box.lo, box.hi, len) != null) continue
      const hit = pick.blockOnRay(bot, from, d, len + 0.6)
      if (!hit || hit.t < len - 0.35 || hit.pos.y !== Math.floor(pt.y) - 1) continue
      const raw = (5 + 2 * stars) * Math.sqrt((BLAST_R - dist) / BLAST_R)
      if (!best || raw > best.raw) best = { point: pt, dist: Math.round(dist * 100) / 100, raw: Math.round(raw * 10) / 10 }
    }
  }
  return best
}

function hotbarOf (bot, item) {
  for (let i = 0; i < 9; i++) {
    const it = bot.inventory.slots[36 + i]
    if (it && item && it.slot === item.slot) return i
  }
  return -1
}
// Нужный арбалет — в хотбар (выстрел сменой слота в одном тике).
async function toHotbar (bot, item) {
  const h = hotbarOf(bot, item)
  if (h >= 0) return h
  if (!item || item.slot == null || item.slot === OFF) return -1
  if (bot.currentWindow || bot.inventory.selectedItem) return -1
  let dest = -1
  for (let i = 0; i < 9; i++) if (i !== bot.quickBarSlot && !bot.inventory.slots[36 + i]) { dest = i; break }
  if (dest < 0) {
    const KEEP = /_(sword|axe|spear)$|^(mace|bow|crossbow|totem_of_undying|shield|wind_charge|ender_pearl|golden_apple|enchanted_golden_apple|water_bucket)$/
    for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && !KEEP.test(s.name)) { dest = i; break } }
  }
  if (dest < 0) return -1
  try { await bot.moveSlotItem(item.slot, 36 + dest) } catch { return -1 }
  const it = bot.inventory.slots[36 + dest]
  return it && it.name === 'crossbow' ? dest : -1
}

// Сделать fn сразу после пакета позиции этого тика (как mace.afterPacket: при
// отставании mineflayer гонит два тика физики подряд, и setImmediate срабатывал
// уже после следующего пакета).
function afterPacket (bot, fn) {
  afterMovePacket(bot, fn)
}

// ---------------------------------------------------------------- зарядка
//
// Зарядить арбалет: в правую руку, «использовать», держать, пока в предмете не
// появится снаряд (сервер пришлёт слот), отпустить. Фейерверк — из левой руки:
// на время зарядки он туда, прежнее (щит, тотем) — обратно.
async function load (bot, ctl, item, { ammo = 'arrow', abortIf = null, arrow = null, onTick = null }: any = {}) {
  const t0 = gameClock.now()
  const info = read.crossbowInfo(bot, item)
  if (!info) return { ok: false, why: 'не арбалет' }
  if (info.loaded) return { ok: true, already: true, ms: 0 }
  let restoreOff = null
  if (ammo === 'firework') {
    const rockets = rocketsOf(bot)
    if (!rockets) return { ok: false, why: 'фейерверков со звёздами нет' }
    const off = bot.inventory.slots[OFF]
    // Сервер заряжает ракету из левой руки — там должна быть именно эта (со звёздами).
    if (!off || off.name !== 'firework_rocket' || rocketStars(off) < rocketStars(rockets)) {
      if (bot.currentWindow || bot.inventory.selectedItem) return { ok: false, why: 'курсор занят' }
      try { await bot.equip(rockets, 'off-hand') } catch (e) { return { ok: false, why: 'ракеты в левую: ' + e.message } }
      if (off && off.name !== 'firework_rocket') restoreOff = off.name
    }
  } else {
    if (!arrowCount(bot)) return { ok: false, why: 'стрел нет' }
    if (arrow) await readyArrow(bot, arrow)
  }
  const restore = async () => {
    if (!restoreOff) return
    const back = bot.inventory.items().find(i => i.name === restoreOff)
    if (back) { try { await bot.equip(back, 'off-hand') } catch {} }
  }
  try {
    const cur = bot.inventory.items().find(i => i.slot === item.slot && i.name === 'crossbow') || item
    if (!bot.heldItem || bot.heldItem.slot !== cur.slot) {
      // Именно этот арбалет — слотом хотбара: bot.equip по имени брал ПЕРВЫЙ арбалет, то есть заряженный, и
      // «использовать» стреляло им в никуда (s7e «арбалет» р.1: «зарядил (0 мс)» ×301 — второй так и не заряжался).
      let hb = hotbarOf(bot, cur)
      if (hb < 0) hb = await toHotbar(bot, cur)
      if (hb >= 0) { if (bot.quickBarSlot !== hb) bot.setQuickBarSlot(hb) } else { try { await bot.equip(cur, 'hand') } catch (e) { return { ok: false, why: 'арбалет в руку: ' + e.message } } }
    }
    if (!bot.heldItem || bot.heldItem.slot !== cur.slot) return { ok: false, why: 'в руке не тот арбалет' }
    const heldInfo = read.crossbowInfo(bot, bot.heldItem)
    if (heldInfo && heldInfo.loaded) return { ok: false, why: 'в руке заряженный — «использовать» выстрелило бы' }
    const ticks = chargeTicks(info.quickCharge)
    bot.activateItem()
    const limit = gameClock.now() + (ticks + 8) * TICK_MS + 250
    let loaded = false
    while (gameClock.now() < limit) {
      if (ctl && ctl.aborted) break
      const held = bot.heldItem
      const hi = held && held.name === 'crossbow' ? read.crossbowInfo(bot, held) : null
      if (hi && hi.loaded) { loaded = true; break }
      if (abortIf && abortIf()) break
      if (onTick) { try { onTick() } catch {} }
      await sleep(TICK_MS)
    }
    bot.deactivateItem()
    for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) { try { bot.setControlState(k, false) } catch {} }
    if (!loaded) {
      // Отпускание само кладёт снаряд, если заряд уже полный.
      await sleep(120)
      const hi = bot.heldItem && bot.heldItem.name === 'crossbow' ? read.crossbowInfo(bot, bot.heldItem) : null
      loaded = !!(hi && hi.loaded)
    }
    return { ok: loaded, ms: gameClock.now() - t0, ammo, why: loaded ? null : 'не зарядился' }
  } finally {
    await restore()
  }
}

// ---------------------------------------------------------------- выстрел
//
// Финальный прицел — на позднем physicTick перед пакетом движения.
// На ndMovementSent: слот арбалета → use_item → слот назад, в том же кадре.
async function fire (bot, entity, item, { velFn = null, frac = null, onHit = null, point = null, shouldStop = null, traceAim = false }: any = {}) {
  const info = read.crossbowInfo(bot, item)
  if (!info || !info.loaded) return { fired: false, why: 'не заряжен' }
  let hb = hotbarOf(bot, item)
  if (hb < 0) hb = await toHotbar(bot, item)
  if (hb < 0) return { fired: false, why: 'арбалет не в хотбаре' }
  return new Promise<any>(resolve => {
    const rocket = info.ammo === 'firework'
    let done = false
    const onT = AsyncResource.bind(() => {
      if (done) return
      const stopped = shouldStop?.()
      if (!stopped && !point && !bowMod.hasObservedVelocity(entity)) return
      done = true
      gameClock.clearTimeout(timer)
      bot.removeListener('physicTick', onT)
      if (stopped) return resolve({ fired: false, why: 'выстрел отменён' })
      const from = pick.eyeOf(bot).offset(0, -(rocket ? ROCKET_DROP : ARROW_DROP), 0)
      let sol = null
      let observation = null
      // Refresh an arrow's observation once after the first solve/LOS work.
      // Both paths must pass collision checks; no guessed network coefficient.
      for (let pass = 0; pass < (rocket ? 1 : 2); pass++) {
        const velocity = velFn ? velFn() : bowMod.observedVelocity(entity)
        observation = traceAim ? { at: gameClock.serverNow(), position: { ...entity.position }, velocity: { ...velocity }, grounded: entity.onGround, solvedAt: null, checkedAt: null, releasedAt: null } : null
        let target = point || lead(entity, () => velocity, frac ?? (rocket ? 0.4 : 0.55), bot)
        if (observation) target = bowMod.traceTarget(target, observation)
        if (rocket) {
          sol = rocketAim(from, target)
          const safe = rocketSafe(bot, from, sol, info.multishot)
          if (!safe.ok) return resolve({ fired: false, why: safe.why })
        } else {
          sol = bowMod.aim(from, target, ARROW_SPEED, GRAVITY)
          if (observation) observation.solvedAt = gameClock.serverNow()
          if (!sol) return resolve({ fired: false, why: 'не долетит' })
          const wall = bowMod.blockedAt(bot, from, sol, { x: 0, y: 0, z: 0 }, ARROW_SPEED)
          if (wall) return resolve({ fired: false, blocked: true, why: `на линии блок ${wall.x},${wall.y},${wall.z}` })
        }
        if (observation) observation.checkedAt = gameClock.serverNow()
      }
      bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      afterPacket(bot, () => {
        if (shouldStop?.()) return resolve({ fired: false, why: 'выстрел отменён' })
        if (!point && !bowMod.hasObservedVelocity(entity)) return resolve({ fired: false, why: 'скорость цели ещё не наблюдалась' })
        if (observation) observation.releasedAt = gameClock.serverNow()
        const back = bot.quickBarSlot
        // Журнал выстрела (ND_DEBUG_XBOW=1): куда целились, где он был, какое
        // упреждение, и чем ушёл use_item (взгляд в пакете — bot.entity.yaw/pitch
        // в этот миг: если его перебил другой таймер, стрела ушла не туда).
        const shotLog: any = process.env.ND_DEBUG_XBOW ? {
          t: gameClock.now(), d: Math.round(from.distanceTo(entity.position) * 10) / 10,
          me: [+bot.entity.position.x.toFixed(2), +bot.entity.position.y.toFixed(2), +bot.entity.position.z.toFixed(2)],
          him: [+entity.position.x.toFixed(2), +entity.position.y.toFixed(2), +entity.position.z.toFixed(2)],
          vel: (() => { const v = velFn ? velFn() : { x: 0, y: 0, z: 0 }; return [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] })(),
          at: sol.at ? [+sol.at.x.toFixed(2), +sol.at.y.toFixed(2), +sol.at.z.toFixed(2)] : null,
          ticks: Math.round((sol.ticks || 0) * 10) / 10,
          aim: [+(sol.yaw * 180 / Math.PI).toFixed(2), +(sol.pitch * 180 / Math.PI).toFixed(2)],
          sent: [+(bot.entity.yaw * 180 / Math.PI).toFixed(2), +(bot.entity.pitch * 180 / Math.PI).toFixed(2)]
        } : null
        try {
          if (back !== hb) bot.setQuickBarSlot(hb)
          bot._ndXbowFiring = true
          bot.activateItem()
          if (back !== hb) bot.setQuickBarSlot(back)
        } catch {} finally { bot._ndXbowFiring = false }
        if (shotLog) {
          // Где он был в расчётный миг попадания (упреждение против его хода).
          gameClock.setTimeout(() => { try { shotLog.himAtImpact = [+entity.position.x.toFixed(2), +entity.position.y.toFixed(2), +entity.position.z.toFixed(2)] } catch {} }, Math.max(0, (sol.ticks || 0) * TICK_MS))
          let hitLogged = false
          const onH = (victim) => { if (victim === entity && !hitLogged) { hitLogged = true; console.log('[xshot]', JSON.stringify({ ...shotLog, hit: gameClock.now() - shotLog.t })) } }
          bot.on('entityHurt', onH)
          gameClock.setTimeout(() => { bot.removeListener('entityHurt', onH); if (!hitLogged) console.log('[xshot]', JSON.stringify({ ...shotLog, hit: null, himAfter: [+entity.position.x.toFixed(2), +entity.position.y.toFixed(2), +entity.position.z.toFixed(2)] })) }, Math.min(3000, (sol.ticks || 10) * TICK_MS + 1200))
        }
        // Выстрел не «использование»: mineflayer иначе считает руку занятой.
        bot.usingHeldItem = false
        let hit = false
        const hp0 = read.healthRaw(bot, entity)
        const onHurt = (victim) => {
          if (victim !== entity || hit) return
          hit = true
          if (onHit) { try { onHit() } catch {} }
        }
        bot.on('entityHurt', onHurt)
        gameClock.setTimeout(() => bot.removeListener('entityHurt', onHurt), Math.min(3000, (sol.ticks || 10) * TICK_MS + 1200))
        resolve({ fired: true, ammo: info.ammo, multishot: info.multishot, piercing: info.piercing, ticks: sol.ticks, aimAt: sol.at, from, dist: Math.round(from.distanceTo(entity.position) * 10) / 10, hp0, ...(observation ? { aimObservation: observation } : {}) })
      })
    })
    // Final aim follows planning but precedes updatePosition's look packet.
    Object.defineProperty(onT, '_ndLatePacketAim', { value: true })
    bot.on('physicTick', onT)
    const timer = gameClock.setTimeout(() => { if (!done) { done = true; bot.removeListener('physicTick', onT); resolve({ fired: false, why: !point && !bowMod.hasObservedVelocity(entity) ? 'скорость цели ещё не наблюдалась' : 'физика стоит' }) } }, 400)
  })
}

// ---------------------------------------------------------------- решение
//
// Что делать с арбалетами в этом тике. ctx из pvp.js:
//   entity, d (по земле), r (досягаемость до него), sees, hp, fs (read.state),
//   busy (tempo.state: consuming/inWeb/pillaring), allIn, safe(ms) → bool,
//   shieldAtUs, others (другие враги), opening (первые секунды боя), rushing.
// Ответ: { act: 'fire'|'load', item, info, why, ammo? } или null.
function plan (bot, ctx) {
  const list = crossbows(bot)
  if (!list.length) return null
  const { entity, d, sees } = ctx
  const fs = ctx.fs || {}
  const loaded = list.filter(x => x.info.loaded)
  const empty = list.filter(x => !x.info.loaded)
  // --- Выстрел. Мгновенный — поэтому в окна, которых лук не ловит.
  if (loaded.length && sees && d >= 2.5 && d <= 48) {
    const pick = (pred) => loaded.find(x => pred(x.info))
    // Пустая ракета (0 звёзд) урона не даёт — как не заряжен.
    const rocket = pick(i => i.ammo === 'firework' && i.stars !== 0)
    const rocketOk = rocket && d >= 7 && d <= 34
    const arrowCb = pick(i => i.ammo !== 'firework')
    const pierce = pick(i => i.piercing > 0)
    const best = rocketOk ? rocket : (arrowCb || null)
    const dmg = best ? expectedDamage(bot, entity, best.info.ammo === 'firework' ? 'firework' : 'arrow', best.info.stars ?? 3) : 0
    const pair = (ctx.others || []).some(o => o && o.position && o.position.distanceTo(entity.position) < 4)
    // Стрелы и фейерверк его почти не берут (ctx.weak — pvp.js arrowsWeak:
    // «Защита от снарядов» ×0.2): стрелять — только чтобы добить.
    if (ctx.weak) {
      if (best && fs.ehp != null && fs.ehp <= dmg + 0.5 && !ctx.shieldAtUs) return { act: 'fire', item: best.item, info: best.info, why: `добиваю (${Math.round(fs.ehp ?? 0)} хп)` }
      return null
    }
    // Его щит поднят к нам: стрелу без «Пронзания» и взрыв спереди щит гасит
    // целиком (замер try-xbow xplain: 9 выстрелов, 0 урона) — только «Пронзание»,
    // остальное держать заряженным до окна.
    if (ctx.shieldAtUs) {
      // Оба обхода щита — по ожидаемому урону, а не порядком (S7d): «Пронзание» — стрела арбалета всегда крит 7–11
      // (ср. 9) × попадание 0.6 (kill-planner pHit.arrow); ракета в пол сбоку-сзади — взрыв не спереди, щит не держит
      // (shieldBypassPoint: сырой урон по точке) × 0.7 (pHit.firework).
      const pierceE = pierce && d >= 3.2 ? 9 * 0.6 : 0
      let bp = null
      if (rocket && d >= 6 && d <= 30) bp = shieldBypassPoint(bot, entity, require('./pick').eyeOf(bot).offset(0, -ROCKET_DROP, 0), rocket.info.stars ?? 3) // pick здесь — локальный выбор арбалета
      const rocketE = bp ? bp.raw * 0.7 : 0
      if (rocketE > pierceE && bp) return { act: 'fire', item: rocket.item, info: rocket.info, point: bp.point, why: `фейерверк в пол за его щит (${bp.raw} до брони)` }
      if (pierceE > 0) return { act: 'fire', item: pierce.item, info: pierce.info, why: '«Пронзание» сквозь его щит' }
    } else {
      // Причины по убыванию ценности: первая, что подошла.
      // Держим дистанцию (ctx.kite, 2026-09-26: «арбалет» 0:4 и ничья против
      // лука со щитом — заряженный арбалет молчал на 4–9 бл., и бой уходил в
      // меч): стрела — с 4 бл., пока щит не поднят; фейерверк — когда он открыт и
      // не прикрыт щитом: тянет лук (с натянутым луком щит не поднять —
      // LivingEntity.isBlocking по активному предмету) или щита при нём нет.
      const openForRocket = rocketOk && (!ctx.hisShield || ctx.theyDraw)
      const reasons = [
        [ctx.allIn && best, best, 'добиваю после его тотема'],
        [best && fs.ehp != null && fs.ehp <= dmg + 0.5, best, `добиваю (${Math.round(fs.ehp ?? 0)} хп)`],
        [ctx.busy && ctx.busy.consuming && best, best, 'он ест/пьёт — мгновенный выстрел'],
        [ctx.busy && (ctx.busy.inWeb || ctx.busy.pillaring) && best, best, ctx.busy && ctx.busy.inWeb ? 'он в паутине' : 'он строит столб'],
        [ctx.kite ? openForRocket : rocketOk, rocket, ctx.theyDraw ? 'фейерверк — он тянет лук, щит не поднять' : 'фейерверк'],
        [best && best.info.multishot && pair, best, '«Тройной выстрел» по двоим'],
        [best && ctx.opening && d >= 8, best, 'до сшибки'],
        [arrowCb && d >= 9 && (empty.length || arrowCb.info.quickCharge >= 2), arrowCb, 'издалека'],
        [arrowCb && ctx.kite && d >= 4, arrowCb, 'держу дистанцию — стрела']
      ]
      const hit = reasons.find(([ok]) => ok)
      if (hit) return { act: 'fire', item: hit[1].item, info: hit[1].info, why: hit[2] }
    }
  }
  // --- Зарядка: пока он не успеет дойти до нас за заряд + отпускание.
  // Заранее, в начале боя (до сшибки, он в 10+ блоках), — даже перед рывком:
  // заряженный арбалет — «пистолет» на окно (PVP-RESEARCH в.5).
  if (empty.length && !ctx.weak && (!ctx.rushing || (ctx.opening && d >= 10))) {
    const rockets = rocketsOf(bot)
    const arrowsN = arrowCount(bot)
    if (!rockets && !arrowsN) return null
    // Два арбалета: «Тройной» (без «Пронзания») — под фейерверки, «Пронзание» — под стрелы.
    // Какой первым (2026-09-26): щит при нём и лук не тянет — «Пронзание»
    // (стрелу щит не держит: applyItemBlocking, getPierceLevel() > 0 → 0);
    // тянет лук или щита нет — фейерверк (его щит не поднят).
    const pierceFirst = ctx.hisShield && !ctx.theyDraw
    const pref = (x) => (pierceFirst ? (x.info.piercing > 0 ? 1 : 0) : (ctx.theyDraw && !x.info.piercing ? 1 : 0))
    const order = empty.slice().sort((a, b) => (pref(b) - pref(a)) || (b.info.quickCharge - a.info.quickCharge))
    for (const x of order) {
      const i = x.info
      let ammo = null
      // Ракета — с 5 бл. (s7b: при «с 8» за 10 раундов заряжена 1 раз — бой почти весь ближе 8; выстрел ракетой
      // по-прежнему с 6–7 бл., а против щита — в пол за ним).
      if (rockets && !i.piercing && (d >= 5 || !arrowsN) && !(ctx.totemOff && ctx.hp <= 14)) ammo = 'firework'
      else if (arrowsN) ammo = 'arrow'
      if (!ammo) continue
      const ms = chargeTicks(i.quickCharge) * TICK_MS + 350 + (ammo === 'firework' ? 300 : 0)
      if (!ctx.safe || !ctx.safe(ms)) return null
      return { act: 'load', item: x.item, info: i, ammo, why: `заряжаю арбалет (${ammo === 'firework' ? 'фейерверк' : 'стрела'})` }
    }
  }
  return null
}

// Один ход арбалетом из боя (pvp.js): решение и исполнение. ctx — как у plan,
// плюс velFn, abortIf (бросить зарядку: он подошёл, по нам попали), onHit.
// Возвращает { did: 'fire'|'load', ok, why } или null — ничего не делал.
async function step (bot, ctl, ctx, { used = () => {}, holdWeapon = null, stats = null, planned = null }: any = {}) {
  const p = planned || plan(bot, ctx)
  if (!p) return null
  const S = stats || {}
  const dbg = (what, r) => { if (process.env.ND_DEBUG_PVP) console.log('[xbow]', what, JSON.stringify({ act: p.act, why: p.why, ammo: p.ammo || p.info.ammo, d: Math.round((ctx.d || 0) * 10) / 10, ...r })) }
  if (p.act === 'fire') {
    let hb = hotbarOf(bot, p.item)
    if (hb < 0) hb = await toHotbar(bot, p.item)
    if (hb < 0) return { did: 'fire', ok: false, why: 'арбалет не лезет в хотбар' }
    const item = bot.inventory.slots[36 + hb]
    const r: any = await fire(bot, ctx.entity, item, {
      velFn: ctx.velFn,
      point: p.point || null,
      onHit: () => {
        S.hits = (S.hits || 0) + 1
        used(`арбалет попал (${p.info.ammo === 'firework' ? 'фейерверк' : 'стрела'})`)
        if (ctx.onHit) { try { ctx.onHit(p) } catch {} }
      }
    })
    if (r.fired) {
      S.shots = (S.shots || 0) + 1
      if (p.info.ammo === 'firework') S.rockets = (S.rockets || 0) + 1
      used('арбалет: ' + p.why)
    } else if (r.why) S.skipped = r.why
    dbg('fire', { fired: !!r.fired, skip: r.fired ? undefined : r.why, ticks: r.ticks })
    return { did: 'fire', ok: !!r.fired, why: r.fired ? p.why : r.why, blocked: !!r.blocked, ammo: p.info.ammo }
  }
  if (p.act === 'load') {
    let arrow = null
    if (p.ammo === 'arrow') {
      const a = pickArrow(bot, { ...(ctx.arrowCtx || {}), forCrossbow: true })
      arrow = a && a.item
    }
    const r = await load(bot, ctl, p.item, { ammo: p.ammo, abortIf: ctx.abortIf, arrow, onTick: ctx.onLoadTick })
    if (holdWeapon) await holdWeapon()
    if (r.ok) { S.loads = (S.loads || 0) + 1; used(`зарядил арбалет (${p.ammo === 'firework' ? 'фейерверк' : 'стрела'}, ${Math.round(r.ms)} мс)`) } else S.loadFails = (S.loadFails || 0) + 1
    dbg('load', { ok: r.ok, why: r.why, ms: r.ms })
    return { did: 'load', ok: r.ok, why: r.why, ms: r.ms }
  }
  return null
}

// Стрела для лука: выбрать, поставить первой, и сколько тянуть (вред — коротко).
async function prepBow (bot, ctx: any = {}) {
  const a = pickArrow(bot, ctx)
  if (!a || !a.item) return { drawMs: null, why: null }
  const ok = await readyArrow(bot, a.item)
  const dm = a.harm && ok ? harmDrawMs(ctx.d || 99) : 0
  return { drawMs: dm || null, why: ok ? a.why : null, kind: arrowKind(a.item) }
}

// Арбалет лучше лука сейчас? Быстрая перезарядка ≥ 2 (цикл 0.8 с против 1.15 с и
// всегда крит) или лука нет; лук с «Силой» бьёт больнее — тогда лук для обычных
// выстрелов, арбалет — «заряженный пистолет» на окна.
function crossbowFirst (bot) {
  const list = crossbows(bot)
  if (!list.length) return false
  if (!arrowCount(bot) && !rocketsOf(bot)) return false
  if (list.some(x => x.info.loaded)) return true
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (!bow) return true
  if (read.enchLevel(bot, bow, 'power') >= 2) return false
  return list.some(x => x.info.quickCharge >= 2) || !!rocketsOf(bot)
}

// Заряженный арбалет стреляет от любого «использовать» (use_item), не только
// из fire(): съесть, выпить, метнуть трезубец, закинуть удочку — если нужный
// предмет не успел лечь в руку, стрела уходит туда, куда бот смотрит (арена
// 2026-09-26: «стреляет из арбалета куда-то в сторону»; прицельные выстрелы
// fire() при этом попадали в 69 из 74). Выстрел — только из fire(); прочие
// use_item с заряженным арбалетом в правой руке не отправляем и пишем, откуда
// пришли. Ставится один раз на тело (session.js).
function guardCrossbow (bot) {
  if (!bot || bot._ndXbowGuard || typeof bot.activateItem !== 'function') return
  bot._ndXbowGuard = true
  const raw = bot.activateItem
  bot.activateItem = function (offHand, ...rest: any[]) {
    if (!offHand && !bot._ndXbowFiring) {
      const held = bot.heldItem
      if (held && held.name === 'crossbow') {
        let info = null
        try { info = read.crossbowInfo(bot, held) } catch {}
        if (info && info.loaded) {
          bot._ndXbowBlocked = (bot._ndXbowBlocked || 0) + 1
          if (process.env.ND_DEBUG_XBOW || bot._ndXbowBlocked <= 30) {
            console.log('[xguard] случайный выстрел из заряженного арбалета не отправлен:', String(new Error().stack).split(/\r?\n/).slice(2, 6).map(l => l.trim()).join(' < '))
          }
          return
        }
      }
    }
    return raw.call(bot, offHand, ...rest)
  }
}

module.exports = {
  shieldBypassPoint, guardCrossbow,
  plan, step, prepBow, load, fire, readyArrow, pickArrow, firstArrow, arrowKind, tippedPotion, crossbows, crossbowFirst,
  chargeTicks, rocketAim, rocketSafe, expectedDamage, harmDrawMs, bowPower, rocketStars, hotbarOf, toHotbar, afterPacket, rocketsOf,
  ARROW_SPEED, ROCKET_SPEED, BLAST_R
}
