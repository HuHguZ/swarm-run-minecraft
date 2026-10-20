'use strict'
// Лагерь у спавнера (campSpawner) — состояние лагеря. Прежние `let` и короткие стрелки замыкания campSpawner — поля
// объекта cs (CampState); столб, чашка, лук и спуск — camp/moves.ts, шаги цикла — camp/steps.ts, оркестр — blaze/camp.ts.
import * as gameClock from '../../game-clock'
import { xyz } from '../../movement'
import { countOf, itemNamed } from '../../items'
import { canUseRanged } from '../../play-policy'
import { arrowsHave } from '../targets'

// Высота столба лагеря; кто ещё бывает у спавнера; кто из них бьёт вплотную (прежние const внутри campSpawner).
export const PILLAR = 3
export const OTHER = /^(wither_skeleton|magma_cube|piglin_brute|hoglin|skeleton|zoglin)$/
export const WS = /^(wither_skeleton|piglin_brute|hoglin|zoglin)$/

export interface CampState {
  session: any
  ctl: any
  spawner: any
  want: number
  deadline: number
  dead: Set<any>
  setPhase: (s: string) => void
  p: any
  bot: any
  pick: typeof import('../../pick')
  frLeft: () => number
  base: any
  floorY: number
  out: any
  t0: number
  lastSwing: number
  lastLog: number
  lastAct: number
  post: any
  noShot: Map<any, number>
  swordOf: () => any
  equipSword: () => Promise<void>
  fillers: () => number
  guard: any
  shieldOn: boolean
  shield: (on: any, face?: any) => Promise<void>
  onTop: () => boolean
  bowReady: () => any
  climbFailAt: number
  descWhy: string
  up: boolean
}

// Начало лагеря (прежнее начало campSpawner до первого хода).
export function openCamp (session, ctl, { spawner, want, deadline, dead, setPhase = () => {}, p = {} }: any): CampState {
  const bot = session.bot
  const cs = { session, ctl, spawner, want, deadline, dead, setPhase, p, bot } as CampState
  cs.pick = require('../../pick')
  const { potionOf }: typeof import('../../pvp') = require('../../pvp')
  cs.frLeft = () => bot.inventory.items().filter(i => /potion$/.test(i.name) && /fire_resistance$/.test(potionOf(i) || '')).reduce((n, i) => n + i.count, 0)
  cs.base = bot.entity.position.floored()
  // Помост тронного зала — ноги на высоте спавнера (MonsterThrone: спавнер на помосте). «Наверху» — ноги на +2.6 и выше.
  cs.floorY = spawner ? spawner.y : cs.base.y
  cs.out = { swings: 0, drinks: 0, picks: 0, fights: 0, shots: 0, towers: 0, descents: 0, wsShots: 0, rods0: countOf(bot, 'blaze_rod'), stopped: null, post: xyz(cs.base) }
  cs.t0 = gameClock.now()
  cs.lastSwing = 0
  cs.lastLog = 0
  cs.lastAct = gameClock.now()
  cs.post = cs.base
  cs.noShot = new Map()
  cs.swordOf = () => bot.inventory.items().filter(i => /_sword$/.test(i.name)).sort((a, b) => ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(b.name.split('_')[0]) - ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'].indexOf(a.name.split('_')[0]))[0]
  cs.equipSword = async () => { const sw = cs.swordOf(); if (sw && (!bot.heldItem || bot.heldItem.name !== sw.name)) { try { await bot.equip(sw, 'hand') } catch {} } }
  cs.fillers = () => { try { return (require('../../sealed') as typeof import('../../sealed')).fillerCount(bot) } catch { return 0 } }
  // Щит между взмахами: блейз вплотную бьёт раз в 20 тиков (6, в железе ~3.4 — и под огнестойкостью: удар не огонь;
  // neF-B5f31-1 03.10 — у спавнера 20 → 7 хп ударами за полторы минуты, смерть). Щит к нему, взмах — когда меч готов.
  cs.guard = null
  try { cs.guard = (require('../../combat') as typeof import('../../combat')).makeShield(session, ctl, { shield: 'always' }) } catch {}
  cs.shieldOn = false
  cs.shield = async (on, face = null) => {
    if (!cs.guard) return
    if (on && face) { try { await bot.lookAt(face, true) } catch {} }
    if (on && !cs.shieldOn) { cs.shieldOn = true; try { await cs.guard.raise(true) } catch {} } else if (!on && cs.shieldOn) { cs.shieldOn = false; try { await cs.guard.raise(false) } catch {} }
  }
  cs.onTop = () => bot.entity.position.y >= cs.floorY + PILLAR - 0.4
  cs.bowReady = () => itemNamed(bot, 'bow') && arrowsHave(bot) > 0 && canUseRanged(session, { name: 'blaze' }, p)
  cs.climbFailAt = 0
  cs.descWhy = ''
  return cs
}
