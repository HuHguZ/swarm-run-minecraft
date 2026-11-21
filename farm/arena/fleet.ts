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
      const result = c.onWindBid?.(m)
      if (m.type === 'wind_bid') {
        const answer = granted => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'wind_bid_answer', id: m.id, granted: granted === true })) }
        if (result instanceof Promise) void result.then(answer, () => answer(false))
        else answer(result)
      }
      return
    }
    if (pending.has(m.id)) m.ok ? settle(m.id, 'resolve', m.result) : settle(m.id, 'reject', Object.assign(new Error(m.error),
      typeof m.code === 'string' && { code: m.code }, m.notStarted === true && { notStarted: true }))
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

type RestoreClient = { b: { name: string; ws: number }; c: ReturnType<typeof client> }

async function paperRoster (i: number, confirm: typeof rcon, names: string[]): Promise<Set<string>> {
  const reply = String(await confirm(i, 'list')).trim()
  const list = /^There are (\d+) of a max of \d+ players online:\s*(.*)$/s.exec(reply)
  if (!list) throw new Error('Paper не подтвердил полный список игроков')
  const listed = list[2].split(',').map(n => n.trim()).filter(Boolean)
  const complete = (players: string[]) => players.length === +list[1] && new Set(players).size === players.length
  if (listed.every(n => /^\w{1,16}$/.test(n)) && complete(listed)) return new Set(listed)
  // Paper abbreviates /list with "..." on the 40-player Colosseum. RCON can concatenate
  // multiple named data replies without separators, or truncate a very large response.
  const data = String(await confirm(i, 'execute as @a run data get entity @s playerGameType')).trim()
  const row = /(\w{1,16}) has the following entity data: [0-3]/g
  const players = Array.from(data.matchAll(row), match => match[1])
  if (!data.replace(row, '').trim() && complete(players)) return new Set(players)
  const present = new Set<string>()
  for (const name of names) {
    const answer = String(await confirm(i, `execute if entity @a[name=${name}]`)).trim()
    if (/^Test passed(?:[.,] count: 1)?$/i.test(answer)) present.add(name)
    else if (!/^Test failed(?:[.,] count: 0)?$/i.test(answer)) throw new Error(`Paper не подтвердил список игроков: ${name}`)
  }
  return present
}

// Cross-dimension teleport removes the old Paper chunk subscriptions without closing the game socket.
// A named, dimension-scoped read confirms the spectator even if the teleport reply was lost or ambiguous.
export async function restoreRoundRoster (i: number, bots, confirm: typeof rcon, rebuild: () => Promise<void>,
  report: (s: string) => void, home: { x: number; y: number; z: number }) {
  if (LAN || !bots.length || ![home.x, home.y, home.z].every(Number.isFinite)) throw new Error('неверная площадка восстановления раунда')
  const slots = new Map([...baseActors(i), ...EXTRA.map((_, k) => extra(i, k))].map(b => [b.name, b.ws]))
  if (bots.some(b => slots.get(b.name) !== b.ws) || new Set(bots.map(b => b.name)).size !== bots.length) throw new Error('не подтверждён состав слота')
  const clients: RestoreClient[] = bots.map(b => ({ b, c: client(`ws://127.0.0.1:${b.ws}`) }))
  try {
    const checked = await Promise.all(clients.map(async ({ b, c }) => {
      let peek
      try { await c.ready; peek = await c.call('peek', { timeoutSeconds: 0 }) } catch { return null }
      if (!onLoopbackServer(peek, 25600 + i) || typeof peek.state?.connected !== 'boolean') throw new Error(`${b.name}: демон не подтвердил сервер фермы`)
      return peek.state.connected as boolean
    }))
    const verified = clients.filter((_, k) => checked[k] !== null)
    if (!verified.length) throw new Error('восстановление: нет доступных бойцов раунда')
    const knownOnline = new Set(clients.filter((_, k) => checked[k] === true).map(({ b }) => b.name))
    // A failed control socket is tolerable only if Paper also says its body is absent.
    const onlineNames = () => paperRoster(i, confirm, clients.map(({ b }) => b.name))
    const before = await onlineNames()
    for (const { b } of clients) if (before.has(b.name) && !knownOnline.has(b.name)) throw new Error(`${b.name}: онлайн без подтверждения демона`)
    await Promise.all(verified.filter(({ b }) => before.has(b.name)).map(({ c }) => c.call('stop')))

    const move = async (name: string, dimension: string, at: string) => {
      await confirm(i, `gamemode spectator ${name}`)
      await confirm(i, `execute as ${name} if entity @s[gamemode=spectator] in minecraft:${dimension} run tp @s ${at}`).catch(() => {})
      const receipt = String(await confirm(i, `execute as ${name} at @s if dimension minecraft:${dimension} run data get entity @s playerGameType`)).trim()
      return receipt === `${name} has the following entity data: 3`
    }
    const attempted = new Set<string>(), parked = new Set<string>(), joined = new Set<string>()
    const homeAt = `${home.x} ${home.y} ${home.z}`
    let rebuildError: unknown
    let rebuilt = false
    try {
      for (const { b } of verified) if (before.has(b.name)) {
        attempted.add(b.name) // Includes a move whose reply is subsequently lost.
        if (await move(b.name, 'the_nether', '0.5 128 0.5')) parked.add(b.name)
        else if ((await onlineNames()).has(b.name)) {
          throw new Error(`${b.name}: Paper не подтвердил парковку в Незере`)
        }
      }
      const current = await onlineNames()
      for (const { b } of clients) if (current.has(b.name) && !parked.has(b.name)) throw new Error(`${b.name}: появился во время парковки`)
      report(`до восстановления Колизея в Незере бойцов: ${[...parked].filter(n => current.has(n)).length}`)
      await rebuild()
      rebuilt = true
    } catch (e) { rebuildError = e }
    // A failed clone also returns its parked bodies. Only an actually absent, verified session needs a login.
    const returning = verified.filter(({ b }) => rebuilt || attempted.has(b.name))
    const online = await onlineNames().catch(() => null)
    const offline = returning.filter(({ b }) => online && !online.has(b.name))
    const connected = new Set<string>()
    const deadline = AbortSignal.timeout(60000)
    const join = async () => {
      while (!deadline.aborted) {
        const entry = offline.shift()
        if (!entry) return
        try { if ((await entry.c.call('connect', { timeoutSeconds: 0 })).state?.connected === true) connected.add(entry.b.name) } catch {}
      }
    }
    if (offline.length) await Promise.all(Array.from({ length: Math.min(4, offline.length) }, join))
    for (const { b } of returning) {
      if (online && !online.has(b.name) && !connected.has(b.name)) continue
      try {
        if (!await move(b.name, 'overworld', homeAt)) throw new Error('возврат не подтверждён')
        joined.add(b.name)
      } catch (e) { report(`⚠ ${b.name}: ${e}`) }
    }
    report(`после восстановления Колизея вернулись бойцы ${joined.size}/${clients.length}`)
    // Never start another round with a connected fighter stranded in the parking dimension.
    const missing = returning.filter(({ b }) => !joined.has(b.name)).map(({ b }) => b.name)
    if (missing.length) {
      const stillOnline = await onlineNames().catch(() => null)
      if (!stillOnline || missing.some(n => stillOnline.has(n)) || !joined.size) {
        throw new Error(`${rebuildError ? String(rebuildError) + '; ' : ''}не подтвердили возврат в обычный мир: ${missing.join(', ')}`)
      }
    }
    if (!rebuilt) throw rebuildError
    return joined
  } finally { for (const { c } of clients) c.ws.terminate() }
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
export async function down (i, names?: ReadonlySet<string>) {
  const owned = ownedExtras(i, await inspect(registeredPorts(i)))
  const count = await mutate(names ? owned.filter(b => names.has(b.name)) : owned, 'Stop-Process -InputObject $p -ErrorAction Stop')
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
