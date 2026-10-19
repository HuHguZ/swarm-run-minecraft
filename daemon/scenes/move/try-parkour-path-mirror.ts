// Offline mirror check of mineflayer-pathfinder A* on a saved farm world (region files, read-only).
// The same Movements/AStar as the daemon, with or without the skylight "under roof" step cost
// (session.ts underRoofCost: skyLight <= 7 -> 1.5 per step) that goto adds on surface walks.
//   node try-parkour-path-mirror.js <server-dir> <cx,cy,cz> <start dx,dz> <goal dx,dz> [range]
//   e.g. node try-parkour-path-mirror.js ../farm/server-27 2000,100,2000 -9.5,0.5 -21.5,0
// The east run mirrors x about the layout's mirror plane (cell x -> -x): X = 2*cx + 1 - x.
// ponytail: static snapshot (no entities, no block updates), one A* per call without tick splitting.
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as nbt from 'prismarine-nbt'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
import { Movements, goals } from 'mineflayer-pathfinder'
import AStar = require('mineflayer-pathfinder/lib/astar')
import Move = require('mineflayer-pathfinder/lib/move')

type Section = { Y: number; SkyLight?: number[]; block_states?: { palette: Array<{ Name: string; Properties?: Record<string, string> }>; data?: Array<[number, number]> } }
export function savedWorld(serverDir: string) {
  const dir = path.join(serverDir, 'world', 'region'); const chunks = new Map<string, { sections?: Section[] } | null>(); const blocks = new Map<string, unknown>()
  const chunk = (cx: number, cz: number) => {
    const key = `${cx},${cz}`
    if (!chunks.has(key)) {
      const file = path.join(dir, `r.${cx >> 5}.${cz >> 5}.mca`); let value = null
      if (fs.existsSync(file)) {
        const buf = fs.readFileSync(file); const i = 4 * ((cx & 31) + (cz & 31) * 32); const off = (buf.readUInt32BE(i) >>> 8) * 4096
        if (off) { const len = buf.readUInt32BE(off); const data = buf.subarray(off + 5, off + 4 + len); value = nbt.simplify(nbt.parseUncompressed(buf[off + 4] === 2 ? zlib.inflateSync(data) : data, 'big')) }
      }
      chunks.set(key, value)
    }
    return chunks.get(key)
  }
  const sectionAt = (x: number, y: number, z: number) => chunk(x >> 4, z >> 4)?.sections?.find(s => s.Y === y >> 4)
  const index = (x: number, y: number, z: number) => ((y & 15) * 16 + (z & 15)) * 16 + (x & 15)
  const sky = (x: number, y: number, z: number) => {
    const light = sectionAt(x, y, z)?.SkyLight; if (!light) return 15
    const i = index(x, y, z); const byte = light[i >> 1] & 0xff
    return i & 1 ? byte >> 4 : byte & 15
  }
  const state = (x: number, y: number, z: number) => {
    const states = sectionAt(x, y, z)?.block_states
    if (!states) return { Name: 'minecraft:air' }
    const { palette, data } = states
    if (palette.length === 1 || !data) return palette[0]
    const bits = Math.max(4, Math.ceil(Math.log2(palette.length))); const per = Math.floor(64 / bits); const i = index(x, y, z); const long = data[Math.floor(i / per)]
    const value = (BigInt.asUintN(32, BigInt(long[0])) << 32n) | BigInt.asUintN(32, BigInt(long[1]))
    return palette[Number((value >> BigInt((i % per) * bits)) & ((1n << BigInt(bits)) - 1n))]
  }
  return { blockAt(p: Vec3) {
    const q = p.floored(); const key = `${q.x},${q.y},${q.z}`
    if (!blocks.has(key)) {
      const s = state(q.x, q.y, q.z); const name = s.Name.replace('minecraft:', '')
      const props = Object.fromEntries(Object.entries(s.Properties ?? {}).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v]))
      const block = registry.blocksByName[name] ? Block.fromProperties(name, props as Record<string, any>, 0) : Block.fromStateId(registry.blocksByName.stone.defaultState, 0)
      block.position = q; block.skyLight = sky(q.x, q.y, q.z)
      blocks.set(key, block)
    }
    return blocks.get(key)
  } }
}

export function search(world: ReturnType<typeof savedWorld>, start: Vec3, goal: Vec3, { range = 2, roof = true } = {}) {
  // Заглушка бота для Movements: только реестр, мир и тело.
  const bot: any = Object.assign(new EventEmitter(), { registry, version: '1.21.11', game: { minY: -64, height: 384 }, entities: {}, inventory: { items: () => [] },
    entity: { position: start, effects: {}, onGround: true }, blockAt: (p: Vec3) => world.blockAt(p) })
  const movements = new Movements(bot)
  movements.canDig = false; movements.allow1by1towers = false
  if (roof) movements.exclusionAreasStep.push((block: { skyLight?: number }) => typeof block?.skyLight === 'number' && block.skyLight <= 7 ? 1.5 : 0)
  const goalNear = new goals.GoalNear(Math.floor(goal.x), Math.floor(goal.y), Math.floor(goal.z), range)
  const p = start.floored()
  const astar = new AStar(new Move(p.x, p.y, p.z, 0, 0), movements, goalNear, 60000, 60000)
  const result = astar.compute()
  return { status: result.status, cost: +result.cost.toFixed(2), ms: Math.round(result.time), visited: result.visitedNodes, generated: result.generatedNodes, length: result.path.length,
    roofSteps: result.path.filter((m: { x: number; y: number; z: number }) => (world.blockAt(new Vec3(m.x, m.y, m.z)) as { skyLight: number }).skyLight <= 7).length }
}

if (require.main === module) {
  const [serverDir, centerArg, startArg, goalArg, rangeArg] = process.argv.slice(2)
  const [cx, cy, cz] = centerArg.split(',').map(Number); const [sx, sz] = startArg.split(',').map(Number); const [gx, gz] = goalArg.split(',').map(Number)
  const world = savedWorld(path.resolve(serverDir))
  const mirror = (x: number) => 2 * cx + 1 - x
  for (const roof of [true, false]) {
    const west = search(world, new Vec3(cx + sx, cy, cz + sz), new Vec3(cx + gx, cy, cz + gz), { range: Number(rangeArg ?? 2), roof })
    const east = search(world, new Vec3(mirror(cx + sx), cy, cz + sz), new Vec3(mirror(cx + gx), cy, cz + gz), { range: Number(rangeArg ?? 2), roof })
    console.log(JSON.stringify({ roofCost: roof, west, east }))
  }
}
