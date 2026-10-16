import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
const Vec3=require('vec3'),registry=require('prismarine-registry')('1.21.11')

function fixture(count=8,frame=false,fit=true){
  const file=path.resolve(__dirname,'../src/fortress.js'),native=createRequire(file),source=fs.readFileSync(file,'utf8')
  const start=source.indexOf('function look(')>=0?source.indexOf('function look('):source.indexOf('function look (')
  const end=source.indexOf('\nfunction remember',start);assert.ok(start>=0&&end>start)
  const raw=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/bastion-housing-entry.json'),'utf8'))
  const views=raw.views.map(v=>({at:{x:v.at[0],y:v.at[1],z:v.at[2]},blocks:v.cells.map(([x,y,z,name])=>({name,position:{x,y,z}}))}))
  const assessment=require('../src/bastion/entry-route').assess(views.slice(0,1))
  const cells=views[0].blocks.filter(b=>b.name==='polished_blackstone_bricks').slice(0,count).map(b=>new Vec3(b.position.x,b.position.y,b.position.z))
  const B=registry.blocksByName.polished_blackstone_bricks.id,O=registry.blocksByName.obsidian.id
  let scans=0
  const bot:any={entity:{position:new Vec3(-27.5,58,28.5)},entities:{},world:{getColumn(){},raycast(){}},findBlocks:({matching})=>matching.includes(B)?cells:frame&&matching.includes(O)?[new Vec3(-18,59,28)]:[],blockAt:p=>({name:'polished_blackstone_bricks',position:p})}
  const ctx:any={module:{exports:{}},process,console,FORTRESS_BLOCKS:[],BASTION_BLOCKS:['polished_blackstone_bricks'],seesBlock:()=>true,xyz:p=>({x:p.x,y:p.y,z:p.z}),bearingWords:()=>'',require:id=>id==='./bastion/entry-route'?{observeSteps:function*(){scans++;return fit?assessment:{type:null,hypotheses:[]}}}:native(id)}
  vm.runInNewContext(source.slice(start,end)+'\nmodule.exports=look;',ctx)
  return{run:()=>ctx.module.exports(bot,registry),scans:()=>scans}
}
test('a saved characteristic housing fit opens first-sight detection at eight sparse bricks, while seven bricks or an unrecognized ruin do not',()=>{
  const good=fixture();assert.equal(good.run().bastion?.type,'units');assert.equal(good.scans(),1)
  const few=fixture(7);assert.equal(few.run().bastion,undefined);assert.equal(few.scans(),0)
  assert.equal(fixture(8,false,false).run().bastion,undefined)
})
test('early template recognition preserves the visible ruined-portal frame check',()=>{
  const result=fixture(8,true).run();assert.equal(result.bastion,undefined);assert.equal(result.ruins?.seen,8)
})
