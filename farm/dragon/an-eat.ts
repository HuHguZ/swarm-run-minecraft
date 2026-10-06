// Съеденные кровати: по записи сервера — тики, где коробки дракона (голова/шея/тело) накрывают клетки кровати H/F,
// между установкой ('pillar:bed') и щелчком. node an-eat.js <dir>...
const fs = require('fs'); const path = require('path')
const S = require('./dsim')
for (const dir of process.argv.slice(2)) {
  const tf = fs.readdirSync(dir).filter(f => /^dragon-/.test(f))[0]; const rf = fs.readdirSync(dir).filter(f => /^rec/.test(f))[0]
  if (!tf || !rf) continue
  const t0 = Date.parse(tf.replace(/^dragon-/, '').replace(/\.jsonl$/, '').replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, 'T$1:$2:$3.$4Z'))
  const T = fs.readFileSync(path.join(dir, tf), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const pp = T.find(e => e.k === 'pillarPlan' && e.H); if (!pp) continue
  const H = { x: pp.H[0], y: pp.H[1], z: pp.H[2] }; const F = { x: pp.F[0], y: pp.H[1], z: pp.F[1] }
  const R = fs.readFileSync(path.join(dir, rf), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(x => x && x.p)
  const byGt = new Map(R.map(x => [x.gt, x]))
  const cells = [H, F]
  const hitAt = (x) => {
    const b: any = byGt.get(x.gt - 1); if (!b) return null
    const hist = []; for (let k = 0; k <= 10; k++) { const h: any = byGt.get(x.gt - k); hist.push(h ? h.p[1] : x.p[1]) }
    const s = { x: x.p[0], y: x.p[1], z: x.p[2], yRot: x.r[0], yRotA: S.wrap(x.r[0] - b.r[0]) * 10, hist }
    const hd = S.headOf(s, false); const nk = S.neckOf(s, false)
    const boxes = [[hd.x, hd.y, hd.z, 0.5, 1], [nk.x, nk.y, nk.z, 1.5, 3], [s.x + S.msin(s.yRot * 0.017453292) * 0.5, s.y, s.z - S.mcos(s.yRot * 0.017453292) * 0.5, 2.5, 3]]
    for (const [cx, cy, cz, hw, h] of boxes) for (const c of cells) {
      if (c.x + 1 > cx - hw && c.x < cx + hw && c.y + 1 > cy && c.y < cy + h && c.z + 1 > cz - hw && c.z < cz + hw) return true
    }
    return false
  }
  // интервалы «кровать стоит»: от pillar:bed до bed (щелчок)
  let last = null; const evs = []
  for (const e of T) { if (e.k === 's' && e.doing !== last) { if (e.doing === 'pillar:bed') evs.push({ k: 'place', t: e.t }); last = e.doing } if (e.k === 'bed') evs.push({ k: 'click', t: e.t }) }
  const out = []
  for (let i = 0; i < evs.length; i++) {
    if (evs[i].k !== 'place') continue
    const j = evs.findIndex((e, k) => k > i && e.k === 'click'); if (j < 0) continue
    const a = t0 + evs[i].t + 300; const b = t0 + evs[j].t - 100
    const ticks = R.filter(x => x.t >= a && x.t <= b && x.ph === 3)
    const hits = ticks.filter(hitAt)
    out.push(`${Math.round(evs[i].t / 100) / 10}→${Math.round(evs[j].t / 100) / 10}с: тиков ${ticks.length}, накрыта ${hits.length}`)
  }
  console.log(path.basename(path.dirname(dir)) + '/' + path.basename(dir), JSON.stringify(H), out.join('; '))
}
