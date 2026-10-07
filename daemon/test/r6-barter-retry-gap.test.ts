'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const flow = require('../src/barter-flow')
const vm = require('node:vm')
const { clockFixture } = require('./clock-fixture')
const fs = require('node:fs')
const path = require('node:path')
const stock = { gold_ingot: 10, gold_block: 5, ender_pearl: 13, obsidian: 7 }
for (const stopped of ['бартер встал: пиглинов рядом нет', 'бартер встал: пиглины рядом есть, но ни до одного не дойти (стены, другой этаж)']) {
  test(`col04e N2bx22: preserved gold permits recovery from ${stopped}`, () => {
    assert.equal(flow.retry({ ingotsTraded: 0, stopped }, stock), true)
  })
}
test('a completed trade and a true gold shortage do not trigger this retry', () => {
  const stopped = 'бартер встал: пиглинов рядом нет'
  assert.equal(flow.retry({ ingotsTraded: 1, stopped }, stock), false)
  assert.equal(flow.retry({ ingotsTraded: 0, stopped }, { gold_ingot: 17 }), false)
})
test('unrelated failures and a missing reason retain normal stage backoff', () => {
  assert.equal(flow.retry({ ingotsTraded: 0, stopped: 'умер' }, stock), false)
  assert.equal(flow.retry({ ingotsTraded: 0 }, stock), false)
})
test('the campaign clears its dry gate when the saved 55 ingots can fund another trader search', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../campaign.js'), 'utf8')
  const a = src.indexOf('    if (barterFlow.enabled() && barterFlow.retry(d, state.inventory || {}))')
  const b = src.indexOf('    if (d.need && d.need.what', a)
  const c: Record<string, any> = { barterFlow: { enabled: () => true, retry: flow.retry },
    d: { ingotsTraded: 0, stopped: 'бартер встал: пиглинов рядом нет' },
    state: { inventory: stock }, b: { key: 'бастион (ад)' }, bs: { dry: 2 }, approached: false,
    bastionDry: 2, barterRetryPending: false, Date, log () {} }
  c.gameClock = clockFixture(c)
  await vm.runInNewContext('(async () => { for (let i = 0; i < 1; i++) {\n' + src.slice(a, b) + '\n} })()', c)
  assert.equal(c.bastionDry, 0); assert.equal(c.bs.dry, 0)
  assert.equal(c.barterRetryPending, true)
})
test('ND_BARTER_RETRY_GAP=0 keeps old classification without disabling explicit retries', t => {
  const before = process.env.ND_BARTER_RETRY_GAP; process.env.ND_BARTER_RETRY_GAP = '0'
  t.after(() => { if (before === undefined) delete process.env.ND_BARTER_RETRY_GAP; else process.env.ND_BARTER_RETRY_GAP = before })
  assert.equal(flow.retry({ ingotsTraded: 0, stopped: 'бартер встал: пиглинов рядом нет' }, stock), false)
  assert.equal(flow.retry({ ingotsTraded: 0, barterRetry: 'другой этаж' }, stock), true)
})
