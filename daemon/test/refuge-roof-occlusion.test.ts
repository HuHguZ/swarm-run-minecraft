import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import Module from 'node:module'

const sourceDir = path.resolve(__dirname, '../src')
const sourceRequire = Module.createRequire(path.join(sourceDir, 'fortify.ts'))
const { Vec3 } = sourceRequire('vec3')
const esbuild = require('esbuild')

function scene(options: any = {}) {
  let ms = 0, hits = 0, placements = 0
  const cache = new Map<string, any>(), timers = new Set<any>()
  const ctl = { aborted: !!options.aborted, onAbort: [] }
  const cells = new Map<string, any>()
  const cell = new Vec3(0, 10, 0)
  const block = (p: any, name: string) => ({ name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] })
  const set = (p: any, name: string) => cells.set(p.toString(), block(p, name))
  for (let x = -4; x <= 4; x++) for (let y = 8; y <= 15; y++) for (let z = -4; z <= 4; z++) set(new Vec3(x, y, z), y < 10 ? 'dirt' : 'air')
  for (const s of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) for (const y of [0, 1]) set(cell.plus(s).offset(0, y, 0), 'cobblestone')
  const anchors = [cell.offset(1, 2, 0), cell.offset(0, 2, 1)]
  for (const p of anchors) set(p, 'jungle_leaves')
  const items = [{ name: 'dirt', count: 7, type: 1 }, { name: 'stone_sword', count: 1, type: 2 }]
  const entity = { id: 1, position: cell.offset(.53, 0, .53), onGround: true, height: 1.8, width: .6 }
  const zombie = { id: 2, name: options.neutral ? 'cow' : 'zombie', position: entity.position.offset(-.2, 0, -.2), height: 1.95, width: .6, _ndVisible: !options.unseen }
  const bot: any = { registry: sourceRequire('prismarine-registry')('1.21.11'), entity, health: 20, entities: options.noMob ? { 1: entity } : { 1: entity, 2: zombie }, inventory: { items: () => items }, heldItem: options.loseAnchors ? null : items[0],
    blockAt: (p: any) => cells.get(p.floored().toString()), getControlState: () => false, setControlState() {}, look: async () => {}, lookAt: async () => {},
    equip: async (item: any) => { bot.heldItem = item; if (options.loseAnchors) for (const p of anchors) set(p, 'air') },
    attack(target: any) { hits++; delete bot.entities[target.id] },
    async placeBlock(ref: any, face: any) { placements++; set(ref.position.plus(face), 'dirt') }
  }
  const clock = { now: () => ms, setTimeout(fn: any, delay: number) { const id = setTimeout(fn, delay); timers.add(id); return id }, clearTimeout(id: any) { clearTimeout(id); timers.delete(id) } }
  const sleep = async (delay: number) => { ms += delay; if (options.abortAfterHit && hits) ctl.aborted = true }
  const itemHelpers = { itemNamed: (_bot: any, name: string) => items.find(i => i.name === name), itemMatching: (_bot: any, re: RegExp) => items.find(i => re.test(i.name)), bestWeapon: () => items[1] }
  function load(name: string): any {
    if (cache.has(name)) return cache.get(name)
    const file = path.join(sourceDir, name + '.ts'), mod = { exports: {} }
    cache.set(name, mod.exports)
    const localRequire = (id: string) => {
      if (id === './game-clock') return clock
      if (id === './movement') return { sleep }
      if (id === './items') return itemHelpers
      if (id === './worlds') return { worldOf: () => 'overworld' }
      if (id === './pick' || id === './build') return load(id.slice(2))
      return sourceRequire(id)
    }
    const source = esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code
    new vm.Script(Module.wrap(source), { filename: file }).runInThisContext()(mod.exports, localRequire, mod, file, sourceDir)
    cache.set(name, mod.exports); return mod.exports
  }
  const fortify = load('fortify'), pick = load('pick')
  return { bot, cell, ctl, fortify, pick, set, anchors, metrics: () => ({ hits, placements, ms }), close: () => { for (const id of timers) clearTimeout(id) } }
}

test('roof retries an honest nearby hostile occluding existing leaves anchors', async () => {
  const s = scene()
  try {
    assert.deepEqual(s.fortify.refugePlan(s.bot, s.cell).map((p: any) => p.kind), ['roof'])
    assert.equal(s.pick.faceAim(s.bot, s.anchors[0], new Vec3(-1, 0, 0)), null)
    const result = await s.fortify.refugeBox(s.bot, s.cell, { ctl: s.ctl })
    assert.equal(result.sealed, true)
    assert.deepEqual(s.metrics(), { hits: 1, placements: 1, ms: 250 })
  } finally { s.close() }
})

test('an unobstructed roof places without attacking', async () => {
  const s = scene({ noMob: true })
  try { const r = await s.fortify.refugeBox(s.bot, s.cell, { ctl: s.ctl }); assert.equal(r.sealed, true); assert.equal(s.metrics().hits, 0) } finally { s.close() }
})

test('losing the real roof anchors does not turn missing support into an attack', async () => {
  const s = scene({ loseAnchors: true })
  try { const r = await s.fortify.refugeBox(s.bot, s.cell, { ctl: s.ctl }); assert.equal(r.sealed, false); assert.equal(s.metrics().hits, 0); assert.equal(s.metrics().placements, 0) } finally { s.close() }
})

test('a cancelled build does not attack or place', async () => {
  const s = scene({ aborted: true })
  try { await s.fortify.refugeBox(s.bot, s.cell, { ctl: s.ctl }); assert.equal(s.metrics().hits, 0); assert.equal(s.metrics().placements, 0) } finally { s.close() }
})

test('cancellation during knockback wait prevents the roof placement', async () => {
  const s = scene({ abortAfterHit: true })
  try { const r = await s.fortify.refugeBox(s.bot, s.cell, { ctl: s.ctl }); assert.equal(s.metrics().hits, 1); assert.equal(s.metrics().placements, 0); assert.equal(r.sealed, false) } finally { s.close() }
})

for (const [name, options] of [['unseen hostile', { unseen: true }], ['neutral animal', { neutral: true }]] as const) test(`${name} is not attacked to close the roof`, async () => {
  const s = scene(options)
  try { const r = await s.fortify.refugeBox(s.bot, s.cell, { ctl: s.ctl }); assert.equal(s.metrics().hits, 0); assert.equal(s.metrics().placements, 0); assert.equal(r.sealed, false) } finally { s.close() }
})
