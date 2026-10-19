import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import { cjsContext } from './cjs-context'
import { bodySource } from './source-fixture'
const Vec3: typeof import('vec3').Vec3=require('vec3')
function fixture(){
  const file=path.resolve(__dirname,'../src/blaze.js'),native=createRequire(file),bot:any=new EventEmitter(),calls:string[]=[]
  const ctl={aborted:false},state={seen:false,fr:false}
  Object.assign(bot,{entity:{position:new Vec3(.5,65,.5)},pathfinder:{setGoal:()=>calls.push('stop')}})
  const context:any={module:{exports:{}},console,process,setTimeout,clearTimeout,fixtureState:state,
    require:id=>id==='./movement'?{...native(id),stuckGuard:()=>({promise:new Promise(()=>{}),stop(){}}),gotoPath:()=>{calls.push('path');const p:any=new Promise(()=>{});p.cancel=()=>calls.push('cancel');return p}}:
      id==='./game-clock'?{now:()=>0,setTimeout:()=>0,clearTimeout(){}}:native(id)}
  vm.runInNewContext(bodySource(file)+'\nhasEffect=()=>fixtureState.fr;watchers=()=>fixtureState.seen?1:0;',cjsContext(context))
  return{module:context.module.exports,bot,ctl,state,calls}
}
test('ne6 visible shooter selects fight or cover before the unguarded spawner approach, with no potion gate',()=>{
  const f=fixture()
  assert.equal(typeof f.module.canApproachSpawner,'function')
  assert.equal(f.module.canApproachSpawner(f.bot,new Set()),true)
  f.state.seen=true
  assert.equal(f.module.canApproachSpawner(f.bot,new Set()),false)
  f.state.fr=true
  assert.equal(f.module.canApproachSpawner(f.bot,new Set()),true)
  f.state.fr=false;f.state.seen=false
  assert.equal(f.module.canApproachSpawner(f.bot,new Set()),true,'cover removes the line of fire without requiring fire resistance')
})
test('a new line of fire cancels the running approach on the next physics observation, not after its time budget',async()=>{
  const f=fixture()
  assert.equal(typeof f.module.canApproachSpawner,'function')
  const work=f.module.walkNear(f.bot,f.ctl,new Vec3(16,70,0),7,60000,{stopIf:()=>!f.module.canApproachSpawner(f.bot,new Set())})
  await new Promise<void>(r=>setImmediate(r))
  f.state.seen=true;f.bot.emit('physicsTick')
  const result=await work
  assert.equal(result.ok,false)
  assert.ok(f.calls.includes('cancel'))
  assert.equal(f.bot.listenerCount('physicsTick'),0)
})
