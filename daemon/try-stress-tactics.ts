// Stage D of the tactical stress stand (research/claude-1006/tactics.md): the distractions of the abstract stand,
// honestly in Minecraft on a farm slot - primed TNT, a charged creeper, a zombie in diamond gear, blaze crowds (one over a
// platform edge), a mixed crowd, a wither skeleton - while the bot works a long skill. Commands only prepare the scene;
// the body acts on its own.
//   node farm/farm.js run try-stress-tactics.js --slots N --tag s4c-stress-<n> [PHASES=a,b] [PHASE_TICKS=1200]
// Rows (LAB_OUT): one per phase {phase, ok, died, deaths, causes, swaps, actions[{action,level,t}], hp0, minHp, hp, ticks,
// wallMs, physics, fell}; a summary {deaths, between, phases}. Fails on any death.
// Round 4 (S4c): deaths are counted by the server, not by the bot's events - a deathCount scoreboard (read through the
// body's chat, `ask`) and the death lines of the server log, read after the body settles. Round 2's s4b-flap-3 lost a fall
// ("fell from a high place" at the end of blaze-crowd, died:false): the status poll and the daemon's 'death' event both
// raced the landing. The phases are isolated: day, frozen time, no natural spawns (s4b-flap-1/2: 4 deaths to night mobs
// between two runs went unreported), and every phase runs a fixed number of game ticks, so lockstep and plain 750 compare.
// Round 4 (S4d): night (zombies and skeletons do not burn; time frozen at midnight), a 3-layer floor (a creeper crater is
// no hole into the void), KIT=iron (iron armour, iron sword, shield) or KIT=bare (stone sword only), the night mobs one by
// one (zombie, skeleton, spider, creeper, husk with an iron spear) and a crowd of four, and a Nether fortress bridge
// (3 wide over a 30-block drop: a wither skeleton walking up it, two blazes beside) - S1c's falls and boxes at the body.
import assert from 'node:assert/strict'
import fs from 'node:fs'

interface Event { type: string; action?: string; threatLevel?: number; hp?: number; gameAt?: number }
interface Selected { action?: string; level?: number; t?: number }
interface State { health: number; food: number; pos: { x: number; y: number; z: number }; busy: string | null
  physicsTicks?: number; clock?: { ticks?: number; tickRate?: number } }
const { connect, createKit } = require('./scene-kit')
const wallSleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))
// A death message of 1.21.11 (en_us death.*) starts with the victim's name and one of these words.
const DEATH = /^(was |fell |died|drowned|burned|went up|went off|blew up|hit the ground|tried to swim|walked into|suffocated|starved|froze|experienced|withered|discovered|didn't want|left the confines|squashed|is |got finished)/

async function main(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  const player = process.env.MC_USERNAME ?? `NeuroFarm${slot}`
  assert.ok(slot >= 1 && slot <= 32 && process.env.ND_WS === `ws://127.0.0.1:${8800 + slot}`, 'farm only; explicit slot and matching WS required')
  assert.ok(process.env.ND_SERVER_LOG, 'explicit farm server log required')
  const connection = connect(process.env.ND_WS)
  await connection.ready
  const call = (method: string, params: Record<string, unknown> = {}) => connection.call(method, params)
  const kit = createKit({ call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player, replyMs: 3000 })
  const save = (row: Record<string, unknown>) => {
    console.log(JSON.stringify(row))
    if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
  }
  const command = async (text: string, confirm = true) => {
    const result = await kit.cmd(text)
    if (confirm) assert.ok(result.ok, `farm command not confirmed: ${text}: ${result.why}`)
  }
  const status = async (): Promise<State> => (await call('status')).state
  const X = 3600, Y = 200, Z = 3600
  // The Nether bridge: along z, 3 wide, nether bricks over a 30-block drop, under the bedrock roof.
  const NX = 3600, NY = 100, NZ = 3600
  const KIT = process.env.KIT || 'iron'
  assert.ok(/^(iron|bare)$/.test(KIT), 'KIT=iron|bare')
  const PHASE_TICKS = Number(process.env.PHASE_TICKS || 1200)
  // status rounds health: a body at 0.24 hp reads 0 (s4d-ab B-iron-1: "did not respawn" while alive). Dead = 0 AND a death
  // line of the server log since the last check.
  let lifeMark = 0
  const alive = async () => {
    for (const started = Date.now(); Date.now() < started + 30000;) {
      if ((await status()).health > 0 || Date.now() - started > 2000 && !deathLines(lifeMark).length) { lifeMark = kit.serverLog.mark(); return }
      await wallSleep(200)
    }
    throw new Error('the bot did not respawn')
  }
  // The server's count: deathCount scoreboard; its feedback goes to the body's chat only (not the log), hence ask.
  const deathCount = async (): Promise<number> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await call('ask', { command: '/scoreboard players get @s nd_deaths', match: 'nd_deaths', ms: 3000 })
      const line = ((r?.detail?.lines ?? r?.lines ?? []) as string[]).find(l => /has \d+ \[nd_deaths\]/.test(l))
      if (line) return Number(/has (\d+)/.exec(line)![1])
      await wallSleep(300)
    }
    throw new Error('deathCount scoreboard not readable')
  }
  // The second witness and the cause: death lines of the server log since a mark.
  const deathLines = (from: number): string[] => kit.serverLog.linesFrom(from).lines
    .map((l: { text: string }) => /^\[\d\d:\d\d:\d\d\] \[[^\]]+\]: (.*)$/.exec(l.text)?.[1] ?? '')
    .filter((body: string) => body.startsWith(player + ' ') && DEATH.test(body.slice(player.length + 1)))
    .map((body: string) => body.slice(player.length + 1))
  // The client's inventory must show the kit before the phase: a /clear landing in the middle of eating left the body with
  // the server's 16 bread and none on its own side (s4d-ab2: no 'edible', combat.fight "нет запаса еды" in every Fight).
  const equip = async (retry = true): Promise<void> => {
    await command('/clear @s', false)
    const items = KIT === 'iron' ? ['iron_sword', 'iron_pickaxe', 'bread 16', 'cobblestone 64'] : ['stone_sword', 'stone_pickaxe', 'bread 16', 'cobblestone 16']
    for (const item of items) await command(`/give @s minecraft:${item}`)
    if (KIT === 'iron') {
      for (const [slot, piece] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]) {
        await command(`/item replace entity @s armor.${slot} with minecraft:iron_${piece}`)
      }
      await command('/item replace entity @s weapon.offhand with minecraft:shield')
    }
    await command('/effect clear @s', false)
    for (const until = Date.now() + 3000; Date.now() < until; await wallSleep(100)) {
      if (((await call('status')).state?.inventory?.bread ?? 0) > 0) return
    }
    if (retry) await equip(false)
  }
  // The bridge is rebuilt for each bridge phase; the body stands at its south end.
  const resetBridge = async () => {
    await alive()
    await call('stop')
    await command('/gamemode creative', false)
    await command(`/execute in minecraft:the_nether run tp @s ${NX + .5} ${NY + 3} ${NZ - 18.5}`, false)
    await wallSleep(1500)
    await command('/kill @e[type=!minecraft:player,distance=..80]', false)
    await kit.fillExact('the_nether', [[NX - 8, NY - 30, NZ - 26], [NX + 8, NY + 8, NZ + 26]], 'air')
    await kit.fillExact('the_nether', [[NX - 1, NY - 1, NZ - 24], [NX + 1, NY - 1, NZ + 24]], 'nether_bricks')
    await equip()
    await command(`/execute in minecraft:the_nether run tp @s ${NX + .5} ${NY} ${NZ - 18.5}`)
    await command('/effect give @s minecraft:slow_falling 1 0 true')
    await wallSleep(300)
    await command('/gamemode survival')
    await command('/effect give @s minecraft:instant_health 1 5 true')
    await command('/effect give @s minecraft:saturation 1 5 true')
  }
  const reset = async (at = { x: X + .5, z: Z + .5 }) => {
    await alive()
    await call('stop')
    await command('/gamemode creative', false)
    // After a death the body respawns at the world spawn: come back first, the arena chunks must be loaded for the fill.
    await command(`/execute in minecraft:overworld run tp @s ${X + .5} ${Y + 5} ${Z + .5}`, false)
    for (const until = Date.now() + 10000; Date.now() < until && Math.abs((await status()).pos.x - X) > 20;) await wallSleep(200)
    await wallSleep(300)
    await command('/kill @e[type=!minecraft:player,distance=..60]', false)
    await kit.fillExact('overworld', [[X - 16, Y, Z - 16], [X + 16, Y + 8, Z + 16]], 'air')
    await kit.fillExact('overworld', [[X - 16, Y - 3, Z - 16], [X + 16, Y - 1, Z + 16]], 'stone')
    await equip()
    await command(`/tp @s ${at.x} ${Y} ${at.z}`)
    await command('/effect give @s minecraft:slow_falling 1 0 true')
    await wallSleep(300)
    await command('/gamemode survival')
    await command('/effect give @s minecraft:instant_health 1 5 true')
    await command('/effect give @s minecraft:saturation 1 5 true')
  }
  // A long skill to distract: walk back and forth along the platform.
  const busy = (to = { x: X + 12, z: Z + .5 }) => { void call('goto', { x: to.x, y: Y, z: to.z, timeoutSeconds: 120 }).catch(() => {}) }
  let total = 0
  let betweenFrom = 0
  let between = 0
  const phase = async (name: string, prepare: () => Promise<void>, expect: (actions: Selected[]) => boolean,
    { start, walk, nether = false }: { start?: { x: number; z: number }; walk?: { x: number; z: number }; nether?: boolean } = {}) => {
    if (nether) await resetBridge(); else await reset(start)
    // Deaths since the last phase settled (reset, the idle body between runs) belong to no phase - reported, not hidden.
    const counted = await deathCount()
    between += counted - total
    total = counted
    const before = await status()
    const mark = connection.heard.length
    const logMark = kit.serverLog.mark()
    const wall0 = Date.now()
    if (nether) void call('goto', { x: NX + .5, y: NY, z: NZ + 20.5, timeoutSeconds: 120 }).catch(() => {}); else busy(walk)
    await wallSleep(300)
    await prepare()
    const t0 = before.clock?.ticks ?? 0
    let state = before, minHp = before.health, lowest = before.pos.y, dead = false
    for (const capped = Date.now() + Math.max(60000, PHASE_TICKS * 10); Date.now() < capped;) {
      state = await status()
      minHp = Math.min(minHp, state.health)
      // Only the first life: a respawn at the world spawn (overworld, y ~70) is no fall from the platform or the bridge.
      dead ||= state.health <= 0
      if (!dead) lowest = Math.min(lowest, state.pos.y)
      if ((state.clock?.ticks ?? 0) - t0 >= PHASE_TICKS) break
      await wallSleep(50)
    }
    try { await call('stop') } catch {}
    // Settle: a body in the air lands (or dies) before the count; then both witnesses are read.
    for (const until = Date.now() + 3000; Date.now() < until;) {
      const s = await status()
      if (s.health <= 0 || Math.abs(s.pos.y - Math.round(s.pos.y)) < .01) break
      await wallSleep(100)
    }
    await wallSleep(1500)
    await alive()
    const counted2 = await deathCount()
    const deaths = counted2 - total
    total = counted2
    const causes = deathLines(logMark)
    betweenFrom = kit.serverLog.mark()
    const heard = (connection.heard as Event[]).slice(mark)
    for (const event of heard) if (event.type === 'tactical_finished' && typeof event.hp === 'number') minHp = Math.min(minHp, event.hp)
    const actions: Selected[] = heard.filter(event => event.type === 'tactical_selected').map(event => ({ action: event.action, level: event.threatLevel, t: event.gameAt }))
    // A>B>A within 2 game seconds at one threat level (round 2: Fight<->LastStand every sample at four blazes).
    const swaps = actions.filter((a, i) => i >= 2 && a.action === actions[i - 2].action && a.action !== actions[i - 1].action &&
      a.level === actions[i - 1].level && (a.t === undefined || actions[i - 2].t === undefined || a.t - actions[i - 2].t! < 2000)).length
    const died = deaths > 0 || causes.length > 0
    const ok = !died && swaps === 0 && expect(actions)
    const ticks = (state.clock?.ticks ?? 0) - t0
    const physics = ticks > 0 ? Math.round(((state.physicsTicks ?? 0) - (before.physicsTicks ?? 0)) / ticks * 100) / 100 : null
    save({ slot, phase: name, ok, died, deaths, causes, swaps, actions, hp0: before.health, minHp, hp: state.health, pos: state.pos,
      fell: lowest < (nether ? NY : Y) - 2, kit: KIT, ticks, wallMs: Date.now() - wall0, physics, tickRate: state.clock?.tickRate })
    return ok
  }
  const results: boolean[] = []
  const wanted = (process.env.PHASES || 'zombie-melee,blaze-crowd,blaze-edge,tnt,charged-creeper,diamond-zombie,crowd,wither-skeleton').split(',').filter(Boolean)
  const want = (name: string) => wanted.includes(name)
  const noFlap = () => true
  try {
    assert.equal((await call('connect')).status, 'done')
    await call('play_mode', { mode: 'free' })
    await kit.ensureWorld('overworld', { tp: `${X + .5} ${Y + 5} ${Z + .5}` })
    await kit.randomReset()
    await kit.gamerule('spawn_mobs', false)
    await kit.gamerule('advance_time', false)
    // Night: the night mobs do not burn (S4c's day-time zombie burned in the sun); spawns stay off, time frozen.
    await command('/time set midnight')
    await command('/scoreboard objectives add nd_deaths deathCount', false)
    await command('/scoreboard players set @s nd_deaths 0', false)
    betweenFrom = kit.serverLog.mark()
    if (want('zombie-melee')) results.push(await phase('zombie-melee', () => command(`/summon minecraft:zombie ${X + 4.5} ${Y} ${Z + .5}`), noFlap))
    if (want('blaze-crowd')) results.push(await phase('blaze-crowd', async () => {
      await command('/effect give @s minecraft:fire_resistance 600 0 true')
      for (const [dx, dz] of [[3, 0], [-3, 1], [1, 3], [0, -3]]) await command(`/summon minecraft:blaze ${X + .5 + dx} ${Y + 1} ${Z + .5 + dz}`)
    }, noFlap))
    // (S4c, review g) blazes hovering past the platform edge, the body working at the edge without fire resistance: the
    // answer must not walk or run off it (S1c: falls from fortress bridges under Fight/Flee at blazes).
    if (want('blaze-edge')) results.push(await phase('blaze-edge', async () => {
      for (const dz of [-2, 1, 4]) await command(`/summon minecraft:blaze ${X + 20.5} ${Y + 2} ${Z + .5 + dz}`)
    }, noFlap, { start: { x: X + 14.5, z: Z + .5 }, walk: { x: X + 15.5, z: Z + 12.5 } }))
    if (want('tnt')) results.push(await phase('tnt', () => command(`/summon minecraft:tnt ${X + 2.5} ${Y} ${Z + .5} {fuse:60}`),
      actions => actions.some(a => a.action === 'Dodge' && a.level === 4)))
    if (want('anvil')) results.push(await phase('anvil', async () => { const at = (await status()).pos; await command(`/setblock ${Math.floor(at.x)} ${Y + 8} ${Math.floor(at.z)} minecraft:anvil`) },
      actions => actions.some(a => a.action === 'Dodge')))
    if (want('charged-creeper')) results.push(await phase('charged-creeper', () => command(`/summon minecraft:creeper ${X + 5.5} ${Y} ${Z + .5} {powered:1b}`),
      actions => actions.length > 0))
    // 1.21.11 mob equipment by /item (a summon with the equipment component is longer than the 250-char chat limit).
    if (want('diamond-zombie')) results.push(await phase('diamond-zombie', async () => {
      await command(`/summon minecraft:zombie ${X + 6.5} ${Y} ${Z + .5} {Tags:["nd_s4"],PersistenceRequired:1b}`)
      for (const [slot, item] of [['weapon.mainhand', 'diamond_sword'], ['armor.head', 'diamond_helmet'], ['armor.chest', 'diamond_chestplate'],
        ['armor.legs', 'diamond_leggings'], ['armor.feet', 'diamond_boots']]) await command(`/item replace entity @e[tag=nd_s4,limit=1] ${slot} with minecraft:${item}`)
    }, actions => actions.length > 0))
    // The mix of the slot-18 night deaths (06.10 22:57): zombies, a spider and a creeper at once.
    if (want('crowd')) results.push(await phase('crowd', async () => {
      for (const [kind, dx, dz] of [['zombie', 5, 0], ['zombie', -4, 3], ['zombie', 1, -6], ['spider', -6, -2], ['creeper', 7, 5]] as const) {
        await command(`/summon minecraft:${kind} ${X + .5 + dx} ${Y} ${Z + .5 + dz}`)
      }
    }, actions => actions.length > 0))
    // S4d: the night mobs of the S5c/S8 deaths, one by one, and a crowd of four (COORD 03:25: an iron, shielded body with a
    // sword ran from a lone zombie and died). The answer to a lone one is a fight; actions are kept for the report.
    if (want('skeleton')) results.push(await phase('skeleton', () => command(`/summon minecraft:skeleton ${X + 10.5} ${Y} ${Z + .5}`), noFlap))
    if (want('spider')) results.push(await phase('spider', () => command(`/summon minecraft:spider ${X + 6.5} ${Y} ${Z + .5}`), noFlap))
    if (want('creeper')) results.push(await phase('creeper', () => command(`/summon minecraft:creeper ${X + 6.5} ${Y} ${Z + .5}`), noFlap))
    if (want('husk-spear')) results.push(await phase('husk-spear', async () => {
      await command(`/summon minecraft:husk ${X + 6.5} ${Y} ${Z + .5} {Tags:["nd_s4d"],PersistenceRequired:1b}`)
      await command('/item replace entity @e[tag=nd_s4d,limit=1] weapon.mainhand with minecraft:iron_spear')
    }, noFlap))
    // The live conditions of the S5c/S8 deaths with a lone zombie at the body: a creeper in sight far behind it (its 19.4 set
    // the fight threshold to 20+), and hunger with a second zombie far off (food 12: "recover", a box at 3 blocks).
    if (want('zombie-creeper')) results.push(await phase('zombie-creeper', async () => {
      await command(`/summon minecraft:zombie ${X + 5.5} ${Y} ${Z + .5}`)
      await command(`/summon minecraft:creeper ${X - 12.5} ${Y} ${Z + .5}`)
    }, noFlap))
    if (want('hungry-zombies')) results.push(await phase('hungry-zombies', async () => {
      await command('/effect give @s minecraft:hunger 30 60 true')
      for (const until = Date.now() + 15000; Date.now() < until && (await status()).food > 12;) await wallSleep(100)
      await command('/effect clear @s minecraft:hunger', false)
      await command(`/summon minecraft:zombie ${X + 4.5} ${Y} ${Z + .5}`)
      await command(`/summon minecraft:zombie ${X - 14.5} ${Y} ${Z + 4.5}`)
    }, noFlap))
    if (want('crowd4')) results.push(await phase('crowd4', async () => {
      for (const [kind, dx, dz] of [['zombie', 5, 0], ['zombie', -4, 3], ['zombie', 1, -6], ['skeleton', -9, -2]] as const) {
        await command(`/summon minecraft:${kind} ${X + .5 + dx} ${Y} ${Z + .5 + dz}`)
      }
    }, noFlap))
    // S1c's second killer (07.10: 7 of 25 deaths), here on the overworld platform: a wither skeleton with its stone sword.
    if (want('wither-skeleton')) results.push(await phase('wither-skeleton', () => command(`/summon minecraft:wither_skeleton ${X + 5.5} ${Y} ${Z + .5}`),
      actions => actions.length > 0))
    // S1c in the fortress: a wither skeleton walking up a 3-wide bridge, two blazes hovering beside it, a 30-block drop.
    if (want('bridge')) results.push(await phase('bridge', async () => {
      await command(`/execute in minecraft:the_nether run summon minecraft:wither_skeleton ${NX + .5} ${NY} ${NZ - 8.5}`)
      for (const dx of [-5, 5]) await command(`/execute in minecraft:the_nether run summon minecraft:blaze ${NX + .5 + dx} ${NY + 2} ${NZ - 4.5}`)
    }, noFlap, { nether: true }))
  } finally {
    try { await call('stop') } catch {}
    try { await command('/kill @e[type=!minecraft:player,distance=..60]', false) } catch {}
  }
  // Deaths after the last phase settled (none expected: no spawns, day) - still counted.
  await wallSleep(1500)
  let after = 0
  try { after = await deathCount() - total } catch {}
  const tail = deathLines(betweenFrom)
  connection.close()
  save({ slot, summary: true, ok: results.every(Boolean) && between === 0 && after === 0, phases: results.length, between, after, tail })
  assert.ok(results.every(Boolean), 'a stress phase failed (see rows)')
}
if (require.main === module) main().catch(error => { console.error(error); process.exit(1) })
