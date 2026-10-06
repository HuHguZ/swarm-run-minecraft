import type { WorldState } from './world-state'

export type SkillOutcome = 'SUCCESS' | 'FAILURE' | 'INTERRUPTED' | 'TIMEOUT' | 'PARTIAL'
export interface EnvironmentEvent { type: string; reason?: string; [key: string]: unknown }
export interface SkillCommand { skill: string; params?: Record<string, unknown>; strategy?: string }
export interface ExecutionResult {
  outcome: SkillOutcome
  reason?: string
  events: EnvironmentEvent[]
  detail?: Record<string, unknown>
}
export interface Environment {
  observe(): Promise<WorldState>
  execute(command: SkillCommand, signal: AbortSignal): Promise<ExecutionResult>
  cancel(reason: string): Promise<void>
  now(): number
  sleep(milliseconds: number): Promise<void>
}
