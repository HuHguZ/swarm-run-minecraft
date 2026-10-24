import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { worldOf, Block, registry, native } from './parkour-fixture'
import { dropOptions, runDrop } from '../src/flee-drop'
import { installFallGuard } from '../src/edges/mlg'
import { landingDamage } from '../src/navigation/landing'
import * as reflex from '../src/reflex-lock'
import * as clock from '../src/game-clock'

function fixture(height = 40, radius = 12) {
  const cells: Array<[number,number,number,string]> = []
  for (let x=-radius;x<=radius;x++) for(let z=-radius;z<=radius;z++) cells.push([x,119,z,'stone'])
  for (let x=-2;x<=0;x++) for(let z=-1;z<=1;z++) cells.push([x,119+height,z,'stone'])
  const {bot,world}=worldOf(cells)
  bot.entity.position=new Vec3(.98,120+height,.5)
  bot.entity.height=1.8;bot.entity.eyeHeight=1.62;bot.entity.type='player';bot.entity.metadata=[]
  bot.inventory.items=()=>bot.inventory.slots.filter(Boolean)
  bot.clearControlStates=()=>{};bot.setControlState=()=>{};bot.look=async()=>{}
  const arena={x:0,y:120,z:0,r:radius,killY:110}
  const price=(_end,hurt,ticks)=>60*hurt/(bot.health-hurt)+ticks
  const options=()=>dropOptions(bot,arena,price)
  return {bot,world,arena,options}
}

async function nativeDrop(technique, abort=false, unready=false) {
  const f=fixture(), game=clock.activate(new clock.GameClock({manual:true,epoch:1000}))
  const oldClutch=process.env.ND_CLUTCH, overlay=new Map(), packets=[]
  const controls={forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false}
  const raw=f.world.getBlock
  f.world.getBlock=p=>overlay.get(p.floored().toString()) || raw(p)
  const put=(p,name)=>{
    const b=Block.fromStateId(registry.blocksByName[name].defaultState);b.position=p.floored();overlay.set(b.position.toString(),b)
  }
  f.bot.game.gameMode='survival';f.bot.game.dimension=technique==='cobweb'?'minecraft:the_nether':'minecraft:overworld'
  f.bot._client=new EventEmitter();f.bot.quickBarSlot=0
  f.bot.inventory=Object.assign(new EventEmitter(),{slots:[],items:()=>f.bot.inventory.slots.filter(Boolean)})
  f.bot.inventory.slots[36]={name:technique==='cobweb'?'cobweb':'water_bucket',slot:36,count:2}
  f.bot.heldItem=f.bot.inventory.slots[36]
  f.bot.setQuickBarSlot=slot=>{f.bot.quickBarSlot=slot;f.bot.heldItem=f.bot.inventory.slots[36+slot]}
  f.bot.equip=async()=>{}
  f.bot.look=async(yaw,pitch)=>{f.bot.entity.yaw=yaw;f.bot.entity.pitch=pitch}
  f.bot.setControlState=(key,value)=>{controls[key]=value}
  f.bot.getControlState=key=>controls[key]
  f.bot.clearControlStates=()=>{for(const key of Object.keys(controls)) controls[key]=false}
  f.bot.activateItem=()=>{
    const held=f.bot.heldItem.name;f.bot._client.write('use_item',{held})
    const p=f.bot.entity.position.floored();p.y=120
    if(held==='water_bucket') put(p,'water');else overlay.delete(p.toString())
    f.bot.inventory.slots[36]={name:held==='water_bucket'?'bucket':'water_bucket',slot:36};f.bot.heldItem=f.bot.inventory.slots[36]
  }
  f.bot._genericPlace=(ref,face)=>{f.bot._client.write('block_place',{held:f.bot.heldItem.name});put(ref.position.plus(face),'cobweb')}
  f.bot._client.write=(name,data)=>{packets.push({name,...data,planned:!!f.bot._ndParkourForecast})}
  try {
    process.env.ND_CLUTCH='0'
    const guard=installFallGuard({bot:f.bot})
    if(oldClutch==null) delete process.env.ND_CLUTCH;else process.env.ND_CLUTCH=oldClutch
    const session={bot:f.bot};reflex.install(session)
    const choice=f.options().find(o=>o.drop.technique===technique);assert.ok(choice)
    let result,contact=false
    const ctl={aborted:false,onAbort:[]}
    const done=runDrop(f.bot,ctl,choice,{allow(_drop,ms){f.bot._ndClutchAllowUntil=game.now()+ms}},f.arena).then(ok=>{result=ok})
    for(let t=0;t<160 && (result===undefined || t<choice.drop.plan.ticks+10);t++) {
      const state=new native.PlayerState(f.bot,controls)
      f.bot.physics.simulatePlayer(state,f.world);state.apply(f.bot)
      if(unready && t===1) {f.bot.inventory.slots[36]=null;f.bot.heldItem=null}
      contact ||= technique==='water'?f.bot.entity.isInWater:f.bot.entity.isInWeb
      game.advanceTicks(1);f.bot.emit('physicsTick');f.bot.emit('ndMovementSent')
      await new Promise<void>(r=>setImmediate(r))
      if(unready && result!==undefined) break
      if(abort && !ctl.aborted && state.pos.y<choice.drop.from.y-6) {ctl.aborted=true;for(const fn of [...ctl.onAbort]) fn()}
    }
    assert.equal(result,!abort && !unready,'контроллер доводит до контакта либо подтверждает отмену')
    await done
    if(unready) {assert.equal(packets.length,0);assert.equal(guard.saved,0);return}
    assert.equal(contact,true)
    const sent=packets.filter(p=>p.name===(technique==='water'?'use_item':'block_place') && p.held===(technique==='water'?'water_bucket':'cobweb'))
    assert.equal(sent.length,1,'освобождённый план не ставит повторно после квитанции')
    assert.equal(sent[0].planned,!abort,'MLG работает под forecastOwner/guard.allow и после отмены')
    assert.equal(guard.saved,1);assert.equal(guard.missed,0)
  } finally {if(oldClutch==null) delete process.env.ND_CLUTCH;else process.env.ND_CLUTCH=oldClutch;game.dispose();clock.activate(null)}
}

test('ведро даёт глубокий спуск по готовности, цене промаха и хп; до схода обязателен planWater', async()=>{
  const f=fixture(), game=clock.activate(new clock.GameClock({manual:true,epoch:1000}))
  let ready=true
  f.bot.inventory.slots[36]={name:'water_bucket',slot:36}
  f.bot._ndFallGuard={waterReady:()=>({ok:ready}),saved:20,missed:0,planWater:()=>null}
  try {
    const get=()=>f.options().find(o=>o.drop.technique==='water')
    const good=get();assert.ok(good);assert.equal(good.end.y,120);assert.ok(good.drop.hurt>0)
    f.bot._ndFallGuard.missedAt=game.now();assert.ok(get().cost>good.cost)
    delete f.bot._ndFallGuard.missedAt
    f.bot.health=5;assert.ok(get().cost>good.cost,'смертельный промах дороже на малом хп')
    f.bot.health=20;ready=false;assert.equal(get(),undefined)
    ready=true;f.bot.game.dimension='minecraft:the_nether';assert.equal(get(),undefined)
    f.bot.game.dimension='minecraft:overworld'
    const raw=f.bot.blockAt
    f.bot.blockAt=p=>p.y===119 ? Object.assign(Block.fromStateId(registry.blocksByName.oak_leaves.defaultState),{position:p.floored()}) : raw(p)
    assert.equal(get(),undefined,'вода не спасает на waterlogged опоре')
    f.bot.blockAt=raw
    assert.equal(await runDrop(f.bot,{aborted:false},good,{allow(){assert.fail('не шагать без взведения')}},f.arena),false)
    f.bot._ndFallGuard.planWater=()=>()=>{}
    const falling=runDrop(f.bot,{aborted:false,onAbort:[]},good,{allow(){}},f.arena)
    f.bot.entity.position=new Vec3(good.end.x,110,good.end.z);f.bot.entity.onGround=false;f.bot.entity.isInWater=true
    f.bot.emit('physicsTick');assert.equal(await falling,false,'вода ниже killY не делает ход успешным')
    f.bot.entity.position=good.drop.from.clone();f.bot.entity.onGround=true;f.bot.entity.isInWater=false
    f.arena.killY=120;assert.equal(get(),undefined)
  } finally {game.dispose();clock.activate(null)}
  for(const abort of [false,true]) await nativeDrop('water',abort)
  await nativeDrop('water',false,true)
})

test('паутина в хотбаре даёт спуск в Аду, но рюкзак и негодный исполнитель его не разрешают',async()=>{
  const f=fixture()
  f.bot.game.dimension='minecraft:the_nether'
  f.bot.inventory.slots[36]={name:'cobweb',slot:36,count:1}
  f.bot._ndFallGuard={webReady:()=>({ok:true}),saved:20,missed:0}
  const get=()=>f.options().find(o=>o.drop.technique==='cobweb')
  assert.ok(get());assert.equal(get().end.y,120)
  f.bot.inventory.slots[10]=f.bot.inventory.slots[36];f.bot.inventory.slots[36]=null
  assert.equal(get(),undefined)
  f.bot.inventory.slots[36]=f.bot.inventory.slots[10]
  f.bot._ndFallGuard.webReady=()=>({ok:false});assert.equal(get(),undefined)
  for(const abort of [false,true]) await nativeDrop('cobweb',abort)
  await nativeDrop('cobweb',false,true)
})

test('элитры дают безракетный спуск только с полной безопасной посадкой и исправным крылом',async()=>{
  const f=fixture(8,30)
  f.bot.inventory.slots[6]={name:'elytra',slot:6,durabilityUsed:0}
  const get=()=>f.options().find(o=>o.drop.technique==='elytra')
  const good=get();assert.ok(good);assert.ok(good.drop.glide.r.kind==='floor');assert.ok(good.drop.glide.damageRaw>0)
  assert.ok(good.drop.hurt>=good.drop.glide.damageRaw,'остаточный урон полёта входит в цену')
  assert.ok(good.end.y>=f.arena.y);assert.ok(good.cost>0)
  f.bot.inventory.slots[6].durabilityUsed=registry.itemsByName.elytra.maxDurability-1
  assert.equal(get(),undefined)
  f.bot.inventory.slots[6].durabilityUsed=0
  f.arena.killY=120;assert.equal(get(),undefined)
  await nativeGlide()
  await nativeGlide(false)
})

async function nativeGlide(wearing=true) {
  const {bot,world,arena}=fixture(8,30)
  const wing={ name: 'elytra', slot: wearing?6:36, durabilityUsed: 0 }
  bot.inventory.slots[6] = wearing?wing:{name:'diamond_chestplate',slot:6}
  if(!wearing) bot.inventory.slots[36]=wing
  bot.quickBarSlot=0;bot.heldItem=bot.inventory.slots[36]
  bot.setQuickBarSlot=slot=>{bot.quickBarSlot=slot;bot.heldItem=bot.inventory.slots[36+slot]}
  bot.activateItem=()=>{
    assert.equal(bot.entity.onGround,true,'элитры надеваются до схода, нагрудник возвращается на земле')
    const slot=36+bot.quickBarSlot
    ;[bot.inventory.slots[6],bot.inventory.slots[slot]]=[bot.inventory.slots[slot],bot.inventory.slots[6]]
    bot.heldItem=bot.inventory.slots[slot]
    bot._client.write('use_item')
  }
  bot.inventory.items = () => bot.inventory.slots.filter(Boolean)
  bot._ndReflexSession = { bot }
  bot._client = new EventEmitter()
  const packets: string[] = []
  bot._client.write = (name: string) => { packets.push(name) }
  bot.supportFeature = () => false
  let controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }
  bot.clearControlStates = () => { for (const key of Object.keys(controls)) controls[key] = false }
  bot.setControlState = (key: string, value: boolean) => { controls[key] = value }
  bot.look = async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  const get = () => dropOptions(bot, arena, (_end, hurt, ticks) => hurt + ticks).find(o => o.drop.technique === 'elytra')
  const good = get()
  assert.ok(good)
  assert.ok(good.drop.glide.damageRaw > 0, 'крыло не отменяет сухие восемь блоков падения')
  assert.ok(good.drop.hurt >= good.drop.glide.damageRaw)
  bot.health = 4; assert.equal(get(), undefined, 'смертельный оплаченный урон недопустим'); bot.health = 20
  const game = new clock.GameClock({ manual: true }); clock.activate(game)
  let settled = false, result: boolean | undefined
  const operation = runDrop(bot, { aborted: false, onAbort: [] }, good, { allow() {} }, arena)
    .then(ok => { settled = true; result = ok })
  let fall = 0, contact: number | null = null
  try {
    await new Promise<void>(resolve=>setImmediate(resolve))
    for (let tick = 0; tick < 280 && !settled; tick++) {
      game.advanceTicks(1)
      // После касания только даём истечь ожиданию land(), не добавляем лишних игровых шагов.
      if (contact === null) {
        const oldY = bot.entity.position.y
        const state = new native.PlayerState(bot, controls)
        bot.physics.simulatePlayer(state, world); state.apply(bot)
        fall = bot.entity.position.y > oldY ? 0 : fall + Math.max(0, oldY - bot.entity.position.y)
        if (bot.entity.onGround && bot.entity.position.y <= 120.01) {
          const floor = world.getBlock(bot.entity.position.offset(0, -.01, 0))
          contact = landingDamage(floor, fall, bot.entity.attributes)
          bot.health -= contact
        }
        bot.emit('physicsTick')
      }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    assert.ok(settled, 'посадка должна завершиться за конечное число тиков')
    await operation
    assert.equal(result, true)
    assert.ok(packets.includes('entity_action'), 'элитры раскрыты настоящим клиентским пакетом')
    assert.ok(contact !== null && contact <= good.drop.glide.damageRaw, 'прогноз покрывает нативный урон касания')
    assert.equal(bot.entity.position.y, 120)
    assert.ok(Math.abs(bot.entity.position.x) < arena.r && Math.abs(bot.entity.position.z) < arena.r)
    assert.equal(bot.fireworkRocketDuration, 0)
    if(!wearing) assert.equal(bot.inventory.slots[6]?.name,'diamond_chestplate')
  } finally { game.dispose(); clock.activate(null) }
}
