import { velocityFromRaw } from '../../../daemon/src/drops'

const outgoing = new Set(['position', 'position_look', 'look', 'flying', 'tick_end', 'use_item', 'teleport_confirm', 'player_input', 'player_loaded'])
const incoming = new Set(['world_event', 'position', 'respawn', 'game_state_change'])
const copy = (value: any) => value === undefined ? null : JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? String(v) : v))

/** Read-only wire witness for one opening; it must never prevent an original packet. */
export function captureOpeningWire(bot: any) {
  const client = bot._client, original = client.write, descriptor = Object.getOwnPropertyDescriptor(client, 'write'), rows: any[] = []
  const record = (direction: string, name: string, data: any, extra: any = {}) => {
    try {
      const e = bot.entity, p = e?.position, v = e?.velocity
      rows.push({ ms: Date.now(), direction, name, data: copy(data), own: {
        x: p?.x, y: p?.y, z: p?.z, yaw: e?.yaw, pitch: e?.pitch, onGround: e?.onGround,
        velocity: v ? { x: v.x, y: v.y, z: v.z } : null }, ...extra })
    } catch {}
  }
  const serializer = client.serializer
  const serialized = (buffer: Buffer) => {
    try {
      const bytes = Buffer.from(buffer), parsed = serializer.proto.parsePacketBuffer('packet', bytes).data
      if (outgoing.has(parsed.name)) record('serialized', parsed.name, parsed.params, { hex: bytes.toString('hex') })
    } catch {}
  }
  serializer?.on?.('data', serialized)
  client.write = function (this: any, ...args: any[]) {
    if (outgoing.has(args[0])) record('out', args[0], args[1])
    return Reflect.apply(original, this, args)
  }
  const packet = (data: any, meta: any, bytes: any) => {
    if (meta?.name === 'spawn_entity') {
      const p = bot.entity?.position
      if (p && Math.hypot(data.x - p.x, data.y - p.y, data.z - p.z) <= 12)
        record('in', meta.name, data, { velocity: velocityFromRaw(bytes, 'spawn') })
    } else if (incoming.has(meta?.name)) record('in', meta.name, data)
  }
  client.on('packet', packet)
  return { rows, close() {
    if (descriptor) Object.defineProperty(client, 'write', descriptor)
    else delete client.write
    client.removeListener('packet', packet)
    serializer?.removeListener?.('data', serialized)
  } }
}
