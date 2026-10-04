'use strict'
// Скан копии мира для маршрута (поток route, 03.10.2026): руда железа, уголь, гравий и вода, которые ВИДНЫ из воздуха,
// связанного с поверхностью (пещеры, овраги, склоны — куда можно войти не копая). Правило AGENTS.md: знание карты из
// копии этого же мира разрешено; бот всё равно копает только то, что видит прицел (pick.js), — скан говорит, куда идти.
// Только ферма, только свои слоты (8–15, 27–30).
//
//   node farm/route-scan/scan.js gen <slot> [half=160]    прогрузить квадрат 2*half вокруг спавна (forceload), save-all
//   node farm/route-scan/scan.js scan <slot> [half=160]   прочитать region-файлы слота → farm/route-scan/<seed>.json
//   node farm/route-scan/scan.js sum                       сводка по всем <seed>.json
//
// Чтение .mca — как farm/portal-scan/scan.js (агент G): zlib + NBT, палитры 1.18+.
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const net = require('net')
const nbt = require(path.join(__dirname, '..', '..', 'daemon', 'node_modules', 'prismarine-nbt'))

const ROOT = path.join(__dirname, '..', '..')
const OUT = __dirname
const MIN_Y = -64
const H = 384
// Слоты потока route (раунд 3, 03.10 13:34): 8–20 и 27–29.
const ALLOWED = new Set([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 27, 28, 29])

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
  const send = (type, body) => new Promise((resolve, reject) => {
    const id = nextId++
    const t = setTimeout(() => { waiting.delete(id); reject(new Error('rcon timeout: ' + body)) }, 60000)
    waiting.set(id, r => { clearTimeout(t); resolve(r) })
    sock.write(pkt(id, type, body))
  })
  const ready = new Promise((resolve, reject) => {
    sock.once('connect', async () => {
      try { const r = await send(3, pass); if (r === null) reject(new Error('rcon auth')); else resolve() } catch (e) { reject(e) }
    })
    sock.once('error', reject)
  })
  return { ready, cmd: body => send(2, body), close: () => sock.end() }
}

function slotInfo (slot) {
  if (!ALLOWED.has(slot)) throw new Error(`слот ${slot}: потоку route можно только 8–20, 27–29`)
  const dir = path.join(ROOT, 'farm', `server-${slot}`)
  const props = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8')
  const get = k => (new RegExp('^' + k.replace('.', '\\.') + '=(.*)$', 'm').exec(props) || [])[1]
  return { dir, rcon: Number(get('rcon.port')), pass: get('rcon.password'), seed: get('level-seed') }
}
function longStr (v) {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return ((BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0)).toString()
  return String(v)
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
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function cmdGen (slot, half) {
  const s = slotInfo(slot)
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
  for (let bx = scx - hc; bx < scx + hc; bx += 16) {
    for (let bz = scz - hc; bz < scz + hc; bz += 16) {
      const x2 = Math.min(bx + 15, scx + hc - 1); const z2 = Math.min(bz + 15, scz + hc - 1)
      await rc.cmd(`forceload add ${bx * 16} ${bz * 16} ${x2 * 16 + 15} ${z2 * 16 + 15}`)
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
    }
  }
  await rc.cmd('save-all flush')
  rc.close()
  console.log(JSON.stringify({ slot, spawn, seconds: Math.round((Date.now() - t0) / 1000) }))
}

const regionCache = new Map()
function readChunkNbtRaw (worldDir, cx, cz, sub = 'region') {
  const rx = cx >> 5; const rz = cz >> 5
  const file = path.join(worldDir, sub, `r.${rx}.${rz}.mca`)
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
const C = { OTHER: 0, AIR: 1, WATER_SRC: 2, WATER: 3, LAVA: 4, SOFT: 5, IRON: 6, COAL: 7, GRAVEL: 8, LEAVES: 9, LOG: 10, LAVA_SRC: 11, PLANK: 12 }
const SOFT = /(grass|fern|flower|tulip|orchid|allium|bluet|daisy|poppy|dandelion|lily_of|cornflower|bush|sapling|vine|^snow$|torch|carpet|button|pressure_plate|rail|sugar_cane|mushroom$|roots|sprouts|lichen|moss_carpet|petals|leaf_litter|firefly_bush|hanging_moss|dripleaf|spore_blossom|hanging_roots|pointed_dripstone|amethyst_bud|amethyst_cluster|sweet_berry|pitcher|torchflower)/
function codeOf (state) {
  const n = state.Name.replace('minecraft:', '')
  const p = state.Properties || {}
  if (n === 'air' || n === 'cave_air' || n === 'void_air') return C.AIR
  if (n === 'water') return (p.level === '0' || p.level === undefined) ? C.WATER_SRC : C.WATER
  if (/^(bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/.test(n) || p.waterlogged === 'true') return C.WATER
  if (n === 'lava') return (p.level === '0' || p.level === undefined) ? C.LAVA_SRC : C.LAVA
  if (n === 'iron_ore' || n === 'deepslate_iron_ore') return C.IRON
  if (n === 'coal_ore' || n === 'deepslate_coal_ore') return C.COAL
  if (n === 'gravel') return C.GRAVEL
  if (/_planks$/.test(n)) return C.PLANK
  if (/leaves$/.test(n)) return C.LEAVES
  if (/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/.test(n)) return C.LOG
  // grass_block — земля, а не трава: SOFT (/grass/) делал дёрн проходимым — клетки «где стоять» сканом оказывались в
  // дёрне (на 1 ниже ног), луч к гравию/руде шёл сквозь дёрн (rt3-A1/A3: «не вижу gravel в 12» у клетки скана; проверено
  // на слоте 18 03.10: клетка скана −79,76,31 — grass_block).
  if (n === 'grass_block' || n === 'dirt_path' || n === 'farmland' || n === 'mycelium' || n === 'podzol') return C.OTHER
  if (SOFT.test(n)) return C.SOFT
  return C.OTHER
}

// Только видимые с сухого stand клетки. Координаты — реальный блок, не центроид группы в стене.
function woodGroups (cells, structs, spawn) {
  const groups = new Map()
  for (const c of cells) {
    if (!c.stand) continue
    const building = structs.find(s => c.x >= s.bb[0] && c.x <= s.bb[3] && c.y >= s.bb[1] && c.y <= s.bb[4] && c.z >= s.bb[2] && c.z <= s.bb[5])
    const inside = building ? building.name : null
    const key = `${Math.floor(c.x / 8)},${Math.floor(c.z / 8)},${inside || ''}`
    const g = groups.get(key) || { x: c.x, y: c.y, z: c.z, stand: c.stand, n: 0, logs: 0, planks: 0, in: inside, d: Math.round(Math.hypot(c.stand.x - spawn.x, c.stand.z - spawn.z)) }
    g.n++; g[/_planks$/.test(c.name) ? 'planks' : 'logs']++
    groups.set(key, g)
  }
  return [...groups.values()].filter(g => g.logs * 4 + g.planks >= 9).sort((a, b) => a.d - b.d).slice(0, 120)
}
async function cmdScan (slot, half) {
  const s = slotInfo(slot)
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
  const grid = new Uint8Array(W * W * H)
  const ground = new Int16Array(W * W).fill(-1) // MOTION_BLOCKING_NO_LEAVES − 1: верх рельефа без листвы
  const at = (x, y, z) => (y * W + z) * W + x
  let missing = 0
  const chests = []
  const structs = []
  const mobs = []
  const animals = []
  const woodCells = []
  const beds = []
  const tmp = new Uint16Array(4096)
  const t0 = Date.now()
  for (let i = 0; i < NC; i++) {
    for (let k = 0; k < NC; k++) {
      const raw = readChunkNbtRaw(worldDir, cx0 + i, cz0 + k)
      if (!raw) { missing++; continue }
      const v = nbt.parseUncompressed(raw).value
      const status = v.Status ? v.Status.value : '?'
      if (!/full/.test(status)) { missing++; continue }
      for (const sec of (v.sections ? v.sections.value.value : [])) {
        const ys = sec.Y.value * 16 - MIN_Y
        if (ys < 0 || ys >= H) continue
        const bs = sec.block_states && sec.block_states.value
        if (!bs) continue
        const pal = bs.palette.value.value.map(e => nbt.simplify({ type: 'compound', value: e }))
        const codes = pal.map(codeOf)
        if (pal.length === 1 || !bs.data) tmp.fill(0)
        else unpack(longsOf(bs.data.value), Math.max(4, Math.ceil(Math.log2(pal.length))), 4096, tmp)
        for (let j = 0; j < 4096; j++) {
          const x = i * 16 + (j & 15); const y = ys + (j >> 8); const z = k * 16 + ((j >> 4) & 15)
          const code = codes[tmp[j]]
          grid[at(x, y, z)] = code
          if (code === C.LOG || code === C.PLANK) woodCells.push({ x, y, z, name: pal[tmp[j]].Name.replace('minecraft:', '') })
        }
      }
      // Сундуки построек: блок-сущности с таблицей лута (ещё не открыты) — место и таблица (лут решится при открытии).
      const bel = (v.block_entities && v.block_entities.value && v.block_entities.value.value) || []
      for (const e of bel) {
        const b = nbt.simplify({ type: 'compound', value: e })
        // Кровати построек (деревня, иглу; скан v6): у кровати блок-сущность на каждой половине — пары сливаются ниже.
        if (/:bed$/.test(String(b.id || ''))) { beds.push({ x: b.x, y: b.y, z: b.z }); continue }
        if (!/chest|barrel/.test(String(b.id || ''))) continue
        if (b.LootTable) chests.push({ x: b.x, y: b.y, z: b.z, table: String(b.LootTable).replace(/^minecraft:(chests\/)?/, ''), id: String(b.id).replace('minecraft:', '') })
      }
      // Постройки: старт и коробка (BB) — где на самом деле встала (cubiomes знает попытку, не всегда — постройку).
      const st = v.structures && v.structures.value && v.structures.value.starts && v.structures.value.starts.value
      if (st) {
        for (const [name, tag] of Object.entries(st)) {
          const s2 = nbt.simplify(tag)
          if (!s2 || s2.id === 'INVALID') continue
          const bbs = (s2.Children || []).map(c => c.BB).filter(Boolean)
          if (!bbs.length) continue
          const bb = bbs.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3]), Math.max(a[4], b[4]), Math.max(a[5], b[5])])
          structs.push({ name: name.replace('minecraft:', ''), bb, pieces: bbs.length, template: (s2.Children[0] && s2.Children[0].Template) || null })
        }
      }
      // Сущности при генерации (голем деревни, жители) — отдельные файлы entities/.
      try {
        const rawE = readChunkNbtRaw(worldDir, cx0 + i, cz0 + k, 'entities')
        if (rawE) {
          const L = (nbt.parseUncompressed(rawE).value.Entities || {}).value
          for (const e of ((L && L.value) || [])) {
            const m = nbt.simplify({ type: 'compound', value: e })
            if (/iron_golem|villager/.test(String(m.id || '')) && Array.isArray(m.Pos)) mobs.push({ id: String(m.id).replace('minecraft:', ''), x: Math.round(m.Pos[0]), y: Math.round(m.Pos[1]), z: Math.round(m.Pos[2]) })
            // Звери при генерации (скан v6): овцы с цветом шерсти (Color, 0 — белая) — кровать до ночи; коровы/свиньи/куры — еда.
            else if (/:(sheep|cow|pig|chicken|rabbit|mooshroom)$/.test(String(m.id || '')) && Array.isArray(m.Pos)) animals.push({ id: String(m.id).replace('minecraft:', ''), x: Math.round(m.Pos[0]), y: Math.round(m.Pos[1]), z: Math.round(m.Pos[2]), ...(/sheep/.test(m.id) ? { c: Number(m.Color || 0), sh: m.Sheared ? 1 : 0 } : {}) })
          }
        }
      } catch {}
      const hm = v.Heightmaps && v.Heightmaps.value && (v.Heightmaps.value.MOTION_BLOCKING_NO_LEAVES || v.Heightmaps.value.OCEAN_FLOOR)
      if (hm) {
        const arr = new Uint16Array(256)
        unpack(longsOf(hm.value), 9, 256, arr)
        for (let j = 0; j < 256; j++) ground[(k * 16 + (j >> 4)) * W + (i * 16 + (j & 15))] = arr[j] - 1 // индекс y верхнего блока
      }
    }
  }
  // Верх столба (первая сверху не-воздушная клетка, листва — тоже верх: над ней небо).
  const top = new Int16Array(W * W).fill(-1)
  for (let z = 0; z < W; z++) for (let x = 0; x < W; x++) for (let y = H - 1; y >= 0; y--) { if (grid[at(x, y, z)] !== C.AIR) { top[z * W + x] = y; break } }
  // Воздух, связанный с поверхностью (BFS от клетки над верхом столба по воздуху и мягким блокам); значение — шагов от
  // поверхности + 1 (сколько идти пещерой, не копая), 0 — закрытый воздух.
  const openAir = new Uint16Array(grid.length)
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
        if (ny > top[nz * W + nx] + 1) continue
        const nid = at(nx, ny, nz)
        if (openAir[nid]) continue
        const c = grid[nid]
        if (c !== C.AIR && c !== C.SOFT) continue
        openAir[nid] = Math.min(65535, openAir[cur] + 1); push(nid)
      }
    }
  }
  const top0 = (x, z) => top[z * W + x]
  const sx = spawn.x - X0; const sz = spawn.z - Z0
  const hdist = (x, z) => Math.round(Math.hypot(x - sx, z - sz))
  const nb6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
  const inb = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < W
  const openFace = (x, y, z) => { for (const [dx, dy, dz] of nb6) { const nx = x + dx; const ny = y + dy; const nz = z + dz; if (inb(nx, ny, nz) && openAir[at(nx, ny, nz)]) return true } return false }
  // Луч от глаз (клетка ног + 1.62) к центру блока: все клетки по пути — воздух/мягкие, первая твёрдая — сам блок.
  const passable = c => c === C.AIR || c === C.SOFT
  const losTo = (ex, ey, ez, x, y, z) => {
    const ox = ex; const oy = ey; const oz = ez
    const tx = x + 0.5; const ty = y + 0.5; const tz = z + 0.5
    const len = Math.hypot(tx - ox, ty - oy, tz - oz)
    const n = Math.ceil(len * 8)
    for (let i = 1; i < n; i++) {
      const f = i / n
      const cx = Math.floor(ox + (tx - ox) * f); const cy = Math.floor(oy + (ty - oy) * f); const cz = Math.floor(oz + (tz - oz) * f)
      if (cx === x && cy === y && cz === z) return true
      if (!inb(cx, cy, cz)) return false
      if (!passable(grid[at(cx, cy, cz)])) return false
    }
    return true
  }
  // Клетка, где можно стоять у руды: воздух ног и головы связан с поверхностью, пол твёрдый, в 1–4 бл. от руды,
  // и с глаз руда видна (луч до неё без твёрдого по пути).
  const standNear = (x, y, z) => {
    let best = null
    for (let dy = -3; dy <= 1; dy++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          const fx = x + dx; const fy = y + dy; const fz = z + dz
          if (!inb(fx, fy - 1, fz) || !inb(fx, fy + 1, fz)) continue
          if (!openAir[at(fx, fy, fz)] || !openAir[at(fx, fy + 1, fz)]) continue
          const fl = grid[at(fx, fy - 1, fz)]
          if (fl === C.AIR || fl === C.WATER || fl === C.WATER_SRC || fl === C.LAVA || fl === C.SOFT) continue
          const d = Math.hypot(dx, dy + 1.1, dz)
          if (d > 4.3) continue
          if (!losTo(fx + 0.5, fy + 1.62, fz + 0.5, x, y, z)) continue
          if (!best || d < best.d) best = { x: fx, y: fy, z: fz, d }
        }
      }
    }
    return best
  }
  // Жилы железа (6-связность, вместе со скрытыми клетками), у которых хоть одна клетка у открытого воздуха.
  const seen = new Uint8Array(grid.length)
  const stack = new Int32Array(1 << 20)
  const veins = { [C.IRON]: [], [C.COAL]: [], [C.GRAVEL]: [] }
  const buriedIron = []
  const buriedGravel = []
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < W; z++) {
      for (let x = 0; x < W; x++) {
        const id = at(x, y, z)
        const c = grid[id]
        if ((c !== C.IRON && c !== C.COAL && c !== C.GRAVEL) || seen[id]) continue
        let sp = 0; stack[sp++] = id; seen[id] = 1
        const cells = []
        let open = 0; let best = null
        while (sp) {
          const cur = stack[--sp]
          const cy = Math.floor(cur / (W * W)); const rem = cur - cy * W * W; const cz = Math.floor(rem / W); const cx = rem - cz * W
          cells.push(cur)
          if (openFace(cx, cy, cz)) {
            open++
            if (!best || Math.abs(cy - top[cz * W + cx]) < Math.abs(best[1] - top[best[2] * W + best[0]])) best = [cx, cy, cz]
          }
          for (const [dx, dy, dz] of nb6) {
            const nx = cx + dx; const ny = cy + dy; const nz = cz + dz
            if (!inb(nx, ny, nz)) continue
            const nid = at(nx, ny, nz)
            if (grid[nid] === c && !seen[nid] && sp < stack.length) { seen[nid] = 1; stack[sp++] = nid }
          }
        }
        // Закрытая жила железа неглубоко (скан v6, поток route 03.10): до неё — свой колодец сверху без пещер по пути
        // (столбец над верхней клеткой жилы до рельефа — порода, по бокам колодца — не воздух/вода/лава). Этап железа под
        // землёй (штреки к y 16) стоил 600–930 с и трёх смертей в rt3-A1; колодец на 4–14 бл. — ~1 мин.
        // То же для гравия (огонь: кремень 10 % за блок): закрытая залежь ≥ 10 блоков неглубоко — колодец к ней (rt3: кремень
        // ✗ — главный остаток потерь; у трети сидов открытого сухого гравия в 200 м нет).
        if (!open && (c === C.IRON ? cells.length >= 3 : c === C.GRAVEL && cells.length >= 10)) {
          let tb = null
          for (const cur of cells) { const yy = Math.floor(cur / (W * W)); const rr = cur - yy * W * W; const zz = Math.floor(rr / W); const xx = rr - zz * W; if (!tb || yy > tb[1]) tb = [xx, yy, zz] }
          const g0 = ground[tb[2] * W + tb[0]]
          const depthB = g0 >= 0 ? g0 - tb[1] : -1
          if (depthB >= 2 && depthB <= 14) {
            let ok = true
            const bad = q => q === C.AIR || q === C.WATER || q === C.WATER_SRC || q === C.LAVA || q === C.LAVA_SRC
            for (let y2 = tb[1] + 1; y2 <= g0 && ok; y2++) {
              const q = grid[at(tb[0], y2, tb[2])]
              if (bad(q) && y2 < g0) { ok = false; break }
              // По бокам ствола: ниже 2 верхних — ни воздуха, ни жидкости; у верха — без воды/лавы (колодец у лужи/реки
              // tunnel не копает: «вода снизу — колодец не копаю», rt3-A3).
              const wetQ = q => q === C.WATER || q === C.WATER_SRC || q === C.LAVA || q === C.LAVA_SRC
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                const nx = tb[0] + dx; const nz = tb[2] + dz
                if (!inb(nx, y2, nz)) continue
                const q = grid[at(nx, y2, nz)]
                if ((y2 <= g0 - 2 && Math.abs(dx) + Math.abs(dz) === 1 && bad(q)) || wetQ(q)) { ok = false; break }
              }
            }
            if (ok) (c === C.IRON ? buriedIron : buriedGravel).push({ x: tb[0] + X0, y: tb[1] + MIN_Y, z: tb[2] + Z0, n: cells.length, depth: depthB, top: g0 + MIN_Y, d: hdist(tb[0], tb[2]) })
          }
        }
        if (!open || !best) continue
        if (c === C.GRAVEL && cells.length < 3) continue
        const [bx, by, bz] = best
        const gtop = ground[bz * W + bx] >= 0 ? ground[bz * W + bx] : top[bz * W + bx]
        const st = standNear(bx, by, bz)
        if (!st) continue
        // Вода у клетки (водоносный слой пещеры): утонул у руды — rt-R1 слот 8, y 35–45. Сколько воды в кубе ±3.
        let wet = 0
        for (let dy = -2; dy <= 3; dy++) for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) {
          const qx = st.x + dx; const qy = st.y + dy; const qz = st.z + dz
          if (inb(qx, qy, qz)) { const q = grid[at(qx, qy, qz)]; if (q === C.WATER || q === C.WATER_SRC || q === C.LAVA || q === C.LAVA_SRC) wet++ }
        }
        const walk = openAir[at(st.x, st.y, st.z)] - 1
        veins[c].push({ x: bx + X0, y: by + MIN_Y, z: bz + Z0, n: cells.length, open, depth: Math.max(0, gtop - by), d: hdist(bx, bz), wet, walk, stand: { x: st.x + X0, y: st.y + MIN_Y, z: st.z + Z0 } })
      }
    }
  }
  // Вода: источники с открытым воздухом сверху (черпак сверху) и берегом рядом, ближние к спавну.
  const water = []
  for (let z = 0; z < W; z += 1) {
    for (let x = 0; x < W; x += 1) {
      for (let y = H - 2; y > 0; y--) {
        const c = grid[at(x, y, z)]
        if (c === C.AIR || c === C.SOFT || c === C.LEAVES) continue
        if (c === C.WATER_SRC && openAir[at(x, y + 1, z)]) {
          const st = standNear(x, y + 1, z)
          if (st) water.push({ x: x + X0, y: y + MIN_Y, z: z + Z0, d: hdist(x, z), stand: { x: st.x + X0, y: st.y + MIN_Y, z: st.z + Z0 }, depth: Math.max(0, (ground[z * W + x] >= 0 ? ground[z * W + x] : top[z * W + x]) - y) })
        }
        break
      }
    }
  }
  water.sort((a, b) => a.d - b.d)
  // Лава: тела (6-связность по лаве), источники с воздухом сверху (черпак), глубина верхнего такого источника под
  // рельефом, связан ли воздух над ним с поверхностью (open — войти без копки), ближний к спавну такой источник.
  const lavaBodies = []
  {
    const seenL = new Uint8Array(grid.length)
    for (let y = 1; y < H - 1; y++) {
      for (let z = 0; z < W; z++) {
        for (let x = 0; x < W; x++) {
          const id0 = at(x, y, z)
          const c0 = grid[id0]
          if ((c0 !== C.LAVA_SRC && c0 !== C.LAVA) || seenL[id0]) continue
          let sp = 0; stack[sp++] = id0; seenL[id0] = 1
          let all = 0; let src = 0; let top = 0; let openTop = 0; let best = null; let bestDepth = 1e9; let minY = 1e9
          while (sp) {
            const cur = stack[--sp]
            const cy = Math.floor(cur / (W * W)); const rem = cur - cy * W * W; const cz = Math.floor(rem / W); const cx = rem - cz * W
            all++
            minY = Math.min(minY, cy)
            if (grid[cur] === C.LAVA_SRC) {
              src++
              const up = cy + 1 < H ? grid[at(cx, cy + 1, cz)] : C.AIR
              if (up === C.AIR || up === C.SOFT) {
                top++
                const open = openAir[at(cx, cy + 1, cz)] ? 1 : 0
                openTop += open
                const g = ground[cz * W + cx] >= 0 ? ground[cz * W + cx] : top0(cx, cz)
                const depth = Math.max(0, g - cy)
                const dd = hdist(cx, cz)
                const score = dd + depth * 2.5 - open * 20
                if (!best || score < best.score) best = { x: cx + X0, y: cy + MIN_Y, z: cz + Z0, d: dd, depth, open, score }
                bestDepth = Math.min(bestDepth, depth)
              }
            }
            for (const [dx, dy, dz] of nb6) {
              const nx = cx + dx; const ny = cy + dy; const nz = cz + dz
              if (!inb(nx, ny, nz)) continue
              const nid = at(nx, ny, nz)
              const nc = grid[nid]
              if ((nc === C.LAVA_SRC || nc === C.LAVA) && !seenL[nid] && sp < stack.length) { seenL[nid] = 1; stack[sp++] = nid }
            }
          }
          if (top >= 10 && best) lavaBodies.push({ x: best.x, y: best.y, z: best.z, d: best.d, depth: best.depth, src, top, openTop, minY: minY + MIN_Y })
        }
      }
    }
  }
  lavaBodies.sort((a, b) => (a.d + a.depth * 2.5) - (b.d + b.depth * 2.5))
  // Деревья: брёвна над рельефом (выше верха земли без листвы — ствол стоит на поверхности), по клеткам 8×8.
  const cellsT = new Map()
  for (let z = 0; z < W; z++) {
    for (let x = 0; x < W; x++) {
      const g0 = ground[z * W + x]
      const t0 = top[z * W + x]
      if (t0 < 0) continue
      for (let y = Math.max(0, (g0 >= 0 ? g0 : t0) - 1); y <= Math.min(H - 1, t0); y++) {
        if (grid[at(x, y, z)] !== C.LOG) continue
        const k = `${x >> 3},${z >> 3}`
        const c = cellsT.get(k) || { n: 0, x: 0, y: 0, z: 0 }
        c.n++; c.x += x; c.y += y; c.z += z
        cellsT.set(k, c)
      }
    }
  }
  const trees = [...cellsT.values()].filter(c => c.n >= 4).map(c => {
    const x = Math.round(c.x / c.n); const z = Math.round(c.z / c.n)
    return { x: x + X0, y: Math.round(c.y / c.n) + MIN_Y, z: z + Z0, n: c.n, d: hdist(x, z) }
  }).sort((a, b) => a.d - b.d)
  const sortIron = a => a.sort((p, q) => (p.d + p.depth * 2 - Math.min(p.n, 8) * 6) - (q.d + q.depth * 2 - Math.min(q.n, 8) * 6))
  const out = {
    seed,
    spawn,
    half,
    v: 7,
    made: new Date().toISOString(),
    missingChunks: missing,
    seconds: Math.round((Date.now() - t0) / 1000),
    iron: sortIron(veins[C.IRON].filter(v => v.depth <= 40)).slice(0, 60),
    ironAll: veins[C.IRON].length,
    // Закрытые жилы железа неглубоко, колодец к ним без пещер (v6): ближние и богатые вперёд.
    gravelBuried: buriedGravel.filter(v => v.depth <= 10).sort((a, b) => (a.d + a.depth * 3 - Math.min(a.n, 30)) - (b.d + b.depth * 3 - Math.min(b.n, 30))).slice(0, 40),
    ironBuried: buriedIron.sort((a, b) => (a.d + a.depth * 3 - Math.min(a.n, 8) * 4) - (b.d + b.depth * 3 - Math.min(b.n, 8) * 4)).slice(0, 60),
    coal: veins[C.COAL].filter(v => v.depth <= 24).sort((a, b) => a.d - b.d).slice(0, 30),
    // Гравий: сухой (без воды у клетки) вперёд — у рек под водой его не берут (mine dry), а ближние речные вытесняли
    // сухие из списка (rt-R4: «не вижу gravel»).
    gravel: veins[C.GRAVEL].filter(v => v.depth <= 6).sort((a, b) => ((a.wet > 0) - (b.wet > 0)) || a.d - b.d).slice(0, 60),
    water: water.slice(0, 60),
    trees: trees.slice(0, 40),
    wood: process.env.ND_ROUTE_WOODMAP === '0' ? [] : woodGroups(woodCells.map(c => {
      const st = standNear(c.x, c.y, c.z)
      if (!st) return { ...c, stand: null }
      return { ...c, x: c.x + X0, y: c.y + MIN_Y, z: c.z + Z0, stand: { x: st.x + X0, y: st.y + MIN_Y, z: st.z + Z0 } }
    }), structs, spawn),
    lava: lavaBodies.slice(0, 30),
    chests: chests.map(c => {
      // Вода над сундуком и у него (клад под морем, сундук руин в океане): клеток воды в кубе ±2 и столбе на 6 вверх.
      let wet = 0
      const lx = c.x - X0; const ly = c.y - MIN_Y; const lz = c.z - Z0
      for (let dy = -1; dy <= 6; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (dy > 2 && (dx || dz)) continue
        const qx = lx + dx; const qy = ly + dy; const qz = lz + dz
        if (inb(qx, qy, qz)) { const q = grid[at(qx, qy, qz)]; if (q === C.WATER || q === C.WATER_SRC) wet++ }
      }
      // Верх рельефа над сундуком (v6): сундук руин на 6+ ниже — руины под землёй (route: мимо).
      const g0 = (lx >= 0 && lx < W && lz >= 0 && lz < W) ? ground[lz * W + lx] : -1
      return { ...c, wet, gy: g0 >= 0 ? g0 + MIN_Y : null, d: Math.round(Math.hypot(c.x - spawn.x, c.z - spawn.z)) }
    }).sort((a, b) => a.d - b.d).slice(0, 120),
    structures: structs.map(t => ({ ...t, d: Math.round(Math.hypot((t.bb[0] + t.bb[3]) / 2 - spawn.x, (t.bb[2] + t.bb[5]) / 2 - spawn.z)) })).sort((a, b) => a.d - b.d).slice(0, 60),
    golems: mobs.filter(m => m.id === 'iron_golem').map(m => ({ ...m, d: Math.round(Math.hypot(m.x - spawn.x, m.z - spawn.z)) })).sort((a, b) => a.d - b.d),
    villagers: mobs.filter(m => m.id === 'villager').length,
    animals: animals.map(m => ({ ...m, d: Math.round(Math.hypot(m.x - spawn.x, m.z - spawn.z)) })).sort((a, b) => a.d - b.d).slice(0, 400),
    // Кровати: половины одной кровати (соседние клетки) — одна запись; в постройке (bb) — её имя.
    beds: beds.filter((b, i) => !beds.slice(0, i).some(q => Math.abs(q.x - b.x) + Math.abs(q.z - b.z) <= 1 && q.y === b.y)).map(b => {
      const t = structs.find(s => b.x >= s.bb[0] && b.x <= s.bb[3] && b.z >= s.bb[2] && b.z <= s.bb[5] && b.y >= s.bb[1] - 1 && b.y <= s.bb[4] + 1)
      return { ...b, in: t ? t.name : null, d: Math.round(Math.hypot(b.x - spawn.x, b.z - spawn.z)) }
    }).sort((a, b) => a.d - b.d).slice(0, 60)
  }
  fs.writeFileSync(path.join(OUT, `${seed}.json`), JSON.stringify(out))
  console.log(JSON.stringify({ seed, missing, seconds: out.seconds, iron: out.iron.length, ironAll: out.ironAll, ironNear: out.iron.filter(v => v.d <= 100).length, water: water.length, nearWater: water[0] && water[0].d, trees: trees.length, nearTree: trees[0] && trees[0].d, lava: lavaBodies.length, lava0: lavaBodies[0] ? `${lavaBodies[0].d}м/глуб${lavaBodies[0].depth}/${lavaBodies[0].top}` : null, chests: out.chests.length, structures: out.structures.map(t => `${t.name}:${t.d}`).slice(0, 8).join(' '), golems: out.golems.length }))
}

function cmdSum () {
  const rows = fs.readdirSync(OUT).filter(f => /^-?\d+\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')))
  for (const r of rows) {
    const near = r.iron.filter(v => v.d <= 120 && v.depth <= 16)
    const n = near.reduce((a, v) => a + v.n, 0)
    console.log(`${r.seed}: жил железа у воздуха ≤ 120 м и ≤ 16 вглубь — ${near.length} (руды ${n}), ближняя ${near[0] ? `${near[0].d} м n${near[0].n} глуб ${near[0].depth}` : '—'}; вода ${r.water[0] ? r.water[0].d + ' м' : '—'}`)
  }
}

async function main () {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === 'gen') return cmdGen(Number(a), Number(b || 160))
  if (cmd === 'scan') return cmdScan(Number(a), Number(b || 160))
  if (cmd === 'sum') return cmdSum()
  console.log('gen <slot> [half] | scan <slot> [half] | sum')
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1) })
module.exports = { codeOf, C, woodGroups }
