import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { REPO_ROOT } from '../daemon/src/paths'

const { Vec3 } = require(path.join(REPO_ROOT, 'daemon/node_modules/vec3'))
const { transformSync } = require('esbuild')
const source = fs.readFileSync(process.env.ND_ADVERSARY_TEST_SOURCE || path.join(REPO_ROOT, 'farm/arena/adversary.ts'), 'utf8')
const modes = ['rush', 'undermine', 'tnt', 'mace', 'bow', 'web', 'tntlate', 'room']

async function scene(mode: string, priorDeath: boolean, newDeath: boolean) {
  const fn = source.match(new RegExp(`async function ${mode}\\s*\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0]
  assert.ok(fn, 'exercise the actual standalone scene without connecting its client')
  const target = { id: 2, username: 'NeuroFarm31z', position: new Vec3(12, 120, 0), yaw: 0, metadata: [] }
  const dead = new Map(priorDeath ? [[target.username, 100]] : []), mainPeriod = ({ rush: 50, undermine: 100, tnt: 400, mace: 50, bow: 50, web: 50, tntlate: 50, room: 50 })[mode]
  let now = 50000, selected = false, changed = false, mainSleeps = 0
  // An actual native death during the first await AFTER target selection must
  // remain part of this scene, including hp/equipment/teleport preparation.
  const targetAwait = () => { if (selected && newDeath && !changed) { changed = true; dead.set(target.username, 101) } }
  const bot: any = { entity: { position: new Vec3(0, 120, 0), velocity: new Vec3(0, -.5, 0), onGround: false }, entities: { 2: target },
    inventory: { items: () => [{ name: 'arrow' }] }, creative: { startFlying() {} },
    pathfinder: { setGoal() {} }, clearControlStates() {}, setControlState() {},
    lookAt: async () => {}, attack() {}, activateItem() {}, deactivateItem() {}, dig: async () => {},
    blockAt: (p: any) => ({ name: mode === 'web' ? 'cobweb' : 'stone', boundingBox: p.y < 120 || mode === 'room' && p.y >= 122 ? 'block' : 'empty' }),
    world: { raycast: () => null } }
  const sandbox: any = { bot, dead, NAME: 'Tester', Vec3, tick: 1000, freezes: [], swings: new Map(), hurt: new Map(), watch: new Map(),
    Date: { now: () => now }, goals: { GoalFollow: class {} },
    setMode: async () => {}, immortal: async () => {}, hold: async () => { targetAwait(); return true }, hpOf: async () => { targetAwait(); return 20 },
    cmd: async () => { targetAwait(); return '' }, nearest: () => { selected = true; return target },
    dist: () => 12, sees: () => true, openSky: () => true, handActive: () => false, eye: () => bot.entity.position.offset(0, 1.62, 0),
    stop() {}, say() {}, sleep: async (ms: number) => { now += ms; if (ms === mainPeriod) mainSleeps++; if (mode === 'web') target.position = target.position.offset(2, 0, 0) } }
  vm.runInNewContext(transformSync(fn, { loader: 'ts', target: 'node22' }).code + `\nthis.runScene = ${mode}`, sandbox)
  const result = await sandbox.runScene()
  return { result, mainSleeps, dead, changed }
}

for (const mode of modes) {
  test(`${mode}: a prior round death does not stop a living target's new scene`, async () => {
    const actual = await scene(mode, true, false)
    assert.ok(actual.mainSleeps > 0, 'the current observation must run despite the old death receipt')
    if ('died' in actual.result) assert.equal(actual.result.died, false, 'an old death is not a new scene death')
    assert.equal(actual.dead.get('NeuroFarm31z'), 100, 'do not clear shared death history')
  })
  for (const priorDeath of [false, true]) test(`${mode}: a new death during target preparation stops the scene (prior=${priorDeath})`, async () => {
    const actual = await scene(mode, priorDeath, true)
    assert.equal(actual.changed, true)
    assert.equal(actual.mainSleeps, 0, 'capture the baseline before the first target await, then stop on the new receipt')
    if ('died' in actual.result) assert.equal(actual.result.died, true)
    assert.equal(actual.dead.get('NeuroFarm31z'), 101)
  })
}
