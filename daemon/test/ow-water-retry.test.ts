import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { Vec3 } from 'vec3'
import { bodySource } from './source-fixture'
import { cjsContext } from './cjs-context'
import { runIntent } from '../src/session/intent-runner'
import { EventBus } from '../src/events'

function fixture({ enabled = true, mode = 'tactical', wet = true, refusal = null as string | null,
  status = 'success', throwPrepare = false } = {}) {
  const file = path.join(__dirname, '../src/session/goto.ts'), realRequire = createRequire(file)
  const records: any[] = [], scopes: any[] = [], starts: any[] = [], stops: any[] = [], refusals: any[] = []
  const calls = { paths: 0, unstick: 0, observations: 0, clears: 0, prepareSawScope: false }
  let pending: Promise<any>, entered: () => void
  let releasePath = () => {}
  const ready = new Promise<void>(resolve => { entered = resolve })
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(3.5, 61, 4.5), isInWater: wet, onGround: !wet },
    game: { dimension: 'overworld' }, inventory: { slots: [], items: () => [] },
    health: 20, food: 20, entities: {},
    clearControlStates() { calls.clears++ },
    pathfinder: { goal: null, movements: { canDig: true, scafoldingBlocks: [] }, thinkTimeout: 40,
      setGoal(goal) { this.goal = goal },
      goto(goal) {
        calls.paths++; this.goal = goal
        const route = [{ x: 3, y: 61, z: 4 }, { x: 4, y: 60, z: 4 }, { x: 5, y: 60, z: 4 }]
        let reject, watchdog
        const request: any = new Promise((resolve, fail) => { reject = fail
          if (mode === 'wait') watchdog = setTimeout(() => fail(new Error('test path kept executing instead of changing approach')), 50)
          setImmediate(() => {
            bot.emit('physicsTick')
            bot.emit('path_update', { status, path: route })
            entered()
            if (mode === 'arrive') {
              bot.entity.position = new Vec3(goal.x + .5, goal.y ?? 61, goal.z + .5)
              resolve(undefined)
            } else if (mode !== 'wait') {
              const ctl = session.current.ctl
              ctl.interruptedBy = mode.startsWith('tactical') ? { type: 'tactical', threatLevel: 2 } : { type: 'cancelled', by: 'stop' }
              ctl.abort()
            }
          })
        })
        releasePath = () => { if (watchdog) clearTimeout(watchdog); reject(new Error('goal changed')) }
        request.cancel = () => { if (mode !== 'tactical-stalled') releasePath() }
        return request
      }
    }
  })
  const helpers = {
    startWaterRoute(_bot, target) {
      starts.push(target)
      if (!enabled) return null
      const scope: any = { target, previous: bot._ndOwWaterRoute,
        observe: () => { calls.observations++ } }
      bot._ndOwWaterRoute = scope; scopes.push(scope); bot.on('physicsTick', scope.observe)
      return scope
    },
    recordWaterRouteFailure(_bot, scope, by) {
      records.push({ scope, by: { ...by }, water: bot.entity.isInWater,
        active: bot._ndOwWaterRoute === scope, surface: !!bot._ndOwSurfaceWalk,
        surfaceWalk: session.surfaceWalk, goalY: session.pathGoalY })
    },
    stopWaterRoute(_bot, scope) {
      if (!scope) return
      stops.push(scope); bot.removeListener('physicsTick', scope.observe)
      if (bot._ndOwWaterRoute === scope) bot._ndOwWaterRoute = scope.previous
    },
    waterRouteRefusal(_bot, scope, route) { refusals.push({ scope, route }); return refusal }
  }
  const session: any = {
    bot, current: null, reflex: null, bus: new EventBus(), mcData: {}, surfaceWalk: false,
    require: () => bot, underSky: () => true, state: () => ({ water: bot.entity.isInWater }),
    cancel() {
      if (this.current) this.current.ctl.abort()
      this.current = null; bot.pathfinder.setGoal(null)
    },
    updateMovements() { calls.prepareSawScope = !!bot._ndOwWaterRoute; if (throwPrepare) throw new Error('prepare failed') },
    runIntent(name, worker, options) {
      pending = runIntent.call(this, name, worker, { ...options, timeoutMs: 0, interruptible: false })
      return pending
    }
  }
  const context: any = { module: { exports: {} }, calls, bot, session,
    require(name) {
      if (name === './water-route') return helpers
      if (name === './surface-walk') return {
        surfaceWalkOn: () => true,
        startSurfaceWalk: () => { const previous = bot._ndOwSurfaceWalk; bot._ndOwSurfaceWalk = { live: true }; return previous },
        stopSurfaceWalk: (_bot, scope) => { bot._ndOwSurfaceWalk = scope },
        surfaceDropGuard: () => ({ promise: new Promise(() => {}), stop() {} }), recoverSurface: async () => false
      }
      if (name === '../movement') return {
        xyz: p => ({ x: p.x, y: p.y, z: p.z }), inWater: () => bot.entity.isInWater,
        gotoWaitOn: () => false, unstick: async () => { calls.unstick++ },
        stuckGuard: () => ({ promise: new Promise(() => {}), stop() {} })
      }
      if (name === '../blockmoves') return { on: () => false }
      if (name === '../hopgoto') return { on: () => false }
      if (name === '../unstuck') return { on: () => false }
      if (name === '../fortify') return { leaveSealedCell: async () => {} }
      if (name === '../navigation/parkour') return { withinArena: () => true, IDLE: {} }
      if (name === '../game-clock') return { now: () => 0, clearTimeout() {} }
      if (name === './shared') return { skyLightAt: () => 15, HOLDING: [] }
      return realRequire(name)
    }
  }
  vm.runInNewContext(bodySource(file) + `
    gotoPreMoves = async function(run) { run.descentRuns = []; };
  `, cjsContext(context))
  const goto = (p: any = {}) => context.module.exports.goto.call(session,
    { x: 20, z: 4, surface: 'strict', pathWait: false, bridge: false, ...p })
  return { bot, session, goto, ready, records, starts, stops, scopes, refusals, calls,
    settled: () => pending, releasePath: () => releasePath() }
}

test('tactical water cancellation records the observed route once before surface/path cleanup', async () => {
  const f = fixture(), result = await f.goto()
  assert.equal(result.code, 'TACTICAL')
  assert.equal(f.records.length, 1)
  assert.equal(f.records[0].water, true)
  assert.equal(f.records[0].active, true)
  assert.equal(f.records[0].surface, true)
  assert.equal(f.records[0].surfaceWalk, true)
  assert.deepEqual(f.records[0].by, { type: 'tactical', threatLevel: 2 })
  assert.equal(f.calls.prepareSawScope, true, 'the retry cost must be available before rebuilding movements')
  assert.equal(f.calls.observations, 1)
  assert.equal(f.stops.length, 1)
  assert.equal(f.bot._ndOwWaterRoute, undefined)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.bot.listenerCount('path_update'), 0)
})

for (const scenario of [{ mode: 'arrive' }, { mode: 'cancelled' }, { wet: false }, { enabled: false }]) {
  test(`success cleanup and unrelated cancellation do not create water retry memory ${JSON.stringify(scenario)}`, async () => {
    const f = fixture(scenario)
    await f.goto()
    assert.equal(f.records.length, 0)
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
    assert.equal(f.bot.listenerCount('path_update'), 0)
  })
}

test('a helper refusal stops an unchanged complete wet route without retry, unstick or executing it', async () => {
  const f = fixture({ mode: 'wait', refusal: 'нужен другой подход к воде' })
  const result = await f.goto()
  assert.equal(result.status, 'done')
  assert.equal(result.detail.code, 'WATER_ROUTE_UNCHANGED')
  assert.equal(result.detail.stopped, 'нужен другой подход к воде')
  assert.equal(f.calls.paths, 1)
  assert.equal(f.calls.unstick, 0)
  assert.equal(f.refusals.length, 1)
  assert.equal(f.records.length, 0)
  assert.equal(f.bot.pathfinder.goal, null)
  assert.equal(f.bot.listenerCount('path_update'), 0)
})

test('partial routes are allowed to finish searching for a different water approach', async () => {
  const f = fixture({ status: 'partial', refusal: 'не отказывать частичному пути' })
  await f.goto()
  assert.equal(f.refusals.length, 0)
  assert.equal(f.records.length, 1)
})

test('a prepare error releases the route observer without fabricating a tactical failure', async () => {
  const f = fixture({ throwPrepare: true }), result = await f.goto()
  assert.equal(result.status, 'failed')
  assert.match(result.error, /prepare failed/)
  assert.equal(f.records.length, 0)
  assert.equal(f.stops.length, 1)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
  assert.equal(f.bot.listenerCount('path_update'), 0)
})

test('arena goto bypasses speedrun water retry state', async () => {
  const f = fixture()
  await f.goto({ arena: { x: 0, z: 0, r: 100, killY: 0 } })
  assert.equal(f.starts.length, 0)
  assert.equal(f.records.length, 0)
  assert.equal(f.refusals.length, 0)
  assert.equal(f.bot.listenerCount('physicsTick'), 0)
})

test('abort releases the water observer immediately even if the old path has not unwound', async () => {
  const f = fixture({ mode: 'tactical-stalled' }), pending = f.goto()
  try {
    await f.ready
    assert.equal(f.records.length, 1)
    assert.equal(f.bot._ndOwWaterRoute, undefined)
    assert.equal(f.bot.listenerCount('physicsTick'), 0)
    assert.equal(f.stops.length, 1)
  } finally { f.releasePath(); await pending }
})

test('a later Tactical move into water cannot relabel an earlier dry cancellation', async () => {
  const f = fixture({ mode: 'tactical-stalled', wet: false }), pending = f.goto()
  await f.ready
  f.bot.entity.isInWater = true
  f.releasePath()
  await pending
  assert.equal(f.records.length, 0)
})
