// node dist/farm/dragon/cdp-prof.js <port> <seconds> <out.cpuprofile> — профиль CPU процесса node с --inspect (s5 06.10)
const WebSocket = require((require('path') as typeof import('path')).join(__dirname, '..', '..', 'daemon', 'node_modules', 'ws'))
import * as http from 'http'
const [port, secs, out] = [process.argv[2], Number(process.argv[3]), process.argv[4]]
http.get(`http://127.0.0.1:${port}/json/list`, res => {
  let b = ''; res.on('data', d => { b += d }); res.on('end', () => {
    const url = JSON.parse(b)[0].webSocketDebuggerUrl
    const ws = new WebSocket(url); let id = 0; const wait = new Map()
    const send = (method, params = {}) => new Promise<any>(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    ws.on('message', m => { const j = JSON.parse(m); if (j.id && wait.has(j.id)) { wait.get(j.id)(j.result); wait.delete(j.id) } })
    ws.on('open', async () => {
      await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 250 }); await send('Profiler.start')
      console.log('profiling', secs, 's')
      setTimeout(async () => { const r = await send('Profiler.stop'); ;(require('fs') as typeof import('fs')).writeFileSync(out, JSON.stringify(r.profile)); console.log('saved', out); ws.close() }, secs * 1000)
    })
  })
})
