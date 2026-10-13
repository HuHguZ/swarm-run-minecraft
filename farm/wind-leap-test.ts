// Проверка прыжка на заряде ветра в точку (daemon/src/wind-leap.ts, RPC wind_leap) на слоте фермы: площадка в небе
// и столбы на разной высоте и дальности; по каждому — план (dryRun) и прыжок, сел ли на верх столба.
//   node farm/wind-leap-test.js <слот> [повторов=2]
const path = require('path')
const fs = require('fs')
const net = require('net')
const ROOT = path.join(__dirname, '..')
const WebSocket = require(path.join(ROOT, 'daemon', 'node_modules', 'ws'))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const slot = Number(process.argv[2] || 30)
const REPS = Number(process.argv[3] || 2)
const props = fs.readFileSync(path.join(ROOT, 'farm', `server-${slot}`, 'server.properties'), 'utf8')
const prop = (k: string) => (new RegExp('^' + k + '=(.*)$', 'm').exec(props) || [])[1].trim()
const NAME = `NeuroFarm${slot}`

function rcon (cmd: string): Promise<string> {
  return new Promise((resolve) => {
    const pkt = (id: number, t: number, b: string) => { const B = Buffer.from(b, 'utf8'); const x = Buffer.alloc(14 + B.length); x.writeInt32LE(10 + B.length, 0); x.writeInt32LE(id, 4); x.writeInt32LE(t, 8); B.copy(x, 12); return x }
    const s = net.connect(Number(prop('rcon.port')), '127.0.0.1', () => s.write(pkt(1, 3, prop('rcon.password'))))
    let acc = Buffer.alloc(0); let sent = false
    s.on('data', d => {
      acc = Buffer.concat([acc, d])
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0); if (acc.length < len + 4) break
        const id = acc.readInt32LE(4); const body = acc.slice(12, len + 2).toString(); acc = acc.slice(len + 4)
        if (id === 1 && !sent) { sent = true; s.write(pkt(2, 2, cmd)) } else if (id === 2) { s.end(); resolve(body) }
      }
    })
    s.on('error', () => resolve(''))
    setTimeout(() => { s.destroy(); resolve('') }, 4000)
  })
}
function call (method: string, params: any): Promise<any> {
  return new Promise(resolve => {
    const ws = new WebSocket('ws://127.0.0.1:' + (8800 + slot))
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method, params })))
    ws.on('message', (m: any) => { const j = JSON.parse(String(m)); if (j.id === 1) { ws.close(); resolve(j.result?.detail ?? j.result ?? j) } })
    ws.on('error', (e: any) => resolve({ error: e.message }))
    setTimeout(() => { try { ws.close() } catch {} resolve({ error: 'timeout' }) }, 20000)
  })
}

// Столб: верх на (x, top, z) относительно площадки (ноги на 150); стартовая площадка 5×5 на y 149.
const CASES = [
  { name: '4 вперёд, +3', x: 0, z: -4, top: 152 },
  { name: '5 вперёд, +5', x: 0, z: -5, top: 154 },
  { name: '3 вперёд, +6', x: 0, z: -3, top: 155 },
  { name: '7 вперёд, +1', x: 0, z: -7, top: 150 },
  { name: '6 наискось, +4', x: 4, z: -4, top: 153 },
  { name: '9 вперёд, 0', x: 0, z: -9, top: 149 }
]

async function main () {
  await call('connect', {}); await sleep(3000); await rcon(`tp ${NAME} 0.5 150 0.5 180 0`); await sleep(2000)
  for (const c of ['gamerule fall_damage false', `gamemode survival ${NAME}`, 'fill -12 140 -12 12 170 12 air', 'fill -2 149 -2 2 149 2 stone']) await rcon(c)
  const rows: any[] = []
  for (const cs of CASES) {
    await rcon('fill -12 140 -12 12 170 12 air'); await rcon('fill -2 149 -2 2 149 2 stone')
    await rcon(`fill ${cs.x} 140 ${cs.z} ${cs.x} ${cs.top} ${cs.z} stone`)
    for (let k = 0; k < REPS; k++) {
      await rcon(`clear ${NAME}`); await rcon(`give ${NAME} minecraft:wind_charge 16`)
      await rcon(`tp ${NAME} 0.5 150 0.5 180 0`); await sleep(1500)
      const to = { x: cs.x + 0.5, y: cs.top + 1, z: cs.z + 0.5 }
      const dry = await call('wind_leap', { to, dryRun: true })
      const r = await call('wind_leap', { to })
      await sleep(500)
      const row = { case: cs.name, k, plan: dry.plan || dry.near || dry.why, ok: !!r.ok, off: r.off, dy: r.dy, why: r.why || null, at: r.at }
      rows.push(row); console.log(JSON.stringify(row))
    }
  }
  const ok = rows.filter(r => r.ok).length
  console.log(`ИТОГ: ${ok}/${rows.length} прыжков сели на столб`)
  await rcon('fill -12 140 -12 12 170 12 air')
}
main().catch(e => { console.error(e); process.exit(1) })
