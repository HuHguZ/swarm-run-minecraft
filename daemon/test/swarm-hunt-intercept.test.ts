import test from 'node:test'
import assert from 'node:assert/strict'
import { planPvp } from '../src/swarm'
import type { PvpOptions } from '../src/swarm/plan-frame'
import { swarmTeam } from '../../farm/swarm/swarm-driver/team'

const point = (x: number) => ({ x, y: 64, z: 0 })
const netherite = ['helmet', 'chestplate', 'leggings', 'boots'].map(slot => 'netherite_' + slot)

function hunt(loadout: any, heavyGap = 7, preyGap: number | null = 22) {
  let now = 1000
  const bots = ['Hunter', 'B', 'C', 'D', 'E'].map(name => ({ name, team: 'blue' }))
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, { p: point(i ? -25 - i : 0), hp: 20,
    inv: { stone_sword: 1 }, armor: {}, ...(i ? {} : loadout) }]))
  const team = swarmTeam({ bots, pos, alive: () => true, now: () => now, boards: new Map(), blueprints: new Map() })
  const board = team.boardOf(bots[0])
  board.setMembers(team.membersOf(bots[0]))
  const armored = (x = heavyGap, vx = -.26, hpEstimate?: number) => board.observe('Hunter', now, { id: 'Heavy', visible: true, position: point(x),
    velocity: { x: vx, y: 0, z: 0 }, equipment: { weapon: 'netherite_sword', armor: netherite, enchanted: true }, hpEstimate })
  const wounded = () => board.observe('Hunter', now, { id: 'Prey', visible: true, position: point(preyGap!),
    equipment: { weapon: 'wooden_sword', armor: [] }, hpEstimate: 6 })
  armored()
  if (preyGap !== null) wounded()
  const plan = (options: PvpOptions = {}) => planPvp(board, team.membersOf(bots[0]), { aggressive: true, quorum: 3, doctrine: 'hunt',
    foesLeft: 10, hideouts: [point(-20)], ...options }).get('Hunter')!
  return { plan, pos, armored, wounded, advance: ms => { now += ms } }
}

test('a losing swordsman abandons a distant finish before a visible armored pursuer can intercept', () => {
  const f = hunt({})
  const task = f.plan()
  assert.equal(task.kind, 'flee')
  assert.equal(task.data?.target, 'Heavy')
  f.advance(9000); f.wounded()
  assert.equal(f.plan().data?.target, 'Prey', 'fresh vulnerable opponent after the stronger contact expires')
  f.advance(9000)
  assert.equal(f.plan().kind, 'loot', 'with no contact the unequipped fighter improves its kit')
  const close = hunt({}, 10, 2)
  assert.equal(close.plan().data?.target, 'Prey', 'a finish already in sword reach remains viable')
  assert.equal(hunt({}).plan({ travelSeconds: () => .5 }).data?.target, 'Prey', 'a faster traversable route lets the swordsman finish')
  assert.equal(hunt({}).plan({ travelSeconds: () => NaN }).kind, 'flee', 'an unknown route cannot beat the pursuer')
  assert.equal(hunt({}, 7, 8).plan({ travelSeconds: () => 12 }).kind, 'flee', 'a close target still needs a long detour')
})

test('the isolated, unequipped fighter escapes the last charging champion and resumes after rearming', () => {
  for (const aggressive of [false, true]) {
    const f = hunt({ inv: {} }, 7, null)
    const options = { foesLeft: 1, aggressive, lootOffer: () => ({ tier: 3, seconds: 3, position: point(-16) }) }
    const task = f.plan(options)
    assert.equal(task.kind, 'flee', 'the four distant teammates cannot help before the champion hits')
    assert.equal(task.data?.target, 'Heavy')
    assert.ok(task.data?.kite || task.data?.regroup || task.data?.hide)
    f.advance(1000); f.armored(32, 0)
    assert.equal(f.plan(options).kind, 'loot', 'enough separation to reach the actual supply offer')
    Object.assign(f.pos.Hunter, { inv: { netherite_sword: 1 }, armor: Object.fromEntries(['head', 'torso', 'legs', 'feet'].map((s, i) => [s, netherite[i]])) })
    f.advance(1000); f.armored()
    const armed = f.plan(options)
    assert.equal(armed.kind, 'fight', 'the same fighter returns with a real weapon and armor')
    assert.equal(armed.data?.target, 'Heavy')
  }
  const finish = hunt({ inv: { diamond_axe: 1 } }, 2, null)
  finish.armored(2, -.26, .25)
  assert.equal(finish.plan({ foesLeft: 1 }).kind, 'fight', 'a live target in reach that the next hit can finish')
})

for (const [name, loadout, viable] of [
  ['empty bow', { inv: { bow: 1 } }, false],
  ['empty crossbow', { inv: { crossbow: 1 } }, false],
  ['healing arrow', { inv: { bow: 1, tipped_arrow: 1 }, attackArrows: 0 }, false],
  ['ordinary arrow', { inv: { bow: 1, arrow: 1 } }, true],
  ['spectral arrow', { inv: { bow: 1, spectral_arrow: 1 } }, true],
  ['harmful tipped arrow', { inv: { bow: 1, tipped_arrow: 1 }, attackArrows: 1 }, true],
  ['loaded crossbow', { inv: { crossbow: 1 }, loadedCrossbow: true, attackArrows: 0 }, true],
  ['loaded offhand crossbow', { inv: {}, offHand: { item: 'crossbow' }, loadedCrossbow: true, attackArrows: 0 }, true],
] as const) test(`a hunter compares an offensive shot with interception: ${name}`, () => {
  const task = hunt(loadout, 10).plan()
  assert.equal(task.kind, viable ? 'fight' : 'flee')
  assert.equal(task.data?.target, viable ? 'Prey' : 'Heavy')
})
