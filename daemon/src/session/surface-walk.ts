// Опыт C, выключен: цена только относительно опор, действительно увиденных телом.
import { Vec3 as SurfaceVec3 } from 'vec3'
import { surface as sightSurface, seesNow } from '../perception/eyes'

type Sample = { x: number; y: number; z: number }
type Surface = { samples: Sample[]; ticks: number; waterSeen: Map<string, boolean> }
// Песочницы тестов (vm) без process — флаги выключены.
const env = (name: string) => typeof process !== 'undefined' ? process.env[name] : undefined
export const surfaceWalkOn = bot => env('ND_OW_SURFACE_WALK') === '1' &&
  String(bot.game?.dimension || '').replace(/^minecraft:/, '') === 'overworld'

export function startSurfaceWalk(bot) {
  if (!surfaceWalkOn(bot)) return null
  const context: Surface = { samples: [], ticks: 0, waterSeen: new Map() }
  const scope = { previous: bot._ndOwSurfaceWalk, context, observe: () => {
    if (bot._ndOwSurfaceWalk === context && ++context.ticks % 10 === 0) observeSurface(bot)
  } }
  bot._ndOwSurfaceWalk = context
  observeSurface(bot)
  bot.on?.('physicsTick', scope.observe)
  return scope
}

export function stopSurfaceWalk(bot, scope) {
  if (!scope) return
  bot.removeListener?.('physicsTick', scope.observe)
  if (bot._ndOwSurfaceWalk === scope.context) bot._ndOwSurfaceWalk = scope.previous
}

export function observeSurface(bot) {
  const ctx: Surface = bot._ndOwSurfaceWalk, me = bot.entity?.position
  if (!ctx || !me || !surfaceWalkOn(bot)) return
  ctx.waterSeen.clear()
  const add = (x, y, z) => {
    if (!ctx.samples.some(p => p.x === x && p.y === y && p.z === z)) ctx.samples.push({ x, y, z })
  }
  // Пол, на котором стоим, известен телу без луча и без скана колонны.
  if (bot.entity.onGround) {
    const p = me.floored(), floor = bot.blockAt(p.offset(0, -1, 0), false)
    if (floor?.boundingBox === 'block') add(p.x, p.y, p.z)
  }
  if (bot.registry && bot.world) {
    // 32 коротких луча, раз в 10 тиков; первая видимая грань, без heightmap/seed.
    for (let yaw = 0; yaw < 360; yaw += 22.5) for (const pitch of [20, 55]) {
      const hit = sightSurface(bot, { yaw, pitch, maxDist: 24 })
      if (!hit || /leaves|_log|_wood|mushroom|cactus/.test(hit.name)) continue
      const p = new SurfaceVec3(hit.pos.x, hit.pos.y, hit.pos.z)
      const above = bot.blockAt(p.offset(0, 1, 0), false)
      // Не записываем бок стены или крону как верх местной поверхности.
      if (above?.boundingBox === 'empty' && seesNow(bot, p.offset(0, 1, 0))) add(p.x, p.y + 1, p.z)
    }
  }
  // Локальная память: гора позади не становится полом всей будущей долины.
  ctx.samples = ctx.samples.filter(p => Math.hypot(p.x + .5 - me.x, p.z + .5 - me.z) <= 32).slice(-256)
}

function depthBelow(ctx: Surface, p) {
  let depth = 0
  for (const rim of ctx.samples) {
    const d = Math.hypot(rim.x - p.x, rim.z - p.z)
    if (d <= 12) depth = Math.max(depth, rim.y - p.y - d - 2)
  }
  return depth
}

export function surfaceStepCost(bot, block) {
  const ctx: Surface = bot._ndOwSurfaceWalk, p = block?.position
  if (!surfaceWalkOn(bot) || !ctx || !p) return 0
  const depth = depthBelow(ctx, p)
  // 1:1 склон с запасом 2 блока бесплатен. Цена конечна даже в глубоком овраге.
  let cost = Math.min(120, depth * 3)
  if (block.name === 'water') {
    const key = `${p.x},${p.y},${p.z}`
    let seen = ctx.waterSeen.get(key)
    if (seen === undefined) { seen = !!bot.registry && seesNow(bot, p); ctx.waterSeen.set(key, seen) }
    // level >= 8 — falling в данных vanilla 1.21.11. Горизонтальное течение
    // дорого только ниже наблюдённого берега; ровная река остаётся проходимой.
    if (seen) {
      const level = Number(block.getProperties?.().level ?? 0)
      if (level >= 8 || level > 0 && depth > 0) cost += 40
    }
  }
  return cost
}

export function priceSurfaceMoves(bot, movements) {
  const neighbors = movements.getNeighbors.bind(movements)
  movements.getNeighbors = node => {
    const moves = neighbors(node)
    if (surfaceWalkOn(bot) && bot._ndOwSurfaceWalk) for (const move of moves) {
      const cell = bot.blockAt(new SurfaceVec3(move.x, move.y, move.z), false)
      // После native-проверок: exclusionStep суммой >100 запрещает ход.
      // Здесь цена конечна, и проверяется именно посадка, включая drop в воду.
      move.cost += surfaceStepCost(bot, cell)
    }
    return moves
  }
}

export function recoveryTarget(bot): Sample | null {
  const ctx: Surface = bot._ndOwSurfaceWalk, me = bot.entity?.position
  if (!surfaceWalkOn(bot) || !ctx || !me) return null
  const nearby = ctx.samples.filter(p => {
    const d = Math.hypot(p.x + .5 - me.x, p.z + .5 - me.z)
    return d <= 12 && p.y - me.y - d - 2 >= 4
  })
  // Ближайший действительно увиденный выход, а не самая высокая гора.
  nearby.sort((a, b) => Math.hypot(a.x + .5 - me.x, a.z + .5 - me.z) - Math.hypot(b.x + .5 - me.x, b.z + .5 - me.z))
  return nearby[0] || null
}

export function surfaceDropGuard(bot) {
  let rejectDrop
  const promise = new Promise<never>((_resolve, reject) => { rejectDrop = reject })
  const check = () => {
    if (!bot._ndOwSurfaceRecovering && env('ND_OW_SURFACE_RECOVER') === '1' && recoveryTarget(bot))
      rejectDrop(Object.assign(new Error('тело ниже видимого берега — выход наверх'), { surfaceDrop: true }))
  }
  const active = surfaceWalkOn(bot) && bot._ndOwSurfaceWalk && env('ND_OW_SURFACE_RECOVER') === '1'
  if (active) bot.on?.('physicsTick', check)
  check()
  return { promise, stop: () => bot.removeListener?.('physicsTick', check) }
}

export async function recoverSurface(session, ctl, deadline) {
  const bot = session.bot, target = recoveryTarget(bot)
  if (env('ND_OW_SURFACE_RECOVER') !== '1' || !target || ctl.aborted) return false
  const clock: typeof import('../game-clock') = require('../game-clock')
  const left = Math.min(30, Math.max(0, deadline - clock.now()) / 1000)
  // surface имеет минимальный бюджет 10 с; не продлеваем срок исходного хода.
  if (left < 10) return false
  const fromY = bot.entity.position.y
  const previous = bot._ndOwSurfaceRecovering
  bot._ndOwSurfaceRecovering = true
  try {
    await (require('../survival') as typeof import('../survival')).surface(session, ctl,
      { targetY: target.y, timeoutSeconds: left, preferPillar: true, hand: false, recover: true })
  } finally { bot._ndOwSurfaceRecovering = previous }
  return bot.entity.position.y >= fromY + 1
}
