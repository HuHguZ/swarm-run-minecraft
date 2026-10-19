// Farm-only causal scene for sr-m-3: BlockOff at a distant blaze must execute a real refuge.
// Run the SAME script against the baseline daemon (EXPECT=old) and the changed daemon (EXPECT=new).
// NETHER_SCENE=shield checks the same daemon executor facing a distant active ghast.
// FARM_SLOT, matching ND_WS and ND_SERVER_LOG are required; LAB_OUT appends the measured row.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { connect, createKit } from '../lib/scene-kit'
const wallSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const DEATH = /^(was |fell |died|drowned|burned|went up|went off|blew up|hit the ground|tried to swim|walked into|suffocated|starved|froze|experienced|withered|discovered|didn't want|left the confines|squashed|is |got finished)/

export async function runNetherRefugeScene(): Promise<void> {
  const slot = Number(process.env.FARM_SLOT), player = `NeuroFarm${slot}`
  const expected = process.env.EXPECT || 'new'
  const shelterScene = process.env.NETHER_SCENE !== 'shield'
  const mob = shelterScene ? 'blaze' : 'ghast', distance = shelterScene ? 12 : 24, action = shelterScene ? 'BlockOff' : 'Shield'
  const startHp = shelterScene ? 10 : 20, startYaw = shelterScene ? -90 : 90
  const shieldSeconds = Number(process.env.SHIELD_GAME_SECONDS || 20)
  assert.ok(Number.isFinite(shieldSeconds) && shieldSeconds >= 6 && shieldSeconds <= 60, 'explicit bounded shield measurement window')
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 32 && process.env.ND_WS === `ws://127.0.0.1:${8800 + slot}`, 'explicit matching farm slot/WS required')
  assert.ok(process.env.ND_SERVER_LOG, 'explicit farm server log required')
  assert.ok(expected === 'old' || expected === 'new', 'EXPECT=old|new')
  const connection = connect(process.env.ND_WS)
  await connection.ready
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    let timer: NodeJS.Timeout
    try { return await Promise.race([connection.call(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 15000) })]) }
    finally { clearTimeout(timer) }
  }
  const kit = createKit({ call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player, replyMs: 3000 })
  const command = async (text: string, required = true) => {
    const result = await kit.cmd(text)
    if (required) assert.ok(result.ok, `fixture command not confirmed: ${text}: ${result.why}`)
  }
  const ask = async (command: string, match: string): Promise<string[]> => {
    const result = await call('ask', { command, match, ms: 3000 })
    return result.detail?.lines || []
  }
  const nativeHealth = async (): Promise<number> => {
    const lines = await ask('/data get entity @s Health', 'entity data')
    const hp = lines.map(line => /entity data: (\d+(?:\.\d+)?)f/.exec(line)).find(Boolean)
    assert.ok(hp, `native Health unavailable: ${JSON.stringify(lines)}`)
    return Number(hp[1])
  }
  const nativeDeaths = async (): Promise<number> => {
    const lines = await ask('/scoreboard players get @s nd_deaths', 'nd_deaths')
    const score = lines.map(line => /has (\d+) \[nd_deaths\]/.exec(line)).find(Boolean)
    assert.ok(score, `native deathCount unavailable: ${JSON.stringify(lines)}`)
    return Number(score[1])
  }
  const nativeBlock = async (x: number, y: number, z: number): Promise<boolean> => {
    const lines = await ask(`/execute if block ${x} ${y} ${z} minecraft:netherrack`, 'Test ')
    assert.ok(lines.some(line => /Test (passed|failed)/.test(line)), `native block probe unavailable: ${JSON.stringify(lines)}`)
    return lines.some(line => /Test passed/.test(line))
  }
  const nativeVector = async (selector: string, field: string): Promise<number[]> => {
    const lines = await ask(`/data get entity ${selector} ${field}`, 'entity data')
    const value = lines.find(line => line.includes('entity data: ['))?.split('entity data: ')[1]
    assert.ok(value, `native ${field} unavailable: ${JSON.stringify(lines)}`)
    return (value.match(/-?\d+(?:\.\d+)?/g) || []).map(Number)
  }
  const status = async () => (await call('status')).state
  const X = 4200, Y = 100, Z = 4200, radius = 28
  // A ghast is four blocks wide. Keep its whole starting body inside cleared air; 57*57*10 stays below /fill's limit.
  const box = [[X - radius, Y - 4, Z - radius], [X + radius, Y + 5, Z + radius]]
  const foe = `@e[type=minecraft:${mob},tag=nd_refuge_probe,limit=1]`
  try {
    await call('connect')
    assert.equal((await call('status')).detail?.server, `127.0.0.1:${25600 + slot}`, 'daemon must connect to its farm server')
    await call('stop')
    await call('play_mode', { mode: 'free' })
    await command('/gamemode creative')
    await kit.setDifficulty('normal')
    await kit.gamerule('spawn_mobs', false)
    await kit.gamerule('keep_inventory', false)
    await kit.forceload('the_nether', box)
    await kit.fillExact('the_nether', box, 'air')
    await kit.fillExact('the_nether', [[X - radius, Y - 4, Z - radius], [X + radius, Y - 1, Z + radius]], 'netherrack')
    await kit.ensureWorld('the_nether', { tp: `${X + .5} ${Y} ${Z + .5} ${startYaw} 0`, floor: 'netherrack' })
    // Fire ticks survive Creative and /effect clear; extinguish a previous arm before enabling Survival.
    await command(`/setblock ${X} ${Y} ${Z} minecraft:water`)
    await wallSleep(250)
    await command(`/setblock ${X} ${Y} ${Z} minecraft:air`)
    await command('/kill @e[type=!minecraft:player,distance=..40]', false)
    await command('/effect clear @s', false)
    await command('/clear @s', false)
    await command('/attribute @s minecraft:max_health base set 20')
    await command('/effect give @s minecraft:instant_health 1 5 true')
    await command('/effect give @s minecraft:saturation 1 5 true')
    await command('/effect clear @s', false)
    await command(`/attribute @s minecraft:max_health base set ${startHp}`)
    await command('/effect give @s minecraft:instant_health 1 5 true')
    await wallSleep(150)
    await command('/effect clear @s', false)
    for (const item of ['iron_sword', 'iron_pickaxe', 'netherrack 64', 'bread 16']) await command(`/give @s minecraft:${item}`)
    for (const [slot, piece] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]) {
      await command(`/item replace entity @s armor.${slot} with minecraft:iron_${piece}`)
    }
    await command('/item replace entity @s weapon.offhand with minecraft:shield')
    await command('/scoreboard objectives add nd_deaths deathCount', false)
    await command('/scoreboard players set @s nd_deaths 0')
    const salt = await kit.randomReset(process.env.RNG_SEED || 1011)
    await command(`/tp @s ${X + .5} ${Y} ${Z + .5} ${startYaw} 0`)
    await command(`/summon minecraft:${mob} ${X + distance + .5} ${Y} ${Z + .5} {Tags:["nd_refuge_probe"],PersistenceRequired:1b,NoAI:1b}`)
    let prepared = await status()
    for (const until = Date.now() + 5000; Date.now() < until && ((prepared.inventory?.bread || 0) < 16 || prepared.offHand?.item !== 'shield');) {
      await wallSleep(25); prepared = await status()
    }
    console.log(JSON.stringify({ preflight: prepared }))
    assert.equal(prepared.inventory?.bread, 16, 'client must confirm all healing food before survival')
    assert.equal(prepared.inventory?.netherrack, 64, 'client must confirm survival blocks')
    assert.equal(prepared.offHand?.item, 'shield', 'client must confirm the shield')
    let seen = (await call('observe', { radius: distance + 4 })).detail
    for (const until = Date.now() + 5000; Date.now() < until && !seen?.entities?.some(entity => entity.name.toLowerCase() === mob);) {
      await wallSleep(25); seen = (await call('observe', { radius: distance + 4 })).detail
    }
    console.log(JSON.stringify({ sight: seen?.entities }))
    assert.ok(seen?.entities?.some(entity => entity.name.toLowerCase() === mob && Math.abs(entity.dist - distance) < 1), 'client eyes must see the distant shooter')
    const hpBefore = await nativeHealth(), deathsBefore = await nativeDeaths(), before = await status()
    const rotationBefore = shelterScene ? null : await nativeVector('@s', 'Rotation')
    assert.equal(hpBefore, startHp, 'server must confirm matched HP before survival')
    assert.equal(before.health, startHp, 'client must receive matched HP before survival')
    assert.equal(before.food, 20, 'matched full hunger must permit ordinary recovery inside refuge')
    assert.equal(before.clock?.frozen, false, 'root must provide a running farm server')
    const aiOff = await ask(`/data get entity ${foe} NoAI`, 'entity data|Found no elements')
    assert.ok(aiOff.some(line => /entity data: (1b|true)/.test(line)), `native preparation control must confirm NoAI: ${JSON.stringify(aiOff)}`)
    const mark = connection.heard.length, logMark = kit.serverLog.mark(), started = Date.now()
    // Queue the three transition commands without an echo barrier between them: at 750 TPS the activated mob would
    // otherwise wander out of the matched 12/24-block starting geometry before Survival even begins.
    await call('say', { text: `/data merge entity ${foe} {NoAI:0b}` })
    await call('say', { text: '/gamemode survival' })
    await call('say', { text: '/attribute @s minecraft:max_health base set 20' })
    const ai = await ask(`/data get entity ${foe} NoAI`, 'entity data|Found no elements')
    assert.ok(ai.some(line => /entity data: (0b|false)|Found no elements matching NoAI/.test(line)), `native server must confirm active shooter AI: ${JSON.stringify(ai)}`)
    let finished: any, state = await status(), minHp = state.health
    for (;;) {
      const events = connection.heard.slice(mark)
      finished = events.find(event => event.type === 'tactical_finished' && event.action === action && event.result !== 'preempted'
        && (shelterScene || expected === 'old' || (event.detail?.shielded === true && event.detail?.shield?.blocked > 0)))
      const measured = !shelterScene && expected === 'new'
        ? (state.clock?.ticks ?? 0) - (before.clock?.ticks ?? 0) >= shieldSeconds * 20 : !!finished
      if (measured || events.some(event => event.type === 'death') || Date.now() - started >= 60000) break
      await wallSleep(25)
      state = await status(); minHp = Math.min(minHp, state.health)
    }
    // Read-only native witnesses after execution; do not heal, kill or switch modes until these are recorded.
    const hpAfter = await nativeHealth(), deaths = await nativeDeaths() - deathsBefore
    const deathLines = kit.serverLog.linesFrom(logMark).lines.map(line => line.text.split(`]: ${player} `)[1])
      .filter(line => line && DEATH.test(line))
    const events = connection.heard.slice(mark), detail = finished?.detail
    const shieldEpisodes = events.filter(event => event.type === 'tactical_finished' && event.action === 'Shield')
    const blocked = shieldEpisodes.reduce((sum, event) => sum + (event.detail?.shield?.blocked || 0), 0)
    let direction = null
    if (!shelterScene) {
      const rotation = await nativeVector('@s', 'Rotation'), position = await nativeVector('@s', 'Pos'), enemyPosition = await nativeVector(foe, 'Pos')
      const yaw = rotation[0] * Math.PI / 180, dx = enemyPosition[0] - position[0], dz = enemyPosition[2] - position[2]
      direction = { rotationBefore, rotation, position, enemyPosition, distance: Math.hypot(dx, dz), facingDot: (-Math.sin(yaw) * dx + Math.cos(yaw) * dz) / Math.hypot(dx, dz) }
    }
    let blocks: { roof: boolean; upperWalls: boolean[] } | null = null
    if (detail?.cell) {
      const { x, y, z } = detail.cell
      blocks = { roof: await nativeBlock(x, y + 2, z), upperWalls: [] }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) blocks.upperWalls.push(await nativeBlock(x + dx, y + 1, z + dz))
    }
    const row = { slot, expected, salt, scene: shelterScene ? 'nether-distant-blaze-refuge' : 'nether-distant-ghast-shield', ai, before, sight: seen?.entities, hpBefore, foodBefore: before.food, hpAfter, minHp, deaths, deathLines, finished, blocks, direction, shieldEpisodes, blocked,
      ticks: (state.clock?.ticks ?? 0) - (before.clock?.ticks ?? 0), wallMs: Date.now() - started, events }
    console.log(JSON.stringify(row))
    if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
    assert.ok(events.some(event => event.type === 'tactical_selected' && event.action === action), 'same actual tactical action must be selected in both arms')
    assert.ok(finished, 'tactical action must settle before the wall deadline')
    assert.equal(deaths, 0, 'native deathCount must stay zero')
    assert.equal(deathLines.length, 0, 'server must have no death line')
    if (!shelterScene) {
      assert.ok(blocked > 0 || events.some(event => event.type === 'damage' && event.cause === 'fireball' && event.source === 'ghast'), 'active native ghast must produce a real blocked or damaging fireball')
      assert.ok(direction.distance > 16, 'native shooter witness must remain beyond the old aim range')
      assert.ok(expected === 'old' ? direction.facingDot < 0 : direction.facingDot > 0, 'native yaw must distinguish facing away from facing the observed shooter')
      if (expected === 'new') {
        assert.equal(detail?.shielded, true, 'actual native shield confirmation must succeed')
        assert.ok(blocked >= 2, 'server sounds must confirm repeated actual shield blocks across the fixed game window')
      }
    } else if (expected === 'old') {
      assert.equal(detail?.how, 'бой', 'baseline must reproduce the incorrect executor')
      assert.equal(detail?.duel?.swings, 0)
      assert.match(detail?.duel?.stopped || '', /блейз вне ближнего боя/)
      assert.equal(detail?.healed, undefined, 'zero-swings result must not be credited as a refuge')
    } else {
      assert.equal(detail?.why, 'tactical BlockOff')
      assert.equal(detail?.how, 'box', 'new executor must actually build a refuge')
      assert.ok(detail?.placed > 0, 'survival block placements must be confirmed')
      assert.equal(detail?.healed, true, 'RPC completion alone is insufficient')
      assert.ok(hpAfter >= 16, 'native health must confirm recovery')
      assert.equal(blocks?.roof, true, 'native server must confirm the built roof')
      assert.ok(blocks.upperWalls.filter(Boolean).length >= 3, 'native server must confirm walls after the refuge opens its exit')
    }
  } finally {
    try { await call('stop') } catch {}
    try { await command('/gamemode creative') } catch {}
    try { await command('/attribute @s minecraft:max_health base set 20') } catch {}
    try { await command(`/kill ${foe}`, false) } catch {}
    try { await kit.unforceload('the_nether', box) } catch {}
    connection.close()
  }
}
if (require.main === module) runNetherRefugeScene().catch(error => { console.error(error); process.exitCode = 1 })
