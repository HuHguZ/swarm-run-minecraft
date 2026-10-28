'use strict'
// Демоны бойцов: доп. бойцы слота (поднять, погасить), RPC к демону и проверка порта.
import { ROOT, sleep, log } from './context'
import { codeDir as slotCodeDir } from '../code-dir'
import { LAN, rcon } from './server'
import * as fs from 'fs'
import path = require('path')
import * as net from 'net'
import { spawn, execFile } from 'child_process'
import * as os from 'os'
import { randomBytes, createHash } from 'crypto'
const WebSocket = require(path.join(ROOT, 'daemon', 'node_modules', 'ws'))

// До 24 бойцов на слот буквами c..z, дальше — двумя буквами aa..cz (10.10: «30 на 30», затем «40 на 40» — до 102 сверх <i> и <i>b).
export const EXTRA = [...'cdefghijklmnopqrstuvwxyz', ...[...'abc'].flatMap(p => [...'abcdefghijklmnopqrstuvwxyz'].map(c => p + c))]
// Порты доп. бойцов — общие для всех слотов (8961…, viewer 3261…); два стенда разом — свои базы: FFA_WS_BASE, FFA_VIEWER_BASE
// (поток «тайники» 21.10: слот 30 — 9200…, viewer 3600…).
const WS_BASE = Number(process.env.FFA_WS_BASE) || 8961
const VIEWER_BASE = Number(process.env.FFA_VIEWER_BASE) || 3261
export const extra = (i, k) => ({ name: `NeuroFarm${i}${EXTRA[k]}`, ws: WS_BASE + k, viewer: VIEWER_BASE + k, mem: path.join(ROOT, 'farm', `memory-${i}${EXTRA[k]}`) })
export const portOpen = port => new Promise<any>(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)); s.setTimeout(1500, () => { s.destroy(); resolve(false) }) })

// RPC к демону: у каждого вызова свой срок (его игровое время + 30 с), обрыв сокета отвергает всё ожидающее — иначе
// умерший демон держал вечно и тех, кто ждал его (обмен, бросок ветром; ревью 13.10).
export function client (url) {
  const ws = new WebSocket(url); let id = 0; const pending = new Map()
  const c: any = { ws }
  const settle = (rid, fn, value) => { const p = pending.get(rid); if (!p) return; pending.delete(rid); clearTimeout(p.timer); p[fn](value) }
  const failAll = (why) => { for (const rid of [...pending.keys()]) settle(rid, 'reject', new Error(why)) }
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.type === 'danger') { if (c.onDanger) c.onDanger(m); return } if (!pending.has(m.id)) return; m.ok ? settle(m.id, 'resolve', m.result) : settle(m.id, 'reject', new Error(m.error)) })
  ws.on('close', () => failAll(`RPC ${url}: сокет закрыт`)); ws.on('error', () => {})
  // Демон с застрявшим циклом событий принимает TCP, но рукопожатие WebSocket не отвечает — без срока старт арены ждал вечно
  // (бой роя 24.10: час на «команды: 30 бойцов»).
  c.ready = new Promise<any>((res, rej) => { const t = setTimeout(() => { rej(new Error(`RPC ${url}: демон не отвечает 20 с`)); try { ws.terminate() } catch {} }, 20000); ws.once('open', () => { clearTimeout(t); res(undefined) }); ws.once('error', e => { clearTimeout(t); rej(e) }) })
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

type Actor = { name: string; ws: number; mem?: string }
type ProcessRow = { pid: number; born: string; cmd: string; exe: string; ports?: number[] }
const run = (cmd, args) => new Promise<string>(res => execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 }, (e, out) => res(e ? '' : String(out))))
const quote = s => "'" + String(s).replaceAll("'", "''") + "'"
const ownerFile = s => path.join(s.mem, 'fleet-owner.json')
const commandHash = cmd => createHash('sha256').update(cmd, 'utf8').digest('hex')
const sameProcess = (a: ProcessRow, b?: ProcessRow) => !!b && a.pid === b.pid && a.born === b.born && a.cmd === b.cmd && a.exe === b.exe

async function listening () {
  const tcp = await run('netstat', ['-ano', '-p', 'TCP'])
  if (!tcp.trim()) return null
  const listeners = new Map<number, number>()
  for (const l of tcp.split(/\r?\n/)) {
    const m = l.trim().split(/\s+/)
    if (m.length >= 5 && m[3] === 'LISTENING') {
      const port = Number(m[1].slice(m[1].lastIndexOf(':') + 1)), pid = Number(m[4]), old = listeners.get(port)
      listeners.set(port, old === undefined || old === pid ? pid : 0)
    }
  }
  return listeners
}

async function inspect () {
  const [listeners, raw] = await Promise.all([listening(), run('powershell', ['-NoProfile', '-Command',
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='java.exe'" | ForEach-Object { try { $p = Get-Process -Id $_.ProcessId -ErrorAction Stop; [PSCustomObject]@{pid=$_.ProcessId; born=$p.StartTime.ToUniversalTime().Ticks.ToString(); cmd=$_.CommandLine; exe=$_.ExecutablePath} } catch {} }) | ConvertTo-Json -Compress`])])
  const processes = new Map<number, ProcessRow>()
  try { for (const p of [].concat(JSON.parse(raw))) if (Number.isInteger(p?.pid) && /^\d+$/.test(p.born) && p.cmd && p.exe) processes.set(p.pid, p) } catch {}
  return { listeners: listeners || new Map<number, number>(), processes }
}

function ownedExtras (i, snapshot) {
  return EXTRA.flatMap((_, k) => {
    const s = extra(i, k)
    try {
      const o = JSON.parse(fs.readFileSync(ownerFile(s), 'utf8')), p = snapshot.processes.get(o.pid)
      if (o.slot === i && o.name === s.name && o.ws === s.ws && snapshot.listeners.get(s.ws) === o.pid &&
        new RegExp(`^nd-fleet-${i}-${s.name}-${s.ws}-[a-f0-9]{32}$`).test(o.title) &&
        o.cmd.includes(`--title=${o.title} `) && o.exe.toLowerCase() === process.execPath.toLowerCase() && sameProcess(o, p)) return [{ ...s, ...p, ports: [s.ws] }]
    } catch {}
    return []
  })
}

async function onServer (s: Actor, i) {
  if (!await portOpen(s.ws)) return false
  const c = client(`ws://127.0.0.1:${s.ws}`)
  let timer
  try {
    return await Promise.race([c.ready.then(() => c.call('peek')).then(r => ['127.0.0.1', 'localhost', '::1'].some(host => r.detail?.server === `${host}:${LAN || 25600 + i}`)),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000) })])
  } catch { return false } finally { clearTimeout(timer); c.ws.terminate() }
}

const baseActors = i => [{ name: `NeuroFarm${i}`, ws: 8800 + i }, { name: `NeuroFarm${i}b`, ws: 8900 + i }]

export async function discover (i): Promise<Actor[]> {
  const snapshot = await inspect(), bases = await Promise.all(baseActors(i).map(async s => await onServer(s, i) ? s : null))
  return [...bases.filter(Boolean), ...ownedExtras(i, snapshot)].map(s => ({ name: s.name, ws: s.ws }))
}

async function mutate (rows: ProcessRow[], action: string) {
  if (!rows.length) return 0
  // Hash keeps 102 exact command identities below Windows' command-line limit.
  const expected = rows.map(p => ({ pid: p.pid, born: p.born, hash: commandHash(p.cmd), ports: p.ports }))
  const result = await run('powershell', ['-NoProfile', '-Command', `$done=0; foreach ($r in (ConvertFrom-Json ${quote(JSON.stringify(expected))})) { try {
    $p=Get-Process -Id $r.pid -ErrorAction Stop; if ($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $r.born) { continue }
    $c=Get-CimInstance Win32_Process -Filter ("ProcessId="+$r.pid); $h=[System.Security.Cryptography.SHA256]::Create();
    $hash=([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$c.CommandLine)))).Replace('-','').ToLowerInvariant(); $h.Dispose(); if ($hash -ne $r.hash) { continue }
    $valid=$true; foreach ($port in $r.ports) { $ls=@(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue); if (!$ls.Count -or @($ls | Where-Object OwningProcess -ne $r.pid).Count) { $valid=$false } }; if (!$valid) { continue }
    $p=Get-Process -Id $r.pid -ErrorAction Stop; if ($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $r.born) { continue }
    ${action}; $done++
  } catch {} }; Write-Output $done`])
  return Number(result.trim()) || 0
}

export async function up (i, n) {
  if (!Number.isInteger(n) || n < 0 || n > EXTRA.length) throw new Error(`бойцов 0..${EXTRA.length}`)
  const cwd = codeDir(i)
  for (let k = 0; k < n; k++) {
    const s = extra(i, k)
    const [wsOpen, viewerOpen] = await Promise.all([portOpen(s.ws), portOpen(s.viewer)]), ports = await listening()
    if (!ports) throw new Error(`${s.name}: не удалось проверить слушающие порты`)
    if (wsOpen || ports.has(s.ws)) {
      if (!ownedExtras(i, await inspect()).some(o => o.ws === s.ws)) throw new Error(`${s.name}: порт ${s.ws} занят чужим или неподтверждённым процессом`)
      log(`${s.name}: уже ${s.ws}`); continue
    }
    if (viewerOpen || ports.has(s.viewer)) throw new Error(`${s.name}: viewer-порт ${s.viewer} уже занят`)
    fs.mkdirSync(s.mem, { recursive: true })
    const out = fs.openSync(path.join(ROOT, 'farm', `daemon-ffa-${s.name}.out.log`), 'w')
    const env = { ...process.env, ND_WS_PORT: String(s.ws), MC_USERNAME: s.name, MC_PORT: String(LAN || 25600 + i), ND_VIEWER_PORT: String(s.viewer), ND_MEMORY_DIR: s.mem }
    const title = `nd-fleet-${i}-${s.name}-${s.ws}-${randomBytes(16).toString('hex')}`
    const p = spawn(process.execPath, [`--title=${title}`, path.join(cwd, 'src', 'index.js')], { cwd, env, detached: true, stdio: ['ignore', out, out], windowsHide: true })
    await new Promise<void>((resolve, reject) => { p.once('spawn', resolve); p.once('error', reject) })
    p.unref()
    for (let t = 0; t < 30 && !(await portOpen(s.ws)); t++) await sleep(1000)
    const snapshot = await inspect(), row = snapshot.processes.get(p.pid)
    if (!row || snapshot.listeners.get(s.ws) !== p.pid || !row.cmd.includes(`--title=${title} `) || row.exe.toLowerCase() !== process.execPath.toLowerCase()) {
      p.kill(); throw new Error(`${s.name}: не подтверждён процесс запущенного демона`)
    }
    try { fs.writeFileSync(ownerFile(s), JSON.stringify({ ...row, slot: i, name: s.name, ws: s.ws, title })) } catch (e) { p.kill(); throw e }
    await mutate([{ ...row, ports: [] }], "$p.PriorityClass = 'BelowNormal'")
    log(`${s.name}: демон ${s.ws} ✓ (${path.basename(cwd)})`)
  }
}
export async function down (i) {
  const count = await mutate(ownedExtras(i, await inspect()), 'Stop-Process -InputObject $p -ErrorAction Stop')
  log(`слот ${i}: остановлено подтверждённых демонов ${count}; неподтверждённые процессы не трогал`)
  return count
}

// Человек играет на арене (пользователь 22.10: «когда я играю на арене, можно дать ботам обычный приоритет и все ядра»): сервер
// слота и демоны бойцов — обычный приоритет и все ядра; людей нет — обратно щадящий режим (ниже обычного, ядра из
// farm/limits.json). Под нагрузкой игры щадящий режим ронял физику ботов до 4–10 тиков/с, и боты стояли (стенд 22.10).
// Без ожидания цикла событий: netstat и powershell — в фоне.
export async function boost (i, on): Promise<number> {
  const snapshot = await inspect(), rows: ProcessRow[] = ownedExtras(i, snapshot)
  for (const s of baseActors(i)) {
    const p = snapshot.processes.get(snapshot.listeners.get(s.ws))
    if (p && path.basename(p.exe).toLowerCase() === 'node.exe' && await onServer(s, i)) rows.push({ ...p, ports: [s.ws] })
  }
  const mc = 25600 + i, rc = 25700 + i, server = snapshot.processes.get(snapshot.listeners.get(mc))
  if (!LAN && server && path.basename(server.exe).toLowerCase() === 'java.exe' && snapshot.listeners.get(rc) === server.pid &&
    /There are \d+ of a max of \d+ players online/.test(await rcon(i, 'list').catch(() => ''))) rows.push({ ...server, ports: [mc, rc] })
  if (!rows.length) return 0
  let limits: any = {}
  try { limits = JSON.parse(fs.readFileSync(path.join(ROOT, 'farm', 'limits.json'), 'utf8')) } catch {}
  const all = 2 ** Math.min(32, os.cpus().length) - 1
  const mask = on || limits.cores === 'all' ? all : all & 0xFFFF0000
  return mutate(rows, `$p.PriorityClass = '${on ? 'Normal' : 'BelowNormal'}'; $p.ProcessorAffinity = [IntPtr][long]${mask}`)
}
