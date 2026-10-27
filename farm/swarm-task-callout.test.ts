import test from 'node:test'
import assert from 'node:assert/strict'
import { createDriverState } from './swarm/swarm-driver/state'
import { swarmTeam } from './swarm/swarm-driver/team'
import { installSight } from './arena/watch'
import { installRadio } from './arena/radio'
import { EventEmitter } from 'node:events'
import { EventBus } from '../daemon/src/events'

function chatClient() {
  const registry = require('../daemon/node_modules/prismarine-registry')('1.21.11')
  const bot: any = new EventEmitter(), bus = new EventBus(), parsed: any[] = [], received: string[] = []
  let writes = 0
  bot.username = 'NeuroFarm31'; bot.registry = registry; bot._client = new EventEmitter()
  bot.supportFeature = feature => registry.supportFeature(feature)
  bot._client.write = bot._client.chat = () => { writes++ }
  require('../daemon/node_modules/mineflayer/lib/plugins/chat')(bot, {})
  bot.on('messagestr', text => received.push(text))
  bot.on('chat', (from, text, translate) => {
    parsed.push({ from, text })
    if (from !== bot.username && translate !== 'chat.type.admin') bus.emit('chat', { from, text })
  })
  const ChatMessage = require('../daemon/node_modules/prismarine-chat')(registry)
  const system = component => bot._client.emit('systemChat', { positionId: 1,
    formattedMessage: { type: 'string', value: new ChatMessage(component).toString() } })
  return { bus, parsed, received, system, writes: () => writes }
}

function voice(enabled = true) {
  let at = 6000
  const lines: string[] = [], messages: string[] = []
  const sw = createDriverState({ bots: [], pos: {}, alive: () => true, log: line => lines.push(line), now: () => at,
    announce: enabled ? text => { messages.push(text) } : null })
  const handler = swarmTeam(sw), b: any = { name: 'A', team: 'blue' }
  const accept = (target = 'Foe', cover?: string, kind = 'fight') => {
    const task = { kind, data: { target, ...(cover ? { cover } : {}) } }
    b.swarmTask = task
    handler.say(b, task)
  }
  return { lines, messages, accept, advance: (ms: number) => { at += ms } }
}

test('accepted focus task logs its actor and target once without game chat or claiming arrival', () => {
  const f = voice()
  f.accept()
  assert.equal(f.messages.length, 0)
  const intent = f.lines.find(line => /иду/.test(line)) || ''
  assert.match(intent, /A.*Foe/)
  assert.doesNotMatch(intent, /пришёл|добрался|помог|прибыл/)
  f.advance(10000); f.accept()
  assert.equal(f.messages.length, 0)
  assert.equal(f.lines.length, 2, 'repeated task does not create another internal callout')
})

test('changing only the accepted cover recipient updates the internal log without game chat', () => {
  const f = voice()
  f.accept('Foe', 'Hurt1')
  assert.equal(f.messages.length, 0)
  assert.match(f.lines[1], /прикрыть Hurt1/)
  assert.match(f.lines[0], /Hurt1/)
  f.advance(5000); f.accept('Foe', 'Hurt2')
  assert.equal(f.messages.length, 0)
  assert.equal(f.lines.length, 4)
  assert.match(f.lines[3], /прикрыть Hurt2/)
  assert.match(f.lines[2], /Hurt2/)
})

test('every changed target stays in the internal log while game chat stays silent', () => {
  const f = voice()
  f.accept('Foe1'); f.advance(4999); f.accept('Foe2')
  assert.equal(f.messages.length, 0)
  assert.equal(f.lines.length, 4)
  f.advance(1); f.accept('Foe3', undefined, 'goto')
  assert.equal(f.messages.length, 0)
  assert.match(f.lines[5], /Foe3/)
  f.accept('Foe4', undefined, 'flee')
  assert.equal(f.messages.length, 0)
  assert.equal(f.lines.length, 7, 'retreat is not logged as advancing on a target')
})

test('without an announce sink tasks keep their logs and stay silent', () => {
  const f = voice(false)
  f.accept('Foe', 'Hurt')
  assert.equal(f.messages.length, 0)
  assert.match(f.lines[0], /Hurt/)
})

test('native 1.21.11 team tellraw never becomes a player-chat interrupt', () => {
  const f = voice(), client = chatClient()
  f.accept('Foe', 'Hurt')
  assert.deepEqual(f.messages, [], 'individual coordination remains internal')
  client.system([{ text: '[рой] ' }, { text: 'приём: загон' }])
  assert.equal(client.received.length, 1)
  assert.match(client.received[0], /приём: загон/)
  assert.deepEqual(client.parsed, [])
  assert.equal(client.bus.pending(), null)
  assert.equal(client.writes(), 0)
})

test('native radio tellraw stays system text while actual player chat still interrupts', t => {
  const before = process.env.ARMS_CHAT
  process.env.ARMS_CHAT = '1'
  t.after(() => { if (before === undefined) delete process.env.ARMS_CHAT; else process.env.ARMS_CHAT = before })
  t.mock.method(globalThis, 'setInterval', () => 0 as any)
  const commands: string[] = [], lines: string[] = [], client = chatClient()
  const ctx: any = { i: 31, teams: true, bots: [], pos: {}, deadNow: new Set(), out: new Set(), radio: {},
    log: text => lines.push(text), rcon: async (_i, command) => { commands.push(command) } }
  installRadio(ctx)
  ctx.radioSay({ name: 'NeuroFarm31c', team: 'blue' }, 'прикройте! на меня 31x')
  assert.equal(lines.length, 1)
  assert.equal(commands.length, 1)
  client.system(JSON.parse(commands[0].replace(/^tellraw @a /, '')))
  assert.equal(client.received.length, 1)
  assert.match(client.received[0], /NeuroFarm31c.*прикройте/)
  assert.deepEqual(client.parsed, [])
  assert.equal(client.bus.pending(), null)
  client.system({ text: '<Human> help' })
  assert.equal(client.parsed.length, 1, 'the installed legacy player-chat parser remains active')
  assert.equal(client.bus.pending()?.type, 'chat')
  assert.equal(client.bus.pending(['death', 'kicked', 'disconnected']), null, 'allowPlayer fights ignore chat')
  assert.equal(client.writes(), 0)
})

for (const chat of ['0', '1']) test(`real arena factory keeps accepted tasks internal with ARMS_CHAT=${chat}`, async t => {
  const before = process.env.ARMS_CHAT
  process.env.ARMS_CHAT = chat
  t.after(() => { if (before === undefined) delete process.env.ARMS_CHAT; else process.env.ARMS_CHAT = before })
  let now = 6000
  t.mock.method(Date, 'now', () => now)
  const calls: any[] = [], messages: string[] = []
  const b: any = { name: 'A', team: 'blue', c: { async call(method, params) {
    calls.push({ method, params })
    return { status: 'done', detail: method === 'fight' ? { landed: 1, swings: 1 } : {} }
  } } }
  const ctx: any = { i: 31, arms: false, bots: [b], names: ['A'], pos: { A: { p: { x: 0, y: 64, z: 0 }, hp: 20,
    inv: { iron_sword: 1 }, armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' } } },
    humans: {}, X: 0, Y: 64, Z: 0, R: 50, perches: [], deathAt: {}, deadNow: new Set(), out: new Set(),
    alive: () => true, hostile: () => true, home: () => '0 0', log() {}, rcon: async (_slot, command) => { messages.push(command) } }
  installSight(ctx)
  ctx.swarmDriver.observe(b, [{ id: 'Foe', visible: true, position: { x: 2.8, y: 64, z: 0 }, equipment: { weapon: 'wooden_sword' } }])
  assert.equal(messages.filter(m => m.includes('A:') || m.includes('A —')).length, 0, 'an observation is not an accepted task')
  await ctx.swarmDriver.turn(b)
  assert.equal(b.swarmTask.data.target, 'Foe')
  now += 9000
  ctx.swarmDriver.observe(b, [{ id: 'Foe2', visible: true, position: { x: 2.8, y: 64, z: 0 }, equipment: { weapon: 'wooden_sword' } }])
  assert.equal(messages.filter(m => m.includes('A:') || m.includes('A —')).length, 0, 'the initial doctrine announcement shares the same throttle')
  await ctx.swarmDriver.turn(b)
  assert.equal(b.swarmTask.data.target, 'Foe2')
  const accepted = messages.filter(m => m.includes('A:') || m.includes('A —'))
  assert.equal(accepted.length, 0)
  assert.ok(calls.some(c => c.method === 'fight'), 'the real driver executed its accepted fight')
  assert.ok(calls.every(c => c.method !== 'say'), 'voice never becomes interrupting player chat')
})

test('a 600-second 30-bot model round limits actual team tellraw to one per 20 seconds', async t => {
  const chat = process.env.ARMS_CHAT, doctrine = process.env.SWARM_DOCTRINE
  process.env.ARMS_CHAT = '1'
  t.after(() => {
    if (chat === undefined) delete process.env.ARMS_CHAT; else process.env.ARMS_CHAT = chat
    if (doctrine === undefined) delete process.env.SWARM_DOCTRINE; else process.env.SWARM_DOCTRINE = doctrine
  })
  let now = 30000
  t.mock.method(Date, 'now', () => now)
  const commands: Array<{ at: number; command: string }> = [], lines: string[] = []
  const bots = Array.from({ length: 30 }, (_, k) => ({ name: `Bot${k}`, team: 'blue', c: { async call (method: string) {
    return { status: 'done', detail: method === 'fight' ? { landed: 1, swings: 1 } : {} }
  } } }))
  const pos = Object.fromEntries(bots.map(b => [b.name, { p: { x: 0, y: 64, z: 0 }, hp: 20,
    inv: { iron_sword: 1 }, armor: { head: 'iron_helmet', torso: 'iron_chestplate', legs: 'iron_leggings', feet: 'iron_boots' } }]))
  const ctx: any = { i: 31, arms: false, bots, names: bots.map(b => b.name), pos,
    humans: {}, X: 0, Y: 64, Z: 0, R: 50, perches: [], deathAt: {}, deadNow: new Set(), out: new Set(),
    alive: () => true, hostile: () => true, home: () => '0 0', log: line => lines.push(line),
    rcon: async (_slot, command) => { commands.push({ at: now, command }) } }
  const factory: typeof import('./swarm/swarm-driver') = require('./swarm/swarm-driver')
  const create = factory.createSwarmDriver
  let teamEvent!: (text: string, color: string) => any
  t.mock.method(factory, 'createSwarmDriver', opts => { teamEvent = opts.announce; return create(opts) })
  installSight(ctx)
  for (let second = 0; second < 600; second++) {
    now = 30000 + second * 1000
    process.env.SWARM_DOCTRINE = second % 2 ? 'hunt' : 'buffalo'
    const b = bots[second % bots.length]
    ctx.swarmDriver.observe(b, [{ id: 'Foe', visible: true, position: { x: 2.8, y: 64, z: 0 }, equipment: { weapon: 'wooden_sword' } }])
    await ctx.swarmDriver.turn(b)
    // Exercise bursts at the actual arena adapter, including formerly unthrottled assault notices.
    teamEvent('🧭 приём: загон', 'aqua')
    teamEvent('☢ ШТУРМ на Foe!', 'red')
  }
  t.diagnostic(JSON.stringify({ seconds: 600, bots: bots.length, tellraw: commands.length,
    acceptedFocusLogs: lines.filter(line => /Bot\d+.*Foe.*иду/.test(line)).length }))
  assert.ok(commands.length >= 2, 'team events still reach the game chat')
  assert.ok(commands.length <= 30, `600 seconds permits at most 30 messages, got ${commands.length}`)
  for (let k = 1; k < commands.length; k++) assert.ok(commands[k].at - commands[k - 1].at >= 20000)
  assert.ok(commands.every(({ command }) => /^tellraw @a /.test(command)))
  assert.ok(commands.every(({ command }) => !/Bot\d+ —|; иду/.test(command)), 'no per-bot coordination reaches tellraw')
  assert.ok(lines.some(line => /Bot\d+.*Foe.*иду/.test(line)), 'accepted focus remains explicit in the internal journal')
})
