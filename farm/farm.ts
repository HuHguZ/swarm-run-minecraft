'use strict'
// Ферма тестовых миров: N серверов Paper 1.21.11, на каждом свой бот-оператор
// со своим демоном. Одна сцена этапа (daemon/try-lab-*.js и т.п.) идёт сразу
// на всех мирах, итоги сводятся в одну таблицу — данных в N раз быстрее.
//
// Раскладка слота i (1..32):
//   сервер   farm/server-<i>   игра 25600+i, RCON 25700+i (пароль в его server.properties)
//   бот      NeuroFarm<i>, оператор (ops.json пишется до старта, офлайн-UUID)
//   демон    ws 8800+i, viewer 3100+i, память farm/memory-<i>
// Шаблон сервера — server-twin (jar, библиотеки, настройки); миры — свои.
//
//   node farm/farm.js up 8                      8 миров с сидом двойника прохождения
//   node farm/farm.js up 8 --random             у каждого свой случайный сид (разные карты)
//   node farm/farm.js up 8 --seeds 1,2,3        сиды по кругу
//   node farm/farm.js up 8 --pool [файл]         хорошие сиды: farm/seeds/good-v2.json (с лавой) или v1, без повтора
//   node farm/farm.js up 4 --from 9             слоты 9..12
//   node farm/farm.js up 4 --tick-rate 100      целевые 100 тиков/с; TICK_RATE=100 — то же (умолчание 20)
//   node farm/farm.js up 8 --fresh              стереть миры и память слотов (чистый старт)
//   node farm/farm.js up 1 --lockstep           пошаговый мир (ND_LOCKSTEP=1 — то же): тик идёт, только когда боты
//                                               обсчитали предыдущие (FarmLockstep.java); демоны и сцены слота — тоже
//                                               в этом режиме; окно ND_LOCKSTEP_WINDOW (2), клапан ND_LOCKSTEP_STALL_MS (2000)
//   node farm/farm.js up 8 --world server-twin  миры — копия чужой папки (тот сервер должен
//                                               стоять или быть в save-off; сид — из level.dat)
//   node farm/farm.js status
//   node farm/farm.js tick 1-4 rate 100         RCON: скорость серверов (query / freeze / unfreeze / step 40)
//   node farm/farm.js tick --all query         состояние тиков всех поднятых слотов
//   node farm/farm.js daemons 1-10              перезапустить только тела, миры не трогать
//   node farm/farm.js rcon all "time set day"   команда на все поднятые слоты (или 3, 1-4)
//   node farm/farm.js run try-lab-pearls.js --slots 1-8 --tag pearls-a STYLE=duel -- 2
//        сцена на каждом слоте (cwd daemon/), env: ND_WS, MC_USERNAME, MC_PORT,
//        ND_SERVER_LOG, LAB_OUT=farm/results/<tag>/slot-<i>.jsonl, плюс KEY=VAL;
//        аргументы после «--» — сцене. Ждёт всех, печатает сводку (report).
//        --tick-rate / TICK_RATE — скорость перед сценой; бюджеты MINUTES — игровые минуты.
//   node farm/farm.js report <tag>              сводка по итогам (ok, числа: среднее/мин/макс)
//   node farm/farm.js kill-runs <tag>           оборвать сцены партии
//   node farm/farm.js down [слоты]              штатно: RCON stop (мир сохраняется), демоны — стоп
//   node farm/farm.js nice                      приоритет/ядра фермы — поднятым серверам и демонам
//   node farm/farm.js up 1 --from 8 --reup …    то же, но слоты диапазона сперва down под замком up (серии сид за сидом)
//   node farm/farm.js snapshot s1d-a            заморозить собранный код демона и сцен для серии: копия *.js/*.json и
//                                               data/ в .daemon-<имя> (рядом с daemon/), node_modules — ссылкой
//   node farm/farm.js up 1 --from 21 --code s1d-a   демон слота — из снимка (запомнится: daemons и run слота — тоже);
//                                               daemons 21 --code <имя> — сменить снимок; --code live — живое дерево;
//                                               snapshot <имя> --drop — удалить снимок (ссылку node_modules — первой)
// Лимит миров разом (вместе с server-run 25569) и ядра — farm/limits.json: играет пользователь или нет.
// Долгие дела (up, run) запускать в фоне с выводом в файл — не через | tail.
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const crypto = require('crypto')
const { spawn, execFileSync } = require('child_process')
const { tickRate, tickAction, checkedReply, configureTick, runEnv, disablePacketLimiter } = require('./tick-control')
const { acceleratedDigArgs } = require('./accelerated-dig')

const ROOT = path.resolve(__dirname, '..')
const FARM = __dirname
const DAEMON = path.join(ROOT, 'daemon')
// Снимок кода для серии (07.10: «контрольная» серия шла на 7–11 разных версиях кода — другие агенты правили общее дерево,
// сравнения «до/после» недоказательны). Снимок лежит рядом с daemon/ (та же глубина: пути __dirname/.. ведут в корень).
const codeDir = name => !name || name === 'live' ? DAEMON : path.join(ROOT, '.daemon-' + name)
const slotCode = i => readState().slots?.[i]?.code || null
function cmdSnapshot (args) {
  const name = args._[0]
  if (!name || !/^[\w.-]+$/.test(name) || name === 'live') throw new Error('snapshot: имя снимка — буквы, цифры, «.-_» (не live)')
  const dest = codeDir(name)
  if (args.drop) {
    // node_modules снимка — ссылка на daemon/node_modules: сначала снять ссылку, иначе рекурсивное удаление уйдёт по ней.
    const link = path.join(dest, 'node_modules')
    try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link) } catch {}
    if (fs.existsSync(link)) throw new Error(`${link} — не ссылка, не удаляю`)
    fs.rmSync(dest, { recursive: true, force: true })
    return log(`снимок ${name} удалён`)
  }
  if (fs.existsSync(dest)) throw new Error(`снимок ${name} уже есть (${dest}) — новое имя или snapshot ${name} --drop`)
  let files = 0
  const copy = (from, to, all) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name)
      if (e.isDirectory()) {
        if (from === DAEMON && /^(node_modules|test|castle-shots|colosseum-shots)$/.test(e.name)) continue
        copy(a, b, all || e.name === 'data')
      } else if (all || /\.(js|cjs|mjs|json)$/.test(e.name)) { fs.mkdirSync(to, { recursive: true }); fs.copyFileSync(a, b); files++ }
    }
  }
  copy(DAEMON, dest, false)
  fs.symlinkSync(path.join(DAEMON, 'node_modules'), path.join(dest, 'node_modules'), 'junction')
  let head = ''; try { head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch {}
  fs.writeFileSync(path.join(dest, 'SNAPSHOT.json'), JSON.stringify({ name, at: new Date().toISOString(), head, files }, null, 2))
  log(`снимок ${name}: ${files} файлов → ${dest} (git ${head} + незакоммиченное дерево на момент снимка)`)
}
const TEMPLATE = path.join(ROOT, 'server-twin')
const JAVA = 'C:\\Users\\user\\AppData\\Roaming\\.minecraft\\runtime\\java-runtime-delta\\windows\\java-runtime-delta\\bin\\java.exe'
const JAR = 'paper-1.21.11-132.jar'
const TWIN_SEED = '5709596442716969862'
const STATE = path.join(FARM, 'slots.json')
const MAX_SLOTS = 32 // 29.09: 17–32 — миры со случайными сидами (бастион по типам)
// 29.09 вечер: пользователь играет на этом же компьютере, и 32 мира фермы клали его игру.
// Теперь миров разом не больше MAX_UP (считая server-run), приоритет ниже обычного и только
// ядра второго CCD (логические 16–31, L3 32 МБ) — CCD0 с 3D V-Cache (0–15, 96 МБ) остаётся игре.
// Серверы, демоны и сцены — дети farm.js и наследуют приоритет и маску ядер.
// Переключатель — farm/limits.json, его правит координатор по словам пользователя:
//   играет    { "maxUp": 4,  "cores": "ccd1" }
//   не играет { "maxUp": 28, "cores": "all" }   (30.09 00:20: «вырубил игру, нагружай максимально»)
// Нет файла — щадящий режим.
function readLimits () { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'limits.json'), 'utf8')) } catch { return {} as Record<string, any> } }
const LIMITS = readLimits()
const MAX_UP = Number(process.env.FARM_MAX_UP || LIMITS.maxUp || 4)
const AFFINITY = process.env.FARM_AFFINITY || (LIMITS.cores === 'all' ? '0xFFFFFFFF' : '0xFFFF0000')
const MAIN_PORTS = [25569, 8769] // server-run и его демон — тоже в лимите и в nice

const slot = i => ({
  i,
  dir: path.join(FARM, `server-${i}`),
  mc: 25600 + i,
  rcon: 25700 + i,
  ws: 8800 + i,
  viewer: 3100 + i,
  name: `NeuroFarm${i}`,
  mem: path.join(FARM, `memory-${i}`)
})
const sleep = ms => new Promise<any>(r => setTimeout(r, ms))
const log = (...a) => console.log(`[${new Date().toTimeString().slice(0, 8)}]`, ...a)

function readState () { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} as Record<string, any> } }
function writeState (s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)) }

// Офлайн-UUID игрока (UUID v3 от «OfflinePlayer:<имя>») — как у сервера без онлайн-режима.
function offlineUuid (name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest()
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  const x = h.toString('hex')
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`
}

function portOpen (port, host = '127.0.0.1') {
  return new Promise<any>(resolve => {
    const s = net.connect(port, host)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
    s.setTimeout(1500, () => { s.destroy(); resolve(false) })
  })
}
async function waitPort (port, want, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (await portOpen(port) === want) return true; await sleep(1000) }
  return false
}

// Кто слушает порт (netstat) — убивать только владельца своего порта.
// Снимок один на всё дело: execFileSync стоит цикл событий, и параллельные
// portOpen в это время ловят свой таймаут 1.5 с раньше, чем «connect» —
// сервер «не слушает» (2026-09-28: down 1-13 не остановил слоты 1–8).
function listeners () {
  const map = new Map()
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().split(/\s+/)
      if (m.length >= 5 && m[3] === 'LISTENING') map.set(Number(m[1].slice(m[1].lastIndexOf(':') + 1)), Number(m[4]))
    }
  } catch {}
  return map
}
function pidOnPort (port) { return listeners().get(port) || 0 }
// Приоритет «ниже обычного» и ядра AFFINITY (FARM_AFFINITY=off — не трогать ядра).
function gentle (pid = process.pid) {
  try { os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {}
  if (AFFINITY === 'off') return
  try { execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)}).ProcessorAffinity = [IntPtr][long]${BigInt(AFFINITY)}`], { stdio: 'ignore', windowsHide: true }) } catch {}
}
// limits.json "prio": "1-7" — слоты, чувствительные к такту (бой с драконом): сервер и демон с обычным приоритетом,
// остальные — ниже обычного. Повторяется после up/daemons, иначе перезапуск вернул бы «ниже обычного» (наследуется от farm.js).
function prioSlots () {
  const out = new Set()
  for (const part of String(readLimits().prio || '').split(',').filter(Boolean)) {
    const [x, y] = part.split('-').map(Number)
    for (let i = x; i <= (y || x); i++) out.add(i)
  }
  return out
}
const slotOfPort = p => (p > 25600 && p <= 25600 + MAX_SLOTS) ? p - 25600 : (p > 8800 && p <= 8800 + MAX_SLOTS) ? p - 8800 : (p > 8900 && p <= 8900 + MAX_SLOTS) ? p - 8900 : 0
function applyPrio () {
  const prio = prioSlots()
  if (!prio.size) return []
  const done = []
  for (const [p, pid] of listeners()) {
    if (!prio.has(slotOfPort(p))) continue
    try { os.setPriority(pid, os.constants.priority.PRIORITY_NORMAL); done.push(pid) } catch {}
  }
  return done
}
const farmPort = p => slotOfPort(p) !== 0 || MAIN_PORTS.includes(p)
function worldsUp (lis) { return [...lis.keys()].filter(p => (p > 25600 && p <= 25600 + MAX_SLOTS) || p === 25569) }
function killPid (pid) { if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} } }
function cmdLine (pid) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8' }).trim()
  } catch { return '' }
}

function rmrf (p) { fs.rmSync(p, { recursive: true, force: true }) }
function copyDir (src, dst) { fs.cpSync(src, dst, { recursive: true, force: true }) }

function preparePacketLimiter (s) {
  const file = path.join(s.dir, 'config', 'paper-global.yml')
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const after = disablePacketLimiter(before)
  if (after === before) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, after)
  return { file, before }
}
async function reloadPaper (s, changed) {
  try { checkedReply('paper reload', await slotRcon(s, 'paper reload')) }
  catch (error) {
    if (changed?.file) fs.writeFileSync(changed.file, changed.before)
    throw error
  }
  log(`слот ${s.i}: packet-limiter отключён, Paper config обновлён`)
}
async function ensurePacketLimiter (s) {
  const changed = preparePacketLimiter(s)
  if (changed) await reloadPaper(s, changed)
}

function props (dir) {
  const f = path.join(dir, 'server.properties')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}
function propGet (text, k) { const m = new RegExp('^' + k.replace(/\./g, '\\.') + '=(.*)$', 'm').exec(text); return m ? m[1] : null }
function propSet (text, k, v) {
  const re = new RegExp('^' + k.replace(/\./g, '\\.') + '=.*$', 'm')
  return re.test(text) ? text.replace(re, `${k}=${v}`) : text + `\n${k}=${v}`
}

// ---------------------------------------------------------------- RCON
function rcon (port, pass, cmd, timeoutMs = 8000) {
  return new Promise<any>((resolve, reject) => {
    const pkt = (id, type, body) => {
      const b = Buffer.from(body, 'utf8')
      const buf = Buffer.alloc(14 + b.length)
      buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12)
      return buf
    }
    const sock = net.connect(port, '127.0.0.1', () => sock.write(pkt(1, 3, pass)))
    let acc = Buffer.alloc(0)
    let authed = false
    const t = setTimeout(() => { sock.destroy(); reject(new Error('rcon timeout')) }, timeoutMs)
    sock.on('data', d => {
      acc = Buffer.concat([acc, d])
      while (acc.length >= 4) {
        const len = acc.readInt32LE(0)
        if (acc.length < len + 4) break
        const id = acc.readInt32LE(4)
        const body = acc.slice(12, len + 2).toString('utf8')
        acc = acc.slice(len + 4)
        if (!authed) {
          if (id === -1) { clearTimeout(t); sock.end(); return reject(new Error('rcon auth failed')) }
          authed = true
          sock.write(pkt(2, 2, cmd))
        } else { clearTimeout(t); sock.end(); return resolve(body) }
      }
    })
    sock.on('error', e => { clearTimeout(t); reject(e) })
  })
}
function slotRcon (s, cmd) {
  const p = props(s.dir)
  return rcon(Number(propGet(p, 'rcon.port')), propGet(p, 'rcon.password'), cmd)
}

// ---------------------------------------------------------------- слоты
function parseSlots (arg, fallback) {
  if (!arg || arg === 'all') return fallback
  const out = new Set()
  for (const part of String(arg).split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) throw new Error('слоты: ' + arg)
    const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a
    for (let i = a; i <= b; i++) out.add(i)
  }
  return [...out].filter((i: any) => i >= 1 && i <= MAX_SLOTS).sort((x: any, y: any) => x - y)
}
function upSlots () { const st = readState(); return Object.keys(st.slots || {} as Record<string, any>).map(Number).sort((a, b) => a - b) }
function randomSeed () { return BigInt.asIntN(64, BigInt('0x' + crypto.randomBytes(8).toString('hex'))).toString() }

function prepareSlot (s, { seed, fresh, world }: any) {
  if (!fs.existsSync(path.join(s.dir, JAR))) {
    fs.mkdirSync(s.dir, { recursive: true })
    for (const f of [JAR, 'eula.txt', 'bukkit.yml', 'spigot.yml', 'commands.yml', 'help.yml', 'permissions.yml', 'server.properties']) {
      const src = path.join(TEMPLATE, f)
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(s.dir, f))
    }
    for (const d of ['libraries', 'versions', 'cache', 'config', 'plugins']) {
      const src = path.join(TEMPLATE, d)
      if (fs.existsSync(src)) copyDir(src, path.join(s.dir, d))
    }
    for (const f of ['banned-ips.json', 'banned-players.json', 'whitelist.json']) fs.writeFileSync(path.join(s.dir, f), '[]')
  }
  if (fresh || world) {
    for (const w of ['world', 'world_nether', 'world_the_end']) rmrf(path.join(s.dir, w))
    rmrf(s.mem)
  }
  if (world) {
    const from = path.isAbsolute(world) ? world : path.join(ROOT, world)
    for (const w of ['world', 'world_nether', 'world_the_end']) {
      const src = path.join(from, w)
      if (fs.existsSync(src)) copyDir(src, path.join(s.dir, w))
    }
    for (const lock of ['world/session.lock', 'world_nether/session.lock', 'world_the_end/session.lock']) rmrf(path.join(s.dir, lock))
  }
  fs.mkdirSync(s.mem, { recursive: true })
  let p = props(s.dir) || props(TEMPLATE)
  const pass = propGet(p, 'rcon.password') && propGet(p, 'enable-rcon') === 'true' ? propGet(p, 'rcon.password') : crypto.randomBytes(12).toString('hex')
  const set = {
    'server-port': s.mc,
    'query.port': s.mc,
    'enable-rcon': 'true',
    'rcon.port': s.rcon,
    'rcon.password': pass,
    'broadcast-rcon-to-ops': 'false',
    'level-seed': seed,
    motd: `NeuroDown farm ${s.i}`,
    'max-players': Number(process.env.FARM_MAX_PLAYERS) || 6,
    // FARM_VIEW_DISTANCE (12.10, арена: Колизей 160×160 — с края до края дальше 8 чанков, боты не видели игрока).
    'view-distance': Number(process.env.FARM_VIEW_DISTANCE) || 8,
    'simulation-distance': 8,
    'spawn-protection': 0,
    'online-mode': 'false',
    'allow-flight': 'true',
    'pause-when-empty-seconds': -1
  }
  for (const [k, v] of Object.entries<any>(set)) p = propSet(p, k, v)
  fs.writeFileSync(path.join(s.dir, 'server.properties'), p)
  fs.writeFileSync(path.join(s.dir, 'ops.json'), JSON.stringify([{ uuid: offlineUuid(s.name), name: s.name, level: 4, bypassesPlayerLimit: false }], null, 2))
  return preparePacketLimiter(s)
}

async function startServer (s) {
  if (await portOpen(s.mc)) return log(`слот ${s.i}: сервер уже слушает ${s.mc}`)
  const out = fs.openSync(path.join(s.dir, 'console.out.log'), 'w')
  const err = fs.openSync(path.join(s.dir, 'console.err.log'), 'w')
  const p = spawn(JAVA, ['-Xms1G', '-Xmx3G', '-XX:+UseG1GC', '-Dfile.encoding=UTF-8', ...acceleratedDigArgs(JAVA, s.dir), '-jar', JAR, '--nogui'], { cwd: s.dir, detached: true, stdio: ['ignore', out, err], windowsHide: true })
  p.unref()
  log(`слот ${s.i}: java pid ${p.pid}, жду порт ${s.mc}`)
  return p.pid
}
// Пошаговый режим — свойство мира (агент сервера), его записывает up: демоны и сцены слота берут его отсюда.
const lockstepEnv = i => ({ ND_LOCKSTEP: readState().slots?.[i]?.lockstep ? '1' : '0' })
async function startDaemon (s, rate = readState().slots?.[s.i]?.tickRate ?? tickRate({} as Record<string, any>, process.env, LIMITS.tickRate)) {
  if (await portOpen(s.ws)) return log(`слот ${s.i}: демон уже слушает ${s.ws}`)
  const out = fs.openSync(path.join(FARM, `daemon-${s.i}.out.log`), 'w')
  const err = fs.openSync(path.join(FARM, `daemon-${s.i}.err.log`), 'w')
  const env = runEnv(process.env, { ND_WS_PORT: String(s.ws), MC_USERNAME: s.name, MC_PORT: String(s.mc), ND_VIEWER_PORT: String(s.viewer), ND_MEMORY_DIR: s.mem, ...lockstepEnv(s.i) }, rate)
  const cwd = codeDir(slotCode(s.i))
  if (cwd !== DAEMON) {
    if (!fs.existsSync(path.join(cwd, 'src', 'index.js'))) throw new Error(`слот ${s.i}: снимка кода ${cwd} нет`)
    log(`слот ${s.i}: демон из снимка ${path.basename(cwd)}`)
  }
  const p = spawn(process.execPath, ['src/index.js'], { cwd, env, detached: true, stdio: ['ignore', out, err], windowsHide: true })
  p.unref()
  return p.pid
}

// Лимит миров считается по слушающим портам, а сервер открывает порт через 10–60 с после старта: up из цикла
// down→up одного агента и чужой up проходили проверку оба (06.10 21:48 — 5 миров при maxUp 4 почти час).
// Поэтому up целиком — под общим замком фермы, второй up ждёт. Замок мёртвого процесса снимается.
const UP_LOCK = path.join(FARM, 'up.lock')
async function withUpLock (fn) {
  const until = Date.now() + 15 * 60000
  for (;;) {
    try { fs.mkdirSync(UP_LOCK); break } catch {}
    let pid = 0; try { pid = Number(fs.readFileSync(path.join(UP_LOCK, 'pid'), 'utf8')) } catch {}
    let alive = false; try { if (pid) { process.kill(pid, 0); alive = true } } catch {}
    let young = true; try { young = Date.now() - fs.statSync(UP_LOCK).mtimeMs < 60000 } catch {}
    if (!alive && (pid || !young)) { fs.rmSync(UP_LOCK, { recursive: true, force: true }); continue }
    if (Date.now() > until) throw new Error(`up: замок ${UP_LOCK} занят 15 мин (pid ${pid}) — другой up завис?`)
    await sleep(2000)
  }
  fs.writeFileSync(path.join(UP_LOCK, 'pid'), String(process.pid))
  try { return await fn() } finally { fs.rmSync(UP_LOCK, { recursive: true, force: true }) }
}

async function cmdUp (args) {
  const rate = tickRate(args, process.env, LIMITS.tickRate)
  if (args.lockstep) process.env.ND_LOCKSTEP = '1' // acceleratedDigArgs (агент сервера) читает env
  const lockstep = process.env.ND_LOCKSTEP === '1'
  const n = Number(args._[0] || 4)
  const from = Number(args.from || 1)
  const ids = []; for (let i = from; i < from + n && i <= MAX_SLOTS; i++) ids.push(i)
  const up = worldsUp(listeners())
  const extra = ids.filter(i => !up.includes(slot(i).mc)).length
  if (up.length + extra > MAX_UP) throw new Error(`лимит ${MAX_UP} миров разом (farm/limits.json — играет ли пользователь): уже подняты порты ${up.join(', ') || '—'}, просишь ещё ${extra}. Сначала down лишних.`)
  if (lockstep && extra < ids.length) throw new Error('--lockstep: сервер слота уже поднят, а режим задаётся агентом при старте — сначала down')
  if (args.code && !fs.existsSync(path.join(codeDir(args.code), 'src', 'index.js'))) throw new Error(`--code ${args.code}: снимка нет — сначала node farm/farm.js snapshot ${args.code}`)
  // --pool [файл] — хорошие сиды (farm/seeds/good-v1.json по умолчанию): случайные без повтора среди поднятых слотов
  // (решение пользователя 02.10: спидран пока тренируем только на хороших сидах). lava === false — пропустить.
  let seeds = args.seeds ? String(args.seeds).split(',') : null
  if (args.pool) {
    const v2 = path.join(__dirname, 'seeds', 'good-v2.json')
    const pf = typeof args.pool === 'string' ? args.pool : fs.existsSync(v2) ? v2 : path.join(__dirname, 'seeds', 'good-v1.json')
    const used = new Set(Object.values<any>((readState().slots) || {} as Record<string, any>).map(x => String(x && x.seed)))
    // good-v2 (portal-tech): lava — метры до годной лавы, false — нет в 200 м, null — не сканирован. Сперва проверенные.
    const rows = JSON.parse(fs.readFileSync(pf, 'utf8')).seeds.filter(x => x.lava !== false)
    const checked = rows.filter(x => typeof x.lava === 'number')
    const all = (checked.length >= ids.length ? checked : rows).map(x => String(x.seed))
    const fresh = all.filter(x => !used.has(x))
    const pick = (fresh.length >= ids.length ? fresh : all).slice()
    for (let k = pick.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [pick[k], pick[j]] = [pick[j], pick[k]] }
    seeds = pick.slice(0, ids.length)
    log(`пул ${path.basename(pf)}: ${all.length} сидов, взяты ${seeds.join(', ')}`)
  }
  const mine: Record<string, any> = {} as Record<string, any>; const reloadPackets = new Map()
  for (const [k, i] of ids.entries()) {
    const s = slot(i)
    const seed = args.random ? randomSeed() : seeds ? seeds[k % seeds.length] : (args.seed || TWIN_SEED)
    const changed = prepareSlot(s, { seed, fresh: !!args.fresh, world: args.world || null })
    if (changed && up.includes(s.mc)) reloadPackets.set(i, changed)
    mine[i] = { seed, since: new Date().toISOString(), world: args.world || null, tickRate: rate, ...(lockstep ? { lockstep: true } : {}), ...(args.code && args.code !== 'live' ? { code: args.code } : {}) }
  }
  // Чтение и запись slots.json — подряд, после долгой подготовки миров: параллельные up/down других слотов
  // (два потока серий) иначе затирали свои записи (rt-R6 03.10).
  const st = readState(); st.slots = Object.assign(st.slots || {} as Record<string, any>, mine)
  writeState(st)
  // Старт лесенкой: генерация спавна на всех сразу — пик CPU.
  for (const i of ids) { await startServer(slot(i)); await sleep(4000) }
  for (const i of ids) {
    const s = slot(i)
    const ok = await waitPort(s.mc, true, 300000)
    if (!ok) { log(`слот ${s.i}: сервер НЕ поднялся — смотри ${path.join(s.dir, 'console.out.log')}`); continue }
    if (!(await waitPort(s.rcon, true, 30000))) throw new Error(`слот ${s.i}: RCON ${s.rcon} не поднялся`)
    if (reloadPackets.has(i)) await reloadPaper(s, reloadPackets.get(i))
    // level.dat сохраняет tick rate и freeze: явное 20 тоже надо применить.
    const ticks = await configureTick(command => slotRcon(s, command), rate)
    log(`слот ${s.i}: запрос ${rate} тиков/с — ${ticks.replace(/\s+/g, ' ').trim()}`)
    await startDaemon(s, rate)
    const dOk = await waitPort(s.ws, true, 30000)
    log(`слот ${s.i}: сервер ${s.mc} ✓, демон ${s.ws} ${dOk ? '✓' : 'НЕ поднялся'} (${s.name}, сид ${st.slots[i].seed})`)
  }
}

async function cmdDaemons (args) {
  // Несколько агентов на одной ферме: без явных слотов не трогать всех (02.10: «down --slots 29-30» опускал ВСЕ миры —
  // --slots тут не читался). Слоты — позиционно или --slots; все разом — только --all.
  const spec = args._[0] || (typeof args.slots === 'string' ? args.slots : null)
  if (!spec && !args.all) throw new Error('daemons: укажи слоты (daemons 3-5 или --slots 3-5); все разом — daemons --all')
  const ids = parseSlots(spec || undefined, upSlots())
  if (args.code) {
    if (!fs.existsSync(path.join(codeDir(args.code), 'src', 'index.js'))) throw new Error(`--code ${args.code}: снимка нет — сначала node farm/farm.js snapshot ${args.code}`)
    const st = readState()
    for (const i of ids) if (st.slots?.[i]) { if (args.code === 'live') delete st.slots[i].code; else st.slots[i].code = args.code }
    writeState(st)
  }
  const owners = listeners()
  for (const i of ids) {
    const pid = owners.get(slot(i).ws)
    if (!pid) continue
    const command = cmdLine(pid)
    if (!/node/i.test(command) || !/src[\\/]index\.js/.test(command)) throw new Error(`порт ${slot(i).ws} занят чужим процессом — отменяю`)
  }
  for (const i of ids) killPid(owners.get(slot(i).ws))
  await Promise.all(ids.map(async i => {
    if (!(await waitPort(slot(i).ws, false, 10000))) throw new Error(`слот ${i}: старый демон ещё слушает порт`)
  }))
  for (const kv of args.env) process.env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1)
  await Promise.all(ids.map(async i => {
    const s = slot(i)
    if (!(await portOpen(s.mc))) throw new Error(`слот ${i}: сервер ${s.mc} не запущен`)
    await startDaemon(s)
    if (!(await waitPort(s.ws, true, 30000))) throw new Error(`слот ${i}: демон не поднялся`)
    log(`слот ${i}: демон ${s.ws} перезапущен, мир сохранён`)
  }))
}

async function cmdDown (args) {
  // Несколько агентов на одной ферме: без явных слотов не трогать всех (02.10: «down --slots 29-30» опускал ВСЕ миры —
  // --slots тут не читался). Слоты — позиционно или --slots; все разом — только --all.
  const spec = args._[0] || (typeof args.slots === 'string' ? args.slots : null)
  if (!spec && !args.all) throw new Error('down: укажи слоты (down 3-5 или --slots 3-5); все разом — down --all')
  const ids = parseSlots(spec || undefined, upSlots())
  const lis = listeners()
  // Сперва серверы (RCON stop: сохранить и выйти), потом демоны — синхронных вызовов посреди ожиданий нет.
  await Promise.all(ids.map(async i => {
    const s = slot(i)
    const spid = lis.get(s.mc)
    if (spid) {
      try { await slotRcon(s, 'stop') } catch (e) { log(`слот ${i}: rcon stop — ${e.message}`) }
      // Порт закрывается сразу, а JVM ещё пишет чанки — ждать сам процесс.
      const until = Date.now() + 120000
      while (Date.now() < until) { try { process.kill(spid, 0) } catch { break } await sleep(1000) }
      try { process.kill(spid, 0); log(`слот ${i}: java ${spid} жив через 120 с — убиваю`); killPid(spid) } catch {}
    }
    log(`слот ${i}: сервер остановлен`)
  }))
  for (const i of ids) { const dpid = lis.get(slot(i).ws); if (dpid) killPid(dpid) }
  const st = readState()
  for (const i of ids) if (st.slots) delete st.slots[i]
  writeState(st)
}

async function cmdStatus () {
  const st = readState()
  const ids = upSlots()
  if (!ids.length) return log('слотов нет')
  for (const i of ids) {
    const s = slot(i)
    const srv = await portOpen(s.mc); const dmn = await portOpen(s.ws)
    let online = ''; let ticks = ''
    if (srv) { try { online = (await slotRcon(s, 'list')).replace(/\s+/g, ' ').trim() } catch {} }
    if (srv) { try { ticks = (await slotRcon(s, 'tick query')).replace(/\s+/g, ' ').trim() } catch (e) { ticks = `tick query: ${e.message}` } }
    console.log(`слот ${i}: сервер ${s.mc} ${srv ? 'up' : 'down'}, демон ${s.ws} ${dmn ? 'up' : 'down'}, сид ${st.slots[i].seed}${st.slots[i].world ? ' (мир ' + st.slots[i].world + ')' : ''}, tick-rate запрос ${st.slots[i].tickRate ?? 'не записан'}${st.slots[i].lockstep ? ' пошаговый' : ''} ${online}${ticks ? ' | ' + ticks : ''}`)
  }
}

function tickSelection (args) {
  const flagged = typeof args.slots === 'string' || args.all
  const spec = flagged ? args.slots : args._[0]
  if (!spec && !args.all) throw new Error('tick: укажи слоты (tick 3-5 query или --slots 3-5); все разом — tick --all query')
  const action = tickAction(flagged ? args._ : args._.slice(1))
  return { spec, action }
}

async function cmdTick (args) {
  const { spec, action } = tickSelection(args)
  const ids = parseSlots(spec, upSlots())
  if (!ids.length) throw new Error('tick: нет выбранных слотов')
  for (const i of ids) {
    if (action.command !== 'tick query') await ensurePacketLimiter(slot(i))
    const response = checkedReply(action.command, await slotRcon(slot(i), action.command))
    if (action.rate !== undefined) {
      const st = readState()
      if (st.slots?.[i]) { st.slots[i].tickRate = action.rate; writeState(st) }
    }
    console.log(`слот ${i}: ${response}`)
  }
}

async function cmdRcon (args) {
  const ids = parseSlots(args._[0], upSlots())
  const text = args._.slice(1).join(' ')
  for (const i of ids) {
    try { console.log(`слот ${i}: ${(await slotRcon(slot(i), text)) || '(пусто)'}`) } catch (e) { console.log(`слот ${i}: ОШИБКА ${e.message}`) }
  }
}

async function cmdRun (args, sceneArgs) {
  const rate = tickRate(args, process.env, LIMITS.tickRate)
  const scene = args._[0]
  if (!scene) throw new Error('run: какая сцена?')
  const ids = parseSlots(args.slots, upSlots())
  const tag = args.tag || `${path.basename(scene, '.js')}-${new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')}`
  const dir = path.join(FARM, 'results', tag)
  fs.mkdirSync(dir, { recursive: true })
  const extra: Record<string, any> = {} as Record<string, any>
  for (const kv of args.env) { const k = kv.slice(0, kv.indexOf('=')); extra[k] = kv.slice(kv.indexOf('=') + 1) }
  // Уровень знания карты (S10, daemon/src/perception/knowledge): явно в окружение сцены и в batch.json — сцена, кампания и
  // строки итогов (report) видят один и тот же уровень; без ND_KNOWLEDGE — из старых флагов, по умолчанию rsg.
  try { extra.ND_KNOWLEDGE = require('../daemon/src/perception/knowledge').level({ ...process.env, ...extra }) } catch {}
  // Применить всем выбранным серверам до старта любой сцены; сервер может быть
  // восстановленной копией с сохранённой другой скоростью или заморозкой.
  for (const i of ids) {
    await ensurePacketLimiter(slot(i))
    // В 750 TPS ожидание подключения успевало сменить сутки; ночь не входит в подготовку свежего старта.
    if (path.basename(scene) === 'try-lab-fresh.js') checkedReply('time set 1000', await slotRcon(slot(i), 'time set 1000'))
    const ticks = await configureTick(command => slotRcon(slot(i), command), rate)
    const st = readState()
    if (st.slots?.[i]) { st.slots[i].tickRate = rate; writeState(st) }
    log(`слот ${i}: запрос ${rate} тиков/с — ${ticks.replace(/\s+/g, ' ').trim()}`)
  }
  const pids: Record<string, any> = {} as Record<string, any>
  const runs = ids.map(i => new Promise<void>(resolve => {
    const s = slot(i)
    const env = runEnv(process.env, {
      ND_WS: `ws://127.0.0.1:${s.ws}`,
      MC_USERNAME: s.name,
      MC_PORT: String(s.mc),
      ND_SERVER_LOG: path.join(s.dir, 'logs', 'latest.log'),
      LAB_OUT: path.join(dir, `slot-${i}.jsonl`),
      FARM_SLOT: String(i),
      ...lockstepEnv(i),
      ...extra
    }, rate)
    const out = fs.openSync(path.join(dir, `slot-${i}.out`), 'a')
    const err = fs.openSync(path.join(dir, `slot-${i}.err`), 'a')
    const p = spawn(process.execPath, [scene, ...sceneArgs], { cwd: codeDir(slotCode(i)), env, stdio: ['ignore', out, err], windowsHide: true })
    pids[i] = p.pid
    fs.writeFileSync(path.join(dir, 'pids.json'), JSON.stringify(pids))
    log(`слот ${i}: ${scene} ${sceneArgs.join(' ')} → pid ${p.pid}`)
    p.on('exit', code => { log(`слот ${i}: сцена кончилась, код ${code}`); resolve() })
  }))
  const lockstepSlots = ids.filter(i => readState().slots?.[i]?.lockstep)
  fs.writeFileSync(path.join(dir, 'batch.json'), JSON.stringify({ scene, sceneArgs, env: runEnv({} as Record<string, any>, extra, rate), tickRate: rate, clock: 'game', slots: ids, ...(lockstepSlots.length ? { lockstepSlots } : {}), at: new Date().toISOString() }, null, 2))
  await Promise.all(runs)
  report(tag)
}

function cmdKillRuns (args) {
  const dir = path.join(FARM, 'results', args._[0] || '')
  let pids: Record<string, any> = {} as Record<string, any>
  try { pids = JSON.parse(fs.readFileSync(path.join(dir, 'pids.json'), 'utf8')) } catch { return log('нет pids.json у партии') }
  for (const [i, pid] of Object.entries<any>(pids)) {
    const cl = cmdLine(pid)
    if (/node/i.test(cl) && /try-|scene|lab/i.test(cl)) { killPid(pid); log(`слот ${i}: сцена ${pid} оборвана`) }
  }
}

// Сводка: у сцен свои поля, общее — ok, seconds, deaths и прочие числа верхнего уровня.
function report (tag, by = null) {
  const dir = path.join(FARM, 'results', tag)
  const rows = []
  // Уровень знания карты партии (S10): в каждую строку итогов, если сцена его не написала сама.
  let knowledge = null
  try { knowledge = JSON.parse(fs.readFileSync(path.join(dir, 'batch.json'), 'utf8')).env.ND_KNOWLEDGE || null } catch {}
  for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) {
    const i = Number(/\d+/.exec(f)[0])
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try { rows.push({ slot: i, ...(knowledge ? { knowledge } : {}), ...JSON.parse(line) }) } catch {}
    }
  }
  fs.writeFileSync(path.join(dir, 'all.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
  console.log(`\n=== ${tag}: попыток ${rows.length} (слотов ${new Set(rows.map(r => r.slot)).size}) — ${path.join(dir, 'all.jsonl')}`)
  if (!rows.length) return
  const okN = rows.filter(r => r.ok === true).length
  if (rows.some(r => 'ok' in r)) console.log(`ok: ${okN} из ${rows.length} (${Math.round(okN * 100 / rows.length)}%)`)
  const nums: Record<string, any> = {} as Record<string, any>
  for (const r of rows) for (const [k, v] of Object.entries<any>(r)) if (typeof v === 'number' && !['slot', 'run'].includes(k)) (nums[k] = nums[k] || []).push(v)
  for (const [k, vs] of Object.entries<any>(nums)) {
    const avg = vs.reduce((a, b) => a + b, 0) / vs.length
    console.log(`${k}: среднее ${avg.toFixed(1)}, мин ${Math.min(...vs)}, макс ${Math.max(...vs)} (n=${vs.length})`)
  }
  // --by поле: сводка по группам (например bastionType — тип бастиона).
  if (by) {
    const groups: Record<string, any> = {} as Record<string, any>
    for (const r of rows) (groups[String(r[by])] = groups[String(r[by])] || []).push(r)
    for (const [g, rs] of Object.entries<any>(groups)) {
      const line = [`  ${by}=${g}: ${rs.length} попыт.`]
      if (rs.some(r => 'ok' in r)) line.push(`ok ${rs.filter(r => r.ok === true).length}`)
      for (const k of ['goldBlocksDug', 'ingotsTraded', 'pearls', 'fireRes', 'ingots', 'seconds']) {
        const vs = rs.map(r => r[k]).filter(v => typeof v === 'number')
        if (vs.length) line.push(`${k} ${(vs.reduce((a, b) => a + b, 0) / vs.length).toFixed(1)}`)
      }
      line.push(`смертей ${rs.filter(r => Array.isArray(r.deaths) ? r.deaths.some(d => /was |died|fell|tried|burn/.test(d)) : r.deaths > 0).length}`)
      console.log(line.join(', '))
    }
  }
  const causes: Record<string, any> = {} as Record<string, any>
  for (const r of rows) for (const c of (r.causes || [])) { const k = String(c).replace(/^\S+ /, ''); causes[k] = (causes[k] || 0) + 1 }
  if (Object.keys(causes).length) console.log('смерти: ' + Object.entries<any>(causes).sort((a, b) => b[1] - a[1]).map(([k, v]: any) => `${k} ×${v}`).join('; '))
}

function parseArgs (argv) {
  const dd = argv.indexOf('--')
  const main = dd >= 0 ? argv.slice(0, dd) : argv
  const sceneArgs = dd >= 0 ? argv.slice(dd + 1) : []
    const a: { _: string[]; env: string[]; [option: string]: any } = { _: [], env: [] }
  for (let k = 0; k < main.length; k++) {
    const t = main[k]
    if (t.startsWith('--')) {
      if (t.startsWith('--tick-rate=')) { a['tick-rate'] = t.slice(12); continue }
      const key = t.slice(2)
      if (!['seed', 'seeds', 'from', 'world', 'slots', 'tag', 'by', 'pool', 'tick-rate', 'random', 'fresh', 'all', 'help', 'lockstep', 'code', 'drop', 'reup'].includes(key)) throw new Error(`неизвестный параметр ${t}; значения передаются через пробел`)
      const next = main[k + 1]
      if (next !== undefined && !next.startsWith('--') && !/^[A-Z_][A-Z0-9_]*=/.test(next) && ['seed', 'seeds', 'from', 'world', 'slots', 'tag', 'by', 'pool', 'tick-rate', 'code'].includes(key)) { a[key] = next; k++ } else a[key] = true
    } else if (/^[A-Z_][A-Z0-9_]*=/.test(t) && a._.length >= 1) a.env.push(t)
    else a._.push(t)
  }
  return { a, sceneArgs }
}

// --reup: какие слоты диапазона гасить (свои: снимок того же потока — префикс имени до «-»), какие чужие (отказ).
function reupPlan (ids: number[], slots: Record<string, any>, code: string | undefined, isUp: (i: number) => boolean) {
  const owner = (name: any) => typeof name === 'string' && name && name !== 'live' ? name.split('-')[0] : null
  const me = owner(code)
  const down: number[] = [], refuse: number[] = []
  for (const i of ids) {
    if (!isUp(i)) { if (slots[i]) down.push(i); continue }
    if (me && owner(slots[i] && slots[i].code) === me) down.push(i); else refuse.push(i)
  }
  return { down, refuse }
}
if (typeof module !== 'undefined') module.exports = { reupPlan } // фикстура tick-control грузит исходник без module

;(async () => {
  // Тест (farm-reup.test) берёт reupPlan через require — без запуска CLI; фикстура tick-control режет исходник по этой строке.
  if (require.main !== module) return
  const [cmd, ...rest] = process.argv.slice(2)
  const { a, sceneArgs } = parseArgs(rest)
  try {
    // Неверный rate отсекается до подготовки миров, nice и любых процессов.
    if (['up', 'run'].includes(cmd)) tickRate(a)
    if (cmd === 'tick') tickSelection(a)
    if (['up', 'daemons', 'run', 'nice'].includes(cmd)) gentle()
    if (cmd === 'nice') {
      const pids = [...new Set([...listeners()].filter(([p]: any) => farmPort(p)).map(([, pid]: any) => pid))]
      for (const pid of pids) gentle(pid)
      log(`ниже обычного, ядра ${AFFINITY}: ${pids.join(', ') || 'некому'}`)
      const pr = applyPrio()
      if (pr.length) log(`обычный приоритет (prio ${readLimits().prio}): ${pr.join(', ')}`)
    } else if (cmd === 'up') {
      // --reup (S8b 07.10): свои слоты диапазона сперва down — под тем же замком up, чтобы между сидами серии место не ушло
      // чужому up (down→up в скрипте серии терял слот).
      // Только СВОИ (S8c 07.10, замечание проверки д): слот поднят и в slots.json снимок того же потока (префикс имени снимка до
      // «-»), иначе отказ — чужой мир не гасим; не поднятый слот — только чистка записи.
      await withUpLock(async () => {
        if (a.reup) {
          const f = Number(a.from || 1), n = Number(a._[0] || 4)
          const ids = []; for (let i = f; i < f + n && i <= MAX_SLOTS; i++) ids.push(i)
          const up = worldsUp(listeners())
          const r = reupPlan(ids, readState().slots || {}, a.code, i => up.includes(slot(i).mc))
          if (r.refuse.length) throw new Error(`--reup: слоты ${r.refuse.join(', ')} подняты не твоим снимком (--code ${a.code || '—'}, в slots.json ${r.refuse.map(i => readState().slots?.[i]?.code || 'без снимка').join(', ')}) — чужой мир не гашу`)
          if (r.down.length) await cmdDown({ _: [r.down.join(',')] })
        }
        return cmdUp(a)
      }); applyPrio()
    } else if (cmd === 'daemons') { await cmdDaemons(a); applyPrio() }
    else if (cmd === 'down') await cmdDown(a)
    else if (cmd === 'status') await cmdStatus()
    else if (cmd === 'rcon') await cmdRcon(a)
    else if (cmd === 'tick') await cmdTick(a)
    else if (cmd === 'run') await cmdRun(a, sceneArgs)
    else if (cmd === 'report') report(a._[0], a.by || null)
    else if (cmd === 'kill-runs') cmdKillRuns(a)
    else if (cmd === 'uuid') console.log(offlineUuid(a._[0]))
    else if (cmd === 'snapshot') cmdSnapshot(a)
    else console.log(fs.readFileSync(__filename.replace(/\.js$/, '.ts'), 'utf8').split(/\r?\nconst fs/)[0].split(/\r?\n/).slice(1).map(l => l.replace(/^\/\/ ?/, '')).join('\n'))
  } catch (e) {
    console.error('ОШИБКА', e.stack || e.message)
    process.exitCode = 1
  }
})()
