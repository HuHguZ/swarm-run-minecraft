import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { enemyWindFrames, pendingWindHit, planEnemyWind } from '../src/combat/enemy-wind'
const clock: typeof import('../src/game-clock') = require('../src/game-clock')
const pick: typeof import('../src/pick') = require('../src/pick')
const threats: typeof import('../src/threats') = require('../src/threats')
const search: typeof import('../src/pvp/search') = require('../src/pvp/search')

// DB strict A: the native lead was in flight for eight ticks.
const recordedBirthA = { born: 1793904481818.417, sync: 1793904481831.4214, now: 1793904481942.1335, tick: 15779281,
  velocity: new Vec3(1.5072294491030505, .046798112317056946, -.0017993985525146129), motion: undefined as Vec3 | undefined,
  ownZ: 601.5, previous: 1793904481731.3835, latest: 1793904481831.1301 }

function recordedBirth(t, ownX: number, nominalDelay = 0, capture = recordedBirthA) {
  const { born, sync, now, tick, velocity } = capture
  const origin = new Vec3(592.7, 202.62000000476837, 600.5)
  const position = new Vec3(604.5, 201, 600.5), idle = new Vec3(0, 0, 0), yaw = Math.PI
  const foe = { id: 181, username: 'Red', type: 'player', position, velocity: idle, onGround: true, yaw,
    metadata: [], equipment: [], width: .6, height: 1.8, _ndVisible: true, _ndMotionEpoch: 2, _ndObservationNow: () => now,
    _ndPositionReceipts: [
      { ...position, t: capture.previous, kind: 'reacquired', grounded: false, yaw },
      { ...position, t: capture.latest, kind: 'sync_entity_position', grounded: true, yaw }
    ] }
  const own = { id: 'Blue', position: new Vec3(ownX, 201, capture.ownZ), velocity: new Vec3(0, -.0784000015258789, 0),
    launchMovement: idle, onGround: true, gameTick: tick }
  const ally = { id: 182, username: 'Relay', type: 'player', position: origin.offset(0, -1.62, 0),
    velocity: idle, onGround: true, width: .6, height: 1.8 }
  const record = { name: 'wind_charge', owner: ally.id, p: origin, observedAt: born }
  const charge = { id: 200, name: record.name, position: origin }
  const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
  const world = { getBlock(p: Vec3) {
    const q = p.floored()
    const floor = q.x >= 588 && q.x <= 616 && (q.y === 200 && q.z >= 595 && q.z <= 611 || q.y === 199 && q.z >= 589 && q.z <= 594)
    const b = Block.fromStateId(registry.blocksByName[floor ? 'stone' : 'air'].defaultState)
    b.position = q; return b
  } }
  const bot = { entity: { ...own, id: 180, username: own.id, type: 'player', width: .6, height: 1.8 }, username: own.id,
    registry, version: '1.21.11', food: 20, game: { minY: -64, height: 384 }, inventory: { slots: [], items: () => [] },
    physics: require('../src/tick-plugins').getPhysics().Physics(registry, world), blockAt: world.getBlock,
    ndClock: { age: BigInt(tick), ticks: 20, serverTicks: 20 }, _ndSwarmAllies: [ally.username], _ndThrown: new Map([[charge.id, record]]),
    entities: { [foe.id]: foe, [ally.id]: ally, [charge.id]: charge }, players: { Red: { entity: foe }, Relay: { entity: ally } } }
  t.mock.method(clock, 'observationNow', () => now)
  t.mock.method(threats, 'projectileView', () => ({ position: origin, _ndObservationNow: () => now, _ndPositionReceipts: [null, { t: sync }],
    _ndWindMotion: { position: capture.motion ?? origin.plus(velocity.scaled((sync - born) / 50)), velocity, t: sync, birth: { velocity, record } } }))
  const arena = { x: 600, y: 201, z: 600.5, r: 9, ellipse: { a: 8, b: 10 }, killY: 190 }
  const options = { arena, startTick: tick, delays: [nominalDelay], maxShots: 1, waitForHit: true, visiblePrefix: true,
    reactAfterHit: true, expectedPrefix: nominalDelay ? undefined : charge.id, collision: bot, allies: [{ ...ally, id: ally.username, gameTick: tick }] }
  return { bot, foe, arena, origin, expected: charge.id, plan: () => planEnemyWind(bot, foe, [own], options) }
}

test('a stale birth witness keeps the recorded launch ray and rejects a possibly simultaneous second hit', t => {
  const f = recordedBirth(t, 595)
  const frames = enemyWindFrames(f.bot, f.foe, f.arena, [], 0, true, f.bot)
  const hold = pendingWindHit(f.bot, f.foe, frames, [], f.bot)
  const follow = pendingWindHit(f.bot, f.foe, frames, [], f.bot, { witness: true })
  assert.equal(hold?.id, f.expected, 'ordinary pending protection still holds for the visible charge')
  assert.equal(follow?.ticks, hold?.ticks, 'follow certification does not shift the ordinary pending estimate')
  assert.deepEqual(follow?.witness?.from, f.origin, 'the first ray must retain its actual launch point')
  assert.equal(follow?.witness?.age, 2, 'the adjacent age-one branch remains in the paired forecast')
  assert.equal(f.plan(), null, 'the seven-tick follower can arrive with the latest plausible lead impact')
})

test('the same immutable birth ray still permits a later eight-tick follower', t => {
  const f = recordedBirth(t, 593.5), plan = f.plan()
  assert.equal(plan?.relayPrefix, f.expected)
  assert.equal(plan?.shots[0].ticks, 8)
})

test('an eight-tick follower can bid for the current tick when the ordinary lead is one tick', t => {
  const f = recordedBirth(t, 593.5, 1), plan = f.plan()
  assert.equal(plan?.relayPrefix, f.expected)
  assert.equal(plan?.shots[0].ticks, 8)
  assert.equal(plan?.shots[0].fireDelay, 0)
})

test('a granted EF relay retains the exact lead contact when receipt drift skips an expanding hitbox face', t => {
  const f = recordedBirth(t, 593.102, 0, {
    born: 1793938303789.2112, sync: 1793938303831.0896, now: 1793938303912.7056, tick: 15779293,
    velocity: new Vec3(1.5050593311166245, .04245332950103431, -.006998018291965127),
    motion: new Vec3(593.9605900747255, 202.65555757030856, 600.4941386813003),
    ownZ: 601.456, previous: 1793938303689.2944, latest: 1793938303911.017
  })
  assert.equal(f.plan()?.relayPrefix, f.expected)
})

// T1 c's actual +867ms pending check: its returned fair projectile views and native-kernel target frames.
// Other bodies are the public NPC packet snapshot 30ms before that call. The test world is explicitly open air;
// it measures repeated entity LOS work, not an offline reconstruction of the Colosseum's terrain/visibility.
const recordedT = {"at":1793813376417.547,"gameTick":15480308,"target":{"id":1797,"username":"RedWw2e68ia","position":{"x":599.696533203125,"y":130.84724608063698,"z":600.739501953125},"width":0.6,"height":1.8},"own":{"x":612.5,"y":120,"z":602.5},"frames":[[598.8487002441406,132.2481980561902,601.0356918457031],[598.4811136088866,132.81052649632235,601.1641079975586],[598.1466097708055,133.28320837685155,601.2809666957471],[597.8422112781518,133.66803662725997,601.3873081110986],[597.5652086498369,133.96676831847435,601.4840787990685],[597.3131362580704,134.18112538003643,601.5721401251211],[597.0837503815628,134.31279530292994,601.652275931829],[596.8750092339409,134.3634318283511,601.7251995159331],[596.6850547896049,134.3346556227038,601.791559977468],[596.5121962452592,134.22805493909468,601.8519479974645],[596.3548949699046,134.0451862655986,601.9069010956615],[596.211750809332,133.78757496055863,601.9569084150207],[596.0814896232108,133.45671587518004,602.0024150756376],[595.9629519438406,133.0540739636725,602.043826136799],[595.8550826556137,132.58108488118944,602.0815102024559],[595.7569216033272,132.03915556980863,602.1158027022036],[595.6675950457466,131.42966483279307,602.147008876974],[595.5863078783482,130.75396389736682,602.1754064960152],[595.5123365560156,130.01337696623526,602.2012483293425],[595.445022652693,129.20920175807487,602.2247643976705],[595.3837670006693,128.34271003721338,602.2461640198488],[595.3280243573279,127.41514813271623,602.2656376760312],[595.2772985518872,126.4277374470913,602.2833587031572],[595.231138068936,125.38167495481963,602.2994848378419],[595.1891320294505,124.27813369091545,602.3141596204049],[595.1509065335188,123.1182632297151,602.3275136725372],[595.1161213322208,121.9031901540901,602.3396658599776],[595.0844667990397,120.63401851527604,602.3507243505484],[595.0556611738449,120,602.3607875769678],[595.0294480549176,120,602.3699451130095],[595.0151356919832,120,602.3749451276883],[595.0073211418211,120,602.3749451276883],[595.0030543974326,120,602.3749451276883]],"bodies":[{"username":"NeuroFarm31","position":{"x":609.3555722084275,"y":123.41047850251198,"z":595.9554484022763}},{"username":"NeuroFarm31c","position":{"x":612.5,"y":120,"z":602.5}},{"username":"NeuroFarm31d","position":{"x":614.5,"y":120,"z":600.5}},{"username":"NeuroFarm31e","position":{"x":548.9525215256091,"y":139.60670211847398,"z":596.756212821182}},{"username":"NeuroFarm31f","position":{"x":627.6827062565135,"y":150.5,"z":655.2966949758919}},{"username":"NeuroFarm31g","position":{"x":664.5094891265367,"y":150.64136799395752,"z":623.8651234567718}},{"username":"NeuroFarm31h","position":{"x":660.9445330379774,"y":143,"z":578.4513127778811}},{"username":"NeuroFarm31i","position":{"x":615.176958414466,"y":159.94543985605372,"z":563.8673853424177}},{"username":"NeuroFarm31j","position":{"x":552.5,"y":153.5,"z":554.5478169299072}},{"username":"NeuroFarm31k","position":{"x":632.5586137686888,"y":136.875,"z":549.6383756758177}},{"username":"NeuroFarm31l","position":{"x":642.6437123076738,"y":124,"z":620.6453289577025}},{"username":"NeuroFarm31m","position":{"x":586.0830707449246,"y":131.3417924350822,"z":580.6490829264878}},{"username":"NeuroFarm31n","position":{"x":656.7451831107215,"y":141.5444836768791,"z":577.6274508624259}},{"username":"NeuroFarm31o","position":{"x":630.935302734375,"y":162.40632811188698,"z":572.1347260163889}},{"username":"NeuroFarm31p","position":{"x":566.918129849899,"y":165.83788201692158,"z":564.1630331603965}},{"username":"NeuroFarm31q","position":{"x":579.5022872547288,"y":137.41999998688698,"z":649.5}},{"username":"NeuroFarm31r","position":{"x":554.3178507402105,"y":136,"z":640.210267077045}},{"username":"NeuroFarm31s","position":{"x":572.499899588658,"y":138.72639647126198,"z":622.4283669345699}},{"username":"NeuroFarm31t","position":{"x":573.1413792317077,"y":128,"z":639.2376255988296}},{"username":"NeuroFarm31u","position":{"x":635.7256527405196,"y":166.50349608063698,"z":603.1836885724563}}],"charges":[{"id":1809,"owner":192,"observedAt":1793813375797.6465,"spawn":{"x":614.5,"y":121.62000000476837,"z":600.5},"velocity":{"x":-1.275102240126961,"y":0.8307391808582065,"z":-0.023072697308185397},"view":{"id":1809,"name":"wind_charge","position":{"x":601.7492047372111,"y":129.9276138548356,"z":600.2697659849439},"receipts":[{"x":614.5,"y":121.62000000476837,"z":600.5,"t":1793813375805.5508},{"x":601.7492047372111,"y":129.9276138548356,"z":600.2697659849439,"t":1793813376257.1936}],"motion":{"position":{"x":601.7492047372111,"y":129.9276138548356,"z":600.2697659849439},"velocity":{"x":-1.2750795262788857,"y":0.8307613850067251,"z":-0.023023401505589555},"t":1793813376257.2385}},"viewNow":1793813376417.952},{"id":1811,"owner":191,"observedAt":1793813375805.796,"spawn":{"x":612.5,"y":121.62000000476837,"z":602.5},"velocity":{"x":-1.1811023622047245,"y":0.9004455838369041,"z":-0.203747787340536},"view":{"id":1811,"name":"wind_charge","position":{"x":612.5,"y":121.62000000476837,"z":602.5},"receipts":[{"x":612.5,"y":121.62000000476837,"z":602.5,"t":1793813375805.8472},{"x":612.5,"y":121.62000000476837,"z":602.5,"t":1793813375835.266}],"motion":{"position":{"x":611.8037125953422,"y":122.15086210627464,"z":602.3798977210168},"velocity":{"x":-1.1810865067082916,"y":0.9004816988179538,"z":-0.20372504253695045},"t":1793813375835.2866,"birth":{"velocity":{"x":-1.1810865067082916,"y":0.9004816988179538,"z":-0.20372504253695045},"spawnPosition":{"x":612.5,"y":121.62000000476837,"z":602.5},"spawnVelocity":{"x":-1.1811023622047245,"y":0.9004455838369041,"z":-0.203747787340536},"observedAt":1793813375805.81,"t0":1793813385042}}},"viewNow":1793813376541.8386}]}

function fixture(t: any, firstOnly = false) {
  const point = (p: any) => new Vec3(p.x, p.y, p.z)
  const own: any = { id: 191, username: 'NeuroFarm31c', position: point(recordedT.own), width: .6, height: 1.8 }
  const foe: any = { ...recordedT.target, position: point(recordedT.target.position) }
  const entities: any = { 191: own, [foe.id]: foe }
  let id = 5000
  for (const b of recordedT.bodies) {
    if (b.username === own.username) continue
    const eid = b.username === 'NeuroFarm31d' ? 192 : b.username === 'NeuroFarm31' ? 190 : id++
    entities[eid] = { id: eid, username: b.username, type: 'player', position: point(b.position), width: .6, height: 1.8 }
  }
  const bot: any = { entity: own, entities, username: own.username,
    ndClock: { age: BigInt(recordedT.gameTick), ticks: 0, serverTicks: 0 },
    blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] }) }
  const records = new Map(), views = new Map(), viewCalls = new Map(), los = new Map()
  for (const q of firstOnly ? recordedT.charges.slice(0, 1) : recordedT.charges) {
    records.set(q.id, { name: 'wind_charge', p: q.spawn, v: q.velocity, observedAt: q.observedAt, owner: q.owner })
    entities[q.id] = { id: q.id, name: 'wind_charge', position: point(q.view.position) }
    views.set(q.id, { id: q.id, position: point(q.view.position), _ndPositionReceipts: q.view.receipts,
      _ndWindMotion: q.view.motion, _ndObservationNow: () => q.viewNow })
  }
  let hidden = false
  t.mock.method(clock, 'observationNow', () => recordedT.at)
  t.mock.method(threats, 'thrownTracker', () => records)
  t.mock.method(threats, 'projectileView', (_b, e) => { viewCalls.set(e.id, (viewCalls.get(e.id) || 0) + 1); return views.get(e.id) })
  t.mock.method(search, 'observedCollision', () => bot)
  t.mock.method(pick, 'canHit', (_b, e) => { los.set(e.id, (los.get(e.id) || 0) + 1); return e.username !== 'Blocker' || !hidden })
  const frames = recordedT.frames.map(p => ({ pos: new Vec3(p[0], p[1], p[2]), vel: new Vec3(0, 0, 0), onGround: false }))
  return { bot, foe, frames, los, viewCalls, records, views, setHidden: (v: boolean) => { hidden = v } }
}

test('recorded T pending miss needs no world or entity rays when both charges miss the whole body', t => {
  const f = fixture(t)
  assert.equal(pendingWindHit(f.bot, f.foe, f.frames), null)
  assert.deepEqual([...f.viewCalls.values()], [1, 1], 'each charge has one returned fair view')
  assert.equal(f.los.size, 0)
})

function hitFrames(f: ReturnType<typeof fixture>) {
  const q = recordedT.charges[0], v = new Vec3(q.view.motion.velocity.x, q.view.motion.velocity.y, q.view.motion.velocity.z)
  const at = new Vec3(q.view.motion.position.x, q.view.motion.position.y, q.view.motion.position.z)
    .plus(v.scaled((q.viewNow - q.view.motion.t) / 50))
  return { at, v, frames: f.frames.map(() => ({ pos: at.plus(v.scaled(8)).offset(0, -.5, 0), vel: new Vec3(0, 0, 0), onGround: false })) }
}

test('the same native T ray still protects its eighth-tick physical hit', t => {
  const f = fixture(t, true), h = hitFrames(f)
  const hit = pendingWindHit(f.bot, f.foe, h.frames)
  assert.equal(hit?.id, 1809); assert.equal(hit?.ticks, 8)
  assert.ok([...f.los.values()].every(n => n === 1))
})

test('an observed native charge can protect a hit after the old thirty-tick cutoff', t => {
  const f = fixture(t, true), h = hitFrames(f)
  const frames = Array.from({ length: 66 }, () => ({ pos: h.at.plus(h.v.scaled(35)).offset(0, -.5, 0), vel: new Vec3(0, 0, 0), onGround: false }))
  assert.equal(pendingWindHit(f.bot, f.foe, frames)?.id, 1809)
  assert.ok(pendingWindHit(f.bot, f.foe, frames).ticks > 30)
  assert.equal(pendingWindHit(f.bot, f.foe, frames.slice(0, 30)), null, 'an unknown future remains unavailable beyond the supplied frames')
})

test('pending LOS caches false inside one call and observes a newly visible interceptor on the next call', t => {
  const f = fixture(t, true), h = hitFrames(f)
  f.bot.entities[7000] = { id: 7000, username: 'Blocker', type: 'player', position: h.at.plus(h.v.scaled(4)).offset(0, -.5, 0), width: .6, height: 1.8 }
  f.setHidden(true)
  assert.equal(pendingWindHit(f.bot, f.foe, h.frames)?.ticks, 8)
  assert.equal(f.los.get(7000), 1, 'an invisible body remains unavailable throughout this synchronous call')
  f.los.clear(); f.setHidden(false)
  assert.equal(pendingWindHit(f.bot, f.foe, h.frames), null, 'a current visible body intercepts the charge before the target')
  assert.equal(f.los.get(7000), 1, 'the previous false is not retained by the next call')
  f.los.clear(); f.setHidden(true)
  assert.equal(pendingWindHit(f.bot, f.foe, h.frames)?.ticks, 8)
  assert.equal(f.los.get(7000), 1, 'a later LOS gap does not retain the prior true either')
})

test('pending work never projects a charge without its current returned fair view', t => {
  const f = fixture(t, true), h = hitFrames(f), view = f.views.get(1809)
  f.views.set(1809, null)
  assert.equal(pendingWindHit(f.bot, f.foe, h.frames), null)
  assert.equal(f.los.size, 0, 'a stored native motion is insufficient after loss of projectile visibility')
  f.views.set(1809, view)
  assert.equal(pendingWindHit(f.bot, f.foe, h.frames)?.ticks, 8, 'the next call can use the newly fair projectile again')
})

// Y1470's public motion was already returned to both actors before its actual native hit.
const recordedY = {
  c: { time: 1793821044526.7703, viewNow: 1793821044592.1738, born: 1793821044326.0713, receipt: 1793821044327.6953, motionAt: 1793821044327.701,
    motion: [608.4676178842955, 121.65620734769122, 598.4945584773855],
    frames: [[598.2917913275114,133.2751466360056,597.0355123118455],[598.2538399902344,132.6762844811113,596.975406640625],[598.2193042733122,132.01099955636667,596.9207104798143],[598.187876770913,131.28062031590173,596.8709369734765],[598.1592777437298,130.48644864478933,596.8256430827092],[598.1332526289931,129.62976039042567,596.7844256421109],[598.1095697745826,128.71180588328338,596.7469177711665],[598.0880183770691,127.73381044724945,596.7127856086071]] },
  e: { time: 1793821044019.5957, viewNow: 1793821044019.5957, born: 1793821043751.263, receipt: 1793821043856.1597, motionAt: 1793821043856.2117,
    motion: [606.4145917486272, 123.95175288899951, 598.1495659436208],
    frames: [[598.2920724833984,133.2753532186166,597.0355252009276],[598.2541985249326,132.6765571887082,596.9754230769985],[598.2197332227286,132.01133706645095,596.920730144223],[598.188369797723,131.2810213324249,596.8709595753973],[598.1598290809679,130.48691189762383,596.8256683577658],[598.1338570287207,129.63028463484648,596.7844533497213],[598.1102224611758,128.7123898994599,596.7469476924007],[598.0887150047099,127.73445303974775,596.712817544239]] }
}

function recordedYFixture(t: any, actor: 'c' | 'e' = 'c', elapsed = 0) {
  const f = fixture(t, true), q = recordedY[actor], point = (p: number[]) => new Vec3(p[0], p[1], p[2])
  const velocity = new Vec3(-.9935366736016584, 1.1109009484042511, -.16695488111862727)
  f.records.clear(); f.views.clear()
  f.records.set(1470, { name: 'wind_charge', owner: 219, p: { x: 608.5, y: 121.62000000476837, z: 598.5 }, v: velocity, observedAt: q.born })
  const view = { id: 1470, position: new Vec3(608.5, 121.62000000476837, 598.5), _ndPositionReceipts: [null, { t: q.receipt }],
    _ndWindMotion: { position: point(q.motion), velocity, t: q.motionAt }, _ndObservationNow: () => q.viewNow + elapsed }
  f.views.set(1470, view)
  f.bot.entities = { [f.bot.entity.id]: f.bot.entity, [f.foe.id]: f.foe,
    219: { id: 219, username: 'NeuroFarm31', type: 'player', position: view.position },
    1470: { id: 1470, name: 'wind_charge', position: view.position } }
  t.mock.method(clock, 'observationNow', () => q.time)
  f.frames = q.frames.map(p => ({ pos: point(p), vel: new Vec3(0, 0, 0), onGround: false }))
  return { ...f, view, velocity }
}

for (const actor of ['c', 'e'] as const) test(`recorded Y ${actor} preserves an already visible hit across asynchronous body movement`, t => {
  // e's exact dynamic view clock was not logged; its first returned-view call brackets it within one millisecond.
  for (const elapsed of actor === 'e' ? [0, 1] : [0]) {
    const f = recordedYFixture(t, actor, elapsed), hit = pendingWindHit(f.bot, f.foe, f.frames)
    assert.equal(hit?.id, 1470, 'the incoming cast can hit before the target advances to the next body pose')
    assert.ok(hit.ticks <= 5)
  }
})

for (const mode of ['near miss', 'wall', 'unknown cell', 'interceptor', 'hidden projectile', 'stale projectile', 'scheduled cast', 'short forecast']) {
  test(`pending body movement window still rejects ${mode}`, t => {
    const f = recordedYFixture(t), q = f.records.get(1470)
    let scheduled: any[] = []
    if (mode === 'near miss') for (const frame of f.frames) frame.pos.z += 3
    if (mode === 'wall') f.bot.blockAt = p => p.floored().x === 602
      ? { name: 'stone', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty', shapes: [] }
    if (mode === 'unknown cell') f.bot.blockAt = () => null
    if (mode === 'interceptor') {
      const motion = f.view._ndWindMotion, position = motion.position.plus(f.velocity.scaled((f.view._ndObservationNow() - motion.t) / 50 + 2)).offset(0, -.5, 0)
      f.bot.entities[7000] = { id: 7000, username: 'Blocker', type: 'player', position, width: .6, height: 1.8 }
    }
    if (mode === 'hidden projectile') f.views.set(1470, null)
    if (mode === 'stale projectile') f.view._ndObservationNow = () => f.view._ndWindMotion.t + 21 * 50
    if (mode === 'scheduled cast') scheduled = [{ thrower: 'NeuroFarm31', fireTick: Number(f.bot.ndClock.age) - Math.round((recordedY.c.time - q.observedAt) / 50), from: q.p, velocity: f.velocity }]
    if (mode === 'short forecast') f.frames = f.frames.slice(0, 5)
    assert.equal(pendingWindHit(f.bot, f.foe, f.frames, scheduled), null)
  })
}

test('pending movement window keeps a different cast and refreshes current interceptor visibility', t => {
  const f = recordedYFixture(t), q = f.records.get(1470)
  const other: any = { thrower: 'NeuroFarm31', fireTick: Number(f.bot.ndClock.age) - Math.round((recordedY.c.time - q.observedAt) / 50) + 2, from: q.p, velocity: f.velocity }
  assert.equal(pendingWindHit(f.bot, f.foe, f.frames, [other])?.id, 1470, 'a scheduled same-owner cast in another native epoch is unrelated')
  const motion = f.view._ndWindMotion, position = motion.position.plus(f.velocity.scaled((f.view._ndObservationNow() - motion.t) / 50 + 2)).offset(0, -.5, 0)
  f.bot.entities[7000] = { id: 7000, username: 'Blocker', type: 'player', position, width: .6, height: 1.8 }
  f.setHidden(true)
  assert.equal(pendingWindHit(f.bot, f.foe, f.frames)?.id, 1470, 'hidden third bodies are not read into the ray')
  f.setHidden(false)
  assert.equal(pendingWindHit(f.bot, f.foe, f.frames), null, 'the next call observes the new visible interception')
})
