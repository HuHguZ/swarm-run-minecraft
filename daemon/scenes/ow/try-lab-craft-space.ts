'use strict'
// Одна короткая сцена; операторская подготовка разрешена только в ферме.
import * as fs from 'fs'
import { connect, createKit, sleep } from '../lib/scene-kit'
async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 10) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  const result: Record<string, any> = { labFixture: true, ok: false }
  try {
    await conn.ready
    await conn.call('connect')
    const status = await conn.call('status')
    if (status.detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('сервер не фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await kit.cmd('/gamemode creative')
    await kit.ensureWorld('overworld', { tp: '2400 100 2400' })
    await kit.fillExact('overworld', [[2393, 99, 2393], [2407, 99, 2407]], 'stone')
    await kit.fillExact('overworld', [[2397, 100, 2397], [2403, 103, 2403]], 'air')
    await kit.cmd('/tp @s 2400.5 100 2400.5')
    await sleep(1500)
    await kit.cmd('/gamemode survival')
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/clear @s')
    await kit.cmd('/setblock 2401 100 2400 minecraft:crafting_table')
    for (const item of ['cobblestone 64', 'stick 64', 'crafting_table 1', 'netherrack 2112']) await kit.cmd(`/give @s minecraft:${item}`)
    await sleep(300)
    result.before = (await conn.call('situation')).detail
    result.full = await conn.call('craft', { item: 'stone_pickaxe', count: 1 })
    await kit.cmd('/clear @s minecraft:netherrack 128')
    await sleep(1200)
    result.afterSpace = (await conn.call('status')).state.inventory
    result.duplicated = result.before.free === 0 && result.full.state.inventory.cobblestone === 58 && result.afterSpace.stone_pickaxe === 2
    await kit.cmd('/clear @s')
    await kit.cmd('/kill @e[type=minecraft:item,distance=..16]')
    for (const item of ['cobblestone 64', 'stick 64', 'crafting_table 1', 'netherrack 2112']) await kit.cmd(`/give @s minecraft:${item}`)
    result.tidy = await conn.call('pack', { mode: 'tidy', also: 'netherrack:128' })
    result.fixed = await conn.call('craft', { item: 'stone_pickaxe', count: 1 })
    result.ok = result.duplicated && result.fixed.state.inventory.stone_pickaxe === 1 && result.fixed.state.inventory.cobblestone === 61
  } catch (e) { result.error = e.message } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify(result))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
