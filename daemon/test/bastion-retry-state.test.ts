import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
const source=fs.readFileSync(path.join(__dirname,'../src/bastion/bastion.js'),'utf8')
// routeRetryAt и sealedGold — в bastion/sealed-gold.ts (рядом, в этом порядке); bastion() остался в bastion/bastion.ts.
const sealedSource=fs.readFileSync(path.join(__dirname,'../src/bastion/sealed-gold.js'),'utf8')

test('a failed gold route stays deferred within its RPC despite elapsed time; the disabled switch keeps the former deadlines',()=>{
  const start=sealedSource.indexOf('function routeRetryAt('),end=sealedSource.indexOf('async function sealedGold(',start)
  assert.ok(start>=0&&end>start)
  let now=0
  const ctx:any={process:{env:{ND_NE_RECOVER:'1'}},gameClock:{now:()=>now}}
  const retry=vm.runInNewContext(sealedSource.slice(start,end)+'\nrouteRetryAt',cjsContext(ctx))
  assert.equal(retry(60000),Infinity)
  now=86400000;assert.equal(retry(60000),Infinity)
  ctx.process.env.ND_NE_RECOVER='0';assert.equal(retry(60000),now+60000)
})

test('deferred visible gold does not create an idle three-second wait without a real threat; the old control and actual danger still wait',async()=>{
  const start=source.indexOf('const waiting ='),end=source.indexOf('const me = bot.entity.position',start)
  assert.ok(start>=0&&end>start)
  const fragment=source.slice(start,end)
  for(const [enabled,danger,expected]of [['1',false,0],['1',true,1],['0',false,1]]as const){
    let waits=0
    const ctx:any={process:{env:{ND_NE_RECOVER:enabled}},st:{gold:new Map([['g',{}]]),skip:new Map([['g',60000]])},idle:0,bot:{},session:{},ctl:{},
      gameClock:{now:()=>0},countOf:()=>0,sleep:async()=>{waits++},unpackGold:async()=>assert.fail('no gold was supplied'),
      require:id=>{assert.equal(id,'.././ne-guard');return{hot:()=>danger}}}
    await vm.runInNewContext('(async()=>{for(let n=0;n<1;n++){'+fragment+'}return idle})()',cjsContext(ctx))
    assert.equal(waits,expected)
  }
})
