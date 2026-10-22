import test from 'node:test'
import assert from 'node:assert/strict'
import { tntCharges } from '../src/tactics/blast'
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(data as any)

// Горящий динамит у ног и блоки динамита по следу: видимые — в цепочке (фитиль поджигателя + 10), за стеной — нет (не рентген).
function bot(cells: Map<string, string>) {
  return { registry: data, game: { dimension: 'overworld' }, entity: { position: new Vec3(.5, 64, .5) },
    entities: { 7: { id: 7, name: 'tnt', position: new Vec3(3.5, 64, .5), metadata: { [data.entitiesByName.tnt.metadataKeys.indexOf('fuse')]: 20 } } },
    blockAt(p) { const at = p.floored(); const b = Block.fromStateId(data.blocksByName[cells.get(at.toString()) || 'air'].defaultState, 0); b.position = at; return b },
    findBlocks({ matching }) { return [...cells].filter(([, n]) => data.blocksByName[n].id === matching).map(([k]) => new Vec3(...(k.slice(1, -1).split(',').map(Number) as [number, number, number]))) } }
}

test('a seen TNT block next to a primed charge joins the chain; one behind a wall does not', () => {
  const cells = new Map([[new Vec3(5, 64, 0).toString(), 'tnt'], [new Vec3(3, 64, 4).toString(), 'tnt']])
  for (const y of [64, 65, 66]) for (const x of [2, 3, 4]) cells.set(new Vec3(x, y, 3).toString(), 'stone')
  const charges = tntCharges(bot(cells))
  assert.deepEqual(charges.map(c => [c.primed, c.fuse]), [[true, 20], [false, 30]])
  assert.equal(charges[1].position.x, 5.5)
})
