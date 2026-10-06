'use strict'
const fs = require('fs')
const { connect, createKit, sleep } = require('./scene-kit')
async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 10) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  const result: Record<string, any> = { labFixture: true, ok: false }
  try {
    await conn.ready
    await conn.call('connect')
    if ((await conn.call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('сервер не фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await kit.cmd('/gamemode creative')
    await kit.ensureWorld('the_nether', { tp: '2400.5 80 2400.5' })
    await kit.fillExact('the_nether', [[2390, 79, 2390], [2410, 79, 2410]], 'nether_bricks')
    await kit.fillExact('the_nether', [[2390, 80, 2390], [2410, 85, 2410]], 'air')
    await kit.cmd('/kill @e[type=!minecraft:player,distance=..24]')
    await kit.cmd('/setblock 2402 80 2400 minecraft:nether_bricks')
    await kit.cmd('/setblock 2402 81 2400 minecraft:nether_bricks')
    await kit.cmd('/setblock 2400 80 2404 minecraft:spawner{SpawnData:{entity:{id:"minecraft:blaze"}},Delay:3000}')
    await kit.cmd('/tp @s 2400.5 80 2400.5')
    await kit.cmd('/clear @s')
    for (const item of ['stone_pickaxe', 'stone_sword', 'shield', 'iron_chestplate', 'cooked_beef 12', 'netherrack 64']) await kit.cmd(`/give @s minecraft:${item}`)
    await kit.cmd('/gamemode survival')
    await conn.call('armor')
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/effect give @s minecraft:saturation 1 20 true')
    await kit.cmd('/effect give @s minecraft:instant_damage 1 1 true')
    await sleep(150)
    result.start = (await conn.call('status')).state
    result.fight = await conn.call('blaze', { rods: 1, box: false, timeoutSeconds: 45 })
    result.rests = result.fight.detail?.rests || []
    result.ok = result.start.health < 14 && result.rests.some(r => r.exited === true)
  } catch (e) { result.error = e.message } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify({ ok: result.ok, error: result.error, startHp: result.start?.health, rests: result.rests }))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
