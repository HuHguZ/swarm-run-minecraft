'use strict'
const gameClock = require('../game-clock')
const { sleep } = require('../movement')
const { equipBestTool, missingHarvestTool } = require('../items')
const { withTimeout } = require('../build')
let unstuck: any
const WALL_STEP_MS = 10 * 50
// in_wall deals one HP per damage-immunity window (10 ticks). Leave one HP for the next pulse.
const exitBudget = (bot, digMs = Infinity) => {
  if (!Number.isFinite(digMs)) digMs = Infinity
  const lifeMs = Math.max(0, (bot.health ?? 20) - 1) * 500
  // If mining still fits, leave its time available after unsuccessful probes.
  return Math.max(50, Math.min(digMs, digMs < lifeMs ? lifeMs - digMs : lifeMs))
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
    const eye = require('../pick').eyeOf(bot)
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
    if (head && suffocating(head) && (unstuck ??= require('../unstuck')).overlapsBody(bot, head)) return { name: head.name, block: head }
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
      for (let i = 0; i < 12 && gameClock.now() < until && !ctl?.aborted; i++) {
        const now = this.buriedBy(bot)
        if (!now) break
        if (!now.block) {
          await sleep(200)
          continue
        }
        const cell = now.block
        if (!this.visibleBurialBlock(bot, cell)) { why = 'блок вне видимого прицела'; break }
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
          if ((column || !Number.isFinite(toolMs) || toolMs > WALL_STEP_MS) && await this.stepOutOfWall(bot, { ctl, maxMs: exitBudget(bot, toolMs) })) break
          if (ctl?.aborted) break
          await withTimeout(bot.dig(cell), Math.max(8000, (handMs || 0) + 1500, Number.isFinite(toolMs) ? toolMs + 1500 : 0), `${cell.name} не ломается`)
          this.dugTotal++
          why = null
        } catch (e) {
          why = String((e && e.message) || e)
          try { bot.stopDigging() } catch {}
        }
        await sleep(400)
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
      const pick = require('../pick')
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
  const Vec3 = require('vec3')
  const pick = require('../pick')
  const { HAZARD } = require('../navigation/geometry')
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
      while (!ctl?.aborted && gameClock.now() < end) {
        await new Promise<void>(resolve => {
          const timer = gameClock.setTimeout(done, 50)
          function done () { gameClock.clearTimeout(timer); wake = null; resolve() }
          wake = done
        })
        if (ctl?.aborted) break
        if (!buriedBy.call(this, bot)?.block) return true
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

module.exports = { buriedBy, fallingOverhead, freeIfBuried, visibleBurialBlock, freed, stepOutOfWall }
