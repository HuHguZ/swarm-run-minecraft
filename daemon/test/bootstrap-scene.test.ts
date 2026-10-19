import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { cjsContext } from './cjs-context'

function sceneFixture(name: 'try-lab-fresh' | 'try-lab-ne-run', kitName: string) {
  const calls: any[] = [], commands: any[] = []
  let paused = false, now = 100000, inventory = 0, naturalChest = 33
  const measured = new Error('measurement boundary')
  const state = { dimension: 'overworld', health: 20, food: 20, pos: { x: 0, y: 64, z: 0 }, tactics: { threatLevel: 0 }, inventory: {}, clock: { serverTicks: 100 } }
  const call = async (method, params: any = {}) => {
    calls.push({ method, params }); now += 50
    if (method === 'connect') {
      if (params.bootstrapPaused !== undefined) paused = params.bootstrapPaused
      if (!paused && naturalChest) { inventory += naturalChest; naturalChest = 0 }
      if (name === 'try-lab-ne-run' && params.bootstrapPaused === false) throw measured
    }
    return { status: 'done', state, detail: { lit: true, physics: { onGround: true }, pickLeft: 100 } }
  }
  const command = async text => {
    commands.push({ text, paused }); now += 50
    if (/^\/(clear|give|effect)\b/.test(text)) assert.equal(paused, true, `${text} must run before autonomous resource use`)
    if (text === '/clear @s') inventory = 0
    if (text.startsWith('/give ')) inventory++
    return { ok: true }
  }
  const kit = { cmd: command, must: command, gamerule: async () => {}, setDifficulty: async () => {}, randomReset: async () => 1, ensureWorld: async () => {} }
  const clock = { now: () => now, wall: { now: () => now, sleep: async ms => { now += ms } } }
  const environment = { KIT: kitName, UNTIL: 'dragon', MINUTES: '1', LAB_OUT: 'fixture.jsonl', FARM_SLOT: '21' }
  const stage = { 'try-lab-fresh': 'ow', 'try-lab-ne-run': 'nether' }[name]
  const source = path.resolve(process.env.ND_BOOT_SCENE_SOURCE || path.join(__dirname, '..'), 'scenes', stage, `${name}.js`)
  const body = fs.readFileSync(source, 'utf8')
  const context: any = { module: { exports: {} }, __dirname: path.dirname(source), console: { log() {}, error() {} }, process: { env: environment, execPath: process.execPath, exit() {} }, require(id) {
    if (id === '../../src/game-clock') return clock
    if (id === '../lib/farm-bootstrap') return { farmBootstrap: async rpc => rpc('connect', { bootstrapPaused: true }) }
    if (id === '../lib/scene-kit') return { connect: () => ({ ready: Promise.resolve(), call, heard: [] }), createKit: () => kit, sleep: async ms => { now += ms } }
    if (id === '../lib/scene-nether-entry') return { prepareOverworldEntry: async () => state.pos, cleanupPreparationThreats: async () => [], confirmSurvivalReadiness: async port => { await port.sample(); return {} } }
    if (id === '../../src/campaign/nether-supply') return { netherToolsReady: () => true }
    if (id === '../../src/campaign/nether-progress') return {}
    if (id === '../../src/route') return { mapLevel: () => 'blind' }
    if (id === 'child_process') return { spawn: () => { throw measured }, execFileSync: () => '20.0f' }
    if (id === 'fs') return { statSync: () => ({ size: 0 }), writeFileSync() {}, readFileSync: () => 'level-seed=1' }
    if (id === 'path') return path
    if (id === '../../src/paths') return (require('../src/paths') as typeof import('../src/paths'))
    throw new Error(`Unexpected scene dependency ${id}`)
  } }
  vm.runInNewContext(body.slice(0, body.lastIndexOf('main().catch')) + '\nmodule.exports = { main };', cjsContext(context), { filename: source })
  return { main: context.module.exports.main, measured, calls, commands, receipt: () => ({ inventory, naturalChest }) }
}

for (const kit of ['', 'iron_pickaxe;bread 8']) test(`fresh ${kit ? 'stage KIT' : 'empty RSG'} pauses before handshake and releases after its final clear/give`, async () => {
  const f = sceneFixture('try-lab-fresh', kit)
  await assert.rejects(f.main(), error => error === f.measured)
  const connects = f.calls.filter(c => c.method === 'connect')
  assert.deepEqual(connects.map(c => c.params.bootstrapPaused), [true, false])
  assert.equal(f.receipt().inventory, 33 + (kit ? 2 : 0))
})

test('Nether post KIT keeps bootstrap paused through every destructive setup command and releases before entry', async () => {
  const f = sceneFixture('try-lab-ne-run', 'post')
  await assert.rejects(f.main(), error => error === f.measured)
  assert.deepEqual(f.calls.filter(c => c.method === 'connect').map(c => c.params.bootstrapPaused), [true, false])
  assert.ok(f.commands.some(c => c.text.startsWith('/give @s minecraft:potion')))
  assert.ok(f.commands.some(c => c.text === '/clear @s minecraft:obsidian'))
  assert.equal(f.commands.at(-1).text, '/clear @s minecraft:obsidian')
})
