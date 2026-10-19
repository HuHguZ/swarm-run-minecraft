'use strict'
// Все RPC-методы демона: фабрики по темам (rpc/*.ts) над одним контекстом. Имя метода объявляется ровно один раз —
// повтор бросает при запуске (простое слияние молча затёрло бы обработчик).
import type { Method, RpcContext } from './context'
import { observationMethods } from './observation'
import { hazardMethods } from './hazards'
import { hazardCoverMethods } from './hazards-cover'
import { aerialMethods } from './aerial'
import { terrainMethods } from './terrain'
import { terrainCoverMethods } from './terrain-cover'
import { swarmMethods } from './swarm'
import { intentMethods } from './intents'
import { worldTruthMethods } from './world-truth'
import { directorMethods } from './director'

function createMethods (ctx: RpcContext): Record<string, Method> {
  const methods: Record<string, Method> = {}
  for (const part of [observationMethods(ctx), hazardMethods(ctx), hazardCoverMethods(ctx), aerialMethods(ctx), terrainMethods(ctx), terrainCoverMethods(ctx), swarmMethods(ctx), intentMethods(ctx), worldTruthMethods(ctx), directorMethods(ctx)]) {
    for (const [name, fn] of Object.entries(part)) {
      if (Object.prototype.hasOwnProperty.call(methods, name)) throw new Error(`RPC: метод ${name} объявлен дважды`)
      methods[name] = fn as Method
    }
  }
  return methods
}

export { createMethods }
