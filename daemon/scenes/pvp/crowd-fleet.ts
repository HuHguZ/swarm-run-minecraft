'use strict'
// Нападающие сцены «толпа на одного» (try-crowd): свои демоны слота 29 на портах 9100+k — не 8961+ (их делят все слоты,
// 8961–8989 занял стенд 15×15 слота 31). Так же, как farm/arena/fleet.ts up: демон из той же сборки, что и сцена.
//   node dist-enc/daemon/scenes/pvp/crowd-fleet.js up 5     поднять NeuroFarm29a…e (ws 9100…9104)
//   node dist-enc/daemon/scenes/pvp/crowd-fleet.js down     погасить всех на 9100–9110
import { DIST_ROOT, REPO_ROOT } from '../../src/paths'
import * as fs from 'fs'
import * as net from 'net'
import path = require('path')
import { spawn, execFileSync } from 'child_process'

export const SLOT = 29
export const MC_PORT = 25600 + SLOT
export const WS0 = 9100
export const MAX = 7
export const fighter = (k: number) => ({ name: `NeuroFarm${SLOT}${'acdefgh'[k]}`, ws: WS0 + k, viewer: 9200 + k, mem: path.join(REPO_ROOT, 'farm', `memory-${SLOT}enc-${k}`) })
const OUT = path.join(REPO_ROOT, 'farm', 'results', 'claude-arena', 'enc')

export const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const s = net.connect(port, '127.0.0.1')
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Скорость и пошаговость — как у мира слота (farm/slots.json пишет farm.js up): демоны идут в такт с сервером.
function slotState () {
  try { return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'farm', 'slots.json'), 'utf8')).slots?.[SLOT] || {} } catch { return {} }
}
export async function up (n: number) {
  if (!(n >= 1 && n <= MAX)) throw new Error(`нападающих 1..${MAX}`)
  const st = slotState()
  const rate = Number(st.tickRate) || 20
  fs.mkdirSync(OUT, { recursive: true })
  for (let k = 0; k < n; k++) {
    const s = fighter(k)
    if (await portOpen(s.ws)) { console.log(`${s.name}: уже ${s.ws}`); continue }
    fs.mkdirSync(s.mem, { recursive: true })
    const out = fs.openSync(path.join(OUT, `daemon-${s.name}.log`), 'w')
    const env = { ...process.env, ND_WS_PORT: String(s.ws), MC_USERNAME: s.name, MC_PORT: String(MC_PORT), ND_VIEWER_PORT: String(s.viewer),
      ND_MEMORY_DIR: s.mem, TICK_RATE: String(rate), ND_TICK_RATE: String(rate), ND_CLOCK: 'game', ND_LOCKSTEP: st.lockstep ? '1' : '0' }
    const p = spawn(process.execPath, ['src/index.js'], { cwd: path.join(DIST_ROOT, 'daemon'), env, detached: true, stdio: ['ignore', out, out], windowsHide: true })
    p.unref()
    try { require('os').setPriority(p.pid, require('os').constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
    for (let t = 0; t < 30 && !(await portOpen(s.ws)); t++) await sleep(1000)
    console.log(`${s.name}: демон ${s.ws} ${await portOpen(s.ws) ? 'поднят' : 'НЕ поднялся'}`)
  }
}

export function down () {
  let out = ''
  try { out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }) } catch {}
  for (let k = 0; k <= 10; k++) {
    const port = WS0 + k
    const line = out.split(/\r?\n/).map(l => l.trim().split(/\s+/)).find(m => m.length >= 5 && m[3] === 'LISTENING' && m[1].endsWith(':' + port))
    if (line) { try { process.kill(Number(line[4])); console.log(`ws ${port}: погашен (pid ${line[4]})`) } catch {} }
  }
}

if (require.main === module) {
  const [cmd, n] = process.argv.slice(2)
  if (cmd === 'up') up(Number(n || 5)).then(() => process.exit(0), e => { console.error(e); process.exit(1) })
  else if (cmd === 'down') { down(); process.exit(0) } else { console.log('crowd-fleet.js up N | down'); process.exit(1) }
}
