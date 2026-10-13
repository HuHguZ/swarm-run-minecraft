'use strict'
import { runFlightRoute, type FlightRouteRequest } from '../combat/flight-route'
import { runBoatHop, type BoatHopRequest } from '../combat/boat-hop'
import { navigate } from '../navigation/parkour'
const actions = require('../actions')
const mining = require('../mining')
const survival = require('../survival')
const containers = require('../containers')
const nether = require('../nether')
const obsidianMod = require('../obsidian')
const HOLDING = ['chat', 'low_health', 'death', 'kicked', 'disconnected']

function parkour(this: any, p: Parameters<typeof navigate>[2] & { timeoutSeconds?: number }) {
  const timeoutMs = p.mode === 'route' || p.mode === 'options'
    ? (Math.max(1, Math.min(p.mode === 'route' ? 3600 : 600, p.timeoutSeconds ?? 120)) + 20) * 1000 : 60000
  return this.runIntent('parkour', (ctl: any) => navigate(this.bot, ctl, p), {
    timeoutMs, interruptOn: HOLDING, params: p
  })
}

function flightRoute(this: any, p: FlightRouteRequest) {
  return this.runIntent('flight_route', (ctl: any) => runFlightRoute(this, ctl, p), {
    timeoutMs: ((p.timeoutSeconds ?? 120) + 20) * 1000, interruptOn: HOLDING, params: p
  })
}

function boatHop(this: any, p: BoatHopRequest = {}) {
  return this.runIntent('boat_hop', (ctl: any) => runBoatHop(this, ctl, p), {
    timeoutMs: ((p.timeoutSeconds ?? 10) + 5) * 1000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'], params: p
  })
}

function mine (this: any, p: any = {}) {
    return this.runIntent('mine', ctl => {
      this.require()
      this.updateMovements()
      return actions.mine(this, ctl, p)
    }, { timeoutMs: Math.min(600, p.timeoutSeconds ?? 180) * 1000, params: p })
  }

function mineSeen (this: any, p: any = {}) {
    if (!p.at && !p.block) {
      return this.immediate(() => { this.require(); return mining.recallOre(this, p) })
    }
    return this.runIntent('mine_seen', ctl => {
      this.require()
      this.updateMovements()
      return mining.mineSeen(this, ctl, p)
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 180) + 20) * 1000,
      interruptOn: ['chat', 'damage', 'low_health', 'death', 'kicked', 'disconnected'],
      params: p
    })
  }

function digDown (this: any, p: any = {}) {
    const stairs = p.mode === 'stairs' || p.mode === 'лестница'
    const depth = Math.max(1, Math.min(128, p.depth ?? 5))
    const budget = stairs
      ? Math.min(600, p.timeoutSeconds ?? 240)
      : Math.min(600, p.timeoutSeconds ?? (25 + depth * 4))
    return this.runIntent('dig_down', ctl => {
      this.require()
      return actions.digDown(this, ctl, { ...p, budgetSeconds: budget })
    }, {
      timeoutMs: (budget + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

function explore (this: any, p: any = {}) {
    return this.runIntent('explore', ctl => {
      this.require()
      this.updateMovements()
      return actions.explore(this, ctl, p)
    }, { timeoutMs: (Math.min(280, p.timeoutSeconds ?? 45) + 20) * 1000, params: p })
  }

function craft (this: any, p: any = {}) {
    return this.runIntent('craft', ctl => {
      this.require()
      if (this.crafting) throw new Error('автопилот сейчас делает инструмент, повтори через секунду')
      return actions.craft(this, ctl, p)
    }, { timeoutMs: Math.max(1, Math.min(600, p.timeoutSeconds ?? 90)) * 1000, interruptOn: HOLDING, params: p })
  }

function place (this: any, p: any = {}) {
    return this.runIntent('place', ctl => {
      this.require()
      return actions.place(this, ctl, p)
    }, { timeoutMs: 45000 })
  }

function obsidian (this: any, p: any = {}) {
    const budget = Math.min(600, p.timeoutSeconds ?? 300)
    return this.runIntent('obsidian', ctl => {
      this.require()
      this.updateMovements()
      return obsidianMod.obsidian(this, ctl, { count: p.count ?? 10, radius: p.radius ?? 20, timeoutSeconds: budget })
    }, { timeoutMs: (budget + 20) * 1000, interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'] })
  }

function smelt (this: any, p: any = {}) {
    return this.runIntent('smelt', ctl => {
      this.require()
      return containers.smelt(this, ctl, p)
    }, { timeoutMs: (Math.min(600, p.timeoutSeconds ?? 120) + 30) * 1000, interruptOn: HOLDING })
  }

function furnaceTake (this: any, p: any = {}) {
    return this.runIntent('furnace_take', ctl => {
      this.require()
      return containers.takeFurnace(this, ctl, p)
    }, { timeoutMs: 60000, interruptOn: HOLDING })
  }

function tunnel (this: any, p: any = {}) {
    return this.runIntent('tunnel', ctl => {
      this.require()
      this.updateMovements()
      return mining.tunnel(this, ctl, p)
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 180) + 20) * 1000,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected'],
      params: p
    })
  }

function shelter (this: any, p: any = {}) {
    return this.runIntent('shelter', ctl => {
      this.require()
      return survival.shelter(this, ctl, p)
    }, { timeoutMs: 90000, interruptOn: ['chat', 'death', 'kicked', 'disconnected'] })
  }

function surface (this: any, p: any = {}) {
    return this.runIntent('surface', ctl => {
      this.require()
      this.updateMovements()
      return survival.surface(this, ctl, p)
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 240) + 25) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

function recoverLoot (this: any, p: any = {}) {
    return this.runIntent('recover', ctl => {
      this.require()
      this.updateMovements()
      return survival.recoverLoot(this, ctl, p)
    }, {
      timeoutMs: (Math.min(300, p.timeoutSeconds ?? 90) + 25) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

function sleepInBed (this: any, p: any = {}) {
    if (p.simple) {
      return this.runIntent('sleep', ctl => {
        this.require()
        return actions.sleepInBed(this, ctl, p)
      }, { timeoutMs: (Math.min(120, p.waitSeconds ?? 40) + 20) * 1000 })
    }
    if (p.mode === 'spawn' || p.mode === 'take') {
      return this.runIntent('sleep', ctl => {
        this.require()
        const bt = require('../bedtime')
        return p.mode === 'spawn' ? bt.setSpawn(this, ctl, p) : bt.takeSpawnBed(this, ctl)
      }, { timeoutMs: 40000, params: p })
    }
    return this.runIntent('sleep', ctl => {
      this.require()
      this.updateMovements()
      return require('../bedtime').night(this, ctl, p)
    }, { timeoutMs: (Math.max(60, Math.min(600, p.timeoutSeconds ?? 300)) + 20) * 1000, params: p })
  }

function wakeUp (this: any, ) {
    return this.immediate(() => { this.require(); return actions.wakeUp(this) })
  }

function portal (this: any, p: any = {}) {
    const mode = String(p.mode || 'build').trim().toLowerCase()
    if (mode === 'where' || mode === 'forget') return this.immediate(() => nether.portalNow(this, p))
    if (mode === 'enter') {
      return this.runIntent('portal', ctl => {
        this.require()
        this.updateMovements()
        return nether.enter(this, ctl, p)
      }, {
        timeoutMs: (Math.min(600, p.timeoutSeconds ?? 90) + 20) * 1000,
        params: p,
        interruptOn: ['death', 'kicked', 'disconnected']
      })
    }
    if (mode === 'cast') {
      return this.runIntent('portal', async ctl => {
        this.require()
        this.updateMovements()
        const r = await require('../cast').castPortal(this, ctl, p)
        if (!r.built || ctl.aborted) return r
        const lit = await nether.portal(this, ctl, { mode: 'build', timeoutSeconds: 60 })
        return { ...r, lit: !!(lit && lit.lit), light: lit }
      }, {
        timeoutMs: (Math.min(600, p.timeoutSeconds ?? 540) + 90) * 1000,
        params: p,
        interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
      })
    }
    return this.runIntent('portal', ctl => {
      this.require()
      this.updateMovements()
      return nether.portal(this, ctl, p)
    }, {
      timeoutMs: (Math.min(600, p.timeoutSeconds ?? 150) + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
  }

module.exports = { mine, mineSeen, digDown, explore, craft, place, smelt, furnaceTake, tunnel, shelter, surface, recoverLoot, sleepInBed, wakeUp, portal, obsidian, flightRoute, boatHop, parkour }
