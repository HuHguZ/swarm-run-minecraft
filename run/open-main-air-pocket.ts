'use strict'
// Короткое решение MCP-мозга по потолку, названному реальным surface.
// Все действия — обычная копка/постановка собственных блоков. Не оператор.
import { connect } from '../daemon/scenes/lib/scene-kit'
const conn = connect('ws://127.0.0.1:8769')
let lastDeath
async function step (method, params: any = {} as Record<string, any>) {
  const r = await conn.call(method, params)
  console.log(JSON.stringify({ method, params, status: r.status, by: r.by?.type, hp: r.state?.health,
    pos: r.state?.pos, detail: r.detail, error: r.error }))
  const stamp = r.state?.lastDeathAt
  if (r.by?.type === 'death' || r.events?.some(e => e.type === 'death') ||
    (lastDeath !== undefined && stamp !== lastDeath)) throw new Error('смерть — прежнее решение отменено')
  if (stamp !== undefined) lastDeath = stamp
  if (r.status !== 'done') throw new Error(`${method}: ${r.error || r.status}`)
  return r
}
async function main () {
  await conn.ready
  try {
    if ((await step('status')).detail.server !== '127.0.0.1:25569') throw new Error('не основной сервер')
    const start = (await step('connect')).state
    if (start.dimension !== 'overworld' || !start.pos || Math.hypot(start.pos.x - 618, start.pos.y - 59, start.pos.z + 60) > 2) {
      throw new Error('позиция изменилась — старые координаты копки отменены')
    }
    // Краткое вытеснение воды в клетке глаз — обычный факел из рюкзака.
    // При отказе или смерти прежняя копка не запускается.
    await step('place', { block: 'torch', at: { x: 618, y: 60, z: -60 } })
    await step('situation')
    await step('mine', { block: 'stone_like', at: { x: 618, y: 61, z: -60 }, radius: 4, collect: false, timeoutSeconds: 10 })
    await step('surface', { targetY: 60, timeoutSeconds: 8, preferPillar: false })
    for (const [x, y] of [[618, 62], [619, 61], [619, 62]]) {
      await step('mine', { block: 'stone_like', at: { x, y, z: -60 }, radius: 4, collect: false, timeoutSeconds: 10 })
    }
    await step('place', { block: 'cobblestone', at: { x: 619, y: 60, z: -60 } })
    await step('surface', { targetY: 61, timeoutSeconds: 15, preferPillar: false })
    const sit = await step('situation')
    if (sit.detail.inWater) throw new Error('вода осталась — повтор не запускается')
    console.log(JSON.stringify({ dry: true, hp: sit.state.health, pos: sit.state.pos }))
  } finally {
    try { await conn.call('stop') } finally { await conn.call('disconnect', { reason: 'конец решения выхода из водной камеры' }); conn.close() }
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
