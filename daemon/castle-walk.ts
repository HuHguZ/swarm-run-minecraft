'use strict'
// Проходимость замка (castle.js) для игрока — без сервера. BFS от улицы
// нижнего города по клеткам, где игрок может стоять:
//   · под ногами опора (верх коллизии блока ниже, в т. ч. сундук, плита),
//     либо сама клетка — ковёр/нижняя плита/люк, либо лестница-ladder/вода;
//   · тело 0.6×1.8 по центру клетки не упирается в коллизию (двери и калитки
//     считаются открытыми — их открывают, лёгкий блок света — пустота);
//   · шаг к соседу по стороне: подъём прыжком до 1.25 (над головой хватает
//     места), спуск — падением до 4 блоков; по лестнице и в воде — вверх-вниз.
// Отчёт:
//   1. двери: не достигнута, или с одной стороны проход закрыт — чем;
//   2. рабочие блоки и хранилища (верстак, печи, сундуки, бочки, наковальня,
//      кафедры, кровати…): нет достижимой клетки рядом — не подойти;
//   3. сундук под сплошным блоком — не откроется;
//   4. недостижимые «комнаты»: связные куски пола под крышей, куда не попасть.
//   node castle-walk.js [--opts '{"json":1}']

const C = require('./colosseum')
const LG = require('./colosseum-light')

const USE = /^(crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|ender_chest|anvil|chipped_anvil|damaged_anvil|grindstone|smithing_table|stonecutter|loom|cartography_table|fletching_table|lectern|enchanting_table|brewing_stand|cauldron|water_cauldron|lava_cauldron|composter|jukebox|.*_bed|lever|stone_button|.*_button|decorated_pot|chiseled_bookshelf|bell)$/

function walk (m, { start = [0, 2, 46] }: any = {} as Record<string, any>) {
  const { g } = m
  const T = LG.tables(g)
  const n = g.pal.length
  const pass = new Uint8Array(n); const climb = new Uint8Array(n); const water = new Uint8Array(n)
  const names = new Array(n)
  for (let v = 1; v < n; v++) {
    const { name } = C.parse(g.pal[v])
    names[v] = name
    if (/_door$|_fence_gate$|^light$|_button$|_pressure_plate$|^lever$|^tripwire|^redstone_wire$|_sign$|_banner$|torch$|^cobweb$/.test(name)) pass[v] = 1
    if (/^(ladder|vine|scaffolding|twisting_vines|weeping_vines)$/.test(name)) climb[v] = 1
    if (name === 'water' || name === 'bubble_column') { climb[v] = 1; water[v] = 1 }
  }
  const sx = g.sx; const sz = g.sz; const sxz = sx * sz
  const FP0 = 0.2; const FP1 = 0.8; const HEIGHT = 1.8
  const vAt = (x, y, z) => g.in(x, y, z) ? g.data[g.i(x, y, z)] : 0
  const boxes = v => pass[v] ? [] : T.boxes[v]
  const hits = b => b[3] > FP0 && b[0] < FP1 && b[5] > FP0 && b[2] < FP1
  // Верх коллизии клетки в центральном квадрате (0 — пусто).
  const topOf = v => { let t = 0; for (const b of boxes(v)) if (hits(b)) t = Math.max(t, b[4]); return t }
  // Свободен ли столб (x, z) по высоте [lo, hi) (мировые y).
  const clear = (x, z, lo, hi) => {
    for (let y = Math.floor(lo); y < Math.ceil(hi); y++) {
      for (const b of boxes(vAt(x, y, z))) {
        if (!hits(b)) continue
        if (y + b[4] > lo + 1e-3 && y + b[1] < hi - 1e-3) return false
      }
    }
    return true
  }
  const Ecache = new Float32Array(g.data.length).fill(-1e9)
  // Высота ног, если стоять в клетке (x, y, z); NaN — нельзя.
  const standE = (x, y, z) => {
    if (!g.in(x, y, z) || !g.in(x, y - 1, z)) return NaN
    const i = g.i(x, y, z)
    if (Ecache[i] !== -1e9) return Ecache[i]
    let E = NaN
    const v = g.data[i]
    const own = topOf(v)
    if (own <= 0.6) {
      if (climb[v]) E = y + own
      else if (own > 0) E = y + own
      else {
        const vb = vAt(x, y - 1, z)
        const bt = topOf(vb)
        if (bt >= 0.8) E = y - 1 + bt
        else if (climb[vb]) E = y
      }
      if (!Number.isNaN(E) && !clear(x, z, E, E + HEIGHT)) E = NaN
    }
    Ecache[i] = E
    return E
  }
  const seen = new Uint8Array(g.data.length)
  const q = []
  const push = (x, y, z) => { const i = g.i(x, y, z); if (!seen[i]) { seen[i] = 1; q.push(i) } }
  const [sx0, sy0, sz0] = start
  if (Number.isNaN(standE(sx0, sy0, sz0))) throw new Error(`старт ${start} — не стоять`)
  push(sx0, sy0, sz0)
  const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi]
    const x = i % sx + g.x0; const z = Math.floor(i / sx) % sz + g.z0; const y = Math.floor(i / sxz) + g.y0
    const Ea = standE(x, y, z)
    const va = g.data[i]
    for (const [dx, dz] of N4) {
      const nx = x + dx; const nz = z + dz
      for (let ny = y + 1; ny >= y - 5; ny--) {
        if (!g.in(nx, ny, nz)) continue
        const Eb = standE(nx, ny, nz)
        if (Number.isNaN(Eb)) {
          // Сквозь твёрдое вниз не падаем.
          if (!clear(nx, nz, ny, ny + 1) && ny <= y) break
          continue
        }
        if (Eb - Ea > 1.25) break
        // Подъём до 0.6 — шагом (над исходной клеткой запас не нужен), выше — прыжок.
        if (Eb >= Ea) { if (Eb - Ea <= 0.6 || clear(x, z, Ea, Eb + HEIGHT)) push(nx, ny, nz) } else if (Ea - Eb <= 4.01 && clear(nx, nz, Eb, Ea + HEIGHT)) push(nx, ny, nz)
        break
      }
    }
    // Лестница/вода: вверх-вниз.
    if (climb[va] || climb[vAt(x, y - 1, z)]) {
      if (climb[va] && g.in(x, y + 1, z) && (climb[vAt(x, y + 1, z)] || !Number.isNaN(standE(x, y + 1, z))) && clear(x, z, y, y + 1 + HEIGHT)) {
        if (Number.isNaN(standE(x, y + 1, z))) Ecache[g.i(x, y + 1, z)] = y + 1
        push(x, y + 1, z)
      }
      if (climb[vAt(x, y - 1, z)] && g.in(x, y - 1, z)) { if (Number.isNaN(standE(x, y - 1, z))) Ecache[g.i(x, y - 1, z)] = y - 1; push(x, y - 1, z) }
    }
  }
  const reached = (x, y, z) => g.in(x, y, z) && seen[g.i(x, y, z)] === 1
  const out: Record<string, any> = { nodes: q.length, doors: [], use: [], chests: [], rooms: [] }
  const what = (x, y, z) => { const s = g.get(x, y, z); return s ? C.parse(s).name : 'пусто' }

  // 1. Двери.
  const DIRV = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
  const seenDoor = new Set()
  for (const d of m.doors || []) {
    const k = `${d.x},${d.y},${d.z}`
    if (seenDoor.has(k)) continue
    seenDoor.add(k)
    if (!/_door$/.test(what(d.x, d.y, d.z))) { out.doors.push({ ...d, why: `дверь затёрта: ${what(d.x, d.y, d.z)}` }); continue }
    const [fx, fz] = DIRV[d.facing]
    const sides = [[d.x + fx, d.z + fz], [d.x - fx, d.z - fz]]
    const probs = []
    for (const [ax, az] of sides) {
      // Сторона двери: клетка на уровне порога (или ступенькой выше/ниже).
      let ok = false
      for (const dy of [0, 1, -1]) if (reached(ax, d.y + dy, az)) ok = true
      if (!ok) {
        const blockers = [0, 1].map(dy => what(ax, d.y + dy, az)).filter(s => s !== 'пусто' && !/carpet|light|_sign|banner|torch|_door/.test(s))
        probs.push(`с ${ax},${az}: ${blockers.length ? 'закрыто — ' + blockers.join(' + ') : 'не дойти'}`)
      }
    }
    if (probs.length) out.doors.push({ ...d, why: probs.join('; ') })
  }
  // 2–3. Рабочие блоки и сундуки.
  const nearReached = (x, y, z) => {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -3; dy <= 1; dy++) if ((dx || dz || dy) && reached(x + dx, y + dy, z + dz)) return true
    return false
  }
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i]
    if (!v || !USE.test(names[v])) continue
    const x = i % sx + g.x0; const z = Math.floor(i / sx) % sz + g.z0; const y = Math.floor(i / sxz) + g.y0
    if (!nearReached(x, y, z)) out.use.push({ x, y, z, name: names[v] })
    if (/^(chest|trapped_chest)$/.test(names[v])) {
      const a = vAt(x, y + 1, z)
      if (a && T.fullColl[a] && T.opacity[a] >= 15) out.chests.push({ x, y, z, above: names[a] })
    }
  }
  // 4. Недостижимые куски пола под крышей.
  const comp = new Int32Array(g.data.length)
  let cid = 0
  const roofed = (x, y, z) => { for (let yy = y + 2; yy <= y + 14; yy++) { const v = vAt(x, yy, z); if (v && T.fullColl[v]) return true } return false }
  for (let y = g.y0 + 1; y <= g.y1 - 2; y++) {
    for (let z = g.z0; z <= g.z1; z++) {
      for (let x = g.x0; x <= g.x1; x++) {
        const i = g.i(x, y, z)
        if (seen[i] || comp[i]) continue
        const E = standE(x, y, z)
        if (Number.isNaN(E) || water[g.data[i]] || !roofed(x, y, z)) continue
        cid++
        const st = [i]; comp[i] = cid
        const cells = []
        while (st.length) {
          const j = st.pop()
          const cx = j % sx + g.x0; const cz = Math.floor(j / sx) % sz + g.z0; const cy = Math.floor(j / sxz) + g.y0
          cells.push([cx, cy, cz])
          for (const [dx, dz] of N4) {
            for (const dy of [0, 1, -1]) {
              const nx = cx + dx; const ny = cy + dy; const nz = cz + dz
              if (!g.in(nx, ny, nz)) continue
              const k = g.i(nx, ny, nz)
              if (seen[k] || comp[k] || Number.isNaN(standE(nx, ny, nz)) || !roofed(nx, ny, nz)) continue
              comp[k] = cid; st.push(k)
            }
          }
        }
        if (cells.length >= 3) {
          const bb = cells.reduce((a, [cx, cy, cz]: any) => [Math.min(a[0], cx), Math.min(a[1], cy), Math.min(a[2], cz), Math.max(a[3], cx), Math.max(a[4], cy), Math.max(a[5], cz)], [1e9, 1e9, 1e9, -1e9, -1e9, -1e9])
          out.rooms.push({ size: cells.length, bb, at: cells[0] })
        }
      }
    }
  }
  out.rooms.sort((a, b) => b.size - a.size)
  out.reached = reached
  return out
}

module.exports = { walk }

if (require.main === module) {
  const args = process.argv.slice(2)
  const oi = args.indexOf('--opts')
  const opts = oi >= 0 ? JSON.parse(args[oi + 1]) : {} as Record<string, any>
  const CS = require('./castle')
  const t0 = Date.now()
  const m = CS.model(opts)
  const t1 = Date.now()
  const r = walk(m)
  console.log(`модель ${t1 - t0} мс, обход ${Date.now() - t1} мс: достижимых клеток ${r.nodes}, дверей ${new Set(m.doors.map(d => `${d.x},${d.y},${d.z}`)).size}`)
  console.log(`\nДВЕРИ с проблемой: ${r.doors.length}`)
  for (const d of r.doors) console.log(`  ${d.mat} ${d.x},${d.y},${d.z} (${d.facing}): ${d.why}`)
  console.log(`\nНЕ ПОДОЙТИ к блокам: ${r.use.length}`)
  for (const u of r.use) console.log(`  ${u.name} ${u.x},${u.y},${u.z}`)
  console.log(`\nСУНДУКИ под сплошным блоком: ${r.chests.length}`)
  for (const c of r.chests) console.log(`  ${c.x},${c.y},${c.z} под ${c.above}`)
  console.log(`\nНЕДОСТИЖИМЫЙ ПОЛ под крышей (кусков ≥ 3): ${r.rooms.length}`)
  for (const c of r.rooms.slice(0, 60)) console.log(`  ${c.size} кл. x ${c.bb[0]}..${c.bb[3]} y ${c.bb[1]}..${c.bb[4]} z ${c.bb[2]}..${c.bb[5]}`)
}
