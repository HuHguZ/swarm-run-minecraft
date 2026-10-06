// Stage D of the tactical stress stand (research/claude-1006/tactics.md): the distractions of the abstract stand,
// honestly in Minecraft on a farm slot - primed TNT, a falling anvil, a charged creeper, a zombie in diamond gear with a
// diamond sword - while the bot works a long skill. Commands only prepare the scene; the body acts on its own.
//   node farm/farm.js run try-stress-tactics.js --slots N --tag s4-stress-<n>
// Rows (LAB_OUT): one per phase {phase, ok, actions[{action,level}], hp0, hp, died, detail}. Fails on death.
import assert from 'node:assert/strict'
import fs from 'node:fs'

interface Event { type: string; action?: string; threatLevel?: number; hp?: number; hpBefore?: number }
interface Selected { action?: string; level?: number }
interface State { health: number; food: number; pos: { x: number; y: number; z: number }; busy: string | null; tactics?: { threatLevel: number; state?: any }
  physicsTicks?: number; clock?: { ticks?: number; tickRate?: number } }
const { connect, createKit } = require('./scene-kit')
const wallSleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

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
  const alive = async () => {
    for (const until = Date.now() + 20000; Date.now() < until;) { if ((await status()).health > 0) return; await wallSleep(200) }
    throw new Error('the bot did not respawn')
  }
  const reset = async () => {
    await alive()
    await call('stop')
    await command('/gamemode creative', false)
    // After a death the body respawns at the world spawn: come back first, the arena chunks must be loaded for the fill.
    await command(`/tp @s ${X + .5} ${Y + 5} ${Z + .5}`, false)
    for (const until = Date.now() + 10000; Date.now() < until && Math.abs((await status()).pos.x - X) > 20;) await wallSleep(200)
    await wallSleep(300)
    await command('/kill @e[type=!minecraft:player,distance=..40]', false)
    await kit.fillExact('overworld', [[X - 16, Y, Z - 16], [X + 16, Y + 8, Z + 16]], 'air')
    await kit.fillExact('overworld', [[X - 16, Y - 1, Z - 16], [X + 16, Y - 1, Z + 16]], 'stone')
    await command('/clear @s', false)
    for (const item of ['iron_sword', 'iron_pickaxe', 'bread 16', 'cobblestone 64']) await command(`/give @s minecraft:${item}`)
    for (const [slot, piece] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]) {
      await command(`/item replace entity @s armor.${slot} with minecraft:iron_${piece}`)
    }
    await command(`/tp @s ${X + .5} ${Y} ${Z + .5}`)
    await command('/gamemode survival')
    await command('/effect give @s minecraft:instant_health 1 5 true')
    await command('/effect give @s minecraft:saturation 1 5 true')
  }
  // A long skill to distract: dig down beside the platform is too destructive here, so walk back and forth.
  const busy = () => { void call('goto', { x: X + 12, y: Y, z: Z + .5, timeoutSeconds: 120 }).catch(() => {}) }
  const phase = async (name: string, prepare: () => Promise<void>, seconds: number, expect: (actions: Selected[]) => boolean) => {
    await reset()
    const before = await status()
    const mark = connection.heard.length
    busy()
    await wallSleep(300)
    await prepare()
    const until = Date.now() + seconds * 1000
    let state = before, minHp = before.health
    while (Date.now() < until) {
      state = await status()
      minHp = Math.min(minHp, state.health)
      if (state.health <= 0) break
      await wallSleep(50)
    }
    // At 750 TPS one 50 ms wall poll is ~37 game seconds: deaths and low health come from the daemon's own events.
    const heard = (connection.heard as Event[]).slice(mark)
    const died = state.health <= 0 || heard.some(event => event.type === 'death')
    for (const event of heard) if (event.type === 'tactical_finished' && typeof event.hp === 'number') minHp = Math.min(minHp, event.hp)
    const actions: Selected[] = heard.filter(event => event.type === 'tactical_selected').map(event => ({ action: event.action, level: event.threatLevel }))
    // Round 2: A>B>A swaps of the selected actions (farm 06.10, slot 30: Fight<->LastStand every sample at four blazes).
    const swaps = actions.filter((a, i) => i >= 2 && a.action === actions[i - 2].action && a.action !== actions[i - 1].action).length
    const ok = !died && expect(actions)
    // Share of server ticks the body's physics saw (S7: status.physicsTicks / clock.ticks); at 750 TPS a creeper fuse of
    // 30 ticks can fall between two of them.
    const ticks = (state.clock?.ticks ?? 0) - (before.clock?.ticks ?? 0)
    const physics = ticks > 0 ? Math.round(((state.physicsTicks ?? 0) - (before.physicsTicks ?? 0)) / ticks * 100) / 100 : null
    save({ slot, phase: name, ok, hp0: before.health, minHp, hp: state.health, died, swaps, actions, pos: state.pos, ticks, physics, tickRate: state.clock?.tickRate })
    return ok
  }
  const results: boolean[] = []
  // PHASES=zombie-melee,blaze-crowd runs only those (round 2 flap check); default - all.
  const wanted = (process.env.PHASES || '').split(',').filter(Boolean)
  const want = (name: string) => !wanted.length || wanted.includes(name)
  try {
    assert.equal((await call('connect')).status, 'done')
    await call('play_mode', { mode: 'free' })
    await kit.ensureWorld('overworld', { tp: `${X + .5} ${Y + 5} ${Z + .5}` })
    await kit.randomReset()
    // Wall seconds at 750 TPS are ~37 game seconds each; the fuse is 80 ticks.
    // Round 2: a plain melee fight with crit jumps (the stand's regress-crit-jump-zombie) and a crowd of four blazes at
    // full health (s1 slot 30, 20:36 MSK): no Fight>LastStand>Fight swaps expected.
    if (want('zombie-melee')) results.push(await phase('zombie-melee', () => command(`/summon minecraft:zombie ${X + 4.5} ${Y} ${Z + .5}`), 3,
      actions => !actions.some((a, i) => i >= 2 && a.action === actions[i - 2].action && a.action !== actions[i - 1].action)))
    if (want('blaze-crowd')) results.push(await phase('blaze-crowd', async () => {
      await command('/effect give @s minecraft:fire_resistance 600 0 true')
      for (const [dx, dz] of [[3, 0], [-3, 1], [1, 3], [0, -3]]) await command(`/summon minecraft:blaze ${X + .5 + dx} ${Y + 1} ${Z + .5 + dz}`)
    }, 3, actions => !actions.some((a, i) => i >= 2 && a.action === actions[i - 2].action && a.action !== actions[i - 1].action && a.level === actions[i - 1].level)))
    if (want('tnt')) results.push(await phase('tnt', () => command(`/summon minecraft:tnt ${X + 2.5} ${Y} ${Z + .5} {fuse:60}`), 2,
      actions => actions.some(a => a.action === 'Dodge' && a.level === 4)))
    if (want('anvil')) results.push(await phase('anvil', async () => { const at = (await status()).pos; await command(`/setblock ${Math.floor(at.x)} ${Y + 8} ${Math.floor(at.z)} minecraft:anvil`) }, 2,
      actions => actions.some(a => a.action === 'Dodge')))
    if (want('charged-creeper')) results.push(await phase('charged-creeper', () => command(`/summon minecraft:creeper ${X + 5.5} ${Y} ${Z + .5} {powered:1b}`), 3,
      actions => actions.length > 0))
    // 1.21.5+ mob equipment component (check the bot's sighting: hit >= 6 means the sword was seen).
    // 1.21.11 mob equipment by /item (a summon with the equipment component is longer than the 250-char chat limit).
    if (want('diamond-zombie')) results.push(await phase('diamond-zombie', async () => {
      await command(`/summon minecraft:zombie ${X + 6.5} ${Y} ${Z + .5} {Tags:["nd_s4"],PersistenceRequired:1b}`)
      for (const [slot, item] of [['weapon.mainhand', 'diamond_sword'], ['armor.head', 'diamond_helmet'], ['armor.chest', 'diamond_chestplate'],
        ['armor.legs', 'diamond_leggings'], ['armor.feet', 'diamond_boots']]) await command(`/item replace entity @e[tag=nd_s4,limit=1] ${slot} with minecraft:${item}`)
    }, 4, actions => actions.length > 0))
  } finally {
    try { await call('stop') } catch {}
    try { await command('/kill @e[type=!minecraft:player,distance=..40]', false) } catch {}
    connection.close()
  }
  save({ slot, summary: true, ok: results.every(Boolean), phases: results.length })
  assert.ok(results.every(Boolean), 'a stress phase failed (see rows)')
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
