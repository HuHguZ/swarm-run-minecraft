import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'
import { choose } from '../src/elytra/control'
import { glideStep } from '../src/elytra/physics'
import { wrap, yawTo, RESCUE_ROCKETS } from '../src/elytra/consts'
import { toHotbar } from '../src/elytra/kit'
import { divePlan } from '../src/elytra/dive'
import * as L from '../src/combat/aerial-lance'
import { evaluateAerial, type AerialState } from '../src/combat/aerial-graph'
import { createAerialCombat } from '../src/combat/aerial-executor'

function openWorld (floorY = 100) {
  return {
    at: (_x: number, y: number) => (y < floorY ? 1 : 0),
    solid: (_x: number, y: number) => y < floorY,
    boxHit: (_x: number, y: number) => y < floorY,
    floorBelow: (_x: number, y: number, _z: number, depth = 40) =>
      y - depth <= floorY ? { top: floorY, lava: false, water: false } : null
  }
}

test('Phase 5 smooth steering: closed-loop 1.21.11 glide past a close target banks smoothly without 180-deg yaw snapping or spin reversals', () => {
  const W = openWorld(100)
  // Bot has just overshot target at (0, 112, 0), currently at (0, 118, -5) flying north (vz = -1.2) — target is 5 blocks directly behind!
  const target = new Vec3(0, 112, 0)
  const sim = (smooth: boolean) => {
    const p = { x: 0, y: 118, z: -5 }
    const v = { x: 0.05, y: 0, z: -1.2 }
    let yaw = 0
    let pitch = 0
    let turnSign = 0
    let maxYawJump = 0
    let signFlips = 0
    let prevSign = 0
    let minDist = Infinity
    let hitT = -1
    for (let t = 0; t < 60; t++) {
      const st: any = { p: { ...p }, v: { ...v }, boost: 0, fd: 0 }
      if (smooth) { st.yaw = yaw; st.pitch = pitch; st.turnSign = turnSign }
      const pl = choose(W, st, { kind: 'point', at: target, reach: true, gap: 2.5, speedMin: 0.45 })
      assert.ok(pl, 'planner must always find a safe glide trajectory')
      if (t > 0) maxYawJump = Math.max(maxYawJump, Math.abs(wrap(pl.yaw - yaw)))
      const hs = Math.hypot(v.x, v.z)
      if (hs > 0.4) {
        const heading = Math.atan2(-v.x, -v.z)
        const bank = wrap(pl.yaw - heading)
        const s = Math.abs(bank) > 0.35 ? Math.sign(bank) : 0
        if (s && prevSign && s !== prevSign) signFlips++
        if (s) prevSign = s
        if (Math.abs(bank) > 0.35) turnSign = Math.sign(bank)
        else if (Math.abs(bank) < 0.15) turnSign = 0
      }
      yaw = pl.yaw
      pitch = pl.pitch
      glideStep(p, v, yaw, pitch, false)
      const d = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z)
      if (d < minDist) { minDist = d; hitT = t }
    }
    return { maxYawJump, signFlips, minDist, hitT }
  }
  const oldRes = sim(false)
  const newRes = sim(true)
  assert.ok(newRes.maxYawJump < 1.0, `smooth live steering must avoid violent 180-deg yaw snaps (got max Δyaw=${newRes.maxYawJump.toFixed(2)} vs stateless ${oldRes.maxYawJump.toFixed(2)})`)
  assert.ok(newRes.maxYawJump < oldRes.maxYawJump, `smooth max Δyaw (${newRes.maxYawJump.toFixed(2)}) must beat stateless (${oldRes.maxYawJump.toFixed(2)})`)
  assert.equal(newRes.signFlips, 0, `smooth banked turn must commit to one turn direction with 0 reversals (got ${newRes.signFlips} vs old ${oldRes.signFlips})`)
  assert.ok(newRes.minDist < 2.5, `smooth banked arc must swing back onto target cleanly (minDist=${newRes.minDist.toFixed(2)})`)
  assert.ok(newRes.hitT <= oldRes.hitT, `smooth banked arc must reach target at least as fast as jerky spinning (${newRes.hitT} <= ${oldRes.hitT})`)
})

test('Phase 5 faster lock-on: chooseLance locks onto a 45-deg off-axis moving/strafing target immediately via widened yaw & lead bearing', () => {
  const W = openWorld(100)
  // Bot flying north at (0, 108, 12) with active glide/rocket, moving/strafing target starting at (10, 100, 0) running east (+0.25 b/t) — ~45 deg off nose!
  const st = { p: { x: 0, y: 108, z: 12 }, v: { x: 0.1, y: -0.05, z: -1.35 }, yaw: 0, pitch: -0.1, boost: 10, fd: 0 }
  const hisV = { x: 0.25, y: 0, z: 0 }
  const foot = (t: number) => ({ x: 10 + hisV.x * t, y: 100, z: 0 })
  const pl = L.chooseLance(W, st, foot, { name: 'diamond_spear', hisV, H: 16 })
  assert.ok(pl, 'chooseLance must lock directly onto a 45-deg off-axis moving target without falling back to circling')
  assert.ok(pl.hitT <= 15 && pl.dmg > 0, `expected prompt kinetic hit (hitT=${pl.hitT}, dmg=${pl.dmg})`)
})

test('Phase 5 faster lock-on: aerial-executor stand() extends a smooth turn-out arc when overshooting target inside 8 blocks', async () => {
  const capturedGoals: any[] = []
  const target: any = { id: 2, position: new Vec3(0, 110, 0), velocity: new Vec3(0, 0, 0), flying: true, isValid: true }
  // Bot at (0, 111, -6) flying north (vz = -1.2): target is 6 blocks behind (outside 4.5 jab reach, inside 8-block turn radius)!
  const bot: any = Object.assign(new EventEmitter(), {
    health: 20,
    entity: { id: 1, position: new Vec3(0, 111, -6), velocity: new Vec3(0, 0, -1.2), elytraFlying: true, onGround: false, yaw: 0, pitch: 0 },
    heldItem: { name: 'iron_spear' },
    inventory: { slots: [], items: () => [{ name: 'iron_spear' }, { name: 'firework_rocket', count: 8 }] },
    world: { raycast: () => null }
  })
  const ops: any = {
    enemy: () => target,
    worldOf: () => openWorld(100),
    kit: () => ({ elytra: true, chest: true, mace: false, rockets: 8 }),
    landingSpot: () => new Vec3(0, 100, 0),
    gliding: (e: any) => !!(e.elytraFlying || e.flying),
    predictGlider: (e: any, v: any, t: number) => e.position.offset((v?.x || 0) * t, (v?.y || 0) * t, (v?.z || 0) * t),
    takeoff: async () => ({ ok: true }),
    fly: async (_b: any, _c: any, opts: any) => {
      const g = opts.goal()
      capturedGoals.push(g.at(0))
      return { why: 'done' }
    },
    land: async () => ({ ok: true }),
    swapChest: async () => ({ ok: true }),
    startGlide: () => true,
    allow () {},
    used () {},
    stats: {}
  }
  const aerial = createAerialCombat(bot, ops)
  await aerial.run({ aborted: false })
  assert.equal(capturedGoals.length, 1)
  // Because bot is flying north (-Z) and target is behind (+Z within 8 bl), turn-out point must extend FORWARD (-Z, z < -4) and laterally, NOT behind at z > 0!
  assert.ok(capturedGoals[0].z < bot.entity.position.z - 4, `expected forward turn-out arc (z=${capturedGoals[0].z.toFixed(1)} < -8), not 180-deg overhead snap behind bot`)
  assert.ok(Math.abs(capturedGoals[0].x) >= 4, `expected smooth lateral bank offset (|x|=${Math.abs(capturedGoals[0].x).toFixed(1)})`)
})

test('Phase 5 EV pricing (#20-28): divePlan allows axe stun-slam vs shield; lancePlan allows airborne flank with 1 rocket; evaluateAerial prices HP continuously', () => {
  const makeBot = (items: any[], flying = false) => ({
    entity: { position: new Vec3(0.5, 100, 0.5), onGround: !flying, isInWater: false, elytraFlying: flying, yaw: 0, pitch: 0 },
    inventory: { slots: Object.assign(Array(46).fill(null), flying ? { 6: { name: 'elytra' } } : {}), items: () => items },
    blockAt: () => ({ boundingBox: 'empty', name: 'air' }),
    registry: require('prismarine-registry')('1.21.11'),
    on () {}
  })
  const shieldedFoe = { position: new Vec3(10.5, 100, 0.5), yaw: Math.PI / 2, metadata: [0, 0, 0, 0, 0, 0, 0, 0, 1], equipment: [{ name: 'shield' }] }

  // divePlan: with axe, stun-slam breaks shield -> allowed; without axe and foe facing us with shield -> refused.
  const baseDiveItems = [{ name: 'elytra', count: 1 }, { name: 'mace', count: 1 }, { name: 'diamond_chestplate', count: 1 }, { name: 'firework_rocket', count: 4 }]
  assert.equal(divePlan(makeBot(baseDiveItems), shieldedFoe, { d: 10, dy: 0, hp: 20, foeGrounded: true, hisShield: true }), null, 'without axe, dive into facing shield is refused')
  assert.ok(divePlan(makeBot([...baseDiveItems, { name: 'diamond_axe', count: 1 }]), shieldedFoe, { d: 10, dy: 0, hp: 20, foeGrounded: true, hisShield: true }), 'with axe, stun-slam dive vs shield is allowed')

  // lancePlan: already gliding -> 1 rocket is enough and flanking shielded foe is allowed.
  const airBot = makeBot([{ name: 'elytra', count: 1 }, { name: 'firework_rocket', count: 1 }, { name: 'iron_spear', count: 1 }], true)
  assert.ok(L.lancePlan(airBot, shieldedFoe, { d: 12, hp: 12, hisShield: true }), 'airborne lance can flank shielded foe with 1 rocket')

  // evaluateAerial: hp=5 still prefers SafeLanding, hp=8 still includes and prices DiveStrike competitively instead of hard-deleting it.
  const actor = (id: number, x: number, y: number, flying: boolean) => ({ id, position: { x, y, z: 0 }, velocity: { x: 0.1, y: -0.6, z: 0 }, flying, grounded: !flying, alive: true })
  const baseState = (health: number): AerialState => ({
    self: actor(1, 0, 80, true), target: actor(2, 2, 77, false), health, interrupted: false,
    safeLanding: { x: 0, y: 64, z: 0 }, corridorClear: true,
    equipment: { elytra: true, chestplate: true, rockets: 4, pearls: 2, mace: true, spear: true },
    maceDropReady: true, maceReady: true, spearReady: true, fallDistance: 4, pearlDamage: 5
  })
  assert.equal(evaluateAerial(baseState(5)).node, 'SafeLanding', 'critically low hp=5 still chooses SafeLanding')
  const at8 = evaluateAerial(baseState(8))
  assert.ok(at8.candidates.some(c => c.id === 'DiveStrike'), 'hp=8 must price DiveStrike instead of hard-deleting it')
  assert.equal(at8.node, 'SafeLanding', 'at hp=8 low-HP SafeLanding still beats risky DiveStrike by cost')
  assert.equal(evaluateAerial(baseState(9)).node, 'DiveStrike', 'at hp=9 ready DiveStrike cleanly beats SafeLanding')
})

test('Phase 5 #20-25a: kit.toHotbar swaps a fallback slot when all 9 hotbar slots hold KEEP items', async () => {
  const slots = Array(46).fill(null)
  const keepNames = ['diamond_sword', 'diamond_axe', 'mace', 'bow', 'crossbow', 'totem_of_undying', 'golden_apple', 'water_bucket', 'shield']
  keepNames.forEach((name, i) => { slots[36 + i] = { name, slot: 36 + i, count: 1 } })
  slots[12] = { name: 'firework_rocket', slot: 12, count: 8 }
  const bot: any = {
    quickBarSlot: 0,
    currentWindow: null,
    inventory: { slots, items: () => slots.filter(Boolean) },
    moveSlotItem: async (from: number, to: number) => {
      const tmp = slots[to]
      slots[to] = slots[from]
      slots[from] = tmp
    }
  }
  const idx = await toHotbar(bot, (it: any) => it?.name === 'firework_rocket')
  assert.ok(idx >= 0 && idx < 9 && idx !== 0, `toHotbar must find a non-held fallback slot on full KEEP hotbar (got ${idx})`)
  assert.equal(slots[36 + idx]?.name, 'firework_rocket')
  assert.equal(slots[36]?.name, 'diamond_sword', 'currently held slot 0 must stay untouched')
})

test('Phase 5 #20-25b: land() jink does not burn RESCUE_ROCKETS', async t => {
  const bot: any = Object.assign(new EventEmitter(), {
    health: 20, fireworkRocketDuration: 0,
    entity: { position: new Vec3(0, 128, 0), velocity: new Vec3(0.5, -0.2, 0), onGround: false, elytraFlying: true, yaw: 0, pitch: 0 }
  })
  const state: any = { driving: 0, fd: 0 }
  let fired = 0
  t.mock.method(require('../src/elytra/physics'), 'worldOf', () => openWorld(120))
  const installMod = require('../src/elytra/install')
  t.mock.method(installMod, 'install', () => state)
  t.mock.method(installMod, 'flightControl', (_b: any, ctl: any) => ctl)
  t.mock.method(installMod, 'steer', () => {})
  t.mock.method(installMod, 'fireRocket', () => { fired++; return { ok: true } })
  t.mock.method(require('../src/elytra/kit'), 'rocketCount', () => RESCUE_ROCKETS) // exactly RESCUE_ROCKETS (3)
  t.mock.method(require('../src/elytra/rocket-forecast'), 'rocketForecast', () => ({ boost: 0, boostMin: 0, boostMax: 0 }))
  // Trigger a smash jink during landing!
  t.mock.method(require('../src/threats'), 'incomingGliders', () => [])
  t.mock.method(require('../src/threats'), 'smashes', () => [{ ticks: 6, at: new Vec3(1, 128, 0) }])
  t.mock.method(require('../src/elytra/control'), 'choose', (_w: any, _s: any, _g: any, o: any) => ({
    c: o?.rocketNow ? 1 : 20, yaw: 0, pitch: 0, r: { kind: null, t: 18, fd: 0 }
  }))
  const file = require.resolve('../src/elytra/flight'), saved = require.cache[file]
  delete require.cache[file]
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved })
  const ctl = { aborted: false }
  const landing = require('../src/elytra/flight').land(bot, ctl, { at: new Vec3(0, 120, 0), arena: { x: 0, y: 120, z: 0, r: 60, killY: 113 } })
  try {
    bot.emit('physicsTick')
    assert.equal(fired, 0, 'a mid-landing jink must NOT burn RESCUE_ROCKETS')
  } finally {
    ctl.aborted = true
    bot.emit('physicsTick')
    await landing
  }
})

test('Phase 5 #20-25c: aerial-executor strikeMace keeps chestplate on when close to ground (<= 2.2 bl) and reglide-swaps only when high', async () => {
  const c = clock.activate(new clock.GameClock({ manual: true, epoch: 50000 }))
  try {
    for (const endY of [101.5, 114]) {
      const swaps: string[] = []
      let glides = 0
      const target: any = { id: 2, position: new Vec3(0, 100, 0), velocity: new Vec3(0, 0, 0), flying: false, isValid: true }
      const bot: any = Object.assign(new EventEmitter(), {
        health: 20,
        entity: { id: 1, position: new Vec3(0, 114, 0), velocity: new Vec3(0, -0.5, 0), elytraFlying: true, onGround: false, yaw: 0, pitch: 0 },
        heldItem: { name: 'mace' },
        inventory: { slots: Object.assign(Array(46).fill(null), { 6: { name: 'elytra' } }), items: () => [{ name: 'elytra' }, { name: 'diamond_chestplate' }, { name: 'mace' }] },
        _ndElytra: { driving: 0, fd: 2 },
        _ndMaceHeldAt: 40000,
        world: { raycast: () => null }
      })
      const ops: any = {
        enemy: () => target,
        worldOf: () => openWorld(100),
        kit: () => ({ elytra: true, chest: true, mace: true, rockets: 4 }),
        landingSpot: () => new Vec3(0, 100, 0),
        gliding: (e: any) => !!(e.elytraFlying || e.flying),
        predictGlider: (e: any) => e.position,
        takeoff: async () => ({ ok: true }),
        fly: async () => ({ why: 'done' }),
        land: async () => ({ ok: true }),
        swapChest: async (_b: any, want: string) => {
          swaps.push(want)
          bot.inventory.slots[6] = { name: want === 'elytra' ? 'elytra' : 'diamond_chestplate' }
          if (want === 'chest') {
            bot.entity.elytraFlying = false
            bot.entity.position.y = endY
            bot.heldItem = { name: 'diamond_sword' }
          }
          return { ok: true }
        },
        startGlide: () => { glides++; return true },
        allow () {},
        used () {},
        stats: {}
      }
      const aerial = createAerialCombat(bot, ops)
      await aerial.run({ aborted: false })
      if (endY <= 102.2) {
        assert.deepEqual(swaps, ['chest'], 'at <= 2.2 bl above floor, strikeMace must NOT swap elytra back onto chest')
        assert.equal(glides, 0)
      } else {
        assert.deepEqual(swaps, ['chest', 'elytra'], 'high above floor (> 2.2 bl), strikeMace reglide-swaps back to elytra')
        assert.equal(glides, 1)
      }
    }
  } finally {
    c.dispose()
  }
})

test('Phase 5 #20-24: rescue_config triggers pit rescue using rocketForecast boostMin=0 even when fireworkRocketDuration is pinned to 40', async () => {
  const { readFileSync } = require('node:fs')
  const { createRequire } = require('node:module')
  const path = require('node:path')
  const vm = require('node:vm')
  const bot: any = Object.assign(new EventEmitter(), {
    health: 20,
    fireworkRocketDuration: 40, // install.ts pins this to 40 until entityGone!
    entity: { position: new Vec3(0, 117, 0), velocity: new Vec3(0, -0.8, 0), onGround: false, isInWater: false, elytraFlying: true, yaw: 0, pitch: -0.2 },
    inventory: { slots: [], items: () => [{ name: 'elytra' }, { name: 'firework_rocket', count: 3 }] }
  })
  const rolloutBoosts: number[] = []
  let rescued = false
  const sky: any = {
    install: () => ({ fd: 0, lastY: 117, driving: 1 }),
    worldOf: () => ({ floorBelow: () => null }),
    kit: () => ({ elytra: true, rockets: 3 }),
    rocketForecast: () => ({ boost: 12, boostMin: 0, boostMax: 18, boostUntil: null }),
    // Nominal boost=12 stays above killY (118), but worst-case boostMin=0 drops below killY+1 (112)!
    rollout: (_W: any, _p: any, _v: any, _y: number, _pi: number, boost: number) => {
      rolloutBoosts.push(boost)
      return boost > 0 ? { kind: null, fd: 0, p: { y: 118 } } : { kind: null, fd: 6, p: { y: 112 } }
    },
    fly: async () => ({ why: 'ok' })
  }
  const session: any = {
    bot,
    current: { name: 'fight' },
    require: () => bot,
    runIntent: async (name: string) => { if (name === 'fly_to') rescued = true; return { status: 'done', detail: { ok: true } } }
  }
  const file = path.join(__dirname, '../src/rpc/aerial.js'), native = createRequire(file)
  const mod = { exports: {} as any }
  vm.runInNewContext(readFileSync(file, 'utf8'), {
    module: mod,
    exports: mod.exports,
    require: (name: string) => name === '../elytra' ? sky : name === '../combat/wind-out' ? { installWindOut () {} } : native(name),
    console: { log () {} }
  })
  const methods = mod.exports.aerialMethods({ session })
  await methods.rescue_config({ safe: { x: 0, y: 120, z: 0 }, killY: 113, arena: { x: 0, y: 120, z: 0, r: 60 } })
  bot.emit('physicsTick')
  await new Promise(setImmediate)
  assert.ok(rolloutBoosts.includes(0), `rescue_config must check boostMin=0 instead of trusting pinned fireworkRocketDuration=40 (checked: ${rolloutBoosts.join(',')})`)
  assert.equal(rescued, true, 'rescue_config must trigger fly_to rescue when boostMin=0 crosses killY+1')
})
