import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import { pvpState } from '../src/swarm/board'
import * as co from '../src/pvp/combat-observe'
import { swarmSightings } from '../src/swarm-senses'
import { DAMAGE_TYPES } from '../src/gamedata'
import { edgeTurn } from '../src/pvp/turn-melee'
import { directThreat, swarmWork } from '../src/swarm-work'
import { MELEE_CAP } from '../src/swarm/race'
import { shoveHits } from '../src/swarm/shove'
import { strikeSlot, strikeWait, WINDOW_MS } from '../src/pvp/strike-order'
import { swarmTurnWork } from '../../farm/swarm/swarm-driver/turn-work'
import { swarmTeam } from '../../farm/swarm/swarm-driver/team'

const p = (x = 0, y = 64, z = 0) => ({ x, y, z })
const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
const member = (id: string, x = 3, z = 0, pick = true): SwarmMember => ({ id, team: 'blue', position: p(x, 64, z), health: 20, strength: 40, role: 'fighter', weapon: 'diamond_sword', armor, inventory: { diamond_sword: 1, ...(pick ? { netherite_pickaxe: 1 } : {}) } })

test('q9: подтверждённые удары, которые съедает лечение, меняют тактику до смертей даже при aggressive; промахи и действенный урон — нет', () => {
  let time = 1000
  const team = [member('a'), member('b'), member('c'), member('d')]
  const board = new SwarmBoard('blue', () => time, 3000)
  board.setMembers(team)
  const bots = team.slice(0, 2).map((m, i) => {
    const bot: any = new EventEmitter(); bot._client = new EventEmitter()
    bot.entity = { id: i + 1, position: new Vec3(3, 64, i), onGround: true }
    bot.blockAt = () => ({ name: 'air', boundingBox: 'empty' })
    const metadata = []; Object.defineProperty(metadata, 9, { get() { throw new Error('HP игрока запрещено') } })
    const foe = { id: 7, username: 'HuHguZ', type: 'player', position: new Vec3(0, 64, 0), onGround: true, equipment: [], metadata }
    bot.entities = { 7: foe }
    return { bot, foe, tracker: co.trackFoe(bot, foe, { roundScope: 'q9', now: () => time, visible: () => true }), m }
  })
  const refresh = () => {
    for (const b of bots) for (const s of swarmSightings(b.bot)) board.observe(b.m.id, time, s)
    planPvp(board, team, { aggressive: true, quorum: 1 })
  }
  try {
    for (const b of bots) b.tracker.noteAttack({ min: .2, max: .2, mean: .2, raw: 8 })
    refresh(); assert.ok(!pvpState(board).dislodge, 'заявка на удар не подтверждает попадания')
    for (let i = 0; i < 8; i++) {
      const b = bots[i % 2]
      b.tracker.noteAttack({ min: .2, max: .2, mean: .2, raw: 8 })
      b.bot._client.emit('damage_event', { entityId: 7, sourceCauseId: b.bot.entity.id + 1, sourceTypeId: 0 })
      for (let t = 0; t < 10; t++) { time += 50; for (const b of bots) b.bot.emit('physicsTick') }
      refresh(); refresh() // повторный опрос не добавляет попаданий
    }
    assert.equal(pvpState(board).dislodge, true, 'роняем до первой смерти, хотя aggressive обходит strongFew')
    for (let t = 0; t < 180; t++) { time += 50; for (const b of bots) b.bot.emit('physicsTick') }
    refresh(); assert.ok(!pvpState(board).dislodge, 'старые попадания вышли из окна')
    for (let i = 0; i < 3; i++) {
      const b = bots[i % 2]
      b.tracker.noteAttack({ min: 5, max: 5, mean: 5, raw: 10 })
      b.bot._client.emit('damage_event', { entityId: 7, sourceCauseId: b.bot.entity.id + 1, sourceTypeId: 0 })
      for (let t = 0; t < 10; t++) { time += 50; for (const b of bots) b.bot.emit('physicsTick') }
      refresh()
    }
    assert.ok(!pvpState(board).dislodge, 'падающее оценочное здоровье — действенный урон')
    board.resetRound(); assert.ok(!pvpState(board).dislodge)
    board.setMembers(team)
    const b = bots[0]
    b.tracker.stop()
    b.foe.equipment = [null, null, ...armor.map(name => ({ name, componentMap: new Map([['enchantments', { data: {} }]]) }))] as any
    b.bot.heldItem = { name: 'diamond_sword' }
    b.tracker = co.trackFoe(b.bot, b.foe, { roundScope: 'q9-glint', now: () => time, visible: () => true })
    bots[1].bot.emit('end')
    for (let i = 0; i < 8; i++) {
      // Настоящий путь MF: damage_event без noteAttack, тип удара из данных 1.21.11, чары видны только блеском.
      b.bot._client.emit('damage_event', { entityId: 7, sourceCauseId: b.bot.entity.id + 1, sourceTypeId: DAMAGE_TYPES.indexOf('player_attack') })
      for (let t = 0; t < 10; t++) { time += 50; b.bot.emit('physicsTick') }
      refresh()
    }
    assert.equal(pvpState(board).dislodge, true, 'блеск даёт диапазон защиты, а не скрытые уровни или завышенный урон')
  } finally { for (const b of bots) { b.tracker.stop(); b.bot.emit('end') } }
})

test('q9: смертельный край — кирочники копают кроме двух в упор, цепь ударов дальше трёх блоков идёт к краю по окнам', async () => {
  const calls: string[] = [], start = p(10, 64, .5), stand = p(.5, 64, .5)
  let at = start
  const task: any = { position: p(2, 63, 0), data: { dig: '2,63,0', undermine: true, stands: [stand], blocks: ['sandstone'], target: 'enemy', drop: Infinity } }
  const b: any = { name: 'b', swarmTask: task, c: { call: async method => {
    calls.push(method)
    if (method === 'status') return { state: { pos: at } }
    if (method === 'goto') return { status: 'interrupted', by: { type: 'cancelled' } }
    if (method === 'center_in') { at = stand; return { status: 'done', detail: { ok: true, at } } }
    return { status: 'done', detail: { ok: true } }
  } } }
  const holes: any[] = []
  const sw: any = { now: () => 0, alive: () => true, log: () => {}, pos: {}, bots: [], arena: {}, home: () => ({}), cooldown: new Map(), holes,
    planned: new Map(), walls: new Map(), ladderRoutes: [], go: () => {}, detail: r => r.detail || r, teamOf: () => 'blue', ownProtection: () => [], say2: () => {}, generation: 1, siteFailed: () => {} }
  await swarmTurnWork(sw).turnDig({ b, context: { members: [{ id: 'b' }] }, board: { tasks: () => [task] }, task, round: 1, m: { p: start } } as any)
  assert.deepEqual(calls, ['status', 'goto'], 'прерванный подход не возрождает старую копку после нового приказа')
  assert.equal(holes.length, 0)
  const edge = swarmTeam({ holes: [{ x: 9, y: 63, z: 0, drop: 7 }], bots: [], edgeOf: () => ({ x: -1, z: 0, drop: Infinity, at: 1 }) } as any).edgeNear(p())
  assert.equal(edge.drop, Infinity, 'далёкая мелкая яма не скрывает смертельный край в упор')
  // Исполнитель сохраняет направление цепи; спринт-удар полезнее случайного крита в обратную сторону.
  for (const x of [2.5, -2.5]) {
    const me = new Vec3(x, 64, 0)
    const ctx: any = { bot: { entity: { position: me, yaw: Math.PI / 2 }, blockAt: () => null }, entity: { position: new Vec3(0, 64, 0), username: 'HuHguZ' },
      session: { current: { params: { target: 'HuHguZ', shoveAt: p(-6) } } }, opts: {}, st: {}, prof: { player: true }, pushAt: Infinity, backAt: Infinity, nearMe: [], nearFoe: [], duo: { foes: () => [] }, ready: () => false }
    const turn: any = { now: 1000, me, d: 2.5, r: 2.5, theirR: 2.5, cooldownLeft: 0, canHit: true, inSight: true }
    edgeTurn(ctx, turn)
    if (x > 0) assert.equal(turn.edgeHit, 'sprint', 'с противоположной краю стороны — спринт-удар')
    else assert.equal(turn.canHit, false, 'со стороны края сначала обходим: обратного толчка нет')
    delete ctx.session; delete ctx.entity.username
    assert.doesNotThrow(() => edgeTurn(ctx, turn), 'обычный бой с мобом не требует командного приказа')
  }
  // Короткая работа допускает переживаемый урон; долгая или смертельная — обрывается, опоры своих сохраняются.
  const worker: any = { health: 20, entity: { id: 1, position: new Vec3(.5, 64, .5), width: .6, height: 1.8 }, inventory: { slots: [] },
    blockAt: () => ({ name: 'air', boundingBox: 'empty', shapes: [] }) }
  const enemy = { id: 7, username: 'enemy', type: 'player', position: new Vec3(2, 64, .5), equipment: [], metadata: [] }
  worker.entities = { 7: enemy }
  assert.equal(directThreat(worker), enemy, 'обычная работа прерывается от контакта')
  assert.equal(directThreat(worker, [], 100, e => e, { workMs: 100, ranged: false }), null)
  assert.equal(directThreat(worker, [], 10000, e => e, { workMs: 10000, ranged: false }), enemy)
  worker.health = 1
  assert.equal(directThreat(worker, [], 100, e => e, { workMs: 100, ranged: false }), enemy)
  const support = await swarmWork({ bot: worker }, null, { kind: 'dig', at: p(0, 63, 0), undermine: true })
  assert.equal(support.why, 'allied_support', 'ценой здоровья нельзя разрешить копку собственной опоры')
  const team = Array.from({ length: 8 }, (_, i) => member(`b${i}`, 2.1 + i * .1, (i - 3.5) * .12))
  const scene = (now = () => 10000) => {
    const board = new SwarmBoard('blue', now, 3000); board.setMembers(team)
    // Только свои подтверждённые удары и оценка HP; метаданные противника не входят в план.
    board.observe('b0', 10000, { id: 'HuHguZ', position: p(), visible: true, hpEstimate: 20, equipment: { armor, enchanted: true },
      hitProof: { healed: 1.6, hits: Array.from({ length: 8 }, (_, i) => ({ ago: (8 - i) * 500, damage: .2, lowDamage: .2, healed: i * .2 })) } })
    return board
  }
  const sites = Array.from({ length: 8 }, (_, i) => ({ x: -2 - i % 2, y: 63, z: Math.floor(i / 2) - 2, feetY: 64, drop: Infinity, tier: 2, blocks: ['sand', 'obsidian'], handMs: 250750, stands: [-.5, -3.5].map(x => p(x, 64, Math.floor(i / 2) - 2 + .5)) }))
  const options = { aggressive: true, quorum: 1, edgeOf: () => ({ x: -1, z: 0, drop: Infinity, at: 6 }) }
  let time = 10000
  const diggingBoard = scene(() => time)
  const digging = planPvp(diggingBoard, team, { ...options, digSites: () => sites })
  const miners = [...digging.values()].filter(t => t.data?.dig)
  assert.equal(miners.length, team.length - MELEE_CAP, 'в контакте копают все кирочники, кроме двух прикрывающих')
  assert.ok(miners.every(t => t.data!.undermine && t.position!.x < 0), 'копают смертельные клетки с подходом к стойке')
  assert.equal(new Set(miners.map(t => t.data!.dig)).size, miners.length, 'каждый разбирает свою клетку')
  time += 8500
  diggingBoard.observe('b0', time, { id: 'HuHguZ', position: p(), visible: true, equipment: { armor, enchanted: true } })
  const continued = planPvp(diggingBoard, team, { ...options, digSites: () => sites })
  assert.equal([...continued.values()].filter(t => t.data?.undermine).length, miners.length, 'истечение ленты 8 с не рвёт начатую копку обсидиана 9.4 с')
  const gone = planPvp(diggingBoard, team, { ...options, digSites: () => [] })
  assert.ok(![...gone.values()].some(t => t.data?.undermine), 'исчезнувшая смертельная клетка завершает подкоп по миру')
  const shove = planPvp(scene(), team.map(m => ({ ...m, inventory: { diamond_sword: 1 } })), options)
  const fighters = [...shove.values()].filter(t => t.kind === 'fight')
  assert.equal(fighters.length, team.length)
  assert.ok(fighters.every(t => t.data!.shove && Math.cos(t.data!.slot * Math.PI / 4) > 0), 'бьют с противоположной краю стороны')
  const foe: any = { position: p(), equipment: { armor }, velocity: p(0, 0, 0) }
  const hits = shoveHits(foe, options.edgeOf(), { sprint: true })
  assert.equal(hits, 4, 'по физике 1.21.11 до 6 блоков — четыре спринт-удара по незериту')
  assert.ok(shoveHits(foe, { ...options.edgeOf(), at: 10 }, { sprint: true }) > hits, 'дальний край дороже')
  assert.ok(shoveHits(foe, options.edgeOf(), { sprint: true, kb: 2 }) < hits, 'Отдача сокращает цепь')
  const order = team.map(m => m.id), here = new Set(order)
  assert.equal(strikeSlot(order, 'b1', 'HuHguZ', here, 'b0'), 0)
  assert.equal(strikeWait(1000, 1000, 0), WINDOW_MS, 'следующий толчок после 10 тиков неуязвимости')
  const open = planPvp(scene(), team.map((m, i) => i ? m : { ...m, inventory: { mace: 1, wind_charge: 2 } }), { aggressive: true, quorum: 1 })
  assert.ok(![...open.values()].some(t => t.data?.dig || t.data?.shove), 'без края сохранён обычный натиск/булава')
})
