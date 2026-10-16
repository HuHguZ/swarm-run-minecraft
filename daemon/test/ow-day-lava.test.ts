import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
const source=fs.readFileSync(path.join(__dirname,'../campaign.ts'),'utf8').replace(/\r\n/g,'\n')
const natural=require('../src/portal-natural'),registry=require('prismarine-registry')('1.21.11'),Vec3=require('vec3')
const noop=async()=>{}
function fn(name,context:any={}){
  const at=source.indexOf(`function ${name} (`);assert(at>=0,`missing ${name}`)
  const begin=source.slice(at-6,at)==='async '?at-6:at
  return vm.runInNewContext(stripTypeScriptTypes(source.slice(begin,source.indexOf('\n}\n',at)+2))+'\n'+name,context)
}
const view=(extra:any={})=>({pos:{x:0,y:70,z:0},surface:true,exitY:70,terrain:{horizon:128,occluderTop:71,points:[],stoneSeconds:.6,deepslateSeconds:1.15,tools:'stone'},
  ruins:[],heard:null,views:[],searchSeconds:60,scoutHazard:.00034,mineHazard:.00023,deathSeconds:3600,...extra})
const quote=v=>JSON.parse(JSON.stringify(fn('dayLavaQuotes')(v)))

test('day lava is opt-out, requires the carried casting kit, and leaves night and known lava to their existing owners',()=>{
  for(const mode of ['on','off','night','known','nether','empty']){
    const ctx:any={process:{env:{ND_OW_DAY_LAVA:mode==='off'?'0':undefined}},known:mode==='known'?{lava:{x:4,y:70,z:0}}:{},
      state:{pos:{x:0,y:70,z:0}},sit:{night:mode==='night'},died:false,dim:()=>mode==='nether'?'the_nether':'overworld',
      lighter:()=>true,have:()=>mode==='empty'?0:1}
    assert.equal(fn('dayLavaActive',ctx)(),mode==='on',mode)
  }
})

test('surface frontier wins in open terrain; obstructed sight makes descent cheaper without a clock switch',()=>{
  assert.equal(quote(view())[0].kind,'frontier')
  const forest=view({terrain:{...view().terrain,horizon:8,occluderTop:80}})
  assert.equal(quote(forest)[0].kind,'down')
  assert.deepEqual(quote({...forest,elapsedMs:0}),quote({...forest,elapsedMs:3600000}))
})

test('a visible higher landmark can clear observed occluders and replace the blind tower',()=>{
  const v=view({terrain:{...view().terrain,horizon:8,occluderTop:74,points:[{at:{x:10,y:79,z:0},water:false}]}})
  assert.equal(quote(v)[0].kind,'view')
  assert.deepEqual(quote(v)[0].to,{x:10,y:79,z:0})
})

test('a visible lower landing buys actual height reduction; nearby remembered ruins and fresh sound remain alternatives',()=>{
  const forest=view({terrain:{...view().terrain,horizon:8,points:[]}})
  assert.equal(quote({...forest,terrain:{...forest.terrain,points:[{at:{x:12,y:-20,z:0},water:false}]}})[0].kind,'cave')
  assert.equal(quote({...forest,ruins:[{kind:'ruined_portal',at:{x:32,y:70,z:0}}]})[0].kind,'ruin')
  const sound=quote({...forest,heard:{dir:'east',dist:8,below:true}})[0]
  assert.equal(sound.kind,'sound');assert.equal(sound.direction,'east');assert.equal(sound.depth,8)
  assert.equal(Object.hasOwn(sound,'to'),false,'subtitles do not supply hidden coordinates')
})

test('covered negative viewpoints reduce the value of another surface leg; cave search at the lava band does not climb to the sky',()=>{
  const fresh=quote(view()).find(j=>j.kind==='frontier'&&j.direction==='east')
  const used=quote(view({views:[{pos:{x:64,y:70,z:0},radius:128}]})).find(j=>j.kind==='frontier'&&j.direction==='east')
  assert(!used||used.price>fresh.price)
  assert.equal(quote(view({surface:false,pos:{x:0,y:-54,z:0}}))[0].kind,'drift')
})

function terrainBot(shape:(x:number,y:number,z:number)=>string){
  const sid=(x,y,z)=>registry.blocksByName[shape(x,y,z)].defaultState
  return{registry,game:{minY:-64,height:384,dimension:'overworld'},entity:{position:new Vec3(.5,64,.5),eyeHeight:1.62},
    inventory:{items:()=>[{name:'stone_pickaxe',type:registry.itemsByName.stone_pickaxe.id,count:1,durabilityUsed:4}]},
    blockAt:p=>{const b=require('prismarine-block')(registry).fromStateId(sid(p.x,p.y,p.z));b.position=new Vec3(p.x,p.y,p.z);return b},
    world:{getColumn:(cx,cz)=>({getBlockStateId:p=>sid(cx*16+p.x,p.y,cz*16+p.z)})}}
}
test('terrain cues use the existing first-hit rays: the hidden hill never becomes a target',()=>{
  assert.equal(typeof natural.terrainView,'function')
  const b=terrainBot((x,y,z)=>x===4&&y>=64&&y<=90?'stone':x>=8&&y<=80?'stone':y<=63?'stone':'air')
  const t=natural.terrainView(b)
  assert(t.points.every(p=>!(p.at.x>=8&&Math.abs(p.at.z)<4)),'a hill behind the wall is not observed')
  assert(t.horizon<=128)
  assert(t.stoneSeconds>0&&t.deepslateSeconds>t.stoneSeconds)
})

test('a floor exposed by an actual ravine ray is a descent cue, with no underground scan',()=>{
  assert.equal(typeof natural.terrainView,'function')
  const b=terrainBot((x,y,z)=>y<=(x>=3?42:63)?'stone':'air'),t=natural.terrainView(b)
  assert(t.points.some(p=>p.at.x>=3&&p.at.y<=43))
})

test('the first visible cave source beyond the old forty-block survey is retained; a wall hides it',()=>{
  const cave=(x,y,z)=>y>=74?'stone':y<=0?'lava':'air'
  const t=natural.terrainView(terrainBot(cave))
  assert(t.sources.some(s=>Math.hypot(s.at.x-.5,s.at.y-65.62,s.at.z-.5)>40))
  const hidden=natural.terrainView(terrainBot((x,y,z)=>y>=3&&y<=60?'stone':cave(x,y,z)))
  assert.deepEqual(hidden.sources,[])
})

function stepFixture(){
  const calls:any[]=[],terrain={...view().terrain,signature:'same-rays'},ctx:any={known:{},state:{pos:{x:0,y:70,z:0},inventory:{stone_pickaxe:1}},sit:{night:false},died:false,strategyInterrupted:false,
    dayLavaActive:()=>true,sense:noop,readMemory:noop,dayLavaViews:[],dayLavaFailures:new Set(),OW_HEAR:false,
    stairEntrance:null,surfaceShaft:null,lavaSourceKnown:false,lavaBad:()=>false,log(){},call:async(m,p)=>{calls.push({m,p});return{}},
    intelligence:{environment:{observe:async()=>({})},registry:{get:()=>({estimateCost:()=>1200,estimateRisk:()=>.02})}},
    process:{env:{}},spares:noop,lootSeenStructures:noop,
    dayLavaQuotes:()=>[{id:'frontier:east',kind:'frontier',to:{x:64,z:0},direction:'east',price:100,seconds:20}],
    act:async(m,p)=>{calls.push({m,p});return{status:'done',detail:m==='portal_natural'?{terrain,sites:[]}:m==='structure'?{known:[]}:m==='observe'?{entities:[]}: {}}}}
  return{ctx,calls,terrain}
}
test('a ray-confirmed source is kept even when the old twelve-source survey best is empty',async()=>{
 for(const fromTerrain of [false,true]){
  const f=stepFixture();f.ctx.act=async(m,p)=>{f.calls.push({m,p});assert.equal(m,'portal_natural');assert.equal(p.need,1);return{status:'done',detail:{best:null,terrain:f.terrain,sites:[{at:{x:40,y:63,z:0},usable:true}]}}}
  if(fromTerrain)f.ctx.act=async()=>({detail:{best:null,sites:[],terrain:{...f.terrain,sources:[{at:{x:40,y:63,z:0}}]}}})
  assert.equal(await fn('dayLavaStep',f.ctx)(),true)
  assert.deepEqual(JSON.parse(JSON.stringify(f.ctx.known.lava)),{x:40,y:63,z:0})
  assert.equal(f.ctx.lavaSourceKnown,true)
  assert.equal(f.calls.some(c=>['tunnel','dig_down','goto'].includes(c.m)),false)
 }
})

test('a failed same-cause move is not repeated; a changed body position rearms it',async()=>{
  const f=stepFixture(),run=fn('dayLavaStep',f.ctx)
  await run();await run()
  assert.equal(f.calls.filter(c=>c.m==='goto').length,1)
  f.ctx.state.pos.x=32;await run()
  assert.equal(f.calls.filter(c=>c.m==='goto').length,2)
  f.ctx.state.pos.x=0;await run()
  assert.equal(f.calls.filter(c=>c.m==='goto').length,2,'returning to the old unchanged refusal does not erase it')
})

test('the actual step prices the distant visible portal frame as well as remembered ruins',async()=>{
  const f=stepFixture(),at={x:70,y:70,z:10}
  f.ctx.act=async(m,p)=>{f.calls.push({m,p});return{detail:m==='portal_natural'?{terrain:f.terrain,sites:[],ruins:[{at}]}:m==='structure'?{known:[]}: {}}}
  f.ctx.dayLavaQuotes=v=>{assert.deepEqual(v.ruins[0].at,at);return[]}
  await fn('dayLavaStep',f.ctx)()
})

test('night or flag-off delegates without actions, and an interrupted observation starts no excavation',async()=>{
  const f=stepFixture();f.ctx.dayLavaActive=()=>false
  assert.equal(await fn('dayLavaStep',f.ctx)(),false);assert.equal(f.calls.length,0)
  f.ctx.dayLavaActive=()=>true;f.ctx.act=async()=>{f.ctx.strategyInterrupted=true;return{status:'interrupted'}}
  await fn('dayLavaStep',f.ctx)()
  assert.equal(f.calls.filter(c=>['goto','dig_down','tunnel'].includes(c.m)).length,0)
})

test('changed preparation state returns to the planner before starting a stale descent',async()=>{
  for (const change of ['night','moved','dead','interrupted']) {
    const f=stepFixture()
    f.ctx.dayLavaQuotes=()=>[{id:'down:east',kind:'down',direction:'east',depth:8,price:100}]
    f.ctx.spares=async()=>{if(change==='night')f.ctx.dayLavaActive=()=>false;else if(change==='dead')f.ctx.died=true;else if(change==='interrupted')f.ctx.strategyInterrupted=true;else f.ctx.state.pos.x=10}
    f.ctx.sense=async()=>{assert(!f.ctx.died&&!f.ctx.strategyInterrupted,'no RPC after terminal preparation')}
    await fn('dayLavaStep',f.ctx)()
    assert.equal(f.calls.filter(c=>c.m==='dig_down').length,0,change)
  }
})

test('the actual graph scout uses the enabled step and credits the new observed section',async()=>{
  const f=stepFixture(),facts:any={}
  Object.assign(f.ctx,{strategyExecuting:false,lavaScoutCells:new Set(),lavaScoutViews:0,dim:()=> 'overworld',graphFact:(k,v)=>{facts[k]=v}})
  f.ctx.dayLavaStep=fn('dayLavaStep',f.ctx)
  const old=f.ctx.act
  f.ctx.act=async(m,p)=>{const r=await old(m,p);if(m==='goto')f.ctx.state.pos.x=64;return r}
  const r=await fn('executeStrategy',f.ctx)({skill:'scoutLava'},new AbortController().signal)
  assert.equal(r.outcome,'SUCCESS',r.reason)
  assert.equal(f.calls.filter(c=>c.m==='goto').length,1)
  assert.equal(f.calls.filter(c=>['explore','tunnel'].includes(c.m)).length,0)
  assert.equal(facts.lava_scout_views,1)
})

test('legacy cast asks the daylight scout before a blind attempt; the actual opt-out restores the old cast',async()=>{
 for(const enabled of [true,false]){
  const calls:string[]=[],ctx:any={known:{},state:{pos:{x:0,y:70,z:0},playPolicy:{mode:'speedrun'}},sit:{surface:true,night:false},
    castRuns:0,died:false,strategyInterrupted:false,OW_DEEP:false,process:{env:{ND_OW_DAY_LAVA:enabled?undefined:'0'}},sense:noop,weakAndHungry:()=>false,dim:()=> 'overworld',act:async()=>({status:'done',detail:{}}),
    dayLavaStep:async()=>{calls.push('day-scout');return true},readMemory:noop,skyLavaLook:noop,lootSeenStructures:noop,ensureFlint:noop,
    recoverGuard:noop,unclutter:noop,castForKit:async()=>{calls.push('blind-cast');if(enabled)throw Error('blind casting before daylight scouting');ctx.known.portal=true;return{detail:{}}},
    defStage:(_id,_needed,run)=>{ctx.run=run}}
  if(!enabled){ctx.dayLavaActive=fn('dayLavaActive',ctx);ctx.dayLavaStep=fn('dayLavaStep',ctx)}
  const start=source.indexOf("defStage('cast',"),end=source.indexOf("defStage('diamond',",start)
  vm.runInNewContext(stripTypeScriptTypes(source.slice(start,end)),ctx)
  await ctx.run();assert.deepEqual(calls,[enabled?'day-scout':'blind-cast'])
 }
})
