import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { cjsContext } from './cjs-context'

// Run the actual round setup and admission; only its external RPC/RCON and
// clocks are scripted. No server, scene bootstrap, build or fight is started.
const source = readFileSync(join(__dirname, '../arena/arms-run.js'), 'utf8')
const span = (from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a)
  assert(a >= 0 && b > a)
  return source.slice(a, b)
}
const body = span('async function resetPlayer(', 'function knownAreas(') +
  span('function freshStats(', 'class ArmsEnv {') +
  span('async function ensureConnected(', 'async function main(')

function fixture({ delayedDamage = false, broken = null }: any = {}) {
  let now = 0, damageAt = Infinity, damaged = false
  const admitted: any[] = [], calls: any[] = []
  const states = new Map()
  const sides = ['A', 'B'].map(name => {
    states.set(name, { connected: true, health: 20, food: 20, inventory: {}, armor: {}, offHand: null,
      pos: { x: 0, y: 120, z: 0 }, lastDeathAt: null })
    return { name, async call(method, params) {
      calls.push({ at: now, method, name, params })
      if (method === 'status') {
        const state = JSON.parse(JSON.stringify(states.get(name)))
        // The real status header rounds HP and floors F3 coordinates.
        state.health = Math.round(state.health)
        state.pos = Object.fromEntries(Object.entries(state.pos).map(([axis, value]) => [axis, Math.floor(Number(value))]))
        return { state }
      }
      if (['stop', 'temper', 'connect', 'auto_loot'].includes(method)) return { status: 'done' }
      throw new Error(`unexpected RPC ${method}`)
    } }
  })
  const advance = async ms => {
    now += ms
    if (delayedDamage && !damaged && now >= damageAt) { states.get('B').health = 18; damaged = true }
  }
  const cmd = async text => {
    calls.push({ at: now, command: text })
    const probe = text.match(/^execute if entity @a\[name=(A|B),nbt=\{Health:20\.0f,foodLevel:20\}\]$/)
    if (probe) { const s = states.get(probe[1]); return s.health === 20 && s.food === 20 ? 'Test passed, count: 1' : 'Test failed' }
    const words = text.split(' '), name = words[0] === 'effect' ? words[2] : words[1]
    const state = states.get(name)
    if (state && text.startsWith('clear ')) { state.inventory = {}; state.armor = {}; state.offHand = null }
    if (state && text.includes('minecraft:instant_health')) state.health = 20
    if (state && text.includes('minecraft:saturation')) state.food = 20
    if (state && text.startsWith('tp ')) {
      state.pos = { x: Number(words[2]), y: Number(words[3]), z: Number(words[4]) }
      if (name === 'B' && delayedDamage && !damaged) damageAt = Math.min(damageAt, now + 1000)
    }
    // A server/client receipt that stays invalid despite preparation must fail
    // the round, not silently exhaust retries and launch the brains.
    if (state && name === 'B' && broken) {
      if (broken === 'health') state.health = 18
      if (broken === 'fractional health') state.health = 19.75
      if (broken === 'food') state.food = 17
      if (broken === 'height') state.pos.y = 125
      if (broken === 'inventory') state.inventory = { bread: 1 }
      if (broken === 'armor') state.armor = { head: 'iron_helmet' }
      if (broken === 'offHand') state.offHand = 'shield'
    }
    return 'ok'
  }
  const context = { cmd, W: p => ({ x: 2000 + p.x, y: 120 + p.y, z: 2000 + p.z }),
    L: { spawns: [{ x: -10, y: 0, z: 0, yaw: -90 }, { x: 10, y: 0, z: 0, yaw: 90 }], y1: 12 },
    X: 2000, Y: 120, Z: 2000, PREP_RATE: 20, FIGHT_RATE: 20, MAX_MS: 600000, SEED: 'fixture', OUT: null,
    sleep: advance, gameClock: { now: () => now, snapshot: () => ({ ticks: now / 50 }), wall: { now: () => now, sleep: advance } },
    build: async () => ({ bad: 0 }), log() {}, knownAreas: () => [],
    brain: async (side, round) => { admitted.push({ name: side.name, ...side.stats.inv0 }); round.over = true },
    pace: advance }
  const runRound = runInNewContext(body + '\nrunRound', cjsContext(context))
  return { calls, admitted, run: () => runRound(1, sides[0], sides[1]) }
}

test('a delayed setup HP drop is repaired before either Arms brain starts', async () => {
  const f = fixture({ delayedDamage: true })
  await f.run()
  assert.equal(f.admitted.length, 2)
  assert.deepEqual(f.admitted.map(s => s.hp), [20, 20], 'native C1 admitted the west side with HP18')
  assert.deepEqual(f.admitted.map(s => s.food), [20, 20])
})

for (const broken of ['health', 'fractional health', 'food', 'height', 'inventory', 'armor', 'offHand']) {
  test(`Arms never admits an unrepaired ${broken} start after bounded setup retries`, async () => {
    const f = fixture({ broken })
    await assert.rejects(f.run(), /start|старт|подготов/i)
    assert.equal(f.admitted.length, 0, 'neither side may begin an unequal round')
  })
}

test('a healthy empty pair starts on its assigned sides without another reset', async () => {
  const f = fixture()
  await f.run()
  assert.equal(f.admitted.length, 2)
  assert.deepEqual(f.admitted.map(s => s.hp), [20, 20])
  assert.deepEqual(f.admitted.map(s => s.pos.x), [2010, 1990])
  assert.equal(f.calls.filter(c => c.command?.startsWith('tp ')).length, 2)
})
