'use strict'
const gameClock = require('./game-clock')
const armor = require('./armor')
const { countOf, craftPlan, plankCount, spendablePlanks, GROUPS, TABLE_PLANKS } = require('./items')
const actions = require('./actions')
const { canSeePoint } = require('./perception')
// No cycle: combat pulls armor, items, build, actions and social, none of which
// knows this file.
const { liveAttacker, HOSTILES, ARMOR_GAP, SWING_MS } = require('./combat')

// What a long intent needs on the body before it leaves, checked once, in one
// place, at the door (session.runIntent).
//
// The tool half of this question already had a good answer — the staircase
// prices the pickaxe with the way back included (items.toolShortfall) — and the
// rest had none. Armour was put on by exactly one thing, the autopilot timer,
// and that timer stands down for the whole of every intent (autopilot.js
// bodyBusy). Only `fight` dressed itself. Torches were checked lazily and in
// silence — `if (!itemNamed(bot, 'torch')) return false` in mining.js,
// actions.js and survival.js — so a drift walked into the dark and found out
// twenty blocks in, and nobody was ever told. The worst of it was `recover`:
// it walks to the pile of the last death, which is where whatever did the
// killing is standing, holding whatever happened to be in hand.
//
// Two kinds of answer, and the line between them is who gets to decide:
//   did  — armour that is already in the bag, a better weapon than the one in
//          hand. No decision in it; the autopilot would have done the same on
//          its next idle tick. Done here, bounded, and reported.
//   need — no torches for a drift, no food for a long way down, no shield for
//          the graveyard. Only the brain can weigh those, so they are NOT a
//          refusal: the intent runs anyway and the words ride on the answer.
//          Same shape escort already gives hunger (escort.js need), plus a
//          sentence, because {what, count, have} alone says nothing about why.

// ------------------------------------------------------------------ budget

// The whole preflight, clicks and waiting included. It runs INSIDE the intent,
// so it is paid out of the intent's own timeout (runIntent's clock is already
// running) — and three seconds is well under the 15-25 seconds every long
// intent with a deadline of its own keeps over that deadline (session.js), so
// the ordinary way for work to end stays a `done` with a report, not a bare
// clock. (`mine` has no deadline of its own and no margin; there the clock is
// the only stop anyway, and three seconds of 180 is what it costs.) The normal
// case is far less: an armour plan is a few local clicks plus one confirm
// window (armor.js settle), and with nothing to change it is a read. A click
// already sent when the three seconds run out still finishes: mineflayer holds
// a hotbar click for up to DIG_CLICK_TIMEOUT (500 ms) after a dig.
const PREFLIGHT_MS = 3000

// Same confirm window combat.dressForFight settled on for the same clicks.
const ARMOR_CONFIRM_MS = 400

// A hand swap is one or two clicks; the server corrects a refused one a tick or
// two later (armor.js:285 explains why a resolved equip proves nothing).
const HAND_SETTLE_MS = 250

// survival.js holds its own hand swaps to the same five seconds (withTimeout
// around bot.equip): a click is a round trip, and a digger must not park on one.
const REARM_TIMEOUT_MS = 5000

const POLL_MS = 100

// Food points, not items: «одна морковка» and «один стейк» are three and eight.
// Walking costs no hunger at all and a staircase costs very little; what eats
// the bar underground is healing, and natural regeneration stops below 18. So
// this is not «what the trip burns» but «one real heal after the first mob» —
// one steak, or two bread.
const FOOD_FOR_TRIP = 8

// When a dig is a trip at all: forty-eight cells of rock. That is the sixteen-
// level staircase dig_down has asked food for since the table was written
// (three cells a level: head, middle, low — items.SWINGS_PER_LEVEL), and the
// same rock in a drift is 24 blocks of a 1×2 corridor. Asking by the rock and
// not by the length is what keeps the two diggers on one rule: a default
// 16-block drift is 32 cells and asked for a steak on every call of a loop,
// ~300 characters a time, while a 16-level staircase is 48 and a 2-block drift
// asked exactly as loudly.
const FOOD_FROM_CELLS = 48
const STAIR_CELLS_PER_LEVEL = 3

// ------------------------------------------------------------------ weapons

// Damage and attack speed of every sword and axe on this server, out of its own
// jar (vanilla data generator, reports/items.json, minecraft:attribute_modifiers
// on top of the player's base 1 damage and 4 attacks a second). minecraft-data
// 3.112.0 carries neither number, the same gap armor.js fills for armour.
const MELEE = {
  wooden_sword: [4, 1.6],
  golden_sword: [4, 1.6],
  stone_sword: [5, 1.6],
  copper_sword: [5, 1.6],
  iron_sword: [6, 1.6],
  diamond_sword: [7, 1.6],
  netherite_sword: [8, 1.6],
  wooden_axe: [7, 0.8],
  golden_axe: [7, 1.0],
  stone_axe: [9, 0.8],
  copper_axe: [9, 0.8],
  iron_axe: [9, 0.9],
  diamond_axe: [9, 1.0],
  netherite_axe: [10, 1.0]
}

// Damage a second at the pace combat.fight actually swings (SWING_MS), with
// vanilla's charge rule: a swing before the item's cooldown is up deals
// 0.2 + 0.8·charge² of its damage (Player.attack, getAttackStrengthScale(0.5)).
// items.bestWeapon's «any sword before any axe» put a wooden_sword (6.2 a
// second) in place of a diamond_axe (7.4) and called it a better weapon. At
// this pace a sword is always fully charged and an axe never is, so swords
// still win tier for tier — only the cross-tier cases change.
function meleeScore (item) {
  const m = item && MELEE[item.name]
  if (!m) return 0
  const [damage, speed] = m
  const charge = Math.min(1, (SWING_MS / 50 + 0.5) / (20 / speed))
  return damage * (0.2 + 0.8 * charge * charge) / (SWING_MS / 1000)
}

// Slots 9..44, the held item included (it lives in the hotbar), so «best» and
// «what is in hand» are asked of one list.
function bestMelee (bot) {
  let best = null
  let score = 0
  for (const i of bot.inventory.items()) {
    const s = meleeScore(i)
    if (s > score) { best = i; score = s }
  }
  return best
}

// ------------------------------------------------------------------ table

// Kept in step with actions.js by import where it is exported, and by the same
// literal where it is not yet: a bag of rotten flesh must not read as a packed
// lunch, and minecraft-data calls fish buckets food (actions.js bestFood).
const RISKY_FOOD = actions.RISKY_FOOD ||
  /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chicken|suspicious_stew)$/
const NOT_ACTUALLY_FOOD = actions.NOT_ACTUALLY_FOOD || /_bucket$/

// What the furnace makes of what the bag already holds. Named by the output,
// because that is what mc_smelt takes.
const COOKS_INTO = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  rabbit: 'cooked_rabbit',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato'
}

// mining.js clamp and MAX_LENGTH, so the torch count is priced on the drift
// that will actually be dug and not on the number that was asked for.
const MAX_LENGTH = 128

function clamp (value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

const modeOf = (p, fallback) => String((p && p.mode) || fallback).trim().toLowerCase()

// A torch every `every` cells over `span` cells, the way both diggers place
// them: tunnel on `step % every`, digStairs on `cut % torchEvery`.
function torchPlan (span, every, unit, what) {
  if (!(every > 0)) return null
  const count = Math.floor(span / every)
  return count > 0 ? { count, every, span, unit, what } : null
}

// Keyed on the name runIntent is called with (session.js), NOT on the MCP tool.
// Every entry is a function of the intent's own params, because the same name
// covers a five-block shaft and a hundred-level staircase.
//
// armor   — wear the best of the bag (armor.equipBestArmor: the autopilot's own
//           rule, cliff rule and shield-into-an-empty-off-hand included)
// weapon  — 'hand': take the best sword/axe if the hand holds worse;
//           'need': the same, and say so when there is no weapon at all
// shield  — say so when there is no shield anywhere
// torches — say so when the bag holds fewer than the lit corridor wants
// food    — say so when the bag holds fewer food points than this
//
// Deliberately absent, each for a reason:
//   fight   — dresses itself (combat.dressForFight) and knows the one thing
//             this cannot: how far away the mob is. Inside six blocks it fights
//             in what it has; a preflight here would click anyway.
//   give, stash, chest_put — dressing first would wear the very armour the brain
//             is about to hand over or put away, and handover refuses to give
//             worn armour without force.
//   craft, smelt, chest_take, chest_list, place — a window or a single click; a
//             swap there races the window for the cursor.
//   sleep, shelter — in bed the server refuses inventory clicks, and a shelter
//             is dug because there is no time.
//   wait, take — the brain listening, and a pickup two blocks away.
const NEEDS = {
  goto: () => ({ armor: true }),
  mine: () => ({ armor: true }),
  mine_seen: () => ({ armor: true }),
  portal: () => ({ armor: true }),
  surface: () => ({ armor: true }),
  // Only `go` walks. `set` stands a chest and a torch where the body already is.
  base: p => (modeOf(p, 'where') === 'go' ? { armor: true } : null),
  explore: () => ({ armor: true, weapon: 'hand' }),
  escort: () => ({ armor: true, weapon: 'hand' }),
  dig_down: p => {
    // Exactly the test session.digDown and actions.digDown make — no trim, no
    // case folding — or the preflight would price a staircase for a shaft.
    const stairs = p.mode === 'stairs' || p.mode === 'лестница'
    // The shaft places no torches and is the quick way to depth, not a trip.
    if (!stairs) return { armor: true }
    // digStairs' own defaults (actions.js), not session.digDown's `depth ?? 5`:
    // that one only prices the timeout, and the staircase digs p.depth or 16.
    // Destructuring defaults only replace undefined, so null is kept as null
    // here too: digStairs turns a null depth into one level and a null
    // torchEvery into no torches, and so does this.
    const depth = Math.max(1, Math.min(128, p.depth === undefined ? 16 : p.depth))
    const every = p.torchEvery === undefined ? 6 : p.torchEvery
    return {
      armor: true,
      torches: torchPlan(depth, every, 'уровня', `лесенка на ${depth} уровней`),
      food: depth * STAIR_CELLS_PER_LEVEL >= FOOD_FROM_CELLS ? FOOD_FOR_TRIP : 0
    }
  },
  tunnel: p => {
    const len = clamp(p.length === undefined ? 16 : p.length, 1, MAX_LENGTH, 16)
    const every = clamp(p.torchEvery === undefined ? 8 : p.torchEvery, 0, MAX_LENGTH, 8)
    // mining.js rounds a one-high request up to the body's two.
    const tall = clamp(p.height === undefined ? 2 : p.height, 2, 3, 2)
    return {
      armor: true,
      torches: torchPlan(len, every, 'блока', `штрек на ${len} блоков`),
      food: len * tall >= FOOD_FROM_CELLS ? FOOD_FOR_TRIP : 0
    }
  },
  // Food is not asked of recover: the usual caller has just respawned with an
  // empty bag and a full bar, and the pile is where the food is.
  //
  // `graveyard` is survival.recoverLoot's own split: explicit x and z are a
  // place the brain named — a stash dropped on purpose carries no death and no
  // clock — and only the argument-less and `index` forms walk to a death.
  recover: p => ({
    armor: true,
    weapon: 'need',
    shield: true,
    graveyard: !(p.x !== undefined && p.x !== null && p.z !== undefined && p.z !== null)
  })
}

// null means «nothing to check» and costs the caller nothing: no bot read, no
// timer, no extra tick. That is the whole contract for the short intents.
function requirements (name, params) {
  const entry = NEEDS[name]
  if (!entry) return null
  try {
    return entry(params || {}) || null
  } catch {
    // Params the action itself will reject in words; the preflight has no
    // business answering first and worse.
    return null
  }
}

// ------------------------------------------------------------------ reading

// Everything that moves the one cursor, the same list armor.js whyNotEquip
// asks plus the two flags other routines hold across a whole operation.
// session.crafting in particular: a craft through a table holds a window for
// seconds, and a swap clicked into it lands in the crafting grid.
function handsBusy (session) {
  const bot = session.bot
  if (!bot || !bot.entity) return 'бот не в игре'
  if ((bot.health ?? 20) <= 0) return 'мёртв'
  if (session.armorBusy) return 'автопилот переодевается'
  if (session.eating) return 'ем'
  if (session.crafting) return 'автопилот крафтит инструмент'
  if (bot.currentWindow) return 'открыто окно'
  if (bot.isSleeping) return 'сплю'
  if (bot.inventory.selectedItem) return 'на курсоре другой предмет'
  return null
}

// The body the kit was about is not there to hear it: kicked, disconnected or
// dead. After a death the bag is a pile on the floor, so «в рюкзаке X» and
// «пойду в чём есть» would both describe something that no longer exists.
function gone (session) {
  const bot = session.bot
  return !bot || !bot.entity || (bot.health ?? 20) <= 0
}

// How the check was cut short, in the words both halves of the answer use.
// 'ended'  — the intent itself is over (an interrupt, its clock, a cancel): the
//            worker will never start (session.runIntent checks ctl.aborted).
// 'budget' — only the three seconds of the check ran out: the work goes on.
function cutShort (sub) {
  return sub.why === 'budget'
    ? `за ${PREFLIGHT_MS / 1000} с проверки не успел`
    : 'работу прервали ещё до выхода'
}

// The autopilot cannot START anything while the intent runs — runIntent sets
// session.current before this is called and bodyBusy reads it — but a tick that
// began a moment earlier is still finishing its meal or its swap. Waiting it out
// is cheap; clicking over it strands an item on the cursor.
//
// The abort is asked FIRST. Asked after the hands, a wait cut short inside the
// very poll the hands came free in fell through as «free», and the caller
// clicked a sword into the hand after the chat answer had already gone out —
// reproduced with the meal ending at 130 ms and the chat landing at 170.
// Returns null (free, go on) or the reason it stopped waiting.
async function untilHandsFree (session, sub, onBusy) {
  let last = null
  for (;;) {
    if (sub.aborted) return handsBusy(session) || last || 'прервано'
    const why = handsBusy(session)
    if (!why) return null
    last = why
    if (onBusy) onBusy(why)
    await pause(POLL_MS, sub)
  }
}

function pause (ms, sub) {
  return new Promise(resolve => {
    if (sub && sub.aborted) return resolve()
    const t = gameClock.setTimeout(resolve, ms)
    if (sub) sub.onAbort.push(() => { gameClock.clearTimeout(t); resolve() })
  })
}

function foodInBag (bot, mcData) {
  let points = 0
  let risky = 0
  const foods = (mcData && mcData.foodsByName) || {}
  for (const i of bot.inventory.items()) {
    if (NOT_ACTUALLY_FOOD.test(i.name)) continue
    const f = foods[i.name]
    if (!f) continue
    if (RISKY_FOOD.test(i.name)) { risky += i.count; continue }
    points += (f.foodPoints || 0) * i.count
  }
  return { points, risky }
}

// ------------------------------------------------------------------ hints

// mc_equip (actions.equip) finds its item with items(), slots 9..44, so it
// cannot name anything in the left hand: «mc_equip item=torch» answers «нет
// torch в инвентаре» with 64 torches in slot 45. What it CAN do is put
// something ELSE into the left hand — mineflayer's moveSlotItem clicks source,
// off-hand, source, and the third click drops what the off-hand held into the
// bag slot the new item came from. A tool is never the thing offered: the
// diggers look for their pickaxe in items() too, and the hand's own stack
// would empty the hand.
const NOT_FOR_SWAP = /_(pickaxe|axe|shovel|hoe|sword)$|^(torch|shield|bucket)$|_bucket$/

// `moves` is the finished clause — «факелы переедут», «iron_sword переедет» —
// because Russian agrees the verb with what is moving.
function offHandSwap (bot, moves) {
  const bag = bot.inventory.items()
  const held = bot.heldItem ? bot.heldItem.name : null
  const pick = bag.find(i => i.name === 'shield') ||
    bag.find(i => i.name !== held && !NOT_FOR_SWAP.test(i.name))
  return pick ? `mc_equip item=${pick.name} destination=off-hand — ${moves} в рюкзак на его место` : null
}

// Russian counts one, few and many differently (mcp/src/format.js has the same).
function plural (n, one, few, many) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b === 1) return one
  if (b > 1 && b < 5) return few
  return many
}

// actions.craft makes exactly what it is asked for and never the sticks on the
// way (recipesFor with the bag as it is), so «mc_craft item=torch» with coal and
// no stick is a refusal. The advice walks the chain back to what the bag holds.
function torchCraftHint (bot, mcData, missing) {
  const coal = countOf(bot, 'coal') + countOf(bot, 'charcoal')
  if (!coal) return 'Угля в рюкзаке нет — скрафтить не из чего'
  const torch = `mc_craft item=torch count=${missing} (уголь и палка дают 4)`
  const sticks = countOf(bot, 'stick')
  if (sticks) return `Угля ${coal}, палок ${sticks} — ${torch}`
  const planks = spendablePlanks(bot, mcData)
  if (planks >= 2) return `Угля ${coal}, а палок нет — сперва mc_craft item=stick (свободных досок ${planks}), потом ${torch}`
  const log = bot.inventory.items().find(i => GROUPS.any_wood.test(i.name))
  const plank = log && log.name.replace(/^stripped_/, '').replace(/_(log|wood|stem|hyphae)$/, '_planks')
  if (plank && mcData && mcData.itemsByName && mcData.itemsByName[plank]) {
    return `Угля ${coal}, а палок и свободных досок нет — mc_craft item=${plank} из ${log.name}, ` +
      `потом mc_craft item=stick, потом ${torch}`
  }
  return `Угля ${coal}, а палку сделать не из чего: палок 0, досок ${plankCount(bot)} ` +
    `(${TABLE_PLANKS} держу на верстак), брёвен нет`
}

// ------------------------------------------------------------------ needs

function torchNeed (bot, mcData, t, kit) {
  const have = countOf(bot, 'torch')
  if (have >= t.count) return
  // Counted from the bag and not from slot 45 on purpose: that is where both
  // diggers take the next torch from (placeTorch -> itemNamed -> items()), so
  // torches in the left hand are torches the corridor will not get. The
  // difference is the advice: those need moving, not crafting.
  const off = bot.inventory.slots[armor.OFF_HAND]
  const inLeft = off && off.name === 'torch' ? off.count : 0
  let fix
  if (inLeft) {
    const swap = offHandSwap(bot, 'факелы переедут')
    fix = `Ещё ${inLeft} ${plural(inLeft, 'факел', 'факела', 'факелов')} у меня в левой руке, а ставлю я только из рюкзака — ` +
      (swap || 'положить в левую руку взамен нечего, в рюкзаке одни инструменты')
  } else {
    fix = torchCraftHint(bot, mcData, t.count - have)
  }
  kit.need.push({
    what: 'факелы',
    count: t.count,
    have,
    why:
      `${t.what} с факелом через ${t.every}: ` +
      (have ? `света хватит до ${have * t.every}-го ${t.unit}, дальше` : 'с первого же шага') +
      ' пойду в темноте, а в темноте за спиной спавнятся мобы. ' + fix +
      '; или зови с torchEvery=0, если свет не нужен'
  })
}

function foodNeed (bot, mcData, want, kit) {
  const { points, risky } = foodInBag(bot, mcData)
  if (points >= want) return
  const bar = Math.round(bot.food ?? 0)
  // Two different sentences: at 14 the regeneration has ALREADY stopped, and
  // «как упадёт ниже 18» said about a bar at 14 is a sentence that argues with
  // its own number.
  const state = bar < 18
    ? `сытость уже ${bar} — ниже 18 здоровье само не возвращается`
    : `сытость сейчас ${bar}; как упадёт ниже 18, здоровье само возвращаться перестанет`
  const foods = (mcData && mcData.foodsByName) || {}
  const raw = bot.inventory.items().find(i => COOKS_INTO[i.name] && foods[COOKS_INTO[i.name]])
  const fix = raw
    ? `Сырое в рюкзаке: ${raw.name}×${raw.count} — mc_smelt item=${COOKS_INTO[raw.name]} даст ` +
      `${foods[COOKS_INTO[raw.name]].foodPoints * raw.count} очков`
    : 'Хватит стейка (8) или двух хлебов (по 5); если они есть в общаке — mc_stash mode=take item=cooked_beef count=2'
  kit.need.push({
    what: 'еда',
    count: want,
    have: points,
    unit: 'очков сытости',
    why:
      `${state}, а подлечиться внизу больше нечем` +
      (risky ? ` (гнилой плоти и прочего сомнительного ${risky} — не в счёт)` : '') +
      `. ${fix} — или иди как есть, если поход короткий`
  })
}

function weaponNeed (session, spec, kit) {
  const bot = session.bot
  if (bestMelee(bot)) return
  const where = spec.graveyard
    ? 'иду туда, где меня убили, и то, что убило, скорее всего ещё там'
    : 'иду за вещами'
  const off = bot.inventory.slots[armor.OFF_HAND]
  if (off && MELEE[off.name]) {
    const swap = offHandSwap(bot, `${off.name} переедет`)
    kit.need.push({
      what: 'оружие в правую руку',
      why: `${where}, а ${off.name} у меня в левой руке — левой не бьют, и mc_equip его там не видит. ` +
        (swap ? `${swap}, потом mc_equip item=${off.name}` : 'Положить в левую руку взамен нечего')
    })
    return
  }
  let fix = ''
  try {
    const plan = craftPlan(bot, session.mcData, 'sword')
    if (plan && plan.ready) fix = `; из рюкзака выйдет ${plan.item} — mc_craft item=${plan.item}`
    else if (plan) {
      fix = `; скрафтить не из чего: на ${plan.item} не хватает ` +
        plan.missing.map(m => `${m.name}×${m.need - m.have}`).join(', ')
    }
  } catch {}
  kit.need.push({
    what: 'оружие',
    count: 1,
    have: 0,
    why: `${where}, а у меня ни меча, ни топора${fix}`
  })
}

// Only the absence is a need. A shield in the bag with an EMPTY off-hand is the
// armour step's job (armor.js shieldStep puts it on); a shield in the bag with
// something else in the off-hand is left alone there on purpose — a totem or a
// map was put in that hand by someone — and so it is left alone here too, and
// said out loud.
function shieldNeed (session, spec, kit) {
  const bot = session.bot
  const off = bot.inventory.slots[armor.OFF_HAND]
  if (off && off.name === 'shield') return
  const inBag = countOf(bot, 'shield')
  if (inBag && !off) return
  if (inBag) {
    kit.need.push({
      what: 'щит в левую руку',
      why: `щит в рюкзаке, а левая рука занята ${off.name} — сам не снимаю; ` +
        'если щит сейчас важнее: mc_equip item=shield destination=off-hand'
    })
    return
  }
  const iron = countOf(bot, 'iron_ingot')
  let planks = 0
  try { planks = spendablePlanks(bot, session.mcData) } catch {}
  kit.need.push({
    what: 'щит',
    count: 1,
    have: 0,
    why: (spec.graveyard
      ? 'у кучи обычно стоит тот, кто меня убил, а от стрелка без щита закрыться нечем. '
      : 'от стрелка по дороге без щита закрыться нечем. ') +
      `Щит — 6 досок и железный слиток на верстаке (досок ${plankCount(bot)}, железа ${iron})` +
      (iron >= 1 && planks >= 6 ? ' — хватает: mc_craft item=shield' : '')
  })
}

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
  const gold = Object.values(armor.readWorn(bot)).some(v => v && /^golden_/.test(v.item))
  for (const e of Object.values(bot.entities || {})) {
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

async function dress (session, sub, kit) {
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

async function arm (session, sub, kit) {
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
async function rearm (session, ctl) {
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
      new Promise((_resolve, reject) => { timer = gameClock.setTimeout(() => reject(new Error('timeout')), REARM_TIMEOUT_MS) })
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

// ------------------------------------------------------------------ run

function freshKit () {
  return { started: gameClock.now(), did: [], skipped: [], need: [], error: null, ms: null, pending: null }
}

// Never rejects: a preflight that throws must not cost the intent it guards.
// A throw is still not swallowed — it rides on the answer as `error`, because a
// check that silently stopped checking reads exactly like «всё на месте».
//
// `kit` is filled in as the checks run rather than returned at the end, so a
// chat that lands mid-swap still leaves whatever was already found for
// runIntent to attach — and `kit.pending` says what the step in progress was.
async function preflight (session, ctl, spec, kit) {
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
    await new Promise(resolve => setImmediate(resolve))
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
function summary (kit) {
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
  const out = {}
  if (did.length) out.did = did
  if (skipped.length) out.skipped = skipped
  if (need.length) out.need = need
  if (kit.error) out.error = kit.error
  if (!Object.keys(out).length) return undefined
  out.ms = kit.ms ?? (gameClock.now() - kit.started)
  return out
}

module.exports = {
  requirements,
  preflight,
  freshKit,
  summary,
  rearm,
  NEEDS,
  PREFLIGHT_MS,
  FOOD_FOR_TRIP,
  FOOD_FROM_CELLS,
  MELEE,
  meleeScore,
  bestMelee,
  foodInBag
}
