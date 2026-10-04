'use strict'
// Сводка лаборатории взрыва кровати (daemon/try-lab-dragon-blast.js): по плечам гипотез.
//   node farm/dragon/an-blast.js <тег> [<тег> …]      — farm/results/<тег>/slot-*.jsonl
//   ALL=1 — все взрывы (по умолчанию только снижение LAND_ON_PORTAL; сидячие salvage — отдельной строкой)
// Урон — по серверу (плагин DragonLab: хп до/после взрыва), не по клиенту.
const fs = require('fs')
const path = require('path')
const tags = process.argv.slice(2)
if (!tags.length) { console.log('node farm/dragon/an-blast.js <тег> [...]'); process.exit(1) }
const R = path.join(__dirname, '..', 'results')
const rows = []
for (const tag of tags) {
  const dir = path.join(R, tag)
  for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) {
    const slot = Number(/(\d+)/.exec(f)[1])
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!l) continue; try { rows.push({ ...JSON.parse(l), slot, tag }) } catch {} }
  }
}
const q = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo) }
const f1 = v => v == null ? '-' : (Math.round(v * 10) / 10).toFixed(1)
const f2 = v => v == null ? '-' : (Math.round(v * 100) / 100).toFixed(2)
const pct = (n, d) => d ? `${Math.round(100 * n / d)}%` : '-'
const arms = [...new Set(rows.filter(r => r.arm).map(r => r.arm))]
const ALL = process.env.ALL === '1'
console.log(`теги: ${tags.join(', ')}; слотов ${new Set(rows.map(r => r.tag + r.slot)).size}; ${ALL ? 'все взрывы' : 'взрывы на снижении'}`)
console.log('плечо | взрывов | урон p25/p50/p90 | ≥50 | ≥45 | d голова p50 | dMin±10 p50 | seen p50 | не голова | поздно на 1 тик | снижений | взр/сниж | урон/сниж | урон/кровать | пустых | нам/сниж (макс) | смертей')
for (const arm of arms) {
  const all = rows.filter(r => r.t === 'blast' && r.arm === arm)
  const B = ALL ? all : all.filter(r => r.ph === 'LAND_ON_PORTAL')
  const cyc = rows.filter(r => r.t === 'cyc' && r.arm === arm && r.landed)
  const dm = B.map(b => b.dmg)
  const late = B.filter(b => b.dPrev != null && b.dPrev + 0.3 < b.dHead && b.dNext != null && b.dNext > b.dHead).length
  const beds = cyc.reduce((s, c) => s + c.blasts + (c.lost || 0) + (c.eaten || 0), 0)
  const dmgC = cyc.reduce((s, c) => s + c.dmg, 0)
  const self = cyc.map(c => c.self)
  console.log([arm, B.length, `${f1(q(dm, 0.25))}/${f1(q(dm, 0.5))}/${f1(q(dm, 0.9))}`, pct(dm.filter(v => v >= 50).length, dm.length), pct(dm.filter(v => v >= 45).length, dm.length),
    f2(q(B.map(b => b.dHead).filter(v => v != null), 0.5)), f2(q(B.map(b => b.dMin).filter(v => v != null), 0.5)), f2(q(B.map(b => b.seen).filter(v => v != null), 0.5)),
    B.filter(b => b.part && b.part !== 'head').length, pct(late, B.length), cyc.length, f1(cyc.length ? B.length / cyc.length : null), f1(cyc.length ? dmgC / cyc.length : null),
    f1(beds ? dmgC / beds : null), cyc.filter(c => !c.blasts).length, `${f1(cyc.length ? self.reduce((s, v) => s + v, 0) / cyc.length : null)} (${f1(self.length ? Math.max(...self) : null)})`,
    rows.filter(r => r.t === 'cyc' && r.arm === arm).reduce((s, c) => s + (c.deaths || 0), 0)].join(' | '))
  const sit = all.filter(r => r.ph !== 'LAND_ON_PORTAL')
  if (!ALL && sit.length) console.log(`   ${arm}: не на снижении ${sit.length} взрывов, урон p50 ${f1(q(sit.map(b => b.dmg), 0.5))} (${[...new Set(sit.map(b => b.ph))].join(', ')})`)
  // по номеру в цепочке
  const byK = []
  for (let k = 0; k < 8; k++) { const s = B.filter(b => b.k === k).map(b => b.dmg); if (s.length) byK.push(`${k + 1}:${f1(q(s, 0.5))}(${s.length})`) }
  console.log(`   ${arm}: урон p50 по номеру взрыва ${byK.join(' ')}`)
  const aim = {}; for (const b of B) if (b.aimErr != null) aim[b.aimErr] = (aim[b.aimErr] || 0) + 1
  const ups = B.map(b => b.headUp).filter(v => v != null); const hz = B.map(b => b.headHz).filter(v => v != null)
  console.log(`   ${arm}: голова над центром p50 ${f2(q(ups, 0.5))}, по горизонтали p50 ${f2(q(hz, 0.5))}; ошибка тика (взрыв − задуманный, +1 = поздно) ${JSON.stringify(aim)}; cам щелчок в тике p50 ${f1(q(B.map(b => b.sentInTick).filter(v => v != null), 0.5))} мс`)
  const whys = {}; for (const c of rows.filter(r => r.t === 'cyc' && r.arm === arm)) { const k = c.landed ? (c.why || '-') : 'не сел'; whys[k] = (whys[k] || 0) + 1 }
  console.log(`   ${arm}: конец цепочки ${JSON.stringify(whys)}`)
}
const sum = rows.filter(r => r.t === 'summary')
console.log(`сцен ${sum.length}, с ошибкой ${sum.filter(s => s.error).length}${sum.filter(s => s.error).length ? ': ' + [...new Set(sum.filter(s => s.error).map(s => s.error))].join('; ') : ''}`)
