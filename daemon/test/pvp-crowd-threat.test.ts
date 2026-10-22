'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as ct from '../src/pvp/crowd-threat'

const P = (x: number, z: number, y = 100) => ({ x, y, z })
const IRON = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].map(name => ({ name }))
const me = (o: any = {}) => ({ p: P(0, 0), hp: 20, charge: 1, weapon: 'iron_sword', armor: IRON, shield: true, splash: [], ...o })
let n = 0
const foe = (o: any = {}) => ({ id: ++n, name: 'f' + n, p: P(5, 0), held: 'iron_sword', ehp: 20, readyMs: 0, armor: IRON, sees: true, ...o })

test('угрозы: булава сверху опаснее меча рядом; лучник с натянутым луком — раньше незаряженного', () => {
  const sword = foe({ p: P(2.5, 0), theirR: 2.4 })
  const mace = foe({ held: 'mace', p: P(1, 1, 108), airborne: true })
  const ts = ct.threats([sword, mace], me())
  assert.equal(ts[0].f, mace, JSON.stringify(ts.map(t => [t.f.name, t.kind, t.eta, t.dmg])))
  assert.equal(ts[0].kind, 'mace')
  assert.ok(ts[0].dmg > 12, 'удар с 8 бл. по железу — больше 12')
  const a = ct.threatOf(foe({ held: 'bow', p: P(15, 0), drawing: true }), me())
  const b = ct.threatOf(foe({ held: 'bow', p: P(15, 0) }), me())
  assert.equal(a.kind, 'archer'); assert.ok(a.eta < b.eta)
})

test('угрозы: кто ударит первым — ближний с готовым ударом раньше дальнего и перезаряжающегося', () => {
  const near = ct.threatOf(foe({ p: P(2.8, 0), theirR: 2.5, readyMs: 0 }), me())
  const recharging = ct.threatOf(foe({ p: P(2.8, 0), theirR: 2.5, readyMs: 500 }), me())
  const far = ct.threatOf(foe({ p: P(9, 0), theirR: 8.7 }), me())
  assert.ok(near.eta < recharging.eta && near.eta < far.eta, JSON.stringify([near.eta, recharging.eta, far.eta]))
  assert.ok(near.danger > far.danger)
  // Бежит на меня — скоро; стоит на 6 бл. — не скоро (до спринта ему время).
  const run = ct.threatOf(foe({ p: P(6, 0), theirR: 5.7, v: { x: -0.28, y: 0, z: 0 } }), me())
  const stand = ct.threatOf(foe({ p: P(6, 0), theirR: 5.7, v: { x: 0, y: 0, z: 0 } }), me())
  assert.ok(run.eta <= 0.6 && stand.eta > 0.6, JSON.stringify([run.eta, stand.eta]))
})

test('удар: добиваю того, у кого хп по оценке меньше удара; щит к нам — хуже открытого', () => {
  const weak = foe({ hitNow: true, ehp: 3 })
  const full = foe({ hitNow: true, ehp: 20 })
  assert.equal(ct.strikeChoice([full, weak], me()).f, weak)
  const shield = foe({ hitNow: true, ehp: 12, blocking: true })
  const open = foe({ hitNow: true, ehp: 14 })
  assert.equal(ct.strikeChoice([shield, open], me()).f, open)
  assert.equal(ct.strikeChoice([shield], me()), null, 'щит к нам без топора — не бью')
  assert.equal(ct.strikeChoice([shield], me({ axe: true })).f, shield, 'с топором — по щиту')
  assert.equal(ct.strikeChoice([foe({ hitNow: false })], me()), null, 'вне руки — не удар')
})

test('зелье: вред в кучу из троих с 5 бл.; ближе 4.6 (облако на мне) и одиночку без добивания — нет', () => {
  const harm = { item: { name: 'splash_potion' }, kind: 'strong_harming' }
  const pile = [foe({ p: P(4.7, 0) }), foe({ p: P(6.0, 1) }), foe({ p: P(5.5, -1.2) })]
  const s = ct.splashChoice(pile, me({ splash: [harm] }))
  assert.ok(s && s.hit.length === 3 && s.value > 20, JSON.stringify(s))
  // Бегут на меня — к разрыву будут ближе 4.6: не бросаю.
  const rushing = [foe({ p: P(4.7, 0), v: { x: -0.28, y: 0, z: 0 } }), foe({ p: P(6.0, 1), v: { x: -0.28, y: 0, z: 0 } }), foe({ p: P(5.5, -1.2), v: { x: -0.28, y: 0, z: 0 } })]
  assert.equal(ct.splashChoice(rushing, me({ splash: [harm] })), null)
  // Я ухожу с той же скоростью — сближения нет: бросок за спину в погоню.
  assert.ok(ct.splashChoice(rushing, me({ splash: [harm], v: { x: -0.28, y: 0, z: 0 } })))
  const close = [foe({ p: P(3, 0) }), foe({ p: P(3.5, 1) })]
  assert.equal(ct.splashChoice(close, me({ splash: [harm] })), null)
  assert.equal(ct.splashChoice([foe({ p: P(4.7, 0) })], me({ splash: [harm] })), null)
  assert.ok(ct.splashChoice([foe({ p: P(4.7, 0), ehp: 6 })], me({ splash: [harm] })), 'одиночку — если вред его добьёт')
  // Добиваемый один, но два вреда II (24) его снимут — бросок в него; не добиваемый — нет.
  const lone = foe({ p: P(4.7, 0), ehp: 18 })
  // Дальше 5.0 — не берусь (предел к ногам 5.54 минус сдвиг за время броска).
  assert.equal(ct.splashChoice([foe({ p: P(6.2, 0) }), foe({ p: P(6.8, 1) })], me({ splash: [harm] })), null)
  assert.ok(ct.splashChoice([lone], me({ splash: [harm, harm] }), { focus: lone.id }))
  assert.equal(ct.splashChoice([lone], me({ splash: [harm, harm] })), null)
  // Ближе 4.5 — рамки ближе 3.4 даже для вреда (облако по мне сильнее края); при хп < 10 — только чистое окно (≥ 5.1, а
  // дальше 5.0 к ногам не долетит): на ровном вреда нет.
  assert.equal(ct.splashChoice([foe({ p: P(4.3, 0) }), foe({ p: P(4.4, 1) })], me({ splash: [harm] })), null)
  assert.equal(ct.splashChoice([foe({ p: P(4.7, 0) }), foe({ p: P(5.5, 1) })], me({ splash: [harm], hp: 8 })), null)
  // Слабость — только с чистым окном (на себя её нельзя): с высоты 3 бл.; и только по ближникам (лучникам пользы нет).
  const weak = { item: { name: 'splash_potion' }, kind: 'weakness' }
  const up = { p: P(0, 0, 103) }
  assert.equal(ct.splashChoice([foe({ p: P(5.5, 0) }), foe({ p: P(6, 1), held: 'iron_axe' })], me({ splash: [weak] })), null, 'на ровном — нет')
  assert.equal(ct.splashChoice([foe({ p: P(5.5, 0), held: 'bow' }), foe({ p: P(6, 1), held: 'bow' })], me({ splash: [weak], ...up })), null)
  assert.ok(ct.splashChoice([foe({ p: P(5.5, 0) }), foe({ p: P(6, 1), held: 'iron_axe' })], me({ splash: [weak], ...up })))
})

test('клещи: двое с разных сторон вот-вот ударят — уйти; заряжен и один в руке — сперва удар', () => {
  const a = foe({ p: P(3, 0), theirR: 2.8 }); const b = foe({ p: P(-3, 0), theirR: 2.8 })
  const mem = ct.newMem()
  assert.equal(ct.decide({ foes: [a, b], me: me({ charge: 0.3 }), mem, now: 0 }).kind, 'break')
  const mem2 = ct.newMem()
  const hit = { ...a, hitNow: true }
  assert.equal(ct.decide({ foes: [hit, b], me: me({ charge: 1 }), mem: mem2, now: 0 }).kind, 'strike')
  // Оба с одной стороны — не клещи: к добиваемому (щит от ближнего — у удара по цели), не бег.
  const c = foe({ p: P(3, 0.5), theirR: 2.8, ehp: 15 }); const d = foe({ p: P(3, -0.5), theirR: 2.8 })
  const dd = ct.decide({ foes: [c, d], me: me({ charge: 0.3 }), mem: ct.newMem(), now: 0 })
  assert.equal(dd.kind, 'engage'); assert.equal(dd.f.id, c.id)
  // Лучник тянет лук, ближних рядом нет — щит к нему.
  const arch = foe({ held: 'bow', p: P(14, 0), drawing: true })
  const ds = ct.decide({ foes: [arch, foe({ p: P(-12, 0), v: { x: 0, y: 0, z: 0 } })], me: me({ charge: 0.3 }), mem: ct.newMem(), now: 0 })
  assert.equal(ds.kind, 'shield'); assert.equal(ds.f.id, arch.id)
})

test('добиваемый: урон в одного — цель держится, пока другой не слабее на 4+', () => {
  const a = foe({ p: P(3, 0), ehp: 12 }); const b = foe({ p: P(-3, 0), ehp: 14 }); const c = foe({ p: P(0, 3), ehp: 20 })
  const mem = ct.newMem()
  assert.equal(ct.focusOf([a, b, c], me(), null).id, a.id)
  assert.equal(ct.focusOf([{ ...a, ehp: 12 }, { ...b, ehp: 10 }, c], me(), a.id).id, a.id, 'b слабее на 2 — держу a')
  assert.equal(ct.focusOf([{ ...a, ehp: 12 }, { ...b, ehp: 7 }, c], me(), a.id).id, b.id, 'b слабее на 5 — к нему')
  // Удар — по добиваемому, даже если рядом в руке другой чуть слабее.
  const s = ct.strikeChoice([{ ...a, hitNow: true, ehp: 12 }, { ...b, hitNow: true, ehp: 11 }], me(), null, a.id)
  assert.equal(s.f.id, a.id, JSON.stringify(s))
  void mem
})

test('куча: добиваемый в куче из троих — не лезу, держу место лицом к первому; один — иду к нему', () => {
  const pile = [foe({ p: P(5, 0), ehp: 12, v: { x: 0, y: 0, z: 0 } }), foe({ p: P(5.5, 1.5), v: { x: 0, y: 0, z: 0 } }), foe({ p: P(5.5, -1.5), v: { x: 0, y: 0, z: 0 } })]
  const d = ct.decide({ foes: pile, me: me({ charge: 0.5 }), mem: ct.newMem(), now: 0 })
  assert.equal(d.kind, 'hold', d.why)
  const alone = [foe({ p: P(5, 0), ehp: 12, v: { x: 0, y: 0, z: 0 } }), foe({ p: P(-5, 6), v: { x: 0, y: 0, z: 0 } })]
  assert.equal(ct.decide({ foes: alone, me: me({ charge: 0.5 }), mem: ct.newMem(), now: 0 }).kind, 'engage')
})

test('дёрганье считается: возврат к прежнему решению быстрее 1 с — flip', () => {
  const mem = ct.newMem()
  const a = foe({ p: P(8, 0), theirR: 7.7, ehp: 10, v: { x: 0, y: 0, z: 0 } }); const b = foe({ p: P(-8, 0), theirR: 7.7, ehp: 20, v: { x: 0, y: 0, z: 0 } })
  const arch = foe({ held: 'bow', p: P(0, 14), drawing: true })
  ct.decide({ foes: [a, b], me: me({ charge: 0.3, shield: false }), mem, now: 0 })
  ct.decide({ foes: [a, b, arch], me: me({ charge: 0.3 }), mem, now: 700 })
  ct.decide({ foes: [a, b], me: me({ charge: 0.3, shield: false }), mem, now: 1100 })
  assert.equal(mem.switches, 2); assert.equal(mem.flips, 1)
})

test('без дёрганья: цель «к кому» держится 600 мс, если не появился срочный повод', () => {
  const a = foe({ p: P(8, 0), theirR: 7.7, ehp: 14 }); const b = foe({ p: P(-8, 0), theirR: 7.7, ehp: 15 })
  const mem = ct.newMem()
  const d1 = ct.decide({ foes: [a, b], me: me({ charge: 0.5, shield: false }), mem, now: 0 })
  assert.equal(d1.kind, 'engage')
  const first = d1.f
  // Чуть другая оценка — b стал «лучше»: в пределах 600 мс цель та же.
  const a2 = { ...a, ehp: 16 }; const b2 = { ...b, ehp: 12 }
  assert.equal(ct.decide({ foes: [a2, b2], me: me({ charge: 0.5, shield: false }), mem, now: 300, cur: first.id }).f.id, first.id)
  // Добить в руке — сразу, без срока.
  const kill = { ...b2, ehp: 2, hitNow: true, p: P(-2.5, 0), theirR: 2.2 }
  const d3 = ct.decide({ foes: [a2, kill], me: me({ charge: 1, shield: false }), mem, now: 350, cur: first.id })
  assert.equal(d3.kind, 'strike'); assert.equal(d3.f.id, kill.id)
  assert.ok(mem.switches >= 1)
})

test('булава: взлёт на заряде ветра над головой — уже угроза (булаву берут на спуске)', () => {
  const up = foe({ held: 'wind_charge', p: P(1, 1, 105), airborne: true, v: { x: 0, y: 0.8, z: 0 } })
  assert.equal(ct.threatOf(up, me()).kind, 'mace')
  const walk = foe({ held: 'wind_charge', p: P(1, 1, 100), v: { x: 0.1, y: 0, z: 0 } })
  assert.notEqual(ct.threatOf(walk, me()).kind, 'mace')
})

test('зелье: враг на линии броска рядом со мной — не бросаю (разобьётся о него у меня); мало хп — без вреда', () => {
  const harm = { item: { name: 'splash_potion' }, kind: 'strong_harming' }
  const pile = [foe({ p: P(4.7, 0) }), foe({ p: P(6.0, 1) }), foe({ p: P(5.5, -1.2) })]
  assert.ok(ct.splashChoice(pile, me({ splash: [harm] })))
  assert.equal(ct.splashChoice([...pile, foe({ p: P(2.5, 0.2) })], me({ splash: [harm] })), null)
  assert.equal(ct.splashChoice(pile, me({ splash: [harm], hp: 5 })), null)
  assert.equal(ct.splashChoice(pile, me({ splash: [harm] }), { reach: () => false }), null, 'не долетит — нет')
})

test('булава сверху — раньше удара и зелья', () => {
  const m = foe({ held: 'mace', p: P(1, 1, 106), airborne: true })
  const s = foe({ p: P(2, 0), hitNow: true, ehp: 2 })
  assert.equal(ct.decide({ foes: [m, s], me: me(), mem: ct.newMem(), now: 0 }).kind, 'mace')
})

test('разброс: трое по кругу — почти 360°, трое с одной стороны — меньше 90°', () => {
  assert.ok(ct.spread(P(0, 0), [P(5, 0), P(-2.5, 4.3), P(-2.5, -4.3)]) > 4)
  assert.ok(ct.spread(P(0, 0), [P(5, 0), P(5, 1), P(5, -1)]) < Math.PI / 2)
})
