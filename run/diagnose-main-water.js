'use strict'
const { connect } = require('../daemon/scene-kit')
const conn = connect('ws://127.0.0.1:8769')
async function main () {
  await conn.ready
  try {
    if ((await conn.call('status')).detail.server !== '127.0.0.1:25569') throw new Error('не основной сервер')
    await conn.call('connect')
    for (const [method, params] of [['status', { physics: true }], ['dig_time', { x: 618, y: 61, z: -60, hold: 'stone_pickaxe' }], ['situation', {}]]) {
      const r = await conn.call(method, params)
      console.log(JSON.stringify({ method, hp: r.state?.health, pos: r.state?.pos, detail: r.detail, error: r.error }))
    }
  } finally { await conn.call('disconnect', { reason: 'конец чтения диагностики копки' }); conn.close() }
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
