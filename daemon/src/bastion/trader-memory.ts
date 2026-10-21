// Last sightings are search anchors, not live entities or a promise of HOME.
const clock: typeof import('../game-clock') = require('../game-clock')
const eyes: typeof import('../perception/eyes') = require('../perception/eyes')
const senses: typeof import('../perception/senses') = require('../perception/senses')
const { Vec3 }: typeof import('vec3') = require('vec3')
const TTL = 600000 // search budget, not an AI residence time
const on = () => process.env.ND_BARTER_TRADER_MEMORY === '1'
export const visible = bot => eyes.entities(bot,{radius:64,rememberMs:0,hearMs:0}).filter(e=>e.seen && e.pos)
function state (bot) {
  const now=clock.now(); const dim=String(bot.game?.dimension || '')
  let s=bot._ndTraderMemory
  if (!s || s.world!==bot.world || s.dim!==dim || now<s.last) s=bot._ndTraderMemory={world:bot.world,dim,last:now,adults:new Map(),sound:null,expired:0}
  s.last=now
  for (const [id,r] of s.adults) if(now-r.t>TTL) { s.adults.delete(id); s.expired++ }
  if(s.sound && now-s.sound.t>30000)s.sound=null
  return s
}
function sample (bot) {
  if(!on() || !bot.entity)return
  const s=state(bot), now=clock.now()
  for(const e of visible(bot)) {
    if(e.name!=='piglin')continue
    const pg=bot.entities[e.id], keys=bot.registry.entitiesByName.piglin.metadataKeys
    if(!pg || pg.metadata?.[keys.indexOf('baby')]) { s.adults.delete(e.id); continue }
    const metadata=[]; metadata[keys.indexOf('baby')]=false
    s.adults.set(e.id,{t:now,e:{id:e.id,name:'piglin',position:new Vec3(e.pos.x,e.pos.y,e.pos.z),metadata}})
  }
}
export function install (bot) {
  if(!on() || !bot?.entity)return
  state(bot); sample(bot)
  if(bot._ndTraderMemoryOff)return
  senses.installHearing(bot)
  let next=clock.now()+500
  const tick=()=>{if(on() && (clock.now()>=next || clock.now()<next-500)){next=clock.now()+500;sample(bot)}}
  const sound=()=>{
    if(!on() || !bot.entity)return
    const h=senses.heard(bot,{sinceMs:200,match:/^(?:minecraft:)?entity\.piglin\./})[0]
    if(!h || h.ago!==0)return
    const at=senses.hearPoint(bot,h)
    // Only public subtitle fields and OUR listening position; no packet/source coordinates or IDs.
    if(at)state(bot).sound={t:clock.now(),position:new Vec3(at.x,at.y,at.z),origin:bot.entity.position.clone(),dir:h.dir8,band:h.band}
  }
  bot.on('physicsTick',tick); bot._client.on('sound_effect',sound);bot._client.on('entity_sound_effect',sound)
  const off=()=>{bot.removeListener('physicsTick',tick);bot._client.removeListener('sound_effect',sound);bot._client.removeListener('entity_sound_effect',sound);bot.removeListener('end',off);delete bot._ndTraderMemoryOff;delete bot._ndTraderMemory}
  bot._ndTraderMemoryOff=off;bot.once('end',off)
}
export function traders (bot,radius=64) {
  install(bot)
  if(!on() || !bot.entity)return []
  return [...state(bot).adults.values()].filter(r=>r.e.position.distanceTo(bot.entity.position)<=radius)
    .map(r=>({...r.e,position:r.e.position.clone(),metadata:r.e.metadata.slice(),seenAt:r.t,memoryOnly:true}))
}
export function hints (bot) {
  const adults=traders(bot), s=state(bot)
  const out=adults.map(e=>({position:e.position,source:'seen',ageMs:clock.now()-e.seenAt,searchRadius:16}))
  if(s.sound)out.unshift({...s.sound,source:'sound',ageMs:clock.now()-s.sound.t,searchRadius:s.sound.band==='далеко'?Infinity:8})
  return out
}
export function score (from,d,hints) {
  if(!hints.length)return 0
  return Math.max(...hints.map(h=>{const x=h.position.x-from.x,z=h.position.z-from.z,n=Math.hypot(x,z);return n>0?(x*d[0]+z*d[1])/n:0}))
}
export function stats (bot) {
  const s=state(bot), now=clock.now(), ages=[...s.adults.values()].map(r=>now-r.t)
  return {visible:visible(bot).filter(e=>e.name==='piglin').length,anchors:s.adults.size,oldestS:ages.length?Math.round(Math.max(...ages)/1000):null,expired:s.expired,sound:s.sound?{dir:s.sound.dir,band:s.sound.band}:null}
}
