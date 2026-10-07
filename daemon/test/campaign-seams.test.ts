'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { load, ready } = require('./campaign-seams-fixture')

test('mapped portal with seven empty frames still requires a dragon kit', () => {
  const c = load(ready({ red_bed: 1, ender_eye: 7, blaze_powder: 1 }), undefined, { ND_EYES_NEED: '7' })
  c.known.portal = { x: 0, y: 60, z: 0 }
  c.known.stronghold = { x: 0, z: 0 }
  assert.equal(c.needed('endkit'), true, 'converted rods are not a kit prerequisite')
})

test('remembered End room does not bypass missing resources on resume', () => {
  const c = load(ready({ red_bed: 1 }))
  c.known.endPortal = { x: 0, y: 60, z: 0 }
  assert.equal(c.needed('endkit'), true)
})

test('stronghold checkpoint preserves five combat beds', async () => {
  const state = ready({ ender_eye: 12 })
  const c = load(state, (method, p) => {
    if (method === 'sleep' && p.mode === 'spawn') state.inventory.red_bed--
    return method === 'stronghold' && p.mode === 'room' ? { room: { x: 0, y: 60, z: 0 } } : {} as Record<string, any>
  })
  c.known.stronghold = { x: 0, y: 60, z: 0 }
  await c.run('stronghold')
  assert.equal(state.inventory.red_bed, 5)
  assert.equal(c.calls.some(x => x.method === 'sleep' && x.params.mode === 'spawn'), false)
})

test('End portal checkpoint preserves five combat beds', async () => {
  const state = ready()
  const c = load(state, (method, p) => {
    if (method === 'sleep' && p.mode === 'spawn') state.inventory.red_bed--
    if (method === 'stronghold' && p.mode === 'fill') { state.dimension = 'the_end'; return { entered: true } }
    return method === 'dragon' ? { dragon: { won: true } } : {} as Record<string, any>
  })
  c.known.endPortal = { x: 0, y: 60, z: 0 }
  await c.run('dragon')
  assert.equal(state.inventory.red_bed, 5)
})

test('three failed collection passes never authorize an under-equipped End entry', async () => {
  const state = ready({ red_bed: 2 })
  const c = load(state, (method, p) => {
    if (method === 'stronghold' && p.mode === 'fill') { state.dimension = 'the_end'; return { entered: true } }
    return method === 'dragon' ? { dragon: { won: true } } : {} as Record<string, any>
  })
  c.known.endPortal = { x: 0, y: 60, z: 0 }; c.runs(3)
  await assert.rejects(c.run('dragon'), e => e.stopCampaign && /END_SEAM_NOT_READY.*beds/.test(e.message))
  assert.equal(c.calls.some(x => x.method === 'stronghold' && x.params.mode === 'fill'), false)
})

test('station obsidian and blocks are checked after kit RPC, before fill', async () => {
  const state = ready()
  const c = load(state, method => {
    if (method === 'kit') { state.inventory.obsidian = 2; state.inventory.cobblestone = 62 }
    return method === 'dragon' ? { dragon: { won: true } } : {} as Record<string, any>
  })
  c.known.endPortal = { x: 0, y: 60, z: 0 }
  await assert.rejects(c.run('dragon'), /END_SEAM_NOT_READY.*obsidian.*blocks/)
  assert.equal(c.calls.some(x => x.method === 'stronghold' && x.params.mode === 'fill'), false)
})

test('body below regeneration hunger is fed before End entry', async () => {
  const state = ready(); state.food = 14
  const c = load(state, (method, p) => {
    if (method === 'eat') { state.food = 20; state.inventory.cooked_beef-- }
    if (method === 'stronghold' && p.mode === 'fill') { state.dimension = 'the_end'; return { entered: true } }
    return method === 'dragon' ? { dragon: { won: true } } : {} as Record<string, any>
  })
  state.inventory.cooked_beef = 9
  c.known.endPortal = { x: 0, y: 60, z: 0 }
  await c.run('dragon')
  assert.equal(state.food, 20)
  assert.ok(c.calls.findIndex(x => x.method === 'eat') < c.calls.findIndex(x => x.method === 'stronghold' && x.params.mode === 'fill'))
})

test('Nether leg can exit near mapped stronghold before Overworld collection', () => {
  const state = ready({ red_bed: 1, ender_eye: 12 }); state.dimension = 'the_nether'
  const c = load(state); c.known.stronghold = { x: 2000, z: 0 }
  assert.equal(c.needed('stronghold'), true)
})

test('explicit laboratory endkit disable preserves the stage-only experiment', () => {
  const c = load(ready({ red_bed: 1, ender_eye: 12 }), undefined, { ND_ENDKIT: '0' })
  assert.equal(c.needed('endkit'), false)
})

test('ND_END_SEAM=0 preserves legacy collection selection', () => {
  const c = load(ready({ red_bed: 1, ender_eye: 7, blaze_powder: 1 }), undefined, { ND_END_SEAM: '0', ND_EYES_NEED: '7' })
  assert.equal(c.needed('endkit'), false)
})


// S5d (07.10): сытость 17/18, еда есть, а укус оборвала тактика — вход в Энд с отметкой риска, а не БЛОКЕР (s5d-N-5).
test('hunger one point short with food in the pack is a priced risk, not an End blocker', async () => {
  const state = ready(); state.food = 17
  const c = load(state, (method, p) => {
    if (method === 'stronghold' && p.mode === 'fill') { state.dimension = 'the_end'; return { entered: true } }
    return method === 'dragon' ? { dragon: { won: true } } : {} as Record<string, any>
  })
  c.known.endPortal = { x: 0, y: 60, z: 0 }
  await c.run('dragon')
  assert.equal(c.calls.filter(x => x.method === 'eat').length >= 2, true, 'еда — несколько заходов')
  assert.equal(c.calls.some(x => x.method === 'stronghold' && x.params.mode === 'fill'), true)
})
