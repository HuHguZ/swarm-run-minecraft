'use strict'
import * as gameClock from '../../src/game-clock'
import * as fs from 'fs'
import { connect, createKit, sleep } from '../lib/scene-kit'
async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 10) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  const timer = gameClock.wall.setTimeout(() => conn.ws.terminate(), 120000)
  const result: Record<string, any> = { labFixture: true, slot, ok: false }
  try {
    await conn.ready
    await conn.call('connect')
    if ((await conn.call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('не сервер фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await kit.cmd('/gamemode creative')
    await kit.cmd('/effect clear @s')
    await kit.cmd('/effect give @s minecraft:instant_health 1 10 true')
    await kit.ensureWorld('overworld', { tp: '3198.5 100 3198.5' })
    await kit.cmd('/difficulty peaceful')
    for (const [dim, x, z] of ([['the_nether', 400, 400], ['overworld', 3200, 3200]] as Array<any>)) {
      await kit.forceload(dim, [[x - 3, 99, z - 3], [x + 4, 104, z + 3]])
      await sleep(500)
      await kit.fillExact(dim, [[x - 3, 99, z - 3], [x + 4, 104, z + 3]], 'air')
      await kit.fillExact(dim, [[x - 3, 99, z - 3], [x + 4, 99, z + 3]], 'stone')
      await kit.fillExact(dim, [[x - 1, 99, z], [x + 2, 103, z]], 'obsidian')
      await kit.fillExact(dim, [[x, 100, z], [x + 1, 102, z]], 'nether_portal[axis=x]')
    }
    // All four overworld doorsteps lack a floor; there is no clearStand
    // alternative that could let this test pass without the repair.
    for (const z of [3199, 3201]) await kit.fillExact('overworld', [[3200, 99, z], [3201, 99, z]], 'air')
    await kit.cmd('/clear @s')
    await kit.cmd('/give @s minecraft:flint_and_steel 1')
    await kit.cmd('/give @s minecraft:cobblestone 16')
    await kit.ensureWorld('overworld', { tp: '3198.5 100 3198.5' })
    await kit.cmd('/gamemode survival')
    await conn.call('disconnect')
    await conn.call('connect')
    // No operator commands after login. Placement and transition must work
    // on a newly loaded survival connection.
    result.before = (await conn.call('status')).state
    const portals = await conn.call('blocks_around', { find: 'nether_portal', radius: 16, count: 64 })
    result.portalCount = portals.detail.found.length
    if (result.before.dimension !== 'overworld' || portals.detail.found.length !== 6 || result.before.inventory.cobblestone !== 16 || result.before.health !== 20) {
      throw new Error('сцена не готова: верхний мир, 6 клеток портала, 16 блоков и 20 хп обязательны')
    }
    result.fixtureReady = true
    const start = gameClock.now()
    result.enter = await conn.call('portal', { mode: 'enter', timeoutSeconds: 60 })
    result.elapsedMs = gameClock.now() - start
    await sleep(500)
    result.end = (await conn.call('status')).state
    result.ok = result.enter.detail?.went === true && result.enter.detail?.access?.ok === true &&
      result.enter.detail.access.placed === 1 && result.end.dimension === 'the_nether' &&
      result.end.health === 20 && result.end.inventory.cobblestone === 15
    // Cleanup happens after the measured result, never during the transition.
    for (const [dim, x, z] of ([['the_nether', 400, 400], ['overworld', 3200, 3200]] as Array<any>)) {
      await kit.unforceload(dim, [[x - 3, 99, z - 3], [x + 4, 104, z + 3]])
    }
  } catch (e) { result.error = e.message } finally {
    try { await conn.call('disconnect') } catch {}
    gameClock.wall.clearTimeout(timer)
    conn.close()
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify({ slot, ok: result.ok, elapsedMs: result.elapsedMs, error: result.error, access: result.enter?.detail?.access, stopped: result.enter?.detail?.stopped }))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
