import test from 'node:test'
import assert from 'node:assert/strict'
import { wall } from '../src/game-clock'
import { _softTransform } from '../src/fastblocks'

function clock () {
  const original = { monotonic: wall.monotonic, setImmediate: wall.setImmediate }
  let now = 0
  const turns: (() => void)[] = []
  wall.monotonic = () => now
  wall.setImmediate = fn => turns.push(fn)
  return { turns, work: () => { now += 9 }, restore: () => Object.assign(wall, original) }
}

test('a costly inbound batch yields without losing frames, partial bytes or write order', async () => {
  const c = clock()
  const sp = require('minecraft-protocol/src/transforms/framing').createSplitter()
  sp._transform = _softTransform
  const frames: number[] = []
  const callbacks: number[] = []
  sp.on('data', frame => { frames.push(frame[0]); c.work() })
  const finished = new Promise<void>((resolve, reject) => { sp.on('finish', resolve); sp.on('error', reject) })
  try {
    sp.write(Buffer.from([1, 10, 1, 11, 2, 12]), () => callbacks.push(1))
    sp.write(Buffer.from([13, 1, 14]), () => callbacks.push(2))
    sp.end()
    assert.deepEqual(frames, [10], 'return to the event loop after costly dispatch')
    assert.deepEqual(callbacks, [], 'the following write must stay queued')
    assert.equal(c.turns.length, 1)
    while (c.turns.length) c.turns.shift()!()
    await finished
    assert.deepEqual(frames, [10, 11, 12, 14])
    assert.deepEqual(callbacks, [1, 2])
    assert.equal(sp.buffer.length, 0)
  } finally { c.restore(); sp.destroy() }
})

test('a splitter destroyed during a yield does not dispatch the remaining frames', () => {
  const c = clock()
  let calls = 0
  const sp: any = { buffer: Buffer.alloc(0), push () { c.work() }, destroyed: false }
  try {
    _softTransform.call(sp, Buffer.from([1, 10, 1, 11]), null, () => { calls++ })
    assert.equal(c.turns.length, 1)
    sp.destroyed = true
    sp.push = () => assert.fail('dispatch after disconnect')
    c.turns.shift()!()
    assert.equal(calls, 1)
  } finally { c.restore() }
})

test('a downstream failure after yielding reaches the transform callback once', () => {
  const c = clock()
  const fatal = new Error('downstream parser failed')
  const errors: Error[] = []
  let sent = 0
  const sp: any = { buffer: Buffer.alloc(0), push () { if (sent++) throw fatal; c.work() } }
  try {
    _softTransform.call(sp, Buffer.from([1, 10, 1, 11]), null, error => errors.push(error))
    assert.equal(c.turns.length, 1)
    c.turns.shift()!()
    assert.deepEqual(errors, [fatal])
  } finally { c.restore() }
})
