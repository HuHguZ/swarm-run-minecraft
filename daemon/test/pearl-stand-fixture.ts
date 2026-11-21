import { Vec3 } from 'vec3'
import { cacheMethods } from '../src/rpc/caches'
import { worldOf, drive } from './parkour-fixture'

export function pearlStandGallery(start = -.99) {
  const cells: Array<[number, number, number, string]> = []
  for (let x = -5; x <= 24; x++) for (let z = -9; z <= 8; z++) cells.push([x,119,z,'stone'])
  for (let z = -4; z <= 1; z++) for (let y = 115; y <= 200; y++) cells.push([11,y,z,'glass'])
  for (let x = 9; x <= 23; x++) for (let z = -7; z <= 7; z++) if (x !== 11 || z < -4 || z > 1) cells.push([x,123,z,'glass'])
  const { world, bot } = worldOf(cells)
  drive(bot, world)
  bot.username = 'Runner'; bot.entity.id = 1; bot.entity.position = new Vec3(.5,120,start); bot.entity.velocity = new Vec3(0,-.0784,0)
  bot.entities = {}; bot.players = {}; bot.inventory.items = () => [{ name:'ender_pearl', count:1 }]
  const ctl = { aborted: false, onAbort: [] }, session = { bot, current: { ctl }, require: () => bot, immediate: fn => fn(), runIntent: (_, fn) => fn(ctl) }
  const rpc = cacheMethods({ session } as any), arena = { x:20,z:0,r:80,killY:113 }, to = new Vec3(16.5,124,.5)
  const frames = []
  bot.on('nd_parkour', frame => frames.push(frame))
  return { bot, rpc, session, ctl, arena, frames, preview: () => rpc.pearl_plan({ to, arena }),
    walk: (z = -.75) => rpc.pearl_stand({ at: { x:.5, y:120, z }, arena }) }
}
