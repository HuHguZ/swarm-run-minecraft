import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm-driver'
import { doctrineScenes, evaluateDoctrine, validateSceneDefinitions } from './swarm-doctrine-scenes'
import { REPO_ROOT } from '../../daemon/src/paths'

// The lab operator owns the running slot; this harness never starts or stops a server.
const io = require('../results/doctrine-lab-io.cjs')
const output = path.join(REPO_ROOT, 'farm/results', `swarm-doctrines-native-${Date.now()}.json`)
const wanted = new Set((process.env.DOCTRINE_CASES || '').split(',').filter(Boolean))
const scenes = doctrineScenes().filter(s => !wanted.size || wanted.has(s.id))
assert.ok(scenes.length > 0, 'at least one known doctrine must be selected')
for (const id of wanted) assert.ok(scenes.some(s => s.id === id), `unknown doctrine ${id}`)
const selected = io.peers.slice(0, 12)
const clients = selected.map(p => io.rpc(p))
const admin = io.rcon()
const nativeLog = process.env.DOCTRINE_NATIVE_LOG
const report: any = { startedAt: new Date().toISOString(), native: true, slot: 31,
  execution: 'existing SWARM_DOCTRINE option, production createSwarmDriver, real own sightings',
  cases: [], passed: false }
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2))
const log = (...a) => console.log(new Date().toISOString(), ...a)
const detail = r => r?.detail || r || {}
const records = () => nativeLog && fs.existsSync(nativeLog)
  ? fs.readFileSync(nativeLog, 'utf8').split('\n').filter(Boolean).flatMap(s => { try { return [JSON.parse(s)] } catch { return [] } }) : []
const at = p => `${p.x} ${p.y} ${p.z}`
const command = async s => {
  const result = await admin.call(s)
  assert.ok(!/Unknown(?: or incomplete| effect| item| attribute)|Incorrect argument|No entity was found|Too many blocks|not loaded/i.test(result), `${s}: ${result}`)
  return result
}
const stopActors = async () => { await Promise.all(clients.map(c => c.call('stop').catch(() => {}))) }
// Игровые часы решений роя — как в ffa при TICK_RATE > 20: темп — прирост gametime (RCON) к стене, раз в секунду.
// Без них в лаборатории на 40 TPS драйвер жил вдвое медленнее игры, чем на арене (ревью 13.10).
let clock: { now: () => number; stop: () => void } = { now: () => Date.now(), stop: () => {} }
async function gameClock() {
  const gt = async () => { const m = /(\d+)/.exec(await admin.call('time query gametime').catch(() => '') || ''); return m ? [Date.now(), +m[1]] : null }
  const a = await gt(); await io.sleep(1000); let last = await gt()
  let speed = a && last && last[0] > a[0] ? Math.max(.5, (last[1] - a[1]) * 50 / (last[0] - a[0])) : 1
  let base = Date.now(), virt = base
  const now = () => virt + (Date.now() - base) * speed
  const timer = setInterval(async () => {
    const t = await gt(); if (!t) return
    if (last && t[0] > last[0]) { virt = now(); base = Date.now(); speed = speed * .7 + Math.max(.5, (t[1] - last[1]) * 50 / (t[0] - last[0])) * .3 }
    last = t
  }, 1000)
  report.driverClock = { speedAtStart: speed }
  log('driver game clock, speed ×' + speed.toFixed(2))
  return { now, stop: () => clearInterval(timer) }
}

async function run(scene) {
  const startedAt = Date.now(), entry: any = { id: scene.id, startedAt, required: scene.required,
    execution: 'controlled doctrine execution', frames: [], plans: [], cells: [], rpcs: [], logs: [], packets: [], actorIds: {} }
  report.cases.push(entry); save()
  const active = scene.actors.map((actor, k) => ({ ...actor, name: selected[k].name, client: clients[k] }))
  const byKey = new Map<string, any>(active.map(a => [a.key, a]))
  const byName = new Map<string, any>(active.map(a => [a.name, a]))
  const replace = value => typeof value === 'string' && byKey.has(value) ? byKey.get(value).name
    : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)])) : value
  const pos: any = {}, calls = new Set<Promise<any>>(), deferredFood: string[] = []
  let running = true, scriptIndex = 0
  await stopActors()
  await command(`gamerule natural_health_regeneration ${scene.naturalRegeneration ? 'true' : 'false'}`)
  for (const p of selected) await command(`gamemode spectator ${p.name}`)
  await command('fill 2977 220 2977 3024 227 3024 air')
  await command('fill 2977 228 2977 3024 234 3024 air')
  await command('fill 2977 219 2977 3024 219 3024 stone')
  for (const f of scene.fills || []) await command(`fill ${at(f.a)} ${at(f.b)} ${f.block}`)
  for (const actor of active) {
    await command(`clear ${actor.name}`)
    await command(`effect clear ${actor.name}`)
    await command(`attribute ${actor.name} minecraft:knockback_resistance base set 0`)
    await command(`team join nd_doctrine_${actor.team} ${actor.name}`)
    await command(`tp ${actor.name} ${at(actor.p)}`)
    await command(`gamemode survival ${actor.name}`)
    await command(`effect give ${actor.name} instant_health 1 10 true`)
    await io.sleep(100)
    await command(`effect clear ${actor.name} instant_health`)
    await command(`effect give ${actor.name} saturation 1 20 true`)
    if (actor.hp < 20) await command(`damage ${actor.name} ${20 - actor.hp} minecraft:generic`)
    for (const [item, count] of Object.entries(actor.inv || {})) if (Number(count) > 0 && !(item === 'splash_potion' && actor.potions)) {
      const enchant = /_sword$/.test(item) && actor.ench?.sharpness ? `[enchantments={sharpness:${actor.ench.sharpness}}]` : ''
      const give = `give ${actor.name} ${item}${enchant} ${count}`
      // A hungry body's auto-eat must start in the measured scene, after its initial HUD check.
      if (actor.food < 20 && item === 'golden_apple') deferredFood.push(give)
      else await command(give)
    }
    for (const [kind, count] of Object.entries(actor.potions || {})) if (Number(count) > 0)
      await command(`give ${actor.name} splash_potion[potion_contents={potion:"minecraft:${kind.replace(/^splash_/, '')}"}] ${count}`)
    for (const [slot, item] of Object.entries(actor.armor || {})) await command(`item replace entity ${actor.name} armor.${slot === 'torso' ? 'chest' : slot} with ${item}${actor.ench?.protection ? `[enchantments={protection:${actor.ench.protection}}]` : ''}`)
    for (const effect of actor.effects || []) {
      const applied = await command(`effect give ${actor.name} ${effect.name} ${effect.seconds} ${effect.amplifier} true`)
      assert.ok(/Applied effect/i.test(applied), `${actor.key} fixture effect was not applied: ${applied}`)
      entry.logs.push({ at: Date.now(), text: `fixture effect ${actor.key}: ${applied}` })
    }
    for (const [attribute, value] of Object.entries(actor.attributes || {})) await command(`attribute ${actor.name} minecraft:${attribute} base set ${value}`)
    if (actor.held) await actor.client.call('equip', { item: actor.held, destination: 'hand' })
    await actor.client.call('temper', { enabled: false })
  }
  if (active.some(a => a.food < 20)) {
    for (const a of active.filter(a => a.food < 20)) await command(`effect give ${a.name} hunger 5 255 true`)
    await io.sleep(2200)
    for (const a of active) await command(`effect clear ${a.name} hunger`)
  }
  await io.sleep(500)
  const nativeStart = Date.now()
  const bots = active.filter(a => a.team === 'blue').map(a => ({ name: a.name, team: a.team, c: { call: async (method, params = {}) => {
    if (!running) throw new Error('doctrine scene ended; stale action rejected')
    const row: any = { at: Date.now(), actor: a.key, method, params }; entry.rpcs.push(row)
    try { const r = await a.client.call(method, params); row.finishedAt = Date.now(); row.result = r; return r }
    catch (error) { row.finishedAt = Date.now(); row.error = String(error); throw error }
  } } }))
  process.env.SWARM_DOCTRINE = scene.id
  const driver = createSwarmDriver({ bots, pos, arena: scene.arena, arms: false, now: clock.now,
    alive: name => running && (pos[name]?.hp ?? 0) > 0,
    home: () => scene.arena, hostile: (_b, id) => byName.get(id)?.team === 'red',
    log: (...args) => entry.logs.push({ at: Date.now(), text: args.join(' ') }) })
  const busy = new Set<string>()
  const scripts = [...(scene.scripts || [])].sort((a, b) => a.afterMs - b.afterMs)
  const poll = async () => {
    const snapshot = await Promise.all(active.map(async a => {
      const r = await a.client.call('status', { physics: true, items: true, swarm: true,
        swarmAllies: active.filter(o => o.team === a.team && o.name !== a.name).map(o => o.name) })
      assert.equal(r.detail.server, '127.0.0.1:25631', `owned body ${a.name} changed servers`)
      const s = r.state, d = r.detail, p = d.physics?.pos || s.pos
      if (a.team === 'blue') pos[a.name] = { p: { ...p }, hp: s.health, inv: s.inventory || {}, armor: s.armor || {},
        offHand: s.offHand || null, potions: s.potions || {}, enchants: d.ownEnchants || [] }
      return { a, r, frame: { p: { ...p }, hp: s.health, food: s.food, inventory: { ...s.inventory },
        armor: s.armor, potions: s.potions, held: s.held, offHand: s.offHand, enchants: d.ownEnchants,
        velocity: d.physics?.velocity, onGround: d.physics?.onGround, yaw: d.physics?.yaw, pitch: d.physics?.pitch,
        gameTick: s.clock?.ticks, clockId: s.clock?.id } }
    }))
    // Only same-body reports enter decisions. Opposing own HUD snapshots are lab evidence.
    for (const { a, r } of snapshot) if (a.team === 'blue') driver.observe(bots.find(b => b.name === a.name), r.detail.sightings || [])
    const frame: any = { at: Date.now(), gameTick: snapshot[0]?.frame.gameTick, actors: Object.fromEntries(snapshot.map(s => [s.a.key, s.frame])) }
    entry.frames.push(frame)
    entry.plans.push({ at: Date.now(), snapshot: driver.snapshot() })
  }
  try {
    await poll()
    entry.initial = entry.frames[0]
    for (const a of active) {
      const own = entry.initial.actors[a.key]
      assert.ok(Math.hypot(...['x', 'y', 'z'].map(k => own.p[k] - a.p[k])) < 1.5, `${a.key} fixture pose did not settle`)
      assert.ok(Math.abs(own.hp - a.hp) <= 1, `${a.key} actual HP ${own.hp}, prepared ${a.hp}`)
      if (a.food < 20) assert.ok(own.food < 20, `${a.key} must actually be hungry for the food-use scene`)
      for (const [slot, item] of Object.entries(a.armor || {})) assert.equal(own.armor?.[slot], item, `${a.key} own armor ${slot}`)
      for (const [potion, count] of Object.entries(a.potions || {})) assert.ok((own.potions?.[potion] || 0) >= Number(count), `${a.key} typed healing potion not prepared`)
    }
    for (const give of deferredFood) await command(give)
    const deadline = nativeStart + scene.seconds * 1000
    while (Date.now() < deadline) {
      await poll()
      while (scriptIndex < scripts.length && scripts[scriptIndex].afterMs <= Date.now() - nativeStart) {
        const script = scripts[scriptIndex++], actor = byKey.get(script.actor)
        assert.ok(actor, `missing script actor ${script.actor}`)
        const row: any = { at: Date.now(), actor: actor.key, method: script.method, params: { ...replace(script.params), arena: scene.arena }, fixtureScript: true }
        entry.rpcs.push(row)
        const promise = actor.client.call(script.method, row.params).then(result => { row.result = result; row.finishedAt = Date.now() })
          .catch(error => { row.error = String(error); entry.logs.push({ at: Date.now(), text: `script: ${error}` }) })
        calls.add(promise); promise.finally(() => calls.delete(promise))
      }
      for (const b of bots) if (!busy.has(b.name) && (pos[b.name]?.hp || 0) > 0) {
        busy.add(b.name)
        const promise = driver.turn(b).catch(error => entry.logs.push({ at: Date.now(), text: `turn ${b.name}: ${error}` }))
          .finally(() => busy.delete(b.name))
        calls.add(promise); promise.finally(() => calls.delete(promise))
      }
      await io.sleep(200)
    }
    running = false; await stopActors()
    await Promise.race([Promise.allSettled([...calls]), io.sleep(12000)])
    assert.equal(calls.size, 0, 'cancelled scene actions must settle before the next fixture')
    await poll()
    const rows = records().filter(r => r.at >= nativeStart && r.at <= Date.now())
    for (const r of rows) {
      r.direction = r.direction === 'in' ? 'incoming' : r.direction === 'out' ? 'outgoing' : r.direction
      if (r.packetName === 'explosion') { entry.packets.push(r); continue }
      const actor = byName.get(r.actor || r.name)
      if (!actor) continue
      if (r.entityId || r.ownEntityId) entry.actorIds[actor.key] = r.ownEntityId ?? r.entityId
      if (/^(use_entity|use_item|block_place|block_dig|damage_event|entity_damage|entity_velocity|update_health|respawn)$/.test(r.packetName || '')) entry.packets.push({ ...r, actor: actor.key })
      if (r.p || r.position) {
        const nearest = entry.frames.reduce((best, frame) => Math.abs(frame.at - r.at) < Math.abs(best.at - r.at) ? frame : best, entry.frames[0])
        if (Math.abs(nearest.at - r.at) < 350) Object.assign(nearest.actors[actor.key], { yaw: r.yaw, pitch: r.pitch,
          activeItem: r.activeItem, shield: r.shield, ownEntityId: r.ownEntityId })
      }
    }
    const tasks = entry.plans.flatMap(p => Object.values(p.snapshot).flatMap((b: any) => b.tasks || []))
    const cells = new Map<string, any>(tasks.filter(t => t.kind === 'build' && t.position).map(t => [at(t.position), t]))
    for (const p of scene.blueprint?.cells || []) cells.set(at(p), { position: p, data: { block: 'cobblestone' } })
    for (const p of scene.blueprint?.slits || []) cells.set(at(p), { position: p, data: { block: 'air' } })
    for (const p of scene.blueprint?.floor || []) cells.set(at(p), { position: p, data: { block: 'stone' } })
    for (const cell of cells.values()) {
      const receipt = entry.rpcs.find(r => r.method === 'swarm_work' && r.params.kind === 'place' &&
        at(r.params.at) === at(cell.position) && detail(r.result).done && detail(r.result).why === 'placed' &&
        detail(r.result).at && at(detail(r.result).at) === at(cell.position) && detail(r.result).after === cell.data.block)
      entry.cells.push({ at: Date.now(), p: cell.position, block: cell.data.block, actor: receipt?.actor,
        confirmed: /passed/i.test(await command(`execute if block ${at(cell.position)} minecraft:${cell.data.block}`)), source: 'rcon' })
    }
    entry.result = evaluateDoctrine(scene, entry)
    entry.finishedAt = Date.now()
    log(scene.id, JSON.stringify(entry.result)); save()
  } finally { running = false; await stopActors(); driver.reset(); for (const p of selected) await command(`gamemode spectator ${p.name}`) }
}

async function main() {
  validateSceneDefinitions()
  await admin.ready; await Promise.all(clients.map(c => c.ready))
  if (process.env.DRIVER_WALL_CLOCK !== '1') clock = await gameClock()
  const naturalRegeneration = await command('gamerule natural_health_regeneration')
  const oldDoctrine = process.env.SWARM_DOCTRINE
  try {
    await command('gamerule natural_health_regeneration false')
    for (const team of ['blue', 'red']) { await admin.call(`team add nd_doctrine_${team}`); await command(`team modify nd_doctrine_${team} friendlyFire false`) }
    for (const scene of scenes) { try { await run(scene) } catch (error) { report.cases[report.cases.length - 1].error = String(error); log(scene.id, String(error)); save() } }
    report.passed = report.cases.length === scenes.length && report.cases.every(c => c.result?.passed)
    if (!report.passed) process.exitCode = 1
  } finally {
    await stopActors()
    await command(`gamerule natural_health_regeneration ${/true/i.test(naturalRegeneration) ? 'true' : 'false'}`)
    for (const p of selected) {
      await admin.call(`effect clear ${p.name}`)
      await admin.call(`attribute ${p.name} minecraft:knockback_resistance base set 0`)
      await admin.call(`gamemode spectator ${p.name}`)
    }
    for (const team of ['blue', 'red']) await admin.call(`team remove nd_doctrine_${team}`)
    if (oldDoctrine === undefined) delete process.env.SWARM_DOCTRINE; else process.env.SWARM_DOCTRINE = oldDoctrine
    clock.stop(); for (const c of clients) c.close(); admin.close()
    report.finishedAt = new Date().toISOString(); save(); log('EVIDENCE', output)
  }
}
main().catch(error => { report.error = String(error); save(); for (const c of clients) c.close(); admin.close(); console.error(error); process.exitCode = 1 })
