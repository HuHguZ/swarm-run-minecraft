import * as bowMod from '../bow'
import { DRAW_MS as BOW_DRAW_MS } from '../bow'
import * as edges from '../edges'
import * as gameClock from '../game-clock'
import * as melee from '../melee'
import { keyDir } from '../moves'
import * as pick from '../pick'
import * as ranged from '../ranged'
import * as totemMod from '../totem'
import { reachFrom, stepSafe, usingItem } from './body'
import { EYE, FIX, HIT_REACH, TICK_MS } from './rules'
import { type DuelCtx } from './turn'

// Шаг вбок: сторона меняется по пройденному поперёк пути или по небезопасной стороне.
export function installStrafe (ctx: DuelCtx) {
  const { bot } = ctx
  ctx.strafeKey = Math.random() < 0.5 ? 'left' : 'right'
  ctx.strafeFrom = bot.entity.position.clone()
  ctx.strafeAxis = keyDir(bot, ctx.strafeKey)
  ctx.strafeStep = (span = 1.5, turn = false) => {
    const p = bot.entity.position
    const across = Math.abs((p.x - ctx.strafeFrom.x) * ctx.strafeAxis.x + (p.z - ctx.strafeFrom.z) * ctx.strafeAxis.z)
    const flip = ctx.strafeKey === 'left' ? 'right' : 'left'
    if ((turn || across >= span || !stepSafe(bot, keyDir(bot, ctx.strafeKey))) && stepSafe(bot, keyDir(bot, flip))) {
      ctx.strafeKey = flip
      ctx.strafeFrom = p.clone()
      ctx.strafeAxis = keyDir(bot, ctx.strafeKey)
    }
    return ctx.strafeKey
  }
}

// Уклон с линии, выпуск его лука, ближний бой (melee.fight), тотем, ответный удар.
export function installMelee (ctx: DuelCtx) {
  const { bot, st, used, vision } = ctx
  ctx.sawRelease = () => {
    const using = usingItem(bot, ctx.entity)
    if (using === 'bow') { if (!ctx.theirDrawAt) ctx.theirDrawAt = gameClock.now(); return false }
    const shot = ctx.theirDrawAt && gameClock.now() - ctx.theirDrawAt > 350
    ctx.theirDrawAt = 0
    return !!shot
  }
  const mf = ctx.mf = melee.fight(bot, { target: () => ctx.entity, jumpOk: (e) => !(FIX && e && e.position && bot.entity && edges.dropAlong(bot, bot.entity.position.plus(bot.entity.position.minus(e.position)), 2.6)) })
  ctx.tot = totemMod.install(bot)
  ctx.use0 = bot._ndUse ? { ...bot._ndUse.stats } : null
  mf.setCounter((e) => {
    if (!ctx.prof.player || e?.id !== ctx.entity.id || !bot.entity || !vision.visible(ctx.entity)) return false
    e = ctx.entity
    if (reachFrom(bot.entity.position.offset(0, EYE, 0), e) > HIT_REACH) return false
    if (mf.clock.charge(0) <= 0.9 || usingItem(bot, e) === 'shield') return false
    const use = bot._ndUse
    if (use && (use.cur || gameClock.now() - (use.endedAt || 0) < mf.clock.msPerTick)) return false
    const sprintHit = mf.clock.srvSprint
    mf.hit(e, { after: sprintHit ? 'wtap' : null, kind: 'counter' })
    st.swings++
    ctx.lastSwing = gameClock.now()
    ctx.firstHitDone = true
    ctx.hitKind = null
    used('ответный удар на его удар')
    return true
  })
}

// Перезарядка приёмов и запрет выстрела в ту же заслонённую цель до смены геометрии.
export function installShotGate (ctx: DuelCtx) {
  const { blockedShotTargets, bot, cd, vision } = ctx
  ctx.ready = (k) => k === 'drinkCover' || k === 'fort' || gameClock.now() >= (cd[k] || 0)
  ctx.rest = (k, ms) => { if (k !== 'drinkCover' && k !== 'fort') cd[k] = gameClock.now() + ms }
  ctx.shotReady = (kind, drawMs = BOW_DRAW_MS, point = null) => {
    const target = blockedShotTargets[kind]
    if (target == null) return true
    if (target !== ctx.entity.id) return true
    if (ctx.prof.player && !vision.visible(ctx.entity)) return false
    const ticks = drawMs < BOW_DRAW_MS ? Math.max(2, Math.round(drawMs / TICK_MS) - 1) : 20
    const power = Math.min(1, (ticks * ticks / 400 + ticks / 10) / 3)
    const speed = kind === 'xbow' ? ranged.ARROW_SPEED : bowMod.SPEED * power
    const from = pick.eyeOf(bot).offset(0, -0.1, 0)
    const targetAt = point || bowMod.leadTarget(ctx.entity, () => ctx.track.vel(), bot)
    const sol = bowMod.aim(from, targetAt, speed, bowMod.GRAVITY)
    return !!sol && !bowMod.blockedAt(bot, from, sol, { x: 0, y: 0, z: 0 }, speed)
  }
}
