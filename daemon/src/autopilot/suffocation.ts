'use strict'
import * as gameClock from '../game-clock'
import { sleep } from '../movement'
import { equipBestTool, missingHarvestTool } from '../items'
import { withTimeout } from '../build'
let unstuck: any
const wallRescue = bot => process.env.ND_OW_BURIAL_STEP === '1' && bot.game?.dimension === 'overworld'
const WALL_STEP_MS = 10 * 50
// in_wall deals one HP per damage-immunity window (10 ticks). Leave one HP for the next pulse.
const exitBudget = (bot, digMs = Infinity) => {
  if (!Number.isFinite(digMs)) digMs = Infinity
  const lifeMs = Math.max(0, (bot.health ?? 20) - 1) * 500
  // If mining still fits, leave its time available after unsuccessful probes.
  const probeMs = wallRescue(bot) ? Math.max(digMs, WALL_STEP_MS / Math.max(.01, bot.physics?.sneakSpeed ?? .3) + WALL_STEP_MS + 50) : digMs
  return Math.max(50, Math.min(probeMs, digMs < lifeMs ? lifeMs - digMs : lifeMs))
}
const FALLS = new Set([
  'gravel', 'suspicious_gravel', 'sand', 'red_sand', 'suspicious_sand',
  'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg',
  'pointed_dripstone', 'scaffolding',
  'white_concrete_powder', 'orange_concrete_powder', 'magenta_concrete_powder',
  'light_blue_concrete_powder', 'yellow_concrete_powder', 'lime_concrete_powder',
  'pink_concrete_powder', 'gray_concrete_powder', 'light_gray_concrete_powder',
  'cyan_concrete_powder', 'purple_concrete_powder', 'blue_concrete_powder',
  'brown_concrete_powder', 'green_concrete_powder', 'red_concrete_powder',
  'black_concrete_powder'
])

// Entity.isInWall (1.21.11) counts only suffocating states: by default blocksMotion && isCollisionShapeFullBlock, plus soul sand,
// mud, farmland and dirt path (isSuffocating always). A bamboo stalk (its shape here without the per-position XZ offset), a fence
// or a pane at the eyes hurts nobody: FreeEmbedded dug a "visible escape" 2936 times in 28 min inside bamboo (cl-m 14.10).
const SUFFOCATING_THIN = /^(soul_sand|mud|farmland|dirt_path)$/
const suffocating = b => SUFFOCATING_THIN.test(b.name) ||
  (b.shapes ?? [[0, 0, 0, 1, 1, 1]]).some(s => s[0] <= 0 && s[1] <= 0 && s[2] <= 0 && s[3] >= 1 && s[4] >= 1 && s[5] >= 1)

// Embedded blocks must be visible to the client ray before an honest escape dig.
function buriedBy (this: any, bot) {
    // Entity.isInWall (1.21.11) tests a thin box at the eyes, width * .8.
    // A jumping body or a head across a cell edge can suffocate while feet+1.2 is air.
    // Contact only identifies the obstruction; visibleBurialBlock still gates every dig.
    const eye = (require('../pick') as typeof import('../pick')).eyeOf(bot)
    const r = (bot.entity.width || .6) * .4
    const centre = eye.floored()
    const cells = [centre]
    for (let x = Math.floor(eye.x - r); x <= Math.floor(eye.x + r); x++) {
      for (let y = Math.floor(eye.y - .0000005); y <= Math.floor(eye.y + .0000005); y++) {
        for (let z = Math.floor(eye.z - r); z <= Math.floor(eye.z + r); z++) {
          const at = centre.clone(); at.x = x; at.y = y; at.z = z
          if (!at.equals(centre)) cells.push(at)
        }
      }
    }
    for (const at of cells) {
      const b = bot.blockAt(at)
      if (!b || b.boundingBox !== 'block' || !suffocating(b)) continue
      const shapes = b.shapes ?? [[0, 0, 0, 1, 1, 1]]
      if (shapes.some(s => at.x + s[0] < eye.x + r && at.x + s[3] > eye.x - r &&
        at.y + s[1] < eye.y + .0000005 && at.y + s[4] > eye.y - .0000005 &&
        at.z + s[2] < eye.z + r && at.z + s[5] > eye.z - r)) return { name: b.name, block: b }
    }
    const head = bot.blockAt(bot.entity.position.offset(0, 1.2, 0))
    if (head && suffocating(head) && (unstuck ??= (require('../unstuck') as typeof import('../unstuck'))).overlapsBody(bot, head)) return { name: head.name, block: head }
    // A server in_wall packet is an observation even when a predicted dig left local air.
    // It permits a physical exit, never excavation of an unseen neighbouring cell.
    if (wallRescue(bot)) {
      this.syncDamageContext?.(bot)
      const hit = Math.max(this.inWallAt || -Infinity, this.session?._tacticalInWallAt ?? -Infinity)
      if (gameClock.now() - hit < 2000) return { name: 'in_wall', block: null }
    }
    if (!this.announced) return null
    const above = bot.blockAt(bot.entity.position.offset(0, 2.2, 0))
    if (above && above.boundingBox === 'block' && FALLS.has(above.name)) {
      return { name: above.name, block: null }
    }
    const drop = this.fallingOverhead(bot)
    return drop ? { name: drop, block: null } : null
  }

function fallingOverhead (this: any, bot) {
    const me = bot.entity.position
    for (const e of (Object.values(bot.entities || {}) as any)) {
      if (!e || e.name !== 'falling_block' || !e.position) continue
      if (Math.floor(e.position.x) !== Math.floor(me.x)) continue
      if (Math.floor(e.position.z) !== Math.floor(me.z)) continue
      const dy = e.position.y - me.y
      if (dy > 0 && dy < 6) return 'падающий блок'
    }
    return null
  }

async function freeIfBuried (this: any, bot, { ctl = null, force = false }: any = {}) {
    if (!force && this.session.tactics?.enabled()) { this.session.tactics.update(true); return }
    const hp = bot.health ?? 20
    const losing = hp < (this.lastHp ?? hp)
    this.lastHp = hp
    if (this.freeing) return

    const head = this.buriedBy(bot)
    if (!head) {
      this.buriedSince = null
      this.stuck = false
      this.freed(bot, null)
      return
    }
    const cur0 = this.session.current
    if (!force && cur0 && cur0.name === 'dragon' && gameClock.now() - (this.inWallAt || 0) > 2000) return
    this.stuck = true
    if (!this.buriedSince) this.buriedSince = gameClock.now()

    const busy = this.bodyBusy()
    const dire = hp <= this.cfg.lowHealth
    if (!force && !losing && !dire) {
      if (busy) return
      if (gameClock.now() - this.buriedSince < 2000) return
    }

    this.buriedSince = null
    this.freeing = true
    const during = busy ? (this.session.current ? this.session.current.name : 'refuge') : null
    if (!this.announced) {
      this.announced = true
      this.dugTotal = 0
      this.session.bus.emit('buried', { block: head.name, health: Math.round(hp), during })
    }

    let why = null
    try {
      if (during && !force) await this.takeTheMouth(bot)
      if (ctl) ctl.onAbort.push(() => { try { bot.stopDigging() } catch {} })
      const until = gameClock.now() + 6000
      let noExit = null
      for (let i = 0; i < 12 && gameClock.now() < until && !ctl?.aborted; i++) {
        const now = this.buriedBy(bot)
        if (!now) break
        if (!now.block) {
          if (wallRescue(bot)) {
            why = await this.stepOutOfWall(bot, { ctl, maxMs: exitBudget(bot) }) ? null : 'in_wall: выход не подтверждён движением'
            break
          }
          await sleep(200)
          continue
        }
        const cell = now.block
        if (!this.visibleBurialBlock(bot, cell)) {
          if (wallRescue(bot) && await this.stepOutOfWall(bot, { ctl, maxMs: exitBudget(bot) })) break
          why = 'блок вне видимого прицела'
          break
        }
        // Не ломается (бедрок, барьер колизея — digTime Infinity): копать бесполезно — шаг в соседнюю свободную клетку
        // (S7d, ревью Codex №4: 28b в барьере поля копал его 12 с до «suffocated in a wall»).
        let infinite = cell.name === 'bedrock' || cell.name === 'barrier'
        try { if (!infinite && !Number.isFinite(bot.digTime(cell))) infinite = true } catch {}
        if (infinite) { const nm = cell.name === 'bedrock' ? 'бедрок' : cell.name === 'barrier' ? 'барьер' : cell.name; why = (await this.stepOutOfWall(bot, { ctl, maxMs: exitBudget(bot) })) ? null : `над головой ${nm} — не ломается, выйти некуда`; break }
        const problem = this.session.mcData
          ? missingHarvestTool(bot, cell, this.session.mcData)
          : null
        let handMs = null
        if (problem) {
          try { handMs = cell.digTime(null, false, false, false, [], bot.entity.effects) } catch {}
          const hpMs = ((bot.health ?? 20) - 1) * 500
          if (!(Number.isFinite(handMs) && handMs < hpMs)) {
            why = await this.stepOutOfWall(bot, { ctl, maxMs: exitBudget(bot, handMs) }) ? null : problem
            break
          }
        }
        try {
          await equipBestTool(bot, cell)
          // Время копки — после экипировки (обсидиан алмазной киркой ~9.4 с не успевал в 8 с — копал заново и
          // утонул, S7d, ревью Codex №4).
          let toolMs = 0
          try { toolMs = bot.digTime(cell) } catch {}
          // Lava can turn the water at our head into obsidian. A clear side exit costs at most
          // ten ticks per attempt; compare that with the equipped dig time before spending HP.
          // Moving out does not grant permission to mine a hidden block behind the embedded one.
          // Сыпучее над сыпучим (карман гравия над штреком): каждый выкопанный блок заменяет следующий из колонки — шаг вбок, в
          // открытый штрек, раньше копки (cl-x 14.10: двенадцать раскопок за 6 с, хп 20 → 0, «suffocated in a wall»).
          const column = FALLS.has(cell.name) && FALLS.has(bot.blockAt(cell.position.offset(0, 1, 0))?.name || '')
          // Боковой выход с этой клетки уже не нашёлся (колодец 1×1: стены те же) — дальше только копка: проба перед КАЖДЫМ блоком
          // колонны стоила ~2.2 с упора в стены (≈ 4 хп) на блок (ow 27.10, A2-10 −3911: in_wall 19 → 3 хп на трёх гравиях).
          const here = bot.entity.position.floored().toString()
          if ((column || !Number.isFinite(toolMs) || toolMs > WALL_STEP_MS) && noExit !== here) {
            if (await this.stepOutOfWall(bot, { ctl, maxMs: exitBudget(bot, toolMs) })) break
            if (bot.entity.position.floored().toString() === here) noExit = here
          }
          if (ctl?.aborted) break
          // A failed/short physical probe may still have moved us. Revalidate its old dig target.
          if (wallRescue(bot)) {
            const contact = this.buriedBy(bot)?.block
            if (!contact || !contact.position.equals(cell.position) || !this.visibleBurialBlock(bot, contact)) continue
          }
          await withTimeout(bot.dig(cell), Math.max(8000, (handMs || 0) + 1500, Number.isFinite(toolMs) ? toolMs + 1500 : 0), `${cell.name} не ломается`)
          this.dugTotal++
          why = null
        } catch (e) {
          why = String((e && e.message) || e)
          try { bot.stopDigging() } catch {}
        }
        // Mineflayer locally predicts air before a server receipt. Observe the next in_wall pulse.
        await sleep(wallRescue(bot) ? WALL_STEP_MS + 50 : 400)
      }
      const feet = bot.blockAt(bot.entity.position)
      const footProblem = feet && this.session.mcData
        ? missingHarvestTool(bot, feet, this.session.mcData)
        : null
      if (!ctl?.aborted && feet && feet.boundingBox === 'block' && feet.name !== 'bedrock' && !footProblem && this.visibleBurialBlock(bot, feet)) {
        try {
          await equipBestTool(bot, feet)
          let toolMs = 0
          try { toolMs = bot.digTime(feet) } catch {}
          await withTimeout(bot.dig(feet), Math.max(8000, Number.isFinite(toolMs) ? toolMs + 1500 : 0), `${feet.name} не ломается`)
          this.dugTotal++
          if (wallRescue(bot)) await sleep(WALL_STEP_MS + 50)
        } catch (e) {
          why = String((e && e.message) || e)
          try { bot.stopDigging() } catch {}
        }
      }
    } catch (e) {
      why = String((e && e.message) || e)
      try { bot.stopDigging() } catch {}
    } finally {
      this.freeing = false
    }
    const left = this.buriedBy(bot)
    if (wallRescue(bot)) console.log('[suffocation]', JSON.stringify({ head: head.name, at: head.block?.position,
      left: left?.name || null, dug: this.dugTotal || 0, hp: bot.health, why }))
    this.stuck = !!left
    if (!this.stuck) { const dug = this.dugTotal || 0; this.freed(bot, during); return { freed: true, dug } }
    const now = gameClock.now()
    if (now - (this.buriedSaidAt || 0) <= 10000) return
    this.buriedSaidAt = now

    const dug = this.dugTotal || 0
    if (dug > 0) {
      this.session.bus.emit('digging_out', {
        block: left.name,
        health: Math.round(bot.health ?? 0),
        dug,
        during
      })
      return
    }
    this.session.bus.emit('still_buried', {
      block: left.name,
      health: Math.round(bot.health ?? 0),
      dug,
      during,
      why: why || 'блок не поддался'
    })
    try {
      this.session.journal.append('завал',
        `не смог откопаться: ${left.name} над головой, ${why || 'блок не поддался'}` +
        (during ? ` (шло намерение ${during})` : ''), bot.entity.position)
    } catch {}
    return { freed: false, dug: this.dugTotal || 0, reason: why || 'блок не поддался' }
  }

function visibleBurialBlock (this: any, bot, block) {
    try {
      const pick: typeof import('../pick') = require('../pick')
      const eye = pick.eyeOf(bot)
      const delta = block.position.offset(0.5, 0.5, 0.5).minus(eye)
      const distance = delta.norm()
      if (distance < 1e-9) return true
      const hit = pick.blockOnRay(bot, eye, delta.scaled(1 / distance), Math.min(4.5, distance + 0.1))
      return !!hit && hit.pos.equals(block.position)
    } catch { return false }
  }

// Inside an opaque block neighbouring packet cells are not observations. Try short
// directions by distance alone, sneaking against unseen edges; unknown contact risk
// remains, compared with continuing in_wall damage. Never excavate a hidden neighbour.
async function stepOutOfWall (this: any, bot, { ctl = null, maxMs = Infinity }: any = {}) {
  const Vec3: typeof import('vec3').Vec3 = require('vec3')
  const pick: typeof import('../pick') = require('../pick')
  const { HAZARD }: typeof import('../navigation/geometry') = require('../navigation/geometry')
  const at = bot.entity.position.clone()
  const base = at.floored()
  const cells = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]].map(([dx, dz]) => base.offset(dx, 0, dz))
  cells.sort((a, b) => a.offset(0.5, 0, 0.5).distanceTo(at) - b.offset(0.5, 0, 0.5).distanceTo(at))
  const until = gameClock.now() + maxMs
  // Native physics multiplies movement input by sneakSpeed (normally 0.3).
  const probeMs = WALL_STEP_MS / Math.max(.01, bot.physics?.sneakSpeed ?? .3)
  const wasSneaking = !!bot.getControlState?.('sneak')
  const stop = () => { try { bot.setControlState('forward', false); bot.setControlState('sneak', wasSneaking) } catch {} }
  let wake = null
  const cancel = () => { stop(); wake?.() }
  ctl?.onAbort?.push(cancel)
  try {
    for (const c of cells) {
      if (ctl?.aborted || gameClock.now() >= until) break
      const below = c.offset(0, -1, 0)
      // Reject an actually visible hazard, never use a hidden support to rank directions.
      if (pick.blockSeen(bot, below, { range: 4.5 }) && HAZARD.test(bot.blockAt(below, false)?.name || '')) continue
      const goal = new Vec3(c.x + 0.5, at.y, c.z + 0.5)
      try { await bot.lookAt(goal.offset(0, 1.6, 0), true) } catch {}
      if (ctl?.aborted) break
      try { bot.setControlState('sneak', true); bot.setControlState('forward', true) } catch {}
      const end = Math.min(until, gameClock.now() + probeMs)
      let clearSince = null
      while (!ctl?.aborted && gameClock.now() < end) {
        await new Promise<void>(resolve => {
          const timer = gameClock.setTimeout(done, 50)
          function done () { gameClock.clearTimeout(timer); wake = null; resolve() }
          wake = done
        })
        if (ctl?.aborted) break
        const clear = !buriedBy.call(this, bot)?.block
        if (!wallRescue(bot)) { if (clear) return true; continue }
        const moved = Math.hypot(bot.entity.position.x - at.x, bot.entity.position.z - at.z) >= (bot.entity.width || .6) / 2
        if (!clear || !moved) { clearSince = null; continue }
        if (clearSince === null) clearSince = gameClock.now()
        // A predicted dig can leave local air while the server still suffocates us.
        // Require horizontal progress AND a full damage-immunity window plus one tick
        // without another in_wall packet; fresh damage during the probe resets the receipt.
        const hit = Math.max(this.inWallAt || -Infinity, this.session?._tacticalInWallAt ?? -Infinity)
        if (gameClock.now() - Math.max(clearSince, hit) < WALL_STEP_MS + 50) continue
        this.inWallAt = 0
        if (this.session) { this.session._tacticalInWallAt = -Infinity; this.session._tacticalEmbedded = false }
        return true
      }
      try { bot.setControlState('forward', false) } catch {}
    }
    return false
  } finally {
    cancel()
    if (ctl?.onAbort) { const i = ctl.onAbort.indexOf(cancel); if (i >= 0) ctl.onAbort.splice(i, 1) }
  }
}

function freed (this: any, bot, during) {
    this.buriedSaidAt = 0
    const dug = this.dugTotal || 0
    this.dugTotal = 0
    if (!this.announced) return
    this.announced = false
    this.session.bus.emit('freed', {
      dug,
      byItself: dug === 0,
      health: Math.round(bot.health ?? 0),
      during
    })
  }

export { buriedBy, fallingOverhead, freeIfBuried, visibleBurialBlock, freed, stepOutOfWall }
