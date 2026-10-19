'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { sleep, v3, count, NO_DIG } from './common'
import { WOODS } from './kinds'
import { walk, digAt } from './site'
import { air, headWet, swimming, swimTo } from './water'

// Двери на карманы воздуха — до глубокого нырка (6 досок → 3 двери на верстаке; actions.craft сам ставит и забирает стол).
async function ensureDoors (session, ctl) {
  const bot = session.bot
  if (bot.inventory.items().some(i => /_door$/.test(i.name) && i.name !== 'iron_door')) return true
  for (const w of WOODS) {
    if (count(bot, `${w}_planks`) < 6 && count(bot, new RegExp(`^(stripped_)?${w}_(log|wood)$`)) < 2) continue
    try { await (require('../actions') as typeof import('../actions')).craft(session, ctl, { item: `${w}_door`, count: 3 }); if (count(bot, `${w}_door`) > 0) return true } catch {}
  }
  return false
}
async function digToSee (session, ctl, pos, { ms = 60000, wet = false }: any = {}) {
  const bot = session.bot
  const pick: typeof import('../pick') = require('../pick')
  const p = v3(pos).floored()
  const t0 = gameClock.now()
  const left = () => ms - (gameClock.now() - t0)
  const seen = () => !!pick.blockAim(bot, p, { range: 4.5, seeThrough: null })
  let stuck = 0
  for (let i = 0; i < 40 && !ctl.aborted && left() > 0; i++) {
    if (seen()) return true
    if (wet || swimming(bot)) {
      await swimTo(session, ctl, p, { reach: 3.6, ms: Math.min(30000, left()) })
      if (seen()) return true
      if (++stuck > 3) break
      continue
    }
    const eye = pick.eyeOf(bot)
    const c = p.offset(0.5, 0.5, 0.5)
    const d = c.minus(eye)
    const len = d.norm()
    if (len > 4.4) {
      const before = bot.entity.position.clone()
      try { await walk(session, ctl, new goals.GoalNear(p.x, p.y, p.z, stuck ? 1 : 2), Math.min(30000, left())) } catch {}
      if (bot.entity.position.distanceTo(before) < 0.5 && ++stuck > 2) break
      continue
    }
    const hit = pick.blockOnRay(bot, eye, d.scaled(1 / len), len + 0.5)
    if (!hit || hit.pos.equals(p)) return seen()
    if (NO_DIG.test(hit.block.name)) {
      try { await walk(session, ctl, new goals.GoalNear(p.x, p.y, p.z, 1), Math.min(15000, left())) } catch {}
      if (++stuck > 2) break
      continue
    }
    const r = await digAt(session, ctl, hit.pos, { maxMs: 12000, walkMs: 1 })
    if (!r.ok && ++stuck > 3) break
  }
  return seen()
}

// Копать под собой, пока под ногами не сундук: копается только блок под ногами (виден), ловушки и жидкость — стоп.
// { chest: Vec3 } или { stopped }, dug — сколько выкопал.
async function digDown (session, ctl, { maxDepth = 16 }: any = {}) {
  const bot = session.bot
  let dug = 0
  for (let k = 0; k < maxDepth + 4 && !ctl.aborted; k++) {
    const f = bot.entity.position.floored()
    // Под ногами — первый контур вертикального луча из глаз (ревью Codex q2: стоя на сундуке, верх 0.875, «floored − 1»
    // читал скрытый блок под ним); так же ковёр и плита у ног.
    const under = (require('../pick') as typeof import('../pick')).blockOnRay(bot, (require('../pick') as typeof import('../pick')).eyeOf(bot), new Vec3(0, -1, 0), 4.5)?.block || null
    if (!under) return { stopped: 'чанк не прогружен', dug }
    if (/^(chest|trapped_chest|barrel)$/.test(under.name)) {
      // Луч видит сундук ещё в падении (до него 2–4 бл.): дождаться опоры — плита камеры храма видна только стоя на нём
      // (ферма 14.10, храм 24,53,170: «плита цела», сундук «отсюда не дотянуться» — тело ещё летело в колодце).
      const t1 = gameClock.now()
      while (!ctl.aborted && !bot.entity.onGround && gameClock.now() - t1 < 2500) await sleep(80, ctl)
      return { chest: under.position, dug }
    }
    if (/water|lava/.test(under.name)) return { stopped: `под ногами ${under.name} — не копаю`, dug }
    if (NO_DIG.test(under.name)) return { stopped: `под ногами ${under.name} — не копаю`, dug }
    if (dug >= maxDepth) return { stopped: `глубже ${maxDepth} не копаю`, dug }
    if (under.boundingBox !== 'empty') {
      const r = await digAt(session, ctl, under.position, { maxMs: 8000, walkMs: 1 })
      if (!r.ok) return { stopped: `не копается ${under.name}: ${r.why || '?'}`, dug }
      dug++
    }
    // Дождаться падения на клетку ниже.
    const t0 = gameClock.now()
    while (gameClock.now() - t0 < 1500 && bot.entity.position.floored().y >= f.y && !ctl.aborted) await sleep(80)
    if (headWet(bot)) return { stopped: 'в столбце вода', dug }
  }
  return { stopped: 'прервано', dug }
}

// Вниз по лестнице ствола (иглу): встать в столб люка и не держать ни прыжка, ни шага — по лестнице сползает
// (LivingEntity.handleOnClimbable: скорость вниз ≥ −0.15). Итог — y ног внизу или null.
// Середина свободной части клетки люка: створка открытого люка — тонкая коробка у одной стены (3/16), тело (0.6) проходит
// в оставшиеся 0.8125, только если целиться в их середину (допуск ±0.1).
function holeCenter (bot, hatch) {
  const b = bot.blockAt(v3(hatch))
  let cx = 0.5
  let cz = 0.5
  const s = b && /_trapdoor$/.test(b.name) && Array.isArray(b.shapes) ? b.shapes[0] : null
  if (s) {
    if (s[3] - s[0] < 0.5) cx = s[0] > 0.01 ? s[0] / 2 : (s[3] + 1) / 2
    if (s[5] - s[2] < 0.5) cz = s[2] > 0.01 ? s[2] / 2 : (s[5] + 1) / 2
  }
  return v3(hatch).offset(cx, 0, cz)
}
async function ladderDown (session, ctl, hatch, ms = 15000) {
  const bot = session.bot
  const c = holeCenter(bot, hatch)
  const t0 = gameClock.now()
  const y0 = bot.entity.position.y
  try { await walk(session, ctl, new goals.GoalNear(hatch.x, hatch.y + 1, hatch.z, 1), 8000) } catch {}
  let lastY = bot.entity.position.y
  let still = 0
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      const pos = bot.entity.position
      const flatD = Math.hypot(c.x - pos.x, c.z - pos.z)
      try { await bot.lookAt(new Vec3(c.x, pos.y + 1.2, c.z), true) } catch {}
      bot.setControlState('jump', false)
      bot.setControlState('sneak', false)
      // В дыру тело (0.6) проваливается, только когда до середины свободной части ≤ 0.1: шажками, без разгона мимо.
      if (flatD > 0.07) { bot.setControlState('forward', true); await sleep(flatD > 0.6 ? 150 : 50); bot.setControlState('forward', false) }
      await sleep(150)
      const y = bot.entity.position.y
      if (process.env.ND_DEBUG_STRUCT) console.log('[ladder]', pos.x.toFixed(2), y.toFixed(2), pos.z.toFixed(2), 'flat', flatD.toFixed(2), (bot.blockAt(bot.entity.position.floored()) || {}).name)
      if (Math.abs(y - lastY) < 0.05) { if (++still > (flatD <= 0.07 ? 6 : 24)) break } else still = 0
      lastY = y
    }
  } finally { for (const k of ['forward', 'jump', 'sneak']) bot.setControlState(k, false) }
  // Дно — только стоя на опоре (по таймауту посреди лестницы это не дно и не высота сундука — ревью Codex q2).
  return !ctl.aborted && bot.entity.onGround && bot.entity.position.y < y0 - 2 ? Math.floor(bot.entity.position.y) : null
}

// Вверх по лестнице ствола: в столбе люка держать прыжок (LivingEntity.handleOnClimbable: прыжок на лестнице — +0.2).
// Открытый люк над лестницей той же стороны — тоже лестница (LivingEntity.onClimbable → trapdoorUsableAsLadder);
// prismarine-physics для 1.21 этого не знает (features.json: climbableTrapdoor — до 1.20) и наверху бот прыгал на краю
// люка 25 с (ферма 14.10, иглу 163,-218) — подъём 0.2 за тик в клетке люка добавляем, как сервер. Над полом — шаг на
// соседнюю клетку пола, где проходимо.
async function ladderUp (session, ctl, hatch, ms = 25000) {
  const bot = session.bot
  const c = holeCenter(bot, hatch)
  const H = v3(hatch)
  const t0 = gameClock.now()
  const low = b => !!b && (!Array.isArray(b.shapes) || !b.shapes.length || Math.max(...b.shapes.map(q => q[4])) <= 0.2)
  const exit = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => H.offset(dx, 1, dz))
    .find(q => { const a = bot.blockAt(q); const b = bot.blockAt(q.offset(0, 1, 0)); const f = bot.blockAt(q.offset(0, -1, 0)); return low(a) && b && (!b.shapes || !b.shapes.length) && f && f.boundingBox === 'block' })
  const climb = () => {
    try {
      const f = bot.blockAt(bot.entity.position.floored())
      if (!bot.controlState.jump || !f || !/_trapdoor$/.test(f.name)) return
      const p = f.getProperties()
      const below = bot.blockAt(f.position.offset(0, -1, 0))
      if (String(p.open) === 'true' && below && below.name === 'ladder' && below.getProperties().facing === p.facing) bot.entity.velocity.y = 0.2
    } catch {}
  }
  bot.on('physicsTick', climb)
  try { await walk(session, ctl, new goals.GoalNear(hatch.x, bot.entity.position.y, hatch.z, 0), 6000) } catch {}
  try {
    while (!ctl.aborted && gameClock.now() - t0 < ms) {
      const pos = bot.entity.position
      if (pos.y >= H.y + 0.95 && bot.entity.onGround && Math.hypot(pos.x - c.x, pos.z - c.z) > 0.55) break
      const top = pos.y > H.y + 0.6 && exit
      const aim = top ? exit.offset(0.5, 0, 0.5) : c
      try { await bot.lookAt(new Vec3(aim.x, pos.y + 1.2, aim.z), true) } catch {}
      bot.setControlState('forward', top ? true : Math.hypot(c.x - pos.x, c.z - pos.z) > 0.3)
      bot.setControlState('jump', true)
      await sleep(100)
      if (process.env.ND_DEBUG_STRUCT) console.log('[ladderUp]', pos.x.toFixed(2), pos.y.toFixed(2), pos.z.toFixed(2), (bot.blockAt(pos.floored()) || {}).name, top ? 'выход' : '')
    }
  } finally {
    for (const k of ['forward', 'jump']) bot.setControlState(k, false)
    bot.removeListener('physicsTick', climb)
  }
  return bot.entity.position.y >= H.y + 0.95
}

// Сундук под водой — отвесно, как спидраннер: поверху к точке над сундуком, вниз по его столбцу (присед — тонуть), на что
// встал — копать под собой (виден: под ногами), пока под ногами не сундук. Столбец над сундуком после этого — открытая
// вода: наверх — прямо (breathe), следующий нырок — тем же ходом. Стоя на твёрдом, копка в воде ×0.2, а не ×0.04
// (Player.getDestroySpeed: глаза в воде ×0.2, не на земле ÷5). true — сундук под ногами или в прицеле.
async function diveToChest (session, ctl, c, { ms = 40000 }: any = {}) {
  const bot = session.bot
  const pick: typeof import('../pick') = require('../pick')
  const p = v3(c).floored()
  const t0 = gameClock.now()
  const left = () => ms - (gameClock.now() - t0)
  const seen = () => !!pick.blockAim(bot, p, { range: 4.5, seeThrough: null })
  // Готов — сундук в прицеле и на досягаемости открытия (containers: 3.6 до середины): виден в дыру палубы с 4 бл. — ещё
  // вниз, в трюм (ферма 14.10, корабль −220,−952: «не дотянуться» с края дыры).
  const ready = () => seen() && pick.eyeOf(bot).distanceTo(p.offset(0.5, 0.5, 0.5)) <= 3.5
  const col = p.offset(0.5, 0, 0.5)
  const flatD = () => Math.hypot(bot.entity.position.x - col.x, bot.entity.position.z - col.z)
  if (ready()) return true
  // Поверху — к точке над столбцом (воздух не тратится).
  if (flatD() > 1.2) {
    const surfY = bot._ndSurface ? Math.floor(bot._ndSurface.y) : Math.floor(bot.entity.position.y)
    await swimTo(session, ctl, { x: p.x, y: Math.max(surfY, p.y + 2), z: p.z }, { reach: 1.4, ms: Math.min(30000, left()) })
  }
  let dug = 0
  // Присед в воде — тонуть быстрее (LivingEntity.goDownInWater: −0.04 за тик; prismarine-physics этого не умеет).
  const sink = () => { if (bot.controlState.sneak && bot.entity.isInWater) bot.entity.velocity.y -= 0.04 }
  bot.on('physicsTick', sink)
  try {
    while (!ctl.aborted && left() > 0) {
      if (ready()) return true
      const f = bot.entity.position.floored()
      const under = (require('../pick') as typeof import('../pick')).blockOnRay(bot, (require('../pick') as typeof import('../pick')).eyeOf(bot), new Vec3(0, -1, 0), 4.5)?.block || null
      if (process.env.ND_DEBUG_STRUCT) console.log('[dive]', bot.entity.position.toString(), 'under', under && under.name, under && under.position.toString(), 'flat', flatD().toFixed(2), 'ground', bot.entity.onGround)
      // Под ногами сам сундук: готов — открывать; нет (стою на краю дыры палубы, до него 3.8) — встать точно и опуститься.
      const onTarget = !!under && under.position.equals(p)
      if (onTarget && ready()) return true
      if (f.y <= p.y && !onTarget) break // ниже сундука — промахнулся столбцом
      // Держаться столбца: взгляд вниз на середину столбца, короткий шаг.
      // Стоя — точнее: в дыру 1×1 (выкопанная палуба) тело 0.6 проходит, только если до середины ≤ 0.2 (ферма 14.10,
      // корабль −220,−952: 0.27 от середины — стоял на краю дыры, пока не кончился воздух).
      // Шаг — без приседа: присед на земле не пускает с края (prismarine-physics, как ванильный «крадущийся» шаг) — в дыру
      // тело не шагнёт (там же: 0.20 от середины, 30 шагов на месте).
      if (flatD() > (bot.entity.onGround ? 0.12 : 0.35)) {
        try { await bot.lookAt(new Vec3(col.x, bot.entity.position.y, col.z), true) } catch {}
        bot.setControlState('sneak', false)
        bot.setControlState('forward', true); await sleep(bot.entity.onGround ? 50 : 80); bot.setControlState('forward', false)
      }
      if (bot.entity.onGround && under && under.boundingBox === 'block' && !onTarget) {
        if (NO_DIG.test(under.name)) return seen()
        // Присед не отпускать: в воде без него тело всплывает с палубы, и копка «не на земле» — ещё ×5 (Player.getDestroySpeed).
        bot.setControlState('sneak', true)
        const t1 = gameClock.now()
        const r = await digAt(session, ctl, under.position, { maxMs: 20000, walkMs: 1 })
        if (process.env.ND_DEBUG_STRUCT) console.log('[dive] dig', under.name, under.position.toString(), JSON.stringify(r), 'ms', gameClock.now() - t1, 'ground', bot.entity.onGround, 'air', air(bot))
        if (!r.ok) return seen()
        dug++
      } else {
        bot.setControlState('sneak', true)
        await sleep(150)
      }
    }
  } finally { bot.setControlState('sneak', false); bot.setControlState('forward', false); bot.removeListener('physicsTick', sink) }
  void dug
  return seen()
}

export { digToSee, digDown, ladderDown, ladderUp, diveToChest }
