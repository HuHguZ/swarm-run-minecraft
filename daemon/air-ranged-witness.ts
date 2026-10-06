// Farm-only transport witness; it never grants ticks or changes controls.
const { performance } = require('node:perf_hooks')

export function createPacketWitness(bot: any, enabled: boolean, now = () => performance.now()) {
  if (!enabled) return { start() {}, drain: () => null, dispose() {} }
  const client = bot._client; const clock = bot.ndClock
  const packets: any[] = []; const anchors = new Map<string, any>()
  let recording = false
  const stamp = (direction: string, name: string, packet: any) => {
    const copy = { ...packet }
    if (copy.flags && typeof copy.flags === 'object') copy.flags = { ...copy.flags }
    for (const key of ['age', 'time']) if (copy[key] !== undefined) {
      const value = copy[key]
      copy[key] = String(Array.isArray(value)
        ? BigInt.asIntN(64, (BigInt(value[0]) << 32n) | BigInt(value[1] >>> 0)) : value)
    }
    return { direction, name, packet: copy, mono: now(), wall: Date.now(),
      ticks: clock.ticks, serverTicks: clock.serverTicks, serverAge: String(clock.age),
      effectiveRate: clock.effectiveRate, predictionTicks: clock.predictionTicks,
      serverAt: clock.serverAt, sampleAt: clock.sampleAt, sampleAge: String(clock.sampleAge) }
  }
  const push = (entry: any) => { packets.push(entry); if (packets.length > 256) packets.shift() }
  const listeners = new Map<string, (packet: any) => void>()
  for (const name of ['update_time', 'position', 'set_ticking_state', 'step_tick']) {
    const listener = (packet: any) => {
      if (!packet) return
      const entry = stamp('in', name, packet); anchors.set(name, entry)
      if (recording) push(entry)
    }
    listeners.set(name, listener); client.prependListener(name, listener)
  }
  const oldWrite = client.write
  const write = function (this: any, name: string, packet: any, ...args: any[]) {
    if (recording && /^(position|position_look|look|tick_end|teleport_confirm)$/.test(name)) push(stamp('out', name, packet))
    return oldWrite.call(this, name, packet, ...args)
  }
  client.write = write
  return {
    start() {
      packets.length = 0; recording = true
      for (const entry of [...anchors.values()].sort((a, b) => a.mono - b.mono)) push(entry)
      push(stamp('event', 'drive', {}))
    },
    drain() {
      recording = false
      return { clockId: clock.id, timeOrigin: performance.timeOrigin, packets: packets.splice(0) }
    },
    dispose() {
      recording = false; packets.length = 0
      for (const [name, listener] of listeners) client.removeListener(name, listener)
      if (client.write === write) client.write = oldWrite
    }
  }
}

// Farm-only pairing. ACK sequence is cumulative and carries no generation tick;
// its receipt age must not be presented as the time handleUseItem executed.
export function pairUseWitness(weapon: string, shooterId: number, uses: any[], acknowledgements: any[], spawns: any[]) {
  return uses.filter(p => p.name === 'use_item' || (p.name === 'block_dig' && p.status === 5)).map(use => {
    const phase = use.name === 'block_dig' ? 'release' : weapon === 'bow' ? 'draw' : 'fire'
    const ack = use.name === 'use_item' && use.sequence > 0
      ? acknowledgements.find(p => p.mono >= use.mono && p.sequenceId >= use.sequence) ?? null : null
    const spawn = phase === 'draw' ? null : spawns.find(p => p.mono >= use.mono && p.objectData === shooterId) ?? null
    return { phase, use, ack, spawn,
      ackAfterUseMs: ack ? ack.mono - use.mono : null,
      spawnAfterUseMs: spawn ? spawn.mono - use.mono : null }
  })
}
