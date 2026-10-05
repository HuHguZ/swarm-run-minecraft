'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
function fixture ({ pos = { x: -73, y: 114, z: 152 }, dimension = 'the_nether', obsidian = 17, lighter = true, flag = '1', pending = false } = {}) {
  const src = fs.readFileSync(path.join(__dirname, '../campaign.js'), 'utf8')
  const a = src.indexOf('let shNetherTries = 0')
  const b = src.indexOf('// Не начинаем длинную дорогу', a)
  const c = { state: { pos }, known: { stronghold: { x: -585, z: 1274 } }, process: { env: { ND_EXIT_LOCAL_RETRY: flag } },
    Math, dim: () => dimension, lighter: () => lighter, have: item => item === 'obsidian' ? obsidian : 0,
    PICK_DIAMOND: /diamond_pickaxe/, pendingExitFrame: () => pending }
  vm.runInNewContext(src.slice(a, b) + '\nthis.allowed = canLink; this.used = () => { shNetherTries++ }', c)
  return c
}
test('col04e N2bx23: the third stage can resume at the exit after two failed calls', () => {
  const f = fixture(); assert.equal(f.allowed(), true); f.used(); f.used()
  assert.equal(f.allowed(), true, 'local frame work remains reachable by the campaign')
})
test('a distant Nether journey retains its two-stage cap', () => {
  const f = fixture({ pos: { x: -125, y: 73, z: -219 } }); f.used(); f.used()
  assert.equal(f.allowed(), false)
})
test('local retries do not waive obsidian or ignition', () => {
  for (const opts of [{ obsidian: 0 }, { lighter: false }]) {
    const f = fixture(opts); f.used(); f.used(); assert.equal(f.allowed(), false)
  }
})
test('an Overworld position does not reopen a distant Nether journey', () => {
  const f = fixture({ dimension: 'overworld' }); f.used(); f.used(); assert.equal(f.allowed(), false)
})
test('a partly built exit frame retains the existing resume contract', () => {
  const f = fixture({ pending: true, obsidian: 0 }); f.used(); f.used(); assert.equal(f.allowed(), true)
})
test('ND_EXIT_LOCAL_RETRY=0 keeps the original cap at the local target', () => {
  const f = fixture({ flag: '0' }); f.used(); f.used(); assert.equal(f.allowed(), false)
})
