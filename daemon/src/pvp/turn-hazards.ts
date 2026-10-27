import { goals } from 'mineflayer-pathfinder'
import * as gameClock from '../game-clock'
import * as hazards from '../hazards'
import { blockName, keyDir, wantsJump } from '../moves'
import * as read from '../read'
import * as tools from '../tools'
import * as totemMod from '../totem'
import * as pick from '../pick'
import { canSurvivePearl } from '../throw'
import { pearlDamage } from '../pearl-hop'
import { hasEffect, onFire, stepSafe } from './body'
import { findItem } from './potions'
import { HIT_REACH, TICK_MS, cooldownMs } from './rules'
import { escapeBurn, lavaExit } from './lava-exit'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'
import { webExitPlan } from '../navigation/web-exit'
import { executePlan } from '../navigation/parkour/execute'
import { settledLanding } from '../navigation/parkour/model'

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

// Паутина на мне: сначала защита, затем выход по цене времени и входящего урона.
export async function webTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, digWatch, escapePearl, guard, holdItem, holdWeapon, mc, pathTo, pendingWater, ready, rest, routeInputs, st, tt, used } = ctx
  const webCells = hazards.webCells(bot)
  turn.meInWeb = webCells.length > 0
  turn.webPlan = null
  turn.webSafe = true
  if (!webCells.length) { ctx.failedCutWeb = null; return }
  if (ctx.pathing) { pathTo(false); ctx.pathing = false }
  clear()
  const hp = bot.health ?? 20
  const foes = tt.threats()
  const eta = e => Math.max(tt.eta(e), tt.state(e).swung?.left || 0)
  const loss = ms => foes.reduce((n, e) => n + Math.ceil(Math.max(0, ms - eta(e)) / cooldownMs(e.equipment?.[0])) * totemMod.burstOf(bot, e), 0)
  const eye = pick.eyeOf(bot)
  const target = webCells.map(c => {
    const point = c.offset(.5, .5, .5), ray = point.minus(eye), length = ray.norm()
    const aim = length < 1e-6 || pick.blockOnRay(bot, eye, ray.scaled(1 / length), length + .01)?.pos.equals(c) ? point : pick.blockAim(bot, c, { range: 4.5, seeThrough: null })
    return aim ? { cell: c, aim } : null
  }).find(Boolean)
  const cut = target ? tools.bestFor(bot, bot.blockAt(target.cell)) : { ms: Infinity, item: null }
  const opts = []
  if (Number.isFinite(cut.ms)) opts.push({ how: 'cut', busyMs: cut.ms, freeMs: webCells.reduce((n, c) => n + tools.bestFor(bot, bot.blockAt(c)).ms, 0) })
  const water = findItem(bot, i => i.name === 'water_bucket')
  // Строго вниз: у первого контура верхняя грань, в том числе при глазах внутри паутины.
  const hit = water && !/nether/.test(String(bot.game?.dimension || '')) && pick.blockOnRay(bot, pick.eyeOf(bot), { x: 0, y: -1, z: 0 }, 4.5, /^(water|lava|bubble_column)$/)
  const cell = hit?.pos?.offset(0, 1, 0)
  if (cell && hit.block.name === 'cobweb' && cell.y > webCells[0].y && webCells.some(c => c.x === cell.x && c.z === cell.z) && /^(air|cave_air|void_air)$/.test(blockName(bot, cell) || '')) {
    // Вода течёт раз в 5 тиков; цена включает спуск от источника до нижней паутины.
    opts.push({ how: 'water', item: water, cell, busyMs: 2 * TICK_MS, freeMs: (2 + 5 * (cell.y - Math.min(...webCells.map(c => c.y)))) * TICK_MS })
  }
  const alternativeMs = Math.min(...opts.map(o => o.freeMs)), wasBlocking = guard?.blocking?.()
  let walkBusyMs = 0, walkAt = 0
  const walkCtl = { onAbort: ctx.ctl.onAbort, get aborted() {
    return ctx.ctl.aborted || (bot.health ?? hp) < hp || !!(ctx.prof.player && mc.threat()) ||
      !!(guard?.stats?.worn && walkBusyMs && loss(Math.max(0, walkBusyMs - (gameClock.now() - walkAt))) >= (bot.health ?? hp))
  } }
  const forecastWalk = async () => {
    const previousAim = ctx.aim
    ctx.aim = 'free'
    try { return await webExitPlan(bot, walkCtl, alternativeMs) } finally { ctx.aim = previousAim }
  }
  const walk = await forecastWalk()
  if (ctx.ctl.aborted || (bot.health ?? hp) < hp) return NEXT
  if (walk && !walkCtl.aborted) opts.push({ how: 'walk', walk, busyMs: walk.ticks * TICK_MS, freeMs: walk.ticks * TICK_MS })
  const inputs = [webCells.map(c => [c, bot.blockAt(c)?.stateId]), bot.entity.onGround, bot.entity.isInWater, routeInputs()].join('|')
  const available = opts.filter(o => !(ctx.failedCutWeb?.inputs === inputs && ctx.failedCutWeb.how === o.how && gameClock.now() - ctx.failedCutWeb.at < o.busyMs))
  const score = o => o.freeMs * (1 + loss(o.freeMs) / Math.max(1, hp))
  turn.webPlan = available.sort((a, b) => score(a) - score(b))[0] || null
  const plan = turn.webPlan
  // За ход режется одна клетка: окно на 0.4 с годится и при двух слоях паутины.
  turn.webSafe = !!plan && loss(plan.busyMs) < hp
  const urgent = foes.some(e => eta(e) <= (plan?.busyMs || 0) + 5 * TICK_MS) || !!(ctx.prof.player && mc.threat())
  // Щит прикрывает ожидание окна; при резке и броске его придётся опустить.
  if (urgent && guard?.stats?.worn) { ctx.aim = 'target'; await guard.raise(true) }
  const pearl = findItem(bot, i => i.name === 'ender_pearl')
  if (pearl && canSurvivePearl(bot) && (!plan || loss(plan.freeMs) > pearlDamage(bot))) {
    if (guard) await guard.raise(false)
    const out = await escapePearl({ jump: false })
    if (out?.thrown) { await holdWeapon(); return NEXT }
    if (urgent && guard?.stats?.worn) await guard.raise(true)
  }
  if (urgent && guard?.stats?.worn && guard.failure?.() !== 'shield_cooldown' && (!turn.webSafe || ctx.prof.player && mc.threat())) {
    await ctx.sleep(TICK_MS)
    return NEXT
  }
  if (!plan) { await ctx.sleep(TICK_MS); return NEXT }
  if (plan.how === 'walk') {
    const path = wasBlocking === guard?.blocking?.() ? plan.walk : await forecastWalk()
    if (!path || walkCtl.aborted) return NEXT
    walkBusyMs = path.ticks * TICK_MS; walkAt = gameClock.now()
    ctx.aim = 'free'
    try {
      const out = await executePlan(bot, walkCtl, { ...path, arena: ctx.arena }, state =>
        !hazards.webCells(bot).length && settledLanding(bot, state, path.target, .12))
      turn.meInWeb = hazards.webCells(bot).length > 0
      ctx.failedCutWeb = turn.meInWeb ? { inputs, how: 'walk', at: gameClock.now(), why: out.why || 'web_not_left' } : null
      if (out.ok && !turn.meInWeb) used('вышел из паутины шагом')
    } finally { ctx.aim = 'target'; await holdWeapon() }
    return NEXT
  }
  if (guard) await guard.raise(false)
  let why = null
  ctx.aim = 'free'
  try {
    if (plan.how === 'water') {
      if (await holdItem(plan.item)) {
        await bot.look(bot.entity.yaw, -Math.PI / 2, true)
        await ctx.sleep(TICK_MS)
        bot.activateItem()
        pendingWater.push({ cell: plan.cell, at: gameClock.now() })
        const until = gameClock.now() + plan.freeMs + 2 * TICK_MS
        while (!ctx.ctl.aborted && hazards.webCells(bot).length && gameClock.now() < until) {
          // Ведро уже вылито: пока течёт вода, снова прикрыться к противнику.
          ctx.aim = 'target'
          if (urgent && guard?.stats?.worn) guard.raise(true)
          await ctx.sleep(TICK_MS)
        }
      }
    } else {
      await bot.lookAt(target.aim, true)
      const started = gameClock.now()
      why = await digWatch(bot.blockAt(target.cell), () => ctx.ctl.aborted ? 'прервано' : ctx.prof.player && mc.threat() ? 'булава летит' :
        guard?.stats?.worn && loss(Math.max(0, cut.ms - (gameClock.now() - started))) >= (bot.health ?? hp) ? 'нужен щит' : null, false)
    }
  } catch (error) { why = error.message } finally { ctx.aim = 'target'; await holdWeapon() }
  const left = hazards.webCells(bot)
  const removed = webCells.filter(c => { const b = bot.blockAt(c); return b && b.name !== 'cobweb' })
  ctx.failedCutWeb = removed.length ? null : { inputs, how: plan.how, at: gameClock.now(), why: why || 'web_not_removed' }
  if (removed.length) {
    used(plan.how === 'water' ? removed.length === webCells.length && !left.length ? 'вода: смыл паутину' : `вода: снял ${removed.length} кл., осталось ${left.length}` : `разрезал паутину (${cut.item?.name || 'рука'})`)
    st.cutFails = 0
  }
  else if (ready('webFight')) { rest('webFight', 3000); used(`паутина осталась: ${why || 'жду подтверждения'}`) }
  turn.meInWeb = left.length > 0
  return NEXT
}

// Паутина между нами: эта работа не задерживает спасение собственного тела.
export async function webObstacleTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, digWatch, holdWeapon, mc, routeInputs, used } = ctx
  const { inSight, meInWeb, r, sight } = turn
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
  const { hp, r, safeMedical, safety } = turn
  // Проигрывая размен, выбираемся и из общей ямы, а не ждём, пока враг отпустит.
  if (ctx.myPit && ((!ctx.theirPit && r > HIT_REACH) || (hp <= safety?.threshold && !safeMedical))) {
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
