import test = require('node:test')
import assert = require('node:assert/strict')
import 'node:fs'
import * as fs from 'node:fs'
import { transpiledSource } from './source-fixture'

// Exercise the actual speedrun dispatch, including the second barter site.
test('speedrun gathers traders in its initial and retry pits; explicit booth/trap retain their executor', async () => {
  const text = transpiledSource(require.resolve('../src/bastion/bastion'))
  const start = text.indexOf('if (bo) {\n            st.pit =')
  const end = text.indexOf('} else {\n            st.lastBarter', start)
  assert.ok(start >= 0 && end > start)
  const run = new Function('bo', 'st', 'session', 'ctl', 'deadline', 'keep', 'done', 'penTrade', 'boothTrade',
    'log', 'countOf', 'gameClock', 'BF', 'moveBarterSite', 'digPit', 'mergeTrades', 'require',
    `const bot = session.bot; return (async () => { ${text.slice(start, end)} } })();`)
  for (const kind of ['pit', 'booth', 'trap']) {
    const bo = { kind, F: { x: 0, y: 98, z: 0 }, P: { x: 0, y: 98, z: 0 }, M: { x: 0, y: 100, z: 0 } }
    const st: any = { sealedState: {} }
    let pens = 0, booths = 0
    const receipt = () => ({ stopped: kind === 'pit' ? 'яма не работает' : 'цель', handed: 3, spent: 3 })
    await run(bo, st, { bot: {} }, { aborted: false }, 600000, 0, () => false,
      async () => { pens++; return receipt() }, async () => { booths++; return receipt() },
      () => {}, () => 64, { now: () => 0 }, { enabled: () => false }, async () => true,
      async () => ({ ...bo }), (a, b) => ({ ...b, spent: a.spent + b.spent }),
      () => ({ key: (x, y, z) => `${x},${y},${z}` }))
    assert.equal(pens, kind === 'pit' ? 3 : 0, `${kind}: containment executor`)
    assert.equal(booths, kind === 'pit' ? 0 : 1, `${kind}: booth executor`)
    assert.equal(st.pitTrade.spent, kind === 'pit' ? 9 : 3, 'receipt accounting survives retries')
  }
})

test('another speedrun barter batch resumes the existing pen before trying a new pit', async () => {
  // digPit живёт в bastion/barter-site.ts (рядом с bastion.ts — spec './pen-trap', './booth-trade' те же).
  const text = transpiledSource(require.resolve('../src/bastion/barter-site'))
  const start = text.indexOf('async function digPit(')
  const end = text.indexOf('const leftAnger =', start)
  assert.ok(start >= 0 && end > start)
  const plan = { ready: true, Bf: { x: -1, y: 98, z: 0 }, H: { x: 0, y: 99, z: 0 },
    lanes: [{ k: 0, T: { x: 1, y: 100, z: 0 } }] }
  let oldPits = 0
  const localRequire = name => name === './pen-trap' ? { penHere: () => plan }
    : name === './booth-trade' ? { currentPit: () => { oldPits++; return null } }
    : { exposure: () => [] }
  const run = new Function('require', 'log', text.slice(start, end) + '\n}\nreturn digPit;')(localRequire, () => {})
  const result = await run({ bot: {} }, { aborted: false }, { sealedState: { own: new Set() } }, 120000)
  assert.ok(result, 'keep the trapped traders rather than searching for another site')
  assert.equal(oldPits, 0)
  assert.equal(result.kind, 'pit')
  assert.deepEqual(result.F, plan.Bf)
  assert.deepEqual(result.O, plan.lanes[0].T)
})
