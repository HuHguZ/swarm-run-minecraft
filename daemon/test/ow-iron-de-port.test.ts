import { statementOf } from './source-fixture'
import { campaignTs, withSetters } from './campaign-source'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { cjsContext } from './cjs-context'
const source=campaignTs().replace(/\r\n/g,'\n')
const noop=async()=>{}
function fn(name:string,context:any){
  const at=source.indexOf(`function ${name} (`),start=source.slice(at-6,at)==='async '?at-6:at
  assert(at>=0,name)
  return vm.runInNewContext("'use strict';\n"+stripTypeScriptTypes(source.slice(start,source.indexOf('\n}\n',at)+2))+'\n'+name,cjsContext(withSetters(context)))
}
const counter=bag=>item=>typeof item==='string'?bag[item]||0:Object.entries(bag).reduce((s,[k,n]:any)=>s+(item.test(k)?n:0),0)
test('a funded lighter crafts in the inventory grid without a table; HAND_IGNITER=0 retains the old refusal',async()=>{
  for(const off of [false,true]){
    const bag:any={iron_ingot:1,flint:1,bucket:1},calls:string[]=[]
    const context:any={process:{env:{ND_OW_IRON_HAND_IGNITER:off?'0':undefined}},unclutter:noop,refresh:noop,
      TABLE_ITEMS:vm.runInNewContext(source.match(/^const TABLE_ITEMS = .+$/m)![0]+'\nTABLE_ITEMS'),
      ensureTable:async()=>{calls.push('table');return false},
      act:async(m,p)=>{calls.push(m);assert.equal(p.item,'flint_and_steel');assert.equal(bag.iron_ingot,1);assert.equal(bag.flint,1);bag.iron_ingot--;bag.flint--;bag.flint_and_steel=1;return{status:'done'}}}
    assert.equal(await fn('craft',context)('flint_and_steel'),!off)
    assert.deepEqual(calls,off?['table']:['craft'])
    assert.equal(bag.flint_and_steel||0,off?0:1)
  }
})
async function furnace({raw='raw_iron',visible=true,blocked=false,off=false,dimension='overworld',error='печки нет: не хватает камня (0 из 8)'}={}){
  const bag:any={[raw]:4,coal:1},calls:any[]=[],into=raw.replace('raw_','')+'_ingot'
  const context:any={process:{env:{ND_OW_IRON_FURNACE:off?'0':undefined}},state:{inventory:bag},died:false,strategyInterrupted:false,
    have:counter(bag),dim:()=>dimension,refresh:noop,unclutter:noop,ensureTable:noop,mineSeenAll:noop,craft:noop,planksFor:()=>null,log(){},
    RAW:/^(beef|mutton|chicken)$/,LOGS:/_log$/,COBBLE:/^(cobblestone|cobbled_deepslate|blackstone)$/,
    act:async(method,p)=>{
      calls.push({method,p})
      if(method==='mine'&&visible&&!blocked)bag.cobblestone=8
      if(method==='dig_down'&&!blocked)bag.cobblestone=8
      if(method==='smelt'){
        if((bag.cobblestone||0)<8&&!bag.furnace)return{status:'failed',error}
        bag.furnace=1;bag.cobblestone=0;bag[raw]=0;bag[into]=4
      }
      return{status:'done',detail:{}}
    }}
  await fn('smeltAll',context)(raw,into)
  return{bag,calls}
}
for(const raw of ['raw_iron','raw_gold'])for(const visible of [true,false])test(`furnace repair follows its physical shortage; ${raw}, visible stone=${visible}`,async()=>{
  const f=await furnace({raw,visible})
  assert.equal(f.bag[raw.replace('raw_','')+'_ingot'],4)
  assert.equal(f.calls.filter(x=>x.method==='dig_down').length,visible?0:1)
  assert.equal(f.calls.filter(x=>x.method==='smelt').length,2)
})
test('FURNACE=0 restores the old path; connection errors do not buy stone',async()=>{
  for(const params of [{off:true},{error:'connection closed'}]){
    const f=await furnace(params)
    assert.equal(f.bag.iron_ingot,undefined)
    assert.equal(f.calls.some(x=>['mine','dig_down'].includes(x.method)),false)
  }
})
test('an unsuccessful furnace supply does not retry smelting with the same missing material',async()=>{
  const f=await furnace({blocked:true})
  assert.equal(f.calls.filter(x=>x.method==='smelt').length,1)
  assert.equal(f.calls.filter(x=>x.method==='dig_down').length,1)
})
test('the Overworld furnace repair leaves Nether smelting unchanged',async()=>{
  const f=await furnace({dimension:'the_nether'})
  assert.equal(f.calls.some(x=>['mine','dig_down'].includes(x.method)),false)
})

test('remembered iron may be approached from ten blocks and is limited to the current deficit',async()=>{
  let left=2;const requests:any[]=[]
  const mine=fn('mineSeenAll',{process:{env:{}},OW_DEEP:true,died:false,y:()=>16,
    call:async()=>({detail:{spots:[{name:'iron_ore',fromMe:10,why:'в прямой видимости',at:{x:10,y:28,z:0}}]}}),
    act:async(m,p)=>{requests.push({m,p});left-=p.count??8;return{status:'done'}}})
  await mine('iron_ore,deepslate_iron_ore',24,()=>left)
  assert.equal(requests.length,1);assert.equal(requests[0].p.count,2);assert.equal(left,0)
})
test('an unchanged failed approach to remembered iron is not repeated inside the same call',async()=>{
  const requests:any[]=[]
  await fn('mineSeenAll',{process:{env:{}},OW_DEEP:false,died:false,y:()=>16,
    call:async()=>({detail:{spots:[{name:'iron_ore',fromMe:10,why:'в прямой видимости',at:{x:10,y:16,z:0}}]}}),
    act:async(m,p)=>{requests.push({m,p});return{status:'done',detail:{stopped:'нет пути',taken:[]}}}
  })('iron_ore,deepslate_iron_ore',24,()=>2)
  assert.equal(requests.length,1)
})

test('the old memory filter is retained with MEMORY=0 and for unrelated coal callers',async()=>{
  for(const [block,remaining,env]of [['iron_ore',()=>2,{ND_OW_IRON_MEMORY:'0'}],['coal_ore',undefined,{}]]as any[]){
    const requests:any[]=[]
    await fn('mineSeenAll',{process:{env},OW_DEEP:false,died:false,y:()=>16,
      call:async()=>({detail:{spots:[{name:block,fromMe:10,why:'в прямой видимости',at:{x:10,y:16,z:0}}]}}),
      act:async(m,p)=>{requests.push({m,p});return{status:'done'}}})(block,24,remaining)
    assert.equal(requests.length,0)
  }
})
test('iron memory is consumed before descent or a new drift; MEMORY=0 restores the old descent',async()=>{
  for(const mode of ['on','off','interrupted']){
    const off=mode==='off'
    const bag:any={iron_ingot:3,stone_pickaxe:1,flint:1},calls:string[]=[],dig=new Error('new excavation before known ore')
    const context:any={process:{env:{ND_OW_IRON_MEMORY:off?'0':undefined}},known:{},state:{inventory:bag,pos:{x:0,y:36,z:0},health:20,food:20},sit:{surface:false,night:false},
      died:false,strategyInterrupted:false,OW_DEEP:false,OW_HEAR:false,ironRuns:0,ironLeg:0,ironBlocked:new Set(),castSurfaceFailed:false,
      PICK_IRON:/iron_pickaxe/,PICK_STONE:/stone_pickaxe/,LOGS:/_log$/,FOOD:/bread/,ARMOR_POINTS:{},ARMOR_SLOT:{},ARMOR_COST:{},fightGearWanted:false,
      have:counter(bag),portalBuckets:()=>1,lighter:()=>false,weakAndHungry:()=>false,y:()=>36,dim:()=> 'overworld',gearWorth:()=>({missing:false}),
      sense:noop,cook:noop,refresh:noop,recoverGuard:noop,unclutter:noop,spares:noop,lightUp:noop,torches:noop,log(){},woodNow:()=>0,
      smeltAll:async()=>{bag.iron_ingot+=(bag.raw_iron||0);bag.raw_iron=0},spendIron:noop,ironToSmelt:()=>4,
      descend:async()=>{calls.push('descend');throw dig},mobInTheWay:async()=>false,
      call:async()=>({detail:{spots:[{name:'iron_ore',fromMe:10,why:'в прямой видимости',at:{x:10,y:36,z:0}}]}}),
      act:async(m,p)=>{calls.push(m);assert.equal(m,'mine_seen');if(mode==='interrupted'){context.strategyInterrupted=true;return{status:'interrupted'}}bag.raw_iron=(bag.raw_iron||0)+p.count;return{status:'done'}},
      defStage:(_n,_needed,run)=>{context.run=run}}
    context.mineSeenAll=fn('mineSeenAll',context)
    vm.runInNewContext(stripTypeScriptTypes(statementOf(source,"defStage('iron',")),cjsContext(withSetters(context)))
    if(off)await assert.rejects(context.run(true),e=>e===dig)
    else{await context.run(true);assert.deepEqual(calls,['mine_seen']);assert.equal(bag.iron_ingot,mode==='interrupted'?3:4)}
  }
})

async function wet(cluster:boolean,off:boolean){
  // cek1-s1-6, campaign lines 98,101,104,107: only refused water cells and the actual body pose.
  const points=[{p:[-35,58,-13],w:[-34,62,-13]},{p:[-55,58,-13],w:[-55,62,-12]},{p:[-55,57,-33],w:[-56,62,-33]},{p:[-35,56,-33],w:[-35,62,-34]}]
  let i=0;const goals:any[]=[]
  const context:any={process:{env:{ND_OW_IRON_WET:off?'0':undefined}},state:{pos:{x:-35,y:58,z:-13}},sit:{surface:true,night:false},died:false,
    OW_DEEP:false,OW_SHAFT:false,PICK_STONE:/pickaxe$/,known:{},heading:0,descendLava:null,
    recoverGuard:noop,unclutter:noop,spares:noop,ensurePick:async()=>true,reserve:noop,sense:noop,refresh:noop,
    mobInTheWay:async()=>false,NIGHT_DOWN2:()=>false,nightHold:()=>false,have:()=>0,y:()=>context.state.pos.y,dim:()=> 'overworld',
    act:async(m,p)=>{if(m==='dig_down'){const s=points[i++];context.state.pos={x:s.p[0],y:s.p[1],z:s.p[2]};return{status:'done',detail:{stopped:`вода у ${s.w.join(',')} — дальше не копаю`}}}
      assert.equal(m,'goto');goals.push(p);if(goals.length===4)context.died=true;return{status:'done'}}}
  context.awayFrom=fn('awayFrom',context)
  await fn('descend',context)(16,{wetCluster:cluster})
  return goals.map(g=>({x:g.x,z:g.z}))
}
test('iron wet detours use all observed refusal cells; off and non-iron calls retain the last-cell route',async()=>{
  assert.deepEqual((await wet(true,false))[3],{x:-18,z:-50})
  assert.deepEqual((await wet(true,true))[3],{x:-35,z:-9})
  assert.deepEqual(await wet(false,false),await wet(false,true))
})
