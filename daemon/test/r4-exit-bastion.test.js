'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const bastion = require('../src/bastion')
const bot = bag => ({ inventory: { items: () => Object.entries(bag).map(([name, count]) => ({ name, count })) } })

function env (t, name, value) {
  const before = process.env[name]
  process.env[name] = value
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before })
}

for (const flow of ['0', '1']) test(`bastion exit reserve with ND_BARTER_FLOW=${flow}: ordinary obsidian and ignition`, t => {
  env(t, 'ND_BARTER_FLOW', flow)
  env(t, 'ND_EXIT_KIT', '1')
  assert.equal(bastion.exitReserveReady(bot({ obsidian: 9, crying_obsidian: 64, flint_and_steel: 1 }), { obsidian: 10 }), false)
  assert.equal(bastion.exitReserveReady(bot({ obsidian: 10 }), { obsidian: 10 }), false)
  assert.equal(bastion.exitReserveReady(bot({ obsidian: 10, fire_charge: 1 }), { obsidian: 10 }), true)
  assert.equal(bastion.exitReserveReady(bot({ obsidian: 10, flint_and_steel: 1 }), { obsidian: 10 }), true)
  assert.equal(bastion.exitReserveReady(bot({}), {}), true, 'calls without an exit goal retain their contract')
})

test('ND_EXIT_KIT=0 disables the additional bastion exit reserve', t => {
  env(t, 'ND_EXIT_KIT', '0')
  assert.equal(bastion.exitReserveReady(bot({}), { obsidian: 10 }), true)
})

test('r4 exit export preserves the applied barter and reflex entry points', () => {
  assert.equal(typeof bastion.exitReserveReady, 'function')
  assert.equal(typeof bastion.moveBarterSite, 'function')
  assert.equal(typeof bastion.handNoWalk, 'function')
})
