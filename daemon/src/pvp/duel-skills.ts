import { goals } from 'mineflayer-pathfinder'
import * as assess from '../assess'
import { pickFiller, placeBlockAt, towerUp, withTimeout } from '../build'
import * as edges from '../edges'
import * as fortify from '../fortify'
import * as gameClock from '../game-clock'
import { bestWeapon } from '../items'
import * as mace from '../mace'
import { blockName, keyDir, solid } from '../moves'
import { raySees } from '../perception'
import * as pick from '../pick'
import * as ranged from '../ranged'
import * as spear from '../spear'
import * as tempo from '../tempo'
import * as threats from '../threats'
import * as throwMod from '../throw'
import * as tools from '../tools'
import * as totemMod from '../totem'
import { creeperSwelling, hasEffect, healthOf, onFire, reachFrom, stepSafe, yawTo } from './body'
import { countOf, findItem, findPotion, potionOf, potionRole } from './potions'
import { BOX_FRONT_MS, BOX_MS, COVER_MS, COVER_WIDE_MS, EYE, FIX, HIT_REACH, PILLAR_MS, TICK_MS, cooldownMs, isPlayer } from './rules'
import { Vec3 } from './vec3'
import { type DuelCtx } from './turn'

// Делегаты навыков и стенка с памятью неудач, столб.
export function installSkillDelegates (ctx: DuelCtx) {
  const { bot, buildHot, failedWalls, maceNow, session } = ctx
  ctx.heldName = (...args: any[]) => ctx.pvpSkills.heldName(...args)
  ctx.switched = (...args: any[]) => ctx.pvpSkills.switched(...args)
  ctx.pickWeaponFor = (...args: any[]) => ctx.pvpSkills.pickWeaponFor(...args)

  ctx.holdWeapon = (...args: any[]) => ctx.pvpSkills.holdWeapon(...args)

  ctx.holdItem = (...args: any[]) => ctx.pvpSkills.holdItem(...args)

  ctx.useAt = (...args: any[]) => ctx.pvpSkills.useAt(...args)

  ctx.foeGrounded = (...args: any[]) => ctx.pvpSkills.foeGrounded(...args)
  ctx.leadFn = (...args: any[]) => ctx.pvpSkills.leadFn(...args)
  ctx.reachable = (...args: any[]) => ctx.pvpSkills.reachable(...args)
  ctx.throwAt = (...args: any[]) => ctx.pvpSkills.throwAt(...args)

  ctx.placeUnder = (...args: any[]) => ctx.pvpSkills.placeUnder(...args)

  const wallToward = (...args: any[]) => ctx.pvpSkills.wallToward(...args)
  const wallInputs = ctx.wallInputs = (pos, wide = false) => {
    const me = bot.entity.position
    const dx = pos.x - me.x, dz = pos.z - me.z, n = Math.hypot(dx, dz) || 1
    const filler = pickFiller(bot)
    const cells = []
    for (const a of (wide ? [0, -Math.PI / 4, Math.PI / 4] : [0])) {
      const cell = new Vec3(Math.floor(me.x + (dx * Math.cos(a) - dz * Math.sin(a)) / n * 1.3), Math.floor(me.y), Math.floor(me.z + (dx * Math.sin(a) + dz * Math.cos(a)) / n * 1.3))
      for (const y of [-1, 0, 1]) { const b = bot.blockAt(cell.offset(0, y, 0)); cells.push(cell.offset(0, y, 0), b?.stateId ?? b?.name) }
    }
    return [me.floored(), filler?.name, filler && Math.min(wide ? 6 : 2, countOf(bot, filler.name)), ...cells,
      !!maceNow(), !!session._reflexState?.active].join('|')
  }
  ctx.coverFrom = async (pos, options: any = {}) => {
    const key = options.wide ? 'wide' : 'column'
    const inputs = wallInputs(pos, options.wide)
    if (failedWalls.get(key)?.inputs === inputs) return 0
    const placed = await ctx.pvpSkills.coverFrom(pos, options)
    if (placed) failedWalls.delete(key)
    else failedWalls.set(key, { inputs: wallInputs(pos, options.wide), why: 'no_visible_placement' })
    return placed
  }

  ctx.coverForDrink = (...args: any[]) => ctx.pvpSkills.coverForDrink(...args)
  const perchHeight = ctx.perchHeight = (...args: any[]) => ctx.pvpSkills.perchHeight(...args)
  ctx.headroom = (...args: any[]) => ctx.pvpSkills.headroom(...args)
  ctx.pillarOut = async () => {
    const h = perchHeight()
    const inputs = ctx.columnInputs(h) + '|' + buildHot(h * PILLAR_MS)
    if (ctx.failedPillar?.inputs === inputs) return false
    const ok = await ctx.pvpSkills.pillarOut()
    ctx.failedPillar = ok ? null : { inputs: ctx.columnInputs(perchHeight()) + '|' + buildHot(perchHeight() * PILLAR_MS), why: 'pillar_not_confirmed' }
    return ok
  }
}

// Спуск со столба с памятью неудачи по входам.
export function installPerchDrop (ctx: DuelCtx) {
  const { bot, routeInputs, session } = ctx
  ctx.dropFromPerch = async () => {
    const support = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    const supportInputs = [routeInputs(), support?.stateId ?? support?.name, support && tools.bestFor(bot, support).ms,
      ctx.itemInputs(/water_bucket|mace|boots$/), hasEffect(bot, 'resistance'), !!bot._ndFallGuard?.waterReady?.().ok,
      !!session._reflexState?.active].join('|')
    const inputs = [routeInputs(), bot.entity.onGround, ctx.itemInputs(/water_bucket|mace|boots$/),
      bot.health, hasEffect(bot, 'resistance'), !!bot._ndFallGuard?.waterReady?.().ok].join('|')
    if (ctx.failedPerchDrop?.kind === 'dig' ? ctx.failedPerchDrop.supportInputs === supportInputs : ctx.failedPerchDrop?.inputs === inputs) return { ok: false, acted: false }
    const result = await ctx.pvpSkills.dropFromPerch()
    ctx.failedPerchDrop = result.ok ? null : { inputs, supportInputs, kind: result.kind, why: result.kind === 'dig' ? 'support_not_removed' : 'no_safe_descent' }
    return result
  }
}

// Коробка: делегаты.
export function installFortDelegates (ctx: DuelCtx) {
  ctx.healItem = (...args: any[]) => ctx.pvpSkills.healItem(...args)
  ctx.fortPossible = (...args: any[]) => ctx.pvpSkills.fortPossible(...args)
  ctx.isAir = (...args: any[]) => ctx.pvpSkills.isAir(...args)
  ctx.cellOk = (...args: any[]) => ctx.pvpSkills.cellOk(...args)
  ctx.fortSpot = (...args: any[]) => ctx.pvpSkills.fortSpot(...args)
}

// Коробка с памятью неудачи по входам и риску.
export function installFort (ctx: DuelCtx) {
  const { bot, buildHot, fortSpot, st, style, tt, wallInputs } = ctx
  const fortInputs = () => {
    const spot = fortSpot()
    const check = spot && fortify.boxCheck(bot, { cell: spot, toward: ctx.entity.position, roof: true })
    return [spot, check?.why, check?.ok, wallInputs(ctx.entity.position, true)].join('|')
  }
  ctx.fortOut = async () => {
    const inputs = fortInputs()
    const risk = [bot.health, totemMod.absorption(bot), tt.safe(BOX_MS + style.reactMs).ok, buildHot(BOX_MS)].join('|')
    if (ctx.failedFort?.inputs === inputs && (ctx.failedFort.why === 'construction_unconfirmed' || ctx.failedFort.risk === risk)) return false
    const started = st.build?.box || 0
    const ok = await ctx.pvpSkills.fortOut()
    ctx.failedFort = ok ? null : { inputs: fortInputs(), risk, why: (st.build?.box || 0) > started ? 'construction_unconfirmed' : 'siting_or_risk' }
    return ok
  }
}

// Ямы, вёдра, паутина, еда и зелья, жемчуг — делегаты и память неудач.
export function installHazardSkills (ctx: DuelCtx) {
  const { bot, columnInputs, itemInputs, routeInputs } = ctx
  ctx.edgeTally = (...args: any[]) => ctx.pvpSkills.edgeTally(...args)
  ctx.climbOut = async pit => {
    const inputs = columnInputs(pit.depth) + '|' + routeInputs()
    if (ctx.failedPitExit?.inputs === inputs) return false
    const ok = await ctx.pvpSkills.climbOut(pit)
    ctx.failedPitExit = ok ? null : { inputs: columnInputs(Math.max(0, (pit.rimY ?? bot.entity.position.y + pit.depth) - bot.entity.position.y)) + '|' + routeInputs(), why: 'rim_not_reached' }
    return ok
  }
  ctx.lavaIntoPit = async lava => {
    const inputs = routeInputs() + '|' + itemInputs(/bucket$/)
    if (ctx.failedPitLava?.inputs === inputs) return false
    const ok = await ctx.pvpSkills.lavaIntoPit(lava)
    ctx.failedPitLava = ok ? null : { inputs: routeInputs() + '|' + itemInputs(/bucket$/), why: 'pit_access_or_lava_unconfirmed' }
    return ok
  }

  ctx.bucketLanding = (...args: any[]) => ctx.pvpSkills.bucketLanding(...args)
  ctx.useOnGroundAt = (...args: any[]) => ctx.pvpSkills.useOnGroundAt(...args)

  ctx.scoop = (...args: any[]) => ctx.pvpSkills.scoop(...args)
  ctx.towerShield = (...args: any[]) => ctx.pvpSkills.towerShield(...args)

  ctx.hazardOnLine = (...args: any[]) => ctx.pvpSkills.hazardOnLine(...args)
  ctx.unblockPath = (...args: any[]) => ctx.pvpSkills.unblockPath(...args)

  ctx.digWatch = (...args: any[]) => ctx.pvpSkills.digWatch(...args)

  ctx.punishable = (...args: any[]) => ctx.pvpSkills.punishable(...args)

  ctx.eatHeld = (...args: any[]) => ctx.pvpSkills.eatHeld(...args)
  ctx.consumeItem = (...args: any[]) => ctx.pvpSkills.consumeItem(...args)

  ctx.drink = (...args: any[]) => ctx.pvpSkills.drink(...args)

  ctx.escapePearl = (...args: any[]) => ctx.pvpSkills.escapePearl(...args)
}

// Контекст частей навыков (equipment, cover, terrain, recovery) и сами навыки.
export function installSkills (ctx: DuelCtx) {
  const { PERCH_MAX, TOWER_SAFE_DRAW_MS, bot, bowWatch, bucketLanding, buildDone, buildGuard, buildHot, cellOk, clear, consumeItem, coverForDrink, coverFrom, ctl, digWatch, drink, eatHeld, edgeGuard, falls, foeGrounded, foeHpDecide, fortSealed, fortSpot, guard, guardCtl, hazardOnLine, headroom, healItem, heldName, holdItem, holdWeapon, isAir, leadFn, maceAbort, maceNow, mc, noteBuild, pathTo, pendingWater, perchHeight, punishable, rangedAllowed, reachable, ready, rest, retarget, routeInputs, scoop, session, set, st, style, switched, telemetryHp, towerShield, tt, useAt, useOnGroundAt, used } = ctx
  const combatContext = {
get consumeItem () { return consumeItem },
get aim () { return ctx.aim }, set aim (value) { ctx.aim = value },
get aimPoint () { return ctx.aimPoint }, set aimPoint (value) { ctx.aimPoint = value },
get assess () { return assess },
get bestWeapon () { return bestWeapon },
get blockName () { return blockName },
get bot () { return bot },
get bowWatch () { return bowWatch },
get BOX_FRONT_MS () { return BOX_FRONT_MS },
get BOX_MS () { return BOX_MS },
get bucketLanding () { return bucketLanding },
get buildDone () { return buildDone },
get buildGuard () { return buildGuard },
get buildHot () { return buildHot },
get cellOk () { return cellOk },
get chosenWeapon () { return ctx.chosenWeapon }, set chosenWeapon (value) { ctx.chosenWeapon = value },
get clear () { return clear },
get cooldownMs () { return cooldownMs },
get countOf () { return countOf },
get COVER_MS () { return COVER_MS },
get COVER_WIDE_MS () { return COVER_WIDE_MS },
get coverForDrink () { return coverForDrink },
get coverFrom () { return coverFrom },
get creeperSwelling () { return creeperSwelling },
get ctl () { return ctx.ctl }, set ctl (value) { ctx.ctl = value },
get digWatch () { return digWatch },
get drink () { return drink },
get eatHeld () { return eatHeld },
get edgeGuard () { return edgeGuard },
get edges () { return edges },
get entity () { return ctx.entity }, set entity (value) { retarget(value) },
get EYE () { return EYE },
get falls () { return falls },
get findItem () { return findItem },
get findPotion () { return findPotion },
get FIX () { return FIX },
get foeGrounded () { return foeGrounded },
get fort () { return ctx.fort }, set fort (value) { ctx.fort = value },
get fortify () { return fortify },
get fortSealed () { return fortSealed },
get fortSpot () { return fortSpot },
get gameClock () { return gameClock },
get goals () { return goals },
get guard () { return guard },
get guardCtl () { return guardCtl },
get hasEffect () { return hasEffect },
get hazardOnLine () { return hazardOnLine },
get headroom () { return headroom },
get healItem () { return healItem },
get healthOf () { return healthOf },
get telemetryHp () { return telemetryHp },
get foeHpDecide () { return foeHpDecide },
get heldName () { return heldName },
get HIT_REACH () { return HIT_REACH },
get holdItem () { return holdItem },
get itemReady () { return pvpSkills.itemReady },
get holdWeapon () { return holdWeapon },
get isAir () { return isAir },
get isPlayer () { return isPlayer },
get keyDir () { return keyDir },
get lastHurtByTarget () { return ctx.lastHurtByTarget }, set lastHurtByTarget (value) { ctx.lastHurtByTarget = value },
get lastSwing () { return ctx.lastSwing }, set lastSwing (value) { ctx.lastSwing = value },
get leadFn () { return leadFn },
get mace () { return mace },
get maceAbort () { return maceAbort },
get maceNow () { return maceNow },
get mc () { return mc },
get nextReady () { return ctx.nextReady }, set nextReady (value) { ctx.nextReady = value },
get noteBuild () { return noteBuild },
get onFire () { return onFire },
get pathing () { return ctx.pathing }, set pathing (value) { ctx.pathing = value },
get pathTo () { return pathTo },
get pendingWater () { return pendingWater },
get perch () { return ctx.perch }, set perch (value) { ctx.perch = value },
get PERCH_MAX () { return PERCH_MAX },
get perchHeight () { return perchHeight },
get pick () { return pick },
get pickFiller () { return pickFiller },
get PILLAR_MS () { return PILLAR_MS },
get placeBlockAt () { return placeBlockAt },
get potionOf () { return potionOf },
get potionRole () { return potionRole },
get process () { return process },
get prof () { return ctx.prof }, set prof (value) { ctx.prof = value },
get punishable () { return punishable },
get ranged () { return ranged },
get rangedAllowed () { return rangedAllowed },
get raySees () { return raySees },
get reachable () { return reachable },
get routeInputs () { return routeInputs },
get reachFrom () { return reachFrom },
get ready () { return ready },
get rest () { return rest },
get scoop () { return scoop },
get seesNow () { return ctx.seesNow },
get session () { return ctx.session }, set session (value) { ctx.session = value },
get set () { return set },
get sleep () { return ctx.sleep },
get solid () { return solid },
get spear () { return spear },
get st () { return st },
get stepSafe () { return stepSafe },
get style () { return style },
get switched () { return switched },
get tempo () { return tempo },
get theirPit () { return ctx.theirPit }, set theirPit (value) { ctx.theirPit = value },
get throwMod () { return throwMod },
get threats () { return threats },
get TICK_MS () { return TICK_MS },
get tools () { return tools },
get TOWER_SAFE_DRAW_MS () { return TOWER_SAFE_DRAW_MS },
get towerShield () { return towerShield },
get towerUp () { return towerUp },
get track () { return ctx.track }, set track (value) { ctx.track = value },
get tt () { return tt },
get throwWhy () { return ctx.throwWhy }, set throwWhy (value) { ctx.throwWhy = value },
get useAt () { return useAt },
get used () { return used },
get useOnGroundAt () { return useOnGroundAt },
get Vec3 () { return Vec3 },
get weapon () { return ctx.weapon }, set weapon (value) { ctx.weapon = value },
get withTimeout () { return withTimeout },
get yawTo () { return yawTo }
}
const pvpSkills = ctx.pvpSkills = {
...require('./equipment').createEquipment(combatContext),
...require('./cover').createCover(combatContext),
...require('./terrain').createTerrain(combatContext),
...require('./recovery').createRecovery(combatContext)
}
}

// Разгон копьём издалека, честная видимость сейчас.
export function installLateSkills (ctx: DuelCtx) {
  const { bot, pvpSkills, vision } = ctx
  ctx.spearChargeFar = (...args: any[]) => pvpSkills.spearChargeFar(...args)
  ctx.seesNow = () => { try { return (!ctx.prof.player || vision.visible(ctx.entity)) && raySees(bot, bot.entity.position.offset(0, EYE, 0), ctx.entity.position.offset(0, (ctx.entity.height || 1.8) * 0.55, 0)) } catch { return false } }
}
