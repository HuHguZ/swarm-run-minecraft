'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// Продолжение сохранённого слота 5 существующим goStronghold/room, без горной/ночной кампании.
import * as fs from 'fs'
import path = require('path')
import { connect, createKit, sleep } from '../../daemon/scenes/lib/scene-kit'
const ROOT = REPO_ROOT
const PREFIX = path.join(REPO_ROOT, 'farm/stronghold_route/direct-room')
const MEM = path.join(ROOT, 'farm/memory-5/state.json')
const read = () => JSON.parse(fs.readFileSync(MEM, 'utf8'))
const c = connect('ws://127.0.0.1:8805')
const kit = createKit({ call: c.call, heard: c.heard, logFile: path.join(ROOT, 'farm/server-5/logs/latest.log'), player: 'NeuroFarm5' })
async function main () {
  await c.ready
  await c.call('connect')
  await c.call('stop')
  await sleep(1500)
  await kit.randomReset()
  const stamps = new Set((read().deaths || []).map(x => x.at))
  const start = (await c.call('status')).state
  const t0 = Date.now()
  let active = null
  let reason = '3 вызова room'
  const results = []
  const timer = setInterval(async () => {
    try {
      const s = (await c.call('status')).state
      const deaths = (read().deaths || []).filter(x => !stamps.has(x.at)).map(({ at, cause, pos }: any) => ({ at, cause, pos }))
      const rec = { at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), ...s, deaths }
      fs.appendFileSync(PREFIX + '.trace.jsonl', JSON.stringify(rec) + '\n')
      console.log(JSON.stringify(rec))
      if (deaths.length) { reason = 'durable смерть'; await c.call('stop') }
    } catch (e) { console.error(e.message) }
  }, 10000)
  try {
    for (let i = 0; i < 3 && reason !== 'durable смерть'; i++) {
      active = await c.call('stronghold', { mode: 'room', timeoutSeconds: 500 })
      results.push(active)
      fs.appendFileSync(PREFIX + '.calls.jsonl', JSON.stringify({ at: new Date().toISOString(), call: i + 1, ...active }) + '\n')
      if (active.detail?.room) { reason = 'комната найдена'; break }
      if (active.by?.type === 'death') { reason = 'durable смерть'; break }
      if ((active.state?.health ?? 20) < 12) {
        await c.call('eat')
        await c.call('fight', { timeoutSeconds: 30, retreatAtHealth: 7 })
      }
    }
  } finally { clearInterval(timer) }
  const end = (await c.call('status')).state
  const m = read()
  const rec = { at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), reason, start, end,
    room: m.places?.['портал в Край'], deaths: (m.deaths || []).filter(x => !stamps.has(x.at)).map(({ at, cause, pos }: any) => ({ at, cause, pos })),
    results }
  fs.appendFileSync(PREFIX + '.jsonl', JSON.stringify(rec) + '\n')
  await c.call('stop')
  await c.call('disconnect', { reason: 'ферма: direct-room завершён' })
  c.close()
}
main().then(() => process.exit(0)).catch(async e => {
  console.error(e.stack || e)
  await c.call('stop').catch(() => {})
  await c.call('disconnect', { reason: 'ферма: ошибка direct-room' }).catch(() => {})
  c.close()
  process.exit(1)
})
