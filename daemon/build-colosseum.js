'use strict'
// Постройка Колизея вокруг арены (colosseum.js) командами через демон — RPC
// say, как у arena.js. Разовая и идемпотентная: повторный запуск ставит те
// же блоки; флаг-файл colosseum-built.json говорит арене, что он уже стоит.
//
//   node build-colosseum.js --ws ws://127.0.0.1:8781 --pos "3000 120 3000" [--R 24] [--ceil 16]
//        [--dry-run] [--undo] [--no-clear] [--rate 150] [--out cmds.txt]
// По умолчанию берёт ARENA_A, ARENA_POS, ARENA_R, ARENA_CEIL_H — как арена.
//
// Порядок: forceload на габарит → очистка объёма (всё, кроме квадрата поля:
// старые стеклянные оболочки, мусор, лава/вода; жидкости и под полом поля) →
// постройка снизу вверх, навесное в конце → барьерная коробка поля и дно
// щели → проверка контрольных блоков (execute if block … run tellraw) →
// forceload снят → флаг. Сервер успевает: каждые SYNC команд ждём метку
// tellraw — значит, всё до неё выполнено.
// --undo: воздух на весь объём (кроме поля), вместо барьера — стеклянные
// стены классической арены, барьерный потолок, пояс фонарей; флаг удаляется.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const CZ = require('./colosseum')

// ARENA_COLOS_FLAG — свой флаг-файл (ферма, 2026-09-30: копия Колизея для опытов
// не должна писать во флаг живой арены); по умолчанию — как было.
const FLAG = process.env.ARENA_COLOS_FLAG ? path.resolve(process.env.ARENA_COLOS_FLAG) : path.join(__dirname, 'colosseum-built.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Всё, что нужно для постройки, без сети: модель, команды, очистка, габарит.
function plan ({ X, Y, Z, R = 24, ceilH = 16 }) {
  const m = CZ.model({ R, ceilH })
  const cmds = CZ.commands(m, { X, Y, Z })
  const fp = CZ.footprint(m, { X, Y, Z })
  const hash = crypto.createHash('sha1').update(cmds.join('\n')).digest('hex').slice(0, 12)
  return { m, cmds, fp, hash, clear: clearCommands(m, { X, Y, Z, ceilH }), field: CZ.fieldCommands({ X, Y, Z, R, ceilH }), chunks: chunkBoxes(fp) }
}

// Воздух на объём постройки (колонки, где модель что-то ставит, и эллипс
// до края стилобата) от её нижнего слоя (dy −2) — ниже ничего не трогаем, —
// кроме квадрата поля |dx|,|dz| ≤ R: его ведёт арена; над полем — только выше
// потолка (крыша старой внешней оболочки на y+24). Сверху вниз. Плюс
// жидкости в столбе под полем (висящие источники).
function clearCommands (m, { X, Y, Z, ceilH = 16 }) {
  const { g, p } = m
  const R = p.R
  const x0 = g.x0; const z0 = g.z0; const nx = g.sx; const nz = g.sz
  const mask = new Uint8Array(nx * nz)
  for (let x = g.x0; x <= g.x1; x++) {
    for (let z = g.z0; z <= g.z1; z++) {
      if (Math.abs(x) <= R && Math.abs(z) <= R) continue
      const f = CZ.foot(p.A1, p.B1, x, z)
      let any = f.n <= p.F + 3
      if (!any) for (let y = g.y0; y <= g.y1 && !any; y++) if (g.data[g.i(x, y, z)]) any = true
      if (any) mask[(x - x0) * nz + (z - z0)] = 1
    }
  }
  const y0 = -2; const y1 = g.y1 + 6 // старая оболочка — до y+24, мачты до +39
  const rows = []
  for (let x = g.x0; x <= g.x1; x++) {
    let z = g.z0
    while (z <= g.z1) {
      if (!mask[(x - x0) * nz + (z - z0)]) { z++; continue }
      let z2 = z
      while (z2 + 1 <= g.z1 && mask[(x - x0) * nz + (z2 + 1 - z0)]) z2++
      rows.push({ x, z, z2 })
      z = z2 + 1
    }
  }
  // Соседние x с тем же отрезком z — в один прямоугольник.
  const rects = []
  for (const r of rows) {
    const last = rects.find(q => q.z === r.z && q.z2 === r.z2 && q.x2 === r.x - 1)
    if (last) last.x2 = r.x; else rects.push({ x: r.x, x2: r.x, z: r.z, z2: r.z2 })
  }
  const out = []
  for (const q of rects) {
    const area = (q.x2 - q.x + 1) * (q.z2 - q.z + 1)
    const step = Math.max(1, Math.floor(32768 / area))
    for (let yt = y1; yt >= y0; yt -= step) {
      const yb = Math.max(y0, yt - step + 1)
      out.push({ y: yt, cmd: `/fill ${X + q.x} ${Y + yb} ${Z + q.z} ${X + q.x2} ${Y + yt} ${Z + q.z2} minecraft:air` })
    }
  }
  if (ceilH + 1 <= y1) {
    const area = (2 * R + 1) * (2 * R + 1)
    const step = Math.max(1, Math.floor(32768 / area))
    for (let yt = y1; yt >= ceilH + 1; yt -= step) out.push({ y: yt, cmd: `/fill ${X - R} ${Y + Math.max(ceilH + 1, yt - step + 1)} ${Z - R} ${X + R} ${Y + yt} ${Z + R} minecraft:air` })
  }
  out.sort((a, b) => b.y - a.y)
  const cmds = out.map(o => o.cmd)
  // Висящие источники воды/лавы под полом поля (иначе водопады до земли).
  for (const liq of ['water', 'lava']) cmds.push(`/fill ${X - R} ${Y - 14} ${Z - R} ${X + R} ${Y - 2} ${Z + R} minecraft:air replace minecraft:${liq}`)
  return cmds
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

// Классическая коробка арены (для --undo): стекло на R+1 от пола до потолка,
// пояс морских фонарей, барьерный потолок (как arena.js buildArena/walls).
function classicCommands ({ X, Y, Z, R, ceilH }) {
  const r = R + 1; const T = Y + ceilH - 1
  const out = []
  for (const [a, b, c, d] of [[X - r, Z - r, X + r, Z - r], [X - r, Z + r, X + r, Z + r], [X - r, Z - r, X - r, Z + r], [X + r, Z - r, X + r, Z + r]]) {
    out.push(`/fill ${a} ${Y - 1} ${b} ${c} ${T} ${d} minecraft:glass`)
    out.push(`/fill ${a} ${Y + 2} ${b} ${c} ${Y + 2} ${d} minecraft:sea_lantern`)
  }
  out.push(`/fill ${X - r} ${Y - 2} ${Z - r} ${X + r} ${Y - 2} ${Z + r} minecraft:air replace minecraft:crying_obsidian`)
  out.push(`/fill ${X - r} ${Y + ceilH} ${Z - r} ${X + r} ${Y + ceilH} ${Z + r} minecraft:barrier`)
  return out
}

// Флаг — карта «x y z» → запись о постройке (тестовый сервер и живой мир не
// путаются).
const keyOf = (X, Y, Z) => `${X} ${Y} ${Z}`
function readFlags () { try { return JSON.parse(fs.readFileSync(FLAG, 'utf8')) } catch { return {} } }
function readFlag ({ X, Y, Z } = {}) { const all = readFlags(); return X === undefined ? null : all[keyOf(X, Y, Z)] || null }
function writeFlag (rec) { const all = readFlags(); if (rec.remove) delete all[keyOf(rec.X, rec.Y, rec.Z)]; else all[keyOf(rec.X, rec.Y, rec.Z)] = rec; fs.writeFileSync(FLAG, JSON.stringify(all, null, 1)) }
function flagMatches (f, { R }) {
  return !!f && f.R === R && f.version === CZ.DEFAULTS.version
}

// Выполнение. call(method, params) — RPC демона; who — имя бота (для tellraw).
async function run ({ call, log = console.log, X, Y, Z, R = 24, ceilH = 16, rate = 150, sync = 400, clear = true, undo = false, who = 'NeuroDown', rules = true, settle = 15 }) {
  const P = plan({ X, Y, Z, R, ceilH })
  const t0 = Date.now()
  let sent = 0; let lastSync = Date.now()
  const hasAsk = await call('ask', { command: `/tellraw ${who} "cz:hello"`, match: 'cz:hello', ms: 3000 }).then(r => !!(r && r.detail && r.detail.lines && r.detail.lines.some(l => l.includes('cz:hello'))), () => false)
  // Метка: сервер выполнил всё, что до неё.
  const barrier = async () => {
    if (!hasAsk) { await sleep(300); return }
    const tag = 'cz:' + (++sent)
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
  // Ответы на тысячи /fill не нужны ни боту, ни операторам в чате (арена сама
  // выключает их у себя — rules: false).
  if (rules) {
    await call('say', { text: '/gamerule send_command_feedback false' })
    await call('say', { text: '/gamerule log_admin_commands false' })
  }
  try {
    for (const [a, b, c, d] of P.chunks) await send(`/forceload add ${a} ${b} ${c} ${d}`)
    await barrier(); await sleep(3000) // чанки прогрузиться
    if (undo) {
      await phase('разбор (воздух)', P.clear)
      await phase('классическая коробка', classicCommands({ X, Y, Z, R, ceilH }))
      writeFlag({ X, Y, Z, remove: true })
    } else {
      if (clear) await phase('очистка объёма', P.clear)
      await phase('постройка', P.cmds)
      await phase('барьерная коробка поля', P.field)
      if (hasAsk) {
        const probes = pickProbes(P.m, { X, Y, Z }, 12)
        let ok = 0
        for (const pr of probes) {
          const tag = 'czp:' + (++sent)
          const r = await call('ask', { command: `/execute if block ${pr.x} ${pr.y} ${pr.z} ${pr.block} run tellraw ${who} "${tag}"`, match: tag, ms: 3000 }).catch(() => null)
          if (r && r.detail && r.detail.lines && r.detail.lines.some(l => l.includes(tag))) ok++
          else log(`нет блока ${pr.block} в ${pr.x} ${pr.y} ${pr.z}`)
        }
        log(`проверка: ${ok}/${probes.length} контрольных блоков на месте`)
        if (ok < probes.length) throw new Error('контрольные блоки не сошлись — постройка неполная')
      }
      writeFlag({ X, Y, Z, R, ceilH, version: CZ.DEFAULTS.version, hash: P.hash, commands: P.cmds.length, blocks: P.m.stats.blocks, footprint: P.fp, builtAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000) })
    }
  } finally {
    // Свет досчитывается не сразу: выгрузить чанки раньше — сохранить
    // недосчитанный. Держим чанки ещё settle секунд.
    await sleep(settle * 1000)
    for (const [a, b, c, d] of P.chunks) await call('say', { text: `/forceload remove ${a} ${b} ${c} ${d}` }).catch(() => {})
    if (rules) {
      await call('say', { text: '/gamerule send_command_feedback true' }).catch(() => {})
      await call('say', { text: '/gamerule log_admin_commands true' }).catch(() => {})
    }
  }
  const secs = (Date.now() - t0) / 1000
  log(`${undo ? 'разобрано' : 'построено'} за ${secs.toFixed(1)} с (${P.cmds.length} команд постройки, ${P.clear.length} очистки)`)
  return { seconds: secs, plan: P }
}

// Контрольные блоки: по одному характерному (колонна, фонарь, ступень ряда,
// карниз, мачта) — разные места и высоты.
function pickProbes (m, { X, Y, Z }, n) {
  const { g } = m
  const want = ['quartz_pillar', 'lantern', 'smooth_sandstone_stairs', 'smooth_quartz_stairs', 'spruce_fence', 'chiseled_quartz_block', 'sand', 'shroomlight', 'cut_sandstone', 'diorite_wall', 'gold_block', 'red_banner']
  const out = []
  let seed = 7
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  for (const name of want) {
    const idx = []
    for (let v = 1; v < g.pal.length; v++) if (CZ.parse(g.pal[v]).name === name) idx.push(v)
    if (!idx.length) continue
    for (let tries = 0; tries < 200000; tries++) {
      const i = Math.floor(rnd() * g.data.length)
      if (!idx.includes(g.data[i])) continue
      const x = i % g.sx + g.x0; const rest = Math.floor(i / g.sx); const z = rest % g.sz + g.z0; const y = Math.floor(rest / g.sz) + g.y0
      const { name: nm, props } = CZ.parse(g.pal[g.data[i]])
      const keep = ['facing', 'half', 'type', 'axis', 'hanging'].filter(k => props[k] !== undefined)
      out.push({ x: X + x, y: Y + y, z: Z + z, block: 'minecraft:' + nm + (keep.length ? `[${keep.map(k => `${k}=${props[k]}`).join(',')}]` : '') })
      break
    }
    if (out.length >= n) break
  }
  return out
}

module.exports = { plan, run, clearCommands, classicCommands, readFlag, writeFlag, flagMatches, FLAG }

// ------------------------------------------------------------------ CLI
if (require.main === module) {
  const args = process.argv.slice(2)
  const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
  const has = k => args.includes('--' + k)
  const [X, Y, Z] = (opt('pos', process.env.ARENA_POS || '200 100 200')).split(/\s+/).map(Number)
  const R = Number(opt('R', process.env.ARENA_R || 24))
  const ceilH = Number(opt('ceil', process.env.ARENA_CEIL_H || 16))
  const url = opt('ws', process.env.ARENA_A || 'ws://127.0.0.1:8781')
  const rate = Number(opt('rate', 150))
  const who = opt('who', 'NeuroDown')
  if (has('dry-run')) {
    const P = plan({ X, Y, Z, R, ceilH })
    const f = readFlag({ X, Y, Z })
    console.log(`Колизей у ${X} ${Y} ${Z}, поле R=${R}, потолок +${ceilH}: эллипс арены ${2 * P.m.p.A1}×${2 * P.m.p.B1}, снаружи ~${P.fp.x1 - P.fp.x0 + 1}×${P.fp.z1 - P.fp.z0 + 1}, высота до y=${P.fp.y1}`)
    console.log(`блоков ${P.m.stats.blocks}, команд постройки ${P.cmds.length} (fill ${P.cmds.filter(c => c.startsWith('/fill')).length}), очистки ${P.clear.length}, коробки поля ${P.field.length}, forceload ${P.chunks.length}`)
    console.log(`габарит x ${P.fp.x0}..${P.fp.x1}, y ${P.fp.y0}..${P.fp.y1}, z ${P.fp.z0}..${P.fp.z1}; зритель ${JSON.stringify(CZ.watchSpot(P.m, { X, Y, Z }))}`)
    console.log(`при ${rate} команд/с — около ${Math.round((P.cmds.length + P.clear.length) / rate)} с; хэш ${P.hash}; флаг: ${f ? (flagMatches(f, { R }) ? 'стоит (' + f.builtAt + ')' : 'другой (R ' + f.R + ', версия ' + f.version + ')') : 'нет'}`)
    const out = opt('out', null)
    if (out) fs.writeFileSync(out, [...(has('undo') ? P.clear : [...P.clear, ...P.cmds, ...P.field])].join('\n') + '\n')
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
      if (!has('undo') && flagMatches(f, { R }) && !has('force')) console.log(`флаг: Колизей уже стоит (${f.builtAt}) — ставлю те же блоки ещё раз (идемпотентно), без очистки`)
      await run({ call, X, Y, Z, R, ceilH, rate, undo: has('undo'), clear: !has('no-clear') && !(flagMatches(f, { R }) && !has('force')), who })
      process.exit(0)
    } catch (e) { console.error('FAILED:', e.stack || e.message); process.exit(1) }
  })
}
