// Stage B of the stress stand: the abstract world (sim-world.ts) dressed as a mineflayer bot, so the REAL observeTactics
// (minecraft.ts) reads it - blocks, entities, metadata, effects, inventory, damage packets - instead of the observeWorld
// mirror. Flat ground at y 63; the world's facts become blocks: a box/hole/pillar shelter is stone around the body,
// lava/water are fluid cells, "no exits" is a ring of fire (exitsNear refuses fire cells, sight passes through).
// Shots in flight are projectile entities on the straight line shooter -> body (threats.incoming reads their position
// receipts); ponytail: cover pockets are not built (cover stays false).
import { EventEmitter } from 'node:events'
import { jumpHeight, type SimWorld } from './sim-world'

const { Vec3 } = require('vec3')
const clock = require('../game-clock')
const registry = require('minecraft-data')('1.21.11')

const ARMOR: Record<number, string[]> = { 0: [], 7: ['leather'], 15: ['iron'], 20: ['diamond'] }
const HEIGHT: Record<string, number> = { creeper: 1.7, spider: .9, cave_spider: .5, skeleton: 1.99, piglin_brute: 1.95, player: 1.8,
  wither_skeleton: 2.4, enderman: 2.9, ghast: 4, magma_cube: 2.04, hoglin: 1.4, phantom: .5, blaze: 1.8 }
const HAND: Record<string, string> = { player: 'diamond_sword', piglin_brute: 'golden_axe', skeleton: 'bow', wither_skeleton: 'stone_sword', vindicator: 'iron_axe', piglin: 'golden_sword' }
const DAMAGE_TYPE: Record<string, number> = { in_wall: 22 }
const item = (name: string, count = 1, extra: Record<string, unknown> = {}) => ({ name, count, type: registry.itemsByName[name]?.id ?? 0, ...extra })

export function mineflayerFacade(world: SimWorld, session: Record<string, any>) {
  const bot: any = new EventEmitter()
  bot.setMaxListeners(0)
  bot.version = '1.21.11'
  bot.registry = registry
  bot._client = new EventEmitter()
  bot.username = 'NeuroDown'
  bot.entity = { id: 1, type: 'player', username: 'NeuroDown', position: new Vec3(.5, 64, .5), velocity: new Vec3(0, 0, 0), height: 1.8,
    eyeHeight: 1.62, width: .6, onGround: true, effects: {}, metadata: [0], yaw: 0, pitch: 0, isInWater: false, isInLava: false }
  bot.game = { dimension: world.spec.nether ? 'the_nether' : 'overworld', gameMode: 'survival' }
  bot.pathfinder = { setGoal() {}, setMovements() {}, stop() {} }
  bot.clearControlStates = () => {}; bot.stopDigging = () => {}; bot.deactivateItem = () => {}; bot.setControlState = () => {}
  bot.inventory = { slots: new Array(46).fill(null), items: () => items }
  let items: Array<Record<string, unknown>> = []
  const body = () => bot.entity.position.floored()
  // Rough ground: every third cell (hashed) is a block higher - natural terrain the flat-only exitsNear read as dead ends.
  const lift = (x: number, z: number) => world.spec.rough && ((Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) >>> 0) % 3 === 0 ? 1 : 0
  // Fluids stay where the event put them (a pool around the spot), the body moves through them.
  let lavaAt: { x: number; z: number } | null = null, waterAt: { x: number; z: number } | null = null

  bot.blockAt = (point: any) => {
    const p = point.floored()
    const b = world.body
    const feet = body()
    const dx = p.x - feet.x, dz = p.z - feet.z, ring = Math.max(Math.abs(dx), Math.abs(dz))
    const block = (name: string) => ({ name, type: registry.blocksByName[name]?.id ?? 0, position: p,
      boundingBox: /^(air|water|lava|fire)$/.test(name) ? 'empty' : 'block', shapes: /^(air|water|lava|fire)$/.test(name) ? [] : [[0, 0, 0, 1, 1, 1]] })
    const shelter = b.shelter && b.shelter.breach <= 0 ? b.shelter.kind : null
    if (b.embedded && dx === 0 && dz === 0 && (p.y === feet.y || p.y === feet.y + 1)) return block('stone')
    if (shelter === 'box' && (ring === 1 && p.y >= feet.y && p.y <= feet.y + 1 || ring <= 1 && p.y === feet.y + 2)) return block('cobblestone')
    if (shelter === 'hole' && ring === 1 && p.y >= feet.y && p.y <= 63) return block('stone')
    if (shelter === 'pillar' && dx === 0 && dz === 0 && p.y >= 64 && p.y < feet.y) return block('cobblestone')
    const pool = (at: { x: number; z: number } | null, r: number) => !!at && Math.max(Math.abs(p.x - at.x), Math.abs(p.z - at.z)) <= r
    if (b.inLava && pool(lavaAt, world.spec.lavaExit ? 2 : 6) && p.y === 64) return block('lava')
    if (b.submerged > 0 && pool(waterAt, 3) && p.y >= 64 && p.y <= 66) return block('water')
    if (!world.spec.exits && ring >= 1 && ring <= 3 && p.y === 64) return block('fire')
    // An undiggable floor stays undiggable in the Nether too: the guard's hole two down reads this ground (ne-guard.holeFits).
    if (p.y < 64 + lift(p.x, p.z)) return block(!world.spec.floorDiggable ? 'bedrock' : world.spec.nether ? 'netherrack' : 'stone')
    return block('air')
  }

  // The world moves; mirror it into the bot before every observation.
  const sync = () => {
    const b = world.body
    const y = b.shelter?.kind === 'pillar' && b.shelter.breach <= 0 ? 67 : b.shelter?.kind === 'hole' && b.shelter.breach <= 0 ? 62 : 64 + lift(Math.floor(b.x + .5), Math.floor(b.z + .5))
    const jump = jumpHeight(world)
    bot.entity.position = new Vec3(b.x + .5, y + jump, b.z + .5)
    lavaAt = b.inLava ? lavaAt ?? body() : null
    waterAt = b.submerged > 0 ? waterAt ?? body() : null
    bot.entity.onGround = !b.falling && jump <= 0
    bot.entity.isInLava = b.inLava
    bot.entity.isInWater = b.submerged > 0
    bot.entity.metadata[0] = b.burning > 0 && b.fireRes <= 0 ? 1 : 0
    bot.entity.effects = b.fireRes > 0 ? { [(registry.effectsByName.fire_resistance ?? registry.effectsByName.FireResistance).id]: { amplifier: 0, duration: b.fireRes } } : {}
    bot.health = b.hp; bot.food = b.food; bot.foodSaturation = b.saturation
    bot.oxygenLevel = Math.max(0, Math.min(20, Math.round(b.air / 15)))
    bot._ndClutch = b.falling && b.waterBucket && !world.spec.nether ? { lastDecision: { action: 'water' } } : null
    const armor = ARMOR[b.armor] ?? []
    ;[5, 6, 7, 8].forEach((slot, i) => { bot.inventory.slots[slot] = armor[0] ? item(`${armor[0]}_${['helmet', 'chestplate', 'leggings', 'boots'][i]}`) : null })
    bot.inventory.slots[45] = b.shield && b.shieldOff <= 0 ? item('shield') : null
    const potion = { componentMap: new Map([['potion_contents', { data: { potionId: 'minecraft:fire_resistance' } }]]) }
    // A speedrun body carries a pickaxe: without one refuge refuses the box (no breaking out) and builds a pillar, which a
    // phantom reaches (stage B diverged from the mirror on regress-husk-at-sight-edge).
    items = [b.weapon !== 'fist' && item(b.weapon), item('iron_pickaxe'), b.blocks > 0 && item('cobblestone', b.blocks), b.meals > 0 && item('bread', b.meals),
      b.waterBucket && item('water_bucket'), b.frPotion > 0 && item('potion', b.frPotion, potion), b.pearls > 0 && item('ender_pearl', b.pearls)]
      .filter(Boolean) as Array<Record<string, unknown>>
    const entities: Record<number, any> = { 1: bot.entity }
    const swell = registry.entitiesByName.creeper.metadataKeys.indexOf('swell_dir')
    const powered = registry.entitiesByName.creeper.metadataKeys.indexOf('is_powered')
    for (const e of world.enemies) {
      if (e.hp <= 0) continue
      const name = e.player ? 'player' : e.kind
      const metadata: unknown[] = []
      if (e.kind === 'creeper') { metadata[swell] = e.swell > 0 ? 1 : -1; metadata[powered] = e.charged }
      entities[e.id] = { id: e.id, name, type: e.player ? 'player' : 'mob', ...(e.player ? { username: `Tank${e.id}` } : {}),
        position: new Vec3(e.x + .5, 64 + lift(Math.floor(e.x + .5), Math.floor(e.z + .5)), e.z + .5), velocity: new Vec3(0, 0, 0), height: HEIGHT[name] ?? 1.95, width: .6, isValid: true,
        equipment: HAND[name] ? [item(HAND[name])] : [], metadata }
    }
    world.tnts.forEach((t, i) => { entities[1000 + i] = { id: 1000 + i, name: 'tnt', type: 'other', position: new Vec3(t.x + .5, 64, t.z + .5),
      velocity: new Vec3(0, 0, 0), height: .98, width: .98, isValid: true, metadata: [0, 300, null, false, false, false, 0, 0, t.fuse] } })
    // A shot in flight: fireball (ghast), small_fireball (blaze) or arrow; an arrow's first velocity lifts it against gravity
    // .05 (threats.closestApproach: step, drag .99, gravity) so it meets the body when the world says it does.
    const now = clock.now()
    world.arrows.forEach((a, i) => {
      if (a.due <= world.tick) return
      const shooter = world.enemies.find(e => e.id === a.from)
      const name = shooter?.kind === 'ghast' ? 'fireball' : shooter?.kind === 'blaze' ? 'small_fireball' : 'arrow'
      const flight = Math.max(1, a.due - a.fired), done = (world.tick - a.fired) / flight, left = a.due - world.tick
      const from = new Vec3(a.x + .5, 65.5, a.z + .5), to = bot.entity.position.offset(0, .9, 0)
      const at = from.plus(to.minus(from).scaled(done))
      const g = name === 'arrow' ? .05 : 0
      const v = new Vec3((to.x - at.x) / left, (to.y - at.y + g * left * (left - 1) / 2) / left, (to.z - at.z) / left)
      entities[2000 + i] = { id: 2000 + i, name, type: 'projectile', position: at, velocity: v, height: .5, width: .5, isValid: true, metadata: [],
        _ndPositionReceipts: [{ x: at.x - v.x, y: at.y - v.y, z: at.z - v.z, t: now - 50 }, { x: at.x, y: at.y, z: at.z, t: now }], _ndObservationNow: () => clock.now() }
    })
    bot.entities = entities
  }

  // Damage packets and the autopilot's damage memory, as hookDamage records them (sourceCauseId = id + 1).
  world.onHurt = () => {
    const b = world.body
    const type = b.hurtBy !== null ? 'mob' : 'generic'
    session.autopilot.lastHurt = { at: world.tick * 50, type, byMob: b.hurtByMob, source: null, sourceId: b.hurtBy, dimension: bot.game.dimension }
    bot._client.emit('damage_event', { entityId: 1, sourceTypeId: b.embedded ? DAMAGE_TYPE.in_wall : 0, sourceCauseId: b.hurtBy !== null ? b.hurtBy + 1 : 0 })
  }
  session.autopilot = { lastHurt: null, syncDamageContext() {}, buriedBy: () => world.body.embedded ? { name: 'stone' } : null }
  session.mcData = registry
  sync()
  return { bot, sync }
}
