'use strict'
import * as gameClock from '../game-clock'
import { biomeName } from '../perception'
import { dimOf, flat, v3, count } from './common'
import { SETS, KINDS } from './kinds'

// ------------------------------------------------------------------ память

function listOf (session) {
  const s = session.journal.state
  return Array.isArray(s.structures) ? s.structures : []
}

function remember (session, d, dim) {
  const K = KINDS[d.kind]
  const list = listOf(session)
  const same = list.find(s => s.kind === d.kind && s.dim === dim && flat(s, d.at) < Math.max(24, K.r * 2))
  if (same) {
    // Центр деревни: первая запись — по краю, который увидел первым (ферма 14.10: с края explore сундуков не находил).
    // Колокол на виду — центр по нему; иначе — среднее увиденного с разных мест (вес старого — до 4 взглядов).
    const move = d.kind === 'village' && !same.bell && d.bell ? d.bell : null
    const drift = d.kind === 'village' && !same.bell && !move && flat(same, d.at) > 6
    // Раз в минуту — обновить «видел» и улики, не чаще: patch пишет файл.
    if (move || drift || gameClock.now() - (same.t || 0) > 60000 || d.evidence.some(e => !(same.ev || []).includes(e))) {
      session.journal.patch(s => {
        const r = (s.structures || []).find(x => x === same || (x.kind === same.kind && x.dim === same.dim && x.x === same.x && x.z === same.z))
        if (!r) return
        r.t = gameClock.now()
        r.ev = [...new Set([...(r.ev || []), ...d.evidence])].slice(0, 8)
        if (move) { r.x = move.x; r.y = move.y; r.z = move.z; r.bell = true }
        else if (drift) {
          const n = Math.min(4, r.n || 1)
          r.x = Math.round((r.x * n + d.at.x) / (n + 1)); r.z = Math.round((r.z * n + d.at.z) / (n + 1)); r.y = Math.round(((r.y ?? d.at.y) * n + d.at.y) / (n + 1))
          r.n = (r.n || 1) + 1
        }
      })
    }
    return { fresh: false, rec: same }
  }
  const at0 = d.bell || d.at
  const rec: any = { kind: d.kind, dim, x: at0.x, y: at0.y, z: at0.z, t: gameClock.now(), ev: d.evidence.slice(0, 8), done: false, ...(d.bell ? { bell: true } : {}) }
  session.journal.patch(s => {
    if (!Array.isArray(s.structures)) s.structures = []
    s.structures.push(rec)
    if (s.structures.length > 80) s.structures.splice(0, s.structures.length - 80)
  })
  try { session.journal.append('постройка', `${K.ru} на ${d.at.x},${d.at.y},${d.at.z} (${dim}): видел ${d.evidence.join(', ')}`, v3(d.at)) } catch {}
  try {
    const map = session.director && session.director.map
    if (map) { map.hint(dim, d.at, 'structure'); map.hint(dim, d.at, `s:${d.kind}`) }
  } catch {}
  return { fresh: true, rec }
}

function patchRec (session, rec, fn) {
  session.journal.patch(s => {
    const r = (s.structures || []).find(x => x.kind === rec.kind && x.dim === rec.dim && x.x === rec.x && x.z === rec.z)
    if (r) fn(r)
  })
}

// Запись постройки, внутри которой точка (для loot.js: «что за место»).
function recordedAt (session, pos, dim = null) {
  const d = dim || dimOf(session.bot)
  let best = null
  for (const r of listOf(session)) {
    if (r.dim !== d) continue
    const K = KINDS[r.kind]
    if (!K) continue
    const dist = flat(r, pos)
    if (dist <= Math.max(K.lootR || 0, K.r) && Math.abs((r.y ?? pos.y) - pos.y) <= 24 && (!best || dist < best.dist)) best = { rec: r, dist }
  }
  return best ? best.rec : null
}

function describe (rec, me, looted = null) {
  const K = KINDS[rec.kind] || {}
  // Узнанный шаблон: невзятые сундуки с таблицами (для цены: campaign/structure-value).
  const ex = rec.fit && rec.fit.extra
  const fit = rec.fit ? { name: rec.fit.name, chests: (rec.fit.chests || []).filter(([x, y, z]) => !looted || (!looted.has(`${x},${y},${z}`) && !looted.has(`miss:${x},${y},${z}`))).map(([x, y, z, table, p, wet]) => ({ x, y, z, table, p, wet: !!wet })), ...(ex && Number.isFinite(ex.houses) ? { houses: ex.houses, beds: ex.beds || 0, hay: ex.hay || 0 } : {}) } : undefined
  return {
    kind: rec.kind,
    name: K.ru,
    at: { x: rec.x, y: rec.y, z: rec.z },
    dim: rec.dim,
    dist: me ? Math.round(flat(me, rec)) : undefined,
    done: !!rec.done,
    evidence: rec.ev,
    prio: K.prio,
    value: K.value,
    danger: K.danger,
    note: rec.note || undefined,
    fit,
    rough: rec.rough || undefined
  }
}

function known (session, { all = false }: any = {}) {
  const bot = session.bot
  const dim = dimOf(bot)
  const me = bot.entity.position
  const looted = lootedSet(session)
  return listOf(session).filter(r => all || r.dim === dim).map(r => describe(r, r.dim === dim ? me : null, looted))
    .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9))
}

// Для session.compactState: не весь список, а счёт и ближайшие.
function compact (list) {
  if (!Array.isArray(list) || !list.length) return undefined
  const kinds = {}
  for (const r of list) kinds[r.kind] = (kinds[r.kind] || 0) + 1
  return {
    всего: list.length,
    виды: kinds,
    последние: list.slice(-4).map(r => `${(KINDS[r.kind] || {}).ru || r.kind} ${r.x},${r.y},${r.z} ${r.dim}${r.done ? ' (взято)' : ''}`),
    как: 'mc_structure mode=list — все с расстояниями; explore — зайти и взять'
  }
}

// ------------------------------------------------------------------ где искать

// Где может быть следующая постройка этого вида — по сетке регионов
// structure_set. Семя мира бот не знает (честно), поэтому точку не
// вычислить; известно другое: в каждом регионе ровно одна попытка, старт
// в окне у северо-западного угла, а регион, где такая уже найдена,
// второй не даст (у nether_complexes — ни крепости, ни бастиона).
function whereNext (session, kind, { from = null }: any = {}) {
  const K = KINDS[kind]
  if (!K) throw new Error(`не знаю постройку ${kind}; бывают: ${Object.keys(KINDS).join(', ')}`)
  const bot = session.bot
  const dim = dimOf(bot)
  const me = from || bot.entity.position
  const S = K.set ? SETS[K.set] : null
  const out: any = { kind, name: K.ru, dims: K.dim, biomes: biomesText(kind) }
  if (!K.dim.includes(dim)) out.warn = `${K.ru} бывает только в ${K.dim.join('/')}, а мы в ${dim}`
  if (!S) { out.text = `${K.ru}: регионов нет — растёт где придётся (${K.ru === 'данж' ? 'в пещерах, в любом биоме, y до 256' : 'смотри биомы'})`; return out }
  if (S.rings) { out.text = 'крепость Края — кольца (128 штук, первое кольцо 1280-2816 от центра): mc_stronghold по глазам Края'; return out }
  if (S.perChunk) {
    out.text = `${K.ru}: не регионы, а шанс ${S.perChunk * 100}% на чанк${S.at ? `; ${S.at}` : ''} — в среднем одна на ${Math.round(1 / S.perChunk)} чанков`
    if (kind === 'mineshaft') out.text += '; честно — идти пещерами/штреком на y 0..40, шахту выдают рельсы и паутина'
    return out
  }
  const span = S.spacing * 16
  const win = (S.spacing - S.separation) * 16
  const rxOf = x => Math.floor(Math.floor(x / 16) / S.spacing)
  const used = new Set()
  for (const r of listOf(session)) if (S.members.includes(r.kind) && r.dim === dim) used.add(`${rxOf(r.x)},${rxOf(r.z)}`)
  const seenChunks = (session.director && session.director.map && session.director.map.seen[dim]) || {}
  const rx0 = rxOf(me.x)
  const rz0 = rxOf(me.z)
  const cand = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const rx = rx0 + dx
      const rz = rz0 + dz
      const k = `${rx},${rz}`
      const x0 = rx * span
      const z0 = rz * span
      const cx = x0 + Math.round(win / 2)
      const cz = z0 + Math.round(win / 2)
      // Сколько чанков окна уже видели (карта директора).
      let total = 0
      let visited = 0
      for (let ix = 0; ix < S.spacing - S.separation; ix += 2) {
        for (let iz = 0; iz < S.spacing - S.separation; iz += 2) {
          total++
          if (seenChunks[`${rx * S.spacing + ix},${rz * S.spacing + iz}`]) visited++
        }
      }
      const cover = total ? visited / total : 0
      cand.push({
        region: k,
        used: used.has(k),
        window: { x0, z0, x1: x0 + win - 1, z1: z0 + win - 1 },
        x: cx,
        z: cz,
        dist: Math.round(Math.hypot(cx - me.x, cz - me.z)),
        covered: Math.round(cover * 100)
      })
    }
  }
  const open = cand.filter(c => !c.used).sort((a, b) => (a.dist * (1 + a.covered / 50)) - (b.dist * (1 + b.covered / 50)))
  out.region = `${span}×${span} блоков, старт в окне ${win}×${win} у северо-западного угла${S.triangular ? ' (ближе к середине окна)' : ''}`
  out.here = cand.find(c => c.region === `${rx0},${rz0}`)
  out.next = open.slice(0, 4)
  if (S.share) out.share = S.share
  if (S.frequency) out.chance = `попытка удаётся в ${S.frequency * 100}% регионов`
  const b = biomeName(bot, me.floored ? me.floored() : me)
  if (K.biomes && b && !/^biome#/.test(b) && !K.biomes.test(b)) out.biomeNow = `здесь ${b} — ${K.ru} тут не растёт`
  out.text = `${K.ru}: регион ${out.region}. ${out.here && out.here.used ? 'В нашем регионе уже найдена — ищи в соседних. ' : ''}` +
    (out.next.length ? `Ближайшее окно без находки: ${out.next[0].x},${out.next[0].z} (${out.next[0].dist} бл., разведано ${out.next[0].covered}%).` : '')
  return out
}

function biomesText (kind) {
  const B = {
    desert_pyramid: 'desert', jungle_pyramid: 'jungle, bamboo_jungle', igloo: 'snowy_plains, snowy_slopes, snowy_taiga',
    swamp_hut: 'swamp', village: 'plains, meadow, desert, savanna, snowy_plains, taiga',
    ruined_portal: 'почти любой (7 вариантов: обычный, пустыня, джунгли, болото, горы, океан, Ад)',
    shipwreck: 'океаны (затонувший) и пляжи (на мели)', ocean_ruin: 'океаны: холодные — камень, тёплые — песчаник',
    monument: 'глубокие океаны', mansion: 'dark_forest, pale_garden', outpost: 'plains, desert, savanna, taiga, snowy, горы, cherry_grove',
    trial_chambers: 'почти все сухопутные и океаны, под землёй y -40..-20', ancient_city: 'deep_dark (под горами, y ≈ -52)',
    mineshaft: 'почти везде под землёй; в бесплодных землях — открытые, на поверхности', buried_treasure: 'beach, snowy_beach',
    fortress: 'все биомы Ада', bastion: 'все биомы Ада, кроме базальтовых дельт', end_city: 'end_highlands, end_midlands (внешние острова)',
    trail_ruins: 'тайга, старые леса, джунгли', dungeon: 'любой, под землёй', stronghold: 'любой, кольца от 0,0'
  }
  return B[kind]
}

// Что рядом стоит крюка (для директора): известные невзятые постройки этого
// измерения по пользе сейчас и расстоянию.
function opportunities (session, { radius = 192 }: any = {}) {
  const bot = session.bot
  const me = bot.entity.position
  const dim = dimOf(bot)
  const obsidian = count(bot, 'obsidian')
  const hasDiamondPick = count(bot, /^(diamond|netherite)_pickaxe$/) > 0
  const beds = count(bot, /_bed$/)
  const out = []
  for (const r of listOf(session)) {
    if (r.dim !== dim || r.done) continue
    const K = KINDS[r.kind]
    if (!K || K.handler === 'avoid') continue
    const dist = Math.round(flat(me, r))
    if (dist > radius) continue
    let prio = K.prio
    let why = K.value
    if (r.kind === 'ruined_portal' && !hasDiamondPick && obsidian < 10) { prio = 4; why = `обсидиан без алмазной кирки: в сундуке и рамке (есть ${obsidian} из 10) + огниво` }
    if (r.kind === 'village' && beds < 3) { prio = 4; why = `кровати (есть ${beds}, на дракона нужно 3+), еда, железо` }
    if (r.kind === 'end_city' && count(bot, 'elytra') === 0) { prio = 3; why = 'элитры на корабле' }
    const limit = prio >= 4 ? 192 : prio === 3 ? 160 : prio === 2 ? 96 : 40
    if (dist > limit) continue
    out.push({ ...describe(r, me), prio, why })
  }
  return out.sort((a, b) => b.prio - a.prio || a.dist - b.dist)
}

// ------------------------------------------------------------------ лут

function lootedSet (session) {
  const s = session.journal.state
  return new Set(Array.isArray(s.looted) ? s.looted : [])
}

function markLooted (session, key) {
  session.journal.patch(s => {
    if (!s.looted) s.looted = []
    if (!s.looted.includes(key)) s.looted.push(key)
    if (s.looted.length > 500) s.looted.splice(0, s.looted.length - 500)
  })
}

// Карты сокровищ в рюкзаке → клад в память построек (крестик и своя метка — treasure-map). Вне карты — место примерное
// (rough): уточнится, когда тело войдёт в карту. [{ x, z, rough, id }]
function readTreasureMaps (session) {
  const bot = session.bot
  if (!bot || !bot.inventory || dimOf(bot) !== 'overworld') return []
  const tm: typeof import('../treasure-map') = require('../treasure-map')
  const out = []
  for (const m of tm.read(bot)) {
    const at = Number.isFinite(m.x) ? { x: m.x, z: m.z } : m.toward
    if (!at) continue
    const rough = !Number.isFinite(m.x)
    const same = listOf(session).find(r => r.kind === 'buried_treasure' && r.map === m.id)
    if (same) {
      if (same.rough && (same.x !== at.x || same.z !== at.z || !rough)) patchRec(session, same, r => { r.x = at.x; r.z = at.z; r.rough = rough })
    } else {
      const r = remember(session, { kind: 'buried_treasure', at: { x: at.x, y: 62, z: at.z }, evidence: [rough ? 'карта сокровищ (я вне карты — место примерно)' : 'карта сокровищ'] }, 'overworld')
      patchRec(session, r.rec, x => { x.map = m.id; x.rough = rough })
    }
    out.push({ ...at, rough, id: m.id })
  }
  return out
}

export {
  listOf, remember, patchRec, recordedAt, known, compact, whereNext, opportunities, lootedSet, markLooted,
  readTreasureMaps
}
