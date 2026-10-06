'use strict'
const gameClock = require('./game-clock')
const { goals } = require('mineflayer-pathfinder')
const { sleep, xyz } = require('./movement')
const { withTimeout } = require('./build')
const { collectNearbyDrops } = require('./actions')
const {
  GROUPS, TOOL_RESERVE, itemNamed, countOf, countItems, diffItems,
  toolStatus, bestOfKind, usesLeft
} = require('./items')
const { readWorn } = require('./armor')
const social = require('./social')

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
const THROW = 2

// The pitch the body throws with, kept level and kept SEPARATE from the turn.
//
// Not because level throws furthest — that was the cos(pitch) model and the run
// above buried it; if anything the four level throws in that run travelled least
// of all, which is a curiosity and far too thin to build on. It stays for two
// duller reasons: one variable fewer in a thing already ruled by chance, and a
// body that stares at its own feet while handing something over reads as broken
// to the person standing in front of it.
const THROW_PITCH = 0

// How wrong the stand-off may be before it is worth walking to fix it. Half the
// pickup reach: off by this much and the stack still lands inside what the
// person can reach standing still, so the walk would buy nothing.
const BAND = 0.7

// How close a stack has to settle for a person standing still to get it.
// Pickup is not our code at all — the server does it by distance — so the
// number is measured, twice, and the second measurement is why it is not 1.5:
// collectNearbyDrops walks to GoalNear(drop, 1) and sleeps 350 ms, and that is
// how every block mined here ended up in the bag (actions.js:38-53); and in the
// world on 2026-09-01 a stack that came to rest 1.5 blocks from Igrok was NOT
// picked up while he stood there. So 1.5 is already past the edge, and a
// threshold set there would make the body decide «он просто не берёт» at
// exactly the distance that is a miss — and stop trying.
const PICKUP = 1.2

// Farther than this a handover is a journey, and a journey is the brain's
// decision, not a side effect of «дай кирку». Same number the body already uses
// to decide whether a person counts as being around at all (social.SCAN): past
// it there is no player_near, no direction word, nothing to hand anything to.
const REACH = social.SCAN

// Sprint is off (session.js:107-109), so this is the walking speed social.js:20-22
// counts with. Used only to answer «сколько идти» — and in a straight line, so
// it is a floor, never a promise.
const WALK_BPS = 4.3

// How long one toss is watched before the body decides the person did not get
// it, and how often the world is asked. Not a single sleep: we do not know when
// the server will let anybody pick the stack up, so the loop answers the moment
// playerCollect arrives instead of always paying the whole wait.
const WATCH_MS = 5000
const POLL_MS = 250

// How long the world is asked whether a stack has appeared. The entity is not
// there the instant it is thrown: the spawn packet and the item_stack metadata
// are two more packets after the throw, and at 20 tps (README) a couple of
// ticks of server lag is already 100 ms. Measured today on the ore run, where
// asking once was the whole bug.
const DROP_WINDOW_MS = 4000

// How far to look for the stack we just let go of. Deliberately generous, and
// for the same reason there is no throwing distance in this file at all: how
// far the server carries a dropped stack is exactly the thing mineflayer will
// not tell us, so a tight radius here is a guess dressed as a filter. Measured
// in the world on the first run: with radius 8 the answer came back «вещь ушла,
// а где — по миру не видно», while the scene's own observe was looking straight
// at the drop.
const FIND_DROP = 32

// How many times the body will pick its own miss back up and try again.
const TRIES = 3

// How far the body steps away after letting go. Nothing in mineflayer picks
// items up; the server does it by distance and the thrower is no exception, so
// a body that stands over its own gift is the body most likely to take it back.
const BACK_OFF = 4

const r1 = n => Math.round(n * 10) / 10
const r2 = n => Math.round(n * 100) / 100
const at = p => `${p.x},${p.y},${p.z}`
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const walkSeconds = d => Math.max(1, Math.round(d / WALK_BPS))

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

const TOOL_KINDS = /^(pickaxe|axe|shovel|sword|hoe)$/

function normalizeAsk (raw) {
  const word = String(raw || '').trim().toLowerCase()
  if (!word) return null
  return ASK_RU[word] || word
}

// minecraft-data 1.21.11 lists the four fish buckets among the foods and none
// of them is edible — actions.js:956-960 measured that (using one spills a fish
// on the floor). Without the same exclusion here a bucket of salmon counts as
// dinner and «последняя еда» stops protecting anything.
const NOT_FOOD = /_bucket$/
const isFood = (mcData, name) => !!(mcData && mcData.foodsByName[name]) && !NOT_FOOD.test(name)

function foodOwned (bot, mcData) {
  return bot.inventory.items().reduce((n, i) => n + (isFood(mcData, i.name) ? i.count : 0), 0)
}

// Which one of a kind the body parts with. bestOfKind is the one it digs with
// (items.js:124-133), so handing that over hands over the tool in use: the
// spare goes instead — and among spares the one with the fewest swings left,
// because that is the one worth least to us and still whole to him.
function spareOfKind (bot, kind) {
  const mine = bot.inventory.items().filter(i => i.name.endsWith(`_${kind}`))
  if (!mine.length) return null
  const best = bestOfKind(bot, kind)
  const pool = mine.filter(i => i !== best)
  return (pool.length ? pool : mine).slice().sort((a, b) => usesLeft(a) - usesLeft(b))[0]
}

// What we have, in the words of the state header, shortest list that is still
// an answer. Used only by refusals: «нет такого» is useless without it.
function bagLine (bot, limit = 8) {
  const items = (Object.entries(countItems(bot)) as [string, any][]).sort((a: any, b: any) => b[1] - a[1])
  if (!items.length) return 'рюкзак пуст'
  const shown = items.slice(0, limit).map(([n, c]) => `${n}×${c}`)
  return shown.join(', ') + (items.length > limit ? ` и ещё ${items.length - limit} видов` : '')
}

// Everything the bag holds that answers the same word, for the «нет вовсе»
// refusal: asked for a pickaxe and there is none — say which tools there are.
function similarLine (bot, ask) {
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
function pickItem (bot, mcData, rawAsk) {
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
function wornMatch (bot, rawAsk) {
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
function precious (session, item, want) {
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

// ---------------------------------------------------------------- the world

function droppedItem (ent) {
  try { return ent.getDroppedItem() } catch { return null }
}

// Every item entity around, in the words the rest of the answer uses. `name`
// null means «what is it» has not arrived yet: the stack and its contents come
// in two packets (entities.js:450-461 emits itemDrop only once the metadata
// with the item_stack is in), so a stack seen the same tick it spawned is a
// real drop with an unknown name, not a phantom.
function lyingAround (bot, { name = null, radius = 8, from = null }: any = {}) {
  const me = from || bot.entity.position
  const out = []
  for (const ent of ((Object.values(bot.entities) as any[]) as any)) {
    // Тот же признак, по которому дроп видит observe (perception.js берёт
    // ent.username || ent.displayName || ent.name и печатает «Item»). Раньше
    // здесь стояло только name === 'item', и если бы имя в этой связке
    // mineflayer/minecraft-data оказалось другим, модуль не видел бы того, что
    // сцена в том же прогоне видит своими глазами.
    if (!ent || !ent.position) continue
    if (ent.name !== 'item' && ent.displayName !== 'Item' && ent.name !== 'item_stack') continue
    // Где предмет сейчас по физике полёта (drops.js): mineflayer держит летящий в точке
    // броска до секунды, и «лёг» по двум одинаковым опросам мерил бы бросок в ноль.
    let pos = ent.position
    try { pos = require('./drops').nowOf(bot, ent) } catch {}
    const dist = pos.distanceTo(me)
    if (dist > radius) continue
    const it = droppedItem(ent)
    if (name && (!it || it.name !== name)) continue
    out.push({
      id: ent.id,
      item: it ? it.name : null,
      count: it ? it.count : null,
      at: xyz(pos),
      // Точная позиция рядом с блочной: по блочной нельзя понять, остановился
      // стак или ещё летит — за четверть секунды полёта он проходит меньше
      // блока, и округлённая координата повторяется дважды подряд ещё в
      // воздухе. Ровно на этом замер и соврал: дальность 1.1 вместо 2.
      exact: { x: r2(pos.x), y: r2(pos.y), z: r2(pos.z) },
      dist: r1(dist),
      where: social.whereIs(bot, pos)
    })
  }
  out.sort((a, b) => a.dist - b.dist)
  return out
}

// Ask the world in a window, not once.
//
// Measured today on the ore run: collectNearbyDrops asks a single time and
// leaves if the answer is empty (`if (!drop) break`, actions.js:41-42), and the
// item entity's spawn packet arrives a tick or two after the block broke — so
// the block was mined and the drop was never collected. Here the same hole is
// wider: a person throws a stack and says «на, возьми» in one breath, and his
// words reach the daemon over the chat packet while the entity is still on its
// way. One poll would answer «на земле ничего не лежит» about a stack landing
// at our feet.
async function waitForDrops (bot, ctl, { name = null, radius = 8, from = null, windowMs = DROP_WINDOW_MS }: any = {}) {
  const deadline = gameClock.now() + windowMs
  let seen = []
  for (;;) {
    // Asked without the name filter on purpose: a stack whose item_stack
    // metadata has not arrived yet is a real drop with an unknown name
    // (entities.js:450-461 emits itemDrop only once it has), and filtering by
    // name inside the poll makes it invisible instead of making it wait.
    const all = lyingAround(bot, { radius, from })
    seen = name ? all.filter(d => d.item === name) : all
    const named = all.length && all.every(d => d.item)
    if ((seen.length && named) || ctl.aborted || gameClock.now() >= deadline) break
    await sleep(POLL_MS)
  }
  return seen
}

function dropIds (bot) {
  const out = new Set()
  for (const e of ((Object.values(bot.entities) as any[]) as any)) {
    if (e && (e.name === 'item' || e.displayName === 'Item' || e.name === 'item_stack')) out.add(e.id)
  }
  return out
}

// Our own stack is the item entity that was not in the world a moment ago.
//
// NOT «the nearest stack whose name matches what we threw» — that was the first
// version and it came back from the world empty-handed twice over. The name
// needs the item_stack metadata, which is a packet of its own arriving when it
// arrives (prismarine-entity getDroppedItem reads metadata[8] and returns null
// until then); the radius needs a guess at how far the throw carries, which is
// the one number nothing in mineflayer will give us. Identity by entity id
// needs neither: whatever it ends up being called and however far it flew, a
// stack that was not there before we let go is ours.
async function waitForOwnDrop (bot, ctl, known, stood, windowMs = DROP_WINDOW_MS) {
  const deadline = gameClock.now() + windowMs
  let best = null
  let id = null
  let guessed = false
  let lastKey = null
  let settled = false

  for (;;) {
    const all = lyingAround(bot, { radius: FIND_DROP, from: stood })
    let cur = id !== null ? all.find(d => d.id === id) : null
    if (!cur) {
      const fresh = all.filter(d => !known.has(d.id))
      // Nothing new, but something lies where a throw would land: take it as
      // the candidate rather than answer «не видно». The id diff can only miss
      // if the spawn packet never arrived, and a guess from the landing spot is
      // strictly better than reporting nothing.
      cur = fresh[0] || (id === null ? all.find(d => d.dist <= THROW + 3) : null)
      if (cur) { id = cur.id; guessed = !fresh.length }
    }

    if (cur) {
      best = guessed ? { ...cur, guessed: true } : cur
      // A stack read while it is still in the air measures the throw as zero.
      // The scene caught exactly that: a snapshot 19 ms after the drop found the
      // item at the thrower's own feet and one block ABOVE them (y 72 over a
      // floor at 71) — mid-flight. So what we want is not the first sighting but
      // the first position that repeats: the stack that has come to rest.
      // Сдвиг меньше 5 см между двумя опросами — стак лежит. Сравнение точных
      // координат, а не блочных: блочные повторяются в полёте.
      const e = cur.exact
      settled = !!lastKey && Math.hypot(e.x - lastKey.x, e.y - lastKey.y, e.z - lastKey.z) < 0.05
      lastKey = e
      if (settled && cur.item) break
    }

    if (ctl.aborted || gameClock.now() >= deadline) break
    await sleep(POLL_MS)
  }

  // Honest about which of the two it is: a landed stack measures the throw, a
  // stack still in the air does not, and the calibration downstream must not
  // treat them the same.
  if (best) best.settled = settled
  return best
}

// What the world actually holds, for the one answer that must never be «по миру
// не видно»: on the first run in the world that sentence was the whole report,
// and the scene's own observe was looking straight at the stack at the time.
function dropCensus (bot, from) {
  const all = lyingAround(bot, { radius: 64, from })
  return { count: all.length, nearest: all[0] || null }
}

// The only witness that a handover happened. `collector` is the person, not us,
// and the packet comes from the server, so this is the one fact in the whole
// file that cannot be produced by wishful thinking.
function listenCollect (bot, key) {
  const got = []
  const on = (collector, collected) => {
    const who = collector && (collector.username || collector.name)
    if (who !== key) return
    const it = collected ? droppedItem(collected) : null
    got.push({ at: gameClock.now(), id: collected ? collected.id : null, item: it ? it.name : null, count: it ? it.count : null })
  }
  bot.on('playerCollect', on)
  return { got, off: () => { try { bot.removeListener('playerCollect', on) } catch {} } }
}

// ---------------------------------------------------------------- moving

// Both walks below clear the goal themselves on every exit. escort.js:236-244
// paid for that rule: a follow goal left armed after the intent answered kept
// walking the body for as long as nobody thought to call stop.
function stand (bot) {
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
}

// Stand at throwing distance from the person — not «as close as possible», see
// THROW. A ring, not a radius: GoalNear(player, 3) is satisfied by standing on
// his toes, which is the one place we must not throw from.
async function standOff (bot, ctl, ent, want, msLeft) {
  // По ГОРИЗОНТАЛИ, а не по прямой. Ставим тело мы только в плане XZ, а
  // сравнивали с трёхмерным расстоянием — и человек четырьмя блоками ниже делал
  // условие невыполнимым: тело вставало куда надо, а функция отвечала «не встал
  // на бросок» и бросок вообще не случался. Поймано на заглушке.
  const gap = () => r1(flat(ent.position, bot.entity.position))
  const started = bot.entity.position.clone()
  const walked = () => Math.round(flat(bot.entity.position, started))
  if (Math.abs(gap() - want) <= BAND) return { walked: 0, gap: gap(), ok: true }

  // The spot at throwing distance on OUR side of him: walking round a person is
  // not the point, and in a corridor there is no round.
  const me = bot.entity.position
  let dx = me.x - ent.position.x
  let dz = me.z - ent.position.z
  const len = Math.hypot(dx, dz)
  if (len < 0.001) { dx = 1; dz = 0 } else { dx /= len; dz /= len }
  const tx = Math.floor(ent.position.x + dx * want)
  const tz = Math.floor(ent.position.z + dz * want)

  try {
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 1)),
      Math.max(3000, msLeft),
      'не успел встать на бросок'
    )
  } catch (err) {
    stand(bot)
    // A block out is still a throw worth making; ten blocks out is not.
    return { walked: walked(), gap: gap(), ok: Math.abs(gap() - want) <= 1.5, error: String(err.message || err) }
  }
  stand(bot)
  return { walked: walked(), gap: gap(), ok: Math.abs(gap() - want) <= 1.5 }
}

// Away from the person, not toward the stack: the stack is somewhere near where
// we stood, and walking around it is how the body would collect its own gift on
// the way past.
async function stepBack (bot, ctl, ent, msLeft) {
  const me = bot.entity.position
  let dx = me.x - ent.position.x
  let dz = me.z - ent.position.z
  const len = Math.hypot(dx, dz)
  if (len < 0.001) { dx = 1; dz = 0 } else { dx /= len; dz /= len }
  const tx = Math.floor(me.x + dx * BACK_OFF)
  const tz = Math.floor(me.z + dz * BACK_OFF)
  try {
    await withTimeout(bot.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 1)), Math.max(2500, Math.min(8000, msLeft)), 'некуда отойти')
  } catch {}
  stand(bot)
  return xyz(bot.entity.position)
}

// ---------------------------------------------------------------- give

async function give (session, ctl, { player, item: ask, count = 1, force = false, timeoutSeconds = 60 }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const from = xyz(bot.entity.position)
  const budget = Math.max(15, Math.min(180, Math.round(Number(timeoutSeconds) || 60)))
  const deadline = gameClock.now() + budget * 1000
  const left = () => Math.max(0, deadline - gameClock.now())

  const asked = String(player || '').trim()
  if (!asked) throw new Error('кому отдавать? give нужен player — ник игрока')

  // A nick typed from memory in the wrong case must not come back as «такого
  // игрока нет» about somebody standing two blocks away — same rule escort.js:181
  // states for the same reason.
  const key = bot.players[asked]
    ? asked
    : Object.keys(bot.players).find(n => n.toLowerCase() === asked.toLowerCase())
  const online = Object.keys(bot.players).filter(n => n !== bot.username)

  if (!key) {
    const stopped = `${asked} не на сервере`
    return {
      to: asked, gave: null, took: false, from, at: from, onlineNow: online, stopped,
      note: (online.length ? `сейчас онлайн: ${online.join(', ')}` : 'на сервере вообще никого нет') +
        '. Проверь ник или дождись player_joined, потом mc_give снова.'
    }
  }

  const ent0 = bot.players[key].entity
  if (!ent0 || !ent0.position) {
    const stopped = `${key} на сервере, но не прогружен — он дальше прорисовки`
    return {
      to: key, gave: null, took: false, from, at: from, onlineNow: online, stopped,
      note: 'отдавать некому: до него дальше, чем видит тело. Спроси координаты (mc_say) и mc_goto, потом mc_give снова.'
    }
  }

  const gap0 = r1(ent0.position.distanceTo(bot.entity.position))
  if (gap0 > REACH) {
    // The control case: a stack thrown at somebody forty blocks away lands in
    // the grass and nobody ever learns where. Say the road instead.
    const secs = walkSeconds(gap0)
    return {
      to: key,
      gave: null,
      took: false,
      from,
      at: from,
      player: { name: key, at: xyz(ent0.position), gap: gap0 },
      road: { walk: Math.round(gap0), walkSeconds: secs, etaSeconds: secs },
      stopped: `${key} в ${gap0} бл. — из рук в руки так не отдать (держу до ${REACH})`,
      note:
        `бросать отсюда нельзя: стак упадёт под ноги мне, а не ему, и потеряется. Идти ${Math.round(gap0)} бл., ` +
        `это ~${secs}с: mc_goto ${xyz(ent0.position).x} ${xyz(ent0.position).z}, потом mc_give снова. ` +
        `Или позови его к себе (mc_say) — я стою на ${at(from)}.`
    }
  }

  // ---- what leaves the bag
  let found = pickItem(bot, mcData, ask)
  if (found.error) throw new Error(found.error)

  if (!found.item) {
    const worn = wornMatch(bot, ask)
    if (worn && !force) {
      return {
        to: key, gave: null, took: false, from, at: from,
        stopped: `${worn.item} — это броня на мне`,
        note:
          `она в слотах брони (5-8), а бросок берёт только рюкзак (слоты 9-44), так что снять придётся сначала. ` +
          `Снимать не буду: без неё любой удар дороже. Правда нужна — mc_give с force=true, тогда сниму и отдам.`
      }
    }
    if (worn && force) {
      // Safe here and only here: the autopilot's armour routine stands down
      // while an intent is running (autopilot.js counts session.current as
      // busy), so nothing puts the piece straight back on between these lines.
      try { await bot.unequip(worn.dest) } catch (err) {
        return {
          to: key, gave: null, took: false, from, at: from,
          stopped: `не смог снять ${worn.item}`,
          note: `${String(err.message || err)}. Попробуй ещё раз или сними другим способом.`
        }
      }
      found = { item: itemNamed(bot, worn.item) }
    }
  }

  if (!found.item) {
    const similar = similarLine(bot, normalizeAsk(ask))
    return {
      to: key, gave: null, took: false, from, at: from,
      have: countItems(bot),
      stopped: `${found.why || 'нет такого'} — отдавать нечего`,
      note: `${similar ? similar + '. ' : ''}В рюкзаке: ${bagLine(bot)}. Скажи человеку, чем можешь заменить (mc_say).`
    }
  }

  const item = found.item
  const owned = countOf(bot, item.name)
  const want = Math.max(1, Math.min(64, Math.round(Number(count) || 1), owned))

  const stop = precious(session, item, want)
  if (stop && !force) {
    return {
      to: key, gave: null, took: false, from, at: from,
      keep: stop.what,
      have: { [item.name]: owned },
      stopped: `не отдам: ${stop.what}`,
      note: stop.note
    }
  }

  // ---- deliver
  const heard = listenCollect(bot, key)
  ctl.onAbort.push(() => { heard.off(); stand(bot) })

  // Сколько этой вещи было ДО всяких бросков. Единственный способ отличить
  // «вещь где-то в мире» от «вещь у меня»: тело подбирает свой бросок обратно,
  // и тогда говорить «вещь из рюкзака ушла» — прямая ложь про свой же рюкзак.
  const startedWith = countOf(bot, item.name)
  const attempts = []
  let took = null
  let lost = null
  let walked = 0
  // Стартуем с факта, если он есть: последняя ИЗМЕРЕННАЯ дальность живёт на
  // сессии и переживает вызов, так что второй mc_give за смену начинает уже не
  // с константы. Константа осталась только для самого первого броска процесса —
  // до того, как мир хоть раз ответил.
  let throwDist = Number.isFinite(session.throwCarry) ? session.throwCarry : THROW

  try {
    for (let n = 1; n <= TRIES && !took && !ctl.aborted && left() > 3000; n++) {
      const ent = (bot.players[key] && bot.players[key].entity) || null
      if (!ent || !ent.position) { lost = `${key} пропал из виду`; break }

      const walk = await standOff(bot, ctl, ent, throwDist, Math.min(left(), 25000))
      walked += walk.walked
      if (!walk.ok) {
        attempts.push({
          try: n,
          stopped: `не встал на бросок: ${walk.error || 'нет дороги'}`,
          gap: walk.gap,
          wanted: r1(throwDist)
        })
        break
      }

      // Turn to him — the yaw is both manners and the only horizontal aim there
      // is. Then flatten the pitch: looking a person in the eye from three
      // blocks away is nearly level, but from one block it is a stare at the
      // floor, and the throw would follow it into the ground.
      try {
        await bot.lookAt(ent.position.offset(0, (ent.height || 1.8) * 0.9, 0), true)
        await bot.look(bot.entity.yaw, THROW_PITCH, true)
      } catch {}

      const stood = bot.entity.position.clone()
      // Наклон в момент броска — тот самый параметр, из-за которого дальность
      // гуляла впятеро. В отчёт он идёт рядом с дальностью, чтобы связь было
      // видно без отдельного расследования.
      const pitchDeg = Math.round(bot.entity.pitch * 180 / Math.PI)
      const before = countOf(bot, item.name)
      // Everything already lying around, so that what appears next is ours.
      const knownDrops = dropIds(bot)
      // The witness has to belong to THIS toss: heard.got keeps every collect
      // this player made since the intent started, and a stack he picked up on
      // the previous attempt must not sign for the current one.
      const tossedAt = gameClock.now()
      let error = null
      try { await bot.toss(item.type, null, Math.min(want, before)) } catch (err) { error = String(err.message || err) }
      // The bag, not the promise: bot.toss resolves on its own click bookkeeping,
      // and what actually left the body is a subtraction anybody can check.
      const sent = before - countOf(bot, item.name)
      if (sent <= 0) {
        attempts.push({ try: n, sent: 0, stopped: error || 'вещь осталась в рюкзаке' })
        break
      }

      const mine = await waitForOwnDrop(bot, ctl, knownDrops, stood)

      // Отходим только если бросок лёг нам под ноги. При направленном броске
      // стак улетает В СТОРОНУ человека, то есть от нас, и лишняя ходьба стоит
      // трёх-пяти секунд на попытку и удлиняет следующий заход.
      const tooClose = !mine || mine.dist <= PICKUP + 0.5
      const back = tooClose ? await stepBack(bot, ctl, ent, Math.min(left(), 8000)) : xyz(bot.entity.position)

      const watchUntil = gameClock.now() + Math.min(WATCH_MS, left())
      let taken = null
      while (gameClock.now() < watchUntil && !ctl.aborted && !taken) {
        taken = heard.got.find(g => g.at >= tossedAt && ((mine && g.id === mine.id) || g.item === item.name)) || null
        if (!taken) await sleep(POLL_MS)
      }

      if (taken) {
        // Удачный бросок — такой же замер, как промах, и терять его глупо.
        if (mine && mine.settled && mine.dist >= 1) session.throwCarry = Math.max(1.5, Math.min(3.5, mine.dist))
        took = { item: item.name, count: sent, confirmedBy: 'collect' }
        attempts.push({
          try: n,
          sent,
          stoodOff: r1(walk.gap),
          pitch: pitchDeg,
          flight: mine ? r1(mine.dist) : null,
          // Где стак лёг относительно ЧЕЛОВЕКА — то самое число, которое
          // отличает «долетело» от «повезло». Считаем и на успехе тоже: удачный
          // бросок так же полезен для понимания, как промах.
          fromPlayer: mine ? r1(Math.hypot(mine.at.x + 0.5 - ent.position.x, mine.at.z + 0.5 - ent.position.z)) : null,
          settled: mine ? !!mine.settled : undefined,
          took: true
        })
        break
      }

      // Nobody took it: ask the world where it is now.
      const still = mine ? lyingAround(bot, { radius: FIND_DROP }).find(d => d.id === mine.id) : null
      const toHim = still ? r1(Math.hypot(still.at.x + 0.5 - ent.position.x, still.at.z + 0.5 - ent.position.z)) : null
      const rec: any = {
        try: n,
        sent,
        stoodOff: r1(walk.gap),
        pitch: pitchDeg,
        flight: mine ? r1(mine.dist) : null,
        // Долетел и лёг — или мы посмотрели, пока он ещё летел. Без этого
        // flight читается как факт там, где он ещё не факт.
        settled: mine ? !!mine.settled : undefined,
        guessed: mine && mine.guessed ? true : undefined,
        lies: still ? still.at : null,
        fromPlayer: toHim,
        stoodAt: xyz(stood),
        backedTo: back,
        census: mine ? undefined : dropCensus(bot, stood)
      }
      attempts.push(rec)

      // Мир только что сказал, на сколько несёт бросок ЗДЕСЬ — и это единственное
      // число, которому тут можно верить: замеры дали 3.1 и 4.6 в одной и той же
      // арене. Но только по ОСТАНОВИВШЕМУСЯ стаку: замер в полёте показывает
      // ноль (сцена поймала такой на 19-й миллисекунде), и калибровка по нему
      // подвела бы тело вплотную — то есть ровно к той ошибке, из-за которой
      // передача не работала вовсе.
      if (mine && mine.settled && mine.dist >= 1) {
        // Верхняя граница ниже прежней: живые замеры дали 0.4-2.8, а стенд-офф
        // 4 и 5 промахнулись оба раза. Если бросок и правда случайный, то это
        // калибровка по шуму, и уезжать по ней далеко от рабочей дистанции —
        // худшее, что можно сделать.
        throwDist = Math.max(1.5, Math.min(3.5, mine.dist))
        session.throwCarry = throwDist
      }
      const triesLeft = n < TRIES && left() > 12000

      if (!still) {
        // The one case that looks like «пропало» and is not: the body walked
        // over its own gift while stepping away and the server handed it back.
        if (countOf(bot, item.name) >= before) {
          rec.stopped = 'подобрал собственный бросок обратно, пока отходил'
          if (triesLeft) continue
          lost = 'бросок каждый раз возвращался ко мне — с этого места не отдать'
          break
        }
        lost = 'стак пропал из виду — либо он всё-таки подобрал, либо его унесло'
        break
      }
      if (toHim !== null && toHim <= PICKUP) {
        // Under his feet and still on the ground: taking it back from there
        // would be picking his pocket, so the body says so and stops.
        lost = `стак лежит у ${key} под ногами (${toHim} бл.), но он его не поднял`
        break
      }
      if (!triesLeft) break

      // Missed him: pick our own miss back up and try from closer. This is the
      // only place the body walks over drops on purpose, and it takes whatever
      // else is lying there — walking over a stack is how picking up works.
      const grabbedBefore = countOf(bot, item.name)
      await collectNearbyDrops(bot, ctl, { radius: 8, timeoutMs: Math.min(10000, left()) })
      if (countOf(bot, item.name) <= grabbedBefore) {
        lost = 'не смог подобрать свой же бросок обратно'
        break
      }
    }
  } finally {
    heard.off()
    stand(bot)
  }

  const here = xyz(bot.entity.position)
  const ent = (bot.players[key] && bot.players[key].entity) || null
  const gap = ent && ent.position ? r1(ent.position.distanceTo(bot.entity.position)) : null
  const last = attempts[attempts.length - 1] || null

  const out: any = {
    to: key,
    gave: took ? { item: item.name, count: took.count } : null,
    took: !!took,
    tries: attempts.length,
    attempts,
    walked,
    from,
    at: here,
    player: { name: key, at: ent && ent.position ? xyz(ent.position) : null, gap },
    have: { [item.name]: countOf(bot, item.name) }
  }

  if (took) {
    out.note =
      `${key} забрал ${item.name}×${took.count} — это сказал сервер (пакет collect), а не я. ` +
      `Стою на ${at(here)}, в ${gap} бл. от него. Надо ещё — mc_give снова.`
  } else if (countOf(bot, item.name) >= startedWith) {
    // Вещь вернулась к нам целиком — ни одного стака в мире не осталось.
    out.stopped = lost || (last && last.stopped) || 'отдать с этого места не вышло'
    out.note =
      `${item.name} осталась у меня: каждый бросок я же и подобрал обратно, пока отходил. ` +
      `Стою в ${gap === null ? '?' : gap} бл. от ${key}. Попробуй ещё раз, когда он подойдёт ближе, ` +
      `или отойди сам и позови mc_give снова — с этой точки не получается.`
  } else {
    const lies = last && last.lies ? last.lies : null
    out.stopped = lost || (last && last.stopped) ||
      (lies ? `не долетело: стак лежит в ${last.fromPlayer} бл. от ${key}, а не у него` : 'отдать не вышло')
    out.drop = lies ? { at: lies, fromPlayer: last.fromPlayer, item: item.name, count: last.sent } : undefined
    out.note =
      (lies
        ? `${item.name}×${last.sent} лежит на ${at(lies)} — это ${last.fromPlayer} бл. от ${key} и ${last.flight} бл. от места броска. ` +
          `Скажи ему подойти и подобрать (mc_say), или забери обратно сам: mc_take item=${item.name}. `
        : `вещь из рюкзака ушла, а своего броска в мире не нашёл. ` +
          (last && last.census
            ? `Предметов на земле рядом: ${last.census.count}` +
              (last.census.nearest ? `, ближайший ${last.census.nearest.item || 'без имени'} на ${at(last.census.nearest.at)} (${last.census.nearest.dist} бл.)` : '') +
              '. Проверь mc_take — возможно, это он. '
            : '') ) +
      `Вещи на земле лежат 5 минут, потом их не будет.`
  }

  try {
    session.journal.append(
      'передача',
      `${key}: ${took ? `отдал ${item.name}×${took.count}` : `не отдал ${item.name} (${out.stopped})`}`,
      bot.entity.position
    )
  } catch {}

  return out
}

// ---------------------------------------------------------------- take

async function take (session, ctl, { item: ask = null, radius = 8, timeoutSeconds = 25 }: any = {}) {
  const bot = session.bot
  const mcData = session.mcData
  const from = xyz(bot.entity.position)
  const budget = Math.max(5, Math.min(120, Math.round(Number(timeoutSeconds) || 25)))
  const deadline = gameClock.now() + budget * 1000
  const reach = Math.max(2, Math.min(24, Math.round(Number(radius) || 8)))

  const before = countItems(bot)
  const wanted = ask ? normalizeAsk(ask) : null

  // The words «на, возьми» beat the entity to us, so this waits instead of
  // asking once — see waitForDrops.
  const lying = await waitForDrops(bot, ctl, { radius: reach })

  const matches = (d) => {
    if (!wanted || !d.item) return !wanted
    if (d.item === wanted) return true
    if (GROUPS[wanted]) return GROUPS[wanted].test(d.item)
    if (wanted === 'еда' || wanted === 'food') return isFood(mcData, d.item)
    if (TOOL_KINDS.test(wanted)) return d.item.endsWith(`_${wanted}`)
    return d.item.includes(wanted)
  }

  if (!lying.length) {
    return {
      took: {}, picked: 0, from, at: from, lying: [],
      stopped: `на земле в ${reach} бл. ничего не лежит`,
      note:
        (wanted ? `${wanted} рядом не валяется. ` : '') +
        'Попроси человека бросить ещё раз (mc_say) — вещи на земле лежат 5 минут. ' +
        `Кинул дальше ${reach} бл. — позови mc_take с radius побольше.`
    }
  }

  const target = lying.filter(matches)
  if (wanted && !target.length) {
    // «Не то» и «сервер ещё не сказал, что это» — разные ответы, и путать их
    // нельзя: во втором случае вещь может быть ровно та, которую просили.
    const unnamed = lying.filter(d => !d.item).length
    return {
      took: {}, picked: 0, from, at: from, lying,
      stopped: unnamed
        ? `рядом лежит ${lying.length} ${lying.length === 1 ? 'куча' : 'кучи'}, но что именно — сервер ещё не прислал`
        : `${wanted} среди лежащего рядом нет`,
      note:
        `на земле лежит: ${lying.map(d => `${d.item || 'что-то'}×${d.count ?? '?'} (${d.dist} бл. ${d.where})`).join('; ')}. ` +
        'Брать не стал — просили другое. Нужно это (или неизвестное) — позови mc_take без item, он берёт всё подряд.'
    }
  }

  // A full bag is why «взял 0» used to be indistinguishable from «там пусто» —
  // the same case containers.js:1923-1927 spells out before walking anywhere.
  // Not fatal on its own: a partial stack of the same thing still has room.
  const free = bot.inventory.emptySlotCount()
  const canTopUp = target.some(d => d.item && bot.inventory.items().some(i => i.name === d.item && i.count < i.stackSize))
  if (free === 0 && !canTopUp) {
    return {
      took: {}, picked: 0, from, at: from, lying,
      stopped: 'рюкзак полон — ни одного пустого слота',
      note:
        `занято ${bot.inventory.items().length} слотов, доложить некуда. ` +
        `На земле: ${target.map(d => `${d.item || 'что-то'}×${d.count ?? '?'}`).join(', ')} — лежит 5 минут. ` +
        'Освободи место: mc_stash mode=put или mc_chest_put, в крайнем случае mc_drop лишнего, потом mc_take снова.'
    }
  }

  // Walking over a stack is how picking up works, so this takes everything on
  // the way and not only what was asked for — the report below says exactly what
  // came, including what nobody asked for.
  //
  // Two rounds, not one, and for the same reason waitForDrops exists:
  // collectNearbyDrops leaves the moment the world answers empty
  // (actions.js:41-42), and a person handing over two stacks throws the second
  // while the body is still walking onto the first.
  const gainedSoFar = () => diffItems(before, countItems(bot))
  const hasWanted = () => Object.keys(gainedSoFar()).some(n => matches({ item: n, count: 1 }))
  let picked = 0
  for (let round = 0; round < 2; round++) {
    picked += await collectNearbyDrops(bot, ctl, {
      radius: reach,
      timeoutMs: Math.max(3000, Math.min(20000, deadline - gameClock.now()))
    })
    await sleep(500) // the last stack lands a tick or two after the walk (survival.js:526)
    if (ctl.aborted || gameClock.now() > deadline - 2000) break
    if (!wanted || hasWanted()) break
    if (!(await waitForDrops(bot, ctl, { radius: reach, windowMs: 800 })).filter(matches).length) break
  }

  const gained = diffItems(before, countItems(bot))
  const got = (Object.entries(gained) as [string, any][])
  const stillThere = lyingAround(bot, { radius: reach })
  const here = xyz(bot.entity.position)

  const missed = wanted && !got.some(([n]) => matches({ item: n, count: 1 }))
    ? target.map(d => d.item).filter(Boolean)
    : []

  const spoils = got.map(([n, c]) => `${n}×${c}`).join(', ')
  const out: any = {
    took: gained,
    picked,
    from,
    at: here,
    lying: stillThere,
    asked: wanted || null
  }

  if (!got.length) {
    // Совет «разгрузись» уместен ровно тогда, когда место и было проблемой:
    // picked>0 значит, что тело дошло до куч и всё равно ничего не влезло.
    const full = picked > 0
    out.stopped = full ? 'прошёл по кучам и ничего не влезло — рюкзак полон' : 'ничего не подобрал'
    out.note =
      `на земле осталось ${stillThere.length} ${stillThere.length === 1 ? 'куча' : 'куч'}` +
      (stillThere.length ? `: ${stillThere.map(d => `${d.item || 'что-то'} на ${at(d.at)}`).join('; ')}` : '') +
      (full
        ? '. Класть некуда: разгрузись (mc_stash mode=put) и позови mc_take снова.'
        : '. Дойти до кучи не вышло — подойди ближе (mc_goto) и позови mc_take снова.')
  } else {
    out.note =
      `подобрал ${spoils}` +
      (missed.length ? `; а вот ${missed.join(', ')} не досталось` : '') +
      (stillThere.length ? `; на земле ещё лежит ${stillThere.map(d => d.item || 'что-то').join(', ')}` : '') +
      `. Скажи человеку спасибо (mc_say) — он ждёт ответа.`
  }

  try {
    session.journal.append('передача', `взял с земли: ${got.length ? spoils : 'ничего'}`, bot.entity.position)
  } catch {}

  return out
}

module.exports = {
  give,
  take,
  lyingAround,
  pickItem,
  precious,
  spareOfKind,
  normalizeAsk,
  THROW,
  PICKUP,
  REACH,
  TRIES
}
