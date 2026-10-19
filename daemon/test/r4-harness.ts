'use strict'
import { campaignSocket, campaignVm, clockDate, rpcDone } from './campaign-source'
import { withClockFixture } from './clock-fixture'
function campaign (inventory: any = {} as Record<string, any>, situation: any = {} as Record<string, any>, env: any = {} as Record<string, any>): Record<string, any> {
  const clock = { t: 1000 }
  const calls = []
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory }
  const sit = { surface: true, foes: 0, tod: 1000, ...situation }
  const socket = campaignSocket((method, params) => {
    calls.push({ method, params })
    return rpcDone(method === 'situation' ? sit : {}, state)
  })
  const context = campaignVm(`
    state = fixtureState; sit = fixtureSit;
    module.exports = { act, routeGo, routeHunt, routeStep, castOneAt, routeHealToEnter,
      deadline: t => { stage = 'route'; routeDeadline = t },
      hooks: h => { if (h.goToward) goToward = h.goToward; if (h.leaveWater) leaveWater = h.leaveWater;
        if (h.rest) rest = h.rest; if (h.quickHunt) quickHunt = h.quickHunt; if (h.eatTo) eatTo = h.eatTo;
        if (h.routeInfo) routeInfoGet = () => h.routeInfo; },
      portal: p => { known.portal = p },
    }
  `, { socket, env: { ND_ROUTE: '1', ...env }, date: clockDate(clock), globals: { fixtureState: state, fixtureSit: sit }, wrap: withClockFixture })
  return { ...context.module.exports, clock, calls, state, sit }
}
export { campaign }
