'use strict'
// Глаза роя для поиска тайников (21.10; модель — swarm/cache-model): что видит игрок, крутя головой на месте.
//   · лучи из глаз по сфере (rayDirs): первая непрозрачная клетка и грань, в которую вошёл луч (как perception/eyes:
//     непрозрачно — коробка 'block' кроме стекла/решёток/паутины, и лава); незагруженный столбец — конец луча;
//   · сундуки, видимые сейчас (pick.blockSeen — луч до грани первым входит в сундук, как blocks_around seen);
//   · «пирог» F3 (perception/senses.pie), но с наклоном: счёт сундуков в окне взгляда рысканье × тангаж шагом step — как
//     человек, водя камерой по кругу и вверх-вниз, смотрит, когда в «пироге» появляется доля blockentities. Клетки наружу
//     не выходят: только счёт в окне. Отсечение заслонённых секций клиента не моделируется — как в perception/senses.
import * as eyes from './perception/eyes'
import { castRay, rayDirs, pieCounts } from './swarm/cache-model'
import { wall } from './game-clock'
import { Vec3 } from 'vec3'
import { faceAim } from './pick'
import { supportAt } from './navigation/geometry'
import { FALLING } from './build'

export async function cacheScan (bot: any, { rays = 700, range = 56, spin = Math.random(), pie = true, pieStep = 5, pieRange = 64, chestRange = 40, checkFootings }: any = {}) {
  if (!bot?.entity || !bot.registry) return null
  const n = Math.max(32, Math.min(2000, Math.floor(rays)))
  const read = eyes.reader(bot)
  const shapes = bot._ndEyes?.shapes || eyes.shapeCache(bot.registry)
  const p = bot.entity.position
  const o = { x: p.x, y: p.y + (require('./pick') as typeof import('./pick')).eyeHeight(bot), z: p.z }
  // [0] means unknown from distance zero; numeric 0 would invent clear air in unfinished directions.
  const hits: (number[] | 0)[] = Array.from({ length: n }, () => [0])
  const out: any = { eye: o, n, spin, range, hits }
  function* work () {
    const dirs = rayDirs(n, spin), first = Math.floor(((spin % 1 + 1) % 1) * n)
    const opaque = (x, y, z) => { const s = read.at(x, y, z); return s < 0 ? -1 : shapes.opaque(s) ? 1 : 0 }
    // Rotate the first direction so moving observers do not always scan just the upper hemisphere.
    for (let k = 0; k < n; k++) {
      const i = (first + k) % n
      hits[i] = castRay(o, opaque, dirs[i], range)
      yield
    }
    try {
      const V = require('vec3'); const pk = require('./pick')
      const id = bot.registry.blocksByName.chest?.id
      if (id !== undefined) {
        out.chests = []
        for (const v of bot.findBlocks({ matching: [id], maxDistance: chestRange, count: 96 })) {
          if (pk.blockSeen(bot, new V(v.x, v.y, v.z), { range: chestRange })) out.chests.push([v.x, v.y, v.z])
          yield
        }
      }
    } catch { delete out.chests }
    if (pie) {
      // Не публиковать неполные счётчики «пирога»: они выдавали бы непросмотренные секции за пустые.
      const e = bot._ndEyes || new eyes.Eyes(bot)
      e.syncDim()
      const cells: { x: number; y: number; z: number }[] = []
      for (const s of e.sectionsNear(read, o, pieRange)) {
        const ent = e.section(read, s.cx, s.cz, s.sy)
        if (ent) for (const c of ent.cells) if (c.pie && c.name === 'chest') cells.push(c)
        yield
      }
      out.pie = { step: pieStep, range: pieRange, bins: pieCounts(o, cells, pieStep, pieRange) }
    }
    if (Array.isArray(checkFootings) && checkFootings.length) {
      const standable = []
      const up = new Vec3(0, 1, 0)
      for (const cell of checkFootings) {
        yield
        if (!cell || ![cell.x, cell.y, cell.z].every(Number.isSafeInteger)) continue
        const at = new Vec3(cell.x, cell.y, cell.z)
        if (Math.hypot(at.x + .5 - o.x, at.y + .5 - o.y, at.z + .5 - o.z) <= 4.5 + Math.sqrt(3) / 2 && faceAim(bot, at, up)) {
          const block = bot.blockAt(at)
          const surface = block && !FALLING.has(block.name) && !/_(concrete_powder|anvil)$|^(anvil|dragon_egg|suspicious_sand|suspicious_gravel)$/.test(block.name) &&
            supportAt({ blockAt: p => p.equals(at) ? block : null }, at.offset(.5, 1, .5), .5)
          if (surface) standable.push({ x: at.x, y: at.y, z: at.z })
        }
      }
      out.standableFootings = standable
    }
  }
  const body = bot.entity, world = bot.world, dimension = bot.game?.dimension
  let ended = false, changed = false, slice = wall.monotonic() + 4
  const end = () => { ended = true }, change = () => { changed = true }
  const alive = () => !ended && bot.entity === body && bot.world === world && bot.game?.dimension === dimension && !(bot.health <= 0)
  const events = ['death', 'end', 'respawn'], terrain = ['blockUpdate', 'chunkColumnLoad', 'chunkColumnUnload']
  for (const name of events) bot.once(name, end)
  for (const name of terrain) bot.once(name, change)
  try {
    const steps = work()
    for (;;) {
      if (!alive()) return null
      if (steps.next().done) return out
      if (wall.monotonic() < slice) continue
      // shortcut: one ray, findBlocks call and section remain synchronous; split a unit if it alone overruns a tick.
      await new Promise<void>(resolve => wall.setImmediate(resolve))
      if (!alive()) return null
      if (changed || body.position.x !== o.x || body.position.y + (require('./pick') as typeof import('./pick')).eyeHeight(bot) !== o.y || body.position.z !== o.z) return out
      slice = wall.monotonic() + 4
    }
  } finally {
    for (const name of events) bot.removeListener(name, end)
    for (const name of terrain) bot.removeListener(name, change)
  }
}
