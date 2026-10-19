import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmergencyEscape, lavaFallFloor } from '../src/combat/emergency-escape'
// Фасад elytra отдаёт имена геттерами — подмены ставятся в частях, где имена определены.
import skyWorld = require('../src/elytra/physics')
import skyKit = require('../src/elytra/kit')
import skyFlight = require('../src/elytra/flight')
import pearls = require('../src/pearl-hop')
import projectiles = require('../src/throw')
import { Vec3 } from 'vec3'
import * as clock from '../src/game-clock'

test('only a fresh descending lava forecast can start a rescue before contact', () => {
  const from = new Vec3(.5, 120, .5)
  const forecast: any = { at: clock.now(), from, landing: { lava: true, top: 101 }, ground: false, excluded: false }
  const bot: any = { entity: { position: from.clone(), velocity: new Vec3(0, -.2, 0), onGround: false }, _ndClutch: { forecast } }
  assert.equal(lavaFallFloor(bot), 101)
  forecast.excluded = true; assert.equal(lavaFallFloor(bot), null)
  forecast.excluded = false; forecast.at -= 151; assert.equal(lavaFallFloor(bot), null)
  forecast.at = clock.now(); bot.entity.position.x += 2; assert.equal(lavaFallFloor(bot), null)
  bot.entity.position = from.clone(); bot.entity.onGround = true; assert.equal(lavaFallFloor(bot), null)
  bot.entity.onGround = false; bot.entity.velocity.y = .2; assert.equal(lavaFallFloor(bot), null)
})

test('the current validated movement endpoint supersedes a competing lava coast forecast, while drift damage expiry and release restore rescue', () => {
  const timer = new clock.GameClock({ manual: true, epoch: 0 }); clock.activate(timer)
  // Recorded Author43 body frames; its marker was not recorded. Model the
  // existing producer's from/next contract rather than claiming a stale packet.
  const from = new Vec3(22.310492886795448, 108.02442408821369, 39.71366478840542)
  const at = new Vec3(22.476627246522682, 107.79673560066871, 39.54312306140648)
  const marker = { from: from.clone(), next: at.offset(.007, 0, 0), until: 100, hp: 20 }
  const bot: any = { health: 20, entity: { position: at.clone(), velocity: new Vec3(.15, -.30, -.15), onGround: false },
    _ndClutch: { forecast: { at: 0, from: from.clone(), landing: { lava: true, top: 101 }, ground: false, excluded: false } },
    _ndParkourForecast: marker }
  try {
    assert.equal(lavaFallFloor(bot), null, 'a fresh matching native next frame must not be cancelled by a different coast forecast')
    bot.entity.position = from.offset(.007, 0, 0)
    assert.equal(lavaFallFloor(bot), null, 'the same owner remains valid before the controller advances its marker')
    bot.entity.position = at.clone(); bot.health = 19
    assert.equal(lavaFallFloor(bot), 101, 'damage immediately revokes the owner exemption')
    bot.health = 20; bot.entity.position = marker.next.offset(.11, 0, 0)
    assert.equal(lavaFallFloor(bot), 101, 'drift beyond both validated endpoints restores the real rescue')
    bot.entity.position = at.clone(); timer.advanceTicks(2)
    assert.equal(lavaFallFloor(bot), 101, 'an expired owner cannot suppress a still-fresh lava forecast')
    marker.until = 200; delete bot._ndParkourForecast
    bot._ndClutch.forecast.guardAllow = true
    assert.equal(lavaFallFloor(bot), 101, 'an old guardAllow boolean cannot substitute for a live movement owner')
  } finally { timer.dispose(); clock.activate(null) }
})

test('a lava rescue accepts a safe steep arc and stops searching before delaying the emergency throw', async () => {
  const saved: any[] = [skyWorld.worldOf, skyFlight.landingSpot, skyKit.kit, skyFlight.lavaLaunchClear, pearls.settle, pearls.pearlDamage, projectiles.throwAt]
  const shore = new Vec3(8.5, 105, .5)
  const bot: any = { health: 20, entity: { position: new Vec3(.5, 100, .5), isInLava: true },
    inventory: { items: () => [{ name: 'ender_pearl', count: 8 }] }, blockAt: () => ({ name: 'lava' }) }
  let forecasts = 0
  skyWorld.worldOf = () => ({})
  skyFlight.landingSpot = () => shore
  skyKit.kit = () => ({ elytra: false, rockets: 0 }) as any
  skyFlight.lavaLaunchClear = () => true
  pearls.settle = (_world: any, at: any) => ({ ok: at.x === shore.x, edge1: 0 }) as any
  pearls.pearlDamage = () => 5
  projectiles.throwAt = async (_bot: any, _target: any, options: any) => {
    const shot = options.pick({ from: bot.entity.position, landing: (_yaw: number, pitch: number) => {
      forecasts++
      return pitch >= 85 * Math.PI / 180 ? { tp: shore } : { tp: new Vec3(.5, 100, .5) }
    } })
    assert.ok(shot, 'the steep trajectory clears a nearby high wall')
    assert.equal(options.onAim({ land: { tp: shore } }), true)
    bot.entity.position = shore.clone()
    return { thrown: true } as any
  }
  try {
    assert.equal((await createEmergencyEscape(bot).run({ aborted: false }, 'pearl')).ok, true)
    assert.ok(forecasts <= 12, 'the first safe forecast is used immediately in lava')
  } finally {
    [skyWorld.worldOf, skyFlight.landingSpot, skyKit.kit, skyFlight.lavaLaunchClear, pearls.settle, pearls.pearlDamage, projectiles.throwAt] = saved
  }
})
