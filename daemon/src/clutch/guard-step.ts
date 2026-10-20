'use strict'
// Сторож блочного клатча — тик (st.step на physicsTick): учёт посадки и высоты падения, прогноз и решение decide, вода
// рядом, лестница на стену, блок под траекторию. Щелчок — на ближайшем move (clutch/guard-fire.ts).
import { FILLER, key, decide } from './blocks'
import { type ClutchGuard, eyeHeight, controls, climbing, emit, releaseSteering, prepare, cancelScheduled } from './guard-state'
import { context, waterStep } from './guard-forecast'
import { fire, ladderState, fireLadder } from './guard-fire'

// На земле: итог прошлого полёта (спасён / ранен) и высота отсчёта падения; в воздухе — пик.
function trackFlight (g: ClutchGuard, e) {
  const { bot, st, stats, world, pending, now } = g
  if (e.onGround) {
    if (st.flight) {
      const f = st.flight
      if (f.landed == null) { f.landed = now(); f.fall = Math.max(f.peak, st.peak ?? f.peak) - e.position.y; stats.landed++; emit(g, 'landed', { y: e.position.y, fall: f.fall, pending: pending.size }) }
      if (now() - f.landed >= 300) {
        const contact = f.cells.some(r => r.confirmed && world.getBlock(r.cell)?.stateId === r.stateId && Math.abs(e.position.y - r.cell.y - 1) < 1e-6 &&
          e.position.x + 0.3 > r.cell.x && e.position.x - 0.3 < r.cell.x + 1 && e.position.z + 0.3 > r.cell.z && e.position.z - 0.3 < r.cell.z + 1)
        if (bot.health >= f.hp - 0.01 && !pending.size && (contact || f.ladder) && !f.denied) { stats.saved++; emit(g, 'saved', { hp: bot.health, fall: f.fall, ladder: !!f.ladder }) }
        else emit(g, 'damaged_or_unconfirmed', { hp: bot.health, fall: f.fall, pending: pending.size })
        st.flight = null; st.blocks = 0; st.steering = null; st.ladderPlaced = false
      }
    } else { st.blocks = 0; st.ladderPlaced = false }
    st.peak = e.position.y; prepare(g)
  } else st.peak = Math.max(st.peak ?? bot._ndFallGuard?.peak ?? e.position.y, e.position.y)
}

// Лестница на стену вместо блока (есть в хотбаре, клатч нужен или блоков нет): итог тика или undefined.
function tryLadder (g: ClutchGuard, s, e, decision) {
  const { bot, st, api, world, blocked, hand, makeBlock, opts } = g
  if ((decision.action === 'clutch' || decision.why === 'no_blocks') && !st.ladderPlaced && !g.preparing && process.env.ND_LADDER_CLUTCH !== '0') {
    const ladder = bot.inventory.slots.slice(36, 45).find(i => i?.name === 'ladder')
    const lp = ladder && api.ladderPlan({ state: s, world, peak: st.peak, entities: bot.entities, selfId: e.id, eyeHeight: eyeHeight(g),
      ladderBlock: (cell, facing) => makeBlock(cell, ladderState(g, facing)), canReference: b => !blocked.has(key(b.position)) })
    if (lp) {
      g.scheduled = lp
      const snapshot = s.pos.clone()
      hand.hold(200)
      bot.look(lp.yaw, lp.pitch, true)?.catch?.(() => {})
      g.movement = () => fireLadder(g, lp, snapshot)
      bot.once('move', g.movement)
      if (opts.afterPacket) opts.afterPacket(bot, () => { if (g.scheduled === lp) fireLadder(g, lp, snapshot) })
      return { action: 'clutch', why: 'ladder' }
    }
  }
  return undefined
}

// Блок под траекторию: план create().plan и щелчок на ближайшем move.
function planBlock (g: ClutchGuard, s, e, decision) {
  const { bot, st, stats, api, world, blocked, spent, hand, opts, now } = g
  if (decision.action !== 'clutch' || st.blocks >= (opts.maxBlocks ?? 3) || g.preparing || now() - g.barAt < 300) return decision
  // Спуск блоками (descent.ts): первые ~0.4 бл. падения не ставить — грань стены на глубине 3 ещё вне руки (4.5),
  // а самый верхний блок дал бы шаг в 1 блок.
  const deep = !st.blocks && (bot._ndClutchDeep || 0) > now()
  if (deep && (st.peak ?? e.position.y) - e.position.y < 0.4) return decision
  const count = bot.inventory.slots.slice(36, 45).filter(i => i && FILLER.test(i.name)).reduce((n, i) => n + i.count, 0) - (opts.reserve ?? 0) - [...spent.values()].reduce((n, v) => n + v, 0)
  const p = api.plan({ state: s, world, peak: st.peak, blockCount: count, maxBlocks: (opts.maxBlocks ?? 3) - st.blocks, entities: bot.entities, selfId: e.id, eyeHeight: eyeHeight(g),
    canReference: b => !blocked.has(key(b.position)), steer: opts.steer, deep })
  if (!p || blocked.has(key(p.cell))) { stats.no_face++; emit(g, 'no_face'); return decision }
  g.scheduled = p
  const snapshot = s.pos.clone()
  hand.hold(200)
  bot.look(p.yaw, p.pitch, true)?.catch?.(() => {})
  g.movement = () => fire(g, p, snapshot, decision)
  bot.once('move', g.movement)
  // Optional existing edges.afterPacket fallback. move handles catch-up ticks
  // synchronously, before simulatePlayer of the next real tick can run.
  if (opts.afterPacket) opts.afterPacket(bot, () => { if (g.scheduled === p) fire(g, p, snapshot, decision) })
  return decision
}

function step (g: ClutchGuard) {
  const { bot, st, PlayerState, now } = g
  if (st.stopped) return { action: 'none', why: 'stopped' }
  st.t++; st.expire(); cancelScheduled(g)
  const e = bot.entity
  if (!e?.position || !e.velocity) return { action: 'none', why: 'no_body' }
  if (e.onGround && !st.waterPlan) { releaseSteering(g); st.waterAttempted = false }
  const s = new PlayerState(bot, controls(g))
  trackFlight(g, e)
  // Лестница, лоза, леса, паутина сбрасывают падение (LivingEntity.onClimbable →
  // resetFallDistance, makeStuckInBlock) — считать его заново от этой высоты.
  if (!e.onGround && climbing(g, e.position)) st.peak = e.position.y
  const ctx = context(g, s); const decision = decide(ctx); st.lastDecision = decision
  st.forecast = { from: s.pos.clone(), at: now(), landing: { lava: !!ctx.landing.lava, top: ctx.landing.top },
    guardAllow: !!ctx.guardAllow, intentional: !!ctx.intentional, ground: !!ctx.ground, vy: s.vel.y, excluded: decision.why === 'excluded' }
  const waterChoice = waterStep(g, s, ctx, decision)
  if (waterChoice) { st.lastDecision = waterChoice; return waterChoice }
  const L = ctx.landing || {}
  // Для журнала сторожа (edges.js «[clutch] молчит»): почему не клатч.
  st._dbg = { top: L.top, water: !!L.water, lava: !!L.lava, bad: !!L.bad, unknown: !!L.unknown, blocks: ctx.blocks, ground: ctx.ground, bucket: ctx.hasBucketBar, mode: ctx.mode, excl: ['dragon', 'wind', 'mace', 'swimming', 'lava', 'intentional', 'guardAllow', 'waterPlaced', 'elytra', 'riding', 'slowFalling', 'levitation', 'climbing'].filter(k => ctx[k]) }
  if (decision.action === 'water' || [ctx.dragon, ctx.wind, ctx.mace, ctx.swimming, ctx.lava, ctx.intentional, ctx.guardAllow, ctx.waterPlaced, ctx.dead].some(Boolean) || ctx.mode === 'creative' || ctx.mode === 'spectator') releaseSteering(g)
  if (s.isInWater || s.isInLava) { st.peak = null; st.flight = null; st.blocks = 0 }
  const ladder = tryLadder(g, s, e, decision)
  if (ladder) return ladder
  return planBlock(g, s, e, decision)
}

export { step }
