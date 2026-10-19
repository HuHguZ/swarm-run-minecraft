'use strict'
// Тело бота: класс Session — поля, конструктор, основа (жив ли, состояние, отмена, обёртки намерений). Методы — в частях
// session/*.ts (вход и провода, настройки пути, goto, общение, память, ресурсы, продвижение, снаряжение, бой): они
// подмешиваются в прототип ниже (Object.assign), а их типы — слиянием interface Session с типами частей (PartMethods).
import { stateSummary } from './perception'
import * as playPolicy from './play-policy'
import { skyLightAt } from './session/shared'
import type { PartMethods } from './session/types'
import * as lifecycle from './session/lifecycle'
import * as pathing from './session/pathing'
import * as gotoPart from './session/goto'
import * as interaction from './session/interaction'
import * as memory from './session/memory'
import * as resources from './session/resources'
import * as progression from './session/progression'
import * as equipment from './session/equipment'
import * as combatPart from './session/combat'
// Поля, которых нет в типах библиотек: политика игры на боте (читают items, pack), полуширина тела 1.21.11 в физике,
// цена воды у Movements pathfinder'а, «в лаве» у сущности (ставит физика).
declare module 'mineflayer' {
  interface Bot { ndPlayPolicy?: any }
  interface PhysicsOptions { playerHalfWidth?: number }
}
declare module 'mineflayer-pathfinder' { interface Movements { liquidCost?: number } }
declare module 'prismarine-entity' { interface Entity { isInLava?: boolean } }

// Части-методы сессии: их сигнатуры (без this) становятся методами класса через слияние интерфейса с классом.
export interface Session extends PartMethods<typeof lifecycle>, PartMethods<typeof pathing>, PartMethods<typeof gotoPart>,
  PartMethods<typeof interaction>, PartMethods<typeof memory>, PartMethods<typeof resources>, PartMethods<typeof progression>,
  PartMethods<typeof equipment>, PartMethods<typeof combatPart> {}

// Holds the body. One Session == one bot on one server.
export class Session {
  declare replanRevision: number
  declare tactics: import('./tactics/minecraft').TacticalSystem

  declare cfg: any
  declare bus: any
  declare journal: any
  declare bot: any
  declare mcData: any
  declare current: any
  declare lastHealth: any
  declare connecting: any
  declare playPolicy: any
  declare temper: any
  declare director: any
  declare autopilot: any
  declare bootstrapPaused: boolean
  declare dropSet: any
  declare dropWhy: any
  declare bridgeWanted: any
  declare sprintWanted: any
  declare gotoTarget: any
  declare furnaceLeft: any
  declare shelterBox: any
  declare gotoArena: import('./navigation/parkour').MovementArena | undefined
  declare movementsSignature: any
  declare routeOutpostInfo: any
  declare surfaceWalk: any
  declare scoutFromY: number | null
  declare surfaceStrict: any
  declare pathGoalY: any
  declare movements: any
  declare dropForeign: any
  declare dropRecheck: any
  declare pathNodes: any
  declare dropRecheckSince: any
  declare dropRetryTimer: any
  declare lastPath: any
  declare lastDeath: any
  declare pendingCause: any
  declare respawnNudge: any
  declare ticks: any
  declare steerSaid: any
  declare bagFullSaid: any
  declare pathKeep: any
  declare followGoal: any
  declare reflex: any
  declare crafting: any
  declare eating: any
  declare _prestartIntents: Set<(by?: any) => void> | undefined
  // Ставят снаружи: index.ts (автопилот, режиссёр), rpc и навыки (спасение, враги-люди, автолут, мозг).
  declare _rescue: any
  declare _ndFoes: any
  declare lootAuto: any
  declare brainAttached: any

  constructor (cfg, bus, journal) {
    this.cfg = cfg
    this.bus = bus
    this.journal = journal
    this.bot = null
    this.mcData = null
    this.current = null
    this.lastHealth = 20
    this.connecting = null
    this.bootstrapPaused = false
    this.replanRevision = 0
    this.tactics = new ((require('./tactics/minecraft') as typeof import('./tactics/minecraft')).TacticalSystem)(this)
    this.playPolicy = playPolicy.configure(journal.state?.playPolicy)
    // Характер: как бот отвечает человеку, который его бьёт (autopilot.js
    // provoked). Меняется через mc_temper, живёт до перезапуска демона.
    this.temper = {
      enabled: true,
      firstHitChance: 0.35,
      windowMs: 30000,
      fightSeconds: 90,
      calmAfterMs: 12000,
      retreatAtHealth: 4,
      // Вступаться за игрока рядом, когда его бьёт моб (gestures.js).
      defend: true
    }
  }

  stuckCells = new Map<string, number>()

  underSky () {
    const bot = this.bot
    if (!bot || !bot.entity || !bot.game || bot.game.dimension !== 'overworld') return false
    const s = skyLightAt(bot, bot.entity.position.offset(0, 1.62, 0).floored())
    return s !== null && s >= 12
  }

  // ------------------------------------------------------------------- basics

  alive () {
    return !!(this.bot && this.bot.entity)
  }

  require () {
    if (!this.alive()) throw new Error('бот не в игре — сначала connect')
    return this.bot
  }

  state () {
    return stateSummary(this.bot, {
      goal: this.journal.state.goal,
      playPolicy: this.playPolicy,
      // События читают несколько наблюдателей; смерть не должна потеряться
      // после drain() или перезапуска тела. Журнал сохраняется на диске.
      lastDeathAt: this.journal.state.deaths?.at(-1)?.at || null,
      clock: this.bot?.ndClock?.snapshot() || null,
      // Физических тиков тела (physicsTick): доля от clock.ticks — сколько тиков
      // клиент не успел (часы пропускают их при нехватке CPU), S7 06.10.
      physicsTicks: this.ticks,
      busy: this.current ? this.current.name : null,
      tactics: this.tactics?.snapshot() || null,
      // Своё добро, оставленное в печке прерванной плавкой (containers.takeFurnace).
      ...(this.furnaceLeft ? { furnaceLeft: this.furnaceLeft } : {})
    })
  }

  // ------------------------------------------------------------ intent runner

  // by — кто перебил (имя нового намерения, 'stop'): в журнале «interrupted {type: cancelled, by}» (Codex 15.10: 151 из 282
  // отменённых боёв стенда — 0/0 до первого взмаха, отправитель не был виден). Первая причина (тактика) не затирается.
  cancel (by = 'cancel') {
    for (const cancel of (this as any)._prestartIntents || []) cancel(by)
    ;(require('./reflex-lock') as typeof import('./reflex-lock')).cancel(this)
    this.followGoal = null
    if (this.current) {
      this.current.ctl.interruptedBy ||= { type: 'cancelled', by }
      this.current.ctl.abort()
      this.current = null
    }
    if (this.bot) {
      try { this.bot.pathfinder.setGoal(null) } catch {}
      try { this.bot.clearControlStates() } catch {}
    }
  }

  // event fires (player chat, damage, low health, death, disconnect), or the
  runIntent (name, worker, options: any = {}) {
    return (require('./session/intent-runner') as typeof import('./session/intent-runner')).runIntent.call(this, name, worker, options)
  }

  // Non-blocking action: does not cancel whatever is running.
  async immediate (worker) {
    const result: any = await Promise.resolve()
      .then(() => worker())
      .then(
        detail => ({ status: 'done', detail: detail ?? null }),
        err => ({ status: 'failed', error: String((err && err.message) || err) })
      )
    result.events = this.bus.drain()
    result.state = this.state()
    return result
  }
}

Object.assign(Session.prototype, lifecycle, pathing, gotoPart, interaction, memory, resources, progression, equipment, combatPart)

export { sleep, steerIntoDig } from './session/shared'
export { xyz } from './movement'
export { resultCode } from './session/results'
