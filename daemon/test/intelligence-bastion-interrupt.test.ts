import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'

function watched(lava = { present: false, escaped: 0 }) {
  const source = fs.readFileSync(require.resolve('../src/bastion/booth-trade'), 'utf8')
  const body = source.slice(source.indexOf('async function lavaWatched'), source.indexOf('async function barterRound'))
  return new Function('gameClock', 'inLava', 'lavaEscape', 'lavaEscapeDeep', 'log', body + '\nreturn lavaWatched')(
    { setInterval, clearInterval }, () => lava.present, async () => { lava.present = false; lava.escaped++ }, async () => {}, () => {})
}

test('Bastion route subcontroller waits for the actual parent tactical lease', async () => {
  let release: () => void
  const lease = new Promise<void>(resolve => { release = resolve })
  const ctl = { aborted: false, onAbort: [] as Array<() => void>, waitReflex: () => lease }
  let continued = false
  const pending = watched()({}, ctl, async sub => { await sub.waitReflex(); continued = true; return { ok: true } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(continued, false)
  release!()
  assert.deepEqual(await pending, { ok: true })
  assert.equal(ctl.onAbort.length, 0)
})

test('local lava cancellation keeps the live parent and completes the existing lava recovery', async () => {
  const lava = { present: true, escaped: 0 }
  const ctl = { aborted: false, onAbort: [] as Array<() => void>, async waitReflex() {} }
  const bot = { health: 20, pathfinder: { setGoal() {} }, clearControlStates() {} }
  const result = await watched(lava)(bot, ctl, async sub => {
    sub.aborted = true
    await sub.waitReflex()
    return { ok: true }
  })
  assert.equal(lava.escaped, 1)
  assert.equal(ctl.aborted, false)
  assert.equal(result.ok, false)
  assert.equal(result.why, 'лава у ног')
})

test('aborted tactical parent prevents the wrapped route from resuming and detaches callbacks', async () => {
  let release: () => void
  const lease = new Promise<void>(resolve => { release = resolve })
  const ctl = { aborted: false, onAbort: [] as Array<() => void>, async waitReflex() {
    await lease
    if (this.aborted) throw Object.assign(new Error('reflex: действие прервано'), { code: 'REFLEX_CANCELLED' })
  } }
  let resumed = false
  const pending = watched()({}, ctl, async sub => { await sub.waitReflex(); resumed = true })
  ctl.aborted = true
  for (const callback of [...ctl.onAbort]) callback()
  release!()
  await assert.rejects(pending, { code: 'REFLEX_CANCELLED' })
  assert.equal(resumed, false)
  assert.equal(ctl.onAbort.length, 0)
})
