import test from 'node:test'
import assert from 'node:assert/strict'
import { guardFalls } from './arena/map'
import { installSight } from './arena/watch'

test('connected arena bodies receive the driver arena in rescue and wind configuration before the first refresh', async t => {
  const timers = new Map<number, () => void>(), configs: any[] = []
  t.mock.method(globalThis, 'setInterval', (run, ms) => { timers.set(ms, run); return 0 as any })
  const bots = ['NeuroFarm31', 'NeuroFarm31c'].map(name => ({ name, c: { async call(method, params) {
    configs.push({ name, method, params })
    if (method === 'rescue_config' && name === 'NeuroFarm31' && configs.length === 1) throw Error('connection changed')
  } } }))
  const ctx: any = { i: 31, arms: true, X: 600, Y: 120, Z: 600, R: 80,
    L: { y0: -4, half: 80, ellipse: { a: 77, b: 65 } }, bots, names: bots.map(b => b.name), pos: {}, humans: {},
    perches: [], deathAt: {}, alive: () => true, hostile: () => true, rcon() {}, log() {} }
  installSight(ctx)
  await bots[0].c.call('wind_report', {})
  const { y, killY, ...driverArena } = configs.pop().params.arena
  guardFalls(ctx)
  assert.deepEqual(configs.map(c => c.name), bots.map(b => b.name), 'the first native self-wind must not precede installation of the body reflex')
  assert.equal(configs[1].method, 'rescue_config')
  assert.deepEqual(configs[1].params.arena, driverArena, 'the body must score centre shots against the same ellipse origin as the driver')
  assert.deepEqual(configs[1].params, { safe: { x: 600.5, y: 120, z: 600.5 }, killY: 113, arena: { x: 600.5, z: 600.5, r: 80, ellipse: { a: 77, b: 65 } } })
  timers.get(20000)!()
  assert.deepEqual(configs.slice(2), configs.slice(0, 2), 'periodic refresh still configures reconnecting bodies after an initial failure')
})

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
