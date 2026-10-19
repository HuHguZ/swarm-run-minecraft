'use strict'
// Демоны бойцов: доп. бойцы слота (поднять, погасить), RPC к демону и проверка порта.
import { ROOT, sleep, log } from './context'
import { codeDir as slotCodeDir } from '../code-dir'
import { LAN } from './server'
import * as fs from 'fs'
import path = require('path')
import * as net from 'net'
import { spawn, execFileSync } from 'child_process'
const WebSocket = require(path.join(ROOT, 'daemon', 'node_modules', 'ws'))

// До 24 бойцов на слот буквами c..z, дальше — двумя буквами aa..cz (10.10: «30 на 30», затем «40 на 40» — до 102 сверх <i> и <i>b).
export const EXTRA = [...'cdefghijklmnopqrstuvwxyz', ...[...'abc'].flatMap(p => [...'abcdefghijklmnopqrstuvwxyz'].map(c => p + c))]
export const extra = (i, k) => ({ name: `NeuroFarm${i}${EXTRA[k]}`, ws: 8961 + k, viewer: 3261 + k, mem: path.join(ROOT, 'farm', `memory-${i}${EXTRA[k]}`) })
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
