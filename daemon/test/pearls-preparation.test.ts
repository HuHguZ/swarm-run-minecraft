import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import { cjsContext } from './cjs-context'
import { bodySource } from './source-fixture'

test('the real foxhole skill reports failed preparation separately from a completed empty hunt, without inventing a kill or pearl',async()=>{
  const file=path.resolve(__dirname,'../src/pearls.js'),native=createRequire(file),Vec3=native('vec3')
  const bot:any=new EventEmitter()
  Object.assign(bot,{entity:{position:new Vec3(.5,49,.5)},health:20,food:20,entities:{},inventory:{items:()=>[]},blockAt(){assert.fail('the no-site fixture supplies no visible geometry')}})
  const context:any={module:{exports:{}},console:{log(){}},process:{env:{ND_NE_RECOVER:'1'}},Set,Map,
    require:id=>id==='./game-clock'?{now:()=>0}:id==='./walkable'?{walkable:()=>[]}:id==='./build'?{...native(id),towerUp:async()=>({ok:false})}:
      id==='./items'?{...native(id),bestWeapon:()=>null}:native(id)}
  vm.runInNewContext(bodySource(file)+'\nfoxHere=()=>null;module.exports.testFoxhole=huntFoxhole;',cjsContext(context))
  const r=await context.module.exports.testFoxhole({bot,mcData:{}},{aborted:false,onAbort:[]},{count:12})
  assert.equal(r.prepared,false)
  assert.equal(r.kills,0)
  assert.equal(r.pearls.gained,0)
  assert.match(r.stopped,/ровного места/)
  assert.equal(bot.listenerCount('physicsTick'),0)
})
