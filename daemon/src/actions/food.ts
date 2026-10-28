'use strict'
// Еда и рука: equip, выбор еды (RISKY_FOOD, bestFood), еда с проверкой сытости (eat), drop.
// ---------------------------------------------------------------- equip / eat / drop
const gameClock: typeof import('../game-clock') = require('../game-clock')
const { sleep }: typeof import('../movement') = require('../movement')
const { itemNamed }: typeof import('../items') = require('../items')
async function equip (session, { item: name, destination = 'hand' }: any = {}) {
  const bot = session.bot
  const item = itemNamed(bot, name)
  if (!item) throw new Error(`нет ${name} в инвентаре`)
  await bot.equip(item, destination)
  return { equipped: name, destination }
}

// Things that feed you and then hurt you. Eaten only when there is nothing
// else, because a bot that clears a cave comes home with a bag of rotten flesh.
const RISKY_FOOD = /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chicken|suspicious_stew)$/

// minecraft-data 1.21.11 lists salmon_bucket / cod_bucket / pufferfish_bucket /
// tropical_fish_bucket in foodsByName, and they are not edible at all — using
// one spills a fish on the floor. Their score (3.6) beats rotten flesh (-89.6),
// so without this the bag-of-flesh case picks a bucket and eats nothing.
const NOT_ACTUALLY_FOOD = /_bucket$/

// mineflayer refuses to consume anything else at food 20 ("Food is full").
const ALWAYS_EDIBLE = /^(potion|milk_bucket|honey_bottle|golden_apple|enchanted_golden_apple)$/

// A bite takes 1.61s in vanilla; mineflayer waits 2.5s for its own confirmation
// packet before giving up. 4s covers both plus server lag, and the poll returns
// the instant the food bar actually moves, so the normal case still costs ~1.6s.
const EAT_WATCH_MS = 4000

// Equipping a meal moves its whole stack out of inventory.items() (slots 9..44).
// Slot 45 is still carried food; moving it is not a witnessed bite.
function mealItems (bot) {
  const bag = bot.inventory.items()
  const off = bot.inventory.slots?.[45]
  return off && !bag.some(i => i === off || i.slot === 45) ? [...bag, off] : bag
}

function bestFood (bot, mcData) {
  const edible = mealItems(bot)
    .filter(i => !NOT_ACTUALLY_FOOD.test(i.name))
    .map(i => ({ item: i, data: mcData.foodsByName[i.name] }))
    .filter(e => e.data)
  if (!edible.length) return null
  const score = e => (e.data.foodPoints || 0) + (e.data.saturation || 0) - (RISKY_FOOD.test(e.item.name) ? 100 : 0)
  edible.sort((a, b) => score(b) - score(a))
  return edible[0].item
}

// The bar, not the promise. bot.consume() resolves on a confirmation packet the
// server may never send, and it is aborted outright by any second bite —
// including the autopilot's, which fires every second below food 16 and cancels
// ours with "Consuming cancelled due to calling bot.consume() again". If the
// food bar went up, the bot ate, whatever the promise says.
async function untilFoodRises (bot, before, timeoutMs, giveUp) {
  const deadline = gameClock.now() + timeoutMs
  while (gameClock.now() < deadline) {
    if ((bot.food ?? 0) > before) return true
    if (giveUp && giveUp()) break
    await sleep(200)
  }
  return (bot.food ?? 0) > before
}

// The next failure has to be diagnosable from one run, so the full original text
// goes into the answer. mineflayer throws plain Errors, node AssertionError and
// TypeError on this path, and a bare "Cannot read properties of null" says
// nothing about which of them it was or where it came from.
function describeFailure (err, during) {
  if (!err) return null
  const name = (err && err.name) || typeof err
  const message = String((err && err.message) || err)
  const at = err && err.stack
    ? String(err.stack).split('\n').slice(1, 3).map(s => s.trim()).join(' <- ')
    : null
  const out: any = { during, error: `${name}: ${message}` }
  if (at) out.at = at
  return out
}

// The captured Item object goes stale the moment the server resyncs a slot: its
// .slot then points at whatever moved in, so re-equipping by that reference puts
// the wrong thing in the hand — or clicks slot undefined and throws an
// AssertionError over an otherwise successful meal. Look the item up again by
// type, and never let this step decide the outcome.
async function restoreHand (bot, previous, food) {
  if (!previous || previous.type === food.type) return null
  try {
    const again = mealItems(bot).find(i => i.type === previous.type)
    if (!again) return { error: `прежний предмет (${previous.name}) в руку не вернулся: его больше нет в инвентаре` }
    await bot.equip(again, 'hand')
    return null
  } catch (err) {
    return describeFailure(err, 'вернуть предмет в руку')
  }
}

// Never rejects. Every failure here is recoverable — no food, a full bar, a bite
// the server ignored — and rejecting turns all of them into one WebSocket error
// with no detail at all: that is exactly the pair of "поесть RPC null" lines in
// diamond4.log, one of which was a bot that had just died with an empty bag.
async function eat (session, { item: name }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const foodBefore = bot.food ?? 0

  // A full bar is not a failure, and mineflayer's raw "Food is full" reaching
  // the brain as an error is worse than useless — it reads as "eating is
  // broken". Health regenerates on its own above 18 food, so the honest answer
  // is that there is nothing to do here.
  if (!name && foodBefore >= 20) {
    return { note: 'сыт, есть не стал — здоровье и так восстанавливается', food: Math.round(foodBefore) }
  }

  const food = name ? mealItems(bot).find(i => i.name === name) : bestFood(bot, mcData)
  if (!food) {
    return {
      ate: null,
      note: name ? `нет ${name} в инвентаре` : 'еды в инвентаре нет',
      food: Math.round(foodBefore),
      slotsUsed: bot.inventory.items().length,
      offHand: bot.inventory.slots?.[45] ? { item: bot.inventory.slots[45].name, count: bot.inventory.slots[45].count } : null
    }
  }

  // Asking the world first is both faster and a better answer than relaying
  // mineflayer's exception for the same thing.
  if (foodBefore >= 20 && !ALWAYS_EDIBLE.test(food.name)) {
    return { note: 'сыт, есть не стал', food: Math.round(foodBefore), tried: food.name }
  }

  const owned = n => mealItems(bot).reduce((s, i) => s + (i.name === n ? i.count : 0), 0)
  const hadCount = owned(food.name)
  // Еда — immediate: session.current — чужое намерение, часто уже прерванное тактикой (sr-1010 10.10: «не поел» за 2 тика при
  // 12 стейках, хп 13 → 6 → смерть). Сдаваться — только если его прервали во время еды.
  const ctl0 = session.current?.ctl
  const aborted0 = !!ctl0?.aborted
  const stopped = () => !aborted0 && !!ctl0?.aborted
  const previous = bot.heldItem
  const { consumeInOffhand, restoreOffhand }: typeof import('../consumable-hands') = require('../consumable-hands')
  const offHand = consumeInOffhand(bot)
  const previousOff = bot.inventory.slots?.[45]

  let failure = null
  try {
    await bot.equip(food, offHand ? 'off-hand' : 'hand')
  } catch (err) {
    failure = describeFailure(err, 'взять еду в руку')
  }

  if (!failure && !stopped()) {
    let thrown = null
    // Started, never awaited as the verdict: its rejection is only evidence.
    const consuming = (offHand || food.name === 'honey_bottle' ? Promise.resolve().then(() => bot.activateItem(offHand)) : bot.consume()).then(() => null, err => { thrown = err })
    // Only one rejection is allowed to cut the watch short. "Food is full" is
    // refused before any packet leaves, so nothing can happen afterwards; every
    // other rejection — the cancelled bite above especially — still leaves a
    // meal in flight, and bailing on it would throw away a successful one.
    const fed = await untilFoodRises(bot, foodBefore, EAT_WATCH_MS,
      () => owned(food.name) < hadCount || stopped() || !!thrown && /food is full/i.test(String((thrown && thrown.message) || thrown)))
    if (!fed && owned(food.name) >= hadCount) {
      await consuming
      failure = describeFailure(thrown, 'съесть') ||
        { during: 'съесть', error: 'ошибки не было, но сытость не выросла за 4с' }
    }
  }

  let handBack = null
  if (offHand) {
    try { bot.deactivateItem(); await restoreOffhand(bot, previousOff, food) } catch (err) { handBack = describeFailure(err, 'вернуть предмет во вторую руку') }
  } else handBack = await restoreHand(bot, previous, food)
  // Keep the remaining meal in the spendable bag, including a resumed stack
  // left in the second hand by an earlier interrupted meal. Preserve new gear.
  const remaining = bot.inventory.slots?.[45]
  if (remaining && (remaining.name === food.name || remaining.name === previousOff?.name) &&
      mcData.foodsByName[remaining.name] && !NOT_ACTUALLY_FOOD.test(remaining.name) && bot.inventory.emptySlotCount() > 0) {
    try { await bot.unequip('off-hand') } catch (err) { handBack = describeFailure(err, 'вернуть остаток еды в рюкзак') }
  }
  const foodAfter = bot.food ?? 0
  // Two independent witnesses, because either one alone can lie: the bar does
  // not move if exhaustion spends the point in the same second (digging and
  // fighting both do that), and the stack does not shrink if it was the
  // autopilot's bite that fed us.
  const spent = hadCount - owned(food.name)

  if (foodAfter > foodBefore || spent > 0) {
    const out: any = { ate: food.name, hand: offHand ? 'off-hand' : 'hand', food: Math.round(foodAfter), gain: Math.round(foodAfter - foodBefore), spent }
    if (spent <= 0) out.note = 'сытость выросла, но свой кусок цел — успел автопилот'
    if (foodAfter <= foodBefore) out.note = 'кусок съеден, но полоска не выросла — голод съедает быстрее'
    // Kept even on success: this is the only place the cancelled-bite text ever
    // shows up once the world says the meal happened anyway.
    if (failure) out.despite = failure.error
    if (handBack) out.handBack = handBack.error
    return out
  }

  if (failure && /food is full/i.test(failure.error)) {
    return { note: 'сыт, есть не стал', food: Math.round(foodAfter), tried: food.name }
  }

  // Everything the next run needs to tell the cases apart without a third
  // attempt: an open window makes equip click the wrong slots, and a running
  // intent means something else was moving the same inventory at the same time.
  const out: any = {
    ate: null,
    note: 'не поел',
    tried: food.name,
    food: Math.round(foodAfter),
    held: bot.heldItem ? bot.heldItem.name : null,
    windowOpen: bot.currentWindow ? (bot.currentWindow.type || bot.currentWindow.id) : null,
    busy: session.current ? session.current.name : null,
    offHand: bot.inventory.slots?.[45] ? { item: bot.inventory.slots[45].name, count: bot.inventory.slots[45].count } : null
  }
  Object.assign(out, failure)
  if (handBack) out.handBack = handBack.error
  return out
}

async function drop (session, { item: name, count }: any = {}) {
  const bot = session.bot
  const item = itemNamed(bot, name)
  if (!item) throw new Error(`нет ${name} в инвентаре`)
  await bot.toss(item.type, null, count ?? item.count)
  return { dropped: name, count: count ?? item.count }
}

export { equip, RISKY_FOOD, NOT_ACTUALLY_FOOD, bestFood, eat, drop }
