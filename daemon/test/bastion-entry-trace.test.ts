import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'

test('optional entry trace records changed honest views, including an unrecognized facade; identical state and the disabled flag add no logs',async()=>{
  for(const enabled of ['0','1']){
    const file=path.resolve(__dirname,'../src/bastion/entry-route.js'),native=createRequire(file),Vec3=native('vec3')
    const frame={at:{x:0,y:60,z:0},blocks:Array.from({length:4},(_,x)=>({name:'polished_blackstone_bricks',position:{x,y:60,z:1}}))}
    const bot:any={entity:{position:new Vec3(.5,60,.5)},world:{getColumn(){},raycast(){}},game:{dimension:'the_nether'},
      blockAt(){assert.fail('diagnostic output must not read a hidden world')},inventory:{items:()=>[]}}
    const mem={world:bot.world,dimension:'the_nether',frames:[frame],visited:new Set()},rows:any[]=[]
    const context:any={module:{exports:{}},process:{env:{ND_BASTION_ENTRY_TRACE:enabled}},console:{log:(p,s)=>rows.push({p,...JSON.parse(s)})},setImmediate,Set,testMemory:mem,require:native}
    vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nmemory=()=>testMemory;observe=async()=>({type:null,hypotheses:[]});',context)
    const run=()=>context.module.exports.approach({bot},{aborted:false},{},Infinity)
    assert.equal((await run()).handled,false)
    await run()
    frame.blocks.push({name:'polished_blackstone_bricks',position:{x:4,y:60,z:1}})
    await run()
    assert.equal(rows.length,enabled==='1'?2:0)
    if(enabled==='1'){assert.equal(rows[0].visibleBricks,4);assert.equal(rows[1].visibleBricks,5);assert.equal(rows[1].start,null)}
  }
})
