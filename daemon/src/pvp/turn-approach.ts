import * as gameClock from '../game-clock'
import { bestWeapon } from '../items'
import { blockName, keyDir, wantsJump } from '../moves'
import * as read from '../read'
import * as pick from '../pick'
import * as spear from '../spear'
import * as throwMod from '../throw'
import { healthOf, stepSafe } from './body'
import { runLength } from '../flee'
import { foodAnimals, foodIgnitionAllowed } from './food-fire'
import { findItem, potionOf, potionRole } from './potions'
import { FAR, HIT_REACH, TICK_MS } from './rules'
import { strikeWait } from './strike-order'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

// Диагностика связки: одна запись причины в игровую секунду, повтор hint её не сбрасывает.
function traceLanceWeb (bot: any, stage: string, data: any) {
  if (process.env.ND_LANCE_WEB_TRACE !== '1') return
  const at = gameClock.now(), key = [stage, data.target || '', data.reason || ''].join(':')
  const sent: Map<string, number> = bot._ndLanceWebTrace || (bot._ndLanceWebTrace = new Map())
  if (at - (sent.get(key) ?? -Infinity) < 1000) return
  sent.set(key, at)
  console.log('[lance-web]', JSON.stringify({ stage, at, helper: bot.username, ...data }))
}

// Радиус координации шире руки; реальный клик проверяется отдельно.
export function lanceWebRequest (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, entity, vision } = ctx, hint = bot._ndLanceWeb
  if (!hint) return null
  const refuse = (reason: string) => { traceLanceWeb(bot, 'decision', { target: hint.target, reason }); return null }
  if (hint.until <= gameClock.now()) return refuse('expired')
  if (hint.target !== (entity.username || entity.name)) return refuse('wrong_target')
  if (ctx.ctl.aborted || !ctx.prof.player || ctx.prof.webImmune || turn.meInWeb) return refuse('helper_unavailable')
  if (bot.entity.elytraFlying || bot._ndElytra?.driving) return refuse('flight_active')
  if (bot.entity.position.distanceTo(entity.position) >= 12) return refuse('outside_coordination')
  if (!vision.visible(entity)) return refuse('hidden_target')
  const cell = entity.position.floored(), below = cell.offset(0, -1, 0)
  if (!pick.blockSeen(bot, below)) return refuse('hidden_support')
  if (bot.blockAt(below)?.boundingBox !== 'block') return refuse('unsupported_target')
  if ([cell, cell.offset(0, 1, 0)].some(p => pick.blockSeen(bot, p) && bot.blockAt(p)?.name === 'cobweb')) return refuse('already_webbed')
  const web = findItem(bot, i => i.name === 'cobweb')
  if (!web) return refuse('no_web')
  traceLanceWeb(bot, 'decision', { target: hint.target, reason: 'approach' })
  return web
}

export function lanceWebItem (ctx: DuelCtx, turn: TurnFrame) {
  const web = lanceWebRequest(ctx, turn)
  if (!web) return null
  const below = ctx.entity.position.floored().offset(0, -1, 0)
  if (!pick.faceAim(ctx.bot, below, { x: 0, y: 1, z: 0 })) {
    traceLanceWeb(ctx.bot, 'decision', { target: ctx.bot._ndLanceWeb.target, reason: 'no_legal_face_in_reach' })
    return null
  }
  traceLanceWeb(ctx.bot, 'decision', { target: ctx.bot._ndLanceWeb.target, reason: 'ready' })
  return web
}

export async function lanceWebTurn (ctx: DuelCtx, turn: TurnFrame) {
  const web = lanceWebItem(ctx, turn)
  if (!web) return
  delete ctx.bot._ndLanceWeb
  if (ctx.pathing) { ctx.pathTo(false); ctx.pathing = false }
  ctx.clear()
  try {
    const ok = await ctx.placeUnder(web, 'команда: паутина к тарану')
    traceLanceWeb(ctx.bot, 'use', { target: ctx.entity.username || ctx.entity.name, reason: ok ? 'placed' : 'placement_refused', ok })
    if (ok) return NEXT
  } finally { await ctx.holdWeapon() }
}

// Летун: шаг вбок, не гнаться.
export async function flyerTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, pathTo, set, strafeStep } = ctx
  const { dy } = turn
  if (ctx.prof.flying && (dy > 3 || ctx.entity.name === 'ghast')) {
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
    strafeStep()
    const zig = ctx.dodgeKey && ctx.dodgeLine ? ctx.dodgeKey : ctx.strafeKey
    set('forward', false)
    set('back', false)
    set('left', zig === 'left' && stepSafe(bot, keyDir(bot, 'left')))
    set('right', zig === 'right' && stepSafe(bot, keyDir(bot, 'right')))
    set('sprint', false)
    set('jump', false)
    await ctx.sleep(TICK_MS)
    return NEXT
  }
}

// Далеко: разгон копья, жемчуг к лучнику, зигзаг, путь.
export async function farApproachTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, clear, guard, holdWeapon, leadFn, pathTo, pvpSkills, ready, rest, routeInputs, set, spearChargeFar, strafeStep, used } = ctx
  const { aimedCb, arrowItem, bowItem, bowShield, cbShield, d, hp, meInWeb, noMelee, r, seesBody, theyBow, theyUp } = turn
  if (d > FAR && !(noMelee && bowItem && arrowItem)) {
    if (guard) await guard.raise(!!(cbShield || bowShield))
    if (ctx.perch) { clear(); await ctx.sleep(TICK_MS); return NEXT }
    if (!theyUp && !ctx.perch && !ctx.fort && !meInWeb && (await spearChargeFar(r, d))) return NEXT
    const shooter = theyBow || ctx.prof.ranged
    const pearl = findItem(bot, i => i.name === 'ender_pearl')
    if (ctx.prof.player && theyBow && pearl && pvpSkills.itemReady(pearl) && pearl.count >= 2 && d > 14 && d < 40 && hp > 13) {
      ctx.aim = 'free'
      const r = await pvpSkills.throwPearl(leadFn(0.1), {
        onAim: (res) => !!(res.land && !res.land.void && throwMod.safeLanding(bot, res.land.tp) && res.land.tp.y > bot.entity.position.y - 5)
      })
      ctx.aim = 'target'
      if (!(r && r.thrown)) await holdWeapon()
      if (r && r.thrown) {
        used('жемчуг: к лучнику')
        await holdWeapon()
        return NEXT
      }
    }
    const f = keyDir(bot, 'forward')
    if (aimedCb && seesBody && d < 40) {
      if (ctx.pathing) { pathTo(false); ctx.pathing = false }
      const fw = stepSafe(bot, f)
      const zig = ctx.dodgeKey && ctx.dodgeLine ? ctx.dodgeKey : ctx.strafeKey
      set('forward', fw); set('back', false)
      set('sprint', fw && (bot.food ?? 20) > 6)
      set('left', zig === 'left' && stepSafe(bot, keyDir(bot, 'left')))
      set('right', zig === 'right' && stepSafe(bot, keyDir(bot, 'right')))
      set('jump', false)
      if (ready('cbDodgeNote')) { rest('cbDodgeNote', 4000); used(`его арбалет на мне — пробег вбок (${aimedCb.steadyMs} мс держит прицел)`) }
      await ctx.sleep(TICK_MS)
      return NEXT
    }
    if (shooter && seesBody && stepSafe(bot, f) && d < 30) {
      if (ctx.pathing) { pathTo(false); ctx.pathing = false }
      strafeStep()
      const zig = ctx.dodgeKey && ctx.dodgeLine ? ctx.dodgeKey : ctx.strafeKey
      set('forward', true)
      set('sprint', (bot.food ?? 20) > 6)
      set('left', zig === 'left' && stepSafe(bot, keyDir(bot, 'left')))
      set('right', zig === 'right' && stepSafe(bot, keyDir(bot, 'right')))
      set('jump', wantsJump(bot, f) || Math.random() < 0.15)
      await ctx.sleep(TICK_MS)
      return NEXT
    }
    // Видно его, и до него ровная дорога — бежать прямо, без A*: GoalFollow ищет путь с нуля, как только цель ушла на 2 бл.
    // (человек со Скоростью — каждые 3–4 тика), и пока поиск идёт, бот стоит (стенд бота-противника 22.10: поиск дольше 1 с
    // у трети походов). Обрыв, лава, стена, ступень выше блока, вода — как раньше, путём (бег по прямой плыл через ров:
    // пользователь — «плывут по воде вместо прыжков по блокам»; путь мостит воду блоками).
    const to = ctx.entity.position, me = bot.entity.position, flat = Math.hypot(to.x - me.x, to.z - me.z)
    const run = seesBody && flat < 32 && Math.abs(to.y - me.y) < 1.5 ? runLength(bot, { x: (to.x - me.x) / flat, z: (to.z - me.z) / flat }, Math.ceil(flat), 1, ctx.AR) : null
    if (run && run.len >= Math.floor(flat) - 1 && !run.wet) {
      if (ctx.pathing) { pathTo(false); ctx.pathing = false }
      set('forward', stepSafe(bot, f)); set('back', false); set('left', false); set('right', false)
      set('sprint', (bot.food ?? 20) > 6)
      set('jump', wantsJump(bot, f))
      await ctx.sleep(TICK_MS)
      return NEXT
    }
    if (!ctx.pathing && (ctx.failedReposition?.inputs === routeInputs() || ctx.failedFlank?.inputs === routeInputs())) {
      strafeStep(); clear()
      set(ctx.strafeKey, stepSafe(bot, keyDir(bot, ctx.strafeKey)))
      await ctx.sleep(TICK_MS)
      return NEXT
    }
    if (!ctx.pathing) { pathTo(true); ctx.pathing = true; clear() }
    set('sprint', true)
    await ctx.sleep(TICK_MS)
    return NEXT
  }
  if (ctx.pathing) { pathTo(false); ctx.pathing = false }
}

// Зелья, паутина, лава и огонь под него.
export async function debuffTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, duo, fireTerrainSafe, foeGrounded, foodFire, holdWeapon, opts, pendingLava, placeUnder, session, throwAt, useOnGroundAt } = ctx
  const { d, dy, hp, inWeb, r, seesBody } = turn
  // Толпа: зелья бросает turn-crowd (в кучу, к ногам, с 5.1–5.5 бл.); здесь — в одного, и каждая неудача — смена предмета.
  if ((d > 2.5 || ctx.theirPit) && d < 7 && !ctx.crowd?.on) {
    const effNow = read.effectsOf(bot, ctx.entity)
    const duoOn = ctx.prof.player && duo.active()
    const fits = i => {
      const base = (potionOf(i) || '').replace(/^(long|strong)_/, '')
      return potionRole(potionOf(i)) === 'debuff' && !(ctx.prof.undead && (base === 'harming' || base === 'poison')) && !effNow.has(base) && !(duoOn && base === 'harming')
    }
    const pref = ctx.splashFirst ? ['slowness', 'weakness', 'poison'].map(k => findItem(bot, i => i.name === 'splash_potion' && fits(i) && (potionOf(i) || '').replace(/^(long|strong)_/, '') === k)).find(Boolean) : null
    if (ctx.splashFirst && !pref) ctx.splashFirst = false
    const bad = pref || findItem(bot, i => (i.name === 'splash_potion' || i.name === 'lingering_potion') && fits(i))
    if (bad) {
      if (await throwAt(bad, 'зелье в него: ' + (potionOf(bad) || '?'))) {
        await holdWeapon()
        return NEXT
      }
    }
  }

  const web = findItem(bot, i => i.name === 'cobweb')
  if (web && !inWeb && !ctx.prof.webImmune && !ctx.prof.creeper && r < 4.2 && foeGrounded()) {
    if (await placeUnder(web, 'паутина под него')) { await holdWeapon(); return NEXT }
  }

  const lava = findItem(bot, i => i.name === 'lava_bucket')
  const fireProof = ctx.prof.player && read.effectsOf(bot, ctx.entity).has('fire_resistance')
  if (lava && ctx.prof.player && !fireProof && r > 2 && r < 4.3 && dy > -1 && dy < 1.5) {
    const cell = ctx.entity.position.floored()
    if (blockName(bot, cell) === 'air' || blockName(bot, cell) === 'cobweb') {
      if (await useOnGroundAt(lava, cell, 'лава под него')) {
        pendingLava.push({ cell, at: gameClock.now() })
        await holdWeapon()
        return NEXT
      }
    }
  }

  const flint = findItem(bot, i => i.name === 'flint_and_steel')
  const foodHunt = opts.purpose === 'food' && foodAnimals.has(ctx.entity.name)
  const fireCell = ctx.entity.position.floored()
  const animalFire = foodHunt && !!flint && foodIgnitionAllowed({ purpose: opts.purpose, animal: ctx.entity.name,
    remainingUses: (flint.maxDurability ?? 64) - (flint.durabilityUsed ?? 0), grounded: !!bot.entity.onGround && foeGrounded(),
    visible: seesBody, burning: !!(ctx.entity.metadata?.[0] & 1),
    selfSafe: hp >= 12 && bot.entity.position.distanceTo(fireCell.offset(.5, .5, .5)) > 2 && !bot.entity.isInWater && !bot.entity.isInLava,
    terrainSafe: fireTerrainSafe(fireCell) })
  const fireOk = foodHunt ? animalFire : ctx.prof.player || session.playPolicy?.mode !== 'speedrun'
  if (flint && fireOk && !ctx.prof.fireImmune && !fireProof && !ctx.prof.creeper && r > 1.8 && r < 4.3) {
    const cell = ctx.entity.position.floored()
    if (blockName(bot, cell) === 'air') {
      if (foodHunt) foodFire.attempts++
      if (await useOnGroundAt(flint, cell, foodHunt ? 'поджёг добычу для готового мяса' : 'поджёг')) {
        if (foodHunt) foodFire.ignited++
        await holdWeapon(); return NEXT
      }
      await holdWeapon()
    }
  }
}

// Копьё: укол, разгон, дистанция.
export async function spearTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, ctl, foe, gate, guard, holdItem, holdWeapon, maceNow, mf, ready, rest, routeInputs, set, st, strafeStep, used, vision } = ctx
  const { blocking, d, me, meInWeb, now, r, seesBody, theyUp } = turn
  const spearIt = ctx.prof.player && !theyUp && !ctx.perch && !ctx.fort && !meInWeb && !(ctx.spearOffUntil > now) ? spear.spearOf(bot) : null
  let spearTurn = !!spearIt
  if (spearIt) {
    const sName = spearIt.item.name
    const heldSpear = !!(bot.heldItem && spear.isSpear(bot.heldItem.name))
    const swordS = bestWeapon(bot)
    const sjNow = spear.jabReach(bot, ctx.entity)
    const justHit = now - ctx.lastSwing < 250
    if (heldSpear) {
      if (swordS && (sjNow.close || r < 2.1) && !(sjNow.ok && spear.readyIn(bot, sName) === 0)) {
        st.spearSwaps = (st.spearSwaps || 0) + 1
        used('копьё → меч: он ближе 2 бл., укол не достаёт')
        await holdWeapon()
        spearTurn = false
      }
    } else {
      const beyond = r > HIT_REACH + 0.4 && !sjNow.close
      const cheap = justHit || mf.clock.charge(0) < 0.4 || r > 4.2
      // Граф отверг и укол, и разгон — меч в руке остаётся (иначе свап меч↔копьё каждый тик с проверкой ниже).
      const graphNo = !!ctx.gp && !gate('jab') && !gate('charge')
      if (!swordS || (beyond && cheap && !graphNo)) {
        st.spearSwaps = (st.spearSwaps || 0) + 1
        if (swordS) used('меч → копьё: он дальше руки, заряд меча пуст')
        await holdItem(spearIt.item)
      } else spearTurn = false
    }
  }
  // Копьё — по расчёту, не правилом (показ 09.10: «держу его на 3.4–4.5» колол, хотя граф выбирал меч): укол и
  // разгон оба отвергнуты графом, а меч есть — ближе и мечом.
  if (spearIt && spearTurn && ctx.gp && bestWeapon(bot) && !gate('jab') && !gate('charge')) {
    spearTurn = false
    if (bot.heldItem && spear.isSpear(bot.heldItem.name)) await holdWeapon()
    if (ready('spearGraphNote')) { rest('spearGraphNote', 4000); used('копьё в сторону: мечом выгоднее по расчёту') }
  }
  // Щит поднят, а топор есть: укол и разгон копья щит гасит целиком (копьё щит не выбивает — Weapon без
  // disable_blocking), s7d-c-30p «копья»: 389 погашенных ударов, 3 ничьих — копьё в сторону, ближе и топором (свап в
  // тик удара в основной ветке), потом снова копьё.
  if (spearIt && spearTurn && blocking && findItem(bot, i => /_axe$/.test(i.name)) && !(foe.shieldOff(ctx.entity) > 300)) {
    spearTurn = false
    if (bot.heldItem && spear.isSpear(bot.heldItem.name)) await holdWeapon()
    if (ready('spearShieldNote')) { rest('spearShieldNote', 4000); used('щит поднят — копьё в сторону, топором') }
  }
  if (spearIt && spearTurn) {
    const sName = spearIt.item.name
    if (!bot.heldItem || bot.heldItem.name !== sName) await holdItem(spearIt.item)
    const sReady = spear.readyIn(bot, sName)
    const sj = spear.jabReach(bot, ctx.entity)
    const vS = ctx.track.vel()
    const towardMe = (vS.x * (me.x - ctx.entity.position.x) + vS.z * (me.z - ctx.entity.position.z)) / Math.max(d, 0.1)
    const win = spear.chargeWindow(sName, r, towardMe)
    const spearInputs = [routeInputs(), !!win, !!maceNow()].join('|')
    if (win && seesBody && (bot.food ?? 20) > 6 && stepSafe(bot, keyDir(bot, 'forward')) && (!ctx.failedSpearCharge || ctx.failedSpearCharge.inputs !== spearInputs)) {
      if (guard) await guard.raise(false)
      ctx.aim = 'free'
      const hpS = healthOf(bot, vision.source(ctx.entity))
      const ch = await spear.charge(bot, ctl, ctx.entity, { maxMs: 1800, safe: k => stepSafe(bot, keyDir(bot, k)), vel: () => ctx.track.vel(), onHit: () => { st.landed++ } })
      ctx.aim = 'target'
      ctx.failedSpearCharge = ch.hit ? null : { inputs: [routeInputs(), !!win, !!maceNow()].join('|'), why: ch.why || 'charge_missed' }
      st.spearCharges = (st.spearCharges || 0) + 1
      if (ch.hit) st.spearChargeHits = (st.spearChargeHits || 0) + 1
      used(ch.hit ? `разгон копьём — попал (${hpS != null && healthOf(bot, vision.source(ctx.entity)) != null ? Math.round((hpS - healthOf(bot, vision.source(ctx.entity))) * 10) / 10 : '?'} хп)` : `разгон копьём — мимо (${ch.why || 'время'})`)
      return NEXT
    }
    if (now - ctx.lastSwing < 250 && r <= HIT_REACH && bestWeapon(bot)) {
      st.spearSwaps = (st.spearSwaps || 0) + 1
      used('копьё → меч сразу после укола: он в руке меча')
      await holdWeapon()
      return NEXT
    }
    if (sj.ok && sReady === 0 && strikeWait(now, ctx.targetHurtAt, ctx.strikeSlot || 0) === 0) {
      if (guard) await guard.raise(false)
      ctx.aim = 'free'
      const j = await spear.jab(bot, ctx.entity)
      ctx.aim = 'target'
      if (j.ok) { st.swings++; ctx.lastSwing = gameClock.now(); used('укол копьём') }
      await ctx.sleep(TICK_MS)
      return NEXT
    }
    // Укол не проходит (край ямы или блок между нами — он ниже): держать его копьём на 3.4–4.5 бессмысленно — бот стоял над ямой
    // по 6–15 с без удара (стенд бота-противника 22.10). Секунда без пути укола — копьё в сторону на 5 с: ближе другим оружием
    // (подъём, спуск, столб — у остальных веток).
    if (!sj.ok && !sj.far && !sj.close) {
      ctx.spearBlockedAt ??= now
      if (now - ctx.spearBlockedAt > 1000) {
        ctx.spearOffUntil = now + 5000; ctx.spearBlockedAt = null
        if (bestWeapon(bot)) await holdWeapon()
        used(`копьё в сторону: укол не проходит (${sj.why || '?'})`)
        return NEXT
      }
    } else ctx.spearBlockedAt = null
    const wantR = sReady < 250 ? 3.8 : 4.2
    const fwdS = r > wantR && stepSafe(bot, keyDir(bot, 'forward'))
    const backS = r < 3.4 && stepSafe(bot, keyDir(bot, 'back'))
    strafeStep()
    set('forward', fwdS)
    set('back', backS && !fwdS)
    set('left', ctx.strafeKey === 'left' && stepSafe(bot, keyDir(bot, 'left')))
    set('right', ctx.strafeKey === 'right' && stepSafe(bot, keyDir(bot, 'right')))
    set('sprint', fwdS && r > 5 && (bot.food ?? 20) > 6)
    set('jump', false)
    if (ready('spearNote')) { rest('spearNote', 5000); used('копьё: держу его на 3.4–4.5, дальше его меча') }
    await ctx.sleep(TICK_MS)
    return NEXT
  }
}
