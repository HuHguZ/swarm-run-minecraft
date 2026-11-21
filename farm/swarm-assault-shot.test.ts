import test from 'node:test'
import assert from 'node:assert/strict'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTeam } from './swarm/swarm-driver/team'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmTurn } from './swarm/swarm-driver/turn'

const p = (x, y, z) => ({ x, y, z })
const armor = { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' }

// Solo match, 14:04. The archive shows an 11-voter assault and a 30s loot offer while
// the human is above the fighters. A usable bow on this particular fighter is a controlled input.
function replay(voters = 11) {
  let now = 1000, seconds = 30
  const calls: any[] = [], pos: any = {}
  const bots = Array.from({ length: 40 }, (_, i) => {
    const name = 'B' + String(i).padStart(2, '0')
    pos[name] = { p: p(i % 7 * 1.1, 120, Math.floor(i / 7) * 1.1), hp: 20, food: 20,
      inv: i < voters ? { iron_sword: 1, ...(i === 0 && { bow: 1, arrow: 32 }) } : { wind_charge: 2 }, armor: i < voters ? armor : {} }
    return { name, team: 'blue', c: { async call(method, args) { calls.push({ method, args }); return { status: 'done', detail: { shot: false } } } } }
  })
  const sw = createDriverState({ bots, pos, alive: () => true, arms: true, aggressive: true, now: () => now,
    humanNames: () => ['Visitor'], hostile: (_, id) => id === 'Visitor', arena: { x: 0, y: 120, z: 0, r: 80 }, home: () => p(0, 120, 0), log() {} })
  Object.assign(sw, swarmTeam(sw), swarmRetry(sw), swarmMoves(sw), { preempt() {}, chestAtHand: () => false,
    grab: async () => false, lootOffer: () => ({ position: p(-20, 120, -1), tier: 1, seconds }),
    detail: r => r.detail, say() {}, reactCamp: async () => false, cacheTurn: async () => false })
  const b = bots[0], driver = swarmTurn(sw)
  const observe = (i, x, y, weapon = 'iron_sword') => sw.observe(bots[i], x === null ? [] : [{
    id: 'Visitor', visible: true, position: p(x, y, 1), equipment: { weapon, armor: ['iron_chestplate'] }
  }], now)
  for (let i = 0; i < voters; i++) observe(i, 12, 120)
  const { board } = sw.refresh(b)
  assert.equal(board.assault?.voters.length ?? 0, voters === 11 ? voters : 0)
  const update = (mode = 'clear') => {
    now += 600
    const x = mode === 'moved' ? 19 : mode === 'distant' ? 45 : 17
    const weapon = mode === 'return fire' ? 'crossbow' : mode === 'smash' ? 'mace' : 'iron_sword'
    for (let i = 0; i < voters; i++) observe(i, i === 0 && mode === 'ally only' ? null : x, 138, weapon)
    if (mode === 'short loot') seconds = 2
    if (mode === 'no arrows') pos[b.name].attackArrows = 0
    if (mode === 'hurt') pos[b.name].hp = 3
    return sw.refresh(b).task
  }
  return { sw, b, calls, update, turn: () => driver.turn(b) }
}

test('a voting archer shoots from the arena floor before the 30s loot trip, and a failed arc frees it for loot', async () => {
  const f = replay(), task = f.update()
  assert.equal(task.kind, 'fight')
  assert.equal(task.data.target, 'Visitor')
  assert.deepEqual(task.position, p(0, 120, 0))
  const duties = [...f.sw.planned.get('blue').values()]
  assert.equal(duties.length, 40)
  assert.equal(duties.filter(t => t.data?.stablePost).length, 1)
  await f.turn()
  assert.deepEqual(f.calls.map(c => c.method), ['shoot'])
  assert.deepEqual(f.calls[0].args.fromPost, task.position)
  assert.equal(f.calls[0].args.stablePost, true)
  assert.equal(f.update().kind, 'loot')
  assert.ok(f.update('moved').data.stablePost)
})

test('unseen target, unusable ammunition, return fire, injury or a nearby upgrade do not claim the shot', () => {
  for (const mode of ['ally only', 'no arrows', 'return fire', 'smash', 'hurt', 'short loot', 'distant']) {
    assert.ok(!replay().update(mode).data.perchShot, mode)
  }
  assert.ok(!replay(1).update().data.perchShot, 'single unconfirmed contact')
})
