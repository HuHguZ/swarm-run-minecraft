import test from 'node:test'
import assert from 'node:assert/strict'
import combat = require('../src/combat')
import { swarmMethods } from '../src/rpc/swarm'
import { digStepSafe, reachFrom } from '../src/pvp/body'
import { Vec3 } from 'vec3'
import { runIntent } from '../src/session/intent-runner'
import { edgeTurn, meleeIntentTurn, strikeTurn } from '../src/pvp/turn-melee'
import { NEXT } from '../src/pvp/turn'
import { postureTurn } from '../src/pvp/turn-target'
import { createEquipment } from '../src/pvp/equipment'
import { createHpEstimate } from '../src/pvp/hp-estimate'
import { bestWeapon } from '../src/items'
import { getPhysics } from '../src/tick-plugins'
import { canHit } from '../src/pick'

const scope = { target: 'Champ', roundScope: 'blue:1', fightId: 'fight-1' }
const guard = { digAvoid: [{ x: 1, y: 63, z: 0, feetY: 64 }], swarmStand: { x: 2.5, y: 64, z: .5 } }
function fixture() {
  const ctl = { aborted: false, onAbort: [], _ndFightClosed: false }
  const params: any = { ...scope, allowPlayer: true, timeoutSeconds: 12 }
  const current = { name: 'fight', ctl, params }
  const session: any = { current, state: () => ({ busy: session.current?.name }),
    immediate() { throw new Error('must not enter immediate or drain events') },
    cancel() { throw new Error('must not cancel the live fight') },
    bus: { drain() { throw new Error('must not drain combat events') } } }
  const methods: any = swarmMethods({ session } as any)
  const ask = (patch = {}) => methods.fight_guard?.({ ...scope, ...guard, ...patch }) || { detail: { accepted: false, reason: 'unsupported' } }
  return { session, current, ctl, params, ask }
}

test('fight_guard updates the exact live fight without aborting, and the existing step consumer sees it', async () => {
  const f = fixture(), original = f.session.current
  const reply = await f.ask()
  assert.equal(reply.detail.accepted, true, reply.detail.reason)
  assert.equal(reply.status, 'done'); assert.deepEqual(reply.events, [])
  assert.equal(f.session.current, original); assert.equal(f.current.ctl, f.ctl); assert.equal(f.ctl.aborted, false)
  assert.deepEqual(f.params.digAvoid, guard.digAvoid); assert.deepEqual(f.params.swarmStand, guard.swarmStand)
  assert.notEqual(f.params.digAvoid, guard.digAvoid, 'wire arrays are copied')
  assert.notEqual(f.params.digAvoid[0], guard.digAvoid[0], 'wire coordinates are copied')
  const bot: any = { entity: { position: new Vec3(.5, 64, .5), width: .6, height: 1.8, metadata: [] } }
  assert.equal(digStepSafe({ bot, session: f.session, opts: {} }, { x: 1, z: 0 }), false)
  assert.equal((await f.ask({ digAvoid: [], swarmStand: null })).detail.accepted, true)
  assert.equal(digStepSafe({ bot, session: f.session, opts: {} }, { x: 1, z: 0 }), true)
  assert.deepEqual(f.params.digAvoid, []); assert.equal(f.params.swarmStand, null)
})

test('fight_guard rejects stale, aborted, closed and malformed snapshots atomically', async () => {
  const f = fixture()
  assert.equal((await f.ask()).detail.accepted, true)
  const snapshot = JSON.stringify(f.params), cells = f.params.digAvoid, stand = f.params.swarmStand
  for (const patch of [{ target: 'Other' }, { roundScope: 'blue:0' }, { fightId: 'previous' }, { fightId: '' },
    { digAvoid: null }, { digAvoid: [{}] }, { digAvoid: Array(4097).fill(guard.digAvoid[0]) },
    { digAvoid: [{ x: 1.5, y: 63, z: 0 }] }, { digAvoid: [{ x: 1, y: 63, z: 0, feetY: NaN }] },
    { swarmStand: { x: Infinity, y: 64, z: 0 } }, { swarmStand: { x: 30000001, y: 64, z: 0 } }, { swarmStand: undefined }]) {
    assert.equal((await f.ask(patch)).detail.accepted, false, JSON.stringify(patch))
    assert.equal(JSON.stringify(f.params), snapshot); assert.equal(f.params.digAvoid, cells); assert.equal(f.params.swarmStand, stand)
  }
  f.ctl.aborted = true; assert.equal((await f.ask()).detail.accepted, false)
  f.ctl.aborted = false; f.ctl._ndFightClosed = true; assert.equal((await f.ask()).detail.accepted, false)
  f.ctl._ndFightClosed = false; f.session.current = { ...f.current, name: 'evade' }
  assert.equal((await f.ask()).detail.accepted, false)
  f.session.current = { ...f.current, ctl: { aborted: false }, params: { ...f.params, fightId: 'fight-2' } }
  assert.equal((await f.ask()).detail.accepted, false, 'an old fight token cannot mutate the next controller')
})

test('fight_guard leaves the real intent runner and its live controller running until its worker completes', async () => {
  let finish: (v: any) => void, drains = 0
  const params: any = { ...scope }, worker = new Promise(r => { finish = r })
  const session: any = { current: null, state: () => ({ busy: session.current?.name }), bus: { drain: () => { drains++; return [] } } }
  const running = runIntent.call(session, 'fight', () => worker, { params, exclusive: false, interruptible: false, timeoutMs: 0 })
  await new Promise(resolve => setImmediate(resolve))
  const current = session.current
  assert.equal(current.name, 'fight'); assert.equal(current.ctl.aborted, false)
  const reply = await (swarmMethods({ session } as any) as any).fight_guard({ ...scope, ...guard })
  assert.equal(reply.detail.accepted, true)
  assert.equal(session.current, current); assert.equal(current.ctl.aborted, false); assert.equal(drains, 0)
  assert.deepEqual(current.params.digAvoid, guard.digAvoid)
  finish({ landed: 1 })
  assert.equal((await running).status, 'done'); assert.equal(session.current, null); assert.equal(drains, 1)
  assert.equal((await (swarmMethods({ session } as any) as any).fight_guard({ ...scope, ...guard })).detail.accepted, false)
})

test('fight_guard updates the actual edgeTurn shove direction and clears it without restarting the fight', async () => {
  const f = fixture(), to = { x: -6, y: 64, z: .5 }, me = new Vec3(2.5, 64, .5)
  const ctx: any = { bot: { entity: { position: me, yaw: Math.PI / 2 }, blockAt: () => null },
    entity: { position: new Vec3(0, 64, .5), username: scope.target }, session: f.session, opts: {}, st: {},
    prof: { player: true }, pushAt: Infinity, backAt: Infinity, nearMe: [], nearFoe: [], duo: { foes: () => [] }, ready: () => false }
  const frame = (): any => ({ now: 1000, me, d: 2.5, r: 2.5, theirR: 2.5, cooldownLeft: 0, canHit: true, inSight: true })
  assert.equal((await f.ask({ shoveAt: to })).detail.accepted, true)
  assert.deepEqual(f.params.shoveAt, to)
  assert.notEqual(f.params.shoveAt, to, 'incoming coordinates are copied')
  to.x = 99
  let turn = frame(); edgeTurn(ctx, turn)
  assert.equal(turn.edgeHit, 'sprint', 'current.params reaches the real consumer without frozen PvP opts')
  assert.equal(f.ctl.aborted, false)
  assert.equal((await f.ask({ shoveAt: { x: 6, y: 64, z: .5 } })).detail.accepted, true)
  turn = frame(); edgeTurn(ctx, turn)
  assert.equal(turn.canHit, false, 'an updated edge requires the opposite side immediately')
  assert.equal((await f.ask()).detail.accepted, true)
  assert.equal(f.params.shoveAt.x, 6, 'old callers omitting this optional field preserve the live directive')
  assert.equal((await f.ask({ shoveAt: null })).detail.accepted, true)
  assert.equal(f.params.shoveAt, null)
  assert.equal(f.session.current, f.current); assert.equal(f.ctl.aborted, false)
  assert.equal((await f.ask({ shoveAt: { x: -6, y: 64, z: .5 } })).detail.accepted, true)
  turn = frame(); edgeTurn(ctx, turn); assert.equal(turn.edgeHit, 'sprint')
  assert.equal((await f.ask({ shoveAt: null })).detail.accepted, true)
  turn = frame(); edgeTurn(ctx, turn)
  assert.equal(turn.pushing, false, 'cleared live order must not survive in the250ms natural-edge cache')
  assert.equal(turn.edgeHit, null)
})

test('malformed optional shove coordinates cannot partially update a live guard', async () => {
  const f = fixture()
  assert.equal((await f.ask({ shoveAt: { x: -6, y: 64, z: .5 } })).detail.accepted, true)
  const before = JSON.stringify(f.params), shove = f.params.shoveAt, cells = f.params.digAvoid
  for (const shoveAt of [{}, { x: 0, y: NaN, z: 0 }, { x: Infinity, y: 64, z: 0 }, { x: 30000001, y: 64, z: 0 }, false]) {
    assert.equal((await f.ask({ digAvoid: [], shoveAt })).detail.accepted, false)
    assert.equal(JSON.stringify(f.params), before)
    assert.equal(f.params.shoveAt, shove); assert.equal(f.params.digAvoid, cells)
  }
})

test('ordered shove yields to existing pressure after a failed flank without reviving a physically unavailable hit', () => {
  for (const [press, aligned, canHit] of [[true, false, true], [false, false, true], [true, true, true], [true, false, false]]) {
    const f = fixture(), me = new Vec3(2.5, 64, .5)
    f.params.target = scope.target; f.params.shoveAt = { x: aligned ? -6 : 6, y: 64, z: .5 }
    const ctx: any = { bot: { entity: { position: me, yaw: Math.PI / 2 }, blockAt: () => null },
      entity: { position: new Vec3(0, 64, .5), username: scope.target }, session: f.session, opts: {}, st: { swings: 0, landed: 0 },
      prof: { player: true }, pushAt: Infinity, backAt: Infinity, nearMe: [], nearFoe: [], duo: { foes: () => [] }, ready: () => false,
      fortSealed: () => false, healItem: () => null, routeInputs: () => 'same observed floor', used: () => {},
      exchangeStart: { swings: 0, landed: 0 }, failedFlank: press ? { inputs: 'same observed floor' } : null }
    const turn: any = { now: 1000, me, hp: 20, d: 2.5, dy: 0, r: 2.2, theirR: 2.2, seesBody: true,
      cooldownLeft: 0, canHit }
    postureTurn(ctx, turn)
    assert.equal(turn.inSight, true, 'the real public pick remains reachable')
    assert.equal(turn.pressing, press, 'postureTurn derives pressure from an existing failed flank, without a new timer')
    edgeTurn(ctx, turn)
    assert.equal(turn.canHit, canHit && (press || aligned), 'a misaligned ordered shove cannot suppress the existing pressure fallback')
    assert.equal(turn.pushing, aligned || !press)
    assert.equal(turn.edgeHit, aligned ? 'sprint' : null)
    assert.equal(f.session.current, f.current); assert.equal(f.ctl.aborted, false)
  }
})

test('a filled ordered shove destination does not suppress ready sword strikes', async () => {
  const f = fixture()
  const position = new Vec3(588.3000000119209, 120, 594.3000000119209)
  const to = position.offset(6, 0, 0)
  assert.equal((await f.ask({ shoveAt: to })).detail.accepted, true)
  const stands = [
    new Vec3(590.4987511337886, 120, 596.7043423878877),
    new Vec3(587.3695369268825, 121.00133597911214, 595.2800381985301),
    new Vec3(591.4542369272621, 120, 594.8341720002194),
    new Vec3(588.7606398882841, 120, 595.6095116161658)
  ]
  function step(me: Vec3, other: (p: Vec3) => string | undefined = () => undefined, canHit = true, foe = position) {
    const bot = {
      entity: { position: me, yaw: 0, width: .6, height: 1.8 }, physics: { playerHalfWidth: Math.fround(.6) / 2 },
      blockAt(at: Vec3) {
        const p = at.floored()
        const name = other(p) ?? (p.y < 120 ? 'sandstone' : 'air')
        if (name === 'unknown') return null
        return { name, position: p, boundingBox: name === 'sandstone' ? 'block' : 'empty',
          shapes: name === 'sandstone' ? [[0, 0, 0, 1, 1, 1]] : [] }
      }
    }
    const ctx: any = { bot, entity: { position: foe, username: scope.target }, session: f.session, opts: {}, st: {},
      prof: { player: true }, pushAt: Infinity, backAt: Infinity, nearMe: [], nearFoe: [], duo: { foes: () => [] }, ready: () => false }
    const turn: any = { now: 1000, me, d: me.distanceTo(foe), r: 2.5, theirR: 2.7, cooldownLeft: 0, canHit, inSight: true }
    edgeTurn(ctx, turn)
    return turn
  }
  for (const me of stands) {
    const turn = step(me)
    assert.equal(turn.canHit, true)
    assert.equal(turn.pushing, false)
  }
  for (const [name, x, y, z] of [['lava', 594, 119, 594], ['lava', 595, 120, 595], ['unknown', 594, 119, 594], ['air', 594, 119, 594]] as const) {
    const turn = step(stands[0], p => p.x === x && p.y === y && p.z === z ? name : undefined)
    assert.equal(turn.canHit, false, name)
    assert.equal(turn.pushing, true)
  }
  assert.equal(step(position.offset(-2, 0, 0)).edgeHit, 'sprint')
  assert.equal(step(stands[0], undefined, false).canHit, false)
  assert.equal(step(stands[0], undefined, true, position.offset(0, 1, 0)).canHit, false)
  assert.equal(f.session.current, f.current); assert.equal(f.ctl.aborted, false)
})

test('an ordered shove cannot buy a useless bare hit on the supported arena floor', async t => {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const first = [new Vec3(606.9027802966389, 120, 600.5916372055452), new Vec3(604.960618399475, 120.60473163136353, 600.5)]
  const second = [new Vec3(606.9849269810521, 120, 600.5917264971052), new Vec3(606.6971731730208, 120, 600.4773463568171)]
  for (const mode of ['DX A1', 'DX A2', 'raise', 'edge', 'finishing', 'last stand', 'armed', 'pickup', 'no order']) await t.test(mode, async () => {
    const f = fixture(), hits: string[] = [], raises: boolean[] = [], equips: string[] = []
    const [me, at] = (mode === 'DX A1' ? first : second).map(p => p.clone())
    const rim = Math.floor(at.x)
    if (mode === 'edge') { at.x = rim - .19; me.set(at.x + 1.7, at.y, at.z) }
    const armor = ['boots', 'leggings', 'chestplate', 'helmet'].map(name => ({ name: 'netherite_' + name }))
    const entity: any = { id: 2, type: 'player', username: scope.target, position: at, height: 1.8, width: Math.fround(.6),
      _ndVisible: true, onGround: at.y === 120, metadata: [],
      equipment: [{ name: 'mace' }, null, ...(mode === 'finishing' ? [null, null, ...armor.slice(2)] : armor)] }
    Object.defineProperty(entity, 'health', { get() { throw Error('private player HP') } })
    const sword = { name: 'netherite_sword', count: 1 }
    const items = [{ name: 'bow', count: 1 }, { name: 'arrow', count: 64 }, { name: 'wind_charge', count: 32 },
      { name: 'ender_pearl', count: 4 }, { name: 'iron_pickaxe', count: 1 }, { name: 'cobblestone', count: 64 }]
    if (mode === 'armed' || mode === 'pickup') items.push(sword)
    const slots = []
    slots[45] = { name: 'shield', count: 1 }
    const bot: any = { version: '1.21.11', registry, health: 20, food: 20, game: { minY: -64, height: 384 },
      entity: { id: 1, position: me, velocity: new Vec3(0, -.0784, 0), yaw: Math.atan2(me.x - at.x, me.z - at.z),
        pitch: 0, height: 1.8, width: Math.fround(.6), onGround: true, metadata: [], effects: {}, attributes: {} },
      entities: { 2: entity }, inventory: { slots, items: () => items }, heldItem: mode === 'armed' ? sword : null,
      getControlState: () => false, equip: async item => { equips.push(item.name); bot.heldItem = item },
      blockAt(p: Vec3) {
        const cell = p.floored(), air = cell.y >= 120 || mode === 'edge' && cell.x < rim
        const block = Block.fromStateId(registry.blocksByName[air ? 'air' : 'sand'].minStateId, 0)
        block.position = cell
        return block
      } }
    bot.physics = getPhysics().Physics(registry, { getBlock: bot.blockAt })
    // Replay an aligned order with the recorded native attack poses.
    const to = at.plus(at.minus(me).scaled(10))
    if (mode !== 'no order') assert.equal((await f.ask({ shoveAt: { ...to, y: at.y } })).detail.accepted, true)
    const estimate = createHpEstimate({ hp: mode === 'finishing' ? .5 : 20 })
    const ctx: any = { bot, entity, session: f.session, ctl: f.ctl, opts: {}, AR: { x: 600.5, z: 600.5, rx: 77, rz: 65 },
      prof: { player: true, theirReach: 3 }, weapon: bot.heldItem, lastStand: mode === 'last stand',
      guard: { stats: { worn: true }, blocking: () => false, raise: async value => { raises.push(value) } },
      st: { swings: 0 }, combo: { note() {} }, foe: { shieldOff: () => 0 }, foeEst: estimate.snapshot,
      mf: { clock: { charge: () => 1, leftMs: () => 0, critNow: () => false, msPerTick: 50, srvSprint: mode === 'edge' },
        shield: () => mode === 'raise' ? 'raise' : 'lower', skill: { counter: 0 }, hit: () => { hits.push(bot.heldItem?.name ?? 'AIR') } },
      tt: { state: () => ({}), foes: new Map() }, ready: () => false, rest() {}, roll: () => false, used() {}, after: () => false,
      strafeStep() {}, style: { aggression: 0 }, nearMe: [], nearFoe: [], duo: { foes: () => [] },
      pushAt: 0, backAt: Infinity, track: { vel: () => new Vec3(0, 0, 0) }, targetHurtAt: -Infinity, hitKind: 'plain',
      bestWeapon, heldName: () => bot.heldItem?.name, switched() {} }
    ctx.holdWeapon = createEquipment(ctx).holdWeapon
    const turn: any = { now: 1000, me, d: me.distanceTo(at), r: reachFrom(me.offset(0, 1.62, 0), entity),
      theirR: 2.7, cooldownLeft: 0, inSight: canHit(bot, entity), seesBody: true, closing: 0 }
    meleeIntentTurn(ctx, turn)
    edgeTurn(ctx, turn)
    assert.equal(turn.canHit, true)
    assert.equal(turn.edgeHit, mode === 'no order' ? null : 'sprint')
    assert.equal(ctx.push?.now ?? null, mode === 'edge' ? 'sprint' : null)
    const result = await strikeTurn(ctx, turn)
    if (mode === 'DX A1' || mode === 'DX A2' || mode === 'pickup' || mode === 'raise') {
      assert.equal(result, mode === 'pickup' ? NEXT : undefined, 'a held strike reaches the ordinary turn wait')
      assert.deepEqual(hits, [], 'do not send a bare attack without a useful local result')
      assert.deepEqual(raises, mode === 'raise' ? [true] : [], 'a rejected strike preserves defensive shield advice')
    } else assert.deepEqual(hits, [mode === 'armed' ? 'netherite_sword' : 'AIR'])
    assert.deepEqual(equips, mode === 'pickup' ? ['netherite_sword'] : [])
    if (mode === 'pickup') assert.equal(ctx.weapon, sword)
  })
})
