'use strict'
// Сводка серии r-run3 (s5, 06.10): победы без смерти, смерти и причины, время убийства от платформы, кровати, реальное время,
// темп и отставание часов, доля игрового времени в окне точности (события precision трассы).
//   node farm/dragon/e2e-sum.js <тег> [--json]
const fs = require('fs')
const path = require('path')
const tag = process.argv[2]
const logs = path.join(__dirname, '..', 'logs')
const files = fs.readdirSync(logs).filter(f => new RegExp(`^${tag}-s\\d+\\.jsonl$`).test(f)).sort((a, b) => Number(a.match(/s(\d+)\.jsonl/)[1]) - Number(b.match(/s(\d+)\.jsonl/)[1]))
const q = (a, p) => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null }
const rows = []
for (const f of files) {
  const k = Number(f.match(/s(\d+)\.jsonl/)[1])
  const r = JSON.parse(fs.readFileSync(path.join(logs, f), 'utf8').trim().split('\n').pop())
  // окно точности: сумма игрового времени между on и off по трассам боя
  let precMs = 0; let precN = 0
  for (const t of r.traces || []) {
    let on = null
    try {
      for (const l of fs.readFileSync(t, 'utf8').split('\n')) {
        if (!l.includes('"precision"')) continue
        const e = JSON.parse(l)
        if (e.on && on == null) { on = e.t; precN++ } else if (e.off && on != null) { precMs += e.t - on; on = null }
      }
    } catch {}
  }
  const lab = path.join(logs, `trace-${tag}`, `s${k}`, 'lab-ev.jsonl')
  let death = null
  try { const d = fs.readFileSync(lab, 'utf8').split('\n').filter(l => l.includes('"t":"death"')).pop(); if (d) death = JSON.parse(d).msg } catch {}
  rows.push({ k, win: !!(r.killed && !r.died), killed: !!r.killed, died: !!r.died, secs: r.secs, kill: r.killSecs, center: r.centerSecs, station: r.stationSecs, beds: r.bedsTotal, wall: r.wallSecs, rate: r.rate, lag: r.lagTicks, gameTicks: r.gameTicks, home: r.home, precSec: Math.round(precMs / 1000), precN, death, stopped: r.stopped })
}
const n = rows.length; const wins = rows.filter(r => r.win)
const out = {
  tag, fights: n, wins: wins.length, winRate: n ? +(wins.length / n).toFixed(3) : null, deaths: rows.filter(r => r.died).length,
  killSec: { p50: q(wins.map(r => r.kill), 0.5), p90: q(wins.map(r => r.kill), 0.9), min: q(wins.map(r => r.kill), 0) },
  beds: { p50: q(rows.map(r => r.beds), 0.5), max: q(rows.map(r => r.beds), 1), winsP50: q(wins.map(r => r.beds), 0.5) },
  centerSec: q(rows.map(r => r.center), 0.5), stationSec: q(rows.map(r => r.station), 0.5),
  wallSec: { p50: q(rows.map(r => r.wall), 0.5), sum: Math.round(rows.reduce((s, r) => s + (r.wall || 0), 0)) },
  effTps: (() => { const g = rows.reduce((s, r) => s + (r.gameTicks || 0), 0); const w = rows.reduce((s, r) => s + (r.wall || 0), 0); return w ? Math.round(g / w) : null })(),
  lagMax: q(rows.map(r => r.lag), 1), precisionShare: (() => { const p = rows.reduce((s, r) => s + r.precSec, 0); const g = rows.reduce((s, r) => s + (r.secs || 0), 0); return g ? +(p / g).toFixed(3) : null })(),
  deathsBy: rows.filter(r => r.died).map(r => `s${r.k}: ${r.death || r.stopped}`)
}
if (process.argv.includes('--json')) console.log(JSON.stringify({ ...out, rows }, null, 1))
else {
  console.log(JSON.stringify(out, null, 1))
  for (const r of rows) console.log(`s${r.k} ${r.win ? 'ПОБЕДА' : r.died ? 'смерть' : 'нет'} убит ${r.kill ?? '-'} с, центр ${r.center ?? '-'}, станция ${r.station ?? '-'}, кроватей ${r.beds}, всего ${r.secs} с / ${r.wall} с реальн., окно ${r.precSec} с (${r.precN})${r.death ? ' — ' + r.death : ''}`)
}
