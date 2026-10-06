'use strict'
const gameClock = require('./src/game-clock')
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
    await kit.ensureWorld('overworld', { tp: '2800 100 2800' })
    await kit.fillExact('overworld', [[2798, 99, 2798], [2802, 104, 2802]], 'stone')
    await kit.fillExact('overworld', [[2800, 100, 2800], [2800, 103, 2800]], 'air')
    await kit.fillExact('overworld', [[2797, 105, 2797], [2803, 108, 2803]], 'air')
    await kit.cmd('/clear @s')
    await kit.cmd('/give @s minecraft:stone_pickaxe 1')
    await kit.cmd('/give @s minecraft:cobblestone 64')
    await kit.cmd(`/tp @s ${slot % 2 ? '2800.5 100 2800.30000001192093' : '2800.699999988079 100 2800.5'}`)
    await sleep(1000)
    await kit.cmd('/gamemode survival')
    // Re-enter with no operator command after login: creative preparation must
    // not hide a missing player_loaded handshake at the moment of the dig.
    await conn.call('disconnect')
    await conn.call('connect')
    result.start = (await conn.call('status', { physics: true })).detail.physics
    const start = gameClock.now()
    result.climb = await conn.call('surface', { targetY: 105, preferPillar: true, timeoutSeconds: 12 })
    result.elapsedMs = gameClock.now() - start
    await sleep(1000)
    result.end = await conn.call('situation')
    result.ok = result.end.detail.surface && result.end.state.health === 20 && result.end.state.pos.y >= 105
  } catch (e) { result.error = e.message } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify({ slot, ok: result.ok, elapsedMs: result.elapsedMs, error: result.error, climb: result.climb?.detail }))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
