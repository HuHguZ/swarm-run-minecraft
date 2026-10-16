import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

const source = fs.readFileSync(path.join(__dirname, '../campaign.ts'), 'utf8')
function fixture(env = {}) {
  const calls: any[] = [], inventory: any = { bucket: 1, flint_and_steel: 1, stone_pickaxe: 1 }
  const ctx: any = { process: { env }, state: { pos: { x: 0, y: 8, z: 0 }, health: 20 },
    sit: { surface: false, night: false }, known: {}, knownWater: null, died: false, strategyInterrupted: false,
    stairEntrance: { y: 149 }, surfaceShaft: null, OW_HEAR: true, OW_DEEP: false, waterSearchView: '', waterSearchFailedView: '',
    have: re => Object.entries(inventory).reduce((n, [k, v]) => n + ((typeof re === 'string' ? k === re : re.test(k)) ? Number(v) : 0), 0),
    y: () => ctx.state.pos.y, dim: () => 'overworld', log() {},
    act: async (method, params) => { calls.push({ method, params }); return { status: 'done', detail: {} } },
    intelligence: { environment: { observe: async () => ({}) }, registry: { get: id => ({ estimateCost: () => 1200, estimateRisk: () => 0 }) } },
    structureValue: { SECONDS: { iron: 152 } }, nightHold: () => false,
    smeltAll: async () => { inventory.iron_ingot = 3; inventory.raw_iron = 0 },
    craft: async () => { inventory.iron_ingot -= 3; inventory.bucket++ }
  }
  vm.createContext(ctx)
  vm.runInContext(source.slice(source.indexOf('const lavaApproachSeconds ='), source.indexOf('const surfaceLavaNear =')) + '\nthis.lavaPrice=lavaApproachSeconds', ctx)
  for (const [a, b] of [['async function kitWaterHere', "defStage('water',"], ['async function approachCastLava', "defStage('cast',"], ['const portalBuckets =', 'async function spendIron ()']]) {
    const start = source.indexOf(a), end = source.indexOf(b, start)
    if (start >= 0) vm.runInContext(source.slice(start, end), ctx)
  }
  return { ctx, calls, inventory }
}

test('water heard below a mountain is tried before climbing 141 blocks, without OW_DEEP', async () => {
  const f = fixture()
  f.ctx.act = async (method, params) => {
    f.calls.push({ method, params })
    if (params.listen) return { detail: { heard: [{ dir: 'east', flat: 6, height: 0, dist: 6 }] } }
    if (method === 'tunnel') return { detail: { stopped: 'вода на 7,8,0' } }
    if (params.waterHint) { f.inventory.water_bucket = 1; f.inventory.bucket = 0 }
    return { detail: {} }
  }
  assert.equal(await f.ctx.kitWaterHere(), true)
  assert.equal(f.calls.some(c => c.method === 'surface' || c.method === 'shelter'), false)
  assert.equal(f.calls.find(c => c.method === 'tunnel')?.params.direction, 'east')
  assert.equal(f.calls.find(c => c.params.waterHint)?.params.waterHint.x, 7)
})

test('water switch disables local work; silent caves do not cause blind tunnelling', async () => {
  for (const env of [{ ND_OW_KIT_WATER: '0' }, {}]) {
    const f = fixture(env)
    assert.equal(await f.ctx.kitWaterHere(), false)
    assert.equal(f.calls.some(c => c.method === 'tunnel' || c.method === 'dig_down'), false)
  }
})

test('a cheap surface alternative beats a long, uncertain water dig', async () => {
  const f = fixture(); f.ctx.state.pos.y = 148
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { detail: { heard: [{ dir: 'east', flat: 16, height: -12 }] } } }
  assert.equal(await f.ctx.kitWaterHere(), false)
  assert.equal(f.calls.some(c => c.method === 'tunnel' || c.method === 'dig_down'), false)
})

test('remembered water uses a three-dimensional approach and no exact sound coordinates', async () => {
  const f = fixture(); f.ctx.knownWater = { x: 4, y: 10, z: 0 }
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); if (params.waterHint) f.inventory.water_bucket = 1; return { detail: {} } }
  assert.equal(await f.ctx.kitWaterHere(), true)
  const go = f.calls.find(c => c.method === 'goto')
  assert.equal(go.params.y, 10); assert.equal(go.params.surface, false)
})

test('water handoff stops after a tactical interruption before looking or digging', async () => {
  const f=fixture()
  f.ctx.act=async(method,params)=>{f.calls.push({method,params});return {status:'interrupted'}}
  assert.equal(await f.ctx.kitWaterHere(),null)
  assert.equal(f.calls.length,1)
})

test('water scouting prices the visible lower slope instead of searching along the summit',async()=>{
  const f=fixture();f.ctx.sit.surface=true;f.ctx.state.pos.y=132
  f.ctx.act=async(method,params)=>{f.calls.push({method,params});return {detail:{surface:params.yaw===90
    ?{name:'grass_block',pos:{x:-24,y:110,z:0},dist:30,water:false}
    :{name:'stone',pos:{x:0,y:131,z:2},dist:3,water:false}}}}
  assert.equal(await f.ctx.waterSearchDirection(),'west')
  assert.equal(f.calls.some(c=>c.method==='goto'||c.method==='dig_down'),false)
  const off=fixture({ND_OW_KIT_WATER:'0'});off.ctx.sit.surface=true
  assert.equal(await off.ctx.waterSearchDirection(),null);assert.equal(off.calls.length,0)
})

test('failed water exploration is re-admitted by a changed view, not elapsed time or health',async()=>{
  const f=fixture();f.ctx.sit.surface=true;f.ctx.state.pos.y=132
  let floor=110
  f.ctx.act=async()=>({detail:{surface:{name:'stone',pos:{x:-24,y:floor,z:0},dist:30,water:false}}})
  assert.ok(await f.ctx.waterSearchDirection())
  f.ctx.waterSearchFailedView=f.ctx.waterSearchView;f.ctx.state.health=12
  assert.equal(await f.ctx.waterSearchDirection(),undefined)
  floor=109
  assert.ok(await f.ctx.waterSearchDirection())
})

test('an interrupted slope observation returns control before a water-search move',async()=>{
  const f=fixture();f.ctx.sit.surface=true
  f.ctx.act=async(method,params)=>{f.calls.push({method,params});return {status:'interrupted'}}
  assert.equal(await f.ctx.waterSearchDirection(),undefined)
  assert.equal(f.calls.length,1)
})

test('a confirmed surface pool can beat the closer horizontal glimpse far below',()=>{
  const f=fixture()
  assert.ok(f.ctx.lavaPrice({x:100,y:8,z:0},true)<f.ctx.lavaPrice({x:0,y:-54,z:0},false))
})

test('snapshot lava memory restores the seen source rather than the observer 53 blocks below',async()=>{
  const place={x:20,y:15,z:-24,dimension:'overworld',note:'лава на -2,68,-26'}
  const f=fixture(),p=f.ctx.lavaMemoryPlace(place)
  assert.deepEqual([p.x,p.y,p.z],[-2,68,-26])
  assert.equal(p.dimension,'overworld');assert.equal(place.y,15)
  assert.equal(fixture({ND_OW_KIT_LAVA:'0'}).ctx.lavaMemoryPlace(place),place)
  assert.equal(f.ctx.lavaMemoryPlace({...place,note:'сгорел тут'}).y,15)
  Object.assign(f.ctx,{BASTION_KEYS:[],lavaBad:()=>false,call:async()=>({detail:{state:{places:{'лава':place}}}})})
  vm.runInContext(stripTypeScriptTypes(source.slice(source.indexOf('async function readMemory ()'),source.indexOf('let guarding ='))),f.ctx)
  await f.ctx.readMemory()
  assert.deepEqual([f.ctx.known.lava.x,f.ctx.known.lava.y,f.ctx.known.lava.z],[-2,68,-26])
})

test('remembered lava 73 blocks below is approached until height changes stop', async () => {
  const f = fixture(); f.ctx.state.pos = { x: 10, y: 88, z: 10 }; f.ctx.known.lava = { x: 10, y: 15, z: 10 }
  f.ctx.act = async (method, params) => {
    f.calls.push({ method, params }); if (method === 'dig_down') f.ctx.state.pos.y -= params.depth
    return { status: 'done', detail: {} }
  }
  assert.equal(await f.ctx.approachCastLava(), true)
  assert.ok(Math.abs(f.ctx.state.pos.y - 15) <= 6)
  assert.ok(f.calls.filter(c => c.method === 'dig_down').length > 3)
  assert.ok(f.calls.filter(c => c.method === 'dig_down').every(c => c.params.maxFallHp === 0))
})

test('an XZ-only goto receipt is not arrival; unchanged height gets one descent', async () => {
  const f = fixture(); f.ctx.known.lava = { x: 0, y: -20, z: 0 }
  assert.equal(await f.ctx.approachCastLava(), false)
  assert.equal(f.calls.filter(c => c.method === 'dig_down').length, 1)
})

test('lava switch disables the new approach; a tactical interruption never starts a descent', async () => {
  const off = fixture({ ND_OW_KIT_LAVA: '0' }); off.ctx.known.lava = { x: 0, y: -20, z: 0 }
  assert.equal(await off.ctx.approachCastLava(), false); assert.equal(off.calls.length, 0)
  const f = fixture(); f.ctx.known.lava = { x: 0, y: -20, z: 0 }
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { status: 'interrupted' } }
  assert.equal(await f.ctx.approachCastLava(), false)
  assert.equal(f.calls.some(c => c.method === 'dig_down'), false)
})

test('source refusal can buy a second bucket and preserves windows without a hidden hint', async () => {
  const f = fixture(); f.inventory.water_bucket = 1; f.inventory.bucket = 0; f.inventory.iron_ingot = 3
  f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return params.one ? { detail: { stopped: 'лавы со столба не достать', frame: '9/10 обсидиан' } } : { detail: { built: true } } }
  const r = await f.ctx.castForKit({ mode: 'cast', windows: true, hint: { x: 99, y: 3, z: 99 } })
  assert.equal(r.detail.built, true)
  assert.equal(f.calls.at(-1).params.windows, true)
  assert.equal(f.calls.at(-1).params.hint, undefined)
  assert.equal(f.calls.at(-1).params.one, undefined)
})

test('frame switch restores the old shore-only fallback; expensive iron keeps the alternative', async () => {
  for (const env of [{ ND_OW_KIT_FRAME: '0' }, {}]) {
    const f = fixture(env); f.inventory.water_bucket = 1; f.inventory.bucket = 0
    f.ctx.act = async (method, params) => { f.calls.push({ method, params }); return { detail: { stopped: 'лавы со столба не достать' } } }
    await f.ctx.castForKit({ mode: 'cast' })
    assert.equal(f.calls.length, 1)
  }
})
