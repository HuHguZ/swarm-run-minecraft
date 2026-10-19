'use strict'
// Набор на портал: литьё для набора, вода рядом, кремень.
import { OW_HEAR } from './flags'
import { strategyInterrupted, state, sit, died, known, stairEntrance, waterSearchFailedView, waterSearchView,
  surfaceShaft, knownWater, setKnownWater, setWaterSearchView } from './state'
import { log } from './log'
import { have, y, dim, portalFar, portalBuckets } from './queries'
import { refresh } from './observe'
import { act } from './act'
import { craft, smeltAll } from './kit'
import { structureValue } from './scout'
import { graphFact, intelligence } from './strategy-bridge'
import * as gameClock from '../src/game-clock'
let castKitSupplyFailure = ''
// A carried second bucket costs no extra iron; it can rescue a shore the one-bucket geometry cannot use.
async function castForKit (params) {
  const one = portalBuckets() === 1
  const r = await act('portal', { ...params, ...(one ? { one: true, hint: undefined } : {}) })
  if (process.env.ND_OW_KIT_FRAME !== '0' && one && r.status !== 'interrupted' && !died && !strategyInterrupted &&
      /места на берегу нет|лавы со столба не достать|лавы в досягаемости нет/.test(String(r.detail?.stopped || ''))) {
    const supplyKey = () => JSON.stringify([state.pos, have('iron_ingot'), have('raw_iron'), have(/bucket$/), r.detail?.site, r.detail?.stopped])
    if (have(/bucket$/) < 2 && castKitSupplyFailure !== supplyKey()) {
      const s = await intelligence.environment.observe()
      const scout = intelligence.registry.get('ScoutLava'), iron = intelligence.registry.get('MineIron')
      const bars = Math.max(0, 3 - have('iron_ingot')), ore = Math.max(0, bars - have('raw_iron'))
      const second = 20 + bars * 10 + ore * structureValue.SECONDS.iron + (ore ? iron.estimateRisk(s) * 3600 : 0)
      const top = stairEntrance?.y ?? surfaceShaft?.top ?? y()
      // shortcut: shaft receipts give about 2 s/block; replace with measured route ETA after paired scenes.
      const exit = sit.surface ? 0 : Math.max(0, top - y()) * 2
      const search = scout.estimateCost(s) / 20 + scout.estimateRisk(s) * 3600 + exit
      log(`литьё: второе ведро ≈ ${Math.round(second)} с, новая разведка ≈ ${Math.round(search)} с`)
      if (second < search) {
        if (ore) {
          const mined = await act('mine', { block: 'iron_ore,deepslate_iron_ore', count: ore, radius: 16, dry: true, timeoutSeconds: 45 })
          if (mined.status === 'interrupted' || died || strategyInterrupted) return mined
        }
        if (have('iron_ingot') + have('raw_iron') >= 3 && have('iron_ingot') < 3) await smeltAll('raw_iron', 'iron_ingot', { max: 3 - have('iron_ingot') })
        if (died || strategyInterrupted) return r
        if (have('iron_ingot') >= 3) await craft('bucket')
        if (died || strategyInterrupted) return r
        if (have(/bucket$/) < 2) castKitSupplyFailure = supplyKey()
      }
    }
    if (have(/bucket$/) >= 2) return act('portal', { ...params, one: undefined, hint: undefined })
    return r
  }
  if (one && r.status !== 'interrupted' && !died && have(/bucket$/) >= 2 && /места на берегу нет/.test(String(r.detail?.stopped || ''))) {
    log('литьё: берег для одного ведра не подходит, два ведра уже с собой — другая раскладка')
    return act('portal', { ...params, hint: undefined, windows: false })
  }
  return r
}
async function kitWaterHere () {
  if (process.env.ND_OW_KIT_WATER === '0' || dim() !== 'overworld' || !state.pos || died || !have('bucket') || have('water_bucket')) return false
  const interrupted = r => r.status === 'interrupted' || died || strategyInterrupted
  const first = await act('bucket', { fluid: 'water', radius: 48 })
  if (interrupted(first)) return null
  if (have('water_bucket')) return true
  const top = stairEntrance?.y ?? surfaceShaft?.top ?? Math.max(64, y())
  // shortcut: 40 s is GetWater's graph price, 2 s/block is the measured shaft ascent ETA.
  const outside = 40 + (sit.surface ? 0 : Math.max(0, top - y()) * 2)
  if (knownWater) {
    const q = knownWater, flat = Math.hypot(q.x - state.pos.x, q.z - state.pos.z)
    if (flat / 2.5 + Math.abs(q.y - y()) * 2 + 12 < outside) {
      if (Math.hypot(flat, q.y - y()) > 4 && interrupted(await act('goto', { ...q, range: 3, surface: false, descent: false, timeoutSeconds: 45 }))) return null
      if (interrupted(await act('portal', { mode: 'cast', waterHint: q, timeoutSeconds: 120 }))) return null
      if (have('water_bucket')) return true
      setKnownWater(null)
    }
  }
  if (!OW_HEAR || sit.surface || died || strategyInterrupted) return false
  const h = await act('portal', { mode: 'cast', listen: 16, fluid: 'water', timeoutSeconds: 30 })
  if (interrupted(h)) return null
  const heard = h.detail?.heard?.[0]
  if (!heard || died || strategyInterrupted) return false
  const length = Math.max(1, Math.min(16, (heard.flat || 0) + 3))
  if (length * 2 + Math.abs(heard.height || 0) * 2 + 12 >= outside) return false
  log(`вода рядом: слышу ${heard.dir}, ~${heard.dist} бл.; короткий подкоп дешевле подъёма`)
  const vertical = Math.abs(heard.height || 0) > (heard.flat || 0)
  const t = await act('tunnel', { direction: vertical ? (heard.height > 0 ? 'up' : 'down') : heard.dir,
    length: vertical ? Math.min(16, Math.abs(heard.height)) : length, torchEvery: 0, timeoutSeconds: 90 })
  if (interrupted(t)) return null
  const wet = /вода (?:у|на) (-?\d+),(-?\d+),(-?\d+)/.exec(String(t.detail?.stopped || ''))
  if (wet && interrupted(await act('portal', { mode: 'cast', waterHint: { x: +wet[1], y: +wet[2], z: +wet[3] }, timeoutSeconds: 120 }))) return null
  if (!have('water_bucket') && interrupted(await act('bucket', { fluid: 'water', radius: 32 }))) return null
  return have('water_bucket') > 0
}

async function waterSearchDirection () {
  if (process.env.ND_OW_KIT_WATER === '0' || !sit.surface || !state.pos) return null
  // Surface-water prior, not a height gate: search near the valley costs less than staying high.
  const price = floorY => 80 / 2.5 + Math.max(0, floorY + 1 - 64) * 2
  let best = price(y() - 1), direction = null
  const hits = []
  for (const pitch of [20, 45]) for (const [yaw, dir] of [[0, 'south'], [90, 'west'], [180, 'north'], [270, 'east']]) {
    const r = await act('perceive', { mode: 'surface', yaw, pitch, maxDist: 96 })
    if (r.status === 'interrupted' || died || strategyInterrupted) return undefined
    const s = r.detail?.surface
    hits.push(s ? [s.name, s.pos, s.water] : null)
    if (!s?.pos || s.water || /water|lava|leaves|_log$/.test(String(s.name))) continue
    const score = price(s.pos.y)
    if (score < best) { best = score; direction = dir }
  }
  setWaterSearchView(JSON.stringify([['x', 'y', 'z'].map(k => Math.floor(state.pos[k])), hits]))
  if (waterSearchView === waterSearchFailedView) return undefined
  return direction
}

const flintSearchSeen = new Set<string>()
let flintSearchViews = 0
async function ensureFlint () {
  if (have('flint_and_steel') || have('fire_charge')) return true
  // Current body pose after an actual search look, never coordinates of hidden gravel.
  const view = () => state.pos && ['x', 'y', 'z'].every(axis => Number.isFinite(state.pos[axis]))
    ? [dim(), ...['x', 'y', 'z'].map(axis => Math.floor(state.pos[axis] / 16))].join(':') : null
  const initialView = view()
  if (initialView) flintSearchSeen.add(initialView)
  const until = gameClock.now() + 180000
  if (!have('flint') && have('gravel') && !died) {
    const r = await act('flint_grind', { max: 40, timeoutSeconds: 90 })
    await refresh()
    if (r.status === 'interrupted') return false
  }
  for (let k = 0; k < 4 && !have('flint') && !died && gameClock.now() < until; k++) {
    if ((state.health ?? 20) < 12) { log('кремень: мало хп — поиск гравия прекращаю'); break }
    const g = await act('mine', { block: 'gravel', dry: true, count: 8, radius: 48, timeoutSeconds: Math.min(60, (until - gameClock.now()) / 1000) })
    if (g.status === 'interrupted') { log('кремень: копку прервали — поиск гравия прекращаю'); break }
    await refresh()
    if (!have('flint') && have('gravel') && gameClock.now() + 5000 < until) {
      const r = await act('flint_grind', { max: 40, timeoutSeconds: Math.min(90, (until - gameClock.now()) / 1000) })
      await refresh()
      if (r.status === 'interrupted') return false
    }
    if (have('flint') || died || gameClock.now() >= until) break
    if (!(g.detail && g.detail.dug)) {
      const e = await act('explore', { block: 'gravel', dry: true, surface: true, radius: 48, stepDistance: 60, timeoutSeconds: Math.min(60, (until - gameClock.now()) / 1000) })
      if (e.status === 'interrupted') return false
      const seen = view()
      const fresh = seen && e.status === 'done' && !e.detail?.stuck && !strategyInterrupted && !died && !flintSearchSeen.has(seen)
      if (fresh) { flintSearchSeen.add(seen); flintSearchViews++; graphFact('flint_search_views', flintSearchViews) }
      if (!e.detail?.found && !fresh) break
    }
  }
  if (have('flint') && !have('iron_ingot') && known.portal && portalFar() < 48) await act('chest_take', { item: 'iron_ingot', count: 1 })
  if (have('flint') && have('iron_ingot')) await craft('flint_and_steel')
  return have('flint_and_steel') > 0
}

export { castForKit, kitWaterHere, waterSearchDirection, ensureFlint }
