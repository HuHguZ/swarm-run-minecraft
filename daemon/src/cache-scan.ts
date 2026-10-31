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

export async function cacheScan (bot: any, { rays = 700, range = 56, spin = Math.random(), pie = true, pieStep = 5, pieRange = 64, chestRange = 40 }: any = {}) {
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
