import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

// Настоящий RPC handler без bootstrap демона, сокетов и подключения к миру.
const indexPath = join(__dirname, '../src/index.js')
const source = readFileSync(indexPath, 'utf8')
const body = source.slice(source.indexOf('const methods = {'), source.indexOf('const wss ='))
function status(bot: any) {
  const methods = runInNewContext(body + '\nmethods', {
    session: { bot, immediate: (fn: any) => fn() }, cfg: {}, require: createRequire(indexPath)
  })
  return methods.status
}

test('Arms status: по запросу возвращает собственные заряды, звёзды и все слоты снаряжения', async () => {
  const slots = Array(46).fill(null)
  slots[0] = { name: 'diamond', count: 1 } // Результат крафта ещё не принадлежит инвентарю.
  slots[5] = { name: 'iron_helmet', count: 1 }
  slots[10] = { name: 'crossbow', count: 1, componentMap: new Map([['charged_projectiles', { data: {
    projectiles: [{ name: 'firework_rocket', components: [{ type: 'fireworks', data: { explosions: [{}, {}] } }] }]
  } }]]) }
  slots[36] = { name: 'firework_rocket', count: 7, componentMap: new Map([['fireworks', { data: { explosions: [{}, {}, {}] } }]]) }
  slots[45] = { name: 'spectral_arrow', count: 12 }
  const run = status({ inventory: { slots } })
  assert.equal((await run({})).items, undefined, 'описание инвентаря — только по запросу')
  const { items } = await run({ items: true })
  assert.deepEqual(Array.from(items, (item: any) => item.name), ['iron_helmet', 'crossbow', 'firework_rocket', 'spectral_arrow'])
  assert.equal(items[1].crossbow.loaded, true)
  assert.equal(items[1].crossbow.ammo, 'firework')
  assert.equal(items[1].crossbow.stars, 2)
  assert.equal(items[2].stars, 3)
  assert.equal(items[2].count, 7)
  assert.equal(items[3].count, 12)
})

test('Arms status: нет подключения — нет выдуманного собственного инвентаря', async () => {
  const result = await status(null)({ items: true })
  assert.equal(result.items.length, 0)
})
