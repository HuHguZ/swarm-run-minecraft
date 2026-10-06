import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { speedrunRegistry, dragonGoal } from '../src/core/speedrun'
import { StrategicDirector } from '../src/core/strategy'
import { SimEnvironment } from '../src/environments/sim'
import { SimRpcEnvironment, SimRpcServer } from '../src/environments/sim-rpc'

test('same director runs the simulated graph through a WebSocket port, clock and pending RPC', async () => {
  const registry = speedrunRegistry()
  const server = new SimRpcServer(new SimEnvironment(registry, { deterministic: true }), { port: 0 })
  await server.ready()
  const environment = await SimRpcEnvironment.connect(server.url())
  try {
    const initial = await environment.observe()
    assert.equal(initial.elapsedMs, 0)
    await environment.sleep(150)
    assert.equal(environment.now(), 150)
    await assert.rejects(environment.call('goto', { x: 1 }), /Unsupported simulated RPC/)
    await assert.rejects(environment.call('clock.sleep', { milliseconds: -1 }), /milliseconds/)
    await assert.rejects(environment.call('execute', { skill: 'wood', strategy: 'AcquireWood', params: [] }), /Expected an object/)
    await assert.rejects(environment.call('execute', { skill: 'fight', strategy: 'AcquireWood' }), /mismatched/)
    const director = new StrategicDirector(registry, environment, { goal: dragonGoal })
    let steps = 0
    while (++steps <= 40 && (await director.tick()).stopped !== 'goal') {}
    assert.ok(steps < 40)
    assert.equal(dragonGoal(await environment.observe()), true)
    assert.ok(environment.now() > 150)
    const aborted = new AbortController()
    aborted.abort('test cancellation')
    assert.equal((await environment.execute({ skill: 'wood' }, aborted.signal)).outcome, 'INTERRUPTED')

    const peer = new WebSocket(server.url())
    await new Promise<void>((resolve, reject) => { peer.once('open', resolve); peer.once('error', reject) })
    const messages = new Map<number, (response: { ok: boolean; result?: Record<string, unknown>; error?: string }) => void>()
    peer.on('message', raw => { const response = JSON.parse(raw.toString()); messages.get(response.id)?.(response) })
    const request = (id: number, method: string, params: Record<string, unknown>) => new Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }>(resolve => {
      messages.set(id, resolve)
      peer.send(JSON.stringify({ id, method, params }))
    })
    // Both frames arrive before the deferred simulated skill begins.
    const pending = request(1, 'run', { skill: 'wood', strategy: 'AcquireWood' })
    const stopped = request(2, 'stop', { reason: 'operator stop' })
    const task = (await pending).result!
    assert.equal(task.status, 'pending')
    assert.equal((await stopped).ok, true)
    const completed = (await request(3, 'status', { token: task.token })).result!
    assert.equal(completed.status, 'interrupted')
    assert.equal((completed.detail as Record<string, unknown>).outcome, 'INTERRUPTED')
    peer.close()
  } finally {
    await environment.close()
    await server.close()
  }
})
