import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

function fixture(p: any = {}) {
  const bot: any = new EventEmitter(), calls: any[] = [], flights: any[] = []
  bot.health = p.hp ?? 20
  bot.entity = { position: new Vec3(70, p.y ?? 125, 0), velocity: new Vec3(0, p.vy ?? -1, 0),
    onGround: false, elytraFlying: !!p.flying, yaw: 0, pitch: 0 }
  bot.inventory = { slots: [], items: () => [] }
  bot.waitForTicks = async () => {}
  const pad = new Vec3(69, 120, 0)
  const W = { solid: () => { throw new Error('rescue must not scan ridge') },
    floorBelow: () => p.noFloor ? null : { top: p.floor ?? 120, water: !!p.water },
    landingSafe: () => !p.water }
  bot.blockAt = pos => {
    const at = pos.floored(), floor = !p.noFloor && at.y === (p.floor ?? 120) - 1
    return { position: at, name: floor ? p.water ? 'water' : 'stone' : 'air', boundingBox: floor && !p.water ? 'block' : 'empty',
      shapes: floor && !p.water ? [[0, 0, 0, 1, 1, 1]] : [] }
  }
  const S = { fd: p.fd ?? 0, lastY: bot.entity.position.y }
  let probes = 0
  const sky: any = {
    flightControl: (_b, ctl) => ctl, install: () => S, worldOf: () => W, kit: () => ({ elytra: true, rockets: p.rockets ?? 1 }),
    gliding: b => b.elytraFlying, wearingElytra: () => true, plainRocket: () => false,
    startGlide: () => { calls.push('glide'); bot.entity.elytraFlying = true; return true },
    toHotbar: async () => { calls.push('hotbar') },
    rollout: () => ({ kind: p.kind ?? null, fd: p.predFd ?? 0, p: { y: p.endY ?? 124 } }),
    headroom: () => p.headroom ?? 5, landingSpot: () => (++probes > (p.missingProbes ?? 0) ? pad : null),
    escape: async (_b, ctl, e, o) => {
      calls.push({ escape: e.username, arena: o.arena })
      if (p.escapeDeath) bot.health = 0
      if (p.escapeAbort) ctl.aborted = true
      return { ok: true, note: 'уход', hp1: bot.health }
    },
    fly: async (_b, ctl, o) => {
      flights.push(o)
      for (let n = 0; n < 20; n++) o.goal()
      assert.equal(ctl.aborted, false)
      bot.entity.position = pad.offset(0, 2, 0); bot.entity.velocity.y = -.1
      if (p.touch) {
        const ground = { x: pad.x, y: p.touchY ?? pad.y, z: pad.z }
        bot.entity.position = new Vec3(ground.x, ground.y, ground.z)
        if (p.abortAfterTouch) ctl.aborted = true
        return { why: 'сел', ground }
      }
      return { why: o.until() }
    },
    land: async (_b, _ctl, o) => {
      calls.push('land'); assert.equal(o.at.x, 69)
      bot.entity.position = pad; bot.entity.onGround = true; bot.entity.elytraFlying = false
      return { ok: true }
    },
    chestDown: async () => {
      calls.push('chest')
      if (p.groundFlicker) bot.entity.onGround = false
      if (p.chestDeath) bot.health = 0
      if (p.chestOutside) bot.entity.position.x = 90
      if (p.chestSlip) bot.entity.position.y -= 2
      return { ok: true }
    }
  }
  bot.players = { HuHguZ: { entity: { username: 'HuHguZ', position: new Vec3(69, 120, 0) } } }
  const session: any = { bot, _ndFoes: p.foes || [], require: () => bot, runIntent: async (name, work, options) => {
    calls.push({ name, params: options.params })
    return p.run ? { status: 'done', detail: await work({ aborted: false }) } : { status: 'done' }
  } }
  const file = path.join(__dirname, '../src/rpc/aerial.js'), native = createRequire(file)
  const mod = { exports: {} as any }
  vm.runInNewContext(readFileSync(file, 'utf8'), { module: mod, exports: mod.exports,
    require: name => name === '../elytra' ? sky : name === '../pvp/last-seen' ? { createLastSeen: () => ({
      observe: e => e && p.visible ? { ...e, position: e.position.clone(), _ndVisible: true } : null,
      visible: e => !!e?._ndVisible, close: () => calls.push('sight-close')
    }) } : native(name), console: { log () {} } })
  return { bot, calls, flights, methods: mod.exports.aerialMethods({ session }), probes: () => probes }
}

test('rescue: accumulated fall, lethal equality, glider impact and slow descent into kill zone', async () => {
  for (const [p, expected] of [
    [{ fd: 24 }, 1], [{ y: 143 }, 1], [{ y: 125 }, 0], [{ fd: 24, water: true }, 0],
    [{ flying: true, kind: 'floor', predFd: 30 }, 1], [{ flying: true }, 0],
    [{ flying: true, y: 114.5, vy: -.08, endY: 113.85 }, 1],
    [{ flying: true, y: 140, vy: -.08, endY: 139.4 }, 0], [{ fd: 24, rockets: 0 }, 1]
  ] as Array<[any, number]>) {
    const f = fixture(p)
    await f.methods.rescue_config({ safe: { x: 0, y: 120, z: 0 }, killY: 113, arena: { x: 0, z: 0, r: 80 } })
    f.bot.emit('physicsTick')
    assert.equal(f.calls.filter(c => c.name === 'fly_to').length, expected, JSON.stringify(p))
  }
})

test('rescue: hp5, local pad, no ridge scan; glide works with one or zero rockets', async () => {
  for (const rockets of [0, 1]) {
    const f = fixture({ hp: 5, run: true, rockets })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true,
      arena: { x: 0, z: 0, r: 80 } })
    assert.equal(r.detail.ok, true)
    assert.equal(r.detail.hp, 0)
    assert.equal(f.flights[0].goal().at.x, 69)
    assert.equal(f.flights[0].noRocket(), false)
    assert.equal(f.calls.includes('glide'), true)
    assert.equal(f.calls.includes('land'), true)
    assert.equal(f.calls.includes('chest'), true)
  }
})

test('rescue: missing pad keeps a controlled goal and retries the local search', async () => {
  const f = fixture({ hp: 5, run: true, missingProbes: 1 })
  const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true })
  assert.equal(r.detail.ok, true)
  assert.equal(f.probes(), 2)
})

test('rescue: actual touchdown survives an onGround flicker; unsafe contacts stay failures', async () => {
  for (const [p, ok] of [
    [{ touch: true }, true], [{ groundFlicker: true }, true],
    [{ touch: true, touchY: 113 }, false], [{ touch: true, water: true }, false],
    [{ chestDeath: true }, false], [{ chestOutside: true }, false], [{ chestSlip: true }, false]
  ] as Array<[any, boolean]>) {
    const f = fixture({ run: true, ...p })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true,
      arena: { x: 0, z: 0, r: 80 } })
    assert.equal(r.detail.ok, ok, JSON.stringify(p))
  }
})

test('rescue: unsafe contact, death and supersession keep distinct reasons and failed guards', async () => {
  for (const [p, why, guard] of [
    [{ touch: true, touchY: 72, floor: 72 }, 'unsafe_contact', 'minY'],
    [{ touch: true, water: true }, 'unsafe_contact', 'dry'],
    [{ touch: true, abortAfterTouch: true }, 'flight_superseded', 'active'],
    [{ chestDeath: true }, 'death', 'alive'],
    [{ chestSlip: true }, 'не сел безопасно', 'support']
  ] as Array<[any, string, string]>) {
    const f = fixture({ run: true, ...p })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true,
      arena: { x: 0, z: 0, r: 80 } })
    assert.equal(r.detail.ok, false, JSON.stringify(p))
    assert.equal(r.detail.why, why, JSON.stringify(p))
    const d = r.detail.contact
    const guards: Record<string, unknown> = { minY: d.before.minY, dry: d.before.dry,
      active: d.active, alive: d.alive, support: d.current.support }
    assert.equal(guards[guard], false, JSON.stringify(p))
    if (guard === 'minY') assert.equal(d.before.minFloorY, 114)
    if (guard === 'support') assert.equal(d.touchdown, true)
  }
})

test('rescue: lethal pit and void escape the visible foe; hidden players and blocked ascent keep glide rescue', async () => {
  for (const [p, escaping] of [[{}, true], [{ noFloor: true }, true], [{ escapeDeath: true }, true], [{ escapeAbort: true }, true],
    [{ visible: false }, false], [{ foes: [] }, false], [{ rockets: 0 }, false], [{ headroom: 3 }, false]] as Array<[any, boolean]>) {
    const f = fixture({ run: true, hp: 1.2, rockets: 47, foes: ['HuHguZ'], visible: true, ...p })
    const r = await f.methods.fly_to({ at: { x: 0, y: 120, z: 0 }, killY: 113, rescue: true,
      arena: { x: 0, z: 0, r: 80 } })
    const escape = f.calls.find(c => c.escape)
    assert.equal(!!escape, escaping, JSON.stringify(p))
    if (escape) {
      assert.equal(r.detail.ok, !p.escapeDeath && !p.escapeAbort)
      assert.equal(r.detail.why, p.escapeDeath ? 'death' : p.escapeAbort ? 'flight_superseded' : null)
      assert.equal(escape.escape, 'HuHguZ')
      assert.equal(escape.arena.y, 120)
      assert.equal(f.calls.includes('land'), false, 'не садиться в ближайшую яму')
      assert.equal(f.calls.includes('sight-close'), true)
    }
  }
})
