'use strict'
// Live deterministic timing/movement/mining/combat + freeze/step probe. Farm only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { connect, createKit } = require('./scene-kit')
const clock = require('./src/game-clock')

async function waitInChunks (call, seconds) {
  let result
  for (let left = seconds; left > 0;) {
    const chunk = Math.min(300, left) // Session.wait caps one RPC at 300 game seconds.
    result = await call('wait', { seconds: chunk })
    if (result.status !== 'done') return result
    left -= chunk
  }
  return { ...result, detail: { ...result.detail, waited: seconds } }
}

// A command echo is not proof that the client has settled after world loading,
// teleporting and changing mode. Warm up with native time, and fail rather than
// healing or resetting a lagging clock during the measured survival skills.
async function warmFixture (call, rate, { wall = clock.wall, timeoutMs = 30000, stableMs = 1000 } = {}) {
  const started = wall.monotonic()
  let stableFrom = null; let maxLagTicks = 0; let samples = 0; let last
  for (;;) {
    const r = await call('status', { physics: true })
    const s = r.state || {}; const c = s.clock || {}; const p = s.pos || {}
    const now = wall.monotonic()
    samples++
    if (Number.isFinite(c.lagTicks)) maxLagTicks = Math.max(maxLagTicks, c.lagTicks)
    last = { health: s.health, food: s.food, pos: s.pos, onGround: r.detail?.physics?.onGround,
      rate: c.tickRate, effectiveRate: c.effectiveRate, lagTicks: c.lagTicks, ticks: c.ticks }
    const ready = s.dimension === 'overworld' && s.health === 20 && s.food === 20 &&
      Math.abs(p.x - 2800.5) <= 1 && Math.abs(p.y - 200) <= 0.1 && Math.abs(p.z - 2800.5) <= 1 &&
      last.onGround === true && c.running && !c.frozen && c.tickRate === rate &&
      Number.isFinite(c.lagTicks) && c.lagTicks <= 20
    stableFrom = ready ? stableFrom ?? now : null
    if (stableFrom !== null && now - stableFrom >= stableMs) return { status: 'done', samples,
      realSeconds: +((now - started) / 1000).toFixed(3), maxLagTicks, ...last }
    if (now - started >= timeoutMs) {
      const error = new Error('fixture warmup failed: ' + JSON.stringify(last))
      error.warmup = { status: 'failed', samples, realSeconds: +((now - started) / 1000).toFixed(3), maxLagTicks, ...last }
      throw error
    }
    await wall.sleep(200)
  }
}

async function waitForMob (call, name, { wall = clock.wall, timeoutMs = 3000 } = {}) {
  const started = wall.monotonic()
  for (;;) {
    const r = await call('observe', { radius: 4, fair: false })
    const entities = r.detail?.entities || []
    const now = wall.monotonic()
    if (entities.some(e => String(e.name).toLowerCase() === name)) return { status: 'done',
      realSeconds: +((now - started) / 1000).toFixed(3), lagTicks: r.state?.clock?.lagTicks ?? null }
    if (now - started >= timeoutMs) throw new Error(`fixture ${name} not observed within ${timeoutMs} wall ms`)
    await wall.sleep(50)
  }
}

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  assert.ok(slot >= 1 && slot <= 32 && process.env.ND_WS === `ws://127.0.0.1:${8800 + slot}`, 'farm only')
  const requestedRate = Number(process.env.TICK_RATE || process.env.ND_TICK_RATE || 20)
  assert.ok(Number.isFinite(requestedRate) && requestedRate >= 1 && requestedRate <= 10000)
  const conn = connect(process.env.ND_WS)
  await conn.ready
  const rows = []
  const save = row => {
    rows.push(row)
    console.log(JSON.stringify(row))
    if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
  }
  const status = async () => (await conn.call('status', { physics: true })).state
  const measure = async (name, method, params) => {
    const before = await status()
    const start = clock.wall.monotonic()
    const r = method === 'wait' ? await waitInChunks(conn.call, params.seconds) : await conn.call(method, params)
    const realSeconds = (clock.wall.monotonic() - start) / 1000
    const ticks = r.state.clock.ticks - before.clock.ticks
    const serverTicks = before.clock.serverTicks == null || r.state.clock.serverTicks == null ? null : r.state.clock.serverTicks - before.clock.serverTicks
    const row = { slot, rate: before.clock.tickRate, effectiveBefore: before.clock.effectiveRate, effectiveAfter: r.state.clock.effectiveRate, name, status: r.status, code: r.code,
      ticks, serverTicks, lagTicks: r.state.clock.lagTicks, actualTPS: +(ticks / realSeconds).toFixed(1),
      actualServerTPS: serverTicks == null ? null : +(serverTicks / realSeconds).toFixed(1),
      seconds: ticks / 20, realSeconds: +realSeconds.toFixed(3), speedup: +(ticks / 20 / realSeconds).toFixed(2),
      hpBefore: before.health, hp: r.state.health, foodBefore: before.food, food: r.state.food,
      pos: r.state.pos, by: r.by, events: r.events, detail: r.detail }
    save(row)
    assert.equal(r.status, 'done', `${name}: ${r.error || r.code}`)
    return r
  }
  let kit
  try {
    assert.equal((await conn.call('connect')).status, 'done')
    await conn.call('stop')
    await conn.call('play_mode', { mode: 'free' })
    kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await kit.cmd('/tick rate 20')
    await kit.cmd('/gamemode creative')
    await kit.cmd('/effect clear @s')
    await kit.gamerule('keep_inventory', 'false')
    await kit.gamerule('spawn_mobs', 'false')
    await kit.gamerule('advance_time', 'false')
    await kit.cmd('/time set day')
    await kit.ensureWorld('overworld', { tp: '2800.5 205 2800.5' })
    await kit.forceload('overworld', [[2796, 198, 2796], [2832, 205, 2806]])
    await kit.fillExact('overworld', [[2796, 200, 2796], [2832, 205, 2806]], 'air')
    await kit.fillExact('overworld', [[2796, 199, 2796], [2832, 199, 2806]], 'stone')
    await kit.cmd('/tp @s 2800.5 200 2800.5')
    await kit.cmd('/execute in minecraft:overworld run kill @e[type=!minecraft:player,x=2814,y=200,z=2800,distance=..48]')
    await kit.cmd('/clear @s')
    for (const item of ['iron_sword', 'iron_pickaxe', 'bread 16']) await kit.cmd(`/give @s minecraft:${item}`)
    await kit.cmd('/gamemode survival')
    await kit.cmd('/effect give @s minecraft:saturation 1 5 true')
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    const warm = async phase => {
      try { save({ slot, name: 'warmup', phase, ...await warmFixture(conn.call, phase === 'setup' ? 20 : requestedRate) }) }
      catch (error) { if (error.warmup) save({ slot, name: 'warmup', phase, ...error.warmup }); throw error }
    }
    await warm('setup')
    await kit.cmd(`/tick rate ${requestedRate}`)
    await warm('target')
    const waitSeconds = Number(process.env.TICK_WAIT_SECONDS || 6)
    assert.ok(Number.isFinite(waitSeconds) && waitSeconds >= 1 && waitSeconds <= 600)
    const waited = await measure(`wait${waitSeconds}`, 'wait', { seconds: waitSeconds })
    assert.ok(waited.state.clock.tickRate > 0)
    const walk = await measure('walk24', 'goto', { x: 2824, y: 200, z: 2800, range: 1, timeoutSeconds: 20, sprint: false })
    assert.ok(walk.state.pos.x >= 2822, 'reached 24-block goal')
    await kit.cmd('/setblock 2825 200 2800 minecraft:stone')
    await clock.sleep(500) // observe the block update before invoking the skill
    const dug = await measure('dig-stone', 'dig_time', { x: 2825, y: 200, z: 2800, hold: 'iron_pickaxe', dig: true, settleMs: 100 })
    assert.equal(dug.detail.after, 'air')
    await kit.cmd('/kill @e[type=minecraft:zombie,distance=..32]')
    await kit.cmd('/summon minecraft:zombie 2825 200 2800 {NoAI:1b,PersistenceRequired:1b}')
    save({ slot, rate: requestedRate, name: 'zombie-visible', ...await waitForMob(conn.call, 'zombie') })
    const fight = await measure('fight-zombie', 'fight', { target: 'zombie', purpose: 'defense', timeoutSeconds: 20 })
    assert.ok(fight.detail.killed || fight.detail.kills?.length, 'zombie killed by skill')
    await kit.cmd('/tick freeze')
    await clock.wall.sleep(300)
    const frozen = await status()
    assert.equal(frozen.clock.frozen, true)
    let done = false
    const waiting = conn.call('wait', { seconds: 1 }).then(r => { done = true; return r })
    await clock.wall.sleep(350)
    assert.equal(done, false, 'game wait remains pending under freeze')
    await kit.cmd('/tick step 3')
    await clock.wall.sleep(500)
    const stepped = await status()
    assert.equal(stepped.clock.ticks - frozen.clock.ticks, 3, 'exactly 3 stepped ticks')
    assert.equal(done, false, 'three ticks do not exhaust 20-tick wait')
    await kit.cmd('/tick unfreeze')
    assert.equal((await waiting).status, 'done')
    save({ slot, rate: frozen.clock.tickRate, name: 'freeze-step', ok: true, ticks: 3 })
    await kit.cmd('/tick rate 40')
    await clock.wall.sleep(300)
    const changed = await measure('rate-change-wait4', 'wait', { seconds: 4 })
    assert.equal(changed.state.clock.tickRate, 40)
  } finally {
    if (kit) { try { await kit.cmd('/tick unfreeze') } catch {} }
    try { await conn.call('disconnect') } catch {}
    conn.close()
  }
}
module.exports = { waitInChunks, warmFixture, waitForMob }
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1 })
