// Добивание мечом после 4-й кровати (02.10, поток dragon): по свидетелю DragonLab (позы головы по тикам) и плану станции R —
// сколько тиков голова в досягаемости меча (3.0 от глаз до коробки головы 1×1×1) стоя и в прыжке (+1.25), от 4-го взрыва
// (+10 тиков неуязвимости) до 5-го (или до посадки). Сидящий: голова = тело + 6.5 по взгляду, y −1.
//   node farm/dragon/an-reach.js <тег> [<тег> ...]
const fs = require('fs'); const path = require('path')
const LOGS = path.join(__dirname, '..', 'logs')
const EYE = 1.62
function boxDist (e, h) { // h — низ-центр головы
  const cx = Math.max(h[0] - 0.5, Math.min(e[0], h[0] + 0.5)); const cy = Math.max(h[1], Math.min(e[1], h[1] + 1)); const cz = Math.max(h[2] - 0.5, Math.min(e[2], h[2] + 0.5))
  return Math.hypot(e[0] - cx, e[1] - cy, e[2] - cz)
}
const rows = []
for (const tag of process.argv.slice(2)) {
  const dir = path.join(LOGS, 'trace-' + tag)
  for (const s of fs.readdirSync(dir).filter(x => /^s\d+$/.test(x)).sort((a, b) => a.slice(1) - b.slice(1))) {
    const lab = path.join(dir, s, 'lab-ev.jsonl'); if (!fs.existsSync(lab)) continue
    const tr = fs.readdirSync(path.join(dir, s)).filter(x => /^dragon-.*\.jsonl$/.test(x)).map(x => path.join(dir, s, x))
    let plan = null
    for (const f of tr) for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (l.includes('"k":"pillarPlan"') && l.includes('"R":true')) { try { plan = JSON.parse(l) } catch {} } }
    if (!plan) continue
    const feet = [plan.B[0] + 0.5, plan.B[1], plan.B[2] + 0.5]; const eye = [feet[0], feet[1] + EYE, feet[2]]; const eyeJ = [feet[0], feet[1] + EYE + 1.25, feet[2]]
    const ev = fs.readFileSync(lab, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const bx = ev.filter(e => e.t === 'bx' && e.ph === 'LAND_ON_PORTAL')
    const poses = ev.filter(e => e.t === 'pose')
    // цепочки: взрывы одного снижения — подряд с промежутком < 100 тиков
    let chain = []; const chains = []
    for (const b of bx) { if (chain.length && b.tick - chain[chain.length - 1].tick > 100) { chains.push(chain); chain = [] } chain.push(b) }
    if (chain.length) chains.push(chain)
    for (const c of chains) {
      if (c.length < 4) continue
      const t4 = c[3].tick + 10
      const tEnd = c[4] ? c[4].tick : (ev.find(e => e.t === 'ph' && e.tick > c[3].tick && e.from === 'LAND_ON_PORTAL') || { tick: t4 + 200 }).tick
      let nS = 0; let nJ = 0; let minS = 99; let minJ = 99
      for (const p of poses) { if (p.tick < t4 || p.tick > tEnd || p.ph !== 'LAND_ON_PORTAL') continue; const dS = boxDist(eye, p.head); const dJ = boxDist(eyeJ, p.head); minS = Math.min(minS, dS); minJ = Math.min(minJ, dJ); if (dS <= 3) nS++; if (dJ <= 3) nJ++ }
      const sit = ev.find(e => e.t === 'ph' && e.tick >= c[3].tick && e.from === 'LAND_ON_PORTAL')
      rows.push({ tag, s, n: c.length, ticks: tEnd - t4, nS, nJ, minS: +minS.toFixed(2), minJ: +minJ.toFixed(2), next: sit ? sit.to : null, hp4: c[3].hp != null ? +(c[3].hp).toFixed(1) : null, P: plan.H[1], feetY: feet[1] })
    }
  }
}
for (const r of rows) console.log(JSON.stringify(r))
const k = rows.length
console.log(`цепочек ≥4: ${k}; голова в досягаемости стоя хоть тик: ${rows.filter(r => r.nS > 0).length}, в прыжке: ${rows.filter(r => r.nJ > 0).length}; тиков p50 стоя ${med(rows.map(r => r.nS))}, в прыжке ${med(rows.map(r => r.nJ))}`)
function med (a) { a = a.slice().sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null }
