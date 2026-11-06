// Mineflayer 4.37.1 predates the position packet's independent delta flags.
// Keep its handler/ack/respawn order; replace only modern PositionMoveRotation.
export const PHYSICS_SOURCE_SHA256 = 'e6faedca2bab274c6d1ae5dc50e9ee7c57af9576174061b033da0cd50aec7dda'
interface Point { x: number; y: number; z: number }
interface PositionPacket extends Point {
  dx: number; dy: number; dz: number; yaw: number; pitch: number
  flags: { x?: boolean; y?: boolean; z?: boolean; yaw?: boolean; pitch?: boolean; dx?: boolean; dy?: boolean; dz?: boolean; yawDelta?: boolean }
}

// 1.21.11 Mth's float sine table, evaluated at its selected entry without
// allocating 65,536 entries. Vec3.xRot/yRot receive float radians.
function nativeTrig(radians: number, cosine = false): number {
  const index = Math.trunc(radians * 10430.378350470453 + (cosine ? 16384 : 0)) & 65535
  return Math.fround(Math.sin(index / 10430.378350470453))
}
export function absolutePosition(pos: Point, vel: Point, yaw: number, pitch: number, packet: PositionPacket) {
  // PositionMoveRotation.calculateAbsolute: rotation fields and arithmetic are floats.
  yaw = Math.fround(yaw); pitch = Math.fround(pitch)
  const flags = packet.flags
  const nextYaw = Math.fround((flags.yaw ? yaw : 0) + packet.yaw)
  const nextPitch = Math.max(-90, Math.min(90, Math.fround((flags.pitch ? pitch : 0) + packet.pitch)))
  let { x, y, z } = vel
  if (flags.yawDelta) {
    const rx = Math.fround(Math.fround(pitch - nextPitch) * Math.PI / 180)
    const ry = Math.fround(Math.fround(yaw - nextYaw) * Math.PI / 180)
    const cx = nativeTrig(rx, true), sx = nativeTrig(rx), cy = nativeTrig(ry, true), sy = nativeTrig(ry)
    const rotatedY = y * cx + z * sx, rotatedZ = z * cx - y * sx
    const rotatedX = x * cy + rotatedZ * sy
    z = rotatedZ * cy - x * sy; x = rotatedX; y = rotatedY
  }
  return { x: (flags.x ? pos.x : 0) + packet.x, y: (flags.y ? pos.y : 0) + packet.y, z: (flags.z ? pos.z : 0) + packet.z,
    dx: (flags.dx ? x : 0) + packet.dx, dy: (flags.dy ? y : 0) + packet.dy, dz: (flags.dz ? z : 0) + packet.dz,
    yaw: nextYaw, pitch: nextPitch }
}

export function adaptPositionSource(source: string): string {
  const before = "    if (typeof packet.flags === 'object') {"
  if (source.split(before).length !== 2) throw new Error('Unsupported Mineflayer position handler')
  return source.replace(before, `    if (typeof packet.flags === 'object' && typeof packet.dx === 'number' && typeof packet.dy === 'number' && typeof packet.dz === 'number') {
      const absolute = ndAbsolutePosition(pos, vel, conv.toNotchianYaw(bot.entity.yaw), conv.toNotchianPitch(bot.entity.pitch), packet)
      vel.set(absolute.dx, absolute.dy, absolute.dz)
      pos.set(absolute.x, absolute.y, absolute.z)
      newYaw = absolute.yaw
      newPitch = absolute.pitch
    } else if (typeof packet.flags === 'object') {`)
}

let stockPhysics
// NPCs can load this as createBot({ plugins: { physics: positionPhysics } }).
// Only this packet adaptation is shared: stock timers and integrator stay stock.
export function positionPhysics(bot, options) {
  if (!stockPhysics) {
    const fs: typeof import('node:fs') = require('node:fs')
    const path: typeof import('node:path') = require('node:path')
    const { createHash }: typeof import('node:crypto') = require('node:crypto')
    const { createRequire }: typeof import('node:module') = require('node:module')
    const filename = require.resolve('mineflayer/lib/plugins/physics')
    const source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n')
    if (createHash('sha256').update(source).digest('hex') !== PHYSICS_SOURCE_SHA256) throw new Error('Unsupported Mineflayer physics source for position adapter')
    const loaded = { exports: {} as any }
    new Function('require', 'module', 'exports', '__filename', '__dirname', 'ndAbsolutePosition', adaptPositionSource(source))(
      createRequire(filename), loaded, loaded.exports, filename, path.dirname(filename), absolutePosition)
    stockPhysics = loaded.exports
  }
  return stockPhysics(bot, options)
}
