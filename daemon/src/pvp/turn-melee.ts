import * as edges from '../edges'
import * as flee from '../flee'
import * as gameClock from '../game-clock'
import * as hazards from '../hazards'
import * as mace from '../mace'
import * as melee from '../melee'
import { blockName, keyDir, stepSafe as stepSafeRaw, wantsJump } from '../moves'
import * as owShield from '../ow-shield'
import * as read from '../read'
import * as tempo from '../tempo'
import * as totemMod from '../totem'
import { creeperSwelling, edgeBurns, noteWindThrowers, onFire, reachFrom, stepSafe } from './body'
import { findItem } from './potions'
import { CRIT_ANY_RISE, FIX, HIT_REACH, REACH_MARGIN, TICK_MS, cooldownMs, ticksToFall } from './rules'
import { Vec3 } from './vec3'
import { crowdSteer } from './turn-crowd'
import { strikeSlot, strikeWait } from './strike-order'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Моё место в очереди ударов по цели (раз в 250 мс): очередь — из fight RPC (strikeOrder: имена или { цель: имена };
// combat.fight пока не передаёт её в бой — беру из параметров текущего намерения), присутствующие — видимые игроки
// очереди в 6 бл. от цели.
function strikeSlotOf (ctx: DuelCtx, now: number) {
  if (now < (ctx.strikeSlotAt || 0)) return ctx.strikeSlot || 0
  ctx.strikeSlotAt = now + 250
  const order = ctx.opts.strikeOrder ?? ctx.session?.current?.params?.strikeOrder
  if (!order || !ctx.prof.player) return (ctx.strikeSlot = 0)
  const tp = ctx.entity.position
  const present = new Set<string>()
  for (const pl of Object.values(ctx.bot.players || {}) as any[]) {
    const e = pl && pl.entity
    if (e && e.position && e.username !== ctx.bot.username && e.position.distanceTo(tp) <= 6 && ctx.vision.visible(e)) present.add(e.username)
  }
  return (ctx.strikeSlot = strikeSlot(order, ctx.bot.username, ctx.entity.username || '', present, ctx.targetHurtBy))
}

// Топор по поднятому на меня щиту — сразу, без заряда меча и окна неуязвимости: любой удар топором выключает щит на 5 с
// (сила удара не важна), а пока жду заряд, удар булавы своего упрётся в щит (пользователь 22.10: «паутина под него, топор
// выбивает щит, сразу удар булавой с высоты»). Не в окне подъёма (первые 4 тика щит не держит — туда бьёт меч), не со спины
// (щит держит переднюю полусферу) и не по уже выбитому.
export function axeTapNow ({ axe, blocking, shieldFresh, facingMe, r, inSight, shieldOffMs = 0 }: { axe: unknown; blocking: boolean; shieldFresh: boolean; facingMe: boolean; r: number; inSight: boolean; shieldOffMs?: number }) {
  return !!axe && !!blocking && !shieldFresh && facingMe && r <= HIT_REACH && !!inSight && !(shieldOffMs > 300)
}

// Ближний бой: щит, удар готов ли, вперёд или назад.
export function meleeIntentTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { after, bot, foe, guard, mf, ready, rest, roll, strafeStep, style, tt, used } = ctx
  const { blocking, cooldownLeft, d, inSight, inWeb, me, now, r, seesBody, theirR, theyBow, theyEat, theyUp } = turn
  const axe = turn.axe = findItem(bot, i => /_axe$/.test(i.name))

  // Окно неуязвимости цели (10 тиков) и моё место в очереди ударов роя (strike-order: fight RPC strikeOrder).
  const iframes = turn.iframes = strikeWait(now, ctx.targetHurtAt, strikeSlotOf(ctx, now))
  if (blocking) ctx.shieldUpAt = now
  else if (ctx.shieldUpAt && !ctx.shieldDownAt) ctx.shieldDownAt = now
  if (blocking) ctx.shieldDownAt = 0
  // Щит закрывает то, куда он смотрит (взгляд — голова; тело отстаёт): BlocksAttacks по вектору взгляда.
  const fYaw = typeof ctx.entity.headYaw === 'number' ? ctx.entity.headYaw : (ctx.entity.yaw || 0)
  const fx = -Math.sin(fYaw); const fz = -Math.cos(fYaw)
  const tx = me.x - ctx.entity.position.x; const tz = me.z - ctx.entity.position.z
  const tn = Math.hypot(tx, tz) || 1
  const facingMe = (fx * tx + fz * tz) / tn > 0.2 // щит закрывает переднюю полусферу
  const tState = tt.state(ctx.entity)
  const shieldFresh = turn.shieldFresh = blocking && !!tState.since && now - tState.since < 4 * mf.clock.msPerTick - 30
  if (shieldFresh && ready('freshShieldNote')) { rest('freshShieldNote', 3000); used('бью в окно подъёма его щита') }
  const intoShield = turn.intoShield = blocking && !axe && facingMe && !shieldFresh
  const punish = turn.punish = !blocking && ctx.shieldDownAt && now - ctx.shieldDownAt < 600
  if (intoShield && ready('shieldNote')) { rest('shieldNote', 5000); used('не бью в щит — жду, когда опустит') }
  if (punish && ready('punishNote')) { rest('punishNote', 3000); used('опустил щит — бью первым') }
  const hisHand = turn.hisHand = ctx.entity.equipment && ctx.entity.equipment[0] ? ctx.entity.equipment[0].name : ''
  const fsH = tt.foes.get(ctx.entity.id)
  const hisReadyMs = turn.hisReadyMs = fsH && fsH.swungAt ? Math.max(0, fsH.swungAt + tempo.swingCooldownMs(hisHand) - now) : 0
  const race = turn.race = ctx.prof.player && theirR <= tempo.PLAYER_REACH && hisReadyMs <= TICK_MS
  const cdHit = turn.cdHit = race ? mf.clock.leftMs(0.91) : cooldownLeft
  const owMelee = turn.owMelee = guard?.stats?.worn && gameClock.now() >= (bot._ndShieldDisabledUntil || 0) ? owShield.meleeGuard(bot, ctx.entity, fsH?.swungAt || 0, guard.blocking?.() || false) : null
  const axeTap = turn.axeTap = axeTapNow({ axe, blocking, shieldFresh, facingMe, r, inSight, shieldOffMs: ctx.prof.player ? foe.shieldOff(ctx.entity) : 0 })
  turn.canHit = (cdHit === 0 && iframes === 0 || axeTap) && r <= HIT_REACH && !intoShield && inSight && owMelee !== true && !ctx.owShot
  turn.forward = false
  turn.back = false
  turn.strafe = null
  turn.sprint = false

  strafeStep()

  const shieldBroken = ctx.prof.player && foe.shieldOff(ctx.entity) > 300
  if (shieldBroken && ready('shieldOffNote')) { rest('shieldOffNote', 5000); used('его щит выбит — давлю') }
  const vulnerable = turn.vulnerable = inWeb || theyEat || theyBow || (blocking && axe) || turn.punRush || shieldBroken
  const rush = turn.rush = (after('rush', theyEat && seesBody && r > HIT_REACH - 0.3) && roll('rush', theyEat, style.aggression)) ||
    ((turn.punRush || ctx.rushActive) && r > HIT_REACH - 0.3)
  if (cooldownLeft <= 150) {
    if (r > HIT_REACH - 0.15) { turn.forward = true; turn.sprint = !ctx.jumpedForCrit }
  } else if (!vulnerable && !turn.punStep && theirR < ctx.prof.theirReach + (ctx.prof.player ? 0.2 : REACH_MARGIN) && cooldownLeft > 250) {
    turn.back = true
  } else if (vulnerable && r > HIT_REACH - 0.3) {
    turn.forward = true
  }
  if (rush) {
    turn.forward = true
    turn.sprint = true
    if (ready('rush')) { rest('rush', 2500); used(ctx.rushActive ? 'рывок со спринт-ударом' : turn.punRush ? 'рывок на занятого' : 'рывок, пока он ест') }
  }
  if (theyUp) {
    turn.forward = d > 3.2
    turn.back = d < 1.8
    if (ready('waitUp')) { rest('waitUp', 4000); used('он на столбе — жду внизу') }
  }
  turn.strafe = ctx.strafeKey
}

// Бегство от шипящего крипера.
export async function creeperFleeTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, guard, set, used } = ctx
  const { d, now } = turn
  if (ctx.prof.creeper && creeperSwelling(bot, ctx.entity) && d < 6.5) {
    if (!ctx.swellPlan || now >= ctx.swellPlanAt) {
      ctx.swellPlan = flee.pickDirection(bot, flee.hostilesAround(bot, 24), ctx.swellPlan ? ctx.swellPlan.yaw : null)
      ctx.swellPlanAt = now + 300
    }
    ctx.aim = 'free'
    if (ctx.swellPlan) await bot.look(ctx.swellPlan.yaw, 0, true).catch(() => {})
    if (guard) await guard.raise(false)
    const f = keyDir(bot, 'forward')
    set('back', false); set('left', false); set('right', false)
    set('forward', !!ctx.swellPlan && stepSafe(bot, f))
    set('sprint', (bot.food ?? 20) > 6)
    set('jump', wantsJump(bot, f))
    if (!ctx.fleeingSwell) { used('убегаю от шипящего крипера'); ctx.fleeingSwell = true }
    await ctx.sleep(TICK_MS)
    return NEXT
  }
}

// Обход щита, наказание, уклон, показ и двое на одного правят шаг.
export function steerTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { duo, hm } = ctx
  const { axe, blocking, cooldownLeft, d, hp, pressing, punish, r, rush, theirHp, theirR, theyUp, vulnerable } = turn
  ctx.fleeingSwell = false
  ctx.swellPlan = null
  if (ctx.aim === 'away' || ctx.aim === 'free') ctx.aim = 'target'
  if (blocking && !axe) {
    turn.forward = r > 3.4
    turn.back = r < 2.6
    if (!turn.strafe) turn.strafe = ctx.strafeKey || 'left'
  }
  if (punish && r > HIT_REACH - 0.3) { turn.forward = true; turn.back = false }
  if (ctx.dodgeKey && ctx.dodgeLine) { turn.strafe = ctx.dodgeKey; turn.back = false }
  if (hm && ctx.prof.player && !theyUp && !ctx.crowd?.on) {
    ({ forward: turn.forward, back: turn.back, strafe: turn.strafe, sprint: turn.sprint } = hm.steer({ forward: turn.forward, back: turn.back, strafe: turn.strafe, sprint: turn.sprint }, {
      r, theirR, d, hp, theirHp, cooldownLeft, blocking, vulnerable, rush,
      dodging: !!(ctx.dodgeKey && ctx.dodgeLine), flank: blocking && !axe, press: pressing
    }))
  }
  if (ctx.prof.player && !theyUp && ctx.crowd?.on) ({ forward: turn.forward, back: turn.back, strafe: turn.strafe, sprint: turn.sprint } = crowdSteer(ctx, { forward: turn.forward, back: turn.back, strafe: turn.strafe, sprint: turn.sprint }, { r, cooldownLeft }))
  else if (ctx.prof.player && !theyUp && duo.active()) ({ forward: turn.forward, back: turn.back, strafe: turn.strafe, sprint: turn.sprint } = duo.steer({ forward: turn.forward, back: turn.back, strafe: turn.strafe, sprint: turn.sprint }, { entity: ctx.entity, r, cooldownLeft }))
}

// Край и опасности: толкнуть его, не стоять спиной к яме или стене.
export function edgeTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, ready, rest, st, used } = ctx
  const { cooldownLeft, d, me, now, pressing, r, theirR } = turn
  turn.pushing = false
  turn.edgeHit = null
  if (!ctx.theirPit && !ctx.myPit && d < 6 && now >= ctx.pushAt) {
    ctx.pushAt = now + 250
    try { ctx.push = edges.pushPlan(bot, ctx.entity, { vel: ctx.track.vel() }) } catch { ctx.push = null }
  }
  if (ctx.push && d < 6 && !ctx.theirPit && !ctx.myPit) {
    if (ctx.push.now) {
      turn.pushing = true
      turn.edgeHit = ctx.push.now
      turn.back = false
      if (r > HIT_REACH - 0.15 || (ctx.push.now === 'sprint' && cooldownLeft <= 150)) turn.forward = true
      if (ctx.push.now === 'sprint' && cooldownLeft <= 150) turn.sprint = true
      if (ready('pushNote')) { rest('pushNote', 3000); used(ctx.push.now === 'hit' ? 'он у края — бью сразу' : 'толкаю его в яму спринт-ударом') }
    } else if (ctx.push.stand && (ctx.push.sure || !(FIX && pressing))) {
      // Обход «встать так, чтобы яма была за ним» — пока размены идут; долго без размена (нажим) — бить, а не кружить
      // (S7d, s7d-z-27 «булава против щита»: 4+ мин на 3.0 бл. — я «захожу, чтобы столкнуть», он «не стою спиной к
      // яме», ничья по пределу раунда).
      turn.pushing = true
      const px = ctx.push.stand.x - me.x
      const pz = ctx.push.stand.z - me.z
      const yaw = bot.entity.yaw
      const fwd = px * -Math.sin(yaw) + pz * -Math.cos(yaw)
      const right = px * Math.cos(yaw) + pz * -Math.sin(yaw)
      if (Math.abs(right) > 0.3) turn.strafe = right > 0 ? 'right' : 'left'
      if (fwd > 0.5 && cooldownLeft <= 150) turn.forward = true
      else if (fwd < -0.5) { turn.back = true; turn.forward = false }
      if (ready('pushNote')) { rest('pushNote', 3000); used('захожу, чтобы столкнуть') }
    }
  }
  const hz = !turn.pushing && !ctx.theirPit && !ctx.myPit ? hazards.nearest(ctx.nearFoe, ctx.entity.position) : null
  if (hz && hz.d >= 0.6 && hz.d <= 2.8 && !ctx.fleeingSwell) {
    const hx = hz.pos.x + 0.5 - ctx.entity.position.x
    const hzz = hz.pos.z + 0.5 - ctx.entity.position.z
    const hn = Math.hypot(hx, hzz) || 1
    const fx = ctx.entity.position.x - me.x
    const fz = ctx.entity.position.z - me.z
    const fn = Math.hypot(fx, fz) || 1
    const cos = (fx * hx + fz * hzz) / (fn * hn)
    if (cos > 0.8) {
      turn.pushing = true
      if (cooldownLeft <= 150) { turn.forward = true; turn.sprint = true; turn.back = false }
      if (ready('pushNote')) { rest('pushNote', 4000); used(`толкаю его в ${hz.kind === 'лава' ? 'лаву' : hz.kind === 'паутина' ? 'паутину' : 'яму'}`) }
    } else if (!(FIX && pressing)) {
      const px = ctx.entity.position.x - hx / hn * 2.4 - me.x
      const pz = ctx.entity.position.z - hzz / hn * 2.4 - me.z
      const yaw = bot.entity.yaw
      const fwd = px * -Math.sin(yaw) + pz * -Math.cos(yaw)
      const right = px * Math.cos(yaw) + pz * -Math.sin(yaw)
      if (Math.abs(right) > 0.4) turn.strafe = right > 0 ? 'right' : 'left'
      if (fwd > 0.6 && cooldownLeft <= 150) turn.forward = true
      if (ready('pushNote')) { rest('pushNote', 4000); used('захожу, чтобы столкнуть') }
    }
  }
  // Опасность за спиной по линии удара — от каждого, кто меня достаёт (цель и другие в 4.5 бл.), а не только от цели:
  // удар отбрасывает на ~1 бл., спринт-удар и серия — до 3 (стенд 15×15 a24 21.10: 3 из 6 первых смертей — «tried to swim
  // in lava» после серии ударов у ямы лавы вровень с полом Колизея). Лава — до 3 бл., яма и паутина — до 2.2. Лава за
  // спиной важнее, чем столкнуть его самому (turn.pushing): шаг в сторону от ямы, по своему ходу.
  // ND_LAVA_BEHIND=0 — как было (только цель, 2.2 бл., столкнуть важнее): замер «до».
  const LB = process.env.ND_LAVA_BEHIND !== '0'
  const hitters = [ctx.entity, ...(LB ? ctx.duo.foes().filter(e => e && e !== ctx.entity && e.position && reachFrom(e.position.offset(0, 1.62, 0), bot.entity) <= 4.5) : [])]
  let behind = null
  for (const h of ctx.nearMe) {
    const bx = h.pos.x + 0.5 - me.x
    const bz = h.pos.z + 0.5 - me.z
    const bd = Math.hypot(bx, bz)
    if (bd > (h.kind === 'лава' && LB ? 3.0 : 2.2)) continue
    const from = hitters.find(e => {
      const ax = me.x - e.position.x
      const az = me.z - e.position.z
      return (bx * ax + bz * az) / ((Math.hypot(ax, az) || 1) * (bd || 1)) > 0.5
    })
    if (from && (!behind || bd < behind.bd)) behind = { ...h, bd, from }
  }
  if (behind && (!turn.pushing || (LB && behind.kind === 'лава'))) {
    turn.pushing = false
    turn.back = false
    const hx = me.x - behind.pos.x - 0.5; const hz = me.z - behind.pos.z - 0.5; const hn = Math.hypot(hx, hz) || 1
    const away = k => { const v = keyDir(bot, k); return (v.x * hx + v.z * hz) / hn }
    const keys = ['left', 'right', 'forward'].filter(k => away(k) > 0.25 && stepSafe(bot, keyDir(bot, k))).sort((a, b) => away(b) - away(a))
    if (keys[0] === 'forward') { turn.forward = true; turn.strafe = null } else if (keys[0]) { turn.strafe = keys[0]; if (away('forward') < -0.2) turn.forward = false } else {
      const yaw = bot.entity.yaw
      const right = (behind.pos.x + 0.5 - me.x) * Math.cos(yaw) + (behind.pos.z + 0.5 - me.z) * -Math.sin(yaw)
      turn.strafe = right > 0 ? 'left' : 'right'
    }
    if (ready('backNote')) { rest('backNote', 4000); used(`не стою спиной к ${behind.kind === 'лава' ? 'лаве' : behind.kind === 'паутина' ? 'паутине' : 'яме'}${behind.from !== ctx.entity ? ' (бьёт ' + (behind.from.username || 'другой') + ')' : ''}`) }
  }
  // Обрыв за спиной по линии толчка — от каждого, кто толкнёт (пользователь 21.10: «рой скидывает нарочно, и каждый
  // знает, что скинут его»): удар — от всех в 5.5 бл. (edges.backToDrop: прогон физики отброса), заряд ветра в руке —
  // в 10 бл. (взрыв ветра бьёт мимо неуязвимости и щита: обрыв по линии от него на 5 бл., edges.dropAlong). Не только
  // цель боя: в толпе толкает тот, кто бьёт. Своя безопасность — раньше, чем «столкнуть его» (turn.pushing).
  // ND_EDGE_ALL=0 — как было (только цель, без зарядов ветра).
  const EDGE_ALL = process.env.ND_EDGE_ALL !== '0'
  if (now >= ctx.backAt && (EDGE_ALL || (!turn.pushing && theirR < 5.5))) {
    ctx.backAt = now + 200
    ctx.behindDrop = null
    const pushers = EDGE_ALL ? [ctx.entity, ...ctx.duo.foes().filter(e => e && e !== ctx.entity)] : [ctx.entity]
    // Кто бросает заряды ветра: в руке заряд держат миг броска (сцена edge: 30 взрывов ветра, «в руке» — ни разу), поэтому
    // помню бросок — видимый заряд ветра (сущность) в 2.5 бл. от него — на 10 с.
    if (EDGE_ALL) noteWindThrowers(bot, pushers, now)
    let n = 0
    for (const e of pushers) {
      if (!e.position) continue
      const dh = Math.hypot(e.position.x - me.x, e.position.z - me.z)
      const held = e.equipment && e.equipment[0] ? e.equipment[0].name : null
      const wind = EDGE_ALL && (held === 'wind_charge' || now - (bot._ndWindBy?.get(e.id) || -1e9) < 10000) && dh <= 10
      // Удочка в руке, видит меня, в 30 бл.: тянет к себе (edges.pullDrop) — яма между нами опасна спереди.
      const rod = EDGE_ALL && held === 'fishing_rod' && dh <= 30 && ctx.vision.visible(e)
      if (dh > 5.5 && !wind && !rod) continue
      let drop = null
      try {
        if (dh <= 5.5) drop = edges.backToDrop(bot, e.position, { kb: held ? read.enchLevel(bot, e.equipment[0], 'knockback') : 0 })
        if (!drop && wind && edges.dropAlong(bot, e.position, 5)) drop = { fall: true, wind: true }
        if (!drop && rod) { const p = edges.pullDrop(bot, e.position); if (p) drop = { ...p, rod: true } }
      } catch {}
      if (drop) { n++; if (!ctx.behindDrop) ctx.behindDrop = { ...drop, from: e } }
    }
    if (ctx.behindDrop) ctx.behindDrop.n = n
  } else if (!EDGE_ALL && (turn.pushing || theirR >= 5.5)) ctx.behindDrop = null
  if (ctx.behindDrop) {
    turn.back = false
    turn.pushing = false
    // Сойти с линии: туда, где до края дальше (вбок или вперёд — к нему), по безопасному шагу.
    // От удочки — не к рыболову (тянет к нему, яма впереди): ход с линии вбок или прочь.
    const toward = (k) => { const f = ctx.behindDrop.rod && ctx.behindDrop.from?.position; if (!f) return 0; const v = keyDir(bot, k); const fx = f.x - me.x; const fz = f.z - me.z; return (v.x * fx + v.z * fz) / (Math.hypot(fx, fz) || 1) }
    const keys = (EDGE_ALL ? (ctx.behindDrop.rod ? ['left', 'right', 'back'] : ['left', 'right', 'forward']) : ['left', 'right']).map(k => { const v = keyDir(bot, k); return { k, c: stepSafe(bot, v) && toward(k) < 0.3 ? edges.clearance(bot, me.offset(v.x * 1.2, 0, v.z * 1.2), 2.5) : -1 } })
      .sort((a, b) => b.c - a.c)
    if (keys[0].k === 'forward') { turn.forward = true; turn.strafe = null } else if (keys[0].k === 'back') { turn.back = keys[0].c >= 0; turn.forward = false; turn.strafe = null } else { turn.strafe = keys[0].k; const fw = keys.find(x => x.k === 'forward'); if (EDGE_ALL && (!fw || fw.c < 0.5)) turn.forward = false }
    const bd = ctx.behindDrop
    if (ready('backNote')) { rest('backNote', 4000); used(`${bd.rod ? 'не стою за ямой от удочки' : 'не стою спиной к яме'} (${bd.rod ? 'удочка у ' : bd.wind ? 'заряд ветра у ' : 'удар '}${bd.from && bd.from !== ctx.entity ? (bd.from.username || 'другого') : 'его'}${bd.n > 1 ? `, толкнут ${bd.n}` : ''} кинул бы)`) }
  }
  // Спиной к стене (пользователь 14.10: «у стен стоят, не убегают в сторону от меня, а вперёд ко мне идут — я мечом
  // забиваю их в прыжке»): отбросу некуда, и он бьёт крит за критом. Стена в шаге за спиной (по линии от него), он
  // в 4 бл. — вбок вдоль стены, где пробег длиннее (flee.runLength: стены и ширина тела); вперёд — только на свой удар.
  if (!turn.pushing && !behind && !ctx.behindDrop && ctx.prof.player && theirR < 4) {
    const ax = me.x - ctx.entity.position.x, az = me.z - ctx.entity.position.z, an = Math.hypot(ax, az) || 1
    const c = me.offset(ax / an * 0.8, 0, az / an * 0.8)
    if ([0, 1].some(dy => bot.blockAt(c.offset(0, dy, 0).floored())?.boundingBox === 'block')) {
      const side = ['left', 'right'].map(k => ({ k, len: require('../flee').runLength(bot, keyDir(bot, k), 3, 3).len }))
      const open = side[0].len >= side[1].len ? side[0] : side[1]
      if (open.len >= 1) {
        turn.back = false; turn.strafe = open.k
        if (cooldownLeft > 150) { turn.forward = false; turn.sprint = false }
        if (ready('wallNote')) { rest('wallNote', 4000); used('спиной к стене — ухожу вдоль неё') }
      }
    }
  }
  const intoHazard = turn.intoHazard = (k) => {
    const dir = keyDir(bot, k)
    const c = me.offset(dir.x * 0.9, -1, dir.z * 0.9).floored()
    return ctx.nearMe.some(h => h.pos.x === c.x && h.pos.z === c.z)
  }
  const wantFwd = turn.forward
  if (turn.forward && intoHazard('forward')) turn.forward = false
  if (turn.strafe && intoHazard(turn.strafe)) turn.strafe = null

  if (turn.forward && !stepSafe(bot, keyDir(bot, 'forward'))) turn.forward = false
  if (ctx.prof.player && wantFwd && !turn.forward && r > HIT_REACH + 0.3 && !ctx.perch && !ctx.fort) { if (!st.blockedSince) st.blockedSince = now } else if (turn.forward || !wantFwd) st.blockedSince = 0
}

// Путь к нему перекрыт: расчистить или обойти.
export async function unblockTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { itemInputs, miningProgress, ready, rest, routeInputs, st, unblockPath, used } = ctx
  const { me, now } = turn
  if (st.blockedSince && !miningProgress() && (!ctx.failedUnblock || ctx.failedUnblock.inputs !== routeInputs() + '|' + itemInputs(/bucket$|cobblestone|dirt/))) {
    if (await unblockPath()) { ctx.failedUnblock = null; st.unblocks = (st.unblocks || 0) + 1; return NEXT }
    ctx.failedUnblock = { inputs: routeInputs() + '|' + itemInputs(/bucket$|cobblestone|dirt/), why: 'obstacle_not_removed' }
    if (ready('detourNote')) { rest('detourNote', 4000); used('путь к нему перекрыт — обхожу') }
    if (!ctx.failedReposition || ctx.failedReposition.inputs !== routeInputs()) ctx.reposition = { from: me.clone(), at: now, target: ctx.entity.id }
  }
}

// Безопасные шаги, выход из радиуса взрыва.
export function exitTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { blastRetreat, bot } = ctx
  const { me } = turn
  if (turn.back && !stepSafe(bot, keyDir(bot, 'back'))) turn.back = false
  if (turn.strafe && !stepSafe(bot, keyDir(bot, turn.strafe))) {
    ctx.strafeKey = turn.strafe === 'left' ? 'right' : 'left'
    turn.strafe = stepSafe(bot, keyDir(bot, ctx.strafeKey)) ? ctx.strafeKey : null
  }

  const blast = blastRetreat()
  if (blast) {
    const gap = p => Math.hypot(p.x - blast.at.x, p.z - blast.at.z)
    const inside = Math.abs(me.y - blast.at.y) < 3 && gap(me) < blast.radius + .3
    if (inside) {
      const exits = ['back', 'left', 'right', 'forward'].filter(k => stepSafe(bot, keyDir(bot, k)))
        .map(k => ({ k, away: gap(me.plus(new Vec3(keyDir(bot, k).x, 0, keyDir(bot, k).z))) }))
        .filter(k => k.away > gap(me)).sort((a, b) => b.away - a.away)
      turn.forward = exits[0]?.k === 'forward'; turn.back = exits[0]?.k === 'back'
      turn.strafe = /^(left|right)$/.test(exits[0]?.k || '') ? exits[0].k : null
    }
  }
}

// Вид удара: крит, спринт, гонка; прыжок.
export function hitKindTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, mf, ready, rest, used } = ctx
  const { blocking, closing, cooldownLeft, d, hisReadyMs, hp, inWeb, intoHazard, meInWeb, now, r, theirHp, theirR, theyBow, theyEat } = turn
  const charging = closing > 0.2 && d > 4
  if ((!ctx.hitKind && cooldownLeft < 8 * mf.clock.msPerTick) || turn.edgeHit === 'sprint') {
    const myHp = hp + totemMod.absorption(bot)
    ctx.hitKind = turn.edgeHit === 'sprint' ? 'sprint' : mf.choose({
      meInWeb: meInWeb || !!bot.entity.isInWeb,
      creeper: ctx.prof.creeper,
      defenseless: inWeb || theyEat || theyBow,
      first: !ctx.firstHitDone,
      charging,
      hisReadyMs: ctx.prof.player ? hisReadyMs : null,
      myReadyMs: cooldownLeft,
      close: ctx.prof.player && r > 2.2 && theirR <= tempo.PLAYER_REACH + Math.max(0, closing) * 2,
      weaker: ctx.prof.player && theirHp != null && myHp + 4 < theirHp,
      comboOn: now - ctx.lastHurtByTarget > 1500 && now - ctx.lastSwing < 1500
    })
  }
  if (ctx.hitKind === 'crit' && bot.entity.onGround && ctx.prof.player && theirR <= tempo.PLAYER_REACH + 0.3 &&
      r > 2.2 && hisReadyMs <= cooldownLeft + 2 * mf.clock.msPerTick && !(inWeb || theyEat || theyBow)) {
    ctx.hitKind = (bot.food ?? 20) > 6 ? 'sprint' : 'plain'
    if (ready('raceNote')) { rest('raceNote', 4000); used('гонка — без прыжка за критом, спринт-удар') }
  }
  if (FIX && ctx.hitKind === 'crit' && bot.entity.onGround && ctx.prof.player && d < 6) {
    if (now >= ctx.jumpDropAt) { ctx.jumpDropAt = now + 200; try { ctx.jumpDrop = edges.dropAlong(bot, ctx.entity.position, 4.5) } catch { ctx.jumpDrop = false } }
    if (ctx.jumpDrop) {
      ctx.hitKind = (bot.food ?? 20) > 6 ? 'sprint' : 'plain'
      if (ready('dropCritNote')) { rest('dropCritNote', 4000); used('у ямы — без прыжка за критом') }
    }
  }
  const wantCrit = ctx.hitKind === 'crit' && !blocking && !meInWeb && !bot.entity.isInWeb
  const wantSprintHit = ctx.hitKind === 'sprint' && !meInWeb && (bot.food ?? 20) > 6
  if (bot.entity.onGround) ctx.jumpedForCrit = false
  turn.jump = false
  if (wantCrit && bot.entity.onGround && cooldownLeft < 320 && r < HIT_REACH + 0.9 && !meInWeb) {
    turn.jump = true
    ctx.jumpedForCrit = true
    turn.sprint = turn.sprint && !mf.clock.srvSprint
  }
  if (wantSprintHit && cooldownLeft <= 150 && !turn.back && r < HIT_REACH + 1.5 && !intoHazard('forward') && stepSafe(bot, keyDir(bot, 'forward'))) {
    turn.forward = true
    turn.sprint = true
    if (!mf.clock.srvSprint && bot.getControlState('sprint') && !mf.planning()) mf.rearm()
  }
  if (ctx.prof.player && read.spearIn(ctx.entity) && theirR < 5 && !turn.pushing) {
    turn.back = false
    if (r > 1.3 && !intoHazard('forward') && stepSafe(bot, keyDir(bot, 'forward'))) turn.forward = true
    if (ready('spearHugNote')) { rest('spearHugNote', 4000); used('у него копьё — прилипаю ближе 2 блоков') }
  }
  const moveDir = turn.forward ? 'forward' : turn.back ? 'back' : turn.strafe
  if (moveDir && wantsJump(bot, keyDir(bot, moveDir))) turn.jump = true
  if (turn.jump && moveDir && ctx.jumpedForCrit) {
    const far = turn.sprint ? 2.6 : 1.8
    if (!stepSafeRaw(bot, keyDir(bot, moveDir), { water: onFire(bot), reach: far }) ||
        !stepSafeRaw(bot, keyDir(bot, moveDir), { water: onFire(bot), reach: far / 2 + 0.45 })) {
      turn.forward = false; turn.back = false; turn.strafe = null; turn.sprint = false
    }
  }
}

// Под ногами ломают опору — сойти.
export function floorEscapeTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, safeNeighbor } = ctx
  const { me } = turn
  if (ctx.floorEscape) {
    const c = ctx.floorEscape.cell
    const margin = 0.5 + (bot.entity.width || 0.6) / 2
    if (me.y < c.y || Math.abs(me.x - c.x - 0.5) > margin || Math.abs(me.z - c.z - 0.5) > margin) ctx.floorEscape = null
    else if (!stepSafe(bot, ctx.floorEscape.dir)) {
      const dir = safeNeighbor(me.floored())
      ctx.floorEscape = dir ? { ...ctx.floorEscape, dir } : null
    }
  }
  if (ctx.floorEscape) {
    let best = null; let bd = -2
    for (const k of ['forward', 'back', 'left', 'right']) {
      const v = keyDir(bot, k); const dot = v.x * ctx.floorEscape.dir.x + v.z * ctx.floorEscape.dir.z
      if (dot > bd) { bd = dot; best = k }
    }
    turn.forward = best === 'forward'; turn.back = best === 'back'; turn.strafe = best === 'left' || best === 'right' ? best : null
    turn.sprint = turn.forward; turn.jump = false
  }
}

// Обход паутины, клавиши.
export function controlsTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, mf, ready, rest, set, used } = ctx
  const { me, meInWeb } = turn
  if (!meInWeb) {
    const webAhead = (key) => {
      const v = keyDir(bot, key)
      for (const k of [0.6, 1.1]) {
        const c = me.offset(v.x * k, 0, v.z * k).floored()
        if (blockName(bot, c) === 'cobweb' || blockName(bot, c.offset(0, 1, 0)) === 'cobweb') return true
      }
      return false
    }
    if (turn.forward && webAhead('forward')) {
      turn.forward = false; turn.sprint = false
      if (!turn.strafe) turn.strafe = webAhead('left') ? 'right' : 'left'
      if (ready('webAvoidNote')) { rest('webAvoidNote', 4000); used('обхожу свою паутину') }
    }
    if (turn.back && webAhead('back')) turn.back = false
    if (turn.strafe && webAhead(turn.strafe)) turn.strafe = null
  }
  if (ctx.hitKind === 'crit' && !bot.entity.onGround && !meInWeb) turn.sprint = turn.sprint && bot.getControlState('sprint') && !mf.clock.srvSprint
  const kk = mf.override({ forward: turn.forward, back: turn.back, left: turn.strafe === 'left', right: turn.strafe === 'right', sprint: turn.sprint && (bot.food ?? 20) > 6, jump: turn.jump })
  // Последнее слово — безопасность шага (DeepSeek t3 21.10: план удара mf.override ставит W/S-tap поверх отменённых
  // клавиш; вперёд+вбок — диагональ, которую по отдельности никто не проверял; прыжок несёт на 1.5–2.5 бл.).
  for (const k of ['forward', 'back', 'left', 'right']) if (kk[k] && !stepSafe(bot, keyDir(bot, k))) kk[k] = false
  if ((kk.forward || kk.back) && (kk.left || kk.right)) {
    const a = keyDir(bot, kk.forward ? 'forward' : 'back'); const b = keyDir(bot, kk.left ? 'left' : 'right')
    const n = Math.hypot(a.x + b.x, a.z + b.z) || 1
    if (!stepSafe(bot, new Vec3((a.x + b.x) / n, 0, (a.z + b.z) / n))) { kk.left = false; kk.right = false }
  }
  if (kk.jump && (kk.forward || kk.back || kk.left || kk.right)) {
    const k = kk.forward ? 'forward' : kk.back ? 'back' : kk.left ? 'left' : 'right'
    const far = kk.sprint ? 2.6 : 1.8
    // Ступенька прямо перед ногами (wantsJump) — прыжок на неё, не дальний: его не режу.
    if (!wantsJump(bot, keyDir(bot, k)) && (!stepSafeRaw(bot, keyDir(bot, k), { water: onFire(bot), reach: far }) || edgeBurns(bot, keyDir(bot, k), far))) kk.jump = false
  }
  kk.sprint = kk.sprint && kk.forward
  // В воде с ходом — «прыжок» держать: тело всплывает, у бортика вылезает на берег (как игрок).
  if (bot.entity.isInWater && (kk.forward || kk.back || kk.left || kk.right)) kk.jump = true
  set('forward', kk.forward)
  set('back', kk.back)
  set('left', kk.left)
  set('right', kk.right)
  set('sprint', kk.sprint)
  set('jump', kk.jump)
}

// Щит в левой руке, удар у края, хит-селект, удар.
export async function strikeTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { TRACE, bot, combo, guard, holdItem, holdWeapon, mf, ready, rest, st, trace, used } = ctx
  const { axe, blocking, bowShield, canHit, cbShield, cdHit, closing, cooldownLeft, hisHand, hisReadyMs, iframes, inSight, intoShield, meInWeb, now, owMelee, r, race, shieldFresh, theirR } = turn
  const theirHand = hisHand
  const offShield = bot.inventory.slots[45] && bot.inventory.slots[45].name === 'shield'
  if (guard && guard.stats && guard.stats.worn && offShield) {
    const adv = owMelee === null ? mf.shield({ theirR, closing, hisReadyMs, hisHand: theirHand, myLeftMs: cdHit, inMyReach: r <= HIT_REACH }) : owMelee ? 'raise' : 'lower'
    if (adv === 'raise') guard.raise(true)
    else if (adv === 'lower' && !cbShield && !(owShield.enabled(bot) && !ctx.prof.player && bowShield)) await guard.raise(false)
  }

  const edgeSpam = turn.edgeHit === 'hit' && iframes === 0 && r <= HIT_REACH && !intoShield && inSight && cooldownLeft > 0 && owMelee !== true && !ctx.owShot
  if (edgeSpam && ready('edgeSpamNote')) { rest('edgeSpamNote', 3000); used('бью у края, не дожидаясь заряда') }
  // Хит-селект = (1) ответный удар в тик его отброса (melee.counterFn: свой спринт-удар ×0.6 гасит часть его толчка —
  // Player.causeExtraKnockback) и (2) ожидание его удара до 3 тиков. ND_HS_WAIT=0 — без (2): по jar выигрыш даёт только
  // отброс (1), а ожидание отдаёт ему первый удар (A/B s7d-e-28-hsb: выключенный хит-селект 7 : 3).
  // В толпе не жду ничьего удара: пока жду одного, бьют остальные.
  const selectWait = ctx.prof.player && !ctx.crowd?.on && race && closing > 0.1 && !turn.pushing && theirR < 3.0 && mf.skill.counter > 0.7 && process.env.ND_HIT_SELECT !== '0' && process.env.ND_HS_WAIT !== '0'
  if (selectWait) { if (!ctx.selectSince) ctx.selectSince = now } else ctx.selectSince = 0
  const holdForSelect = selectWait && !turn.axeTap && now - ctx.selectSince < 3 * mf.clock.msPerTick
  if (holdForSelect && ready('selectNote')) { rest('selectNote', 4000); used('жду его удара, чтобы ответить (hit-select)') }
  if ((canHit && !holdForSelect) || edgeSpam) {
    const falling = mf.clock.critNow()
    const rising = !bot.entity.onGround && !falling
    const upTicks = rising ? ticksToFall(bot.entity.velocity.y) : 0
    const critWait = rising && !edgeSpam && !turn.axeTap && (ctx.jumpedForCrit || (ctx.hitKind === 'crit' && CRIT_ANY_RISE)) &&
      upTicks <= 7 && !(race && theirR <= 2.6 && upTicks > 2 && r > 2.2) && !bot.entity.isInWater && !meInWeb
    if (critWait && !ctx.jumpedForCrit && ready('pcritNote')) { rest('pcritNote', 4000); used('жду спуска для крита (подбросило)') }
    if (!critWait) {
      let swungWith = ctx.weapon
      let swapTo = -1
      if (blocking && !shieldFresh && axe && ctx.weapon && ctx.weapon.name !== axe.name) {
        if (melee.FAST_AXE) {
          swapTo = melee.axeSlot(bot)
          if (swapTo < 0 && (await mace.ensureHotbar(bot, [axe.name]))) swapTo = melee.axeSlot(bot)
        }
        if (swapTo < 0 && (await holdItem(axe))) swungWith = axe
      }
      if (guard) await guard.raise(false)
      const use = bot._ndUse
      if (!(use && (use.cur || gameClock.now() - (use.endedAt || 0) < mf.clock.msPerTick))) {
        const sprintHit = mf.clock.srvSprint && mf.clock.charge(0) > 0.9
        ctx.swingCrit = falling && !mf.clock.srvSprint
        const after = sprintHit ? (closing > 0.1 && theirR < 3.2 && !turn.pushing ? 'stap' : 'wtap') : null
        mf.hit(ctx.entity, { swapTo, after, kind: ctx.hitKind, diag: { jumped: ctx.jumpedForCrit, race: race && theirR <= 2.6 } })
        // Щит (пункт H): удар по поднятому щиту — топором (выключит) или сбоку/сзади вне его 90° (BlocksAttacks);
        // урон, прошедший при поднятом щите, считает onTickDmg (окно 600 мс). Звено комбо — вид удара.
        if (blocking) {
          const sh = st.shield || (st.shield = { hits: 0, axe: 0, outside: 0, through: 0 })
          sh.hits++
          const axeHit = swapTo >= 0 || (swungWith && /_axe$/.test(swungWith.name))
          if (axeHit) sh.axe++
          const ang = require('./damage-model').shieldAngle(typeof ctx.entity.headYaw === 'number' ? ctx.entity.headYaw : (ctx.entity.yaw || 0), ctx.entity.position, bot.entity.position)
          if (ang > 90) { sh.outside++; if (ready('flankNote')) { rest('flankNote', 3000); used('удар мимо щита: сбоку/сзади') } }
          ctx.shieldHitAt = gameClock.now()
          if (axeHit) used('топор по щиту')
        }
        combo.note(swapTo >= 0 ? 'топор' : ctx.hitKind === 'crit' ? 'крит' : ctx.hitKind === 'sprint' ? 'спринт-удар' : 'удар')
        if (TRACE) trace(`удар: ${swapTo >= 0 ? 'топором (свап)' : ctx.hitKind === 'crit' ? 'в прыжке за критом' : ctx.hitKind === 'sprint' ? 'спринт-удар' : 'обычный'}${after ? ' + ' + after : ''}${blocking ? ' — по щиту' : ''} (d=${r.toFixed(1)})`)
        st.swings++
        ctx.punches = 0
        ctx.rushActive = false
        ctx.firstHitDone = true
        ctx.hitKind = null
        ctx.lastSwing = gameClock.now()
        ctx.nextReady = ctx.lastSwing + cooldownMs(swungWith)
        if (sprintHit) st.sprintHits++
        if (blocking && !shieldFresh && (swapTo >= 0 || (swungWith && /_axe$/.test(swungWith.name)))) st.axeOnShield++
        if (swungWith !== ctx.weapon) await holdWeapon()
        if (ctx.prof.creeper) ctx.creeperBack = { id: ctx.entity.id }
      }
    }
  }
}
