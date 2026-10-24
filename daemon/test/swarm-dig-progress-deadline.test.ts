import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, pvpState } from '../src/swarm/board'
import { digSeconds, dislodgeSeconds, noteDigFailure, noteDigProgress } from '../src/swarm/dislodge'

function fixture() {
  let at = 1000
  const board = new SwarmBoard('blue', () => at)
  const state = pvpState(board)
  const cell = '541,119,591', method = `dig:${cell}`
  const foe: any = { id: 'Champ', position: { x: 541.5, y: 120, z: 591.5 } }
  const S: any = { board, state, team: [] }
  const pick: any = { inventory: { diamond_pickaxe: 1 } }
  const site = { blocks: ['quartz_bricks', 'obsidian'] }
  board.upsert({ id: 'dig:t', kind: 'goto', assignedTo: 't', data: { target: foe.id, dig: cell } })
  return { board, state, cell, method, foe, S, pick, site,
    time: (n: number) => { at = n },
    price: (seconds: number) => dislodgeSeconds(S, foe, method, seconds, 30),
    attempt: () => state.dislodgeWork!.get(`${foe.id}:${method}`)! }
}

test('L lower receipt buys native remaining work after slow centering, from receipt time rather than next poll', () => {
  const f = fixture()
  const total = digSeconds(f.pick, f.site), remaining = digSeconds(f.pick, f.site, 1)
  assert.equal(remaining, 9.4, 'native 1.21.11 unenchanted diamond pick / obsidian')
  f.price(total)
  const originalDeadline = f.attempt().deadline
  // L: center_in takes about 3.4s instead of the planner walk estimate; top is then actually removed.
  const progressAt = 1000 + 3400 + digSeconds(f.pick, { blocks: ['quartz_bricks'] }) * 1000
  f.time(progressAt)
  noteDigProgress(f.board, f.foe.id, f.cell, 1)
  f.time(progressAt + 1100) // delayed coordinator poll must not donate another 1.1s
  assert.ok(f.price(remaining) < 30)
  const deadline = progressAt + (remaining + .5) * 1000
  assert.equal(f.attempt().deadline, deadline, 'confirmed top receipt starts the remaining native budget')
  assert.ok(deadline > originalDeadline)
  f.time(progressAt + 6947) // actual L lower work was stopped after only 6.947s
  assert.ok(f.price(remaining) < 30, 'keep the same physical lower work before its 9.4s completes')
  f.time(progressAt + remaining * 1000)
  assert.ok(f.price(remaining) < 30, 'full native obsidian work fits')
  f.time(deadline + 1)
  assert.ok(f.price(remaining) > 30, 'no further progress still has a finite deadline')
})

test('same already_clear counter, lower counter and approach polling never renew a consumed progress budget', () => {
  const f = fixture(), remaining = digSeconds(f.pick, f.site, 1)
  f.price(digSeconds(f.pick, f.site))
  f.time(4400); noteDigProgress(f.board, f.foe.id, f.cell, 1)
  f.time(4500); f.price(remaining)
  const deadline = f.attempt().deadline
  for (const t of [5000, 7000, 10000, deadline]) {
    f.time(t)
    noteDigProgress(f.board, f.foe.id, f.cell, 1)
    noteDigProgress(f.board, f.foe.id, f.cell, 0)
    f.price(remaining)
    assert.equal(f.attempt().deadline, deadline)
  }
  f.time(deadline + 1)
  noteDigProgress(f.board, f.foe.id, f.cell, 1)
  assert.ok(f.price(remaining) > 30)
})

test('without a block receipt, falling approach estimates retain the original hard deadline', () => {
  const f = fixture(), remaining = digSeconds(f.pick, f.site, 1)
  f.price(remaining + 1)
  const deadline = f.attempt().deadline
  for (const t of [2000, 4400, 7000, deadline]) {
    f.time(t); f.price(remaining)
    assert.ok(f.attempt().deadline <= deadline)
  }
  f.time(deadline + 1)
  assert.ok(f.price(remaining) > 30)
})

test('a successful top receipt does not erase a later explicit body refusal or its existing penalty window', () => {
  const f = fixture(), remaining = digSeconds(f.pick, f.site, 1)
  f.price(digSeconds(f.pick, f.site))
  f.time(4400); noteDigProgress(f.board, f.foe.id, f.cell, 1)
  f.time(4410); noteDigFailure(f.board, f.foe.id, f.cell)
  f.time(4500)
  assert.ok(f.price(remaining) > 30, 'direct_threat/allied_support refusal remains costly')
  assert.equal(f.attempt().failed, true)
  const costly = f.price(remaining)
  f.time(5500)
  assert.ok(f.price(remaining) < costly, 'the existing one-second-per-second penalty decay remains')
})
