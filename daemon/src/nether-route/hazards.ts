'use strict'
// Ход по сетке Ада (nether-route.ts): место в рюкзаке, лава, бруты и спавнеры, зоны бастиона, золотые кирки.
import { Vec3 } from 'vec3'
import * as gameClock from '../game-clock'
import { log, sleep, xyz } from './base'


// Место в рюкзаке: копка по Аду набивает его незераком (сотни), и стержни/золото потом не подбираются — рюкзак полон
// (neF-B16f21 03.10: стержень в 0.95 бл. от ног лежит, 79 взмахов и 0 стержней). Лишнее (сверх запаса bastion
// JUNK_KEEP) — бросить назад, за спину (вперёд — тело само подберёт снова).
export async function makeRoom (bot, want = 5) {
  if (bot.inventory.emptySlotCount() >= want) return 0
  const yaw0 = bot.entity.yaw; const pitch0 = bot.entity.pitch
  let tossed = []
  try {
    await bot.look(yaw0 + Math.PI, 0.3, true).catch(() => {})
    // Свой запас: незерак (мосты, заделка) — 64, гравий/песок душ/кирпич/кварц — прочь; чернокамень и булыжник — НЕ
    // трогать: из них каменные кирки (D5-31 03.10: у спавнера ни одной кирки — булыжник ушёл на кирки и мосты, чернокамень
    // выброшен как лишний, «бой у спавнера: не хватает кирки»).
    // Незерак — 128 (B2-3 03.10: заделка штрека съела 64, коробке стража блоков не осталось — «нечем», смерть).
    const KEEP = { netherrack: 128, gravel: 0, soul_sand: 0, soul_soil: 0, nether_brick: 0, quartz: 0, dried_ghast: 0, basalt: 16, polished_blackstone_bricks: 0, cracked_polished_blackstone_bricks: 0, magma_block: 0, crimson_nylium: 0, warped_nylium: 0, glowstone_dust: 0, crying_obsidian: 4, leather: 0, magma_cream: 0, iron_nugget: 64, glass_bottle: 0, bone: 0 }
    for (const [name, keep] of (Object.entries(KEEP) as [string, any][])) {
      let have = bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0)
      if (have <= keep) continue
      for (const it of bot.inventory.items().filter(i => i.name === name).sort((a, c) => a.count - c.count)) {
        if (have - it.count < keep) break
        try { await bot.tossStack(it); have -= it.count; tossed.push(`${name}×${it.count}`) } catch {}
      }
    }
    if (bot.inventory.emptySlotCount() < Math.min(3, want)) { try { await (require('../pack') as typeof import('../pack')).makeRoom(bot, { slots: Math.min(3, want) }) } catch {} }
  } finally { await bot.look(yaw0, pitch0, true).catch(() => {}) }
  if (tossed.length) log('рюкзак: выбросил', { tossed, free: bot.inventory.emptySlotCount() })
  return tossed.length
}

// Тело в лаве (сорвалось с моста над лавовым морем — B12f22 03.10; под огнестойкостью живо): плыть к ближнему берегу —
// клетка в 10 бл., где пол твёрдый, а ноги и голова свободны; прыжок+вперёд, пока не на твёрдом.
export function inLava (bot) {
  if (bot.entity && bot.entity.isInLava) return true
  const p = bot.entity.position
  for (const x of new Set([Math.floor(p.x - 0.3), Math.floor(p.x + 0.3)])) {
    for (const z of new Set([Math.floor(p.z - 0.3), Math.floor(p.z + 0.3)])) {
      for (const y of new Set([Math.floor(p.y), Math.floor(p.y + 1)])) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && /lava/.test(b.name)) return true }
    }
  }
  return false
}
export async function lavaSwim (bot, ctl, st) {
  if (!inLava(bot)) return false
  const f = bot.entity.position.floored()
  let best = null
  for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) for (let dy = -2; dy <= 3; dy++) {
    const c = f.offset(dx, dy, dz)
    const a = bot.blockAt(c); const b = bot.blockAt(c.offset(0, 1, 0)); const u = bot.blockAt(c.offset(0, -1, 0))
    if (!a || !b || !u) continue
    if (a.boundingBox !== 'empty' || b.boundingBox !== 'empty' || /lava|fire|nether_portal/.test(a.name + b.name)) continue
    if (u.boundingBox !== 'block' || /magma/.test(u.name)) continue
    // Без лавы рядом по горизонтали — рамка тела (±0.3) иначе в ней (D6-32 03.10: «выбрался» в портал рядом с лавой).
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => [0, 1].some(y => { const q = bot.blockAt(c.offset(x, y, z)); return q && q.name === 'lava' }))) continue
    const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5
    if (!best || d < best.d) best = { c, d }
  }
  if (!best) return false
  st.swims = (st.swims || 0) + 1
  const t0 = gameClock.now()
  try {
    // Из лавы — всегда до конца, и при оборванном ходе: обёртка lavaWatched (bastion) рвёт ход именно на лаве, и выход
    // обрывался за 0.1 с, а потом 5 с считался план — тело горело (VR22-1 03.10: смерть на 14-й с после входа в Ад).
    while (gameClock.now() - t0 < 9000) {
      const p = bot.entity.position
      await bot.lookAt(new Vec3(best.c.x + 0.5, p.y + 1.2, best.c.z + 0.5), true).catch(() => {})
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await sleep(80)
      if (!inLava(bot) && bot.entity.onGround) break
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
  log('из лавы', { to: xyz(best.c), ok: !inLava(bot), s: Math.round((gameClock.now() - t0) / 100) / 10, hp: Math.round(bot.health ?? 0) })
  return !inLava(bot)
}

// Коробки известного золота бастионов (память тела: «бастион (ад)» … gold) ± 12 — зоны, где открытое втридорога: путь
// из бастиона к крепости шёл по двору — брут (neF-C124-1 03.10: «slain by Piglin Brute» на 6-м шаге хода).
export function bruteSpots (session) {
  try {
    const places = (session.journal && session.journal.state && session.journal.state.places) || {}
    const out = []
    for (const [k, v] of ((Object.entries(places) as [string, any][]) as any)) if (/бастион/.test(k) && v && Array.isArray(v.brutes)) for (const b of v.brutes) if (Array.isArray(b) && b.length === 3) out.push(b)
    return out
  } catch { return [] }
}
// ND_SPAWNER_HOT=1: спавнер блейзов из памяти — уходя от него (цель дальше 30) без огнестойкости, открытое в ±14 (−4..+10)
// +6 за шаг: штреком в толще, а не коридором под шарами (D7-32 03.10: 11 очей на 20-й мин, на 36-м шаге хода от
// спавнера «fireballed by Blaze»).
// Кирок никаких, камня на каменные нет — золотые из слитков (3 слитка + 2 палки; копает незерак и кирпич, 32 копки,
// быстрее железной): D6-23 03.10 — 13 слитков в рюкзаке, «для ифритов не хватает кирки — домой», 20 мин ходу назад.
export async function goldPicks (session, ctl, want = 2) {
  const bot = session.bot
  const A: typeof import('../actions') = require('../actions')
  const has = n => bot.inventory.items().filter(i => i.name === n).reduce((k, i) => k + i.count, 0)
  let made = 0
  try {
    for (let k = 0; k < want && has('gold_ingot') >= 3 && !ctl.aborted; k++) {
      if (has('stick') < 2 && bot.inventory.items().some(i => /_planks$/.test(i.name))) await A.craft(session, ctl, { item: 'stick', count: 4 })
      if (has('stick') < 2) break
      const n0 = has('golden_pickaxe')
      await A.craft(session, ctl, { item: 'golden_pickaxe', count: 1 })
      if (has('golden_pickaxe') <= n0) break
      made++
    }
  } catch (e) { log('кирки: золотые не вышло', { error: e.message }) }
  return made
}
export function spawnerHot (session, goal, fireproof) {
  if (process.env.ND_SPAWNER_HOT !== '1' || fireproof) return []
  try {
    const places = (session.journal && session.journal.state && session.journal.state.places) || {}
    const out = []
    for (const [k, v] of ((Object.entries(places) as [string, any][]) as any)) {
      if (!/спавнер блейзов/.test(k) || !v || typeof v.x !== 'number') continue
      if (v.dimension && v.dimension !== 'the_nether') continue
      if (Math.hypot(goal.x - v.x, goal.z - v.z) < 30) continue
      out.push([v.x - 14, v.y - 4, v.z - 14, v.x + 14, v.y + 10, v.z + 14, 6])
    }
    return out
  } catch { return [] }
}
// Места брутов из копии мира + (ND_GUARD=1) живые бруты/хоглины рядом: открытое в 12 бл. от живого +40 за шаг (ревью Codex
// ne-deaths.md №1: штраф +10 A* брал, если обход дороже; 12 смертей от брутов на открытом ходе).
export function liveDangers (session) {
  if (process.env.ND_BRUTE_MEMORY === '1') {
    const memory: typeof import('../brute-memory') = require('../brute-memory')
    const bot = session.bot
    memory.install(bot)
    const out = memory.routeZones(bot)
    // In the blind mode neither copy-world brutes nor hidden live mobs are facts.
    try { for (const e of (require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot, { radius: 64, rememberMs: 0, hearMs: 0 })) {
      if (e.seen && /^(hoglin|zoglin)$/.test(e.name || '') && e.pos) out.push([e.pos.x, e.pos.y, e.pos.z, 40])
    } } catch {}
    return out
  }
  // Дом брута из копии — +30 за открытый шаг в 12 бл. (было 10: s1d-F22b-3 — подход к гуще золота −7739… прошёл мимо брута, смерть на 2.4 мин).
  const out = bruteSpots(session).map(b => [b[0], b[1], b[2], 30])
  if (process.env.ND_GUARD === '0') return out
  const bot = session.bot
  try {
    for (const e of ((Object.values(bot.entities || {}) as any[]) as any)) {
      if (!e || !e.position || e.isValid === false || !/^(piglin_brute|hoglin|zoglin)$/.test(e.name || '')) continue
      if (e.position.distanceTo(bot.entity.position) > 64) continue
      out.push([Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z), 40])
    }
  } catch {}
  return out
}
export function bastionZones (session) {
  try {
    const places = (session.journal && session.journal.state && session.journal.state.places) || {}
    const out = []
    for (const [k, v] of ((Object.entries(places) as [string, any][]) as any)) {
      if (!/бастион/.test(k) || !v) continue
      if (v.dimension && v.dimension !== 'the_nether') continue
      // Коробка бастиона по кускам (карта) ± 16 — двор, мосты, хоглины и бруты вокруг (D1-26 03.10: брут в 20 бл. от
      // золота, на багровом нилии у бастиона).
      if (Array.isArray(v.bb) && v.bb.length === 6) { out.push([v.bb[0] - 16, v.bb[1] - 4, v.bb[2] - 16, v.bb[3] + 16, v.bb[4] + 8, v.bb[5] + 16]); continue }
      if (!Array.isArray(v.gold) || !v.gold.length) continue
      const xs = v.gold.map(q => q[0]); const ys = v.gold.map(q => q[1]); const zs = v.gold.map(q => q[2])
      out.push([Math.min(...xs) - 12, Math.min(...ys) - 6, Math.min(...zs) - 12, Math.max(...xs) + 12, Math.max(...ys) + 8, Math.max(...zs) + 12])
    }
    return out
  } catch { return [] }
}
