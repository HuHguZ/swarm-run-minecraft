'use strict'
const gameClock = require('../game-clock')
const actions = require('../actions')
const containers = require('../containers')
const armor = require('../armor')
const obsidianMod = require('../obsidian')
const packMod = require('../pack')
const prepMod = require('../prep')
function sleep (ms, ctl?: any) {
  if (ctl?.aborted) return Promise.resolve()
  return new Promise<void>(resolve => {
    const t = gameClock.setTimeout(resolve, ms)
    if (ctl) ctl.onAbort.push(() => { gameClock.clearTimeout(t); resolve() })
  })
}
const HOLDING = ['chat', 'low_health', 'death', 'kicked', 'disconnected']
const WORKBENCH = ['damage', 'low_health', 'death', 'kicked', 'disconnected']

function prep (this: any, p: any = {}) {
    return this.runIntent('prep', ctl => {
      const bot = this.require()
      const enemy = p.enemy || null
      const shouldStop = (mode) => {
        const e = enemy && bot.players[enemy] && bot.players[enemy].entity
        if (!e) return false
        const d = e.position.distanceTo(bot.entity.position)
        return mode === 'soon' ? d < 14 : d < 5
      }
      return prepMod.prepare(this, ctl, { strategy: p.strategy || 'full', shouldStop })
    }, { timeoutMs: 120000, interruptOn: ['damage', 'death', 'kicked', 'disconnected'] })
  }

function enchant (this: any, p: any = {}) {
    if (p.mode === 'plan') return this.immediate(async () => { this.require(); return require('../enchant').plan(this, p) })
    return this.runIntent('enchant', ctl => {
      this.require()
      return require('../enchant').run(this, ctl, p)
    }, { timeoutMs: 240000, interruptOn: WORKBENCH })
  }

function brew (this: any, p: any = {}) {
    if (p.plan) return this.immediate(async () => { this.require(); return require('../brew').brew(this, { aborted: false, onAbort: [] }, p) })
    const steps = (require('../brew').chainOf(require('../brew').resolvePotion(p.potion || 'fire_resistance') || 'awkward') || []).length + (p.splash ? 1 : 0)
    const batches = Math.ceil(Math.max(1, Math.min(6, p.count || 3)) / 3)
    return this.runIntent('brew', ctl => {
      this.require()
      return require('../brew').brew(this, ctl, p)
    }, { timeoutMs: (150 + steps * batches * 25) * 1000, interruptOn: WORKBENCH })
  }

function kit (this: any, p: any = {}) {
    if (p.craft === false) return this.immediate(async () => { this.require(); return require('../fightkit').kit(this, { aborted: false, onAbort: [] }, p) })
    return this.runIntent('kit', ctl => {
      this.require()
      return require('../fightkit').kit(this, ctl, p)
    }, { timeoutMs: 180000, interruptOn: WORKBENCH })
  }

function bucket (this: any, p: any = {}) {
    return this.runIntent('bucket', ctl => {
      this.require()
      this.updateMovements()
      return obsidianMod.fillBucket(this, ctl, { fluid: p.fluid === 'lava' ? 'lava' : 'water', radius: p.radius ?? 24 })
    }, { timeoutMs: 60000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

function pack (this: any, p: any = {}) {
    if ((p.mode || 'status') === 'status') {
      return this.immediate(async () => packMod.status(this.require()))
    }
    return this.runIntent('pack', async ctl => {
      const bot = this.require()
      const before = packMod.status(bot)
      let also = null
      if (p.also) {
        also = {}
        for (const part of String(p.also).split(',')) {
          const [name, n] = part.split(':').map(s => s.trim())
          if (name) also[name] = Math.max(0, Number(n) || 0)
        }
      }
      const r = await packMod.tidy(bot, { also })
      if (r.tossed.length && !ctl.aborted && bot.entity.onGround) {
        const yaw = bot.entity.yaw
        const away = bot.entity.position.offset(Math.sin(yaw) * 3, 0, Math.cos(yaw) * 3)
        await require('../navigation/parkour').executeJump(bot, ctl, away, { allowWalk: true, planningMs: 180 })
      }
      return { ...r, free: bot.inventory.emptySlotCount(), was: before.free }
    }, { timeoutMs: 20000, interruptOn: ['death', 'kicked', 'disconnected'] })
  }

function cache (this: any, p: any = {}) {
    const mode = p.mode || 'make'
    if (mode === 'list') {
      return this.immediate(async () => {
        const places = this.journal.state.places || {}
        const out = []
        for (const [name, r] of (Object.entries(places) as any)) {
          if (!/^схрон/.test(name) || !r) continue
          out.push({ name, x: r.x, y: r.y, z: r.z, dimension: r.dimension, chests: (r.chests || []).map(c => c.contents || {}) })
        }
        return { caches: out, text: out.length ? out.map(c => `${c.name} на ${c.x},${c.y},${c.z}`).join('; ') : 'схронов нет' }
      })
    }
    return this.runIntent('cache', async ctl => {
      this.require()
      this.updateMovements()
      let name = p.name
      if (!name) {
        const taken = new Set(Object.keys(this.journal.state.places || {}))
        let n = 1
        while (taken.has(`схрон-${n}`)) n++
        name = `схрон-${n}`
      }
      const set = await containers.base(this, ctl, { mode: 'set', name, radius: 6, torch: false })
      const put = await containers.stash(this, ctl, { mode: 'put', name, item: p.item || 'all', keep: p.keep || null })
      return { name, at: set.at || put.at, put: put.put, kept: put.kept, stopped: put.stopped, note: put.note }
    }, { timeoutMs: 120000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

function chestPut (this: any, p: any = {}) {
    return this.runIntent('chest_put', ctl => {
      this.require()
      this.updateMovements()
      return containers.chestPut(this, ctl, p)
    }, { timeoutMs: 60000, interruptOn: HOLDING })
  }

function chestTake (this: any, p: any = {}) {
    return this.runIntent('chest_take', ctl => {
      this.require()
      this.updateMovements()
      return containers.chestTake(this, ctl, p)
    }, { timeoutMs: containers.chestTakeMs(p.timeoutSeconds) + 2000, params: p, interruptOn: HOLDING })
  }

function chestList (this: any, p: any = {}) {
    return this.runIntent('chest_list', ctl => {
      this.require()
      this.updateMovements()
      return containers.chestList(this, ctl, p)
    }, { timeoutMs: 45000, interruptOn: HOLDING })
  }

function base (this: any, p: any = {}) {
    const mode = String(p.mode || 'where').trim().toLowerCase()
    if (mode === 'where' || mode === 'forget') return this.immediate(() => containers.baseNow(this, p))
    return this.runIntent('base', ctl => {
      this.require()
      this.updateMovements()
      return containers.base(this, ctl, p)
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 120) + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

function stash (this: any, p: any = {}) {
    if (String(p.mode || 'list').trim().toLowerCase() === 'list') {
      return this.immediate(() => containers.stashNow(this, p))
    }
    return this.runIntent('stash', ctl => {
      this.require()
      this.updateMovements()
      return containers.stash(this, ctl, p)
    }, { timeoutMs: 90000, interruptOn: HOLDING })
  }

function wearBestArmor (this: any, p: any = {}) {
    return this.immediate(() => {
      this.require()
      return armor.equipBestArmor(this, { aborted: false, onAbort: [] }, p)
    })
  }

function equipItem (this: any, p: any = {}) {
    return this.immediate(() => { this.require(); return actions.equip(this, p) })
  }

function eat (this: any, p: any = {}) {
    return this.immediate(async () => {
      this.require()
      this.eating = true
      try { return await actions.eat(this, p) } finally { this.eating = false }
    })
  }

function dropItem (this: any, p: any = {}) {
    return this.immediate(() => { this.require(); return actions.drop(this, p) })
  }

module.exports = { prep, enchant, brew, kit, bucket, pack, cache, chestPut, chestTake, chestList, base, stash, wearBestArmor, equipItem, eat, dropItem }
