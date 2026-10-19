import { goals } from 'mineflayer-pathfinder'
import { pickFiller } from '../build'
import * as gameClock from '../game-clock'
import { keyDir } from '../moves'
import * as owShield from '../ow-shield'
import { thundering } from '../perception'
import * as read from '../read'
import * as threats from '../threats'
import { reachFrom, stepSafe } from './body'
import { FAR, HIT_REACH, TICK_MS } from './rules'
import { Vec3 } from './vec3'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Летящее в меня: пляска на столбе, фаербол, стенка от стрел.
export async function incomingTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, coverFrom, healAt, holdWeapon, ready, rest, set, strafeStep, swatted, used } = ctx
  const { eye, hp, me, theyBow } = turn
  const inc = turn.inc = threats.incoming(bot).filter(p => p.ticks <= 12)
  // Spawn receipts predict a fast bolt before its second visible position packet.
  for (const arrow of threats.dangers(bot).arrows) {
    const entry = [...(bot._ndThrown || [])].find(([, r]) => r.p === arrow.from)
    if (!entry || inc.some(p => p.entity.id === entry[0])) continue
    const [id, observed] = entry
    inc.push({ name: arrow.name, ticks: arrow.ticks, at: arrow.at, vel: observed.v,
      entity: { id, position: new Vec3(observed.p.x, observed.p.y, observed.p.z) } })
  }
  inc.sort((a, b) => a.ticks - b.ticks)
  if (ctx.perch && bot.entity.position.y >= ctx.perch.top - 1.2 && (theyBow || inc.some(x => /arrow|trident/.test(x.name)))) {
    strafeStep(0.3)
    set('sneak', true)
    set('left', ctx.strafeKey === 'left' && stepSafe(bot, keyDir(bot, 'left'))); set('right', ctx.strafeKey === 'right' && stepSafe(bot, keyDir(bot, 'right')))
    if (ready('perchDanceNote')) { rest('perchDanceNote', 4000); used('пританцовываю на столбе от стрел') }
  } else if (ctx.perch) set('sneak', false)

  const ball = inc.find(p => p.name === 'fireball' && reachFrom(eye, p.entity) <= 3.2) ||
    (() => {
      const f = (Object.values(bot.entities) as any[]).find((e : any) => e && e.name === 'fireball' && e.position && reachFrom(eye, e) <= 3.2)
      return f ? { entity: f, name: 'fireball' } : null
    })()
  if (ball && !swatted.has(ball.entity.id)) {
    const ghast = ctx.entity.name === 'ghast' ? ctx.entity
      : bot.nearestEntity(e => e && e.name === 'ghast' && e.position && e.position.distanceTo(me) < 64)
    ctx.aim = 'free'
    try {
      const aimAt = ghast
        ? ghast.position.offset(0, 2, 0).plus((ghast.velocity || new Vec3(0, 0, 0)).scaled(10))
        : ball.entity.position.plus(ball.entity.position.minus(eye))
      await bot.lookAt(aimAt, true)
      await ctx.sleep(60)
      if (ball.entity.isValid !== false) {
        swatted.set(ball.entity.id, { vel: ball.vel || { x: 0, z: 0 } })
        bot.attack(ball.entity)
        used('отбил фаербол')
      }
    } catch {}
    ctx.aim = 'target'
    await ctx.sleep(TICK_MS)
    return NEXT
  }

  const arrowIn = inc.find(p => /arrow|trident/.test(p.name) && p.ticks >= 4)
  if (arrowIn && hp <= healAt + 2 && pickFiller(bot)) {
    const from = me.minus(new Vec3(arrowIn.vel.x, 0, arrowIn.vel.z).normalize().scaled(4))
    if (await coverFrom(from, { wide: true, what: 'стенка от стрел' })) { await holdWeapon(); return NEXT }
  }
}

// Его выстрел и заряженный арбалет: щит или уход с линии.
export function dodgeTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, foe, guard, ready, rest, sawRelease, st, used } = ctx
  const { d, inc, me, r, seesBody } = turn
  const released = sawRelease()
  const aimedCb = turn.aimedCb = ctx.prof.player && seesBody ? foe.aimedAtMe(ctx.entity) : null
  const hisCb = turn.hisCb = ctx.prof.player ? (read.crossbowInfo(bot, ctx.entity.equipment && ctx.entity.equipment[0]) || read.crossbowInfo(bot, ctx.entity.equipment && ctx.entity.equipment[1])) : null
  const cbNow = !!(aimedCb && !aimedCb.piercing && guard && guard.stats && guard.stats.worn && r > HIT_REACH && d <= FAR)
  const bolt = turn.bolt = inc.find(p => /arrow|trident|firework/.test(p.name))
  const cbShield = turn.cbShield = cbNow || !!(bolt && !hisCb?.piercing && guard?.stats?.worn && r > HIT_REACH)
  const corridor = inc[0]
  if (corridor) {
    if (ctx.dodgeLine?.id !== corridor.entity.id) ctx.dodgeKey = null
    ctx.dodgeLine = { id: corridor.entity.id, from: corridor.entity.position.clone(), vel: corridor.vel }
  } else if (ctx.dodgeLine) {
    const dx = me.x - ctx.dodgeLine.from.x, dz = me.z - ctx.dodgeLine.from.z
    const n = Math.hypot(ctx.dodgeLine.vel.x, ctx.dodgeLine.vel.z) || 1
    const across = Math.abs(dx * ctx.dodgeLine.vel.z - dz * ctx.dodgeLine.vel.x) / n
    const passed = dx * ctx.dodgeLine.vel.x + dz * ctx.dodgeLine.vel.z < 0
    if (across > .9 || passed || ctx.dodgeLine.id != null && !bot.entities[ctx.dodgeLine.id]) { ctx.dodgeLine = null; ctx.dodgeKey = null }
  }
  if (!ctx.dodgeLine && (released || aimedCb && !cbShield)) {
    ctx.dodgeLine = { id: null, from: ctx.entity.position.clone(), vel: { x: -Math.sin(ctx.entity.yaw), z: -Math.cos(ctx.entity.yaw) } }
  }
  if (ctx.dodgeLine && (!ctx.dodgeKey || !stepSafe(bot, keyDir(bot, ctx.dodgeKey)))) {
    const key = threats.dodgeKey(bot, { vel: ctx.dodgeLine.vel }, k => stepSafe(bot, keyDir(bot, k)))
    if (key) {
      ctx.dodgeKey = key; ctx.strafeKey = key; st.dodges++
      if (released) used('ушёл с линии выстрела')
    } else { ctx.dodgeLine = null; ctx.dodgeKey = null }
    if (aimedCb && ready('cbAimNote')) { rest('cbAimNote', 3000); used(`его заряженный арбалет на мне (${aimedCb.ammo || '?'}${aimedCb.piercing ? ', «Пронзание»' : ''}) — схожу с линии`) }
  }
}

// Щит от лука и арбалета, укрытие от молнии.
export async function shieldsTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, ctl, guard, miningProgress, pathTo, ready, rest, routeInputs, set, shelterNear, skyOver, st, used } = ctx
  const { aimedCb, bolt, cbShield, d, hisCb, meInWeb, pressing, r, sees, seesBody, their, theyBow } = turn
  const bowShield = turn.bowShield = owShield.enabled(bot) && !ctx.prof.player && ctx.owShot !== undefined ? !!ctx.owShot : theyBow && !hisCb && (ctx.prof.player || ctx.prof.ranged) && guard?.stats?.worn && sees && r > HIT_REACH
  if (bowShield) {
    guard.raise(true)
    if (ready('bowShieldNote')) { rest('bowShieldNote', 4000); used(their === 'trident' ? 'щит от трезубца' : 'щит от стрелы') }
  }
  // Гроза и у него «Громовержец» (видно в руке): молния бьёт только под открытым небом (channeling.json can_see_sky) —
  // под навес, если он рядом (≤ 6 бл., крышу вижу), и держаться там, пока он мечет издали; сблизился — бой как всегда.
  // Цена: под навесом бросок даёт ему 8 вместо 8 + 5 + поджог; долго без размена — нажим (pressing) выводит в бой.
  if (ctx.prof.player && seesBody && d > 4.5 && !pressing && !meInWeb && !ctx.perch && !ctx.fort && thundering(bot)) {
    const hisTri = [ctx.entity.equipment && ctx.entity.equipment[0], ctx.entity.equipment && ctx.entity.equipment[1]].find(it => it && it.name === 'trident' && read.enchLevel(bot, it, 'channeling') > 0)
    if (hisTri) {
      st.storm = st.storm || { seen: 0, shelters: 0, under: 0, noShelter: 0 }
      if (!skyOver(bot.entity)) {
        if (ready('stormUnder')) { rest('stormUnder', 3000); st.storm.under++; used('гроза: под навесом — молния не достанет') }
        if (ctx.pathing) { pathTo(false); ctx.pathing = false }
        for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) set(k, false)
        if (bowShield) guard.raise(true)
        await ctx.sleep(TICK_MS)
        return NEXT
      }
      const shelter = shelterNear(6)
      const stormInputs = [shelter?.x, shelter?.y, shelter?.z, routeInputs()].join('|')
      if (!ctx.failedStormCover || ctx.failedStormCover.inputs !== stormInputs) {
        st.storm.seen++
        const c = shelter
        if (c) {
          st.storm.shelters++
          used('гроза: у него «Громовержец» — под навес')
          if (guard) await guard.raise(false)
          try { bot.pathfinder.setGoal(new goals.GoalBlock(c.x, c.y, c.z)) } catch {}
          let from = bot.entity.position.clone(), progressAt = gameClock.now(), noPath = false
          const onPath = result => { if (result?.status === 'noPath' && !miningProgress()) noPath = true }
          bot.on('path_update', onPath)
          try {
            while (!ctl.aborted && !ctx.selfDied && !noPath && skyOver(bot.entity) && ctx.entity.position.distanceTo(bot.entity.position) > 3.5) {
              if (miningProgress() || bot.entity.position.distanceTo(from) >= .5) { from = bot.entity.position.clone(); progressAt = gameClock.now() }
              if (gameClock.now() - progressAt > 3000) break
              await ctx.sleep(TICK_MS)
            }
          } finally { bot.removeListener('path_update', onPath); try { bot.pathfinder.setGoal(null) } catch {} }
          ctx.failedStormCover = skyOver(bot.entity) ? { inputs: [c.x, c.y, c.z, routeInputs()].join('|'), why: 'roof_not_reached' } : null
          return NEXT
        } else st.storm.noShelter++
      }
    }
  }
  if (cbShield) {
    guard.raise(true)
    if (ready('cbShieldNote')) { rest('cbShieldNote', 4000); used(`щит от заряженного арбалета (${aimedCb?.ammo || bolt?.name || '?'})`) }
  }
}
