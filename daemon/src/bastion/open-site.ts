// ND_BARTER_OPEN_SITE=1: an observed open floor competes with protected sites.
// No seed/copy data. Constants below are priors, not native Minecraft rules.
export const enabled = () => process.env.ND_BARTER_OPEN_SITE === '1'
const key = v => `${v.x},${v.y},${v.z}`
const dirs = [[1,0],[-1,0],[0,1],[0,-1]]
// Conditional historical stack delivery: s2-bastpit03 179/186. Setup=60 s is the
// core default, doubled for the historical 3 working pits / 6 attempts. Window
// .41 is a scenario prior from run-trade.ts, not the delivery of a working pit.
const protectedPrior = () => [{kind:'pit',rate:144/334*60,delivery:179/186,setupSeconds:120}, {kind:'booth',rate:25,delivery:.41,setupSeconds:60}]

export function siteChoice (s) {
  const n = Math.min(4, Math.max(0, s.adults)) // no measured extrapolation beyond four adults
  // obr23a/b (2 adults), obr23c/d (4). These measure accepted/net gold, not loot delivery.
  const rate = (n <= 2 ? n * 101 / 380 * 30 : 101 / 380 * 60 + (n-2) * (144 / 312 * 60 - 101 / 380 * 60) / 2)
  const options = (s.protected || protectedPrior())
    .map(p => ({kind:p.kind, seconds: p.setupSeconds + s.ingots * 60 / Math.max(.01,p.rate) / Math.max(.01,p.delivery), rate:p.rate, delivery:p.delivery}))
  const delivery = s.openDelivery ?? .85 // core/barter-model prior; open scenes have no stack denominator
  const learnedRate = s.timing?.ingots > 0 && s.timing.seconds > 0
    ? 60 * (27 + s.timing.ingots) / (27 * 60 / Math.max(.01,rate) + s.timing.seconds) : rate
  const observedRate = Math.min(n * 60000 / 5950, learnedRate) // 119 ticks per adult; a previous crowd cannot speed up one trader
  options.push({kind:'open', seconds: n ? s.waitSeconds + s.walkSeconds + s.ingots * 60 / observedRate / delivery + s.riskSeconds + Math.max(0,20-s.hp)*5 : Infinity,
    rate:observedRate, delivery})
  options.sort((a,b)=>a.seconds-b.seconds)
  return {...options[0],options}
}

export function rememberProtected (st,bo,setupSeconds) {
  const quotes=st.sitePrices ||= protectedPrior()
  if(!bo){for(const p of quotes)p.setupSeconds+=setupSeconds;return}
  const p=quotes.find(p=>p.kind===(bo.kind==='pit'?'pit':'booth')), r=st.pitTrade||{}
  p.setupSeconds=(p.setupSeconds+setupSeconds)/2
  if(r.barterReceipts>0 && !r.receiptsPartial)p.delivery=(p.delivery*10+(r.barterDelivered||0))/(10+r.barterReceipts)
  if(r.spent>0 && r.seconds>0)p.rate=60*(27+r.spent)/(27*60/p.rate+r.seconds)
  st.tradeTiming||={ingots:0,seconds:0}
  st.tradeTiming.ingots+=r.spent||0;st.tradeTiming.seconds+=r.seconds||0
}

export function stopReason ({hp,visible}) {
  if (hp < 8) return `хп ${Math.round(hp)} — лечиться в штреке`
  const t = visible.find(e => e.name === 'piglin_brute' || /^(hoglin|zoglin)$/.test(e.name) && e.dist <= 12 ||
    e.name === 'magma_cube' && e.dist <= 10 || /^(ghast|blaze)$/.test(e.name) && e.dist <= 48 || e.name === 'piglin' && e.angry && e.dist <= 16)
  return t ? `${t.name} в ${t.dist} — назад в штрек` : null
}

// Own coordinates may guide a search through our seals; foreign floor must be visible NOW.
export function paths (start, allowed, stairs = false, limit = 256) {
  const q = [{v:start,path:[]}], seen = new Set([key(start)])
  for(let i=0;i<q.length && q.length<limit;i++) for(const [x,z] of dirs) for(const y of stairs ? [0,1,-1] : [0]) {
    const v = typeof start.offset === 'function' ? q[i].v.offset(x,y,z) : {x:q[i].v.x+x,y:q[i].v.y+y,z:q[i].v.z+z}
    if(seen.has(key(v)) || !allowed(v))continue
    seen.add(key(v)); q.push({v,path:[...q[i].path,v]})
  }
  return q
}

export async function chooseOpen (bx) {
  if(!enabled())return null
  const {session,bot,ctl,st,deadline} = bx, S=st.sealedState
  if(!S?.own || S.exposed !== false || ctl.aborted)return null
  const C: typeof import('./take-gold-block') = require('./take-gold-block')
  const SL: typeof import('../sealed') = require('../sealed')
  const E: typeof import('../perception/eyes') = require('../perception/eyes')
  const TM: typeof import('./trader-memory') = require('./trader-memory')
  const BM: typeof import('../brute-memory') = require('../brute-memory')
  const P: typeof import('../pick') = require('../pick')
  const A: typeof import('../assess') = require('../assess')
  const {lastGoldBreak}: typeof import('./predict-gold') = require('./predict-gold')
  const {Vec3} = C, home=SL.bodyCells(bot)[0], world=bot.world
  if(!S.own.has(key(home)) || !S.own.has(key(home.offset(0,1,0))))return null
  const trail=[home.clone()], opened=[], t0=C.gameClock.now()
  let cancelled=false
  const alive=()=>session.bot===bot && bot.world===world && st.sealedState===S && (bot.health??0)>0 && !ctl.aborted
  const seen=()=>E.entities(bot,{radius:48,rememberMs:0,hearMs:0}).filter(e=>e.seen && e.pos)
    .map(e=>({...e,dist:new Vec3(e.pos.x,e.pos.y,e.pos.z).distanceTo(bot.entity.position),angry:e.name==='piglin' && C.aggressive(bot,bot.entities[e.id])}))
  const threat=()=>!C.goldWorn(bot)?'золотая броня потеряна':stopReason({hp:bot.health??0,visible:seen()})
  const read=v=>E.seesNow(bot,v)?bot.blockAt(v,false):null
  const air=v=>SL.classOf(read(v))===SL.AIR
  const floor=v=>C.fullCover(read(v)) && [SL.SOLID,SL.HARD,SL.GUARD].includes(SL.classOf(read(v)))
  const own=new Set([...S.own,...(S.filled||[])])
  if(S.entry){own.add(key(S.entry));own.add(key({...S.entry,y:S.entry.y+1}))}
  const ours=v=>own.has(key(v)) && own.has(key(v.offset(0,1,0)))
  const returnReserve=()=>5000+(trail.length+1)*4000+opened.length*4000
  const guardBusy=()=> (require('../ne-guard') as typeof import('../ne-guard')).busy(bot)
  const safe=()=>!cancelled && alive() && C.gameClock.now()<deadline-returnReserve() && !guardBusy()
  const clearSeenSeal=async v=>{
    const b=read(v)
    if(SL.classOf(b)===SL.AIR)return true
    if(!S.filled?.has(key(v)) || !SL.FILL_NAMES.includes(b?.name))return false
    const avoid=seen().map(e=>bot.entities[e.id]).filter(Boolean)
    for(const [x,y,z] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const face=new Vec3(x,y,z), aim=P.faceAim(bot,v,face,{avoid})
      if(!aim)continue
      if(!safe() || threat())return false
      opened.push(v.clone());S.exposed=true // attempted mutation can succeed even if the reply throws/times out
      const r=await SL.digCell(bot,v,{face,aim,interrupted:()=>!safe() || !!threat()})
      if(!['air','ok'].includes(r) || !air(v))return false
      S.filled.delete(key(v));S.own.add(key(v))
      return true
    }
    return false
  }
  // Manual adjacent step has no pathfinder fallback, digging, scaffolding or retry jump.
  const step=async(to,retreat=false)=>{
    if(!(retreat ? alive() && !guardBusy() && C.gameClock.now()<deadline-2000 : safe() && !threat()))return false
    const at=SL.bodyCells(bot)[0], dy=to.y-at.y
    if(Math.abs(to.x-at.x)+Math.abs(to.z-at.z)!==1 || Math.abs(dy)>1)return false
    const volume=[to,to.offset(0,1,0)]
    if(dy>0)volume.push(at.offset(0,2,0))
    if(dy<0)volume.push(to.offset(0,2,0))
    for(const v of volume) if(!air(v) && (retreat || !ours(to) || !(await clearSeenSeal(v))))return false
    if(!floor(to.offset(0,-1,0)))return false
    const until=Math.min(deadline-(retreat?2000:returnReserve()),C.gameClock.now()+2500)
    try {
      while((retreat ? alive() && !guardBusy() : safe()) && C.gameClock.now()<until && (retreat || !threat())) {
        if(SL.bodyCells(bot)[0].equals(to) && bot.entity.onGround)return true
        if(!volume.every(air) || !floor(to.offset(0,-1,0)))return false
        await bot.lookAt(to.offset(.5,1.6,.5),true)
        bot.setControlState('forward',true);bot.setControlState('jump',dy>0)
        await C.sleep(50)
      }
    } finally {bot.setControlState('forward',false);bot.setControlState('jump',false)}
    return SL.bodyCells(bot)[0].equals(to) && bot.entity.onGround
  }
  const go=async(path,retreat=false)=>{
    for(const to of path){if(!(await step(to,retreat)))return false;if(!retreat)trail.push(to.clone())}
    return true
  }
  const back=async()=>{
    const failure=()=>{S.exposed=true;st.openReturn={ok:false,stopped:'обратный ход не подтверждён'};return false}
    try {
    if(!alive() || guardBusy())return failure() // cancellation/death/world change never starts another action
    const at=SL.bodyCells(bot)[0]
    let index=trail.length-1;while(index>=0 && !trail[index].equals(at))index--
    if(index<0)return failure() // knockback: no invented path through walls
    let ok=true
    const pending=new Map(opened.map(v=>[key(v),v]))
    const closePassed=async remaining=>{
      for(const [k,v] of pending) {
        if(remaining.has(k) || SL.bodyCells(bot).some(c=>c.equals(v)) || !E.seesNow(bot,v) || v.distanceTo(bot.entity.position)>4.5)continue
        if(!alive())return false
        await SL.fillCell(bot,v,ctl)
        if(!C.fullCover(read(v)))return false
        S.own.delete(k);(S.filled||=new Set()).add(k);pending.delete(k)
      }
      return true
    }
    for(let i=index-1;i>=0;i--) {
      if(!(await step(trail[i],true))){ok=false;break}
      const remaining=new Set(trail.slice(0,i+1).flatMap(v=>[key(v),key(v.offset(0,1,0))]))
      if(!(await closePassed(remaining))){ok=false;break}
    }
    if(!(await closePassed(new Set())) || pending.size)ok=false
    S.exposed=!ok
    st.openReturn={ok,stopped:ok?null:'обратный ход/закладка не подтверждены'}
    return ok
    } catch {return failure()}
  }
  const cool=()=>{
    const last=Math.max(lastGoldBreak(st),bot._ndGuard?.angerAt||0)
    return last>0?Math.max(0,last+33000-C.gameClock.now()):0
  }
  try {
    // Pay anger time in the closed tunnel, never while walking out of it.
    while(safe() && cool()>0 && !threat())await C.sleep(Math.min(250,cool()))
    if(!safe() || threat()) {await back();return null}
    // q5c hints are search anchors; never count a remembered adult as a trader.
    const hints=process.env.ND_BARTER_TRADER_MEMORY==='1'?TM.hints(bot):[]
    const stations=paths(home,ours,true)
    const anchors=hints.length?hints.map(h=>h.position):S.entry?[S.entry]:[home]
    const score=r=>Math.min(...anchors.map(h=>Math.hypot(h.x-r.v.x,h.y-r.v.y,h.z-r.v.z)))+r.path.length*.25
    const target=stations.sort((a,b)=>score(a)-score(b))[0]
    if(!(await go(target.path))){await back();return null}
    // q5c peek was already called by chooseSite before this search. Its anchors
    // guide our own reversible path; never let another executor move off our trail.
    const openPaths=()=>{
      if(threat())return []
      const gold=seen().filter(e=>e.name==='item').filter(e=>{try{return bot.entities[e.id].getDroppedItem()?.name==='gold_ingot'}catch{return false}})
      return paths(SL.bodyCells(bot)[0],v=>air(v)&&air(v.offset(0,1,0))&&floor(v.offset(0,-1,0)) &&
        !gold.some(e=>Math.hypot(e.pos.x-v.x-.5,e.pos.z-v.z-.5)<1.6),false)
    }
    const adults=()=>{
      const reach=new Set(openPaths().map(r=>key(r.v))), f=SL.bodyCells(bot)[0]
      return seen().filter(e=>e.name==='piglin' && e.dist<=12 && Math.abs(e.pos.y-f.y)<.6 && !C.isBaby(bot,bot.entities[e.id]) && !e.angry &&
        dirs.some(([x,z])=>reach.has(key(new Vec3(Math.floor(e.pos.x)+x,f.y,Math.floor(e.pos.z)+z)))))
    }
    BM.observe(bot,true)
    const gear=A.gearOf([5,6,7,8].map(s=>bot.inventory.slots[s]))
    const risk=()=>{
      const hp=Math.max(1,bot.health??1), dangers=seen().filter(e=>e.name!=='piglin' || e.angry)
      const hits={piglin_brute:13,hoglin:6,zoglin:6,magma_cube:6,ghast:6,blaze:5,piglin:8}
      const harm=dangers.reduce((n,e)=>n+(hits[e.name]?A.afterArmor(hits[e.name],gear.armor,gear.tough)*Math.max(0,1-e.dist/(e.name==='ghast'?48:24)):0),0)
      // Policy: one lost run costs an hour (bastion/brute-risk); memory is a soft price.
      return 3600*Math.min(.95,harm/hp)+60*Math.max(BM.riskNear(bot).cost,...adults().map(e=>BM.riskNear(bot,e.pos).cost))
    }
    const approachSeconds=(C.gameClock.now()-t0)/1000
    const quote=(includeApproach=false)=>siteChoice({adults:adults().length,ingots:Math.max(1,Math.min(36,C.countOf(bot,'gold_ingot')+9*C.countOf(bot,'gold_block')-bx.keep)),
      hp:bot.health??0,waitSeconds:cool()/1000,walkSeconds:includeApproach?approachSeconds:0,
      riskSeconds:risk(),timing:st.openTiming,protected:st.sitePrices})
    const choice=quote(true);(st.siteChoices||=[]).push(choice);C.log('бартер: цена места',choice)
    if(!safe() || threat() || choice.kind!=='open'){await back();return null}
    const move=async(target,range,ms)=>{
      const until=Math.min(deadline-20000,C.gameClock.now()+ms)
      while(safe() && !threat() && C.gameClock.now()<until) {
        const r=openPaths().filter(r=>r.v.offset(.5,0,.5).distanceTo(target.offset(.5,0,.5))<=range).sort((a,b)=>a.path.length-b.path.length)[0]
        if(!r)return {ok:false,error:'нет видимого пола'}
        if(!r.path.length)return {ok:true}
        if(!(await go([r.path[0]])))break
      }
      return {ok:false,error:threat()||'путь прерван'}
    }
    const lying=(name=null)=>seen().filter(e=>e.name==='item').map(e=>{
      const entity=bot.entities[e.id];let stack=null;try{stack=entity.getDroppedItem()}catch{}
      return {e:entity,id:e.id,stack,name:stack?.name,rest:e.pos,dist:e.dist}
    }).filter(e=>e.stack && (!name||e.name===name))
    const line=dir=>{
      const at=SL.bodyCells(bot)[0]
      return [1,2,3,4].every(n=>{const v=at.offset(Math.round(n*dir.x),0,Math.round(n*dir.z));return air(v)&&floor(v.offset(0,-1,0))})
    }
    const collect=async(radius,ms,match=null)=>{
      if(!safe() || threat())return 0
      const D: typeof import('../drops')=require('../drops')
      const ids=new Set(seen().map(e=>e.id))
      const gold=lying('gold_ingot').filter(e=>e.dist<=12)
      const wanted=(e,s)=>ids.has(e.id) && s && s.name!=='gold_ingot' && (!match||match(e,s)) && !gold.some(g=>Math.hypot(g.rest.x-e.position.x,g.rest.z-e.position.z)<1.6)
      const it=lying().filter(e=>e.dist<=radius && wanted(e.e,e.stack)).sort((a,b)=>a.dist-b.dist)[0]
      if(it && !threat())await move(new Vec3(it.rest.x,it.rest.y,it.rest.z).floored(),0,Math.min(ms,1500))
      return D.collect(bot,ctl,{radius:1.5,timeoutMs:Math.min(ms,500),appearMs:0,match:wanted,allowMovement:false,canContinue:()=>safe()&&!threat()})
    }
    return {kind:'open',F:home,nextKind:null as string|null,quote,adults,move,collect,back,threat,cool,safe,visible:seen,lying,line,tradeDeadline:()=>deadline-returnReserve(),cancel:()=>{cancelled=true}}
  } catch(e) {const ok=await back();st.openReturn={ok,stopped:e.message};throw e}
}

export async function tradeOpen (bx,bo) {
  const {session,bot,ctl,st,deadline,keep}=bx
  const C: typeof import('./take-gold-block')=require('./take-gold-block')
  const {barterRound}: typeof import('./booth-trade')=require('./booth-trade')
  let stopped=null, pickedGold=0
  const sub={aborted:false,onAbort:[] as Array<()=>void>,waitReflex:async()=>{if(ctl.waitReflex)await ctl.waitReflex();if(ctl.aborted)cut()}}
  const cut=()=>{if(sub.aborted)return;sub.aborted=true;bo.cancel();for(const f of sub.onAbort){try{f()}catch{}};try{bot.pathfinder.setGoal(null)}catch{};bot.clearControlStates()}
  const watch=()=>{const why=bo.threat();if(ctl.aborted||!bo.safe()||why||bo.cool()>0){stopped=why||'прервано/новая злость';cut()}}
  const onGold=p=>{
    const e=bot.entities[p.collectedEntityId], pg=bot.entities[p.collectorEntityId]
    const visible=(require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot,{radius:12,rememberMs:0,hearMs:0}).filter(e=>e.seen)
    try{if(pg?.name==='piglin' && !C.isBaby(bot,pg) && visible.some(e=>e.id===pg.id) && visible.some(v=>v.id===e?.id) && e.getDroppedItem()?.name==='gold_ingot' && p.pickupItemCount===1)pickedGold++}catch{}
  }
  ctl.onAbort?.push(cut);bot._client.on('collect',onGold)
  const timer=C.gameClock.setInterval(watch,100)
  try {
    while(!ctl.aborted && !sub.aborted && !C.inLava(bot) && !((require('./run') as typeof import('./run')).done(bx)) && C.gameClock.now()<deadline-30000) {
      watch();if(sub.aborted)break
      const n=Math.min(36,Math.max(0,C.countOf(bot,'gold_ingot')+9*C.countOf(bot,'gold_block')-keep))
      if(!n)break
      await C.unpackGold(session,sub,keep+n)
      watch();if(sub.aborted)break
      const can=Math.min(n,Math.max(0,C.countOf(bot,'gold_ingot')-keep))
      if(can<=0){stopped='блоки не распаковались';break}
      const gold0=pickedGold
      const r=await barterRound(session,sub,st,can,bo.tradeDeadline(),
        {neutralPath:true,openSite:true,move:bo.move,collect:bo.collect,adults:bo.adults,visible:bo.visible,lying:bo.lying,line:bo.line,stop:()=>sub.aborted||!!bo.threat(),acceptedGold:()=>pickedGold-gold0})
      st.lastBarter='на открытом';st.openTiming||={ingots:0,seconds:0}
      st.openTiming.ingots+=r.accepted||0;st.openTiming.seconds+=r.seconds||0
      st.tradeTiming||={ingots:0,seconds:0};st.tradeTiming.ingots+=r.accepted||0;st.tradeTiming.seconds+=r.seconds||0
      C.log('бартер на открытом',{...r,accepted:r.accepted,stopped:stopped||r.stopped})
      if(sub.aborted || r.stopped || !(r.accepted>0))break
      const choice=bo.quote();(st.siteChoices||=[]).push(choice);C.log('бартер: цена между раундами',choice)
      if(choice.kind!=='open'){bo.nextKind=choice.kind;stopped='другое место дешевле';break}
    }
  } finally {
    C.gameClock.clearInterval(timer);bot._client.removeListener('collect',onGold)
    if(ctl.onAbort){const i=ctl.onAbort.indexOf(cut);if(i>=0)ctl.onAbort.splice(i,1)}
    const returned=await bo.back();st.openReturn={ok:returned,stopped}
    C.log('бартер: назад в штрек',st.openReturn)
    if(!returned)st.barterRetry='открытый торг: обратный ход/закладка не подтверждены'
  }
}
