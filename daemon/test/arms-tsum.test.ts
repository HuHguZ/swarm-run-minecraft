'use strict'
// Сводка приёмов арены (farm/crystal/tsum) и сторож портов PvP-сцен (arms-guard), 2026-10-06.
const test = require('node:test')
const assert = require('node:assert/strict')
const tsum = require('../../farm/crystal/tsum')
const guard = require('../arms-guard')

test('tsum: победы по бойцам и ролям, приёмы с числами суммируются по местам, урон', () => {
  const r = (n, winner, aName, tricksA, dmgA) => 'x ROUND ' + JSON.stringify({ kit: 'копья', n, winner, durS: 30 + n, tps: 600 + n, lagMax: { a: 3, b: 18 },
    a: { name: aName, died: winner !== aName, swings: 10, landed: 5, crits: 2, sprintHits: 1, tricks: tricksA, trickDmg: dmgA },
    b: { name: aName === 'P' ? 'Q' : 'P', died: winner === aName, swings: 8, landed: 3, tricks: { 'копьё: разгонов 2, попал 1; смен копьё↔меч 3': 1 } } })
  const text = [r(1, 'P', 'P', { 'спринт-крит': 2 }, { 'спринт-крит': 7.5 }), r(2, 'P', 'Q', { 'спринт-крит': 1 }, { 'спринт-крит': 3, прочее: 2 })].join('\n')
  const rounds = tsum.parse(text, 'f')
  assert.equal(rounds.length, 2)
  const [k] = tsum.summarize(rounds)
  assert.deepEqual(k.byName, { P: 2 })
  assert.deepEqual(k.byRole, { a: 1, b: 1 })
  assert.equal(k.lag, 18)
  assert.equal(k.tricks['спринт-крит'].uses, 3)
  assert.equal(k.tricks['спринт-крит'].dmg, 10.5)
  assert.equal(k.tricks['прочее'].dmg, 2)
  const sp = k.tricks['копьё: разгонов #, попал #; смен копьё↔меч #']
  assert.deepEqual(sp.nums, [4, 2, 6])
  assert.match(tsum.render([k]), /разгонов 4, попал 2; смен копьё↔меч 6/)
})

test('arms-guard: только порты фермы; живая арена, server/ и основной мир — отказ', () => {
  assert.deepEqual(guard.farmOnly({ ws: ['ws://127.0.0.1:8827', 'ws://127.0.0.1:8927'], mc: ['25627'] }), [8827, 8927])
  for (const bad of ['ws://127.0.0.1:8765', 'ws://127.0.0.1:8768', 'ws://127.0.0.1:8769', 'ws://127.0.0.1:8791', undefined]) {
    assert.throws(() => guard.farmOnly({ ws: [bad] }), /только ферма/, String(bad))
  }
  assert.throws(() => guard.farmOnly({ ws: ['ws://127.0.0.1:8827'], mc: [25565] }), /сервер 25565/)
  assert.throws(() => guard.farmOnly({ ws: ['ws://127.0.0.1:8827'], mc: [''] }), /только ферма/)
  assert.equal(guard.farmServer('127.0.0.1:25627'), 25627)
  assert.throws(() => guard.farmServer('127.0.0.1:25565'), /не к ферме/)
})
