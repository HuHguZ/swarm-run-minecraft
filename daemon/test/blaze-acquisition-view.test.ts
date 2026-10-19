import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import path = require('node:path')
import * as vm from 'node:vm'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as esbuild from 'esbuild'
import { bodySource } from './source-fixture'
import { stubRequire } from './stub-require'

// Run the actual combat loop; perception hides the tracked entity behind a wall.
async function acquire({ hidden = new Vec3(10, 64, 0), known = true, progress = true, aborted = false, spawner = null, found = false, visible = false, viewDistance = 2, stopViews = 1, clearPlan = null, clearEnabled = true, burning = false }: any = {}) {
  let clock = 1000
  const walks = [], views = [], phases = [], goals = []
  const clearCalls = [], clearExec = []
  const ctl = { aborted }
  const bot: any = new EventEmitter()
  bot.health = bot.food = 20
  bot.entity = { id: 1, position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: new Vec3(0, 0, 0) }
  bot.entity.metadata = [burning ? 1 : 0]
  bot.entities = hidden ? { 2: { id: 2, name: 'blaze', position: hidden, isValid: true, height: 1.8, width: 0.6 } } : {}
  bot.visible = visible
  bot.inventory = { items: () => [{ name: 'iron_sword', count: 1 }], slots: new Array(46).fill(null) }
  bot.pathfinder = { movements: {}, setMovements() {}, setGoal(g) {
    if (g) { goals.push({ x: g.x, y: g.y, z: g.z }); bot.entity.position = new Vec3(g.x, g.y, g.z) }
  } }
  bot.equip = async () => {}
  bot.lookAt = async () => {}
  bot.clearControlStates = () => {}
  bot.setControlState = () => {}
  bot.blockAt = p => ({ name: p.y < 64 ? 'netherrack' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p })
  bot.physics = {}
  const guard = { wear: async () => {}, raise: async () => {}, lower: async () => {}, close() {}, report: () => ({}), stats: {} }
  const file = path.join(__dirname, '../src/blaze.ts')
  const session: any = { bot, mcData: (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11'), journal: { state: { places: known ? { 'крепость (ад)': { x: 4, y: 64, z: 4, dimension: 'the_nether' } } : {} } } }
  // Заглушки по spec (stubRequire сверяет и разрешённый путь: части blaze/hold/* просят '../../fortress'); unmatched() —
  // заглушки, которые ни разу не сработали.
  const req = stubRequire(file, {
    './game-clock': { now: () => clock, sleep: async ms => { clock += ms } },
    './walkable': { walkable: () => [], standable: () => false },
    './blaze-clear': {
      observe() {},
      plan: (_b, _sp, options) => { clearCalls.push(options); return clearPlan },
      execute: async (_s, _c, p, safe) => { clearExec.push(p); const ok = safe(500); ctl.aborted = true; return { ok, seconds: .5 } }
    },
    './fortress': {
      PLACE: 'крепость (ад)', placeOf: () => known ? session.journal.state.places['крепость (ад)'] : null,
      tour: async (_s, _c, options) => {
        views.push({ ...options, at: clock, from: bot.entity.position.clone() })
        if (progress) bot.entity.position = bot.entity.position.offset(viewDistance, 0, 0)
        if (progress && !found && views.length >= stopViews) ctl.aborted = true
        // fortress.look omits spawners/blazes when none are actually seen.
        return { spawners: found ? [{ x: 4, y: 64, z: 4, dist: 3 }] : undefined, blazes: undefined, seen: 1, hops: [], at: bot.entity.position }
      }
    }
  }, {
    './movement': actual => ({ ...actual, sleep: async ms => { clock += ms } }),
    './combat': actual => ({ ...actual, makeShield: () => guard }),
    './combat-safety': actual => ({ ...actual, watch: () => ({ check: () => ({ action: 'fight' }), close() {} }) })
  })
  const context: any = {
    module: { exports: {} }, exports: {}, console: { log() {} }, setTimeout, clearTimeout, Date,
    process: { env: { ND_GUARD: '0', ND_NE_ROUTE: '0' } }, bot, ctl, walks,
    require: req
  }
  // seesMe/seesMob — объявления function: ниже их можно переприсвоить без правки текста.
  const code = esbuild.transformSync(bodySource(file), { loader: 'ts', format: 'cjs' }).code
  vm.runInNewContext(code + `
    makeRadar = () => ({ untilDanger: () => Infinity, incoming: () => [], charged: () => false, stop() {}, stats: {} });
    fightMoves = () => ({}); hasEffect = () => true; witherClose = () => null;
    liveBlazes = () => Object.values(bot.entities); seesMe = () => bot.visible; seesMob = () => bot.visible;
    losClear = () => false; reachTo = () => 99; aimFrac = () => null;
    walkNear = async (_b, _c, p) => { walks.push(p.clone()); return true };
    module.exports.testHold = holdSpawner;
  `, cjsContext(context), { filename: file })
  const result = await context.module.exports.testHold(session, ctl, {
    spawner, want: 1, deadline: 51000, dead: new Set(), setPhase: p => phases.push(p),
    p: { box: false, clearSpawner: clearEnabled }
  })
  // './blaze-clear' and './fortress' are reached only by the clearing and the no-spawner view paths; those tests check them
  // through clearCalls and views.
  assert.deepEqual(req.unmatched().filter(k => k !== './blaze-clear' && k !== './fortress'), [], 'every stub reaches the decomposed spawner loop')
  return { walks, views, result, phases, clock, bot, goals, clearCalls, clearExec }
}

test('no-spawner combat acquires a fortress view instead of repeating a hidden entity coordinate', async () => {
  const r = await acquire()
  assert.equal(r.walks.length, 0, 'tracked hidden blaze coordinates cannot choose the walk goal')
  assert.equal(r.views.length, 1)
  assert.equal(r.views[0].hops, 1)
  assert.equal(r.views[0].deadline - r.views[0].at, 6000)
})

test('the same lawful view is chosen with a hidden blaze elsewhere or no tracked blaze', async () => {
  const a = await acquire({ hidden: new Vec3(2, 67, 11) })
  const b = await acquire({ hidden: null })
  assert.equal(a.views.length, 1)
  assert.equal(b.views.length, 1)
  assert.deepEqual(a.views[0], b.views[0])
  assert.equal(a.walks.length + b.walks.length, 0)
})

test('without observed fortress knowledge an unseen target does not create a goal', async () => {
  const r = await acquire({ known: false })
  assert.equal(r.walks.length, 0)
  assert.equal(r.views.length, 0)
  assert.ok(r.clock < 10000, 'return to the caller rather than waiting through the whole fight budget')
  assert.ok(r.result.stopped)
})

test('a failed stationary view ends the acquisition step instead of repeating it', async () => {
  const r = await acquire({ progress: false })
  assert.equal(r.views.length, 1)
  assert.ok(r.result.stopped)
  assert.ok(r.clock < 10000)
})

test('cancellation before combat does not start a view or hidden approach', async () => {
  const r = await acquire({ aborted: true })
  assert.equal(r.walks.length + r.views.length, 0)
})

test('a genuinely observed spawner is handed back to the caller for the spawner fight', async () => {
  const r = await acquire({ found: true })
  assert.equal(r.views.length, 1)
  assert.ok(r.result.stopped)
  assert.deepEqual(Array.from(r.result.spawners), [{ x: 4, y: 64, z: 4 }])
})

test('a currently visible blaze keeps the existing combat branch', async () => {
  const r = await acquire({ visible: true })
  assert.equal(r.views.length, 0)
})

test('a new no-spawner view becomes the current fight position instead of walking back to the old post', async () => {
  const r = await acquire({ viewDistance: 12, stopViews: 2 })
  assert.equal(r.views.length, 2)
  assert.equal(r.goals.length, 0, 'the old fight post must not undo deliberate acquisition')
  assert.equal(r.views[1].from.x, r.views[0].from.x + 12)
})

test('the actual spawner loop executes a priced clear action and returns its receipt', async () => {
  const plan = { mode: 'pick', pos: new Vec3(3, 65, 4), gain: .05, costSeconds: .5, savedSeconds: 2 }
  const r = await acquire({ hidden: null, spawner: new Vec3(4, 64, 4), clearPlan: plan })
  assert.equal(r.clearExec.length, 1)
  assert.equal(r.clearCalls[0].rods, 1)
  assert.ok(r.clearCalls[0].horizon > 0)
  assert.equal(r.result.clearing[0].ok, true)
  assert.ok(r.phases.includes('расчистка спавнера'))
  assert.equal(r.bot.listenerCount('blockUpdate'), 0)
})

test('the actual spawner loop does not repeatedly re-price an unchanged unprofitable world', async () => {
  const r = await acquire({ hidden: null, spawner: new Vec3(4, 64, 4) })
  assert.equal(r.clearCalls.length, 1)
  assert.equal(r.clearExec.length, 0)
})

test('the fire metadata alone does not reject a priced dig while fire resistance prevents its damage', async () => {
  const clearPlan = { mode: 'pick', pos: new Vec3(3, 65, 4), gain: .05, costSeconds: .5, savedSeconds: 2 }
  const r = await acquire({ hidden: null, spawner: new Vec3(4, 64, 4), clearPlan, burning: true })
  assert.equal(r.result.clearing?.[0]?.ok, true)
})

test('control scenes and an aborted spawner call do not start clearing', async () => {
  const disabled = await acquire({ hidden: null, spawner: new Vec3(4, 64, 4), clearEnabled: false })
  const aborted = await acquire({ hidden: null, spawner: new Vec3(4, 64, 4), aborted: true })
  assert.equal(disabled.clearCalls.length + aborted.clearCalls.length, 0)
})
