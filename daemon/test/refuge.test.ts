'use strict'
// Аварийный отход (survival.refuge, research/05-synthesis.md F.5): оценка места
// и выбор способа на фейковом боте. Мир — настоящие блоки 1.21.11
// (prismarine-block: формы, твёрдость, время копки), мобы — сущности с позицией.
import test = require('node:test')
import assert = require('node:assert/strict')
const Vec3: typeof import('vec3').Vec3 = require('vec3')
const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const mcData = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')
import survival = require('../src/survival')
import fortify = require('../src/fortify')
import hold = require('../src/survival/hold-out')

const blockOf = (name, pos) => {
  const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
  b.position = pos
  return b
}

// Мир: пол floor на y ≤ 63, воздух выше; at(x, y, z) → имя или null (по умолчанию).
function scene ({ floor = 'stone', at = null, dim = 'overworld', mobs = [], items = [], hp = 6, food = 20, feet = [0.5, 64, 0.5], water = false }: any = {} as Record<string, any>) {
  const cache = new Map()
  const bot = {
    version: '1.21.11',
    registry,
    game: { dimension: dim },
    health: hp,
    food,
    entity: { id: 1, position: new Vec3(...(feet as [number, number, number])), onGround: true, isInWater: water, isInLava: false, effects: {} as Record<string, any>, metadata: [], height: 1.8, width: 0.6 },
    entities: {} as Record<string, any>,
    heldItem: null,
    world: { raycast: () => null },
    inventory: {
      items: () => items.map((it, i) => ({ name: it[0], count: it[1], type: registry.itemsByName[it[0]].id, slot: 9 + i, metadata: 0 })),
      slots: Array(46).fill(null)
    },
    blockAt (p) {
      const v = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const k = `${v.x},${v.y},${v.z}`
      if (!cache.has(k)) {
        const named = at ? at(v.x, v.y, v.z) : null
        cache.set(k, blockOf(named || (v.y <= 63 ? floor : 'air'), v))
      }
      return cache.get(k)
    }
  }
  bot.entities[1] = bot.entity
  mobs.forEach(([name, x, z, y = 64]: any, i) => {
    bot.entities[10 + i] = { id: 10 + i, name, type: 'hostile', position: new Vec3(x, y, z), height: 1.95, width: 0.6, isValid: true, metadata: [] }
  })
  return { bot, mcData }
}
const look = s => survival.refugeLook(s)
const choose = s => survival.chooseRefuge(look(s))
const ZOMBIES = [['zombie', 6.5, 0.5], ['zombie', -5.5, 0.5], ['zombie', 0.5, 6.5], ['zombie', 0.5, -5.5]]
const KIT = [['stone_pickaxe', 1], ['cobblestone', 10], ['cooked_mutton', 4]]

test('видимые гаст, ифрит и арбалетчик за 16 блоками запрещают открытый столб в своей дальности', () => {
  for (const [name, distance] of [['ghast', 45], ['blaze', 30], ['pillager', 24]] as const) {
    const s = scene({ dim: 'the_nether', floor: 'netherrack', mobs: [[name, distance + 0.5, 0.5]], items: KIT })
    const a = look(s)
    assert.equal(a.shooters, 1, `${name} виден и может стрелять`)
    assert.equal(a.walkers, 0, 'дальний стрелок не становится ближним преследователем')
    assert.equal(a.pillar, null)
    assert.notEqual(survival.chooseRefuge(a).how, 'pillar')
  }
})

test('дальний враг за стеной, вне своей дальности и дальний ходячий не меняют выбор укрытия', () => {
  const hidden = scene({ mobs: [['ghast', 45.5, 0.5]], items: KIT })
  hidden.bot.world.raycast = () => blockOf('stone', new Vec3(5, 64, 0))
  assert.equal(look(hidden).foes, 0)
  for (const [name, distance] of [['ghast', 65], ['blaze', 49], ['pillager', 33], ['zombie', 30]] as const) {
    const a = look(scene({ mobs: [[name, distance + 0.5, 0.5]], items: KIT }))
    assert.equal(a.foes, 0, `${name} в ${distance} блоках сейчас не достаёт`)
  }
})

test('holdOut покидает открытое место и столб при видимом гасте в 45 блоках до еды', async () => {
  for (const [kind, why] of [['pillar', 'breached'], ['open', 'contact']]) {
    const s = scene({ dim: 'the_nether', mobs: [['ghast', 45.5, 0.5]], items: [], food: 10 })
    const r = await hold.holdOut(s, { aborted: false }, { kind, minHp: 18, deadline: (require('../src/game-clock') as typeof import('../src/game-clock')).now() + 1000, note () {} })
    assert.equal(r.why, why)
    assert.deepEqual(r.ate, [])
  }
})

test('при выходе из укрытия видимый дальний гаст опасен; гаст за стеной не читается сквозь неё', () => {
  const s = scene({ hp: 20, mobs: [['ghast', 45.5, 0.5]] })
  const at = s.bot.entity.position.floored()
  assert.match(survival.outsideDanger(s.bot, at) || '', /стрелок/)
  s.bot.world.raycast = () => blockOf('stone', new Vec3(5, 64, 0))
  assert.equal(survival.outsideDanger(s.bot, at), null)
})

test('зомби рядом, 10 блоков на открытом месте — коробка, и оценка укладывается в 50 мс', () => {
  const s = scene({ mobs: ZOMBIES, items: KIT })
  const a = look(s)
  assert.equal(survival.chooseRefuge(a).how, 'box')
  assert.ok(a.cell && a.cell.blocks <= 10, 'клетка по карману')
  assert.ok(a.ms <= 50, `оценка ${a.ms} мс`)
})

test('у стены и в углу — клетка у породы: стены в зачёт, блоков меньше, крыше есть опора', () => {
  // Стена в 3 блока высотой по x = 2 и по z = 2 (угол), бот в шаге от угла.
  const at = (x, y, z) => (y >= 64 && y <= 66 && (x === 2 || z === 2) ? 'stone' : null)
  const s = scene({ at, mobs: [['zombie', -4.5, -4.5]], items: [['stone_pickaxe', 1], ['cobblestone', 10]] })
  const a = look(s)
  assert.equal(survival.chooseRefuge(a).how, 'box')
  assert.ok(a.cell.walls >= 2, `готовых стен ${a.cell.walls}`)
  assert.ok(a.cell.blocks <= 5, `блоков на коробку ${a.cell.blocks}`)
  assert.equal(a.cell.leans, true, 'крыша опирается на стену в 3 блока — подпорка не нужна')
})

test('блоков мало для открытой клетки, а у стены хватает — клетка у стены', () => {
  const at = (x, y, z) => (y >= 64 && y <= 66 && x === 3 ? 'stone' : null)
  const s = scene({ at, mobs: [['zombie', -7.5, 0.5]], items: [['stone_pickaxe', 1], ['cobblestone', 7]] })
  const a = look(s)
  assert.equal(survival.chooseRefuge(a).how, 'box')
  assert.equal(a.cell.cell.x, 2, 'встаёт вплотную к стене')
})

test('ходячих нет, пол копается — нора; в Аду — никогда нора', () => {
  const far = [['skeleton', 30.5, 0.5]]
  assert.equal(choose(scene({ mobs: far, items: KIT })).how, 'hole')
  const nether = scene({ dim: 'the_nether', floor: 'netherrack', mobs: far, items: [['stone_pickaxe', 1], ['netherrack', 12]] })
  const a = look(nether)
  assert.equal(a.hole, null)
  assert.equal(survival.chooseRefuge(a).how, 'box')
})

test('ходячий в 16 бл. — коробка, а не нора: выход из норы под ним опаснее', () => {
  assert.equal(choose(scene({ mobs: [['zombie', 14.5, 0.5]], items: KIT })).how, 'box')
})

test('блоков мало на коробку, но хватает на столб — столб от ходячих; от стрелка — нет', () => {
  const few = [['stone_pickaxe', 1], ['netherrack', 5], ['cooked_mutton', 4]]
  const nether = scene({ dim: 'the_nether', floor: 'netherrack', mobs: ZOMBIES, items: few })
  assert.equal(choose(nether).how, 'pillar')
  const shot = scene({ dim: 'the_nether', floor: 'netherrack', mobs: [...ZOMBIES, ['skeleton', 9.5, 0.5]], items: few })
  assert.notEqual(choose(shot).how, 'pillar')
  // Низкий потолок — столбу расти некуда.
  const low = scene({ dim: 'the_nether', floor: 'netherrack', mobs: ZOMBIES, items: few, at: (x, y) => (y === 67 ? 'netherrack' : null) })
  assert.equal(choose(low).how, 'flee')
})

test('Ад без блоков — бегство (NO_BLOCKS), вниз не копает', () => {
  const s = scene({ dim: 'the_nether', floor: 'netherrack', mobs: ZOMBIES, items: [['stone_pickaxe', 1], ['cooked_mutton', 4]] })
  const pick = choose(s)
  assert.equal(pick.how, 'flee')
  assert.equal(pick.code, 'NO_BLOCKS')
})

test('ни блоков, ни кирки на каменном полу — бегство NO_BLOCKS', () => {
  const pick = choose(scene({ mobs: ZOMBIES, items: [['cooked_mutton', 4]] }))
  assert.equal(pick.how, 'flee')
  assert.equal(pick.code, 'NO_BLOCKS')
})

test('булыжник без кирки — из своей коробки не выйти: не коробка, а столб (с него спрыгнуть)', () => {
  const pick = choose(scene({ mobs: ZOMBIES, items: [['cobblestone', 20]] }))
  assert.equal(pick.how, 'pillar')
})

test('крипер рядом — бегство, коробка его не держит', () => {
  const pick = choose(scene({ mobs: [['creeper', 4.5, 0.5], ['zombie', -6.5, 0.5]], items: KIT }))
  assert.equal(pick.how, 'flee')
  assert.match(pick.why, /крипер/)
})

test('в воде — бегство к суше (IN_WATER)', () => {
  const pick = choose(scene({ mobs: ZOMBIES, items: KIT, water: true }))
  assert.equal(pick.how, 'flee')
  assert.equal(pick.code, 'IN_WATER')
})

test('тело в замкнутом кармане без врагов — строить нечего', () => {
  // Клетка 1×1×2 в камне: стены и потолок — порода (свой штрек).
  const at = (x, y, z) => (y >= 64 && y <= 66 && !(x === 0 && z === 0 && y <= 65) ? 'stone' : null)
  const s = scene({ at, mobs: [['zombie', 6.5, 0.5]], items: KIT })
  assert.equal(choose(s).how, 'pocket')
})

test('ближний дойдёт раньше, чем встанут стены, — сперва оторваться', () => {
  const close = look(scene({ mobs: [['zombie', 2.5, 0.5]], items: KIT }))
  assert.equal(survival.outrun(close, 'box'), true)
  const far = look(scene({ mobs: [['zombie', 9.5, 0.5]], items: KIT }))
  assert.equal(survival.outrun(far, 'box'), false)
})

test('скорость погони по байткоду 1.21.11: зомби ~2.3 бл/с, паук ~3.9', () => {
  assert.ok(Math.abs(survival.chaseBps('zombie') - 2.28) < 0.02)
  assert.ok(Math.abs(survival.chaseBps('spider') - 3.88) < 0.02)
})

test('план коробки: лицо к врагу первым, подпорка и крыша последними', () => {
  const s = scene({ items: KIT })
  const plan = fortify.refugePlan(s.bot, new Vec3(0, 64, 0), new Vec3(6.5, 64, 0.5))
  assert.equal(plan.length, 10)
  assert.deepEqual([plan[0].pos.x, plan[0].pos.z], [1, 0], 'первый блок — к зомби')
  assert.deepEqual(plan.slice(-2).map(p => p.kind), ['support', 'roof'])
})

test('полублок у стены — не стена и не место для блока: клетка не годится', () => {
  const at = (x, y, z) => (x === 1 && z === 0 && y === 64 ? 'oak_slab' : null)
  const s = scene({ at, items: KIT })
  assert.equal(fortify.refugeNeed(s.bot, new Vec3(0, 64, 0)), null)
  assert.ok(fortify.refugeNeed(s.bot, new Vec3(-2, 64, 0)))
})

// Поток survival 02.10: клетка у обрыва (пещера, уступ) — нижнему блоку стены не к чему прислониться
// (base1 слот 17: «коробка 1/4 — не к чему прислонить блок», бегство, смерть). Такая клетка не годится.
test('клетка у обрыва без опоры для стены — не под коробку', () => {
  // Пол только x ≤ 0 (обрыв на x = 1), тело на краю.
  const s = scene({ items: KIT, at: (x, y, z) => (y <= 63 && x >= 1 ? 'air' : null) })
  const need = fortify.refugeNeed(s.bot, new Vec3(0, 64, 0))
  assert.equal(need, null)
  // На ровном полу — годится.
  const flat = scene({ items: KIT })
  assert.ok(fortify.refugeNeed(flat.bot, new Vec3(0, 64, 0)))
})

// В воде — путь к берегу подальше от утопленника: бассейн x −6..6, берег везде; утопленник у восточного края.
test('к берегу — не к утопленнику', () => {
  const pool = (x, y, z) => (Math.abs(x) <= 6 && Math.abs(z) <= 6 && y >= 60 && y <= 63 ? 'water' : null)
  const s = scene({ items: KIT, at: pool, feet: [0.5, 62, 0.5], water: true })
  const r = survival.shoreRoute(s.bot, { foes: [new Vec3(7.5, 64, 0.5)] })
  assert.ok(r, 'берег найден')
  assert.ok(r.target.x < 4, `берег не у утопленника: ${r.target}`)
  const free = survival.shoreRoute(s.bot, {} as Record<string, any>)
  assert.ok(free && Math.max(Math.abs(free.target.x), Math.abs(free.target.z)) === 7)
})

// Океан: суши в 24 бл. нет (cl-ah 14.10: «берега в 16 бл. не вижу» за 0 с, утопленники добили) — ближайшая суша над водой.
test('берег дальше 24 бл. — ближайшая суша над водой', () => {
  const sea = (x, y, z) => (x > -40 && x < 30 && Math.abs(z) < 50 && y >= 50 && y <= 63 ? 'water' : null)
  const s = scene({ items: KIT, at: sea, feet: [0.5, 62, 0.5], water: true })
  assert.equal(survival.shoreRoute(s.bot, { radius: 24, rise: 14, drop: 8 }), null)
  const p = hold.farShore(s.bot)
  assert.ok(p, 'суша найдена')
  assert.deepEqual([p.x, p.y, p.z], [30, 64, 0])
})

// Ниша (ND_REFUGE_NICHE): стена камня на востоке (x ≥ 1, y 64..66) — вкопаться туда; на ровном поле — нечего.
test('ниша — в сплошную стену рядом, не в поле', () => {
  const wall = (x, y, z) => (x >= 1 && y >= 64 && y <= 66 ? 'stone' : null)
  const s = scene({ items: KIT, at: wall })
  const n = fortify.nichePlan(s.bot, new Vec3(0, 64, 0))
  assert.ok(n, 'ниша найдена')
  assert.deepEqual([n.side.x, n.side.z], [1, 0])
  assert.ok(n.digMs > 0 && n.digMs < 2400, `копка ${n.digMs} мс`)
  const flat = scene({ items: KIT })
  assert.equal(fortify.nichePlan(flat.bot, new Vec3(0, 64, 0)), null)
  // Гравий в стене — не копать (обвал).
  const grav = scene({ items: KIT, at: (x, y, z) => (x >= 1 && y >= 64 && y <= 66 ? (x === 1 && y === 65 && z === 0 ? 'gravel' : 'stone') : null) })
  assert.equal(fortify.nichePlan(grav.bot, new Vec3(0, 64, 0)), null)
})

// Пересидка (sitTight → outsideDanger): когда из закрытого укрытия не выходить.
test('снаружи опасно: двое ходячих в 10 бл., стрелок в 16, ночь «до рассвета»; один в 8 при 20 хп — нет', () => {
  const at = new Vec3(0, 64, 0)
  const two = scene({ hp: 20, mobs: [['zombie', 7.5, 0.5], ['zombie', -6.5, 3.5]] })
  assert.match(survival.outsideDanger(two.bot, at) || '', /ходячих 2/)
  const one = scene({ hp: 20, mobs: [['zombie', 8.5, 0.5]] })
  assert.equal(survival.outsideDanger(one.bot, at), null)
  const lowOne = scene({ hp: 8, mobs: [['zombie', 4.5, 0.5]] })
  assert.ok(survival.outsideDanger(lowOne.bot, at))
  const archer = scene({ hp: 20, mobs: [['parched', 12.5, 0.5]] })
  assert.match(survival.outsideDanger(archer.bot, at) || '', /стрелок/)
  const night: any = scene({ hp: 20 })
  night.bot.time = { timeOfDay: 15000 }
  assert.equal(survival.outsideDanger(night.bot, at), null)
  assert.match(survival.outsideDanger(night.bot, at, { untilDawn: true }) || '', /рассвета/)
})

function neutralScene (name = 'piglin', { angry = false, hit = false, expired = false }: any = {}) {
  const s: any = scene({ dim: 'the_nether', hp: 10, items: KIT, mobs: [[name, 0.5, 1.7, 65]] })
  const e = s.bot.entities[10]
  const keys = registry.entitiesByName[name].metadataKeys
  e.metadata[keys.indexOf(name === 'enderman' ? 'creepy' : 'mob_flags')] = angry ? (name === 'enderman' ? true : 4) : 0
  if (hit) s.lastAttacker = { id: e.id, at: (require('../src/game-clock') as typeof import('../src/game-clock')).now() - (expired ? 21000 : 0), how: 'damage_event' }
  return s
}

test('напавший пиглин участвует в расчёте коробки: близость, ETA и отход до стен', () => {
  const s = neutralScene('piglin', { angry: true })
  const a = look(s)
  assert.equal(a.nearest?.name, 'piglin')
  assert.equal(a.foeClose, true)
  assert.equal(survival.outrun(a, 'box'), true)
})

test('спокойный пиглин без золота не становится преследователем в расчёте укрытия', async () => {
  const s = neutralScene()
  const a = look(s)
  assert.equal(a.nearest, null)
  assert.equal(a.foeClose, false)
  assert.equal(survival.outrun(a, 'box'), false)
  assert.equal(survival.outsideDanger(s.bot, new Vec3(0, 64, 0)), null)
  assert.equal(await hold.waitClear(s, { aborted: false }, new Vec3(0, 64, 0), { deadline: 0 }), true)
})

test('подтверждённый нападающий учитывается без флага агрессии, другой и давний пиглин — нет', () => {
  const s = neutralScene('piglin', { hit: true })
  assert.equal(look(s).nearest?.name, 'piglin')
  s.lastAttacker.id = 11
  assert.equal(look(s).nearest, null)
  assert.equal(look(neutralScene('piglin', { hit: true, expired: true })).nearest, null)
})

test('агрессивный пиглин остаётся опасным у выхода и после исчерпания ожидания', async () => {
  const s = neutralScene('piglin', { angry: true })
  const at = new Vec3(0, 64, 0)
  assert.match(survival.outsideDanger(s.bot, at) || '', /ходячих 1/)
  assert.equal(await hold.waitClear(s, { aborted: false }, at, { deadline: 0 }), false)
})

test('злой эндермен учитывается в укрытии по видимому creepy, спокойный — нет', () => {
  assert.equal(look(neutralScene('enderman', { angry: true })).nearest?.name, 'enderman')
  assert.equal(look(neutralScene('enderman')).nearest, null)
})
