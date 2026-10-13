'use strict'
const gameClock = require('./game-clock')
// Кристаллы Края в бою с игроком (просьба 2026-09-30: «они много урона наносят
// и тоже зрелищно драться ими, научи ботов ими биться зрелищно»). Бой — не
// ваншот, а размен: взрывы, «попы» тотемов, обсидиан вокруг ног, подрыв
// стрелой издалека. Без глупых самоподрывов и без действий сквозь стену.
//
// Механика — байткод Paper 1.21.11 (codex-lab/end-bytecode: EndCrystal,
// ServerExplosion, ExplosionDamageCalculator, LivingEntity) и декомпиляция
// клиента 1.21.11 (extremeheat/extracted_minecraft_data):
//  * EndCrystal.hurtServer: любой урон не от взрыва — remove и взрыв силы 6.0
//    в getX/Y/Z (низ кристалла = верх обсидиана), ExplosionInteraction.BLOCK,
//    приписан ударившему (damageSources.explosion(this, атакующий)); урон от
//    взрыва (чужой кристалл рядом) — remove БЕЗ взрыва: цепочек нет.
//  * EndCrystalItem.useOn: кликнутый блок — obsidian или bedrock (грань любая),
//    клетка над ним isEmptyBlock, в рамке [x,y+1,z]..[x+1,y+3,z+1] нет НИКАКИХ
//    сущностей (игроки, предметы, стрелы, рамки 2×2 соседних кристаллов).
//  * ServerExplosion.hurtEntities: d = |ноги − центр| / 12, > 1 — мимо;
//    видимость getSeenPercent (сетка по рамке, ClipContext.COLLIDER — луч от
//    точки рамки к центру); урон ((i² + i)/2·7·12 + 1), i = (1 − d)·вид.
//    Толчок (1 − d)·вид·(1 − explosion_knockback_resistance) по «центр → глаза»
//    («Взрывоустойчивость» +0.15 за уровень на вещь).
//  * LivingEntity.hurtServer: invulnerableTime > 10 (из 20) — урон не больше
//    lastHurt не проходит вовсе, больший — только разница. Значит второй
//    кристалл в 10 тиков после первого пропадает: ритм подрывов ≥ 0.5 с, а
//    свой следующий кристалл ставится заранее и бьётся, когда окно кончилось.
//    Обратное — своё окно: только что получил взрыв сырой силы R — чужой
//    кристалл со своими ≤ R бьётся «бесплатно» (ему — полностью).
//  * Урон после брони (CombatRules), чары: «Защита» 1, «Взрывоустойчивость»
//    2 за уровень, сумма ≤ 20 → ×(1 − EPF/25); сложность до брони: «трудно»
//    ×1.5, «легко» min(f/2+1, f) (boom.blast, Player.hurtServer).
//  * Пакеты при подрыве: damage_event и «поп» тотема (35) — из hurtServer, до
//    пакета взрыва; сущность кристалла снимается (remove) тоже раньше взрыва.
//  * RespawnAnchorBlock (бонус): светокамнем — заряд; «использовать» не
//    светокамнем в верхнем мире или Крае — removeBlock и взрыв 5 с огнём в
//    центре блока, ни на кого не записан.
// Приёмы (PVP-RESEARCH б.10, в.3; гайды Crystal PvP): кристалл у его ног —
// ближе к нему, чем к себе; подрыв рукой в 2–3 тика или стрелой с 6+ блоков;
// заранее поставленный кристалл во время его неуязвимости; surround — обсидиан
// с 4 сторон у своих ног (кристалл на уровне ног не встанет, а на блоке
// окружения закрыт снизу); сбить его кристалл, когда ему больнее или в своё
// окно; отойти, если его кристалл у меня и он его достаёт.

const Vec3 = require('vec3')
const boom = require('./boom')
const pick = require('./pick')

const P = 6
const EYE = 1.62
const HIT_R = 3.0
const PLACE_R = 4.5
const TICK = 50
const IFRAME_MS = 500
const ON = process.env.ND_CRYSTAL !== '0'
const DEBUG = !!process.env.ND_DEBUG_CRYSTAL
const AIRS = new Set(['air', 'cave_air', 'void_air'])
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
// Якорь: сила 5, взрывается там, где не работает (верхний мир, Край).
const ANCHOR_P = 5
const ANCHOR_WORLDS = /overworld|end$|the_end/
// Якорь готов к бою: якоря и светокамень есть, измерение — где он взрывается.
const anchorReady = (bot, k) => k.anchors > 0 && k.glowstone > 0 && ANCHOR_WORLDS.test(bot.game && bot.game.dimension || 'overworld')

const sleep = (ms) => new Promise<any>(r => gameClock.setTimeout(r, ms))
const r1 = (x) => Math.round(x * 10) / 10
// S7c (07.10): щит в размене и в защите, уход в укрытие и блок между, хп соперника-игрока — оценкой.
// ND_CX2=0 — поведение до S7c (A/B серий).
const CX2 = process.env.ND_CX2 !== '0'

// Щит (javap 1.21.11, research/claude-1006/s7c/jar): взрыв кристалла/якоря не в #bypasses_shield,
// LivingEntity.applyItemBlocking → BlocksAttacks.resolveBlockedDamage по DamageSource.getSourcePosition
// (кристалл — его позиция, якорь — центр блока): горизонтальный угол взгляда на источник ≤ 90° — урон 0
// (DamageReduction щита: base 0, factor 1). Толчок взрыва щит не гасит (ServerExplosion.hurtEntities: push
// после hurtServer). Держит через 5 тиков после подъёма.
function shieldUpOf (bot, e) {
  try { const u = require('./pvp/combat-observe').usingOf(bot, e); return !!(u && u.name === 'shield') } catch { return false }
}
// Кэш лучей без одной клетки: якорь снимается раньше взрыва (RespawnAnchorBlock.explode: removeBlock, потом
// explode) — его блок лучам не преграда. Кэш — как в boom.segmentBlocked (get/set по «x,y,z»).
function without (cache, cell) {
  const ak = `${cell.x},${cell.y},${cell.z}`
  return { get: (k) => (k === ak ? null : cache.get(k)), set: (k, v) => { if (k !== ak) cache.set(k, v) }, has: (k) => k === ak || cache.has(k) }
}
function shieldCovers (e, at, src) {
  const dm = require('./pvp/damage-model')
  return dm.shieldAngle(e.headYaw ?? e.yaw ?? 0, at || e.position, src) <= dm.SHIELD_HALF_ANGLE
}

// ---------------------------------------------------------------- геометрия

function boxOf (e) {
  const w = e.width ?? 0.6
  const h = e.height ?? 1.8
  const p = e.position
  return { minX: p.x - w / 2, minY: p.y, minZ: p.z - w / 2, maxX: p.x + w / 2, maxY: p.y + h, maxZ: p.z + w / 2 }
}
function intersects (a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ
}
// Рамка кристалла 2×2×2 с центром низа в c.
function crystalBox (c) { return { minX: c.x - 1, minY: c.y, minZ: c.z - 1, maxX: c.x + 1, maxY: c.y + 2, maxZ: c.z + 1 } }
function boxDist (p, b) {
  const x = Math.max(b.minX, Math.min(p.x, b.maxX))
  const y = Math.max(b.minY, Math.min(p.y, b.maxY))
  const z = Math.max(b.minZ, Math.min(p.z, b.maxZ))
  return Math.hypot(p.x - x, p.y - y, p.z - z)
}

function blockAt (bot, cache, x, y, z) {
  const k = `${x},${y},${z}`
  if (cache && cache.has('b' + k)) return cache.get('b' + k)
  let b = null
  try { b = (cache?.world || bot).blockAt(new Vec3(x, y, z), false) } catch {}
  if (cache) cache.set('b' + k, b)
  return b
}
const copyCache = cache => Object.assign(new Map(cache), cache?.world ? { world: cache.world } : {})
const isAirB = (b) => !!b && AIRS.has(b.name)
const isBaseB = (b) => !!b && (b.name === 'obsidian' || b.name === 'bedrock')
const solidB = (b) => !!b && b.boundingBox === 'block'

// Можно ли поставить кристалл на блок base (EndCrystalItem.useOn): обсидиан
// или бедрок, над ним воздух, в столбе 1×2 над ним ни одной сущности.
function baseFree (bot, base, { cache = null, ents = null }: any = {}) {
  if (!isBaseB(blockAt(bot, cache, base.x, base.y, base.z))) return false
  if (!isAirB(blockAt(bot, cache, base.x, base.y + 1, base.z))) return false
  const col = { minX: base.x, minY: base.y + 1, minZ: base.z, maxX: base.x + 1, maxY: base.y + 3, maxZ: base.z + 1 }
  for (const e of ents || (Object.values(bot.entities || {}) as any[])) {
    if (!e || !e.position || e.isValid === false) continue
    if (intersects(col, boxOf(e))) return false
  }
  return true
}
const centerOf = (base) => new Vec3(base.x + 0.5, base.y + 1, base.z + 0.5)

// Живое и кристаллы перекрывают прицел клиента (GameRenderer.pick: сущность
// под лучом раньше блока — клик уйдёт в неё, не в грань).
function pickBlockers (bot, eye) {
  return (Object.values(bot.entities || {}) as any[]).filter((e : any) => e && e !== bot.entity && e.position && e.isValid !== false &&
    e.position.distanceTo(eye) < 9 && (e.type === 'player' || e.name === 'end_crystal' || /mob|hostile|animal|passive|water|ambient/.test(e.type || '')))
}

// Грань блока base, в которую можно честно кликнуть (pick.faceAim): верх
// первым, потом бока к нам. Возвращает { face, pt } или null.
const FACES = [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
function faceFor (bot, base, eye, avoid) {
  for (const f of FACES) {
    const c = base.offset(0.5 + f.x * 0.5, 0.5 + f.y * 0.5, 0.5 + f.z * 0.5)
    if ((eye.x - c.x) * f.x + (eye.y - c.y) * f.y + (eye.z - c.z) * f.z <= 0) continue
    if (c.distanceTo(eye) > PLACE_R + 0.6) continue
    const pt = pick.faceAim(bot, base, f, { eye, range: PLACE_R - 0.05, avoid })
    if (pt) return { face: f, pt }
  }
  return null
}

// Ударить кристалл (в точке center) отсюда: рамка 2×2×2 в 3.0 от глаз, луч к
// точке рамки не упирается в блок (как pick.aim) и не проходит сквозь рамку
// сущности раньше кристалла — он сам, другой кристалл, моб: прицел клиента взял
// бы их, не кристалл (GameRenderer.pick; ревью Codex 2026-09-30). Перебор точек
// рамки — кристалл за его спиной виден краем.
const AIM_FRACS = []
for (const fy of [0.5, 0.8, 0.3, 0.95, 0.1]) {
  for (const [fx, fz] of [[0.5, 0.5], [0.15, 0.5], [0.85, 0.5], [0.5, 0.15], [0.5, 0.85], [0.15, 0.15], [0.85, 0.85], [0.15, 0.85], [0.85, 0.15]]) AIM_FRACS.push([fx, fy, fz])
}
function hitAim (bot, center, eye, range = HIT_R - 0.1) {
  const cb = crystalBox(center)
  if (boxDist(eye, cb) > range) return null
  const lo = { x: cb.minX, y: cb.minY, z: cb.minZ }
  const hi = { x: cb.maxX, y: cb.maxY, z: cb.maxZ }
  const occ = pickBlockers(bot, eye).filter((e : any) => e.position.distanceTo(center) >= 0.2).map(boxOf)
  for (const [fx, fy, fz] of AIM_FRACS) {
    const tp = new Vec3(lo.x + 2 * fx, lo.y + 2 * fy, lo.z + 2 * fz)
    const delta = tp.minus(eye)
    const len = delta.norm()
    if (len < 1e-6) return tp
    const d = delta.scaled(1 / len)
    const tE = pick.rayBox(eye, d, lo, hi, range + 0.001)
    if (tE == null || tE > range) continue
    if (pick.blockOnRay(bot, eye, d, tE)) continue
    if (occ.some(b => { const t = pick.rayBox(eye, d, { x: b.minX, y: b.minY, z: b.minZ }, { x: b.maxX, y: b.maxY, z: b.maxZ }, tE); return t != null && t < tE - 0.02 })) continue
    return tp
  }
  return null
}

// Независимая проверка «не сквозь стену» для счёта (другой луч — prismarine
// world.raycast по формам блоков): первый блок на пути к точке — не раньше неё.
function losClear (bot, eye, pt, { expectBlock = null }: any = {}) {
  try {
    const d = pt.minus(eye)
    const len = d.norm()
    if (len < 1e-3) return true
    const hit = bot.world.raycast(eye, d.scaled(1 / len), len + 0.05)
    if (!hit) return true
    if (expectBlock && hit.position && hit.position.equals(expectBlock)) return true
    const at = hit.intersect ? hit.intersect.distanceTo(eye) : hit.position.offset(0.5, 0.5, 0.5).distanceTo(eye)
    return at >= len - 0.03
  } catch { return false }
}

// ---------------------------------------------------------------- состояние тела

function effHp (bot, e) {
  if (e === bot.entity) return (bot.health ?? 20) + (require('./totem').absorption(bot) || 0)
  let h = null
  try {
    const keys = bot.registry.entitiesByName[e.name || 'player'].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const v = e.metadata && e.metadata[i >= 0 ? i : 9]
    if (typeof v === 'number') h = v
  } catch {}
  let abs = 0
  try { abs = require('./read').absorptionOf(bot, e) || 0 } catch {}
  return (h ?? 20) + abs
}
function countOf (bot, name) { return bot.inventory.items().reduce((n, i) => n + (i.name === name ? i.count : 0), 0) }
function kitOf (bot) {
  return {
    crystals: countOf(bot, 'end_crystal'),
    obsidian: countOf(bot, 'obsidian'),
    bow: !!bot.inventory.items().find(i => i.name === 'bow'),
    arrows: !!bot.inventory.items().find(i => /arrow$/.test(i.name)),
    totems: countOf(bot, 'totem_of_undying') + (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'totem_of_undying' ? 1 : 0),
    anchors: countOf(bot, 'respawn_anchor'),
    glowstone: countOf(bot, 'glowstone')
  }
}
// Износ надетой брони с «Починкой»: доля потраченной прочности у самой
// изношенной вещи и сколько прочности не хватает всем вместе (slots 5..8).
function armorWear (bot) {
  const read = require('./read')
  let worst = 0; let missing = 0; let mending = 0
  const items = {}
  for (const sl of [5, 6, 7, 8]) {
    const it = bot.inventory.slots[sl]
    if (!it || !it.maxDurability) continue
    if (read.enchLevel(bot, it, 'mending') <= 0) continue
    mending++
    const used = it.durabilityUsed || 0
    items[sl] = { name: it.name, used }
    missing += used
    worst = Math.max(worst, used / it.maxDurability)
  }
  return { worst, missing, mending, items }
}
function surrounded (bot, cell, cache) {
  return SIDES.every(s => solidB(blockAt(bot, cache, cell.x + s.x, cell.y, cell.z + s.z)))
}
function feetCell (p) { return new Vec3(Math.floor(p.x), Math.floor(p.y + 1e-3), Math.floor(p.z)) }

// ---------------------------------------------------------------- оценка

// Размен от взрыва в center: ему и мне (после брони и чар), сырые значения —
// для окна неуязвимости.
// meMax — мне при полной видимости (без лучей): предел «свой тотем — никогда»
// держится на нём, а не на лучах. Финальная партия b4: 15 из 298 подрывов
// дали мне больше прогноза на 3+ (шаг из-за укрытия за 2–3 тика до взрыва,
// лучи вскользь по краю окружения), один — хлопнул свой тотем при прогнозе 0.3.
// himShield — его щит поднят (shieldUpOf): источник в его передних 90° — ему 0 (сырой тоже: окна нет).
function trade (bot, center, him, me, dHim, dMe, cache, { himAt = null, meAt = null, power = P, himShield = false }: any = {}) {
  let h = boom.blast(bot, center, power, himAt || him.position, { def: dHim, cache })
  if (himShield && h.raw > 0 && shieldCovers(him, himAt, center)) h = { ...h, dmg: 0, raw: 0, blocked: true }
  const m = boom.blast(bot, center, power, meAt || me.position, { def: dMe, cache })
  const mx = boom.blast(bot, center, power, meAt || me.position, { def: dMe, seen: 1 })
  return { him: h.dmg, me: m.dmg, meMax: mx.dmg, himRaw: h.raw, meRaw: m.raw, himSeen: h.seen, meSeen: m.seen }
}

// Урон, который ему реально пройдёт с учётом его окна неуязвимости: в окне
// проходит только превышение сырого над последним ударом (очень грубо —
// пропорцией от урона после брони).
// def — его защита: броня применяется к разнице сырого (LivingEntity.hurtServer
// → actuallyHurt(amount − lastHurt)), не пропорцией (ревью Codex: 3.2 против 1.6).
function landed (t, win, def = null) {
  if (!win) return t.him
  if (t.himRaw <= win.raw + 0.5) return 0
  const delta = t.himRaw - win.raw
  if (!def) return t.him * delta / t.himRaw
  const assess = require('./assess')
  return assess.afterArmor(delta, def.armor, def.tough) * (1 - (def.epf || 0) / 25) * Math.max(0, 1 - 0.2 * (def.resist || 0))
}

// Что стоит сделать с кристаллом сейчас. me — моё состояние; opts.minNet —
// сколько «ему минус мне» считать выгодой.
// Свой тотем своим же кристаллом не хлопать никогда (запас 3 хп); ему —
// заметно; размен в нашу пользу хотя бы в 1.3 раза и не больше ~45% своего.
// Добить (или сбить его тотем) — можно и при равном размене, если себе не
// смертельно. Симметричная броня с «Взрывоустойчивостью» на открытом поле
// даёт ~12.6 ему у ног и ~7.5 себе с 3.5 блоков — это ещё размен; себе
// больше, чем ему, — никогда.
// press — долго без размена (нажим pvp.js): размен 1:1 тоже годится, лишь бы
// себе не смертельно, — иначе два бота в окружениях стоят до «застоя».
// hisTotem — тотем у него в руке: «добить» — лишь сбить тотем, и за это
// большой ценой себе (до смертельного) не платить — только обычным пределом.
function worthHit (t, { myEff, hisEff, hisLand, press = false, hisTotem = false }: any) {
  const worst = Math.max(t.me, t.meMax ?? t.me)
  // ND_CRYSTAL_RECKLESS=1 (арена 10.10: «пусть все взрывают друг друга»): рвать, если ему ≥ 2.5, а сам переживу с запасом 2.
  if (process.env.ND_CRYSTAL_RECKLESS === '1') return hisLand >= 2.5 && worst < myEff - 2
  if (worst >= myEff - 3) return false
  if (hisLand < 2.5) return false
  const kill = hisLand >= hisEff - 0.5
  if (kill && hisLand >= t.me && (hisTotem ? t.me <= Math.max(2.5, myEff * 0.45) : worst < myEff - 4)) return true
  if (press) return hisLand >= t.me && t.me <= Math.max(2.5, myEff * 0.6) && t.me < myEff - 4
  return hisLand >= t.me * 1.3 + 0.5 && t.me <= Math.max(2.5, myEff * 0.45)
}

// ---------------------------------------------------------------- бой

// foeHp(foe) — ЭХП соперника-игрока для решений: оценка (pvp.foeHpDecide, правило 06.10 «хп игрока только
// оценкой»); без неё — prior 20, для мобов — метаданные. telemetryHp — только замеры отчёта.
// noteAttack(range, {projectile}) — подтверждённый урон для
// оценки (combat-observe.trackFoe): damage_event с причиной «я» вычитает этот интервал.
function create (bot, { enemy, used = () => {}, foeHp = null, noteAttack = null, telemetryHp = e => effHp(bot, e), guard = null }: any = {}) {
  const st: any = {
    placed: 0, obby: 0, hits: 0, shots: 0, pre: 0, booms: 0, mine: 0, his: 0,
    dealt: [], self: 0, selfPops: 0, popsDealt: 0, popsTaken: 0, hisPops: 0, myPops: 0,
    surround: 0, surroundBlocks: 0, defuse: 0, free: 0, dodges: 0,
    wallPlace: 0, wallHit: 0, fails: {},
    // Его подрывы у меня: threats — взрыв, который при полной видимости снял бы мне ≥ 4; evaded — из них
    // пришло ≤ max(1.5, четверть); threatMax/threatTaken — суммы прогноза и пришедшего (телеметрия, точное хп своё).
    threats: 0, evaded: 0, threatMax: 0, threatTaken: 0
  }
  const isPlayerE = (e) => !!e && (e.type === 'player' || !!e.username)
  const hisHp = (foe) => {
    if (isPlayerE(foe)) { const v = foeHp?.(foe); return typeof v === 'number' && Number.isFinite(v) ? v : 20 }
    return effHp(bot, foe)
  }
  const mine = new Map() // id → { at, how, hitAt }
  const exploded = [] // { at, center, mine }
  // Окно неуязвимости: принятый удар открывает 10 тиков; больший удар внутри
  // окна проходит разницей и окно НЕ продлевает (LivingEntity.hurtServer;
  // ревью Codex) — начало держим, сырой поднимаем до большего.
  const winUpdate = (w, at, raw) => (w && at - w.at < IFRAME_MS ? { at: w.at, raw: Math.max(w.raw, raw) } : { at, raw })
  let myWin = null // { at, raw } — моё окно неуязвимости после взрыва
  let hisWin = null
  let myHurtAt = 0
  let hisHurtAt = 0
  let sawHis = 0 // когда он показал кристалл/обсидиан (в руке, свой кристалл)
  let pendingAt = 0
  let lastSurround = 0
  let lastDodge = 0
  let lastPlaceShoot = 0
  let lastEat = 0
  let lastObby = 0
  let lastMend = 0
  let lastAnchor = 0
  let shieldUntil = 0
  let bowSeenAt = -1e9
  // Щит подряд (s7c1 «кристалл со щитом» р.3: оба 75 раз под щитом, 192 с ничья): дольше 2.5 с без подрыва —
  // щит из вариантов уклонения вон, остаются укрытие/блок/отход (кристалл стоит — уйти от него, а не стоять).
  let shieldStreakAt = 0
  let shieldLastEnd = -1e9
  let coverSince = null
  // Якоря рядом (S7c, просьба пользователя 01:26 — наравне с кристаллами): блоки respawn_anchor по blockUpdate;
  // mine — поставил я. anchorClick — мой клик-подрыв (свой или его якорь): чей взрыв силы 5.
  const anchorsAt = new Map()
  const myAnchorCells = new Set()
  // Честное восприятие (S7d, открытое №3 S7c): его кристаллы — только увиденные (луч от моих глаз до кристалла без
  // блоков, или этот кристалл я уже видел), якоря — мои или увиденные (pick.blockSeen: верх/грань в прицеле глаз),
  // его снаряжение (лук, кристалл в руке) запоминается, только пока он сам мне виден. blockUpdate/entity_spawn
  // приходят на всё в прогруженных чанках — это знание мира, не взгляд. ND_HONEST_CX=0 — прежнее (для сравнения).
  const HONEST = process.env.ND_HONEST_CX !== '0'
  const seenCrystals = new Set()
  const myEye = () => bot.entity.position.offset(0, EYE, 0)
  const crystalSeen = (e) => {
    if (!HONEST) return true
    if (seenCrystals.has(e.id)) return true
    const eye = myEye()
    if (losClear(bot, eye, e.position.offset(0, 1, 0))) { seenCrystals.add(e.id); st.seenCrystals = (st.seenCrystals || 0) + 1; return true }
    st.hiddenCrystals = (st.hiddenCrystals || 0) + 1
    return false
  }
  const foeVisible = (foe) => !HONEST || (foe && foe.position && losClear(bot, myEye(), foe.position.offset(0, 1.2, 0)))
  const anchorSeen = (a) => {
    const now = gameClock.now()
    if (now - (a.checkAt ?? -Infinity) < 250) return !!(a.seen || a.mine)
    a.checkAt = now
    try {
      const b = bot.blockAt(a.pos, false)
      if (b?.name === 'respawn_anchor') {
        if (!HONEST || pick.blockSeen(bot, a.pos)) {
          a.seen = true
          a.charges = Number(b.getProperties?.().charges) || 0
        }
      } else if (b) {
        // Пропажу тоже нужно увидеть: packet за стеной не стирает память якоря.
        const eye = myEye(); const d = a.pos.offset(.5, .5, .5).minus(eye); const len = d.norm()
        if (!HONEST || len <= 64) {
          const hit = len > 0 ? pick.blockOnRay(bot, eye, d.scaled(1 / len), len) : null
          if (!HONEST || !hit || hit.pos.equals(a.pos)) { anchorsAt.delete(cellKey(a.pos)); return false }
        }
      }
    } catch {}
    return !!(a.seen || a.mine)
  }
  let anchorClick = null
  const cellKey = (p) => `${p.x},${p.y},${p.z}`
  let worstCache = { at: 0, v: 0 }
  const fail = (why) => { st.fails[why] = (st.fails[why] || 0) + 1 }

  const gone = []
  const onGone = (e) => {
    try {
      if (!e || e.name !== 'end_crystal' || !e.position) return
      gone.push({ id: e.id, pos: e.position.clone(), at: gameClock.now() })
      while (gone.length > 30) gone.shift()
    } catch {}
  }
  // Когда кристалл появился: его подрыв «сразу» (≤ 6 тиков — поставил и ударил) от него не уйти, «потом»
  // (заранее в моё окно, стрелой издалека) — уклонению время есть. Счёт уклонений — по обоим.
  const spawnAt = new Map()
  const onSpawn = (e) => {
    try {
      if (!e || e.name !== 'end_crystal') return
      spawnAt.set(e.id, gameClock.now())
      if (spawnAt.size > 60) spawnAt.delete(spawnAt.keys().next().value)
      if (!mine.has(e.id)) {
        const foe = enemy()
        if (foe && foe.position && e.position.distanceTo(foe.position) < 6 && crystalSeen(e)) sawHis = gameClock.now()
      }
    } catch {}
  }
  // Его окно и от удара рукой: сырой крит мечом с «Остротой» ~13 — кристалл
  // (40–75 сырого) пройдёт разницей; взрыв ставит окно сам (onExplosion).
  const onHurt = (e) => {
    try {
      const foe = enemy()
      const now = gameClock.now()
      if (bot.entity && e && e.id === bot.entity.id) myHurtAt = now
      else if (foe && e && e.id === foe.id) {
        hisHurtAt = now
        const boomNow = exploded.length && now - exploded[exploded.length - 1].at < 120
        if (!boomNow && !(hisWin && now - hisWin.at < IFRAME_MS)) hisWin = { at: now, raw: 13 }
      }
    } catch {}
  }
  // Взрыв: чей кристалл (сущность ещё в мире — пакет взрыва приходит раньше
  // remove_entities), сырой удар мне и ему по модели — окна неуязвимости; урон
  // и «поп» — за 400 мс после.
  const onExplosion = (pkt) => {
    try {
      const c = pkt && pkt.center
      // Якорь (сила 5): счёт и окна неуязвимости; остальное — только кристаллы.
      if (c && pkt.radius > 4.5 && pkt.radius < 5.5) {
        st.anchorSeen = (st.anchorSeen || 0) + 1
        const at5 = new Vec3(c.x, c.y, c.z)
        const f5 = enemy()
        const now5 = gameClock.now()
        if (bot.entity) { const m = boom.blast(bot, at5, 5, bot.entity.position, { def: boom.defenseOf(bot, bot.entity) }); if (m.raw > 1.01) myWin = winUpdate(myWin, now5, m.raw) }
        if (f5 && f5.position) { const h = boom.blast(bot, at5, 5, f5.position, { def: boom.defenseOf(bot, f5) }); if (h.raw > 1.01) hisWin = winUpdate(hisWin, now5, h.raw) }
        // Счёт якорей (телеметрия, точное хп): мой клик по этой клетке за 600 мс — мой подрыв (свой якорь или
        // его, сбитый первым); иначе — его подрыв у меня: прогноз при полной видимости и что пришло.
        const k5 = cellKey(new Vec3(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z)))
        const own5 = !!(anchorClick && anchorClick.key === k5 && now5 - anchorClick.at < 600)
        const his0 = f5 && f5.position ? telemetryHp(f5) : null
        const my0 = bot.entity ? effHp(bot, bot.entity) : 0
        let thr5 = 0
        if (!own5 && bot.entity) { try { thr5 = boom.blast(bot, at5, 5, bot.entity.position, { def: boom.defenseOf(bot, bot.entity), seen: 1 }).dmg } catch {} }
        gameClock.setTimeout(() => {
          try {
            const popHim = pops.some(p => p.who === 'him' && p.at >= now5 - 150 && p.at <= now5 + 400)
            const popMe = pops.some(p => p.who === 'me' && p.at >= now5 - 150 && p.at <= now5 + 400)
            const f = enemy()
            const my1 = effHp(bot, bot.entity)
            if (own5) {
              const his1 = f && f.isValid !== false ? telemetryHp(f) : 0
              if (his0 != null && (popHim || his1 != null)) (st.anchorDealt = st.anchorDealt || []).push(r1(popHim ? Math.max(0, his0) : Math.max(0, his0 - his1)))
              st.anchorSelf = r1((st.anchorSelf || 0) + (popMe ? my0 : Math.max(0, my0 - my1)))
              if (popMe) st.anchorSelfPops = (st.anchorSelfPops || 0) + 1
            } else if (thr5 >= 4) {
              const took = popMe ? my0 : Math.max(0, my0 - my1)
              st.anchorThreats = (st.anchorThreats || 0) + 1
              st.anchorThreatMax = r1((st.anchorThreatMax || 0) + thr5)
              st.anchorThreatTaken = r1((st.anchorThreatTaken || 0) + took)
              if (took <= Math.max(1.5, thr5 * 0.25)) st.anchorEvaded = (st.anchorEvaded || 0) + 1
            }
          } catch {}
        }, 400)
        return
      }
      if (!c || !(pkt.radius > 5.5 && pkt.radius < 6.5)) return
      const at = new Vec3(c.x, c.y, c.z)
      // Сущность снята раньше пакета взрыва (remove → ClientboundRemoveEntities
      // сразу, взрыв — после explode): ищем и среди только что снятых.
      let ent = null
      for (const e of ((Object.values(bot.entities) as any[]) as any)) if (e && e.name === 'end_crystal' && e.position && e.position.distanceTo(at) < 0.2) { ent = e; break }
      if (!ent) { const g = gone.find(x => gameClock.now() - x.at < 1000 && x.pos.distanceTo(at) < 0.2); if (g) ent = { id: g.id } }
      const rec = ent && mine.get(ent.id)
      const age = ent && spawnAt.has(ent.id) ? gameClock.now() - spawnAt.get(ent.id) : null
      const own = !!(rec && rec.hitAt && gameClock.now() - rec.hitAt < 600)
      st.booms++
      if (own) st.mine++; else st.his++
      const foe = enemy()
      const cache = new Map()
      const now = gameClock.now()
      if (bot.entity) {
        const m = boom.blast(bot, at, P, bot.entity.position, { def: boom.defenseOf(bot, bot.entity), cache })
        if (m.raw > 1.01) myWin = winUpdate(myWin, now, m.raw)
      }
      let hisBefore = null
      if (foe && foe.position) {
        const h = boom.blast(bot, at, P, foe.position, { def: boom.defenseOf(bot, foe), cache })
        if (h.raw > 1.01) hisWin = winUpdate(hisWin, now, h.raw)
        hisBefore = telemetryHp(foe)
      }
      const myBefore = effHp(bot, bot.entity)
      // Его подрыв рядом со мной: что дал бы при полной видимости (без щита и укрытия).
      let threat = 0
      if (!own && bot.entity) { try { threat = boom.blast(bot, at, P, bot.entity.position, { def: boom.defenseOf(bot, bot.entity), seen: 1 }).dmg } catch {} }
      const ev: any = { at: now, center: at, own, hisBefore, myBefore, popHim: false, popMe: false, threat, slow: age != null && age > 300 }
      exploded.push(ev)
      while (exploded.length > 40) exploded.shift()
      gameClock.setTimeout(() => {
        try {
          // «Поп» тотема (событие 35) сервер шлёт из hurtServer — РАНЬШЕ пакета
          // взрыва (ServerLevel.explode: explode(), потом ClientboundExplode).
          const popAt = (who) => pops.some(p => p.who === who && p.at >= ev.at - 150 && p.at <= ev.at + 400)
          ev.popHim = popAt('him')
          ev.popMe = popAt('me')
          if (ev.popHim && own) st.popsDealt++
          if (ev.popMe && !own) st.popsTaken++
          const f = enemy()
          const hisAfter = f && f.isValid !== false ? telemetryHp(f) : 0
          const myAfter = effHp(bot, bot.entity)
          if (own) {
            const dealt = hisBefore == null || (!ev.popHim && hisAfter == null) ? null : ev.popHim ? Math.max(0, hisBefore) : Math.max(0, hisBefore - hisAfter)
            if (dealt != null) st.dealt.push(r1(dealt))
            const self = ev.popMe ? myBefore : Math.max(0, myBefore - myAfter)
            st.self = r1(st.self + self)
            if (DEBUG) console.log('[crystal] мой взрыв:', JSON.stringify({ dealt: dealt == null ? null : r1(dealt), self: r1(self), popHim: ev.popHim, popMe: ev.popMe }))
          }
          // Всё, что пришло от его подрывов (и тех, от которых ушёл дальше «угрозы»): урон на его подрыв.
          if (!own) st.hisTaken = r1((st.hisTaken || 0) + (ev.popMe ? myBefore : Math.max(0, myBefore - myAfter)))
          if (!own && ev.threat >= 4) {
            const took = ev.popMe ? myBefore : Math.max(0, myBefore - myAfter)
            st.threats++
            st.threatMax = r1(st.threatMax + ev.threat)
            st.threatTaken = r1(st.threatTaken + took)
            const ok = took <= Math.max(1.5, ev.threat * 0.25)
            if (ok) st.evaded++
            if (ev.slow) { st.threatsSlow = (st.threatsSlow || 0) + 1; if (ok) st.evadedSlow = (st.evadedSlow || 0) + 1; st.threatSlowMax = r1((st.threatSlowMax || 0) + ev.threat); st.threatSlowTaken = r1((st.threatSlowTaken || 0) + took) }
            if (DEBUG) console.log('[crystal] его взрыв у меня:', JSON.stringify({ threat: r1(ev.threat), took: r1(took), shield: shieldUntil > ev.at }))
          }
        } catch {}
      }, 400)
    } catch {}
  }
  const pops = []
  // Кто меня ранил последним (damage_event: sourceCauseId = id + 1): «поп»
  // тотема сервер шлёт в том же hurtServer сразу после — самоподрыв это мой
  // тотем от урона, причина которого — я сам (свой кристалл), и только он.
  let lastDmg = null
  const onDamage = (p) => {
    try {
      if (!bot.entity || p.entityId !== bot.entity.id) return
      lastDmg = { at: gameClock.now(), self: p.sourceCauseId === bot.entity.id + 1 }
    } catch {}
  }
  const onStatus = (p) => {
    try {
      if (p.entityStatus !== 35) return
      const foe = enemy()
      const now = gameClock.now()
      if (bot.entity && p.entityId === bot.entity.id) {
        st.myPops++
        pops.push({ at: now, who: 'me' })
        if (lastDmg && lastDmg.self && now - lastDmg.at < 120) { st.selfPops++; try { used('САМОПОДРЫВ: свой тотем от своего взрыва') } catch {} }
      } else if (foe && p.entityId === foe.id) { st.hisPops++; pops.push({ at: now, who: 'him' }) }
      while (pops.length > 40) pops.shift()
    } catch {}
  }
  const onBlock = (oldB, newB) => {
    try {
      const b = newB || oldB
      if (!b || !b.position) return
      const k = cellKey(b.position)
      if (newB && newB.name === 'respawn_anchor' && !anchorsAt.has(k)) anchorsAt.set(k, { pos: newB.position.clone(), mine: myAnchorCells.has(k), at: gameClock.now() })
      const a = anchorsAt.get(k)
      if (a) { a.checkAt = -Infinity; anchorSeen(a) }
    } catch {}
  }
  bot.on('entitySpawn', onSpawn)
  bot.on('entityGone', onGone)
  bot.on('entityHurt', onHurt)
  bot.on('blockUpdate', onBlock)
  try { bot._client.on('explosion', onExplosion) } catch {}
  try { bot._client.on('entity_status', onStatus) } catch {}
  try { bot._client.on('damage_event', onDamage) } catch {}
  const close = () => {
    bot.removeListener('entitySpawn', onSpawn)
    bot.removeListener('entityGone', onGone)
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('blockUpdate', onBlock)
    try { bot._client.removeListener('explosion', onExplosion) } catch {}
    try { bot._client.removeListener('entity_status', onStatus) } catch {}
    try { bot._client.removeListener('damage_event', onDamage) } catch {}
  }

  const inWin = (w, ms = IFRAME_MS - 20) => w && gameClock.now() - w.at < ms ? w : null
  // Только кристалл (в руке или поставленный у нас): обсидиан в руке — ещё не
  // кристаллы («арсенал»: обсидиан — на коробку), и «бой кристаллами» с его
  // запретом коробки и перестрелки тогда включался бы зря.
  const heShows = (foe) => {
    const eq = (foe && foe.equipment) || []
    if (eq.slice(0, 2).some(it => it && /^(end_crystal|respawn_anchor)$/.test(it.name)) && foeVisible(foe)) sawHis = gameClock.now()
    return gameClock.now() - sawHis < 60000
  }

  // Худший для меня кристалл, который он может поставить прямо сейчас
  // (обсидиан/бедрок в 4.5 от его глаз, рядом со мной, столб свободен).
  function worstVsMe (foe, cache, dMe) {
    const now = gameClock.now()
    if (now - worstCache.at < 250) return worstCache.v
    const me = bot.entity.position
    const cell = feetCell(me)
    const hisEye = foe.position.offset(0, EYE, 0)
    const ents = (Object.values(bot.entities) as any[])
    let worst = 0
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = -2; dy <= 0; dy++) {
          const base = new Vec3(cell.x + dx, cell.y + dy, cell.z + dz)
          if (!baseFree(bot, base, { cache, ents })) continue
          const c = centerOf(base)
          if (c.distanceTo(hisEye) > PLACE_R + 0.3) continue
          if (boxDist(hisEye, crystalBox(c)) > HIT_R + 0.6) continue
          const m = boom.blast(bot, c, P, me, { def: dMe, cache })
          if (m.dmg > worst) worst = m.dmg
        }
      }
    }
    worstCache = { at: now, v: worst }
    return worst
  }

  // ------------------------------------------------------------ уклонение (S7c)
  // Его кристалл у меня, он его достаёт. Варианты — щит лицом к кристаллу, клетка-укрытие, блок между —
  // считаются ожидаемым уроном: пока вариант не готов (тики), подрыв может прийти с прежней силой.
  // Подрыв — равномерно в ближайшие haz тиков (evade: 6, если он достаёт кристалл рукой или лук в руке, иначе 25).

  const passable = (b) => !!b && b.boundingBox === 'empty' && !/lava|fire|cobweb|water|powder_snow/.test(b.name)
  const standable = (cell, cache) => {
    const below = blockAt(bot, cache, cell.x, cell.y - 1, cell.z)
    return solidB(below) && below.name !== 'magma_block' && passable(blockAt(bot, cache, cell.x, cell.y, cell.z)) && passable(blockAt(bot, cache, cell.x, cell.y + 1, cell.z))
  }
  // Сколько мне от его кристаллов в точке pos: худший целиком, остальные — доля (окно после первого).
  function hurtAt (threats, pos, dMe, cache) {
    const d = threats.map(th => boom.blast(cache?.world || bot, th.c.position, th.power || P, pos, { def: dMe, cache: th.cell ? without(cache, th.cell) : cache }).dmg).sort((a, b) => b - a)
    return d.length ? d[0] + 0.3 * d.slice(1).reduce((s, x) => s + x, 0) : 0
  }
  // Прямой ход по ровному: каждая точка линии — клетка на высоте ног проходима, под ней опора.
  function lineClear (from, to, cache) {
    const n = Math.max(1, Math.ceil(from.distanceTo(to) / 0.25))
    for (let i = 1; i <= n; i++) {
      const p = from.plus(to.minus(from).scaled(i / n))
      const c = new Vec3(Math.floor(p.x), Math.floor(from.y + 1e-3), Math.floor(p.z))
      if (!standable(c, cache)) return false
    }
    return true
  }
  // haz — когда подрыв: равномерно в [lo, hi] тиков; клетка — по ожидаемому урону (не успел — пришло как стоя).
  function coverSpot (threats, dMe, cache, R = 3, haz = { lo: 0, hi: 6 }) {
    const me = bot.entity.position
    const here = hurtAt(threats, me, dMe, cache)
    const fc = feetCell(me)
    let best = null
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        for (const dy of [0, -1, 1]) {
          if (!dx && !dz) continue
          const h = Math.hypot(dx, dz)
          if (h > R + 0.2 || (dy !== 0 && h > 1.5)) continue
          const cell = new Vec3(fc.x + dx, fc.y + dy, fc.z + dz)
          if (!standable(cell, cache)) continue
          if (dy === 1 && !passable(blockAt(bot, cache, fc.x, fc.y + 2, fc.z))) continue
          if (dy === 0 && !lineClear(me, new Vec3(cell.x + 0.5, me.y, cell.z + 0.5), cache)) continue
          const pos = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5)
          const dmg = hurtAt(threats, pos, dMe, cache)
          const ticks = Math.ceil(Math.hypot(pos.x - me.x, pos.z - me.z) / 0.26) + (dy ? 3 : 1)
          const pr = Math.max(0, Math.min(1, (ticks - haz.lo) / Math.max(1, haz.hi - haz.lo)))
          const e = pr * here + (1 - pr) * dmg + ticks * 0.01
          if (!best || e < best.e) best = { pos, cell, dmg, ticks, e }
        }
      }
    }
    return best
  }
  // Чем ставить блок между: обсидиан, иначе булыжник, иначе светокамень сверх двух (заряд якоря).
  const wallItem = () => { const k = kitOf(bot); return k.obsidian > 0 ? 'obsidian' : countOf(bot, 'cobblestone') > 0 ? 'cobblestone' : k.glowstone > 2 ? 'glowstone' : null }
  const wallBlocks = () => { const k = kitOf(bot); return k.obsidian + countOf(bot, 'cobblestone') + Math.max(0, k.glowstone - 2) }
  // Блок обсидиана между мной и кристаллом (один или столбик из двух): лучи к телу упираются в него.
  // Ставится только честно (видимая грань опоры) и не в рамку сущности (кристалл 2×2×2 мешает стройке).
  function wallSpot (threats, dMe, cache) {
    if (wallBlocks() < 1) return null
    const me = bot.entity.position
    const eye = me.offset(0, EYE, 0)
    const fc = feetCell(me)
    const view = cache?.world || bot
    const boxes = (Object.values(view.entities) as any[]).filter((e : any) => e && e.position && e.isValid !== false &&
      (e.type === 'player' || e.name === 'end_crystal' || /mob|hostile|animal|passive/.test(e.type || ''))).map((e : any) => e.name === 'end_crystal' ? crystalBox(e.position) : boxOf(e))
    const key = (c) => `${c.x},${c.y},${c.z}`
    const faceOk = (cell) => {
      for (const n of [new Vec3(0, -1, 0), ...SIDES]) {
        const ref = cell.plus(n)
        if (!solidB(blockAt(bot, cache, ref.x, ref.y, ref.z))) continue
        if (pick.faceAim(view, ref, n.scaled(-1), { eye, range: PLACE_R - 0.05 })) return true
      }
      return false
    }
    const singles = []
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (!dx && !dz) continue
        const cell = new Vec3(fc.x + dx, fc.y, fc.z + dz)
        if (!isAirB(blockAt(bot, cache, cell.x, cell.y, cell.z))) continue
        if (!threats.some(th => (cell.x + 0.5 - me.x) * (th.c.position.x - me.x) + (cell.z + 0.5 - me.z) * (th.c.position.z - me.z) > 0)) continue
        const cb = { minX: cell.x, minY: cell.y, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 1, maxZ: cell.z + 1 }
        if (boxes.some(b => intersects(cb, b))) continue
        if (!faceOk(cell)) continue
        const sim = copyCache(cache)
        sim.set(key(cell), [[0, 0, 0, 1, 1, 1]])
        singles.push({ cells: [cell], dmg: hurtAt(threats, me, dMe, sim), ticks: 3, sim })
      }
    }
    singles.sort((a, b) => a.dmg - b.dmg)
    let best = singles[0] || null
    // Столбик: второй блок на первый (грань — его верх, глаза выше неё).
    for (const s of singles.slice(0, 4)) {
      const up = s.cells[0].offset(0, 1, 0)
      if (!isAirB(blockAt(bot, cache, up.x, up.y, up.z))) continue
      const ub = { minX: up.x, minY: up.y, minZ: up.z, maxX: up.x + 1, maxY: up.y + 1, maxZ: up.z + 1 }
      if (boxes.some(b => intersects(ub, b)) || up.offset(0.5, 1, 0.5).distanceTo(eye) > PLACE_R - 0.2 || eye.y <= up.y) continue
      if (wallBlocks() < 2) break
      const sim = copyCache(s.sim)
      sim.set(key(up), [[0, 0, 0, 1, 1, 1]])
      const dmg = hurtAt(threats, me, dMe, sim)
      if (!best || dmg + 0.15 < best.dmg) best = { cells: [s.cells[0], up], dmg, ticks: 6, sim }
    }
    return best
  }
  // Блок-заслон для своего якоря: клетка у моих ног (или у головы) в сторону якоря, честно ставится, не прячет
  // от глаз верх якоря (по нему клик заряда и подрыва). Возвращает лучший { cell, t } по размену.
  function guardFor (anchorCell, center, cache, living, { himAt, dHim, dMe, foe, himShield }: any) {
    const me = bot.entity.position
    const eye = me.offset(0, EYE, 0)
    const mc = feetCell(me)
    const top = anchorCell.offset(0.5, 1, 0.5)
    const toTop = top.minus(eye); const lenTop = toTop.norm(); const dirTop = toTop.scaled(1 / lenTop)
    let best = null
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const dy of [0, 1]) {
          if (!dx && !dz) continue
          const cell = new Vec3(mc.x + dx, mc.y + dy, mc.z + dz)
          if (cell.equals(anchorCell)) continue
          if ((cell.x + 0.5 - me.x) * (center.x - me.x) + (cell.z + 0.5 - me.z) * (center.z - me.z) <= 0) continue
          if (!isAirB(blockAt(bot, cache, cell.x, cell.y, cell.z))) continue
          const cb = { minX: cell.x, minY: cell.y, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 1, maxZ: cell.z + 1 }
          if (living.some(e => intersects(cb, boxOf(e)))) continue
          if (pick.rayBox(eye, dirTop, { x: cb.minX, y: cb.minY, z: cb.minZ }, { x: cb.maxX, y: cb.maxY, z: cb.maxZ }, lenTop) != null) continue
          let face = false
          for (const n of [new Vec3(0, -1, 0), ...SIDES]) {
            const ref = cell.plus(n)
            if (ref.equals(anchorCell) || !solidB(blockAt(bot, cache, ref.x, ref.y, ref.z))) continue
            if (pick.faceAim(bot, ref, n.scaled(-1), { eye, range: PLACE_R - 0.05 })) { face = true; break }
          }
          if (!face) continue
          const sim = new Map(cache)
          sim.set(cellKey(cell), [[0, 0, 0, 1, 1, 1]])
          const t = trade(bot, center, foe, bot.entity, dHim, dMe, without(sim, anchorCell), { himAt, power: ANCHOR_P, himShield })
          if (!best || t.him - 1.3 * t.me > best.t.him - 1.3 * best.t.me) best = { cell, t }
        }
      }
    }
    return best
  }
  function hasShield () { return !!bot.inventory.items().find(i => i.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield') }
  // Щит одной стороной: направление на худший кристалл; кого конус (≤ 85°, запас к 90) не берёт — урон идёт.
  function shieldPlan (threats, dMe, cache) {
    if (!hasShield()) return null
    const me = bot.entity.position
    const worst = threats.slice().sort((a, b) => b.t.me - a.t.me)[0]
    const yaw = Math.atan2(-(worst.c.position.x - me.x), -(worst.c.position.z - me.z))
    const dm = require('./pvp/damage-model')
    const open = threats.filter(th => dm.shieldAngle(yaw, me, th.c.position) > 85)
    const inHand = (bot.heldItem && bot.heldItem.name === 'shield') || (bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield')
    const use = guard && !guard.failure() ? guard.nativeUse() : null
    const usedTicks = use?.useConfirmed ? Math.max(0, use.confirmedTicks ?? 0) : 0
    // LivingEntity.getItemBlockingWith: пять тиков текущего use, не каждого плана.
    // Готовность — native ACK/age из общего щита; клиентские тики её не ускоряют.
    const ready = !!guard?.blocking()
    const turn = threats.some(th => dm.shieldAngle(bot.entity.yaw ?? 0, me, th.c.position) > 85 && !open.includes(th)) ? 1 : 0
    const ticks = ready ? turn : Math.max(0, dm.SHIELD_DELAY_TICKS - usedTicks) + (inHand ? 1 : 2)
    return { yaw, dmg: open.length ? hurtAt(open, me, dMe, cache) : 0, ticks }
  }
  // Прикрыт от его кристаллов (лучей к телу почти нет, при полной видимости было бы ≥ 4): его кристалл в прицеле
  // и мне от него ≤ 1.5 — сбить первым (угроза снята); иначе — держать укрытие (не выходить в ближний бой) до 3 с.
  function coverHold (threats, { dMe, myEff, cache, eye, now, far = true }: any) {
    const open = Math.max(...threats.map(th => th.t.meMax ?? th.t.me))
    const here = hurtAt(threats, bot.entity.position, dMe, cache)
    if (!(open >= 4 && here <= Math.max(1.5, open * 0.35))) { coverSince = null; return null }
    for (const th of threats) {
      if (th.cell) continue
      const aim = hitAim(bot, th.c.position, eye)
      if (aim && th.t.me <= 1.5 && Math.max(th.t.me, th.t.meMax ?? th.t.me) < myEff - 3) return { kind: 'defuse', c: th.c, t: th.t, aim, why: 'clear', note: `сбил его кристалл из-за укрытия (мне ${r1(th.t.me)})` }
    }
    if (coverSince == null) coverSince = now
    if (now - coverSince > 3000 || !far) return null
    st.coverHolds = (st.coverHolds || 0) + 1
    return { kind: 'hold', note: '' }
  }
  function evade (threats, { dMe, myEff, cache, foe, delayTicks = 0, finishTicks = null, finishGain = 0, count = true }: any) {
    const me = bot.entity.position
    const now0 = hurtAt(threats, me, dMe, cache)
    if (now0 < 2.5) return null
    // Когда подрыв: он достаёт кристалл рукой или лук в руке — в любой из ближайших 6 тиков; ни того, ни другого —
    // ему отойти и натянуть лук (crystal.place-shoot: отход до 1.3 с + натяжение 0.55–0.9 с) — между 20 и 45 тиками,
    // тогда и укрытие ищется дальше (6 бл.: бегом 0.26 б/т за 20 т — 5 бл.).
    const reachNow = !!foe && threats.some(th => boxDist(foe.position.offset(0, EYE, 0), th.cell ? { minX: th.cell.x, minY: th.cell.y, minZ: th.cell.z, maxX: th.cell.x + 1, maxY: th.cell.y + 1, maxZ: th.cell.z + 1 } : crystalBox(th.c.position)) <= (th.cell ? PLACE_R : HIT_R + 0.4))
    const hisBowNow = !!foe && foe.equipment && foe.equipment[0] && /^(bow|crossbow)$/.test(foe.equipment[0].name)
    const haz = reachNow || hisBowNow ? { lo: 0, hi: 6 } : { lo: 20, hi: 45 }
    const expected = (ticks, dmg) => { const p = Math.max(0, Math.min(1, (ticks - haz.lo) / (haz.hi - haz.lo))); return p * now0 + (1 - p) * dmg }
    const stay = finishTicks == null ? now0 : expected(finishTicks, Math.max(0, now0 - finishGain))
    const exp = o => expected(o.ticks + delayTicks, o.dmg) + (o.stall || 0)
    const opts = []
    const t0s = gameClock.now()
    // Щит подряд — не запрет, а цена (S7d, «гибкость вместо правил»): после 1.5 с подряд каждая секунда под щитом
    // стоит ~1.5 хп ожидаемого (пока стою — не бью, он заходит за спину или берёт топор: s7c1 р.3 — 75 щитов, ничья).
    // Укрытие или блок дешевле — уйдёт к ним; другого нет — щит остаётся.
    const sh = shieldPlan(threats, dMe, cache)
    const streakS = t0s - shieldLastEnd < 600 ? (t0s - shieldStreakAt) / 1000 : 0
    if (sh) opts.push({ kind: 'shield', yaw: sh.yaw, threats, dmg: sh.dmg, ticks: sh.ticks, stall: Math.max(0, streakS - 1.5) * 1.5 })
    const cv = coverSpot(threats, dMe, cache, haz.lo >= 20 ? 6 : 3, haz)
    if (cv && cv.dmg < now0) opts.push({ kind: 'cover', to: cv.pos, threats, dmg: cv.dmg, ticks: cv.ticks })
    const wl = wallSpot(threats, dMe, cache)
    if (wl && wl.dmg < now0) opts.push({ kind: 'wall', cells: wl.cells, threats, dmg: wl.dmg, ticks: wl.ticks })
    let best = null
    for (const o of opts) { o.exp = exp(o); if (!best || o.exp < best.exp) best = o }
    if (count) st.evadePlans = (st.evadePlans || 0) + 1
    if (!best || best.exp > stay - 1.5) return null
    const what = best.kind === 'shield' ? 'щит лицом к его кристаллу' : best.kind === 'cover' ? 'в укрытие от его кристалла' : `блок между мной и его кристаллом (${best.cells.length})`
    best.note = `${what}: ${r1(now0)} → ${r1(best.dmg)} (ожидаемо ${r1(best.exp)}, из ${r1(myEff)})`
    best.now = now0
    return best
  }

  // A local observation for the eat poll. Unknown collision cells are not free paths;
  // for blast rays they contribute no cover, so unknown exposure is an upper bound.
  // Fixed voxel samples must precede blockAt: a hidden block's shape cannot pick its own observation rays.
  function eatDefenseCache () {
    const cells = new Map()
    const view = Object.create(bot)
    view.entities = { [bot.entity.id]: bot.entity }
    for (const e of (Object.values(bot.entities) as any[])) {
      if (e?.position && e.isValid !== false && foeVisible(e)) view.entities[e.id] = e
    }
    view.blockAt = pos => {
      const cell = pos.floored(); const key = cellKey(cell)
      if (cells.has(key)) return cells.get(key)
      const eye = myEye()
      const points = [[.5, .5, .5]]
      for (const x of [.05, .95]) for (const y of [.05, .95]) for (const z of [.05, .95]) points.push([x, y, z])
      const seen = points.some(([x, y, z]) => {
        const d = cell.offset(x, y, z).minus(eye); const len = d.norm()
        const hit = len > 0 ? pick.blockOnRay(bot, eye, d.scaled(1 / len), len, /glass|_pane$|^barrier$|^iron_bars$/) : null
        return !hit || hit.pos.equals(cell)
      })
      const b = seen ? bot.blockAt(cell, false) : null
      cells.set(key, b); return b
    }
    return Object.assign(new Map(), { world: view })
  }

  function eatAnchorDefense (item, leftMs, noticed, reactMs) {
    const foe = enemy()
    if (!CX2 || !foe?.position || foe.isValid === false) return null
    const me = bot.entity.position; const dMe = boom.defenseOf(bot, bot.entity)
    const threats = []
    for (const a of anchorsAt.values()) {
      if (a.mine || a.pos.distanceTo(me) > 8 || !anchorSeen(a) || !(a.charges > 0)) continue
      const center = a.pos.offset(.5, .5, .5)
      const dmg = boom.blast(bot, center, ANCHOR_P, me, { def: dMe, seen: 1 }).dmg
      threats.push({ c: { position: center, id: 'a' + cellKey(a.pos), isValid: true }, t: { me: dmg }, power: ANCHOR_P, cell: a.pos, charges: a.charges })
    }
    if (!threats.length) { noticed.at = null; return null }
    const now = gameClock.now()
    if (noticed.at == null) noticed.at = now
    const delay = Math.max(0, (reactMs || 0) - (now - noticed.at))
    // Consumables + AbsorptionMobEffect (1.21.11, combat-calc-javap): absorption I / IV.
    // Count the absorption granted on completion; do not credit future regeneration ticks.
    const absorption = Math.max(0, effHp(bot, bot.entity) - (bot.health ?? 20))
    const gain = Math.max(0, (item === 'enchanted_golden_apple' ? 16 : item === 'golden_apple' ? 4 : 0) - absorption)
    const defense = evade(threats, { dMe, myEff: effHp(bot, bot.entity), cache: eatDefenseCache(), foe,
      delayTicks: Math.ceil(delay / TICK), finishTicks: Math.ceil(leftMs / TICK), finishGain: gain, count: false })
    return delay > 0 ? null : defense
  }

  // ------------------------------------------------------------ план
  // ctx: { vel } — его скорость (б/т) для упреждения на 3 тика.
  // Время плана (лучи видимости — десятки на клетку): в отчёт среднее и худшее.
  function plan (ctx: any = {}) {
    const t0 = process.hrtime.bigint()
    try { return planBody(ctx) } finally {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6
      st.planN = (st.planN || 0) + 1
      st.planMsSum = (st.planMsSum || 0) + ms
      if (ms > (st.planMsMax || 0)) st.planMsMax = Math.round(ms * 10) / 10
    }
  }
  function planBody (ctx: any = {}) {
    lastPress = !!ctx.press
    if (!ON || !bot.entity) return null
    const foe = enemy()
    if (!foe || !foe.position || foe.isValid === false) return null
    const now = gameClock.now()
    const me = bot.entity.position
    const eye = me.offset(0, EYE, 0)
    const k = kitOf(bot)
    const cache = new Map()
    const dMe = boom.defenseOf(bot, bot.entity)
    const dHim = boom.defenseOf(bot, foe)
    const myEff = effHp(bot, bot.entity)
    const hisEff = hisHp(foe)
    const himShield = CX2 && shieldUpOf(bot, foe)
    const v = ctx.vel || { x: 0, y: 0, z: 0 }
    const himAt = foe.position.offset(v.x * 3, 0, v.z * 3)
    const hisW = inWin(hisWin)
    const myW = inWin(myWin, IFRAME_MS - 60)
    const dist = me.distanceTo(foe.position)
    const hisEye = foe.position.offset(0, EYE, 0)
    const foeSeenNow = foeVisible(foe)
    const hisHand = foeSeenNow && foe.equipment && foe.equipment[0] ? foe.equipment[0].name : ''
    const hisBow = /^(bow|crossbow)$/.test(hisHand)
    if (hisBow) bowSeenAt = now
    const crystals = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'end_crystal' && e.position && e.isValid !== false &&
      (e.position.distanceTo(me) < 13 || e.position.distanceTo(foe.position) < 13) && crystalSeen(e))
    if (!crystals.length && !k.crystals && !anchorReady(bot, k) && !anchorsAt.size) return null
    const shows = heShows(foe)
    const press = !!ctx.press
    const eqF = foe.equipment || []
    const hisTotem = !!((eqF[0] && eqF[0].name === 'totem_of_undying') || (eqF[1] && eqF[1].name === 'totem_of_undying'))

    // 1. Его (и любой) кристалл у меня: сбить выгодно или в своё окно; иначе
    //    отойти, если он его достаёт.
    let danger = null
    const threats = []
    for (const c of (crystals as any)) {
      const t = trade(bot, c.position, foe, bot.entity, dHim, dMe, cache, { himShield })
      // Прикрыт (лучей почти нет), а в открытую было бы ≥ 4 — в угрозы для «держать укрытие», не в «опасность».
      const covered = CX2 && t.me < 2 && (t.meMax ?? 0) >= 4
      if (t.me < 2 && !covered) continue
      if (boxDist(hisEye, crystalBox(c.position)) <= HIT_R + 0.4 || hisBow || (CX2 && now - bowSeenAt < 60000 && c.position.distanceTo(hisEye) < 24 && losClear(bot, hisEye, c.position.offset(0, 1, 0)))) threats.push({ c, t })
      if (!covered && (!danger || t.me > danger.t.me)) danger = { c, t }
    }
    // Его якоря у меня (S7c): заряженный он подорвёт одним кликом, пустой — двумя (светокамень, клик). Достаёт,
    // если центр в 4.5 от его глаз. Свой клик по его заряженному якорю — подрыв, когда размен в мою пользу
    // (взрыв ни на кого не записан, но бьёт его сильнее); иначе — уклонение ценой, как от кристалла.
    if (CX2) {
      for (const a of anchorsAt.values()) {
        if (!anchorSeen(a)) continue
        if (a.mine || a.pos.distanceTo(me) > 8) continue
        const charges = a.charges || 0
        const center = a.pos.offset(0.5, 0.5, 0.5)
        const t = trade(bot, center, foe, bot.entity, dHim, dMe, without(cache, a.pos), { power: ANCHOR_P, himShield })
        if (t.me < 2 && !((t.meMax ?? 0) >= 4)) continue
        const th = { c: { position: center, id: 'a' + cellKey(a.pos), isValid: true }, t, power: ANCHOR_P, cell: a.pos, charges }
        if (center.distanceTo(hisEye) <= PLACE_R + 0.5) threats.push(th)
        const hisLand = landed(t, hisW, dHim)
        const worstMe = Math.max(t.me, t.meMax ?? t.me)
        if (charges > 0 && worstMe < myEff - 3 && hisLand >= t.me * 1.2 + 1 && now - lastAnchor > 600) {
          const ff = faceFor(bot, a.pos, eye, pickBlockers(bot, eye))
          if (ff) return { kind: 'anchorPop', cell: a.pos, t, note: `его якорь у нас — подорвал сам, ему больнее (${r1(hisLand)} против ${r1(t.me)})` }
        }
      }
      if (!danger && threats.length && now - lastDodge > 400) {
        const ev = evade(threats, { dMe, myEff, cache, foe })
        if (ev) return ev
        const ch = coverHold(threats, { dMe, myEff, cache, eye, now, far: dist > 3.6 })
        if (ch) return ch
      }
    }
    if (danger) {
      const { c, t } = danger
      const aim = hitAim(bot, c.position, eye)
      const free = myW && t.meRaw <= myW.raw - 0.5
      const hisLand = landed(t, hisW, dHim)
      // Своё окно: сырой удар мне не больше того, что только что пришёл, — мне 0.
      const worstMe = Math.max(t.me, t.meMax ?? t.me)
      if (aim && free && hisLand >= 1.5 && worstMe < myEff - 3) return { kind: 'defuse', c, t, aim, why: 'free', note: `его кристалл — в своё окно неуязвимости (ему ${r1(hisLand)}, мне 0)` }
      if (aim && worstMe < myEff - 3 && hisLand >= t.me * 1.2 + 1) return { kind: 'defuse', c, t, aim, why: 'trade', note: `сбил кристалл у нас — ему больнее (${r1(hisLand)} против ${r1(t.me)})` }
      const hisReach = boxDist(hisEye, crystalBox(c.position)) <= HIT_R + 0.4 || hisBow
      const lethal = t.me >= myEff - 1
      // S7c: защита ценой — щит лицом к кристаллу, укрытие (клетка, где лучей к телу нет), блок между —
      // против «стоять» по ожидаемому урону (evade). Сбить его кристалл сам — выше, когда размен в мою пользу.
      if (CX2 && threats.length && now - lastDodge > 400) {
        const ev = evade(threats, { dMe, myEff, cache, foe })
        if (ev) return ev
        const ch = coverHold(threats, { dMe, myEff, cache, eye, now, far: dist > 3.6 })
        if (ch) return ch
      }
      if (hisReach && (lethal || t.me >= Math.max(5, myEff * 0.45)) && now - lastDodge > 700) {
        return { kind: 'dodge', from: c.position, t, note: `ухожу от его кристалла (прогноз ${r1(t.me)} из ${r1(myEff)})` }
      }
    }

    // 2. Удар по нему: готовый кристалл у него — рукой или стрелой; новый —
    //    на обсидиан у его ног (рукой сразу, заранее в его окно, или «поставил
    //    — отошёл — стрела»).
    let best = null
    // Край, яма, лава рядом с ним (S7c): толчок взрыва (1−d)·вид. по «центр → глаза» сбросит его — к цене +5.
    const edgy = CX2 && (() => { try { return require('./edges').hazardAround(bot, foe.position, 5, new Map()) } catch { return false } })()
    // Толпа (ND_CRYSTAL_RECKLESS=1, арена 10.10: «взорвал — следующий сразу, пока не убьёшь кучу врагов»): за каждого
    // чужого игрока в 6 бл. от кристалла, кроме цели, — к цене (6 − d)·1.2; свои по команде (teamMap) не в счёт.
    const crowd = (pos) => {
      if (!pos || process.env.ND_CRYSTAL_RECKLESS !== '1') return 0
      const mine = bot.teamMap?.[bot.username]?.team
      let s = 0
      for (const e of Object.values(bot.entities || {}) as any[]) {
        if (!e || e.type !== 'player' || e === foe || e === bot.entity || !e.position) continue
        if (mine && bot.teamMap?.[e.username]?.team === mine) continue
        const d = e.position.distanceTo(pos)
        if (d < 6) s += (6 - d) * 1.2
      }
      return s
    }
    const consider = (o) => {
      const at0 = o.c?.position || (o.c && Number.isFinite(o.c.x) ? o.c : null)
      if (at0 && /^(hit|shoot|place|place-hit|place-shoot)$/.test(o.kind)) o.score += crowd(at0)
      if (edgy && o.c && (o.land ?? 0) >= 1.5 && o.kind !== 'obby') {
        let off = false
        try { off = boom.judge(bot, foe, o.c.position || o.c, P, { cache, foeAt: himAt }).off } catch {}
        if (off) { o.score += 5; o.knock = true; o.note = (o.note || '') + ' — толчком за край' }
      }
      if (!best || o.score > best.score) best = o
    }
    const bonus = (land) => (land >= hisEff - 0.5 ? 6 : 0)
    // Цена своего урона — от состояния (S7d): 1.3 при запасе, дороже по мере того, как мой запас хп тает (у края
    // смерти каждый свой хп дороже его хп): 12 эфф. хп и ниже — +1/6 за каждый недостающий (s7c4: себе 730 на 2387 ему).
    const wMe = CX2 ? 1.3 + Math.max(0, 12 - myEff) / 6 : 1.3
    for (const c of (crystals as any)) {
      if (c.position.distanceTo(foe.position) > 7) continue
      const t = trade(bot, c.position, foe, bot.entity, dHim, dMe, cache, { himAt, himShield })
      const land = landed(t, hisW, dHim)
      const aim = hitAim(bot, c.position, eye)
      if (aim && worthHit(t, { myEff, hisEff, hisLand: land, press, hisTotem })) consider({ kind: 'hit', c, t, aim, land, score: land - wMe * t.me + bonus(land) + 1 })
      // Стрелой — рукой не достать, а размен с места выгодный.
      if (k.bow && k.arrows && !aim && worthHit(t, { myEff, hisEff, hisLand: land, press, hisTotem }) && c.position.distanceTo(eye) < 24 && losClear(bot, eye, c.position.offset(0, 1, 0))) {
        consider({ kind: 'shoot', c, t, land, score: land - wMe * t.me + bonus(land) - 0.5 })
      }
    }
    // Готовый свой кристалл у него в руке досягаемости ждёт конца его окна —
    // не ставить новый рядом.
    const waiting = crystals.some((c : any) => mine.has(c.id) && c.position.distanceTo(foe.position) < 3.5 && hitAim(bot, c.position, eye))
    if (k.crystals > 0 && !waiting && dist < 8.5) {
      const avoid = pickBlockers(bot, eye)
      const ents = (Object.values(bot.entities) as any[])
      const fc = feetCell(foe.position)
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          for (let dy = -2; dy <= 0; dy++) {
            const base = new Vec3(fc.x + dx, fc.y + dy, fc.z + dz)
            const c = centerOf(base)
            if (c.distanceTo(eye) > PLACE_R + 0.6) continue
            if (!baseFree(bot, base, { cache, ents })) continue
            const t = trade(bot, c, foe, bot.entity, dHim, dMe, cache, { himAt, himShield })
            if (t.him < 2.5) continue
            const land = landed(t, hisW, dHim)
            const aim = hitAim(bot, c, eye, HIT_R - 0.25)
            const faceP = () => faceFor(bot, base, eye, avoid)
            if (aim && worthHit(t, { myEff, hisEff, hisLand: land, press, hisTotem })) {
              const f = faceP(); if (!f) continue
              consider({ kind: 'place-hit', base, c, f, t, land, score: land - wMe * t.me + bonus(land) })
            } else if (aim && hisW && worthHit(t, { myEff, hisEff, hisLand: t.him, press, hisTotem })) {
              const f = faceP(); if (!f) continue
              consider({ kind: 'place', base, c, f, t, land: t.him, score: t.him - wMe * t.me - 1.5 })
            } else if (k.bow && k.arrows && t.him >= 4 && myEff > 8 && now - lastPlaceShoot > 2500 && (!aim || (t.me > myEff * 0.45 && dist >= 3.5))) {
              // Рукой не достать или себе дорого: поставить, при нужде отойти, стрелой.
              // Вплотную (он в 3.5) — не кристалл, а меч: кристалл у него будет и
              // у меня, а удар мечом его отбросит на дистанцию кристалла.
              const f = faceP(); if (!f) continue
              consider({ kind: 'place-shoot', base, c, f, t, land, score: t.him * 0.6 - 2 })
            }
          }
        }
      }
    }
    // 2а. Основы у него нет (пол не обсидиан: светокамень, камень, его столб) —
    //     свой обсидиан у его ног, кристалл на него — следующим проходом. Клетка
    //     пола рядом с ним (выбитая взрывом, дыра) лучше всего: центр взрыва на
    //     уровне его ног, рамка открыта; на уровне ног — основа сама закрывает
    //     ему низ (~40% видимости). Модель ставит блок в кэш лучей и считает.
    if (k.crystals > 0 && k.obsidian > 0 && !waiting && dist < 7 && (!best || best.score < 3) && now - lastObby > 900) {
      const fc = feetCell(foe.position)
      const ents = (Object.values(bot.entities) as any[])
      const blocks = ents.filter((e : any) => e && e.position && e.isValid !== false && (e.type === 'player' || e.name === 'end_crystal' || /mob|hostile|animal|passive/.test(e.type || '')))
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          for (const dy of [-1, 0]) {
            if (!dx && !dz) continue
            const cell = new Vec3(fc.x + dx, fc.y + dy, fc.z + dz)
            if (!isAirB(blockAt(bot, cache, cell.x, cell.y, cell.z))) continue
            if (!isAirB(blockAt(bot, cache, cell.x, cell.y + 1, cell.z))) continue
            const cellBox = { minX: cell.x, minY: cell.y, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 1, maxZ: cell.z + 1 }
            if (blocks.some(e => intersects(cellBox, boxOf(e)))) continue
            const col = { minX: cell.x, minY: cell.y + 1, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 3, maxZ: cell.z + 1 }
            if (ents.some((e : any) => e && e.position && e.isValid !== false && intersects(col, boxOf(e)))) continue
            const c = centerOf(cell)
            if (c.distanceTo(eye) > PLACE_R - 0.2) continue
            // Блок встанет — лучам он преграда (его собственная рамка — нет).
            const sim = new Map(cache)
            sim.set(`${cell.x},${cell.y},${cell.z}`, [[0, 0, 0, 1, 1, 1]])
            const t = trade(bot, c, foe, bot.entity, dHim, dMe, sim, { himAt, himShield })
            if (t.him < 4) continue
            const aim = hitAim(bot, c, eye, HIT_R - 0.25)
            const byHand = !!aim && worthHit(t, { myEff, hisEff, hisLand: t.him, press, hisTotem })
            const byBow = k.bow && k.arrows && t.me < myEff * 0.45
            if (!byHand && !byBow) continue
            // Цена — как у следующего хода (удар или стрела) минус лишний блок.
            const next = byHand ? t.him - wMe * t.me + bonus(t.him) : t.him * 0.6 - 2
            // Грань, к которой прислонить обсидиан, — видна (build.placeBlockAt honest).
            let face = false
            for (const n of [new Vec3(0, -1, 0), ...SIDES]) {
              const ref = cell.plus(n)
              if (!solidB(blockAt(bot, cache, ref.x, ref.y, ref.z))) continue
              if (pick.faceAim(bot, ref, n.scaled(-1), { eye, range: PLACE_R - 0.05 })) { face = true; break }
            }
            if (!face) continue
            consider({ kind: 'obby', cell, t, land: t.him, score: next - 0.5, note: `обсидиан у его ног под кристалл (прогноз ему ${r1(t.him)})` })
          }
        }
      }
    }
    // 2в. Якорь возрождения (бонус, 2026-09-30; RespawnAnchorBlock 1.21.11): в
    //     верхнем мире «использовать» заряженный якорь не светокамнем — блок
    //     снимается и взрыв силы 5 с огнём в его центре, ни на кого не записан.
    //     Якорь у его ног (клетка воздуха рядом, грань видна), светокамень,
    //     и ещё раз — мечом. Рамка кристалла не нужна, но три клика — дольше.
    // Якорь — не только когда кристаллу нечего делать: при годном размене — то
    //     якорь, то кристалл (разнообразие для зрителя), лучший — всегда.
    let anchorBest = null
    if (anchorReady(bot, k) && dist < 6.5 && now - lastAnchor > 2500 && !hisW) {
      const fc = feetCell(foe.position)
      const mc = feetCell(me)
      const ents = (Object.values(bot.entities) as any[])
      const living = ents.filter((e : any) => e && e.position && e.isValid !== false && (e.type === 'player' || e.name === 'end_crystal' || /mob|hostile|animal|passive/.test(e.type || '')))
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const cell = new Vec3(fc.x + dx, fc.y, fc.z + dz)
          if (cell.equals(fc) || cell.equals(mc)) continue
          if (!isAirB(blockAt(bot, cache, cell.x, cell.y, cell.z))) continue
          if (!solidB(blockAt(bot, cache, cell.x, cell.y - 1, cell.z))) continue
          const cb = { minX: cell.x, minY: cell.y, minZ: cell.z, maxX: cell.x + 1, maxY: cell.y + 1, maxZ: cell.z + 1 }
          if (living.some(e => intersects(cb, boxOf(e)))) continue
          const c = cell.offset(0.5, 0.5, 0.5)
          if (c.distanceTo(eye) > PLACE_R - 0.4) continue
          // Блок снимается до взрыва — лучам он не преграда (кэш как есть).
          let t = trade(bot, c, foe, bot.entity, dHim, dMe, without(cache, cell), { himAt, power: ANCHOR_P, himShield })
          // Себе дорого — «щит из светокамня» (S7c): блок между мной и якорем (взрыв бьёт сущности раньше, чем
          // ломает блоки — ServerExplosion.explode: hurtEntities до interactWithBlocks), тогда размен — заново.
          let guard = null
          if (!worthHit(t, { myEff, hisEff, hisLand: t.him, press, hisTotem })) {
            if (!CX2 || k.glowstone < 2) continue
            const g = guardFor(cell, c, cache, living, { himAt, dHim, dMe, foe, himShield })
            if (!g || !worthHit(g.t, { myEff, hisEff, hisLand: g.t.him, press, hisTotem })) continue
            t = g.t; guard = g.cell
          }
          // Опора под якорем видна (ставить) — грань самого якоря потом та же сторона.
          if (!pick.faceAim(bot, cell.offset(0, -1, 0), new Vec3(0, 1, 0), { eye, range: PLACE_R - 0.05 })) continue
          const sc = t.him - wMe * t.me + bonus(t.him) - 1 - (guard ? 0.5 : 0)
          if (!anchorBest || sc > anchorBest.score) anchorBest = { kind: 'anchor', cell, guard, t, land: t.him, score: sc, note: `якорь у его ног${guard ? ' за светокамнем' : ''} (прогноз ему ${r1(t.him)}, мне ${r1(t.me)})` }
        }
      }
    }
    if (anchorBest && anchorBest.score > 0.5 && (!best || anchorBest.score >= best.score || (Math.random() < 0.35 && anchorBest.score >= best.score - 2))) best = anchorBest
    // Добить (или сбить его тотем) — прежде еды.
    if (best && best.score > 0.5 && best.land >= hisEff - 0.5 && best.kind !== 'obby') return best
    // 2б. Яблоко на месте: хп мало, его кристалл мне сейчас не смертелен, он не
    //     в руке (или я в окружении) — есть здесь, а не бегать по арене (прогон
    //     t1: «не ем под ударами — отрываюсь» уводил бой в перестрелку).
    const cell0 = feetCell(me)
    const walled = surrounded(bot, cell0, cache)
    const abs = myEff - (bot.health ?? 20)
    const gold = bot.inventory.items().find(i => i.name === 'golden_apple')
    const egap = bot.inventory.items().find(i => i.name === 'enchanted_golden_apple')
    const apple = ((bot.health ?? 20) <= 8 && egap) || (abs < 3 && gold) || (abs < 3 && egap) || null
    const safeNow = !(danger && danger.t.me >= myEff - 1)
    if (apple && now - lastEat > 2500 && myEff <= 13 && safeNow && (dist > 3.8 || walled) && !(hisBow && !walled)) {
      return { kind: 'eat', item: apple.name, note: `ем ${apple.name === 'enchanted_golden_apple' ? 'зачарованное яблоко' : 'золотое яблоко'} на месте (${r1(myEff)} хп${walled ? ', в окружении' : ''})` }
    }
    // 2г. «Починка» бутылками опыта (просьба 2026-09-30: броня к ~20-му взрыву
    //     у ног ломалась — дальше каждый кристалл 25+): износ вещи ≥ 35%, его
    //     кристалл мне не смертелен, он не в руке (или я в окружении) — бутылки
    //     себе под ноги, сферы опыта чинят вещи с «Починкой» (2 прочности за очко).
    const wear = armorWear(bot)
    const bottles = countOf(bot, 'experience_bottle')
    if (wear.mending && bottles > 0 && wear.worst >= 0.35 && now - lastMend > 4000 && safeNow && (dist > 4.5 || walled) && !(hisBow && !walled) && !(best && best.land >= hisEff - 0.5)) {
      return { kind: 'mend', n: Math.min(bottles, 12, Math.max(4, Math.ceil(wear.missing / 14))), wear, note: `чиню броню опытом (износ до ${Math.round(wear.worst * 100)}%${walled ? ', в окружении' : ''})` }
    }
    if (best && best.score > 0.5) return best

    // 3. Защита заранее: он с кристаллами рядом, а мне отсюда светит много —
    //    обсидиан вокруг ног (surround).
    if (shows && k.obsidian >= 4 && dist < 6.5 && now - lastSurround > 2500) {
      const cell = feetCell(me)
      if (!surrounded(bot, cell, cache) && bot.entity.onGround) {
        const w = worstVsMe(foe, cache, dMe)
        if (w >= Math.max(6, myEff * 0.4)) return { kind: 'surround', w, note: `обсидиан вокруг ног (его кристалл мне сейчас до ${r1(w)})` }
      }
    }
    // 4. В окружении и он рядом, но не в руке — держать место (не выпрыгивать
    //    за ударом меча под его кристаллы); в нажиме — нет.
    if (walled && !press && dist > 3.4 && dist < 7.5 && shows && (k.crystals > 0 || crystals.length)) return { kind: 'hold' }
    return null
  }

  // ------------------------------------------------------------ действия

  async function toHotbar (name) {
    for (let i = 0; i < 9; i++) { const s = bot.inventory.slots[36 + i]; if (s && s.name === name) return i }
    const it = bot.inventory.items().find(i => i.name === name)
    if (!it || bot.currentWindow) return -1
    let dest = -1
    for (let i = 0; i < 9; i++) if (i !== bot.quickBarSlot && !bot.inventory.slots[36 + i]) { dest = i; break }
    const KEEP = /_sword$|_axe$|^bow$|^totem_of_undying$|golden_apple$|^end_crystal$|^obsidian$/
    if (dest < 0) for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && !KEEP.test(s.name)) { dest = i; break } }
    if (dest < 0) for (let i = 8; i >= 0; i--) { const s = bot.inventory.slots[36 + i]; if (i !== bot.quickBarSlot && s && s.name !== 'totem_of_undying' && !/_sword$/.test(s.name)) { dest = i; break } }
    if (dest < 0) return -1
    try { await bot.moveSlotItem(it.slot, 36 + dest) } catch { return -1 }
    const s = bot.inventory.slots[36 + dest]
    return s && s.name === name ? dest : -1
  }

  function waitSpawn (at, ms = 450) {
    return new Promise<any>(resolve => {
      const on = (e) => { if (e && e.name === 'end_crystal' && e.position && e.position.distanceTo(at) < 0.3) done(e) }
      const t = gameClock.setTimeout(() => done(null), ms)
      function done (e) { gameClock.clearTimeout(t); bot.removeListener('entitySpawn', on); resolve(e) }
      bot.on('entitySpawn', on)
    })
  }

  // Кристалл на base: взгляд в видимую точку грани, пакет, ждать сущность.
  async function place (base, f) {
    const idx = await toHotbar('end_crystal')
    if (idx < 0) { fail('кристалла нет в хотбаре'); return null }
    if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
    const eye = bot.entity.position.offset(0, EYE, 0)
    // Прицел мог уйти за тик (он сдвинулся, мы сдвинулись) — перепроверить.
    const ff = faceFor(bot, base, eye, pickBlockers(bot, eye)) || null
    if (!ff) { fail('грань не видно'); return null }
    if (!baseFree(bot, base)) { fail('столб занят'); return null }
    // Второй, независимый луч (world.raycast) не согласен — не ставить: сквозь
    // стену пользователь считает читом. Счёт отказов — wallPlace (0 = лучи
    // согласны всегда); поставленного сквозь стену нет по построению.
    if (!losClear(bot, eye, ff.pt, { expectBlock: base })) { st.wallPlace++; fail('второй луч: грань за блоком'); return null }
    const block = bot.blockAt(base, false)
    if (!block) return null
    const w = waitSpawn(centerOf(base))
    try {
      await bot._genericPlace(block, ff.face, { forceLook: true, delta: ff.pt.minus(base), swingArm: 'right' })
    } catch (e) { fail('клик: ' + e.message); return null }
    const c: any = await w
    if (!c) { fail('кристалл не появился'); return null }
    mine.set(c.id, { at: gameClock.now(), base })
    st.placed++
    return c
  }

  async function hit (c) {
    const eye = pick.eyeOf(bot)
    const pt = hitAim(bot, c.position, eye)
    if (!pt) { fail('кристалл не в прицеле'); return false }
    if (!losClear(bot, eye, pt)) { st.wallHit++; fail('второй луч: кристалл за блоком'); return false }
    await bot.lookAt(pt, true).catch(() => {})
    const before = bot._ndBlockedHits || 0
    const fw = CX2 && noteAttack ? freshWorth(c.position) : null
    try { bot.attack(c) } catch { return false }
    if ((bot._ndBlockedHits || 0) > before) { fail('сторож прицела'); return false }
    noteBlast(fw)
    const rec = mine.get(c.id) || { at: gameClock.now() }
    rec.hitAt = gameClock.now()
    mine.set(c.id, rec)
    st.hits++
    return true
  }
  // Оценке его хп — урон моего подрыва интервалом (прогноз лучей ±): damage_event с причиной «я» его вычтет.
  function noteBlast (fw, projectile = false) {
    if (!fw || !fw.t || !noteAttack || !(fw.land > 0.3)) return
    try { noteAttack({ min: fw.land * 0.75, max: fw.land * 1.2 + 0.5, mean: fw.land, raw: fw.t.himRaw }, { projectile }) } catch {}
  }



  async function backOff (ctl, from, { ms = 900, until = null, stepSafe = null }: any = {}) {
    const t0 = gameClock.now()
    const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
    try {
      while (gameClock.now() - t0 < ms && !ctl.aborted) {
        if (until && until()) break
        const me = bot.entity.position
        const yaw = Math.atan2(-(me.x - from.x), -(me.z - from.z))
        await bot.look(yaw, 0, true).catch(() => {})
        const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
        let ok = !stepSafe || stepSafe(fwd)
        let side = null
        if (!ok && stepSafe) {
          for (const [k2, sgn] of ([['left', 1], ['right', -1]] as any)) {
            const d = { x: -Math.sin(yaw + sgn * Math.PI / 2), z: -Math.cos(yaw + sgn * Math.PI / 2) }
            if (stepSafe(d)) { side = k2; break }
          }
        }
        set('forward', ok); set('sprint', ok && (bot.food ?? 20) > 6); set('left', side === 'left'); set('right', side === 'right')
        // Блок на пути (окружение) — прыжок.
        const ahead = me.offset(fwd.x * 0.8, 0.2, fwd.z * 0.8).floored()
        const b = bot.blockAt(ahead, false)
        set('jump', ok && solidB(b))
        await sleep(TICK)
      }
    } finally { for (const k of ['forward', 'sprint', 'back', 'left', 'right', 'jump']) set(k, false) }
  }

  // К точке to бегом по прямой (укрытие в 1–3 клетках): ступень — прыжком; у края — stepSafe.
  async function moveTo (ctl, to, { ms = 900, until = null, stepSafe = null }: any = {}) {
    const t0 = gameClock.now()
    const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
    try {
      while (gameClock.now() - t0 < ms && !ctl.aborted) {
        if (until && until()) break
        const me = bot.entity.position
        const dx = to.x - me.x; const dz = to.z - me.z
        const h = Math.hypot(dx, dz)
        if (h < 0.22 && Math.abs(me.y - to.y) < 0.6) break
        const yaw = Math.atan2(-dx, -dz)
        await bot.look(yaw, 0, true).catch(() => {})
        const fwd = { x: dx / h, z: dz / h }
        const ok = !stepSafe || stepSafe(fwd) || to.y < me.y - 0.5
        set('forward', ok); set('sprint', ok && h > 0.8 && (bot.food ?? 20) > 6)
        set('jump', ok && to.y > me.y + 0.5 && h < 1.6)
        if (!ok) break
        await sleep(TICK)
      }
    } finally { for (const k of ['forward', 'sprint', 'jump']) set(k, false) }
  }

  // Стрела летит, пока тянем лук, моё здоровье меняется (его кристалл, его
  // удар): перед спуском снова «не хлопнуть свой тотем своим кристаллом» —
  // иначе натяжение бросить (прогон b3: поставил при 18 хп, отходя получил его
  // кристалл до 4 — и своя стрела хлопнула свой тотем).
  // Размен заново на момент удара: хп, поглощение, броня (ломается), его и моё
  // место, его окно — план устарел за await (постановка, взгляд, смена слота).
  let lastPress = false
  // airCell — клетка, которая до взрыва исчезнет (якорь: removeBlock раньше
  // explode) — лучам не преграда.
  function freshWorth (center, { power = P, airCell = null }: any = {}) {
    const foe = enemy()
    if (!foe || !foe.position || foe.isValid === false || !bot.entity) return { ok: false }
    const dMe = boom.defenseOf(bot, bot.entity)
    const dHim = boom.defenseOf(bot, foe)
    const cache = new Map()
    if (airCell) cache.set(`${airCell.x},${airCell.y},${airCell.z}`, null)
    const t = trade(bot, center, foe, bot.entity, dHim, dMe, cache, { power, himShield: CX2 && shieldUpOf(bot, foe) })
    const eqF = foe.equipment || []
    const hisTotem = !!((eqF[0] && eqF[0].name === 'totem_of_undying') || (eqF[1] && eqF[1].name === 'totem_of_undying'))
    const land = landed(t, inWin(hisWin), dHim)
    const ok = worthHit(t, { myEff: effHp(bot, bot.entity), hisEff: hisHp(foe), hisLand: land, press: lastPress, hisTotem })
    return { ok, t, land }
  }

  // Другой кристалл на прямой к цели раньше неё — стрела возьмёт его (ревью
  // Codex: «стрела в безопасный дальний кристалл попадёт в опасный ближний»).
  function crystalInLine (c) {
    const eye = bot.entity.position.offset(0, EYE, 0)
    const to = c.position.offset(0, 1, 0)
    const d = to.minus(eye)
    const len = d.norm()
    if (len < 1e-3) return null
    const dir = d.scaled(1 / len)
    const cb = crystalBox(c.position)
    const tT = pick.rayBox(eye, dir, { x: cb.minX, y: cb.minY, z: cb.minZ }, { x: cb.maxX, y: cb.maxY, z: cb.maxZ }, len) ?? len
    let best = null; let bestT = Infinity
    for (const e of ((Object.values(bot.entities) as any[]) as any)) {
      if (!e || e.name !== 'end_crystal' || e.id === c.id || !e.position || e.isValid === false) continue
      const b = crystalBox(e.position)
      const t = pick.rayBox(eye, dir, { x: b.minX, y: b.minY, z: b.minZ }, { x: b.maxX, y: b.maxY, z: b.maxZ }, len)
      if (t != null && t < tT - 0.05 && t < bestT) { best = e; bestT = t }
    }
    return best
  }

  async function shoot (ctl, c, ctx) {
    const selfRisk = () => { try { return boom.blast(bot, c.position, P, bot.entity.position, { def: boom.defenseOf(bot, bot.entity), seen: 1 }).dmg >= effHp(bot, bot.entity) - 4.5 } catch { return true } }
    const lineRisk = () => { try { const o = crystalInLine(c); return !!(o && !freshWorth(o.position).ok) } catch { return true } }
    if (selfRisk()) { fail('выстрел: себе смертельно'); return false }
    const other = crystalInLine(c)
    if (other) {
      // Ближний кристалл на линии — выстрел достанется ему; стрелять, только если
      // и его взрыв мне не опасен (по полной видимости) и ему выгоден.
      const fw = freshWorth(other.position)
      if (!fw.ok) { fail('выстрел: на линии другой кристалл'); return false }
      c = other
    }
    const r = await boom.shootAt(bot, ctl, c, { anyBow: true, drawMs: c.position.distanceTo(bot.entity.position) > 10 ? 900 : 550, shouldStop: () => (ctx.stop && ctx.stop()) || selfRisk() || lineRisk() }).catch(e => ({ shot: false, why: e.message }))
    if (r && r.shot) {
      if (CX2 && noteAttack) noteBlast(freshWorth(c.position), true)
      const rec = mine.get(c.id) || { at: gameClock.now() }
      rec.hitAt = gameClock.now() + 400 // стрела летит
      mine.set(c.id, rec)
      st.shots++
      return true
    }
    fail('выстрел: ' + ((r && r.why) || '?'))
    return false
  }

  async function doSurround (ctl, foe) {
    const fortify = require('./fortify')
    const { placeBlockAt } = require('./build')
    await fortify.centerInCell(bot, 450)
    const cell = fortify.feetCell(bot)
    const toward = foe && foe.position ? foe.position : null
    const order = SIDES.slice().sort((a, b) => toward ? (b.x * (toward.x - cell.x - 0.5) + b.z * (toward.z - cell.z - 0.5)) - (a.x * (toward.x - cell.x - 0.5) + a.z * (toward.z - cell.z - 0.5)) : 0)
    let placed = 0
    for (const s of order) {
      if (ctl.aborted) break
      const p = cell.plus(s)
      const b = bot.blockAt(p, false)
      if (solidB(b)) continue
      try {
        const r = await placeBlockAt(bot, p, { item: 'obsidian', honest: true, timeoutMs: 450 })
        if (r && r.ok && !r.already) placed++
      } catch {}
    }
    return placed
  }

  // ctx: { stepSafe, stop }. ND_DEBUG_CRYSTAL — каждое действие в лог (заметки
  // боя pvp.js прореживает: одна на вид за 1.5 с).
  async function run (ctl, a, ctx: any = {}) {
    if (a.knock) st.knockTries = (st.knockTries || 0) + 1
    const out = await runBody(ctl, a, ctx)
    if (DEBUG && a.kind !== 'hold') { try { const me = bot.entity.position; console.log(`[crystal] ${a.kind} ${out.ok ? 'ok' : 'нет'} | ${out.note || ''} | хп ${r1(effHp(bot, bot.entity))} я ${r1(me.x)},${r1(me.y)},${r1(me.z)}${a.t ? ` | прогноз ему ${r1(a.t.him)}, мне ${r1(a.t.me)} (макс ${r1(a.t.meMax ?? a.t.me)})` : ''}`) } catch {} }
    return out
  }
  async function runBody (ctl, a, ctx: any = {}) {
    const out: any = { ok: false, note: a.note || '' }
    const foe = enemy()
    if (a.kind === 'defuse') {
      // Заново на этот миг: мои хп и броня, окно ещё идёт (для «free»), размен (для «trade»).
      {
        const f = enemy()
        const dMe = boom.defenseOf(bot, bot.entity)
        const worstNow = boom.blast(bot, a.c.position, P, bot.entity.position, { def: dMe, seen: 1 }).dmg
        const eff = effHp(bot, bot.entity)
        let okNow = worstNow < eff - 3 && !!f && a.c.isValid !== false && !!bot.entities[a.c.id]
        if (okNow && a.why === 'free') { const w = inWin(myWin, IFRAME_MS - 60); const t = boom.blast(bot, a.c.position, P, bot.entity.position, { def: dMe }); okNow = !!(w && t.raw <= w.raw - 0.5) }
        if (okNow && a.why === 'clear') okNow = boom.blast(bot, a.c.position, P, bot.entity.position, { def: dMe }).dmg <= 1.5
        else if (okNow && a.why !== 'free') { const fw = freshWorth(a.c.position); okNow = !!(fw.t && fw.land >= fw.t.me * 1.2 + 1) }
        if (!okNow) { out.note = ''; out.wait = 60; return out }
      }
      const ok = await hit(a.c)
      out.ok = ok
      if (ok) { if (a.why === 'free') st.free++; else if (a.why === 'clear') st.clears = (st.clears || 0) + 1; else st.defuse++ }
      out.note = ok ? a.note : 'кристалл: сбить не вышло'
      out.wait = 120
      return out
    }
    if (a.kind === 'dodge') {
      lastDodge = gameClock.now()
      const dMe = boom.defenseOf(bot, bot.entity)
      await backOff(ctl, a.from, { ms: 500, stepSafe: ctx.stepSafe, until: () => boom.blast(bot, a.from, P, bot.entity.position, { def: dMe }).dmg < Math.max(3, a.t.me * 0.5) })
      st.dodges++
      out.ok = true
      out.wait = 150
      return out
    }
    // Его кристаллы, что ещё стоят и достают меня.
    const alive = (a) => a.threats.filter(th => th.cell ? (() => { const known = anchorsAt.get(cellKey(th.cell)); return !!known && anchorSeen(known) })() : (th.c.isValid !== false && bot.entities[th.c.id]))
    if (a.kind === 'shield') {
      lastDodge = gameClock.now()
      const off = bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield'
      if (!off) {
        const idx = await toHotbar('shield')
        if (idx < 0) { fail('щит: не в хотбаре'); out.wait = 100; return out }
        if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
      }
      const t0 = gameClock.now()
      if (t0 - shieldLastEnd > 600) shieldStreakAt = t0
      st.shieldUps = (st.shieldUps || 0) + 1
      const managed = off && guard
      try {
        await bot.look(a.yaw, 0, true).catch(() => {})
        if (managed) await guard.raise(true)
        else bot.activateItem(off)
        shieldUntil = Infinity
        // Держать, пока его кристаллы стоят (до 1.5 с): лицом к худшему из живых.
        while (gameClock.now() - t0 < 1500 && !ctl.aborted) {
          const live = alive(a)
          if (!live.length) break
          const me = bot.entity.position
          const w = live.sort((x, y) => y.t.me - x.t.me)[0]
          await bot.look(Math.atan2(-(w.c.position.x - me.x), -(w.c.position.z - me.z)), 0, true).catch(() => {})
          await sleep(TICK)
        }
      } finally {
        try { if (managed) await guard.raise(false); else bot.deactivateItem() } catch {}
        shieldUntil = gameClock.now()
        shieldLastEnd = gameClock.now()
        st.shieldMs = (st.shieldMs || 0) + (gameClock.now() - t0)
      }
      out.ok = true
      out.wait = 60
      return out
    }
    if (a.kind === 'cover') {
      lastDodge = gameClock.now()
      st.covers = (st.covers || 0) + 1
      const dMe = boom.defenseOf(bot, bot.entity)
      await moveTo(ctl, a.to, { ms: Math.min(1500, a.ticks * TICK * 2 + 200), stepSafe: ctx.stepSafe, until: () => !alive(a).length })
      out.ok = true
      out.note = `${a.note}; на месте ${r1(hurtAt(alive(a), bot.entity.position, dMe, new Map()))}`
      out.wait = 80
      return out
    }
    if (a.kind === 'wall') {
      lastDodge = gameClock.now()
      const { placeBlockAt } = require('./build')
      let n = 0
      for (const cell of a.cells) {
        if (ctl.aborted || !alive(a).length) break
        let r = null
        try { r = await placeBlockAt(bot, cell, { item: wallItem() || 'obsidian', honest: true, timeoutMs: 400 }) } catch (e) { r = { ok: false, reason: e.message } }
        if (r && r.ok && !r.already) n++
        else { fail('блок между: ' + ((r && r.reason) || '?')); break }
      }
      if (n) { st.walls = (st.walls || 0) + 1; st.wallBlocks = (st.wallBlocks || 0) + n }
      out.ok = n > 0
      out.wait = 60
      return out
    }
    if (a.kind === 'hit') {
      if (!freshWorth(a.c.position).ok) { out.note = ''; out.wait = 60; return out }
      const ok = await hit(a.c)
      out.ok = ok
      out.note = ok ? `кристалл у него — удар (прогноз ему ${r1(a.land)}, мне ${r1(a.t.me)})` : 'кристалл у него: удар не прошёл'
      out.wait = ok ? 380 : 100
      return out
    }
    if (a.kind === 'shoot') {
      const ok = await shoot(ctl, a.c, ctx)
      out.ok = ok
      out.note = ok ? `стрела в кристалл у него (прогноз ему ${r1(a.land)}, мне ${r1(a.t.me)})` : 'стрела в кристалл: не вышло'
      out.wait = 300
      return out
    }
    if (a.kind === 'place-hit' || a.kind === 'place') {
      const c: any = await place(a.base, a.f)
      if (!c) { out.note = 'кристалл: не поставил'; out.wait = 250; return out }
      if (a.kind === 'place') {
        st.pre++
        pendingAt = gameClock.now()
        out.ok = true
        out.keepItem = true
        out.note = `кристалл заранее — жду конца его неуязвимости (прогноз ${r1(a.t.him)})`
        out.wait = 60
        return out
      }
      // Удар через ~0.1 с, как у человека (и кристалл виден зрителю), и только
      // если размен всё ещё годен на этот миг; нет — кристалл остаётся «заранее».
      await sleep(100)
      if (ctl.aborted) return out
      if (c.isValid === false || !bot.entities[c.id]) { out.note = 'кристалл у него взорвали раньше удара'; out.wait = 80; return out }
      const fw = freshWorth(c.position)
      if (!fw.ok) { st.pre++; out.ok = true; out.keepItem = true; out.note = 'кристалл поставил — размен ушёл, жду'; out.wait = 60; return out }
      const ok = await hit(c)
      out.ok = ok
      out.note = ok ? `кристалл у его ног и удар (прогноз ему ${r1(a.land)}, мне ${r1(a.t.me)})` : 'кристалл поставил, удар не прошёл'
      out.keepItem = true
      out.wait = ok ? 380 : 80
      return out
    }
    if (a.kind === 'place-shoot') {
      lastPlaceShoot = gameClock.now()
      const c: any = await place(a.base, a.f)
      if (!c) { out.note = 'кристалл: не поставил'; out.wait = 250; return out }
      const dMe = boom.defenseOf(bot, bot.entity)
      const dHim = boom.defenseOf(bot, foe)
      await backOff(ctl, c.position, {
        ms: 1300,
        stepSafe: ctx.stepSafe,
        until: () => boom.blast(bot, c.position, P, bot.entity.position, { def: dMe }).dmg < Math.max(1.5, effHp(bot, bot.entity) * 0.12)
      })
      if (c.isValid === false || !bot.entities[c.id]) { out.note = 'кристалл у него взорвали раньше стрелы'; out.ok = true; out.wait = 100; return out }
      const f2 = enemy()
      const him = f2 && f2.position ? boom.blast(bot, c.position, P, f2.position, { def: dHim }).dmg : 0
      if (him < 2) { out.note = 'поставил кристалл, отошёл — он ушёл от него, стрелу не трачу'; out.wait = 200; return out }
      // Стрелять — только в видимое: за блоком его не взять в прицел.
      if (!losClear(bot, bot.entity.position.offset(0, EYE, 0), c.position.offset(0, 1, 0))) { out.note = 'поставил кристалл, отошёл — его не видно за блоками'; out.wait = 200; return out }
      const ok = await shoot(ctl, c, ctx)
      out.ok = ok
      out.note = ok ? `кристалл у него, отошёл и стрелой (прогноз ему ${r1(him)})` : 'кристалл поставил, стрелой не вышло'
      out.wait = 300
      return out
    }
    if (a.kind === 'anchor') {
      lastAnchor = gameClock.now()
      const { placeBlockAt } = require('./build')
      let r = null
      myAnchorCells.add(cellKey(a.cell))
      try { r = await placeBlockAt(bot, a.cell, { item: 'respawn_anchor', honest: true, timeoutMs: 500 }) } catch (e) { r = { ok: false, reason: e.message } }
      const ab = () => bot.blockAt(a.cell, false)
      if (!r || !r.ok || !ab() || ab().name !== 'respawn_anchor') { fail('якорь: ' + ((r && r.reason) || 'не встал')); out.note = 'якорь у его ног: не встал'; out.wait = 250; return out }
      st.anchors = (st.anchors || 0) + 1
      // «Щит из светокамня» между мной и якорем — до заряда (S7c).
      if (a.guard && isAirB(bot.blockAt(a.guard, false))) {
        let g = null
        try { g = await placeBlockAt(bot, a.guard, { item: 'glowstone', honest: true, timeoutMs: 400 }) } catch (e) { g = { ok: false, reason: e.message } }
        if (g && g.ok && !g.already) st.anchorGuards = (st.anchorGuards || 0) + 1
        else fail('якорь: заслон ' + ((g && g.reason) || '?'))
      }
      // check — последняя проверка перед самим кликом (после переноса предмета).
      const click = async (item, check = null) => {
        const idx = await toHotbar(item)
        if (idx < 0) return false
        if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
        const eye = bot.entity.position.offset(0, EYE, 0)
        const ff = faceFor(bot, a.cell, eye, pickBlockers(bot, eye))
        if (!ff || !losClear(bot, eye, ff.pt, { expectBlock: a.cell })) return false
        if (check && !check()) return false
        try { await bot._genericPlace(ab(), ff.face, { forceLook: true, delta: ff.pt.minus(a.cell), swingArm: 'right' }) } catch { return false }
        return true
      }
      // Заряд: светокамнем; ждать, пока блок покажет заряд (свойство charges).
      if (!(await click('glowstone'))) { fail('якорь: заряд'); out.note = 'якорь поставил, зарядить не вышло'; out.wait = 200; return out }
      const t0 = gameClock.now()
      const charged = () => { const b = ab(); if (!b || b.name !== 'respawn_anchor') return false; try { const p = b.getProperties && b.getProperties(); return !!(p && Number(p.charges) > 0) } catch { return false } }
      while (gameClock.now() - t0 < 300 && !charged()) await sleep(TICK)
      if (!charged()) { fail('якорь: заряд не подтвердился'); out.note = 'якорь: заряд не подтвердился'; out.wait = 150; return out }
      // Взрыв: «использовать» мечом (не светокамнем, в левой руке тотем) — если
      // размен на миг клика всё ещё годен (за перенос меча и взгляд хп и место уходят).
      let held = false
      const sword = bot.inventory.items().find(i => /_sword$/.test(i.name))
      const ok = sword ? await click(sword.name, () => { if (ctl.aborted || !charged()) return false; const fw = freshWorth(a.cell.offset(0.5, 0.5, 0.5), { power: ANCHOR_P, airCell: a.cell }); if (fw.ok) { anchorClick = { key: cellKey(a.cell), at: gameClock.now() }; if (CX2) noteBlast(fw); return true } held = true; return false }) : false
      if (held) { st.anchorHeld = (st.anchorHeld || 0) + 1; out.note = 'якорь заряжен — размен ушёл, не взрываю'; out.wait = 150; return out }
      if (ok) { st.anchorBooms = (st.anchorBooms || 0) + 1; out.ok = true; out.note = a.note } else { fail('якорь: подрыв'); out.note = 'якорь зарядил, подорвать не вышло' }
      out.wait = 350
      return out
    }
    if (a.kind === 'anchorPop') {
      // Его заряженный якорь у нас — подрыв моим кликом не светокамнем (RespawnAnchorBlock.useWithoutItem: заряд > 0,
      // не Ад → explode), если размен на миг клика всё ещё в мою пользу.
      lastAnchor = gameClock.now()
      const item = (bot.inventory.items().find(i => /_sword$/.test(i.name)) || bot.inventory.items().find(i => !/glowstone/.test(i.name)))
      const idx = item ? await toHotbar(item.name) : -1
      if (idx < 0) { fail('его якорь: нечем кликнуть'); out.wait = 100; return out }
      if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
      const b = bot.blockAt(a.cell, false)
      const eye = bot.entity.position.offset(0, EYE, 0)
      const ff = b && b.name === 'respawn_anchor' ? faceFor(bot, a.cell, eye, pickBlockers(bot, eye)) : null
      if (!ff || !losClear(bot, eye, ff.pt, { expectBlock: a.cell })) { fail('его якорь: грань не видно'); out.wait = 80; return out }
      const fw = freshWorth(a.cell.offset(0.5, 0.5, 0.5), { power: ANCHOR_P, airCell: a.cell })
      if (!(fw.t && fw.land >= fw.t.me * 1.2 + 1)) { out.note = ''; out.wait = 60; return out }
      anchorClick = { key: cellKey(a.cell), at: gameClock.now() }
      try { await bot._genericPlace(b, ff.face, { forceLook: true, delta: ff.pt.minus(a.cell), swingArm: 'right' }) } catch { fail('его якорь: клик'); out.wait = 80; return out }
      noteBlast(fw)
      st.anchorPops = (st.anchorPops || 0) + 1
      out.ok = true
      out.wait = 200
      return out
    }
    if (a.kind === 'obby') {
      lastObby = gameClock.now()
      const { placeBlockAt } = require('./build')
      let r = null
      try { r = await placeBlockAt(bot, a.cell, { item: 'obsidian', honest: true, timeoutMs: 500 }) } catch (e) { r = { ok: false, reason: e.message } }
      if (r && r.ok && !r.already) { st.obby++; out.ok = true; out.keepItem = false; out.wait = 60; return out }
      fail('обсидиан: ' + ((r && r.reason) || '?'))
      out.note = 'обсидиан у его ног: не встал'
      out.wait = 200
      return out
    }
    if (a.kind === 'hold') {
      st.holdTicks = (st.holdTicks || 0) + 1
      const f = enemy()
      if (f && f.position) await bot.lookAt(f.position.offset(0, EYE, 0), true).catch(() => {})
      out.ok = true
      out.note = ''
      out.wait = 100
      out.hold = true
      return out
    }
    if (a.kind === 'mend') {
      lastMend = gameClock.now()
      const idx = await toHotbar('experience_bottle')
      if (idx < 0) { out.note = 'бутылки опыта: не в хотбаре'; out.wait = 300; return out }
      if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
      const w0 = armorWear(bot)
      const dist0 = (() => { const f = enemy(); return f && f.position ? f.position.distanceTo(bot.entity.position) : 99 })()
      // Опасность — его кристалл, смертельный мне по полной видимости, который он
      // достаёт рукой или ЛУКОМ; или он подошёл ближе, чем был, и уже в 4 бл.
      const danger = () => {
        const f = enemy()
        const me = bot.entity.position
        if (!f || !f.position) return false
        const dMe = boom.defenseOf(bot, bot.entity)
        const hand = f.equipment && f.equipment[0] ? f.equipment[0].name : ''
        const bowUp = /^(bow|crossbow)$/.test(hand)
        if (f.position.distanceTo(me) < Math.min(4, dist0 - 0.5)) return true
        for (const c of ((Object.values(bot.entities) as any[]) as any)) {
          if (!c || c.name !== 'end_crystal' || !c.position || c.position.distanceTo(me) > 7) continue
          if (boom.blast(bot, c.position, P, me, { def: dMe, seen: 1 }).dmg >= effHp(bot, bot.entity) - 1 && (bowUp || boxDist(f.position.offset(0, EYE, 0), crystalBox(c.position)) < HIT_R + 0.5)) return true
        }
        return false
      }
      let thrown = 0
      await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
      for (let i = 0; i < a.n && !ctl.aborted && !danger(); i++) {
        if (!bot.heldItem || bot.heldItem.name !== 'experience_bottle') break
        try { bot.activateItem() } catch { break }
        thrown++
        await sleep(90)
      }
      try { bot.deactivateItem() } catch {}
      // Сферы впитываются по порции в 2 тика (бутылка 3–11 опыта, 2 прочности за
      // очко; 12 бутылок ≈ 24 порции ≈ 2.5 с) — стоять, пока рядом есть сферы и
      // броня чинится, не дольше 3.5 с, бросить при опасности.
      const t0 = gameClock.now()
      const orbsNear = () => (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'experience_orb' && e.position && e.position.distanceTo(bot.entity.position) < 6)
      await sleep(300)
      while (gameClock.now() - t0 < 3500 && !ctl.aborted && !danger() && orbsNear()) await sleep(TICK)
      // Починено — только по уцелевшим вещам (сломанная пропала бы как «починенная»).
      let fixed = 0
      for (const sl of [5, 6, 7, 8]) {
        const was = w0.items && w0.items[sl]
        const it = bot.inventory.slots[sl]
        if (was == null || !it || it.name !== was.name) continue
        fixed += Math.max(0, was.used - (it.durabilityUsed || 0))
      }
      st.mends = (st.mends || 0) + 1
      st.bottles = (st.bottles || 0) + thrown
      st.repaired = (st.repaired || 0) + fixed
      out.ok = thrown > 0
      out.note = `${a.note}: бутылок ${thrown}, починено ${fixed}`
      out.wait = 150
      return out
    }
    if (a.kind === 'eat') {
      lastEat = gameClock.now()
      const idx = await toHotbar(a.item)
      if (idx < 0) { out.note = 'яблоко: не в хотбаре'; out.wait = 300; return out }
      if (bot.quickBarSlot !== idx) bot.setQuickBarSlot(idx)
      const had = countOf(bot, a.item)
      const dMe = boom.defenseOf(bot, bot.entity)
      let why = null
      const noticed = { at: null }
      try {
        if (ctl.aborted || ctx.stop?.()) { out.note = 'яблоко: прервано'; return out }
        bot.activateItem()
        const t0 = gameClock.now()
        while (gameClock.now() - t0 < 1900 && !ctl.aborted) {
          await sleep(TICK)
          if (countOf(bot, a.item) < had) break
          if (ctl.aborted || ctx.stop?.()) { why = 'другая угроза'; break }
          const defense = eatAnchorDefense(a.item, Math.max(0, require('./tempo').consumeMs(a.item) - (gameClock.now() - t0)), noticed, ctx.reactMs)
          if (defense) { out.defense = defense; why = 'защита от видимого якоря дешевле остатка еды'; break }
          // Его кристалл у меня и мне от него смертельно — бросить есть.
          const f = enemy()
          const me = bot.entity.position
          for (const c of ((Object.values(bot.entities) as any[]) as any)) {
            if (!c || c.name !== 'end_crystal' || !c.position || c.position.distanceTo(me) > 7) continue
            const m = boom.blast(bot, c.position, P, me, { def: dMe })
            if (m.dmg >= effHp(bot, bot.entity) - 1 && f && f.position && boxDist(f.position.offset(0, EYE, 0), crystalBox(c.position)) < HIT_R + 0.5) { why = 'его кристалл у меня'; break }
          }
          if (why) break
        }
      } finally { try { bot.deactivateItem() } catch {} }
      const ate = countOf(bot, a.item) < had
      if (ate) st.gapples = (st.gapples || 0) + 1
      else st.eatAborts = (st.eatAborts || 0) + 1
      out.ok = ate
      out.note = ate ? a.note : `яблоко бросил: ${why || 'не доел'}`
      out.wait = 100
      return out
    }
    if (a.kind === 'surround') {
      lastSurround = gameClock.now()
      const n = await doSurround(ctl, foe)
      if (n > 0) { st.surround++; st.surroundBlocks += n }
      out.ok = n > 0
      out.note = n > 0 ? `${a.note}: ${n} бл.` : 'обсидиан вокруг ног: не встал'
      out.wait = 150
      return out
    }
    return out
  }

  function engaged () {
    const foe = enemy()
    if (!ON || !foe) return false
    const k = kitOf(bot)
    // Набор только с якорями (без кристаллов) — тоже взрывной бой (TODO п.8).
    return k.crystals > 0 || heShows(foe) || anchorReady(bot, k) ||
      [...anchorsAt.values()].some(a => a.pos.distanceTo(bot.entity.position) <= 8 && anchorSeen(a))
  }
  // Кристаллы — главное оружие (набор «кристаллы»: 96 штук): без коробки и без
  // перестрелки из лука. В «небе и порохе» (16 кристаллов среди элитр, булавы,
  // вагонеток) и в «арсенале» всё как было.
  const startDominant = kitOf(bot).crystals >= 20
  function dominant () {
    return ON && (startDominant || kitOf(bot).crystals >= 20)
  }

  function report () {
    const avg = st.dealt.length ? r1(st.dealt.reduce((s, x) => s + x, 0) / st.dealt.length) : undefined
    const active = st.placed || st.hits || st.shots || st.booms || st.surround || st.defuse || st.dodges || st.threats || st.shieldUps || st.covers || st.walls || st.anchors || st.anchorSeen || st.anchorPops
    if (!active) return undefined
    const out: any = {}
    for (const [k, v] of (Object.entries(st) as [string, any][])) {
      if (Array.isArray(v) ? v.length : (typeof v === 'object' ? Object.keys(v).length : v)) out[k] = v
    }
    if (avg !== undefined) out.avg = avg
    if (st.planN) { out.planMsAvg = Math.round(st.planMsSum / st.planN * 10) / 10; delete out.planMsSum }
    return out
  }

  return { st, plan, run, engaged, dominant, report, close, worstVsMe, evade, coverSpot, wallSpot, hisHp, guardFor, _onBlock: onBlock }
}

module.exports = { ON, CX2, create, baseFree, centerOf, hitAim, faceFor, trade, landed, worthHit, crystalBox, boxDist, surrounded, losClear, shieldCovers, P }
