// Подъём на лодке против столба и ступеней pathfinder'а (14.10, просьба пользователя: «наверху — либо лесенка, либо
// телепортация»). Лестница из ступеней по 2 бл. (высота HEIGHT), тело у подножия; заходы по ARMS:
//   boat   — boat_climb (лодка на грань ступени в прыжке, посадка, высадка, лодку назад), до верха;
//   goto   — goto к верхней ступени (pathfinder: прыжки, столб, копка — как решит сам);
//   pillar — tunnel up на HEIGHT (столб на месте).
//   node farm/farm.js run try-lab-boat-climb.js --slots 1 --tag bc-6 HEIGHT=6 REPEAT=3 ARMS=boat,goto,pillar
// Строка на заход: игровые секунды, дошёл ли до высоты, хп, урон, блоков потрачено, лодка вернулась.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
const { connect, createKit } = require('./scene-kit')

async function main (): Promise<void> {
  const slot = Number(process.env.FARM_SLOT)
  assert.ok(Number.isInteger(slot) && slot >= 1 && slot <= 32, 'boat climb: farm slot')
  const connection = connect(process.env.ND_WS); await connection.ready
  const player = process.env.MC_USERNAME
  const kit = createKit({ call: connection.call, heard: connection.heard, logFile: process.env.ND_SERVER_LOG, player })
  void execFileSync; void path
  const status = async () => connection.call('status', { physics: true })
  const dim = process.env.DIM === 'nether' ? 'the_nether' : 'overworld'
  const rock = dim === 'the_nether' ? 'netherrack' : 'stone'
  const X0 = 4400; const Z0 = 3800; const FLOOR = 140; const H = Math.max(2, Number(process.env.HEIGHT || 6))
  const N = Math.ceil(H / 2) // ступени по 2 бл., проступь 2
  const start = [X0 + .5, FLOOR, Z0 + .5]
  const box = (a: number[], b: number[], block: string) => kit.fillExact(dim, [a, b], block)
  const count = (inv: Record<string, number>, re: RegExp) => Object.entries(inv || {}).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + (v as number), 0)
  async function build (): Promise<void> {
    await box([X0 - 6, FLOOR - 3, Z0 - 6], [X0 + 2 * N + 8, FLOOR + 2 * N + 8, Z0 + 6], 'air')
    await box([X0 - 6, FLOOR - 3, Z0 - 6], [X0 + 2 * N + 8, FLOOR - 1, Z0 + 6], rock)
    // Ступень k (1..N): x ≥ X0 + 2k − 1 (проступь 2 — лодке 1.375 в ширину нужен простор над гранью), верх — FLOOR + 2k.
    for (let k = 1; k <= N; k++) await box([X0 + 2 * k - 1, FLOOR, Z0 - 2], [X0 + 2 * N + 4, FLOOR + Math.min(2 * k, H) - 1, Z0 + 2], rock)
  }
  try {
    await connection.call('connect')
    await connection.call('stop'); await connection.call('play_mode', { mode: 'free' })
    await kit.cmd('/gamemode creative'); await kit.ensureWorld(dim, { tp: start.join(' ') })
    await kit.cmd('/gamerule spawn_mobs false'); await kit.cmd('/gamerule advance_time false'); await kit.cmd('/time set 6000')
    const repeat = Math.max(1, Number(process.env.REPEAT ?? 3))
    const arms = (process.env.ARMS || 'boat,goto,pillar').split(',')
    for (let trial = 0; trial < repeat * arms.length; trial++) {
      const arm = arms[trial % arms.length]
      await connection.call('stop'); await kit.cmd('/gamemode creative')
      await kit.ensureWorld(dim, { tp: start.join(' ') })
      await build()
      await kit.cmd('/kill @e[type=!player,distance=..64]')
      await kit.cmd(`/execute in minecraft:${dim} run tp @s ${start.join(' ')} -90 0`)
      await kit.cmd('/clear @s')
      await kit.cmd('/give @s oak_boat 1'); await kit.cmd('/give @s stone_axe 1'); await kit.cmd(`/give @s ${dim === 'the_nether' ? 'netherrack' : 'cobblestone'} 64`)
      await kit.cmd('/gamemode survival'); await kit.cmd('/effect give @s minecraft:instant_health 1 5 true'); await connection.call('wait', { seconds: 1 })
      const before = await status(); const wall0 = Date.now()
      const top = { x: X0 + 2 * N, y: FLOOR + H, z: Z0 }
      const reply = arm === 'boat' ? await connection.call('boat_climb', { toward: { x: X0 + 2 * N + 3, z: Z0 }, goalY: FLOOR + H, timeoutSeconds: 60 })
        : arm === 'goto' ? await connection.call('goto', { x: top.x, y: top.y, z: top.z, range: 0, timeoutSeconds: 90 })
          : await connection.call('tunnel', { direction: 'up', length: H, timeoutSeconds: 90 })
      const wallMs = Date.now() - wall0
      await connection.call('wait', { seconds: 1 })
      const after = await status()
      const ticks = (after.state.clock?.ticks ?? NaN) - (before.state.clock?.ticks ?? NaN)
      const y = after.detail.physics?.pos?.y ?? after.state.pos?.y
      const inv0 = before.state.inventory || {}; const inv1 = after.state.inventory || {}
      const blocks = count(inv0, /^(cobblestone|netherrack)$/) - count(inv1, /^(cobblestone|netherrack)$/)
      const row = { slot, trial, arm, height: H, dim, status: reply.status, seconds: ticks / 20, wallMs, reached: Number.isFinite(y) && y >= FLOOR + H - .2, y,
        hp: after.state.health, hpLost: 20 - after.state.health, blocks, boats: count(inv1, /_boat$/), detail: reply.detail && (reply.detail.steps ? { steps: reply.detail.steps.map((s: any) => ({ ok: s.ok, why: s.why, gained: s.gained, sec: s.sec, boatBack: s.boatBack })), why: reply.detail.why } : reply.detail.stopped || reply.detail.note || null), error: reply.error || null }
      console.log(JSON.stringify(row)); if (process.env.LAB_OUT) fs.appendFileSync(process.env.LAB_OUT, JSON.stringify(row) + '\n')
    }
  } finally {
    try { await connection.call('stop') } catch {}
    connection.close()
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1) })
