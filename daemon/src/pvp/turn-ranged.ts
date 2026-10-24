import * as arrows from '../arrows'
import * as assess from '../assess'
import { DRAW_MS as BOW_DRAW_MS, shoot as bowShoot } from '../bow'
import { pickFiller } from '../build'
import * as gameClock from '../game-clock'
import { bestWeapon } from '../items'
import * as mace from '../mace'
import { keyDir } from '../moves'
import * as ranged from '../ranged'
import * as read from '../read'
import * as tempo from '../tempo'
import { digStepSafe, reachFrom, stepSafe } from './body'
import { findItem } from './potions'
import { EYE, FAR, FIX, HIT_REACH, TICK_MS, cooldownMs } from './rules'
import { NEXT, type DuelCtx, type TurnFrame } from './turn'

function rangedStep (ctx: DuelCtx, changes) {
  const keys: Record<string, boolean> = {}
  for (const k of ['forward', 'back', 'left', 'right']) {
    keys[k] = changes[k] ?? ctx.bot.getControlState(k)
    if (keys[k] && (!stepSafe(ctx.bot, keyDir(ctx.bot, k)) || !digStepSafe(ctx, keyDir(ctx.bot, k)))) keys[k] = false
  }
  const f = keyDir(ctx.bot, keys.forward ? 'forward' : keys.back ? 'back' : ''), s = keyDir(ctx.bot, keys.left ? 'left' : keys.right ? 'right' : '')
  const n = Math.hypot(f.x + s.x, f.z + s.z)
  if (n && !digStepSafe(ctx, { x: (f.x + s.x) / n, z: (f.z + s.z) / n })) for (const k of Object.keys(keys)) keys[k] = false
  for (const k of Object.keys(keys)) ctx.set(k, keys[k])
  if (!keys.forward) ctx.set('sprint', false)
}

// Подобрать стрелы.
export async function arrowPickupTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { bot, ctl, holdWeapon, maceNow, pathTo, punishable, routeInputs, used } = ctx
  const { busyFoe, hp, pressing } = turn
  if (!ctx.fort && !ctx.perch && !(FIX && (pressing || punishable())) && bot.inventory.items().some(i => i.name === 'bow' || i.name === 'crossbow')) {
    const lying = arrows.plan(bot, { enemy: ctx.entity, busy: busyFoe, hp })
    const arrowRunInputs = lying && [lying.id ?? lying.entity?.id, lying.position ?? lying.entity?.position, routeInputs()].join('|')
    if (lying && (!ctx.failedArrowRun || ctx.failedArrowRun.inputs !== arrowRunInputs)) {
      if (ctx.pathing) { pathTo(false); ctx.pathing = false }
      // И прицел: aimTimer каждый тик разворачивает голову к нему, а
      ctx.aim = 'free'
      const run = await arrows.collect(bot, ctl, {
        target: lying,
        safe: dir => stepSafe(bot, dir),
        abortIf: () => (ctx.entity.isValid && ctx.entity.position.distanceTo(bot.entity.position) < 5) || (FIX && maceNow())
      }).finally(() => { ctx.aim = 'target' })
      ctx.failedArrowRun = run.got ? null : { inputs: arrowRunInputs, why: run.why || 'arrow_not_collected' }
      if (run.got) used(`подобрал стрелы ×${run.got}`)
      else if (run.moved) used(`сбегал за стрелой — ${run.why === 'собрал' ? 'её уже нет' : run.why}`)
      if (run.moved) { await holdWeapon(); return NEXT }
    }
  }
}

// Арбалет: урон, план, зарядка и стрельба, дистанция.
export async function crossbowTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { attackers, blockedShotTargets, bot, co, coverFrom, ctl, duo, foe, foeEst, fortSealed, guard, hazardOnLine, holdWeapon, maceNow, miningProgress, pathTo, rangedAllowed, ready, rest, sawRelease, set, shotInputs, shotReady, st, strafeStep, tt, used } = ctx
  const { blocking, d, hp, me, meInWeb, r, seesBody, theirR, theyBow, theyUp } = turn
  const xbAmmo = !!(findItem(bot, i => /arrow$/.test(i.name)) || findItem(bot, i => i.name === 'firework_rocket'))
  const shotDmg = ctx.prof.player ? Math.max(ranged.expectedDamage(bot, ctx.entity, 'arrow'), ranged.rocketsOf(bot) ? ranged.expectedDamage(bot, ctx.entity, 'firework') : 0) : 9
  turn.meleeDmg = 0
  if (ctx.prof.player) {
    try {
      const w = bestWeapon(bot)
      const WEAPON = require('../totem').WEAPON
      let raw = ((w && WEAPON[w.name]) || 1) * 1.5
      const sharp = w ? read.enchLevel(bot, w, 'sharpness') : 0
      if (sharp > 0) raw += 1 + 0.5 * (sharp - 1)
      const armorE = (ctx.entity.equipment || []).slice(2)
      const g = assess.gearOf(armorE)
      const epfM = Math.min(20, armorE.reduce((n, it) => n + (it ? read.enchLevel(bot, it, 'protection') : 0), 0))
      turn.meleeDmg = assess.afterArmor(raw, g.armor, g.tough) * (1 - epfM / 25)
    } catch {}
  }
  const blockedLong = turn.blockedLong = r > HIT_REACH && !miningProgress() &&
    (!stepSafe(bot, keyDir(bot, 'forward')) || !!hazardOnLine() || !!ctx.failedReposition || !!ctx.failedFlank)
  const arrowsWeak = turn.arrowsWeak = ctx.prof.player && !blockedLong && (shotDmg < 0.8 || shotDmg < 0.4 * turn.meleeDmg) && !!findItem(bot, i => /_(sword|axe)$/.test(i.name) || i.name === 'mace')
  if (arrowsWeak && ready('arrowsWeakNote')) { rest('arrowsWeakNote', 8000); used('стрелы его почти не берут — в ближний бой') }
  const xbKite = ctx.prof.player && !arrowsWeak && !meInWeb && !ctx.perch && !ctx.fort && !theyUp && !turn.punRush && !ctx.rushActive && xbAmmo &&
    d >= 4.5 && d <= 24 && !duo.active() && !!findItem(bot, i => i.name === 'crossbow') && ranged.crossbowFirst(bot) &&
      !findItem(bot, i => i.name === 'mace') && (blockedShotTargets.xbow == null || shotReady('xbow')) &&
      (!ctx.failedXbow || ctx.failedXbow.inputs !== shotInputs())
  const hisShield = !!((ctx.entity.equipment && ctx.entity.equipment[1] && ctx.entity.equipment[1].name === 'shield') || blocking)
  const xbLoadSafe = (ms) => {
    if (gameClock.now() - tt.myHurtAt < 300) return false
    const gap = Math.max(0, theirR - tempo.PLAYER_REACH)
    return (gap / tempo.SPRINT_BPT) * TICK_MS >= ms - 250
  }
  if (rangedAllowed() && ctx.prof.player && !meInWeb && findItem(bot, i => i.name === 'crossbow')) {
    // «Добиваю» (ranged.plan) — по верху оценки его хп, не по метаданным.
    const fsX = co.isPlayer(ctx.entity) ? { ...foe.state(ctx.entity), ehp: foeEst().hi } : foe.state(ctx.entity)
    const hisMain = ctx.entity.equipment && ctx.entity.equipment[0] ? ctx.entity.equipment[0].name : ''
    const vX = ctx.track.vel()
    const xCtx = {
      entity: ctx.entity, d, r, sees: seesBody, hp, fs: fsX, busy: tt.state(ctx.entity), allIn: foe.allIn(ctx.entity),
      kite: xbKite, hisShield, theyDraw: theyBow, weak: arrowsWeak,
      safe: (ms) => (xbKite ? xbLoadSafe(ms) : tt.safe(ms, { fortSealed: fortSealed() }).ok),
      shieldAtUs: mace.shieldAtUs(bot, ctx.entity),
      others: [...attackers.values()].filter(a => gameClock.now() - a.at < 8000).map(a => a.e),
      opening: !ctx.firstHitDone, rushing: turn.punRush || ctx.rushActive,
      totemOff: !!(bot.inventory.slots[45] && bot.inventory.slots[45].name === 'totem_of_undying'),
      velFn: () => ctx.track.vel(),
      abortIf: () => gameClock.now() - tt.myHurtAt < 300 || (ctx.entity.isValid && reachFrom(ctx.entity.position.offset(0, EYE, 0), bot.entity) <= tempo.PLAYER_REACH + 0.5) || (FIX && maceNow()),
      onLoadTick: () => {
        strafeStep()
        set('forward', false); set('sprint', false)
        rangedStep(ctx, { left: ctx.strafeKey === 'left', right: ctx.strafeKey === 'right' })
      },
      arrowCtx: {
        d, fs: fsX, player: true,
        running: (vX.x * (ctx.entity.position.x - me.x) + vX.z * (ctx.entity.position.z - me.z)) / Math.max(d, 0.1) > 0.12,
        strongHitter: fsX.effects && fsX.effects.has('strength') || /_axe$|^mace$|^netherite_sword$/.test(hisMain)
      }
    }
    const xPlan = ranged.plan(bot, xCtx)
    let xb = null
    if (xPlan && (!ctx.failedXbow || ctx.failedXbow.inputs !== shotInputs()) &&
        (xPlan.act === 'load' || xPlan.info.ammo === 'firework' || shotReady('xbow', BOW_DRAW_MS, xPlan.point))) {
      if (guard) await guard.raise(false)
      pathTo(false); ctx.pathing = false
      ctx.aim = 'free'
      xb = await ranged.step(bot, ctl, xCtx, { used, holdWeapon, stats: st.xbow || (st.xbow = {}), planned: xPlan })
      ctx.aim = 'target'
      ctx.failedXbow = xb?.ok ? null : { inputs: shotInputs(), why: xb?.why || 'crossbow_action_unconfirmed' }
    }
    if (xb && xb.did === 'fire' && xb.ok) {
      delete blockedShotTargets.xbow
      ctx.nextReady = Math.max(ctx.nextReady, gameClock.now() + cooldownMs(bot.heldItem))
      return NEXT
    }
    if (xb && xb.did === 'load' && xb.ok) return NEXT
    xbowShotBlocked(ctx, xb)
  }
  if (xbKite) {
    if (ctx.pathing) { pathTo(false); ctx.pathing = false }
    const loadedX = ranged.crossbows(bot).some(x => x.info.loaded)
    const vK = ctx.track.vel()
    const toMeK = (vK.x * (me.x - ctx.entity.position.x) + vK.z * (me.z - ctx.entity.position.z)) / Math.max(d, 0.1)
    if (!loadedX && toMeK > 0.12 && d < 9 && !xbLoadSafe(10 * TICK_MS + 350) && pickFiller(bot)) {
      const put = await coverFrom(ctx.entity.position, { what: 'арбалет: стенка между нами — заряжаю за ней' })
      if (put) { await holdWeapon(); return NEXT }
    }
    if (guard && guard.stats && guard.stats.worn) {
      if (theyBow && !loadedX && seesBody) { guard.raise(true); if (ready('bowShieldNote')) { rest('bowShieldNote', 4000); used('щит от стрелы') } } else guard.raise(false)
    }
    strafeStep()
    if (sawRelease()) { strafeStep(1.5, true); st.dodges++; used('ушёл с линии выстрела') }
    const backK = (toMeK > 0.03 || d < 7) && stepSafe(bot, keyDir(bot, 'back')) && digStepSafe(ctx, keyDir(bot, 'back'))
    const fwdK = d > 14 && !backK && stepSafe(bot, keyDir(bot, 'forward')) && digStepSafe(ctx, keyDir(bot, 'forward'))
    rangedStep(ctx, { forward: fwdK, back: backK, left: ctx.strafeKey === 'left', right: ctx.strafeKey === 'right' })
    set('sprint', bot.getControlState('forward') && (bot.food ?? 20) > 6); set('jump', false)
    if (ready('xbKiteNote')) { rest('xbKiteNote', 5000); used('арбалет: держу дистанцию, заряжаю и стреляю') }
    await ctx.sleep(TICK_MS)
    return NEXT
  }
}

// Лук: дальность, цена близкого выстрела, застой, выстрел.
export async function bowTurn (ctx: DuelCtx, turn: TurnFrame) {
  const { blockedShotTargets, bot, clear, co, ctl, cx, foe, foeEst, guard, heldName, holdWeapon, maceNow, miningProgress, pathTo, rangedAllowed, ready, rest, sawRelease, set, shotInputs, shotReady, st, strafeStep, switched, tt, used } = ctx
  const { arrowsWeak, blockedLong, blocking, cooldownLeft, d, dy, hp, me, meInWeb, now, r, seesBody, theirR, theyUp } = turn
  const noMelee = turn.noMelee = !findItem(bot, i => /_(sword|axe)$/.test(i.name))
  const bowRange = ctx.theirPit ? 1.2 : theyUp ? 1.5 : noMelee ? 2.5 : ctx.perch ? 3 : ctx.prof.player ? FAR : ctx.prof.ranged ? 12 : 6
  const bowItem = turn.bowItem = rangedAllowed() ? findItem(bot, i => i.name === 'bow') : null
  const arrowItem = turn.arrowItem = findItem(bot, i => /arrow$/.test(i.name))
  const dBow = ctx.prof.flying || theyUp ? me.distanceTo(ctx.entity.position) : d
  const sees = turn.sees = seesBody
  // Неудачный подход не делает видимую цель в 4–7 блоках недоступной луку.
  // Сравниваем выстрел с доступным сейчас ударом и ценой занятой руки: только
  // видимое сближение, наша недавняя боль и видимое оружие, без точного его HP.
  const closeBowWorth = (ms) => {
    const o = co.observe(bot, ctx.entity, { tracker: ctx.calc })
    const gap = Math.max(0, reachFrom(ctx.entity.position.offset(0, EYE, 0), bot.entity) - tempo.PLAYER_REACH)
    const recent = gameClock.now() - tt.myHurtAt < tempo.HURT_WINDOW_MS
    const arrive = recent || gap === 0 ? 0 : o.foe.approach > 0 ? gap / o.foe.approach * TICK_MS : Infinity
    const exposed = Math.max(0, ms - arrive)
    const hand = o.foe.main
    const dm = require('./damage-model')
    const hit = dm.afterDefense(dm.meleeRaw({ weapon: hand?.name, sharpness: hand?.ench?.sharpness || 0,
      strength: o.foe.effects.strength ? 0 : -1, crit: true }), 'melee', dm.defenseOf(o.me.armor, { resistance: o.me.resistance }))
    const self = exposed > 0 ? hit * (1 + Math.floor(exposed / tempo.swingCooldownMs(hand?.name))) : 0
    const availableMelee = o.dist <= HIT_REACH ? turn.meleeDmg : 0
    const defense = dm.defenseOf(o.foe.armor, { resistance: o.foe.resistance })
    const gain = dm.arrowOutcomes({ speed: dm.arrowSpeedAt(3, dBow), power: read.enchLevel(bot, bowItem, 'power'), crit: true })
      .reduce((sum, a) => sum + a.p * dm.afterDefense(a.raw, 'projectile', defense), 0)
    return self < o.me.ehp && gain > self + availableMelee
  }
  const closeBow = !!bowItem && !!arrowItem && sees && ctx.prof.player && dBow < (turn.punBow ? 5 : bowRange) && blockedLong && r > HIT_REACH && !miningProgress() && closeBowWorth(BOW_DRAW_MS)
  if (process.env.ND_DEBUG_PVP && now - (st.dbgAt || 0) > 1000) {
    st.dbgAt = now
    console.log('[pvp]', JSON.stringify({ t: ctx.label, d: Math.round(d * 10) / 10, dBow: Math.round(dBow * 10) / 10, dy: Math.round(dy), hp: Math.round(hp), r: Math.round(r * 10) / 10, theirR: Math.round(theirR * 10) / 10, cd: cooldownLeft, iframes: Math.max(0, ctx.targetHurtAt + 500 - now), blocking, meInWeb, pathing: ctx.pathing, held: heldName(), swings: st.swings, bow: !!bowItem, arrows: !!arrowItem, sees, range: bowRange, ready: ready('bow'), flying: !!ctx.prof.flying }))
  }
  // Стрелы не обгоняют его лечение (S7d, s7d-e-29p «только якоря»: 5 ничьих из 5 — 7 мин перестрелки на 20–47 бл.,
  // попадание 1.6–2.5 раз в 3–5 с, а у него регенерация и 12 яблок): за последние 20 с стрельбы (≥ 4 выстрела) моя
  // оценка его хп (середина: попадания вниз, его видимое лечение и регенерация в границах насыщения вверх) не
  // опустилась хоть на 1 — лук не двигает бой, сближаюсь (якорь, кристалл, ближний). На исходе (верх ≤ 8) — стреляю.
  let arrowsStall = false
  if (ctx.prof.player && dBow > 8 && !!findItem(bot, i => /_(sword|axe)$/.test(i.name) || i.name === 'mace')) {
    try {
      const eB = foeEst()
      const pr = st.bowProg || (st.bowProg = [])
      if (!pr.length || now - pr[pr.length - 1].at > 1000) pr.push({ at: now, mean: eB.mean, shots: st.arrows || 0, apples: ctx.calc.seenApples || 0 })
      while (pr.length > 2 && now - pr[1].at >= 20000) pr.shift()
      const old = pr[0]
      // Увиденные съеденные им яблоки — тоже прогресс лука (ревью Codex): стрелы заставили тратить запас.
      if (now - old.at >= 20000 && (st.arrows || 0) - old.shots >= 4) arrowsStall = eB.hi > 8 && eB.mean > old.mean - 1 && (ctx.calc.seenApples || 0) === old.apples
    } catch {}
    if (arrowsStall && ready('arrowsStallNote')) { rest('arrowsStallNote', 8000); st.arrowsStall = (st.arrowsStall || 0) + 1; used('стрелы не обгоняют его лечение — сближаюсь') }
  }
  const bowPointless = (arrowsWeak || arrowsStall || cx.dominant()) && !theyUp && !ctx.perch && !ctx.theirPit
  const fsB = ctx.prof.player && bowItem && arrowItem ? (co.isPlayer(ctx.entity) ? { ...foe.state(ctx.entity), ehp: foeEst().hi } : foe.state(ctx.entity)) : null
  const vB = ctx.track.vel()
  const hisBowHand = ctx.entity.equipment && ctx.entity.equipment[0] ? ctx.entity.equipment[0].name : ''
  const bowContext = fsB && {
    d: dBow, fs: fsB, player: true,
    running: (vB.x * (ctx.entity.position.x - me.x) + vB.z * (ctx.entity.position.z - me.z)) / Math.max(d, 0.1) > 0.12,
    heavyArmor: assess.gearOf((ctx.entity.equipment || []).slice(2)).armor >= 15,
    strongHitter: (fsB.effects && fsB.effects.has('strength')) || /_axe$|^mace$|^netherite_sword$/.test(hisBowHand)
  }
  const bowArrow = bowContext && ranged.pickArrow(bot, bowContext)
  const bowDrawMs = bowArrow?.harm ? ranged.harmDrawMs(dBow) || BOW_DRAW_MS : BOW_DRAW_MS
  if (bowItem && arrowItem && !bowPointless && (dBow >= (turn.punBow ? 5 : bowRange) || closeBow) && dBow < (ctx.prof.flying ? 64 : 48) && shotReady('bow', bowDrawMs) && sees && !turn.punRush && !ctx.rushActive && !(ctx.prof.player && ranged.crossbowFirst(bot)) &&
      (!ctx.failedBow || ctx.failedBow.inputs !== shotInputs())) {
    if (guard) await guard.raise(false)
    pathTo(false); ctx.pathing = false
    clear()
    const before = heldName()
    ctx.aim = 'free'
    const closeAt = theyUp ? 0 : ctx.prof.player ? 5 : 3.5
    let prepB = { drawMs: null, why: null }
    if (ctx.prof.player) {
      prepB = await ranged.prepBow(bot, bowContext).catch(() => ({ drawMs: null, why: null }))
      if (prepB.why) used('стрела: ' + prepB.why)
    }
    let drawnMs = 0
    const shot = await bowShoot(bot, ctx.entity, {
      velFn: () => ctx.track.vel(),
      follow: false,
      drawMs: prepB.drawMs || undefined,
      holdWhile: ctx.prof.player ? () => mace.shieldAtUs(bot, ctx.entity) : null,
      onHit: () => { st.arrowHits = (st.arrowHits || 0) + 1 },
      shouldStop: () => ctl.aborted || (closeBow ? !closeBowWorth(Math.max(TICK_MS, (prepB.drawMs || BOW_DRAW_MS) - drawnMs)) : ctx.entity.position.distanceTo(bot.entity.position) < closeAt) ||
        (Object.values(bot.entities) as any[]).some((e : any) => e && e.name === 'fireball' && e.position && e.position.distanceTo(bot.entity.position) < 7) || (theyUp && reachFrom(bot.entity.position.offset(0, EYE, 0), ctx.entity) <= HIT_REACH) || (FIX && maceNow()),
      onDraw: (ms) => {
        drawnMs = ms
        ctx.track.update()
        if (sawRelease()) { strafeStep(1.5, true); st.dodges++; used('ушёл с линии выстрела') }
        strafeStep()
        const v = ctx.track.vel()
        const mp = bot.entity.position
        const dist = Math.max(0.1, mp.distanceTo(ctx.entity.position))
        const toMe = (v.x * (mp.x - ctx.entity.position.x) + v.z * (mp.z - ctx.entity.position.z)) / dist
        rangedStep(ctx, { left: ctx.strafeKey === 'left', right: ctx.strafeKey === 'right', back: toMe > 0.05 || !ctx.prof.player })
      }
    })
    clear()
    ctx.aim = 'target'
    switched(before)
    ctx.failedBow = shot.shot || shot.blocked ? null : { inputs: shotInputs(), why: shot.why || 'arrow_unconfirmed' }
    if (shot.shot) { delete blockedShotTargets.bow; used('выстрел из лука'); st.arrows = (st.arrows || 0) + 1 }
    bowShotBlocked(ctx, shot)
    await holdWeapon()
    return NEXT
  }
}

// Стрела упёрлась в стену: лук по этой цели — до смены геометрии (shotReady), обход.
export function bowShotBlocked (ctx: DuelCtx, shot) {
  const { blockedShotTargets, bot, st, used } = ctx
  if (shot.blocked) {
    blockedShotTargets.bow = ctx.entity.id
    ctx.reposition = { from: bot.entity.position.clone(), at: gameClock.now(), target: ctx.entity.id }
    if (!st.blockedShots) used('стена на линии — обхожу')
    st.blockedShots = (st.blockedShots || 0) + 1
  }
}

// Болт упёрся в стену: арбалет по этой цели — до смены геометрии.
export function xbowShotBlocked (ctx: DuelCtx, xb) {
  if (xb && xb.blocked) ctx.blockedShotTargets.xbow = ctx.entity.id
}
