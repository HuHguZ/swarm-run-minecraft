'use strict'
// Сканер лавы у спавна для техник портала без алмазной кирки (агент G, 02.10.2026).
// Только ферма, только слоты 29–30.
//
//   node farm/portal-scan/scan.js gen <slot> [half=256]   прогрузить квадрат 2*half вокруг спавна (forceload),
//                                                          save-all flush; мир остаётся на диске слота
//   node farm/portal-scan/scan.js scan <slot> [half=256]  прочитать region-файлы слота и посчитать лаву/воду/магму;
//                                                          итог — farm/portal-scan/results/<seed>.json
//   node farm/portal-scan/scan.js sum                      свести все results/*.json в таблицу
//
// Чтение — прямо из .mca (zlib + NBT, палитры 1.18+), без бота: данные мира, не то, что видно глазами. Это ответ
// «что вообще генерируется», а не «что найдёт бот» — найти бот может только видимое (portal-natural.js).
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const net = require('net')
const nbt = require(path.join(__dirname, '..', '..', 'daemon', 'node_modules', 'prismarine-nbt'))

const ROOT = path.join(__dirname, '..', '..')
// PORTAL_SCAN_OUT — другая папка итогов (пул хороших сидов: results-pool), по умолчанию results (случайные сиды).
const OUT = process.env.PORTAL_SCAN_OUT ? path.resolve(process.env.PORTAL_SCAN_OUT) : path.join(__dirname, 'results')
const MIN_Y = -64
const H = 384
const ALLOWED = new Set([29, 30])

// ---------------------------------------------------------------- rcon
function rconClient (port, pass) {
  const sock = net.connect(port, '127.0.0.1')
  let acc = Buffer.alloc(0)
  let nextId = 10
  const waiting = new Map()
  const pkt = (id, type, body) => {
    const b = Buffer.from(body, 'utf8')
    const buf = Buffer.alloc(14 + b.length)
    buf.writeInt32LE(10 + b.length, 0); buf.writeInt32LE(id, 4); buf.writeInt32LE(type, 8); b.copy(buf, 12)
    return buf
  }
  sock.on('data', d => {
    acc = Buffer.concat([acc, d])
    while (acc.length >= 4) {
      const len = acc.readInt32LE(0)
      if (acc.length < len + 4) break
      const id = acc.readInt32LE(4)
      const body = acc.slice(12, len + 2).toString('utf8')
      acc = acc.slice(len + 4)
      const w = waiting.get(id)
      if (w) { waiting.delete(id); w(body) } else if (id === -1) { for (const f of waiting.values()) f(null); waiting.clear() }
    }
  })
  const send = (type, body) => new Promise<any>((resolve, reject) => {
    const id = nextId++
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('rcon timeout: ' + body)) }, 60000)
    waiting.set(id, r => { clearTimeout(t); resolve(r) })
    sock.write(pkt(id, type, body))
  })
  const ready = new Promise<void>((resolve, reject) => {
    sock.once('connect', async () => {
      try { const r = await send(3, pass); if (r === null) reject(new Error('rcon auth')); else resolve() } catch (e) { reject(e) }
    })
    sock.once('error', reject)
  })
  return { ready, cmd: body => send(2, body), close: () => sock.end() }
}

function slotInfo (slot) {
  if (!ALLOWED.has(slot)) throw new Error(`слот ${slot}: агенту G можно только 29–30`)
  const dir = path.join(ROOT, 'farm', `server-${slot}`)
  const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')
  const get = k => (new RegExp('^' + k.replace('.', '\\.') + '=(.*)$', 'm').exec(props) || [])[1]
  return { dir, rcon: Number(get('rcon.port')), pass: get('rcon.password'), seed: get('level-seed') }
}

async function readLevel (dir) {
  const raw = fs.readFileSync(path.join(dir, 'world', 'level.dat'))
  const { parsed } = await nbt.parse(raw)
  const d = nbt.simplify(parsed).Data
  let spawn = null
  if (d.spawn && d.spawn.pos) spawn = { x: d.spawn.pos[0], y: d.spawn.pos[1], z: d.spawn.pos[2] }
  else if (d.SpawnX !== undefined) spawn = { x: d.SpawnX, y: d.SpawnY, z: d.SpawnZ }
  let seed = null
  const wgs = d.WorldGenSettings
  if (wgs && wgs.seed !== undefined) seed = longStr(wgs.seed)
  return { spawn, seed }
}
function longStr (v) {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return ((BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0)).toString()
  return String(v)
}

const sleep = ms => new Promise<any>(r => setTimeout(r, ms))

async function cmdGen (slot, half) {
  const s = slotInfo(slot)
  // RCON открывается на «Done», через ~5 с после игрового порта (его и ждёт farm up) — повторять до минуты.
  let rc = null
  for (let k = 0; k < 30; k++) {
    rc = rconClient(s.rcon, s.pass)
    try { await rc.ready; break } catch (e) { rc = null; await sleep(2000) }
  }
  if (!rc) throw new Error(`rcon ${s.rcon} не открылся за минуту`)
  await rc.cmd('save-all flush')
  const { spawn } = await readLevel(s.dir)
  if (!spawn) throw new Error('нет спавна в level.dat')
  const scx = Math.floor(spawn.x / 16); const scz = Math.floor(spawn.z / 16)
  const hc = Math.ceil(half / 16)
  const t0 = Date.now()
  // Партии по 16x16 чанков (forceload — не больше 256 за раз).
  for (let bx = scx - hc; bx < scx + hc; bx += 16) {
    for (let bz = scz - hc; bz < scz + hc; bz += 16) {
      const x2 = Math.min(bx + 15, scx + hc - 1); const z2 = Math.min(bz + 15, scz + hc - 1)
      const r = await rc.cmd(`forceload add ${bx * 16} ${bz * 16} ${x2 * 16 + 15} ${z2 * 16 + 15}`)
      // Дождаться, пока все чанки партии станут FULL: execute if loaded по каждому.
      for (let tries = 0; tries < 600; tries++) {
        let missing = 0
        for (let cx = bx; cx <= x2; cx += 1) {
          for (let cz = bz; cz <= z2; cz += 1) {
            const q = await rc.cmd(`execute if loaded ${cx * 16 + 8} 64 ${cz * 16 + 8}`)
            if (!/passed/i.test(q || '')) missing++
          }
        }
        if (!missing) break
        await sleep(1500)
      }
      await rc.cmd(`forceload remove ${bx * 16} ${bz * 16} ${x2 * 16 + 15} ${z2 * 16 + 15}`)
      console.log(`партия ${bx},${bz}: ${(r || '').slice(0, 80)} — ${Math.round((Date.now() - t0) / 1000)} с`)
    }
  }
  await rc.cmd('save-all flush')
  rc.close()
  console.log(JSON.stringify({ slot, spawn, seconds: Math.round((Date.now() - t0) / 1000) }))
}

// ---------------------------------------------------------------- region
const regionCache = new Map()
function readChunkNbtRaw (worldDir, cx, cz) {
  const rx = cx >> 5; const rz = cz >> 5
  const file = path.join(worldDir, 'region', `r.${rx}.${rz}.mca`)
  let buf = regionCache.get(file)
  if (buf === undefined) { buf = fs.existsSync(file) ? fs.readFileSync(file) : null; regionCache.set(file, buf) }
  if (!buf) return null
  const idx = ((cx & 31) + (cz & 31) * 32) * 4
  const off = ((buf[idx] << 16) | (buf[idx + 1] << 8) | buf[idx + 2]) * 4096
  if (!off) return null
  const len = buf.readUInt32BE(off)
  const comp = buf[off + 4]
  const data = buf.slice(off + 5, off + 4 + len)
  if (comp === 2) return zlib.inflateSync(data)
  if (comp === 1) return zlib.gunzipSync(data)
  if (comp === 3) return data
  throw new Error(`сжатие ${comp} не умею (чанк ${cx},${cz})`)
}

function longsOf (arr) {
  // prismarine-nbt: long — [hi, lo] или bigint.
  const n = arr.length
  const hi = new Uint32Array(n); const lo = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    const v = arr[i]
    if (typeof v === 'bigint') { hi[i] = Number((v >> 32n) & 0xffffffffn); lo[i] = Number(v & 0xffffffffn) } else { hi[i] = v[0] >>> 0; lo[i] = v[1] >>> 0 }
  }
  return { hi, lo }
}
function unpack (longs, bits, count, out) {
  const per = Math.floor(64 / bits)
  const mask = (1 << bits) - 1
  for (let i = 0; i < count; i++) {
    const li = (i / per) | 0
    const o = (i % per) * bits
    const hi = longs.hi[li]; const lo = longs.lo[li]
    let v
    if (o >= 32) v = (hi >>> (o - 32)) & mask
    else if (o + bits <= 32) v = (lo >>> o) & mask
    else v = ((lo >>> o) | (hi << (32 - o))) & mask
    out[i] = v
  }
  return out
}

// Коды клеток.
const C = { OTHER: 0, AIR: 1, WATER: 2, LAVA_SRC: 3, LAVA_FLOW: 4, MAGMA: 5, OBSIDIAN: 6, CRYING: 7, SOFT: 8, ICE: 9 }
const WATERY = /^(water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/
const SOFT = /(grass|fern|flower|tulip|orchid|allium|bluet|daisy|poppy|dandelion|lily_of|cornflower|bush|sapling|vine|snow$|torch|carpet|button|pressure_plate|rail|sugar_cane|mushroom$|roots|sprouts|lichen|moss_carpet|petals|leaf_litter|cactus_flower|firefly_bush|hanging_moss|dripleaf|spore_blossom|hanging_roots|pointed_dripstone|amethyst_bud|amethyst_cluster|cobweb|sweet_berry|pitcher|torchflower)/
function codeOf (state) {
  const n = state.Name.replace('minecraft:', '')
  const p = state.Properties || {} as Record<string, any>
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return C.AIR
  if (n === 'lava') return p.level === '0' || p.level === undefined ? C.LAVA_SRC : C.LAVA_FLOW
  if (WATERY.test(n) || p.waterlogged === 'true') return C.WATER
  if (n === 'magma_block') return C.MAGMA
  if (n === 'obsidian') return C.OBSIDIAN
  if (n === 'crying_obsidian') return C.CRYING
  if (/ice$/.test(n)) return C.ICE
  if (SOFT.test(n)) return C.SOFT
  return C.OTHER
}

async function cmdScan (slot, half, worldDirArg) {
  const s: any = worldDirArg ? { dir: worldDirArg } : slotInfo(slot)
  const worldDir = path.join(s.dir, 'world')
  const lvl = await readLevel(s.dir)
  const spawn = lvl.spawn
  const seed = lvl.seed || s.seed
  const scx = Math.floor(spawn.x / 16); const scz = Math.floor(spawn.z / 16)
  const hc = Math.ceil(half / 16)
  const cx0 = scx - hc; const cz0 = scz - hc
  const NC = hc * 2
  const W = NC * 16
  const X0 = cx0 * 16; const Z0 = cz0 * 16
  const grid = new Uint8Array(W * W * H) // index (y * W + z) * W + x
  const biome = new Array(NC * NC * 24 * 64)
  const oceanFloor = new Int16Array(W * W).fill(-999)
  const at = (x, y, z) => (y * W + z) * W + x
  const rps = []
  const structCount: Record<string, any> = {} as Record<string, any>
  let missingChunks = 0
  const tmp = new Uint16Array(4096)
  const tmpB = new Uint8Array(64)
  const t0 = Date.now()
  for (let i = 0; i < NC; i++) {
    for (let k = 0; k < NC; k++) {
      const cx = cx0 + i; const cz = cz0 + k
      const raw = readChunkNbtRaw(worldDir, cx, cz)
      if (!raw) { missingChunks++; continue }
      const root = nbt.parseUncompressed(raw)
      const v = root.value
      const status = v.Status ? v.Status.value : '?'
      if (!/full/.test(status)) { missingChunks++; continue }
      for (const sec of (v.sections ? v.sections.value.value : [])) {
        const sy = sec.Y.value
        const ys = (sy * 16 - MIN_Y)
        if (ys < 0 || ys >= H) continue
        const bs = sec.block_states && sec.block_states.value
        if (bs) {
          const pal = bs.palette.value.value.map(e => nbt.simplify({ type: 'compound', value: e }))
          const codes = pal.map(codeOf)
          if (pal.length === 1 || !bs.data) tmp.fill(0)
          else unpack(longsOf(bs.data.value), Math.max(4, Math.ceil(Math.log2(pal.length))), 4096, tmp)
          for (let j = 0; j < 4096; j++) {
            const lx = j & 15; const lz = (j >> 4) & 15; const ly = j >> 8
            grid[at(i * 16 + lx, ys + ly, k * 16 + lz)] = codes[tmp[j]]
          }
        }
        const bi = sec.biomes && sec.biomes.value
        if (bi) {
          const pal = bi.palette.value.value
          if (pal.length === 1 || !bi.data) tmpB.fill(0)
          else unpack(longsOf(bi.data.value), Math.ceil(Math.log2(pal.length)), 64, tmpB)
          const base = ((i * NC + k) * 24 + (ys >> 4)) * 64
          for (let j = 0; j < 64; j++) biome[base + j] = pal[tmpB[j]].replace('minecraft:', '')
        }
      }
      const hm = v.Heightmaps && v.Heightmaps.value && v.Heightmaps.value.OCEAN_FLOOR
      if (hm) {
        const arr = new Uint16Array(256)
        unpack(longsOf(hm.value), 9, 256, arr)
        for (let j = 0; j < 256; j++) oceanFloor[(k * 16 + (j >> 4)) * W + (i * 16 + (j & 15))] = arr[j] + MIN_Y
      }
      const st = v.structures && v.structures.value && v.structures.value.starts && v.structures.value.starts.value
      if (st) {
        for (const [name, tag] of Object.entries<any>(st)) {
          const s2 = nbt.simplify(tag)
          if (!s2 || s2.id === 'INVALID') continue
          structCount[name] = (structCount[name] || 0) + 1
          if (/ruined_portal/.test(name)) {
            const ch = (s2.Children || [])[0] || {} as Record<string, any>
            const bb = ch.BB
            rps.push({ name, template: ch.Template, placement: ch.VerticalPlacement || ch.Placement || null, bb })
          }
        }
      }
    }
  }
  const tRead = Date.now() - t0
  const biomeAt = (x, y, z) => {
    const i = x >> 4; const k = z >> 4
    const b = biome[((i * NC + k) * 24 + (y >> 4)) * 64 + ((((y & 15) >> 2) * 16) + (((z & 15) >> 2) * 4) + ((x & 15) >> 2))]
    return b || '?'
  }
  // Верх столба (первая сверху не-воздушная клетка) и верх «твёрдого или жидкого».
  const top = new Int16Array(W * W).fill(-1)
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      for (let y = H - 1; y >= 0; y--) { const c = grid[at(x, y, z)]; if (c !== C.AIR) { top[z * W + x] = y; break } }
    }
  }
  // Воздух, связанный с поверхностью (пещеры и обрывы, куда можно войти не копая): BFS от клетки над верхом столба
  // вниз и вбок по воздуху и мягким блокам. Вода не проводит (вход под водой не считаем).
  const openAir = new Uint8Array(grid.length)
  {
    const Q = new Int32Array(16 * 1024 * 1024)
    let qh = 0; let qt = 0; let qn = 0
    const push = id => { if (qn >= Q.length) return; Q[qt] = id; qt = (qt + 1) % Q.length; qn++ }
    for (let z = 0; z < W; z++) {
      for (let x = 0; x < W; x++) {
        const y = top[z * W + x] + 1
        if (y <= 0 || y >= H) continue
        const id = at(x, y, z)
        if (grid[id] === C.AIR) { openAir[id] = 1; push(id) }
      }
    }
    while (qn) {
      const cur = Q[qh]; qh = (qh + 1) % Q.length; qn--
      const cy = Math.floor(cur / (W * W)); const rem = cur - cy * W * W; const cz = Math.floor(rem / W); const cx = rem - cz * W
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const nx = cx + dx; const ny = cy + dy; const nz = cz + dz
        if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= W) continue
        if (ny > top[nz * W + nx] + 1) continue // выше поверхности — не нужно
        const nid = at(nx, ny, nz)
        if (openAir[nid]) continue
        const c = grid[nid]
        if (c !== C.AIR && c !== C.SOFT) continue
        openAir[nid] = 1; push(nid)
      }
    }
  }
  // Площадь биомов по поверхности (биом клетки верха столба) — знаменатель для «где чаще поверхностная лава».
  const biomeArea: Record<string, any> = {} as Record<string, any>
  for (let z = 0; z < W; z += 2) {
    for (let x = 0; x < W; x += 2) {
      const ty = top[z * W + x]; if (ty < 0) continue
      const b = biomeAt(x, ty, z); biomeArea[b] = (biomeArea[b] || 0) + 4
    }
  }
  const sx = spawn.x - X0; const sz = spawn.z - Z0
  const hdist = (x, z) => Math.round(Math.hypot(x - sx, z - sz))
  // Расстояние Чебышёва до ближайшей воды, до 8.
  const waterDist = (x, y, z, rmax = 8) => {
    for (let r = 1; r <= rmax; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue
        for (let dz = -r; dz <= r; dz++) {
          const zz = z + dz; if (zz < 0 || zz >= W) continue
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue
            const xx = x + dx; if (xx < 0 || xx >= W) continue
            if (grid[at(xx, yy, zz)] === C.WATER) return r
          }
        }
      }
    }
    return 99
  }
  const inRp = (x, y, z, pad = 3) => {
    const wx = x + X0; const wy = y + MIN_Y; const wz = z + Z0
    for (const r of rps) {
      const b = r.bb; if (!b) continue
      if (wx >= b[0] - pad && wx <= b[3] + pad && wy >= b[1] - pad && wy <= b[4] + pad && wz >= b[2] - pad && wz <= b[5] + pad) return r
    }
    return null
  }
  // Кластеры лавы (источники и текущая), 6-связность, отдельно: верх (y ≥ −54) и низ.
  const seen = new Uint8Array(grid.length)
  const clusters = []
  const deepFloor = -54 - MIN_Y // индекс y = −54
  const counts: Record<string, any> = { lavaSrc: 0, lavaSrcUpper: 0, lavaSrcDeep: 0, magma: 0, magmaUnderWater: 0, obsidian: 0, crying: 0, water: 0 }
  const magmaSpots = []
  const obsOutsideRp = []
  const nb6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  const stack = new Int32Array(4 * 1024 * 1024)
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < W; z++) {
      for (let x = 0; x < W; x++) {
        const id = at(x, y, z)
        const c = grid[id]
        if (c === C.WATER) counts.water++
        else if (c === C.MAGMA) {
          counts.magma++
          const up = y + 1 < H ? grid[at(x, y + 1, z)] : 0
          if (up === C.WATER) counts.magmaUnderWater++
          if (magmaSpots.length < 5000) magmaSpots.push([x, y, z, up === C.WATER ? 1 : 0])
        } else if (c === C.OBSIDIAN || c === C.CRYING) {
          if (c === C.OBSIDIAN) counts.obsidian++; else counts.crying++
          if (!inRp(x, y, z, 1) && obsOutsideRp.length < 20000) obsOutsideRp.push([x, y, z])
        }
        if ((c !== C.LAVA_SRC && c !== C.LAVA_FLOW) || seen[id]) continue
        // BFS
        let sp = 0; stack[sp++] = id; seen[id] = 1
        const cl: Record<string, any> = { open: 0, src: 0, all: 0, minY: 1e9, maxY: -1e9, sky: 0, airFace: 0, waterMin: 99, near: 1e9, nearAt: null, rp: null, bx1: 1e9, bz1: 1e9, bx2: -1e9, bz2: -1e9, depth: 1e9 }
        const srcCells = []
        while (sp) {
          const cur = stack[--sp]
          const cy = Math.floor(cur / (W * W)); const rem = cur - cy * W * W; const cz = Math.floor(rem / W); const cx = rem - cz * W
          cl.all++
          const isSrc = grid[cur] === C.LAVA_SRC
          if (isSrc) { cl.src++; srcCells.push([cx, cy, cz]) }
          cl.minY = Math.min(cl.minY, cy); cl.maxY = Math.max(cl.maxY, cy)
          cl.bx1 = Math.min(cl.bx1, cx); cl.bx2 = Math.max(cl.bx2, cx); cl.bz1 = Math.min(cl.bz1, cz); cl.bz2 = Math.max(cl.bz2, cz)
          if (top[cz * W + cx] === cy) cl.sky++
          for (const [dx, dy, dz] of nb6) {
            const nx = cx + dx; const ny = cy + dy; const nz = cz + dz
            if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= W) continue
            const nid = at(nx, ny, nz)
            const nc = grid[nid]
            if (dy >= 0 && nc === C.AIR) { cl.airFace++; if (openAir[nid]) cl.open++ }
            if ((nc === C.LAVA_SRC || nc === C.LAVA_FLOW) && !seen[nid]) {
              if (sp >= stack.length) continue
              seen[nid] = 1; stack[sp++] = nid
            }
          }
          const d = hdist(cx, cz)
          if (isSrc && d < cl.near) { cl.near = d; cl.nearAt = [cx + X0, cy + MIN_Y, cz + Z0] }
          if (isSrc) {
            const of = oceanFloor[cz * W + cx]
            if (of > -999) cl.depth = Math.min(cl.depth, Math.max(0, of - 1 - (cy + MIN_Y)))
          }
        }
        if (!cl.src) continue
        counts.lavaSrc += cl.src
        const upper = cl.maxY >= deepFloor + 1 // хоть одна клетка выше −54
        if (!upper) { counts.lavaSrcDeep += cl.src; clusters.push({ deep: true, src: cl.src, near: cl.near, nearAt: cl.nearAt, minY: cl.minY + MIN_Y, maxY: cl.maxY + MIN_Y, airFace: cl.airFace, open: cl.open, depth: cl.depth }); continue }
        counts.lavaSrcUpper += cl.src
        // Вода у кластера: по выборке до 400 источников.
        const step = Math.max(1, Math.floor(srcCells.length / 400))
        for (let q = 0; q < srcCells.length; q += step) {
          const [x1, y1, z1] = srcCells[q]
          cl.waterMin = Math.min(cl.waterMin, waterDist(x1, y1, z1, Math.min(8, cl.waterMin - 1)))
          if (cl.waterMin === 1) break
        }
        const [tx, ty, tz] = srcCells[0]
        const r = inRp(tx, ty, tz) || srcCells.slice(0, 50).map(([a, b, c2]: any) => inRp(a, b, c2)).find(Boolean)
        clusters.push({
          deep: false,
          src: cl.src,
          all: cl.all,
          minY: cl.minY + MIN_Y,
          maxY: cl.maxY + MIN_Y,
          sky: cl.sky,
          airFace: cl.airFace,
          open: cl.open,
          water: cl.waterMin,
          near: cl.near,
          nearAt: cl.nearAt,
          depth: cl.depth === 1e9 ? null : cl.depth,
          rp: r ? r.template || r.name : null,
          rpPlacement: r ? r.placement : null,
          biome: biomeAt(tx, ty, tz),
          size: [cl.bx2 - cl.bx1 + 1, cl.maxY - cl.minY + 1, cl.bz2 - cl.bz1 + 1]
        })
      }
    }
  }
  // Подводные «овраги»: столбы, где вода уходит на 10+ ниже медианы дна вокруг (радиус 8). Дно — OCEAN_FLOOR.
  const ravineCols = []
  for (let z = 8; z < W - 8; z += 1) {
    for (let x = 8; x < W - 8; x += 1) {
      const of = oceanFloor[z * W + x]
      if (of <= -999) continue
      const ty = top[z * W + x]
      if (ty < 0 || grid[at(x, ty, z)] !== C.WATER) continue // сверху не вода — не под водой
      if (!/ocean/.test(biomeAt(x, Math.max(0, of - MIN_Y), z))) continue // только океан
      const ring = []
      for (const [dx, dz] of [[8, 0], [-8, 0], [0, 8], [0, -8], [6, 6], [-6, 6], [6, -6], [-6, -6]]) ring.push(oceanFloor[(z + dz) * W + x + dx])
      ring.sort((a, b) => a - b)
      const med = ring[4]
      if (of <= med - 10) ravineCols.push([x, z, of, med])
    }
  }
  // Магма и лава у дна этих столбов.
  let ravineMagma = 0; let ravineLava = 0; let ravineMinFloor = 999
  const ravineNear = []
  for (const [x, z, of] of ravineCols) {
    const yb = of - MIN_Y - 1
    let m = false; let l = false
    for (let dy = -3; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const xx = x + dx; const zz = z + dz; const yy = yb + dy
          if (xx < 0 || zz < 0 || xx >= W || zz >= W || yy < 0 || yy >= H) continue
          const c = grid[at(xx, yy, zz)]
          if (c === C.MAGMA) m = true
          if (c === C.LAVA_SRC || c === C.LAVA_FLOW) l = true
        }
      }
    }
    ravineMinFloor = Math.min(ravineMinFloor, of)
    if (m) ravineMagma++
    if (l) ravineLava++
    if (ravineNear.length < 3 || hdist(x, z) < ravineNear[ravineNear.length - 1].d) {
      ravineNear.push({ d: hdist(x, z), at: [x + X0, of, z + Z0], floor: of, magma: m, lava: l }); ravineNear.sort((a, b) => a.d - b.d); if (ravineNear.length > 3) ravineNear.pop()
    }
  }
  // Магма: где (биом, под водой, высота).
  const magmaBy: Record<string, any> = {} as Record<string, any>
  for (const [x, y, z, w] of magmaSpots) {
    const k = `${biomeAt(x, y, z)}${w ? ' (под водой)' : ''} y${Math.floor((y + MIN_Y) / 16) * 16}`
    magmaBy[k] = (magmaBy[k] || 0) + 1
  }
  // RP: обсидиан в рамке и лава рядом.
  const rpInfo = rps.map(r => {
    const b = r.bb
    let obs = 0; let cry = 0; let lava = 0; let magma = 0
    if (b) {
      for (let wx = b[0] - 3; wx <= b[3] + 3; wx++) {
        for (let wy = b[1] - 3; wy <= b[4] + 3; wy++) {
          for (let wz = b[2] - 3; wz <= b[5] + 3; wz++) {
            const x = wx - X0; const y = wy - MIN_Y; const z = wz - Z0
            if (x < 0 || z < 0 || x >= W || z >= W || y < 0 || y >= H) continue
            const c = grid[at(x, y, z)]
            if (c === C.OBSIDIAN) obs++; else if (c === C.CRYING) cry++; else if (c === C.LAVA_SRC) lava++; else if (c === C.MAGMA) magma++
          }
        }
      }
    }
    const cxw = b ? (b[0] + b[3]) / 2 : 0; const czw = b ? (b[2] + b[5]) / 2 : 0
    return { template: (r.template || '').replace('minecraft:ruined_portal/', ''), placement: r.placement, at: b ? [Math.round(cxw), b[1], Math.round(czw)] : null, d: b ? Math.round(Math.hypot(cxw - spawn.x, czw - spawn.z)) : null, obsidian: obs, crying: cry, lavaSrc: lava, magma }
  }).sort((a, b) => a.d - b.d)
  // Сводки по классам кластеров (верх, y ≥ −54).
  const up = clusters.filter(c => !c.deep)
  const cls = c => c.rp ? 'rp' : c.sky > 0 ? 'surface' : c.open > 0 ? 'open-cave' : c.airFace > 0 ? 'closed-cave' : 'enclosed'
  // Оценка пути, с: поверху 4 бл/с (ходьба с pathfinder), вниз по открытой пещере 1 с на уровень, лесенкой копая —
  // 3.25 с на уровень (dev-E, медиана 467 шагов). Только для ранжирования источников.
  const est = c => Math.round(c.near / 4 + (c.depth || 0) * (c.sky > 0 || c.open > 0 ? 1 : 3.25))
  const byClass: Record<string, any> = {} as Record<string, any>
  for (const c of up) {
    const k = cls(c)
    const e = byClass[k] || (byClass[k] = { clusters: 0, src: 0, ge10: 0, nearWater8: 0, nearWater3: 0, nearest10: null, fastest10: null, nearestAny: null })
    e.clusters++; e.src += c.src
    if (c.src >= 10) {
      e.ge10++
      const rec = { near: c.near, at: c.nearAt, src: c.src, depth: c.depth, water: c.water, biome: c.biome, est: est(c) }
      if (!e.nearest10 || c.near < e.nearest10.near) e.nearest10 = rec
      if (!e.fastest10 || rec.est < e.fastest10.est) e.fastest10 = rec
    }
    if (c.water <= 8) e.nearWater8++
    if (c.water <= 3) e.nearWater3++
    if (!e.nearestAny || c.near < e.nearestAny.near) e.nearestAny = { near: c.near, at: c.nearAt, src: c.src, depth: c.depth, water: c.water }
  }
  // «Годная для литья у воды»: ≥ 10 источников, видна (небо или воздух), вода ≤ 8.
  const usable = up.filter(c => c.src >= 10 && (c.sky > 0 || c.open > 0)).sort((a, b) => est(a) - est(b))
  const usableWater = usable.filter(c => c.water <= 8)
  const deepList = clusters.filter(c => c.deep)
  const deepExposed = deepList.filter(c => c.airFace > 0 && c.src >= 10).sort((a, b) => a.near - b.near)
  const deepOpen = deepList.filter(c => c.open > 0 && c.src >= 10).sort((a, b) => a.near - b.near)
  const res = {
    seed,
    spawn,
    area: { x0: X0, z0: Z0, size: W, chunks: NC * NC, missingChunks },
    readMs: tRead,
    counts,
    structures: structCount,
    byClass,
    nearestUsable: usable.slice(0, 5).map(c => ({ class: cls(c), est: est(c), near: c.near, at: c.nearAt, src: c.src, depth: c.depth, water: c.water, biome: c.biome, y: [c.minY, c.maxY] })),
    nearestUsableNearWater: usableWater.slice(0, 5).map(c => ({ class: cls(c), est: est(c), near: c.near, at: c.nearAt, src: c.src, depth: c.depth, water: c.water, biome: c.biome })),
    deep: { clusters: deepList.length, src: counts.lavaSrcDeep, exposed10: deepExposed.length, open10: deepOpen.length, nearestExposed: deepExposed[0] ? { near: deepExposed[0].near, at: deepExposed[0].nearAt, src: deepExposed[0].src, depth: deepExposed[0].depth, est: est(deepExposed[0]) } : null, nearestOpen: deepOpen[0] ? { near: deepOpen[0].near, at: deepOpen[0].nearAt, src: deepOpen[0].src, depth: deepOpen[0].depth, est: est(deepOpen[0]) } : null },
    ravines: { columns: ravineCols.length, minFloor: ravineMinFloor, withMagma: ravineMagma, withLava: ravineLava, nearest: ravineNear },
    magmaBy,
    obsidianOutsideRp: obsOutsideRp.length,
    obsidianOutsideRpY: (() => { const m: Record<string, any> = {} as Record<string, any>; for (const [, y] of obsOutsideRp) { const k = Math.floor((y + MIN_Y) / 16) * 16; m[k] = (m[k] || 0) + 1 } return m })(),
    ruinedPortals: rpInfo,
    biomeArea,
    spawnBiome: biomeAt(Math.max(0, Math.min(W - 1, sx)), Math.max(0, Math.min(H - 1, top[Math.max(0, Math.min(W - 1, sz)) * W + Math.max(0, Math.min(W - 1, sx))])), Math.max(0, Math.min(W - 1, sz))),
    surfaceLakes: up.filter(c => c.sky > 0 && !c.rp).map(c => ({ src: c.src, near: c.near, at: c.nearAt, biome: c.biome, water: c.water, y: [c.minY, c.maxY] })),
    clustersUpper: up.length
  }
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${seed}.json`)
  fs.writeFileSync(file, JSON.stringify(res, null, 1))
  console.log(`seed ${seed}: ${file} (${Math.round((Date.now() - t0) / 1000)} с, нет чанков ${missingChunks})`)
}

function cmdSum () {
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.json'))
  const rows = files.map(f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')))
  const K = ['rp', 'surface', 'open-cave', 'closed-cave', 'enclosed']
  const agg: Record<string, any> = {} as Record<string, any>
  for (const r of rows) {
    const bc = r.byClass
    const g = k => bc[k] && bc[k].fastest10 ? `${bc[k].ge10}× ${bc[k].fastest10.near}м/${bc[k].fastest10.depth}гл/${bc[k].fastest10.est}с` : (bc[k] ? `${bc[k].clusters}кл<10` : '—')
    for (const k of K) { const a = agg[k] || (agg[k] = { seeds: 0, has10: 0, near: [], est: [] }); a.seeds++; if (bc[k] && bc[k].fastest10) { a.has10++; a.near.push(bc[k].fastest10.near); a.est.push(bc[k].fastest10.est) } }
    const d = r.deep.nearestOpen
    const a = agg.deepOpen || (agg.deepOpen = { seeds: 0, has10: 0, near: [], est: [] }); a.seeds++; if (d) { a.has10++; a.near.push(d.near); a.est.push(d.est) }
    const u = r.nearestUsable[0]
    const b = agg.best || (agg.best = { seeds: 0, has10: 0, near: [], est: [], cls: {} as Record<string, any> }); b.seeds++
    const cands = [u ? { cls: u.class, est: u.est, near: u.near } : null, d ? { cls: 'deep-open', est: d.est, near: d.near } : null].filter(Boolean).sort((x, y) => x.est - y.est)
    if (cands[0]) { b.has10++; b.near.push(cands[0].near); b.est.push(cands[0].est); b.cls[cands[0].cls] = (b.cls[cands[0].cls] || 0) + 1 }
    console.log([`сид ${r.seed}`, `${r.area.size}², нет ${r.area.missingChunks}`, ...K.map(k => `${k} ${g(k)}`),
      `низ откр ${d ? `${d.near}м/${d.depth}гл/${d.est}с` : '—'}`,
      `овраги ок ${r.ravines.columns} (дно ≥ ${r.ravines.minFloor}), магма ${r.ravines.withMagma}, лава ${r.ravines.withLava}`,
      `RP: ${r.ruinedPortals.map(p => `${p.d}м ${p.placement} обс${p.obsidian}+${p.crying} лава${p.lavaSrc}`).join('; ') || '—'}`].join(' | '))
  }
  const med = a => { if (!a.length) return '—'; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)] }
  // Доля сидов, где ближайший годный источник класса — в пределах R от спавна (поверху видно до дальности прорисовки:
  // ферма 8 чанков = 128, server-run 10 = 160).
  const within = (r, k, R) => { const e = r.byClass[k]; return !!(e && e.nearest10 && e.nearest10.near <= R) }
  const n = rows.length
  const pct = f => `${rows.filter(f).length}/${n}`
  console.log(`
в пределах R от спавна (≥10 ист.):`)
  for (const R of [96, 128, 160, 256, 384]) {
    console.log(`R ${String(R).padStart(3)}: поверхность ${pct(r => within(r, 'surface', R))}, руины-лава ${pct(r => within(r, 'rp', R))}, руины любые ${pct(r => r.ruinedPortals.some(p => p.d <= R))}, открытая пещера ${pct(r => within(r, 'open-cave', R))}, пещера ≤30 вглубь ${pct(r => (r.nearestUsable || []).some(u => u.class === 'open-cave' && u.near <= R && (u.depth || 0) <= 30))}, поверх.|руины-лава ${pct(r => within(r, 'surface', R) || within(r, 'rp', R))}`)
  }
  const rpAll = rows.flatMap(r => r.ruinedPortals)
  console.log(`руин в квадратах: ${rpAll.length} на ${n} сидов; с лавой ≥5 ист.: ${rpAll.filter(p => p.lavaSrc >= 5).length}; обсидиан в рамке-зоне медиана ${med(rpAll.map(p => p.obsidian))}, плачущий ${med(rpAll.map(p => p.crying))}; размещение ${JSON.stringify(rpAll.reduce((m, p) => { m[p.placement] = (m[p.placement] || 0) + 1; return m }, {} as Record<string, any>))}`)
  const dp = rows.map(r => r.deep.nearestOpen).filter(Boolean)
  console.log(`низ (≤ −55, открыт к поверхности): сидов ${dp.length}/${n}, по горизонтали медиана ${med(dp.map(d => d.near))} м, глубина под поверхностью медиана ${med(dp.map(d => d.depth))}`)
  const rav = rows.map(r => r.ravines)
  console.log(`океанские впадины (дно на 10+ ниже кольца 8 бл.): столбов ${rav.reduce((a, b) => a + b.columns, 0)}, у дна магма ${rav.reduce((a, b) => a + b.withMagma, 0)}, лава ${rav.reduce((a, b) => a + b.withLava, 0)}; магма всего ${rows.reduce((a, r) => a + r.counts.magma, 0)} (под водой ${rows.reduce((a, r) => a + r.counts.magmaUnderWater, 0)})`)
  console.log('\nкласс: есть ≥10 ист. в квадрате / сидов; медиана ближайшего (м) и оценки пути (с)')
  for (const [k, a] of Object.entries<any>(agg)) console.log(`${k.padEnd(12)} ${a.has10}/${a.seeds}  м ${med(a.near)}  с ${med(a.est)}${a.cls ? '  ' + JSON.stringify(a.cls) : ''}`)
}

// Поверхностные озёра лавы (кластеры с небом, не у руин) на площадь биома: где их чаще. Озеро засчитано в биом
// своей клетки; площадь — поверхность всех сканов с biomeArea. Ставка — на 1000 чанков поверхности биома.
function cmdBiomes () {
  const rows = fs.readdirSync(OUT).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'))).filter(r => r.biomeArea)
  const area: Record<string, any> = {} as Record<string, any>; const lakes: Record<string, any> = {} as Record<string, any>; const lakes10: Record<string, any> = {} as Record<string, any>
  for (const r of rows) {
    for (const [b, a] of Object.entries<any>(r.biomeArea)) area[b] = (area[b] || 0) + a
    for (const l of r.surfaceLakes || []) { lakes[l.biome] = (lakes[l.biome] || 0) + 1; if (l.src >= 10) lakes10[l.biome] = (lakes10[l.biome] || 0) + 1 }
  }
  const total = Object.values<any>(area).reduce((a, b) => a + b, 0)
  const all = Object.values<any>(lakes).reduce((a, b) => a + b, 0); const all10 = Object.values<any>(lakes10).reduce((a, b) => a + b, 0)
  console.log(`сканов ${rows.length}, поверхность ${Math.round(total / 256)} чанков, озёр ${all} (≥10 ист. ${all10}); на 1000 чанков: ${(all10 / total * 256000).toFixed(2)}`)
  const list = Object.keys(area).map(b => ({ b, chunks: area[b] / 256, n: lakes[b] || 0, n10: lakes10[b] || 0 })).sort((x, y) => y.chunks - x.chunks)
  for (const e of list) if (e.chunks >= 50 || e.n) console.log(`${e.b.padEnd(26)} ${String(Math.round(e.chunks)).padStart(6)} чанков  озёр ${e.n} (≥10: ${e.n10})  на 1000 ч: ${(e.n10 / e.chunks * 1000).toFixed(2)}`)
}

async function main () {
  const [cmd, a, b, c] = process.argv.slice(2)
  if (cmd === 'gen') return cmdGen(Number(a), Number(b || 256))
  if (cmd === 'scan') return cmdScan(Number(a), Number(b || 256), c)
  if (cmd === 'sum') return cmdSum()
  if (cmd === 'biomes') return cmdBiomes()
  console.log(fs.readFileSync(__filename.replace(/\.js$/, '.ts'), 'utf8').split('\n').slice(1, 12).join('\n'))
}
main().catch(e => { console.error(e); process.exitCode = 1 })
