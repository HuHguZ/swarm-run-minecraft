// ND_BAST_BRUTE_EXIT (поток bast 27.10): закрытый выход, сдвинувший тело, — переоценка выхода (до 3 раз), а не BRUTE_MEMORY_REPLAN.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bruteExitAgain } from '../src/session/goto'

test('bruteExitAgain: hold — всегда ждать; covered со сдвигом — до 3 переоценок только с флагом', () => {
  const prev = process.env.ND_BAST_BRUTE_EXIT
  try {
    delete process.env.ND_BAST_BRUTE_EXIT
    assert.equal(bruteExitAgain({ mode: 'hold' }, { n: 0 }), true)
    assert.equal(bruteExitAgain({ mode: 'covered', moved: 5 }, { n: 0 }), false, 'без флага — прежний REPLAN')
    process.env.ND_BAST_BRUTE_EXIT = '1'
    const moves = { n: 0 }
    assert.deepEqual([1, 2, 3, 4].map(() => bruteExitAgain({ mode: 'covered', moved: 5 }, moves)), [true, true, true, false])
    assert.equal(bruteExitAgain({ mode: 'covered', moved: 0 }, { n: 0 }), false, 'не сдвинулся — REPLAN')
    assert.equal(bruteExitAgain(undefined, { n: 0 }), false)
  } finally { if (prev === undefined) delete process.env.ND_BAST_BRUTE_EXIT; else process.env.ND_BAST_BRUTE_EXIT = prev }
})
