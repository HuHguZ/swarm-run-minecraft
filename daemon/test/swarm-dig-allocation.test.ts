import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Vec3 } from 'vec3'
import { SwarmBoard, planPvp, type SwarmMember } from '../src/swarm'
import { swarmWork } from '../src/swarm-work'
import { controlsTurn } from '../src/pvp/turn-melee'
import { canDigTrap } from '../src/swarm/plan-jobs'
import { swarmTurnWork } from '../../farm/swarm/swarm-driver/turn-work'
import { swarmTurn } from '../../farm/swarm/swarm-driver/turn'

const p = (x: number, z: number, y = 120) => ({ x, y, z })
const armor = ['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots']
const under = (q, s) => s.y === Math.floor(q.y - .01) && q.x + .3 > s.x && q.x - .3 < s.x + 1 && q.z + .3 > s.z && q.z - .3 < s.z + 1
function scene() {
  const team: SwarmMember[] = Array.from({ length: 30 }, (_, i) => ({ id: `b${String(i).padStart(2, '0')}`, team: 'blue',
    position: i < 22 ? p(.5 + Math.cos(i * Math.PI / 11) * 2.5, .5 + Math.sin(i * Math.PI / 11) * 2.5) : p(25 + i, 0),
    health: 20, strength: i < 22 ? 40 : 1, role: i % 4 === 0 ? 'miner-builder' : 'fighter',
    weapon: i < 22 ? 'stone_sword' : undefined, armor: i < 22 ? armor : [],
    inventory: i < 22 ? { stone_sword: 1, netherite_pickaxe: 1 } : {} }))
  const sites = Array.from({ length: 25 }, (_, i) => {
    const x = (i % 5 - 2) * 2, z = (Math.floor(i / 5) - 2) * 2
    return { x, y: 119, z, feetY: 120, drop: Infinity, tier: 2, blocks: ['sandstone', 'obsidian'],
      stands: [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => p(x + .5 + dx, z + .5 + dz)) }
  })
  const board = new SwarmBoard('blue', () => 10000, 3000); board.setMembers(team)
  const observe = (proof = false) => board.observe('b00', 10000, { id: 'HuHguZ', position: p(.5, .5), visible: true, hpEstimate: 20,
    equipment: { weapon: 'diamond_sword', armor }, ...(proof ? { hitProof: { healed: 12.3, hits: [
      { ago: 1000, damage: 5.5, lowDamage: 5.5, healed: 0 }, { ago: 500, damage: 6.5, lowDamage: 5.5, healed: 6.15 }
    ] } } : {}) })
  const options = { aggressive: true, quorum: 1, digSites: () => sites, edgeOf: () => null }
  return { team, board, sites, observe, options }
}

test('q9c-2: при 30 ботах и 22 мечниках наблюдаемое лечение делает полезную копку делом всех свободных кирок кроме двух прикрывающих', () => {
  const f = scene(); f.observe()
  const before = planPvp(f.board, f.team, f.options)
  assert.equal([...before.values()].filter(t => t.kind === 'fight').length, 22, 'журнальные 19–23 бойца до доказанного пустого урона')
  f.observe(true)
  const plan = planPvp(f.board, f.team, f.options), miners = [...plan.values()].filter(t => t.data?.dig)
  assert.equal(miners.length, 20, 'из 22 кирок две прикрывают, остальные выполняют доступную работу вместо бесполезного натиска')
  assert.equal(new Set(miners.map(t => t.data!.dig)).size, 20)
  const stands = miners.map(t => t.data!.stands[0])
  assert.ok(stands.every((q, i) => stands.every((r, j) => i === j || Math.hypot(q.x - r.x, q.z - r.z) >= .6)), 'у рабочих разные стойки')
  assert.ok(stands.every(q => miners.every(t => !under(q, t.position))), 'стойки не стоят на чужой копке')
  const limited = planPvp(f.board, f.team, { ...f.options, digSites: () => f.sites.slice(0, 3) })
  assert.ok([...limited.values()].filter(t => t.data?.dig).length <= 3, 'геометрия ограничивает работы, число копателей не выдумывается')
  const quick = scene()
  for (const m of quick.team.slice(0, 22)) { m.weapon = 'diamond_sword'; m.inventory = { diamond_sword: 1, netherite_pickaxe: 1 } }
  quick.observe(true)
  assert.equal([...planPvp(quick.board, quick.team, quick.options).values()].filter(t => t.data?.dig).length, 0, 'даже после двух пустых попаданий более быстрая доступная атака сохраняется')
})

test('q9c-3: занятые бойцами полезные клетки резервируются, бойцы освобождают опору; физическая защита и честный луч сохраняются', async () => {
  const f = scene(); f.observe(true)
  const plan = planPvp(f.board, f.team, f.options), miners = [...plan.values()].filter(t => t.data?.dig)
  const job = miners.find(t => f.team.some(m => under(m.position, t.position)))
  assert.ok(job, 'можно назначить полезную клетку, занятую перемещаемым своим')
  const avoid = miners.map(t => t.position!)
  assert.ok([...plan.values()].filter(t => t.kind === 'fight').every(t => avoid.every(s => !under(t.position, s))), 'боевые сектора вне поддержки назначенных ям')
  const ally = f.team.find(m => under(m.position, job.position))!
  const moved = plan.get(ally.id)!
  assert.ok(avoid.every(s => !under(moved.data?.dig ? moved.data.stands[0] : moved.position, s)), 'занимающий яму получает безопасную стойку')
  const bot: any = new EventEmitter(), cells = new Map<string, any>()
  bot._client = new EventEmitter(); bot.version = '1.21.11'; bot.health = 20
  bot.registry = require('minecraft-data')('1.21.11')
  bot.entity = { id: 1, position: new Vec3(job.data!.stands[0].x, 120, job.data!.stands[0].z), width: .6, height: 1.8, onGround: true, effects: {}, metadata: [] }
  const block = (at, name) => { const b = bot.registry.blocksByName[name]; return { ...b, position: at.floored(), stateId: b.defaultState,
    boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], digTime: () => 20, canHarvest: () => true } }
  bot.blockAt = at => cells.get(at.floored().toString()) || block(at, at.y < 120 ? 'stone' : 'air')
  const other: any = { id: 2, username: ally.id, type: 'player', position: new Vec3(ally.position.x, 120, ally.position.z), width: .6, height: 1.8, metadata: [] }
  bot.entities = { 2: other }; bot.inventory = { slots: [], items: () => [] }; bot.canDigBlock = () => true
  bot.lookAt = async () => {}; bot.stopDigging = () => {}; bot.clearControlStates = () => {}
  let dug = 0
  bot.dig = async b => { dug++; const air = block(b.position, 'air'); cells.set(b.position.toString(), air); bot._client.emit('block_change', { location: b.position, type: air.stateId }); bot.emit('blockUpdate', b, air) }
  const params = { kind: 'dig', at: job.position, undermine: true, allies: [ally.id] }
  assert.equal((await swarmWork({ bot }, null, params)).why, 'allied_support', 'приказ об отходе ещё не означает физически освобождённую клетку')
  other.position = new Vec3(30, 120, 30)
  const eyeCell = bot.entity.position.offset(0, 1, 0).floored()
  cells.set(eyeCell.toString(), block(eyeCell, 'stone'))
  assert.equal((await swarmWork({ bot }, null, params)).why, 'occluded_or_out_of_reach', 'реальный контур блока закрывает луч, даже при короткой дистанции')
  assert.equal(dug, 0)
  cells.delete(eyeCell.toString())
  assert.equal((await swarmWork({ bot }, null, params)).why, 'dug', 'свободная опора и открытая грань позволяют копать с серверной квитанцией')
  assert.equal(dug, 1)
  const top = new Vec3(job.position!.x, job.position!.y, job.position!.z), lower = top.offset(0, -1, 0)
  const farStand = top.offset(2.5, 1, .5), nearStand = top.offset(1.5, 1, .5)
  bot.entity.position = farStand; cells.set(top.toString(), block(top, 'stone'))
  assert.ok(canDigTrap(farStand, job.position), 'грубая дистанция допускает стойку в двух клетках')
  assert.equal((await swarmWork({ bot }, null, params)).why, 'dug', 'верхний слой виден издали')
  assert.equal((await swarmWork({ bot }, null, { ...params, at: lower })).why, 'occluded_or_out_of_reach', 'нижний слой закрывает край обычного пола')
  bot.entity.position = nearStand
  assert.equal((await swarmWork({ bot }, null, { ...params, at: lower })).why, 'dug', 'соседняя центральная стойка открывает нижний слой честным лучом')
  const rpcCalls: string[] = [], nativeTask: any = { ...job, data: { ...job.data, stands: [nearStand] } }
  let centered = true, failures = 0
  bot.entity.position = farStand; cells.set(top.toString(), block(top, 'stone')); cells.set(lower.toString(), block(lower, 'stone'))
  const driverBot: any = { name: 'worker', swarmTask: nativeTask, c: { call: async (method, input) => {
    rpcCalls.push(method)
    if (method === 'status') return { state: { pos: bot.entity.position } }
    if (method === 'center_in') { if (centered) bot.entity.position = nearStand; return { status: centered ? 'done' : 'failed', detail: { ok: centered, at: bot.entity.position } } }
    if (method === 'goto') return { status: 'done' }
    return { status: 'done', detail: await swarmWork({ bot }, null, input) }
  } } }
  const holes: any[] = [], sw: any = { now: () => 10000, alive: () => true, log() {}, pos: {}, bots: [], arena: {}, home: () => ({}), cooldown: new Map(), holes,
    planned: new Map(), walls: new Map(), ladderRoutes: [], go() {}, detail: r => r.detail || r, teamOf: () => 'blue', ownProtection: () => [], say2() {}, generation: 1, siteFailed() { failures++ } }
  const driverContext: any = { b: driverBot, context: { members: [{ id: 'worker', position: farStand }] }, board: { tasks: () => [nativeTask] }, task: nativeTask, round: 1, m: { p: farStand } }
  await swarmTurnWork(sw).turnDig(driverContext)
  assert.ok(rpcCalls.indexOf('center_in') < rpcCalls.indexOf('swarm_work'), 'подкоп начинает с назначенной стойки, хотя грубая дистанция уже проходит')
  assert.equal(holes.length, 1, 'оба слоя вскрыты с одной стойки без промежуточного отказа луча')
  const occupant = { id: 'guard', position: top.offset(.5, 1, .5) }
  driverContext.context.members.push(occupant); sw.pos.guard = { p: occupant.position }
  holes.length = 0; rpcCalls.length = 0; cells.set(top.toString(), block(top, 'stone')); cells.set(lower.toString(), block(lower, 'stone'))
  await swarmTurnWork(sw).turnDig(driverContext)
  assert.ok(!rpcCalls.includes('swarm_work'), 'до фактического ухода своего ждёт, а не пробует копать его опору')
  assert.equal(failures, 0, 'ожидание ухода не штрафует пригодную клетку')
  sw.pos.guard.p = new Vec3(30, 120, 30); rpcCalls.length = 0
  await swarmTurnWork(sw).turnDig(driverContext)
  assert.ok(rpcCalls.indexOf('center_in') < rpcCalls.indexOf('swarm_work'), 'после реального освобождения сначала центрируется')
  assert.equal(holes.length, 1); assert.equal(failures, 0)
  holes.length = 0; rpcCalls.length = 0; bot.entity.position = farStand; centered = false
  cells.set(top.toString(), block(top, 'stone')); cells.set(lower.toString(), block(lower, 'stone'))
  await swarmTurnWork(sw).turnDig(driverContext)
  assert.ok(!rpcCalls.includes('swarm_work'), 'неудачное центрирование не подменяется грубой дистанцией')
  function controls({ at = [.5, 64, 1.5], stand, forced = { forward: true }, escape = false, opts = true }: any = {}) {
    const me = new Vec3(at[0], at[1], at[2]), keys: any = {}, params = { digAvoid: [{ x: 0, y: 63, z: 0 }], swarmStand: stand }
    const bot: any = { entity: { position: me, width: .6, height: 1.8, yaw: 0, onGround: true, metadata: [] }, food: 20, getControlState: () => false,
      blockAt: q => ({ name: q.y < 64 ? 'stone' : 'air', boundingBox: q.y < 64 ? 'block' : 'empty', shapes: q.y < 64 ? [[0, 0, 0, 1, 1, 1]] : [] }) }
    const ctx: any = { bot, entity: { position: new Vec3(.5, 64, -.5), width: .6, height: 1.8 }, opts: opts ? params : {}, session: { current: { params } }, floorEscape: escape ? { dir: { x: 0, z: -1 } } : null,
      mf: { clock: { srvSprint: false }, override: k => ({ ...k, ...forced }) }, ready: () => false, rest() {}, used() {}, set: (k, v) => { keys[k] = v } }
    const turn: any = { me, meInWeb: false, forward: false, back: false, strafe: null, sprint: false, jump: false, canHit: true, inSight: true }
    controlsTurn(ctx, turn)
    assert.equal(turn.canHit, true, 'резерв клетки не выключает удары')
    return keys
  }
  assert.equal(controls().forward, false, 'боевой override не возвращает бойца на опору копки')
  assert.equal(controls({ opts: false }).forward, false, 'приказ читается и из параметров текущей сессии')
  assert.equal(controls({ at: [1.2, 64, 1.5] }).forward, false, 'учтён край тела шириной .6')
  const diagonal = controls({ at: [1.6, 64, 1.6], forced: { forward: true, left: true } })
  assert.equal(diagonal.forward || diagonal.left, false, 'проверяется весь диагональный шаг')
  assert.equal(controls({ at: [.5, 64, 3.5], forced: { forward: true, jump: true, sprint: true } }).forward, false, 'прыжок не пересекает резерв копки')
  assert.equal(controls({ at: [.5, 64, .5], forced: { back: true } }).back, true, 'с уже занятой клетки можно выйти')
  const hold = controls({ stand: { x: .5, y: 64, z: 1.5 }, forced: { forward: true, left: true } })
  assert.equal(hold.forward || hold.back || hold.left || hold.right, false, 'в своём секторе держит стойку и продолжает бить')
  assert.equal(controls({ at: [.5, 64, 2.5], stand: { x: .5, y: 64, z: 1.5 }, forced: { back: true } }).forward, true, 'возвращается безопасным шагом в свой сектор')
  assert.equal(controls({ at: [.5, 64, 4.5], stand: { x: .5, y: 64, z: 4.5 } }).forward, true, 'недосягаемая боевая стойка не замораживает сближение')
  assert.equal(controls({ escape: true }).forward, true, 'спасение с физически уходящего пола остаётся приоритетным')
  const { digStepSafe } = require('../src/pvp/body') as typeof import('../src/pvp/body')
  const reserved: any = { bot: { entity: { position: new Vec3(1.6, 64, 1.6), width: .6, height: 1.8, metadata: [] } }, opts: { digAvoid: [{ x: 0, y: 63, z: 0 }] } }
  assert.equal(digStepSafe(reserved, { x: -1, z: 0 }), true)
  assert.equal(digStepSafe(reserved, { x: 0, z: -1 }), true)
  assert.equal(digStepSafe(reserved, { x: -Math.SQRT1_2, z: -Math.SQRT1_2 }), false, 'общая проверка ловит угол рамки при диагональном ходе стрелка')
  reserved.bot.entity.position = new Vec3(1.6, 64, 3.6)
  assert.equal(digStepSafe(reserved, { x: -Math.SQRT1_2, z: -Math.SQRT1_2 }), true, 'callback проверяет текущее положение, не старый кадр боя')
  const drawnKeys: any = {}, drawnAt = new Vec3(1.6, 64, -.6)
  const drawnBot: any = { entity: { position: drawnAt, width: .6, height: 1.8, yaw: 0, metadata: [] }, food: 20,
    inventory: { items: () => [{ name: 'bow', count: 1 }, { name: 'arrow', count: 64 }] },
    getControlState: k => !!drawnKeys[k], blockAt: q => ({ name: q.y < 64 ? 'stone' : 'air', boundingBox: q.y < 64 ? 'block' : 'empty' }) }
  const drawnCtx: any = { bot: drawnBot, entity: { position: drawnAt.offset(0, 0, -8), equipment: [] }, opts: reserved.opts,
    prof: { player: false }, cx: { dominant: () => false }, track: { vel: () => new Vec3(0, 0, 0), update() {} },
    blockedShotTargets: {}, st: {}, rangedAllowed: () => true, shotReady: () => true, shotInputs: () => 'draw', heldName: () => 'bow',
    clear() { for (const k of Object.keys(drawnKeys)) drawnKeys[k] = false }, pathTo() {}, holdWeapon: async () => {}, switched() {},
    sawRelease: () => false, strafeStep() {}, strafeKey: 'left', set: (k, v) => { drawnKeys[k] = v }, ready: () => false, used() {}, rest() {} }
  let drawCallbacks = 0
  const { bowTurn } = require('./pvp-parts').pvpParts({ ...require('../src/pvp/rules'), ...require('../src/pvp/body'),
    keyDir: require('../src/moves').keyDir, findItem: require('../src/pvp/potions').findItem, BOW_DRAW_MS: 1050,
    bowShoot: async (_bot, _foe, opts) => {
      drawCallbacks++; opts.onDraw(200)
      assert.ok(!drawnKeys.left && !drawnKeys.back, 'реальный onDraw не проводит диагональ через зарезервированную опору')
      return { shot: true }
    } }, ['turn-ranged'], ['bowTurn'])
  await bowTurn(drawnCtx, { me: drawnAt, d: 8, r: 8, hp: 20, seesBody: true, now: 10000 } as any)
  assert.equal(drawCallbacks, 1, 'проверен callback настоящей ступени лука, пропускающей controlsTurn')
  const reserve = scene(), guard = reserve.team[22]
  Object.assign(guard, { position: p(5.2, .5), weapon: 'stone_sword', inventory: { stone_sword: 1 }, armor, strength: 40 })
  reserve.observe(true)
  const reservedPlan = planPvp(reserve.board, reserve.team, { ...reserve.options, aggressive: false, quorum: 99 })
  const guardTask = reservedPlan.get(guard.id)!
  assert.equal(guardTask.kind, 'goto')
  assert.ok([...reservedPlan.values()].some(t => t.data?.dig && under(guard.position, t.position)), 'стоящий на опоре резерв тоже обязан отойти')
  let engaged: any
  const guardBot: any = { name: guard.id, c: { call: async () => { assert.fail('локальный бой не должен обходить освобождение опоры') } } }
  const guardTurn = swarmTurn({ generation: 1, now: () => 10000, alive: () => true, log() {}, pos: { [guard.id]: { p: guard.position, inv: guard.inventory } }, arena: {}, cooldown: new Map(),
    refresh: () => ({ board: reserve.board, member: guard, members: reserve.team, task: guardTask }), say() {}, chestAtHand: () => false, onslaught: () => false,
    cacheTurn: async () => false, transfer: async () => false, turnFight: async tc => { engaged = tc } } as any)
  await guardTurn.turn(guardBot)
  assert.equal(engaged.task.kind, 'fight')
  assert.equal(engaged.task.data.committed, true)
  assert.deepEqual(engaged.task.data.digAvoid, guardTask.data!.digAvoid, 'срочный бой goto → fight сохраняет освобождение опоры')
  const stand = guardTask.data!.swarmStand
  const fighting = { ...guardTask, kind: 'fight' }
  assert.equal(guardTurn.phase(fighting), guardTurn.phase({ ...fighting, data: { ...fighting.data, swarmStand: { ...stand, x: stand.x + .01 } } }), 'малое движение сектора сохраняет фазу боя; живой guard обновляется без stop')
  assert.notEqual(guardTurn.phase(guardTask), guardTurn.phase({ ...guardTask, data: { ...guardTask.data, swarmStand: { ...stand, x: stand.x + .01 } } }), 'goto несёт точную цель, поэтому новая стойка требует нового похода')
})
