import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { tuneMovements } from '../src/worlds'
import { swarmSightings } from '../src/swarm-senses'
import { placeBlockAt } from '../src/build'

function fixture() {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry), cells = new Map<string, string>()
  const ally = { id: 2, name: 'player', type: 'player', username: 'Ally', width: .6, height: 1.8, position: new Vec3(.5, 64, .5), isValid: true }
  for (const [x, z] of [[-1, 0], [0, -1], [0, 1]]) for (let y = 64; y <= 66; y++) cells.set(new Vec3(x, y, z).toString(), 'cobblestone')
  for (let x = 0; x <= 1; x++) cells.set(new Vec3(x, 66, 0).toString(), 'cobblestone')
  let calls = 0
  const bot: any = { registry, entity: { id: 1, name: 'player', width: .6, height: 1.8, position: new Vec3(2.5, 64, .5) }, entities: { 2: ally },
    game: { dimension: 'overworld', minY: -64, height: 384 },
    inventory: { items: () => [{ name: 'cobblestone', type: registry.itemsByName.cobblestone.id, count: 64 }] },
    heldItem: { name: 'cobblestone', type: registry.itemsByName.cobblestone.id },
    blockAt(p) { const at = p.floored(), b = Block.fromStateId(registry.blocksByName[cells.get(at.toString()) || (at.y < 64 ? 'stone' : 'air')].defaultState); b.position = at; return b },
    lookAt: async () => {}, waitForTicks: async () => {},
    _genericPlace: async (ref, face) => { calls++; cells.set(ref.position.plus(face).toString(), bot.heldItem.name) } }
  tuneMovements(bot, {})
  swarmSightings(bot, ['Ally'])
  return { bot, cells, ally, calls: () => calls, door: new Vec3(1, 64, 0) }
}

test('общая установка не закрывает последний выход видимому союзнику', async () => {
  const f = fixture()
  const r = await placeBlockAt(f.bot, f.door, { item: 'cobblestone', honest: true })
  assert.equal(r.ok, false)
  assert.equal(f.calls(), 0)
})

test('прямой genericPlace и повторная настройка движений сохраняют guard', async () => {
  const f = fixture(), ref = f.bot.blockAt(new Vec3(1, 63, 0))
  tuneMovements(f.bot, {})
  await assert.rejects(f.bot._genericPlace(ref, new Vec3(0, 1, 0)), /Ally/)
  assert.equal(f.calls(), 0)
})

test('своя стенка на арене тоже не закрывает последний выход поставившему', async () => {
  const f = fixture()
  f.bot.username = 'Builder'
  f.bot.entity.position = f.ally.position.clone()
  delete f.bot.entities[2]
  const r = await placeBlockAt(f.bot, f.door, { item: 'cobblestone', honest: true })
  assert.equal(r.ok, false)
  assert.equal(f.calls(), 0)
})

test('основной бот без командного контекста по-прежнему может закрыть своё укрытие', async () => {
  const f = fixture()
  f.bot.entity.position = f.ally.position.clone()
  delete f.bot.entities[2]
  swarmSightings(f.bot, [])
  const r = await placeBlockAt(f.bot, f.door, { item: 'cobblestone', honest: true })
  assert.equal(r.ok, true)
  assert.equal(f.calls(), 1)
})

test('второй выход оставляет разрешённой стенку в первом', async () => {
  const f = fixture()
  for (let y = 64; y <= 66; y++) f.cells.delete(new Vec3(0, y, 1).toString())
  const r = await placeBlockAt(f.bot, f.door, { item: 'cobblestone', honest: true })
  assert.equal(r.ok, true)
  assert.equal(f.calls(), 1)
})

test('уже запертый союзник не запрещает постороннюю помощь', async () => {
  const f = fixture()
  f.cells.set(f.door.toString(), 'cobblestone')
  await f.bot._genericPlace(f.bot.blockAt(new Vec3(2, 63, 1)), new Vec3(0, 1, 0))
  assert.equal(f.calls(), 1)
})

test('доступный прыжок на новый блок сохраняет выход', async () => {
  const f = fixture()
  for (let x = 0; x <= 1; x++) f.cells.delete(new Vec3(x, 66, 0).toString())
  const r = await placeBlockAt(f.bot, f.door, { item: 'cobblestone', honest: true })
  assert.equal(r.ok, true)
  assert.equal(f.calls(), 1)
})

test('скрытый союзник не запускает проверку его невидимых проходов', async () => {
  const f = fixture()
  for (let y = 64; y <= 65; y++) f.cells.set(new Vec3(1, y, 0).toString(), 'cobblestone')
  const read = f.bot.blockAt
  f.bot.blockAt = p => { assert.ok(p.x >= 1, 'нельзя читать скрытый проход союзника'); return read(p) }
  await f.bot._genericPlace(f.bot.blockAt(new Vec3(2, 63, 1)), new Vec3(0, 1, 0))
  assert.equal(f.calls(), 1)
})

test('новый список команды исключает бывшего союзника из запрета', async () => {
  const f = fixture()
  swarmSightings(f.bot, [])
  await f.bot._genericPlace(f.bot.blockAt(new Vec3(1, 63, 0)), new Vec3(0, 1, 0))
  assert.equal(f.calls(), 1)
})
