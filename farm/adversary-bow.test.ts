import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { REPO_ROOT } from '../daemon/src/paths'
import { blockOnRay } from '../daemon/src/pick'

const { Vec3 } = require(path.join(REPO_ROOT, 'daemon/node_modules/vec3'))
const { transformSync } = require('esbuild')
const source = fs.readFileSync(process.env.ND_ADVERSARY_BOW_TEST_SOURCE || path.join(REPO_ROOT, 'farm/arena/adversary.ts'), 'utf8')
const fn = source.match(/async function bow\s*\(\) \{[\s\S]*?\n\}/)?.[0]
assert.ok(fn)
async function run(kind = 'clear', candidates = [new Vec3(40, 120, 0)]) {
  let now = 50000, moved = false
  const players = candidates.map((p, n) => ({ id: n + 2, username: `NeuroFarm31${n}`, position: p, isValid: true }))
  const dead = new Map(), commands: string[] = []
  const stone = { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }, air = { name: 'air', boundingBox: 'empty', shapes: [] }
  const blockAt = (p: any) => kind === 'unknown' || kind === 'unknown-ray' && p.y === 121 ? null : kind === 'blocked' ? stone :
    kind === 'unsupported' ? air : kind === 'hazard' && p.y === 120 ? { ...air, name: 'water' } :
      kind.startsWith('support-') && p.y < 120 ? { ...stone, name: kind.slice('support-'.length) } :
      kind === 'wall' && p.y >= 120 && Math.floor(p.x) % 4 === 0 ? stone : p.y < 120 ? stone : air
  const bot: any = { entity: { position: new Vec3(0, 120, 0) }, entities: {}, inventory: { items: () => [{ name: 'arrow' }] }, blockAt }
  const dist = (e: any) => e.position.distanceTo(bot.entity.position)
  const sandbox: any = { bot, dead, NAME: 'Tester', Vec3, hurt: new Map(), Date: { now: () => now },
    require: (name: string) => { assert.equal(name, '../../daemon/src/pick'); return { blockOnRay } },
    setMode: async () => {}, immortal: async () => {}, hold: async () => true, hpOf: async () => 20,
    foes: () => players, dist, sees: () => !(moved && kind === 'lost-sight'),
    nearest: (pred: any = () => true) => players.filter(pred).sort((a, b) => dist(a) - dist(b))[0],
    cmd: async (command: string) => { commands.push(command); const m = /^tp Tester (\S+) (\S+) (\S+)$/.exec(command); if (m) {
      moved = true; bot.entity.position = new Vec3(+m[1], +m[2], +m[3]); if (kind === 'died-during-tp') dead.set(players[0].username, 1)
    } return '' }, sleep: async (ms: number) => { now += ms } }
  vm.runInNewContext(transformSync(fn, { loader: 'ts', target: 'node22' }).code + '\nthis.runScene = bow', sandbox)
  return { result: await sandbox.runScene(), commands, bot }
}
test('bow reaches a known supported clear firing point when the initial scene has no target', async () => {
  const actual = await run()
  assert.ok(!actual.result.skip, 'the clear candidate must produce a real target')
  assert.equal(actual.commands.length, 1); assert.ok(actual.commands[0].startsWith('tp Tester '))
  assert.equal(actual.result.died, false)
})
test('bow keeps an initially eligible target without teleporting', async () => {
  const actual = await run('clear', [new Vec3(20, 120, 0)])
  assert.ok(!actual.result.skip); assert.deepEqual(actual.commands, [])
})
for (const kind of ['blocked', 'unknown', 'unknown-ray', 'unsupported', 'hazard', 'wall', 'support-magma_block', 'support-campfire', 'support-cactus']) test(`bow refuses an unsafe fallback (${kind})`, async () => {
  const actual = await run(kind)
  assert.ok(actual.result.skip); assert.deepEqual(actual.commands, [])
})
test('bow searches another nearby target when the closest has no supported firing ring', async () => {
  const actual = await run('clear', [new Vec3(40, 140, 0), new Vec3(60, 120, 0)])
  assert.ok(!actual.result.skip); assert.equal(actual.result.name, 'NeuroFarm311'); assert.equal(actual.commands.length, 1)
})
test('bow bounds fallback target setup to eight nearby actors', async () => {
  const actual = await run('clear', [...Array.from({ length: 8 }, (_, n) => new Vec3(40 + n, 140, 0)), new Vec3(70, 120, 0)])
  assert.ok(actual.result.skip); assert.deepEqual(actual.commands, [])
})
for (const kind of ['lost-sight', 'died-during-tp']) test(`bow rechecks target state after its own teleport (${kind})`, async () => {
  const actual = await run(kind)
  assert.ok(actual.result.skip); assert.equal(actual.commands.length, 1)
})
