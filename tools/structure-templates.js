'use strict'
// Шаблоны построек из jar 1.21.11 → daemon/data/structure-templates.json (знание игры, как у спидраннера: где в корабле,
// храме, иглу, доме деревни лежат сундуки). Сундуки — блоки chest/barrel шаблона с LootTable или маркеры данных
// (structure_block DATA): ShipwreckPieces.MARKERS_TO_LOOT (map/supply/treasure_chest → сундук на клетку НИЖЕ маркера),
// IglooPieces ("chest" → ниже), OceanRuinPieces ("chest" → на клетке маркера, big/small). Зеркало и «воздух ставится ли» —
// из makeSettings классов кусков (javap 1.21.11): корабль Mirror.NONE + STRUCTURE_AND_AIR; иглу NONE, воздух ставится;
// руины портала зеркало FRONT_BACK в 50 %, воздух — только с airPocket; подводные руины NONE + STRUCTURE_AND_AIR;
// дома деревни — jigsaw, только поворот, воздух ставится. Веса — из списков кусков (корабль: 20 в океане, 11 на пляже,
// Util.getRandom) и пулов деревень (worldgen/template_pool/village/<биом>/houses.json).
// Храмы пустыни и джунглей — код (DesertPyramidPiece, JungleTemplePiece), не NBT: их слепки снимает
// tools/structure-capture.js с фермы (/place structure на ровной площадке) и пишет сюда же с src: 'capture'.
//
//   node tools/structure-templates.js [путь к paper-1.21.11.jar]
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require(path.join(__dirname, '..', 'daemon', 'node_modules', 'prismarine-nbt'))

const ROOT = path.join(__dirname, '..')
const JAR = process.argv[2] || path.join(ROOT, 'farm', 'server-1', 'versions', '1.21.11', 'paper-1.21.11.jar')
const OUT = path.join(ROOT, 'daemon', 'data', 'structure-templates.json')

// Zip без библиотек: центральный каталог → локальный заголовок → inflateRaw.
function zipIndex (buf) {
  let e = buf.length - 22
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) throw new Error('не zip')
  const n = buf.readUInt16LE(e + 10)
  let p = buf.readUInt32LE(e + 16)
  const out = new Map()
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20)
    const nlen = buf.readUInt16LE(p + 28)
    const xlen = buf.readUInt16LE(p + 30)
    const clen = buf.readUInt16LE(p + 32)
    const off = buf.readUInt32LE(p + 42)
    out.set(buf.toString('utf8', p + 46, p + 46 + nlen), { method, csize, off })
    p += 46 + nlen + xlen + clen
  }
  return {
    names: [...out.keys()],
    read (name) {
      const f = out.get(name)
      if (!f) return null
      const l = f.off
      const start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28)
      const data = buf.subarray(start, start + f.csize)
      return f.method === 8 ? zlib.inflateRawSync(data) : data
    }
  }
}

const CH = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-/:;<=>?@[]^_`{|}~'

async function template (zip, name) {
  const raw = zip.read(`data/minecraft/structure/${name}.nbt`)
  if (!raw) throw new Error(`нет шаблона ${name}`)
  const t = nbt.simplify((await nbt.parse(zlib.gunzipSync(raw), 'big')).parsed)
  const pal0 = (t.palette || t.palettes[0]).map(s => s.Name.replace(/^minecraft:/, ''))
  const [X, Y, Z] = t.size
  const pal = []
  const idx = new Map()
  const id = n => { if (!idx.has(n)) { idx.set(n, pal.length); pal.push(n) } return idx.get(n) }
  const grid = new Array(X * Y * Z).fill(' ')
  const markers = []
  const chests = []
  for (const b of t.blocks) {
    let n = pal0[b.state]
    const [x, y, z] = b.pos
    if (n === 'structure_block') { if (b.nbt && b.nbt.mode === 'DATA') markers.push([x, y, z, b.nbt.metadata]); continue }
    if (n === 'structure_void') continue
    // Jigsaw ставит на своё место final_state.
    if (n === 'jigsaw') n = String((b.nbt && b.nbt.final_state) || 'air').replace(/^minecraft:/, '').replace(/\[.*$/, '')
    if (/^(chest|trapped_chest|barrel)$/.test(n) && b.nbt && b.nbt.LootTable) chests.push([x, y, z, String(b.nbt.LootTable).replace(/^minecraft:chests\//, '')])
    const i = id(n)
    if (i >= CH.length) throw new Error(`${name}: палитра длиннее ${CH.length}`)
    grid[x + X * (z + Z * y)] = CH[i]
  }
  return { size: t.size, pal, grid: grid.join(''), markers, chests }
}

const SHIP_BEACHED = ['with_mast', 'sideways_full', 'sideways_fronthalf', 'sideways_backhalf', 'rightsideup_full', 'rightsideup_fronthalf', 'rightsideup_backhalf',
  'with_mast_degraded', 'rightsideup_full_degraded', 'rightsideup_fronthalf_degraded', 'rightsideup_backhalf_degraded']
const SHIP_OCEAN = ['with_mast', 'upsidedown_full', 'upsidedown_fronthalf', 'upsidedown_backhalf', 'sideways_full', 'sideways_fronthalf', 'sideways_backhalf',
  'rightsideup_full', 'rightsideup_fronthalf', 'rightsideup_backhalf', 'with_mast_degraded', 'upsidedown_full_degraded', 'upsidedown_fronthalf_degraded',
  'upsidedown_backhalf_degraded', 'sideways_full_degraded', 'sideways_fronthalf_degraded', 'sideways_backhalf_degraded', 'rightsideup_full_degraded',
  'rightsideup_fronthalf_degraded', 'rightsideup_backhalf_degraded']
const SHIP_MARKERS = { map_chest: 'shipwreck_map', supply_chest: 'shipwreck_supply', treasure_chest: 'shipwreck_treasure' }

async function main () {
  const zip = zipIndex(fs.readFileSync(JAR))
  const prev = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { templates: {} }
  const T = {}
  const put = (name, kind, t, extra) => { T[name] = { kind, size: t.size, pal: t.pal, grid: t.grid, chests: t.chests, ...extra } }

  // Корабли: сундук — на клетку ниже маркера.
  for (const s of new Set([...SHIP_OCEAN, ...SHIP_BEACHED])) {
    const t = await template(zip, `shipwreck/${s}`)
    for (const [x, y, z, m] of t.markers) if (SHIP_MARKERS[m]) {
      const i = t.chests.findIndex(c => c[0] === x && c[1] === y - 1 && c[2] === z)
      if (i >= 0) t.chests.splice(i, 1)
      t.chests.push([x, y - 1, z, SHIP_MARKERS[m]])
    }
    put(`shipwreck/${s}`, 'shipwreck', t, { air: false, mirror: false, w: { ocean: SHIP_OCEAN.includes(s) ? 1 / SHIP_OCEAN.length : 0, beached: SHIP_BEACHED.includes(s) ? 1 / SHIP_BEACHED.length : 0 } })
  }
  // Иглу: верх всегда, подвал (лестница 4..11 кусков по 3 + лаборатория) в половине (IglooPieces.addPieces).
  for (const [s, extra] of [['top', { pivot: [3, 5, 5], offset: [0, 0, 0] }], ['middle', { pivot: [1, 3, 1], offset: [2, -3, 4] }], ['bottom', { pivot: [3, 6, 7], offset: [0, -3, -2], p: 0.5 }]]) {
    const t = await template(zip, `igloo/${s}`)
    for (const [x, y, z, m] of t.markers) if (m === 'chest') { t.chests = t.chests.filter(c => !(c[0] === x && c[1] === y - 1 && c[2] === z)); t.chests.push([x, y - 1, z, 'igloo_chest']) }
    put(`igloo/${s}`, 'igloo', t, { air: true, mirror: false, ...extra })
  }
  // Руины портала: 5 % гигантские (3), иначе обычные (10) — RuinedPortalStructure; зеркало FRONT_BACK в 50 %.
  for (let i = 1; i <= 10; i++) put(`ruined_portal/portal_${i}`, 'ruined_portal', await template(zip, `ruined_portal/portal_${i}`), { air: false, mirror: true, w: { any: 0.95 / 10 } })
  for (let i = 1; i <= 3; i++) put(`ruined_portal/giant_portal_${i}`, 'ruined_portal', await template(zip, `ruined_portal/giant_portal_${i}`), { air: false, mirror: true, w: { any: 0.05 / 3 } })
  // Подводные руины: сундук на клетке маркера.
  for (const f of zip.names.filter(n => /^data\/minecraft\/structure\/underwater_ruin\/[a-z_0-9]+\.nbt$/.test(n))) {
    const s = f.replace(/^data\/minecraft\/structure\/|\.nbt$/g, '')
    const t = await template(zip, s)
    const big = /\/big_/.test(s)
    for (const [x, y, z, m] of t.markers) if (m === 'chest') t.chests.push([x, y, z, big ? 'underwater_ruin_big' : 'underwater_ruin_small'])
    put(s, 'ocean_ruin', t, { air: false, mirror: false })
  }
  // Аванпост: вышка (сундук наверху).
  for (const s of ['watchtower', 'watchtower_overgrown']) put(`pillager_outpost/${s}`, 'outpost', await template(zip, `pillager_outpost/${s}`), { air: true, mirror: false })
  // Дома деревень — все дома пулов пяти биомов (и без сундуков: чтобы такой дом узнавался как пустой), вес пула.
  for (const biome of ['plains', 'desert', 'savanna', 'snowy', 'taiga']) {
    const pool = JSON.parse(zip.read(`data/minecraft/worldgen/template_pool/village/${biome}/houses.json`).toString('utf8'))
    const total = pool.elements.reduce((s, e) => s + e.weight, 0)
    for (const e of pool.elements) {
      const loc = e.element && e.element.location
      if (!loc) continue
      const s = String(loc).replace(/^minecraft:/, '')
      put(s, 'village', await template(zip, s), { air: e.element.element_type !== 'minecraft:legacy_single_pool_element', mirror: false, biome, w: { slot: e.weight / total } })
    }
  }
  for (const [k, v] of Object.entries(prev.templates || {})) if (v && v.src === 'capture') T[k] = v
  const out = { v: 1, from: path.basename(JAR), templates: T }
  fs.writeFileSync(OUT, JSON.stringify(out))
  const kinds = {}
  for (const v of Object.values(T)) kinds[v.kind] = (kinds[v.kind] || 0) + 1
  console.log(`${Object.keys(T).length} шаблонов → ${path.relative(ROOT, OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} КБ):`, JSON.stringify(kinds))
}

main().catch(e => { console.error(e); process.exit(1) })
