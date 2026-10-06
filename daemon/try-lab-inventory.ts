'use strict'
const fs = require('fs')
const { connect, createKit, sleep } = require('./scene-kit')
async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 10) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  const result: Record<string, any> = { labFixture: true, slot, ok: false }
  try {
    await conn.ready
    await conn.call('connect')
    if ((await conn.call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('не сервер фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await kit.cmd('/gamemode creative')
    await kit.ensureWorld('overworld', { tp: '3000.5 100 3000.5' })
    await kit.fillExact('overworld', [[2993, 99, 2993], [3007, 99, 3007]], 'stone')
    await kit.fillExact('overworld', [[2994, 100, 2994], [3006, 104, 3006]], 'air')
    await kit.cmd('/tp @s 3000.5 100 3000.5')
    await kit.cmd('/clear @s')
    await kit.cmd('/give @s minecraft:stone_pickaxe 1')
    await kit.cmd('/give @s minecraft:stone_sword 1')
    for (const item of ['cobblestone 64', 'stick 64', 'crafting_table 4', 'furnace 3', 'bowl 4', 'leather 4', 'lapis_lazuli 4', 'blaze_rod 2', 'netherrack 1664']) await kit.cmd(`/give @s minecraft:${item}`)
    await kit.cmd('/gamemode survival')
    await sleep(500)
    result.before = await conn.call('situation')
    if (result.before.detail.free !== 0) throw new Error('полный рюкзак не подготовлен — сцена недействительна')
    result.tidy = await conn.call('pack', { mode: 'tidy', also: 'netherrack:128, crafting_table:1, furnace:1, bowl:1, leather:0, lapis_lazuli:0' })
    await sleep(2200)
    result.clean = (await conn.call('status')).state.inventory
    result.craft = await conn.call('craft', { item: 'stone_pickaxe', count: 1 })
    await sleep(2200)
    result.end = (await conn.call('status')).state.inventory
    result.ok = result.craft.status === 'done' && result.clean.crafting_table === 1 && result.clean.furnace === 1 &&
      !result.clean.leather && !result.clean.lapis_lazuli && result.end.stone_pickaxe === result.clean.stone_pickaxe + 1 &&
      result.end.cobblestone === result.clean.cobblestone - 3 && result.end.blaze_rod === 2
  } catch (e) { result.error = e.message } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify({ slot, ok: result.ok, error: result.error, craft: result.craft?.status, clean: result.clean, end: result.end }))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
