// Под стрелами не стоим после сорванного подъёма и используем готовый расчёт ветра.
import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmClimb } from './swarm/swarm-driver/climb'
import { ascentActive, runAscent } from './swarm/swarm-driver/ascent'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { pearlStandGallery } from '../daemon/test/pearl-stand-fixture'

function fixture({ inventory = { stone: 64, iron_pickaxe: 1 }, reply = null, ladder = false }: any = {}) {
  let time = 1000
  const calls: any[] = [], refusals = new Set<string>()
  const frame: any = { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: inventory,
    frame: 20, frameAt: time, observedAt: time }
  const b: any = { name: 'A', arrowThreat: { active: true, at: time }, c: { async call(method, params) {
    calls.push({ method, params, climbing: !!b.climbing, ascent: b.swarmAscent })
    if (reply) { const r = await reply(method, params, b, frame); if (r) return r }
    return { status: 'done', detail: method === 'goto' ? { why: 'no path' } : { ok: false } }
  } } }
  const sw: any = { now: () => time, pos: { A: frame }, log() {}, arena: { x: 0, z: 0, r: 50 },
    cooldown: new Map(), ladderRoutes: ladder ? [{ base: { x: 1, y: 64, z: 0 }, top: { x: 6, y: 68, z: 0 } }] : [],
    detail: r => r?.detail || r || {}, bounded: p => p, blast: async () => false,
    failed: (_b, key, sig = '') => refusals.add(key + '|' + sig),
    blocked: (_b, key, sig = '') => refusals.has(key + '|' + sig), cleared() {}, alive: () => true, generation: 0 }
  sw.go = (_b, at, range, seconds, arena) => b.c.call('goto', { ...at, range, timeoutSeconds: seconds, arena })
  const foe = { id: 'Foe', position: { x: 6, y: 68, z: 0 } }
  return { b, frame, calls, refusals, sw, foe, setTime: value => { time = value },
    run: () => swarmClimb(sw).climbTo(b, foe, foe.position) }
}

async function reportLaunch(f, climb, stand, roof, hops = 1) {
  const scout = { name: 'Scout', team: 'blue', c: { call: async m => ({ detail: m === 'pearl_plan' ? { ok: true } :
    { ok: true, hops, launchAt: stand, at: roof } }) } }
  f.sw.pos.Scout ??= { ...f.frame, p: { ...f.frame.p } }
  await climb.pearlUp(scout, roof)
}

test('сорванный подъём под луком в том же ходе уходит в укрытие, затем в бегство', async () => {
  const f = fixture()
  assert.equal(await f.run(), true)
  assert.deepEqual(f.calls.map(c => c.method), ['goto', 'take_cover', 'flee'])
  assert.equal(f.calls[1].params.localOnly, true)
  assert.ok([...f.refusals].some(key => key.startsWith('climb:A|')))
  assert.equal(f.b.swarmAscent, undefined)
  assert.equal(f.b.climbing, false)
  f.calls.length = 0
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['take_cover', 'flee'], 'тот же отказ не запускает подъём снова')
})

test('после отказа броска соседняя стойка остаётся доступна, пока путь в безопасной зоне', async () => {
  const f = fixture({ inventory: { ender_pearl: 3 }, reply: method => method === 'pearl_up'
    ? { detail: { ok: false, stop: 'нет броска' } } : null })
  f.b.arrowThreat.active = false
  f.frame.p = { x: 15, y: 64, z: 1 }
  f.sw.arena.z = .5
  const h = { x: 40.5, y: 92, z: .5 }
  const bounds = { ...f.sw.arena, avoid: [{ x: 16.5, y: 64, z: .5, r: 1 }] }
  f.sw.lootArena = () => bounds
  f.sw.surfaceY = x => [14, 16, 12].includes(Math.floor(x)) ? 64 : null
  const climb = swarmClimb(f.sw)
  assert.deepEqual(await climb.pearlUp(f.b, h), { moved: true })
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_up', 'goto'])
  const { x, y, z, arena } = f.calls[1].params
  assert.deepEqual({ x, y, z }, { x: 12.5, y: 64, z: .5 })
  assert.deepEqual(arena, bounds)
  f.calls.length = 0
  await climb.pearlUp(f.b, h)
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_up'], 'последняя безопасная стойка уже проверена')
  f.calls.length = 0
  await climb.pearlUp(f.b, h)
  assert.deepEqual(f.calls, [], 'при тех же условиях расчёт не повторяется')
  bounds.avoid.length = 0
  await climb.pearlUp(f.b, h)
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_up', 'goto'], 'после ухода угрозы открылась стойка')
  assert.equal(f.calls[1].params.x, 16.5)
})

test('разведчик передаёт своим ближнюю стойку, с которой сам долетел на крышу', async () => {
  const ledge = { x: 42.5, y: 90, z: .5 }, launch = { x: 39.25, y: 70, z: 12.75 }
  const f = fixture({ inventory: { ender_pearl: 1 } })
  f.b.team = 'blue'; f.b.arrowThreat.active = false
  f.frame.p = { x: 38.5, y: 70, z: 15.5 }
  let bounds = f.sw.arena
  f.sw.lootArena = () => bounds
  Object.assign(f.sw, swarmRetry(f.sw))
  const climb = swarmClimb(f.sw), calls = []
  f.b.c.call = async (m, p) => { calls.push([m, p]); return { detail: { ok: false, why: 'no path' } } }
  const attempt = async () => { calls.length = 0; await climb.pearlUp(f.b, ledge); return calls.map(c => c[0]) }
  assert.deepEqual(await attempt(), ['pearl_plan'])
  assert.deepEqual(await attempt(), [], 'нет новой информации')
  await reportLaunch(f, climb, launch, ledge)
  f.b.team = 'red'
  assert.deepEqual(await attempt(), [], 'другая команда не слышит разведчика')
  f.b.team = 'blue'
  bounds = { ...f.sw.arena, avoid: [{ ...launch, r: 1 }] }
  assert.deepEqual(await attempt(), ['pearl_plan'], 'опасная стойка исключена')
  bounds = f.sw.arena
  assert.deepEqual(await attempt(), ['pearl_plan', 'goto'], 'новый доклад открыл ранее закрытую цель')
  const p = calls[1][1]
  assert.deepEqual([p.x, p.y, p.z, p.exactY, p.range], [launch.x, launch.y, launch.z, true, 0])
  assert.deepEqual(await attempt(), ['pearl_plan'], 'пеший отказ не повторяет тот же маршрут')
  assert.deepEqual(await attempt(), [])
  f.sw.generation++
  Object.assign(f.sw, swarmRetry(f.sw))
  assert.deepEqual(await attempt(), ['pearl_plan'], 'старую стойку в новом раунде никто не сообщал')
})

test('отказ одной крыши не мешает броску на соседнюю с того же места', async () => {
  const f = fixture({ inventory: { ender_pearl: 1 }, reply: (method, p) => ({
    detail: { ok: p.to.x === 12, at: p.to } }) })
  f.b.arrowThreat.active = false
  const climb = swarmClimb(f.sw)
  await climb.pearlUp(f.b, { x: 16, y: 80, z: 0 })
  assert.equal((await climb.pearlUp(f.b, { x: 12, y: 80, z: 0 }))?.arrived, true)
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_plan', 'pearl_plan', 'pearl_up'])
})

test('a scout guides a last-pearl carrier by a fraction of a block and the carrier checks its own arc again', async () => {
  const roof = { x: 16.5, y: 124, z: .5 }
  const f = fixture({ inventory: { ender_pearl: 1 } })
  const releases: string[] = [], calls: string[] = []
  function actor(name: string, startZ: number) {
    const { bot, rpc, arena } = pearlStandGallery(startZ)
    f.sw.arena = arena
    const pearl = { name: 'ender_pearl', type: bot.registry.itemsByName.ender_pearl.id, slot: 36, count: 1 }
    bot.heldItem = pearl; bot.inventory.items = () => pearl.count ? [pearl] : []
    let landing
    bot.activateItem = () => {
      releases.push(name); pearl.count--
      // The fixture supplies the server teleport after the native release.
      bot.entity.position = landing.clone(); bot.entity.velocity = bot.entity.velocity.scaled(0)
    }
    const frame = f.sw.pos[name] = { ...f.frame, p: bot.entity.position.clone() }
    return { name, team: 'blue', c: { call: async (m, p) => {
      calls.push(m)
      const timer = m === 'pearl_up' ? setInterval(() => bot.waitForTicks(1), 4) : undefined
      try {
        const detail = await rpc[m](p)
        if (m === 'pearl_plan' && detail.ok) landing = detail.feet
        frame.p = bot.entity.position.clone()
        return { detail }
      } finally { clearInterval(timer) }
    } } }
  }
  const scout = actor('Scout', -.75), carrier = actor('Carrier', -.99)
  Object.assign(f.sw, swarmRetry(f.sw))
  const climb = swarmClimb(f.sw)
  assert.equal((await climb.pearlUp(scout, roof))?.arrived, true)
  calls.length = 0
  assert.deepEqual(await climb.pearlUp(carrier, roof), { moved: true })
  assert.deepEqual(calls, ['pearl_plan', 'pearl_stand'])
  assert.ok(Math.abs(f.sw.pos.Carrier.p.z + .75) < .08)
  assert.deepEqual(releases, ['Scout'])
  assert.equal((await climb.pearlUp(carrier, roof))?.arrived, true)
  assert.deepEqual(calls, ['pearl_plan', 'pearl_stand', 'pearl_plan', 'pearl_up'])
  assert.deepEqual(releases, ['Scout', 'Carrier'])
})

test('new danger cancels the precise approach and a failed footing leaves another point in the same cell available', async () => {
  const roof = { x: 16.5, y: 124, z: .5 }, first = { x: .5, y: 120, z: -.75 }, other = { ...first, z: -.25 }
  let guarded = true, interrupted = true
  const f = fixture({ inventory: { ender_pearl: 1 }, reply(m) {
    if (m === 'pearl_plan' && guarded) bounds = { ...f.sw.arena, avoid: [{ ...first, r: 2 }] }
    if (m === 'pearl_stand' && interrupted) return { status: 'interrupted' }
  } })
  let bounds = f.sw.arena
  f.b.team = 'blue'; f.b.arrowThreat.active = false; f.frame.p = { ...first, z: -.99 }
  f.sw.lootArena = () => bounds
  Object.assign(f.sw, swarmRetry(f.sw))
  const climb = swarmClimb(f.sw)
  await reportLaunch(f, climb, first, roof)
  await reportLaunch(f, climb, other, roof)
  const step = async () => { f.calls.length = 0; await climb.pearlUp(f.b, roof); return f.calls.find(c => c.method === 'pearl_stand')?.params.at }
  assert.equal(await step(), undefined, 'the latest threat arrived during the preview')
  guarded = false; bounds = f.sw.arena
  assert.deepEqual(await step(), first)
  interrupted = false
  assert.deepEqual(await step(), first, 'external interruption leaves the first footing available')
  assert.deepEqual(await step(), other, 'a genuine movement failure only closes one precise footing')
  assert.equal(await step(), undefined)
  await step()
  assert.deepEqual(f.calls, [], 'unchanged geometry stops both walking and speculative previews')
})

test('a coarse arrival one level below the scout cannot keep the carrier walking to the same block', async () => {
  const stand = { x: 1.5, y: 120.5, z: .5 }, roof = { x: 16.5, y: 124, z: .5 }
  const f = fixture({ inventory: { ender_pearl: 1 }, reply(m) {
    if (m === 'goto') return { detail: { arrived: { x: 1, y: 120, z: 0 } } }
  } })
  f.frame.p = { ...stand, y: 120 }; f.b.team = 'blue'; f.b.arrowThreat.active = false
  Object.assign(f.sw, swarmRetry(f.sw))
  const climb = swarmClimb(f.sw)
  await reportLaunch(f, climb, stand, roof)
  for (let i = 0; i < 3; i++) await climb.pearlUp(f.b, roof)
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_plan', 'goto', 'pearl_plan'])
})

test('a now-safe launch point reopens after the nearby threat seen during the precise movement leaves', async () => {
  const stand = { x: .5, y: 120, z: -.75 }, roof = { x: 16.5, y: 124, z: .5 }
  const f = fixture({ inventory: { ender_pearl: 1 }, reply: m => m === 'pearl_stand' ? { detail: { ok: false, why: 'unsafe_start' } } : null })
  let bounds = { ...f.sw.arena, avoid: [{ ...stand, x: 3, r: .5 }] }
  f.sw.lootArena = () => bounds
  f.frame.p = { ...stand, z: -.99 }; f.b.team = 'blue'; f.b.arrowThreat.active = false
  Object.assign(f.sw, swarmRetry(f.sw))
  const climb = swarmClimb(f.sw)
  await reportLaunch(f, climb, stand, roof)
  for (let i = 0; i < 3; i++) await climb.pearlUp(f.b, roof)
  assert.equal(f.calls.filter(c => c.method === 'pearl_stand').length, 1)
  bounds = f.sw.arena
  f.calls.length = 0
  await climb.pearlUp(f.b, roof)
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_plan', 'pearl_stand'])
})

test('the swarm keeps both proven approaches to a roof when the newest one is guarded or the nearest walk fails', async () => {
  const roof = { x: 42.5, y: 90, z: .5 }
  const west = { x: 11.25, y: 70, z: 12.75 }, east = { x: 36.25, y: 70, z: 12.75 }
  const f = fixture({ inventory: { ender_pearl: 1 } })
  f.b.team = 'blue'; f.b.arrowThreat.active = false
  f.frame.p = { x: 16.5, y: 70, z: 14.5 }
  let bounds = f.sw.arena
  f.sw.lootArena = () => bounds
  Object.assign(f.sw, swarmRetry(f.sw))
  const climb = swarmClimb(f.sw)
  await reportLaunch(f, climb, west, roof)
  await reportLaunch(f, climb, east, roof)
  await reportLaunch(f, climb, { x: 19, y: 70, z: 14 }, roof, 0)
  const approach = async () => {
    f.calls.length = 0
    await climb.pearlUp(f.b, roof)
    return f.calls.find(c => c.method === 'goto')?.params
  }
  bounds = { ...f.sw.arena, avoid: [{ ...east, r: 2 }] }
  assert.equal((await approach())?.x, west.x, 'the earlier confirmed throw remains a safe approach')
  assert.equal((await approach())?.x, undefined, 'the failed walk and the guarded alternative cannot attract a retry')
  bounds = f.sw.arena
  assert.equal((await approach())?.x, east.x, 'once clear, the other approach is still available')
  assert.equal((await approach())?.x, undefined)
  await reportLaunch(f, climb, { ...east, x: east.x + .1, y: east.y + .01 }, roof)
  await approach()
  assert.deepEqual(f.calls, [], 'another throw from the same cell cannot restart an exhausted approach')
  const launch = { x: 23.5, y: 70, z: 14.5 }
  await reportLaunch(f, climb, launch, roof)
  assert.equal((await approach())?.x, launch.x, 'a newly proven footing reopens the approach')
})

test('к известной крыше бот подходит с ближней безопасной стороны и пробует другую стойку после отказа', async () => {
  const f = fixture({ inventory: { ender_pearl: 1 } })
  f.b.arrowThreat.active = false
  f.frame.p = { x: 27.5, y: 64, z: .5 }; f.sw.arena.z = .5
  const roof = { x: 40.5, y: 92, z: .5 }
  f.sw.surfaceY = x => [14, 22, 30].includes(Math.floor(x)) ? 64 : null
  const climb = swarmClimb(f.sw)
  for (let i = 0; i < 3; i++) await climb.pearlUp(f.b, roof)
  assert.deepEqual(f.calls.filter(c => c.method === 'goto').map(c => c.params.x), [30.5, 22.5, 14.5])
})

test('поздний ответ о дуге после смены раунда не бросает жемчуг, не запускает подход и не закрывает стойку', async () => {
  for (const pending of ['pearl_plan', 'pearl_up', 'goto']) {
    const f = fixture({ inventory: { ender_pearl: 1 }, reply: method => {
      if (method === pending) { f.sw.generation++; f.b.climbing = true }
      return { detail: method === 'pearl_plan' ? { ok: pending !== 'goto' } : { ok: false, stop: 'нет броска' } }
    } })
    f.b.arrowThreat.active = false
    f.sw.surfaceY = () => 64
    await swarmClimb(f.sw).pearlUp(f.b, { x: 40, y: 90, z: 0 })
    assert.equal(f.calls.at(-1).method, pending)
    assert.equal(f.b.climbing, true, 'новый ход сохраняет управление')
    assert.ok(![...f.refusals].some(k => k.startsWith('pearlUp:') || k.startsWith('pearlSpot:A:14,')))
  }
})

test('жемчуг к замеченному противнику на ярусе проверяет наблюдаемую посадку и границу арены', async () => {
  const f = fixture({ inventory: { ender_pearl: 2, stone: 64 }, reply: method => method === 'pearl_to'
    ? { status: 'done', detail: { ok: false, why: 'no_observed_pearl_trajectory' } } : null })
  f.b.arrowThreat.active = false
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['pearl_to', 'goto'])
  assert.deepEqual(f.calls[0].params, { to: f.foe.position, observed: true, arena: f.sw.arena, _climb: true })
})

test('дошёл без набора высоты: свежий ответ RPC тоже ведёт в укрытие', async () => {
  const f = fixture({ reply: method => method === 'goto' ? {
    status: 'done', detail: { arrived: { x: 5, y: 64, z: 0 } }, state: { pos: { x: 5, y: 64, z: 0 } }
  } : null })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['goto', 'take_cover', 'flee'])
})

test('ветер под обстрелом поднимает через готовый физический wind_leap раньше стройки', async () => {
  const f = fixture({ inventory: { stone: 64, wind_charge: 4 }, reply: method => method === 'wind_leap' ? {
    status: 'done', detail: { ok: true }, state: { pos: { x: 6, y: 68, z: 0 } }
  } : null })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['wind_leap'])
  assert.deepEqual(f.calls[0].params.toward, f.foe.position)
  assert.equal(f.calls[0].params._climb, true)
  assert.equal(f.calls[0].climbing, true)
  assert.ok(f.calls[0].ascent)
})

test('сторож остановил зависший ветер: тот же ход выходит из обстрела без новой стройки', async () => {
  const f = fixture({ inventory: { stone: 64, wind_charge: 4 }, reply: (method, _p, b) => {
    if (method !== 'wind_leap') return null
    b.swarmAscent.stalled = true
    return { status: 'interrupted', by: { type: 'cancelled', by: 'stop' } }
  } })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['wind_leap', 'take_cover', 'flee'])
})

test('отказ готовой лестницы под луком уводит, а не заканчивает ход на месте', async () => {
  const f = fixture({ ladder: true })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['ladder_up', 'take_cover', 'flee'])
})

test('a ready combat route approaches its base then climbs natively with no ladder inventory', async () => {
  const f = fixture({ inventory: {}, reply: (method, params, _b, frame) => {
    if (method === 'goto') {
      if (params.y !== 64) return { status: 'failed', error: 'stuck at the upper air neighbor' }
      frame.p = { x: params.x, y: params.y, z: params.z }
      return { status: 'done', detail: { arrived: frame.p } }
    }
    if (method === 'ladder_up') {
      assert.deepEqual(frame.inv, {})
      assert.deepEqual(params.wall, { x: 6, y: 64, z: 0 }); assert.deepEqual(params.face, { x: -1, z: 0 })
      frame.p = { x: 6.5, y: 68, z: .5 }
      return { status: 'done', detail: { ok: true, complete: true, placed: 0, at: frame.p } }
    }
    return null
  } })
  f.sw.ladderRoutes.push({ key: 'ready', base: { x: 5.5, y: 64, z: .5 }, top: { x: 6.5, y: 68, z: .5 } })
  f.foe.position = { x: 6.5, y: 68, z: .5 }
  f.sw.go = (_b, at, range, seconds, arena) => f.b.c.call('goto', { ...at, range, timeoutSeconds: seconds, arena })
  assert.equal(await f.run(), true)
  assert.deepEqual(f.calls.map(c => c.method), ['goto', 'ladder_up'])
  assert.ok(f.calls.every(c => c.climbing && c.ascent))
  assert.equal(f.refusals.size, 0)
})

test('an interrupted or stale ladder approach cannot start its native climb', async () => {
  for (const stale of [false, true]) {
    const f = fixture({ inventory: {}, reply: method => {
      if (method !== 'goto') return null
      if (stale) { f.sw.generation++; return { status: 'done', detail: { arrived: { x: 5.5, y: 64, z: .5 } } } }
      return { status: 'interrupted', by: { type: 'tactical', requireObservation: true } }
    } })
    f.sw.ladderRoutes.push({ key: 'ready', base: { x: 5.5, y: 64, z: .5 }, top: { x: 6.5, y: 68, z: .5 } })
    await f.run()
    assert.deepEqual(f.calls.map(c => c.method), ['goto'])
    assert.equal(f.b.swarmAscent, undefined)
  }
})

test('tactical interruption не отбирает тело у аварийного владельца новым побегом', async () => {
  const f = fixture({ reply: method => method === 'goto' ? {
    status: 'interrupted', by: { type: 'tactical', requireObservation: true }
  } : null })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['goto'])
  assert.equal(f.b.swarmFightReply?.status, 'interrupted')
})

test('без блоков и кирки под луком уходит, а не добывает песок на виду', async () => {
  const f = fixture({ inventory: {} })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['take_cover', 'flee'])
})

test('достигнутая высота из state.pos не теряется за отставшим poll', async () => {
  const f = fixture({ reply: method => method === 'goto' ? {
    status: 'done', detail: { arrived: { x: 6, y: 64, z: 0 } }, state: { pos: { x: 6, y: 68, z: 0 } }
  } : null })
  await f.run()
  assert.deepEqual(f.calls.map(c => c.method), ['goto'])
  assert.equal(f.refusals.size, 0)
})

test('укрытие с квитанцией не заменяется новым бегством; без обстрела старый подъём и копка остаются', async () => {
  const covered = fixture({ reply: method => method === 'take_cover' ? { status: 'done', detail: { ok: true } } : null })
  await covered.run()
  assert.deepEqual(covered.calls.map(c => c.method), ['goto', 'take_cover'])
  const quiet = fixture({ inventory: { wind_charge: 4, stone: 64 } })
  quiet.b.arrowThreat.active = false
  await quiet.run()
  assert.deepEqual(quiet.calls.map(c => c.method), ['goto'])
  const miner = fixture({ inventory: {}, reply: method => method === 'mine' ? { detail: { dug: 1 } } : null })
  miner.b.arrowThreat.active = false
  assert.equal(await miner.run(), true)
  assert.deepEqual(miner.calls.map(c => c.method), ['mine'])
})

test('подъём с прогрессом не рвётся от попадания, а стояние снимает защиту', async () => {
  const f = fixture()
  let finish: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const climbing = runAscent(f.b, f.frame, f.foe.position, () => gate, f.sw.now)
  const live = (at, frame, p = f.frame.p) => ({ ...f.frame, p, frame, observedAt: at, frameAt: at })
  try {
    assert.equal(ascentActive(f.b, live(1100, 22), 1100), true)
    assert.equal(ascentActive(f.b, { ...live(2100, 42, { x: 0, y: 65, z: 0 }), hp: 17 }, 2100), true,
      'попадание само по себе не рвёт подъём с продвижением')
    assert.equal(ascentActive(f.b, live(3300, 66, { x: 0, y: 65, z: 0 }), 3300), true)
    assert.equal(ascentActive(f.b, live(3700, 74, { x: 0, y: 65, z: 0 }), 3700), false,
      'после 1.5 с без продвижения обычный прицел получает право выбрать выход')
    assert.equal(f.b.swarmAscent.stalled, true)
  } finally { finish(); await climbing }
})

test('запоздалый status и замёрзшие тики не доказывают stalled; расход блока считается работой', async () => {
  const f = fixture()
  let finish: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const climbing = runAscent(f.b, f.frame, f.foe.position, () => gate, f.sw.now)
  try {
    assert.equal(ascentActive(f.b, { ...f.frame, observedAt: 8000 }, 8000), false)
    assert.equal(f.b.swarmAscent.stalled, false, 'старые физические данные не разрешают stop сторожа')
    assert.equal(ascentActive(f.b, { ...f.frame, observedAt: 3000, frameAt: 3000 }, 3000), true,
      'тот же физический кадр не доказывает стояние')
    const placed = { ...f.frame, inv: { stone: 63 }, observedAt: 2000, frameAt: 2000, frame: 40 }
    assert.equal(ascentActive(f.b, placed, 2000), true)
    assert.equal(ascentActive(f.b, { ...placed, observedAt: 3300, frameAt: 3300, frame: 66 }, 3300), true)
  } finally { finish(); await climbing }
})

test('поздний finally старого RPC не снимает владельца нового подъёма', async () => {
  const f = fixture()
  let firstDone: () => void, secondDone: () => void
  const first = runAscent(f.b, f.frame, f.foe.position, () => new Promise<void>(r => { firstDone = r }), f.sw.now)
  const second = runAscent(f.b, f.frame, { x: 7, y: 69, z: 0 }, () => new Promise<void>(r => { secondDone = r }), f.sw.now)
  const token = f.b.swarmAscent
  firstDone(); await first
  assert.equal(f.b.swarmAscent, token)
  assert.equal(f.b.climbing, true)
  secondDone(); await second
  assert.equal(f.b.swarmAscent, undefined)
  assert.equal(f.b.climbing, false)
})

test('поставленная лестница — прогресс; после долгого поиска движение возвращает защиту до stop', async () => {
  const f = fixture({ inventory: { ladder: 4 } })
  let finish: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const climbing = runAscent(f.b, f.frame, f.foe.position, () => gate, f.sw.now)
  try {
    const placed = { ...f.frame, inv: { ladder: 3 }, observedAt: 2600, frameAt: 2600, frame: 52 }
    assert.equal(ascentActive(f.b, placed, 2600), true, 'лестницу поставил, хотя ещё не поднялся по ней')
    const stopped = { ...placed, observedAt: 4300, frameAt: 4300, frame: 86 }
    assert.equal(ascentActive(f.b, stopped, 4300), false)
    const moved = { ...stopped, p: { x: 0, y: 65, z: 0 }, observedAt: 4400, frameAt: 4400, frame: 88 }
    assert.equal(ascentActive(f.b, moved, 4400), true, 'поиск без обстрела закончился и тело пошло')
    f.b.swarmAscent.stopping = true
    assert.equal(ascentActive(f.b, { ...moved, p: { x: 0, y: 66, z: 0 } }, 4500), false,
      'посланный stop не оживляет уже отвергнутый эпизод')
  } finally { finish(); await climbing }
})

test('повтор уже проверенного кадра после остановки физики не становится новым доказательством стояния', async () => {
  const f = fixture()
  let finish: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const climbing = runAscent(f.b, f.frame, f.foe.position, () => gate, f.sw.now)
  try {
    const oneTick = { ...f.frame, frame: 21, observedAt: 1100, frameAt: 1100 }
    assert.equal(ascentActive(f.b, oneTick, 1100), true)
    assert.equal(ascentActive(f.b, { ...oneTick, observedAt: 3100 }, 3100), true,
      'после первого тика физика замерла: тот же кадр не разрешает stop')
    assert.equal(f.b.swarmAscent.stalled, false)
    assert.equal(ascentActive(f.b, { ...oneTick, frame: 22, observedAt: 3200, frameAt: 3200 }, 3200), false,
      'новый кадр после бюджета подтверждает стояние')
  } finally { finish(); await climbing }
})
