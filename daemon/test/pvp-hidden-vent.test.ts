import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { hiddenFoeTurn } from '../src/pvp/turn-reach'
import type { TurnFrame } from '../src/pvp/turn'
import { createTerrain } from '../src/pvp/terrain'
import { getPhysics } from '../src/tick-plugins'
import * as wind from '../src/combat/team-wind'
import { eyeOf } from '../src/pick'

const registry = require('minecraft-data')('1.21.11')
const Block = require('prismarine-block')(registry)
const v = (x: number, y: number, z: number) => new Vec3(x, y, z)
const arena = { x: -60.5, y: 40, z: -.5, r: 80, ellipse: { a: 77, b: 65 }, killY: 33 }
// Translated sections of the two-block opening. The fixture supplies no destination.
const sections = [
  ['#####...','#####...','#####...','####....','####....','####....'],
  ['######..','######..','######..','#####...','#####...','#####...'],
  ['...###..','...##S..','...##S..','..##S...','..##S...','..###...'],
  ['...###..','...##...','...##...','..##....','..##....','..###...'],
  ['...###..','...##...','...##...','..##....','..##....','..###...'],
  ['...###..','...##...','....#...','..#.....','..##....','..###...'],
  ['...###..','...##...','....#...','..#.....','..##....','..###...'],
  ['######..','#####...','#####...','####....','####....','#####...'],
  ['#####...','#####...','#####...','####....','####....','#####...']
]

function terrain(pos: Vec3, roof = false) {
  const p=pos.floored(), cell=roof&&p.x===11&&p.y===67&&p.z===10?'#':sections[p.y-62]?.[p.z-8]?.[p.x-8]
  const name=cell==='#'?'smooth_sandstone':cell==='S'?'smooth_sandstone_slab':'air'
  const block=Block.fromStateId(registry.blocksByName[name].defaultState,0);block.position=p;return block
}

function fixture(mode='normal'){
  const keys={}, slots=[], events=[], state={reads:0,punches:0,covered:true}, owner={name:'pvp'}
  if(mode!=='unarmed')slots[45]={name:'wind_charge',count:5}
  const entity={position:v(10.227,64,10.700),velocity:v(0,-.0784000015258789,0),onGround:true,height:1.8,width:.6,id:1,yaw:0,pitch:0,type:'player',name:'player',username:'Blue',attributes:{},effects:{}}
  const foe={position:v(11.7,67,10.3),width:.6,height:1.8,id:2,isValid:true,type:'player',username:'Red'}
  const bot: any=new EventEmitter(), session: any={bot,current:owner};let moved=v(0,0,0), pending=null, wallUnknown=false, roofChanged=false
  Object.assign(bot,{entity,username:'Blue',registry,food:20,health:20,version:'1.21.11',game:{minY:-64,height:384},inventory:{slots,items:()=>[]},entities:{},players:{},
    pathfinder:{setGoal:()=>{}},blockAt(p){state.reads++;return wallUnknown?null:terrain(p,roofChanged)},
    setControlState(k,value){keys[k]=value},getControlState(k){return !!keys[k]},clearControlStates(){for(const k of Object.keys(keys))keys[k]=false},
    _ndLaunchMovement:()=>moved.clone(),look(yaw,pitch){entity.yaw=yaw;entity.pitch=pitch
      if(pitch < -1 && !events.some(e=>e[0]==='aim')){
        events.push(['aim',entity.position.clone()])
        if(mode==='changed-owner')session.current={name:'other'}
        if(mode==='changed-packet')moved=v(.01,0,0)
        if(mode==='changed-terrain')wallUnknown=true
        if(mode==='changed-roof')roofChanged=true
        if(mode==='changed-sighting')foe.position=foe.position.offset(1,0,0)
        if(mode==='ally'){
          const ally={...foe,id:3,username:'Ally',position:entity.position.offset(-.25,0,0),velocity:v(0,0,0)}
          bot.entities[ally.id]=ally;bot.players.Ally={entity:ally,gamemode:0};bot._ndSwarmAllies=['Ally']
        }
      }
      return Promise.resolve()
    },
    activateItem(off){
      const direction=v(-Math.sin(entity.yaw)*Math.cos(entity.pitch),Math.sin(entity.pitch),-Math.cos(entity.yaw)*Math.cos(entity.pitch))
      const hit=wind.windBlockImpact(bot,eyeOf(bot),direction,6)
      assert.ok(hit,'self shot reached an observed floor')
      pending={burst:hit.burst,ticks:Math.ceil(hit.distance/wind.WIND.speed)}
      events.push(['use_item',entity.position.clone(),off])
      if(mode==='target-lost-in-flight')foe.isValid=false
    },
    async waitForTicks(n){
      for(let i=0;i<n;i++){
        if(pending&&pending.ticks--===0){entity.velocity=entity.velocity.plus(wind.windImpulse(bot,entity.position,pending.burst));pending=null}
        const before=entity.position.clone(), next=new (getPhysics().PlayerState)(bot,keys)
        bot.physics.simulatePlayer(next,{getBlock:terrain}).apply(bot)
        moved=entity.position.minus(before)
        if(mode==='reacquired'&&entity.position.z<10.55)state.covered=false
        bot.emit('physicsTick');bot.emit('ndMovementSent')
      }
      if(mode==='late-settle'&&n>1){
        moved=v(.01,0,0)
        setImmediate(()=>{events.push(['settled-receipt']);void bot.waitForTicks(1)})
      }
    }
  })
  bot.physics=getPhysics().Physics(registry,{getBlock:terrain})
  const ctx: any={bot,entity:foe,foeSeenPos:foe.position.clone(),AR:arena,arena,session,ctl:{aborted:false,onAbort:[]},
    after:()=>true,async punchThrough(){state.punches++;return false},ready:()=>false,rest:()=>{},punches:0,style:{punchLimit:1},aim:'target',
    pathing:true,pathTo:()=>events.push(['path-stopped']),routeInputs:()=>'fixed',vision:{visible:()=>!state.covered},used:s=>events.push(['used',s])}
  const turn = { d: 1.6, hidden: true, me: entity.position, now: 1, r: 1.82, theyEat: false, theyUp: false } as TurnFrame
  return {ctx,turn,state,events,entity,session,owner}
}

const throwsWind=x=>x.events.filter(e=>e[0]==='use_item')
test('ordinary failed hidden approach chooses an observed tangent, then a stationary self cast',async()=>{
  const f=fixture()
  assert.equal(await hiddenFoeTurn(f.ctx,f.turn),'next')
  assert.equal(f.state.punches,1);assert.equal(throwsWind(f).length,1)
  assert.ok(throwsWind(f)[0][1].z<10.55&&throwsWind(f)[0][1].y===64)
  assert.ok(f.entity.position.y>66.95,'stock leap settled above the wall')
  assert.equal(f.ctx.aim,'target');assert.equal(f.ctx.ctl.onAbort.length,0)
  await hiddenFoeTurn(f.ctx,f.turn);assert.equal(throwsWind(f).length,1)
})

for(const mode of ['reacquired','changed-owner','changed-packet','changed-terrain','changed-roof','changed-sighting','ally'])test('after the walk decline release when '+mode,async()=>{
  const f=fixture(mode)
  assert.equal(await hiddenFoeTurn(f.ctx,f.turn),'next')
  assert.equal(throwsWind(f).length,0);assert.ok(f.entity.position.z<10.55)
  assert.equal(f.ctx.ctl.onAbort.length,0)
})

test('crowd hold, unavailable charge or changed owner do not start the fallback',async()=>{
  for(const mode of ['crowd','unarmed','stolen','ordinary','square','invalid-ellipse']){
    const f=fixture(mode)
    if(mode==='crowd')f.ctx.crowd={hold:true}
    if(mode==='stolen')f.session._reflexState={active:{source:'shield'}}
    if(mode==='ordinary')f.ctx.AR=null
    if(mode==='square')f.ctx.arena={...arena,ellipse:undefined}
    if(mode==='invalid-ellipse')f.ctx.arena={...arena,ellipse:{a:77,b:0}}
    await hiddenFoeTurn(f.ctx,f.turn)
    assert.equal(f.events.length,0);assert.equal(f.ctx.hiddenVentTried,undefined)
    assert.equal(f.state.punches,mode==='crowd'?0:1)
  }
})

test('same hidden cell miss is cheap, and a newly observed cell or target life can try again',async()=>{
  const f=fixture();f.ctx.foeSeenPos=v(9.2,67,10.5);f.ctx.entity.position=f.ctx.foeSeenPos.clone()
  assert.equal(await hiddenFoeTurn(f.ctx,f.turn),undefined)
  const first=f.state.reads;assert.ok(first>50)
  assert.equal(await hiddenFoeTurn(f.ctx,f.turn),undefined)
  assert.ok(f.state.reads-first<first/2)
  assert.equal(throwsWind(f).length,0)
  f.ctx.foeSeenPos=v(11.7,67,10.3);f.ctx.entity.position=f.ctx.foeSeenPos.clone()
  assert.equal(await hiddenFoeTurn(f.ctx,f.turn),'next');assert.equal(throwsWind(f).length,1)
  f.ctx.entity={...f.ctx.entity}
  f.entity.position=v(10.227,64,10.7);f.entity.velocity=v(0,-.0784000015258789,0)
  assert.equal(await hiddenFoeTurn(f.ctx,f.turn),'next');assert.equal(throwsWind(f).length,2)
})

test('a new grounded approach cell reopens the same last-seen target',async()=>{
  const f=fixture();f.entity.position=v(9.75,64,10.7)
  assert.equal(await hiddenFoeTurn(f.ctx,f.turn),undefined);assert.equal(throwsWind(f).length,0)
  f.entity.position=v(10.227,64,10.7)
  assert.equal(await hiddenFoeTurn(f.ctx,f.turn),'next');assert.equal(throwsWind(f).length,1)
})

test('an observed upper stand still occluded from the last-seen body does not spend wind',async()=>{
  const f=fixture();f.ctx.foeSeenPos=v(12.7,67,10.3);f.ctx.entity.position=f.ctx.foeSeenPos.clone()
  assert.equal(await hiddenFoeTurn(f.ctx,f.turn),undefined)
  assert.deepEqual(f.events,[]);assert.equal(throwsWind(f).length,0)
})

test('one final native settle receipt recovers a still-moving walk result',async()=>{
  const f=fixture('late-settle');assert.equal(await hiddenFoeTurn(f.ctx,f.turn),'next')
  assert.ok(f.events.findIndex(e=>e[0]==='settled-receipt')<f.events.findIndex(e=>e[0]==='use_item'))
  assert.equal(throwsWind(f).length,1)
})

test('a spent charge stays on the safe landing under the same owner after target life ends',async()=>{
  const f=fixture('target-lost-in-flight');assert.equal(await hiddenFoeTurn(f.ctx,f.turn),'next')
  assert.equal(f.ctx.entity.isValid,false);assert.equal(throwsWind(f).length,1);assert.ok(f.entity.position.y>66.95)
})

function earlyFixture (digMs: number) {
  const f = fixture()
  f.entity.position = v(10.69, 64, 10.3)
  f.ctx.after = () => false
  f.ctx.bot.world = { raycast: () => terrain(v(11, 66, 10)) }
  f.ctx.EYE = 1.62
  f.ctx.tools = { bestFor: () => ({ ms: digMs }), breakFast: () => assert.fail('early lookup must not dig') }
  f.ctx.punchThrough = createTerrain(f.ctx).punchThrough
  return f
}

test('ordinary hidden route uses the still-open approach when the wall cannot be opened', async () => {
  const f = earlyFixture(10000)
  const result = await hiddenFoeTurn(f.ctx, f.turn)
  if (result !== 'next') {
    f.entity.position = v(10.7, 64, 9.873)
    f.ctx.after = () => true
    assert.equal(await hiddenFoeTurn(f.ctx, f.turn), undefined, 'ordinary side movement leaves the observed opening')
  }
  assert.equal(result, 'next')
  assert.equal(throwsWind(f).length, 1)
  assert.ok(f.entity.position.y > 66.95)
})

test('before reaction a cheap ordinary opening or a reachable strike has priority', async () => {
  const dig = earlyFixture(500)
  assert.equal(await hiddenFoeTurn(dig.ctx, dig.turn), undefined)
  assert.deepEqual(dig.events, [])
  const strike = earlyFixture(10000)
  strike.turn.inSight = true
  assert.equal(await hiddenFoeTurn(strike.ctx, strike.turn), undefined)
  assert.deepEqual(strike.events, [])
})
