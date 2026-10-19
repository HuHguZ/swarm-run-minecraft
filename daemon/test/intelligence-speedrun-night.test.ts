import test from 'node:test'
import assert from 'node:assert/strict'

import { createOverworldRoute } from '../src/campaign/overworld-route'

test('speedrun mapped route does not craft a bed or leave its work position to sleep', async () => {
  const work: string[] = []
  const route = createOverworldRoute({
    ROUTE_SLEEP: true,
    died: false,
    state: { playPolicy: { mode: 'speedrun' } },
    sit: { night: true, bed: false },
    sense: async () => {},
    dim: () => 'overworld',
    todNow: () => 16000,
    nightNow: () => true,
    have: (pattern: RegExp) => pattern.test('white_wool') ? 3 : 0,
    makeBed: async () => { work.push('craft bed') },
    refresh: async () => {},
    gameClock: { now: () => 60000 },
    routeSleptAt: 0,
    routeLeaveOutpost: async () => { work.push('leave work') },
    rlog: () => {},
    nightGuard: async () => { work.push('sleep') }
  })
  assert.equal(await route.routeSleep('before work'), false)
  assert.deepEqual(work, [])
})
