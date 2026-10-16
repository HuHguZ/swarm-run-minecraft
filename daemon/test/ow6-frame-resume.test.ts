import test from 'node:test'
import assert from 'node:assert/strict'
const Vec3=require('vec3')
const {geom, _in, castPortal}=require('../src/cast')

function fixture(done=9) {
  const origin=new Vec3(1,69,-28),g=geom(origin,'z',-1),blocks=new Map<string,string>()
  const key=p=>p.toArray().join(',')
  const frame=[[0,-1],[1,-1],[-1,0],[2,0],[-1,1],[2,1],[-1,2],[2,2],[0,3],[1,3]].map(([i,j])=>g.at(i,j))
  for(let i=-1;i<=2;i++)for(const p of [g.at(i,-2),g.F(i,-2)])blocks.set(key(p),'stone')
  for(const p of frame.slice(0,done))blocks.set(key(p),'obsidian')
  const read=p=>{const name=blocks.get(key(p))||'air';return {name,position:p,boundingBox:/air|water|lava/.test(name)?'empty':'block',getProperties:()=>({level:0})}}
  const plan={origin:{x:1,y:69,z:-28},axis:'z',side:-1,dig:[],place:[]}
  const session:any={bot:{entity:{position:new Vec3(-2.5,69,-27.5)},blockAt:read,game:{dimension:'overworld'}},castPlan1:plan,journal:{state:{places:{}}}}
  return {session,blocks,key,g,frame,read,plan}
}
test('two-bucket continuation keeps the observed nine-block frame and never schedules its obsidian for digging',()=>{
  const f=fixture(),r=_in.resumeOnePlan?.(f.session,{maxDig:64,windows:true})
  assert.ok(r,'known partial frame should be resumed')
  assert.deepEqual(r.origin,f.plan.origin);assert.equal(r.axis,'z');assert.equal(r.side,-1)
  assert.equal(r.windows,true)
  assert.ok(r.dig.every(p=>f.read(new Vec3(p.x,p.y,p.z)).name!=='obsidian'))
})
test('a persisted single-bucket frame is available after restart in the same dimension',()=>{
  const f=fixture();f.session.castPlan1=null as any
  f.session.journal.state.places['литьё портала (одно ведро)']={x:1,y:69,z:-28,axis:'z',side:-1,dimension:'overworld'}
  assert.ok(_in.resumeOnePlan?.(f.session,{maxDig:64}))
  f.session.bot.game.dimension='the_nether'
  assert.equal(_in.resumeOnePlan?.(f.session,{maxDig:64})??null,null)
})
test('a fresh unused footprint does not displace the normal two-bucket planner',()=>{
  const f=fixture(0);assert.equal(_in.resumeOnePlan?.(f.session,{maxDig:64})??null,null)
})
test('continuation is rejected when its floor, clearance or reachable location has changed',()=>{
  const f=fixture();assert.ok(_in.resumeOnePlan?.(f.session,{maxDig:64}))
  f.blocks.set(f.key(f.g.F(0,-2)),'sand');assert.equal(_in.resumeOnePlan?.(f.session,{maxDig:64})??null,null)
  f.blocks.set(f.key(f.g.F(0,-2)),'stone');assert.ok(_in.resumeOnePlan?.(f.session,{maxDig:64}))
  f.blocks.set(f.key(f.g.at(0,0)),'obsidian');assert.equal(_in.resumeOnePlan?.(f.session,{maxDig:64})??null,null)
  f.blocks.delete(f.key(f.g.at(0,0)));f.session.bot.entity.position=new Vec3(200,69,200)
  assert.equal(_in.resumeOnePlan?.(f.session,{maxDig:64})??null,null)
})
test('a missing block is not treated as safe empty geometry',()=>{
  const f=fixture();const read=f.session.bot.blockAt
  f.session.bot.blockAt=p=>p.equals(f.g.F(1,0))?null:read(p)
  assert.equal(_in.resumeOnePlan?.(f.session,{maxDig:64})??null,null)
})
for(const persistedTwo of [false,true])test('executor restores its active two-bucket checkpoint before adopting one: existing two = '+persistedTwo,async()=>{
  const f=fixture()
  f.session.bot.inventory={items:()=>[{name:'water_bucket',count:1},{name:'bucket',count:1},{name:'cobblestone',count:64}]}
  f.session.journal.patch=fn=>fn(f.session.journal.state)
  if(persistedTwo)f.session.journal.state.places['литьё портала']={x:10,y:69,z:-28,axis:'z',side:-1,dimension:'overworld',dig:[],lavaAt:[]}
  const r=await castPortal(f.session,{aborted:true,onAbort:[]})
  assert.equal(r.site.origin.x,persistedTwo?10:1)
  assert.equal(f.session.castPlan.origin.x,persistedTwo?10:1)
  assert.equal(f.session.journal.state.places['литьё портала'].x,persistedTwo?10:1)
})

function nativeRefillFixture() {
  const f=fixture(),registry=require('prismarine-registry')('1.21.11'),Block=require('prismarine-block')(registry)
  const read=p=>{p=p.floored();const name=f.read(p).name,b=Block.fromProperties(name,name==='lava'?{level:0}:{},0);b.position=p;return b}
  const world=new (require('prismarine-world')('1.21.11'))().sync
  world.getBlock=read
  world.getColumn=(cx,cz)=>({getBlockStateId:p=>read(new Vec3(cx*16+p.x,p.y,cz*16+p.z)).stateId})
  Object.assign(f.session.bot,{registry,blockAt:read,world,game:{dimension:'overworld',minY:-64,height:384},
    inventory:{items:()=>[{name:'water_bucket',count:1},{name:'bucket',count:1},{name:'cobblestone',count:64}]}})
  f.session.castPlan=_in.resumeOnePlan(f.session,{maxDig:64})
  f.session.journal.patch=fn=>fn(f.session.journal.state)
  return f
}

test('two buckets do not rebuild an unchanged source-empty nine-block frame',async()=>{
  const f=nativeRefillFixture(),state=_in.refillState(f.session.bot,f.session.castPlan)
  assert.equal(state.empty,true)
  f.session.castLavaFailure={key:state.key,stopped:'лава кончилась: зачерпнуть не вышло'}
  const r=await castPortal(f.session,{aborted:false,onAbort:[]})
  assert.equal(r.retryBlocked,true);assert.equal(r.frame,'9/10 обсидиан')
  assert.equal(r.dug,0);assert.equal(r.placed,0)
  f.session.bot.entity.position=f.session.bot.entity.position.offset(1,0,0)
  assert.notEqual(_in.refillState(f.session.bot,f.session.castPlan).key,state.key)
})

test('a newly visible source outside the original shore footprint re-admits two-bucket refill',()=>{
  const f=nativeRefillFixture(),before=_in.refillState(f.session.bot,f.session.castPlan)
  f.blocks.set(f.key(new Vec3(-8,68,-28)),'lava')
  const after=_in.refillState(f.session.bot,f.session.castPlan)
  assert.equal(after.empty,false);assert.notEqual(after.key,before.key)
})
