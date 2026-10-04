'use strict'
// Искусственная закрытая водная камера. Все операторские команды — только ферма.
const fs = require('fs')
const { connect, createKit, sleep } = require('./scene-kit')
async function main () {
  const slot = Number(process.env.FARM_SLOT)
  if (!(slot >= 1 && slot <= 10) || process.env.ND_WS !== `ws://127.0.0.1:${8800 + slot}` ||
    process.env.MC_USERNAME !== `NeuroFarm${slot}`) throw new Error('только ферма')
  const conn = connect(process.env.ND_WS)
  const result = { labFixture: true, ok: false, steps: [], slot }
  const call = async (method, params = {}) => {
    const r = await conn.call(method, params)
    result.steps.push({ method, params, status: r.status, by: r.by?.type, error: r.error,
      hp: r.state?.health, pos: r.state?.pos, detail: r.detail })
    if (r.status !== 'done') throw new Error(`${method}: ${r.error || r.status}`)
    return r
  }
  try {
    await conn.ready
    await call('connect')
    if ((await call('status')).detail.server !== `127.0.0.1:${25600 + slot}`) throw new Error('сервер не фермы')
    const kit = createKit({ call: conn.call, heard: conn.heard, logFile: process.env.ND_SERVER_LOG, player: process.env.MC_USERNAME })
    await kit.cmd('/gamemode creative')
    await kit.ensureWorld('overworld', { tp: '2600.5 100 2600.5' })
    await kit.fillExact('overworld', [[2598, 99, 2598], [2602, 104, 2602]], 'stone')
    await kit.fillExact('overworld', [[2600, 100, 2600], [2600, 101, 2600]], 'water')
    await kit.cmd('/clear @s')
    await kit.cmd('/give @s minecraft:stone_pickaxe')
    await kit.cmd('/give @s minecraft:cobblestone 12')
    if (process.env.TORCH_AIR === '1') await kit.cmd('/give @s minecraft:torch 12')
    await kit.cmd('/tp @s 2600.5 100 2600.5')
    await sleep(1200) // дождаться чанка после смены измерения и телепорта лаборатории
    await kit.cmd('/effect give @s minecraft:instant_health 1 5 true')
    await kit.cmd('/gamemode survival')
    result.start = (await call('situation')).detail
    if (!result.start.inWater || result.start.surface) throw new Error('водная камера ещё не загружена — сцена недействительна')
    if (process.env.TORCH_AIR === '1') {
      await call('wait', { seconds: 10 })
      result.beforeTorch = (await call('situation')).detail
      result.torch = await call('place', { block: 'torch', at: { x: 2600, y: 101, z: 2600 } })
      await sleep(200)
      result.afterTorch = (await call('situation')).detail
    }
    // Блоки над водой не вскрываются случайной добычей соседней стены.
    await call('mine', { block: 'stone', at: { x: 2600, y: 102, z: 2600 }, radius: 4, collect: false, timeoutSeconds: 12 })
    result.airPocket = await call('surface', { targetY: 101, timeoutSeconds: 8, preferPillar: false })
    for (const [x, y] of [[2600, 103], [2601, 102], [2601, 103]]) {
      await call('mine', { block: 'stone', at: { x, y, z: 2600 }, radius: 4, collect: false, timeoutSeconds: 12 })
    }
    // Ступень выше воды, рядом с колонкой. Это обычная постановка своего блока.
    await call('place', { block: 'cobblestone', at: { x: 2601, y: 101, z: 2600 } })
    result.escape = await call('surface', { targetY: 102, timeoutSeconds: 15, preferPillar: false })
    await sleep(1000) // air_supply восстанавливается сервером после выхода
    result.end = (await call('situation')).detail
    result.ok = result.start.inWater && !result.end.inWater && result.end.oxygen === 20 && result.end.hp >= 18
  } catch (e) { result.error = e.message } finally {
    try { await conn.call('disconnect') } catch {}
    conn.close()
    fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(result) + '\n')
    console.log(JSON.stringify({ slot, ok: result.ok, error: result.error, hp: result.end?.hp, escape: result.escape?.detail }))
  }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
