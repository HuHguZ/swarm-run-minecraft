import { distance } from './common'
import type { SwarmDriverCtx } from './common'

// Фланг ветра (пользователь 24.10: «если они стоят под тем, кого подкидывают, не откинут — отойти в сторону»): взрыв
// толкает от центра порыва к глазам цели (ServerExplosion), а порыв — там, где заряд встретил её тело; брошенный снизу бьёт
// в ноги и только подкидывает, брошенный полого сбоку — уносит вбок. Враг в воздухе или у края — до трёх свободных с
// зарядами, кто стоит под ним или снаружи, идут на сторону центра на пологий угол (дальше, чем он высоко); бросок решает
// тело само (combat/wind-out: вылетит ли от моего броска сейчас).
const FLANK_N = 3, FLANK_RANGE = 18, FLANK_MS = 2500
export function flankSpots(target: { x: number; y: number; z: number }, arena: { x: number; z: number; r: number }, floorY: number, shooters: { x: number; y: number; z: number }[]) {
  let ux = target.x - arena.x, uz = target.z - arena.z
  if (Math.hypot(ux, uz) < 1) { const c = shooters.reduce((a, p) => ({ x: a.x + p.x / shooters.length, z: a.z + p.z / shooters.length }), { x: 0, z: 0 }); ux = target.x - c.x; uz = target.z - c.z }
  const n = Math.hypot(ux, uz) || 1; ux /= n; uz /= n
  const h = Math.max(0, target.y - floorY), back = Math.min(12, 5 + 1.5 * h)
  // Плохой угол: ближе по горизонтали, чем 1.5 высоты (снизу — в ноги), или не со стороны центра (толкнёт внутрь).
  const bad = (p: { x: number; z: number }) => Math.hypot(p.x - target.x, p.z - target.z) < Math.max(3, 1.5 * h) || (p.x - target.x) * ux + (p.z - target.z) * uz > -2
  const spots = [0, -1, 1].map(k => ({ x: target.x - ux * back - uz * 3 * k, y: floorY, z: target.z - uz * back + ux * 3 * k }))
    .map(p => { const m = Math.max(Math.abs(p.x - arena.x), Math.abs(p.z - arena.z)), lim = arena.r - 2; return m > lim ? { x: arena.x + (p.x - arena.x) * lim / m, y: p.y, z: arena.z + (p.z - arena.z) * lim / m } : p })
  return { spots, bad, out: { x: ux, z: uz }, back }
}

/** An observation may start one short chain per team; it never stops an existing fight or defence. */
export function swarmWind(sw: SwarmDriverCtx) {
  const { bots, pos, now, alive, teamOf, arena, log } = sw
  const pending = new Map<string, object>()
  const attempted = new Map<string, string>()
  let generation = sw.generation
  const detail = reply => reply?.detail || reply || {}
  const protectedAction = b => b.maceDefense?.until > now() || b.climbing || pos[b.name]?.gliding ||
    (/^(lava_escape|dodge_blast|clear_web|evade|juke|take_cover|douse_lava|pearl_to|wind_jump|wind_leap|fly_to|burrow|block_behind|peek_shot)$/.test(b.last?.m || '') || b.shieldHold && b.last?.m === 'swarm_hold') && b.last?.pending !== false
  // Preflight is a query: panic() caches the strategic verdict and must not run for an unused wind opportunity.
  const available = b => alive(b.name) && !!pos[b.name]?.p && !b.swarmReserved && !pos[b.name]?.combo && !protectedAction(b)
  async function windObserve(b, sightings, seenAt = now()) {
    const round = sw.generation, team = teamOf(b), key = `${round}:${team}`, token = {}, reserved: any[] = []
    const current = () => round === sw.generation && alive(b.name)
    const charged = o => (pos[o.name]?.inv?.wind_charge || 0) > 0 || pos[o.name]?.offHand === 'wind_charge'
    const roster = bots.filter(o => teamOf(o) === team && alive(o.name) && pos[o.name]?.p)
    if (pending.has(key) || !current() || now() - seenAt > 1000 || !roster.some(o => charged(o) && available(o))) return false
    const target = (sightings || []).filter(e => e.visible === true && sw.hostile(b, e.id))
      .sort((a, c) => distance(a.position, pos[b.name].p) - distance(c.position, pos[b.name].p))[0]
    if (!target) return false
    if (generation !== round) { attempted.clear(); generation = round }
    const scene = JSON.stringify([target.id, target.position, target.velocity, target.equipment,
      roster.map(o => [o.name, pos[o.name].p, pos[o.name].v, pos[o.name].velocity, pos[o.name].armor,
        pos[o.name].inv?.wind_charge || 0, pos[o.name].offHand, available(o)])])
    if (attempted.get(key) === scene) return false
    pending.set(key, token)
    let planMs = 0
    try {
      // A cold native forecast may miss its first launch window; one measured replan replaces that stale schedule.
      for (let attempt = 0; attempt < 2; attempt++) {
        const reports = await Promise.all(roster.map(async o => {
          const start = now(), reply = detail(await o.c.call('wind_report', { target: target.id }).catch(() => null))
          return { bot: o, ...reply, at: now(), ms: now() - start }
        }))
        if (!current()) return false
        const bodies = reports.filter(r => r.ok && r.report && Number.isSafeInteger(r.gameTick))
        const ready = bodies.filter(r => r.ready && available(r.bot) && charged(r.bot))
        if (!ready.length) return false
        const rtt = Math.max(0, ...bodies.map(r => r.ms)), leadTicks = Math.max(2, Math.ceil((rtt + planMs) / 50) + 1)
        if (leadTicks > 20) return false
        const start = now(), proposal = detail(await b.c.call('enemy_wind_plan', {
          target: target.id, throwers: ready.map(r => r.report), allies: bodies.map(r => r.report), arena, leadTicks, maxShots: 2
        }).catch(() => null))
        planMs = now() - start
        if (!current()) return false
        const plan = proposal.plan
        if (proposal.ok || proposal.why === 'no_useful_native_chain') attempted.set(key, scene)
        if (!proposal.ok || !plan?.shots?.length || plan.shots.length > 3) return false
        const currentTick = Math.max(...bodies.map(r => r.gameTick + Math.ceil((now() - r.at) / 50)))
        if (plan.shots.some(s => !Number.isSafeInteger(s.fireTick) || s.fireTick <= currentTick + Math.ceil(rtt / 50))) continue
        const shooters = [...new Set<string>(plan.shots.map(s => s.thrower))].map(id => ready.find(r => r.bot.name === id)?.bot)
        if (shooters.some(o => !o || !available(o) || sw.panic(o))) return false
        for (const o of shooters) { o.swarmReserved = token; reserved.push(o) }
        const results = await Promise.all(shooters.map(async o => detail(await o.c.call('wind_out', { plan, arena, allies: bodies.map(r => r.report) }).catch(e => ({ fired: false, why: e.message })))))
        if (!current()) return false
        const fired = results.filter(r => r.fired).length, confirmed = results.filter(r => r.launchConfirmed).length, bursts = results.filter(r => r.burstSeen).length
        log(`🌬 ${team} → ${target.id}: цепочка ${fired}/${shooters.length}, запуск подтверждён ${confirmed}, всплесков видно ${bursts}`)
        return fired > 0
      }
      attempted.delete(key)
      return false
    } finally {
      for (const o of reserved) if (o.swarmReserved === token) delete o.swarmReserved
      if (pending.get(key) === token) pending.delete(key)
    }
  }
  // Караул жемчуга (тело: combat/pearl-watch): враг бросил жемчуг — двое ближайших свободных бойцов команды идут в точку
  // приземления, пока он летит; бой подхватит их там (wind-out у края, удар в момент появления). Один жемчуг — один вызов.
  const pearlsSeen = new Map<string, number>()
  function pearlObserve(b, pearls) {
    for (const pl of pearls || []) {
      const key = `${sw.generation}:${pl.owner}:${pl.id}`
      if (pearlsSeen.has(key) || !sw.hostile(b, pl.owner)) continue
      pearlsSeen.set(key, now()); if (pearlsSeen.size > 200) pearlsSeen.delete(pearlsSeen.keys().next().value!)
      const team = teamOf(b), at = { x: pl.at.x, y: Math.round(pl.at.y), z: pl.at.z }
      if (arena && (Math.abs(at.x - arena.x) > arena.r - 1 || Math.abs(at.z - arena.z) > arena.r - 1 || at.y <= (arena.killY ?? -64))) { log(`🟣 ${pl.owner}: жемчуг за край (${Math.round(at.x)},${at.y},${Math.round(at.z)}) — не встречаем`); continue }
      // Только кто успеет к появлению: бег 5.6 бл./с (спринт) за время полёта и 3 бл. на удар; дальние — без толку (стенд
      // 24.10 12:58: 17 встреч назначены за 15–30 бл., ни одной не состоялось).
      const reach = 3 + 5.6 * pl.eta / 20
      const guards = bots.filter(o => teamOf(o) === team && available(o) && !sw.panic(o) && distance(pos[o.name].p, at) <= reach)
        .sort((x, y) => distance(pos[x.name].p, at) - distance(pos[y.name].p, at)).slice(0, 2)
      log(`🟣 ${pl.owner} бросил жемчуг → ${Math.round(at.x)},${at.y},${Math.round(at.z)} через ${pl.eta} т. (видел ${b.name}; стазис 3×1 поймал бы: ${pl.stasis ? 'да' : 'нет'}); встречают: ${guards.map(o => `${o.name} (${distance(pos[o.name].p, at).toFixed(0)} бл.)`).join(', ') || `никто не успеет (≤ ${reach.toFixed(0)} бл.)`}`)
      for (const o of guards) {
        const token = {}; o.swarmReserved = token
        void sw.go(o, at, 1.5, Math.max(2, Math.ceil(pl.eta / 20) + 2)).catch(() => {}).finally(() => { if (o.swarmReserved === token) delete o.swarmReserved })
      }
    }
  }
  const flankAt = new Map<string, number>()
  function windFlank(b, sightings) {
    if (!arena || process.env.ND_WIND_FLANK === '0') return
    // Лук тоже: стрела толкает вдоль своего полёта (AbstractArrow.doKnockback — «Отдача» ×0.6 на уровень, плюс обычный
    // отброс от попадания), подброшенного в воздухе — на несколько блоков; со стороны центра — наружу.
    const team = teamOf(b), inv = o => pos[o.name]?.inv || {}
    const charged = o => (inv(o).wind_charge || 0) > 0 || pos[o.name]?.offHand === 'wind_charge' || (inv(o).bow || 0) > 0 && ((inv(o).arrow || 0) + (inv(o).tipped_arrow || 0) + (inv(o).spectral_arrow || 0)) > 0
    for (const e of sightings || []) {
      if (e.visible !== true || !sw.hostile(b, e.id) || !e.position) continue
      const key = `${team}:${e.id}`
      if (now() - (flankAt.get(key) || 0) < FLANK_MS) continue
      const room = arena.r - Math.max(Math.abs(e.position.x - arena.x), Math.abs(e.position.z - arena.z))
      const crew = bots.filter(o => teamOf(o) === team && available(o) && charged(o) && !sw.panic(o) && distance(pos[o.name].p, e.position) <= FLANK_RANGE)
      // Один боец (чемпион) — не рой: его фланг уводил из боя (стенд 24.10 14:48 — по 2–3 раза в секунду).
      if (crew.length < 2) continue
      const floorY = Math.min(...crew.map(o => pos[o.name].p.y))
      // Подброшен, а не прыгнул: прыжок — 0.42 бл./т. вверх, обычный в бою; выше 2.5 бл. над полом — уже не прыжок.
      const airborne = (e.velocity?.y || 0) > .5 || e.position.y - floorY > 2.5
      if (!airborne && room > 5) continue
      const { spots, bad } = flankSpots(e.position, arena, floorY, crew.map(o => pos[o.name].p))
      const movers = crew.filter(o => bad(pos[o.name].p)).sort((x, y) => distance(pos[x.name].p, spots[0]) - distance(pos[y.name].p, spots[0])).slice(0, FLANK_N)
      if (!movers.length) continue
      flankAt.set(key, now())
      log(`🌬↔ ${team} → ${e.id}${airborne ? ' в воздухе' : ' у края'} (${room.toFixed(0)} бл. до края): на фланг ${movers.map((o, k) => `${o.name} ${distance(pos[o.name].p, spots[k]).toFixed(0)} бл.`).join(', ')}`)
      movers.forEach((o, k) => {
        const token = {}; o.swarmReserved = token
        void sw.go(o, spots[k], 1.5, 2).catch(() => {}).finally(() => { if (o.swarmReserved === token) delete o.swarmReserved })
      })
    }
  }
  return { windObserve, pearlObserve, windFlank }
}
