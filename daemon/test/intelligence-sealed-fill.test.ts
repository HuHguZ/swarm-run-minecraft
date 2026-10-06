const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const esbuild = require('esbuild')
const { Vec3 } = require('vec3')
type Vector = import('vec3').Vec3

const sourceCache = new Map<string, { exports: unknown }>()
function sourceModule(name: string): unknown {
  const filename = path.join(__dirname, '../src', name + '.ts')
  const cached = sourceCache.get(filename)
  if (cached) return cached.exports
  const mod = { exports: {} }
  sourceCache.set(filename, mod)
  const localRequire = createRequire(filename)
  const sourceRequire = (request: string) => /^\.\/(sealed|build|pick)$/.test(request)
    ? sourceModule(request.slice(2)) : localRequire(request)
  vm.runInNewContext(esbuild.transformSync(fs.readFileSync(filename, 'utf8'),
    { loader: 'ts', format: 'cjs', target: 'node24' }).code,
  { module: mod, require: sourceRequire, process, console, setImmediate, performance, Buffer })
  return mod.exports
}
const sealed = sourceModule('sealed') as { fillCell(bot: unknown, position: Vector): Promise<boolean> }
const pick = sourceModule('pick') as { faceAim(bot: unknown, ref: Vector, face: Vector): Vector | null }

function placementFixture(hidden: boolean, unavailable = false) {
  const blocks = new Map<string, string>()
  const target = new Vec3(2, 1, 0)
  const reference = target.offset(0, -1, 0)
  const key = (p: Vector) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  blocks.set(key(reference), 'blackstone')
  if (hidden) for (let y = 0; y <= 2; y++) for (let z = -1; z <= 1; z++) blocks.set(`1,${y},${z}`, 'blackstone')
  let packets = 0
  const filler = { name: 'netherrack', type: 1, count: 8 }
  const bot = {
    entity: { position: new Vec3(0.5, 0, 0.5) }, entities: {},
    heldItem: filler, inventory: { items: () => unavailable ? [] : [filler] },
    blockAt(position: Vector) {
      const name = blocks.get(key(position)) || 'air'
      return { name, position: position.floored(), boundingBox: name === 'air' ? 'empty' : 'block',
        shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] }
    },
    async lookAt() {},
    async placeBlock(ref: { position: Vector }, face: Vector) {
      packets++
      blocks.set(key(ref.position.plus(face)), 'netherrack')
    }
  }
  return { bot, target, reference, packets: () => packets }
}

test('sealed closure refuses a reference hidden by a wall using the real client pick', async () => {
  const fixture = placementFixture(true)
  assert.equal(pick.faceAim(fixture.bot, fixture.reference, new Vec3(0, 1, 0)), null)
  assert.equal(await sealed.fillCell(fixture.bot, fixture.target), false)
  assert.equal(fixture.packets(), 0, 'no placement packet may cross the wall')
})

test('sealed closure keeps visible placement and unavailable filler contracts', async () => {
  const visible = placementFixture(false)
  assert.ok(pick.faceAim(visible.bot, visible.reference, new Vec3(0, 1, 0)))
  assert.equal(await sealed.fillCell(visible.bot, visible.target), true)
  assert.equal(visible.packets(), 1)
  const unavailable = placementFixture(false, true)
  assert.equal(await sealed.fillCell(unavailable.bot, unavailable.target), false)
  assert.equal(unavailable.packets(), 0)
})
