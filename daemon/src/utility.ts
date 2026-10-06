'use strict'
const gameClock = require('./game-clock')
// Удочка, трезубец, хорус, ловушки (2026-09-26, «мега-бот»: всё, чем дерутся
// про-игроки; PVP-RESEARCH б.6, б.12, б.15, б.17; в.12–в.15). Взрывчатки нет
// намеренно: TNT и кристаллы ломают небесную арену пользователя.
//
// Числа — декомпилированный клиент 1.21.11 (github extremeheat/
// extracted_minecraft_data, ветка client1.21.11, пути от net/minecraft/):
//  * world/entity/projectile/FishingHook: поплавок вылетает от глаз, на 0.3
//    вперёд по взгляду; скорость = (взгляд по горизонтали, tan(наклона вверх) в
//    пределах ±5) × (0.6/|v| + треуг(0.5, 0.0103)) — по горизонтали
//    0.6·cos p + 0.5, всего 0.6 + 0.5/cos p; своё движение НЕ прибавляется
//    (скорость задана в конструкторе). Тик в полёте: y −0.03, сдвиг, ×0.92.
//    Попал в сущность — hooked_entity (метаданные №8) = её id + 1, урона и
//    отброса нет. retrieve(): зацеплен — pullEntity: скорость цели += 0.1 ×
//    (владелец − поплавок), поплавок на цели в y + 0.8·рост; событие сущности 31.
//    Игрока тянет ЕГО СОБСТВЕННЫЙ клиент (handleEntityEvent: isLocalPlayer) —
//    бота на mineflayer никто не тянет, поэтому installRodPull делает это за
//    ванильный клиент. Леска рвётся дальше 32 бл. или без удочки в руках
//    (shouldStopFishing: distanceToSqr ≤ 1024). Прочность: сущность −5.
//  * world/entity/LivingEntity: урон не прерывает еду и питьё (stopUsingItem —
//    только смерть, смена предмета, отпускание); удочка «сбивает еду» только
//    тем, что тащит едока (он медленный ×0.2) к нашему мечу, к яме, к лаве.
//  * world/item/TridentItem: бросок — натяжение ≥ 10 тиков, скорость 2.5,
//    неточность 1.0, + своё смещение (spawnProjectileFromRotation); урон 8.
//    «Тягун» — только в воде или под дождём: толчок по взгляду 1.5 + 0.75·(L−1)
//    (Enchantments: trident_spin_attack_strength), с земли сперва +1.2 вверх,
//    20 тиков вращения, касание 8 урона. releaseUsing идёт и у клиента — бот
//    толкает себя сам. world/entity/projectile/arrow/ThrownTrident: физика
//    стрелы (сдвиг, ×0.99, y −0.05), «Верность» L возвращает: ×0.95 + 0.05·L к
//    глазам владельца, как только попал или лежит > 4 тиков.
//  * world/item/consume_effects/TeleportRandomlyConsumeEffect + LivingEntity.
//    randomTeleport: хорус — еда 1.6 с (Consumables.defaultFood), потом до 16
//    попыток: x, y, z ± 8 (diameter 16), вниз до блока, который держит
//    (blocksMotion) — хоть до дна мира; место без столкновений и без жидкости;
//    падение обнуляется. Перезарядка 1 с (Items.CHORUS_FRUIT useCooldown 1.0).
//  * world/entity/item/FallingBlockEntity.causeFallDamage + AnvilBlock.falling:
//    наковальня бьёт всех в своей рамке при посадке на min(floor(2·ceil(h − 1)),
//    40); урон falling_anvil — мимо щита (DamageTypeTagsProvider BYPASSES_SHIELD),
//    шлем ×0.75 (LivingEntity: DAMAGES_HELMET), броня считается. Падает сквозь
//    игрока и паутину (коллизий у них нет).
//  * BucketItem.use: луч от глаз по контуру блоков (паутина — полный куб):
//    лава встаёт в клетку перед гранью, в которую смотрим; поэтому лава на
//    врага в паутине — в верхнюю грань паутины, в клетку его головы.

const Vec3 = require('vec3')
const edges = require('./edges')
const tempo = require('./tempo')
const read = require('./read')
const bowMod = require('./bow')
const hazards = require('./hazards')
const { afterPacket } = require('./mace')
// Дождь и гроза — общий помощник по уровням (perception.raining/thundering,
// 2026-09-26): флаг bot.isRaining на Paper вывернут.
const { raySees, raining, thundering } = require('./perception')
const { placeBlockAt, pickFiller } = require('./build')
const { sleep } = require('./movement')

const EYE = 1.62
const USE_RANGE = 4.4
const TICK_MS = 50

function findItem (bot, test) { return bot.inventory.items().find(test) || null }
function countOf (bot, name) { return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0) }
function isPlayer (e) { return !!e && (e.type === 'player' || !!e.username) }
function hpOf (bot, e) { const h = read.healthRaw(bot, e); return h == null ? null : h + read.absorptionOf(bot, e) }
function solidAt (bot, p) { const b = bot.blockAt(p); return !!b && b.boundingBox === 'block' }
function nameAt (bot, p) { const b = bot.blockAt(p); return b ? b.name : null }
function airAt (bot, p) { const b = bot.blockAt(p); return !!b && (b.name === 'air' || b.name === 'cave_air') }

// Тик, на котором физика посчитана, — и действие после пакета позиции этого тика.
function onTickThen (bot, compute, act, timeoutMs = 400) {
  return new Promise<any>(resolve => {
    let done = false
    const onT = () => {
      if (done) return
      done = true
      gameClock.clearTimeout(t)
      bot.removeListener('physicsTick', onT)
      let sol = null
      try { sol = compute() } catch {}
      if (!sol) return resolve(null)
      if (sol.yaw != null) bot.look(sol.yaw, sol.pitch, true).catch(() => {})
      afterPacket(bot, () => { try { act(sol) } catch {} resolve(sol) })
    }
    const t = gameClock.setTimeout(() => { if (!done) { done = true; bot.removeListener('physicsTick', onT); resolve(null) } }, timeoutMs)
    bot.on('physicsTick', onT)
  })
}

// ================================================================ удочка

const ROD_G = 0.03
const ROD_DRAG = 0.92
// Полёт поплавка при наклоне p (вверх +) до горизонтали dx: высота и тики.
function rodFlight (p, dx) {
  const tn = Math.max(-5, Math.min(5, Math.tan(p)))
  const k = 0.6 / Math.hypot(1, tn) + 0.5
  let vh = k; let vy = tn * k
  let x = 0.3; let y = 0
  if (dx <= x) return { y: 0, ticks: 0 }
  for (let t = 1; t <= 80; t++) {
    vy -= ROD_G
    const nx = x + vh; const ny = y + vy
    if (nx >= dx) { const f = (dx - x) / (nx - x); return { y: y + (ny - y) * f, ticks: t - 1 + f } }
    x = nx; y = ny
    vh *= ROD_DRAG; vy *= ROD_DRAG
    if (vh < 0.02) return null
  }
  return null
}
// Наклон для попадания на высоту dy на дальности dx (низкая траектория).
function rodPitch (dx, dy) {
  const at = p => { const f = rodFlight(p, dx); return f ? f.y : -Infinity }
  let prev = null
  for (let deg = -40; deg <= 70; deg += 1) {
    const p = deg * Math.PI / 180
    if (at(p) >= dy) {
      if (prev === null) return { pitch: p, ticks: rodFlight(p, dx).ticks }
      let lo = prev; let hi = p
      for (let i = 0; i < 25; i++) { const m = (lo + hi) / 2; if (at(m) >= dy) hi = m; else lo = m }
      const f = rodFlight(hi, dx)
      return f ? { pitch: hi, ticks: f.ticks } : null
    }
    prev = p
  }
  return null
}
// Дальность, на которую вообще долетает (горизонт, наклон 25°): для плана.
const ROD_MAX = 11

// Честность (PVP-RESEARCH б.15): ванильный клиент по событию 31 поплавка,
// зацепившего его, сам прибавляет себе 0.1 × (владелец − поплавок). mineflayer —
// нет, и человек удочкой бота не сдёргивал. Один раз на бота, всегда.
function installRodPull (bot) {
  if (bot._ndRodPull) return bot._ndRodPull
  const R = { owners: new Map(), pulled: 0, last: null, mine: null }
  bot._ndRodPull = R
  const typeId = bot.registry.entitiesByName.fishing_bobber ? bot.registry.entitiesByName.fishing_bobber.id : -1
  try {
    bot._client.on('spawn_entity', (p) => {
      if (!p || p.type !== typeId) return
      R.owners.set(p.entityId, p.objectData)
      if (bot.entity && p.objectData === bot.entity.id) R.mine = { id: p.entityId, at: gameClock.now() }
      if (R.owners.size > 64) R.owners.delete(R.owners.keys().next().value)
    })
    bot._client.on('entity_status', (p) => {
      try {
        if (!p || p.entityStatus !== 31 || !bot.entity) return
        const hook = bot.entities[p.entityId]
        if (!hook || hook.name !== 'fishing_bobber') return
        if (hook.metadata[8] !== bot.entity.id + 1) return
        const owner = bot.entities[R.owners.get(p.entityId)]
        if (!owner || !owner.position) return
        const me = bot.entity.position
        const v = { x: (owner.position.x - me.x) * 0.1, y: (owner.position.y - (me.y + 0.8 * 1.8)) * 0.1, z: (owner.position.z - me.z) * 0.1 }
        bot.entity.velocity.x += v.x
        bot.entity.velocity.y += v.y
        bot.entity.velocity.z += v.z
        R.pulled++
        R.last = { at: gameClock.now(), v, from: owner.username || owner.name }
        bot.emit('nd_rodPulled', R.last)
      } catch {}
    })
  } catch {}
  return R
}

// Мой поплавок и кого он держит.
function myHook (bot) {
  const R = bot._ndRodPull
  if (!R || !R.mine) return null
  const e = bot.entities[R.mine.id]
  if (!e || e.isValid === false) return null
  const h = e.metadata ? e.metadata[8] : 0
  return { e, hooked: typeof h === 'number' && h > 0 ? h - 1 : null }
}

// Зачем тянуть (или null): со столба; через яму или в лаву между нами (прогон
// тела edges.knockRun со скоростью рывка); едока — к мечу.
function rodPlan (bot, e, { d, dy, sees, busy = {}, theyUp = false }: any = {}) {
  if (!isPlayer(e) || !sees) return null
  if (!findItem(bot, i => i.name === 'fishing_rod')) return null
  if (d < 3.5 || d > ROD_MAX) return null
  const me = bot.entity.position
  const pull = new Vec3((me.x - e.position.x) * 0.1, (me.y - (e.position.y + 1.44)) * 0.1, (me.z - e.position.z) * 0.1)
  const cache = new Map()
  // Сдёрнуть со столба или уступа: он выше и в 0.4 от края, за которым 1.5+
  // вниз (порог «безопасного падения» 3 тут не годится: столб в 3 — тоже столб).
  if ((theyUp || dy > 1.8) && edges.clearance(bot, e.position, 0.6, new Map(), 1.5) < 0.4) return { why: 'удочкой со столба', pull }
  // В яму или лаву между нами: его полёт от рывка (он тянет назад — counter).
  try {
    if (edges.hazardAround(bot, e.position, 4, cache)) {
      const onGround = edges.support(bot, e.position, cache).drop <= 0.05
      const base = edges.stateOf(bot)
      const v = new Vec3(pull.x, onGround ? Math.max(pull.y, 0) : pull.y, pull.z)
      const r = edges.knockRun(bot, base, e.position, v, onGround, Math.atan2(-(me.x - e.position.x), -(me.z - e.position.z)), true, cache)
      if (r && r.fall) return { why: r.lava ? 'удочкой в лаву' : 'удочкой в яму', pull }
    }
  } catch {}
  // Ест или пьёт: медленный (×0.2), рывок подтащит его к мечу — добить в глоток.
  if (busy.consuming && busy.consuming.left > 700 && d > 4.5) return { why: 'удочкой подтащил едока', pull }
  return null
}

// Заброс и подсечка. Прицел — по поплавку (своё движение не прибавляется),
// с упреждением его хода; поймали — сразу «использовать» ещё раз (рывок).
async function rodPull (bot, ctl, e, { velFn = () => ({ x: 0, y: 0, z: 0 }), maxMs = 1600 }: any = {}) {
  installRodPull(bot)
  const rod = findItem(bot, i => i.name === 'fishing_rod')
  if (!rod) return { ok: false, why: 'удочки нет' }
  try { await bot.equip(rod, 'hand') } catch (err) { return { ok: false, why: err.message } }
  if (!bot.heldItem || bot.heldItem.name !== 'fishing_rod') return { ok: false, why: 'не взял удочку' }
  const R = bot._ndRodPull
  R.mine = null
  const hp0 = hpOf(bot, e)
  const cast: any = await onTickThen(bot, () => {
    const eye = bot.entity.position.offset(0, EYE, 0)
    const v = velFn() || { x: 0, z: 0 }
    let ticks = 6
    let sol = null
    for (let i = 0; i < 3; i++) {
      const P = e.position.offset(v.x * ticks, 0.9, v.z * ticks)
      const dx = Math.hypot(P.x - eye.x, P.z - eye.z)
      const s = rodPitch(dx, P.y - eye.y)
      if (!s) return null
      sol = { yaw: Math.atan2(-(P.x - eye.x), -(P.z - eye.z)), pitch: s.pitch, ticks: s.ticks }
      ticks = s.ticks
    }
    return sol
  }, () => bot.activateItem())
  if (!cast) return { ok: false, why: 'не долетит' }
  const t0 = gameClock.now()
  let hooked = false
  while (!ctl.aborted && gameClock.now() - t0 < Math.min(maxMs, cast.ticks * 50 + 700)) {
    const h = myHook(bot)
    if (h && h.hooked === e.id) { hooked = true; break }
    await sleep(TICK_MS)
  }
  // Подсечка (или смотать пустой): второе «использовать» с удочкой в руке.
  // ND_DEBUG_ROD=1 (сцена try-utility): сразу за пакетом подсечки — /data его
  // Motion: сервер разбирает пакеты по порядку в одном тике, и ответ — скорость,
  // которую ему записал pullEntity (правда сервера, а не наш расчёт).
  let probe = null
  const onMsg = (m) => { const s = String(m); if (/has the following entity data/.test(s) && !probe) probe = s.replace(/^.*data: /, '') }
  const dbg = process.env.ND_DEBUG_ROD === '1' && hooked && e.username
  if (dbg) bot.on('messagestr', onMsg)
  try { bot.activateItem() } catch {}
  if (dbg) { try { bot.chat(`/data get entity ${e.username} Motion`) } catch {} }
  await sleep(dbg ? 400 : 120)
  if (dbg) bot.removeListener('messagestr', onMsg)
  const me = bot.entity.position
  const expect = hooked ? `${((me.x - e.position.x) * 0.1).toFixed(2)}, ${((me.y - e.position.y - 1.44) * 0.1).toFixed(2)}, ${((me.z - e.position.z) * 0.1).toFixed(2)}` : null
  return { ok: hooked, hooked, ticks: cast.ticks, pitchDeg: Math.round(cast.pitch * 1800 / Math.PI) / 10, hp0, probe, expect }
}

// ================================================================ трезубец

const TRIDENT_SPEED = 2.5
const TRIDENT_G = 0.05
function tridents (bot) {
  return bot.inventory.items().filter(i => i.name === 'trident').map(i => ({
    item: i,
    loyalty: read.enchLevel(bot, i, 'loyalty'),
    riptide: read.enchLevel(bot, i, 'riptide'),
    channeling: read.enchLevel(bot, i, 'channeling')
  }))
}
// Под дождём ли точка: идёт дождь и над ней открытое небо (Entity.isInRain →
// Level.isRainingAt: canSeeSky). Идёт ли дождь — perception.raining: уровень
// дождя > 0.2, как Level.isRaining (флаг mineflayer на Paper вывернут: после
// дождя он встаёт в true — прежнее «флаг или уровень» видело бы дождь в сушь).
function rainAt (bot, pos) {
  if (!raining(bot)) return false
  const f = pos.floored()
  const observed = bot.blockAt(f)?.biome
  // prismarine-block's version-only Biome wrapper can omit modern climate
  // fields; use the same observed ID in this connection's negotiated registry.
  const biome = observed && (bot.registry?.biomes?.[observed.id] ?? observed)
  if (!biome || biome.has_precipitation !== true || biome.temperature < .15) return false
  const maxY = (bot.game?.minY ?? -64) + (bot.game?.height ?? 384)
  for (let y = f.y + 1; y < maxY; y++) {
    const b = bot.blockAt(new Vec3(f.x, y, f.z))
    if (!b) return false
    if (b.boundingBox === 'block' || /water|lava|leaves|glass|barrier/.test(b.name)) return false
  }
  return true
}
function wetOrRain (bot, state = null) {
  const pos = state?.pos ?? bot.entity?.position
  return !!(pos && ((state?.isInWater ?? bot.entity.isInWater) || rainAt(bot, pos) || rainAt(bot, pos.offset(0, bot.physics?.playerHeight ?? 1.8, 0))))
}

// Какой трезубец бросить: «Громовержец» в грозу по цели под небом; иначе с
// «Верностью» (вернётся сам); без чар — только добить (поднимать некогда).
// Трезубец с «Тягуном» не бросается вовсе (TridentItem.releaseUsing).
function tridentPlan (bot, e, { d, sees, finishing = false }: any = {}) {
  if (!sees || d < 5 || d > 24) return null
  const ts = tridents(bot).filter(t => !t.riptide)
  if (!ts.length) return null
  // Молния «Громовержца» — только в грозу (ThrownTrident: level.isThundering()
  // — уровень грозы > 0.9, Level.isThundering).
  const storm = thundering(bot)
  if (storm && rainAt(bot, e.position)) {
    const ch = ts.find(t => t.channeling)
    if (ch) return { t: ch, why: 'трезубец: молния в грозу' }
  }
  const loyal = ts.filter(t => t.loyalty).sort((a, b) => b.loyalty - a.loyalty)[0]
  if (loyal) return { t: loyal, why: `трезубец с «Верностью ${loyal.loyalty}»` }
  if (finishing) return { t: ts[0], why: 'трезубец: добить' }
  return null
}

// Бросок: натяжение 13 тиков (порог 10, запас на пакеты), прицел по физике
// стрелы (bow.aimMoving со скоростью 2.5) со своим смещением этого тика,
// спуск — после пакета позиции.
async function throwTrident (bot, e, t, { velFn = null, onDraw = null }: any = {}) {
  try { await bot.equip(t.item, 'hand') } catch (err) { return { ok: false, why: err.message } }
  if (!bot.heldItem || bot.heldItem.name !== 'trident') return { ok: false, why: 'не взял трезубец' }
  const target = bowMod.leadTarget(e, velFn)
  const eye = () => bot.entity.position.offset(0, EYE - 0.1, 0)
  const pre = bowMod.aim(eye(), target, TRIDENT_SPEED, TRIDENT_G)
  if (!pre) return { ok: false, why: 'не долетит' }
  if (bowMod.blockedAt(bot, eye(), pre, undefined, TRIDENT_SPEED)) return { ok: false, why: 'блок на линии' }
  let lastPos = bot.entity.position.clone()
  let moved = { x: 0, y: 0, z: 0 }
  const onTick = () => { const p = bot.entity.position; moved = { x: p.x - lastPos.x, y: p.y - lastPos.y, z: p.z - lastPos.z }; lastPos = p.clone() }
  bot.on('physicsTick', onTick)
  const hp0 = hpOf(bot, e)
  bot.activateItem()
  const t0 = gameClock.now()
  try {
    while (gameClock.now() - t0 < 650) {
      const s = bowMod.aimMoving(eye(), target, moved, !bot.entity.onGround, TRIDENT_SPEED, TRIDENT_G)
      if (s) bot.look(s.yaw, s.pitch, true).catch(() => {})
      if (onDraw) onDraw()
      await sleep(TICK_MS)
    }
    const fin: any = await onTickThen(bot, () => {
      const s = bowMod.aimMoving(eye(), target, moved, !bot.entity.onGround, TRIDENT_SPEED, TRIDENT_G)
      if (!s || bowMod.blockedAt(bot, eye(), s, moved, TRIDENT_SPEED)) return null
      return s
    }, () => bot.deactivateItem())
    if (!fin) { try { bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9) } catch { bot.deactivateItem() } return { ok: false, why: 'линия закрылась' } }
    return { ok: true, hp0, ticks: fin.ticks }
  } finally {
    bot.removeListener('physicsTick', onTick)
  }
}

// «Тягун»: рывок по взгляду (yaw, pitch). Сервер толкает только у себя
// (Entity.push без hurtMarked) — скорость и подъём прибавляем сами, как клиент.
async function riptide (bot, yaw, pitch = 0, options: any = {}) {
  const t = tridents(bot).filter(x => x.riptide).sort((a, b) => b.riptide - a.riptide)[0]
  if (!t) return { ok: false, why: 'нет трезубца с «Тягуном»' }
  if (!wetOrRain(bot)) return { ok: false, why: 'не в воде и не под дождём' }
  return require('./navigation/riptide').runRiptide(bot, options.ctl ?? { aborted: false }, t.item, t.riptide, yaw, pitch,
    state => wetOrRain(bot, state), release => onTickThen(bot, () => ({ yaw, pitch }), release), options.target, options.launch)
}
async function riptideTo(bot, ctl, target) {
  const trident = tridents(bot).filter(t => t.riptide).sort((a, b) => b.riptide - a.riptide)[0]
  if (!trident || !wetOrRain(bot) || ctl.aborted || bot._ndClutch?.waterPlan) return { ok: false, why: 'no_available_navigation_riptide', ticks: 0 }
  const chosen = await require('./navigation/riptide').planRiptideTo(bot, ctl, trident.riptide, target, state => wetOrRain(bot, state))
  if (!chosen) return { ok: false, why: 'no_safe_navigation_riptide', ticks: 0 }
  return riptide(bot, chosen.yaw, chosen.pitch, { ctl, target })
}

// ================================================================ хорус

// Куда перенесёт хорус отсюда: те же 16 попыток, что у сервера (±8 по x, y, z,
// вниз до опоры хоть до дна мира, место без блоков и жидкости), n прогонов.
// Итог: доля «перенёсся», «сел ниже ног на 4+» (на небесной арене — вылет на
// землю под ней), средний сдвиг и сколько раз ушёл от ближайшего врага на 6+.
function chorusOdds (bot, foes: any = [], { n = 300 }: any = {}) {
  const me = bot.entity.position
  const minY = (bot.game && bot.game.minY) ?? -64
  const maxY = minY + ((bot.game && bot.game.height) || 384) - 1
  const cache = new Map()
  const bm = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (cache.has(k)) return cache.get(k)
    const b = bot.blockAt(new Vec3(x, y, z), false)
    const v = !b ? 'unknown' : b.boundingBox === 'block' ? 'solid' : /water|lava|bubble_column/.test(b.name) ? 'liquid' : 'free'
    cache.set(k, v)
    return v
  }
  const fits = (x, y, z) => {
    // Рамка игрока 0.6 × 1.8 без блоков и жидкости.
    for (const [ox, oz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
      for (const oy of [0, 0.9, 1.79]) {
        const c = bm(Math.floor(x + ox), Math.floor(y + oy), Math.floor(z + oz))
        if (c !== 'free') return false
      }
    }
    return true
  }
  const out = { n, tp: 0, low: 0, away6: 0, sumMove: 0, sumFoe: 0, lava: 0, walled: 0 }
  // Между нами и точкой прыжка — барьер (стена поля в Колизее, 2026-09-26):
  // хорус переносит сквозь неё, на трибуны, а это вылет с ринга.
  const barrierCache = new Map()
  const isBarrier = (x, y, z) => {
    const k = `${x},${y},${z}`
    if (barrierCache.has(k)) return barrierCache.get(k)
    const b = bot.blockAt(new Vec3(x, y, z), false)
    const v = !!b && b.name === 'barrier'
    barrierCache.set(k, v)
    return v
  }
  const walledOff = (to) => {
    const dx = to.x - me.x; const dz = to.z - me.z
    const len = Math.hypot(dx, dz)
    for (let t = 0.5; t < len; t += 0.5) {
      const x = Math.floor(me.x + dx * t / len); const z = Math.floor(me.z + dz * t / len)
      for (const y of [Math.floor(me.y + 0.5), Math.floor(me.y + 1.5), Math.floor(to.y + 0.5)]) if (isBarrier(x, y, z)) return true
    }
    return false
  }
  for (let s = 0; s < n; s++) {
    let land = null
    for (let a = 0; a < 16 && !land; a++) {
      const x = me.x + (Math.random() - 0.5) * 16
      let y = Math.max(minY, Math.min(maxY, me.y + (Math.random() - 0.5) * 16))
      const z = me.z + (Math.random() - 0.5) * 16
      let by = Math.floor(y)
      let found = false
      while (by > minY) {
        const below = bm(Math.floor(x), by - 1, Math.floor(z))
        if (below === 'unknown') break
        if (below === 'solid') { found = true; break }
        y -= 1; by -= 1
      }
      if (found && fits(x, y, z)) land = new Vec3(x, y, z)
    }
    if (!land) continue
    out.tp++
    out.sumMove += Math.hypot(land.x - me.x, land.z - me.z)
    if (me.y - land.y > 4) out.low++
    const df = foes.length ? Math.min(...foes.map(f => Math.hypot(f.position.x - land.x, f.position.z - land.z))) : 99
    out.sumFoe += Math.min(df, 30)
    if (df >= 6) out.away6++
    try { if (edges.hazardAround(bot, land, 1, new Map())) out.lava++ } catch {}
    if (walledOff(land)) out.walled++
  }
  const p = k => Math.round(out[k] / n * 100)
  return {
    n,
    tp: p('tp'),
    low: p('low'),
    away6: p('away6'),
    hazard: p('lava'),
    walled: p('walled'),
    move: out.tp ? Math.round(out.sumMove / out.tp * 10) / 10 : 0,
    foeDist: out.tp ? Math.round(out.sumFoe / out.tp * 10) / 10 : 0
  }
}

// Чем уходить: хорус или жемчуг (или ничем). Жемчуг — 5 хп (ThrownEnderpearl.
// onHit, мимо брони), летит куда бросил, но из коробки и из-под потолка не
// вылетит; хорус — 0 хп и сквозь стены, но 1.6 с жевать и куда выпадет.
//  · заперт (паутина, которую не срезать, яма, коробка) — хорус;
//  · хп ≤ 6 — жемчуг сам почти убивает — хорус;
//  · жемчуга нет, лечиться нечем, хп на исходе — хорус;
//  · хорус ведёт за край (≥ 15% прогонов ниже ног на 4+) — нет.
// Жевать под ударами можно (урон еду не прерывает), если за 1.6 с он не снимет
// всё: ожидаемый урон — по его заряду и оружию (totem.burstOf).
function escapeChoice (bot, { hp, foes = [], trapped = null, pearls = 0, canHeal = false, pearlAt = 9, burst = 4 }: any = {}) {
  if (!findItem(bot, i => i.name === 'chorus_fruit')) return null
  if (gameClock.now() < (bot._ndChorusCd || 0)) return null
  // Жемчуг сам почти убивает: 5 хп, меньше с «Невесомостью» и «Защитой»
  // (tempo.pearlDamage — арена с чарами).
  let pd = 5
  try { pd = require('./tempo').pearlDamage(bot) } catch {}
  const low = hp <= pd + 1
  const want = trapped || (low && hp <= pearlAt) || (!pearls && !canHeal && hp <= pearlAt)
  if (!want) return null
  const odds = chorusOdds(bot, foes, { n: 160 })
  if (odds.tp < 60 || odds.low >= 15 || odds.hazard >= 20) return { use: null, odds, why: 'хорус ведёт за край или некуда' }
  if (odds.walled >= 5) return { use: null, odds, why: 'хорус уведёт за стену поля' }
  const near = foes.filter(f => f.position.distanceTo(bot.entity.position) < 4).length
  const expect = near * burst * 1.6
  if (hp - expect < 1.5 && !trapped) return { use: null, odds, why: 'не дожую — забьют' }
  return { use: 'chorus', odds, why: trapped ? `заперт (${trapped})` : low ? `мало хп (${Math.round(hp)}) — жемчуг сам снял бы ${pd.toFixed(1)}` : 'уйти больше нечем' }
}

async function chorusEscape (bot, ctl) {
  const fruit = findItem(bot, i => i.name === 'chorus_fruit')
  if (!fruit) return { ok: false, why: 'хоруса нет' }
  try { await bot.equip(fruit, 'hand') } catch (err) { return { ok: false, why: err.message } }
  const had = countOf(bot, 'chorus_fruit')
  const from = bot.entity.position.clone()
  let tpAt = null
  const onMove = () => { if (!tpAt && bot.entity.position.distanceTo(from) > 1.5) tpAt = gameClock.now() }
  bot.on('forcedMove', onMove)
  bot.activateItem()
  const t0 = gameClock.now()
  try {
    while (!ctl.aborted && gameClock.now() - t0 < 2400 && countOf(bot, 'chorus_fruit') >= had) await sleep(TICK_MS)
    await sleep(150)
  } finally {
    bot.removeListener('forcedMove', onMove)
  }
  if (countOf(bot, 'chorus_fruit') >= had) { try { bot.deactivateItem() } catch {} return { ok: false, why: 'не доел' } }
  bot._ndChorusCd = gameClock.now() + 1000
  const moved = bot.entity.position.distanceTo(from)
  return { ok: moved > 1.5, moved: Math.round(moved * 10) / 10, ms: gameClock.now() - t0 }
}

// ================================================================ ловушки

// Застрял ли он: паутина у ног или головы, яма в клетку шириной, коробка.
function stuckOf (bot, e) {
  const f = e.position.floored()
  let walls = 0
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (solidAt(bot, f.offset(dx, 0, dz)) && solidAt(bot, f.offset(dx, 1, dz))) walls++
  if (walls >= 4) return 'коробка'
  if (nameAt(bot, f) === 'cobweb' || nameAt(bot, f.offset(0, 1, 0)) === 'cobweb') return 'паутина'
  try { if (hazards.pitTrap(bot, e.position)) return 'яма' } catch {}
  return null
}

// Наковальня над ним: самая высокая клетка его столба (до +6 над ногами), куда
// дотянуться (≤ 4.4 от глаз), путь вниз свободен, есть к чему прислонить (блок
// сбоку или сверху). Нет опоры — столбик рядом из заполнителя. Урон при посадке
// на пол его клетки: floor(2·ceil(h − 1)) до брони и шлема (×0.75).
function anvilPlan (bot, e, { build = true }: any = {}) {
  if (!findItem(bot, i => /anvil$/.test(i.name))) return null
  const f = e.position.floored()
  const eye = bot.entity.position.offset(0, EYE, 0)
  const filler = build ? pickFiller(bot) : null
  const fillN = filler ? countOf(bot, filler.name) : 0
  for (let k = 6; k >= 2; k--) {
    const cell = f.offset(0, k, 0)
    if (cell.offset(0.5, 0.5, 0.5).distanceTo(eye) > USE_RANGE) continue
    let clear = true
    for (let y = 2; y <= k; y++) if (!airAt(bot, f.offset(0, y, 0))) { clear = false; break }
    if (!clear) continue
    const dmg = Math.min(40, Math.floor(2 * Math.ceil(k - 1)))
    const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    if (solidAt(bot, cell.offset(0, 1, 0)) || sides.some(([dx, dz]) => solidAt(bot, cell.offset(dx, 0, dz)))) return { cell, k, dmg, support: [] }
    if (!filler) continue
    // Столбик опоры: соседняя колонка ближе к нам, снизу до высоты k.
    const me = bot.entity.position
    const side = sides.map(([dx, dz]) => f.offset(dx, 0, dz)).sort((a, b) => Math.hypot(a.x + 0.5 - me.x, a.z + 0.5 - me.z) - Math.hypot(b.x + 0.5 - me.x, b.z + 0.5 - me.z))
    for (const col of side) {
      if (col.equals(bot.entity.position.floored())) continue
      const need = []
      let ok = true
      for (let y = 0; y <= k; y++) {
        const c = col.offset(0, y, 0)
        if (solidAt(bot, c)) continue
        if (!airAt(bot, c) || c.offset(0.5, 0.5, 0.5).distanceTo(eye) > USE_RANGE) { ok = false; break }
        need.push(c)
      }
      if (ok && need.length <= fillN && need.length <= 6) return { cell, k, dmg, support: need }
    }
  }
  return null
}

async function dropAnvil (bot, ctl, e, plan) {
  for (const c of plan.support) {
    if (ctl.aborted) return { ok: false, why: 'прервали' }
    const r = await placeBlockAt(bot, c, { timeoutMs: 600, honest: true }).catch(() => ({ ok: false }))
    if (!r.ok) return { ok: false, why: 'опора не встала: ' + (r.reason || '?') }
  }
  // Паутина в его столбе обнуляет падение и наковальне (WebBlock.entityInside →
  // makeStuckInBlock у любой сущности: resetFallDistance) — замер 2026-09-26:
  // наковальня с 6 бл. сквозь паутину сняла 0. Срезать мечом (0.4 с), потом ронять.
  const f = e.position.floored()
  for (const c of [f.offset(0, 1, 0), f]) {
    const b = bot.blockAt(c)
    if (!b || b.name !== 'cobweb') continue
    const sw = findItem(bot, i => /_sword$|^shears$/.test(i.name))
    if (!sw) return { ok: false, why: 'паутину в его клетке нечем срезать' }
    try { await bot.equip(sw, 'hand'); await Promise.race([bot.dig(b, true), sleep(1500)]) } catch {}
    if (nameAt(bot, c) === 'cobweb') return { ok: false, why: 'паутина в его клетке не срезалась' }
  }
  const anvil = findItem(bot, i => /anvil$/.test(i.name))
  if (!anvil) return { ok: false, why: 'наковальни нет' }
  const hp0 = hpOf(bot, e)
  const r = await placeBlockAt(bot, plan.cell, { item: anvil.name, timeoutMs: 600, honest: true }).catch(() => ({ ok: false }))
  if (!r.ok) return { ok: false, why: 'наковальня не встала: ' + (r.reason || '?') }
  // Падает через 2 тика (FallingBlock: delay after place), летит ~k блоков.
  let hpMin = hp0
  const t0 = gameClock.now()
  while (gameClock.now() - t0 < 1300) { const h = hpOf(bot, e); if (h != null && (hpMin == null || h < hpMin)) hpMin = h; await sleep(TICK_MS) }
  return { ok: true, k: plan.k, dmg: plan.dmg, dealt: hp0 != null && hpMin != null ? Math.round((hp0 - hpMin) * 10) / 10 : null, built: plan.support.length }
}

// Запереть в коробке 1×2: четыре стороны на уровне ног и головы. Он в паутине
// (вчетверо медленнее) — успеваем; крыши нет — сверху наковальня.
function blockInPlan (bot, e) {
  const filler = pickFiller(bot)
  if (!filler) return null
  const f = e.position.floored()
  const eye = bot.entity.position.offset(0, EYE, 0)
  const cells = []
  for (const dy of [0, 1]) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = f.offset(dx, dy, dz)
      if (solidAt(bot, c)) continue
      if (!airAt(bot, c) || c.offset(0.5, 0.5, 0.5).distanceTo(eye) > USE_RANGE) return null
      if (c.equals(bot.entity.position.floored()) || c.equals(bot.entity.position.floored().offset(0, 1, 0))) return null
      cells.push(c)
    }
  }
  if (!cells.length || cells.length > countOf(bot, filler.name)) return null
  // Больше трёх блоков не ставить: один встаёт за 3–4 тика, а из паутины он
  // выходит за 0.3–0.5 с (водой) — восемь блоков вокруг открытого поля не
  // успевают никогда (живая арена 2026-09-26: «коробка не сомкнулась» 23 раза
  // из 27, и каждая оставляла на арене мусор, который потом ломали и обходили).
  // Коробка — когда он уже почти заперт: в углу, у стены, в своей же стенке.
  if (cells.length > 3) return null
  return { cells }
}
async function blockIn (bot, ctl, e, plan) {
  let placed = 0
  for (const c of plan.cells) {
    if (ctl.aborted) break
    const r = await placeBlockAt(bot, c, { timeoutMs: 500, honest: true }).catch(() => ({ ok: false }))
    if (r.ok) placed++
  }
  return { ok: stuckOf(bot, e) === 'коробка', placed }
}

// Лава на того, кто застрял: в паутине — в верхнюю грань паутины (клетка его
// головы, стечёт вниз, паутину сожжёт); в яме — в верхнюю грань блока под ним.
function lavaPlan (bot, e) {
  if (!findItem(bot, i => i.name === 'lava_bucket')) return null
  if (read.effectsOf(bot, e).has('fire_resistance')) return null
  const f = e.position.floored()
  const eye = bot.entity.position.offset(0, EYE, 0)
  const me = bot.entity.position
  if (Math.hypot(f.x + 0.5 - me.x, f.z + 0.5 - me.z) < 2.2) return null
  let aim = null
  if (nameAt(bot, f) === 'cobweb') aim = { pt: f.offset(0.5, 1, 0.5), cell: f.offset(0, 1, 0) }
  else if (nameAt(bot, f.offset(0, 1, 0)) === 'cobweb') aim = { pt: f.offset(0.5, 2, 0.5), cell: f.offset(0, 2, 0) }
  else if (solidAt(bot, f.offset(0, -1, 0)) && airAt(bot, f)) aim = { pt: f.offset(0.5, 0, 0.5), cell: f }
  if (!aim || aim.pt.distanceTo(eye) > USE_RANGE || aim.pt.y > eye.y) return null
  // Луч не должен упереться раньше (в блок между нами).
  if (!raySees(bot, eye, aim.pt)) return null
  return aim
}
async function pourLava (bot, e, plan) {
  const lava = findItem(bot, i => i.name === 'lava_bucket')
  if (!lava) return { ok: false }
  try { await bot.equip(lava, 'hand') } catch { return { ok: false } }
  await bot.lookAt(plan.pt, true).catch(() => {})
  await sleep(60)
  try { bot.activateItem() } catch {}
  await sleep(100)
  const b = bot.blockAt(plan.cell)
  return { ok: !!(b && b.name === 'lava'), cell: plan.cell }
}

// ================================================================ на бой

// Один раз на бой: планировщик приёмов и счёт. used — в отчёт боя.
function create (bot, { used = () => {}, tt = null }: any = {}) {
  installRodPull(bot)
  const st = { rod: 0, rodHooked: 0, trident: 0, tridentHit: 0, riptide: 0, chorus: 0, anvils: 0, anvilDmg: [], boxes: 0, lava: 0, pulledMe: 0 }
  const cd = {}
  const ready = (k) => gameClock.now() >= (cd[k] || 0)
  const rest = (k, ms) => { cd[k] = gameClock.now() + ms }
  const pending = [] // своя лава: забрать ведром
  const onPulled = () => { st.pulledMe++ }
  bot.on('nd_rodPulled', onPulled)

  // Лава, поставленная ловушкой, — обратно в ведро через 3 с, если достаём.
  const scoop = async () => {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]
      if (gameClock.now() - p.at < 3000) continue
      pending.splice(i, 1)
      const b = bot.blockAt(p.cell)
      const bucket = findItem(bot, it => it.name === 'bucket')
      if (!b || b.name !== 'lava' || !bucket) continue
      if (p.cell.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, EYE, 0)) > USE_RANGE) continue
      try { await bot.equip(bucket, 'hand'); await bot.lookAt(p.cell.offset(0.5, 0.3, 0.5), true); await sleep(50); bot.activateItem(); await sleep(80) } catch {}
      return true
    }
    return false
  }

  // Шаг боя: один приём или null. ctx: { entity, d, dy, r, hp, sees, theyUp,
  // busy (tt.state), vel(), others[], ctl, onDraw }.
  const step = async (ctx) => {
    const e = ctx.entity
    if (!e || !isPlayer(e) || !bot.entity) return null
    if (pending.length && (await scoop())) return { did: 'scoop' }
    const stuck = ctx.d < 6 ? stuckOf(bot, e) : null
    // Ловушки: он застрял рядом.
    if (stuck && ready('trap')) {
      const lp = stuck !== 'коробка' && !(ctx.busy && ctx.busy.burning) ? lavaPlan(bot, e) : null
      if (lp) {
        rest('trap', 4000)
        const r = await pourLava(bot, e, lp)
        if (r.ok) { st.lava++; pending.push({ cell: r.cell, at: gameClock.now() }); used(`ловушка: лава на него (${stuck})`); return { did: 'lava' } }
      }
      if (stuck === 'паутина' && ctx.d <= 3.4 && !(ctx.others || []).some(o => o.position.distanceTo(bot.entity.position) < 5) && ready('box')) {
        const bp = blockInPlan(bot, e)
        if (bp) {
          rest('box', 8000)
          const r = await blockIn(bot, ctx.ctl, e, bp)
          if (r.placed) { st.boxes++; used(r.ok ? `ловушка: запер в коробке 1×2 (${r.placed} бл.)` : `ловушка: коробка не сомкнулась (${r.placed} бл.)`) }
          if (r.placed) return { did: 'box' }
        }
      }
      const ap = anvilPlan(bot, e)
      if (ap) {
        rest('trap', 4000)
        const r = await dropAnvil(bot, ctx.ctl, e, ap)
        if (r.ok) { st.anvils++; if (r.dealt != null) st.anvilDmg.push(r.dealt); used(`ловушка: наковальня с ${ap.k} бл. (${stuck}${r.built ? `, опора ${r.built}` : ''}) — снял ${r.dealt ?? '?'} хп`); return { did: 'anvil' } }
        used('ловушка: наковальня не вышла — ' + r.why)
        rest('trap', 2500)
      }
    }
    // Удочка.
    if (ready('rod') && ctx.d >= 3.5 && ctx.d <= ROD_MAX) {
      const rp = rodPlan(bot, e, { d: ctx.d, dy: ctx.dy, sees: ctx.sees, busy: ctx.busy || {}, theyUp: ctx.theyUp })
      if (rp) {
        rest('rod', 2500)
        st.rod++
        const r = await rodPull(bot, ctx.ctl, e, { velFn: ctx.vel })
        if (r.hooked) { st.rodHooked++; used(rp.why + ' — зацепил и дёрнул' + (r.probe ? ` (сервер: Motion [${r.probe}], расчёт рывка [${r.expect}])` : '')) } else used(rp.why + ' — мимо')
        return { did: 'rod', rush: !!r.hooked }
      }
    }
    // Трезубец в него.
    if (ready('trident')) {
      const ehp = hpOf(bot, e)
      const tp = tridentPlan(bot, e, { d: ctx.d, sees: ctx.sees, finishing: ehp != null && ehp <= 5 })
      if (tp && (ctx.d > 7 || (ctx.busy && ctx.busy.consuming))) {
        rest('trident', 1800)
        st.trident++
        const r = await throwTrident(bot, e, tp.t, { velFn: ctx.vel, onDraw: ctx.onDraw })
        if (r.ok) {
          used(tp.why)
          // Попал ли: его хп в полёте (≤ 1 с).
          const t0 = gameClock.now()
          while (gameClock.now() - t0 < Math.min(1200, (r.ticks || 10) * 50 + 300)) { const h = hpOf(bot, e); if (h != null && r.hp0 != null && h < r.hp0 - 0.4) { st.tridentHit++; used('трезубец попал'); break } await sleep(TICK_MS) }
          return { did: 'trident' }
        }
      }
    }
    // «Тягун» в грозу/дождь или в воде — рывком к нему: касание 8 урона.
    if (ready('riptideNote') && ctx.d > 6 && tridents(bot).some(t => t.riptide) && !wetOrRain(bot)) {
      rest('riptideNote', 10000)
      used(`трезубец: «Тягун» ждёт воды или дождя (дождь ${raining(bot) ? 'идёт' : 'нет'} [флаг ${!!bot.isRaining}, уровень ${Math.round((bot.rainState || 0) * 100) / 100}], небо над головой ${rainAt(bot, bot.entity.position) ? 'открыто' : 'закрыто'})`)
    }
    if (ready('riptide') && ctx.d > 6 && ctx.d < 14 && ctx.hp >= 10 && ctx.sees && wetOrRain(bot) && tridents(bot).some(t => t.riptide)) {
      rest('riptide', 5000)
      const me = bot.entity.position
      const yaw = Math.atan2(-(e.position.x - me.x), -(e.position.z - me.z))
      const r = await riptide(bot, yaw, 0.12, { ctl: ctx.ctl })
      if (r.ok) { st.riptide++; used(`трезубец: «Тягун ${r.level}» рывком к нему (${r.moved} бл.)`); return { did: 'riptide' } }
      used('трезубец: «Тягун» не вышел — ' + r.why)
    }
    return null
  }

  // Уход «Тягуном» из-под двоих или на последних хп (дождь или вода).
  const riptideAway = async (foes, ctl = null) => {
    if (!ready('riptideAway') || !wetOrRain(bot) || !tridents(bot).some(t => t.riptide)) return null
    const me = bot.entity.position
    let sx = 0; let sz = 0
    for (const f of foes) { const d = Math.max(0.5, f.position.distanceTo(me)); sx += (me.x - f.position.x) / d; sz += (me.z - f.position.z) / d }
    if (!sx && !sz) return null
    const yaw = Math.atan2(-sx, -sz)
    // Путь свободен на 6 блоков и там есть пол (не в дыру арены).
    const dir = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
    const eye = me.offset(0, 1.2, 0)
    if (!raySees(bot, eye, eye.plus(dir.scaled(6)))) return null
    const landAt = me.plus(dir.scaled(9))
    try { if (edges.lethalAt(bot, landAt, new Map())) return null } catch {}
    rest('riptideAway', 6000)
    const r = await riptide(bot, yaw, 0.12, { ctl })
    if (r.ok) { st.riptide++; used(`трезубец: «Тягун ${r.level}» — ушёл рывком (${r.moved} бл.)`) }
    return r
  }

  const chorusMaybe = async (ctl, ctx) => {
    if (!ready('chorus')) return null
    const ch = escapeChoice(bot, ctx)
    if (!ch) return null
    rest('chorus', 2500)
    if (!ch.use) { if (ready('chorusNote')) { rest('chorusNote', 8000); used(`хорус: не ем — ${ch.why} (перенос ${ch.odds.tp}%, ниже на 4+ ${ch.odds.low}%)`) } return null }
    const r = await chorusEscape(bot, ctl)
    if (r.ok) { st.chorus++; used(`хорус: ${ch.why} — прыгнул на ${r.moved} бл. (прогноз: от врага 6+ в ${ch.odds.away6}%, сдвиг ~${ch.odds.move})`) } else used(`хорус: ${ch.why} — ${r.why || 'не перенесло'}`)
    return r
  }

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    bot.removeListener('nd_rodPulled', onPulled)
    if (st.pulledMe) used(`удочкой дёрнули меня ×${st.pulledMe} (сдвинулся сам, как клиент)`)
    const bits = []
    if (st.rod) bits.push(`удочка ${st.rodHooked}/${st.rod}`)
    if (st.trident) bits.push(`трезубец ${st.tridentHit}/${st.trident}`)
    if (st.riptide) bits.push(`«Тягун» ${st.riptide}`)
    if (st.chorus) bits.push(`хорус ${st.chorus}`)
    if (st.anvils) bits.push(`наковальня ${st.anvils} (${st.anvilDmg.join(', ')} хп)`)
    if (st.boxes) bits.push(`коробка ${st.boxes}`)
    if (st.lava) bits.push(`лава-ловушка ${st.lava}`)
    if (bits.length) used('подручное: ' + bits.join(', '))
  }

  return { step, chorusMaybe, riptideAway, stuckOf: (e) => stuckOf(bot, e), stats: st, close }
}

module.exports = {
  create, installRodPull, rodFlight, rodPitch, rodPlan, rodPull, myHook,
  tridentPlan, throwTrident, riptide, riptideTo, rainAt, chorusOdds, escapeChoice, chorusEscape,
  stuckOf, anvilPlan, dropAnvil, blockInPlan, blockIn, lavaPlan, pourLava, ROD_MAX
}
