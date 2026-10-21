// Proposed daemon/src/lava-nav.ts. ND_LAVA_NAV_GUARD is opt-in; never a seed/world scan.
import { Vec3 } from 'vec3'
import * as clock from './game-clock'
import * as locks from './reflex-lock'
import { worldOf } from './worlds'
import { bodyClear, bodyBox, intersects, supportAt, type CollisionWorld } from './navigation/geometry'
import { damageTypeName } from './gamedata'
import { inLava } from './tactics/lava-escape'
import { steerTo } from './blockmoves'
import { placeBlockAt } from './build'
type Body = Record<string, any>
type Bot = Body & CollisionWorld & { entity: Body & { position: Vec3 } }
const traces = new WeakMap<object, { world: string; points: Vec3[]; busy: boolean; contact?: Vec3 }>()
export const on = (s: Body) => process.env.ND_LAVA_NAV_GUARD === '1' && !!s.bot?.entity && worldOf(s.bot) === 'the_nether'
export function reset(s: Body): void { if (locks.owner(s)?.source==='lava-nav') locks.cancel(s); traces.delete(s) }
function trace(s: Body) {
  const world = String(s.bot.game?.dimension || worldOf(s.bot))
  let st = traces.get(s)
  if (!st || st.world !== world) { st = { world, points: [], busy: false }; traces.set(s, st) }
  return st
}
// Current body and its own footprints only. A flowing cell at the rim counts even if native isInLava is still false.
function wet(bot: Bot): boolean {
  if (inLava(bot)) return true
  const b = bodyBox(bot, bot.entity.position)
  for (let x = Math.floor(b.minX); x <= Math.floor(b.maxX); x++) for (let z = Math.floor(b.minZ); z <= Math.floor(b.maxZ); z++)
    for (let y = Math.floor(b.minY); y <= Math.floor(b.maxY); y++) {
      if (bot.blockAt(new Vec3(x, y, z), false)?.name === 'lava' && intersects(b, { minX:x,minY:y,minZ:z,maxX:x+1,maxY:y+1,maxZ:z+1 })) return true
    }
  return false
}
export const hazard = (s: Body): boolean => on(s) && wet(s.bot)
const dry = (bot: Bot, p: Vec3) => bodyClear(bot, p) && !!supportAt(bot, p, .04)
export function sample(s: Body): void {
  if (!on(s)) return
  const b = s.bot, st = trace(s), p = b.entity.position
  if (b.health <= 0) { reset(s); return }
  if (st.busy) return
  if (wet(b)) { rewind(s); return }
  if (!b.entity.onGround || !dry(b, p)) return
  if (st.contact) { if (p.distanceTo(st.contact)<.6) return; delete st.contact; st.points=[] }
  const last = st.points.at(-1)
  if (last && p.distanceTo(last) > 1.25) st.points = [] // jump/teleport receipt is not a walked corridor
  if (!last || p.distanceTo(last) >= .15) st.points.push(p.clone())
  if (st.points.length > 64) st.points.shift()
}
export function hit(s: Body, packet?: Body): void {
  if (on(s) && packet && packet.entityId === s.bot.entity.id && damageTypeName(packet.sourceTypeId) === 'lava') rewind(s)
}
function clearLeg(bot: Bot, from: Vec3, p: Vec3): boolean {
  const length=p.distanceTo(from)
  if (length>1.25) return false
  // Flooded footprints may be necessary on the way OUT; solids/unknown cells may not.
  const corridor = { physics:bot.physics, entity:bot.entity, game:bot.game, blockAt(p: Vec3) { const b = bot.blockAt(p, false); return b?.name === 'lava' ? { ...b, name: 'air', shapes: [], boundingBox: 'empty' } : b } }
  for (let k=1, n=Math.max(1,Math.ceil(length/.15)); k<=n; k++) {
    const at=from.plus(p.minus(from).scaled(k/n))
    if (!bodyClear(corridor,at)) return false
    // A once-walked bridge can have lost its floor. Only actual fluid permits swimming over missing support.
    if (!supportAt(bot,at,1.25) && bot.blockAt(at,false)?.name!=='lava') return false
  }
  return true
}
export function backtrack(s: Body): Vec3[] {
  if (!on(s)) return []
  const bot = s.bot, st = trace(s), route: Vec3[] = []
  let from = bot.entity.position
  for (const p of [...st.points].reverse()) {
    if (!clearLeg(bot,from,p)) break
    route.push(p.clone()); from = p
  }
  // End on real, still-supported dry ground, never on a stale fluid cell.
  while (route.length && !dry(bot, route.at(-1)!)) route.pop()
  return route
}
// Следа нет (стоял, его стёрла прошлая попытка) — шаг в соседнюю сухую клетку прочь от видимой лавы рядом, без лавы над
// клеткой (лавопад сверху): dbg36-3818 — тело 1.5 с стояло под стекающей лавой, след пуст, «запасные» потом не спасли.
const DIRS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
export function stepAway(bot: Bot): Vec3[] {
  const f = bot.entity.position.floored(), lava: Vec3[] = []
  for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 4; dy++) for (let dz = -3; dz <= 3; dz++)
    if (bot.blockAt(f.offset(dx, dy, dz), false)?.name === 'lava') lava.push(f.offset(dx + .5, dy + .5, dz + .5))
  if (!lava.length) return []
  const ok = (p: Vec3) => dry(bot, p) && ![0, 1, 2, 3].some(h => bot.blockAt(p.floored().offset(0, h, 0), false)?.name === 'lava')
  const far = (p: Vec3) => Math.min(...lava.map(l => l.distanceTo(p.offset(0, .9, 0))))
  let best: { route: Vec3[]; score: number } | null = null
  for (const [dx, dz] of DIRS4) for (const dy of [0, 1, -1]) {
    const a = new Vec3(f.x + dx + .5, f.y + dy, f.z + dz + .5)
    if (!ok(a)) continue
    const b = new Vec3(a.x + dx, a.y, a.z + dz)
    const route = ok(b) && far(b) > far(a) ? [a, b] : [a]
    const score = far(route.at(-1)!)
    if (!best || score > best.score) best = { route, score }
  }
  return best ? best.route : []
}
export function rewind(s: Body): boolean {
  if (!on(s) || s.bot.health <= 0) return false
  const st = trace(s)
  if (st.busy || locks.owner(s)?.source === 'lava-nav') return true
  if (st.contact) return false // one attempt per contact; leave existing potion/swim fallbacks alive
  const b = s.bot, trail = backtrack(s), route = trail.length ? trail : stepAway(b)
  st.contact=b.entity.position.clone()
  // Abort BEFORE an Emergency lease: goto must not restore the old hazardous goal after the lease.
  const ctl = s.current?.ctl
  if (ctl && !ctl.aborted) { ctl.interruptedBy = { type:'tactical', threatLevel:4, requireObservation:true }; ctl.abort() }
  s.replanRevision = (s.replanRevision || 0) + 1
  if (!route.length) {
    // Existing potion/swim/climb remains available; no invented blind reverse direction.
    locks.emergency(s, () => {}, 0)
    return false
  }
  st.busy = true
  void locks.start(s, async (rescue: Body) => {
    const begin = b.entity.position.clone(), deadline = clock.now()+1800
    let i=0
    try {
      while (!rescue.aborted && on(s) && trace(s)===st && b.health>0 && clock.now()<deadline && i<route.length) {
        const p=b.entity.position, target=route[i]
        if (!wet(b) && b.entity.onGround && dry(b,p) && p.distanceTo(begin)>=.6) {
          b.clearControlStates()
          await sealOpened(s,rescue,[begin.floored(),begin.floored().offset(0,1,0)])
          return { ok:true, method:'dry trail reached' }
        }
        if (Math.hypot(p.x-target.x,p.z-target.z)<.12 && Math.abs(p.y-target.y)<1.25) { i++; continue }
        // A new block update can close a recorded corridor while the worker awaits look().
        if (!clearLeg(b,p,target)) break
        const steer=steerTo(b,b.entity,target,false)
        await b.look(steer.yaw,0,true)
        if (rescue.aborted || !on(s) || trace(s)!==st) break
        for (const k of ['back','left','right','sprint','sneak']) b.setControlState(k,false)
        b.setControlState('forward',steer.forward)
        b.setControlState('jump',wet(b) || target.y>p.y+.1)
        await clock.sleep(50)
      }
      return { ok:false, why:'trail rescue budget exhausted' }
    } finally { b.clearControlStates(); b.jumpQueued=false }
  }, { source:'lava-nav', owner:'Emergency', priority:3, preempt:true, immediate:true }).finally(() => {
    st.busy=false
    // Do not keep retrying the same failed trail and starve potion/flight/swim fallbacks.
    st.points=[]
  })
  return true
}
// Called immediately after each dig, before any step forward. Report breach even when the server refuses the plug.
export async function sealOpened(s: Body, ctl: Body, cells: Vec3[]): Promise<boolean> {
  if (!on(s)) return false
  const D: typeof import('./endportal-descent') = require('./endportal-descent')
  const bot=s.bot, body=bodyBox(bot,bot.entity.position), seen=new Set<string>()
  let breach=false, attempted=false
  for (const c of cells) for (const [dx,dy,dz] of [[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
    const p=c.offset(dx,dy,dz), key=`${p.x},${p.y},${p.z}`
    if (seen.has(key)) continue
    seen.add(key)
    if (D.seen(bot,p)?.name!=='lava') continue
    breach=true
    // Never entomb the current body; only a ray-visible face, with a bounded receipt wait.
    if (attempted || ctl.aborted || intersects(body,{minX:p.x,minY:p.y,minZ:p.z,maxX:p.x+1,maxY:p.y+1,maxZ:p.z+1})) continue
    attempted=true
    await placeBlockAt(bot,p,{steady:true,honest:true,exactAim:true,timeoutMs:250,ctl}).catch(()=>({ok:false}))
  }
  return breach
}
