'use strict'
// Человек в бою (showman.ts): состояние слоя на один бой — опции от pvp.js, нрав, счёт и бывшие let замыкания create
// (его жесты, фаза, стойка, засада, финты, победа). Части слоя получают его первым аргументом.

type Showman = {
  // Опции create (pvp.js).
  bot: any
  session: any
  target: () => any
  observe: (e: any) => any
  style: any
  used: (label: string) => void
  set: (key: string, on: boolean) => void
  aimTo: (kind: string, at?: any) => void
  stopPath: () => void
  tt: any
  stepOk: (key: string) => boolean
  cover: any
  fillerCount: any
  weaponMs: any
  onAirSwing: any
  nearDrop: any
  // Нрав, начало боя, счёт и перезарядки.
  human: boolean
  persona: any
  t0: number
  stats: { showMs: number, tacticMs: number, acts: Record<string, number>, phaseMs: Record<string, number> }
  cds: any
  // Его жесты.
  seen: any
  hits: { took: number[], gave: number[] }
  lastExchange: number
  deathSpot: any
  whiff: any
  mirrored: Record<string, boolean>
  mirror: any
  onCrouch: (e: any) => void
  onSwing: (e: any) => void
  onHurt: (victim: any, source: any) => void
  onDead: (e: any) => void
  onTick: () => void
  // Фаза.
  phase: any
  phaseAt: number
  // Стойка.
  driving: boolean
  lease: number
  posture: any
  engaged: boolean
  lullRolled: boolean
  lastTick: number
  rushSwings: number
  honorRush: any
  circleKey: string
  circleFlipAt: number
  chatSlot: any
  // Засада.
  hide: any
  // steer: финты, отход, паузы.
  bait: any
  baits: number
  bites: number
  baitOff: boolean
  baitRolled: boolean
  retreat: any
  pauseUntil: number
  foeKey: string | null
  pauseRolledAt: number
  lastSteer: number
  // Победа и отчёт.
  victoryDone: boolean
  closed: boolean
}

export type { Showman }
