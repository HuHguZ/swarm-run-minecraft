import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Vec3 } from 'vec3'

test('shaft exit retains the tower controller rather than the foxhole jump controller', async () => {
  const file = join(__dirname, '../src/pearls.js')
  const load = createRequire(file)
  const bot = { entity: { position: new Vec3(2, 40, 3) } }
  const ctl = { aborted: false }
  const calls: unknown[] = []
  const context = { module: { exports: {} as any }, process, console,
    require: (name: string) => name === './build' ? { towerUp: async (body: typeof bot, control: typeof ctl, count: number) => {
      calls.push([control, count]); body.entity.position = body.entity.position.offset(0, count, 0)
      return { placed: count }
    } } : load(name) }
  runInNewContext(readFileSync(file, 'utf8') + '\nmodule.exports.shaftExit = climbOut', context)
  const result = await context.module.exports.shaftExit(bot, ctl, { shaft: bot.entity.position.clone(), stand: bot.entity.position.offset(2, 0, 0), top: new Vec3(2, 46, 3) })
  assert.equal(result.ok, true)
  assert.equal(result.placed, 6)
  assert.deepEqual(calls, [[ctl, 6]])
})
