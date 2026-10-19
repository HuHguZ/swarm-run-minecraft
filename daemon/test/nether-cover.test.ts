'use strict'
// Закрытый штрек Ада (nether-cover.around): что видно вокруг новых клеток штрека — проёмы, жидкость под заклад, золото в стенах.
// Скрытое за стеной решений не меняет (только видимое, endportal-descent.seen).
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')

// Мир из настоящих чанков 1.21.11 (как в s5e-endgame): незерак y 0..70, воздух выше.
function world (fill: (x: number, y: number, z: number) => string | null = () => null) {
  const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
  const Chunk = (require('prismarine-chunk') as typeof import('prismarine-chunk').default)(registry)
  const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
  const columns = new Map()
  const w: any = {}
  w.getColumn = (cx: number, cz: number) => {
    if (Math.abs(cx) > 2 || Math.abs(cz) > 2) return null
    const k = `${cx},${cz}`
    if (!columns.has(k)) {
      const c = new Chunk({ minY: 0, worldHeight: 256 } as any)
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 0; y <= 70; y++) {
        c.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[fill(cx * 16 + x, y, cz * 16 + z) || 'netherrack'].defaultState)
      }
      columns.set(k, c)
    }
    return columns.get(k)
  }
  const get = (x: number, y: number, z: number) => { const c = w.getColumn(x >> 4, z >> 4); return c ? c.getBlockStateId(new Vec3(x & 15, y, z & 15)) : null }
  const set = (p: any, n: string) => w.getColumn(p.x >> 4, p.z >> 4).setBlockStateId(new Vec3(p.x & 15, p.y, p.z & 15), registry.blocksByName[n].defaultState)
  const bot: any = {
    registry,
    game: { minY: 0, height: 256, dimension: 'the_nether' },
    entity: { position: new Vec3(0.5, 60, 0.5), eyeHeight: 1.62, height: 1.8 },
    world: w,
    health: 20,
    blockAt: (p: any) => { const s = get(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); if (s === null) return null; const b = Block.fromStateId(s, 0); b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b }
  }
  return { bot, set }
}

// Тело на (0,60,0)–(0,61,0), забой на восток (1,60,0)–(1,61,0) уже вскрыт.
const body = [new Vec3(0, 60, 0), new Vec3(0, 61, 0)]
const cells = [new Vec3(1, 61, 0), new Vec3(1, 60, 0)]
function tunnel (W: any) { for (const p of [...body, ...cells]) W.set(p, 'air') }
const xyz = (q: any) => [q.x, q.y, q.z]

test('штрек: порода вокруг — проёмов нет; пещера и лава дальше стены решений не меняют', () => {
  const { around }: typeof import('../src/nether-cover') = require('../src/nether-cover')
  const A = world(); tunnel(A)
  const B = world((x, y, z) => (x === 3 && y >= 59 && y <= 62 && Math.abs(z) <= 1 ? 'air' : x === 1 && z === 2 && y === 60 ? 'lava' : null)); tunnel(B)
  const a = around(A.bot, cells, body); const b = around(B.bot, cells, body)
  assert.equal(a.open.length + a.wet.length + a.gold.length, 0)
  assert.deepEqual(b, a)
})

test('штрек: пещера сразу за забоем — проёмы впереди (устье), снизу вверх', () => {
  const { around }: typeof import('../src/nether-cover') = require('../src/nether-cover')
  const W = world((x, y, z) => (x >= 2 && x <= 5 && y >= 59 && y <= 63 && Math.abs(z) <= 2 ? 'air' : null)); tunnel(W)
  const a = around(W.bot, cells, body)
  assert.deepEqual(a.open.map(xyz), [[2, 60, 0], [2, 61, 0]])
})

test('штрек: лава у забоя — под заклад, руда золота в стене — к копке, портал — не проём', () => {
  const { around }: typeof import('../src/nether-cover') = require('../src/nether-cover')
  const W = world((x, y, z) => (x === 1 && z === 1 && y === 60 ? 'lava' : x === 1 && z === -1 && y === 61 ? 'nether_gold_ore' : x === 1 && y === 62 && z === 0 ? 'nether_portal' : null)); tunnel(W)
  const a = around(W.bot, cells, body)
  assert.deepEqual(a.wet.map(xyz), [[1, 60, 1]])
  assert.deepEqual(a.gold.map(xyz), [[1, 61, -1]])
  assert.equal(a.open.length, 0)
})


test('neP-1: liquid in the body cannot be reported as a sealed healing pocket', async () => {
  const W = world()
  W.set(new Vec3(0,60,0), 'lava'); W.set(new Vec3(0,61,0), 'lava')
  W.bot.entity.isInLava = true
  const result = await (require('../src/nether-cover') as typeof import('../src/nether-cover')).coverHere({ bot: W.bot }, { aborted: false })
  assert.equal(result.ok, false)
  assert.equal(result.sealed, false)
})
