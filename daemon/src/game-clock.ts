'use strict'
// Gameplay time is counted in ticks. Legacy durations use NOMINAL ms: 50 = one
// tick at every server rate. Network/CPU/calendar code explicitly uses wall.
// Never patch process globals: ws, RCON, filesystem and A* keep real clocks.
const { EventEmitter } = require('node:events')
const { AsyncResource } = require('node:async_hooks')
const { performance } = require('node:perf_hooks')
const wall: any = { now: () => Date.now(), monotonic: () => performance.now(), setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate }
wall.sleep = ms => new Promise<any>(resolve => wall.setTimeout(resolve, ms))
const TICK_MS = 50
// Lockstep farm (ND_LOCKSTEP=1, farm/FarmLockstep.java): the server runs a tick only after this client's tick_end
// for all but a small window, and sends update_time every tick. A confirmed age is then a grant: pulse each tick at
// once with physics, at most `predictionTicks` ahead. Only a lag past this means the server's stall valve let the
// world run on without us: resynchronize by skipping, as an ordinary farm clock does.
const LOCKSTEP_RESYNC_TICKS = 20
// Stall valve (s5c 06.10): no update_time while running means the world stopped telling us its time — credits after the
// End exit portal (win_game limbo: the player is in no level), a lost connection, a hung server. The +predictionTicks cap
// then froze every game timer forever (s5-e23-s7: scene sleep(250) waited 7 min; c5-s1: skill timers never fired).
// After stallMs of wall time without a time packet the clock runs on at the vanilla client's own 20 ticks/s, as the
// game client does; the next time packet bounds it again. ND_CLOCK_STALL_MS=0 disables (followers never use it).
const STALL_RATE = 20
function stallMsOf (env = process.env) {
  const v = env.ND_CLOCK_STALL_MS === undefined ? 3000 : Number(env.ND_CLOCK_STALL_MS)
  return Number.isFinite(v) && v >= 0 ? v : 3000
}
let nextId = 0

class GameClock extends EventEmitter {
  declare id: any
  declare epoch: any
  declare ticks: any
  declare tickRate: any
  declare effectiveRate: any
  declare frozen: any
  declare steps: any
  declare manual: any
  declare predictionTicks: any
  declare running: any
  declare disposed: any
  declare timers: any
  declare age: any
  declare serverTicks: any
  declare serverAt: any
  declare freezeServerTick: any
  declare freezeClientTick: any
  declare sampleAt: any
  declare sampleAge: any
  declare pacingSampled: any
  declare observationMs: any
  declare observationAt: any
  declare freezeObservationMs: any
  declare pumpTimer: any
  declare pumpImmediate: any
  declare nextPulseAt: any
  declare cleanups: any
  declare lockstep: boolean
  declare stallMs: number
  declare stallTimer: any
  declare emit: any

  constructor ({ manual = false, epoch = wall.now(), predictionTicks = 20, lockstep = false, stallMs = stallMsOf() }: any = {}) {
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
    this.serverAt = null
    this.freezeServerTick = 0
    this.freezeClientTick = 0
    this.sampleAt = null
    this.sampleAge = null
    this.pacingSampled = false
    this.observationMs = 0
    this.observationAt = null
    this.freezeObservationMs = 0
    this.pumpTimer = null
    this.pumpImmediate = false
    this.nextPulseAt = null
    this.cleanups = []
    this.lockstep = lockstep
    this.stallMs = stallMs
    this.stallTimer = null
  }
  // Own prediction (not a follower), running unfrozen, and the last time packet is older than the valve.
  stalled () {
    return !this.manual && this.stallMs > 0 && this.predictionTicks > 0 && !this.frozen && this.serverAt !== null &&
      wall.monotonic() - this.serverAt >= this.stallMs
  }
  capped () {
    return !this.frozen && this.serverTicks !== null && this.ticks >= this.serverTicks + this.predictionTicks && !this.stalled()
  }
  armStall () {
    if (this.stallTimer || this.manual || this.disposed || !(this.stallMs > 0) || this.predictionTicks <= 0 || this.serverAt === null) return
    this.stallTimer = wall.setTimeout(() => { this.stallTimer = null; this.schedule(true) }, Math.max(1, this.serverAt + this.stallMs - wall.monotonic()))
    this.stallTimer.unref?.()
  }

  now () { return this.epoch + this.ticks * TICK_MS }
  // Date world observations by confirmed server age, even when client physics
  // falls behind. Interpolate only the next 20-tick time-packet interval; this
  // does not advance gameplay timers or client physics.
  observationRate () {
    // Short observations need a measured rate before the body's one-second
    // pacing sample. Reuse confirmed ages; frozen/stepped ages are not TPS.
    const sampleTicks = this.sampleAge === null ? 0 : Number(this.age - this.sampleAge)
    const sampleSpan = this.sampleAt === null ? 0 : this.serverAt - this.sampleAt
    return sampleTicks >= 20 && sampleSpan > 0
      ? Math.max(1, Math.min(this.tickRate, sampleTicks * 1000 / sampleSpan)) : this.effectiveRate
  }
  serverNow () {
    if (this.manual || this.serverTicks === null || this.serverAt === null) return this.now()
    const tick = this.frozen
      ? Math.max(this.serverTicks, this.freezeServerTick + this.ticks - this.freezeClientTick)
      : this.serverTicks + Math.min(20, Math.max(0, wall.monotonic() - this.serverAt) * this.observationRate() / 1000)
    return this.epoch + tick * TICK_MS
  }
  // Movement intervals need continuous elapsed observation time. Subtracting
  // absolute serverNow estimates across an age correction compresses dt or
  // makes it negative. Integrate the confirmed rate without advancing physics.
  observationNow () {
    if (this.manual || this.serverTicks === null || this.serverAt === null) return this.now()
    const at = wall.monotonic()
    if (this.observationAt === null) {
      this.observationMs = this.serverNow()
      this.freezeObservationMs = this.frozen ? this.epoch + this.freezeServerTick * TICK_MS : this.observationMs
    } else if (this.frozen) {
      const tick = Math.max(this.serverTicks, this.freezeServerTick + this.ticks - this.freezeClientTick)
      this.observationMs = this.freezeObservationMs + (tick - this.freezeServerTick) * TICK_MS
    } else this.observationMs += Math.max(0, at - this.observationAt) * this.observationRate() * TICK_MS / 1000
    this.observationAt = at
    return this.observationMs
  }
  snapshot () {
    return { id: this.id, ticks: this.ticks, gameMs: this.now(), elapsedMs: this.ticks * TICK_MS,
      tickRate: this.tickRate, effectiveRate: this.effectiveRate, frozen: this.frozen, stepping: this.steps,
      serverTicks: this.serverTicks, lagTicks: this.serverTicks === null ? null : Math.max(0, this.serverTicks - this.ticks),
      wallMs: wall.now(), running: this.running && !this.disposed, ...(this.lockstep ? { lockstep: true } : {}), ...(this.stalled() ? { stalled: true } : {}) }
  }
  setState ({ tick_rate = this.tickRate, is_frozen = this.frozen }: any = {}) {
    if (!Number.isFinite(tick_rate) || tick_rate < 1 || tick_rate > 10000) throw new RangeError('tick rate must be 1..10000')
    const changed = this.tickRate !== tick_rate
    const freezeChanged = this.frozen !== !!is_frozen
    if (changed || freezeChanged) this.observationNow()
    if (freezeChanged) {
      this.freezeObservationMs = this.observationMs
      this.freezeServerTick = this.serverTicks ?? this.ticks
      this.freezeClientTick = this.ticks
      if (this.serverAt !== null) this.serverAt = wall.monotonic()
    }
    this.tickRate = tick_rate
    if (changed || freezeChanged) { this.effectiveRate = tick_rate; this.sampleAt = null; this.sampleAge = null; this.pacingSampled = false }
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
    const stalled = this.stalled()
    const rate = stalled ? STALL_RATE : this.effectiveRate
    if (restart) {
      this.clearPump()
      this.nextPulseAt = wall.monotonic() + 1000 / rate
    }
    if (this.manual || this.disposed || !this.running || this.pumpTimer) return
    if (this.frozen && this.steps <= 0) return
    if (this.capped()) { this.armStall(); return }
    if (this.nextPulseAt === null) this.nextPulseAt = wall.monotonic() + 1000 / rate
    // Confirmed backlog grants time, not several physical steps in one wall
    // frame (Air41). Followers and explicit frozen steps still replay grants.
    // Lockstep never paces by the measured rate: the world waits for us, so that rate would only ratchet down.
    const lockstep = this.lockstep && !this.frozen && this.serverTicks !== null && !stalled
    const paced = this.predictionTicks > 0 && !this.frozen && !lockstep
    const catchingUp = lockstep || (!paced && this.serverTicks !== null && this.ticks < this.serverTicks)
    const deadline = this.nextPulseAt
    const remaining = deadline - wall.monotonic()
    // Windows timers can wake only every ~16 ms. Sleep for long waits, then
    // yield through check-phase turns until the monotonic deadline. One tick
    // per turn preserves packet processing and promise continuations at high TPS.
    this.pumpImmediate = catchingUp || remaining <= 16
    const run = () => {
      this.pumpTimer = null
      if (catchingUp || wall.monotonic() >= deadline) {
        const pulseStartedAt = wall.monotonic()
        if (!this.pulse()) return
        // A tick callback may have changed rate/freeze or disposed the clock.
        if (this.disposed || this.pumpTimer || this.nextPulseAt !== deadline) return
        // Pace physical starts, including callback work in this interval. An
        // overdue step starts a fresh deadline without replaying expired ones.
        this.nextPulseAt = (paced ? Math.max(pulseStartedAt, deadline) : catchingUp ? wall.monotonic() : deadline) + 1000 / rate
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
    if (this.capped()) return false
    if (this.frozen) this.steps--
    // Confirmed world time may outpace a CPU-blocked producer. Reconcile its
    // elapsed ticks, then run due intervals once without replaying physics.
    if (!this.manual && !this.frozen && this.predictionTicks > 0 && this.serverTicks > this.ticks + (this.lockstep ? LOCKSTEP_RESYNC_TICKS : 1)) this.ticks = this.serverTicks - 1
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
  setTimeout (fn, ms, ...args: any[]) { return this.timer(fn, ms, false, args) }
  setInterval (fn, ms, ...args: any[]) { return this.timer(fn, ms, true, args) }
  clearTimeout (t) {
    if (this.timers.delete(t)) { t.resource.emitDestroy(); t.cancel?.() }
  }
  clearInterval (t) { this.clearTimeout(t) }
  sleep (ms) {
    return new Promise<any>(resolve => {
      const t: any = this.setTimeout(resolve, ms)
      t.cancel = resolve
    })
  }
  syncAge (age) {
    age = asBigInt(age)
    if (this.stallTimer) { wall.clearTimeout(this.stallTimer); this.stallTimer = null }
    this.observationNow()
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
      this.pacingSampled = false
    } else if (!this.frozen) {
      // A single packet gap measures delivery jitter as well as server TPS.
      // Until the first full window, reuse accumulating confirmed ages instead
      // of pacing at an unmeasured request. Air30's cold 750 request reached the
      // +20 prediction cap and paused players for 39 ms at native ~415 TPS.
      // Keep the original window; steady pacing still aggregates a full second.
      const sampleTicks = Number(age - this.sampleAge)
      const span = at - this.sampleAt
      if ((span >= 1000 && sampleTicks >= 10) || (!this.pacingSampled && sampleTicks >= 20 && span > 0)) {
        this.effectiveRate = Math.max(1, Math.min(this.tickRate, sampleTicks * 1000 / span))
        if (span >= 1000) { this.sampleAt = at; this.sampleAge = age; this.pacingSampled = true }
      }
    }
    this.age = age
    this.serverAt = at
    if (reanchor) this.observationAt = null
    if (this.serverTicks !== previousTarget) this.schedule(reanchor || this.predictionTicks === 0 || this.frozen)
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
      // Lockstep keeps its anchor: re-anchoring a lagging client at its own tick shifts it toward the server's window
      // (a lockup until the stall valve). A truly different age still re-anchors in syncAge.
      if (this.lockstep) return
      this.age = null; this.serverTicks = null; this.serverAt = null; this.sampleAt = null; this.sampleAge = null; this.pacingSampled = false
      this.observationAt = null
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
    if (this.stallTimer) { wall.clearTimeout(this.stallTimer); this.stallTimer = null }
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
  return activate(new GameClock({ epoch: Math.max(wall.now(), active?.now() ?? 0), ...lockstepOptions() }).attach(bot))
}
// The farm sets ND_LOCKSTEP=1 for daemons of slots raised with `up --lockstep` (their server runs the tick gate).
function lockstepOptions (env = process.env) {
  if (env.ND_LOCKSTEP !== '1') return {}
  const ahead = env.ND_LOCKSTEP_AHEAD === undefined ? 2 : Number(env.ND_LOCKSTEP_AHEAD)
  if (!Number.isSafeInteger(ahead) || ahead < 1 || ahead > 20) throw new RangeError('ND_LOCKSTEP_AHEAD must be 1..20 ticks')
  return { lockstep: true, predictionTicks: ahead }
}
function live () { return active && !active.disposed ? active : null }
const now = () => live()?.now() ?? wall.now()
const serverNow = () => live()?.serverNow() ?? now()
const observationNow = () => live()?.observationNow() ?? now()
const snapshot = () => live()?.snapshot() ?? null
const setGameTimeout = (fn, ms, ...args: any[]) => live()?.setTimeout(fn, ms, ...args) ?? wall.setTimeout(fn, ms, ...args)
const setGameInterval = (fn, ms, ...args: any[]) => live()?.setInterval(fn, ms, ...args) ?? wall.setInterval(fn, ms, ...args)
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
module.exports = { GameClock, TICK_MS, wall, bind, activate, lockstepOptions, now, serverNow, observationNow, snapshot, follow, changes, sleep,
  setTimeout: setGameTimeout, setInterval: setGameInterval, clearTimeout: clearGameTimer, clearInterval: clearGameTimer }
