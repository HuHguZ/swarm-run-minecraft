'use strict'
import { REPO_ROOT, DIST_ROOT } from '../../daemon/src/paths'
// Пул хороших сидов + лава из скана → farm/seeds/good-v2.json (агент G, 02.10.2026).
//   node dist/farm/portal-scan/pool-merge.js            — взять good-v1.json и results-pool/*.json
// Поля сида (новые):
//   lava       — до ближайшей годной лавы, м по горизонтали от спавна (быстрейшая по оценке пути); false — в 200 м
//                годной нет; null — сид не сканирован
//   lavaClass  — rp (у руин) | surface (под небом) | open-cave (пещера, связанная воздухом с поверхностью)
//   lavaSrc, lavaDepth (м под поверхностью), lavaAt [x,y,z], lavaEst (оценка пути, с: 4 бл/с поверху, 1 с на уровень
//                вниз по открытой пещере)
//   rpLava     — источников лавы у ближайших руин (их рамка ±3), rpPlacement — как стоят руины, rpLavaOk — ≥ 10
//                (литья хватит)
//   start      — ключ «быстроты старта», меньше — лучше: lavaEst (или 600, если лавы нет) − 60 за годную лаву у руин +
//                деревня/8 (м → с ходьбы ~ /4, вес половина)
//   sky        — {d, cls, at, src}: ближайшая годная лава, видимая сверху (surface или rp с глубиной ≤ 3); null — нет в
//                квадрате скана. Подсказка portal-natural.js (hintFor, режим run с seed/hint)
// Годная лава — тело ≥ 10 источников (cast.js льёт 10 клеток по ведру). Скан — farm/portal-scan/scan.js (half 224).
import * as fs from 'fs'
import path = require('path')
const ROOT = REPO_ROOT
const V1 = path.join(ROOT, 'farm', 'seeds', 'good-v1.json')
const V2 = path.join(ROOT, 'farm', 'seeds', 'good-v2.json')
const DIR = path.join(REPO_ROOT, 'farm/portal-scan/results-pool')
const R = 200
const { skyOfScan } = require(path.join(DIST_ROOT, 'daemon', 'src', 'portal-natural'))

const v1 = JSON.parse(fs.readFileSync(V1, 'utf8'))
let scanned = 0
const seeds = v1.seeds.map(s0 => {
  const s: Record<string, any> = { ...s0 }
  const f = path.join(DIR, `${s.seed}.json`)
  if (!fs.existsSync(f)) return { ...s, lava: null, start: null }
  scanned++
  const r = JSON.parse(fs.readFileSync(f, 'utf8'))
  const cands = []
  for (const k of ['rp', 'surface', 'open-cave']) {
    const e = r.byClass[k]
    if (e && e.fastest10 && e.fastest10.near <= R) cands.push({ cls: k, ...e.fastest10 })
    if (e && e.nearest10 && e.nearest10.near <= R) cands.push({ cls: k, ...e.nearest10 })
  }
  cands.sort((a, b) => a.est - b.est)
  const best = cands[0] || null
  const rp = (r.ruinedPortals || [])[0] || null
  s.lava = best ? best.near : false
  s.lavaClass = best ? best.cls : null
  s.lavaSrc = best ? best.src : null
  s.lavaDepth = best ? best.depth : null
  s.lavaAt = best ? best.at : null
  s.lavaEst = best ? best.est : null
  s.rpLava = rp ? rp.lavaSrc : null
  s.rpPlacement = rp ? rp.placement : null
  s.rpScanD = rp ? rp.d : null
  s.rpLavaOk = !!(rp && rp.lavaSrc >= 10)
  // sky — годная лава, видимая сверху: озеро под небом или руины на поверхности (глубина ≤ 3), ближайшая по
  // горизонтали; подсказка для portal-natural (hintFor) — знание карты из копии этого же мира. Правило — skyOfScan.
  s.sky = skyOfScan(r)
  s.start = Math.round((best ? best.est : 600) - (s.rpLavaOk ? 60 : 0) + (s.village || 400) / 8)
  return s
})
const order = [...seeds].sort((a, b) => (a.start ?? 1e9) - (b.start ?? 1e9))
const out = {
  ...v1,
  version: v1.version,
  made: `${v1.made}; лава — скан farm/portal-scan/scan.js (агент G), ${new Date().toISOString().slice(0, 16)}`,
  note: `${v1.note} v2: lava — до годной лавы (≥ 10 источников) в ${R} м, класс rp/surface/open-cave; rpLava — лава у руин; отсортировано по start (быстрота старта: лава, руина с лавой, деревня). Сканировано ${scanned} из ${seeds.length}.`,
  seeds: order
}
fs.writeFileSync(V2, JSON.stringify(out, null, 1))
const done = seeds.filter(s => s.lava !== null)
const cls: Record<string, any> = {} as Record<string, any>
for (const s of done) cls[s.lavaClass || 'нет'] = (cls[s.lavaClass || 'нет'] || 0) + 1
const med = a => { a = a.filter(x => typeof x === 'number').sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null }
console.log(`good-v2.json: сканировано ${scanned}/${seeds.length}; лава в ${R} м: ${done.filter(s => s.lava !== false).length}/${done.length}; классы ${JSON.stringify(cls)}; медиана до лавы ${med(done.map(s => s.lava))} м; руины с лавой ≥ 10: ${done.filter(s => s.rpLavaOk).length}, ≥ 5: ${done.filter(s => (s.rpLava || 0) >= 5).length}`)
const skyD = done.map(s => s.sky ? s.sky.d : Infinity)
console.log(`видимая сверху (озеро/руины на поверхности): ${[96, 128, 160, 200, 256].map(R0 => `в ${R0} м ${skyD.filter(d => d <= R0).length}/${done.length}`).join(', ')}; медиана ${med(skyD.filter(Number.isFinite))} м`)
console.log('лучшие 10:', order.slice(0, 10).map(s => `${s.seed} (${s.lavaClass || '—'} ${s.lava} м, руина-лава ${s.rpLava}, деревня ${s.village})`).join('; '))
