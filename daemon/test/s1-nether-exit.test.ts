import { campaignSocket, campaignVm, rpcDone } from './campaign-source'
import test = require('node:test')
import assert = require('node:assert/strict')
import { withClockFixture } from './clock-fixture'

// Выход из Ада без записи «портал (ад)» (вход прерван тактикой — s1-post08 06.10): идти к x/8, z/8 портала верхнего мира.
function exitFixture() {
  const state = { health: 20, food: 20, dimension: 'the_nether', pos: { x: 106, y: 69, z: -151 },
    armor: {}, potions: {}, inventory: { ender_eye: 10, cooked_beef: 12 } as Record<string, number> }
  const requests: Array<{ method: string; params: Record<string, any> }> = []
  const socket = campaignSocket((method, params) => {
    requests.push({ method, params })
    return rpcDone(method === 'situation' ? { surface: false, foes: 0 } : {}, state)
  })
  const context = campaignVm(`
    state = fixtureState; sit = { surface: false, foes: 0 };
    known.portal = { x: 236, y: 68, z: 170, dimension: 'overworld' };
    known.netherPortal = null;
    module.exports = { leave: returnFromNether };
  `, { socket, env: { ND_NE_ROUTE: '1' }, wrap: withClockFixture, globals: { AbortController, fixtureState: state } })
  return { context, requests }
}

test('leaving the Nether without a recorded arrival portal routes to the overworld portal divided by eight', async () => {
  const { context, requests } = exitFixture()
  await context.module.exports.leave()
  const route = requests.find(r => r.method === 'ne_route')
  assert.ok(route, 'a route toward the linked portal is attempted before portal enter')
  assert.equal(route!.params.x, 30)
  assert.equal(route!.params.z, 21)
  const portal = requests.findIndex(r => r.method === 'portal')
  assert.ok(portal === -1 || requests.findIndex(r => r.method === 'ne_route') < portal, 'portal enter only after the route')
})
