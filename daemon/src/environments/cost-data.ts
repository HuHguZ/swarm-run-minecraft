import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CostModel } from '../core/cost-model'

export function loadCosts(filename = process.env.ND_STRATEGY_COSTS ?? resolve(__dirname, '../../strategy-costs.json')): CostModel[] {
  if (filename === '0' || !existsSync(filename)) return []
  const value: unknown = JSON.parse(readFileSync(filename, 'utf8'))
  const models = value && typeof value === 'object' && 'models' in value ? value.models : value
  if (!Array.isArray(models)) throw new Error('Strategy costs must contain a models array')
  for (const model of models) {
    if (!model || typeof model.key !== 'string' || ![model.samples, model.successes, model.deaths, model.medianTicks, model.p90Ticks].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || model.samples < model.successes + model.deaths) throw new Error('Invalid strategy cost model')
    if (model.deathSamples !== undefined && (!Number.isInteger(model.deathSamples) || model.deathSamples < model.deaths || model.deathSamples > model.samples)) throw new Error('Invalid mortality sample count')
  }
  return models as CostModel[]
}
