'use strict'
// Только чтение состояния игрока на собственном run-сервере. Пароль не выводится.
const fs = require('fs')
const path = require('path')
const net = require('net')
const props = fs.readFileSync(path.join(__dirname, '../server-run/server.properties'), 'utf8')
const prop = name => props.split(/\r?\n/).find(s => s.startsWith(name + '='))?.slice(name.length + 1)
function query (command) {
  return new Promise((resolve, reject) => {
    const packet = (id, type, text) => {
      const body = Buffer.from(text, 'utf8')
      const b = Buffer.alloc(body.length + 14)
      b.writeInt32LE(body.length + 10, 0); b.writeInt32LE(id, 4); b.writeInt32LE(type, 8); body.copy(b, 12)
      return b
    }
    const sock = net.connect(Number(prop('rcon.port')), '127.0.0.1', () => sock.write(packet(1, 3, prop('rcon.password'))))
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('read timeout')) }, 5000)
    let data = Buffer.alloc(0)
    sock.on('error', reject)
    sock.on('data', chunk => {
      data = Buffer.concat([data, chunk])
      while (data.length >= 4 && data.length >= data.readInt32LE(0) + 4) {
        const size = data.readInt32LE(0)
        const id = data.readInt32LE(4); const type = data.readInt32LE(8)
        const text = data.subarray(12, size + 2).toString('utf8')
        data = data.subarray(size + 4)
        if (id === -1) { clearTimeout(timer); sock.destroy(); reject(new Error('read auth failed')); return }
        if (id === 1 && type === 2) sock.write(packet(2, 2, command))
        if (id === 2) { clearTimeout(timer); sock.end(); resolve(text); return }
      }
    })
  })
}
module.exports = { query }
if (require.main === module) {
  ;(async () => {
    for (const field of ['Pos', 'Health', 'Air', 'OnGround']) console.log(await query('data get entity NeuroDown ' + field))
  })().catch(e => { console.error(e.message); process.exitCode = 1 })
}
