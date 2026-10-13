import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
const Vec3 = require('vec3')
const esbuild = require('esbuild')

function sourceModule(name: string, overrides: Record<string, unknown> = {}) {
  const file = path.resolve(__dirname, '../src', name + '.ts')
  const local = createRequire(file), module = { exports: {} as Record<string, any> }
  const code = esbuild.transformSync(readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInThisContext(require('node:module').wrap(code), { filename: file })(module.exports,
    (id: string) => id in overrides ? overrides[id] : local(id), module, file, path.dirname(file))
  return module.exports
}
const state = sourceModule('tactics/state')
const field = (changes: Record<string, any> = {}) => ({ at: 1000, health: 20, food: 20, armor: 0,
  weapon: false, shield: false, enemies: [{ id: 2, kind: 'enderman', threatening: true, player: false, distance: 1, hit: 7 }],
  incomingProjectiles: 0, burning: false, lava: false, fireResistance: false, explosion: false,
  dangerousFall: false, emergencyController: false, inWater: false, cover: false, portal: false,
  escapeRoute: true, blocks: 0, water: false, edible: false, canFight: false, contact: true,
  shelter: 'DigDown', protectedEncounter: false, digDownCostHp: 21, ...changes })

test('angry enderman discounts a run without inheriting the flyer dead-end rules', () => {
  const s = field()
  assert.equal(state.runGain(s), .3)
  assert.equal(state.outpaced(s), false, 'a supported hole still holds against this walker')
  assert.equal(state.deadEnd(s), false)
  assert.equal(state.runGain(field({ enemies: [{ ...s.enemies[0], threatening: false }] })), 1,
    'a calm entity must not change the price of escaping an unidentified attacker')
})

test('the native open shaft is priced until its roof, without a blanket blockless refusal', () => {
  const choices = state.candidates(field())
  assert.equal(choices[0]?.id, 'CreateDistance')
  assert.equal(choices.find((c: any) => c.id === 'CreateDistance')?.score, 25.5)
  assert.ok(choices.some((c: any) => c.id === 'DigDown'))
  assert.equal(choices.find((c: any) => c.id === 'DigDown').score, 0)
})

test('complete hit exposure can still favor a hole with armor-reduced observed damage', () => {
  const assess = require('../src/assess'), hit = Math.round(assess.afterArmor(assess.MOBS.enderman.dmg, 20, 8) * 10) / 10
  const s = field({ armor: 20, enemies: [{ ...field().enemies[0], hit }], digDownCostHp: 3 * hit })
  assert.equal(state.candidates(s)[0]?.id, 'DigDown')
})

test('the hole is priced by survival exposure, not a new health refusal', () => {
  const choices = state.candidates(field({ health: 8 }))
  assert.equal(choices[0]?.id, 'CreateDistance', 'HP8 / hit7 is only about 1.14 seconds of exposure')
  assert.ok(choices.some((c: any) => c.id === 'DigDown'), 'a dangerous physical option stays priced, not prohibited')
  assert.ok(choices.find((c: any) => c.id === 'DigDown').score < 25.5)
})

test('the captured HP13 slow hole is not claimed to save the native fatal encounter', () => {
  assert.equal(state.candidates(field({ health: 13, digDownCostHp: 26.6 }))[0]?.id, 'CreateDistance')
})

test('a bare body with no local refuge retains the ordinary run fallback', () => {
  const choices = state.candidates(field({ shelter: null, digDownCostHp: undefined }))
  assert.equal(choices[0]?.id, 'CreateDistance')
  assert.ok(choices[0].score > 0)
})

test('an existing low pocket needs no filler, while a box still needs building material', () => {
  assert.equal(state.candidates(field({ shelter: 'Hide', cover: true, digDownCostHp: undefined }))[0]?.id, 'Hide')
  assert.equal(state.candidates(field({ shelter: 'BlockOff', digDownCostHp: undefined })).some((c: any) => c.id === 'BlockOff'), false)
})

test('fall ownership and player reach still exclude digging down', () => {
  assert.equal(state.candidates(field({ dangerousFall: true })).some((c: any) => c.id === 'DigDown'), false)
  assert.equal(state.candidates(field({ enemies: [{ id: 2, kind: 'player', player: true, threatening: true, distance: 1 }] }))
    .some((c: any) => c.id === 'DigDown'), false)
})

test('the observer charges full digging and the existing closing-roof cost in complete hits', () => {
  const registry = require('minecraft-data')('1.21.11')
  const position = new Vec3(.5, 64, .5)
  const bot: any = { health: 20, food: 20, entity: { id: 1, position, height: 1.8, width: .6,
    eyeHeight: 1.62, onGround: true, metadata: [], effects: {} },
    inventory: { slots: [], items: () => [] }, game: { dimension: 'overworld' }, registry,
    entities: { 2: { id: 2, name: 'enderman', position: new Vec3(1.5, 64, .5),
      height: 2.9, width: .6, metadata: [], isValid: true } },
    blockAt(p: any) { const q = p.floored(); return { position: q, name: q.y < 64 ? 'dirt' : 'air',
      boundingBox: q.y < 64 ? 'block' : 'empty', shapes: q.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] } } }
  const survival = { refugeLook: () => ({ blocks: 0, hole: { depth: 3, ms: 1800 } }), chooseRefuge: () => ({ how: 'hole' }),
    buildMsOf: require('../src/survival').buildMsOf }
  const tactics = sourceModule('tactics/minecraft', { '../survival': survival,
    '../combat-safety': { inspect: () => ({ action: 'leave', threats: [{ id: 2, distance: 1, hit: 7 }] }) } })
  const s = tactics.observeTactics({ bot, mcData: registry })
  assert.equal(s.shelter, 'DigDown')
  assert.equal(s.digDownCostHp, 21)
  assert.equal(state.candidates(s)[0]?.id, 'CreateDistance')
})

test('real inspect saying fight does not hide a physical hole from an unarmed Enderman encounter', () => {
  const registry = require('minecraft-data')('1.21.11'), position = new Vec3(.5, 64, .5)
  const bot: any = { health: 20, food: 20, version: '1.21.11', entity: { id: 1, position,
    height: 1.8, width: .6, eyeHeight: 1.62, onGround: true, metadata: [], effects: {} },
    inventory: { slots: [], items: () => [{ name: 'diamond_shovel', count: 1 }] },
    game: { dimension: 'overworld' }, registry,
    entities: { 2: { id: 2, name: 'enderman', position: new Vec3(3.5, 64, .5),
      height: 2.9, width: .6, metadata: [], isValid: true } },
    blockAt(p: any) { const q = p.floored(); return { position: q, name: q.y < 64 ? 'dirt' : 'air',
      boundingBox: q.y < 64 ? 'block' : 'empty', shapes: q.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] } } }
  assert.equal(require('../src/combat-safety').inspect(bot, { target: bot.entities[2] }).action, 'fight')
  let scans = 0
  const tactics = sourceModule('tactics/minecraft', { '../survival': {
    refugeLook() { scans++; return { blocks: 0, hole: { depth: 3, ms: 1650 } } },
    chooseRefuge: () => ({ how: 'hole' }), buildMsOf: require('../src/survival').buildMsOf } })
  const session = { bot, mcData: registry, current: { params: { target: '#2' } } }
  const s = tactics.observeTactics(session)
  assert.equal(s.weapon, false)
  assert.equal(s.shelter, 'DigDown')
  assert.equal(s.digDownCostHp, 21)
  assert.equal(state.candidates(s)[0]?.id, 'CreateDistance')
  assert.equal(scans, 1)
  tactics.observeTactics({ ...session, current: null })
  assert.equal(scans, 1, 'a calm untargeted Enderman does not cause a new geometry scan')
  bot.entities[2].name = 'zombie'
  tactics.observeTactics({ ...session, current: null })
  assert.equal(scans, 1, 'the healthy non-Enderman observer keeps its existing admission')
})

test('the reused physical planner rejects loose, wet, open-sided and unloaded shaft cells', () => {
  const body = sourceModule('survival/surface-body', { '.././tools': { bestFor: () => ({ ms: 100 }) } })
  const base = new Vec3(0, 64, 0)
  const bot: any = { inventory: { items: () => [] }, blockAt: (p: any) => ({ name: 'dirt', boundingBox: 'block', position: p }) }
  assert.equal(body.holePlan(bot, null, base)?.depth, 3)
  for (const bad of [null, { name: 'sand', boundingBox: 'block' }, { name: 'lava', boundingBox: 'empty' },
    { name: 'water', boundingBox: 'empty' }, { name: 'bedrock', boundingBox: 'block' }]) {
    bot.blockAt = (p: any) => p.equals(base.offset(0, -1, 0)) ? bad : { name: 'dirt', boundingBox: 'block', position: p }
    assert.equal(body.holePlan(bot, null, base), null)
  }
  bot.blockAt = (p: any) => p.equals(base.offset(1, -2, 0)) ? { name: 'air', boundingBox: 'empty' }
    : { name: 'dirt', boundingBox: 'block', position: p }
  assert.equal(body.holePlan(bot, null, base), null)
})

function executor({ valid = true, sealed = true, pocket = true, abort = false, handoff = false } = {}) {
  const calls: string[] = []
  const bot: any = { entity: { position: new Vec3(.5, 64, .5), onGround: true }, entities: {}, game: { dimension: 'overworld' } }
  const session: any = { bot, mcData: {}, _refugeBuild: undefined }
  const ctl: any = { aborted: false, onAbort: [], abort() { this.aborted = true } }
  const newer = { aborted: false, onAbort: [] }
  const survival = {
    holePlan() { calls.push('validate'); return valid ? { depth: 3, ms: 1200 } : null },
    refugeLook() { calls.push('look'); return { pocket: pocket && bot.entity.position.y === 61 ? 2 : 0 } },
    async refuge() {
      calls.push('refuge')
      assert.equal(bot.entity.position.y, 61, 'generic recovery cannot run before the physical descent')
      return { code: 'OK', how: 'pocket', stayed: true }
    }
  }
  const entry = { async enterShelter(s: any, control: any, options: any) {
    calls.push('dig')
    assert.equal(s._refugeBuild, control, 'only the actual bounded construction owns protection')
    assert.deepEqual(options, { depth: 3, torch: false, box: false, maxSwings: 5, center: true })
    if (abort) control.abort()
    if (handoff) { control.abort(); s._refugeBuild = newer }
    bot.entity.position.y = 61
    return { depth: 3, sealed }
  } }
  const tactics = sourceModule('tactics/minecraft', { '../survival': survival,
    '../survival/enter-shelter': entry, '../fortify': { feetCell: () => bot.entity.position.floored(),
      async centerInCell() { calls.push('center') } } })
  const system = new tactics.TacticalSystem(session)
  return { session, ctl, newer, calls, system, run: () => system.execute({ id: 'DigDown', score: 60 }, ctl, field()) }
}

test('escape progress keeps a validated blockless hole available when no run exit exists', () => {
  const f = executor(), progress = new (require('../src/tactics/escape-progress').EscapeProgress)()
  const observation = f.system.escapeObservation(field({ escapeRoute: false }))
  assert.deepEqual(observation.actions, ['DigDown'])
  assert.equal(progress.observe(observation).exhausted, false)
  const box = f.system.escapeObservation(field({ escapeRoute: false, shelter: 'BlockOff' }))
  assert.equal(progress.observe(box).exhausted, true, 'a box still requires real building material')
})

test('Enderman DigDown executes the existing hole before generic refuge recovery', async () => {
  const f = executor()
  const r = await f.run()
  assert.equal(r.code, 'OK')
  assert.ok(f.calls.indexOf('dig') < f.calls.indexOf('refuge'))
  assert.equal(f.session._refugeBuild, undefined)
})

for (const options of [{ valid: false }, { sealed: false }, { pocket: false }]) {
  test('changed physical geometry or unconfirmed shelter cannot claim completed DigDown ' + JSON.stringify(options), async () => {
    const f = executor(options), r = await f.run()
    assert.equal(r.failed, true)
    assert.equal(f.calls.includes('refuge'), false)
    assert.equal(f.session._refugeBuild, undefined)
    if ('valid' in options && !options.valid) assert.equal(f.calls.includes('dig'), false)
  })
}

test('abort after the physical dig releases only its own shelter marker', async () => {
  const f = executor({ abort: true }), r = await f.run()
  assert.equal(r.cancelled, true)
  assert.equal(f.calls.includes('refuge'), false)
  assert.equal(f.session._refugeBuild, undefined)
})

test('an emergency takeover keeps its newer construction marker', async () => {
  const f = executor({ handoff: true }), r = await f.run()
  assert.equal(r.cancelled, true)
  assert.equal(f.session._refugeBuild, f.newer)
  assert.equal(f.calls.includes('refuge'), false)
})
