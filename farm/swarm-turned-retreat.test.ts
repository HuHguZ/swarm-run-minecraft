import test from 'node:test'
import assert from 'node:assert/strict'
import { createSwarmDriver } from './swarm/swarm-driver'

const point = (x: number) => ({ x, y: 64, z: 0 })
const champion = {
  weapon: 'netherite_sword', weaponEnchanted: true,
  armor: ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'],
  armorEnchanted: [true, true, true, true]
}
const sight = (id: string, x: number, equipment: any = { armor: [] }) => ({
  id, position: point(x), visible: true, equipment
})

function scene(hp: number, cornered = false) {
  let clock = 100_000
  const calls: { method: string; args: any }[] = []
  const bot = (name: string, team: string) => ({ name, team, c: { async call(method: string, args: any) {
    calls.push({ method, args })
    return { status: 'done', detail: method === 'flee' && cornered ? { cornered: true } : { ok: true } }
  } } })
  const blue = [bot('A', 'blue'), ...Array.from({ length: 5 }, (_, i) => bot('B' + i, 'blue'))]
  const red = Array.from({ length: 6 }, (_, i) => bot('R' + i, 'red'))
  const dead = new Set<string>()
  const bots = [...blue, ...red], pos = Object.fromEntries(bots.map((b, i) => [b.name, {
    p: point(i === 0 ? 0 : i < blue.length ? -35 - i : 60 + i),
    hp: i === 0 ? hp : 20, inv: {}, armor: {}, observedAt: clock
  }]))
  const driver = createSwarmDriver({ bots, pos, arms: true, aggressive: false, now: () => clock,
    arena: { x: 0, y: 64, z: 0, r: 100, killY: 55 }, home: () => point(-44),
    alive: name => !dead.has(name), hostile: (_, id) => id.startsWith('R'), log() {} })
  return {
    async turn(observations: any[], radio: any[] = [], dt = 900) {
      clock += dt
      for (const body of Object.values(pos)) body.observedAt = clock
      calls.length = 0
      driver.observe(blue[0], observations)
      if (radio.length) driver.observe(blue[1], radio)
      await driver.turn(blue[0])
      return { task: (blue[0] as any).swarmTask, calls: calls.slice() }
    },
    eliminated(name: string) { dead.add(name); driver.publicDeath(name, null) }
  }
}

for (const same of [false, true]) test('a wounded fighter with a head start flees a visible champion after ' +
    (same ? 'the original pursuer rearms' : 'the original pursuer dies'), async () => {
  const s = scene(6)
  const escape = await s.turn([sight('R0', 8)])
  assert.ok(escape.calls.some(c => c.method === 'flee'))
  const defend = await s.turn([sight('R0', 2)])
  assert.equal(defend.task.data.turned, true)
  assert.ok(defend.calls.some(c => c.method === 'fight' && c.args.target === 'R0'))
  if (!same) s.eliminated('R0')
  const id = same ? 'R0' : 'R1'
  const again = await s.turn([sight(id, 10, champion)])
  assert.equal(again.task.kind, 'flee')
  assert.ok(again.calls.some(c => c.method === 'flee'))
  assert.equal(again.calls.some(c => c.method === 'goto' && c.args.x === 10 || c.method === 'fight'), false)
})

test('a teammate or a name through a wall cannot renew the personal counterattack', async () => {
  for (const tag of [false, true]) {
    const s = scene(20)
    const bow = { weapon: 'bow', armor: [] }
    assert.equal((await s.turn([sight('R0', 8, bow)])).task.kind, 'flee')
    const defend = await s.turn([sight('R0', 2, bow)])
    assert.ok(defend.calls.some(c => c.method === 'fight' && c.args.target === 'R0'))
    const own = tag ? [{ id: 'R0', visible: false, nametag: true, position: point(9) }] : []
    const unseen = await s.turn(own, [sight('R0', 9, bow)], 1500)
    assert.equal(!!unseen.task.data.turned, false)
  }
})

test('direct contact allows the healthy fighter to keep countering its own pursuer', async () => {
  const s = scene(20)
  const bow = { weapon: 'bow', armor: [] }
  await s.turn([sight('R0', 8, bow)])
  const close = await s.turn([sight('R0', 2, bow)])
  assert.ok(close.calls.some(c => c.method === 'fight' && c.args.target === 'R0'))
  const next = await s.turn([sight('R0', 3, bow)])
  assert.equal(next.task.data.turned, true)
  assert.ok(next.calls.some(c => c.method === 'fight' && c.args.target === 'R0'))
  const changed = await s.turn([sight('R0', 10, champion)])
  assert.ok(changed.calls.some(c => c.method === 'flee'))
})

test('an unarmed fighter can still answer after the escape skill finds its exits blocked', async () => {
  const s = scene(6, true)
  const trapped = await s.turn([sight('R0', 2, champion)])
  assert.equal(trapped.task.kind, 'flee')
  const fight = trapped.calls.findIndex(c => c.method === 'fight' && c.args.lastStand && c.args.target === 'R0')
  const flee = trapped.calls.findIndex(c => c.method === 'flee')
  assert.ok(flee >= 0 && fight > flee)
})
