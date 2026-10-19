'use strict'
const gameClock: typeof import('./game-clock') = require('./game-clock')
// Элитры в бою (просьба 2026-09-26: «крылья … летать, убегать от соперника,
// лететь с высоты в него, обстреливать…»). Что умеет:
//  1. Полёт: взлёт (прыжок → «раскрыть» → фейерверк), управление одним
//     взглядом, набор высоты, круги под потолком арены, посадка без урона.
//  2. Уход с фейерверками на малом хп: подальше от него и повыше, глоток или
//     яблоко в воздухе, посадка там, где его нет.
//  3. Пике с булавой: сверху почти отвесно (щит сверху не держит), перед
//     ударом элитры — на нагрудник (полёт кончается, высота падения, набранная
//     в пике, остаётся) и удар с падения; мимо — элитры обратно и уйти в полёт.
//  4. Против летуна (крючки в pvp.js): не гоняться по земле, стрелять в его
//     рамку 0.6, щит или шаг из-под пике.
//
// Физика — своя, та же, что в игре (декомпиляция клиента 1.21.11,
// extremeheat/extracted_minecraft_data, ветка client1.21.11):
//  * world/entity/LivingEntity.travelFallFlying → updateFallFlyingMovement:
//    v.y += g·(−1 + 0.75·cos²θ); вниз — часть v.y уходит вперёд по взгляду;
//    взгляд вверх — горизонталь уходит в подъём (×3.2); горизонталь
//    поворачивается к взгляду на 10% за тик; ×(0.99, 0.98, 0.99), потом ход.
//    prismarine-physics (moveEntityWithHeading, ветка elytraFlying) считает
//    ровно так же — сверено построчно, и тело на тестовом Paper летит без
//    единого отката (elytra-probe 2026-09-26: 400 тиков, 0 forcedMove);
//  * world/entity/projectile/FireworkRocketEntity.tick: пока жив прицепленный
//    фейерверк, каждый тик v += взгляд·0.1 + (взгляд·1.5 − v)·0.5 — предел
//    1.7 б/т по взгляду; живёт 10·(1 + flight_duration) + rand(6) + rand(7)
//    тиков (обычная ракета — 20–31). Клиент игры разгоняется, пока сущность
//    фейерверка не пропала; mineflayer — по своей случайной оценке: здесь —
//    как у клиента (до entityGone);
//  * Entity.checkFallDistanceAccumulation (LivingEntity.updateFallFlying):
//    в полёте, пока v.y > −0.5, высота падения держится ≤ 1 — посадка из
//    планирования без урона; в пике (v.y < −0.5) копится как обычно. Замер
//    /data get fall_distance: пике 28 тиков — 31.3, выход в планирование —
//    через 4 тика снова 1.36 (elytra-probe dive);
//  * LivingEntity.handleFallFlyingCollisions: удар о стену в полёте —
//    (горизонталь до − после)·10 − 3 урона (fly_into_wall): 1.7 б/т — 14 хп;
//  * world/entity/Avatar.POSES: FALL_FLYING — рамка 0.6×0.6, глаза 0.4:
//    сервер меряет от них руку и выпускает стрелу. prismarine двигает рамку
//    1.8 и в полёте — прогноз ниже тоже (1.8 не пролезет туда, где 0.6
//    пролезла бы, — осторожнее, откатов не будет);
//  * Player.canCriticalAttack полёт не запрещает; MaceItem.canSmashAttack —
//    запрещает (fallDistance > 1.5 && !isFallFlying): удар булавой с пике —
//    только после свапа элитр на нагрудник (Equippable.swapWithEquipmentSlot:
//    «использовать» нагрудник в руке — одним пакетом, левой рукой, чтобы
//    заряд булавы в правой не обнулился — Player.tick сверяет только правую);
//  * ServerGamePacketListenerImpl.handleMovePlayer: в полёте «слишком быстро»
//    — только за 300 (квадрат блоков за пакет), а тело сервер не моделирует,
//    лишь сверяет сдвиг с коллизиями — чужая физика не мешает;
//  * FireworkRocketItem.use: ракета — только если isFallFlying на сервере;
//    ServerGamePacketListenerImpl START_FALL_FLYING → Player.tryToStartFallFlying:
//    не на земле, не в воде, элитры на теле.

const { ON }: typeof import('./elytra/consts') = require('./elytra/consts')
const { worldOf, headroom }: typeof import('./elytra/physics') = require('./elytra/physics')
const { hasElytra, kit, swapChest }: typeof import('./elytra/kit') = require('./elytra/kit')
const { install, startGlide }: typeof import('./elytra/install') = require('./elytra/install')
const { fly, takeoff, landingSpot, land, chestDown }: typeof import('./elytra/flight') = require('./elytra/flight')
const { gliding, predictGlider, track }: typeof import('./elytra/track') = require('./elytra/track')
const { escape }: typeof import('./elytra/escape') = require('./elytra/escape')
const { divePlan, diveSmash, healthOf }: typeof import('./elytra/dive') = require('./elytra/dive')

// ---------------------------------------------------------------- в бою

// На бой: слежка за ним и решения. pvp.js зовёт decide() в цикле; run()
// держит тело до посадки. allow() — отпустить рефлекс края на время полёта
// (он рулил бы клавишами, которые элитрам не нужны).
function create (bot, { enemy, used = () => {}, edgeGuard = null, arena = null, telemetryHp = e => healthOf(bot, e) }: any = {}) {
  install(bot)
  const createdAt = gameClock.now()
  const guard0 = bot._ndElytra?.guardSaves || 0
  worldOf(bot)
  const fl = track(bot, { enemy })
  const st: any = {}
  const allow = () => { try { if (edgeGuard) edgeGuard.allow(400, 400) } catch {} }
  // Посадка воздушного боя — с нагрудником назад (S7d, ревью Codex №2: ветки SafeLanding звали только land(), и
  // боец дрался на земле в элитрах — броня 12 вместо 20, урон по нему ×2.2: s7d-y-30 р.3, 10 : 0 по именам).
  // Границы арены — во взлёт, полёт и посадку (Codex 15.10: полёт терял arena — боты улетали за Колизей и стояли там с
  // «goto target is outside arena bounds» по 1300 раз).
  const landDressed = async (b, c, o: any = {}) => {
    const r = await land(b, c, { arena, ...o })
    try { if ((b.health ?? 0) > 0 && !b.entity.elytraFlying) await chestDown(b, c, { stats: o.stats, arena }) } catch {}
    return r
  }
  const takeoffIn = (b, c, o: any = {}) => takeoff(b, c, { arena, ...o })
  const flyIn = (b, c, o: any = {}) => fly(b, c, { arena, ...o })
  const aerial = (require('./combat/aerial-executor') as typeof import('./combat/aerial-executor')).createAerialCombat(bot, {
    enemy, worldOf, kit, landingSpot, gliding, predictGlider, takeoff: takeoffIn, fly: flyIn, land: landDressed,
    swapChest, startGlide, allow, used, stats: st
  })
  const lanceMod: typeof import('./combat/aerial-lance') = require('./combat/aerial-lance')
  let nextDive = 0
  let nextEscape = 0
  let nextLance = 0
  return {
    fl,
    st,
    gliding: () => fl.flying(),
    threat: () => fl.threat(),
    // Что делать сейчас: 'escape' — уход лечиться, 'dive' — пике с булавой.
    decide (ctx) {
      // Без элитр в рюкзаке (весь нынешний «арсенал») — сразу мимо: ни
      // разбора рюкзака, ни прогнозов.
      if (!ON || !bot.entity || !hasElytra(bot)) return null
      const e = enemy()
      if (!e || !e.position) return null
      if (gliding(bot.entity) || gliding(e)) {
        if (ctx.hp <= ctx.healAt && ctx.heal && kit(bot).rockets >= 2 && gameClock.now() >= nextEscape) {
          nextEscape = gameClock.now() + 8000
          return { kind: 'escape' }
        }
        // Таран копьём (s7b): в полёте — тоже, если копьё и ракеты есть, а его щит не в деле.
        // Показ 09.10: 4 с паузы в воздухе отдавали полёт перехвату (AerialIntercept) — оба бота кружили друг вокруг друга;
        // таран сам разводит (разбег прочь) и бросает в пике.
        if (gameClock.now() >= nextLance && lanceMod.lancePlan(bot, e, ctx)) { nextLance = gameClock.now() + 500; return { kind: 'lance' } }
        const decision = aerial.decide(undefined, ctx)
        return decision.selected ? { kind: 'aerial', decision } : null
      }
      if (!bot.entity.onGround) return null
      const now = gameClock.now()
      const k = kit(bot)
      if (!k.elytra || k.rockets < 1) return null
      if (ctx.hp <= ctx.healAt && ctx.heal && !ctx.eatSafe && now >= nextEscape && k.rockets >= 2) {
        const W = worldOf(bot)
        if (headroom(W, bot.entity.position, 8) >= 6) { nextEscape = now + 8000; return { kind: 'escape' } }
      }
      // Показ 09.10: 6 с / 15 с паузы — бот подолгу бился пешком, хотя таран выгоднее (ракеты стережёт lancePlan ≥ 3).
      if (now >= nextLance && lanceMod.lancePlan(bot, e, ctx)) { nextLance = now + 2000; return { kind: 'lance' } }
      if (now >= nextDive && divePlan(bot, e, ctx)) { nextDive = now + 9000; return { kind: 'dive' } }
      return null
    },
    async run (ctl, plan, ctx: any = {}) {
      const e = enemy()
      if (plan.kind === 'aerial') return aerial.run(ctl, ctx)
      if (plan.kind === 'escape') return escape(bot, ctl, e, { heal: ctx.heal, enough: ctx.enough, stats: st, used, allow, arena })
      if (plan.kind === 'lance') {
        const res: any = await lanceMod.lance(bot, ctl, e, { vel: ctx.vel, stats: st, used, allow, arena, telemetryHp })
        // Ни одного попадания — не сразу снова (ракеты и время).
        if (!res.hit) nextLance = gameClock.now() + 1000
        return res
      }
      if (plan.kind === 'dive') {
        const res: any = await diveSmash(bot, ctl, e, { vel: ctx.vel, stats: st, used, allow, telemetryHp, arena })
        // Без подтверждённого попадания пике расходует ракеты и грозит падением.
        if (!res.hit) nextDive = gameClock.now() + 30000
        return res
      }
      return { ok: false, note: 'нечего' }
    },
    report () {
      const t = fl.report()
      const out = {
        takeoffs: st.takeoffs || undefined, launchTurns: st.launchTurns || undefined,
        rockets: st.rockets || undefined,
        escapes: st.escapes || undefined,
        escapeS: st.escapeMs ? Math.round(st.escapeMs / 100) / 10 : undefined,
        escapeHp: st.escapeHp || undefined,
        hurtAir: st.hurtAir || undefined,
        dives: st.dives || undefined,
        diveHits: st.diveHits || undefined,
        diveDealt: st.diveDealt,
        diveSelf: st.diveSelf || undefined,
        landings: st.landings || undefined,
        landDmg: st.landDmg || undefined,
        aerialNodes: st.aerialNodes,
        airJabs: st.airJabs || undefined,
        airSmashes: st.airSmashes || undefined,
        airPearls: st.airPearls || undefined,
        airArrows: st.airArrows || undefined,
        airArrowHits: st.airArrowHits || undefined,
        lances: st.lances || undefined,
        lancePasses: st.lancePasses || undefined,
        lanceHits: st.lanceHits || undefined,
        lanceDealt: st.lanceDealt,
        lanceSelf: st.lanceSelf || undefined,
        lanceBadLand: st.lanceBadLand || undefined,
        lanceDeaths: st.lanceDeaths || undefined,
        lanceTrace: st.lanceTrace,
        lanceEarly: st.lanceEarly || undefined,
        lanceBail: st.lanceBail || undefined,
        guardSaves: ((bot._ndElytra?.guardSaves || 0) - guard0) || undefined,
        reglideReflex: bot._ndElytra?.reglideReflex || undefined, airDrops: bot._ndElytra?.drops || undefined,
        // Чужие повороты взгляда, отбитые замком руля (кто — по кадру стека), за всё время демона.
        blockedLooks: bot._ndElytra?.blockedLooks || undefined,
        blockedBy: bot._ndElytra?.blockedLooks ? Object.entries(bot._ndElytra.blockedBy || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`) : undefined,
        chestAir: st.chestAir || undefined,
        reglide: st.reglide || undefined,
        // Удары о стену/пол себе за этот бой (чёрный ящик install): вид/фаза/урон, † — насмерть; ticks — первого.
        crashes: (() => { const c = (bot._ndElytra?.crashes || []).filter(x => x.at >= createdAt); return c.length ? c.map(x => `${x.kind}/${x.phase || '?'}/−${x.dmg ?? '?'}${x.died ? '†' : ''}`) : undefined })(),
        crashTicks: (() => { const c = (bot._ndElytra?.crashes || []).find(x => x.at >= createdAt); return c ? c.ticks.slice(-6).map(k => `${k.ph || '-'} ${k.x},${k.y},${k.z} v${k.vx},${k.vy},${k.vz} fd${k.fd}${k.ef ? '' : ' нет полёта'}${k.fw ? ' ракета' : ''}`) : undefined })(),
        foe: t
      }
      return (Object.values(out) as any[]).some(v => v !== undefined) ? out : undefined
    },
    close () { fl.close() }
  }
}

export { create }
export { ON, EYE_FLY, FLY_H, nextTick } from './elytra/consts'
export { lookVec, glideStep, fallStep, worldOf, rollout, headroom, reachFromBox } from './elytra/physics'
export { kit, hasElytra, wearingElytra, rocketCount, plainRocket, bestChest, toHotbar, swapChest } from './elytra/kit'
export { choose } from './elytra/control'
export { install, steer, startGlide, fireRocket, arenaAround } from './elytra/install'
export { rocketChoice, fly, launchLook, takeoff, lavaLaunchClear, landingSpot, land, chestDown } from './elytra/flight'
export { gliding, predictGlider, track } from './elytra/track'
export { consumeAir, escape } from './elytra/escape'
export { smashBonus, divePlan, diveSmash } from './elytra/dive'
