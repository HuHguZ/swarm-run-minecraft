import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { REPO_ROOT } from '../daemon/src/paths'

test('adversary survival mode preserves native gravity before first creative flight and restores it afterwards', async () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'farm/arena/adversary.ts'), 'utf8')
  const fn = source.match(/async function setMode \(m: string\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(fn, 'exercise the actual standalone adversary mode function without connecting its client')
  const { transformSync } = require('esbuild')
  const registry = require(path.join(REPO_ROOT, 'daemon/node_modules/minecraft-data'))('1.21.11')
  const bot: any = { registry, physics: { gravity: .08 }, game: { gameMode: 'survival' } }
  require(path.join(REPO_ROOT, 'daemon/node_modules/mineflayer/lib/plugins/creative'))(bot)
  const sandbox: any = { bot, NAME: 'Champ', cmd: async (command: string) => { bot.game.gameMode = command.split(' ')[1] }, sleep: async () => {} }
  vm.runInNewContext(transformSync(fn, { loader: 'ts', target: 'node22' }).code + '\nthis.setMode = setMode', sandbox)
  await sandbox.setMode('survival')
  assert.equal(bot.physics.gravity, .08)
  bot.creative.startFlying()
  assert.equal(bot.physics.gravity, 0)
  await sandbox.setMode('survival')
  assert.equal(bot.physics.gravity, .08)
})
