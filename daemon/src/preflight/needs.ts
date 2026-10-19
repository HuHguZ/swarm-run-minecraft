'use strict'
// Сборы: чтение рук и рюкзака, подсказки крафта, нужды навыка по видам (факел, еда, оружие, щит).
import * as gameClock from '../game-clock'
import armor = require('../armor')
import { countOf, craftPlan, plankCount, spendablePlanks, GROUPS, TABLE_PLANKS } from '../items'
import { PREFLIGHT_MS, POLL_MS, NOT_ACTUALLY_FOOD, RISKY_FOOD, COOKS_INTO, bestMelee, MELEE } from './table'

// ------------------------------------------------------------------ reading

// Everything that moves the one cursor, the same list armor.js whyNotEquip
// asks plus the two flags other routines hold across a whole operation.
// session.crafting in particular: a craft through a table holds a window for
// seconds, and a swap clicked into it lands in the crafting grid.
export function handsBusy (session) {
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
export function gone (session) {
  const bot = session.bot
  return !bot || !bot.entity || (bot.health ?? 20) <= 0
}

// How the check was cut short, in the words both halves of the answer use.
// 'ended'  — the intent itself is over (an interrupt, its clock, a cancel): the
//            worker will never start (session.runIntent checks ctl.aborted).
// 'budget' — only the three seconds of the check ran out: the work goes on.
export function cutShort (sub) {
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
export async function untilHandsFree (session, sub, onBusy) {
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

export function pause (ms, sub?: any) {
  return new Promise<any>(resolve => {
    if (sub && sub.aborted) return resolve(undefined)
    const t = gameClock.setTimeout(resolve, ms)
    if (sub) sub.onAbort.push(() => { gameClock.clearTimeout(t); resolve(undefined) })
  })
}

export function foodInBag (bot, mcData) {
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

export function torchNeed (bot, mcData, t, kit) {
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

export function foodNeed (bot, mcData, want, kit) {
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

export function weaponNeed (session, spec, kit) {
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
export function shieldNeed (session, spec, kit) {
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
