// Offline replay of the parkour planner on a saved farm world (region files, read-only).
// No server, no farm slot: the same supportRoute/planJump code runs on block states read
// from <server>/world/region/*.mca, so a map blocker can be studied without a live world.
//   node try-parkour-offline.js <server-dir> <from x,y,z> <to x,y,z> [bounce x,y,z]
//   e.g. node try-parkour-offline.js ../farm/server-29 16.5,122,-42.5 5.5,122,-44.5 10.5,119,-45.5
// ponytail: no entities, no block updates; a static snapshot of the saved world only.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { REPO_ROOT } from '../../src/paths'
import * as nbt from 'prismarine-nbt'
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)

type Section = { Y: number; block_states?: { palette: Array<{ Name: string; Properties?: Record<string, string> }>; data?: Array<[number, number]> } }
function readChunk(dir: string, cx: number, cz: number): { sections?: Section[] } | null {
  const file = path.join(dir, `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}.mca`)
  if (!fs.existsSync(file)) return null
  const buf = fs.readFileSync(file); const i = 4 * ((cx & 31) + (cz & 31) * 32)
  const off = (buf.readUInt32BE(i) >>> 8) * 4096; if (!off) return null
  const len = buf.readUInt32BE(off); const comp = buf[off + 4]; const data = buf.subarray(off + 5, off + 4 + len)
  return nbt.simplify(nbt.parseUncompressed(comp === 2 ? zlib.inflateSync(data) : comp === 1 ? zlib.gunzipSync(data) : data, 'big'))
}

export function regionWorld(serverDir: string) {
  const dir = path.join(serverDir, 'world', 'region'); const chunks = new Map<string, ReturnType<typeof readChunk>>(); const blocks = new Map<string, unknown>()
  const stateAt = (x: number, y: number, z: number) => {
    const key = `${x >> 4},${z >> 4}`
    if (!chunks.has(key)) chunks.set(key, readChunk(dir, x >> 4, z >> 4))
    const chunk = chunks.get(key); if (!chunk) return null
    const section = chunk.sections?.find(s => s.Y === y >> 4)
    if (!section?.block_states) return { Name: 'minecraft:air' }
    const { palette, data } = section.block_states
    if (palette.length === 1 || !data) return palette[0]
    const bits = Math.max(4, Math.ceil(Math.log2(palette.length))); const per = Math.floor(64 / bits)
    const index = ((y & 15) * 16 + (z & 15)) * 16 + (x & 15); const long = data[Math.floor(index / per)]
    const value = (BigInt.asUintN(32, BigInt(long[0])) << 32n) | BigInt.asUintN(32, BigInt(long[1]))
    return palette[Number((value >> BigInt((index % per) * bits)) & ((1n << BigInt(bits)) - 1n))]
  }
  const set = (p: Vec3, block: unknown) => { const q = p.floored(); blocks.set(`${q.x},${q.y},${q.z}`, block) }
  return { set, getBlock(p: Vec3) {
    const q = p.floored(); const key = `${q.x},${q.y},${q.z}`
    if (!blocks.has(key)) {
      const state = stateAt(q.x, q.y, q.z)
      let block = null
      if (state) {
        const name = state.Name.replace('minecraft:', '')
        const props = Object.fromEntries(Object.entries(state.Properties ?? {}).map(([k, v]) => [k, v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v]))
        block = registry.blocksByName[name] ? Block.fromProperties(name, props as Record<string, any>, 0) : Block.fromStateId(registry.blocksByName.stone.defaultState, 0)
        block.position = q
      }
      blocks.set(key, block)
    }
    return blocks.get(key)
  } }
}

export function offlineBot(serverDir: string, at: Vec3) {
  const world = regionWorld(serverDir)
  const native = (require('../../src/tick-plugins') as typeof import('../../src/tick-plugins')).getPhysics()
  // Офлайн-тело: заглушка бота поверх сохранённого мира (тип MovementBot ей не описать).
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384 }, inventory: { slots: [], items: () => [] }, health: 20, food: 20,
    entity: { position: at.clone(), velocity: new Vec3(0, -.0784000015258789, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, yaw: 0, pitch: 0, effects: {}, attributes: {} },
    blockAt: (p: Vec3) => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: native.Physics(registry, world)
  })
  // Hand use of a wooden door (offline): toggle both halves as the server would and report the block updates.
  bot.lookAt = async () => {}
  bot.activateBlock = async (block: { name: string; position: Vec3; getProperties(): Record<string, unknown> }) => {
    if (!/_door$/.test(block.name) || block.name === 'iron_door') return
    const lower = block.getProperties().half === 'upper' ? block.position.offset(0, -1, 0) : block.position
    for (const p of [lower, lower.offset(0, 1, 0)]) {
      const old = world.getBlock(p) as { name: string; getProperties(): Record<string, unknown> }
      const next = Block.fromProperties(old.name, { ...old.getProperties(), open: true } as Record<string, any>, 0); next.position = p
      world.set(p, next); bot.emit('blockUpdate', old, next)
    }
  }
  return bot
}

/** The real `route()` over the saved world: controls drive the same native integrator each tick. */
export async function offlineRoute(serverDir: string, from: Vec3, goals: Vec3[], maxLandings: number, maxFallDamage = 0) {
  const bot = offlineBot(serverDir, from); const native = (require('../../src/tick-plugins') as typeof import('../../src/tick-plugins')).getPhysics()
  const clockModule: typeof import('../../src/game-clock') = require('../../src/game-clock'); const clock = new clockModule.GameClock({ manual: true, epoch: 0 }); clockModule.activate(clock)
  const { route, IDLE }: typeof import('../../src/navigation/parkour') = require('../../src/navigation/parkour')
  const world = { getBlock: (p: Vec3) => bot.blockAt(p) }
  let control = { ...IDLE }; let moving = 0
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control); bot.physics.simulatePlayer(state, world); state.apply(bot)
      clock.advanceTicks(1); moving++; bot.emit('physicsTick')
      if (!bot.listenerCount('physicsTick')) break
    }
  }
  const began = performance.now()
  const result = await route(bot, { aborted: false }, { toward: goals[goals.length - 1], waypoints: goals.slice(0, -1), maxLandings, beam: 24, maxTicks: 38, timeoutSeconds: 3600, maxFallDamage })
  return { result, wallMs: performance.now() - began, movingTicks: moving, at: bot.entity.position.clone() }
}

if (require.main === module && process.argv[3] === 'route') {
  // node try-parkour-offline.js <server-dir> route <from x,y,z> <next checkpoint ordinal> [maxLandings] [checkpoints count]  (MAXFALL=n: fall damage budget)
  const [serverDir, , fromArg, cpArg, landingsArg, countArg] = process.argv.slice(2)
  const cps = (JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, 'codex-lab/parkour-map-1.21.11/semantic-landmarks.json'), 'utf8')).checkpoints as Array<{ x: number; y: number; z: number }>)
    .slice(Number(cpArg) - 1, Number(cpArg) - 1 + Number(countArg ?? 1)).map(p => new Vec3(p.x, p.y, p.z))
  void offlineRoute(path.resolve(serverDir), new Vec3(...(fromArg.split(',').map(Number) as [number, number, number])), cps, Number(landingsArg ?? 100), Number(process.env.MAXFALL ?? 0)).then(({ result, wallMs, movingTicks, at }) => {
    const landings = result.landings as Array<{ target: Vec3; mode: string; bounce?: Vec3; at: Vec3; ticks: number; planningMs: number; routing?: { workMs?: number; cached?: boolean } }>
    const rejected = (result as unknown as { rejected: typeof landings }).rejected
    for (const l of landings) console.log('L', process.env.WP ? JSON.stringify(((l as any).waypoints ?? []).map((w: any) => [w.x, w.y, w.z].map((n: number) => +n.toFixed(1)).join(',') + (w.bounce ? 'B' : '') + (w.climb ? 'C' : '')).join(' ')) : '', `${l.at.x.toFixed(2)},${l.at.y},${l.at.z.toFixed(2)}`, l.mode, l.bounce ? ((l as any).chain ? `bounce×${1 + (l as any).chain.length}` : 'bounce') : '', `ticks ${l.ticks} plan ${l.planningMs?.toFixed(0)}ms route ${l.routing?.cached ? 'cached' : `${l.routing?.workMs?.toFixed(0)}ms`}`)
    for (const l of rejected) console.log('R', JSON.stringify((l as any).from), '->', JSON.stringify(l.target), l.bounce ? 'bounce' : '', (l as any).why, (l as any).forecast?.diagnostics?.why ?? '', `frames ${(l as any).forecast?.diagnostics?.frames} plan ${l.planningMs?.toFixed(0)}ms`)
    const planning = [...landings, ...rejected].reduce((s, l) => s + (l.planningMs ?? 0), 0); const routingMs = [...landings, ...rejected].reduce((s, l) => s + (l.routing?.cached ? 0 : l.routing?.workMs ?? 0), 0)
    console.log(JSON.stringify({ ok: result.ok, why: result.why, landings: landings.length, rejected: rejected.length, reached: (result as unknown as { reachedGoals: unknown[] }).reachedGoals.length, at, wallMs: Math.round(wallMs), planningMs: Math.round(planning), routingMs: Math.round(routingMs), movingTicks }))
  })
} else if (require.main === module) {
  const vec = (s?: string) => s ? new Vec3(...(s.split(',').map(Number) as [number, number, number])) : undefined
  const [serverDir, fromArg, toArg, bounceArg] = process.argv.slice(2)
  // bounce "x,y,z" or a spring chain "x,y,z;x,y,z" (contact order)
  const from = vec(fromArg)!; const to = vec(toArg)!; const [bounce, ...chain] = (bounceArg ?? '').split(';').filter(Boolean).map(a => vec(a)!)
  const bot = offlineBot(path.resolve(serverDir), from)
  const { planJump, reboundApex, reboundCeiling }: typeof import('../../src/navigation/parkour') = require('../../src/navigation/parkour')
  const { supportRoute }: typeof import('../../src/navigation/support-route') = require('../../src/navigation/support-route')
  void (async () => {
    if (bounce) console.log('apex walk/jump', reboundApex(bot, bounce, from.y, false), reboundApex(bot, bounce, from.y, true), 'ceiling', reboundCeiling(bot, from, bounce))
    const diagnostics = { frames: 0, profiles: 0 }; const began = performance.now()
    const plan = planJump(bot, to, { bounce, chain, maxTicks: bounce ? 90 + 60 * chain.length : 38, allowWalk: true, diagnostics })
    console.log('planJump', plan ? `ticks ${plan.ticks}` : 'null', JSON.stringify(diagnostics), `${(performance.now() - began).toFixed(0)} ms`)
    const routing = {}; const t0 = performance.now()
    const route = await supportRoute(bot, from, to, new Set(), 14, routing, (f: Vec3, s: Vec3) => reboundCeiling(bot, f, s) - (bot.physics.stepHeight ?? 0))
    console.log('supportRoute', `${(performance.now() - t0).toFixed(0)} ms`, JSON.stringify(routing))
    for (const o of route) console.log(' ', o.target.toString(), o.support, o.mode ?? '', o.bounce ? `bounce ${JSON.stringify(o.bounce)}` : '')
  })()
}
