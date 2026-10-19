'use strict'
// Состояние хода главного цикла (campaign/loop.ts), общее для его частей: паузы пустых заходов и их ключ, отметка
// прогресса для сторожа, последний этап, ожидание угрозы в Аду. Создаёт runCampaign; части меняют поля на месте.
export interface CampaignTurn {
  fails: Map<string, any>
  failureKey: (name: string) => string
  cooling: (s: any) => boolean
  failStage: (name: string, key: string) => void
  resetPauses: (why: string) => void
  lastProgressAt: number
  lastStage: string
  netherThreatWaits: number
  threatHp0: number
  threatBurrowAt: number
}

// Чем кончилась часть хода: следующий ход, конец кампании или дальше по ходу.
export type TurnFlow = 'continue' | 'break' | undefined
