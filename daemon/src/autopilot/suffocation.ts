'use strict'
const gameClock = require('../game-clock')
const { sleep } = require('../movement')
const { equipBestTool, missingHarvestTool } = require('../items')
const { withTimeout } = require('../build')
let unstuck: any
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

// Embedded blocks must be visible to the client ray before an honest escape dig.
function buriedBy (this: any, bot) {
    const head = bot.blockAt(bot.entity.position.offset(0, 1.2, 0))
    if (head && (unstuck ??= require('../unstuck')).overlapsBody(bot, head)) return { name: head.name, block: head }
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
        if (cell.name === 'bedrock') { why = 'над головой бедрок'; break }
        const problem = this.session.mcData
          ? missingHarvestTool(bot, cell, this.session.mcData)
          : null
        let handMs = null
        if (problem) {
          try { handMs = cell.digTime(null, false, false, false, [], bot.entity.effects) } catch {}
          const hpMs = ((bot.health ?? 20) - 1) * 500
          if (!(Number.isFinite(handMs) && handMs < hpMs)) { why = problem; break }
        }
        try {
          await equipBestTool(bot, cell)
          await withTimeout(bot.dig(cell), Math.max(8000, (handMs || 0) + 1500), `${cell.name} не ломается`)
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
          await withTimeout(bot.dig(feet), 8000, `${feet.name} не ломается`)
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

module.exports = { buriedBy, fallingOverhead, freeIfBuried, visibleBurialBlock, freed }
