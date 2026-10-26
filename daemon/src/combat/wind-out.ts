// Реактивный сброс зарядом ветра (пользователь 24.10: «зарядами ветра выкидывать врага с арены»). Каждый бот решает сам,
// по своим глазам, каждый второй тик: видимый враг у края Колизея (или в воздухе) — если брошу сейчас, вылетит ли он за
// край / ниже линии смерти, даже рулящий назад к центру. Да — бросок рядом с текущим боем (wind_out, не эксклюзивно).
// Цепочка складывается без общего расписания: следующий бот видит уже изменённую скорость цели и считает свой бросок от
// неё (общий график по RPC разъезжался на 1–2 тика между процессами — auto-log 24.10 04:47…07:06).
// Физика — та же, что у роевой цепи: enemy-wind (WindCharge 1.21.11, ServerExplosion, сопротивление по видимой броне).
import * as clock from '../game-clock'
import * as hands from '../mace/hands'
import { worldTick, arenaRoom, type WindArena, type WindReport } from './team-wind'
import { planEnemyWind } from './enemy-wind'
import { isAlly } from './ally-safety'
import { WIND_CD_MS } from '../mace/consts'
import { seesPlayer } from '../pvp/last-seen'
const tw = () => require('./team-wind') as typeof import('./team-wind')
// Скорость чужого тела — по наблюдённым позициям: сырой entity.velocity — из редких пакетов entity_velocity (см. enemy-wind enemyView).
const seenV = (e: any) => (require('../bow/track') as typeof import('../bow/track')).observedVelocity(e) || e.velocity

// Край, от которого вообще считаем: в воздухе — до 12 бл. до края квадрата арены, на земле — 5 (иначе толчок не вынесет).
// RANGE_AIR — по подброшенному (пользователь 25.10: «подкидывают хорошо и потом перестают кидать»: подброшенный на 50+ бл. уходил
// дальше 16 бл. от всех, и цепь вставала; «лимиты на радиусы убирай»). В полёте на элитрах — бросок на подлёте (RANGE_FLY).
// Стенд ветра 25.10: гребень Колизея — в 6.5 бл. от края квадрата, и облёт на элитрах 13 с кружил в 6–9 бл. от стоящего там, не
// бросив ни разу (край 5 отсекал его до расчёта). Предфильтр шире; вылетит ли — решает сам расчёт (planEnemyWind). Заряд летит
// 1.5 бл/т до 30 т. — 45 бл.; разброс 0.0172 на 36 бл. — ~0.6 бл., в рамку тела с полями.
const EDGE_AIR = 12, EDGE_GROUND = 8, RANGE = 36, RANGE_AIR = 48, RANGE_FLY = 24, ALLY_R = 7
// «Шаг цепи»: бросок не выносит сам, но уводит к краю на столько блоков — следующий добьёт (цена — один заряд).
// Стенд 25.10 (гребень в 7.5 бл. от края, подлёт на 6 бл.): с порогом 0.7 бросков втрое больше, но 0 сбросов из 14 — заряд
// уводит ~1 бл., за полёт серия не набирает 7 бл.; с 2 — 2 из 6. Порог 2.
const CHAIN_PROGRESS = 2, OUT_PROGRESS = 1, VOLLEY_PROGRESS = .5
// Жонглирование (пользователь 24.10: «подлетел высоко — закидывают, чтобы поднялся выше и улетел с арены вниз»): высоко
// над опорой — в любом месте арены; бросок держит в воздухе дольше на JUGGLE_AIR тиков и не тянет внутрь.
const HIGH = 2.5, JUGGLE_AIR = 6

export function edgeRoom(arena: WindArena, p: { x: number; z: number }) {
  return arenaRoom(arena, p)
}

/** Height of the feet above the first known support below (up to 40 blocks); Infinity — nothing seen under him. */
export function heightAbove(bot: any, p: { x: number; y: number; z: number }) {
  const { Vec3 }: typeof import('vec3') = require('vec3')
  for (let dy = 0; dy <= 40; dy++) {
    const b = bot.blockAt(new Vec3(p.x, p.y - dy - .01, p.z), false)
    if (b && b.boundingBox === 'block') return p.y - (Math.floor(p.y - dy - .01) + 1)
  }
  return Infinity
}

/** A visible survival foe at least 2 blocks below and within 6 horizontally — the mace descent target. */
export function maceTarget(bot: any, me: { x: number; y: number; z: number }) {
  return (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity).find(e => e?.position && e !== bot.entity && e.username &&
    !isAlly(bot, e) && bot.players[e.username]?.gamemode === 0 && e.position.y < me.y - 2 &&
    Math.hypot(e.position.x - me.x, e.position.z - me.z) <= 6 && seesPlayer(bot, e)) || null
}

/** Hostile, visible, alive, close; near an edge, or high in the air anywhere (juggle). */
export function windOutCandidates(bot: any, arena: WindArena) {
  const own = bot.entity?.position
  if (!own) return []
  return (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity).filter(e => e?.position && e !== bot.entity && e.username &&
    e.username !== bot.username && !isAlly(bot, e) && bot.players[e.username]?.gamemode !== 3 && bot.players[e.username]?.gamemode !== 1 &&
    e.position.distanceTo(own) <= (bot.entity.elytraFlying ? RANGE_FLY : e.onGround ? RANGE : RANGE_AIR) && (edgeRoom(arena, e.position) <= (e.onGround ? EDGE_GROUND : EDGE_AIR) || !e.onGround && heightAbove(bot, e.position) >= HIGH) && seesPlayer(bot, e))
    .sort((a, b) => edgeRoom(arena, a.position) - edgeRoom(arena, b.position))
}

/** Allies that a burst near this foe could move: sight is checked only for the few close to him (cost: 30 LOS rays per ally). */
function alliesNear(bot: any, foe: any, now: number): WindReport[] {
  return (Object.values(bot.entities || {}) as any[]).filter(e => e?.position && e !== bot.entity && e.username && isAlly(bot, e) &&
    e.position.distanceTo(foe.position) <= ALLY_R && bot.players?.[e.username]?.gamemode !== 3)
    .sort((a, b) => a.position.distanceTo(foe.position) - b.position.distanceTo(foe.position)).slice(0, 4).filter(e => seesPlayer(bot, e))
    .map(a => ({ id: a.username, position: { ...a.position }, velocity: { ...seenV(a) }, onGround: !!a.onGround, eyeHeight: 1.62, gameTick: now }))
}

/** Decide one own shot released THIS tick; null — nothing worth a charge. Pure: no hands, no packets. */
// Счётчик отказов (ND_WIND_TRACE=1): почему по видимому у края не бросили — для стенда ветра.
export const windTrace: Record<string, number> = {}
const trace = (k: string) => { if (process.env.ND_WIND_TRACE === '1') windTrace[k] = (windTrace[k] || 0) + 1 }
export function windOutDecide(bot: any, own: WindReport, arena: WindArena, lag = 0) {
  const now = worldTick(bot)
  if (now === null) return null
  for (const foe of windOutCandidates(bot, arena).slice(0, 2)) {
    const allies = alliesNear(bot, foe, now)
    const plan = planEnemyWind(bot, foe, [own], { arena, startTick: now, maxShots: 1, allies, delays: [lag], reactAfterHit: true, juggle: !foe.onGround })
    trace(!plan ? 'no_plan' : plan.baseline.out ? 'already_out' : plan.shots[0].fireDelay !== lag ? 'late' : 'planned')
    // Сам и так улетает — заряд не тратить (и не толкнуть его обратно на край).
    if (!plan || plan.baseline.out || plan.shots[0].fireDelay !== lag) continue
    // «Вылет» без увода наружу — падение сквозь неувиденные клетки (observedCollision: не видно — воздух), а на деле он
    // валится внутрь, на поле (стенд 24.10 12:44: «вылетит?» при прогнозе +0 бл., толкали внутрь). Наружу — хотя бы на блок.
    const outward = (r: typeof plan.nominal) => r.out && r.progress >= OUT_PROGRESS
    // Заряд толкает вдоль своего полёта: стоя снаружи от цели (ближе него к краю), толкаю внутрь, сколько бы ни сулил расчёт
    // (стенд 25.10: облётчик с внешней стороны трижды снёс его с яруса на поле). Снаружи — только верный вылет.
    const ox = foe.position.x - arena.x, oz = foe.position.z - arena.z, on = Math.hypot(ox, oz) || 1
    const outside = ((foe.position.x - own.position.x) * ox + (foe.position.z - own.position.z) * oz) / on < -.5
    // Серия (пользователь 25.10: «закидывали ветров, чтобы я улетел к краю»): рядом с ним уже летит заряд (свой или его подброс) —
    // подхватываю и малым шагом: один заряд уводит ~1 бл., несколько за один подлёт — к краю.
    // Подброшен (летит вверх или высоко над опорой) — тоже начало серии.
    // Только у края (EDGE_AIR): посреди поля серия не выносит, а руки уходят с оружия (15×15 26.10: 1894 серии, сбросов ветром 6
    // из 2316 бросков, смертей от копья 50).
    const volley = !foe.onGround && edgeRoom(arena, foe.position) <= EDGE_AIR && (heightAbove(bot, foe.position) >= HIGH || (foe.velocity?.y || 0) > .3 ||
      (Object.values(bot.entities || {}) as any[]).some(c => c?.position && /wind_charge$/.test(c.name || '') && c.position.distanceTo(foe.position) < 6))
    const juggle = !foe.onGround && plan.nominal.air >= plan.baseline.air + JUGGLE_AIR && plan.nominal.progress >= .3
    const kind = outward(plan.worst) ? 'out' : outside ? null : outward(plan.nominal) ? 'out?' :
      !foe.onGround && plan.nominal.progress >= (volley ? VOLLEY_PROGRESS : CHAIN_PROGRESS) ? (volley ? 'volley' : 'chain') : juggle ? 'juggle' : null
    if (outside && !kind) trace('outside')
    trace(kind ? 'kind:' + kind : `weak:${foe.onGround ? 'ground' : 'air'}`)
    if (kind) return { kind, plan, foe, allies, shot: plan.shots[0] }
  }
  return null
}

// Батут и волейбол (пользователь 24.10): союзник с булавой только что подпрыгнул к врагу — заряд в пол ему под ноги к тику
// прилёта, его подбрасывает (взрыв от центра к глазам, ServerExplosion), падает он булавой (бонус от fallDistance, MaceItem).
// Враг на земле — батут, удар сверху; враг в воздухе (подброшен) — волейбол, перехват на высоте. Тело союзника бьёт само.
// Цена: без попадания союзнику падение ~6–8 бл. (3–5 хп) — поэтому только при видимом враге рядом с ним и подъёме вверх.
export function trampolineDecide(bot: any, own: WindReport) {
  const { Vec3 }: typeof import('vec3') = require('vec3')
  const tw: typeof import('./team-wind') = require('./team-wind')
  const me = bot.entity?.position
  if (!me) return null
  const foes = (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity).filter(e => e?.position && e.username && e !== bot.entity &&
    !isAlly(bot, e) && bot.players[e.username]?.gamemode === 0 && e.position.distanceTo(me) <= 24)
  for (const ally of Object.values(bot.entities || {}) as any[]) {
    if (!ally?.position || ally === bot.entity || !ally.username || !isAlly(bot, ally) || ally.position.distanceTo(me) > 8) continue
    if (ally.heldItem?.name !== 'mace' && ally.equipment?.[0]?.name !== 'mace') continue
    const v = new (require('vec3').Vec3)(seenV(ally).x, seenV(ally).y, seenV(ally).z)
    // Только что оторвался от пола прыжком (0.42 → вниз по 0.08): подъём, низко над опорой.
    if (ally.onGround || !(v.y > .15 && v.y < .45) || heightAbove(bot, ally.position) > 1.3) continue
    const foe = foes.map(e => ({ e, d: Math.hypot(e.position.x - ally.position.x, e.position.z - ally.position.z) }))
      .filter(f => f.d >= 2 && f.d <= 9 && (f.e.position.x - ally.position.x) * v.x + (f.e.position.z - ally.position.z) * v.z > 0).sort((a, b) => a.d - b.d)[0]
    if (!foe || !seesPlayer(bot, ally) || !seesPlayer(bot, foe.e)) continue
    // Один заряд на прыжок: бросает ближайший к нему из своих (без общего расписания все видят одно и то же; стенд 14:06 —
    // по 3–5 зарядов в одного прыгнувшего).
    const mine = me.distanceTo(ally.position)
    if ((Object.values(bot.entities || {}) as any[]).some(o => o?.position && o !== ally && o !== bot.entity && o.username && isAlly(bot, o) &&
      o.position.distanceTo(ally.position) < mine - .3 && bot.players?.[o.username]?.gamemode === 0)) continue
    const floorY = ally.position.y - heightAbove(bot, ally.position)
    const eye = me.offset(0, 1.62, 0), moved = new Vec3(own.velocity.x, own.onGround ? 0 : own.velocity.y, own.velocity.z)
    // Где он будет к прилёту: баллистика игрока (тяжесть 0.08, сопротивление 0.98), горизонталь — ×0.91 в воздухе.
    let t = Math.max(1, Math.ceil(eye.distanceTo(ally.position) / tw.WIND.speed)), shot: any = null, feet: any = null
    for (let iter = 0; iter < 3; iter++) {
      let p = ally.position.clone(), w = v.clone()
      for (let k = 0; k < t; k++) { p = p.plus(w); w = new Vec3(w.x * .91, (w.y - .08) * .98, w.z * .91) }
      feet = p
      shot = tw.windShot(bot, eye, new Vec3(p.x, floorY, p.z), moved, bot.username)
      if (!shot) break
      if (shot.ticks === t) break
      t = shot.ticks
    }
    if (!shot || !feet) continue
    const kick = tw.windImpulse({ ...bot, entity: { attributes: {} } }, feet, shot.burst)
    if (kick.y < .5) continue
    return { kind: foe.e.onGround ? 'trampoline' : 'volley', ally: ally.username, foe: foe.e, shot, kick: +kick.y.toFixed(2) }
  }
  return null
}

// Выпуск в тот же тик, что и расчёт: поворот едет в самом use_item (1.21.11 ServerGamePacketListenerImpl.handleUseItem →
// absSnapRotationTo), отдельный пакет взгляда и ожидание тика не нужны — прыгающая цель за 1–2 тика уходила с прицела.
export function release(bot: any, shot: { yaw: number; pitch: number }) {
  const off = hands.offWind(bot), slot = hands.hotbarIndex(bot, 'wind_charge')
  if (!off && slot < 0) return false
  const back = bot.quickBarSlot
  if (!off && back !== slot) bot.setQuickBarSlot(slot)
  try {
    bot.entity.yaw = shot.yaw; bot.entity.pitch = shot.pitch
    bot.activateItem(off); bot.usingHeldItem = false; bot._ndWindCd = clock.now() + WIND_CD_MS
  } finally { if (!off && back !== slot) bot.setQuickBarSlot(back) }
  return true
}

export function installWindOut(session: any) {
  const bot = session.bot
  if (!bot || bot._ndWindOut) return
  const stats = session._windOut ||= { tries: 0, fired: 0, log: [] as any[] }
  let busy = false, tick = 0, spawnGeneration = 0, planEma = 40, lastMiss: { me: any, foe: any } | null = null
  bot._ndWindOut = true
  bot.on('respawn', () => { spawnGeneration++ })
  const tryTrampoline = (arena: WindArena) => {
    if (!hands.offWind(bot) && hands.hotbarIndex(bot, 'wind_charge') < 0) return
    const ex: typeof import('./enemy-wind-execute') = require('./enemy-wind-execute')
    const report = ex.enemyWindReport(session)
    if (!report.ok || !report.ready) return
    const pick = trampolineDecide(bot, report.report)
    if (!pick || !tw().windInside(pick.shot.burst, arena)) return
    busy = true
    const entry: any = { at: clock.now(), target: pick.foe.username, kind: pick.kind, ally: pick.ally, kick: pick.kick, edge: +edgeRoom(arena, pick.foe.position).toFixed(1), air: !pick.foe.onGround, progress: 0, planMs: 0 }
    const foeId = pick.foe.id
    let hurt = false
    const onHurt = (e: any) => { if (e?.id === foeId) hurt = true }
    hands.afterPacket(bot, () => {
      entry.fired = release(bot, pick.shot)
      if (!entry.fired) { busy = false; return }
      stats.fired++
      bot.on('entityHurt', onHurt)
      let left = 40
      const wait = () => { if (--left > 0 && !hurt) return; bot.removeListener('physicsTick', wait); bot.removeListener('entityHurt', onHurt)
        entry.hit = hurt; busy = false; stats.log.push(entry); if (stats.log.length > 20) stats.log.shift() }
      bot.on('physicsTick', wait)
    })
  }
  // Меня подбросили (батут союзника) с булавой в руке, враг внизу в 6 бл. — спуск с ударом (mace.descend): своего взлёта у
  // тела не было, и удар с падения сам не начинался (стенд 24.10 14:06 — пять батутов, ни одного удара).
  let descending = false
  const tryDescend = () => {
    if (descending || bot.heldItem?.name !== 'mace' || bot.entity.onGround || bot.entity.elytraFlying || heightAbove(bot, bot.entity.position) < 4) return
    const me = bot.entity.position
    const foe = maceTarget(bot, me)
    if (!foe) return
    descending = true
    const entry: any = { at: clock.now(), target: foe.username, kind: 'descend', ally: bot.username, kick: 0, fired: true, progress: 0, edge: 0 }
    session.runIntent('mace_descend', ctl => (require('../mace') as typeof import('../mace')).descend(bot, ctl, foe, {}),
      { exclusive: false, timeoutMs: 5000, interruptOn: ['death', 'kicked', 'disconnected'], params: { reflex: true } })
      .then(r => { entry.hit = !!r?.detail?.hit }).catch(() => {})
      .finally(() => { descending = false; stats.log.push(entry); if (stats.log.length > 20) stats.log.shift() })
  }
  // Щит от булавы сверху — рефлекс тела вне боя (стенд 25.10: падение с 12 бл. на лутающего, летящего и бросающего ветер — ни щита,
  // ни отскока, 5 смертей из 6; драйвер замечал «падает на меня» через опрос раз из двух и поздно). Щит держит через 5 т. после подъёма (blockDelayTicks), mace_smash щитом гасится (jar 1.21.11) — подъём за ≤ 25 т.
  let shieldUp = false, shieldSeen = 0, equipping = false, dodging: { x: number, z: number } | null = null
  const smashShield = (): boolean => {
    const foes: string[] = session._ndFoes || []
    // И в бою: его защита (mace/defend) поднимает щит, только если он уже надет, — стенд: «☂ падает на меня» у дерущегося, удар в открытого.
    const s = foes.length && !bot.entity.elytraFlying ? (require('../threats') as typeof import('../threats')).smashes(bot, foes)[0] : null
    if (!s || s.ticks > 25) {
      if (shieldUp && clock.now() - shieldSeen > 300) { bot.deactivateItem(); bot.setControlState('back', false); shieldUp = false }
      if (dodging && clock.now() - shieldSeen > 300) { for (const k of ['forward', 'sprint', 'jump']) bot.setControlState(k, false); dodging = null }
      return shieldUp || !!dodging
    }
    shieldSeen = clock.now()
    const off = bot.inventory.slots[45]
    if (off?.name !== 'shield') {
      const sh = bot.inventory.items().find((i: any) => i.name === 'shield')
      // Тотем в левой руке при малом хп не снимать. Щита нет — спринт с прыжком прочь от точки удара, если до посадки 5+ т. и
      // пробег чистый (без обрыва глубже 3 и стен, flee.runLength), — стенд: двое без щита стояли и умирали.
      if (!sh || off?.name === 'totem_of_undying' && bot.health <= 16) {
        const me = bot.entity.position, dx = me.x - s.at.x, dz = me.z - s.at.z, n = Math.hypot(dx, dz)
        if (s.ticks < 5 || !bot.entity.onGround && !dodging) return !!dodging
        const fl: any = require('../flee')
        const dirs = [0, .8, -.8, 1.6, -1.6].map(a => { const b0 = n > .3 ? Math.atan2(dz, dx) : Math.random() * 6.28; return { x: Math.cos(b0 + a), z: Math.sin(b0 + a) } })
        const dir = dodging || dirs.find(d => fl.runLength(bot, d, 4, 3, session._rescue?.arena).len >= 2.5)
        if (!dir) return false
        if (!dodging) bot.pathfinder?.setGoal(null)
        dodging = dir
        bot.look(Math.atan2(-dir.x, -dir.z), 0, true).catch(() => {})
        for (const k of ['forward', 'sprint', 'jump']) bot.setControlState(k, true)
        return true
      }
      if (!equipping) { equipping = true; bot.equip(sh, 'off-hand').catch(() => {}).finally(() => { equipping = false }) }
      return true
    }
    bot.lookAt(new Vec3(s.from.x, s.from.y, s.from.z), true).catch(() => {})
    // Прямо над головой щит не держит (LivingEntity.isDamageSourceBlocked: горизонталь до него нулевая) — шаг назад, лицом к нему.
    const dh = Math.hypot(s.from.x - bot.entity.position.x, s.from.z - bot.entity.position.z)
    bot.setControlState('back', dh < 1.5); bot.setControlState('sprint', false)
    if (!shieldUp) {
      bot.activateItem(true); shieldUp = true
      stats.log.push({ at: clock.now(), target: s.name, kind: 'shield', ticks: s.ticks, fired: true, progress: 0, edge: 0 }); if (stats.log.length > 20) stats.log.shift()
    }
    return true
  }
  const { Vec3 }: typeof import('vec3') = require('vec3')
  bot.on('physicsTick', () => {
    const cfg = session._rescue
    if (cfg?.arena && bot.entity && bot.health > 0 && smashShield()) return
    if (cfg?.arena && bot.entity && bot.health > 0) tryDescend()
    if (busy || !cfg?.arena || (++tick & 1) || !bot.entity || !(bot.health > 0) || process.env.ND_WIND_OUT === '0') return
    if (!hands.windReady(bot) || bot.usingHeldItem) return
    const arena: WindArena = { ...cfg.arena, killY: Number.isFinite(cfg.killY) ? cfg.killY : undefined }
    if (process.env.ND_WIND_TRACE === '1' && tick % 200 === 0 && Object.keys(windTrace).length) {
      const pt = (require('./enemy-wind') as typeof import('./enemy-wind')).planTraceCounts
      console.log('[wind-trace]', JSON.stringify(windTrace), JSON.stringify(pt)); for (const k of Object.keys(windTrace)) delete windTrace[k]; for (const k of Object.keys(pt)) delete pt[k]
    }
    if (!windOutCandidates(bot, arena).length) {
      if (process.env.ND_WIND_TRACE === '1' && tick % 10 === 0) for (const e of (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity)) {
        if (!e?.position || e === bot.entity || isAlly(bot, e) || bot.players[e.username]?.gamemode !== 0) continue
        const d = e.position.distanceTo(bot.entity.position)
        trace(d > (e.onGround ? RANGE : RANGE_AIR) ? 'cand:far' : edgeRoom(arena, e.position) > (e.onGround ? EDGE_GROUND : EDGE_AIR) && (e.onGround || heightAbove(bot, e.position) < HIGH) ? 'cand:edge' : !seesPlayer(bot, e) ? 'cand:los' : 'cand:other')
      }
      tryTrampoline(arena); return
    }
    // Заряд в рюкзаке — сначала в хотбар (фоном), считать бросок — со следующего раза.
    if (!hands.offWind(bot) && hands.hotbarIndex(bot, 'wind_charge') < 0) { busy = true; hands.ensureHotbar(bot, ['wind_charge']).catch(() => {}).finally(() => { busy = false }); return }
    const ex: typeof import('./enemy-wind-execute') = require('./enemy-wind-execute')
    const report = ex.enemyWindReport(session, { flying: true })
    if (!report.ok || !report.ready) return
    const t0 = clock.wall.monotonic(), nativeClock = bot.ndClock, observedAt = nativeClock?.observationNow?.(), generation = spawnGeneration
    // Упреждение на свой расчёт: бросок уходит через planMs после кадра, по которому считан (стенд 24.10 14:06: 90–230 мс —
    // мимо, цель уже на земле). Цель — на столько тиков вперёд, сколько обычно длится расчёт (скользящее среднее).
    const lag = Math.max(0, Math.min(4, Math.round(planEma * (nativeClock?.observationRate?.() ?? 20) / 1000)))
    const pick = windOutDecide(bot, report.report, arena, lag)
    const planMs = Math.round(clock.wall.monotonic() - t0)
    planEma = planEma * .8 + planMs * .2
    if (!pick) return
    // Тот же бросок с того же места по стоящему там же уже не попал — не повторять (стенд 25.10: 15 «out?» снизу по стоящему на
    // гребне, ни взрыва у цели, ни сдвига). Сдвинулся я или он — снова можно.
    const me = bot.entity.position
    if (lastMiss && me.distanceTo(lastMiss.me) < .5 && pick.foe.position.distanceTo(lastMiss.foe) < .5) return
    stats.tries++
    const entry: any = { at: clock.now(), target: pick.foe.username, kind: pick.kind, planMs, foeY: +pick.foe.position.y.toFixed(1),
      edge: +edgeRoom(arena, pick.foe.position).toFixed(1), air: !pick.foe.onGround, progress: +pick.plan.nominal.progress.toFixed(1), allies: pick.allies.length, lag, airGain: pick.plan.nominal.air - pick.plan.baseline.air }
    let logged = false
    const done = () => { busy = false; if (logged) return; logged = true; stats.log.push(entry); if (stats.log.length > 20) stats.log.shift() }
    // Замер прогноза: скорость цели сырая (пакеты entity_velocity) и по наблюдённым позициям, где ждём ноги к прилёту.
    const r2 = (v: any) => v ? [v.x, v.y, v.z].map(n => +(+n).toFixed(2)).join(',') : '?'
    const obsV = (require('../bow/track') as typeof import('../bow/track')).observedVelocity(pick.foe)
    entry.dbg = `v ${r2(pick.foe.velocity)} / набл. ${r2(obsV)}, ноги к прилёту ${r2(pick.shot.feet)} через ${pick.shot.ticks}+${pick.shot.fireDelay} т.`
    busy = true
    // Расчёт занял стеночное время: тик уже другой — пусть решает следующий заход по свежему кадру.
    if (worldTick(bot) !== pick.plan.gameTick) { entry.why = 'tick_passed_while_planning'; return done() }
    const meAt = me.clone(), foeAt = pick.foe.position.clone()
    hands.afterPacket(bot, () => {
      // Наблюдённое игровое время идёт и при заблокированном callback; подтверждённый тик мог догнать его уже в afterPacket.
      const tick = worldTick(bot)
      if (generation !== spawnGeneration || bot.ndClock !== nativeClock || tick === null || tick < pick.plan.gameTick) { entry.why = 'stale_release'; return done() }
      const elapsed = observedAt === undefined ? clock.wall.monotonic() - t0 : nativeClock.observationNow() - observedAt
      if (Math.max(elapsed, (tick - pick.plan.gameTick) * 50) > (lag + 1) * 50 + 25) { entry.why = 'stale_release'; return done() }
      entry.fired = release(bot, pick.shot)
      if (!entry.fired) { entry.why = 'charge_not_in_hotbar'; return done() }
      stats.fired++
      // Следующий бросок — с перезарядкой заряда (windReady), а не после замера: замер ждал полёт + 11 т., и за 1–1.5 с в воздухе
      // бот успевал один заряд (пользователь 25.10: «подкидываю себя на краю — кинут один ветер, и всё»; стенд: 1 сброс из 4 с 7 бл.).
      busy = false
      // Взрыв у цели — по пакету explosion в окне полёта (порыв gust_emitter_small, радиус 1.2).
      const spread = .08 + pick.shot.ticks * .05
      const onBoom = (pk: any) => { if (pk?.center && Math.hypot(pk.center.x - pick.shot.burst.x, pk.center.y - pick.shot.burst.y, pk.center.z - pick.shot.burst.z) <= 1.5 + spread) entry.burst = true }
      bot._client.on('explosion', onBoom)
      let left = pick.shot.ticks + 3
      const wait = () => {
        if (left === 3) { const q = bot.players?.[pick.foe.username]?.entity?.position; entry.dbg += `, на деле ${r2(q)}` }
        if (--left > -8) return // ещё 8 тиков после окна взрыва — куда его унесло
        bot.removeListener('physicsTick', wait); bot._client.removeListener('explosion', onBoom)
        const p = bot.players?.[pick.foe.username]?.entity?.position
        if (p) { entry.edgeAfter = +edgeRoom(arena, p).toFixed(1); entry.yAfter = +p.y.toFixed(1) }
        lastMiss = !entry.burst && p && p.distanceTo(foeAt) < .3 ? { me: meAt, foe: foeAt } : null
        logged = true; stats.log.push(entry); if (stats.log.length > 20) stats.log.shift()
      }
      bot.on('physicsTick', wait)
    })
  })
}
