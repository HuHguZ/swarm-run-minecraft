// Q regression: execute real TypeScript with narrow movement/clock/RPC ports. No world or connection.
export {}
const { test } = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module')
const { REPO_ROOT: root } = require('../src/paths')
const req = Module.createRequire(path.join(root, 'daemon/package.json'))
const ts = Module.createRequire(path.join(root, 'package.json'))('@typescript/typescript6')
const source = name => fs.readFileSync(path.join(root, name), 'utf8')
function load(name, stubs: Record<string, any> = {}, text = source(name)): any {
  const file = path.join(root, name), local = Module.createRequire(file), module = { exports: {} as any }
  const code = ts.transpileModule(text, { fileName:file, compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS} }).outputText
  vm.runInNewContext(code, {module,exports:module.exports,require:id => Object.hasOwn(stubs,id)?stubs[id]:local(id),
    console,process,Buffer,setTimeout,clearTimeout,setInterval,clearInterval,__dirname:path.dirname(file),__filename:file}, {filename:file})
  return module.exports
}
const pick = load('daemon/src/pick.ts'), Vec3 = req('vec3').Vec3
const registry = req('minecraft-data')('1.21.11'), Block = req('prismarine-block')(registry)
const previousFlag = process.env.ND_OW_BURIAL_STEP
test.after(() => { if (previousFlag === undefined) delete process.env.ND_OW_BURIAL_STEP; else process.env.ND_OW_BURIAL_STEP = previousFlag })
process.env.ND_OW_BURIAL_STEP = '1'
function fixture({ visible = true, fresh = true, solid = true, column = false } = {}) {
  let now = 10000, digging = 0, stepping = 0, obstruction = solid
  const clock = { now: () => now, setTimeout: (fn,ms) => setImmediate(() => { now += ms; fn() }), clearTimeout: clearImmediate }
  const api = load('daemon/src/autopilot/suffocation.ts', {
    '../game-clock':clock, '../movement': { sleep:async ms => { now+=ms } },
    '../items':{ equipBestTool:async()=>{}, missingHarvestTool:()=>null }, '../build':{ withTimeout:p=>p },
    '../pick':pick, '../unstuck':{ overlapsBody:()=>false }, '../navigation/geometry':{ HAZARD:/lava/ }
  }, source('daemon/src/autopilot/suffocation.ts'))
  const air = p => { const b=Block.fromStateId(0,0); b.position=p.floored(); return b }
  const bot: any = { health:11, registry, entities:{}, game:{dimension:'overworld'}, entity:{position:new Vec3(.5,64,.5),width:.6,height:1.8,effects:{}},
    getControlState:()=>false, blockAt:p=> { if(obstruction && (p.floored().equals(new Vec3(0,65,0)) || column && p.floored().equals(new Vec3(0,66,0)))) {const b=Block.fromStateId(registry.blocksByName.gravel.defaultState,0);b.position=p.floored();return b}return air(p) },
    digTime:()=>250, dig:async()=>{digging++;obstruction=false}, stopDigging:()=>{}, lookAt:async()=>{}, setControlState:()=>{} }
  const auto: any = { ...api, inWallAt:fresh?now:-Infinity, session:{current:null,mcData:null,bus:{emit:()=>{}},journal:{append:()=>{}}},
    cfg:{lowHealth:8}, bodyBusy:()=>false, visibleBurialBlock:()=>visible, takeTheMouth:async()=>{} }
  auto.stepOutOfWall = async () => { stepping++; obstruction=false; auto.inWallAt=-Infinity; return true }
  return {api,auto,bot,digging:()=>digging,stepping:()=>stepping,clock}
}
test('confirmed in_wall with locally air eyes remains an emergency',()=>{
  const f=fixture({solid:false}); assert.ok(f.auto.buriedBy(f.bot),'local air must not erase server damage')
})
test('stale damage and ordinary air do not start burial',()=>{
  const f=fixture({solid:false,fresh:false}); assert.equal(f.auto.buriedBy(f.bot),null)
})
test('unpickable contact triggers physical exit without mining a hidden block',async()=>{
  const f=fixture({visible:false}); const r=await f.auto.freeIfBuried(f.bot,{force:true})
  assert.equal(f.digging(),0); assert.equal(f.stepping(),1); assert.equal(r.freed,true)
})
test('fresh damage without a local obstruction probes an exit immediately',async()=>{
  const f=fixture({solid:false}); const r=await f.auto.freeIfBuried(f.bot,{force:true})
  assert.equal(f.stepping(),1); assert.equal(r.freed,true)
})
test('visible head obstruction is mined immediately',async()=>{
  const f=fixture({fresh:false}),start=f.clock.now(); const r=await f.auto.freeIfBuried(f.bot,{force:true})
  assert.equal(f.digging(),1); assert.equal(r.freed,true);assert.ok(f.clock.now()-start>=550,'local dig prediction needs a damage-free window')
})
test('the last feet dig also observes a full damage window and retains new in_wall',async()=>{
  const f=fixture({fresh:false}),start=f.clock.now(),read=f.bot.blockAt
  let feet=true
  f.bot.blockAt=p=>{if(feet&&p.floored().equals(new Vec3(0,64,0))){const b=Block.fromStateId(registry.blocksByName.gravel.defaultState,0);b.position=p.floored();return b}return read(p)}
  const dig=f.bot.dig
  f.bot.dig=async b=>{if(b.position.y===64){feet=false;f.auto.inWallAt=f.clock.now()}else await dig(b)}
  const r=await f.auto.freeIfBuried(f.bot,{force:true})
  assert.ok(f.clock.now()-start>=1100,'both the head and last feet dig need observation');assert.notEqual(r?.freed,true);assert.equal(f.auto.stuck,true)
})
test('local air without movement is not a successful physical escape',async()=>{
  const f=fixture({solid:false}); assert.equal(await f.api.stepOutOfWall.call(f.auto,f.bot,{maxMs:100}),false)
})
test('a physical exit clears the stale server-damage latch',async()=>{
  const f=fixture({solid:false}); f.bot.setControlState=(k,v)=>{if(k==='forward'&&v)f.bot.entity.position=f.bot.entity.position.offset(1,0,0)}
  assert.equal(await f.api.stepOutOfWall.call(f.auto,f.bot,{maxMs:1200}),true)
  assert.equal(f.auto.buriedBy(f.bot),null)
})
test('new in_wall packets during movement prevent false freed and retain damage evidence',async()=>{
  const f=fixture({solid:false}),timer=f.clock.setTimeout
  f.bot.setControlState=(k,v)=>{if(k==='forward'&&v)f.bot.entity.position=f.bot.entity.position.offset(1,0,0)}
  f.clock.setTimeout=(fn,ms)=>timer(()=>{f.auto.inWallAt=f.clock.now();fn()},ms)
  assert.equal(await f.api.stepOutOfWall.call(f.auto,f.bot,{maxMs:1200}),false)
  assert.ok(f.auto.inWallAt>=f.clock.now()-50)
})
test('a vertical fall is not a confirmed exit from a locally invisible column',async()=>{
  const f=fixture({solid:false})
  f.bot.setControlState=(k,v)=>{if(k==='forward'&&v)f.bot.entity.position=f.bot.entity.position.offset(0,-1,0)}
  assert.equal(await f.api.stepOutOfWall.call(f.auto,f.bot,{maxMs:1200}),false)
})
test('fast gravel-column dig reserves enough time to confirm a real side exit',async()=>{
  const f=fixture({column:true})
  f.auto.stepOutOfWall=f.api.stepOutOfWall
  f.bot.setControlState=(k,v)=>{if(k==='forward'&&v)f.bot.entity.position=f.bot.entity.position.offset(1,0,0)}
  const r=await f.auto.freeIfBuried(f.bot,{force:true})
  assert.equal(f.digging(),0,'do not dig the old head cell after moving clear');assert.equal(r.freed,true)
})
test('a gravel column in a 1x1 shaft probes the side exit once, then only digs (ow 27.10: 19 -> 3 hp on three gravel)',async()=>{
  const f=fixture({fresh:false})
  let left=3, digs=0, probes=0
  const gravel=p=>{const b=Block.fromStateId(registry.blocksByName.gravel.defaultState,0);b.position=p.floored();return b}
  await f.bot.dig(); const read=f.bot.blockAt
  f.bot.blockAt=p=>{const q=p.floored();if(q.x===0&&q.z===0&&q.y>=65&&q.y<65+left)return gravel(p);return read(p)}
  f.bot.dig=async()=>{digs++;left--}
  f.auto.stepOutOfWall=async()=>{probes++;return false}
  const r=await f.auto.freeIfBuried(f.bot,{force:true})
  assert.equal(digs,3,'the whole column is dug');assert.equal(probes,1,'the same walls are not probed again for every falling block');assert.equal(r.freed,true)
})
test('flag 0 retains original no-geometry behaviour',()=>{
  process.env.ND_OW_BURIAL_STEP='0';try{const f=fixture({solid:false});assert.equal(f.auto.buriedBy(f.bot),null)}finally{process.env.ND_OW_BURIAL_STEP='1'}
})
test('overworld rescue does not turn stale cross-dimension damage into Nether burial',()=>{
  const f=fixture({solid:false});f.bot.game.dimension='the_nether';assert.equal(f.auto.buriedBy(f.bot),null)
})
test('the first opaque block still hides its neighbour from rescue mining',()=>{
  const f=fixture({fresh:false}),b=Block.fromStateId(registry.blocksByName.gravel.defaultState,0);b.position=new Vec3(1,65,0)
  assert.equal(f.api.visibleBurialBlock.call(f.auto,f.bot,b),false)
})
function campaignFixture() {
  const calls=[],logs=[],state={health:11,pos:{x:0,y:64,z:0}},sit={buried:false,inWater:false}
  const st={state,sit,died:false,fighting:false,setFighting:v=>{st.fighting=v}}
  const danger=load('daemon/campaign/danger.ts',{
    './state':st,'./observe':{sense:async()=>{}},'./act':{act:async(name,p)=>{calls.push({name,p});return{status:'done',detail:{freed:true}}}},
    './queries':{dim:()=> 'overworld'},'./log':{log:s=>logs.push(s)},'./kit':{},'./underground':{},'../src/game-clock':{now:()=>10000},
    './flags':{},'./rpc':{},'./craft':{},'./movement':{},'./rest':{},'./guards':{},'./travel':{}
  },source('daemon/campaign/danger.ts'))
  return{danger,calls,logs,st}
}
test('campaign in_wall dispatches rescue even when situation.buried is false',async()=>{
  const f=campaignFixture();await f.danger.answerThreat('in_wall');assert.equal(f.calls[0]?.name,'unstuck');assert.equal(f.calls[0]?.p.cause,'in_wall');assert.equal(f.st.fighting,false)
})
test('burial recovery asks for action instead of a two-second wait',async()=>{
  const f=campaignFixture();f.st.sit.buried=true;await f.danger.waitDugOut();assert.equal(f.calls[0]?.name,'unstuck');assert.ok(!f.calls.some(c=>c.name==='wait'))
})
test('RPC rescue keeps tactical ownership instead of starting a second intent',async()=>{
  const {intentMethods}=load('daemon/src/rpc/intents.ts',{},source('daemon/src/rpc/intents.ts'))
  let requests=0, intents=0
  const bot={game:{dimension:'overworld'}},session={bot,require:()=>bot,autopilot:{buriedBy:()=>null},
    tactics:{enabled:()=>true,requestGuard:async()=>{requests++}},immediate:async fn=>fn(),runIntent:()=>{intents++}}
  const r=await intentMethods({session,bus:{},vision:{}}).unstuck({cause:'in_wall'})
  assert.equal(requests,1);assert.equal(intents,0);assert.equal(r.freed,true)
})
test('RPC rescue without tactics calls the same forced burial implementation',async()=>{
  const {intentMethods}=load('daemon/src/rpc/intents.ts',{},source('daemon/src/rpc/intents.ts'))
  let forced=false
  const bot={game:{dimension:'overworld'}},session={bot,require:()=>bot,tactics:{enabled:()=>false},
    autopilot:{freeIfBuried:async(b,p)=>{assert.equal(b,bot);forced=p.force;return{freed:true}}},
    runIntent:async(name,fn)=>{assert.equal(name,'unstuck');return fn({onAbort:[]})}}
  const r=await intentMethods({session,bus:{},vision:{}}).unstuck({cause:'in_wall'})
  assert.equal(forced,true);assert.equal(r.freed,true)
})
test('an expired route budget and active refuge cannot block in_wall RPC',async()=>{
  let calls=0
  const state={stage:'route',strategyExecuting:false,strategyInterrupted:false,state:{health:11,food:12,dimension:'overworld',pos:{x:0,y:64,z:0}},
    sit:{surface:false},died:false,fighting:true,resting:false,routeDeadline:1,known:{portal:true}}
  const api=load('daemon/campaign/act.ts',{
    './flags':{},'./rpc':{call:async(name,p)=>{assert.equal(name,'unstuck');calls++;return{status:'done',detail:{freed:true},events:[]}}},
    './state':state,'./log':{telemetry:{on:()=>false},log:()=>{}},'./queries':{have:()=>0,y:()=>64,dim:()=> 'overworld'},
    './observe':{acceptResult:()=>{},stopLava:async()=>null},'./stages/table':{},'./nether-plan':{},
    './danger':{refugeRunning:()=>true,awaitRefuge:async()=>{throw new Error('rescue must not wait for refuge')}},'./guards':{},'./kit':{},'./underground':{},'./gear':{},'./route-wiring':{},
    '../src/game-clock':{now:()=>10000}
  },source('daemon/campaign/act.ts'))
  await api.act('unstuck',{cause:'in_wall'});assert.equal(calls,1)
})
