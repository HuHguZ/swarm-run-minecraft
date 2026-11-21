import { Vec3 } from 'vec3'
import { faceAim, blockSeen, hitboxOf, eyeOf, blockOnRay } from './pick'
import { seesPlayer } from './pvp/last-seen'
import { alliedExitBlocked } from './build'
import { withinArena } from './navigation/parkour/model'

// Common, steady redstone conductors in Java 1.21.11. Glass, leaves and decorative
// full outlines do not satisfy ChestBlock.isBlockedChestByBlock.
export const lidBlock = /^(?:dirt|stone|cobblestone|netherrack|(?:smooth_|cut_)?sandstone|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_planks)$/
export function approachingChest(p, velocity, center) {
  if (!velocity) return false
  const dx = center.x - p.x, dz = center.z - p.z
  return dx * dx + dz * dz > (dx - velocity.x) ** 2 + (dz - velocity.z) ** 2
}
let registry, Block
export function lidMaterial(inventory, held, team) {
  const candidates = Object.keys(inventory || {}).filter(n => inventory[n] > 0 && lidBlock.test(n))
  if (!candidates.length) return null
  registry ||= require('minecraft-data')('1.21.11'); Block ||= require('prismarine-block')(registry)
  const tools = new Set<string>(Object.keys(inventory))
  for (const m of team) for (const [n, count] of Object.entries(m.inventory || {})) if (Number(count) > 0) tools.add(n)
  const own = [...tools].filter(n => /_(?:pickaxe|axe|shovel)$/.test(n)).map(n => registry.itemsByName[n]?.id)
  let best = null, gain = 0
  for (const name of candidates) {
    const block = Block.fromStateId(registry.blocksByName[name].defaultState, 0)
    const ms = tool => block.digTime(tool, false, false, false)
    const delay = ms(registry.itemsByName[held]?.id ?? null)
    const recover = Math.min(ms(null), ...own.map(ms))
    const net = delay - recover - 50 // one click now and one eventual removal by the team
    if (net > gain) { gain = net; best = name }
  }
  return best
}

const open = new WeakMap<object, Map<string, Vec3>>()
export function watchChestLids(bot) {
  if (open.has(bot)) return
  const lids = new Map<string, Vec3>(); open.set(bot, lids)
  const note = (b, count) => {
    if (!b || !/^(chest|trapped_chest)$/.test(b.name) || !blockSeen(bot, b.position, { range: 6 })) return
    if (count > 0) lids.set(b.position.toString(), b.position); else lids.delete(b.position.toString())
  }
  bot.on('chestLidMove', (chest, count) => { if (chest?.getProperties?.().type === 'single') note(chest, count) })
  // Mineflayer coalesces double lid animations. A visible packet for either
  // half is sufficient even before its partner's animation arrives.
  bot._client?.on('block_action', packet => {
    if (packet.byte1 !== 1 || ![bot.registry.blocksByName.chest?.id, bot.registry.blocksByName.trapped_chest?.id].includes(packet.blockId)) return
    const p = packet.location, b = p && bot.blockAt(new Vec3(p.x, p.y, p.z))
    if (b && b.type === packet.blockId && b.getProperties?.().type !== 'single') note(b, packet.byte2)
  })
  bot.on('respawn', () => lids.clear())
  bot.on('chunkColumnUnload', corner => {
    for (const [key, at] of lids) if ((at.x >> 4) === (corner.x >> 4) && (at.z >> 4) === (corner.z >> 4)) lids.delete(key)
  })
}
const up = new Vec3(0, 1, 0)
const clockwise = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }
// The seam of a Java chest points clockwise from facing on its LEFT half.
// Adjacent chests from a different pair can have the very same block name.
export function seenChestPartner(bot, block) {
  if (!block || !/^(chest|trapped_chest)$/.test(block.name)) return null
  const props = block.getProperties?.(), side = props?.type === 'left' ? 1 : props?.type === 'right' ? -1 : 0
  const dir = clockwise[props?.facing]
  if (!side || !dir || !blockSeen(bot, block.position, { range: 4.5 })) return null
  const at = block.position.offset(side * dir[0], 0, side * dir[1])
  const second = bot.blockAt(at), other = second?.getProperties?.()
  return second?.name === block.name && other?.facing === props.facing && other.type === (side === 1 ? 'right' : 'left') &&
    blockSeen(bot, at, { range: 4.5 }) ? at : null
}
export function seenChest(bot, lid, reservedPartner?: { x: number; y: number; z: number }) {
  const base = lid.offset(0, -1, 0), block = bot.blockAt(base)
  if (reservedPartner) return seenChestPartner(bot, block)?.equals(reservedPartner) ? block : null
  return block && /^(chest|trapped_chest)$/.test(block.name) && block.getProperties?.().type === 'single' &&
    blockSeen(bot, base, { range: 4.5 }) ? block : null
}

export async function placeChestLid(bot, ctl, pos, item, rival, allies, arena, beforeClick: () => void, partner?: { x: number; y: number; z: number }) {
  const chest = seenChest(bot, pos, partner), spare = bot.inventory.slots[45], main = bot.heldItem?.name
  const offhand = /_sword$/.test(main) && (!spare || spare.name === item)
  const stack = spare?.name === item ? spare : bot.inventory.items().find(i => i.name === item)
  const ready = () => offhand ? bot.inventory.slots[45]?.name === item && bot.heldItem?.name === main : bot.heldItem?.name === item
  const enemy = () => bot.players?.[rival.id]?.entity || Object.values<any>(bot.entities || {}).find(e => e.username === rival.id)
  if (!chest || !rival.at || !rival.velocity) return { ok: false, reason: 'lid_unavailable' }
  const center = chest.position.offset(.5, .5, .5)
  if (!approachingChest(rival.at, rival.velocity, center)) return { ok: false, reason: 'lid_unavailable' }
  // Use successive visible positions. Mineflayer's raw player velocity is a knockback packet,
  // not the rival's walking speed. Retreat since the radio observation cancels the click.
  const partnerKey = partner && new Vec3(partner.x, partner.y, partner.z).toString()
  // Capping a second, already obstructed half would spend a block without delaying anyone.
  const otherTop = partner && new Vec3(partner.x + .5, partner.y + 1.5, partner.z + .5)
  let lastDistance = Math.hypot(rival.at.x - center.x, rival.at.z - center.z)
  const valid = () => {
    const e = enemy()
    if (ctl.aborted || !e || !seesPlayer(bot, e) || e.position.distanceTo(center) > 5 ||
        bot.currentWindow || open.get(bot)?.has(chest.position.toString()) || partnerKey && open.get(bot)?.has(partnerKey) ||
        !withinArena(bot, pos.offset(.5, 0, .5), arena) || !/^(air|cave_air|void_air)$/.test(bot.blockAt(pos)?.name) ||
        seenChest(bot, pos, partner)?.stateId !== chest.stateId) return false
    if (otherTop) {
      const eye = eyeOf(bot), delta = otherTop.minus(eye)
      if (delta.norm() > 4.5 || blockOnRay(bot, eye, delta.unit(), delta.norm())) return false
    }
    const distance = Math.hypot(e.position.x - center.x, e.position.z - center.z)
    if (distance > lastDistance + 1e-6) return false
    lastDistance = distance
    const bodies = [bot.entity, ...Object.values<any>(bot.entities || {}).filter(a => a !== bot.entity && a.position && (a.username || a.type === 'mob') && seesPlayer(bot, a))]
    return !bodies.some(a => {
      const { lo, hi } = hitboxOf(bot, a)
      return lo.x < pos.x + 1 && hi.x > pos.x && lo.y < pos.y + 1 && hi.y > pos.y && lo.z < pos.z + 1 && hi.z > pos.z
    })
  }
  if (!stack || !valid() || alliedExitBlocked(bot, pos, item, allies)) return { ok: false, reason: 'lid_unavailable' }
  const sneak = bot.getControlState('sneak')
  try {
    bot.setControlState('sneak', true)
    if (!ready()) await bot.equip(stack, offhand ? 'off-hand' : 'hand')
    if (!sneak) await bot.waitForTicks(1)
    if (!valid() || !bot.getControlState('sneak')) return { ok: false, reason: 'lid_unavailable' }
    const aim = faceAim(bot, chest.position, up), from = bot.entity.position.clone()
    if (!aim) return { ok: false, reason: 'lid_occluded' }
    await bot.lookAt(aim, true)
    if (!valid() || !from.equals(bot.entity.position) || !ready() || !bot.getControlState('sneak') ||
        !faceAim(bot, chest.position, up)?.equals(aim)) return { ok: false, reason: 'lid_unavailable' }
    beforeClick()
    await bot._placeBlockWithOptions(chest, up, { forceLook: 'ignore', delta: aim.minus(chest.position), offhand, swingArm: offhand ? 'left' : 'right' })
    return { ok: true }
  } finally { if (!ctl.aborted && !sneak) bot.setControlState('sneak', false) }
}
