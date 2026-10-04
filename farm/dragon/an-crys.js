// Сводка серий «кристаллы с места ожидания» (03.10, поток dragon): node farm/dragon/an-crys.js <тег> [<тег2> ...]  (ROWS=1 — построчно)
// Итоги — farm/logs/<тег>-s<k>.jsonl (try-dragon e2e), трассы — farm/logs/trace-<тег>/s<k>/dragon-*.jsonl, CPU — CPU=<файл>
// (farm/dragon/cpu-log.js, по умолчанию farm/logs/cpu-crys.log): средняя загрузка за окно боя (первая → последняя запись трасс).
// Время — от платформы (секунды сцены): центр, станция, первый заход на посадку, убийство; кристаллы — выстрелов, сбито своими,
// живых по серверу после боя; A/B — PAIR=тегA,тегB: попарно по номеру боя (одни сиды).
const fs = require('fs'); const path = require('path')
const L = path.join(__dirname, '..', 'logs')
const q = (xs, p) => { const v = xs.filter(x => x != null && !Number.isNaN(x)).sort((a, b) => a - b); return v.length ? Math.round(v[Math.min(v.length - 1, Math.floor((v.length - 1) * p + 0.5))] * 10) / 10 : '-' }
const isoOf = f => { const m = /dragon-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d+)Z/.exec(f); return m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : 0 }
const cpuFile = process.env.CPU || path.join(L, 'cpu-crys.log')
const cpu = fs.existsSync(cpuFile) ? fs.readFileSync(cpuFile, 'utf8').trim().split('\n').map(l => { const [t, v] = l.split(' '); return { t: Date.parse(t), v: Number(v) } }).filter(x => x.t && !Number.isNaN(x.v)) : []
const cpuAvg = (a, b) => { const xs = cpu.filter(x => x.t >= a && x.t <= b); return xs.length ? Math.round(xs.reduce((s, x) => s + x.v, 0) / xs.length) : null }
function load (tag) {
  const files = fs.readdirSync(L).filter(f => f.startsWith(tag + '-s') && /-s\d+\.jsonl$/.test(f))
  const R = []
  for (const f of files) {
    const k = Number(/-s(\d+)\.jsonl$/.exec(f)[1])
    const r = fs.readFileSync(path.join(L, f), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).pop()
    if (!r || !r.calls) { R.push({ k, scene: true, why: r && (r.why || r.stopped) }); continue }
    const traces = (r.traces || []).filter(t => fs.existsSync(t)).sort((a, b) => isoOf(a) - isoOf(b))
    const t0 = traces.length ? isoOf(traces[0]) : 0
    let approach = null; let landing = null; let tEnd = t0; let shots = 0; let ours = 0; let moves = 0; let strafes = 0; let strafeAfter = 0; let lastShotT = -1e9
    let perches = 0; let digUp = null; const swordKill = []; let swordMore = null; let refused = 0; let noSpot = 0
    const cr = new Map()
    for (const tf of traces) {
      const off = isoOf(tf) - t0
      for (const l of fs.readFileSync(tf, 'utf8').split('\n')) {
        if (!l || l.includes('"k":"d') || l.includes('"k":"s"') || l.includes('"k":"runnerHeight"')) continue
        let e; try { e = JSON.parse(l) } catch { continue }
        const t = (e.t + off) / 1000
        tEnd = Math.max(tEnd, isoOf(tf) + e.t)
        if (e.k === 'phase') {
          if (e.ph === 2 && approach == null) approach = t
          if (e.ph === 3 && landing == null) landing = t
          if (e.ph === 3) perches++
          if (e.ph === 1) { strafes++; if (t - lastShotT < 6) strafeAfter++ }
        }
        if (e.k === 'crysShot') { shots++; lastShotT = t; const c = cr.get(e.id) || { shots: 0, y: null, hit: false }; c.shots++; if (e.y != null) c.y = e.y; c.lob = c.lob || e.mode === 'lob'; cr.set(e.id, c) }
        if (e.k === 'crysGone' && e.ours) { ours++; const c = cr.get(e.id) || { shots: 0 }; c.hit = true; c.y = e.at ? e.at[1] : c.y; c.t = t; cr.set(e.id, c) }
        if (e.k === 'crysKnown' && e.y != null) { const c = cr.get(e.id) || { shots: 0, hit: false }; c.y = c.y ?? e.y; c.caged = e.caged; cr.set(e.id, c) }
        if (e.k === 'crysMove') moves++
        if (e.k === 'crysRefused') refused++
        if (e.k === 'crysNoSpot') noSpot++
        if (e.k === 'digUp' && digUp == null) digUp = { t, ok: e.ok, up: e.up, ms: e.ms, first: !!e.first }
        if (e.k === 'runnerSword' && e.why === 'убит') swordKill.push(t)
        if (e.k === 'swordMore' && swordMore == null) swordMore = { t, hp: e.hp }
      }
    }
    // Сцена упала после победы («бот не в игре» после портала домой) — лаунчер повторил бой в том же мире (дракон воскрешён):
    // засчитывать первую попытку — её трасса (не из r.traces) кончилась победой; время — фаза «умирает» от начала трассы.
    let retryWin = null
    {
      const td = path.join(L, `trace-${tag}`, `s${k}`)
      const own = new Set(traces.map(t => path.resolve(t)))
      if (fs.existsSync(td) && t0) {
        for (const tf of fs.readdirSync(td).filter(x => /^dragon-/.test(x)).map(x => path.join(td, x)).sort((a, b) => isoOf(a) - isoOf(b))) {
          if (own.has(path.resolve(tf)) || isoOf(tf) >= t0) continue
          const ls = fs.readFileSync(tf, 'utf8').split('\n')
          if (!ls.some(l => l.includes('"k":"end"') && l.includes('"won":true'))) continue
          const dy = ls.find(l => l.includes('"k":"phase"') && (l.includes('"ph":9') || l.includes('"hp":0,')))
          let t = null; try { t = dy ? Math.round(JSON.parse(dy).t / 1000) : null } catch {}
          retryWin = { killSecs: t }
          break
        }
      }
    }
    const won = !!(r.killed && !r.died) || !!retryWin
    if (retryWin) { r.killSecs = retryWin.killSecs; r.bedsTotal = r.bedsTotal || 4 }
    const cs = String(r.crystalsServer || '').split('->').map(Number)
    const lastHit = [...cr.values()].filter(c => c.hit && c.t != null).reduce((m, c) => Math.max(m, c.t), 0) || null
    R.push({ k, cr: [...cr.values()], lastHit, won, retry: !!retryWin, died: !!r.died, beds: r.bedsTotal, killSecs: r.killSecs, secs: r.secs, center: r.centerSecs, station: r.stationSecs, approach, landing, perches, shots, ours, moves, refused, noSpot, strafes, strafeAfter, crysEnd: Number.isFinite(cs[1]) ? cs[1] : null, crys0: Number.isFinite(cs[0]) ? cs[0] : null, cpu: t0 ? cpuAvg(t0, tEnd) : null, digUp, swordKill: swordKill.length, swordMore, hp: r.dragonHp, cause: r.cause, stopped: r.stopped, wait: r.crysWait })
  }
  return R.sort((a, b) => a.k - b.k)
}
function sum (tag, R) {
  const F = R.filter(r => !r.scene); const n = F.length; const w = F.filter(r => r.won)
  const pc = x => Math.round(100 * x / Math.max(1, n))
  console.log(`${tag}: боёв ${n} (сцена ${R.length - n}), побед ${w.length} (${pc(w.length)}%), ≤4 кроватей ${w.filter(r => r.beds <= 4).length}; смертей ${F.filter(r => r.died).length}`)
  console.log(`  убийство p50 ${q(w.map(r => r.killSecs), 0.5)} с (p25 ${q(w.map(r => r.killSecs), 0.25)}, p75 ${q(w.map(r => r.killSecs), 0.75)}); центр p50 ${q(F.map(r => r.center), 0.5)}, станция p50 ${q(F.map(r => r.station), 0.5)}, 1-й заход p50 ${q(F.map(r => r.approach), 0.5)} (p75 ${q(F.map(r => r.approach), 0.75)}), посадок p50 ${q(F.map(r => r.perches), 0.5)}`)
  console.log(`  кристаллы: выстрелов ${F.reduce((s, r) => s + r.shots, 0)} (p50 ${q(F.map(r => r.shots), 0.5)}), сбито своими ${F.reduce((s, r) => s + r.ours, 0)} (p50 ${q(F.map(r => r.ours), 0.5)}), живых после боя p50 ${q(F.map(r => r.crysEnd), 0.5)}; переходов ${F.reduce((s, r) => s + r.moves, 0)}, отказов ${F.reduce((s, r) => s + r.refused, 0)}, «нет точки» ${F.reduce((s, r) => s + r.noSpot, 0)}; заходов с фаерболом ${F.reduce((s, r) => s + r.strafes, 0)} (в 6 с после выстрела ${F.reduce((s, r) => s + r.strafeAfter, 0)})`)
  {
    // по кристаллам (открытых в мире всегда 8: SpikeFeature guarded — j = 1, 2): сбито из 8, выстрелов на сбитый, по высоте
    const crs = F.flatMap(r => r.cr || [])
    if (crs.length) {
      const bins = [[0, 86, 'y < 86'], [86, 96, 'y 86–95'], [96, 999, 'y ≥ 96']]
      const parts = bins.map(([a, b, nm]) => { const xs = crs.filter(c => c.y != null && c.y >= a && c.y < b && c.shots); const h = xs.filter(c => c.hit); return `${nm}: сбито ${h.length}/${xs.length}, стрел на сбитый ${h.length ? Math.round(10 * h.reduce((s, c) => s + c.shots, 0) / h.length) / 10 : '-'}` })
      const hit = F.reduce((s, r) => s + r.ours, 0)
      console.log(`  сбито открытых: ${hit} из ${8 * F.length} (${Math.round(100 * hit / Math.max(1, 8 * F.length))} %), из 10 — ${Math.round(100 * hit / Math.max(1, 10 * F.length))} %; стрел на сбитый ${Math.round(10 * F.reduce((s, r) => s + r.shots, 0) / Math.max(1, hit)) / 10}; все 8 сбиты к p50 ${q(F.map(r => r.ours >= 8 ? r.lastHit : null), 0.5)} с; ${parts.join('; ')}; навесом ${crs.filter(c => c.lob).length}`)
    }
  }
  const lo = F.filter(r => r.cpu != null && r.cpu <= 70); const hi = F.filter(r => r.cpu != null && r.cpu > 70)
  console.log(`  CPU за бой p50 ${q(F.map(r => r.cpu), 0.5)} %, max ${q(F.map(r => r.cpu), 1)}; бои при CPU ≤ 70 %: ${lo.filter(r => r.won).length}/${lo.length}; > 70 %: ${hi.filter(r => r.won).length}/${hi.length}`)
  const du = F.filter(r => r.digUp); if (du.length) console.log(`  шахта вверх: ${du.length} (сначала ${du.filter(r => r.digUp.first).length}, ок ${du.filter(r => r.digUp.ok).length}), центр в этих боях p50 ${q(du.map(r => r.center), 0.5)}`)
  const sm = F.filter(r => r.swordMore); if (sm.length) console.log(`  меч после кроватей (swordMore): ${sm.length}, из них побед ${sm.filter(r => r.won).length}`)
  const rt = F.filter(r => r.retry); if (rt.length) console.log(`  сцена упала после победы, засчитана первая попытка: ${rt.map(r => 's' + r.k).join(', ')} (прочие поля — из повтора)`)
  if (process.env.ROWS) for (const r of R) console.log(r.scene ? `  s${r.k} СЦЕНА ${r.why}` : `  s${r.k} ${r.won ? (r.retry ? 'ПОБЕДА(1-я попытка)' : 'ПОБЕДА') :r.died ? 'СМЕРТЬ ' + JSON.stringify(r.cause || {}).slice(0, 70) : 'проигрыш'} убит ${r.killSecs} центр ${r.center} станция ${r.station} заход ${r.approach} посадок ${r.perches} выстр ${r.shots} сбито ${r.ours} крист ${r.crys0}->${r.crysEnd} стрейф ${r.strafes}/${r.strafeAfter} cpu ${r.cpu}${r.digUp ? ' шахта ' + JSON.stringify(r.digUp) : ''}${r.swordMore ? ' меч+ ' + r.swordMore.hp : ''} хп ${r.hp} ${r.stopped || ''}`.slice(0, 300))
}
const tags = process.argv.slice(2)
const all = {}
for (const tag of tags) { all[tag] = load(tag); sum(tag, all[tag]) }
if (process.env.PAIR) {
  const [a, b] = process.env.PAIR.split(','); const A = all[a] || load(a); const B = all[b] || load(b)
  const bk = new Map(B.filter(r => !r.scene).map(r => [r.k, r]))
  const pairs = A.filter(r => !r.scene && bk.has(r.k)).map(r => [r, bk.get(r.k)])
  const both = pairs.filter(([x, y]) => x.won && y.won)
  const dt = both.map(([x, y]) => x.killSecs - y.killSecs)
  console.log(`A/B ${a} − ${b}: пар ${pairs.length}; победы ${pairs.filter(p => p[0].won).length} / ${pairs.filter(p => p[1].won).length}; только A ${pairs.filter(p => p[0].won && !p[1].won).length}, только B ${pairs.filter(p => !p[0].won && p[1].won).length}; разница убийства (обе победы, n ${both.length}) p50 ${q(dt, 0.5)} с, p25 ${q(dt, 0.25)}, p75 ${q(dt, 0.75)}`)
}
