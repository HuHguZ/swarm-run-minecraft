// Сводка серии без рук (01.10): node farm/dragon/an-series.js <тег> <слотов> [<тег2> <слотов2> ...]
// Победы при ≤4/≤5/≤6 кроватях, смерти, урон p50, станция p50, взрывов в снижении p50, проигрыши и смерти построчно (ROWS=1).
const fs = require('fs'); const path = require('path')
const L = path.join(__dirname, '..', 'logs')
const a = process.argv.slice(2)
const q = xs => { const v = xs.filter(x => x != null).sort((p, r) => p - r); return v.length ? v[Math.min(v.length - 1, Math.floor((v.length - 1) / 2 + 0.5))] : '-' }
for (let i = 0; i < a.length; i += 2) {
  const tag = a[i]; const N = Number(a[i + 1]); const R = []
  // FROM=15 — с этого слота (A/B ab-run: A — 1..N, B — N+1..2N)
  for (let S = Number(process.env.FROM || 1); S <= N; S++) {
    const f = path.join(L, `${tag}-s${S}.jsonl`); if (!fs.existsSync(f)) continue
    const r = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).pop(); if (!r) continue
    const beds = []; const chains = []; const td = path.join(L, `trace-${tag}`, `s${S}`)
    if (fs.existsSync(td)) for (const tf of fs.readdirSync(td).filter(x => /^dragon-/.test(x))) for (const l of fs.readFileSync(path.join(td, tf), 'utf8').split('\n')) {
      if (l.includes('"k":"bedDone"')) { try { beds.push(JSON.parse(l).dmg) } catch {} }
      if (l.includes('"k":"pillarRun"')) { try { chains.push((JSON.parse(l).booms || []).filter(b => typeof b === 'number').length) } catch {} }
    }
    const c = r.cause || {}
    R.push({ S, won: !!(r.killed && !r.died), died: !!r.died, kb: r.killed && !r.died ? r.bedsTotal : null, st: r.stationSecs, c: r.centerSecs, beds, chain: chains.length ? Math.max(...chains) : 0, hp: r.dragonHp, stop: r.stopped, doing: c.doing, secs: r.secs })
  }
  const kb = R.filter(r => r.won).map(r => r.kb)
  console.log(`${tag}: боёв ${R.length}, побед ≤4/≤5/≤6 ${kb.filter(k => k <= 4).length}/${kb.filter(k => k <= 5).length}/${kb.filter(k => k <= 6).length} (${Math.round(100 * kb.filter(k => k <= 6).length / Math.max(1, R.length))}%), смертей ${R.filter(r => r.died).length}, урон p50 ${q(R.flatMap(r => r.beds))}, станция p50 ${q(R.map(r => r.st))} (есть ${R.filter(r => r.st != null).length}), центр p50 ${q(R.map(r => r.c))}, взрывов в снижении p50 ${q(R.filter(r => r.st != null).map(r => r.chain))}`)
  if (process.env.ROWS) for (const r of R) if (!r.won) console.log(`  s${r.S} ${r.died ? 'СМЕРТЬ ' + r.doing + ' ' + r.secs + 'с' : ''} центр ${r.c} станция ${r.st} хп ${r.hp} кровати ${JSON.stringify(r.beds)} ${r.stop || ''}`.slice(0, 220))
}
