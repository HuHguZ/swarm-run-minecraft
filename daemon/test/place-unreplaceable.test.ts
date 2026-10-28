import test from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { tuneMovements } from '../src/worlds'
import { swarmSightings } from '../src/swarm-senses'
import { placeBlockAt } from '../src/build'

// sr27 full: коробка на месте — «ответа от сервера нет» 520+ раз. Сервер (BlockPlaceContext.canPlace → canBeReplaced) не
// ставит блок в клетку с незаменимым растением или факелом (тег minecraft:replaceable 1.21.11 их не содержит), а клетка
// с пустой рамкой выглядела свободной. Ночью «свет» ставит факел у ног, следом коробка — стену в клетку факела.
function fixture(occupant: string) {
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry), cells = new Map<string, string>()
  const target = new Vec3(1, 64, 0)
  cells.set(target.toString(), occupant)
  const dug: string[] = []
  const bot: any = { registry, entity: { id: 1, name: 'player', width: .6, height: 1.8, position: new Vec3(.5, 64, .5) }, entities: {},
    game: { dimension: 'overworld', minY: -64, height: 384 },
    inventory: { items: () => [{ name: 'cobblestone', type: registry.itemsByName.cobblestone.id, count: 64 }] },
    heldItem: { name: 'cobblestone', type: registry.itemsByName.cobblestone.id },
    blockAt(p) { const at = p.floored(), b = Block.fromStateId(registry.blocksByName[cells.get(at.toString()) || (at.y < 64 ? 'stone' : 'air')].defaultState); b.position = at; return b },
    lookAt: async () => {}, look: async () => {}, waitForTicks: async () => {},
    dig: async (b) => { dug.push(b.name); cells.delete(b.position.toString()) },
    // Сервер: в незаменимую клетку не ставит (пакет ушёл, блок не появился).
    _genericPlace: async (ref, face) => {
      const at = ref.position.plus(face), here = cells.get(at.toString()) || 'air'
      if (!registry.blocksByName[here] || !/^(air|short_grass|snow)$/.test(here)) return
      cells.set(at.toString(), bot.heldItem.name)
    } }
  tuneMovements(bot, {})
  swarmSightings(bot, [])
  return { bot, cells, target, dug }
}

for (const occupant of ['torch', 'poppy', 'oak_sapling']) test(`стена в клетку с ${occupant}: сорвать и поставить`, async () => {
  const f = fixture(occupant)
  const r = await placeBlockAt(f.bot, f.target, { item: 'cobblestone', honest: true, timeoutMs: 200 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(f.dug, [occupant])
  assert.equal(f.cells.get(f.target.toString()), 'cobblestone')
})

test('заменимая трава не ломается — блок ставится поверх', async () => {
  const f = fixture('short_grass')
  const r = await placeBlockAt(f.bot, f.target, { item: 'cobblestone', honest: true, timeoutMs: 200 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(f.dug, [])
})
