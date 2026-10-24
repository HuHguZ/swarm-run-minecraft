import test from 'node:test'
import assert from 'node:assert/strict'
import { pvpParts } from './pvp-parts'
import { Vec3 } from 'vec3'
import * as ct from '../src/pvp/crowd-threat'

test('проверка отсутствующего выхода не тормозит каждый тик боя; урон и новая клетка требуют нового расчёта', async () => {
  let quotes = 0
  const ctx: any = { arenaStay: true, safeMedical: false, safety: { action: 'leave' }, hp: 8,
    now: 1000, AR: {}, bot: { entity: { position: new Vec3(.5, 70, .5) } },
    tt: { threats: () => [{ id: 2, position: new Vec3(2, 70, 0) }] }, strategicRequest: () => null,
    flee: { hostilesAround: () => [], pickDirection: () => { quotes++; return null } } }
  const { safetyTurn } = pvpParts(ctx, ['turn-escape'], ['safetyTurn'])
  await safetyTurn(ctx, ctx)
  ctx.now++
  await safetyTurn(ctx, ctx)
  assert.equal(quotes, 1)
  ctx.now = 1300
  await safetyTurn(ctx, ctx)
  assert.equal(quotes, 2)
  ctx.hp = 7
  await safetyTurn(ctx, ctx)
  assert.equal(quotes, 3)
  ctx.bot.entity.position.x++
  await safetyTurn(ctx, ctx)
  assert.equal(quotes, 4)
})

for (const drop of [false, true]) test(`один противник: небезопасный размен разрешает выгодный спуск (drop=${drop})`, async () => {
  const arena = { x: 0, y: 64, z: 0, r: 24, killY: 40 }, hs = [{ e: { id: 2 } }], calls: any[] = []
  const ctx: any = { arenaStay: true, flightRecovery: false, safeMedical: false, safety: { action: 'leave' },
    lastStand: true, prof: { player: true }, now: 1000, deadline: 4000, AR: arena, session: {}, ctl: { aborted: false },
    bot: { entity: { position: new Vec3(0, 70, 0) } }, tt: { threats: () => [{ id: 2 }] },
    pathTo() {}, clear() {}, holdWeapon: async () => {}, strategicRequest: () => null,
    flee: { hostilesAround: (_bot, _range, ids) => { assert.deepEqual(Array.from(ids), [2]); return hs },
      pickDirection: (...args) => { assert.equal(args[1], hs); assert.equal(args[4], arena); assert.equal(args[6], true); return drop ? { drop: {} } : null },
      smartFlee: async (_session, _ctl, options) => { calls.push(options); return { mode: 'спрыгнул' } } } }
  const { safetyTurn } = pvpParts(ctx, ['turn-escape'], ['safetyTurn'])
  assert.equal(await safetyTurn(ctx, ctx), drop ? 'next' : undefined)
  assert.equal(calls.length, drop ? 1 : 0)
  if (drop) { assert.equal(calls[0].arena, arena); assert.deepEqual(Array.from(calls[0].foes), [2]) }
})

for (const cornered of [false, true]) test(`отход из клещей проверяет общий выход до боя на месте (cornered=${cornered})`, async () => {
  const arena = { x: 0, y: 64, z: 0, r: 24, killY: 40 }, home = { x: -8, y: 64, z: 0 }
  const position = new Vec3(.5, 70, .5), foes = [2, 3, 4].map(id => ({ id, name: 'Foe' + id,
    p: new Vec3(id, 70, 0), ehp: 20, theirR: 2, held: 'netherite_sword' }))
  const calls: any[] = []
  const cr: any = { on: true, offAt: 0, frameAt: 1000, mem: ct.newMem(), skipUntil: new Map(), noteAt: new Map(),
    st: { ticks: 0, foesMax: 0, kinds: {}, switches: 0, flips: 0, breaks: 0, trapped: 0 },
    frame: { foes, me: { p: position, hp: 4, charge: 0, weapon: null, armor: [] } } }
  const ctx: any = { prof: { player: true }, crowd: cr, bot: { _ndCrowd: {}, entity: { position } },
    session: {}, ctl: { aborted: false }, AR: arena, opts: { relocateTo: home }, deadline: 4000,
    mf: { clock: { charge: () => 0 } }, now: 1000, me: position, entity: { id: 2 },
    used() {}, pathTo() {}, clear() {}, set() {}, holdWeapon: async () => {}, pathing: false, fortPossible: () => false,
    flee: { pickDirection: () => null, smartFlee: async (session, ctl, options) => { calls.push({ session, ctl, options }); return { cornered, mode: 'бегу', ran: 3 } } },
    gameClock: { now: () => 1000 }, ct, throwMod: { kindOf: () => ({}) }, process }
  const { crowdTurn } = pvpParts(ctx, ['turn-crowd'], ['crowdTurn'])
  assert.equal(await crowdTurn(ctx, ctx), cornered ? undefined : 'next')
  assert.equal(calls.length, 1, 'локальный тупик ещё не означает, что выхода вниз нет')
  assert.equal(calls[0].session, ctx.session)
  assert.equal(calls[0].ctl, ctx.ctl)
  assert.deepEqual(Array.from(calls[0].options.foes), [2, 3, 4])
  assert.equal(calls[0].options.arena, arena)
  assert.deepEqual(Array.from(calls[0].options.goals), [home])
  assert.equal(cr.st.trapped, cornered ? 1 : 0)
  assert.equal(ctx.aim, cornered ? 'target' : 'free')
})
