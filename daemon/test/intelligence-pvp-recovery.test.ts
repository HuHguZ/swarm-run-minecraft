import test from 'node:test'
import assert from 'node:assert/strict'
import { recoveryDecision, type RecoveryWindow } from '../src/pvp/recovery-graph'
import { consumeHand } from '../src/pvp/hand-policy'
import { createRecovery } from '../src/pvp/recovery'
import { counterattackAfterFailedEscape } from '../src/pvp/last-stand'

const window: RecoveryWindow = { hp: 15, buff: false, desperate: false, consuming: false, drink: false,
  safe: true, covered: false, grounded: true, flightStable: false, clutchActive: false,
  moveSafe: true, opponentUsing: false, opponentPunishable: false }

test('recovery graph moves while eating, cancels approach and punishes an opponent drinking', () => {
  assert.deepEqual(recoveryDecision(window).path, ['Observe', 'RecoverWhileMoving', 'Eat'])
  assert.equal(recoveryDecision({ ...window, consuming: true, safe: false }).node, 'CancelOnApproach')
  assert.equal(recoveryDecision({ ...window, opponentUsing: true, opponentPunishable: true }).node, 'PunishOpponentUsing')
  assert.equal(recoveryDecision({ ...window, buff: true, opponentUsing: true, opponentPunishable: false }).node, 'Eat')
  assert.equal(recoveryDecision({ ...window, clutchActive: true }).node, 'WaitForWindow')
  assert.equal(recoveryDecision({ ...window, grounded: false }).node, 'WaitForWindow')
})

function recoveryFixture(approachAt = Infinity) {
  let now = 0
  let activatedAt = Infinity
  const apple = { name: 'golden_apple', count: 2, slot: 10 }
  const shield = { name: 'shield', count: 1, slot: 45 }
  const sword = { name: 'diamond_sword', count: 1, slot: 36 }
  let storedShield = shield
  const slots: any[] = []
  slots[45] = shield
  const controls: Record<string, boolean> = {}
  const packets: boolean[] = []
  const movements: string[] = []
  let cancelled = false
  const position = { offset: () => position }
  const bot = { entity: { onGround: true, position }, health: 15,
    heldItem: sword, inventory: { slots, items: () => [apple, storedShield, sword] }, controlState: controls,
    async equip(item, hand) {
      if (hand === 'off-hand') {
        if (item.name === 'golden_apple') storedShield = { ...shield, slot: 9 }
        if (item.name === 'shield' && item.slot !== storedShield.slot) throw Error('stale equipment slot')
        slots[45] = item
      } else this.heldItem = item
    },
    activateItem(offhand) { packets.push(offhand); activatedAt = now },
    deactivateItem() { cancelled = true; activatedAt = Infinity }
  }
  const ctx: Record<string, any> = {
    bot, entity: { position }, prof: { player: true }, ctl: { aborted: false }, session: {},
    EYE: 1.62, gameClock: { now: () => now }, edges: { falling: () => false }, FIX: true,
    st: { healed: [], eatPunish: { swaps: 0 } },
    tt: { safe: () => ({ ok: now < approachAt }), guard: () => () => now >= approachAt,
      stats: { refused: 0, aborted: 0 }, state: () => ({}), noteConsume() {} },
    tempo: { ON: true, consumeMs: () => 1600 }, fortSealed: () => false, reachFrom: () => 10,
    countOf: (_bot, name) => name === apple.name ? apple.count : 1,
    stepSafe: () => true, keyDir: (_bot, key) => key, maceNow: () => false,
    set: (key, value) => { controls[key] = value; if (value) movements.push(key) },
    used() {}, punishable: () => null,
    async sleep(ms) { now += ms; if (now - activatedAt >= 1600) { apple.count--; activatedAt = Infinity } },
    async holdItem(item) { bot.heldItem = item; return true }
  }
  const recovery = createRecovery(ctx)
  ctx.eatHeld = recovery.eatHeld
  return { recovery, ctx, bot, apple, shield, sword, packets, movements, cancelled: () => cancelled }
}

test('offhand recovery keeps weapon, emits offhand activation, moves and restores shield', async () => {
  assert.equal(consumeHand({ main: 'diamond_sword', off: 'shield', safe: true, grounded: true,
    clutchActive: false, shieldNeeded: false, totemNeeded: false }), 'off-hand')
  assert.equal(consumeHand({ main: 'bow', off: null, safe: true, grounded: true,
    clutchActive: false, shieldNeeded: false, totemNeeded: false }), 'hand')
  assert.equal(consumeHand({ main: 'diamond_sword', off: 'shield', safe: true, grounded: false, flightStable: true,
    clutchActive: false, shieldNeeded: false, totemNeeded: false }), 'off-hand')
  assert.equal(consumeHand({ main: 'diamond_sword', off: 'shield', safe: true, grounded: false, flightStable: true, diveActive: true,
    clutchActive: false, shieldNeeded: false, totemNeeded: false }), null)
  assert.equal(consumeHand({ main: 'iron_spear', off: null, safe: true, grounded: true, usingMain: true,
    clutchActive: false, shieldNeeded: false, totemNeeded: false }), null)
  const f = recoveryFixture()
  assert.equal(await f.recovery.consumeItem(f.apple), true)
  assert.deepEqual(f.packets, [true])
  assert.equal(f.bot.heldItem, f.sword)
  assert.equal(f.bot.inventory.slots[45].name, f.shield.name)
  assert.equal(f.bot.inventory.slots[45].slot, 9)
  assert.ok(f.movements.includes('back'))
  assert.equal(f.bot.controlState.back, false)
  assert.equal(f.ctx.session.eating, false)
})

test('approach interrupts offhand food without consuming stack or losing shield', async () => {
  const f = recoveryFixture(400)
  assert.equal(await f.recovery.consumeItem(f.apple), false)
  assert.equal(f.apple.count, 2)
  assert.equal(f.cancelled(), true)
  assert.equal(f.bot.inventory.slots[45].name, f.shield.name)
  assert.equal(f.ctx.session.eating, false)
})

test('a blocked escape switches to counterattack only with a live visible reachable attacker', () => {
  const corner = { alive: true, interrupted: false, clear: false, hazardous: false, targetVisible: true, targetReach: 2, moved: .1 }
  assert.equal(counterattackAfterFailedEscape(corner), true)
  for (const change of [{ clear: true }, { targetVisible: false }, { targetReach: 9 }, { moved: 4 },
    { alive: false }, { interrupted: true }, { hazardous: true }]) {
    assert.equal(counterattackAfterFailedEscape({ ...corner, ...change }), false)
  }
})
