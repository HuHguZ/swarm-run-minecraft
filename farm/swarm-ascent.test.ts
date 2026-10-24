// Под стрелами не стоим после сорванного подъёма и используем готовый расчёт ветра.
import test from 'node:test'
import assert from 'node:assert/strict'
import { swarmClimb } from './swarm/swarm-driver/climb'
import { ascentActive, runAscent } from './swarm/swarm-driver/ascent'

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
  const foe = { id: 'Foe', position: { x: 6, y: 68, z: 0 } }
  return { b, frame, calls, refusals, sw, foe, setTime: value => { time = value },
    run: () => swarmClimb(sw).climbTo(b, foe, foe.position) }
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
  assert.deepEqual(f.calls.map(c => c.method), ['goto', 'take_cover', 'flee'])
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
