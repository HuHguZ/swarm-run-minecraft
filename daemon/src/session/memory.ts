'use strict'
import type { Session } from '../session'
import * as playPolicy from '../play-policy'
import * as worlds from '../worlds'
import { xyz } from '../movement'
import { worldsTag } from './shared'

// Посмотреть или поменять характер. Числа проверяются здесь, а не в MCP:
// демон зовут и сцены, мимо схемы.
function setTemper (this: Session, p: any = {}): Promise<any> {
    const t = this.temper
    if (typeof p.enabled === 'boolean') t.enabled = p.enabled
    if (typeof p.firstHitChance === 'number') t.firstHitChance = Math.max(0, Math.min(1, p.firstHitChance))
    if (typeof p.windowSeconds === 'number') t.windowMs = Math.max(5, p.windowSeconds) * 1000
    if (typeof p.fightSeconds === 'number') t.fightSeconds = Math.max(10, Math.min(300, p.fightSeconds))
    if (typeof p.calmSeconds === 'number') t.calmAfterMs = Math.max(3, p.calmSeconds) * 1000
    if (typeof p.retreatAtHealth === 'number') t.retreatAtHealth = Math.max(1, Math.min(19, p.retreatAtHealth))
    if (typeof p.defend === 'boolean') t.defend = p.defend
    return this.immediate(async () => ({
      enabled: t.enabled,
      firstHitChance: t.firstHitChance,
      windowSeconds: t.windowMs / 1000,
      fightSeconds: t.fightSeconds,
      calmSeconds: t.calmAfterMs / 1000,
      retreatAtHealth: t.retreatAtHealth,
      defend: t.defend,
      now: this.current && this.current.name === 'retaliate' ? `дерусь с ${this.current.target}` : null
    }))
}

function setPlayMode (this: Session, p: any = {}): Promise<any> {
    const next = playPolicy.configure(this.playPolicy, p)
    return this.immediate(async () => {
      if (next.mode !== this.playPolicy.mode) {
        this.cancel()
        if (next.mode === 'free') this.director?.stop()
      }
      this.playPolicy = next
      if (this.bot) this.bot.ndPlayPolicy = next
      this.journal.patch(s => { s.playPolicy = next })
      return { playPolicy: next }
    })
}

function setGoal (this: Session, { text }: any): Promise<any> {
    return this.immediate(async () => {
      this.journal.patch(s => { s.goal = text })
      this.journal.append('цель', text, this.bot && this.bot.entity && this.bot.entity.position)
      return { goal: text }
    })
}

function remember (this: Session, { kind = 'заметка', text, place }: any): Promise<any> {
    return this.immediate(async () => {
      const pos = this.bot && this.bot.entity ? this.bot.entity.position : null
      if (place) {
        const here = pos ? worlds.worldOf(this.bot) : null
        const old = (this.journal.state.places || {})[place]
        if (old && here && worlds.worldOfRecord(old) !== here) {
          const there = worldsTag(here)
          throw new Error(`«${place}» уже записано ${worlds.inWorld(worlds.worldOfRecord(old))} — ` +
            `это место ${worlds.inWorld(here)} назову иначе, например «${place} (${there})». Старую запись не трогаю.`)
        }
        this.journal.patch(s => {
          if (!s.places) s.places = {}
          s.places[place] = { ...(s.places[place] || {}), ...xyz(pos), ...(here ? { dimension: here } : {}), note: text }
        })
      }
      this.journal.append(kind, text, pos)
      return { remembered: text, place: place || null }
    })
}

// The death log is the one part of memory that grows without bound, and
function compactState (this: Session): any {
    const s = this.journal.state
    const deaths = Array.isArray(s.deaths) ? s.deaths : []
    const open = deaths.filter(d => !d.recovered)
    const ore = Array.isArray(s.ore) ? s.ore : []
    const kinds = {}
    for (const r of ore) kinds[r.name] = (kinds[r.name] || 0) + 1
    return {
      ...s,
      deaths: {
        всего: deaths.length,
        неразобрано: open.length,
        последние: open.slice(-3).map(d => ({ at: d.at, pos: d.pos }))
      },
      ore: {
        всего: ore.length,
        виды: kinds,
        последние: ore.slice(-3).map(r => ({ name: r.name, at: { x: r.x, y: r.y, z: r.z }, seen: r.seen })),
        как: 'это память о виденном, а не зрение — забрать через mc_mine_seen'
      },
      // Постройки — счёт и последние (весь список — mc_structure mode=list).
      structures: (require('../structures') as typeof import('../structures')).compact(s.structures),
      looted: Array.isArray(s.looted) ? s.looted.length : undefined
    }
}

function recall (this: Session, { lines = 40 }: any = {}): Promise<any> {
    return this.immediate(async () => ({
      state: this.compactState(),
      journal: this.journal.tail(lines)
    }))
}

export { setTemper, setPlayMode, setGoal, remember, compactState, recall }
