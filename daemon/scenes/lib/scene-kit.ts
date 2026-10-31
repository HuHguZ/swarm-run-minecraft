'use strict'
import { REPO_ROOT } from '../../src/paths'
// Scene instruments: a command counts as done by the server's reply line, and
// the world under the body by the header plus the arena floor — never by the
// fact that the text was sent.
//
// Why. Every try-*.js has its own cmd(): call('say') and sleep(600). It never
// reads a reply, and three kinds of silence in server/logs/latest.log look
// exactly like success:
//   * a refusal to an operator is not logged at all (1.21.11 does not know
//     doMobSpawning: 847 commands, zero replies over a month);
//   * "nothing changed" is silent too: 38 of 38 /difficulty normal in the
//     2026-09-16 night log have no reply — already normal, or never ran;
//   * /fill counts CHANGED blocks only: /fill 594 42 597 640 58 603
//     minecraft:stone (5593 blocks) answered "Successfully filled 62 block(s)",
//     and 211 of 306 fills answered nothing.
// So the witness is a [NeuroDown: ...] line after the echo
// "NeuroDown issued server command: <text>", and a witness command must change
// the world (a fill goes through another block, a difficulty through another
// value).
//
// Two-ended reply window. Near end: the echo of exactly this command after the
// mark. Far end: the next echo of the same player, or the clock. A reply line
// between them belongs to this command, because the server runs one player's
// commands one at a time and writes the reply in the tick of the echo.
//
// Separator. The same text twice (a fill retried after a refusal, a second
// /time set) cannot be told apart by its echo: if the first echo reached the
// file after the mark (flush lag measured 43..1051 ms, p50 526, over 300 s; a
// server generating chunks can stall longer than the window), the second call
// would read the first one's reply. So a repeat is preceded by /say nd-<nonce>:
// the server logs its echo strictly after every line of the earlier command,
// and the window starts behind it.
//
// Blind spots: commands sent around the kit (a scene's old cmd()) are not
// counted as repeats; a latest.log rotation (server restart) ends the window
// with a refusal instead of surviving it.
import * as fs from 'fs'
import path = require('path')
import * as gameClock from '../../src/game-clock'

// session.js say() cuts the text at 250: a longer command reaches the server as
// a different command, and its echo simply never matches.
const MAX_CMD = 250
// commands.fill.toobig — a refusal, not logged.
const MAX_FILL = 32768
// commands.forceload.toobig.
const MAX_FORCELOAD_CHUNKS = 256
const DEFAULT_LOG = process.env.ND_SERVER_LOG || path.join(REPO_ROOT, 'server/logs/latest.log')
const DIMS = new Set(['overworld', 'the_nether', 'the_end'])
const DIFFICULTY = { peaceful: 'Peaceful', easy: 'Easy', normal: 'Normal', hard: 'Hard' }

class ArenaError extends Error {
  declare name: any
  declare result: any

  constructor (message, result = null) {
    super(message)
    this.name = 'ArenaError'
    this.result = result
  }
}

// Scene durations follow server ticks; command replies and world loading are
// transport readiness and must still progress when the game is frozen.
const sleep = ms => gameClock.sleep(ms)
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ------------------------------------------------------------------ pure parts

function checkCommand (text) {
  const t = String(text)
  if (!t.startsWith('/')) throw new ArenaError(`не команда: «${t.slice(0, 40)}» — без косой черты это уйдёт в чат`)
  if (t.length > MAX_CMD) {
    throw new ArenaError(`команда длиной ${t.length} > ${MAX_CMD}: демон режет чат до ${MAX_CMD} (session.js say), сервер получил бы другую команду — раздели её`)
  }
  // Coordinates joined by commas are refused by the server and the refusal goes
  // only to the player's chat: thirteen red checks once, with the code fine.
  // NBT and selector brackets legitimately carry commas, so they are cut first.
  const bare = t.replace(/\{[^}]*\}|\[[^\]]*\]/g, '')
  if (/\d,\s*-?\d/.test(bare)) throw new ArenaError(`координаты через запятую: «${t}» — сервер понимает только пробел`)
  return t
}

function inWorld (dim, command) {
  const c = String(command).replace(/^\//, '')
  if (dim == null) return `/${c}`
  if (!DIMS.has(dim)) throw new ArenaError(`неизвестный мир «${dim}»: жду overworld, the_nether или the_end`)
  return `/execute in minecraft:${dim} run ${c}`
}

function normBox (box) {
  const [a, b] = Array.isArray(box) ? box : [box.from, box.to]
  const n = v => Array.isArray(v) ? { x: v[0], y: v[1], z: v[2] } : v
  const p = n(a); const q = n(b)
  for (const k of ['x', 'y', 'z']) {
    if (!Number.isInteger(p[k]) || !Number.isInteger(q[k])) throw new ArenaError(`углы коробки должны быть целыми блоками: ${JSON.stringify(box)}`)
  }
  return {
    x1: Math.min(p.x, q.x), y1: Math.min(p.y, q.y), z1: Math.min(p.z, q.z),
    x2: Math.max(p.x, q.x), y2: Math.max(p.y, q.y), z2: Math.max(p.z, q.z)
  }
}

// Both corners are inclusive in /fill, hence the +1 on every axis.
function volume (b) {
  return (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) * (b.z2 - b.z1 + 1)
}

// Halve the longest axis until each piece fits. Pieces are disjoint and cover
// the box exactly, so their volumes add up to the box's — fillExact re-checks.
function splitBox (b, max = MAX_FILL) {
  if (volume(b) <= max) return [b]
  const len = { x: b.x2 - b.x1 + 1, y: b.y2 - b.y1 + 1, z: b.z2 - b.z1 + 1 }
  const axis = ['x', 'y', 'z'].reduce((best, k) => len[k] > len[best] ? k : best, 'x')
  const cut = b[axis + '1'] + Math.floor(len[axis] / 2)
  const lo = { ...b, [axis + '2']: cut - 1 }
  const hi = { ...b, [axis + '1']: cut }
  return [...splitBox(lo, max), ...splitBox(hi, max)]
}

function chunkSpan (b) {
  const cx1 = Math.floor(b.x1 / 16); const cx2 = Math.floor(b.x2 / 16)
  const cz1 = Math.floor(b.z1 / 16); const cz2 = Math.floor(b.z2 / 16)
  return { cx1, cz1, cx2, cz2, count: (cx2 - cx1 + 1) * (cz2 - cz1 + 1) }
}

// Arena lanes (NETHER.md §2, the Nether arena standard). Names go in slice order;
// a new scene is appended so the old lanes never move.
const LANES = ['worldrules', 'dimension', 'blaze', 'worlds', 'nether-safety', 'travel', 'fortress', 'nether-walk', 'blaze-run']
// Burning frames from try-portal at x=1800 above, and the portal the server
// probably made for them near x=225 below: zombified piglins come from there.
const KEEP_AWAY = [{ dim: 'overworld', x: 1800 }, { dim: 'the_nether', x: 225 }]
function lane (name) {
  const k = LANES.indexOf(name)
  if (k < 0) throw new ArenaError(`полосы «${name}» нет в реестре: допиши имя в конец LANES в scene-kit.js`)
  const z = 400 * k
  const out = { k, over: { x: 3200, z }, fight: { x: 3400, z }, nether: { x: 400, z: z / 8 } }
  for (const [where, dim] of [['over', 'overworld'], ['fight', 'overworld'], ['nether', 'the_nether']]) {
    for (const bad of KEEP_AWAY) {
      if (bad.dim === dim && Math.abs(out[where].x - bad.x) < 150) throw new ArenaError(`полоса ${name} ближе 150 блоков к x=${bad.x} в ${dim}`)
    }
  }
  return out
}

// ------------------------------------------------------------------ server log

function createServerLog (file = DEFAULT_LOG, player = 'NeuroDown') {
  const size = () => { try { return fs.statSync(file).size } catch { return 0 } }
  const echoPrefix = `${player} issued server command: `
  const replyPrefix = `[${player}: `

  // Complete lines only, cut on the byte 0x0A so a multibyte character split by
  // a half-flushed write is never decoded; CRLF is what this server writes.
  function linesFrom (from) {
    const st = size()
    if (st < from) return { rotated: true, lines: [] }
    if (st === from) return { rotated: false, lines: [] }
    const buf = Buffer.alloc(st - from)
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buf, 0, buf.length, from) } finally { fs.closeSync(fd) }
    const lines = []
    let start = 0
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 10) continue
      lines.push({ text: buf.toString('utf8', start, i).replace(/\r$/, ''), end: from + i + 1 })
      start = i + 1
    }
    return { rotated: false, lines }
  }

  const bodyOf = text => {
    const m = /^\[\d\d:\d\d:\d\d\] \[[^\]]+\]: (.*)$/.exec(text)
    return m ? m[1] : null
  }

  // Byte offset: everything the server writes from here on is «after the mark».
  const mark = () => size()

  // Near end: the echo of exactly `cmdText` after `from`. Far end: the next echo
  // of the same player, or `ms` on the clock. `re` null means «the echo is
  // enough» — the command reached the server as this text, nothing more.
  async function expectReply (cmdText, re, { from = mark(), ms = 6000 }: any = {} as Record<string, any>) {
    const t0 = gameClock.wall.now()
    for (;;) {
      const { rotated, lines } = linesFrom(from)
      if (rotated) return { ok: false, why: 'rotated', echo: false, reply: null, saw: [], ms: gameClock.wall.now() - t0 }
      let echoEnd = null; let reply = null; let closedBy = null
      const saw = []
      for (const l of lines) {
        const body = bodyOf(l.text)
        if (body === null) continue
        if (echoEnd === null) {
          if (body === echoPrefix + cmdText) {
            echoEnd = l.end
            if (!re) break
          }
          continue
        }
        if (body.startsWith(echoPrefix)) { closedBy = body.slice(echoPrefix.length); break }
        if (!body.startsWith(replyPrefix) || !body.endsWith(']')) continue
        const msg = body.slice(replyPrefix.length, -1)
        if (re.test(msg)) { reply = msg; break }
        saw.push(msg)
      }
      const took = gameClock.wall.now() - t0
      if (echoEnd !== null && (!re || reply !== null)) return { ok: true, why: null, echo: true, echoEnd, reply, saw, ms: took }
      if (closedBy !== null) return { ok: false, why: 'silent', echo: true, echoEnd, reply: null, saw, closedBy, ms: took }
      if (took >= ms) return { ok: false, why: echoEnd === null ? 'no-echo' : 'silent', echo: echoEnd !== null, echoEnd, reply: null, saw, ms: took }
      await gameClock.wall.sleep(100)
    }
  }

  return { file, player, mark, expectReply, linesFrom }
}

// One human line per result: what the server said, or which silence it was.
function describe (r) {
  if (r.ok) return r.reply !== null && r.reply !== undefined ? `ответ «${r.reply}» за ${r.ms} мс` : `эхо за ${r.ms} мс`
  const other = r.saw && r.saw.length ? `; вместо него «${r.saw.join('», «')}»` : ''
  if (r.why === 'no-echo') return `эха нет за ${r.ms} мс — до сервера команда не дошла этим текстом${other}`
  if (r.why === 'rotated') return 'latest.log начат заново (сервер перезапущен?) — окно оборвано'
  if (r.why === 'separator') return `разделитель не дошёл: ${describe(r.sepResult)}`
  const closed = r.closedBy ? `, окно закрыла следующая команда «${r.closedBy.slice(0, 60)}»` : ''
  return `эхо есть, ответа нет за ${r.ms} мс${closed}${other}`
}

// ------------------------------------------------------------------ connection

// The same RPC shape every try-*.js builds by hand: events from every reply are
// kept in `heard`, because any daemon answer drains the bus.
const clockSockets = new Set()
let clockSocket = null
// Native observers also need tick-driven physics. Each bot gets its own plugin
// scope; only a standalone scene's primary bot supplies the process clock.
function createGameBot (options, { primary = false }: any = {} as Record<string, any>) {
  const clock = new gameClock.GameClock(gameClock.lockstepOptions())
  const { plugins } = (require('../../src/tick-plugins') as typeof import('../../src/tick-plugins')).createTickPlugins(clock)
  const bot = (require('mineflayer') as typeof import('mineflayer')).createBot({ ...options, plugins: { ...plugins, ...options.plugins } })
  clock.attach(bot)
  ;(require('../../src/client-loaded') as typeof import('../../src/client-loaded')).install(bot)
  if (primary && !gameClock.snapshot()) gameClock.activate(clock)
  return bot
}

function connect (url = process.env.ND_WS || 'ws://127.0.0.1:8765', { followClock = true }: any = {}) {
  const WebSocket: typeof import('ws') = require('ws')
  const ws = new WebSocket(url)
  clockSockets.add(ws)
  clockSocket ??= ws
  ws.on('close', () => {
    clockSockets.delete(ws)
    if (clockSocket === ws) clockSocket = clockSockets.values().next().value ?? null
  })
  let id = 0
  const pending = new Map()
  const heard = []
  const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) return reject(new Error('RPC: соединение закрыто или ещё не открыто'))
    const rid = ++id
    pending.set(rid, { resolve, reject })
    ws.send(JSON.stringify({ id: rid, method, params }))
  })
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString())
    // Multiple bots in a scene share server ticks. Switching snapshot IDs on
    // every second bot's heartbeat would dispose the current game timers.
    if (followClock && ws === clockSocket) gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.ok && m.result && Array.isArray(m.result.events)) heard.push(...m.result.events)
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
  })
  ws.on('close', () => {
    for (const p of pending.values()) p.reject(new Error('RPC: соединение закрыто'))
    pending.clear()
  })
  const ready = new Promise<any>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return { ws, call, heard, ready, close: () => ws.close() }
}

// ------------------------------------------------------------------ the kit

function createKit ({ call, heard = [], logFile = DEFAULT_LOG, player = 'NeuroDown', replyMs = 6000 }: any = {} as Record<string, any>) {
  if (typeof call !== 'function') throw new ArenaError('набору нужен call(method, params) — RPC демона')
  const serverLog = createServerLog(logFile, player)
  const sinceSeparator = new Set()
  let seq = 0

  async function say (text) {
    const r = await call('say', { text })
    if (r && r.status === 'failed') throw new ArenaError(`демон не отправил «${text}»: ${r.error}`)
  }

  async function cmd (text, { reply = null, ms = replyMs }: any = {} as Record<string, any>) {
    const t = checkCommand(text)
    let from = null
    let separator = null
    if (sinceSeparator.has(t)) {
      separator = `nd-${process.pid.toString(36)}-${(++seq).toString(36)}`
      const sepText = `/say ${separator}`
      const sepFrom = serverLog.mark()
      await say(sepText)
      const s = await serverLog.expectReply(sepText, null, { from: sepFrom, ms })
      if (!s.ok) return { ...s, ok: false, why: 'separator', sepResult: s, text: t, separator }
      sinceSeparator.clear()
      from = s.echoEnd
    }
    sinceSeparator.add(t)
    if (from === null) from = serverLog.mark()
    await say(t)
    const r = await serverLog.expectReply(t, reply, { from, ms })
    return { ...r, text: t, separator }
  }

  async function must (text, reply, what, opts: any = {} as Record<string, any>) {
    const r = await cmd(text, { reply, ...opts })
    if (!r.ok) throw new ArenaError(`${what}: «${r.text}» — ${describe(r)}`, r)
    return r
  }

  // The reply names the rule the way THIS server printed it
  // (latest.log:9 «[NeuroDown: Gamerule spawn_mobs is now set to: false]»), not
  // «minecraft:spawn_mobs». The reply comes even when the value was already set,
  // so it confirms the state, not a change.
  async function gamerule (id, value) {
    if (!/^[a-z0-9_]+$/.test(String(id))) {
      throw new ArenaError(`правило «${id}» не в snake_case: сервер 1.21.11 знает только новые имена (spawn_mobs, advance_time) и на старое молчит`)
    }
    const v = String(value)
    const ok = new RegExp(`^Gamerule ${escapeRe(id)} is now set to: ${escapeRe(v)}$`)
    // У Paper правила свои у world / world_nether / world_the_end: «/gamerule» из
    // верхнего мира оставлял в Аду keep_inventory=false (слот 26, 02.10 14:28 —
    // смерть в Аду, рюкзак потерян). Ставим во всех трёх.
    const r = await must(`/gamerule ${id} ${v}`, ok, `правило ${id}=${v} не подтверждено`)
    for (const dim of ['the_nether', 'the_end']) {
      await must(`/execute in minecraft:${dim} run gamerule ${id} ${v}`, ok, `правило ${id}=${v} в ${dim} не подтверждено`)
    }
    return r
  }

  // Remove first: an already forced chunk answers «No chunks were marked», and
  // that refusal is not logged — add would look exactly like a lost command.
  // After the remove every chunk changes state, so the count must be exact.
  async function forceload (dim, box) {
    const b = normBox(box)
    const s = chunkSpan(b)
    if (s.count > MAX_FORCELOAD_CHUNKS) throw new ArenaError(`forceload на ${s.count} чанков > ${MAX_FORCELOAD_CHUNKS}: сервер откажет молча`)
    const xz = `${b.x1} ${b.z1} ${b.x2} ${b.z2}`
    await cmd(inWorld(dim, `forceload remove ${xz}`))
    const re = s.count === 1
      ? /^Marked chunk \S.* to be force loaded$/
      : new RegExp(`^Marked ${s.count} chunks in \\S+ from .* to be force loaded$`)
    const r = await must(inWorld(dim, `forceload add ${xz}`), re, `чанки ${dim} не удержаны (${s.count} шт.)`)
    return { ...r, chunks: s.count }
  }

  async function unforceload (dim, box) {
    const b = normBox(box)
    const s = chunkSpan(b)
    const re = s.count === 1
      ? /^Unmarked chunk \S.* for force loading$/
      : new RegExp(`^Unmarked ${s.count} chunks in \\S+ from .* for force loading$`)
    return must(inWorld(dim, `forceload remove ${b.x1} ${b.z1} ${b.x2} ${b.z2}`), re, `чанки ${dim} не отпущены (${s.count} шт.)`)
  }

  // /fill reports changed blocks only, so a piece is first filled with another
  // block (air, or stone when the target is air): then every block of the second
  // fill changes and the reply must name the piece's exact volume. A silent or
  // short piece is retried — an unloaded chunk refuses the whole fill silently
  // and forceloaded chunks still take a moment to generate.
  async function fillExact (dim, box, block, { tries = 4, waitMs = 1500 }: any = {} as Record<string, any>) {
    const b = normBox(box)
    const total = volume(b)
    const target = String(block).includes(':') ? String(block) : `minecraft:${block}`
    const other = target === 'minecraft:air' ? 'minecraft:stone' : 'minecraft:air'
    const pieces = splitBox(b)
    let filled = 0
    let attempts = 0
    for (const p of pieces) {
      const v = volume(p)
      const coords = `${p.x1} ${p.y1} ${p.z1} ${p.x2} ${p.y2} ${p.z2}`
      const want = new RegExp(`^Successfully filled ${v} block\\(s\\)$`)
      let r = null
      for (let i = 0; i < tries; i++) {
        attempts++
        await cmd(inWorld(dim, `fill ${coords} ${other}`))
        r = await cmd(inWorld(dim, `fill ${coords} ${target}`), { reply: want })
        if (r.ok) break
        await gameClock.wall.sleep(waitMs)
      }
      if (!r.ok) throw new ArenaError(`не залил ${coords} в ${dim || 'текущем мире'} блоком ${target}: ждал ${v} блоков, ${describe(r)}; попыток ${tries}`, r)
      filled += v
    }
    if (filled !== total) throw new ArenaError(`куски дали ${filled} блоков, коробка ${total} — ошибка разрезки`)
    return { volume: total, pieces: pieces.length, attempts }
  }

  // An unchanged difficulty answers «did not change» and that is not logged, so
  // the target is reached from another value and only the second reply counts.
  // Easy as the detour: peaceful would despawn hostiles and refill hunger.
  async function setDifficulty (d) {
    if (!DIFFICULTY[d]) throw new ArenaError(`сложность «${d}» не из peaceful/easy/normal/hard`)
    const via = d === 'easy' ? 'normal' : 'easy'
    await cmd(`/difficulty ${via}`)
    const r = await must(`/difficulty ${d}`, new RegExp(`^The difficulty has been set to ${DIFFICULTY[d]}$`), `сложность ${d} не подтверждена`)
    return { ...r, via }
  }

  // The body is where the header says AND on the floor only this arena has.
  // With `tp` the body is sent there first (execute in … run tp crosses worlds).
  async function ensureWorld (dim, { floor = null, tp = null, seconds = 15 }: any = {} as Record<string, any>) {
    if (!DIMS.has(dim)) throw new ArenaError(`неизвестный мир «${dim}»`)
    if (tp) await must(inWorld(dim, `tp @s ${tp}`), new RegExp(`^Teleported ${escapeRe(player)} to `), `телепорт в ${dim} не подтверждён`)
    const t0 = gameClock.wall.now()
    let last = null
    for (;;) {
      const st = await call('status')
      const state = (st && st.state) || {} as Record<string, any>
      let standingOn = null
      if (floor) {
        const o = await call('observe', { radius: 4, fair: false })
        standingOn = (((o && o.detail) || {} as Record<string, any>).terrain || {} as Record<string, any>).standingOn || null
      }
      last = { dimension: state.dimension || null, standingOn, pos: state.pos || null, ms: gameClock.wall.now() - t0 }
      if (last.dimension === dim && (!floor || standingOn === floor)) return last
      if (gameClock.wall.now() - t0 >= seconds * 1000) break
      await gameClock.wall.sleep(500)
    }
    throw new ArenaError(`я не в ${dim}${floor ? ` на ${floor}` : ''}: заголовок говорит ${last.dimension}, под ногами ${last.standingOn}, позиция ${JSON.stringify(last.pos)} — ждал ${seconds} с`, last)
  }

  // «/random reset *» без соли — та же последовательность лута (бартер!) на каждой копии одного сида мира (разбор
  // 06.10: все бартерные акты на сиде-двойнике дали ровно +2 жемчуга). Соль по умолчанию случайная; RNG_SEED= — повтор
  // (A/B-сцены с намеренно одинаковой последовательностью). Ответ сервера сверяется; соль возвращается для итога сцены.
  // В Аду — отдельной командой: у Paper последовательности могут быть свои у каждого мира, лишний сброс той же солью безвреден.
  // Ответ «Reset N random sequence(s)» сервер в журнал не пишет (RandomCommand: sendSuccess(…, false)) — он только в чате
  // тела, поэтому через RPC ask. Соль — int (resetAllSequencesAndSetNewDefaults(…, int, boolean, boolean)).
  async function randomReset (seed: unknown = process.env.RNG_SEED) {
    const salt = seed != null && String(seed).trim() !== '' ? Math.trunc(Number(seed)) : Math.floor(Math.random() * 2 ** 31)
    if (!Number.isSafeInteger(salt) || Math.abs(salt) > 2 ** 31 - 1) throw new ArenaError(`соль ГСЧ «${seed}» — не int`)
    for (const dim of [null, 'the_nether']) {
      const command = inWorld(dim, `random reset * ${salt}`)
      const r = await call('ask', { command, match: 'random sequence', ms: replyMs })
      const lines = (r && r.detail && r.detail.lines) || []
      if (!lines.some(l => /Reset \d+ random sequence\(s\)/.test(l))) throw new ArenaError(`сброс ГСЧ «${command}» не подтверждён: ${JSON.stringify(lines).slice(0, 200)}`, r)
    }
    console.log('соль ГСЧ', salt)
    return salt
  }

  const between = (t0, t1, type, domain = 'game') => heard.filter(e => {
    if (!e) return false
    const at = domain === 'wall' ? e.at : (e.gameAt ?? e.at)
    return at >= t0 && at <= t1 && (!type || e.type === type)
  })

  return { call, heard, serverLog, cmd, must, gamerule, forceload, unforceload, fillExact, setDifficulty, ensureWorld, randomReset, between }
}

// ------------------------------------------------------------------ итог прогона кампании
//
// Журнал кампании (campaign.js log): «[HH:MM:SS +  Mм] <этап>     <строка>». Отсюда — ВЕХИ с минутами,
// последний начатый этап, машинные коды исходов («код X» в строке вызова, session.resultCode).
const LINE_RE = /^\[(\d\d:\d\d:\d\d) \+\s*(\d+)м\] (\S+)\s+(.*)$/
function campaignFacts (text = '') {
  const miles: Record<string, any> = {} as Record<string, any>
  const codes = []
  let lastStage = null
  let lastMinute = 0
  for (const raw of String(text).split(/\r?\n/)) {
    const m = LINE_RE.exec(raw)
    if (!m) continue
    const minute = Number(m[2])
    const body = m[4]
    lastMinute = minute
    const v = /^ВЕХА (\S+): готово в \S+, (\d+) мин/.exec(body)
    if (v && miles[v[1]] === undefined) miles[v[1]] = Number(v[2])
    if (/^ход \d+: начинаю/.test(body)) lastStage = m[3]
    const c = /^(\S+) .* → (done|failed|timeout|interrupted) .*?(?:\| )?код ([A-Z][A-Z0-9_]*)/.exec(body)
    const s = c || /^(\S+) .* → (done|failed|timeout|interrupted) /.exec(body)
    if (s) codes.push({ minute, method: s[1], status: s[2], code: c ? c[3] : (s[2] === 'done' ? 'OK' : s[2].toUpperCase()) })
  }
  return { miles, lastStage, lastMinute, codes }
}

// Главная причина смертей по строкам сервера («NeuroFarm5 was slain by Zombie», «… tried to swim in lava»).
function deathCause (line) {
  const t = String(line).replace(/^\S+ /, '')
  if (/sweet berry bush/.test(t)) return 'sweet_berry_bush'
  const by = /\bby ([A-Za-z][\w ]*?)(?: using .*| while .*)?$/.exec(t)
  if (by) return by[1].trim()
  if (/lava/.test(t)) return 'lava'
  if (/fell|hit the ground/.test(t)) return 'fall'
  if (/drown/.test(t)) return 'drown'
  if (/burn|flames/.test(t)) return 'fire'
  if (/suffocat/.test(t)) return 'suffocation'
  if (/starv/.test(t)) return 'starve'
  return t.split(' ').slice(0, 3).join(' ')
}
function mainDeathCause (deaths = []) {
  const n: Record<string, any> = {} as Record<string, any>
  for (const d of deaths) { const k = deathCause(d); n[k] = (n[k] || 0) + 1 }
  return Object.entries<any>(n).sort((a, b) => b[1] - a[1])[0]?.[0] || '?'
}

// Класс провала прогона (research/05-synthesis.md J1) — один на прогон, по тому, что его остановило:
//   OK · SHELTER_ABORT · NO_STEP:<этап·почему> · WATCHDOG:<этап> · DEATH_LOOP:<причина> · TIMEOUT:<этап> ·
//   STUCK:<этап> (последние 10 мин только STUCK/NO_PATH) · CRASH · OTHER:<что>.
// rec: { ok, stoppedBy, deaths[], exitCode, deathsMax }; text — журнал кампании.
const STUCK_CODES = new Set(['STUCK', 'NO_PATH'])
function classify (rec: any = {} as Record<string, any>, text = '') {
  if (rec.ok) return 'OK'
  const t = String(text || '')
  const facts = campaignFacts(t)
  const stage = facts.lastStage || '?'
  const stoppedBy = String(rec.stoppedBy || '')
  const deaths = Array.isArray(rec.deaths) ? rec.deaths : []
  const blockers = t.match(/БЛОКЕР[^\n]*/g) || []
  const blocker = /БЛОКЕР/.test(stoppedBy) ? stoppedBy : (blockers[blockers.length - 1] || '')
  if (/^смертей/.test(stoppedBy) || (!blocker && deaths.length >= (rec.deathsMax || 5))) return `DEATH_LOOP:${mainDeathCause(deaths)}`
  if (blocker) {
    if (/укрыти|нор[аы]? не закрыт|не вышел из воды/.test(blocker)) return 'SHELTER_ABORT'
    if (/сторож/.test(blocker)) { const m = /этапа? ([a-z]+)/.exec(blocker); return `WATCHDOG:${m ? m[1] : stage}` }
    if (/нет доступного шага/.test(blocker)) {
      const m = /нет доступного шага \(([^)]*)\)/.exec(blocker)
      return `NO_STEP:${m ? m[1].replace(/\s*,\s*/g, ',') : '?'}`
    }
    if (/восемь попыток/.test(blocker)) return `NO_STEP:восемь попыток(${stage})`
    if (/нужных этапов нет/.test(blocker)) return 'NO_STEP:нужных этапов нет'
    return `OTHER:${blocker.replace(/^БЛОКЕР:?\s*/, '').slice(0, 60)}`
  }
  if (/прогон упал/.test(t) || (typeof rec.exitCode === 'number' && rec.exitCode !== 0 && rec.exitCode !== 2)) return 'CRASH'
  if (/^кампания вышла/.test(stoppedBy)) return `OTHER:${stoppedBy}`
  if (/^время/.test(stoppedBy) || !stoppedBy) {
    const window = facts.codes.filter(c => c.minute >= facts.lastMinute - 10)
    if (window.length >= 3 && window.every(c => STUCK_CODES.has(c.code))) return `STUCK:${stage}`
    return `TIMEOUT:${stage}`
  }
  return `OTHER:${stoppedBy.slice(0, 60)}`
}

export {
  MAX_CMD, MAX_FILL, MAX_FORCELOAD_CHUNKS, DEFAULT_LOG, LANES,
  ArenaError, checkCommand, inWorld, normBox, volume, splitBox, chunkSpan, lane,
  createServerLog, describe, connect, createGameBot, createKit, sleep,
  campaignFacts, deathCause, mainDeathCause, classify
}
