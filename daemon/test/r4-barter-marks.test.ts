'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { markPearls } = require('../src/barter-marks')
test('first ten pearls timestamp persists after spending pearls or later samples', () => {
  const marks: Record<string, any> = {} as Record<string, any>; markPearls(marks, { ender_pearl: 9 }, 60)
  assert.equal(marks.pearls10, undefined)
  markPearls(marks, { ender_pearl: 10 }, 719); markPearls(marks, { ender_pearl: 0 }, 730)
  assert.equal(marks.pearls10, 719 / 60)
})
test('a sample after the 12-minute deadline cannot count as a timely success', () => {
  const marks = markPearls({} as Record<string, any>, { ender_eye: 4, ender_pearl: 6 }, 721)
  assert(marks.pearls10 > 12)
})
