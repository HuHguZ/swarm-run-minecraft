'use strict'
// S7c (07.10): щит в размене кристаллов (его поднятый щит гасит взрыв в передних 90°), уклонение ценой —
// щит лицом к кристаллу / укрытие / блок между — и хп соперника-игрока только оценкой.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const cr = require('../src/crystal')
const boom = require('../src/boom')
const { EventEmitter } = require('node:events')
const clock = require('../src/game-clock')
const combat = require('../src/combat')

function duelBot ({ foeAt = new Vec3(4.5, 0, 0.5), inv = null, extra = {} as Record<string, any> }: any = {}) {
  const registry = require('minecraft-data')('1.21.11')
  const blocks = new Map(Object.entries<any>(extra))
  const block = (p) => {
    const k = `${p.x},${p.y},${p.z}`
    const name = blocks.has(k) ? blocks.get(k) : (p.y === -1 ? 'obsidian' : 'air')
    const solid = name !== 'air'
    return { name, boundingBox: solid ? 'block' : 'empty', shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], position: new Vec3(p.x, p.y, p.z), getProperties: () => ({ charges: name === 'respawn_anchor' ? (extra.charges ?? 1) : 0 }) }
  }
  const bot: Record<string, any> = {
    entity: { id: 1, position: new Vec3(0.5, 0, 0.5), width: 0.6, height: 1.8, type: 'player', name: 'player', metadata: [], onGround: true },
    entities: {},
    blockAt: (p) => block({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }),
    world: { raycast: () => null },
    registry, health: 20, game: { difficulty: 'normal' },
    on: () => {}, removeListener: () => {}, _client: { on: () => {}, removeListener: () => {} }
  }
  bot.entities[1] = bot.entity
  const item = (name, count = 1) => ({ name, count, slot: 36 })
  const items = inv ? inv.map(n => item(n, 64)) : [item('end_crystal', 64), item('obsidian', 64), item('diamond_sword')]
  const ench = (name, id) => ({ name, count: 1, componentMap: new Map([['enchantments', { data: { enchantments: [{ id: 'minecraft:' + id, level: 4 }] } }]]) })
  const armor = [ench('diamond_helmet', 'protection'), ench('diamond_chestplate', 'protection'), ench('diamond_leggings', 'blast_protection'), ench('diamond_boots', 'protection')]
  const slots = []
  slots[5] = armor[0]; slots[6] = armor[1]; slots[7] = armor[2]; slots[8] = armor[3]
  bot.inventory = { items: () => items, slots }
  const foe: Record<string, any> = { id: 2, name: 'player', type: 'player', username: 'Foe', position: foeAt, yaw: Math.PI / 2, width: 0.6, height: 1.8, metadata: [], equipment: [null, null, armor[3], armor[2], armor[1], armor[0]], isValid: true }
  bot.entities[2] = foe
  return { bot, foe }
}
const crystalAt = (bot, id, x, z) => { const e = { id, name: 'end_crystal', position: new Vec3(x, 0, z), width: 2, height: 2, isValid: true }; bot.entities[id] = e; return e }

test('размен: его поднятый щит гасит кристалл спереди (ему 0), кристалл за спиной бьёт', () => {
  const { bot, foe } = duelBot()
  const dMe = boom.defenseOf(bot, bot.entity); const dHim = boom.defenseOf(bot, foe)
  // Он смотрит на -x (на меня, yaw π/2): кристалл между нами — в его переднем конусе.
  const front = cr.trade(bot, new Vec3(2.5, 0, 0.5), foe, bot.entity, dHim, dMe, new Map(), { himShield: true })
  assert.equal(front.him, 0)
  const open = cr.trade(bot, new Vec3(2.5, 0, 0.5), foe, bot.entity, dHim, dMe, new Map(), { himShield: false })
  assert.ok(open.him > 5, `без щита ${open.him}`)
  const back = cr.trade(bot, new Vec3(6.5, 0, 0.5), foe, bot.entity, dHim, dMe, new Map(), { himShield: true })
  assert.ok(back.him > 5, `за спиной ${back.him}`)
  assert.equal(cr.shieldCovers(foe, foe.position, new Vec3(4.3, 0, 3.5)), true, 'сбоку чуть впереди — держит')
  assert.equal(cr.shieldCovers(foe, foe.position, new Vec3(5.5, 0, 3.5)), false, 'сзади-сбоку — нет')
})

test('уклонение: кристалл в 3 блоках, обсидиан есть — блок между (ожидаемый урон меньше стоять)', () => {
  const { bot, foe } = duelBot({ foeAt: new Vec3(6.5, 0, 0.5) })
  const c = cr.create(bot, { enemy: () => foe })
  const cry = crystalAt(bot, 9, 3.5, 0.5)
  const dMe = boom.defenseOf(bot, bot.entity)
  const t = cr.trade(bot, cry.position, foe, bot.entity, boom.defenseOf(bot, foe), dMe, new Map())
  const a = c.evade([{ c: cry, t }], { dMe, myEff: 20, cache: new Map() })
  assert.ok(a, 'есть вариант')
  assert.equal(a.kind, 'wall', JSON.stringify({ kind: a.kind, note: a.note }))
  assert.ok(a.dmg < t.me * 0.5, `за блоком ${a.dmg} при ${t.me}`)
  // Блок — между: ближе ко мне, чем кристалл, и не в рамке кристалла (2×2×2 мешает стройке).
  for (const cell of a.cells) assert.ok(cell.x + 1 <= cry.position.x - 1 + 1e-9, `клетка ${cell}`)
  c.close()
})

test('уклонение: кристалл в 2 блоках (блок не встать — рамка кристалла), щит есть — щит лицом к нему', () => {
  const { bot, foe } = duelBot({ inv: ['end_crystal', 'diamond_sword', 'shield'] })
  const c = cr.create(bot, { enemy: () => foe })
  const cry = crystalAt(bot, 9, 2.5, 0.5)
  const dMe = boom.defenseOf(bot, bot.entity)
  const t = cr.trade(bot, cry.position, foe, bot.entity, boom.defenseOf(bot, foe), dMe, new Map())
  const a = c.evade([{ c: cry, t }], { dMe, myEff: 20, cache: new Map() })
  assert.ok(a && a.kind === 'shield', JSON.stringify(a && { kind: a.kind, note: a.note }))
  // Взгляд на кристалл: +x от меня (yaw −π/2 в соглашении mineflayer).
  assert.ok(Math.abs(a.yaw + Math.PI / 2) < 1e-6, `yaw ${a.yaw}`)
  c.close()
})

test('уклонение: рядом ступень вниз (яма за спиной) — укрытие, если лучи к телу закрыты', () => {
  // Яма 1×1 глубиной 1 в (-1,-1,0): стоя в ней, тело ниже пола — кристалл на полу видит лишь верх.
  const { bot, foe } = duelBot({ inv: ['end_crystal', 'diamond_sword'], extra: { '-1,-1,0': 'air', '-1,-2,0': 'obsidian' } })
  const c = cr.create(bot, { enemy: () => foe })
  const cry = crystalAt(bot, 9, 2.5, 0.5)
  const dMe = boom.defenseOf(bot, bot.entity)
  const t = cr.trade(bot, cry.position, foe, bot.entity, boom.defenseOf(bot, foe), dMe, new Map())
  const cv = c.coverSpot([{ c: cry, t }], dMe, new Map())
  assert.ok(cv, 'укрытие есть')
  assert.ok(cv.dmg < t.me, `в укрытии ${cv.dmg} против ${t.me}`)
  c.close()
})

test('хп соперника-игрока в решениях — оценкой (foeHp), не метаданными', () => {
  const { bot, foe } = duelBot()
  foe.metadata[9] = 20
  const c = cr.create(bot, { enemy: () => foe, foeHp: () => 7.5 })
  if (cr.CX2) assert.equal(c.hisHp(foe), 7.5)
  const c0 = cr.create(bot, { enemy: () => foe })
  assert.equal(c0.hisHp(foe), 20, 'без оценки — метаданные (мобы, телеметрия)')
  c.close(); c0.close()
})

const anchorBlock = (x, z) => ({ name: 'respawn_anchor', position: new Vec3(x, 0, z) })

test('его заряженный якорь у его ног, мне дальше — подрываю сам (anchorPop)', () => {
  const { bot, foe } = duelBot({ inv: ['respawn_anchor', 'glowstone', 'diamond_sword'], extra: { '3,0,0': 'respawn_anchor' } })
  const c = cr.create(bot, { enemy: () => foe, foeHp: () => 20 })
  c._onBlock(null, anchorBlock(3, 0))
  const a = c.plan({})
  if (cr.CX2) assert.ok(a && a.kind === 'anchorPop', JSON.stringify(a && { kind: a.kind, note: a.note }))
  c.close()
})

test('его якорь между нами (мне столько же, сколько ему) — не подрываю, блок между', () => {
  const { bot, foe } = duelBot({ inv: ['respawn_anchor', 'glowstone', 'obsidian', 'diamond_sword'], extra: { '2,0,0': 'respawn_anchor' } })
  const c = cr.create(bot, { enemy: () => foe, foeHp: () => 20 })
  c._onBlock(null, anchorBlock(2, 0))
  const a = c.plan({})
  if (cr.CX2) {
    assert.ok(a && a.kind !== 'anchorPop', 'не в мою пользу — не подрываю')
    assert.ok(a && /^(wall|cover|shield)$/.test(a.kind), JSON.stringify(a && { kind: a.kind, note: a.note }))
  }
  c.close()
})

test('защита от видимого вражеского якоря работает без собственной взрывчатки', () => {
  const { bot, foe } = duelBot({ inv: ['obsidian', 'diamond_sword'], extra: { '2,0,0': 'respawn_anchor' } })
  const c = cr.create(bot, { enemy: () => foe, foeHp: () => 20 })
  c._onBlock(null, anchorBlock(2, 0))
  try {
    assert.equal(c.engaged(), true, 'чужой видимый якорь включает защиту')
    const a = c.plan({})
    assert.ok(a && /^(wall|cover|shield)$/.test(a.kind), JSON.stringify(a && { kind: a.kind, note: a.note }))
  } finally { c.close() }
})

test('свой якорь: себе дорого — заслон из светокамня между мной и якорем снижает мне урон', () => {
  const { bot, foe } = duelBot({ foeAt: new Vec3(3.5, 0, 0.5), inv: ['respawn_anchor', 'glowstone', 'diamond_sword'] })
  const c = cr.create(bot, { enemy: () => foe })
  const cell = new Vec3(2, 0, 0)
  const center = cell.offset(0.5, 0.5, 0.5)
  const dMe = boom.defenseOf(bot, bot.entity); const dHim = boom.defenseOf(bot, foe)
  const open = cr.trade(bot, center, foe, bot.entity, dHim, dMe, new Map(), { power: 5 })
  const living = [bot.entity, foe]
  const g = c.guardFor(cell, center, new Map(), living, { himAt: foe.position, dHim, dMe, foe, himShield: false })
  assert.ok(g, 'заслон найден')
  assert.ok(g.t.me < open.me * 0.5, `мне ${g.t.me} против ${open.me} без заслона`)
  assert.ok(g.t.him > open.him * 0.8, `ему почти столько же: ${g.t.him} против ${open.him}`)
  c.close()
})

test('прикрыт стенкой от его кристалла (он с луком отошёл) — держу укрытие или сбиваю его кристалл, не выхожу', () => {
  const { bot, foe } = duelBot({ foeAt: new Vec3(7.5, 0, 0.5), extra: { '1,0,0': 'obsidian', '1,1,0': 'obsidian' } })
  foe.equipment[0] = { name: 'bow' }
  const c = cr.create(bot, { enemy: () => foe, foeHp: () => 20 })
  const cry = crystalAt(bot, 9, 3.5, 0.5)
  void cry
  const a = c.plan({})
  if (cr.CX2) assert.ok(a && (a.kind === 'hold' || (a.kind === 'defuse' && a.why === 'clear')), JSON.stringify(a && { kind: a.kind, why: a.why, note: a.note }))
  c.close()
})

test('его кристалл у меня, а он отошёл без лука в руке — времени много: укрытие дальше (до 6 бл.), урона меньше', () => {
  const { bot, foe } = duelBot({ foeAt: new Vec3(9.5, 0, 0.5), inv: ['end_crystal', 'diamond_sword'] })
  const c = cr.create(bot, { enemy: () => foe })
  const cry = crystalAt(bot, 9, 2.5, 0.5)
  const dMe = boom.defenseOf(bot, bot.entity)
  const t = cr.trade(bot, cry.position, foe, bot.entity, boom.defenseOf(bot, foe), dMe, new Map())
  const a = c.evade([{ c: cry, t }], { dMe, myEff: 20, cache: new Map(), foe })
  assert.ok(a && a.kind === 'cover', JSON.stringify(a && { kind: a.kind, note: a.note }))
  assert.ok(a.to.distanceTo(cry.position) >= 5, `ушёл на ${a.to.distanceTo(cry.position).toFixed(1)} бл.`)
  assert.ok(a.dmg < t.me * 0.6, `${a.dmg} против ${t.me}`)
  c.close()
})

test('S7d честно: его якорь за стеной (не виден) — не угроза и не цель; его кристалл за стеной — не в угрозах', () => {
  // Стена из обсидиана x=1..2, y=0..3, z=-2..2 — между мной (x 0.5) и якорем/кристаллом (x 3–4).
  const extra = { '3,0,0': 'respawn_anchor' }
  for (let x = 1; x <= 2; x++) for (let y = 0; y <= 3; y++) for (let z = -2; z <= 2; z++) extra[`${x},${y},${z}`] = 'obsidian'
  const { bot, foe } = duelBot({ foeAt: new Vec3(5.5, 0, 0.5), inv: ['respawn_anchor', 'glowstone', 'obsidian', 'diamond_sword'], extra })
  // Луч мира: первый твёрдый блок по пути (как bot.world.raycast) — стена.
  bot.world.raycast = (from, dir, len) => {
    for (let t = 0; t <= len; t += 0.05) {
      const p = from.plus(dir.scaled(t))
      const b = bot.blockAt(p)
      if (b && b.boundingBox === 'block') return { position: b.position, intersect: p }
    }
    return null
  }
  const c = cr.create(bot, { enemy: () => foe, foeHp: () => 20 })
  c._onBlock(null, anchorBlock(3, 0))
  crystalAt(bot, 9, 3.5, 2.5)
  const a = c.plan({})
  assert.ok(!a || !/^(anchorPop|wall|cover|shield|dodge|defuse)$/.test(a.kind), JSON.stringify(a && { kind: a.kind, note: a.note }))
  // Кристалл за стеной отфильтрован восприятием (не «увиден»), а не случайно: счётчик скрытых.
  if (process.env.ND_HONEST_CX !== '0') assert.ok((c.st.hiddenCrystals || 0) > 0, JSON.stringify(c.st))
  c.close()
})

test('S7d close crystal needs first LOS even inside two blocks; opening the wall reveals it', () => {
  const fs = require('node:fs'); const path = require('node:path'); const Module = require('node:module')
  const file = path.join(__dirname, '../src/crystal.ts'); const mod = new Module(file, module)
  mod.filename = file; mod.paths = Module._nodeModulePaths(path.dirname(file))
  mod._compile(require('esbuild').transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, file)
  const { bot, foe } = duelBot({ inv: ['diamond_sword'] })
  const open = bot.blockAt; let wall = true
  bot.blockAt = p => wall && Math.floor(p.x) === 1
    ? { name: 'obsidian', boundingBox: 'block', position: p.floored(), shapes: [[0, 0, 0, 1, 1, 1]] }
    : open(p)
  bot.world.raycast = (eye, dir, len) => {
    const hit = require('../src/pick').blockOnRay(bot, eye, dir, len)
    return hit && { position: hit.pos, intersect: eye.plus(dir.scaled(hit.t)) }
  }
  const cry = crystalAt(bot, 9, 2.2, .5); cry.position.y = 1
  assert.ok(cry.position.distanceTo(bot.entity.position.offset(0, 1.62, 0)) < 2)
  const c = mod.exports.create(bot, { enemy: () => foe, foeHp: () => 20 })
  try {
    assert.equal(c.plan({}), null, 'a never-seen crystal cannot become a threat through the wall')
    assert.equal(c.st.seenCrystals || 0, 0)
    assert.ok(c.st.hiddenCrystals > 0)
    wall = false
    c.plan({})
    assert.equal(c.st.seenCrystals, 1, 'visible nearby crystal still enters perception')
  } finally { c.close() }
})

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function raisedShield (confirmedTicks = 5) {
  const game = clock.activate(new clock.GameClock({ manual: true, epoch: 1000 }))
  const { bot, foe } = duelBot({ inv: ['diamond_sword'], extra: { '2,0,0': 'respawn_anchor' } })
  const emitter = new EventEmitter()
  bot.on = emitter.on.bind(emitter); bot.removeListener = emitter.removeListener.bind(emitter)
  bot._client = new EventEmitter()
  bot.inventory.slots[45] = { name: 'shield', count: 1 }
  bot.heldItem = { name: 'diamond_sword', count: 1 }; bot.quickBarSlot = 0
  bot.entity.yaw = -Math.PI / 2
  let raises = 0; let lowers = 0
  const key = bot.registry.entitiesByName.player.metadataKeys.indexOf('living_entity_flags')
  const metadata = flags => {
    bot.entity.metadata[key] = flags
    bot._client.emit('entity_metadata', { entityId: 1, metadata: [{ key, value: flags }] })
  }
  bot.activateItem = () => { raises++ }
  bot.deactivateItem = () => { lowers++; metadata(0) }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  game.attach(bot)
  const age = n => bot._client.emit('update_time', { age: BigInt(n) })
  age(1000)
  const ctl = { aborted: false, onAbort: [] }
  const guard = combat.makeShield({ bot }, ctl, { shield: 'always' })
  assert.equal(await guard.wear(), true)
  const pending = guard.raise(true)
  metadata(3); age(1001); game.advanceTicks(1); await turn(); await pending
  age(1001 + confirmedTicks)
  const c = cr.create(bot, { enemy: () => foe, guard })
  c._onBlock(null, anchorBlock(2, 0))
  return { bot, foe, c, ctl, guard, game, age, raises: () => raises, lowers: () => lowers,
    close () { c.close(); guard.close(); game.dispose() } }
}

test('готовый native щит выбирается против близкого якоря без повторной задержки подъёма', async () => {
  const a = await raisedShield()
  try {
    assert.equal(a.guard.blocking(), true)
    const plan = a.c.plan()
    assert.equal(plan?.kind, 'shield', JSON.stringify(plan))
    assert.equal(plan.ticks, 0, 'источник уже перед готовым щитом')
    assert.equal(plan.exp, 0)
  } finally { a.close() }
})

test('готовый щит спиной к якорю учитывает разворот, а незавершённый подъём — оставшиеся native тики', async () => {
  const a = await raisedShield(3)
  try {
    const rising = a.c.plan()
    assert.equal(rising?.kind, 'shield')
    assert.equal(rising.ticks, 3, 'два native тика до блока и один на команду')
    a.age(1006); a.bot.entity.yaw = Math.PI / 2
    const turning = a.c.plan()
    assert.equal(turning?.kind, 'shield')
    assert.equal(turning.ticks, 1, 'готовность не устраняет время разворота')
  } finally { a.close() }
})

test('подтверждённый подъём без пяти native тиков ещё не считается готовой защитой якоря', async () => {
  const a = await raisedShield(0)
  try {
    a.game.advanceTicks(30)
    assert.equal(a.guard.blocking(), false, 'wall time не подтверждает тики сервера')
    assert.notEqual(a.c.plan()?.kind, 'shield')
    a.age(1006)
    assert.equal(a.c.plan()?.kind, 'shield')
    a.bot._client.emit('set_cooldown', { cooldownGroup: 'minecraft:shield', cooldownTicks: 100 })
    assert.notEqual(a.c.plan()?.kind, 'shield', 'выбитый щит не наследует готовность прошлого use')
  } finally { a.close() }
})

test('исполнение защиты сохраняет уже поднятый щит и освобождает его при отмене', async () => {
  const a = await raisedShield()
  try {
    const plan = { kind: 'shield', yaw: -Math.PI / 2, threats: [{ cell: new Vec3(2, 0, 0), c: { position: new Vec3(2.5, .5, .5) }, t: { me: 10 } }] }
    const pending = a.c.run(a.ctl, plan)
    await turn()
    assert.equal(a.raises(), 1, 'повторный activateItem не перезапускает готовый use')
    assert.equal(a.lowers(), 0)
    a.ctl.aborted = true; a.game.advanceTicks(1)
    await pending
    assert.equal(a.lowers(), 1)
    assert.equal(a.guard.blocking(), false)
  } finally { a.ctl.aborted = true; a.game.advanceTicks(40); a.close() }
})

test('скрытое изменение уже увиденного якоря не выдаёт заряд; повторный взгляд обновляет его', () => {
  const extra = { '3,0,0': 'respawn_anchor', charges: 0 }
  const { bot, foe } = duelBot({ inv: ['diamond_sword'], extra })
  const original = bot.blockAt
  let visible = true
  bot.blockAt = p => !visible && Math.floor(p.x) === 1 && p.y >= 0 && p.y < 4
    ? { name: 'obsidian', position: p.floored(), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
    : original(p)
  const c = cr.create(bot, { enemy: () => foe })
  try {
    c._onBlock(null, anchorBlock(3, 0))
    assert.equal(c.engaged(), true)
    assert.notEqual(c.plan()?.kind, 'anchorPop', 'увидели пустой якорь')
    visible = false; extra.charges = 1
    c._onBlock(anchorBlock(3, 0), anchorBlock(3, 0))
    // Убираем заслон только из расчёта урона/прицела: память состояния должна сама
    // запрещать новый charge, даже если запоздалый blockUpdate уже попал в мир.
    const pick = require('../src/pick')
    const seen = pick.blockSeen
    try {
      pick.blockSeen = () => false
      visible = true
      assert.notEqual(c.plan()?.kind, 'anchorPop', 'скрытый packet не превращается в известный заряд')
    } finally { pick.blockSeen = seen }
    c._onBlock(anchorBlock(3, 0), anchorBlock(3, 0))
    assert.equal(c.plan()?.kind, 'anchorPop', 'новый заряд виден при повторном взгляде')
  } finally { c.close() }
})

test('скрытый blockUpdate не сообщает исчезновение якоря; пустое место нужно увидеть', () => {
  const game = clock.activate(new clock.GameClock({ manual: true, epoch: 100000 }))
  const { bot, foe } = duelBot({ inv: ['diamond_sword'], extra: { '3,0,0': 'respawn_anchor' } })
  const original = bot.blockAt
  let wall = false; let removed = false
  bot.blockAt = p => {
    const cell = p.floored()
    if (wall && cell.x === 1 && cell.y >= 0 && cell.y < 4) return { name: 'obsidian', position: cell, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }
    if (removed && cell.equals(new Vec3(3, 0, 0))) return { name: 'air', position: cell, boundingBox: 'empty', shapes: [] }
    return original(p)
  }
  const c = cr.create(bot, { enemy: () => foe })
  try {
    c._onBlock(null, anchorBlock(3, 0))
    assert.equal(c.engaged(), true)
    wall = true; removed = true
    c._onBlock(anchorBlock(3, 0), bot.blockAt(new Vec3(3, 0, 0)))
    assert.equal(c.engaged(), true, 'якорь помним, хотя скрытый packet удалил его из мира')
    wall = false; game.advanceTicks(5)
    assert.equal(c.engaged(), false, 'увиденное пустое место удаляет старую угрозу')
  } finally { c.close(); game.dispose() }
})
