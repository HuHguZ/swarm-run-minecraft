import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { observeTactics } from '../src/tactics/minecraft'
import { Vec3 } from 'vec3'

// PvP-дуэль (pvp.duel держит session.tempo) — защищённый бой: тактика уровня <3 её не перебивает (s7 06.10).
function session(current: string | null, tempo: boolean) {
  const bot: any = new EventEmitter()
  bot.version = '1.21.11'
  bot.health = 20; bot.food = 20
  bot.inventory = { slots: [], items: () => [{ name: 'diamond_sword', count: 1 }] }
  bot.registry = { foodsByName: {}, entitiesByName: {}, effectsByName: {}, blocksByName: {} }
  bot.entity = { id: 1, position: new Vec3(.5, 64, .5), height: 1.8, eyeHeight: 1.62, onGround: true, effects: {}, metadata: [], yaw: 0, pitch: 0 }
  bot.entities = {}
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.blockAt = (p: any) => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored(), shapes: p.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] })
  return { bot, current: current ? { name: current } : null, reflex: null, bus: { emit: () => {} }, tempo: tempo ? {} : null }
}

test('PvP-дуэль владеет боем: protectedEncounter при fight с session.tempo, без дуэли — нет', () => {
  assert.equal(observeTactics(session('fight', true)).protectedEncounter, true)
  assert.equal(observeTactics(session('fight', false)).protectedEncounter, false)
  assert.equal(observeTactics(session('goto', true)).protectedEncounter, false, 'вне боя tempo не защищает')
})
