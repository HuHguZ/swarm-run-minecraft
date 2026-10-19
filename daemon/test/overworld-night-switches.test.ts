import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { candidates, type TacticalState } from '../src/tactics/state'
import { TacticalArbiter } from '../src/tactics/arbiter'
import { cjsContext } from './cjs-context'
import { transformSync } from 'esbuild'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

const flags = ['ND_OW_NIGHT_FLEE', 'ND_OW_NIGHT_BLOCKOFF', 'ND_OW_NIGHT_CREEPER']
function withFlags(values: Array<string | undefined>, fn: () => any) {
  const saved = flags.map(key => process.env[key])
  flags.forEach((key, i) => values[i] === undefined ? delete process.env[key] : process.env[key] = values[i])
  const restore = () => flags.forEach((key, i) => saved[i] === undefined ? delete process.env[key] : process.env[key] = saved[i])
  try {
    const result = fn()
    if (result?.then) return result.finally(restore)
    restore()
    return result
  } catch (error) { restore(); throw error }
}
const state = (extra: Partial<TacticalState> = {}): TacticalState => ({ at: 0, health: 12, food: 13, armor: 0,
  weapon: true, shield: false, enemies: [{ id: 1, kind: 'skeleton', distance: 6.3, threatening: true, player: false, hit: 3.5 }],
  incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false, dangerousFall: false,
  emergencyController: false, inWater: false, cover: false, portal: false, escapeRoute: true, blocks: 240,
  water: false, edible: false, canFight: false, contact: true, shelter: 'BlockOff', protectedEncounter: false, ...extra })

function load(file: string, overrides: Record<string, any>) {
  const local = createRequire(file), module = { exports: {} as any }
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext((require('node:module') as typeof import('node:module')).wrap(code), { filename: file })(module.exports,
    id => Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : local(id), module, file, path.dirname(file))
  return module.exports
}
async function box({ niche = false, pocket = false } = {}) {
  const calls: string[] = [], ctl = { aborted: false, onAbort: [] }
  let sealed = pocket
  const session: any = { bot: { health: 12, entities: {}, game: { dimension: niche ? 'the_nether' : 'overworld' },
    entity: { position: new Vec3(0, 64, 0), onGround: true } } }
  const survival = { refugeLook: () => ({ pocket: sealed ? 2 : 0 }), chooseRefuge: () => ({ how: 'box' }),
    refuge: async () => { calls.push('recover'); return { code: 'OK' } } }
  const hold = { takeBox: async () => { calls.push('box'); sealed = true; return {} },
    takeNiche: async () => { calls.push('niche'); sealed = true; return {} } }
  const { TacticalSystem } = load(path.resolve(__dirname, '../src/tactics/minecraft.ts'), {
    '../survival': survival, '../survival/hold-out': hold })
  await TacticalSystem.prototype.execute.call({ session }, { id: 'BlockOff' }, ctl, state(niche ? {
    shield: true, niche: true, enemies: [{ id: 1, kind: 'piglin', distance: 5, threatening: true, player: false }] } : {}))
  return calls
}

for (const value of [undefined, '0', '1', 'true']) {
  const on = value === '1'
  test(`FLEE=${value}: exhausted retreat restores the n7 choice unless explicitly enabled`, () => withFlags([value, '0', '0'], () => {
    const choices = candidates(state({ health: 13, weapon: false, shelter: 'DigDown', blocks: 0,
      digDownCostHp: 3, escapeExhausted: true,
      enemies: [{ id: 1, kind: 'spider', distance: 3.9, threatening: true, player: false, hit: 2 }] }))
    assert.equal(choices[0].id, on ? 'DigDown' : 'LastStand')
    assert.equal(choices.some(c => c.id === 'CreateDistance'), on)
    assert.equal(choices.some(c => c.id === 'Flee'), on)
    assert.equal(choices.some(c => c.id === 'DigDown'), on)
    assert.equal(choices.find(c => c.id === 'LastStand')!.score, on ? 90 / (1 + 6 / 13) : 155)
  }))
  test(`CREEPER=${value}: approach is discounted only when enabled`, () => withFlags(['0', '0', value], () => {
    const choices = candidates(state({ health: 16, food: 20, canFight: true, shelter: null,
      enemies: [{ id: 1, kind: 'creeper', distance: 4.3, threatening: true, player: false, hit: 22 }] }))
    assert.equal(choices[0].id, on ? 'Flee' : 'Fight')
    assert.equal(choices.find(c => c.id === 'Fight')!.score, on ? 90 / (1 + 22 / 16) : 90)
  }))
  test(`BLOCKOFF=${value}: same shelter restarts at critical HP only in legacy mode`, () => withFlags(['0', value, '0'], () => {
    const arbiter = new TacticalArbiter()
    assert.equal(arbiter.decide(state()).selected?.id, 'BlockOff')
    const critical = arbiter.decide(state({ at: 1000, health: 4 }))
    assert.equal(critical.selected?.id, 'BlockOff')
    assert.equal(critical.change, !on)
    assert.equal(arbiter.decide(state({ at: 1050, health: 4, explosion: true })).selected?.id, 'Dodge')
  }))
  test(`BLOCKOFF=${value}: executor builds before recovery only when enabled`, () => withFlags(['0', value, '0'], async () => {
    assert.deepEqual(await box(), on ? ['box', 'recover'] : ['recover'])
    assert.deepEqual(await box({ niche: true }), ['niche', 'recover'])
    assert.deepEqual(await box({ niche: true, pocket: true }), on ? ['recover'] : ['niche', 'recover'])
  }))
}

for (const value of ['0', '1']) test(`BLOCKOFF=${value}: C7 and the speedrun pocket policy remain independent`, () =>
  withFlags(['0', value, '0'], async () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/survival/refuge-body.ts'), 'utf8')
    for (const [night, speedrun, wanted] of [['0', false, value === '1'], ['1', false, true], ['0', true, true]] as const) {
      const calls: string[] = [], out = { hp0: 12, code: 'OK', stayIn: true, untilDawn: false, steps: [] }
      const bot = { health: 12, food: 13, entity: { position: new Vec3(0, 12, 0) } }
      const ctx: any = { process: { env: { ...process.env, ND_NIGHT_WORK: night, ND_REFUGE_SPIDER: '0', ND_REFUGE_PLANKS: '0' } }, console: { log() {} },
        require: name => name.endsWith('fortify') ? { landed: async () => {} } : {},
        gameClock: { now: () => 1 }, refugeLook: () => ({ blocks: 0, pocket: 2 }),
        lookLine: () => '', chooseRefuge: () => ({ how: 'pocket' }), outrun: () => false,
        sitOn: () => true, holdOut: async () => ({ why: 'no_food', ate: [] }),
        sitTight: async () => { calls.push('sit'); return { sat: 1 } } }
      const start = source.indexOf('async function refugeBody (')
      vm.runInNewContext(transformSync(source.slice(start, source.indexOf('\nasync function takeHole', start)) + '\nthis.run=refugeBody', { loader: 'ts' }).code, cjsContext(ctx))
      const result = await ctx.run({ bot, playPolicy: { mode: speedrun ? 'speedrun' : 'other' } }, { aborted: false },
        { t0: 0, minHp: 16, deadline: 60000, out, step() {}, hurts: [] })
      assert.equal(!!result.stayed, wanted, `C7=${night}, speedrun=${speedrun}`)
      assert.deepEqual(calls, wanted ? [] : ['sit'])
    }
  }))

for (let mask = 0; mask < 8; mask++) test(`independent flags ${mask.toString(2).padStart(3, '0')}`, () => {
  const values = flags.map((_, i) => (mask & 1 << i) ? '1' : '0')
  return withFlags(values, () => {
    const retreat = state({ health: 13, weapon: false, shelter: 'DigDown', blocks: 0, digDownCostHp: 3,
      escapeExhausted: true, enemies: [{ id: 1, kind: 'spider', distance: 3.9, threatening: true, player: false, hit: 2 }] })
    assert.equal(candidates(retreat)[0].id, mask & 1 ? 'DigDown' : 'LastStand')
    const arbiter = new TacticalArbiter()
    arbiter.decide(state())
    assert.equal(arbiter.decide(state({ at: 1000, health: 4 })).change, !(mask & 2))
    const creeper = state({ health: 16, canFight: true, shelter: null,
      enemies: [{ id: 1, kind: 'creeper', distance: 4.3, threatening: true, player: false, hit: 22 }] })
    assert.equal(candidates(creeper)[0].id, mask & 4 ? 'Flee' : 'Fight')
    const bear = { id: 8, action: 'PillarUp', cost: 1, seconds: 1, loss: 0, top: 67, signature: 'test-bear' }
    const polar = new TacticalArbiter()
    assert.equal(polar.decide(state({ polarBear: bear })).selected?.id, 'PillarUp')
    assert.equal(polar.decide(state({ at: 1000, health: 4, polarBear: bear })).change, false)
  })
})
