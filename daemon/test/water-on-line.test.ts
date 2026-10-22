import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerrain } from '../src/pvp/terrain'
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// Ров между ботом и целью на арене: глубокая вода на линии — помеха (мост на бегу), мелкая — нет; блоков нет — вплавь.
function ctx (cells: Map<string, string>, env: Record<string, string>, filler: any) {
  const name = (p: any) => cells.get(p.floored().toString()) || 'air'
  const c: any = {
    Vec3, process: { env }, gameClock: { now: () => 1000 }, EYE: 1.62,
    bot: { entity: { position: new Vec3(.5, 64, .5) }, blockAt: (p: any) => ({ name: name(p), boundingBox: /air|water/.test(name(p)) ? 'empty' : 'block' }) },
    entity: { position: new Vec3(6.5, 64, .5) }, blockName: (_b: any, p: any) => name(p),
    clear () {}, used (w: string) { c.said = w }, holdWeapon: async () => {}, pickFiller: () => filler,
    placeBlockAt: async () => ({ ok: true })
  }
  const t = createTerrain(c)
  c.hazardOnLine = t.hazardOnLine
  return { c, t }
}
function moat (deep: boolean) {
  const cells = new Map<string, string>()
  for (let x = 0; x <= 7; x++) for (const y of [62, 63]) cells.set(new Vec3(x, y, 0).toString(), 'stone')
  for (let x = 2; x <= 4; x++) { cells.set(new Vec3(x, 63, 0).toString(), 'water'); if (deep) cells.set(new Vec3(x, 62, 0).toString(), 'water') }
  return cells
}

test('deep water between us is a gap on the arena only; a puddle is not', () => {
  assert.deepEqual(ctx(moat(true), { ND_SCAFFOLD_ANY: '1' }, null).t.hazardOnLine(), { cell: new Vec3(2, 63, 0), kind: 'water' })
  assert.equal(ctx(moat(true), {}, null).t.hazardOnLine(), null)
  assert.equal(ctx(moat(false), { ND_SCAFFOLD_ANY: '1' }, null).t.hazardOnLine(), null)
})

test('without blocks a bot swims across instead of standing at the edge', async () => {
  const bare = ctx(moat(true), { ND_SCAFFOLD_ANY: '1' }, null)
  assert.equal(await bare.t.unblockPath(), true)
  assert.equal(bare.c.bot._ndSwimUntil, 4000)
  assert.equal(bare.c.said, 'вода между нами — вплавь')
})
