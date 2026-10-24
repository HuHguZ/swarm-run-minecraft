'use strict'
import test = require('node:test')
import assert = require('node:assert/strict')
import * as fs from 'node:fs'
import path = require('node:path')
import * as gameClock from '../src/game-clock'
import { EventBus } from '../src/events'
import { Session } from '../src/session'

// Модули, где бюджеты — только игровые часы: сам src/<имя>.js и вся его папка тела src/<имя>/** — части, на которые
// модуль разделён, проверяются без правки списка. «фасад:папка» — тело живёт не в папке с именем фасада (index → rpc/).
const GAME_TIME_MODULES = ['dragon', 'clutch', 'blockmoves', 'edges', 'pvp', 'combat', 'movement', 'bastion', 'nether', 'actions', 'crystal',
  'mining', 'containers', 'architect', 'structures', 'index:rpc']
// Файлы тел, где стеночные часы по делу (путь от src/): метка «клещей» между ботами команды живёт в реальном времени
// (ставит team-assist, читает aerial-lance), срок свежести снимка партнёра по ветру (team-wind: снимок приходит по RPC из
// другого демона, свои игровые часы там не общие), журнал комбо fight-graph — отметки для разбора, не бюджет; templateFit
// (structures/templates) меряет время процессора.
const WALL_CLOCK_ALLOWED = ['combat/aerial-lance.js', 'combat/team-wind.js', 'pvp/team-assist.js', 'pvp/fight-graph.js', 'structures/templates.js']

function gameTimeFiles (): string[] {
  const src = path.join(__dirname, '../src')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) files.push(full)
    }
  }
  for (const entry of GAME_TIME_MODULES) {
    const [name, body = name] = entry.split(':')
    files.push(path.join(src, name + '.js'))
    if (fs.existsSync(path.join(src, body))) walk(path.join(src, body))
  }
  return [...new Set(files)].filter(file => !WALL_CLOCK_ALLOWED.includes(path.relative(src, file).split(path.sep).join('/')))
}

test('dragon, MLG, combat, navigation and intent budgets have no implicit wall clocks', () => {
  const src = path.join(__dirname, '../src')
  for (const allowed of WALL_CLOCK_ALLOWED) assert.ok(fs.existsSync(path.join(src, allowed)), `исключение ${allowed} устарело — файла нет`)
  const files = gameTimeFiles()
  assert.ok(files.length > GAME_TIME_MODULES.length, 'папки тел просканированы')
  for (const file of files) {
    const name = path.relative(src, file)
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /Date\.now\b/, name)
    assert.doesNotMatch(source, /(?<![\w.])(?:setTimeout|setInterval)\s*\(/, name)
  }
})

test('intent timeout follows ticks and disconnect grace returns even in a frozen world', async () => {
  const c = gameClock.activate(new gameClock.GameClock({ manual: true }))
  const bus = new EventBus()
  const s = new Session({} as Record<string, any>, bus, { state: {} as Record<string, any>, append () {} })
  s.state = () => ({ connected: true, clock: c.snapshot() })
  const started = s.runIntent('test_clock', () => new Promise<void>(() => {}), { timeoutMs: 150, interruptible: false })
  c.advanceTicks(2)
  let settled = false
  started.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  c.advanceTicks(1)
  c.setState({ is_frozen: true })
  const r = await started
  assert.equal(r.status, 'timeout')
  c.dispose()
})

test('session background timers resume on a new clock after reconnect', () => {
  const loot: typeof import('../src/lootclock') = require('../src/lootclock')
  const structures: typeof import('../src/structures') = require('../src/structures')
  const death = { pos: { x: 0, z: 0 }, dimension: 'overworld', ticking: 0 }
  const session: any = { bot: { entity: { position: { x: 0, z: 0 } }, game: { dimension: 'overworld' } },
    journal: { state: { deaths: [death] } }, structuresAuto: false }
  const first = gameClock.activate(new gameClock.GameClock({ manual: true }))
  loot.install(session); structures.install(session)
  first.advanceTicks(20)
  assert.equal(death.ticking, 1)
  first.dispose()
  const second = gameClock.activate(new gameClock.GameClock({ manual: true }))
  try {
    loot.install(session); structures.install(session)
    assert.equal(session._lootclock.clock, second)
    assert.equal(session._structuresTimer.clock, second)
    second.advanceTicks(20)
    assert.equal(death.ticking, 2)
  } finally { second.dispose(); gameClock.activate(null) }
})

test('stop before a wait worker starts settles while the world is frozen', async () => {
  const c = gameClock.activate(new gameClock.GameClock({ manual: true }))
  c.setState({ is_frozen: true })
  const s = new Session({} as Record<string, any>, new EventBus(), { state: {} as Record<string, any>, append () {} })
  s.state = () => ({ connected: true, clock: c.snapshot() })
  try {
    const waiting = s.wait({ seconds: 1 })
    await s.stop()
    const result = await waiting
    assert.equal(result.status, 'interrupted')
    assert.match(result.error, /прервано ещё до начала/)
    assert.equal(s.current, null)
    assert.equal(c.timers.size, 0)
    assert.equal(c.ticks, 0)
  } finally { c.dispose(); gameClock.activate(null) }
})

test('stop settles an already running noncooperative worker without game ticks', async () => {
  const c = gameClock.activate(new gameClock.GameClock({ manual: true }))
  c.setState({ is_frozen: true })
  const s = new Session({} as Record<string, any>, new EventBus(), { state: {} as Record<string, any>, append () {} })
  s.state = () => ({ connected: true, clock: c.snapshot() })
  try {
    const running = s.runIntent('test_stop', () => new Promise<void>(() => {}))
    await new Promise<any>(resolve => setImmediate(resolve))
    await s.stop()
    const result = await running
    assert.equal(result.status, 'interrupted')
    assert.equal(result.by.type, 'cancelled')
    assert.equal(s.current, null)
    assert.equal(c.timers.size, 0)
  } finally { c.dispose(); gameClock.activate(null) }
})

test('drop retry resumes after its disconnected clock was disposed', () => {
  const s = new Session({} as Record<string, any>, new EventBus(), { state: {} as Record<string, any>, append () {} })
  let retries = 0
  s.refreshDrop = () => { retries++ }
  const first = gameClock.activate(new gameClock.GameClock({ manual: true }))
  s.dropRetry(50)
  first.dispose()
  const second = gameClock.activate(new gameClock.GameClock({ manual: true }))
  try {
    s.dropRetry(50)
    second.advanceTicks(1)
    assert.equal(retries, 1)
  } finally { second.dispose(); gameClock.activate(null) }
})
