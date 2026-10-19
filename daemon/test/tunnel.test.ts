'use strict'
// Регрессии по ревью Codex 30.09 (codex-lab/review-bastion2-20260930.md): закрытый штрек и переход по Аду.
import test = require('node:test')
import assert = require('node:assert/strict')
import { Vec3 } from 'vec3'
const SL: any = require('../src/sealed')
const data = (require('minecraft-data') as typeof import('minecraft-data'))('1.21.11')

// Тело в мире-незераке: клетки из world — воздух и т. п.; копка превращает клетку в воздух; шаг вперёд —
// телепорт в клетку взгляда (как в пробах Codex).
function fakeBot (items = null) {
  const world = new Map()
  const position = new Vec3(0.5, 40, 0.5)
  for (const y of [40, 41]) world.set(`0,${y},0`, 'air')
  let aim
  const stone = { name: 'stone_pickaxe', type: data.itemsByName.stone_pickaxe.id, count: 1, maxDurability: 131, durabilityUsed: 0 }
  const inv = items || [stone]
  const bot: Record<string, any> = {
    world, health: 20, entity: { position, onGround: true }, heldItem: inv[0],
    inventory: { items: () => inv },
    blockAt (v) {
      const name = world.get(SL.keyV(v)) || 'netherrack'
      return { name, type: data.blocksByName[name].id, position: v,
        boundingBox: name === 'air' ? 'empty' : 'block',
        shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]],
        hardness: data.blocksByName[name].hardness, material: 'mineable/pickaxe' }
    },
    async equip (item) { bot.heldItem = item },
    async dig (b) { world.set(SL.keyV(b.position), 'air') },
    digTime () { return 0 },
    stopDigging () {},
    async lookAt (v) { aim = v },
    setControlState (state, on) {
      if (state === 'forward' && on) bot.entity.position = new Vec3(aim.x, bot.entity.position.y, aim.z)
    },
    clearControlStates () {}
  }
  return bot
}
const flat = x => ({ kind: 'flat', to: { x, y: 40, z: 0 }, clear: [{ x, y: 41, z: 0 }, { x, y: 40, z: 0 }], floor: { x, y: 39, z: 0 } })

test('закрытый штрек: новый пробой после закрытого участка засыпается за спиной', async () => {
  const bot = fakeBot()
  bot.inventory.items = () => [bot.heldItem, { name: 'netherrack', type: data.itemsByName.netherrack.id, count: 32 }]
  const S: Record<string, any> = { own: new Set(['0,40,0', '0,41,0']), exposed: true, noBonus: true, dug: 0, moves: 0, fills: 0, deadline: Date.now() + 20000 }
  assert.equal((await SL.execute({ bot }, { aborted: false }, [flat(1)], S)).ok, true)
  assert.equal(S.exposed, false, 'после первого хода закрыто')
  bot.world.set('2,41,1', 'air') // пещера сбоку следующей клетки
  S.breachOk = () => true
  const fill0 = SL.fillCell
  let filled = 0
  SL.fillCell = async (b, v) => { filled++; bot.world.set(SL.keyV(v), 'netherrack'); return true }
  try {
    assert.equal((await SL.execute({ bot }, { aborted: false }, [flat(2)], S)).ok, true)
  } finally { SL.fillCell = fill0 }
  assert.ok(filled > 0 || (S.exposed as boolean) === true, 'пробой замечен: засыпка за спиной или exposed')
})

test('закрытый штрек: гравий — не пол (план)', async () => {
  const own = new Set(['0,40,0', '0,41,0'])
  const cls = (x, y, z) => {
    if (own.has(`${x},${y},${z}`)) return SL.AIR
    if (x === 1 && y === 39 && z === 0) return SL.FALL
    if (x === 1 && y < 39 && z === 0) return SL.AIR
    return SL.SOLID
  }
  const r = await SL.plan({ cls, dig: () => 0.1, own, starts: [{ x: 0, y: 40, z: 0 }], goal: (x, y, z) => x === 1 && y === 40 && z === 0,
    h: (x, y, z) => Math.abs(x - 1) + Math.abs(y - 40) + Math.abs(z), box: { x0: 0, x1: 1, y0: 40, y1: 40, z0: 0, z1: 0 } })
  assert.equal(r.ok, false, 'на висящий гравий не шагаем')
})

test('штрек по Аду: вне радиуса — не «дошёл», даже если цель куска расширилась', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const plan0 = SL.plan
  SL.plan = async o => { const a = o.starts[0]; return o.goal(a.x, a.y, a.z) ? { ok: true, path: [] } : { ok: false, why: {} as Record<string, any> } }
  try {
    const bot = fakeBot()
    bot.pathfinder = { goto () { throw new Error('offline') }, setGoal () {} }
    const r = await T.tunnelTo({ bot }, { aborted: false }, { x: 10, y: 40, z: 0 }, { radius: 4, deadline: Date.now() + 5000 })
    assert.equal(r.ok, false, `ложный успех в ${Math.hypot(10 - r.at.x, 0 - r.at.z)} блоках`)
  } finally { SL.plan = plan0 }
})

test('штрек по Аду: запрет вскрытия у бастиона — по каждой клетке, а не по старту куска', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const plan0 = SL.plan
  const ctl: Record<string, any> = { aborted: false }
  let inside = null; let outside = null
  SL.plan = async o => {
    if (o.breachOk) { inside = o.breachOk('47,40,0', '47,41,1'); outside = o.breachOk('60,40,0', '60,41,1'); ctl.aborted = true }
    return { ok: false, why: {} as Record<string, any> }
  }
  try {
    const bot = fakeBot()
    bot.entity.position = new Vec3(50.5, 40, 0.5)
    bot.world.set('50,40,0', 'air'); bot.world.set('50,41,0', 'air')
    await T.tunnelTo({ bot }, ctl, { x: 32, y: 40, z: 0 }, { noBreachNear: { x: 0, z: 0, r: 48 }, deadline: Date.now() + 5000 })
    assert.equal(inside, false, 'клетка в 47 от бастиона — не вскрывать')
    assert.equal(outside, true, 'клетка в 60 — можно')
  } finally { SL.plan = plan0 }
})

test('штрек по Аду: финальный план не вскрывает двор внутри noBreachNear', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const plan0 = SL.plan; const execute0 = SL.execute
  const ctl: Record<string, any> = { aborted: false }
  const breaches = []
  let executed = false
  SL.plan = async o => {
    if (!o.breachOk) return { ok: false, why: {} as Record<string, any> }
    const allowed = o.breachOk('9,40,0', '9,41,1')
    breaches.push(allowed)
    if (breaches.length === 1 && allowed) return { ok: true, path: [flat(1)] }
    ctl.aborted = true
    return { ok: false, why: {} as Record<string, any> }
  }
  SL.execute = async (session, control, path, S) => {
    executed = true
    breaches.push(S.breachOk('9,40,0', '9,41,1'))
    ctl.aborted = true
    return { ok: true }
  }
  try {
    const bot = fakeBot()
    await T.tunnelTo({ bot }, ctl, { x: 10, y: 40, z: 0 }, {
      noBreachNear: { x: 10, z: 0, r: 48 }, deadline: Date.now() + 5000
    })
    assert.equal(breaches[0], false, 'финальный план отвергает вскрытие двора в одном блоке от бастиона')
    assert.equal(executed, false, 'запрещённый финальный путь не передаётся исполнителю')
  } finally { SL.plan = plan0; SL.execute = execute0 }
})

test('фильтр инструментов: при штреке по незераку железная кирка не берётся, для золота — берётся', () => {
  const tools: typeof import('../src/tools') = require('../src/tools')
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const mcBlock = (require('prismarine-block') as typeof import('prismarine-block'))('1.21.11')
  const pick = (name, left, slot) => ({ name, type: data.itemsByName[name].id, maxDurability: data.itemsByName[name].maxDurability, durabilityUsed: data.itemsByName[name].maxDurability - left, slot, count: 1 })
  const stone = pick('stone_pickaxe', 8, 10)
  const iron = pick('iron_pickaxe', 250, 11)
  const bot: Record<string, any> = { inventory: { items: () => [stone, iron] }, entity: { onGround: true, effects: {} as Record<string, any> }, heldItem: stone }
  const netherrack = mcBlock.fromStateId(data.blocksByName.netherrack.defaultState, 0)
  const gold = mcBlock.fromStateId(data.blocksByName.gold_block.defaultState, 0)
  assert.equal(tools.bestFor(bot, netherrack).item.name, 'iron_pickaxe', 'без фильтра обёртка берёт железную')
  bot._ndToolFilter = T.makeToolFilter(bot, true)
  assert.equal(tools.bestFor(bot, netherrack).item.name, 'stone_pickaxe')
  assert.equal(tools.bestFor(bot, gold).item.name, 'iron_pickaxe')
})

test('штрек по Аду: в радиусе по горизонтали, но на 40 блоков ниже цели — не «дошёл»', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const plan0 = SL.plan
  SL.plan = async o => { const a = o.starts[0]; return o.goal(a.x, a.y, a.z) ? { ok: true, path: [] } : { ok: false, why: {} as Record<string, any> } }
  try {
    const bot = fakeBot()
    bot.pathfinder = { goto () { throw new Error('offline') }, setGoal () {} }
    const r = await T.tunnelTo({ bot }, { aborted: false }, { x: 2, y: 80, z: 0 }, { radius: 4, deadline: Date.now() + 5000 })
    assert.equal(r.ok, false, 'разница высоты 40 — не цель')
  } finally { SL.plan = plan0 }
})

test('штрек по маршруту: кирок на дорогу не хватит — не начинает', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const plan0 = SL.plan
  let plans = 0
  SL.plan = async () => { plans++; return { ok: false, why: {} as Record<string, any> } }
  try {
    const bot = fakeBot()
    const via = [[0, 40, 0], [100, 30, 0], [200, 20, 0], [300, 20, 0]]
    const r = await T.tunnelTo({ bot }, { aborted: false }, { x: 300, y: 20, z: 0 }, { via, budgetCheck: true, deadline: Date.now() + 5000 })
    assert.equal(r.ok, false)
    assert.match(r.why, /кирок на дорогу не хватит/)
    assert.equal(plans, 0, 'не планировал')
  } finally { SL.plan = plan0 }
})

test('штрек по маршруту: вход у ближней к цели точки, куски — без права вскрытия', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const plan0 = SL.plan
  const ctl: Record<string, any> = { aborted: false }
  const calls = []
  const via = [[0, 40, 0], [24, 40, 0], [48, 30, 0], [72, 20, 0]]
  SL.plan = async o => {
    calls.push({ breach: !!o.breachOk, hits: via.map(([x, y, z]: any) => o.goal(x, y, z)), y0: o.box.y0 })
    if (calls.length >= 3) ctl.aborted = true
    return { ok: false, why: {} as Record<string, any> }
  }
  try {
    const bot = fakeBot()
    bot.entity.position = new Vec3(40.5, 38, 0.5)
    bot.world.set('40,38,0', 'air'); bot.world.set('40,39,0', 'air')
    await T.tunnelTo({ bot }, ctl, { x: 72, y: 20, z: 0 }, { via, deadline: Date.now() + 5000 })
    assert.ok(calls.length >= 1)
    assert.equal(calls.some(c => c.breach), false, 'по маршруту без вскрытия')
    assert.equal(calls[0].hits[0], false, 'к началу маршрута не возвращается')
    assert.ok(calls[0].y0 < 33, 'ниже лавового моря можно')
  } finally { SL.plan = plan0 }
})

test('штрек по маршруту: тело у начала маршрута входит в его начало, а не у конца', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const plan0 = SL.plan
  const ctl: Record<string, any> = { aborted: false }
  let first = null
  // «Манхэттенский» маршрут: прямая от начала к концу по длине почти равна маршруту.
  const via = [[0, 40, 0], [30, 40, 0], [30, 40, 30], [60, 40, 30], [60, 40, 60]]
  SL.plan = async o => { if (!first) first = via.map(([x, y, z]: any) => o.goal(x, y, z)); ctl.aborted = true; return { ok: false, why: {} as Record<string, any> } }
  try {
    const bot = fakeBot()
    await T.tunnelTo({ bot }, ctl, { x: 60, y: 40, z: 60 }, { via, deadline: Date.now() + 5000 })
    assert.ok(first, 'план был')
    assert.equal(first[3] || first[4], false, 'не напрямик к концу маршрута')
  } finally { SL.plan = plan0 }
})

test('штрек по маршруту: открытая площадка портала допускает один безопасный вход ногами', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const plan0 = SL.plan
  SL.plan = async () => ({ ok: false, nodes: 1, why: { foreign: 12, hard: 2 } })
  try {
    for (const scenario of ['portal', 'bastion', 'foe']) {
      const bot = fakeBot()
      for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (const y of [40, 41]) bot.world.set(`${x},${y},${z}`, 'air')
      bot.findBlock = () => ({ name: 'nether_portal', position: new Vec3(-1, 40, 0) })
      if (scenario === 'foe') bot.entities = { 1: { name: 'hoglin', position: new Vec3(2, 40, 0) } }
      let steps = 0
      bot.pathfinder = { async goto () { steps++; bot.entity.position = new Vec3(8.5, 40, 0.5) }, setGoal () {} }
      const r = await T.tunnelTo({ bot }, { aborted: false }, { x: 60, y: 40, z: 0 }, {
        via: [[16, 40, 0], [36, 40, 0], [60, 40, 0]],
        noBreachNear: { x: scenario === 'bastion' ? 10 : 100, z: 0, r: 48 }, deadline: Date.now() + 5000
      })
      assert.equal(steps, scenario === 'portal' ? 1 : 0, `${scenario}: вход ногами только далеко от бастиона и врагов`)
      assert.equal(r.ok, false, 'отход не выдаётся за пройденный маршрут')
    }
  } finally { SL.plan = plan0 }
})

test('штрек по маршруту: отказ без движения не пропускает точки как пройденные', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const plan0 = SL.plan
  SL.plan = async () => ({ ok: false, nodes: 1, why: { foreign: 12 } })
  try {
    const bot = fakeBot()
    for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (const y of [40, 41]) bot.world.set(`${x},${y},${z}`, 'air')
    const r = await T.tunnelTo({ bot }, { aborted: false }, { x: 60, y: 40, z: 0 }, {
      via: [[16, 40, 0], [36, 40, 0], [60, 40, 0]], deadline: Date.now() + 5000
    })
    assert.equal(r.moves, 0)
    assert.equal(r.viaDone, 0, 'тело на старте: первая точка не пройдена')
    assert.equal(r.detours, 6, 'недоступная точка прекращает маршрут, а не гонит ещё 27 пустых планов')
  } finally { SL.plan = plan0 }
})

test('запас кирок: брёвна из pickBudget действительно превращаются в каменные кирки', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const actions: typeof import('../src/actions/craft') = require('../src/actions/craft') // craft — в части craft (фасад — геттеры)
  const craft0 = actions.craft
  const item = (name, count) => ({ name, count, type: data.itemsByName[name].id, maxDurability: data.itemsByName[name].maxDurability, durabilityUsed: 0 })
  const inv = [item('birch_log', 3), item('oak_planks', 1), item('stick', 1), item('blackstone', 6), item('crafting_table', 1)]
  const bot = fakeBot(inv)
  bot.inventory.items = () => inv.filter(i => i.count > 0)
  const take = (name, n) => { const i = inv.find(i => i.name === name && i.count >= n); assert.ok(i, `материал ${name}×${n} существует`); i.count -= n }
  actions.craft = async (session, ctl, p) => {
    if (p.item === 'birch_planks') { take('birch_log', 1); inv.push(item('birch_planks', 4)) }
    else if (p.item === 'stick') { take('birch_planks', 2); inv.find(i => i.name === 'stick').count += 4 }
    else if (p.item === 'stone_pickaxe') { take('blackstone', 3); take('stick', 2); inv.push(item('stone_pickaxe', 1)) }
    else throw new Error('неожиданный рецепт ' + p.item)
  }
  try {
    assert.ok(T.pickBudget(bot).craftable >= 2, 'бюджет обещает две кирки из этих же материалов')
    assert.equal(await T.restockPicks({ bot }, { aborted: false }, 2), 2, 'переводит бревно в доски и палки, затем делает обещанные кирки')
    assert.equal(T.lowPicks(bot), 2)
    assert.equal(bot.inventory.items().find(i => i.name === 'birch_log').count, 2, 'лишние брёвна не расходует')
  } finally { actions.craft = craft0 }
})

test('запас кирок: при палках и брёвнах сначала делает недостающий верстак', async () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const actions: typeof import('../src/actions/craft') = require('../src/actions/craft') // craft — в части craft (фасад — геттеры)
  const { spendablePlanks }: typeof import('../src/items') = require('../src/items')
  const craft0 = actions.craft
  const item = (name, count) => ({ name, count, type: data.itemsByName[name].id })
  const inv = [item('birch_log', 1), item('oak_planks', 1), item('stick', 5), item('blackstone', 6)]
  const bot = fakeBot(inv)
  bot.inventory.items = () => inv.filter(i => i.count > 0)
  bot.findBlock = () => null
  const n = name => bot.inventory.items().filter(i => i.name === name).reduce((sum, i) => sum + i.count, 0)
  const take = (name, count) => {
    for (const it of inv.filter(i => i.name === name)) { const used = Math.min(it.count, count); it.count -= used; count -= used }
    assert.equal(count, 0, `ингредиент ${name} есть`)
  }
  const calls = []
  actions.craft = async (session, ctl, p) => {
    calls.push(p.item)
    if (p.item === 'birch_planks') { take('birch_log', 1); inv.push(item('birch_planks', 4)) }
    else if (p.item === 'crafting_table') { take('birch_planks', 4); inv.push(item('crafting_table', 1)) }
    else if (p.item === 'stick') {
      assert.ok(spendablePlanks(bot, data) >= 2, 'настоящий резерв actions.craft оставляет доски верстаку')
      take('birch_planks', 2); inv.push(item('stick', 4))
    } else if (p.item === 'stone_pickaxe') {
      if (!n('crafting_table')) throw new Error('нет верстака и четырёх досок для ensureTable')
      take('stick', 2); take('blackstone', 3); inv.push(item('stone_pickaxe', 1))
    } else throw new Error('неожиданный рецепт ' + p.item)
  }
  try {
    assert.equal(await T.restockPicks({ bot, mcData: data }, { aborted: false }, 2), 2)
    assert.deepEqual(calls.slice(0, 2), ['birch_planks', 'crafting_table'])
    assert.equal(n('crafting_table'), 1)
  } finally { actions.craft = craft0 }
})

test('бюджет кирок: одно бревно даёт 4 доски, а новый верстак стоит ещё 4', () => {
  const T: typeof import('../src/tunnel') = require('../src/tunnel')
  const bot = fakeBot([{ name: 'birch_log', count: 3 }, { name: 'oak_planks', count: 1 }, { name: 'stick', count: 5 }, { name: 'blackstone', count: 60 }])
  bot.findBlock = () => null
  assert.equal(T.pickBudget(bot).craftable, 10, '13 досок минус 4 верстаку: 16 палок плюс имеющиеся 5')
  const inv = bot.inventory.items()
  inv.push({ name: 'crafting_table', count: 1 })
  assert.equal(T.pickBudget(bot).craftable, 14, 'с готовым верстаком все 13 досок доступны')
})
