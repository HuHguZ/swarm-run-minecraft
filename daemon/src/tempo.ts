'use strict'
import * as gameClock from './game-clock'
// Темп боя с человеком (жалобы пользователя после живых дуэлей 2026-09-25):
//  · «ел, пока его забивали насмерть» — есть и пить только когда безопасно, и
//    бросать глоток в тот же тик, когда безопасно быть перестало;
//  · «горел в коробке, её ломали, а он ел» — вскрытая коробка: потушиться и
//    вырваться с дальней от врага стороны, а не стоять;
//  · «оба бота в начале пьют одно и то же» — план начала боя на каждый бой свой;
//  · «когда другой пьёт — это твоя возможность» — видеть, чем противник занят
//    (ест, пьёт, тянет лук, в паутине, строит столб, прилетел жемчугом,
//    только что махнул), и наказывать сразу.
// pvp.js зовёт отсюда маленькими крючками. ND_TEMPO=0 выключает новое
// поведение (прогон «до» для сравнения), счётчики при этом считают так же.
//
// Числа механики — из кода игры 1.21.11 (github extremeheat/extracted_minecraft_data,
// ветка client1.21.11); класс указан рядом с числом.

import { raySees } from './perception'
import { blockName, stepSafe, keyDir, wantsJump } from './moves'
import { edgeBurns } from './pvp/body'
import { sleep } from './movement'

const ON = process.env.ND_TEMPO !== '0'
// Качество боя (pvp.js FIX, 2026-09-26); ND_FIGHTFIX=0 — как раньше.
const FIX = process.env.ND_FIGHTFIX !== '0'
const TICK_MS = 50

// Consumables.defaultFood()/defaultDrink(): consumeSeconds(1.6F) — еда, золотые
// яблоки и питьевые зелья по 32 тика; DRIED_KELP 0.8 с, HONEY_BOTTLE 2.0 с.
function consumeMs (name) {
  if (name === 'dried_kelp') return 800
  if (name === 'honey_bottle') return 2000
  return 1600
}
// UseEffects.DEFAULT = (canSprint=false, speedMultiplier=0.2F): пока предмет в
// ходу, ввод движения ×0.2 (LocalPlayer.modifyInput), спринт не начать
// (LocalPlayer.canStartSprinting: !isSlowDueToUsingItem), рука занята — удара нет.
const USE_SPEED_MUL = 0.2
// Скорость игрока по земле, блоков за тик: MOVEMENT_SPEED 0.1
// (Player.createAttributes) × 1.3 спринт (LivingEntity.SPEED_MODIFIER_SPRINTING,
// 0.3 ADD_MULTIPLIED_TOTAL) × 0.98 ввод (LocalPlayer.modifyInput); за тик тело
// проходит a/(1 − 0.6·0.91) (LivingEntity.travel, трение блока 0.6 × 0.91) =
// 0.2806 бл/тик, 5.6 бл/с. Скорость зелья — +20% за уровень (MobEffects.SPEED).
const SPRINT_BPT = 0.1 * 1.3 * 0.98 / (1 - 0.6 * 0.91)
const WALK_BPT = 0.1 * 0.98 / (1 - 0.6 * 0.91)
// WebBlock.entityInside: makeStuckInBlock(state, Vec3(0.25, 0.05, 0.25)).
const WEB_MUL = 0.25
// BowItem.getPowerForTime: сила (t²+2t)/3 при t = тики/20 — полная с 20 тиков;
// releaseUsing: скорость стрелы = сила × 3.0 бл/тик.
const FULL_DRAW_MS = 1000
const ARROW_BPT = 3.0
// Урон проходит снова, когда от 20 тиков неуязвимости осталось ≤10
// (LivingEntity.hurtServer: invulnerableTime > 10 гасит удар) — «бьют прямо
// сейчас», если урон был меньше 10 тиков (+ тик пинга) назад.
const HURT_WINDOW_MS = 550
// ThrownEnderpearl.onHit: hurtServer(enderPearl(), 5.0F) — прилетевший жемчугом
// потерял 5 хп и стоит там, где его не ждал.
const PEARL_DAMAGE = 5
// Урон своего жемчуга с нашей бронёй: тип ender_pearl в тегах is_fall и
// bypasses_armor (server-1.21.11.jar, data/minecraft/tags/damage_type) —
// броня не режет, а «Невесомость» режет как падение (+3 EPF за уровень), и
// «Защита» (+1 за уровень): 5 × (1 − min(20, EPF)/25).
function pearlDamage (bot) {
  try {
    const read: typeof import('./read') = require('./read')
    const worn = [5, 6, 7, 8].map(i => bot.inventory.slots[i]).filter(Boolean)
    const epf = worn.reduce((n, it) => n + read.enchLevel(bot, it, 'protection') + 3 * read.enchLevel(bot, it, 'feather_falling'), 0)
    return PEARL_DAMAGE * (1 - Math.min(20, epf) / 25)
  } catch { return PEARL_DAMAGE }
}
// LivingEntity.DATA_LIVING_ENTITY_FLAGS — синхронное поле №8 (у Entity их восемь,
// 0..7); бит 1 — isUsingItem, бит 2 — левая рука (getUsedItemHand).
const FLAGS_INDEX = 8
// Досягаемость удара игрока — ENTITY_INTERACTION_RANGE 3.0 (Player.createAttributes);
// +0.3 на пинг и на то, что он сдвинется между нашим расчётом и его пакетом.
const PLAYER_REACH = 3.3
// Potions: SWIFTNESS 3600 тиков, LONG_SWIFTNESS 9600, STRONG_SWIFTNESS 1800 (уровень II).
const SWIFT = { swiftness: [1, 180000], long_swiftness: [1, 480000], strong_swiftness: [2, 90000] }
// Перезарядка удара = 20 / attack_speed тиков (Attributes.ATTACK_SPEED предметов:
// меч 1.6, топоры 0.8–1.0) — пока он заряжается, полного удара от него нет.
function swingCooldownMs (name) {
  if (!name) return 250
  if (/_sword$/.test(name)) return 625
  if (/^(wooden|stone)_axe$/.test(name)) return 1250
  if (name === 'iron_axe') return 1111
  if (/_axe$/.test(name)) return 1000
  if (name === 'mace') return 1667
  if (name === 'trident') return 909
  return 250
}

const EAT_RE = /apple|beef|porkchop|chicken|mutton|rabbit|cod|salmon|bread|potato|carrot|stew|soup|cookie|melon_slice|berries|pie|honey|kelp|chorus|beetroot/
function useKind (name) {
  if (!name) return 'other'
  if (name === 'potion' || name === 'honey_bottle' || name === 'milk_bucket') return 'drink'
  if (EAT_RE.test(name)) return 'eat'
  if (name === 'bow' || name === 'crossbow' || name === 'trident') return 'draw'
  if (name === 'shield') return 'block'
  return 'other'
}

function potionName (item) {
  try { return (require('./pvp') as typeof import('./pvp')).potionOf(item) } catch { return null }
}

function flagsOf (e) {
  const f = e && e.metadata ? e.metadata[FLAGS_INDEX] : 0
  return typeof f === 'number' ? f : 0
}

function burning (e) {
  try { return (e.metadata[0] & 0x01) !== 0 } catch { return false }
}

function reachFrom (eye, e) {
  const hw = (e.width || 0.6) / 2
  const h = e.height || 1.8
  const p = e.position
  const cx = Math.max(p.x - hw, Math.min(p.x + hw, eye.x))
  const cy = Math.max(p.y, Math.min(p.y + h, eye.y))
  const cz = Math.max(p.z - hw, Math.min(p.z + hw, eye.z))
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

function hasEffect (bot, name) {
  try {
    const eff = bot.registry.effectsByName[name]
    return !!(eff && bot.entity.effects && bot.entity.effects[eff.id])
  } catch { return false }
}

function inWebAt (bot, pos) {
  const f = pos.floored()
  return blockName(bot, f) === 'cobweb' || blockName(bot, f.offset(0, 1, 0)) === 'cobweb'
}

// ------------------------------------------------------------------ слежка
//
// Что делает каждый, кто нам враг в этом бою. Всё — на событиях (метаданные,
// взмах руки, блоки, урон) и на тике физики: реакция не ждёт цикла решений,
// который бывает занят луком или зельем по секунде.
function track (bot, { threats, reactMs = 150 }: any = {}) {
  const tk = trackState(bot, threats, reactMs)
  trackListen(tk)
  trackReads(tk)
  trackConsume(tk)
  return tk.T
}

// Слежка за врагами одного боя: T — объект, который получает бой (прежний T), foes — что известно о каждом,
// foeList — враги сейчас, S(e) — запись врага.
interface TrackCtx {
  bot: any; T: any; foes: Map<any, any>; stats: any; foeList: () => any[]; isFoe: (e: any) => boolean; S: (e: any) => any
}

function trackState (bot, threats, reactMs): TrackCtx {
  const foes = new Map()
  const stats = {
    consumes: 0, pressured: 0, aborted: 0, desperate: 0, refused: 0,
    foeConsumes: 0, busyLanded: 0, busyByKind: {}, punish: {},
    breaches: 0, breachEscapes: 0, kites: 0
  }
  const T: any = { foes, stats, myHurtAt: 0, reactMs, opening: null }
  const foeList = () => { try { return (threats() || []).filter(e => e && e.isValid !== false && e.position) } catch { return [] } }
  T.threats = foeList
  const isFoe = (e) => !!e && foeList().some(t => t.id === e.id)
  const S = (e) => {
    let s = foes.get(e.id)
    if (!s) {
      s = { use: null, lastUse: null, swungAt: 0, pearlAt: 0, placeAt: 0, pillarAt: 0, digAt: 0, digPos: null, digKey: null, digStart: 0, digTotal: 0, speedLvl: 0, speedUntil: 0, hist: [], peak: 0 }
      foes.set(e.id, s)
    }
    return s
  }
  return { bot, T, foes, stats, foeList, isFoe, S }
}

// Слушатели: его глоток/натяжка (метаданные), взмах, постройка, копание, урон, скорость по тикам; T.close снимает их.
function trackListen (tk: TrackCtx) {
  const { bot, T, stats, foeList, isFoe, S } = tk
  const onUpdate = (e) => {
    if (!isFoe(e)) return
    e = foeList().find(t => t.id === e.id)
    const s = S(e)
    if (e._ndVisible === false) { s.use = null; return }
    const now = gameClock.now()
    const f = flagsOf(e)
    const using = (f & 1) !== 0
    if (using && !s.use) {
      const it = (e.equipment || [])[(f & 2) ? 1 : 0]
      const name = it ? it.name : null
      s.use = { since: now, name, kind: useKind(name), potion: name === 'potion' ? potionName(it) : null }
      if (s.use.kind === 'eat' || s.use.kind === 'drink') stats.foeConsumes++
    } else if (!using && s.use) {
      const u = s.use
      s.use = null
      s.lastUse = { ...u, until: now }
      // Допил до конца — зелье на нём. Скорость меняет, как быстро он добежит.
      if (u.kind === 'drink' && u.potion && now - u.since >= consumeMs(u.name) - 150 && SWIFT[u.potion]) {
        s.speedLvl = SWIFT[u.potion][0]
        s.speedUntil = now + SWIFT[u.potion][1]
      }
    }
  }
  const onSwing = (e) => { const seen = foeList().find(t => t.id === e?.id); if (seen && seen._ndVisible !== false) S(seen).swungAt = gameClock.now() }
  // Поставил блок рядом с собой сразу после взмаха — строит; под себя — столб.
  const onBlock = (oldB, newB) => {
    try {
      if (!newB || newB.boundingBox !== 'block' || (oldB && oldB.boundingBox === 'block')) return
      const now = gameClock.now()
      for (const e of foeList()) {
        if (e._ndVisible === false) continue
        const s = S(e)
        if (now - s.swungAt > 400) continue
        const c = newB.position.offset(0.5, 0.5, 0.5)
        if (c.distanceTo(e.position.offset(0, 1.62, 0)) > 5.5) continue
        s.placeAt = now
        if (newB.position.x === Math.floor(e.position.x) && newB.position.z === Math.floor(e.position.z) && newB.position.y < e.position.y) s.pillarAt = now
      }
    } catch {}
  }
  // Он ломает блок: когда доломает — по его инструменту в руке и чарам на нём
  // (prismarine-block digTime, та же формула, что у сервера): обсидиан алмазной
  // киркой 9.4 с, с «Эффективностью V» 2.2 с. Стены коробки из обсидиана (2026-
  // 09-26) не повод выскакивать в первую же секунду его копания.
  const onDig = (block, stage, breaker) => {
    if (!breaker || !isFoe(breaker) || !block || !block.position) return
    if (!(require('./pick') as typeof import('./pick')).blockSeen(bot, block.position)) return
    breaker = foeList().find(t => t.id === breaker.id)
    const s = S(breaker)
    const now = gameClock.now()
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    if (s.digKey !== key || now - s.digAt > 1500) {
      s.digKey = key
      s.digStart = now
      s.digTotal = 0
      try {
        const tool = breaker.equipment && breaker.equipment[0]
        const b = bot.blockAt(block.position)
        if (b && b.digTime) s.digTotal = b.digTime(tool ? tool.type : null, false, false, false, (tool && tool.enchants) || [], {})
      } catch {}
    }
    s.digAt = now
    s.digPos = block.position.clone ? block.position.clone() : block.position
  }
  // Сколько ему ещё ломать текущий блок (мс); null — не ломает или неизвестно.
  T.digLeftMs = (e) => {
    const s = S(e)
    if (!s.digAt || gameClock.now() - s.digAt > 1200 || !s.digTotal || !Number.isFinite(s.digTotal)) return null
    return Math.max(0, s.digStart + s.digTotal - gameClock.now())
  }
  const onHurt = (victim, source) => {
    const now = gameClock.now()
    if (victim === bot.entity) T.myHurtAt = now
    if (victim && source && bot.entity && source.id === bot.entity.id && isFoe(victim)) {
      const b = T.busy(victim)
      if (b) { stats.busyLanded++; stats.busyByKind[b] = (stats.busyByKind[b] || 0) + 1 }
    }
  }
  // Скорость — по тикам физики: пик за 2 с. Скачок больше 4 блоков за тик —
  // телепорт (жемчуг), в скорость не идёт.
  const onTick = () => {
    const now = gameClock.now()
    for (const e of foeList()) {
      const s = S(e)
      if (e._ndVisible === false) { s.use = null; s.hist.length = 0; s.peak = 0; continue }
      const p = e.position
      const last = s.hist[s.hist.length - 1]
      if (last && now - last.t < 40) continue
      if (last) {
        const dh = Math.hypot(p.x - last.x, p.z - last.z)
        const ticks = Math.max(1, (now - last.t) / TICK_MS)
        if (dh > 4 && ticks <= 3) { s.pearlAt = now; s.hist.length = 0 }
        else s.hist.push({ x: p.x, z: p.z, t: now, v: dh / ticks })
      } else s.hist.push({ x: p.x, z: p.z, t: now, v: 0 })
      while (s.hist.length > 1 && now - s.hist[0].t > 2000) s.hist.shift()
      // Пик по среднему из трёх тиков: один дёрнувшийся пакет — не скорость.
      let peak = 0
      for (let i = 2; i < s.hist.length; i++) peak = Math.max(peak, (s.hist[i].v + s.hist[i - 1].v + s.hist[i - 2].v) / 3)
      s.peak = peak
    }
  }
  bot.on('entityUpdate', onUpdate)
  bot.on('entitySwingArm', onSwing)
  bot.on('blockUpdate', onBlock)
  bot.on('blockBreakProgressObserved', onDig)
  bot.on('entityHurt', onHurt)
  bot.on('physicsTick', onTick)
  T.close = () => {
    bot.removeListener('entityUpdate', onUpdate)
    bot.removeListener('entitySwingArm', onSwing)
    bot.removeListener('blockUpdate', onBlock)
    bot.removeListener('blockBreakProgressObserved', onDig)
    bot.removeListener('entityHurt', onHurt)
    bot.removeListener('physicsTick', onTick)
  }
}

// Чем он занят, через сколько достанет, безопасно ли занять руки (T.state, busy, eta, safe).
function trackReads (tk: TrackCtx) {
  const { bot, T, foeList, S } = tk
  // Чем он занят сейчас. left — сколько ещё мс он будет занят (оценка).
  T.state = (e) => {
    if (!e || !e.position) return {}
    e = foeList().find(t => t.id === e.id) || e
    const s = S(e)
    const now = gameClock.now()
    const out: any = {}
    if (s.use && (s.use.kind === 'eat' || s.use.kind === 'drink')) {
      out.consuming = { item: s.use.potion || s.use.name, since: s.use.since, left: Math.max(0, consumeMs(s.use.name) - (now - s.use.since)) }
    }
    if (s.use && s.use.kind === 'draw') out.drawing = now - s.use.since
    if (s.use && s.use.kind === 'block') out.blocking = true
    if (inWebAt(bot, e.position)) out.inWeb = true
    if (burning(e)) out.burning = true
    if (now - s.pillarAt < 900) out.pillaring = true
    else if (now - s.placeAt < 500) out.placing = true
    if (now - s.pearlAt < 1500) out.pearled = now - s.pearlAt
    const held = e.equipment && e.equipment[0] ? e.equipment[0].name : null
    const cdMs = swingCooldownMs(held)
    if (now - s.swungAt < cdMs - 100) out.swung = { ago: now - s.swungAt, left: cdMs - (now - s.swungAt) }
    out.since = s.use ? s.use.since : 0
    return out
  }
  // Одно слово — чем занят (для счёта «попал, пока он занят»).
  T.busy = (e) => {
    const b = T.state(e)
    if (b.consuming) return 'ест/пьёт'
    if (b.drawing) return 'тянет лук'
    if (b.inWeb) return 'в паутине'
    if (b.pillaring || b.placing) return 'строит'
    if (b.pearled) return 'после жемчуга'
    return null
  }

  // Через сколько мс он сможет по нам попасть: рукой (дойти до края своей
  // досягаемости спринтом) или стрелой (дотянуть лук и долететь).
  T.eta = (e) => {
    const me = bot.entity
    if (!me || !e || !e.position) return Infinity
    const s = S(e)
    const now = gameClock.now()
    const eye = e.position.offset(0, 1.62, 0)
    const r = reachFrom(eye, me)
    const gap = Math.max(0, r - PLAYER_REACH)
    const lvl = now < s.speedUntil ? s.speedLvl : 0
    let v = Math.max(s.peak || 0, SPRINT_BPT * (1 + 0.2 * lvl))
    if (inWebAt(bot, e.position)) v = Math.min(v, SPRINT_BPT * (1 + 0.2 * lvl) * WEB_MUL)
    let melee = gap <= 0 ? 0 : (gap / v) * TICK_MS
    // Он сам ест или пьёт: до конца глотка он медленный (×0.2) и без удара;
    // бросить глоток может, но глоток зелья люди не бросают — считаем половину.
    const b = T.state(e)
    if (melee > 0 && b.consuming) melee += b.consuming.left / 2
    let ranged = Infinity
    const held = e.equipment && e.equipment[0] ? e.equipment[0].name : null
    if ((held === 'bow' || held === 'crossbow') && r < 40) {
      let sees = true
      try { sees = raySees(bot, eye, me.position.offset(0, 1.0, 0)) } catch {}
      if (sees) ranged = Math.max(0, FULL_DRAW_MS - (b.drawing || 0)) + (r / ARROW_BPT) * TICK_MS
    }
    return Math.min(melee, ranged)
  }

  // Безопасно ли занять руки на ms. fortSealed — сидим в целой коробке, и её
  // никто не ломает.
  // ignoreFire — пьём саму огнестойкость: горение ей не помеха, а причина.
  T.safe = (ms = 1600, { fortSealed = false, ignoreFire = false }: any = {}) => {
    const now = gameClock.now()
    if (now - T.myHurtAt < HURT_WINDOW_MS) return { ok: false, why: 'по мне попали' }
    if (!ignoreFire && burning(bot.entity) && !hasEffect(bot, 'fire_resistance')) return { ok: false, why: 'горю' }
    const foes = foeList()
    if (fortSealed) {
      // Копает, но доломает позже конца глотка (обсидиан) — пить можно.
      const digging = foes.some(e => {
        if (now - S(e).digAt >= 1200) return false
        const left = T.digLeftMs(e)
        return left == null || left < ms + 400
      })
      if (!digging) return { ok: true, why: 'в целой коробке' }
      return { ok: false, why: 'ломают коробку' }
    }
    let worst = null
    for (const e of foes) {
      const eta = T.eta(e)
      if (!worst || eta < worst.eta) worst = { e, eta }
    }
    if (worst && worst.eta < ms + T.reactMs) {
      return { ok: false, why: `${worst.e.username || worst.e.name} достанет через ${Math.round(worst.eta)} мс`, eta: worst.eta }
    }
    return { ok: true, eta: worst ? worst.eta : Infinity }
  }
}

// Глоток под сторожем, учёт и как наказать то, чем он занят (T.guard, noteConsume, punished, punish).
function trackConsume (tk: TrackCtx) {
  const { bot, T, stats } = tk
  // Сторож глотка: зовётся каждый тик, пока едим; true — бросать. Считает по
  // оставшемуся времени, а не по полному.
  T.guard = (name, opts: any = {}) => {
    const t0 = gameClock.now()
    const total = consumeMs(name)
    return () => {
      const left = Math.max(100, total - (gameClock.now() - t0))
      const s = T.safe(left, { fortSealed: typeof opts.fortSealed === 'function' ? opts.fortSealed() : !!opts.fortSealed })
      if (!s.ok) T.lastAbort = String(s.why).replace(/ через \d+ мс/, '')
      return !s.ok
    }
  }

  // Учёт: начали есть — под давлением ли. Одна и та же мерка до и после.
  T.noteConsume = (name, { desperate = false, fortSealed = false }: any = {}) => {
    stats.consumes++
    const s = T.safe(consumeMs(name), { fortSealed })
    if (!s.ok) stats.pressured++
    if (desperate) stats.desperate++
    if (process.env.ND_DEBUG_PVP) console.log('[tempo] consume', name, s.ok ? 'safe' : 'PRESSURE: ' + s.why, desperate ? 'desperate' : '')
    return s
  }
  T.punished = (kind) => { stats.punish[kind] = (stats.punish[kind] || 0) + 1 }

  // Как наказать то, чем он занят. null — он свободен или окно уже упущено.
  // Решение — после реакции (reactMs от начала его занятости), а не в тот же тик.
  T.punish = (e, { d, r, sees, has = {}, hitReach = 2.9 }: any = {}) => {
    // Сработал его тотем (read.js через T.read, 2026-09-26): 5 с у него 1 хп и
    // 8 поглощения, эффекты сняты (DeathProtection.TOTEM_OF_UNDYING) — всё в ход:
    // вред II (12 магией мимо брони) убивает, иначе рывок и удар.
    const ai = T.read && T.read.allIn ? T.read.allIn(e) : null
    if (ai) {
      // «Защита» на его броне режет и магию: 12 × (1 − EPF/25), EPF — сумма
      // уровней, не больше 20 (CombatRules.getDamageAfterMagicAbsorb). После
      // тотема у него 1 хп + 8 поглощения: вред убивает при EPF ≤ 6, иначе
      // рывок (арена с чарами, 2026-09-26).
      let epf = 0
      try { epf = Math.min(20, [2, 3, 4, 5].reduce((n, i) => n + (e.equipment && e.equipment[i] ? (require('./read') as typeof import('./read')).enchLevel(bot, e.equipment[i], 'protection') : 0), 0)) } catch {}
      const harmKills = 12 * (1 - epf / 25) >= 9
      if (has.harm && harmKills && sees && d > 2.5 && d < 7) return { kind: 'harm', why: ai.why, left: ai.left }
      return { kind: 'rush', why: ai.why, left: ai.left }
    }
    const b = T.state(e)
    const now = gameClock.now()
    const reacted = (since) => !since || now - since >= T.reactMs
    const reachMs = Math.max(0, r - hitReach) / SPRINT_BPT * TICK_MS
    if (b.consuming && reacted(b.consuming.since)) {
      const busy = `он ${/potion/.test(b.consuming.item || '') || !EAT_RE.test(b.consuming.item || '') ? 'пьёт' : 'ест'}`
      if (has.harm && sees && d > 3 && d < 7) return { kind: 'harm', why: busy, left: b.consuming.left }
      if (reachMs < b.consuming.left + 300 && d < 10) return { kind: 'rush', why: busy, left: b.consuming.left }
      if (has.bow && sees && d >= 6) return { kind: 'bow', why: busy, left: b.consuming.left }
      return { kind: 'rush', why: busy, left: b.consuming.left }
    }
    if (b.inWeb) {
      if (has.harm && sees && d > 3 && d < 7) return { kind: 'harm', why: 'он в паутине' }
      if (has.bow && sees && d >= 7) return { kind: 'bow', why: 'он в паутине' }
      return { kind: 'rush', why: 'он в паутине' }
    }
    // Тянет лук — медленный (×0.2) и рукой не ударит, пока не отпустит.
    if (b.drawing && b.drawing >= T.reactMs && d < 12) return { kind: 'rush', why: 'он тянет лук' }
    if (b.pillaring || b.placing) {
      if (d < 7) return { kind: 'rush', why: b.pillaring ? 'он строит столб' : 'он ставит блоки' }
      if (has.bow && sees) return { kind: 'bow', why: 'он строится' }
    }
    if (b.pearled && b.pearled >= T.reactMs) {
      if (d < 8) return { kind: 'rush', why: 'он прилетел жемчугом (−' + PEARL_DAMAGE + ' хп)' }
      if (has.bow && sees) return { kind: 'bow', why: 'он прилетел жемчугом' }
    }
    // Только что махнул: его удар заряжается — наш следующий придёт первым.
    if (b.swung && b.swung.left > 200 && r < 4.5) return { kind: 'step', why: 'он только что махнул', left: b.swung.left }
    return null
  }
}

// ------------------------------------------------------------------ начало
//
// План начала боя — на бой, по дистанции, киту, здоровью и характеру.
// has: { bow, drinkBuffs, splashDebuff, harm, pearls, fort, heal }.
function pickOpening ({ d, hp, aggression = 0.5, has = {}, foeBusy = false }: any) {
  const w: any = {}
  w.rush = 0.8 + aggression * 1.4
  if (has.bow && d >= 8) w.bow = 0.5 + (1 - aggression) * 1.2
  // Пить на старте можно, только если есть время (глоток 1.6 с): тогда и
  // заложен вес; сам глоток всё равно спросит safe() и бросит, если он бежит.
  // Он сам уже пьёт или ест (FIX, 2026-09-26: «вдвоём пьют и смотрят друг на
  // друга») — это окно наказать, а не пить следом: рывок и выстрел вместо бафа.
  if (has.drinkBuffs) w.buff = foeBusy ? (FIX ? 0.1 : 1.6) : d >= 10 ? 0.8 : 0.2
  if (FIX && foeBusy) { w.rush *= 1.6; if (w.bow) w.bow *= 1.4 }
  if (has.splashDebuff && d >= 4) w.splash = 0.6 + aggression * 0.3
  if (has.pearls >= 2 && d >= 10 && hp >= 15) w.pearl = 0.25 + aggression * 0.5
  if (has.fort && (has.drinkBuffs || has.heal)) w.fort = 0.2 + (1 - aggression) * 0.4
  const total: any = (Object.values(w) as any[]).reduce((a: any, b) => a + b, 0)
  let x = Math.random() * total
  for (const [k, v] of ((Object.entries(w) as [string, any][]) as any)) { x -= v; if (x <= 0) return { kind: k, weights: w } }
  return { kind: 'rush', weights: w }
}

// ------------------------------------------------------------------ отрыв
//
// Бегом от всех врагов (flee.pickDirection: мимо стен, обрывов, лавы) со
// спринтом и прыжками. until() — хватит, стало безопасно; stop() — он догнал.
// Взгляд ведёт сам: aim в pvp.js на это время 'free'.
async function kite (bot, ctl, threats, { ms = 1500, until = null, stop = null }: any = {}) {
  const flee: typeof import('./flee') = require('./flee')
  const t0 = gameClock.now()
  let plan = null
  let planAt = 0
  let out = 'время'
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      if (until && until()) { out = 'оторвался'; break }
      if (stop && stop()) { out = 'догнал'; break }
      if (gameClock.now() >= planAt) {
        const me = bot.entity.position
        const hs = (threats() || []).filter(e => e && e.position).map(e => ({ e, doc: { radius: 12, weight: 10 }, d: e.position.distanceTo(me) }))
        plan = flee.pickDirection(bot, hs, plan ? plan.yaw : null)
        planAt = gameClock.now() + 300
      }
      if (!plan) { out = 'некуда'; break }
      await bot.look(plan.yaw, 0, true).catch(() => {})
      const f = keyDir(bot, 'forward')
      // Край рамки над лавой или огнём — не шаг (поток «окружение» 21.10: центр шага на камне, край — над ямой с лавой).
      const go = stepSafe(bot, f, { water: false }) && !edgeBurns(bot, f)
      bot.setControlState('forward', go)
      bot.setControlState('sprint', go && (bot.food ?? 20) > 6)
      // Спринт с прыжками быстрее спринта (прыжок со спринтом даёт +0.2 по ходу,
      // LivingEntity.jumpFromGround) — если приземление по ходу безопасно.
      const hop = go && bot.entity.onGround && stepSafe(bot, f, { water: false, reach: 2.6 }) && !edgeBurns(bot, f, 2.6)
      bot.setControlState('jump', wantsJump(bot, f) || hop)
      await sleep(TICK_MS)
    }
  } finally {
    for (const k of ['forward', 'sprint', 'jump']) { try { bot.setControlState(k, false) } catch {} }
  }
  return out
}

export {
  ON, track, pickOpening, kite, consumeMs, useKind, swingCooldownMs, reachFrom,
  SPRINT_BPT, WALK_BPT, USE_SPEED_MUL, WEB_MUL, FULL_DRAW_MS, ARROW_BPT, HURT_WINDOW_MS, PEARL_DAMAGE, pearlDamage, FLAGS_INDEX, PLAYER_REACH
}
