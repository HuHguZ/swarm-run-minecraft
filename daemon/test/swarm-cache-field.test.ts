import test from 'node:test'
import assert from 'node:assert/strict'
import { CacheModel, castRays, pieCounts, type CacheScan } from '../src/swarm/cache-model'
import { swarmCaches } from '../../farm/swarm/swarm-driver/caches'

const p = (x: number, y: number, z: number) => ({ x, y, z })
const box = { x0:-15, x1:15, z0:-15, z1:15, y0:119, y1:130 }
const chest = p(7,118,2), foot = p(3.5,120,2.5)
const key = (a: typeof chest) => `${a.x},${a.y},${a.z}`
function reports(hidden = [chest]): CacheScan[] {
  return [p(4.5,121.62,1.5), p(8.5,121.62,5.5), p(10.5,121.62,.5)].map((eye,i) => ({
    eye, n:700, spin:.16+i/10, range:24,
    hits:castRays(eye, (_x,y,_z) => y === 119 ? 1 : 0, 700,.16+i/10,24),
    pie:{ step:5,range:32,bins:pieCounts(eye,hidden,5,32) }
  }))
}
test('three anonymous F3 bearings under a visible field propose uncovering a single cap from a different support', () => {
  const m = new CacheModel(box, { field: true })
  for (const r of reports()) m.addScan(r)
  m.markWalked(foot)
  const tunnel = m.planDig(foot)
  assert.equal(tunnel?.gain ?? 0,0)
  const plan = m.planSurface(foot)
  assert.ok(plan?.surface, 'the ordinary tunnel cannot credit a field discovery')
  assert.deepEqual(plan.to,chest)
  assert.deepEqual(plan.surface,p(7,119,2))
  assert.equal(plan.from.y,120)
  assert.equal(Math.abs(plan.from.x-chest.x)+Math.abs(plan.from.z-chest.z),1)
  assert.ok(plan.gain > 0 && plan.gain <= 1)
  assert.ok(!m.known.has(key(chest)), 'bearing intersection is only a hypothesis')
  assert.equal(m.planSurface(foot,{reserved:new Set(plan.exposed)})?.to.x === chest.x,false)
  m.surveySurface(plan.surface)
  assert.equal(m.planSurface(foot),null,'a physically examined cell is shared')
})
test('no field dig from an empty bearing, unseen cover, occupied entrance, or an old chest contradicted this round', () => {
  for (const mode of ['empty','no cover','no stand','surveyed memory','opened']) {
    const m = new CacheModel(box,{field:true})
    if (mode === 'surveyed memory' || mode === 'opened') m.known.set(key(chest),chest)
    for (const r of reports(mode === 'empty' || mode === 'surveyed memory' ? [] : [chest])) m.addScan(mode === 'no cover' ? {...r,hits:[]} : r)
    m.markWalked(foot)
    assert.equal(m.planSurface(foot,{skip:()=>mode==='no stand',opened:mode==='opened'?new Set([key(chest)]):undefined}),null,mode)
  }
})

test('a disproved historical chest cannot consume a different chest in a shared distant F3 sector', () => {
  const old = p(8,118,2), m = new CacheModel(box,{field:true})
  m.known.set(key(old), old)
  const eye = p(-11.5,121.62,2.5)
  m.addScan({eye,n:700,spin:.15,range:32,hits:castRays(eye,(_x,y,_z)=>y===119?1:0,700,.15,32),
    pie:{step:5, range:32, bins:pieCounts(eye,[chest],5,32)}})
  for (const r of reports()) m.addScan(r)
  const offer = m.planSurface(foot)
  assert.deepEqual(offer?.to, chest, 'another vantage contradicts the stale location')
  assert.ok(m.known.has(key(old)), 'the previous-round sighting still belongs to memory')
})

test('a reported attacker releases the field search to the safe miner in a twenty-bot team', async t => {
  const oldMap = process.env.ARMS_MAP, oldMemory = process.env.ARMS_CACHE_MEMORY
  process.env.ARMS_MAP = 'colosseum'; process.env.ARMS_CACHE_MEMORY = '0'
  t.after(() => {
    for (const [k, v] of [['ARMS_MAP', oldMap], ['ARMS_CACHE_MEMORY', oldMemory]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })
  let now = 1000, current: CacheScan
  const calls: any[] = [], logs: string[] = [], pos: any = {}
  const bots = Array.from({ length: 20 }, (_, i) => {
    const name = ['A', 'B', 'Scout'][i] || 'Wing' + i
    pos[name] = { p: i === 0 ? p(-9,120,-9) : p(12.5,120,2.5), hp: 20, inv: i < 2 ? { iron_pickaxe: 1 } : {} }
    return { name, swarmTask: { kind: i === 0 ? 'fight' : 'loot' }, c: { async call(method: string) {
      return { status:'done', detail: method === 'cache_scan' ? current : {} }
    } } }
  })
  const arena = { x:0,y:120,z:0,r:16 }
  const board = { enemies: () => [{ id:'Human', position:p(-8,120,-9), seenAt:now }] }
  const work = swarmCaches({ arms:true, arena, bots, pos, now:()=>now, alive:()=>true, teamOf:()=>'blue', generation:1,
    boardOf:()=>board, lootArena:()=>arena, detail:r=>r?.detail, go:async (b, at)=>{ calls.push([b.name,at]);return {status:'interrupted'} },
    log:s=>logs.push(s), placed:new Map(), blocked:()=>false, failed() {} } as any)
  for (current of reports()) {
    pos.Scout.p = {...current.eye, y:current.eye.y-1.62}; now+=21000
    work.cacheObserve(bots[2]); await new Promise(resolve=>setImmediate(resolve))
  }
  assert.equal(await work.cacheTurn(bots[0], board),false)
  assert.equal(await work.cacheTurn(bots[1], board),true)
  assert.deepEqual(calls.map(c=>c[0]),['B'])
  assert.equal(Math.abs(calls[0][1].x-.5-chest.x)+Math.abs(calls[0][1].z-.5-chest.z),1)
  const assignment = logs.find(line=>line.includes('B: ищу тайники'))!
  assert.match(assignment,/0\.00·14 \+ 1\.00·1\.5/, 'field loot is valued as an ordinary chest')
  t.diagnostic(assignment)
})
