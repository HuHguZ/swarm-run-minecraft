import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as threats from '../src/threats'
import { dodgeBlast } from '../src/tactics/blast'
const data = require('minecraft-data')('1.21.11'), Block = require('prismarine-block')('1.21.11')

function scene() {
  const cells = new Map<string,any>(), sand = data.blocksByName.sandstone.defaultState, air = data.blocksByName.air.defaultState
  const pos = new Vec3(3,64,0), center = pos.offset(.5,.5,.5)
  const bot:any = Object.assign(new EventEmitter(), { game:{dimension:'overworld'}, registry:data, username:'Bot', health:20, food:20,
    _client:new EventEmitter(),entity:{id:1,username:'Bot',position:new Vec3(.5,64,.5),height:1.8,width:.6,yaw:0,pitch:0},entities:{},players:{},
    inventory:{slots:[],items:()=>[]},blockAt(p){p=p.floored(); const block=Block.fromStateId(cells.get(p.toString())??(p.y===63?sand:air),0);block.position=p;return block},
    findBlocks({matching}){return [...cells.keys()].map(k=>new Vec3(...(k.slice(1,-1).split(',').map(Number) as [number,number,number]))).filter(p=>bot.blockAt(p).type===matching)} })
  const enemy:any={id:2,type:'player',username:'Miner',isValid:true,position:new Vec3(4.5,64,1.5),height:1.8,width:.6,yaw:0,pitch:0,metadata:[],equipment:[]}
  bot.entities[2]=enemy;bot.players.Miner={entity:enemy,gamemode:0}
  const set=(p,state)=>{const old=bot.blockAt(p);cells.set(p.toString(),state);bot.emit('blockUpdate',old,bot.blockAt(p))}
  const anchor=(n:number)=>set(pos,Block.fromProperties(data.blocksByName.respawn_anchor.id,{charges:n},0).stateId)
  const wall=(on:boolean)=>{for(let z=-3;z<=3;z++)for(let y=64;y<=67;y++)set(new Vec3(2,y,z),on?sand:air)}
  const scan=(foes=['Miner'])=>threats.dangers(bot,{foes}).blasts
  return {bot,enemy,pos,center,anchor,wall,set,scan}
}

test('visible charged anchor plus a reachable attacker interrupts a route through native dodge; it clears when the attacker leaves',async()=>{
  const f=scene();f.anchor(1)
  const contacts=f.scan();assert.equal(contacts.length,1)
  assert.equal(contacts[0].kind,'respawn_anchor');assert.equal(contacts[0].fuse,null);assert.equal(contacts[0].foe,'Miner')
  assert.deepEqual({...contacts[0].at},{...f.center})
  let stopped=false,steps=0
  f.bot.pathfinder={setGoal(goal){if(goal===null) stopped=true}}
  f.bot.look=async yaw=>{f.bot.entity.yaw=yaw}
  f.bot.setControlState=(key,on)=>{if(key==='forward'&&on){steps++;f.enemy.position=new Vec3(30.5,64,1.5)}}
  const result=await (dodgeBlast as any)({bot:f.bot},{aborted:false,onAbort:[]},['Miner'])
  assert.ok(stopped);assert.equal(steps,1);assert.equal(result.kind,'respawn_anchor');assert.equal(result.clear,true)
})

test('a wall, the safe dimension, a spectator, an unreachable activator or empty charges cannot masquerade as an armed anchor',()=>{
  const f=scene();f.anchor(0);assert.deepEqual(f.scan(),[])
  f.anchor(2);f.wall(true);assert.deepEqual(f.scan(),[]);f.wall(false)
  f.bot.game.dimension='the_nether';assert.deepEqual(f.scan(),[]);f.bot.game.dimension='overworld'
  f.bot.players.Miner.gamemode=3;assert.deepEqual(f.scan(),[]);f.bot.players.Miner.gamemode=0
  assert.deepEqual(f.scan([]),[])
  f.enemy.position=new Vec3(14.5,64,3.5);assert.deepEqual(f.scan(),[])
  f.enemy.position=new Vec3(4.5,64,1.5);assert.equal(f.scan().length,1)
})

test('a visible archer aiming a drawn bow through clear air can trigger a nearby crystal from range; a stone wall or changed aim removes the threat',()=>{
  const f=scene(); const crystal={id:5,name:'end_crystal',type:'object',width:2,height:2,isValid:true,position:f.pos.offset(.5,0,.5)}
  f.bot.entities[5]=crystal; f.enemy.position=new Vec3(3.5,64,-12.5);f.enemy.yaw=Math.PI;f.enemy.pitch=0
  f.enemy.equipment[0]={name:'bow'};f.enemy.metadata[data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')]=1
  assert.equal(f.scan()[0]?.kind,'end_crystal')
  f.enemy.pitch=1;assert.deepEqual(f.scan(),[]);f.enemy.pitch=0
  f.enemy.metadata[data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')]=0;assert.deepEqual(f.scan(),[])
  f.enemy.metadata[data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')]=1
  for(let y=63;y<68;y++) f.set(new Vec3(3,y,-6),data.blocksByName.stone.defaultState)
  assert.deepEqual(f.scan(),[])
})
import { hazardMethods } from '../src/rpc/hazards'
import { Session } from '../src/session'
import { EventBus } from '../src/events'
import * as clock from '../src/game-clock'

function responseSession(bot) {
  const session = new Session({}, new EventBus(), { state: {}, append () {} })
  session.bot = bot
  session.tactics = {enabled: () => false} as any
  session.state = () => ({ connected:true, busy:session.current?.name || null })
  return { session, rpc: hazardMethods({session,gameClock:clock} as any) }
}

test('a stationary TNT cart only warns for a plausible visible fire-arrow shot; nobody needs to approach the cart',()=>{
  const f=scene()
  f.bot.entities[5]={id:5,type:'object',name:'tnt_minecart',height:.7,width:.98,isValid:true,position:f.pos.offset(.5,0,.5)}
  assert.deepEqual(f.scan(),[], 'ordinary melee proximity does not detonate a parked cart')
  f.enemy.position=new Vec3(3.5,64,-12.5);f.enemy.yaw=Math.PI;f.enemy.pitch=-.06
  f.enemy.equipment[0]={name:'bow'};f.enemy.metadata[data.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')]=1
  assert.deepEqual(f.scan(),[], 'plain bow on an open unlit range')
  const component = {}; Object.defineProperty(component,'data',{get(){throw new Error('specific enchants must be private')}})
  f.enemy.equipment[0].componentMap=new Map([['enchantments',component]])
  const [threat]=f.scan();assert.equal(threat.kind,'tnt_minecart');assert.equal(threat.foe,'Miner');assert.equal(threat.reach,17)
  f.enemy.yaw=0;assert.deepEqual(f.scan(),[])
})

test('the real dodge_blast RPC keeps an ongoing action if its visible activator is gone',async()=>{
  const f=scene();f.anchor(1); const [contact]=f.scan()
  const {session,rpc}=responseSession(f.bot)
  const route:any={name:'goto',params:{},done:Promise.resolve(),ctl:{aborted:false,abort(){this.aborted=true}}}
  session.current=route
  f.enemy.position=new Vec3(21,64,.5)
  const answer:any=await rpc.dodge_blast({enemies:[contact.foe]})
  assert.equal(answer.notStarted,true);assert.equal(session.current,route);assert.equal(route.ctl.aborted,false)
})

test('a cornered body with an already worn shield faces the anchor and sends the actual off-hand use',async()=>{
  const f=scene(); f.anchor(1)
  const original=f.bot.blockAt
  f.bot.blockAt=p=>{if(p.y===63 && (Math.floor(p.x)!==0 || Math.floor(p.z)!==0)) {const b=Block.fromStateId(data.blocksByName.air.defaultState,0);b.position=p.floored();return b}return original(p)}
  f.bot.ndClock={age:100n,serverTicks:1}
  f.bot.inventory.slots[45]={name:'shield',type:data.itemsByName.shield.id}
  f.bot.clearControlStates=()=>{};f.bot.setControlState=()=>{};f.bot.look=async(yaw)=>{f.bot.entity.yaw=yaw}
  let bearing=null, releases=0
  f.bot.lookAt=async p=>{bearing=p}
  f.bot.activateItem=off=>{assert.equal(off,true);releases++;f.enemy.position=new Vec3(25,64,4)}
  f.bot.deactivateItem=()=>{}
  const {rpc}=responseSession(f.bot)
  const answer:any=await rpc.dodge_blast({enemies:['Miner']})
  assert.equal(answer.detail?.cornered,true,JSON.stringify(answer));assert.equal(answer.detail.shield.kind,'respawn_anchor')
  assert.equal(releases,1,JSON.stringify(answer));assert.equal(bearing.x,f.center.x);assert.equal(bearing.z,f.center.z)
})
