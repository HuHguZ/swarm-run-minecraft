'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const bastion = require('../src/bastion')

// Мир-камень с вырезанными клетками (яма тела, свалка, пол пиглинов).
function worldWith (air) {
  const k = (x, y, z) => `${x},${y},${z}`
  const open = new Set(air.map(c => k(...c)))
  return p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    return open.has(k(x, y, z))
      ? { name: 'air', shapes: [], boundingBox: 'empty', position: p }
      : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block', position: p }
  }
}

test('свалка ямы: прицел находится, и брошенное при любом разбросе ложится на 1 ниже ног', () => {
  // Тело: ноги (0,100,0), голова (0,101,0); свалка сбоку по +x: Dh (1,101,0), D1 (1,100,0), D2 (1,99,0).
  const bot = { entity: { position: new Vec3(0.5, 100, 0.5) }, blockAt: worldWith([[0, 100, 0], [0, 101, 0], [1, 101, 0], [1, 100, 0], [1, 99, 0]]) }
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
  const bot = { entity: { position: new Vec3(0.5, 100, 0.5) }, blockAt: worldWith(air) }
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
  const k = (x, y, z) => `${x},${y},${z}`
  const open = new Set(air.map(c => k(...c)))
  const blockAt = p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    return (y >= 0 || open.has(k(x, y, z))) ? { name: 'air', shapes: [], boundingBox: 'empty' } : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' }
  }
  const bot = { entity: { position: new Vec3(0.5, -4, 0.5) }, blockAt }
  for (const [x, z] of [[0.5, 1.5], [0.3, 1.3], [0.7, 1.7], [0.5, 2.5], [0.3, 2.7]]) {
    assert.ok(bastion.throwLands(bot, new Vec3(x, -2, z), bot.entity.position).ok, `из ${x},${z}`)
  }
})

test('ловушка: приманка, брошенная стоя ногами в H (голова в клетке рта), ложится в дальнюю клетку камеры', () => {
  // Момент броска: вскрыты M (голова), C0 (низ ближней), C2 и C2+1 (дальняя открыта к полу); C1 ещё пол.
  const air = [[0, -3, 0], [0, -2, 0], [0, -2, 1], [0, -2, 2], [0, -1, 2]]
  const k = (x, y, z) => `${x},${y},${z}`
  const open = new Set(air.map(c => k(...c)))
  const blockAt = p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    return (y >= 0 || open.has(k(x, y, z))) ? { name: 'air', shapes: [], boundingBox: 'empty' } : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block' }
  }
  const bot = { entity: { position: new Vec3(0.5, -3, 0.5) }, blockAt }
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
  const bot = { entity: { position: new Vec3(0.5, 100, 0.5) }, blockAt: worldWith(air) }
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
  const bot = { heldItem: slots[36], inventory: { slots, items: () => slots.filter(Boolean) }, setQuickBarSlot: i => { q = i }, equip: async it => { equipped = it.name } }
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
  const k = (x, y, z) => `${x},${y},${z}`
  // Тело (0,100,0)+(0,101,0); штрек подходит по +x: (1,100,0)/(1,101,0), дальше (2,100,0)/(2,101,0) и
  // угловой (1,100,1)/(1,101,1); свалка по −x: Dh (−1,101,0), D1 (−1,100,0), D2 (−1,99,0), к D1 примыкает
  // клетка штрека (−1,100,−1).
  const open = new Set([[0, 100, 0], [0, 101, 0], [1, 100, 0], [1, 101, 0], [2, 100, 0], [2, 101, 0], [1, 100, 1], [1, 101, 1],
    [-1, 101, 0], [-1, 100, 0], [-1, 99, 0], [-1, 100, -1]].map(c => k(...c)))
  const blockAt = p => {
    const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
    return open.has(k(x, y, z)) ? { name: 'air', shapes: [], boundingBox: 'empty', position: p } : { name: 'blackstone', shapes: [[0, 0, 0, 1, 1, 1]], boundingBox: 'block', position: p }
  }
  const bot = { entity: { position: new Vec3(0.5, 100, 0.5) }, blockAt }
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
    const items = list.map(([name, count], slot) => ({ name, count, slot }))
    return {
      registry: { foodsByName: { potato: {}, cooked_beef: {}, rotten_flesh: {} } },
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
