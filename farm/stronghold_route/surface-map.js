'use strict'
// Офлайн-данные высот из разрешённой копии мира; основной мир не читается/не меняется.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('../../daemon/node_modules/prismarine-nbt')
const REGION = process.env.SURFACE_REGION || path.resolve(__dirname, '../pristine-run/world/region')
const chunks = new Map()
const regions = new Map()
function long (v) { return typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt.asUintN(64, BigInt(v[0]) << 32n | BigInt(v[1] >>> 0)) }
function chunk (x, z) {
  const key = `${x},${z}`
  if (chunks.has(key)) return chunks.get(key)
  const file = path.join(REGION, `r.${x >> 5}.${z >> 5}.mca`)
  if (!regions.has(file)) regions.set(file, fs.existsSync(file) ? fs.readFileSync(file) : null)
  const b = regions.get(file)
  let c = null
  if (b) {
    const idx = ((x & 31) + (z & 31) * 32) * 4
    const off = b.readUIntBE(idx, 3) * 4096
    if (off) {
      const len = b.readUInt32BE(off)
      const packed = b.subarray(off + 5, off + 4 + len)
      const raw = b[off + 4] === 2 ? zlib.inflateSync(packed) : b[off + 4] === 1 ? zlib.gunzipSync(packed) : packed
      c = nbt.simplify(nbt.parseUncompressed(raw))
    }
  }
  chunks.set(key, c)
  return c
}
function height (x, z, kind = 'MOTION_BLOCKING_NO_LEAVES') {
  const c = chunk(x >> 4, z >> 4)
  const hm = c?.Heightmaps?.[kind]
  if (!hm) return null
  const i = (z & 15) * 16 + (x & 15)
  return Number(long(hm[Math.floor(i / 7)]) >> BigInt(i % 7 * 9) & 511n) - 64
}
function block (x, y, z) {
  const c = chunk(x >> 4, z >> 4)
  if (!c) return null
  const s = c.sections?.find(s => s.Y === (y >> 4))
  const bs = s?.block_states
  if (!bs) return 'air'
  const pal = bs.palette
  let index = 0
  if (pal.length > 1) {
    const bits = Math.max(4, Math.ceil(Math.log2(pal.length)))
    const per = Math.floor(64 / bits)
    const i = (y & 15) * 256 + (z & 15) * 16 + (x & 15)
    index = Number(long(bs.data[Math.floor(i / per)]) >> BigInt(i % per * bits) & ((1n << BigInt(bits)) - 1n))
  }
  return pal[index].Name.replace('minecraft:', '')
}
if (require.main === module) {
  const [x0, z0, x1, z1, step] = process.argv.slice(2).map(Number)
  const rows = []
  for (let z = z0; z <= z1; z += step) {
    const row = []
    for (let x = x0; x <= x1; x += step) {
      const y = height(x, z)
      row.push({ x, z, y, floor: y === null ? null : block(x, y - 1, z) })
    }
    rows.push(row)
  }
  fs.writeFileSync(path.join(__dirname, 'surface-grid.json'), JSON.stringify({ x0, z0, x1, z1, step, rows }))
  console.log('x:', rows[0].map(c => c.x).join(' '))
  for (const r of rows) console.log(r[0].z, r.map(c => c.y === null ? '?' : c.floor === 'water' ? '~' : Math.floor(c.y / 10).toString(36)).join(''))
}
module.exports = { height, block, chunk }
