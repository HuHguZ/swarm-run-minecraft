'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import { campaign } from './r4-harness'
test('portal heal does not cook or mine for a furnace with raw meat at the frame', async () => {
  const c = campaign({ beef: 3 }); c.state.health = 1; c.state.food = 16
  c.hooks({ rest: async () => {}, eatTo: async () => { c.state.food = 20 } })
  await c.routeHealToEnter()
  assert.equal(c.calls.some(x => /^(mine|dig_down|smelt)$/.test(x.method)), false)
})
test('enter refuses to send a portal RPC if healing did not reach 10 HP', async () => {
  const c = campaign({ bread: 2 }); c.state.health = 1; c.state.food = 20; c.portal({ x: 2, y: 64, z: 0 })
  c.hooks({ rest: async () => {} })
  assert.equal(await c.routeStep({ kind: 'enter' }), false)
  assert.equal(c.calls.some(x => x.method === 'portal'), false)
})
test('ND_ROUTE_ENTERHEAL=0 keeps the legacy handoff after unsuccessful rest', async () => {
  const c = campaign({} as Record<string, any>, {} as Record<string, any>, { ND_ROUTE_ENTERHEAL: '0' }); c.state.health = 1; c.state.food = 20
  c.hooks({ rest: async () => {} })
  assert.equal(await c.routeHealToEnter(), true)
})
