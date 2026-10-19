// Общее для тестов паркура (parkour-*.test.ts): реестр 1.21.11, нативная физика, мир из клеток, прогон тела по тикам.
import { Vec3 } from 'vec3'
import { EventEmitter } from 'node:events'

const registry = (require('prismarine-registry') as typeof import('prismarine-registry'))('1.21.11')
const Block: any = (require('prismarine-block') as typeof import('prismarine-block'))(registry)
const native = (require('../src/tick-plugins') as typeof import('../src/tick-plugins')).getPhysics()
function worldOf(cells: Array<[number, number, number, string, Record<string, unknown>?]>) {
  const blocks = new Map(cells.map(([x, y, z, name, properties]) => {
    const block = properties ? Block.fromProperties(name, properties) : Block.fromStateId(registry.blocksByName[name].defaultState)
    block.position = new Vec3(x, y, z)
    return [`${x},${y},${z}`, block]
  }))
  const world = { getBlock(p: Vec3) {
    const q = p.floored()
    const block = blocks.get(`${q.x},${q.y},${q.z}`)
    if (block) return block
    const air = Block.fromStateId(registry.blocksByName.air.defaultState)
    air.position = q
    return air
  } }
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', registry, game: { minY: -64, height: 384 }, inventory: { slots: [], items: () => [] }, health: 20, food: 20,
    entity: { position: new Vec3(.5, 1, .5), velocity: new Vec3(0, 0, 0), onGround: true,
      isInWater: false, isInLava: false, isInWeb: false, yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} },
    blockAt: (p: Vec3) => world.getBlock(p), jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
    physics: native.Physics(registry, world)
  })
  return { world, bot }
}
function drive(bot: Record<string, any>, world: { getBlock(p: Vec3): unknown }) {
  const { IDLE }: typeof import('../src/navigation/parkour') = require('../src/navigation/parkour')
  let control = { ...IDLE }
  bot.setControlState = (key: string, value: boolean) => { control[key] = value }
  bot.clearControlStates = () => { control = { ...IDLE } }
  bot.look = async (yaw: number) => { bot.entity.yaw = yaw }
  bot.waitForTicks = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      const state = new native.PlayerState(bot, control)
      bot.physics.simulatePlayer(state, world); state.apply(bot); bot.emit('physicsTick')
      if (!bot.listenerCount('physicsTick')) break
    }
  }
}

export { registry, Block, native, worldOf, drive }
