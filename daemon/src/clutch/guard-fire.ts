'use strict'
// Сторож блочного клатча — щелчки после пакета позиции (событие move): блок по плану create().plan и лестница на стену
// по плану ladderPlan. Перед щелчком план проверяется заново по той же позиции, что ушла серверу.
import { key, replaceable, othersOf, occupied, fullReference, blockReference, intersects, decide } from './blocks'
import { type ClutchGuard, eyeHeight, available, controls, emit, removePrediction, cancelScheduled } from './guard-state'
import { context } from './guard-forecast'

function fire (g: ClutchGuard, plan, snapshot, decision) {
  const { bot, st, stats, world, pending, spent, faceAim, hand, makeBlock, PlayerState, now } = g
  if (st.stopped || !g.scheduled || st.lastDecision?.action !== 'clutch') return
  cancelScheduled(g)
  const pos = bot.entity?.position
  if (!pos || pos.distanceTo(snapshot) > 1e-7) { stats.stale++; emit(g, 'stale'); return }
  // A custom afterPacket callback may execute after another simulation tick.
  // Abort stale work rather than use a different server AABB/eye accidentally.
  const s = new PlayerState(bot, controls(g))
  const current = context(g, s)
  if (decide(current).action !== 'clutch') return
  const rb = world.getBlock(plan.ref); const cell = world.getBlock(plan.cell)
  const others = othersOf(bot.entities, bot.entity.id)
  const eye = snapshot.offset(0, eyeHeight(g), 0)
  const point = faceAim(bot, plan.ref, plan.face, { eye, range: 4.5, avoid: others })
  const item = available(g)
  if (!item || !replaceable(cell) || !blockReference(rb) || !point || intersects(plan.cell, snapshot) || occupied(plan.cell, others)) return
  const def = bot.registry.blocksByName[item.name]
  if (!def) return
  const virtualBlock = makeBlock(plan.cell, def.defaultState)
  if (!virtualBlock || !virtualBlock.shapes?.some(sh => sh.every((v, i) => v === (i < 3 ? 0 : 1)))) return
  const k = key(plan.cell)
  const record = { cell: plan.cell, refKey: key(plan.ref), oldStateId: cell.stateId, stateId: def.defaultState, sentAt: now(), slot: item.slot, reserved: true }
  // move is emitted after position/position_look; this look goes before place.
  // Explicit look also covers concurrent look changes and forceLook:'ignore'.
  // The same steering that proved this placement must own the body until
  // its forecast landing; a four-tick click pulse can end mid knockback arc.
  hand.hold(Math.max(200, plan.landTick * 50))
  hand.as(() => {
    const d = point.minus(eye)
    const yaw = Math.atan2(-d.x, -d.z); const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    bot.look(yaw, pitch, true)?.catch?.(() => {})
    bot._client.write('look', { yaw: 180 - yaw * 180 / Math.PI, pitch: -pitch * 180 / Math.PI,
      onGround: !!bot.entity.onGround, flags: { onGround: !!bot.entity.onGround, hasHorizontalCollision: !!bot.entity.isCollidedHorizontally } })
    if (bot.quickBarSlot !== item.slot - 36) bot.setQuickBarSlot(item.slot - 36)
    pending.set(k, record)
    g.reservations.push(record)
    spent.set(item.slot, (spent.get(item.slot) || 0) + 1)
    try {
      // _genericPlace writes synchronously until its first await; ignore
      // avoids that await. Cursor is the exact legal faceAim point.
      const sent = bot._genericPlace(rb, plan.face, { delta: point.minus(plan.ref), forceLook: 'ignore', swingArm: 'right' })
      bot.world.setBlockStateId(plan.cell, def.defaultState)
      Promise.resolve(sent).catch(e => { removePrediction(g, k, true, 'denied'); emit(g, 'send_error', { error: e.message }) })
    } catch (e) { removePrediction(g, k, true, 'denied'); emit(g, 'send_error', { error: e.message }); return }
    stats.placed++; st.blocks++
    if (!st.flight) st.flight = { hp: bot.health, fall: plan.fall, peak: st.peak, started: now(), cells: [] }
    st.flight.cells.push(record)
    st.flight.fall = plan.fall
    emit(g, 'placed', { cell: plan.cell, ref: plan.ref, face: plan.face, fall: plan.fall, expectedBlocks: plan.chain.length, landTick: plan.landTick })
    const previous = st.steering?.previous || controls(g)
    for (const [k, v] of (Object.entries(plan.control) as [string, any][])) bot.setControlState?.(k, v)
    st.steering = { yaw: plan.yaw, control: plan.control, previous }
  })
}
// prismarine-block — запомненный ленивый загрузчик: ladderState зовётся из ladderPlan на каждую клетку-кандидата в тике
// падения, а require из папки части не попадает в быстрый кеш Node (как movement/lazy.ts).
let blockLoaded: typeof import('prismarine-block') | undefined
const prismarineBlock = (): typeof import('prismarine-block') => (blockLoaded ??= require('prismarine-block'))
const ladderState = (g: ClutchGuard, facing) => prismarineBlock()(g.bot.registry).fromProperties('ladder', { facing, waterlogged: false } as Record<string, any>, undefined).stateId
function fireLadder (g: ClutchGuard, plan, snapshot) {
  const { bot, st, stats, world, pending, faceAim, hand, now } = g
  if (st.stopped || g.scheduled !== plan) return
  cancelScheduled(g)
  const pos = bot.entity?.position
  if (!pos || pos.distanceTo(snapshot) > 1e-7) { stats.stale++; emit(g, 'stale'); return }
  const item = bot.inventory.slots.slice(36, 45).find(i => i?.name === 'ladder')
  const rb = world.getBlock(plan.ref); const cell = world.getBlock(plan.cell)
  const others = othersOf(bot.entities, bot.entity.id)
  const eye = snapshot.offset(0, eyeHeight(g), 0)
  const point = faceAim(bot, plan.ref, plan.face, { eye, range: 4.5, avoid: others })
  if (!item || !replaceable(cell) || !fullReference(rb) || !point || snapshot.y < plan.cell.y + 1) return
  const stateId = ladderState(g, plan.facing)
  const k = key(plan.cell)
  const record = { cell: plan.cell, refKey: key(plan.ref), oldStateId: cell.stateId, stateId, sentAt: now(), slot: item.slot, reserved: false, ladder: true }
  hand.hold(200)
  hand.as(() => {
    const d = point.minus(eye)
    const yaw = Math.atan2(-d.x, -d.z); const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
    bot.look(yaw, pitch, true)?.catch?.(() => {})
    bot._client.write('look', { yaw: 180 - yaw * 180 / Math.PI, pitch: -pitch * 180 / Math.PI,
      onGround: !!bot.entity.onGround, flags: { onGround: !!bot.entity.onGround, hasHorizontalCollision: !!bot.entity.isCollidedHorizontally } })
    if (bot.quickBarSlot !== item.slot - 36) bot.setQuickBarSlot(item.slot - 36)
    pending.set(k, record)
    try {
      const sent = bot._genericPlace(rb, plan.face, { delta: point.minus(plan.ref), forceLook: 'ignore', swingArm: 'right' })
      bot.world.setBlockStateId(plan.cell, stateId)
      Promise.resolve(sent).catch(e => { removePrediction(g, k, true, 'denied'); emit(g, 'send_error', { error: e.message }) })
    } catch (e) { removePrediction(g, k, true, 'denied'); emit(g, 'send_error', { error: e.message }); return }
    stats.ladders++; st.ladderPlaced = true
    if (!st.flight) st.flight = { hp: bot.health, fall: plan.fall, peak: st.peak, started: now(), cells: [] }
    st.flight.cells.push(record); st.flight.ladder = true
    emit(g, 'ladder_placed', { cell: plan.cell, ref: plan.ref, face: plan.face, facing: plan.facing, fall: plan.fall, landTick: plan.landTick })
  })
}

export { fire, ladderState, fireLadder }
