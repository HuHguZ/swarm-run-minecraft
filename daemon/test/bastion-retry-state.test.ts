import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'
import { declSource } from './source-fixture'
// routeRetryAt — часть тела bastion/sealed-gold.ts (sealed-gold/state.ts), по имени; шаг «отложенное золото» цикла
// bastion() — stepDeferred в bastion/run-loop.ts.
const sealedSource=declSource(require.resolve('../src/bastion/sealed-gold'),'routeRetryAt')

test('a failed gold route stays deferred within its RPC despite elapsed time; the disabled switch keeps the former deadlines',()=>{
  assert.ok(sealedSource.includes('function routeRetryAt('))
  let now=0
  const ctx:any={process:{env:{ND_NE_RECOVER:'1'}},gameClock:{now:()=>now}}
  const retry=vm.runInNewContext(sealedSource+'\nrouteRetryAt',cjsContext(ctx))
  assert.equal(retry(60000),Infinity)
  now=86400000;assert.equal(retry(60000),Infinity)
  ctx.process.env.ND_NE_RECOVER='0';assert.equal(retry(60000),now+60000)
})

test('deferred visible gold does not create an idle three-second wait without a real threat; the old control and actual danger still wait',async()=>{
  const text=declSource(require.resolve('../src/bastion/run-loop'),'stepDeferred')
  assert.ok(text.includes('const waiting ='))
  for(const [enabled,danger,expected]of [['1',false,0],['1',true,1],['0',false,1]]as const){
    let waits=0
    const ctx:any={process:{env:{ND_NE_RECOVER:enabled}},
      gameClock:{now:()=>0},countOf:()=>0,sleep:async()=>{waits++},unpackGold:async()=>assert.fail('no gold was supplied'),
      require:id=>{assert.equal(id,'.././ne-guard');return{hot:()=>danger}}}
    const step=vm.runInNewContext(text+'\nstepDeferred',cjsContext(ctx))
    const bx={st:{gold:new Map([['g',{}]]),skip:new Map([['g',60000]])},idle:0,bot:{},session:{},ctl:{}}
    await step(bx)
    assert.equal(waits,expected)
  }
})
