'use strict'
// Проверка замка в мире через демон (RPC ask): блоки по модельным
// координатам, произвольные команды. Замок стоит в X Y Z из castle-built.json.
//   node castle-probe.js --ws ws://127.0.0.1:8771 block x y z <блок[сост]> …
//   node castle-probe.js --ws … cmd "/…" [match]
const fs = require('fs')
const path = require('path')
const WebSocket = require('ws')

function rpc (url) {
  const ws = new WebSocket(url)
  let id = 0
  const wait = new Map()
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); const w = wait.get(m.id); if (!w) return; wait.delete(m.id); m.ok ? w.res(m.result) : w.rej(new Error(JSON.stringify(m.error))) })
  const ready = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  const call = async (method, params = {}) => { await ready; const k = ++id; ws.send(JSON.stringify({ id: k, method, params })); return new Promise((resolve, reject) => wait.set(k, { res: resolve, rej: reject })) }
  return { call, close: () => ws.close() }
}

function origin () {
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, 'castle-built.json'), 'utf8'))
  const [k] = Object.keys(all)
  return all[k]
}

// Выполнить команду и вернуть строки чата, совпавшие с match.
async function ask (call, command, match, ms = 4000) {
  const r = await call('ask', { command, match, ms })
  return (r && r.detail && r.detail.lines) || []
}

// Блок в мире (модельные координаты) — совпадает ли с состоянием?
async function isBlock (call, o, x, y, z, block) {
  const lines = await ask(call, `/execute if block ${o.X + x} ${o.Y + y} ${o.Z + z} ${block}`, 'Test (passed|failed)')
  return lines.some(l => /passed/.test(l)) ? true : lines.some(l => /failed/.test(l)) ? false : null
}

module.exports = { rpc, origin, ask, isBlock }

if (require.main === module) {
  const a = process.argv.slice(2)
  const wi = a.indexOf('--ws'); const url = wi >= 0 ? a.splice(wi, 2)[1] : 'ws://127.0.0.1:8771'
  const { call, close } = rpc(url)
  const o = origin()
  ;(async () => {
    if (a[0] === 'block') {
      for (let i = 1; i + 3 < a.length; i += 4) {
        const [x, y, z] = a.slice(i, i + 3).map(Number)
        console.log(`${x} ${y} ${z} ${a[i + 3]}: ${await isBlock(call, o, x, y, z, a[i + 3])}`)
      }
    } else if (a[0] === 'cmd') {
      console.log((await ask(call, a[1], a[2] || '.', Number(a[3] || 4000))).join('\n'))
    }
    close()
  })().catch(e => { console.error(e.message); close(); process.exit(1) })
}
