import test from 'node:test'
import assert from 'node:assert/strict'
import { createCampaignIntelligence } from '../src/campaign/intelligence'
import { fact } from '../src/core/world-state'

function fixture(blockedName: string, gold = 0) {
  const observation: any = { state: { dimension: 'the_nether', health: 20, food: 20, pos: { x:-8,y:64,z:69 },
    inventory: { iron_pickaxe:1, stone_pickaxe:1, iron_sword:1, cooked_mutton:8, cobblestone:64, gold_ingot:gold } },
    known: { portal:{x:0,y:64,z:0}, fortress:{x:0,y:64,z:90} },
    facts: { bastion:fact(true,'observed',0), bastions_exhausted:fact(false,'observed',0),
      blaze_allowed:fact(true,'observed',0), nether_tools_ready:fact(true,'observed',0),
      bastion_gold_left:fact(153,'inferred',0), endermen_seconds_per_pearl:fact(240,'observed',0) } }
  const records:any[]=[], calls:string[]=[],clock={t:0}
  const intelligence=createCampaignIntelligence({ eyes:12,beds:7,now:()=>clock.t,sleep:async()=>{},record:r=>records.push(r),
    observe:async()=>observation,call:async()=>({}),execute:async c=>{calls.push(c.skill);return{outcome:'FAILURE',events:[]}} })
  const stages=['nether','bastion','pearls'].map(name=>({name,needed:()=>true,ready:()=>true,defer:()=>false,done:()=>false,run:async()=>{}}))
  intelligence.director.options.goal=s=>s.resources.rods>=6 && s.resources.pearls>=12
  for(const strategy of intelligence.registry.all())strategy.estimateRisk=()=>0
  return{observation,records,calls,clock,intelligence,select:()=>intelligence.select(stages,s=>s.name===blockedName)}
}

test('Nether refusal cannot be bypassed by the special graph dispatch; another productive goal is selected by price',async()=>{
  const old=process.env.ND_NE_RECOVER;process.env.ND_NE_RECOVER='1'
  try{
    const f=fixture('nether')
    f.intelligence.registry.get('GetBlazeRods')!.estimateCost=()=>1
    f.intelligence.registry.get('BastionBarter')!.estimateCost=()=>200
    f.intelligence.registry.get('HuntEndermen')!.estimateCost=()=>300
    const selected=await f.select()
    assert.equal(selected?.strategy?.id,'BastionBarter')
    await selected!.stage.run()
    assert.deepEqual(f.calls,['bastion'])
    assert.ok(f.records.some(r=>r.reason==='Nether alternative after refusal'))
  }finally{if(old===undefined)delete process.env.ND_NE_RECOVER;else process.env.ND_NE_RECOVER=old}
})

test('a blocked bastion allows rods or Endermen to compete without marking its remaining gold exhausted',async()=>{
  const old=process.env.ND_NE_RECOVER;process.env.ND_NE_RECOVER='1'
  try{
    for(const [hunt,rods,want]of [[10,100,'HuntEndermen'],[100,10,'GetBlazeRods']]as const){
      const f=fixture('bastion')
      f.intelligence.registry.get('BastionBarter')!.estimateCost=()=>1
      f.intelligence.registry.get('HuntEndermen')!.estimateCost=()=>hunt
      f.intelligence.registry.get('GetBlazeRods')!.estimateCost=()=>rods
      const selected=await f.select()
      assert.equal(selected?.strategy?.id,want)
      assert.equal(f.observation.facts.bastions_exhausted.value,false)
      assert.equal(f.observation.facts.bastion_gold_left.value,153)
    }
  }finally{if(old===undefined)delete process.env.ND_NE_RECOVER;else process.env.ND_NE_RECOVER=old}
})

test('real threat retains tactical control and the new switch leaves legacy selection available when off',async()=>{
  const old=process.env.ND_NE_RECOVER
  try{
    process.env.ND_NE_RECOVER='1'
    const f=fixture('nether');f.observation.state.tactics={threatLevel:2}
    assert.equal(await f.select(),null)
    process.env.ND_NE_RECOVER='0'
    const legacy=fixture('nether');legacy.intelligence.registry.get('GetBlazeRods')!.estimateCost=()=>1
    assert.equal((await legacy.select())?.strategy?.id,'GetBlazeRods')
  }finally{if(old===undefined)delete process.env.ND_NE_RECOVER;else process.env.ND_NE_RECOVER=old}
})

test('a failed Nether producer does not return on the director clock, but its own new physical view reopens it immediately',async()=>{
  const old=process.env.ND_NE_RECOVER;process.env.ND_NE_RECOVER='1'
  try{
    const f=fixture('none'),strategy=f.intelligence.registry.get('GetBlazeRods')!
    await f.intelligence.director.run(strategy);await f.intelligence.director.run(strategy)
    f.clock.t+=3600000;f.observation.state.inventory.quartz=64
    let observed=await f.intelligence.environment.observe()
    f.intelligence.director.decide(observed)
    assert.equal(f.intelligence.director.canRun(strategy,observed),false,'elapsed time and unrelated stock repaired no route')
    f.observation.state.pos.x+=8
    observed=await f.intelligence.environment.observe();f.intelligence.director.decide(observed)
    assert.equal(f.intelligence.director.canRun(strategy,observed),true,'a physically different approach does not wait for a director timer')
  }finally{if(old===undefined)delete process.env.ND_NE_RECOVER;else process.env.ND_NE_RECOVER=old}
})
