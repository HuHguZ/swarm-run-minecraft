'use strict'
import * as tickFixture from './tick-plugins-fixture'
import { bodySource } from './source-fixture'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import { Module } from 'node:module'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import AStar = require('mineflayer-pathfinder/lib/astar')
import Move = require('mineflayer-pathfinder/lib/move')
import { goals, Movements } from 'mineflayer-pathfinder'
import '../src/fastblocks'

// Exercise current source without writing the frozen compiled daemon.
const movementFile = path.join(__dirname, '../src/movement.js')
const movementModule: any = new Module(movementFile, module)
movementModule.filename = movementFile
movementModule.paths = (Module as any)._nodeModulePaths(path.dirname(movementFile))
// Фасад movement и его части (movement/) одной областью — текущий исходник, как раньше один файл.
movementModule._compile(bodySource(movementFile), movementFile)
const { gotoGoal } = movementModule.exports

// Общий стенд установленных библиотек (tick-plugins-fixture) без его тестов.
const helpers: any = { exports: tickFixture }

const node = (x, z) => new Move(x, 64, z, 0, 1)
for (const valid of [true, false]) test('a different completed branch can join only through an allowed walk edge: ' + valid, async () => {
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(.5, 64, .5), onGround: true }
  bot.pathfinder = { setGoal() {}, isMoving: () => true, canMove: () => true }
  const goal = { isEnd: () => false }, walk = gotoGoal(bot, goal)
  const root = { data: node(0, 0), parent: null }
  const old = node(0, 1), next = node(1, 0), far = node(2, 0)
  far.toPlace.push({ x: 2, y: 63, z: 0 })
  const terminal = { data: far, parent: { data: next, parent: root } }
  const context = { bestNode: { data: old, parent: root }, openDataMap: new Map([[far.hash, terminal]]),
    movements: { getNeighbors: () => valid ? [next] : [old] } }
  try {
    bot.emit('path_update', { status: 'partial', path: [old], context })
    const result = { status: 'success', path: [next, far], context }
    const publication = result.path
    bot.emit('path_update', result)
    assert.equal(result.path, publication)
    assert.deepEqual(result.path, valid ? [next, far] : [old])
    if (valid) assert.equal(result.path[1].toPlace.length, 1)
  } finally { walk.cancel(); await assert.rejects(walk, { name: 'PathStopped' }) }
})

const edges = new Map([
  ['0,64,0', [[1,0], [0,1]]], ['1,64,0', [[0,0]]],
  ['0,64,1', [[0,0], [1,1]]], ['1,64,1', [[0,1], [2,1]]],
  ['2,64,1', [[1,1], [3,1]]], ['3,64,1', [[2,1], [3,0]]],
  ['3,64,0', [[3,1]]]
])

// Use the installed executor's trimming, rather than making a second route rule.
const nativeSource = fs.readFileSync(require.resolve('mineflayer-pathfinder'), 'utf8')
const trimStart = nativeSource.indexOf('  function pathFromPlayer (path) {')
const trimEnd = nativeSource.indexOf('\n  function ', trimStart + 3)
assert.ok(trimStart >= 0 && trimEnd > trimStart)
const trimFor = bot => new Function('bot', nativeSource.slice(trimStart, trimEnd) + '\nreturn pathFromPlayer')(bot)

for (const variant of ['ready', 'keep marker then ready', 'unsafe', 'wrong body', 'wrong height', 'airborne', 'mining', 'placing',
  'first break', 'first placement', 'bridge', 'descend', 'keep marker then blocked', 'zero first', 'unknown physics', 'water bypass']) {
  test(`a native trimmed different partial branch: ${variant}`, async () => {
    const before = process.env.ND_ASTAR_SLICE_NODES
    process.env.ND_ASTAR_SLICE_NODES = '1'
    const { install, testClock, block } = helpers.exports
    const bot: any = install(testClock(750), { pathfinder: true, physicsEnabled: false })
    bot.entity.position.set(.5,64,.5); bot.blockAt = p => block(p.y < 64 ? 'stone' : 'air', p)
    const native = bot.pathfinder, mv = new Movements(bot), trim = trimFor(bot)
    mv.allowEntityDetection = false
    mv.getNeighbors = n => {
      const [x,,z] = n.hash.split(',').map(Number)
      const cells = x === 0 && z === 0 ? [[1,0],[0,1]] : x === 1 && z === 0 ? [] : z === 1 && x < 50 ? [[x+1,1]] : [[50,0]]
      return cells.map(([x,z]) => new Move(x,64,z,0,1))
    }
    const goal = new goals.GoalBlock(50,64,0)
    let generator, currentPath = [], calls = 0
    bot.pathfinder = { goal: null, canMove: native.canMove, isMoving: () => currentPath.length > 0,
      isMining: () => variant === 'mining', isBuilding: () => variant === 'placing',
      setGoal (g) { this.goal = g; calls++; if (g) generator = native.getPathFromTo(mv,bot.entity.position,g); bot.emit('goal_updated',g) } }
    const walk = gotoGoal(bot,goal); walk.catch(() => {})
    try {
      const initial = generator.next().value.result
      bot.emit('path_update',initial); currentPath = initial.path
      const consumed = currentPath.shift(); bot.entity.position.set(consumed.x,consumed.y,consumed.z)
      let next, chain
      for (let i=0; i<4; i++) {
        next = generator.next().value.result; trim(next.path); chain = []
        for (let n = next.ndPartialNode || next.context.bestNode; n; n = n.parent) chain.unshift(n.data)
        if (next.path.length && !chain.includes(consumed)) break
      }
      assert.equal(next.status,'partial'); assert.equal(chain.includes(consumed),false)
      assert.equal(native.canMove(next.path),true,'actual scoped Physics connects the body to this native first step')
      const candidate = next.path.slice(), first = candidate[0], publication = next.path
      if (variant === 'wrong body') bot.entity.position.x += 2
      if (variant === 'wrong height') bot.entity.position.y += 2
      if (variant === 'airborne') bot.entity.onGround = false
      if (variant === 'first break') first.toBreak.push({x:0,y:64,z:1})
      if (variant === 'first placement') first.toPlace.push({x:0,y:63,z:1,dx:0,dy:1,dz:0})
      if (variant === 'bridge') first.ndBridge = {}
      if (variant === 'descend') first.ndDescend = {}
      if (variant === 'unknown physics') delete bot.pathfinder.canMove
      if (variant === 'unsafe' || variant === 'keep marker then blocked') {
        bot.blockAt = p => block(p.y < 64 || Math.floor(p.x) === 0 && Math.floor(p.z) === 1 ? 'stone' : 'air',p)
        assert.equal(native.canMove(candidate),false,'the native simulator rejects the blocked connection')
      }
      if (variant.startsWith('keep marker')) {
        const marker: any = new Vec3(bot.entity.position.x,bot.entity.position.y,bot.entity.position.z)
        marker.toBreak = []; marker.toPlace = []; marker.ndKeep = true
        next.path.unshift(marker)
        if (variant === 'keep marker then blocked') assert.equal(native.canMove(next.path),true,'a zero marker alone cannot prove the next edge')
      }
      if (variant === 'zero first') next.path.unshift(consumed)
      if (variant === 'water bypass') { bot.entity.isInWater = true; assert.equal(native.canMove(candidate),true) }
      const expected = next.path.slice()
      bot.emit('path_update',next); currentPath = next.path
      assert.equal(next.path,publication)
      if (variant === 'ready' || variant === 'keep marker then ready') assert.deepEqual(next.path,expected,'retain only the already trimmed connected branch')
      else assert.equal(next.path.length,0,'a different branch needs a real, nonzero physical first step')
      bot.emit('physicsTick'); assert.equal(calls,1,'the same continuing context is retained')
    } finally {
      walk.cancel(); await assert.rejects(walk,{name:'PathStopped'}); bot.emit('end')
      if (before === undefined) delete process.env.ND_ASTAR_SLICE_NODES; else process.env.ND_ASTAR_SLICE_NODES = before
    }
  })
}

for (const variant of ['ready', 'same coordinates different node', 'body moved', 'wrong height', 'mining', 'placing',
  'airborne', 'first break', 'first placement', 'bridge', 'descend', 'blocked', 'no physics predicate', 'world reset']) {
  test(`a continuing native partial suffix: ${variant}`, async () => {
    const before = process.env.ND_ASTAR_SLICE_NODES
    process.env.ND_ASTAR_SLICE_NODES = '1'
    const { install, testClock, block } = helpers.exports
    const bot: any = install(testClock(750), { pathfinder: true, physicsEnabled: false })
    bot.entity.position.set(.5,64,.5); bot.blockAt = p => block(p.y < 64 ? 'stone' : 'air', p)
    const native = bot.pathfinder, mv = new Movements(bot)
    mv.allowEntityDetection = false
    mv.getNeighbors = n => {
      const x = Number(n.hash.split(',')[0])
      return x < 5 ? [new Move(x+1,64,0,0,1)] : []
    }
    const goal = new goals.GoalBlock(5,64,0)
    let generator, currentPath = [], calls = 0
    bot.pathfinder = { goal: null, canMove: native.canMove, isMoving: () => currentPath.length > 0,
      isMining: () => variant === 'mining', isBuilding: () => variant === 'placing',
      setGoal (g) { this.goal = g; calls++; if (g) generator = native.getPathFromTo(mv,bot.entity.position,g); bot.emit('goal_updated',g) } }
    const walk = gotoGoal(bot,goal); walk.catch(() => {})
    try {
      const first = generator.next().value.result
      bot.emit('path_update',first); currentPath = first.path
      const consumed = currentPath.shift()
      bot.entity.position.set(consumed.x,consumed.y,consumed.z)
      const next = generator.next().value.result, publication = next.path, child = next.context.bestNode.data
      assert.equal(next.status,'partial')
      assert.equal(next.context.bestNode.parent.data,consumed,'the actual A* chain continues the consumed Move')
      assert.equal(native.canMove([child]),true,'the actual scoped Physics admits this first edge')
      if (variant === 'same coordinates different node') next.context.bestNode.parent.data = Object.assign(Object.create(Object.getPrototypeOf(consumed)),consumed)
      if (variant === 'body moved') bot.entity.position.x += 2
      if (variant === 'wrong height') bot.entity.position.y += 2
      if (variant === 'airborne') bot.entity.onGround = false
      if (variant === 'first break') child.toBreak.push({x:2,y:64,z:0})
      if (variant === 'first placement') child.toPlace.push({x:2,y:63,z:0,dx:0,dy:1,dz:0})
      if (variant === 'bridge') child.ndBridge = {}
      if (variant === 'descend') child.ndDescend = {}
      if (variant === 'blocked') bot.pathfinder.canMove = () => false
      if (variant === 'no physics predicate') delete bot.pathfinder.canMove
      if (variant === 'world reset') bot.emit('path_reset','block_updated')
      bot.emit('path_update',next); currentPath = next.path
      assert.equal(next.path,publication,'earlier consumers retain the native publication array')
      if (variant === 'ready') assert.deepEqual(next.path,[child],'walk only the existing child suffix, without returning to the old root')
      else if (variant === 'world reset') assert.deepEqual(next.path,[consumed,child],'a world invalidator revokes the consumed-node identity memory')
      else assert.equal(next.path.length,0,'unproved old-root suffix remains outside the executor')
      bot.emit('physicsTick'); assert.equal(calls,1,'do not restart the continuing A*')
    } finally {
      walk.cancel(); await assert.rejects(walk,{name:'PathStopped'}); bot.emit('end')
      if (before === undefined) delete process.env.ND_ASTAR_SLICE_NODES; else process.env.ND_ASTAR_SLICE_NODES = before
    }
  })
}

test('a consumed partial prefix lets installed A* finish its connected detour', async t => {
  const before = { slice: process.env.ND_ASTAR_SLICE_NODES, max: process.env.ND_ASTAR_NODES_PER_MS }
  process.env.ND_ASTAR_SLICE_NODES = '1'; process.env.ND_ASTAR_NODES_PER_MS = '0'
  t.after(() => {
    for (const [key, value] of [['ND_ASTAR_SLICE_NODES', before.slice], ['ND_ASTAR_NODES_PER_MS', before.max]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })
  const { install, testClock, block } = helpers.exports
  const bot: any = install(testClock(750), { pathfinder: true, physicsEnabled: false })
  bot.entity.position.set(.5,64,.5)
  bot.blockAt = p => block(p.y < 64 ? 'stone' : 'air', p)
  const canMove = bot.pathfinder.canMove
  const mv = { bot, getNeighbors: n => (edges.get(n.hash) || []).map(([x,z]) => node(x,z)) }
  const goal = new goals.GoalBlock(3,64,0)
  const search = () => {
    const p = bot.entity.position.floored()
    return new AStar(new Move(p.x,p.y,p.z,0,0), mv, goal, 5000, 1000)
  }
  const reference = search(); let referenceResult
  for (let i=0; i<30; i++) { referenceResult = reference.compute(); if (referenceResult.status !== 'partial') break }
  assert.equal(referenceResult.status, 'success', 'the real installed A* can solve this graph')
  let context, currentPath = [], searches = 0, reached = false, searching = false
  bot.pathfinder = {
    goal: null, isMoving: () => currentPath.length > 0, isMining: () => false, isBuilding: () => false,
    canMove,
    setGoal (g) { this.goal = g; currentPath = []; if (g) { context = search(); searches++; searching = true }; bot.emit('goal_updated', g) }
  }
  const walk = gotoGoal(bot, goal); walk.catch(() => {})
  try {
    for (let i=0; i<30 && !reached; i++) {
      if (searching) {
        const result = context.compute()
        bot.emit('path_update', result); currentPath = result.path
        searching = result.status === 'partial'
      }
      const next = currentPath.shift()
      if (next) bot.entity.position.set(next.x+.5,next.y,next.z+.5)
      if (goal.isEnd(bot.entity.position.floored())) { reached = true; bot.emit('goal_reached', goal) }
      else bot.emit('physicsTick')
    }
    assert.equal(reached, true, 'short cul-de-sac prefixes must not repeatedly discard the unfinished search')
    assert.equal(searches, 1, 'the same continuing A* supplies the completed route')
    await walk
  } finally {
    if (!reached) { walk.cancel(); await assert.rejects(walk, { name: 'PathStopped' }) }
    bot.emit('end')
  }
})

for (const variant of ['blocked', 'reachable', 'keep marker', 'busy building', 'busy mining', 'cancelled', 'new goal', 'empty']) {
  test(`a timed-out native search after consuming its prefix: ${variant}`, async () => {
    // Natural O: the body stopped at 556.5/120/582.67. A stale published head was 11 blocks east.
    const bot = helpers.exports.install(helpers.exports.testClock(750), { pathfinder: true, physicsEnabled: false })
    const move = x => Object.assign(new Move(Math.floor(x),120,582,0,1), { x, y: 120, z: 582.5 })
    bot.entity.position.set(555.5,120,582.67); bot.entity.onGround = true
    bot.blockAt = p => helpers.exports.block(p.y < 120 || Math.floor(p.x) === 560 && p.y < 125 ? 'stone' : 'air', p)
    const native = bot.pathfinder, goal = new goals.GoalNear(553,144,557,2)
    let current = [], starts = 0, action = ''
    bot.pathfinder = { goal: null, isMoving: () => current.length > 0, canMove: native.canMove,
      isMining: () => action === 'busy mining', isBuilding: () => action === 'busy building',
      setGoal(g) { this.goal = g; starts++; bot.emit('goal_updated',g) } }
    const walk = gotoGoal(bot, goal); walk.catch(() => {})
    try {
      const consumed = move(556.5), root = { data: move(555.5), parent: null }
      const context = { bestNode: { data: consumed, parent: root } }
      const partial = { status: 'partial', context, path: [consumed] }
      bot.emit('path_update',partial); current = partial.path; current.shift()
      bot.entity.position.set(556.5,120,582.67)
      const next = move(variant === 'reachable' ? 557.5 : 567.5), after = move(next.x + 1)
      after.toPlace.push({x:558,y:119,z:582,dx:0,dy:1,dz:0})
      const tail = [next,after]
      assert.equal(native.canMove(tail), variant === 'reachable')
      const timed = { status: 'timeout', context, path: variant === 'empty' ? [] : tail.slice() }
      context.bestNode = { data: after, parent: { data: next, parent: root } }
      if (variant === 'keep marker') timed.path.unshift(Object.assign(move(556.5), { ndKeep: true }))
      action = variant
      bot.emit('path_update',timed); current = timed.path
      if (variant === 'reachable') {
        assert.deepEqual(current,tail, 'preserve the ready first edge and its following placement')
        current.length = 0; bot.emit('physicsTick'); await walk
        assert.equal(starts,1)
      } else if (variant === 'empty') {
        await walk; assert.equal(starts,1, 'a native empty terminal keeps its ordinary outcome')
      } else {
        assert.equal(current.length,0, 'the executor may not adopt an obsolete or unproved first edge')
        if (variant === 'cancelled') walk.cancel()
        if (variant === 'new goal') bot.pathfinder.setGoal(new goals.GoalBlock(0,120,0))
        if (action.startsWith('busy')) { bot.emit('physicsTick'); assert.equal(starts,1); action = '' }
        bot.emit('physicsTick')
        assert.equal(starts, variant === 'cancelled' ? 1 : 2)
        if (variant === 'cancelled' || variant === 'new goal') {
          await assert.rejects(walk, { name: variant === 'cancelled' ? 'PathStopped' : 'GoalChanged' })
          bot.emit('path_update',timed); bot.emit('physicsTick')
          assert.equal(starts, variant === 'cancelled' ? 1 : 2, 'late results cannot revive the old walk')
        } else assert.equal(bot.pathfinder.goal, goal)
      }
    } finally { walk.cancel(); await walk.catch(() => {}); bot.emit('end') }
  })
}

for (const rejection of ['blocked first edge', 'airborne', 'mining', 'placing', 'first break', 'first placement', 'no physics predicate']) {
  test(`a consumed prefix rebases the terminal chain for ${rejection}`, async () => {
    const bot: any = new EventEmitter()
    bot.entity = { position: new Vec3(.5,64,.5), onGround: true }
    const root = { data: node(0,0), parent: null }, first = { data: node(1,0), parent: root }
    const context = { bestNode: first }
    let currentPath = [], calls = 0
    bot.pathfinder = { goal: null, isMoving: () => currentPath.length > 0, canMove: () => true,
      isMining: () => rejection === 'mining', isBuilding: () => rejection === 'placing',
      setGoal (g) { this.goal = g; calls++; bot.emit('goal_updated', g) } }
    const goal = { isEnd: () => false }
    const walk = gotoGoal(bot, goal); walk.catch(() => {})
    try {
      const partial = { status: 'partial', context, path: [first.data] }
      bot.emit('path_update', partial); currentPath = partial.path
      currentPath.shift(); bot.entity.position.set(1.5,64,.5)
      const pending = { status: 'partial', context, path: [node(0,1)] }
      bot.emit('path_update', pending); currentPath = pending.path; bot.emit('physicsTick')
      assert.equal(calls, 1, 'the still-running search remains intact')
      const terminal = { status: 'success', context, path: [node(0,1),node(3,0)] }
      if (rejection === 'blocked first edge') bot.pathfinder.canMove = () => false
      if (rejection === 'no physics predicate') delete bot.pathfinder.canMove
      if (rejection === 'airborne') bot.entity.onGround = false
      if (rejection === 'first break') terminal.path[0].toBreak.push({x:0,y:64,z:1})
      if (rejection === 'first placement') terminal.path[0].toPlace.push({x:0,y:63,z:1,dx:0,dy:1,dz:0})
      bot.emit('path_update', terminal); currentPath = terminal.path
      assert.equal(terminal.path.length, 0, 'the old-root first edge must be physically validated before adoption')
      bot.emit('physicsTick')
      assert.equal(calls, 2)
      assert.equal(bot.pathfinder.goal, goal)
    } finally { walk.cancel(); await assert.rejects(walk, { name: 'PathStopped' }) }
  })
}

test('external path invalidation and Emergency still revoke a consumed search', async () => {
  const bot: any = new EventEmitter()
  bot.entity = { position: new Vec3(.5,64,.5), onGround: true }
  const root = { data: node(0,0), parent: null }, first = { data: node(1,0), parent: root }
  const context = { bestNode: first }
  let currentPath = [], goals = 0
  bot.pathfinder = { goal: null, isMoving: () => currentPath.length > 0, canMove: () => true,
    setGoal (g) { this.goal = g; goals++; bot.emit('goal_updated',g) } }
  const goal = { isEnd: () => false }, walk = gotoGoal(bot,goal); walk.catch(() => {})
  try {
    const p = { status:'partial', context, path:[first.data] }
    bot.emit('path_update',p); currentPath=p.path; currentPath.shift()
    bot.emit('path_reset','block_updated')
    const fresh = { status:'partial', context:{bestNode:first}, path:[first.data] }
    bot.emit('path_update',fresh); currentPath=fresh.path
    assert.equal(currentPath.length,1,'world invalidation permits a freshly rooted prefix')
    let after
    bot._ndReflexTake = { after: fn => { after=fn } }
    bot.pathfinder.setGoal(null); bot.emit('physicsTick')
    assert.equal(goals,2,'waiting worker does not take control from Emergency')
    assert.equal(typeof after,'function')
  } finally { walk.cancel(); await assert.rejects(walk,{name:'PathStopped'}) }
})

for (const variant of ['airborne','unknown physics','ordinary airborne walk','grounded publication','mining','placing','first break','first placement']) {
  test(`a different native terminal construction route rebases only an idle plain prefix: ${variant}`, async () => {
    const previous=process.env.ND_ASTAR_SLICE_NODES
    process.env.ND_ASTAR_SLICE_NODES='1'
    const bot: any=new EventEmitter(), controls={forward:false,jump:false}
    bot.entity={position:new Vec3(650.3,150,554.33),onGround:true}
    const start=new Move(650,150,554,7,0), ghost=new Move(649,151,555,7,Math.SQRT2+1)
    const tower=[151,152,153,154].map((y,i)=>new Move(650,y,554,6-i,2,[],[{x:650,y:y-2,z:554,dx:0,dy:1,dz:0,jump:true}]))
    const terminal=new Move(649,154,555,3,Math.SQRT2), goal=new goals.GoalBlock(649,154,555)
    const search=new AStar(start,{getNeighbors(n){
      if(n===start)return[ghost,tower[0]]
      const i=tower.indexOf(n)
      return i<0?[]:i===3?[terminal]:[tower[i+1]]
    }},goal,5000)
    let currentPath=[],calls=0
    bot.pathfinder={goal:null,isMoving:()=>currentPath.length>0,isMining:()=>variant==='mining',isBuilding:()=>variant==='placing',canMove:()=>true,
      setGoal(g){this.goal=g;calls++;currentPath=[];controls.forward=false;controls.jump=false;bot.emit('goal_updated',g)}}
    if(variant==='unknown physics')delete bot.pathfinder.canMove
    const walk=gotoGoal(bot,goal);walk.catch(()=>{})
    try {
      const partial=search.compute()
      assert.equal(partial.status,'partial');assert.deepEqual(partial.path,[ghost])
      bot.emit('path_update',partial);currentPath=partial.path
      bot.entity.position.set(650.1149766831819,150.41999998688698,554.6001058427306)
      bot.entity.onGround=false;controls.forward=true;controls.jump=true
      if(variant==='first break')ghost.toBreak.push({x:649,y:151,z:555})
      if(variant==='first placement')ghost.toPlace.push({x:649,y:150,z:555,dx:0,dy:1,dz:0})
      let success
      for(let i=0;i<20;i++){success=search.compute();if(success.status!=='partial')break}
      assert.equal(success.status,'success');assert.equal(success.path[0],tower[0]);assert.equal(success.path[0].toPlace.length,1)
      if(variant==='ordinary airborne walk')success.path[0].toPlace.length=0
      if(variant==='grounded publication') {
        // V11 native receipt: the failed walk's jump reports ground for the exact
        // SUCCESS tick, then repeats its unreachable old prefix instead of building.
        bot.entity.position.set(650.2856291954586,150,554.3510406838491)
        bot.entity.onGround=true
      }
      bot.emit('path_update',success);currentPath=success.path
      if(variant==='airborne'||variant==='unknown physics'||variant==='grounded publication') {
        assert.equal(currentPath.length,0,'rebase the complete construction route without requiring a weak or missing canMove predicate')
        bot.emit('physicsTick')
        assert.equal(calls,2,'the existing native goal reset rebases from the actual body')
        assert.deepEqual(controls,{forward:false,jump:false},'native reset releases the old jump; no synthetic movement or landing')
        assert.equal(tower[0].toPlace.length,1,'an unexecuted construction action was not consumed')
      } else {
        assert.equal(currentPath[0],ghost,'an ordinary airborne walk or active dig/place keeps its existing action')
        bot.emit('physicsTick');assert.equal(calls,1)
        assert.deepEqual(controls,{forward:true,jump:true},'keep the native steering of the retained prefix')
      }
    } finally {
      walk.cancel();await assert.rejects(walk,{name:'PathStopped'})
      if(previous===undefined)delete process.env.ND_ASTAR_SLICE_NODES;else process.env.ND_ASTAR_SLICE_NODES=previous
    }
  })
}
