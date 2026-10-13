'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

function kit (env) {
  const source = fs.readFileSync(require.resolve('../try-dragon'), 'utf8')
  const start = source.indexOf('function e2eKit(')
  const end = source.indexOf('function deathCause(', start)
  assert.ok(start > 0 && end > start)
  return vm.runInNewContext(source.slice(start, end) + '\ne2eKit()', { process: { env } })
}

test('iron End fixture can carry campaign station obsidian without enchantments', () => {
  const out = kit({ E2E_KIT: 'iron', E2E_OBSIDIAN: '4', E2E_CRYING: '2', E2E_GAPPLES: '2' })
  assert.ok(out.includes('obsidian 4'))
  assert.ok(out.includes('crying_obsidian 2'))
  assert.ok(out.includes('iron_chestplate'))
  assert.ok(out.includes('golden_apple 2'))
  assert.ok(out.every(item => !/diamond|enchantments/.test(item)))
})

test('iron End fixture keeps its default inventory without added station blocks', () => {
  const out = kit({ E2E_KIT: 'iron' })
  assert.equal(out.filter(item => /obsidian/.test(item)).length, 0)
  assert.equal(out.filter(item => item === 'cobblestone 64').length, 3)
})

test('campaign2 End fixture still adds its existing station blocks once', () => {
  const out = kit({ E2E_KIT: 'campaign2', E2E_OBSIDIAN: '4', E2E_CRYING: '2' })
  assert.equal(out.filter(item => item === 'obsidian 4').length, 1)
  assert.equal(out.filter(item => item === 'crying_obsidian 2').length, 1)
})
