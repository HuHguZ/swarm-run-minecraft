'use strict'
// Демоны бойцов: доп. бойцы слота (поднять, погасить), RPC к демону и проверка порта.
import { ROOT, sleep, log } from './context'
import { codeDir as slotCodeDir } from '../code-dir'
import { LAN } from './server'
import * as fs from 'fs'
import path = require('path')
import * as net from 'net'
import { spawn, execFile, execFileSync } from 'child_process'
import * as os from 'os'
const WebSocket = require(path.join(ROOT, 'daemon', 'node_modules', 'ws'))

// До 24 бойцов на слот буквами c..z, дальше — двумя буквами aa..cz (10.10: «30 на 30», затем «40 на 40» — до 102 сверх <i> и <i>b).
export const EXTRA = [...'cdefghijklmnopqrstuvwxyz', ...[...'abc'].flatMap(p => [...'abcdefghijklmnopqrstuvwxyz'].map(c => p + c))]
// Порты доп. бойцов — общие для всех слотов (8961…, viewer 3261…); два стенда разом — свои базы: FFA_WS_BASE, FFA_VIEWER_BASE
// (поток «тайники» 21.10: слот 30 — 9200…, viewer 3600…).
const WS_BASE = Number(process.env.FFA_WS_BASE) || 8961
const VIEWER_BASE = Number(process.env.FFA_VIEWER_BASE) || 3261
export const extra = (i, k) => ({ name: `NeuroFarm${i}${EXTRA[k]}`, ws: WS_BASE + k, viewer: VIEWER_BASE + k, mem: path.join(ROOT, 'farm', `memory-${i}${EXTRA[k]}`) })
export const portOpen = port => new Promise<any>(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })

// RPC к демону: у каждого вызова свой срок (его игровое время + 30 с), обрыв сокета отвергает всё ожидающее — иначе
// умерший демон держал вечно и тех, кто ждал его (обмен, бросок ветром; ревью 13.10).
export function client (url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map()
  const c: any = { ws }
  const settle = (rid, fn, value) => { const p = pending.get(rid); if (!p) return; pending.delete(rid); clearTimeout(p.timer); p[fn](value) }
  const failAll = (why) => { for (const rid of [...pending.keys()]) settle(rid, 'reject', new Error(why)) }
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.type === 'danger') { if (c.onDanger) c.onDanger(m); return } if (!pending.has(m.id)) return; m.ok ? settle(m.id, 'resolve', m.result) : settle(m.id, 'reject', new Error(m.error)) })
  ws.on('close', () => failAll(`RPC ${url}: сокет закрыт`)); ws.on('error', () => {})
  c.ready = new Promise<any>((res, rej) => { ws.once('open', res); ws.once('error', rej) })
  c.call = (method, params: any = {}) => new Promise<any>((resolve, reject) => {
    const rid = ++id, budget = (Number.isFinite(params?.timeoutSeconds) ? params.timeoutSeconds : 60) * 1000 + 30000
    pending.set(rid, { resolve, reject, timer: setTimeout(() => settle(rid, 'reject', new Error(`RPC ${method}: нет ответа ${Math.round(budget / 1000)} с`)), budget) })
    try { ws.send(JSON.stringify({ id: rid, method, params })) } catch (e: any) { settle(rid, 'reject', e) }
  })
  return c
}

function codeDir (i) {
  let code = process.env.FFA_CODE || null
  if (!code) try { code = JSON.parse(fs.readFileSync(path.join(ROOT, 'farm', 'slots.json'), 'utf8')).slots?.[i]?.code || null } catch {}
  return slotCodeDir(code)
}
export async function up (i, n) {
  const cwd = codeDir(i)
  for (let k = 0; k < n; k++) {
    const s = extra(i, k)
    if (await portOpen(s.ws)) { log(`${s.name}: уже ${s.ws}`); continue }
    fs.mkdirSync(s.mem, { recursive: true })
    const out = fs.openSync(path.join(ROOT, 'farm', `daemon-ffa-${s.name}.out.log`), 'w')
    const env = { ...process.env, ND_WS_PORT: String(s.ws), MC_USERNAME: s.name, MC_PORT: String(LAN || 25600 + i), ND_VIEWER_PORT: String(s.viewer), ND_MEMORY_DIR: s.mem }
    const p = spawn(process.execPath, ['src/index.js'], { cwd, env, detached: true, stdio: ['ignore', out, out], windowsHide: true })
    p.unref()
    try { (require('os') as typeof import('os')).setPriority(p.pid, (require('os') as typeof import('os')).constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
    for (let t = 0; t < 30 && !(await portOpen(s.ws)); t++) await sleep(1000)
    log(`${s.name}: демон ${s.ws} ${await portOpen(s.ws) ? '✓' : 'НЕ поднялся'} (${path.basename(cwd)})`)
  }
}
export function down (i) {
  for (let k = 0; k < EXTRA.length; k++) {
    const s = extra(i, k)
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
      const line = out.split(/\r?\n/).map(l => l.trim().split(/\s+/)).find(m => m.length >= 5 && m[3] === 'LISTENING' && m[1].endsWith(':' + s.ws))
      if (line) { process.kill(Number(line[4])); log(`${s.name}: погашен`) }
    } catch {}
  }
}

// Человек играет на арене (пользователь 22.10: «когда я играю на арене, можно дать ботам обычный приоритет и все ядра»): сервер
// слота и демоны бойцов — обычный приоритет и все ядра; людей нет — обратно щадящий режим (ниже обычного, ядра из
// farm/limits.json). Под нагрузкой игры щадящий режим ронял физику ботов до 4–10 тиков/с, и боты стояли (стенд 22.10).
// Без ожидания цикла событий: netstat и powershell — в фоне.
export async function boost (i, on): Promise<number> {
  const ports = new Set([25600 + i, 8800 + i, 8900 + i, ...EXTRA.map((_, k) => extra(i, k).ws)])
  const run = (cmd, args) => new Promise<string>(res => execFile(cmd, args, { encoding: 'utf8', windowsHide: true }, (e, out) => res(e ? '' : String(out))))
  const pids = new Set<number>()
  for (const l of (await run('netstat', ['-ano', '-p', 'TCP'])).split(/\r?\n/)) {
    const m = l.trim().split(/\s+/)
    if (m.length >= 5 && m[3] === 'LISTENING' && ports.has(Number(m[1].slice(m[1].lastIndexOf(':') + 1)))) pids.add(Number(m[4]))
  }
  if (!pids.size) return 0
  let limits: any = {}
  try { limits = JSON.parse(fs.readFileSync(path.join(ROOT, 'farm', 'limits.json'), 'utf8')) } catch {}
  const all = 2 ** Math.min(32, os.cpus().length) - 1
  const mask = on || limits.cores === 'all' ? all : all & 0xFFFF0000
  await run('powershell', ['-NoProfile', '-Command', `foreach ($id in ${[...pids].join(',')}) { try { $p = Get-Process -Id $id; $p.PriorityClass = '${on ? 'Normal' : 'BelowNormal'}'; $p.ProcessorAffinity = [IntPtr][long]${mask} } catch {} }`])
  return pids.size
}
