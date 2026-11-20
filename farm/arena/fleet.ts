'use strict'
// Демоны бойцов: доп. бойцы слота (поднять, погасить), RPC к демону и проверка порта.
import { ROOT, sleep, log } from './context'
import { codeDir as slotCodeDir } from '../code-dir'
import { LAN, rcon } from './server'
import * as fs from 'fs'
import path = require('path')
import * as net from 'net'
const DIAG = path.join(ROOT, 'farm', 'diag')
import { spawn } from 'child_process'
import { listenerOwners, runInspection as run, windowsPortOwner, boundPortsQuery } from '../listeners'
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
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
    if (m.type === 'danger') { c.onDanger?.(m); return }
    if (m.type === 'wind_bid' || m.type === 'wind_bid_done') {
      const granted = c.onWindBid?.(m) === true
      if (m.type === 'wind_bid' && ws.readyState === 1) ws.send(JSON.stringify({ type: 'wind_bid_answer', id: m.id, granted }))
      return
    }
    if (pending.has(m.id)) m.ok ? settle(m.id, 'resolve', m.result) : settle(m.id, 'reject', new Error(m.error))
  })
  ws.on('close', () => failAll(`RPC ${url}: сокет закрыт`)); ws.on('error', () => {})
  // Демон с застрявшим циклом событий принимает TCP, но рукопожатие WebSocket не отвечает — без срока старт арены ждал вечно
  // (бой роя 24.10: час на «команды: 30 бойцов»).
  c.ready = new Promise<any>((res, rej) => { const t = setTimeout(() => { rej(new Error(`RPC ${url}: демон не отвечает 20 с`)); try { ws.terminate() } catch {} }, 20000); ws.once('open', () => { clearTimeout(t); res(undefined) }); ws.once('error', e => { clearTimeout(t); rej(e) }) })
  c.windRadio = onBid => {
    c.onWindBid = onBid
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'wind_radio' }))
  }
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
const quote = s => "'" + String(s).replaceAll("'", "''") + "'"
const ownerFile = s => path.join(s.mem, 'fleet-owner.json')
const commandHash = cmd => createHash('sha256').update(cmd, 'utf8').digest('hex')
const sameProcess = (a: ProcessRow, b?: ProcessRow) => !!b && a.pid === b.pid && a.born === b.born && a.cmd === b.cmd && a.exe === b.exe

const registeredPorts = i => EXTRA.map((_, k) => extra(i, k)).filter(s => fs.existsSync(ownerFile(s))).map(s => s.ws)

async function inspect (ports: number[]) {
  const [listeners, raw] = await Promise.all([listenerOwners(ports), run('powershell', ['-NoProfile', '-Command',
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
    return await Promise.race([c.ready.then(() => c.call('peek')).then(r => onLoopbackServer(r, LAN || 25600 + i)),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 5000) })])
  } catch { return false } finally { clearTimeout(timer); c.ws.terminate() }
}

const onLoopbackServer = (peek, port) => ['127.0.0.1', 'localhost', '::1'].some(host => peek.detail?.server === `${host}:${port}`)

/** Disconnect the old match before its clients receive the entire replacement Colosseum. */
export async function leaveForRestore (i: number, bots, confirm = rcon) {
  if (LAN || !bots.length) return 0
  return withRestoreClients(bots, async clients => (await detachFromPaper(i, clients, confirm)).exited)
}

type RestoreClient = { b: { name: string; ws: number }; c: ReturnType<typeof client> }

async function withRestoreClients<T> (bots, run: (clients: RestoreClient[]) => Promise<T>): Promise<T> {
  const clients = bots.map(b => ({ b, c: client(`ws://127.0.0.1:${b.ws}`) }))
  try { return await run(clients) } finally { for (const { c } of clients) c.ws.terminate() }
}

async function detachFromPaper (i: number, clients: RestoreClient[], confirm: typeof rcon, allowUnavailable = false) {
  if (!clients.length) throw new Error('восстановление: нет бойцов раунда')
  const probeDeadline = AbortSignal.timeout(20000)
  const probeTimeout = new Promise<never>((_, reject) => probeDeadline.addEventListener('abort', () => reject(new Error('демон не ответил при проверке сервера за 20 с')), { once: true }))
  const checked = await Promise.all(clients.map(async ({ b, c }) => {
    let peek
    try {
      peek = await Promise.race([probeTimeout, c.ready.then(() => c.call('peek'))])
    } catch (error) {
      if (!allowUnavailable) throw error
      return null
    }
    if (!onLoopbackServer(peek, 25600 + i) || typeof peek.state?.connected !== 'boolean') throw new Error(`${b.name}: демон не подтвердил сервер фермы`)
    return peek.state.connected as boolean
  }))
  const verified = clients.filter((_, index) => checked[index] !== null)
  if (!verified.length) throw new Error('восстановление: нет доступных бойцов раунда')
  const leaving = clients.filter((_, index) => checked[index] === true)
  const stop = new AbortController()
  const deadline = AbortSignal.any([stop.signal, AbortSignal.timeout(20000)]) // wall time, independent of accelerated arena timers
  const timeout = new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new Error('восстановление: не подтверждён выход бойцов за 20 с')), { once: true }))
  const rejoinable = new Set(clients.filter((_, index) => checked[index] === false))
  try {
    const departures = Promise.allSettled(leaving.map(async entry => {
      const { b, c } = entry
      if ((await c.call('disconnect', { reason: 'восстановление Колизея' }))?.ok !== true) throw new Error(`${b.name}: выход не подтверждён`)
      rejoinable.add(entry)
    }))
    if (!allowUnavailable) {
      const failure = (await Promise.race([timeout, departures])).find(result => result.status === 'rejected')
      if (failure) throw failure.reason
    }
    const wanted = new Set(clients.map(({ b }) => b.name))
    // All clients share one RCON stream. Read one complete roster per attempt,
    // after the disconnects, instead of interleaving a command per player.
    await Promise.race([timeout, (async () => {
      for (;;) {
        deadline.throwIfAborted()
        try {
          const reply = String(await confirm(i, 'list')).trim()
          const match = /^There are (\d+) of a max of \d+ players online:\s*(.*)$/s.exec(reply)
          if (match) {
            const names = match[2].split(',').map(n => n.trim()).filter(Boolean)
            if (names.length === Number(match[1]) && new Set(names).size === names.length && names.every(n => /^\w{1,16}$/.test(n) && !wanted.has(n))) return
          }
        } catch (e) {
          if (!/ECONNABORTED|ECONNRESET|EPIPE|rcon (closed|timeout)/i.test(String(e))) throw e
        }
        await sleep(200)
      }
    })()])
    // Paper proves departure even if a quit reply was lost. Only reuse a socket
    // whose previous quit completed, so a late handler cannot evict the new body.
    if (allowUnavailable) await Promise.race([timeout, departures]).catch(() => {})
    if (!rejoinable.size) throw new Error('восстановление: нет доступных бойцов раунда')
    return { exited: leaving.length, verified: verified.filter(entry => rejoinable.has(entry)) }
  } catch (error) {
    stop.abort()
    // Restore only sessions verified online before this attempt. connect is
    // idempotent for a body that never left.
    if (leaving.length) {
      const restored = new Set()
      const expired = AbortSignal.timeout(20000)
      await Promise.race([new Promise<void>(resolve => expired.addEventListener('abort', () => resolve(), { once: true })),
        Promise.allSettled(leaving.map(async ({ b, c }) => {
          if ((await c.call('connect')).state?.connected === true) restored.add(b.name)
        }))])
      const missing = leaving.filter(({ b }) => !restored.has(b.name))
      if (missing.length) throw new Error(`${error}; не подтвердили обратный вход: ${missing.map(({ b }) => b.name).join(', ')}`)
    }
    throw error
  } finally { stop.abort() }
}

// Use the same verified control sockets on both sides of the clone. Fight RPC wrappers
// may skip commands while a bot is climbing; those wrappers do not own the session.
export async function restoreRoundRoster (i: number, bots, confirm: typeof rcon, rebuild: () => Promise<void>, report: (s: string) => void) {
  if (LAN) throw new Error('переподключение раунда доступно только на ферме')
  return withRestoreClients(bots, async clients => {
    const { exited, verified } = await detachFromPaper(i, clients, confirm, true)
    report(`до восстановления Колизея вышли бойцы раунда (${exited})`)
    const joined = new Set<string>()
    try { await rebuild() } finally {
      // A sequential warm login of 40 took 38 wall seconds on slot 31. Bound
      // simultaneous chunk loads and give the group one shared wall deadline.
      const deadline = AbortSignal.timeout(60000)
      const pending = verified.slice()
      const join = async () => {
        while (!deadline.aborted) {
          const entry = pending.shift()
          if (!entry) return
          const { b, c } = entry
          try { if ((await c.call('connect')).state?.connected === true) joined.add(b.name) } catch {}
        }
      }
      const workers = () => Promise.all(Array.from({ length: Math.min(4, pending.length) }, join))
      await Promise.race([new Promise<void>(resolve => deadline.addEventListener('abort', () => resolve(), { once: true })), (async () => {
        await workers()
        pending.push(...verified.filter(({ b }) => !joined.has(b.name)))
        await workers()
      })()])
      const missing = clients.filter(({ b }) => !joined.has(b.name)).map(({ b }) => b.name)
      report(`после восстановления Колизея вошли бойцы ${joined.size}/${clients.length}${missing.length ? '; не вошли: ' + missing.join(', ') : ''}`)
    }
    return new Set(joined)
  })
}

const baseActors = i => [{ name: `NeuroFarm${i}`, ws: 8800 + i }, { name: `NeuroFarm${i}b`, ws: 8900 + i }]

export async function discover (i): Promise<Actor[]> {
  const snapshot = await inspect(registeredPorts(i)), bases = await Promise.all(baseActors(i).map(async s => await onServer(s, i) ? s : null))
  return [...bases.filter(Boolean), ...ownedExtras(i, snapshot)].map(s => ({ name: s.name, ws: s.ws }))
}

async function mutate (rows: ProcessRow[], action: string) {
  if (!rows.length) return 0
  // Hash keeps 102 exact command identities below Windows' command-line limit.
  const expected = rows.map(p => ({ pid: p.pid, born: p.born, hash: commandHash(p.cmd), ports: p.ports }))
  const result = await run('powershell', ['-NoProfile', '-Command', `$done=0; ${windowsPortOwner}
  $rows=ConvertFrom-Json ${quote(JSON.stringify(expected))}; $ports=@($rows | ForEach-Object { $_.ports } | Where-Object { $_ } | Sort-Object -Unique)
  $bound=if ($ports.Count) { ${boundPortsQuery} }
  Invoke-FarmPortOwners $ports @($bound) { param($owners)
  foreach ($r in $rows) { try {
    $p=Get-Process -Id $r.pid -ErrorAction Stop; if ($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $r.born) { continue }
    $c=Get-CimInstance Win32_Process -Filter ("ProcessId="+$r.pid); $h=[System.Security.Cryptography.SHA256]::Create();
    $hash=([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$c.CommandLine)))).Replace('-','').ToLowerInvariant(); $h.Dispose(); if ($hash -ne $r.hash) { continue }
    if (@($r.ports | Where-Object { $_ -and $owners[[int]$_] -ne $r.pid }).Count) { continue }
    $p=Get-Process -Id $r.pid -ErrorAction Stop; if ($p.StartTime.ToUniversalTime().Ticks.ToString() -ne $r.born) { continue }
    ${action}; $done++
  } catch {} }; Write-Output $done }`])
  return Number(result.trim()) || 0
}

export async function up (i, n) {
  if (!Number.isInteger(n) || n < 0 || n > EXTRA.length) throw new Error(`бойцов 0..${EXTRA.length}`)
  const cwd = codeDir(i)
  for (let k = 0; k < n; k++) {
    const s = extra(i, k)
    const [wsOpen, viewerOpen, ports] = await Promise.all([portOpen(s.ws), portOpen(s.viewer), listenerOwners([s.ws, s.viewer])])
    if (!ports) throw new Error(`${s.name}: не удалось проверить слушающие порты`)
    if (wsOpen || ports.has(s.ws)) {
      if (!ownedExtras(i, await inspect([s.ws])).some(o => o.ws === s.ws)) throw new Error(`${s.name}: порт ${s.ws} занят чужим или неподтверждённым процессом`)
      log(`${s.name}: уже ${s.ws}`); continue
    }
    if (viewerOpen || ports.has(s.viewer)) throw new Error(`${s.name}: viewer-порт ${s.viewer} уже занят`)
    fs.mkdirSync(s.mem, { recursive: true })
    const out = fs.openSync(path.join(ROOT, 'farm', `daemon-ffa-${s.name}.out.log`), 'w')
    const env = { ...process.env, ND_WS_PORT: String(s.ws), MC_USERNAME: s.name, MC_PORT: String(LAN || 25600 + i), ND_VIEWER_PORT: String(s.viewer), ND_MEMORY_DIR: s.mem,
      // При падении от нехватки памяти — отчёт Node и один снимок кучи (что заняло память; стека JS в отчёте OOM нет) в farm/diag:
      // демон стенда 29 упал за 155 с без следа (29.10, 4 ГБ — синхронный разгон). Предел 2 ГБ (обычно куча ≤ 0.6 ГБ) — снимок
      // вдвое меньше. Свой NODE_OPTIONS вызывающего идёт последним и перекрывает.
      NODE_OPTIONS: `--report-on-fatalerror --report-directory=${DIAG} --heapsnapshot-near-heap-limit=1 --diagnostic-dir=${DIAG} --max-old-space-size=2048 ${process.env.NODE_OPTIONS || ''}`.trim() }
    const title = `nd-fleet-${i}-${s.name}-${s.ws}-${randomBytes(16).toString('hex')}`
    fs.mkdirSync(DIAG, { recursive: true })
    const p = spawn(process.execPath, [`--title=${title}`, path.join(cwd, 'src', 'index.js')], { cwd, env, detached: true, stdio: ['ignore', out, out], windowsHide: true })
    await new Promise<void>((resolve, reject) => { p.once('spawn', resolve); p.once('error', reject) })
    p.unref()
    for (let t = 0; t < 30 && !(await portOpen(s.ws)); t++) await sleep(1000)
    const snapshot = await inspect([s.ws]), row = snapshot.processes.get(p.pid)
    if (!row || snapshot.listeners.get(s.ws) !== p.pid || !row.cmd.includes(`--title=${title} `) || row.exe.toLowerCase() !== process.execPath.toLowerCase()) {
      p.kill(); throw new Error(`${s.name}: не подтверждён процесс запущенного демона`)
    }
    try { fs.writeFileSync(ownerFile(s), JSON.stringify({ ...row, slot: i, name: s.name, ws: s.ws, title })) } catch (e) { p.kill(); throw e }
    await mutate([{ ...row, ports: [] }], "$p.PriorityClass = 'BelowNormal'")
    log(`${s.name}: демон ${s.ws} ✓ (${path.basename(cwd)})`)
  }
}
export async function down (i) {
  const count = await mutate(ownedExtras(i, await inspect(registeredPorts(i))), 'Stop-Process -InputObject $p -ErrorAction Stop')
  log(`слот ${i}: остановлено подтверждённых демонов ${count}; неподтверждённые процессы не трогал`)
  return count
}

// Человек играет на арене (пользователь 22.10: «когда я играю на арене, можно дать ботам обычный приоритет и все ядра»): сервер
// слота и демоны бойцов — обычный приоритет и все ядра; людей нет — обратно щадящий режим (ниже обычного, ядра из
// farm/limits.json). Под нагрузкой игры щадящий режим ронял физику ботов до 4–10 тиков/с, и боты стояли (стенд 22.10).
// Без ожидания цикла событий: netstat и powershell — в фоне.
export async function boost (i, on): Promise<number> {
  const ports = [...registeredPorts(i), ...baseActors(i).map(s => s.ws), ...(!LAN ? [25600 + i, 25700 + i] : [])]
  const snapshot = await inspect(ports), rows: ProcessRow[] = ownedExtras(i, snapshot)
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
