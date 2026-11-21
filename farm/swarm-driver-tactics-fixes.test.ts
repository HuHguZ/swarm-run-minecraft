import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmClimb } from './swarm/swarm-driver/climb'
import { swarmRetry } from './swarm/swarm-driver/retry'
import { swarmMoves } from './swarm/swarm-driver/moves'
import { swarmLifecycle, currentTurn } from './swarm/swarm-driver/lifecycle'
import { swarmWind, relayCatchSpots } from './swarm/swarm-driver/wind'
import { swarmPosition } from './swarm/swarm-driver/position'
import { swarmTeam } from './swarm/swarm-driver/team'
import { swarmTurn } from './swarm/swarm-driver/turn'
import { swarmTurnTasks } from './swarm/swarm-driver/turn-tasks'
import { SwarmBoard } from '../daemon/src/swarm'
import { installDangers } from './arena/dangers'
import { watchAlarm, watchStatus } from './arena/watch'
import { startTactics } from './arena/supply'
import { installRounds } from './arena/rounds'

const turn = () => new Promise(resolve => setImmediate(resolve))

test('pearlUp breaks out of no-throw / arrived-in-place spin loop instead of looping 800x', async () => {
  const calls: string[] = []
  const pos: any = { Q: { p: { x: 566, y: 128, z: 567 }, hp: 20, inv: { ender_pearl: 2 }, armor: {} } }
  const b: any = {
    name: 'Q', team: 'blue',
    c: {
      async call(method: string) {
        calls.push(method)
        if (method === 'pearl_up') return { status: 'done', detail: { ok: false, hops: 0, stop: 'нет броска', at: { ...pos.Q.p } } }
        // Simulate goto returning arrived while bot barely moved (remained inside failed cell 566,128,567).
        if (method === 'goto') return { status: 'done', detail: { arrived: { ...pos.Q.p } }, state: { pos: { ...pos.Q.p } } }
        return { status: 'done', detail: {} }
      }
    }
  }
  const sw: any = createDriverState({
    bots: [b], pos, alive: () => true, now: () => 1000,
    arena: { x: 600, y: 120, z: 600, r: 80, killY: 113 },
    surfaceY: () => 128, log() {}
  })
  Object.assign(sw, swarmRetry(sw), { teamOf: () => 'blue', boardOf: () => ({ enemies: () => [] }), lootArena: () => sw.arena })
  Object.assign(sw, swarmMoves(sw))
  const climb = swarmClimb(sw)
  const roof = { x: 551.5, y: 153, z: 554.5 }

  let result: any = { moved: true }
  let iters = 0
  while (result !== null && iters < 25) {
    result = await climb.pearlUp(b, roof)
    iters++
  }
  assert.equal(result, null, 'pearlUp exhausts bad spots and returns null instead of spinning forever')
  assert.ok(iters <= 10, `bounded attempts (got ${iters})`)
  assert.ok(calls.filter(c => c === 'goto').length <= 8, 'each candidate spot attempted at most once')
  const countBefore = calls.length
  assert.equal(await climb.pearlUp(b, roof), null)
  assert.equal(calls.length, countBefore, 'blocked target issues zero additional RPCs')
})

test('turnRecover breaks 0s done eat loop via swarm_hold then recover-noop board fact', async () => {
  let time = 1000
  const calls: string[] = [], facts: any[] = []
  const m = { p: { x: 0, y: 120, z: 0 }, hp: 8, food: 20, inv: { cooked_beef: 4 } }
  const b: any = {
    name: 'M',
    c: { async call(method: string) { calls.push(method); return { status: 'done', detail: { ate: null, note: 'сыт' } } } }
  }
  const sw: any = { generation: 1, now: () => time, alive: () => true, arena: {}, detail: r => r?.detail || r, positionStep: async () => false }
  const tasks = swarmTurnTasks(sw)
  const tc: any = { b, round: 1, m, enemies: [], task: { kind: 'recover', position: m.p, data: {} }, context: { members: [{ id: 'M' }], board: { recordFact: (_s, _t, f) => facts.push(f) } } }

  await tasks.turnRecover(tc)
  assert.deepEqual(calls, ['eat'])
  time += 500
  await tasks.turnRecover(tc)
  assert.deepEqual(calls, ['eat', 'swarm_hold'], 'second noop holds instead of repeating 0s eat')
  time += 2500
  await tasks.turnRecover(tc)
  assert.equal(facts.some(f => f.id === 'recover-noop:M'), true, 'third stalled recover records recover-noop fact')
})

test('wind reservation cancels active guardedTurn owner so stale turn yields immediately', () => {
  const owner = { cancelled: false }
  const b: any = { name: 'A', team: 'blue', swarmExecuting: true, swarmTurnOwner: owner, c: { call: async () => ({ status: 'done', detail: {} }) } }
  const pos: any = { A: { p: { x: 0, y: 120, z: 0 }, hp: 20, inv: { wind_charge: 4 }, armor: {} } }
  const sw: any = createDriverState({
    bots: [b], pos, alive: () => true, hostile: () => true, now: () => 5000,
    arena: { x: 0, y: 120, z: 0, r: 40, ellipse: { rx: 40, rz: 40 } }, log() {}
  })
  Object.assign(sw, { teamOf: () => 'blue', panic: () => false, go: async () => ({ status: 'done', detail: {} }) })
  assert.equal(currentTurn(sw, b, sw.generation), true)

  const wind = swarmWind(sw)
  wind.windFlank(b, [{ id: 'Foe', visible: true, position: { x: 10, y: 135, z: 0 } }])
  assert.ok(b.swarmReserved, 'windFlank reserved the bot')
  assert.equal(owner.cancelled, true, 'active guardedTurn owner was cancelled upon reservation')
  assert.equal(currentTurn(sw, b, sw.generation), false, 'currentTurn yields immediately while reserved')
})

test('positionStep scopes positionQueries per team and releases semaphore before physical movement', async () => {
  let releaseWalk!: () => void
  const walkGate = new Promise<void>(r => { releaseWalk = r })
  const makeBot = (name: string, team: string) => ({ name, team, c: { async call() { return { status: 'done', detail: {} } } } })
  const bots = [makeBot('R1', 'red'), makeBot('R2', 'red'), makeBot('R3', 'red'), makeBot('B1', 'blue')]
  const pos: any = Object.fromEntries(bots.map((b, i) => [b.name, { p: { x: i * 10, y: 64, z: 0 }, hp: 20, inv: {}, armor: {} }]))
  const queriesAtWalk: number[] = []
  const sw: any = createDriverState({ bots, pos, alive: () => true, now: () => 1000, arena: { x: 0, y: 64, z: 0, r: 60 }, log() {} })
  Object.assign(sw, swarmRetry(sw), {
    teamOf: b => b.team, fighting: () => false, panic: () => false, detail: r => r,
    async execute(b: any, method: string) {
      if (method === 'swarm_position') return { observed: true, candidates: [{ score: 5, at: { x: pos[b.name].p.x + 5, y: 64, z: 0 }, methods: [{ kind: 'walk', skill: 'goto', cost: 1, params: {} }] }] }
      queriesAtWalk.push(sw.positionQueries)
      await walkGate
      return { ok: true, at: { x: pos[b.name].p.x + 5, y: 64, z: 0 } }
    }
  })
  const position = swarmPosition(sw)
  const board = { team: 'red', enemies: () => [], recordFact() {} }
  const pending = position.positionStep(bots[0], { board, member: { reserve: {} }, members: [] }, 'ranged')
  for (let i = 0; i < 10 && !queriesAtWalk.length; i++) await turn()
  assert.deepEqual(queriesAtWalk, [0], 'positionQueries semaphore is released before physical movement begins')
  releaseWalk()
  assert.equal(await pending, true)
})

test('team.ts caches membersOf per tick, assigns kit-based roles without modulo gates, and exposes bow/power', () => {
  let time = 1000
  const bots = ['B0', 'B1', 'B2'].map(name => ({ name, team: 'blue' }))
  // Put splash healing on k=0 (where old k % 3 === 1 failed!), pickaxe on k=1 (old k % 3 === 0 failed!), bow on k=2 (old k % 2 failed!).
  const pos: any = {
    B0: { p: { x: 0, y: 64, z: 0 }, hp: 20, food: 20, inv: { splash_potion: 3 }, potions: { splash_healing: 3 }, armor: {} },
    B1: { p: { x: 2, y: 64, z: 0 }, hp: 20, food: 20, inv: { diamond_pickaxe: 1, cobblestone: 32 }, armor: {} },
    B2: { p: { x: 4, y: 64, z: 0 }, hp: 20, food: 20, inv: { bow: 1, arrow: 32 }, attackArrows: 32, armor: {}, enchants: [{ name: 'bow', slot: 9, ench: { power: 4 } }] }
  }
  const sw: any = createDriverState({ bots, pos, alive: () => true, hostile: () => true, now: () => time, arena: { x: 0, y: 64, z: 0, r: 40 }, log() {} })
  const team = swarmTeam(sw)
  const m1 = team.membersOf(bots[0])
  assert.equal(m1.find(m => m.id === 'B0')?.role, 'healer')
  assert.equal(m1.find(m => m.id === 'B1')?.role, 'miner-builder')
  assert.equal(m1.find(m => m.id === 'B2')?.role, 'ranged')
  assert.equal(m1.find(m => m.id === 'B2')?.weapon, 'bow')
  assert.equal(m1.find(m => m.id === 'B2')?.ench?.power, 4)

  // Same-tick second call hits cache (returns identical member objects without rebuilding).
  const m2 = team.membersOf(bots[1])
  assert.strictEqual(m1[0], m2[0], 'same-tick call reuses cached member objects')
})

test('moves.go escalates repeated noPath from the same cell to climb+unstuck and then backs off', async () => {
  const calls: any[] = []
  const pos: any = { I: { p: { x: 630, y: 120, z: 566 }, hp: 20, inv: { iron_pickaxe: 1 }, armor: {} } }
  const b: any = {
    name: 'I', team: 'blue',
    c: { async call(_m: string, p: any) { calls.push(p); return { status: 'done', detail: { stopped: 'No path to the goal!', at: { ...pos.I.p } }, state: { pos: { ...pos.I.p } } } } }
  }
  const sw: any = createDriverState({ bots: [b], pos, alive: () => true, now: () => 1000, arena: { x: 600, y: 120, z: 600, r: 80 }, log() {} })
  Object.assign(sw, swarmRetry(sw), { teamOf: () => 'blue', boardOf: () => ({ enemies: () => [] }) })
  const moves = swarmMoves(sw)
  const target = { x: 614, y: 120, z: 615 }

  await moves.go(b, target)
  await moves.go(b, target)
  assert.equal(calls[0].unstuck, undefined)
  assert.equal(calls[1].unstuck, undefined)
  await moves.go(b, target)
  assert.equal(calls[2].climb, true, '3rd attempt from trapped cell enables climb')
  assert.equal(calls[2].unstuck, true, '3rd attempt from trapped cell enables unstuck')
  const r4 = await moves.go(b, target)
  assert.equal(calls.length, 3, '4th immediate attempt backs off instead of hammering A* 407x')
  assert.equal(r4.code, 'NO_PATH')
})

test('dangers.ts dodgeAway smash fallback skips shield on successful dodge and triggers fallback on cached failure', async t => {
  const calls: string[] = []
  let now = 10000
  t.mock.method(Date, 'now', () => now)
  let evadeOk = true
  const b: any = {
    name: 'A', team: 'blue', last: { m: 'goto' },
    c: {
      async call(method: string) {
        if (method === 'swarm_pose') return { status: 'done', detail: { cells: [] } }
        calls.push(method)
        if (method === 'evade') return { status: 'done', detail: { ok: evadeOk, why: evadeOk ? undefined : 'некуда' } }
        return { status: 'done', detail: { ok: true } }
      }
    }
  }
  const p = { x: 0, y: 64, z: 0 }
  const ctx: any = { round: 1, bots: [b], pos: { A: { p, hp: 20, inv: { shield: 1 }, armor: {} } }, busy: new Set(), out: new Set(), deadNow: new Set(), alive: () => true, enemiesOf: () => [], log() {} }
  installDangers(ctx)

  // 1) Successful dodge must NOT freeze bot in swarm_hold shield stance.
  b.c.onDanger({ pos: p, observedAt: now, dangers: { smashes: [{ name: 'Macer', ticks: 12, at: { x: 2, y: 64, z: 0 } }] } })
  await turn(); await turn()
  assert.deepEqual(calls, ['evade'])

  // 2) Failed dodge invokes dangerShieldSmash fallback.
  calls.length = 0; evadeOk = false; now += 1500
  b.c.onDanger({ pos: p, observedAt: now, dangers: { smashes: [{ name: 'Macer', ticks: 12, at: { x: 2, y: 64, z: 0 } }] } })
  await turn(); await turn(); await turn()
  assert.deepEqual(calls, ['evade', 'swarm_hold'])

  // 3) Cached dodge failure (evade skipped) MUST still invoke dangerShieldSmash fallback!
  calls.length = 0; now += 1500
  b.c.onDanger({ pos: p, observedAt: now, dangers: { smashes: [{ name: 'Macer', ticks: 12, at: { x: 2, y: 64, z: 0 } }] } })
  await turn(); await turn(); await turn()
  assert.deepEqual(calls, ['swarm_hold'], 'cached evade failure still raises shield against mace smash')
})

test('watchAlarm exempts active defense/recovery intents, watchStatus uses ctx.hostile, supply skips dead rolesT, and readDeaths uses pre-death pos', async t => {
  // 1) watchAlarm exempt list
  const stopped: string[] = []
  let alarmTick!: () => void
  t.mock.method(globalThis, 'setInterval', (fn: any) => { alarmTick = fn; return 1 as any })
  const b: any = { name: 'A', team: 'blue', c: { call: async (m: string) => { if (m === 'stop') stopped.push(b.last.m); return {} } } }
  const ctx: any = {
    round: 1, between: false, teams: false, bots: [b], names: ['A'],
    pos: { A: { p: { x: 0, y: 120, z: 0 }, hp: 20, observedAt: Date.now(), frameAt: Date.now() } },
    busy: new Set(), alive: () => true, teamOf: () => 'blue',
    enemiesOf: () => [{ n: 'Foe', d: 2, spd: 6, human: true, seenAt: Date.now() }]
  }
  watchAlarm(ctx)
  for (const method of ['lava_escape', 'dodge_blast', 'clear_web', 'eat', 'antidote', 'swarm_hold', 'pearl_ambush', 'pearl_trap', 'boost_lance', 'boost_shot']) {
    b.last = { m: method, pending: true, at: Date.now(), p: {} }
    alarmTick()
  }
  assert.deepEqual(stopped, [], 'watchAlarm must not interrupt active defense/recovery/ambush actions')

  // 2) startTactics returns no rolesT and skips legacy roles logging in arms mode
  const roleLogs: string[] = []
  const tac = await startTactics({
    i: 31, teams: true, arms: true, bots: [{ name: 'A', team: 'blue' }],
    pos: { A: { inv: { bow: 1 }, armor: {} } }, busy: new Set(),
    labNeed: {}, brewed: {}, alchemist: {}, log: l => roleLogs.push(l), sleep: async () => {}
  } as any)
  assert.equal('rolesT' in tac, false)
  assert.equal(roleLogs.length, 0, 'arms mode does not spam legacy roles logs')

  // 3) readDeaths uses pre-death live arena position when pos[victim].p already reset to spawn 84 bl away
  const tmpLog = path.join(os.tmpdir(), `nd-deaths-${Date.now()}.log`)
  fs.writeFileSync(tmpLog, '')
  const logs: string[] = []
  const victim: any = { name: 'NeuroFarm31i', team: 'blue', swarmTask: { kind: 'flee' }, last: { m: 'flee' }, lastLivePos: { p: { x: 602, y: 120, z: 600 }, at: Date.now(), round: 1 } }
  const killer: any = { name: 'NeuroFarm31', team: 'red', lastLivePos: { p: { x: 600, y: 120, z: 600 }, at: Date.now(), round: 1 } }
  const rctx: any = {
    i: 31, teams: true, arms: true, bots: [victim, killer], names: ['NeuroFarm31i', 'NeuroFarm31'],
    // Simulate post-death respawn reset to world spawn 84 blocks away!
    pos: { NeuroFarm31i: { p: { x: 516, y: 120, z: 600 }, hp: 0 }, NeuroFarm31: { p: { x: 600, y: 120, z: 600 }, hp: 20 } },
    deaths: {}, kills: {}, deadNow: new Set(), out: new Set(), deathAt: {}, killGaps: [], humans: {}, roundWins: { red: 0, blue: 0 },
    radio: {}, opened: new Set(), chestBy: new Map(), chestFail: new Map(), refills: new Map(), labNeed: {}, brewed: {}, alchemist: {},
    LOGF: tmpLog, logAt: 0, BOX: '', HUMAN_TEAM: '', X: 600, Y: 120, Z: 600, R: 80, round: 1, between: false,
    teamOf: n => n === 'NeuroFarm31' ? 'red' : 'blue', emote: async () => {}, rcon: async () => '', log: l => logs.push(l), sleep: async () => {}
  }
  installRounds(rctx)
  fs.appendFileSync(tmpLog, '[20:50:10] [Server thread/INFO]: NeuroFarm31i was slain by NeuroFarm31\n')
  rctx.readDeaths()
  fs.unlinkSync(tmpLog)
  assert.match(logs[0], /в 2 бл\./, `expected real combat distance (~2 bl), got: ${logs[0]}`)
  assert.deepEqual(rctx.deathAt.NeuroFarm31i.p, { x: 602, y: 120, z: 600 })
})

test('dynamic role rotation shifts geared/close-combat specialists into fighters and upgrades reported chests in tourChoice', () => {
  let now = 1000
  const bots = ['M', 'H', 'F'].map(name => ({ name, team: 'blue' }))
  const pos: any = {
    M: { p: { x: 0, y: 64, z: 0 }, hp: 20, inv: { diamond_pickaxe: 1, cobblestone: 64, stone_sword: 1 }, armor: {}, potions: {} },
    H: { p: { x: 2, y: 64, z: 0 }, hp: 20, inv: { wooden_sword: 1 }, armor: {}, potions: { splash_healing: 2 } },
    F: { p: { x: 4, y: 64, z: 0 }, hp: 20, inv: { iron_sword: 1 }, armor: { torso: 'iron_chestplate' }, potions: {} },
  }
  const sw: any = createDriverState({ bots, pos, alive: () => true, now: () => now, arena: { x: 0, y: 64, z: 0, r: 80 }, log() {} })
  Object.assign(sw, swarmTeam(sw))

  // Initially undergeared miner & healer hold specialist roles.
  let members = sw.membersOf(bots[0])
  assert.equal(members.find(m => m.id === 'M')?.role, 'miner-builder')
  assert.equal(members.find(m => m.id === 'H')?.role, 'healer')

  // Once M gears up into top frontline gear (and finishes building / runs out of blocks), M rotates into fighter!
  now += 200
  pos.M.inv = { diamond_pickaxe: 1, netherite_sword: 1 }
  pos.M.armor = { head: 'diamond_helmet', torso: 'diamond_chestplate', legs: 'diamond_leggings', feet: 'diamond_boots' }
  members = sw.membersOf(bots[0])
  assert.notEqual(members.find(m => m.id === 'M')?.role, 'miner-builder', 'geared healthy miner without blocks/build demand rotates into combat role')

  // When a visible enemy closes within 4 bl of H (and no ally is wounded), H rotates out of healer into combat!
  now += 200
  pos.H.inv = { diamond_sword: 1 }
  pos.H.armor = { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' }
  sw.boardOf(bots[0]).observe('H', now, { id: 'Red', position: { x: 5, y: 64, z: 0 }, visible: true, equipment: { weapon: 'iron_sword', armor: [] } })
  members = sw.membersOf(bots[0])
  assert.notEqual(members.find(m => m.id === 'H')?.role, 'healer', 'combat-engaged geared medic rotates into fighter')

  // Wounded fighter F who picked up a pickaxe+blocks and stepped away from combat rotates into miner-builder!
  now += 200
  pos.F.p = { x: 30, y: 64, z: 0 }
  pos.F.hp = 10
  pos.F.inv = { iron_pickaxe: 1, cobblestone: 32, stone_sword: 1 }
  pos.F.armor = {}
  members = sw.membersOf(bots[0])
  assert.equal(members.find(m => m.id === 'F')?.role, 'miner-builder', 'wounded/undergeared fighter with utility rotates back to support/mine')
})

test('preempt and turn never keep mining/building or jog past a close visible enemy', async () => {
  const calls: string[] = []
  let now = 10000
  const foePos = { x: 5, y: 120, z: 0 }
  const b: any = {
    name: 'U', team: 'blue', swarmExecuting: true,
    swarmTask: { id: 'pvp:U', kind: 'scout', data: { reserve: true } },
    swarmTurnOwner: { cancelled: false },
    last: { m: 'dig_to', pending: true, p: {} },
    c: { async call(method: string) { calls.push(method); return { status: 'done', detail: {} } } }
  }
  const pos: any = { U: { p: { x: 0, y: 120, z: 0 }, hp: 20, inv: { iron_sword: 1, diamond_pickaxe: 1, cobblestone: 64 }, armor: { torso: 'iron_chestplate' } } }
  const board = new SwarmBoard('blue', () => now, 8000)
  const member: any = { id: 'U', team: 'blue', position: pos.U.p, health: 20, strength: 40, role: 'miner-builder', inventory: pos.U.inv, weapon: 'iron_sword', armor: ['iron_chestplate'] }
  board.setMembers([member])
  board.observe('U', now, { id: 'Red', position: foePos, visible: true, equipment: { weapon: 'stone_sword', armor: [] } })

  let nextTask: any = { id: 'pvp:U', kind: 'fight', data: { target: 'Red' }, position: foePos }
  const sw: any = {
    now: () => now, generation: 1, pos, bots: [b], arms: true, hideouts: [], chestTops: [], alive: () => true,
    teamOf: () => 'blue', arena: { x: 0, y: 120, z: 0, r: 80 },
    refresh: () => ({ board, member, members: [member], task: nextTask }),
    say() {}, log() {}, onslaught: () => false, cooldown: new Map(),
    chestAtHand: () => false, cacheTurn: async () => { calls.push('cache'); return true },
    transfer: async () => false, loot: async () => false, tour: async () => false,
    blocked: () => false,
    positionStep: async () => { calls.push('position'); return true },
    buildStep: async () => { calls.push('build'); return true },
    mineStep: async () => { calls.push('mine'); return true },
    turnGoto: async () => { calls.push('goto') },
    turnFight: async () => { calls.push('fight') },
    search: async () => { calls.push('search') },
    detail: (r: any) => r?.detail || r
  }
  const { preempt, turn: runTurn } = swarmTurn(sw)

  // 1) preempt() immediately stops dig_to when a close visible enemy appears (despite identical empty phase()).
  assert.equal(preempt(b), true, 'preempt interrupts dig_to on close visible enemy / fight escalation')
  assert.deepEqual(calls, ['stop'])
  assert.equal(b.swarmTurnOwner.cancelled, true)

  // 2) turn() with fight task & visible enemy at 5 bl skips cacheTurn/positionStep/buildStep/mineStep and runs fight!
  calls.length = 0
  b.swarmTurnOwner = { cancelled: false }
  await runTurn(b)
  assert.deepEqual(calls, ['fight'], 'close fight skips miner-builder work and cacheTurn')

  // 3) turn() with goto { search: true } & visible enemy at 5 bl engages instead of jogging past!
  calls.length = 0
  nextTask = { id: 'pvp:U', kind: 'goto', data: { search: true }, position: { x: 40, y: 120, z: 0 } }
  b.swarmTurnOwner = { cancelled: false }
  await runTurn(b)
  assert.deepEqual(calls, ['fight'], 'armed bot engages close visible enemy instead of jogging past during search goto')
})

test('Phase 4 polish: preempt damps fight-shove & fight-target thrash and never self-interrupts heal/scout; turnFlee breaks 0s take_cover freeze; readDeaths survives hp=0 crystal respawn', async () => {
  let now = 20000
  const calls: string[] = []
  const foeA = { id: 'A', position: { x: 5, y: 120, z: 0 }, visible: true, equipment: { weapon: 'iron_sword', armor: [] } }
  const foeB = { id: 'B', position: { x: 4.5, y: 120, z: 0 }, visible: true, equipment: { weapon: 'iron_sword', armor: [] } }
  const board = new SwarmBoard('blue', () => now, 8000)
  const member: any = { id: 'Q', team: 'blue', position: { x: 0, y: 120, z: 0 }, health: 20, strength: 50, role: 'fighter', inventory: { iron_sword: 1 }, weapon: 'iron_sword', armor: [] }
  board.setMembers([member])
  board.observe('Q', now, foeA)
  board.observe('Q', now, foeB)

  let nextTask: any = { id: 'pvp:Q', kind: 'fight', data: { target: 'A', shove: true, shoveAt: { x: 8, y: 120, z: 0 } }, position: foeA.position }
  const b: any = {
    name: 'Q', team: 'blue', swarmExecuting: true, swarmTaskAt: now - 500,
    swarmTask: { id: 'pvp:Q', kind: 'fight', data: { target: 'A' }, position: foeA.position },
    swarmTurnOwner: { cancelled: false },
    last: { m: 'goto', pending: true, p: {} },
    c: { async call(method: string) { calls.push(method); return { status: 'done', detail: { ok: true } } } }
  }
  const pos: any = { Q: { p: { x: 0, y: 120, z: 0 }, hp: 20, inv: { iron_sword: 1 }, armor: {} } }
  const sw: any = {
    now: () => now, generation: 1, pos, bots: [b], alive: () => true, teamOf: () => 'blue',
    arena: { x: 0, y: 120, z: 0, r: 80 },
    refresh: () => ({ board, member, members: [member], task: nextTask }),
    say() {}, log() {}, detail: (r: any) => r?.detail || r, blocked: () => false, failed() {}
  }
  const { preempt } = swarmTurn(sw)

  // 1) First intentional ordinary -> shove transition preempts immediately; immediate ping-pong back within 2.5s is damped.
  assert.equal(preempt(b), true, 'first intentional fight -> shove transition preempts cleanly')
  assert.deepEqual(calls, ['stop'])
  calls.length = 0
  b.swarmTask = nextTask
  b.swarmTurnOwner = { cancelled: false }
  b.last = { m: 'goto', pending: true, p: {} }
  nextTask = { id: 'pvp:Q', kind: 'fight', data: { target: 'A' }, position: foeA.position }
  now += 500
  assert.equal(preempt(b), false, 'immediate shove -> ordinary ping-pong within 2.5s is damped without aborting goto')
  assert.equal(b.swarmTask.data.shove, undefined)
  assert.deepEqual(calls, [])

  // 2) Active [fight] on visible target <= 6 bl does NOT abort on marginal target swap A -> B.
  b.last = { m: 'fight', pending: true, p: { target: 'A' } }
  b.swarmTask = { id: 'pvp:Q', kind: 'fight', data: { target: 'A' }, position: foeA.position }
  nextTask = { id: 'pvp:Q', kind: 'fight', data: { target: 'B' }, position: foeB.position }
  assert.equal(preempt(b), false, 'active fight at 5 bl resists noisy target swap')

  // 3) heal -> heal and scout(buildKind) -> scout(buildKind) NEVER self-interrupt [goto].
  b.last = { m: 'goto', pending: true, p: {} }
  b.swarmTask = nextTask = { id: 'pvp:Q', kind: 'heal', data: { ally: 'Ally' }, position: { x: 4, y: 120, z: 0 } }
  assert.equal(preempt(b), false, 'heal -> heal never self-interrupts goto')
  b.swarmTask = nextTask = { id: 'pvp:Q', kind: 'scout', data: { buildKind: 'cutoff' }, position: { x: 4, y: 120, z: 0 } }
  assert.equal(preempt(b), false, 'scout(buildKind) -> scout(buildKind) never self-interrupts goto')

  // 4) turnFlee breaks repeated 0s done take_cover noop by holding cover or advancing to destination.
  const coverCalls: string[] = []
  const cb: any = {
    name: 'D', team: 'blue',
    c: { async call(m: string) { coverCalls.push(m); return { status: 'done', detail: { ok: true }, state: { pos: { x: 0, y: 128, z: 0 } } } } }
  }
  const cpos: any = { D: { p: { x: 0, y: 128, z: 0 }, hp: 14, inv: {}, armor: {} } }
  const csw: any = {
    now: () => now, generation: 1, pos: cpos, alive: () => true, log() {},
    arena: { x: 0, y: 120, z: 0, r: 80 }, cooldown: new Map(), detail: (r: any) => r?.detail || r,
    blocked: () => false, failed() {}, rangedAdvantage: () => false, go: async () => { coverCalls.push('go'); return { status: 'done', detail: { arrived: true } } }
  }
  const fleeTasks = swarmTurnTasks(csw)
  const tc: any = { b: cb, board, context: { members: [] }, round: 1, m: cpos.D, task: { kind: 'flee', position: { x: 0, y: 128, z: 0 }, data: { target: 'Arc' } }, enemies: [{ id: 'Arc', threat: 'bow', seenAt: now, position: { x: 20, y: 120, z: 0 } }] }
  await fleeTasks.turnFlee(tc)
  assert.deepEqual(coverCalls, ['take_cover'])
  now += 500
  await fleeTasks.turnFlee(tc)
  assert.deepEqual(coverCalls, ['take_cover', 'take_cover', 'swarm_hold'], '2nd 0s take_cover noop holds cover instead of triggering 6s frozen reset')

  // 5) readDeaths uses prevLivePos even after an intermediate hp=0 poll and respawn inside arena (crystal kill).
  const tmpLog = path.join(os.tmpdir(), `nd-crystal-deaths-${Date.now()}.log`)
  fs.writeFileSync(tmpLog, '')
  const logs: string[] = []
  const victim: any = {
    name: 'NeuroFarm31n', team: 'red', swarmTask: { kind: 'flee' }, last: { m: 'flee' },
    lastLivePos: { p: { x: 600, y: 120, z: 600 }, at: Date.now(), round: 1 },
    prevLivePos: { p: { x: 570, y: 120, z: 620 }, at: Date.now() - 800, round: 1 },
    respawnedAt: Date.now() - 200
  }
  const killer: any = { name: 'NeuroFarm31q', team: 'blue', lastLivePos: { p: { x: 572, y: 120, z: 621 }, at: Date.now(), round: 1 } }
  const rctx: any = {
    i: 31, teams: true, arms: true, bots: [victim, killer], names: ['NeuroFarm31n', 'NeuroFarm31q'],
    pos: { NeuroFarm31n: { p: { x: 600, y: 120, z: 600 }, hp: 20 }, NeuroFarm31q: { p: { x: 572, y: 120, z: 621 }, hp: 20 } },
    deaths: {}, kills: {}, deadNow: new Set(), out: new Set(), deathAt: {}, killGaps: [], humans: {}, roundWins: { red: 0, blue: 0 },
    radio: {}, opened: new Set(), chestBy: new Map(), chestFail: new Map(), refills: new Map(), labNeed: {}, brewed: {}, alchemist: {},
    LOGF: tmpLog, logAt: 0, BOX: '', HUMAN_TEAM: '', X: 600, Y: 120, Z: 600, R: 80, round: 1, between: false,
    teamOf: (n: string) => n === 'NeuroFarm31q' ? 'blue' : 'red', emote: async () => {}, rcon: async () => '', log: (l: string) => logs.push(l), sleep: async () => {}
  }
  installRounds(rctx)
  fs.appendFileSync(tmpLog, '[22:21:46] [Server thread/INFO]: NeuroFarm31n was blown up by NeuroFarm31q\n')
  rctx.readDeaths()
  fs.unlinkSync(tmpLog)
  assert.match(logs[0], /в 2 бл\./, `crystal kill after instant respawn logs real combat distance (~2 bl), got: ${logs[0]}`)
})

test('Phase 5 windObserve: scoped reports/RTT/ack resilience, quantized scene dedup, and immediate airborne follow-up', async () => {
  let now = 200000
  const calls: any[] = []
  const arena = { x: 600.5, y: 120, z: 600.5, r: 80, ellipse: { a: 77, b: 65 } }
  const pos: any = {
    FastA: { p: { x: 600, y: 120, z: 594 }, hp: 20, inv: { wind_charge: 6 }, armor: {} },
    FastB: { p: { x: 604, y: 120, z: 596 }, hp: 20, inv: { wind_charge: 6 }, armor: {} },
    SlowThrower: { p: { x: 595, y: 120, z: 595 }, hp: 20, inv: { wind_charge: 6 }, armor: {} },
    MidBystander: { p: { x: 570, y: 120, z: 600 }, hp: 20, inv: {}, armor: {} }, // 30 bl away, uncharged, off ray
    FarBot: { p: { x: 665, y: 120, z: 655 }, hp: 20, inv: {}, armor: {} } // >80 bl away, out of scope
  }
  let dropMidAck = true, lagSlowThrower = true, failPlan = false
  const bots: any[] = Object.keys(pos).map(name => ({
    name, team: 'blue', last: { m: 'fight', pending: true },
    c: {
      async call(method: string, p: any) {
        calls.push({ name, method, p })
        if (method === 'wind_report' && p.cancel) return { detail: { ok: true } }
        if (method === 'wind_report') {
          if (name === 'SlowThrower' && lagSlowThrower && !p.coordination) { await turn(); await turn(); now += 600 }
          if (name === 'MidBystander' && dropMidAck && p.coordination) throw new Error('distant bystander ack timeout')
          const tick = 100 + Math.floor((now - 200000) / 50)
          return { detail: { ok: true, coordination: p.coordination, ready: true, gameTick: tick,
            report: { id: name, position: pos[name].p, velocity: { x: 0, y: 0, z: 0 }, onGround: true, gameTick: tick } } }
        }
        if (method === 'enemy_wind_plan') {
          const tick = 100 + Math.floor((now - 200000) / 50)
          if (failPlan) return { detail: { ok: false, why: 'no_useful_native_chain', gameTick: tick } }
          return { detail: { ok: true, gameTick: tick, plan: { gameTick: tick, target: p.target,
            shots: p.throwers.map((r: any, i: number) => ({ thrower: r.id, fireTick: tick + p.leadTicks + i * 2, arrivalTick: tick + p.leadTicks + i * 2 + 3 })) } } }
        }
        if (method === 'wind_out') return { detail: { fired: true, launchConfirmed: true, burstSeen: true } }
        throw new Error('unexpected ' + method)
      }
    }
  }))
  const sw: any = {
    now: () => now, generation: 1, arena, bots, pos, alive: () => true,
    teamOf: (b: any) => b.team, hostile: (_b: any, id: string) => id === 'Red', panic: () => false, log() {}
  }
  const api = swarmWind(sw)
  const foe = { id: 'Red', visible: true, position: { x: 600.5, y: 120, z: 600.5 }, velocity: { x: 0.05, y: 0, z: 0.25 } }

  // 1) FarBot (>48 bl away, uncharged, off ray) is excluded from wind_report; SlowThrower (600ms RTT) is dropped from throwers
  //    instead of aborting FastA/FastB; MidBystander (30 bl, uncharged, off ray) failing ack does NOT abort the chain!
  assert.equal(await api.windObserve(bots[0], [foe], now), true)
  assert.equal(calls.some(c => c.name === 'FarBot'), false, 'far uncharged bot across arena is excluded from wind_report fan-out')
  const plan1 = calls.find(c => c.method === 'enemy_wind_plan')
  assert.deepEqual(plan1.p.throwers.map((r: any) => r.id), ['FastA', 'FastB'], 'slow thrower excluded from active throwers without aborting fast pair')
  assert.ok(plan1.p.allies.some((r: any) => r.id === 'SlowThrower'), 'slow thrower stays in allies for safety')
  assert.deepEqual(calls.filter(c => c.method === 'wind_out').map(c => c.name), ['FastA', 'FastB'])

  // 2) Immediate follow-up after fired chain: attempted cache was cleared on fired > 0 so shot #2 plans immediately!
  calls.length = 0
  lagSlowThrower = false; dropMidAck = false
  assert.equal(await api.windObserve(bots[0], [{ ...foe, airborne: true, windAffected: true }], now), true)
  assert.equal(calls.filter(c => c.method === 'enemy_wind_plan').length, 1, 'airborne follow-up plans immediately after fired shot')

  // 3) Quantized scene dedup: micro float jitter & FarBot wandering do NOT bust no_useful_native_chain cache.
  calls.length = 0
  failPlan = true
  assert.equal(await api.windObserve(bots[0], [foe], now), false)
  pos.FarBot.p.x += 5
  const jittered = { ...foe, position: { x: foe.position.x + 0.01, y: foe.position.y, z: foe.position.z - 0.01 }, velocity: { x: 0.051, y: 0.005, z: 0.249 } }
  assert.equal(await api.windObserve(bots[0], [jittered], now), false)
  assert.equal(calls.filter(c => c.method === 'enemy_wind_plan').length, 1, 'micro jitter and out-of-scope FarBot movement deduplicate')
})

test('Phase 5 center-to-rim relay: windFlank stages rear launcher + lateral corridor catcher & windWing prioritizes/leads moving airborne target', async () => {
  let now = 300000
  const arena = { x: 600.5, y: 120, z: 600.5, r: 80, ellipse: { a: 77, b: 65 } }
  const moves: any[] = [], orbits: any[] = []
  const mkBot = (name: string, p: any, inv: any, extra: any = {}) => ({
    name, team: 'blue', last: { m: 'goto', pending: false }, ...extra,
    c: {
      async call(method: string, params: any) {
        if (method === 'wing_orbit') { orbits.push({ name, params }); return { detail: { ok: true } } }
        return { status: 'done' }
      }
    }
  })
  // Moving target at center of Colosseum (room=65 bl) heading +Z toward short rim (b=65).
  const foe = { id: 'Runner', visible: true, position: { x: 600.5, y: 120, z: 600.5 }, velocity: { x: 0, y: 0, z: 0.28 } }
  const pos: any = {
    Launcher: { p: { x: 600.5, y: 120, z: 602.5 }, hp: 20, inv: { wind_charge: 4 }, armor: {} }, // bad angle (outside target)
    Catcher: { p: { x: 608, y: 120, z: 607 }, hp: 20, inv: { wind_charge: 4 }, armor: {} }, // ready to take corridor catch spot
    MeleeLocked: { p: { x: 600.5, y: 120, z: 604 }, hp: 20, inv: { wind_charge: 4 }, armor: {} }, // in close fight <=8 bl
    WingNearLead: { p: { x: 600.5, y: 128, z: 597 }, hp: 20, gliding: true, inv: { elytra: 1, firework_rocket: 6, wind_charge: 4 }, armor: { torso: 'elytra' } },
    WingFarBack: { p: { x: 600.5, y: 128, z: 575 }, hp: 20, gliding: true, inv: { elytra: 1, firework_rocket: 6, wind_charge: 4 }, armor: { torso: 'elytra' } }
  }
  const bots = [
    mkBot('Launcher', pos.Launcher.p, pos.Launcher.inv),
    mkBot('Catcher', pos.Catcher.p, pos.Catcher.inv),
    mkBot('MeleeLocked', pos.MeleeLocked.p, pos.MeleeLocked.inv, { swarmTask: { kind: 'fight', data: { target: 'Runner' } } }),
    mkBot('WingNearLead', pos.WingNearLead.p, pos.WingNearLead.inv),
    mkBot('WingFarBack', pos.WingFarBack.p, pos.WingFarBack.inv)
  ]
  const sw: any = {
    now: () => now, generation: 1, arena, bots, pos, alive: () => true,
    teamOf: (b: any) => b.team, hostile: (_b: any, id: string) => id === 'Runner' || id === 'Grounded', panic: () => false,
    boardOf: () => ({ enemies: () => [] }), log() {},
    go: async (o: any, at: any) => { moves.push({ name: o.name, at }); return { status: 'done' } }
  }
  const api = swarmWind(sw)

  // 1) Center-to-rim ground windFlank dispatches Launcher (rear) + Catcher (lateral corridor ahead), never yanks MeleeLocked.
  api.windFlank(bots[0], [foe])
  assert.deepEqual(moves.map(m => m.name).sort(), ['Catcher', 'Launcher'], 'center relay stages 1 rear launcher + 1 corridor catcher without yanking melee fighter')
  const launcherMove = moves.find(m => m.name === 'Launcher')!.at
  const catcherMove = moves.find(m => m.name === 'Catcher')!.at
  assert.ok(launcherMove.z < foe.position.z, 'launcher stages behind target on center side (-out)')
  assert.ok(catcherMove.z > foe.position.z + 6, 'catcher stages ahead along +Z outward carry corridor')
  assert.ok(Math.abs(catcherMove.x - foe.position.x) >= 5, 'catcher is laterally offset >=5 bl out of launcher ray')
  const sampleCatches = relayCatchSpots(foe.position, arena, 120)
  assert.equal(sampleCatches.length, 2)

  // 2) windWing prioritizes airborne/windAffected target over grounded target and uses velocity lead + 3-bl airborne re-pickup.
  const grounded = { id: 'Grounded', visible: true, position: { x: 600.5, y: 120, z: 650 }, velocity: { x: 0, y: 0, z: 0 } }
  const airborne = { ...foe, airborne: true, windAffected: true, position: { x: 600.5, y: 126, z: 605 } }
  api.windWing(bots[0], [grounded, airborne])
  await turn()
  assert.equal(orbits[0].params.target, 'Runner', 'airborne windAffected target prioritized first over grounded rim target')
  assert.equal(orbits[0].name, 'WingNearLead', 'closest elytra escort to velocity-led lane is dispatched to airborne target')

  // After orbit completes and airborne target advances 3.5 bl (<6, >=3), WingNearLead immediately re-engages!
  const beforeRe = orbits.length
  api.windWing(bots[0], [{ ...airborne, position: { x: 600.5, y: 126, z: 608.5 } }])
  await turn()
  assert.equal(orbits.length, beforeRe + 1, 'airborne wind-affected target re-dispatches escort after >=3 bl movement')
  assert.equal(orbits.at(-1).name, 'WingNearLead')
})

test('dangers.ts clear_web failure logs real reason/count (never undefined) and backs off 1.8s instead of spamming', async t => {
  let now = 400000
  t.mock.method(Date, 'now', () => now)
  const logs: string[] = []
  let webCalls = 0
  const b: any = {
    name: 'WebBot', team: 'blue', last: { m: 'goto', pending: false },
    c: {
      async call(method: string) {
        if (method === 'clear_web') {
          webCalls++
          return webCalls === 1
            ? { status: 'failed' }
            : { status: 'done', detail: { ok: false, broken: 0 } }
        }
        return { status: 'done' }
      }
    }
  }
  const ctx: any = {
    round: 1, bots: [b], pos: { WebBot: { p: { x: 0, y: 64, z: 0 }, inv: { iron_sword: 1 } } },
    busy: new Set(), out: new Set(), deadNow: new Set(), alive: () => true,
    enemiesOf: () => [], swarmDriver: { panic: () => false, canEngage: () => true },
    log: (line: string) => logs.push(line)
  }
  installDangers(ctx)
  const fire = () => b.c.onDanger({ pos: { x: 0, y: 64, z: 0 }, observedAt: ++now, dangers: { web: [{ at: { x: 0, y: 64, z: 0 }, cells: 1 }] } })

  fire()
  await turn()
  assert.equal(webCalls, 1)
  assert.ok(!logs.some(l => l.includes('undefined')), `log must never print undefined: ${logs.join(' | ')}`)
  assert.ok(logs.some(l => l.includes('0 из 1 failed')), `expected formatted fallback count, got: ${logs.join(' | ')}`)

  // Immediate repeats within 1.8s backoff must NOT spam clear_web.
  for (let i = 0; i < 6; i++) { now += 100; fire(); await turn() }
  assert.equal(webCalls, 1, 'clear_web backs off for 1.8s after failure instead of spamming 6x/sec')

  // After 1.8s backoff elapses, retry runs cleanly and logs broken count.
  now += 1900
  fire()
  await turn()
  assert.equal(webCalls, 2, 'clear_web retries cleanly after backoff expires')
  assert.ok(!logs.some(l => l.includes('undefined')))
})
