'use strict'
// Ход одного раунда арены по трассам демонов (S7d, пересказ боёв вместо роликов): строки [trace] обоих бойцов
// (ND_TRACE_PVP: время UTC, кто, +с от начала дуэли, приём/удар/урон/граф) в окне раунда из ROUND-строки.
//   node farm/crystal/fightlog.js farm/results/<тег> <файл .out> <номер раунда> [--max 120]
// Окно: [конец раунда − durS − 5 с, конец + 2 с] по времени строки ROUND (UTC арены). Логи демонов — копии из папки
// серии (daemon-<слот>.log, daemon-<слот>b.log, …c/d.log).
const fs = require('fs')
const path = require('path')

const [dir, file, nStr, ...rest] = process.argv.slice(2)
if (!dir || !file || !nStr) { console.log('node farm/crystal/fightlog.js <папка серии> <файл .out> <раунд> [--max 120]'); process.exit(0) }
const MAX = rest.includes('--max') ? Number(rest[rest.indexOf('--max') + 1]) : 120
// --logs <папки через запятую> — где логи демонов (по умолчанию — папка серии; живые — farm/crystal, farm).
const LOGS = rest.includes('--logs') ? rest[rest.indexOf('--logs') + 1].split(',') : [dir]
const tod = (s) => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + x }
let round = null; let endT = null
for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)) {
  const i = line.indexOf('ROUND {')
  if (i < 0) continue
  const r = JSON.parse(line.slice(i + 6))
  if (String(r.n) === nStr) { round = r; endT = tod(/^\[(\d\d:\d\d:\d\d)\]/.exec(line)[1]) }
}
if (!round) { console.log('раунда нет'); process.exit(0) }
const from = endT - round.durS - 5; const to = endT + 2
const names = [round.a.name, round.b.name]
const lines = []
for (const ld of LOGS) for (const f of fs.readdirSync(ld)) {
  if (!/daemon-.*\.log$/.test(f)) continue
  for (const line of fs.readFileSync(path.join(ld, f), 'utf8').split(/\r?\n/)) {
    const m = /^\[trace\] (\d\d:\d\d:\d\d) (\S+) \+([\d.]+)s (.*)$/.exec(line)
    if (!m || !names.includes(m[2])) continue
    const t = tod(m[1])
    if (t < from || t > to) continue
    lines.push({ t, who: m[2], rel: Number(m[3]), what: m[4] })
  }
}
lines.sort((a, b) => a.t - b.t || a.rel - b.rel)
console.log(`${round.kit}, раунд ${round.n} (${round.sides}), ${round.durS} с, победил ${round.winner || 'никто'}; смерти: ${(round.deaths || []).map(d => `${d.who} ${d.msg}`).join('; ') || '—'}`)
let shown = 0; let last = ''
for (const l of lines) {
  const short = l.what.replace(/ \| я .*$/, '').replace(/\s+/g, ' ')
  const key = l.who + short
  if (key === last) continue
  last = key
  if (++shown > MAX) { console.log(`… ещё ${lines.length - MAX}`); break }
  const pos = /\| я ([\d.,-]+) хп (\d+)(?: \| он [\d.,-]+ d=([\d.]+)(?: оценка ([\d–-]+) \(точно (-?\d+)\))?)?/.exec(l.what)
  console.log(`  +${(l.t - from - 5).toString().padStart(3)}с ${l.who === names[0] ? 'A' : 'B'} ${short}${pos ? ` [хп ${pos[2]}${pos[3] ? `, d ${pos[3]}` : ''}${pos[4] ? `, его оценка ${pos[4]}, точно ${pos[5]}` : ''}]` : ''}`)
}
