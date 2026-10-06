'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const bastion = require('../src/bastion')

// Мир-камень с вырезанными клетками (яма тела, свалка, пол пиглинов).
function worldWith (air) {
  const k = (x: any, y: any, z: any) => `${x},${y},${z}`
  const open = new Set(air.map(c => k(...(c as [number, number, number]))))
  return p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    return open.has(k(x, y, z))
      ? { name: 'air', shapes: [], boundingBox: 'empty', position: p }
      : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block', position: p }
  }
}

test('barter resumes after tactical refuge by physically closing the current room before activating the protected branch', async () => {
  const SL = require('../src/sealed')
  const nativeAir = new Set(['0,100,0', '0,101,0', '0,102,0', '1,100,0', '1,101,0', '2,100,0', '2,101,0'])
  const bot: Record<string, any> = { health: 20, entities: {}, game: { dimension: 'the_nether' },
    entity: { position: new Vec3(.5, 100, .5), onGround: true },
    pathfinder: { setGoal: () => {} }, clearControlStates: () => {}, inventory: { items: () => [{ name: 'netherrack', count: 32 }] },
    blockAt: at => worldWith([...nativeAir].map(key => key.split(',').map(Number)))(at) }
  const session = { bot, _tunnelOwn: new Set(['2,100,0', '2,101,0']) }
  const ctl = { aborted: false }
  const fill = SL.fillCell
  const prepared = require('../src/bastion/bastion').prepareBarterCover
  const st: Record<string, any> = { towered: 0 }
  const placed: string[] = []
  SL.fillCell = async (_bot, at) => { const key = SL.keyV(at); placed.push(key); nativeAir.delete(key); return true }
  try {
    const result = await prepared(session, ctl, st, require('../src/game-clock').now() + 60000)
    assert.equal(result.ok, true)
    assert.equal(st.sealedDone, true)
    assert.equal(st.sealedState.exposed, false)
    assert.deepEqual(placed.sort(), ['0,102,0', '1,100,0', '1,101,0'])
    assert.equal(SL.exposure(bot, st.sealedState.own).length, 0, 'native walls, rather than a saved exposed flag, authorize barter')
    assert.ok(st.sealedState.own.has('2,100,0'), 'the actually remembered tunnel remains usable by later protected plans')
    nativeAir.add('1,100,0')
    SL.fillCell = async () => true
    const rejected: Record<string, any> = {}
    assert.equal((await prepared(session, ctl, rejected, require('../src/game-clock').now() + 60000)).ok, false,
      'a successful placement return cannot replace an actual confirmed wall')
    assert.equal(rejected.sealedState, undefined)
    SL.fillCell = async () => { ctl.aborted = true; return false }
    assert.equal((await prepared(session, ctl, rejected, require('../src/game-clock').now() + 60000)).ok, false)
    assert.equal(rejected.sealedState, undefined, 'tactical interruption cannot publish a protected trade state')
  } finally { SL.fillCell = fill }
})

test('physical cover restoration preserves an existing safe upper trading mouth and rejects dangerous floors', async () => {
  const SL = require('../src/sealed')
  const air = [[0, 100, 0], [0, 101, 0], [0, 102, 0], [0, 102, 1]]
  const bot: Record<string, any> = { health: 20, game: { dimension: 'the_nether' },
    entity: { position: new Vec3(.5, 100, .5), onGround: true },
    pathfinder: { setGoal: () => {} }, clearControlStates: () => {}, inventory: { items: () => [] }, blockAt: worldWith(air) }
  const prepare = require('../src/bastion/bastion').prepareBarterCover
  const st: Record<string, any> = {}
  const result = await prepare({ bot }, { aborted: false }, st, require('../src/game-clock').now() + 60000)
  assert.equal(result.ok, true)
  assert.equal(result.n, 0)
  assert.equal(SL.classOf(bot.blockAt(new Vec3(0, 102, 0))), SL.AIR, 'a ready trading mouth stays open')
  const native = bot.blockAt
  for (const floor of [null, { name: 'lava', boundingBox: 'empty', shapes: [] },
    { name: 'magma_block', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }]) {
    bot.blockAt = at => at.x === 0 && at.y === 99 && at.z === 0 ? floor : native(at)
    const unsafe: Record<string, any> = {}
    assert.equal((await prepare({ bot }, { aborted: false }, unsafe, require('../src/game-clock').now() + 60000)).ok, false)
    assert.equal(unsafe.sealedDone, undefined)
  }
})

test('cover refusal carries the actual unrounded body and loaded geometry without authorizing barter', async () => {
  const SL = require('../src/sealed')
  const prepare = require('../src/bastion/bastion').prepareBarterCover
  const position = new Vec3(53.1723, 37, 112.9182)
  const bot = { health: 20, entities: {}, game: { dimension: 'the_nether' }, physics: { playerHalfWidth: .3, playerHeight: 1.8 },
    entity: { position, onGround: true }, pathfinder: { setGoal: () => {} }, clearControlStates: () => {},
    inventory: { items: () => [{ name: 'netherrack', count: 32 }] },
    blockAt: worldWith([[53, 37, 112], [53, 38, 112], [53, 39, 112], [54, 37, 112], [54, 38, 112]]) }
  const original = SL.fillCell
  SL.fillCell = async () => false
  const st: Record<string, any> = {}
  try {
    const refused = await prepare({ bot }, { aborted: false }, st, require('../src/game-clock').now() + 60000)
    assert.equal(refused.ok, false)
    assert.equal(refused.why, 'стены или потолок физически не замкнуты')
    assert.equal(st.sealedDone, undefined)
    assert.equal(st.sealedState, undefined)
    assert.deepEqual(refused.diagnostic.position, { x: position.x, y: position.y, z: position.z })
    assert.equal(refused.diagnostic.onGround, true)
    assert.equal(refused.diagnostic.body.minX, position.x - .3)
    assert.equal(refused.diagnostic.body.maxZ, position.z + .3)
    assert.ok(refused.diagnostic.cells.length <= 24)
    assert.ok(refused.diagnostic.cells.some(cell => cell.position.y === 36 && cell.name === 'blackstone' && cell.loaded))
    assert.ok(refused.diagnostic.breaches.some(breach => breach.open === '54,37,112'))
  } finally { SL.fillCell = original }
})

test('готовая физически закрытая яма сразу исполняется повторным digPit без новой копки', async () => {
  const air = [[0, 100, 0], [0, 101, 0], [0, 102, 0]]
  for (let z = 1; z <= 4; z++) for (let y = 102; y <= 104; y++) air.push([0, y, z])
  const piglin = { id: 7, name: 'piglin', position: new Vec3(.5, 102, 2.5), metadata: [false, 0], isValid: true }
  let digs = 0
  const bot: Record<string, any> = { entity: { position: new Vec3(.5, 100, .5), onGround: true },
    registry: { entitiesByName: { piglin: { metadataKeys: ['baby', 'mob_flags'] } } },
    blockAt: worldWith(air), entities: { 7: piglin }, dig: async () => { digs++; throw new Error('ready pit must not dig') } }
  const S = { own: new Set(['0,100,0', '0,101,0']), fails: [] }
  const bo = await require('../src/bastion/bastion').digPit({ bot }, { aborted: false }, { sealedState: S }, require('../src/game-clock').now() + 180000)
  assert.equal(bo.reused, true)
  assert.deepEqual(bo.P, { x: 0, y: 100, z: 0 })
  assert.deepEqual(bo.O, { x: 0, y: 102, z: 1 })
  assert.equal(digs, 0)
  assert.equal(S.own.has('0,102,0'), true)
  bot.blockAt = worldWith([...air, [1, 100, 0]])
  assert.equal(require('../src/bastion/booth-trade').currentPit(bot, S), null, 'an opening at body level forbids reusing the trade position')
  bot.blockAt = worldWith(air)
  piglin.position.y = 105
  assert.equal(require('../src/bastion/booth-trade').currentPit(bot, S), null, 'another floor cannot masquerade as an accessible trader')
})

test('свалка ямы: прицел находится, и брошенное при любом разбросе ложится на 1 ниже ног', () => {
  // Тело: ноги (0,100,0), голова (0,101,0); свалка сбоку по +x: Dh (1,101,0), D1 (1,100,0), D2 (1,99,0).
  const bot: Record<string, any> = { entity: { position: new Vec3(0.5, 100, 0.5) }, blockAt: worldWith([[0, 100, 0], [0, 101, 0], [1, 101, 0], [1, 100, 0], [1, 99, 0]]) }
  const bo = { kind: 'pit', P: { x: 0, y: 100, z: 0 }, dump: { Dh: { x: 1, y: 101, z: 0 }, D1: { x: 1, y: 100, z: 0 }, D2: { x: 1, y: 99, z: 0 } } }
  const aim = bastion.dumpAim(bot, bo)
  assert.ok(aim, 'прицел есть')
  for (const dvy of [-0.1, 0, 0.1]) {
    const at = bastion.tossLands(bot, aim, null, dvy)
    assert.equal(Math.floor(at.x), 1)
    assert.ok(at.y < 99.5, `лёг на ${at.y}`)
  }
})

test('бросок пиглина в яму: из 2 блоков перед ртом добыча падает к нам', () => {
  // Яма: ноги (0,100,0); рот (0,102,0); пол пиглинов y=102 (блоки на 101) по +z; над ртом стена.
  const air = [[0, 100, 0], [0, 101, 0], [0, 102, 0]]
  for (let x = -3; x <= 3; x++) for (let z = 1; z <= 5; z++) for (let y = 102; y <= 104; y++) air.push([x, y, z])
  const bot: Record<string, any> = { entity: { position: new Vec3(0.5, 100, 0.5) }, blockAt: worldWith(air) }
  const near = bastion.throwLands(bot, new Vec3(0.5, 102, 2.5), bot.entity.position)
  assert.ok(near.ok, 'из 2 блоков напротив — в досягаемости')
  const far = bastion.throwLands(bot, new Vec3(0.5, 102, 5.5), bot.entity.position)
  assert.ok(!far.ok, 'из 5 блоков — нет')
})

test('ловушка торговцев: место находится на ровном полу, и бросок из обеих клеток камеры долетает', () => {
  const SL = require('../src/sealed')
  // Пол пиглинов: ноги y=0 (блоки на −1), ниже — камень. Ловушка на O=(0,0,1), d=(0,1).
  const view = { cls: (x, y, z) => y >= 0 ? SL.AIR : SL.SOLID }
  const t = bastion.trapAt(view, new Set(), { x: 0, y: 0, z: 1 }, [0, 1])
  assert.ok(t, 'ловушка есть')
  assert.deepEqual([t.C0, t.M, t.P], [{ x: 0, y: -2, z: 1 }, { x: 0, y: -2, z: 0 }, { x: 0, y: -4, z: 0 }])
  assert.deepEqual(t.C2, { x: 0, y: -2, z: 2 })
  assert.ok(t.dump, 'свалка есть')
  // Мир после копки: тело (P,H), рот M, камера C0/C1 и C2/C2+1.
  const air = [[0, -4, 0], [0, -3, 0], [0, -2, 0], [0, -2, 1], [0, -1, 1], [0, -2, 2], [0, -1, 2]]
  const k = (x: any, y: any, z: any) => `${x},${y},${z}`
  const open = new Set(air.map(c => k(...(c as [number, number, number]))))
  const blockAt = p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    return (y >= 0 || open.has(k(x, y, z))) ? { name: 'air', shapes: [], boundingBox: 'empty' } : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' }
  }
  const bot: Record<string, any> = { entity: { position: new Vec3(0.5, -4, 0.5) }, blockAt }
  for (const [x, z] of [[0.5, 1.5], [0.3, 1.3], [0.7, 1.7], [0.5, 2.5], [0.3, 2.7]]) {
    assert.ok(bastion.throwLands(bot, new Vec3(x, -2, z), bot.entity.position).ok, `из ${x},${z}`)
  }
})

test('ловушка: приманка, брошенная стоя ногами в H (голова в клетке рта), ложится в дальнюю клетку камеры', () => {
  // Момент броска: вскрыты M (голова), C0 (низ ближней), C2 и C2+1 (дальняя открыта к полу); C1 ещё пол.
  const air = [[0, -3, 0], [0, -2, 0], [0, -2, 1], [0, -2, 2], [0, -1, 2]]
  const k = (x: any, y: any, z: any) => `${x},${y},${z}`
  const open = new Set(air.map(c => k(...(c as [number, number, number]))))
  const blockAt = p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    return (y >= 0 || open.has(k(x, y, z))) ? { name: 'air', shapes: [], boundingBox: 'empty' } : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' }
  }
  const bot: Record<string, any> = { entity: { position: new Vec3(0.5, -3, 0.5) }, blockAt }
  const aim = bastion.baitAim(bot, { C2: { x: 0, y: -2, z: 2 }, d: [0, 1] })
  assert.ok(aim, 'прицел приманки есть')
  for (const dvy of [-0.1, 0, 0.1]) {
    const at = bastion.tossLands(bot, aim, null, dvy)
    assert.deepEqual([Math.floor(at.x), Math.floor(at.y), Math.floor(at.z)], [0, -2, 2], `разброс ${dvy}: ${at.x.toFixed(2)},${at.y.toFixed(2)},${at.z.toFixed(2)}`)
  }
})

test('приманка из ямы: прицел сквозь рот кладёт слиток дальше нашей рамки подбора, туда, откуда бросок долетит', () => {
  // Яма: ноги (0,100,0); рот (0,102,0); пол пиглинов y=102 по +z (x −3..3, z 1..5), над ртом стена.
  const air = [[0, 100, 0], [0, 101, 0], [0, 102, 0]]
  for (let x = -3; x <= 3; x++) for (let z = 1; z <= 5; z++) for (let y = 102; y <= 104; y++) air.push([x, y, z])
  const bot: Record<string, any> = { entity: { position: new Vec3(0.5, 100, 0.5) }, blockAt: worldWith(air) }
  const bo = { kind: 'pit', M: { x: 0, y: 102, z: 0 }, d: [0, 1] }
  const t0 = Date.now()
  const lures = bastion.pitLures(bot, bo)
  const ms = Date.now() - t0
  assert.ok(lures.length > 0, 'прицелы есть')
  assert.ok(ms < 5000, `считается ${ms} мс`)
  const best = lures[0]
  assert.ok(best.score >= 5, `лучшая оценка ${best.score}`)
  assert.ok(best.pl >= 0.6, `доля долетающих ${best.pl}`)
  for (const dvy of [-0.04, 0, 0.04]) {
    const at = bastion.tossLands(bot, best.aim, null, dvy)
    assert.ok(Math.abs(at.y - 102) < 0.3, `лёг на пол (y ${at.y.toFixed(2)})`)
    assert.ok(Math.hypot(at.x - 0.5, at.z - 0.5) >= 1.6, 'дальше рамки подбора')
  }
})

test('золото в руке между сделками не держим: пустая клетка хотбара или инструмент', async () => {
  const slots = new Array(46).fill(null)
  slots[36] = { name: 'gold_ingot', type: 1, count: 30, slot: 36 }
  slots[37] = { name: 'diamond_pickaxe', type: 2, count: 1, slot: 37 }
  let q = 0; let equipped = null
  const bot: Record<string, any> = { heldItem: slots[36], inventory: { slots, items: () => slots.filter(Boolean) }, setQuickBarSlot: i => { q = i }, equip: async it => { equipped = it.name } }
  assert.equal(await bastion.unholdGold(bot), true)
  assert.equal(q, 2, 'выбрана первая пустая клетка хотбара')
  for (let i = 38; i < 45; i++) slots[i] = { name: 'netherrack', type: 3, count: 64, slot: i }
  assert.equal(await bastion.unholdGold(bot), true)
  assert.equal(equipped, 'diamond_pickaxe', 'хотбар полон — в руку кирку')
  bot.heldItem = slots[37]
  assert.equal(await bastion.unholdGold(bot), false, 'не золото — ничего не делаем')
})

test('яма замыкается перед торгом: штрек у тела и угловые клетки заложены, свалка открыта', async () => {
  const SL = require('../src/sealed')
  const k = (x: any, y: any, z: any) => `${x},${y},${z}`
  // Тело (0,100,0)+(0,101,0); штрек подходит по +x: (1,100,0)/(1,101,0), дальше (2,100,0)/(2,101,0) и
  // угловой (1,100,1)/(1,101,1); свалка по −x: Dh (−1,101,0), D1 (−1,100,0), D2 (−1,99,0), к D1 примыкает
  // клетка штрека (−1,100,−1).
  const open = new Set([[0, 100, 0], [0, 101, 0], [1, 100, 0], [1, 101, 0], [2, 100, 0], [2, 101, 0], [1, 100, 1], [1, 101, 1],
    [-1, 101, 0], [-1, 100, 0], [-1, 99, 0], [-1, 100, -1]].map(c => k(...(c as [number, number, number]))))
  const blockAt = p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    return open.has(k(x, y, z)) ? { name: 'air', shapes: [], boundingBox: 'empty', position: p } : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block', position: p }
  }
  const bot: Record<string, any> = { entity: { position: new Vec3(0.5, 100, 0.5) }, blockAt }
  const order = []
  const fill0 = SL.fillCell
  SL.fillCell = async (b, v) => { order.push(k(v.x, v.y, v.z)); open.delete(k(v.x, v.y, v.z)); return true }
  try {
    const S = { own: new Set([...open]) }
    const dump = [{ x: -1, y: 101, z: 0 }, { x: -1, y: 100, z: 0 }, { x: -1, y: 99, z: 0 }]
    const r = await bastion.sealBody(bot, S, dump)
    for (const c of ['1,100,0', '1,101,0', '1,100,1', '1,101,1', '-1,100,-1']) assert.ok(order.includes(c), `заложена ${c}: ${order.join(' ')}`)
    assert.ok(order.indexOf('1,100,1') < order.indexOf('1,100,0'), 'угловая раньше грани')
    for (const c of ['-1,101,0', '-1,100,0', '-1,99,0']) assert.ok(open.has(c), `свалка ${c} открыта`)
    assert.ok(!order.includes('2,100,0'), 'дальний штрек не трогаем')
    assert.equal(r.n, order.length)
  } finally { SL.fillCell = fill0 }
})

test('хлам бастиона и ямы не выбрасывает аварийный запас (pack.RESERVE): блоки стройки и еду', async () => {
  function bagBot (list) {
    const items = list.map(([name, count]: any, slot) => ({ name, count, slot }))
    return {
      registry: { foodsByName: { potato: {} as Record<string, any>, cooked_beef: {} as Record<string, any>, rotten_flesh: {} as Record<string, any> } },
      inventory: { items: () => items.slice() },
      tossStack: async it => { items.splice(items.indexOf(it), 1) }
    }
  }
  // Кирпич бастиона — блок стройки в Аду; базальт — тоже. Всего 30: базальт (10) выбросить можно, кирпич (20) — нет.
  const bot = bagBot([['polished_blackstone_bricks', 20], ['soul_sand', 5], ['basalt', 10]])
  const tossed = await bastion.dropJunk(bot)
  assert.deepEqual(tossed.sort(), ['basalt×10', 'soul_sand×5'])
  assert.equal(bot.inventory.items().find(i => i.name === 'polished_blackstone_bricks').count, 20, 'без блоков нет коробки отхода')
  // Яма: гнилая плоть — в свалку, а картошка — последняя еда (запас 2) — нет.
  const pit = bagBot([['rotten_flesh', 7], ['potato', 3], ['gold_ingot', 30]])
  assert.deepEqual(bastion.pitJunk(pit).map(i => i.name), ['rotten_flesh'])
})
