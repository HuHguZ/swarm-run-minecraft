import { performance } from 'node:perf_hooks'
import type { Bot } from 'mineflayer'
import type { Vec3 } from 'vec3'

type DigBot = Pick<Bot, 'version' | '_client' | 'blockAt' | 'on' | 'removeListener'> & {
  _updateBlockState?(position: Vec3, stateId: number): void
}
type ReceiptResult = 'confirmed' | 'rejected' | 'timeout' | 'interrupted'
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}

export function watchDigReceipt(bot: DigBot, position: Vec3, interrupted: () => boolean = () => false) {
  if (bot.version !== '1.21.11' || !bot._client) throw new Error('dig receipt requires Minecraft 1.21.11 native packets')
  const original = bot.blockAt(position)?.stateId
  let latest: number | undefined
  let completed = false
  let receivedAir = false
  let rejected = false
  let cancelled = false
  let wake: (() => void) | undefined
  let completedAt: number | undefined
  let receivedAt: number | undefined
  let settledAt: number | undefined
  let packetKind: 'single' | 'section' | undefined
  const matches = (x: unknown, y: unknown, z: unknown) => x === position.x && y === position.y && z === position.z
  const received = (state: number, kind: 'single' | 'section') => {
    latest = state
    receivedAt = performance.now(); packetKind = kind
    const block = bot.blockAt(position)
    const empty = block?.stateId === state && /^(air|cave_air|void_air)$/.test(block.name)
    if (empty) receivedAir = true
    else { receivedAir = false; if (completed) rejected = true }
    wake?.()
  }
  const single = (value: unknown) => {
    const packet = object(value); const at = object(packet.location)
    if (matches(at.x, at.y, at.z) && typeof packet.type === 'number') received(packet.type, 'single')
  }
  const multiple = (value: unknown) => {
    const packet = object(value); const chunk = object(packet.chunkCoordinates)
    if (![chunk.x, chunk.y, chunk.z].every(value => typeof value === 'number') || !Array.isArray(packet.records)) return
    for (const record of packet.records) {
      if (typeof record !== 'number' || !Number.isInteger(record)) continue
      const x = Number(chunk.x) * 16 + ((record >>> 8) & 15)
      const y = Number(chunk.y) * 16 + (record & 15)
      const z = Number(chunk.z) * 16 + ((record >>> 4) & 15)
      if (matches(x, y, z)) received(Math.floor(record / 4096), 'section')
    }
  }
  const cancel = () => { cancelled = true; wake?.() }
  bot._client.on('block_change', single)
  bot._client.on('multi_block_change', multiple)
  for (const event of ['death', 'end', 'kicked'] as const) bot.on(event, cancel)
  return {
    async settle(wallMs = 3000): Promise<ReceiptResult> {
      completed = true
      completedAt = performance.now()
      const deadline = completedAt + Math.max(0, Math.min(3000, wallMs))
      while (!receivedAir && !rejected && !cancelled && !interrupted() && performance.now() < deadline) {
        await new Promise<void>(resolve => {
          const ready = () => { clearTimeout(timer); wake = undefined; resolve() }
          const timer = setTimeout(ready, Math.min(10, Math.max(0, deadline - performance.now())))
          wake = ready
        })
      }
      settledAt = performance.now()
      if (cancelled || interrupted()) {
        const restore = latest ?? original
        if (restore !== undefined) { try { bot._updateBlockState?.(position, restore) } catch {} }
        return 'interrupted'
      }
      if (receivedAir && /^(air|cave_air|void_air)$/.test(bot.blockAt(position)?.name ?? '')) return 'confirmed'
      const restore = latest ?? original
      if (restore !== undefined) { try { bot._updateBlockState?.(position, restore) } catch {} }
      return rejected ? 'rejected' : 'timeout'
    },
    timing() {
      return { packet: packetKind ?? 'none',
        serverWaitWallMs: completedAt === undefined || receivedAt === undefined ? 0 : Math.max(0, receivedAt - completedAt),
        notificationDelayWallMs: settledAt === undefined || receivedAt === undefined ? 0 : Math.max(0, settledAt - receivedAt) }
    },
    close() {
      cancel()
      bot._client.removeListener('block_change', single)
      bot._client.removeListener('multi_block_change', multiple)
      for (const event of ['death', 'end', 'kicked'] as const) bot.removeListener(event, cancel)
    }
  }
}
