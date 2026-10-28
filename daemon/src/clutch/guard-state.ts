'use strict'
// Сторож блочного клатча (clutch install) — состояние и мелкие действия. Прежние константы и `let` замыкания install
// (резервы блоков, запланированный щелчок, подготовка хотбара) — поля объекта g (ClutchGuard); общее с внешним миром
// состояние — как было, в g.st (его возвращает install). Прежние внутренние функции — функции с g первым аргументом.
// Прогноз и вода — clutch/guard-forecast.ts, щелчки — clutch/guard-fire.ts, тик — clutch/guard-step.ts, подписки —
// clutch/guard.ts.
import * as gameClock from '../game-clock'
import { IDLE, FILLER, LAST, key, selectBlock } from './blocks'
import { create } from './plan'

export interface ClutchGuard {
  session: any
  opts: any
  bot: any
  Vec3: any
  PlayerState: any
  faceAim: any
  hand: any
  now: () => number
  simulate: (s: any, w: any) => any
  makeBlock: any
  api: ReturnType<typeof create>
  world: { getBlock: (p: any) => any }
  pending: Map<string, any>
  blocked: Map<string, number>
  spent: Map<any, number>
  reservations: any[]
  stats: any
  st: any
  scheduled: any
  preparing: boolean
  lastPrepare: number
  barAt: number
  movement: any
}

function openGuard (session, opts): ClutchGuard {
  const bot = session.bot
  const { Vec3, PlayerState, faceAim, hand } = opts
  if (!hand || !hand.as || !hand.hold || !bot.world || !bot._genericPlace) throw new TypeError('shared hand, world and _genericPlace required')
  const now = opts.now || gameClock.now
  const simulate = opts.simulate || ((s, w) => (bot._ndSimOrig || bot.physics.simulatePlayer).call(bot.physics, s, w))
  const makeBlock = opts.makeBlock
  const api = create({ Vec3, faceAim, simulate, makeBlock })
  const world = { getBlock: p => bot.blockAt(p, false) }
  const pending = new Map(); const blocked = new Map(); const spent = new Map()
  const reservations = []
  const stats = { placed: 0, confirmed: 0, denied: 0, timeout: 0, landed: 0, saved: 0, no_face: 0, stale: 0, water_plans: 0, water_saved: 0, water_failed: 0, soft_plans: 0, soft_saved: 0, soft_failed: 0, ladders: 0 }
  const st: any = { stats, pending, api, peak: null, blocks: 0, t: 0, stopped: false, flight: null, path: [], lastDecision: null }
  const scheduled = null; const preparing = false; const lastPrepare = -Infinity; const barAt = -Infinity; const movement = null
  return { session, opts, bot, Vec3, PlayerState, faceAim, hand, now, simulate, makeBlock, api, world, pending, blocked, spent, reservations, stats, st, scheduled, preparing, lastPrepare, barAt, movement }
}

const eyeHeight = (g: ClutchGuard) => { const { opts, bot } = g; return typeof opts.eyeHeight === 'function' ? opts.eyeHeight(bot) : (opts.eyeHeight ?? (bot.getControlState?.('sneak') ? 1.27 : 1.62)) }
const available = (g: ClutchGuard) => selectBlock(g.bot.inventory.slots, g.opts.reserve ?? 0, g.spent)
// Клавиши поимённо: у mineflayer bot.controlState — геттеры без enumerable, и
// { ...bot.controlState } пуст → в прогнозе (undefined − undefined) = NaN по x/z
// (ферма 30.09, clutch-dbg3: клатч молчал «unknown_world» на каждом падении).
const controls = (g: ClutchGuard) => {
  const { bot } = g
  const c = {}
  for (const k of Object.keys(IDLE)) c[k] = !!(typeof bot.getControlState === 'function' ? bot.getControlState(k) : bot.controlState && bot.controlState[k])
  return c
}
// BlockTags.CLIMBABLE 1.21.11 (клетка ног) и паутина.
const CLIMB = /^(ladder|vine|scaffolding|weeping_vines|weeping_vines_plant|twisting_vines|twisting_vines_plant|cave_vines|cave_vines_plant|cobweb)$/
const climbing = (g: ClutchGuard, p) => { const { world, Vec3 } = g; const b = world.getBlock(p.floored ? p.floored() : new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))); return !!(b && CLIMB.test(b.name)) }
const emit = (g: ClutchGuard, what, detail: any = {}) => { const { bot, st } = g; return bot.emit('nd_clutch', { what, fall: st.flight ? st.flight.fall : 0, blocks: st.blocks, t: st.t, ...detail }) }
function releaseSteering (g: ClutchGuard) {
  const { bot, st } = g
  const own = st.steering
  if (!own) return
  for (const [k, v] of (Object.entries(own.control) as [string, any][])) if (bot.getControlState?.(k) === v) bot.setControlState?.(k, !!own.previous[k])
  st.steering = null
}
function releaseReservation (g: ClutchGuard, r) {
  const { spent } = g
  if (!r.reserved) return
  r.reserved = false
  spent.set(r.slot, Math.max(0, (spent.get(r.slot) || 0) - 1))
}
function removePrediction (g: ClutchGuard, k, restore, reason?: any) {
  const { bot, world, pending, blocked, stats, st, now } = g
  const p = pending.get(k)
  if (!p) return
  pending.delete(k)
  if (restore && world.getBlock(p.cell)?.stateId === p.stateId) bot.world.setBlockStateId(p.cell, p.oldStateId)
  if (reason) { stats[reason]++; releaseReservation(g, p); g.reservations = g.reservations.filter(r => r.reserved); if (st.flight) st.flight.denied = true; blocked.set(k, now() + 500); emit(g, reason, { cell: p.cell }) }
  // An unaccepted parent cannot support dependent unaccepted extensions.
  for (const [child, record] of [...pending]) if (record.refKey === k) removePrediction(g, child, true, 'denied')
}
function receipt (g: ClutchGuard, p, id) {
  const { pending, stats, st } = g
  const k = key(p); const r = pending.get(k)
  if (!r) return
  if (id === r.stateId) { pending.delete(k); r.confirmed = true; stats.confirmed++; if (st.flight) st.flight.confirmed = (st.flight.confirmed || 0) + 1; emit(g, 'confirmed', { cell: r.cell }) }
  else removePrediction(g, k, false, 'denied') // mineflayer already installed the authoritative state
}
function expire (g: ClutchGuard) {
  const { pending, blocked, opts, now } = g
  for (const [k, p] of [...pending]) if (now() - p.sentAt >= (opts.confirmMs ?? 1000)) removePrediction(g, k, true, 'timeout')
  for (const [k, until] of blocked) if (now() >= until) blocked.delete(k)
}
function prepare (g: ClutchGuard) {
  const { bot, opts, hand, now } = g
  if (opts.prepare === false || g.preparing || now() - g.lastPrepare < 1000 || bot.currentWindow || hand.on && hand.on()) return
  g.lastPrepare = now()
  const sel = selectBlock(bot.inventory.slots, opts.reserve ?? 0)
  if (sel && !LAST.test(sel.name)) return
  const it = bot.inventory.items().find(i => FILLER.test(i.name) && !LAST.test(i.name) && i.slot < 36) ||
    (sel ? null : bot.inventory.items().find(i => FILLER.test(i.name) && i.slot < 36) || bot.inventory.items().find(i => i.name === 'cobweb' && i.slot < 36))
  if (!it || typeof bot.moveSlotItem !== 'function') return
  let dest = -1
  for (let i = 36; i <= 44; i++) if (!bot.inventory.slots[i] && i !== bot.quickBarSlot + 36) { dest = i; break }
  // S1f: хотбар полон — блоки для клатча обменять со слотом наименее нужного (не оружие/инструмент/ведро/щит/еда/жемчуг/зелья…).
  // «no_bar_slot» в 10 из 30 прогонов Ада вслепую, а «клатч молчит: no_blocks» при полном рюкзаке блоков — смерти в лаве (s1f-H2-2:
  // за прогон блоков почти не потрачено, в хотбаре их не было). ND_CLUTCH_SWAP=0 — прежнее.
  if (dest < 0 && process.env.ND_CLUTCH_SWAP !== '0') {
    const KEEP = /_(sword|axe|pickaxe|shovel|hoe|helmet|chestplate|leggings|boots)$|bucket|shield|bow$|crossbow|arrow|ender_pearl|ender_eye|flint_and_steel|fire_charge|potion|^cooked_|bread|golden_(apple|carrot)|_bed$|blaze_rod|blaze_powder|totem|crafting_table|^stick$/
    for (let i = 36; i <= 44; i++) { const s = bot.inventory.slots[i]; if (s && i !== bot.quickBarSlot + 36 && !KEEP.test(s.name) && !FILLER.test(s.name)) { dest = i; break } }
  }
  if (dest < 0) { emit(g, 'no_bar_slot'); return }
  g.preparing = true
  Promise.resolve(bot.moveSlotItem(it.slot, dest)).catch(e => emit(g, 'to_bar_failed', { error: e.message })).finally(() => { g.preparing = false; g.barAt = now() })
}
function cancelScheduled (g: ClutchGuard) {
  const { bot } = g
  if (g.movement) bot.removeListener('move', g.movement)
  g.movement = null; g.scheduled = null
}

export { openGuard, eyeHeight, available, controls, climbing, emit, releaseSteering, releaseReservation, removePrediction, receipt, expire, prepare, cancelScheduled }
