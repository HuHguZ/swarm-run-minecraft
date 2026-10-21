'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { xyz, sleep } from '../movement'
import { canSeePoint } from '../perception'
import { seesBlock } from '../sight'
import * as worlds from '../worlds'

const PLACE = 'крепость (ад)'
const SPAWNER_PLACE = 'спавнер блейзов'
const FORTRESS_BLOCKS = ['nether_bricks', 'nether_brick_fence', 'nether_brick_stairs']
const BASTION_BLOCKS = ['polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'gilded_blackstone']
const BASTION_PLACE = 'бастион (ад)'
const DIRS = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }
const WORDS = { east: 'восток', west: 'запад', south: 'юг', north: 'север' }

// Время (ЧЧ:ММ:СС) — для разбора, куда ушли минуты этапа (dev-F 02.10).
const log = (what, o) => console.log('[fortress]', new Date().toTimeString().slice(0, 8), what, JSON.stringify(o))
function clamp (v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// Сторона света по смещению: 0° — юг (+z), 90° — восток (+x), как у stronghold.js.
function bearingWords (dx, dz) {
  const a = (Math.atan2(dx, dz) * 180 / Math.PI + 360) % 360
  const names = ['юг', 'юго-восток', 'восток', 'северо-восток', 'север', 'северо-запад', 'запад', 'юго-запад']
  return names[Math.round(a / 45) % 8]
}

// Eight eye rays, first hit only. Unknown cells end the observed horizon.
// This is visibility, never proof of a floor or a walkable corridor.
// Чистая дальность луча от глаз по направлению dir (до reach): первый блок с формой, лава/вода/огонь — стоп.
function rayClear (bot, eye, dir, reach = 64) {
  const { RaycastIterator } = (require('prismarine-world') as typeof import('prismarine-world')).iterators
  const cube: [number, number, number, number, number, number][] = [[0, 0, 0, 1, 1, 1]]
  const ray = new RaycastIterator(eye, dir, reach)
  let p = eye.floored(), clear = reach
  try {
    while (p) {
      const entry = ray.intersect(cube, p)
      const at = Math.max(0, Math.min(reach, entry ? entry.pos.minus(eye).dot(dir) : 0))
      const b = bot.blockAt(p)
      if (!b) { clear = at; break }
      const hit = ray.intersect(b.shapes || (b.boundingBox === 'block' ? cube : []), p)
      if (hit || /^(lava|water|fire|soul_fire)$/.test(b.name)) {
        clear = hit ? Math.max(0, Math.min(reach, hit.pos.minus(eye).dot(dir))) : at
        break
      }
      const next = ray.next()
      p = next ? new Vec3(next.x, next.y, next.z) : null
    }
  } catch { clear = 0 }
  return clear
}
function openDirections (bot) {
  const eye = (require('../pick') as typeof import('../pick')).eyeOf(bot)
  return Array.from({ length: 8 }, (_, k) => {
    const a = k * Math.PI / 4
    return { k, clear: rayClear(bot, eye, new Vec3(Math.cos(a), 0, Math.sin(a)), 64) }
  })
}

// Один взгляд вокруг: для каждого вида — свой findBlocks и свой бюджет лучей.
// ND_BASTION_TOUCH (поток ne 21.10): свою копку тело знает как игрок — сломанный кирпич бастиона. Изнутри штрека видно 4–10 граней,
// порога 24 видимых нет никогда (nbt24a: 7–12 кирпичей в рюкзаке, «bastion 0», 3 захода поиска, 572 с). Руины портала — ~10
// кирпичей и сквозь них не копают; 6 своих в 24 бл. — бастион.
function touchInstall (bot) {
  if (bot._ndBastionTouch) return bot._ndBastionTouch
  const dug = bot._ndBastionTouch = []
  // diggingCompleted отдаёт уже воздух — смотрим смену блока в досягаемости тела (5 бл.): кирпич → воздух = своя копка.
  bot.on('blockUpdate', (o, n) => {
    if (!o || !n || n.type !== 0 || !BASTION_BLOCKS.includes(o.name) || !o.position || !bot.entity || o.position.distanceTo(bot.entity.position) > 5) return
    dug.push(o.position.clone()); if (dug.length > 64) dug.shift()
  })
  return dug
}
function look (bot, mcData, { radius = 64, perKind = 400, rayBudget = 500 }: any = {}) {
  const touched = process.env.ND_BASTION_TOUCH === '1' ? touchInstall(bot) : null
  const me = bot.entity.position
  const ids = FORTRESS_BLOCKS.map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
  let candidates = []
  for (const id of ids) candidates.push(...bot.findBlocks({ matching: [id], maxDistance: radius, count: perKind }))
  // ND_BLZ_NO_THRONE: кирпич крепости без трона (регион брошен после обходов) — не «вижу крепость» снова.
  const skip = bot._ndSkipFortRegions
  if (skip?.length) candidates = candidates.filter(p => !skip.some(r => r[0] === Math.floor(p.x / 432) && r[1] === Math.floor(p.z / 432)))
  candidates.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
  const found = candidates.length
  // Лучи — поровну ближним и дальним: крепость видно с края, а ближние
  // кандидаты за стеной съели бы весь бюджет.
  let pick = candidates
  if (candidates.length > rayBudget) {
    const step = candidates.length / rayBudget
    pick = []
    for (let i = 0; i < rayBudget; i++) pick.push(candidates[Math.floor(i * step)])
  }
  const seen = []
  for (const p of pick) {
    const b = bot.blockAt(p)
    if (b && seesBlock(bot, b)) seen.push(p)
  }
  const spawnerId = mcData.blocksByName.spawner.id
  const spawners = bot.findBlocks({ matching: [spawnerId], maxDistance: Math.min(radius, 48), count: 16 })
    .filter(p => { const b = bot.blockAt(p); return b && seesBlock(bot, b) })
  const blazes = (Object.values(bot.entities) as any[]).filter((e : any) => e && e.name === 'blaze' && e.position &&
    e.position.distanceTo(me) <= radius && canSeePoint(bot, e.position.offset(0, 0.9, 0)))
  const out: any = { candidates: found, rayChecked: pick.length, seen: seen.length, seenList: seen }
  // Бастион: полированный блэкстоун-кирпич и позолоченный блэкстоун. Кирпич
  // бывает и в разрушенном портале (BlackstoneReplaceProcessor меняет
  // stone_bricks на polished_blackstone_bricks), но там его десяток — поэтому
  // порог 24 видимых. В регионе одна постройка: бастион — крепости тут нет.
  const bIds = BASTION_BLOCKS.map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
  const bCand = bot.findBlocks({ matching: bIds, maxDistance: radius, count: 200 })
  const bSeen = []
  for (let i = 0; i < bCand.length && bSeen.length < 40; i += Math.max(1, Math.floor(bCand.length / 120))) {
    const b = bot.blockAt(bCand[i])
    if (b && seesBlock(bot, b)) bSeen.push(bCand[i])
  }
  let housing = null
  if (bSeen.length >= 8 && bSeen.length < 24 && bot.world?.getColumn && bot.world?.raycast) {
    // The sparse candidate scan may miss most of a visible facade; require a template fit before lowering detection.
    const steps = (require('../bastion/entry-route') as typeof import('../bastion/entry-route')).observeSteps(bot)
    let next = steps.next()
    while (!next.done) next = steps.next()
    if (next.value?.type === 'units') housing = next.value
  }
  if (bSeen.length >= 24 || housing) {
    bSeen.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    // Большие руины портала Ада — тот же кирпич, но у них на виду обсидиан рамы (обычный и плачущий), у бастиона его нет
    // (b10-5-2 14.10: «бастион» из 32 блоков у руин — вышки и обзор впустую, золота 0).
    const oIds = ['obsidian', 'crying_obsidian'].map(n => mcData.blocksByName[n]).filter(Boolean).map(b => b.id)
    const frame = bot.findBlocks({ matching: oIds, point: bSeen[0], maxDistance: 12, count: 12 }).some(p => { const b = bot.blockAt(p); return b && seesBlock(bot, b) })
    if (frame && process.env.ND_NE_RUINS_CHECK !== '0') out.ruins = { seen: bSeen.length, nearest: xyz(bSeen[0]), dist: Math.round(bSeen[0].distanceTo(me)) }
    else out.bastion = { seen: bSeen.length, nearest: xyz(bSeen[0]), dist: Math.round(bSeen[0].distanceTo(me)), bearing: bearingWords(bSeen[0].x - me.x, bSeen[0].z - me.z) }
  }
  if (housing && out.bastion) { out.bastion.type = 'units'; out.bastion.hypotheses = housing.hypotheses.length }
  // ND_BASTION_BRUTE_SIGN: брут рождается только в бастионе и держится своего HOME (PiglinBruteAi) — видимый брут = бастион здесь.
  if (process.env.ND_BASTION_BRUTE_SIGN === '1' && !out.bastion && !out.ruins) {
    const brute = (Object.values(bot.entities) as any[]).filter((e: any) => e && e.name === 'piglin_brute' && e.position && e.isValid !== false &&
      e.position.distanceTo(me) <= radius && canSeePoint(bot, e.position.offset(0, 1.2, 0))).sort((a: any, b: any) => a.position.distanceTo(me) - b.position.distanceTo(me))[0]
    if (brute) {
      const n = brute.position.floored()
      out.bastion = { seen: 1, brute: true, nearest: xyz(n), dist: Math.round(n.distanceTo(me)), bearing: bearingWords(n.x - me.x, n.z - me.z) }
    }
  }
  if (touched && !out.bastion && !out.ruins) {
    const mine = touched.filter(p => p.distanceTo(me) <= 24)
    if (mine.length >= 6) {
      const n = mine[mine.length - 1]
      out.bastion = { seen: mine.length, touched: true, nearest: xyz(n), dist: Math.round(n.distanceTo(me)), bearing: bearingWords(n.x - me.x, n.z - me.z) }
    }
  }
  if (seen.length) {
    const near = seen[0]
    out.nearest = xyz(near)
    out.dist = Math.round(near.distanceTo(me))
    out.bearing = bearingWords(near.x - me.x, near.z - me.z)
    out.spanY = [Math.min(...seen.map(p => p.y)), Math.max(...seen.map(p => p.y))]
  }
  if (spawners.length) out.spawners = spawners.map(p => ({ ...xyz(p), dist: Math.round(p.distanceTo(me)) }))
  if (blazes.length) out.blazes = { seen: blazes.length, nearest: Math.round(Math.min(...blazes.map((e : any) => e.position.distanceTo(me)))) }
  if (blazes.length) out.blazeList = blazes.map((e : any) => e.position.floored())
  return out
}

function remember (session, seenAt, what) {
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[PLACE] = { ...seenAt, dimension: 'the_nether', note: what }
  })
  session.journal.append(PLACE, what, new Vec3(seenAt.x, seenAt.y, seenAt.z))
}

// Бастионы по порядку (campaign.js BASTION_KEYS): второй увиденный — «бастион 2 (ад)», а не поверх первого (раньше новый
// затирал старый — первый, ещё не пройденный, терялся; выработанный — «находился» снова).
const BASTION_KEYS_ALL = [BASTION_PLACE, 'бастион 2 (ад)', 'бастион 3 (ад)']
// Выработан ли бастион у точки p: запись кампании «выработан: <ключ>» в 100 блоках (campaign.js readMemory).
function bastionNear (session, p, r = 96) {
  const places = (session.journal.state && session.journal.state.places) || {}
  return (Object.entries(places) as [string, any][]).some(([k, v]: any) => /бастион/.test(k) && v && worlds.worldOfRecord(v) === 'the_nether' && Math.hypot(v.x - p.x, v.z - p.z) <= r)
}
function bastionSpentNear (session, p) {
  const places = (session.journal.state && session.journal.state.places) || {}
  return (Object.entries(places) as [string, any][]).some(([k, v]: any) => /^выработан: бастион/.test(k) && v && worlds.worldOfRecord(v) === 'the_nether' && Math.hypot(v.x - p.x, v.z - p.z) <= 100)
}
// Узнать бастион издалека в момент, когда он виден (с вышки разведки обзор лучше, чем с подхода): predictGold радиусом 112
// → гипотезы старта (тип, поворот, сдвиг) — в запись бастиона; bastion() по ним сразу знает золото (p.starts).
async function recognizeFar (session, ctl) {
  try {
    // S1e: predictGold — в bastion/predict-gold (прослойка ./bastion его не отдаёт: «predictGold is not a function» в каждом прогоне
    // s1e-B0/M2 — бастион издалека не узнавался, гипотезы старта шаблона не доходили до bastion()).
    const pg = await (require('../bastion/predict-gold') as typeof import('../bastion/predict-gold')).predictGoldAsync(session.bot, 112, ctl)
    const all = pg && pg.start && pg.start.all
    if (all && all.length) { log('бастион узнан издалека', { starts: all, basalt: pg.basalt, chests: pg.chests }); return all }
  } catch (e) { if (ctl.aborted) throw e; log('бастион издалека', { error: e.message }) }
  return null
}
async function rememberBastion (session, b, ctl) {
  const places = (session.journal.state && session.journal.state.places) || {}
  if (BASTION_KEYS_ALL.some(k => places[k] && Math.hypot(places[k].x - b.nearest.x, places[k].z - b.nearest.z) < 64)) return
  if (bastionSpentNear(session, b.nearest)) return
  const key = BASTION_KEYS_ALL.find(k => !places[k])
  if (!key) return
  const note = 'похоже на бастион (блэкстоун-кирпич): пиглины и золото — бартер жемчуга (mc_pearls mode=barter), золотая броня обязательна; крепости в этом регионе нет'
  // Сперва запись места, потом узнавание шаблона: узнавание с ctl рвалось тактикой (TACTICAL) и бросало — увиденный бастион не
  // попадал в память вовсе (Codex q6: nbs13-25 21.10 — «подтвердил 40 блоков, находка не сохранилась», 20 мин поиска впустую).
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[key] = { ...b.nearest, dimension: 'the_nether', note }
  })
  session.journal.append(key, `похоже на бастион: ${b.seen} видимых блоков блэкстоун-кирпича, ближайший ${b.nearest.x},${b.nearest.y},${b.nearest.z}`, new Vec3(b.nearest.x, b.nearest.y, b.nearest.z))
  const starts = await recognizeFar(session, ctl)
  if (starts) session.journal.patch(s => { if (s.places?.[key]) s.places[key] = { ...s.places[key], starts } })
}

function rememberSpawner (session, sp) {
  const seen = session._ndSpawnerSight ||= new Set()
  const key = `${worlds.worldOf(session.bot)}:${sp.x},${sp.y},${sp.z}`
  if (!seen.has(key)) {
    const block = session.bot.blockAt?.(new Vec3(sp.x, sp.y, sp.z))
    if (block?.name === 'spawner' && seesBlock(session.bot, block)) {
      seen.add(key)
      log('спавнер: вижу', { gameMs: gameClock.now(), at: xyz(session.bot.entity.position), spawner: xyz(block.position) })
    }
  }
  const places = (session.journal.state && session.journal.state.places) || {}
  const old = places[SPAWNER_PLACE]
  if (old && old.x === sp.x && old.y === sp.y && old.z === sp.z) return
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    s.places[SPAWNER_PLACE] = { x: sp.x, y: sp.y, z: sp.z, dimension: 'the_nether', note: 'спавнер в крепости Ада (тронный зал блейзов): стоять в 16 блоках, чтобы работал' }
  })
  session.journal.append(SPAWNER_PLACE, `видел спавнер в крепости на ${sp.x},${sp.y},${sp.z}`, new Vec3(sp.x, sp.y, sp.z))
}

// Взгляд сверху (как игрок с вышки): столб до +20 (под потолком Ада не выше 118), взгляд, вниз — разбирая свой столб.
// Мост крепости (y 48–70) и вал бастиона над лавовым морем с высоты видны через полкарты, с земли — нет: на новых мирах
// 02.10 разведка 5 мин «кирпича не видно» в 4 мирах из 6 (крепость в 250–415 бл.). Только где над головой открыто ≥ 8.
async function highLook (session, ctl, glance, { up = 20, walkBlocks = null }: any = {}): Promise<{ skipped?: string; price?: any; up?: number; placed?: number; seen?: number; bastion?: boolean; v?: any; shot?: boolean }> {
  const bot = session.bot
  const { towerUp }: typeof import('../build') = require('../build')
  const base = bot.entity.position.floored()
  const priced = process.env.ND_BLZ_PRICED_LOOK === '1' && Number.isFinite(walkBlocks)
  if (priced) up = Math.min(up, 12)
  // На столбе тело не уходит и не прячется: стрелки рядом (пиглины без нашего золота — арбалеты, скелеты, ифриты, гаст) — не
  // строить (b5-5-1 14.10: столб 12 бл. у пиглинов, хп 20 → 0 за 2 с, «slain by Piglin»).
  const goldWorn = [5, 6, 7, 8].some(s => /^golden_/.test(bot.inventory.slots[s]?.name || ''))
  // Без золотой вещи открытый столб — цена выше пользы (c19-5-1, d4-5-1: вышка у портала, арбалеты, смерть на 1-й мин): обзор —
  // из устьев закрытого штрека и «пирогом» (Codex q5/q9).
  if (!goldWorn && process.env.ND_NE_COVER !== '0') return { skipped: 'без золота вышку не строю — обзор из устьев штрека' }
  const shootersNow = () => (require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot, { radius: 48 }).filter(e => e.seen && e.dist != null && (
    (e.name === 'piglin' && !goldWorn && e.dist <= 24) || (/^(skeleton|blaze|piglin_brute)$/.test(e.name) && e.dist <= 24) || (e.name === 'ghast' && e.dist <= 48)))
  const shooters = shootersNow()
  if (shooters.length && process.env.ND_TOWER_SHOOTERS !== '0') return { skipped: `стрелки рядом: ${shooters.slice(0, 3).map(e => `${e.name} ${Math.round(e.dist)}`).join(', ')}` }
  // Гаста слышно (его звук громкий — Ghast.getSoundVolume 5, сервер шлёт в 16·5 = 80 бл.; senses.heard — сторона и полоса, как
  // субтитры) — столб под ним не строить (b5-7-3 14.10: вышка y 84 → 91 сразу у портала, шары, смерть за 30 с).
  const ghastHeard = (require('../perception/senses') as typeof import('../perception/senses')).heard(bot, { sinceMs: 15000, match: /ghast/ }).length > 0
  if (!priced && ghastHeard && process.env.ND_TOWER_SHOOTERS !== '0') return { skipped: 'гаста слышно — вышку не строю' }
  let free = 0
  for (let y = 2; y <= up + 2; y++) { const b = bot.blockAt(base.offset(0, y, 0)); if (!b || b.boundingBox !== 'empty' || /lava/.test(b.name)) break; free++ }
  const n = Math.min(up, free - 1, 118 - base.y)
  if (n < 8) return { skipped: `над головой открыто ${free}` }
  let price = null
  const hp0 = bot.health ?? 20
  if (priced) {
    const filler = (require('../build') as typeof import('../build')).pickFiller(bot)
    if (!filler || filler.count < n) return { skipped: 'нет блоков на пробную вышку' }
    const Block = (require('prismarine-block') as typeof import('prismarine-block'))(bot.registry)
    const state = bot.registry.blocksByName[filler.name]?.defaultState
    const remove = state == null ? Infinity : (require('../tools') as typeof import('../tools')).bestFor(bot, Block.fromStateId(state, 0)).ms / 1000
    // Prior: towerUp ~0.7 s/block + descent dig time and 0.25 s wait. Not a measured survival probability.
    const seconds = n * (0.7 + remove + 0.25) + 1
    const configuredSpeed = Number(process.env.ND_BLZ_LOOK_WALK_SPEED ?? 2.3)
    const walkSpeed = Number.isFinite(configuredSpeed) && configuredSpeed > 0 ? configuredSpeed : 2.3
    // A heard ghast buys the cost of one aborted attempt; no invented hit probability or shield discount.
    const abortBudget = ghastHeard ? seconds : 0
    price = { blocks: n, seconds, abortBudget, walkSeconds: Math.max(0, walkBlocks) / walkSpeed, walkSpeed,
      heard: ghastHeard, hp: hp0, shieldPresent: bot.inventory.slots[45]?.name === 'shield', swatAttached: !!bot._ndSwat }
    log('вышка: цена', price)
    if (!Number.isFinite(seconds) || seconds + abortBudget >= price.walkSeconds) return { skipped: 'вышка дороже следующего хода', price }
  }
  // Стрелки показались, пока столб рос (c19-5-1: вышка 20 бл., арбалеты пиглинов сбили с верха, падение 19 бл.) — стоп и вниз,
  // как в bastion/tower-scan.ts.
  const t: any = await towerUp(bot, ctl, n, {
    sneak: true, abortIf: () => process.env.ND_TOWER_SHOOTERS !== '0' && (shootersNow().length || (!priced && (require('../perception/senses') as typeof import('../perception/senses')).heard(bot, { sinceMs: 15000, match: /ghast/ }).length) || (priced && (bot.health ?? 20) < hp0)) ? 'стрелки рядом' : null
  }).catch(e => ({ ok: false, reason: e.message }))
  const top = bot.entity.position.floored()
  const shot = !!t && (t.why || []).includes('стрелки рядом')
  const v = shot ? { seen: 0 } : await glance()
  for (let i = 0; i < n + 6 && !ctl.aborted; i++) {
    const f = bot.entity.position.floored()
    if (f.y <= base.y) break
    const below = bot.blockAt(f.offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') { await sleep(300); continue }
    try { await bot.dig(below, true) } catch { break }
    await sleep(250)
  }
  return { up: top.y - base.y, placed: t && t.placed, seen: v.seen, bastion: !!(v as any).bastion, v: shot ? undefined : v, shot: shot || undefined, ...(price ? { price } : {}) }
}

function placeOf (session, key) {
  const places = (session.journal.state && session.journal.state.places) || {}
  return places[key] || null
}

export {
  rayClear, PLACE, SPAWNER_PLACE, FORTRESS_BLOCKS, BASTION_BLOCKS, BASTION_PLACE, DIRS, WORDS, log, clamp, look, remember,
  BASTION_KEYS_ALL, bastionNear, bastionSpentNear, rememberBastion, rememberSpawner, highLook, placeOf, openDirections
}
