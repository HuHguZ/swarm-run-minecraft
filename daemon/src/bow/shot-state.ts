'use strict'
// Лук (bow.ts): состояние одного выстрела shoot() — его опции, решатель прицела и общие переменные фаз
// (бывшие let замыкания shoot: фазы натяжения, спуска и слежения за стрелой меняют их через этот объект).
import type { observeCharge } from './charge'

type ShotState = {
  bot: any
  entity: any
  // Опции shoot.
  velFn: any
  onDraw: any
  onSettle: any
  onRelease: any
  onHit: any
  shouldStop: any
  follow: boolean
  mode: string
  point: any
  steep: any
  drawMs: number
  holdWhile: any
  holdMaxMs: number
  traceAim: boolean
  // Выведено до натяжения.
  cancelDraw: () => void
  short: boolean
  speed: number
  targetNow: () => any
  eye: () => any
  charge: ReturnType<typeof observeCharge>
  // Слежение за своим смещением и решатель (trackShot).
  stopTick: () => void
  t0?: number
  holdDeadline?: number
  moved?: { x: number, y: number, z: number }
  myVel?: () => { x: number, y: number, z: number }
  solve?: () => any
  // Общие переменные фаз.
  sent: boolean
  sol?: any
  arrow?: any
  me?: any
  spawnPkt?: any
  hit?: boolean
  releasedAt?: number | null
}

export type { ShotState }
