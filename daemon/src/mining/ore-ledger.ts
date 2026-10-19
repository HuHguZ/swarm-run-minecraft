'use strict'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { FACES } from '../build'
import { at, isLava, isWater } from './dig-core'

// Where the fair-play line runs, stated once because this is the exact edge
// the project cares about:
//
//   a block with a face on a cell we have just emptied is a block a player
//   standing in this corridor is looking at — recording it is honest;
//   a block still sealed in stone is not ours to know, however plainly
//   findBlocks reads it out of chunk memory.
//
// So the walls are written down at the moment they are opened. canSeeBlock
// only ever answers from where the body is standing *now*, and by the end of a
// run the first walls are behind it — that is how the iron two blocks into the
// drift went unreported while the coal near the face did not. This pass does
// not raycast at all: it does not have to, the wall is open by construction.
function noteExposedOre (bot, oreSet, cell, height, seen, groups, why) {
  for (let h = 0; h < height; h++) {
    const pos = cell.offset(0, h, 0)
    const air = bot.blockAt(pos)
    // A column the server refused to break is still stone, and everything
    // around it is still buried — nothing there is ours to report. Lava and
    // water count as 'empty' too, and those cells are exactly the ones we
    // turned back from: their walls were never opened and are not ours either.
    if (!air || air.boundingBox !== 'empty' || isLava(air) || isWater(air)) continue
    for (const face of FACES) {
      const block = bot.blockAt(pos.plus(face))
      if (!block || !oreSet.has(block.type)) continue
      const p = block.position
      const key = `${p.x},${p.y},${p.z}`
      if (seen.has(key)) continue
      seen.add(key)
      // Which claim this spot rests on. The wall of our own drift is open by
      // construction and stays true until something changes it; a raycast is
      // true about a moment. rememberOre keeps the difference so the brain can
      // read it back weeks later.
      if (why) why.set(key, 'стена штрека')
      const g = groups.get(block.name)
      if (g) g.push(p)
      else groups.set(block.name, [p])
    }
  }
}

// The other half of the report: ore that is further off but genuinely in view —
// across a cave the corridor broke into, say. noteExposedOre cannot see that,
// and line of sight is the whole point here, so this one does raycast. Asked
// every step rather than once at the end, because by the end the near walls are
// behind us and out of sight.
// Positions are kept, not distances: the bot moves a block between scans, and
// a "nearest" built from distances measured at four different standing spots
// points at the wrong ore. Ranking happens once, at the end, from where the
// body actually ended up.
function scanOres (bot, ids, useFair, seen, groups, radius, why) {
  let found = []
  try {
    found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 48 })
  } catch {
    return
  }
  for (const pos of found) {
    const key = `${pos.x},${pos.y},${pos.z}`
    if (seen.has(key)) continue
    try {
      const block = bot.blockAt(pos)
      if (!block) continue
      // findBlocks reads the chunk straight out of memory; this line is the
      // whole fog of war for the ore report.
      if (useFair && !bot.canSeeBlock(block)) continue
      seen.add(key)
      if (why) why.set(key, 'в прямой видимости')
      const g = groups.get(block.name)
      if (g) g.push(pos)
      else groups.set(block.name, [pos])
    } catch {
      // canSeeBlock raycasts and can throw on a chunk that is going away. One
      // unreadable block must not cost us the scan, let alone the tunnel.
    }
  }
}


// ---------------------------------------------------------------- ore memory

// Where the drift's ore report used to end: inside one tool result, which the
// next context compaction threw away. The y=-59 run is the whole argument. The
// drift answered
//     deepslate_diamond_ore x2, nearest 139,-57,159, fromMouth 16.1
// and four drifts later `mine deepslate_diamond_ore` answered
//     не вижу deepslate_diamond_ore в радиусе 24
//     (смотрю честно, только по прямой видимости)
// Both halves are correct on their own terms — the drift reported a wall it had
// personally opened, mine re-derived visibility from where the body was now
// standing — and between them they lost the diamonds while the coordinates sat
// in the brain's own context.
//
// Fair play (config.fairPlay) does not say "only what is in front of the eyes
// right now". It says only what a person could know, and a person who saw
// diamonds in the wall of their own drift remembers where they are and walks
// back for them. Forgotten ore is knowledge, not x-ray. So the ledger is
// allowed, and it is fenced by the same two rules the report already obeys:
//
//   written — only from a face opened onto a cell we emptied (noteExposedOre)
//             or from a raycast that actually reached the block (scanOres).
//             Never from findBlocks alone: that is the fog of war and it stays
//             exactly where it was.
//   read    — only a coordinate already in this ledger is actionable. One the
//             brain invents is refused however plainly the chunk reads out
//             underneath it. That refusal IS the x-ray guard, and try-ore case
//             (г) measures it: a real diamond block the bot never saw, still in
//             the wall after the call.
//
// And the third rule, which keeps memory from turning into a lie: memory is
// never reported as sight. The block is re-read on arrival, from within reach,
// and «помню» and «вижу» stay different words in the answer — the vein can be
// gone (a cave-in, another player, lava), and "добыл" for a block that is not
// there costs more than saying nothing.

// Capped on the way in. The deaths list in memory/state.json grew without a
// bound until compactState had to be written to stop it eating the answer;
// this one does not get to repeat that.
const LEDGER_MAX = 120
// How far off a remembered coordinate a request may land and still mean it.
// One block: a brain copying coordinates out of a drift report is exact, and a
// brain that is one out meant the block it can name. Two would start being a
// search, and a search through stone is the x-ray we are avoiding.
const SNAP = 1
// Where memory is allowed to become sight. Within five blocks the wall is
// simply in front of the body — the same "open by construction" the drift's own
// report leans on. Reading blockAt from forty blocks away is reading the chunk
// out of client memory, which is precisely what fairPlay forbids.
const VERIFY_RANGE = 5
// A walk this long is not a detour, it is a trip, and it should be the brain's
// decision (mc_goto) rather than a surprise inside a mining call.
const MAX_TRIP = 200

const posKey = p => `${p.x},${p.y},${p.z}`
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 16)

function ledgerOf (session) {
  const s = session.journal.state
  // EMPTY_STATE in journal.js predates this key, and loadState() merges the
  // file over the template — so in a memory written before today the key is
  // simply absent rather than empty.
  if (!Array.isArray(s.ore)) s.ore = []
  return s.ore
}

// One row per block, never per vein: four rows is four coordinates the brain
// can hand back one at a time. `why` is kept because "стена штрека" (opened by
// us, certain) and "в прямой видимости" (a raycast across a cave, and whatever
// was in the way can move) are different degrees of the same claim.
function rememberOre (session, spots) {
  if (!spots || !spots.length) return 0
  let added = 0
  session.journal.patch(s => {
    if (!Array.isArray(s.ore)) s.ore = []
    const have = new Set(s.ore.map(posKey))
    for (const spot of spots) {
      if (have.has(posKey(spot))) continue
      have.add(posKey(spot))
      s.ore.push(spot)
      added++
    }
    if (s.ore.length > LEDGER_MAX) s.ore.splice(0, s.ore.length - LEDGER_MAX)
  })
  return added
}

// Struck off the moment the world disagrees — whether we took the block or
// found the square bare. A ledger that keeps offering a coordinate the body has
// already stood on and found empty is worse than no ledger.
function forgetOre (session, positions) {
  if (!positions.length) return
  const gone = new Set(positions.map(posKey))
  session.journal.patch(s => {
    if (Array.isArray(s.ore)) s.ore = s.ore.filter(r => !gone.has(posKey(r)))
  })
}

// What the bot remembers, and nothing else: this never touches the world. It is
// tempting to blockAt() every row and mark the stale ones, and that is exactly
// the x-ray — freshness is only ever established by walking there, which is why
// every row goes out with the warning attached.
function recallOre (session, { block = null, limit = 12 }: any = {}) {
  const bot = session.bot
  const me = bot && bot.entity ? bot.entity.position : null
  const want = block ? String(block).trim().toLowerCase() : null
  let rows = ledgerOf(session)
  if (want && want !== 'any_ore') {
    rows = rows.filter(r => r.name === want || r.name.includes(want) || want.includes(r.name))
  }
  const spots = rows.map(r => ({
    name: r.name,
    at: { x: r.x, y: r.y, z: r.z },
    seen: r.seen,
    why: r.why,
    fromMe: me ? Math.round(Math.hypot(r.x - me.x, r.y - me.y, r.z - me.z) * 10) / 10 : undefined
  })).sort((a, b) => (a.fromMe ?? 0) - (b.fromMe ?? 0))

  const kinds = {}
  for (const r of rows) kinds[r.name] = (kinds[r.name] || 0) + 1
  return {
    remembered: rows.length,
    kinds,
    spots: spots.slice(0, limit),
    note: rows.length
      ? 'это память, а не зрение: блока может уже не быть — проверю на месте и скажу честно'
      : 'руды не помню вообще — копай штрек (mc_tunnel), он записывает стены в момент вскрытия'
  }
}

// The refusal has to be actionable or it is a hang. "не помню" on its own sends
// the brain round the same call; the y=-51 log is four turns of exactly that.
function noSuchMemory (session, asked, name) {
  const mem = recallOre(session, {})
  const kinds = (Object.entries(mem.kinds) as [string, any][]).map(([n, c]) => `${n}x${c}`).join(', ')
  const what = asked ? `на ${at(asked)}` : `${name || 'такой руды'} нигде`
  const known = mem.remembered
    ? `Помню: ${kinds}; ближайшая ${mem.spots[0].name} на ${at(mem.spots[0].at)} (${mem.spots[0].fromMe} от меня) — зови с этими координатами. `
    : 'Не помню пока ничего. '
  return new Error(
    `не помню руды ${what} — я её не видел, а сквозь камень не смотрю. ${known}` +
    'Чтобы было что добывать: копай штрек (mc_tunnel) на глубине от -59 до -54, ' +
    'он записывает руду в момент вскрытия стены и отдаёт координаты в ores — с ними и зови.'
  )
}

// Exact hit first, then one block of slack, and never a search: the rows are
// the only candidates that exist, so the worst this can do is aim at something
// the bot has already seen.
function pickTarget (session, asked, name) {
  const rows = ledgerOf(session)
  if (!rows.length) return null
  if (asked) {
    const p = { x: Math.floor(asked.x), y: Math.floor(asked.y), z: Math.floor(asked.z) }
    const exact = rows.find(r => r.x === p.x && r.y === p.y && r.z === p.z)
    if (exact) return { row: exact, asked: p, snapped: false }
    const near = rows
      .filter(r => Math.max(Math.abs(r.x - p.x), Math.abs(r.y - p.y), Math.abs(r.z - p.z)) <= SNAP)
      .sort((a, b) =>
        (Math.abs(a.x - p.x) + Math.abs(a.y - p.y) + Math.abs(a.z - p.z)) -
        (Math.abs(b.x - p.x) + Math.abs(b.y - p.y) + Math.abs(b.z - p.z)))[0]
    return near ? { row: near, asked: p, snapped: true } : null
  }
  const want = name ? String(name).trim().toLowerCase() : null
  const me = session.bot.entity.position
  const fit = rows
    .filter(r => !want || want === 'any_ore' || r.name === want || r.name.includes(want) || want.includes(r.name))
    .sort((a, b) =>
      Math.hypot(a.x - me.x, a.y - me.y, a.z - me.z) - Math.hypot(b.x - me.x, b.y - me.y, b.z - me.z))
  return fit.length ? { row: fit[0], asked: null, snapped: false } : null
}

// The moment memory meets sight, and the only place in this file where a
// remembered coordinate is allowed to become a fact. The body is within reach
// of a square it has been carrying since some earlier drift, so for the first
// time the block can honestly be looked at.
//
// Four answers, and «далеко» is the one that makes the other three legal.
// blockAt on a coordinate forty blocks away reads the chunk straight out of
// client memory — that is precisely the x-ray fairPlay forbids, and it is the
// same call findBlocks makes that the fog of war exists to filter. So outside
// VERIFY_RANGE this refuses to look at all and concludes nothing: the freshness
// of a row is established by walking there, never by asking from the mouth of
// the corridor.
//
// «не прогружено» is deliberately not folded into «нет». An unloaded chunk is
// the absence of knowledge, and answering «нет» to it would strike a live vein
// off the ledger for good on the strength of a packet that had not arrived.
function verify (bot, row) {
  const pos = new Vec3(row.x, row.y, row.z)
  const gap = bot.entity.position.distanceTo(pos)
  if (gap > VERIFY_RANGE) return { state: 'далеко', gap: Math.round(gap * 10) / 10 }
  const b = bot.blockAt(pos)
  if (!b) return { state: 'не прогружено' }
  if (b.name === row.name) return { state: 'на месте', block: b }
  return { state: 'нет', found: b.name, block: b }
}

export {
  noteExposedOre, scanOres, VERIFY_RANGE, MAX_TRIP, posKey, stamp, ledgerOf, rememberOre, forgetOre, recallOre,
  noSuchMemory, pickTarget, verify
}
