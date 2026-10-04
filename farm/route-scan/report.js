'use strict'
// Сводка серий «новый мир → вход в Ад» (поток route): доля вошедших, время входа (медиана, p90), смерти, класс
// неудачи, время по шагам маршрута (строки «МАРШРУТ шаг <id> ok|НЕ ВЫШЕЛ за N с» журнала кампании).
//   node farm/route-scan/report.js <tag> [<tag> ...] [--steps] [--json]
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..', '..')
const args = process.argv.slice(2)
// --seeds <файл> — только сиды из файла (через запятую); --as <имя> — все серии одной строкой сводки.
const optVal = k => { const i = args.indexOf(k); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v }
const seedsFile = optVal('--seeds')
const asName = optVal('--as')
const seedSet = seedsFile ? new Set(fs.readFileSync(seedsFile, 'utf8').trim().split(/[,s]+/)) : null
const tags = args.filter(a => !a.startsWith('--'))
const wantSteps = args.includes('--steps')
const asJson = args.includes('--json')

const q = (a, f) => { const v = a.slice().sort((x, y) => x - y); if (!v.length) return null; const i = Math.min(v.length - 1, Math.max(0, Math.ceil(f * v.length) - 1)); return v[i] }
const med = a => { const v = a.slice().sort((x, y) => x - y); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }

function rows (tag) {
  const dir = path.join(ROOT, 'farm', 'results', tag)
  const out = []
  for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean)
    for (const l of lines) {
      let r
      try { r = JSON.parse(l) } catch { continue }
      r.slot = Number(/slot-(\d+)/.exec(f)[1])
      let text = ''
      try { text = fs.readFileSync(path.join(dir, r.campaignLog), 'utf8') } catch {}
      r.steps = []
      for (const m of text.matchAll(/МАРШРУТ шаг (\S+) (ok|НЕ ВЫШЕЛ) за (\d+) с \(бюджет (\d+) с\)/g)) r.steps.push({ id: m[1], ok: m[2] === 'ok', s: Number(m[3]), budget: Number(m[4]) })
      const plan = /МАРШРУТ маршрут \[([^\]]+)\]/.exec(text)
      r.route = plan ? plan[1] : null
      // Когда вошёл: момент смены измерения по журналу (portal enter → done и тело в Аду) или reachedAt сцены.
      r.enterMin = r.ok ? r.reachedAt : null
      // Первый вход — по строке «Я в Аду» журнала: этап Ада возвращается домой раньше, чем сцена заметит Ад (rt-L2 слот
      // 14), или сцена ловит второй вход (rt-R6 слот 29: вошёл на 9.9 мин, сцена записала 23.7).
      {
        const st = /==== \d{4}-\d\d-\d\d (\d\d):(\d\d):(\d\d) запуск/.exec(text)
        // «Мир сменился (верхний мир → Ад)» — тоже вход (тело не устроилось за 15 с, но в Аду было: rt3-A2 слот 27).
        const en = /\[(\d\d):(\d\d):(\d\d) [^\]]*\][^\n]*portal \{"mode":"enter"[^\n]*(?:Я в Аду|Мир сменился \(верхний мир → Ад\))/.exec(text)
        if (st && en) {
          const sec = x => (+x[1]) * 3600 + (+x[2]) * 60 + (+x[3])
          let d = sec(en) - sec(st)
          if (d < 0) d += 86400
          const m = Math.round(d / 6) / 10
          if (!r.ok) r.class = (r.class || '') + ' (вошёл и вернулся)'
          if (!r.ok || r.enterMin == null || m < r.enterMin) r.enterMin = m
          r.ok = true
        }
      }
      const lit = /ВЕХА (?:cast|portal|route)[^\n]*?(\d+) мин от запуска/.exec(text)
      const litLine = text.split('\n').find(l => /МАРШРУТ шаг lava:\S+ ok|ВЕХА (cast|portal):/.test(l))
      r.litMin = litLine ? Number((/\+\s*(\d+)м\]/.exec(litLine) || [])[1]) : null
      void lit
      // Кровать и сон (раунд 3): минута первой кровати в рюкзаке, сколько раз ночь проскочила сном; минута смерти.
      {
        const bm = /\[\d\d:\d\d:\d\d \+\s*(\d+)м\][^\n]*_bed×/.exec(text)
        r.bedMin = bm ? Number(bm[1]) : null
        r.sleeps = (text.match(/МАРШРУТ сон: утро|ночь — сплю/g) || []).length
        const dm = /\[\d\d:\d\d:\d\d \+\s*(\d+)м\][^\n]*умер — проверяю/.exec(text)
        r.deathMin = dm ? Number(dm[1]) : null
      }
      r.tag = tag
      out.push(r)
    }
  }
  return out
}

const all = tags.flatMap(rows).filter(r => !seedSet || seedSet.has(String(r.seed))).map(r => (asName ? { ...r, tag: asName } : r))
const byTag = {}
for (const r of all) (byTag[r.tag] = byTag[r.tag] || []).push(r)
const summary = {}
for (const [tag, rs] of Object.entries(byTag)) {
  const ok = rs.filter(r => r.ok)
  const t = ok.map(r => r.enterMin).filter(x => x != null)
  const cls = {}
  for (const r of rs.filter(r => !r.ok)) { const k = String(r.class || r.stoppedBy || '?').replace(/@.*$/, ''); cls[k] = (cls[k] || 0) + 1 }
  const steps = {}
  for (const r of rs) for (const s of r.steps) { const k = s.id.replace(/^ore:.*/, 'ore'); (steps[k] = steps[k] || { n: 0, ok: 0, s: [] }); steps[k].n++; if (s.ok) steps[k].ok++; steps[k].s.push(s.s) }
  summary[tag] = {
    n: rs.length,
    entered: ok.length,
    enterMedianMin: med(t),
    enterP90Min: q(t, 0.9),
    deaths: rs.reduce((a, r) => a + (r.deathCount || 0), 0),
    runsWithDeath: rs.filter(r => (r.deathCount || 0) > 0).length,
    portalLit: rs.filter(r => r.litMin != null || r.ok).length,
    bedBy10: rs.filter(r => r.bedMin != null && r.bedMin < 10).length,
    slept: rs.filter(r => r.sleeps > 0).length,
    deathsNight: rs.filter(r => (r.deathCount || 0) > 0 && r.deathMin != null && r.deathMin >= 10).length,
    fail: cls,
    steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, `${v.ok}/${v.n}, медиана ${med(v.s)} с`]))
  }
}
if (asJson) { console.log(JSON.stringify({ summary, rows: all.map(r => ({ tag: r.tag, slot: r.slot, seed: r.seed, ok: r.ok, enterMin: r.enterMin, litMin: r.litMin, deaths: r.deathCount, deathMin: r.deathMin, bedMin: r.bedMin, sleeps: r.sleeps, class: r.class, route: r.route, steps: r.steps })) }, null, 1)); process.exit(0) }
for (const [tag, s] of Object.entries(summary)) {
  console.log(`=== ${tag}: в Аду ${s.entered}/${s.n}, время входа медиана ${s.enterMedianMin ?? '—'} мин, p90 ${s.enterP90Min ?? '—'}; портал горит ${s.portalLit}/${s.n}; смертей ${s.deaths} (прогонов со смертью ${s.runsWithDeath}, из них с 10-й мин ${s.deathsNight}); кровать к 10-й мин ${s.bedBy10}/${s.n}, спал ${s.slept}`)
  console.log(`    неудачи: ${Object.entries(s.fail).map(([k, v]) => `${k} ×${v}`).join(', ') || '—'}`)
  if (Object.keys(s.steps).length) console.log(`    шаги: ${Object.entries(s.steps).map(([k, v]) => `${k} ${v}`).join('; ')}`)
}
if (wantSteps) {
  for (const r of all.sort((a, b) => a.tag.localeCompare(b.tag) || a.slot - b.slot)) {
    console.log(`${r.tag} слот ${r.slot} ${r.seed}: ${r.ok ? `В АДУ ${r.enterMin} мин` : `нет (${r.class || r.stoppedBy})`}${r.litMin != null ? `, портал ${r.litMin} мин` : ''}, смертей ${r.deathCount || 0}${r.deathMin != null ? ` (${r.deathMin} мин)` : ''}, кровать ${r.bedMin ?? '—'} мин, сон ${r.sleeps}; ${r.route || ''}`)
    if (r.steps.length) console.log('    ' + r.steps.map(s => `${s.id}${s.ok ? '' : '✗'} ${s.s}с`).join(' → '))
  }
}
