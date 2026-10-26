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
//    выбивает (Weapon(1), без disableBlocking) — щит держит только спереди: таран не планируем, лишь когда он смотрит на нас;
//  * ракета до копья: mainhand fallback меняет слот и сбрасывает use;
//    offhand firework сам server use копья не сбрасывает.
import * as clock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as sky from '../elytra'
import * as spear from '../spear'
import { leadTarget } from '../bow/track'
import { hitboxOf, rayBox } from '../pick'
import { observedCollision } from '../pvp/search'
import { ROCKET_MAX_TICKS } from '../elytra/consts'
import { damageTypeName } from '../gamedata'

const EYE_FLY = 0.4
const MIN_R = 2.0
const MAX_R = 4.5
const MARGIN = 0.125
const r2 = (x: number) => Math.round(x * 100) / 100
const wrap = (a: number) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
const yawTo = (a: any, b: any) => Math.atan2(-(b.x - a.x), -(b.z - a.z))

function lancePoint (p: any, arena: any) {
  if (!arena) return p
  const r = Math.max(0, arena.r - 3)
  return new Vec3(Math.max(arena.x - r, Math.min(arena.x + r, p.x)), p.y,
    Math.max(arena.z - r, Math.min(arena.z + r, p.z)))
}

type V = { x: number; y: number; z: number }
type LanceClip = (eye: V, direction: V, range: number) => number

// Native cell traversal, observed COLLIDER shapes; packet-only terrain stays solid.
export function lanceCollider (world: { blockAt: (p: any) => any }): LanceClip {
  const { RaycastIterator } = require('prismarine-world').iterators
  return (eye, direction, range) => {
    const from = new Vec3(eye.x, eye.y, eye.z), dir = new Vec3(direction.x, direction.y, direction.z)
    const iterator = new RaycastIterator(from, dir, range)
    try {
      for (let cell = from.floored(); cell; cell = iterator.next()) {
        const p = new Vec3(cell.x, cell.y, cell.z), block = world.blockAt(p)
        const shapes = block?.shapes ?? (!block || block.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : [])
        let nearest = range
        for (const s of shapes) {
          const t = rayBox(from, dir, { x: p.x + s[0], y: p.y + s[1], z: p.z + s[2] },
            { x: p.x + s[3], y: p.y + s[4], z: p.z + s[5] }, range)
          if (t != null) nearest = Math.min(nearest, t)
        }
        if (nearest < range) return nearest
      }
      return range
    } catch { return 0 }
  }
}

// ProjectileUtil: clip eyes→end, contains bare(start), bare.clip, then grown→bare through COLLIDER.
// AABB.clip ищет вход из-за границы: start внутри одного margin не даёт попадания.
export function lanceHits (eye: V, L: V, v: V, foot: V, h = 1.8, w = 0.6, clip: LanceClip = null): boolean {
  const range = MAX_R + Math.max(0, L.x * v.x + L.y * v.y + L.z * v.z)
  const tMax = clip ? Math.min(range, clip(eye, L, range)) : range
  if (!(tMax >= MIN_R)) return false
  const start = { x: eye.x + L.x * MIN_R, y: eye.y + L.y * MIN_R, z: eye.z + L.z * MIN_R }
  const hw = w / 2
  if (start.x >= foot.x - hw && start.x < foot.x + hw &&
      start.y >= foot.y && start.y < foot.y + h &&
      start.z >= foot.z - hw && start.z < foot.z + hw) return true
  const target = { position: foot, height: h, width: w }
  const bare = spear.rayBox(eye, L, target, 0)
  if (bare && bare.tIn > MIN_R && bare.tIn < tMax) return true
  const grown = spear.rayBox(eye, L, target, MARGIN)
  if (!grown || !(grown.tIn > MIN_R && grown.tIn < tMax)) return false
  if (!clip) return true
  const entry = new Vec3(eye.x + L.x * grown.tIn, eye.y + L.y * grown.tIn, eye.z + L.z * grown.tIn)
  const toCenter = new Vec3(foot.x, foot.y + h / 2, foot.z).minus(entry), distance = toCenter.norm()
  const direction = toCenter.scaled(1 / distance)
  const inner = spear.rayBox(entry, direction, target, 0)
  return !!inner && inner.tIn > 0 && inner.tIn < Math.min(distance, clip(entry, direction, distance))
}

// Базовый урон KineticWeapon до чар и брони; damage condition также требует mine >= 0.
export function lanceDamage (name: string, L: V, myV: V, hisV: V = { x: 0, y: 0, z: 0 }) {
  const spec = spear.SPEARS[name]
  const mine = (L.x * myV.x + L.y * myV.y + L.z * myV.z) * 20
  const his = (L.x * (hisV.x || 0) + L.y * (hisV.y || 0) + L.z * (hisV.z || 0)) * 20
  const rel = Math.max(0, mine - his)
  const dmg = spec && mine >= 0 && rel >= spear.DMG_REL ? 1 + Math.floor(rel * spec.mult) : 0
  return { rel: r2(rel), dmg, knock: mine >= spear.KB_SPEED }
}

const YAW_OFF = [0, 0.05, -0.05, 0.12, -0.12, 0.22, -0.22, 0.35, -0.35, 0.55, -0.55]
const PITCHES = [-1.0, -0.8, -0.62, -0.48, -0.36, -0.26, -0.17, -0.09, 0, 0.09, 0.2, 0.34]

// Взгляд на этот тик, при котором полёт (своя физика elytra.rollout) за H тиков проводит его рамку через отрезок
// копья, и после касания есть выход вверх без пола/стены. foot(t) — его ноги через t тиков, h — его рамка.
// hitT — тики до касания: 0 — следующий отправленный шаг (сервер проверяет копьё в позиции после хода с новым взглядом;
// c40–c41: отсчёт «от текущего, уже отправленного» давал ложное «касание сейчас» — попаданий на заход 0.42 → 0.17).
export function chooseLance (W: any, st: { p: V; v: V; boost: number; fd: number }, foot: (t: number) => V, { h = 1.8, hisV = { x: 0, y: 0, z: 0 }, name = 'iron_spear', H = 16, readyIn = 0, arena = null, clip = null }: any = {}) {
  const feet = Array.from({ length: H + 1 }, (_, t) => foot(t))
  const f0 = feet[0]
  const bearing = yawTo(st.p, f0)
  const hs = Math.hypot(st.v.x, st.v.z)
  const heading = hs > 0.2 ? Math.atan2(-st.v.x, -st.v.z) : bearing
  const yaws = new Set<number>()
  for (const o of YAW_OFF) { yaws.add(wrap(bearing + o)); yaws.add(wrap(heading + o)) }
  const looks = new Map<number, number[]>([...yaws].map(yaw => [yaw, PITCHES]))
  // Летун (рамка 0.6, Codex 23.10): взгляд на каждый будущий тик — от своих будущих глаз в середину его рамки, три уточнения.
  const pair = h <= 0.6 && process.env.ND_LANCE_PAIR !== '0'
  if (pair) for (let t = 1; t <= H; t++) {
    let yaw = bearing; let pitch = 0
    // ponytail: три уточнения прицела; не хватит — добавить затравки.
    for (let i = 0; i < 3; i++) {
      const r = sky.rollout(W, st.p, st.v, yaw, pitch, st.boost, t, { fd: st.fd, arena })
      const f = feet[t]
      yaw = yawTo(r.p, f)
      pitch = Math.atan2(f.y + h / 2 - r.p.y - EYE_FLY, Math.hypot(f.x - r.p.x, f.z - r.p.z))
    }
    looks.set(yaw, [...(looks.get(yaw) || []), pitch])
  }
  let best: any = null
  for (const [yaw, pitches] of looks) {
    for (const pitch of pitches) {
      const r = sky.rollout(W, st.p, st.v, yaw, pitch, st.boost, H, { fd: st.fd, keepPath: true, arena })
      const L = sky.lookVec(yaw, pitch)
      const path = r.path || []
      let hit: any = null
      let early: any = null
      for (let t = 0; t < path.length && !hit; t++) {
        const q = path[t]
        const v = { x: q.vx, y: q.vy, z: q.vz }
        if (!lanceHits({ x: q.x, y: q.y + EYE_FLY, z: q.z }, L, v, feet[t + 1], h)) continue
        const a = feet[t], b = feet[t + 1]
        // Его скорость в миг касания — по тому же прогнозу (у летуна постоянная hisV давала планы без урона).
        const hitV = pair ? { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z } : hisV
        const dm = lanceDamage(name, L, v, hitV)
        if (dm.dmg > 0) {
          if (clip && !lanceHits({ x: q.x, y: q.y + EYE_FLY, z: q.z }, L, v, feet[t + 1], h, .6, clip)) continue
          const contact = { t, q, ...dm }
          if (t + 1 >= readyIn) hit = contact
          else if (!early) early = contact
        }
      }
      if (!hit) hit = early
      if (!hit) continue
      // Столкнулись раньше касания — не годится.
      if (r.kind && r.t <= hit.t) continue
      // Выход: с точки касания тянуть вверх (pitch 0.6) 12 тиков — без стены и без жёсткого пола.
      const out = sky.rollout(W, hit.q, { x: hit.q.vx, y: hit.q.vy, z: hit.q.vz }, yaw, 0.6, Math.max(0, st.boost - hit.t - 1), 12, { fd: hit.q.fd, arena })
      if (out.kind === 'outside') continue
      // Выход в стену или в пол — цена, а не запрет (S7d, «гибкость вместо правил»): урон себе на выходе
      // (о стену 10·Δv − 3, падение fd − 3) весит вдвое больше урона ему; такой заход берётся, только если иначе
      // нечем (страховка «опасно» по 6 тикам вперёд в заходе остаётся).
      const exitSelf = out.kind === 'wall' ? Math.max(0, out.dmg) : out.kind === 'floor' ? Math.max(0, out.fd - 3) : 0
      // Касание раньше конца задержки копья (useTicks < delay) урона не даёт (KineticWeapon) — цена, а не запрет
      // (S7d: s7d-base — «мимо: ближе 0.2, копьё 10 т» при задержке 12; s7h отказ от ранних планов уронил касания —
      // без плана проход шёл над головой): каждый недостающий тик — +3, дуга подлиннее выигрывает у прямой.
      const ready = hit.t + 1 >= readyIn
      let c = hit.t - Math.min(40, hit.dmg) * 0.15 + Math.abs(pitch) * 0.3 + exitSelf * 2 + Math.max(0, readyIn - (hit.t + 1)) * 3
      if (out.kind === 'floor') c += 8
      if (out.kind === 'ceil') c += 60 + (12 - out.t) * 3
      if (!best || c < best.c) best = { c, yaw, pitch, hitT: hit.t, dmg: ready ? hit.dmg : 0, rel: hit.rel, ready, exit: out.kind || null }
    }
  }
  return best
}

// Касание тарана — только damage_event цели, причина которого — я (sourceCauseId = id + 1; 0 — без причины).
// Страховка захода по 6 тикам прямого полёта: отказ «стена»/«пол» или null — заходим.
// Пол раньше касания копьём — выход; касание раньше пола — заход по стоящему на земле (показ 09.10: по человеку на земле
// 3 из 6 заходов бросались за 9 бл., бот кружил). Стена за ним (c33: 25 из 31 отказа — касание готовым копьём на 0–4 т,
// стена за целью на 4–5 т) — заход, если касание раньше стены на 3 т (damage_event до начала выхода) и выход плана чист.
export function aheadBail (ahead: any, pl: any): 'стена' | 'пол' | null {
  const hitFirst = (gap: number) => !!pl?.ready && pl.hitT + gap <= ahead.t
  if (ahead.kind === 'wall' && ahead.dmg >= 1) return hitFirst(3) && pl.exit !== 'wall' ? null : 'стена'
  if (ahead.kind === 'floor' && ahead.fd > 3 && !hitFirst(0)) return 'пол'
  return null
}

export function ownHit (pk: any, myId: number, foeId: number): boolean {
  return !!pk && pk.entityId === foeId && pk.sourceCauseId === myId + 1
}

/** Item.Properties.spear sets DAMAGE_TYPE=SPEAR; a kinetic contact has our direct and causal entity IDs. */
export function ownSpearHit(pk: any, myId: number, foeId: number): boolean {
  return ownHit(pk, myId, foeId) && pk.sourceDirectId === myId + 1 && damageTypeName(pk.sourceTypeId) === 'spear'
}

// Годится ли таран сейчас (на земле или уже в полёте): элитры, ≥3 простых ракет, копьё, хп, место над собой и над ним,
// его щит не в деле. Нагрудник не нужен: есть — после посадки вернётся на тело (lanceLand), нет — элитры на теле ничего
// не отнимают. Требование нагрудника не пускало на таран голых с элитрами, копьём и ракетами (стенд 21.10, ARMS_AIR=1:
// у 29 синих — ни одного тарана, у чемпиона в незерите — 4 убийства копьём за 2 минуты).
// Щит у него — не запрет (пользователь 24.10: «пускай пробуют копьём на того, у кого щит — в несколько игроков пробьют»):
// щит держит спереди, а рой заходит со всех сторон; отказ — только тому, на кого он сейчас смотрит.
export function lancePlan (bot: any, e: any, { d, hp, hisShield = false }: any = {}) {
  if (!sky.ON || hisShield && bot.entity?.position && e?.position && facing(e, bot.entity.position) > 0.5) return null
  const k = sky.kit(bot)
  const sp = spear.spearOf(bot)
  if (!k.elytra || k.rockets < 3 || !sp) return null
  if (!bot.entity || bot.entity.isInWater || !e || !e.position) return null
  if (hp < 8 || !(d >= 3) || d > 40) return null
  const W = sky.worldOf(bot)
  if (!sky.gliding(bot.entity) && sky.headroom(W, bot.entity.position, 10) < 8) return null
  // Место над ним — для захода сверху на стоящего; летящего под потолком бьём сбоку (показ 09.10: дезматч у потолка —
  // таран запрещался, полёт уходил перехвату, боты кружили).
  if (!sky.gliding(e) && sky.headroom(W, e.position, 6) < 4) return null
  return { kind: 'lance', spear: sp.item.name }
}

// Он держит «использовать» копьём (living_entity_flags 0x01, рука — 0x02) и куда смотрит (косинус к точке).
function spearBraced (bot: any, e: any): boolean {
  if (e._ndVisible === false) return false
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

export function lancePincerFrom (bot: any, e: any) {
  const pin = bot._ndPincer
  return pin && pin.until > clock.now() && pin.target === (e.username || e.name) ? pin.from : null
}

// Бок/тыл по видимому yaw. Клещи выбирают ближайшую допустимую сторону к зеркалу союзника.
export function lanceFlankPoint (from: V, e: any, y: number, arena: any = null, pinFrom: V = null) {
  const f = e.position
  const preferred = pinFrom ? yawTo(f, { x: 2 * f.x - pinFrom.x, y, z: 2 * f.z - pinFrom.z }) : yawTo(f, from)
  const point = (yaw: number) => { const L = sky.lookVec(yaw, 0); return lancePoint(new Vec3(f.x + L.x * 17, y, f.z + L.z * 17), arena) }
  if (!Number.isFinite(e.yaw)) return point(preferred)
  const wanted = point(preferred), front = sky.lookVec(e.yaw, 0)
  const candidates = [preferred, e.yaw + Math.PI, e.yaw + Math.PI / 2, e.yaw - Math.PI / 2].map(point)
  const rear = candidates.filter(p => (p.x - f.x) * front.x + (p.z - f.z) * front.z <= 1e-9)
  const distance = (p: V) => Math.hypot(p.x - (pinFrom ? wanted.x : from.x), p.z - (pinFrom ? wanted.z : from.z))
  return (rear.length ? rear : candidates).sort((a, b) => distance(a) - distance(b))[0]
}

// Телеметрия урона (не решения): здоровье + поглощение по метаданным — яблоко «съедало» таран в 0 (s7f).
function ehpTele (bot: any, e: any): number | null {
  const h = healthOf(bot, e)
  if (h == null) return null
  try { return h + ((require('../read') as typeof import('../read')).absorptionOf(bot, e) || 0) } catch { return h }
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
export async function lance (bot: any, ctl: { aborted: boolean }, e: any, { vel = () => ({ x: 0, y: 0, z: 0 }), stats = {} as any, used = (_: string) => {}, allow = null as any, maxMs = 45000, passes = 8, arena = null as any, telemetryHp = e => ehpTele(bot, e), afterPass = null }: any = {}) {
  const ln = lanceContext(bot, ctl, e, { vel, stats, used, allow, maxMs, passes, arena, telemetryHp })
  const { t0, out, valid, sp, onHurt, stopUse } = ln
  if (!sp) { out.note = 'таран: копья нет'; return out }
  const name = sp.item.name
  const spec = spear.SPEARS[name]
  const delayMs = Math.round(spec.delay * 20) * 50
  Object.assign(ln, { name, spec, delayMs })
  const early = await lanceMount(ln)
  if (early) return early
  stats.lances = (stats.lances || 0) + 1
  used('элитры: таран копьём — разбег')
  try { bot._client.on('damage_event', onHurt) } catch {}
  const flight = { target: e.username || e.name }
  ln.S.lance = flight
  try {
    while (valid() && out.passes < passes && clock.now() - t0 < maxMs && sky.gliding(bot.entity)) {
      if (sky.rocketCount(bot) < 1 || (bot.health ?? 0) < 6) break
      // После пике возвращаем ракеты в левую, копьё — в правую до разбега и зарядки.
      try {
        const rocket = bot.inventory.items().find(sky.plainRocket)
        if (rocket && !sky.plainRocket(bot.inventory.slots[45])) await bot.equip(rocket, 'off-hand')
        if (!valid()) break
        if (bot.heldItem?.name !== name) await bot.equip(sp.item, 'hand')
      } catch { break }
      if (!valid() || bot.heldItem?.name !== name || !sky.plainRocket(bot.inventory.slots[45])) break
      const climb = await lanceRunUp(ln)
      if (climb.why !== 'разбег' && climb.why !== 'долго') break
      if (!valid() || !sky.gliding(bot.entity)) break
      const res = await lanceApproach(ln)
      if (!valid() || !sky.gliding(bot.entity)) break
      await lanceExit(ln, res)
      if (valid() && sky.gliding(bot.entity) && /^(попал|мимо)$/.test(res.why) && afterPass) {
        const combo = await afterPass(ln.ctl)
        if (combo?.hit) { out.hit = true; out.maceHits = (out.maceHits || 0) + 1 }
      }
    }
  } finally {
    if (ln.S.lance === flight) delete ln.S.lance
    stopUse()
    try { bot._client.removeListener('damage_event', onHurt) } catch {}
  }
  return lanceLand(ln)
}

// Один таран — прежние параметры и const тела lance; using/useAt/hitAt — копьё «в деле» и время его касания.
interface LanceCtx {
  bot: any; ctl: { aborted: boolean }; e: any; vel: () => any; stats: any; used: (s: string) => void; allow: any; maxMs: number; passes: number
  arena: any; telemetryHp: (e: any) => number | null; W: any; S: any; t0: number; out: any; hp0: number; hisHp0: number | null
  valid: () => any; sp: any; name: string; spec: any; delayMs: number
  foe: () => any; hisH: () => number; hv: () => any; footAt: (t: number) => any; ceilY: () => number; cruiseY: () => number
  using: boolean; useAt: number; hitAt: number; onHurt: (pk: any) => void; stopUse: () => void; clip: LanceClip
}

function lanceContext (bot: any, ctl: { aborted: boolean }, e: any, { vel, stats, used, allow, maxMs, passes, arena, telemetryHp }: any): LanceCtx {
  const W = sky.worldOf(bot)
  const S = sky.install(bot)
  ctl = sky.flightControl(bot, ctl)
  const t0 = clock.now()
  const out: any = { ok: false, hit: false, passes: 0, hits: 0, dealt: 0, note: '' }
  const hp0 = bot.health ?? 20
  const hisHp0 = telemetryHp(e)
  const valid = () => !ctl.aborted && (bot.health ?? 0) > 0 && e && e.isValid !== false && e.position
  const sp = spear.spearOf(bot)
  const foe = () => e.position
  const hisH = () => hitboxOf(bot, e).h
  // Его скорость — без NaN (bow.trackTarget изредка отдаёт NaN, s7 р.1): нечисло = 0.
  // И не больше 3 б/т по оси (рывок от удара/телепорт давали «план 230 урона, 237 бл/с» в s7f; летун с ракетой — до ~2.2).
  const hv = () => { const v = vel() || {}; const n = (x: any) => Number.isFinite(x) ? Math.max(-3, Math.min(3, x)) : 0; return { x: n(v.x), y: n(v.y), z: n(v.z), ageTicks: Number.isFinite(v.ageTicks) ? Math.max(0, v.ageTicks) : 0 } }
  const footAt = leadTarget(e, hv, bot, 0)
  const ceilY = () => sky.arenaAround(bot, W, bot.entity.position).ceilY - 1.8 - 1.4
  const cruiseY = () => Math.min(ceilY(), foe().y + 7)
  const ln: LanceCtx = { bot, ctl, e, vel, stats, used, allow, maxMs, passes, arena, telemetryHp, W, S, t0, out, hp0, hisHp0, valid, sp,
    name: null, spec: null, delayMs: 0, foe, hisH, hv, footAt, ceilY, cruiseY, using: false, useAt: 0, hitAt: 0, onHurt: null, stopUse: null,
    clip: lanceCollider(observedCollision(bot)) }
  // Попадание — его damage_event, причина которого — я (sourceCauseId = мой id + 1), пока копьё «в деле».
  // entityHurt без источника (падение, кинетическая, его кристалл) касанием не считается (замечание проверки S7b в).
  const onHurt = (pk: any) => {
    if (!ln.using || !bot.entity || !ownSpearHit(pk, bot.entity.id, e.id)) return
    ln.hitAt = clock.now()
  }
  const stopUse = () => { if (ln.using) { ln.using = false; try { if ((ctl as any)._ndFlightOwner.active) bot.deactivateItem() } catch {} } }
  Object.assign(ln, { onHurt, stopUse })
  return ln
}

// Земля: элитры, ракеты, копьё; не в полёте — взлёт. Не вышло — итог (out) с причиной, вышло — ничего.
async function lanceMount (ln: LanceCtx) {
  const { bot, ctl, stats, allow, arena, out, sp, name, foe } = ln
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
  if (!sky.gliding(bot.entity)) {
    const away = yawTo(foe(), bot.entity.position)
    const to = await sky.takeoff(bot, ctl, { pitch: 1.05, yaw: away, stats, arena })
    if (!to.ok) { await sky.chestDown(bot, ctl, { stats, arena }); out.note = 'таран: не взлетел — ' + to.why; return out }
  }
}

async function lanceRunUp (ln: LanceCtx) {
  const { bot, ctl, e, stats, used, allow, arena, valid, name, foe, ceilY, cruiseY } = ln
  ln.S.phase = 'таран: разбег'
  // 1) Разбег: точка на его стороне от нас за 17 бл., высота cruiseY. (s7h/s7j: копьё «использовать» уже на
  // развороте к нему дало касаний 15 % и 8 % против 30 % в s7f — откатил; копьё — в заходе, по времени до касания.)
  // Клещи (командный бой, 10.10): напарник заходит на ту же цель — разбег на противоположной от него стороне,
  // увернувшись от одного, цель подставится второму. Подсказку даёт свой (assist pincer), живёт 6 с.
  const pinFrom = lancePincerFrom(bot, e)
  const side = pinFrom ? yawTo(foe(), { x: 2 * foe().x - pinFrom.x, y: 0, z: 2 * foe().z - pinFrom.z }) : yawTo(foe(), bot.entity.position)
  if (pinFrom) stats.pincers = (stats.pincers || 0) + 1
  let flankSide: number | null = null
  const runUp = () => {
    const f = foe(), raised = spearBraced(bot, e) && Number.isFinite(e.yaw)
    // Сторона выбрана по видимому прицелу один раз за разбег: не гоняем точку за каждым его поворотом.
    if (raised && flankSide == null) flankSide = yawTo(f, lanceFlankPoint(bot.entity.position, e, cruiseY(), arena, pinFrom))
    const L = sky.lookVec(raised && flankSide != null ? flankSide : side, 0)
    return lancePoint(new Vec3(f.x + L.x * 17, cruiseY(), f.z + L.z * 17), arena)
  }
  // Показ 09.10: у стены точка разбега ужата до ~10 бл., а разворот ждал 13 — бот кружил до «долго» (4 с).
  // Разворот — по фактической длине разбега (не дальше 13).
  let runR = 13
  const climb = await sky.fly(bot, ctl, { arena,
    maxMs: 4000, stats, phase: 'таран: разбег',
    goal: () => { const P = runUp(); const f = foe(); runR = Math.max(0, Math.min(13, Math.hypot(P.x - f.x, P.z - f.z) - 1.5)); return { kind: 'point', at: P, reach: true, minY: foe().y + 3, maxY: ceilY(), gap: 3, speedMin: 0.5 } },
    rocketIf: (s: any) => (s.p.y < foe().y + 4 || Math.hypot(s.v.x, s.v.z) < 0.5) ? true : null,
    noRocket: () => sky.rocketCount(bot) <= 1,
    onTick: () => {
      if (allow) allow()
      // Показ 09.10: заход ~10 т, задержка железного копья 13 т — пролёт в 1.3 бл. над ним «копьё 11 т», мимо.
      // Копьё — в конце разбега (≥ 10 бл. от него, ~5 т до разворота): к касанию готово, окно урона 11 с.
      const me = bot.entity.position; const f = foe()
      if (!ln.using && bot.heldItem?.name === name && Math.hypot(me.x - f.x, me.z - f.z) >= 10) {
        bot.activateItem(); ln.using = true; ln.useAt = clock.now(); used('элитры: копьё к тарану (в конце разбега)')
      }
    },
    until: () => {
      if (!valid()) return 'цель пропала'
      const me = bot.entity.position; const f = foe()
      const dh = Math.hypot(me.x - f.x, me.z - f.z), P = runUp()
      // Радиальной дальности мало: при обходе сначала дойти до выбранной стороны. Допуск — прежний недобор радиуса.
      if (flankSide != null && spearBraced(bot, e) && Math.hypot(me.x - P.x, me.z - P.z) > Math.max(1.5, Math.hypot(P.x - f.x, P.z - f.z) - runR)) return null
      // Выше него на 3.5 — если потолок пускает; он под потолком — хватит высоты потолка (иначе круги до «долго»).
      return dh >= runR && me.y >= Math.min(f.y + 3.5, ceilY() - 1) ? 'разбег' : null
    }
  })
  return climb
}

// Заход до касания или отказа и его разбор: попадание, снятое хп, след захода (lanceTrace).
async function lanceApproach (ln: LanceCtx) {
  const { bot, e, stats, used, allow, arena, telemetryHp, W, S, out, valid, name, spec, delayMs, foe, hisH, hv, footAt, stopUse } = ln
  // 2) Заход: к нему (ракета, если медленно), затем «использовать» копьё; взгляд — chooseLance.
  out.passes++
  stats.lancePasses = (stats.lancePasses || 0) + 1
  const hp1 = telemetryHp(e)
  ln.hitAt = 0
  S.phase = 'таран: заход'
  const res: any = await new Promise<any>(resolve => {
    let done = false
    let rocket = (!ln.using && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 1.1 && sky.rocketCount(bot) > 1 && !(bot.fireworkRocketDuration > 0)) ? 'нужна' : 'нет'
    let minD = Infinity; let growing = 0
    let prevF: any = null
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
        if (ln.hitAt) return fin('попал')
        if (!valid()) return fin(e && e.isValid === false && ln.using ? 'цель пропала' : 'прервали')
        const b = bot.entity
        if (b.onGround) return fin('сел')
        if (!b.elytraFlying && clock.now() - S.startedAt > 400) return fin('полёт кончился')
        if (allow) allow()
        if (clock.now() - tR > 4500) return fin('долго')
        const f = foe()
        // Его смещение за тик по позициям (трекер лука у летуна даёт 0) — для разбора промахов.
        const hd = prevF ? { x: f.x - prevF.x, y: f.y - prevF.y, z: f.z - prevF.z } : null
        prevF = { x: f.x, y: f.y, z: f.z }
        // Его копьё «на изготовке» и смотрит на нас: встречный разгон — отн. скорость = моя + его, урон обоим
        // (KineticWeapon: rel = взгляд·его − взгляд·моя для него); s7e р.4 — таран в его копьё: себе −15.
        if (spearBraced(bot, e) && facing(e, b.position) > 0.6 && Math.hypot(f.x - b.position.x, f.z - b.position.z) < 14) return fin('его копьё на изготовке')
        const eye = b.position.offset(0, EYE_FLY, 0)
        const dist = Math.hypot(f.x - eye.x, f.y + hisH() / 2 - eye.y, f.z - eye.z)
        const sampleAt = clock.now()
        const closest = dist < minD - 0.05
        if (closest) {
          minD = dist; growing = 0
          const v = b.velocity
          close = { closestAt: sampleAt, targetId: e.id,
            p: [b.position.x, b.position.y, b.position.z], targetP: [f.x, f.y, f.z], h: hisH(), look: [b.yaw, b.pitch], d: r2(dist), dy: r2(b.position.y - f.y), sp: r2(Math.hypot(v.x, v.y, v.z)), use: ln.using ? Math.round((clock.now() - ln.useAt) / 50) : -1, plan: null,
            ready: null, prel: null, hv: hv(), gl: !!e.elytraFlying, mv: [r2(v.x), r2(v.y), r2(v.z)], hd: hd && [r2(hd.x), r2(hd.y), r2(hd.z)],
            // Отн. скорость вдоль взгляда, бл/с (порог урона 4.6): по моей скорости и его смещению за тик.
            rel: hd ? r2(Math.max(0, ((L0 => L0.x * (v.x - hd.x) + L0.y * (v.y - hd.y) + L0.z * (v.z - hd.z))(sky.lookVec(b.yaw, b.pitch))) * 20)) : null }
        } else if (++growing >= 4 && minD < 8) {
          // Разбор промахов (c31: 24 «мимо» на 31 попадание) — строка на промах: ближе всего, его скорость, был ли готовый план.
          try { console.log('[lance-miss]', JSON.stringify({ at: clock.now(), ...close, hv: close?.hv && [r2(close.hv.x), r2(close.hv.y), r2(close.hv.z)], planned })) } catch {}
          return fin('мимо')
        }
        const st = { p: b.position, v: b.velocity, boost: bot.fireworkRocketDuration || 0, fd: S.fd }
        const readyIn = ln.using ? Math.max(0, Math.round(spec.delay * 20) + 1 - Math.round((clock.now() - ln.useAt) / 50)) : Math.round(spec.delay * 20) + 1
        const pl = chooseLance(W, st, footAt, { h: hisH(), hisV: hv(), name, readyIn, arena, clip: ln.clip })
        if (closest) Object.assign(close, {
          plan: pl?.hitT ?? null, ready: pl?.ready ?? null, prel: pl?.rel ?? null,
          readyIn, planAt: sampleAt, planHitAt: pl ? sampleAt + pl.hitT * 50 : null,
          planLook: pl ? [pl.yaw, pl.pitch] : null
        })
        // Касание раньше конца задержки копья урона не даст — только считаем (s7h: отказ от таких планов уронил
        // касания 30 % → 15 %: без плана проход шёл «над головой» мимо; задержку решает ранний старт копья).
        if (pl && !pl.ready) stats.lanceEarly = (stats.lanceEarly || 0) + 1
        let look: any
        if (pl) { best = pl; planned++; look = pl } else {
          // Не достаём из этих взглядов — к точке над его головой (с упреждением), не ниже пола + 2.
          // Летун (рамка 0.6): глаза — в середину рамки; «над головой +0.8» проносило над ним (try-lance 23.10: без плана
          // 241 промах из 280, dy +0.7). Стоящему — как было: копьё с высоты глаз проходит через рамку 1.8.
          const aimY = sky.gliding(e) && process.env.ND_LANCE_MID !== '0' ? hisH() / 2 - EYE_FLY : hisH() + 0.8
          look = sky.choose(W, st, { kind: 'point', at: (t: number) => footAt(t).offset(0, aimY, 0), reach: true, gap: 2, speedMin: 0.8, arena })
        }
        // Страховка: этот взгляд за 6 тиков — в стену с уроном или в пол с высотой падения > 3 — выйти сейчас.
        if (!look) return fin('граница арены')
        const ahead = sky.rollout(W, st.p, st.v, look.yaw, look.pitch, st.boost, 6, { fd: st.fd, arena })
        if (ahead.kind === 'outside') return fin('граница арены')
        const bail = aheadBail(ahead, pl)
        if (bail) {
          stats.lanceBail = (stats.lanceBail || 0) + 1
          // Разбор отказов (c29–c31: «стена» в трети заходов, причина не доказана) — строка на отказ: клетки рамки в точке
          // удара (W.at и блок клиента), рамка 1.8 против 0.6, высота над собой и над ним (Codex 22.10).
          try {
            const xyz = (p: any) => [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)], q = ahead.p, cells = []
            for (let x = Math.floor(q.x - .3); x <= Math.floor(q.x + .3); x++)
              for (let y = Math.floor(q.y); y <= Math.floor(q.y + 1.8); y++)
                for (let z = Math.floor(q.z - .3); z <= Math.floor(q.z + .3); z++)
                  cells.push([x, y, z, W.at(x, y, z), bot.blockAt(new Vec3(x, y, z))?.name ?? null])
            console.log('[lance-bail]', JSON.stringify({ at: clock.now(), kind: ahead.kind, t: ahead.t, dmg: ahead.dmg, fd: ahead.fd,
              own: { p: xyz(st.p), v: xyz(st.v), boost: st.boost }, target: { p: xyz(f), h: hisH() }, look: [look.yaw, look.pitch],
              source: pl ? 'lance' : 'point', plan: pl && { hitT: pl.hitT, ready: pl.ready, exit: pl.exit }, readyIn, rocket,
              q: xyz(q), cells, headroom: [sky.headroom(W, st.p, 40), sky.headroom(W, f, 40)],
              boxHit: { standing: W.boxHit(q.x, q.y, q.z, 1.8), flying: W.boxHit(q.x, q.y, q.z, .6) } }))
          } catch {}
          return fin('опасно: ' + bail)
        }
        sky.steer(bot, look.yaw, look.pitch)
        if (rocket === 'нужна') {
          rocket = 'нет'
          const boosted = sky.rollout(W, st.p, st.v, look.yaw, look.pitch, ROCKET_MAX_TICKS, 6, { fd: st.fd, arena })
          const unsafe = boosted.kind === 'outside' || (boosted.kind === 'wall' && boosted.dmg >= 1) || (boosted.kind === 'floor' && boosted.fd > 3)
          if (!unsafe) {
            rocket = 'была'
            spear.afterPacket(bot, () => { const fr = sky.fireRocket(bot); if (fr.ok) stats.rockets = (stats.rockets || 0) + 1 })
            return
          }
        }
        // Копьё — после ракеты, так, чтобы задержка кончилась до касания (≈ дистанция / скорость тиков).
        const sp1 = Math.hypot(b.velocity.x, b.velocity.y, b.velocity.z)
        const eta = (dist - 3) / Math.max(0.3, sp1) * 50
        if (!ln.using && eta < delayMs + 4000) {
          if (bot.heldItem?.name === name) { bot.activateItem(); ln.using = true; ln.useAt = clock.now(); used('элитры: копьё к тарану') }
        }
        // Пол близко на пике — выйти, иначе удар о землю.
        const fl = W.floorBelow(b.position.x, b.position.y, b.position.z, 6)
        if (fl && b.position.y - fl.top < 1.2 && b.velocity.y < -0.45) return fin('пол близко')
        void ln.useAt
      } catch (err: any) { fin('ошибка: ' + err.message) }
    }
    bot.on('physicsTick', onT)
  })
  stopUse()
  if (res.why === 'попал') {
    out.hits++
    stats.lanceHits = (stats.lanceHits || 0) + 1
    // Сколько снял (телеметрия, метаданные): хп приходит позже события удара — минимум за 0.5 с.
    let hpMin = telemetryHp(e)
    const tH = clock.now()
    // Убил (сущность снята — с do_immediate_respawn раньше метаданных с хп 0) — снял всё, что было (hp1);
    // раньше hpMin оставался равен hp1 и убийство писалось «снял 0» (замечание проверки S7b в).
    const onH = () => { const h = telemetryHp(e); if (h != null && (hpMin == null || h < hpMin)) hpMin = h; if (clock.now() - tH > 500 || e.isValid === false) { bot.removeListener('physicsTick', onH); const dealt = e.isValid === false && hp1 != null ? hp1 : (hp1 != null && hpMin != null ? Math.max(0, hp1 - hpMin) : null); if (dealt != null) { out.dealt += dealt; (stats.lanceDealt = stats.lanceDealt || []).push(r2(dealt)) } } }
    bot.on('physicsTick', onH)
    used(`элитры: таран копьём — попал${res.best ? ` (план ${res.best.dmg}, ${res.best.rel} бл/с)` : ''}`)
  } else used(`элитры: таран — ${res.why}`)
  // Разбор захода (s7b): ближе всего (до его середины), высота над ним, скорость б/т, тиков «использования»
  // копья к этому мигу (−1 — не начато), был ли план касания и сколько тиков из захода.
  const tr = stats.lanceTrace || (stats.lanceTrace = [])
  if (tr.length < 12) tr.push(`${res.why}: ближе ${res.close ? res.close.d : '?'} (dy ${res.close ? res.close.dy : '?'}, ${res.close ? res.close.sp : '?'} б/т, копьё ${res.close ? res.close.use : '?'} т), план ${res.planned} т`)
  return res
}

async function lanceExit (ln: LanceCtx, res: any) {
  ln.S.phase = 'таран: выход'
  const { bot, ctl, stats, allow, arena, foe, hv, ceilY, cruiseY } = ln
  // 3) Выход вверх и прочь от стен: точка впереди по ходу на cruiseY.
  await sky.fly(bot, ctl, { arena,
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
      return { kind: 'point', at: lancePoint(new Vec3(b.position.x + L.x * 10, cruiseY(), b.position.z + L.z * 10), arena), minY: f.y + 3, maxY: ceilY(), gap: 3, speedMin: 0.4, away: f, awayR: 6 }
    },
    noRocket: () => !/копьё на изготовке/.test(res.why),
    rocketIf: (st: any) => Math.hypot(st.v.x, st.v.z) < 1.0 ? true : null,
    onTick: () => { if (allow) allow() },
    until: () => bot.entity.position.y >= foe().y + 3 && bot.entity.velocity.y < 0.3 ? 'вышел' : null
  })
}

async function lanceLand (ln: LanceCtx) {
  const { bot, ctl, e, stats, arena, telemetryHp, W, t0, out, hp0, hisHp0, foe } = ln
  // 4) Посадка подальше от него, нагрудник назад.
  // Сесть — всегда, даже если бой уже кончился (убил в воздухе) или его прервали: элитры без руля — хуже любого
  // перехвата (тактика летать не умеет). Прерывает посадку только смерть. Бой кончился (ctl прерван) — посадка
  // идёт фоном, а отчёт возвращается сразу: иначе «стоп» арены обгонял отчёт дуэли (s7e: у обоих пустые ROUND).
  out.hit = out.hit || out.hits > 0
  out.ok = true
  if ((bot.health ?? 0) <= 0) { out.note = `элитры: таран копьём ${out.passes} заход(а), попаданий ${out.hits} — погиб в воздухе`; stats.lanceDeaths = (stats.lanceDeaths || 0) + 1; return out }
  const landCtl = sky.flightControl(bot, ctl, true)
  const finish = async () => {
    if (landCtl.aborted) return { ok: false, why: 'flight_superseded' }
    let l: any = { ok: !!bot.entity.onGround }
    if (!bot.entity.elytraFlying && !bot.entity.onGround && (bot.health ?? 0) > 0) {
      // Полёт уже кончился (пол на заходе, касание) — дождаться земли и посчитать, чем обошлось.
      const hpF = bot.health ?? 20
      const tF = clock.now()
      while (!bot.entity.onGround && !bot.entity.isInWater && !landCtl.aborted && clock.now() - tF < 3000) await clock.sleep(50)
      const lostF = Math.max(0, hpF - (bot.health ?? 20))
      l = { ok: !!(bot.entity.onGround || bot.entity.isInWater) && lostF < 0.5, why: lostF >= 0.5 ? `упал −${r2(lostF)}` : 'сел без полёта', lost: lostF }
    }
    if (landCtl.aborted) return { ok: false, why: 'flight_superseded' }
    if (bot.entity.elytraFlying) {
      const inside = arena ? (x: number, z: number) => Math.abs(x - arena.x) <= arena.r - 1 && Math.abs(z - arena.z) <= arena.r - 1 : null
      const live = e && e.isValid !== false && e.position
      const spot = sky.landingSpot(bot, W, { near: bot.entity.position, away: live ? foe() : null, floorY: live ? foe().y : null, radius: 16, inside })
      l = await sky.land(bot, landCtl, { at: spot, away: live ? foe() : null, stats, arena })
    }
    await clock.sleep(150)
    if (landCtl.aborted) return { ok: false, why: 'flight_superseded' }
    if ((bot.health ?? 0) > 0 && !/_chestplate$/.test(bot.inventory.slots[6]?.name || '')) await sky.chestDown(bot, landCtl, { stats, arena })
    if (!l.ok) stats.lanceBadLand = (stats.lanceBadLand || 0) + 1
    return l
  }
  const account = (l: any) => {
    const hisHp1 = e ? telemetryHp(e) : null
    out.self = r2(Math.max(0, hp0 - (bot.health ?? 20)))
    out.total = hisHp0 != null && hisHp1 != null ? r2(Math.max(0, hisHp0 - hisHp1)) : null
    out.landed = !!l.ok
    out.ms = clock.now() - t0
    stats.lanceSelf = r2((stats.lanceSelf || 0) + out.self)
    out.note = `элитры: таран копьём ${out.passes} заход(а), попаданий ${out.hits}${out.maceHits ? `, булавой ${out.maceHits}` : ''}${out.dealt ? `, снял ${r2(out.dealt)}` : ''}${out.self ? `, себе −${out.self}` : ''}, посадка ${l.ok ? 'цела' : (l.why || '?')}`
  }
  if (ctl.aborted && bot.entity.elytraFlying) {
    finish().then(account).catch(() => {})
    out.note = `элитры: таран копьём ${out.passes} заход(а), попаданий ${out.hits}${out.dealt ? `, снял ${r2(out.dealt)}` : ''} — бой кончился в воздухе, сажусь`
    return out
  }
  account(await finish())
  return out
}
