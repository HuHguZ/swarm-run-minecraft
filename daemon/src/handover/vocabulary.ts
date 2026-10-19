'use strict'
// Передача: дальности броска и ожидания, словарь просьб, выбор вещи, неприкосновенное.
import { GROUPS, TOOL_RESERVE, itemNamed, countItems, toolStatus, bestOfKind, usesLeft } from '../items'
import { readWorn } from '../armor'
import * as social from '../social'

// Handing a thing to a person and taking a thing from him.
//
// The body could already notice a player, turn to him, hear him and not hit
// back (social.js, escort.js). The two things it could not do are the two a
// person asks for most: «дай кирку» and «на, возьми». mc_drop is not that: it
// throws a stack on the floor wherever the body happens to stand and answers
// «dropped: cobblestone, count: 8» — no person in it, no walk to him, no
// witness that anything reached anybody, and no line it will not cross.
//
// The one question this file had to answer first: from what distance does a
// dropped stack actually reach the person? The answer is that there is no such
// distance, and it is not a matter of measurement.
//
// mineflayer drops an item by clicking the slot and then clicking outside the
// window: bot.toss builds a transfer with `destStart: -999`
// (simple_inventory.js:29-40), transfer sends that to clickWindow
// (inventory.js:305-311), and clickWindow writes `window_click` with
// windowId / stateId / slot / mouseButton / mode / changedSlots / cursorItem
// (inventory.js:557-610). There is no direction in that packet, no target and
// no aim. Whatever the server then does with the stack, our yaw is not an
// argument to it — so «бросить подальше и точнее» is not a thing this code can
// do, and any constant claiming a throwing range would be invented.
//
// What is left is the only distance we control — where the body stands when it
// lets go — and one real witness of the outcome: the server's own `collect`
// packet, which mineflayer re-emits as playerCollect(collector, collected)
// (entities.js:149-154). So the shape of the act is: walk up, let go, watch the
// world, and report what actually happened, including «не долетело, лежит вот
// здесь». Never «я бросил, значит отдал».

// Where to stand to throw at a person. An opening bid, and a small one.
//
// The world has answered, and the answer is SPLIT — which is why it took five
// rounds to get: direction and distance are two different questions and we kept
// measuring them with one number.
//
//   DIRECTION IS AIMED. try-give, four throws per angle, bearing measured from a
//   known teleported origin against the entity's exact position: 7 of 12 throws
//   had usable angular resolution and all 7 landed within 45 degrees of where
//   the body was facing. Under a uniform scatter that is one chance in ten
//   thousand. Turning to the person is therefore not manners — it is half the
//   delivery.
//
//   DISTANCE IS SCATTER. Same run: the spread of carries WITHIN one pitch angle
//   (up to 1.2 blocks) was larger than the difference BETWEEN angles (0.9), so
//   the tilt does not decide how far it goes and neither does anything else we
//   control. Live carries have ranged from 0 to 2.8 blocks from the same spot.
//
// So no constant can be right, and this one is only a place to start: two blocks
// works under both halves of that answer. If the throw carries far, the stack
// lands past the person and still inside the 1.2 he can reach standing still; if
// it carries nothing, it lands at our own feet — which the loop below already
// treats as its own case, steps away from and retries. And two is what worked in
// the world: the handover that succeeded did it from stoodOff 2.2, after 4 and 5
// had both missed. Everything past that is the calibration, and with distance
// ruled by chance the calibration is not a fallback but the whole mechanism.
export const THROW = 2

// The pitch the body throws with, kept level and kept SEPARATE from the turn.
//
// Not because level throws furthest — that was the cos(pitch) model and the run
// above buried it; if anything the four level throws in that run travelled least
// of all, which is a curiosity and far too thin to build on. It stays for two
// duller reasons: one variable fewer in a thing already ruled by chance, and a
// body that stares at its own feet while handing something over reads as broken
// to the person standing in front of it.
export const THROW_PITCH = 0

// How wrong the stand-off may be before it is worth walking to fix it. Half the
// pickup reach: off by this much and the stack still lands inside what the
// person can reach standing still, so the walk would buy nothing.
export const BAND = 0.7

// How close a stack has to settle for a person standing still to get it.
// Pickup is not our code at all — the server does it by distance — so the
// number is measured, twice, and the second measurement is why it is not 1.5:
// collectNearbyDrops walks to GoalNear(drop, 1) and sleeps 350 ms, and that is
// how every block mined here ended up in the bag (actions.js:38-53); and in the
// world on 2026-09-01 a stack that came to rest 1.5 blocks from Igrok was NOT
// picked up while he stood there. So 1.5 is already past the edge, and a
// threshold set there would make the body decide «он просто не берёт» at
// exactly the distance that is a miss — and stop trying.
export const PICKUP = 1.2

// Farther than this a handover is a journey, and a journey is the brain's
// decision, not a side effect of «дай кирку». Same number the body already uses
// to decide whether a person counts as being around at all (social.SCAN): past
// it there is no player_near, no direction word, nothing to hand anything to.
export const REACH = social.SCAN

// Sprint is off (session.js:107-109), so this is the walking speed social.js:20-22
// counts with. Used only to answer «сколько идти» — and in a straight line, so
// it is a floor, never a promise.
const WALK_BPS = 4.3

// How long one toss is watched before the body decides the person did not get
// it, and how often the world is asked. Not a single sleep: we do not know when
// the server will let anybody pick the stack up, so the loop answers the moment
// playerCollect arrives instead of always paying the whole wait.
export const WATCH_MS = 5000
export const POLL_MS = 250

// How long the world is asked whether a stack has appeared. The entity is not
// there the instant it is thrown: the spawn packet and the item_stack metadata
// are two more packets after the throw, and at 20 tps (README) a couple of
// ticks of server lag is already 100 ms. Measured today on the ore run, where
// asking once was the whole bug.
export const DROP_WINDOW_MS = 4000

// How far to look for the stack we just let go of. Deliberately generous, and
// for the same reason there is no throwing distance in this file at all: how
// far the server carries a dropped stack is exactly the thing mineflayer will
// not tell us, so a tight radius here is a guess dressed as a filter. Measured
// in the world on the first run: with radius 8 the answer came back «вещь ушла,
// а где — по миру не видно», while the scene's own observe was looking straight
// at the drop.
export const FIND_DROP = 32

// How many times the body will pick its own miss back up and try again.
export const TRIES = 3

// How far the body steps away after letting go. Nothing in mineflayer picks
// items up; the server does it by distance and the thrower is no exception, so
// a body that stands over its own gift is the body most likely to take it back.
export const BACK_OFF = 4

export const r1 = n => Math.round(n * 10) / 10
export const r2 = n => Math.round(n * 100) / 100
export const at = p => `${p.x},${p.y},${p.z}`
export const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
export const walkSeconds = d => Math.max(1, Math.round(d / WALK_BPS))

// ---------------------------------------------------------------- vocabulary

const KIND_RU = { pickaxe: 'кирка', axe: 'топор', shovel: 'лопата', sword: 'меч', hoe: 'мотыга' }

// The person types Russian and the brain forwards the word as it was said —
// «дай кирку» arrives here as `item: 'кирку'`. social.js:87-92 already keeps the
// same vocabulary in the other direction; this is the half that reads it.
// Deliberately small: everything else goes through the game name, which is what
// the state header shows the brain anyway (perception.js:91).
const ASK_RU = {
  кирка: 'pickaxe', кирку: 'pickaxe', кирки: 'pickaxe', кирок: 'pickaxe',
  меч: 'sword', меча: 'sword', мечи: 'sword',
  топор: 'axe', топора: 'axe',
  лопата: 'shovel', лопату: 'shovel',
  мотыга: 'hoe', мотыгу: 'hoe',
  еда: 'еда', еды: 'еда', еду: 'еда', поесть: 'еда', пожрать: 'еда',
  хлеб: 'bread', хлеба: 'bread',
  мясо: 'cooked_beef', мяса: 'cooked_beef', стейк: 'cooked_beef', стейка: 'cooked_beef',
  факел: 'torch', факелы: 'torch', факелов: 'torch', факела: 'torch',
  булыжник: 'cobblestone', булыжника: 'cobblestone', камень: 'cobblestone', камня: 'cobblestone',
  доски: 'any_planks', досок: 'any_planks', палки: 'stick', палок: 'stick',
  уголь: 'coal', угля: 'coal', железо: 'iron_ingot', железа: 'iron_ingot',
  алмаз: 'diamond', алмазы: 'diamond', алмазов: 'diamond',
  щит: 'shield', ведро: 'bucket', лук: 'bow', стрелы: 'arrow', стрел: 'arrow'
}

export const TOOL_KINDS = /^(pickaxe|axe|shovel|sword|hoe)$/

export function normalizeAsk (raw) {
  const word = String(raw || '').trim().toLowerCase()
  if (!word) return null
  return ASK_RU[word] || word
}

// minecraft-data 1.21.11 lists the four fish buckets among the foods and none
// of them is edible — actions.js:956-960 measured that (using one spills a fish
// on the floor). Without the same exclusion here a bucket of salmon counts as
// dinner and «последняя еда» stops protecting anything.
const NOT_FOOD = /_bucket$/
export const isFood = (mcData, name) => !!(mcData && mcData.foodsByName[name]) && !NOT_FOOD.test(name)

function foodOwned (bot, mcData) {
  return bot.inventory.items().reduce((n, i) => n + (isFood(mcData, i.name) ? i.count : 0), 0)
}

// Which one of a kind the body parts with. bestOfKind is the one it digs with
// (items.js:124-133), so handing that over hands over the tool in use: the
// spare goes instead — and among spares the one with the fewest swings left,
// because that is the one worth least to us and still whole to him.
export function spareOfKind (bot, kind) {
  const mine = bot.inventory.items().filter(i => i.name.endsWith(`_${kind}`))
  if (!mine.length) return null
  const best = bestOfKind(bot, kind)
  const pool = mine.filter(i => i !== best)
  return (pool.length ? pool : mine).slice().sort((a, b) => usesLeft(a) - usesLeft(b))[0]
}

// What we have, in the words of the state header, shortest list that is still
// an answer. Used only by refusals: «нет такого» is useless without it.
export function bagLine (bot, limit = 8) {
  const items = (Object.entries(countItems(bot)) as [string, any][]).sort((a: any, b: any) => b[1] - a[1])
  if (!items.length) return 'рюкзак пуст'
  const shown = items.slice(0, limit).map(([n, c]) => `${n}×${c}`)
  return shown.join(', ') + (items.length > limit ? ` и ещё ${items.length - limit} видов` : '')
}

// Everything the bag holds that answers the same word, for the «нет вовсе»
// refusal: asked for a pickaxe and there is none — say which tools there are.
export function similarLine (bot, ask) {
  const kind = TOOL_KINDS.test(ask) ? ask : null
  const owned = bot.inventory.items().map(i => i.name)
  if (kind) {
    const tools = [...new Set(owned.filter(n => /_(pickaxe|axe|shovel|sword|hoe)$/.test(n)))]
    return tools.length ? `из инструментов есть ${tools.join(', ')}` : 'инструментов нет вообще ни одного'
  }
  const like = [...new Set(owned.filter(n => n.includes(ask) || ask.includes(n)))]
  return like.length ? `похожее есть: ${like.join(', ')}` : null
}

// Which item leaves the bag for this word. Order matters: an exact game name is
// never overridden by guessing, and a group («any_planks») is answered with
// something we actually own rather than with the group's first member.
export function pickItem (bot, mcData, rawAsk) {
  const ask = normalizeAsk(rawAsk)
  if (!ask) return { error: 'не сказано, что отдавать' }

  const exact = itemNamed(bot, ask)
  if (exact) return { item: exact }

  if (ask === 'еда' || ask === 'food') {
    const foods = bot.inventory.items().filter(i => isFood(mcData, i.name))
    if (foods.length) return { item: foods.sort((a, b) => b.count - a.count)[0] }
    return { miss: ask, why: 'еды в рюкзаке нет' }
  }

  if (TOOL_KINDS.test(ask)) {
    const spare = spareOfKind(bot, ask)
    if (spare) return { item: spare }
    return { miss: ask, why: `${KIND_RU[ask] || ask} — ни одной` }
  }

  if (GROUPS[ask]) {
    const hit = bot.inventory.items().filter(i => GROUPS[ask].test(i.name))
    if (hit.length) return { item: hit.sort((a, b) => b.count - a.count)[0] }
    return { miss: ask, why: `ничего из группы ${ask}` }
  }

  // Last resort: the word is a piece of a name we own («beef» → cooked_beef).
  const loose = bot.inventory.items().filter(i => i.name.includes(ask))
  if (loose.length) return { item: loose.sort((a, b) => b.count - a.count)[0] }

  return { miss: ask, why: `${ask} — нет вовсе` }
}

// Armour is a special kind of "нет такого": bot.toss searches slots 9..44
// (window.inventoryStart is 9 for the player inventory) and worn pieces live in
// 5..8, so items() cannot see them and toss cannot reach them either. Saying
// «нет iron_chestplate» about the chestplate on our chest is a lie the person
// can see through by looking at us.
export function wornMatch (bot, rawAsk) {
  const ask = normalizeAsk(rawAsk)
  if (!ask) return null
  const worn = readWorn(bot)
  for (const [dest, piece] of ((Object.entries(worn) as [string, any][]) as any)) {
    if (!piece) continue
    if (piece.item === ask || piece.item.includes(ask)) return { dest, ...piece }
  }
  return null
}

// ---------------------------------------------------------------- the line

// What the body does not hand over unless it is told to in so many words.
//
// The idiom is the one containers.js:1473-1492 already uses for the chest run
// (KEEP: tools and armour are `Infinity`, food is kept 16 deep) and items.js
// uses for the tool budget (TOOL_RESERVE = 40 swings). The numbers here are
// lower on purpose, and that is the whole difference between the two rules: the
// chest line protects a mining trip that has not started yet, this one protects
// only the next minute — a person standing in front of you asking for food is
// not a chest, and refusing to share while holding fifteen steaks is not care,
// it is hoarding. So: never the last tool of a kind, never the armour on the
// body, never the last piece of food.
export function precious (session, item, want) {
  const bot = session.bot
  const mcData = session.mcData
  const name = item.name

  const kind = (/_(pickaxe|axe|shovel|sword|hoe)$/.exec(name) || [])[1]
  if (kind) {
    const st = toolStatus(bot, kind)
    if (st.count - want < 1) {
      const ru = KIND_RU[kind] || kind
      return {
        what: `последняя ${ru}`,
        note:
          `${name} — единственная ${ru} в рюкзаке (ударов в ней ${st.total === Infinity ? 'без счёта' : st.total}, ` +
          `неприкосновенный запас — ${TOOL_RESERVE}, items.js:38). Отдам — работать нечем и наверх не выкопаться. ` +
          `Сначала сделать запасную: mc_craft stone_pickaxe. Всё равно отдать — mc_give с force=true.`
      }
    }
  }

  if (isFood(mcData, name)) {
    const have = foodOwned(bot, mcData)
    if (have - want < 1) {
      const canGive = Math.max(0, have - 1)
      return {
        what: 'последняя еда',
        note:
          `еды всего ${have} ${have === 1 ? 'кусок' : 'кусков'} (${name}), отдать просят ${want} — останусь без единого. ` +
          (canGive > 0 ? `Могу отдать ${canGive}: mc_give count=${canGive}. ` : 'Отдавать нечего. ') +
          `Всё равно отдать всё — mc_give с force=true; тогда следующая остановка это поход за едой.`
      }
    }
  }

  return null
}
