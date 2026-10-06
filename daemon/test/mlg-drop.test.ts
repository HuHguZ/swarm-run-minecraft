'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const edges = require('../src/edges')
const { Session } = require('../src/session')

// Тело для edges.mlgDrop: сторож падения стоит, ведро — в рюкзаке или нет.
function body ({ hp = 20, dim = 'minecraft:overworld', bucket = true, guard = true, slot = 40, barAt = 0 }: any = {} as Record<string, any>) {
  const item = { name: bucket ? 'water_bucket' : 'bucket', slot }
  const slots = []
  slots[slot] = item
  return {
    entity: { position: { x: 0, y: 80, z: 0 }, onGround: true },
    health: hp,
    game: { dimension: dim },
    inventory: { items: () => [item], slots },
    _ndFallGuard: guard ? { toHotbar: async () => {}, barAt } : undefined
  }
}

test('с ведром в верхнем мире — смело до 60 блоков; после промаха — пока промах оставляет 4 хп', () => {
  assert.deepEqual(edges.mlgDrop({ bot: body() }), { ok: true, drop: 60, bold: true })
  assert.deepEqual(edges.mlgDrop({ bot: body({ hp: 12 }) }), { ok: true, drop: 60, bold: true })
  // Мало хп — не смело, а осторожно; с 6 хп промах с 6 блоков стоил бы 3 из 6.
  assert.equal(edges.mlgDrop({ bot: body({ hp: 6 }) }).ok, false)
  const missed: any = body()
  missed._ndFallGuard.missedAt = Date.now() - 60000
  assert.deepEqual(edges.mlgDrop({ bot: missed }), { ok: true, drop: 19, bold: false })
  missed._ndFallGuard.missedAt = Date.now() - 31 * 60000
  assert.equal(edges.mlgDrop({ bot: missed }).drop, 60)
  process.env.ND_MLG_RESERVE = '4'
  try { assert.deepEqual(edges.mlgDrop({ bot: body({ hp: 12 }) }), { ok: true, drop: 11, bold: false }) } finally { delete process.env.ND_MLG_RESERVE }
})

test('без ведра, в Аду, без сторожа и в бою с драконом — нет', () => {
  assert.equal(edges.mlgDrop({ bot: body({ bucket: false }) }).ok, false)
  assert.equal(edges.mlgDrop({ bot: body({ dim: 'minecraft:the_nether' }) }).ok, false)
  assert.equal(edges.mlgDrop({ bot: body({ guard: false }) }).ok, false)
  assert.equal(edges.mlgDrop({ bot: body(), current: { name: 'dragon' } }).ok, false)
  assert.equal(edges.mlgDrop({ bot: body(), mlgOff: true }).ok, false)
  // В Энде вода стоит — можно.
  assert.equal(edges.mlgDrop({ bot: body({ dim: 'minecraft:the_end' }) }).ok, true)
  // В творческом — нет: клики по рюкзаку ненадёжны, да и падение не ранит.
  const creative: any = body()
  creative.game.gameMode = 'creative'
  assert.deepEqual(edges.mlgDrop({ bot: creative }), { ok: false, why: 'не выживание' })
})

test('ведро в рюкзаке — сначала в хотбар, прыгать не раньше, чем сервер примет перекладку', () => {
  const back = edges.mlgDrop({ bot: body({ slot: 12 }) })
  assert.equal(back.ok, false)
  assert.equal(back.toBar, true)
  const fresh = edges.mlgDrop({ bot: body({ barAt: Date.now() - 100 }) })
  assert.equal(fresh.ok, false)
  assert.ok(fresh.retryMs > 0 && fresh.retryMs <= 320)
  assert.equal(edges.mlgDrop({ bot: body({ barAt: Date.now() - 1000 }) }).ok, true)
})

test('прыжок с ведром дороже шага, обычный спуск — как был', () => {
  const mv = {
    getMoveDropDown (node, dir, neighbors) { for (const y of [77, 76, 70, 60]) neighbors.push({ x: 1, y, z: 0, cost: 1 }) },
    getMoveDown (node, neighbors) { neighbors.push({ x: 0, y: 72, z: 0, cost: 2 }) }
  }
  edges.priceDrops(edges.priceDrops(mv)) // дважды — надбавка одна
  const n = []
  mv.getMoveDropDown({ x: 0, y: 80, z: 0 }, { x: 1, z: 0 }, n)
  mv.getMoveDown({ x: 0, y: 80, z: 0 }, n)
  // 3 — даром; 4 — с уроном без воды — не планируется; 10 и 20 — с водой; копка вниз на 8 — с водой.
  assert.deepEqual(n.map(m => [80 - m.y, m.cost]), [[3, 1], [10, 5], [20, 5], [8, 6]])
})

// Сессия с живым pathfinder'ом: ведро вылито посреди пути с прыжком.
function session ({ path, hp = 20, drop = 19, moving = true }: any = {} as Record<string, any>) {
  const bot: any = body({ hp })
  let resets = 0
  bot.pathfinder = { movements: { maxDropDown: drop }, isMoving: () => moving, setMovements: () => { resets++ } }
  const s = Object.create(Session.prototype)
  s.bot = bot
  s.dropSet = drop
  // Как в демоне: path_update → notePath (узлы — pathNodes, lastPath — сводка поиска).
  s.notePath({ status: 'success', cost: 12, visitedNodes: 40, generatedNodes: 90, time: 3, path })
  return { s, bot, resets: () => resets }
}

test('lastPath — сводка поиска, а не узлы: перестройка всё равно видит прыжок (регресс 02.10)', () => {
  const { s, bot, resets } = session({ path: [{ x: 1, y: 80, z: 0 }, { x: 2, y: 65, z: 0 }] })
  assert.equal(Array.isArray(s.lastPath), false)
  assert.equal(s.lastPath.length, 2)
  bot.inventory.items = () => [{ name: 'bucket', slot: 40 }]
  bot.inventory.slots[40] = { name: 'bucket', slot: 40 }
  s.refreshDrop()
  assert.equal(bot.pathfinder.movements.maxDropDown, 4)
  assert.equal(resets(), 1)
  // Исполнитель сдвинул узлы (прыжок позади) — массив живой, перестраивать нечего.
  s.pathNodes.splice(0, 2, { x: 3, y: 65, z: 0 })
  bot.entity.position.y = 65
  s.dropSet = 19
  bot.pathfinder.movements.maxDropDown = 19
  s.refreshDrop()
  assert.equal(resets(), 1)
})

test('ведро кончилось, а в пути прыжок на 15 — путь перестраивается', () => {
  const { s, bot, resets } = session({ path: [{ x: 1, y: 80, z: 0 }, { x: 2, y: 65, z: 0 }, { x: 3, y: 65, z: 0 }] })
  bot.inventory.items = () => [{ name: 'bucket', slot: 40 }]
  bot.inventory.slots[40] = { name: 'bucket', slot: 40 }
  s.refreshDrop()
  assert.equal(bot.pathfinder.movements.maxDropDown, 4)
  assert.equal(resets(), 1)
})

test('предел ниже, но прыжков в пути нет — путь не трогаем', () => {
  const { s, bot, resets } = session({ path: [{ x: 1, y: 80, z: 0 }, { x: 2, y: 78, z: 0 }] })
  bot.health = 14
  bot._ndFallGuard.missedAt = Date.now()
  s.refreshDrop()
  assert.equal(bot.pathfinder.movements.maxDropDown, 13)
  assert.equal(resets(), 0)
})

test('чужой предел (бой поставил свой) не перетираем', () => {
  const { s, bot, resets } = session({ path: [{ x: 2, y: 60, z: 0 }] })
  bot.pathfinder.movements.maxDropDown = 3
  bot.inventory.items = () => []
  bot.inventory.slots.length = 0
  s.refreshDrop()
  assert.equal(bot.pathfinder.movements.maxDropDown, 3)
  assert.equal(resets(), 0)
})

test('ведро стало готово посреди пути по лестнице — путь перекладывается на прыжок', () => {
  const { s, bot, resets } = session({ path: [{ x: 1, y: 79, z: 0 }], drop: 4 })
  s.refreshDrop()
  assert.equal(bot.pathfinder.movements.maxDropDown, 60)
  assert.equal(resets(), 1)
})

test('в воздухе путь не перестраивается — после посадки да', () => {
  const { s, bot, resets } = session({ path: [{ x: 1, y: 60, z: 0 }, { x: 2, y: 45, z: 0 }] })
  bot.entity.position.y = 70
  bot.entity.onGround = false
  bot.inventory.items = () => [{ name: 'bucket', slot: 40 }]
  bot.inventory.slots[40] = { name: 'bucket', slot: 40 }
  s.dropRetry = () => {}
  s.refreshDrop()
  assert.equal(bot.pathfinder.movements.maxDropDown, 4)
  assert.equal(resets(), 0)
  assert.equal(s.dropRecheck, true)
  bot.entity.position.y = 60
  bot.entity.onGround = true
  s.refreshDrop()
  assert.equal(resets(), 1)
  assert.equal(s.dropRecheck, false)
})

test('прыжок с ведром на листву, полублок, забор, кактус не планируется', () => {
  // Опора под клеткой посадки x: 1 — камень, 2 — листва, 3 — полублок, 4 — кактус, 5 — камень с забором в ногах.
  const under = { 1: ['stone', {} as Record<string, any>], 2: ['oak_leaves', { waterlogged: false }], 3: ['stone_slab', { waterlogged: false, type: 'bottom' }], 4: ['cactus', {} as Record<string, any>], 5: ['stone', {} as Record<string, any>] }
  const blockAt = (p) => {
    const [name, props] = p.y === 59 ? under[p.x] : p.x === 5 ? ['oak_fence', { waterlogged: false }] : ['air', {} as Record<string, any>]
    return { name, position: p, getProperties: () => props }
  }
  const mv = {
    bot: { blockAt },
    getMoveDropDown (node, dir, neighbors) { for (const x of [1, 2, 3, 4, 5]) neighbors.push({ x, y: 60, z: 0, cost: 1 }) },
    getMoveDown () {}
  }
  edges.priceDrops(mv)
  const n = []
  mv.getMoveDropDown({ x: 0, y: 80, z: 0 }, { x: 1, z: 0 }, n)
  assert.deepEqual(n.map(m => m.x), [1])
  // Невысокий спуск на ту же листву — как был: вода там не нужна.
  const low = []
  mv.getMoveDropDown({ x: 0, y: 63, z: 0 }, { x: 1, z: 0 }, low)
  assert.deepEqual(low.map(m => m.x), [1, 2, 3, 4, 5])
})
