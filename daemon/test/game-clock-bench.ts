'use strict'
// Run explicitly: node test/game-clock-bench.js [milliseconds per rate]
// This opens only an ephemeral loopback echo socket; no Minecraft server needed.
import * as net from 'node:net'
import { performance } from 'node:perf_hooks'
import { once } from 'node:events'
import { GameClock, wall } from '../src/game-clock'

function percentile (values, p) {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor((sorted.length - 1) * p)] : null
}

async function main () {
  const duration = Number(process.argv[2] || 1000)
  if (!Number.isFinite(duration) || duration < 100) throw new Error('duration must be at least 100 ms')
  for (const delay of [1, 5, 10]) {
    const gaps = []
    let previous = performance.now()
    const started = previous
    const finish = started + Math.min(duration, 600)
    await new Promise<void>(resolve => {
      function pulse () {
        const at = performance.now()
        gaps.push(at - previous)
        previous = at
        if (at < finish) setTimeout(pulse, delay)
        else resolve()
      }
      setTimeout(pulse, delay)
    })
    console.log(JSON.stringify({ nativeDelayMs: delay, callsPerSecond: gaps.length * 1000 / (previous - started),
      medianMs: percentile(gaps, 0.5), p95Ms: percentile(gaps, 0.95) }))
  }

  const server = net.createServer(socket => socket.pipe(socket))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1')
  client.setNoDelay(true)
  await once(client, 'connect')
  const pending = new Map()
  let text = ''
  let responses = []
  client.on('data', bytes => {
    text += bytes.toString()
    let newline
    while ((newline = text.indexOf('\n')) !== -1) {
      const id = text.slice(0, newline)
      text = text.slice(newline + 1)
      const sent = pending.get(id)
      if (sent !== undefined) responses.push(performance.now() - sent)
      pending.delete(id)
    }
  })
  let sequence = 0
  const ping = setInterval(() => {
    const id = String(++sequence)
    pending.set(id, performance.now())
    client.write(`${id}\n`)
  }, 50)
  try {
    for (const rate of [20, 100, 200, 400, 800]) {
      responses = []
      const gaps = []
      const clock = new GameClock()
      clock.setState({ tick_rate: rate })
      const started = performance.now()
      const cpu = process.cpuUsage()
      let previous = started
      clock.on('tick', () => {
        const at = performance.now()
        gaps.push(at - previous)
        previous = at
      })
      clock.start()
      await wall.sleep(duration)
      clock.dispose()
      const elapsed = performance.now() - started
      const used = process.cpuUsage(cpu)
      console.log(JSON.stringify({ requestedTPS: rate, actualTPS: clock.ticks * 1000 / elapsed,
        ticks: clock.ticks, wallMs: elapsed, cpuOneCorePercent: (used.user + used.system) / (elapsed * 10),
        tickMedianMs: percentile(gaps, 0.5), tickP95Ms: percentile(gaps, 0.95),
        tcpResponses: responses.length, tcpP95Ms: percentile(responses, 0.95) }))
    }
  } finally {
    clearInterval(ping)
    client.end()
    await once(client, 'close')
    await new Promise<any>(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
