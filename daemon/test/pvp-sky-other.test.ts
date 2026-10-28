// Таран другого летуна в бою со своей целью: защита, если свою цель сейчас не ударить раньше.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { skySenseTurn } from '../src/pvp/turn-air'

function frame(t, { targetAt = new Vec3(10, 64, 0), ready = true } = {}) {
  const threats = require('../src/threats')
  const glider = { id: 7, name: 'glider', kind: 'dive', ticks: 14, at: { x: 0, y: 64.5, z: -2 }, from: { x: 0, y: 66, z: -20 }, vel: { x: 0, y: -.1, z: 1.4 }, blockable: false }
  t.mock.method(threats, 'incomingGliders', () => [glider])
  const bot: any = { entity: { position: new Vec3(0, 64, 0), elytraFlying: false, height: 1.8, width: .6 }, blockAt: p => ({ name: 'air', position: p, boundingBox: 'empty', shapes: [] }) }
  const ctx: any = { bot, prof: { player: true }, sky: { threat: () => null }, vision: { visible: () => true }, entity: { id: 2, position: targetAt },
    session: { _ndFoes: ['Flyer', 'Target'] }, nextReady: ready ? 0 : Infinity }
  const turn: any = { me: bot.entity.position }
  skySenseTurn(ctx, turn)
  return turn
}

test('чужой летун идёт на меня, а свою цель не ударить — защита от него', t => {
  const turn = frame(t)
  assert.equal(turn.skyThreat?.other?.id, 7)
  assert.equal(turn.skyThreat.eta, 14)
})

test('своя цель в досягаемости и удар готов — бью её, не отвлекаюсь', t => {
  assert.equal(frame(t, { targetAt: new Vec3(2, 64, 0) }).skyThreat, null)
})

test('своя цель рядом, но удар не готов — защита от летуна', t => {
  assert.equal(frame(t, { targetAt: new Vec3(2, 64, 0), ready: false }).skyThreat?.other?.id, 7)
})
