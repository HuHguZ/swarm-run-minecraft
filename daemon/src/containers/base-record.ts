'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// ------------------------------------------------------------------- base

// A base is not a building. It is one record in memory plus the operations
// that keep that record true. The brain thinks once every 10-30 seconds, so
// "сходи посмотри, что в общаке" spends a whole turn on a fact the bot already
// had in its hands when it closed the lid. Hence the cache below: written by
// the same three calls that change a shelf, read back without moving the body.
//
// The record lives in state.places under one name, in the shape mc_remember
// and mc_recall already use — {x,y,z,note} plus our own keys. Nothing else had
// to be taught anything: mc_recall dumps places whole, so the base and what is
// in it survive a daemon restart and a context compaction for free.

const BASE = 'база'

// A shelf farther than this from the centre belongs to a base that has since
// moved: mc_remember place=база rewrites x/y/z and leaves our keys alone, and
// a chest three hundred blocks back would otherwise stay on the list forever.
const STASH_RADIUS = 24

// Past this the walk home is its own intent with its own budget. A stash call
// gets 90s; two hundred blocks of walking eat all of it and answer nothing.
const STASH_WALK = 48

// Chunks stream in behind the body. blockAt over an unloaded chunk answers
// null, and reading that as "сундук сломали" is the worst possible lie to tell
// about somebody's stash.
const LOAD_MS = 5000

// ---------------------------------------------------------------- record

const iso = () => new Date().toISOString()
const minutesSince = s => {
  const t = Date.parse(s || '')
  return Number.isFinite(t) ? Math.max(0, Math.round((gameClock.wall.now() - t) / 60000)) : null
}
const samePos = (c, p) => c.x === p.x && c.y === p.y && c.z === p.z

function placesOf (session) {
  return (session.journal.state && session.journal.state.places) || {}
}

// A place is a base if it carries a stash list. That is also what survives
// mc_remember: rewriting the note by hand keeps the array, and if somebody
// wipes it the record simply reads as "база без общака" and the next put
// adopts or builds one.
function baseNames (session) {
  const places = placesOf(session)
  return Object.keys(places).filter(n => n === BASE || Array.isArray(places[n].chests))
}

function readBase (session, name = BASE) {
  const rec = placesOf(session)[name]
  if (!rec || !Number.isFinite(rec.x) || !Number.isFinite(rec.y) || !Number.isFinite(rec.z)) return null
  const centre = new Vec3(rec.x, rec.y, rec.z)
  const chests = (Array.isArray(rec.chests) ? rec.chests : [])
    .filter(c => c && Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z))
    .filter(c => centre.distanceTo(new Vec3(c.x, c.y, c.z)) <= STASH_RADIUS)
  return { ...rec, name, chests, centre }
}

// The note is the one field the rest of the system already reads (mc_recall
// prints it, the journal quotes it), so it is regenerated on every write and
// stays one line.
function baseNote (rec) {
  const alive = (Array.isArray(rec.chests) ? rec.chests : []).filter(c => !c.gone)
  const bits = [alive.length ? `общак: ${alive.length} шт` : 'общака нет']
  if (rec.furnace) bits.push('печь')
  if (rec.table) bits.push('верстак')
  if (rec.sky === false) bits.push('под землёй')
  if (rec.why) bits.push(rec.why)
  return bits.join('; ')
}

function patchBase (session, name, fn) {
  let out = null
  session.journal.patch(s => {
    if (!s.places) s.places = {}
    const rec = Object.assign({}, s.places[name] || {})
    fn(rec)
    rec.note = baseNote(rec)
    s.places[name] = rec
    out = rec
  })
  return out
}

function rememberChest (session, name, block, facts: any = {}) {
  const p = block.position
  patchBase(session, name, r => {
    const list = Array.isArray(r.chests) ? r.chests.slice() : []
    const j = list.findIndex(c => samePos(c, p))
    const was = j >= 0 ? list[j] : {}
    const entry = { ...was, x: p.x, y: p.y, z: p.z, kind: block.name, ...facts, seenAt: iso(), gone: false }
    if (j >= 0) list[j] = entry
    else list.push(entry)
    // Six shelves is more than a player keeps at one base, and the whole list
    // is dumped on every mc_recall.
    r.chests = list.slice(-6)
  })
}

function markChest (session, name, pos, patch) {
  patchBase(session, name, r => {
    const list = Array.isArray(r.chests) ? r.chests.slice() : []
    const j = list.findIndex(c => samePos(c, pos))
    if (j < 0) return
    list[j] = { ...list[j], ...patch }
    r.chests = list
  })
}

// Called from the three chest actions while the shelf is still open in front
// of the bot. This is the whole trick behind `stash mode=list`: the cache is
// never separately fetched, it is a by-product of the work that changed it.
function touchChest (session, block, facts) {
  try {
    for (const name of baseNames(session)) {
      const rec = readBase(session, name)
      if (!rec || !rec.chests.some(c => samePos(c, block.position))) continue
      rememberChest(session, name, block, facts)
      return name
    }
  } catch {}
  return null
}

function stashTotals (rec) {
  const total = {}
  for (const c of rec.chests) {
    if (c.gone || !c.contents) continue
    for (const [n, k] of (Object.entries(c.contents) as [string, any][])) total[n] = (total[n] || 0) + k
  }
  return total
}

function chestView (c) {
  return {
    at: { x: c.x, y: c.y, z: c.z },
    kind: c.kind || 'chest',
    free: c.free,
    slots: c.slots,
    contents: c.contents || {},
    seenMinutesAgo: minutesSince(c.seenAt),
    gone: c.gone || undefined
  }
}

const aliveChests = rec => rec.chests.filter(c => !c.gone)
const freeSlots = rec => aliveChests(rec).reduce((n, c) => n + (c.free || 0), 0)
const stalest = rec => aliveChests(rec).reduce((m, c) => {
  const s = minutesSince(c.seenAt)
  return s === null ? m : Math.max(m, s)
}, 0)

export {
  BASE, STASH_WALK, LOAD_MS, iso, readBase, patchBase, rememberChest, markChest, touchChest, stashTotals,
  chestView, aliveChests, freeSlots, stalest
}
