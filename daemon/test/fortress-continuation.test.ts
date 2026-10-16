import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { transformSync } from 'esbuild'
const { Vec3 } = require('vec3')

function fixture({ enabled = '1', covered = false, move = false } = {}) {
  const file = path.resolve(__dirname, '../src/fortress.ts'), native = createRequire(file)
  const items: any[] = [{ name: 'iron_pickaxe', count: 1, durabilityUsed:0, maxDurability:250 }, { name: 'cobblestone', count: 64 }]
  const bot: any = { game: { dimension: 'the_nether' }, entity: { position: new Vec3(.5,64,.5) }, entities:{}, health: 20,
    inventory: { items: () => items }, blockAt: () => assert.fail('a continuation quote must use observations, never hidden blocks') }
  const bricks = new Set(['20,63,0'])
  const session: any = { bot, mcData: {}, _ndFortressFrontier: { world: 'the_nether', bricks },
    _ndTourVisited: { world: 'the_nether', points: [bot.entity.position.clone()], views: [bot.entity.position.clone()] },
    journal: { state: { places: {} }, patch: fn => fn(session.journal.state), append() {} } }
  const calls: any[] = [], view: any = { seen: 0, seenList: [], ...(covered ? { blazes: { seen: 1, nearest: 24 } } : {}) }
  const context: any = { module: { exports: {} }, process: { env: { ND_FORTRESS_CONTINUE: enabled } }, console: { log() {} },
    fixtureView: view, fixtureCalls: calls, fixtureMove: (kind, goal, opts) => {
      calls.push({ kind, goal: { ...goal }, opts })
      if (move) bot.entity.position = new Vec3(goal.x+.5, goal.y+1, goal.z+.5)
      return { ok: move, moved: move ? 8 : 0, why: 'closed face', error: 'noPath' }
    }, require: name => name === './nether-cover' ? { closedBore: async (_s,_c,goal,opts) => context.fixtureMove('covered', goal, opts) } : native(name) }
  vm.runInNewContext(transformSync(fs.readFileSync(file,'utf8'),{ loader:'ts',format:'cjs' }).code + `
    look = () => fixtureView;
    climbTo = async (_s,_c,goal) => fixtureMove('open',goal,{});
    module.exports.plan = typeof continuationPlan === 'function' ? continuationPlan : () => null;
    module.exports.run = typeof continueFortress === 'function' ? continueFortress : async () => ({ advanced:false });
    module.exports.rpcBody = scoutBody;
  `, context)
  return { bot, session, bricks, items, view, calls,
    plan: () => context.module.exports.plan(session, view),
    preview: () => context.module.exports.rpcBody(session,{aborted:false},{mode:'continue',planOnly:true}),
    run: (p: any = {}) => context.module.exports.run(session, { aborted:false }, { deadline:Infinity, ...p }) }
}

test('an exhausted local floor frontier can quote a farther previously seen fortress face without looking through it', () => {
  const f=fixture(), q=f.plan()
  assert.ok(q, 'the visible floor budget does not exhaust previously observed brick')
  assert.equal(q.source,'seen brick')
  assert.equal(q.to.x,20)
  assert.ok(Number.isFinite(q.seconds) && q.seconds>0)
  assert.equal(f.calls.length,0,'quoting is read-only')
})

test('real Vec3 observation keys survive the quote path, including their parentheses and spaces', async () => {
  const f=fixture();f.bricks.clear();f.view.seenList=[new Vec3(20,63,0)]
  const r=await f.run({planOnly:true})
  assert.equal(r.plan?.to.x,20)
  assert.ok(Number.isFinite(r.plan?.seconds))
})

test('the fortress RPC body routes a continuation preview to its own read-only quote', async () => {
  const f=fixture(),r=await f.preview()
  assert.equal(r.plan?.to.x,20)
  assert.equal(f.calls.length,0)
})

test('a known straight bridge row can continue beyond its observed end as a template hypothesis', () => {
  const f=fixture();f.bricks.clear()
  for(let x=0;x<=4;x++) f.bricks.add(`${x},63,0`)
  f.session._ndTourVisited.views = Array.from({length:5},(_,x)=>new Vec3(x+.5,64,.5))
  const q=f.plan()
  assert.ok(q)
  assert.equal(q.source,'bridge axis')
  assert.ok(q.to.x<=-8 || q.to.x>=12)
  assert.ok(f.session._ndTourVisited.views.every(p=>p.distanceTo(new Vec3(q.to.x+.5,q.to.y+1,q.to.z+.5))>=8))
})

test('a single nearby brick is neither a hidden map nor a known straight corridor', () => {
  const f=fixture();f.bricks.clear();f.bricks.add('1,63,0')
  assert.equal(f.plan(),null)
})

test('disconnected brick observations do not invent a straight bridge across their gap', () => {
  const f=fixture();f.bricks.clear()
  for(const x of [0,2,4]) f.bricks.add(`${x},63,0`)
  assert.equal(f.plan(),null)
})

test('visible non-blaze threats buy cover too, with spatial hysteresis at 24/32 blocks', () => {
  const f=fixture();f.view.routeThreat=20
  assert.equal(f.plan()?.covered,true)
  f.view.routeThreat=28
  assert.equal(f.plan()?.covered,false)
  f.session._ndFortressContinue={world:'the_nether',routes:new Map(),covered:true}
  assert.equal(f.plan()?.covered,true)
  f.view.routeThreat=33
  assert.equal(f.plan()?.covered,false)
})

test('an observed ranged threat buys a covered continuation at the current level instead of dropping below the fortress', async () => {
  const f=fixture({covered:true});const q=f.plan()
  assert.ok(q?.covered)
  await f.run({ planKey:q.key })
  assert.equal(f.calls[0]?.kind,'covered')
  assert.equal(f.calls[0].opts.minY,64)
  assert.equal(f.calls[0].opts.adjacent,true)
})

test('a sealed refuge is a physical reason to open a covered exit even after its hostile leaves the current ray', async () => {
  const f=fixture();f.view.boxed=true
  assert.equal(f.plan()?.covered,true)
  await f.run()
  assert.equal(f.calls[0]?.kind,'covered')
})

test('a failed same-level walking approach opens a visible covered bore instead of inheriting climbTo refusal', async () => {
  const f=fixture();await f.run()
  assert.ok(f.calls.some(r=>r.kind==='covered'))
})

test('an unchanged failed physical continuation is refused on the next RPC; elapsed time and unrelated loot cannot reopen it', async () => {
  const f=fixture()
  const r=await f.run()
  assert.equal(r.advanced,false)
  assert.ok(f.calls.length>0)
  f.items.push({name:'quartz',count:64})
  const n=f.calls.length
  await f.run()
  assert.equal(f.calls.length,n)
  f.bot.entity.position.x+=8
  await f.run()
  assert.ok(f.calls.length>n,'a new physical approach changes the failed cause')
})

test('new observed brick reopens a refused continuation; spending supply alone does not', async () => {
  const f=fixture();await f.run();const n=f.calls.length
  f.items[1].count--
  await f.run();assert.equal(f.calls.length,n)
  f.bricks.add('22,63,0')
  await f.run();assert.ok(f.calls.length>n)
})

test('a newly usable filler or a fresh pickaxe changes a refused construction cause', async () => {
  for(const material of ['basalt','pick']) {
    const f=fixture();f.items[0].durabilityUsed=200
    await f.run();const n=f.calls.length
    f.items[0].durabilityUsed=210
    await f.run();assert.equal(f.calls.length,n,'less remaining tool life cannot repair the failed route')
    if(material==='basalt')f.items.push({name:'basalt',count:64})
    else f.items[0].durabilityUsed=0
    await f.run();assert.ok(f.calls.length>n)
  }
})

test('a quote is bound to the observed plan and refuses stale execution or an unaffordable alternative', async () => {
  const f=fixture(),q=f.plan()
  assert.ok(q)
  await f.run({planKey:'stale'});assert.equal(f.calls.length,0)
  await f.run({maxCostSeconds:0});assert.equal(f.calls.length,0)
  await f.run({planOnly:true});assert.equal(f.calls.length,0)
})

test('a successful continuation credits actual eight-block displacement and keeps its physical receipt', async () => {
  const f=fixture({move:true}),r=await f.run()
  assert.equal(r.advanced,true)
  assert.equal(r.continuationTried,1)
  assert.ok(r.explored>=2)
})

test('the continuation switch leaves the previous frontier implementation available', async () => {
  const f=fixture({enabled:'0'})
  assert.equal(f.plan(),null)
  await f.run();assert.equal(f.calls.length,0)
})
