'use strict'
// Сборы: бюджет времени, оружие ближнего боя по цене, таблица нужд навыков.
import actions = require('../actions')
import { SWING_MS } from '../combat'

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
export const PREFLIGHT_MS = 3000

// Same confirm window combat.dressForFight settled on for the same clicks.
export const ARMOR_CONFIRM_MS = 400

// A hand swap is one or two clicks; the server corrects a refused one a tick or
// two later (armor.js:285 explains why a resolved equip proves nothing).
export const HAND_SETTLE_MS = 250

// survival.js holds its own hand swaps to the same five seconds (withTimeout
// around bot.equip): a click is a round trip, and a digger must not park on one.
export const REARM_TIMEOUT_MS = 5000

export const POLL_MS = 100

// Food points, not items: «одна морковка» and «один стейк» are three and eight.
// Walking costs no hunger at all and a staircase costs very little; what eats
// the bar underground is healing, and natural regeneration stops below 18. So
// this is not «what the trip burns» but «one real heal after the first mob» —
// one steak, or two bread.
export const FOOD_FOR_TRIP = 8

// When a dig is a trip at all: forty-eight cells of rock. That is the sixteen-
// level staircase dig_down has asked food for since the table was written
// (three cells a level: head, middle, low — items.SWINGS_PER_LEVEL), and the
// same rock in a drift is 24 blocks of a 1×2 corridor. Asking by the rock and
// not by the length is what keeps the two diggers on one rule: a default
// 16-block drift is 32 cells and asked for a steak on every call of a loop,
// ~300 characters a time, while a 16-level staircase is 48 and a 2-block drift
// asked exactly as loudly.
export const FOOD_FROM_CELLS = 48
const STAIR_CELLS_PER_LEVEL = 3

// ------------------------------------------------------------------ weapons

// Damage and attack speed of every sword and axe on this server, out of its own
// jar (vanilla data generator, reports/items.json, minecraft:attribute_modifiers
// on top of the player's base 1 damage and 4 attacks a second). minecraft-data
// 3.112.0 carries neither number, the same gap armor.js fills for armour.
export const MELEE = {
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
export function meleeScore (item) {
  const m = item && MELEE[item.name]
  if (!m) return 0
  const [damage, speed] = m
  const charge = Math.min(1, (SWING_MS / 50 + 0.5) / (20 / speed))
  return damage * (0.2 + 0.8 * charge * charge) / (SWING_MS / 1000)
}

// Slots 9..44, the held item included (it lives in the hotbar), so «best» and
// «what is in hand» are asked of one list.
export function bestMelee (bot) {
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
export const RISKY_FOOD = actions.RISKY_FOOD ||
  /^(rotten_flesh|spider_eye|poisonous_potato|pufferfish|chicken|suspicious_stew)$/
export const NOT_ACTUALLY_FOOD = actions.NOT_ACTUALLY_FOOD || /_bucket$/

// What the furnace makes of what the bag already holds. Named by the output,
// because that is what mc_smelt takes.
export const COOKS_INTO = {
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
export const NEEDS = {
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
export function requirements (name, params) {
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
