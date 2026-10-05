'use strict'
// Gameplay time is counted in ticks. Legacy durations use NOMINAL ms: 50 = one
// tick at every server rate. Network/CPU/calendar code explicitly uses wall.
// Never patch process globals: ws, RCON, filesystem and A* keep real clocks.
const { EventEmitter } = require('node:events')
const { AsyncResource } = require('node:async_hooks')
const { performance } = require('node:perf_hooks')
const wall = { now: () => Date.now(), monotonic: () => performance.now(), setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate }
wall.sleep = ms => new Promise(resolve => wall.setTimeout(resolve, ms))
const TICK_MS = 50
let nextId = 0

class GameClock extends EventEmitter {
  constructor ({ manual = false, epoch = wall.now(), predictionTicks = 20 } = {}) {
    super()
    this.id = `${process.pid}:${++nextId}`
    this.epoch = epoch
    this.ticks = 0
    this.tickRate = 20
    this.effectiveRate = 20
    this.frozen = false
    this.steps = 0
    this.manual = manual
    this.predictionTicks = predictionTicks
    this.running = false
    this.disposed = false
    this.timers = new Set()
    this.age = null
    this.serverTicks = null
    this.sampleAt = null
    this.sampleAge = null
    this.pumpTimer = null
    this.pumpImmediate = false
    this.nextPulseAt = null
    this.cleanups = []
  }

  now () { return this.epoch + this.ticks * TICK_MS }
  snapshot () {
    return { id: this.id, ticks: this.ticks, gameMs: this.now(), elapsedMs: this.ticks * TICK_MS,
      tickRate: this.tickRate, effectiveRate: this.effectiveRate, frozen: this.frozen, stepping: this.steps,
      serverTicks: this.serverTicks, lagTicks: this.serverTicks === null ? null : Math.max(0, this.serverTicks - this.ticks),
      wallMs: wall.now(), running: this.running && !this.disposed }
  }
  setState ({ tick_rate = this.tickRate, is_frozen = this.frozen } = {}) {
    if (!Number.isFinite(tick_rate) || tick_rate < 1 || tick_rate > 10000) throw new RangeError('tick rate must be 1..10000')
    const changed = this.tickRate !== tick_rate
    const freezeChanged = this.frozen !== !!is_frozen
    this.tickRate = tick_rate
    if (changed || freezeChanged) { this.effectiveRate = tick_rate; this.sampleAt = null; this.sampleAge = null }
    this.frozen = !!is_frozen
    if (!this.frozen) this.steps = 0
    this.emit('state', this.snapshot())
    if (changed || freezeChanged) this.schedule(true)
  }
  step (ticks) {
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new RangeError('step must be a nonnegative integer')
    if (this.steps === ticks) return
    this.steps = ticks
    this.emit('state', this.snapshot())
    this.schedule(true)
  }
  start () {
    if (this.disposed || this.running) return
    this.running = true
    this.schedule(true)
  }
  schedule (restart = false) {
    if (restart) {
      this.clearPump()
      this.nextPulseAt = wall.monotonic() + 1000 / this.effectiveRate
    }
    if (this.manual || this.disposed || !this.running || this.pumpTimer) return
    if (this.frozen && this.steps <= 0) return
    if (!this.frozen && this.serverTicks !== null && this.ticks >= this.serverTicks + this.predictionTicks) return
    if (this.nextPulseAt === null) this.nextPulseAt = wall.monotonic() + 1000 / this.effectiveRate
    const catchingUp = this.serverTicks !== null && this.ticks < this.serverTicks
    const deadline = this.nextPulseAt
    const remaining = deadline - wall.monotonic()
    // Windows timers can wake only every ~16 ms. Sleep for long waits, then
    // yield through check-phase turns until the monotonic deadline. One tick
    // per turn preserves packet processing and promise continuations at high TPS.
    this.pumpImmediate = catchingUp || remaining <= 16
    const run = () => {
      this.pumpTimer = null
      if (catchingUp || wall.monotonic() >= deadline) {
        if (!this.pulse()) return
        // A tick callback may have changed rate/freeze or disposed the clock.
        if (this.disposed || this.pumpTimer || this.nextPulseAt !== deadline) return
        // Confirmed past ticks must not push future predictions outward.
        this.nextPulseAt = (catchingUp ? wall.monotonic() : deadline) + 1000 / this.effectiveRate
      }
      this.schedule()
    }
    this.pumpTimer = this.pumpImmediate ? wall.setImmediate(run) : wall.setTimeout(run, remaining - 8)
    // Unreferenced immediates let poll sleep until unrelated I/O/timers and
    // recreate the Windows timer limit. Pause/stall/dispose release this handle.
    if (!this.pumpImmediate) this.pumpTimer.unref?.()
  }
  clearPump () {
    if (this.pumpTimer) {
      if (this.pumpImmediate) wall.clearImmediate(this.pumpTimer)
      else wall.clearTimeout(this.pumpTimer)
    }
    this.pumpTimer = null
  }
  pulse () {
    if (this.disposed || (this.frozen && this.steps <= 0)) return false
    // Time packets arrive every 20 world ticks. Don't run arbitrarily far into
    // the future if the server stalls. A step packet is an explicit tick grant.
    if (!this.frozen && this.serverTicks !== null && this.ticks >= this.serverTicks + this.predictionTicks) return false
    if (this.frozen) this.steps--
    this.advanceTicks(1)
    return true
  }
  advanceTicks (count) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError('ticks must be a nonnegative integer')
    for (let i = 0; i < count && !this.disposed; i++) {
      this.ticks++
      this.emit('tick', this.ticks)
      for (const t of [...this.timers]) {
        if (!this.timers.has(t) || t.at > this.ticks) continue
        if (t.interval) t.at = this.ticks + t.interval
        else this.timers.delete(t)
        try { t.resource.runInAsyncScope(t.fn, undefined, ...t.args) } finally {
          if (!t.interval) t.resource.emitDestroy()
        }
      }
    }
  }
  timer (fn, ms, interval, args) {
    if (typeof fn !== 'function') throw new TypeError('timer callback must be a function')
    const ticks = Math.max(1, Math.ceil((Number(ms) || 0) / TICK_MS))
    const t = { clock: this, fn, args, at: this.ticks + ticks, interval: interval ? ticks : 0,
      resource: new AsyncResource('NeuroDownGameTimer'), unref () { return this }, ref () { return this } }
    this.timers.add(t)
    return t
  }
  setTimeout (fn, ms, ...args) { return this.timer(fn, ms, false, args) }
  setInterval (fn, ms, ...args) { return this.timer(fn, ms, true, args) }
  clearTimeout (t) {
    if (this.timers.delete(t)) { t.resource.emitDestroy(); t.cancel?.() }
  }
  clearInterval (t) { this.clearTimeout(t) }
  sleep (ms) {
    return new Promise(resolve => {
      const t = this.setTimeout(resolve, ms)
      t.cancel = resolve
    })
  }
  syncAge (age) {
    age = asBigInt(age)
    const at = wall.monotonic()
    const previousTarget = this.serverTicks
    let reanchor = this.age === null
    if (this.age !== null) {
      const delta = Number(age - this.age)
      // Respawn/dimension ages can differ. Re-anchor instead of replaying a
      // world's entire history, or turning a /time command into a deadline.
      if (delta >= 0 && delta <= 10000) {
        this.serverTicks += delta
      } else { this.serverTicks = this.ticks; reanchor = true }
    } else this.serverTicks = this.ticks
    if (reanchor || this.sampleAt === null) {
      if (reanchor) this.effectiveRate = this.tickRate
      this.sampleAt = at
      this.sampleAge = age
    } else if (!this.frozen && at - this.sampleAt >= 1000) {
      // A single packet gap measures delivery jitter as well as server TPS.
      // Aggregate age deltas before clamping; stepped/frozen age isn't a rate.
      const sampleTicks = Number(age - this.sampleAge)
      if (sampleTicks >= 10) {
        this.effectiveRate = Math.max(1, Math.min(this.tickRate, sampleTicks * 1000 / (at - this.sampleAt)))
        this.sampleAt = at
        this.sampleAge = age
      }
    }
    this.age = age
    if (this.serverTicks !== previousTarget) this.schedule(true)
  }
  attach (bot) {
    bot.ndClock = this
    const listen = (emitter, event, fn) => {
      emitter.on(event, fn)
      this.cleanups.push(() => emitter.removeListener(event, fn))
    }
    listen(bot._client, 'set_ticking_state', p => this.setState(p))
    listen(bot._client, 'step_tick', p => this.step(p.tick_steps))
    listen(bot._client, 'update_time', p => this.syncAge(p.age))
    listen(bot, 'respawn', () => {
      this.age = null; this.serverTicks = null; this.sampleAt = null; this.sampleAge = null
      this.effectiveRate = this.tickRate
      this.schedule(true)
    })
    listen(bot, 'login', () => this.start())
    listen(bot, 'end', () => this.dispose())
    return this
  }
  dispose () {
    if (this.disposed) return
    this.disposed = true
    this.running = false
    this.clearPump()
    for (const fn of this.cleanups.splice(0)) fn()
    for (const t of [...this.timers]) this.clearTimeout(t)
    this.emit('state', this.snapshot())
  }
}
function asBigInt (value) {
  if (typeof value === 'bigint') return value
  if (Array.isArray(value)) return BigInt.asIntN(64, (BigInt(value[0]) << 32n) | BigInt(value[1] >>> 0))
  if (Number.isSafeInteger(value)) return BigInt(value)
  throw new TypeError('invalid server game age')
}

let active = null
const changes = new EventEmitter()
function activate (clock) {
  active = clock
  changes.emit('bound', clock)
  return clock
}
function bind (bot) {
  if (bot.ndClock) return activate(bot.ndClock)
  if (active && !active.disposed) active.dispose()
  return activate(new GameClock({ epoch: Math.max(wall.now(), active?.now() ?? 0) }).attach(bot))
}
function live () { return active && !active.disposed ? active : null }
const now = () => live()?.now() ?? wall.now()
const snapshot = () => live()?.snapshot() ?? null
const setGameTimeout = (fn, ms, ...args) => live()?.setTimeout(fn, ms, ...args) ?? wall.setTimeout(fn, ms, ...args)
const setGameInterval = (fn, ms, ...args) => live()?.setInterval(fn, ms, ...args) ?? wall.setInterval(fn, ms, ...args)
function clearGameTimer (t) { if (t?.clock) t.clock.clearTimeout(t); else wall.clearTimeout(t) }
const sleep = ms => live()?.sleep(ms) ?? wall.sleep(ms)

// Campaign runs in another process. Follow daemon clock snapshots; the daemon
// remains the authority and its freeze/stall is reflected in campaign budgets.
// RPC snapshots arrive every five game ticks, plus a 250 wall-ms heartbeat.
// Followers replay only confirmed ticks
// on separate event loop turns, without an independent prediction/busy-wait loop.
let remoteSource = null
function follow (s) {
  if (!s || !Number.isSafeInteger(s.ticks)) return
  if (remoteSource !== s.id || !live()) {
    active?.dispose()
    const clock = new GameClock({ epoch: s.gameMs - s.ticks * TICK_MS, predictionTicks: 0 })
    clock.ticks = s.ticks
    activate(clock)
    remoteSource = s.id
  }
  const c = live()
  c.setState({ tick_rate: s.tickRate, is_frozen: s.frozen || !s.running })
  c.syncAge(BigInt(s.ticks))
  if (s.frozen) c.step(Math.max(0, c.serverTicks - c.ticks))
  c.start()
}
module.exports = { GameClock, TICK_MS, wall, bind, activate, now, snapshot, follow, changes, sleep,
  setTimeout: setGameTimeout, setInterval: setGameInterval, clearTimeout: clearGameTimer, clearInterval: clearGameTimer }
