'use strict'
// Камера боя на ферме (s7b 06.10, п.8 плана: «записать 1–2 показательных боя»). Третий клиент NeuroCam<i> в режиме
// наблюдателя (gamemode spectator — команды только на ферме: arms-guard не пускает на чужие порты) висит над
// бойцами и смотрит на середину между ними; кадры — prismarine-viewer (веб) + puppeteer, затем ffmpeg → mp4.
// Бойцы наблюдателя не видят (ServerPlayer.broadcastToPlayer: наблюдатель — только наблюдателям).
//   SLOT=27 CAM_SECONDS=90 CAM_OUT=../research/claude-1006/pvp-video/frames-1 node arena-cam.js
// Ждёт, пока оба бойца (CAM_A/CAM_B, по умолчанию NeuroFarm<i> и NeuroFarm<i>b) в 40 бл. друг от друга, пишет кадры
// CAM_SECONDS реального времени (или до CAM_STOP_FILE), потом собирает mp4 (CAM_MP4).
const fs = require('fs')
const path = require('path')
const net = require('net')
const { execFileSync } = require('child_process')
const mineflayer = require('mineflayer')
const { farmOnly } = require('./arms-guard')

const SLOT = Number(process.env.SLOT || 27)
const MC_PORT = 25600 + SLOT
const RCON_PORT = 25700 + SLOT
const VIEW_PORT = Number(process.env.CAM_VIEW_PORT || 3300 + SLOT)
const A = process.env.CAM_A || `NeuroFarm${SLOT}`
const B = process.env.CAM_B || `NeuroFarm${SLOT}b`
const SECONDS = Number(process.env.CAM_SECONDS || 90)
const FPS = Number(process.env.CAM_FPS || 10)
const W = Number(process.env.CAM_W || 960)
const H = Number(process.env.CAM_H || 540)
const OUT = path.resolve(process.env.CAM_OUT || `../research/claude-1006/pvp-video/frames-${Date.now()}`)
const MP4 = process.env.CAM_MP4 || OUT + '.mp4'
const DIST = Number(process.env.CAM_DIST || 8)
const UP = Number(process.env.CAM_UP || 4)
const BOX = process.env.CAM_BOX === '0' ? null : (process.env.CAM_BOX || '200.5,200.5,22').split(',').map(Number)
const log = (...a: any[]) => console.log(`[${new Date().toTimeString().slice(0, 8)}] cam:`, ...a)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function rconPass () {
  const p = fs.readFileSync(path.join(__dirname, '..', 'farm', `server-${SLOT}`, 'server.properties'), 'utf8')
  return /^rcon\.password=(.*)$/m.exec(p)![1].trim()
}
function rcon (cmd: string): Promise<string> {
  const pass = rconPass()
  return new Promise((resolve, reject) => {
    const pkt = (id: number, type: number, body: string) => { const b = Buffer.from(body, 'utf8'); const buf = Buffer.alloc(14 + b.length); buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12); return buf }
    const sock = net.connect(RCON_PORT, '127.0.0.1', () => sock.write(pkt(1, 3, pass)))
    let acc = Buffer.alloc(0); let authed = false
    const t = setTimeout(() => { sock.destroy(); reject(new Error('rcon timeout')) }, 5000)
    sock.on('data', (d: Buffer) => {
      acc = Buffer.concat([acc, d])
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0)
        if (acc.length < len + 4) break
        const id = acc.readInt32LE(4); const body = acc.slice(12, len + 2).toString('utf8'); acc = acc.slice(len + 4)
        if (!authed) { if (id === -1) { clearTimeout(t); sock.end(); return reject(new Error('rcon auth')) } authed = true; sock.write(pkt(2, 2, cmd)) } else { clearTimeout(t); sock.end(); return resolve(body) }
      }
    })
    sock.on('error', (e: Error) => { clearTimeout(t); reject(e) })
  })
}
// Позиция игрока — через data get (RCON), камера своим клиентом бойцов не видит.
async function posOf (name: string) {
  const r = await rcon(`data get entity ${name} Pos`).catch(() => '')
  const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(r)
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null
}

async function main () {
  farmOnly({ mc: [MC_PORT] })
  fs.mkdirSync(OUT, { recursive: true })
  const bot = mineflayer.createBot({ host: '127.0.0.1', port: MC_PORT, username: `NeuroCam${SLOT}`, version: '1.21.11', auth: 'offline' })
  await new Promise<void>((res, rej) => { bot.once('spawn', () => res()); bot.once('error', rej); bot.once('kicked', (r: any) => rej(new Error('kicked ' + JSON.stringify(r)))) })
  bot.physicsEnabled = false
  await rcon(`gamemode spectator NeuroCam${SLOT}`)
  log('в игре, наблюдатель')
  const { mineflayer: viewer } = require('prismarine-viewer')
  viewer(require('./src/viewer-adapter').viewerBot(bot), { port: VIEW_PORT, firstPerson: true, viewDistance: 6 })
  const puppeteer = require('puppeteer')
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] })
  const page = await browser.newPage()
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 })
  await page.goto(`http://127.0.0.1:${VIEW_PORT}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  // Ждать бой: оба на сервере и ближе 40 бл.
  let a = null; let b = null
  for (let i = 0; i < 600; i++) {
    a = await posOf(A); b = await posOf(B)
    if (a && b && Math.hypot(a.x - b.x, a.z - b.z) < 40) break
    await sleep(500)
  }
  if (!a || !b) throw new Error('бойцов нет')
  let orbit = Math.atan2(a.x - b.x, a.z - b.z) + Math.PI / 2
  const place = async () => {
    a = (await posOf(A)) || a; b = (await posOf(B)) || b
    const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2 + 1; const mz = (a.z + b.z) / 2
    const spread = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
    const dist = DIST + spread * 0.6
    orbit += 0.004
    let cx = mx + Math.sin(orbit) * dist; let cz = mz + Math.cos(orbit) * dist; const cy = my + UP + spread * 0.15
    // Внутри арены (CAM_BOX=cx,cz,r — центр и полуширина поля): из-за стекла бой не видно.
    if (BOX) { cx = Math.max(BOX[0] - BOX[2], Math.min(BOX[0] + BOX[2], cx)); cz = Math.max(BOX[1] - BOX[2], Math.min(BOX[1] + BOX[2], cz)) }
    const yaw = Math.atan2(-(mx - cx), (mz - cz)) * 180 / Math.PI
    const pitch = Math.atan2(cy - my, Math.hypot(mx - cx, mz - cz)) * 180 / Math.PI
    await rcon(`tp NeuroCam${SLOT} ${cx.toFixed(2)} ${cy.toFixed(2)} ${cz.toFixed(2)} ${yaw.toFixed(1)} ${pitch.toFixed(1)}`).catch(() => {})
  }
  await place()
  await sleep(6000) // первые чанки в странице
  const stopFile = process.env.CAM_STOP_FILE
  const t0 = Date.now()
  let n = 0
  let placing: Promise<void> | null = null
  while (Date.now() - t0 < SECONDS * 1000 && !(stopFile && fs.existsSync(stopFile))) {
    const tf = Date.now()
    if (!placing) placing = place().finally(() => { placing = null })
    await page.screenshot({ path: path.join(OUT, `f${String(n++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 })
    const wait = 1000 / FPS - (Date.now() - tf)
    if (wait > 0) await sleep(wait)
  }
  const real = (Date.now() - t0) / 1000
  const fps = Math.max(1, Math.round(n / real * 10) / 10)
  log(`кадров ${n} за ${real.toFixed(1)} с (≈${fps} к/с)`)
  await browser.close().catch(() => {})
  try { bot.viewer && bot.viewer.close() } catch {}
  bot.quit()
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(OUT, 'f%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(process.env.CAM_CRF || 30), '-preset', 'veryfast', MP4], { stdio: 'inherit' })
  log('mp4:', MP4, (fs.statSync(MP4).size / 1e6).toFixed(1), 'МБ')
  process.exit(0)
}
main().catch(e => { console.error('cam:', e.message); process.exit(1) })
