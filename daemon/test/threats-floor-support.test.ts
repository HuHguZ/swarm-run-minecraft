import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import threats = require('../src/threats')

const registry = require('prismarine-registry')('1.21.11'), Block = require('prismarine-block')(registry)
function scene({ name = 'stone', x = .5, y = 120 } = {}) {
  const changes = new Map<string, string>()
  const bot: any = Object.assign(new EventEmitter(), { registry, _client: new EventEmitter(), entities: {},
    entity: { id: 1, position: new Vec3(x, y, .5), velocity: new Vec3(0, 0, 0), height: 1.8, width: .6, onGround: true },
    blockAt(p) { const q = p.floored(), n = changes.get(q.toString()) ?? (q.y === 119 ? name : q.y === 118 ? 'obsidian' : 'air')
      const b = Block.fromStateId(registry.blocksByName[n].defaultState); b.position = q; return b } })
  const danger = () => threats.dangers(bot, { foes: [] }).floor
  danger()
  const crack = (at = new Vec3(0, 119, 0)) => bot.emit('blockBreakProgressObserved', bot.blockAt(at), 2, { id: 2, username: 'Ally' })
  const remove = (at = new Vec3(0, 119, 0)) => { const old = bot.blockAt(at); changes.set(at.toString(), 'air'); bot.emit('blockUpdate', old, bot.blockAt(at)) }
  const sound = (at: Vec3, what = 'hit') => bot._client.emit('sound_effect', { sound: { data: { soundName: `minecraft:block.stone.${what}` } },
    x: at.x * 8, y: at.y * 8, z: at.z * 8, volume: 1 })
  return { bot, danger, crack, remove, sound, close: () => bot.emit('end') }
}

test('a visible neighboring excavation does not take an intact native support from this body', () => {
  for (const event of ['crack', 'remove']) {
    const f = scene(), at = new Vec3(1, 119, 0)
    try {
      if (event === 'crack') f.crack(at); else f.remove(at)
      assert.deepEqual(f.danger(), [], 'the worker stands on cell0 while its ally excavates cell1')
      f.sound(at.offset(.5, .5, .5), event === 'crack' ? 'hit' : 'break')
      assert.deepEqual(f.danger(), [], 'the same known neighbor does not reappear as a blind sound escape')
      assert.equal(f.bot.blockAt(new Vec3(0, 119, 0)).name, 'stone')
    } finally { f.close() }
  }
})

test('native full blocks and slabs under the own AABB remain threats even when an ally breaks them', () => {
  for (const options of [{ name: 'stone', y: 120 }, { name: 'stone_slab', y: 119.5 }]) for (const event of ['crack', 'remove']) {
    const f = scene(options)
    try {
      if (event === 'crack') f.crack(); else f.remove()
      assert.equal(f.danger()[0]?.signal, 'sight', `${options.name}/${event}: the actual support is protected`)
    } finally { f.close() }
  }
})

test('real native shape overlap counts edge support, while an adjacent cell or a thin wall outside the feet does not', () => {
  for (const options of [
    { name: 'stone', x: 1.15, y: 120, expected: true },
    { name: 'stone', x: 1.3, y: 120, expected: false },
    { name: 'cobblestone_wall', x: 1.1, y: 120.5, expected: false }
  ]) {
    const f = scene(options)
    try { f.crack(); assert.equal(!!f.danger().length, options.expected, JSON.stringify(options)) } finally { f.close() }
  }
})

test('a support event is rechecked against the current feet after moving or landing below its old top', () => {
  for (const move of [new Vec3(3.5, 120, .5), new Vec3(.5, 119, .5)]) {
    const f = scene()
    try { f.crack(); assert.ok(f.danger().length); f.bot.entity.position = move; assert.deepEqual(f.danger(), []) } finally { f.close() }
  }
})

test('unexplained nearby digging behind an opaque floor remains uncertain, including beside a known visible dig', () => {
  for (const neighbor of [false, true]) {
    const f = scene()
    try {
      if (neighbor) { f.crack(new Vec3(1, 119, 0)); f.sound(new Vec3(1.5, 119.5, .5)) }
      f.crack(new Vec3(0, 118, 0)) // genuinely hidden by our opaque stone support
      f.sound(new Vec3(.5, 118.5, .5))
      const signal = f.danger()[0]
      assert.equal(signal?.signal, 'sound')
      assert.equal(signal.holes, 0, 'hearing cannot disclose the hidden cell')
      assert.equal(signal.at.y, f.bot.entity.position.y)
    } finally { f.close() }
  }
})

test('planning both dig layers never manufactures a native disappearance or crack event', () => {
  const f = scene()
  try {
    f.bot._ndDigAvoid = [{ x: 0, y: 119, z: 0 }, { x: 0, y: 118, z: 0 }]
    assert.deepEqual(f.danger(), [])
  } finally { f.close() }
})
