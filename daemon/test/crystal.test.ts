'use strict'
// Кристаллы Края (crystal.js, 2026-09-30): установка по EndCrystalItem.useOn,
// урон по формуле ServerExplosion с видимостью, окно неуязвимости, правило
// «себе больше, чем ему, и свой тотем — никогда», честный прицел.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const cr = require('../src/crystal')
const boom = require('../src/boom')

// Мир: пол y=-1 (obsidian по умолчанию), остальное воздух; extra — «x,y,z» → имя.
function world ({ floor = 'obsidian', extra = {} as Record<string, any>, ents = {} as Record<string, any> }: any = {} as Record<string, any>) {
  const blocks = new Map(Object.entries<any>(extra))
  const block = (p) => {
    const k = `${p.x},${p.y},${p.z}`
    const name = blocks.has(k) ? blocks.get(k) : (p.y === -1 ? floor : 'air')
    const solid = name !== 'air'
    return { name, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], position: new Vec3(p.x, p.y, p.z) }
  }
  const bot: Record<string, any> = {
    entity: { id: 1, position: new Vec3(0.5, 0, 0.5), width: 0.6, height: 1.8, type: 'player', name: 'player' },
    entities: ents,
    blockAt: (p) => block({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }),
    world: { raycast: () => null }
  }
  bot.entities[1] = bot.entity
  return bot
}
const noArmor = { armor: 0, tough: 0, epf: 0, kbRes: 0, resist: 0 }
const crystalKit = { armor: 20, tough: 8, epf: 20, kbRes: 0.6, resist: 0 } // алмаз, «Защита IV» ×3 + поножи «Взрывоустойчивость IV»

test('кристалл: только обсидиан или бедрок, воздух над ним, в столбе 1×2 никого', () => {
  const bot = world({ extra: { '3,-1,0': 'crying_obsidian', '4,0,0': 'stone' } })
  assert.equal(cr.baseFree(bot, new Vec3(2, -1, 0)), true)
  assert.equal(cr.baseFree(bot, new Vec3(3, -1, 0)), false, 'плачущий обсидиан — не основа')
  assert.equal(cr.baseFree(bot, new Vec3(4, -1, 0)), false, 'над основой блок')
  // Игрок у края своей клетки задевает соседний столб (рамка 0.6).
  bot.entities[2] = { id: 2, position: new Vec3(1.8, 0, 0.5), width: 0.6, height: 1.8, type: 'player', name: 'player' }
  assert.equal(cr.baseFree(bot, new Vec3(2, -1, 0)), false, 'рамка игрока в столбе')
  // Соседний кристалл: рамка 2×2 закрывает и соседние столбы.
  const b2 = world()
  b2.entities[3] = { id: 3, position: new Vec3(5.5, 0, 0.5), width: 2, height: 2, name: 'end_crystal' }
  assert.equal(cr.baseFree(b2, new Vec3(6, -1, 0)), false, 'рамка соседнего кристалла')
  assert.equal(cr.baseFree(b2, new Vec3(7, -1, 0)), true)
})

test('урон по формуле ServerExplosion: 85 в упор, 74.8 с блока; броня кристального набора — ~12.6', () => {
  const bot = world()
  // Центр взрыва — верх обсидиана (низ кристалла), ноги цели на том же уровне.
  const c = new Vec3(1.5, 0, 0.5)
  const at1 = boom.blast(bot, c, 6, new Vec3(0.5, 0, 0.5), { def: noArmor })
  assert.ok(Math.abs(at1.raw - 74.83) < 0.2, `сырой с 1 блока ${at1.raw}`)
  assert.equal(at1.seen, 1)
  const armored = boom.blast(bot, c, 6, new Vec3(0.5, 0, 0.5), { def: crystalKit })
  assert.ok(armored.dmg > 12 && armored.dmg < 13, `после брони и чар ${armored.dmg}`)
  // Далеко — меньше; дальше 12 — ноль.
  const at6 = boom.blast(bot, c, 6, new Vec3(7.5, 0, 0.5), { def: crystalKit })
  assert.ok(at6.dmg < 4 && at6.dmg > 2.5, `с 6 блоков ${at6.dmg}`)
  assert.equal(boom.blast(bot, c, 6, new Vec3(14, 0, 0.5), { def: crystalKit }).dmg, 0)
})

test('сложность мира: «трудно» ×1.5 к сырому, «легко» min(f/2+1, f) — до брони', () => {
  const bot = world()
  const c = new Vec3(1.5, 0, 0.5)
  const at = new Vec3(0.5, 0, 0.5)
  const normal = boom.blast(bot, c, 6, at, { def: noArmor }).raw
  bot.game = { difficulty: 'hard' }
  assert.ok(Math.abs(boom.blast(bot, c, 6, at, { def: noArmor }).raw - normal * 1.5) < 0.05)
  bot.game = { difficulty: 'easy' }
  assert.ok(Math.abs(boom.blast(bot, c, 6, at, { def: noArmor }).raw - (normal / 2 + 1)) < 0.05)
})

test('обсидиан вокруг ног (surround) закрывает низ: кристалл на блоке окружения бьёт вдвое слабее', () => {
  const extra = { '1,0,0': 'obsidian', '-1,0,0': 'obsidian', '0,0,1': 'obsidian', '0,0,-1': 'obsidian' }
  const open = world()
  const walled = world({ extra })
  const me = new Vec3(0.5, 0, 0.5)
  // Открытое поле: кристалл на полу рядом.
  const floorHit = boom.blast(open, new Vec3(1.5, 0, 0.5), 6, me, { def: crystalKit })
  // В окружении: кристалл на блоке окружения (центр на уровне y+1).
  const topHit = boom.blast(walled, new Vec3(1.5, 1, 0.5), 6, me, { def: crystalKit })
  assert.ok(topHit.seen < 0.7, `видимость ${topHit.seen}`)
  assert.ok(topHit.dmg < floorHit.dmg * 0.7, `${topHit.dmg} против ${floorHit.dmg}`)
  assert.equal(cr.surrounded(walled, new Vec3(0, 0, 0)), true)
  assert.equal(cr.surrounded(open, new Vec3(0, 0, 0)), false)
})

test('размен: себе больше, чем ему, или свой тотем — никогда; добить можно при равном', () => {
  const eff = { myEff: 20, hisEff: 20 }
  assert.equal(cr.worthHit({ him: 12.6, me: 7.5 }, { ...eff, hisLand: 12.6 }), true, 'у его ног, я в 3.5 бл.')
  assert.equal(cr.worthHit({ him: 12.6, me: 11 }, { ...eff, hisLand: 12.6 }), false, 'между нами')
  assert.equal(cr.worthHit({ him: 12.6, me: 4 }, { myEff: 6, hisEff: 20, hisLand: 12.6 }), false, 'себе до тотема')
  assert.equal(cr.worthHit({ him: 9, me: 8 }, { myEff: 20, hisEff: 8, hisLand: 9 }), true, 'добить при почти равном')
  assert.equal(cr.worthHit({ him: 7, me: 8 }, { myEff: 20, hisEff: 6, hisLand: 7 }), false, 'добить, но себе больше')
  // Тотем у него в руке: «добить» — только сбить тотем; 12 себе за это — нет.
  assert.equal(cr.worthHit({ him: 17.5, me: 12 }, { myEff: 20, hisEff: 9, hisLand: 17.5 }), true, 'без тотема — добить можно')
  assert.equal(cr.worthHit({ him: 17.5, me: 12 }, { myEff: 20, hisEff: 9, hisLand: 17.5, hisTotem: true }), false, 'с тотемом — не такой ценой')
  // Свой тотем — по худшему случаю (полная видимость), не по лучам: прогон b4 —
  // прогноз мне 0.3 за окружением, шаг из укрытия, факт 9.6 и «поп».
  assert.equal(cr.worthHit({ him: 12.7, me: 0.3, meMax: 9.6 }, { myEff: 10, hisEff: 20, hisLand: 12.7 }), false, 'худший случай хлопает мой тотем')
  assert.equal(cr.worthHit({ him: 12.7, me: 0.3, meMax: 9.6 }, { myEff: 20, hisEff: 20, hisLand: 12.7 }), true, 'при полном здоровье — можно')
  assert.equal(cr.worthHit({ him: 2, me: 0 }, { ...eff, hisLand: 2 }), false, 'ему незаметно')
})

test('окно неуязвимости: сырой не больше последнего не проходит, больший — разницей', () => {
  const t = { him: 12, himRaw: 60 }
  assert.equal(cr.landed(t, null), 12)
  assert.equal(cr.landed(t, { raw: 70 }), 0)
  assert.ok(Math.abs(cr.landed(t, { raw: 30 }) - 6) < 1e-9)
})

test('удар по кристаллу: рамка 2×2×2 в 3 блоках и без стены на луче', () => {
  const bot = world()
  const eye = new Vec3(0.5, 1.62, 0.5)
  // Кристалл в 3.5 бл. — рамка ближе на 1: достаю.
  assert.ok(cr.hitAim(bot, new Vec3(4, 0, 0.5), eye))
  // В 4.5 — рамка в 3.5: не достаю.
  assert.equal(cr.hitAim(bot, new Vec3(5, 0, 0.5), eye), null)
  // Стена 2 блока высотой между нами (x=2, во всю ширину рамки) — прицел не
  // возьмёт; над стеной рамка видна только выше 2 — тоже закрыто стеной в 3.
  const extra: Record<string, any> = {} as Record<string, any>
  for (let z = -2; z <= 2; z++) for (let y = 0; y <= 2; y++) extra[`2,${y},${z}`] = 'obsidian'
  const walled = world({ extra })
  assert.equal(cr.hitAim(walled, new Vec3(3.5, 0, 0.5), eye), null)
})

test('рамка кристалла и расстояние до неё', () => {
  const b = cr.crystalBox(new Vec3(0.5, 0, 0.5))
  assert.deepEqual([b.minX, b.minY, b.maxX, b.maxY], [-0.5, 0, 1.5, 2])
  assert.equal(cr.boxDist(new Vec3(0.5, 1, 0.5), b), 0)
  assert.ok(Math.abs(cr.boxDist(new Vec3(4.5, 1, 0.5), b) - 3) < 1e-9)
})

// План целиком на поддельном боте: пол, он в нескольких блоках, у меня
// кристаллы и обсидиан.
function duelBot ({ floor = 'obsidian', foeAt = new Vec3(4.5, 0, 0.5), extra = {} as Record<string, any>, inv = null }: any = {} as Record<string, any>) {
  const registry = require('minecraft-data')('1.21.11')
  const bot = world({ floor, extra })
  bot.registry = registry
  bot.health = 20
  bot.game = { difficulty: 'normal' }
  bot.entity.metadata = []
  bot.entity.onGround = true
  const item = (name, count = 1) => ({ name, count, slot: 36 })
  const items = inv || [item('end_crystal', 64), item('obsidian', 64), item('diamond_sword'), item('bow'), item('arrow', 32)]
  // Броня кристального набора (CRYSTAL_ARMOR арены): «Защита IV», поножи «Взрывоустойчивость IV».
  const ench = (name, id) => ({ name, count: 1, componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'minecraft:' + id, level: 4 }] } }]]) })
  const armor = [ench('diamond_helmet', 'protection'), ench('diamond_chestplate', 'protection'), ench('diamond_leggings', 'blast_protection'), ench('diamond_boots', 'protection')]
  const slots = []
  slots[5] = armor[0]; slots[6] = armor[1]; slots[7] = armor[2]; slots[8] = armor[3]
  bot.inventory = { items: () => items, slots }
  bot.on = () => {}
  bot.removeListener = () => {}
  bot._client = { on: () => {}, removeListener: () => {} }
  const foe = { id: 2, name: 'player', type: 'player', username: 'Foe', position: foeAt, width: 0.6, height: 1.8, metadata: [], equipment: [null, null, armor[3], armor[2], armor[1], armor[0]], isValid: true }
  bot.entities[2] = foe
  return { bot, foe }
}

test('план: на обсидиановом полу — кристалл у его ног (рукой или стрелой), не у себя', () => {
  const { bot, foe } = duelBot({ foeAt: new Vec3(3.5, 0, 0.5) })
  const c = cr.create(bot, { enemy: () => foe })
  const a = c.plan({} as Record<string, any>)
  assert.ok(a, 'есть действие')
  assert.ok(/^place/.test(a.kind), a.kind)
  // Кристалл ближе к нему, чем ко мне, и ему больнее.
  assert.ok(a.c.distanceTo(foe.position) < a.c.distanceTo(bot.entity.position), 'у него, не у меня')
  assert.ok(a.t.him > a.t.me * 1.3, `ему ${a.t.him}, мне ${a.t.me}`)
  c.close()
})

test('план: пол не обсидиан — обсидиан у его ног только туда, где кристалл его возьмёт', () => {
  // Ровный камень: основа на уровне его ног сама закрывает ему низ (~40%
  // видимости) — ~1.7 после брони, не стоит; ничего не делать.
  const flat = duelBot({ floor: 'smooth_stone', foeAt: new Vec3(3.5, 0, 0.5) })
  const c1 = cr.create(flat.bot, { enemy: () => flat.foe })
  assert.equal(c1.plan({} as Record<string, any>), null)
  c1.close()
  // Яма в полу рядом с ним (выбитый светокамень, воронка): обсидиан в яму —
  // центр взрыва на уровне его ног, рамка открыта.
  // Яма сбоку от него (за его спиной грани ямы закрыл бы он сам — прицел
  // клиента взял бы его рамку, а не блок).
  const holed = duelBot({ floor: 'smooth_stone', foeAt: new Vec3(2.5, 0, 0.5), extra: { '2,-1,1': 'air' } })
  holed.bot.entity.position = new Vec3(-0.5, 0, 0.5)
  const c2 = cr.create(holed.bot, { enemy: () => holed.foe })
  const a = c2.plan({} as Record<string, any>)
  assert.ok(a, 'есть действие')
  assert.equal(a.kind, 'obby')
  assert.deepEqual([a.cell.x, a.cell.y, a.cell.z], [2, -1, 1])
  assert.ok(a.t.him > 8, `ему ${a.t.him}`)
  c2.close()
})

test('план: без кристаллов и без его кристаллов рядом — ничего', () => {
  const { bot, foe } = duelBot({ inv: [] })
  const c = cr.create(bot, { enemy: () => foe })
  assert.equal(c.plan({} as Record<string, any>), null)
  c.close()
})

test('план: якорь возрождения (бонус) — в верхнем мире, у его ног, когда кристаллу нет основы', () => {
  const item = (name, count = 1) => ({ name, count, slot: 36 })
  const inv = [item('end_crystal', 8), item('respawn_anchor', 4), item('glowstone', 8), item('diamond_sword')]
  const { bot, foe } = duelBot({ floor: 'smooth_stone', foeAt: new Vec3(3.5, 0, 0.5), inv })
  bot.game.dimension = 'overworld'
  const c = cr.create(bot, { enemy: () => foe })
  const a = c.plan({} as Record<string, any>)
  assert.ok(a, 'есть действие')
  assert.equal(a.kind, 'anchor')
  assert.ok(a.t.him > a.t.me, `ему ${a.t.him}, мне ${a.t.me}`)
  c.close()
  // В аду якорь не взрывается (RespawnAnchorBlock.canSetSpawn) — не предлагать.
  bot.game.dimension = 'the_nether'
  const c2 = cr.create(bot, { enemy: () => foe })
  const a2 = c2.plan({} as Record<string, any>)
  assert.ok(!a2 || a2.kind !== 'anchor')
  c2.close()
})

test('якоря без кристаллов (TODO п.8): бой взрывом включается и план — якорь; в Аду — нет', () => {
  const item = (name, count = 1) => ({ name, count, slot: 36 })
  const inv = [item('respawn_anchor', 8), item('glowstone', 16), item('diamond_sword')]
  const { bot, foe } = duelBot({ floor: 'smooth_stone', foeAt: new Vec3(3.5, 0, 0.5), inv })
  bot.game.dimension = 'overworld'
  const c = cr.create(bot, { enemy: () => foe })
  assert.equal(c.engaged(), true, 'якорь и светокамень — взрывной бой')
  const a = c.plan({} as Record<string, any>)
  assert.ok(a && a.kind === 'anchor', `план ${a && a.kind}`)
  c.close()
  bot.game.dimension = 'the_nether'
  const c2 = cr.create(bot, { enemy: () => foe })
  assert.equal(c2.engaged(), false, 'в Аду якорь не взрывается')
  assert.equal(c2.plan({} as Record<string, any>), null)
  c2.close()
  // Без светокамня якорь не зарядить.
  const { bot: b3, foe: f3 } = duelBot({ floor: 'smooth_stone', foeAt: new Vec3(3.5, 0, 0.5), inv: [item('respawn_anchor', 8), item('diamond_sword')] })
  b3.game.dimension = 'overworld'
  const c3 = cr.create(b3, { enemy: () => f3 })
  assert.equal(c3.engaged(), false)
  c3.close()
})
