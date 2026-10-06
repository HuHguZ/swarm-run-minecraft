import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyWorld, knows, amount } from '../src/core/world-state'
import { StrategyRegistry, StrategicDirector, type Strategy, type DecisionRecord } from '../src/core/strategy'
import type { Environment, ExecutionResult } from '../src/core/environment'

const goal = (s: ReturnType<typeof emptyWorld>) => knows(s, 'done')
function milestone(id: string, extra: Partial<Strategy> = {}): Strategy {
  return { id, skill: id, version: 1, preconditions: s => !knows(s, 'done'), expectedEffects: { facts: { done: true } }, estimateCost: () => 100,
    estimateRisk: () => 0, timeoutMs: 600000, successCondition: (_b, a) => knows(a, 'done'), ...extra }
}
function env(action: (state: ReturnType<typeof emptyWorld>) => ExecutionResult) {
  const state = emptyWorld()
  let calls = 0
  const environment: Environment & { calls: () => number } = {
    observe: async () => state, execute: async () => { calls++; return action(state) }, cancel: async () => undefined,
    now: () => state.elapsedMs, sleep: async ms => { state.elapsedMs += ms }, calls: () => calls
  }
  return { state, environment }
}

test('an exhausted strategy without retryCondition returns after game-time backoff that doubles per round', async () => {
  const { state, environment } = env(() => ({ outcome: 'FAILURE', events: [] }))
  const director = new StrategicDirector(new StrategyRegistry().register(milestone('rods')), environment, { goal, retryAfterMs: 60000 })
  await director.tick(); await director.tick()
  assert.equal(director.decide(state).reason, 'unreachable')
  assert.equal(director.nextRetryAt(), 60000)
  state.elapsedMs = 59999
  assert.equal(director.decide(state).reason, 'unreachable')
  state.elapsedMs = 60000
  assert.equal(director.decide(state).steps[0]?.id, 'rods', 're-admitted after one backoff')
  await director.tick(); await director.tick()
  assert.equal(director.decide(state).reason, 'unreachable')
  assert.equal(director.nextRetryAt(), 60000 + 120000, 'second round waits twice as long')
})

test('progress by another strategy re-admits an exhausted one for two rounds only, then time alone decides', async () => {
  const { state, environment } = env(() => ({ outcome: 'FAILURE', events: [] }))
  const helper: Strategy = { ...milestone('helper'), preconditions: s => amount(s, 'wood') < 5, expectedEffects: { resources: { wood: 1 } },
    successCondition: (b, a) => amount(a, 'wood') > amount(b, 'wood') }
  const registry = new StrategyRegistry().register(milestone('blocked')).register(helper)
  const director = new StrategicDirector(registry, environment, { goal, retryAfterMs: 3600000 })
  const fail = async () => { await director.run(registry.get('blocked')!); await director.run(registry.get('blocked')!) }
  const progress = async () => { environment.execute = async () => { state.resources.wood = amount(state, 'wood') + 1; return { outcome: 'SUCCESS', events: [] } }
    assert.equal((await director.run(registry.get('helper')!)).outcome, 'SUCCESS')
    environment.execute = async () => ({ outcome: 'FAILURE', events: [] }) }
  for (let round = 1; round <= 2; round++) {
    await fail()
    assert.equal(director.canRun(registry.get('blocked')!, state), false)
    await progress()
    director.decide(state)
    assert.equal(director.canRun(registry.get('blocked')!, state), true, `round ${round}: progress re-admits`)
  }
  await fail(); await progress(); director.decide(state)
  assert.equal(director.canRun(registry.get('blocked')!, state), false, 'third round needs the time backoff')
})

test('explicit retryCondition stays authoritative over the generic time backoff', async () => {
  const { state, environment } = env(() => ({ outcome: 'FAILURE', events: [] }))
  const site = milestone('site', { retryCondition: (failed, current) => amount(current, 'gold') > amount(failed, 'gold') })
  const director = new StrategicDirector(new StrategyRegistry().register(site), environment, { goal, retryAfterMs: 1000 })
  await director.tick(); await director.tick()
  state.elapsedMs += 3600000
  assert.equal(director.decide(state).reason, 'unreachable')
  assert.equal(director.nextRetryAt(), null)
  state.resources.gold = 9
  assert.equal(director.decide(state).steps[0]?.id, 'site')
})

test('a skill interrupted every time without progress becomes a FAILURE instead of restarting forever', async () => {
  const records: DecisionRecord[] = []
  const { state, environment } = env(s => { s.revision++; return { outcome: 'INTERRUPTED', reason: 'tactical', events: [{ type: 'tactical_released' }] } })
  const director = new StrategicDirector(new StrategyRegistry().register(milestone('bastion')), environment, { goal, record: r => records.push(r) })
  const outcomes: string[] = []
  for (let i = 0; i < 12; i++) {
    const turn = await director.tick()
    if (turn.stopped) { outcomes.push(turn.stopped); break }
    outcomes.push(turn.outcome!)
  }
  assert.deepEqual(outcomes, ['INTERRUPTED', 'INTERRUPTED', 'FAILURE', 'INTERRUPTED', 'INTERRUPTED', 'FAILURE', 'unreachable'])
  assert.equal(records.filter(r => r.level === 'strategy' && r.outcome === 'FAILURE')[0]?.reason, 'interrupted 3 times without progress')
  assert.equal(state.revision, 6)
})

test('interruptions that still make progress never count toward the loop guard', async () => {
  const { state, environment } = env(s => { s.revision++; s.resources.gold = amount(s, 'gold') + 9; return { outcome: 'INTERRUPTED', events: [] } })
  const director = new StrategicDirector(new StrategyRegistry().register(milestone('dig')), environment, { goal })
  for (let i = 0; i < 6; i++) assert.equal((await director.tick()).outcome, 'INTERRUPTED')
  assert.equal(amount(state, 'gold'), 54)
})

test('strategy telemetry marks a death so cost import can count mortality', async () => {
  const records: DecisionRecord[] = []
  const { environment } = env(s => { s.alive = false; s.health = 0; return { outcome: 'FAILURE', events: [{ type: 'death' }] } })
  const director = new StrategicDirector(new StrategyRegistry().register(milestone('lava')), environment, { goal, record: r => records.push(r) })
  assert.equal((await director.tick()).outcome, 'FAILURE')
  assert.equal(records.find(r => r.level === 'strategy')?.death, true)
})
