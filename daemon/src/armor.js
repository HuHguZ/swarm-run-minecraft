'use strict'
const gameClock = require('./game-clock')
const { sleep } = require('./movement')

// Putting armour on. mineflayer never does it by itself, and the bot has spent
// whole nights carrying a full iron set in its backpack while being beaten to
// death in a shirt.
//
// The numbers have to live here: minecraft-data 3.112.0 knows nothing about
// armour on 1.21.11. An item record is exactly {id, name, displayName,
// stackSize, enchantCategories, repairWith, maxDurability} — `armor` and
// `armorMaterials` are undefined and there is no armour file anywhere in the
// package. The table below came out of this server's own jar via the vanilla
// data generator (minecraft:attribute_modifiers), so it is what the server
// actually applies — copper armour included, which shipped in 1.21 and which
// most published tables still omit.
//
// Two things are deliberately NOT in the table. Knockback resistance: only
// netherite has any, and netherite already wins every comparison on toughness,
// so it could never decide anything. Durability: item.maxDurability from
// minecraft-data is verified correct for all 29 pieces, and one source of
// truth beats two.

// ---------------------------------------------------------------- table

const ARMOR = {
  leather_helmet: { dest: 'head', points: 1, tough: 0 },
  leather_chestplate: { dest: 'torso', points: 3, tough: 0 },
  leather_leggings: { dest: 'legs', points: 2, tough: 0 },
  leather_boots: { dest: 'feet', points: 1, tough: 0 },

  copper_helmet: { dest: 'head', points: 2, tough: 0 },
  copper_chestplate: { dest: 'torso', points: 4, tough: 0 },
  copper_leggings: { dest: 'legs', points: 3, tough: 0 },
  copper_boots: { dest: 'feet', points: 1, tough: 0 },

  golden_helmet: { dest: 'head', points: 2, tough: 0 },
  golden_chestplate: { dest: 'torso', points: 5, tough: 0 },
  golden_leggings: { dest: 'legs', points: 3, tough: 0 },
  golden_boots: { dest: 'feet', points: 1, tough: 0 },

  chainmail_helmet: { dest: 'head', points: 2, tough: 0 },
  chainmail_chestplate: { dest: 'torso', points: 5, tough: 0 },
  chainmail_leggings: { dest: 'legs', points: 4, tough: 0 },
  chainmail_boots: { dest: 'feet', points: 1, tough: 0 },

  iron_helmet: { dest: 'head', points: 2, tough: 0 },
  iron_chestplate: { dest: 'torso', points: 6, tough: 0 },
  iron_leggings: { dest: 'legs', points: 5, tough: 0 },
  iron_boots: { dest: 'feet', points: 2, tough: 0 },

  diamond_helmet: { dest: 'head', points: 3, tough: 2 },
  diamond_chestplate: { dest: 'torso', points: 8, tough: 2 },
  diamond_leggings: { dest: 'legs', points: 6, tough: 2 },
  diamond_boots: { dest: 'feet', points: 3, tough: 2 },

  netherite_helmet: { dest: 'head', points: 3, tough: 3 },
  netherite_chestplate: { dest: 'torso', points: 8, tough: 3 },
  netherite_leggings: { dest: 'legs', points: 6, tough: 3 },
  netherite_boots: { dest: 'feet', points: 3, tough: 3 },

  // Iron-grade protection with the best durability outside diamond, plus water
  // breathing on the surface. Nothing else here needs a special case.
  turtle_helmet: { dest: 'head', points: 2, tough: 0 }
}

// The whitelist above is the whole point: carved_pumpkin, elytra and the seven
// heads are all "equippable" with zero armour, so upgrading into one would
// strip the slot bare. Never derive a candidate from the equippable flag.

// mineflayer's own armour slot numbers (simple_inventory.js armorSlots).
// bot.inventory.items() is slots 9..44 only, so worn armour is invisible to
// every helper in items.js — a "do I already have a chestplate" check built on
// items() reports a fully armoured bot as naked and re-equips forever.
const SLOTS = [['head', 5], ['torso', 6], ['legs', 7], ['feet', 8]]

// The off-hand, out of the same table (simple_inventory.js:19). Not armour:
// it adds no points and can never compete with a chestplate. It lives here
// anyway because it is the same cursor, the same "mineflayer will not do it by
// itself", and the same failure — the bot carried a shield in the bag through
// every skeleton fight it lost, because nothing in the daemon ever put one on.
const OFF_HAND = 45

// ---------------------------------------------------------------- scoring

// A piece this worn shatters inside the next fight, and a slot that drops to
// zero mid-fight is worse than a slot that was never good.
const CLIFF = 0.1
// What counts as a replacement worth downgrading to. Swapping a dying diamond
// helmet for an iron one that is itself half gone only moves the problem.
const HEALTHY = 0.5
// Armour points we are willing to lose to keep a slot alive. Two is a helmet's
// worth; trading a diamond chestplate's eight for leather's three is not.
const DOWNGRADE = 2

// prismarine-item reads this off the item's `damage` component and returns
// null for anything unbreakable. It has not thrown for us, but this runs on a
// timer inside the autopilot, where an unhandled rejection is invisible.
function wear (item) {
  try { return item.durabilityUsed || 0 } catch { return 0 }
}

function percentLeft (item) {
  const max = item.maxDurability || 0
  if (!max) return null
  return Math.round(((max - wear(item)) / max) * 100)
}

function score (item) {
  const a = ARMOR[item.name]
  if (!a) return null
  const max = item.maxDurability || 0
  const left = max ? max - wear(item) : Infinity
  return { points: a.points, tough: a.tough, left, leftFrac: max ? left / max : 1 }
}

// Damage does not reduce protection — a diamond chestplate with 1 durability
// left still blocks all eight points, right up until it breaks. So durability
// is a tiebreak here and never part of the ranking.
function better (x, y) {
  if (!x) return false
  if (!y) return true
  if (x.points !== y.points) return x.points > y.points
  if (x.tough !== y.tough) return x.tough > y.tough
  return x.left > y.left
}

// Best piece for one slot out of everything we own, the worn one included.
function choose (candidates) {
  let best = null
  for (const c of candidates) if (better(c.score, best && best.score)) best = c
  if (!best || best.score.leftFrac >= CLIFF) return best

  let alt = null
  for (const c of candidates) {
    if (c === best || c.score.leftFrac < HEALTHY) continue
    if (best.score.points - c.score.points > DOWNGRADE) continue
    if (better(c.score, alt && alt.score)) alt = c
  }
  // Nothing healthy within range: wear the dying piece anyway. Refusing it
  // leaves the slot empty, which is strictly worse than one more fight of
  // protection.
  if (!alt) return best

  // The cliff rule may only ever spend armour points that belong to the piece
  // on the body. A dying spare in the BAG has no business demoting what we are
  // already wearing: iron at 30% was being traded for fresh leather because a
  // 5%-durability diamond helmet happened to be lying in the backpack, and
  // neither of those two had anything to do with the other.
  const worn = candidates.find(c => c.onBody)
  if (worn && worn !== best && better(worn.score, alt.score)) return worn
  return alt
}

// ---------------------------------------------------------------- reading

// Worn armour, straight out of the slots. Exported because perception.js
// builds its inventory from items() and therefore cannot see any of this.
function readWorn (bot) {
  const out = {}
  for (const [dest, slot] of SLOTS) {
    const it = bot.inventory.slots[slot]
    const a = it ? ARMOR[it.name] : null
    out[dest] = it
      ? { item: it.name, points: a ? a.points : 0, durability: percentLeft(it) }
      : null
  }
  return out
}

function defenseOf (worn) {
  return Object.values(worn).reduce((n, v) => n + (v ? v.points : 0), 0)
}

// Everything is decided before a single click happens: the cursor is shared
// with the autopilot's eating, so the less time spent clicking the better.
// Biggest gain first — an abort or a chest opening can cut the loop short at
// any step, and the chestplate is worth three helmets.
function planSwaps (bot) {
  const plan = []
  for (const [dest, slot] of SLOTS) {
    const worn = bot.inventory.slots[slot]
    const wornScore = worn ? score(worn) : null

    const candidates = []
    if (wornScore) candidates.push({ item: worn, score: wornScore, onBody: true })
    for (const it of bot.inventory.items()) {
      const a = ARMOR[it.name]
      if (!a || a.dest !== dest) continue
      candidates.push({ item: it, score: score(it), onBody: false })
    }

    const pick = choose(candidates)
    if (!pick || pick.onBody) continue
    // В Аду золото на теле держит пиглинов мирными (PiglinAi.isWearingSafeArmor,
    // paper-1.21.11: хватит одной вещи из #piglin_safe_armor). golden_helmet и
    // iron_helmet — оба по 2 очка, ничью решала прочность, и автопилот снимал
    // последнюю золотую вещь (NETHER.md §1, «Броня»). Последнюю — не снимаем.
    if (worn && /^golden_/.test(worn.name) && !/^golden_/.test(pick.item.name) &&
      bot.game && bot.game.dimension === 'the_nether' &&
      SLOTS.filter(([, s]) => { const it = bot.inventory.slots[s]; return it && /^golden_/.test(it.name) }).length <= 1) continue
    plan.push({
      dest,
      slot,
      name: pick.item.name,
      wear: wear(pick.item),
      was: worn ? worn.name : null,
      gain: pick.score.points - (wornScore ? wornScore.points : 0),
      // The only way gain goes negative: the cliff rule traded points for a
      // slot that will still be there after the fight. Say so out loud.
      note: wornScore && wornScore.leftFrac < CLIFF ? 'старое почти сломано' : undefined
    })
  }
  plan.sort((a, b) => b.gain - a.gain)
  // Appended after the sort rather than ranked with the rest: gain is armour
  // points and a shield has none, so it has no business displacing a chestplate
  // in the queue. Last is also where it belongs — an abort part way through the
  // plan should cost the cheapest item.
  const shield = shieldStep(bot)
  if (shield) plan.push(shield)
  return plan
}

// Only ever fills an EMPTY off-hand. Whatever is already in there was put there
// on purpose — a totem, a map, blocks for the left hand — and dressing the bot
// does not extend to evicting it.
function shieldStep (bot) {
  if (bot.inventory.slots[OFF_HAND]) return null
  const shield = bot.inventory.items().find(i => i.name === 'shield')
  if (!shield) return null
  return { dest: 'off-hand', slot: OFF_HAND, name: shield.name, wear: wear(shield), was: null, gain: 0 }
}

// Kept out of readWorn on purpose: defenseOf() sums points over everything
// readWorn returns, and a shield in that list would either contribute a fake
// point or force a zero special case into the one function that has to stay
// pure arithmetic.
function readOffHand (bot) {
  const it = bot.inventory.slots[OFF_HAND]
  return it ? { item: it.name, durability: percentLeft(it) } : null
}

// ---------------------------------------------------------------- equip

// Reasons the click must not be sent at all. Re-checked before every swap:
// another intent can open a chest between two pieces.
function whyNotEquip (bot) {
  // Unknown health means the first health packet has not landed yet, not a
  // corpse — the rest of the daemon reads it as 20 for exactly that reason.
  if ((bot.health ?? 20) <= 0) return 'мёртв — оденусь после респавна'
  // equip() clicks into bot.currentWindow when one is open, and slot 6 of a
  // chest is a chest slot: the chestplate goes into the box and whatever was
  // in the box ends up on the cursor. unequip() asserts against this; equip()
  // has no such guard.
  if (bot.currentWindow) return 'открыт сундук — броню не трогаю'
  // The server refuses inventory clicks from a sleeping player and says
  // nothing about it. Waking up to change clothes would also throw away the
  // night skip, which is the whole reason the bot is in bed.
  if (bot.isSleeping) return 'сплю — переоденусь утром'
  // Something else is mid-click; the autopilot eats on a 1s timer and moves
  // this same cursor. Stacking clicks strands an item on it, and then
  // moveSlotItem's recovery click puts the wrong thing back.
  if (bot.inventory.selectedItem) return 'руки заняты другим кликом'
  return null
}

// The plan was made a few clicks ago and item.slot is a snapshot: the previous
// swap, or the autopilot juggling food through the hotbar, may have moved the
// piece since. Find it again by what it is rather than by where it was — two
// stacks with the same name and the same damage are interchangeable.
function findAgain (bot, step) {
  return bot.inventory.items().find(i => i.name === step.name && wear(i) === step.wear) || null
}

async function swap (bot, step) {
  const item = findAgain(bot, step)
  if (!item) return { ok: false, why: 'пропало из инвентаря' }
  try {
    await bot.equip(item, step.dest)
  } catch (err) {
    return { ok: false, why: String((err && err.message) || err) }
  }
  return { ok: true }
}

// Damage is part of the check because a swap may be one iron helmet for a
// fresher iron helmet, and the name alone cannot tell those two apart.
function isWorn (bot, step) {
  const now = bot.inventory.slots[step.slot]
  return !!(now && now.name === step.name && wear(now) === step.wear)
}

// Armour slots get no acknowledgement on 1.21.11. clickWindow only awaits a
// server update for inventory slots 1..4 (the crafting output); for every
// other slot it applies the click to bot.inventory.slots ITSELF, through
// Window.acceptClick, and only then writes the packet. So a resolved
// bot.equip() and an immediate read of slots[5..8] are the same guess wearing
// two hats — reading the slot back straight away can never catch a refusal.
// What a refusal does produce is a correction a tick or two later, as set_slot
// on window 0. Hence: make all the clicks, sit out one settle window, then
// look. One wait for the whole plan, not one per piece.
async function settle (ctl, ms) {
  const deadline = gameClock.now() + ms
  while (gameClock.now() < deadline && !ctl.aborted) await sleep(50)
}

// Wear the best of what we are carrying. Cheap to call on a timer: with
// nothing to change it walks four slots and returns. Opens no window and
// leaves no goal running, so there is nothing to register on ctl.onAbort —
// the abort check between swaps is the whole cleanup.
async function equipBestArmor (session, ctl = {}, { confirmMs = 600 } = {}) {
  const bot = session.bot
  if (!bot || !bot.entity) throw new Error('бот не в игре')
  const settleMs = Math.max(200, Math.min(3000, confirmMs))

  const done = (equipped, stopped, skipped) => {
    const worn = readWorn(bot)
    return {
      equipped,
      worn,
      // The status header builds its inventory from bot.inventory.items(), which
      // is slots 9..44 — so a worn shield is invisible everywhere else in the
      // daemon. This is the only place that says what is on the left arm.
      offHand: readOffHand(bot),
      defense: defenseOf(worn),
      stopped: stopped || undefined,
      skipped: skipped.length ? skipped : undefined
    }
  }

  // Two swap loops at once corrupt the cursor exactly the way eating does, and
  // the autopilot timer will happily call this on top of the brain's own call.
  if (session.armorBusy) return done([], 'уже переодеваюсь', [])
  // Not "the way eating does" — literally eating. actions.eat moves the food to
  // the hand with bot.equip (actions.js:1103), which is the same moveSlotItem
  // and the same cursor. whyNotEquip below only catches the instant when
  // something is already ON the cursor; session.eating covers the whole meal,
  // and it is the flag the autopilot's own mouth already respects
  // (autopilot.js:456). This mattered the moment combat started calling us:
  // the autopilot eats on a one-second timer and a fight lasts a minute.
  if (session.eating) return done([], 'ем — броню надену после', [])
  const blocked = whyNotEquip(bot)
  if (blocked) return done([], blocked, [])

  const plan = planSwaps(bot)
  if (!plan.length) return done([], null, [])

  const clicked = []
  const skipped = []
  let stopped = null
  session.armorBusy = true
  try {
    for (const step of plan) {
      if (ctl.aborted) { stopped = 'прервано'; break }
      const stop = whyNotEquip(bot)
      if (stop) { stopped = stop; break }

      // A failed swap is not a failed action: the other three slots are still
      // worth filling, and the caller needs to see what actually got worn.
      const r = await swap(bot, step)
      if (r.ok) clicked.push(step)
      else skipped.push(`${step.dest}: ${r.why}`)
    }
    // Still holding armorBusy: nobody else may start clicking while the
    // server is being given its one chance to take any of this back.
    if (clicked.length) await settle(ctl, settleMs)
  } finally {
    session.armorBusy = false
  }

  const equipped = []
  for (const step of clicked) {
    if (isWorn(bot, step)) equipped.push({ slot: step.dest, item: step.name, was: step.was, note: step.note })
    else skipped.push(`${step.dest}: сервер не подтвердил`)
  }

  return done(equipped, stopped, skipped)
}

// What is on the body and what is still in the bag, for the status header and
// for "am I geared". Read-only — nothing here touches the cursor.
function armorReport (session) {
  const bot = session.bot
  if (!bot || !bot.entity) throw new Error('бот не в игре')
  const worn = readWorn(bot)
  return {
    worn,
    offHand: readOffHand(bot),
    defense: defenseOf(worn),
    better: planSwaps(bot).map(s => ({
      slot: s.dest, item: s.name, was: s.was, gain: s.gain, note: s.note
    }))
  }
}

module.exports = { equipBestArmor, armorReport, readWorn, readOffHand, defenseOf, ARMOR, OFF_HAND }
