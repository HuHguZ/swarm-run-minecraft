import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
let route: any = {}
try { route = require('../src/bastion/entry-route') } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e }
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/bastion-housing-entry.json'), 'utf8'))
const frames = () => data.views.map(v => ({ at: { x:v.at[0], y:v.at[1], z:v.at[2] }, blocks: v.cells.map(([x,y,z,name])=>({ name,position:{x,y,z} })) }))

test('two saved honest housing views recover the root pose and lower-wall entry without reading a world', () => {
  assert.equal(typeof route.assess, 'function', 'the entry recognizer is missing')
  const f=frames(), first=route.assess([f[0]])
  assert.equal(first.type, 'units')
  assert.equal(first.start, null, 'one facade is a hypothesis until a second characteristic view')
  const actual=route.assess(f)
  assert.deepEqual(actual.start, data.expected)
  assert.deepEqual(actual.entry, { x:-2,y:36,z:21 })
})

test('time, repeated observations and movement without new geometry cannot certify a root', () => {
  assert.equal(typeof route.assess, 'function')
  const f=frames()[0]
  for(const dx of [0,.02,1,8]){
    const repeated={at:{...f.at,x:f.at.x+dx},blocks:f.blocks}
    assert.equal(route.assess([f,repeated]).start,null)
  }
})

test('an earlier empty view is not a second characteristic facade', () => {
  assert.equal(typeof route.assess,'function')
  const f=frames()[0]
  assert.equal(route.assess([{at:{...f.at,x:f.at.x-8},blocks:[]},f]).start,null)
})

test('type knowledge alone supplies no wall coordinates and an empty view supplies no type', () => {
  assert.equal(typeof route.entryOf, 'function')
  assert.equal(route.entryOf({type:'units'}),null)
  assert.equal(route.entryOf({type:'hoglin_stable',r:1,t:{x:32,y:32,z:32}}),null)
  assert.equal(route.assess([]).type,null)
  assert.equal(route.assess([{at:{x:0,y:64,z:0},blocks:[{name:'netherrack',position:{x:1,y:64,z:0}}]}]).start,null)
})

test('housing entry is transformed from the recognized template under all four rotations', () => {
  assert.equal(typeof route.entryOf, 'function')
  const expected=[{x:21,y:36,z:66},{x:-2,y:36,z:21},{x:43,y:36,z:-2},{x:66,y:36,z:43}]
  for(let r=0;r<4;r++)assert.deepEqual(route.entryOf({type:'units',r,t:{x:32,y:32,z:32}}),expected[r])
})

test('a second view is chosen on supplied observed support, laterally along the facade, without revisiting a failed stop', () => {
  assert.equal(typeof route.chooseView,'function')
  const at={x:0,y:60,z:0},nodes=[{pos:at,d:0},{pos:{x:0,y:60,z:-4},d:4},{pos:{x:0,y:60,z:4},d:4}]
  const next=route.chooseView(nodes,at,{x:10,y:60,z:0},new Set(['0,60,-4']))
  assert.deepEqual(next.pos,{x:0,y:60,z:4})
  assert.equal(route.chooseView(nodes,at,{x:10,y:60,z:0},new Set(['0,60,-4','0,60,4'])),null)
  assert.equal(route.chooseView([{pos:{x:2,y:60,z:2},d:4}],at,{x:10,y:60,z:0},new Set()),null,'path length alone is not spatial separation')
})

test('an ambiguous set of housing poses cannot produce an entry coordinate', () => {
  assert.equal(typeof route.agreedStart,'function')
  const a={type:'units',r:1,t:{x:32,y:32,z:32}},b={...a,t:{...a.t,z:48}}
  assert.equal(route.agreedStart([a,b]),null)
  assert.deepEqual(route.agreedStart([a,{...a}]),a)
})

test('cells above a shorter jar rampart variant remain unknown and cannot contradict the real housing pose', () => {
  assert.equal(typeof route.assess,'function')
  const f=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/bastion-housing-variable-rampart.json'),'utf8'))
  const views=f.views.map(v=>({at:{x:v.at[0],y:v.at[1],z:v.at[2]},blocks:v.cells.map(([x,y,z,name])=>({name,position:{x,y,z}}))}))
  assert.deepEqual(route.assess(views).start,f.expected)
})

function routeFixture (move=true,cosmetic=false) {
  const file=path.resolve(__dirname,'../src/bastion/entry-route.js'),native=createRequire(file),Vec3=native('vec3')
  const items=[{name:'iron_pickaxe',count:1,durabilityUsed:0},{name:'cobblestone',count:64}],calls:any[]=[]
  const bot:any={entity:{position:new Vec3(-27.5,58,28.5)},health:20,food:20,game:{dimension:'the_nether'},world:{getColumn:()=>null,raycast:()=>null},entities:{},inventory:{items:()=>items},
    blockAt:p=>({name:'netherrack',boundingBox:'block',position:p})}
  const mem:any={world:bot.world,dimension:'the_nether',frames:[],visited:new Set(),confirmed:data.expected}
  const session={bot},context:any={module:{exports:{}},process,console,setImmediate,Set,testMemory:mem,
    require:id=>id==='../nether-cover'?{closedBore:async (_s,_c,target,options)=>{calls.push({target,options});if(move)bot.entity.position=new Vec3(target.x+.5,target.y,target.z+.5);return{ok:move,moved:move?1:0,down:0,dug:cosmetic?2:0,placed:cosmetic?2:0,unsealed:0,why:move?null:'no physical route'}}}:
      id==='../perception/eyes'?{seesNow:()=>true}:id==='../sealed'?{bodyCells:b=>[b.entity.position.floored()]}:native(id)}
  vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nmemory=()=>testMemory;',context)
  return{run:()=>context.module.exports.approach(session,{aborted:false},{},Infinity),calls,bot,items,mem}
}

test('a confirmed honest housing pose sends the covered bore to its lower wall, including the real target height', async () => {
  assert.equal(typeof route.approach,'function')
  const f=routeFixture(),result=await f.run()
  assert.equal(result.ok,true)
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].target)),{x:-2,y:36,z:21})
  assert.equal(f.calls[0].options.adjacent,true)
  assert.ok(f.calls[0].options.minY<=36,'default y=40 cannot reach this gold wall')
  assert.ok(f.calls[0].options.own instanceof Set)
  assert.equal(f.calls[0].options.stop({recognized:true}),false,'already recognized masonry must not stop the way to the lower wall')
})

test('an unchanged blocked approach sends no second bore; relevant replacement tools change its cause', async () => {
  assert.equal(typeof route.approach,'function')
  const f=routeFixture(false)
  await f.run();await f.run()
  assert.equal(f.calls.length,1)
  f.bot.entities[10]={name:'item',position:f.bot.entity.position}
  await f.run();assert.equal(f.calls.length,1,'an incidental dropped item did not unblock the wall')
  f.items.push({name:'stone_pickaxe',count:1,durabilityUsed:0})
  await f.run()
  assert.equal(f.calls.length,2)
})

test('breaking and refilling the same mouth without moving is not route progress and cannot repeat', async()=>{
  const f=routeFixture(false,true),first=await f.run()
  assert.equal(first.progress,false)
  await f.run();assert.equal(f.calls.length,1)
})

test('the second view is scanned at its observed destination, after intermediate movement passes four blocks', async()=>{
  const file=path.resolve(__dirname,'../src/bastion/entry-route.js'),native=createRequire(file),Vec3=native('vec3')
  const f=frames()[0],pos=new Vec3(0.5,60,.5),bot:any={entity:{position:pos},health:20,game:{dimension:'the_nether'},world:{getColumn(){},raycast(){}},entities:{},inventory:{items:()=>[]},blockAt:()=>({name:'netherrack'})}
  const nodes=Array.from({length:7},(_,x)=>({pos:new Vec3(x,60,0),d:x}))
  const mem:any={world:bot.world,dimension:'the_nether',frames:[{...f,at:{x:.5,y:60,z:.5}}],visited:new Set(),aim:new Vec3(6,60,0),assessment:{hypotheses:[data.expected]}}
  let scans=0
  const ctx:any={module:{exports:{}},process,console,setImmediate,Set,testMemory:mem,recordScan:()=>{scans++;return{hypotheses:[data.expected]}},require:id=>id==='../perception/eyes'?{seesNow:()=>true}:id==='../sealed'?{bodyCells:b=>[b.entity.position.floored()]}:id==='../walkable'?{walkable:()=>nodes.map(n=>({...n,d:Math.abs(n.pos.x-Math.floor(bot.entity.position.x))}))}:id==='../endportal-descent'?{walkInto:async(_b,_c,p)=>{bot.entity.position=p.offset(.5,0,.5);return true}}:native(id)}
  vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nmemory=()=>testMemory;observe=async()=>recordScan();',ctx)
  const run=()=>ctx.module.exports.approach({bot},{aborted:false},{},Infinity)
  for(let n=0;n<6;n++)await run()
  assert.equal(scans,0,'a partial approach must not consume the endpoint contour')
  await run();assert.equal(scans,1)
})
