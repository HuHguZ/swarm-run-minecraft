// Изолированный измеритель потока идей: только слот 28; запуск из dist-ideas<N>.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { REPO_ROOT, DIST_ROOT } from '../../../daemon/src/paths'
import { rcon } from '../../arena/server'

export function summarize(rows: any[]) {
  const sum = (k: string) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0)
  const kills = rows.filter(r => Number.isFinite(r.ttkMs))
  return { n: rows.length, damage: rows.length ? sum('damage') / rows.length : 0,
    kills: sum('kills'), ownDeaths: sum('ownDeaths'), successRate: rows.length ? rows.filter(r => r.success).length / rows.length : 0,
    meanKillMs: kills.length ? kills.reduce((n, r) => n + r.ttkMs, 0) / kills.length : null }
}

const SLOT = 28
const OUT = path.join(REPO_ROOT, 'farm/results/ideas-28')
const STOP = path.join(REPO_ROOT, 'codex-lab/AUTO-STOP')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const stopped = () => fs.existsSync(STOP)
const clients: any[] = []
export { cmd, connect, reset, arena, target, chase, clients, sleep, stopped }
const mod = (name: string) => require(path.join(REPO_ROOT, 'daemon/node_modules', name))
let adversary: ReturnType<typeof spawn> | null = null
async function cmd(command: string) {
  const reply = String(await rcon(SLOT, command))
  if (/^kill @e/.test(command) && /No entity was found/.test(reply)) return reply
  if (/Unknown|Incorrect argument|No entity|Expected|Cannot|Invalid|not a valid/i.test(reply)) throw new Error(`${command}: ${reply}`)
  return reply
}
async function connect(name: string, clock: any = null) {
  const plugins = clock ? require(path.join(DIST_ROOT, 'daemon/src/tick-plugins')).createTickPlugins(clock).plugins : undefined
  const bot = mod('mineflayer').createBot({ host: '127.0.0.1', port: 25600 + SLOT, username: name, version: '1.21.11', auth: 'offline', ...(plugins ? { plugins } : {}) })
  if (clock) clock.attach(bot)
  clients.push(bot)
  bot.on('error', (e: Error) => console.error(name, e.message))
  const { velocityFromRaw } = require(path.join(DIST_ROOT, 'daemon/src/drops'))
  bot._client.on('packet', (pk: any, meta: any, bytes: any) => {
    if (meta?.name !== 'entity_velocity' || pk?.entityId !== bot.entity?.id) return
    const v = velocityFromRaw(bytes, 'velocity')
    if (v) pk.velocity = { x: v.x * 8000, y: v.y * 8000, z: v.z * 8000 }
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: spawn timeout`)), 30000)
    bot.once('spawn', () => { clearTimeout(timer); resolve() })
    bot.once('kicked', r => { clearTimeout(timer); reject(new Error(`${name}: ${JSON.stringify(r)}`)) })
  })
  await cmd(`gamemode creative ${name}`)
  await cmd(`tp ${name} 610.5 151 610.5`)
  return bot
}
function target(bot: any, name: string) { return Object.values<any>(bot.entities).find(e => e.username === name) }
export function measure(bot: any) {
  const hp0 = bot.health
  let last = bot.health, damage = 0, healing = 0, deaths = 0, events = 0, ttkMs: number | null = null
  const t0 = Date.now()
  const health = () => { if (deaths) return; damage += Math.max(0, last - bot.health); healing += Math.max(0, bot.health - last); last = bot.health }
  const death = () => { if (deaths) return; damage += Math.max(0, last); last = 0; deaths = 1; ttkMs = Date.now() - t0 }
  const packet = (pk: any) => { if (!deaths && pk.entityId === bot.entity?.id) events++ }
  bot.on('health', health); bot.on('death', death); bot._client.on('damage_event', packet)
  return () => {
    bot.removeListener('health', health); bot.removeListener('death', death); bot._client.removeListener('damage_event', packet)
    return { hp0, damage, healing, deaths, damageEvents: events, ttkMs, hp: deaths ? 0 : bot.health }
  }
}
async function reset(actors: any[], poses: number[][], shield = false) {
  if (stopped()) throw new Error('AUTO-STOP')
  for (const b of clients) { b.clearControlStates(); b.deactivateItem(); await cmd(`gamemode spectator ${b.username}`) }
  await cmd('kill @e[type=item]')
  await cmd('random reset * 280126')
  for (let i = 0; i < actors.length; i++) {
    const b = actors[i], p = poses[i]
    await cmd(`gamemode creative ${b.username}`)
    await cmd(`effect clear ${b.username}`); await cmd(`clear ${b.username}`)
    for (const slot of ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet', 'weapon.offhand']) await cmd(`item replace entity ${b.username} ${slot} with minecraft:air`)
    await cmd(`tp ${b.username} ${p[0]} 151 ${p[1]}`)
    await cmd(`give ${b.username} minecraft:diamond_sword`); await cmd(`give ${b.username} minecraft:diamond_axe`)
    await cmd(`effect give ${b.username} minecraft:instant_health 1 10 true`)
    await cmd(`gamemode survival ${b.username}`)
  }
  if (shield) await cmd(`item replace entity ${actors[actors.length - 1].username} weapon.offhand with minecraft:shield`)
  await sleep(1000)
}
async function chase(bot: any, names: string[], ctl: any) {
  const pick = require(path.join(DIST_ROOT, 'daemon/src/pick'))
  while (!ctl.aborted && !stopped() && bot.health > 0) {
    const e = names.map(n => target(bot, n)).filter(e => e?.isValid !== false && e?.position)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    if (e) {
      const dv = e.position.minus(bot.entity.position), d = Math.hypot(dv.x, dv.z)
      await bot.look(Math.atan2(-dv.x, -dv.z), 0, true)
      bot.setControlState('forward', d > 2.1); bot.setControlState('sprint', d > 2.1)
      if (pick.aim(bot, e)) bot.setControlState('jump', false)
    } else bot.clearControlStates()
    await sleep(50)
  }
  bot.clearControlStates()
}
async function arena() {
  for (const c of ['gamerule keep_inventory false', 'gamerule natural_health_regeneration false', 'gamerule spawn_mobs false',
    'time set day', 'weather clear', 'setworldspawn 600 151 600', 'forceload add 576 576 624 624',
    'fill 580 150 580 620 150 620 minecraft:stone', 'fill 580 151 580 620 157 620 minecraft:air',
    'fill 597 151 599 604 153 599 minecraft:stone']) await cmd(c)
}
async function trials(stage = 'all') {
  const { runMeleeCombo, debuffOpening, splashMedic } = require(path.join(DIST_ROOT, 'daemon/src/swarm/combos/ideas'))
  const bots = []
  for (const suffix of ['c', 'd', 'e', 'f', 'g', 'h']) bots.push(await connect(`NeuroFarm28${suffix}`))
  const rows: any[] = []
  const record = (row: any) => { rows.push(row); fs.appendFileSync(path.join(OUT, 'trials.jsonl'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)) }
  if (stage === 'all') for (const shield of [false, true]) for (let rep = 0; rep < 3; rep++) for (const kind of (rep % 2 ?
    (shield ? ['shield-break', 'simultaneous'] : ['stagger', 'simultaneous']) : (shield ? ['simultaneous', 'shield-break'] : ['simultaneous', 'stagger']))) {
    const a = bots.slice(0, 2), victim = bots[2]
    await reset([...a, victim], [[600, 602.4], [601.1, 602.4], [600.5, 600.5]], shield)
    let shieldReady = null
    if (shield) {
      await sleep(5100)
      await victim.lookAt(a[0].entity.position.offset(0, 1.5, 0), true); victim.activateItem(true); await sleep(500)
      const keys = a[0].registry.entitiesByName.player.metadataKeys
      const flags = keys.indexOf('living_entity_flags')
      shieldReady = { offhand: victim.inventory.slots[45]?.name, active: !!(target(a[0], victim.username)?.metadata[flags] & 1) }
      if (shieldReady.offhand !== 'shield' || !shieldReady.active) throw new Error(`shield not ready: ${JSON.stringify(shieldReady)}`)
    }
    const finish = measure(victim), own = a.map(measure), ctl = { aborted: false }
    const sent = await Promise.all(a.map((b, index) => runMeleeCombo(b, target(b, victim.username), { kind, index, count: 2, rounds: 3, ctl })))
    await sleep(500); ctl.aborted = true
    const result = finish(), ours = own.map(f => f())
    record({ stage: shield ? 'shield' : 'iframe', rep, kind, shieldReady, ...result, kills: result.deaths, ownDeaths: ours.reduce((n, r) => n + r.deaths, 0), success: result.damage > 0, sent })
  }
  for (const kind of ['weakness', 'slowness']) for (let rep = 0; rep < 3; rep++) {
    const thrower = bots[0], victim = bots[2]
    const range = stage === 'ground' ? 5 : 6
    await reset([thrower, victim], [[600.5, 600.5 + range], [600.5, 600.5]])
    await cmd(`give ${thrower.username} minecraft:splash_potion[potion_contents={potion:"minecraft:${kind}"}]`)
    await sleep(400)
    const before = measure(victim)
    const result = await debuffOpening(thrower, target(thrower, victim.username), { kind, allies: [] })
    await sleep(1600)
    const raw = await cmd(`data get entity ${victim.username} active_effects`)
    const ownEffects = await cmd(`data get entity ${thrower.username} active_effects`)
    const receipt = before()
    record({ stage: 'debuff', range, rep, kind, result, effects: raw, ownEffects, ...receipt, kills: receipt.deaths, ownDeaths: 0,
      success: raw.includes(`minecraft:${kind}`) && !ownEffects.includes(`minecraft:${kind}`) })
  }
  if (stage === 'all' && splashMedic) for (let rep = 0; rep < 3; rep++) {
    const healer = bots[0], friends = bots.slice(1, 3)
    await reset([healer, ...friends], [[600.5, 606.5], [600, 602.5], [601, 602.5]])
    for (const b of friends) await cmd(`damage ${b.username} 12 minecraft:generic`)
    await cmd(`give ${healer.username} minecraft:splash_potion[potion_contents={potion:"minecraft:strong_healing"}]`)
    await sleep(400)
    const ends = friends.map(measure)
    healer._ndSwarmAllies = friends.map(b => b.username)
    const result = await splashMedic(healer, friends.map(b => ({ ...target(healer, b.username), health: b.health })), [])
    await sleep(1600)
    const receipts = ends.map(f => f())
    record({ stage: 'medic', rep, result, receipts, damage: 0, kills: 0, ownDeaths: 0, success: receipts.every(r => r.healing > 0), healed: receipts.reduce((n, r) => n + r.healing, 0), ttkMs: null })
  }
  console.log('SUMMARY', JSON.stringify(Object.fromEntries([...new Set(rows.map(r => `${r.stage}/${r.kind ?? 'heal'}`))].map(key => [key, summarize(rows.filter(r => `${r.stage}/${r.kind ?? 'heal'}` === key))]))))
}

async function smallRounds() {
  const { runMeleeCombo, debuffOpening } = require(path.join(DIST_ROOT, 'daemon/src/swarm/combos/ideas'))
  const bots = []
  for (const suffix of ['c', 'd', 'e', 'f']) bots.push(await connect(`NeuroFarm28${suffix}`))
  await cmd('fill 597 151 599 604 153 599 minecraft:air')
  for (let rep = 0; rep < 3; rep++) for (const enhanced of (rep % 2 ? [true, false] : [false, true])) {
    await reset(bots, [[598, 607], [602, 607], [598, 601], [602, 601]])
    const blue = bots.slice(0, 2), red = bots.slice(2), ctl = { aborted: false }, ends = bots.map(measure)
    const fallen = new Set<string>(), actorCtl = bots.map(() => ({ aborted: false }))
    const deaths = bots.map((b, i) => { const fn = () => { fallen.add(b.username); actorCtl[i].aborted = true }; b.once('death', fn); return fn })
    const loops = bots.map((b, i) => chase(b, (i < 2 ? red : blue).map(b => b.username), actorCtl[i]))
    if (enhanced) {
      await cmd(`give ${blue[0].username} minecraft:splash_potion[potion_contents={potion:"minecraft:weakness"}]`)
      await sleep(200)
      await debuffOpening(blue[0], target(blue[0], red[0].username), { kind: 'weakness', allies: blue.slice(1).map(b => target(blue[0], b.username)) })
    }
    const attacks = bots.map(async (b, i) => {
      while (!actorCtl[i].aborted && b.health > 0 && !stopped()) {
        const names = (i < 2 ? red : blue).filter(b => !fallen.has(b.username)).map(b => b.username)
        const foe = names.map(n => target(b, n)).filter(Boolean).sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))[0]
        if (!foe) break
        await runMeleeCombo(b, foe, { kind: enhanced && i < 2 ? 'shield-break' : 'simultaneous', index: i % 2, count: 2, rounds: 1, ctl: actorCtl[i] })
        await sleep(500)
      }
    })
    await sleep(12000); ctl.aborted = true; actorCtl.forEach(c => { c.aborted = true }); await Promise.all([...loops, ...attacks])
    bots.forEach((b, i) => b.removeListener('death', deaths[i]))
    const receipts = ends.map(f => f()), enemies = receipts.slice(2)
    const row = { stage: '2v2', rep, enhanced, damage: enemies.reduce((n, r) => n + r.damage, 0), kills: enemies.reduce((n, r) => n + r.deaths, 0),
      ownDeaths: receipts.slice(0, 2).reduce((n, r) => n + r.deaths, 0), success: enemies.some(r => r.deaths), ttkMs: Math.min(...enemies.map(r => r.ttkMs ?? Infinity)), receipts }
    if (!Number.isFinite(row.ttkMs)) row.ttkMs = null
    fs.appendFileSync(path.join(OUT, 'rounds.jsonl'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row))
  }
}

async function actualAdversary() {
  const { runMeleeCombo, debuffOpening } = require(path.join(DIST_ROOT, 'daemon/src/swarm/combos/ideas'))
  const bots = []
  for (const suffix of ['c', 'd', 'e', 'f', 'g']) bots.push(await connect(`NeuroFarm28${suffix}`))
  await cmd('team add red').catch(() => {})
  await reset(bots, [[600, 602], [602, 602], [604, 602], [600, 605], [604, 605]])
  const own = bots.map(measure)
  const scenes = process.env.IDEAS_ADV_SCENES || 'idle'
  if (!['idle', 'rush'].includes(scenes)) throw new Error('IDEAS_ADV_SCENES: idle or rush')
  const enhanced = process.env.IDEAS_COMBO === '1'
  const log = fs.openSync(path.join(OUT, `adversary-${scenes}-${enhanced ? 'combo' : 'control'}.log`), 'w')
  adversary = spawn(process.execPath, [path.join(DIST_ROOT, 'farm/arena/adversary.js'), '28', scenes, '0.7', 'IdeasChamp'],
    { env: { ...process.env, ADV_IDLE_S: '30' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let idle = false, ready = false, text = ''
  adversary.stdout!.on('data', data => { fs.writeSync(log, data); text += data; if (text.includes('в красных, ботов видно:')) ready = true; if (text.includes('🧪 idle')) idle = true })
  adversary.stderr!.on('data', data => fs.writeSync(log, data))
  for (let i = 0; i < 100 && !ready && !stopped(); i++) {
    await cmd('team join red IdeasChamp').catch(() => {}); await sleep(200)
  }
  if (scenes === 'idle') {
    for (let i = 0; i < 60 && !idle && !stopped(); i++) await sleep(200)
    if (!idle) throw new Error(`adversary idle not ready: ${text.slice(-500)}`)
  } else { if (!ready) throw new Error('adversary not ready'); await sleep(800) }
  await cmd('effect give IdeasChamp minecraft:instant_health 1 10 true')
  await sleep(150)
  await cmd('effect clear IdeasChamp minecraft:instant_health')
  const ctl = { aborted: false }, t0 = Date.now()
  // adversary штатно бессмертен; стенд снимает Resistance, чтобы измерить реальные потери HP.
  const clearEffects = async () => { for (const effect of ['resistance', 'regeneration']) await rcon(SLOT, `effect clear IdeasChamp minecraft:${effect}`) }
  await clearEffects()
  const clear = setInterval(() => { clearEffects().catch(() => {}) }, 200)
  let damageEvents = 0
  const event = (pk: any) => { if (pk.entityId === target(bots[0], 'IdeasChamp')?.id) damageEvents++ }
  bots[0]._client.on('damage_event', event)
  const killed = new Set<number>(), actorCtl = bots.map(() => ({ aborted: false }))
  let damage = 0, healing = 0, last: number | null = null, hp0: number | null = null, hp1: number | null = null, killMs: number | null = null
  let endLife: () => void
  const lifeEnded = new Promise<void>(resolve => { endLife = resolve })
  const ownDeath = bots.map((b, i) => { const fn = () => { actorCtl[i].aborted = true }; b.once('death', fn); return fn })
  const death = (e: any) => {
    if (e.username !== 'IdeasChamp' || killed.size) return
    killed.add(e.id); damage += Math.max(0, last ?? 0); hp1 = last = 0; killMs = Date.now() - t0
    actorCtl.forEach(c => { c.aborted = true }); endLife()
  }
  bots[0].on('entityDead', death)
  const hp = async () => { const s = await rcon(SLOT, 'data get entity IdeasChamp Health'); const m = /([\d.]+)f/.exec(String(s)); return m ? +m[1] : null }
  hp0 = await hp(); last = hp0
  if (hp0 !== 20) throw new Error(`adversary fixture HP must be 20, got ${hp0}`)
  const telemetry = setInterval(() => { hp().then(h => {
    if (killed.size) return
    if (h != null && last != null) { damage += Math.max(0, last - h); healing += Math.max(0, h - last) }
    if (h != null) { last = h; hp1 = h }
  }).catch(() => {}) }, 100)
  const jobs = bots.map(async (b, index) => {
    if (index > 1) return
    const movement = chase(b, ['IdeasChamp'], actorCtl[index])
    try {
      if (enhanced && !index) {
        await cmd(`give ${b.username} minecraft:splash_potion[potion_contents={potion:"minecraft:weakness"}]`); await sleep(200)
        await debuffOpening(b, target(b, 'IdeasChamp'), { kind: 'weakness', allies: bots.slice(1).map(a => target(b, a.username)).filter(Boolean) })
      }
      while (!actorCtl[index].aborted && !stopped() && b.health > 0) {
        const e = target(b, 'IdeasChamp')
        if (e) await runMeleeCombo(b, e, { kind: enhanced ? 'shield-break' : 'simultaneous', index, count: 2, rounds: 3, ctl: actorCtl[index] })
        else await sleep(100)
      }
    } finally { await movement }
  })
  try { await Promise.race([sleep(scenes === 'rush' ? 26000 : 10000), lifeEnded]) } finally { ctl.aborted = true; actorCtl.forEach(c => { c.aborted = true }); clearInterval(clear); clearInterval(telemetry); await Promise.all(jobs) }
  bots[0]._client.removeListener('damage_event', event)
  bots[0].removeListener('entityDead', death)
  bots.forEach((b, i) => b.removeListener('death', ownDeath[i]))
  const receipts = own.map(f => f())
  const row = { stage: 'adversary', scenes, enhanced, hp0, hp1, damage, healing, kills: killed.size, ttkMs: killMs, damageEvents, elapsedMs: Date.now() - t0, ownDeaths: receipts.reduce((n, r) => n + r.deaths, 0), receipts }
  fs.appendFileSync(path.join(OUT, 'adversary.jsonl'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row))
  adversary!.stdout!.removeAllListeners('data'); adversary!.stderr!.removeAllListeners('data'); fs.closeSync(log)
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  if (stopped()) throw new Error('AUTO-STOP')
  try {
    await arena()
    const mode = process.argv[2] || 'trials'
    if (mode === 'trials') await trials()
    else if (mode === 'ground') await trials('ground')
    else if (mode === 'rounds') await smallRounds()
    else if (mode === 'adversary') await actualAdversary()
    else throw new Error(`unknown mode ${mode}`)
  } finally {
    adversary?.kill()
    for (const bot of clients) { bot.clearControlStates(); bot.quit('ideas complete') }
    await sleep(500)
  }
}

if (process.argv.includes('--self-check')) {
  const assert = require('node:assert/strict')
  assert.deepEqual(summarize([{ damage: 8, kills: 0, ownDeaths: 0, success: true, ttkMs: null },
    { damage: 20, kills: 1, ownDeaths: 1, success: false, ttkMs: 1000 }]),
  { n: 2, damage: 14, kills: 1, ownDeaths: 1, successRate: .5, meanKillMs: 1000 })
  console.log('combo-ideas self-check PASS')
}
else if (require.main === module) main().then(() => process.exit(0), e => { console.error(e); process.exit(1) })
