// «Держать в LANDING»: кровать у центрального столба (подушка — клетка рядом со столбом), щелчок в миг
// ближайшего прохода головы, после взрыва — толчок дракону (ServerExplosion), он заходит снова; новая
// кровать на то же место не раньше чем через 11 тиков. Сколько взрывов и урона до «сел» — по прогнозу
// посадки из записанных посадок (rec-*.jsonl). node farm/dragon/an-landchain.js rec...
const fs = require('fs')
const Vec3 = require('../../daemon/node_modules/vec3')
const D = require('../../daemon/src/dragon')
const q8 = r => Math.round(r * 256 / 360) * 360 / 256
const MAXD = +(process.env.MAXD || 3.2)
const res = []
const perPillow: Record<string, any> = {} as Record<string, any>
const perPillowD: Record<string, any> = {} as Record<string, any>
for (const file of process.argv.slice(2)) {
  const L = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(x => x && x.ph != null && x.p)
  const byGt = new Map(L.map(x => [x.gt, x]))
  for (let i = 1; i < L.length; i++) {
    if (!([5, 6, 7].includes(L[i].ph) && L[i - 1].ph === 3 && L[i].gt - L[i - 1].gt === 1)) continue
    const gs = L[i].gt; const P = Math.floor(L[i].p[1]); const kb = gs - 60
    const a: any = byGt.get(kb - 3); const b: any = byGt.get(kb)
    if (!a || !b || a.ph !== 3 || b.ph !== 3) continue
    const pk = (x, t) => ({ t, id: 1, x: x.p[0], y: x.p[1], z: x.p[2], vx: x.v[0], vy: x.v[1], vz: x.v[2], yRot: D.yRotOf(Math.PI - q8(x.r[0]) * Math.PI / 180), ph: D.PHASE.LANDING })
    const fc = D.landingForecast({ list: [pk(a, 0), pk(b, 150)] }, P)
    if (!fc || !fc.path.length) continue
    // подушки у столба (0,0): изголовье в клетке рядом (8 соседей), высоты P−1 (над факелами) и P−3
    const pillows = []
    const DY = (process.env.DY || '-1,0,1').split(',').map(Number); const RING = process.env.RING2 ? [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2]] : []
    for (const [x, z] of [...(process.env.CENTER ? [[0, 0]] : []), [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], ...RING]) for (const y of DY.map(d => P + d)) pillows.push({ x, y, z })
    let best = null
    for (const pw of pillows) {
      const c = new Vec3(pw.x + 0.5, pw.y + 0.5, pw.z + 0.5)
      const T = { x: 0.5, y: P, z: 0.5 }
      const s = D.simClone ? D.simClone(fc.path[0].st) : JSON.parse(JSON.stringify(fc.path[0].st))
      let last = -100; let dmg = 0; const booms = []; let k = 0; let sat = null
      let prevD = 99; let prevS = null
      for (k = 1; k <= 300; k++) {
        const dx = s.x - T.x; const dy = s.y - T.y; const dz = s.z - T.z
        if (dx * dx + dy * dy + dz * dz < 1) { sat = k; break }
        const snap = JSON.parse(JSON.stringify(s))
        D.simStep(s, T, 1.5, D.turnLanding)
        const h = D.simHead(s, false)
        const d = Math.hypot(h.x - c.x, h.y - c.y, h.z - c.z)
        // checkWalls: клетка кровати (и соседняя изножья — грубо, клетка изголовья) не в коробке головы
        const inHead = Math.floor(h.y) <= pw.y && pw.y <= Math.floor(h.y + 1) && Math.floor(h.x - 0.5) <= pw.x && pw.x <= Math.floor(h.x + 0.5) && Math.floor(h.z - 0.5) <= pw.z && pw.z <= Math.floor(h.z + 0.5)
        // взрыв на локальном минимуме расстояния (прошлый тик ближе, чем этот)
        if (prevS && prevD <= MAXD && d > prevD && k - 1 - last >= 11 && !prevS.inHead) {
          const hit = D.bedDamage(prevD, 1)
          dmg += hit; booms.push({ k: k - 1, d: +prevD.toFixed(2), hit })
          last = k - 1
          // толчок по состоянию после тика k−1, затем тик k заново
          Object.assign(s, JSON.parse(JSON.stringify(prevS.state)))
          const pu = D.blastPush(s, c, 1)
          s.vx += pu.x; s.vy += pu.y; s.vz += pu.z
          D.simStep(s, T, 1.5, D.turnLanding)
          const h2 = D.simHead(s, false)
          prevD = Math.hypot(h2.x - c.x, h2.y - c.y, h2.z - c.z); prevS = null
          continue
        }
        prevD = d; prevS = { state: JSON.parse(JSON.stringify(s)), inHead }
        void snap
      }
      const K = +(process.env.K || 6); const dmgK = booms.slice(0, K).reduce((a, b) => a + b.hit, 0)
      const r = { pw, booms, dmg: Math.round(dmgK), sat, natural: fc.n }
      const key = `${pw.x},${pw.z},${pw.y - P}`
      ;(perPillow[key] = perPillow[key] || []).push(r.dmg); (perPillowD[key] = perPillowD[key] || []).push(...booms.slice(0, +(process.env.K || 6)).map(b => b.d))
      if (!best || r.dmg > best.dmg) best = r
    }
    res.push({ file: file.replace(/.*trace-/, ''), gs, ...best })
    if (res.length >= +(process.env.MAXN || 40)) break
  }
  if (res.length >= +(process.env.MAXN || 40)) break
}
const dm = res.map(r => r.dmg).sort((a, b) => a - b)
const q = p => dm[Math.min(dm.length - 1, Math.floor(dm.length * p))]
console.log(`посадок ${res.length}: урон до «сел» с подушки у столба — p25 ${q(0.25)} p50 ${q(0.5)} p75 ${q(0.75)} макс ${dm[dm.length - 1]}; ≥200: ${dm.filter(x => x >= 200).length}; ≥150: ${dm.filter(x => x >= 150).length}`)
const nb = res.map(r => r.booms.length).sort((a, b) => a - b)
console.log(`взрывов: p50 ${nb[Math.floor(nb.length / 2)]}, макс ${nb[nb.length - 1]}; сел через (тиков от прогноза): p50 ${res.map(r => r.sat || 999).sort((a, b) => a - b)[Math.floor(res.length / 2)]} (без взрывов ~${res.map(r => r.natural).sort((a, b) => a - b)[Math.floor(res.length / 2)]})`)
for (const r of res.slice(0, 12)) console.log(JSON.stringify({ f: r.file, pw: r.pw, dmg: r.dmg, sat: r.sat, nat: r.natural, booms: r.booms.map(b => `${b.k}:${b.d}`) }))
console.log('по одной неподвижной подушке (урон до «сел» или 300 тиков): p25/p50, доля ≥ 200')
for (const [k, v] of Object.entries<any>(perPillow).sort((a, b) => b[1].filter(x => x >= 200).length - a[1].filter(x => x >= 200).length)) {
  const s2 = v.slice().sort((a, b) => a - b)
  const dd = (perPillowD[k] || []).slice().sort((a, b) => a - b)
  console.log(`  ${k}: p25 ${s2[Math.floor(s2.length * 0.25)]} p50 ${s2[Math.floor(s2.length / 2)]}, ≥200 ${v.filter(x => x >= 200).length}/${v.length}; взрывов ${dd.length}, d p50 ${dd[Math.floor(dd.length / 2)]}`)
}
