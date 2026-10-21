import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { startWaterRoute, stopWaterRoute, priceWaterMoves, waterRouteCost, recordWaterRouteFailure, waterRouteRefusal } from '../src/session/water-route'
const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
const { Movements } = require('mineflayer-pathfinder'), Move = require('mineflayer-pathfinder/lib/move')

function lake(t) {
  const was = process.env.ND_OW_WATER_ROUTE
  process.env.ND_OW_WATER_ROUTE = '1'
  t.after(() => { if (was === undefined) delete process.env.ND_OW_WATER_ROUTE; else process.env.ND_OW_WATER_ROUTE = was })
  const edits = new Map(), controls = { jump: false, sprint: true }
  const read = p => {
    const q = p.floored(), key = q.toString()
    let name = q.y <= 0 ? 'sand' : q.x >= 1 && q.x <= 6 && Math.abs(q.z) <= 1 && q.y <= 3 ? 'water' : 'air'
    if (q.x <= 0 && q.y <= 3) name = 'stone'
    const b = Block.fromStateId(edits.get(key) ?? registry.blocksByName[name].defaultState); b.position = q; return b
  }
  const bot: any = Object.assign(new EventEmitter(), { version: '1.21.11', registry, game: { minY:-64, height:384, dimension:'overworld' },
    entity: { position: new Vec3(.5,4,.5), metadata:[], effects:{}, isInWater:false }, entities:{},
    inventory:{items:()=>[]}, health:20, food:20, oxygenLevel:20, blockAt:read,
    world:{ getColumn:(cx,cz)=>({getBlockStateId:p=>read(new Vec3(cx*16+p.x,p.y,cz*16+p.z)).stateId}) },
    pathfinder:{isMoving:()=>true, bestHarvestTool:()=>null}, setControlState:(k,v)=>{controls[k]=v} })
  bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')] = 300
  const scope = startWaterRoute(bot, {x:6,z:0,range:1})
  t.after(()=>stopWaterRoute(bot,scope))
  return {bot,scope,read,edits,controls}
}

test('C2 is off by default, no water graph or control ownership outside OW', t => {
  const {bot,scope,read} = lake(t)
  process.env.ND_OW_WATER_ROUTE = '0'
  assert.equal(waterRouteCost(bot,read(new Vec3(2,1,0))),0)
  assert.equal(startWaterRoute(bot,{x:4,z:0}),null)
  process.env.ND_OW_WATER_ROUTE = '1'; bot.game.dimension='the_nether'
  assert.equal(waterRouteCost(bot,read(new Vec3(2,1,0))),0)
  stopWaterRoute(bot,scope)
})

test('surface water is cheaper than a submerged route, and low air/current/drowned add finite cost', t => {
  const {bot,scope,read,edits} = lake(t)
  const surface=waterRouteCost(bot,read(new Vec3(2,3,0))), deep=waterRouteCost(bot,read(new Vec3(2,1,0)))
  assert.ok(deep>surface && surface>0)
  bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')]=0
  assert.ok(waterRouteCost(bot,read(new Vec3(2,1,0)))>deep)
  scope.foes=[{x:2,y:1,z:0}]
  const foe=waterRouteCost(bot,read(new Vec3(2,1,0)))
  scope.foes=[]
  assert.ok(foe>waterRouteCost(bot,read(new Vec3(2,1,0))))
  edits.set(new Vec3(2,3,0).toString(),registry.blocksByName.water.minStateId+8)
  bot.emit('blockUpdate')
  assert.ok(Number.isFinite(waterRouteCost(bot,read(new Vec3(2,3,0)))))
  assert.ok(waterRouteCost(bot,read(new Vec3(2,3,0)))>surface)
})

test('native neighbors gain a real surface swim entry and upward swimming; original moves remain', t => {
  const {bot}=lake(t), mv=new Movements(bot)
  mv.canDig=false; mv.scafoldingBlocks=[]; mv.allow1by1towers=false; mv.allowParkour=false
  const shore=new Move(0,4,0,0,0), before=mv.getNeighbors(shore)
  priceWaterMoves(bot,mv)
  const after=mv.getNeighbors(shore)
  assert.ok(after.some(n=>n.x===1&&n.y===3&&n.z===0), 'surface instead of native y-2 landing')
  assert.ok(before.every(n=>after.some(m=>m.x===n.x&&m.y===n.y&&m.z===n.z)))
  assert.ok(mv.getNeighbors(new Move(2,1,0,0,0)).some(n=>n.x===2&&n.y===2&&n.z===0))
})

test('actual water blocks trigger native swim stroke even when entity.isInWater is false; owner and finish respected', t=>{
  const {bot,scope,controls}=lake(t)
  bot.entity.position=new Vec3(2.5,2,.5); bot.emit('physicsTick')
  assert.equal(controls.jump,true); assert.equal(controls.sprint,false)
  controls.jump=false; bot._ndReflexSession={_reflexState:{active:{owner:'Tactical'}}}; bot.emit('physicsTick')
  assert.equal(controls.jump,false)
  stopWaterRoute(bot,scope); bot._ndReflexSession=null; bot.emit('physicsTick')
  assert.equal(controls.jump,false); assert.equal(bot.listenerCount('physicsTick'),0); assert.equal(bot.listenerCount('blockUpdate'),0)
})

test('new water neighbors preserve native exclusions, mob costs and finite post-search prices', t=>{
  const {bot}=lake(t), mv=new Movements(bot)
  mv.canDig=false; mv.scafoldingBlocks=[]; mv.allow1by1towers=false; mv.allowParkour=false
  const shore=new Move(0,4,0,0,0)
  priceWaterMoves(bot,mv)
  const first=mv.getNeighbors(shore).find(n=>n.x===1&&n.y===3&&n.z===0)
  assert.ok(first)
  mv.exclusionAreasStep.push(()=>4)
  const costly=mv.getNeighbors(shore).find(n=>n.x===1&&n.y===3&&n.z===0)
  assert.ok(costly.cost>=first.cost+12)
  mv.exclusionAreasStep.push(()=>100)
  assert.ok(!mv.getNeighbors(shore).some(n=>n.x===1&&n.y===3&&n.z===0))
})

test('same submerged tactical failure is priced on the next call; refilled air does not erase it', t=>{
  const {bot,scope,read}=lake(t)
  const failedPath=[{x:2,y:1,z:0},{x:3,y:1,z:0},{x:6,y:3,z:0}]
  waterRouteRefusal(bot,scope,failedPath)
  bot.entity.position=new Vec3(2.5,1,.5); bot.emit('physicsTick')
  const before=waterRouteCost(bot,read(new Vec3(2,1,0)))
  bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')]=120
  recordWaterRouteFailure(bot,scope,{type:'tactical'})
  stopWaterRoute(bot,scope); bot.entity.position=new Vec3(.5,4,.5)
  bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')]=300
  const next=startWaterRoute(bot,{x:6,z:0,range:1}); t.after(()=>stopWaterRoute(bot,next))
  const after=waterRouteCost(bot,read(new Vec3(2,1,0)))
  assert.ok(after>=before+60 && Number.isFinite(after))
  assert.match(waterRouteRefusal(bot,next,failedPath),/тот же/)
  assert.equal(waterRouteRefusal(bot,next,[{x:2,y:3,z:0}]),null,'surface route is a different cause')
  assert.equal(waterRouteRefusal(bot,next,[{x:2,y:1,z:0},{x:2,y:2,z:0},{x:6,y:3,z:0}]),null,'same first cell with a new ascent is allowed')
})

test('observed terrain changes and new water capability allow replanning; unrelated target does not inherit failure', t=>{
  const {bot,scope,edits}=lake(t)
  const path=[{x:2,y:1,z:0},{x:3,y:1,z:0}]
  waterRouteRefusal(bot,scope,path)
  bot.entity.position=new Vec3(2.5,1,.5); bot.emit('physicsTick')
  bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')]=120
  recordWaterRouteFailure(bot,scope,{type:'tactical'})
  assert.ok(waterRouteRefusal(bot,scope,path))
  edits.set(new Vec3(2,1,0).toString(),registry.blocksByName.air.defaultState); bot.emit('blockUpdate')
  assert.equal(waterRouteRefusal(bot,scope,path),null)
  edits.clear(); bot.emit('blockUpdate'); stopWaterRoute(bot,scope)
  bot.inventory.items=()=>[{name:'oak_boat',count:1}]
  const next=startWaterRoute(bot,{x:6,z:0,range:1}); t.after(()=>stopWaterRoute(bot,next))
  assert.equal(waterRouteRefusal(bot,next,path),null)
  const other=startWaterRoute(bot,{x:10,z:0,range:1}); t.after(()=>stopWaterRoute(bot,other))
  assert.equal(waterRouteRefusal(bot,other,path),null)
})

test('a shorter dive from another dry entry can reuse the old failed tail', t=>{
  const {bot,scope}=lake(t)
  const old=[{x:1,y:1,z:0},{x:2,y:1,z:0},{x:3,y:1,z:0},{x:4,y:1,z:0},{x:6,y:3,z:0}]
  waterRouteRefusal(bot,scope,old)
  bot.entity.position=new Vec3(4.5,1,.5); bot.emit('physicsTick')
  bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')]=120
  recordWaterRouteFailure(bot,scope,{type:'tactical'}); stopWaterRoute(bot,scope)
  bot.entity.position=new Vec3(4.5,4,2.5)
  bot.entity.metadata[registry.entitiesByName.player.metadataKeys.indexOf('air_supply')]=300
  const next=startWaterRoute(bot,{x:6,z:0,range:1}); t.after(()=>stopWaterRoute(bot,next))
  assert.equal(waterRouteRefusal(bot,next,old.slice(3)),null)
})

test('an unrelated tactical fight with full air does not poison a water route', t=>{
  const {bot,scope}=lake(t)
  bot.entity.position=new Vec3(2.5,1,.5); bot.emit('physicsTick')
  recordWaterRouteFailure(bot,scope,{type:'tactical'})
  assert.equal(bot._ndOwWaterFailures,undefined)
})
