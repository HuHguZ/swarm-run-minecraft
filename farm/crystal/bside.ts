'use strict'
// Второй боец на сервере слота фермы (дуэли кристаллами, 2026-09-30): демон
// NeuroFarm<i>b на том же сервере 25600+i, ws 8900+i, viewer 3200+i, память
// farm/memory-<i>b; приоритет «ниже обычного» (farm.js nice его не видит — порт
// не фермы), оператор через RCON слота.
//   node farm/crystal/bside.js up 29 30
//   node farm/crystal/bside.js down 29 30
//   node farm/crystal/bside.js restart 29 30
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const { spawn, execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const DAEMON = path.join(ROOT, 'daemon')
const OUT = __dirname
const sleep = ms => new Promise<any>(r => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a)

function portOpen (port) {
  return new Promise<any>(resolve => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
    s.setTimeout(1500, () => { s.destroy(); resolve(false) })
  })
}
function pidOnPort (port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().split(/\s+/)
      if (m.length >= 5 && m[3] === 'LISTENING' && Number(m[1].slice(m[1].lastIndexOf(':') + 1)) === port) return Number(m[4])
    }
  } catch {}
  return 0
}
const side = i => ({ i, ws: 8900 + i, viewer: 3200 + i, mc: 25600 + i, name: `NeuroFarm${i}b`, mem: path.join(ROOT, 'farm', `memory-${i}b`) })

async function up (i) {
  const s = side(i)
  if (!(await portOpen(s.mc))) throw new Error(`слот ${i}: сервер ${s.mc} не запущен`)
  if (await portOpen(s.ws)) { log(`${s.name}: демон уже слушает ${s.ws}`); return }
  fs.mkdirSync(s.mem, { recursive: true })
  const out = fs.openSync(path.join(OUT, `daemon-${i}b.out.log`), 'w')
  const err = fs.openSync(path.join(OUT, `daemon-${i}b.err.log`), 'w')
  const env = { ...process.env, ND_WS_PORT: String(s.ws), MC_USERNAME: s.name, MC_PORT: String(s.mc), ND_VIEWER_PORT: String(s.viewer), ND_MEMORY_DIR: s.mem }
  const p = spawn(process.execPath, ['src/index.js'], { cwd: DAEMON, env, detached: true, stdio: ['ignore', out, err], windowsHide: true })
  p.unref()
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  // Ядра — как у демонов фермы (limits.json cores, farm.ts gentle): без этого
  // второй боец шёл на всех 32 ядрах и в дуэлях обгонял первого по доле
  // физических тиков (s7 06.10: 0.89 против 0.77 при 750 TPS).
  try {
    const lim = JSON.parse(fs.readFileSync(path.join(ROOT, 'farm', 'limits.json'), 'utf8'))
    const mask = process.env.FARM_AFFINITY === 'off' ? null : lim.cores === 'ccd1' ? 0xFFFF0000n : null
    if (mask) execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${p.pid}).ProcessorAffinity = [IntPtr][long]${mask}`], { stdio: 'ignore', windowsHide: true })
  } catch {}
  for (let k = 0; k < 30 && !(await portOpen(s.ws)); k++) await sleep(1000)
  log(`${s.name}: демон ${s.ws} ${await portOpen(s.ws) ? '✓' : 'НЕ поднялся'} (pid ${p.pid}, ниже обычного, ядра по limits.json)`)
  try { execFileSync(process.execPath, [path.join(ROOT, 'farm', 'farm.js'), 'rcon', String(i), `op ${s.name}`], { stdio: 'inherit' }) } catch (e) { log('op:', e.message) }
}
async function down (i) {
  const s = side(i)
  const pid = pidOnPort(s.ws)
  if (!pid) { log(`${s.name}: демона нет`); return }
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  log(`${s.name}: демон ${s.ws} остановлен (pid ${pid})`)
}

;(async () => {
  const [cmd, ...ids] = process.argv.slice(2)
  const slots = ids.map(Number).filter(n => n >= 1 && n <= 32)
  if (!slots.length) { console.log("слоты 1–32: node farm/crystal/bside.js up|down|restart 27 28"); return }
  for (const i of slots) {
    if (cmd === 'down' || cmd === 'restart') await down(i)
    if (cmd === 'restart') await sleep(1500)
    if (cmd === 'up' || cmd === 'restart') await up(i)
  }
})().catch(e => { console.error('ОШИБКА', e.message); process.exitCode = 1 })
