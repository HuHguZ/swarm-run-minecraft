// Таран копьём на элитрах (s7b 06.10, план пользователя п.2: «атаки копьями на элитрах»).
//
// Механика — javap paper-1.21.11 (research/claude-1006/s7b/jar):
//  * ItemStack.onUseTick → KineticWeapon.damageEntities каждый тик «использования» копья; полёт на элитрах не мешает
//    (Item.use → startUsingItem без проверок полёта);
//  * после delayTicks (копьё: delay·20) — урон, пока тиков после задержки ≤ окна урона (Items.spear: iron 11.25 с·20),
//    отн. скорость ≥ 4.6 бл/с: rel = max(0, взгляд·моя − взгляд·его), скорости — getKnownSpeed·20;
//    урон = базовая атака игрока (1) + floor(rel·множитель копья) — iron 0.95, diamond 1.075: на 1.5 б/т (30 бл/с)
//    это 29–33 до брони; отброс — моя скорость вдоль взгляда ≥ 5.1 бл/с (окно kb), отброс идёт и сквозь щит
//    (Player.stabAttack: causeExtraKnockback не зависит от hurtOrSimulate);
//  * кого: ProjectileUtil.getHitEntitiesAlong — отрезок от глаз+взгляд·2.0 до глаз+взгляд·(4.5 + max(0, взгляд·мой ход
//    за тик)), рамка цели раздута на 0.125, блоки (COLLIDER) обрывают; одну цель — раз в 10 тиков (wasRecentlyStabbed);
//  * щит (Items.SHIELD BlocksAttacks: 90°, все типы, задержка 0.25 с) держит урон типа spear спереди; копьё щит не
//    выбивает (Weapon(1), без disableBlocking) — против поднятого щита таран не планируем;
//  * ракету и копьё одной рукой разом не «используют» (клиент игры, пока держит «использовать», второй не начинает):
//    ракета — до копья, во время разгона — нет.
const clock = require('../game-clock')
const Vec3 = require('vec3')
const sky = require('../elytra')
const spear = require('../spear')

const EYE_FLY = 0.4
const MIN_R = 2.0
const MAX_R = 4.5
const MARGIN = 0.125
const r2 = (x: number) => Math.round(x * 100) / 100
const wrap = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
const yawTo = (a: any, b: any) => Math.atan2(-(b.x - a.x), -(b.z - a.z))

type V = { x: number; y: number; z: number }

// Отрезок [2.0, 4.5 + max(0, L·v)] луча eye + t·L входит в раздутую рамку цели (ноги foot, ширина w, высота h)?
export function lanceHits (eye: V, L: V, v: V, foot: V, h = 1.8, w = 0.6): boolean {
  const tMax = MAX_R + Math.max(0, L.x * v.x + L.y * v.y + L.z * v.z)
  const hw = w / 2 + MARGIN
  const lo = [foot.x - hw, foot.y - MARGIN, foot.z - hw]
  const hi = [foot.x + hw, foot.y + h + MARGIN, foot.z + hw]
  const o = [eye.x, eye.y, eye.z]
  const d = [L.x, L.y, L.z]
  let t0 = MIN_R; let t1 = tMax
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return false; continue }
    let a = (lo[i] - o[i]) / d[i]; let b = (hi[i] - o[i]) / d[i]
    if (a > b) { const s = a; a = b; b = s }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
    if (t0 > t1) return false
  }
  return true
}

// Урон разгона (KineticWeapon.damageEntities): отн. скорость в бл/с и урон до брони; 0 — ниже порога 4.6.
export function lanceDamage (name: string, L: V, myV: V, hisV: V = { x: 0, y: 0, z: 0 }) {
  const spec = spear.SPEARS[name]
  const mine = (L.x * myV.x + L.y * myV.y + L.z * myV.z) * 20
  const his = (L.x * (hisV.x || 0) + L.y * (hisV.y || 0) + L.z * (hisV.z || 0)) * 20
  const rel = Math.max(0, mine - his)
  const dmg = spec && rel >= spear.DMG_REL ? 1 + Math.floor(rel * spec.mult) : 0
  return { rel: r2(rel), dmg, knock: mine >= spear.KB_SPEED }
}

const YAW_OFF = [0, 0.05, -0.05, 0.12, -0.12, 0.22, -0.22, 0.35, -0.35, 0.55, -0.55]
const PITCHES = [-1.0, -0.8, -0.62, -0.48, -0.36, -0.26, -0.17, -0.09, 0, 0.09, 0.2, 0.34]

// Взгляд на этот тик, при котором полёт (своя физика elytra.rollout) за H тиков проводит его рамку через отрезок
// копья, и после касания есть выход вверх без пола/стены. foot(t) — его ноги через t тиков, h — его рамка.
// { yaw, pitch, hitT, dmg, rel } или null (из этих взглядов не достать).
export function chooseLance (W: any, st: { p: V; v: V; boost: number; fd: number }, foot: (t: number) => V, { h = 1.8, hisV = { x: 0, y: 0, z: 0 }, name = 'iron_spear', H = 16, readyIn = 0 }: any = {}) {
  const f0 = foot(0)
  const bearing = yawTo(st.p, f0)
  const hs = Math.hypot(st.v.x, st.v.z)
  const heading = hs > 0.2 ? Math.atan2(-st.v.x, -st.v.z) : bearing
  const yaws = new Set<number>()
  for (const o of YAW_OFF) { yaws.add(wrap(bearing + o)); yaws.add(wrap(heading + o)) }
  let best: any = null
  for (const yaw of yaws) {
    for (const pitch of PITCHES) {
      const r = sky.rollout(W, st.p, st.v, yaw, pitch, st.boost, H, { fd: st.fd, keepPath: true })
      const L = sky.lookVec(yaw, pitch)
      const path = r.path || []
      let hit: any = null
      for (let t = 0; t < path.length && !hit; t++) {
        const q = path[t]
        const v = { x: q.vx, y: q.vy, z: q.vz }
        if (!lanceHits({ x: q.x, y: q.y + EYE_FLY, z: q.z }, L, v, foot(t + 1), h)) continue
        const dm = lanceDamage(name, L, v, hisV)
        if (dm.dmg > 0) hit = { t, q, ...dm }
      }
      if (!hit) continue
      // Столкнулись раньше касания — не годится.
      if (r.kind && r.t <= hit.t) continue
      // Выход: с точки касания тянуть вверх (pitch 0.6) 12 тиков — без стены и без жёсткого пола.
      const out = sky.rollout(W, hit.q, { x: hit.q.vx, y: hit.q.vy, z: hit.q.vz }, yaw, 0.6, 0, 12, { fd: hit.q.fd })
      // Выход в стену или в пол — цена, а не запрет (S7d, «гибкость вместо правил»): урон себе на выходе
      // (о стену 10·Δv − 3, падение fd − 3) весит вдвое больше урона ему; такой заход берётся, только если иначе
      // нечем (страховка «опасно» по 6 тикам вперёд в заходе остаётся).
      const exitSelf = out.kind === 'wall' ? Math.max(0, out.dmg) : out.kind === 'floor' ? Math.max(0, out.fd - 3) : 0
      // Касание раньше конца задержки копья (useTicks < delay) урона не даёт (KineticWeapon) — цена, а не запрет
      // (S7d: s7d-base — «мимо: ближе 0.2, копьё 10 т» при задержке 12; s7h отказ от ранних планов уронил касания —
      // без плана проход шёл над головой): каждый недостающий тик — +3, дуга подлиннее выигрывает у прямой.
      let c = hit.t - Math.min(40, hit.dmg) * 0.15 + Math.abs(pitch) * 0.3 + exitSelf * 2 + Math.max(0, readyIn - hit.t) * 3
      if (out.kind === 'floor') c += 8
      if (!best || c < best.c) best = { c, yaw, pitch, hitT: hit.t, dmg: hit.dmg, rel: hit.rel, exit: out.kind || null }
    }
  }
  return best
}

// Касание тарана — только damage_event цели, причина которого — я (sourceCauseId = id + 1; 0 — без причины).
export function ownHit (pk: any, myId: number, foeId: number): boolean {
  return !!pk && pk.entityId === foeId && pk.sourceCauseId === myId + 1
}

// Годится ли таран сейчас (на земле или уже в полёте): элитры, ≥3 простых ракет, копьё, нагрудник для возврата,
// хп, место над собой и над ним, его щит не в деле.
export function lancePlan (bot: any, e: any, { d, hp, hisShield = false }: any = {}) {
  if (!sky.ON || hisShield) return null
  const k = sky.kit(bot)
  const sp = spear.spearOf(bot)
  if (!k.elytra || k.rockets < 3 || !sp || !k.chest) return null
  if (!bot.entity || bot.entity.isInWater || !e || !e.position) return null
  if (hp < 8 || !(d >= 3) || d > 40) return null
  const W = sky.worldOf(bot)
  if (!sky.gliding(bot.entity) && sky.headroom(W, bot.entity.position, 10) < 8) return null
  if (sky.headroom(W, e.position, 6) < 4) return null
  return { kind: 'lance', spear: sp.item.name }
}

// Он держит «использовать» копьём (living_entity_flags 0x01, рука — 0x02) и куда смотрит (косинус к точке).
function spearBraced (bot: any, e: any): boolean {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys
    const i = keys.indexOf('living_entity_flags')
    const f = e.metadata[i >= 0 ? i : 8]
    if (typeof f !== 'number' || !(f & 0x01)) return false
    const it = (f & 0x02) ? (e.equipment || [])[1] : (e.equipment || [])[0]
    return !!(it && spear.isSpear(it.name))
  } catch { return false }
}
function facing (e: any, at: any): number {
  const fx = -Math.sin(e.yaw || 0); const fz = -Math.cos(e.yaw || 0)
  const tx = at.x - e.position.x; const tz = at.z - e.position.z
  const h = Math.hypot(tx, tz) || 1
  return (fx * tx + fz * tz) / h
}

// Телеметрия урона (не решения): здоровье + поглощение по метаданным — яблоко «съедало» таран в 0 (s7f).
function ehpTele (bot: any, e: any): number | null {
  const h = healthOf(bot, e)
  if (h == null) return null
  try { return h + (require('../read').absorptionOf(bot, e) || 0) } catch { return h }
}

function healthOf (bot: any, e: any): number | null {
  try {
    const keys = bot.registry.entitiesByName[e.name].metadataKeys
    const i = keys ? keys.indexOf('health') : -1
    const h = e.metadata[i >= 0 ? i : 9]
    return typeof h === 'number' ? h : null
  } catch { return null }
}

// Таран: взлёт → набор высоты и отход на разбег → заход (ракета, затем копьё «использовать») → касание → выход
// вверх → повтор (до passes) → посадка без кругов и нагрудник назад. stats — общая статистика элитр (report()).
export async function lance (bot: any, ctl: { aborted: boolean }, e: any, { vel = () => ({ x: 0, y: 0, z: 0 }), stats = {} as any, used = (_: string) => {}, allow = null as any, maxMs = 30000, passes = 3, arena = null as any }: any = {}) {
  const W = sky.worldOf(bot)
  const S = sky.install(bot)
  const t0 = clock.now()
  const out: any = { ok: false, hit: false, passes: 0, hits: 0, dealt: 0, note: '' }
  const hp0 = bot.health ?? 20
  const hisHp0 = healthOf(bot, e)
  const valid = () => !ctl.aborted && (bot.health ?? 0) > 0 && e && e.isValid !== false && e.position
  const sp = spear.spearOf(bot)
  if (!sp) { out.note = 'таран: копья нет'; return out }
  const name = sp.item.name
  const spec = spear.SPEARS[name]
  const delayMs = Math.round(spec.delay * 20) * 50
  // Земля: элитры на тело (правой), ракеты — в левую, копьё — в правую.
  if (!sky.wearingElytra(bot)) {
    const sw = await sky.swapChest(bot, 'elytra', { hand: 'main' })
    if (!sw.ok) { out.note = 'таран: элитры не надел — ' + sw.why; return out }
  }
  try { const rk = bot.inventory.items().find(sky.plainRocket); if (rk && !sky.plainRocket(bot.inventory.slots[45])) await bot.equip(rk, 'off-hand') } catch {}
  try { if (bot.heldItem?.name !== name) await bot.equip(sp.item, 'hand') } catch {}
  if (bot.heldItem?.name !== name || !sky.plainRocket(bot.inventory.slots[45])) {
    if (!sky.gliding(bot.entity)) await sky.swapChest(bot, 'chest')
    out.note = 'таран: копьё или ракета не в руках'
    return out
  }
  if (allow) allow()
  const foe = () => e.position
  const hisH = () => sky.gliding(e) ? 0.6 : 1.8
  // Его скорость — без NaN (bow.trackTarget изредка отдаёт NaN, s7 р.1): нечисло = 0.
  // И не больше 2 б/т по оси (рывок от удара/телепорт давали «план 230 урона, 237 бл/с» в s7f).
  const hv = () => { const v = vel() || {}; const n = (x: any) => Number.isFinite(x) ? Math.max(-2, Math.min(2, x)) : 0; return { x: n(v.x), y: n(v.y), z: n(v.z) } }
  const footAt = (t: number) => sky.gliding(e) ? sky.predictGlider(e, hv(), t) : (() => { const f = foe(); const v = hv(); return new Vec3(f.x + v.x * t, f.y, f.z + v.z * t) })()
  const ceilY = () => sky.arenaAround(bot, W, bot.entity.position).ceilY - 1.8 - 1.4
  const cruiseY = () => Math.min(ceilY(), foe().y + 7)
  if (!sky.gliding(bot.entity)) {
    const away = yawTo(foe(), bot.entity.position)
    const to = await sky.takeoff(bot, ctl, { pitch: 1.05, yaw: away, stats })
    if (!to.ok) { await sky.chestDown(bot, ctl, { stats }); out.note = 'таран: не взлетел — ' + to.why; return out }
  }
  stats.lances = (stats.lances || 0) + 1
  used('элитры: таран копьём — разбег')
  // Попадание — его damage_event, причина которого — я (sourceCauseId = мой id + 1), пока копьё «в деле».
  // entityHurt без источника (падение, кинетическая, его кристалл) касанием не считается (замечание проверки S7b в).
  let using = false
  let useAt = 0
  let hitAt = 0
  const onHurt = (pk: any) => {
    if (!using || !bot.entity || !ownHit(pk, bot.entity.id, e.id)) return
    hitAt = clock.now()
  }
  try { bot._client.on('damage_event', onHurt) } catch {}
  const stopUse = () => { if (using) { using = false; try { bot.deactivateItem() } catch {} } }
  try {
    while (valid() && out.passes < passes && clock.now() - t0 < maxMs && sky.gliding(bot.entity)) {
      if (sky.rocketCount(bot) < 1 || (bot.health ?? 0) < 6) break
      // 1) Разбег: точка на его стороне от нас за 17 бл., высота cruiseY. (s7h/s7j: копьё «использовать» уже на
      // развороте к нему дало касаний 15 % и 8 % против 30 % в s7f — откатил; копьё — в заходе, по времени до касания.)
      const side = yawTo(foe(), bot.entity.position)
      const runUp = () => { const f = foe(); const L = sky.lookVec(side, 0); return new Vec3(f.x + L.x * 17, cruiseY(), f.z + L.z * 17) }
      const inside = (p: any) => !arena || (Math.abs(p.x - arena.x) <= arena.r - 3 && Math.abs(p.z - arena.z) <= arena.r - 3)
      const climb = await sky.fly(bot, ctl, {
        maxMs: 4000, stats, phase: 'таран: разбег',
        goal: () => { const P = runUp(); if (!inside(P)) { const f = foe(); P.x = f.x + (P.x - f.x) * 0.6; P.z = f.z + (P.z - f.z) * 0.6 } return { kind: 'point', at: P, reach: true, minY: foe().y + 3, maxY: ceilY(), gap: 3, speedMin: 0.5 } },
        rocketIf: (s: any) => (s.p.y < foe().y + 4 || Math.hypot(s.v.x, s.v.z) < 0.5) ? true : null,
        noRocket: () => sky.rocketCount(bot) <= 1,
        onTick: () => { if (allow) allow() },
        until: () => {
          if (!valid()) return 'цель пропала'
          const me = bot.entity.position; const f = foe()
          const dh = Math.hypot(me.x - f.x, me.z - f.z)
          return dh >= 13 && me.y >= f.y + 3.5 ? 'разбег' : null
        }
      })
      if (climb.why !== 'разбег' && climb.why !== 'долго') break
      if (!valid() || !sky.gliding(bot.entity)) break
      // 2) Заход: к нему (ракета, если медленно), затем «использовать» копьё; взгляд — chooseLance.
      out.passes++
      stats.lancePasses = (stats.lancePasses || 0) + 1
      const hp1 = ehpTele(bot, e)
      hitAt = 0
      S.phase = 'таран: заход'
      const res: any = await new Promise<any>(resolve => {
        let done = false
        let rocket = (!using && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 1.1 && sky.rocketCount(bot) > 1 && !(bot.fireworkRocketDuration > 0)) ? 'нужна' : 'нет'
        let minD = Infinity; let growing = 0
        const tR = clock.now()
        let best: any = null
        let close: any = null
        let planned = 0
        S.driving = (S.driving || 0) + 1
        const fin = (why: string) => { if (done) return; done = true; S.driving = Math.max(0, (S.driving || 1) - 1); bot.removeListener('physicsTick', onT); resolve({ why, best, close, planned }) }
        const onT = () => {
          if (done) return
          try {
            // Попадание — раньше «прервали»: таран, убивший его, обрывает бой в тот же тик (s7e р.1: «прервали» при смерти цели).
            if (hitAt) return fin('попал')
            if (!valid()) return fin(e && e.isValid === false && using ? 'цель пропала' : 'прервали')
            const b = bot.entity
            if (b.onGround) return fin('сел')
            if (!b.elytraFlying && clock.now() - S.startedAt > 400) return fin('полёт кончился')
            if (allow) allow()
            if (clock.now() - tR > 4500) return fin('долго')
            const f = foe()
            // Его копьё «на изготовке» и смотрит на нас: встречный разгон — отн. скорость = моя + его, урон обоим
            // (KineticWeapon: rel = взгляд·его − взгляд·моя для него); s7e р.4 — таран в его копьё: себе −15.
            if (spearBraced(bot, e) && facing(e, b.position) > 0.6 && Math.hypot(f.x - b.position.x, f.z - b.position.z) < 14) return fin('его копьё на изготовке')
            const eye = b.position.offset(0, EYE_FLY, 0)
            const dist = Math.hypot(f.x - eye.x, f.y + hisH() / 2 - eye.y, f.z - eye.z)
            if (dist < minD - 0.05) {
              minD = dist; growing = 0
              const v = b.velocity
              close = { d: r2(dist), dy: r2(b.position.y - f.y), sp: r2(Math.hypot(v.x, v.y, v.z)), use: using ? Math.round((clock.now() - useAt) / 50) : -1, plan: best ? best.hitT : null }
            } else if (++growing >= 4 && minD < 8) return fin('мимо')
            const st = { p: b.position, v: b.velocity, boost: bot.fireworkRocketDuration || 0, fd: S.fd }
            const readyIn = using ? Math.max(0, Math.round(spec.delay * 20) + 1 - Math.round((clock.now() - useAt) / 50)) : Math.round(spec.delay * 20) + 1
            const pl = chooseLance(W, st, footAt, { h: hisH(), hisV: hv(), name, readyIn })
            // Касание раньше конца задержки копья урона не даст — только считаем (s7h: отказ от таких планов уронил
            // касания 30 % → 15 %: без плана проход шёл «над головой» мимо; задержку решает ранний старт копья).
            const delayT = Math.round(spec.delay * 20) + 1
            if (pl && (!using || (clock.now() - useAt) / 50 + pl.hitT < delayT)) stats.lanceEarly = (stats.lanceEarly || 0) + 1
            let look: any
            if (pl) { best = pl; planned++; look = pl } else {
              // Не достаём из этих взглядов — к точке над его головой (с упреждением), не ниже пола + 2.
              look = sky.choose(W, st, { kind: 'point', at: (t: number) => footAt(t).offset(0, hisH() + 0.8, 0), reach: true, gap: 2, speedMin: 0.8 })
            }
            // Страховка: этот взгляд за 6 тиков — в стену с уроном или в пол с высотой падения > 3 — выйти сейчас.
            const ahead = sky.rollout(W, st.p, st.v, look.yaw, look.pitch, st.boost, 6, { fd: st.fd })
            if ((ahead.kind === 'wall' && ahead.dmg >= 1) || (ahead.kind === 'floor' && ahead.fd > 3)) { stats.lanceBail = (stats.lanceBail || 0) + 1; return fin('опасно: ' + (ahead.kind === 'wall' ? 'стена' : 'пол')) }
            sky.steer(bot, look.yaw, look.pitch)
            if (rocket === 'нужна') {
              // Ракета уходит с взглядом этого тика (после пакета).
              rocket = 'была'
              spear.afterPacket(bot, () => { const fr = sky.fireRocket(bot); if (fr.ok) stats.rockets = (stats.rockets || 0) + 1 })
              return
            }
            // Копьё — после ракеты, так, чтобы задержка кончилась до касания (≈ дистанция / скорость тиков).
            const sp1 = Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z)
            const eta = (dist - 3) / Math.max(0.3, sp1) * 50
            if (!using && eta < delayMs + 4000) {
              if (bot.heldItem?.name === name) { bot.activateItem(); using = true; useAt = clock.now(); used('элитры: копьё к тарану') }
            }
            // Пол близко на пике — выйти, иначе удар о землю.
            const fl = W.floorBelow(b.position.x, b.position.y, b.position.z, 6)
            if (fl && b.position.y - fl.top < 1.2 && b.velocity.y < -0.45) return fin('пол близко')
            void useAt
          } catch (err: any) { fin('ошибка: ' + err.message) }
        }
        bot.on('physicsTick', onT)
      })
      stopUse()
      if (res.why === 'попал') {
        out.hits++
        stats.lanceHits = (stats.lanceHits || 0) + 1
        // Сколько снял (телеметрия, метаданные): хп приходит позже события удара — минимум за 0.5 с.
        let hpMin = ehpTele(bot, e)
        const tH = clock.now()
        // Убил (сущность снята — с do_immediate_respawn раньше метаданных с хп 0) — снял всё, что было (hp1);
        // раньше hpMin оставался равен hp1 и убийство писалось «снял 0» (замечание проверки S7b в).
        const onH = () => { const h = ehpTele(bot, e); if (h != null && (hpMin == null || h < hpMin)) hpMin = h; if (clock.now() - tH > 500 || e.isValid === false) { bot.removeListener('physicsTick', onH); const dealt = e.isValid === false && hp1 != null ? hp1 : (hp1 != null && hpMin != null ? Math.max(0, hp1 - hpMin) : null); if (dealt != null) { out.dealt += dealt; (stats.lanceDealt = stats.lanceDealt || []).push(r2(dealt)) } } }
        bot.on('physicsTick', onH)
        used(`элитры: таран копьём — попал${res.best ? ` (план ${res.best.dmg}, ${res.best.rel} бл/с)` : ''}`)
      } else used(`элитры: таран — ${res.why}`)
      // Разбор захода (s7b): ближе всего (до его середины), высота над ним, скорость б/т, тиков «использования»
      // копья к этому мигу (−1 — не начато), был ли план касания и сколько тиков из захода.
      const tr = stats.lanceTrace || (stats.lanceTrace = [])
      if (tr.length < 12) tr.push(`${res.why}: ближе ${res.close ? res.close.d : '?'} (dy ${res.close ? res.close.dy : '?'}, ${res.close ? res.close.sp : '?'} б/т, копьё ${res.close ? res.close.use : '?'} т), план ${res.planned} т`)
      if (!valid() || !sky.gliding(bot.entity)) break
      // 3) Выход вверх и прочь от стен: точка впереди по ходу на cruiseY.
      await sky.fly(bot, ctl, {
        maxMs: 1500, stats, phase: 'таран: выход',
        // Отказ от захода (его копьё на изготовке, опасный выход) — прочь от него, а не «по ходу» (по ходу — в его
        // копьё: s7j р.1 «таран — мимо, себе −20», встречный разгон убил тараном его копья).
        // Его копьё на изготовке (S7d, ревью Codex №5: один встречный таран на 33–49 бл/с решает бой, а отказ уходил
        // «прочь» по его же линии, без ракеты): уход дугой вбок от линии его захода (в сторону, противоположную его
        // боковому ходу), ракета — по цене (rocketChoice), если скорость мала.
        goal: () => {
          const b = bot.entity; const f = foe()
          let away = /копьё на изготовке|опасно/.test(res.why) ? yawTo(f, b.position) : Math.atan2(-b.velocity.x, -b.velocity.z)
          if (/копьё на изготовке/.test(res.why)) {
            const v = hv(); const rx = b.position.x - f.x; const rz = b.position.z - f.z
            const side = (v.x * rz - v.z * rx) >= 0 ? -1 : 1
            away += side * 1.0
          }
          const L = sky.lookVec(away, 0)
          return { kind: 'point', at: new Vec3(b.position.x + L.x * 10, cruiseY(), b.position.z + L.z * 10), minY: f.y + 3, maxY: ceilY(), gap: 3, speedMin: 0.4, away: f, awayR: 6 }
        },
        noRocket: () => !/копьё на изготовке/.test(res.why),
        rocketIf: (st: any) => Math.hypot(st.v.x, st.v.z) < 1.0 ? true : null,
        onTick: () => { if (allow) allow() },
        until: () => bot.entity.position.y >= foe().y + 3 && bot.entity.velocity.y < 0.3 ? 'вышел' : null
      })
    }
  } finally {
    stopUse()
    try { bot._client.removeListener('damage_event', onHurt) } catch {}
  }
  // 4) Посадка подальше от него, нагрудник назад.
  // Сесть — всегда, даже если бой уже кончился (убил в воздухе) или его прервали: элитры без руля — хуже любого
  // перехвата (тактика летать не умеет). Прерывает посадку только смерть. Бой кончился (ctl прерван) — посадка
  // идёт фоном, а отчёт возвращается сразу: иначе «стоп» арены обгонял отчёт дуэли (s7e: у обоих пустые ROUND).
  out.hit = out.hits > 0
  out.ok = true
  if ((bot.health ?? 0) <= 0) { out.note = `элитры: таран копьём ${out.passes} заход(а), попаданий ${out.hits} — погиб в воздухе`; stats.lanceDeaths = (stats.lanceDeaths || 0) + 1; return out }
  const finish = async () => {
    let l: any = { ok: !!bot.entity.onGround }
    if (!bot.entity.elytraFlying && !bot.entity.onGround && (bot.health ?? 0) > 0) {
      // Полёт уже кончился (пол на заходе, касание) — дождаться земли и посчитать, чем обошлось.
      const hpF = bot.health ?? 20
      const tF = clock.now()
      while (!bot.entity.onGround && !bot.entity.isInWater && (bot.health ?? 0) > 0 && clock.now() - tF < 3000) await clock.sleep(50)
      const lostF = Math.max(0, hpF - (bot.health ?? 20))
      l = { ok: !!(bot.entity.onGround || bot.entity.isInWater) && lostF < 0.5, why: lostF >= 0.5 ? `упал −${r2(lostF)}` : 'сел без полёта', lost: lostF }
    }
    if (bot.entity.elytraFlying) {
      const landCtl = { get aborted () { return (bot.health ?? 0) <= 0 } }
      const inside = arena ? (x: number, z: number) => Math.abs(x - arena.x) <= arena.r - 1 && Math.abs(z - arena.z) <= arena.r - 1 : null
      const live = e && e.isValid !== false && e.position
      const spot = sky.landingSpot(bot, W, { near: bot.entity.position, away: live ? foe() : null, floorY: live ? foe().y : null, radius: 16, inside })
      l = await sky.land(bot, landCtl, { at: spot, away: live ? foe() : null, stats })
    }
    await clock.sleep(150)
    if ((bot.health ?? 0) > 0 && !/_chestplate$/.test(bot.inventory.slots[6]?.name || '')) await sky.chestDown(bot, ctl, { stats })
    if (!l.ok) stats.lanceBadLand = (stats.lanceBadLand || 0) + 1
    return l
  }
  const account = (l: any) => {
    const hisHp1 = e ? healthOf(bot, e) : null
    out.self = r2(Math.max(0, hp0 - (bot.health ?? 20)))
    out.total = hisHp0 != null && hisHp1 != null ? r2(Math.max(0, hisHp0 - hisHp1)) : null
    out.landed = !!l.ok
    out.ms = clock.now() - t0
    stats.lanceSelf = r2((stats.lanceSelf || 0) + out.self)
    out.note = `элитры: таран копьём ${out.passes} заход(а), попаданий ${out.hits}${out.dealt ? `, снял ${r2(out.dealt)}` : ''}${out.self ? `, себе −${out.self}` : ''}, посадка ${l.ok ? 'цела' : (l.why || '?')}`
  }
  if (ctl.aborted && bot.entity.elytraFlying) {
    finish().then(account).catch(() => {})
    out.note = `элитры: таран копьём ${out.passes} заход(а), попаданий ${out.hits}${out.dealt ? `, снял ${r2(out.dealt)}` : ''} — бой кончился в воздухе, сажусь`
    return out
  }
  account(await finish())
  return out
}
