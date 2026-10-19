'use strict'
// Сборы: preflight (нужды навыка → руки и броня → отказ с подсказкой), свежий набор, сводка.
import * as gameClock from '../game-clock'
import { PREFLIGHT_MS, bestMelee, meleeScore } from './table'
import { torchNeed, foodNeed, weaponNeed, shieldNeed, gone, cutShort } from './needs'
import { dress, arm } from './clicks'

// ------------------------------------------------------------------ run

export function freshKit () {
  return { started: gameClock.now(), did: [], skipped: [], need: [], error: null, ms: null, pending: null }
}

// Never rejects: a preflight that throws must not cost the intent it guards.
// A throw is still not swallowed — it rides on the answer as `error`, because a
// check that silently stopped checking reads exactly like «всё на месте».
//
// `kit` is filled in as the checks run rather than returned at the end, so a
// chat that lands mid-swap still leaves whatever was already found for
// runIntent to attach — and `kit.pending` says what the step in progress was.
export async function preflight (session, ctl, spec, kit) {
  const sub = { aborted: false, why: null, onAbort: [] }
  const stop = why => {
    if (sub.aborted) return
    sub.aborted = true
    sub.why = why
    for (const fn of sub.onAbort) { try { fn() } catch {} }
  }
  ctl.onAbort.push(() => stop('ended'))
  // The hook above only hears an abort that comes AFTER it. The next exclusive
  // runIntent in the same tick aborts this ctl before the microtask that calls
  // us has run, and then nothing ever told the check: the chestplate was
  // clicked while the intent that replaced this one held the cursor
  // (reproduced: goto cancelled by craft, one torso click inside the craft).
  if (ctl.aborted) stop('ended')
  const timer = gameClock.setTimeout(() => stop('budget'), PREFLIGHT_MS)
  try {
    // One macrotask before anything is read or clicked. An interrupt that was
    // already waiting in the bus (events.js pending) resolves runIntent's race
    // in microtasks; this lets its abort land first, so a person who spoke
    // before the call does not get a swap clicked in front of the answer.
    // setImmediate and not gameClock.setTimeout(0): the timer is ~15 ms on Windows, and
    // this is paid by every table intent, including the ones with nothing to do.
    await new Promise<any>(resolve => setImmediate(resolve))
    const bot = session.bot
    if (sub.aborted || !bot || !bot.entity || !bot.inventory) return kit

    // Reads first. They cost nothing and are true whatever happens to the
    // clicks below, so an interrupt in the middle of a swap still reports them.
    if (spec.torches) torchNeed(bot, session.mcData, spec.torches, kit)
    if (spec.food) foodNeed(bot, session.mcData, spec.food, kit)
    if (spec.weapon === 'need') weaponNeed(session, spec, kit)
    if (spec.shield) shieldNeed(session, spec, kit)

    // Armour before the hand: the chestplate is worth more than the sword if
    // the budget runs out between the two.
    if (spec.armor && !sub.aborted) await dress(session, sub, kit)
    if (spec.weapon && !gone(session)) {
      if (!sub.aborted) {
        await arm(session, sub, kit)
      } else {
        // The armour spent the time. A better weapon left in the bag is still a
        // fact about the trip, and silence here read as «рука в порядке».
        const best = bestMelee(bot)
        if (best && meleeScore(bot.heldItem) < meleeScore(best)) {
          kit.skipped.push(`${best.name} в руку не брал — ${cutShort(sub)}`)
        }
      }
    }
  } catch (err) {
    kit.pending = null
    // A body that left mid-check (kicked, disconnected) makes every read throw
    // «бот не в игре». That is not a check that broke, and the status line of
    // the same answer already says where the body went.
    if (!(sub.why === 'ended' && gone(session))) kit.error = String((err && err.message) || err)
  } finally {
    gameClock.clearTimeout(timer)
    kit.ms = gameClock.now() - kit.started
  }
  return kit
}

// What goes on the answer: a copy, so a preflight still unwinding after a chat
// answer cannot change what that answer said, and nothing at all when there is
// nothing to say — a dressed, armed, lit, fed body costs the brain zero lines.
//
// runIntent calls this only after ctl.abort(), on every ending. A `pending`
// still set here therefore means one thing: the check was cut off mid-step and
// the answer is going out without it (chat gets no grace) — and the worker,
// which starts only after the check returns, will not start at all.
export function summary (kit) {
  if (!kit) return undefined
  const did = kit.did.slice()
  const skipped = kit.skipped.slice()
  const need = kit.need.map(n => ({ ...n }))
  const p = kit.pending
  if (p && p.kind === 'wait-armor') {
    need.push({
      what: 'надеть броню',
      why: `в рюкзаке ${p.names} лучше надетого; ждал, пока освободятся руки${p.busy ? ` (${p.busy})` : ''}, ` +
        'и тут работу прервали — к ней не приступал; mc_armor, как освободится'
    })
  } else if (p && p.kind === 'clicks-armor') {
    skipped.push(`${p.names}: надевал, когда работу прервали, — подтверждения сервера не дождался; что на теле, покажет mc_armor`)
  } else if (p && p.kind === 'wait-hand') {
    skipped.push(`${p.name} в руку не взял: ждал руки${p.busy ? ` (${p.busy})` : ''}, а работу прервали`)
  } else if (p && p.kind === 'clicks-hand') {
    skipped.push(`${p.name} в руку: кликнул, когда работу прервали, — подтверждения не дождался`)
  }
  const out: any = {}
  if (did.length) out.did = did
  if (skipped.length) out.skipped = skipped
  if (need.length) out.need = need
  if (kit.error) out.error = kit.error
  if (!Object.keys(out).length) return undefined
  out.ms = kit.ms ?? (gameClock.now() - kit.started)
  return out
}
