'use strict'
import { DIST_ROOT } from '../../daemon/src/paths'
// Сервер слота: команды RCON (одно соединение на слот) или чатом распорядителя в LAN-мире пользователя, постройка
// Колизея в LAN и игровое время драйвера на ускоренном сервере.
import { ROOT, sleep, log } from './context'
import * as fs from 'fs'
import path = require('path')
import * as net from 'net'

function props (i) { return fs.readFileSync(path.join(ROOT, 'farm', `server-${i}`, 'server.properties'), 'utf8') }
const prop = (p, k) => (p.match(new RegExp('^' + k.replace('.', '\\.') + '=(.*)$', 'm')) || [])[1]
// Одно соединение RCON на слот (колизей 10.10: соединение на команду — 3754 сокета в TIME_WAIT за три постройки по
// ~1800 команд, EADDRINUSE и падение гонки). Ответ — по номеру пакета; оборвалось — следующая команда откроет заново.
const pkt = (id, type, body) => { const b = Buffer.from(body, 'utf8'); const buf = Buffer.alloc(14 + b.length); buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12); return buf }
const RCON: Record<number, any> = {}
function rconConn (i) {
  if (RCON[i]?.ok) return RCON[i].ready
  const p = props(i)
  const port = Number(prop(p, 'rcon.port')); const pass = prop(p, 'rcon.password')
  const s: any = { ok: true, wait: new Map(), id: 10, acc: Buffer.alloc(0) }
  RCON[i] = s
  s.sock = net.connect(port, '127.0.0.1', () => s.sock.write(pkt(1, 3, pass)))
  s.ready = new Promise<any>((resolve, reject) => s.wait.set(1, { resolve: (_b, id) => id === -1 ? reject(new Error('rcon auth failed')) : resolve(s), reject }))
  s.sock.on('data', d => {
    s.acc = Buffer.concat([s.acc, d])
    while (s.acc.length >= 4) {
      const len = s.acc.readInt32LE(0)
      if (s.acc.length < len + 4) break
      const id = s.acc.readInt32LE(4); const body = s.acc.slice(12, len + 2).toString('utf8')
      s.acc = s.acc.slice(len + 4)
      const key = id === -1 ? 1 : id
      const w = s.wait.get(key); if (w) { s.wait.delete(key); w.resolve(body, id) }
    }
  })
  const fail = e => { s.ok = false; for (const w of s.wait.values()) w.reject(e); s.wait.clear() }
  s.sock.on('error', fail)
  s.sock.on('close', () => fail(new Error('rcon closed')))
  s.ready.catch(() => {})
  return s.ready
}
// LAN-мир пользователя (ARMS_LAN=<порт>, 10.10): RCON нет — команды шлёт бот-распорядитель чатом (в LAN с читами все —
// операторы, анти-спам их не кикает). Ответ ждём только у list и data get (системным сообщением); весь чат распорядителя —
// в свой журнал: по нему смерти, как по latest.log сервера фермы.
export const LAN = Number(process.env.ARMS_LAN || 0)
export const LAN_NAME = process.env.ARMS_LAN_CMD || 'NeuroArena'
export const LAN_LOG = path.join(ROOT, 'farm', 'results', 'lan-chat.log')
let lanBot: Promise<any> | null = null
const lanWait: any[] = []
function lanConn () {
  if (lanBot) return lanBot
  lanBot = new Promise<any>((resolve, reject) => {
    const mf = require(path.join(ROOT, 'daemon', 'node_modules', 'mineflayer'))
    const bot = mf.createBot({ host: '127.0.0.1', port: LAN, username: LAN_NAME, version: '1.21.11', auth: 'offline' })
    bot.once('spawn', () => resolve(bot))
    bot.on('messagestr', (m) => {
      try { fs.appendFileSync(LAN_LOG, `[${new Date().toTimeString().slice(0, 8)}] [Server thread/INFO]: ${m}\n`) } catch {}
      const k = lanWait.findIndex(w => w.re.test(m)); if (k >= 0) lanWait.splice(k, 1)[0].resolve(m)
    })
    bot.on('kicked', r => log('распорядитель кикнут: ' + JSON.stringify(r)))
    bot.on('end', () => { lanBot = null })
    bot.on('error', e => { log('распорядитель: ' + e.message); lanBot = null; reject(e) })
  })
  return lanBot
}
let lanAt = 0
export async function lanCmd (cmd, timeoutMs = 3000, re: RegExp | null = null) {
  const bot = await lanConn()
  const due = Math.max(lanAt + 8, Date.now()); lanAt = due; if (due > Date.now()) await sleep(due - Date.now()) // ≤ 125 команд/с
  const ent = /^data get entity (\S+)/.exec(cmd)
  re = re || (/^list/.test(cmd) ? /players online/ : ent ? new RegExp(`^(${ent[1]} has the following|No entity was found|Found no elements)`) : null)
  if (!re) { bot.chat('/' + cmd); return '' }
  return new Promise<any>(resolve => {
    const w = { re, resolve }; lanWait.push(w); bot.chat('/' + cmd)
    setTimeout(() => { const k = lanWait.indexOf(w); if (k >= 0) { lanWait.splice(k, 1); resolve('') } }, timeoutMs)
  })
}
// Сокет закрылся или сервер не ответил (под нагрузкой 30 ботов) — ещё раз по новому соединению: без повтора первая же
// осечка на старте роняла драйвер (бой роя 24.10: «rcon timeout», «rcon closed» — по 10 минут простоя).
export function rcon (i, cmd, timeoutMs = 8000) {
  return rconOnce(i, cmd, timeoutMs).catch(e => /rcon (closed|timeout)|ECONNRESET|EPIPE/.test(String(e?.message)) ? rconOnce(i, cmd, timeoutMs) : Promise.reject(e))
}
function rconOnce (i, cmd, timeoutMs) {
  if (LAN) return lanCmd(cmd, Math.min(timeoutMs, 3000))
  return rconConn(i).then((s: any) => new Promise<any>((resolve, reject) => {
    const id = ++s.id
    const t = setTimeout(() => { s.wait.delete(id); reject(new Error('rcon timeout')) }, timeoutMs)
    s.wait.set(id, { resolve: (b) => { clearTimeout(t); resolve(b) }, reject: (e) => { clearTimeout(t); reject(e) } })
    s.sock.write(pkt(id, 2, cmd))
  }))
}

export async function buildLan (who) {
  if (!LAN) throw new Error('нужен ARMS_LAN=<порт>')
  await lanConn()
  let [X0, Y0, Z0] = (process.env.ARMS_POS || '').split(/\s+/).map(Number)
  if (!process.env.ARMS_POS) {
    const ps = await lanCmd(`data get entity ${who} Pos`)
    const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(String(ps)); if (!m) throw new Error(`нет позиции ${who}: ${ps}`)
    X0 = Math.floor(+m[1]); Y0 = Number(process.env.ARMS_Y || 200); Z0 = Math.floor(+m[3])
  }
  log(`Колизей в LAN ${LAN}: ${X0} ${Y0} ${Z0}`)
  await lanCmd('gamerule log_admin_commands false')
  process.env.ARENA_COLOS_FLAG = process.env.ARENA_COLOS_FLAG || path.join(ROOT, 'farm', 'results', 'lan-colosseum.json')
  const CZB = require(path.join(DIST_ROOT, 'daemon', 'arena', 'build-colosseum'))
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const call = async (m, p) => {
    if (m === 'say') { await lanCmd(String(p.text).replace(/^\//, '')); return {} }
    if (m === 'ask') { const l = await lanCmd(String(p.command).replace(/^\//, ''), p.ms || 3000, new RegExp(esc(p.match))); return { detail: { lines: l ? [l] : [] } } }
  }
  await CZB.run({ call, log, X: X0, Y: Y0, Z: Z0, R: 24, ceilH: 16, who: LAN_NAME, rules: false, rate: Number(process.env.ARENA_COLOS_RATE || 120) })
  fs.writeFileSync(path.join(ROOT, 'farm', 'results', 'lan-pos.txt'), `${X0} ${Y0} ${Z0}`)
  log(`готово: ARMS_POS="${X0} ${Y0} ${Z0}"`)
}

// Ускоренный сервер (12.10: «тикрейт сделай больше, чтобы быстрее шло»; TICK_RATE>20 или GAME_CLOCK=1): таймеры, sleep и
// Date.now драйвера — в игровом времени, иначе паузы перед уворотом, перезарядки и опросы растягиваются в тиках во столько
// же раз. Темп — прирост gametime (RCON) к стене, раз в 1 с; интервалы берут темп при создании (первый замер — до боя).
// new Date() в журнале — по-прежнему стенное.
export async function gameClock (i) {
  const realNow = Date.now; const realSet = setTimeout; const realInt = setInterval
  const gt = async () => { const m = /(\d+)/.exec(await rcon(i, 'time query gametime', 3000).catch(() => '') || ''); return m ? [realNow(), +m[1]] : null }
  const a = await gt(); await sleep(2000); const b = await gt()
  let speed = a && b ? Math.max(0.5, (b[1] - a[1]) * 50 / (b[0] - a[0])) : 1
  let base = realNow(); let virt = base; let last = b
  const now = () => virt + (realNow() - base) * speed
  Date.now = now
  ;(global as any).setTimeout = (fn, ms = 0, ...r) => realSet(fn, ms / speed, ...r)
  ;(global as any).setInterval = (fn, ms = 0, ...r) => realInt(fn, ms / speed, ...r)
  realInt(async () => {
    const t = await gt(); if (!t) return
    if (last && t[0] > last[0]) { virt = now(); base = realNow(); speed = speed * 0.7 + Math.max(0.5, (t[1] - last[1]) * 50 / (t[0] - last[0])) * 0.3 }
    last = t
  }, 1000)
  log(`игровое время драйвера: темп ×${speed.toFixed(2)}`)
  realInt(() => log(`темп сервера ×${speed.toFixed(2)}`), 60000)
}
