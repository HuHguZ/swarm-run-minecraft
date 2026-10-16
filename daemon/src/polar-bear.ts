const pick = require('./pick')
const assess = require('./assess')
const enabled = () => process.env.ND_POLAR_BEAR !== '0'
// Paper 1.21.11: PolarBear, MeleeAttackGoal, Mob, MoveControl, LivingEntity (REPORT.md).
const reach = .7 + Math.sqrt(2.04) - .6 + .3
const followMax = 20 * (1 + .11485) // Mob.finalizeSpawn: FOLLOW_RANGE * (1 + triangle(0, .11485)).
const JUMP = (() => { let height = 0, ticks = 0; for (let y = 0, v = .42; ; v = (v - .08) * .98) {
  y += v; ticks++; height = Math.max(height, y); if (y <= 0) return { height, ticks }
} })()
const MECH = { hp: 30, hit: 6, every: 1, follow: 20, followMax, cubRange: 10, cubMax: followMax / 2, reach,
  land: 20 * .98 * (.25 * 1.25) ** 2 / (1 - .6 * .91), water: 20 * .98 * (.25 * 1.25) * .02 / (1 - .98),
  walk: 20 * .98 * .1 / (1 - .6 * .91), sprint: 20 * .98 * .13 / (1 - .6 * .91), swim: 20 * .98 * .02 / (1 - .8) }
const memory = new WeakMap<object, any>()
const canReach = (bot, e) => e.position.y < bot.entity.position.y + (bot.entity.height || 1.8) && e.position.y + 1.4 + JUMP.height > bot.entity.position.y
function meta(bot, e, key, fallback) {
  const i = bot.registry?.entitiesByName?.polar_bear?.metadataKeys?.indexOf(key) ?? -1
  return e.metadata?.[i < 0 ? fallback : i]
}
function risks(bot, struckId = null) {
  if (!enabled() || !bot.entity || bot.health <= 0) { memory.delete(bot); return [] }
  let memo = memory.get(bot)
  const dim = bot.game?.dimension
  if (!memo || memo.dim !== dim || memo.body !== bot.entity) memory.set(bot, memo = { dim, body: bot.entity, bears: new Map() })
  const me = bot.entity.position
  const visible = Object.values(bot.entities || {}).filter((e: any) => e?.name === 'polar_bear' && e.position &&
    e.isValid !== false && e.position.distanceTo(me) <= 32 && pick.aim(bot, e, { range: 32 })?.point) as any[]
  const seen = new Set(visible.map(e => e.id))
  const cubs = visible.filter(e => meta(bot, e, 'baby', 16) === true)
  for (const e of visible) {
    if (meta(bot, e, 'baby', 16) === true) continue
    const prev = memo.bears.get(e.id), d = e.position.distanceTo(me)
    const attack = e.id === struckId || !!(meta(bot, e, 'mob_flags', 15) & 4) || meta(bot, e, 'standing', 17) === true
    // getEntitiesOfClass intersects adult AABB.inflate(8,4,8) with the cub AABB; not a spherical radius.
    const family = cubs.some(c => Math.abs(c.position.x - e.position.x) < 8 + .7 + .35 &&
      Math.abs(c.position.z - e.position.z) < 8 + .7 + .35 && c.position.y + .7 > e.position.y - 4 && c.position.y < e.position.y + 1.4 + 4)
    if (!attack && !family && (!prev || d >= MECH.followMax)) { memo.bears.delete(e.id); continue }
    memo.bears.set(e.id, { e: { ...e, position: e.position.clone() }, d, visible: true,
      attacking: attack || !!prev?.attacking && d < MECH.followMax,
      avoiding: d <= MECH.cubMax + reach || !!prev?.avoiding && d < MECH.followMax })
  }
  for (const [id, r] of memo.bears) {
    if (seen.has(id)) continue
    r.d = r.e.position.distanceTo(me); r.visible = false
    if (r.d >= MECH.followMax) memo.bears.delete(id)
  }
  return [...memo.bears.values()]
}
const attacking = (bot, e) => risks(bot).some(r => r.e.id === e.id && r.attacking && r.visible && canReach(bot, r.e))
function pillarCause(bot) {
  const feet = bot.entity.position.floored()
  return [bot.game?.dimension, feet.toString(), require('./pack').buildCount(bot, 'overworld'),
    require('./fortify').pickFiller(bot, { steady: true })?.name,
    ...Array.from({ length: 8 }, (_, k) => bot.blockAt(feet.offset(0, k - 1, 0))?.stateId ?? bot.blockAt(feet.offset(0, k - 1, 0))?.name)].join('|')
}

// Cost in seconds: time spent plus the jar's slow regeneration (1 HP / 80 ticks); survival precedes that price.
function choose({ hp, hit, fightSeconds, shield, water, distance, gap = Math.max(0, distance - reach), route = false, shoreSeconds = Infinity, pillarSeconds = Infinity, food = 20, swings = Math.ceil(fightSeconds * 1.6) }) {
  const contact = gap / (water ? MECH.water : MECH.land)
  const price = (action, seconds, loss) => ({ action, seconds, loss, cost: seconds + loss * 4 })
  // shortcut: unknown attack phase is uniform; 5 ticks to raise again after a swing, replace with confirmed shield-hit phase.
  const exchanges = Math.ceil(fightSeconds / MECH.every)
  const fightLoss = (shield ? Math.min(exchanges, (swings + 1) * 5 / 20 / MECH.every) : exchanges) * hit
  const options = [price('Fight', contact + fightSeconds, fightLoss)]
  // A turn toward the bear closes at both speeds; do not price a bank beyond it as an unopposed swim.
  const shoreContact = gap / (MECH.water + MECH.swim)
  if (Number.isFinite(shoreSeconds)) options.push(price('Surface', shoreSeconds, (shoreSeconds < shoreContact ? 0 : 1 + Math.floor((shoreSeconds - shoreContact) / MECH.every)) * hit))
  if (Number.isFinite(pillarSeconds) && pillarSeconds < contact) options.push(price('PillarUp', pillarSeconds, 0))
  const lead = (food > 6 ? MECH.sprint : MECH.walk) - MECH.land
  if (!water && route && lead > 0) options.push(price('Flee', Math.max(0, MECH.followMax + reach - distance) / lead, distance < reach ? hit : 0))
  return options.sort((a, b) => Number(a.loss >= hp) - Number(b.loss >= hp) || a.cost - b.cost)[0]
}

function plan(session, known = risks(session.bot)) {
  const bot = session.bot
  const active = known.filter(r => r.attacking && r.visible && r.d < MECH.followMax && canReach(bot, r.e))
  if (!enabled() || !active.length) return null
  const bear = active.sort((a, b) => a.d - b.d)[0]
  const movement = require('./movement'), fortify = require('./fortify'), flee = require('./flee')
  const water = movement.inWater(bot), p = bot.entity.position, feet = p.floored()
  const gap = Math.min(...active.map(r => { const dx = Math.abs(p.x - r.e.position.x), dz = Math.abs(p.z - r.e.position.z)
    return Math.max(dx, dz) ? Math.hypot(dx, dz) * Math.max(0, 1 - reach / Math.max(dx, dz)) : 0 }))
  const items = bot.inventory.items(), gear = assess.gearOf([5, 6, 7, 8].map(i => bot.inventory.slots[i]))
  const sword = items.filter(i => /_sword$/.test(i.name)).map(i => assess.WEAPON[i.name] || 1).sort((a, b) => b - a)[0] || 1
  const fightSeconds = Math.ceil(MECH.hp / sword) * (sword > 1 ? 1 / 1.6 : .5)
  const hit = assess.afterArmor(MECH.hit, gear.armor, gear.tough) * active.length
  const route = water ? movement.findSwimRoute(bot, { visibleOnly: true }) : null
  let shoreSeconds = Infinity
  if (route?.kind === 'land') {
    let prev = p, length = 0
    for (const cell of route.path) { length += prev.distanceTo(cell.offset(.5, 0, .5)); prev = cell.offset(.5, 0, .5) }
    shoreSeconds = length / MECH.swim
  }
  // Three above the highest neighbouring foothold: a jumping 1.4-high bear reaches 1.4 + 1.252 < 3.
  const lift = require('./survival/hold-out').standTop(bot, feet), top = feet.y + 3 + lift
  const signature = pillarCause(bot)
  const filler = fortify.pickFiller(bot, { steady: true })
  const pillar = !water && bot.entity.onGround && filler && require('./pack').buildCount(bot, 'overworld') >= top - feet.y &&
    bot.blockAt(feet.offset(0, -1, 0))?.boundingBox === 'block' &&
    Array.from({ length: top - feet.y + 2 }, (_, k) => bot.blockAt(feet.offset(0, k + 1, 0))).every(b => b?.boundingBox === 'empty' && !/water|lava/.test(b.name)) &&
    signature !== bot._ndBearPillarFailed
  const building = session._ndBearPillar && !session._ndBearPillar.ctl.aborted
  const run = !water && flee.pickDirection(bot, flee.hostilesAround(bot, 32))
  const dryRoute = run && run.run >= 3 && !flee.runLength(bot, run.dir, run.run).wet &&
    run.end.distanceTo(bear.e.position) > bear.d
  const response = building ? { action: 'PillarUp', cost: 0, seconds: 0, loss: 0 } : choose({
    hp: bot.health, hit, fightSeconds, shield: bot.inventory.slots[45]?.name === 'shield' && require('./game-clock').now() >= (bot._ndShieldDisabledUntil || 0), water, distance: bear.d, gap,
    route: !!dryRoute, shoreSeconds, food: bot.food,
    pillarSeconds: pillar ? (top - feet.y) * (JUMP.ticks + 1) / 20 : Infinity })
  return { ...response, id: bear.e.id, top: building ? session._ndBearPillar.top : top, signature }
}

async function pillar(session, ctl, target) {
  const bot = session.bot
  session._ndBearPillar = { ctl, top: target.top }
  try {
    bot.pathfinder?.setGoal(null); bot.clearControlStates()
    let placed = 0
    while (!ctl.aborted && bot.health > 0 && bot.entity.position.y < target.top) {
      const result = await require('./build').towerUp(bot, ctl, 1, { sneak: true, fast: true, maxDigMs: 0, item: require('./fortify').pickFiller(bot, { steady: true })?.name })
      placed += result.placed
      if (!result.ok) {
        if (!ctl.aborted) bot._ndBearPillarFailed = pillarCause(bot)
        return { failed: true, placed, reason: result.why?.join('; ') || result.reason }
      }
    }
    return { ok: !ctl.aborted && bot.health > 0 && bot.entity.position.y >= target.top, placed }
  } finally { if (session._ndBearPillar?.ctl === ctl) session._ndBearPillar = null }
}
module.exports = { enabled, MECH, JUMP, canReach, risks, attacking, choose, plan, pillar }
