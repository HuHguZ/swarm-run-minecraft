'use strict'
import { cjsContext } from '../daemon/test/cjs-context'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as vm from 'node:vm'
import { createRequire } from 'node:module'

test('nice and slot priority include both farm fighters and exclude live/boundary ports', async () => {
  const cli = path.join(__dirname, 'farm.js'); const load = createRequire(cli)
  const entries = [[25630, 200], [8830, 201], [8930, 202], [8932, 203], [8765, 300], [8768, 301], [8900, 302], [8933, 303], [8800, 304], [8833, 305]]
  const priorities = []; const affinity = []
  const context = vm.createContext(cjsContext({ __dirname, __filename: cli, Buffer, setTimeout, clearTimeout,
    process: { argv: ['node', cli, 'nice'], env: {}, pid: 99 }, console: { log () {}, error: message => { throw new Error(message) } },
    require: name => name === './listeners' ? { listenerOwners: async ports => {
      assert.ok(ports.every(port => ![8765, 8768, 25565].includes(port)))
      return new Map(entries as [number, number][])
    } } : name === 'fs' ? { readFileSync: () => JSON.stringify({ maxUp: 4, cores: 'ccd1', prio: '30' }) }
      : name === 'os' ? { constants: { priority: { PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0 } }, setPriority: (pid, priority) => priorities.push([pid, priority]) }
      : name === 'child_process' ? { execFileSync: (exe, args) => {
        assert.equal(exe, 'powershell'); affinity.push(args.at(-1)); return ''
      } } : load(name)
  }))
  context.module = { exports: {} }
  context.require.main = context.module
  await vm.runInContext(fs.readFileSync(cli, 'utf8'), context)
  assert.deepEqual(priorities.filter(([, p]) => p === 10).map(([pid]) => pid), [99, 200, 201, 202, 203])
  assert.deepEqual(priorities.filter(([, p]) => p === 0).map(([pid]) => pid), [200, 201, 202])
  assert.equal(affinity.length, 5)
  assert.ok(affinity.every(command => command.includes('4294901760')))
})
