'use strict'
const gameClock = require('./src/game-clock')
// Operator-prepared test pond, on farm worlds only. The escape uses surface,
// with no coordinates of the bank passed to the bot and no rescue commands.
const fs = require('fs')
const { connect, createKit, sleep } = require('./scene-kit')
async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 10) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` || process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  const result = { labFixture: true, slot, ok: false, steps: [], roof: slot % 2 === 1 }
  const call = async (method, params = {}) => {
    const r = await conn.call(method, params)
    result.steps.push({ method, status: r.status, error: r.error, hp: r.state?.health, pos: r.state?.pos, detail: r.detail })
    if (r.status !== 'done') throw new Error(`${method}: ${r.error || r.status}`)
    return r
  }
  try {
    await conn.ready
    await call('connect')
    if ((await call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('сервер не фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await kit.cmd('/gamemode creative')
    await kit.ensureWorld('overworld', { tp: '2700.5 100 2700.5' })
    await kit.fillExact('overworld', [[2698, 99, 2698], [2707, 107, 2702]], 'stone')
    await kit.fillExact('overworld', [[2700, 100, 2700], [2705, 103, 2700]], 'water')
    await kit.fillExact('overworld', [[2700, 104, 2700], [2706, 107, 2700]], 'air')
    if (result.roof) await kit.cmd('/setblock 2700 102 2700 minecraft:stone')
    await kit.cmd('/clear @s')
    await kit.cmd('/tp @s 2700.5 100 2700.5')
    await sleep(1200)
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/gamemode survival')
    result.start = (await call('situation')).detail
    if (!result.start.inWater || result.start.surface) throw new Error('пруд не загружен — сцена недействительна')
    const start = gameClock.now()
    result.escape = await call('surface', { targetY: 104, timeoutSeconds: 12, preferPillar: false })
    result.elapsedMs = gameClock.now() - start
    await sleep(3000) // an airborne jump over water is not a stable landing
    result.end = (await call('situation')).detail
    result.body = (await call('status', { physics: true })).detail.physics
    result.ok = !result.end.inWater && result.end.oxygen === 20 && result.end.hp === 20 && result.body.onGround && result.end.surface
  } catch (e) { result.error = e.message } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify({ slot, roof: result.roof, ok: result.ok, error: result.error, hp: result.end?.hp, elapsedMs: result.elapsedMs, escape: result.escape?.detail }))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
