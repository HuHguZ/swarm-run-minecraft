'use strict'
// Таблица по механикам для отчёта S7d: строка на (серия, набор) — раундов, победы, ничьи, причины смертей,
// ключевые частоты набора, темп. Полные файлы серий (все ROUND), смерти — ROUND.deaths (лог сервера в окне раунда).
//   node dist/farm/crystal/s7dtable.js farm/results/s7d-g-27 farm/results/s7d-i-29p …
import * as fs from 'fs'
import path = require('path')

const num = (x) => Number(x) || 0
const sum = (xs) => xs.reduce((s, x) => s + num(x), 0)
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '—'
const med = (xs) => { const s = xs.filter(x => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const rows = []
for (const dir of process.argv.slice(2)) {
  // Испорченные серии (мир «приключение», бесконечное насыщение карты) — не в сводку, даже если попали в маску.
  if (!fs.existsSync(dir) || /invalid/.test(path.basename(dir))) continue
  const tag = path.basename(dir)
  const byKit = new Map()
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.out')) continue
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('ROUND {')
      if (i < 0) continue
      try { const r = JSON.parse(line.slice(i + 6)); if (!byKit.has(r.kit)) byKit.set(r.kit, []); byKit.get(r.kit).push(r) } catch {}
    }
  }
  for (const [kit, rs] of byKit) {
    const sides = rs.flatMap(r => [r.a, r.b].filter(Boolean))
    const wins = {}
    for (const r of rs) if (r.winner) wins[r.winner.replace('NeuroFarm', '')] = (wins[r.winner.replace('NeuroFarm', '')] || 0) + 1
    const kinds = {}
    for (const r of rs) for (const d of r.deaths || []) kinds[d.kind] = (kinds[d.kind] || 0) + 1
    const key = []
    const E = sides.map(s => s.elytra).filter(Boolean)
    if (E.length) {
      const crashes = sum(E.map(e => (e.crashes || []).filter(c => String(c).startsWith('стена/')).length))
      const floors = sum(E.map(e => (e.crashes || []).filter(c => String(c).startsWith('пол/')).length))
      key.push(`тараны: касаний ${sum(E.map(e => e.lanceHits))}/${sum(E.map(e => e.lancePasses))} заходов; ударов о стену ${crashes}${floors ? `, о пол ${floors}` : ''}`)
    }
    const C = sides.map(s => s.crystal).filter(Boolean)
    if (C.some(c => c.placed)) key.push(`кристаллы: по нему ≥1 ${C.flatMap(c => c.dealt || []).filter(x => x >= 1).length}, уклон. ${sum(C.map(c => c.evaded))}/${sum(C.map(c => c.threats))} (${pct(sum(C.map(c => c.evaded)), sum(C.map(c => c.threats)))}), себе ${Math.round(sum(C.map(c => c.self)))} / ему ${Math.round(sum(C.flatMap(c => c.dealt || [])))}`)
    if (C.some(c => c.anchors || c.anchorThreats)) key.push(`якоря: поставил ${sum(C.map(c => c.anchors))}, по нему ≥1 ${C.flatMap(c => c.anchorDealt || []).filter(x => x >= 1).length}, уклон. ${sum(C.map(c => c.anchorEvaded))}/${sum(C.map(c => c.anchorThreats))}`)
    const R = sides.map(s => s.rod).filter(Boolean)
    if (R.length) key.push(`удочка: зацепов ${sum(R.map(x => x.hooked))}/${sum(R.map(x => x.casts))}`)
    const U = sides.map(s => s.util).filter(Boolean)
    if (U.some(u => u.trident)) key.push(`трезубец: попал ${sum(U.map(u => u.tridentHit))}/${sum(U.map(u => u.trident))}, молний ${sum(U.map(u => u.bolts))}`)
    const MC = sides.map(s => s.mace).filter(Boolean)
    if (MC.some(m => m.smashes || m.launches)) key.push(`булава: с падения ${sum(MC.map(m => m.smashHits))}/${sum(MC.map(m => m.smashes))}, оглушающих ${sum(MC.map(m => m.stunSlams))}`)
    const X = sides.map(s => s.xbow).filter(Boolean)
    if (X.some(x => x.shots)) key.push(`арбалет: попал ${sum(X.map(x => x.hits))}/${sum(X.map(x => x.shots))}`)
    const M = sides.map(s => s.melee).filter(Boolean)
    if (M.length) key.push(`ближний: критов ${sum(M.map(m => m.crits))}, спринт ${sum(M.map(m => m.sprintHits))}/${sum(M.map(m => m.sprintTries))}, комбо макс ${Math.max(0, ...M.map(m => (m.combo && m.combo.max) || 0))}`)
    const G = sides.map(s => s.shield).filter(x => x && x.worn)
    if (G.length) key.push(`щит: погашено ${sum(G.map(x => x.blocked))}, выбит топором ${sum(G.map(x => x.disabled))}, под щитом ${Math.round(sum(G.map(x => x.upSeconds)))} с`)
    const B = sides.map(s => s.blockLog).filter(Boolean)
    if (B.length) { let n = 0; let ok = 0; for (const b of B) for (const e of Object.values<any>(b.place || {})) { n += e.n; ok += e.ok } key.push(`блоков поставил ${ok}/${n}`) }
    const combos = {}
    for (const s of sides) for (const [k, v] of Object.entries<any>((s.combos && s.combos.chains) || {})) combos[k] = (combos[k] || 0) + v
    const topC = Object.entries(combos).sort((a: any, b: any) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ×${v}`).join(', ')
    if (topC) key.push(`комбо: ${topC}`)
    rows.push(`| ${tag} | ${kit} | ${rs.length} | ${Object.entries(wins).map(([k, v]) => `${k}:${v}`).join(' ')} | ${rs.filter(r => !r.winner).length} | ${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ') || '—'} | ${key.join('; ')} | ${med(rs.map(r => r.tps))} т/с, лаг ≤${Math.max(...rs.map(r => Math.max(num(r.lagMax && r.lagMax.a), num(r.lagMax && r.lagMax.b))))} |`)
  }
}
console.log('| серия | набор | раундов | победы | ничьи | смерти (причины) | ключевое | темп |')
console.log('|---|---|---|---|---|---|---|---|')
for (const r of rows) console.log(r)
