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
