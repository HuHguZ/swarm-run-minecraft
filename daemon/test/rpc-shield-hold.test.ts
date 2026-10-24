import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmMethods } from '../src/rpc/swarm'

test('shield hold RPC keeps draw/smash params and gives its body time to finish', async () => {
  let options
  const session = { runIntent: async (name, body, opts) => { options = opts; return name } }
  const methods = swarmMethods({ session } as any)
  for (const whileThreat of ['whileDraw', 'whileSmash']) {
    const params = { shield: true, requireShield: true, [whileThreat]: 'Foe', seconds: 20 }
    assert.equal(await methods.swarm_hold(params), 'swarm_hold')
    assert.equal(options.params, params, 'reflex locks see the live hold, not empty params')
    assert.ok(options.timeoutMs > 20000, 'RPC watchdog must outlive the world-driven hold')
  }
})
