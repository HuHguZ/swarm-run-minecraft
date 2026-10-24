// Лестницу не рвёт небольшой пересчёт цены боя; новая опасность прерывает сразу.
import test from 'node:test'
import assert from 'node:assert/strict'
import { assessSwarmFight } from '../daemon/src/swarm'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnWork } from './swarm/swarm-driver/turn-work'
import { createSwarmDriver } from './swarm/swarm-driver'

test('ladder phase hysteresis prices the accepted fight and yields to danger without a timer', async () => {
  let now = 1000, entered: () => void, finish: (r: any) => void
  const begun = new Promise<void>(resolve => { entered = resolve })
  const pending = new Promise(resolve => { finish = resolve })
  const calls: string[] = [], at = { x: .5, y: 64, z: 2.5 }
  const ladder = { id: 'ladder', kind: 'goto', data: { ladder: 'wall' }, position: at }
  const member: any = { id: 'A', team: 'blue', position: at, health: 40, maxHealth: 40, strength: 40,
    role: 'miner-builder', inventory: { iron_sword: 1, ladder: 32 }, armor: {} }
  const foe: any = { id: 'Foe', seenAt: now, sources: ['A'], position: { x: 14, y: 64, z: 2.5 }, equipment: { weapon: 'iron_sword' } }
  const enemies = [foe], initial = assessSwarmFight(member, enemies, [member])
  let retreat: any, task: any = { id: 'flee', kind: 'flee', data: { panic: true, risk: initial } }
  const board = { enemies: () => enemies, tasks: () => [], facts: () => [] }
  const context = { board, member, members: [member], get task() { return task } }
  const b: any = { name: 'A', swarmTask: ladder, swarmExecuting: true, c: { async call(method: string) {
    calls.push(method)
    if (method === 'status') return { state: { pos: at, health: member.health, inventory: member.inventory } }
    if (method === 'ladder_up') { entered(); return pending }
    return { detail: {} }
  } } }
  const sw: any = { now: () => now, pos: { A: { p: at, hp: member.health } }, alive: () => true, log: () => {},
    refresh: () => context, walls: new Map([['wall', { key: 'wall', x: 0, y: 64, z: 0, top: 70, face: { x: 0, z: 1 } }]]),
    siteOpen: () => true, siteFailed: () => {}, ladderRoutes: [], detail: r => r.detail || r,
    say: () => {}, onslaught: () => false, turnFlee: async () => { calls.push('flee-turn') } }
  const { preempt, turn } = swarmTurn(sw)
  const work = swarmTurnWork(sw).turnLadder({ b, task: ladder, member, context, enemies } as any)
  await begun
  try {
    const accepted = b.swarmLadder
    assert.equal(preempt(b), false, 'тот же мир не отменяет уже принятую стройку')
    const price = initial.duelKillSeconds ?? initial.killSeconds
    task.data.risk = { ...initial, duelKillSeconds: price * 1.2 }
    now += 60000; foe.seenAt = now
    assert.equal(preempt(b), false, 'запас цены держится по состоянию, а не первую секунду')
    task.data.risk = { ...initial, duelKillSeconds: price * 1.5 }
    assert.equal(preempt(b), true, 'ухудшившаяся цена боя перевешивает продолжение')
    retreat = b.swarmTask
    b.swarmTask = ladder; task.data.risk = initial
    member.health = 39
    assert.equal(preempt(b), true, 'потеря HP прерывает даже при здоровье выше стандартных 20')
    b.swarmTask = ladder; member.health = 40
    task.data.risk = { ...initial, lethal: true }
    assert.equal(preempt(b), true, 'смертельный размен не удерживается')
    b.swarmTask = ladder; task.data.risk = { ...initial, burst: true }
    assert.equal(preempt(b), true, 'первый смертельный залп не удерживается')
    b.swarmTask = ladder; task.data.risk = initial; foe.position.x = 7; foe.sources = []
    assert.equal(preempt(b), true, 'дошедший до стройки враг прерывает сразу')
    b.swarmTask = ladder; foe.position.x = 20; foe.sources = ['A']; foe.equipment.weapon = 'bow'
    assert.equal(preempt(b), true, 'свежий видимый лучник прерывает при прежней цене')
    b.swarmTask = ladder; foe.equipment.weapon = 'iron_sword'; foe.threat = 'bow'
    assert.equal(preempt(b), true, 'свежее наблюдение bow не теряется за старым equipment')
    b.swarmTask = ladder; foe.threat = 'blast'; foe.position.x = 7; foe.sources = []
    assert.equal(preempt(b), true, 'близкий взрыв прерывает и без личной видимости')
    foe.position.x = 20; foe.sources = ['A']; delete foe.threat
    b.swarmTask = ladder; foe.equipment.weapon = 'iron_sword'; member.maxHealth = 80
    assert.equal(preempt(b), true, 'ухудшение доли здоровья тоже прерывает стройку')
    member.maxHealth = 40
    for (const memory of [undefined, { hp: 40 }, { ...accepted, risk: { ...initial, duelKillSeconds: Infinity } },
      { ...accepted, risk: { ...initial, duelKillSeconds: NaN } }]) {
      b.swarmTask = ladder; b.swarmLadder = memory
      assert.equal(preempt(b), true, 'нет достоверной исходной цены — выполняю новый отход')
    }
    assert.equal(calls.filter(m => m === 'stop').length, 13)
  } finally {
    finish({ detail: { complete: false, why: 'конец теста' } })
    await work
  }
  assert.equal(b.swarmLadder, undefined, 'завершение работы убирает принятую цену')
  b.swarmTask = retreat; foe.position.x = 14
  const price = initial.duelKillSeconds ?? initial.killSeconds
  task = { ...ladder, data: { ...ladder.data, risk: { ...initial, duelKillSeconds: price * 1.5 } } }
  assert.equal(preempt(b), false, 'новый goto к той же лестнице не отменяет нужный отход')
  await turn(b)
  await turn(b)
  assert.deepEqual(calls.slice(-2), ['flee-turn', 'flee-turn'], 'после конца короткого flee следующий ход продолжает отход')
  task.data.risk = { ...initial, duelKillSeconds: price * 1.3 }
  assert.equal(preempt(b), false, 'небольшого улучшения цены для возврата недостаточно')
  member.health = 41; task.data.risk = { ...initial, lethal: true }
  assert.equal(preempt(b), false, 'лечение не возвращает на лестницу под ещё смертельный размен')
  task.data.risk = { ...initial, burst: true }
  assert.equal(preempt(b), false, 'лечение не возвращает под ещё смертельный залп')
  member.health = 40; task.data.risk = { ...initial, duelKillSeconds: price * 1.1 }
  assert.equal(preempt(b), true, 'заметное улучшение цены возвращает к работе без ожидания таймера')
  b.swarmTask = retreat; task.data.risk = { ...initial, duelKillSeconds: price * 1.5 }; foe.position.x = 40
  assert.equal(preempt(b), true, 'оторвались от прежнего врага — можно вернуться к работе')
  b.swarmTask = retreat; foe.position.x = 14; foe.sources = []
  assert.equal(preempt(b), true, 'прежний враг скрылся из личного вида — отход закончен')
  b.swarmTask = retreat; foe.sources = ['A']; member.health = 41
  assert.equal(preempt(b), true, 'здоровее при том же несмертельном риске — можно строить')
  b.swarmTask = retreat; member.health = 40; task.data.ladder = 'other-wall'
  assert.equal(preempt(b), true, 'другая лестница не наследует цену отказа старой')
  const driver = createSwarmDriver({ bots: [b], pos: { A: { p: at, hp: 40, inv: {} } }, alive: () => true,
    arena: { x: 0, y: 64, z: 0, r: 32 }, home: () => at, hostile: () => false, log: () => {} })
  b.swarmLadder = { hp: 40 }; b.swarmTask = { kind: 'flee', data: { ladderRetreat: {} } }
  driver.reset()
  assert.equal(b.swarmLadder, undefined, 'новый раунд убирает принятую цену незавершённой работы')
  assert.equal(b.swarmTask, undefined, 'новый раунд убирает цену обратной смены вместе с flee')
})
