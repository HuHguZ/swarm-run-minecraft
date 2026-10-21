import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { CAMPAIGN, withSetters } from './campaign-source'
import { functionSource } from './source-fixture'
import { cjsContext } from './cjs-context'

// Real act(): the regression is retaining the nearest water while discarding
// an observed source with a cheaper complete route to the portal lake.
function fixture(env: Record<string, string> = {ND_OW_WATER_ROUNDTRIP:'1'}) {
  const ctx: any = {
    process: {env}, state: {dimension:'overworld', health:20, food:20, pos:{x:0,y:64,z:0}, inventory:{}, playPolicy:{mode:'speedrun'}},
    sit:{surface:true}, stage:'-', strategyExecuting:false, strategyInterrupted:false,
    died:false, resting:true, fighting:false, hunting:false, restIdleUntil:0,
    known:{lava:{x:100,y:64,z:0}}, lavaSourceKnown:true, knownWater:null,
    REFUGE_PASS:new Set(), SELF_GUARDED:new Set(), OW_DEEP:false,
    refugeRunning:()=>false, mobInTheWay:async()=>false, stopLava:async()=>null,
    acceptResult:()=>{}, seamSnapshot:()=>{}, log:()=>{}, telemetry:{on:()=>false},
    dim:()=>ctx.state.dimension, y:()=>ctx.state.pos.y,
    have:()=>0, gameClock:{now:()=>1}, detail:{},
    call:async()=>({status:'done', detail:ctx.detail, events:[]})
  }
  vm.createContext(cjsContext(withSetters(ctx)))
  vm.runInContext(transformSync(functionSource(CAMPAIGN,'act',{ts:true}),{loader:'ts',format:'cjs'}).code,ctx)
  return {ctx, see:async(q:any)=>{ctx.detail={blocks:[{name:'water',nearest:q}]}; await ctx.act('observe',{})}}
}

test('R water: observed forward source wins the complete route, not the nearest detour',async()=>{
  const f=fixture(), behind={x:-10,y:64,z:0}, forward={x:20,y:64,z:0}
  await f.see(behind); await f.see(forward)
  // Behind = (10+110)/2.5 = 48 s; forward = (20+80)/2.5 = 40 s.
  assert.deepEqual(f.ctx.knownWater,forward)
})

test('R water: default and explicit off preserve nearest-observer choice',async()=>{
  for(const env of [{},{ND_OW_WATER_ROUNDTRIP:'0'}]){
    const f=fixture(env), behind={x:-10,y:64,z:0}
    await f.see(behind); await f.see({x:20,y:64,z:0})
    assert.deepEqual(f.ctx.knownWater,behind)
  }
})

test('R water: vertical return and a changed lake change the cheaper source',async()=>{
  const f=fixture(), low={x:20,y:34,z:0}, dryLevel={x:30,y:64,z:0}
  await f.see(low); await f.see(dryLevel)
  assert.deepEqual(f.ctx.knownWater,dryLevel)
  f.ctx.known.lava={x:-100,y:64,z:0}
  const other={x:-20,y:64,z:0}; await f.see(other)
  assert.deepEqual(f.ctx.knownWater,other)
})

test('R water: no proved lake retains local acquisition; full bucket does not retarget',async()=>{
  const f=fixture(), near={x:-10,y:64,z:0}
  f.ctx.lavaSourceKnown=false
  await f.see(near); await f.see({x:20,y:64,z:0})
  assert.deepEqual(f.ctx.knownWater,near)
  f.ctx.have=(item:string)=>item==='water_bucket'?1:0
  await f.see({x:1,y:64,z:0}); assert.deepEqual(f.ctx.knownWater,near)
})

test('R water: a hidden liquid veto supplies no exact source coordinate',async()=>{
  const f=fixture()
  f.ctx.detail={stopped:'вода у 1,64,0 — дальше не копаю'}
  await f.ctx.act('observe',{})
  assert.equal(f.ctx.knownWater,null)
})

test('R water: source ranking cannot change a tactical interruption into a new move',async()=>{
  const f=fixture()
  f.ctx.strategyExecuting=true
  f.ctx.acceptResult=()=>{f.ctx.strategyInterrupted=true}
  await assert.rejects(f.see({x:20,y:64,z:0}),/STRATEGY_INTERRUPTED/)
  assert.equal(f.ctx.knownWater,null)
})

test('R lookout: a survey can remember water beyond the ordinary 48-block view',async()=>{
  const f=fixture({ND_OW_LAKE_WATER_LOOK:'1'})
  f.ctx.detail={waterSources:[{x:255,y:62,z:-152}]}
  await f.ctx.act('portal_natural',{mode:'survey'})
  assert.deepEqual(f.ctx.knownWater,{x:255,y:62,z:-152})
})

test('R lookout: ignore survey water when disabled, malformed, in another dimension or from another skill',async()=>{
  for(const kind of ['off','malformed','nether','other-skill']){
    const f=fixture(kind==='off'?{}:{ND_OW_LAKE_WATER_LOOK:'1'})
    if(kind==='nether')f.ctx.state.dimension='the_nether'
    f.ctx.detail={waterSources:[kind==='malformed'?{x:1,z:2}:{x:255,y:62,z:-152}]}
    await f.ctx.act(kind==='other-skill'?'observe':'portal_natural',{mode:'survey'})
    assert.equal(f.ctx.knownWater,null,kind)
  }
})

test('R lookout and route: rank all seen sources by the full route, retaining finite coordinates only',async()=>{
  const f=fixture({ND_OW_LAKE_WATER_LOOK:'1',ND_OW_WATER_ROUNDTRIP:'1'})
  f.ctx.detail={waterSources:[{x:-10,y:64,z:0},{x:20,y:64,z:0},{x:NaN,y:64,z:0}]}
  await f.ctx.act('portal_natural',{mode:'survey'})
  assert.deepEqual(f.ctx.knownWater,{x:20,y:64,z:0})
})
