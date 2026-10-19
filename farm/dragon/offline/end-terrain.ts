// Рельеф у фонтана Энда по файлам региона (02.10, поток dragon): высота земли вокруг столба относительно P (клетка над верхним
// бедроком столба) — где можно стоять у головы сидящего. Читает world_the_end/DIM1/region/*.mca слота фермы (мир сохранён).
//   node dist/farm/dragon/offline/end-terrain.js farm/server-1 [farm/server-2 ...]
import * as fs from 'fs'; import path = require('path'); import * as zlib from 'zlib'
const nbt = require(path.join(__dirname, '..', '..', '..', 'daemon', 'node_modules', 'prismarine-nbt'))
function readChunk (dir, cx, cz) {
  const rx = Math.floor(cx / 32); const rz = Math.floor(cz / 32)
  const f = path.join(dir, `r.${rx}.${rz}.mca`); if (!fs.existsSync(f)) return null
  const buf = fs.readFileSync(f); const i = 4 * ((cx & 31) + (cz & 31) * 32)
  const off = (buf.readUInt32BE(i) >>> 8) * 4096; if (!off) return null
  const len = buf.readUInt32BE(off); const comp = buf[off + 4]
  const data = buf.subarray(off + 5, off + 4 + len)
  const raw = comp === 2 ? zlib.inflateSync(data) : comp === 1 ? zlib.gunzipSync(data) : data
  return nbt.simplify(nbt.parseUncompressed(raw, 'big'))
}
function blockGetter (dir) {
  const cache = new Map()
  return (x, y, z) => {
    const cx = x >> 4; const cz = z >> 4; const k = cx + ',' + cz
    if (!cache.has(k)) cache.set(k, readChunk(dir, cx, cz))
    const ch = cache.get(k); if (!ch) return null
    const sy = y >> 4; const sec = (ch.sections || []).find(s => s.Y === sy); if (!sec || !sec.block_states) return 'air'
    const pal = sec.block_states.palette; if (pal.length === 1) return pal[0].Name.replace('minecraft:', '')
    const bits = Math.max(4, Math.ceil(Math.log2(pal.length))); const per = Math.floor(64 / bits)
    const idx = ((y & 15) * 16 + (z & 15)) * 16 + (x & 15)
    const L = sec.block_states.data[Math.floor(idx / per)]; const v = (BigInt.asUintN(32, BigInt(L[0])) << 32n) | BigInt.asUintN(32, BigInt(L[1]))
    const id = Number((v >> BigInt((idx % per) * bits)) & ((1n << BigInt(bits)) - 1n))
    return pal[id].Name.replace('minecraft:', '')
  }
}
for (const srv of process.argv.slice(2)) {
  const dir = path.join(srv, 'world_the_end', 'DIM1', 'region')
  if (!fs.existsSync(dir)) { console.log(srv, 'нет Энда'); continue }
  const at = blockGetter(dir)
  let P = null; for (let y = 90; y > 40; y--) { if (at(0, y, 0) === 'bedrock') { P = y + 1; break } }
  if (P == null) { console.log(srv, 'столба нет'); continue }
  // высота ног (первая клетка воздуха над твёрдым), относительно P, для клеток r ≤ 10
  const rows = []
  for (let z = -10; z <= 10; z++) {
    let line = ''
    for (let x = -10; x <= 10; x++) {
      const r = Math.hypot(x + 0.5 - 0.5, z + 0.5 - 0.5)
      if (r > 10.5) { line += '   '; continue }
      let fy = null
      for (let y = P + 3; y >= P - 8; y--) { const b = at(x, y, z); const a = at(x, y + 1, z); if (b && !/air|fire|torch|portal/.test(b) && /air|fire/.test(a || 'air')) { fy = y + 1; break } }
      line += fy == null ? '  .' : String(fy - P).padStart(3)
    }
    rows.push(line)
  }
  console.log(`== ${srv}: P=${P} (ноги относительно P; −4 — уровень пола чаши)`)
  console.log(rows.join('\n'))
}
