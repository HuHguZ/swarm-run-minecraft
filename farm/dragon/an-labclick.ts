'use strict'
// Точность щелчка кровати по свидетелю сервера DragonLab (s5, 06.10, 750 TPS): для каждого урона дракону взрывом кровати
// (dd, bad_respawn_point) — тик взрыва, голова в этот тик и лучший тик в ±6 (поза головы pose пишется каждый тик у центра).
//   node dist/farm/dragon/an-labclick.js <events.jsonl> [от_ISO] [до_ISO]
import * as fs from 'fs'
const [file, from, to] = process.argv.slice(2)
const t0 = from ? Date.parse(from) : 0; const t1 = to ? Date.parse(to) : Infinity
const ev = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } })
  .filter(e => e && e.ms == null ? false : e.ms >= t0 && e.ms <= t1)
const pose = new Map(); for (const e of ev) if (e.t === 'pose') pose.set(e.tick, e)
const rows = []
for (const e of ev) {
  if (e.t !== 'dd' || e.type !== 'bad_respawn_point' || !e.src) continue
  const c = { x: e.src[0], y: e.src[1], z: e.src[2] }
  const d = k => { const p = pose.get(e.tick + k); return p ? Math.hypot(p.head[0] - c.x, p.head[1] + 0.5 - c.y, p.head[2] - c.z) : null }
  let best = null
  for (let k = -6; k <= 6; k++) { const v = d(k); if (v != null && (!best || v < best.d)) best = { k, d: v } }
  rows.push({ at: new Date(e.ms).toISOString().slice(11, 19), tick: e.tick, dmg: +e.fin.toFixed(1), head: d(0) && +d(0).toFixed(2), best: best && +best.d.toFixed(2), off: best && best.k })
}
const offs = {}; for (const r of rows) offs[r.off] = (offs[r.off] || 0) + 1
const med = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
console.log(`взрывов кроватей по дракону ${rows.length}; сдвиг лучшего тика (+ — надо было позже): ${JSON.stringify(offs)}`)
console.log(`голова в тик взрыва p50 ${med(rows.map(r => r.head))}, лучшее в ±6 p50 ${med(rows.map(r => r.best))}, урон p50 ${med(rows.map(r => r.dmg))}`)
for (const r of rows) console.log(JSON.stringify(r))
