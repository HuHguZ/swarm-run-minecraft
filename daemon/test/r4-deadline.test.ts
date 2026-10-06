'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { campaign } = require('./r4-harness')
test('route food fight uses remaining step time', async () => {
  const c = campaign(); c.deadline(2500)
  await c.act('fight', { target: '#7', purpose: 'food', timeoutSeconds: 25 })
  assert.equal(c.calls.find(x => x.method === 'fight').params.timeoutSeconds, 1)
})
test('expired route step refuses food fight before RPC', async () => {
  const c = campaign(); c.deadline(999)
  await assert.rejects(c.act('fight', { target: '#7', purpose: 'food' }), /ROUTE_BUDGET/)
  assert.equal(c.calls.filter(x => x.method === 'fight').length, 0)
})
test('defense and surface remain possible after route deadline', async () => {
  const c = campaign(); c.deadline(999)
  await c.act('fight', { target: '#8', purpose: 'defense', timeoutSeconds: 12 })
  await c.act('surface', { timeoutSeconds: 20 })
  assert.equal(c.calls.find(x => x.method === 'fight').params.timeoutSeconds, 12)
})
test('routeGo stops if shore recovery still leaves body in water', async () => {
  const c = campaign({} as Record<string, any>, { inWater: true }); let transitions = 0
  c.hooks({ leaveWater: async () => false, goToward: async () => { transitions++; return true } })
  assert.equal(await c.routeGo({ x: 40, z: 0 }), false)
  assert.equal(transitions, 0)
})
