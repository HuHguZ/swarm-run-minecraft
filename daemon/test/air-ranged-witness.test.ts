import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createPacketWitness, pairUseWitness } from '../scenes/pvp/air-ranged-witness'
import { saveAirSummary } from '../scenes/pvp/try-air-ranged'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function fixture(enabled: boolean) {
  let mono = 10
  const sent: any[] = []
  const client: any = new EventEmitter()
  client.write = function (name: string, packet: any) { sent.push({ name, packet: { ...packet, flags: packet.flags && { ...packet.flags } }, receiver: this }); return 17 }
  const original = client.write
  const clock = { id: 'target-process:1', ticks: 20, serverTicks: 18, age: 100n, effectiveRate: 750, predictionTicks: 20, serverAt: 9, sampleAt: 1, sampleAge: 80n }
  const witness = createPacketWitness({ _client: client, ndClock: clock }, enabled, () => ++mono)
  return { witness, client, clock, sent, original }
}

test('target packet witness leaves trace-on/off clock, controls and wire calls identical', () => {
  const on = fixture(true); const off = fixture(false)
  for (const f of [on, off]) {
    f.client.emit('update_time', { age: 120n, time: 50n })
    f.client.emit('set_ticking_state', { tick_rate: 750, is_frozen: false })
    f.witness.start()
    f.client.emit('position', { x: 4, y: 180, z: 3, flags: { x: false }, teleportId: 7 })
    assert.equal(f.client.write('teleport_confirm', { teleportId: 7 }), 17)
    f.clock.ticks++; f.clock.serverTicks++
    const packet = { x: 4, y: 179.92, z: 3, flags: { onGround: false } }
    assert.equal(f.client.write('position', packet), 17)
    packet.y = 100; packet.flags.onGround = true
    f.client.write('tick_end', {})
  }
  assert.deepEqual(on.clock, off.clock)
  assert.deepEqual(on.sent.map(({ receiver, ...entry }) => entry), off.sent.map(({ receiver, ...entry }) => entry))
  assert.ok(on.sent.every(entry => entry.receiver === on.client))
  assert.equal(off.client.write, off.original, 'trace off installs no write wrapper')
  assert.equal(off.client.listenerCount('update_time'), 0)
  const trace = on.witness.drain()!
  assert.equal(off.witness.drain(), null)
  assert.equal(trace.clockId, 'target-process:1')
  assert.deepEqual(trace.packets.map(p => p.name), ['update_time', 'set_ticking_state', 'drive', 'position', 'teleport_confirm', 'position', 'tick_end'])
  assert.equal(trace.packets[0].packet.age, '120')
  const outgoing = trace.packets.find(p => p.direction === 'out' && p.name === 'position')
  assert.equal(outgoing.packet.y, 179.92, 'a reused outgoing packet cannot mutate the witness')
  assert.equal(outgoing.packet.flags.onGround, false)
  assert.equal(outgoing.ticks, 21); assert.equal(outgoing.serverTicks, 19)
  assert.ok(trace.packets.every((p, i) => i === 0 || p.mono > trace.packets[i - 1].mono))
  on.witness.dispose()
  assert.equal(on.client.write, on.original); assert.equal(on.client.listenerCount('position'), 0)
})

test('target packet witness keeps at most 256 entries and stops recording after coast', () => {
  const f = fixture(true); f.witness.start()
  for (let x = 0; x < 300; x++) f.client.write('position', { x, y: 180, z: 0 })
  const trace = f.witness.drain()!
  assert.equal(trace.packets.length, 256)
  assert.equal(trace.packets[0].packet.x, 44); assert.equal(trace.packets.at(-1).packet.x, 299)
  f.client.write('position', { x: 301, y: 180, z: 0 })
  assert.equal(f.witness.drain()!.packets.length, 0)
  assert.equal(f.sent.length, 301, 'ring truncation and coast cannot discard actual wire calls')
  f.witness.dispose()
})

test('Air46 delivery age does not fabricate a world-thread ACK or date the bow release by sequence zero', () => {
  const use = { name: 'use_item', sequence: 5, mono: 22645.8684, serverAge: '24712530' }
  const arrow = { objectData: 237, entityId: 415, mono: 22648.43, serverAge: '24712530' }
  const missing = pairUseWitness('crossbow', 237, [use], [], [arrow])[0]
  assert.equal(missing.ack, null, 'Air46 ping_response is transport RTT, not a use ACK')
  assert.equal(missing.spawn.entityId, 415)
  const ack = { sequenceId: 5, mono: 22649, serverAge: '24712530' }
  const paired = pairUseWitness('crossbow', 237, [use], [ack], [arrow])[0]
  assert.equal(paired.ack.sequenceId, 5)
  assert.equal(paired.ackAfterUseMs, ack.mono - use.mono)
  assert.ok(paired.spawnAfterUseMs < paired.ackAfterUseMs, 'spawn may precede the deferred cumulative ACK')
  assert.equal('ackWorldTick' in paired, false, 'ACK carries no native generation age')

  const draw = { name: 'use_item', sequence: 1, mono: 6573.2888 }
  const release = { name: 'block_dig', status: 5, sequence: 0, mono: 6713.5856 }
  const rows = pairUseWitness('bow', 237, [draw, release], [{ sequenceId: 1, mono: 6580 }], [{ ...arrow, mono: 6733.9162 }])
  assert.equal(rows[0].phase, 'draw')
  assert.equal(rows[0].ack.sequenceId, 1)
  assert.equal(rows[0].spawn, null, 'a draw ACK is not a release witness')
  assert.equal(rows[1].phase, 'release')
  assert.equal(rows[1].ack, null, 'release sequence zero cannot reuse the earlier draw ACK')
})

test('native use witness pairs cumulative ACKs after the write and only the shooter arrow', () => {
  const use = { name: 'use_item', sequence: 5, mono: 100 }
  const acks = [{ sequenceId: 7, mono: 99 }, { sequenceId: 4, mono: 101 }, { sequenceId: 6, mono: 102 }]
  const spawns = [{ objectData: 474, entityId: 1, mono: 101 }, { objectData: 473, entityId: 674, mono: 103 }]
  // Air47 own arrow objectData473 and damage sourceCauseId474 refer to owner473.
  const paired = pairUseWitness('crossbow', 473, [use], acks, spawns)[0]
  assert.equal(paired.ack.sequenceId, 6)
  assert.equal(paired.spawn.entityId, 674)
  assert.equal(paired.ackAfterUseMs, 2)
  assert.equal(paired.spawnAfterUseMs, 3)
  assert.equal(pairUseWitness('crossbow', 473, [use], [{ sequenceId: 4, mono: 101 }], [])[0].ack, null)
})

test('Air47 six-case failure remains a compact parseable farm receipt before the strict assertion', () => {
  const selected = ['both-falling', 'fall-glider', 'opposite-gliders']
  const rows = ['bow', 'crossbow'].flatMap(weapon => selected.map(kind => ({ weapon, kind, repeat: 0,
    result: weapon === 'bow' && kind === 'fall-glider' ? { shot: false } : { fired: true },
    hit: weapon === 'crossbow' && kind === 'fall-glider', damage: weapon === 'crossbow' && kind === 'fall-glider' ? 10 : 0,
    validationError: weapon === 'bow' && kind === 'fall-glider' ? 'shot must actually release in air' : null,
    nativeTrace: [{ large: 'native-only detail' }] })))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-air-summary-'))
  const output = path.join(dir, 'slot-31.jsonl')
  try {
    assert.throws(() => {
      const summary = saveAirSummary(output, rows, selected)
      assert.ok(summary.ok, 'unchanged strict native failure')
    })
    const lines = fs.readFileSync(output, 'utf8').trim().split('\n')
    assert.equal(lines.length, 1, 'farm parser sees one finished attempt despite the later assertion')
    const saved = JSON.parse(lines[0])
    assert.equal(saved.ok, false)
    assert.deepEqual([saved.shots, saved.fired, saved.hits, saved.misses, saved.noShots, saved.validationFailures], [6, 5, 1, 4, 1, 1])
    assert.equal(saved.cases.length, 6)
    assert.equal('nativeTrace' in saved.cases[0], false)
    const source = fs.readFileSync(path.join(__dirname, '../scenes/pvp/try-air-ranged.ts'), 'utf8')
    assert.ok(source.indexOf('saveAirSummary(process.env.LAB_OUT') < source.indexOf('assert.ok(rows.every'), 'real fixture persists before its existing strict checks')
  } finally { if (fs.existsSync(output)) fs.unlinkSync(output); fs.rmdirSync(dir) }
})
