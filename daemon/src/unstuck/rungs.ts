'use strict'
// Застревание: ступени выхода (RUNGS) — от шага и прыжка до пролома и выхода вплавь.
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { axisTo, solid, at, overlapsBody, waterB, lavaB, sleepReal } from './diagnose'
import { groundNear, hold, breakToward, digVisible, aborted, swimTo } from './tools'

export const RUNGS = {
  // Флаг копки pathfinder'а без копки (смерть посреди копки, чанк ушёл): сбросить.
  async clearDig (ctx) {
    const did = (require('../tools') as typeof import('../tools')).unstickPathfinderDig(ctx.bot)
    return { applied: did, why: did ? 'флаг копки снят' : 'флага нет' }
  },
  // Свежие ходы pathfinder'а и поиск с нуля из этой точки.
  async replan (ctx) {
    const { bot, session } = ctx
    try { bot.clearControlStates() } catch {}
    try { (require('../tools') as typeof import('../tools')).unstickPathfinderDig(bot) } catch {}
    if (session && typeof session.updateMovements === 'function') { try { session.updateMovements(true) } catch {} }
    return { applied: true, why: 'новые ходы, поиск заново' }
  },
  // Шаг к цели с прыжком (порог, полублок, край воды); не сдвинулся — назад (если сзади пол) и снова с прыжком вбок.
  async backJump (ctx) {
    const { bot, toward } = ctx
    const p0 = bot.entity.position.clone()
    const feet = p0.floored()
    const dir = axisTo(bot, toward)
    let yaw = bot.entity.yaw
    if (toward) yaw = Math.atan2(-(toward.x - p0.x), -(toward.z - p0.z))
    try { await bot.look(yaw, 0, true) } catch {}
    const frontOk = dir ? groundNear(bot, feet.plus(dir)) || solid(at(bot, feet.plus(dir))) : true
    if (frontOk) await hold(ctx, ['forward', 'jump'], 450)
    if (bot.entity.position.distanceTo(p0) >= 0.5) return { applied: true, why: 'шаг с прыжком' }
    const back = new Vec3(Math.sin(yaw), 0, Math.cos(yaw))
    const behind = p0.plus(back).floored()
    if (groundNear(bot, behind) && !solid(at(bot, behind)) && !solid(at(bot, behind.offset(0, 1, 0)))) await hold(ctx, ['back'], 350)
    const side = (Math.floor(gameClock.now() / 1000) % 2) ? 'left' : 'right'
    if (frontOk) await hold(ctx, ['forward', 'jump', side], 550)
    const moved = bot.entity.position.distanceTo(p0)
    return { applied: moved >= 0.3, why: `назад и прыжок, сдвиг ${moved.toFixed(2)}` }
  },
  // Снести видимое, что стоит между телом и целью: клетки ног и головы впереди, при подъёме — над головой.
  async breakAhead (ctx) { return breakToward(ctx, 1) },
  async breakAhead2 (ctx) { return breakToward(ctx, 2) },
  // Завалило: твёрдое в клетке головы/ног — выкопать (глаза внутри блока — он и есть под прицелом).
  async digOut (ctx) {
    const { bot } = ctx
    const feet = bot.entity.position.floored()
    const dug = []
    for (const c of [feet.offset(0, 1, 0), feet]) {
      const b = at(bot, c)
      if (!overlapsBody(bot, b) && !(b && /^(powder_snow|cobweb|sweet_berry_bush)$/.test(b.name))) continue
      const r = await digVisible(ctx, c)
      if (r.ok) dug.push(r.name)
      if (aborted(ctx)) break
    }
    return { applied: dug.length > 0, why: dug.length ? `выкопался: ${dug.join(', ')}` : 'нечего копать' }
  },
  // Из воды — к ближнему берегу (movement.escapeWater: путь по клеткам воды до сухой опоры или до воздуха).
  async swimOut (ctx) {
    const { bot } = ctx
    const m: typeof import('../movement') = require('../movement')
    if (!m.inWater(bot)) return { applied: false, why: 'не в воде' }
    // Берег вплавь в 16 бл. (с прыжком на уступ в 1 блок); нет — сразу ступенька/лесенка (пруд в яме, берег на 2+ выше).
    return swimTo(ctx, waterB, () => m.inWater(bot), { radius: 16, ms: 10000 })
  },
  // Из лавы (тонет с огнестойкостью — neF-mB26-1: goto ×214 «путь кончился» из лавового моря и смерть): путь по клеткам
  // лавы до сухой опоры, вверх и к ней.
  async swimOutLava (ctx) {
    const { bot } = ctx
    const inLava = () => !!bot.entity.isInLava || lavaB(at(bot, bot.entity.position.floored())) || lavaB(at(bot, bot.entity.position.offset(0, 0.9, 0).floored()))
    if (!inLava()) return { applied: false, why: 'не в лаве' }
    return swimTo(ctx, lavaB, inLava, { radius: 10, ms: 6000 })
  },
  // Ещё раз к берегу (после выемки или ступеньки берег вплавь мог появиться).
  async swimOut2 (ctx) { return RUNGS.swimOut(ctx) },
  // Выемка в берегу: берег выше воды на 1+ (из воды на него не вылезти: prismarine-physics — тело у стенки поднимается
  // до верха воды + 0.43, а надо + 1; kelp us-main2). Снести блоки берега впереди над уровнем воды (+1, +2), и берег —
  // вровень с водой: вперёд с прыжком — и на нём (симуляция: 36 тиков). Под водой копка медленнее — до 12 с.
  async notch (ctx) {
    const { bot, toward } = ctx
    const m: typeof import('../movement') = require('../movement')
    if (!m.inWater(bot)) return { applied: false, why: 'не в воде' }
    const dir = axisTo(bot, toward)
    if (!dir) return { applied: false, why: 'нет направления' }
    const col = bot.entity.position.floored()
    let y = col.y
    while (y < col.y + 3 && waterB(at(bot, new Vec3(col.x, y + 1, col.z)))) y++
    if (!waterB(at(bot, new Vec3(col.x, y, col.z)))) y--
    const front = new Vec3(col.x + dir.x, y, col.z + dir.z)
    if (!solid(at(bot, front))) return { applied: false, why: 'впереди не берег' }
    const dug = []; const skip = []
    for (const c of [front.offset(0, 2, 0), front.offset(0, 1, 0)]) {
      if (aborted(ctx)) break
      const b = at(bot, c)
      if (!solid(b)) continue
      const r = await digVisible(ctx, c, { maxMs: 12000 })
      if (r.ok) dug.push(r.name); else skip.push(`${b.name}: ${r.why}`)
    }
    if (solid(at(bot, front.offset(0, 1, 0))) || solid(at(bot, front.offset(0, 2, 0)))) return { applied: false, why: `выемку не сделал: ${skip.slice(0, 2).join('; ')}` }
    try { await bot.look(Math.atan2(-dir.x, -dir.z), 0, true) } catch {}
    const t0 = gameClock.now()
    try {
      bot.setControlState('forward', true); bot.setControlState('jump', true)
      while (gameClock.now() - t0 < 3000 && !aborted(ctx) && !(bot.entity.onGround && !m.inWater(bot))) await (ctx.sleep || sleepReal)(100)
    } finally { try { bot.clearControlStates() } catch {} }
    const out = bot.entity.onGround && !m.inWater(bot)
    return { applied: out || dug.length > 0, why: `выемка ${dug.join(', ') || 'уже была'}${out ? ', вылез' : ', не вылез'}` }
  },
  // Ступенька к цели: блок в клетку ног впереди (вода или пусто, под ней опора) и прыжок на него; стена в два блока —
  // столб на 1 и шаг.
  async stepUp (ctx) {
    const { bot, toward, ctl } = ctx
    const build: typeof import('../build') = require('../build')
    const dir = axisTo(bot, toward)
    if (!dir) return { applied: false, why: 'нет направления' }
    const feet = bot.entity.position.floored()
    const front = feet.plus(dir)
    const ff = at(bot, front); const fh = at(bot, front.offset(0, 1, 0)); const fa = at(bot, front.offset(0, 2, 0))
    const yaw = Math.atan2(-dir.x, -dir.z)
    const wet = waterB(at(bot, feet)) || waterB(ff)
    const higher = !!toward && toward.y > bot.entity.position.y + 0.9
    // (а) Впереди вода или пусто (под ней опора), а выше по ходу — уступ: блок в клетку ног впереди и прыжок на него.
    if (!solid(ff) && !solid(fh) && !lavaB(ff) && (wet || higher)) {
      const r = await build.placeBlockAt(bot, front, { honest: true, steady: true, timeoutMs: 2500 })
      if (!r.ok) return { applied: false, why: `ступенька: ${r.reason}` }
      try { await bot.look(yaw, 0, true) } catch {}
      await hold(ctx, ['forward', 'jump'], 600)
      return { applied: true, why: 'ступенька и прыжок' }
    }
    // (б) Стена в два блока, над ней и над головой свободно: столб на 1 и шаг на стену.
    if (solid(ff) && solid(fh) && !solid(fa) && !solid(at(bot, feet.offset(0, 2, 0))) && !wet) {
      const up = await build.towerUp(bot, ctl, 1, { sneak: false })
      if (!up.placed) return { applied: false, why: `столб: ${up.reason || (up.why && up.why[0]) || 'не встал'}` }
      try { await bot.look(yaw, 0, true) } catch {}
      await hold(ctx, ['forward', 'jump'], 600)
      return { applied: true, why: 'столб на 1 и шаг на стену' }
    }
    return { applied: false, why: 'ступенька некуда' }
  },
  // Вылезти из своей ямы/шахты столбом (build.escapePit: потолок с жидкостью за ним не вскрывает).
  async climbOut (ctx) {
    const { bot, ctl, mcData } = ctx
    const build: typeof import('../build') = require('../build')
    if (!build.inPit(bot)) return { applied: false, why: 'не в яме' }
    const r = await build.escapePit(bot, ctl, { maxClimb: 8, mcData })
    return { applied: !!(r && r.climbed > 0), why: `из ямы на ${r && r.climbed}${r && r.stopped ? ' — ' + r.stopped : ''}` }
  },
  // Промежуточная цель: A* к дальней цели не укладывается в 5 с (ферма: 17–34 узла за 40 мс), а к точке в 16–22 бл. по
  // пути — укладывается. Пробуем прямо к цели и под углом ±35°/±70°; засчитано, если тело стало ближе к цели на 6+.
  async waypoint (ctx) {
    const { bot, toward } = ctx
    if (!toward) return { applied: false, why: 'нет цели' }
    const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
    const { gotoGoal }: typeof import('../movement') = require('../movement')
    const p0 = bot.entity.position.clone()
    const dx = toward.x - p0.x; const dz = toward.z - p0.z
    const dist = Math.hypot(dx, dz)
    if (dist < 14) return { applied: false, why: 'цель близко' }
    const left = () => Math.hypot(toward.x - bot.entity.position.x, toward.z - bot.entity.position.z)
    const len = Math.min(22, dist * 0.6)
    const tried = []
    const tw = gameClock.now()
    for (const deg of [0, 35, -35, 70, -70]) {
      if (aborted(ctx) || gameClock.now() - tw > 25000 || (ctx.deadline && (ctx.now ? ctx.now() : gameClock.now()) > ctx.deadline - 8000)) break
      const a = deg * Math.PI / 180
      const ux = (dx * Math.cos(a) - dz * Math.sin(a)) / dist; const uz = (dx * Math.sin(a) + dz * Math.cos(a)) / dist
      const wx = Math.floor(p0.x + ux * len); const wz = Math.floor(p0.z + uz * len)
      const sub = new goals.GoalNearXZ(wx, wz, 3)
      let t = null
      try {
        await Promise.race([gotoGoal(bot, sub), new Promise<any>((_r, reject) => { t = gameClock.setTimeout(() => reject(new Error('промежуточная: 15 с')), 15000) })])
      } catch (err) { tried.push(`${deg}°: ${String(err.message).slice(0, 40)}`) } finally { gameClock.clearTimeout(t); try { bot.pathfinder.setGoal(null) } catch {} }
      if (dist - left() >= 6) return { applied: true, why: `промежуточная ${wx},${wz} (${deg}°): ближе на ${Math.round(dist - left())}` }
      if (bot.entity.position.distanceTo(p0) < 1) tried.push(`${deg}°: ни шага`)
    }
    return { applied: false, why: `промежуточные не помогли: ${tried.slice(0, 3).join('; ')}` }
  },
  // Обход блоками: мост на ходу и спуск блоками (blockmoves.js) — для этого перехода.
  async bypass (ctx) {
    const { session } = ctx
    if (!session) return { applied: false, why: 'нет сессии' }
    if (session.bridgeWanted === true || (session.movements && session.movements.bridge)) return { applied: false, why: 'мост уже включён' }
    session.bridgeWanted = true
    try { session.updateMovements(true) } catch {}
    return { applied: true, why: 'мост и спуск блоками на этот переход' }
  }
}
