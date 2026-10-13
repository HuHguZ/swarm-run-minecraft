import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const esbuild = require('esbuild')
const file = path.resolve(__dirname, '../src/survival/hold-out.ts')
const req = createRequire(file)
const actionsText = fs.readFileSync(path.resolve(__dirname, '../src/actions.ts'), 'utf8')
const mealText = actionsText.slice(actionsText.indexOf('const RISKY_FOOD ='), actionsText.indexOf('async function drop (session'))
const meals = { exports: {} as any }
vm.runInNewContext(esbuild.transformSync(mealText + '\nmodule.exports={bestFood}', {loader:'ts',format:'cjs'}).code,
  {module:meals,exports:meals.exports,require:req})
const module0 = { exports: {} as any }
let ate = 0
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(file, 'utf8'), {loader:'ts',format:'cjs'}).code, {
  module:module0,exports:module0.exports,
  require: name => name === '.././actions' ? {...meals.exports,eat:async () => { ate++; return {ate:'cooked_beef'} }} :
    name === '.././fightkit' ? {hasEffect:()=>false,findPotion:()=>null} :
      name === './surface-body' || name === './enter-shelter' ? {} : req(name)
})
const refuge = module0.exports
const foodsByName = require('minecraft-data')('1.21.11').foodsByName
function scene(bag: string[], off: string | null, data = true) {
  const slots = Array(46).fill(null)
  if (off) slots[45] = {name:off,count:3,slot:45}
  return {bot:{health:9,food:12,inventory:{slots,items:()=>bag.map((name,i)=>({name,count:3,slot:9+i}))},registry:{foodsByName}},mcData:data ? {foodsByName} : null,eating:false}
}
for (const data of [true,false]) test(`refuge recognises carried slot-45 meal with ${data ? 'session' : 'registry'} food data`,()=>{
  assert.equal(refuge.hasFood(scene([], 'cooked_beef', data)),true)
})
test('healStep reaches the existing eat action for an orphaned off-hand meal', async()=>{
  ate=0; const s=scene([], 'cooked_beef')
  assert.equal(await refuge.healStep(s, {aborted:false}, 16),'cooked_beef')
  assert.equal(ate,1); assert.equal(s.eating,false)
})
test('refuge keeps its existing risky-food and fish-bucket exclusions',()=>{
  for (const item of ['rotten_flesh','chicken','suspicious_stew','pufferfish','cod_bucket','shield']) {
    assert.equal(refuge.hasFood(scene([], item)),false,item)
  }
  assert.equal(refuge.hasFood(scene(['cooked_beef'], 'rotten_flesh')),true)
})
