import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { planRounds, shieldRaised, teamLifeStop, damageSources, pairedSummary, fixtureHealth, damageTotals, settleFixtureTeleport } from './swarm/swarm-driver/combo-ab'

test('each causal pair changes only the tested arm, alternates order and mirrors both arms together', () => {
  const rounds = planRounds('axe', 2, 4)
  assert.equal(rounds.length, 8)
  assert.deepEqual(rounds.map(r => r.enhanced), [false, true, true, false, false, true, true, false])
  assert.deepEqual(rounds.map(r => r.side), [1, 1, -1, -1, 1, 1, -1, -1])
  for (let i = 0; i < rounds.length; i += 2) {
    const { enhanced: a, ...left } = rounds[i], { enhanced: b, ...right } = rounds[i + 1]
    assert.notEqual(a, b)
    assert.deepEqual(left, right)
    assert.equal(new Set(left.actors.map(b => b.name)).size, 4)
    assert.equal(left.actors.filter(b => b.team === 'own').length, 2)
    assert.equal(left.actors.filter(b => b.team === 'enemy').length, 2)
  }
  assert.notEqual(rounds[0].seed, rounds[2].seed)
  assert.throws(() => planRounds('axe', 6, 4))
  assert.throws(() => planRounds('axe', 2, 0))
})

test('medic pays with one existing actor and only two own fighters start injured; controls retain the same potion', () => {
  const [control, enhanced] = planRounds('medic', 3, 1)
  assert.equal(control.actors.length, 6)
  assert.equal(control.actors.filter(b => b.hp === 8 && b.team === 'own').length, 2)
  assert.equal(control.actors.filter(b => b.hp !== 20 && b.team === 'enemy').length, 0)
  assert.equal(control.actors.filter(b => b.items.some(i => i.includes('strong_healing'))).length, 1)
  assert.deepEqual(control.actors, enhanced.actors)
  assert.throws(() => planRounds('medic', 2, 1))
  const opening = planRounds('debuff', 3, 1)[0]
  for (const friend of opening.actors.filter(a => a.team === 'own'))
    for (const enemy of opening.actors.filter(a => a.team === 'enemy'))
      assert.ok(Math.hypot(friend.pose[0] - enemy.pose[0], friend.pose[1] - enemy.pose[1]) >= 6)
})

test('axe gate reads observed offhand use and equipment without reading enemy HP', () => {
  const bot = { registry: { entitiesByName: { player: { metadataKeys: ['other', 'living_entity_flags'] } } } }
  const foe: any = { metadata: [0, 3], equipment: [null, { name: 'shield' }] }
  Object.defineProperty(foe, 'health', { get() { throw new Error('enemy HP decision') } })
  assert.equal(shieldRaised(bot, foe), true)
  foe.metadata[1] = 1
  assert.equal(shieldRaised(bot, foe), false)
  foe.metadata[1] = 3; foe.equipment[1] = { name: 'totem_of_undying' }
  assert.equal(shieldRaised(bot, foe), false)
})

test('native death stops only its actor across respawn; neighbours fight until either team is wiped', () => {
  for (const fallen of [[0, 1], [2, 3]]) {
    const bots: any[] = Array.from({ length: 4 }, () => new EventEmitter())
    bots.forEach((b, i) => { b.username = `Actor${i}`; b.clearControlStates = () => { b.cleared = (b.cleared || 0) + 1 }; b.deactivateItem = () => {} })
    const ctl = bots.map(() => ({ aborted: false })), guard = teamLifeStop(bots, ctl, 2)
    bots[fallen[0]].emit('death')
    assert.equal(ctl[fallen[0]].aborted, true)
    assert.equal(ctl[fallen[1]].aborted, false)
    assert.equal(ctl[fallen[0] < 2 ? 2 : 0].aborted, false)
    assert.equal(guard.ended, false)
    assert.equal(guard.alive[fallen[0] < 2 ? 0 : 1].includes(`Actor${fallen[0]}`), false)
    bots[fallen[0]].emit('spawn'); bots[fallen[0]].emit('death')
    assert.equal(ctl[fallen[0]].aborted, true)
    assert.equal(guard.alive[fallen[0] < 2 ? 0 : 1].length, 1)
    bots[fallen[1]].emit('death')
    assert.ok(ctl.every(c => c.aborted))
    assert.equal(guard.ended, true)
    assert.equal(guard.first, fallen[0])
    guard.close()
    assert.ok(bots.every(b => b.listenerCount('death') === 0))
  }
})

test('friendly damage uses native causes and HP loss, leaves ambiguous loss unattributed, and excludes later lives', () => {
  const bot: any = new EventEmitter()
  bot.health = 20; bot.entity = { id: 10 }; bot._client = new EventEmitter()
  const finish = damageSources(bot, [20])
  bot._client.emit('damage_event', { entityId: 10, sourceCauseId: 21 })
  bot.health = 15; bot.emit('health')
  bot._client.emit('damage_event', { entityId: 10, sourceCauseId: 31 })
  bot.health = 11; bot.emit('health')
  bot.health = 9; bot.emit('health')
  bot._client.emit('damage_event', { entityId: 10, sourceCauseId: 31 })
  bot.health = 0; bot.emit('health'); bot.emit('death')
  bot.health = 20; bot.emit('health')
  bot._client.emit('damage_event', { entityId: 10, sourceCauseId: 21 })
  bot.health = 1; bot.emit('health')
  assert.deepEqual(finish(), { friendlyDamage: 5, hostileDamage: 13, unknownDamage: 2, friendlyEvents: 1, hostileEvents: 2 })
})

test('paired summary uses only complete matched pairs and preserves failed kill TTK as null', () => {
  const common = { case: 'axe', size: 2, pair: 0, damage: 10, kills: 0, ownDeaths: 0, ttkMs: null, friendlyDamage: 0, consumed: 0 }
  const summary = pairedSummary([{ ...common, enhanced: false }, { ...common, enhanced: true, damage: 14, kills: 1, ttkMs: 1000 }, { ...common, pair: 1, enhanced: true, damage: 999 }])
  assert.equal(summary.length, 1)
  assert.equal(summary[0].pairs, 1)
  assert.equal(summary[0].delta.damage, 4)
  assert.equal(summary[0].control.meanKillMs, null)
  assert.equal(summary[0].enhanced.meanKillMs, 1000)
})

test('injured fixture bypasses respawn damage immunity, clears healing before restoring normal max HP, and restores max HP on failure', async () => {
  const bot = { username: 'Wounded', health: 20 }, sent: string[] = []
  let maxHealth = 20, healing = false
  const send = async (command: string) => {
    sent.push(command)
    if (command.startsWith('damage ')) return // A respawn immune player ignores ordinary fixture damage.
    if (command === 'attribute Wounded minecraft:max_health base set 8') maxHealth = 8
    if (command === 'effect give Wounded minecraft:instant_health 1 10 true') { healing = true; bot.health = maxHealth }
    if (command === 'effect clear Wounded minecraft:instant_health') healing = false
    if (command === 'attribute Wounded minecraft:max_health base set 20') { maxHealth = 20; if (healing) bot.health = maxHealth }
    return ''
  }
  await fixtureHealth(bot, 8, send)
  assert.equal(bot.health, 8)
  assert.equal(maxHealth, 20)
  assert.equal(healing, false)
  assert.equal(sent.some(c => c.startsWith('damage ')), false)
  const failed: string[] = []
  await assert.rejects(fixtureHealth(bot, 8, async command => { failed.push(command); if (command.startsWith('effect give')) throw new Error('RCON failed'); return '' }), /RCON failed/)
  assert.ok(failed.includes('attribute Wounded minecraft:max_health base set 20'))
})

test('our damage never credits enemy friendly sweep or unattributed enemy HP loss', () => {
  const receipts = [{ damage: 12 }, { damage: 8 }, { damage: 5 }]
  const attributed = [{ friendlyDamage: 1, hostileDamage: 10, unknownDamage: 1 },
    { friendlyDamage: 2, hostileDamage: 6, unknownDamage: 0 }, { friendlyDamage: 0, hostileDamage: 3, unknownDamage: 2 }]
  assert.deepEqual(damageTotals(receipts, attributed, 1), { damage: 9, rawEnemyDamage: 13, enemyFriendlyDamage: 2,
    enemyUnknownDamage: 2, friendlyDamage: 1, unknownDamage: 1 })
})

test('fixture settles a real hop before measurement and releases jump even when ticks fail', async () => {
  const make = (landAt: number) => {
    let tick = 0
    const controls: boolean[] = []
    return { entity: { onGround: true }, controls,
      setControlState(key: string, value: boolean) { assert.equal(key, 'jump'); controls.push(value) },
      async waitForTicks(n: number) { assert.equal(n, 1); this.entity.onGround = ++tick >= landAt } }
  }
  const fast = make(3), slow = make(7)
  await settleFixtureTeleport([fast, slow])
  assert.deepEqual(fast.controls, [true, false]); assert.deepEqual(slow.controls, [true, false])
  assert.equal(slow.entity.onGround, true)
  const stuck = make(Infinity)
  await assert.rejects(settleFixtureTeleport([stuck]), /fixture hop did not land/)
  assert.deepEqual(stuck.controls, [true, false])
  await assert.rejects(settleFixtureTeleport([make(1)]), /fixture hop did not lift/)
  const broken = make(3)
  broken.waitForTicks = async () => { throw new Error('disconnected') }
  await assert.rejects(settleFixtureTeleport([broken]), /disconnected/)
  assert.deepEqual(broken.controls, [true, false])
})
