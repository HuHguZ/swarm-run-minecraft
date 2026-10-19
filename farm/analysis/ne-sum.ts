'use strict'
import { REPO_ROOT } from '../../daemon/src/paths'
// Сводка партий потока nether-end (dev-F): node dist/farm/analysis/ne-sum.js <тег> [тег…]
// По каждой попытке — строка; в конце n, успехов, медиана минут (по успешным и всем), смерти.
import * as fs from 'fs'
import path = require('path')
const R = path.join(REPO_ROOT, 'farm/results')
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const rows = []
const PIECES = process.argv[2] === '--pieces'
for (const tag of PIECES ? [] : process.argv.slice(2)) {
  let files = []
  try { files = fs.readdirSync(path.join(R, tag)).filter(f => /^slot-\d+\.jsonl$/.test(f)) } catch { console.log(`${tag}: нет папки`); continue }
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(R, tag, f), 'utf8').split('\n')) {
      if (!l.trim()) continue
      try { rows.push({ tag, slot: /\d+/.exec(f)[0], ...JSON.parse(l) }) } catch {}
    }
  }
}
for (const r of rows) {
  const t = r.reachedAt ?? r.minutes ?? (r.seconds != null ? Math.round(r.seconds / 6) / 10 : null)
  const extra = [
    r.rods != null ? `стержней ${r.rods}` : '',
    r.pearls != null ? `жемчуг ${r.pearls}` : '',
    r.ingotsTraded != null ? `слитков ${r.ingotsTraded}` : '',
    r.goldBlocks != null ? `блоков ${r.goldBlocks}` : '',
    r.bastion && r.bastion.type ? `тип ${r.bastion.type}` : '',
    r.marks ? `отметки ${JSON.stringify(r.marks)}` : ''
  ].filter(Boolean).join(', ')
  console.log(`${r.tag}:${r.slot} ${r.ok ? 'OK ' : 'не '} ${t ?? '?'} мин, смертей ${r.deathCount ?? '?'} — ${String(r.stoppedBy || r.class || '').slice(0, 70)}${extra ? ' | ' + extra : ''}`)
}
const real = rows.filter(r => !r.setupFail)
const ok = real.filter(r => r.ok)
const tm = r => r.reachedAt ?? r.minutes ?? (r.seconds != null ? r.seconds / 60 : null)
if (!PIECES) console.log(`\nпопыток ${real.length} (+${rows.length - real.length} сорвано на подготовке), успехов ${ok.length}` +
  `, медиана времени успешных ${med(ok.map(tm).filter(x => x != null)) ?? '—'} мин` +
  `, смертей всего ${real.reduce((n, r) => n + (r.deathCount || 0), 0)}, попыток со смертью ${real.filter(r => r.deathCount).length}`)

// --- Куски по журналам кампании (node dist/farm/analysis/ne-sum.js --pieces <тег-префикс>…): бастион (блоки, слитки, жемчуг),
// крепость (у спавнера, стержни), смерти, вехи — и для оборванных попыток (без итога в jsonl).
if (process.argv[2] === '--pieces') {
  const out = []
  for (const pre of process.argv.slice(3)) {
    for (const tag of fs.readdirSync(R).filter(d => d.startsWith(pre))) {
      for (const f of fs.readdirSync(path.join(R, tag)).filter(f => /\.campaign\.log$/.test(f))) {
        const t = fs.readFileSync(path.join(R, tag, f), 'utf8')
        const rows = t.split('\n')
        const min = l => { const m = /\+\s*(\d+)м\]/.exec(l); return m ? Number(m[1]) : null }
        let blocks = 0; let ingots = 0; let pearls = 0; let rods = 0; let spawnerAt = null; let rodsAt = null; let goldAt = null
        for (const l of rows) {
          let m = /золотых блоков (\d+), слитков пиглинам (\d+), в рюкзаке (\{[^}]*\})/.exec(l)
          if (m) { blocks += Number(m[1]); ingots += Number(m[2]); try { pearls = Math.max(pearls, JSON.parse(m[3]).ender_pearl || 0) } catch {} if (Number(m[1]) > 0 && goldAt == null) goldAt = min(l) }
          m = /стержней: (\d+)/.exec(l)
          if (m) { rods = Math.max(rods, Number(m[1])); if (Number(m[1]) >= 7 && rodsAt == null) rodsAt = min(l) }
          if (/у спавнера \{/.test(l) && spawnerAt == null) spawnerAt = min(l)
        }
        const deaths = rows.filter(l => /умер — проверяю/.test(l)).length
        const last = rows.filter(Boolean).pop() || ''
        out.push({ tag, blocks, ingots, pearls, goldAt, spawnerAt, rods, rodsAt, deaths, end: min(last), miles: rows.filter(l => /ВЕХА/.test(l)).map(l => (/ВЕХА (\S+)/.exec(l) || [])[1]).join(',') })
      }
    }
  }
  for (const r of out) console.log(`${r.tag}: бастион ${r.blocks} бл./${r.ingots} сл./жемчуг ${r.pearls}${r.goldAt != null ? ` (золото на ${r.goldAt}м)` : ''}; спавнер ${r.spawnerAt ?? '—'}м, стержней ${r.rods}${r.rodsAt != null ? ` (7+ на ${r.rodsAt}м)` : ''}; смертей ${r.deaths}; конец ${r.end}м; вехи ${r.miles || '—'}`)
  const n = out.length
  const s = k => out.filter(r => r[k]).length
  console.log(`\nпопыток ${n}: с золотом ${out.filter(r => r.blocks > 0).length}, с бартером ≥ 9 жемчуга ${out.filter(r => r.pearls >= 9).length}, у спавнера ${s('spawnerAt')}, 7+ стержней ${out.filter(r => r.rods >= 7).length}, со смертью ${out.filter(r => r.deaths).length} (смертей ${out.reduce((a, r) => a + r.deaths, 0)})`)
}
