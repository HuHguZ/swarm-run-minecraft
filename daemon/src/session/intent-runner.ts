'use strict'
const gameClock = require('../game-clock')
const gear = require('../preflight')
const { resultCode } = require('./results')

async function runIntent (this: any, name, worker, { exclusive = true, interruptible = true, timeoutMs = 120000, interruptOn = null, params = null }: any = {}) {
    if (exclusive && this.tactics?.enabled()) await this.tactics.waitForRelease()
    // Директор (director.js) не рвёт mc_wait мозга: мозг ждёт и слушает, пока
    // директор работает, и прерывания будят его как обычно.
    const fromDirector = require('../director').byDirector()
    if (exclusive && !(fromDirector && this.current && this.current.name === 'wait')) this.cancel()

    const ctl: any = { aborted: false, onAbort: [] }
    const reflexLock = require('../reflex-lock')
    ctl.waitReflex = () => reflexLock.wait(this, ctl)
    ctl.abort = () => {
      if (ctl.aborted) return
      ctl.aborted = true
      for (const fn of ctl.onAbort) { try { fn() } catch {} }
    }
    const beside = !exclusive && this.current && this.current.name !== 'wait' && this.current.ctl && !this.current.ctl.aborted
    if (!beside) this.current = { name, ctl, byDirector: fromDirector, params }

    const spec = gear.requirements(name, params)
    const kit = spec ? gear.freshKit() : null
    let entered = false
    const begin = async () => {
      await ctl.waitReflex()
      if (ctl.aborted) throw new Error('прервано ещё до начала: к работе не приступал')
      entered = true
      return worker(ctl)
    }
    const start = spec
      ? () => gear.preflight(this, ctl, spec, kit).then(() => {
          if (ctl.aborted) throw new Error('прервано ещё до начала: успел только проверить снаряжение, к работе не приступал')
          return begin()
        })
      : begin

    const work = Promise.resolve()
      .then(() => reflexLock.run(this, ctl, start))
      .then(
        async detail => { if (!ctl.aborted) await ctl.waitReflex(); return { status: 'done', detail: detail ?? null } },
        err => ({ status: 'failed', error: String((err && err.message) || err), ...(err && typeof err.code === 'string' && /^[A-Z][A-Z_]+$/.test(err.code) ? { code: err.code } : {}) })
      ).catch(err => ({ status: 'failed', error: String(err?.message || err), ...(err?.code ? { code: err.code } : {}) }))

    // stop/disconnect must answer even when gameplay timers are frozen.
    const racers = [work, new Promise(resolve => {
      ctl.onAbort.push(() => resolve({ status: 'interrupted', by: ctl.interruptedBy || { type: 'cancelled' } }))
    })]
    let pending = null
    if (interruptible) {
      let waiter
      const next = async () => {
        waiter = this.bus.nextInterrupt(interruptOn)
        const ev = await waiter
        // A melee reflex is a pause, not a worker cancellation. Other events
        // (chat/death/end and environmental damage) keep their normal semantics.
        if (this.reflex && (ev.type === 'low_health' || (ev.type === 'damage' && /^mob_attack/.test(ev.cause || '')))) return next()
        return { status: 'interrupted', by: ev }
      }
      pending = { cancel: () => waiter?.cancel() }
      racers.push(next())
    }
    let timer = null
    if (timeoutMs > 0) {
      racers.push(new Promise(resolve => {
        timer = gameClock.setTimeout(
          () => resolve({ status: 'timeout', afterSeconds: Math.round(timeoutMs / 1000) }),
          timeoutMs
        )
      }))
    }

    const result: any = await Promise.race(racers)
    if (pending) pending.cancel()
    if (timer) gameClock.clearTimeout(timer)

    ctl.abort()
    if (this.current && this.current.ctl === ctl) this.current = null

    // The clock used to throw the work away along with the budget. Measured in
    const by = result.status === 'interrupted' && result.by ? result.by.type : null
    if (result.status === 'timeout' || (by && by !== 'chat' && by !== 'gesture')) {
      const settled = await Promise.race([work, gameClock.wall.sleep(1000)])
      if (settled && settled.detail && typeof settled.detail === 'object') {
        result.detail = settled.detail
        result.partial = true
        if (typeof settled.detail.stopped !== 'string') {
          settled.detail.stopped = by
            ? `прервано (${by}) — ниже то, что успел`
            : `время вышло за ${result.afterSeconds}с — ниже то, что успел`
        }
      } else if (settled && settled.error) {
        // Aborted mid-swing and threw on the way out. The text is worth more
        // than the bare clock: «нет кирки» and «не дошёл» are different orders.
        result.error = settled.error
      }
    }

    const kitReport = gear.summary(kit)
    if (kitReport) result.gear = kitReport
    if (!entered) result.notStarted = true

    // Drained after the grace above, so whatever the unwinding worker emitted
    // travels with the report it belongs to instead of with the next answer.
    const drained = this.bus.drain()
    result.events = result.by ? drained.filter(e => e.seq !== result.by.seq) : drained
    result.state = this.state()
    result.code = resultCode(result)
    return result
  }

module.exports = { runIntent }
