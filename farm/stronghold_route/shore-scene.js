'use strict'
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('../../daemon/scene-kit')
const ROOT = path.resolve(__dirname, '../..')
const OUT = path.join(__dirname, 'shore-result.jsonl')
const MEM = path.join(ROOT, 'farm/memory-2/state.json')
const conn = connect('ws://127.0.0.1:8802')
const kit = createKit({ call: conn.call, heard: conn.heard, logFile: path.join(ROOT, 'farm/server-2/logs/latest.log'), player: 'NeuroFarm2' })
const read = () => JSON.parse(fs.readFileSync(MEM, 'utf8'))
const stages = []
async function step (method, params) {
  const result = await conn.call(method, params)
  const rec = { at: new Date().toISOString(), method, params, ...result }
  stages.push(rec)
  console.log(JSON.stringify(rec))
  return result
}
async function main () {
  await conn.ready
  await step('connect', {})
  await step('stop', {})
  if (process.env.SHORE_RESET_PLACEMENT === '1') {
    await kit.cmd(process.env.SHORE_FROM_DRY === '1' ? '/tp @s -236.5 63 736.5' : '/tp @s -178.5 62 725.5')
    await kit.ensureWorld('overworld')
    await sleep(3000) // после /tp нужно дождаться чанков; biome:null не доказательство воды
  }
  await kit.cmd('/random reset *')
  const before = read()
  const stamps = new Set((before.deaths || []).map(x => x.at))
  const start = await step('status', {})
  const t0 = Date.now()
  if (process.env.SHORE_PILLAR === '1') await step('surface', { targetY: 64, timeoutSeconds: 45, preferPillar: true })
  if (process.env.SHORE_FROM_DRY === '1') await step('ride', { kind: 'boat', mode: 'go', x: -178, z: 725, stay: true, pickup: false, timeoutSeconds: 120 })
  const r = await step('ride', { kind: 'boat', mode: 'go', x: -236, z: 736, timeoutSeconds: 120 })
  await sleep(1000)
  let sit = await step('situation', {})
  if (sit.detail?.inWater === false) await step('sleep', { untilMorning: true, take: true, timeoutSeconds: 30 })
  sit = await step('situation', {})
  const after = read()
  const deaths = (after.deaths || []).filter(x => !stamps.has(x.at)).map(({ at, cause, pos }) => ({ at, cause, pos }))
  const rec = { at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    start: start.state, arrived: r.detail?.arrived, inWater: sit.detail?.inWater, surface: sit.detail?.surface,
    state: sit.state, deaths, stages }
  fs.appendFileSync(OUT, JSON.stringify(rec) + '\n')
  await conn.call('stop')
  await conn.call('disconnect', { reason: 'ферма: опыт берега завершён' })
  conn.close()
}
main().then(() => process.exit(0)).catch(async e => {
  console.error(e.stack || e)
  await conn.call('stop').catch(() => {})
  await conn.call('disconnect', { reason: 'ферма: ошибка опыта берега' }).catch(() => {})
  conn.close()
  process.exit(1)
})
