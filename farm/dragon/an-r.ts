import { REPO_ROOT } from '../../daemon/src/paths'
// Сводка серии боёв (02.10, поток dragon): node dist/farm/dragon/an-r.js <тег> [<тег2> ...]   (ROWS=1 — построчно)
// Итоги — farm/logs/<тег>-s<k>.jsonl (сцена try-dragon e2e), трассы — farm/logs/trace-<тег>/s<k>/dragon-*.jsonl (только вызовы боя).
// Победа — дракон убит (сервер: дракона нет) и бот жив; портал — отдельно. Станция до первого снижения — первая удачная
// pillarBuild раньше первой фазы LANDING (3). Кровати до станции — bedDone раньше станции.
import * as fs from 'fs'; import path = require('path')
const L = path.join(REPO_ROOT, 'farm/logs')
const q = (xs, p) => { const v = xs.filter(x => x != null && !Number.isNaN(x)).sort((a, b) => a - b); return v.length ? Math.round(v[Math.min(v.length - 1, Math.floor((v.length - 1) * p + 0.5))] * 10) / 10 : '-' }
const tally = (m, k) => { m[k] = (m[k] || 0) + 1 }
const isoOf = f => { const m = /dragon-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d+)Z/.exec(f); return m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : 0 }
for (const tag of process.argv.slice(2)) {
  const files = fs.readdirSync(L).filter(f => f.startsWith(tag + '-s') && f.endsWith('.jsonl') && /-s\d+\.jsonl$/.test(f))
  const R = []; const scene = []
  const buildWhy: Record<string, any> = {} as Record<string, any>; const runWhy: Record<string, any> = {} as Record<string, any>; const planNo: Record<string, any> = {} as Record<string, any>
  const dmgR = []; const dmgP1 = []; const dmgP0 = []; const dmgOther = []
  for (const f of files) {
    const k = Number(/-s(\d+)\.jsonl$/.exec(f)[1])
    const lines = fs.readFileSync(path.join(L, f), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    const r = lines.pop(); if (!r) continue
    if (!r.calls) { scene.push({ k, why: r.why || r.stopped || 'сцена' }); continue }
    const traces = (r.traces || []).filter(t => fs.existsSync(t)).sort((a, b) => isoOf(a) - isoOf(b))
    const t0 = traces.length ? isoOf(traces[0]) : 0
    let landing = null; let station = null; let Pr = null; const beds = []; const chains = []; let rNull = 0; let aPlan = 0
    for (const tf of traces) {
      const off = isoOf(tf) - t0
      for (const l of fs.readFileSync(tf, 'utf8').split('\n')) {
        if (!l || l.includes('"k":"d') || l.includes('"k":"s"')) continue
        let e; try { e = JSON.parse(l) } catch { continue }
        const t = (e.t + off) / 1000
        if (e.k === 'phase' && e.ph === 3 && landing == null) landing = t
        if (e.k === 'pillarBuild') { if (e.ok && station == null) station = t; if (!e.ok) tally(buildWhy, String(e.why).replace(/-?\d+,-?\d+,-?\d+/g, '#').slice(0, 60)) }
        if (e.k === 'pillarPlan') { if (e.no) { rNull++; for (const kk of Object.keys(e.no)) tally(planNo, kk.slice(0, 50)) } else if (e.R === false) aPlan++; else if (e.R && Pr == null) Pr = e.H[1] }
        if (e.k === 'bedDone') beds.push({ t, dmg: e.dmg, R: e.runnerY != null, y: e.runnerY, why: e.why, oc: e.oc })
        if (e.k === 'pillarRun') { chains.push((e.booms || []).filter(b => typeof b === 'number').length); tally(runWhy, String(e.why).slice(0, 40)) }
      }
    }
    for (const b of beds) {
      if (typeof b.dmg !== 'number') continue
      if (b.R) { dmgR.push(b.dmg); if (Pr != null) (b.y > Pr ? dmgP1 : dmgP0).push(b.dmg) } else dmgOther.push(b.dmg)
    }
    const won = !!(r.killed && !r.died)
    R.push({ k, won, died: !!r.died, portal: !!r.portal, beds: r.bedsTotal, killSecs: r.killSecs, secs: r.secs, landing, station, early: station != null && (landing == null || station < landing), before: beds.filter(b => station == null || b.t < station).length, nBeds: beds.length, dmgs: beds.map(b => b.dmg), chain: chains.length ? Math.max(...chains) : 0, hp: r.dragonHp, rNull, aPlan, cause: r.cause, stopped: r.stopped, sword: r.sword || null })
  }
  R.sort((a, b) => a.k - b.k)
  const n = R.length; const w = R.filter(r => r.won)
  console.log(`${tag}: боёв ${n} (+ сцена не поднялась ${scene.length}), побед ${w.length} (${Math.round(100 * w.length / Math.max(1, n))}%), из них ≤4 кроватей ${w.filter(r => r.beds <= 4).length}, ≤5 ${w.filter(r => r.beds <= 5).length}; смертей ${R.filter(r => r.died).length}; портал ${R.filter(r => r.portal).length}`)
  console.log(`  станция есть ${R.filter(r => r.station != null).length}/${n}, до первого снижения ${R.filter(r => r.early).length}/${n}; станция p50 ${q(R.map(r => r.station), 0.5)} с, первое снижение p50 ${q(R.map(r => r.landing), 0.5)} с; убийство p50 ${q(w.map(r => r.killSecs), 0.5)} с`)
  console.log(`  кроватей до станции ${R.reduce((s, r) => s + r.before, 0)} (боёв с такими ${R.filter(r => r.before).length}); план R пуст в ${R.filter(r => r.rNull).length} боях, станция A в ${R.filter(r => r.aPlan).length}`)
  const all = R.flatMap(r => r.dmgs).filter(x => typeof x === 'number')
  console.log(`  урон за кровать p25/p50/p90: все ${q(all, 0.25)}/${q(all, 0.5)}/${q(all, 0.9)} (n ${all.length}); R ${q(dmgR, 0.25)}/${q(dmgR, 0.5)}/${q(dmgR, 0.9)} (n ${dmgR.length}; P ${q(dmgP0, 0.5)} n ${dmgP0.length}, P+1 ${q(dmgP1, 0.5)} n ${dmgP1.length}); прочие ${q(dmgOther, 0.5)} (n ${dmgOther.length}); цепочка max p50 ${q(R.filter(r => r.station != null).map(r => r.chain), 0.5)}`)
  console.log(`  стройка — отказы: ${JSON.stringify(Object.entries<any>(buildWhy).sort((a, b) => b[1] - a[1]).slice(0, 8))}`)
  console.log(`  цепочки — конец: ${JSON.stringify(Object.entries<any>(runWhy).sort((a, b) => b[1] - a[1]).slice(0, 8))}`)
  { const sw = R.filter(r => r.sword && r.sword.length); if (sw.length) { const hits = sw.reduce((a, r) => a + r.sword.reduce((b, x) => b + (x.hits || 0), 0), 0); const by: Record<string, any> = {} as Record<string, any>; for (const r of sw) for (const x of r.sword) for (const [k, v] of Object.entries<any>(x.by || {} as Record<string, any>)) by[k] = (by[k] || 0) + v; console.log('  меч (ND_RUN_SWORD): боёв ' + sw.length + ', ударов ' + hits + ' ' + JSON.stringify(by) + ', побед ' + sw.filter(r => r.won).length + ', концы ' + JSON.stringify(sw.flatMap(r => r.sword.map(x => x.why)))) } }
  if (Object.keys(planNo).length) console.log(`  план пуст: ${JSON.stringify(Object.entries<any>(planNo).sort((a, b) => b[1] - a[1]).slice(0, 6))}`)
  if (scene.length) console.log(`  сцена: ${scene.map(s => `s${s.k} ${s.why}`).join('; ')}`)
  if (process.env.ROWS) for (const r of R) console.log(`  s${r.k} ${r.won ? 'ПОБЕДА' : r.died ? 'СМЕРТЬ ' + JSON.stringify(r.cause || {} as Record<string, any>).slice(0, 80) : 'проигрыш'} кров ${r.beds} снижение ${r.landing} станция ${r.station} до ${r.before} урон ${JSON.stringify(r.dmgs)} цепь ${r.chain} хп ${r.hp} убит ${r.killSecs}${r.sword ? ' меч ' + JSON.stringify(r.sword.map(x => [x.hits, x.hp0, x.hpMin, x.why])) : ''} ${r.stopped || ''}`.slice(0, 260))
}
