'use strict'
import { REPO_ROOT } from '../../src/paths'
// Сводка серий потока movement по farm/results/<tag>/slot-*.jsonl (медианы по удачным, доля дошедших, урон, блоки).
//   node try-lab-mv-sum.js gap <tag...>          — стенд try-lab-mv-gap.js: сцена × режим
//   node try-lab-mv-sum.js terrain <tag> [A B]   — рельеф try-lab-mv-terrain.js: режимы и парное сравнение A/B по ногам
//   node try-lab-mv-sum.js pair <tagA> <tagB>    — рельеф: те же ноги и режимы в двух сериях (до/после правки)
//   node try-lab-mv-sum.js mlg <tag...>          — try-lab-mlg-drop.js: поверхность/высота/режим, все пробы
import * as fs from 'fs'
import path = require('path')

const RES = path.join(REPO_ROOT, 'farm/results')
function load (tag) {
  const dir = path.join(RES, tag)
  const rows = []
  for (const f of fs.readdirSync(dir).filter(f => /^slot-\d+\.jsonl$/.test(f))) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (l.trim()) { try { rows.push(JSON.parse(l)) } catch {} } }
  }
  return rows
}
const med = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const sec = ms => (ms / 1000).toFixed(2)

function gap (tags) {
  const rows = tags.flatMap(load).filter(r => r.scene)
  const by: Record<string, any> = {} as Record<string, any>
  for (const r of rows) { (by[r.scene] = by[r.scene] || {} as Record<string, any>); (by[r.scene][r.mode] = by[r.scene][r.mode] || []).push(r) }
  for (const [sc, modes] of Object.entries<any>(by)) {
    const base = modes.base ? med(modes.base.filter(r => r.ok).map(r => r.ms)) : NaN
    const parts = Object.entries<any>(modes).map(([m, rs]: any) => {
      const valid = rs.filter(r => !/не на плите|сцена/.test(r.error || ''))
      const ok = valid.filter(r => r.ok)
      const t = med(ok.map(r => r.ms))
      const rel = Number.isFinite(base) && m !== 'base' && ok.length ? ` (${Math.round((t / base - 1) * 100)} %)` : ''
      const dmg = valid.filter(r => (r.minHp ?? 20) < 20).length
      const fell = valid.filter(r => r.fell).length
      return `${m} ${ok.length}/${valid.length} ${ok.length ? sec(t) : '—'}${rel}${fell ? ' падений ' + fell : ''}${dmg ? ' урон ' + dmg : ''}`
    })
    console.log(sc.padEnd(12), parts.join(' | '))
  }
}

function terrain (tag: any, A: any, B: any) {
  const rows = load(tag)
  const modes = [...new Set(rows.map(r => r.mode))]
  for (const m of modes) {
    const rs = rows.filter(r => r.mode === m); const ok = rs.filter(r => r.ok)
    console.log(m.padEnd(22), `дошли ${ok.length}/${rs.length}, медиана ${sec(med(ok.map(r => r.ms)))} с, истощение ${med(rs.filter(r => r.exhaust != null).map(r => r.exhaust)).toFixed(2)}, урон ${rs.filter(r => r.minHp < 20).length}`)
  }
  A = A || modes[0]; B = B || modes[1]
  if (!A || !B) return
  const legs: Record<string, any> = {} as Record<string, any>
  for (const r of rows) { const k = r.slot + ':' + r.leg; (legs[k] = legs[k] || {} as Record<string, any>)[r.mode] = r }
  const pairs = Object.values<any>(legs).filter(l => l[A] && l[B] && l[A].ok && l[B].ok)
  const rel = pairs.map(l => l[B].ms / l[A].ms - 1)
  const sA = pairs.reduce((a, l) => a + l[A].ms, 0); const sB = pairs.reduce((a, l) => a + l[B].ms, 0)
  console.log(`пары ${pairs.length}: ${B} к ${A} — медиана ${Math.round(med(rel) * 100)} %, сумма ${Math.round((sB / sA - 1) * 100)} %, быстрее в ${rel.filter(x => x < 0).length}`)
}

function pair (ta: any, tb: any) {
  const key = r => `${r.slot}:${r.leg}:${r.mode}`
  const a = Object.fromEntries(load(ta).map(r => [key(r), r])); const b = Object.fromEntries(load(tb).map(r => [key(r), r]))
  const ks = Object.keys(a).filter(k => b[k] && a[k].ok && b[k].ok)
  const rel = ks.map(k => b[k].ms / a[k].ms - 1)
  console.log(`пары ${ks.length}: ${tb} к ${ta} — медиана ${Math.round(med(rel) * 100)} %, быстрее в ${rel.filter(x => x < 0).length}; дошли ${Object.values<any>(a).filter(r => r.ok).length} / ${Object.values<any>(b).filter(r => r.ok).length}`)
}

function mlg (tags) {
  for (const tag of tags) {
    const rows = load(tag)
    const by: Record<string, any> = {} as Record<string, any>
    for (const r of rows) { const k = `${r.surf}/${r.H}/${r.mode}`; (by[k] = by[k] || []).push(r) }
    console.log(`${tag}: удачно ${rows.filter(r => r.ok).length}/${rows.length}, с уроном ${rows.filter(r => r.minHp < 20).length}`)
    console.log('  ' + Object.entries<any>(by).map(([k, rs]: any) => `${k}: ${rs.map(r => (r.ok ? '' : 'X') + (r.ms / 1000).toFixed(1) + (r.minHp < 20 ? '!' + r.minHp : '')).join(',')}`).join(' | '))
  }
}

const [what, ...args] = process.argv.slice(2)
if (what === 'gap') gap(args)
else if (what === 'terrain') terrain(args[0], args[1], args[2])
else if (what === 'pair') pair(args[0], args[1])
else if (what === 'mlg') mlg(args)
else console.log(fs.readFileSync(__filename.replace(/\.js$/, '.ts'), 'utf8').split('\n').slice(1, 7).join('\n'))
