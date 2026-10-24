import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Vec3 } from 'vec3'
import { createEquipment } from '../src/pvp/equipment'
import { stepSafe } from '../src/moves'

test('web placement stops old movement; subsequent steps avoid the whole web and can leave it', async () => {
  const webs = new Set<string>(), keys: Record<string, boolean> = { forward: true, sprint: true }
  const web = { name: 'cobweb', slot: 36, count: 8 }
  let material = web.name
  let stoppedAtEquip = false, stoppedAtAim = false, packets = 0
  const bot: any = {
    entity: { position: new Vec3(.5, 64, .75) },
    physics: { playerHalfWidth: Math.fround(.6) / 2, playerHeight: 1.8 },
    blockAt (at: Vec3) {
      const position = at.floored(), solid = position.y < 64
      return { position, name: solid ? 'stone' : webs.has(position.toString()) ? material : 'air', boundingBox: solid ? 'block' : 'empty' }
    },
    lookAt: async () => { stoppedAtAim = !ctx.pathing && !Object.values(keys).some(Boolean) },
    placeBlock: async (below: any) => { packets++; webs.add(below.position.offset(0, 1, 0).toString()) }
  }
  const ctx: any = {
    bot, entity: { position: new Vec3(2.5, 64, 1.5) }, Vec3, ctl: { aborted: false },
    pathing: true, pathTo: () => { ctx.pathing = false }, clear: () => { for (const key of Object.keys(keys)) keys[key] = false },
    pick: { faceAim: () => new Vec3(2.5, 64, 1.5) },
    holdItem: async (item: any) => { material = item.name; stoppedAtEquip = !ctx.pathing && !Object.values(keys).some(Boolean); return true },
    blockName: (_bot: any, at: Vec3) => bot.blockAt(at).name, withTimeout: async (p: Promise<any>) => p, used () {}
  }
  const equipment = createEquipment(ctx), east = { x: 1, z: 0 }
  assert.equal(await equipment.placeUnder(web, 'web'), true)
  const observed: Record<string, boolean> = { stoppedAtEquip, stoppedAtAim }
  // Центр остаётся в z=0, а край рамки входит в паутину в z=1.
  bot.entity.position = new Vec3(1, 64, .75)
  observed.sideContactBlocked = !stepSafe(bot, east)
  // Дальний шаг кончается за паутиной: проверка одной конечной точки пропускает её.
  bot.entity.position = new Vec3(.5, 64, .75)
  observed.crossingBlocked = !stepSafe(bot, east, { reach: 5 })
  // Проверка одного охватывающего прямоугольника зря запрещала бы эту свободную диагональ.
  webs.clear(); webs.add(new Vec3(2, 64, 0).toString())
  bot.entity.position = new Vec3(.5, 64, .5)
  observed.diagonalOpen = stepSafe(bot, { x: Math.SQRT1_2, z: Math.SQRT1_2 }, { reach: 3 })
  bot.entity.position = new Vec3(2.5, 64, .5)
  observed.escapeOpen = stepSafe(bot, { x: -1, z: 0 }, { reach: 1.8 })
  // Клетка цели может пересекать наше тело даже при видимой грани опоры.
  webs.clear(); bot.entity.position = new Vec3(2.1, 64, 1.1)
  observed.selfPlacementRefused = !await equipment.placeUnder(web, 'web') && packets === 1
  // Другие предметы сохраняют прежнее поведение постановки на ходу.
  webs.clear(); bot.entity.position = new Vec3(.5, 64, .75); ctx.pathing = true; keys.forward = true
  const dirt = { ...web, name: 'dirt' }
  observed.otherPlacementKeepsMovement = await equipment.placeUnder(dirt, 'block') && ctx.pathing && keys.forward
  assert.deepEqual(observed, Object.fromEntries(Object.keys(observed).map(key => [key, true])))
})
