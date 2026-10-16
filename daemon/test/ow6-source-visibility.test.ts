import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
const Vec3 = require('vec3')
const registry = require('prismarine-registry')('1.21.11')
const Block = require('prismarine-block')(registry)
const World = require('prismarine-world')('1.21.11')
const { visibleSources } = require('../src/obsidian')
const { liveLava } = require('../src/cast')
const { judge1, geom1 } = require('../src/cast1')

function waterWorld() {
  const cells = new Map<string, any>(), waters: any[] = []
  const read = p => {
    p=p.floored(); const b=Block.fromStateId(cells.get(p.toString()) ?? registry.blocksByName.air.defaultState)
    b.position=p; return b
  }
  const put = (x,y,z,name,props={}) => {
    const p=new Vec3(x,y,z),b=Block.fromProperties(name,props,0)
    cells.set(p.toString(),b.stateId); if(name==='water')waters.push(p)
  }
  // 400 closer sources sealed in a rock box. The visible pond is beyond them.
  for(let x=1;x<=10;x++)for(let y=59;y<=62;y++)for(let z=-4;z<=5;z++)put(x,y,z,'water',{level:0})
  for(let x=-1;x<=12;x++)for(let y=57;y<=64;y++)for(let z=-6;z<=7;z++)
    if(x<1||x>10||y<59||y>62||z< -4||z>5)put(x,y,z,'stone')
  put(-20,65,0,'water',{level:0}); put(-3,65,0,'water',{level:3})
  const world=new World().sync; world.getBlock=read
  world.getColumn=(cx,cz)=>({getBlockStateId:p=>read(new Vec3(cx*16+p.x,p.y,cz*16+p.z)).stateId})
  const bot={registry,game:{minY:-64,height:384},entity:{position:new Vec3(-1.5,65,0.5),eyeHeight:1.62},world,blockAt:read,
    findBlocks:({count})=>waters.slice().sort((a,b)=>a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position)).slice(0,count)}
  return {bot,put}
}
test('bucket sees a source beyond 400 occluded cells and skips a nearer flow',()=>{
  const {bot}=waterWorld()
  assert.deepEqual(visibleSources(bot,'water',32).map(b=>b.position.toArray()),[[-20,65,0]])
})
test('bucket does not promote a hidden source, and still accepts a nearby visible source',()=>{
  const {bot,put}=waterWorld()
  put(-10,64,-3,'stone'); put(-10,65,-3,'stone'); put(-10,66,-3,'stone')
  put(-2,65,2,'water',{level:0})
  const out=visibleSources(bot,'water',32)
  assert.ok(out.some(b=>b.position.equals(new Vec3(-2,65,2))))
  assert.ok(out.every(b=>b.position.x<0),'sealed box stays unseen')
})

test('water switch restores the old pre-visibility cutoff for the paired control',()=>{
  const {bot}=waterWorld(),previous=process.env.ND_OW_KIT_WATER
  try {
    process.env.ND_OW_KIT_WATER='0'
    assert.deepEqual(visibleSources(bot,'water',32),[])
  } finally {
    if(previous===undefined)delete process.env.ND_OW_KIT_WATER;else process.env.ND_OW_KIT_WATER=previous
  }
})
test('two-bucket refills do not turn a connected hidden lake into a walking target',()=>{
  const {bot,put}=waterWorld()
  for(let x=-1;x<=12;x++)for(let z=-6;z<=7;z++)put(x,64,z,'stone')
  for(let x=6;x<=9;x++)for(let z=0;z<=3;z++)put(x,64,z,'lava',{level:0})
  for(let y=65;y<=69;y++)for(let z=-6;z<=7;z++)put(3,y,z,'stone')
  const seeds=[new Vec3(6,64,0)],ref=bot.entity.position
  assert.equal(liveLava(bot,seeds,ref).length,0)
  for(let y=65;y<=69;y++)for(let z=-6;z<=7;z++)put(3,y,z,'air')
  assert.ok(liveLava(bot,seeds,ref).length>0)
})

test('ten reachable sources suffice; the frame switch restores the old eleven-source reserve',()=>{
  const read=p=>{
    p=p.floored()
    const lava=p.y===64&&p.x>=3&&p.x<=4&&p.z>=-2&&p.z<=2
    const b=Block.fromProperties(lava?'lava':p.y<=64?'stone':'air',lava?{level:0}:{},0)
    b.position=p;return b
  }
  const g=geom1(new Vec3(0,65,0),'z',1),previous=process.env.ND_OW_KIT_FRAME
  assert.equal(judge1(read,g).plan?.lava,10)
  try {
    process.env.ND_OW_KIT_FRAME='0'
    assert.equal(judge1(read,g).plan,undefined)
  } finally {
    if(previous===undefined)delete process.env.ND_OW_KIT_FRAME;else process.env.ND_OW_KIT_FRAME=previous
  }
})
