'use strict'
const fs = require('fs')
const path = require('path')
const { connect, createKit, sleep } = require('../../daemon/scene-kit')
const ROOT = path.resolve(__dirname, '../..')
const PREFIX = path.join(__dirname, 'boat-route')
const MEM = path.join(ROOT, 'farm/memory-2/state.json')
const read = () => JSON.parse(fs.readFileSync(MEM, 'utf8'))
const c = connect('ws://127.0.0.1:8802')
const kit = createKit({ call: c.call, heard: c.heard, logFile: path.join(ROOT, 'farm/server-2/logs/latest.log'), player: 'NeuroFarm2' })
const shore = { x: Number(process.env.BOAT_SHORE_X || -400), z: Number(process.env.BOAT_SHORE_Z || 1796) }
const distance = s => s.pos ? Math.hypot(shore.x - s.pos.x, shore.z - s.pos.z) : Infinity
const calls = []
let reason = '8 минут лодочных отрезков'
async function act (method, params) {
  const r = await c.call(method, params)
  const rec = { at: new Date().toISOString(), method, params, ...r }
  calls.push(rec)
  fs.appendFileSync(PREFIX + '.calls.jsonl', JSON.stringify(rec) + '\n')
  console.log(JSON.stringify({ at: rec.at, method, params, status: r.status, detail: r.detail, pos: r.state?.pos, health: r.state?.health, food: r.state?.food, lastDeathAt: r.state?.lastDeathAt }))
  return r
}
async function main () {
  await c.ready
  await c.call('connect')
  await c.call('stop')
  await sleep(1500)
  await kit.cmd('/random reset *')
  const stamps = new Set((read().deaths || []).map(x => x.at))
  const start = (await c.call('status')).state
  let state = start
  const t0 = Date.now()
  let room = null
  for (let n = 0; n < 22 && Date.now() - t0 < 8 * 60000; n++) {
    if ((read().deaths || []).some(x => !stamps.has(x.at))) { reason = 'durable смерть'; break }
    if (distance(state) <= 16) { reason = 'достиг берега A'; break }
    const initial = distance(state)
    const a = Math.atan2(shore.z - state.pos.z, shore.x - state.pos.x)
    let moved = false
    for (const turn of [0, 0.5, -0.5]) {
      const step = Math.min(64, initial)
      const dest = initial <= 80 ? shore : { x: Math.round(state.pos.x + Math.cos(a + turn) * step), z: Math.round(state.pos.z + Math.sin(a + turn) * step) }
      const r = await act('ride', { kind: 'boat', mode: 'go', ...dest, stay: initial > 80, timeoutSeconds: 70 })
      state = r.state || state
      if (r.by?.type === 'death') { reason = 'durable смерть'; break }
      if (r.detail?.arrived && r.detail?.beached && initial > 80) {
        await act('ride', { kind: 'boat', mode: 'dismount' })
        await act('ride', { kind: 'boat', mode: 'pickup', radius: 8 })
        const w = await act('goto', { ...dest, range: 4, timeoutSeconds: 30, surface: 'strict' })
        state = w.state || state
      }
      if (distance(state) < initial - 20 || distance(state) <= 16) { moved = true; break }
      if (initial <= 80) break
    }
    if (reason === 'durable смерть') break
    if (!moved) { reason = 'нет продвижения за три известных лодочных направления'; break }
  }
  if (reason === 'достиг берега A' || distance(state) <= 24) {
    await act('sleep', { untilMorning: true, take: true, timeoutSeconds: 30 })
    const r = await act('stronghold', { mode: 'room', timeoutSeconds: 500 })
    room = r.detail?.room || null
    reason = room ? 'комната найдена' : 'берег достигнут, room отказал'
    state = r.state || state
  }
  const m = read()
  const rec = { at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), reason, start, state,
    room: room || m.places?.['портал в Край'], deaths: (m.deaths || []).filter(x => !stamps.has(x.at)).map(({ at, cause, pos }) => ({ at, cause, pos })), calls }
  fs.appendFileSync(PREFIX + '.jsonl', JSON.stringify(rec) + '\n')
  await c.call('stop')
  await c.call('disconnect', { reason: 'ферма: boat-route завершён' })
  c.close()
}
main().then(() => process.exit(0)).catch(async e => {
  console.error(e.stack || e)
  await c.call('stop').catch(() => {})
  await c.call('disconnect', { reason: 'ферма: ошибка boat-route' }).catch(() => {})
  c.close()
  process.exit(1)
})
