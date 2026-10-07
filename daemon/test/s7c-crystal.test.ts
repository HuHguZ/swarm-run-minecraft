'use strict'
// S7c (07.10): щит в размене кристаллов (его поднятый щит гасит взрыв в передних 90°), уклонение ценой —
// щит лицом к кристаллу / укрытие / блок между — и хп соперника-игрока только оценкой.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const cr = require('../src/crystal')
const boom = require('../src/boom')

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
