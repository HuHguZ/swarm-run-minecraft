import { goals } from 'mineflayer-pathfinder'
import * as gameClock from '../game-clock'
import * as hazards from '../hazards'
import { blockName, keyDir, wantsJump } from '../moves'
import * as read from '../read'
import * as tools from '../tools'
import * as totemMod from '../totem'
import { hasEffect, onFire, stepSafe } from './body'
import { findItem } from './potions'
import { HIT_REACH, TICK_MS, cooldownMs } from './rules'
import { escapeBurn, lavaExit } from './lava-exit'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Ямы и опасности рядом, паутина на нём, перезарядка, успокоился ли он.
export function terrainTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, calmAfterMs, finish, mf } = ctx
  const { d, dy, me, now } = turn
  if (now >= ctx.terrainAt) {
    ctx.terrainAt = now + 250
    ctx.myPit = hazards.pitTrap(bot, me)
    ctx.theirPit = dy < -1.5 ? hazards.pitTrap(bot, ctx.entity.position) : null
    ctx.nearFoe = hazards.hazardsNear(bot, ctx.entity.position, 3)
    // 3 бл.: серия ударов отбрасывает до 3 (лава вровень с полом — edgeTurn «не стою спиной к лаве»).
    ctx.nearMe = hazards.hazardsNear(bot, me, process.env.ND_LAVA_BEHIND !== '0' ? 3 : 2)
  }
  turn.inWeb = blockName(bot, ctx.entity.position.floored()) === 'cobweb' ||
    blockName(bot, ctx.entity.position.floored().offset(0, 1, 0)) === 'cobweb'

  turn.cooldownLeft = mf.clock.leftMs(1)

  if (calmAfterMs && now - ctx.lastHurtByTarget > calmAfterMs && d > 8) {
    return { end: finish({ calmed: true, why: `${ctx.label} не бьёт ${Math.round((now - ctx.lastHurtByTarget) / 1000)}с и отошёл` }) }
  }
}

// Вычерпать свою лаву и воду.
export async function scoopTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, holdWeapon, pendingLava, pendingWater, scoop } = ctx
  const { meInWeb } = turn
  for (let i = pendingLava.length - 1; i >= 0; i--) {
    if (!ctx.entity.position.floored().equals(pendingLava[i].cell) || (ctx.prof.player && read.effectsOf(bot, ctx.entity).has('fire_resistance'))) {
      const cell = pendingLava.splice(i, 1)[0].cell
      await scoop(cell)
      await holdWeapon()
    }
  }
  for (let i = pendingWater.length - 1; i >= 0; i--) {
    const pw = pendingWater[i]
    if (onFire(bot) || meInWeb) continue
    pendingWater.splice(i, 1)
    const wb = bot.blockAt(pw.cell)
    if (!wb || wb.name !== 'water' || wb.metadata !== 0) continue
    if (pw.cell.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)) > 4) continue
    await scoop(pw.cell)
    await holdWeapon()
  }
}

// Паутина на мне или между нами.
export async function webTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, digWatch, heldName, holdItem, holdWeapon, maceNow, mc, pendingWater, ready, rest, routeInputs, st, tt, used } = ctx
  const { cooldownLeft, hp, inSight, me, meInWeb, r, sight } = turn
  const webCells = meInWeb ? [me.floored(), me.floored().offset(0, 1, 0)].filter(c => blockName(bot, c) === 'cobweb') : []
  turn.webPlan = null
  if (webCells.length) {
    const f = me.floored()
    const headWeb = webCells.some(c => c.y === f.y + 1)
    const wCell = headWeb ? f.offset(0, 2, 0) : f.offset(0, 1, 0)
    const wItem = findItem(bot, i => i.name === 'water_bucket')
    const nether = /nether/.test(String((bot.game && bot.game.dimension) || ''))
    const opts = []
    if (wItem && !nether && /^(air|cave_air)$/.test(blockName(bot, wCell) || '')) {
      opts.push({ how: 'water', item: wItem, cell: wCell, busyMs: 150, freeMs: 150 + (headWeb ? 460 : 300) })
    }
    const cutOne = tools.bestFor(bot, bot.blockAt(webCells[0])).ms
    const cutAll = webCells.reduce((s, c) => s + tools.bestFor(bot, bot.blockAt(c)).ms, 0)
    if (cutOne <= 2500) opts.push({ how: 'cut', busyMs: cutOne, freeMs: cutAll })
    const inReach = r <= HIT_REACH + 0.5
    const score = o => o.freeMs + (inReach ? o.busyMs : 0)
    turn.webPlan = (onFire(bot) && opts.find(o => o.how === 'water')) || opts.sort((a, b) => score(a) - score(b) || (a.how === 'cut' ? -1 : 1))[0] || null
  }
  // Голова в паутине — прицел упирается в неё саму (VoxelShape.clip: глаза
  const webSafe = turn.webSafe = !!turn.webPlan && (r > HIT_REACH || !inSight || cooldownLeft >= turn.webPlan.busyMs ||
    hp > totemMod.burstOf(bot, ctx.entity) * (1 + Math.floor(Math.max(0, turn.webPlan.busyMs - tt.eta(ctx.entity)) / cooldownMs(ctx.entity.equipment?.[0]))))
  if (meInWeb && ready('webFight')) {
    if (!turn.webPlan) { rest('webFight', 3000); used('в паутине — снять нечем (ни меча, ни ножниц, ни воды)') } else if (!webSafe) { rest('webFight', 3000); used('в паутине — сперва удар, сниму в перезарядке') }
  }
  const cutWebInputs = turn.webPlan && [webCells.join('|'), turn.webPlan.how, turn.webPlan.cell, turn.webPlan.busyMs, !!webSafe, !!maceNow(), routeInputs()].join('|')
  if (turn.webPlan && webSafe && !(ctx.prof.player && mc.threat()) && (!ctx.failedCutWeb || ctx.failedCutWeb.inputs !== cutWebInputs)) {
    ctx.failedCutWeb = { inputs: cutWebInputs, why: 'web_action_unconfirmed' }
    if (turn.webPlan.how === 'water') {
      if (await holdItem(turn.webPlan.item)) {
        ctx.aim = 'point'
        ctx.aimPoint = { yaw: bot.entity.yaw, pitch: -Math.PI / 2 }
        await bot.look(bot.entity.yaw, -Math.PI / 2, true).catch(() => {})
        await ctx.sleep(TICK_MS)
        try { bot.activateItem() } catch {}
        await ctx.sleep(TICK_MS)
        ctx.aim = 'target'
        ctx.failedCutWeb = { inputs: cutWebInputs, why: 'water_or_web_receipt_pending' }
        pendingWater.push({ cell: turn.webPlan.cell, at: gameClock.now() })
        used(onFire(bot) ? 'вода на себя: потушился и смыл паутину' : `вода: смыл паутину (${webCells.length} кл.)`)
      }
      await holdWeapon()
      return NEXT
    }
    ctx.aim = 'free'
    const stop = await digWatch(bot.blockAt(webCells[0]), () => (ctx.prof.player && mc.threat()) ? 'булава летит' : null)
    ctx.aim = 'target'
    ctx.failedCutWeb = blockName(bot, webCells[0]) !== 'cobweb' ? null : { inputs: cutWebInputs, why: stop || 'web_not_removed' }
    if (stop) used(`бросил резать паутину: ${stop}`)
    else if (blockName(bot, webCells[0]) !== 'cobweb') { used(`разрезал паутину (${heldName()})`); st.cutFails = 0 } else if (++st.cutFails >= 2) {
      st.cutFails = 0
    }
    await holdWeapon()
    return NEXT
  }
  // Он в руке, но прицел упирается в паутину между нами или у его головы
  if (!meInWeb && r <= HIT_REACH && !inSight && sight && sight.blocked && sight.blocked.block &&
      sight.blocked.block.name === 'cobweb' && !(ctx.prof.player && mc.threat()) &&
      (!ctx.failedHisWeb || ctx.failedHisWeb.inputs !== routeInputs() + '|' + tools.bestFor(bot, sight.blocked.block).ms)) {
    const cut = tools.bestFor(bot, sight.blocked.block)
    if (cut.ms <= 1200) {
      ctx.aim = 'free'
      const stop = await digWatch(sight.blocked.block, () => (ctx.prof.player && mc.threat()) ? 'булава летит' : null)
      ctx.aim = 'target'
      ctx.failedHisWeb = blockName(bot, sight.blocked.pos) !== 'cobweb' ? null : { inputs: routeInputs() + '|' + cut.ms, why: stop || 'web_not_removed' }
      if (stop) used(`бросил резать его паутину: ${stop}`)
      else if (blockName(bot, sight.blocked.pos) !== 'cobweb') used('срезал паутину, что закрывала его')
      await holdWeapon()
      return NEXT
    }
  }
}

// Огонь и лава под ногами, бег к воде.
export async function fireTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, ctl, holdWeapon, pathTo, routeInputs, scoop, set, useOnGroundAt, used } = ctx
  const { me, meInWeb, webSafe, r } = turn
  const water = findItem(bot, i => i.name === 'water_bucket')
  // Вплотную (его меч в 4 бл.) — не выливать: горение снимает 1 в секунду, а вода, которую не успел забрать под его ударами,
  // держит в узкой комнате (игра пользователя 22.10: «вода мешает им убегать — забиваю»).
  if (water && onFire(bot) && !meInWeb && !bot.entity.isInWater && !(ctx.prof.player && r <= 4)) {
    const cell = me.floored()
    await useOnGroundAt(water, cell, 'вода: потушился')
    await ctx.sleep(250)
    await scoop(cell)
    await holdWeapon()
    return NEXT
  }
  const feetName = blockName(bot, me.floored())
  if (/^(lava|fire|soul_fire)$/.test(feetName) && (!ctx.failedOutOfFire || ctx.failedOutOfFire.inputs !== routeInputs())) {
    // Ближайшая клетка поля (на уровне ног или на блок выше — край ямы вровень с полом), до 3 бл.; не останавливаться на
    // кольце магмы (lava-exit: escapeBurn — пока под ногами горит).
    if (lavaExit(bot, me, ctx.entity.position)) {
      ctx.aim = 'free'
      clear()
      const r = await escapeBurn(bot, { limitMs: 1500, foe: ctx.entity.position, aborted: () => ctl.aborted, sleep: ms => ctx.sleep(ms), now: () => gameClock.now() })
      clear()
      ctx.aim = 'target'
      ctx.failedOutOfFire = r.ok ? null : { inputs: routeInputs(), why: 'hazard_not_left' }
      used(feetName === 'lava' ? `выпрыгнул из лавы (${r.ms} мс${r.ok ? '' : ', не вышел'})` : 'вышел из огня')
      return NEXT
    }
  }
  if (onFire(bot) && !bot.entity.isInWater && !hasEffect(bot, 'fire_resistance')) {
    const waterId = bot.registry.blocksByName.water && bot.registry.blocksByName.water.id
    const pools = waterId !== undefined ? bot.findBlocks({ matching: waterId, maxDistance: 10, count: 12 }) : []
    const here = bot.entity.position
    const pool = pools.map(v => bot.blockAt(v)).filter(b => b && Math.abs(b.position.y - here.y) <= 3)
      .sort((x, y) => x.position.distanceTo(here) - y.position.distanceTo(here))[0] || null
    const poolInputs = [pool?.position, pool?.stateId ?? pool?.name, routeInputs()].join('|')
    if (pool && (!ctx.failedToWater || ctx.failedToWater.inputs !== poolInputs)) {
      ctx.aim = 'free'
      const near = pool.position.offset(0.5, 0, 0.5).distanceTo(here) <= 4.5
      const t0 = gameClock.now()
      if (near) {
        await bot.lookAt(pool.position.offset(0.5, 0.5, 0.5), true).catch(() => {})
        set('forward', true); set('sprint', true); set('back', false); set('left', false); set('right', false)
        while (gameClock.now() - t0 < 1800 && !bot.entity.isInWater && !ctl.aborted) {
          set('jump', wantsJump(bot, keyDir(bot, 'forward')))
          await ctx.sleep(TICK_MS)
        }
        clear()
      } else {
        pathTo(true, new goals.GoalBlock(pool.position.x, pool.position.y, pool.position.z)); ctx.pathing = true
        while (gameClock.now() - t0 < 3500 && !bot.entity.isInWater && !ctl.aborted) await ctx.sleep(TICK_MS)
        pathTo(false); ctx.pathing = false
        clear()
      }
      ctx.aim = 'target'
      ctx.failedToWater = bot.entity.isInWater ? null : { inputs: [pool.position, pool.stateId ?? pool.name, routeInputs()].join('|'), why: 'pool_not_reached' }
      if (bot.entity.isInWater) used(near ? 'потушился в воде' : 'добежал до воды — потушился')
      return NEXT
    }
  }
  if (meInWeb && (!turn.webPlan || webSafe)) {
    clear()
    const out = ['back', 'left', 'right'].find(k => stepSafe(bot, keyDir(bot, k)))
    if (out) set(out, true)
  }
}

// Ямы: выбраться из своей, держать его в его.
export async function pitTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, climbOut, holdWeapon, lavaIntoPit, placeUnder, ready, rest, used } = ctx
  const { r } = turn
  if (ctx.myPit && !ctx.theirPit && r > HIT_REACH) {
    if (await climbOut(ctx.myPit)) return NEXT
  }
  if (ctx.theirPit && !ctx.myPit) {
    const lava = findItem(bot, i => i.name === 'lava_bucket')
    if (lava && ctx.prof.player) {
      if (await lavaIntoPit(lava)) return NEXT
    }
    const web = findItem(bot, i => i.name === 'cobweb')
    if (web && r < 5.3) {
      if (await placeUnder(web, 'паутина ему в яму')) { await holdWeapon(); return NEXT }
    }
    if (ready('pitNote')) { rest('pitNote', 5000); used('он в яме — не выпускаю') }
  }
}
