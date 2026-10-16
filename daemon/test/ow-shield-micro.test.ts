import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorld, stepWorld, hurt } from '../src/tactics/sim-world'
import { mineflayerFacade } from '../src/tactics/sim-mineflayer'
const clock = require('../src/game-clock')
const ow = require('../src/ow-shield')
const threats = require('../src/threats')
const assess = require('../src/assess')

function bowScene(draw: boolean) {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const w = createWorld({ name: 'shield-raise-before-release', seed: 3, ticks: 120, body: { hp: 4, food: 0, armor: 0, shield: true, blocks: 0, knockbackResistance: 1 },
    events: [{ at: 1, type: 'enemy', kind: 'skeleton', distance: 3.6 }] })
  const { bot, sync } = mineflayerFacade(w, {})
  try {
    while (w.tick < 120 && w.body.hp > 0) {
      sync()
      const shots = threats.incoming(bot)
      const g = draw ? ow.rangedGuard(bot, Object.values(bot.entities).filter((e: any) => e.name === 'skeleton'), shots) :
        shots[0] ? { point: shots[0].entity.position } : null
      if (g) {
        const p = bot.entity.position, dx = g.point.x - p.x, dz = g.point.z - p.z, n = Math.hypot(dx, dz)
        w.body.faceX = dx / n; w.body.faceZ = dz / n; w.body.shieldAt = w.tick; w.body.shieldUp++
      } else w.body.shieldUp = 0
      stepWorld(w); c.advanceTicks(1)
    }
    return { hp: w.body.hp, died: w.died, log: w.log }
  } finally { bot.emit('end'); c.dispose() }
}

test('A5 short bow flight is too late for a new five-tick guard, visible draw protects that first shot', () => {
  const late = bowScene(false), early = bowScene(true)
  assert.equal(late.died, 'arrow')
  assert.equal(early.died, null, early.log.join('\n'))
  assert.equal(early.hp, 4)
})

test('A5 shield stops front melee/arrow/explosion at five ticks, with rear and four-tick counterexamples', () => {
  for (const type of ['mob', 'arrow', 'explosion']) for (const [up, face, expected] of [[5, 1, 20], [4, 1, 16], [5, -1, 16]]) {
    const w = createWorld({ name: 'native-shield-boundary', body: { hp: 20, food: 0, armor: 0, shield: true }, events: [] })
    w.body.shieldUp = up; w.body.faceX = face; w.body.faceZ = 0
    hurt(w, 4, type, null, { x: 2, z: 0 })
    assert.equal(w.body.hp, expected, `${type}/${up}/${face}`)
  }
})

test('A5 melee swing receipts open a real twenty-tick counterattack window without reading foe HP/cooldown in policy', () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const w = createWorld({ name: 'zombie-shield-counter', body: { hp: 20, food: 0, armor: 0, shield: true, weapon: 'stone_sword', knockbackResistance: 1 },
    events: [{ at: 1, type: 'enemy', kind: 'zombie', distance: 1.4 }] })
  const { bot, sync } = mineflayerFacade(w, {})
  let lastObservedSwing = 0, nextOwnSwing = 0, swings = 0
  try {
    while (w.tick < 180 && w.body.hp > 0 && (!w.enemies.length || w.enemies[0].hp > 0)) {
      sync(); const e = Object.values(bot.entities).find((e: any) => e.name === 'zombie') as any
      const guard = e && ow.meleeGuard(bot, e, lastObservedSwing)
      if (guard) { w.body.shieldAt = w.tick; w.body.shieldUp++; w.body.faceX = 1; w.body.faceZ = 0 }
      else {
        w.body.shieldUp = 0
        if (e && w.tick >= nextOwnSwing) { w.enemies[0].hp -= assess.afterArmor(5, w.enemies[0].armor, 0); nextOwnSwing = w.tick + 13; swings++ }
      }
      // The harness emits the visible swing when MeleeAttackGoal attempts its attack, including a blocked attempt.
      const previous = w.enemies[0]?.cooldown
      stepWorld(w); c.advanceTicks(1)
      if (w.enemies[0]?.cooldown === 20 && previous !== 20) lastObservedSwing = clock.now()
    }
    assert.ok(swings >= 4)
    assert.ok(w.enemies[0].hp <= 0)
    assert.equal(w.body.hp, 17, 'only the first unannounced arrival hit can land before the physical raise delay')
  } finally { bot.emit('end'); c.dispose() }
})
