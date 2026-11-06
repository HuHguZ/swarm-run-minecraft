import * as arrows from '../arrows'
import * as duoMod from '../duo'
import * as edges from '../edges'
import * as gameClock from '../game-clock'
import { solid } from '../moves'
import { raySees } from '../perception'
import * as pick from '../pick'
import * as read from '../read'
import * as tempo from '../tempo'
import * as threats from '../threats'
import * as utilityMod from '../utility'
import { healthOf, livingFlags, lookDead, reachFrom, stepSafe, usingItem, yawTo } from './body'
import { findItem, potionOf } from './potions'
import { ANGRY_IF_HIT, EYE, HOSTILE_MOB, TICK_MS, isPlayer } from './rules'
import { Vec3 } from './vec3'
import { type DuelCtx } from './turn'
import { isAlly } from '../combat/ally-safety'
import { smashShieldAim } from '../combat/shield'
import { shieldHold } from '../reflex-lock'

// Удары и смерти, другие нападающие, мобы, двое на одного, утилиты, фаерболы, его лук.
export function installEvents (ctx: DuelCtx) {
  const { attackers, bot, bowWatch, ctl, dead, mobHits, noteExchange, session, st, swatted, tt, used, vision } = ctx
  const onHurt = ctx.onHurt = (victim, source) => {
    if (isAlly(bot, victim)) return
    if (victim?.id === ctx.entity.id) { ctx.targetHurtAt = gameClock.now(); ctx.targetHurtBy = source ? (source.id === bot.entity?.id ? bot.username : source.username || null) : null; ctx.strikeSlotAt = 0 }
    if (isAlly(bot, source)) return
    if (source && bot.entity && ((victim?.id === ctx.entity.id && source.id === bot.entity.id) || (victim === bot.entity && source.id === ctx.entity.id))) noteExchange()
    if (victim?.id === ctx.entity.id && source === bot.entity) {
      st.landed++
      if (ctx.lastStand) session.bus?.emit('last_stand_hit', { target: ctx.entity.id, swings: st.swings, landed: st.landed,
        targetHealth: healthOf(bot, vision.source(ctx.entity)), health: bot.health })
      if (gameClock.now() - ctx.lastSwing < 400 && ctx.swingCrit) st.crits++
    }
    if (victim === bot.entity && source && source.id === ctx.entity.id) ctx.lastHurtByTarget = gameClock.now()
    if (victim === bot.entity && source && isPlayer(source) && source.id !== ctx.entity.id && source.id !== bot.entity.id && source.username !== bot.username) {
      const a = attackers.get(source.id) || { e: source, n: 0 }
      a.at = gameClock.now(); a.n++; a.e = source
      attackers.set(source.id, a)
    }
  }
  ctx.otherAttacker = () => {
    const now = gameClock.now()
    let best = null
    for (const [id, a] of attackers) {
      const e = vision.observe(a.e)
      if (now - a.at > 4000 || !e || !vision.visible(e) || e.isValid === false || dead.has(id) || isAlly(bot, e) || lookDead(bot, e) || e.id === ctx.entity.id) continue
      const dist = e.position.distanceTo(bot.entity.position)
      if (dist > 14) continue
      const score = (now - a.at) / 1000 + dist / 3 - a.n * 0.3
      if (!best || score < best.score) best = { e, dist, score }
    }
    return best
  }
  const onDead = ctx.onDead = (e) => {
    if (e) dead.add(e.id)
    if (e?.id === ctx.entity.id && !isAlly(bot, e)) {
      ctx.killed = true
      if (ctx.lastStand) session.bus?.emit('last_stand_kill', { target: ctx.entity.id, swings: st.swings, landed: st.landed, health: bot.health })
    }
  }
  const onSelfDeath = ctx.onSelfDeath = () => { ctx.selfDied = true }
  bot.on('death', onSelfDeath)
  const onMobHurt = ctx.onMobHurt = (victim, source) => {
    try {
      if (victim !== bot.entity || !source || isPlayer(source)) return
      const nm = source.name || ''
      if (HOSTILE_MOB.test(nm) || ANGRY_IF_HIT.test(nm)) mobHits.set(source.id, gameClock.now())
    } catch {}
  }
  bot.on('entityHurt', onMobHurt)
  const mobThreat = ctx.mobThreat = () => {
    if (!bot.entity) return null
    const me = bot.entity.position
    const eyeM = me.offset(0, EYE, 0)
    const now = gameClock.now()
    let best = null
    for (const e of ((Object.values(bot.entities) as any[]) as any)) {
      if (!e || e === bot.entity || !e.position || isPlayer(e)) continue
      const nm = e.name || ''
      const hitting = now - (mobHits.get(e.id) || 0) < 5000
      if (!HOSTILE_MOB.test(nm) && !(hitting && ANGRY_IF_HIT.test(nm))) continue
      if (dead.has(e.id) || lookDead(bot, e)) continue
      const dist = e.position.distanceTo(me)
      if (dist > (hitting ? 14 : 6)) continue
      const close = dist < (nm === 'creeper' ? 5 : 4)
      if (!hitting && !close) continue
      if (!hitting && !raySees(bot, eyeM, e.position.offset(0, (e.height || 1.8) * 0.6, 0))) continue
      const score = dist - (hitting ? 4 : 0) - (nm === 'creeper' ? 3 : 0)
      if (!best || score < best.score) best = { e, dist, hitting, score }
    }
    return best
  }
  ctx.mobCtl = { get aborted () { return ctl.aborted || !!mobThreat() }, onAbort: ctl.onAbort, abort: () => ctl.abort() }
  bot.on('entityHurt', onHurt)
  bot.on('entityDead', onDead)
  const duo = ctx.duo = duoMod.create(bot, { target: () => ctx.entity, attackers, dead, used, tt, observe: vision.observe, holdWeapon: () => ctx.holdWeapon(), setAim: (m) => { ctx.aim = m }, potionOf, roundScope: ctx.opts.roundScope })
  ctl.onAbort.push(() => duo.close())
  const util = ctx.util = utilityMod.create(bot, { used, tt })
  ctl.onAbort.push(() => util.close())
  const onTickSwat = ctx.onTickSwat = () => {
    try {
      if (!bot.entity) return
      const eyeNow = bot.entity.position.offset(0, EYE, 0)
      for (const fb of ((Object.values(bot.entities) as any[]) as any)) {
        if (!fb || fb.name !== 'fireball' || !fb.position) continue
        const rr = reachFrom(eyeNow, fb)
        if (rr > 3.0) continue
        if (!pick.canHit(bot, fb, { range: 3.0 })) continue
        const last = swatted.get(fb.id)
        const approach = threats.incoming(bot).find(p => p.entity.id === fb.id)
        if (last && (!approach || last.vel.x * approach.vel.x + last.vel.z * approach.vel.z >= 0)) continue
        swatted.set(fb.id, { vel: approach?.vel || { x: 0, z: 0 } })
        const g = bot.nearestEntity(e => e && e.name === 'ghast' && e.position && e.position.distanceTo(bot.entity.position) < 64)
        if (g) {
          const tgt = g.position.offset(0, 2, 0)
          const dx = tgt.x - eyeNow.x; const dy2 = tgt.y - eyeNow.y; const dz = tgt.z - eyeNow.z
          bot.look(Math.atan2(-dx, -dz), Math.atan2(dy2, Math.hypot(dx, dz)), true).catch(() => {})
        }
        bot.attack(fb)
        used('отбил фаербол')
      }
      if (swatted.size > 64) for (const id of swatted.keys()) if (!bot.entities[id]) swatted.delete(id)
    } catch {}
  }
  bot.on('physicsTick', onTickSwat)
  const arrowLog = arrows.track(bot)
  const onTickArcher = ctx.onTickArcher = () => {
    try {
      if (!ctx.entity.isValid || !ctx.prof.player || !vision.visible(ctx.entity)) return
      const now = gameClock.now()
      const sh = arrowLog.shots.get(ctx.entity.id)
      const n = sh ? sh.n : 0
      if (bowWatch.who !== ctx.entity.id) { bowWatch.who = ctx.entity.id; bowWatch.seen = n; bowWatch.drawAt = 0; bowWatch.loadedAt = 0 }
      if (n > bowWatch.seen) { bowWatch.shots += n - bowWatch.seen; bowWatch.seen = n; bowWatch.shotAt = sh.at; bowWatch.drawAt = 0; bowWatch.lastU = null }
      const f = livingFlags(bot, ctx.entity)
      const eq0 = ctx.entity.equipment && ctx.entity.equipment[0] ? ctx.entity.equipment[0].name : null
      const uNow = (f & 0x01) && !(f & 0x02) && (eq0 === 'bow' || (!eq0 && bowWatch.shots > 0)) ? 'bow' : usingItem(bot, ctx.entity)
      if (process.env.ND_DEBUG_TOWER && uNow !== bowWatch.lastU) { console.log('[bowWatch]', JSON.stringify({ u: uNow, flags: livingFlags(bot, ctx.entity), eq0: ctx.entity.equipment && ctx.entity.equipment[0] ? ctx.entity.equipment[0].name : null })); bowWatch.lastU = uNow }
      if (uNow === 'bow') { if (!bowWatch.drawAt && now - bowWatch.shotAt > 60) bowWatch.drawAt = now } else bowWatch.drawAt = 0
      const hand = ctx.entity.equipment && ctx.entity.equipment[0]
      const cb = hand && hand.name === 'crossbow' ? read.crossbowInfo(bot, hand) : null
      if (cb && cb.loaded) { if (!bowWatch.loadedAt) bowWatch.loadedAt = now } else if (bowWatch.loadedAt) {
        if (cb) bowWatch.xbowShotAt = now
        bowWatch.loadedAt = 0
      }
    } catch {}
  }
  bot.on('physicsTick', onTickArcher)
}

// Ломают пол подо мной — выход на соседнюю опору, пока ломающий не бросил.
export function installFloorWatch (ctx: DuelCtx) {
  const { bot, ready, rest, used } = ctx
  const safeNeighbor = ctx.safeNeighbor = (feet) => {
    const opts = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const c = feet.offset(dx, 0, dz)
      if (solid(bot, c.offset(0, -1, 0)) && !solid(bot, c) && !solid(bot, c.offset(0, 1, 0)) && stepSafe(bot, { x: dx, z: dz })) opts.push({ x: dx, z: dz })
    }
    return opts.length ? opts[Math.floor(Math.random() * opts.length)] : null
  }
  const onCrack = ctx.onCrack = (block, stage, breaker) => {
    try {
      if (!bot.entity || !block || !block.position) return
      if (breaker && breaker.id === bot.entity.id) return
      const feet = bot.entity.position.floored()
      const bp = block.position
      const under = bp.x === feet.x && bp.z === feet.z && bp.y < feet.y && bp.y >= feet.y - 3
      if (!under) return
      if (ctx.floorEscape?.cell.equals(bp)) ctx.floorEscape.breakers.add(breaker?.id ?? null)
      else {
        const dir = safeNeighbor(feet)
        if (dir) ctx.floorEscape = { dir, cell: bp.clone(), breakers: new Set([breaker?.id ?? null]) }
      }
      if (ready('floorNote')) { rest('floorNote', 3000); used('ломают пол подо мной — схожу') }
    } catch {}
  }
  bot.on('blockBreakProgressObserved', onCrack)
  const onCrackEnd = ctx.onCrackEnd = (block, breaker) => {
    if (!block?.position || !ctx.floorEscape?.cell.equals(block.position)) return
    ctx.floorEscape.breakers.delete(breaker?.id ?? null)
    if (!ctx.floorEscape.breakers.size) ctx.floorEscape = null
  }
  bot.on('blockBreakProgressEnd', onCrackEnd)
}

// Падение и MLG, прицел каждый тик.
export function installFallAndAim (ctx: DuelCtx) {
  const { bot, ovl, session, tt, used, vision } = ctx
  ctx.groundY = bot.entity ? bot.entity.position.y : 0
  const onTickFall = ctx.onTickFall = async () => {
    try {
      const e = bot.entity
      if (!e) return
      if (e.onGround || e.isInWater) { ctx.groundY = e.position.y; ctx.mlgArmed = false; return }
      if (e.velocity.y > -0.3 || ctx.groundY - e.position.y < 2) return
      let land = null
      for (let k = 1; k < 64; k++) {
        const c = e.position.offset(0, -k, 0).floored()
        if (solid(bot, c)) { land = c; break }
      }
      const fallTotal = land ? ctx.groundY - (land.y + 1) : 99
      if (fallTotal < 4) return
      const water = findItem(bot, i => i.name === 'water_bucket')
      if (!water) return
      if (!ctx.mlgArmed) { ctx.mlgArmed = true; await bot.equip(water, 'hand').catch(() => {}); used('падаю — ведро воды наготове') }
      if (land && e.position.y - (land.y + 1) < 3.2) {
        await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
        bot.activateItem()
        used('вода под себя (MLG)')
        ctx.groundY = e.position.y
        gameClock.setTimeout(() => { try { const b = findItem(bot, i => i.name === 'bucket'); const w = bot.findBlock({ matching: bb => bb && bb.name === 'water', maxDistance: 3 }); if (b && w) bot.equip(b, 'hand').then(() => bot.activateBlock(w)).catch(() => {}) } catch {} }, 900)
      }
    } catch {}
  }
  if (!bot._ndFallGuard) bot.on('physicsTick', onTickFall)
  const onMlg = ctx.onMlg = (e) => {
    if (e.what === 'fired') used('вода под себя (MLG)')
    else if (e.what === 'saved') used('MLG: приземлился в воду')
    else if (e.what === 'missed') used('MLG: промахнулся')
    else if (e.what === 'picked') used('MLG: воду обратно в ведро')
  }
  bot.on('nd_mlg', onMlg)
  ctx.aimTimer = gameClock.setInterval(() => {
    vision.observe(ctx.entity)
    if (!bot.entity || !ctx.entity.isValid) return
    try {
      const nowO = gameClock.now()
      const u = bot._ndUse && bot._ndUse.cur
      const k = u ? tempo.useKind(u.name) : null
      const both = ctx.prof.player && (session.eating || k === 'eat' || k === 'drink') && !!tt.state(ctx.entity).consuming
      if (both) {
        const dtO = Math.min(200, nowO - ovl.at)
        ovl.ms += dtO
        if (!ovl.was) ovl.n++
        if (ctx.entity.position.distanceTo(bot.entity.position) < 24 && raySees(bot, bot.entity.position.offset(0, EYE, 0), ctx.entity.position.offset(0, (ctx.entity.height || 1.8) * 0.55, 0))) ovl.openMs = (ovl.openMs || 0) + dtO
      }
      ovl.was = both
      ovl.at = nowO
    } catch {}
    try {
      if (bot.targetDigBlock && bot.targetDigBlock.position) {
        bot.lookAt(bot.targetDigBlock.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
        return
      }
      if (ctx.pathing || edges.falling(bot)) return
      if (ctx.owShot) { const p = ctx.owShot.point; bot.lookAt(new Vec3(p.x, p.y, p.z), true).catch(() => {}); return }
      if (ctx.aim === 'target') {
        // Прогноз следящего бывает с NaN по x/z (s7-arms11, [nan-guard] lookAt({x:null,y:106,z:null})) — тогда смотрю на тело.
        const p0 = ctx.track.at(2)
        const p = [p0.x, p0.y, p0.z].every(Number.isFinite) ? p0 : ctx.entity.position
        const lead = ctx.sightOff ? p.plus(ctx.sightOff) : p.offset(0, (ctx.entity.height || 1.8) * 0.75, 0)
        const defense = bot._ndMaceDefense
        const guardAim = defense?.ctl === ctx.ctl && defense.target === ctx.entity.username && shieldHold(session) && ctx.guard?.blocking?.()
          ? smashShieldAim(bot, ctx.entity, lead) : null
        bot.lookAt(guardAim ?? lead, true).catch(() => {})
      } else if (ctx.aim === 'away') {
        const me = bot.entity.position
        const yaw = yawTo(ctx.entity.position, me) // от него к нам — туда и бежим
        bot.look(yaw + (Math.random() - 0.5) * 0.6, 0, true).catch(() => {})
      } else if (ctx.aim === 'point' && ctx.aimPoint) {
        bot.look(ctx.aimPoint.yaw, ctx.aimPoint.pitch, true).catch(() => {})
      }
    } catch {}
  }, TICK_MS)
}
