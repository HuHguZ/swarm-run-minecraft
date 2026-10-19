// Голова на взлёте относительно головы сидя (запись сервера rec-*.jsonl): взлёт сам (сидел ≥ 95 тиков)
// и от урона. node dist/farm/dragon/an-tkhead.js <файлы rec...>
import * as fs from 'fs'
import * as S from './dsim'
const RAD = Math.PI / 180
const rows = { nat: [], dmg: [] }
const KS = [1, 2, 5, 8, 10, 11, 12, 13, 15, 20]
for (const file of process.argv.slice(2)) {
  const L = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(x => x && x.ph != null && x.p)
  const byGt = new Map(L.map(x => [x.gt, x]))
  const head = (gt, sitting, yRotA) => {
    const x: any = byGt.get(gt); if (!x) return null
    const hist = []; for (let k = 0; k <= 10; k++) { const h: any = byGt.get(gt - k); hist.push(h ? h.p[1] : x.p[1]) }
    const s = { x: x.p[0], y: x.p[1], z: x.p[2], yRot: x.r[0], yRotA, hist }
    return S.headOf(s, sitting)
  }
  for (let i = 1; i < L.length; i++) {
    if (!(L[i].ph === 4 && L[i - 1].ph !== 4)) continue
    const g0 = L[i].gt
    if (L[i - 1].gt !== g0 - 1) continue
    // начало сидения
    let gs = g0 - 1; while (byGt.get(gs - 1) && [5, 6, 7].includes((byGt.get(gs - 1) as any).ph)) gs--
    const dur = g0 - gs
    const last: any = byGt.get(gs - 1); const prev: any = byGt.get(gs - 2)
    const yRotA0 = last && prev ? S.wrap(last.r[0] - prev.r[0]) * 10 : 0
    const hs = head(gs + 2, true, yRotA0)
    if (!hs) continue
    const out = { file: file.replace(/.*trace-/, ''), gt: g0, dur }
    for (const k of KS) {
      const a: any = byGt.get(g0 + k); const b: any = byGt.get(g0 + k - 1)
      if (!a || !b) continue
      const yRotA = S.wrap(a.r[0] - b.r[0]) * 10
      const h = head(g0 + k, false, yRotA)
      out[k] = { dh: Math.hypot(h.x - hs.x, h.z - hs.z), dy: h.y - hs.y }
    }
    ;(dur >= 95 ? rows.nat : rows.dmg).push(out)
  }
}
const med = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN }
for (const kind of ['nat', 'dmg']) {
  const R = rows[kind]
  console.log(`${kind === 'nat' ? 'сам (≥95 тиков)' : 'от урона'}: ${R.length} взлётов`)
  for (const k of KS) {
    const dh = R.map(r => r[k] && r[k].dh).filter(x => x != null); const dy = R.map(r => r[k] && r[k].dy).filter(x => x != null)
    console.log(`  k=${String(k).padStart(2)}: вбок p25 ${q(dh, 0.25).toFixed(1)} мед ${med(dh).toFixed(1)} p75 ${q(dh, 0.75).toFixed(1)} | вверх мед ${med(dy).toFixed(1)} p75 ${q(dy, 0.75).toFixed(1)}`)
  }
}
