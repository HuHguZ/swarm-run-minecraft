'use strict'
// Реальное surface основного бота: без команд оператора, отключение после
// ограниченного выхода из воды сохраняет жизнь во время дальнейшей диагностики.
import { connect } from '../daemon/scenes/lib/scene-kit'
const conn = connect('ws://127.0.0.1:8769')
async function main () {
  await conn.ready
  try {
    const server = await conn.call('status')
    if (server.detail?.server !== '127.0.0.1:25569') throw new Error('не основной сервер')
    await conn.call('connect')
    const result = await conn.call('surface', { targetY: 64, timeoutSeconds: 45, preferPillar: false })
    console.log(JSON.stringify({ status: result.status, by: result.by?.type, hp: result.state?.health,
      pos: result.state?.pos, detail: result.detail, error: result.error }))
    const situation = await conn.call('situation')
    console.log(JSON.stringify({ hp: situation.state?.health, pos: situation.state?.pos, situation: situation.detail }))
    if (situation.detail?.inWater) throw new Error('вода осталась — повтор без разбора не запускается')
  } finally {
    try { await conn.call('stop') } finally { await conn.call('disconnect', { reason: 'конец диагностики выхода из воды' }); conn.close() }
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
