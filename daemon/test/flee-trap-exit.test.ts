import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { worldOf, Block, registry, native } from './parkour-fixture'
import { dropOptions, runDrop } from '../src/flee-drop'
import * as clock from '../src/game-clock'
import { pickDirection } from '../src/flee'

// Пол прозрачен: дно и весь объём падения действительно видны до копки.
test('ловушка: видимый пол копается по цене времени, серверной квитанции и взведённому MLG', async () => {
  const cells: Array<[number,number,number,string]> = [[0,159,0,'glass']]
  for (let x=-8;x<=8;x++) for (let z=-8;z<=8;z++) cells.push([x,119,z,'stone'])
  const {bot,world}=worldOf(cells), game=clock.activate(new clock.GameClock({manual:true,epoch:1000}))
  const raw=world.getBlock, removed=new Set<string>(), controls={forward:false,back:false,left:false,right:false,jump:false,sprint:false,sneak:false}
  world.getBlock=p=>removed.has(p.floored().toString()) ? Object.assign(Block.fromStateId(registry.blocksByName.air.defaultState),{position:p.floored()}) : raw(p)
  bot.entity.position=new Vec3(.5,160,.5);bot.entity.type='player';bot.entity.metadata=[]
  bot._client=new EventEmitter();bot.inventory.items=()=>bot.inventory.slots.filter(Boolean)
  bot.inventory.slots[36]={name:'water_bucket',slot:36};bot.heldItem=bot.inventory.slots[36]
  bot.look=async(yaw,pitch)=>{bot.entity.yaw=yaw;bot.entity.pitch=pitch}
  bot.lookAt=async()=>{};bot.equip=async()=>{};bot.stopDigging=()=>{}
  bot.setControlState=(key,value)=>{controls[key]=value}
  bot.clearControlStates=()=>{for (const key of Object.keys(controls)) controls[key]=false}
  let armed=false, reject=false, receipt=false, movedBeforeReceipt=false, releases=0
  bot._ndFallGuard={saved:20,missed:0,waterReady:()=>({ok:true}),planWater:()=>{armed=true;return()=>{armed=false;releases++}}}
  bot.dig=async block=>{
    assert.ok(armed,'MLG взведён до разрушения собственной опоры')
    if (!reject) bot.health-=2
    removed.add(block.position.toString())
    setImmediate(()=>{
      receipt=true
      if (reject) removed.delete(block.position.toString())
      bot._client.emit('block_change',{location:block.position,type:registry.blocksByName[reject?'glass':'air'].defaultState})
    })
  }
  const arena={x:0,y:120,z:0,r:9,killY:110}
  const choose=(weight=1)=>dropOptions(bot,arena,(_end,hurt,ticks)=>hurt+weight*ticks).find(o=>o.drop.dig?.blocks.some(b=>b.position.equals(new Vec3(0,159,0))) && o.drop.technique==='water')
  try {
    const good=choose();assert.ok(good,'копание видимой опоры добавляет вариант вместо lastStand')
    assert.ok(good.drop.dig.ms>=400)
    assert.ok(choose(3).cost>good.cost,'время неподвижной копки оплачивается')
    const underlying=bot.blockAt
    bot.blockAt=p=>p.y===159 ? Object.assign(Block.fromStateId(registry.blocksByName.stone.defaultState),{position:p.floored()}) : underlying(p)
    assert.equal(choose(),undefined,'неизвестный объём под непрозрачным полом не становится воздухом')
    bot.blockAt=underlying
    const reports=[]
    const done=runDrop(bot,{aborted:false,onAbort:[]},good,{allow(){}},arena,(r)=>reports.push(r))
    let settled=false,result
    done.then(r=>{settled=true;result=r})
    for (let t=0;t<200 && !settled;t++) {
      await new Promise<void>(r=>setImmediate(r))
      if (!receipt && Object.values(controls).some(Boolean)) movedBeforeReceipt=true
      const st=new native.PlayerState(bot,controls);bot.physics.simulatePlayer(st,world);st.apply(bot)
      if (bot.entity.position.y<123 && !bot.entity.onGround) bot.entity.isInWater=true
      game.advanceTicks(1);bot.emit('physicsTick')
    }
    await done
    assert.equal(result,true);assert.equal(movedBeforeReceipt,false)
    assert.equal(reports.length,1);assert.ok(reports[0].height>3);assert.equal(reports[0].technique,'вода')
    assert.equal(releases,1)
    bot.entity.position=new Vec3(.5,160,.5);bot.entity.velocity=new Vec3(0,0,0);bot.entity.onGround=true;bot.entity.isInWater=false
    removed.clear();reject=true;receipt=false
    assert.equal(await runDrop(bot,{aborted:false,onAbort:[]},choose(),{allow(){}},arena),false,'отказ сервера не считается проломом')
    assert.equal(armed,false)

    // За невысокой стеной видно опору; низкая крыша исключает прыжок через неё.
    const wallCells: Array<[number,number,number,string]> = [[1,120,0,'glass'],[0,122,0,'stone']]
    for (let x=-4;x<=4;x++) for (let z=-4;z<=4;z++) wallCells.push([x,119,z,'stone'])
    const wall=worldOf(wallCells), readWall=wall.bot.blockAt, open=new Set<string>()
    wall.bot.entity.position=new Vec3(.5,120,.5)
    wall.bot.blockAt=p=>open.has(p.floored().toString()) ? Object.assign(Block.fromStateId(registry.blocksByName.air.defaultState),{position:p.floored()}) : readWall(p)
    wall.bot._client=new EventEmitter();wall.bot.lookAt=async()=>{};wall.bot.stopDigging=()=>{}
    wall.bot.look=bot.look;wall.bot.setControlState=bot.setControlState;wall.bot.clearControlStates=bot.clearControlStates
    wall.bot.dig=async b=>{open.add(b.position.toString());wall.bot._client.emit('block_change',{location:b.position,type:registry.blocksByName.air.defaultState})}
    const exit=dropOptions(wall.bot,arena,(_end,hurt,ticks)=>hurt+ticks).find(o=>o.drop.exit && o.end.x>2)
    assert.ok(exit,'выломать стену — отдельный наземный вариант с ценой копки')
    wall.bot.look=async(yaw,pitch)=>{wall.bot.entity.yaw=yaw;wall.bot.entity.pitch=pitch}
    let exited, wallReports=0
    const leave=runDrop(wall.bot,{aborted:false,onAbort:[]},exit,{allow(){}},arena,()=>wallReports++).then(ok=>{exited=ok})
    for (let t=0;t<100 && exited===undefined;t++) {
      await new Promise<void>(r=>setImmediate(r))
      const st=new native.PlayerState(wall.bot,controls)
      wall.bot.physics.simulatePlayer(st,{getBlock:p=>wall.bot.blockAt(p)});st.apply(wall.bot)
      game.advanceTicks(1);wall.bot.emit('physicsTick')
    }
    await leave;assert.equal(exited,true);assert.ok(wall.bot.entity.position.x>2)
    assert.equal(wallReports,0,'выход на том же ярусе не является спуском')

    // Непрозрачная коробка не даёт знать пол снаружи: сначала отверстие для взгляда, затем новый план.
    const boxCells: Array<[number,number,number,string]> = [[0,122,0,'cobblestone']]
    for (let x=-8;x<=8;x++) for (let z=-8;z<=8;z++) boxCells.push([x,119,z,'cobblestone'])
    for (const [x,z] of [[1,0],[-1,0],[0,1],[0,-1]]) for (const y of [120,121]) boxCells.push([x,y,z,'cobblestone'])
    const box=worldOf(boxCells), readBox=box.bot.blockAt, holes=new Set<string>(), mined=[]
    box.bot.entity.position=new Vec3(.5,120,.5)
    box.bot.blockAt=p=>holes.has(p.floored().toString()) ? Object.assign(Block.fromStateId(registry.blocksByName.air.defaultState),{position:p.floored()}) : readBox(p)
    box.bot._client=new EventEmitter();box.bot.lookAt=async()=>{};box.bot.stopDigging=()=>{}
    box.bot.inventory.slots[36]={name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,slot:36}
    box.bot.inventory.items=()=>box.bot.inventory.slots.filter(Boolean);box.bot.heldItem=box.bot.inventory.slots[36]
    box.bot.look=async(yaw,pitch)=>{box.bot.entity.yaw=yaw;box.bot.entity.pitch=pitch}
    box.bot.setControlState=bot.setControlState;box.bot.clearControlStates=bot.clearControlStates
    box.bot.dig=async b=>{
      assert.ok(b.position.y>=120,'свою неизвестную опору не копаем')
      mined.push(b.position.clone());holes.add(b.position.toString())
      box.bot._client.emit('block_change',{location:b.position,type:registry.blocksByName.air.defaultState})
    }
    const hs=[{e:{username:'Foe',position:new Vec3(.5,120,.7)},d:.2,doc:{radius:8,weight:8,fast:true}}]
    const chooseBox=()=>pickDirection(box.bot,hs,null,[],arena,null,true)
    assert.ok(dropOptions(box.bot,arena,(_end,_hurt,ticks)=>ticks).some(o=>o.drop.inspect),'видимая непрозрачная стена допускает безопасное отверстие для обзора')
    let next=chooseBox()
    assert.ok(next?.drop?.inspect,'настоящий выбор бегства вскрывает непрозрачную стену вместо вечного lastStand')
    box.bot.inventory.slots[36]=null;box.bot.heldItem=null
    assert.ok(!chooseBox()?.drop?.inspect,'медленная копка рукой проигрывает трём секундам боя на месте')
    box.bot.inventory.slots[36]={name:'diamond_pickaxe',type:registry.itemsByName.diamond_pickaxe.id,slot:36};box.bot.heldItem=box.bot.inventory.slots[36]
    for (let stage=0;stage<2 && next?.drop?.inspect;stage++) {
      assert.equal(await runDrop(box.bot,{aborted:false,onAbort:[]},next,{allow(){}},arena,()=>wallReports++),true)
      assert.deepEqual(box.bot.entity.position,new Vec3(.5,120,.5))
      assert.equal(box.bot.blockAt(new Vec3(0,119,0)).name,'cobblestone')
      next=chooseBox()
    }
    assert.equal(mined.length,2,'голова и ноги открываются отдельными подтверждёнными шагами')
    assert.ok(next && !next.drop?.inspect,`после получения обзора есть настоящий маршрут выхода: ${JSON.stringify({mined,next:next&&{inspect:next.drop?.inspect,end:next.end,dig:next.drop?.dig}})}`)
    assert.equal(wallReports,0,'осмотр через стену не выдаёт квитанцию падения')

    // Отмена контроллера не отменяет уже начатое физическое падение.
    for (const abortAt of ['до схода','сразу после схода','в воздухе']) {
      const fallCells: Array<[number,number,number,string]> = [[0,127,0,'stone']]
      for (let x=-8;x<=8;x++) for (let z=-8;z<=8;z++) fallCells.push([x,119,z,'stone'])
      const fall=worldOf(fallCells), receipts=[], cancel={aborted:false,onAbort:[]}, timerCount=game.timers.size
      fall.bot.entity.position=new Vec3(.98,128,.5)
      fall.bot.look=async(yaw,pitch)=>{fall.bot.entity.yaw=yaw;fall.bot.entity.pitch=pitch}
      let writes=0
      fall.bot.setControlState=(key,value)=>{controls[key]=value;writes++}
      fall.bot.clearControlStates=()=>{for (const key of Object.keys(controls)) controls[key]=false;writes++}
      const option=dropOptions(fall.bot,arena,(_end,hurt,ticks)=>hurt+ticks).find(o=>!o.drop.dig && !o.drop.technique)
      assert.ok(option)
      const operation=runDrop(fall.bot,cancel,option,{allow(){}},arena,r=>receipts.push(r))
      const otherOwner={newOwner:true}
      const stop=()=>{
        cancel.aborted=true;for (const fn of [...cancel.onAbort]) fn()
        fall.bot._ndParkourForecast=otherOwner;writes=0
      }
      if (abortAt==='до схода') stop()
      for (let t=0;t<100;t++) {
        const st=new native.PlayerState(fall.bot,controls)
        fall.bot.physics.simulatePlayer(st,fall.world);st.apply(fall.bot)
        game.advanceTicks(1);fall.bot.emit('physicsTick')
        if (!cancel.aborted && (abortAt==='сразу после схода' ? fall.bot.entity.position.x>1.3 && !fall.bot.entity.onGround && fall.bot.entity.velocity.y<0 : fall.bot.entity.position.y<127.5)) {
          assert.ok(fall.bot.entity.position.y>125,'отмена происходит до трёх блоков падения')
          stop();assert.equal(receipts.length,0)
        }
        if (cancel.aborted && fall.bot.entity.onGround) break
      }
      assert.equal(await operation,false)
      assert.equal(receipts.length,abortAt==='до схода'?0:1,'каждое начатое падение имеет одну квитанцию после отмены')
      if (receipts.length) {assert.equal(receipts[0].height,8);assert.equal(receipts[0].technique,'без')}
      assert.equal(writes,0,'пассивная телеметрия не управляет клавишами')
      assert.equal(fall.bot._ndParkourForecast,otherOwner,'телеметрия не забирает управление нового дела')
      for (const event of ['physicsTick','death','end']) assert.equal(fall.bot.listenerCount(event),0)
      assert.equal(game.timers.size,timerCount,'таймер телеметрии удалён при посадке')
    }
  } finally {game.dispose();clock.activate(null)}
})
