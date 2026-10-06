// A/B подхода жемчугом: node farm/dragon/an-pearl.js <тег> <пар N> [<тег2> <N2> ...]
// Пара i: слот i — A (ND_PEARL=0), слот i+N — B (ND_PEARL=1), сид общий. Итоги — farm/logs/<тег>-s<S>.jsonl,
// трассы — farm/logs/trace-<тег>/s<S>/dragon-*.jsonl (взрывы кроватей: bed/bedDone).
const fs = require('fs')
const path = require('path')
const L = path.join(__dirname, '..', 'logs')
const args = process.argv.slice(2)
const rows = []
for (let a = 0; a < args.length; a += 2) {
  const tag = args[a]; const N = Number(args[a + 1])
  for (let S = 1; S <= 2 * N; S++) {
    const f = path.join(L, `${tag}-s${S}.jsonl`)
    const arm = S <= N ? 'A' : 'B'
    const pair = `${tag}:${S <= N ? S : S - N}`
    if (!fs.existsSync(f)) { rows.push({ tag, S, arm, pair, none: true }); continue }
    const r = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).pop()
    if (!r) { rows.push({ tag, S, arm, pair, none: true }); continue }
    const beds = []
    const seen = []
    const chains = []
    const td = path.join(L, `trace-${tag}`, `s${S}`)
    if (fs.existsSync(td)) {
      for (const tf of fs.readdirSync(td).filter(x => /^dragon-/.test(x))) {
        for (const l of fs.readFileSync(path.join(td, tf), 'utf8').split('\n')) {
          if (l.includes('"k":"pillarPlan"') && l.includes('"seen"')) { try { const e = JSON.parse(l); if (e.seen != null) seen.push(e.seen) } catch {} }
          if (l.includes('"k":"pillarRun"')) { try { const e = JSON.parse(l); chains.push((e.booms || []).filter(b => typeof b === 'number').length) } catch {} }
          if (!l.includes('"k":"bedDone"')) continue
          try { const e = JSON.parse(l); beds.push({ dmg: e.dmg, ph: e.ph, d: e.headDist ?? e.dist, now: e.headNow, took: e.took }) } catch {}
        }
      }
    }
    const pe = r.pearl || {} as Record<string, any>
    rows.push({ tag, S, arm, pair, won: !!(r.killed && !r.died), died: !!r.died, killSecs: r.killed && !r.died ? r.killSecs : null, centerSecs: r.centerSecs, stationSecs: r.stationSecs, pearls: pe.pearls || 0, hops: pe.hops || 0, hpLost: pe.hpLost || 0, misses: pe.misses || 0, pearlStop: pe.stop, beds, seen: seen.length ? seen[seen.length - 1] : null, killBed: r.killed && !r.died ? r.bedsTotal : null, maxChain: chains.length ? Math.max(...chains) : 0, bedsUsed: r.bedsTotal, dragonHp: r.dragonHp, cause: r.cause })
  }
}
const q = (xs, p) => { const v = xs.filter(x => x != null).sort((a, b) => a - b); if (!v.length) return '-'; return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))] }
const med = xs => q(xs, 0.5); const p90 = xs => q(xs, 0.9)
for (const arm of ['A', 'B']) {
  const R = rows.filter(r => r.arm === arm && !r.none)
  const bd = R.flatMap(r => r.beds)
  const dmg = bd.filter(b => b.dmg != null).map(b => b.dmg)
  console.log(`${arm}: боёв ${R.length}, побед ${R.filter(r => r.won).length}, смертей ${R.filter(r => r.died).length}; ` +
    `до центра p50 ${med(R.map(r => r.centerSecs))} p90 ${p90(R.map(r => r.centerSecs))}; станция p50 ${med(R.map(r => r.stationSecs))} p90 ${p90(R.map(r => r.stationSecs))} (есть ${R.filter(r => r.stationSecs != null).length}); ` +
    `смерть дракона p50 ${med(R.map(r => r.killSecs))} p90 ${p90(R.map(r => r.killSecs))}; жемчуга ${R.reduce((n, r) => n + r.pearls, 0)} (бросков ${R.reduce((n, r) => n + r.hops, 0)}, боёв с броском ${R.filter(r => r.hops).length}), хп на жемчуге ${Math.round(R.reduce((n, r) => n + r.hpLost, 0) * 10) / 10}, промахов ${R.reduce((n, r) => n + r.misses, 0)}; ` +
    `взрывов ${bd.length} (${Math.round(bd.length / Math.max(1, R.length) * 10) / 10}/бой), урон p50 ${med(dmg)} p90 ${p90(dmg)}, сумма/бой ${Math.round(dmg.reduce((a, b) => a + b, 0) / Math.max(1, R.length))}; дракон хп в конце p50 ${med(R.filter(r => !r.won).map(r => r.dragonHp))}`)
}
// бюджет кроватей: на какой кровати умер дракон
for (const arm of ['A', 'B']) {
  const R = rows.filter(r => r.arm === arm && !r.none)
  const kb = R.filter(r => r.killBed != null).map(r => r.killBed)
  const now = R.flatMap(r => r.beds).map(b => b.now).filter(x => x != null)
  console.log(`${arm}: побед при ≤4 ${kb.filter(k => k <= 4).length}, ≤5 ${kb.filter(k => k <= 5).length}, ≤6 ${kb.filter(k => k <= 6).length}, всего ${kb.length} из ${R.length} (кровать смерти: ${kb.sort((a, b) => a - b).join(',')}); голова в щелчок (клиент) p50 ${med(now)}; видимость плана p50 ${med(R.map(r => r.seen))}; взрывов в одном снижении (макс. за бой) p50 ${med(R.map(r => r.maxChain))}`)
}
// попарно (один сид)
const pairs = [...new Set(rows.map(r => r.pair))]
const dS = []; const dK = []; const dC = []
for (const p of pairs) {
  const a = rows.find(r => r.pair === p && r.arm === 'A'); const b = rows.find(r => r.pair === p && r.arm === 'B')
  if (!a || !b || a.none || b.none) continue
  if (a.stationSecs != null && b.stationSecs != null) dS.push(b.stationSecs - a.stationSecs)
  if (a.centerSecs != null && b.centerSecs != null) dC.push(b.centerSecs - a.centerSecs)
  if (a.killSecs != null && b.killSecs != null) dK.push(b.killSecs - a.killSecs)
}
console.log(`попарно B−A (с): до центра p50 ${med(dC)} (n ${dC.length}), станция p50 ${med(dS)} (n ${dS.length}), смерть дракона p50 ${med(dK)} (n ${dK.length})`)
if (process.env.ROWS) for (const r of rows) console.log(JSON.stringify({ ...r, beds: r.beds && r.beds.map(b => b.dmg) }))
// взрывы по фазе
const byPh: Record<string, any> = {} as Record<string, any>
for (const r of rows) for (const b of r.beds || []) { const k = `${r.arm}:${b.ph}`; (byPh[k] = byPh[k] || []).push(b.dmg) }
for (const [k, v] of Object.entries<any>(byPh)) console.log(`взрывы ${k}: ${v.length}, урон p50 ${med(v)} p90 ${p90(v)}`)
