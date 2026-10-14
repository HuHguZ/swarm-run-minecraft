'use strict'
// Слепок постройки, которую строит код, а не NBT (DesertPyramidPiece, JungleTemplePiece 1.21.11), — с мира фермы:
// ровная площадка из белого бетона (его эти постройки не кладут) под воздухом, /place structure в углу чанка (кусок храма
// стоит от угла чанка: DesertPyramidStructure/JungleTempleStructure → new …Piece(random, chunk.minBlockX, chunk.minBlockZ)),
// чтение блоков клиентом. Под площадкой своё — всё, что не бетон (и воздух камеры), над ней — всё, что не воздух.
// Пишет в daemon/data/structure-templates.json (src: 'capture'; tools/structure-templates.js такие хранит).
//
//   node tools/structure-capture.js <слот фермы> desert_pyramid|jungle_pyramid [x z]
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const mineflayer = require(path.join(__dirname, '..', 'daemon', 'node_modules', 'mineflayer'))
const { Vec3 } = require(path.join(__dirname, '..', 'daemon', 'node_modules', 'vec3'))

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'daemon', 'data', 'structure-templates.json')
const [slot, kind, ax, az] = process.argv.slice(2)
const TABLE = { desert_pyramid: 'desert_pyramid', jungle_pyramid: 'jungle_temple' }
if (!slot || !TABLE[kind]) { console.error('node tools/structure-capture.js <слот> desert_pyramid|jungle_pyramid [x z]'); process.exit(1) }
const X0 = Math.floor(Number(ax ?? 20000) / 16) * 16
const Z0 = Math.floor(Number(az ?? 20000) / 16) * 16
const P = 150 // верх площадки
const BASE = 'white_concrete'
const A = { x: X0 - 8, z: Z0 - 8 }
const B = { x: X0 + 40, z: Z0 + 40 }
const rcon = cmd => execFileSync('node', [path.join(ROOT, 'farm', 'farm.js'), 'rcon', String(slot), cmd], { encoding: 'utf8' }).trim()
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main () {
  const port = 25600 + Number(slot)
  const name = 'NDCapture'
  const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: name, version: '1.21.11', auth: 'offline' })
  await new Promise((resolve, reject) => { bot.once('spawn', resolve); bot.once('error', reject); bot.once('kicked', r => reject(new Error(String(r)))) })
  console.log(rcon(`op ${name}`))
  console.log(rcon(`gamemode spectator ${name}`))
  console.log(rcon(`forceload add ${A.x} ${A.z} ${B.x} ${B.z}`))
  console.log(rcon(`tp ${name} ${X0 + 10} ${P + 30} ${Z0 + 10}`))
  await sleep(4000)
  // /fill — не больше 32768 клеток за раз: слоями по высоте.
  for (let y = P - 26; y <= P + 34; y++) {
    const block = y <= P ? BASE : 'air'
    for (let x = A.x; x <= B.x; x += 32) rcon(`fill ${x} ${y} ${A.z} ${Math.min(B.x, x + 31)} ${y} ${B.z} ${block}`)
  }
  console.log(rcon(`place structure minecraft:${kind} ${X0} ${P + 1} ${Z0}`))
  await sleep(4000)
  const R = bot.registry
  const cells = []
  let lo = { x: Infinity, y: Infinity, z: Infinity }
  let hi = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let y = P - 26; y <= P + 34; y++) {
    for (let x = A.x; x <= B.x; x++) {
      for (let z = A.z; z <= B.z; z++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (!b) throw new Error(`чанк ${x},${z} не прогружен у клиента`)
        const n = b.name
        const mine = y <= P ? n !== BASE : n !== 'air'
        if (!mine) continue
        cells.push({ x, y, z, n })
        lo = { x: Math.min(lo.x, x), y: Math.min(lo.y, y), z: Math.min(lo.z, z) }
        hi = { x: Math.max(hi.x, x), y: Math.max(hi.y, y), z: Math.max(hi.z, z) }
      }
    }
  }
  if (!cells.length) throw new Error('постройка не встала')
  const size = [hi.x - lo.x + 1, hi.y - lo.y + 1, hi.z - lo.z + 1]
  const CH = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-/:;<=>?@[]^_`{|}~'
  const pal = []
  const grid = new Array(size[0] * size[1] * size[2]).fill(' ')
  const chests = []
  for (const c of cells) {
    let i = pal.indexOf(c.n)
    if (i < 0) { i = pal.length; pal.push(c.n) }
    const x = c.x - lo.x; const y = c.y - lo.y; const z = c.z - lo.z
    grid[x + size[0] * (z + size[2] * y)] = CH[i]
    if (/^(chest|trapped_chest)$/.test(c.n)) chests.push([x, y, z, TABLE[kind]])
  }
  void R
  const lib = JSON.parse(fs.readFileSync(OUT, 'utf8'))
  // Ноль слепка — угол его рамки; пол храма (локальный y кода 0) — над бетоном.
  lib.templates[`capture/${kind}`] = { kind, size, pal, grid: grid.join(''), chests, air: true, mirror: true, src: 'capture', ground: P + 1 - lo.y, w: { any: 1 } }
  fs.writeFileSync(OUT, JSON.stringify(lib))
  console.log(`${kind}: ${cells.length} клеток, рамка ${size.join('×')} от ${lo.x},${lo.y},${lo.z}, сундуков ${chests.length}:`, JSON.stringify(chests))
  console.log(rcon(`forceload remove ${A.x} ${A.z} ${B.x} ${B.z}`))
  bot.quit()
}

main().then(() => setTimeout(() => process.exit(0), 500)).catch(e => { console.error(e); process.exit(1) })
