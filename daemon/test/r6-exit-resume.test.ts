'use strict'
import { cjsContext } from './cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as vm from 'node:vm'
import 'node:fs'
import * as fs from 'node:fs'
import path = require('node:path')
function fixture ({ pos = { x: -73, y: 114, z: 152 }, dimension = 'the_nether', obsidian = 17, lighter = true, flag = '1', pending = false }: any = {} as Record<string, any>) {
  const { declarationSource }: typeof import('./source-fixture') = require('./source-fixture')
  const entry = path.join(__dirname, '../campaign.js')
  const src = ['shNetherTries', 'atExitTarget', 'canLink'].map(name => declarationSource(entry, name)).join('\n')
  const c = { state: { pos }, known: { stronghold: { x: -585, z: 1274 } }, process: { env: { ND_EXIT_LOCAL_RETRY: flag } },
    Math, dim: () => dimension, lighter: () => lighter, have: item => item === 'obsidian' ? obsidian : 0,
    PICK_DIAMOND: /diamond_pickaxe/, pendingExitFrame: () => pending }
  vm.runInNewContext(src + '\nthis.allowed = canLink; this.used = () => { shNetherTries++ }', cjsContext(c))
  return c
}
test('col04e N2bx23: the third stage can resume at the exit after two failed calls', () => {
  const f: any = fixture(); assert.equal(f.allowed(), true); f.used(); f.used()
  assert.equal(f.allowed(), true, 'local frame work remains reachable by the campaign')
})
test('a distant Nether journey retains its two-stage cap', () => {
  const f: any = fixture({ pos: { x: -125, y: 73, z: -219 } }); f.used(); f.used()
  assert.equal(f.allowed(), false)
})
test('local retries do not waive obsidian or ignition', () => {
  for (const opts of [{ obsidian: 0 }, { lighter: false }]) {
    const f: any = fixture(opts); f.used(); f.used(); assert.equal(f.allowed(), false)
  }
})
test('an Overworld position does not reopen a distant Nether journey', () => {
  const f: any = fixture({ dimension: 'overworld' }); f.used(); f.used(); assert.equal(f.allowed(), false)
})
test('a partly built exit frame retains the existing resume contract', () => {
  const f: any = fixture({ pending: true, obsidian: 0 }); f.used(); f.used(); assert.equal(f.allowed(), true)
})
test('ND_EXIT_LOCAL_RETRY=0 keeps the original cap at the local target', () => {
  const f: any = fixture({ flag: '0' }); f.used(); f.used(); assert.equal(f.allowed(), false)
})
