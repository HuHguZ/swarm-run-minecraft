'use strict'
// Постройка замка-собора (castle.js) командами через демон — RPC say/ask, как
// build-colosseum.js. Разовая и идемпотентная: повторный запуск ставит те же
// блоки; флаг-файл castle-built.json помнит, где уже стоит.
//
//   node build-castle.js --ws ws://127.0.0.1:8771 --pos "3000 63 3000" [--opts '{"cat":"diorite"}']
//        [--dry-run] [--undo] [--no-clear] [--rate 150] [--out cmds.txt] [--force]
//
// Замок стоит В ОКЕАНЕ: начало модели y=0 — первый воздух над водой, вода на
// y=-1. Поэтому Y = уровень моря + 1 (в ванили обычно 63). Модель сама кроет
// воду скалой (снизу до y=-18) и вырубает полости (погреба, ров, killbox)
// воздухом в основном проходе — значит очищаем ТОЛЬКО над морем (y≥Y): снять
// всё, что торчит из воды над пятном застройки. Под водой ничего не трогаем —
// вокруг острова остаётся открытый океан.
//
// Порядок: forceload на габарит → очистка над морем (сверху вниз) → постройка
// (массивы по количеству, падающие после, вода последней, навесное —
// одиночными /setblock в конце) → стойки с бронёй (сущности) → проверка
// контрольных блоков → forceload снят → флаг.
//
// Ловушка строится во «взведённом» состоянии (p.trap='armed'). Стрельба
// раздатчиками, магма, плита-провал и люки моста заводятся сразу; подъём и
// сброс решёток — многоступенчатая поршневая логика, её доводим вживую после
// постройки. --undo: воздух на весь габарит и снятие флага.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const CA = require('./castle')
const { parse } = require('./colosseum')

const FLAG = path.join(__dirname, 'castle-built.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function plan ({ X, Y, Z, opts = {} }) {
  const m = CA.model(opts)
  const cmds = CA.commands(m, { X, Y, Z })
  const ents = CA.entityCommands(m, { X, Y, Z })
  const fp = CA.footprint(m, { X, Y, Z })
  const hash = crypto.createHash('sha1').update(cmds.join('\n')).digest('hex').slice(0, 12)
  return { m, cmds, ents, fp, hash, clear: clearCommands(m, { X, Y, Z }), chunks: chunkBoxes(fp) }
}

// Воздух на весь габарит над морем (world y ≥ Y, т.е. модельный y ≥ 0) —
// послойно сверху вниз, каждый слой одним /fill (габарит ~145×141 ≤ 32768).
// Ниже уровня моря не трогаем: скалу и полости ставит сама постройка.
function clearCommands (m, { X, Y, Z }) {
  const { g } = m
  const x0 = X + g.x0; const x1 = X + g.x1
  const z0 = Z + g.z0; const z1 = Z + g.z1
  const yTop = Y + g.y1
  const area = (x1 - x0 + 1) * (z1 - z0 + 1)
  const step = Math.max(1, Math.floor(32768 / area))
  const out = []
  for (let yt = yTop; yt >= Y; yt -= step) {
    const yb = Math.max(Y, yt - step + 1)
    out.push(`/fill ${x0} ${yb} ${z0} ${x1} ${yt} ${z1} minecraft:air`)
  }
  return out
}

// --undo: воздух на весь габарит (и над, и под морем — вернуть океан).
function undoCommands (m, { X, Y, Z }) {
  const { g } = m
  const x0 = X + g.x0; const x1 = X + g.x1
  const z0 = Z + g.z0; const z1 = Z + g.z1
  const area = (x1 - x0 + 1) * (z1 - z0 + 1)
  const step = Math.max(1, Math.floor(32768 / area))
  const out = []
  for (let yt = Y + g.y1; yt >= Y + g.y0; yt -= step) {
    const yb = Math.max(Y + g.y0, yt - step + 1)
    out.push(`/fill ${x0} ${yb} ${z0} ${x1} ${yt} ${z1} minecraft:air`)
  }
  // Вернуть воду до уровня моря (world Y-1 и ниже, до дна габарита).
  out.push(`/fill ${x0} ${Y + g.y0} ${z0} ${x1} ${Y - 1} ${z1} minecraft:water`)
  return out
}

// forceload кусками ≤ 256 чанков.
function chunkBoxes (fp) {
  const cx0 = Math.floor(fp.x0 / 16); const cx1 = Math.floor(fp.x1 / 16)
  const cz0 = Math.floor(fp.z0 / 16); const cz1 = Math.floor(fp.z1 / 16)
  const out = []
  const rowsPer = Math.max(1, Math.floor(256 / (cx1 - cx0 + 1)))
  for (let cz = cz0; cz <= cz1; cz += rowsPer) out.push([cx0 * 16, cz * 16, cx1 * 16 + 15, Math.min(cz1, cz + rowsPer - 1) * 16 + 15])
  return out
}

// Флаг — карта «x y z» → запись о постройке.
const keyOf = (X, Y, Z) => `${X} ${Y} ${Z}`
function readFlags () { try { return JSON.parse(fs.readFileSync(FLAG, 'utf8')) } catch { return {} } }
function readFlag ({ X, Y, Z } = {}) { const all = readFlags(); return X === undefined ? null : all[keyOf(X, Y, Z)] || null }
function writeFlag (rec) { const all = readFlags(); if (rec.remove) delete all[keyOf(rec.X, rec.Y, rec.Z)]; else all[keyOf(rec.X, rec.Y, rec.Z)] = rec; fs.writeFileSync(FLAG, JSON.stringify(all, null, 1)) }
function flagMatches (f) { return !!f && f.version === CA.DEFAULTS.version }

// Контрольные блоки: по одному характерному из разных частей замка.
function pickProbes (m, { X, Y, Z }, n = 14) {
  const { g } = m
  const want = ['diorite', 'stone_bricks', 'spruce_planks', 'dark_oak_planks', 'gold_block', 'iron_bars', 'sticky_piston', 'dispenser', 'deepslate_tiles', 'polished_andesite', 'bookshelf', 'red_wool', 'hay_block', 'chiseled_stone_bricks', 'magma_block']
  const out = []
  let seed = 11
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (const name of want) {
    const idx = []
    for (let v = 1; v < g.pal.length; v++) if (parse(g.pal[v]).name === name) idx.push(v)
    if (!idx.length) continue
    for (let tries = 0; tries < 200000; tries++) {
      const i = Math.floor(rnd() * g.data.length)
      if (!idx.includes(g.data[i])) continue
      const x = i % g.sx + g.x0; const rest = Math.floor(i / g.sx); const z = rest % g.sz + g.z0; const y = Math.floor(rest / g.sz) + g.y0
      const { name: nm, props } = parse(g.pal[g.data[i]])
      const keep = ['facing', 'half', 'type', 'axis'].filter(k => props[k] !== undefined)
      out.push({ x: X + x, y: Y + y, z: Z + z, block: 'minecraft:' + nm + (keep.length ? `[${keep.map(k => `${k}=${props[k]}`).join(',')}]` : '') })
      break
    }
    if (out.length >= n) break
  }
  return out
}

async function run ({ call, log = console.log, X, Y, Z, opts = {}, rate = 150, sync = 400, clear = true, undo = false, who = 'NeuroDown', rules = true, settle = 20 }) {
  const P = plan({ X, Y, Z, opts })
  const t0 = Date.now()
  let sent = 0; let lastSync = Date.now()
  const hasAsk = await call('ask', { command: `/tellraw ${who} "ca:hello"`, match: 'ca:hello', ms: 3000 }).then(r => !!(r && r.detail && r.detail.lines && r.detail.lines.some(l => l.includes('ca:hello'))), () => false)
  const barrier = async () => {
    if (!hasAsk) { await sleep(300); return }
    const tag = 'ca:' + (++sent)
    const r = await call('ask', { command: `/tellraw ${who} "${tag}"`, match: tag, ms: 20000 }).catch(() => null)
    if (!(r && r.detail && r.detail.lines && r.detail.lines.some(l => l.includes(tag)))) log('метка не вернулась за 20 с — сервер отстаёт, жду дальше')
  }
  let n = 0
  const send = async (text) => {
    await call('say', { text })
    n++
    const gap = 1000 / rate
    const due = lastSync + n * gap
    const now = Date.now()
    if (due > now) await sleep(due - now)
    if (n % sync === 0) { await barrier(); lastSync = Date.now(); n = 0 }
  }
  const phase = async (name, list) => {
    const t = Date.now()
    for (const c of list) await send(c)
    await barrier()
    log(`${name}: ${list.length} команд за ${((Date.now() - t) / 1000).toFixed(1)} с`)
  }
  if (rules) {
    await call('say', { text: '/gamerule sendCommandFeedback false' })
    await call('say', { text: '/gamerule commandBlockOutput false' })
  }
  try {
    for (const [a, b, c, d] of P.chunks) await send(`/forceload add ${a} ${b} ${c} ${d}`)
    await barrier(); await sleep(3000)
    if (undo) {
      await phase('разбор (океан)', undoCommands(P.m, { X, Y, Z }))
      writeFlag({ X, Y, Z, remove: true })
    } else {
      if (clear) await phase('очистка над морем', P.clear)
      await phase('постройка', P.cmds)
      await phase('стойки с бронёй', P.ents)
      if (hasAsk) {
        const probes = pickProbes(P.m, { X, Y, Z })
        let ok = 0
        for (const pr of probes) {
          const tag = 'cap:' + (++sent)
          const r = await call('ask', { command: `/execute if block ${pr.x} ${pr.y} ${pr.z} ${pr.block} run tellraw ${who} "${tag}"`, match: tag, ms: 3000 }).catch(() => null)
          if (r && r.detail && r.detail.lines && r.detail.lines.some(l => l.includes(tag))) ok++
          else log(`нет блока ${pr.block} в ${pr.x} ${pr.y} ${pr.z}`)
        }
        log(`проверка: ${ok}/${probes.length} контрольных блоков на месте`)
        if (ok < probes.length - 1) throw new Error('контрольные блоки не сошлись — постройка неполная')
      }
      writeFlag({ X, Y, Z, version: CA.DEFAULTS.version, opts, hash: P.hash, commands: P.cmds.length, blocks: P.m.stats.blocks, lights: P.m.stats.lights, footprint: P.fp, builtAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) })
    }
  } finally {
    await sleep(settle * 1000) // дать свету досчитаться до выгрузки чанков
    for (const [a, b, c, d] of P.chunks) await call('say', { text: `/forceload remove ${a} ${b} ${c} ${d}` }).catch(() => {})
    if (rules) {
      await call('say', { text: '/gamerule sendCommandFeedback true' }).catch(() => {})
      await call('say', { text: '/gamerule commandBlockOutput true' }).catch(() => {})
    }
  }
  const secs = (Date.now() - t0) / 1000
  log(`${undo ? 'разобрано' : 'построено'} за ${secs.toFixed(1)} с (${P.cmds.length} команд постройки, ${P.clear.length} очистки, ${P.ents.length} стоек)`)
  return { seconds: secs, plan: P }
}

module.exports = { plan, run, clearCommands, undoCommands, readFlag, writeFlag, flagMatches, FLAG }

// ------------------------------------------------------------------ CLI
if (require.main === module) {
  const args = process.argv.slice(2)
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
  const has = k => args.includes('--' + k)
  const [X, Y, Z] = (opt('pos', '3000 63 3000')).split(/\s+/).map(Number)
  const url = opt('ws', process.env.CASTLE_WS || 'ws://127.0.0.1:8771')
  const rate = Number(opt('rate', 150))
  const who = opt('who', 'NeuroDown')
  const opts = JSON.parse(opt('opts', '{}'))
  if (has('dry-run')) {
    const P = plan({ X, Y, Z, opts })
    const f = readFlag({ X, Y, Z })
    console.log(`Замок у ${X} ${Y} ${Z} (море Y-1=${Y - 1}), камень собора: ${P.m.p.cat}, ловушка: ${P.m.p.trap}`)
    console.log(`блоков ${P.m.stats.blocks}, свет ${P.m.stats.lights}, команд постройки ${P.cmds.length} (fill ${P.cmds.filter(c => c.startsWith('/fill')).length}), очистки ${P.clear.length}, стоек ${P.ents.length}, forceload ${P.chunks.length}`)
    console.log(`габарит x ${P.fp.x0}..${P.fp.x1}, y ${P.fp.y0}..${P.fp.y1}, z ${P.fp.z0}..${P.fp.z1}`)
    console.log(`при ${rate} команд/с — около ${Math.round((P.cmds.length + P.clear.length) / rate)} с; хэш ${P.hash}; флаг: ${f ? (flagMatches(f) ? 'стоит (' + f.builtAt + ')' : 'другой версии') : 'нет'}`)
    const out = opt('out', null)
    if (out) fs.writeFileSync(out, [...(has('undo') ? undoCommands(P.m, { X, Y, Z }) : [...P.clear, ...P.cmds, ...P.ents])].join('\n') + '\n')
    process.exit(0)
  }
  const WebSocket = require('ws')
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(new Error(m.error)) })
  const call = (method, params = {}) => new Promise((resolve, reject) => { const rid = ++id; pending.set(rid, { resolve, reject }); ws.send(JSON.stringify({ id: rid, method, params })) })
  ws.once('error', e => { console.error('WS:', e.message); process.exit(1) })
  ws.once('open', async () => {
    try {
      const st = await call('status')
      if (!st || !st.state || st.state.connected === false) throw new Error('бот демона не в игре')
      const f = readFlag({ X, Y, Z })
      if (!has('undo') && flagMatches(f) && !has('force')) console.log(`флаг: замок уже стоит (${f.builtAt}) — ставлю те же блоки ещё раз (идемпотентно), без очистки`)
      await run({ call, X, Y, Z, opts, rate, undo: has('undo'), clear: !has('no-clear') && !(flagMatches(f) && !has('force')), who })
      process.exit(0)
    } catch (e) { console.error('FAILED:', e.stack || e.message); process.exit(1) }
  })
}
