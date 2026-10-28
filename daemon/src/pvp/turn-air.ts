import { goals } from 'mineflayer-pathfinder'
import { shoot as bowShoot } from '../bow'
import * as gameClock from '../game-clock'
import { webCells } from '../hazards'
import { blockName, keyDir } from '../moves'
import * as pick from '../pick'
import * as ranged from '../ranged'
import * as spear from '../spear'
import * as tempo from '../tempo'
import { stepSafe } from './body'
import { findItem, findPotion } from './potions'
import { FIX, HIT_REACH, TICK_MS, cooldownMs } from './rules'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'
import { lanceWebRequest } from './turn-approach'

// Паутина на мне, его пике с элитр.
export function skySenseTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, sky, vision } = ctx
  const { me } = turn
  turn.meInWeb = webCells(bot).length > 0
  turn.skyThreat = ctx.prof.player && !bot.entity.elytraFlying && vision.visible(ctx.entity) ? sky.threat() : null
  // Таран другого летуна, пока бьюсь со своей целью (28.10: в бою встречное копьё было только против цели боя — 4 из 11 наземных
  // смертей от тарана пришлись на бой): защита, если свою цель сейчас не ударить раньше (не в досягаемости или удар не готов).
  if (!turn.skyThreat && !bot.entity.elytraFlying) {
    const g = (require('../threats') as typeof import('../threats')).incomingGliders(bot, { foes: ctx.session?._ndFoes ?? null })
      .find(o => o.id !== ctx.entity?.id && o.ticks <= 30)
    const mine = ctx.entity?.position && bot.entity.position.distanceTo(ctx.entity.position) <= HIT_REACH && gameClock.now() >= ctx.nextReady
    if (g && !mine) turn.skyThreat = { kind: g.kind, eta: g.ticks, at: new (require('vec3').Vec3)(g.at.x, g.at.y, g.at.z), other: g }
  }
}

// Копьё на изготовку отпускается, как только пике кончилось.
export function braceReleaseTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, heldName } = ctx
  const { meInWeb, skyThreat } = turn
  if (ctx.bracing && (!skyThreat || meInWeb || !spear.isSpear(heldName()))) { ctx.bracing = false; try { bot.deactivateItem() } catch {} }
}

// Копьё против тарана, щит или уклон от пике.
export async function skyDefenseTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, guard, pathTo, ready, rest, set, sky, st, used } = ctx
  const { me, meInWeb, now, r, skyThreat } = turn
  // Он летит на нас (пике/таран): копьё в руку, взгляд на него и «использовать» — задержка копья должна кончиться
  // до встречи. Урон разгона ему = 1 + floor(rel·mult), rel = −(наш взгляд · его скорость)·20 (KineticWeapon, javap):
  // на его 1.5 б/т — ~29 до брони. Наш щит/уклон — если копья нет или поздно.
  const braceWith = skyThreat && !ctx.bracing && !meInWeb ? spear.spearOf(bot) : null
  if (braceWith && skyThreat.eta >= Math.round(braceWith.spec.delay * 20) + 1 && skyThreat.eta <= 30) {
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
    for (const x of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(x, false)
    try {
      if (bot.heldItem?.name !== braceWith.item.name) await bot.equip(braceWith.item, 'hand')
      const q = skyThreat.at || ctx.entity.position
      const ey = pick.eyeOf(bot)
      await bot.look(Math.atan2(-(q.x - ey.x), -(q.z - ey.z)), Math.atan2(q.y + 0.3 - ey.y, Math.hypot(q.x - ey.x, q.z - ey.z)), true)
      if (bot.heldItem?.name === braceWith.item.name) { bot.activateItem(); ctx.bracing = true; used('копьё на изготовку против тарана') }
    } catch {}
    await ctx.sleep(TICK_MS)
    return NEXT
  }
  if (ctx.bracing && skyThreat) {
    // Держим и ведём взгляд за ним (луч копья 2.0–4.5 по взгляду).
    const o = skyThreat.other
    const q = o ? new (require('vec3').Vec3)(o.from.x + o.vel.x * 2, o.from.y + o.vel.y * 2, o.from.z + o.vel.z * 2) : sky.fl.at(2) || ctx.entity.position
    const ey = pick.eyeOf(bot)
    bot.look(Math.atan2(-(q.x - ey.x), -(q.z - ey.z)), Math.atan2(q.y + 0.3 - ey.y, Math.hypot(q.x - ey.x, q.z - ey.z)), true).catch(() => {})
    await ctx.sleep(TICK_MS)
    return NEXT
  }
  if (skyThreat) {
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
    ctx.aim = 'target'
    let how = null
    if (guard && guard.stats && guard.stats.worn && (skyThreat.eta >= 6 || skyThreat.shielded)) {
      guard.raise(true)
      if (!skyThreat.shielded) { skyThreat.shielded = true; sky.fl.st.shieldUps++ }
      for (const x of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) set(x, false)
      how = 'щит к пике с элитр'
    } else {
      const hv = skyThreat.other?.vel || sky.fl.vel()
      const hn = Math.hypot(hv.x, hv.z) || 1
      let best = null
      for (const k of ['left', 'right', 'back', 'forward']) {
        const dir = keyDir(bot, k)
        if (!stepSafe(bot, dir)) continue
        const across = Math.abs((dir.x * hv.z - dir.z * hv.x) / hn)
        const q = me.offset(dir.x * 2, 0, dir.z * 2)
        const away = Math.hypot(q.x - skyThreat.at.x, q.z - skyThreat.at.z)
        const sc = across * 2 + away
        if (!best || sc > best.sc) best = { k, sc }
      }
      if (best) {
        for (const x of ['forward', 'back', 'left', 'right']) set(x, x === best.k)
        set('sprint', best.k === 'forward' && (bot.food ?? 20) > 6); set('jump', false)
        if (!skyThreat.dodged) { skyThreat.dodged = true; sky.fl.st.dodges++ }
        how = 'ушёл поперёк его пике'
      }
    }
    if (how && ready('skyDef:' + how)) { rest('skyDef:' + how, 2500); used(how) }
    if (how !== 'щит к пике с элитр' && now >= ctx.nextReady && r <= HIT_REACH && pick.canHit(bot, ctx.entity, { range: HIT_REACH })) {
      try { bot.attack(ctx.entity) } catch {}
      st.swings++
      sky.fl.st.counterHits++
      ctx.lastSwing = gameClock.now()
      ctx.nextReady = ctx.lastSwing + cooldownMs(bot.heldItem)
      used('ударил летуна в пролёте')
    }
    await ctx.sleep(TICK_MS)
    return NEXT
  }
}

// Ответ на его жемчуг.
export async function pearlResponseTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, ctl, guard, holdWeapon, itemInputs, maceNow, pathTo, pearlResponse, routeInputs, session, st, used } = ctx
  const { hp, meInWeb } = turn
  if (ctx.prof.player && !meInWeb && !ctx.fort && !ctx.perch) {
    const plan = pearlResponse.decide({ hp, interrupted: maceNow() || ctl.aborted || (session.tactics?.snapshot().threatLevel ?? 0) >= 3 })
    const pearlResponseInputs = [routeInputs(), plan?.kind, plan?.id, itemInputs(/ender_pearl|cobweb|spear$|mace/)].join('|')
    if (plan && (!ctx.failedPearlResponse || ctx.failedPearlResponse.inputs !== pearlResponseInputs)) {
      pathTo(false); ctx.pathing = false; clear()
      if (guard) await guard.raise(false)
      ctx.aim = 'free'
      let result = null
      try { result = await pearlResponse.run(ctl, plan) } catch (error) { result = { note: error.message } }
      ctx.aim = 'target'; clear()
      if (result?.note) used(result.note)
      if (result?.hit) { st.swings++; st.landed++; ctx.lastSwing = gameClock.now() }
      ctx.failedPearlResponse = result?.ok ? null : { inputs: pearlResponseInputs, why: result?.why || result?.note || 'response_not_confirmed' }
      ctx.nextReady = Math.max(ctx.nextReady, gameClock.now() + cooldownMs(bot.heldItem))
      await holdWeapon()
      if (guard) await guard.wear()
      return NEXT
    }
  }
}

// Свой полёт: таран, пике, уход, лечение в воздухе.
export async function flightTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, ctl, fg, foe, foeGrounded, gate, guard, healAt, holdWeapon, maceNow, pathTo, sky, st, tt, used, windInputs } = ctx
  const { d, dy, hp, meInWeb, theirR } = turn
  if (ctx.prof.player && !meInWeb && !ctx.perch && !ctx.fort && (bot.entity.elytraFlying || !maceNow())) {
    const airHeal = () => findItem(bot, i => i.name === 'enchanted_golden_apple') || findItem(bot, i => i.name === 'golden_apple') ||
      findPotion(bot, 'potion', 'heal') || findPotion(bot, 'potion', 'regen')
    const eatSafe = tempo.ON ? tt.safe(tempo.consumeMs('golden_apple')).ok : theirR > 6
    const eqS = ctx.entity.equipment || []
    const hisShield = (!!(eqS[1] && eqS[1].name === 'shield') || !!(eqS[0] && eqS[0].name === 'shield')) && !(foe.shieldOff(ctx.entity) > 1500)
    const sp0 = sky.decide({ hp, healAt, heal: !!airHeal(), eatSafe, safety: turn.safety, safeMedical: !!turn.safeMedical, d, dy, foeGrounded: foeGrounded(), hisShield, prefer: ctx.gp?.pick })
    // Взлёт ради тарана/пике — только если граф боя не нашёл на земле приёма заметно лучше (в воздухе — не мешаем).
    const sp = sp0 && /^(lance|dive)$/.test(sp0.kind) && !bot.entity.elytraFlying && !gate(sp0.kind) ? null : sp0
    // Поддержка — после защит; уход лечиться сохраняет приоритет.
    if (sp && /^(lance|dive)$/.test(sp.kind) && lanceWebRequest(ctx, turn)) return
    if (sp) {
      const crash0 = (bot._ndElytra?.crashes || []).length
      pathTo(false); ctx.pathing = false
      clear()
      if (guard) await guard.raise(false)
      ctx.aim = 'free'
      let res = null
      try { res = await sky.run(ctl, sp, { heal: airHeal, enough: () => (bot.health ?? 0) >= 16, vel: () => ctx.track.vel(), chain: ctx.maceChain }) } catch (e) { res = { note: 'элитры: ' + e.message } }
      ctx.aim = 'target'
      clear()
      if (res && res.note) used(res.note)
      if (res && res.hit) { st.swings++; ctx.lastSwing = gameClock.now() }
      if (res && res.ate) for (const a of res.ate) st.healed.push(a + ' (в воздухе)')
      ctx.failedSky = res?.hit || res?.ate?.length || bot.entity.elytraFlying ? null : { inputs: windInputs(), kind: sp.kind, why: res?.note || 'flight_not_confirmed' }
      // Опыт длинного приёма — в цену графа (касание/удар, удар о стену за этот полёт).
      if (/^(lance|dive)$/.test(sp.kind)) fg.noteExperience(bot._ndFightXp || (bot._ndFightXp = {}), sp.kind, { hit: !!(res && res.hit), crash: (bot._ndElytra?.crashes || []).length > crash0 })
      ctx.nextReady = Math.max(ctx.nextReady, gameClock.now() + cooldownMs(bot.heldItem))
      await holdWeapon()
      if (guard) await guard.wear()
      return NEXT
    }
  }
}

// Он на элитрах: стрелять, бежать под него, если улетает, или ждать посадки, если кружит рядом.
export async function glideShotTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, ctl, guard, heldName, holdWeapon, maceNow, pathTo, rangedAllowed, ready, rest, set, shotInputs, sky, st, strafeStep, switched, used } = ctx
  const { me, meInWeb, r, seesBody } = turn
  if (ctx.prof.player && sky.gliding() && !meInWeb && r > HIT_REACH) {
    const halt = () => { if (ctx.pathing) { pathTo(false); ctx.pathing = false } }
    const chase = glideChaseGoal(me, ctx.entity.position, sky.fl.vel(), t => sky.fl.at(t), ctx.arena)
    if (!chase) halt()
    const bowA = findItem(bot, i => i.name === 'bow')
    const arrA = findItem(bot, i => /arrow$/.test(i.name))
    const d3 = me.distanceTo(ctx.entity.position)
    const airPoint = (t) => { const q = sky.fl.at(Math.max(0, t)); return q ? q.offset(0, .3, 0) : ctx.entity.position.offset(0, .3, 0) }
    const stopAirShot = () => ctl.aborted || !sky.gliding() || !!sky.threat() || (FIX && maceNow())
    const airCrossbow = ranged.crossbows(bot).find(x => x.info.loaded && x.info.ammo !== 'firework')
    if (rangedAllowed() && airCrossbow && d3 >= 4 && d3 < 48 && seesBody && !stopAirShot() &&
        (!ctx.failedAirXbow || ctx.failedAirXbow.inputs !== shotInputs())) {
      halt()
      if (guard) await guard.raise(false)
      ctx.aim = 'free'
      const airShot = await ranged.fire(bot, ctx.entity, airCrossbow.item, { point: airPoint, shouldStop: stopAirShot,
        onHit: () => { st.arrowHits = (st.arrowHits || 0) + 1; sky.fl.st.hits++ } })
      ctx.aim = 'target'
      ctx.failedAirXbow = airShot.fired ? null : { inputs: shotInputs(), why: airShot.why || 'air_bolt_unconfirmed' }
      if (airShot.fired) { used('арбалет по летуну на элитрах'); st.arrows = (st.arrows || 0) + 1; sky.fl.st.shots++; return NEXT }
    }
    if (rangedAllowed() && bowA && arrA && d3 >= 4 && d3 < 48 && seesBody && !stopAirShot() &&
        (!ctx.failedAirBow || ctx.failedAirBow.inputs !== shotInputs())) {
      halt()
      if (guard) await guard.raise(false)
      clear()
      ctx.aim = 'free'
      const beforeA = heldName()
      const shotA = await bowShoot(bot, ctx.entity, {
        point: airPoint,
        follow: false,
        onHit: () => { st.arrowHits = (st.arrowHits || 0) + 1; sky.fl.st.hits++ },
        shouldStop: stopAirShot,
        onDraw: () => {
          strafeStep()
          set('left', ctx.strafeKey === 'left' && stepSafe(bot, keyDir(bot, 'left')))
          set('right', ctx.strafeKey === 'right' && stepSafe(bot, keyDir(bot, 'right')))
        }
      })
      clear()
      ctx.aim = 'target'
      switched(beforeA)
      ctx.failedAirBow = shotA.shot ? null : { inputs: shotInputs(), why: shotA.why || 'air_arrow_unconfirmed' }
      if (shotA.shot) { used('стрела по летуну на элитрах'); st.arrows = (st.arrows || 0) + 1; sky.fl.st.shots++ }
      await holdWeapon()
      return NEXT
    }
    if (chase) {
      // Цель пути — заново, только если точка ушла дальше 3 бл. (иначе путь пересчитывался бы каждый тик).
      if (!ctx.pathing || !ctx.glideChase || Math.hypot(ctx.glideChase.x - chase.x, ctx.glideChase.z - chase.z) > 3) {
        ctx.glideChase = chase
        pathTo(true, new goals.GoalNearXZ(chase.x, chase.z, 2)); ctx.pathing = true
      }
      st.glideChase = (st.glideChase || 0) + 1
      if (ready('skyChaseNote')) { rest('skyChaseNote', 5000); used('он улетает на элитрах — бегу под него') }
      await ctx.sleep(TICK_MS)
      return NEXT
    }
    strafeStep()
    set('forward', false); set('back', false); set('jump', false); set('sprint', false)
    set('left', ctx.strafeKey === 'left' && stepSafe(bot, keyDir(bot, 'left')))
    set('right', ctx.strafeKey === 'right' && stepSafe(bot, keyDir(bot, 'right')))
    if (ready('skyWaitNote')) { rest('skyWaitNote', 5000); used('он кружит на элитрах рядом — жду посадки') }
    await ctx.sleep(TICK_MS)
    return NEXT
  }
}

// Куда бежать за летуном. Раньше бот стоял («не гонюсь, жду посадки»), пока человек улетал на элитрах. Пользователь
// 21.10: «преследования игроков, которые убегают элитрами». Улетает — значит, его ход от нас быстрее 0.2 б/т или он
// дальше 16 бл. по земле. Бежим к земле под точкой, где он будет через секунду (его же физика полёта, track.at) — так
// ближе к месту посадки. Цель держим внутри арены: путь за край не строится. Кружит рядом — null: пике на нас ловит
// skyDefenseTurn.
export function glideChaseGoal (me: { x: number; z: number }, his: { x: number; z: number }, vel: { x: number; z: number },
  at: (t: number) => { x: number; z: number } | null, arena?: { x: number; z: number; r: number } | null) {
  const rx = his.x - me.x, rz = his.z - me.z
  const flat = Math.hypot(rx, rz) || 1
  if ((vel.x * rx + vel.z * rz) / flat <= 0.2 && flat <= 16) return null
  const p = at(20) || his
  if (!arena) return { x: p.x, z: p.z }
  const k = Math.min(1, (arena.r - 2) / Math.max(Math.abs(p.x - arena.x), Math.abs(p.z - arena.z), 1e-6))
  return { x: arena.x + (p.x - arena.x) * k, z: arena.z + (p.z - arena.z) * k }
}
