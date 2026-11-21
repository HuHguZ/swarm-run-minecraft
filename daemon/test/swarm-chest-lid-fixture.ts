import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { block, data, testBot, testClock } from './tick-plugins-fixture'
import { createTickPlugins } from '../src/tick-plugins'
import { swarmMethods } from '../src/rpc/swarm'
import { watchChestLids } from '../src/chest-lid'
import { faceAim } from '../src/pick'
import { swarmSightings } from '../src/swarm-senses'

export const base = new Vec3(664, 150, 578), up = new Vec3(0, 1, 0), at = base.plus(up)
export function scene(cells = new Map()) {
  const bot = testBot(), clock = testClock()
  require('mineflayer/lib/plugins/entities')(bot)
  createTickPlugins(clock).plugins.physics(bot, { physicsEnabled: false })
  bot.entity.position = new Vec3(664.53, 150.5, 579.56); bot.health = 20
  if (!cells.has(base.toString())) cells.set(base.toString(), block('chest', base))
  bot.blockAt = p => cells.get(p.floored().toString()) || block(p.y < 150 ? 'stone' : 'air', p)
  bot.pathfinder = { setGoal() {} }
  const item = { name: 'cobblestone', type: data.itemsByName.cobblestone.id, count: 64 }
  bot.inventory.items = () => [item]; bot.equip = async i => { bot.heldItem = i }
  bot.waitForTicks = async () => {}
  let aim = null, receipt = true, cancelAfter = false
  const ctl = { aborted: false, onAbort: [] as (() => void)[] }
  bot.lookAt = async p => { aim = p }
  const Entity = require('prismarine-entity')('1.21.11')
  const rival = Object.assign(new Entity(2), { id: 2, username: 'V', type: 'player', position: new Vec3(665.5,150.5,581.14),
    width: .6, height: 1.8, velocity: new Vec3(0,0,0), metadata: [], onGround: true })
  bot.players = { V: { entity: rival, gamemode: 0 } }; bot.entities[2] = rival
  require('mineflayer/lib/plugins/generic_place')(bot)
  require('mineflayer/lib/plugins/place_block')(bot)
  const write = bot._client.write
  bot._client.write = (name, p) => {
    write(name, p)
    if (name !== 'block_place') return
    assert.ok(bot.getControlState('sneak'))
    assert.ok(aim.equals(faceAim(bot, base, up)))
    const next = block('cobblestone', at); cells.set(at.toString(), next)
    if (receipt) bot._client.emit('block_change', { location: at, type: next.stateId })
    if (cancelAfter) { ctl.aborted = true; ctl.onAbort.slice().forEach(cancel => cancel()) }
  }
  watchChestLids(bot)
  const session: any = { bot, runIntent: (_id, run) => run(ctl) }
  const call = (extra = {}) => swarmMethods({ session } as any).swarm_work({ kind: 'place', item: 'cobblestone', at, rival: { id: 'V', at: new Vec3(665.5,150.5,581.14), velocity: new Vec3(0,0,-.22) }, chestLid: true, allies: [], timeoutSeconds: 1, ...extra })
  const sightAfterMove = (dz: number) => {
    bot._client.emit('rel_entity_move', { entityId: 2, dX: 0, dY: 0, dZ: dz, onGround: true })
    return swarmSightings(bot, ['Y', 'Ally'])
  }
  return { bot, cells, call, rival, sightAfterMove, noReceipt: () => { receipt = false }, cancelAfterReceipt: () => { cancelAfter = true } }
}
