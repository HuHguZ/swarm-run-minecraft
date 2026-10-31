import test from 'node:test'
import assert from 'node:assert/strict'
import { guardFalls } from './arena/map'

for (const [Y, y0] of [[120, -4], [90, -8]]) test(`the arena death volume ends at the plane advertised to rescue (${Y}, ${y0})`, t => {
  const timers = new Map<number, () => void>(), commands: string[] = [], configs: any[] = []
  t.mock.method(globalThis, 'setInterval', (run, ms) => { timers.set(ms, run); return 0 as any })
  const ctx: any = { i: 31, arms: true, X: 600, Y, Z: 600, L: { y0, half: 80 },
    bots: [{ name: 'NeuroFarm31', c: { async call(method, params) { configs.push({ method, params }) } } }],
    async rcon(slot, command) { assert.equal(slot, 31); commands.push(command) } }
  guardFalls(ctx)
  timers.get(20000)!(); timers.get(1000)!()
  const killY = configs.find(c => c.method === 'rescue_config').params.killY
  const command = commands.find(c => c.startsWith('kill @a['))!
  const y = Number(command.match(/(?:\[|,)y=([^,\]]+)/)![1]), dy = Number(command.match(/(?:\[|,)dy=([^,\]]+)/)![1])
  // EntitySelectorParser.createAabb, jar1.21.11: a positive extent's upper face is dy+1.
  const upperFace = y + dy + 1
  assert.equal(upperFace, killY, 'a glider above its known death plane must remain eligible for rescue')
  assert.equal(killY + .8 < upperFace, false, 'GC31h at plane+.8 must not be killed by this selector')
  assert.equal(killY - .1 < upperFace, true)
  ctx.between = true; commands.length = 0; timers.get(1000)!()
  assert.equal(commands.length, 0, 'the inter-round guard still cannot kill actors')
})

test('classic arena has no artificial death plane or rescue interval', t => {
  t.mock.method(globalThis, 'setInterval', () => { throw Error('no timers outside arms') })
  assert.deepEqual(guardFalls({ arms: false } as any), { rescueT: null, fallT: null })
})
