import test from 'node:test'
import assert from 'node:assert/strict'
import { SwarmBoard, planPvp, planTransfers, type SwarmMember } from '../src/swarm'
import * as fight from '../src/swarm/fight'
import { swarmTeam } from '../../farm/swarm/swarm-driver/team'
import { createDriverState } from '../../farm/swarm/swarm-driver/state'
import { swarmRetry } from '../../farm/swarm/swarm-driver/retry'

const p = (x = 0, y = 64, z = 0) => ({ x, y, z })
const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
const member = (id: string, strong = false): SwarmMember => ({ id, team: 'blue', position: p(10), health: 20, strength: 40, role: 'fighter', weapon: strong ? 'netherite_sword' : 'stone_sword', armor: strong ? armor : [], ench: strong ? { sharpness: 5, protection: 16 } : {}, inventory: { [strong ? 'netherite_sword' : 'stone_sword']: 1 } })

test('helmet-only glint survives the board without inventing weapon Sharpness in the S/V contact', () => {
  let now = 1000
  const own: SwarmMember = { ...member('S'), position: p(), weapon: 'iron_sword', inventory: { iron_sword: 1 },
    armor: ['chainmail_helmet', 'chainmail_chestplate', 'iron_leggings', 'iron_boots'], ench: { sharpness: 0, protection: 2 } }
  const board = new SwarmBoard('blue', () => now)
  board.setMembers([own])
  const raw: any = { id: 'V', position: p(1), visible: true, equipment: { weapon: 'iron_sword', weaponEnchanted: false,
    armor: ['iron_boots', 'chainmail_chestplate', 'iron_helmet'], armorVisible: [true, true, true, true], armorEnchanted: [false, false, false, true], enchanted: true } }
  Object.defineProperty(raw, 'health', { get() { throw Error('hidden player HP') } })
  board.observe('S', now, raw)
  let foe = board.enemies()[0]
  assert.equal(foe.equipment?.weaponEnchanted, false)
  const plain = fight.memberFight(own, foe), risk = fight.assessSwarmFight(own, [foe], [own])
  assert.equal(risk.unsafe, false, 'the actual plain sword must not acquire helmet enchantments')
  assert.deepEqual(risk.enemySharpness, [0, 0])
  now++
  board.observe('S', now, { ...raw, equipment: { ...raw.equipment, weaponEnchanted: true } })
  foe = board.enemies()[0]
  assert.ok(fight.memberFight(own, foe).survival < plain.survival, 'a real weapon glint retains its conservative damage range')
  now++
  board.observe('S', now, raw)
  assert.equal(board.enemies()[0].equipment?.weaponEnchanted, false, 'fresh false replaces old true')
  now++
  board.observe('S', now, { ...raw, visible: false, nametag: true, equipment: { weapon: 'diamond_sword', weaponEnchanted: true } })
  assert.equal(board.enemies()[0].equipment?.weapon, 'iron_sword', 'hidden packets cannot refresh the visible weapon')
  assert.equal(board.enemies()[0].equipment?.weaponEnchanted, false)
  const legacy = { ...foe, equipment: { ...foe.equipment } }
  delete legacy.equipment.weaponEnchanted
  assert.equal(fight.memberFight(own, legacy).survival, fight.memberFight(own, foe).survival)
})

test('solo driver keeps rearming against its only human instead of finishing from round start', () => {
  const bots = Array.from({ length: 30 }, (_, i) => ({ name: `blue${i}`, team: 'blue' }))
  const pos = Object.fromEntries(bots.map((b, i) => [b.name, { p: p(24, 64, i % 5), hp: 20, inv: { bow: 1, arrow: 64 }, armor: {} }]))
  const sw: any = createDriverState({ bots, pos, alive: () => true, now: () => 1000, log: () => {},
    arms: true, aggressive: true, hostile: () => true, humanNames: () => ['HuHguZ'], hideouts: [p(48)] })
  Object.assign(sw, swarmRetry(sw), swarmTeam(sw), { preempt: () => {} })
  sw.boardOf(bots[0]).observe(bots[0].name, 1000, { id: 'HuHguZ', position: p(), visible: true,
    equipment: { weapon: 'netherite_sword', armor, enchanted: true } })
  sw.refresh(bots[0])
  const tasks = [...sw.planned.get('blue').values()] as any[]
  assert.ok(tasks.every(t => !t.data?.finishing), 'one human is the original opposition, not the last survivor of a bot team')
  assert.ok(tasks.some(t => t.kind === 'loot' || t.data?.rearm || t.data?.hide), 'unarmoured archers retain equipment preparation')
})

test('q9: личный размен отправляет слабых за снаряжением, улучшившихся возвращает; лишнее доезжает от свободного союзника', () => {
  assert.equal(typeof (fight as any).memberFight, 'function')
  let time = 1000
  const weak = member('weak'), strong = member('strong', true), team = [weak, strong, ...Array.from({ length: 8 }, (_, i) => member('other' + i))]
  const foe: any = { id: 'HuHguZ', position: p(), seenAt: time, sources: ['strong'], equipment: { weapon: 'netherite_sword', armor, enchanted: true } }
  Object.defineProperty(foe, 'health', { get() { throw new Error('скрытое хп игрока') } })
  const low = (fight as any).memberFight(weak, foe), high = (fight as any).memberFight(strong, foe)
  assert.ok(low.damage[0] < low.damage[1], 'блеск даёт диапазон урона')
  assert.ok(low.survival < high.survival, 'ответный удар считается по моей броне')
  assert.equal(low.rearm, true)
  assert.equal(high.rearm, false)
  const board = new SwarmBoard('blue', () => time, 8000)
  const plan = () => {
    board.setMembers(team)
    board.observe('strong', time, { ...foe, visible: true })
    return planPvp(board, team, { aggressive: true, quorum: 1, hideouts: [p(32), p(-32)] })
  }
  let tasks = plan()
  assert.equal(tasks.get('weak')?.data?.rearm, true, 'толпа слабых не улучшает личный размен')
  assert.notEqual(tasks.get('weak')?.kind, 'fight')
  assert.ok(tasks.get('weak')?.data?.hide || tasks.get('weak')?.kind === 'loot')
  assert.ok(!tasks.get('strong')?.data?.rearm, 'снаряжённый продолжает атаку')
  Object.assign(weak, member('weak', true)); time += 500
  tasks = plan()
  assert.ok(!tasks.get('weak')?.data?.rearm, 'новый комплект сразу пересчитывает назначение')
  assert.ok(['fight', 'goto'].includes(tasks.get('weak')!.kind))

  const bots: any[] = [{ name: 'D', team: 'blue' }, { name: 'R', team: 'blue', swarmTask: { data: { rearm: true } } }, { name: 'Ench', team: 'blue' }]
  const pos: any = { D: { p: p(-60), hp: 20, inv: { stone_sword: 1, iron_sword: 2, iron_spear: 1 }, armor: {} }, R: { p: p(20), hp: 20, inv: { stone_sword: 1 }, armor: {} }, Ench: { p: p(-80), hp: 20, inv: { stone_sword: 2, iron_sword: 1 }, armor: {}, enchants: [{ name: 'stone_sword', slot: 9, ench: { sharpness: 5 } }] } }
  const sw: any = createDriverState({ bots, pos, alive: () => true, now: () => time, log: () => {} })
  Object.assign(sw, swarmRetry(sw), swarmTeam(sw), { preempt: () => {} })
  const members = sw.membersOf(bots[0]), donor = members.find(m => m.id === 'D'), recipient = members.find(m => m.id === 'R'), enchanted = members.find(m => m.id === 'Ench')
  assert.equal(donor.reserve.iron_sword, 1)
  assert.equal(donor.reserve.stone_sword, 0)
  assert.equal(donor.reserve.iron_spear, 1, 'курьер сохраняет копьё')
  assert.equal(recipient.needs.iron_sword, 1, 'каменный меч не отменяет запрос улучшения')
  assert.equal(enchanted.reserve.stone_sword, 2, 'передача по имени не отдаёт зачарованный лучший экземпляр')
  assert.ok(!enchanted.needs.iron_sword)
  const transfer = planTransfers(sw.boardOf(bots[0]), members).find(t => t.data?.recipient === 'R')!
  assert.equal(transfer.data?.item, 'iron_sword')
  assert.equal(transfer.data?.count, 1)

  bots.unshift({ name: 'Near', team: 'blue' }); pos.Near = { p: p(), hp: 20, inv: { iron_sword: 2 }, armor: {} }
  const refresh = () => { sw.plannedAt.clear(); return sw.refresh(bots[0]) }
  refresh()
  let delivery = sw.transfers.get('blue').find(t => t.data?.recipient === 'R')
  assert.equal(delivery.data.donor, 'Near')
  sw.failed(bots.find(b => b.name === 'R'), `transfer:${delivery.id}`, 'iron_sword')
  refresh(); delivery = sw.transfers.get('blue').find(t => t.data?.recipient === 'R')
  assert.notEqual(delivery.data.donor, 'Near', 'отказавшая пара не блокирует дальнего курьера')
})
