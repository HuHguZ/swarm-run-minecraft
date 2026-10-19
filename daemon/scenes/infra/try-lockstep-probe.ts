// Farm clock probe for lockstep A/B (research/claude-1006/lockstep.md): listens to the daemon's clock pushes (every 5
// game ticks) and polls status once a wall second, without commands or skills. Runs beside any scene until killed or
// PROBE_SECONDS or until the file PROBE_STOP exists; writes PROBE_OUT (JSONL: one row per wall second, then a summary).
//   ND_WS=ws://127.0.0.1:88NN PROBE_OUT=farm/results/<tag>/probe.jsonl node try-lockstep-probe.js
// Row: physics share (status.physicsTicks / clock.ticks), effective TPS (confirmed server ticks / wall s), lag (serverTicks - ticks).
import fs from 'node:fs'
import { connect } from '../lib/scene-kit'

interface Clock { ticks: number; serverTicks: number | null; lagTicks: number | null; wallMs: number; tickRate: number; lockstep?: boolean }

async function main(): Promise<void> {
  const connection = connect(process.env.ND_WS, { followClock: false })
  await connection.ready
  const out = process.env.PROBE_OUT
  const write = (row: Record<string, unknown>) => {
    console.log(JSON.stringify(row))
    if (out) fs.appendFileSync(out, JSON.stringify(row) + '\n')
  }
  const lags: number[] = []
  let last: Clock | null = null
  let lagMaxAll = 0
  connection.ws.on('message', (raw: Buffer) => {
    const m = JSON.parse(raw.toString())
    if (m.type !== 'clock' || !m.clock) return
    last = m.clock
    if (typeof m.clock.lagTicks === 'number') { lags.push(m.clock.lagTicks); lagMaxAll = Math.max(lagMaxAll, m.clock.lagTicks) }
  })
  const status = async () => {
    const state = (await connection.call('status')).state
    return { at: Date.now(), physics: state.physicsTicks ?? 0, ticks: state.clock?.ticks ?? 0, server: state.clock?.serverTicks ?? 0 }
  }
  const first = await status()
  let prev = first
  const rows: { share: number; tps: number }[] = []
  const stopAt = Date.now() + Number(process.env.PROBE_SECONDS || 1e9) * 1000
  let stopping = false
  process.on('SIGINT', () => { stopping = true })
  process.stdin.on('end', () => { stopping = true })
  while (!stopping && Date.now() < stopAt && !(process.env.PROBE_STOP && fs.existsSync(process.env.PROBE_STOP))) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const now = await status().catch(() => null)
    if (!now) break
    const ticks = now.ticks - prev.ticks
    const row = { wall: (now.at - prev.at) / 1000, ticks, physics: now.physics - prev.physics, share: ticks > 0 ? round((now.physics - prev.physics) / ticks) : null,
      tps: round((now.server - prev.server) * 1000 / (now.at - prev.at)), lagMax: lags.length ? Math.max(...lags) : null, lockstep: !!(last as Clock | null)?.lockstep }
    rows.push({ share: row.share ?? 1, tps: row.tps })
    lags.length = 0
    write(row)
    prev = now
  }
  const ticks = prev.ticks - first.ticks
  const shares = rows.map(r => r.share).sort((a, b) => a - b)
  write({ summary: true, wallSeconds: round((prev.at - first.at) / 1000), ticks, share: ticks > 0 ? round((prev.physics - first.physics) / ticks) : null,
    shareP10: shares[Math.floor(shares.length * .1)] ?? null, shareMin: shares[0] ?? null,
    tps: round((prev.server - first.server) * 1000 / Math.max(1, prev.at - first.at)), lagMax: lagMaxAll })
  connection.close()
}
const round = (x: number) => Math.round(x * 100) / 100
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1 })
