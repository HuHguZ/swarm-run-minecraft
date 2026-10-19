import * as fs from 'node:fs'
import * as path from 'node:path'
import { terrainPlan } from './arena-terrain'
import { REPO_ROOT } from '../src/paths'

import * as colosseum from './colosseum'
import { normBox, splitBox } from '../scenes/lib/scene-kit'

export const INTELLECT_ARENA = { x: 3000, y: 200, z: 2900, r: 24 }

export function arenaPlan(ground: { min: number; max: number } = { min: 80, max: 90 }) {
  const arena = { ...INTELLECT_ARENA, y: ground.max + 4 }
  const { x: X, y: Y, z: Z, r: R } = arena
  const model = colosseum.model({ R, bays: 40, ceilH: 64, masts: 0 })
  const area = colosseum.footprint(model, { X, Y, Z })
  const box = [[area.x0 - 13, Math.min(ground.min, Y - 11), area.z0 - 13], [area.x1 + 13, Y + 65, area.z1 + 13]]
  const clear = splitBox(normBox(box)).map(b => `/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:air`)
  const fills = (box, block: string): string[] => splitBox(normBox(box)).map(b => `/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} minecraft:${block}`)
  const foundation: string[] = []
  const lava: string[] = []
  const a = model.p.outA; const b = model.p.outB
  const relief = terrainPlan(X, Y, Z, R)
  for (let dz = -b - 12; dz <= b + 12; dz++) {
    const outer = Math.floor((a + 12) * Math.sqrt(Math.max(0, 1 - (dz / (b + 12)) ** 2)))
    const inner = Math.abs(dz) >= b ? -1 : Math.ceil(a * Math.sqrt(1 - (dz / b) ** 2)) - 1
    if (inner >= 0) foundation.push(...fills([[X - inner, Math.min(ground.min, Y - 11), Z + dz], [X + inner, Y - 3, Z + dz]], 'polished_andesite'))
    const strips = inner < 0 ? [[X - outer, X + outer]] : [[X - outer, X - inner - 1], [X + inner + 1, X + outer]]
    for (const [x0, x1] of strips) if (x0 <= x1) {
      lava.push(...fills([[x0, Y - 11, Z + dz], [x1, Y - 11, Z + dz]], 'obsidian'),
        ...fills([[x0, Y - 10, Z + dz], [x1, Y - 6, Z + dz]], 'lava'))
    }
  }
  const commands: string[] = [...clear, ...foundation, ...colosseum.commands(model, { X, Y, Z }),
    `/fill ${X - R} ${Y - 1} ${Z - R} ${X + R} ${Y - 1} ${Z + R} minecraft:obsidian`,
    ...colosseum.fieldLightCommands({ X, Y, Z, R }), ...relief.commands, ...lava]
  const samples = [
    { x: X, y: Y - 1, z: Z, block: 'obsidian' },
    { x: X, y: Y + 64, z: Z, block: 'air' },
    ...relief.samples,
    { x: area.x1 + 5, y: Y - 8, z: Z, block: 'lava' },
    { x: area.x1 + 5, y: Y - 11, z: Z, block: 'obsidian' }
  ]
  return { arena, ground, box, area, terrain: relief.terrain, commands, samples,
    watch: colosseum.watchSpot(model, { X, Y, Z }),
    exterior: { x: area.x1 + 18, y: Y + 18, z: Z + 8 } }
}

export async function terrainHeight(bot, kit, player: string) {
  const bounds = arenaPlan().area
  const heights: number[] = []
  const midX = INTELLECT_ARENA.x
  const midZ = INTELLECT_ARENA.z
  for (const [x0, x1] of [[bounds.x0, midX], [midX + 1, bounds.x1]]) for (const [z0, z1] of [[bounds.z0, midZ], [midZ + 1, bounds.z1]]) {
    const result = await kit.cmd(`/tp ${player} ${Math.floor((x0 + x1) / 2)} 180 ${Math.floor((z0 + z1) / 2)} 0 0`)
    if (!result.ok) throw new Error('terrain spectator teleport unconfirmed')
    await bot.waitForChunksToLoad()
    await (require('../src/game-clock') as typeof import('../src/game-clock')).wall.sleep(250)
    for (let x = x0; x <= x1; x += 8) for (let z = z0; z <= z1; z += 8) {
    let found = false
    for (let y = 319; y >= -64; y--) {
      const block = bot.blockAt(new ((require('vec3') as typeof import('vec3').Vec3))(x, y, z))
      if (!block) throw new Error(`terrain chunk not loaded: ${x},${z}`)
      if (block.boundingBox === 'block' && !/leaves|log|ice/.test(block.name)) { heights.push(y); found = true; break }
    }
    if (!found) throw new Error(`terrain surface missing: ${x},${z}`)
    }
  }
  return { min: Math.min(...heights), max: Math.max(...heights) }
}

function farmWorld(logFile: string) {
  const slot = path.resolve(REPO_ROOT, 'farm/server-31')
  const wanted = path.join(slot, 'logs', 'latest.log')
  if (path.resolve(logFile).toLowerCase() !== wanted.toLowerCase()) throw new Error('arena builder only accepts farm/server-31/logs/latest.log')
  const properties = fs.readFileSync(path.join(slot, 'server.properties'), 'utf8')
  const level = /^level-name=(.+)$/m.exec(properties)?.[1].trim() ?? 'world'
  const world = path.resolve(slot, level)
  if (!world.startsWith(slot + path.sep)) throw new Error('farm level-name escapes slot directory')
  return world
}

export async function buildArena(kit, logFile: string, ground: { min: number; max: number }) {
  const plan = arenaPlan(ground)
  const world = farmWorld(logFile)
  const planFile = path.join(path.dirname(path.dirname(logFile)), 'intellect-arena.json')
  fs.writeFileSync(planFile, JSON.stringify({ ...plan, ready: false, commands: undefined }, null, 2) + '\n')
  console.log('ARENA_PLAN', JSON.stringify({ arena: plan.arena, ground, commands: plan.commands.length }))
  const pack = path.join(world, 'datapacks', 'neurodown_intellect')
  const functions = path.join(pack, 'data', 'neurodown_intellect', 'function')
  fs.mkdirSync(functions, { recursive: true })
  // Paper 1.21.11 version.json: data_major=94, data_minor=1.
  fs.writeFileSync(path.join(pack, 'pack.mcmeta'), JSON.stringify({ pack: { description: 'NeuroDown farm 31 PvP fixture', min_format: [94, 1], max_format: [94, 1] } }, null, 2) + '\n')
  const chunks: string[][] = []
  for (let i = 0; i < plan.commands.length; i += 400) chunks.push(plan.commands.slice(i, i + 400))
  chunks.forEach((commands, i) => fs.writeFileSync(path.join(functions, `batch_${i}.mcfunction`),
    commands.map(c => c.replace(/^\//, '')).join('\n') + `\nscoreboard players set #batch nd_intellect ${i + 1}\n`))
  await kit.forceload('overworld', plan.box)
  const must = async (command: string, reply?: RegExp) => {
    const result = await kit.cmd(command, { reply: reply ?? null, ms: 15000 })
    if (!result.ok) throw new Error(`arena command unconfirmed: ${command}; ${result.why}`)
    return result
  }
  await must('/reload')
  await (require('../src/game-clock') as typeof import('../src/game-clock')).wall.sleep(1000)
  await must('/scoreboard objectives add nd_intellect dummy')
  const witness = `#w${process.pid.toString(36)}${Date.now().toString(36).slice(-5)}`
  let serial = 0
  const confirm = async (condition: string) => {
    const value = ++serial
    await must(`/execute ${condition} run scoreboard players set ${witness} nd_intellect ${value}`,
      new RegExp(`^Set \\[nd_intellect\\] for ${witness} to ${value}$`))
  }
  for (let i = 0; i < chunks.length; i++) {
    await must(`/function neurodown_intellect:batch_${i}`)
    await confirm(`if score #batch nd_intellect matches ${i + 1}`)
    if ((i + 1) % 5 === 0 || i + 1 === chunks.length) console.log('ARENA_BUILD', JSON.stringify({ batch: i + 1, total: chunks.length }))
  }
  for (let i = 0; i < plan.samples.length; i++) {
    const p = plan.samples[i]
    await confirm(`if block ${p.x} ${p.y} ${p.z} minecraft:${p.block}`)
  }
  console.log('ARENA_READY', JSON.stringify({ ...plan, commands: plan.commands.length }))
  fs.writeFileSync(planFile, JSON.stringify({ ...plan, ready: true, commands: undefined }, null, 2) + '\n')
  return plan
}
