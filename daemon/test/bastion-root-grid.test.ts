import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import { REPO_ROOT } from '../src/paths'
import { cjsContext } from './cjs-context'
import B = require('../src/bastion/bastion')
const data=JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'daemon/test/fixtures/bastion-p7-b-102-starts.json'),'utf8'))

function predict(starts,enabled){
  const old={ND_BASTION_ROOT_GRID:process.env.ND_BASTION_ROOT_GRID,ND_KNOWLEDGE:process.env.ND_KNOWLEDGE,ND_BASTION_HYP_FOCUS:process.env.ND_BASTION_HYP_FOCUS}
  // ND_BASTION_HYP_FOCUS (по умолчанию вкл.) включает ту же сетку — «до» меряется без него.
  process.env.ND_BASTION_ROOT_GRID=enabled;process.env.ND_KNOWLEDGE='rsg';process.env.ND_BASTION_HYP_FOCUS=enabled==='0'?'0':'1'
  try{
    const st:any={pred:new Map(),gold:new Map(),chestSeen:new Map(),looted:new Set(),pieces:[]}
    B.rememberStarts({blockAt(){assert.fail('the generator constraint must not read the world')}},st,starts)
    return st
  }finally{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v}
}

test('p7-b-102: impossible inferred roots are removed by the vanilla jar/F3 grid before hidden-gold planning, without certifying a type',()=>{
  const before=predict(data.starts,'0'),after=predict(data.starts,'1')
  assert.equal(before.pred.size,97)
  assert.ok(after.pred.size>0&&after.pred.size<before.pred.size)
  assert.ok(before.pieces.some(c=>c.type==='units'))
  assert.ok(after.pieces.every(c=>c.type==='hoglin_stable'))
})

test('the four-root budget is applied after rejecting impossible roots, including negative chunk coordinates and all rotations',()=>{
  for(let r=0;r<4;r++){
    const actual={type:'units',r,t:{x:-144,y:32,z:32}}
    const st=predict([...Array.from({length:4},(_,i)=>({type:'units',r,t:{x:130+i,y:31,z:18}})),actual],'1')
    assert.ok(st.pred.size>0)
    assert.ok(st.pieces.every(c=>c.type==='units'))
    assert.equal(st.pieces[0].r,(r+1)&3)
  }
})

test('the live predictor filters its anchor roots and direct gold path too; a rescan cannot restore rejected hypotheses',()=>{
  const file=path.resolve(__dirname,'../src/bastion/predict-gold.js'),native=createRequire(file),bp=native('../bastion-pieces'),Vec3=native('vec3')
  assert.equal(typeof bp.startFitsGenerator,'function')
  const anchors=data.starts.map(s=>{const c=bp.goldPiecesFromStart(s)[0];return{...c,match:100,miss:0,gold:bp.lib()[c.piece].gold.length}})
  const fake={...bp,locate:()=>({found:anchors}),verify:()=>({match:0,miss:0}),voteByBasaltSteps:function*(){return[]},voteBySteps:function*(){return[]}}
  const context:any={module:{exports:{}},console,process:{env:{ND_BASTION_ROOT_GRID:'1'}},Set,Map,
    require:id=>id==='.././bastion-pieces'?fake:id==='.././nether-cover'?{blind:()=>true}:id==='./take-gold-block'?{...native(id),visibleOf:()=>[]}:native(id)}
  vm.runInNewContext(fs.readFileSync(file,'utf8'),cjsContext(context))
  const bot={registry:{blocksByName:{}},entity:{position:new Vec3(99,52,5)},entities:{},
    blockAt(){assert.fail('supplied observed anchors need no hidden block lookup')}}
  const result=context.module.exports.predictGold(bot)
  assert.ok(result.start?.all.length)
  assert.ok(result.start.all.every(bp.startFitsGenerator))
  assert.ok(result.gold.length)
  assert.ok(result.gold.every(g=>{const roots=bp.startsFrom(g.wall);return !roots.length||roots.some(bp.startFitsGenerator)}))
})
