'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// Сторож зависания демона (s5, 06.10: после убийства дракона демон дважды замолкал — сервер «Timed out», бой не возвращался).
// Раз в 3 с реального времени — RPC status демона слота (тайм-аут 2 с). Не ответил дважды подряд — цикл событий занят:
// профиль CPU 3 с через инспектор (демон с NODE_OPTIONS=--inspect=127.0.0.1:0, адрес — из farm/daemon-<слот>.err.log).
// Ответил, но часы стоят (ticks ≥ serverTicks+20 и не растут 10 с) — пишет снимок. Всё — в <папка>/hang-*.{json,cpuprofile}.
//   node dist/farm/dragon/hang-watch.js <слот> <папка> [секунд]
import * as fs from 'fs'
import path = require('path')
const WebSocket = require(path.join(__dirname, '..', '..', 'daemon', 'node_modules', 'ws'))
const [slot, dir, secs] = [Number(process.argv[2]), process.argv[3], Number(process.argv[4] || 7200)]
const root = REPO_ROOT
fs.mkdirSync(dir, { recursive: true })
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
function rpc (method, ms = 2000) {
  return new Promise<any>(resolve => {
    let done = false
    const ws = new WebSocket(`ws://127.0.0.1:${8800 + slot}`)
    const t = setTimeout(() => { if (!done) { done = true; try { ws.terminate() } catch {} resolve(null) } }, ms)
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params: {} })))
    ws.on('message', m => { const j = JSON.parse(String(m)); if (j.id !== 1 || done) return; done = true; clearTimeout(t); ws.close(); resolve(j.result || {}) })
    ws.on('error', () => { if (!done) { done = true; clearTimeout(t); resolve(undefined) } })
  })
}
function profile (secs) {
  const err = fs.readFileSync(path.join(root, 'farm', `daemon-${slot}.err.log`), 'utf8')
  const m = [...err.matchAll(/ws:\/\/127\.0\.0\.1:(\d+)\/[-0-9a-f]+/g)].pop()
  if (!m) return Promise.resolve('нет адреса инспектора')
  return new Promise<any>(resolve => {
    const ws = new WebSocket(m[0]); let id = 0; const wait = new Map()
    const send = (method, params = {}) => new Promise<any>(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.on('message', x => { const j = JSON.parse(String(x)); if (j.id && wait.has(j.id)) { wait.get(j.id)(j.result); wait.delete(j.id) } })
    ws.on('error', e => resolve('инспектор: ' + e.message))
    ws.on('open', async () => {
      await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 250 }); await send('Profiler.start')
      setTimeout(async () => { const r = await send('Profiler.stop'); const f = path.join(dir, `hang-${stamp()}.cpuprofile`); fs.writeFileSync(f, JSON.stringify(r.profile)); ws.close(); resolve(f) }, secs * 1000)
    })
  })
}
;(async () => {
  const t0 = Date.now(); let miss = 0; let last = null; let still = 0
  while (Date.now() - t0 < secs * 1000) {
    await new Promise(r => setTimeout(r, 3000))
    const s = await rpc('status')
    if (s === undefined) { miss = 0; continue } // демона нет (перезапуск между боями)
    if (s === null) {
      if (++miss >= 2) { const f = await profile(3); fs.appendFileSync(path.join(dir, 'hang.log'), `${new Date().toISOString()} демон не отвечает — профиль ${f}\n`); miss = 0 }
      continue
    }
    miss = 0
    const c = s.state && s.state.clock
    if (c && c.serverTicks != null && c.ticks - c.serverTicks >= 20 && last && last.ticks === c.ticks) {
      if (++still === 3) fs.appendFileSync(path.join(dir, 'hang.log'), `${new Date().toISOString()} часы стоят: ${JSON.stringify(c)} busy=${s.state.busy} dim=${s.state.dimension} pos=${JSON.stringify(s.state.pos)}\n`)
    } else still = 0
    last = c
  }
})()
