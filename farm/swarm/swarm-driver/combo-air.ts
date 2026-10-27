import * as fs from 'node:fs'
import * as path from 'node:path'
import { REPO_ROOT, DIST_ROOT } from '../../../daemon/src/paths'
import { GameClock } from '../../../daemon/src/game-clock'
import { arena, cmd as rawCmd, clients, connect, measure, reset, sleep, stopped, target } from './combo-ideas'
export { setup, track, place, give, hold, cmd, position }

export function airSummary(rows: any[]) {
  const sum = (key: string) => rows.reduce((n, r) => n + (Number(r[key]) || 0), 0)
  return { n: rows.length, damage: rows.length ? sum('damage') / rows.length : 0, allyDamage: rows.length ? sum('allyDamage') / rows.length : 0,
    contactRate: rows.length ? rows.filter(r => r.contact).length / rows.length : 0,
    outRate: rows.length ? rows.filter(r => r.out).length / rows.length : 0, ownDeaths: sum('ownDeaths') }
}

const X = 600.5, Z = 600.5, Y = 151
const OUT = path.join(REPO_ROOT, 'farm/results/ideas-28')
let pendingRcon = Promise.resolve<any>(null)
const cmd = (command: string) => {
  const result = pendingRcon.then(() => rawCmd(command))
  pendingRcon = result.catch(() => {})
  return result
}
const actions = () => require(path.join(DIST_ROOT, 'daemon/src/swarm/combos/air-ideas'))
const mod = (n: string) => require(path.join(REPO_ROOT, 'daemon/node_modules', n))
const position = b => ({ x: b.entity.position.x, y: b.entity.position.y, z: b.entity.position.z })
async function place(bot: any, x: number, y: number, z: number, platform = false) {
  if (platform) await cmd(`setblock ${Math.floor(x)} ${Math.floor(y) - 1} ${Math.floor(z)} minecraft:glass`)
  await cmd(`tp ${bot.username} ${x} ${y} ${z}`)
}
async function give(bot: any, item: string) { await cmd(`give ${bot.username} minecraft:${item}`) }
async function hold(bot: any, name: string) {
  for (let i = 0; i < 20 && !bot.inventory.items().some(it => it.name === name); i++) await sleep(50)
  const item = bot.inventory.items().find(it => it.name === name)
  if (!item) throw new Error(`missing fixture item ${name}`)
  await bot.equip(item, 'hand')
}
async function data(name: string, key: string) { return cmd(`data get entity ${name} ${key}`) }
async function health(bot: any, hp: number) {
  await cmd(`attribute ${bot.username} minecraft:max_health base set ${hp}`)
  await cmd(`effect give ${bot.username} minecraft:instant_health 1 10 true`)
  await sleep(150)
  await cmd(`effect clear ${bot.username} minecraft:instant_health`)
  if (Math.abs(bot.health - hp) > .01) throw new Error(`fixture health ${bot.username}: ${bot.health} != ${hp}`)
}
function track(bot: any) {
  const frames: any[] = [], damage: any[] = [], explosions: any[] = []
  let nbt: any[] = [], busy = false
  const step = () => frames.push({ ms: Date.now(), ...position(bot), vy: bot.entity.velocity.y, vx: bot.entity.velocity.x, vz: bot.entity.velocity.z,
    onGround: bot.entity.onGround, age: String(bot.ndClock?.age ?? ''), projectiles: Object.values<any>(bot.entities || {})
      .filter(e => /arrow|wind_charge/.test(e.name || '')).map(e => ({ id: e.id, name: e.name, ...e.position })) })
  const hit = pk => { if (pk.entityId === bot.entity?.id) damage.push({ ms: Date.now(), ...pk }) }
  const boom = pk => explosions.push({ ms: Date.now(), center: pk.center, impulse: pk.playerKnockback, radius: pk.radius })
  bot.on('physicsTick', step); bot._client.on('damage_event', hit); bot._client.on('explosion', boom)
  const timer = setInterval(async () => {
    if (busy || !bot.entity) return
    busy = true
    try { nbt.push({ ms: Date.now(), fall: await data(bot.username, 'fall_distance'), pos: await data(bot.username, 'Pos') }) }
    catch (error) { nbt.push({ ms: Date.now(), error: String(error) }) } finally { busy = false }
  }, 100)
  return () => {
    clearInterval(timer); bot.removeListener('physicsTick', step); bot._client.removeListener('damage_event', hit); bot._client.removeListener('explosion', boom)
    return { frames, damage, explosions, nbt }
  }
}
async function setup(bots: any[], poses: number[][], hp = 100) {
  await arena()
  await cmd('fill 595 151 595 607 167 611 minecraft:air')
  await reset(bots, poses)
  for (const b of bots) { b._ndSwarmAllies = []; await health(b, hp) }
  await sleep(300)
}
const allyPermission = (ally: any) => ({ allowAlly: true, allyHealth: () => ally.health,
  allySafe: () => ally.health > 10 && ally.entity.position.y >= Y && ally.entity.position.x > 590 && ally.entity.position.x < 615 && ally.entity.position.z > 590 && ally.entity.position.z < 615 })

async function dropCase(kind: string, enabled: boolean, bots: any[]) {
  const [mace, support, victim] = bots, { maceDive, windAt, punchAt, slowFallingAt } = actions()
  const lateral = kind === 'H10' ? 12 : 0
  await setup([mace, support, victim], [[X, Z + 10], [X, Z + 6], [X, Z - lateral]])
  await give(mace, 'mace'); await hold(mace, 'mace')
  await place(mace, X, Y + 8, Z, true)
  if (kind === 'H29' || kind === 'H10') await place(support, X, Y + (kind === 'H29' ? 10 : 8), Z + 6, true)
  if (kind === 'H10') { support._ndSwarmAllies = [mace.username]; mace._ndSwarmAllies = [support.username] }
  else if (kind === 'H09') { support._ndSwarmAllies = [mace.username]; mace._ndSwarmAllies = [support.username] }
  else { support._ndSwarmAllies = [victim.username]; victim._ndSwarmAllies = [support.username] }
  await give(support, 'wind_charge 4'); await give(support, 'bow[enchantments={punch:2}]'); await give(support, 'arrow 8')
  await give(support, 'splash_potion[potion_contents={potion:"minecraft:slow_falling"}]')
  await mace.waitForTicks(36)
  const ctl = { aborted: false }, finish = measure(victim), own = [mace, support].map(measure), tr = [mace, support, victim].map(track)
  const pre: any[] = [], results: any = {}
  if (kind === 'H29' && enabled) {
    results.slow = await slowFallingAt(support, target(support, mace.username), { ctl, allies: [target(support, victim.username)] })
    await sleep((Number(results.slow.ticks) || 15) * 50 + 250)
    results.effect = await data(mace.username, 'active_effects')
  }
  if (kind === 'H10' && enabled) results.punch = await punchAt(support, target(support, mace.username), { ctl, drawTicks: 6, foe: target(support, victim.username), ...allyPermission(mace) })
  if (kind === 'H09' && enabled) results.wind = await windAt(support, target(support, victim.username), { ctl })
  const t0 = Date.now()
  await cmd(`setblock ${Math.floor(X)} ${Y + 7} ${Math.floor(Z)} minecraft:air`)
  for (let t = 0; t < 20 && mace.entity.onGround; t++) await sleep(20)
  const dive = maceDive(mace, target(mace, victim.username), { ctl, maxTicks: kind === 'H29' ? 180 : 90 })
  results.mace = await dive
  pre.push({ ms: Date.now(), fall: await data(mace.username, 'fall_distance') })
  await sleep(700); ctl.aborted = true
  const receipt = finish(), allies = own.map(f => f()), traces = tr.map(f => f())
  const friendly = kind === 'H29' ? [allies[1], receipt] : allies
  return { kind, enabled, results, ...receipt, damageMeaning: kind === 'H29' ? 'incoming_to_defended_ally' : 'outgoing_to_foe',
    allyDamage: friendly.reduce((n, r) => n + r.damage, 0), ownDeaths: friendly.reduce((n, r) => n + r.deaths, 0),
    contact: !!results.mace.sent && receipt.damage > (results.wind?.fired ? 1 : 0), out: false, elapsedMs: Date.now() - t0, allies, pre, traces }
}

async function spearCase(enabled: boolean, bots: any[]) {
  const [spear, support, victim] = bots, { chargedSpear, windAt } = actions()
  await setup([spear, support, victim], [[X, Z], [X, Z + 6], [X, Z - 6]])
  spear._ndSwarmAllies = [support.username]; support._ndSwarmAllies = [spear.username]
  await give(spear, 'iron_spear'); await give(support, 'wind_charge 4'); await sleep(300)
  const ctl = { aborted: false }, finish = measure(victim), own = [spear, support].map(measure), tr = [spear, support, victim].map(track)
  const charge = chargedSpear(spear, target(spear, victim.username), { ctl, maxTicks: 70 })
  await spear.waitForTicks(18)
  const wind = enabled ? await windAt(support, target(support, spear.username), { ctl, ...allyPermission(spear) }) : null
  const result = await charge
  await sleep(500); ctl.aborted = true
  const receipt = finish(), allies = own.map(f => f()), traces = tr.map(f => f())
  return { kind: 'H11', enabled, results: { wind, spear: result }, ...receipt, allyDamage: allies.reduce((n, r) => n + r.damage, 0),
    ownDeaths: allies.reduce((n, r) => n + r.deaths, 0), contact: receipt.damage > 0, out: false, allies, traces }
}

async function edgeCase(kind: string, enabled: boolean, bots: any[]) {
  const [a, b, victim] = bots, { windAt, punchAt } = actions()
  await setup([a, b, victim], [[X, Z + 8], [X + 2, Z + 3], [X, Z]], 20)
  a._ndSwarmAllies = [b.username]; b._ndSwarmAllies = [a.username]
  for (let y = -64; y <= 150; y += 16) await cmd(`fill 592 ${y} 580 608 ${Math.min(150, y + 15)} 591 minecraft:air`)
  for (const shooter of [a, b]) { await give(shooter, 'bow[enchantments={punch:2}]'); await give(shooter, 'arrow 8'); await give(shooter, 'wind_charge 4') }
  await sleep(300)
  const ctl = { aborted: false }, finish = measure(victim), own = [a, b].map(measure), tr = [a, b, victim].map(track), results: any = {}
  const start = position(victim)
  let deathPose: any = null
  const died = () => { deathPose ||= position(victim) }
  victim.on('death', died)
  if (kind === 'H08') results.first = await windAt(a, target(a, victim.username), { ctl })
  else results.first = await punchAt(a, target(a, victim.username), { ctl, drawTicks: 20 })
  let moved = false
  for (let i = 0; i < 40 && victim.health > 0; i++) {
    if (Math.hypot(victim.entity.position.x - start.x, victim.entity.position.z - start.z) > .2) { moved = true; break }
    await sleep(50)
  }
  if (enabled && moved && victim.health > 0) results.second = await punchAt(b, target(b, victim.username), { ctl, drawTicks: 20 })
  const deadline = Date.now() + 10000
  while (!deathPose && !stopped() && Date.now() < deadline) await sleep(100)
  victim.removeListener('death', died); ctl.aborted = true
  const receipt = finish(), allies = own.map(f => f()), traces = tr.map(f => f())
  if (deathPose && receipt.deaths !== 1) throw new Error('native death missing from first-life receipt')
  const out = traces[2].frames.some(p => p.y < Y - 2)
  return { kind, enabled, results, moved, ...receipt, allyDamage: allies.reduce((n, r) => n + r.damage, 0),
    ownDeaths: allies.reduce((n, r) => n + r.deaths, 0), contact: receipt.damage > 0, out, displacement: (deathPose || position(victim)).z - start.z, allies, traces }
}

async function echelonCase(enabled: boolean, bots: any[]) {
  const [a, b, victim] = bots, { aerialPass } = actions()
  await setup([a, b, victim], [[X - 4, Z + 10], [X + 4, Z + 10], [X, Z - 5]])
  a._ndSwarmAllies = [b.username]; b._ndSwarmAllies = [a.username]
  for (const [i, flyer] of [a, b].entries()) {
    await give(flyer, 'diamond_spear'); await give(flyer, 'firework_rocket 48')
    await cmd(`item replace entity ${flyer.username} armor.chest with minecraft:elytra`)
    await place(flyer, X + (i ? 4 : -4), Y + (enabled ? (i ? 7 : 3) : 3), Z + 10, true)
  }
  await sleep(600)
  const ctl = { aborted: false }, finish = measure(victim), own = [a, b].map(measure), tr = [a, b, victim].map(track)
  const results = await Promise.all([aerialPass(a, target(a, victim.username), { ctl, maxTicks: 240 }),
    aerialPass(b, target(b, victim.username), { ctl, maxTicks: 240, delayTicks: enabled ? 15 : 0 })])
  ctl.aborted = true
  const receipt = finish(), allies = own.map(f => f()), traces = tr.map(f => f())
  let minSeparation = Infinity
  for (const a of traces[0].frames) {
    const b = traces[1].frames.reduce((best, p) => !best || Math.abs(p.ms - a.ms) < Math.abs(best.ms - a.ms) ? p : best, null)
    if (b && Math.abs(b.ms - a.ms) <= 30) minSeparation = Math.min(minSeparation, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z))
  }
  return { kind: 'H13', enabled, results, ...receipt, allyDamage: allies.reduce((n, r) => n + r.damage, 0),
    ownDeaths: allies.reduce((n, r) => n + r.deaths, 0), contact: receipt.damage > 0, out: false,
    minSeparation: Number.isFinite(minSeparation) ? minSeparation : null, allies, traces }
}
async function main() {
  const kind = process.argv[2] || 'H29', pairs = Number(process.argv[3] || 2)
  if (!['H09', 'H10', 'H11', 'H08', 'H07', 'H13', 'H29', 'all'].includes(kind) || !Number.isInteger(pairs) || pairs < 1 || pairs > 20) throw new Error('combo-air Hxx|all pairs[1..20]')
  const kinds = kind === 'all' ? ['H29', 'H11', 'H09', 'H10', 'H08', 'H07', 'H13'] : [kind], rows: any[] = []
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `air-${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)
  try {
    await arena()
    const bots = []
    for (const suffix of ['i', 'j', 'k']) {
      const bot = await connect(`NeuroFarm28${suffix}`, new GameClock())
      const pf = mod('mineflayer-pathfinder'); bot.loadPlugin(pf.pathfinder); bot.pathfinder.setMovements(new pf.Movements(bot))
      bots.push(bot)
    }
    await sleep(1200)
    for (const h of kinds) for (let rep = 0; rep < pairs; rep++) for (const enabled of (rep % 2 ? [true, false] : [false, true])) {
      if (stopped()) throw new Error('AUTO-STOP')
      const row = ['H09', 'H10', 'H29'].includes(h) ? await dropCase(h, enabled, bots) : h === 'H11' ? await spearCase(enabled, bots) :
        h === 'H13' ? await echelonCase(enabled, bots) : await edgeCase(h, enabled, bots)
      rows.push(row); fs.appendFileSync(file, JSON.stringify({ rep, ...row }) + '\n')
      console.log(JSON.stringify({ file, rep, ...row, traces: undefined }))
    }
    console.log('SUMMARY', JSON.stringify(Object.fromEntries(kinds.flatMap(h => [false, true].map(on => [`${h}/${on}`, airSummary(rows.filter(r => r.kind === h && r.enabled === on))])))))
  } finally {
    for (const b of clients) { b.clearControlStates(); b.deactivateItem(); b.quit('air trial finished') }
    await sleep(500)
  }
}
if (require.main === module) main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
