'use strict'
// Сборы: клики — надеть броню при мобах рядом, взять оружие в руку, перевооружиться после дела.
import * as gameClock from '../game-clock'
import armor = require('../armor')
import { canSeePoint } from '../perception'
import { liveAttacker, HOSTILES, ARMOR_GAP } from '../combat'
import { ARMOR_CONFIRM_MS, bestMelee, meleeScore, HAND_SETTLE_MS, REARM_TIMEOUT_MS } from './table'
import { untilHandsFree, gone, cutShort, pause, handsBusy } from './needs'

// ------------------------------------------------------------------ clicks

// Who makes six blocks too close to dress, and who does not. Distance alone
// (nearestHostile) counted a zombie in the next cave through solid rock, and an
// enderman minding its own business — underground that blocked every dressing
// at the door for a mob that could not reach the body in the second the clicks
// cost. So: whatever is hitting us, or a hostile with a line of sight to us.
// The rest is still named, so «одевался» never reads as «никого не было».
function mobsNear (session) {
  const bot = session.bot
  const me = bot.entity.position
  let threat = null
  let quiet = null
  const hit = liveAttacker(session)
  if (hit && hit.position.distanceTo(me) < ARMOR_GAP) {
    threat = { e: hit, d: hit.position.distanceTo(me), how: 'и бьёт меня' }
  }
  // Piglins leave alone anyone wearing a piece of gold.
  const gold = (Object.values(armor.readWorn(bot)) as any[]).some((v : any) => v && /^golden_/.test(v.item))
  for (const e of ((Object.values(bot.entities || {}) as any[]) as any)) {
    if (!e || e === bot.entity || !e.name || !HOSTILES.has(e.name) || !e.position) continue
    const d = e.position.distanceTo(me)
    if (d >= ARMOR_GAP || (threat && threat.e === e)) continue
    const neutral = e.name === 'enderman' || (e.name === 'piglin' && gold)
    const seen = !neutral && canSeePoint(bot, e.position.offset(0, (e.height || 1.8) * 0.85, 0))
    if (seen) {
      if (!threat || d < threat.d) threat = { e, d, how: 'и видит меня' }
    } else if (!quiet || d < quiet.d) {
      quiet = { e, d, how: neutral ? 'не трогает, пока не трону' : 'за породой, меня не видит' }
    }
  }
  return { threat, quiet }
}

const blocks = d => Math.round(d * 10) / 10

export async function dress (session, sub, kit) {
  // Read-only first: a plan with nothing in it must cost neither a wait nor a
  // confirm window, and that is the case on every call after the first.
  if (!armor.armorReport(session).better.length) return

  // The doctrine combat.dressForFight already paid for: a full plan is eight
  // clicks and a confirm window, a second and more, and a zombie covers six
  // blocks in about three. Inside that the body goes as it is and the answer
  // says so — a drift's first move against a mob at three blocks is the wall,
  // not the chestplate. The weapon below is NOT held back by this: one click,
  // and the thing most wanted exactly when something is that close.
  const { threat, quiet } = mobsNear(session)
  if (threat) {
    const names = armor.armorReport(session).better.map(s => s.item).join(', ')
    kit.need.push({
      what: 'надеть броню',
      why: `в рюкзаке ${names} лучше надетого, но ${threat.e.name} в ${blocks(threat.d)} бл. ${threat.how} — ` +
        'переодеваться поздно, клики стоят секунду; пойду в чём есть, mc_armor, когда отобьёшься'
    })
    return
  }

  // Marked BEFORE the wait: a chat answer is summarised the instant it lands,
  // with no grace (session.runIntent), so what this step was doing has to be
  // readable from outside while it is still doing it.
  kit.pending = { kind: 'wait-armor', names: armor.armorReport(session).better.map(s => s.item).join(', '), busy: null }
  const busy = await untilHandsFree(session, sub, why => { kit.pending.busy = why })
  kit.pending = null
  if (gone(session)) return
  // Re-planned after the wait: the tick we waited out may well have been the
  // autopilot dressing the body itself, and then there is nothing left to do.
  const plan = armor.armorReport(session).better
  if (!plan.length) return
  const names = plan.map(s => s.item).join(', ')
  if (busy) {
    kit.need.push({
      what: 'надеть броню',
      why: sub.why === 'budget'
        ? `в рюкзаке ${names} лучше надетого, а надеть ${cutShort(sub)} (${busy}) — пойду в чём есть; mc_armor, как освободится`
        : `в рюкзаке ${names} лучше надетого; надеть не успел (${busy}), а ${cutShort(sub)} — mc_armor, как освободится`
    })
    return
  }

  kit.pending = { kind: 'clicks-armor', names }
  const r = await armor.equipBestArmor(session, sub, { confirmMs: ARMOR_CONFIRM_MS })
  kit.pending = null
  const pieces = r.equipped.filter(e => e.slot !== 'off-hand').map(e => e.item)
  const shield = r.equipped.some(e => e.slot === 'off-hand')
  const what = [...pieces, ...(shield ? ['щит в левую руку'] : [])].join(', ')
  if (what) {
    // An abort cuts armor.settle short, and isWorn then reads back the client's
    // own guess (armor.js:285): «надел» would be a claim the server never had
    // its window to take back.
    if (sub.aborted) {
      kit.skipped.push(`${what}: кликнул, а подтверждения сервера не дождался — ${cutShort(sub)}; что на теле, покажет mc_armor`)
    } else {
      kit.did.push(`надел ${what}${pieces.length ? ` (броня ${r.defense})` : ''}` +
        (quiet ? `; ${quiet.e.name} в ${blocks(quiet.d)} бл., но ${quiet.how}` : ''))
    }
  }
  if (r.skipped) for (const s of r.skipped) kit.skipped.push(`броня ${s}`)
  if (sub.aborted) {
    // Clicked pieces are already said above with the same reason; only a cut
    // that left nothing clicked at all still owes the brain the bag's armour.
    if (!r.equipped.length) {
      kit.need.push({
        what: 'надеть броню',
        why: `в рюкзаке ${names} лучше надетого, а надеть не вышло (${cutShort(sub)}) — ` +
          (sub.why === 'budget' ? 'пойду в чём есть; ' : '') + 'mc_armor, как освободится'
      })
    }
    return
  }
  if (r.stopped && !r.equipped.length) {
    kit.need.push({
      what: 'надеть броню',
      why: `в рюкзаке ${names} лучше надетого, а надеть не вышло (${r.stopped}) — пойду в чём есть; mc_armor, как освободится`
    })
  } else if (r.stopped) {
    kit.skipped.push(`броня: ${r.stopped}`)
  }
}

// mineflayer's equip throws its own English («Server rejected transaction…»).
// The brain gets the Russian of what it means, with the raw text kept whole in
// quotes for whoever reads the logs.
function refusal (err) {
  return `клик не прошёл («${String((err && err.message) || err)}»)`
}

export async function arm (session, sub, kit) {
  const bot = session.bot
  const best = bestMelee(bot)
  if (!best) return
  const held = bot.heldItem
  if (meleeScore(held) >= meleeScore(best)) return

  kit.pending = { kind: 'wait-hand', name: best.name, busy: null }
  const busy = await untilHandsFree(session, sub, why => { kit.pending.busy = why })
  kit.pending = null
  if (gone(session)) return
  if (busy) { kit.skipped.push(`${best.name} в руку не взял (${busy}) — ${cutShort(sub)}`); return }
  // The item object is a snapshot and the wait above may have moved it (a meal
  // juggles the hotbar); found again by name, the way armor.js findAgain does.
  const again = bot.inventory.items().find(i => i.name === best.name)
  if (!again) { kit.skipped.push(`${best.name} пропал из рюкзака, пока ждал`); return }

  // The flag armor.js guards the cursor with. Held for the click and its settle
  // so an armour call that lands in between answers «уже переодеваюсь» instead of
  // clicking on top of us.
  session.armorBusy = true
  kit.pending = { kind: 'clicks-hand', name: best.name }
  let why = null
  try {
    await bot.equip(again, 'hand')
    const until = gameClock.now() + HAND_SETTLE_MS
    while (gameClock.now() < until && !sub.aborted) await pause(50)
  } catch (err) {
    why = refusal(err)
  } finally {
    session.armorBusy = false
    kit.pending = null
  }
  const now = bot.heldItem
  if (now && now.name === best.name) {
    if (sub.aborted) kit.skipped.push(`${best.name} в руку: кликнул, а подтверждения не дождался — ${cutShort(sub)}`)
    else kit.did.push(`взял в руку ${best.name}${held ? ` вместо ${held.name}` : ''}`)
  } else {
    kit.skipped.push(`${best.name} в руку не встал${why ? `: ${why}` : ''}`)
  }
}

// The door is not where the fight is. Every digger takes the pickaxe back into
// the hand — actions.digStairs calls items.equipBestTool before each cut, and
// pathfinder does the same for any block on its path — so the sword arm() put
// there is gone by the bottom of a staircase, and the bottom of recover's
// staircase is the pile, where whatever killed us usually still stands.
// Called by the digger at the moment the hand matters (survival.recoverLoot).
// No wait and no words: while the intent runs the autopilot cannot start a
// meal or a swap (bodyBusy), and a hand busy anyway is simply left as it is.
// Returns the name taken into the hand, or null.
export async function rearm (session, ctl) {
  const bot = session.bot
  if (!bot || !bot.entity || !bot.inventory || (ctl && ctl.aborted)) return null
  const best = bestMelee(bot)
  if (!best || meleeScore(bot.heldItem) >= meleeScore(best)) return null
  if (handsBusy(session)) return null
  session.armorBusy = true
  let timer = null
  try {
    await Promise.race([
      bot.equip(best, 'hand'),
      new Promise<any>((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('timeout')), REARM_TIMEOUT_MS) })
    ])
  } catch {
    return null
  } finally {
    gameClock.clearTimeout(timer)
    session.armorBusy = false
  }
  const now = bot.heldItem
  return now && now.name === best.name ? best.name : null
}
