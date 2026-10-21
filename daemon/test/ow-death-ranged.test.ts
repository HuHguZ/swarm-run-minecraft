import test from 'node:test'
import assert from 'node:assert/strict'
import { candidates, type TacticalState } from '../src/tactics/state'
import { TacticalArbiter } from '../src/tactics/arbiter'
import { observeTactics, TacticalSystem } from '../src/tactics/minecraft'
import { createWorld, stepWorld } from '../src/tactics/sim-world'
import { mineflayerFacade } from '../src/tactics/sim-mineflayer'
import * as hold from '../src/survival/hold-out'

const flagged = async (value: string, fn: () => unknown) => {
  const old = process.env.ND_OW_DEATH_RANGED
  process.env.ND_OW_DEATH_RANGED = value
  try { await fn() } finally {
    if (old === undefined) delete process.env.ND_OW_DEATH_RANGED
    else process.env.ND_OW_DEATH_RANGED = old
  }
}
const state = (extra: Partial<TacticalState> = {}): TacticalState => ({ at: 0, health: 20, food: 12, armor: 0,
  weapon: true, shield: false, enemies: [{ id: 2, kind: 'skeleton', distance: 14, threatening: true, player: false, hit: 4 }],
  incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false,
  dangerousFall: false, emergencyController: false, inWater: false, cover: false, portal: false,
  escapeRoute: true, blocks: 64, water: false, edible: false, canFight: true, contact: true,
  shelter: 'BlockOff', protectedEncounter: false, buildCostHp: 4, ...extra })
const site = (extra: any = {}) => ({ nearest: { name: 'skeleton', d: 6.6, etaMs: 1600 },
  cell: { blocks: 8, roofSolid: false, leans: true, dist: 0 },
  owRanged: { health: 14, meleeEtaMs: Infinity, shots: [{ hit: 4, everyMs: 2000 }] }, ...extra })

test('OW archer: a payable short roof is not replaced by a longer exposed run', () => {
  const a = site()
  assert.ok(hold.buildMsOf(a, 'box') > a.nearest.etaMs, 'reproduces old melee ETA trigger')
  assert.equal(hold.outrun(a, 'box'), false)
  assert.equal(hold.outrun({ ...a, owRanged: undefined }, 'box'), true, 'legacy snapshot unchanged')
})

test('OW archer: construction remains priced against lethal exposure and an arriving zombie', () => {
  assert.equal(hold.outrun(site({ owRanged: { health: 4, meleeEtaMs: Infinity, shots: [{ hit: 4, everyMs: 2000 }] } }), 'box'), true)
  assert.equal(hold.outrun(site({ owRanged: { health: 20, meleeEtaMs: 500, shots: [{ hit: 4, everyMs: 2000 }] } }), 'box'), true)
  const long = site({ cell: { blocks: 20, roofSolid: false, leans: true, dist: 8 } })
  assert.equal(hold.outrun(long, 'box'), true, 'a costly distant box still buys a run')
})

test('OW archer: the nearer fight and the cheaper roof both remain candidates', () => {
  const s = { ...state(), owRangedApproachHp: 8 } as TacticalState
  const choices = candidates(s)
  assert.equal(choices[0]?.id, 'BlockOff')
  assert.ok(choices.some(c => c.id === 'Fight'), 'risk prices the approach; it does not forbid it')
  assert.equal(candidates({ ...s, buildCostHp: 16 })[0]?.id, 'Fight', 'an expensive box loses to the approach')
  assert.equal(candidates(state())[0]?.id, 'Fight', 'flag-off state keeps the original ranking')
  assert.equal(candidates({ ...s, shelter: null, blocks: 0 })[0]?.id, 'Fight', 'no blocks does not mean standing idle')
})

test('OW archer: actual observation is flag gated, early, visible, unshielded and overworld only', async () => {
  await flagged('0', () => {
    const w = createWorld({ name: 'ow-ranged-off', events: [{ at: 1, type: 'enemy', kind: 'skeleton', distance: 12 }] })
    stepWorld(w)
    const session: any = {}, facade = mineflayerFacade(w, session)
    session.bot = facade.bot; facade.sync()
    assert.equal((observeTactics(session)! as any).owRangedApproachHp, undefined)
  })
  await flagged('1', () => {
    for (const [nether, shield] of [[false, false], [true, false], [false, true]]) {
      const w = createWorld({ name: 'ow-ranged-observe', world: { nether }, body: { shield }, events: [
        { at: 1, type: 'enemy', kind: 'skeleton', distance: 12 }] })
      stepWorld(w)
      const session: any = {}, facade = mineflayerFacade(w, session)
      session.bot = facade.bot; facade.sync()
      const observed: any = observeTactics(session)!
      if (!nether && !shield) {
        assert.ok(observed.owRangedApproachHp > 0)
        assert.ok(observed.shelter, 'find a physical roof before the first hit at full health')
        const look: any = hold.refugeLook(session)
        assert.ok(look.owRanged?.shots.length, 'the generic refuge uses the same visible bow policy')
        assert.equal(candidates(state({ enemies: [], contact: false })).length, 0)
        const pick: any = require('../src/pick'), aim = pick.aim
        try {
          pick.aim = () => null
          assert.equal((observeTactics(session)! as any).owRangedApproachHp, undefined, 'hidden skeleton is not priced')
        } finally { pick.aim = aim }
        const foe: any = Object.values(session.bot.entities).find((e: any) => e.name === 'skeleton')
        foe.equipment ||= []; foe.equipment[0] = { name: 'stone_sword' }
        assert.equal((observeTactics(session)! as any).owRangedApproachHp, undefined, 'a sword skeleton is melee')
        foe.equipment[0] = { name: 'bow' }
        session.bot.entities[999] = { ...foe, id: 999, name: 'player', username: 'other' }
        assert.equal((observeTactics(session)! as any).owRangedApproachHp, undefined, 'mixed PvP preserves its existing owner')
        assert.equal((hold.refugeLook(session) as any).owRanged, undefined)
      } else assert.equal(observed.owRangedApproachHp, undefined)
    }
  })
})

test('OW archer: damage does not restart the paid construction at the critical threshold', () => {
  const arbiter = new TacticalArbiter()
  const s = { ...state({ health: 10, canFight: false, buildCostHp: 0 }), owRangedApproachHp: 8 } as TacticalState
  assert.equal(arbiter.decide(s).selected?.id, 'BlockOff')
  const later = arbiter.decide({ ...s, health: 6 })
  assert.equal(later.selected?.id, 'BlockOff')
  assert.equal(later.change, false)
})

test('OW archer: selected cover uses the existing builder and restores the owner after failure', async () => {
  const survival: any = require('../src/survival')
  const mutable: any = require('../src/survival/hold-out')
  const old = { look: survival.refugeLook, choose: survival.chooseRefuge, box: mutable.takeBox }
  const previous = { aborted: false, onAbort: [] }
  const session: any = { bot: { game: { dimension: 'minecraft:overworld' }, entities: {} }, _refugeBuild: previous }
  const ctl: any = { aborted: false, onAbort: [] }
  let built = 0
  survival.refugeLook = () => ({ pocket: 0 })
  survival.chooseRefuge = () => ({ how: 'box' })
  mutable.takeBox = async (_session: any, owner: any) => {
    built++; assert.equal(session._refugeBuild, owner)
    throw new Error('placement stopped')
  }
  try {
    const system: any = new TacticalSystem(session)
    await assert.rejects(system.execute({ id: 'BlockOff', score: 95 }, ctl,
      { ...state({ enemies: [] }), owRangedApproachHp: 8 }), /placement stopped/)
    assert.equal(built, 1)
    assert.equal(session._refugeBuild, previous)
  } finally {
    survival.refugeLook = old.look; survival.chooseRefuge = old.choose; mutable.takeBox = old.box
  }
})
