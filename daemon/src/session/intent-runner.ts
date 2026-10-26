'use strict'
import * as gameClock from '../game-clock'
import * as gear from '../preflight'
import { resultCode } from './results'
import { INTERRUPTING } from '../events'
// ND_CHAT_INTERRUPT=0 — чат не рвёт работу (совместная игра 10.10: человек пишет, кампания идёт, а не «стоишь и тупишь»);
// строки чата приезжают в событиях результата, wait по-прежнему будится чатом.
const chatOff = process.env.ND_CHAT_INTERRUPT === '0'
// Уворот не перебивается обычным приказом (12.10, арена: бой, баф, лут драйвера рвали рывок от зелья и стрел — бот
// стоял под брызгами): новый ждёт конца уворота (он короткий: рывок ≤ 1.5 с, джук ≤ 4 с), stop — рвёт как раньше.
// Тот же набор, что reflex-lock COMMANDED_ESCAPE: ветер/жемчуг/элитры тоже рвались боем драйвера до старта (roof-free-1).
const DODGES = /^(evade|juke|take_cover|douse_lava|wind_jump|pearl_to|fly_to|burrow|block_behind|peek_shot|wind_leap|dodge_blast|clear_web)$/

async function runIntent (this: any, name, worker, { exclusive = true, interruptible = true, timeoutMs = 120000, interruptOn = null, params = null }: any = {}) {
    // Уворот не ждёт тактики (12.10: «ест/пьёт зелье — булавой ваншотаю, ноль реакции»; mace-6: рывок стоял в очереди за
    // щитом/едой тактики и начинался за 6 тиков до удара): неаварийный рефлекс снимается сразу, аварийный (падение, лава) —
    // дождаться; остальные приказы — как раньше, после тактики.
    // stop must also cancel a queued RPC before it owns a worker controller.
    const cancelled = Symbol('cancelled before start')
    let stopped = false, cancelPrestart, cancelledBy
    const abort = new Promise(resolve => { cancelPrestart = by => { stopped = true; cancelledBy ||= { type: 'cancelled', by }; resolve(cancelled) } })
    const waiting = this._prestartIntents ||= new Set()
    waiting.add(cancelPrestart)
    const beforeStart = async promise => {
      const value = await Promise.race([promise, abort])
      if (stopped) throw cancelled
      return value
    }
    try {
    if (DODGES.test(name)) {
      const rl: typeof import('../reflex-lock') = require('../reflex-lock'); const o = rl.owner(this); if (o && o.owner !== 'Emergency') rl.cancel(this)
      while (rl.owner(this)?.owner === 'Emergency' && this.reflex) await beforeStart(this.reflex)
    } else if (exclusive && this.tactics?.enabled()) await beforeStart(this.tactics.waitForRelease())
    const cur = this.current
    // Спасаюсь из пропасти на элитрах (rescue) — его не рвёт ничто, кроме stop (13.10: подстрелил — рывок от следующей
    // стрелы отменил полёт, и бот упал).
    if (cur && (cur.name === 'fly_to' || cur.name === 'pearl_to') && cur.params?.rescue && cur.ctl && !cur.ctl.aborted) return { status: 'failed', error: cur.name === 'fly_to' ? 'спасаюсь на элитрах' : 'спасаюсь жемчугом', code: 'RESCUE_BUSY' }
    if (exclusive && !DODGES.test(name) && cur && DODGES.test(cur.name) && cur.ctl && !cur.ctl.aborted && cur.done) await beforeStart(cur.done.catch(() => {}))
    if (stopped) throw cancelled
    } catch (err) {
      if (err !== cancelled) throw err
      const result: any = { status: 'interrupted', by: cancelledBy || { type: 'cancelled' }, notStarted: true,
        events: this.bus.drain(), state: this.state() }
      result.code = resultCode(result)
      return result
    } finally {
      // The exclusive commit below cancels other intents, never this one.
      waiting.delete(cancelPrestart)
    }
    // Директор (director.js) не рвёт mc_wait мозга: мозг ждёт и слушает, пока
    // директор работает, и прерывания будят его как обычно.
    const fromDirector = (require('../director') as typeof import('../director')).byDirector()
    if (exclusive && !(fromDirector && this.current && this.current.name === 'wait')) this.cancel(name)

    const ctl: any = { aborted: false, onAbort: [] }
    const reflexLock: typeof import('../reflex-lock') = require('../reflex-lock')
    ctl.waitReflex = () => reflexLock.wait(this, ctl)
    ctl.abort = () => {
      if (ctl.aborted) return
      ctl.aborted = true
      for (const fn of ctl.onAbort) { try { fn() } catch {} }
      if (exclusive) reflexLock.releaseIntent(this, ctl)
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
        err => {
          // Ошибка кода (TypeError и т.п.) — со стеком в журнал демона: в ответе RPC остаётся одно сообщение (c13-7-2 14.10:
          // fortress spawner «pos.floored is not a function» без места падения).
          if (err instanceof TypeError || err instanceof ReferenceError || err instanceof RangeError) console.error('[intent] ' + name + ' упал:', err.stack)
          return { status: 'failed', error: String((err && err.message) || err), ...(err && typeof err.code === 'string' && /^[A-Z][A-Z_]+$/.test(err.code) ? { code: err.code } : {}) }
        }
      ).catch(err => ({ status: 'failed', error: String(err?.message || err), ...(err?.code ? { code: err.code } : {}) }))
    if (!beside) this.current.done = work

    // stop/disconnect must answer even when gameplay timers are frozen.
    const racers = [work, new Promise(resolve => {
      ctl.onAbort.push(() => resolve({ status: 'interrupted', by: ctl.interruptedBy || { type: 'cancelled' } }))
    })]
    let pending = null
    if (interruptible) {
      let waiter
      const next = async () => {
        waiter = this.bus.nextInterrupt(chatOff && name !== 'wait' ? [...(interruptOn || INTERRUPTING)].filter(t => t !== 'chat') : interruptOn)
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

export { runIntent }
