import { goals } from 'mineflayer-pathfinder'
import * as boom from '../boom'
import { pickFiller } from '../build'
import * as crystal from '../crystal'
import * as edges from '../edges'
import * as elytra from '../elytra'
import * as gameClock from '../game-clock'
import * as mace from '../mace'
import { keyDir } from '../moves'
import * as showman from '../showman'
import { stepSafe } from './body'
import { countOf, findItem } from './potions'
import { FIX, cooldownMs } from './rules'
import { Vec3 } from './vec3'
import { type DuelCtx } from './turn'

// Управление, показ, путь, арена, край, булава, элитры, жемчуг, взрывчатка, кристаллы; уборка по прерыванию.
export function installServices (ctx: DuelCtx) {
  const { aimTimer, arena, bot, ctl, foeHpDecide, guard, keys, mf, onCrack, onCrackEnd, onMlg, session, st, style, telemetryHp, tt, used, vision } = ctx
  const clear = ctx.clear = () => { for (const k of keys) { try { bot.setControlState(k, false) } catch {} } }
  const set = ctx.set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
  const hm = ctx.hm = showman.create({
    bot, session, target: () => ctx.entity, observe: vision.observe, style, used, set, tt, styleOut: st.style,
    aimTo: (mode, point = null) => { ctx.aim = mode; ctx.aimPoint = point },
    stopPath: () => { if (ctx.pathing) { pathTo(false); ctx.pathing = false } },
    stepOk: (k) => stepSafe(bot, keyDir(bot, k)),
    fillerCount: () => { const f = pickFiller(bot); return f ? countOf(bot, f.name) : 0 },
    cover: async (pos) => { const n = await ctx.coverFrom(pos, { what: 'засада: колонна между нами' }); await ctx.holdWeapon(); return n },
    weaponMs: () => cooldownMs(bot.heldItem),
    onAirSwing: () => { ctx.nextReady = Math.max(ctx.nextReady, gameClock.now() + cooldownMs(bot.heldItem)) },
    nearDrop: () => { try { return FIX && !!ctx.entity.position && edges.dropAlong(bot, ctx.entity.position, 4.5) } catch { return false } }
  })
  if (hm) ctl.onAbort.push(() => hm.close())

  const pathTo = ctx.pathTo = (on, goal = null) => {
    try {
      const mv = bot.pathfinder.movements
      const webId = bot.registry.blocksByName.cobweb && bot.registry.blocksByName.cobweb.id
      if (on && mv && mv.blocksToAvoid && webId != null) mv.blocksToAvoid.add(webId)
      if (on && !goal && ctx.holdGoal) goal = ctx.holdGoal
      if (on) bot.pathfinder.setGoal(goal || new goals.GoalFollow(ctx.entity, 2), !goal)
      else bot.pathfinder.setGoal(null)
    } catch {}
  }
  const miningProgress = ctx.miningProgress = require('./movement').createPathMiningProgress(bot, () => gameClock.now())
  const onRoutePath = ctx.onRoutePath = result => {
    if (ctx.pathing && result?.status === 'noPath' && !miningProgress()) {
      if (ctx.reposition) ctx.reposition.failed = 'noPath'
      if (ctx.flankRoute) ctx.flankRoute.failed = 'noPath'
      if (ctx.counterRoute) ctx.counterRoute.failed = 'noPath'
      if (ctx.siegeRoute) ctx.siegeRoute.failed = 'noPath'
    }
  }
  bot.on('path_update', onRoutePath)

  const mv = bot.pathfinder && bot.pathfinder.movements
  const { arena: AR, onField, restore: restoreMoves } = require('./movement').combatMovement(bot, arena)
  ctx.AR = AR
  ctx.onField = onField
  ctx.restoreMoves = restoreMoves
  ctx.guardSpot = (p) => {
    if (!AR) return null
    const fy = Math.floor(AR.y + 1e-6) - 1
    const cx = Math.max(AR.x - AR.r + 1, Math.min(AR.x + AR.r - 1, p.x))
    const cz = Math.max(AR.z - AR.r + 1, Math.min(AR.z + AR.r - 1, p.z))
    const floorAt = (x, z) => { const b = bot.blockAt(new Vec3(x, fy, z), false); return !!b && b.boundingBox === 'block' }
    const clearAt = (x, z) => { for (const k of [1, 2]) { const b = bot.blockAt(new Vec3(x, fy + k, z), false); if (!b || b.boundingBox !== 'empty' || /lava|fire|cobweb/.test(b.name)) return false } return true }
    let best = null
    for (let dx = -7; dx <= 7; dx++) {
      for (let dz = -7; dz <= 7; dz++) {
        const x = Math.floor(cx) + dx; const z = Math.floor(cz) + dz
        if (Math.abs(x + 0.5 - AR.x) > AR.r - 1 || Math.abs(z + 0.5 - AR.z) > AR.r - 1) continue
        if (!floorAt(x, z) || !clearAt(x, z)) continue
        let safe = true
        for (let ax = -1; ax <= 1 && safe; ax++) for (let az = -1; az <= 1 && safe; az++) if (!floorAt(x + ax, z + az)) safe = false
        if (!safe) continue
        const dist = Math.hypot(x + 0.5 - p.x, z + 0.5 - p.z)
        if (!best || dist < best.dist) best = { x, z, dist }
      }
    }
    return best ? new Vec3(best.x, fy + 1, best.z) : null
  }
  const edgeGuard = ctx.edgeGuard = edges.guard(bot, {
    margin: () => (ctx.entity && ctx.entity.isValid && ctx.entity.position && bot.entity && ctx.entity.position.distanceTo(bot.entity.position) < 6 ? 0.35 : 0)
  })
  const mc = ctx.mc = mace.track(bot, { enemy: () => ctx.entity, telemetryHp })
  ctl.onAbort.push(() => mc.close())
  const sky = ctx.sky = elytra.create(bot, { enemy: () => ctx.entity, used, edgeGuard, arena: AR, telemetryHp })
  ctl.onAbort.push(() => sky.close())
  const pearlResponse = ctx.pearlResponse = require('../combat/pearl-response').createPearlResponse(bot, {
    enemy: () => ctx.entity, used,
    webAt: async (point, controller) => {
      const web = findItem(bot, i => i.name === 'cobweb')
      return !!web && ctx.pvpSkills.placeAt(web, new Vec3(point.x, point.y, point.z), 'паутина в точке прилёта жемчуга', controller)
    }
  })
  ctl.onAbort.push(() => pearlResponse.close())
  const bm = ctx.bm = boom.create(bot, { enemy: () => ctx.entity, used, crystals: !crystal.ON, telemetryHp })
  ctl.onAbort.push(() => bm.close())
  // Хп соперника-игрока в решениях кристаллов — оценкой (правило 06.10); урон своих подрывов — в оценку (S7c).
  const cx = ctx.cx = crystal.create(bot, { enemy: () => ctx.entity, used, guard, telemetryHp, foeHp: (e) => foeHpDecide(e), noteAttack: (r, o) => ctx.calc.noteAttack(r, o) })
  ctl.onAbort.push(() => cx.close())
  ctx.maceNow = () => { try { return !!(ctx.prof.player && mc.threat()) } catch { return false } }
  ctx.maceAbort = (what) => { st.maceAborts = (st.maceAborts || 0) + 1; used('бросил ' + what + ': булава сверху') }
  ctx.buildGuard = (...args: any[]) => ctx.pvpSkills.buildGuard(...args)
  ctx.guardCtl = (...args: any[]) => ctx.pvpSkills.guardCtl(...args)
  ctx.buildDone = (...args: any[]) => ctx.pvpSkills.buildDone(...args)
  ctx.buildHot = (...args: any[]) => ctx.pvpSkills.buildHot(...args)
  ctx.noteBuild = (...args: any[]) => ctx.pvpSkills.noteBuild(...args)

  ctl.onAbort.push(() => {
    gameClock.clearInterval(aimTimer)
    bot.removeListener('path_update', onRoutePath)
    bot.removeListener('blockBreakProgressObserved', onCrack)
    bot.removeListener('blockBreakProgressEnd', onCrackEnd)
    clear()
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.deactivateItem() } catch {}
    restoreMoves()
    edgeGuard.stop()
    bot.removeListener('nd_mlg', onMlg)
    tt.close()
    if (session.tempo === tt) session.tempo = null
    mf.close()
    ctx.pvpSkills.closeEquipment()
  })
}
