'use strict'

// Interrupt policy, decided during design:
//   INTERRUPTING  - a real player talks to us, we take damage, health gets low,
//                   we die, or the connection breaks. These yank the brain out
//                   of whatever it was doing.
//   BUFFERED      - everything else piles up and is handed over together with
//                   the result of the action that was running.
const INTERRUPTING = new Set(['chat', 'damage', 'low_health', 'death', 'kicked', 'disconnected'])

// Recorded is not the same as delivered. nextInterrupt() only ever registered a
// waiter and never looked at the buffer, so a message that arrived while the
// brain was between turns could not stop the next intent: measured, wait(30)
// called after the message slept all 30 seconds and handed the text over at the
// end. For the types below, sitting in the buffer *is* the interrupt — drain()
// is what "delivered" means here, so anything still in there has reached nobody,
// and every one of these makes the plan the brain is about to act on wrong.
// damage and low_health stay out on purpose: they repeat by nature, the
// autopilot already answers them, and one stale hit would abort every next
// intent at its first tick.
const PENDING_WAKES = new Set(['chat', 'gesture', 'friend_hurt', 'death', 'kicked', 'disconnected'])

// Жест человека (gestures.js: присел перед нами, прыгает, смотрит в упор,
// кинул вещь) — тот же разговор, что чат, только телом. Он будит mc_wait, но
// не рвёт работу: в INTERRUPTING его нет, и намерения со списком по
// умолчанию его не слышат — его слушает только тот, кто назвал явно
// (session.wait). Остальным он приезжает в событиях вместе с результатом.
// Друга бьёт моб (friend_hurt) — туда же: живой напарник на это оборачивается.
// Аварийный отход автопилота (emergency, autopilot.js) будит и ожидание: пока тело свободно, автопилот ждущих не
// отпускает (interruptFor — только поверх работы), а wait кампании или мозга должен узнать, что тело занято отходом,
// сразу, а не через 30 с (research/dev-B-refuge.md, правка 4).
const WAKES = new Set([...INTERRUPTING, 'gesture', 'friend_hurt', 'emergency'])

// Урон, от которого не спасают ни бой, ни нора, и который кончается, если идти дальше (тип — session.wireHealth
// из damage_event): ягодный куст, кактус, порошковый снег, давка, уже случившееся падение. Он не рвёт работу —
// ферма 30.09 (fresh-A0, слот 8): тайга, куст у ног, каждый шаг — удар, goto и нора рвались уроном каждые
// 2 с, этап еды шёл пустым кругом до блокера. Событие остаётся в буфере и приезжает с итогом намерения;
// низкое здоровье (low_health) рвёт по-прежнему.
const QUIET_DAMAGE = new Set(['sweet_berry_bush', 'cactus', 'freeze', 'cramming', 'fall', 'stalagmite', 'fly_into_wall', 'ender_pearl'])  // ender_pearl — свой бросок (5 хп), не нападение: goto с жемчугом не рвать
const wakes = (type, data) => WAKES.has(type) && !(type === 'damage' && QUIET_DAMAGE.has(data && data.cause))

const MAX_BUFFER = 60

class EventBus {
  constructor () {
    this.buffer = []
    this.waiters = new Set()
    this.seq = 0
  }

  emit (type, data = {}) {
    const ev = { seq: ++this.seq, at: Date.now(), type, ...data }
    if (wakes(type, data)) {
      // Interrupts are delivered as the reason the action stopped, and are
      // also kept in the buffer so nothing is silently lost.
      this.buffer.push(ev)
      this.trim()
      for (const waiter of Array.from(this.waiters)) {
        if (waiter.accepts(ev.type)) {
          this.waiters.delete(waiter)
          waiter.resolve(ev)
        }
      }
    } else {
      this.buffer.push(ev)
      this.trim()
    }
    return ev
  }

  // Overflow used to cut from the head, and the head is where the oldest unread
  // message sits. One fight is enough to push 60 events through (damage on
  // every hit), and a player's line is the only thing in this buffer that
  // cannot be recovered by looking at the world again — so ordinary events give
  // up their place first.
  trim () {
    if (this.buffer.length <= MAX_BUFFER) return
    let excess = this.buffer.length - MAX_BUFFER
    const kept = []
    for (const ev of this.buffer) {
      if (excess > 0 && !PENDING_WAKES.has(ev.type)) { excess--; continue }
      kept.push(ev)
    }
    // Only reachable when the overflow is itself unread messages; then the
    // oldest do go, because a bus that grows without bound is a leak.
    if (kept.length > MAX_BUFFER) kept.splice(0, kept.length - MAX_BUFFER)
    this.buffer = kept
  }

  // The oldest buffered event this filter accepts that nobody has been given
  // yet, or null. Used by nextInterrupt to answer from the buffer.
  pending (only = null) {
    const allowed = only ? new Set(only) : null
    for (const ev of this.buffer) {
      if (!PENDING_WAKES.has(ev.type)) continue
      if (allowed ? allowed.has(ev.type) : INTERRUPTING.has(ev.type)) return ev
    }
    return null
  }

  // Resolves with the next interrupting event. Never rejects.
  // `only` narrows which types count: a fight takes damage constantly, so it
  // must not treat damage as a reason to stop and think.
  nextInterrupt (only = null) {
    // Already waiting for an answer: resolve now instead of parking behind a
    // sleep that will hand the same text over a minute later.
    const already = this.pending(only)
    if (already) {
      const done = Promise.resolve(already)
      done.cancel = () => {}
      return done
    }

    const allowed = only ? new Set(only) : null
    let waiter
    const p = new Promise(resolve => {
      waiter = { resolve, accepts: type => (allowed ? allowed.has(type) : INTERRUPTING.has(type)) }
      this.waiters.add(waiter)
    })
    p.cancel = () => this.waiters.delete(waiter)
    return p
  }

  // Hand over everything that accumulated and clear the buffer.
  drain () {
    const out = this.buffer
    this.buffer = []
    return out
  }
}

module.exports = { EventBus, INTERRUPTING, WAKES, QUIET_DAMAGE }
