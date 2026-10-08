'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

test('nice and slot priority include both farm fighters and exclude live/boundary ports', async () => {
  const cli = path.join(__dirname, 'farm.js'); const load = createRequire(cli)
  const entries = [[25630, 200], [8830, 201], [8930, 202], [8932, 203], [8765, 300], [8768, 301], [8900, 302], [8933, 303], [8800, 304], [8833, 305]]
  const priorities = []; const affinity = []
  const context = vm.createContext({ __dirname, __filename: cli, Buffer, setTimeout, clearTimeout,
    process: { argv: ['node', cli, 'nice'], env: {}, pid: 99 }, console: { log () {}, error: message => { throw new Error(message) } },
    require: name => name === 'fs' ? { readFileSync: () => JSON.stringify({ maxUp: 4, cores: 'ccd1', prio: '30' }) }
      : name === 'os' ? { constants: { priority: { PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0 } }, setPriority: (pid, priority) => priorities.push([pid, priority]) }
      : name === 'child_process' ? { execFileSync: (exe, args) => {
        if (exe === 'netstat') return entries.map(([port, pid]) => `TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING ${pid}`).join('\n')
        assert.equal(exe, 'powershell'); affinity.push(args.at(-1)); return ''
      } } : load(name)
  })
  context.module = { exports: {} }
  context.require.main = context.module
  vm.runInContext(fs.readFileSync(cli, 'utf8'), context)
  await Promise.resolve()
  assert.deepEqual(priorities.filter(([, p]) => p === 10).map(([pid]) => pid), [99, 200, 201, 202, 203])
  assert.deepEqual(priorities.filter(([, p]) => p === 0).map(([pid]) => pid), [200, 201, 202])
  assert.equal(affinity.length, 5)
  assert.ok(affinity.every(command => command.includes('4294901760')))
})
