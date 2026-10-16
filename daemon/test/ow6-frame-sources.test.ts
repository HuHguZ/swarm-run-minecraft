import test from 'node:test'
import assert from 'node:assert/strict'
const Vec3=require('vec3')
const one=require('../src/cast1')

function fixture() {
  const origin=new Vec3(1,69,-28),g=one.geom1(origin,'z',-1),blocks=new Map<string,string>()
  const key=p=>p.toArray().join(',')
  for(const t of one.cells(g).slice(0,9))blocks.set(key(t.c),'obsidian')
  const read=p=>{const name=blocks.get(key(p))||'air';return {name,position:p,boundingBox:/air|water|lava/.test(name)?'empty':'block',getProperties:()=>({level:0})}}
  const inventory={water_bucket:1,cobblestone:100}
  const bot={entity:{position:g.G(0,0).offset(.5,0,.5),eyeHeight:1.62},entities:{},game:{dimension:'overworld'},blockAt:read,
    inventory:{items:()=>Object.entries(inventory).map(([name,count])=>({name,count}))},pathfinder:{setGoal(){}},health:20}
  const plan={origin:{x:1,y:69,z:-28},axis:'z',side:-1,dig:[],place:[]}
  const session={bot,castPlan1:plan,journal:{state:{places:{}}},castOneSourceFailure:null as any}
  return {bot,plan,session,blocks,key,g,inventory}
}
test('the same nine-block source deficit returns its receipt before any building or movement',async()=>{
  const f=fixture(),state=one.sourceState1?.(f.bot,f.plan)
  assert.ok(state?.short,'the physical deficit must be known')
  f.session.castOneSourceFailure={plan:f.plan,key:state.key,report:{frame:'9/10 обсидиан',built:false,stopped:'лавы со столба не достать'}}
  const clock=require('../src/game-clock'),now=clock.now
  try {
    for(const elapsed of [0,3600000]) {
      clock.now=()=>elapsed
      const r=await one.castOne(f.session,{aborted:false,onAbort:[]})
      assert.equal(r.retryBlocked,true);assert.equal(r.frame,'9/10 обсидиан')
      assert.equal(r.placed,0);assert.equal(r.dug,0)
    }
    f.blocks.delete(f.key(one.cells(f.g)[0].c))
    const changed=await one.castOne(f.session,{aborted:false,onAbort:[]})
    assert.equal(changed.retryBlocked,true);assert.equal(changed.frame,'8/10 обсидиан')
  } finally {clock.now=now}
})
test('a reachable new source changes the cause, rather than elapsed time or unrelated health',()=>{
  const f=fixture(),before=one.sourceState1?.(f.bot,f.plan)
  assert.ok(before?.short)
  f.bot.health=19;assert.deepEqual(one.sourceState1(f.bot,f.plan),before)
  f.blocks.set(f.key(f.g.H(0,-1)),'lava')
  const after=one.sourceState1(f.bot,f.plan)
  assert.equal(after.short,false)
})
test('carried lava or a completed last cell removes the source deficit',()=>{
  const f=fixture();assert.equal(one.sourceState1?.(f.bot,f.plan)?.short,true)
  f.inventory['lava_bucket']=1;assert.equal(one.sourceState1(f.bot,f.plan).short,false)
  delete f.inventory['lava_bucket'];f.blocks.set(f.key(one.cells(f.g).at(-1).c),'obsidian')
  assert.equal(one.sourceState1(f.bot,f.plan).short,false)
})
test('source geometry improving re-admits the frame before the next physical material request',async()=>{
  const f=fixture();assert.equal(one.sourceState1?.(f.bot,f.plan)?.short,true)
  f.session.castOneSourceFailure={plan:f.plan,key:one.sourceState1(f.bot,f.plan).key,report:{frame:'9/10 обсидиан',built:false,stopped:'лавы со столба не достать'}}
  f.blocks.set(f.key(f.g.H(0,-1)),'lava');f.inventory.cobblestone=0
  const r=await one.castOne(f.session,{aborted:false,onAbort:[]})
  assert.equal(r.retryBlocked,undefined);assert.equal(r.need.what,'cobblestone')
  assert.equal(f.session.castOneSourceFailure,null)
})

test('frame switch restores the old executor despite a saved source refusal',async()=>{
  const f=fixture(),previous=process.env.ND_OW_KIT_FRAME
  f.session.castOneSourceFailure={plan:f.plan,key:one.sourceState1(f.bot,f.plan).key,report:{frame:'9/10 обсидиан',built:false,stopped:'лавы со столба не достать'}}
  f.inventory.cobblestone=0
  try {
    process.env.ND_OW_KIT_FRAME='0'
    const r=await one.castOne(f.session,{aborted:false,onAbort:[]})
    assert.equal(r.retryBlocked,undefined);assert.equal(r.need.what,'cobblestone')
  } finally {
    if(previous===undefined)delete process.env.ND_OW_KIT_FRAME;else process.env.ND_OW_KIT_FRAME=previous
  }
})
test('one new source re-admits a partial frame even before all remaining lava has been found',async()=>{
  const f=fixture()
  for(const t of one.cells(f.g).slice(6,9))f.blocks.delete(f.key(t.c))
  const before=one.sourceState1?.(f.bot,f.plan);assert.equal(before?.short,true)
  f.session.castOneSourceFailure={plan:f.plan,key:before.key,report:{frame:'6/10 обсидиан',built:false,stopped:'лавы со столба не достать'}}
  f.blocks.set(f.key(f.g.H(0,-1)),'lava');f.inventory.cobblestone=0
  assert.equal(one.sourceState1(f.bot,f.plan).short,true,'three more sources are still missing')
  const r=await one.castOne(f.session,{aborted:false,onAbort:[]})
  assert.equal(r.retryBlocked,undefined);assert.equal(r.need.what,'cobblestone')
})
