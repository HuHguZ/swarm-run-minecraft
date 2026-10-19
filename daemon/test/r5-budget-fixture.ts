'use strict'
import { campaignSocket, campaignVm, clockDate, rpcDone } from './campaign-source'
import { withClockFixture } from './clock-fixture'
function fixture (info): Record<string, any> {
  const clock: Record<string, any> = { t: 1000 }; const calls = []; const steps = []; const logs = []
  const state = { health: 20, food: 20, dimension: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: { stone_pickaxe: 1 } }
  const sit = { surface: true, foes: 0, timeOfDay: 1000, inWater: false }
  const socket = campaignSocket((method, params) => { calls.push({ method, params }); return rpcDone(method === 'situation' ? sit : {}, state) })
  const ctx = campaignVm(`
    state = fixtureState; sit = fixtureSit; routeInfoGet = () => fixtureInfo;
    routeStep = async s => { if (s.kind === 'treasure') await act('structure', { timeoutSeconds: 900 }); return step(s) };
    stage = 'route'; module.exports = { run: () => STAGES.find(s => s.name === 'route').run() };
  `, { socket, log: s => logs.push(s), env: { ND_ROUTE: '1', ND_ROUTE_BED: '0' }, date: clockDate(clock), wrap: withClockFixture,
    globals: { fixtureState: state, fixtureSit: sit, fixtureInfo: info,
      step: async s => { steps.push(s.kind); if (s.kind === 'treasure') { clock.t += 181000; return false }; return 'delegate' } } })
  return { ...ctx.module.exports, calls, steps, logs }
}
export { fixture }
