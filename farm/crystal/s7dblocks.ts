'use strict'
// Блоки в бою по всем сериям (S7d, пункт G): приём → поставил/сломал (успех/попыток, среднее время), по наборам;
// ошибки (не подтвердил сервер, своя опора); приёмы-метки боя с блоками (used): стенка, укрытие, коробка, столб…
//   node farm/crystal/s7dblocks.js farm/results/s7d-g-27 farm/results/s7d-i-29 …
const fs = require('fs')
const path = require('path')

const agg = { place: {}, dig: {} }
const err = { nc: 0, os: 0 }
const labels = {}
const LABEL = /укрыт|колонн|столб|коробк|мост|ступен|заслон|блок(ом| между)|обсидиан вокруг|опору|стенк|паутин|лава под|лаву|наковальн|прорубаю|выломал|пробил|залил водой|вода под себя/
let rounds = 0
for (const dir of process.argv.slice(2)) {
  // Испорченные серии (мир «приключение», бесконечное насыщение карты) — не в сводку, даже если попали в маску.
  if (!fs.existsSync(dir) || /invalid/.test(path.basename(dir))) continue
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.out')) continue
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      const i = line.indexOf('ROUND {')
      if (i < 0) continue
      let r = null
      try { r = JSON.parse(line.slice(i + 6)) } catch { continue }
      rounds++
      for (const s of [r.a, r.b]) {
        if (!s) continue
        const b = s.blockLog
        if (b) {
          for (const k of ['place', 'dig']) {
            for (const [t, e] of Object.entries<any>(b[k] || {})) {
              const tag = t.replace(/^прочее:.*/, 'прочее')
              const a = agg[k][tag] || (agg[k][tag] = { n: 0, ok: 0, msSum: 0, kits: new Set() })
              a.n += e.n; a.ok += e.ok; if (e.ms != null) a.msSum += e.ms * e.ok; a.kits.add(r.kit)
            }
          }
          err.nc += Number(b.errors?.notConfirmed) || 0; err.os += Number(b.errors?.ownSupport) || 0
        }
        for (const [k, v] of Object.entries<any>(s.tricks || {})) if (LABEL.test(k)) { const kk = k.replace(/\d+(\.\d+)?/g, '#'); labels[kk] = (labels[kk] || 0) + Number(v) }
      }
    }
  }
}
const fmt = (m) => Object.entries<any>(m).sort((a, b) => b[1].n - a[1].n).map(([t, a]) => `| ${t} | ${a.ok}/${a.n} | ${a.ok ? Math.round(a.msSum / a.ok) : '—'} мс | ${[...a.kits].join(', ')} |`).join('\n')
console.log(`Раундов: ${rounds}. Ошибки: не подтвердил сервер ${err.nc}, копал свою опору ${err.os}.`)
console.log('\n| поставил: приём | успех/попыток | время (игр. мс) | наборы |\n|---|---|---|---|')
console.log(fmt(agg.place))
console.log('\n| сломал: приём | успех/попыток | время (игр. мс) | наборы |\n|---|---|---|---|')
console.log(fmt(agg.dig))
console.log('\nМетки боя с блоками (раз): ' + Object.entries(labels).sort((a: any, b: any) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${v}`).join('; '))
