'use strict'
// Minimal RCON client for MY run server only (server-run, rcon port from its
// server.properties). Usage: node rcon.js "gamerule keep_inventory true"
const net = require('net')
const fs = require('fs')
const props = fs.readFileSync('C:/Users/user/Desktop/work/minecraft-claude/server-run/server.properties', 'utf8')
const get = k => (new RegExp('^' + k.replace('.', '\\.') + '=(.*)$', 'm').exec(props) || [])[1]
const port = Number(get('rcon.port'))
const pass = get('rcon.password')
if (port === 25575 || !pass) { console.error('refusing: not the run server rcon config'); process.exit(1) }
const cmd = process.argv.slice(2).join(' ')
const pkt = (id, type, body) => {
  const b = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + b.length)
  buf.writeInt32LE(10 + b.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  b.copy(buf, 12)
  return buf
}
const sock = net.connect(port, '127.0.0.1', () => sock.write(pkt(1, 3, pass)))
let acc = Buffer.alloc(0)
let authed = false
sock.on('data', d => {
  acc = Buffer.concat([acc, d])
  while (acc.length >= 4) {
    const len = acc.readInt32LE(0)
    if (acc.length < len + 4) break
    const id = acc.readInt32LE(4)
    const body = acc.slice(12, len + 2).toString('utf8')
    acc = acc.slice(len + 4)
    if (!authed) {
      if (id === -1) { console.error('auth failed'); sock.end(); return }
      authed = true
      sock.write(pkt(2, 2, cmd))
    } else {
      console.log(body || '(empty reply)')
      sock.end()
    }
  }
})
sock.on('error', e => { console.error(e.message); process.exit(1) })
setTimeout(() => process.exit(0), 5000)
