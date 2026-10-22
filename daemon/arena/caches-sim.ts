'use strict'
// Офлайн-стенд поиска тайников (поток «тайники», 21.10): Колизей раунда как сетка (модель + раскладка + тайники раунда),
// копатели с моделью команды (swarm/cache-model): сканы лучами и «пирогом» по сетке — тем же кодом, что у демона
// (castRays, pieCounts), копка ходами planDig, «нашёл» — сундук тайника виден из глаз (луч входит в него первым).
// Время: дорога 4 бл/с (×1.3), копка digS на блок, ход по ходу 4 бл/с. Без сервера — быстрые замеры узора и «пирога».
//   node dist-loot/daemon/arena/caches-sim.js [раундов=10] [пирог 1|0] [копателей=3] [секунд=300] [digS=0.55] [мест осмотра=10] [память 0|1]
import * as C from './colosseum'
import * as CA from './colosseum-arms'
import { pickCaches } from './colosseum-caches'
import { CacheModel, castRays, pieCounts } from '../src/swarm/cache-model'

type P = { x: number; y: number; z: number }
const SEE = /carpet|banner|torch|button|glass|_pane|iron_bars|ladder|^light$|^air$|lantern|chain/

// views — со скольких мест свои осмотрелись в начале раунда (лут бродит по полю); memory — сундуки, увиденные в прошлых
// раундах (карта та же), дополняется увиденным в этом.
export function simRound (L: any, round: number, { pie = true, diggers = 3, seconds = 300, digS = 0.55, spin0 = 0, views = 10, memory = null as Map<string, P> | null } = {}) {
  const m0 = C.model({ R: 24, ceilH: 16 })
  const g = m0.g
  for (const [x, y, z, b] of [...L.field, ...L.set]) g.set(x, y, z, b === 'air' ? '' : String(b).replace(/\{.*$/, ''))
  for (let x = -L.R; x <= L.R; x++) for (let z = -L.R; z <= L.R; z++) if (!g.get(x, -1, z)) g.set(x, -1, z, 'sand') // пол поля кладут команды раскладки
  const caches = pickCaches(L, round)
  for (const c of caches) g.set(c.x, c.y, c.z, 'chest')
  const chests: P[] = [...L.chests.map((c: any) => ({ x: c.x, y: c.y, z: c.z })), ...caches.map(c => ({ x: c.x, y: c.y, z: c.z }))]
  const isChest = new Set(chests.map(c => `${c.x},${c.y},${c.z}`))
  const opaque = (x: number, y: number, z: number) => { const b = g.get(x, y, z); return b && !SEE.test(C.parse(b).name) ? 1 : 0 }
  const box = { x0: g.x0, x1: g.x1, y0: -1, y1: 44, z0: g.z0, z1: g.z1 }
  const model = new CacheModel(box)
  if (memory) for (const [k, c] of memory) model.known.set(k, { ...c })
  let spin = spin0
  const visible = (eye: P) => chests.filter(c => {
    const d = { x: c.x + .5 - eye.x, y: c.y + .5 - eye.y, z: c.z + .5 - eye.z }, n = Math.hypot(d.x, d.y, d.z)
    if (n > 40) return false
    for (let t = 0.3; t < n; t += 0.1) {
      const x = Math.floor(eye.x + d.x / n * t), y = Math.floor(eye.y + d.y / n * t), z = Math.floor(eye.z + d.z / n * t)
      if (x === c.x && y === c.y && z === c.z) return true
      if (opaque(x, y, z)) return false
    }
    return true
  })
  const scan = (feet: P) => {
    const eye = { x: feet.x, y: feet.y + 1.62, z: feet.z }
    spin = (spin + 0.618) % 1
    const vis = visible(eye)
    model.addScan({ eye, n: 700, spin, range: 56, hits: castRays(eye, opaque, 700, spin, 56), chests: vis.map(c => [c.x, c.y, c.z]), ...(pie ? { pie: { step: 5, range: 64, bins: pieCounts(eye, chests.filter(c => g.get(c.x, c.y, c.z) === 'chest'), 5, 64) } } : {}) })
    return vis
  }
  // Свои бродят по полю и рядам (лут): сканы с десятка мест в начале раунда.
  for (const [x, z] of [[-36, 0], [36, 0], [-12, -12], [12, 12], [-12, 12], [12, -12], [0, 0], [-20, 0], [20, 0], [0, 18]].slice(0, views)) {
    let y = 0; while (opaque(x, y, z) || opaque(x, y + 1, z)) y++
    scan({ x: x + .5, y, z: z + .5 })
  }
  const bots = Array.from({ length: diggers }, (_, k) => ({ p: { x: (k - 1) * 8 + .5, y: 0, z: .5 }, t: 0 }))
  const found: { at: P; t: number }[] = []
  const known = new Set<string>()
  for (let guard = 0; guard < 400; guard++) {
    const b = bots.reduce((a, c) => c.t < a.t ? c : a)
    if (b.t >= seconds || found.length === caches.length) break
    const others = bots.filter(o => o !== b)
    const plan = model.planDig(b.p, { digS, away: others.map(o => (o as any).to).filter(Boolean) })
    if (!plan) { b.t += 5; continue }
    ;(b as any).to = plan.to
    const travel = Math.hypot(plan.from.x + .5 - b.p.x, plan.from.y - b.p.y, plan.from.z + .5 - b.p.z) * 1.3 / 4
    const { dug } = model.dig(plan.from, plan.to)
    let solid = 0
    for (const c of dug.slice(0, 12)) { // dig_to за раз — до 6 шагов
      if (opaque(c.x, c.y, c.z)) { solid++; if (!isChest.has(`${c.x},${c.y},${c.z}`)) g.set(c.x, c.y, c.z, '') }
    }
    const walked = dug.slice(0, 12).filter((_, i) => i % 2 === 0)
    for (const w of walked) model.markWalked(w)
    const end = walked[walked.length - 1] || plan.from
    b.p = { x: end.x + .5, y: end.y, z: end.z + .5 }
    b.t += travel + solid * digS + walked.length / 4 + 0.5
    for (const c of scan(b.p)) {
      const k = `${c.x},${c.y},${c.z}`
      if (known.has(k)) continue
      known.add(k)
      const cache = caches.find(q => q.x === c.x && q.y === c.y && q.z === c.z)
      if (cache && Math.hypot(c.x + .5 - b.p.x, c.y + .5 - b.p.y - 1.62, c.z + .5 - b.p.z) < 6) { found.push({ at: c, t: Math.round(b.t) }); model.markFound(c) }
    }
  }
  if (memory) for (const [k, c] of model.known) if (!caches.some(q => `${q.x},${q.y},${q.z}` === k)) memory.set(k, c)
  return { caches: caches.map(c => ({ x: c.x, y: c.y, z: c.z })), found, time: Math.round(Math.max(...bots.map(b => b.t))) }
}

if (require.main === module) {
  const [rounds = '10', pie = '1', dg = '3', sec = '300', digS = '0.55', views = '10', mem = '0'] = process.argv.slice(2)
  const memory = mem === '1' ? new Map<string, P>() : null
  const L = CA.generate('team1')
  const firsts: number[] = []; let all = 0, total = 0
  for (let r = 1; r <= Number(rounds); r++) {
    const t0 = Date.now()
    const s = simRound(L, r, { pie: pie !== '0', diggers: Number(dg), seconds: Number(sec), digS: Number(digS), views: Number(views), memory })
    all += s.found.length; total += s.caches.length
    if (s.found.length) firsts.push(s.found[0].t)
    console.log(`раунд ${r}: тайников ${s.caches.length} (dy ${s.caches.map(c => c.y).join('/')}), найдено ${s.found.length}${s.found.length ? ' на ' + s.found.map(f => f.t + ' с').join(', ') : ''} (сим ${Date.now() - t0} мс)`)
  }
  firsts.sort((a, b) => a - b)
  console.log(`итог: «пирог» ${pie !== '0' ? 'да' : 'нет'}, копателей ${dg}, ${sec} с, мест осмотра ${views}, память ${mem === '1' ? 'да' : 'нет'}: найдено ${all}/${total}; первый тайник в ${firsts.length}/${rounds} раундах, медиана ${firsts.length ? firsts[Math.floor(firsts.length / 2)] : '—'} с`)
}
