'use strict'
import { owAirEmergency, owDeathWaterOn, inWater } from './movement/water'
const gameClock: typeof import('./game-clock') = require('./game-clock')
// One session owns the hands. AsyncLocalStorage distinguishes a suspended worker,
// its late continuations, and the reflex, including callbacks created before takeover.
const { AsyncLocalStorage }: typeof import('node:async_hooks') = require('node:async_hooks')
// Хранилище контекста: сессия, ctl навыка, захвативший руки рефлекс и операция (эпоха) плагина.
const context = new AsyncLocalStorage<{ session?: any; ctl?: any; reflex?: any; op?: { epoch: number } }>()
interface ControlLease {
  owner: 'Skill' | 'Tactical' | 'Emergency'
  priority: number
  source: string
  startedAt: number
  ctl: { aborted: boolean; abort(): void; onAbort: Array<() => void> }
}
const on = () => process.env.ND_GUARD !== '0' && process.env.ND_GUARD_REFLEX !== '0'
const cancelled = () => Object.assign(new Error('reflex: действие прервано'), { code: 'REFLEX_CANCELLED' })
const interrupted = () => Object.assign(new Error('reflex: повторить локальное действие'), { code: 'REFLEX_RETRY' })
const abortCtl = () => {
  const ctl: any = { aborted: false, onAbort: [] }
  ctl.abort = () => { if (ctl.aborted) return; ctl.aborted = true; for (const f of [...ctl.onAbort]) { try { f() } catch {} } }
  return ctl
}
function state (s) { return s._reflexState || (s._reflexState = { epoch: 0, pausedMs: 0, active: null }) }
function clock (s) {
  if (!s) return gameClock.now()
  const st = state(s)
  const owner = context.getStore()?.reflex === st.active && st.active
  return gameClock.now() - st.pausedMs - (st.active && !owner ? gameClock.now() - st.active.startedAt : 0)
}
// ND_MAGMA_ESCAPE=1: a passive Shift constraint, never a second movement owner.
// Narrow exception: only the physical support block and the protective key.
function magmaSupport (s) {
  const b = s.bot
  if (owAirEmergency(b) || owDeathWaterOn(b) && inWater(b) && state(s).active?.source === 'Surface') return false
  return process.env.ND_MAGMA_ESCAPE === '1' && (b?.health ?? 0) > 0 && !b.vehicle &&
    b.entity?.onGround && !b.entity.isInLava && b.supportFeature?.('newPlayerInputPacket') &&
    b.blockAt(b.entity.position.offset(0, -.01, 0))?.name === 'magma_block'
}
function keepMagmaSneak (s) {
  if (!magmaSupport(s)) return false
  const b = s.bot
  // The timer may carry an aborted skill context. Borrow only the CURRENT lease
  // for this one key; ordinary stale actions and packets remain fenced.
  context.run({ session: s, reflex: state(s).active }, () => {
    b.setControlState('sneak', true)
    // Local=true does not prove server Shift. Resend a complete input snapshot.
    b._client.write('player_input', { inputs: {
      forward: b.getControlState('forward'), backward: b.getControlState('back'),
      left: b.getControlState('left'), right: b.getControlState('right'),
      jump: b.getControlState('jump'), shift: true, sprint: b.getControlState('sprint')
    } })
  })
  return true
}
function allowed (s) {
  const st = state(s); const c = context.getStore()
  if (c && c.session === s && (c.ctl?.aborted || (c.reflex && st.active !== c.reflex))) return false
  return !st.active || !!(c && c.session === s && c.reflex === st.active)
}
function owner (s): ControlLease | null { return state(s).active }
async function wait (s, ctl) {
  while (s.reflex && context.getStore()?.reflex !== state(s).active) {
    if (ctl?.aborted) throw cancelled()
    await s.reflex
  }
  if (ctl?.aborted || (context.getStore()?.reflex && !allowed(s))) throw cancelled()
}
function run<T> (s, ctl, fn: () => T): T { return context.run({ session: s, ctl }, fn) }
function cancel (s) { state(s).active?.ctl.abort() }
// The aborted worker's finally is fenced. Its intent must release the physical
// keys outside that context, but never touch a replacement skill or defence.
function releaseIntent (s, ctl) {
  if (s.current?.ctl !== ctl || state(s).active) return
  context.exit(() => {
    try { s.bot?.pathfinder?.setGoal(null) } catch {}
    try { s.bot?.clearControlStates?.() } catch {}
  })
}
function mark (s, how) {
  const a = state(s).active
  if (!a || a.firstAction != null || context.getStore()?.reflex !== a) return
  a.firstAction = gameClock.now()
  s.bot.emit('nd_guard_reflex', { how, reflexMs: a.firstAction - a.triggerAt, source: a.source, during: s.current?.name || null })
}
function take (s) {
  const b = s.bot
  // Рефлекс падения (Emergency) снимает цель на долю секунды: goto (movement.gotoGoal) видит, чей это сброс, и после
  // рефлекса продолжает ту же цель, а не падает «goal was changed» (S8b 07.10: 41 переход за 4 серии S8).
  // after(fn) — fn после конца аренды и ВНЕ её контекста (обёртка pathfinder.setGoal в контексте снятой аренды молчит).
  const a = state(s).active
  const lease = a && a.owner === 'Emergency' ? s.reflex : null
  b._ndReflexTake = lease ? { after: fn => lease.then(() => context.exit(fn)) } : null
  try { b.pathfinder?.setGoal(null) } catch {} finally { b._ndReflexTake = null }
  try { b.stopDigging?.() } catch {}
  try { if (b.currentWindow) b.closeWindow(b.currentWindow) } catch {}
  try { b.clearControlStates?.() } catch {}
  try { b.deactivateItem?.() } catch {}
}
// Set the promise BEFORE calling any bot API: a nested damage/physics callback
// sees the same lock. Neither current nor its ctl is replaced/aborted.
// Приказной уворот/побег (арена 12.10: рывок от булавы и зелья, джук от лука, ветер, жемчуг, элитры, укрытие) — уже ответ
// на угрозу. Неаварийный рефлекс (щит и бой тактики, жест, сторож) посреди него отбирал руки и ноги: рывок вставал
// (mace-7: «reflex: действие прервано», бот под булавой не сдвинулся). Аварийный (падение, лава) — как раньше. Уход от
// динамита и срез паутины — тоже (стенд бота-противника 22.10: тактика рвала уход от горящего заряда через 0.1–0.3 с).
// Таран по приказу (RPC lance, сцена try-lance 23.10): щит тактики рвал 10 таранов из 12 ещё на взлёте.
// Разгон стрелой (boost_lance/boost_shot, сцена try-arrow-boost 24.10): бой тактики бил своего лучника после толчка.
// Засада и ловушка на жемчуг — срок до его появления: отвлечься на бой — опоздать.
const COMMANDED_ESCAPE = /^(evade|juke|take_cover|douse_lava|clear_water|wind_jump|pearl_to|fly_to|lance|boost_lance|boost_shot|pearl_ambush|pearl_trap|pearl_test_up|jump_down|wing_orbit|burrow|block_behind|peek_shot|wind_leap|dodge_blast|clear_web)$/
// Подъём к цели (goto climb, Codex 15.10): щит и бой тактики от летящего трезубца не отбирают ноги — «лезу к RedTest1 —
// The goal was changed» на каждом броске. Аварии (падение, лава, мало хп, застрял в блоке, взрыв) — как раньше.
// Щит к падающему с булавой (swarm_hold whileSmash) — тоже приказ: тактика рвала стойку («cancelled by tactical»), и удар сверху
// приходил в открытого (игра пользователя 23.10, 31ab: щит снят за 3.35 с, через 2 с — smashed).
function shieldHold (s) {
  const c = s.current, defense = s.bot?._ndMaceDefense
  return !c?.ctl?.aborted && (c?.name === 'swarm_hold' && !!(c.params?.whileSmash || c.params?.whileDraw) ||
    c?.name === 'fight' && defense?.current === c && !!defense.ctl && !defense.ctl.aborted && defense.until > gameClock.now())
}
function protectedClimb (s) {
  const c = s.current, h = s.tactics?.snapshot?.()?.state
  return (c?.name === 'goto' && !!c.params?.climb || c?.name === 'swarm_work' && c.params?.kind === 'dig' && !!c.params?._climb) && !c.ctl?.aborted && (s.bot?.health ?? 0) > (s.cfg?.lowHealth ?? 8) && !!h &&
    !s.bot?.entity?.isInLava && !['dangerousFall', 'emergencyController', 'lava', 'lavaAhead', 'lavaEscapePending', 'embedded', 'explosion', 'drowning'].some(k => h[k])
}
function start (s, fn, { triggerAt = gameClock.now(), source = 'melee', owner = 'Tactical', priority = 2, preempt = false, immediate = false }: any = {}) {
  install(s)
  const st = state(s)
  if (owner !== 'Emergency' && s.current && !s.current.ctl?.aborted && (COMMANDED_ESCAPE.test(s.current.name || '') || protectedClimb(s) || shieldHold(s))) return Promise.resolve({ acted: false, cancelled: true, why: 'идёт уворот по приказу' })
  if (st.active) {
    if (!preempt || st.active.priority > priority) return s.reflex
    st.active.ctl.abort()
  }
  const a: any = { ctl: abortCtl(), triggerAt, startedAt: gameClock.now(), source, owner, priority, firstAction: null }
  st.epoch++; st.active = a
  let release
  const done = new Promise(resolve => { release = resolve })
  s.reflex = done
  const cleanup = result => {
    if (st.active !== a) return
    if (s.bot === b) context.run({ session: s, reflex: a }, () => take(s))
    st.pausedMs += gameClock.now() - a.startedAt
    st.active = null; s.reflex = null
    release(result)
  }
  const ended = () => a.ctl.abort()
  const b = s.bot
  b.once('death', ended); b.once('end', ended)
  a.ctl.onAbort.push(() => cleanup({ acted: false, cancelled: true }))
  context.run({ session: s, ctl: a.ctl, reflex: a }, () => {
    take(s)
    let work
    const invoke = () => a.ctl.aborted || st.active !== a ? { acted: false, cancelled: true } : fn(a.ctl)
    try { work = immediate ? Promise.resolve(invoke()) : Promise.resolve().then(invoke) } catch (error) { work = Promise.reject(error) }
    work.then(cleanup, error => cleanup({ acted: false, error: error.message }))
      .finally(() => { b.removeListener('death', ended); b.removeListener('end', ended) })
  })
  // Remove event hooks even when a third-party action fails to settle after death.
  done.then(() => { b.removeListener('death', ended); b.removeListener('end', ended) })
  return done
}
function emergency (s, fn, holdMs = 200) {
  if (!s?.bot) return fn()
  const active = state(s).active
  if (active?.owner === 'Emergency' && context.getStore()?.reflex === active) return fn()
  let result
  start(s, () => {
    result = fn()
    return Promise.all([Promise.resolve(result), new Promise(resolve => gameClock.setTimeout(resolve, holdMs))])
  }, { source: 'fall-controller', owner: 'Emergency', priority: 3, preempt: true, immediate: true })
  return result
}
const ASYNC = ['dig', 'equip', 'unequip', 'look', 'lookAt', 'placeBlock', '_genericPlace', 'openContainer', 'openBlock', 'openEntity', 'consume', 'craft', 'transfer', 'clickWindow', 'moveSlotItem', 'putAway', 'putSelectedItemRange', 'toss', 'tossStack']
const SYNC = ['setControlState', 'clearControlStates', 'attack', 'mount', 'dismount', 'swingArm', 'activateItem', 'deactivateItem', 'activateBlock', 'activateEntity', 'setQuickBarSlot', 'stopDigging', 'closeWindow']
const CONTROL_PACKETS = new Set(['use_item', 'block_place', 'use_entity', 'client_command', 'vehicle_move', 'steer_vehicle', 'steer_boat', 'player_input', 'arm_animation', 'position', 'position_look', 'look', 'flying'])
function inventoryCount (b, id, metadata) {
  return b.inventory.items().filter(i => i.type === id && (metadata == null || i.metadata === metadata)).reduce((n, i) => n + i.count, 0)
}
async function operation (s, obj, name, raw, args) {
  const parent = context.getStore()
  if (parent?.session === s && parent.op) {
    // Unwind an interrupted plugin stack rather than clicking slots of a CLOSED
    // crafting/container window after resumption. Its root restarts locally.
    if (!allowed(s) || parent.op.epoch !== state(s).epoch) throw interrupted()
    if (name === 'craft') craftSafe(s)
    return raw.apply(obj, args)
  }
  const ctl = parent?.session === s ? parent.ctl : null
  const b = s.bot
  // Слот может переехать после защиты; тип не различает лечение/вред и зачарования.
  const selectedItem = name === 'equip' && args[0]?.type != null ? structuredClone(args[0]) : null
  let craftRemaining = name === 'craft' ? Math.max(0, parseInt(args[1] ?? 1, 10)) : null
  for (;;) {
    await wait(s, ctl)
    // A lease taken between wait()'s check and this continuation (same macrotask) still owns the hands (stress stand).
    if (!allowed(s)) continue
    const epoch = state(s).epoch
    const op = { epoch }
    const c = { session: s, ctl, reflex: parent?.reflex, op }
    let value, error
    const output = name === 'craft' ? args[0]?.result : null
    const before = output ? inventoryCount(b, output.id, output.metadata) : 0
    const attempt = args.slice()
    if (name === 'craft') {
      craftSafe(s)
      if (!craftRemaining) return
      attempt[1] = craftRemaining
      if (attempt[2]?.position) attempt[2] = b.blockAt(attempt[2].position)
      // A table/pick can be invalidated by the defence. Fail this LOCAL operation
      // honestly; do not teleport/replay the entire bastion intent.
      if (args[0]?.requiresTable && attempt[2]?.name !== 'crafting_table') throw new Error('reflex: верстак больше недоступен')
    }
    if (name === 'dig' && attempt[0]?.position) {
      attempt[0] = b.blockAt(attempt[0].position)
      if (attempt[0] && /^(air|cave_air|void_air)$/.test(attempt[0].name)) return
    }
    if (selectedItem) {
      const items = b.inventory.items()
      const same = i => (require('./invsync') as typeof import('./invsync')).sameStack(b, i, selectedItem)
      // items() исключает броню и вторую руку; их актуальные клиентские слоты тоже законны.
      const atSlot = Number.isInteger(selectedItem.slot) && selectedItem.slot >= 0 ? b.inventory.slots?.[selectedItem.slot] : null
      attempt[0] = atSlot && same(atSlot) ? atSlot : items.find(same)
      if (!attempt[0]) throw Object.assign(new Error('reflex: выбранного предмета больше нет'), { code: 'REFLEX_ITEM_GONE' })
    }
    try { value = await context.run(c, () => raw.apply(obj, attempt)) } catch (e) { error = e }
    const changed = epoch !== state(s).epoch
    if (ctl?.aborted || (parent?.reflex && !allowed(s))) throw cancelled()
    if (!changed) {
      if (error) throw error
      if (/^open(Container|Block|Entity)$/.test(name) && value) wrapWindow(s, value, obj, name, raw, args)
      if (name === 'placeBlock') mark(s, 'place')
      return value
    }
    await wait(s, ctl)
    if (output) {
      // Count only credited output; never duplicate crafts whose result was
      // collected before takeover. Raw mineflayer.craft cleans its cached window
      // in catch (craft.js); retry opens a fresh one.
      const made = Math.max(0, inventoryCount(b, output.id, output.metadata) - before)
      craftRemaining -= Math.min(craftRemaining, Math.floor(made / output.count))
      if (!craftRemaining) return
    } else if (!error && !['dig', 'goto', 'look', 'lookAt', 'equip', 'unequip'].includes(name)) {
      // Successful inventory/placement actions are committed, not replayable.
      return value
    } else if (error && !['dig', 'goto', 'look', 'lookAt', 'equip', 'unequip', 'openContainer', 'openBlock', 'openEntity'].includes(name)) {
      throw Object.assign(new Error('reflex: незавершённая транзакция, требуется пересчитать локальное действие'), { code: 'REFLEX_TRANSACTION' })
    }
  }
}
function craftSafe (s) {
  if (context.getStore()?.reflex) return
  const covered = e => {
    if (process.env.ND_CRAFT_COVER === '0') return false
    try {
      const P: typeof import('./perception') = require('./perception'); const eye = P.eyePos(s.bot)
      // Do not relax the check for a gap at feet/torso while only the eyes are
      // hidden. Missing chunks/errors retain the original refusal.
      return [0.1, (e.height || 1.8) * 0.5, (e.height || 1.8) * 0.9]
        .every(y => !P.raySees(s.bot, eye, e.position.offset(0, y, 0)))
    } catch { return false }
  }
  if ((require('./worlds') as typeof import('./worlds')).worldOf(s.bot) === 'the_nether' && (require('./ne-guard') as typeof import('./ne-guard')).meleeFoes(s.bot, 12).some(e => !covered(e))) {
    throw Object.assign(new Error('reflex: крафт отложен, враг в 12 блоках'), { code: 'REFLEX_UNSAFE_CRAFT' })
  }
}
function wrapWindow (s, w, obj, opener, rawOpen, openArgs) {
  if (w._ndReflexWindow) return
  w._ndReflexWindow = true
  let live = w
  for (const name of ['deposit', 'withdraw']) {
    if (typeof w[name] !== 'function') continue
    const raw = w[name]
    w[name] = async (...args: any[]) => {
      await wait(s, context.getStore()?.ctl)
      if (s.bot.currentWindow !== live) live = await rawOpen.apply(obj, openArgs)
      // Child clicks run inside a root transaction; a closed window cannot
      // become inventory window 0. No automatic replay of a partial transfer.
      return operation(s, live, name, live === w ? raw : live[name], args)
    }
  }
  if (typeof w.close === 'function') w.close = () => { if (s.bot.currentWindow === live) s.bot.closeWindow(live) }
}
function install (s) {
  const b = s.bot
  if (!b || b._ndReflexLock) return
  b._ndReflexLock = true
  b._ndReflexSession = s
  // Примесь клавиш внутри ограды: запоздалое действие не меняет ввод, а аварийный владелец выключает уворот сразу.
  if (typeof b.setControlState === 'function' && typeof b.getControlState === 'function')
    (require('./projectile-evasion') as typeof import('./projectile-evasion')).install(s, () => !state(s).active && allowed(s))
  const wrapAsync = (obj, name) => {
    const raw = obj?.[name]
    if (typeof raw !== 'function') return
    obj[name] = function (...args: any[]) { return operation(s, obj, name, raw, args) }
  }
  for (const name of ASYNC) wrapAsync(b, name)
  for (const name of SYNC) {
    const raw = b[name]
    if (typeof raw !== 'function') continue
    b[name] = function (...args: any[]) {
      const c = context.getStore()
      if (/^activate(Block|Entity)$/.test(name) && c?.op && (!allowed(s) || c.op.epoch !== state(s).epoch)) throw interrupted()
      if (!allowed(s)) return
      if (c?.op && c.op.epoch !== state(s).epoch) return
      // A stale craft catch must not close the reflex's/new operation's window.
      if (name === 'closeWindow' && args[0] !== b.currentWindow && args[0] !== b.inventory) return
      const r = raw.apply(this, args)
      if (name === 'attack') mark(s, 'attack')
      if (name === 'activateItem' && args[0] === true && b.inventory.slots[45]?.name === 'shield') mark(s, 'shield')
      return r
    }
  }
  wrapAsync(b.pathfinder, 'goto')
  for (const name of ['setGoal', 'setMovements', 'stop']) {
    const raw = b.pathfinder?.[name]
    if (!raw) continue
    b.pathfinder[name] = function (...args: any[]) { if (allowed(s)) return raw.apply(this, args) }
  }
  // inventory.clickWindow can sleep AFTER entry (hotbar/DIG_CLICK_TIMEOUT).
  // Fence its final write too, so an old craft never clicks inventory window 0.
  if (typeof b._client?.write === 'function') {
    const raw = b._client.write
    b._client.write = function (name, data) {
      const c = context.getStore()
      if (name === 'window_click' && c?.session === s && c.op && (!allowed(s) || c.op.epoch !== state(s).epoch)) throw interrupted()
      if (CONTROL_PACKETS.has(name) && c?.session === s && (!allowed(s) || c.op && c.op.epoch !== state(s).epoch)) {
        // s5 06.10: диагностика молча выброшенных пакетов навыка (ND_DROP_LOG=1)
        if (process.env.ND_DROP_LOG && name !== 'position' && name !== 'position_look' && name !== 'look' && name !== 'flying') console.log(`[reflex-drop] ${name} — руки у ${state(s).active?.source ?? '-'}${c.op && c.op.epoch !== state(s).epoch ? ', старая эпоха' : ''}${c.ctl?.aborted ? ', навык прерван' : ''}`)
        return
      }
      // A permitted cleanup/vehicle input must not release server Shift on magma.
      if (name === 'player_input' && magmaSupport(s)) data = { ...data, inputs: { ...data?.inputs, shift: true } }
      const out = raw.call(this, name, data)
      if (name === 'block_place' && c?.reflex && data?.location) mark(s, 'place')
      return out
    }
  }
}
module.exports = { on, run, wait, start, install, cancel, releaseIntent, mark, clock, owner, emergency, protectedClimb, shieldHold, keepMagmaSneak }
export { on, run, wait, start, install, cancel, releaseIntent, mark, clock, owner, emergency, protectedClimb, shieldHold, keepMagmaSneak }
