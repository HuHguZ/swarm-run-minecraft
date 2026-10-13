'use strict'
// Native counterfactual for an XZ route entering a deep cave (room-e, 11.10).
// Setup commands are confined to an explicitly verified farm slot; terrain stays native.
const fs = require('node:fs')
const { connect, createKit } = require('./scene-kit')
const gameClock = require('./src/game-clock')

async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 32) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('only an explicit farm slot')
  const conn = connect(process.env.ND_WS)
  await conn.ready
  try {
    await conn.call('connect')
    const st = await conn.call('status')
    if (st.detail?.server !== `127.0.0.1:${25600 + slot}`) throw new Error('wrong server')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await conn.call('stop')
    await kit.gamerule('send_command_feedback', 'true')
    await kit.gamerule('keep_inventory', 'false')
    await kit.gamerule('spawn_mobs', process.env.MOBS === '1' ? 'true' : 'false')
    await kit.gamerule('advance_time', 'false')
    await kit.randomReset()
    await kit.setDifficulty('normal')
    await kit.cmd('/time set 1000')
    await kit.cmd('/gamemode creative')
    await kit.cmd('/clear @s')
    const kitItems = ['iron_pickaxe', 'water_bucket', 'iron_sword', 'cobblestone 64', 'cooked_beef 16']
    for (let k = 0; k < kitItems.length; k++) await kit.cmd(`/item replace entity @s hotbar.${k} with minecraft:${kitItems[k]}`)
    for (const [slotName, item] of [['head', 'iron_helmet'], ['chest', 'iron_chestplate'], ['legs', 'iron_leggings'], ['feet', 'golden_boots']]) await kit.cmd(`/item replace entity @s armor.${slotName} with minecraft:${item}`)
    await kit.cmd('/item replace entity @s weapon.offhand with minecraft:shield')
    const start = String(process.env.START || '524.5,54,434.5').split(',').map(Number)
    const goal = String(process.env.GOAL || '576,473').split(',').map(Number)
    if (start.length !== 3 || goal.length !== 2 || ![...start, ...goal].every(Number.isFinite)) throw new Error('START=x,y,z GOAL=x,z')
    await kit.ensureWorld('overworld', { tp: start.join(' ') })
    await kit.cmd('/effect give @s minecraft:instant_health 1 10 true')
    await kit.cmd('/effect give @s minecraft:saturation 1 10 true')
    await kit.cmd('/effect clear @s')
    await kit.cmd('/gamemode survival')
    const readyUntil = gameClock.wall.now() + 15000
    for (;;) {
      const r = await conn.call('status', { physics: true })
      if (r.state?.biome != null && r.detail?.physics?.onGround) break
      if (gameClock.wall.now() >= readyUntil) throw new Error('native chunks/standing position not ready')
      await gameClock.wall.sleep(100)
    }
    const before = (await conn.call('status')).state
    const samples = [before]
    let going = true
    const poll = (async () => {
      while (going) {
        const s = (await conn.call('status')).state
        samples.push(s)
        await gameClock.sleep(200)
      }
    })()
    const t0 = gameClock.now()
    let recovered = null; let result
    try {
      if (process.env.RECOVER === '1') recovered = await conn.call('surface', { timeoutSeconds: Number(process.env.RECOVERY_SECONDS || 120), preferPillar: true })
      result = await conn.call('goto', { x: goal[0], z: goal[1], range: 8, timeoutSeconds: Number(process.env.SECONDS || 120), surface: process.env.SURFACE !== 'false' })
    } finally { going = false; await poll }
    const after = (await conn.call('status')).state
    const record = { scene: 'goto-surface-native', before, after, recovered, result, seconds: (gameClock.now() - t0) / 1000,
      minY: Math.min(...samples.map(s => s.pos.y)), minHp: Math.min(...samples.map(s => s.health)), samples: samples.map(s => ({ pos: s.pos, hp: s.health })) }
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(record) + '\n')
    console.log(JSON.stringify(record))
  } finally {
    await conn.call('disconnect').catch(() => null)
    conn.close()
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error.stack); process.exit(1) })
