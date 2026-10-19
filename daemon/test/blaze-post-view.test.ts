import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(data as any)
import pick = require('../src/pick')
import { choosePost, windowForPost } from '../src/blaze'

// Native E21 local slice captured before the isolated scene. It has a supported
// one-step exit at 202,65,-108; the suggested diagonal climb floor is absent.
const layers = [
  ['0001111','0000001','1111111','2222222','2221222','2222221','2222222','2222222'],
  ['0000010','0000001','1110011','2221022','1220222','1222221','1222222','2222222'],
  ['0000000','0001100','1110111','2221022','1121222','1322220','1322222','2222222'],
  ['0000000','0001100','1122122','1221011','1111111','1111411','1333111','1221111'],
  ['0000000','0000000','1155555','1151111','1331311','1113311','1311111','3151111'],
  ['0000000','0000000','1111111','1311111','1311111','1333111','3311111','3111111']
]
const names = ['netherrack','air','nether_bricks','glowstone','spawner','nether_brick_fence']
function fixture () {
  const cells = new Map<string,string>()
  layers.forEach((rows,dy)=>rows.forEach((row,dz)=>[...row].forEach((n,dx)=>cells.set(`${199+dx},${63+dy},${-112+dz}`, names[Number(n)]))))
  const bot: any = {
    entity: { position:new Vec3(202.5,64,-108.5), onGround:true }, registry:data,
    blockAt (p: any) {
      const c=p.floored(), name=cells.get(`${c.x},${c.y},${c.z}`) || 'air'
      const b=Block.fromStateId(data.blocksByName[name].defaultState,0); b.position=c; return b
    }
  }
  bot.inventory={items:()=>[]}
  bot.canDigBlock=(b:any)=>b.position.offset(.5,.5,.5).distanceTo(bot.entity.position.offset(0,1.62,0))<=4.5
  bot.world={raycast:(eye:any,dir:any,range:number,matcher:any)=>{
    const projection={blockAt:(p:any)=>{
      const b=bot.blockAt(p)
      if(!matcher || matcher(b))return b
      const air=Block.fromStateId(data.blocksByName.air.defaultState,0);air.position=b.position;return air
    }}
    return pick.blockOnRay(projection,eye,dir,range)?.block || null
  }}
  return bot
}

test('blaze: a supported nearby post with a better eye view survives the old-post cost', () => {
  const bot=fixture(), spawner=new Vec3(203,66,-107)
  const best=choosePost(bot,spawner,bot.entity.position.floored())
  assert.ok(best, 'a one-step exit is a real alternative to the ineffective diagonal climb')
  assert.deepEqual([best.pos.x,best.pos.y,best.pos.z],[202,65,-108])
  assert.equal(best.view,6)
  assert.equal(bot.blockAt(best.pos.offset(0,-1,0)).boundingBox,'block')
  assert.equal(bot.blockAt(best.pos).boundingBox,'empty')
  assert.equal(bot.blockAt(best.pos.offset(0,1,0)).boundingBox,'empty')
})

test('blaze: the walkable start node does not make an unsupported post valid', () => {
  const bot=fixture(); bot.entity.position=new Vec3(207.5,66,-107.5)
  bot.world.raycast=()=>null
  assert.equal(choosePost(bot,new Vec3(203,66,-107)),null)
})

test('blaze: the known spawn volume offers one visible reachable window from the reached post', () => {
  const bot=fixture();bot.entity.position=new Vec3(202.5,65,-107.5)
  Object.defineProperty(bot,'entities',{get:()=>{throw new Error('a hidden mob position is not a window target')}})
  const plan=windowForPost(bot,new Vec3(203,66,-107))
  assert.ok(plan,'a physical alternative to repeating the same post')
  assert.deepEqual([plan.pos.x,plan.pos.y,plan.pos.z],[202,67,-107])
  assert.equal(bot.blockAt(plan.pos).name,'glowstone')
  assert.ok(pick.blockSeen(bot,plan.pos,{range:4.5}))
  assert.ok(plan.gain>0)
})

test('blaze: a window cannot target an unreachable block, a floating cell, or an unknown spawner', () => {
  const bot=fixture();bot.entity.position=new Vec3(202.5,65,-107.5)
  bot.canDigBlock=()=>false
  assert.equal(windowForPost(bot,new Vec3(203,66,-107)),null)
  bot.canDigBlock=()=>true;bot.entity.position=new Vec3(207.5,66,-107.5)
  assert.equal(windowForPost(bot,new Vec3(203,66,-107)),null)
  assert.equal(windowForPost(bot,null),null)
})

test('blaze: one-block planning does not see through the second wall of a sealed cell', () => {
  const bot=fixture();bot.entity.position=new Vec3(.5,64,.5)
  bot.blockAt=(p:any)=>{
    const c=p.floored(),r=Math.max(Math.abs(c.x),Math.abs(c.z))
    const shell=(r>=1&&r<=2&&c.y>=62&&c.y<=68)||(r<=2&&(c.y===62||c.y===63||c.y===66||c.y===67))
    const b=Block.fromStateId(data.blocksByName[shell?'nether_bricks':'air'].defaultState,0);b.position=c;return b
  }
  assert.equal(windowForPost(bot,new Vec3(0,64,6)),null)
})
