export type RecoveryNode = 'Observe' | 'RecoverWhileMoving' | 'Eat' | 'Drink' | 'CancelOnApproach' | 'PunishOpponentUsing' | 'WaitForWindow'

export interface RecoveryWindow {
  hp: number
  buff: boolean
  desperate: boolean
  consuming: boolean
  drink: boolean
  safe: boolean
  covered: boolean
  grounded: boolean
  flightStable: boolean
  clutchActive: boolean
  moveSafe: boolean
  opponentUsing: boolean
  opponentPunishable: boolean
}

export interface RecoveryDecision {
  node: RecoveryNode
  path: readonly RecoveryNode[]
  reason: string
}

export const recoveryGraph: Readonly<Record<RecoveryNode, readonly RecoveryNode[]>> = {
  Observe: ['CancelOnApproach', 'PunishOpponentUsing', 'WaitForWindow', 'RecoverWhileMoving', 'Eat', 'Drink'],
  RecoverWhileMoving: ['Eat', 'Drink', 'CancelOnApproach', 'PunishOpponentUsing'],
  Eat: ['Observe', 'CancelOnApproach', 'PunishOpponentUsing'],
  Drink: ['Observe', 'CancelOnApproach', 'PunishOpponentUsing'],
  CancelOnApproach: ['Observe'],
  PunishOpponentUsing: ['Observe'],
  WaitForWindow: ['Observe']
}

export function recoveryDecision(window: RecoveryWindow): RecoveryDecision {
  const stop = (reason: string): RecoveryDecision => ({ node: window.consuming ? 'CancelOnApproach' : 'WaitForWindow', path: ['Observe', window.consuming ? 'CancelOnApproach' : 'WaitForWindow'], reason })
  if (window.clutchActive) return stop('рука нужна для спасения от падения')
  if (!window.grounded && !window.flightStable) return stop('падение или неустойчивый полёт')
  if (!window.desperate && !window.covered && (window.buff || window.hp >= 12) && window.opponentUsing && window.opponentPunishable) {
    return { node: 'PunishOpponentUsing', path: ['Observe', 'PunishOpponentUsing'], reason: 'успеваем ударить до конца чужого глотка' }
  }
  if (!window.safe && !window.desperate) return stop('противник успеет сблизиться или попасть')
  const node = window.drink ? 'Drink' : 'Eat'
  const moving = !window.covered && window.grounded && window.moveSafe
  return { node, path: moving ? ['Observe', 'RecoverWhileMoving', node] : ['Observe', node], reason: moving ? 'лечимся на безопасном отходе' : 'безопасное окно лечения' }
}
