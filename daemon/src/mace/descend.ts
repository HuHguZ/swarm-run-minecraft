// Булава (mace.ts): спуск на цель с ударом в последний тик досягаемости, отрулить от огня, второй заряд под ноги,
// отскок Wind Burst и следующая цель.
import * as gameClock from '../game-clock'
import { Vec3 } from './world'
import * as pick from '../pick'
import { REACH, SMASH_MIN, SWAP, KEYS, yawTo } from './consts'
import { findItem, healthOf, slamHit, afterPacket, windReady, fireWind, selfWindAim } from './hands'
import { reachFrom, floorTop, landing, NO_KEYS, AIR_KEYS, fallCost } from './world'
import { supportAt } from '../navigation/geometry'

/** Steer to the near side of the target, subtracting the body's own coasting distance. */
export function descentSteering(p, v, target, motion, lastYaw) {
  let ticks = 0, y = p.y, vy = v.y
  while (ticks < 40 && !(vy < 0 && y <= target.y + 1)) { y += vy; vy = (vy - .08) * .98; ticks++ }
  ticks = Math.max(1, ticks)
  const dh = Math.hypot(target.x - p.x, target.z - p.z)
  const yaw = dh > .25 ? yawTo(p, target) : lastYaw
  const sin = Math.sin(yaw), cos = Math.cos(yaw)
  const drift = (1 - .91 ** ticks) / .09
  const dx = target.x + motion.x * ticks + sin * .6 - (p.x + v.x * drift)
  const dz = target.z + motion.z * ticks + cos * .6 - (p.z + v.z * drift)
  const forward = -dx * sin - dz * cos, right = dx * cos - dz * sin
  return { yaw, dh, keys: { ...NO_KEYS, forward: forward > .3, back: forward < -.3, right: right > .3, left: right < -.3 } }
}

// Спуск на цель: рулить в воздухе к точке, где он будет, и ударить булавой в
// последний тик, когда ещё достаём (дальше — земля или он выйдет из руки):
// бонус растёт с высотой. Своей скоростью по вертикали и сносом по
// горизонтали считаем, где окажемся; клавиши — относительно взгляда на него.
// Без спринта: спринт снимает крит.
export function descend (bot, ctl, e, { vel = () => ({ x: 0, y: 0, z: 0 }), swap = SWAP, maxMs = 3500, windMlg = true, stats = null, telemetryHp = e => healthOf(bot, e), chain = null, initialHit = null, ready = null, upperApproach = false }: any = {}) {
  return new Promise<any>(resolve => {
    const t0 = gameClock.now()
    let peak = bot.entity.position.y
    let fallPeak = peak, endAt = t0 + maxMs, rebounding = false, choiceAt = 0, relocation = null
    const hits = initialHit ? [initialHit] : []
    const burst = chain && (require('../read') as typeof import('../read')).enchLevel(bot, findItem(bot, 'mace'), 'wind_burst') > 0
    let hit = initialHit
    let done = false
    let lastYaw = bot.entity.yaw
    let lastPos = bot.entity.position.clone()
    let mlgFired = false
    const floorView = upperApproach && (require('../pvp/search') as typeof import('../pvp/search')).observedCollision(bot)
    const landingOptions = upperApproach ? { observed: true, arena: chain?.arena } : undefined
    const set = (k, v) => { try { bot.setControlState(k, v) } catch {} }
    // Сторож ведра (edges.installFallGuard) видит спуск и бросает воду только в
    // последний тик, а наш удар этого тика делает первым (bot._ndSmashNow) —
    // раньше ведро отнимало руку и взгляд посреди спуска (2026-09-26).
    const mark = { at: t0 }
    bot._ndDescend = mark
    let burnNext = 0
    let burnPlan = null
    const burnSteer = () => {
      const now = gameClock.now()
      if (now < burnNext) return burnPlan
      burnNext = now + 100
      if (bot.entity.onGround || bot.entity.isInWater) return (burnPlan = null)
      const cur = { ...NO_KEYS }
      for (const k of ['forward', 'back', 'left', 'right']) cur[k] = bot.getControlState(k)
      const here = landing(bot, cur, landingOptions)
      if (!here || !here.burn) return (burnPlan = null)
      let best = null
      for (const c of AIR_KEYS) {
        const l = landing(bot, c, landingOptions)
        if (!l || l.burn) continue
        const d = e && e.position ? Math.hypot(l.at.x - e.position.x, l.at.z - e.position.z) : 0
        if (!best || d < best.d) best = { keys: c, d }
      }
      if (stats && !burnPlan) { if (best) stats.burnDodge = (stats.burnDodge || 0) + 1; else stats.burnNoWay = (stats.burnNoWay || 0) + 1 }
      burnPlan = best ? { keys: best.keys } : { keys: null, none: true }
      return burnPlan
    }
    const finish = (why) => {
      if (done) return
      done = true
      bot.removeListener('physicsTick', onT)
      if (bot._ndDescend === mark) {
        bot._ndDescend = null
        for (const k of KEYS) set(k, false)
      }
      resolve({ peak, hit: hits[0] || hit, hits, why, relocated: !!relocation, ms: gameClock.now() - t0 })
    }
    // При промахе или потере цели спуск всё ещё может кончиться уроном от падения.
    const tryWindLanding = (p, v, top, moved) => {
      const w = bot._ndWind
      const h = p.y - top
      const hurtFall = w && gameClock.now() < w.until ? (w.impactY - top) : (fallPeak - top)
      if (windMlg && !mlgFired && v.y < -0.35 && hurtFall > 3.6 && h > 1.0 && h < 3.2 && !findItem(bot, 'water_bucket') && windReady(bot)) {
        mlgFired = true
        fireWind(bot, () => !ctl.aborted && selfWindAim(bot, { moved }), { swap: true, immediate: true }).then((r : any) => {
          if (r.fired) { bot._ndWind = { impactY: bot.entity.position.y, until: gameClock.now() + 2000 }; if (stats) stats.mlg++ }
          else mlgFired = false
        })
      }
    }
    const onT = () => {
      try {
        if (done) return
        if (bot._ndDescend !== mark || ctl.aborted || !bot.entity || (bot.health ?? 0) <= 0) return finish('прервали')
        const b = bot.entity
        const p = b.position
        const moved = p.minus(lastPos); lastPos = p.clone()
        if (p.y > peak) peak = p.y
        fallPeak = Math.max(fallPeak, p.y)
        // The landing packet may precede Wind Burst by several server ticks.
        if (b.onGround && gameClock.now() - t0 > 120 && !(hit && burst && gameClock.now() - hit.at < 500)) return finish(hit ? 'сел после удара' : 'сел')
        if (b.isInWater) return finish('в воде')
        if (gameClock.now() > endAt || chain?.deadline && gameClock.now() >= chain.deadline) return finish('долго')
        const v = b.velocity
        // Only the next step for the swing, or a charge within 3.2 blocks of touchdown, needs a floor here.
        const top = floorView ? supportAt(floorView, p, Math.max(3.2, .05 - v.y))?.top ?? -Infinity : floorTop(bot, p)
        // The first wind-assisted flight can lose its original target before any smash.
        if (chain && !hit && e && (e.isValid === false || e._ndVisible === false)) { e = null; choiceAt = 0 }
        // Посадка в лаву или огонь (2026-09-26): он вылил лаву или поджёг
        // место, куда мы сядем, пока летим, — рулить прочь (в воздухе клавиши
        // дают ~0.02 б/т², за 10–20 тиков до блока в сторону). Раз в 100 мс
        // прогон физики до земли с нынешними клавишами; в огонь — восемь
        // сторон, берём ту, где посадка чистая и ближе к нему. Удар — как был:
        // клавиши ему не нужны.
        const burn = e ? burnSteer() : null
        const applyBurn = () => { for (const k of ['forward', 'back', 'left', 'right']) set(k, !!burn.keys[k]); set('sprint', false); set('jump', false) }
        if (hit) {
          if (burn && burn.keys) applyBurn()
          else for (const k of KEYS) set(k, false)
          const hp = telemetryHp(e)
          if (hp != null && (hit.hpMin == null || hp < hit.hpMin)) hit.hpMin = hp
          if (!burst || v.y <= .15 || gameClock.now() - hit.at > 700) return
          rebounding = true; fallPeak = p.y; hit = null; choiceAt = 0
          endAt = Math.min(chain.deadline ?? Infinity, gameClock.now() + maxMs)
          if (stats) stats.rebounds = (stats.rebounds || 0) + 1
        }
        // A visible first target can pearl away too. Reprice from the actual flight, preserving a smash already in hand.
        const reconsider = chain && (rebounding || !e || e.username) && gameClock.now() >= choiceAt
        if (reconsider) choiceAt = gameClock.now() + 200
        const firstSmashNow = reconsider && !rebounding && e && v.y < 0 && fallPeak - p.y > SMASH_MIN + .1 &&
          reachFrom(pick.eyeOf(bot), e, bot) <= REACH - .05 && pick.canHit(bot, e, { range: REACH })
        if (reconsider && !firstSmashNow) {
          const next = chain.choose(fallPeak)
          if (next) {
            e = next.entity; vel = next.vel || (() => ({ x: 0, y: 0, z: 0 })); relocation = null
            chain.onTarget?.(next)
          } else {
            e = null
            let best = null
            for (const keys of AIR_KEYS) {
              const l = landing(bot, keys, { maxTicks: 120, observed: true, arena: chain.arena })
              if (!l?.landed || l.burn) continue
              const damage = fallCost(bot, l.at, Math.max(fallPeak, l.peak), l.floor)
              const remaining = (bot.health ?? 20) - damage
              if (!(remaining > 0)) continue
              // Бережём последние два сердца. Если запаса уже нет, всё ещё можно сесть без урона.
              const reserve = Math.min(4, remaining)
              const score = l.at.y * 2 - damage * 8 - (chain.home ? l.at.distanceTo(new Vec3(chain.home.x, chain.home.y, chain.home.z)) : 0)
              if (!best || reserve > best.reserve || reserve === best.reserve && score > best.score) best = { keys, reserve, score, at: l.at }
            }
            relocation = best
          }
        }
        if (!e) {
          for (const k of KEYS) set(k, !!relocation?.keys[k])
          tryWindLanding(p, v, top, moved)
          return
        }
        if (!e.isValid) {
          if (burn && burn.keys) applyBurn()
          else for (const k of KEYS) set(k, false)
          tryWindLanding(p, v, top, moved)
          return
        }
        const tv = vel() || { x: 0, y: 0, z: 0 }
        const ep = e.position
        const { yaw, dh, keys } = descentSteering(p, v, ep, tv, lastYaw)
        lastYaw = yaw
        const pitch = Math.atan2(ep.y + pick.hitboxOf(bot, e).h / 2 - pick.eyeOf(bot).y, Math.max(0.3, dh))
        bot.look(yaw, pitch, true).catch(() => {})
        for (const key of KEYS) set(key, keys[key])
        if (burn && burn.keys) applyBurn()
        // Удар: падаем, высота падения > 1.5, достаём — и дальше не будет
        // лучше: на следующем тике земля или он вне руки.
        const fall = fallPeak - p.y
        const eye = pick.eyeOf(bot)
        const rNow = reachFrom(eye, e, bot)
        const pNext = p.plus(v)
        const rNext = reachFrom(pNext.offset(0, pick.eyeHeight(bot), 0), { ...e, position: ep.offset(tv.x, tv.y || 0, tv.z) }, bot)
        const landNext = v.y < 0 && pNext.y <= top + 0.05
        if (process.env.ND_DEBUG_MACE) console.log('[mace]', JSON.stringify({ t: gameClock.now() - t0, y: +(p.y - top).toFixed(2), vy: +v.y.toFixed(3), fall: +(peak - p.y).toFixed(2), r: +rNow.toFixed(2), rN: +rNext.toFixed(2), landNext, dh: +dh.toFixed(2), ey: +(ep.y - top).toFixed(2) }))
        // Удар — только если он под прицелом, как у клиента: сквозь крышу его
        // коробки или стенку сервер удар бы принял, а игрок так не может.
        // ready — цели ещё нет на месте (засада жемчуга: падаем в точку его появления) — рулим, но не бьём.
        if (v.y < 0 && fall > SMASH_MIN + 0.1 && (!ready || ready()) && rNow <= REACH - 0.05 && (landNext || rNext > REACH - 0.1 || fall > 14) && pick.canHit(bot, e, { eye, range: REACH })) {
          const hp0 = telemetryHp(e)
          hit = { fall: Math.round(fall * 100) / 100, r: Math.round(rNow * 100) / 100, hp0, at: gameClock.now(), charged: !!(bot._ndMaceHeldAt && gameClock.now() - bot._ndMaceHeldAt >= 1550), selfHp: bot.health ?? 20 }
          const doHit = () => {
            try {
              if (done || bot._ndDescend !== mark || ctl.aborted || e.isValid === false || chain?.visible?.(e) === false || !pick.canHit(bot, e, { range: REACH })) { hit = null; return }
              const sh = slamHit(bot, e, stats)
              if (sh.blocked) { hit = null; return }
              if (swap && sh.swapped) bot.setQuickBarSlot(sh.cur)
              hit.swapped = swap && sh.swapped
              hit.stun = sh.stun
              hit.targetId = e.id; hit.target = e.username || e.name; hits.push(hit)
              if (burst) endAt = Math.max(endAt, Math.min(chain.deadline ?? Infinity, hit.at + 700))
            } catch {}
          }
          bot._ndSmashNow = doHit
          afterPacket(bot, () => { if (bot._ndSmashNow === doHit) { bot._ndSmashNow = null; doHit() } })
          return
        }
        tryWindLanding(p, v, top, moved)
      } catch (err) { finish('ошибка: ' + err.message) }
    }
    bot.on('physicsTick', onT)
  })
}
