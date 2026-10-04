'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const Vec3 = require('vec3')

function scene ({ blockedAll = false, hazard = false, drop = false } = {}) {
  const file = path.join(__dirname, '../src/fortify.js')
  const realRequire = createRequire(file)
  const breaks = []
  const bot = { blockAt: p => {
    const outside = Math.abs(p.x) + Math.abs(p.z) === 2
    // drop: за стенами обрыв — под внешними клетками нет пола.
    if (drop && p.y === -1 && Math.abs(p.x) + Math.abs(p.z) >= 2) return { name: 'air', boundingBox: 'empty', position: p }
    const blocked = outside && (blockedAll || p.x === 2)
    return { name: outside && hazard ? 'lava' : p.y < 0 || blocked || (!outside && (Math.abs(p.x) + Math.abs(p.z) === 1)) ? 'netherrack' : 'air',
      boundingBox: p.y < 0 || blocked || (!outside && Math.abs(p.x) + Math.abs(p.z) === 1) ? 'block' : 'empty', position: p }
  } }
  const context = { module: { exports: {} }, console,
    require: name => name === './tools' ? { bestFor: () => ({ ms: 100 }), breakFast: async (_bot, p) => { breaks.push(p); return { ok: true } } } : realRequire(name) }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context)
  return { bot, breaks, exit: context.module.exports.breakOut }
}

test('выход из коробки открывает стену в сторону свободного прохода, а не следующей стены', async () => {
  const s = scene()
  const result = await s.exit(s.bot, new Vec3(0, 0, 0))
  assert.equal(result.ok, true)
  assert.notEqual(result.side.x, 1, 'дешёвая дыра перед глухой стеной не является выходом')
  assert.equal(s.breaks.length, 2)
})

test('коробка без безопасного прохода не открывается в стену или лаву', async () => {
  for (const config of [{ blockedAll: true }, { hazard: true }]) {
    const s = scene(config)
    const result = await s.exit(s.bot, new Vec3(0, 0, 0))
    assert.equal(result.ok, false)
    assert.equal(s.breaks.length, 0)
  }
})

test('за стеной обрыв — выход в сам пролом, если под ним пол и лавы нет', async () => {
  const s = scene({ drop: true })
  const result = await s.exit(s.bot, new Vec3(0, 0, 0))
  assert.equal(result.ok, true)
  assert.equal(s.breaks.length, 2)
  assert.deepEqual([result.outside.x, result.outside.y, result.outside.z], [result.exit.x, result.exit.y, result.exit.z])
})
