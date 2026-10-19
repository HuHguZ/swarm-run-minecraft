import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { candidates, type TacticalState } from '../src/tactics/state'
import { TacticalArbiter } from '../src/tactics/arbiter'
import { EscapeProgress } from '../src/tactics/escape-progress'
import { SCENARIOS } from '../src/tactics/sim-scenarios'
import { check } from '../src/tactics/sim-run'
import { transformSync } from 'esbuild'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

const flags = ['ND_OW_NIGHT_FLEE', 'ND_OW_NIGHT_BLOCKOFF', 'ND_OW_NIGHT_CREEPER']
const previous = flags.map(key => process.env[key])
before(() => { for (const key of flags) process.env[key] = '1' })
after(() => { flags.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i] }) })

const state = (extra: Partial<TacticalState> = {}): TacticalState => ({ at: 0, health: 12, food: 13, armor: 0,
  weapon: true, shield: false, enemies: [{ id: 1, kind: 'skeleton', distance: 6.3, threatening: true, player: false, hit: 3.5 }],
  incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false, dangerousFall: false,
  emergencyController: false, inWater: false, cover: false, portal: false, escapeRoute: true, blocks: 240,
  water: false, edible: false, canFight: false, contact: true, shelter: 'BlockOff', protectedEncounter: false, ...extra })

test('cmk1-s1-3: approaching a creeper prices its blast; flight competes before the fuse alarm', () => {
  const choices = candidates(state({ health: 16, food: 20, canFight: true, shelter: null,
    enemies: [{ id: 1, kind: 'creeper', distance: 4.3, threatening: true, player: false, hit: 22 }] }))
  const fight = choices.find(c => c.id === 'Fight')!
  assert.ok(fight && fight.score > 0, 'the fight remains an option')
  assert.equal(choices[0].id, 'Flee')
  assert.ok(fight.score < choices[0].score)
})

test('a remote creeper does not discount the fight against the nearest zombie; armor still buys a fight', () => {
  const zombie = { id: 1, kind: 'zombie', distance: 2, threatening: true, player: false, hit: 3 }
  const creeper = { id: 2, kind: 'creeper', distance: 12, threatening: true, player: false, hit: 22 }
  const ordinary = candidates(state({ health: 20, canFight: true, shelter: null, enemies: [creeper, zombie] }))
  assert.equal(ordinary.find(c => c.id === 'Fight')?.score, 90)
  const armored = candidates(state({ health: 20, canFight: true, shelter: null, armor: 15, enemies: [{ ...creeper, distance: 4, hit: 2 }] }))
  assert.equal(armored[0].id, 'Fight')
})

test('mk1-s2-5: an arrow crossing critical HP does not restart the same partial box', () => {
  const arbiter = new TacticalArbiter()
  assert.equal(arbiter.decide(state()).selected?.id, 'BlockOff')
  const hit = arbiter.decide(state({ at: 1000, health: 4 }))
  assert.equal(hit.selected?.id, 'BlockOff')
  assert.equal(hit.change, false)
  assert.equal(arbiter.decide(state({ at: 1050, health: 4, explosion: true })).selected?.id, 'Dodge')
})

test('two confirmed failed retreats reprice the alternatives instead of excluding an untried hole', () => {
  const progress = new EscapeProgress()
  let position = { x: 0, y: 64, z: 0 }
  for (let i = 0; i < 2; i++) {
    const before = { at: i * 3000, position, threatDistance: 4, exits: String(i), available: true, armed: false }
    progress.observe(before)
    progress.begin('CreateDistance', before)
    position = { x: position.x + 8, y: 64, z: 0 }
    progress.finish('CreateDistance', { ...before, position, threatDistance: 3.9 }, 'completed', true)
  }
  const observed = progress.observe({ at: 6000, position, threatDistance: 3.9, exits: '2', available: true })
  assert.equal(observed.exhausted, true)
  const choices = candidates(state({ health: 13, weapon: false, shelter: 'DigDown', digDownCostHp: 3, blocks: 0,
    escapeExhausted: observed.exhausted,
    enemies: [{ id: 1, kind: 'spider', distance: 3.9, threatening: true, player: false, hit: 2 }] }))
  assert.equal(choices[0].id, 'DigDown')
  for (const id of ['Flee', 'CreateDistance', 'LastStand']) {
    assert.ok(choices.some(c => c.id === id && c.score > 0), id + ' remains priced')
  }
})

test('an exhausted retreat alone cannot force a one-HP fist stand; a physical dead end still has that option', () => {
  const bare = state({ health: 1, weapon: false, shelter: null, blocks: 0, escapeExhausted: true,
    enemies: [{ id: 1, kind: 'spider', distance: 3, threatening: true, player: false, hit: 2 }] })
  assert.equal(candidates(bare)[0].id, 'Flee')
  assert.equal(candidates({ ...bare, escapeRoute: false })[0].id, 'LastStand')
})

function nativeBox({ sealed = true, abort = false, handoff = false, throws = false } = {}) {
  const calls: string[] = []
  const ctl: any = { aborted: false, onAbort: [] }, previous = {}, newer = {}
  let built = false
  const site = () => ({ pocket: built && sealed ? 2 : 0, blocks: 64, cell: { blocks: 5 }, canBreakOut: true })
  const session: any = { bot: { health: 12, game: { dimension: 'overworld' }, entities: {},
    entity: { position: new Vec3(.5, 64, .5), onGround: true } }, _refugeBuild: previous }
  const survival = { refugeLook: site, chooseRefuge: () => ({ how: 'box' }),
    async refuge() {
      calls.push('recover')
      assert.ok(built && sealed, 'generic refuge must not replace the selected build with its flee preface')
      return { code: 'OK', how: 'pocket', stayed: true }
    } }
  const hold = { async takeBox() {
    calls.push('build')
    assert.equal(session._refugeBuild, ctl)
    if (throws) throw new Error('builder failure')
    built = true
    if (abort) ctl.aborted = true
    if (handoff) { ctl.aborted = true; session._refugeBuild = newer }
    return sealed ? { cell: session.bot.entity.position, placed: 5 } : null
  } }
  const file = path.resolve(__dirname, '../src/tactics/minecraft.ts'), local = createRequire(file)
  const module = { exports: {} as any }
  const overrides = { '../survival': survival, '../survival/hold-out': hold }
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap(code), { filename: file })(module.exports,
    id => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
  const execute = module.exports.TacticalSystem.prototype.execute
  return { calls, session, previous, newer, run: () => execute.call({ session }, { id: 'BlockOff' }, ctl, state({ enemies: [] })) }
}

test('native BlockOff builds the priced box before generic recovery and restores construction ownership', async () => {
  const f = nativeBox(), result = await f.run()
  assert.deepEqual(f.calls, ['build', 'recover'])
  assert.equal(result.failed, undefined)
  assert.equal(f.session._refugeBuild, f.previous)
})

test('native BlockOff rejects an unsealed build without silently fleeing', async () => {
  const f = nativeBox({ sealed: false }), result = await f.run()
  assert.equal(result.failed, true)
  assert.deepEqual(f.calls, ['build'])
  assert.equal(f.session._refugeBuild, f.previous)
})

for (const options of [{ abort: true }, { handoff: true }]) test(`native box abort preserves ownership ${JSON.stringify(options)}`, async () => {
  const f = nativeBox(options), result = await f.run()
  assert.equal(result.cancelled, true)
  assert.deepEqual(f.calls, ['build'])
  assert.equal(f.session._refugeBuild, options.handoff ? f.newer : f.previous)
})

test('native box construction exceptions restore the preceding owner', async () => {
  const f = nativeBox({ throws: true })
  await assert.rejects(f.run, /builder failure/)
  assert.equal(f.session._refugeBuild, f.previous)
})

test('stand: the creeper approach and partial box tapes retain health and complete their chosen response', async () => {
  for (const name of ['regress-ow-creeper-approach', 'regress-ow-box-critical-hit', 'regress-ow-exhausted-refuge']) {
    const scenario = SCENARIOS.find(s => s.name === name)!
    assert.ok(scenario)
    const r = await check(scenario)
    assert.equal(r.died, null, JSON.stringify(r.selections))
    assert.deepEqual(r.violations, [])
    if (name === 'regress-ow-creeper-approach') {
      assert.equal(r.selections[0].action, 'Flee')
      assert.ok(r.hp >= 16)
    } else if (name === 'regress-ow-box-critical-hit') {
      assert.equal(r.selections.filter(s => s.action === 'BlockOff').length, 1)
      assert.ok(r.hp >= 5)
    } else {
      assert.equal(r.selections.filter(s => s.action === 'CreateDistance' && s.result === 'completed').length, 2)
      assert.ok(r.selections.some(s => s.action === 'BlockOff'))
      assert.ok(!r.selections.some(s => s.action === 'LastStand'))
      assert.ok(r.hp >= 5)
    }
  }
})
