import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { hint } from '../src/pvp/team-assist'
import { lanceWebItem, lanceWebRequest, lanceWebTurn } from '../src/pvp/turn-approach'
import { flightTurn } from '../src/pvp/turn-air'
import { stateSummary } from '../src/perception'
import * as bow from '../src/bow/track'

function fixture() {
  const calls: string[] = []
  const bot: any = { username: 'Helper', health: 20, food: 20, players: {}, registry: { foodsByName: {} },
    game: { dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0), onGround: true, elytraFlying: false },
    inventory: { items: () => [{ name: 'cobweb', count: 2 }], slots: [] },
    blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty',
      position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }) }
  const ctx: any = { bot, entity: { username: 'Foe', position: new Vec3(3, 64, 0), onGround: true },
    ctl: { aborted: false }, prof: { player: true }, vision: { visible: () => true },
    pathing: true, pathTo: () => calls.push('stop-path'), clear: () => calls.push('clear'),
    placeUnder: async () => { calls.push('place'); return true }, holdWeapon: async () => calls.push('weapon') }
  hint({ require: () => bot }, { lanceWeb: { target: 'Foe' } })
  return { bot, ctx, calls, turn: { r: 3, d: 3, dy: 0, hp: 20, theirR: 3, meInWeb: false } as any }
}

test('web hints preserve pincer; clearing either mailbox preserves the other', () => {
  const { bot } = fixture(), session = { require: () => bot }
  hint(session, { target: 'Foe', from: { x: 10, y: 64, z: 0 } })
  const pin = bot._ndPincer
  hint(session, { lanceWeb: { target: 'Foe' } })
  assert.equal(bot._ndPincer, pin)
  assert.ok(bot._ndLanceWeb.until > clock.now())
  hint(session, {})
  assert.equal(bot._ndPincer, null)
  assert.equal(bot._ndLanceWeb.target, 'Foe')
  hint(session, { target: 'Foe', from: { x: 10, y: 64, z: 0 } })
  const pin2 = bot._ndPincer
  hint(session, { lanceWeb: null })
  assert.equal(bot._ndPincer, pin2)
  assert.equal(bot._ndLanceWeb, null)
})

test('support uses existing placement and restores weapon; failed placement falls through', async () => {
  const a = fixture()
  assert.equal(await lanceWebTurn(a.ctx, a.turn), 'next')
  assert.deepEqual(a.calls, ['stop-path', 'clear', 'place', 'weapon'])
  assert.equal(a.bot._ndLanceWeb, undefined)
  const b = fixture()
  b.ctx.placeUnder = async () => { b.calls.push('refused-face'); return false }
  assert.equal(await lanceWebTurn(b.ctx, b.turn), undefined)
  assert.equal(b.calls.at(-1), 'weapon')
})

test('stale, hidden, unsupported-airborne, wrong-target and distant requests cannot place', async () => {
  const variants = [
    a => { a.bot._ndLanceWeb.until = clock.now() - 1 },
    a => { a.bot._ndLanceWeb.target = 'Other' },
    a => { a.ctx.vision.visible = () => false },
    a => { a.ctx.entity.onGround = false; a.ctx.entity.position.y = 66 },
    a => { a.bot.entity.elytraFlying = true },
    a => { a.ctx.entity.position.x = 13 },
    a => { a.bot.inventory.items = () => [] }
  ]
  for (const mutate of variants) {
    const a = fixture(); mutate(a)
    assert.equal(await lanceWebTurn(a.ctx, a.turn), undefined)
    assert.deepEqual(a.calls, [])
  }
})

test('support defers own lance but keeps escape flight priority', async () => {
  const a = fixture()
  Object.assign(a.ctx, { maceNow: () => false, healAt: 8, tt: { safe: () => ({ ok: true }) },
    foeGrounded: () => true, gate: () => true, foe: {}, nextReady: 0, windInputs: () => '',
    sky: { decide: () => ({ kind: 'lance' }), run: async () => { a.calls.push('flight'); return {} } } })
  assert.equal(await flightTurn(a.ctx, a.turn), undefined)
  assert.deepEqual(a.calls, [])
  a.ctx.sky.decide = () => ({ kind: 'escape' })
  assert.equal(await flightTurn(a.ctx, a.turn), 'next')
  assert.ok(a.calls.includes('flight'))
})

test('own status publishes only an active run-up or approach', () => {
  const { bot } = fixture()
  bot.entity.elytraFlying = true
  bot._ndElytra = { lance: { target: 'Foe' }, phase: 'таран: разбег' }
  assert.deepEqual(stateSummary(bot).lance, { target: 'Foe', phase: 'таран: разбег' })
  bot._ndElytra.phase = 'таран: заход'
  assert.equal(stateSummary(bot).lance.phase, 'таран: заход')
  bot._ndElytra.phase = 'таран: выход'
  assert.equal(stateSummary(bot).lance, undefined)
  delete bot._ndElytra.lance
  bot._ndElytra.phase = 'таран: разбег'
  assert.equal(stateSummary(bot).lance, undefined)
})

test('coordination is wider than legal placement; low airborne targets need visible support', () => {
  const far = fixture()
  far.ctx.entity.position.x = 6; far.turn.r = 6
  assert.ok(lanceWebRequest(far.ctx, far.turn), 'помощник сохраняет подход')
  assert.equal(lanceWebItem(far.ctx, far.turn), null, 'шесть блоков не дают клик')
  const edge = fixture()
  edge.ctx.entity.position.x = 4.4; edge.turn.r = 4.4
  assert.ok(lanceWebItem(edge.ctx, edge.turn), 'грань ещё внутри 4.5 от глаз')
  const low = fixture()
  low.ctx.entity.onGround = false; low.ctx.entity.position.y = 64.4
  assert.ok(lanceWebItem(low.ctx, low.turn), 'низкая воздушная цель над опорой')
  const high = fixture()
  high.ctx.entity.onGround = false; high.ctx.entity.position.y = 66
  assert.equal(lanceWebRequest(high.ctx, high.turn), null, 'под текущей клеткой нет опоры')
  const falling = fixture()
  falling.bot.entity.onGround = false
  assert.ok(lanceWebItem(falling.ctx, falling.turn), 'обычное падение допускает законный клик')
  falling.bot.entity.elytraFlying = true
  assert.equal(lanceWebRequest(falling.ctx, falling.turn), null, 'полёт сохраняет свой руль')
  falling.bot.entity.elytraFlying = false; falling.bot._ndElytra = { driving: 1 }
  assert.equal(lanceWebRequest(falling.ctx, falling.turn), null, 'активный рулевой не отдаёт прицел')
  const hidden = fixture(), blockAt = hidden.bot.blockAt
  hidden.bot.blockAt = p => p.x === 1 && p.y >= 64
    ? { name: 'stone', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] }
    : blockAt(p)
  assert.equal(lanceWebRequest(hidden.ctx, hidden.turn), null, 'скрытая опора не разрешает связку')
})

test('support reserves a six-block approach before own takeoff, keeping escape priority', async () => {
  const a = fixture()
  a.ctx.entity.position.x = 6; a.turn.r = 6; a.turn.d = 6
  Object.assign(a.ctx, { maceNow: () => false, healAt: 8, tt: { safe: () => ({ ok: true }) },
    foeGrounded: () => true, gate: () => true, foe: {}, nextReady: 0, windInputs: () => '',
    sky: { decide: () => ({ kind: 'lance' }), run: async () => { a.calls.push('flight'); return {} } } })
  assert.equal(await flightTurn(a.ctx, a.turn), undefined)
  assert.deepEqual(a.calls, [])
  assert.equal(await lanceWebTurn(a.ctx, a.turn), undefined)
  assert.deepEqual(a.calls, [], 'ожидание подхода не пытается поставить издали')
  assert.ok(a.bot._ndLanceWeb, 'неиспользованный запрос сохраняется')
  a.ctx.sky.decide = () => ({ kind: 'escape' })
  assert.equal(await flightTurn(a.ctx, a.turn), 'next')
  assert.ok(a.calls.includes('flight'))
})

test('lance web trace records receipt and deduplicates repeated decision rejections', t => {
  const previous = process.env.ND_LANCE_WEB_TRACE
  process.env.ND_LANCE_WEB_TRACE = '1'
  t.after(() => { if (previous === undefined) delete process.env.ND_LANCE_WEB_TRACE; else process.env.ND_LANCE_WEB_TRACE = previous })
  const records: any[] = []
  t.mock.method(console, 'log', (...args: any[]) => {
    if (args[0] === '[lance-web]') records.push(JSON.parse(args[1]))
  })
  const a = fixture()
  a.ctx.vision.visible = () => false
  lanceWebRequest(a.ctx, a.turn); lanceWebRequest(a.ctx, a.turn)
  hint({ require: () => a.bot }, { lanceWeb: { target: 'Foe' } })
  lanceWebRequest(a.ctx, a.turn)
  assert.equal(records.filter(r => r.stage === 'receive' && r.target === 'Foe').length, 1)
  assert.equal(records.filter(r => r.stage === 'decision' && r.reason === 'hidden_target').length, 1)
})

test('observed slow ground movement and age enter the lead exactly once', () => {
  let now = 1000
  const entity = { position: new Vec3(0, 64, 0), onGround: true, height: 1.8 }
  const tracker = bow.trackTarget(entity, () => now)
  tracker.update(); now += 100
  entity.position.x = .08; entity.position.z = -.04
  tracker.update(); now += 100
  const v = tracker.vel(), p = bow.leadTarget(entity, tracker.vel, null, 0)(8)
  assert.ok(Math.abs(v.x - .04) < 1e-10 && Math.abs(v.z + .02) < 1e-10)
  assert.equal(v.ageTicks, 2)
  assert.ok(Math.abs(p.x - .48) < 1e-10 && Math.abs(p.z + .24) < 1e-10)
  assert.equal(p.y, 64)
})
