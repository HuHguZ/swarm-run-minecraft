'use strict'
import type { Session } from '../session'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
import { goals } from 'mineflayer-pathfinder'
import { observe } from '../perception'
import * as social from '../social'
import { escort } from '../escort'
import handover = require('../handover')
import { sleep } from './shared'

function say (this: Session, text, to = null): Promise<any> {
    return this.immediate(async () => {
      const bot = this.require()
      const body = String(text).slice(0, 250)
      if (to) bot.whisper(String(to), body)
      else bot.chat(body)
      this.journal.append('чат', `<${bot.username}> ${text}`, bot.entity.position)
      return { said: text }
    })
}

// Sets a persistent follow goal and returns straight away. Block afterwards
// with wait() so the follow keeps running while we listen for events.
function follow (this: Session, { player, distance = 3 }: any): Promise<any> {
    this.cancel()
    return this.immediate(async () => {
      const bot = this.require()
      this.updateMovements()
      const target = bot.players[player] && bot.players[player].entity
      if (!target) throw new Error(`не вижу игрока ${player} рядом`)
      bot.pathfinder.setGoal(new goals.GoalFollow(target, distance), true)
      // and therefore does not cancel it — that is the whole follow+wait pattern,
      this.followGoal = { player, distance }
      return { following: player, distance }
    })
}

function stop (this: Session): Promise<any> {
    return this.immediate(async () => {
      this.cancel('stop')
      return { stopped: true }
    })
}

// Idle: block until something interrupts or the timeout expires. Does not
// touch an active follow goal.
function wait (this: Session, { seconds = 30, holdPosition = false }: { seconds?: number; holdPosition?: boolean }): Promise<any> {
    if (typeof holdPosition !== 'boolean') throw new TypeError('holdPosition must be boolean')
    const s = Math.max(1, Math.min(300, seconds))
    return this.runIntent(holdPosition ? 'hold_position' : 'wait', async (ctl) => {
      if (holdPosition) { const bot = this.require(); bot.pathfinder.setGoal(null); bot.clearControlStates() }
      await sleep(s * 1000, ctl)
      return { waited: s }
      // Ожидание слышит и жесты людей (gestures.js): присед, взгляд в упор,
      // брошенную вещь — живой игрок на них отвечает, а не спит дальше.
    }, { exclusive: holdPosition, timeoutMs: (s + 5) * 1000, interruptOn: [...(require('../events') as typeof import('../events')).WAKES] })
}

// Raw turn, no result envelope — used by vision before taking a shot so the
// buffered events are not drained into a throwaway response.
async function turnTo (this: Session, { x, y, z }: any): Promise<void> {
    const bot = this.require()
    await bot.lookAt(new Vec3(x, y, z), true)
}

function lookAt (this: Session, { x, y, z }: any): Promise<any> {
    return this.immediate(async () => {
      await this.turnTo({ x, y, z })
      return { lookingAt: { x, y, z } }
    })
}

function observeIntent (this: Session, { radius = 24, fair }: any = {}): Promise<any> {
    return this.immediate(async () => {
      const bot = this.require()
      const useFair = fair === undefined ? this.cfg.fairPlay : !!fair
      const result = observe(bot, this.mcData, { radius, fair: useFair })
      this.tactics?.observed()
      return { ...result, tactics: this.tactics?.snapshot() || null }
    })
}

function players (this: Session, p: any = {}): Promise<any> {
    return this.immediate(async () => {
      this.require()
      return social.players(this, p)
    })
}

function escortIntent (this: Session, p: any = {}): Promise<any> {
    return this.runIntent('escort', ctl => {
      this.require()
      this.updateMovements()
      return escort(this, ctl, p)
    }, {
      timeoutMs: (Math.min(300, p.forSeconds ?? 60) + 20) * 1000,
      params: p,
      interruptOn: ['chat', 'low_health', 'death', 'kicked', 'disconnected']
    })
}

function giveItem (this: Session, p: any = {}): Promise<any> {
    return this.runIntent('give', ctl => {
      this.require()
      this.updateMovements()
      return handover.give(this, ctl, p)
    }, {
      timeoutMs: (Math.min(180, p.timeoutSeconds ?? 60) + 20) * 1000,
      interruptOn: ['low_health', 'death', 'kicked', 'disconnected']
    })
}

function takeItem (this: Session, p: any = {}): Promise<any> {
    return this.runIntent('take', ctl => {
      this.require()
      this.updateMovements()
      return handover.take(this, ctl, p)
    }, {
      timeoutMs: (Math.min(120, p.timeoutSeconds ?? 25) + 20) * 1000,
      interruptOn: ['low_health', 'death', 'kicked', 'disconnected']
    })
}

export { say, follow, stop, wait, turnTo, lookAt, observeIntent as observe, players, escortIntent as escort, giveItem, takeItem }
