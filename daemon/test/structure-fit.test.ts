'use strict'
// Узнавание построек по шаблонам jar 1.21.11 (structure-fit): шаблон, поставленный в мир настоящих чанков с известным
// поворотом и сдвигом, узнаётся по видимому, и сундуки шаблона ложатся на свои клетки; за стеной ничего не читается.
import test = require('node:test')
import assert = require('node:assert/strict')
import { EventEmitter } from 'events'
import { Vec3 } from 'vec3'
import * as F from '../src/structure-fit'

const CH = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&()*+,-/:;<=>?@[]^_`{|}~'

function world (floor = 'sand', B = { x: 0, z: 0 }) {
  const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
  const Chunk: any = (require('prismarine-chunk') as typeof import('prismarine-chunk').default)(registry)
  const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
  const columns = new Map()
  const w: any = new EventEmitter()
  w.getColumn = (cx, cz) => {
    if (Math.abs(cx - (B.x >> 4)) > 5 || Math.abs(cz - (B.z >> 4)) > 5) return null
    const k = `${cx},${cz}`
    if (!columns.has(k)) columns.set(k, new Chunk({ minY: -64, worldHeight: 384 }))
    return columns.get(k)
  }
  const set = (x, y, z, n) => w.getColumn(x >> 4, z >> 4).setBlockStateId(new Vec3(x & 15, y, z & 15), registry.blocksByName[n].defaultState)
  const get = (x, y, z) => { const c = w.getColumn(x >> 4, z >> 4); return c ? c.getBlockStateId(new Vec3(x & 15, y, z & 15)) : null }
  for (let x = B.x - 40; x < B.x + 56; x++) for (let z = B.z - 40; z < B.z + 56; z++) for (let y = 55; y <= 63; y++) set(x, y, z, floor)
  const bot: any = new EventEmitter()
  Object.assign(bot, {
    registry,
    version: '1.21.11',
    game: { minY: -64, height: 384, dimension: 'overworld' },
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, height: 1.8, yaw: 0, pitch: 0 },
    entities: {},
    world: w,
    blockAt: p => { const s = get(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); if (s === null) return null; const b = Block.fromStateId(s, 0); b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b }
  })
  return { bot, set, get, registry }
}

// Поставить шаблон с поворотом r, зеркалом m и сдвигом t (как StructureTemplate.transform без pivot).
function place (W, name, h) {
  const T = F.lib()[name]
  const [X, Y, Z] = T.size
  for (let y = 0; y < Y; y++) {
    for (let z = 0; z < Z; z++) {
      for (let x = 0; x < X; x++) {
        const ch = T.grid[x + X * (z + Z * y)]
        if (ch === ' ') continue
        const n = T.pal[CH.indexOf(ch)]
        if (n === 'air' && !T.air) continue
        const p = F.toWorld(h, x, y, z)
        W.set(p.x, p.y, p.z, n)
      }
    }
  }
}

test('перенос: мир → шаблон → мир, все 8 преобразований', () => {
  for (let r = 0; r < 4; r++) {
    for (let m = 0; m <= 1; m++) {
      const h = { r, m, t: { x: 7, y: 60, z: -3 } }
      const w = F.toWorld(h, 2, 3, 5)
      assert.deepEqual(F.toLocal(h, w.x, w.y, w.z), [2, 3, 5])
    }
  }
  // CLOCKWISE_90 (StructureTemplate.transform, pivot 0): (x, z) → (-z, x).
  assert.deepEqual(F.toWorld({ r: 1, m: 0, t: { x: 0, y: 0, z: 0 } }, 2, 0, 5), { x: -5, y: 0, z: 2 })
})

test('корабль на пляже: узнан по видимому борту, сундуки шаблона на своих клетках', () => {
  const W = world()
  const h = { r: 1, m: 0, t: { x: 20, y: 62, z: 4 } }
  place(W, 'shipwreck/rightsideup_full', h)
  W.bot.entity.position = new Vec3(4.5, 64, 12.5)
  const r = F.fit(W.bot, 'shipwreck', { x: 10, y: 64, z: 10 }, { radius: 40, env: 'beached' })
  assert.ok(r.best, `узнал: видимых ${r.seen}`)
  assert.equal(r.best.name, 'shipwreck/rightsideup_full')
  assert.deepEqual([r.best.r, r.best.m, r.best.t], [1, 0, { x: 20, y: 62, z: 4 }])
  const chests = F.chestsOf(r)
  const want = F.lib()['shipwreck/rightsideup_full'].chests.map(([x, y, z, t]) => ({ ...F.toWorld(h, x, y, z), t }))
  for (const c of want) assert.ok(chests.some(q => q.x === c.x && q.y === c.y && q.z === c.z && q.table === c.t), `сундук ${c.t} на ${c.x},${c.y},${c.z}`)
})

test('честно: ничего не видно (корабль за стеной) — не узнан', () => {
  const W = world()
  place(W, 'shipwreck/rightsideup_full', { r: 0, m: 0, t: { x: 10, y: 62, z: 0 } })
  for (let x = -30; x <= 40; x++) for (let y = 64; y <= 80; y++) W.set(x, y, -6, 'stone')
  W.bot.entity.position = new Vec3(4.5, 64, -12.5)
  const r = F.fit(W.bot, 'shipwreck', { x: 10, y: 64, z: 10 }, { radius: 40 })
  assert.equal(r.best, null)
})

test('иглу: верх узнан, люк подвала и столб сундука — по шаблону', () => {
  const W = world('grass_block') // снежная равнина: дёрн под снегом, блоков снега в рельефе нет
  const h = { r: 2, m: 0, t: { x: 14, y: 64, z: 9 } }
  place(W, 'igloo/top', h)
  W.bot.entity.position = new Vec3(2.5, 64, 2.5)
  const r = F.fit(W.bot, 'igloo', { x: 11, y: 65, z: 5 }, { radius: 30 })
  assert.ok(r.best && r.best.name === 'igloo/top', JSON.stringify(r && r.best))
  assert.deepEqual([r.best.r, r.best.t], [2, { x: 14, y: 64, z: 9 }])
  const b = F.iglooBasement(r.best)
  assert.deepEqual(b.hatch, F.toWorld(h, 3, 0, 5))
  // Лаборатория под тем же столбцом, что и люк (IglooPieces: стволы лестницы и лаборатории — под люком).
  assert.ok(Math.abs(b.chest.x - b.hatch.x) <= 3 && Math.abs(b.chest.z - b.hatch.z) <= 3, JSON.stringify(b))
})

test('дом деревни: оружейник узнан снаружи, сундук внутри — на своей клетке', () => {
  const W = world('grass_block')
  const name = 'village/plains/houses/plains_weaponsmith_1'
  const h = { r: 3, m: 0, t: { x: 12, y: 64, z: 18 } }
  place(W, name, h)
  W.bot.entity.position = new Vec3(0.5, 64, 4.5)
  const houses = F.fitHouses(W.bot, { x: 12, y: 65, z: 12 }, { radius: 30, biome: 'plains' })
  const hit = houses.find(q => q.name === name)
  assert.ok(hit, JSON.stringify(houses.map(q => q.name)))
  const [x, y, z] = F.lib()[name].chests[0]
  assert.deepEqual(hit.chests.map(c => [c.x, c.y, c.z]), [[F.toWorld(h, x, y, z).x, F.toWorld(h, x, y, z).y, F.toWorld(h, x, y, z).z]])
})

test('далеко от начала мира (x 2000, z −3000): голос держит сдвиг от центра поиска', () => {
  const B = { x: 2000, z: -3008 }
  const W = world('sand', B)
  const h = { r: 3, m: 0, t: { x: B.x + 20, y: 62, z: B.z + 4 } }
  place(W, 'shipwreck/sideways_full', h)
  W.bot.entity.position = new Vec3(B.x + 4.5, 64, B.z + 12.5)
  const r = F.fit(W.bot, 'shipwreck', { x: B.x + 10, y: 64, z: B.z + 10 }, { radius: 40, env: 'beached' })
  assert.ok(r.best, `узнал: видимых ${r.seen}`)
  assert.deepEqual([r.best.name, r.best.r, r.best.m, r.best.t], ['shipwreck/sideways_full', 3, 0, h.t])
})

test('центр деревни: колокол на виду — центр по нему; без него — среднее увиденного с разных мест', () => {
  const S: typeof import('../src/structures') = require('../src/structures')
  const state: any = { structures: [] }
  const session: any = { journal: { state, patch: fn => fn(state), append: () => {} }, director: null }
  S.remember(session, { kind: 'village', at: { x: 100, y: 64, z: 100 }, evidence: ['hay_block'] }, 'overworld')
  S.remember(session, { kind: 'village', at: { x: 130, y: 64, z: 100 }, evidence: ['white_bed'] }, 'overworld')
  assert.equal(state.structures.length, 1)
  assert.ok(state.structures[0].x > 100 && state.structures[0].x < 130, `среднее: ${state.structures[0].x}`)
  S.remember(session, { kind: 'village', at: { x: 140, y: 64, z: 110 }, evidence: ['bell'], bell: { x: 150, y: 65, z: 112 } }, 'overworld')
  assert.deepEqual([state.structures[0].x, state.structures[0].z, state.structures[0].bell], [150, 112, true])
  S.remember(session, { kind: 'village', at: { x: 120, y: 64, z: 90 }, evidence: ['white_bed'] }, 'overworld')
  assert.deepEqual([state.structures[0].x, state.structures[0].z], [150, 112], 'по колоколу центр больше не плывёт')
})

test('копка — только по прицелу: за камнем не копается; стоя на сундуке — он и есть дно колодца', async () => {
  const S: typeof import('../src/structures') = require('../src/structures')
  const W = world('sand')
  const dug = []
  Object.assign(W.bot, {
    inventory: { items: () => [] }, heldItem: null, controlState: {}, setControlState () {}, lookAt: async () => {}, stopDigging () {},
    pathfinder: { setGoal () {}, goto: async () => { throw new Error('нет пути') }, movements: { blocksToAvoid: new Set() } },
    dig: async b => { dug.push(b.name); W.set(b.position.x, b.position.y, b.position.z, 'air') }
  })
  const session: any = { bot: W.bot, journal: { state: {}, patch () {}, append () {} }, updateMovements () {} }
  const ctl = { aborted: false, onAbort: [] }
  // Доска за камнем (глаза — с юга): копка не уходит.
  W.bot.entity.position = new Vec3(0.5, 64, -1.5)
  W.set(0, 64, 0, 'stone'); W.set(0, 65, 0, 'stone'); W.set(0, 64, 1, 'oak_planks')
  const r = await S.digAt(session, ctl, new Vec3(0, 64, 1), { walkMs: 1 })
  assert.deepEqual([r.ok, r.why, dug], [false, 'не в прицеле', []])
  // Встал на сундук (ноги в его клетке на 0.875): копать нечего, песок под ним не трогается.
  W.set(5, 63, 5, 'chest')
  W.bot.entity.position = new Vec3(5.5, 63.875, 5.5)
  const d = await S.digDown(session, ctl, { maxDepth: 4 })
  assert.deepEqual([d.chest && d.chest.y, dug], [63, []])
})

test('иглу узнаётся снаружи: снежный купол и окно-льдинка, ковёр внутри не нужен', () => {
  const S: typeof import('../src/structures') = require('../src/structures')
  const W = world('grass_block')
  const raw = W.bot.blockAt
  W.bot.blockAt = p => { const b = raw(p); if (b) b.biome = { name: 'snowy_plains' }; return b }
  const seen = new Map([['snow_block', [new Vec3(10, 64, 10), new Vec3(11, 65, 10), new Vec3(12, 64, 10)]], ['ice', [new Vec3(10, 65, 12)]]])
  const d = S.evaluate(W.bot, 'igloo', S.KINDS.igloo, seen)
  assert.ok(d && d.kind === 'igloo', JSON.stringify(d))
  assert.equal(S.evaluate(W.bot, 'igloo', S.KINDS.igloo, new Map([['snow_block', [new Vec3(10, 64, 10)]]])), null, 'один снег — не иглу')
})
