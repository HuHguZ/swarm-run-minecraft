import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import childProcess from 'node:child_process'
import { acceleratedDigArgs } from './accelerated-dig'
import { REPO_ROOT } from '../daemon/src/paths'

test('native acceleration rejects main/live/outside directories before invoking Java or reading jars', () => {
  for (const target of ['../server-run', '../server', '../daemon-live', '../server-31', 'server-0', 'server-33']) {
    assert.throws(() => acceleratedDigArgs('must-not-launch', path.resolve(REPO_ROOT, 'farm', target)), /restricted to farm/)
    assert.throws(() => acceleratedDigArgs('must-not-launch', path.resolve(REPO_ROOT, 'farm', target), { ND_FARM_TIME_EVERY_TICK: '1' }), /restricted to farm/)
  }
})

test('time packet PoC still rejects an unverified native jar before Java', t => {
  t.mock.method(fs, 'readFileSync', () => Buffer.from('unverified native jar'))
  t.mock.method(childProcess, 'execFileSync', () => assert.fail('must not invoke Java'))
  assert.throws(() => acceleratedDigArgs('must-not-launch', path.resolve(REPO_ROOT, 'farm/server-31'), { ND_FARM_TIME_EVERY_TICK: '1' }), /verified Paper/)
})

const native = path.resolve(REPO_ROOT, 'farm/server-31/versions/1.21.11/paper-1.21.11.jar')
test('only explicit farm flag enables cadence and cached agent is never overwritten', { skip: !fs.existsSync(native) }, t => {
  const exists = fs.existsSync.bind(fs)
  t.mock.method(fs, 'existsSync', file => String(file).endsWith('farm-dig-clock.jar') || exists(file))
  t.mock.method(fs, 'writeFileSync', () => assert.fail('must not overwrite cached files'))
  t.mock.method(childProcess, 'execFileSync', () => assert.fail('must not invoke Java for cached agent'))
  const server = path.resolve(REPO_ROOT, 'farm/server-31')
  const ordinary = acceleratedDigArgs('must-not-launch', server, {})
  assert.equal(ordinary.length, 1)
  assert.match(ordinary[0], /farm-dig-clock\.jar$/)
  assert.deepEqual(acceleratedDigArgs('must-not-launch', server, { ND_FARM_TIME_EVERY_TICK: '0' }), ordinary)
  assert.deepEqual(acceleratedDigArgs('must-not-launch', server, { ND_FARM_TIME_EVERY_TICK: '1' }), [`${ordinary[0]}=time-every-tick`])
})

test('lockstep is an explicit farm flag with a bounded window and stall valve', { skip: !fs.existsSync(native) }, t => {
  const exists = fs.existsSync.bind(fs)
  t.mock.method(fs, 'existsSync', file => String(file).endsWith('farm-dig-clock.jar') || exists(file))
  t.mock.method(childProcess, 'execFileSync', () => assert.fail('must not invoke Java for cached agent'))
  const server = path.resolve(REPO_ROOT, 'farm/server-31')
  const [ordinary] = acceleratedDigArgs('must-not-launch', server, {})
  assert.deepEqual(acceleratedDigArgs('must-not-launch', server, { ND_LOCKSTEP: '0', ND_FARM_TIME_EVERY_TICK: '1' }), [`${ordinary}=time-every-tick`])
  assert.deepEqual(acceleratedDigArgs('must-not-launch', server, { ND_LOCKSTEP: '1' }), [`${ordinary}=lockstep:2:30000`])
  assert.deepEqual(acceleratedDigArgs('must-not-launch', server, { ND_LOCKSTEP: '1', ND_LOCKSTEP_WINDOW: '1', ND_LOCKSTEP_STALL_MS: '500' }), [`${ordinary}=lockstep:1:500`])
  assert.throws(() => acceleratedDigArgs('must-not-launch', server, { ND_LOCKSTEP: '1', ND_LOCKSTEP_WINDOW: '0' }), /1\.\.20/)
  assert.throws(() => acceleratedDigArgs('must-not-launch', server, { ND_LOCKSTEP: '1', ND_LOCKSTEP_STALL_MS: '10' }), /50\.\.60000/)
})
