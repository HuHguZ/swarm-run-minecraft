import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { swarmCommand } from './swarm/swarm-driver/command'

test('commander forwards explicit climb and budget while ordinary goto keeps its existing defaults', async t => {
  t.mock.method(globalThis, 'setInterval', (() => ({})) as any)
  async function run(order: any) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-command-')), file = path.join(dir, 'orders.json')
    const previous = process.env.SWARM_ORDERS
    fs.writeFileSync(file, JSON.stringify({ bots: { intruder: order } })); process.env.SWARM_ORDERS = file
    try {
      const calls: any[] = [], b = { name: 'intruder', team: 'red', c: { call: async () => ({}) } }, board = { enemies: () => [] }
      const sw: any = { bots: [b], pos: { intruder: { p: { x: 600, y: 128, z: 600 } } }, alive: () => true, log: () => {}, now: () => 1000,
        teamOf: () => 'red', boardOf: () => board, go: async (_b, at, range = 2, seconds = 4) => { calls.push({ at, range, seconds }); return { detail: { arrived: at } } } }
      const command = swarmCommand(sw), task = command.commanded(b, { board })
      assert.equal(await command.commandTurn(b), true)
      return { task, calls }
    } finally {
      if (previous === undefined) delete process.env.SWARM_ORDERS; else process.env.SWARM_ORDERS = previous
      fs.unlinkSync(file); fs.rmdirSync(dir)
    }
  }
  const at = [649.5, 153.5, 555.5]
  const climbing = await run({ do: 'goto', at, range: .8, climbFrom: 144, timeoutSeconds: 10 })
  assert.deepEqual(climbing.task?.position, { x: at[0], y: at[1], z: at[2], climbFrom: 144 })
  assert.deepEqual(climbing.calls, [{ at: climbing.task?.position, range: .8, seconds: 10 }])
  const ordinary = await run({ do: 'goto', at })
  assert.deepEqual(ordinary.calls, [{ at: { x: at[0], y: at[1], z: at[2] }, range: 2, seconds: 4 }])
  for (const invalid of [0, -1, '10', null]) {
    const bad = await run({ do: 'goto', at, climbFrom: '144', timeoutSeconds: invalid })
    assert.equal(bad.calls[0].seconds, 4)
    assert.equal('climbFrom' in bad.calls[0].at, false)
  }
})
