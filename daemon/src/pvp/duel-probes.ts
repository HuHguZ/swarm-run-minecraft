import { DRAW_MS as BOW_DRAW_MS } from '../bow'
import * as edges from '../edges'
import * as gameClock from '../game-clock'
import * as mace from '../mace'
import * as pick from '../pick'
import * as tools from '../tools'
import { creeperSwelling, livingFlags } from './body'
import { EYE } from './rules'
import { Vec3 } from './vec3'
import { type DuelCtx } from './turn'

// Пробы мира: небо над ним и навес рядом (молния «Громовержца»).
export function installProbes (ctx: DuelCtx) {
  const { bot } = ctx
  // Небо над ним для молнии «Громовержца» (channeling.json: can_see_sky у жертвы) — честно: крыша над ним известна,
  // только если я её вижу (pick.blockSeen); невидимый сверху блок — неизвестность, человек считал бы небо открытым.
  // Стекло и барьер свет неба пропускают (над ареной фермы барьер) — не крыша.
  ctx.skyOver = (e) => {
    try {
      const top = e.position.floored().offset(0, 2, 0)
      for (let k = 0; k < 40; k++) {
        const c = top.offset(0, k, 0)
        const b = bot.blockAt(c, false)
        if (!b) return true
        if (b.boundingBox !== 'block' || /glass|barrier|ice/.test(b.name)) continue
        return !pick.blockSeen(bot, c)
      }
    } catch {}
    return true
  }
  // Навес рядом: клетка, где стоять (опора, 2 воздуха), а над головой в 1–5 бл. — непрозрачный блок, который я вижу.
  ctx.shelterNear = (R = 6) => {
    const me0 = bot.entity.position.floored()
    let best = null
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) for (const dy of [0, -1, 1]) {
      const c = me0.offset(dx, dy, dz)
      const dd = Math.hypot(dx, dz)
      if (dd > R || (best && dd >= best.d)) continue
      const fl = bot.blockAt(c.offset(0, -1, 0), false); const a0 = bot.blockAt(c, false); const a1 = bot.blockAt(c.offset(0, 1, 0), false)
      if (!fl || fl.boundingBox !== 'block' || !a0 || a0.boundingBox !== 'empty' || !a1 || a1.boundingBox !== 'empty' || /lava|fire|cobweb|water/.test(a0.name + a1.name)) continue
      let roof = null
      for (let k = 2; k <= 6 && !roof; k++) { const b = bot.blockAt(c.offset(0, k, 0), false); if (b && b.boundingBox === 'block' && !/glass|barrier|ice/.test(b.name)) roof = c.offset(0, k, 0) }
      if (!roof || !pick.blockSeen(bot, roof)) continue
      best = { x: c.x, y: c.y, z: c.z, d: dd }
    }
    return best
  }
}

// Трасса боя для разбора (ND_TRACE_PVP).
export function installTrace (ctx: DuelCtx) {
  const { bot, traceT0 } = ctx
  // Трасса боя для разбора (ND_TRACE_PVP): время, кто, что — в лог демона.
  ctx.TRACE = !!process.env.ND_TRACE_PVP
  ctx.trace = (what) => { try { console.log(`[trace] ${new Date().toISOString().slice(11, 19)} ${bot.username} +${((gameClock.now() - traceT0) / 1000).toFixed(1)}s ${what}`) } catch {} }
}

// Точка прострела и входы маршрута (ключ памяти неудачных подходов).
export function installSight (ctx: DuelCtx) {
  const { bot } = ctx
  // Точка прострела: клетка в 3–6 бл. по горизонтали от его колонны, где стоять (опора, 2 воздуха) и откуда луч
  // от глаз до его груди свободен — ближайшая ко мне.
  ctx.losSpot = () => {
    try {
      const me0 = bot.entity.position
      const ep = ctx.foeSeenPos
      if (!ep) return null
      const ownCell = me0.floored()
      const observed = require('./search').observedCollision(bot)
      const sightWorld = { blockAt: p => observed.blockAt(p) || { boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } }
      const chest = ep.offset(0, (ctx.entity.height || 1.8) * 0.6, 0)
      let best = null
      for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
        const hd = Math.hypot(dx, dz)
        if (hd < 3 || hd > 6.2) continue
        for (const dy0 of [0, 1, -1]) {
          const c = new Vec3(Math.floor(ep.x) + dx, Math.floor(me0.y) + dy0, Math.floor(ep.z) + dz)
          if (c.equals(ownCell)) continue // GoalBlock is already reached: no change of viewpoint.
          const fl = observed.blockAt(c.offset(0, -1, 0)); const a0 = observed.blockAt(c); const a1 = observed.blockAt(c.offset(0, 1, 0))
          if (!fl || fl.boundingBox !== 'block' || !a0 || a0.boundingBox !== 'empty' || !a1 || a1.boundingBox !== 'empty' || /lava|fire|cobweb/.test(a0.name + a1.name)) continue
          if (ctx.AR && !ctx.onField(c.offset(0.5, 0, 0.5))) continue
          const eye = c.offset(0.5, EYE, 0.5); const delta = chest.minus(eye); const len = delta.norm()
          if (pick.blockOnRay(sightWorld, eye, delta.scaled(1 / len), len)) continue
          const md = Math.hypot(c.x + 0.5 - me0.x, c.z + 0.5 - me0.z)
          if (!best || md < best.md) best = { x: c.x, y: c.y, z: c.z, md }
          break
        }
      }
      return best
    } catch { return null }
  }
  ctx.routeInputs = () => {
    const feet = bot.entity.position.floored()
    const target = ctx.entity.position.floored()
    const observed = require('./search').observedCollision(bot)
    const inputs = [ctx.entity.id, feet.toString(), target.toString(), bot.pathfinder?.movements?.canDig, bot.pathfinder?.movements?.maxDropDown]
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const dy of [-1, 0, 1, 2]) {
      const cell = feet.offset(dx, dy, dz)
      const b = observed.blockAt(cell)
      inputs.push(b ? b.stateId ?? b.name : '?')
      if (dy >= 0 && b?.boundingBox === 'block') {
        let digMs = null
        try { digMs = tools.bestFor(bot, b).ms } catch {}
        inputs.push(digMs)
      }
    }
    const eye = pick.eyeOf(bot); const delta = ctx.entity.position.offset(0, EYE, 0).minus(eye); const dist = delta.norm()
    const hit = dist > 0 ? pick.blockOnRay(bot, eye, delta.scaled(1 / dist), dist) : null
    if (hit) {
      let digMs = null
      try { digMs = tools.bestFor(bot, hit.block).ms } catch {}
      inputs.push(hit.pos.toString(), hit.block.stateId ?? hit.block.name, digMs)
    }
    return inputs.join('|')
  }
}

// Входы приёмов (что видно и чем) — ключи памяти неудач; отход от взрыва.
export function installInputs (ctx: DuelCtx) {
  const { bot, dead, fortSealed, maceNow, routeInputs, tt } = ctx
  ctx.punchThrough = (...args: any[]) => ctx.pvpSkills.punchThrough(...args)
  ctx.shotInputs = () => [routeInputs(), itemInputs(/^(bow|crossbow|firework_rocket)$|arrow$/),
    !!bot._ndUse?.cur, livingFlags(bot, bot.entity), typeof bot.ndClock?.age === 'bigint',
    !!maceNow(), tt.safe(BOW_DRAW_MS, { fortSealed: fortSealed() }).ok].join('|')
  const itemInputs = ctx.itemInputs = names => bot.inventory.items().filter(i => names.test(i.name)).map(i =>
    [i.name, i.slot, i.count, i.durabilityUsed, JSON.stringify(i.components || [])].join(':')).join('|')
  ctx.columnInputs = height => {
    const feet = bot.entity.position.floored()
    const blocks = []
    for (let y = -1; y <= height + 2; y++) {
      const cell = feet.offset(0, y, 0)
      const b = bot.blockAt(cell)
      blocks.push(y <= 0 || pick.blockSeen(bot, cell) ? b?.stateId ?? b?.name : '?')
    }
    return [feet, ctx.entity.id, ctx.entity.position.floored(), edges.fillerCount(bot), ...blocks].join('|')
  }
  ctx.windInputs = (native = true) => [routeInputs(), bot.entity.onGround, bot.entity.elytraFlying,
    itemInputs(/^(mace|elytra|wind_charge|firework_rocket)$|spear$/), native ? gameClock.now() >= (bot._ndWindCd || 0) : '',
    mace.shieldAtUs(bot, ctx.entity), !!maceNow()].join('|')
  ctx.blastRetreat = () => {
    const splash = ctx.pvpSkills.splashDanger()
    if (splash) return splash
    if (!ctx.creeperBack) return null
    if (ctx.entity.id !== ctx.creeperBack.id || ctx.entity.isValid === false || dead.has(ctx.entity.id)) { ctx.creeperBack = null; return null }
    const radius = creeperSwelling(bot, ctx.entity) ? 6.5 : 3.8
    if (bot.entity.position.distanceTo(ctx.entity.position) >= radius) { ctx.creeperBack = null; return null }
    return { id: ctx.entity.id, at: ctx.entity.position, radius }
  }
}
