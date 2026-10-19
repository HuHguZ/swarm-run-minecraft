'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// Запись дракона со стороны сервера по тикам (истина для прогноза головы):
//   node dist/farm/dragon/rec-dragon.js <слот> <out.jsonl> [секунд]
// RCON: data get entity … Pos / Motion / Rotation / DragonPhase / Health + time query gametime —
// по полю отдельной командой (большой ответ RCON режет на куски по 4096), все шесть разом;
// команды исполняет главный поток между тиками — почти каждый тик.
import * as net from 'net'
import * as fs from 'fs'
import path = require('path')
const slot = Number(process.argv[2])
const out = process.argv[3]
const secs = Number(process.argv[4] || 1200)
const props = fs.readFileSync(path.join(REPO_ROOT, 'farm', `server-${slot}`, 'server.properties'), 'utf8')
const get = k => (new RegExp('^' + k.replace('.', '\\.') + '=(.*)$', 'm').exec(props) || [])[1]
const port = Number(get('rcon.port')); const pass = get('rcon.password')
const pkt = (id, type, body) => {
  const b = Buffer.from(body, 'utf8'); const buf = Buffer.alloc(14 + b.length)
  buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12); return buf
}
const ws = fs.createWriteStream(out, { flags: 'a' })
let acc = Buffer.alloc(0); let id = 10; const wait = new Map()
let sock = null
function connect () {
  return new Promise<any>((resolve, reject) => {
    sock = net.connect(port, '127.0.0.1')
    sock.on('data', d => {
      acc = Buffer.concat([acc, d])
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0); if (acc.length < len + 4) break
        const rid = acc.readInt32LE(4); const body = acc.slice(12, len + 2).toString('utf8'); acc = acc.slice(len + 4)
        const w = wait.get(rid); if (w) { wait.delete(rid); w(body) }
      }
    })
    sock.on('error', reject)
    sock.on('connect', () => { wait.set(1, resolve); sock.write(pkt(1, 3, pass)) })
  })
}
const send = body => new Promise<any>(resolve => { const i = ++id; wait.set(i, resolve); sock.write(pkt(i, 2, body)) })
const nums = s => (s || '').replace(/[dfL]/g, '').split(',').map(Number)
const arr = s => nums((/\[([^\]]*)\]/.exec(s) || [])[1])
async function main () {
  for (let k = 0; k < 30; k++) { try { await connect(); break } catch (e) { await new Promise<any>(resolve => setTimeout(resolve, 3000)) } }
  const until = Date.now() + secs * 1000
  const sel = '@e[type=minecraft:ender_dragon,limit=1]'
  let lastGt = null; let n = 0
  while (Date.now() < until) {
    // По одной: RconClient читает один пакет за раз, пачку теряет.
    const gt = await send('time query gametime')
    const P: any = await send(`data get entity ${sel} Pos`)
    const M = await send(`data get entity ${sel} Motion`)
    const R = await send(`data get entity ${sel} Rotation`)
    const PH = await send(`data get entity ${sel} DragonPhase`)
    const HP = await send(`data get entity ${sel} Health`)
    const gt2 = await send('time query gametime')
    const g = Number((/(\d+)/.exec(gt) || [])[1])
    // Тик сменился посреди опроса — поля из разных тиков: выбросить.
    if (g !== Number((/(\d+)/.exec(gt2) || [])[1])) continue
    if (g === lastGt) continue
    lastGt = g
    if (!/entity data/.test(P)) {
      if (n++ % 50 === 0) ws.write(JSON.stringify({ t: Date.now(), gt: g, none: P.slice(0, 80) }) + '\n')
      await new Promise<any>(resolve => setTimeout(resolve, 200)); continue
    }
    const ph = Number((/data: (-?\d+)/.exec(PH) || [])[1])
    const hp = Number((/data: ([\d.]+)/.exec(HP) || [])[1])
    ws.write(JSON.stringify({ t: Date.now(), gt: g, ph, hp, p: arr(P), v: arr(M), r: arr(R) }) + '\n')
  }
  ws.end(); sock.end()
}
main().catch(e => { console.error(e); process.exit(1) })
