// Караул жемчуга (пользователь 24.10: «враг бросил жемчуг — бот видит снаряд, считает точку и тик приземления»). Тело видит
// летящий ender_pearl глазами (луч до снаряда без стен), хозяин — ближайший к нему враг при первом взгляде; полёт —
// ThrowableProjectile.tick 1.21.11 (jar): тяжесть 0.03 → инерция ×0.99 (в воде ×0.8) → ход и первый блок на отрезке.
// Встречу в точке появления ставит драйвер (рой), тело только сообщает.
import { Vec3 } from 'vec3'
import * as pick from '../pick'
import { isAlly } from './ally-safety'

const GRAVITY = .03, DRAG = .99

/** Native-order flight to the first solid block on the move vector; null — not within maxTicks or unknown cells on the way. */
export function pearlLanding(world: { blockAt(p: Vec3): any }, from: Vec3, velocity: Vec3, maxTicks = 120) {
  let p = from.clone(), v = velocity.clone()
  for (let tick = 1; tick <= maxTicks; tick++) {
    v = new Vec3(v.x, v.y - GRAVITY, v.z).scaled(DRAG)
    const len = v.norm()
    if (len < 1e-9) return null
    let unknown = false
    const seen = { blockAt(q: Vec3) { const b = world.blockAt(q); if (!b) unknown = true; return b } }
    const hit = pick.blockOnRay(seen, p, v.scaled(1 / len), len)
    if (hit) return { tick, at: p.plus(v.scaled(hit.t / len)), block: hit.pos, velocity: v }
    if (unknown) return null
    p = p.plus(v)
  }
  return null
}

const owners = new WeakMap<object, string>()
/** Visible hostile pearls in flight with their forecast landing; read-only. */
export function enemyPearls(bot: any) {
  const own = bot.entity
  if (!own?.position) return []
  const eye = pick.eyeOf(bot), out: any[] = []
  for (const e of Object.values(bot.entities || {}) as any[]) {
    if (e?.name !== 'ender_pearl' || !e.position || !e.velocity) continue
    const d = e.position.minus(eye), len = d.norm()
    if (len > 64 || len > 1e-6 && pick.blockOnRay(bot, eye, d.scaled(1 / len), len)) continue
    let owner = owners.get(e)
    if (owner === undefined) {
      const thrower = (Object.values(bot.players || {}) as any[]).map(pl => pl?.entity)
        .filter(p => p?.position && p !== own && p.username && p.position.offset(0, 1.62, 0).distanceTo(e.position) <= 3)
        .sort((a, b) => a.position.distanceTo(e.position) - b.position.distanceTo(e.position))[0]
      owner = thrower?.username || ''
      owners.set(e, owner)
    }
    if (!owner || owner === bot.username || isAlly(bot, owner)) continue
    const land = pearlLanding({ blockAt: p => bot.blockAt(p, false) }, e.position, e.velocity)
    if (land) out.push({ id: e.id, owner, at: { x: +land.at.x.toFixed(2), y: +land.at.y.toFixed(2), z: +land.at.z.toFixed(2) }, eta: land.tick,
      stasis: pearlStasis({ x: land.at.x, y: land.at.y + 2.99, z: land.at.z }, land.velocity, 3).caught })
  }
  return out
}

// Стазис-ловушка (пользователь 24.10: вода над песком душ — жемчуг зависает). 1.21.11 (jar): в воде инерция ×0.8 на весь
// вектор, затем пузырьковый столб вверх Entity.onInsideBubbleColumn: vy = min(0.7, vy + 0.06). Вышел из столба вбок — летит
// дальше; коснулся песка — сработал. Ловит только почти отвесный жемчуг: под 45° он покидает столб 1×1 за первый тик.
/** Pearl entering the top of a 1×1 bubble column `depth` water blocks deep (soul sand under it): caught = never touches the sand. */
export function pearlStasis(entry: { x: number; y: number; z: number }, velocity: { x: number; y: number; z: number }, depth: number, maxTicks = 60) {
  const cx = Math.floor(entry.x), cz = Math.floor(entry.z), top = Math.floor(entry.y) + 1, floor = top - depth
  let p = { ...entry }, v = { ...velocity }
  for (let tick = 1; tick <= maxTicks; tick++) {
    const inWater = Math.floor(p.x) === cx && Math.floor(p.z) === cz && p.y >= floor && p.y < top
    v = { x: v.x, y: v.y - GRAVITY, z: v.z }
    const k = inWater ? .8 : DRAG
    v = { x: v.x * k, y: v.y * k, z: v.z * k }
    p = { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z }
    if (Math.floor(p.x) === cx && Math.floor(p.z) === cz && p.y <= floor) return { caught: false, why: 'sand', tick }
    if (Math.floor(p.x) !== cx || Math.floor(p.z) !== cz) return { caught: false, why: 'left_column', tick }
    if (p.y >= floor && p.y < top) v.y = Math.min(.7, v.y + .06)
    if (p.y >= top + 1) return { caught: true, why: 'floats_up', tick }
  }
  return { caught: true, why: 'suspended', tick: maxTicks }
}
