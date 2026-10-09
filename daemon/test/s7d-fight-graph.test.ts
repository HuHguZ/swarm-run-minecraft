'use strict'
// S7d: граф боя (pvp/fight-graph) и новые действия калькулятора (удочка, трезубец с «Громовержцем»).
const test = require('node:test')
const assert = require('node:assert/strict')
const kp = require('../src/pvp/kill-planner')
const fg = require('../src/pvp/fight-graph')

const kit = (mat, ench = {}) => ['helmet', 'chestplate', 'leggings', 'boots'].map(s => ({ name: `${mat}_${s}`, ench }))
function obs ({ dist = 2.5, hp = { lo: 18, hi: 20, mean: 19 }, items = [{ name: 'iron_sword' }], held = 'iron_sword', foe = {}, me = {}, ...rest }: any = {}) {
  return {
    difficulty: 'normal',
    dist,
    los: true,
    foe: { player: true, hp, totem: false, armor: kit('iron'), main: { name: 'iron_sword' }, blocking: false, approach: 0, ...foe },
    me: { ehp: 20, armor: kit('iron'), held, since: 20, onGround: true, canCrit: true, items, hasShield: false, ...me },
    ...rest
  }
}

test('удочка: на 12 бл. подтяг входит в планы как первое действие, а план с ней доходит до удара раньше', () => {
  const o = obs({ dist: 12, items: [{ name: 'iron_sword' }, { name: 'fishing_rod' }] })
  const r = kp.planAttack(o)
  const rod = r.alts.find(a => a.kind === 'rod')
  const melee = r.alts.find(a => a.kind === 'melee')
  assert.ok(rod && melee, JSON.stringify(r.alts))
  assert.deepEqual(rod.seq.slice(0, 2), ['rod', 'melee'])
  // Ближе 3.5 удочка не годится (FishingHook: зацеп и рывок к хозяину — вплотную смысла нет).
  const near = kp.planAttack(obs({ dist: 2.8, items: [{ name: 'iron_sword' }, { name: 'fishing_rod' }] }))
  assert.ok(!near.alts.some(a => a.kind === 'rod'))
})

test('трезубец с «Громовержцем»: в грозу по цели под небом урон больше (молния 5 мимо щита + поджог)', () => {
  const tri = { name: 'trident', ench: { channeling: 1, loyalty: 1 } }
  const dry = kp.planAttack(obs({ dist: 10, items: [{ name: 'iron_sword' }, tri] }))
  const storm = kp.planAttack(obs({ dist: 10, items: [{ name: 'iron_sword' }, tri], storm: true, foeSky: true }))
  const a = dry.alts.find(x => x.kind === 'trident'); const b = storm.alts.find(x => x.kind === 'trident')
  assert.ok(a && b)
  assert.ok(b.dps > a.dps, `${a.dps} → ${b.dps}`)
  // Под крышей молнии нет — как без грозы.
  const roof = kp.planAttack(obs({ dist: 10, items: [{ name: 'iron_sword' }, tri], storm: true, foeSky: false })).alts.find(x => x.kind === 'trident')
  assert.equal(roof.dps, a.dps)
  // «Тягун» не бросается (TridentItem.releaseUsing).
  const rip = kp.planAttack(obs({ dist: 10, items: [{ name: 'iron_sword' }, { name: 'trident', ench: { riptide: 3 } }] }))
  assert.ok(!rip.alts.some(x => x.kind === 'trident'))
})

test('оружие ближнего боя — по урону в секунду; щит поднят и топор есть — топор (ударом-свапом)', () => {
  const items = [{ name: 'diamond_sword' }, { name: 'diamond_axe' }]
  const c = fg.meleeChoice(obs({ items }))
  assert.equal(c.item, 'diamond_sword')
  const s = fg.meleeChoice(obs({ items, foe: { blocking: true } }))
  assert.equal(s.item, 'diamond_axe')
  assert.equal(s.shield, true)
  // Щит уже выбит — снова меч (комбо «топор → меч» в окно 100 тиков).
  assert.equal(fg.meleeChoice(obs({ items, foe: { blocking: true, shieldOffTicks: 40 } })).item, 'diamond_sword')
})

test('граф: таран вблизи — только когда в воздухе его меч не достаёт; опыт меняет цену тарана', () => {
  // Показ 09.10: у него меч — на земле он рубит в ответ, в воздухе нет: таран выгоднее размена.
  const o = obs({ dist: 3, items: [{ name: 'diamond_sword' }, { name: 'iron_spear' }], foe: { main: { name: 'diamond_sword' } } })
  const plan = kp.planAttack(o)
  const store = {}
  const g = fg.decide(o, plan, [fg.lanceOption(o, 'iron_spear', store)])
  assert.equal(g.pick, 'lance', JSON.stringify(g.scores))
  // У него лук — избегнутого ближнего урона нет: вблизи меч, не таран.
  const ob = obs({ dist: 3, items: [{ name: 'diamond_sword' }, { name: 'iron_spear' }], foe: { main: { name: 'bow' } } })
  const gb = fg.decide(ob, kp.planAttack(ob), [fg.lanceOption(ob, 'iron_spear', {})])
  assert.notEqual(gb.pick, 'lance', JSON.stringify(gb.scores))
  const v0 = fg.lanceOption(o, 'iron_spear', store).dmg
  for (let i = 0; i < 10; i++) fg.noteExperience(store, 'lance', { hit: true })
  const v1 = fg.lanceOption(o, 'iron_spear', store).dmg
  assert.ok(v1 > v0, `${v0} → ${v1}`)
  // Неизвестный графу приём (нет строки) — не запрещается.
  assert.equal(g.allow('что-то другое'), true)
})

test('комбо: цепочка приёмов перед потерей хп, части одного удара — один счёт', () => {
  let t = 0
  const log = fg.comboLog(() => t)
  log.note('удочкой подтянул под удар — зацепил и дёрнул')
  t = 300; log.note('рывок со спринт-ударом')
  t = 600; log.dealt(3)
  t = 700; log.dealt(2) // поглощение, затем хп — тот же удар
  const r = log.report()
  assert.equal(r.chains['удочка→спринт-удар'], 1)
  assert.equal(r.dmg['удочка→спринт-удар'], 5)
  t = 5000; log.dealt(4) // давно не было приёма — не комбо
  assert.equal(log.report().chains['удочка→спринт-удар'], 1)
})

test('оценка хп: попадания без заявки — разброс по модели урона моего меча, а не 0.5–12 (оценка не раздувается)', () => {
  const { EventEmitter } = require('node:events')
  const co = require('../src/pvp/combat-observe')
  const client = new EventEmitter()
  const bot: any = new EventEmitter()
  bot._client = client
  bot.entity = { id: 1, position: { x: 0, y: 64, z: 0 }, onGround: true }
  bot.heldItem = { name: 'iron_sword', count: 1 }
  bot.registry = require('minecraft-data')('1.21.11')
  const armor = ['iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet'].map(name => ({ name, count: 1 }))
  const foe: any = { id: 2, type: 'player', username: 'Foe', position: { x: 2, y: 64, z: 0 }, equipment: [null, null, ...armor], metadata: [] }
  const tr = co.trackFoe(bot, foe, { honest: true })
  const PA = require('../src/gamedata').DAMAGE_TYPES.indexOf('player_attack')
  for (let i = 0; i < 3; i++) client.emit('damage_event', { entityId: 2, sourceCauseId: 2, sourceTypeId: PA })
  const e = tr.hp.snapshot()
  tr.stop()
  assert.ok(e.hi - e.lo < 13, `интервал ${e.lo}–${e.hi}`)
  assert.ok(e.hi < 20 && e.lo > 0, `${e.lo}–${e.hi}`)
})

test('S7d: зелье в него — не бросаю, когда он ближе 4.5 бл. (разрыв о его тело заденет и меня, ThrownSplashPotion 4 бл.)', async () => {
  const { createEquipment } = require('../src/pvp/equipment')
  const Vec3 = require('vec3')
  let onAimResult = null
  const ctx: any = {
    bot: { entity: { position: new Vec3(0, 64, 0) }, heldItem: { name: 'splash_potion' } },
    entity: { position: new Vec3(3.3, 64, 0), height: 1.8 },
    reachable: () => true, holdItem: async () => true, holdWeapon: async () => {}, used: () => {},
    leadFn: () => new Vec3(3.3, 65, 0), edges: { support: () => ({ drop: 0 }) }, Vec3, pick: require('../src/pick'),
    throwMod: { throwAt: async (_bot, _t, o) => { onAimResult = o.onAim({ land: { at: new Vec3(5, 64, 0) } }); return { thrown: !!onAimResult } } }
  }
  const eq = createEquipment(ctx)
  assert.equal(await eq.throwAt({ name: 'splash_potion' }, 'зелье'), false, 'он в 3.3 бл. — разрыв рядом со мной')
  assert.equal(onAimResult, false)
  ctx.entity.position = new Vec3(5.5, 64, 0)
  assert.equal(await eq.throwAt({ name: 'splash_potion' }, 'зелье'), true, 'в 5.5 бл. — бросаю')
})

test('S7d: взять зелье — по содержимому; в руке оказалось другое зелье того же имени — «не взял»', async () => {
  const { createEquipment } = require('../src/pvp/equipment')
  const mk = (slot, p) => ({ name: 'splash_potion', slot, components: [{ type: 'potion_contents', data: { potionId: p } }] })
  const heal = mk(37, 'strong_healing'); const harm = mk(38, 'strong_harming')
  const bot: any = { heldItem: null, inventory: { items: () => [heal, harm] } }
  const pvp = require('../src/pvp')
  const was = pvp.potionOf
  pvp.potionOf = (i) => i && i.components && i.components[0].data.potionId
  try {
    let equipped = null
    bot.equip = async (it) => { equipped = it; bot.heldItem = it === heal ? harm : it } // «устаревший слот»: взял соседнее
    const eq = createEquipment({ bot, heldName: () => null, switched: () => {} })
    assert.equal(await eq.holdItem({ ...heal }), false, 'в руке вред — не бросаю')
    assert.equal(equipped, heal, 'искал свежий предмет по содержимому')
    bot.equip = async (it) => { bot.heldItem = it }
    assert.equal(await eq.holdItem({ ...heal }), true)
  } finally { pvp.potionOf = was }
})
