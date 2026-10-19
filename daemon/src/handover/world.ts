'use strict'
// Передача: предметы на земле (свой бросок, перепись, collect), стойка на дальность броска и шаг назад.
import * as gameClock from '../game-clock'
import { goals } from 'mineflayer-pathfinder'
import { sleep, xyz } from '../movement'
import { withTimeout } from '../build'
import * as social from '../social'
import { r2, r1, DROP_WINDOW_MS, POLL_MS, FIND_DROP, THROW, flat, BAND, BACK_OFF } from './vocabulary'

// ---------------------------------------------------------------- the world

function droppedItem (ent) {
  try { return ent.getDroppedItem() } catch { return null }
}

// Every item entity around, in the words the rest of the answer uses. `name`
// null means «what is it» has not arrived yet: the stack and its contents come
// in two packets (entities.js:450-461 emits itemDrop only once the metadata
// with the item_stack is in), so a stack seen the same tick it spawned is a
// real drop with an unknown name, not a phantom.
export function lyingAround (bot, { name = null, radius = 8, from = null }: any = {}) {
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
    try { pos = (require('../drops') as typeof import('../drops')).nowOf(bot, ent) } catch {}
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
export async function waitForDrops (bot, ctl, { name = null, radius = 8, from = null, windowMs = DROP_WINDOW_MS }: any = {}) {
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

export function dropIds (bot) {
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
export async function waitForOwnDrop (bot, ctl, known, stood, windowMs = DROP_WINDOW_MS) {
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
export function dropCensus (bot, from) {
  const all = lyingAround(bot, { radius: 64, from })
  return { count: all.length, nearest: all[0] || null }
}

// The only witness that a handover happened. `collector` is the person, not us,
// and the packet comes from the server, so this is the one fact in the whole
// file that cannot be produced by wishful thinking.
export function listenCollect (bot, key) {
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
export function stand (bot) {
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
}

// Stand at throwing distance from the person — not «as close as possible», see
// THROW. A ring, not a radius: GoalNear(player, 3) is satisfied by standing on
// his toes, which is the one place we must not throw from.
export async function standOff (bot, ctl, ent, want, msLeft) {
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
export async function stepBack (bot, ctl, ent, msLeft) {
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
