'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const T = require('../src/telemetry')

test('resources: counters and best tools from inventory', () => {
  const r = T.resources({ raw_iron: 3, iron_ingot: 2, oak_log: 4, white_bed: 1, ender_pearl: 6, stone_pickaxe: 1, iron_pickaxe: 1, cobblestone: 20 })
  assert.equal(r.iron, 5)
  assert.equal(r.logs, 4)
  assert.equal(r.beds, 1)
  assert.equal(r.pearls, 6)
  assert.equal(r.pick, 'iron')
  assert.equal(r.cobble, 20)
})

test('delta: only changed counters, tool upgrades by name', () => {
  const a = { res: { iron: 2, pick: 'stone', logs: 4 } }
  const b = { res: { iron: 7, pick: 'iron', logs: 4, beds: 1 } }
  assert.deepEqual(T.delta(a, b), { iron: 5, pick: 'iron', beds: 1 })
})

test('outcome: done is ok, death and failure codes are not', () => {
  assert.equal(T.outcome({ status: 'done', detail: {} }).ok, true)
  assert.equal(T.outcome({ status: 'done', code: 'NO_PATH', detail: {} }).ok, false)
  const d = T.outcome({ status: 'interrupted', by: { type: 'death' }, detail: {} })
  assert.equal(d.ok, false)
  assert.equal(d.death, true)
  assert.match(T.outcome({ status: 'failed', detail: { stopped: 'лава у 1,2,3' } }).why, /лава/)
})

test('record: JSONL next to the campaign log; ND_TELEMETRY=0 disables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-tel-'))
  const prev = { log: process.env.ND_CAMPAIGN_LOG, off: process.env.ND_TELEMETRY, skills: process.env.ND_SKILLS_LOG }
  delete process.env.ND_SKILLS_LOG
  process.env.ND_CAMPAIGN_LOG = path.join(dir, 'slot-1-120000.campaign.log')
  try {
    assert.equal(T.file(), path.join(dir, 'slot-1-120000.skills.jsonl'))
    T.record({ level: 'act', skill: 'mine', ok: true })
    const rows = fs.readFileSync(T.file(), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].skill, 'mine')
    assert.ok(rows[0].ver && rows[0].ver.code)
    process.env.ND_TELEMETRY = '0'
    T.record({ level: 'act', skill: 'goto' })
    assert.equal(fs.readFileSync(T.file(), 'utf8').trim().split('\n').length, 1)
  } finally {
    if (prev.log === undefined) delete process.env.ND_CAMPAIGN_LOG; else process.env.ND_CAMPAIGN_LOG = prev.log
    if (prev.off === undefined) delete process.env.ND_TELEMETRY; else process.env.ND_TELEMETRY = prev.off
    if (prev.skills !== undefined) process.env.ND_SKILLS_LOG = prev.skills
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
