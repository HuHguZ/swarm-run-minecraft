// Сводка серий try-lab-mv-gap.js (поток movement): node farm/movement/an-mv.js <tag> [tag…]
// Сводка серий try-lab-mv-gap: сцена × режим → n, ok, медиана ms (только ok), падения, minHp, блоки, жемчуг.
const fs = require('fs')
const path = require('path')
const tags = process.argv.slice(2)
const rows = []
for (const t of tags) {
  const dir = path.join('C:/Users/user/Desktop/work/minecraft-claude/farm/results', t)
  for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)) { try { rows.push({ tag: t, ...JSON.parse(l) }) } catch {} }
  }
}
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const by = {}
for (const r of rows) (by[r.scene] ??= {})[r.mode] ??= [], by[r.scene][r.mode].push(r)
for (const [sc, modes] of Object.entries(by)) {
  const out = []
  for (const [m, rs] of Object.entries(modes)) {
    const ok = rs.filter(r => r.ok)
    const msOk = ok.map(r => r.ms)
    out.push(`${m.padEnd(11)} n=${String(rs.length).padStart(2)} ok=${String(ok.length).padStart(2)} med=${med(msOk) == null ? '  -  ' : (med(msOk) / 1000).toFixed(2).padStart(5)}s p90=${msOk.length ? (msOk.sort((a, b) => a - b)[Math.floor(msOk.length * 0.9)] / 1000).toFixed(1) : '-'}s fell=${rs.filter(r => r.fell).length} hpLoss=${rs.filter(r => r.minHp < 20).length} minHp=${Math.min(...rs.map(r => r.minHp ?? 20))} blocks=${med(rs.map(r => r.blocks || 0))} pearls=${rs.reduce((n, r) => n + (r.pearls || 0), 0)}${rs.some(r => r.error) ? ' err=' + rs.filter(r => r.error).length : ''}`)
  }
  console.log(sc); for (const l of out) console.log('  ' + l)
}
