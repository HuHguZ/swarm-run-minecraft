'use strict'
// ND_SH_PICKS (sr27-end): без единой кирки штрек/ступени к комнате сперва делают каменные из рюкзака; с киркой и без флага — ничего.
import test = require('node:test')
import assert = require('node:assert/strict')

async function run (flag, items) {
  const T: any = require('../src/tunnel')
  const D: any = require('../src/endportal-descent')
  const saved = T.restockPicks; const env = process.env.ND_SH_PICKS
  const calls = []
  T.restockPicks = async (_s, _c, want) => { calls.push(want); return 2 }
  if (flag) process.env.ND_SH_PICKS = '1'; else delete process.env.ND_SH_PICKS
  try {
    await D.picksForDig({ bot: { inventory: { items: () => items.map(name => ({ name })) } } }, { aborted: false })
  } finally { T.restockPicks = saved; if (env === undefined) delete process.env.ND_SH_PICKS; else process.env.ND_SH_PICKS = env }
  return calls
}

test('no pickaxe at all: restock two stone picks before digging', async () => {
  assert.deepEqual(await run(true, ['cobblestone', 'stick']), [2])
})
test('only an iron pickaxe (kept for ore by the tool filter): still restock stone ones', async () => {
  assert.deepEqual(await run(true, ['iron_pickaxe', 'cobblestone']), [2])
})
test('a pickaxe in the bag, or the flag off: nothing to do', async () => {
  assert.deepEqual(await run(true, ['stone_pickaxe', 'cobblestone']), [])
  assert.deepEqual(await run(false, ['cobblestone', 'stick']), [])
})
