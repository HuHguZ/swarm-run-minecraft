'use strict'
const gameClock: typeof import('./game-clock') = require('./game-clock')
const { goals }: typeof import('mineflayer-pathfinder') = require('mineflayer-pathfinder')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const geometry: typeof import('./navigation/geometry') = require('./navigation/geometry')

const sleep = (ms) => gameClock.sleep(ms)
const waterBudgetOn = () => process.env.ND_WATER_ESCAPE_BUDGET !== '0'
// Floor, not round. An entity standing at x=121.5 is in block 121, but rounding
// reports 122 — and the brain then hands 122 to /setblock or to its own
// coordinate arithmetic and acts on the block next door. This is what the game
// itself shows on the F3 "Block" line, and block positions are integers already,
// so nothing else changes.
const xyz = v => (v ? { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) } : null)

// A route shaft is usable only after an actual descent in one block column.
function shaftFromDescent (from, to) {
  if (![from, to].every(p => p && ['x', 'y', 'z'].every(k => Number.isFinite(p[k])))) return null
  const a = xyz(from); const b = xyz(to)
  if (a.x !== b.x || a.z !== b.z || a.y <= b.y) return null
  return { x: a.x, z: a.z, top: a.y, bottom: b.y }
}

// Coordinates handed to us usually come from observe(), which reports the
// position of a block, not of a place you can stand. Asking pathfinder to
// reach the inside of a stone block means no valid node exists, and with
// canDig enabled A* will happily explore twenty thousand nodes before giving
// up. So snap to the nearest standable column first.
function standableY (bot, x, y, z) {
  return geometry.standPositions(bot, new Vec3(x, y, z), { rise: 8, drop: 8 })[0]?.y ?? null
}

// What the bot is physically sitting in when it refuses to move. A valid path
// the bot cannot walk almost always means the body is caught on something.
function describeStall (bot) {
  const name = b => (b ? b.name : 'void')
  const p = bot.entity.position
  return {
    pos: xyz(p),
    ground: name(bot.blockAt(p.offset(0, -1, 0))),
    legs: name(bot.blockAt(p)),
    head: name(bot.blockAt(p.offset(0, 1, 0))),
    ahead: (() => { try { const b = bot.blockAtCursor(4); return b ? b.name : 'air' } catch { return '?' } })(),
    inWater: !!bot.entity.isInWater,
    onGround: !!bot.entity.onGround
  }
}

// Pathfinder reports "partial" forever when the goal is unreachable; the bot
// just stands there. Fail loudly instead of burning the whole timeout.
function stuckGuard (bot, ctl, stagnantLimitMs = 8000) {
  let last = bot.entity.position.clone()
  let stagnant = 0
  let timer = null
  const promise = new Promise<any>((_resolve, reject) => {
    timer = gameClock.setInterval(() => {
      const now = bot.entity.position
      if (now.distanceTo(last) > 0.6) {
        last = now.clone()
        stagnant = 0
      } else {
        stagnant += 1500
      }
      if (stagnant >= stagnantLimitMs) {
        gameClock.clearInterval(timer)
        const diag = describeStall(bot)
        console.log('[stuck]', JSON.stringify(diag))
        try { bot.pathfinder.setGoal(null) } catch {}
        reject(new Error(`застрял на ${diag.legs} у ${diag.ahead}: за ${stagnantLimitMs / 1000}с не сдвинулся`))
      }
    }, 1500)
  })
  ctl.onAbort.push(() => gameClock.clearInterval(timer))
  return { promise, stop: () => gameClock.clearInterval(timer) }
}

// mineflayer-pathfinder is a 2023-era library driving a 2026 game; it
// regularly plans a route the body then fails to walk. Rather than chase every
// individual mismatch, shake the bot loose and let it re-plan from a slightly
// different spot — which is what a person does when they snag on a corner.
function groundBehind (bot) {
  try {
    const yaw = bot.entity.yaw
    // mineflayer: взгляд вперёд — (-sin yaw, -cos yaw); назад — наоборот.
    const bx = Math.sin(yaw)
    const bz = Math.cos(yaw)
    const p = bot.entity.position
    for (const d of [1, 2]) {
      const c = p.offset(bx * d, 0, bz * d).floored()
      let ok = false
      for (let dy = 0; dy <= 3; dy++) {
        const b = bot.blockAt(c.offset(0, -dy - 1, 0))
        if (!b) break
        if (/lava/.test(b.name)) return false
        if (b.boundingBox === 'block') { ok = true; break }
      }
      if (!ok) return false
    }
    return true
  } catch { return false }
}

async function unstick (bot) {
  try { bot.pathfinder.setGoal(null) } catch {}
  try {
    bot.clearControlStates()
    await sleep(150)
    bot.setControlState('jump', true)
    // Назад — только если за спиной есть пол в трёх блоках вниз: рывок назад
    // с прыжком у края обрыва — это падение, а не освобождение.
    if (groundBehind(bot)) bot.setControlState('back', true)
    await sleep(600)
    bot.setControlState('back', false)
    bot.setControlState('jump', false)
    await bot.look(bot.entity.yaw + Math.PI / 2, 0, true)
    await sleep(250)
  } catch {
  } finally {
    try { bot.clearControlStates() } catch {}
  }
}

// Jumping against a shaft wall can repeatedly be rejected by the server.
// Walk to the middle of the same supported cell before jumping; no position
// packets or local onGround overrides, just ordinary movement controls.
async function centerOnFloor (bot, ctl, timeoutMs = 1000, { water = false } = {}) {
  const support = geometry.supportAt(bot, bot.entity.position, .04)
  if (!support) return false
  const target = new Vec3((support.box.minX + support.box.maxX) / 2, support.top, (support.box.minZ + support.box.maxZ) / 2)
  if (!geometry.bodyClear(bot, target, { water })) return false
  const away = () => Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z)
  if (away() <= 0.08) return true
  const end = gameClock.now() + timeoutMs
  try {
    bot.clearControlStates()
    while (!(ctl && ctl.aborted) && gameClock.now() < end && away() > 0.08) {
      await bot.lookAt(target.offset(0, 1.62, 0), true)
      if (ctl?.aborted) break
      bot.setControlState('forward', true)
      await sleep(50)
    }
  } finally { bot.setControlState('forward', false) }
  await sleep(100)
  return away() <= 0.12
}

// bot.entity.isInWater comes from the physics simulation and does not reliably
// flip on 1.21.11 — the bot was drowning with the flag reading false. Trust the
// blocks the body actually occupies instead.
function inWater (bot) {
  if (!bot || !bot.entity) return false
  if (bot.entity.isInWater) return true
  const p = bot.entity.position
  for (const dy of [0, 0.9, -0.2]) {
    const b = bot.blockAt(p.offset(0, dy, 0))
    if (waterCell(b)) return true
  }
  return process.env.ND_WATER_RESCUE === '1' && waterCell(bot.blockAt((require('./pick') as typeof import('./pick')).eyeOf(bot)))
}

// Nearest spot with solid ground and breathable air above it.
function findNearestLand (bot, maxRadius = 24) {
  const me = bot.entity.position.floored()
  for (let r = 1; r <= maxRadius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (let dy = -2; dy <= 12; dy++) {
          const p = me.offset(dx, dy, dz)
          const feet = bot.blockAt(p)
          const head = bot.blockAt(p.offset(0, 1, 0))
          const ground = bot.blockAt(p.offset(0, -1, 0))
          if (!feet || !head || !ground) continue
          if (waterCell(ground) || ground.boundingBox !== 'block') continue
          if (waterCell(feet) || feet.boundingBox !== 'empty') continue
          if (waterCell(head) || head.boundingBox !== 'empty') continue
          return p
        }
      }
    }
  }
  return null
}

// These plants contain source water even though their collision box is empty.
const waterCell = b => !!b && (/^(water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/.test(b.name) ||
  (process.env.ND_WATER_ESCAPE_BUDGET !== '0' || process.env.ND_WATER_RESCUE === '1') && (b.isWaterlogged || b.getProperties?.().waterlogged === true))
const swimPassable = b => !!b && b.boundingBox === 'empty' && !/lava/.test(b.name)
const breathCell = b => swimPassable(b) && (!waterCell(b) || process.env.ND_WATER_RESCUE === '1' && b.name === 'bubble_column')
const headWet = bot => {
  const b = bot.blockAt((require('./pick') as typeof import('./pick')).eyeOf(bot))
  return waterCell(b) && !(process.env.ND_WATER_RESCUE === '1' && b.name === 'bubble_column')
}
const dryFooting = bot => !!bot.entity.onGround && !inWater(bot) && bot.blockAt(bot.entity.position.offset(0, -0.2, 0))?.boundingBox === 'block'
const idleBreath = bot => {
  const p = bot.entity.position.offset(0, 1.62, 0)
  if (!(require('./perception/eyes') as typeof import('./perception/eyes')).seesNow(bot, p)) return false
  const b = bot.blockAt(p)
  return breathCell(b)
}

// LivingEntity.baseTick: air -20 costs 2 HP, resets to 0; oxygenLevel is rounded air/15.
function airTicks (bot) {
  const key = bot.registry?.entitiesByName?.player?.metadataKeys?.indexOf('air_supply') ?? -1
  const air = key >= 0 ? bot.entity.metadata?.[key] : undefined
  return Number.isFinite(air) ? air : Math.max(0, (bot.oxygenLevel ?? 20) * 15 - 7)
}

// LivingEntity.jumpInLiquid / travelInWater: +.04, vertical drag .8, gravity .005.
function swimUpTicks (height, velocity = 0) {
  let y = 0, ticks = 0
  while (y < height && ticks < 320) { velocity += .04; y += velocity; velocity = velocity * .8 - .005; ticks++ }
  return ticks
}

// Extra path cost in dry walking steps: a submerged step includes a visible return to air.
// Unknown/hidden depth is not inspected, and water remains a finite-cost option.
function waterStepCost (bot, block) {
  if (process.env.ND_WATER_ESCAPE_BUDGET === '0' || !block?.position || !waterCell(block)) return 0
  let depth = 0
  for (let y = 1; y <= 16; y++) {
    const p = block.position.offset(0, y, 0)
    if (!(require('./perception/eyes') as typeof import('./perception/eyes')).seesNow(bot, p) || !waterCell(bot.blockAt(p))) break
    depth++
  }
  const sprint = (bot.food ?? 20) > 6
  const eta = (1 - (sprint ? .9 : .8)) / (.02 * .98) + swimUpTicks(depth)
  const walkTicks = (1 - .546) / (.1 * .98 * (sprint ? 1.3 : 1))
  const hp = 2 * Math.ceil(Math.max(0, eta - airTicks(bot) - 20) / 20)
  // One path unit per predicted HP is a policy price, not a damage multiplier.
  return Math.min(90, Math.max(0, eta / walkTicks - 1) + hp)
}

// A dry ore can still have a wet approach (fp3-s14-1). Price only cells currently seen.
function waterApproachCost (bot, target) {
  if (process.env.ND_WATER_ESCAPE_BUDGET === '0' || !bot.world || !bot.registry || !bot.game) return 0
  const from = bot.entity.position, d = Math.ceil(from.distanceTo(target)), seen = new Set()
  let cost = 0
  for (let i = 1; i <= d; i++) {
    const p = from.scaled(1 - i / d).plus(target.scaled(i / d)).floored(), key = p.toString()
    if (seen.has(key) || !(require('./perception/eyes') as typeof import('./perception/eyes')).seesNow(bot, p)) continue
    seen.add(key)
    cost += waterStepCost(bot, bot.blockAt(p))
  }
  return cost
}

// Only the column currently visible from our eyes; no knowledge of air behind a roof.
function airAbove (bot) {
  const eye = (require('./pick') as typeof import('./pick')).eyeOf(bot)
  for (let y = Math.floor(eye.y); y <= Math.floor(eye.y) + 16; y++) {
    const p = new Vec3(eye.x, y, eye.z)
    if (!(require('./perception/eyes') as typeof import('./perception/eyes')).seesNow(bot, p)) return null
    const b = bot.blockAt(p)
    if (!swimPassable(b)) return null
    if (breathCell(b)) return p
  }
  return null
}

// Search connected body-sized cells, rather than declaring a whole pool closed
// because one column has a roof. Unknown cells and lava cannot be crossed.
// The first breath wins when air is scarce; otherwise try to reach dry ground.
function findSwimRoute (bot, { radius = 8, rise = 12, visibleOnly = false, breathOnly = false, toward = null, observed = null }: any = {}) {
  // The PvP escape observes water/air as well as solid faces. Do not plan through
  // an opaque block containing our head; that remains the embedded-body rescue.
  if (visibleOnly && !geometry.bodyClear(bot, bot.entity.position, { water: true, web: true })) return null
  const known = new Map()
  const read = p => {
    if (!visibleOnly) return bot.blockAt(p)
    const key = p.toString()
    if (!known.has(key)) {
      let block = null
      try { if ((require('./perception/eyes') as typeof import('./perception/eyes')).seesNow(bot, p)) { block = bot.blockAt(p); if (block) observed?.set(key, block) } else block = observed?.get(key) || null } catch {}
      known.set(key, block)
    }
    return known.get(key)
  }
  const start = bot.entity.position.floored()
  const underRoof = visibleOnly && (geometry.verticalLift(bot, bot.entity.position, 1) ?? 1) < 1
  const key = p => `${p.x},${p.y},${p.z}`
  const queue = [{ p: start, parent: -1 }]
  const seen = new Set([key(start)])
  let air = null, water = null
  const urgent = (breathOnly || (bot.oxygenLevel ?? 20) <= 8) && headWet(bot)
  const eyeCell = process.env.ND_WATER_ESCAPE_BUDGET !== '0' ? Math.floor((require('./pick') as typeof import('./pick')).eyeHeight(bot)) : 1
  const route = (i, kind) => {
    const path = []
    const target = queue[i].p
    while (queue[i].parent >= 0) { path.unshift(queue[i].p); i = queue[i].parent }
    return { kind, target, path }
  }
  const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
  // Same bounded observation work as shoreRoute; a partial search can still return a visible breath.
  for (let i = 0; i < queue.length && (process.env.ND_WATER_ESCAPE_BUDGET === '0' || i < 6000); i++) {
    const p = queue[i].p
    const feet = read(p)
    const head = read(p.offset(0, eyeCell, 0))
    const floor = read(p.offset(0, -1, 0))
    const land = swimPassable(feet) && swimPassable(head) && !waterCell(feet) && !waterCell(head) && floor?.boundingBox === 'block'
    if (land) return route(i, 'land')
    if (breathCell(head)) {
      if (!air) air = route(i, 'air')
      if (urgent) return air
    }
    if (toward && p.equals(toward)) return route(i, 'water')
    // Under an overhang, visible water can lead upward before its air becomes visible (j1k1-s2-4).
    if (underRoof && waterCell(feet) && waterCell(head) && p.y > start.y &&
        (p.x !== start.x || p.z !== start.z) && (!water || p.y > water.target.y)) water = route(i, 'water')
    const over = read(p.offset(0, 2, 0))
    const next = [...sides.map(d => p.plus(d)), p.offset(0, 1, 0), p.offset(0, -1, 0)]
    // A swim jump can leave water onto the ledge one block above it.
    if (swimPassable(over)) next.push(...sides.map(d => p.plus(d).offset(0, 1, 0)))
    for (const q of next) {
      if (Math.max(Math.abs(q.x - start.x), Math.abs(q.z - start.z)) > radius || Math.abs(q.y - start.y) > rise) continue
      if (seen.has(key(q))) continue
      const f = read(q); const h = read(q.offset(0, eyeCell, 0)); const g = read(q.offset(0, -1, 0))
      if (!swimPassable(f) || !swimPassable(h)) continue
      if (!waterCell(f) && !waterCell(h) && g?.boundingBox !== 'block' && !(process.env.ND_WATER_ESCAPE_BUDGET !== '0' && waterCell(g))) continue
      seen.add(key(q))
      queue.push({ p: q, parent: i })
    }
  }
  return air || (toward ? null : water)
}

// Follow the connected swim route with manual controls: the old direct line to
// the bank could point through a wall while jump stayed stuck under a roof.
// Итог escapeWater: был ли в воде, вышел ли, куда плыл (target) и разбор выхода (exit, kind, eye, feet…).
interface WaterEscape { ok: boolean; wasInWater: boolean; error?: string; target?: { x: number; y: number; z: number } | null; [key: string]: any }
async function escapeWater (bot, ctl, { timeoutMs = 25000, visibleOnly = false, radius = 8 }: any = {}): Promise<WaterEscape> {
  if (!inWater(bot)) return { ok: true, wasInWater: false, error: undefined }

  try { bot.pathfinder.setGoal(null) } catch {}
  const deadline = gameClock.now() + timeoutMs
  let target = null
  let exit = 'dry', loops = 0, kind = null, breathBudget = null, etaTicks = null
  const budget = process.env.ND_WATER_ESCAPE_BUDGET !== '0'
  const rescue = process.env.ND_WATER_RESCUE === '1'
  const routes = new Map()
  const observed = new Map()
  let waterToward = null
  const changed = () => { routes.clear(); observed.clear(); waterToward = null }
  if (budget) bot.on?.('blockUpdate', changed)
  const plan = opts => {
    if (!budget) return findSwimRoute(bot, opts)
    const p = bot.entity.position
    const key = [Math.floor(p.x * 2), Math.floor(p.y * 2), Math.floor(p.z * 2), (require('./pick') as typeof import('./pick')).eyeHeight(bot), headWet(bot), (bot.oxygenLevel ?? 20) <= 8, opts.radius, opts.rise, opts.breathOnly, waterToward?.toString()].join(',')
    if (routes.has(key)) return routes.get(key)
    const route = findSwimRoute(bot, { ...opts, observed, toward: waterToward })
    if (route) routes.set(key, route)
    return route
  }

  try {
    let plugged = false
    let opened = false
    let wide = null, wideAt = 0, diveTo = null
    while (gameClock.now() < deadline && !ctl.aborted && !dryFooting(bot)) {
      if (waterToward && Math.hypot(waterToward.x + .5 - bot.entity.position.x, waterToward.z + .5 - bot.entity.position.z) <= .35 && bot.entity.position.y >= waterToward.y) waterToward = null
      if (budget && !headWet(bot) && airTicks(bot) < 270) {
        // Recover breath before the bank route can send us below another overhang.
        exit = 'recover-air'
        const eye = (require('./pick') as typeof import('./pick')).eyeOf(bot)
        bot.setControlState('forward', false); bot.setControlState('sprint', !!bot.entity._ndSwimming && !idleBreath(bot))
        bot.setControlState('jump', eye.y < Math.floor(eye.y) + .5 && (bot.entity.velocity?.y ?? 0) <= 0)
        await sleep(50); loops++; continue
      }
      if (budget && headWet(bot)) {
        breathBudget = Math.max(0, airTicks(bot) + 20)
        const up = airAbove(bot), eye = (require('./pick') as typeof import('./pick')).eyeOf(bot)
        if (up && (geometry.verticalLift(bot, bot.entity.position, up.y - eye.y) ?? 0) >= up.y - eye.y - 1e-7) {
          exit = 'air-budget-up'; kind = 'air'; target = up
          etaTicks = swimUpTicks(up.y - eye.y, bot.entity.velocity?.y ?? 0)
          await bot.lookAt(up, true)
          if (ctl.aborted || gameClock.now() >= deadline) { exit = ctl.aborted ? 'aborted' : 'deadline'; break }
          bot.setControlState('forward', false); bot.setControlState('sprint', false); bot.setControlState('jump', true)
          await sleep(50); loops++; continue
        }
      }
      // Воздух кончается, а в 8 бл. его нет (затопленный штрек, cl-ac/cl-ai 14.10: утонул в 1–2 бл. от своего хода) — шире:
      // поиск при нехватке воздуха кончается на первом воздухе, так что широкий круг дёшев.
      let route = plan({ visibleOnly: budget || visibleOnly, radius }) ||
        (radius < 16 && (budget || (bot.oxygenLevel ?? 20) <= 8) && headWet(bot) ? plan({ visibleOnly: budget || visibleOnly, radius: 16, rise: 16 }) : null)
      // A previously observed opening stays the goal until reached or invalidated by blocks.
      if (budget) waterToward = route?.kind === 'water' ? route.target : null
      if (budget && headWet(bot)) {
        breathBudget = Math.max(0, airTicks(bot) + 20)
        // ETA uses the reviewed water acceleration/drag; the air deadline determines whether shore needs a breath stop.
        const stepTicks = (1 - ((bot.food ?? 20) > 6 ? .9 : .8)) / (.02 * .98)
        etaTicks = route ? Math.ceil(route.path.length * stepTicks) : Infinity
        if (route?.kind === 'land' && etaTicks > breathBudget) {
          route = plan({ visibleOnly: true, radius: 16, rise: 16, breathOnly: true }) || route
          etaTicks = Math.ceil(route.path.length * stepTicks)
        }
      }
      target = route?.target || null
      kind = route?.kind || null
      loops++
      if (!route) {
        // Своя нора залита и закрыта сверху (tw-a-s1-3 15.10: нора у пруда «потолок закрыт», вода натекла; тактика Surface
        // 13 раз «не нашёл доступного пути из воды» за 2 с, утонул на месте): твёрдый потолок над головой — вскрыть один раз,
        // за ним бывает воздух. Вода над головой (шахта залита сверху) — ниже, затычка.
        const roofAt = budget ? new Vec3(Math.floor(bot.entity.position.x), Math.ceil(bot.entity.position.y + geometry.dimensions(bot).height - 1e-7), Math.floor(bot.entity.position.z)) : bot.entity.position.floored().offset(0, 2, 0)
        const roof = !opened && headWet(bot) ? bot.blockAt(roofAt) : null
        const cause = () => roof && `${roof.position}:${roof.stateId}:${bot.heldItem?.type}:${geometry.dimensions(bot).height}`
        const lifeTicks = () => airTicks(bot) + 20 + Math.max(0, Math.ceil(bot.health / 2) - 1) * 20
        const sameCause = budget && bot._ndWaterDigRefusal === cause() && lifeTicks() <= (bot._ndWaterDigBudget ?? Infinity)
        if (roof && roof.boundingBox === 'block' && !/^(bedrock|obsidian|crying_obsidian|reinforced_deepslate)$/.test(roof.name) &&
            !sameCause && (!budget || (require('./pick') as typeof import('./pick')).blockSeen(bot, roof.position)) && (typeof bot.canDigBlock !== 'function' || bot.canDigBlock(roof))) {
          opened = true
          try {
            if (budget) bot.clearControlStates()
            await (require('./items') as typeof import('./items')).equipBestTool(bot, roof)
            if (ctl.aborted) break
            // The watchdog is the body's remaining air/HP, not another arbitrary dig timeout.
            if (budget) {
              bot._ndWaterDigRefusal = cause()
              bot._ndWaterDigBudget = lifeTicks()
              const ms = Math.max(50, lifeTicks() * 50)
              try { await (require('./build') as typeof import('./build')).withTimeout(bot.dig(roof, true), Math.min(ms, Math.max(1, deadline - gameClock.now())), 'кончился бюджет воздуха на вскрытие потолка') }
              finally { try { bot.stopDigging() } catch {} }
            } else await bot.dig(roof, true)
          } catch {}
          await sleep(200)
          continue
        }
        // Открытая вода над головой (озеро, море — у глубины лучи глаз воздуха не видят): плыть вверх, как человек
        // (tw-cr2-s1-3 15.10: Surface 15 с «пути нет», под водой без маршрута, хп 20 → 11.7 → смерть). Узкая шахта 1×1 без
        // соседней воды — ниже, затычка.
        const feetC = bot.entity.position.floored()
        const headCell = budget ? (require('./pick') as typeof import('./pick')).eyeOf(bot).floored() : feetC.offset(0, 1, 0)
        const upCell = bot.blockAt(headCell.offset(0, 1, 0))
        const openWater = [headCell, headCell.offset(0, 1, 0)].some(c => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => waterCell(bot.blockAt(c.offset(dx, 0, dz)))))
        const headBlock = bot.blockAt((require('./pick') as typeof import('./pick')).eyeOf(bot)), feetBlock = bot.blockAt(feetC)
        const headLevel = headBlock?.getProperties?.().level ?? headBlock?.metadata
        const feetLevel = feetBlock?.getProperties?.().level ?? feetBlock?.metadata
        const flowingShaft = rescue && !openWater && headBlock?.name === 'water' && headLevel > 0 && feetBlock?.name === 'water' && feetLevel > 0
        if (headWet(bot) && waterCell(upCell) && !flowingShaft && (openWater || rescue)) {
          exit = 'swim-up'
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
          bot.setControlState('jump', true)
          await sleep(160)
          continue
        }
        // Шахта залита сверху (своя копка вверх в воду, cl-n 14.10: «не нашёл доступного пути из воды», смерть): воздуха в
        // досягаемости нет — заткнуть клетку над головой; текущая вода в шахте без притока стекает за тики.
        // A plug cuts a flowing inlet; it cannot drain source water already occupying the body.
        if (!plugged && !opened && headWet(bot) && (!rescue || flowingShaft)) {
          plugged = true
          const above = budget ? roofAt : bot.entity.position.floored().offset(0, 2, 0)
          let r = null
          try { r = await (require('./build') as typeof import('./build')).placeBlockAt(bot, above, { timeoutMs: 1500, honest: true, steady: true, ctl }) } catch {}
          if (r && r.ok) { await sleep(1000); continue }
        }
        exit = 'no-route'
        break
      }
      if (route.kind === 'air' && !headWet(bot)) {
        // Голова над водой, а берега в 8 бл. нет. Раньше — выход сразу: клавиши снимались, тело тонуло, тактика снова звала
        // Surface — качели «вынырнул — утонул», воздух 6–8 и вниз (j1k1-s2-2/3/4 15.10: 3 утопления за 10 мин). Теперь: с
        // поверхности видно дальше — берег в 24 бл.; нет и его — держаться на плаву (прыжок), пока воздух не восстановится.
        // Широкий поиск дорог (лучи по клеткам) — не чаще раза в секунду.
        if (gameClock.now() >= wideAt) { wideAt = gameClock.now() + 1000; wide = plan({ visibleOnly: budget || visibleOnly, radius: 24, rise: 4 }) }
        if (wide && wide.kind === 'land') {
          target = wide.target; kind = 'land-wide'
          const passed = wide.path.findIndex(p => p.equals(bot.entity.position.floored()))
          if (passed >= 0) wide.path.splice(0, passed + 1)
          route = wide
        } else if ((bot.oxygenLevel ?? 20) < 18 || budget && !idleBreath(bot)) {
          exit = 'tread'
          bot.setControlState('forward', false)
          bot.setControlState('sprint', false)
          bot.setControlState('jump', true)
          await sleep(160)
          continue
        } else {
          exit = 'air-dry-head'
          break
        }
      }
      const next = route.path[0] || route.target
      // Finish sinking to a lower route cell before jumping again (j1k1-s2-3).
      const surfaceStroke = budget && !headWet(bot) && idleBreath(bot) && (geometry.verticalLift(bot, bot.entity.position, 1) ?? 0) >= 1
      if (surfaceStroke) diveTo = null
      else if (next.y < bot.entity.position.floored().y) diveTo = next.y
      if (diveTo !== null && bot.entity.position.y <= diveTo) diveTo = null
      const horizontal = Math.hypot(next.x + 0.5 - bot.entity.position.x, next.z + 0.5 - bot.entity.position.z)
      await bot.lookAt(next.offset(0.5, budget ? (require('./pick') as typeof import('./pick')).eyeHeight(bot) : 1.62, 0.5), true)
      if (ctl.aborted || gameClock.now() >= deadline) { exit = ctl.aborted ? 'aborted' : 'deadline'; break }
      bot.setControlState('forward', horizontal > 0.25)
      // Skim the open surface without re-entering a dive; compact air pockets retain their swimming pose.
      bot.setControlState('sprint', (horizontal > 0.25 || budget && headWet(bot) && bot.entity._ndSwimming) && (bot.food ?? 20) > 6 && (!budget || headWet(bot) || !idleBreath(bot)))
      // Jump doubles as "swim up" in water and keeps the head above surface.
      bot.setControlState('jump', inWater(bot) && diveTo === null)
      await sleep(160)
    }
  } finally {
    if (budget) bot.removeListener?.('blockUpdate', changed)
    try { bot.clearControlStates() } catch {}
  }

  const out = dryFooting(bot)
  const head = bot.blockAt((require('./pick') as typeof import('./pick')).eyeOf(bot))
  const breathing = breathCell(head)
  if (exit === 'dry' && !out) exit = ctl.aborted ? 'aborted' : 'deadline'
  const feet = bot.blockAt(bot.entity.position)
  return {
    ok: out,
    breathing,
    wasInWater: true,
    target: target ? xyz(target) : null,
    // Почему кончилось (разбор утоплений 15.10: «не нашёл пути» при найденной цели): выход цикла, вид маршрута, клетки глаз/ног.
    exit, loops, kind, eye: head ? head.name : null, feet: feet ? feet.name : null, air: bot.oxygenLevel ?? null,
    ...(budget ? { breathBudget, etaTicks: Number.isFinite(etaTicks) ? etaTicks : null } : {}),
    error: out ? undefined : breathing ? 'голова в воздухе, но на сухой берег не вышел' : 'не нашёл доступного пути из воды'
  }
}

// Walk toward a column, guarded. Used by exploration, where a failed leg just
// means "try another direction" rather than "the intent failed".
async function travelXZ (bot, ctl, x, z, { range = 4, retries = 2, deadline = null, y = null }: any = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (ctl.aborted) return { ok: false, error: 'прервано' }
    if (deadline && gameClock.now() >= deadline) return { ok: false, error: 'время вышло', outOfTime: true }

    // Never start a walk from inside a river — pathfinder will just thrash.
    if (inWater(bot)) {
      const esc = await escapeWater(bot, ctl, { timeoutMs: deadline ? Math.max(1, deadline - gameClock.now()) : 25000 })
      // Отказ без единого таймера (нет пути из воды) — тик игрового времени, иначе цикл вызывающего крутится микрозадачами
      // и вешает демон (s5c-f4-4 06.10: explore, 100 % CPU, часы стоят).
      if (!esc.ok) { await sleep(50); return { ok: false, error: esc.error } }
    }

    const guard = stuckGuard(bot, ctl)
    const goal = Number.isFinite(y)
      ? new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range)
      : new goals.GoalNearXZ(Math.floor(x), Math.floor(z), range)
    const path = gotoPath(bot, goal)
    const activeOther = () => {
      const active = bot._ndReflexSession?._reflexState?.active
      return active && active.ctl !== ctl && (active.owner === 'Tactical' || active.owner === 'Emergency')
    }
    const canSwim = () => !ctl.aborted && !activeOther() && !bot._ndParkourForecast && bot.pathfinder.goal === goal &&
      inWater(bot) && !goal.isEnd(bot.entity.position.floored()) && !bot.pathfinder.isMoving?.() &&
      !bot.pathfinder.isMining?.() && !bot.pathfinder.isBuilding?.() && !bot.targetDigBlock && !bot.usingHeldItem && !bot.currentWindow
    const water = {}, onWet = () => { if (canSwim()) handoff(water) }
    let handoff
    const wet = new Promise(resolve => { handoff = resolve })
    bot.on('physicsTick', onWet)
    const racers = [
      path,
      guard.promise,
      wet
    ]
    // A single leg must not outlive the caller's budget: the guard only fires
    // when the bot stops moving, and a bot walking the wrong way forever is
    // still "moving".
    let timer = null
    if (deadline) {
      const left = Math.max(1, deadline - gameClock.now())
      racers.push(new Promise<any>((_resolve, reject) => {
        timer = gameClock.setTimeout(() => reject(Object.assign(new Error('время вышло'), { outOfTime: true })), left)
      }))
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      const cancelled = path.cancel?.(); cancelled?.catch?.(() => {})
      guard.stop(); bot.removeListener('physicsTick', onWet)
      if (timer) gameClock.clearTimeout(timer)
    }

    try {
      const outcome = await Promise.race(racers)
      if (outcome === water) {
        // A synchronous goal/lease change may arrive after detection but before
        // this continuation. Release only our waiters and leave the new owner alone.
        if (!canSwim()) return { ok: false, error: 'путь передан другому действию или прерван' }
        release()
        bot.pathfinder.setGoal(null)
        if (ctl.aborted || activeOther()) return { ok: false, error: 'прервано' }
        const esc = await escapeWater(bot, ctl, { timeoutMs: deadline ? Math.max(1, deadline - gameClock.now()) : 25000 })
        if (!esc.ok) return { ok: false, error: esc.error }
        if (ctl.aborted || activeOther() || bot.pathfinder.goal !== null) return { ok: false, error: 'путь передан другому действию или прерван' }
        if (goal.isEnd(bot.entity.position.floored())) return { ok: true }
        // A successful change of transport resumes this same leg, even when
        // retries=0. A physical swim refusal is returned above without an unstuck jump.
        attempt--; continue
      }
      // mineflayer-pathfinder 2.4.5 lib/goto.js: путь длиной 0 («partial», ни
      // одного шага) goto считает ДОСТИГНУТОЙ целью и резолвит без ошибки.
      // В Аду (искажённый лес, обрывы) это «ok» у тела, не сдвинувшегося ни на
      // блок: разведка крепости насчитала 208 пройденных блоков при 47
      // настоящих (try-nether-trip, 2026-09-25). Свидетель — где тело.
      const at = bot.entity.position
      if (Math.hypot(at.x - (Math.floor(x) + 0.5), Number.isFinite(y) ? at.y - Math.floor(y) : 0, at.z - (Math.floor(z) + 0.5)) > range + 1.5) {
        throw Object.assign(new Error('pathfinder не нашёл к цели ни шага (путь длиной 0) — не дошёл'), { noStep: true })
      }
      return { ok: true }
    } catch (err) {
      lastError = err
      release()
      if (err.outOfTime) {
        if (bot.pathfinder.goal === goal && !activeOther()) { try { bot.pathfinder.setGoal(null) } catch {} }
        return { ok: false, error: 'время вышло', outOfTime: true }
      }
      if (bot.pathfinder.goal !== goal || activeOther()) return { ok: false, error: err.message }
      try { bot.pathfinder.setGoal(null) } catch {}
      if (ctl.aborted) return { ok: false, error: err.message }
      // Пути нет вовсе — тело и не застревало: рывок назад тут не лечит, а у
      // обрыва в Аду убивает (падение насмерть, try-nether-trip 2026-09-25).
      if (err.noStep) {
        if (!Number.isFinite(y) && bot.physics && bot.entity.onGround && Math.hypot(bot.entity.position.x - (Math.floor(x) + .5), bot.entity.position.z - (Math.floor(z) + .5)) <= 6) {
          const jump = await (require('./navigation/parkour') as typeof import('./navigation/parkour')).tryLocal(bot, ctl, { x, z })
          if (jump.ok) return { ok: true, parkour: jump }
        }
        return { ok: false, error: err.message, noStep: true }
      }
      await unstick(bot)
    } finally {
      release()
    }
  }
  return { ok: false, error: lastError ? lastError.message : 'не дошёл' }
}

// bot.pathfinder.goto (mineflayer-pathfinder 2.4.5 lib/goto.js) резолвит промис на первом path_update с пустым путём
// — и на ЧАСТИЧНОМ результате поиска (status 'partial': 40 мс поиска на тик), если лучший узел пока сам старт: провал,
// стена или река между телом и целью, а обход уводит сначала прочь от цели. Тогда goto «дошёл», не сделав шага,
// session.goto засчитывает «путь длиной 0» и сдаётся за 0.1–0.3 с (ферма 02.10, mv-gap-dbg4: обход провала по
// перемычке в 11 блоках вбок не находился ни разу, 17–34 узла за 40 мс). Здесь тот же контракт, но пустой partial —
// ждать: поиск продолжается в следующих тиках (monitorMovement: astarContext.compute, пока partial; не дольше
// thinkTimeout = 5 с, потом 'timeout').
// По умолчанию включено (02.10, после серий на ферме); ND_GOTO_WAIT=0 — старое поведение goto.js. Сцены — goto { pathWait }.
function gotoWaitOn () { return process.env.ND_GOTO_WAIT !== '0' }
// Бег в goto (pathfinder allowSprinting). По умолчанию — в верхнем мире (02.10, после серий на ферме: рельеф пула
// mv-spr-1/2, mv-ka-A/B — медиана −13…−14 % по 72 парам, урон тот же; стенд и MLG — без падений и урона); в Аду и Крае —
// шагом, пока бег не померен у лавы и пустоты. ND_SPRINT=1 — везде, ND_SPRINT=0 — нигде (откат).
function sprintOn (dim) {
  const v = process.env.ND_SPRINT
  if (v === '1') return true
  if (v === '0') return false
  // 03.10 пользователь: бег во всех мирах (Ад, Край — тоже), шагом — только когда надо (болото — session.updateMovements;
  // край лавы/пустоты — решают этапы). Было: только верхний мир.
  return dim !== undefined
}

// «stuck» на ходу (mineflayer-pathfinder 2.4.5, index.js): исполнитель засчитывает узел, только когда тело в 0.35 от
// path[0], и только тогда обновляет lastNodeTime; через 3.5 с без этого — resetPath('stuck') и поиск A* С НУЛЯ. Пока
// поиск идёт ('partial', каждый тик новый путь), pathFromPlayer срезает узел, на котором тело стоит (reached → minI + 1),
// ДО проверки прибытия — узел не засчитывается никогда, и через 3.5 с поиска путь сбрасывается, хотя тело бежит по нему
// (рельеф пула, mv-spr-dbg4: 41 → 33 по x за 1.5 с и «stuck» на 3.5 с поиска; поиск дальней ноги не доходил до конца).
// Лечим снаружи: в path_update (событие уходит до path = results.path) — если тело сдвинулось на 0.8+ блока с прошлой
// метки, кладём в начало пути узел-метку в точке тела: исполнитель в этом же тике засчитывает его (lastNodeTime = now)
// и идёт к настоящему path[0]. Стоит на месте — метки нет, честный «stuck» остаётся. По умолчанию вкл. (пользователь 10.10: «бот
// начинает бежать по пути и достраивает маршрут по ходу» — арена: поиск в Колизее 1.5–2.3 с, бот стоял); ND_PATH_KEEPALIVE=0 — выкл.
function pathKeepAliveOn () { return process.env.ND_PATH_KEEPALIVE !== '0' }
// Таймаут A* с лучшим путём — идти по нему до конца, а не отказывать (gotoGoal). По умолчанию вкл. (10.10, как выше); ND_GOTO_TIMEOUT_WALK=0 — выкл.
function timeoutWalkOn () { return process.env.ND_GOTO_TIMEOUT_WALK !== '0' }
function pathKeepAlive (bot, { minMove = 0.8 }: any = {}) {
  let mark = null
  const stats = { marks: 0 }
  const onReset = () => { mark = null }
  const onUpdate = (r) => {
    try {
      if (!pathKeepAliveOn() || !r || !Array.isArray(r.path) || !r.path.length || !bot.entity) return
      const p = bot.entity.position
      if (!mark) { mark = p.clone(); return }
      if (p.distanceTo(mark) < minMove) return
      const n0 = r.path[0]
      // Узел с копкой/стройкой и узлы своих исполнителей (мост, спуск) не трогаем: там свой порядок.
      if (!n0 || (n0.toBreak && n0.toBreak.length) || (n0.toPlace && n0.toPlace.length) || n0.ndBridge || n0.ndDescend) return
      if (Math.abs(n0.x - p.x) <= 0.35 && Math.abs(n0.z - p.z) <= 0.35) { mark = p.clone(); return } // и так засчитает
      const n: any = new Vec3(p.x, p.y, p.z)
      n.toBreak = []; n.toPlace = []; n.parkour = false; n.cost = 0; n.remainingBlocks = n0.remainingBlocks; n.ndKeep = true
      r.path.unshift(n)
      mark = p.clone()
      stats.marks++
    } catch {}
  }
  bot.on('path_update', onUpdate)
  bot.on('path_reset', onReset)
  return { stats, stop () { bot.removeListener('path_update', onUpdate); bot.removeListener('path_reset', onReset) } }
}

// opts.unstuck — наблюдатель лестницы выхода (unstuck.watch, ND_UNSTUCK): пока идёт ступень, свои setGoal(null)/goal
// не рвут переход; отказ поиска не у цели он может взять себе (ступень, потом та же цель ещё раз).
function gotoGoal (bot, goal, opts: any = {}) {
  // Native postProcessPath mutates partial A* nodes to block centres. Search and
  // execution must both check block coordinates, including fractional-radius goals.
  const ownEnd = Object.hasOwn(goal, 'isEnd')
  const isEnd = goal.isEnd
  const blockEnd = node => isEnd.call(goal, node.floored())
  goal.isEnd = blockEnd
  let cancel
  const promise = new Promise<any>((resolve, reject) => {
    const error = (name, message) => Object.assign(new Error(message), { name })
    let done = false
    let un = null
    let resumeTimer = null
    const cleanup = (err?: any) => {
      if (done) return
      done = true
      if (goal.isEnd === blockEnd) {
        if (ownEnd) goal.isEnd = isEnd
        else delete goal.isEnd
      }
      if (un) un.stop()
      if (resumeTimer) gameClock.clearTimeout(resumeTimer)
      bot.removeListener('end', onEnd)
      bot.removeListener('death', onDeath)
      bot.removeListener('goal_reached', onReached)
      bot.removeListener('path_update', onPath)
      bot.removeListener('goal_updated', onGoal)
      bot.removeListener('path_stop', onStop)
      bot.removeListener('physicsTick', onTick)
      bot.removeListener('path_reset', onReset)
      setImmediate(() => (err ? reject(err) : resolve(undefined)))
    }
    cancel = () => cleanup(error('PathStopped', 'Path caller finished before the goal!'))
    const onReached = () => { if (un && un.busy()) return; cleanup() }
    // A* не уложился в 5 с ('timeout'), но лучший путь есть — pathfinder идёт по нему (index.js: path = лучший), а в
    // конце встаёт: нового поиска сам не начнёт (pathUpdated). goto.js тут отказывал «Took to long», и попытка пропадала.
    // Идём до конца этого пути и отдаём «дошёл, но не до цели» — session.goto повторит из нового места (ближе — не в счёт).
  let walkingTimeout = false
  let pathContext = null, prefix = null, prefixEnd = null, prefixStarted = false, continuePrefix = false, terminalPrefix = false
    const onTick = () => {
      if (done) return
      // Custom bridge consumption need not emit another terminal path update.
      const exhausted = terminalPrefix && prefixStarted && !prefix.length && bot.entity?.onGround &&
        bot.pathfinder.goal === goal && !goal.isEnd(bot.entity.position) &&
        !bot.pathfinder.isMining?.() && !bot.pathfinder.isBuilding?.()
      if ((continuePrefix || exhausted) && !bot.pathfinder.isMoving() && !(un && un.busy())) {
        continuePrefix = false; terminalPrefix = false
        bot.pathfinder.setGoal(goal)
      } else if (walkingTimeout && !bot.pathfinder.isMoving()) cleanup()
    }
    const onReset = () => {
      walkingTimeout = false
      pathContext = null; prefix = null; prefixEnd = null; prefixStarted = false; continuePrefix = false; terminalPrefix = false
    }
    const onPath = (r) => {
      if (done || !r || (un && un.busy())) return
      if (r.context) {
        if (pathContext !== r.context) {
          pathContext = r.context; prefix = null; prefixEnd = null; prefixStarted = false; continuePrefix = false; terminalPrefix = false
        }
        if (prefixStarted && !prefix.length && (r.status === 'partial' || r.status === 'success')) {
          // Keep the continuing search. Its next child is ready only when the
          // parent chain still contains the exact Move consumed under our feet.
          if (r.status === 'partial') {
            const ready = []
            let n = r.ndPartialNode || r.context.bestNode
            for (; n && n.data !== prefixEnd; n = n.parent) ready.push(n.data)
            ready.reverse()
            // A different native branch is already trimmed from the body. Keep
            // that publication only when Physics proves its actual next edge.
            if (!n) ready.splice(0, ready.length, ...r.path)
            const p = bot.entity?.position
            const reached = q => p && q && Math.abs(p.x - q.x) <= .35 && Math.abs(p.z - q.z) <= .35 && Math.abs(p.y - q.y) < 1
            const marker = ready[0]?.ndKeep ? ready[0] : null
            const step = marker ? ready.slice(1) : ready, first = step[0]
            if (!reached(prefixEnd) || !bot.entity.onGround || bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.() ||
                (marker && (!reached(marker) || marker.toBreak?.length || marker.toPlace?.length || marker.ndBridge || marker.ndDescend)) ||
                !first || reached(first) || first.toBreak?.length || first.toPlace?.length || first.ndBridge || first.ndDescend ||
                // canMove bypasses its simulator in water; it cannot prove a different branch there.
                (!n && bot.entity.isInWater) || bot.pathfinder.canMove?.(step) !== true) { r.path.length = 0; return }
            r.path.splice(0, r.path.length, ...ready)
          } else {
            const first = r.path[0]
            if (!bot.entity?.onGround || bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.() ||
                !first || first.toBreak?.length || first.toPlace?.length || first.ndBridge || first.ndDescend ||
                bot.pathfinder.canMove?.(r.path) !== true) {
              continuePrefix = true; r.path.length = 0
              return
            }
          }
        }
        if (prefix && prefix.length) {
          const tail = r.path.indexOf(prefix[prefix.length - 1])
          if (tail >= 0) prefix.push(...r.path.slice(tail + 1))
          else if (r.status === 'success') {
            const first = prefix[0]
            const ready = []
            if (bot.entity?.onGround && !bot.pathfinder.isMining?.() && !bot.pathfinder.isBuilding?.() &&
                !first.toBreak?.length && !first.toPlace?.length && !first.ndBridge && !first.ndDescend &&
                bot.pathfinder.canMove?.(prefix) === false) {
              // The success node remains in native AStar's open map. bestNode
              // may be a different branch; keep every parent, including jumps
              // discarded by native nearest-node trimming.
              const last = r.path.at(-1), terminal = r.context.openDataMap?.get(last?.hash)
              if (terminal?.data === last) for (let n = terminal; n?.parent; n = n.parent) ready.push(n.data)
            }
            if (ready.length) { prefix = ready.reverse(); continuePrefix = false }
            else continuePrefix = true
          }
          // Session/custom executors already hold this publication's array.
          // Change its contents, so every consumer walks the selected prefix.
          if (r.path !== prefix) r.path.splice(0, r.path.length, ...prefix)
        } else if (!prefixStarted && r.status === 'partial' && r.path.length) {
          // Native nearest-node trimming can cut the detour before a wall.
          // Its already postprocessed A* chain still contains that ready prefix.
          const ready = []
          for (let n = r.ndPartialNode || r.context.bestNode; n && n.parent; n = n.parent) ready.push(n.data)
          r.path.splice(0, r.path.length, ...ready.reverse())
        }
        prefix = r.path
        if (prefix.length) prefixEnd = prefix.at(-1)
        prefixStarted ||= prefix.length > 0
        terminalPrefix = r.status === 'success'
      }
      walkingTimeout = false
      const empty = !r.path || r.path.length === 0
      if (empty && r.status === 'partial') return
      if (!empty && r.status !== 'noPath' && r.status !== 'timeout') return
      if (!empty && r.status === 'timeout' && timeoutWalkOn()) { walkingTimeout = true; return }
      // Как goto.js: пустой путь — «дошёл» (session проверит, у цели ли), noPath/timeout — отказ.
      const answer = () => {
        if (empty) return cleanup()
        return r.status === 'noPath' ? cleanup(error('NoPath', 'No path to the goal!')) : cleanup(error('Timeout', 'Took to long to decide path to goal!'))
      }
      // Отказ поиска не у цели — лестнице выхода, если возьмёт; не поможет — отдаст тот же ответ (answer).
      if (un && bot.entity && !(empty && goal.isEnd(bot.entity.position.floored())) && un.refused(r, answer)) return
      answer()
    }
    // Цель сбросил рефлекс падения (reflex-lock take, Emergency) — пауза: после рефлекса та же цель снова (ND_GOTO_RESUME=0 — выкл.).
    let paused = false
    const onGoal = (g) => {
      if (un && un.busy()) return
      const lease = g === null && bot._ndReflexTake
      if (lease && process.env.ND_GOTO_RESUME !== '0') {
        paused = true
        lease.after(() => { if (!done) resumeTimer = gameClock.setTimeout(() => { resumeTimer = null; if (!done && paused) { paused = false; bot.pathfinder.setGoal(goal) } }, 0) })
        return
      }
      if (g !== goal) cleanup(error('GoalChanged', 'The goal was changed before it could be completed!'))
    }
    const onStop = () => { if (un && un.busy()) return; cleanup(error('PathStopped', 'Path was stopped before it could be completed! Thus, the desired goal was not reached.')) }
    const onEnd = () => cleanup(error('Disconnected', 'соединение закрыто посреди пути'))
    const onDeath = () => cleanup(error('Died', 'бот умер посреди пути'))
    bot.on('end', onEnd)
    bot.on('death', onDeath)
    bot.on('path_stop', onStop)
    bot.on('goal_reached', onReached)
    bot.on('path_update', onPath)
    bot.on('goal_updated', onGoal)
    bot.on('physicsTick', onTick)
    bot.on('path_reset', onReset)
    if (opts.unstuck) un = opts.unstuck.attach(bot, goal, { resume: () => { if (!done) bot.pathfinder.setGoal(goal) }, fail: err => cleanup(err) })
    bot.pathfinder.setGoal(goal)
  })
  return Object.assign(promise, { cancel: () => cancel?.() })
}

function gotoPath (bot, goal) {
  return gotoWaitOn() ? gotoGoal(bot, goal) : bot.pathfinder.goto(goal)
}

module.exports = {
  sleep, xyz, shaftFromDescent, standableY, describeStall, stuckGuard, unstick, centerOnFloor, travelXZ,
  findNearestLand, findSwimRoute, escapeWater, inWater, waterCell, waterStepCost, waterApproachCost, airTicks, waterBudgetOn, gotoGoal, gotoPath, gotoWaitOn, sprintOn, pathKeepAlive, pathKeepAliveOn, timeoutWalkOn
}
export {
  sleep, xyz, shaftFromDescent, standableY, describeStall, stuckGuard, unstick, centerOnFloor, travelXZ,
  findNearestLand, findSwimRoute, escapeWater, inWater, waterCell, waterStepCost, waterApproachCost, airTicks,
  waterBudgetOn, gotoGoal, gotoPath, gotoWaitOn, sprintOn, pathKeepAlive, pathKeepAliveOn, timeoutWalkOn
}
