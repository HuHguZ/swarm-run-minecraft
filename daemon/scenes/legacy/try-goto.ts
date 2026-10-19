'use strict'
import * as gameClock from '../../src/game-clock'
// Focused repro: walk a few short hops and report how each one resolved.
import WebSocket = require('ws')

const ws = new WebSocket(process.env.ND_WS || 'ws://127.0.0.1:8765')
let id = 0
const pending = new Map()
const call = (method, params: any = {} as Record<string, any>) => new Promise<any>((resolve, reject) => {
  const rid = ++id
  pending.set(rid, { resolve, reject })
  ws.send(JSON.stringify({ id: rid, method, params }))
})

ws.on('message', raw => {
  const m = JSON.parse(raw.toString()); gameClock.follow(m.clock || m.result?.state?.clock || m.result?.clock)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.ok ? p.resolve(m.result) : p.reject(new Error(m.error))
})

// Each hop: [dx, dz, useY]. useY=false exercises the "just get to that column"
// path, which is how overland travel actually gets requested.
const HOPS = [[0, 6, false], [6, 0, false], [0, -6, false], [-6, 0, false], [0, 6, true], [4, 4, false]]

ws.on('open', async () => {
  try {
    await call('connect')
    for (const [dx, dz, useY] of HOPS) {
      const p = ((await call('status')) as any).state.pos
      const target: Record<string, any> = { x: p.x + dx, z: p.z + dz, range: 2, timeoutSeconds: 45 }
      if (useY) target.y = p.y
      const r: any = await call('goto', target)
      const moved = Math.round(Math.hypot(r.state.pos.x - p.x, r.state.pos.z - p.z))
      console.log(
        `hop dx=${dx} dz=${dz} y=${useY ? 'given' : 'omitted'} -> ${r.status}` +
        ` | moved ${moved} blocks | ${r.error || JSON.stringify(r.detail && r.detail.target)}`
      )
    }
  } catch (e) {
    console.error('FAILED:', e.message)
    process.exitCode = 1
  } finally {
    ws.close()
  }
})
ws.on('error', e => { console.error('ws:', e.message); process.exitCode = 1 })
