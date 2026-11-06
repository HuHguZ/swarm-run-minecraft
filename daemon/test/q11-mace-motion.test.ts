import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { maceDefenseTurn } from '../src/pvp/turn-mace'
import * as gameClock from '../src/game-clock'
import pick = require('../src/pick')

// Он летит мимо нас справа налево: бежать надо за край будущей досягаемости, а не за текущую спину.
test('mace escape faces away from the moving landing before sprinting, including a wind bounce', async () => {
  const controls: any = {}, bot: any = { entity: { position: new Vec3(.5, 64, .5), yaw: Math.PI / 2, metadata: [] },
    inventory: { slots: Array(46).fill(null), items: () => [] }, entities: {}, food: 20, health: 20,
    blockAt(p) { return { name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' } },
    async look(yaw) { this.entity.yaw = yaw } }
  const threat: any = { kind: 'air', eta: 10, dh: 2, vy: -.4, webTried: true }
  const intent = { name: 'fight', ctl: { aborted: false } }
  const ctx: any = { bot, entity: { username: 'Foe', position: new Vec3(2.5, 76, .5) },
    session: { current: intent }, opts: { maceIntent: intent },
    ctl: { aborted: false }, prof: { player: true }, maceTotem: true, guard: null,
    mc: { threat: () => threat, st: { dodges: 0 } }, track: { vel: () => ({ x: -.8, y: -.4, z: 0 }) },
    pvpSkills: {}, set: (k, v) => { controls[k] = v }, ready: () => false, sleep: async () => {} }
  for (const eta of [10, 36, 37, 24]) {
    threat.eta = eta
    await maceDefenseTurn(ctx, { hp: 20, now: 0, r: 99 } as any)
    assert.equal(ctx.aim, 'point', 'the aim loop must retain the computed escape direction')
    assert.ok(-Math.sin(bot.entity.yaw) > .9, 'sprint away from the projected landing, even toward his current position')
    assert.equal(controls.forward, true)
    assert.equal(controls.sprint, true)
    assert.equal(bot._ndMaceDefense.current, intent, 'the parent intent differs from the child combat controller')
    assert.equal(bot._ndMaceDefense.ctl, ctx.ctl)
  }
  let worn = 0, raised = 0, lowered = 0, wanted = false
  bot.inventory.slots[9] = { name: 'shield' }
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  ctx.guard = { stats: { worn: true }, failure: () => null,
    async wear() { worn++; bot.inventory.slots[45] = { name: 'shield' }; return true },
    traceState: () => ({ want: wanted }),
    raise(up) { if (up) { raised++; wanted = true } else { lowered++; wanted = false } } }
  await maceDefenseTurn(ctx, { hp: 20, now: 0, r: 99 } as any)
  assert.equal(worn, 1, 'a stale worn statistic must not hide the missing offhand shield')
  assert.equal(raised, 1)
  ctx.guard.failure = () => 'shield_cooldown'
  bot._ndShieldDisabledUntil = gameClock.now() + 5000
  await maceDefenseTurn(ctx, { hp: 20, now: 0, r: 99 } as any)
  assert.equal(raised, 1, 'a disabled shield cannot hold a smash: keep escaping')
  assert.equal(ctx.aim, 'point')
  bot._ndShieldDisabledUntil = 0
  await maceDefenseTurn(ctx, { hp: 20, now: 0, r: 99 } as any)
  assert.equal(lowered, 1, 'discard the old failed native use after cooldown')
  assert.equal(raised, 2, 'a sticky observer error must not disable a recovered shield')
  const marker = bot._ndMaceDefense
  ctx.session.current = { name: 'fight', ctl: { aborted: false } }
  await maceDefenseTurn(ctx, { hp: 20, now: 0, r: 99 } as any)
  assert.equal(bot._ndMaceDefense, marker, 'a late continuation cannot acquire a newer intent')
})

test('a mace defence counter requires a held weapon and a live fight', async t => {
  t.mock.method(pick, 'canHit', () => true)
  for (const [item, aborted, expected] of [[undefined, false, 0], ['wind_charge', false, 0], ['iron_sword', true, 0], ['iron_sword', false, 1]] as const) {
    let attacks = 0
    const bot: any = { entity: { position: new Vec3(.5, 64, .5), yaw: 0, metadata: [] },
      heldItem: item ? { name: item } : null, inventory: { slots: Array(46).fill(null), items: () => [] },
      entities: {}, food: 20, attack() { attacks++ }, async look(yaw: number) { this.entity.yaw = yaw },
      blockAt(p: Vec3) { return { name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' } } }
    const ctx: any = { bot, entity: { username: 'Foe', position: new Vec3(1.5, 66, .5) }, ctl: { aborted },
      prof: { player: true }, maceTotem: true, mc: { threat: () => ({ kind: 'air', eta: 2, dh: 1, webTried: true }), st: { dodges: 0, counterHits: 0 } },
      track: { vel: () => ({ x: 0, y: -.6, z: 0 }) }, pvpSkills: {}, set() {}, used() {}, ready: () => false,
      st: { swings: 0 }, nextReady: 0, sleep: async () => {} }
    await maceDefenseTurn(ctx, { hp: 20, now: 1000, r: 2 } as any)
    assert.equal(attacks, expected, item || 'air')
    assert.equal(ctx.mc.st.counterHits, expected)
  }
})
