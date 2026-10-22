import { goals } from 'mineflayer-pathfinder'
import * as bridge from '../bridge'
import { pickFiller, towerUp, withTimeout } from '../build'
import * as edges from '../edges'
import * as fortify from '../fortify'
import * as gameClock from '../game-clock'
import { keyDir } from '../moves'
import { raySees } from '../perception'
import * as pick from '../pick'
import * as tools from '../tools'
import { stepSafe } from './body'
import { findItem, potionOf } from './potions'
import { EYE, FIX, HIT_REACH, PILLAR_MS, THEIR_REACH, TICK_MS } from './rules'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Он выпал с поля — держу арену.
export function holdArenaTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { AR, guardSpot, pathTo, st, used } = ctx
  const { heOut, me, meOut, now } = turn
  if (heOut && !meOut) {
    if (!st.holdSince) { st.holdSince = now; st.holds = (st.holds || 0) + 1; used('он выпал с поля — держу арену') }
    if (now >= ctx.holdGoalAt) {
      ctx.holdGoalAt = now + 1500
      const spot = guardSpot(ctx.entity.position)
      ctx.holdGoal = spot ? new goals.GoalNear(spot.x, spot.y, spot.z, 1) : new goals.GoalNear(AR.x, AR.y, AR.z, 3)
      if (spot && spot.distanceTo(me) > 2.2 && !ctx.pathing) { pathTo(true); ctx.pathing = true }
    }
  } else if (ctx.holdGoal) {
    ctx.holdGoal = null
    st.holdSince = 0
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
  }
}

// Я ниже поля — подъём обратно.
export async function arenaClimbTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { AR, badShafts, bot, bowWatch, buildDone, buildGuard, clear, columnInputs, ctl, guardCtl, holdWeapon, mobCtl, mobThreat, pathTo, routeInputs, st, towerShield, used } = ctx
  const { me, meBelow, now } = turn
  const arenaClimbInputs = AR && columnInputs(Math.max(0, Math.ceil(AR.y - me.y))) + '|' + routeInputs()
  // Во рву у цели (она рядом на уровне поля) — плыть к ней и вылезать у неё, а не искать берег спасением из воды (стенд
  // бота-противника 22.10, остров во рву: «выплыл из ямы на берег, 24 с» в 4 бл. от цели).
  const swimToHim = !!AR && !!bot.entity.isInWater && turn.d < 8 && Math.abs(ctx.entity.position.y - AR.y) < 1.5
  if (meBelow && !swimToHim && ctx.prof.player && !edges.falling(bot) && (!ctx.failedClimb || ctx.failedClimb.inputs !== arenaClimbInputs)) {
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
    clear()
    ctx.aim = 'free'
    const farH = Math.max(Math.abs(bot.entity.position.x - AR.x), Math.abs(bot.entity.position.z - AR.z))
    if (farH > AR.r + 10) {
      used('далеко от поля — иду под него')
      try { bot.pathfinder.setGoal(new goals.GoalNearXZ(AR.x, AR.z, Math.max(4, AR.r - 4))) } catch {}
      const tW = gameClock.now()
      while (gameClock.now() - tW < 25000 && !ctl.aborted && !ctx.selfDied && !mobThreat() && Math.max(Math.abs(bot.entity.position.x - AR.x), Math.abs(bot.entity.position.z - AR.z)) > AR.r) await ctx.sleep(250)
      try { bot.pathfinder.setGoal(null) } catch {}
    }
    const need = Math.max(2, Math.ceil(AR.y - bot.entity.position.y) + 1)
    let have = edges.fillerCount(bot)
    if (have < need) {
      if (!st.gatherNoteAt || now - st.gatherNoteAt > 15000) { st.gatherNoteAt = now; used(`блоков на подъём ${have} из ${need} — добываю`) }
      const gb = await edges.gatherBlocks(bot, mobCtl, { want: need + 4 - have, maxMs: 25000 })
      st.gathered = (st.gathered || 0) + gb.got
      if (gb.got) used(`добыл ${gb.got} бл. на подъём (${gb.what}, ${Math.round(gb.ms / 1000)} с)`)
      else if (gb.why && gb.why !== 'прервали') used(`блоки не добыл: ${gb.why}`)
      have = edges.fillerCount(bot)
    }
    if (have >= need && !mobThreat()) {
      const inputs = routeInputs() + '|' + columnInputs(need)
      if (ctx.shaftInputs !== inputs) { badShafts.clear(); ctx.shaftInputs = inputs }
      const t0c = gameClock.now()
      const gK: any = buildGuard()
      let cb = null
      try { cb = await edges.climbBack(bot, guardCtl(gK), ctx.entity, { beforeStep: towerShield, archer: bowWatch.shots > 0 || !!findItem(bot, i => i.name === 'bow' || i.name === 'crossbow'), floorY: AR.y, exclude: badShafts, digNear: 12000 }) } catch (e) { cb = { ok: false, why: e.message } }
      if (buildDone(gK, 'подъём на поле')) cb = { ok: false, why: gK.why }
      if (cb && !cb.ok && cb.shaft && /не дошёл|не выломал|не растёт|не подпрыгнул/.test(cb.why || '')) for (let ax = -2; ax <= 2; ax++) for (let az = -2; az <= 2; az++) badShafts.add((cb.shaft.x + ax) + ',' + (cb.shaft.z + az))
      if (cb && cb.ok) st.returns = (st.returns || 0) + 1
      used(cb && cb.ok ? `вернулся на поле (${cb.how}, ${Math.round((gameClock.now() - t0c) / 1000)} с)` : `не вернулся: ${(cb && (cb.why || cb.how)) || '?'}`)
    }
    ctx.failedClimb = bot.entity.position.y >= AR.y - 1.5 ? null : { inputs: columnInputs(Math.max(0, Math.ceil(AR.y - bot.entity.position.y))) + '|' + routeInputs(), why: have < need ? 'blocks' : 'shaft_not_reached' }
    ctx.aim = 'target'
    await holdWeapon()
    return NEXT
  }
}

// Он высоко на земле — подъём к нему.
export async function climbToHimTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { AR, bot, bowWatch, buildDone, buildGuard, clear, columnInputs, foeGrounded, guardCtl, holdWeapon, pathTo, routeInputs, towerShield, used } = ctx
  const { d, dy } = turn
  const climbInputs = columnInputs(Math.max(0, Math.ceil(dy))) + '|' + routeInputs()
  if (!AR && ctx.prof.player && dy > 6 && foeGrounded() && !ctx.perch && d < 90 &&
      (!ctx.failedClimb || ctx.failedClimb.inputs !== climbInputs)) {
    pathTo(false); ctx.pathing = false
    clear()
    ctx.aim = 'free'
    const t0c = gameClock.now()
    let cb = null
    const gK: any = buildGuard()
    try { cb = await edges.climbBack(bot, guardCtl(gK), ctx.entity, { beforeStep: towerShield, archer: bowWatch.shots > 0 || !!findItem(bot, i => i.name === 'bow' || i.name === 'crossbow') }) } catch (e) { cb = { ok: false, why: e.message } }
    if (buildDone(gK, 'подъём к нему')) cb = { ok: false, why: gK.why }
    ctx.aim = 'target'
    await holdWeapon()
    used(cb && cb.ok ? `поднялся к нему (${cb.how}, ${Math.round((gameClock.now() - t0c) / 1000)} с)` : `не поднялся: ${(cb && (cb.why || cb.how)) || '?'}`)
    ctx.failedClimb = cb?.ok ? null : { inputs: columnInputs(Math.max(0, Math.ceil(ctx.entity.position.y - bot.entity.position.y))) + '|' + routeInputs(), why: cb?.why || 'climb_not_confirmed' }
    if (process.env.ND_DEBUG_PVP) console.log('[climb]', JSON.stringify(cb))
    return NEXT
  }
}

// Он скрыт: пробить, вскрыть коробку, обойти.
export async function hiddenFoeTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { after, bot, clear, digWatch, holdWeapon, maceNow, mc, miningProgress, noticed, pathTo, punchThrough, ready, rest, routeInputs, style, throwAt, tt, used } = ctx
  const { d, hidden, me, now, r, theyEat, theyUp } = turn
  // Толпа «держит место»: к скрытой цели не пробиваюсь — бью тех, кто вошёл в руку.
  if (ctx.crowd?.hold) return
  if (hidden && !ctx.perch && !ctx.reposition && after('hidden', true) && ctx.punches < style.punchLimit) {
    if (await punchThrough()) { ctx.punches++; return NEXT }
  }
  if (!hidden) delete noticed.hidden
  if (ctx.exhaustedPunch && ctx.exhaustedPunch.inputs !== routeInputs()) { ctx.exhaustedPunch = null; ctx.punches = 0 }
  if (hidden && !ctx.perch && !ctx.reposition && ctx.punches >= style.punchLimit && !ctx.exhaustedPunch) {
    ctx.exhaustedPunch = { inputs: routeInputs(), why: 'opponent_repairs_opening' }
    used('он латает быстрее — жду и лечусь')
  }
  if (hidden && !ctx.perch && !ctx.reposition) {
    const theirCell = ctx.entity.position.floored()
    const enc = fortify.enclosure(bot, theirCell)
    const pickaxe = fortify.pickaxeOf(bot)
    if (enc.walls >= 3 && pickaxe) {
      const plan = fortify.siegePlan(bot, theirCell, me)
      if (plan && plan.digMs > 2500 && d >= 4.6 && d <= 8) {
        const pot = findItem(bot, i => i.name === 'splash_potion' && /(harming|poison)$/.test(potionOf(i) || ''))
        if (pot) {
          if (await throwAt(pot, 'зелье в его коробку')) { await holdWeapon(); return NEXT }
        }
      }
      if (plan && plan.digMs <= 12000) {
        const standDist = Math.hypot(plan.stand.x + 0.5 - me.x, plan.stand.z + 0.5 - me.z)
        const siegeInputs = [plan.breakAt, bot.blockAt(plan.breakAt)?.stateId ?? bot.blockAt(plan.breakAt)?.name, plan.digMs, routeInputs(), !!maceNow(), gameClock.now() - tt.myHurtAt < 300].join('|')
        if (standDist > 0.9 && (!ctx.failedSiege || ctx.failedSiege.inputs !== siegeInputs)) {
          const key = `${plan.stand.x},${plan.stand.y},${plan.stand.z}`
          if (ctx.siegeGoal !== key || !ctx.siegeRoute || !ctx.pathing) {
            ctx.siegeGoal = key; ctx.siegeRoute = { from: me.clone(), at: now }
            pathTo(true, new goals.GoalBlock(plan.stand.x, plan.stand.y, plan.stand.z)); ctx.pathing = true; clear()
          }
          if (miningProgress() || me.distanceTo(ctx.siegeRoute.from) >= .5) { ctx.siegeRoute.from = me.clone(); ctx.siegeRoute.at = now }
          if (ctx.siegeRoute.failed || now - ctx.siegeRoute.at > 3000) {
            ctx.failedSiege = { inputs: siegeInputs, why: ctx.siegeRoute.failed || 'no_progress' }
            ctx.failedReposition = { inputs: routeInputs(), why: ctx.failedSiege.why }
            ctx.siegeRoute = null; ctx.siegeGoal = null; pathTo(false); ctx.pathing = false
          } else { await ctx.sleep(TICK_MS); return NEXT }
        }
        if (standDist <= .9 && (!ctx.failedSiege || ctx.failedSiege.inputs !== siegeInputs)) {
          pathTo(false); ctx.pathing = false; ctx.siegeGoal = null
          clear()
          ctx.aim = 'free'
          const stop = await digWatch(bot.blockAt(plan.breakAt), () => (ctx.prof.player && mc.threat()) ? 'булава летит'
            : !ctx.entity.isValid ? 'он пропал' : ctx.entity.position.floored().distanceTo(theirCell) > 1.5 ? 'он вышел'
              : gameClock.now() - tt.myHurtAt < 300 ? 'бьют меня' : null)
          ctx.aim = 'target'
          await holdWeapon()
          ctx.failedSiege = !fortify.solidAt(bot, plan.breakAt) ? null : { inputs: siegeInputs, why: stop || 'block_not_removed' }
          if (!fortify.solidAt(bot, plan.breakAt)) used(plan.digMs > 2500 ? 'выломал блок его крепкой коробки' : 'выломал блок его коробки киркой')
          else if (stop) used(`бросил ломать его коробку: ${stop}`)
          return NEXT
        }
      } else if (plan && ready('guard')) { rest('guard', 4000); used('его коробку не вскрыть — караулю') }
    } else if (enc.walls >= 3) {
      if (ready('guard')) { rest('guard', 4000); used('караулю его коробку') }
    } else if (r > HIT_REACH && !ctx.exhaustedPunch && (await punchThrough())) {
      return NEXT
    } else if (r > HIT_REACH && !theyUp && (!ctx.failedFlank || ctx.failedFlank.inputs !== routeInputs())) {
      if (!ctx.flankRoute || !ctx.pathing) {
        ctx.flankRoute = { from: me.clone(), at: now, target: ctx.entity.id }
        pathTo(true, new goals.GoalFollow(ctx.entity, 2)); ctx.pathing = true; clear()
      }
      if (miningProgress() || me.distanceTo(ctx.flankRoute.from) >= .5) { ctx.flankRoute.from = me.clone(); ctx.flankRoute.at = now }
      if (ctx.flankRoute.failed || now - ctx.flankRoute.at > 3000) {
        ctx.failedFlank = { inputs: routeInputs(), why: ctx.flankRoute.failed || 'no_progress' }
        ctx.failedReposition = ctx.failedFlank
        ctx.flankRoute = null; pathTo(false); ctx.pathing = false
        used('обход не выходит — иначе')
      } else {
      if (ready('flank')) { rest('flank', 3000); used(theyEat ? 'рывок в обход, пока он ест' : 'обхожу его стенку') }
      await ctx.sleep(TICK_MS)
      return NEXT
      }
    }
  } else if (ctx.siegeGoal) { ctx.siegeGoal = null; ctx.siegeRoute = null; pathTo(false); ctx.pathing = false }
}

// Сломать опору под ним.
export async function breakUnderTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, foeGrounded, holdItem, holdWeapon, maceNow, pathTo, rangedAllowed, routeInputs, shotReady, st, used } = ctx
  const { dy, meInWeb, seesBody, theirR } = turn
  turn.pillarNeeded = !rangedAllowed() || !findItem(bot, i => i.name === 'bow' || i.name === 'crossbow') ||
    !findItem(bot, i => /arrow$/.test(i.name)) || !seesBody || !shotReady('bow') || !!ctx.failedReposition
  // Сломать опору под ним (S7d, пункт G): он стоит выше (столб, уступ), блок под его ногами виден, в досягаемости,
  // ломается быстро (время копки 1.21.11 — bot.digTime лучшим инструментом) и сам я не под его ударом —
  // сломать: он падает (с высоты > 3 — урон), теряет высоту. Иначе — дороже, чем ждать/стрелять/строить свой столб.
  // И на равной высоте — если под его опорой беда (пользователь 10.10: «ломать блоки под противником — забурить, скинуть
  // в лаву или в пропасть»): лава в 3 клетках ниже опоры или пустота глубже 3 (падение с уроном, яма без выхода).
  // Пол колизея — в два слоя (крыша: плита на блоке, галереи: два блока; пользователь 15.10: «на краю стоит — под ним
  // блоки сломать, чтобы скинуть»): один блок под опорой, ниже пустота 3+ — тоже беда; опору ломают дважды, второй — сквозь.
  const dangerBelow = () => {
    try {
      const c = ctx.entity.position.offset(0, -0.5, 0).floored()
      let air = 0, layer = 0
      for (let k = 1; k <= 9; k++) {
        const b = bot.blockAt(c.offset(0, -k, 0))
        if (!b) return false
        if (/lava/.test(b.name)) return k <= 3 + air + layer
        if (b.boundingBox !== 'empty') { if (air || layer || b.diggable === false || /obsidian|bedrock|barrier/.test(b.name)) break; layer++; continue }
        air++
      }
      return air >= 3
    } catch { return false }
  }
  // Быстрая кирка (опора ломается за 0.4 с) — ломать и вплотную (удар он успеет, но и падает сразу); иначе — вне его удара.
  const underMs = () => { try { const blk = bot.blockAt(ctx.entity.position.offset(0, -0.5, 0).floored()); return blk ? tools.bestFor(bot, blk).ms : Infinity } catch { return Infinity } }
  const underInputs = [routeInputs(), ctx.entity.position.offset(0, -.5, 0).floored(), underMs(), theirR > 3.3, !!maceNow()].join('|')
  if ((!ctx.failedBreakUnder || ctx.failedBreakUnder.inputs !== underInputs) && ctx.prof.player && (dy >= 1.4 || dangerBelow()) && foeGrounded() && theirR > (theirR > 1.8 && underMs() <= 400 ? 1.8 : 3.3) && !ctx.perch && !ctx.fort && !meInWeb) {
    try {
      const cell = ctx.entity.position.offset(0, -0.5, 0).floored()
      const blk = bot.blockAt(cell)
      const eyeP = bot.entity.position.offset(0, EYE, 0)
      const myCell = bot.entity.position.offset(0, -0.5, 0).floored()
      const hw = (ctx.entity.width || 0.6) / 2
      // Он на этой клетке целиком (иначе стоит ещё на соседней — ломать бесполезно).
      // Опора — единственная твёрдая клетка под его рамкой (свисает с края, соседняя — воздух, — тоже; Codex 15.10).
      const under = [[-hw, -hw], [-hw, hw], [hw, -hw], [hw, hw]].map(([ox, oz]) => cell.offset(Math.floor(ctx.entity.position.x + ox * .98) - cell.x, 0, Math.floor(ctx.entity.position.z + oz * .98) - cell.z))
      const onlyThis = under.every(c => c.equals(cell) || bot.blockAt(c)?.boundingBox !== 'block')
      if (blk && blk.boundingBox === 'block' && blk.diggable !== false && onlyThis && !cell.equals(myCell) &&
          eyeP.distanceTo(cell.offset(0.5, 0.5, 0.5)) <= 4.4 && pick.blockSeen(bot, cell) && !/obsidian|bedrock|barrier|crying/.test(blk.name)) {
        const tool = (() => { try { return bot.pathfinder.bestHarvestTool(blk) } catch { return null } })()
        if (tool && bot.heldItem?.name !== tool.name) await holdItem(tool)
        let ms = Infinity
        try { ms = bot.digTime(blk) } catch {}
        if (ms <= 1500) {
          if (ctx.pathing) { pathTo(false); ctx.pathing = false }
          clear()
          ctx.aim = 'free'
          const h0 = ctx.entity.position.y
          let ok = false
          bot._ndBlockTag = { what: 'сломать опору под ним', at: gameClock.wall.now() }
          try { await withTimeout(bot.dig(blk, true), ms + 600); ok = !bot.blockAt(cell) || bot.blockAt(cell).boundingBox === 'empty' } catch {}
          bot._ndBlockTag = null
          ctx.aim = 'target'
          st.breakUnder = st.breakUnder || { tries: 0, ok: 0, fell: 0 }
          st.breakUnder.tries++
          ctx.failedBreakUnder = ok ? null : { inputs: underInputs, why: 'support_not_removed' }
          if (ok) st.breakUnder.ok++
          await ctx.sleep(300)
          if (ok && ctx.entity.position.y < h0 - 0.8) st.breakUnder.fell++
          used(ok ? `сломал опору под ним (${blk.name}, ${Math.round(ms)} мс)${ctx.entity.position.y < h0 - 0.8 ? ' — упал' : ''}` : `опору под ним не сломал (${blk.name})`)
          // Осел на второй слой пола (над пустотой) — его сразу, без паузы: иначе отойдёт (Codex 15.10).
          await holdWeapon()
          return NEXT
        } else if (tool) await holdWeapon()
      }
    } catch {}
  }
}

// Столб к его столбу.
export async function counterPillarTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, buildDone, buildGuard, clear, columnInputs, guardCtl, headroom, holdWeapon, miningProgress, noteBuild, pathTo, routeInputs, st, towerShield, used } = ctx
  const { me, now, pillarNeeded, theirR, theyUp } = turn
  if (theyUp && ctx.prof.player && !ctx.perch && !ctx.reposition && pillarNeeded) {
    const filler = pickFiller(bot)
    const fp = ctx.foeSeenPos || me
    const need = ctx.foeSeenPos ? Math.floor(fp.y - me.y) - 1 : 0
    if (filler && need >= 2 && need <= 12 && edges.fillerCount(bot) >= need && headroom(need + 1)) {
      const counterInputs = columnInputs(need) + '|' + routeInputs()
      if (ctx.failedCounter?.inputs === counterInputs) ctx.counterRoute = null
      else {
      const hdP = Math.hypot(fp.x - me.x, fp.z - me.z)
      if (hdP > 1.6) {
        const goal = `${Math.floor(fp.x)},${Math.floor(me.y)},${Math.floor(fp.z)}`
        if (!ctx.counterRoute || ctx.counterRoute.goal !== goal || !ctx.pathing) {
          ctx.counterRoute = { goal, from: me.clone(), at: now, target: ctx.entity.id }
          pathTo(true, new goals.GoalNear(fp.x, me.y, fp.z, 1)); ctx.pathing = true; clear()
        }
        if (miningProgress() || me.distanceTo(ctx.counterRoute.from) >= .5) { ctx.counterRoute.from = me.clone(); ctx.counterRoute.at = now }
        if (ctx.counterRoute.failed || now - ctx.counterRoute.at > 3000) {
          ctx.failedCounter = { inputs: counterInputs, why: ctx.counterRoute.failed || 'no_progress' }
          pathTo(false); ctx.pathing = false; ctx.counterRoute = null
          used('столб к его столбу: не подойти под него')
        } else { await ctx.sleep(TICK_MS); return NEXT }
      } else {
      ctx.counterRoute = null
      pathTo(false); ctx.pathing = false
      clear()
      ctx.aim = 'free'
      if (FIX && theirR <= THEIR_REACH) { ctx.failedCounter = { inputs: counterInputs, why: 'foe_reaches_build' }; st.build.refused++; ctx.aim = 'target'; used('столб к его столбу: не строю — он достаёт сверху'); return NEXT }
      noteBuild('counter', need * PILLAR_MS)
      const gC = buildGuard()
      let tower = null
      try { tower = await towerUp(bot, guardCtl(gC), need, { sneak: false, fast: true, beforeStep: towerShield }) } catch {}
      ctx.failedCounter = tower?.ok ? null : { inputs: columnInputs(Math.max(0, Math.floor(fp.y - bot.entity.position.y) - 1)) + '|' + routeInputs(), why: tower?.why || 'height_not_confirmed' }
      ctx.aim = 'target'
      await holdWeapon()
      if (buildDone(gC, 'столб к его столбу')) { ctx.failedCounter = { inputs: columnInputs(Math.max(0, Math.floor(fp.y - bot.entity.position.y) - 1)) + '|' + routeInputs(), why: gC.why }; return NEXT }
      used(`строю столб к его столбу (${need} бл.)`)
      return NEXT
      }
      }
    }
  }
}

// Стояние на возвышениях: мост или спуск к нему.
export async function standoffTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, buildDone, buildGuard, clear, ctl, edgeGuard, guardCtl, holdWeapon, itemInputs, miningProgress, pathTo, routeInputs, used } = ctx
  const { d, dy, meInWeb, r } = turn
  // Спуск считаем до повторного обхода стены: путь с maxDropDown=3 не сойдёт с борта в 4 блока.
  if (ctx.prof.player && !ctx.fort && !meInWeb && bot.entity.onGround && r > HIT_REACH && d < 8 && dy <= 1.6 &&
      !miningProgress() && (!ctx.failedStandoff || ctx.failedStandoff.inputs !== routeInputs() + '|' + itemInputs(/bucket$|obsidian|cobblestone|dirt/))) {
    const el = bridge.elevatedToward(bot, ctx.entity.position)
    if (el.drop > edges.SAFE_FALL || el.lava) {
      pathTo(false); ctx.pathing = false
      clear()
      ctx.aim = 'free'
      let how = null
      try {
        let br = { ok: false, why: dy < -1.6 ? 'он ниже — спуск' : 'нечем мостить', placed: 0 }
        if (dy >= -1.6 && pickFiller(bot)) {
          const gM = buildGuard()
          br = await bridge.build(bot, guardCtl(gM), ctx.entity)
          if (buildDone(gM, 'мост')) br.ok = false
        }
        how = br.ok ? `мост к нему (${br.placed} бл.)` : null
        if (!br.ok) {
          const dr = await bridge.dropDown(bot, ctl, ctx.entity, { edgeGuard })
          how = dr.ok ? `спрыгнул к нему (−${dr.dmg} хп)` : `застряли на столбах: ${br.why}; ${dr.why || 'спуска нет'}`
          if (dr.ok) ctx.perch = null
        }
      } catch (e) { how = 'стояние на столбах: ' + e.message }
      ctx.aim = 'target'
      await holdWeapon()
      used(how)
      ctx.failedStandoff = how?.startsWith('мост к нему') || how?.startsWith('спрыгнул к нему') ? null : { inputs: routeInputs() + '|' + itemInputs(/bucket$|obsidian|cobblestone|dirt/), why: 'no_bridge_or_landing' }
      return NEXT
    }
  }
}

// Счёт тиков упора в стену.
export function stuckTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot } = ctx
  if (bot.entity.isCollidedHorizontally && (bot.getControlState('forward') || bot.getControlState('left') || bot.getControlState('right'))) ctx.stuckTicks++
  else ctx.stuckTicks = 0
}

// Прыжок через препятствие к нему.
export async function hopTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { HOP, bot, clear, ctl, hazardOnLine, miningProgress, pathTo, routeInputs, st, used } = ctx
  const { d, dy, meInWeb, r } = turn
  // Толпа «держит место» (turn-crowd: цель в куче) — прыжок к цели не нужен (c5f: 3 прыжка за раунд, 1.3 с).
  if (HOP && ctx.prof.player && !ctx.crowd?.hold && !ctx.perch && !ctx.fort && !meInWeb && bot.entity.onGround && !bot.entity.isInWater && r > HIT_REACH && d < 9 &&
      !miningProgress() && (!ctx.failedHop || ctx.failedHop.inputs !== routeInputs()) && (bot.entity.isCollidedHorizontally ||
        (dy > 0.6 && dy < 2.6 && d < 5) || !!hazardOnLine() || !!ctx.failedReposition || !!ctx.failedFlank)) {
    const me0 = bot.entity.position.clone()
    const foeAt = ctx.entity.position.clone()
    const score = (t) => {
      const dd = Math.hypot(t.x - foeAt.x, t.z - foeAt.z)
      if (dd > d - 0.4 || t.y < me0.y - 3) return -Infinity
      return -dd - Math.abs(t.y - foeAt.y) * 0.3 + (t.y > me0.y ? 0.3 : 0)
    }
    pathTo(false); ctx.pathing = false; clear()
    let hop = null
    try { hop = await require('../navigation/parkour').combatHop(bot, ctl, { score, radius: 4 }) } catch (e) { hop = { ok: false, why: e.message } }
    st.hops = (st.hops || 0) + 1
    // Итог по делу (S7d): исполнитель S6 строг (сбитая траектория от его удара — «physics_diverged»), а в бою важно,
    // долетел ли я до точки или стал к нему ближе на 1.5+ без падения: это «удался по делу».
    await ctx.sleep(TICK_MS * 4)
    const meH = bot.entity.position
    const landed = !!(hop && hop.target && bot.entity.onGround && meH.distanceTo(hop.target) <= 1.3)
    const closer = Math.hypot(meH.x - ctx.entity.position.x, meH.z - ctx.entity.position.z) <= d - 1.5 && meH.y >= me0.y - 1
    if (hop && (hop.ok || landed || closer)) {
      st.hopOk = (st.hopOk || 0) + (hop.ok ? 1 : 0)
      st.hopEff = (st.hopEff || 0) + 1
      used(ctx.stuckTicks >= 4 ? 'прыжок через препятствие к нему' : dy > 0.6 ? 'прыжок на его уступ' : 'прыжок к нему (путь стоял)')
      ctx.failedHop = null
    } else { if (hop && hop.why) st.hopWhy = hop.why; ctx.failedHop = { inputs: routeInputs(), why: hop?.why || 'landing_not_confirmed' } }
    ctx.stuckTicks = 0
    return NEXT
  }
}

// Перестановка ради линии обзора.
export async function repositionTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, hazardOnLine, losSpot, miningProgress, pathTo, routeInputs, st, used } = ctx
  const { dy, me, now, r, seesBody } = turn
  // Окно перестановки заканчивается результатом маршрута; время лишь обнаруживает отсутствие прогресса.
  if (ctx.reposition) {
    const mining = miningProgress()
    if (mining || me.distanceTo(ctx.reposition.from) >= 0.5) { ctx.reposition.from = me.clone(); ctx.reposition.at = now }
    const arrived = !!ctx.losGoal && ctx.losGoal.isEnd(me.floored())
    const direct = !ctx.losGoal && seesBody && Math.abs(dy) < 2.5 && stepSafe(bot, keyDir(bot, 'forward')) && !hazardOnLine()
    const failed = ctx.reposition.failed || (!mining && now - ctx.reposition.at > 3000) || (arrived && !seesBody)
    if (arrived || (ctx.losGoal && seesBody) || direct || r <= HIT_REACH || ctx.perch || ctx.fort || ctx.reposition.target !== ctx.entity.id || failed) {
      if (failed) ctx.failedReposition = { inputs: routeInputs(), why: ctx.reposition.failed || (arrived ? 'view_blocked' : 'no_progress') }
      ctx.reposition = null; ctx.losGoal = null; pathTo(false); ctx.pathing = false
    }
  }
  if (!ctx.perch && !ctx.fort && r > HIT_REACH && !ctx.reposition && !miningProgress() &&
      (!ctx.failedReposition || ctx.failedReposition.inputs !== routeInputs())) {
    const wall = !seesBody && !raySees(bot, me.offset(0, 0.4, 0), ctx.entity.position.offset(0, 0.4, 0))
    if (wall || ctx.stuckTicks >= 8) {
      pathTo(false); ctx.pathing = false
      ctx.reposition = { from: me.clone(), at: now, target: ctx.entity.id }
      ctx.stuckTicks = 0
      ctx.losGoal = null
      if (dy > 2.2) {
        const spot = losSpot()
        if (spot) { ctx.losGoal = new goals.GoalBlock(spot.x, spot.y, spot.z); st.losSpots = (st.losSpots || 0) + 1 }
      }
      used(ctx.losGoal ? 'он высоко за стеной — отхожу туда, откуда его видно' : wall ? 'стена между нами — путь в обход или насквозь' : 'упёрся — обхожу')
    }
  }
  if ((ctx.reposition || miningProgress()) && r > HIT_REACH && !ctx.perch) {
    if (!ctx.pathing) { pathTo(true, ctx.losGoal); ctx.pathing = true; clear() }
    await ctx.sleep(TICK_MS)
    return NEXT
  }
}
