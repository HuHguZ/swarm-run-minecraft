// Optional OW desert primitives. No seed/map data: only first-hit visual rays.
import * as gameClock from '../game-clock'
import { surface } from '../perception/eyes'
import { inWater, escapeWater, sleep } from '../movement'
import { towerUp, pickFiller, withTimeout } from '../build'
import { countOf, equipBestTool } from '../items'

export const desertOn = (bot: any, flag: string): boolean => process.env[flag] === '1' &&
  String(bot.game?.dimension || '').replace(/^minecraft:/, '') === 'overworld'

// Leaves are opaque in eyes.surface; a hidden trunk is not evidence that a log was seen.
// Sampling is bounded; failure means no ray found a canopy, not that no tree exists.
export function treeHorizon (bot: any, ctl: any): any {
  let best: any = null
  const chunks = Number(bot.settings?.viewDistance)
  const maxDist = Math.min(128, Number.isFinite(chunks) && chunks > 0 ? chunks * 16 : 128)
  for (let yaw = 0; yaw < 360 && !ctl.aborted; yaw += 3) {
    for (let pitch = -24; pitch <= 12; pitch += 3) {
      const hit = surface(bot, { yaw, pitch, maxDist })
      if (hit && /_(leaves|log|stem)$/.test(hit.name) && (!best || hit.dist < best.dist)) best = hit
    }
  }
  return best
}

export async function desertTreeLook (session: any, ctl: any, walk: any, deadline: number): Promise<any> {
  const bot = session.bot
  if (!desertOn(bot, 'ND_OW_DESERT_LOOK') || ctl.aborted) return null
  if (inWater(bot)) {
    await escapeWater(bot, ctl, { timeoutMs: Math.min(15000, Math.max(0, deadline - gameClock.now())) })
    if (inWater(bot) || ctl.aborted) return { stopped: 'desert look: water exit failed' }
  }
  let tree = treeHorizon(bot, ctl)
  if (tree) return { tree, raised: 0 }
  // Try an observed uphill face first. Never inspect a hidden dune top or choose a map coordinate.
  const from = bot.entity.position.clone()
  const dunes: any[] = []
  for (let yaw = 0; yaw < 360 && !ctl.aborted; yaw += 15) {
    const h = surface(bot, { yaw, pitch: -15, maxDist: 32 })
    if (h && /^(sand|sandstone|red_sand|red_sandstone)$/.test(h.name) && h.pos.y > from.y + 2) dunes.push(h)
  }
  dunes.sort((a, b) => a.dist - b.dist)
  if (dunes[0] && deadline - gameClock.now() > 15000) {
    await walk(dunes[0].pos.x, dunes[0].pos.z, { range: 1 })
    tree = treeHorizon(bot, ctl)
    if (tree) return { tree, raised: bot.entity.position.y - from.y }
  }
  if (ctl.aborted || inWater(bot) || deadline - gameClock.now() < 15000) return null
  let base = bot.entity.position.clone()
  const floor = bot.blockAt(base.offset(0, -0.2, 0))
  if (!bot.entity.onGround || !floor || floor.boundingBox !== 'block' || !/^(sand|sandstone|red_sandstone|dirt)$/.test(floor.name)) return null
  // The tower has real support. Sand is allowed here, never as a hanging roof.
  let stack = pickFiller(bot)
  if (!stack || stack.count < 6) {
    try { await (require('./gather') as typeof import('./gather')).mine(session, ctl,
      { block: 'sand', count: Math.max(0, 6 - countOf(bot, 'sand')), radius: 5, minY: Math.floor(base.y) - 1, fair: true, dry: true }) } catch {}
    stack = pickFiller(bot)
  }
  if (!stack || stack.count < 4 || ctl.aborted || !bot.entity.onGround || inWater(bot)) return null
  base = bot.entity.position.clone()
  if (bot.blockAt(base.offset(0, -0.2, 0))?.boundingBox !== 'block') return null
  const own = base.floored(), height = Math.min(6, stack.count)
  let raised = 0, returned = true
  try {
    await towerUp(bot, ctl, height, { item: stack.name })
    raised = Math.max(0, Math.floor(bot.entity.position.y) - own.y)
    tree = treeHorizon(bot, ctl)
  } finally {
    // Dismantle only our own column. An interrupted intent leaves ownership to its controller.
    while (!ctl.aborted && Math.floor(bot.entity.position.y) > own.y) {
      const feet = bot.entity.position.floored()
      if (feet.x !== own.x || feet.z !== own.z) { returned = false; break }
      const below = bot.blockAt(feet.offset(0, -1, 0))
      if (!below || below.name !== stack.name) { returned = false; break }
      try {
        await equipBestTool(bot, below)
        await withTimeout(bot.dig(below), 6000)
        await sleep(450)
        if (Math.floor(bot.entity.position.y) >= feet.y) { returned = false; break }
      } catch { try { bot.stopDigging() } catch {}; returned = false; break }
    }
  }
  if (!returned || ctl.aborted) return { stopped: 'desert look: column descent incomplete', raised }
  return tree ? { tree, raised } : null
}

// Four sand -> roof in the 2x2 grid, plus three sand reserved for the way out.
// minY avoids mining a pit around the future shelter; existing shelter checks its walls and water.
export async function desertRoof (session: any, ctl: any): Promise<boolean> {
  const bot = session.bot
  if (!desertOn(bot, 'ND_OW_DESERT_HAND_SHELTER') || ctl.aborted || inWater(bot)) return false
  const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
  if (!/^(sand|sandstone|red_sandstone)$/.test(floor?.name || '') || bot.inventory.items().some((i: any) => /_pickaxe$/.test(i.name))) return false
  const stable = !!pickFiller(bot, { steady: true }), need = stable ? 3 : 7
  if (countOf(bot, 'sand') < need) await (require('./gather') as typeof import('./gather')).mine(session, ctl,
    { block: 'sand', count: need - countOf(bot, 'sand'), radius: 5, minY: floor.position.y, fair: true, dry: true })
  if (ctl.aborted || countOf(bot, 'sand') < need) return false
  if (!stable) await (require('./craft') as typeof import('./craft')).craft(session, ctl, { item: 'sandstone', count: 1 })
  return !!pickFiller(bot, { steady: true }) && countOf(bot, 'sand') >= 3
}
