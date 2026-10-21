'use strict'
import * as gameClock from '../game-clock'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import * as stronghold from '../stronghold'
import blazeMod = require('../blaze')
import endportal = require('../endportal')
import fortressMod = require('../fortress')
import pearlsMod = require('../pearls')
import bastionMod = require('../bastion')
import dragonMod = require('../dragon')
import * as architect from '../architect'
import * as sorting from '../sorting'
import * as farmMod from '../farm'
import rideMod = require('../ride')
import * as mechanismMod from '../mechanism'
import { HOLDING } from './shared'

function strongholdIntent (this: any, p: any = {}) {
    if (p.mode === 'go' || p.mode === 'room' || p.mode === 'fill' || p.mode === 'travel') return this.strongholdPath(p)
    if (p.mode === 'solve') return this.immediate(async () => { this.require(); return stronghold.solveStored(this, p) })
    if (p.mode === 'blind') return this.immediate(async () => { const bot = this.require(); return stronghold.blindPlan(bot.entity.position, (require('../worlds') as typeof import('../worlds')).worldOf(bot)) })
    const find = p.mode !== 'throw'
    const budget = Math.min(600, p.timeoutSeconds ?? 240)
    return this.runIntent('stronghold', async ctl => {
      this.require()
      this.updateMovements()
      if (find) return stronghold.findStronghold(this, ctl, { sideways: p.sideways ?? 24, maxThrows: p.maxThrows ?? 4, timeoutSeconds: budget })
      const t = await stronghold.throwEye(this, ctl)
      if (t.thrown) stronghold.rememberThrow(this, t)
      return t
    }, {
      timeoutMs: (budget + 20) * 1000,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

function blaze (this: any, p: any = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? 240)
    return this.runIntent('blaze', ctl => {
      this.require()
      this.updateMovements()
      return blazeMod.farmRods(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      interruptOn: ['chat', 'death', 'kicked', 'disconnected']
    })
  }

function dragon (this: any, p: any = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? 300)
    return this.runIntent('dragon', ctl => {
      this.require()
      return dragonMod.dragon(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      interruptOn: ['death', 'kicked', 'disconnected']
    })
  }

function fortress (this: any, p: any = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? 240)
    return this.runIntent('fortress', ctl => {
      this.require()
      this.updateMovements()
      return fortressMod.scout(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

function pearls (this: any, p: any = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? (p.mode === 'barter' ? 180 : 240))
    return this.runIntent('pearls', ctl => {
      this.require()
      this.updateMovements()
      return pearlsMod.pearls(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: p.mode === 'barter' || p.mode === 'seek'
        ? ['chat', 'low_health', 'death', 'kicked', 'disconnected']
        : ['chat', 'death', 'kicked', 'disconnected']
    })
  }

function bastion (this: any, p: any = {}) {
    const budget = Math.min(1800, p.timeoutSeconds ?? 400) // второй бастион — сотни блоков по Аду до него
    return this.runIntent('bastion', ctl => {
      this.require()
      this.updateMovements()
      return bastionMod.bastion(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'death', 'kicked', 'disconnected']
    })
  }

function netherTunnel (this: any, p: any = {}) {
    const budget = Math.min(Array.isArray(p.via) && p.via.length ? 2700 : 1800, p.timeoutSeconds ?? 900)
    return this.runIntent('nether_tunnel', async ctl => {
      this.require()
      this.updateMovements()
      const { tunnelTo }: typeof import('../tunnel') = require('../tunnel')
      const t = { x: Number(p.x), y: p.y !== undefined ? Number(p.y) : undefined, z: Number(p.z) }
      if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) throw new Error('tunnel: нужны x и z')
      const nb = p.noBreachNear && Number.isFinite(Number(p.noBreachNear.x)) ? { x: Number(p.noBreachNear.x), z: Number(p.noBreachNear.z), r: Number(p.noBreachNear.r) || 48 } : null
      // Вслепую в Аду — закрытым штреком по видимому (tunnelTo планирует по скрытому объёму: Codex q9, честность главной метрики).
      const NC: typeof import('../nether-cover') = require('../nether-cover')
      if (NC.blind() && (require('../worlds') as typeof import('../worlds')).worldOf(this.bot) === 'the_nether') {
        const c = await NC.coveredTo(this, ctl, t, { deadline: gameClock.now() + budget * 1000, radius: p.radius ?? 4 })
        return { ...c, note: c.ok ? `закрытым штреком дошёл: отрезков ${c.segs}, шагов ${c.moved}, копок ${c.dug}` : `закрытый штрек встал: ${c.why}` }
      }
      const r = await tunnelTo(this, ctl, t, { band: p.band, radius: p.radius ?? 4, via: p.via, budgetCheck: p.budgetCheck === true, ironOk: p.ironOk === true, noBreachNear: nb, deadline: gameClock.now() + budget * 1000, log: (w, d) => console.log('[tunnel] ' + w + ' ' + JSON.stringify(d)) })
      delete r.own
      return { ...r, note: r.ok ? `штреком дошёл: кусков ${r.segs}, вскрытий ${r.breach}, обходов ${r.detours}, копок ${r.dug}` : `штрек встал: ${r.why}` }
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'death', 'kicked', 'disconnected']
    })
  }

function strongholdPath (this: any, p: any = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? (p.mode === 'fill' ? 180 : 300))
    const work = { go: endportal.goStronghold, room: endportal.findRoom, fill: endportal.fillFrames, travel: (s, c, q) => (require('../travel') as typeof import('../travel')).travel(s, c, q) }[p.mode]
    return this.runIntent('stronghold', ctl => {
      this.require()
      this.updateMovements()
      return work(this, ctl, { ...p, timeoutSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: p.mode === 'fill' ? HOLDING : (p.mode === 'travel' || p.mode === 'room') ? ['chat', 'death', 'kicked', 'disconnected'] : ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

function build (this: any, p: any = {}) {
    const mode = String(p.mode || 'build').trim().toLowerCase()
    if (mode === 'kinds' || mode === 'plan') return this.immediate(() => architect.kinds(this, mode === 'plan' ? p : {}))
    if (mode === 'status') return this.immediate(() => architect.status(this))
    if (mode === 'forget') return this.immediate(() => architect.forget(this))
    if (mode === 'preview') {
      return this.runIntent('build', ctl => {
        this.require()
        this.updateMovements()
        return architect.preview(this, ctl, p)
      }, { timeoutMs: 120000, interruptOn: HOLDING })
    }
    return this.runIntent('build', ctl => {
      this.require()
      this.updateMovements()
      return architect.build(this, ctl, { ...p, mode })
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 240) + 25) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

function sortStorage (this: any, p: any = {}) {
    return this.runIntent('sort', ctl => {
      this.require()
      this.updateMovements()
      return sorting.sort(this, ctl, p)
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 180) + 30) * 1000, interruptOn: HOLDING })
  }

function writeSign (this: any, p: any = {}) {
    return this.runIntent('sign', ctl => {
      this.require()
      this.updateMovements()
      return sorting.sign(this, ctl, p)
    }, { timeoutMs: 45000, interruptOn: HOLDING })
  }

function farm (this: any, p: any = {}) {
    const mode = String(p.mode || 'status').toLowerCase()
    if (mode === 'status') {
      return this.immediate(async () => {
        this.require()
        const at = p.at ? new Vec3(Math.floor(p.at.x), Math.floor(p.at.y), Math.floor(p.at.z)) : null
        return farmMod.survey(this, { radius: Math.max(2, Math.min(24, p.radius ?? 12)), center: at })
      })
    }
    return this.runIntent('farm', ctl => {
      this.require()
      return farmMod.run(this, ctl, { ...p, mode })
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 180) + 15) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

function ride (this: any, p: any = {}) {
    return this.runIntent('ride', ctl => {
      this.require()
      this.updateMovements()
      return rideMod.run(this, ctl, p)
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 120) + 20) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

function mechanism (this: any, p: any = {}) {
    const mode = String(p.mode || 'status').toLowerCase()
    if (mode === 'status' || mode === 'plan') {
      return this.immediate(async () => {
        this.require()
        return mechanismMod.run(this, { aborted: false, onAbort: [] }, { ...p, mode })
      })
    }
    return this.runIntent('mechanism', ctl => {
      this.require()
      this.updateMovements()
      return mechanismMod.run(this, ctl, { ...p, mode })
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 240) + 15) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

export { strongholdIntent as stronghold, blaze, dragon, fortress, pearls, bastion, netherTunnel, strongholdPath, build, sortStorage, writeSign, farm, ride, mechanism }
