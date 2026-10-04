'use strict'
// Короткое решение MCP-мозга по уже увиденному дереву основного мира.
// Координаты из честного explore 22:56; здесь нет команд оператора.
const { connect } = require('../daemon/scene-kit')
const conn = connect('ws://127.0.0.1:8769')
let lastDeath
async function step (method, params = {}) {
  const r = await conn.call(method, params)
  console.log(JSON.stringify({ method, status: r.status, by: r.by?.type, pos: r.state?.pos,
    hp: r.state?.health, food: r.state?.food, detail: r.detail, error: r.error }))
  const stamp = r.state?.lastDeathAt
  if (r.by?.type === 'death' || r.events?.some(e => e.type === 'death') ||
    (lastDeath !== undefined && stamp !== lastDeath)) throw new Error('смерть — прежний шаг отменён')
  lastDeath = stamp
  if (r.status !== 'done') throw new Error(`${method}: ${r.error || r.status}`)
  return r
}
async function main () {
  await conn.ready
  let ok = false
  try {
    await step('connect')
    const start = await step('status')
    if (start.detail.server !== '127.0.0.1:25569') throw new Error('не основной сервер')
    if (start.state.dimension !== 'overworld') throw new Error('не верхний мир')
    const sit = await step('situation')
    if (sit.detail.night || sit.detail.dusk) {
      const nap = await step('sleep', { untilMorning: true, timeoutSeconds: 90, take: false })
      if (!nap.detail?.morning) throw new Error('ночь не пропущена — без защиты не выхожу')
    }
    // К колонне ствола goto выбирал верх кроны: сверху ствол скрыт листьями.
    // Подходим сбоку, к земле за краем кроны, по обычному маршруту.
    await step('goto', { x: -39, y: 66, z: 10, range: 1, timeoutSeconds: 45, surface: false })
    await step('pack', { mode: 'tidy', also: 'dirt:0,grass_block:0,gunpowder:0,raw_copper:0,leaf_litter:0' })
    const state = (await step('status')).state
    const wood = Object.entries(state.inventory).filter(([k]) => /_log$|_stem$/.test(k)).reduce((n, [, count]) => n + count, 0)
    if (wood < 4) await step('mine', { block: 'any_log', count: 4 - wood, radius: 24, timeoutSeconds: 45 })
    const end = (await step('status')).state
    const got = Object.entries(end.inventory).filter(([k]) => /_log$|_stem$/.test(k)).reduce((n, [, count]) => n + count, 0)
    if (got < 4) throw new Error('древесина не получена')
    console.log(JSON.stringify({ recoveredWood: got, rods: end.inventory.blaze_rod || 0 }))
    ok = true
  } finally {
    if (!ok) { try { await conn.call('stop'); await conn.call('disconnect') } catch {} }
    conn.close()
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
