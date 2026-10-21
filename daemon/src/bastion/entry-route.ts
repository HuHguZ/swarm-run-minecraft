'use strict'
// A facade supplies hypotheses; a spatially separate new contour confirms the housing wall.
const bp: typeof import('../bastion-pieces') = require('../bastion-pieces')
const family = s => s === 'G' || s === 'g' ? 'B' : s === 'M' ? 'o' : s
const bit = { '.': 1, B: 2, b: 4, s: 8, C: 16, L: 32, o: 64 }
const shapes = new Map()
const key = p => `${p.x},${p.y},${p.z}`

function shape (type, r) {
  const k = `${type}/${r}`
  if (shapes.has(k)) return shapes.get(k)
  const pieces = []
  for (const [index,slot] of bp.START_REL[type].entries()) {
    const [x,z] = bp.rot(r, slot.d[0], slot.d[2])
    for (const piece of Object.keys(slot.v)) pieces.push({ piece,slot:index,r:(r + slot.dr) & 3,t:{ x,y:32 + slot.d[1],z } })
  }
  const corners = pieces.flatMap(c => { const [X,Y,Z] = bp.lib()[c.piece].size
    return [0,X-1].flatMap(x => [0,Y-1].flatMap(y => [0,Z-1].map(z => bp.toWorld(c,x,y,z)))) })
  const lo = { x:Math.min(...corners.map(p=>p.x)),y:Math.min(...corners.map(p=>p.y)),z:Math.min(...corners.map(p=>p.z)) }
  const X = Math.max(...corners.map(p=>p.x)) - lo.x + 1, Y = Math.max(...corners.map(p=>p.y)) - lo.y + 1, Z = Math.max(...corners.map(p=>p.z)) - lo.z + 1
  const grid = new Uint8Array(X*Y*Z)
  for(const slot of bp.START_REL[type].keys()) {
    const variants=pieces.filter(c=>c.slot===slot),cells=new Map()
    for(const c of variants) { const P=bp.lib()[c.piece]
      for(let y=0;y<P.size[1];y++) for(let z=0;z<P.size[2];z++) for(let x=0;x<P.size[0];x++) {
        const value=bit[family(bp.cellOf(P,x,y,z))]
        if(!value) continue
        const p=bp.toWorld(c,x,y,z),i=p.x-lo.x+X*(p.z-lo.z+Z*(p.y-lo.y)),old=cells.get(i)||{mask:0,n:0}
        old.mask|=value;old.n++;cells.set(i,old)
      }
    }
    // A shorter variant has no prediction above its roof; it does not assert another variant's masonry.
    for(const [i,v] of cells) grid[i]|=v.mask|(v.n<variants.length?128:0)
  }
  const result = { lo,X,Y,Z,grid,slots:bp.START_REL[type].map((_,i)=>pieces.filter(c=>c.slot===i)) }; shapes.set(k,result); return result
}
function expected (s, t, p) {
  const x=p.x-t.x-s.lo.x,y=p.y-s.lo.y,z=p.z-t.z-s.lo.z
  return x<0||y<0||z<0||x>=s.X||y>=s.Y||z>=s.Z ? 0 : s.grid[x+s.X*(z+s.Z*y)]
}
function pieceAt (c,t,p) {
  const [x,z]=bp.rot((4-c.r)&3,p.x-t.x-c.t.x,p.z-t.z-c.t.z)
  return bit[family(bp.cellOf(bp.lib()[c.piece],x,p.y-c.t.y,z))]||0
}
function coherentScore (h,obs) {
  const selected=[]
  for(const variants of shape(h.type,h.r).slots) {
    let best=null,score=-Infinity
    for(const c of variants) {
      let match=0,miss=0
      for(const o of obs) { const want=pieceAt(c,h.t,o.p)
        if(!want)continue
        if(want===o.bit){if(o.bit!==1)match++}else miss++
      }
      if(match-2*miss>score){score=match-2*miss;best=c}
    }
    if(best)selected.push(best)
  }
  let match=0,miss=0
  for(const o of obs) {
    let want=0
    for(const c of selected)want|=pieceAt(c,h.t,o.p)
    if(!want)continue
    if(want&o.bit){if(o.bit!==1)match++}else miss++
  }
  return {match,miss,score:match-2*miss}
}
function entryOf (start) {
  if(start?.type !== 'units' || !Number.isInteger(start.r) || start.r<0 || start.r>3 || !start.t ||
      !['x','y','z'].every(k=>Number.isInteger(start.t[k]))) return null
  const p=bp.toWorld(start,-11,4,34)
  return { x:p.x,y:p.y,z:p.z }
}
function agreedStart (hypotheses) {
  const first=hypotheses[0]
  const supported = process.env.ND_BASTION_ENTRY_TYPES === '1' && bp.START_REL[first?.type] &&
    Number.isInteger(first.r) && first.r>=0 && first.r<4 && first.t && ['x','y','z'].every(k=>Number.isInteger(first.t[k]))
  if((!supported && !entryOf(first)) || !hypotheses.every(h=>h.type===first.type && h.r===first.r && key(h.t)===key(first.t))) return null
  return {type:first.type,r:first.r,t:first.t}
}
function chooseView (nodes, at, pivot, visited) {
  const dx=pivot.x-at.x,dz=pivot.z-at.z,range=Math.hypot(dx,dz)||1
  const lateral=p=>Math.abs((p.x-at.x)*dz-(p.z-at.z)*dx)/range
  return nodes.filter(n=>n.d>=4 && Math.hypot(n.pos.x-at.x,n.pos.y-at.y,n.pos.z-at.z)>=4 && !visited.has(key(n.pos)))
    .sort((a,b)=>(lateral(b.pos)*4-b.d*.2)-(lateral(a.pos)*4-a.d*.2))[0] || null
}
function assess (frames) {
  const g=assessSteps(frames); let next=g.next()
  while(!next.done) next=g.next()
  return next.value
}
function * assessSteps (frames) {
  const empty={ type:null,hypotheses:[],start:null,entry:null }
  if(!frames.length) return empty
  const observed=new Map()
  for(const frame of frames) for(const b of frame.blocks) observed.set(key(b.position),{ p:b.position,bit:bit[family(bp.symOf(b.name))] })
  const obs=[...observed.values()].filter(o=>o.bit)
  if(!obs.some(o=>o.bit===bit.B)) return empty
  const at=frames[frames.length-1].at, fits=[]
  for(const type of Object.keys(bp.START_REL)) for(let r=0;r<4;r++) {
    const s=shape(type,r)
    // Jar 1.21.11: the air-base roots begin at chunk minimum X/Z and Y=33-1.
    for(let cx=Math.floor(at.x/16)-6;cx<=Math.floor(at.x/16)+6;cx++) for(let cz=Math.floor(at.z/16)-6;cz<=Math.floor(at.z/16)+6;cz++) {
      const t={x:cx*16,y:32,z:cz*16}; let match=0,miss=0
      for(const o of obs) {
        const want=expected(s,t,o.p)
        if(!want) continue
        if(want & o.bit) { if(o.bit!==bit['.']) match++ } else if(!(want & 128)) miss++
      }
      if(match>=14 && miss<=match*.25) fits.push({type,r,t,match,miss,score:match-2*miss})
    }
    yield
  }
  // Pick one whole variant per slot, never a different convenient variant for every observed cell.
  const coherent=[]
  for(const h of fits){const score=coherentScore(h,obs);if(score.match>=14&&score.miss<=score.match*.25)coherent.push({...h,...score});yield}
  coherent.sort((a,b)=>b.score-a.score||a.miss-b.miss)
  const best=coherent[0]
  if(!best) return empty
  const hypotheses=coherent.filter(c=>c.score>=best.score-Math.max(8,best.score*.15))
  if(best.match<48 || best.miss>best.match*.1) return {...empty,hypotheses}
  const type=hypotheses.every(c=>c.type===best.type)?best.type:null
  let separate=false; const seen=new Set(); let previous=null
  for(const frame of frames) {
    const fresh=frame.blocks.filter(b=>bit[family(bp.symOf(b.name))] && family(bp.symOf(b.name))!=='.' && !seen.has(key(b.position)))
    const compatible=frame.blocks.filter(b=>family(bp.symOf(b.name))!=='.' && (expected(shape(best.type,best.r),best.t,b.position)&bit[family(bp.symOf(b.name))])).length
    if(previous && Math.hypot(frame.at.x-previous.x,frame.at.y-previous.y,frame.at.z-previous.z)>=4 &&
        fresh.filter(b=>expected(shape(best.type,best.r),best.t,b.position)&bit[family(bp.symOf(b.name))]).length>=8) separate=true
    for(const b of frame.blocks) seen.add(key(b.position))
    if(compatible>=8)previous ||= frame.at
  }
  const start=(type==='units' || process.env.ND_BASTION_ENTRY_TYPES==='1' && !!type) && separate ? agreedStart(hypotheses) : null
  return {type,hypotheses,start,entry:entryOf(start)}
}

function memory (bot) {
  const old=bot._ndBastionEntry
  if(!old || old.world!==bot.world || old.dimension!==bot.game?.dimension ||
      old.frames.length && Math.hypot(old.frames[0].at.x-bot.entity.position.x,old.frames[0].at.z-bot.entity.position.z)>128)
    bot._ndBastionEntry={world:bot.world,dimension:bot.game?.dimension,frames:[],visited:new Set()}
  return bot._ndBastionEntry
}
function * observeSteps (bot) {
  const {visibleOf}: typeof import('../sight')=require('../sight'),eyes: typeof import('../perception/eyes')=require('../perception/eyes'),Vec3: typeof import('vec3').Vec3=require('vec3')
  const groups=[[/^(polished_blackstone_bricks|cracked_polished_blackstone_bricks|gilded_blackstone)$/,128],
    [/^(basalt|polished_basalt)$/,64],[/blackstone.*(stairs|slab|wall)$|^(chain|lantern|iron_bars)$/,48],
    [/^gold_block$/,24],[/^(chest|trapped_chest|barrel)$/,16]]
  const cells=new Map()
  for(const [pattern,limit] of groups) {
    const ids=(Object.values(bot.registry.blocksByName) as any[]).filter(b=>(pattern as RegExp).test(b.name)).map(b=>b.id)
    for(const b of visibleOf(bot,ids,20,{max:limit,rays:1200})) cells.set(key(b.position),b)
    yield
  }
  for(const b of [...cells.values()]) for(const [dx,dy,dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
    const p=new Vec3(b.position.x+dx,b.position.y+dy,b.position.z+dz)
    if(cells.has(key(p)) || p.distanceTo(bot.entity.position)>21 || !eyes.seesNow(bot,p)) continue
    const air=bot.blockAt(p)
    if(air && /^(air|cave_air|void_air)$/.test(air.name)) cells.set(key(p),air)
  }
  const m=memory(bot),last=m.frames[m.frames.length-1],p=bot.entity.position
  const frame={at:{x:p.x,y:p.y,z:p.z},blocks:[...cells.values()].map(b=>({name:b.name,position:{x:b.position.x,y:b.position.y,z:b.position.z}}))}
  const distance=last ? Math.hypot(p.x-last.at.x,p.y-last.at.y,p.z-last.at.z) : Infinity
  if(distance>=4) m.frames.push(frame)
  else if(distance<.1) m.frames[m.frames.length-1]=frame
  m.frames=m.frames.slice(-12)
  m.assessment=yield * assessSteps(m.frames)
  if(m.assessment.start) m.confirmed=m.assessment.start
  return m.assessment
}
async function observe (bot,ctl) {
  const steps=observeSteps(bot)
  try {
    for(;;) {
      await new Promise<void>(resolve=>setImmediate(resolve))
      if(ctl.aborted || !bot.entity || (bot.health??20)<=0) return null
      const next=steps.next()
      if(next.done) return next.value
    }
  } finally { steps.return(null) }
}
// Optional open approach: one observed, level step at a time; a subtitle is a warning, not an exact mob position.
// Гаст, ифрит и куб магмы короткий шаг по видимому полу к стене не запрещают (стрелки и прыгуны — щит и тактика; nbs08d 21.10:
// у бастиона гаст виден почти всегда — открытый вход не включался ни разу). Причина отказа — в журнал (раз на причину).
let surfaceWhy = ''
function surfaceAllowed (bot) {
  try {
    const no = why => { if (why !== surfaceWhy) { surfaceWhy = why; console.log('[bastion-entry] открытый шаг нельзя:', why) } return false }
    if (!(require('./take-gold-block') as typeof import('./take-gold-block')).goldWorn(bot)) return no('золото не надето')
    if ((require('../ne-guard/foes') as typeof import('../ne-guard/foes')).meleeFoes(bot,24).some((e: any)=>e.name==='piglin')) return no('злой пиглин в 24')
    const foe = (require('../perception/eyes') as typeof import('../perception/eyes')).entities(bot,{radius:32}).find(e=>
      (e.seen && e.dist!=null && e.dist<=24 && /^(piglin_brute|hoglin|zoglin|skeleton|wither_skeleton)$/.test(e.name)) || e.name==='piglin_brute' && !!e.lastPos)
    if (foe) return no(`${foe.name} ${foe.seen ? 'виден' : 'недавно виден'}`)
    if ((require('../perception/senses') as typeof import('../perception/senses')).heard(bot,{sinceMs:4000}).some(h=>h.who==='piglin_brute' && h.band!=='далеко')) return no('брут слышен близко')
    surfaceWhy = ''
    return true
  } catch { return false }
}
function cause (bot,m,target) {
  const Vec3: typeof import('vec3').Vec3=require('vec3'),eyes: typeof import('../perception/eyes')=require('../perception/eyes'),p=bot.entity.position,origin=m.failedOrigin||p
  const cells=[]
  for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) for(let d=1;d<=3;d++) for(let dy=-1;dy<=2;dy++) {
    const q=new Vec3(Math.floor(origin.x)+dx*d,Math.floor(origin.y)+dy,Math.floor(origin.z)+dz*d)
    cells.push(eyes.seesNow(bot,q)?bot.blockAt(q)?.name||'?':'?')
  }
  const stock=bot.inventory.items().filter(i=>/_pickaxe$|^(cobblestone|netherrack|blackstone|polished_blackstone_bricks|nether_bricks)$/.test(i.name))
    .map(i=>[i.name,i.count,i.durabilityUsed||0]).sort()
  const foes=(Object.values(bot.entities||{}) as any[]).filter(e=>/^(piglin|piglin_brute|hoglin|zoglin|skeleton|wither_skeleton|ghast|blaze|magma_cube)$/.test(e.name||'')&&e.position&&eyes.seesNow(bot,e.position))
    .map(e=>[e.name,Math.floor(e.position.x),Math.floor(e.position.y),Math.floor(e.position.z)]).sort()
  return JSON.stringify([key(target),Math.hypot(p.x-origin.x,p.y-origin.y,p.z-origin.z)>=4,cells,stock,foes,process.env.ND_BASTION_SURFACE_ENTRY==='1'?surfaceAllowed(bot):null])
}
async function approach (session,ctl,st,deadline) {
  if(!session.bot?.entity || !session.bot.world?.getColumn || !session.bot.world?.raycast)return{handled:false,ok:false}
  const bot=session.bot,Vec3: typeof import('vec3').Vec3=require('vec3'),SL: typeof import('../sealed')=require('../sealed'),m=memory(bot)
  const last=m.frames[m.frames.length-1],p=bot.entity.position
  // Finish the chosen viewpoint: intermediate scans must not consume its new contour before arrival.
  const res=m.confirmed || m.aim && last && key(p.floored())!==key(m.aim)
    ? m.assessment : await observe(bot,ctl)
  if(ctl.aborted)return{handled:true,ok:false,why:'entry approach interrupted'}
  const units=(res?.hypotheses||[]).filter(h=>h.type==='units')
  const start=m.confirmed
  // A confirmed non-housing template goes to sealedGold's real route planner; no invented housing entrance.
  if(process.env.ND_BASTION_ENTRY_TYPES==='1' && start && start.type!=='units')
    return{handled:true,ok:false,recognized:start,why:'two observed contours; mining route pending'}
  const visible=m.frames[m.frames.length-1]?.blocks.filter(b=>/^(polished_blackstone_bricks|cracked_polished_blackstone_bricks|gilded_blackstone)$/.test(b.name))||[]
  if(process.env.ND_BASTION_ENTRY_TRACE==='1') {
    const trace={phase:'observed-fit',at:m.frames[m.frames.length-1]?.at,frames:m.frames.length,visibleBricks:visible.length,
      type:res?.type||null,hypotheses:units.length,best:units[0]||null,start:start||null}
    const signature=JSON.stringify(trace)
    if(signature!==m.trace){m.trace=signature;console.log('[bastion-entry]',signature)}
  }
  if(!start&&!units.length&&visible.length<8)return{handled:false,ok:false}
  const F=SL.bodyCells(bot)[0],levelProbe=process.env.ND_BASTION_LEVEL_PROBE==='1'&&!start
  let target=entryOf(start||units[0])||visible[0]?.position
  if(levelProbe) {
    // An unconfirmed root is an information probe, not an instruction to descend to its E marker.
    const D: typeof import('../endportal-descent')=require('../endportal-descent')
    const walls=visible.map(b=>new Vec3(b.position.x,F.y,b.position.z)).filter(w=>
      [w,w.offset(0,1,0)].every(q=>/^(polished_blackstone_bricks|cracked_polished_blackstone_bricks|gilded_blackstone)$/.test(D.seen(bot,q)?.name||'')))
    target=walls.sort((a,b)=>Math.abs(a.x-F.x)+Math.abs(a.z-F.z)-Math.abs(b.x-F.x)-Math.abs(b.z-F.z))[0]
    // Other mining steps can use observed gold or rank predicted gold by route cost; do not certify a root here.
    if(!target)return{handled:false,ok:false,why:'no observed level wall for an unconfirmed pose probe'}
  }
  if(start && F.y===target.y && Math.hypot(F.x-target.x,F.z-target.z)<=1.5)return{handled:true,ok:true,start,entry:target}
  if(m.failed===cause(bot,m,target))return{handled:true,ok:false,progress:false,why:'entry route unchanged since its physical failure'}
  const surface=process.env.ND_BASTION_SURFACE_ENTRY==='1'
  if((!start || surface) && (!surface || surfaceAllowed(bot))) {
    const eyes: typeof import('../perception/eyes')=require('../perception/eyes'),y=F.y
    const view={blockAt:q=>{
      if(q.y<y-1||q.y>y+1||!eyes.seesNow(bot,q))return null
      const b=bot.blockAt(q)
      // The optional open step uses full level support, never stairs, drops, bridging or digging.
      return surface && b?.boundingBox==='block' && !b.shapes?.some(s=>s[0]===0&&s[1]===0&&s[2]===0&&s[3]===1&&s[4]===1&&s[5]===1)?null:b
    }}
    const nodes=(require('../walkable') as typeof import('../walkable')).walkable(view,F,{radius:surface?16:8,maxNodes:surface?1200:240})
    const seen=m.frames[m.frames.length-1]?.blocks.filter(b=>/blackstone|basalt|chest/.test(b.name))||[]
    const pivot=seen.length?{x:seen.reduce((s,b)=>s+b.position.x,0)/seen.length,z:seen.reduce((s,b)=>s+b.position.z,0)/seen.length}:target
    let next=m.aim&&nodes.find(n=>key(n.pos)===key(m.aim))
    if(!next || next.d===0){if(m.aim)m.visited.add(key(m.aim));next=chooseView(nodes,F,pivot,m.visited);m.aim=next?.pos}
    if(surface) {
      const walls=visible.map(b=>new Vec3(b.position.x,y,b.position.z)).filter(w=>[w,w.offset(0,1,0)].every(q=>/^(polished_blackstone_bricks|cracked_polished_blackstone_bricks|gilded_blackstone)$/.test(view.blockAt(q)?.name||'')))
      // Route to a visible 1x2 wall face. If its support is not observed/connected, keep the closed variant.
      next=nodes.filter(n=>n.pos.y===y&&!m.visited.has(key(n.pos))&&walls.some(w=>Math.abs(n.pos.x-w.x)+Math.abs(n.pos.z-w.z)===1))
        .sort((a,b)=>a.d-b.d)[0]||null
      m.aim=null
    }
    if(next && next.d>0) {
      const at=next.pos
      while(next.d>1) { const prev=nodes.find(n=>n.d===next.d-1&&n.pos.y===next.pos.y&&Math.abs(n.pos.x-next.pos.x)+Math.abs(n.pos.z-next.pos.z)===1);if(!prev){next=null;break}next=prev }
      if(next) {
        const before=bot.entity.position.clone()
        const stepCtl=surface?{get aborted(){return ctl.aborted||!surfaceAllowed(bot)}}:ctl
        const ok=await (require('../endportal-descent') as typeof import('../endportal-descent')).walkInto(bot,stepCtl,new Vec3(next.pos.x,next.pos.y,next.pos.z),0,true)
        const progress=bot.entity.position.distanceTo(before)>.25
        if(!ok&&!progress){m.visited.add(key(at));m.aim=null}
        if(progress)return{handled:true,ok:false,progress,why:surface?'one observed step to bastion wall':'second characteristic view on observed support'}
      }
    }
  }
  // A probe follows a hypothesis through verified rock; it does not certify that hypothesis or mine hidden gold.
  const S=st.sealedState||(st.sealedState={own:new Set(),exposed:true,dug:0,moves:0,fills:0,ores:0,bonusBlocks:0,goldPassed:0,plans:0,fails:[],planMs:0,walks:0,honest:true})
  const before=bot.entity.position.clone()
  const r=await (require('../nether-cover') as typeof import('../nether-cover')).closedBore(session,ctl,target,{deadline,maxSteps:64,minY:levelProbe?F.y:Math.min(F.y,target.y)-1,adjacent:true,own:S.own,
    onOpen:async()=>{if(!start)await observe(bot,ctl);return{recognized:!!m.confirmed}},stop:v=>!start&&v.recognized})
  S.dug+=r.dug||0;S.moves+=(r.moved||0)+(r.down||0);S.fills+=r.placed||0;S.exposed=!!r.unsealed
  const progress=bot.entity.position.distanceTo(before)>.25||!start&&!!m.confirmed
  const end=SL.bodyCells(bot)[0],ok=!!start&&end.y===target.y&&Math.hypot(end.x-target.x,end.z-target.z)<=1.5
  if(!progress&&!ok){m.failedOrigin=bot.entity.position.clone();m.failed=cause(bot,m,target)}else{m.failed=null;m.failedOrigin=null}
  console.log('[bastion-entry]',JSON.stringify({phase:start?'lower-wall':'pose-probe',start:start||null,hypotheses:units.length,target,at:{x:end.x,y:end.y,z:end.z},ok,progress,dug:r.dug,placed:r.placed,why:r.why}))
  return{handled:true,ok,progress,start:start||null,entry:target,why:r.why}
}

module.exports={assess,assessSteps,agreedStart,entryOf,chooseView,memory,observe,observeSteps,approach}
export { assess, assessSteps, agreedStart, entryOf, chooseView, memory, observe, observeSteps, approach }
