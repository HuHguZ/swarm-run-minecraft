import * as assess from '../assess'
import * as edges from '../edges'
import * as gameClock from '../game-clock'
import { keyDir } from '../moves'
import * as owShield from '../ow-shield'
import { raySees } from '../perception'
import * as pick from '../pick'
import * as tempo from '../tempo'
import { hasEffect, lookDead, nextFoe, reachFrom, stepSafe, usingItem } from './body'
import { foodAnimals } from './food-fire'
import { countOf, findItem, findPotion } from './potions'
import { EDIBLE, EYE, FAR, FIX, HIT_REACH, TICK_MS } from './rules'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'
import { isAlly } from '../combat/ally-safety'

// Жив ли я и цель, убил ли, обход моба, следующая цель, конец по времени.
export async function targetTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, burningFood, clear, clearArea, dead, deadline, edgeTally, finish, foodFire, guard, hm, holdWeapon, kills, opts, otherAttacker, retarget, st, tt, used, vision } = ctx
  const now = turn.now = gameClock.now()
  if (!bot.entity || (bot.health ?? 20) <= 0 || ctx.selfDied) return { end: finish({ died: true }) }
  if (isAlly(bot, ctx.entity)) return { end: finish({ stopped: 'цель — союзник' }) }
  vision.observe(ctx.entity)
  if (opts.purpose === 'food' && foodAnimals.has(ctx.entity.name) && (ctx.entity.metadata?.[0] & 1) && !burningFood.has(ctx.entity.id)) {
    burningFood.add(ctx.entity.id); foodFire.burningObserved++
  }
  edgeTally(now)
  if (edges.falling(bot)) { clear(); await ctx.sleep(TICK_MS); return NEXT }
  if (!ctx.killed && !ctx.entity.isValid && !ctx.prof.player && now - ctx.targetHurtAt < 2500) ctx.killed = true
  if (ctx.mobDetour) {
    const md = ctx.mobDetour
    let seenM = false
    try { seenM = ctx.entity.isValid && assess.inSight(bot, ctx.entity) } catch {}
    if (seenM) md.seenAt = now
    const farM = !ctx.entity.isValid || !ctx.entity.position || ctx.entity.position.distanceTo(bot.entity.position) > 16
    if (ctx.killed || farM || lookDead(bot, ctx.entity) || now - md.seenAt > 5000 || now - md.at > 25000) {
      const wasKilled = ctx.killed
      if (wasKilled) st.mobKills = (st.mobKills || 0) + 1
      dead.add(ctx.entity.id)
      ctx.mobDetour = null
      ctx.killed = false
      ctx.unseen = false
      const back = md.back
      if (back && back.isValid !== false && bot.entities[back.id]) {
        retarget(back)
        used(wasKilled ? `убил ${md.name} — снова к ${ctx.label}` : `${md.name} отстал — снова к ${ctx.label}`)
        await holdWeapon()
        return NEXT
      }
      return { end: finish({ lost: `${back ? (back.username || back.name) : '?'} пропал из виду` }) }
    }
  }
  if (!ctx.prof.player) {
    if (assess.inSight(bot, ctx.entity)) ctx.seenAt = now
    else if (now - ctx.seenAt > 6000) { dead.add(ctx.entity.id); ctx.unseen = true }
  }
  const lostIt = !ctx.killed && (!ctx.entity.isValid || ctx.unseen)
  if (ctx.unseen && !clearArea) return { end: finish({ lost: `${ctx.label} не видно — за стеной` }) }
  ctx.unseen = false
  if (ctx.killed || (lostIt && clearArea)) {
    dead.add(ctx.entity.id)
    if (ctx.killed) kills.push(ctx.label)
    let next = null
    if (clearArea) {
      try { const p = assess.plan(bot, { radius: clearArea, exclude: dead }); next = p && p.first ? p.first.e : null } catch {}
      if (!next) next = nextFoe(bot, clearArea, dead)
    }
    if (!next && ctx.prof.player) { const o = otherAttacker(); if (o) { next = o.e; used(`переключился на ${o.e.username}`) } }
    if (!next) {
      if (hm && ctx.killed && ctx.prof.player) hm.victory()
      return { end: finish(kills.length ? { killed: kills.length > 1 ? kills.join(', ') : kills[0] } : { lost: `${ctx.label} пропал из виду` }) }
    }
    retarget(next)
    await holdWeapon()
    return NEXT
  }
  if (clearArea && !ctx.prof.player && now >= ctx.replanAt) {
    ctx.replanAt = now + 1500
    try {
      const p = assess.plan(bot, { radius: clearArea, exclude: dead })
      const f = p && p.first
      if (f && f.e && f.e !== ctx.entity && f.e.isValid !== false) {
        const curD = ctx.entity.position.distanceTo(bot.entity.position)
        if (f.swelling || (curD > 10 && f.dist < 5)) { retarget(f.e); await holdWeapon(); return NEXT }
      }
    } catch {}
  }
  if (!ctx.entity.isValid) return { end: finish({ lost: `${ctx.label} пропал из виду` }) }
  if (opts.repelLava && (ctx.entity.position.distanceTo(bot.entity.position) > 3 || !hasEffect(bot, 'fire_resistance'))) return { end: finish({ repelled: true }) }
  if (now > deadline) return { end: finish({ timeout: true, targetAlive: true }) }

  ctx.owShot = !ctx.prof.player && guard?.stats?.worn ? owShield.rangedGuard(bot, tt.threats()) : null
  ctx.track.update()
}

// Расстояния, досягаемость, хп, лечение под рукой, общая безопасность.
export function measureTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { AR, bot, fortSealed, healAt, maceNow, opts, retreatAtHealth, tt } = ctx
  const me = turn.me = bot.entity.position
  const eye = turn.eye = me.offset(0, EYE, 0)
  turn.d = Math.hypot(ctx.entity.position.x - me.x, ctx.entity.position.z - me.z)
  turn.dy = ctx.entity.position.y - me.y
  turn.r = reachFrom(eye, ctx.entity)
  const theirEye = ctx.entity.position.offset(0, EYE, 0)
  const theirR = turn.theirR = reachFrom(theirEye, bot.entity)
  const hp = turn.hp = bot.health ?? 20
  const medical = turn.medical = findPotion(bot, 'splash_potion', 'heal') || findPotion(bot, 'potion', 'heal') ||
    findPotion(bot, 'potion', 'regen') || findItem(bot, i => /golden_apple$/.test(i.name))
  const safety = turn.safety = opts.safety.check({ target: ctx.entity, entities: tt.threats(),
    minHealth: Math.max(8, retreatAtHealth), instantHeal: !!medical, repelLava: opts.repelLava })
  turn.safeMedical = medical && !safety.hazard && hp > safety.hit + 2 &&
    (medical.name === 'splash_potion' || tt.safe(tempo.consumeMs(medical.name), { fortSealed: fortSealed() }).ok)
  turn.arenaStay = !!AR && ctx.prof.player && safety.action !== 'dead'
  turn.flightRecovery = ctx.prof.player && bot.entity.elytraFlying && hp > 6 && hp <= healAt && medical &&
    countOf(bot, 'firework_rocket') >= 2 && theirR > 8 && !safety.hazard && !maceNow()
}

// Что у него в руках: щит, еда, лук; его хп — оценкой.
export function foeReadTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, foeHpDecide } = ctx
  const their = turn.their = usingItem(bot, ctx.entity)
  turn.blocking = their === 'shield'
  turn.theyEat = their && EDIBLE.test(their)
  // Натянутый трезубец — тот же стрелок (бросок через ≥ 10 тиков натяжения): щит, рывок на занятого (S7d, пункт I).
  turn.theyBow = their === 'bow' || their === 'crossbow' || their === 'trident'
  turn.theirHp = foeHpDecide(ctx.entity)
}

// Вижу ли тело; где видел последний раз.
export function noteSightTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, vision } = ctx
  const { eye } = turn
  const seesBody = turn.seesBody = (!ctx.prof.player || vision.visible(ctx.entity)) && raySees(bot, eye, ctx.entity.position.offset(0, (ctx.entity.height || 1.8) * 0.55, 0))
  // Player entity is the observer's last-seen view, including sightings made
  // while awaiting a skill. A fresh chest ray must not discard that receipt.
  if (ctx.prof.player || seesBody) ctx.foeSeenPos = ctx.entity.position.clone()
}

// Честный прицел, скрыт ли он, выше ли, нажим, вне поля ли.
export function postureTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { AR, bot, foeGrounded, fortSealed, healItem, hm, onField, pathTo, routeInputs, st, used } = ctx
  const { d, dy, hp, me, meInWeb, now, r, seesBody, theyEat } = turn
  // Честный прицел (pick.js, 2026-09-26: «боты через один блок пробивают»).
  const sight = turn.sight = r <= HIT_REACH + 0.3 ? pick.aim(bot, ctx.entity, { eye: pick.eyeOf(bot), range: HIT_REACH }) : null
  const inSight = turn.inSight = !!(sight && sight.point)
  ctx.sightOff = inSight ? sight.off : null
  // в руке, но под прицел не взять — тоже: стенка его коробки вплотную).
  const hidden = turn.hidden = ctx.prof.player && (!seesBody || (r <= HIT_REACH && !inSight)) && d <= FAR + 2 && !(hm && hm.hiding())
  const theyUp = turn.theyUp = dy > 2.5 && r > HIT_REACH && foeGrounded()
  if (ctx.counterRoute && (!theyUp || ctx.fort || ctx.perch || meInWeb || edges.fillerCount(bot) < Math.floor(dy) - 1)) {
    ctx.counterRoute = null; pathTo(false); ctx.pathing = false
  }
  if (ctx.flankRoute && (!hidden || ctx.fort || ctx.perch || r <= HIT_REACH)) {
    ctx.flankRoute = null; pathTo(false); ctx.pathing = false
  }
  turn.busyFoe = ctx.prof.player && (theyEat || hidden || theyUp)
  if (ctx.rushActive && (r <= HIT_REACH || !seesBody || theyUp || meInWeb || ctx.fort || ctx.perch || !stepSafe(bot, keyDir(bot, 'forward')))) ctx.rushActive = false
  const pressing = turn.pressing = FIX && ctx.prof.player && !fortSealed() && !ctx.perch && !(hp <= 8 && !!healItem()) &&
    (st.swings > ctx.exchangeStart.swings && st.landed === ctx.exchangeStart.landed && now >= ctx.nextReady && r > HIT_REACH ||
      ctx.failedReposition?.inputs === routeInputs() || ctx.failedFlank?.inputs === routeInputs() || !!ctx.exhaustedPunch)
  if (pressing && !st.pressOn) { st.pressOn = true; st.pressure = (st.pressure || 0) + 1; used('нажим: долго без размена — иду бить') } else if (!pressing) st.pressOn = false
  const meBelow = turn.meBelow = !!AR && me.y < AR.y - 1.5
  turn.meOut = !!AR && (meBelow || !onField(me))
  turn.heOut = !!AR && ctx.prof.player && !onField(ctx.entity.position) && ctx.entity.position.y < AR.y - 2.5
}
